//! Batch M's printing (host/print.rs): the hidden windows the print handlers
//! load a document into ([`window`]), the printer list ([`printers`]) and the
//! printing tools they run ([`run_command`]).
//!
//! CEF has no `webContents.print` with options. The shell prints two ways:
//!
//! - **a silent job** (a `deviceName`): the page goes to PDF through the
//!   DevTools protocol and the PDF to the printer: `lp` on macOS and Linux,
//!   the GDI loop of [`windows`] on Windows;
//! - **the system dialog**: Chrome's print preview over the window. CEF does
//!   not say whether the user printed or cancelled, so the job answers
//!   success; a stage 3 difference of the shell contract.

#[cfg(any(windows, test))]
mod windows;

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use main_core::packages::electron_utils::print_cups::{CupsPrintJob, DriverOption, DuplexMode};
use main_core::packages::electron_utils::print_window::{ExecOutcome, PrintReport};
use main_core::packages::electron_utils::printer_options::CommandOutcome;
use serde_json::{Value, json};
use shell_contract::runtime::Thread;
use shell_contract::value::IpcValue;
use shell_ipc_m::hosts::{PrintProfile, PrintSurface, PrintWindowSpec, Printer};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_runtime_cef::{WebviewCefExt, WebviewWindowBuilderCefExt};

use super::contents::{cdp, cdp_bytes, forget_webview, pdf_params};
use super::{HostContext, on_ui};
use crate::views::ViewTable;

/// Electron's `loadFile` resolved when the page loaded; a page that never
/// does is a failure, not a hang
const LOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// The longest a print preview may stay open before the window is let go
const PREVIEW_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const PREVIEW_POLL: Duration = Duration::from_millis(300);

/// The flag a page's `afterprint` sets: the print preview closed
const AFTERPRINT_FLAG: &str = "__seuofficeAfterPrint";

pub fn install(_hosts: &mut shell_contract::Hosts, _cx: &HostContext) {
    // the print host is part of `MHostRef`, which host/menu.rs inserts
}

// ---- printers ----

/// `webContents.getPrintersAsync()` as `{ name, displayName }`
pub(crate) fn printers() -> Vec<Printer> {
    #[cfg(windows)]
    {
        windows::printers()
            .map(|list| {
                list.into_iter()
                    .map(|(name, display_name, _)| Printer { name, display_name })
                    .collect()
            })
            .unwrap_or_else(|error| {
                eprintln!("shell: printers: {error}");
                Vec::new()
            })
    }
    #[cfg(not(windows))]
    {
        cups_printers()
    }
}

/// The CUPS destinations (`lpstat -e`), each with its `printer-info` as the
/// display name, which is what Chromium showed on macOS and Linux
#[cfg(not(windows))]
fn cups_printers() -> Vec<Printer> {
    let CommandOutcome::Exited {
        code: Some(0),
        stdout,
        ..
    } = run_command("/usr/bin/lpstat", &["-e".into()], None)
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&stdout)
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| {
            let info = match run_command("/usr/bin/lpoptions", &["-p".into(), name.into()], None) {
                CommandOutcome::Exited {
                    code: Some(0),
                    stdout,
                    ..
                } => printer_info(&String::from_utf8_lossy(&stdout)),
                _ => None,
            };
            Printer {
                name: name.to_owned(),
                display_name: info.unwrap_or_else(|| name.to_owned()),
            }
        })
        .collect()
}

/// `printer-info` of `lpoptions -p <name>`: `key=value` pairs, a value with
/// spaces quoted with `'`
fn printer_info(options: &str) -> Option<String> {
    let start = options.find("printer-info=")? + "printer-info=".len();
    let rest = &options[start..];
    let value = if let Some(quoted) = rest.strip_prefix('\'') {
        quoted.split('\'').next()?
    } else {
        rest.split_whitespace().next()?
    };
    Some(value.to_owned()).filter(|v| !v.is_empty())
}

// ---- commands ----

/// `execFile`/`spawn` of a printing tool, `stdin` written then closed
pub(crate) fn run_command(file: &str, args: &[String], stdin: Option<&[u8]>) -> CommandOutcome {
    let mut command = Command::new(file);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return CommandOutcome::Failed(format!("spawn {file} {error}")),
    };
    if let (Some(bytes), Some(mut pipe)) = (stdin, child.stdin.take()) {
        use std::io::Write;
        // a tool that exits early closes the pipe: its exit code tells why
        let _ = pipe.write_all(bytes);
    }
    match child.wait_with_output() {
        Ok(output) => CommandOutcome::Exited {
            code: output.status.code(),
            stdout: output.stdout,
            stderr: output.stderr,
        },
        Err(error) => CommandOutcome::Failed(error.to_string()),
    }
}

// ---- print windows ----

/// `new BrowserWindow({ show: false, ... })` for printing. The window is made
/// when the first page loads into it.
pub(crate) fn window(
    app: AppHandle,
    ui: Arc<dyn Thread>,
    views: Arc<ViewTable>,
    spec: PrintWindowSpec,
) -> Box<dyn PrintSurface> {
    Box::new(PrintWindow {
        app,
        ui,
        views,
        spec,
        window: None,
        loaded: Arc::default(),
        destroyed: false,
    })
}

type LoadSignal = Arc<Mutex<Option<mpsc::SyncSender<()>>>>;

struct PrintWindow {
    app: AppHandle,
    ui: Arc<dyn Thread>,
    views: Arc<ViewTable>,
    spec: PrintWindowSpec,
    window: Option<WebviewWindow>,
    /// where the next finished page load is reported
    loaded: LoadSignal,
    destroyed: bool,
}

static NEXT_LABEL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

impl PrintWindow {
    fn scripts_on(&self) -> bool {
        self.spec.profile != PrintProfile::Static
    }

    /// Loads `url` and waits for the page: into a new window the first time
    fn load(&mut self, url: Url) -> Result<(), String> {
        let (tx, rx) = mpsc::sync_channel(1);
        *self.loaded.lock().unwrap() = Some(tx);
        match &self.window {
            Some(window) => {
                let window = window.clone();
                on_ui(&self.ui, move || window.navigate(url)).map_err(|e| e.to_string())?;
            }
            None => self.window = Some(self.build(url)?),
        }
        rx.recv_timeout(LOAD_TIMEOUT)
            .map_err(|_| "ERR_TIMED_OUT: the print page did not load".to_owned())?;
        if self.scripts_on() {
            self.watch_afterprint();
        }
        Ok(())
    }

    fn build(&self, url: Url) -> Result<WebviewWindow, String> {
        let label = format!(
            "print-{}",
            NEXT_LABEL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let app = self.app.clone();
        let spec = self.spec.clone();
        let loaded = self.loaded.clone();
        let scripts = self.scripts_on();
        let parent = spec
            .parent
            .and_then(|w| self.views.label_of_window(w))
            .and_then(|label| app.get_webview_window(&label));
        on_ui(&self.ui, move || {
            let (width, height) = if spec.dialog_chrome {
                (900.0, 700.0)
            } else {
                (spec.width.unwrap_or(800.0), spec.height.unwrap_or(600.0))
            };
            let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
                .visible(false)
                .inner_size(width, height)
                .with_browser_settings(move |settings| {
                    if !scripts {
                        settings.javascript = cef::State::DISABLED;
                    }
                })
                .on_page_load(move |_, payload| {
                    if payload.event() == PageLoadEvent::Finished
                        && let Some(tx) = loaded.lock().unwrap().take()
                    {
                        let _ = tx.send(());
                    }
                });
            if spec.dialog_chrome {
                builder = builder.closable(false).skip_taskbar(true);
            }
            if let Some(parent) = &parent {
                builder = builder.parent(parent).map_err(|e| e.to_string())?;
            }
            builder.build().map_err(|e| e.to_string())
        })
    }

    fn webview(&self) -> Result<tauri::Webview, String> {
        self.window
            .as_ref()
            .map(|w| w.as_ref().clone())
            .ok_or_else(|| "the print window has no page".to_owned())
    }

    /// Remembers in the page when its print preview closed (`afterprint`)
    fn watch_afterprint(&self) {
        let Ok(webview) = self.webview() else { return };
        let script = format!(
            "window.{AFTERPRINT_FLAG} = false; addEventListener('afterprint', () => {{ window.{AFTERPRINT_FLAG} = true }})"
        );
        let _ = cdp(
            &webview,
            "Runtime.evaluate",
            json!({ "expression": script }),
        );
    }

    /// Opens Chrome's print preview and waits until it closed: the page's
    /// `afterprint`, or the window gone, whichever comes first. A page
    /// without scripts cannot report `afterprint`; its window stays until
    /// the user closes it.
    fn preview(&mut self) -> Result<(), String> {
        let window = self.window.clone().ok_or("the print window has no page")?;
        let webview = self.webview()?;
        let shown = window.clone();
        on_ui(&self.ui, move || {
            let _ = shown.show();
            let _ = shown.set_focus();
        });
        let (tx, rx) = mpsc::sync_channel(1);
        webview
            .with_cef_webview(move |cef_view| {
                if let Some(host) = super::menu::host_of(cef_view) {
                    super::menu::print_preview(&host);
                }
                let _ = tx.send(());
            })
            .map_err(|e| e.to_string())?;
        let _ = rx.recv_timeout(LOAD_TIMEOUT);
        let started = Instant::now();
        while started.elapsed() < PREVIEW_TIMEOUT {
            std::thread::sleep(PREVIEW_POLL);
            if !window.is_visible().unwrap_or(false) {
                break;
            }
            if self.scripts_on()
                && let Ok(answer) = cdp(
                    &webview,
                    "Runtime.evaluate",
                    json!({ "expression": format!("window.{AFTERPRINT_FLAG} === true"), "returnByValue": true }),
                )
                && answer["result"]["value"] == true
            {
                break;
            }
        }
        Ok(())
    }

    fn silent(&self, options: &Value) -> PrintReport {
        let printed = self
            .webview()
            .and_then(|webview| print_silently(&webview, options));
        match printed {
            Ok(()) => PrintReport {
                success: true,
                failure_reason: String::new(),
            },
            Err(error) => failed(error),
        }
    }
}

impl PrintSurface for PrintWindow {
    fn load_file(&mut self, path: &str) -> Result<(), String> {
        let url = Url::from_file_path(Path::new(path))
            .map_err(|()| format!("ERR_FILE_NOT_FOUND: {path}"))?;
        self.load(url)
    }

    fn load_url(&mut self, url: &str) -> Result<(), String> {
        let url = crate::app_scheme::webview_url(url)
            .or_else(|| Url::parse(url).ok())
            .ok_or_else(|| format!("ERR_INVALID_URL: {url}"))?;
        self.load(url)
    }

    fn execute_javascript(
        &mut self,
        script: &str,
        user_gesture: bool,
        race_ms: Option<f64>,
    ) -> ExecOutcome {
        let webview = match self.webview() {
            Ok(webview) => webview,
            Err(error) => return ExecOutcome::Throws(error),
        };
        let params = json!({
            "expression": script,
            "awaitPromise": true,
            "userGesture": user_gesture,
            "returnByValue": true,
        });
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let _ = tx.send(cdp(&webview, "Runtime.evaluate", params));
        });
        // without a race the call waits as long as CDP does
        let settled = match race_ms {
            Some(ms) => rx.recv_timeout(Duration::from_millis(ms.max(0.0) as u64)),
            None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        match settled {
            Err(mpsc::RecvTimeoutError::Timeout) => ExecOutcome::Pending,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                ExecOutcome::Throws("the page went away".to_owned())
            }
            Ok(Err(error)) => ExecOutcome::Throws(error),
            Ok(Ok(answer)) => match answer.get("exceptionDetails") {
                Some(details) => ExecOutcome::Rejected(
                    details["exception"]["description"]
                        .as_str()
                        .or_else(|| details["text"].as_str())
                        .unwrap_or("Uncaught")
                        .to_owned(),
                ),
                None => ExecOutcome::Settled,
            },
        }
    }

    fn print(&mut self, options: &Value) -> PrintReport {
        if options["silent"] == true {
            return self.silent(options);
        }
        match self.preview() {
            Ok(()) => PrintReport {
                success: true,
                failure_reason: String::new(),
            },
            Err(error) => failed(error),
        }
    }

    fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, String> {
        cdp_bytes(
            &self.webview()?,
            "Page.printToPDF",
            pdf_params(&ipc_value(options)),
        )
    }

    fn show(&mut self) {
        if let Some(window) = self.window.clone() {
            on_ui(&self.ui, move || {
                let _ = window.show();
            });
        }
    }

    fn focus(&mut self) {
        if let Some(window) = self.window.clone() {
            on_ui(&self.ui, move || {
                let _ = window.set_focus();
            });
        }
    }

    fn is_destroyed(&self) -> bool {
        self.destroyed
    }

    fn destroy(&mut self) {
        self.destroyed = true;
        if let Some(window) = self.window.take() {
            forget_webview(window.label());
            on_ui(&self.ui, move || {
                let _ = window.destroy();
            });
        }
    }
}

impl Drop for PrintWindow {
    fn drop(&mut self) {
        self.destroy();
    }
}

/// `webContents.print({ silent: true, deviceName, ... })` of any webview: the
/// page as PDF, with the print options read as `printToPDF`'s (page size,
/// landscape, margins, scale, background), then to the job's printer.
/// Blocks: call it off the UI thread. Also what the shared `Contents` host
/// does for a view's own silent print.
pub(crate) fn print_silently(webview: &tauri::Webview, options: &Value) -> Result<(), String> {
    let mut params = pdf_params(&ipc_value(&print_as_pdf_options(options)));
    params["printBackground"] = json!(options["printBackground"] != false);
    let pdf = cdp_bytes(webview, "Page.printToPDF", params)?;
    spool(&pdf, options)
}

/// [`print_silently`] with the options as a handler passed them to
/// `Contents::print`
pub(crate) fn print_silently_ipc(
    webview: &tauri::Webview,
    options: &IpcValue,
) -> Result<(), String> {
    print_silently(webview, &json_of(options))
}

fn json_of(value: &IpcValue) -> Value {
    match value {
        IpcValue::Bool(b) => json!(b),
        IpcValue::Number(n) => serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number),
        IpcValue::String(s) => json!(s),
        IpcValue::Array(items) => Value::Array(items.iter().map(json_of).collect()),
        IpcValue::Object(entries) => Value::Object(
            entries
                .iter()
                .filter(|(_, v)| !matches!(v, IpcValue::Undefined))
                .map(|(k, v)| (k.clone(), json_of(v)))
                .collect(),
        ),
        IpcValue::Undefined | IpcValue::Null | IpcValue::Bytes(..) | IpcValue::Date(_) => {
            Value::Null
        }
    }
}

fn failed(reason: impl Into<String>) -> PrintReport {
    PrintReport {
        success: false,
        failure_reason: reason.into(),
    }
}

/// `print`'s options as `printToPDF` names them: Electron's `pageSize` of a
/// print is microns (`{ width, height }`) or a paper name, `printToPDF`'s inches
fn print_as_pdf_options(options: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for key in ["landscape", "scale", "pageRanges", "preferCSSPageSize"] {
        if let Some(value) = options.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if let Some(factor) = options["scaleFactor"].as_f64() {
        out.insert("scale".into(), json!(factor / 100.0));
    }
    match &options["pageSize"] {
        Value::String(name) => {
            out.insert("pageSize".into(), json!(name));
        }
        Value::Object(size) => {
            if let (Some(w), Some(h)) = (size["width"].as_f64(), size["height"].as_f64()) {
                out.insert(
                    "pageSize".into(),
                    json!({ "width": w / 25400.0, "height": h / 25400.0 }),
                );
            }
        }
        _ => {}
    }
    if options["margins"]["marginType"] == "none" {
        out.insert(
            "margins".into(),
            json!({ "top": 0, "bottom": 0, "left": 0, "right": 0 }),
        );
    } else if options["margins"]["marginType"] == "custom" {
        // print's custom margins are CSS pixels, printToPDF's inches
        let margins = &options["margins"];
        let inches = |key: &str| margins[key].as_f64().unwrap_or(0.0) / 96.0;
        out.insert(
            "margins".into(),
            json!({ "top": inches("top"), "bottom": inches("bottom"), "left": inches("left"), "right": inches("right") }),
        );
    }
    Value::Object(out)
}

/// A PDF to the job's printer, without a dialog
fn spool(pdf: &[u8], options: &Value) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::print_pdf(pdf, &silent_job(options), "SeuOffice")
    }
    #[cfg(not(windows))]
    {
        let job = cups_job(options);
        let result = main_core::packages::electron_utils::print_cups::print_pdf_via_cups(
            pdf,
            &job,
            &mut |file, args, stdin| run_command(file, args, stdin),
        );
        if result.ok {
            Ok(())
        } else {
            Err(result.error.unwrap_or_else(|| "lp failed".into()))
        }
    }
}

fn duplex_of(options: &Value) -> Option<DuplexMode> {
    match options["duplexMode"].as_str()? {
        "simplex" => Some(DuplexMode::Simplex),
        "longEdge" => Some(DuplexMode::LongEdge),
        "shortEdge" => Some(DuplexMode::ShortEdge),
        _ => None,
    }
}

fn device_name(options: &Value) -> Option<String> {
    options["deviceName"]
        .as_str()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

#[cfg_attr(windows, allow(dead_code))]
fn cups_job(options: &Value) -> CupsPrintJob {
    CupsPrintJob {
        device_name: device_name(options),
        copies: options["copies"].as_f64(),
        collate: options["collate"].as_bool(),
        duplex_mode: duplex_of(options),
        driver_options: options["driverOptions"].as_array().map(|list| {
            list.iter()
                .filter_map(|o| {
                    Some(DriverOption {
                        name: o["name"].as_str()?.to_owned(),
                        value: o["value"].as_str()?.to_owned(),
                    })
                })
                .collect()
        }),
    }
}

#[cfg(any(windows, test))]
fn silent_job(options: &Value) -> windows::SilentJob {
    windows::SilentJob {
        device_name: device_name(options),
        copies: options["copies"].as_f64().map_or(1, |c| c.max(1.0) as u32),
        collate: options["collate"].as_bool().unwrap_or(false),
        duplex: duplex_of(options).map(|d| match d {
            DuplexMode::Simplex => windows::Duplex::Simplex,
            DuplexMode::LongEdge => windows::Duplex::LongEdge,
            DuplexMode::ShortEdge => windows::Duplex::ShortEdge,
        }),
        landscape: options["landscape"].as_bool().unwrap_or(false),
        color: options["color"].as_bool(),
        page_ranges: options["pageRanges"]
            .as_array()
            .map(|ranges| {
                ranges
                    .iter()
                    .filter_map(|r| Some((r["from"].as_u64()? as u32, r["to"].as_u64()? as u32)))
                    .collect()
            })
            .unwrap_or_default(),
        ..windows::SilentJob::default()
    }
}

/// JSON as the IPC value `pdf_params` reads
fn ipc_value(value: &Value) -> IpcValue {
    match value {
        Value::Null => IpcValue::Null,
        Value::Bool(b) => IpcValue::Bool(*b),
        Value::Number(n) => IpcValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => IpcValue::String(s.clone()),
        Value::Array(items) => IpcValue::Array(items.iter().map(ipc_value).collect()),
        Value::Object(map) => {
            IpcValue::Object(map.iter().map(|(k, v)| (k.clone(), ipc_value(v))).collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn printer_info_reads_a_quoted_or_bare_value() {
        assert_eq!(
            printer_info("copies=1 printer-info='Office Laser' printer-is-shared=false").as_deref(),
            Some("Office Laser")
        );
        assert_eq!(
            printer_info("printer-info=Home device-uri=ipp://x").as_deref(),
            Some("Home")
        );
        assert_eq!(printer_info("copies=1"), None);
    }

    #[test]
    fn print_options_become_pdf_options() {
        let options = json!({
            "silent": true,
            "pageSize": { "width": 210000, "height": 297000 },
            "margins": { "marginType": "custom", "top": 96, "bottom": 48, "left": 0, "right": 0 },
            "scaleFactor": 150,
            "landscape": true,
        });
        let pdf = print_as_pdf_options(&options);
        assert_eq!(pdf["landscape"], true);
        assert_eq!(pdf["scale"], 1.5);
        assert!((pdf["pageSize"]["width"].as_f64().unwrap() - 8.2677).abs() < 1e-3);
        assert_eq!(pdf["margins"]["top"], 1.0);
        assert_eq!(pdf["margins"]["bottom"], 0.5);
        let none =
            print_as_pdf_options(&json!({ "margins": { "marginType": "none" }, "pageSize": "A4" }));
        assert_eq!(none["margins"]["left"], 0);
        assert_eq!(none["pageSize"], "A4");
    }

    #[test]
    fn a_silent_job_reads_its_printer_and_copies() {
        let options = json!({
            "deviceName": "office", "copies": 3, "collate": true, "duplexMode": "longEdge",
            "driverOptions": [{ "name": "ColorModel", "value": "Gray" }, { "name": 1 }],
        });
        let job = cups_job(&options);
        assert_eq!(job.device_name.as_deref(), Some("office"));
        assert_eq!(job.copies, Some(3.0));
        assert_eq!(job.duplex_mode, Some(DuplexMode::LongEdge));
        assert_eq!(job.driver_options.unwrap().len(), 1);
        assert_eq!(cups_job(&json!({ "deviceName": "" })).device_name, None);
        let windows = silent_job(&json!({ "copies": 0, "pageRanges": [{ "from": 2, "to": 3 }] }));
        assert_eq!(windows.copies, 1);
        assert_eq!(windows.page_ranges, vec![(2, 3)]);
    }
}
