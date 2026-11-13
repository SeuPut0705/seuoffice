//! The functions of group `b3-shell` (tools/main-diff/groups/b3-shell.ts).
//!
//! The fakes of the specs (a `run` that answers from a script, a host that
//! records its calls, a socket driven by a list of steps) are written here as
//! the TypeScript spec writes them: each call of a fake is one log line, with
//! the same arguments on both sides. Names that are not exports of their
//! module: `shell-atomic-write.*` is `apps/shell/src/main/atomic-write.ts`,
//! `control-server.serve` is the connection function of control-server.ts.

use std::cell::{Cell, RefCell};
use std::collections::{HashSet, VecDeque};
use std::rc::Rc;

use super::{Answer, CallError, Context, arg, str_arg};
use crate::node_fs::NodeError;
use crate::packages::cli::{CONTROL_FILE, CONTROL_MAX_REQUEST_BYTES, CONTROL_PROTOCOL};
use crate::packages::electron_utils::generate_handoff::{
    GenerateConvertKind, GenerateConvertTarget, GenerateHandoff, GenerateHandoffTarget,
    HandoffStore, Material,
};
use crate::packages::electron_utils::recovery_store::{
    RecoveryCopyFilter, RecoveryCopyState, RecoveryFileIdentity, RecoveryIdentity,
    RecoveryLaunchDecision, RecoveryUntitledIdentity,
};
use crate::packages::i18n::Lang;
use crate::shell::atomic_write::{atomic_copy_file, atomic_write_file};
use crate::shell::control_handlers::{
    ControlAnswer, ControlContents, ControlHost, ControlStep, ControlTab, ScriptRejected,
    control_handler,
};
use crate::shell::control_server::{
    ControlListener, ControlSession, ControlStartError, SessionStep, control_endpoint_path,
    parse_envelope, start_control_server,
};
use crate::shell::csv_import_limit::csv_import_limit_mb;
use crate::shell::default_app::{
    DefaultAppDeps, DefaultAppHost, ExecError, OFFICE_TYPES, create_default_app_service,
    exec_file_runner, mac_app_bundle_path, parse_linux_status, parse_mac_status, parse_reg_value,
    read_file_utf8,
};
use crate::shell::diagram_open_gate::{DiagramOpenGate, DiagramOpenGateDeps, VisioAnswer};
use crate::shell::document_links::{
    DOCUMENT_LINKS_FILE, DocumentLink, DocumentLinkMenuModel, DocumentLinkVia, DocumentLinks,
    DocumentLinksDeps, DocumentLinksFile, LinkLookup, LinkMenuEntry, LinkedWebContents, ListenerId,
    MakeEvent, StatTimes, document_link_menu_model, document_links_at, handoff_store_events,
    is_freshly_saved_path, link_path_key, parse_document_links, read_document_links_file,
    stat_sync, watch_make_events,
};
use crate::shell::document_links_menu::{
    DocumentLinkMenuHandlers, DocumentLinkMenuLabels, MenuItem, document_link_menu_items,
};
use crate::shell::document_password_prompt::{
    DocumentPasswordPrompts, DocumentPasswordWindow, PromptId,
};
use crate::shell::feedback::{
    FEEDBACK_SURVEY_URL, FeedbackEnvironment, feedback_details, feedback_strings, feedback_text,
    platform_label,
};
use crate::shell::launch_recovery::{
    EnsureLoaded, GateGet, GateSubmit, LAUNCH_NEEDS_USER_MESSAGE, LaunchCopy, LaunchCopySource,
    LaunchJudgment, LaunchListGate, LaunchOutcome, LaunchPlan, LiveTabContentsDeps, LiveTabLookup,
    LiveTabStep, OS_SESSION_END_WRITE_TIMEOUT_MS, OsSessionEnd, OsSessionEndDeps, PlannedOpen,
    PlannedSplit, PlannedTab, RecoveryChoice, RecoveryListItem, RecoveryListResult, WriteState,
    live_session_source, normalize_launch_list_result, plan_launch, recovery_identity_key,
    resolve_launch_decisions,
};
use crate::shell::pdf_convert_ui_handlers::{
    PdfConvertUiDeps, PdfConvertUiTabs, ReleaseStep, create_pdf_convert_ui_handlers,
};
use crate::shell::pdf_note_tabs::{
    NoteAppendContents, NoteTabHost, insert_into_note_tab, is_note_file, open_note_tab,
};
use crate::shell::pdf_save_as_formats::{
    pdf_save_as_default_path, pdf_save_as_filters, pdf_save_as_format_of, pdf_save_as_picked_path,
};
use crate::shell::renderer_disposal::Failure;
use crate::shell::session_record::{
    SessionRecordReadResult, SessionUntitledCopy, parse_session_record,
};
use jscompat::{
    JsObject, JsonValue, json_value_from_serde, json_value_to_serde, number_to_string, sha1_hex,
};
use serde_json::{Map, Number, Value};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "shell-atomic-write.atomicWriteFile" => str_arg(args, 0).and_then(|path| {
            let text = str_arg(args, 1)?;
            atomic_write_file(path, text.as_bytes())
                .map(|()| None)
                .map_err(masked)
        }),
        "shell-atomic-write.atomicCopyFile" => str_arg(args, 0).and_then(|source| {
            let path = str_arg(args, 1)?;
            atomic_copy_file(source, path)
                .map(|()| None)
                .map_err(masked)
        }),
        "control-protocol.CONTROL_FILE" => Ok(Some(Value::from(CONTROL_FILE))),
        "control-protocol.CONTROL_PROTOCOL" => Ok(Some(Value::from(CONTROL_PROTOCOL))),
        "control-protocol.CONTROL_MAX_REQUEST_BYTES" => {
            Ok(Some(Value::from(CONTROL_MAX_REQUEST_BYTES as u64)))
        }
        "csv-import-limit.csvImportLimitMb" => csv_call(args),
        "feedback.FEEDBACK_SURVEY_URL" => Ok(Some(Value::from(FEEDBACK_SURVEY_URL))),
        "feedback.FEEDBACK_STRINGS" => Ok(Some(feedback_strings_value())),
        "feedback.feedbackText" => feedback_text_call(args),
        "feedback.platformLabel" => {
            str_arg(args, 0).map(|platform| Some(Value::from(platform_label(platform))))
        }
        "feedback.feedbackDetails" => feedback_details_call(args),
        "pdf-save-as-formats.pdfSaveAsFilters" => str_arg(args, 0).map(|prefix| {
            let filters = pdf_save_as_filters(&mut |key| {
                cx.logs.push(vec![Value::from(key.as_str())]);
                format!("{prefix}{}", key.as_str())
            });
            Some(serde_json::to_value(filters).expect("filters print"))
        }),
        "pdf-save-as-formats.pdfSaveAsDefaultPath" => {
            str_arg(args, 0).map(|path| Some(Value::from(pdf_save_as_default_path(path))))
        }
        "pdf-save-as-formats.pdfSaveAsPickedPath" => {
            str_arg(args, 0).map(|path| Some(Value::from(pdf_save_as_picked_path(path))))
        }
        "pdf-save-as-formats.pdfSaveAsFormatOf" => str_arg(args, 0).map(|target| {
            Some(serde_json::to_value(pdf_save_as_format_of(target)).expect("a format prints"))
        }),
        "control-server.controlEndpointPath" => str_arg(args, 0).and_then(|user_data| {
            let platform = str_arg(args, 1)?;
            Ok(Some(Value::from(control_endpoint_path(
                user_data,
                platform == "win32",
            ))))
        }),
        "control-server.parseEnvelope" => str_arg(args, 0).map(|line| {
            Some(match parse_envelope(line) {
                Some(envelope) => json_value_to_serde(&envelope.raw),
                None => Value::Null,
            })
        }),
        "control-server.startControlServer" => start_server_call(args),
        "control-server.serve" => serve_call(args, cx),
        "control-handlers.controlHandler" => control_handler_call(args, cx),
        "default-app.OFFICE_TYPES" => Ok(Some(office_types_value())),
        "default-app.execFileRunner" => exec_call(args),
        "default-app.macAppBundlePath" => str_arg(args, 0)
            .map(|exe| Some(mac_app_bundle_path(exe).map_or(Value::Null, Value::from))),
        "default-app.parseMacStatus" => str_arg(args, 0).and_then(|json| {
            parse_mac_status(json)
                .map(|status| Some(serde_json::to_value(status).expect("a status prints")))
                .map_err(|e| CallError::plain(e.0))
        }),
        "default-app.parseLinuxStatus" => string_list(args, 0).map(|outputs| {
            Some(serde_json::to_value(parse_linux_status(&outputs)).expect("a status prints"))
        }),
        "default-app.parseRegValue" => str_arg(args, 0)
            .map(|output| Some(parse_reg_value(output).map_or(Value::Null, Value::from))),
        "default-app.createDefaultAppService" => default_app_call(args, cx),
        "diagram-open-gate.openDiagramChecked" => gate_call(args, cx, false),
        "diagram-open-gate.diagramOpenChecking" => gate_call(args, cx, true),
        "document-password-prompt.createDocumentPasswordPrompt" => prompts_call(args, cx),
        "pdf-convert-ui-handlers.createPdfConvertUiHandlers" => convert_call(args, cx),
        "pdf-note-tabs.isNoteFile" => Ok(Some(Value::Bool(is_note_file(
            arg(args, 0).map(json_value_from_serde).as_ref(),
        )))),
        "pdf-note-tabs.openNoteTab" => open_note_call(args, cx),
        "pdf-note-tabs.insertIntoNoteTab" => insert_note_call(args, cx),
        "document-links.DOCUMENT_LINKS_FILE" => Ok(Some(Value::from(DOCUMENT_LINKS_FILE))),
        "document-links.linkPathKey" => {
            str_arg(args, 0).map(|path| Some(Value::from(link_path_key(path))))
        }
        "document-links.parseDocumentLinks" => str_arg(args, 0).map(|text| {
            Some(serde_json::to_value(parse_document_links(text)).expect("links print"))
        }),
        "document-links.readDocumentLinksFile" => str_arg(args, 0).map(|path| {
            Some(serde_json::to_value(read_document_links_file(path)).expect("links print"))
        }),
        "document-links.handoffStoreEvents" => handoff_events_call(args),
        "document-links.watchMakeEvents" => watch_call(args, cx),
        "document-links.isFreshlySavedPath" => fresh_call(args, cx),
        "document-links.DocumentLinks" => links_call(args, cx),
        "document-links.documentLinksAt" => links_at_call(args, cx),
        "document-links.documentLinkMenuModel" => menu_model_call(args, cx),
        "document-links-menu.documentLinkMenuItems" => menu_items_call(args, cx),
        "launch-recovery.OS_SESSION_END_WRITE_TIMEOUT_MS" => {
            Ok(Some(Value::from(OS_SESSION_END_WRITE_TIMEOUT_MS as u64)))
        }
        "launch-recovery.LAUNCH_NEEDS_USER_MESSAGE" => {
            Ok(Some(Value::from(LAUNCH_NEEDS_USER_MESSAGE)))
        }
        "launch-recovery.recoveryIdentityKey" => Ok(Some(Value::from(recovery_identity_key(
            &identity_in(arg(args, 0).unwrap_or(&Value::Null)),
        )))),
        "launch-recovery.planLaunch" => launch_plan_call(args, cx),
        "launch-recovery.resolveLaunchDecisions" => launch_resolve_call(args),
        "launch-recovery.normalizeLaunchListResult" => launch_normalize_call(args),
        "launch-recovery.createLaunchListGate" => launch_gate_call(args, cx),
        "launch-recovery.createOsSessionEnd" => os_end_call(args, cx),
        "launch-recovery.liveSessionSource" => live_call(args, cx),
        "launch-recovery.liveTabContents" => tab_contents_call(args, cx),
        _ => return None,
    })
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

/// `.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')`: a temp name's random part
/// differs on each side, so both sides write it as `<hex>`.
fn mask_tmp(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut at = 0;
    let mut copied = 0;
    while at + 17 <= bytes.len() {
        let window = &bytes[at..at + 17];
        if window[0] == b'.'
            && window[1..13]
                .iter()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            && &window[13..] == b".tmp"
        {
            out.push_str(&text[copied..at]);
            out.push_str(".<hex>.tmp");
            at += 17;
            copied = at;
        } else {
            at += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

fn masked(mut error: NodeError) -> CallError {
    error.message = mask_tmp(&error.message);
    error.into()
}

fn string_list(args: &[Value], i: usize) -> Result<Vec<String>, CallError> {
    arg(args, i)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list"))?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad("a string")))
        .collect()
}

/// a field of an object spec, `None` where it is absent or `null`
fn field<'a>(spec: &'a Value, key: &str) -> Option<&'a Value> {
    spec.get(key).filter(|v| !v.is_null())
}

fn field_str<'a>(spec: &'a Value, key: &str) -> Option<&'a str> {
    field(spec, key).and_then(Value::as_str)
}

fn field_f64(spec: &Value, key: &str) -> Option<f64> {
    field(spec, key).and_then(Value::as_f64)
}

fn field_bool(spec: &Value, key: &str) -> bool {
    spec.get(key) == Some(&Value::Bool(true))
}

fn field_list<'a>(spec: &'a Value, key: &str) -> &'a [Value] {
    field(spec, key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// the calls a fake recorded, handed to the context at the end of a call
#[derive(Clone, Default)]
struct Log(Rc<RefCell<Vec<Vec<Value>>>>);

impl Log {
    fn push(&self, line: Vec<Value>) {
        self.0.borrow_mut().push(line);
    }

    fn flush_into(&self, cx: &mut Context) {
        cx.logs.append(&mut self.0.borrow_mut());
    }
}

// ---- csv-import-limit, feedback, default-app constants ----

fn csv_call(args: &[Value]) -> Answer {
    let settings = arg(args, 0).ok_or_else(|| bad("settings"))?;
    let limit = match json_value_from_serde(settings) {
        JsonValue::Object(object) => csv_import_limit_mb(&object),
        JsonValue::Null => {
            return Err(CallError::plain(
                "Cannot read properties of null (reading 'csvImportLimitMb')",
            ));
        }
        // a property of a list or a primitive is undefined
        _ => csv_import_limit_mb(&JsObject::new()),
    };
    Ok(Some(num(limit)))
}

fn dictionary_value(dict: &JsObject<String>) -> Value {
    let mut map = Map::new();
    for (key, text) in dict.entries() {
        map.insert(key.to_string(), Value::from(text.as_str()));
    }
    Value::Object(map)
}

fn feedback_strings_value() -> Value {
    let strings = feedback_strings();
    let mut map = Map::new();
    map.insert("en".to_string(), dictionary_value(&strings.en));
    map.insert("ko".to_string(), dictionary_value(&strings.ko));
    Value::Object(map)
}

fn lang_arg(args: &[Value], i: usize) -> Result<Lang, CallError> {
    match str_arg(args, i)? {
        "en" => Ok(Lang::En),
        "ko" => Ok(Lang::Ko),
        _ => Err(bad("a language")),
    }
}

/// `[lang, key, params | null]`
fn feedback_text_call(args: &[Value]) -> Answer {
    let lang = lang_arg(args, 0)?;
    let key = str_arg(args, 1)?;
    let params = match arg(args, 2).map(json_value_from_serde) {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::Object(params)) => Some(params),
        Some(_) => return Err(bad("params")),
    };
    Ok(Some(Value::from(feedback_text(lang, key, params.as_ref()))))
}

/// `[lang, { version, os, language }]`
fn feedback_details_call(args: &[Value]) -> Answer {
    let lang = lang_arg(args, 0)?;
    let env = arg(args, 1).ok_or_else(|| bad("env"))?;
    let part = |key: &str| {
        env.get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| bad(key))
    };
    let env = FeedbackEnvironment {
        version: part("version")?,
        os: part("os")?,
        language: part("language")?,
    };
    Ok(Some(Value::from(feedback_details(lang, &env))))
}

fn office_types_value() -> Value {
    Value::Array(
        OFFICE_TYPES
            .iter()
            .map(|t| {
                let mut map = Map::new();
                map.insert("ext".into(), Value::from(t.ext));
                map.insert("uti".into(), Value::from(t.uti));
                map.insert("mime".into(), Value::from(t.mime));
                map.insert("progId".into(), Value::from(t.prog_id));
                Value::Object(map)
            })
            .collect(),
    )
}

/// `[cmd, args]`
fn exec_call(args: &[Value]) -> Answer {
    let cmd = str_arg(args, 0)?;
    let argv = string_list(args, 1)?;
    exec_file_runner(cmd, &argv)
        .map(|out| Some(Value::from(out)))
        .map_err(|ExecError { code, message }| CallError { code, message })
}

// ---- control-server ----

/// the token of the Rust side of the specs: 48 hex digits, as long as the TypeScript's
const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

/// `net.Server.listen` on a unix socket path: the path must be free
struct FakeListener;

impl ControlListener for FakeListener {
    fn listen(&mut self, endpoint: &str) -> Result<(), String> {
        if std::path::Path::new(endpoint).exists() {
            return Err("EADDRINUSE".to_string());
        }
        Ok(())
    }

    fn close(&mut self) {}
}

/// `[userData]`
fn start_server_call(args: &[Value]) -> Answer {
    let user_data = str_arg(args, 0)?;
    let mut listener = FakeListener;
    let started = start_control_server(user_data, false, std::process::id(), TOKEN, &mut listener);
    let mut server = match started {
        Ok(server) => server,
        Err(ControlStartError::Listen(code)) => {
            return Err(CallError {
                message: format!("listen {code}"),
                code: Some(code),
            });
        }
        Err(ControlStartError::WriteFile(error)) => return Err(error.into()),
    };
    let file = jscompat::node_path::host::join(&[user_data, CONTROL_FILE]);
    let text = std::fs::read_to_string(&file).map_err(|e| CallError::plain(e.to_string()))?;
    let mode = file_mode(&file);
    let mut endpoint = Map::new();
    endpoint.insert("protocol".into(), Value::from(server.endpoint.protocol));
    endpoint.insert(
        "pid".into(),
        Value::Bool(server.endpoint.pid == std::process::id()),
    );
    endpoint.insert(
        "endpoint".into(),
        Value::from(server.endpoint.endpoint.as_str()),
    );
    endpoint.insert("token".into(), Value::from("<token>"));
    server.close();
    let mut out = Map::new();
    out.insert("endpoint".into(), Value::Object(endpoint));
    out.insert("file".into(), Value::from(text.replace(TOKEN, "<token>")));
    out.insert("mode".into(), Value::from(mode));
    Ok(Some(Value::Object(out)))
}

#[cfg(unix)]
fn file_mode(path: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| format!("{:o}", meta.permissions().mode() & 0o777))
        .unwrap_or_default()
}

#[cfg(not(unix))]
fn file_mode(_path: &str) -> String {
    String::new()
}

/// `[ops]`: `{ send }`, `{ settle, value }`, `{ settle, reject }`, `{ settle, rejectValue }`
fn serve_call(args: &[Value], cx: &mut Context) -> Answer {
    let ops = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let mut session = ControlSession::new();
    let mut calls = 0usize;
    let mut last: Option<SessionStep> = None;
    for op in ops {
        let step = if let Some(send) = field_str(op, "send") {
            session.on_data(TOKEN, &send.replace("$TOKEN", TOKEN))
        } else {
            let settle = field_f64(op, "settle").ok_or_else(|| bad("settle"))? as usize;
            if settle >= calls {
                return Err(bad("a handler call that was made"));
            }
            let outcome = if let Some(message) = field_str(op, "reject") {
                Err(message.to_string())
            } else if let Some(text) = field_str(op, "rejectValue") {
                Err(text.to_string())
            } else {
                Ok(json_value_from_serde(
                    op.get("value").unwrap_or(&Value::Null),
                ))
            };
            session.settled(outcome)
        };
        match step {
            SessionStep::Handle(request) => {
                cx.logs
                    .push(vec![Value::from("handler"), json_value_to_serde(&request)]);
                calls += 1;
            }
            SessionStep::Reply(_) | SessionStep::Destroy => {
                last.get_or_insert(step);
            }
            SessionStep::Wait => {}
        }
    }
    let mut out = Map::new();
    match last {
        None => {
            out.insert("outcome".into(), Value::from("open"));
        }
        Some(SessionStep::Reply(line)) => {
            out.insert("outcome".into(), Value::from("reply"));
            out.insert("reply".into(), Value::from(line));
        }
        Some(_) => {
            out.insert("outcome".into(), Value::from("destroyed"));
        }
    }
    Ok(Some(Value::Object(out)))
}

// ---- control-handlers ----

/// what the fake `webContents` and host share
struct ControlShared {
    cfg: Value,
    /// `[path, id, kind, contents]`
    tabs: RefCell<Vec<(String, String, String, String)>>,
    /// per contents name: `isLoading` calls and `executeJavaScript` calls so far
    states: RefCell<std::collections::HashMap<String, (usize, usize)>>,
    log: Log,
    clock: Cell<f64>,
}

#[derive(Clone)]
struct FakeControlContents {
    name: String,
    shared: Rc<ControlShared>,
}

impl FakeControlContents {
    fn spec(&self) -> Option<&Value> {
        self.shared
            .cfg
            .get("contents")
            .and_then(|c| c.get(&self.name))
    }
}

impl ControlContents for FakeControlContents {
    fn is_destroyed(&mut self) -> bool {
        self.shared.log.push(vec![
            Value::from("isDestroyed"),
            Value::from(self.name.as_str()),
        ]);
        self.spec()
            .is_some_and(|spec| field_bool(spec, "destroyed"))
    }

    fn is_loading(&mut self) -> bool {
        self.shared.log.push(vec![
            Value::from("isLoading"),
            Value::from(self.name.as_str()),
        ]);
        let seq: Vec<bool> = self
            .spec()
            .map(|spec| {
                field_list(spec, "loading")
                    .iter()
                    .map(|v| v.as_bool().unwrap_or(false))
                    .collect()
            })
            .unwrap_or_default();
        let mut states = self.shared.states.borrow_mut();
        let state = states.entry(self.name.clone()).or_default();
        let answer = seq
            .get(state.0.min(seq.len().saturating_sub(1)))
            .copied()
            .unwrap_or(false);
        state.0 += 1;
        answer
    }
}

impl FakeControlContents {
    /// `await wc.executeJavaScript(script, true)` as the spec's fake answers it
    fn execute_javascript(&self, script: &str) -> Result<Option<JsonValue>, ScriptRejected> {
        self.shared.log.push(vec![
            Value::from("exec"),
            Value::from(self.name.as_str()),
            Value::from(script),
            Value::Bool(true),
        ]);
        let replies: Vec<Value> = self
            .spec()
            .map(|spec| field_list(spec, "replies").to_vec())
            .unwrap_or_default();
        let mut states = self.shared.states.borrow_mut();
        let state = states.entry(self.name.clone()).or_default();
        let reply = replies.get(state.1.min(replies.len().saturating_sub(1)));
        state.1 += 1;
        match reply {
            None => Ok(None),
            Some(reply) if field_bool(reply, "$reject") => Err(ScriptRejected),
            Some(reply) if field_bool(reply, "$undefined") => Ok(None),
            Some(reply) => Ok(Some(json_value_from_serde(reply))),
        }
    }
}

struct FakeControlHost {
    shared: Rc<ControlShared>,
}

impl FakeControlHost {
    fn contents(&self, name: &str) -> FakeControlContents {
        FakeControlContents {
            name: name.to_string(),
            shared: self.shared.clone(),
        }
    }
}

impl ControlHost for FakeControlHost {
    type Contents = FakeControlContents;

    fn reveal(&mut self) {
        self.shared.log.push(vec![Value::from("reveal")]);
    }

    fn open_document(&mut self, path: &str) -> bool {
        self.shared
            .log
            .push(vec![Value::from("openDocument"), Value::from(path)]);
        let Some(added) = field_list(&self.shared.cfg, "opens")
            .iter()
            .find(|open| field_str(open, "path") == Some(path))
        else {
            return false;
        };
        self.shared.tabs.borrow_mut().push((
            path.to_string(),
            field_str(added, "id").unwrap_or_default().to_string(),
            field_str(added, "kind").unwrap_or_default().to_string(),
            field_str(added, "contents").unwrap_or_default().to_string(),
        ));
        true
    }

    fn activate_tab(&mut self, id: &str) {
        self.shared
            .log
            .push(vec![Value::from("activateTab"), Value::from(id)]);
    }

    fn find_tab(&mut self, path: &str) -> Option<ControlTab<FakeControlContents>> {
        self.shared
            .log
            .push(vec![Value::from("findTab"), Value::from(path)]);
        let tabs = self.shared.tabs.borrow();
        let (_, id, kind, contents) = tabs.iter().find(|t| t.0 == path)?;
        Some(ControlTab {
            id: id.clone(),
            kind: kind.clone(),
            web_contents: self.contents(contents),
        })
    }

    fn ready_timeout_ms(&self) -> Option<f64> {
        field_f64(&self.shared.cfg, "readyTimeoutMs")
    }

    fn now_ms(&mut self) -> f64 {
        self.shared.clock.get()
    }
}

/// `[cfg, requests]`
fn control_handler_call(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("cfg"))?.clone();
    let requests = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("requests"))?;
    let tabs = field_list(&cfg, "tabs")
        .iter()
        .map(|t| {
            let text = |key: &str| field_str(t, key).unwrap_or_default().to_string();
            (text("path"), text("id"), text("kind"), text("contents"))
        })
        .collect();
    let log = Log::default();
    let shared = Rc::new(ControlShared {
        cfg,
        tabs: RefCell::new(tabs),
        states: RefCell::default(),
        log: log.clone(),
        clock: Cell::new(cx.now_ms),
    });
    let mut handler = control_handler(FakeControlHost {
        shared: shared.clone(),
    });
    let replies: Vec<Value> = requests
        .iter()
        .map(|request| {
            let (mut run, mut step) = handler.handle(&json_value_from_serde(request));
            loop {
                let answer = match step {
                    ControlStep::Done(reply) => break json_value_to_serde(&reply),
                    ControlStep::ExecuteJavaScript {
                        web_contents,
                        script,
                    } => ControlAnswer::Script(web_contents.execute_javascript(&script)),
                    ControlStep::Wait(ms) => {
                        shared.clock.set(shared.clock.get() + ms);
                        shared.log.push(vec![Value::from("wait"), num(ms)]);
                        ControlAnswer::Waited
                    }
                };
                let Some(run) = run.as_mut() else {
                    break Value::Null;
                };
                step = run.resume(&mut handler, answer);
            }
        })
        .collect();
    log.flush_into(cx);
    Ok(Some(Value::Array(replies)))
}

// ---- default-app ----

/// `short(text)`: a long argument is logged as its SHA-1
fn short(text: &str) -> Value {
    if text.encode_utf16().count() > 100 {
        Value::from(format!("sha1:{}", sha1_hex(text.as_bytes())))
    } else {
        Value::from(text)
    }
}

struct FakeAppHost {
    cfg: Value,
    log: Log,
    home: String,
}

impl DefaultAppHost for FakeAppHost {
    fn run(&mut self, cmd: &str, args: &[String]) -> Result<String, String> {
        self.log.push(vec![
            Value::from("run"),
            Value::from(cmd),
            Value::Array(args.iter().map(|a| short(a)).collect()),
        ]);
        let joined = args.join("\u{1}");
        let hit = field_list(&self.cfg, "script").iter().find(|entry| {
            field_str(entry, "cmd") == Some(cmd)
                && field_str(entry, "includes").is_none_or(|text| joined.contains(text))
                && field_str(entry, "suffix").is_none_or(|text| joined.ends_with(text))
        });
        let Some(hit) = hit else {
            return Err("not scripted".to_string());
        };
        if let Some(message) = field_str(hit, "fail") {
            return Err(message.to_string());
        }
        Ok(field_str(hit, "out").unwrap_or_default().to_string())
    }

    fn open_external(&mut self, url: &str) -> Result<(), String> {
        self.log
            .push(vec![Value::from("openExternal"), Value::from(url)]);
        if field_bool(&self.cfg, "openFails") {
            return Err("no browser".to_string());
        }
        Ok(())
    }

    fn read_file(&mut self, path: &str) -> Result<String, String> {
        if field_bool(&self.cfg, "noReadFile") {
            return read_file_utf8(path);
        }
        let rel = path
            .strip_prefix(&format!("{}/", self.home))
            .unwrap_or(path)
            .to_string();
        self.log
            .push(vec![Value::from("readFile"), Value::from(rel.as_str())]);
        self.cfg
            .get("files")
            .and_then(|files| files.get(&rel))
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "ENOENT".to_string())
    }
}

/// `[cfg, ops]`: ops are `"status"` and `"set"`
fn default_app_call(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("cfg"))?.clone();
    let ops = string_list(args, 1)?;
    let deps = DefaultAppDeps {
        platform: field_str(&cfg, "platform").unwrap_or_default().to_string(),
        packaged: cfg.get("packaged").and_then(Value::as_bool).unwrap_or(true),
        exe_path: field_str(&cfg, "exePath").unwrap_or_default().to_string(),
        registered_app_name: field_str(&cfg, "registeredAppName")
            .unwrap_or("SeuOffice")
            .to_string(),
        home_dir: field_str(&cfg, "home").unwrap_or_default().to_string(),
    };
    let log = Log::default();
    let host = FakeAppHost {
        home: deps.home_dir.clone(),
        cfg,
        log: log.clone(),
    };
    let mut service = create_default_app_service(deps, host);
    let out: Vec<Value> = ops
        .iter()
        .map(|op| {
            let status = if op == "status" {
                service.status()
            } else {
                service.set()
            };
            serde_json::to_value(status).expect("a status prints")
        })
        .collect();
    log.flush_into(cx);
    Ok(Some(Value::Array(out)))
}

// ---- diagram-open-gate ----

struct FakeGateDeps {
    cfg: Value,
    log: Log,
    /// the paths of the Visio checks started, by order
    checks: Vec<String>,
}

impl DiagramOpenGateDeps for FakeGateDeps {
    type Check = usize;

    fn refusal(&mut self, file_path: &str) -> Result<Option<String>, String> {
        self.log
            .push(vec![Value::from("refusal"), Value::from(file_path)]);
        if field_list(&self.cfg, "refusalThrows")
            .iter()
            .any(|p| p.as_str() == Some(file_path))
        {
            return Err("refusal boom".to_string());
        }
        Ok(self
            .cfg
            .get("refusals")
            .and_then(|r| r.get(file_path))
            .and_then(Value::as_str)
            .map(str::to_string))
    }

    fn visio_refusal(&mut self, file_path: &str) -> usize {
        self.log
            .push(vec![Value::from("visioRefusal"), Value::from(file_path)]);
        self.checks.push(file_path.to_string());
        self.checks.len() - 1
    }

    fn open(&mut self, file_path: &str) -> Result<(), String> {
        self.log
            .push(vec![Value::from("open"), Value::from(file_path)]);
        if field_bool(&self.cfg, "openThrows") {
            return Err("open boom".to_string());
        }
        Ok(())
    }

    fn warn(&mut self, message: &str, file_path: &str) -> Result<(), String> {
        self.log.push(vec![
            Value::from("warn"),
            Value::from(message),
            Value::from(file_path),
        ]);
        if field_bool(&self.cfg, "warnThrows") {
            return Err("warn boom".to_string());
        }
        Ok(())
    }
}

/// `[cfg, ops]` (`openDiagramChecked`), `[cfg, ops, path]` (`diagramOpenChecking`)
fn gate_call(args: &[Value], cx: &mut Context, last: bool) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("cfg"))?.clone();
    let ops = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let log = Log::default();
    let mut deps = FakeGateDeps {
        cfg,
        log: log.clone(),
        checks: Vec::new(),
    };
    let mut gate = DiagramOpenGate::new();
    let mut settled: Vec<bool> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for op in ops {
        if let Some(path) = field_str(op, "open") {
            match gate.open_diagram_checked(path, &mut deps) {
                Ok(opened) => {
                    out.push(Value::Bool(opened.opened));
                    if opened.check.is_some() {
                        settled.push(false);
                    }
                }
                Err(message) => {
                    let mut error = Map::new();
                    error.insert("error".into(), Value::from(message));
                    out.push(Value::Object(error));
                }
            }
        } else if let Some(n) = field_f64(op, "settle") {
            let n = n as usize;
            if settled.get(n) == Some(&false) {
                settled[n] = true;
                let path = deps.checks[n].clone();
                let answer = if let Some(message) = field_str(op, "reject") {
                    VisioAnswer::Rejected(message.to_string())
                } else if let Some(text) = field_str(op, "rejectValue") {
                    VisioAnswer::Rejected(text.to_string())
                } else {
                    VisioAnswer::Resolved(field_str(op, "value").map(str::to_string))
                };
                if let Some(message) = gate.finish_visio_check(&path, answer, &mut deps) {
                    log.push(vec![
                        Value::from("[shell] opening a Visio drawing failed:"),
                        Value::from(message),
                    ]);
                }
            }
        } else if let Some(path) = field_str(op, "checking") {
            out.push(Value::Bool(gate.diagram_open_checking(path)));
        }
    }
    log.flush_into(cx);
    if last {
        let path = str_arg(args, 2)?;
        return Ok(Some(Value::Bool(gate.diagram_open_checking(path))));
    }
    Ok(Some(Value::Array(out)))
}

// ---- document-password-prompt ----

struct FakePasswordWindow {
    answers: Rc<RefCell<VecDeque<Option<String>>>>,
    log: Log,
}

impl DocumentPasswordWindow for FakePasswordWindow {
    fn prompt(&mut self, file_name: &str, retry: bool) -> Option<String> {
        self.log.push(vec![
            Value::from("prompt"),
            Value::from(file_name),
            Value::Bool(retry),
        ]);
        self.answers.borrow_mut().pop_front().flatten()
    }

    fn close(&mut self) {
        self.log.push(vec![Value::from("close")]);
    }
}

/// `[answers, ops]`: `{ create }`, `{ ask, retry }`, `{ close }`
fn prompts_call(args: &[Value], cx: &mut Context) -> Answer {
    let answers: VecDeque<Option<String>> = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("answers"))?
        .iter()
        .map(|v| v.as_str().map(str::to_string))
        .collect();
    let ops = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let answers = Rc::new(RefCell::new(answers));
    let log = Log::default();
    let mut queue = DocumentPasswordPrompts::new();
    let mut prompts: Vec<PromptId> = Vec::new();
    let mut asks = Vec::new();
    let mut settled: Vec<Value> = Vec::new();
    let mut done: Vec<usize> = Vec::new();
    let pair = |seq: usize, answer: Option<String>| {
        Value::Array(vec![
            Value::from(seq as u64),
            answer.map_or(Value::Null, Value::from),
        ])
    };
    for op in ops {
        if let Some(name) = field_str(op, "create") {
            let window = FakePasswordWindow {
                answers: answers.clone(),
                log: log.clone(),
            };
            prompts.push(queue.create(Box::new(window), name));
        } else if let Some(i) = field_f64(op, "ask") {
            let retry = field_bool(op, "retry");
            let (ask, outcome) = queue.ask(prompts[i as usize], retry);
            asks.push(ask);
            if let crate::shell::document_password_prompt::Asked::Settled(answer) = outcome {
                done.push(asks.len() - 1);
                settled.push(pair(asks.len() - 1, answer));
            }
        } else if let Some(i) = field_f64(op, "close") {
            for resumed in queue.close(prompts[i as usize]) {
                let seq = asks
                    .iter()
                    .position(|ask| *ask == resumed.ask)
                    .expect("an ask that was made");
                done.push(seq);
                settled.push(pair(seq, resumed.answer));
            }
        }
    }
    log.flush_into(cx);
    let pending: Vec<Value> = (0..asks.len())
        .filter(|seq| !done.contains(seq))
        .map(|seq| Value::from(seq as u64))
        .collect();
    let mut out = Map::new();
    out.insert("settled".into(), Value::Array(settled));
    out.insert("pending".into(), Value::Array(pending));
    Ok(Some(Value::Object(out)))
}

// ---- pdf-convert-ui-handlers ----

struct FakeConvertDeps {
    cfg: Value,
    log: Log,
    /// the Markdown tab of each path
    tabs: Rc<RefCell<Vec<(String, String)>>>,
}

impl PdfConvertUiTabs for FakeConvertDeps {
    fn find_markdown_tab(&mut self, path: &str) -> Option<String> {
        self.log
            .push(vec![Value::from("findMarkdownTab"), Value::from(path)]);
        self.tabs
            .borrow()
            .iter()
            .find(|(held, _)| held == path)
            .map(|(_, id)| id.clone())
    }

    fn activate_view(&mut self, view_id: f64) {
        self.log
            .push(vec![Value::from("activateView"), num(view_id)]);
    }

    fn open_document(&mut self, path: &str) -> bool {
        self.log
            .push(vec![Value::from("openDocument"), Value::from(path)]);
        self.cfg
            .get("openOk")
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }
}

impl PdfConvertUiDeps for FakeConvertDeps {
    fn owns_source(&mut self, view_id: f64, path: &str) -> bool {
        self.log.push(vec![
            Value::from("ownsSource"),
            num(view_id),
            Value::from(path),
        ]);
        field_list(&self.cfg, "owns").iter().any(|pair| {
            pair.get(0).and_then(Value::as_f64) == Some(view_id)
                && pair.get(1).and_then(Value::as_str) == Some(path)
        })
    }

    fn exists(&mut self, path: &str) -> bool {
        self.log
            .push(vec![Value::from("exists"), Value::from(path)]);
        field_list(&self.cfg, "exists")
            .iter()
            .any(|p| p.as_str() == Some(path))
    }

    fn show_in_folder(&mut self, path: &str) {
        self.log
            .push(vec![Value::from("showInFolder"), Value::from(path)]);
    }
}

fn error_value(message: String) -> Value {
    let mut error = Map::new();
    error.insert("error".into(), Value::from(message));
    Value::Object(error)
}

/// `[cfg, steps]`: a step is `[method, viewId, req]`
fn convert_call(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("cfg"))?.clone();
    let steps = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("steps"))?;
    let log = Log::default();
    let tabs: Rc<RefCell<Vec<(String, String)>>> = Rc::new(RefCell::new(
        cfg.get("tabs")
            .and_then(Value::as_object)
            .map(|tabs| {
                tabs.iter()
                    .filter_map(|(path, id)| Some((path.clone(), id.as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default(),
    ));
    let close_fails = field_bool(&cfg, "closeFails");
    let keep_open = field_bool(&cfg, "keepOpen");
    let mut handlers = create_pdf_convert_ui_handlers(FakeConvertDeps {
        cfg,
        log: log.clone(),
        tabs: tabs.clone(),
    });
    let mut out = Vec::new();
    for step in steps {
        let method = step
            .get(0)
            .and_then(Value::as_str)
            .ok_or_else(|| bad("method"))?;
        let view_id = step
            .get(1)
            .and_then(Value::as_f64)
            .ok_or_else(|| bad("view"))?;
        let req = step.get(2).map(json_value_from_serde);
        let req = req.as_ref();
        out.push(match method {
            "releaseTarget" => match handlers.release_target(view_id, req) {
                ReleaseStep::Done(result) => result.map_or_else(error_value, Value::Bool),
                ReleaseStep::CloseTab { tab_id, run } => {
                    // `await deps.closeTab(tabId)` as the spec's fake answers it
                    log.push(vec![Value::from("closeTab"), Value::from(tab_id.as_str())]);
                    let closed = if close_fails {
                        Err("close refused".to_string())
                    } else {
                        if !keep_open {
                            tabs.borrow_mut().retain(|(_, id)| *id != tab_id);
                        }
                        Ok(())
                    };
                    handlers
                        .finish_release_target(run, closed)
                        .map_or_else(error_value, Value::Bool)
                }
            },
            "openResult" => Value::Bool(handlers.open_result(view_id, req)),
            "revealResult" => Value::Bool(handlers.reveal_result(view_id, req)),
            _ => return Err(bad("method")),
        });
    }
    log.flush_into(cx);
    Ok(Some(Value::Array(out)))
}

// ---- pdf-note-tabs ----

/// a fake note tab: `{ name, destroyed }`
struct FakeNoteContents {
    name: String,
    destroyed: bool,
}

impl NoteAppendContents for FakeNoteContents {
    fn is_destroyed(&self) -> bool {
        self.destroyed
    }
}

impl FakeNoteContents {
    fn value(&self) -> Value {
        let mut map = Map::new();
        map.insert("name".into(), Value::from(self.name.as_str()));
        map.insert("destroyed".into(), Value::Bool(self.destroyed));
        Value::Object(map)
    }
}

struct FakeNoteHost<'a> {
    cfg: &'a Value,
    log: Log,
}

impl FakeNoteHost<'_> {
    fn contents(&self, key: &str) -> Option<FakeNoteContents> {
        let spec = field(self.cfg, key)?;
        Some(FakeNoteContents {
            name: field_str(spec, "name").unwrap_or_default().to_string(),
            destroyed: field_bool(spec, "destroyed"),
        })
    }
}

impl NoteTabHost for FakeNoteHost<'_> {
    type Contents = FakeNoteContents;

    fn focus_existing(&mut self, path: &str) -> Option<FakeNoteContents> {
        self.log
            .push(vec![Value::from("focusExisting"), Value::from(path)]);
        self.contents("focus")
    }

    fn open_new(&mut self, path: &str) -> Option<FakeNoteContents> {
        self.log
            .push(vec![Value::from("openNew"), Value::from(path)]);
        self.contents("open")
    }
}

/// `[path, host]`
fn open_note_call(args: &[Value], cx: &mut Context) -> Answer {
    let path = str_arg(args, 0)?;
    let cfg = arg(args, 1).ok_or_else(|| bad("host"))?;
    let log = Log::default();
    let mut host = FakeNoteHost {
        cfg,
        log: log.clone(),
    };
    let opened = open_note_tab(&mut host, path);
    log.flush_into(cx);
    Ok(Some(
        opened.map_or(Value::Null, |contents| contents.value()),
    ))
}

/// `[path, host, text]`
fn insert_note_call(args: &[Value], cx: &mut Context) -> Answer {
    let path = str_arg(args, 0)?;
    let cfg = arg(args, 1).ok_or_else(|| bad("host"))?;
    let text = arg(args, 2).map(json_value_from_serde);
    let log = Log::default();
    let mut host = FakeNoteHost {
        cfg,
        log: log.clone(),
    };
    let queue_log = log.clone();
    let inserted = insert_into_note_tab(
        &mut host,
        path,
        text.as_ref(),
        &mut |contents, path, text| {
            queue_log.push(vec![
                Value::from("queue"),
                Value::from(contents.name.as_str()),
                Value::from(path),
                Value::from(text),
            ]);
        },
    );
    log.flush_into(cx);
    Ok(Some(Value::Bool(inserted)))
}

// ---- document-links ----

/// `seedStore(seed)` of the spec: `{ runs: [{ webContentsId, handedOver, at }], converted:
/// [{ webContentsId, sources, at }] }` put into the hand-off store the way the
/// editors and the shell do
fn seed_store(seed: &Value) -> Result<HandoffStore, CallError> {
    let mut store = HandoffStore::new(cfg!(windows));
    let id = |item: &Value| field_f64(item, "webContentsId").ok_or_else(|| bad("webContentsId"));
    let at = |item: &Value| field_f64(item, "at").ok_or_else(|| bad("at"));
    let paths = |item: &Value, key: &str| -> Result<Vec<String>, CallError> {
        field_list(item, key)
            .iter()
            .map(|p| p.as_str().map(str::to_string).ok_or_else(|| bad(key)))
            .collect()
    };
    for (i, run) in field_list(seed, "runs").iter().enumerate() {
        let (web_contents_id, handed_over) = (id(run)?, paths(run, "handedOver")?);
        store.queue_generate_handoff(
            web_contents_id,
            GenerateHandoff {
                id: format!("h{i}"),
                mode: "ai".to_string(),
                target: GenerateHandoffTarget::Slides,
                materials: handed_over
                    .iter()
                    .map(|path| Material {
                        path: path.clone(),
                        name: jscompat::node_path::host::basename(path, None),
                    })
                    .collect(),
                text: "t".to_string(),
                default_text: false,
                created_at: 0.0,
            },
        );
        store.take_generate_handoff(GenerateHandoffTarget::Slides, web_contents_id);
        store
            .report_generate_run_started(
                GenerateHandoffTarget::Slides,
                web_contents_id,
                &handed_over,
                at(run)?,
            )
            .map_err(CallError::plain)?;
    }
    for (i, made) in field_list(seed, "converted").iter().enumerate() {
        store
            .record_generate_converted(
                id(made)?,
                GenerateConvertTarget::Markdown,
                GenerateConvertKind::MindmapToMarkdown,
                &paths(made, "sources")?,
                &format!("c{i}"),
                at(made)?,
            )
            .map_err(CallError::plain)?;
    }
    Ok(store)
}

fn make_event_value(event: &MakeEvent) -> Value {
    let mut map = Map::new();
    map.insert("webContentsId".into(), num(event.web_contents_id));
    map.insert(
        "mode".into(),
        serde_json::to_value(event.mode).expect("a mode prints"),
    );
    map.insert(
        "sources".into(),
        Value::Array(
            event
                .sources
                .iter()
                .map(|s| s.as_deref().map_or(Value::Null, Value::from))
                .collect(),
        ),
    );
    map.insert("at".into(), num(event.at));
    Value::Object(map)
}

/// `[seed]`
fn handoff_events_call(args: &[Value]) -> Answer {
    let store = seed_store(arg(args, 0).ok_or_else(|| bad("seed"))?)?;
    let events = handoff_store_events(&store);
    Ok(Some(Value::Array(
        events.iter().map(make_event_value).collect(),
    )))
}

/// `[tabs, ops]`: ops are `{ record: id }` and `"flush"`
fn watch_call(args: &[Value], cx: &mut Context) -> Answer {
    let tabs = arg(args, 0)
        .and_then(Value::as_object)
        .ok_or_else(|| bad("tabs"))?
        .clone();
    let ops = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let log = Log::default();
    let (id_log, event_log) = (log.clone(), log.clone());
    let mut store = HandoffStore::new(cfg!(windows));
    let mut watch = watch_make_events(
        &mut store,
        Box::new(move |id| {
            id_log.push(vec![Value::from("tabIdFor"), num(id)]);
            tabs.get(&number_to_string(id))
                .and_then(Value::as_str)
                .map(str::to_string)
        }),
        Box::new(move || event_log.push(vec![Value::from("onEvent")])),
    );
    let mut seen = Vec::new();
    for op in ops {
        if op.as_str() == Some("flush") {
            watch.flush();
        } else {
            let id = field_f64(op, "record").ok_or_else(|| bad("record"))?;
            let made = store
                .record_generate_converted(
                    id,
                    GenerateConvertTarget::Markdown,
                    GenerateConvertKind::MindmapToMarkdown,
                    &[],
                    "c",
                    cx.now_ms,
                )
                .map_err(CallError::plain)?;
            seen.push(made.tab_id.map_or(Value::Null, Value::from));
        }
    }
    watch.flush();
    log.flush_into(cx);
    Ok(Some(Value::Array(seen)))
}

/// `[path, nowMs, stat]`: `stat` is `null` for `statSync`, `{ throws: true }`, or `{ birthtimeMs, mtimeMs }`
fn fresh_call(args: &[Value], cx: &mut Context) -> Answer {
    let path = str_arg(args, 0)?;
    let now_ms = arg(args, 1)
        .and_then(Value::as_f64)
        .ok_or_else(|| bad("nowMs"))?;
    let log = Log::default();
    let cfg = arg(args, 2).filter(|v| !v.is_null()).cloned();
    let fresh = match cfg {
        None => is_freshly_saved_path(path, now_ms, &mut stat_sync),
        Some(cfg) => is_freshly_saved_path(path, now_ms, &mut |path| {
            log.push(vec![Value::from("stat"), Value::from(path)]);
            if field_bool(&cfg, "throws") {
                return Err("ENOENT".to_string());
            }
            Ok(StatTimes {
                // `null` is falsy in `s.birthtimeMs || s.mtimeMs`
                birthtime_ms: field_f64(&cfg, "birthtimeMs").unwrap_or(0.0),
                mtime_ms: field_f64(&cfg, "mtimeMs").unwrap_or(0.0),
            })
        }),
    };
    log.flush_into(cx);
    Ok(Some(Value::Bool(fresh)))
}

fn via_of(text: &str) -> Result<DocumentLinkVia, CallError> {
    match text {
        "ai" => Ok(DocumentLinkVia::Ai),
        "convert" => Ok(DocumentLinkVia::Convert),
        _ => Err(bad("via")),
    }
}

fn link_of(value: &Value) -> Result<DocumentLink, CallError> {
    let text = |key: &str| {
        field_str(value, key)
            .map(str::to_string)
            .ok_or_else(|| bad(key))
    };
    Ok(DocumentLink {
        derived: text("derived")?,
        sources: field_list(value, "sources")
            .iter()
            .map(|s| s.as_str().map(str::to_string).ok_or_else(|| bad("sources")))
            .collect::<Result<_, _>>()?,
        created_at: text("createdAt")?,
        via: via_of(&text("via")?)?,
    })
}

fn event_of(value: &Value) -> Result<MakeEvent, CallError> {
    Ok(MakeEvent {
        web_contents_id: field_f64(value, "webContentsId").ok_or_else(|| bad("webContentsId"))?,
        mode: via_of(field_str(value, "mode").ok_or_else(|| bad("mode"))?)?,
        sources: field_list(value, "sources")
            .iter()
            .map(|s| s.as_str().map(str::to_string))
            .collect(),
        at: field_f64(value, "at").ok_or_else(|| bad("at"))?,
    })
}

/// the events and the clock of a `DocumentLinks` that ops can replace
struct LinksState {
    events: Vec<MakeEvent>,
    now: f64,
}

struct FakeLinksDeps {
    log: Log,
    links: Vec<DocumentLink>,
    state: Rc<RefCell<LinksState>>,
    save_throws: bool,
}

impl DocumentLinksDeps for FakeLinksDeps {
    fn load(&mut self) -> Vec<DocumentLink> {
        self.log.push(vec![Value::from("load")]);
        self.links.clone()
    }

    fn save(&mut self, file: &DocumentLinksFile) -> Result<(), String> {
        self.log.push(vec![
            Value::from("save"),
            serde_json::to_value(file).expect("a file prints"),
        ]);
        if self.save_throws {
            return Err("disk full".to_string());
        }
        Ok(())
    }

    fn events(&mut self) -> Vec<MakeEvent> {
        self.log.push(vec![Value::from("events")]);
        self.state.borrow().events.clone()
    }

    fn now_ms(&mut self) -> f64 {
        self.log.push(vec![Value::from("now")]);
        self.state.borrow().now
    }

    fn warn(&mut self, message: &str, error: &str) {
        self.log
            .push(vec![Value::from(message), Value::from(error)]);
    }
}

/// the `webContents` of a `noteTabPath` op: `once('destroyed')` is logged and remembered
struct FakeLinkContents {
    id: f64,
    log: Log,
    registered: Rc<RefCell<Vec<f64>>>,
}

impl LinkedWebContents for FakeLinkContents {
    fn id(&self) -> f64 {
        self.id
    }

    fn once_destroyed(&mut self) {
        self.log.push(vec![
            Value::from("once"),
            num(self.id),
            Value::from("destroyed"),
        ]);
        self.registered.borrow_mut().push(self.id);
    }
}

fn path_list(paths: Vec<String>) -> Value {
    Value::Array(paths.into_iter().map(Value::from).collect())
}

/// the ops both link specs run
fn run_link_ops<D: DocumentLinksDeps>(
    links: &mut DocumentLinks<D>,
    ops: &[Value],
    log: &Log,
    state: Option<&Rc<RefCell<LinksState>>>,
) -> Result<Vec<Value>, CallError> {
    let registered = Rc::new(RefCell::new(Vec::<f64>::new()));
    let mut listeners: Vec<(String, ListenerId)> = Vec::new();
    let mut out = Vec::new();
    for op in ops {
        let result = if let Some(note) = op.get("note").filter(|n| !n.is_null()) {
            let id = note
                .get(0)
                .and_then(Value::as_f64)
                .ok_or_else(|| bad("id"))?;
            let path = note
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| bad("path"))?;
            // `options?.fresh ?? true`
            let fresh = match note.get(2).and_then(|options| options.get("fresh")) {
                None | Some(Value::Null) => None,
                Some(value) => Some(json_value_from_serde(value).truthy()),
            };
            let mut contents = FakeLinkContents {
                id,
                log: log.clone(),
                registered: registered.clone(),
            };
            match links.note_tab_path(&mut contents, path, fresh) {
                Ok(()) => Value::Null,
                Err(e) => error_value(e.to_string()),
            }
        } else if field_bool(op, "sync") {
            match links.sync() {
                Ok(changed) => Value::Bool(changed),
                Err(e) => error_value(e.to_string()),
            }
        } else if let Some(moved) = op.get("moved").filter(|m| !m.is_null()) {
            let old = moved
                .get(0)
                .and_then(Value::as_str)
                .ok_or_else(|| bad("old"))?;
            let new = moved
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| bad("new"))?;
            links.file_moved(old, new);
            Value::Null
        } else if let Some(path) = field_str(op, "sourcesOf") {
            path_list(links.sources_of(path))
        } else if let Some(path) = field_str(op, "derivedFrom") {
            path_list(links.derived_from(path))
        } else if field_bool(op, "paths") {
            path_list(links.paths())
        } else if field_bool(op, "links") {
            serde_json::to_value(links.links()).expect("links print")
        } else if field_bool(op, "version") {
            Value::from(links.version())
        } else if let Some(id) = field_f64(op, "destroy") {
            let mut held = registered.borrow_mut();
            if let Some(at) = held.iter().rposition(|known| *known == id) {
                held.remove(at);
                links.tab_destroyed(id);
            }
            Value::Null
        } else if let Some(name) = field_str(op, "listen") {
            let log = log.clone();
            let label = name.to_string();
            let id = links.on_change(Box::new(move || {
                log.push(vec![Value::from("change"), Value::from(label.as_str())]);
            }));
            listeners.retain(|(held, _)| held != name);
            listeners.push((name.to_string(), id));
            Value::Null
        } else if let Some(name) = field_str(op, "unlisten") {
            if let Some((_, id)) = listeners.iter().find(|(held, _)| held == name) {
                links.off_change(*id);
            }
            Value::Null
        } else if let Some(events) = op.get("setEvents").filter(|e| !e.is_null()) {
            if let Some(state) = state {
                state.borrow_mut().events = events
                    .as_array()
                    .ok_or_else(|| bad("events"))?
                    .iter()
                    .map(event_of)
                    .collect::<Result<_, _>>()?;
            }
            Value::Null
        } else if let Some(now) = field_f64(op, "setNow") {
            if let Some(state) = state {
                state.borrow_mut().now = now;
            }
            Value::Null
        } else {
            continue;
        };
        out.push(result);
    }
    Ok(out)
}

/// `[cfg, ops]`: cfg is `{ links, events, now, saveThrows }`
fn links_call(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("cfg"))?;
    let ops = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let log = Log::default();
    let state = Rc::new(RefCell::new(LinksState {
        events: field_list(cfg, "events")
            .iter()
            .map(event_of)
            .collect::<Result<_, _>>()?,
        now: field_f64(cfg, "now").unwrap_or(cx.now_ms),
    }));
    let mut links = DocumentLinks::new(FakeLinksDeps {
        log: log.clone(),
        links: field_list(cfg, "links")
            .iter()
            .map(link_of)
            .collect::<Result<_, _>>()?,
        state: state.clone(),
        save_throws: field_bool(cfg, "saveThrows"),
    });
    let out = run_link_ops(&mut links, ops, &log, Some(&state));
    log.flush_into(cx);
    Ok(Some(Value::Array(out?)))
}

/// `[path, seed, ops]`
fn links_at_call(args: &[Value], cx: &mut Context) -> Answer {
    let path = str_arg(args, 0)?;
    let store = seed_store(arg(args, 1).ok_or_else(|| bad("seed"))?)?;
    let ops = arg(args, 2)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let now = cx.now_ms;
    let log = Log::default();
    let warn_log = log.clone();
    let mut links = document_links_at(
        path,
        Box::new(move || handoff_store_events(&store)),
        Box::new(move || now),
        Box::new(move |message, error| {
            warn_log.push(vec![Value::from(message), Value::from(mask_tmp(error))]);
        }),
    );
    let out = run_link_ops(&mut links, ops, &log, None);
    log.flush_into(cx);
    Ok(Some(Value::Array(out?)))
}

/// `[filePath | null, { sources, derived }, existing]`
fn menu_model_call(args: &[Value], cx: &mut Context) -> Answer {
    struct Lookup<'a> {
        spec: &'a Value,
        log: Log,
    }
    impl Lookup<'_> {
        fn paths(&self, key: &str, path: &str) -> Vec<String> {
            self.spec
                .get(key)
                .and_then(|table| table.get(path))
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|p| p.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        }
    }
    impl LinkLookup for Lookup<'_> {
        fn sources_of(&mut self, path: &str) -> Vec<String> {
            self.log
                .push(vec![Value::from("sourcesOf"), Value::from(path)]);
            self.paths("sources", path)
        }

        fn derived_from(&mut self, path: &str) -> Vec<String> {
            self.log
                .push(vec![Value::from("derivedFrom"), Value::from(path)]);
            self.paths("derived", path)
        }
    }
    let file_path = match arg(args, 0) {
        None | Some(Value::Null) => None,
        Some(Value::String(path)) => Some(path.as_str()),
        Some(_) => return Err(bad("filePath")),
    };
    let spec = arg(args, 1).ok_or_else(|| bad("links"))?;
    let existing = string_list(args, 2)?;
    let log = Log::default();
    let mut lookup = Lookup {
        spec,
        log: log.clone(),
    };
    let exists_log = log.clone();
    let model = document_link_menu_model(file_path, &mut lookup, &mut |path| {
        exists_log.push(vec![Value::from("exists"), Value::from(path)]);
        existing.iter().any(|p| p == path)
    });
    log.flush_into(cx);
    Ok(Some(serde_json::to_value(model).expect("a model prints")))
}

fn menu_entries(value: Option<&Value>) -> Result<Vec<LinkMenuEntry>, CallError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| bad("entries"))?
        .iter()
        .map(|entry| {
            let text = |key: &str| {
                field_str(entry, key)
                    .map(str::to_string)
                    .ok_or_else(|| bad(key))
            };
            Ok(LinkMenuEntry {
                path: text("path")?,
                name: text("name")?,
                missing: field_bool(entry, "missing"),
            })
        })
        .collect()
}

/// `[model, labels, isMac]`
fn menu_items_call(args: &[Value], cx: &mut Context) -> Answer {
    struct Handlers(Log);
    impl DocumentLinkMenuHandlers for Handlers {
        fn on_make(&mut self) {
            self.0.push(vec![Value::from("make")]);
        }

        fn on_open(&mut self, path: &str) {
            self.0.push(vec![Value::from("open"), Value::from(path)]);
        }
    }
    let model = arg(args, 0).ok_or_else(|| bad("model"))?;
    let labels = arg(args, 1).ok_or_else(|| bad("labels"))?;
    let is_mac = arg(args, 2)
        .and_then(Value::as_bool)
        .ok_or_else(|| bad("isMac"))?;
    let model = DocumentLinkMenuModel {
        sources: menu_entries(model.get("sources"))?,
        derived: menu_entries(model.get("derived"))?,
    };
    let label = |key: &str| {
        field_str(labels, key)
            .map(str::to_string)
            .ok_or_else(|| bad(key))
    };
    let labels = DocumentLinkMenuLabels {
        make: label("make")?,
        sources: label("sources")?,
        derived: label("derived")?,
    };
    let items = document_link_menu_items(&model, &labels, is_mac);
    let log = Log::default();
    MenuItem::run_clicks(&items, &mut Handlers(log.clone()));
    log.flush_into(cx);
    Ok(Some(serde_json::to_value(&items).expect("items print")))
}

// ---- launch-recovery ----

fn text(x: &str) -> Value {
    Value::from(x)
}

fn opt_text(x: Option<&str>) -> Value {
    x.map_or(Value::Null, Value::from)
}

/// an identity as the spec writes it: `{ kind, filePath }` or `{ kind, untitledId, ext }`
fn identity_in(v: &Value) -> RecoveryIdentity {
    let kind = field_str(v, "kind").unwrap_or_default().to_owned();
    // `'filePath' in identity`
    if v.get("filePath").is_some() {
        RecoveryIdentity::File(RecoveryFileIdentity {
            kind,
            file_path: field_str(v, "filePath").unwrap_or_default().to_owned(),
        })
    } else {
        RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
            kind,
            untitled_id: field_str(v, "untitledId").unwrap_or_default().to_owned(),
            ext: field_str(v, "ext").unwrap_or_default().to_owned(),
        })
    }
}

fn identity_value(identity: &RecoveryIdentity) -> Value {
    let mut o = Map::new();
    match identity {
        RecoveryIdentity::File(f) => {
            o.insert("kind".to_owned(), text(&f.kind));
            o.insert("filePath".to_owned(), text(&f.file_path));
        }
        RecoveryIdentity::Untitled(u) => {
            o.insert("kind".to_owned(), text(&u.kind));
            o.insert("untitledId".to_owned(), text(&u.untitled_id));
            o.insert("ext".to_owned(), text(&u.ext));
        }
    }
    Value::Object(o)
}

fn copy_in(v: &Value) -> LaunchCopy {
    LaunchCopy {
        identity: identity_in(v.get("identity").unwrap_or(&Value::Null)),
        kind: field_str(v, "kind").unwrap_or_default().to_owned(),
        file_path: field_str(v, "filePath").map(str::to_owned),
        untitled_id: field_str(v, "untitledId").map(str::to_owned),
        title: field_str(v, "title").unwrap_or_default().to_owned(),
        written_at: field_f64(v, "writtenAt").unwrap_or(0.0),
        state: field_str(v, "state")
            .and_then(RecoveryCopyState::parse)
            .unwrap_or(RecoveryCopyState::Undecided),
        file_changed_after_copy: field_bool(v, "fileChangedAfterCopy"),
        original_missing: field_bool(v, "originalMissing"),
        original_path: field_str(v, "originalPath").map(str::to_owned),
    }
}

fn copy_value(copy: &LaunchCopy) -> Value {
    let mut o = Map::new();
    o.insert("identity".to_owned(), identity_value(&copy.identity));
    o.insert("kind".to_owned(), text(&copy.kind));
    o.insert("filePath".to_owned(), opt_text(copy.file_path.as_deref()));
    o.insert(
        "untitledId".to_owned(),
        opt_text(copy.untitled_id.as_deref()),
    );
    o.insert("title".to_owned(), text(&copy.title));
    o.insert("writtenAt".to_owned(), num(copy.written_at));
    o.insert("state".to_owned(), text(copy.state.as_str()));
    o.insert(
        "fileChangedAfterCopy".to_owned(),
        Value::Bool(copy.file_changed_after_copy),
    );
    o.insert(
        "originalMissing".to_owned(),
        Value::Bool(copy.original_missing),
    );
    o.insert(
        "originalPath".to_owned(),
        opt_text(copy.original_path.as_deref()),
    );
    Value::Object(o)
}

/// a launch list row as `RecoveryListItem` writes it
pub(super) fn list_item_value(item: &RecoveryListItem) -> Value {
    let mut o = Map::new();
    o.insert("id".to_owned(), text(&item.id));
    o.insert("editorKind".to_owned(), text(&item.editor_kind));
    o.insert("name".to_owned(), text(&item.name));
    o.insert("folder".to_owned(), opt_text(item.folder.as_deref()));
    o.insert("lastCopyTime".to_owned(), num(item.last_copy_time));
    o.insert("untitled".to_owned(), Value::Bool(item.untitled));
    o.insert(
        "fileChangedAfterCopy".to_owned(),
        Value::Bool(item.file_changed_after_copy),
    );
    o.insert(
        "originalMissing".to_owned(),
        Value::Bool(item.original_missing),
    );
    Value::Object(o)
}

fn list_item_in(v: &Value) -> RecoveryListItem {
    RecoveryListItem {
        id: field_str(v, "id").unwrap_or_default().to_owned(),
        editor_kind: field_str(v, "editorKind").unwrap_or_default().to_owned(),
        name: field_str(v, "name").unwrap_or_default().to_owned(),
        folder: field_str(v, "folder").map(str::to_owned),
        last_copy_time: field_f64(v, "lastCopyTime").unwrap_or(0.0),
        untitled: field_bool(v, "untitled"),
        file_changed_after_copy: field_bool(v, "fileChangedAfterCopy"),
        original_missing: field_bool(v, "originalMissing"),
    }
}

fn planned_tab_value(tab: &PlannedTab) -> Value {
    let mut o = Map::new();
    o.insert("key".to_owned(), text(&tab.key));
    o.insert("kind".to_owned(), text(&tab.kind));
    o.insert("title".to_owned(), text(&tab.title));
    if let Some(path) = &tab.file_path {
        o.insert("filePath".to_owned(), text(path));
    }
    let mut open = Map::new();
    match &tab.open {
        PlannedOpen::File => {
            open.insert("type".to_owned(), text("file"));
        }
        PlannedOpen::UntitledCopy {
            copy,
            save_as_default_path,
        } => {
            open.insert("type".to_owned(), text("untitledCopy"));
            open.insert("copy".to_owned(), identity_value(copy));
            if let Some(path) = save_as_default_path {
                open.insert("saveAsDefaultPath".to_owned(), text(path));
            }
        }
    }
    o.insert("open".to_owned(), Value::Object(open));
    Value::Object(o)
}

fn planned_tab_in(v: &Value) -> PlannedTab {
    let open = v.get("open").unwrap_or(&Value::Null);
    PlannedTab {
        key: field_str(v, "key").unwrap_or_default().to_owned(),
        kind: field_str(v, "kind").unwrap_or_default().to_owned(),
        title: field_str(v, "title").unwrap_or_default().to_owned(),
        file_path: field_str(v, "filePath").map(str::to_owned),
        open: if field_str(open, "type") == Some("untitledCopy") {
            PlannedOpen::UntitledCopy {
                copy: identity_in(open.get("copy").unwrap_or(&Value::Null)),
                save_as_default_path: field_str(open, "saveAsDefaultPath").map(str::to_owned),
            }
        } else {
            PlannedOpen::File
        },
    }
}

fn split_value(split: &PlannedSplit) -> Value {
    let mut o = Map::new();
    o.insert("a".to_owned(), text(&split.a));
    o.insert("b".to_owned(), text(&split.b));
    o.insert("orientation".to_owned(), text(&split.orientation));
    o.insert("ratio".to_owned(), num(split.ratio));
    o.insert("focus".to_owned(), text(&split.focus));
    Value::Object(o)
}

fn split_in(v: &Value) -> PlannedSplit {
    PlannedSplit {
        a: field_str(v, "a").unwrap_or_default().to_owned(),
        b: field_str(v, "b").unwrap_or_default().to_owned(),
        orientation: field_str(v, "orientation").unwrap_or_default().to_owned(),
        ratio: field_f64(v, "ratio").unwrap_or(f64::NAN),
        focus: field_str(v, "focus").unwrap_or_default().to_owned(),
    }
}

fn string_items(v: &Value, key: &str) -> Vec<String> {
    field_list(v, key)
        .iter()
        .filter_map(|p| p.as_str().map(str::to_owned))
        .collect()
}

fn plan_value(plan: &LaunchPlan) -> Value {
    let mut o = Map::new();
    o.insert("restoreRun".to_owned(), Value::Bool(plan.restore_run));
    o.insert("crashLoop".to_owned(), Value::Bool(plan.crash_loop));
    o.insert("plainLaunch".to_owned(), Value::Bool(plan.plain_launch));
    o.insert(
        "tabs".to_owned(),
        Value::Array(plan.tabs.iter().map(planned_tab_value).collect()),
    );
    if let Some(front) = &plan.front {
        o.insert("front".to_owned(), text(front));
    }
    if let Some(split) = &plan.split {
        o.insert("split".to_owned(), split_value(split));
    }
    o.insert(
        "items".to_owned(),
        Value::Array(plan.items.iter().map(list_item_value).collect()),
    );
    o.insert(
        "copies".to_owned(),
        Value::Array(
            plan.copies
                .iter()
                .map(|(id, copy)| Value::Array(vec![text(id), copy_value(copy)]))
                .collect(),
        ),
    );
    o.insert(
        "launchPaths".to_owned(),
        Value::Array(plan.launch_paths.iter().map(|p| text(p)).collect()),
    );
    Value::Object(o)
}

fn plan_in(v: &Value) -> LaunchPlan {
    LaunchPlan {
        restore_run: field_bool(v, "restoreRun"),
        crash_loop: field_bool(v, "crashLoop"),
        plain_launch: field_bool(v, "plainLaunch"),
        tabs: field_list(v, "tabs").iter().map(planned_tab_in).collect(),
        front: field_str(v, "front").map(str::to_owned),
        split: field(v, "split").map(split_in),
        items: field_list(v, "items").iter().map(list_item_in).collect(),
        copies: field_list(v, "copies")
            .iter()
            .map(|pair| {
                let pair = pair.as_array().map_or(&[][..], Vec::as_slice);
                (
                    pair.first()
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    copy_in(pair.get(1).unwrap_or(&Value::Null)),
                )
            })
            .collect(),
        launch_paths: string_items(v, "launchPaths"),
    }
}

fn outcome_value(outcome: &LaunchOutcome) -> Value {
    let mut o = Map::new();
    o.insert(
        "storeDecisions".to_owned(),
        Value::Array(
            outcome
                .store_decisions
                .iter()
                .map(|(identity, decision)| {
                    let mut d = Map::new();
                    d.insert("identity".to_owned(), identity_value(identity));
                    d.insert(
                        "decision".to_owned(),
                        text(match decision {
                            RecoveryLaunchDecision::Restore => "restore",
                            RecoveryLaunchDecision::Discard => "discard",
                            RecoveryLaunchDecision::Later => "later",
                        }),
                    );
                    Value::Object(d)
                })
                .collect(),
        ),
    );
    o.insert(
        "remove".to_owned(),
        Value::Array(outcome.remove.iter().map(|k| text(k)).collect()),
    );
    o.insert(
        "replace".to_owned(),
        Value::Array(outcome.replace.iter().map(planned_tab_value).collect()),
    );
    o.insert(
        "append".to_owned(),
        Value::Array(outcome.append.iter().map(planned_tab_value).collect()),
    );
    if let Some(front) = &outcome.front {
        o.insert("front".to_owned(), text(front));
    }
    if let Some(split) = &outcome.split {
        o.insert("split".to_owned(), split_value(split));
    }
    o.insert(
        "launchPaths".to_owned(),
        Value::Array(outcome.launch_paths.iter().map(|p| text(p)).collect()),
    );
    o.insert(
        "splitMemoryOrHome".to_owned(),
        Value::Bool(outcome.split_memory_or_home),
    );
    Value::Object(o)
}

/// the launch list's answer as the spec writes it: `{ dismissed: true }` or `{ decisions }`
fn list_result_in(v: &Value) -> RecoveryListResult {
    if v.get("dismissed").is_some() {
        return RecoveryListResult::Dismissed;
    }
    let mut decisions: JsObject<RecoveryChoice> = JsObject::new();
    if let Some(Value::Object(map)) = v.get("decisions") {
        for (id, choice) in map {
            decisions.set(
                id.clone(),
                if choice.as_str() == Some("restore") {
                    RecoveryChoice::Restore
                } else {
                    RecoveryChoice::Discard
                },
            );
        }
    }
    RecoveryListResult::Decisions(decisions)
}

fn list_result_value(result: &RecoveryListResult) -> Value {
    let mut o = Map::new();
    match result {
        RecoveryListResult::Dismissed => {
            o.insert("dismissed".to_owned(), Value::Bool(true));
        }
        RecoveryListResult::Decisions(decisions) => {
            let mut map = Map::new();
            for (id, choice) in decisions.entries() {
                map.insert(
                    id.to_owned(),
                    text(match choice {
                        RecoveryChoice::Restore => "restore",
                        RecoveryChoice::Discard => "discard",
                    }),
                );
            }
            o.insert("decisions".to_owned(), Value::Object(map));
        }
    }
    Value::Object(o)
}

fn filter_value(filter: &RecoveryCopyFilter) -> Value {
    let mut o = Map::new();
    if let Some(states) = &filter.states {
        o.insert(
            "states".to_owned(),
            Value::Array(states.iter().map(|s| text(s.as_str())).collect()),
        );
    }
    if let Some(untitled) = filter.untitled {
        o.insert("untitled".to_owned(), Value::Bool(untitled));
    }
    Value::Object(o)
}

/// `copies.listCopies` of the spec: each call answers the next list, or throws
struct ListedCopies<'a> {
    lists: &'a [Value],
    at: Cell<usize>,
    log: &'a Log,
}

impl LaunchCopySource for ListedCopies<'_> {
    fn list_copies(&self, filter: &RecoveryCopyFilter) -> Result<Vec<LaunchCopy>, Failure> {
        self.log
            .push(vec![text("listCopies"), filter_value(filter)]);
        let at = self.at.get();
        self.at.set(at + 1);
        match self.lists.get(at) {
            Some(Value::String(s)) if s == "throws" => Err(Failure("listCopies failed".to_owned())),
            Some(list) => Ok(list
                .as_array()
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .map(copy_in)
                .collect()),
            None => Ok(Vec::new()),
        }
    }
}

fn launch_plan_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("scenario"))?;
    let judgment = spec.get("judgment").unwrap_or(&Value::Null);
    let judgment = LaunchJudgment {
        abnormal: field_bool(judgment, "abnormal"),
        crash_loop: field_bool(judgment, "crashLoop"),
    };
    let previous = spec.get("previous").unwrap_or(&Value::Null);
    let previous = match field_str(previous, "status") {
        Some("ok") => SessionRecordReadResult::Ok(
            parse_session_record(&json_value_from_serde(
                previous.get("record").unwrap_or(&Value::Null),
            ))
            .ok_or_else(|| bad("a session record"))?,
        ),
        Some("corrupt") => SessionRecordReadResult::Corrupt,
        _ => SessionRecordReadResult::Missing,
    };
    let log = Log::default();
    let source = ListedCopies {
        lists: field_list(spec, "lists"),
        at: Cell::new(0),
        log: &log,
    };
    let planned = plan_launch(
        &judgment,
        &previous,
        &source,
        &string_items(spec, "launchPaths"),
    );
    log.flush_into(cx);
    planned
        .map(|plan| Some(plan_value(&plan)))
        .map_err(|Failure(message)| CallError::plain(message))
}

fn launch_resolve_call(args: &[Value]) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("scenario"))?;
    let plan = plan_in(spec.get("plan").unwrap_or(&Value::Null));
    let result = field(spec, "result").map(list_result_in);
    Ok(Some(outcome_value(&resolve_launch_decisions(
        &plan,
        result.as_ref(),
    ))))
}

fn launch_normalize_call(args: &[Value]) -> Answer {
    let raw = json_value_from_serde(arg(args, 0).unwrap_or(&Value::Null));
    let ids = string_list(args, 1)?;
    normalize_launch_list_result(&raw, &ids)
        .map(|result| Some(list_result_value(&result)))
        .map_err(|Failure(message)| CallError::plain(message))
}

/// a row the gate scenario publishes: `gateItem(id, name)`
fn gate_row(index: usize) -> RecoveryListItem {
    RecoveryListItem {
        id: format!("r{index}"),
        editor_kind: "docs".to_owned(),
        name: format!("Row {index}"),
        folder: None,
        last_copy_time: 1000.0,
        untitled: true,
        file_changed_after_copy: false,
        original_missing: false,
    }
}

fn rows_value(rows: Option<Vec<RecoveryListItem>>) -> Value {
    rows.map_or(Value::Null, |rows| {
        Value::Array(rows.iter().map(list_item_value).collect())
    })
}

fn rejected(message: &str) -> Value {
    let mut o = Map::new();
    o.insert("rejected".to_owned(), text(message));
    Value::Object(o)
}

/// how the `apply` of the published rows behaves
#[derive(Clone)]
struct GateApply {
    mode: String,
    blocking: bool,
    reenter: Option<Value>,
}

/// an `async` apply that has not settled: the call that started it and the calls that joined it
struct PendingApply {
    slot: usize,
    joined: Vec<usize>,
}

struct GateRun {
    gate: LaunchListGate,
    slots: Vec<Value>,
    waiting: Vec<usize>,
    apply: Option<GateApply>,
    pending: Option<PendingApply>,
    /// the answer of the apply's own `reenter` is being sent
    reentering: bool,
    log: Log,
}

impl GateRun {
    /// the waiters a `settle` woke read the rows
    fn wake(&mut self, woken: usize) {
        let waiting = std::mem::take(&mut self.waiting);
        debug_assert_eq!(waiting.len(), woken);
        for slot in waiting {
            self.slots[slot] = rows_value(self.gate.current());
        }
    }

    fn submit(&mut self, raw: &JsonValue, slot: usize) {
        match self.gate.submit(raw) {
            GateSubmit::Resolved => self.slots[slot] = text("resolved"),
            GateSubmit::Joined => {
                if let Some(pending) = self.pending.as_mut() {
                    pending.joined.push(slot);
                }
            }
            GateSubmit::Rejected(message) => self.slots[slot] = rejected(&message),
            GateSubmit::Apply(result) => self.run_apply(&result, slot),
        }
    }

    fn run_apply(&mut self, result: &RecoveryListResult, slot: usize) {
        let Some(apply) = self.apply.clone() else {
            return;
        };
        self.log
            .push(vec![text("apply"), list_result_value(result)]);
        if apply.blocking {
            self.log.push(vec![
                text("blocking in apply"),
                Value::Bool(self.gate.blocking()),
            ]);
        }
        // an answer sent from inside the apply; a gate that lets it start another
        // apply would send it again from inside that one, so it is sent once
        if let Some(raw) = &apply.reenter
            && !self.reentering
        {
            self.reentering = true;
            let again = self.slots.len();
            self.slots.push(text("pending"));
            self.submit(&json_value_from_serde(raw), again);
            self.reentering = false;
        }
        match apply.mode.as_str() {
            "throws" => {
                // the throw runs the `finally` before `applying` is assigned
                let woken = self.gate.apply_finished(false);
                self.gate.applying_started();
                self.wake(woken);
                self.slots[slot] = rejected("apply threw");
            }
            "rejects" => {
                self.gate.applying_started();
                let woken = self.gate.apply_finished(false);
                self.wake(woken);
                self.slots[slot] = rejected("apply rejected");
            }
            "async" => {
                self.gate.applying_started();
                self.pending = Some(PendingApply {
                    slot,
                    joined: Vec::new(),
                });
            }
            _ => {
                self.gate.applying_started();
                let woken = self.gate.apply_finished(true);
                self.wake(woken);
                self.slots[slot] = text("resolved");
            }
        }
    }

    fn finish(&mut self, ok: bool) {
        let Some(pending) = self.pending.take() else {
            return;
        };
        let woken = self.gate.apply_finished(ok);
        self.wake(woken);
        let outcome = if ok {
            text("resolved")
        } else {
            rejected("apply failed later")
        };
        self.slots[pending.slot] = outcome.clone();
        for joined in pending.joined {
            self.slots[joined] = outcome.clone();
        }
    }
}

fn launch_gate_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("scenario"))?;
    let mut run = GateRun {
        gate: LaunchListGate::new(),
        slots: Vec::new(),
        waiting: Vec::new(),
        apply: None,
        pending: None,
        reentering: false,
        log: Log::default(),
    };
    for step in field_list(spec, "steps") {
        let slot = run.slots.len();
        if step.get("get").is_some() {
            run.slots.push(text("pending"));
            match run.gate.get() {
                GateGet::Waiting => run.waiting.push(slot),
                GateGet::Ready(rows) => run.slots[slot] = rows_value(rows),
            }
        } else if let Some(count) = field_f64(step, "publish") {
            let rows: Vec<RecoveryListItem> = (0..count as usize).map(gate_row).collect();
            let was_open = run.gate.current().is_none();
            let woken = run.gate.publish(rows);
            // only the publish that took effect keeps its `apply`
            if was_open && run.gate.current().is_some() {
                run.apply = Some(GateApply {
                    mode: field_str(step, "apply").unwrap_or("sync").to_owned(),
                    blocking: field_bool(step, "blocking"),
                    reenter: field(step, "reenter").cloned(),
                });
            }
            run.wake(woken);
        } else if step.get("publishNone").is_some() {
            let woken = run.gate.publish_none();
            run.wake(woken);
        } else if let Some(raw) = step.get("submit") {
            run.slots.push(text("pending"));
            run.submit(&json_value_from_serde(raw), slot);
        } else if let Some(how) = field_str(step, "finish") {
            run.finish(how == "resolve");
        } else {
            let mut o = Map::new();
            o.insert("blocking".to_owned(), Value::Bool(run.gate.blocking()));
            run.slots.push(Value::Object(o));
        }
    }
    run.log.flush_into(cx);
    Ok(Some(Value::Array(run.slots)))
}

struct OsHost<'a> {
    spec: &'a Value,
    log: Log,
    /// the editors whose write has not settled
    pending: HashSet<usize>,
    timer_armed: bool,
}

impl OsSessionEndDeps for OsHost<'_> {
    fn mark_shutting_down(&mut self) -> Result<(), Failure> {
        self.log.push(vec![text("markShuttingDown")]);
        if field_str(self.spec, "latch") == Some("throws") {
            return Err(Failure("latch failed".to_owned()));
        }
        Ok(())
    }
    fn mark_session_os_end(&mut self) -> Result<(), Failure> {
        self.log.push(vec![text("markSessionOsEnd")]);
        if field_str(self.spec, "closeRecord") == Some("throws") {
            return Err(Failure("record failed".to_owned()));
        }
        Ok(())
    }
    fn editors(&mut self) -> Result<usize, Failure> {
        self.log.push(vec![text("editors")]);
        if field_str(self.spec, "editors") == Some("throws") {
            return Err(Failure("editors failed".to_owned()));
        }
        Ok(field_list(self.spec, "editors").len())
    }
    fn write_copies_now(&mut self, index: usize) -> WriteState {
        self.log
            .push(vec![text("writeCopiesNow"), Value::from(index)]);
        match field_list(self.spec, "editors")
            .get(index)
            .and_then(Value::as_str)
        {
            Some("throws") => WriteState::Settled(Err(Failure(format!("write {index} threw")))),
            Some("rejects") => WriteState::Settled(Err(Failure(format!("write {index} rejected")))),
            Some("pending") => {
                self.pending.insert(index);
                WriteState::Pending
            }
            _ => WriteState::Settled(Ok(())),
        }
    }
    fn finish(&mut self) {
        self.log.push(vec![text("finish")]);
    }
    fn timeout_ms(&self) -> Option<f64> {
        field_f64(self.spec, "timeoutMs")
    }
    fn warn(&mut self, prefix: &str, detail: &str) {
        self.log.push(vec![text(prefix), text(detail)]);
    }
    fn set_timeout(&mut self, ms: f64) {
        self.log.push(vec![text("setTimeout"), num(ms)]);
        self.timer_armed = true;
    }
    fn clear_timeout(&mut self) {
        self.log.push(vec![text("clearTimeout")]);
    }
}

fn os_end_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("scenario"))?;
    let mut host = OsHost {
        spec,
        log: Log::default(),
        pending: HashSet::new(),
        timer_armed: false,
    };
    let mut end = OsSessionEnd::new();
    let mut calls = 0usize;
    for step in field_list(spec, "steps") {
        if step.get("call").is_some() {
            calls += 1;
            end.run(&mut host);
        } else if let Some(settle) = step.get("settle") {
            let editor = field_f64(settle, "editor").unwrap_or(-1.0) as usize;
            if host.pending.remove(&editor) {
                let result = if field_str(settle, "result") == Some("ok") {
                    Ok(())
                } else {
                    Err(Failure(format!("write {editor} failed later")))
                };
                end.write_settled(&mut host, result);
            }
        } else if host.timer_armed {
            host.timer_armed = false;
            end.timer_fired(&mut host);
        }
    }
    host.log.flush_into(cx);
    let state = text(if end.is_finished() {
        "resolved"
    } else {
        "pending"
    });
    Ok(Some(Value::Array(vec![state; calls])))
}

fn untitled_value(copy: &SessionUntitledCopy) -> Value {
    let mut o = Map::new();
    o.insert("untitledId".to_owned(), text(&copy.untitled_id));
    o.insert("ext".to_owned(), text(&copy.ext));
    Value::Object(o)
}

fn live_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("scenario"))?;
    let strip = field(spec, "strip").map(json_value_from_serde);
    let detached: Vec<JsonValue> = field_list(spec, "detached")
        .iter()
        .map(json_value_from_serde)
        .collect();
    let answers = spec.get("untitled").unwrap_or(&Value::Null);
    let log = Log::default();
    let source = live_session_source(strip.as_ref(), &detached, &mut |tab| {
        let shown = json_value_to_serde(tab);
        let id = field_str(&shown, "id").map(str::to_owned);
        let title = field_str(&shown, "title").map(str::to_owned);
        log.push(vec![text("untitledOf"), shown]);
        // `o.untitledByTitle?.[tab.title] ?? o.untitled[tab.id]`
        let by_title = title
            .as_deref()
            .and_then(|title| spec.get("untitledByTitle").and_then(|m| field(m, title)));
        let answer = match by_title {
            Some(answer) => answer,
            None => field(answers, id.as_deref()?)?,
        };
        Some(SessionUntitledCopy {
            untitled_id: field_str(answer, "untitledId")?.to_owned(),
            ext: field_str(answer, "ext")?.to_owned(),
        })
    });
    log.flush_into(cx);
    let mut shown = Map::new();
    shown.insert(
        "strip".to_owned(),
        source
            .strip
            .as_ref()
            .map_or(Value::Null, json_value_to_serde),
    );
    shown.insert(
        "detached".to_owned(),
        Value::Array(source.detached.iter().map(json_value_to_serde).collect()),
    );
    let copies: Vec<Value> = string_items(spec, "probes")
        .iter()
        .map(|id| {
            source
                .untitled_copy_for(id)
                .map_or(Value::Null, untitled_value)
        })
        .collect();
    let mut answer = Map::new();
    answer.insert("source".to_owned(), Value::Object(shown));
    answer.insert("copies".to_owned(), Value::Array(copies));
    Ok(Some(Value::Object(answer)))
}

struct TabLookup<'a> {
    spec: &'a Value,
    log: &'a Log,
}

impl LiveTabContentsDeps<String> for TabLookup<'_> {
    fn detached(&mut self, tab_id: &str) -> Option<String> {
        self.log.push(vec![text("detached"), text(tab_id)]);
        field_str(self.spec, "detached").map(str::to_owned)
    }
    fn title_of(&mut self, tab_id: &str) -> Option<String> {
        self.log.push(vec![text("titleOf"), text(tab_id)]);
        field_str(self.spec, "title").map(str::to_owned)
    }
}

/// what the caller does for `await deps.ensureLoaded(tabId)`
fn carry_out_ensure_loaded(
    spec: &Value,
    log: &Log,
    tab_id: &str,
) -> Result<EnsureLoaded<String>, Failure> {
    log.push(vec![text("ensureLoaded"), text(tab_id)]);
    match field_str(spec, "ensure") {
        Some("rejects") => Err(Failure("load failed".to_owned())),
        Some("ready") => Ok(EnsureLoaded::Ready(format!("contents of {tab_id}"))),
        Some("needs-user") => Ok(EnsureLoaded::NeedsUser),
        _ => Ok(EnsureLoaded::Missing),
    }
}

fn tab_contents_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("scenario"))?;
    let log = Log::default();
    let mut deps = TabLookup { spec, log: &log };
    let (lookup, mut step) =
        LiveTabLookup::begin::<String>(field_str(spec, "tabId").unwrap_or_default());
    let found = loop {
        match step {
            LiveTabStep::EnsureLoaded(tab_id) => {
                let answer = carry_out_ensure_loaded(spec, &log, &tab_id);
                step = lookup.resume(&mut deps, answer);
            }
            LiveTabStep::Done(result) => break result,
        }
    };
    log.flush_into(cx);
    found
        .map(|contents| contents.map(Value::from))
        .map_err(|Failure(message)| CallError::plain(message))
}
