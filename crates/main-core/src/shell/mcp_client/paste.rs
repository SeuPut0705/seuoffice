//! `apps/shell/src/main/mcp-client/paste.ts`: settings text pasted from a
//! server's guide (user MCP spec 4.1, 12.3): JSON `{"mcpServers": {...}}`, the
//! same without the wrapper, or Codex TOML `[mcp_servers.<name>]`. Each server
//! is read into the fields of the registration screen. Nothing here reads the
//! PC: a placeholder value (`${NAME}`) is emptied and the variable named.
//!
//! Plain calls. `JSON.parse` is `jscompat::json_parse`, whose
//! `JsonSyntaxError` is worded as V8 12.4 words it, so the line the paste
//! reads out of the message is the same. A paste nested deeper than
//! `jscompat::JSON_MAX_DEPTH` is refused by `json_parse` (V8 parses it): the
//! one difference, no real settings text nests that deep.
//!
//! `toLowerCase` of a name is `str::to_lowercase` (`jscompat` has no case
//! mapping; both apply the final-sigma rule, and the names checked are ASCII).
//!
//! Assumed APIs of the `client_pure` slice:
//! - `packages::agent_core::user_mcp_names::{is_valid_server_name(&str, max_length: f64) -> bool,
//!   MCP_SERVER_NAME_MAX: f64, suggest_server_name_from(raw: &str, taken: impl IntoIterator<Item: AsRef<str>>, source: &ServerNameSource) -> String}`
//!   with `ServerNameSource { url: Option<String>, command: Option<String>, args: Option<Vec<String>> }`;
//! - `shell::mcp_servers_api::{McpServerKind, McpTransport}` with `as_str`.

use std::collections::HashSet;

use jscompat::{JsObject, JsonValue, js_regex, json_parse, number_to_string, slice_utf16, trim};

use super::toml::parse_toml;
use crate::packages::agent_core::user_mcp_names::{
    MCP_SERVER_NAME_MAX, ServerNameSource, is_valid_server_name, suggest_server_name_from,
};
use crate::packages::ai_provider::jsval::{object, text};
use crate::shell::mcp_servers_api::{McpServerKind, McpTransport};

/// `PastedServer['problem']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PastedProblem {
    NoTarget,
    UnsupportedType,
}

impl PastedProblem {
    pub fn as_str(self) -> &'static str {
        match self {
            PastedProblem::NoTarget => "no-target",
            PastedProblem::UnsupportedType => "unsupported-type",
        }
    }
}

/// `PastedServer`
#[derive(Debug, Clone, PartialEq)]
pub struct PastedServer {
    /// the name as pasted
    pub pasted_name: String,
    /// a name that follows the rule and is free
    pub name: String,
    pub name_changed: bool,
    pub kind: McpServerKind,
    pub url: String,
    pub transport: McpTransport,
    pub headers: JsObject<String>,
    pub command: String,
    pub args: Vec<String>,
    pub env: JsObject<String>,
    pub key_needed: bool,
    pub key_env_var: Option<String>,
    /// headers whose pasted value was a placeholder: name -> the variable it named
    pub header_vars: JsObject<String>,
    /// variables whose pasted value was a placeholder: name -> the variable it named
    pub env_vars: JsObject<String>,
    /// a `type` the app does not know
    pub type_ignored: Option<String>,
    /// fields of this server the app does not use
    pub ignored: Vec<String>,
    pub problem: Option<PastedProblem>,
}

fn strings_object(record: &JsObject<String>) -> JsonValue {
    let mut out = JsObject::new();
    for (key, value) in record.entries() {
        out.set(key, text(value.as_str()));
    }
    JsonValue::Object(out)
}

fn string_array(items: &[String]) -> JsonValue {
    JsonValue::Array(items.iter().map(|s| text(s.as_str())).collect())
}

fn optional_text(value: &Option<String>) -> JsonValue {
    value
        .as_deref()
        .map_or(JsonValue::Null, |s| JsonValue::String(s.to_owned()))
}

impl PastedServer {
    /// The value as it crosses to a screen, keys in the interface's order.
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            ("pastedName", text(self.pasted_name.as_str())),
            ("name", text(self.name.as_str())),
            ("nameChanged", JsonValue::Bool(self.name_changed)),
            ("kind", text(self.kind.as_str())),
            ("url", text(self.url.as_str())),
            ("transport", text(self.transport.as_str())),
            ("headers", strings_object(&self.headers)),
            ("command", text(self.command.as_str())),
            ("args", string_array(&self.args)),
            ("env", strings_object(&self.env)),
            ("keyNeeded", JsonValue::Bool(self.key_needed)),
            ("keyEnvVar", optional_text(&self.key_env_var)),
            ("headerVars", strings_object(&self.header_vars)),
            ("envVars", strings_object(&self.env_vars)),
            ("typeIgnored", optional_text(&self.type_ignored)),
            ("ignored", string_array(&self.ignored)),
            (
                "problem",
                self.problem.map_or(JsonValue::Null, |p| text(p.as_str())),
            ),
        ])
    }
}

/// `PasteResult['format']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteFormat {
    Json,
    JsonBare,
    Toml,
}

impl PasteFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            PasteFormat::Json => "json",
            PasteFormat::JsonBare => "json-bare",
            PasteFormat::Toml => "toml",
        }
    }
}

/// `PasteResult['error']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteError {
    Empty,
    Unreadable,
    NoServers,
}

impl PasteError {
    pub fn as_str(self) -> &'static str {
        match self {
            PasteError::Empty => "empty",
            PasteError::Unreadable => "unreadable",
            PasteError::NoServers => "no-servers",
        }
    }
}

/// `PasteResult`
#[derive(Debug, Clone, PartialEq)]
pub enum PasteResult {
    Ok {
        format: PasteFormat,
        servers: Vec<PastedServer>,
        /// top-level entries that are not servers
        ignored: Vec<String>,
    },
    Failed {
        error: PasteError,
        /// the line of the pasted text a JSON or TOML mistake is on (from 1), when known
        line: Option<usize>,
    },
}

impl PasteResult {
    /// The value as it crosses to a screen
    pub fn to_json(&self) -> JsonValue {
        match self {
            PasteResult::Ok {
                format,
                servers,
                ignored,
            } => object(vec![
                ("ok", JsonValue::Bool(true)),
                ("format", text(format.as_str())),
                (
                    "servers",
                    JsonValue::Array(servers.iter().map(PastedServer::to_json).collect()),
                ),
                ("ignored", string_array(ignored)),
            ]),
            PasteResult::Failed { error, line } => {
                let mut entries = vec![
                    ("ok", JsonValue::Bool(false)),
                    ("error", text(error.as_str())),
                ];
                if let Some(line) = line {
                    entries.push(("line", JsonValue::Number(*line as f64)));
                }
                object(entries)
            }
        }
    }
}

const KNOWN_FIELDS: [&str; 9] = [
    "type",
    "command",
    "args",
    "env",
    "url",
    "serverUrl",
    "headers",
    "http_headers",
    "bearer_token_env_var",
];

/// `REMOTE_TYPES[type]` for an own key; `None` where the table has none
fn remote_transport(kind: &str) -> Option<McpTransport> {
    match kind {
        "http" | "streamable-http" | "streamableHttp" | "streamable_http" => {
            Some(McpTransport::Auto)
        }
        "sse" => Some(McpTransport::Sse),
        _ => None,
    }
}

/// `placeholderVariable(value)`: a value that names a PC variable instead of
/// holding one, `${NAME}` or `${env:NAME}`, alone or inside text. The
/// variable's name, or `None`.
pub fn placeholder_variable(value: &str) -> Option<String> {
    js_regex!(r"\$\{\s*(?:env:)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}")
        .exec(value)
        .and_then(|m| m.get(1).map(str::to_owned))
}

/// `withoutPlaceholders(record)`: `(values, vars)`
fn without_placeholders(record: &JsObject<String>) -> (JsObject<String>, JsObject<String>) {
    let mut values = JsObject::new();
    let mut vars = JsObject::new();
    for (name, value) in record.entries() {
        match placeholder_variable(value).filter(|v| !v.is_empty()) {
            Some(variable) => {
                vars.set(name, variable);
                values.set(name, String::new());
            }
            None => values.set(name, value.clone()),
        }
    }
    (values, vars)
}

/// `scalarText(v)`: a scalar as text; anything else is dropped
fn scalar_text(v: &JsonValue) -> Option<String> {
    match v {
        JsonValue::String(s) => Some(s.clone()),
        JsonValue::Number(n) => Some(number_to_string(*n)),
        JsonValue::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// `textRecord(v)`
fn text_record(v: Option<&JsonValue>) -> JsObject<String> {
    let mut out = JsObject::new();
    if let Some(JsonValue::Object(record)) = v {
        for (key, value) in record.entries() {
            if let Some(t) = scalar_text(value) {
                out.set(key, t);
            }
        }
    }
    out
}

/// `delete record[key]`
fn without_key(record: &JsObject<String>, key: &str) -> JsObject<String> {
    record
        .entries()
        .into_iter()
        .filter(|(k, _)| *k != key)
        .map(|(k, v)| (k.to_owned(), v.clone()))
        .collect()
}

/// `unfence(text)`: the code inside the first fenced block, when the paste
/// came with prose around it
fn unfence(input: &str) -> &str {
    match js_regex!(r"```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)```").exec(input) {
        Some(fenced) => fenced.get(1).unwrap_or(""),
        None => input,
    }
}

fn read_server(
    pasted_name: &str,
    raw: &JsObject<JsonValue>,
    taken: &mut HashSet<String>,
) -> PastedServer {
    let string_of = |key: &str| match raw.get(key) {
        Some(JsonValue::String(s)) => Some(s.as_str()),
        _ => None,
    };
    let command = string_of("command").map_or("", trim).to_owned();
    let url_field = string_of("url").or_else(|| string_of("serverUrl"));
    let url = url_field.map_or("", trim).to_owned();
    let kind_type = string_of("type");
    let kind = if command.is_empty() {
        McpServerKind::Remote
    } else {
        McpServerKind::Local
    };
    let local = !command.is_empty();
    let args: Vec<String> = match raw.get("args") {
        Some(JsonValue::Array(items)) if local => items.iter().filter_map(scalar_text).collect(),
        _ => Vec::new(),
    };

    let name = if is_valid_server_name(pasted_name, MCP_SERVER_NAME_MAX)
        && !taken.contains(&pasted_name.to_lowercase())
    {
        pasted_name.to_owned()
    } else {
        let source = if local {
            ServerNameSource {
                url: None,
                command: Some(command.clone()),
                args: Some(args.clone()),
            }
        } else {
            ServerNameSource {
                url: Some(url.clone()),
                command: None,
                args: None,
            }
        };
        suggest_server_name_from(pasted_name, taken.iter(), &source)
    };
    taken.insert(name.to_lowercase());

    let transport_of_type = kind_type.and_then(remote_transport);
    // a type the app does not know is set aside; the usual way (Streamable HTTP, then
    // SSE; or the program for a command) is tried, and a wrong one shows when checked
    let type_ignored = kind_type
        .filter(|t| {
            if local {
                *t != "stdio"
            } else {
                transport_of_type.is_none()
            }
        })
        .map(str::to_owned);
    let problem = if command.is_empty() && url.is_empty() {
        Some(PastedProblem::NoTarget)
    } else {
        None
    };

    let key_env_var = string_of("bearer_token_env_var")
        .filter(|v| !v.is_empty())
        .map(str::to_owned);
    let header_source = if local {
        JsObject::new()
    } else {
        let mut merged = text_record(raw.get("http_headers"));
        merged.assign(&text_record(raw.get("headers")));
        merged
    };
    let (mut header_values, mut header_vars) = without_placeholders(&header_source);
    // a key written as `Bearer ${KEY}`: the key field asks for it, the header goes
    let authorization = header_vars
        .entries()
        .into_iter()
        .map(|(h, _)| h.to_owned())
        .find(|h| h.to_lowercase() == "authorization");
    let key_var = key_env_var.clone().or_else(|| {
        authorization
            .as_ref()
            .and_then(|a| header_vars.get(a).cloned())
    });
    if let Some(authorization) = &authorization {
        header_values = without_key(&header_values, authorization);
        header_vars = without_key(&header_vars, authorization);
    }
    let (env_values, env_vars) = without_placeholders(&if local {
        text_record(raw.get("env"))
    } else {
        JsObject::new()
    });
    PastedServer {
        pasted_name: pasted_name.to_owned(),
        name: name.clone(),
        name_changed: name != pasted_name,
        kind,
        url: if local { String::new() } else { url },
        transport: if local {
            McpTransport::Auto
        } else {
            transport_of_type.unwrap_or(McpTransport::Auto)
        },
        headers: header_values,
        command,
        args,
        env: env_values,
        key_needed: !local && key_var.is_some(),
        key_env_var: if local { None } else { key_var },
        header_vars,
        env_vars,
        type_ignored,
        ignored: raw
            .entries()
            .into_iter()
            .map(|(k, _)| k)
            .filter(|k| !KNOWN_FIELDS.contains(k))
            .map(str::to_owned)
            .collect(),
        problem,
    }
}

/// `jsonErrorLine(error, text)`: the line (from 1) of a JSON syntax error in
/// `text`, from the parser's message
fn json_error_line(message: &str, input: &str) -> Option<usize> {
    if let Some(line) = js_regex!(r"line (\d+)", "i").exec(message) {
        return line.get(1).and_then(|n| n.parse().ok());
    }
    let position = js_regex!(r"position (\d+)", "i").exec(message)?;
    let position: f64 = position.get(1)?.parse().ok()?;
    Some(
        slice_utf16(input, 0.0, Some(position))
            .matches('\n')
            .count()
            + 1,
    )
}

/// `linesBefore(text, body)`: where `body` starts in the pasted text, in
/// lines, so a line number counts from the paste
fn lines_before(input: &str, body: &str) -> usize {
    match input.find(body) {
        Some(at) if at > 0 => input[..at].matches('\n').count(),
        _ => 0,
    }
}

fn read_servers(
    entries: &JsObject<JsonValue>,
    taken: &[String],
) -> (Vec<PastedServer>, Vec<String>) {
    let mut used: HashSet<String> = taken.iter().map(|t| t.to_lowercase()).collect();
    let mut servers = Vec::new();
    let mut ignored = Vec::new();
    for (name, raw) in entries.entries() {
        match raw {
            JsonValue::Object(record) => servers.push(read_server(name, record, &mut used)),
            _ => ignored.push(name.to_owned()),
        }
    }
    (servers, ignored)
}

/// `parseMcpPaste(text, taken)`: the servers in a pasted settings text.
/// `taken` holds the names already registered; each pasted server gets a free
/// name, also among the others in the same paste.
pub fn parse_mcp_paste(input: &str, taken: &[String]) -> PasteResult {
    let body = trim(unfence(input));
    if body.is_empty() {
        return PasteResult::Failed {
            error: PasteError::Empty,
            line: None,
        };
    }
    let unreadable = |line: Option<usize>| PasteResult::Failed {
        error: PasteError::Unreadable,
        line,
    };

    let format;
    let entries: JsObject<JsonValue>;
    let mut ignored: Vec<String>;
    if body.starts_with('{') {
        let raw = match json_parse(body) {
            Ok(raw) => raw,
            Err(error) => {
                return unreadable(
                    json_error_line(error.message(), body)
                        .map(|line| line + lines_before(input, body)),
                );
            }
        };
        let JsonValue::Object(raw) = raw else {
            return unreadable(None);
        };
        if let Some(JsonValue::Object(servers)) = raw.get("mcpServers") {
            format = PasteFormat::Json;
            entries = servers.clone();
            ignored = raw
                .entries()
                .into_iter()
                .map(|(k, _)| k)
                .filter(|k| *k != "mcpServers")
                .map(str::to_owned)
                .collect();
        } else {
            format = PasteFormat::JsonBare;
            entries = raw;
            ignored = Vec::new();
        }
    } else {
        let raw = match parse_toml(body) {
            Ok(raw) => raw,
            // a line is named only for text that looks like the settings it should be
            Err(error) => {
                return if !error.stack_overflow && js_regex!(r"\[\s*mcp_servers\.").test(body) {
                    unreadable(Some(error.line + lines_before(input, body)))
                } else {
                    unreadable(None)
                };
            }
        };
        let Some(JsonValue::Object(servers)) = raw.get("mcp_servers") else {
            return unreadable(None);
        };
        format = PasteFormat::Toml;
        entries = servers.clone();
        ignored = raw
            .entries()
            .into_iter()
            .map(|(k, _)| k)
            .filter(|k| *k != "mcp_servers")
            .map(str::to_owned)
            .collect();
    }

    let (servers, read_ignored) = read_servers(&entries, taken);
    if servers.is_empty() {
        return PasteResult::Failed {
            error: PasteError::NoServers,
            line: None,
        };
    }
    ignored.extend(read_ignored);
    PasteResult::Ok {
        format,
        servers,
        ignored,
    }
}
