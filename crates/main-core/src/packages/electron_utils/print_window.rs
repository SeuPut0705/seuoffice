//! `packages/electron-utils/src/print-window.ts`, and the step shape every job
//! on a print or export window shares.
//!
//! On the shell's one core thread nothing may block on a window's renderer.
//! So each await of a renderer (`loadFile`, `executeJavaScript`, `printToPDF`,
//! the `print` callback) is a [`WindowStep::Await`]: the job hands the caller
//! a [`RendererCall`] and itself, the caller carries the call out and gives
//! the job back what it came to, as a [`RendererAnswer`], through the job's
//! `resume`. That returns the next step, up to [`WindowStep::Done`], by which
//! the job has cleaned up after itself (window destroyed, temp folder gone).
//! What the TypeScript calls on a window without waiting (`show`, `focus`,
//! `isDestroyed`, `destroy`) stays a trait of the module.
//!
//! Here: `printHtmlDocument` ([`begin_print`], [`PrintJob`]) over a
//! [`PrintDialogWindow`], and `loadPrintHtml` ([`begin_load_print_html`],
//! [`PrintLoad`]). The probe's 5 s timer is the caller's (`race_ms` of
//! [`RendererCall::ExecuteJavaScript`]).

use jscompat::node_path::host::join;
use serde::Serialize;
use serde_json::Value;

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

/// One await of a job on its window's renderer, for the caller to carry out.
#[derive(Debug, Clone, PartialEq)]
pub enum RendererCall {
    /// `win.loadFile(path)`: answer [`RendererAnswer::Loaded`]
    LoadFile { path: String },
    /// `webContents.executeJavaScript(script, userGesture)`: answer
    /// [`RendererAnswer::Executed`]. With `race_ms` the call is raced with a
    /// timer of that many milliseconds the caller starts, and
    /// [`ExecOutcome::Pending`] is the timer winning.
    ExecuteJavaScript {
        script: &'static str,
        user_gesture: bool,
        race_ms: Option<f64>,
    },
    /// `webContents.printToPDF(options)`: answer [`RendererAnswer::Pdf`]
    PrintToPdf { options: Value },
    /// `webContents.print(options, callback)`: answer
    /// [`RendererAnswer::Printed`] with the arguments the callback got
    Print { options: Value },
}

/// What a [`RendererCall`] came to.
#[derive(Debug, Clone, PartialEq)]
pub enum RendererAnswer {
    Loaded(Result<(), JsError>),
    Executed(ExecOutcome),
    Pdf(Result<Vec<u8>, JsError>),
    /// `Err` is a `print` that throws
    Printed(Result<PrintReport, JsError>),
    /// the job's watchdog timer fired before the call settled (only for a job
    /// that asks for one)
    TimedOut,
}

/// What a job asks of the caller next.
#[derive(Debug)]
pub enum WindowStep<J, T> {
    /// carry `call` out and hand the job what it came to
    Await { call: RendererCall, job: J },
    /// the job is over and cleaned up
    Done(T),
}

/// An answer that is not the one the call asks for: the adapter's mistake,
/// which fails the job (and so still cleans up) rather than the process.
pub(crate) fn wrong_answer(call: &str) -> JsError {
    JsError::plain(format!("the window's answer does not fit the {call} call"))
}

impl RendererAnswer {
    /// what `loadFile` came to
    pub fn into_loaded(self) -> Result<(), JsError> {
        match self {
            RendererAnswer::Loaded(loaded) => loaded,
            _ => Err(wrong_answer("loadFile")),
        }
    }

    /// what `executeJavaScript` came to
    pub fn into_executed(self) -> Result<ExecOutcome, JsError> {
        match self {
            RendererAnswer::Executed(outcome) => Ok(outcome),
            _ => Err(wrong_answer("executeJavaScript")),
        }
    }

    /// what `printToPDF` came to
    pub fn into_pdf(self) -> Result<Vec<u8>, JsError> {
        match self {
            RendererAnswer::Pdf(pdf) => pdf,
            _ => Err(wrong_answer("printToPDF")),
        }
    }

    /// what the `print` callback got
    pub fn into_printed(self) -> Result<PrintReport, JsError> {
        match self {
            RendererAnswer::Printed(printed) => printed,
            _ => Err(wrong_answer("print")),
        }
    }
}

/// `loadFile` of the page a job wrote
pub(crate) fn load_call(path: &str) -> RendererCall {
    RendererCall::LoadFile {
        path: path.to_owned(),
    }
}

/// The `finally` of a job on a window it made itself: `win?.destroy()` (the
/// window is made inside the `try`, so it may not exist), then the work folder
/// removed. A `destroy` that throws stops there and leaves the folder, as the
/// TypeScript's `finally` does. `Err` replaces the job's own outcome.
pub(crate) fn release_job<W>(
    win: Option<&mut W>,
    work_dir: &str,
    destroy: impl FnOnce(&mut W) -> Result<(), JsError>,
) -> Result<(), JsError> {
    if let Some(win) = win {
        destroy(win)?;
    }
    rm_recursive_force(work_dir)?;
    Ok(())
}

const DEFAULT_FILE_NAME: &str = "print.html";
const DEFAULT_DIR_PREFIX: &str = "seuoffice-print-";

/// Where `loadPrintHtml` waits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoadPhase {
    Loading,
    Probing,
}

/// `loadPrintHtml` between its awaits: the temp dir it made and what it waits
/// for.
#[derive(Debug)]
pub struct PrintLoad {
    temp_dir: String,
    phase: LoadPhase,
}

/// A step of `loadPrintHtml`; [`WindowStep::Done`] holds the temp dir the
/// caller must remove afterwards, or what the load threw (its folder is gone
/// then, so a failed load leaves nothing for the caller to clean).
pub type LoadStep = WindowStep<PrintLoad, Result<String, JsError>>;

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
        Err(error) => return WindowStep::Done(Err(error.into())),
    };
    let html_path = join(&[&temp_dir, file_name]);
    let load = PrintLoad {
        temp_dir,
        phase: LoadPhase::Loading,
    };
    if let Err(e) = std::fs::write(&html_path, html) {
        let error = node_error(&e, "open", &html_path).into();
        return load.fail(error);
    }
    WindowStep::Await {
        call: load_call(&html_path),
        job: load,
    }
}

impl PrintLoad {
    /// The answer to the call this load waits for. A probe that rejects is
    /// reported to `log_probe_error` (`console.error`) with the rejection's
    /// message.
    pub fn resume(
        mut self,
        answer: RendererAnswer,
        log_probe_error: &mut dyn FnMut(&str),
    ) -> LoadStep {
        match self.phase {
            LoadPhase::Loading => match answer.into_loaded() {
                Ok(()) => {
                    self.phase = LoadPhase::Probing;
                    WindowStep::Await {
                        call: RendererCall::ExecuteJavaScript {
                            script: PRINT_READY_SCRIPT,
                            user_gesture: true,
                            race_ms: Some(PRINT_READY_TIMEOUT_MS),
                        },
                        job: self,
                    }
                }
                Err(error) => self.fail(error),
            },
            LoadPhase::Probing => match answer.into_executed() {
                Ok(ExecOutcome::Settled | ExecOutcome::Pending) => {
                    WindowStep::Done(Ok(self.temp_dir))
                }
                Ok(ExecOutcome::Rejected(message)) => {
                    log_probe_error(&message);
                    WindowStep::Done(Ok(self.temp_dir))
                }
                Ok(ExecOutcome::Throws(message)) => self.fail(JsError::plain(message)),
                Err(error) => self.fail(error),
            },
        }
    }

    /// the `catch` of `loadPrintHtml`: the folder goes, then the error is
    /// thrown again; an `rm` that throws replaces it
    fn fail(self, error: JsError) -> LoadStep {
        WindowStep::Done(match rm_recursive_force(&self.temp_dir) {
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

/// Where `printHtmlDocument` waits.
#[derive(Debug)]
enum PrintPhase {
    /// in `loadPrintHtml`
    Loading(PrintLoad),
    /// the system print dialog is open over the document loaded from this dir
    Printing(String),
}

/// `printHtmlDocument` between its awaits.
#[derive(Debug)]
pub struct PrintJob {
    win32: bool,
    phase: PrintPhase,
}

/// A step of `printHtmlDocument`; [`WindowStep::Done`] holds the outcome once
/// the window is destroyed and the temp dir removed, or what that cleanup
/// threw, which replaces the outcome.
pub type PrintStep = WindowStep<PrintJob, Result<PrintDialogOutcome, JsError>>;

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
    after_load(win, win32, loading)
}

impl PrintJob {
    /// The answer to the call this print waits for; a probe that rejects is
    /// reported to `log_probe_error` (`console.error`).
    pub fn resume(
        self,
        win: &mut dyn PrintDialogWindow,
        answer: RendererAnswer,
        log_probe_error: &mut dyn FnMut(&str),
    ) -> PrintStep {
        let win32 = self.win32;
        match self.phase {
            PrintPhase::Loading(load) => {
                after_load(win, win32, load.resume(answer, log_probe_error))
            }
            PrintPhase::Printing(temp_dir) => {
                let outcome = answer.into_printed().map(|result| {
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
                finish_print(win, Some(temp_dir), outcome)
            }
        }
    }
}

fn after_load(win: &mut dyn PrintDialogWindow, win32: bool, loading: LoadStep) -> PrintStep {
    match loading {
        WindowStep::Await { call, job } => WindowStep::Await {
            call,
            job: PrintJob {
                win32,
                phase: PrintPhase::Loading(job),
            },
        },
        WindowStep::Done(Ok(temp_dir)) => open_dialog(win, win32, temp_dir),
        WindowStep::Done(Err(error)) => finish_print(win, None, Err(error)),
    }
}

/// the options of the system print dialog
fn dialog_options() -> Value {
    let mut options = serde_json::Map::new();
    options.insert("silent".into(), Value::Bool(false));
    options.insert("printBackground".into(), Value::Bool(true));
    Value::Object(options)
}

fn open_dialog(win: &mut dyn PrintDialogWindow, win32: bool, temp_dir: String) -> PrintStep {
    // Windows attaches the native dialog to the printed window, which must be visible
    if win32 && let Err(error) = win.show().and_then(|()| win.focus()) {
        return finish_print(win, Some(temp_dir), Err(error));
    }
    WindowStep::Await {
        call: RendererCall::Print {
            options: dialog_options(),
        },
        job: PrintJob {
            win32,
            phase: PrintPhase::Printing(temp_dir),
        },
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
        return WindowStep::Done(Err(rm.into()));
    }
    WindowStep::Done(destroyed.map(|()| outcome))
}
