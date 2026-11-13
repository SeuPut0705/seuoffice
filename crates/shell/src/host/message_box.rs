//! `dialog.showMessageBox` (the shared host `Dialogs`): a native message box
//! with any number of buttons, a default and a cancel button, a detail text,
//! an icon by type and an optional checkbox, modal to the parent window, as
//! Electron's is. It runs on the UI thread and blocks its caller, as the
//! contract's section 3 says.
//!
//! - macOS: `NSAlert` ([`mac`]).
//! - Windows: `TaskDialogIndirect`, as Electron's ([`win`]).
//! - elsewhere: `rfd`, which has one to three buttons and no checkbox; a box
//!   outside that is answered as its cancel button and logged.
//!
//! What is the same on every OS is here and tested: the buttons of a box when
//! it names none, which button is the default, which one Escape chooses.

use shell_contract::hosts::{MessageBox, MessageBoxAnswer};
use tauri::Window;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(not(any(target_os = "macos", windows)))]
mod other;
#[cfg(windows)]
mod win;

/// `type` of the options: the icon
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    None,
    Info,
    Warning,
    Error,
    Question,
}

impl Kind {
    fn of(name: Option<&str>) -> Kind {
        match name {
            Some("info") => Kind::Info,
            Some("warning") => Kind::Warning,
            Some("error") => Kind::Error,
            Some("question") => Kind::Question,
            _ => Kind::None,
        }
    }
}

/// A box as every OS shows it: the options, completed the way Electron completes them
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spec {
    pub kind: Kind,
    pub title: Option<String>,
    pub message: String,
    pub detail: Option<String>,
    /// never empty
    pub buttons: Vec<String>,
    /// the button Return presses; none leaves the first
    pub default_id: Option<usize>,
    /// the button Escape and the close box choose, and what a dismissed box answers
    pub cancel_id: usize,
    pub checkbox: Option<String>,
}

impl Spec {
    pub fn of(options: &MessageBox) -> Spec {
        // a box with no buttons has one: OK
        let buttons = if options.buttons.is_empty() {
            vec!["OK".to_owned()]
        } else {
            options.buttons.clone()
        };
        let default_id = options.default_id.filter(|i| *i < buttons.len());
        let cancel_id = cancel_index(&buttons, options.cancel_id);
        Spec {
            kind: Kind::of(options.kind.as_deref()),
            title: options.title.clone().filter(|t| !t.is_empty()),
            message: options.message.clone(),
            detail: options.detail.clone().filter(|d| !d.is_empty()),
            buttons,
            default_id,
            cancel_id,
            checkbox: options.checkbox_label.clone(),
        }
    }

    /// The button Return presses: `defaultId`, else the first
    pub fn effective_default(&self) -> usize {
        self.default_id.unwrap_or(0)
    }
}

/// `cancelId`: the button Escape chooses. When the box names none, Electron
/// takes the first button labelled "cancel" or "no" (any case), else 0. A
/// `cancelId` past the last button is no choice either.
pub fn cancel_index(buttons: &[String], cancel_id: Option<usize>) -> usize {
    if let Some(id) = cancel_id.filter(|i| *i < buttons.len()) {
        return id;
    }
    buttons
        .iter()
        .position(|b| {
            let label = b.trim().to_lowercase();
            label == "cancel" || label == "no"
        })
        .unwrap_or(0)
}

/// Shows the box and waits for its answer. On the UI thread.
pub fn show(options: &MessageBox, parent: Option<&Window>) -> MessageBoxAnswer {
    let spec = Spec::of(options);
    #[cfg(target_os = "macos")]
    return mac::show(&spec, parent);
    #[cfg(windows)]
    return win::show(&spec, parent);
    #[cfg(not(any(target_os = "macos", windows)))]
    return other::show(&spec, parent);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[test]
    fn escape_chooses_the_cancel_id_or_the_cancel_labelled_button_or_the_first() {
        let b = labels(&["Save", "Don't Save", "Cancel"]);
        assert_eq!(cancel_index(&b, Some(1)), 1);
        assert_eq!(cancel_index(&b, None), 2);
        assert_eq!(cancel_index(&labels(&["Yes", " NO "]), None), 1);
        assert_eq!(cancel_index(&labels(&["Replace", "Skip"]), None), 0);
        // an id past the end is no id
        assert_eq!(cancel_index(&b, Some(9)), 2);
        assert_eq!(cancel_index(&labels(&["OK"]), Some(5)), 0);
    }

    #[test]
    fn a_box_is_completed_as_electron_completes_it() {
        let spec = Spec::of(&MessageBox {
            kind: Some("warning".into()),
            title: Some(String::new()),
            message: "Close?".into(),
            detail: Some(String::new()),
            buttons: Vec::new(),
            default_id: Some(3),
            cancel_id: None,
            checkbox_label: Some("Don't ask again".into()),
        });
        assert_eq!(spec.buttons, ["OK"]);
        assert_eq!(spec.kind, Kind::Warning);
        assert_eq!(spec.title, None);
        assert_eq!(spec.detail, None);
        assert_eq!(spec.default_id, None);
        assert_eq!(spec.effective_default(), 0);
        assert_eq!(spec.cancel_id, 0);
        assert_eq!(spec.checkbox.as_deref(), Some("Don't ask again"));

        let five = Spec::of(&MessageBox {
            buttons: labels(&["A", "B", "C", "D", "Cancel"]),
            default_id: Some(1),
            ..MessageBox::default()
        });
        assert_eq!((five.default_id, five.cancel_id), (Some(1), 4));
        assert_eq!(five.kind, Kind::None);
    }
}
