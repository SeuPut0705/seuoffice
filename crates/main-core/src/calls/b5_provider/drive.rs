//! Part `drive` of group `b5-provider` (tools/main-diff/groups/b5-provider/drive.ts):
//! `packages/google-drive/src`: formats.ts, drive-api.ts, oauth.ts and
//! connection.ts.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg};
use super::world::{Sink, call_error, drive, note};
use crate::packages::ai_provider::task::{Fetcher, JsError, LocalBoxFuture, Rt, Signal};
use crate::packages::google_drive::connection::{
    DriveConnection, DriveConnectionOptions, DriveConnectionState, ListenerId,
};
use crate::packages::google_drive::drive_api::{
    AccessTokenSource, DRIVE_API, DRIVE_UPLOAD_API, DriveAccount, DriveApi, DriveApiOptions,
    DriveFailure, DriveFile, DriveListing, DriveResult, ListOptions, MAX_OPEN_BYTES,
    MAX_READ_BYTES, UploadTarget, listing_query, query_literal,
};
use crate::packages::google_drive::formats::{
    FOLDER_MIME, GOOGLE_EXPORTS, OPENABLE_EXTENSIONS, OpenPlan, SHORTCUT_MIME, extension_of,
    is_google_native, local_file_name, office_copy_name, open_plan, upload_mime,
};
use crate::packages::google_drive::oauth::{
    Clock, DRIVE_SCOPE, GOOGLE_AUTH_URL, GOOGLE_REVOKE_URL, GOOGLE_SIGN_IN_TIMEOUT_MS,
    GOOGLE_TOKEN_URL, GoogleClient, GoogleSignInOptions, GoogleTokens, MAX_PICKED_FILES,
    PickRequest, SignInPage, SignInPages, exchange_google_code, google_auth_url, picked_file_ids,
    pkce_pair, redirect_uri, refresh_google_token, revoke_google_token, sign_in_page_html,
    sign_in_with_google,
};

fn s(args: &[Value], i: usize) -> String {
    arg(args, i)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn n(args: &[Value], i: usize) -> f64 {
    arg(args, i).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

fn thrown(e: JsError) -> CallError {
    call_error(&e)
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool) == Some(true)
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2)
        .filter_map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok())
        .collect()
}

fn hex_text(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `{ ok: true, ...fields }`
fn ok_with(fields: Vec<(&str, Value)>) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(true));
    for (key, value) in fields {
        out.insert(key.into(), value);
    }
    Value::Object(out)
}

fn failed(key: &str, reason: &str) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(false));
    out.insert(key.into(), Value::String(reason.into()));
    Value::Object(out)
}

/// A DriveResult as the case shows it: `{ ok: true, ...fields }`, `{ ok:
/// false, kind }`, or what the call threw.
fn shown<T>(
    result: DriveResult<T>,
    fields: impl FnOnce(T) -> Vec<(&'static str, Value)>,
) -> Result<Value, JsError> {
    match result {
        Ok(value) => Ok(ok_with(fields(value))),
        Err(DriveFailure::Kind(kind)) => Ok(failed("kind", kind.as_str())),
        Err(DriveFailure::Thrown(e)) => Err(e),
    }
}

fn file_json(file: &DriveFile) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(file.id));
    out.insert("name".into(), json!(file.name));
    out.insert("mimeType".into(), json!(file.mime_type));
    out.insert("modifiedTime".into(), json!(file.modified_time));
    out.insert("canEdit".into(), json!(file.can_edit));
    if let Some(size) = file.size {
        out.insert("size".into(), json!(size));
    }
    if let Some(md5) = &file.md5_checksum {
        out.insert("md5Checksum".into(), json!(md5));
    }
    if let Some(parents) = &file.parents {
        out.insert("parents".into(), json!(parents));
    }
    if let Some(target) = &file.shortcut_target {
        out.insert(
            "shortcutTarget".into(),
            json!({ "id": target.id, "mimeType": target.mime_type }),
        );
    }
    Value::Object(out)
}

fn account_json(account: &DriveAccount) -> Value {
    json!({ "displayName": account.display_name, "emailAddress": account.email_address })
}

fn state_json(state: &DriveConnectionState) -> Value {
    let mut out = Map::new();
    match state {
        DriveConnectionState::Unavailable => {
            out.insert("state".into(), json!("unavailable"));
        }
        DriveConnectionState::Disconnected { expired } => {
            out.insert("state".into(), json!("disconnected"));
            if *expired {
                out.insert("expired".into(), json!(true));
            }
        }
        DriveConnectionState::Connected { account, persisted } => {
            out.insert("state".into(), json!("connected"));
            out.insert(
                "account".into(),
                account.as_ref().map_or(Value::Null, account_json),
            );
            out.insert("persisted".into(), json!(persisted));
        }
    }
    Value::Object(out)
}

fn tokens_json(tokens: &GoogleTokens) -> Value {
    json!({
        "refreshToken": tokens.refresh_token,
        "accessToken": tokens.access_token,
        "expiresAt": tokens.expires_at,
    })
}

fn listing_of(v: Option<&Value>) -> DriveListing {
    let listing = v.cloned().unwrap_or(Value::Null);
    match str_of(&listing, "kind").as_deref() {
        Some("search") => DriveListing::Search {
            text: str_of(&listing, "text").unwrap_or_default(),
        },
        _ => DriveListing::Recent,
    }
}

fn open_plan_json(plan: &OpenPlan) -> Value {
    let mut out = Map::new();
    match plan {
        OpenPlan::Download { extension } => {
            out.insert("kind".into(), json!("download"));
            out.insert("extension".into(), json!(extension));
        }
        OpenPlan::Export { mime, extension } => {
            out.insert("kind".into(), json!("export"));
            if let Some(mime) = mime {
                out.insert("mime".into(), json!(mime));
            }
            if let Some(extension) = extension {
                out.insert("extension".into(), json!(extension));
            }
        }
        OpenPlan::None => {
            out.insert("kind".into(), json!("none"));
        }
    }
    Value::Object(out)
}

fn page_of(v: Option<&Value>) -> SignInPage {
    let v = v.cloned().unwrap_or(Value::Null);
    SignInPage {
        lang: str_of(&v, "lang").unwrap_or_default(),
        title: str_of(&v, "title").unwrap_or_default(),
        body: str_of(&v, "body").unwrap_or_default(),
    }
}

/// `o.pages ?? PAGES`
fn pages_of(o: &Value) -> SignInPages {
    match o.get("pages") {
        Some(pages) if !pages.is_null() => SignInPages {
            done: page_of(pages.get("done")),
            failed: page_of(pages.get("failed")),
        },
        _ => SignInPages {
            done: SignInPage {
                lang: "en".into(),
                title: "Signed in".into(),
                body: "You can close this tab.".into(),
            },
            failed: SignInPage {
                lang: "en".into(),
                title: "Not signed in".into(),
                body: "Try again.".into(),
            },
        },
    }
}

fn client_from(v: &Value) -> GoogleClient {
    GoogleClient {
        client_id: str_of(v, "clientId").unwrap_or_default(),
        client_secret: str_of(v, "clientSecret").unwrap_or_default(),
    }
}

/// `o.client ?? CLIENT`
fn client_of(o: &Value) -> GoogleClient {
    match o.get("client") {
        Some(client) if !client.is_null() => client_from(client),
        _ => GoogleClient {
            client_id: "cid".into(),
            client_secret: "sec".into(),
        },
    }
}

/// `clockOf(o.nowSeq)`: the values in turn, the last one again and again.
fn clock_of(o: &Value) -> Option<Clock> {
    let seq: Vec<f64> = o
        .get("nowSeq")?
        .as_array()?
        .iter()
        .filter_map(Value::as_f64)
        .collect();
    let at = Cell::new(0usize);
    Some(Rc::new(move || {
        let k = at.get();
        at.set(k + 1);
        seq.get(k.min(seq.len().saturating_sub(1)))
            .copied()
            .unwrap_or(f64::NAN)
    }))
}

/// Runs `body` in the case's world; its value or what it threw.
fn in_world<F>(
    args: &[Value],
    cx: &mut Context,
    body: impl FnOnce(Rt, Signal, Sink, Value) -> F,
) -> Answer
where
    F: Future<Output = Result<Value, JsError>> + 'static,
{
    let world = arg(args, 0).cloned();
    let o = arg(args, 1).cloned().unwrap_or(Value::Null);
    match drive(world.as_ref(), cx, move |rt, signal, sink| {
        body(rt, signal, sink, o)
    })? {
        Ok(v) => Ok(Some(v)),
        Err(e) => Err(thrown(e)),
    }
}

/// `apiOf(run, o)`
fn api_of(sink: &Sink, o: &Value) -> DriveApi {
    let token: Option<String> = match o.get("token") {
        None => Some("tok".to_owned()),
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => None,
    };
    let sink = sink.clone();
    let source: AccessTokenSource = Rc::new(
        move |_rt: Rt, signal: Option<Signal>| -> LocalBoxFuture<Option<String>> {
            note(
                &sink,
                json!(["token", if signal.is_some() { "signal" } else { "none" }]),
            );
            let token = token.clone();
            Box::pin(async move { token })
        },
    );
    DriveApi::new(DriveApiOptions {
        token: source,
        fetch: Fetcher::Node,
        download: flag(o, "download").then_some(Fetcher::Net),
    })
}

/// A DriveApi call in the case's world.
macro_rules! api_call {
    ($args:expr, $cx:expr, |$api:ident, $rt:ident, $o:ident, $signal:ident| $body:expr) => {
        in_world($args, $cx, move |$rt, signal, sink, $o| async move {
            let $api = api_of(&sink, &$o);
            let $signal: Option<Signal> = if flag(&$o, "noSignal") {
                None
            } else {
                Some(signal)
            };
            let $signal = $signal.as_ref();
            $body
        })
    };
}

fn max_bytes(o: &Value) -> f64 {
    o.get("maxBytes")
        .and_then(Value::as_f64)
        .unwrap_or(f64::NAN)
}

/// An oauth call in the case's world, with the caller's signal when asked.
macro_rules! auth_call {
    ($args:expr, $cx:expr, |$rt:ident, $o:ident, $signal:ident| $body:expr) => {
        in_world($args, $cx, move |$rt, signal, _sink, $o| async move {
            let $signal: Option<Signal> = flag(&$o, "useSignal").then_some(signal);
            let $signal = $signal.as_ref();
            $body
        })
    };
}

/// The DriveConnection of a scenario and what its steps share.
struct Ctx {
    conn: DriveConnection,
    sink: Sink,
    signal: Signal,
    pages: SignInPages,
    listeners: RefCell<BTreeMap<String, ListenerId>>,
}

/// `runStep(...)`
fn run_step(ctx: Rc<Ctx>, rt: Rt, step: Value) -> LocalBoxFuture<Result<Value, JsError>> {
    Box::pin(async move {
        let name = str_of(&step, "do").unwrap_or_default();
        let signal = || flag(&step, "signal").then_some(&ctx.signal);
        Ok(match name.as_str() {
            "load" => state_json(&ctx.conn.load(&rt).await),
            "state" => state_json(&ctx.conn.state()),
            "connected" => Value::Bool(ctx.conn.connected()),
            "connect" => match ctx.conn.connect(&rt, &ctx.pages).await {
                Ok(()) => json!({ "ok": true }),
                Err(reason) => failed("reason", reason.as_str()),
            },
            "pick" => match ctx
                .conn
                .pick(&rt, &ctx.pages, flag(&step, "multiple"))
                .await
            {
                Ok(picked) => ok_with(vec![("picked", json!(picked))]),
                Err(reason) => failed("reason", reason.as_str()),
            },
            "cancelConnect" => {
                ctx.conn.cancel_connect();
                Value::Null
            }
            "disconnect" => {
                ctx.conn.disconnect(&rt).await;
                Value::Null
            }
            "onChange" => {
                let label = str_of(&step, "name").unwrap_or_default();
                let sink = ctx.sink.clone();
                let shown_as = label.clone();
                let id = ctx.conn.on_change(move |state| {
                    note(&sink, json!(["state", shown_as, state_json(state)]));
                });
                ctx.listeners.borrow_mut().insert(label, id);
                Value::Null
            }
            "offChange" => {
                let label = str_of(&step, "name").unwrap_or_default();
                let id = ctx.listeners.borrow().get(&label).copied();
                match id {
                    Some(id) => Value::Bool(ctx.conn.remove_listener(id)),
                    None => Value::Null,
                }
            }
            "sleep" => {
                rt.sleep(step.get("ms").and_then(Value::as_f64).unwrap_or(f64::NAN))
                    .await;
                Value::Null
            }
            "settle" => {
                rt.sleep(0.0).await;
                Value::Null
            }
            "api.account" => shown(ctx.conn.api.account(&rt, signal()).await, |account| {
                vec![("account", account_json(&account))]
            })?,
            "api.file" => {
                let id = str_of(&step, "id").unwrap_or_default();
                shown(ctx.conn.api.file(&rt, &id, signal()).await, |file| {
                    vec![("file", file_json(&file))]
                })?
            }
            "seq" => {
                let mut out = Vec::new();
                for inner in step
                    .get("steps")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                {
                    out.push(run_step(ctx.clone(), rt.clone(), inner).await?);
                }
                Value::Array(out)
            }
            "parallel" => {
                let futures = step
                    .get("steps")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|inner| run_step(ctx.clone(), rt.clone(), inner))
                    .collect();
                Value::Array(rt.try_join_all(futures).await?)
            }
            other => return Err(JsError::error(format!("no such step: {other}"))),
        })
    })
}

/// A DriveConnection scenario: the steps of the case, one after the other.
fn scenario(args: &[Value], cx: &mut Context) -> Answer {
    in_world(args, cx, |rt, signal, sink, o| async move {
        let client = match o.get("client") {
            None => Some(GoogleClient {
                client_id: "cid".into(),
                client_secret: "sec".into(),
            }),
            Some(Value::Null) => None,
            Some(client) => Some(client_from(client)),
        };
        let conn = DriveConnection::new(DriveConnectionOptions {
            client,
            fetch: Fetcher::Node,
            download: flag(&o, "download").then_some(Fetcher::Net),
            now: clock_of(&o),
        });
        let ctx = Rc::new(Ctx {
            conn,
            sink,
            signal,
            pages: pages_of(&o),
            listeners: RefCell::new(BTreeMap::new()),
        });
        let mut out = Vec::new();
        for step in o
            .get("steps")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            out.push(run_step(ctx.clone(), rt.clone(), step).await?);
        }
        Ok(Value::Array(out))
    })
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- constants ----
        "formats.FOLDER_MIME" => Ok(Some(json!(FOLDER_MIME))),
        "formats.SHORTCUT_MIME" => Ok(Some(json!(SHORTCUT_MIME))),
        "formats.GOOGLE_EXPORTS" => {
            let mut out = Map::new();
            for (mime, export) in GOOGLE_EXPORTS {
                out.insert(
                    mime.into(),
                    json!({ "mime": export.mime, "extension": export.extension }),
                );
            }
            Ok(Some(Value::Object(out)))
        }
        "formats.OPENABLE_EXTENSIONS" => Ok(Some(json!(OPENABLE_EXTENSIONS))),
        "drive-api.DRIVE_API" => Ok(Some(json!(DRIVE_API))),
        "drive-api.DRIVE_UPLOAD_API" => Ok(Some(json!(DRIVE_UPLOAD_API))),
        "drive-api.MAX_OPEN_BYTES" => Ok(Some(json!(MAX_OPEN_BYTES))),
        "drive-api.MAX_READ_BYTES" => Ok(Some(json!(MAX_READ_BYTES))),
        "oauth.GOOGLE_AUTH_URL" => Ok(Some(json!(GOOGLE_AUTH_URL))),
        "oauth.GOOGLE_TOKEN_URL" => Ok(Some(json!(GOOGLE_TOKEN_URL))),
        "oauth.GOOGLE_REVOKE_URL" => Ok(Some(json!(GOOGLE_REVOKE_URL))),
        "oauth.DRIVE_SCOPE" => Ok(Some(json!(DRIVE_SCOPE))),
        "oauth.MAX_PICKED_FILES" => Ok(Some(json!(MAX_PICKED_FILES))),
        "oauth.GOOGLE_SIGN_IN_TIMEOUT_MS" => Ok(Some(json!(GOOGLE_SIGN_IN_TIMEOUT_MS))),

        // ---- the pure functions ----
        "formats.isGoogleNative" => Ok(Some(json!(is_google_native(&s(args, 0))))),
        "formats.extensionOf" => Ok(Some(json!(extension_of(&s(args, 0))))),
        "formats.openPlan" => {
            let file = arg(args, 0).cloned().unwrap_or(Value::Null);
            let plan = open_plan(
                &str_of(&file, "name").unwrap_or_default(),
                &str_of(&file, "mimeType").unwrap_or_default(),
            );
            Ok(Some(open_plan_json(&plan)))
        }
        "formats.uploadMime" => Ok(Some(json!(upload_mime(&s(args, 0))))),
        "formats.localFileName" => Ok(Some(json!(local_file_name(&s(args, 0), &s(args, 1))))),
        "formats.officeCopyName" => Ok(Some(json!(office_copy_name(&s(args, 0), &s(args, 1))))),
        "drive-api.queryLiteral" => Ok(Some(json!(query_literal(&s(args, 0))))),
        "drive-api.listingQuery" => {
            let (q, order_by) = listing_query(&listing_of(arg(args, 0)));
            Ok(Some(json!({ "q": q, "orderBy": order_by })))
        }
        "oauth.redirectUri" => Ok(Some(json!(redirect_uri(n(args, 0))))),
        "oauth.googleAuthUrl" => {
            let pick = arg(args, 4).filter(|p| !p.is_null()).map(|p| PickRequest {
                multiple: flag(p, "multiple"),
            });
            Ok(Some(json!(google_auth_url(
                &s(args, 0),
                n(args, 1),
                &s(args, 2),
                &s(args, 3),
                pick.as_ref(),
            ))))
        }
        "oauth.pickedFileIds" => Ok(Some(json!(picked_file_ids(
            arg(args, 0).and_then(Value::as_str)
        )))),
        "oauth.signInPageHtml" => Ok(Some(json!(sign_in_page_html(&page_of(arg(args, 0)))))),

        // ---- DriveApi ----
        "drive-api.DriveApi.account" => api_call!(args, cx, |api, rt, _o, signal| {
            shown(api.account(&rt, signal).await, |account| {
                vec![("account", account_json(&account))]
            })
        }),
        "drive-api.DriveApi.list" => api_call!(args, cx, |api, rt, o, signal| {
            let listing = listing_of(o.get("listing"));
            let options = o.get("options").cloned().unwrap_or(Value::Null);
            let options = ListOptions {
                page_token: str_of(&options, "pageToken"),
                page_size: options.get("pageSize").and_then(Value::as_f64),
            };
            shown(api.list(&rt, &listing, &options, signal).await, |list| {
                let mut fields = vec![(
                    "files",
                    Value::Array(list.files.iter().map(file_json).collect()),
                )];
                if let Some(token) = list.next_page_token {
                    fields.push(("nextPageToken", json!(token)));
                }
                fields
            })
        }),
        "drive-api.DriveApi.file" => api_call!(args, cx, |api, rt, o, signal| {
            let id = str_of(&o, "id").unwrap_or_default();
            shown(api.file(&rt, &id, signal).await, |file| {
                vec![("file", file_json(&file))]
            })
        }),
        "drive-api.DriveApi.download" => api_call!(args, cx, |api, rt, o, signal| {
            let id = str_of(&o, "id").unwrap_or_default();
            shown(
                api.download(&rt, &id, max_bytes(&o), signal).await,
                |bytes| vec![("bytes", json!({ "hex": hex_text(&bytes) }))],
            )
        }),
        "drive-api.DriveApi.export" => api_call!(args, cx, |api, rt, o, signal| {
            let id = str_of(&o, "id").unwrap_or_default();
            let mime = str_of(&o, "mime").unwrap_or_default();
            shown(
                api.export(&rt, &id, &mime, max_bytes(&o), signal).await,
                |bytes| vec![("bytes", json!({ "hex": hex_text(&bytes) }))],
            )
        }),
        "drive-api.DriveApi.upload" => api_call!(args, cx, |api, rt, o, signal| {
            let target = o.get("target").cloned().unwrap_or(Value::Null);
            let target = match str_of(&target, "existingId") {
                Some(id) => UploadTarget::Existing { id },
                None => UploadTarget::New {
                    name: str_of(&target, "name").unwrap_or_default(),
                    parent_id: str_of(&target, "parentId"),
                },
            };
            let bytes = hex_bytes(&str_of(&o, "bytes").unwrap_or_default());
            let mime = str_of(&o, "mime").unwrap_or_else(|| "application/octet-stream".into());
            shown(
                api.upload(&rt, &target, &bytes, &mime, signal).await,
                |file| vec![("file", file_json(&file))],
            )
        }),

        // ---- oauth.ts ----
        "oauth.pkcePair" => auth_call!(args, cx, |rt, o, _signal| {
            let times = o.get("times").and_then(Value::as_u64).unwrap_or(1);
            Ok(Value::Array(
                (0..times)
                    .map(|_| {
                        let (verifier, challenge) = pkce_pair(&rt);
                        json!({ "verifier": verifier, "challenge": challenge })
                    })
                    .collect(),
            ))
        }),
        "oauth.exchangeGoogleCode" => auth_call!(args, cx, |rt, o, signal| {
            let now = clock_of(&o);
            let result = exchange_google_code(
                &rt,
                &client_of(&o),
                &str_of(&o, "code").unwrap_or_default(),
                &str_of(&o, "verifier").unwrap_or_default(),
                o.get("port").and_then(Value::as_f64).unwrap_or(f64::NAN),
                Fetcher::Node,
                signal,
                now.as_ref(),
            )
            .await;
            Ok(match result {
                Ok(tokens) => ok_with(vec![("tokens", tokens_json(&tokens))]),
                Err(reason) => failed("reason", reason.as_str()),
            })
        }),
        "oauth.refreshGoogleToken" => auth_call!(args, cx, |rt, o, signal| {
            let now = clock_of(&o);
            let result = refresh_google_token(
                &rt,
                &client_of(&o),
                &str_of(&o, "token").unwrap_or_default(),
                Fetcher::Node,
                signal,
                now.as_ref(),
            )
            .await;
            Ok(match result {
                Ok(refreshed) => ok_with(vec![
                    ("accessToken", json!(refreshed.access_token)),
                    ("expiresAt", json!(refreshed.expires_at)),
                ]),
                Err(reason) => failed("reason", reason.as_str()),
            })
        }),
        "oauth.revokeGoogleToken" => auth_call!(args, cx, |rt, o, _signal| {
            Ok(Value::Bool(
                revoke_google_token(&rt, &str_of(&o, "token").unwrap_or_default(), Fetcher::Node)
                    .await,
            ))
        }),
        "oauth.signInWithGoogle" => auth_call!(args, cx, |rt, o, signal| {
            let options = GoogleSignInOptions {
                client: client_of(&o),
                pages: pages_of(&o),
                signal: signal.cloned(),
                fetch: (!flag(&o, "noFetch")).then_some(Fetcher::Node),
                timeout_ms: o.get("timeoutMs").and_then(Value::as_f64),
                now: clock_of(&o),
                pick: o.get("pick").filter(|p| !p.is_null()).map(|p| PickRequest {
                    multiple: flag(p, "multiple"),
                }),
            };
            Ok(match sign_in_with_google(&rt, &options).await {
                Ok(picked) => ok_with(vec![
                    ("tokens", tokens_json(&picked.tokens)),
                    ("picked", json!(picked.picked)),
                ]),
                Err(reason) => failed("reason", reason.as_str()),
            })
        }),

        // ---- connection.ts ----
        "connection.DriveConnection.state"
        | "connection.DriveConnection.connected"
        | "connection.DriveConnection.load"
        | "connection.DriveConnection.onChange"
        | "connection.DriveConnection.connect"
        | "connection.DriveConnection.pick"
        | "connection.DriveConnection.cancelConnect"
        | "connection.DriveConnection.disconnect"
        | "connection.DriveConnection.api" => scenario(args, cx),
        _ => return None,
    })
}
