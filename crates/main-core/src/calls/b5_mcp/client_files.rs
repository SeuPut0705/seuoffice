//! Group `b5-mcp`, slice `client_files`: see tools/main-diff/groups/b5-mcp/client-files.ts.
//!
//! The fakes the spec describes (a secret codec, a `safeStorage`, a fetch, a
//! runtime kit) are mirrored here; each call of a fake is one `logs` line as
//! the TypeScript writes it. A store scenario is run step by step over a real
//! `mcp-servers.json` in the case's folder.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{
    JsObject, JsonValue, decode_uri_component, encode_uri_component, js_regex,
    json_value_from_serde, json_value_to_serde,
};
use serde_json::Value;

use super::super::{Answer, CallError, Context, arg, str_arg};
use crate::node_fs::{NodeError, node_error};
use crate::packages::ai_provider::jsval::{as_record, as_str, object, prop, text};
use crate::packages::ai_provider::settings_secrets::{CodecThrow, SEALED_PREFIX};
use crate::shell::ai_secrets::SafeStorageLike;
use crate::shell::mcp_client::local_launch::{
    LaunchServer, LaunchSource, MCP_LOCAL_SYSTEM_ENV, MCP_LOCAL_WINDOWS_ENV, McpRuntimeId,
    McpRuntimeKit, PlanOptions, ResolveOptions, ResolvedLaunch, RuntimeDownloadItem,
    RuntimeMissing, RuntimeMissingDetail, RuntimeResolution, planned_launch, prepare_local_launch,
};
use crate::shell::mcp_client::paste::{parse_mcp_paste, placeholder_variable};
use crate::shell::mcp_client::runtime_archive::{
    DownloadError, RuntimeFetch, RuntimeResponse, download_verified_archive,
    extract_runtime_archive,
};
use crate::shell::mcp_client::runtime_pins::{
    ArchiveFormat, MCP_RUNTIME_PLATFORM_KEYS, McpRuntimePins, PinnedArchive, PlatformTable,
    mcp_runtime_pins, mcp_runtime_platform_key,
};
use crate::shell::mcp_client::secrets::{
    McpSecretCodec, SafeStorageMcpCodec, map_server_secrets, open_server_secrets,
    seal_server_secrets, secret_view,
};
use crate::shell::mcp_client::store::{
    MCP_SERVERS_FILE_NAME, MCP_SERVERS_FILE_VERSION, McpOAuthConfig, McpServerConfig,
    McpServersStore, NewMcpServerInput, RuntimeAllowance, create_mcp_servers_store,
    empty_mcp_servers_file, mcp_servers_file_path, new_mcp_server_config,
    normalize_mcp_servers_file, serialize_mcp_servers_file,
};
use crate::shell::mcp_client::toml::parse_toml;
use crate::shell::mcp_servers_api::{McpServerKind, McpTransport};

fn out(value: JsonValue) -> Answer {
    Ok(Some(json_value_to_serde(&value)))
}

fn json_arg(args: &[Value], i: usize) -> JsonValue {
    arg(args, i).map_or(JsonValue::Null, json_value_from_serde)
}

fn strings_of(v: Option<&JsonValue>) -> Vec<String> {
    match v {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|x| as_str(Some(x)).map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

fn string_map(v: Option<&JsonValue>) -> JsObject<String> {
    let mut out = JsObject::new();
    if let Some(record) = v.and_then(as_record) {
        for (key, value) in record.entries() {
            if let Some(s) = as_str(Some(value)) {
                out.set(key, s.to_owned());
            }
        }
    }
    out
}

fn str_list(items: &[String]) -> JsonValue {
    JsonValue::Array(items.iter().map(|s| text(s.as_str())).collect())
}

/// `normalize(value)` of the spec: random ids read as `<uuid>`, a temp file
/// name as `.<hex>.tmp`
fn normalized(value: JsonValue) -> JsonValue {
    let printed = serde_json::to_string(&json_value_to_serde(&value)).unwrap_or_default();
    let printed = js_regex!(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        "g"
    )
    .replace_all(&printed, |_| "<uuid>".to_owned());
    let printed =
        js_regex!(r"\.[0-9a-f]{8,}\.tmp", "g").replace_all(&printed, |_| ".<hex>.tmp".to_owned());
    serde_json::from_str::<Value>(&printed)
        .map(|v| json_value_from_serde(&v))
        .unwrap_or(JsonValue::Null)
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2)
        .filter_map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

// ---- the fake secret codec ----

#[derive(Clone, Copy, PartialEq)]
enum OpenMode {
    Decode,
    Null,
    Throw,
}

struct FakeCodec {
    can_seal: bool,
    seal_throws: bool,
    open: OpenMode,
}

impl FakeCodec {
    fn of(spec: &JsonValue) -> FakeCodec {
        FakeCodec {
            can_seal: matches!(prop(spec, "canSeal"), Some(JsonValue::Bool(true))),
            seal_throws: matches!(prop(spec, "sealThrows"), Some(JsonValue::Bool(true))),
            open: match as_str(prop(spec, "open")) {
                Some("null") => OpenMode::Null,
                Some("throw") => OpenMode::Throw,
                _ => OpenMode::Decode,
            },
        }
    }
}

impl McpSecretCodec for FakeCodec {
    fn can_seal(&self) -> bool {
        self.can_seal
    }

    fn seal(&self, plain: &str) -> Result<String, CodecThrow> {
        if self.seal_throws || plain.contains("!throw") {
            return Err(CodecThrow("seal failed".to_owned()));
        }
        Ok(format!("{SEALED_PREFIX}{}", encode_uri_component(plain)))
    }

    fn open(&self, sealed: &str) -> Result<Option<String>, CodecThrow> {
        if self.open == OpenMode::Throw {
            return Err(CodecThrow("open failed".to_owned()));
        }
        if self.open == OpenMode::Null || sealed.contains("other-pc") {
            return Ok(None);
        }
        decode_uri_component(&sealed[SEALED_PREFIX.len()..])
            .map(Some)
            .map_err(|e| CodecThrow(e.to_string()))
    }
}

/// a fake `safeStorage` the spec describes: `{ available, backend?,
/// encryptThrows?, decryptThrows? }`; it encrypts `x` as the bytes of `enc:x`
struct FakeStorage {
    available: bool,
    backend: Option<String>,
    encrypt_throws: bool,
    decrypt_throws: bool,
}

impl FakeStorage {
    fn from_spec(spec: &JsonValue) -> FakeStorage {
        let flag = |key: &str| matches!(prop(spec, key), Some(JsonValue::Bool(true)));
        FakeStorage {
            available: flag("available"),
            backend: as_str(prop(spec, "backend")).map(str::to_owned),
            encrypt_throws: flag("encryptThrows"),
            decrypt_throws: flag("decryptThrows"),
        }
    }
}

impl SafeStorageLike for FakeStorage {
    fn is_encryption_available(&self) -> bool {
        self.available
    }

    fn encrypt_string(&self, plain: &str) -> Result<Vec<u8>, CodecThrow> {
        if self.encrypt_throws {
            return Err(CodecThrow("encrypt failed".to_owned()));
        }
        Ok(format!("enc:{plain}").into_bytes())
    }

    fn decrypt_string(&self, sealed: &[u8]) -> Result<String, CodecThrow> {
        let text = String::from_utf8_lossy(sealed).into_owned();
        match text.strip_prefix("enc:") {
            Some(plain) if !self.decrypt_throws => Ok(plain.to_owned()),
            _ => Err(CodecThrow("decrypt failed".to_owned())),
        }
    }

    fn get_selected_storage_backend(&self) -> Option<String> {
        self.backend.clone()
    }
}

/// `normalizeMcpServersFile({ servers: [stored] }).servers[0]`
fn normalized_server(stored: &JsonValue) -> Result<McpServerConfig, CallError> {
    let file = normalize_mcp_servers_file(&object(vec![(
        "servers",
        JsonValue::Array(vec![stored.clone()]),
    )]));
    file.servers
        .into_iter()
        .next()
        .ok_or_else(|| CallError::plain("the case's server is not a server"))
}

// ---- the store scenario ----

fn kind_of(v: Option<&JsonValue>) -> McpServerKind {
    if as_str(v) == Some("local") {
        McpServerKind::Local
    } else {
        McpServerKind::Remote
    }
}

fn oauth_of(v: Option<&JsonValue>) -> Option<McpOAuthConfig> {
    let record = v.and_then(as_record)?;
    let field = |key: &str| as_str(record.get(key)).unwrap_or_default().to_owned();
    Some(McpOAuthConfig {
        client_id: field("clientId"),
        client_secret: field("clientSecret"),
        tokens: field("tokens"),
    })
}

fn new_input(v: &JsonValue) -> NewMcpServerInput {
    let record = as_record(v);
    let get = |key: &str| record.and_then(|r| r.get(key));
    NewMcpServerInput {
        name: as_str(get("name")).unwrap_or_default().to_owned(),
        kind: Some(kind_of(get("kind"))),
        url: as_str(get("url")).map(str::to_owned),
        transport: get("transport").map(|t| {
            if as_str(Some(t)) == Some("sse") {
                McpTransport::Sse
            } else {
                McpTransport::Auto
            }
        }),
        headers: get("headers").map(|h| string_map(Some(h))),
        oauth: oauth_of(get("oauth")),
        command: as_str(get("command")).map(str::to_owned),
        args: get("args").map(|a| strings_of(Some(a))),
        env: get("env").map(|e| string_map(Some(e))),
    }
}

fn text_or_null(v: &JsonValue) -> Option<String> {
    as_str(Some(v)).map(str::to_owned)
}

fn apply_ops(draft: &mut crate::shell::mcp_client::store::McpServersFile, ops: &[JsonValue]) {
    for op in ops {
        let JsonValue::Array(parts) = op else {
            continue;
        };
        let kind = as_str(parts.first()).unwrap_or_default();
        match kind {
            "add" => {
                let mut server =
                    new_mcp_server_config(&new_input(parts.get(1).unwrap_or(&JsonValue::Null)));
                if let Some(id) = as_str(parts.get(2)) {
                    server.id = id.to_owned();
                }
                draft.servers.push(server);
            }
            "patch" => {
                let id = as_str(parts.get(1)).unwrap_or_default();
                let Some(server) = draft.servers.iter_mut().find(|s| s.id == id) else {
                    continue;
                };
                let Some(fields) = parts.get(2).and_then(as_record) else {
                    continue;
                };
                for (key, value) in fields.entries() {
                    match key {
                        "name" => server.name = text_or_null(value).unwrap_or_default(),
                        "enabled" => server.enabled = matches!(value, JsonValue::Bool(true)),
                        "keepResultsInside" => {
                            server.keep_results_inside = matches!(value, JsonValue::Bool(true));
                        }
                        "url" => server.url = text_or_null(value).unwrap_or_default(),
                        "headers" => server.headers = string_map(Some(value)),
                        "env" => server.env = string_map(Some(value)),
                        "command" => server.command = text_or_null(value).unwrap_or_default(),
                        "args" => server.args = strings_of(Some(value)),
                        "oauth" => server.oauth = oauth_of(Some(value)),
                        "approvedLaunch" => server.approved_launch = text_or_null(value),
                        "approvedPlan" => server.approved_plan = text_or_null(value),
                        "pendingInstructions" => server.pending_instructions = text_or_null(value),
                        "newTools" => server.new_tools = strings_of(Some(value)),
                        _ => {}
                    }
                }
            }
            "runtime" => {
                let name = as_str(parts.get(1)).unwrap_or_default();
                let allowed = matches!(parts.get(2), Some(JsonValue::Bool(true)));
                draft.runtimes.set(name, RuntimeAllowance { allowed });
            }
            "drop" => {
                let id = as_str(parts.get(1)).unwrap_or_default();
                draft.servers.retain(|s| s.id != id);
            }
            _ => {}
        }
    }
}

fn error_step(e: &NodeError) -> JsonValue {
    object(vec![("error", text(e.message.as_str()))])
}

fn run_step(mcp: &mut McpServersStore<'_>, file: &str, step: &JsonValue) -> JsonValue {
    let op = as_str(prop(step, "op")).unwrap_or_default();
    let id = as_str(prop(step, "id")).unwrap_or_default();
    match op {
        "load" => {
            let load = mcp.load();
            object(vec![
                ("state", text(load.state.as_str())),
                (
                    "unreadable",
                    JsonValue::Array(
                        load.unreadable
                            .iter()
                            .map(|u| {
                                object(vec![
                                    ("serverId", text(u.server_id.as_str())),
                                    ("secret", text(u.secret.as_str())),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ])
        }
        "get" => mcp.get().to_json(),
        "server" => mcp.server(id).map_or(JsonValue::Null, |s| s.to_json()),
        "update" => {
            let ops = match prop(step, "ops") {
                Some(JsonValue::Array(ops)) => ops.clone(),
                _ => Vec::new(),
            };
            let empty = as_str(prop(step, "ret")) == Some("empty");
            let result = mcp.update(&mut |draft| {
                apply_ops(draft, &ops);
                empty.then(empty_mcp_servers_file)
            });
            match result {
                Ok(file) => file.to_json(),
                Err(e) => error_step(&e),
            }
        }
        "removeServer" => match mcp.remove_server(id) {
            Ok(removed) => JsonValue::Bool(removed),
            Err(e) => error_step(&e),
        },
        "sealing" => JsonValue::Bool(mcp.sealing()),
        "view" => mcp.view(),
        "read" => {
            if std::path::Path::new(file).exists() {
                match std::fs::read(file) {
                    Ok(bytes) => text(String::from_utf8_lossy(&bytes).into_owned()),
                    Err(e) => error_step(&node_error(&e, "read", file)),
                }
            } else {
                JsonValue::Null
            }
        }
        "write" => {
            let body = as_str(prop(step, "text")).unwrap_or_default();
            match std::fs::write(file, body) {
                Ok(()) => JsonValue::Null,
                Err(e) => error_step(&node_error(&e, "open", file)),
            }
        }
        "remove" => {
            let _ = std::fs::remove_file(file);
            JsonValue::Null
        }
        _ => JsonValue::Null,
    }
}

fn store_scenario(args: &[Value]) -> Answer {
    let codec = Rc::new(FakeCodec::of(&json_arg(args, 0)));
    let file = str_arg(args, 2)?;
    let mut mcp = create_mcp_servers_store(file, codec);
    let steps = match json_arg(args, 1) {
        JsonValue::Array(steps) => steps,
        _ => Vec::new(),
    };
    let results: Vec<JsonValue> = steps
        .iter()
        .map(|step| run_step(&mut mcp, file, step))
        .collect();
    out(normalized(JsonValue::Array(results)))
}

// ---- runtime pins ----

fn archive_json(a: &PinnedArchive) -> JsonValue {
    object(vec![
        ("url", text(a.url.as_str())),
        ("sha256", text(a.sha256.as_str())),
        ("bytes", JsonValue::Number(a.bytes as f64)),
        ("format", text(a.format.as_str())),
        ("root", text(a.root.as_str())),
    ])
}

fn platform_json<T>(table: &PlatformTable<T>, f: &dyn Fn(&T) -> JsonValue) -> JsonValue {
    object(
        MCP_RUNTIME_PLATFORM_KEYS
            .iter()
            .map(|key| (key.as_str(), f(table.get(*key))))
            .collect(),
    )
}

fn pins_json(pins: &McpRuntimePins) -> JsonValue {
    let runtime = |r: &crate::shell::mcp_client::runtime_pins::PinnedRuntime| {
        object(vec![
            ("version", text(r.version.as_str())),
            ("archives", platform_json(&r.archives, &archive_json)),
        ])
    };
    object(vec![
        ("node", runtime(&pins.node)),
        ("uv", runtime(&pins.uv)),
        (
            "python",
            object(vec![
                ("version", text(pins.python.version.as_str())),
                (
                    "bytes",
                    platform_json(&pins.python.bytes, &|b| JsonValue::Number(*b as f64)),
                ),
            ]),
        ),
    ])
}

// ---- runtime archive ----

struct FakeFetch {
    spec: JsonValue,
    log: RefCell<Vec<Vec<Value>>>,
}

impl RuntimeFetch for FakeFetch {
    fn fetch(&self, url: &str) -> Result<RuntimeResponse, String> {
        self.log
            .borrow_mut()
            .push(vec![Value::from("fetch"), Value::from(url)]);
        if let Some(reason) = as_str(prop(&self.spec, "reject")) {
            return Err(reason.to_owned());
        }
        let status = match prop(&self.spec, "status") {
            Some(JsonValue::Number(n)) => *n as u16,
            _ => 200,
        };
        let body = if matches!(prop(&self.spec, "noBody"), Some(JsonValue::Bool(true))) {
            None
        } else {
            let mut chunks: Vec<Result<Vec<u8>, String>> = strings_of(prop(&self.spec, "chunks"))
                .iter()
                .map(|h| Ok(hex_bytes(h)))
                .collect();
            if let Some(message) = as_str(prop(&self.spec, "midError")) {
                chunks.push(Err(message.to_owned()));
            }
            let body: Box<dyn Iterator<Item = Result<Vec<u8>, String>>> =
                Box::new(chunks.into_iter());
            Some(body)
        };
        Ok(RuntimeResponse {
            ok: (200..300).contains(&status),
            status,
            body,
        })
    }
}

fn pinned_archive(v: &JsonValue) -> PinnedArchive {
    PinnedArchive {
        url: as_str(prop(v, "url")).unwrap_or_default().to_owned(),
        sha256: as_str(prop(v, "sha256")).unwrap_or_default().to_owned(),
        bytes: match prop(v, "bytes") {
            Some(JsonValue::Number(n)) => *n as u64,
            _ => 0,
        },
        format: archive_format(as_str(prop(v, "format")).unwrap_or_default()),
        root: as_str(prop(v, "root")).unwrap_or_default().to_owned(),
    }
}

fn archive_format(name: &str) -> ArchiveFormat {
    if name == "zip" {
        ArchiveFormat::Zip
    } else {
        ArchiveFormat::TarGz
    }
}

fn archive_failure(kind: &str, message: &str) -> JsonValue {
    object(vec![
        ("kind", text(kind)),
        ("name", text("RuntimeArchiveError")),
        ("message", text(message)),
    ])
}

// ---- local launch ----

fn runtime_id(v: Option<&JsonValue>) -> Option<McpRuntimeId> {
    match as_str(v) {
        Some("node") => Some(McpRuntimeId::Node),
        Some("uv") => Some(McpRuntimeId::Uv),
        Some("python") => Some(McpRuntimeId::Python),
        _ => None,
    }
}

fn missing_detail(name: &str) -> RuntimeMissingDetail {
    match name {
        "unsupported-platform" => RuntimeMissingDetail::UnsupportedPlatform,
        "declined" => RuntimeMissingDetail::Declined,
        "download-needed" => RuntimeMissingDetail::DownloadNeeded,
        "offline" => RuntimeMissingDetail::Offline,
        "hash-mismatch" => RuntimeMissingDetail::HashMismatch,
        "extract-failed" => RuntimeMissingDetail::ExtractFailed,
        "python-install-failed" => RuntimeMissingDetail::PythonInstallFailed,
        _ => RuntimeMissingDetail::NotFound,
    }
}

fn resolution_of(v: &JsonValue) -> RuntimeResolution {
    if matches!(prop(v, "ok"), Some(JsonValue::Bool(true))) {
        return RuntimeResolution::Resolved(ResolvedLaunch {
            command: as_str(prop(v, "command")).unwrap_or_default().to_owned(),
            prefix_args: strings_of(prop(v, "prefixArgs")),
            env: string_map(prop(v, "env")),
            path_prepend: strings_of(prop(v, "pathPrepend")),
            source: if as_str(prop(v, "source")) == Some("app") {
                LaunchSource::App
            } else {
                LaunchSource::Pc
            },
            runtime: runtime_id(prop(v, "runtime")),
        });
    }
    let downloads = match prop(v, "downloads") {
        Some(JsonValue::Array(items)) => items
            .iter()
            .map(|item| RuntimeDownloadItem {
                runtime: runtime_id(prop(item, "runtime")).unwrap_or(McpRuntimeId::Node),
                version: as_str(prop(item, "version")).unwrap_or_default().to_owned(),
                bytes: match prop(item, "bytes") {
                    Some(JsonValue::Number(n)) => *n,
                    _ => 0.0,
                },
            })
            .collect(),
        _ => Vec::new(),
    };
    RuntimeResolution::Missing(RuntimeMissing {
        detail: missing_detail(as_str(prop(v, "detail")).unwrap_or_default()),
        runtime: runtime_id(prop(v, "runtime")),
        downloads,
        message: as_str(prop(v, "message")).unwrap_or_default().to_owned(),
    })
}

struct FakeKit<'a> {
    answer: RuntimeResolution,
    log: &'a RefCell<Vec<Vec<Value>>>,
}

impl McpRuntimeKit for FakeKit<'_> {
    fn resolve_command(&self, command: &str, options: &ResolveOptions) -> RuntimeResolution {
        let mut offer = serde_json::Map::new();
        offer.insert("offerDownload".into(), Value::Bool(options.offer_download));
        self.log.borrow_mut().push(vec![
            Value::from("resolve"),
            Value::from(command),
            Value::Object(offer),
        ]);
        self.answer.clone()
    }
}

fn launch_server(v: &JsonValue) -> LaunchServer {
    LaunchServer {
        command: as_str(prop(v, "command")).unwrap_or_default().to_owned(),
        args: strings_of(prop(v, "args")),
        env: string_map(prop(v, "env")),
    }
}

fn plan_options(v: &JsonValue) -> PlanOptions {
    PlanOptions {
        base_env: prop(v, "baseEnv").map(|e| string_map(Some(e))),
        platform: as_str(prop(v, "platform")).map(str::to_owned),
        system_env: prop(v, "systemEnv").map(|e| strings_of(Some(e))),
        offer_download: match prop(v, "offerDownload") {
            Some(JsonValue::Bool(b)) => Some(*b),
            _ => None,
        },
    }
}

fn string_map_json(record: &JsObject<String>) -> JsonValue {
    let mut out = JsObject::new();
    for (key, value) in record.entries() {
        out.set(key, text(value.as_str()));
    }
    JsonValue::Object(out)
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- toml ----
        "toml.parseToml" => (|| {
            let source = str_arg(args, 0)?;
            out(match parse_toml(source) {
                Ok(table) => object(vec![("ok", JsonValue::Object(table))]),
                Err(e) if e.stack_overflow => object(vec![
                    ("error", text(e.message.as_str())),
                    ("name", text("RangeError")),
                ]),
                Err(e) => object(vec![
                    ("error", text(e.message.as_str())),
                    ("name", text("TomlError")),
                    ("line", JsonValue::Number(e.line as f64)),
                ]),
            })
        })(),
        // ---- paste ----
        "paste.parseMcpPaste" => (|| {
            let source = str_arg(args, 0)?;
            let taken = strings_of(Some(&json_arg(args, 1)));
            out(parse_mcp_paste(source, &taken).to_json())
        })(),
        "paste.placeholderVariable" => (|| {
            let value = str_arg(args, 0)?;
            out(placeholder_variable(value).map_or(JsonValue::Null, text))
        })(),
        // ---- secrets ----
        "secrets.safeStorageMcpCodec" => (|| {
            let storage = FakeStorage::from_spec(&json_arg(args, 0));
            let codec = SafeStorageMcpCodec {
                storage: Rc::new(storage),
                platform: str_arg(args, 1)?.to_owned(),
            };
            let op = str_arg(args, 2)?;
            if op == "canSeal" {
                return out(JsonValue::Bool(codec.can_seal()));
            }
            let value = str_arg(args, 3)?;
            if op == "seal" {
                codec
                    .seal(value)
                    .map_err(|e| CallError::plain(e.0))
                    .and_then(|sealed| out(text(sealed)))
            } else {
                codec
                    .open(value)
                    .map_err(|e| CallError::plain(e.0))
                    .and_then(|opened| out(opened.map_or(JsonValue::Null, text)))
            }
        })(),
        "secrets.mapServerSecrets" => (|| {
            let server = normalized_server(&json_arg(args, 0))?;
            let by_ref = str_arg(args, 1)? == "ref";
            let mapped = map_server_secrets(&server, &mut |value, reference| {
                if by_ref {
                    format!("{reference}={value}")
                } else {
                    value.to_uppercase()
                }
            });
            out(mapped.to_json())
        })(),
        "secrets.sealServerSecrets" => (|| {
            let server = normalized_server(&json_arg(args, 0))?;
            let codec = FakeCodec::of(&json_arg(args, 1));
            let (sealed, memory_only) = seal_server_secrets(&server, &codec);
            out(object(vec![
                ("server", sealed.to_json()),
                ("memoryOnly", str_list(&memory_only)),
            ]))
        })(),
        "secrets.openServerSecrets" => (|| {
            let server = normalized_server(&json_arg(args, 0))?;
            let codec = FakeCodec::of(&json_arg(args, 1));
            let (opened, unreadable) = open_server_secrets(&server, &codec);
            out(object(vec![
                ("server", opened.to_json()),
                ("unreadable", str_list(&unreadable)),
            ]))
        })(),
        "secrets.secretView" => (|| {
            let value = str_arg(args, 0)?;
            let memory_only = matches!(arg(args, 1), Some(Value::Bool(true)));
            out(secret_view(value, memory_only).to_json())
        })(),
        // ---- store ----
        "store.MCP_SERVERS_FILE_NAME" => out(text(MCP_SERVERS_FILE_NAME)),
        "store.MCP_SERVERS_FILE_VERSION" => out(JsonValue::Number(MCP_SERVERS_FILE_VERSION)),
        "store.emptyMcpServersFile" => out(empty_mcp_servers_file().to_json()),
        "store.mcpServersFilePath" => {
            str_arg(args, 0).and_then(|dir| out(text(mcp_servers_file_path(dir))))
        }
        "store.newMcpServerConfig" => out(normalized(
            new_mcp_server_config(&new_input(&json_arg(args, 0))).to_json(),
        )),
        "store.normalizeMcpServersFile" => out(normalized(
            normalize_mcp_servers_file(&json_arg(args, 0)).to_json(),
        )),
        "store.serializeMcpServersFile" => out(text(serialize_mcp_servers_file(
            &normalize_mcp_servers_file(&json_arg(args, 0)),
        ))),
        "store.scenario" => store_scenario(args),
        // ---- runtime-pins ----
        "runtime-pins.MCP_RUNTIME_PINS" => out(pins_json(&mcp_runtime_pins())),
        "runtime-pins.MCP_RUNTIME_PLATFORM_KEYS" => out(JsonValue::Array(
            MCP_RUNTIME_PLATFORM_KEYS
                .iter()
                .map(|k| text(k.as_str()))
                .collect(),
        )),
        "runtime-pins.mcpRuntimePlatformKey" => (|| {
            let platform = str_arg(args, 0)?;
            let arch = str_arg(args, 1)?;
            out(mcp_runtime_platform_key(platform, arch)
                .map_or(JsonValue::Null, |k| text(k.as_str())))
        })(),
        // ---- runtime-archive ----
        "runtime-archive.downloadVerifiedArchive" => (|| {
            let archive = pinned_archive(&json_arg(args, 0));
            let fetch = FakeFetch {
                spec: json_arg(args, 1),
                log: RefCell::new(Vec::new()),
            };
            let target = str_arg(args, 2)?;
            let result = download_verified_archive(&archive, target, &fetch);
            cx.logs.extend(fetch.log.into_inner());
            match result {
                Ok(()) => out(object(vec![("ok", JsonValue::Bool(true))])),
                Err(DownloadError::Archive(e)) => out(archive_failure(e.kind.as_str(), &e.message)),
                Err(DownloadError::Io(e)) => Err(CallError::from(e)),
            }
        })(),
        "runtime-archive.extractRuntimeArchive" => (|| {
            let file = str_arg(args, 0)?;
            let format = archive_format(str_arg(args, 1)?);
            let root = str_arg(args, 2)?;
            let dest = str_arg(args, 3)?;
            match extract_runtime_archive(file, format, root, dest) {
                Ok(()) => out(object(vec![("ok", JsonValue::Bool(true))])),
                Err(e) => out(archive_failure(e.kind.as_str(), &e.message)),
            }
        })(),
        // ---- local-launch ----
        "local-launch.MCP_LOCAL_SYSTEM_ENV" => out(JsonValue::Array(
            MCP_LOCAL_SYSTEM_ENV.iter().map(|s| text(*s)).collect(),
        )),
        "local-launch.MCP_LOCAL_WINDOWS_ENV" => out(JsonValue::Array(
            MCP_LOCAL_WINDOWS_ENV.iter().map(|s| text(*s)).collect(),
        )),
        "local-launch.prepareLocalLaunch" | "local-launch.plannedLaunch" => {
            let log = RefCell::new(Vec::new());
            let kit = FakeKit {
                answer: resolution_of(&json_arg(args, 1)),
                log: &log,
            };
            let server = launch_server(&json_arg(args, 0));
            let options = plan_options(&json_arg(args, 2));
            let answer = if name == "local-launch.prepareLocalLaunch" {
                let prepared = prepare_local_launch(&server, &kit, &options);
                out(object(vec![
                    ("plan", prepared.plan.to_json()),
                    (
                        "env",
                        prepared
                            .env
                            .as_ref()
                            .map_or(JsonValue::Null, string_map_json),
                    ),
                ]))
            } else {
                out(planned_launch(&server, &kit, &options).to_json())
            };
            cx.logs.extend(log.into_inner());
            answer
        }
        _ => return None,
    })
}
