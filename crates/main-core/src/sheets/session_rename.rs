//! `apps/sheets/src/main/session-rename.ts`.

use jscompat::js_regex;
use serde_json::{Map, Value};

/// A sheets session as the rename reads it: a JSON object, its keys in the
/// order the TypeScript object has them (`path`, `suggestSaveAs`,
/// `csvSourcePath`, `restoreTarget`, `odsSourcePath` and whatever else the
/// session carries, which a spread copies along). Integer-like keys would be
/// reordered by JavaScript and are not by this map: a session has none.
pub type Session = Map<String, Value>;

/// Replace the extension of `path` with `.xlsx` — mirrors the Save As default for converted copies.
pub fn xlsx_sibling_of(path: &str) -> String {
    js_regex!(r"\.[^.]+$", "g").replace_all(path, |_| ".xlsx".to_owned())
}

/// `session[key] === text`
fn field_is(session: &Session, key: &str, text: &str) -> bool {
    matches!(session.get(key), Some(Value::String(s)) if s == text)
}

/// The session as it should look after `old_path` was renamed to `new_path`,
/// or `None` when the session has nothing to do with `old_path`.
pub fn session_after_rename(session: &Session, old_path: &str, new_path: &str) -> Option<Session> {
    let mut next: Option<Session> = None;
    // `{ ...(next ?? session), ...fields }`: a key that is there keeps its place
    let mut patch = |key: &str, value: &str| {
        next.get_or_insert_with(|| session.clone())
            .insert(key.to_owned(), Value::from(value));
    };
    if field_is(session, "path", old_path) {
        patch("path", new_path);
    }
    if field_is(session, "csvSourcePath", old_path) {
        patch("csvSourcePath", new_path);
    }
    if field_is(session, "restoreTarget", old_path) {
        patch("restoreTarget", new_path);
    }
    if field_is(session, "odsSourcePath", old_path) {
        patch("odsSourcePath", new_path);
    }
    // A converted .xls/.tsv copy is tied to its original only through the Save
    // As default derived from it; re-derive from the new name.
    if session.get("suggestSaveAs").is_some()
        && !field_is(session, "path", old_path)
        && field_is(session, "suggestSaveAs", &xlsx_sibling_of(old_path))
    {
        patch("suggestSaveAs", &xlsx_sibling_of(new_path));
    }
    next
}
