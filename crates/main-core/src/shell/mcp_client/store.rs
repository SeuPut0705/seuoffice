//! `apps/shell/src/main/mcp-client/store.ts`: `mcp-servers.json` in the app
//! data folder (user MCP spec 10, 12.1): the registered servers, their tool
//! permissions and approval fingerprints. In memory every secret is plain; on
//! disk it is sealed or, where this PC cannot seal, left empty.
//!
//! Plain calls: the TypeScript's promise queue (`serial`) runs one call after
//! another, which `&mut self` methods do. A `change` closure of `update` that
//! throws has no counterpart (a closure here does not fail).
//!
//! Data shapes. The file as read stays tolerant of anything: `serverOf` reads
//! a stored value (`JsonValue`) into [`McpServerConfig`], the one fixed shape
//! the TypeScript builds itself (`newMcpServerConfig`), as typed structs whose
//! `to_json` writes the keys in the order the TypeScript builds them. A tool
//! definition keeps its schema and annotations as `JsObject<JsonValue>`. The
//! views a screen sees (`McpServersView`, `McpServerRecordView`) are built as
//! `JsonValue`, keys in the interface's order. The file's `version` is the
//! constant 1 and is not a field.
//!
//! Assumed APIs of the `client_pure` slice: `shell::mcp_servers_api::{McpPermission,
//! McpServerKind, McpTransport}` (each with `as_str`) and `permission_of(Option<&JsonValue>)
//! -> McpPermission`; `shell::mcp_client::fingerprint::launch_review_needed(&JsonValue)
//! -> bool` (given the server's `to_json()`).

use std::collections::HashSet;
use std::rc::Rc;

use jscompat::node_path::host;
use jscompat::{JsMap, JsObject, JsonValue, json_parse, json_stringify_pretty, random_uuid};

use super::fingerprint::launch_review_needed;
use super::secrets::{
    McpSecretCodec, McpSecretRef, open_server_secrets, seal_server_secrets, secret_view,
};
use crate::node_fs::{NodeError, copy_file, namespaced};
use crate::packages::ai_provider::jsval::{as_record, as_str, object, text};
use crate::shell::atomic_write::atomic_write_file;
use crate::shell::mcp_servers_api::{McpPermission, McpServerKind, McpTransport, permission_of};

pub const MCP_SERVERS_FILE_NAME: &str = "mcp-servers.json";
pub const MCP_SERVERS_FILE_VERSION: f64 = 1.0;

/// `mcpServersFilePath(dataDir)`
pub fn mcp_servers_file_path(data_dir: &str) -> String {
    host::join(&[data_dir, MCP_SERVERS_FILE_NAME])
}

/// `McpOAuthConfig`
#[derive(Debug, Clone, PartialEq)]
pub struct McpOAuthConfig {
    pub client_id: String,
    /// secret
    pub client_secret: String,
    /// secret: the token set as the OAuth layer keeps it (JSON text)
    pub tokens: String,
}

impl McpOAuthConfig {
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            ("clientId", text(self.client_id.as_str())),
            ("clientSecret", text(self.client_secret.as_str())),
            ("tokens", text(self.tokens.as_str())),
        ])
    }
}

/// `McpToolDefinition`
#[derive(Debug, Clone, PartialEq)]
pub struct McpToolDefinition {
    pub description: String,
    pub input_schema: JsObject<JsonValue>,
    pub annotations: Option<JsObject<JsonValue>>,
}

impl McpToolDefinition {
    pub fn to_json(&self) -> JsonValue {
        let mut entries = vec![
            ("description", text(self.description.as_str())),
            ("inputSchema", JsonValue::Object(self.input_schema.clone())),
        ];
        if let Some(annotations) = &self.annotations {
            entries.push(("annotations", JsonValue::Object(annotations.clone())));
        }
        object(entries)
    }
}

/// `McpToolEntry`
#[derive(Debug, Clone, PartialEq)]
pub struct McpToolEntry {
    pub permission: McpPermission,
    /// fingerprint of the approved definition (`sha256:...`)
    pub approved: String,
    pub definition: McpToolDefinition,
    /// a changed definition awaiting approval
    pub pending: Option<McpToolDefinition>,
}

impl McpToolEntry {
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            ("permission", text(self.permission.as_str())),
            ("approved", text(self.approved.as_str())),
            ("definition", self.definition.to_json()),
            (
                "pending",
                self.pending
                    .as_ref()
                    .map_or(JsonValue::Null, McpToolDefinition::to_json),
            ),
        ])
    }
}

/// `McpInstructions`: the approved server instructions
#[derive(Debug, Clone, PartialEq)]
pub struct McpInstructions {
    pub approved: String,
    pub text: String,
}

impl McpInstructions {
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            ("approved", text(self.approved.as_str())),
            ("text", text(self.text.as_str())),
        ])
    }
}

/// `McpServerConfig`: one registered server. Fields of the other kind stay at
/// their empty values in memory and are not written to the file.
#[derive(Debug, Clone, PartialEq)]
pub struct McpServerConfig {
    /// made by the app; never shown as a name
    pub id: String,
    pub name: String,
    pub kind: McpServerKind,
    pub enabled: bool,
    pub keep_results_inside: bool,
    // remote
    pub url: String,
    pub transport: McpTransport,
    /// values are secrets
    pub headers: JsObject<String>,
    pub oauth: Option<McpOAuthConfig>,
    // local
    pub command: String,
    pub args: Vec<String>,
    /// values are secrets
    pub env: JsObject<String>,
    /// fingerprint of the command, arguments and env names as approved
    pub approved_launch: Option<String>,
    /// fingerprint of the resolved plan the person allowed
    pub approved_plan: Option<String>,
    // both
    pub instructions: Option<McpInstructions>,
    pub pending_instructions: Option<String>,
    pub tools: JsObject<McpToolEntry>,
    /// tools added since the person last opened this server's tool list
    pub new_tools: Vec<String>,
}

fn string_map_json(record: &JsObject<String>) -> JsonValue {
    let mut out = JsObject::new();
    for (key, value) in record.entries() {
        out.set(key, text(value.as_str()));
    }
    JsonValue::Object(out)
}

fn string_list_json(items: &[String]) -> JsonValue {
    JsonValue::Array(items.iter().map(|s| text(s.as_str())).collect())
}

fn optional_text(value: &Option<String>) -> JsonValue {
    value
        .as_deref()
        .map_or(JsonValue::Null, |s| JsonValue::String(s.to_owned()))
}

fn tools_json(tools: &JsObject<McpToolEntry>) -> JsonValue {
    let mut out = JsObject::new();
    for (name, entry) in tools.entries() {
        out.set(name, entry.to_json());
    }
    JsonValue::Object(out)
}

impl McpServerConfig {
    /// The server in memory, every field, keys as `newMcpServerConfig` builds
    /// them; the form `fingerprint` reads.
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            ("id", text(self.id.as_str())),
            ("name", text(self.name.as_str())),
            ("kind", text(self.kind.as_str())),
            ("enabled", JsonValue::Bool(self.enabled)),
            (
                "keepResultsInside",
                JsonValue::Bool(self.keep_results_inside),
            ),
            ("url", text(self.url.as_str())),
            ("transport", text(self.transport.as_str())),
            ("headers", string_map_json(&self.headers)),
            (
                "oauth",
                self.oauth
                    .as_ref()
                    .map_or(JsonValue::Null, McpOAuthConfig::to_json),
            ),
            ("command", text(self.command.as_str())),
            ("args", string_list_json(&self.args)),
            ("env", string_map_json(&self.env)),
            ("approvedLaunch", optional_text(&self.approved_launch)),
            ("approvedPlan", optional_text(&self.approved_plan)),
            (
                "instructions",
                self.instructions
                    .as_ref()
                    .map_or(JsonValue::Null, McpInstructions::to_json),
            ),
            (
                "pendingInstructions",
                optional_text(&self.pending_instructions),
            ),
            ("tools", tools_json(&self.tools)),
            ("newTools", string_list_json(&self.new_tools)),
        ])
    }
}

/// `runtimes[name]`: a runtime the person allowed the app to download
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeAllowance {
    pub allowed: bool,
}

impl RuntimeAllowance {
    fn to_json(&self) -> JsonValue {
        object(vec![("allowed", JsonValue::Bool(self.allowed))])
    }
}

/// `McpServersFile` (its `version` is the constant 1)
#[derive(Debug, Clone, PartialEq)]
pub struct McpServersFile {
    /// runtimes the person allowed the app to download; kept across app updates
    pub runtimes: JsObject<RuntimeAllowance>,
    pub servers: Vec<McpServerConfig>,
}

impl McpServersFile {
    /// The file in memory as a value: `{ version, runtimes, servers }`, every
    /// secret plain (main process only)
    pub fn to_json(&self) -> JsonValue {
        let mut runtimes = JsObject::new();
        for (name, r) in self.runtimes.entries() {
            runtimes.set(name, r.to_json());
        }
        object(vec![
            ("version", JsonValue::Number(MCP_SERVERS_FILE_VERSION)),
            ("runtimes", JsonValue::Object(runtimes)),
            (
                "servers",
                JsonValue::Array(self.servers.iter().map(McpServerConfig::to_json).collect()),
            ),
        ])
    }
}

/// `emptyMcpServersFile()`
pub fn empty_mcp_servers_file() -> McpServersFile {
    McpServersFile {
        runtimes: JsObject::new(),
        servers: Vec::new(),
    }
}

/// `NewMcpServerInput`
#[derive(Debug, Clone, Default)]
pub struct NewMcpServerInput {
    pub name: String,
    pub kind: Option<McpServerKind>,
    pub url: Option<String>,
    pub transport: Option<McpTransport>,
    pub headers: Option<JsObject<String>>,
    pub oauth: Option<McpOAuthConfig>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<JsObject<String>>,
}

/// `newMcpServerConfig(input)`: a server as first registered (4.7): on,
/// keeping results inside, no tools yet, and a local launch not approved until
/// the person presses "allow". `input.kind` is required in the TypeScript;
/// `NewMcpServerInput::kind` is an `Option` only for `Default`.
pub fn new_mcp_server_config(input: &NewMcpServerInput) -> McpServerConfig {
    let kind = input.kind.unwrap_or(McpServerKind::Remote);
    let local = matches!(kind, McpServerKind::Local);
    McpServerConfig {
        id: random_uuid(),
        name: input.name.clone(),
        kind,
        enabled: true,
        keep_results_inside: true,
        url: if local {
            String::new()
        } else {
            input.url.clone().unwrap_or_default()
        },
        transport: if local {
            McpTransport::Auto
        } else {
            input.transport.unwrap_or(McpTransport::Auto)
        },
        headers: if local {
            JsObject::new()
        } else {
            input.headers.clone().unwrap_or_default()
        },
        oauth: if local { None } else { input.oauth.clone() },
        command: if local {
            input.command.clone().unwrap_or_default()
        } else {
            String::new()
        },
        args: if local {
            input.args.clone().unwrap_or_default()
        } else {
            Vec::new()
        },
        env: if local {
            input.env.clone().unwrap_or_default()
        } else {
            JsObject::new()
        },
        approved_launch: None,
        approved_plan: None,
        instructions: None,
        pending_instructions: None,
        tools: JsObject::new(),
        new_tools: Vec::new(),
    }
}

// ---- reading -------------------------------------------------------------

/// `str(v)`
fn str_of(v: Option<&JsonValue>) -> String {
    as_str(v).unwrap_or_default().to_owned()
}

/// `strOrNull(v)`
fn str_or_null(v: Option<&JsonValue>) -> Option<String> {
    as_str(v).map(str::to_owned)
}

/// `strings(v)`
fn strings(v: Option<&JsonValue>) -> Vec<String> {
    match v {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|x| match x {
                JsonValue::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `stringRecord(v)`
fn string_record(v: Option<&JsonValue>) -> JsObject<String> {
    let mut out = JsObject::new();
    if let Some(record) = v.and_then(as_record) {
        for (key, value) in record.entries() {
            if let JsonValue::String(s) = value {
                out.set(key, s.clone());
            }
        }
    }
    out
}

/// `definitionOf(v)`
fn definition_of(v: Option<&JsonValue>) -> Option<McpToolDefinition> {
    let record = as_record(v?)?;
    Some(McpToolDefinition {
        description: str_of(record.get("description")),
        input_schema: match record.get("inputSchema") {
            Some(JsonValue::Object(schema)) => schema.clone(),
            _ => JsObject::new(),
        },
        annotations: match record.get("annotations") {
            Some(JsonValue::Object(annotations)) => Some(annotations.clone()),
            _ => None,
        },
    })
}

/// `toolEntryOf(v)`
fn tool_entry_of(v: &JsonValue) -> Option<McpToolEntry> {
    let record = as_record(v)?;
    Some(McpToolEntry {
        permission: permission_of(record.get("permission")),
        // a missing fingerprint matches no listing, so the tool comes back for review
        approved: str_of(record.get("approved")),
        definition: definition_of(record.get("definition")).unwrap_or(McpToolDefinition {
            description: String::new(),
            input_schema: JsObject::new(),
            annotations: None,
        }),
        pending: definition_of(record.get("pending")),
    })
}

/// `instructionsOf(v)`
fn instructions_of(v: Option<&JsonValue>) -> Option<McpInstructions> {
    let record = as_record(v?)?;
    match record.get("text") {
        Some(JsonValue::String(text)) => Some(McpInstructions {
            approved: str_of(record.get("approved")),
            text: text.clone(),
        }),
        _ => None,
    }
}

/// `serverOf(v)`
fn server_of(v: &JsonValue) -> Option<McpServerConfig> {
    let record = as_record(v)?;
    let kind = match record.get("kind") {
        Some(JsonValue::String(k)) if k == "local" => McpServerKind::Local,
        Some(JsonValue::String(k)) if k == "remote" => McpServerKind::Remote,
        _ => {
            if matches!(record.get("command"), Some(JsonValue::String(_))) {
                McpServerKind::Local
            } else {
                McpServerKind::Remote
            }
        }
    };
    let local = matches!(kind, McpServerKind::Local);
    let server = new_mcp_server_config(&NewMcpServerInput {
        name: str_of(record.get("name")),
        kind: Some(kind),
        url: Some(str_of(record.get("url"))),
        transport: Some(if as_str(record.get("transport")) == Some("sse") {
            McpTransport::Sse
        } else {
            McpTransport::Auto
        }),
        headers: Some(string_record(record.get("headers"))),
        oauth: record
            .get("oauth")
            .and_then(as_record)
            .map(|oauth| McpOAuthConfig {
                client_id: str_of(oauth.get("clientId")),
                client_secret: str_of(oauth.get("clientSecret")),
                tokens: str_of(oauth.get("tokens")),
            }),
        command: Some(str_of(record.get("command"))),
        args: Some(strings(record.get("args"))),
        env: Some(string_record(record.get("env"))),
    });
    let mut tools: JsObject<McpToolEntry> = JsObject::new();
    if let Some(JsonValue::Object(stored)) = record.get("tools") {
        for (name, t) in stored.entries() {
            if let Some(entry) = tool_entry_of(t) {
                tools.set(name, entry);
            }
        }
    }
    let mut new_tools: Vec<String> = Vec::new();
    for name in strings(record.get("newTools")) {
        if tools.get(&name).is_some() && !new_tools.contains(&name) {
            new_tools.push(name);
        }
    }
    Some(McpServerConfig {
        id: match record.get("id") {
            Some(JsonValue::String(id)) if !id.is_empty() => id.clone(),
            _ => server.id.clone(),
        },
        enabled: !matches!(record.get("enabled"), Some(JsonValue::Bool(false))),
        keep_results_inside: !matches!(
            record.get("keepResultsInside"),
            Some(JsonValue::Bool(false))
        ),
        approved_launch: if local {
            str_or_null(record.get("approvedLaunch"))
        } else {
            None
        },
        approved_plan: if local {
            str_or_null(record.get("approvedPlan"))
        } else {
            None
        },
        instructions: instructions_of(record.get("instructions")),
        pending_instructions: str_or_null(record.get("pendingInstructions")),
        tools,
        new_tools,
        ..server
    })
}

/// `normalizeMcpServersFile(raw)`: the file as read, tolerant of missing
/// fields and values it does not know
pub fn normalize_mcp_servers_file(raw: &JsonValue) -> McpServersFile {
    let Some(raw) = as_record(raw) else {
        return empty_mcp_servers_file();
    };
    let mut runtimes = JsObject::new();
    if let Some(JsonValue::Object(stored)) = raw.get("runtimes") {
        for (name, r) in stored.entries() {
            let allowed = matches!(
                as_record(r).and_then(|r| r.get("allowed")),
                Some(JsonValue::Bool(true))
            );
            runtimes.set(name, RuntimeAllowance { allowed });
        }
    }
    let servers = match raw.get("servers") {
        Some(JsonValue::Array(items)) => items.iter().filter_map(server_of).collect(),
        _ => Vec::new(),
    };
    McpServersFile { runtimes, servers }
}

/// `serializeMcpServersFile(file)`: the file text, each server carrying only
/// the fields of its kind
pub fn serialize_mcp_servers_file(file: &McpServersFile) -> String {
    let servers: Vec<JsonValue> = file
        .servers
        .iter()
        .map(|s| {
            let mut entries = vec![
                ("id", text(s.id.as_str())),
                ("name", text(s.name.as_str())),
                ("kind", text(s.kind.as_str())),
                ("enabled", JsonValue::Bool(s.enabled)),
                ("keepResultsInside", JsonValue::Bool(s.keep_results_inside)),
            ];
            if matches!(s.kind, McpServerKind::Remote) {
                entries.push(("url", text(s.url.as_str())));
                entries.push(("transport", text(s.transport.as_str())));
                entries.push(("headers", string_map_json(&s.headers)));
                entries.push((
                    "oauth",
                    s.oauth
                        .as_ref()
                        .map_or(JsonValue::Null, McpOAuthConfig::to_json),
                ));
            } else {
                entries.push(("command", text(s.command.as_str())));
                entries.push(("args", string_list_json(&s.args)));
                entries.push(("env", string_map_json(&s.env)));
                entries.push(("approvedLaunch", optional_text(&s.approved_launch)));
                entries.push(("approvedPlan", optional_text(&s.approved_plan)));
            }
            entries.push((
                "instructions",
                s.instructions
                    .as_ref()
                    .map_or(JsonValue::Null, McpInstructions::to_json),
            ));
            entries.push((
                "pendingInstructions",
                optional_text(&s.pending_instructions),
            ));
            entries.push(("tools", tools_json(&s.tools)));
            entries.push(("newTools", string_list_json(&s.new_tools)));
            object(entries)
        })
        .collect();
    let mut runtimes = JsObject::new();
    for (name, r) in file.runtimes.entries() {
        runtimes.set(name, r.to_json());
    }
    let document = object(vec![
        ("version", JsonValue::Number(MCP_SERVERS_FILE_VERSION)),
        ("runtimes", JsonValue::Object(runtimes)),
        ("servers", JsonValue::Array(servers)),
    ]);
    format!("{}\n", json_stringify_pretty(&document, 2))
}

// ---- the store -----------------------------------------------------------

/// `McpStoreLoad['state']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpStoreLoadState {
    Missing,
    Ok,
    /// the file could not be read as JSON; the next save keeps it beside as `.damaged`
    Damaged,
}

impl McpStoreLoadState {
    pub fn as_str(self) -> &'static str {
        match self {
            McpStoreLoadState::Missing => "missing",
            McpStoreLoadState::Ok => "ok",
            McpStoreLoadState::Damaged => "damaged",
        }
    }
}

/// one `McpStoreLoad['unreadable']` item: a secret sealed by another account or
/// PC, now empty and to be entered again
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadableSecret {
    pub server_id: String,
    pub secret: McpSecretRef,
}

/// `McpStoreLoad`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpStoreLoad {
    pub state: McpStoreLoadState,
    pub unreadable: Vec<UnreadableSecret>,
}

/// `McpServersStore`, made by [`create_mcp_servers_store`]
pub struct McpServersStore<'h> {
    file_path: String,
    codec: Rc<dyn McpSecretCodec + 'h>,
    state: McpServersFile,
    /// per server id: secrets written empty because this PC could not seal them
    memory_only: JsMap<HashSet<McpSecretRef>>,
    damaged: bool,
}

/// `createMcpServersStore(filePath, codec)`
pub fn create_mcp_servers_store<'h>(
    file_path: &str,
    codec: Rc<dyn McpSecretCodec + 'h>,
) -> McpServersStore<'h> {
    McpServersStore {
        file_path: file_path.to_owned(),
        codec,
        state: empty_mcp_servers_file(),
        memory_only: JsMap::new(),
        damaged: false,
    }
}

impl McpServersStore<'_> {
    fn write(&mut self, next: McpServersFile) -> Result<(), NodeError> {
        let mut sealed_servers: Vec<McpServerConfig> = Vec::new();
        let mut next_memory_only: JsMap<HashSet<McpSecretRef>> = JsMap::new();
        for server in &next.servers {
            let (sealed, memory_only) = seal_server_secrets(server, &*self.codec);
            sealed_servers.push(sealed);
            if !memory_only.is_empty() {
                next_memory_only.set(server.id.clone(), memory_only.into_iter().collect());
            }
        }
        if self.damaged {
            let _ = copy_file(
                &self.file_path,
                &format!("{}.damaged", self.file_path),
                false,
            );
            self.damaged = false;
        }
        let text = serialize_mcp_servers_file(&McpServersFile {
            runtimes: next.runtimes.clone(),
            servers: sealed_servers,
        });
        atomic_write_file(&self.file_path, text.as_bytes())?;
        self.state = next;
        self.memory_only = next_memory_only;
        Ok(())
    }

    fn server_view(&self, server: &McpServerConfig) -> JsonValue {
        let empty = HashSet::new();
        let held = self.memory_only.get(&server.id).unwrap_or(&empty);
        let views = |record: &JsObject<String>, prefix: &str| {
            let mut out = JsObject::new();
            for (k, v) in record.entries() {
                out.set(
                    k,
                    secret_view(v, held.contains(&format!("{prefix}:{k}"))).to_json(),
                );
            }
            JsonValue::Object(out)
        };
        object(vec![
            ("id", text(server.id.as_str())),
            ("name", text(server.name.as_str())),
            ("kind", text(server.kind.as_str())),
            ("enabled", JsonValue::Bool(server.enabled)),
            (
                "keepResultsInside",
                JsonValue::Bool(server.keep_results_inside),
            ),
            ("url", text(server.url.as_str())),
            ("transport", text(server.transport.as_str())),
            ("headers", views(&server.headers, "headers")),
            (
                "oauth",
                server.oauth.as_ref().map_or(JsonValue::Null, |oauth| {
                    object(vec![
                        ("clientId", text(oauth.client_id.as_str())),
                        (
                            "clientSecret",
                            secret_view(&oauth.client_secret, held.contains("oauth:clientSecret"))
                                .to_json(),
                        ),
                        ("signedIn", JsonValue::Bool(!oauth.tokens.is_empty())),
                    ])
                }),
            ),
            ("command", text(server.command.as_str())),
            ("args", string_list_json(&server.args)),
            ("env", views(&server.env, "env")),
            (
                "launchReviewNeeded",
                JsonValue::Bool(launch_review_needed(&server.to_json())),
            ),
            (
                "instructions",
                server
                    .instructions
                    .as_ref()
                    .map_or(JsonValue::Null, McpInstructions::to_json),
            ),
            (
                "pendingInstructions",
                optional_text(&server.pending_instructions),
            ),
            ("tools", tools_json(&server.tools)),
            ("newTools", string_list_json(&server.new_tools)),
            ("secretsMemoryOnly", JsonValue::Bool(!held.is_empty())),
        ])
    }

    /// `load()`
    pub fn load(&mut self) -> McpStoreLoad {
        let Ok(bytes) = std::fs::read(namespaced(&self.file_path)) else {
            self.state = empty_mcp_servers_file();
            self.memory_only = JsMap::new();
            return McpStoreLoad {
                state: McpStoreLoadState::Missing,
                unreadable: Vec::new(),
            };
        };
        let content = String::from_utf8_lossy(&bytes);
        let Ok(raw) = json_parse(&content) else {
            self.state = empty_mcp_servers_file();
            self.memory_only = JsMap::new();
            self.damaged = true;
            return McpStoreLoad {
                state: McpStoreLoadState::Damaged,
                unreadable: Vec::new(),
            };
        };
        let file = normalize_mcp_servers_file(&raw);
        let mut unreadable = Vec::new();
        let mut servers = Vec::new();
        for s in &file.servers {
            let (opened, secrets) = open_server_secrets(s, &*self.codec);
            for secret in secrets {
                unreadable.push(UnreadableSecret {
                    server_id: s.id.clone(),
                    secret,
                });
            }
            servers.push(opened);
        }
        self.state = McpServersFile {
            runtimes: file.runtimes,
            servers,
        };
        self.memory_only = JsMap::new();
        self.damaged = false;
        McpStoreLoad {
            state: McpStoreLoadState::Ok,
            unreadable,
        }
    }

    /// `get()`: a copy with plain secrets: main process only, never sent to a screen
    pub fn get(&self) -> McpServersFile {
        self.state.clone()
    }

    /// `server(id)`
    pub fn server(&self, id: &str) -> Option<McpServerConfig> {
        self.state.servers.iter().find(|s| s.id == id).cloned()
    }

    /// `update(change)`: change and save. `change` edits the draft in place
    /// and answers `None` (`void`), or answers the file to save instead.
    pub fn update(
        &mut self,
        change: &mut dyn FnMut(&mut McpServersFile) -> Option<McpServersFile>,
    ) -> Result<McpServersFile, NodeError> {
        let mut draft = self.state.clone();
        let next = change(&mut draft).unwrap_or(draft);
        self.write(next)?;
        Ok(self.state.clone())
    }

    /// `removeServer(id)`: drop a server and every secret it held (4.9);
    /// `false` when there was none
    pub fn remove_server(&mut self, id: &str) -> Result<bool, NodeError> {
        if !self.state.servers.iter().any(|s| s.id == id) {
            return Ok(false);
        }
        let mut next = self.state.clone();
        next.servers.retain(|s| s.id != id);
        self.write(next)?;
        Ok(true)
    }

    /// `sealing()`: whether this PC seals secrets now
    pub fn sealing(&self) -> bool {
        self.codec.can_seal()
    }

    /// `view()`: what a screen may see (`McpServersView`)
    pub fn view(&self) -> JsonValue {
        let mut runtimes = JsObject::new();
        for (name, r) in self.state.runtimes.entries() {
            runtimes.set(name, r.to_json());
        }
        object(vec![
            ("sealing", JsonValue::Bool(self.codec.can_seal())),
            ("runtimes", JsonValue::Object(runtimes)),
            (
                "servers",
                JsonValue::Array(
                    self.state
                        .servers
                        .iter()
                        .map(|s| self.server_view(s))
                        .collect(),
                ),
            ),
        ])
    }
}
