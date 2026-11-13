//! `packages/electron-utils/src/marked-odt.ts`: the message box an editor
//! shows before it writes content marked "hidden from AI" as an ODT, which
//! cannot hold the mark, and the choice each of its buttons means. The box is
//! described here and shown by the app's main process.

use serde::Serialize;

/// `MarkedOdtChoice`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkedOdtChoice {
    Docx,
    Clear,
    Cancel,
}

/// `MarkedOdtText`: the words of the box, in the app's language.
#[derive(Debug, Clone, PartialEq)]
pub struct MarkedOdtText {
    pub title: String,
    pub message: String,
    pub detail: String,
    /// `None`: the app's Word export cannot keep the hiding either, so Word is
    /// not offered
    pub save_docx: Option<String>,
    pub clear_marks: String,
    pub cancel: String,
}

/// `MarkedOdtBox`, its keys in the order of the literal.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkedOdtBox {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub title: String,
    pub message: String,
    pub detail: String,
    pub buttons: Vec<String>,
    pub default_id: u8,
    pub cancel_id: usize,
    pub no_link: bool,
}

/// `markedOdtBox(text)`
pub fn marked_odt_box(text: &MarkedOdtText) -> MarkedOdtBox {
    let buttons = match &text.save_docx {
        None => vec![text.clear_marks.clone(), text.cancel.clone()],
        Some(save_docx) => vec![
            save_docx.clone(),
            text.clear_marks.clone(),
            text.cancel.clone(),
        ],
    };
    MarkedOdtBox {
        kind: "warning",
        title: text.title.clone(),
        message: text.message.clone(),
        detail: text.detail.clone(),
        cancel_id: buttons.len() - 1,
        buttons,
        default_id: 0,
        no_link: true,
    }
}

/// `markedOdtChoice(response, withDocx)`: the button pressed in the box
/// (`with_docx`: Word was offered); anything else, closing the box among
/// them, is a cancel.
pub fn marked_odt_choice(response: f64, with_docx: bool) -> MarkedOdtChoice {
    if !with_docx {
        return if response == 0.0 {
            MarkedOdtChoice::Clear
        } else {
            MarkedOdtChoice::Cancel
        };
    }
    if response == 0.0 {
        MarkedOdtChoice::Docx
    } else if response == 1.0 {
        MarkedOdtChoice::Clear
    } else {
        MarkedOdtChoice::Cancel
    }
}
