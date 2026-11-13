//! Fakes of the Electron objects the specs describe, shared by the groups.
//! Each call of a fake is one `logs` line, written as the TypeScript fake of
//! the spec writes it.

use std::cell::RefCell;
use std::collections::VecDeque;

use serde_json::Value;

use crate::packages::electron_utils::message_box::{MessageBox, MessageBoxOptions, ParentWindow};
use crate::packages::electron_utils::print_html_pdf::{PdfStep, PrintWindow};
use crate::packages::electron_utils::print_window::{
    JsError, LoadStep, PrintDialogOutcome, PrintDialogWindow, PrintStep, RendererAnswer,
    RendererCall, WindowStep,
};

/// A window whose renderer a scenario scripts: it answers each call at once,
/// so the drivers below play the Electron adapter and carry out every step of
/// a job on it.
pub(super) trait FakeRenderer {
    /// what `call` comes to; a call the scenario lets hang until the job's
    /// watchdog fires is [`RendererAnswer::TimedOut`]
    fn answer(&mut self, call: &RendererCall) -> RendererAnswer;
}

/// Every step of `loadPrintHtml` carried out on the fake, up to its end.
pub(super) fn drive_load<W: FakeRenderer>(
    mut step: LoadStep,
    win: &mut W,
    log_probe_error: &mut dyn FnMut(&str),
) -> Result<String, JsError> {
    loop {
        step = match step {
            WindowStep::Await { call, job } => job.resume(win.answer(&call), log_probe_error),
            WindowStep::Done(loaded) => return loaded,
        }
    }
}

/// Every step of `printHtmlDocument` carried out on the fake, up to its end.
pub(super) fn drive_print<W: PrintDialogWindow + FakeRenderer>(
    mut step: PrintStep,
    win: &mut W,
    log_probe_error: &mut dyn FnMut(&str),
) -> Result<PrintDialogOutcome, JsError> {
    loop {
        step = match step {
            WindowStep::Await { call, job } => {
                let answer = win.answer(&call);
                job.resume(win, answer, log_probe_error)
            }
            WindowStep::Done(outcome) => return outcome,
        }
    }
}

/// Every step of a PDF job carried out on the window it made, up to its end.
pub(super) fn drive_pdf<W: PrintWindow + FakeRenderer>(
    mut step: PdfStep<W>,
) -> Result<Vec<u8>, JsError> {
    loop {
        step = match step {
            WindowStep::Await { call, mut job } => {
                let answer = job.window().answer(&call);
                job.resume(answer)
            }
            WindowStep::Done(pdf) => return pdf,
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
