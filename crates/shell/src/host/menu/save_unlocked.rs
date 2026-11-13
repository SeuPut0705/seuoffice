//! `saveImageFromUrl`'s dialog without holding the process's shared dialog
//! memory while the user picks. W's core-thread handlers lock the same
//! memory, so a dialog open under that lock would stall the core thread for
//! as long as it stays open.
//!
//! Three short steps, all through main-core's own functions:
//! 1. under the lock, the options the dialog would get, anchored in the
//!    remembered folder ([`anchored_options`]);
//! 2. without the lock, the dialog itself and the file written
//!    ([`save_picked`]);
//! 3. under the lock again, a confirmed pick remembered ([`remember_pick`]).
//!
//! A cancel remembers nothing; a confirmation is remembered even when it is
//! the folder already remembered, so the last confirmation wins, as with the
//! TypeScript's one map.

use std::sync::Mutex;

use jscompat::{JsObject, JsonValue};
use main_core::packages::electron_utils::dialog_memory::{
    Dialog, DialogMemory, show_save_dialog_with_memory,
};
use main_core::packages::electron_utils::save_image::{
    DecodedImage, SaveImageOptions, SaveImageResult, save_fetched_image,
};

/// Step 1: the options `save_fetched_image` would show, anchored in what
/// `memory` remembers. Runs main-core's own option building with a dialog
/// that only records them and answers canceled, so nothing is written and
/// nothing remembered.
pub(super) fn anchored_options<W>(
    memory: &Mutex<DialogMemory>,
    parent: Option<&W>,
    url: &str,
    mime: Option<String>,
    opts: &SaveImageOptions<'_>,
) -> JsObject<JsonValue> {
    let mut capture = Capture::<W>::default();
    let probe = DecodedImage {
        bytes: Vec::new(),
        mime,
    };
    let mut memory = memory.lock().unwrap_or_else(|p| p.into_inner());
    save_fetched_image(&mut memory, &mut capture, parent, url, probe, opts);
    capture.options.unwrap_or_default()
}

/// Step 2: `answer` is what the real dialog gave for `options`; the image is
/// written as `save_fetched_image` writes it. No shared state is touched.
pub(super) fn save_picked<W>(
    parent: Option<&W>,
    url: &str,
    image: DecodedImage,
    opts: &SaveImageOptions<'_>,
    answer: &JsonValue,
) -> SaveImageResult {
    let mut replay = Replay::<W>::new(answer.clone());
    save_fetched_image(
        &mut DialogMemory::new(),
        &mut replay,
        parent,
        url,
        image,
        opts,
    )
}

/// Step 3: a confirmed pick becomes the remembered folder; a cancel leaves
/// the memory as another dialog may have left it meanwhile.
pub(super) fn remember_pick<W>(
    memory: &Mutex<DialogMemory>,
    parent: Option<&W>,
    options: &JsObject<JsonValue>,
    answer: &JsonValue,
) {
    let mut replay = Replay::<W>::new(answer.clone());
    let mut memory = memory.lock().unwrap_or_else(|p| p.into_inner());
    show_save_dialog_with_memory(&mut memory, &mut replay, parent, options, None);
}

/// Records the options of a save dialog and answers canceled
struct Capture<W> {
    options: Option<JsObject<JsonValue>>,
    window: std::marker::PhantomData<W>,
}

impl<W> Default for Capture<W> {
    fn default() -> Self {
        Capture {
            options: None,
            window: std::marker::PhantomData,
        }
    }
}

fn canceled() -> JsonValue {
    let mut answer = JsObject::new();
    answer.set("canceled", JsonValue::Bool(true));
    answer.set("filePath", JsonValue::String(String::new()));
    JsonValue::Object(answer)
}

impl<W> Dialog for Capture<W> {
    type Window = W;

    fn show_open_dialog(&mut self, _: Option<&W>, _: &JsObject<JsonValue>) -> JsonValue {
        canceled()
    }

    fn show_save_dialog(&mut self, _: Option<&W>, options: &JsObject<JsonValue>) -> JsonValue {
        self.options = Some(options.clone());
        canceled()
    }
}

/// Answers a save dialog with what the real one gave
struct Replay<W> {
    answer: JsonValue,
    window: std::marker::PhantomData<W>,
}

impl<W> Replay<W> {
    fn new(answer: JsonValue) -> Self {
        Replay {
            answer,
            window: std::marker::PhantomData,
        }
    }
}

impl<W> Dialog for Replay<W> {
    type Window = W;

    fn show_open_dialog(&mut self, _: Option<&W>, _: &JsObject<JsonValue>) -> JsonValue {
        canceled()
    }

    fn show_save_dialog(&mut self, _: Option<&W>, _: &JsObject<JsonValue>) -> JsonValue {
        self.answer.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPTS: SaveImageOptions<'static> = SaveImageOptions {
        title: "Save Image",
        fallback_dir: None,
    };

    fn picked(path: &str) -> JsonValue {
        let mut answer = JsObject::new();
        answer.set("canceled", JsonValue::Bool(false));
        answer.set("filePath", JsonValue::String(path.to_owned()));
        JsonValue::Object(answer)
    }

    fn default_path(memory: &Mutex<DialogMemory>) -> String {
        let options = anchored_options::<()>(memory, None, "https://x/a.png", None, &OPTS);
        match options.get("defaultPath") {
            Some(JsonValue::String(path)) => path.clone(),
            other => panic!("defaultPath {other:?}"),
        }
    }

    /// A reads the memory, B confirms another folder, then A confirms the
    /// folder it read: A's confirmation is the last one, so it is remembered
    #[test]
    fn the_last_confirmation_wins_even_when_it_was_already_remembered() {
        let memory = Mutex::new(DialogMemory::new());
        let a = anchored_options::<()>(&memory, None, "https://x/a.png", None, &OPTS);
        remember_pick::<()>(&memory, None, &a, &picked("/old/a.png"));
        assert!(default_path(&memory).starts_with("/old/"));

        let a_again = anchored_options::<()>(&memory, None, "https://x/a.png", None, &OPTS);
        let b = anchored_options::<()>(&memory, None, "https://x/b.png", None, &OPTS);
        remember_pick::<()>(&memory, None, &b, &picked("/new/b.png"));
        assert!(default_path(&memory).starts_with("/new/"));
        remember_pick::<()>(&memory, None, &a_again, &picked("/old/a.png"));
        assert!(default_path(&memory).starts_with("/old/"));
    }

    /// A cancel keeps what another dialog remembered meanwhile
    #[test]
    fn a_cancel_remembers_nothing() {
        let memory = Mutex::new(DialogMemory::new());
        let a = anchored_options::<()>(&memory, None, "https://x/a.png", None, &OPTS);
        let b = anchored_options::<()>(&memory, None, "https://x/b.png", None, &OPTS);
        remember_pick::<()>(&memory, None, &b, &picked("/new/b.png"));
        remember_pick::<()>(&memory, None, &a, &canceled());
        assert!(default_path(&memory).starts_with("/new/"));
    }

    /// The options the user sees are main-core's, anchored in the memory, and
    /// a confirmed pick writes the image where it was picked
    #[test]
    fn the_unlocked_dialog_saves_what_save_fetched_image_saves() {
        let dir = std::env::temp_dir().join(format!("m-save-unlocked-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let memory = Mutex::new(DialogMemory::new());
        let target = dir.join("pic.png").to_string_lossy().into_owned();
        remember_pick::<()>(
            &memory,
            None,
            &JsObject::new(),
            &picked(&format!("{}/seed.png", dir.to_string_lossy())),
        );
        let options = anchored_options::<()>(
            &memory,
            None,
            "https://x/pic.png",
            Some("image/png".into()),
            &OPTS,
        );
        assert_eq!(
            options.get("defaultPath"),
            Some(&JsonValue::String(target.clone()))
        );
        let image = DecodedImage {
            bytes: vec![1, 2, 3],
            mime: Some("image/png".into()),
        };
        let saved = save_picked::<()>(None, "https://x/pic.png", image, &OPTS, &picked(&target));
        assert!(saved.ok, "{saved:?}");
        assert_eq!(std::fs::read(&target).unwrap(), vec![1, 2, 3]);
        let canceled_save = save_picked::<()>(
            None,
            "https://x/pic.png",
            DecodedImage {
                bytes: vec![9],
                mime: None,
            },
            &OPTS,
            &canceled(),
        );
        assert!(!canceled_save.ok && canceled_save.error.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
