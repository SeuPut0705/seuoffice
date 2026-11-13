//! `apps/shell/src/main/mcp/app-mcp.ts`: main-process wiring for the MCP
//! server.
//!
//! Owns the single service instance, reads the enable/port settings, and
//! exposes the small surface the shell's IPC handlers and lifecycle hooks
//! need. Deps are injected ([`McpRuntime::configure_mcp_runtime`]) so this
//! module never imports `index.ts` back.
//!
//! The TypeScript's module variables (`deps`, `service`, `logger`,
//! `currentSettings`) are the fields of an [`McpRuntime`] the caller owns. The
//! service is the sans-IO [`McpServerService`]; the promises of `start` and
//! `stop` are steps the caller drives:
//!
//! - every method that awaits the service ([`McpRuntime::start_mcp_from_settings`],
//!   [`McpRuntime::apply_mcp_settings`], [`McpRuntime::stop_mcp`]) answers an
//!   [`OpId`] and the [`McpStep`] that call produced; the promise is settled
//!   when an [`McpStep::settled`] of this or a later step lists the id;
//! - the commands the service issues come back in [`McpStep::commands`] for the
//!   caller to carry out (the listener, the sockets, the responses, the
//!   timers). The service's own methods are reached through
//!   [`McpRuntime::service_mut`]; what they return goes through
//!   [`McpRuntime::route`], which writes the `Log` lines to the logger
//!   (`mcpLogger`, on only while the `logging` setting is) and turns the
//!   `StartSettled` / `StopSettled` commands into the promises they settle;
//! - `McpServerService.stop()` of a restart is awaited before the next one is
//!   made: the restart continues from the `StopSettled` command.
//!
//! `buildTools` runs once per client session (the service's tools factory);
//! it reads the runtime's deps and settings at that moment, as the TypeScript
//! reads its module variables.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use jscompat::JsonValue;

use super::cli_runner::CliRunner;
use super::mcp_logger::{LogClock, McpLogger};
use super::mcp_server::{
    DEFAULT_MCP_PORT, McpHost, McpServerService, McpServerServiceOptions, McpToolDefinition,
};
use super::tools::diagram_tools::{DiagramToolsDeps, create_diagram_tools};
use super::tools::document_tools::{
    DefaultSaveDir, DocToolDeps, create_document_tools, document_driver,
};
use super::tools::hwp_tools::{HwpTextReader, create_hwp_tools};
use super::tools::open_documents_tools::{OpenDocumentsDeps, create_open_document_tools};
use super::tools::pdf_tools::{PdfTextReader, create_pdf_tools};
use super::tools::session_tools::{
    FamilyDriver, create_session_host, create_session_tools, js_object,
};
use super::tools::sheets_tools::{SheetsToolDeps, create_sheets_tools, sheets_driver};
use super::tools::slides_tools::{SlidesToolDeps, create_slides_tools, slides_driver};
use crate::packages::i18n::PRODUCT_NAME;
use crate::packages::mcp_sdk::server::{Command, StartError, StartId, StopId};

/// `McpRuntimeDeps`
pub struct McpRuntimeDeps<'h> {
    /// app version reported by get_app_info
    pub version: String,
    /// default folder for generated files
    pub default_save_dir: DefaultSaveDir<'h>,
    /// open a file in the UI (routed to the matching tab)
    pub open_path: Rc<dyn Fn(&str) -> bool + 'h>,
    /// drive a visible docs editor (live document session); absent in headless runs
    pub docs_control: bool,
    /// drive a visible slides deck (main-process session); absent in headless runs
    pub slides_control: bool,
    /// drive a visible sheets grid (renderer workbook session); absent in headless runs
    pub sheets_control: bool,
    /// the bundled seuoffice CLI, backing the headless create/read tools; absent when unavailable
    pub cli_runner: Option<Rc<dyn CliRunner + 'h>>,
    /// documents the user has open (list/read/close); absent in headless runs,
    /// where there is no tab manager to ask
    pub open_documents_control: bool,
    /// resolves a `document` argument (tab id or path) to the webContents of
    /// that open tab; absent in headless runs, which drops the argument from
    /// the tool schemas
    pub resolve_target: bool,
    /// open diagram tabs for read_diagram / apply_diagram_ops; absent in
    /// headless runs, where the two tools answer that the app is not running
    pub diagram_control: bool,
    /// `diagramControl.isDetached`: absent in a control without it
    pub diagram_is_detached: Option<Rc<dyn Fn(&str) -> bool + 'h>>,
    /// where the MCP log file lives (userData); logging is unavailable without it
    pub log_file_path: Option<String>,
    /// the PDF engine behind `read_pdf` (`readPdfText` of the pdf workspace)
    pub pdf_reader: Rc<dyn PdfTextReader + 'h>,
    /// the HWP engine behind `read_hwp` (`hwpToText` of file-parse)
    pub hwp_reader: Rc<dyn HwpTextReader + 'h>,
}

/// what the runtime asks of the world: the service's clock and ids, and the
/// logger's clock
pub trait McpRuntimeHost {
    /// the [`McpHost`] of a service `ensureService` makes
    fn new_service_host(&self) -> Box<dyn McpHost>;
    /// the clock of the `McpLogger` `configureMcpRuntime` makes
    fn new_log_clock(&self) -> Box<dyn LogClock>;
}

/// `McpSettings`
#[derive(Debug, Clone, PartialEq)]
pub struct McpSettings {
    pub enabled: bool,
    pub port: f64,
    /// headless create_docx (no UI) is exposed to clients; default off
    pub background: bool,
    /// server/tool activity is written to the log file; default off
    pub logging: bool,
}

/// `McpStatus`
#[derive(Debug, Clone, PartialEq)]
pub struct McpStatus {
    pub running: bool,
    pub enabled: bool,
    pub port: f64,
    pub background: bool,
    pub logging: bool,
    pub url: Option<String>,
    /// capability families the current build exposes (settings pane rows)
    pub capabilities: Vec<String>,
}

impl McpStatus {
    /// the status as the settings pane receives it
    pub fn to_json(&self) -> JsonValue {
        js_object(vec![
            ("running", JsonValue::Bool(self.running)),
            ("enabled", JsonValue::Bool(self.enabled)),
            ("port", JsonValue::Number(self.port)),
            ("background", JsonValue::Bool(self.background)),
            ("logging", JsonValue::Bool(self.logging)),
            (
                "url",
                match &self.url {
                    Some(url) => JsonValue::String(url.clone()),
                    None => JsonValue::Null,
                },
            ),
            (
                "capabilities",
                JsonValue::Array(
                    self.capabilities
                        .iter()
                        .map(|name| JsonValue::String(name.clone()))
                        .collect(),
                ),
            ),
        ])
    }
}

/// a promise of the runtime
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpId(pub u32);

/// what a promise of the runtime resolves with
#[derive(Debug, Clone, PartialEq)]
pub enum McpResolved {
    /// `undefined` (`startMcpFromSettings`, `stopMcp`)
    Undefined,
    /// the status (`applyMcpSettings`)
    Status(McpStatus),
}

/// how a promise settled: its value, or the message of what it rejects with
pub type McpSettled = Result<McpResolved, String>;

/// what one call of the runtime did
#[derive(Debug, Default)]
pub struct McpStep {
    /// what the service asks the caller to carry out, in order
    pub commands: Vec<Command>,
    /// the promises this step settled
    pub settled: Vec<(OpId, McpSettled)>,
}

/// a promise waiting for the service
enum Pending {
    /// `await service.start(..)`; resolves with the status or `undefined`
    Start {
        op: OpId,
        start: StartId,
        status: bool,
    },
    /// `await service?.stop()`; resolves with the status or `undefined`
    Stop {
        op: OpId,
        stop: StopId,
        status: bool,
    },
    /// the restart of `applyMcpSettings`: `await service?.stop(); service =
    /// null; await ensureService().start(port)`
    Restart { op: OpId, stop: StopId, port: f64 },
}

/// the module variables the tools factory reads at each client session
struct Shared<'h> {
    deps: Option<Rc<McpRuntimeDeps<'h>>>,
    settings: McpSettings,
}

/// the module state of `app-mcp.ts`
pub struct McpRuntime<'h> {
    host: Box<dyn McpRuntimeHost + 'h>,
    shared: Rc<RefCell<Shared<'h>>>,
    service: Option<McpServerService<'h>>,
    logger: Option<McpLogger>,
    pending: Vec<Pending>,
    next_op: u32,
}

const NOT_CONFIGURED: &str = "MCP runtime not configured";

/// `normalize(settings)`: `Err` is the TypeError of reading the settings of
/// `undefined` or `null`
pub fn normalize(settings: Option<&JsonValue>) -> Result<McpSettings, String> {
    let settings = match settings {
        None => return Err("Cannot read properties of undefined (reading 'port')".to_owned()),
        Some(JsonValue::Null) => {
            return Err("Cannot read properties of null (reading 'port')".to_owned());
        }
        Some(settings) => settings,
    };
    let port = match settings.get("port").as_deref() {
        Some(JsonValue::Number(port))
            if port.is_finite() && port.fract() == 0.0 && *port > 0.0 && *port < 65536.0 =>
        {
            *port
        }
        _ => DEFAULT_MCP_PORT,
    };
    let flag = |key: &str| settings.get(key).as_deref() == Some(&JsonValue::Bool(true));
    Ok(McpSettings {
        enabled: flag("enabled"),
        port,
        background: flag("background"),
        logging: flag("logging"),
    })
}

/// `buildTools()`: the tool set of one client session. `Err` is the message of
/// what it throws.
fn build_tools<'h>(shared: &Shared<'h>) -> Result<Vec<McpToolDefinition<'h>>, String> {
    let Some(deps) = shared.deps.clone() else {
        return Err(NOT_CONFIGURED.to_owned());
    };
    let background = shared.settings.background;
    // get_app_info advertises what the registered tool families can generate
    let mut extra_formats = Vec::new();
    if deps.slides_control {
        extra_formats.push("pptx".to_owned());
    }
    if deps.sheets_control {
        extra_formats.push("xlsx".to_owned());
    }
    // one session host per tool set: create_session / save_session drive whichever
    // family is active, and each family's content tools address that same tab.
    // buildTools runs once per client session (see the server's toolsFactory), so
    // each connected client gets its own active session rather than sharing one.
    let host = create_session_host();
    // the families that have a driver, in the order of the TypeScript
    let mut drivers: Vec<Rc<dyn FamilyDriver + 'h>> = Vec::new();
    if deps.docs_control {
        drivers.push(document_driver());
    }
    if deps.slides_control {
        drivers.push(slides_driver());
    }
    if deps.sheets_control {
        drivers.push(sheets_driver());
    }
    let mut tools = Vec::new();
    // the session entry point first: an agent picking a tool sees create_session
    tools.extend(create_session_tools(&drivers, Rc::clone(&host)));
    let open_deps = Rc::clone(&deps);
    tools.extend(create_document_tools(
        Rc::new(DocToolDeps {
            version: deps.version.clone(),
            default_save_dir: Rc::clone(&deps.default_save_dir),
            // headless create_docx is opt-in: off by default so the default surface is
            // the visible document session
            background: Some(background),
            // open_in_seuoffice reports ok only when the file routed to a tab
            open_in_tab: Some(Rc::new(move |file_path: &str| {
                if (open_deps.open_path)(file_path) {
                    Ok(())
                } else {
                    Err(format!("could not open {file_path} in {PRODUCT_NAME}"))
                }
            })),
            docs: deps.docs_control,
            extra_formats: Some(extra_formats),
            cli: deps.cli_runner.clone(),
            resolve_target: deps.resolve_target,
        }),
        Rc::clone(&host),
    ));
    tools.extend(create_slides_tools(
        Rc::new(SlidesToolDeps {
            default_save_dir: Rc::clone(&deps.default_save_dir),
            background: Some(background),
            slides: deps.slides_control,
            cli: deps.cli_runner.clone(),
            resolve_target: deps.resolve_target,
        }),
        Rc::clone(&host),
    ));
    tools.extend(create_sheets_tools(
        Rc::new(SheetsToolDeps {
            default_save_dir: Rc::clone(&deps.default_save_dir),
            background: Some(background),
            sheets: deps.sheets_control,
            cli: deps.cli_runner.clone(),
            resolve_target: deps.resolve_target,
        }),
        host,
    ));
    // headless, session-free read access (read_pdf); registered whenever the
    // pdf workspace is bundled in, which the shell always does
    tools.extend(create_pdf_tools(Rc::clone(&deps.pdf_reader)));
    // the same for Hangul documents (read_hwp)
    tools.extend(create_hwp_tools(Rc::clone(&deps.hwp_reader)));
    // documents the user has open, independent of the session above
    tools.extend(create_open_document_tools(OpenDocumentsDeps {
        control: deps.open_documents_control,
        default_save_dir: Rc::clone(&deps.default_save_dir),
    }));
    // open diagrams: read a page, apply ops as one undo step (no session family)
    tools.extend(create_diagram_tools(DiagramToolsDeps {
        control: deps.diagram_control,
        is_detached: deps.diagram_is_detached.clone(),
    })?);
    Ok(tools)
}

impl<'h> McpRuntime<'h> {
    pub fn new(host: Box<dyn McpRuntimeHost + 'h>) -> Self {
        McpRuntime {
            host,
            shared: Rc::new(RefCell::new(Shared {
                deps: None,
                settings: McpSettings {
                    enabled: false,
                    port: DEFAULT_MCP_PORT,
                    background: false,
                    logging: false,
                },
            })),
            service: None,
            logger: None,
            pending: Vec::new(),
            next_op: 0,
        }
    }

    /// the service, for the caller to drive (`on_request`, `on_timer`,
    /// `on_listening` ..); what it returns goes through [`McpRuntime::route`]
    pub fn service_mut(&mut self) -> Option<&mut McpServerService<'h>> {
        self.service.as_mut()
    }

    /// `currentMcpRuntimeDeps()`: the configured runtime; agent sessions build
    /// their own server from the same controls (decision 0032)
    pub fn current_mcp_runtime_deps(&self) -> Option<Rc<McpRuntimeDeps<'h>>> {
        self.shared.borrow().deps.clone()
    }

    /// `configureMcpRuntime(runtimeDeps)`
    pub fn configure_mcp_runtime(&mut self, runtime_deps: McpRuntimeDeps<'h>) {
        self.logger = match runtime_deps.log_file_path.as_deref() {
            Some(path) if !path.is_empty() => Some(McpLogger::new(path, self.host.new_log_clock())),
            _ => None,
        };
        self.shared.borrow_mut().deps = Some(Rc::new(runtime_deps));
    }

    /// `mcpLogger(message)`: drops a line into the log ring + file when
    /// logging is on; no-op otherwise
    fn mcp_logger(&mut self, message: &str) {
        if !self.shared.borrow().settings.logging {
            return;
        }
        if let Some(logger) = self.logger.as_mut() {
            logger.append(message);
        }
    }

    /// `mcpLogFilePath()`: the configured log file path, when logging is
    /// available at all
    pub fn mcp_log_file_path(&self) -> Option<String> {
        self.shared
            .borrow()
            .deps
            .as_ref()
            .and_then(|deps| deps.log_file_path.clone())
    }

    /// `getMcpRecentLogs()`: recent log lines for the settings pane
    pub fn get_mcp_recent_logs(&self) -> Vec<String> {
        match &self.logger {
            Some(logger) => logger.recent(None),
            None => Vec::new(),
        }
    }

    /// `clearMcpLogs()`
    pub fn clear_mcp_logs(&mut self) {
        if let Some(logger) = self.logger.as_mut() {
            logger.clear();
        }
    }

    /// `revealMcpLogFile()`: reveal the log file in the file manager; creates
    /// it when missing (the reveal itself is the caller's)
    pub fn reveal_mcp_log_file(&self) {
        if let Some(logger) = &self.logger {
            logger.ensure_file();
        }
    }

    /// `buildTools()`, as the service's tools factory runs it
    pub fn build_tools(&self) -> Result<Vec<McpToolDefinition<'h>>, String> {
        build_tools(&self.shared.borrow())
    }

    /// `ensureService()`: `Err` is the message of what it throws
    fn ensure_service(&mut self) -> Result<(), String> {
        let Some(deps) = self.shared.borrow().deps.clone() else {
            return Err(NOT_CONFIGURED.to_owned());
        };
        if self.service.is_none() {
            let shared = Rc::clone(&self.shared);
            let port = self.shared.borrow().settings.port;
            self.service = Some(McpServerService::new(
                McpServerServiceOptions {
                    port,
                    tools: None,
                    // built per client session so concurrent clients do not share one
                    // active editing session; the factory re-reads settings at connect time
                    tools_factory: Some(Box::new(move || {
                        // `deps` is set for as long as a service exists, and the
                        // diagram schemas of DIAGRAM_OPS do not conflict
                        build_tools(&shared.borrow()).expect("the tool set of a configured runtime")
                    })),
                    server_factory: None,
                    version: Some(deps.version.clone()),
                    max_listen_attempts: None,
                    listen_retry_delay_ms: None,
                    token: None,
                },
                self.host.new_service_host(),
            ));
        }
        Ok(())
    }

    fn new_op(&mut self) -> OpId {
        let op = OpId(self.next_op);
        self.next_op += 1;
        op
    }

    /// a promise that settled at once
    fn immediate(&mut self, settled: McpSettled) -> (OpId, McpStep) {
        let op = self.new_op();
        (
            op,
            McpStep {
                commands: Vec::new(),
                settled: vec![(op, settled)],
            },
        )
    }

    /// `await ensureService().start(port)` up to the point it waits
    fn begin_start(&mut self, op: OpId, port: f64, status: bool) -> McpStep {
        if let Err(message) = self.ensure_service() {
            return McpStep {
                commands: Vec::new(),
                settled: vec![(op, Err(message))],
            };
        }
        let service = self.service.as_mut().expect("ensured");
        let (start, commands) = service.start(Some(port));
        self.pending.push(Pending::Start { op, start, status });
        self.route(commands)
    }

    /// `await service?.stop()` up to the point it waits
    fn begin_stop(&mut self, op: OpId, status: bool) -> McpStep {
        if self.service.is_none() {
            let resolved = if status {
                McpResolved::Status(self.mcp_status())
            } else {
                McpResolved::Undefined
            };
            return McpStep {
                commands: Vec::new(),
                settled: vec![(op, Ok(resolved))],
            };
        }
        let service = self.service.as_mut().expect("checked");
        let (stop, commands) = service.stop();
        self.pending.push(Pending::Stop { op, stop, status });
        self.route(commands)
    }

    /// `startMcpFromSettings(settings)`: start the server if settings say it
    /// should be on. Safe to call at boot.
    pub fn start_mcp_from_settings(&mut self, settings: Option<&JsonValue>) -> (OpId, McpStep) {
        let next = match normalize(settings) {
            Ok(next) => next,
            Err(message) => return self.immediate(Err(message)),
        };
        let (enabled, port) = (next.enabled, next.port);
        self.shared.borrow_mut().settings = next;
        if !enabled {
            return self.immediate(Ok(McpResolved::Undefined));
        }
        let op = self.new_op();
        let step = self.begin_start(op, port, false);
        (op, step)
    }

    /// `applyMcpSettings(settings)`: apply a settings change. Persist
    /// semantics are the caller's job (index.ts writes app-settings.json);
    /// here the running server is reconciled with the new values: start, stop,
    /// or restart when the port or the exposed tool set changes.
    pub fn apply_mcp_settings(&mut self, settings: Option<&JsonValue>) -> (OpId, McpStep) {
        let next = match normalize(settings) {
            Ok(next) => next,
            Err(message) => return self.immediate(Err(message)),
        };
        let was_running = self
            .service
            .as_ref()
            .is_some_and(McpServerService::is_running);
        // both comparisons read the OLD settings: they must happen before currentSettings is overwritten
        let (port_changed, background_changed) = {
            let current = &self.shared.borrow().settings;
            (
                next.port != current.port,
                next.background != current.background,
            )
        };
        let (enabled, port) = (next.enabled, next.port);
        self.shared.borrow_mut().settings = next;

        if !enabled {
            let op = self.new_op();
            let step = self.begin_stop(op, true);
            return (op, step);
        }
        // a background flip changes the exposed tool list, so live sessions must be
        // dropped and rebuilt: same treatment as a port change
        if !was_running {
            let op = self.new_op();
            let step = self.begin_start(op, port, true);
            (op, step)
        } else if port_changed || background_changed {
            let op = self.new_op();
            let service = self.service.as_mut().expect("it was running");
            let (stop, commands) = service.stop();
            self.pending.push(Pending::Restart { op, stop, port });
            let step = self.route(commands);
            (op, step)
        } else {
            let status = self.mcp_status();
            self.immediate(Ok(McpResolved::Status(status)))
        }
    }

    /// `stopMcp()`
    pub fn stop_mcp(&mut self) -> (OpId, McpStep) {
        let op = self.new_op();
        let step = self.begin_stop(op, false);
        (op, step)
    }

    /// `stopMcpSync()`
    pub fn stop_mcp_sync(&mut self) -> McpStep {
        let Some(service) = self.service.as_mut() else {
            return McpStep::default();
        };
        let (_, commands) = service.stop();
        self.route(commands)
    }

    /// `mcpStatus()`
    pub fn mcp_status(&self) -> McpStatus {
        let shared = self.shared.borrow();
        let running = self
            .service
            .as_ref()
            .is_some_and(McpServerService::is_running);
        let deps = shared.deps.as_ref();
        let mut capabilities = vec!["docs".to_owned()];
        if deps.is_some_and(|deps| deps.slides_control) {
            capabilities.push("slides".to_owned());
        }
        if deps.is_some_and(|deps| deps.sheets_control) {
            capabilities.push("sheets".to_owned());
        }
        // read_pdf is headless and always registered, so the family is always
        // visible (read-only until the pdf editor is driven)
        capabilities.push("pdf".to_owned());
        // read_hwp likewise
        capabilities.push("hwp".to_owned());
        McpStatus {
            running,
            enabled: shared.settings.enabled,
            port: shared.settings.port,
            background: shared.settings.background,
            logging: shared.settings.logging,
            url: match (&self.service, running) {
                (Some(service), true) => Some(service.get_url()),
                _ => None,
            },
            capabilities,
        }
    }

    /// what the service returned, as steps: the logger lines are written, the
    /// settling of a `start` or a `stop` advances the promise waiting for it,
    /// and the rest is for the caller to carry out
    pub fn route(&mut self, commands: Vec<Command>) -> McpStep {
        let mut step = McpStep::default();
        let mut queue: VecDeque<Command> = commands.into();
        while let Some(command) = queue.pop_front() {
            match command {
                Command::Log(line) => self.mcp_logger(&line),
                Command::StartSettled { start, outcome } => {
                    self.on_start_settled(start, outcome, &mut step);
                }
                Command::StopSettled { stop } => self.on_stop_settled(stop, &mut step),
                other => step.commands.push(other),
            }
        }
        step
    }

    fn on_start_settled(
        &mut self,
        start: StartId,
        outcome: Result<(), StartError>,
        step: &mut McpStep,
    ) {
        let Some(at) = self.pending.iter().position(
            |pending| matches!(pending, Pending::Start { start: id, .. } if *id == start),
        ) else {
            return;
        };
        let Pending::Start { op, status, .. } = self.pending.remove(at) else {
            return;
        };
        let settled = match outcome {
            Ok(()) if status => Ok(McpResolved::Status(self.mcp_status())),
            Ok(()) => Ok(McpResolved::Undefined),
            Err(error) => Err(error.text),
        };
        step.settled.push((op, settled));
    }

    fn on_stop_settled(&mut self, stop: StopId, step: &mut McpStep) {
        let Some(at) = self.pending.iter().position(|pending| match pending {
            Pending::Stop { stop: id, .. } | Pending::Restart { stop: id, .. } => *id == stop,
            Pending::Start { .. } => false,
        }) else {
            return;
        };
        match self.pending.remove(at) {
            Pending::Stop { op, status, .. } => {
                let resolved = if status {
                    McpResolved::Status(self.mcp_status())
                } else {
                    McpResolved::Undefined
                };
                step.settled.push((op, Ok(resolved)));
            }
            Pending::Restart { op, port, .. } => {
                self.service = None;
                let started = self.begin_start(op, port, true);
                step.settled.extend(started.settled);
                step.commands.extend(started.commands);
            }
            Pending::Start { .. } => {}
        }
    }
}
