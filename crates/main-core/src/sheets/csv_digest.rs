//! `apps/sheets/src/main/csv-digest.ts`.

use jscompat::{JsMap, number_to_string};
use serde_json::{Map, Value};

/// A sheets session as `refreshCsvDigest` reads it: a JSON object holding at
/// least the two fields `csvSourcePath` and `csvSourceSha` (when set).
pub type Session = Map<String, Value>;

/// dev+ino for a path, or `None` when it names nothing. Two spellings of one
/// path get the same pair. Where the file system reports no inode (ino 0) the
/// spelling itself is the identity again.
fn file_identity(path: &str) -> Option<String> {
    // `statSync` follows links; a path Node refuses (a NUL) names nothing
    let (dev, ino) = crate::shell::rename_validation::file_identity(path)?;
    // a file system without inode numbers answers 0: the spelling stands in
    if ino == 0.0 {
        return Some(path.to_owned());
    }
    Some(format!(
        "{}:{}",
        number_to_string(dev),
        number_to_string(ino)
    ))
}

/// Point every session whose CSV source is the file just written at its new
/// digest, so its next Save does not read this export as an external change.
/// Matched on dev+ino rather than spelling.
pub fn refresh_csv_digest(sessions: &mut JsMap<Session>, target_path: &str, written_sha: &str) {
    let Some(target_id) = file_identity(target_path) else {
        return;
    };
    let ids: Vec<String> = sessions.keys().map(str::to_owned).collect();
    for session_id in ids {
        let Some(session) = sessions.get(&session_id) else {
            continue;
        };
        // `statSync(undefined)` throws and names nothing, as a non-string does
        let Some(Value::String(source)) = session.get("csvSourcePath") else {
            continue;
        };
        if file_identity(source).as_deref() == Some(target_id.as_str()) {
            // `{ ...session, csvSourceSha }`: a key that is there keeps its place
            let mut next = session.clone();
            next.insert("csvSourceSha".to_owned(), Value::from(written_sha));
            sessions.set(session_id, next);
        }
    }
}
