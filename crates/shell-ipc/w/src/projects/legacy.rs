//! `project:resolveChat`, `project:appendChat`, `project:loadChat` and
//! `project:rebindChat`: the per-document chat of the app-data project store
//! (`registerProjectIpc` of `apps/docs/src/main/docs-main.ts`, which the shell
//! registers for every editor; the copies in sheets-main and slides-main have
//! the same bodies). The store is [`LegacyProjectStore`]; what stays here is
//! what the handlers judge: the arguments, the sheets session lookup and the
//! look-only mode of a headless export.

use std::rc::Rc;

use jscompat::{JsonValue, json_value_to_serde, number_to_string, to_primitive};
use serde_json::{Map, Value, json};
use shell_contract::Batch;
use shell_contract::error::IpcError;
use shell_contract::ipc::{CallContext, ChannelKind, Handler, RegisterError, Registry, Responder};
use shell_contract::value::IpcValue;

use super::host::LegacyProjectStoreHost;
use super::{json_of, to_ipc};
use crate::home_files::HomeFilesHost;

/// `new Error(message)` thrown by a handler
fn error(message: impl Into<String>) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: message.into(),
    }
}

/// what an `Error` of the store says
fn thrown(message: String) -> IpcError {
    error(message)
}

/// `args.<key>` of the handler's one argument: a `TypeError` for `null` and
/// `undefined`, as V8 words it
fn read<'a>(args: Option<&'a JsonValue>, key: &str) -> Result<Option<&'a JsonValue>, IpcError> {
    match args {
        None | Some(JsonValue::Null) => Err(IpcError {
            name: Some("TypeError".into()),
            message: format!(
                "Cannot read properties of {} (reading '{key}')",
                if args.is_none() { "undefined" } else { "null" }
            ),
        }),
        Some(JsonValue::Object(object)) => Ok(object.get(key)),
        Some(_) => Ok(None),
    }
}

/// `if (value)`
fn truthy(value: Option<&JsonValue>) -> bool {
    value.is_some_and(JsonValue::truthy)
}

/// `String(value)`
fn js_string(value: Option<&JsonValue>) -> String {
    to_primitive(value).map_or_else(|error| error.0, |text| text.to_js_string())
}

/// a value the store is given: `undefined` reads as `null`
fn plain(value: Option<&JsonValue>) -> Value {
    value.map_or(Value::Null, json_value_to_serde)
}

struct Handle {
    kind: &'static str,
    store: LegacyProjectStoreHost,
    home: HomeFilesHost,
}

impl Handle {
    /// `sessionPathResolver(event.sender.id, args.sessionId)` when `path` is empty
    fn session_path(&self, cx: &CallContext, session: Option<&JsonValue>) -> Option<String> {
        self.store
            .sheets_session_path(cx.sender.view, &plain(session))
    }

    fn resolve_chat(
        &self,
        cx: &CallContext,
        args: Option<&JsonValue>,
    ) -> Result<IpcValue, IpcError> {
        // a headless export's hidden window is not a document the user opened:
        // its AI panel gets the ids a tab would get, and the store keeps no
        // trace of the file
        let look_only = self.store.headless();
        if !look_only {
            self.store.ensure_default_project().map_err(thrown)?;
        }
        let file_path = read(args, "filePath")?;
        let mut resolved: Option<JsonValue> = file_path.cloned();
        if !truthy(resolved.as_ref()) && truthy(read(args, "sessionId")?) {
            resolved = self
                .session_path(cx, read(args, "sessionId")?)
                .map(JsonValue::String);
        }
        let Some(path) = resolved.filter(JsonValue::truthy) else {
            let chat = match read(args, "tempChatId")? {
                Some(JsonValue::Null) | None => {
                    IpcValue::String(format!("unsaved-{}", number_to_string(self.home.now_ms())))
                }
                Some(value) => to_ipc(&json_value_to_serde(value)),
            };
            return Ok(IpcValue::Object(vec![
                ("projectId".to_owned(), IpcValue::String("default".into())),
                ("chatId".to_owned(), chat),
            ]));
        };
        let path = plain(Some(&path));
        let found = if look_only {
            self.store.lookup_chat_for_file(&path)
        } else {
            self.store.resolve_chat_for_file(&path)
        };
        found.map(|value| to_ipc(&value)).map_err(thrown)
    }

    fn append_chat(&self, args: Option<&JsonValue>) -> Result<IpcValue, IpcError> {
        let role = read(args, "role")?;
        let role_text = match role {
            Some(JsonValue::String(text)) => Some(text.as_str()),
            _ => None,
        };
        if role_text != Some("user") && role_text != Some("assistant") {
            return Err(error(format!("Invalid chat role: {}", js_string(role))));
        }
        let text = match read(args, "text")? {
            Some(JsonValue::String(text)) if text.encode_utf16().count() <= 200_000 => text,
            _ => {
                return Err(error(
                    "Invalid chat text: must be a string up to 200000 chars",
                ));
            }
        };
        let tools = read(args, "tools")?;
        if truthy(tools) && !matches!(tools, Some(JsonValue::Array(_))) {
            return Err(error("Invalid chat tools"));
        }
        let attachments = read(args, "attachments")?;
        if truthy(attachments) && !matches!(attachments, Some(JsonValue::Array(_))) {
            return Err(error("Invalid chat attachments"));
        }
        let mut message = Map::new();
        message.insert("role".into(), json!(role_text));
        message.insert("text".into(), json!(text));
        for (key, value) in [("tools", tools), ("attachments", attachments)] {
            if truthy(value) {
                message.insert(key.into(), plain(value));
            }
        }
        let scope = read(args, "scope")?;
        if truthy(scope) {
            message.insert("scope".into(), plain(scope));
        }
        let skills = read(args, "skills")?;
        if matches!(skills, Some(JsonValue::Array(_))) {
            message.insert("skills".into(), plain(skills));
        }
        self.store
            .append_chat_message(
                &plain(read(args, "projectId")?),
                &plain(read(args, "chatId")?),
                &Value::Object(message),
            )
            .map_err(thrown)?;
        Ok(IpcValue::Undefined)
    }

    fn load_chat(&self, args: Option<&JsonValue>) -> Result<IpcValue, IpcError> {
        let project_id = plain(read(args, "projectId")?);
        let chat_id = plain(read(args, "chatId")?);
        let limit = match read(args, "limit")? {
            None | Some(JsonValue::Null) => json!(200),
            limit => plain(limit),
        };
        self.store
            .load_chat(&project_id, &chat_id, &limit)
            .map(|messages| to_ipc(&messages))
            .map_err(thrown)
    }

    fn rebind_chat(
        &self,
        cx: &CallContext,
        args: Option<&JsonValue>,
    ) -> Result<IpcValue, IpcError> {
        let mut path: Option<JsonValue> = match read(args, "newFilePath")? {
            None | Some(JsonValue::Null) => None,
            Some(value) => Some(value.clone()),
        };
        if !truthy(path.as_ref()) && truthy(read(args, "sessionId")?) {
            path = self
                .session_path(cx, read(args, "sessionId")?)
                .map(JsonValue::String);
        }
        let project_id = plain(read(args, "projectId")?);
        let temp = plain(read(args, "tempChatId")?);
        if let Some(path) = path.filter(JsonValue::truthy) {
            return self
                .store
                .rebind_chat_to_file(&project_id, &temp, &plain(Some(&path)))
                .map(|value| to_ipc(&value))
                .map_err(thrown);
        }
        let new_chat = read(args, "newChatId")?;
        if truthy(new_chat) {
            self.store
                .rebind_chat(&project_id, &temp, &plain(new_chat))
                .map_err(thrown)?;
        }
        let chat = match new_chat {
            None | Some(JsonValue::Null) => read(args, "tempChatId")?,
            value => value,
        };
        Ok(IpcValue::Object(vec![
            ("projectId".to_owned(), field_ipc(read(args, "projectId")?)),
            ("chatId".to_owned(), field_ipc(chat)),
        ]))
    }
}

/// a value of the request as the reply carries it; `undefined` stays
fn field_ipc(value: Option<&JsonValue>) -> IpcValue {
    match value {
        None => IpcValue::Undefined,
        Some(value) => to_ipc(&json_value_to_serde(value)),
    }
}

impl Handler for Handle {
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let args = args.first().and_then(json_of);
        let args = args.as_ref();
        reply.reply(match self.kind {
            "resolveChat" => self.resolve_chat(cx, args),
            "appendChat" => self.append_chat(args),
            "loadChat" => self.load_chat(args),
            _ => self.rebind_chat(cx, args),
        })
    }
}

pub(super) fn register(
    registry: &mut dyn Registry,
    store: &LegacyProjectStoreHost,
    home: &HomeFilesHost,
) -> Result<(), RegisterError> {
    for (kind, channel) in [
        ("resolveChat", "project:resolveChat"),
        ("appendChat", "project:appendChat"),
        ("loadChat", "project:loadChat"),
        ("rebindChat", "project:rebindChat"),
    ] {
        registry.register(
            Batch::W,
            channel,
            ChannelKind::Invoke,
            Rc::new(Handle {
                kind,
                store: store.clone(),
                home: home.clone(),
            }),
        )?;
    }
    Ok(())
}
