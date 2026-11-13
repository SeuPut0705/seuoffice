//! `apps/shell/src/main/error-dialog.ts`.
//!
//! The TypeScript keeps `showing` at module level and clears it when the
//! dialog's promise settles. Here the caller owns an [`ErrorDialog`]: it asks
//! [`ErrorDialog::show`] what to put on screen (nothing, while a box is up),
//! carries it out through `dialog.showMessageBox`, and calls
//! [`ErrorDialog::settled`] once that box is answered.

use serde::Serialize;
use serde_json::Value;

use crate::packages::electron_utils::message_box::ParentWindow;

/// what `err` was: an `Error`, or anything else a caller threw
#[derive(Debug, Clone, PartialEq)]
pub enum ErrorValue {
    Error {
        message: String,
    },
    /// `undefined`
    Undefined,
    Other(Value),
}

/// the `options` literal: its keys in the order it writes them
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ErrorBoxOptions {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub message: String,
    pub detail: String,
}

/// the box to show, and which overload of `showMessageBox` carries it
#[derive(Debug, Clone, PartialEq)]
pub struct ErrorBox {
    pub options: ErrorBoxOptions,
    /// `showMessageBox(win, options)`; false is `showMessageBox(options)`
    pub over_parent: bool,
}

/// `let showing = false`
#[derive(Debug, Default)]
pub struct ErrorDialog {
    showing: bool,
}

/// `String(err)` for a value that is not an `Error`
fn describe(err: &ErrorValue) -> String {
    match err {
        ErrorValue::Error { message } => message.clone(),
        ErrorValue::Undefined => "undefined".to_owned(),
        ErrorValue::Other(value) => jscompat::value_to_string(Some(value)),
    }
}

impl ErrorDialog {
    pub fn new() -> Self {
        Self::default()
    }

    /// `showErrorDialog(win, message, err)` up to the call of `showMessageBox`;
    /// `None` where it returns at once because a box is already up
    pub fn show<W: ParentWindow>(
        &mut self,
        win: Option<&W>,
        message: &str,
        err: &ErrorValue,
    ) -> Option<ErrorBox> {
        if self.showing {
            return None;
        }
        self.showing = true;
        let options = ErrorBoxOptions {
            kind: "error",
            message: message.to_owned(),
            detail: describe(err),
        };
        let over_parent = matches!(win, Some(win) if !win.is_destroyed());
        Some(ErrorBox {
            options,
            over_parent,
        })
    }

    /// `shown.finally(() => { showing = false })`
    pub fn settled(&mut self) {
        self.showing = false;
    }
}
