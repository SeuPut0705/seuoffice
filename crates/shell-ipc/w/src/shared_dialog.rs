//! The process's one dialog memory, used without holding its lock while a
//! dialog is open. A dialog can stay open for minutes, and other threads
//! (M's Save Image As, D2's dialogs) take the same memory meanwhile.
//!
//! The rule: copy the memory under a short lock, show the dialog with the
//! copy, and on a confirmed pick write the copy back under a short lock even
//! when it equals what was copied. A cancel writes nothing. The last confirmed
//! pick wins, as with TypeScript's single `lastUsedDirectoryByDialog` map: A
//! copies /old, B confirms /new, A confirms /old, and /old stays.

use std::sync::Mutex;

use jscompat::JsonValue;

/// Runs `show` with a copy of `shared`. `show` answers its result and
/// whether the user confirmed a pick; only a confirmed pick writes the copy
/// back. The lock is never held while `show` runs.
pub fn with_shared_memory<M: Clone, R>(
    shared: &Mutex<M>,
    show: impl FnOnce(&mut M) -> (R, bool),
) -> R {
    let mut copy = lock(shared).clone();
    let (result, confirmed) = show(&mut copy);
    if confirmed {
        *lock(shared) = copy;
    }
    result
}

fn lock<M>(shared: &Mutex<M>) -> std::sync::MutexGuard<'_, M> {
    // a dialog that panicked left a whole value behind: the memory stays usable
    shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn canceled(result: &JsonValue) -> bool {
    match result {
        JsonValue::Object(object) => object.get("canceled").is_some_and(JsonValue::truthy),
        _ => false,
    }
}

/// The pick `showOpenDialogWithMemory` remembers: not canceled, with a
/// non-empty `filePaths[0]`
pub fn open_confirmed(result: &JsonValue) -> bool {
    let JsonValue::Object(object) = result else {
        return false;
    };
    let first = match object.get("filePaths") {
        Some(JsonValue::Array(paths)) => paths.first(),
        _ => None,
    };
    !canceled(result) && matches!(first, Some(JsonValue::String(path)) if !path.is_empty())
}

/// The pick `showSaveDialogWithMemory` remembers: not canceled, with a
/// non-empty `filePath`
pub fn save_confirmed(result: &JsonValue) -> bool {
    let JsonValue::Object(object) = result else {
        return false;
    };
    !canceled(result)
        && matches!(object.get("filePath"), Some(JsonValue::String(path)) if !path.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use jscompat::JsObject;

    fn pick(confirmed: bool, path: &str) -> JsonValue {
        let mut result = JsObject::new();
        result.set("canceled", JsonValue::Bool(!confirmed));
        result.set(
            "filePaths",
            JsonValue::Array(if confirmed {
                vec![JsonValue::String(path.into())]
            } else {
                vec![]
            }),
        );
        JsonValue::Object(result)
    }

    /// One dialog that remembers the folder of its pick, as the memory does
    fn dialog(shared: &Mutex<String>, answer: JsonValue, meanwhile: impl FnOnce()) -> JsonValue {
        with_shared_memory(shared, |memory| {
            // the dialog is open: another thread can take the memory
            assert!(
                shared.try_lock().is_ok(),
                "the lock is held while the dialog is open"
            );
            meanwhile();
            let confirmed = open_confirmed(&answer);
            if confirmed
                && let JsonValue::Object(o) = &answer
                && let Some(JsonValue::Array(paths)) = o.get("filePaths")
                && let Some(JsonValue::String(path)) = paths.first()
            {
                *memory = path.clone();
            }
            (answer, confirmed)
        })
    }

    #[test]
    fn the_last_confirmed_pick_wins_even_when_it_equals_the_copy() {
        let shared = Mutex::new(String::from("/old"));
        // A copies /old; while A's dialog is open, B confirms /new; A confirms /old
        dialog(&shared, pick(true, "/old"), || {
            dialog(&shared, pick(true, "/new"), || {});
            assert_eq!(*shared.lock().unwrap(), "/new");
        });
        assert_eq!(*shared.lock().unwrap(), "/old");
    }

    #[test]
    fn a_cancel_writes_nothing() {
        let shared = Mutex::new(String::from("/old"));
        // B confirms /new while A's dialog is open; A cancels: B's pick stays
        let answer = dialog(&shared, pick(false, ""), || {
            dialog(&shared, pick(true, "/new"), || {});
        });
        assert!(!open_confirmed(&answer));
        assert_eq!(*shared.lock().unwrap(), "/new");
    }

    #[test]
    fn confirmation_follows_the_memorys_own_rule() {
        let object = |pairs: &[(&str, JsonValue)]| {
            let mut o = JsObject::new();
            for (k, v) in pairs {
                o.set(*k, v.clone());
            }
            JsonValue::Object(o)
        };
        let s = |t: &str| JsonValue::String(t.into());
        assert!(open_confirmed(&pick(true, "/a/b")));
        assert!(!open_confirmed(&pick(true, "")));
        assert!(!open_confirmed(&object(&[
            ("canceled", JsonValue::Bool(true)),
            ("filePaths", JsonValue::Array(vec![s("/a")])),
        ])));
        assert!(save_confirmed(&object(&[
            ("canceled", JsonValue::Bool(false)),
            ("filePath", s("/a/b.docx"))
        ])));
        assert!(save_confirmed(&object(&[("filePath", s("/a/b.docx"))])));
        assert!(!save_confirmed(&object(&[
            ("canceled", JsonValue::Bool(true)),
            ("filePath", s("/a/b.docx"))
        ])));
        assert!(!save_confirmed(&object(&[
            ("canceled", JsonValue::Bool(false)),
            ("filePath", s(""))
        ])));
        assert!(!save_confirmed(&JsonValue::Null));
    }
}
