//! Behaviour a renderer can observe: open, edit, undo and save on the fake
//! deck, the save-as dialog, the close round trip that never blocks, and the
//! cleanup when a view goes.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use shell_contract::editors::{DocumentEditors, SaveMode};
use shell_contract::ipc::Target;
use shell_contract::{IpcValue, Surface, ViewId};

use crate::testkit::{Kit, TestRegistry, call, registered, temp_dir};
use crate::value::{field, num, obj, string};

fn setup(name: &str) -> (Kit, TestRegistry, shell_contract::ipc::Sender, PathBuf) {
    let dir = temp_dir(name);
    // userData exists in a running app: the recent list and the recovery store write there
    std::fs::create_dir_all(dir.join("userdata")).unwrap();
    let kit = Kit::new(&dir, crate::insert_fakes);
    let registry = registered(&kit);
    let sender = kit.view(1, Surface::Slides);
    (kit, registry, sender, dir)
}

fn invoke(
    registry: &TestRegistry,
    sender: shell_contract::ipc::Sender,
    channel: &str,
    args: Vec<IpcValue>,
) -> IpcValue {
    call(registry, sender, channel, args).unwrap_or_else(|e| panic!("{channel}: {e}"))
}

/// `addElement` of a text box carrying `text`
fn add_text(registry: &TestRegistry, sender: shell_contract::ipc::Sender, text: &str) -> IpcValue {
    invoke(
        registry,
        sender,
        "slides:add-element",
        vec![obj([
            ("slideIndex", num(0.0)),
            ("fitWidthPx", num(960.0)),
            ("kind", string("textbox")),
            ("xPx", num(10.0)),
            ("yPx", num(10.0)),
            ("wPx", num(100.0)),
            ("hPx", num(40.0)),
            ("text", string(text)),
        ])],
    )
}

fn history_events(kit: &Kit) -> Vec<(bool, bool)> {
    kit.take_events()
        .into_iter()
        .filter(|(_, channel, _)| *channel == "slides:history-changed")
        .map(|(_, _, args)| {
            let state = &args[0];
            (
                matches!(field(state, "canUndo"), IpcValue::Bool(true)),
                matches!(field(state, "canRedo"), IpcValue::Bool(true)),
            )
        })
        .collect()
}

#[test]
fn channels_without_a_session_answer_null() {
    let (_kit, registry, sender, _dir) = setup("slides-nosession");
    for channel in [
        "slides:add-element",
        "slides:undo",
        "slides:get-render-slides",
    ] {
        let args = if channel == "slides:add-element" {
            vec![obj([("slideIndex", num(0.0))])]
        } else {
            vec![]
        };
        assert_eq!(invoke(&registry, sender, channel, args), IpcValue::Null);
    }
    assert_eq!(
        invoke(&registry, sender, "slides:is-dirty", vec![]),
        IpcValue::Bool(false)
    );
    let saved = invoke(&registry, sender, "slides:save", vec![]);
    assert_eq!(field(&saved, "error"), &string("no file open"));
}

#[test]
fn open_edit_undo_save_on_the_fake_deck() {
    let (kit, registry, sender, dir) = setup("slides-flow");
    let opened = invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);
    assert_eq!(field(&opened, "path"), &string(""));
    assert!(matches!(field(&opened, "slides"), IpcValue::Array(s) if s.len() == 1));
    assert_eq!(
        invoke(&registry, sender, "slides:is-dirty", vec![]),
        IpcValue::Bool(false)
    );

    // an edit marks the deck dirty, answers the rebuilt slide and notifies history
    kit.take_events();
    let added = add_text(&registry, sender, "hello");
    assert_eq!(field(&added, "sourceId"), &string("e1"));
    assert_eq!(
        invoke(&registry, sender, "slides:is-dirty", vec![]),
        IpcValue::Bool(true)
    );
    let events = history_events(&kit);
    assert_eq!(events.last(), Some(&(true, false)));

    // undo restores the deck and enables redo
    let slides = invoke(&registry, sender, "slides:undo", vec![]);
    let IpcValue::Array(slides) = slides else {
        panic!("undo answers the slides")
    };
    assert_eq!(field(&slides[0], "elements"), &IpcValue::Array(vec![]));
    assert_eq!(history_events(&kit).last(), Some(&(false, true)));
    // nothing left to undo
    assert_eq!(
        invoke(&registry, sender, "slides:undo", vec![]),
        IpcValue::Null
    );
    invoke(&registry, sender, "slides:redo", vec![]);
    assert_eq!(history_events(&kit).last(), Some(&(true, false)));

    // an untitled deck asks where the first save goes
    let target = dir.join("deck.pptx");
    kit.dialogs
        .saves
        .lock()
        .unwrap()
        .push_back(Some(target.clone()));
    let saved = invoke(&registry, sender, "slides:save", vec![]);
    assert_eq!(field(&saved, "ok"), &IpcValue::Bool(true));
    assert_eq!(field(&saved, "path"), &string(target.to_string_lossy()));
    assert!(std::fs::read(&target).unwrap().starts_with(b"FAKEPPTX"));
    assert_eq!(
        invoke(&registry, sender, "slides:is-dirty", vec![]),
        IpcValue::Bool(false)
    );
    // the recent list remembers it
    let recent = invoke(&registry, sender, "slides:recent", vec![]);
    assert_eq!(
        recent,
        IpcValue::Array(vec![string(target.to_string_lossy())])
    );

    // reopening the saved file in another view reads what was written
    let other = kit.view(2, Surface::Slides);
    let reopened = invoke(
        &registry,
        other,
        "slides:open-path",
        vec![string(target.to_string_lossy()), num(960.0)],
    );
    // the same path is already open: the view attaches to the live session
    assert_eq!(field(&reopened, "path"), &string(target.to_string_lossy()));
    let IpcValue::Array(slides) = field(&reopened, "slides") else {
        panic!("open answers slides")
    };
    assert_eq!(
        field(&slides[0], "elements"),
        &IpcValue::Array(vec![obj([("id", string("e1")), ("text", string("hello"))])])
    );
}

#[test]
fn save_as_cancel_writes_nothing_and_a_pick_writes_the_deck() {
    let (kit, registry, sender, dir) = setup("slides-saveas");
    invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);

    // the dialog is cancelled: nothing is written and the deck keeps no path
    let cancelled = invoke(
        &registry,
        sender,
        "slides:save-as",
        vec![string("Deck.pptx")],
    );
    assert_eq!(cancelled, obj([("ok", IpcValue::Bool(false))]));

    // a PDF pick writes no deck; the renderer runs the export
    let pdf = dir.join("deck.pdf");
    kit.dialogs
        .saves
        .lock()
        .unwrap()
        .push_back(Some(pdf.clone()));
    let exported = invoke(
        &registry,
        sender,
        "slides:save-as",
        vec![string("Deck.pptx")],
    );
    assert_eq!(field(&exported, "exportAs"), &string("pdf"));
    assert!(!pdf.exists());

    // a name without an extension becomes a .pptx
    let named = dir.join("named");
    kit.dialogs.saves.lock().unwrap().push_back(Some(named));
    let saved = invoke(
        &registry,
        sender,
        "slides:save-as",
        vec![string("Deck.pptx")],
    );
    assert_eq!(field(&saved, "ok"), &IpcValue::Bool(true));
    assert!(dir.join("named.pptx").exists());
    // the deck now has a path: a plain save writes to it without asking
    let again = invoke(&registry, sender, "slides:save", vec![]);
    assert_eq!(field(&again, "ok"), &IpcValue::Bool(true));
    assert_eq!(kit.dialogs.saves.lock().unwrap().len(), 0);
}

#[test]
fn the_close_round_trip_waits_for_the_renderer_without_blocking() {
    let (kit, registry, sender, _dir) = setup("slides-close");
    invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);
    add_text(&registry, sender, "x");
    kit.take_events();
    let editor = slides_editor(&registry);
    assert!(editor.owns(ViewId(1)));
    assert_eq!(editor.document_path(ViewId(1)), None);

    // Save (button 0): the renderer is asked, and the close waits for its answer
    let answer: Rc<RefCell<Option<Result<bool, _>>>> = Rc::default();
    let got = answer.clone();
    kit.dialogs.messages.lock().unwrap().push_back(0);
    editor.request_close(
        ViewId(1),
        None,
        Box::new(move |r| *got.borrow_mut() = Some(r)),
    );
    assert!(
        answer.borrow().is_none(),
        "the continuation is stored, not awaited"
    );
    let events = kit.take_events();
    assert!(
        events
            .iter()
            .any(|(target, channel, _)| *target == Target::View(ViewId(1))
                && *channel == "slides:close-save-request")
    );
    invoke(
        &registry,
        sender,
        "slides:close-save-result",
        vec![IpcValue::Bool(true)],
    );
    assert_eq!(*answer.borrow(), Some(Ok(true)));

    // Cancel (button 2): the view stays open and no save is requested
    let answer: Rc<RefCell<Option<Result<bool, _>>>> = Rc::default();
    let got = answer.clone();
    kit.dialogs.messages.lock().unwrap().push_back(2);
    editor.request_close(
        ViewId(1),
        None,
        Box::new(move |r| *got.borrow_mut() = Some(r)),
    );
    assert_eq!(*answer.borrow(), Some(Ok(false)));
    assert!(
        kit.take_events()
            .iter()
            .all(|(_, c, _)| *c != "slides:close-save-request")
    );

    // a save the renderer reports as failed
    let answer: Rc<RefCell<Option<Result<bool, _>>>> = Rc::default();
    let got = answer.clone();
    editor.request_save(
        ViewId(1),
        SaveMode::Save,
        Box::new(move |r| *got.borrow_mut() = Some(r)),
    );
    assert!(answer.borrow().is_none());
    invoke(
        &registry,
        sender,
        "slides:close-save-result",
        vec![IpcValue::Bool(false)],
    );
    assert_eq!(*answer.borrow(), Some(Ok(false)));

    // a clean deck closes without a question
    let clean = kit.view(3, Surface::Slides);
    invoke(&registry, clean, "slides:new-blank", vec![num(960.0)]);
    let answer: Rc<RefCell<Option<Result<bool, _>>>> = Rc::default();
    let got = answer.clone();
    editor.request_close(
        ViewId(3),
        None,
        Box::new(move |r| *got.borrow_mut() = Some(r)),
    );
    assert_eq!(*answer.borrow(), Some(Ok(true)));
}

#[test]
fn a_view_that_goes_ends_its_session_and_resumes_a_waiting_close() {
    let (kit, registry, sender, _dir) = setup("slides-gone");
    invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);
    add_text(&registry, sender, "x");
    let editor = slides_editor(&registry);
    let answer: Rc<RefCell<Option<Result<bool, _>>>> = Rc::default();
    let got = answer.clone();
    editor.request_save(
        ViewId(1),
        SaveMode::Save,
        Box::new(move |r| *got.borrow_mut() = Some(r)),
    );
    assert!(answer.borrow().is_none());

    kit.destroy(ViewId(1));
    // the renderer is gone: the save is reported as not done
    assert_eq!(*answer.borrow(), Some(Ok(false)));
    assert!(!editor.owns(ViewId(1)));
    assert_eq!(
        invoke(&registry, sender, "slides:get-render-slides", vec![]),
        IpcValue::Null
    );
}

#[test]
fn two_views_share_a_deck_and_both_hear_the_edit() {
    let (kit, registry, sender, dir) = setup("slides-shared");
    invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);
    let target = dir.join("shared.pptx");
    kit.dialogs
        .saves
        .lock()
        .unwrap()
        .push_back(Some(target.clone()));
    invoke(&registry, sender, "slides:save", vec![]);
    let other = kit.view(2, Surface::Slides);
    invoke(
        &registry,
        other,
        "slides:open-path",
        vec![string(target.to_string_lossy()), num(960.0)],
    );
    kit.take_events();
    add_text(&registry, sender, "shared");
    let deck_events: Vec<_> = kit
        .take_events()
        .into_iter()
        .filter(|(_, channel, _)| *channel == "slides:deck-changed")
        .map(|(target, _, _)| target)
        .collect();
    // a partial update reaches every attached window, the editing one included
    assert_eq!(
        deck_events,
        vec![Target::View(ViewId(1)), Target::View(ViewId(2))]
    );
}

#[test]
fn history_batches_collapse_edits_into_one_undo_step() {
    let (_kit, registry, sender, _dir) = setup("slides-batch");
    invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);
    assert_eq!(
        invoke(&registry, sender, "slides:history-batch-begin", vec![]),
        IpcValue::Bool(true)
    );
    add_text(&registry, sender, "a");
    add_text(&registry, sender, "b");
    let id = invoke(&registry, sender, "slides:history-batch-end", vec![]);
    assert!(matches!(id, IpcValue::Number(_)));
    let IpcValue::Array(slides) = invoke(&registry, sender, "slides:undo", vec![]) else {
        panic!("one undo takes back both edits")
    };
    assert_eq!(field(&slides[0], "elements"), &IpcValue::Array(vec![]));
    assert_eq!(
        invoke(&registry, sender, "slides:undo", vec![]),
        IpcValue::Null
    );
}

/// The slides editor among the batch's editors: slides registers after the
/// other apps of the batch, and `editor_for` answers the first that owns a
/// view
fn slides_editor(registry: &TestRegistry) -> Rc<dyn DocumentEditors> {
    registry
        .provided
        .all::<dyn DocumentEditors>()
        .last()
        .cloned()
        .expect("the batch provides editors")
}

#[test]
fn save_as_png_authorizes_one_image_export_for_that_tab_only() {
    let (kit, registry, sender, dir) = setup("slides-png");
    invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);
    let png = dir.join("shot.png");
    kit.dialogs
        .saves
        .lock()
        .unwrap()
        .push_back(Some(png.clone()));
    let picked = invoke(
        &registry,
        sender,
        "slides:save-as",
        vec![string("Deck.pptx")],
    );
    assert_eq!(field(&picked, "exportAs"), &string("png"));

    let export = |target: &std::path::Path, view| {
        invoke(
            &registry,
            view,
            "slides:export-images",
            vec![obj([
                ("format", string("png")),
                ("saveAsTarget", string(target.to_string_lossy())),
                (
                    "pngsBase64",
                    IpcValue::Array(vec![string("AQID"), string("BAUG")]),
                ),
            ])],
        )
    };
    // another tab, or another name, is refused
    let other = kit.view(2, Surface::Slides);
    let refused = export(&png, other);
    assert_eq!(
        field(&refused, "error"),
        &string("export target was not authorized")
    );
    let elsewhere = export(&dir.join("other.png"), sender);
    assert_eq!(field(&elsewhere, "ok"), &IpcValue::Bool(false));
    // the picked name writes one numbered file per slide, once
    let done = export(&png, sender);
    assert_eq!(field(&done, "ok"), &IpcValue::Bool(true));
    assert_eq!(
        std::fs::read(dir.join("shot-01.png")).unwrap(),
        vec![1, 2, 3]
    );
    assert_eq!(
        std::fs::read(dir.join("shot-02.png")).unwrap(),
        vec![4, 5, 6]
    );
    let again = export(&png, sender);
    assert_eq!(field(&again, "ok"), &IpcValue::Bool(false));
}

#[test]
fn the_microphone_is_let_start_only_for_an_editor_with_a_deck() {
    let (_kit, registry, sender, _dir) = setup("slides-mic");
    assert_eq!(
        invoke(&registry, sender, "slides:microphone-access", vec![]),
        IpcValue::Bool(false)
    );
    invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);
    assert_eq!(
        invoke(&registry, sender, "slides:microphone-access", vec![]),
        IpcValue::Bool(true)
    );
    invoke(&registry, sender, "slides:microphone-release", vec![]);
}

#[test]
fn attachments_are_accepted_by_extension_and_size() {
    let (_kit, registry, sender, dir) = setup("slides-files");
    let notes = dir.join("notes.txt");
    std::fs::write(&notes, "abcdef").unwrap();
    let bad = dir.join("tool.exe");
    std::fs::write(&bad, "x").unwrap();
    let answer = invoke(
        &registry,
        sender,
        "slides:files-add",
        vec![IpcValue::Array(vec![
            string(notes.to_string_lossy()),
            string(bad.to_string_lossy()),
        ])],
    );
    let IpcValue::Array(accepted) = field(&answer, "accepted") else {
        panic!("accepted list")
    };
    assert_eq!(accepted.len(), 1);
    assert_eq!(field(&accepted[0], "ext"), &string("txt"));
    let IpcValue::Array(rejected) = field(&answer, "rejected") else {
        panic!("rejected list")
    };
    assert_eq!(
        rejected,
        &vec![string("tool.exe: .exe files are not supported")]
    );
    // the text is read in slices of the characters asked
    let read = invoke(
        &registry,
        sender,
        "slides:files-read",
        vec![string(notes.to_string_lossy()), num(2.0), num(3.0)],
    );
    assert_eq!(field(&read, "text"), &string("cde"));
    assert_eq!(field(&read, "totalChars"), &num(6.0));
}
