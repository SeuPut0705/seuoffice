//! `dialog.showMessageBox` of Electron, as the modules that ask a question
//! call it: over a window that is still open, or without a parent. The
//! adapter implements [`MessageBox`] with Electron's `dialog` and
//! [`ParentWindow`] with a `BrowserWindow`; the comparison with fakes.
//! Promises are plain calls.

use serde::Serialize;

/// the options `showMessageBox` is given, its keys in the order the modules'
/// literals write them; a `None` is a key the literal leaves out
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBoxOptions {
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub buttons: Vec<String>,
    pub default_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancel_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_link: Option<bool>,
}

/// the `isDestroyed` of the window a box sits over
pub trait ParentWindow {
    fn is_destroyed(&self) -> bool;
}

/// both overloads of `showMessageBox`, each answering the `response` index of
/// the pressed button
pub trait MessageBox<W> {
    /// `showMessageBox(parent, box)`
    fn show_message_box_over(&self, parent: &W, options: &MessageBoxOptions) -> f64;
    /// `showMessageBox(box)`
    fn show_message_box(&self, options: &MessageBoxOptions) -> f64;
}

/// `parent && !parent.isDestroyed() ? showMessageBox(parent, box) :
/// showMessageBox(box)`
pub fn show_over_open_parent<D, W>(
    dialog: &D,
    parent: Option<&W>,
    options: &MessageBoxOptions,
) -> f64
where
    D: MessageBox<W> + ?Sized,
    W: ParentWindow,
{
    match parent {
        Some(parent) if !parent.is_destroyed() => dialog.show_message_box_over(parent, options),
        _ => dialog.show_message_box(options),
    }
}
