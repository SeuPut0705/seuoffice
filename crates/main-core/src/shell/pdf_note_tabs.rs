//! `apps/shell/src/main/pdf-note-tabs.ts`.
//!
//! The Markdown tab's `webContents` is a type parameter of the host: the
//! functions here call only `isDestroyed` on it and hand it to the queue.

use jscompat::node_path::host::is_absolute;
use jscompat::{JsonValue, js_regex};

/// The part of the note tab's `webContents` this module calls
/// (`NoteAppendContents.isDestroyed`).
pub trait NoteAppendContents {
    fn is_destroyed(&self) -> bool;
}

/// `NoteTabHost`
pub trait NoteTabHost {
    type Contents: NoteAppendContents;
    /// the Markdown tab or detached window showing this file, brought forward;
    /// `None` when none
    fn focus_existing(&mut self, path: &str) -> Option<Self::Contents>;
    /// open the file in a new Markdown tab; its webContents (`None` without a window)
    fn open_new(&mut self, path: &str) -> Option<Self::Contents>;
}

/// `isNoteFile(path)` of a path that is a string: an absolute path of an
/// existing .md file
pub fn is_note_path(path: &str) -> bool {
    if !is_absolute(path) || !js_regex!(r"\.md$", "i").test(path) {
        return false;
    }
    // existsSync(path) && statSync(path).isFile(): one stat answers both
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

/// `isNoteFile(path)`: anything that is not a string is no note file
pub fn is_note_file(path: Option<&JsonValue>) -> bool {
    match path {
        Some(JsonValue::String(path)) => is_note_path(path),
        _ => false,
    }
}

/// `openNoteTab(host, path)`: bring the note's tab forward or open it; its
/// webContents, `None` when it cannot be shown
pub fn open_note_tab<H: NoteTabHost>(host: &mut H, path: &str) -> Option<H::Contents> {
    if !is_note_path(path) {
        return None;
    }
    host.focus_existing(path).or_else(|| host.open_new(path))
}

/// `insertIntoNoteTab(host, path, text, queue)`: show the note's tab and hand
/// it `text` to append at the end of its document. `queue` is
/// `queueMarkdownNoteAppendFor` in the shell.
pub fn insert_into_note_tab<H: NoteTabHost>(
    host: &mut H,
    path: &str,
    text: Option<&JsonValue>,
    queue: &mut dyn FnMut(&H::Contents, &str, &str),
) -> bool {
    // `typeof text !== 'string' || !text.trim()`
    let text = match text {
        Some(JsonValue::String(text)) if !jscompat::trim(text).is_empty() => text,
        _ => return false,
    };
    let Some(contents) = open_note_tab(host, path) else {
        return false;
    };
    if contents.is_destroyed() {
        return false;
    }
    queue(&contents, path, text);
    true
}
