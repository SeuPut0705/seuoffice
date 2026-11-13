//! The message box where there is no native one with all of Electron's
//! options (Linux): `rfd`, one to three buttons and no checkbox. A box
//! outside that is answered as its cancel button, and says so.

use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use shell_contract::hosts::MessageBoxAnswer;
use tauri::Window;

use super::{Kind, Spec};

pub fn show(spec: &Spec, parent: Option<&Window>) -> MessageBoxAnswer {
    let cancelled = |why: &str| {
        eprintln!(
            "shell: dialog.showMessageBox: {why}; answered as button {}: '{}'",
            spec.cancel_id, spec.message
        );
        MessageBoxAnswer {
            response: spec.cancel_id,
            checkbox_checked: false,
        }
    };
    if spec.checkbox.is_some() {
        return cancelled("a checkbox is not supported by this platform's dialog");
    }
    let buttons = match spec.buttons.as_slice() {
        [a] => MessageButtons::OkCustom(a.clone()),
        [a, b] => MessageButtons::OkCancelCustom(a.clone(), b.clone()),
        [a, b, c] => MessageButtons::YesNoCancelCustom(a.clone(), b.clone(), c.clone()),
        _ => {
            return cancelled(
                "more than three buttons are not supported by this platform's dialog",
            );
        }
    };
    let mut dialog = MessageDialog::new()
        .set_level(match spec.kind {
            Kind::Error => MessageLevel::Error,
            Kind::Warning => MessageLevel::Warning,
            _ => MessageLevel::Info,
        })
        .set_buttons(buttons)
        .set_description(match &spec.detail {
            Some(detail) if !spec.message.is_empty() => format!("{}\n\n{detail}", spec.message),
            Some(detail) => detail.clone(),
            None => spec.message.clone(),
        });
    if let Some(title) = &spec.title {
        dialog = dialog.set_title(title);
    }
    if let Some(parent) = parent {
        dialog = dialog.set_parent(parent);
    }
    let response = match dialog.show() {
        MessageDialogResult::Custom(label) => spec.buttons.iter().position(|b| *b == label),
        MessageDialogResult::Ok | MessageDialogResult::Yes => Some(0),
        MessageDialogResult::Cancel | MessageDialogResult::No => Some(spec.cancel_id),
    };
    MessageBoxAnswer {
        // a closed dialog (Escape, the close box) is the cancel button
        response: response.unwrap_or(spec.cancel_id),
        checkbox_checked: false,
    }
}
