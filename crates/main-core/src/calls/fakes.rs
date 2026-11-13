//! Fakes of the Electron objects the specs describe, shared by the groups.
//! Each call of a fake is one `logs` line, written as the TypeScript fake of
//! the spec writes it.

use std::cell::RefCell;
use std::collections::VecDeque;

use serde_json::Value;

use crate::packages::electron_utils::message_box::{MessageBox, MessageBoxOptions, ParentWindow};
use crate::packages::electron_utils::print_window::{
    ExecOutcome, JsError, LoadStep, PrintDialogOutcome, PrintDialogWindow, PrintReport, PrintStep,
};

/// What a print window does when the renderer is awaited: a scenario's fake
/// answers at once, so [`drive_print`] plays the Electron adapter and carries
/// out each step of a print on it.
pub(super) trait FakePrintRenderer {
    /// `win.loadFile(path)`
    fn load_file(&mut self, path: &str) -> Result<(), JsError>;
    /// `webContents.executeJavaScript(script, userGesture)` as the race with
    /// the timer came out
    fn execute_javascript(&mut self, script: &str, user_gesture: bool) -> ExecOutcome;
    /// `webContents.print(options, callback)`: what the callback got
    fn print(&mut self, silent: bool, print_background: bool) -> Result<PrintReport, JsError>;
}

/// Every step of `loadPrintHtml` carried out on the fake, up to its end.
pub(super) fn drive_load<W: FakePrintRenderer>(
    mut step: LoadStep,
    win: &mut W,
    log_probe_error: &mut dyn FnMut(&str),
) -> Result<String, JsError> {
    loop {
        step = match step {
            LoadStep::Load { path, load } => load.on_loaded(win.load_file(&path)),
            LoadStep::Probe {
                script,
                user_gesture,
                load,
            } => load.on_probe(
                win.execute_javascript(script, user_gesture),
                log_probe_error,
            ),
            LoadStep::Done(loaded) => return loaded,
        }
    }
}

/// Every step of `printHtmlDocument` carried out on the fake, up to its end.
pub(super) fn drive_print<W: PrintDialogWindow + FakePrintRenderer>(
    mut step: PrintStep,
    win: &mut W,
    log_probe_error: &mut dyn FnMut(&str),
) -> Result<PrintDialogOutcome, JsError> {
    loop {
        step = match step {
            PrintStep::Load { path, job } => {
                let loaded = win.load_file(&path);
                job.on_loaded(win, loaded)
            }
            PrintStep::Probe {
                script,
                user_gesture,
                job,
            } => {
                let outcome = win.execute_javascript(script, user_gesture);
                job.on_probe(win, outcome, log_probe_error)
            }
            PrintStep::Dialog {
                silent,
                print_background,
                job,
            } => {
                let printed = win.print(silent, print_background);
                job.on_printed(win, printed)
            }
            PrintStep::Done(outcome) => return outcome,
        }
    }
}

/// a `BrowserWindow` that answers `isDestroyed`
pub(super) struct FakeWindow {
    pub destroyed: bool,
}

impl ParentWindow for FakeWindow {
    fn is_destroyed(&self) -> bool {
        self.destroyed
    }
}

/// `parent` of the spec: null (none), "live" or "destroyed"
pub(super) fn fake_parent(spec: &Value) -> Option<FakeWindow> {
    match spec.get("parent").and_then(Value::as_str) {
        Some("live") => Some(FakeWindow { destroyed: false }),
        Some("destroyed") => Some(FakeWindow { destroyed: true }),
        _ => None,
    }
}

/// a dialog that answers the spec's `response` (a number, or a list taken one
/// per box, NaN once it runs out) and logs each box: `["over", box]` for the
/// overload with a parent, `["box", box]` for the other
pub(super) struct FakeDialog {
    responses: RefCell<VecDeque<f64>>,
    last: f64,
    pub log: RefCell<Vec<Vec<Value>>>,
}

impl FakeDialog {
    pub fn of(spec: &Value) -> FakeDialog {
        let response = spec.get("response");
        let (responses, last) = match response {
            Some(Value::Array(list)) => (
                list.iter()
                    .map(|v| v.as_f64().unwrap_or(f64::NAN))
                    .collect(),
                f64::NAN,
            ),
            other => (
                VecDeque::new(),
                other.and_then(Value::as_f64).unwrap_or(f64::NAN),
            ),
        };
        FakeDialog {
            responses: RefCell::new(responses),
            last,
            log: RefCell::new(Vec::new()),
        }
    }

    fn answer(&self, overload: &str, options: &MessageBoxOptions) -> f64 {
        self.log.borrow_mut().push(vec![
            Value::from(overload),
            serde_json::to_value(options).expect("a box prints"),
        ]);
        self.responses.borrow_mut().pop_front().unwrap_or(self.last)
    }
}

impl MessageBox<FakeWindow> for FakeDialog {
    fn show_message_box_over(&self, _parent: &FakeWindow, options: &MessageBoxOptions) -> f64 {
        self.answer("over", options)
    }

    fn show_message_box(&self, options: &MessageBoxOptions) -> f64 {
        self.answer("box", options)
    }
}
