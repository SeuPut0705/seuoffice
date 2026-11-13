//! `packages/electron-utils/src/print-window.ts`.
//!
//! The TypeScript awaits the print window's renderer three times: `loadFile`,
//! the readiness probe (`executeJavaScript`, raced with a 5 s timer) and the
//! `print` callback. Each await is a step the caller carries out and answers:
//! [`begin_print`] returns a [`PrintStep`] holding the job, and the job's
//! `on_*` method for that step returns the next one, up to
//! [`PrintStep::Done`]. So the core never blocks on a renderer. What the
//! TypeScript calls on the window without waiting (`show`, `focus`,
//! `isDestroyed`, `destroy`) is a [`PrintDialogWindow`]. The probe's timer is
//! the caller's: [`ExecOutcome::Pending`] is a probe still pending when
//! [`PRINT_READY_TIMEOUT_MS`] fires.

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

/// Throwaway window supplied by the caller so each app keeps its own
/// webPreferences: the calls the TypeScript makes on it without awaiting the
/// renderer. The awaited ones are the steps of a [`PrintStep`].
pub trait PrintDialogWindow {
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

/// `PRINT_READY_TIMEOUT_MS`: a user-authored script that never yields must not
/// wedge printing for the session. The caller's timer of the probe.
pub const PRINT_READY_TIMEOUT_MS: f64 = 5_000.0;

const DEFAULT_FILE_NAME: &str = "print.html";
const DEFAULT_DIR_PREFIX: &str = "seuoffice-print-";

/// `loadPrintHtml` between its awaits: the temp dir it made and the file it
/// wrote there.
#[derive(Debug)]
pub struct PrintLoad {
    temp_dir: String,
    html_path: String,
}

/// What `loadPrintHtml` asks of the caller next.
#[derive(Debug)]
pub enum LoadStep {
    /// `await win.loadFile(path)`: answer with [`PrintLoad::on_loaded`]
    Load { path: String, load: PrintLoad },
    /// `webContents.executeJavaScript(script, userGesture)` raced with the
    /// caller's [`PRINT_READY_TIMEOUT_MS`] timer: answer with
    /// [`PrintLoad::on_probe`]
    Probe {
        script: &'static str,
        user_gesture: bool,
        load: PrintLoad,
    },
    /// the document is loaded and ready to print: the temp dir the caller must
    /// remove afterwards. `Err` is what the load threw; its folder is gone
    /// then, so a failed load leaves nothing for the caller to clean.
    Done(Result<String, JsError>),
}

/// `loadPrintHtml(win, html, fileName, dirPrefix)` up to its first await: load
/// a print document into the window, then wait for its readiness probe (fonts
/// and images decoded). `tmp_dir` is `os.tmpdir()`.
pub fn begin_load_print_html(
    html: &str,
    file_name: Option<&str>,
    dir_prefix: Option<&str>,
    tmp_dir: &str,
) -> LoadStep {
    let file_name = file_name.unwrap_or(DEFAULT_FILE_NAME);
    let dir_prefix = dir_prefix.unwrap_or(DEFAULT_DIR_PREFIX);
    // a temp file, not a data: URL: long documents truncate the URL
    let temp_dir = match crate::node_fs::mkdtemp_random(&join(&[tmp_dir, dir_prefix])) {
        Ok(dir) => dir,
        Err(error) => return LoadStep::Done(Err(error.into())),
    };
    let html_path = join(&[&temp_dir, file_name]);
    let load = PrintLoad {
        temp_dir,
        html_path,
    };
    if let Err(e) = std::fs::write(&load.html_path, html) {
        let error = node_error(&e, "open", &load.html_path).into();
        return load.fail(error);
    }
    LoadStep::Load {
        path: load.html_path.clone(),
        load,
    }
}

impl PrintLoad {
    /// what `loadFile` came to
    pub fn on_loaded(self, loaded: Result<(), JsError>) -> LoadStep {
        match loaded {
            Ok(()) => LoadStep::Probe {
                script: PRINT_READY_SCRIPT,
                user_gesture: true,
                load: self,
            },
            Err(error) => self.fail(error),
        }
    }

    /// what the probe came to; one that rejects is reported to
    /// `log_probe_error` (`console.error`) with the rejection's message
    pub fn on_probe(self, outcome: ExecOutcome, log_probe_error: &mut dyn FnMut(&str)) -> LoadStep {
        match outcome {
            ExecOutcome::Settled | ExecOutcome::Pending => {}
            ExecOutcome::Rejected(message) => log_probe_error(&message),
            ExecOutcome::Throws(message) => return self.fail(JsError::plain(message)),
        }
        LoadStep::Done(Ok(self.temp_dir))
    }

    /// the `catch` of `loadPrintHtml`: the folder goes, then the error is
    /// thrown again; an `rm` that throws replaces it
    fn fail(self, error: JsError) -> LoadStep {
        LoadStep::Done(match rm_recursive_force(&self.temp_dir) {
            Ok(()) => Err(error),
            Err(rm) => Err(rm.into()),
        })
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

/// `printHtmlDocument` while it loads the document: the load and whether the
/// window must be shown before the dialog.
#[derive(Debug)]
pub struct PrintJob {
    win32: bool,
    load: PrintLoad,
}

/// `printHtmlDocument` while the system print dialog is open: the temp dir to
/// remove once it closes.
#[derive(Debug)]
pub struct PrintDialogJob {
    temp_dir: String,
}

/// What `printHtmlDocument` asks of the caller next.
#[derive(Debug)]
pub enum PrintStep {
    /// `await win.loadFile(path)`: answer with [`PrintJob::on_loaded`]
    Load { path: String, job: PrintJob },
    /// `webContents.executeJavaScript(script, userGesture)` raced with the
    /// caller's [`PRINT_READY_TIMEOUT_MS`] timer: answer with
    /// [`PrintJob::on_probe`]
    Probe {
        script: &'static str,
        user_gesture: bool,
        job: PrintJob,
    },
    /// `webContents.print({ silent, printBackground }, callback)`: answer with
    /// [`PrintDialogJob::on_printed`]
    Dialog {
        silent: bool,
        print_background: bool,
        job: PrintDialogJob,
    },
    /// the print is over and cleaned up: the window destroyed, the temp dir
    /// removed. `Err` is what that cleanup threw, which replaces the outcome.
    Done(Result<PrintDialogOutcome, JsError>),
}

/// `printHtmlDocument(options)` up to its first await: print a document
/// through the system print dialog in a throwaway window. The window outlives
/// the dialog (destroying it as print() opens closes the sheet) and is
/// destroyed on every path.
pub fn begin_print(
    win: &mut dyn PrintDialogWindow,
    options: &PrintDocumentOptions<'_>,
) -> PrintStep {
    let win32 = options.platform == "win32";
    let loading = begin_load_print_html(
        options.html,
        options.file_name,
        options.dir_prefix,
        options.tmp_dir,
    );
    PrintJob::after_load(win, win32, loading)
}

impl PrintJob {
    /// what `loadFile` came to
    pub fn on_loaded(
        self,
        win: &mut dyn PrintDialogWindow,
        loaded: Result<(), JsError>,
    ) -> PrintStep {
        let win32 = self.win32;
        Self::after_load(win, win32, self.load.on_loaded(loaded))
    }

    /// what the readiness probe came to; see [`PrintLoad::on_probe`]
    pub fn on_probe(
        self,
        win: &mut dyn PrintDialogWindow,
        outcome: ExecOutcome,
        log_probe_error: &mut dyn FnMut(&str),
    ) -> PrintStep {
        let win32 = self.win32;
        Self::after_load(win, win32, self.load.on_probe(outcome, log_probe_error))
    }

    fn after_load(win: &mut dyn PrintDialogWindow, win32: bool, loading: LoadStep) -> PrintStep {
        match loading {
            LoadStep::Load { path, load } => PrintStep::Load {
                path,
                job: PrintJob { win32, load },
            },
            LoadStep::Probe {
                script,
                user_gesture,
                load,
            } => PrintStep::Probe {
                script,
                user_gesture,
                job: PrintJob { win32, load },
            },
            LoadStep::Done(Ok(temp_dir)) => open_dialog(win, win32, temp_dir),
            LoadStep::Done(Err(error)) => finish_print(win, None, Err(error)),
        }
    }
}

fn open_dialog(win: &mut dyn PrintDialogWindow, win32: bool, temp_dir: String) -> PrintStep {
    // Windows attaches the native dialog to the printed window, which must be visible
    if win32 && let Err(error) = win.show().and_then(|()| win.focus()) {
        return finish_print(win, Some(temp_dir), Err(error));
    }
    PrintStep::Dialog {
        silent: false,
        print_background: true,
        job: PrintDialogJob { temp_dir },
    }
}

impl PrintDialogJob {
    /// the arguments of the `print` callback; `Err` is a `print` that throws
    pub fn on_printed(
        self,
        win: &mut dyn PrintDialogWindow,
        printed: Result<PrintReport, JsError>,
    ) -> PrintStep {
        let outcome = printed.map(|result| {
            if !result.success {
                if result.failure_reason == "Print job canceled" {
                    return PrintDialogOutcome::Canceled;
                }
                let reason = if result.failure_reason.is_empty() {
                    "the print job failed".to_owned()
                } else {
                    result.failure_reason
                };
                return PrintDialogOutcome::Failed(reason);
            }
            PrintDialogOutcome::Ok
        });
        finish_print(win, Some(self.temp_dir), outcome)
    }
}

fn destroy_window(win: &mut dyn PrintDialogWindow) -> Result<(), JsError> {
    if !win.is_destroyed()? {
        win.destroy()?;
    }
    Ok(())
}

/// the `catch` and `finally` of `printHtmlDocument`: an error becomes the
/// outcome's message, the window is destroyed, then the temp dir (of a load
/// that finished) removed. What those throw replaces the outcome, the `rm`
/// first.
fn finish_print(
    win: &mut dyn PrintDialogWindow,
    temp_dir: Option<String>,
    outcome: Result<PrintDialogOutcome, JsError>,
) -> PrintStep {
    let outcome = outcome.unwrap_or_else(|error| PrintDialogOutcome::Failed(error.message));
    let destroyed = destroy_window(win);
    if let Some(dir) = temp_dir
        && let Err(rm) = rm_recursive_force(&dir)
    {
        return PrintStep::Done(Err(rm.into()));
    }
    PrintStep::Done(destroyed.map(|()| outcome))
}
