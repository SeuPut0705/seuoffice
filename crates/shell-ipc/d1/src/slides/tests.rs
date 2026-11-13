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

/// An answered save's timer is spent (the TypeScript clears it): when it
/// fires anyway it leaves the view's newer save waiting for its own answer
#[test]
fn an_answered_saves_timer_leaves_the_next_save_waiting() {
    let (_kit, registry, sender, _dir) = setup("slides-save-timer");
    invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);
    add_text(&registry, sender, "x");
    let editor = slides_editor(&registry);
    let app = super::APPS.with(|apps| apps.borrow().last().cloned().unwrap());
    let save = |editor: &Rc<dyn DocumentEditors>| {
        let answer: Rc<RefCell<Option<Result<bool, _>>>> = Rc::default();
        let got = answer.clone();
        editor.request_save(
            ViewId(1),
            SaveMode::Save,
            Box::new(move |r| *got.borrow_mut() = Some(r)),
        );
        answer
    };

    let first = save(&editor);
    let first_ticket = app.state.borrow().next_ticket;
    invoke(
        &registry,
        sender,
        "slides:close-save-result",
        vec![IpcValue::Bool(true)],
    );
    assert_eq!(*first.borrow(), Some(Ok(true)));

    let second = save(&editor);
    app.close_save_expired(ViewId(1), first_ticket);
    assert!(second.borrow().is_none(), "the next save still waits");
    invoke(
        &registry,
        sender,
        "slides:close-save-result",
        vec![IpcValue::Bool(true)],
    );
    assert_eq!(*second.borrow(), Some(Ok(true)));
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

/// A template-selection hooks provider that records what it is called with
#[derive(Default)]
struct Hooks(RefCell<Vec<String>>);

impl shell_contract::slides::SlidesTemplateSelectionHooks for Hooks {
    fn follow(&self, doc: &shell_contract::slides::SlidesDocument, from: &str, to: &str) {
        self.0.borrow_mut().push(format!(
            "follow {} {from:?} {to:?} at {:?}",
            doc.id, doc.path
        ));
    }

    fn inherit(
        &self,
        previous: Option<&shell_contract::slides::SlidesDocument>,
        replacement: &shell_contract::slides::SlidesDocument,
    ) {
        self.0.borrow_mut().push(format!(
            "inherit {:?} -> {} {:?}",
            previous.map(|p| p.id),
            replacement.id,
            replacement.path
        ));
    }

    fn moved(&self, _old_path: &str, _new_path: &str) {}
}

#[test]
fn saves_follow_the_template_selection_and_a_replaced_deck_inherits_it() {
    use shell_contract::slides::{SlidesDocument, SlidesDocuments, SlidesTemplateSelectionHooks};
    let (kit, registry, sender, dir) = setup("slides-hooks");
    let hooks = Rc::new(Hooks::default());
    registry
        .provided
        .add::<dyn SlidesTemplateSelectionHooks>(hooks.clone());
    let docs = registry.provided.all::<dyn SlidesDocuments>().remove(0);
    assert_eq!(docs.document(ViewId(1)), None);

    invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);
    let first = docs.document(ViewId(1)).expect("a session");
    assert_eq!(first.path, "");

    // the first save of an untitled deck follows from "" to the picked path
    let one = dir.join("one.pptx");
    kit.dialogs
        .saves
        .lock()
        .unwrap()
        .push_back(Some(one.clone()));
    invoke(&registry, sender, "slides:save", vec![]);
    let one_text = one.to_string_lossy().into_owned();
    assert_eq!(
        docs.document(ViewId(1)),
        Some(SlidesDocument {
            id: first.id,
            path: one_text.clone()
        })
    );
    // Save As follows from the old path to the new one, same session
    let two = dir.join("two.pptx");
    kit.dialogs
        .saves
        .lock()
        .unwrap()
        .push_back(Some(two.clone()));
    invoke(
        &registry,
        sender,
        "slides:save-as",
        vec![string("Deck.pptx")],
    );
    let two_text = two.to_string_lossy().into_owned();
    assert_eq!(docs.document(ViewId(1)).unwrap().id, first.id);
    assert_eq!(docs.document(ViewId(1)).unwrap().path, two_text);

    // landing generated pages in replace mode makes a new session object
    let page = invoke(
        &registry,
        sender,
        "slides:local-page-generate",
        vec![obj([("specJson", string("{\"title\":\"x\"}"))])],
    );
    let marker = field(&page, "marker").clone();
    let landed = invoke(
        &registry,
        sender,
        "slides:land-generated-pages",
        vec![IpcValue::Array(vec![marker]), num(960.0)],
    );
    assert!(matches!(field(&landed, "slides"), IpcValue::Array(s) if s.len() == 1));
    let replaced = docs.document(ViewId(1)).unwrap();
    assert_ne!(replaced.id, first.id);
    assert_eq!(replaced.path, "");

    let calls = hooks.0.borrow().clone();
    assert_eq!(
        calls,
        vec![
            format!("follow {} \"\" {one_text:?} at {one_text:?}", first.id),
            format!(
                "follow {} {one_text:?} {two_text:?} at {one_text:?}",
                first.id
            ),
            format!("inherit Some({}) -> {} \"\"", first.id, replaced.id),
        ]
    );
}

#[test]
fn every_slides_channel_of_the_batch_has_a_handler() {
    let (_kit, registry, _sender, _dir) = setup("slides-all");
    let missing: Vec<&str> = shell_contract::CHANNELS
        .iter()
        .filter(|spec| spec.batch == shell_contract::Batch::D1 && spec.name.starts_with("slides:"))
        .filter(|spec| {
            spec.kinds
                .iter()
                .any(|k| *k != shell_contract::ipc::ChannelKind::Event)
        })
        .filter(|spec| !registry.handlers.contains_key(spec.name))
        .map(|spec| spec.name)
        .collect();
    assert_eq!(missing, Vec::<&str>::new());
}

#[test]
fn the_master_view_edits_its_part_and_holds_undo_until_it_closes() {
    let (_kit, registry, sender, _dir) = setup("slides-master");
    // no deck, no master
    assert_eq!(
        invoke(&registry, sender, "slides:master-enter", vec![num(960.0)]),
        IpcValue::Null
    );
    invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);
    // editing before the view is entered answers null
    assert_eq!(
        invoke(
            &registry,
            sender,
            "slides:master-delete-element",
            vec![obj([("sourceId", string("m0"))])]
        ),
        IpcValue::Null
    );
    let entered = invoke(&registry, sender, "slides:master-enter", vec![num(960.0)]);
    let IpcValue::Array(items) = field(&entered, "items") else {
        panic!("items")
    };
    assert_eq!(items.len(), 1);
    assert_eq!(field(&items[0], "kind"), &string("master"));

    let text = |value: &str| {
        obj([
            ("sourceId", string("m0")),
            (
                "paragraphs",
                IpcValue::Array(vec![obj([(
                    "runs",
                    IpcValue::Array(vec![obj([("text", string(value))])]),
                )])]),
            ),
        ])
    };
    let edited = invoke(
        &registry,
        sender,
        "slides:master-edit-text",
        vec![text("Hello")],
    );
    assert_eq!(
        field(&edited, "elements"),
        &IpcValue::Array(vec![obj([("id", string("m0")), ("text", string("Hello"))])])
    );
    // a master edit marks the deck changed
    assert_eq!(
        invoke(&registry, sender, "slides:is-dirty", vec![]),
        IpcValue::Bool(true)
    );
    // an element that is not there fails the op: null
    let missing = obj([("sourceId", string("nope"))]);
    assert_eq!(
        invoke(
            &registry,
            sender,
            "slides:master-delete-element",
            vec![missing]
        ),
        IpcValue::Null
    );
    // a new element answers its id
    let added = invoke(
        &registry,
        sender,
        "slides:master-add-element",
        vec![obj([
            ("kind", string("textbox")),
            ("fitWidthPx", num(960.0)),
            ("xPx", num(0.0)),
            ("yPx", num(0.0)),
            ("wPx", num(10.0)),
            ("hPx", num(10.0)),
        ])],
    );
    assert_eq!(field(&added, "sourceId"), &string("m1"));
    // undo is held while the master is open
    assert_eq!(
        invoke(&registry, sender, "slides:undo", vec![]),
        IpcValue::Null
    );
    // closing answers every slide, and undo works again
    let closed = invoke(&registry, sender, "slides:master-close", vec![]);
    assert!(matches!(closed, IpcValue::Array(ref s) if s.len() == 1));
    assert!(matches!(
        invoke(&registry, sender, "slides:undo", vec![]),
        IpcValue::Array(_)
    ));
}

#[test]
fn a_comment_is_added_and_deleted_and_marks_the_deck_changed() {
    let (_kit, registry, sender, _dir) = setup("slides-comments");
    invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);
    let comment =
        |index: f64, text: &str| obj([("slideIndex", num(index)), ("text", string(text))]);
    assert_eq!(
        invoke(
            &registry,
            sender,
            "slides:add-comment",
            vec![comment(7.0, "x")]
        ),
        IpcValue::Null
    );
    assert_eq!(
        invoke(&registry, sender, "slides:is-dirty", vec![]),
        IpcValue::Bool(false)
    );
    let comments = invoke(
        &registry,
        sender,
        "slides:add-comment",
        vec![comment(0.0, "hi")],
    );
    let IpcValue::Array(list) = &comments else {
        panic!("comments")
    };
    assert_eq!(list.len(), 1);
    assert_eq!(field(&list[0], "text"), &string("hi"));
    assert_eq!(
        invoke(&registry, sender, "slides:is-dirty", vec![]),
        IpcValue::Bool(true)
    );
    assert_eq!(
        invoke(&registry, sender, "slides:get-comments", vec![num(0.0)]),
        comments
    );
    // a comment that is not there fails the op: null; the real one goes
    let delete = |idx: f64| {
        obj([
            ("slideIndex", num(0.0)),
            ("authorId", string("a")),
            ("idx", num(idx)),
        ])
    };
    assert_eq!(
        invoke(
            &registry,
            sender,
            "slides:delete-comment",
            vec![delete(5.0)]
        ),
        IpcValue::Null
    );
    assert_eq!(
        invoke(
            &registry,
            sender,
            "slides:delete-comment",
            vec![delete(0.0)]
        ),
        IpcValue::Array(vec![])
    );
    let all = invoke(&registry, sender, "slides:get-all-comments", vec![]);
    assert_eq!(all, IpcValue::Array(vec![IpcValue::Array(vec![])]));
}

#[test]
fn insert_image_places_the_file_the_dialog_picked() {
    let (kit, registry, sender, dir) = setup("slides-image");
    invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);
    // a cancelled dialog inserts nothing
    assert_eq!(
        invoke(
            &registry,
            sender,
            "slides:insert-image",
            vec![num(0.0), num(960.0)]
        ),
        IpcValue::Null
    );
    let picture = dir.join("pic.png");
    std::fs::write(&picture, [1u8, 2, 3]).unwrap();
    kit.dialogs
        .opens
        .lock()
        .unwrap()
        .push_back(Some(vec![picture]));
    let inserted = invoke(
        &registry,
        sender,
        "slides:insert-image",
        vec![num(0.0), num(960.0)],
    );
    assert_eq!(field(&inserted, "sourceId"), &string("e1"));
    assert_eq!(
        field(field(&inserted, "slide"), "elements"),
        &IpcValue::Array(vec![obj([
            ("id", string("e1")),
            ("text", string("picture:png"))
        ])])
    );
    // the insert is one undo step
    assert!(matches!(
        invoke(&registry, sender, "slides:undo", vec![]),
        IpcValue::Array(_)
    ));
    // a slide that is not there inserts nothing and asks for no file
    assert_eq!(
        invoke(
            &registry,
            sender,
            "slides:insert-image",
            vec![num(9.0), num(960.0)]
        ),
        IpcValue::Null
    );
}

/// every file under `dir`
fn files_under(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(files_under(&path));
            } else {
                out.push(path);
            }
        }
    }
    out
}

#[test]
fn the_recovery_pass_copies_a_changed_deck_once_and_a_save_removes_the_copy() {
    let (kit, registry, sender, dir) = setup("slides-recovery");
    invoke(&registry, sender, "slides:new-blank", vec![num(960.0)]);
    // a clean deck has no copy
    super::recovery::run_recovery_pass(false);
    assert!(files_under(&dir.join("userdata")).is_empty());

    add_text(&registry, sender, "unsaved");
    super::recovery::run_recovery_pass(false);
    let copies: Vec<PathBuf> = files_under(&dir.join("userdata"))
        .into_iter()
        .filter(|p| p.to_string_lossy().ends_with(".pptx"))
        .collect();
    assert_eq!(copies.len(), 1, "one copy of the untitled deck");
    assert!(std::fs::read(&copies[0]).unwrap().starts_with(b"FAKEPPTX"));
    let written = std::fs::metadata(&copies[0]).unwrap().modified().unwrap();
    // nothing changed since: the copy is not taken again
    super::recovery::run_recovery_pass(false);
    assert_eq!(
        std::fs::metadata(&copies[0]).unwrap().modified().unwrap(),
        written
    );

    // a save makes the deck's copies go
    kit.dialogs
        .saves
        .lock()
        .unwrap()
        .push_back(Some(dir.join("saved.pptx")));
    invoke(&registry, sender, "slides:save", vec![]);
    assert!(
        files_under(&dir.join("userdata"))
            .iter()
            .all(|p| !p.to_string_lossy().ends_with(".pptx")),
        "the recovery copy is deleted once the deck is saved"
    );
}
