//! `webContents` of a view (the shared host `Contents`): capture, printToPDF,
//! zoom, focus and closing the window. Capture and PDF go through the Chrome
//! DevTools protocol of the view's browser (`Page.captureScreenshot`,
//! `Page.printToPDF`), as the prototype's PDF did.
//!
//! A CDP call blocks its caller until the browser answers; the browser
//! answers on the UI thread, which a core-thread caller does not hold.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value, json};
use shell_contract::hosts::Contents;
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::runtime::Views;
use shell_contract::value::IpcValue;
use shell_contract::{ContentsHost, Hosts};
use tauri_runtime_cef::{DevToolsProtocol, WebviewCefExt, allocate_devtools_message_id};

use super::HostContext;
use super::window::Windows;
use crate::views::ViewTable;

/// a print of a large document can take a while
const CDP_TIMEOUT: Duration = Duration::from_secs(90);

type Answer = (bool, Vec<u8>);

/// CDP results waiting for their caller, by request id
#[derive(Default)]
struct Pending(Mutex<HashMap<i32, mpsc::SyncSender<Answer>>>);

impl Pending {
    fn complete(&self, protocol: DevToolsProtocol) {
        if let DevToolsProtocol::MethodResult {
            message_id,
            success,
            result,
        } = protocol
            && let Some(tx) = self.0.lock().unwrap().remove(&message_id)
        {
            let _ = tx.send((success, result));
        }
    }
}

struct ShellContents {
    table: Arc<ViewTable>,
    windows: Arc<Windows>,
    pending: Arc<Pending>,
    /// views whose browser already hands its results to `pending`
    observed: Mutex<HashSet<ViewId>>,
}

pub fn install(hosts: &mut Hosts, cx: &HostContext) {
    let contents: ContentsHost = Arc::new(ShellContents {
        table: cx.views.clone(),
        windows: cx.windows.clone(),
        pending: Arc::default(),
        observed: Mutex::default(),
    });
    hosts.insert(contents);
}

fn field<'a>(value: &'a IpcValue, key: &str) -> Option<&'a IpcValue> {
    match value {
        IpcValue::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn number(value: Option<&IpcValue>) -> Option<f64> {
    match value {
        Some(IpcValue::Number(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

/// Electron's named paper sizes, in inches
fn paper(name: &str) -> Option<(f64, f64)> {
    Some(match name {
        "A0" => (33.11, 46.81),
        "A1" => (23.39, 33.11),
        "A2" => (16.54, 23.39),
        "A3" => (11.69, 16.54),
        "A4" => (8.27, 11.69),
        "A5" => (5.83, 8.27),
        "A6" => (4.13, 5.83),
        "Legal" => (8.5, 14.0),
        "Letter" => (8.5, 11.0),
        "Tabloid" => (11.0, 17.0),
        _ => return None,
    })
}

/// `webContents.printToPDF(options)` as the parameters of `Page.printToPDF`. A
/// key Electron has and CDP names alike goes across; the page size and the
/// margins (inches in both) are spelled out. What `options` leaves out stays
/// at the browser's default.
fn pdf_params(options: &IpcValue) -> Value {
    let mut params = Map::new();
    for key in [
        "landscape",
        "displayHeaderFooter",
        "printBackground",
        "preferCSSPageSize",
        "generateTaggedPDF",
        "generateDocumentOutline",
    ] {
        if let Some(IpcValue::Bool(b)) = field(options, key) {
            params.insert(key.into(), json!(b));
        }
    }
    if let Some(scale) = number(field(options, "scale")) {
        params.insert("scale".into(), json!(scale));
    }
    for key in ["pageRanges", "headerTemplate", "footerTemplate"] {
        if let Some(IpcValue::String(s)) = field(options, key) {
            params.insert(key.into(), json!(s));
        }
    }
    match field(options, "pageSize") {
        Some(IpcValue::String(name)) => {
            if let Some((w, h)) = paper(name) {
                params.insert("paperWidth".into(), json!(w));
                params.insert("paperHeight".into(), json!(h));
            }
        }
        Some(size @ IpcValue::Object(_)) => {
            if let (Some(w), Some(h)) =
                (number(field(size, "width")), number(field(size, "height")))
            {
                params.insert("paperWidth".into(), json!(w));
                params.insert("paperHeight".into(), json!(h));
            }
        }
        _ => {}
    }
    if let Some(margins) = field(options, "margins") {
        for (key, cdp) in [
            ("top", "marginTop"),
            ("bottom", "marginBottom"),
            ("left", "marginLeft"),
            ("right", "marginRight"),
        ] {
            if let Some(m) = number(field(margins, key)) {
                params.insert(cdp.into(), json!(m));
            }
        }
    }
    Value::Object(params)
}

impl ShellContents {
    fn cdp(&self, view: ViewId, method: &str, params: Value) -> Result<Value, String> {
        let webview = self
            .windows
            .webview(view)
            .ok_or_else(|| format!("no view {}", view.0))?;
        if self.observed.lock().unwrap().insert(view) {
            let pending = self.pending.clone();
            webview
                .on_dev_tools_protocol(move |protocol| pending.complete(protocol))
                .map_err(|e| e.to_string())?;
        }
        let id = allocate_devtools_message_id().map_err(|e| e.to_string())?;
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending.0.lock().unwrap().insert(id, tx);
        let message = json!({ "id": id, "method": method, "params": params }).to_string();
        if let Err(error) = webview.send_dev_tools_message(message.as_bytes()) {
            self.pending.0.lock().unwrap().remove(&id);
            return Err(error.to_string());
        }
        let (success, result) = rx.recv_timeout(CDP_TIMEOUT).map_err(|_| {
            self.pending.0.lock().unwrap().remove(&id);
            format!("{method}: no answer in {}s", CDP_TIMEOUT.as_secs())
        })?;
        if !success {
            return Err(String::from_utf8_lossy(&result).into_owned());
        }
        serde_json::from_slice(&result).map_err(|e| e.to_string())
    }

    /// A CDP result's base64 `data` field
    fn cdp_bytes(&self, view: ViewId, method: &str, params: Value) -> Result<Vec<u8>, String> {
        let result = self.cdp(view, method, params)?;
        let data = result["data"]
            .as_str()
            .ok_or_else(|| format!("{method} returned no data"))?;
        STANDARD.decode(data).map_err(|e| e.to_string())
    }
}

impl Contents for ShellContents {
    fn window_of(&self, view: ViewId) -> Option<WindowId> {
        self.table.sender_of(view).map(|s| s.window)
    }

    fn capture_png(&self, view: ViewId) -> Result<Vec<u8>, String> {
        self.cdp_bytes(view, "Page.captureScreenshot", json!({ "format": "png" }))
    }

    fn print_to_pdf(&self, view: ViewId, options: IpcValue) -> Result<Vec<u8>, String> {
        self.cdp_bytes(view, "Page.printToPDF", pdf_params(&options))
    }

    /// `webContents.print` opens the system's print dialog. Tauri's `print`
    /// shows it and does not report how it ended, so a shown dialog is
    /// `true`; batch M's print host (`host/print.rs`) owns anything finer.
    fn print(&self, view: ViewId, _options: IpcValue) -> Result<bool, String> {
        let webview = self
            .windows
            .webview(view)
            .ok_or_else(|| format!("no view {}", view.0))?;
        webview.print().map_err(|e| e.to_string())?;
        Ok(true)
    }

    fn zoom_factor(&self, view: ViewId) -> f64 {
        self.table.zoom(view)
    }

    fn set_zoom_factor(&self, view: ViewId, factor: f64) {
        self.table.set_zoom(view, factor);
        if let Some(webview) = self.windows.webview(view)
            && let Err(error) = webview.set_zoom(factor)
        {
            eprintln!("shell: setZoomFactor on view {}: {error}", view.0);
        }
    }

    fn focus(&self, view: ViewId) {
        if let Some(webview) = self.windows.webview(view)
            && let Err(error) = webview.set_focus()
        {
            eprintln!("shell: focus view {}: {error}", view.0);
        }
    }

    fn close_window(&self, window: WindowId) {
        if let Err(error) = self.windows.close_window(window) {
            eprintln!("shell: close window {}: {error}", window.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(entries: Vec<(&str, IpcValue)>) -> IpcValue {
        IpcValue::Object(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
        )
    }

    #[test]
    fn electron_options_become_cdp_parameters() {
        let options = object(vec![
            ("landscape", IpcValue::Bool(true)),
            ("printBackground", IpcValue::Bool(true)),
            ("pageSize", IpcValue::String("A4".into())),
            (
                "margins",
                object(vec![
                    ("top", IpcValue::Number(0.0)),
                    ("left", IpcValue::Number(0.5)),
                ]),
            ),
            ("pageRanges", IpcValue::String("1-2".into())),
            ("scale", IpcValue::Number(0.9)),
        ]);
        assert_eq!(
            pdf_params(&options),
            json!({
                "landscape": true,
                "printBackground": true,
                "scale": 0.9,
                "pageRanges": "1-2",
                "paperWidth": 8.27,
                "paperHeight": 11.69,
                "marginTop": 0.0,
                "marginLeft": 0.5,
            })
        );
        let custom = object(vec![(
            "pageSize",
            object(vec![
                ("width", IpcValue::Number(5.0)),
                ("height", IpcValue::Number(7.0)),
            ]),
        )]);
        assert_eq!(
            pdf_params(&custom),
            json!({ "paperWidth": 5.0, "paperHeight": 7.0 })
        );
        assert_eq!(pdf_params(&IpcValue::Undefined), json!({}));
    }
}
