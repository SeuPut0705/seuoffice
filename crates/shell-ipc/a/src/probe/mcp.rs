//! The probe fakes of the `mcp` ports' batch hosts, scripted by the case's
//! `hosts.a.mcp` (the TypeScript half is tools/ipc-diff/groups/a/mcp-servers.ts,
//! mcp-tools.ts and mcp-bridges.ts, which read the same value and log the same
//! lines):
//!
//! - `version`: `app.getVersion()` (`9.9.9` by default); `hosts.a.lang` is the
//!   UI language (`ko` by default)
//! - `servers`: the remote MCP servers behind `net.fetch`, by address:
//!   `{"<url>": {tools: [{name, description}], instructions, initializeStatus,
//!   callText, callError}}`; an address that is not listed (and one with
//!   `unreachable: true`) fails to connect. Each POST and DELETE is one log
//!   line `["net.fetch", method, url, <JSON-RPC method or null>]`
//! - `storage`: `safeStorage`: `{available}` (available by default); the
//!   cipher is a reversible byte transform (XOR 0x5a)
//! - `tabs`: `{docs: [view], sheets: [view], sheetsError}`: the views
//!   `openBlankDocsTabForMcp` / `openBlankSheetsTabForMcp` give, in order
//!
//! Besides the fakes, [`trigger`] runs the calls the MCP tool layer makes of
//! the bridges, which no channel makes.

use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use jscompat::{JsonValue, json_value_from_serde};
use main_core::packages::ai_provider::settings_secrets::CodecThrow;
use main_core::packages::i18n::Lang;
use main_core::packages::mcp_sdk::client::OutputCheck;
use main_core::packages::mcp_sdk::client::net::{FetchError, FetchInit, Headers};
use main_core::shell::ai_secrets::SafeStorageLike;
use main_core::shell::mcp::tools::document_tools::McpEditorCommandName;
use main_core::shell::mcp::tools::sheets_tools::SheetsCommandName;
use serde_json::{Value, json};
use shell_contract::editors::Then;
use shell_contract::provided::Provided;
use shell_contract::runtime::Services;
use shell_contract::{IpcValue, ViewId};

use super::{Log, push};
use crate::mcp::{
    McpBridgeControl, McpNet, McpNetHost, McpSafeStorage, McpShell, McpShellHost, McpTabs,
    McpTabsHost, NetBody, NetResponse,
};
use crate::value::from_json;

struct Once(Option<Vec<u8>>);

impl NetBody for Once {
    fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, FetchError> {
        Ok(self.0.take())
    }
}

struct ProbeNet {
    servers: Value,
    log: Option<Log>,
}

fn response(status: u16, headers: &[(&str, &str)], body: Option<Vec<u8>>) -> NetResponse {
    let mut h = Headers::new();
    for (name, value) in headers {
        h.set(name, value);
    }
    NetResponse {
        status,
        status_text: String::new(),
        headers: h,
        url: String::new(),
        redirected: false,
        opaque_redirect: false,
        body: body.map(|b| Box::new(Once(Some(b))) as Box<dyn NetBody>),
    }
}

impl McpNet for ProbeNet {
    fn fetch(
        &self,
        url: &str,
        init: &FetchInit,
        _limit_ms: Option<f64>,
    ) -> Result<NetResponse, FetchError> {
        let method = init.method.as_deref().unwrap_or("GET");
        let spec = &self.servers[url];
        let rpc: Option<Value> = (method == "POST").then(|| {
            serde_json::from_str(init.body.as_deref().unwrap_or("{}")).unwrap_or(Value::Null)
        });
        if method == "POST" || method == "DELETE" {
            let name = rpc
                .as_ref()
                .and_then(|r| r["method"].as_str())
                .map_or(Value::Null, |m| json!(m));
            push(&self.log, json!(["net.fetch", method, url, name]));
        }
        if !spec.is_object() || spec["unreachable"] == json!(true) {
            return Err(FetchError::type_error("fetch failed"));
        }
        match method {
            "POST" => {
                let rpc = rpc.unwrap_or(Value::Null);
                let rpc_method = rpc["method"].as_str().unwrap_or("");
                let result = match rpc_method {
                    "initialize" => {
                        if let Some(status) = spec["initializeStatus"].as_u64() {
                            return Ok(response(status as u16, &[], Some(b"error".to_vec())));
                        }
                        let mut result = json!({
                            "protocolVersion": rpc["params"]["protocolVersion"],
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "fake", "version": "1"},
                        });
                        if let Some(text) = spec["instructions"].as_str() {
                            result["instructions"] = json!(text);
                        }
                        result
                    }
                    "tools/list" => {
                        json!({"tools": spec["tools"].as_array().cloned().unwrap_or_default()
                        .iter().map(|t| json!({
                            "name": t["name"],
                            "description": t["description"],
                            "inputSchema": {"type": "object", "properties": {}}
                        })).collect::<Vec<_>>()})
                    }
                    "tools/call" => {
                        let name = rpc["params"]["name"].as_str().unwrap_or("");
                        let text = spec["callText"]
                            .as_str()
                            .map_or_else(|| format!("called {name}"), str::to_owned);
                        let mut result = json!({"content": [{"type": "text", "text": text}]});
                        if spec["callError"] == json!(true) {
                            result["isError"] = json!(true);
                        }
                        result
                    }
                    _ => return Ok(response(202, &[], None)),
                };
                let body = serde_json::to_vec(
                    &json!({"jsonrpc": "2.0", "id": rpc["id"], "result": result}),
                )
                .unwrap_or_default();
                let session = [
                    ("content-type", "application/json"),
                    ("mcp-session-id", "s1"),
                ];
                let plain = [("content-type", "application/json")];
                Ok(response(
                    200,
                    if rpc_method == "initialize" {
                        &session
                    } else {
                        &plain
                    },
                    Some(body),
                ))
            }
            "DELETE" => Ok(response(200, &[], None)),
            _ => Ok(response(405, &[], None)),
        }
    }

    fn compile_output_schema(&self, _schema: &JsonValue) -> Result<u64, String> {
        Ok(1)
    }

    fn validate_output(&self, _validator: u64, _value: &JsonValue) -> OutputCheck {
        OutputCheck::Valid
    }
}

struct ProbeShell {
    lang: Lang,
    version: String,
}

impl McpShell for ProbeShell {
    fn lang(&self) -> Lang {
        self.lang
    }

    fn app_version(&self) -> String {
        self.version.clone()
    }
}

struct ProbeStorage {
    available: bool,
}

impl SafeStorageLike for ProbeStorage {
    fn is_encryption_available(&self) -> bool {
        self.available
    }

    fn encrypt_string(&self, plain: &str) -> Result<Vec<u8>, CodecThrow> {
        Ok(plain.bytes().map(|b| b ^ 0x5a).collect())
    }

    fn decrypt_string(&self, sealed: &[u8]) -> Result<String, CodecThrow> {
        let plain: Vec<u8> = sealed.iter().map(|b| b ^ 0x5a).collect();
        Ok(String::from_utf8_lossy(&plain).into_owned())
    }

    fn get_selected_storage_backend(&self) -> Option<String> {
        Some("gnome_libsecret".to_owned())
    }
}

struct ProbeTabs {
    docs: Mutex<VecDeque<u32>>,
    sheets: Mutex<VecDeque<u32>>,
    sheets_error: Option<String>,
    log: Option<Log>,
}

impl McpTabs for ProbeTabs {
    fn open_blank_docs_tab(&self) -> ViewId {
        push(&self.log, json!(["openBlankDocsTabForMcp"]));
        ViewId(self.docs.lock().expect("tabs").pop_front().unwrap_or(0))
    }

    fn authorize_docs_save(&self, view: ViewId, path: &str) {
        push(&self.log, json!(["authorizeMcpDocWrite", view.0, path]));
    }

    fn abandon_blank_docs_tab(&self, view: ViewId) {
        push(&self.log, json!(["abandonBlankTabForMcp", view.0]));
    }

    fn open_blank_sheets_tab(&self) -> Result<ViewId, String> {
        push(&self.log, json!(["openBlankSheetsTabForMcp"]));
        if let Some(message) = &self.sheets_error {
            return Err(message.clone());
        }
        Ok(ViewId(
            self.sheets.lock().expect("tabs").pop_front().unwrap_or(0),
        ))
    }

    fn authorize_sheets_save(&self, view: ViewId, path: &str) {
        push(&self.log, json!(["authorizeMcpSheetWrite", view.0, path]));
    }

    fn abandon_blank_sheets_tab(&self, view: ViewId) {
        push(&self.log, json!(["abandonBlankSheetsTabForMcp", view.0]));
    }
}

pub fn insert(hosts: &mut shell_contract::Hosts, case: &serde_json::Value, log: Option<Log>) {
    let world = &case["mcp"];
    hosts.insert(crate::mcp::hub_factory());
    hosts.insert(crate::mcp::bridges_factory());
    hosts.insert::<McpNetHost>(Arc::new(ProbeNet {
        servers: world["servers"].clone(),
        log: log.clone(),
    }));
    hosts.insert::<McpShellHost>(Arc::new(ProbeShell {
        lang: super::case_lang(case),
        version: world["version"].as_str().unwrap_or("9.9.9").to_owned(),
    }));
    hosts.insert::<McpSafeStorage>(Arc::new(ProbeStorage {
        available: world["storage"]["available"] != json!(false),
    }));
    let views = |key: &str| -> VecDeque<u32> {
        world["tabs"][key]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_u64().map(|v| v as u32))
                    .collect()
            })
            .unwrap_or_default()
    };
    hosts.insert::<McpTabsHost>(Arc::new(ProbeTabs {
        docs: Mutex::new(views("docs")),
        sheets: Mutex::new(views("sheets")),
        sheets_error: world["tabs"]["sheetsError"].as_str().map(str::to_owned),
        log,
    }));
}

fn command_text(args: &Value, at: usize) -> &str {
    args.get(at).and_then(Value::as_str).unwrap_or("")
}

/// The calls of the MCP tool layer on the bridges, by trigger name:
/// `a/mcp-docs-open-blank` `[]`, `a/mcp-docs-run` `[wcId, command, payload?]`,
/// `a/mcp-sheets-open-blank` `[]`, `a/mcp-sheets-run` `[wcId, command, payload?]`.
/// The outcome is the value the promise resolves with (`undefined` when none);
/// `false` when `name` is not one of these.
pub fn trigger(
    name: &str,
    _view: ViewId,
    args: &Value,
    _services: &Services,
    provided: &Rc<Provided>,
    then: Then<IpcValue>,
) -> bool {
    let Some(control) = provided.all::<dyn McpBridgeControl>().into_iter().next() else {
        return false;
    };
    let done: Then<Option<JsonValue>> = Box::new(move |outcome| {
        then(outcome.map(|value| value.map_or(IpcValue::Undefined, |v| from_json(&v))))
    });
    let wc = args.get(0).and_then(Value::as_i64).unwrap_or(-1);
    let payload = args
        .get(2)
        .filter(|p| !p.is_null())
        .map(json_value_from_serde);
    match name {
        "a/mcp-docs-open-blank" => control.docs_open_blank_tab(done),
        "a/mcp-sheets-open-blank" => control.sheets_open_blank_tab(done),
        "a/mcp-docs-run" => {
            let command = match command_text(args, 1) {
                "insert_content" => McpEditorCommandName::InsertContent,
                "replace_blocks" => McpEditorCommandName::ReplaceBlocks,
                "apply_ops" => McpEditorCommandName::ApplyOps,
                "insert_picture" => McpEditorCommandName::InsertPicture,
                "save_document" => McpEditorCommandName::SaveDocument,
                _ => McpEditorCommandName::ReadDocument,
            };
            control.docs_run_command(wc, command, payload, done);
        }
        "a/mcp-sheets-run" => {
            let command = match command_text(args, 1) {
                "apply_ops" => SheetsCommandName::ApplyOps,
                "save_sheet" => SheetsCommandName::SaveSheet,
                _ => SheetsCommandName::ReadSheet,
            };
            control.sheets_run_command(wc, command, payload, done);
        }
        _ => return false,
    }
    true
}
