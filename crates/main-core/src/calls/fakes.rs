//! Fakes of the Electron objects the specs describe, shared by the groups.
//! Each call of a fake is one `logs` line, written as the TypeScript fake of
//! the spec writes it.

use std::cell::RefCell;
use std::collections::VecDeque;

use serde_json::Value;

use crate::packages::electron_utils::message_box::{MessageBox, MessageBoxOptions, ParentWindow};

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
