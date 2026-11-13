//! The process's one dialog memory, used without holding its lock while a
//! dialog is open. A dialog can stay open for minutes, and other threads
//! (M's Save Image As, D2's dialogs) take the same memory meanwhile.
//!
//! The rule: copy the memory under a short lock and build the dialog's
//! options from the copy; the moment the native dialog returns, record its
//! answer in the shared memory under a short lock, by main-core's own rule
//! (a confirmed pick is remembered even when it equals what was copied; a
//! cancel records nothing). Whatever the caller does after the dialog (a
//! file write that stalls) cannot move that moment. The last confirmed pick
//! wins, as with TypeScript's single `lastUsedDirectoryByDialog` map:
//! - A copies /old, B confirms /new, A confirms /old: /old stays;
//! - A confirms /a and its write stalls, B confirms /b, A's write ends: /b stays.

use std::marker::PhantomData;
use std::sync::{Mutex, MutexGuard, PoisonError};

use jscompat::{JsObject, JsonValue};
use main_core::packages::electron_utils::dialog_memory::{
    Dialog, DialogMemory, show_open_dialog_with_memory, show_save_dialog_with_memory,
};

/// Runs `run` with a copy of `shared` and `dialog` wrapped so each answer
/// is recorded in `shared` as the dialog returns it. `run` passes both to
/// main-core's `show_*_dialog_with_memory` (or `save_fetched_image` and the
/// like). The lock is never held while the dialog is open.
pub fn with_shared_memory<D: Dialog, R>(
    shared: &Mutex<DialogMemory>,
    dialog: &mut D,
    run: impl FnOnce(&mut DialogMemory, &mut Recording<'_, D>) -> R,
) -> R {
    let mut copy = lock(shared).clone();
    run(&mut copy, &mut Recording { dialog, shared })
}

/// A dialog whose answers go to the shared memory as they come back
pub struct Recording<'a, D> {
    dialog: &'a mut D,
    shared: &'a Mutex<DialogMemory>,
}

impl<D: Dialog> Dialog for Recording<'_, D> {
    type Window = D::Window;

    fn show_open_dialog(
        &mut self,
        parent: Option<&Self::Window>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let answer = self.dialog.show_open_dialog(parent, options);
        // main-core remembers it or not, by `properties` and `filePaths`,
        // both unchanged in the options the dialog got
        show_open_dialog_with_memory(
            &mut lock(self.shared),
            &mut Answered::new(&answer),
            parent,
            options,
            None,
        );
        answer
    }

    fn show_save_dialog(
        &mut self,
        parent: Option<&Self::Window>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let answer = self.dialog.show_save_dialog(parent, options);
        show_save_dialog_with_memory(
            &mut lock(self.shared),
            &mut Answered::new(&answer),
            parent,
            options,
            None,
        );
        answer
    }
}

/// A dialog that answers what the user already answered
struct Answered<'a, W> {
    answer: &'a JsonValue,
    window: PhantomData<fn(&W)>,
}

impl<'a, W> Answered<'a, W> {
    fn new(answer: &'a JsonValue) -> Self {
        Self {
            answer,
            window: PhantomData,
        }
    }
}

impl<W> Dialog for Answered<'_, W> {
    type Window = W;
    fn show_open_dialog(&mut self, _: Option<&W>, _: &JsObject<JsonValue>) -> JsonValue {
        self.answer.clone()
    }
    fn show_save_dialog(&mut self, _: Option<&W>, _: &JsObject<JsonValue>) -> JsonValue {
        self.answer.clone()
    }
}

fn lock(shared: &Mutex<DialogMemory>) -> MutexGuard<'_, DialogMemory> {
    // a dialog that panicked left a whole value behind: the memory stays usable
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(pairs: &[(&str, JsonValue)]) -> JsonValue {
        let mut o = JsObject::new();
        for (k, v) in pairs {
            o.set(*k, v.clone());
        }
        JsonValue::Object(o)
    }

    fn open_pick(path: &str) -> JsonValue {
        object(&[
            ("canceled", JsonValue::Bool(false)),
            (
                "filePaths",
                JsonValue::Array(vec![JsonValue::String(path.into())]),
            ),
        ])
    }

    fn save_pick(path: &str) -> JsonValue {
        object(&[
            ("canceled", JsonValue::Bool(false)),
            ("filePath", JsonValue::String(path.into())),
        ])
    }

    fn cancel() -> JsonValue {
        object(&[
            ("canceled", JsonValue::Bool(true)),
            ("filePaths", JsonValue::Array(vec![])),
        ])
    }

    /// The user's answer, given after `meanwhile` (other dialogs that ran
    /// while this one was open); asserts the shared lock is free then
    struct User<'a> {
        shared: &'a Mutex<DialogMemory>,
        answer: JsonValue,
        meanwhile: Option<Box<dyn FnOnce() + 'a>>,
    }

    impl User<'_> {
        fn answer(&mut self) -> JsonValue {
            assert!(
                self.shared.try_lock().is_ok(),
                "the lock is held while the dialog is open"
            );
            if let Some(meanwhile) = self.meanwhile.take() {
                meanwhile();
            }
            self.answer.clone()
        }
    }

    impl Dialog for User<'_> {
        type Window = ();
        fn show_open_dialog(&mut self, _: Option<&()>, _: &JsObject<JsonValue>) -> JsonValue {
            self.answer()
        }
        fn show_save_dialog(&mut self, _: Option<&()>, _: &JsObject<JsonValue>) -> JsonValue {
            self.answer()
        }
    }

    fn user<'a>(
        shared: &'a Mutex<DialogMemory>,
        answer: JsonValue,
        meanwhile: impl FnOnce() + 'a,
    ) -> User<'a> {
        User {
            shared,
            answer,
            meanwhile: Some(Box::new(meanwhile)),
        }
    }

    /// An open dialog through the helper; `after` runs once it returned,
    /// still inside the operation (the file write of a save)
    fn open<'a>(
        shared: &'a Mutex<DialogMemory>,
        answer: JsonValue,
        meanwhile: impl FnOnce() + 'a,
        after: impl FnOnce(),
    ) {
        with_shared_memory(shared, &mut user(shared, answer, meanwhile), |m, d| {
            show_open_dialog_with_memory(m, d, None, &JsObject::new(), None);
            after();
        });
    }

    fn save<'a>(
        shared: &'a Mutex<DialogMemory>,
        answer: JsonValue,
        meanwhile: impl FnOnce() + 'a,
        after: impl FnOnce(),
    ) {
        with_shared_memory(shared, &mut user(shared, answer, meanwhile), |m, d| {
            show_save_dialog_with_memory(m, d, None, &JsObject::new(), None);
            after();
        });
    }

    /// The folder the shared memory would offer the next dialog
    fn remembered(shared: &Mutex<DialogMemory>) -> Option<String> {
        struct Offered(Option<JsonValue>);
        impl Dialog for Offered {
            type Window = ();
            fn show_open_dialog(&mut self, _: Option<&()>, o: &JsObject<JsonValue>) -> JsonValue {
                self.0 = o.get("defaultPath").cloned();
                cancel()
            }
            fn show_save_dialog(&mut self, _: Option<&()>, _: &JsObject<JsonValue>) -> JsonValue {
                unreachable!()
            }
        }
        let mut offered = Offered(None);
        show_open_dialog_with_memory(
            &mut lock(shared),
            &mut offered,
            None,
            &JsObject::new(),
            None,
        );
        match offered.0 {
            Some(JsonValue::String(dir)) => Some(dir),
            _ => None,
        }
    }

    fn remembering(dir: &str) -> Mutex<DialogMemory> {
        let shared = Mutex::new(DialogMemory::new());
        open(&shared, open_pick(&format!("{dir}/f.txt")), || {}, || {});
        assert_eq!(remembered(&shared).as_deref(), Some(dir));
        shared
    }

    #[test]
    fn the_last_confirmed_pick_wins_even_when_it_equals_the_copy() {
        let shared = remembering("/old");
        // A copies /old; while A's dialog is open, B confirms /new; A confirms /old
        open(
            &shared,
            open_pick("/old/a.txt"),
            || {
                open(&shared, open_pick("/new/b.txt"), || {}, || {});
                assert_eq!(remembered(&shared).as_deref(), Some("/new"));
            },
            || {},
        );
        assert_eq!(remembered(&shared).as_deref(), Some("/old"));
    }

    #[test]
    fn a_cancel_records_nothing() {
        let shared = remembering("/old");
        // B confirms /new while A's dialog is open; A cancels: B's pick stays
        open(
            &shared,
            cancel(),
            || open(&shared, open_pick("/new/b.txt"), || {}, || {}),
            || {},
        );
        assert_eq!(remembered(&shared).as_deref(), Some("/new"));
    }

    #[test]
    fn a_pick_is_recorded_when_the_dialog_returns_not_when_the_operation_ends() {
        let shared = remembering("/old");
        // A confirms /a and its write stalls; B confirms /b and finishes; A's
        // write ends: B confirmed last, /b stays
        save(
            &shared,
            save_pick("/a/one.png"),
            || {},
            || {
                assert_eq!(remembered(&shared).as_deref(), Some("/a"));
                save(&shared, save_pick("/b/two.png"), || {}, || {});
            },
        );
        assert_eq!(remembered(&shared).as_deref(), Some("/b"));
    }

    #[test]
    fn a_folder_pick_remembers_the_folder_itself() {
        let shared = Mutex::new(DialogMemory::new());
        let options = object(&[(
            "properties",
            JsonValue::Array(vec![JsonValue::String("openDirectory".into())]),
        )]);
        let JsonValue::Object(options) = options else {
            unreachable!()
        };
        with_shared_memory(
            &shared,
            &mut user(&shared, open_pick("/picked/dir"), || {}),
            |m, d| show_open_dialog_with_memory(m, d, None, &options, None),
        );
        assert_eq!(remembered(&shared).as_deref(), Some("/picked/dir"));
    }
}
