//! What a renderer of the sheets editor can observe: session flows, the
//! save-edits transfer, dialogs, picking, the close round trip, recovery
//! copies and a view's end. The engine is [`super::fakes::FakeEngine`].

use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;

use serde_json::Value;
use shell_contract::editors::{SaveMode, editor_for};
use shell_contract::hosts::Hosts;
use shell_contract::ipc::{Sender, Target};
use shell_contract::{Batch, IpcError, IpcValue, Surface, WindowId};

use super::fakes::{FakeEngine, FakeShell};
use super::{insert_fakes, routes, views};
use crate::testkit::{Kit, TestRegistry, call, temp_dir};
use crate::value::{field, num, obj, string};

struct World {
    kit: Kit,
    registry: TestRegistry,
    dir: PathBuf,
}

fn world(name: &str, case: Value) -> World {
    let dir = temp_dir(name);
    let kit = Kit::new(&dir, move |hosts: &mut Hosts| insert_fakes(hosts, &case));
    let mut registry = TestRegistry::default();
    for route in routes(&kit.services, &registry.provided).expect("sheets registers") {
        use shell_contract::ipc::Registry;
        registry
            .register(Batch::D1, route.channel, route.kind, route.handler)
            .expect("the channel is sheets'");
    }
    World { kit, registry, dir }
}

impl World {
    fn tab(&self, id: u32) -> Sender {
        let sender = self.kit.view(id, Surface::Sheets);
        views().unwrap().register_tab(sender.view);
        sender
    }

    fn call(
        &self,
        sender: Sender,
        channel: &str,
        args: Vec<IpcValue>,
    ) -> Result<IpcValue, IpcError> {
        call(&self.registry, sender, channel, args)
    }

    fn file(&self, name: &str, bytes: &[u8]) -> String {
        let path = self.dir.join(name);
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// the shell queues a file for the tab, the renderer pulls it
    fn open(&self, sender: Sender, path: &str) -> IpcValue {
        views().unwrap().queue_workbook(sender.view, path);
        self.call(sender, "workbook:select", vec![]).unwrap()
    }

    fn engine(&self) -> Arc<FakeEngine> {
        self.kit.host::<Arc<FakeEngine>>()
    }

    fn shell(&self) -> Arc<FakeShell> {
        self.kit.host::<Arc<FakeShell>>()
    }
}

use std::sync::Arc;

fn text(value: &IpcValue, key: &str) -> String {
    match field(value, key) {
        IpcValue::String(text) => text.clone(),
        other => panic!("{key} is {other:?}"),
    }
}

fn message(error: IpcError) -> String {
    error.message
}

fn save_request(session: &str, mode: &str) -> IpcValue {
    obj([("sessionId", string(session)), ("mode", string(mode))])
}

fn names(events: &[(Target, &'static str, Vec<IpcValue>)]) -> Vec<(Target, &'static str)> {
    events.iter().map(|(t, c, _)| (*t, *c)).collect()
}

#[test]
fn select_and_reopen_keep_what_a_session_remembers() {
    let w = world("sheets-select", Value::Null);
    let one = w.tab(1);
    let a = w.file("a.xlsx", b"xlsx");
    assert_eq!(
        w.call(one, "sheets:has-queued-workbook", vec![]).unwrap(),
        IpcValue::Bool(false)
    );
    views().unwrap().queue_workbook(one.view, &a);
    assert_eq!(
        w.call(one, "sheets:has-queued-workbook", vec![]).unwrap(),
        IpcValue::Bool(true)
    );
    let file = w.call(one, "workbook:select", vec![]).unwrap();
    assert_eq!(text(&file, "name"), "a.xlsx");
    assert_eq!(text(&file, "path"), a);
    assert_eq!(field(&file, "needsSaveAs"), &IpcValue::Bool(false));
    assert_eq!(field(&file, "readOnly"), &IpcValue::Bool(false));
    assert_eq!(text(&file, "sha256").len(), 64);
    assert_eq!(
        w.call(one, "sheets:has-queued-workbook", vec![]).unwrap(),
        IpcValue::Bool(false)
    );
    assert_eq!(
        w.shell().opened.lock().unwrap().as_slice(),
        [(one.view, a.clone())]
    );

    // nothing queued: the picker; cancelled answers null
    assert_eq!(
        w.call(one, "workbook:select", vec![]).unwrap(),
        IpcValue::Null
    );
    w.kit
        .dialogs
        .opens
        .lock()
        .unwrap()
        .push_back(Some(vec![a.clone().into()]));
    let again = w.call(one, "workbook:select", vec![]).unwrap();
    assert_ne!(text(&again, "sessionId"), text(&file, "sessionId"));

    // a plain path re-opens by itself; a missing file and a foreign extension are refused
    let twin = w
        .call(one, "workbook:reopen", vec![string(a.clone())])
        .unwrap();
    assert_eq!(text(&twin, "name"), "a.xlsx");
    let missing = w.dir.join("gone.xlsx").to_string_lossy().into_owned();
    assert_eq!(
        message(
            w.call(one, "workbook:reopen", vec![string(missing)])
                .unwrap_err()
        ),
        "Workbook file not found."
    );
    let doc = w.file("b.docx", b"x");
    assert_eq!(
        message(
            w.call(one, "workbook:reopen", vec![string(doc)])
                .unwrap_err()
        ),
        "Unsupported workbook: docx"
    );

    // a converted .xls is a copy: the first save is a Save As, and re-opening
    // the copy keeps saying so
    let xls = w.file("old.xls", b"xls");
    let converted = w.open(one, &xls);
    assert_eq!(field(&converted, "needsSaveAs"), &IpcValue::Bool(true));
    assert_eq!(text(&converted, "name"), "old.xlsx");
    let copy_path = text(&converted, "path");
    let continued = w
        .call(one, "workbook:reopen", vec![string(copy_path)])
        .unwrap();
    assert_eq!(field(&continued, "needsSaveAs"), &IpcValue::Bool(true));
    assert_eq!(text(&continued, "name"), "old.xlsx");

    // a CSV keeps its identity
    let csv = w.file("t.csv", b"a,b\n1,2\n");
    let opened = w.open(one, &csv);
    assert_eq!(text(&opened, "csvPath"), csv);
    assert_eq!(field(&opened, "emptyCsv"), &IpcValue::Undefined);
}

#[test]
fn reads_check_the_request_and_the_session() {
    let w = world("sheets-reads", Value::Null);
    let one = w.tab(1);
    let a = w.file("a.xlsx", b"xlsx");
    let file = w.open(one, &a);
    let session = text(&file, "sessionId");
    let request = |sheet: &str| {
        obj([
            ("sessionId", string(session.clone())),
            ("sheetId", string(sheet)),
            (
                "range",
                obj([
                    ("startRow", num(0.0)),
                    ("endRow", num(1.0)),
                    ("startColumn", num(0.0)),
                    ("endColumn", num(1.0)),
                ]),
            ),
        ])
    };
    assert!(
        w.call(one, "workbook:read-range", vec![request("s1")])
            .is_ok()
    );
    let bad = w
        .call(
            one,
            "workbook:read-range",
            vec![obj([("sessionId", string("x"))])],
        )
        .unwrap_err();
    assert_eq!(bad.name, None);
    assert!(bad.message.contains("Invalid UUID"), "{}", bad.message);
    let unknown = obj([
        ("sessionId", string("00000000-0000-4000-8000-0000000000ff")),
        ("sheetId", string("s1")),
    ]);
    assert_eq!(
        message(
            w.call(one, "workbook:read-formulas", vec![unknown])
                .unwrap_err()
        ),
        "Unknown workbook session."
    );
    // recalculation resolves sheet ids to the file's names and back
    let recalc = obj([
        ("sessionId", string(session.clone())),
        (
            "edits",
            IpcValue::Array(vec![obj([
                ("sheetId", string("s1")),
                ("row", num(0.0)),
                ("column", num(0.0)),
                ("input", string("=1+1")),
            ])]),
        ),
        ("reads", IpcValue::Array(vec![])),
    ]);
    let answer = w.call(one, "workbook:recalc", vec![recalc]).unwrap();
    let IpcValue::Array(cells) = field(&answer, "cells") else {
        panic!("cells")
    };
    assert_eq!(text(&cells[0], "sheetId"), "s1");
    assert_eq!(field(&cells[0], "isFormula"), &IpcValue::Bool(true));
}

#[test]
fn a_chunked_edit_transfer_feeds_one_save_and_can_be_aborted() {
    let w = world("sheets-transfer", Value::Null);
    let one = w.tab(1);
    let a = w.file("a.xlsx", b"xlsx");
    let file = w.open(one, &a);
    let session = text(&file, "sessionId");
    let begin = |transfer: &str, total: f64| {
        obj([
            ("sessionId", string(session.clone())),
            ("transferId", string(transfer)),
            ("total", num(total)),
        ])
    };
    let chunk = |transfer: &str, seq: f64, json: &str| {
        obj([
            ("sessionId", string(session.clone())),
            ("transferId", string(transfer)),
            ("seq", num(seq)),
            ("editsJson", string(json)),
        ])
    };
    let t1 = jscompat::random_uuid();
    let bad = w
        .call(one, "workbook:save-edits-begin", vec![begin(&t1, 0.0)])
        .unwrap_err();
    assert!(bad.message.contains("Too small: expected number to be >0"));
    w.call(one, "workbook:save-edits-begin", vec![begin(&t1, 3.0)])
        .unwrap();
    assert_eq!(
        message(
            w.call(one, "workbook:save-edits-begin", vec![begin(&t1, 3.0)])
                .unwrap_err()
        ),
        "Save transfer already exists."
    );
    w.call(one, "workbook:save-edits-chunk", vec![chunk(&t1, 0.0, "[{\"sheetId\":\"s1\",\"row\":0,\"column\":0},{\"sheetId\":\"s1\",\"row\":1,\"column\":0}]")]).unwrap();
    // out of order drops the transfer
    assert_eq!(
        message(
            w.call(
                one,
                "workbook:save-edits-chunk",
                vec![chunk(
                    &t1,
                    5.0,
                    "[{\"sheetId\":\"s1\",\"row\":2,\"column\":0}]"
                )]
            )
            .unwrap_err()
        ),
        "Save transfer chunk out of order."
    );
    assert_eq!(
        message(
            w.call(
                one,
                "workbook:save-edits-chunk",
                vec![chunk(
                    &t1,
                    1.0,
                    "[{\"sheetId\":\"s1\",\"row\":2,\"column\":0}]"
                )]
            )
            .unwrap_err()
        ),
        "Unknown save transfer."
    );

    // abort frees an open transfer; saving it afterwards finds nothing
    let t2 = jscompat::random_uuid();
    w.call(one, "workbook:save-edits-begin", vec![begin(&t2, 1.0)])
        .unwrap();
    w.call(
        one,
        "workbook:save-edits-chunk",
        vec![chunk(
            &t2,
            0.0,
            "[{\"sheetId\":\"s1\",\"row\":0,\"column\":0}]",
        )],
    )
    .unwrap();
    let abort = obj([
        ("sessionId", string(session.clone())),
        ("transferId", string(t2.clone())),
    ]);
    assert_eq!(
        w.call(one, "workbook:save-edits-abort", vec![abort.clone()])
            .unwrap(),
        IpcValue::Undefined
    );
    // aborting again is a no-op
    w.call(one, "workbook:save-edits-abort", vec![abort])
        .unwrap();
    let with_transfer = |transfer: &str| {
        let IpcValue::Object(mut entries) = save_request(&session, "save") else {
            unreachable!()
        };
        entries.push(("editsTransferId".into(), string(transfer)));
        IpcValue::Object(entries)
    };
    assert_eq!(
        message(
            w.call(one, "workbook:save", vec![with_transfer(&t2)])
                .unwrap_err()
        ),
        "Unknown save transfer."
    );

    // a complete transfer is consumed by the save that names it
    let t3 = jscompat::random_uuid();
    w.call(one, "workbook:save-edits-begin", vec![begin(&t3, 1.0)])
        .unwrap();
    w.call(
        one,
        "workbook:save-edits-chunk",
        vec![chunk(
            &t3,
            0.0,
            "[{\"sheetId\":\"s1\",\"row\":0,\"column\":0}]",
        )],
    )
    .unwrap();
    let saved = w
        .call(one, "workbook:save", vec![with_transfer(&t3)])
        .unwrap();
    assert_eq!(field(&saved, "canceled"), &IpcValue::Bool(false));
    let new_session = text(field(&saved, "file"), "sessionId");
    assert_ne!(new_session, session);
    assert_eq!(fs::read(&a).unwrap(), b"xlsx+edits");
    // the old session went with the swap
    let gone = obj([
        ("sessionId", string(session.clone())),
        ("sheetId", string("s1")),
    ]);
    assert_eq!(
        message(
            w.call(one, "workbook:read-formulas", vec![gone])
                .unwrap_err()
        ),
        "Unknown workbook session."
    );
    // the same transfer cannot feed a second save
    assert_eq!(
        message(
            w.call(one, "workbook:save", vec![with_transfer(&t3)])
                .unwrap_err()
        ),
        "Unknown save transfer."
    );
}

#[test]
fn a_save_refuses_a_file_changed_underneath_and_clears_the_recovery_copy() {
    let w = world("sheets-save", Value::Null);
    let one = w.tab(1);
    let a = w.file("a.xlsx", b"xlsx");
    let file = w.open(one, &a);
    let session = text(&file, "sessionId");
    // a dirty tab writes its copy
    let written = w
        .call(
            one,
            "workbook:write-recovery",
            vec![save_request(&session, "save")],
        )
        .unwrap();
    assert_eq!(field(&written, "ok"), &IpcValue::Bool(true));
    let copies = w.dir.join("userdata").join("sheets-autosave");
    assert!(
        fs::read_dir(&copies)
            .unwrap()
            .filter_map(Result::ok)
            .count()
            > 0
    );
    // another program changes the file: Save refuses
    fs::write(&a, b"changed").unwrap();
    assert_eq!(
        message(
            w.call(one, "workbook:save", vec![save_request(&session, "save")])
                .unwrap_err()
        ),
        "The workbook changed on disk after it was opened — use Save As instead."
    );
    // Save As asks where; cancelling leaves everything as it was
    let cancelled = w
        .call(
            one,
            "workbook:save",
            vec![save_request(&session, "save-as")],
        )
        .unwrap();
    assert_eq!(cancelled, obj([("canceled", IpcValue::Bool(true))]));
    // a CSV pick is handed back for the renderer to serialize
    let csv_target = w.dir.join("out.csv").to_string_lossy().into_owned();
    w.kit
        .dialogs
        .saves
        .lock()
        .unwrap()
        .push_back(Some(csv_target.clone().into()));
    let csv = w
        .call(
            one,
            "workbook:save",
            vec![save_request(&session, "save-as")],
        )
        .unwrap();
    assert_eq!(text(&csv, "csvSaveAsPath"), csv_target);
    // an .xlsx pick writes there, swaps the session and drops the copy
    let target = w.dir.join("copy.xlsx").to_string_lossy().into_owned();
    w.kit
        .dialogs
        .saves
        .lock()
        .unwrap()
        .push_back(Some(target.clone().into()));
    let saved = w
        .call(
            one,
            "workbook:save",
            vec![save_request(&session, "save-as")],
        )
        .unwrap();
    assert_eq!(field(&saved, "canceled"), &IpcValue::Bool(false));
    assert_eq!(text(field(&saved, "file"), "path"), target);
    assert!(fs::read(&target).unwrap().ends_with(b"+edits"));
    assert_eq!(
        fs::read_dir(&copies)
            .unwrap()
            .filter_map(Result::ok)
            .count(),
        0
    );
}

#[test]
fn csv_questions_and_exports() {
    let w = world("sheets-csv", Value::Null);
    let one = w.tab(1);
    let ask = |answer: Option<usize>| {
        if let Some(button) = answer {
            w.kit.dialogs.messages.lock().unwrap().push_back(button);
        }
        w.call(one, "workbook:csv-save-confirm", vec![]).unwrap()
    };
    assert_eq!(ask(Some(0)), string("csv"));
    assert_eq!(ask(Some(1)), string("xlsx"));
    // the dialog closed without an answer: its cancel button
    assert_eq!(ask(None), string("cancel"));
    w.kit.dialogs.messages.lock().unwrap().push_back(1);
    assert_eq!(
        w.call(one, "workbook:csv-withheld-choice", vec![]).unwrap(),
        string("export")
    );

    let export = |formulas: bool, target: Option<&str>| {
        let mut entries = vec![
            ("fileName", string("t.csv")),
            ("content", string("a,b\n1,2")),
            ("hasFormulas", IpcValue::Bool(formulas)),
        ];
        if let Some(target) = target {
            entries.push(("targetPath", string(target)));
        }
        let request = IpcValue::Object(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
        );
        w.call(one, "workbook:export-csv", vec![request])
    };
    w.kit.dialogs.messages.lock().unwrap().push_back(0);
    assert_eq!(
        export(true, None).unwrap(),
        obj([
            ("canceled", IpcValue::Bool(true)),
            ("saveAsXlsxInstead", IpcValue::Bool(true))
        ])
    );
    // the dialog's name gets .csv, the file starts with a UTF-8 BOM
    let picked = w.dir.join("export").to_string_lossy().into_owned();
    w.kit
        .dialogs
        .saves
        .lock()
        .unwrap()
        .push_back(Some(picked.clone().into()));
    let done = export(false, None).unwrap();
    assert_eq!(text(&done, "path"), format!("{picked}.csv"));
    assert_eq!(
        fs::read(format!("{picked}.csv")).unwrap(),
        b"\xef\xbb\xbfa,b\n1,2"
    );
    assert_eq!(
        export(false, None).unwrap(),
        obj([("canceled", IpcValue::Bool(true))])
    );
}

#[test]
fn picking_a_range_in_another_workbook_relays_events_in_order() {
    let w = world("sheets-pick", Value::Null);
    let (one, two, three) = (w.tab(1), w.tab(2), w.tab(3));
    let b = w.file("b.xlsx", b"xlsx");
    w.open(two, &b);
    let listed = w.call(one, "workbook:list-tabs", vec![]).unwrap();
    assert_eq!(
        field(&listed, "tabs"),
        &IpcValue::Array(vec![obj([
            ("wcId", num(2.0)),
            ("name", string("b.xlsx")),
            ("path", string(b.clone())),
        ])])
    );
    w.kit.take_events();

    let armed = w
        .call(one, "workbook:pick-arm", vec![obj([("wcId", num(2.0))])])
        .unwrap();
    let pick = text(&armed, "pickId");
    assert!(pick.starts_with("pick-"));
    let events = w.kit.take_events();
    assert_eq!(
        names(&events),
        [(Target::View(two.view), "workbook:pick-armed")]
    );
    assert_eq!(events[0].2, vec![obj([("pickId", string(pick.clone()))])]);

    // arming again cancels the first for every other tab
    let second = text(
        &w.call(one, "workbook:pick-arm", vec![obj([("wcId", num(3.0))])])
            .unwrap(),
        "pickId",
    );
    let events = w.kit.take_events();
    assert_eq!(
        names(&events),
        [
            (Target::View(two.view), "workbook:pick-cancelled"),
            (Target::View(three.view), "workbook:pick-cancelled"),
            (Target::View(three.view), "workbook:pick-armed"),
        ]
    );

    // only the armed tab answers
    let selection = |id: &str| {
        obj([
            ("pickId", string(id)),
            ("sheetName", string("Sheet1")),
            ("startRow", num(0.0)),
            ("endRow", num(1.0)),
            ("startColumn", num(2.0)),
            ("endColumn", num(3.0)),
        ])
    };
    w.call(two, "workbook:pick-select", vec![selection(&second)])
        .unwrap();
    w.call(three, "workbook:pick-select", vec![selection(&pick)])
        .unwrap();
    assert!(w.kit.take_events().is_empty());
    w.call(three, "workbook:pick-select", vec![selection(&second)])
        .unwrap();
    let events = w.kit.take_events();
    assert_eq!(
        names(&events),
        [
            (Target::View(one.view), "workbook:pick-selected"),
            (Target::View(two.view), "workbook:pick-cancelled"),
            (Target::View(three.view), "workbook:pick-cancelled"),
        ]
    );
    assert_eq!(events[0].2, vec![selection(&second)]);
    // the pick is spent
    w.call(three, "workbook:pick-select", vec![selection(&second)])
        .unwrap();
    assert!(w.kit.take_events().is_empty());

    // cancelling tells the others, a stale id changes nothing
    let third = text(
        &w.call(two, "workbook:pick-arm", vec![obj([("wcId", num(1.0))])])
            .unwrap(),
        "pickId",
    );
    w.kit.take_events();
    w.call(
        two,
        "workbook:pick-cancel",
        vec![obj([("pickId", string("pick-stale"))])],
    )
    .unwrap();
    assert!(w.kit.take_events().is_empty());
    w.call(
        two,
        "workbook:pick-cancel",
        vec![obj([("pickId", string(third))])],
    )
    .unwrap();
    assert_eq!(
        names(&w.kit.take_events()),
        [
            (Target::View(one.view), "workbook:pick-cancelled"),
            (Target::View(three.view), "workbook:pick-cancelled"),
        ]
    );
}

type Outcome = Rc<RefCell<Option<Result<bool, IpcError>>>>;

fn outcome() -> (Outcome, shell_contract::editors::Then<bool>) {
    let cell: Outcome = Rc::default();
    let then = cell.clone();
    (
        cell,
        Box::new(move |result| *then.borrow_mut() = Some(result)),
    )
}

#[test]
fn a_close_with_unsaved_work_asks_then_waits_for_the_renderer() {
    let w = world("sheets-close", Value::Null);
    let one = w.tab(1);
    let editors = editor_for(&w.registry.provided, one.view).expect("sheets owns the view");
    let parent = Some(WindowId(1));

    // nothing pending: no question
    let (done, then) = outcome();
    editors.request_close(one.view, parent, then);
    assert_eq!(done.borrow_mut().take(), Some(Ok(true)));
    assert!(w.kit.take_log().is_empty());

    // the renderer mirrors its pending count
    w.call(one, "workbook:pending-edits", vec![num(3.0)])
        .unwrap();
    // junk counts are ignored
    w.call(one, "workbook:pending-edits", vec![num(-1.0)])
        .unwrap();
    w.call(one, "workbook:pending-edits", vec![string("many")])
        .unwrap();

    // Cancel
    w.kit.dialogs.messages.lock().unwrap().push_back(2);
    let (done, then) = outcome();
    editors.request_close(one.view, parent, then);
    assert_eq!(done.borrow_mut().take(), Some(Ok(false)));
    let log = w.kit.take_log();
    assert!(log[0].contains("3 unsaved change(s)"), "{}", log[0]);
    assert!(w.kit.take_events().is_empty());

    // Save: the renderer is asked, and close-save-result resumes the close
    w.kit.dialogs.messages.lock().unwrap().push_back(0);
    let (done, then) = outcome();
    editors.request_close(one.view, parent, then);
    assert!(done.borrow().is_none());
    assert_eq!(
        names(&w.kit.take_events()),
        [(Target::View(one.view), "workbook:close-save-request")]
    );
    w.call(
        one,
        "workbook:close-save-result",
        vec![IpcValue::Bool(true)],
    )
    .unwrap();
    assert_eq!(done.borrow_mut().take(), Some(Ok(true)));
    // a result nobody waits for is ignored
    w.call(
        one,
        "workbook:close-save-result",
        vec![IpcValue::Bool(true)],
    )
    .unwrap();

    // a failed save keeps the tab open
    w.kit.dialogs.messages.lock().unwrap().push_back(0);
    let (done, then) = outcome();
    editors.request_close(one.view, parent, then);
    w.call(
        one,
        "workbook:close-save-result",
        vec![IpcValue::Bool(false)],
    )
    .unwrap();
    assert_eq!(done.borrow_mut().take(), Some(Ok(false)));

    // no answer for two minutes: the close is refused
    w.kit.dialogs.messages.lock().unwrap().push_back(0);
    let (done, then) = outcome();
    editors.request_close(one.view, parent, then);
    w.shell().fire(120_000);
    assert_eq!(done.borrow_mut().take(), Some(Ok(false)));
    // the late result changes nothing
    w.call(
        one,
        "workbook:close-save-result",
        vec![IpcValue::Bool(true)],
    )
    .unwrap();

    // Don't Save closes without asking the renderer
    w.kit.dialogs.messages.lock().unwrap().push_back(1);
    w.kit.take_events();
    let (done, then) = outcome();
    editors.request_close(one.view, parent, then);
    assert_eq!(done.borrow_mut().take(), Some(Ok(true)));
    assert!(w.kit.take_events().is_empty());
}

#[test]
fn a_save_request_is_resumed_by_the_renderers_answer() {
    let w = world("sheets-request-save", Value::Null);
    let one = w.tab(1);
    let editors = editor_for(&w.registry.provided, one.view).unwrap();
    let (done, then) = outcome();
    editors.request_save(one.view, SaveMode::Save, then);
    assert_eq!(
        names(&w.kit.take_events()),
        [(Target::View(one.view), "workbook:close-save-request")]
    );
    assert!(done.borrow().is_none());
    w.call(
        one,
        "workbook:close-save-result",
        vec![IpcValue::Bool(true)],
    )
    .unwrap();
    assert_eq!(done.borrow_mut().take(), Some(Ok(true)));
    // the renderer going away resolves a waiting save as not saved
    let (done, then) = outcome();
    editors.request_save(one.view, SaveMode::SaveAs, then);
    w.call(one, "workbook:pending-edits", vec![num(1.0)])
        .unwrap();
    w.kit.destroy(one.view);
    assert_eq!(done.borrow_mut().take(), Some(Ok(false)));
}

#[test]
fn a_view_that_goes_takes_its_sessions_and_state_with_it() {
    let w = world("sheets-gone", Value::Null);
    let (one, two) = (w.tab(1), w.tab(2));
    let a = w.file("a.xlsx", b"xlsx");
    let b = w.file("b.xlsx", b"xlsx");
    w.open(one, &a);
    w.open(two, &b);
    let snapshots = w.dir.join("temp").join("seuoffice-sheets-sessions");
    let count = |dir: &PathBuf| fs::read_dir(dir).map_or(0, |d| d.filter_map(Result::ok).count());
    assert_eq!(count(&snapshots), 2);
    w.call(one, "workbook:pending-edits", vec![num(2.0)])
        .unwrap();
    let (done, then) = outcome();
    editor_for(&w.registry.provided, one.view)
        .unwrap()
        .request_save(one.view, SaveMode::Save, then);
    // a queued file and an armed pick die with the view
    views().unwrap().queue_workbook(one.view, &a);
    w.kit.destroy(one.view);
    assert_eq!(done.borrow_mut().take(), Some(Ok(false)));
    assert_eq!(count(&snapshots), 1);
    assert_eq!(
        w.call(two, "workbook:list-tabs", vec![]).unwrap(),
        obj([("tabs", IpcValue::Array(vec![]))])
    );
    assert!(editor_for(&w.registry.provided, one.view).is_none());
    // the dead view's recovery question is gone with it
    assert!(
        w.dir
            .join("userdata")
            .join("sheets-autosave")
            .read_dir()
            .is_err()
    );
    // an unsaved tab's window closing keeps its pending count out of the next tab
    let again = w.tab(1);
    assert_eq!(
        w.call(again, "sheets:has-queued-workbook", vec![]).unwrap(),
        IpcValue::Bool(false)
    );
}

#[test]
fn the_sidecar_dying_is_told_to_every_tab() {
    let w = world("sheets-crash", Value::Null);
    let (one, two) = (w.tab(1), w.tab(2));
    w.kit.take_events();
    w.engine().exit();
    assert_eq!(
        names(&w.kit.take_events()),
        [
            (Target::View(one.view), "workbook:sidecar-crashed"),
            (Target::View(two.view), "workbook:sidecar-crashed"),
        ]
    );
}

#[test]
fn flags_the_shell_and_the_renderer_share() {
    let w = world("sheets-flags", Value::Null);
    let one = w.tab(1);
    assert_eq!(
        w.call(one, "sheets:consume-new-blank", vec![]).unwrap(),
        IpcValue::Bool(false)
    );
    views().unwrap().set_new_blank();
    assert_eq!(
        w.call(one, "sheets:consume-new-blank", vec![]).unwrap(),
        IpcValue::Bool(true)
    );
    assert_eq!(
        w.call(one, "sheets:consume-new-blank", vec![]).unwrap(),
        IpcValue::Bool(false)
    );
    assert_eq!(
        w.call(one, "sheets:consume-headless-export", vec![])
            .unwrap(),
        IpcValue::Null
    );
    let settled = Rc::new(RefCell::new(None));
    let sink = settled.clone();
    views().unwrap().register_headless_export(
        one.view,
        "/out.pdf",
        Box::new(move |report| *sink.borrow_mut() = Some(report)),
    );
    assert_eq!(
        w.call(one, "sheets:consume-headless-export", vec![])
            .unwrap(),
        string("/out.pdf")
    );
    w.call(
        one,
        "sheets:headless-export-done",
        vec![obj([("ok", IpcValue::Bool(true))])],
    )
    .unwrap();
    assert_eq!(settled.borrow().as_ref().map(|r| r.ok), Some(true));
}

#[test]
fn an_oversized_delimited_file_is_refused_before_it_is_read() {
    let w = world(
        "sheets-limit",
        serde_json::json!({ "sheets": { "importLimit": 1024.0 } }),
    );
    let one = w.tab(1);
    let big = w.file("big.csv", &vec![b'a'; 2048]);
    views().unwrap().queue_workbook(one.view, &big);
    let error = w.call(one, "workbook:select", vec![]).unwrap_err();
    assert_eq!(error.message, "exceeds the 0MB limit (0.0 MB)");
    // the open left nothing behind
    assert!(
        !w.dir
            .join("temp")
            .join("seuoffice-imports")
            .read_dir()
            .is_ok_and(|d| d.count() > 0)
    );
}

#[test]
fn every_channel_of_the_list_has_a_handler() {
    let w = world("sheets-channels", Value::Null);
    let mine: Vec<&str> = shell_contract::CHANNELS
        .iter()
        .filter(|spec| {
            spec.batch == Batch::D1
                && (spec.name.starts_with("workbook:") || spec.name.starts_with("sheets:"))
                && !spec
                    .kinds
                    .contains(&shell_contract::ipc::ChannelKind::Event)
        })
        .map(|spec| spec.name)
        .collect();
    let missing: Vec<&&str> = mine
        .iter()
        .filter(|name| !w.registry.handlers.contains_key(**name))
        .collect();
    assert!(missing.is_empty(), "no handler for {missing:?}");
    assert_eq!(w.registry.handlers.len(), mine.len());
    assert_eq!(mine.len(), 54);
}
