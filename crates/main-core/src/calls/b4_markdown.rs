//! The functions of group `b4-markdown` (tools/main-diff/groups/b4-markdown.ts).
//!
//! Names are `<ts-file>.<export>`; `asset-lifecycle`, `atomic-write` and
//! `old-names` exist in the html app too and carry the app: `markdown/<ts-file>.<export>`.
//! A `null` argument is an argument left out where the TypeScript has a
//! default. Where the TypeScript keeps state between calls (a class, a
//! module-level map) or a call needs a folder changed in between, the
//! function takes a script of steps and answers one entry per query step.

use std::cell::Cell;
use std::fs;

use jscompat::{js_regex, json_value_from_serde, random_uuid, to_number};
use serde_json::{Number, Value, json};

use super::{Answer, CallError, Context, arg, str_arg};
use crate::markdown::asset_lifecycle::{self as assets, PreparedSaveAsAssets};
use crate::markdown::conversion_lifecycle::{
    self as conversion, MARKDOWN_CONVERSION_TTL_MS, SessionOptions,
};
use crate::markdown::image_export::{ImageExportEnv, ImageExportSessions};
use crate::markdown::image_host::{
    self as host, FetchBody, FetchFailure, FetchInit, FetchResponse, ResponseHeaders,
    SigV4Credentials,
};
use crate::markdown::old_names::{
    ASSET_MANIFEST_FILENAME_WRITTEN, OLD_ASSET_MANIFEST_FILENAMES, OLD_CONVERSION_SESSION_MARKERS,
};
use crate::markdown::ord_map::OrdMap;
use crate::markdown::wiki_create::{CreateNoteOptions, create_wiki_note};
use crate::markdown::wiki_fragment::WikiFragments;
use crate::markdown::wiki_heads::{MAX_HEAD_ENTRIES_PER_KIND, parse_wiki_heads, wiki_heads};
use crate::markdown::wiki_index::{
    MAX_GRAPH_NODES, MAX_INDEX_FILES, WikiIndex, extract_tags, extract_wiki_targets, node_vault_fs,
};
use crate::markdown::wiki_notes::{MAX_NOTES, list_wiki_notes};
use crate::markdown::wiki_resolve::{
    MAX_DEPTH, ResolveOptions, SKIP_DIRS, WikiFs, node_fs, resolve_wiki_links, split_target,
};
use crate::node_fs::NodeError;
use crate::packages::electron_utils::atomic_write::atomic_write_file;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "markdown/old-names.OLD_ASSET_MANIFEST_FILENAMES" => {
            Ok(Some(json!(OLD_ASSET_MANIFEST_FILENAMES)))
        }
        "markdown/old-names.ASSET_MANIFEST_FILENAME_WRITTEN" => {
            Ok(Some(json!(ASSET_MANIFEST_FILENAME_WRITTEN)))
        }
        "markdown/old-names.OLD_CONVERSION_SESSION_MARKERS" => {
            Ok(Some(json!(OLD_CONVERSION_SESSION_MARKERS)))
        }
        "markdown/atomic-write.atomicWriteFile" => str_arg(args, 0).and_then(|path| {
            let text = str_arg(args, 1)?;
            atomic_write_file(path, text.as_bytes())
                .map(|()| None)
                .map_err(masked)
        }),
        "conversion-lifecycle.MARKDOWN_CONVERSION_TTL_MS" => {
            Ok(Some(num(MARKDOWN_CONVERSION_TTL_MS)))
        }
        "conversion-lifecycle.cleanupStaleMarkdownConversions" => cleanup_call(args, cx),
        "conversion-lifecycle.createMarkdownConversionSession" => create_session_call(args, cx),
        "conversion-lifecycle.writeMarkdownConversion" => write_conversion_call(args),
        "image-export.ImageExportSessions" => image_export_call(args),
        "image-host.normalizeImageHostConfig" => {
            let raw = arg(args, 0).map(json_value_from_serde);
            Ok(Some(
                match host::normalize_image_host_config(raw.as_ref()) {
                    Some(config) => serde_json::to_value(config).expect("a config prints"),
                    None => Value::Null,
                },
            ))
        }
        "image-host.isImageHostUsable" => {
            let raw = arg(args, 0).map(json_value_from_serde);
            Ok(Some(Value::Bool(host::is_image_host_usable(raw.as_ref()))))
        }
        "image-host.imageObjectKey" => object_key_call(args),
        "image-host.sigV4" => sig_v4_call(args),
        "image-host.uploadImageToHost" => upload_call(args, cx),
        "wiki-resolve.SKIP_DIRS" => Ok(Some(json!(SKIP_DIRS))),
        "wiki-resolve.MAX_DEPTH" => Ok(Some(Value::from(MAX_DEPTH))),
        "wiki-resolve.splitTarget" => str_arg(args, 0).map(|raw| {
            let split = split_target(raw);
            Some(json!({ "name": split.name, "fragment": split.fragment }))
        }),
        "wiki-resolve.nodeFs"
        | "wiki-index.nodeVaultFs"
        | "wiki-index.wikiBacklinks"
        | "wiki-index.wikiTags"
        | "wiki-index.wikiGraph"
        | "wiki-index.warmWikiIndex" => run_vault_script(args, cx),
        "wiki-resolve.resolveWikiLinks" => resolve_call(args, cx),
        "wiki-notes.MAX_NOTES" => Ok(Some(num(MAX_NOTES))),
        "wiki-notes.listWikiNotes" => notes_call(args, cx),
        "wiki-create.createWikiNote" => create_note_call(args),
        "wiki-heads.MAX_HEAD_ENTRIES_PER_KIND" => Ok(Some(Value::from(MAX_HEAD_ENTRIES_PER_KIND))),
        "wiki-heads.parseWikiHeads" => str_arg(args, 0)
            .map(|raw| Some(serde_json::to_value(parse_wiki_heads(raw)).expect("entries print"))),
        "wiki-heads.wikiHeads" => heads_call(args, cx),
        "wiki-index.MAX_INDEX_FILES" => Ok(Some(Value::from(MAX_INDEX_FILES))),
        "wiki-index.MAX_GRAPH_NODES" => Ok(Some(Value::from(MAX_GRAPH_NODES))),
        "wiki-index.extractWikiTargets" => {
            str_arg(args, 0).map(|text| Some(json!(extract_wiki_targets(text))))
        }
        "wiki-index.extractTags" => str_arg(args, 0).map(|text| Some(json!(extract_tags(text)))),
        "wiki-fragment.rememberWikiFragment" | "wiki-fragment.takeWikiFragment" => {
            fragment_script(args)
        }
        _ => return asset_call(name, args),
    })
}

fn ok(v: Value) -> Answer {
    Ok(Some(v))
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

/// `null` and a missing argument are one thing: left out
fn opt_str(args: &[Value], i: usize) -> Result<Option<&str>, CallError> {
    match arg(args, i) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(bad("a string")),
    }
}

fn opt_num(value: Option<&Value>) -> Result<Option<f64>, CallError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => Ok(n.as_f64()),
        Some(_) => Err(bad("a number")),
    }
}

fn string_list(value: Option<&Value>) -> Result<Vec<String>, CallError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list"))?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad("a string")))
        .collect()
}

fn field_str<'a>(object: &'a Value, key: &str) -> Result<&'a str, CallError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| bad(key))
}

fn error_value(error: &NodeError) -> Value {
    json!({ "error": { "code": error.code, "message": error.message } })
}

/// `.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')`: a temp name's random part
/// differs on each side
fn mask_tmp(text: &str) -> String {
    js_regex!(r"\.[0-9a-f]{12}\.tmp", "g").replace_all(text, |_| ".<hex>.tmp".to_owned())
}

fn masked(mut error: NodeError) -> CallError {
    error.message = mask_tmp(&error.message);
    error.into()
}

/// the random parts of a name written the same on both sides: a UUID, the six
/// characters of `mkdtemp`
fn mask_random(text: &str) -> String {
    let text = js_regex!(
        r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        "g"
    )
    .replace_all(text, |_| "<uuid>".to_owned());
    js_regex!(r"-images-[A-Za-z0-9]{6}", "g").replace_all(&text, |_| "-images-<tmp>".to_owned())
}

// ---- conversion-lifecycle ----

/// `[root, nowMs | null, ttlMs | null]`
fn cleanup_call(args: &[Value], cx: &Context) -> Answer {
    let root = str_arg(args, 0)?;
    let now = opt_num(arg(args, 1))?.unwrap_or(cx.now_ms);
    let ttl = opt_num(arg(args, 2))?.unwrap_or(MARKDOWN_CONVERSION_TTL_MS);
    let removed = conversion::cleanup_stale_markdown_conversions(root, now, ttl)?;
    Ok(Some(json!(removed)))
}

/// A path with a random name is written with its random part masked and the
/// file or folder removed, so the folder after the call is equal on both sides.
fn settle_random_path(path: String) -> Value {
    let shown = mask_random(&path);
    if shown != path {
        let _ = fs::remove_dir_all(&path).or_else(|_| fs::remove_file(&path));
    }
    Value::from(shown)
}

/// `[root, { now?, id?, ttlMs? } | null]`
fn create_session_call(args: &[Value], cx: &Context) -> Answer {
    let root = str_arg(args, 0)?;
    let options = arg(args, 1).filter(|v| !v.is_null());
    let (now, ttl_ms, id) = match options {
        Some(options) => (
            opt_num(options.get("now"))?,
            opt_num(options.get("ttlMs"))?,
            match options.get("id") {
                None | Some(Value::Null) => None,
                Some(Value::String(id)) => Some(id.as_str()),
                Some(_) => return Err(bad("id")),
            },
        ),
        None => (None, None, None),
    };
    let path = conversion::create_markdown_conversion_session(
        root,
        &SessionOptions { now, id, ttl_ms },
        cx.now_ms,
        &random_uuid,
    )?;
    Ok(Some(settle_random_path(path)))
}

/// `[sessionDirectory, suggestedName, text, id | null]`
fn write_conversion_call(args: &[Value]) -> Answer {
    let dir = str_arg(args, 0)?;
    let name = str_arg(args, 1)?;
    let text = str_arg(args, 2)?;
    let id = opt_str(args, 3)?;
    let path = conversion::write_markdown_conversion(dir, name, text.as_bytes(), id, &random_uuid)?;
    Ok(Some(settle_random_path(path)))
}

// ---- image-export ----

/// the id of the nth session started, or the literal `id` of the step
fn id_of(ids: &[String], step: &Value) -> String {
    match step.get("session").and_then(Value::as_u64) {
        Some(n) => ids.get(n as usize).cloned().unwrap_or_default(),
        None => step
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    }
}

fn mkdtemp_suffix() -> String {
    random_uuid()
        .chars()
        .filter(|c| *c != '-')
        .take(6)
        .collect()
}

/// `[steps, scanDirs]`: see the harness; one entry per step, then the
/// folders a session left, listed and removed
fn image_export_call(args: &[Value]) -> Answer {
    let steps = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("steps"))?;
    let scan_dirs = string_list(arg(args, 1))?;
    let env = ImageExportEnv {
        random_uuid: &random_uuid,
        mkdtemp_suffix: &mkdtemp_suffix,
    };
    let mut sessions = ImageExportSessions::new();
    let mut ids: Vec<String> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    let answer = |outcome: Result<Value, NodeError>| match outcome {
        Ok(value) => json!({ "ok": value }),
        Err(error) => error_value(&error),
    };
    for step in steps {
        let op = field_str(step, "op")?;
        let owner = opt_num(step.get("owner"))?.unwrap_or(f64::NAN);
        let outcome: Result<Value, NodeError> = match op {
            "start" => {
                let started = sessions.start(
                    &env,
                    owner,
                    field_str(step, "parent")?,
                    field_str(step, "name")?,
                );
                started.map(|id| {
                    ids.push(id);
                    Value::Null
                })
            }
            "startFiles" => sessions
                .start_files(&env, owner, field_str(step, "target")?)
                .map(|id| {
                    ids.push(id);
                    Value::Null
                }),
            "write" => {
                let page = opt_num(step.get("page"))?.unwrap_or(f64::NAN);
                let base64 = step.get("base64").and_then(Value::as_str);
                sessions
                    .write(owner, &id_of(&ids, step), page, base64)
                    .map(|()| Value::Null)
            }
            "finish" => sessions
                .finish(
                    owner,
                    &id_of(&ids, step),
                    step.get("success") == Some(&Value::Bool(true)),
                )
                .map(|dir| dir.map_or(Value::Null, Value::from)),
            "finishExport" => sessions
                .finish_export(
                    owner,
                    &id_of(&ids, step),
                    step.get("success") == Some(&Value::Bool(true)),
                )
                .map(|done| match done {
                    Some(done) => json!({ "dir": done.dir, "first": done.first }),
                    None => Value::Null,
                }),
            "dispose" => sessions.dispose(owner).map(|()| Value::Null),
            _ => return Err(bad("op")),
        };
        results.push(answer(outcome));
    }
    let mut leftovers: Vec<Value> = Vec::new();
    for dir in &scan_dirs {
        let mut names: Vec<String> = fs::read_dir(dir)
            .map(|reader| {
                reader
                    .filter_map(Result::ok)
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        for name in names {
            if !js_regex!(r"-images-[A-Za-z0-9]{6}$").test(&name) {
                continue;
            }
            let path = format!("{dir}/{name}");
            let mut files: Vec<String> = fs::read_dir(&path)
                .map(|reader| {
                    reader
                        .filter_map(Result::ok)
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default();
            files.sort();
            leftovers.push(json!({ "name": mask_random(&name), "files": files }));
            let _ = fs::remove_dir_all(&path);
        }
    }
    let text = mask_random(&serde_json::to_string(&results).expect("results print"));
    let results: Value = serde_json::from_str(&text).expect("masked results parse");
    Ok(Some(json!({ "results": results, "leftovers": leftovers })))
}

// ---- image-host ----

/// the `Math.random()` of the TypeScript harness: a fixed list, in turn
const RANDOMS: [f64; 3] = [0.31, 0.62, 0.93];

/// `[prefix | null, ext, nowMs, random | null]`
fn object_key_call(args: &[Value]) -> Answer {
    let prefix = opt_str(args, 0)?;
    let ext = str_arg(args, 1)?;
    let now = opt_num(arg(args, 2))?.ok_or_else(|| bad("now"))?;
    let random = opt_num(arg(args, 3))?.unwrap_or(0.3);
    match host::image_object_key(prefix, ext, now, random) {
        Ok(key) => Ok(Some(Value::from(key))),
        Err(host::Thrown::Error(message)) => Err(CallError::plain(message)),
        Err(_) => Err(bad("a thrown value")),
    }
}

/// `[method, url, headers, payloadText, creds, amzDate]`
fn sig_v4_call(args: &[Value]) -> Answer {
    let method = str_arg(args, 0)?;
    let url = url::Url::parse(str_arg(args, 1)?).map_err(|_| CallError {
        code: Some("ERR_INVALID_URL".to_owned()),
        message: "Invalid URL".to_owned(),
    })?;
    let headers: Vec<(String, String)> = arg(args, 2)
        .and_then(Value::as_object)
        .ok_or_else(|| bad("headers"))?
        .iter()
        .map(|(k, v)| {
            v.as_str()
                .map(|v| (k.clone(), v.to_owned()))
                .ok_or_else(|| bad("a header value"))
        })
        .collect::<Result<_, _>>()?;
    let payload = str_arg(args, 3)?;
    let creds = arg(args, 4).ok_or_else(|| bad("creds"))?;
    let amz_date = str_arg(args, 5)?;
    let signature = host::sig_v4(
        method,
        &url,
        &headers,
        payload.as_bytes(),
        &SigV4Credentials {
            access_key_id: field_str(creds, "accessKeyId")?,
            secret_access_key: field_str(creds, "secretAccessKey")?,
            region: field_str(creds, "region")?,
            service: field_str(creds, "service")?,
        },
        amz_date,
    );
    Ok(Some(Value::from(signature)))
}

fn head_hex(bytes: &[u8]) -> String {
    bytes.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn pairs_value(pairs: &[(String, String)]) -> Value {
    Value::Array(pairs.iter().map(|(k, v)| json!([k, v])).collect())
}

fn body_value(body: &FetchBody<'_>) -> Value {
    match body {
        FetchBody::Bytes(bytes) => json!(["bytes", bytes.len(), head_hex(bytes)]),
        FetchBody::Text(text) => json!(["text", text]),
        FetchBody::Form {
            field,
            file_name,
            mime,
            bytes,
        } => json!(["form", field, file_name, mime, bytes.len(), head_hex(bytes)]),
    }
}

/// the response the spec describes, or the failure it throws
fn scripted_response(spec: &Value) -> Result<FetchResponse, FetchFailure> {
    if let Some(kind) = spec.get("throw").and_then(Value::as_str) {
        return Err(match kind {
            "string" => FetchFailure::NonError,
            _ => FetchFailure::Error(
                spec.get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("fetch failed")
                    .to_owned(),
            ),
        });
    }
    let headers = match spec.get("headers") {
        Some(Value::String(kind)) if kind == "absent" => ResponseHeaders::Absent,
        Some(Value::String(kind)) if kind == "noGet" => ResponseHeaders::NoGet,
        other => {
            let header = |name: &str| {
                other
                    .and_then(|h| h.get(name))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            ResponseHeaders::Get {
                location: header("location"),
                content_length: header("content-length"),
            }
        }
    };
    let text = if let Some(message) = spec.get("textReject").and_then(Value::as_str) {
        Some(Err(message.to_owned()))
    } else {
        match spec.get("text") {
            None => Some(Ok(String::new())),
            Some(Value::Null) => None,
            Some(Value::String(text)) => Some(Ok(text.clone())),
            Some(_) => return Err(FetchFailure::Error("bad text".to_owned())),
        }
    };
    Ok(FetchResponse {
        ok: spec.get("ok") == Some(&Value::Bool(true)),
        status: spec.get("status").and_then(Value::as_f64).unwrap_or(0.0),
        opaque_redirect: spec.get("opaque") == Some(&Value::Bool(true)),
        headers,
        text,
    })
}

/// `[config, { bytes, ext, now }, { responses }]`; `bytes` is `{ hex }` or
/// `{ length, fill }`; every fetch is one log line
fn upload_call(args: &[Value], cx: &mut Context) -> Answer {
    let config = arg(args, 0).map(json_value_from_serde);
    let input = arg(args, 1).ok_or_else(|| bad("input"))?;
    let bytes_spec = input.get("bytes").ok_or_else(|| bad("bytes"))?;
    let bytes: Vec<u8> = match bytes_spec.get("hex").and_then(Value::as_str) {
        Some(hex) => (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).map_err(|_| bad("hex")))
            .collect::<Result<_, _>>()?,
        None => vec![
            bytes_spec.get("fill").and_then(Value::as_u64).unwrap_or(0) as u8;
            bytes_spec
                .get("length")
                .and_then(Value::as_u64)
                .ok_or_else(|| bad("length"))? as usize
        ],
    };
    let ext = field_str(input, "ext")?;
    let now = opt_num(input.get("now"))?.unwrap_or(cx.now_ms);
    let responses: Vec<Value> = arg(args, 2)
        .and_then(|fake| fake.get("responses"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut next = 0usize;
    let mut logs: Vec<Vec<Value>> = Vec::new();
    let mut fetch = |url: &str, init: &FetchInit<'_>| -> Result<FetchResponse, FetchFailure> {
        logs.push(vec![
            Value::from(url),
            Value::from(init.method),
            pairs_value(&init.headers),
            body_value(&init.body),
            Value::from(init.redirect),
            Value::Bool(init.timeout_ms == 20_000),
        ]);
        let Some(spec) = responses.get(next) else {
            return Err(FetchFailure::Error("no more responses".to_owned()));
        };
        next += 1;
        scripted_response(spec)
    };
    let drawn = Cell::new(0usize);
    let mut random = || {
        let at = drawn.get();
        drawn.set(at + 1);
        RANDOMS[at % RANDOMS.len()]
    };
    let result =
        host::upload_image_to_host(config.as_ref(), &bytes, ext, &mut fetch, now, &mut random);
    cx.logs.extend(logs);
    Ok(Some(serde_json::to_value(result).expect("a result prints")))
}

// ---- wiki ----

/// `[targets, { fromPath, root }]`: the map as a list of `[target, link]`
fn resolve_call(args: &[Value], cx: &Context) -> Answer {
    let targets = string_list(arg(args, 0))?;
    let options = arg(args, 1).ok_or_else(|| bad("options"))?;
    let now = cx.now_ms;
    let clock = || now;
    let mut fs = node_fs(&clock);
    let resolved = resolve_wiki_links(
        &targets,
        &ResolveOptions {
            from_path: field_str(options, "fromPath")?,
            root: field_str(options, "root")?,
        },
        &mut fs,
    );
    let entries: Vec<Value> = resolved
        .iter()
        .map(|(raw, link)| json!([raw, { "path": link.path, "fragment": link.fragment, "found": link.found }]))
        .collect();
    Ok(Some(Value::Array(entries)))
}

/// `[root, cap | null]`; a string cap is `Number(cap)` (`"NaN"`, `"Infinity"`)
fn notes_call(args: &[Value], cx: &Context) -> Answer {
    let root = str_arg(args, 0)?;
    let cap = match arg(args, 1) {
        None | Some(Value::Null) => MAX_NOTES,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => to_number(text),
        Some(_) => return Err(bad("cap")),
    };
    let now = cx.now_ms;
    let clock = || now;
    let mut fs = node_fs(&clock);
    let notes = list_wiki_notes(root, &mut fs, cap);
    Ok(Some(serde_json::to_value(notes).expect("notes print")))
}

/// `[target, { root, fromDir }]`
fn create_note_call(args: &[Value]) -> Answer {
    let target = str_arg(args, 0)?;
    let options = arg(args, 1).ok_or_else(|| bad("options"))?;
    let created = create_wiki_note(
        target,
        &CreateNoteOptions {
            root: field_str(options, "root")?,
            from_dir: field_str(options, "fromDir")?,
        },
    )?;
    Ok(Some(match created {
        Some(note) => serde_json::to_value(note).expect("a note prints"),
        None => Value::Null,
    }))
}

/// `[target, fromPath, root]`
fn heads_call(args: &[Value], cx: &Context) -> Answer {
    let target = str_arg(args, 0)?;
    let from_path = str_arg(args, 1)?;
    let root = str_arg(args, 2)?;
    let now = cx.now_ms;
    let clock = || now;
    let mut fs = node_fs(&clock);
    Ok(Some(
        serde_json::to_value(wiki_heads(target, from_path, root, &mut fs)).expect("entries print"),
    ))
}

/// `[steps]` over `rememberWikiFragment` / `takeWikiFragment`: `{ op: "remember", path,
/// fragment }` and `{ op: "take", path }`; one entry per `take`
fn fragment_script(args: &[Value]) -> Answer {
    let steps = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("steps"))?;
    let mut fragments = WikiFragments::new();
    let mut taken: Vec<Value> = Vec::new();
    for step in steps {
        let path = field_str(step, "path")?;
        match field_str(step, "op")? {
            "remember" => {
                fragments.remember_wiki_fragment(path, field_str(step, "fragment")?);
            }
            "take" => taken.push(Value::from(fragments.take_wiki_fragment(path))),
            _ => return Err(bad("op")),
        }
    }
    Ok(Some(Value::Array(taken)))
}

fn set_mtime(path: &str, ms: f64) -> Result<(), CallError> {
    let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64);
    fs::File::open(path)
        .and_then(|file| file.set_modified(at))
        .map_err(|e| CallError::plain(format!("set mtime: {e}")))
}

/// `[steps]` over a real folder: the steps change it (`write`, `mkdir`,
/// `rm`, `touch`), move the clock (`tick`), start a new `nodeVaultFs()`
/// (`newFs`) or ask (`isFile`, `list`, `read`, `mtime`, `backlinks`, `tags`,
/// `graph`, `warm`); one entry per question. The index and the filesystem
/// live through the script, the clock starts at `cx.now`.
fn run_vault_script(args: &[Value], cx: &Context) -> Answer {
    let steps = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("steps"))?;
    let clock = Cell::new(cx.now_ms);
    let now = || clock.get();
    let mut vfs = node_vault_fs(&now);
    let mut index = WikiIndex::new();
    let mut out: Vec<Value> = Vec::new();
    for step in steps {
        let op = field_str(step, "op")?;
        let path = || field_str(step, "path");
        let root = || field_str(step, "root");
        let outcome: Value = match op {
            "write" => {
                let path = path()?;
                if let Some(parent) = std::path::Path::new(path).parent() {
                    let _ = fs::create_dir_all(parent);
                }
                fs::write(path, field_str(step, "text")?)
                    .map_err(|e| CallError::plain(format!("write: {e}")))?;
                if let Some(ms) = opt_num(step.get("mtimeMs"))? {
                    set_mtime(path, ms)?;
                }
                continue;
            }
            "mkdir" => {
                let path = path()?;
                fs::create_dir_all(path).map_err(|e| CallError::plain(format!("mkdir: {e}")))?;
                if let Some(ms) = opt_num(step.get("mtimeMs"))? {
                    set_mtime(path, ms)?;
                }
                continue;
            }
            "rm" => {
                let path = path()?;
                let _ = fs::remove_dir_all(path).or_else(|_| fs::remove_file(path));
                continue;
            }
            "touch" => {
                let ms = opt_num(step.get("mtimeMs"))?.ok_or_else(|| bad("mtimeMs"))?;
                set_mtime(path()?, ms)?;
                continue;
            }
            "tick" => {
                clock.set(clock.get() + opt_num(step.get("ms"))?.unwrap_or(0.0));
                continue;
            }
            "newFs" => {
                vfs = node_vault_fs(&now);
                continue;
            }
            "isFile" => Value::Bool(vfs.is_file(path()?)),
            "list" => match vfs.list(field_str(step, "dir")?) {
                Ok(listing) => json!({ "files": listing.files, "dirs": listing.dirs }),
                Err(error) => error_value(&error),
            },
            "read" => match crate::markdown::wiki_index::VaultFs::read(&mut vfs, path()?) {
                Ok(text) => Value::from(text),
                Err(error) => error_value(&error),
            },
            "mtime" => num(crate::markdown::wiki_index::VaultFs::mtime_ms(
                &mut vfs,
                path()?,
            )),
            "backlinks" => serde_json::to_value(index.wiki_backlinks(
                root()?,
                field_str(step, "path")?,
                &mut vfs,
            ))
            .expect("backlinks print"),
            "tags" => serde_json::to_value(index.wiki_tags(root()?, &mut vfs)).expect("tags print"),
            "graph" => {
                serde_json::to_value(index.wiki_graph(root()?, &mut vfs)).expect("a graph prints")
            }
            "warm" => {
                let root = root()?;
                index.warm_wiki_index(root, &mut vfs);
                // the TypeScript's build runs in the background; the tags that
                // follow wait for it (the builds of a root are chained)
                let _ = index.wiki_tags(root, &mut vfs);
                Value::Null
            }
            _ => return Err(bad("op")),
        };
        out.push(outcome);
    }
    Ok(Some(Value::Array(out)))
}

// ---- asset-lifecycle ----

/// a Node error with the random part of a temp name written `<hex>`
fn node<T>(result: Result<T, NodeError>) -> Result<T, CallError> {
    result.map_err(masked)
}

fn hex_bytes(text: &str) -> Result<Vec<u8>, CallError> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).map_err(|_| bad("hex")))
        .collect()
}

fn plan_arg(args: &[Value], i: usize) -> Result<PreparedSaveAsAssets, CallError> {
    let plan = arg(args, i).ok_or_else(|| bad("plan"))?;
    let created = plan
        .get("created")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("created"))?
        .iter()
        .map(|record| {
            Ok(assets::OwnedAssetRecord {
                name: field_str(record, "name")?.to_owned(),
                sha256: field_str(record, "sha256")?.to_owned(),
            })
        })
        .collect::<Result<Vec<_>, CallError>>()?;
    Ok(PreparedSaveAsAssets {
        target_document_path: field_str(plan, "targetDocumentPath")?.to_owned(),
        text: String::new(),
        image_sources: Vec::new(),
        rewrites: Vec::new(),
        created,
    })
}

/// a `ReconcileResult` with the random part of a temp name in its errors written `<hex>`
fn reconcile_value(mut result: assets::ReconcileResult) -> Value {
    result.errors = result.errors.iter().map(|e| mask_tmp(e)).collect();
    serde_json::to_value(result).expect("a result prints")
}

fn asset_call(name: &str, args: &[Value]) -> Option<Answer> {
    Some(match name {
        "markdown/asset-lifecycle.ASSET_MANIFEST_FILENAME" => {
            ok(Value::from(assets::ASSET_MANIFEST_FILENAME))
        }
        "markdown/asset-lifecycle.copyImageIntoOwnedAssets" => (|| -> Answer {
            let result = node(assets::copy_image_into_owned_assets(
                str_arg(args, 0)?,
                str_arg(args, 1)?,
            ))?;
            ok(Value::from(result))
        })(),
        "markdown/asset-lifecycle.writeImageIntoOwnedAssets" => (|| -> Answer {
            let bytes = hex_bytes(str_arg(args, 2)?)?;
            let result = node(assets::write_image_into_owned_assets(
                str_arg(args, 0)?,
                str_arg(args, 1)?,
                &bytes,
            ))?;
            ok(Value::from(result))
        })(),
        "markdown/asset-lifecycle.resolveSafeRelativeImagePath" => {
            str_arg(args, 0).and_then(|doc| {
                let source = str_arg(args, 1)?;
                ok(assets::resolve_safe_relative_image_path(doc, source)
                    .map_or(Value::Null, Value::from))
            })
        }
        "markdown/asset-lifecycle.resolveSafeVaultImagePath" => {
            str_arg(args, 0).and_then(|root| {
                let target = str_arg(args, 1)?;
                ok(assets::resolve_safe_vault_image_path(root, target)
                    .map_or(Value::Null, Value::from))
            })
        }
        "markdown/asset-lifecycle.extractMarkdownImageSources" => str_arg(args, 0)
            .and_then(|text| ok(json!(node(assets::extract_markdown_image_sources(text))?))),
        "markdown/asset-lifecycle.isInDocDir" => str_arg(args, 0).and_then(|target| {
            let dir = str_arg(args, 1)?;
            let separator = opt_str(args, 2)?.unwrap_or(jscompat::node_path::host::SEP);
            ok(Value::Bool(assets::is_in_doc_dir(target, dir, separator)))
        }),
        "markdown/asset-lifecycle.rewriteMarkdownImageSources" => (|| -> Answer {
            let markdown = str_arg(args, 0)?;
            let mut rewrites: OrdMap<String> = OrdMap::new();
            for pair in arg(args, 1)
                .and_then(Value::as_array)
                .ok_or_else(|| bad("rewrites"))?
            {
                let pair = pair.as_array().ok_or_else(|| bad("a pair"))?;
                let from = pair
                    .first()
                    .and_then(Value::as_str)
                    .ok_or_else(|| bad("from"))?;
                let to = pair
                    .get(1)
                    .and_then(Value::as_str)
                    .ok_or_else(|| bad("to"))?;
                rewrites.set(from, to.to_owned());
            }
            ok(Value::from(node(assets::rewrite_markdown_image_sources(
                markdown, &rewrites,
            ))?))
        })(),
        "markdown/asset-lifecycle.prepareAssetsForSaveAs" => (|| -> Answer {
            let prepared = node(assets::prepare_assets_for_save_as(
                str_arg(args, 0)?,
                str_arg(args, 1)?,
                str_arg(args, 2)?,
                &string_list(arg(args, 3))?,
            ))?;
            ok(serde_json::to_value(prepared).expect("a plan prints"))
        })(),
        "markdown/asset-lifecycle.rollbackPreparedSaveAsAssets" => (|| -> Answer {
            node(assets::rollback_prepared_save_as_assets(&plan_arg(
                args, 0,
            )?))?;
            Ok(None)
        })(),
        "markdown/asset-lifecycle.pendingOwnedAssetsForDocument" => str_arg(args, 0)
            .and_then(|doc| ok(json!(assets::pending_owned_assets_for_document(doc)))),
        "markdown/asset-lifecycle.discardPendingOwnedAssets" => str_arg(args, 0)
            .and_then(|doc| ok(reconcile_value(assets::discard_pending_owned_assets(doc)))),
        "markdown/asset-lifecycle.resolveSourcePendingAfterSaveAs" => (|| -> Answer {
            let doc = str_arg(args, 0)?;
            let names = string_list(arg(args, 1))?;
            ok(reconcile_value(
                assets::resolve_source_pending_after_save_as(doc, &names),
            ))
        })(),
        "markdown/asset-lifecycle.reconcileOwnedAssets" => (|| -> Answer {
            let doc = str_arg(args, 0)?;
            let sources = string_list(arg(args, 1))?;
            let pending = match arg(args, 2) {
                None | Some(Value::Null) => None,
                other => Some(string_list(other)?),
            };
            ok(reconcile_value(assets::reconcile_owned_assets(
                doc,
                &sources,
                pending.as_deref(),
            )))
        })(),
        "markdown/asset-lifecycle.renameOwnedAssetDocument" => str_arg(args, 0).and_then(|old| {
            let new = str_arg(args, 1)?;
            node(assets::rename_owned_asset_document(old, new))?;
            Ok(None)
        }),
        "markdown/asset-lifecycle.readOwnedAssetManifest" => str_arg(args, 0).and_then(|doc| {
            ok(assets::read_owned_asset_manifest(doc).map_or(Value::Null, |m| m.to_value()))
        }),
        _ => return None,
    })
}
