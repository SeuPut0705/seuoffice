//! `apps/sheets/src/main/session-reopen.ts`.

use serde_json::{Map, Value};

/// A sheets session as the re-open reads it: a JSON object, a key a JSON
/// `undefined` would be left out.
pub type Session = Map<String, Value>;

/// What the open pipeline is told again so the twin remembers the same things.
pub const CARRIED: [&str; 13] = [
    "suggestSaveAs",
    "csvImport",
    "csvSourcePath",
    "restoreTarget",
    "emptySource",
    "unsavedNew",
    "password",
    "recoveryIdentity",
    "recoveryOriginalPath",
    "unsavedRestore",
    "odsConverted",
    "formulasDropped",
    "odsSourcePath",
];

/// `session[key] !== undefined` (a `null` is defined)
fn defined(session: &Session, key: &str) -> bool {
    session.contains_key(key)
}

/// `session[key] === true`
fn is_true(session: &Session, key: &str) -> bool {
    session.get(key) == Some(&Value::Bool(true))
}

/// The path the renderer knows the session by: `restoreTarget ?? path`
fn renderer_path(session: &Session) -> Option<&Value> {
    match session.get("restoreTarget") {
        None | Some(Value::Null) => session.get("path"),
        target => target,
    }
}

/// True when opening `session.path` as an ordinary file would forget something.
fn remembers_its_open(session: &Session) -> bool {
    defined(session, "suggestSaveAs")
        || defined(session, "csvSourcePath")
        || defined(session, "importTempDir")
        || defined(session, "restoreTarget")
        || is_true(session, "unsavedNew")
        || defined(session, "password")
        || is_true(session, "unsavedRestore")
        || defined(session, "odsSourcePath")
}

/// The session a re-open of `path` continues, or `None` when a plain open by
/// path loses nothing. The latest matching session wins.
pub fn session_to_continue<'a>(sessions: &'a [Session], path: &str) -> Option<&'a Session> {
    let mut found = None;
    for session in sessions {
        let on_path = matches!(renderer_path(session), Some(Value::String(p)) if p == path);
        if on_path && remembers_its_open(session) {
            found = Some(session);
        }
    }
    found
}

/// The open options that make the twin: the carried fields the session holds,
/// in the order of [`CARRIED`]. The import directory is left out on purpose.
pub fn continued_open_options(session: &Session) -> Session {
    CARRIED
        .iter()
        .filter_map(|key| {
            session
                .get(*key)
                .map(|value| ((*key).to_owned(), value.clone()))
        })
        .collect()
}
