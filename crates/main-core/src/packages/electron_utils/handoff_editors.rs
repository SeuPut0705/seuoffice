//! `packages/electron-utils/src/handoff-editors.ts`.
//!
//! The editors that can take a hand-off.

/// every editor that can take a hand-off; each opens it in a new untitled tab
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffEditor {
    Docs,
    Sheets,
    Slides,
    Pdf,
    Markdown,
    Html,
    Mindmap,
    Hwp,
    Epub,
}

impl HandoffEditor {
    pub fn as_str(self) -> &'static str {
        match self {
            HandoffEditor::Docs => "docs",
            HandoffEditor::Sheets => "sheets",
            HandoffEditor::Slides => "slides",
            HandoffEditor::Pdf => "pdf",
            HandoffEditor::Markdown => "markdown",
            HandoffEditor::Html => "html",
            HandoffEditor::Mindmap => "mindmap",
            HandoffEditor::Hwp => "hwp",
            HandoffEditor::Epub => "epub",
        }
    }

    /// the editor named `value`, if any
    pub fn parse(value: &str) -> Option<HandoffEditor> {
        HANDOFF_EDITORS.into_iter().find(|e| e.as_str() == value)
    }
}

pub const HANDOFF_EDITORS: [HandoffEditor; 9] = [
    HandoffEditor::Docs,
    HandoffEditor::Sheets,
    HandoffEditor::Slides,
    HandoffEditor::Pdf,
    HandoffEditor::Markdown,
    HandoffEditor::Html,
    HandoffEditor::Mindmap,
    HandoffEditor::Hwp,
    HandoffEditor::Epub,
];

/// `isHandoffEditor` of a string (a value of another type is not one)
pub fn is_handoff_editor(value: &str) -> bool {
    HandoffEditor::parse(value).is_some()
}

/// The editors whose AI panel takes attachments, so a hand-off can bring the
/// asking tab's saved document along. The markdown and PDF panels have none.
pub const HANDOFF_ATTACH_EDITORS: [HandoffEditor; 6] = [
    HandoffEditor::Docs,
    HandoffEditor::Sheets,
    HandoffEditor::Slides,
    HandoffEditor::Html,
    HandoffEditor::Mindmap,
    HandoffEditor::Hwp,
];

pub fn handoff_editor_takes_attachments(editor: HandoffEditor) -> bool {
    HANDOFF_ATTACH_EDITORS.contains(&editor)
}
