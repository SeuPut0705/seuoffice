//! `apps/shell/src/main/mcp-client/hub-input.ts`: what the settings screen
//! sends, read as untrusted data: well-formed fields are copied one by one,
//! anything else makes the request malformed. The hub then judges what the
//! values mean (names, addresses, header names).
//!
//! A request is a [`JsonValue`] (`None` is `undefined`); the server input and
//! the patch it yields are JSON objects with the keys in the order the
//! TypeScript writes them.

use jscompat::{JsObject, JsonValue, js_regex};

use crate::shell::mcp_servers_api::{MCP_PERMISSIONS, McpPermission};

const ID_MAX: usize = 200;
const NAME_MAX: usize = 256;
const TEXT_MAX: usize = 16 * 1024;
const PASTE_MAX: usize = 256 * 1024;
const ENTRIES_MAX: usize = 256;

fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `isRecord(v)`: an object that is neither `null` nor an array
fn record(value: Option<&JsonValue>) -> Option<&JsObject<JsonValue>> {
    match value {
        Some(JsonValue::Object(object)) => Some(object),
        _ => None,
    }
}

fn short_text(value: Option<&JsonValue>, max: usize) -> Option<&str> {
    match value {
        Some(JsonValue::String(text)) if length(text) <= max => Some(text),
        _ => None,
    }
}

fn string(text: &str) -> JsonValue {
    JsonValue::String(text.to_owned())
}

/// A server id, a tool name: non-empty and short
pub fn server_id_of(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(text)) if !text.is_empty() && length(text) <= ID_MAX => {
            Some(text.clone())
        }
        _ => None,
    }
}

pub fn tool_name_of(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(text)) if !text.is_empty() && length(text) <= NAME_MAX => {
            Some(text.clone())
        }
        _ => None,
    }
}

pub fn paste_text_of(value: Option<&JsonValue>) -> Option<String> {
    short_text(value, PASTE_MAX).map(str::to_owned)
}

pub fn permission_of_input(value: Option<&JsonValue>) -> Option<McpPermission> {
    match value {
        Some(JsonValue::String(text)) => MCP_PERMISSIONS
            .iter()
            .position(|p| *p == text.as_str())
            .map(|i| {
                [
                    McpPermission::Always,
                    McpPermission::Ask,
                    McpPermission::Off,
                ][i]
            }),
        _ => None,
    }
}

pub fn boolean_of(value: Option<&JsonValue>) -> Option<bool> {
    match value {
        Some(JsonValue::Bool(flag)) => Some(*flag),
        _ => None,
    }
}

/// A plan fingerprint as `plannedLaunch` handed it out (`sha256:` and 64 hex digits)
pub fn plan_fingerprint_of(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(text)) if js_regex!(r"^sha256:[0-9a-f]{64}$").test(text) => {
            Some(text.clone())
        }
        _ => None,
    }
}

/// `Read<T>`: a value, `undefined`, or the `BAD` marker
enum Read {
    Absent,
    Bad,
    Value(JsonValue),
}

/// A record of text values where null means "keep the value held"
fn held_record_of(value: Option<&JsonValue>) -> Read {
    let Some(value) = value else {
        return Read::Absent;
    };
    let JsonValue::Object(object) = value else {
        return Read::Bad;
    };
    let entries = object.entries();
    if entries.len() > ENTRIES_MAX {
        return Read::Bad;
    }
    let mut out = JsObject::new();
    for (key, member) in entries {
        if key.is_empty() || length(key) > NAME_MAX {
            return Read::Bad;
        }
        if !matches!(member, JsonValue::Null) && short_text(Some(member), TEXT_MAX).is_none() {
            return Read::Bad;
        }
        out.set(key, member.clone());
    }
    Read::Value(JsonValue::Object(out))
}

fn args_of(value: Option<&JsonValue>) -> Read {
    let Some(value) = value else {
        return Read::Absent;
    };
    let JsonValue::Array(items) = value else {
        return Read::Bad;
    };
    if items.len() > ENTRIES_MAX
        || !items
            .iter()
            .all(|a| short_text(Some(a), TEXT_MAX).is_some())
    {
        return Read::Bad;
    }
    Read::Value(value.clone())
}

fn optional_text(value: Option<&JsonValue>, max: usize) -> Read {
    match value {
        None => Read::Absent,
        Some(value) => match short_text(Some(value), max) {
            Some(_) => Read::Value(value.clone()),
            None => Read::Bad,
        },
    }
}

fn key_of(value: Option<&JsonValue>) -> Read {
    match value {
        None => Read::Absent,
        Some(JsonValue::Null) => Read::Value(JsonValue::Null),
        Some(value) => match short_text(Some(value), TEXT_MAX) {
            Some(_) => Read::Value(value.clone()),
            None => Read::Bad,
        },
    }
}

fn oauth_client_of(value: Option<&JsonValue>) -> Read {
    match value {
        None => return Read::Absent,
        Some(JsonValue::Null) => return Read::Value(JsonValue::Null),
        Some(_) => {}
    }
    let Some(object) = record(value) else {
        return Read::Bad;
    };
    let Some(client_id) = short_text(object.get("clientId"), TEXT_MAX) else {
        return Read::Bad;
    };
    let secret = object.get("clientSecret");
    if !matches!(secret, Some(JsonValue::Null)) && short_text(secret, TEXT_MAX).is_none() {
        return Read::Bad;
    }
    let mut out = JsObject::new();
    out.set("clientId", string(client_id));
    out.set("clientSecret", secret.cloned().unwrap_or(JsonValue::Null));
    Read::Value(JsonValue::Object(out))
}

fn paste_ref_of(value: Option<&JsonValue>) -> Read {
    let Some(value) = value else {
        return Read::Absent;
    };
    let Some(object) = record(Some(value)) else {
        return Read::Bad;
    };
    let token = server_id_of(object.get("token"));
    let index = match object.get("index") {
        Some(JsonValue::Number(n)) if n.is_finite() && n.trunc() == *n && *n >= 0.0 => *n,
        _ => return Read::Bad,
    };
    let Some(token) = token else {
        return Read::Bad;
    };
    let mut out = JsObject::new();
    out.set("token", JsonValue::String(token));
    out.set("index", JsonValue::Number(index));
    Read::Value(JsonValue::Object(out))
}

/// The fields shared by an addition and an edit; `None` when one is malformed
fn fields_of(raw: &JsObject<JsonValue>) -> Option<JsObject<JsonValue>> {
    let transport = match raw.get("transport") {
        None => Read::Absent,
        Some(JsonValue::String(t)) if t == "auto" || t == "sse" => {
            Read::Value(JsonValue::String(t.clone()))
        }
        Some(_) => Read::Bad,
    };
    let allow_plain_http = match raw.get("allowPlainHttp") {
        None => Read::Absent,
        Some(value) => match boolean_of(Some(value)) {
            Some(flag) => Read::Value(JsonValue::Bool(flag)),
            None => Read::Bad,
        },
    };
    let read = [
        ("name", optional_text(raw.get("name"), NAME_MAX)),
        ("url", optional_text(raw.get("url"), TEXT_MAX)),
        ("transport", transport),
        ("key", key_of(raw.get("key"))),
        ("headers", held_record_of(raw.get("headers"))),
        ("oauthClient", oauth_client_of(raw.get("oauthClient"))),
        ("command", optional_text(raw.get("command"), TEXT_MAX)),
        ("args", args_of(raw.get("args"))),
        ("env", held_record_of(raw.get("env"))),
        ("allowPlainHttp", allow_plain_http),
    ];
    let mut patch = JsObject::new();
    for (key, value) in read {
        match value {
            Read::Bad => return None,
            Read::Absent => {}
            Read::Value(value) => patch.set(key, value),
        }
    }
    Some(patch)
}

/// A new server from the registration screen, or `None` when it is malformed
pub fn mcp_server_input_of(raw: Option<&JsonValue>) -> Option<JsonValue> {
    let raw = record(raw)?;
    let kind = match raw.get("kind") {
        Some(JsonValue::String(kind)) if kind == "remote" || kind == "local" => kind,
        _ => return None,
    };
    let fields = fields_of(raw);
    let paste = paste_ref_of(raw.get("paste"));
    let mut out = fields?;
    let name = match out.get("name") {
        Some(JsonValue::String(name)) => name.clone(),
        _ => return None,
    };
    if matches!(paste, Read::Bad) {
        return None;
    }
    out.set("name", JsonValue::String(name));
    out.set("kind", string(kind));
    if let Read::Value(paste) = paste {
        out.set("paste", paste);
    }
    Some(JsonValue::Object(out))
}

/// An edit from the settings screen, or `None` when it is malformed
pub fn mcp_server_patch_of(raw: Option<&JsonValue>) -> Option<JsonValue> {
    let raw = record(raw)?;
    fields_of(raw).map(JsonValue::Object)
}
