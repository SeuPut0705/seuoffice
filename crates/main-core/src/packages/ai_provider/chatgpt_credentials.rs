//! `packages/ai-provider/src/chatgpt/credentials.ts`: where the ChatGPT
//! connection keeps its tokens: one file in the app's data folder,
//! `chatgpt-connection.json`. The tokens are the app's own (OpenAI issued them
//! to this app's registration), never a vendor program's login.
//!
//! - The access, refresh and ID tokens are sealed with the same codec as the
//!   keys in ai-settings.json (decision 0063); a sealed token that cannot be
//!   opened reads as no session. The codec is a parameter here (see
//!   `settings_secrets`), `None` being "no codec registered".
//! - The file is written whole, to a temporary name first and then renamed,
//!   with owner-only permissions where the system has them.
//! - No e-mail address is written. The account's stable id (`subject`) is.
//! - `hostId` names this installation to OpenAI and outlives a sign-out; the
//!   issued `clientId` outlives an ended session. `callbackPath` is the
//!   loopback path that id was issued for.
//!
//! `ChatGptConnectionStore` is the TypeScript interface: [`ChatGptConnectionFileStore`]
//! and [`ChatGptConnectionMemoryStore`] implement it, and a caller may bring
//! its own.

use std::cell::RefCell;
use std::pin::Pin;
use std::rc::Rc;

use jscompat::{JsonValue, js_regex, json_parse, json_stringify_pretty, number_to_string};

use super::jsval::{Obj, as_record, as_str, length16, number, prop, text};
use super::settings_secrets::{AiSecretCodec, open_secret_value, seal_secret_value};
use super::task::{FsAnswer, FsOp, JsError, Rt};

pub const CHATGPT_CONNECTION_FILE: &str = "chatgpt-connection.json";

/// `ChatGptSession`
#[derive(Debug, Clone, PartialEq)]
pub struct ChatGptSession {
    pub access_token: String,
    pub refresh_token: String,
    /// epoch milliseconds
    pub expires_at: f64,
    pub scopes: Vec<String>,
    pub id_token: Option<String>,
}

impl ChatGptSession {
    /// the object `sessionOf` builds
    pub fn to_json(&self) -> JsonValue {
        let mut out = Obj::new();
        out.set("accessToken", text(self.access_token.clone()));
        out.set("refreshToken", text(self.refresh_token.clone()));
        out.set("expiresAt", number(self.expires_at));
        out.set(
            "scopes",
            JsonValue::Array(self.scopes.iter().map(|s| text(s.clone())).collect()),
        );
        if let Some(id_token) = non_empty(&self.id_token) {
            out.set("idToken", text(id_token));
        }
        JsonValue::Object(out)
    }
}

/// `ChatGptConnectionRecord`
#[derive(Debug, Clone, PartialEq)]
pub struct ChatGptConnectionRecord {
    /// `urn:uuid:...`, made once per installation
    pub host_id: String,
    /// the id OpenAI issued at the last sign-in; absent until one
    pub client_id: Option<String>,
    /// the loopback path `clientId` was issued for
    pub callback_path: Option<String>,
    /// the signed-in account's stable id
    pub subject: Option<String>,
    /// absent when signed out
    pub session: Option<ChatGptSession>,
}

impl ChatGptConnectionRecord {
    /// `{ hostId }`
    pub fn fresh(host_id: String) -> Self {
        ChatGptConnectionRecord {
            host_id,
            client_id: None,
            callback_path: None,
            subject: None,
            session: None,
        }
    }

    /// the record as the app holds it: the keys `chatGptConnectionOf` writes
    pub fn to_json(&self) -> JsonValue {
        let mut out = Obj::new();
        out.set("hostId", text(self.host_id.clone()));
        for (key, value) in [
            ("clientId", &self.client_id),
            ("callbackPath", &self.callback_path),
            ("subject", &self.subject),
        ] {
            if let Some(value) = value {
                out.set(key, text(value.clone()));
            }
        }
        if let Some(session) = &self.session {
            out.set("session", session.to_json());
        }
        JsonValue::Object(out)
    }
}

/// the string of an optional string field when it is truthy
fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}

/// What `read()` and `write()` of a store answer: a promise that may reject.
pub type StoreFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, JsError>> + 'a>>;

/// `ChatGptConnectionStore`
pub trait ChatGptConnectionStore {
    fn read<'a>(&'a self, rt: &'a Rt) -> StoreFuture<'a, ChatGptConnectionRecord>;
    fn write<'a>(&'a self, rt: &'a Rt, record: ChatGptConnectionRecord) -> StoreFuture<'a, ()>;
}

/// `newChatGptHostId()`
pub fn new_chatgpt_host_id(rt: &Rt) -> String {
    format!("urn:uuid:{}", rt.random_uuid())
}

/// `stringField(value)`
fn string_field(value: Option<&JsonValue>) -> Option<&str> {
    as_str(value).filter(|v| !v.is_empty())
}

/// `sessionOf(value)`
fn session_of(
    codec: Option<&dyn AiSecretCodec>,
    value: Option<&JsonValue>,
) -> Option<ChatGptSession> {
    let value = value?;
    as_record(value)?;
    let access_token = open_secret_value(
        codec,
        string_field(prop(value, "accessToken")).unwrap_or(""),
    );
    let refresh_token = open_secret_value(
        codec,
        string_field(prop(value, "refreshToken")).unwrap_or(""),
    );
    let id_token = open_secret_value(codec, string_field(prop(value, "idToken")).unwrap_or(""));
    let expires_at = match prop(value, "expiresAt") {
        Some(JsonValue::Number(n)) => *n,
        _ => 0.0,
    };
    let scopes = match prop(value, "scopes") {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|s| as_str(Some(s)).map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    };
    // a token that cannot be opened (another PC, another account) is no session
    if access_token.is_empty() || refresh_token.is_empty() {
        return None;
    }
    Some(ChatGptSession {
        access_token,
        refresh_token,
        expires_at,
        scopes,
        id_token: (!id_token.is_empty()).then_some(id_token),
    })
}

/// `chatGptConnectionOf(value)`: the stored file as the app understands it;
/// anything broken reads as a fresh host
pub fn chatgpt_connection_of(
    rt: &Rt,
    codec: Option<&dyn AiSecretCodec>,
    value: &JsonValue,
) -> ChatGptConnectionRecord {
    if as_record(value).is_none() {
        return ChatGptConnectionRecord::fresh(new_chatgpt_host_id(rt));
    }
    let host_id = string_field(prop(value, "hostId"));
    let client_id = string_field(prop(value, "clientId"));
    let subject = string_field(prop(value, "subject"));
    let session = session_of(codec, prop(value, "session"));
    let issued = client_id.filter(|id| js_regex!(r"^[A-Za-z0-9._-]{1,256}$").test(id));
    let callback_path = string_field(prop(value, "callbackPath"));
    let host_id = match host_id {
        Some(id) if js_regex!(r"^urn:uuid:[0-9a-f-]{36}$", "i").test(id) => id.to_owned(),
        _ => new_chatgpt_host_id(rt),
    };
    ChatGptConnectionRecord {
        host_id,
        client_id: issued.map(str::to_owned),
        // the path belongs to the client id: without one there is nothing it was issued for
        callback_path: match (issued, callback_path) {
            (Some(_), Some(path)) if js_regex!(r"^(/[A-Za-z0-9_-]{1,32}){1,4}$").test(path) => {
                Some(path.to_owned())
            }
            _ => None,
        },
        subject: subject.filter(|s| length16(s) <= 256).map(str::to_owned),
        session,
    }
}

/// `storedChatGptConnection(record)`: the record as it goes to disk: tokens
/// sealed when this PC can
pub fn stored_chatgpt_connection(
    codec: Option<&dyn AiSecretCodec>,
    record: &ChatGptConnectionRecord,
) -> JsonValue {
    let mut out = Obj::new();
    out.set("hostId", text(record.host_id.clone()));
    if let Some(client_id) = non_empty(&record.client_id) {
        out.set("clientId", text(client_id));
        if let Some(path) = non_empty(&record.callback_path) {
            out.set("callbackPath", text(path));
        }
    }
    if let Some(subject) = non_empty(&record.subject) {
        out.set("subject", text(subject));
    }
    if let Some(session) = &record.session {
        let mut stored = Obj::new();
        stored.set(
            "accessToken",
            text(seal_secret_value(codec, &session.access_token)),
        );
        stored.set(
            "refreshToken",
            text(seal_secret_value(codec, &session.refresh_token)),
        );
        if let Some(id_token) = non_empty(&session.id_token) {
            stored.set("idToken", text(seal_secret_value(codec, id_token)));
        }
        stored.set("expiresAt", number(session.expires_at));
        stored.set(
            "scopes",
            JsonValue::Array(session.scopes.iter().map(|s| text(s.clone())).collect()),
        );
        out.set("session", JsonValue::Object(stored));
    }
    JsonValue::Object(out)
}

/// `createChatGptConnectionFileStore(dataDir)`: the file store in `dataDir`.
/// A missing or unreadable file is a fresh host, whose id is written with the
/// first record saved.
pub struct ChatGptConnectionFileStore {
    data_dir: String,
    path: String,
    codec: Option<Rc<dyn AiSecretCodec>>,
    /// `fresh`
    fresh: RefCell<Option<ChatGptConnectionRecord>>,
}

impl ChatGptConnectionFileStore {
    pub fn new(data_dir: &str, codec: Option<Rc<dyn AiSecretCodec>>) -> Self {
        ChatGptConnectionFileStore {
            data_dir: data_dir.to_owned(),
            path: jscompat::node_path::host::join(&[data_dir, CHATGPT_CONNECTION_FILE]),
            codec,
            fresh: RefCell::new(None),
        }
    }

    async fn read_file(&self, rt: &Rt) -> Result<ChatGptConnectionRecord, JsError> {
        let bytes = match rt
            .fs(FsOp::ReadFile {
                path: self.path.clone(),
            })
            .await?
        {
            FsAnswer::Bytes(bytes) => bytes,
            other => return Err(JsError::type_error(format!("readFile answered {other:?}"))),
        };
        let parsed = json_parse(&String::from_utf8_lossy(&bytes))
            .map_err(|e| JsError::new("SyntaxError", e.message()))?;
        Ok(chatgpt_connection_of(rt, self.codec.as_deref(), &parsed))
    }
}

impl ChatGptConnectionStore for ChatGptConnectionFileStore {
    fn read<'a>(&'a self, rt: &'a Rt) -> StoreFuture<'a, ChatGptConnectionRecord> {
        Box::pin(async move {
            match self.read_file(rt).await {
                Ok(record) => Ok(record),
                Err(_) => {
                    // the same new host id for every read until one is written
                    let mut fresh = self.fresh.borrow_mut();
                    let kept = fresh.get_or_insert_with(|| {
                        ChatGptConnectionRecord::fresh(new_chatgpt_host_id(rt))
                    });
                    Ok(kept.clone())
                }
            }
        })
    }

    fn write<'a>(&'a self, rt: &'a Rt, record: ChatGptConnectionRecord) -> StoreFuture<'a, ()> {
        Box::pin(async move {
            rt.fs(FsOp::Mkdir {
                path: self.data_dir.clone(),
                recursive: true,
                mode: None,
            })
            .await?;
            let temp = format!(
                "{}.{}.{}.tmp",
                self.path,
                number_to_string(rt.pid()),
                rt.random_uuid()
            );
            let stored = stored_chatgpt_connection(self.codec.as_deref(), &record);
            let data = format!("{}\n", json_stringify_pretty(&stored, 2));
            let written: Result<(), JsError> = async {
                rt.fs(FsOp::WriteFile {
                    path: temp.clone(),
                    data: data.into_bytes(),
                    mode: Some(f64::from(0o600)),
                    flag: None,
                })
                .await?;
                rt.fs(FsOp::Rename {
                    from: temp.clone(),
                    to: self.path.clone(),
                })
                .await?;
                Ok(())
            }
            .await;
            if let Err(error) = written {
                let _ = rt
                    .fs(FsOp::Rm {
                        path: temp,
                        recursive: false,
                        force: true,
                    })
                    .await;
                return Err(error);
            }
            *self.fresh.borrow_mut() = None;
            Ok(())
        })
    }
}

/// `createChatGptConnectionMemoryStore(initial)`: a store in memory, for tests
/// and for processes that must not touch the disk
pub struct ChatGptConnectionMemoryStore {
    record: RefCell<ChatGptConnectionRecord>,
}

impl ChatGptConnectionMemoryStore {
    /// `initial ?? { hostId: newChatGptHostId() }`
    pub fn new(rt: &Rt, initial: Option<ChatGptConnectionRecord>) -> Self {
        ChatGptConnectionMemoryStore {
            record: RefCell::new(
                initial.unwrap_or_else(|| ChatGptConnectionRecord::fresh(new_chatgpt_host_id(rt))),
            ),
        }
    }

    /// `current()`
    pub fn current(&self) -> ChatGptConnectionRecord {
        self.record.borrow().clone()
    }
}

impl ChatGptConnectionStore for ChatGptConnectionMemoryStore {
    fn read<'a>(&'a self, _rt: &'a Rt) -> StoreFuture<'a, ChatGptConnectionRecord> {
        Box::pin(async move { Ok(self.current()) })
    }

    fn write<'a>(&'a self, _rt: &'a Rt, record: ChatGptConnectionRecord) -> StoreFuture<'a, ()> {
        Box::pin(async move {
            *self.record.borrow_mut() = record;
            Ok(())
        })
    }
}
