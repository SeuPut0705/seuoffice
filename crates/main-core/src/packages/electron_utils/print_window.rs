//! `packages/electron-utils/src/print-window.ts`.
//!
//! The throwaway window comes from the caller as a [`PrintDialogWindow`]: the
//! methods the TypeScript calls on a `BrowserWindow`, so the Electron side is
//! a thin adapter. `setTimeout` of the readiness probe is the caller's:
//! [`ExecOutcome::Pending`] is a probe still pending when the 5 s timer fires.

use jscompat::node_path::host::join;
use serde::Serialize;

use crate::node_fs::{NodeError, node_error};

/// What a call of the TypeScript throws: a Node error or the window's own.
#[derive(Debug, Clone, PartialEq)]
pub struct JsError {
    pub code: Option<String>,
    pub message: String,
}

impl JsError {
    pub fn plain(message: impl Into<String>) -> Self {
        JsError {
            code: None,
            message: message.into(),
        }
    }
}

impl From<NodeError> for JsError {
    fn from(e: NodeError) -> Self {
        JsError {
            code: e.code.map(str::to_owned),
            message: e.message,
        }
    }
}

/// `rm(path, { recursive: true, force: true })`
pub fn rm_recursive_force(path: &str) -> Result<(), NodeError> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        // a file where a folder was expected
        Err(_) if std::fs::symlink_metadata(path).is_ok_and(|m| !m.is_dir()) => {
            match std::fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(e) => Err(node_error(&e, "rm", path)),
            }
        }
        Err(e) => Err(node_error(&e, "rm", path)),
    }
}

/// What `webContents.executeJavaScript(...)` came to by the time the race with
/// the timer was decided.
#[derive(Debug, Clone, PartialEq)]
pub enum ExecOutcome {
    /// the promise resolved first
    Settled,
    /// the promise rejected with this message
    Rejected(String),
    /// the call itself threw, before a promise existed
    Throws(String),
    /// still pending when the 5 s timer fired
    Pending,
}

/// The arguments of `(success, failureReason)` of the `print` callback.
#[derive(Debug, Clone, PartialEq)]
pub struct PrintReport {
    pub success: bool,
    pub failure_reason: String,
}

/// Throwaway window supplied by the caller so each app keeps its own webPreferences.
pub trait PrintDialogWindow {
    fn load_file(&mut self, path: &str) -> Result<(), JsError>;
    fn execute_javascript(&mut self, script: &str, user_gesture: bool) -> ExecOutcome;
    /// `webContents.print({ silent, printBackground }, callback)`: the arguments
    /// the callback got; `Err` is a `print` that throws
    fn print(&mut self, silent: bool, print_background: bool) -> Result<PrintReport, JsError>;
    fn show(&mut self) -> Result<(), JsError>;
    fn focus(&mut self) -> Result<(), JsError>;
    fn is_destroyed(&mut self) -> Result<bool, JsError>;
    fn destroy(&mut self) -> Result<(), JsError>;
}

/// `PrintDialogOutcome`
#[derive(Debug, Clone, PartialEq)]
pub enum PrintDialogOutcome {
    Ok,
    /// the user closed the system dialog: their own outcome, not a failure
    Canceled,
    Failed(String),
}

impl Serialize for PrintDialogOutcome {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            PrintDialogOutcome::Ok => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("ok", &true)?;
                map.end()
            }
            PrintDialogOutcome::Canceled => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("ok", &true)?;
                map.serialize_entry("canceled", &true)?;
                map.end()
            }
            PrintDialogOutcome::Failed(error) => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("ok", &false)?;
                map.serialize_entry("error", error)?;
                map.end()
            }
        }
    }
}

/// Fonts and bitmaps decoded before print(), or pages print with fallback fonts and missing images.
pub const PRINT_READY_SCRIPT: &str = "Promise.all([document.fonts.ready, ...Array.from(document.images).map((i) => i.decode().catch(() => {}))])";

const DEFAULT_FILE_NAME: &str = "print.html";
const DEFAULT_DIR_PREFIX: &str = "seuoffice-print-";

/// Load a print document into the window and wait for its readiness probe
/// (fonts and images decoded). The caller owns the window and must remove the
/// returned temp dir afterwards. `tmp_dir` is `os.tmpdir()`; a probe that
/// rejects is reported to `log_probe_error` (`console.error`), with the
/// rejection's message.
pub fn load_print_html(
    win: &mut dyn PrintDialogWindow,
    html: &str,
    file_name: Option<&str>,
    dir_prefix: Option<&str>,
    tmp_dir: &str,
    log_probe_error: &mut dyn FnMut(&str),
) -> Result<String, JsError> {
    let file_name = file_name.unwrap_or(DEFAULT_FILE_NAME);
    let dir_prefix = dir_prefix.unwrap_or(DEFAULT_DIR_PREFIX);
    // a temp file, not a data: URL: long documents truncate the URL
    let temp_dir = crate::node_fs::mkdtemp_random(&join(&[tmp_dir, dir_prefix]))?;
    let loaded = (|| -> Result<(), JsError> {
        let html_path = join(&[&temp_dir, file_name]);
        std::fs::write(&html_path, html).map_err(|e| node_error(&e, "open", &html_path))?;
        win.load_file(&html_path)?;
        match win.execute_javascript(PRINT_READY_SCRIPT, true) {
            ExecOutcome::Settled | ExecOutcome::Pending => {}
            ExecOutcome::Rejected(message) => log_probe_error(&message),
            ExecOutcome::Throws(message) => return Err(JsError::plain(message)),
        }
        Ok(())
    })();
    match loaded {
        Ok(()) => Ok(temp_dir),
        Err(error) => {
            // a failed load leaves nothing for the caller to clean: they only
            // ever see a temp dir when the document is loaded and ready to print
            rm_recursive_force(&temp_dir)?;
            Err(error)
        }
    }
}

/// `PrintDocumentOptions` without the window
pub struct PrintDocumentOptions<'a> {
    /// final document HTML, assets already resolved by the caller
    pub html: &'a str,
    pub file_name: Option<&'a str>,
    /// temp-dir prefix, so a leaked dir is attributable to the calling app
    pub dir_prefix: Option<&'a str>,
    /// `process.platform`
    pub platform: &'a str,
    /// `os.tmpdir()`
    pub tmp_dir: &'a str,
}

fn print_in_window(
    win: &mut dyn PrintDialogWindow,
    options: &PrintDocumentOptions<'_>,
    temp_dir: &mut Option<String>,
    log_probe_error: &mut dyn FnMut(&str),
) -> Result<PrintDialogOutcome, JsError> {
    *temp_dir = Some(load_print_html(
        win,
        options.html,
        options.file_name,
        options.dir_prefix,
        options.tmp_dir,
        log_probe_error,
    )?);
    // Windows attaches the native dialog to the printed window, which must be visible
    if options.platform == "win32" {
        win.show()?;
        win.focus()?;
    }
    let result = win.print(false, true)?;
    if !result.success {
        if result.failure_reason == "Print job canceled" {
            return Ok(PrintDialogOutcome::Canceled);
        }
        let reason = if result.failure_reason.is_empty() {
            "the print job failed".to_owned()
        } else {
            result.failure_reason
        };
        return Ok(PrintDialogOutcome::Failed(reason));
    }
    Ok(PrintDialogOutcome::Ok)
}

/// Print a document through the system print dialog in a throwaway window.
/// The window outlives the dialog (destroying it as print() opens closes the
/// sheet) and is destroyed on every path. `Err` is what the `finally` blocks
/// throw: that replaces the outcome.
pub fn print_html_document(
    win: &mut dyn PrintDialogWindow,
    options: &PrintDocumentOptions<'_>,
    log_probe_error: &mut dyn FnMut(&str),
) -> Result<PrintDialogOutcome, JsError> {
    let mut temp_dir: Option<String> = None;
    let outcome = match print_in_window(win, options, &mut temp_dir, log_probe_error) {
        Ok(outcome) => outcome,
        Err(error) => PrintDialogOutcome::Failed(error.message),
    };
    let destroyed = (|| -> Result<(), JsError> {
        if !win.is_destroyed()? {
            win.destroy()?;
        }
        Ok(())
    })();
    if let Some(dir) = temp_dir {
        rm_recursive_force(&dir)?;
    }
    destroyed?;
    Ok(outcome)
}
