use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use main_core::packages::electron_utils::recovery_store::SharedRecoveryState;
use serde_json::{Value, json};
use shell_contract::editors::{DocumentEditors, SaveMode, editor_for};
use shell_contract::ipc::{Sender, Target};
use shell_contract::{BytesKind, IpcValue, Surface, ViewId};

use super::PdfEditors;
use super::fakes::{FakeShell, engine, shell};
use super::open::{NoClobber, move_pdf_file_no_clobber, sanitize_auto_rename_base};
use super::{PdfEngineHost, PdfShellHost};
use crate::kit::{IntoIpc, field, obj};
use crate::testing::{HostCall, Rt};

const ORIGINAL: &[u8] = b"%PDF-1.7 original %%EOF";

/// A shell with the editor registered and one PDF view on `file`
struct T {
    rt: Rt,
    view: Sender,
    file: String,
    shell: Arc<FakeShell>,
}

fn rt_with(case: Value) -> (Rt, Arc<FakeShell>) {
    let fake_shell = shell(&case);
    let s = fake_shell.clone();
    let mut rt = Rt::new(move |h| {
        h.insert::<PdfEngineHost>(engine(&case));
        h.insert::<PdfShellHost>(s);
        h.insert(Arc::new(Mutex::new(SharedRecoveryState::new("test"))));
        // crate::pdf::entries registers the tools beside the editor
        crate::pdf::tools::fakes(h, &Value::Null);
    });
    rt.register(crate::pdf::entries).unwrap();
    (rt, fake_shell)
}

fn pdf(rt: &Rt) -> Rc<PdfEditors> {
    rt.provided()
        .all::<PdfEditors>()
        .pop()
        .expect("the pdf editor")
}

fn setup(case: Value) -> T {
    let (rt, shell) = rt_with(case);
    let file = rt.dir.join("doc.pdf").to_string_lossy().into_owned();
    std::fs::write(&file, ORIGINAL).unwrap();
    let view = rt.view(1, Surface::Pdf);
    pdf(&rt).open_view(view.view, Some(&file));
    T {
        rt,
        view,
        file,
        shell,
    }
}

impl T {
    fn invoke(&mut self, channel: &str, args: Vec<IpcValue>) -> IpcValue {
        self.rt.invoke_now(channel, self.view, args).unwrap()
    }
    fn send(&mut self, channel: &str, args: Vec<IpcValue>) {
        self.rt.send(channel, self.view, args)
    }
    fn path(&self, name: &str) -> String {
        self.rt.dir.join(name).to_string_lossy().into_owned()
    }
    fn events(&self) -> Vec<(&'static str, Vec<IpcValue>)> {
        self.rt
            .events()
            .into_iter()
            .map(|e| {
                assert_eq!(e.target, Target::View(self.view.view));
                (e.channel, e.args)
            })
            .collect()
    }
    fn calls(&self) -> Vec<String> {
        std::mem::take(&mut *self.shell.calls.lock().unwrap())
    }
}

fn s(v: &str) -> IpcValue {
    v.into_ipc()
}

fn ok(v: &IpcValue) -> bool {
    field(v, "ok") == &IpcValue::Bool(true)
}

fn err(v: &IpcValue) -> &str {
    crate::kit::as_str(field(v, "error")).unwrap_or_else(|| panic!("no error in {v:?}"))
}

/// A slot a continuation fills
type Slot<T> = Rc<RefCell<Option<T>>>;

fn slot<T: 'static>() -> (Slot<T>, Box<dyn FnOnce(T)>) {
    let cell = Rc::new(RefCell::new(None));
    let fill = cell.clone();
    (cell, Box::new(move |v| *fill.borrow_mut() = Some(v)))
}

fn empty_save(path: &str) -> IpcValue {
    obj([
        ("path", s(path)),
        ("markups", IpcValue::Array(vec![])),
        ("drawings", IpcValue::Array(vec![])),
        ("formValues", IpcValue::Array(vec![])),
        ("stamps", IpcValue::Array(vec![])),
    ])
}

// ---- reading ----

#[test]
fn reads_only_granted_files() {
    let mut t = setup(Value::Null);
    let other = t.path("other.pdf");
    std::fs::write(&other, b"x").unwrap();
    let refused =
        t.rt.invoke_now("pdf:read-file", t.view, vec![s(&other)])
            .unwrap_err();
    assert_eq!(refused.message, "pdf: path not granted to this view");
    let read = t.invoke("pdf:read-file", vec![s(&t.file.clone())]);
    assert_eq!(
        read,
        IpcValue::Bytes(BytesKind::ArrayBuffer, ORIGINAL.to_vec())
    );
    // another view has its own grants
    let stranger = t.rt.view(2, Surface::Pdf);
    assert!(
        t.rt.invoke_now("pdf:read-file", stranger, vec![s(&t.file)])
            .is_err()
    );
}

#[test]
fn chunks_are_bounded_slices_with_the_file_size() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    let chunk = t.invoke(
        "pdf:read-file-chunk",
        vec![s(&f), 2.0.into_ipc(), 5.0.into_ipc()],
    );
    assert_eq!(
        field(&chunk, "data"),
        &IpcValue::Bytes(BytesKind::Uint8Array, b"DF-".to_vec())
    );
    assert_eq!(
        field(&chunk, "fileSize"),
        &(ORIGINAL.len() as f64).into_ipc()
    );
    for (from, to) in [
        (5.0, 2.0),
        (-1.0, 3.0),
        (0.0, 8.0 * 1024.0 * 1024.0 + 1.0),
        (0.5, 3.0),
    ] {
        let e = t.rt.invoke_now(
            "pdf:read-file-chunk",
            t.view,
            vec![s(&f), from.into_ipc(), to.into_ipc()],
        );
        assert_eq!(e.unwrap_err().message, "pdf: invalid chunk range");
    }
}

// ---- saving ----

#[test]
fn save_checks_target_and_annotation_handling() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    let other = t.path("copy.pdf");
    let req = |extra: Vec<(&str, IpcValue)>| {
        let mut base = empty_save(&f);
        if let IpcValue::Object(entries) = &mut base {
            entries.extend(extra.into_iter().map(|(k, v)| (k.to_owned(), v)));
        }
        base
    };
    let cases = [
        (
            req(vec![("targetPath", s(&other))]),
            "pdf: target path not granted to this view",
        ),
        (
            req(vec![("annotations", s("burn"))]),
            "pdf: invalid annotation handling",
        ),
        (
            req(vec![("annotations", s("flatten"))]),
            "pdf: annotation handling requires Save As",
        ),
        (
            req(vec![("copyOnly", true.into_ipc())]),
            "pdf: copyOnly requires Save As",
        ),
    ];
    for (request, error) in cases {
        let answer = t.invoke("pdf:save", vec![request]);
        assert_eq!(err(&answer), error);
    }
    assert!(ok(&t.invoke("pdf:save", vec![req(vec![])])));
}

#[test]
fn save_as_goes_to_the_target_the_main_side_granted() {
    let mut t = setup(Value::Null);
    let target = t.path("copy.pdf");
    let (outcome, then) = slot();
    pdf(&t.rt).request_save_as_outcome(t.view.view, &target, then);
    assert_eq!(t.events(), vec![("pdf:save-as-request", vec![s(&target)])]);
    let mut request = empty_save(&t.file);
    if let IpcValue::Object(e) = &mut request {
        e.push(("targetPath".into(), s(&target)));
        e.push(("copyOnly".into(), true.into_ipc()));
    }
    assert!(ok(&t.invoke("pdf:save", vec![request.clone()])));
    assert_eq!(std::fs::read(&target).unwrap(), ORIGINAL);
    t.send("pdf:save-as-result", vec![true.into_ipc()]);
    assert_eq!(
        *outcome.borrow(),
        Some(super::editors::SaveAsOutcome::Saved)
    );
    // the grant ended with the flow
    assert_eq!(
        err(&t.invoke("pdf:save", vec![request])),
        "pdf: target path not granted to this view"
    );
}

#[test]
fn save_as_times_out_and_a_cancel_is_not_a_failure() {
    let mut t = setup(Value::Null);
    let (first, then) = slot();
    pdf(&t.rt).request_save_as_outcome(t.view.view, &t.path("a.pdf"), then);
    t.send("pdf:save-as-result", vec![s("cancelled")]);
    assert_eq!(
        *first.borrow(),
        Some(super::editors::SaveAsOutcome::Cancelled)
    );
    let (second, then) = slot();
    pdf(&t.rt).request_save_as_outcome(t.view.view, &t.path("b.pdf"), then);
    t.rt.advance(Duration::from_secs(119));
    assert_eq!(*second.borrow(), None);
    t.rt.advance(Duration::from_secs(1));
    assert_eq!(
        *second.borrow(),
        Some(super::editors::SaveAsOutcome::Failed)
    );
}

#[test]
fn a_sibling_pane_change_stops_a_manual_save_when_the_person_keeps_it() {
    let mut t = setup(json!({ "shell": { "isPathOpenElsewhere": true } }));
    let f = t.file.clone();
    t.invoke("pdf:read-file", vec![s(&f)]);
    std::fs::write(&f, b"%PDF changed by the sibling pane %%EOF").unwrap();
    // second button: keep the disk copy
    t.rt.script().message.push_back(1);
    assert_eq!(
        err(&t.invoke("pdf:save", vec![empty_save(&f)])),
        "external-modified"
    );
    // an automatic save defers silently
    let mut auto = empty_save(&f);
    if let IpcValue::Object(e) = &mut auto {
        e.push(("auto".into(), true.into_ipc()));
    }
    assert_eq!(err(&t.invoke("pdf:save", vec![auto])), "external-modified");
    let asked =
        t.rt.script()
            .calls
            .iter()
            .filter(|c| matches!(c, HostCall::Message(..)))
            .count();
    assert_eq!(asked, 1);
}

#[test]
fn redactions_need_their_own_copy_and_no_other_edits() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    let region = json!([{ "pageIndex": 0, "rect": [0, 0, 10, 10] }]);
    let with = |mut r: IpcValue, k: &str, v: IpcValue| {
        if let IpcValue::Object(e) = &mut r {
            e.push((k.into(), v));
        }
        r
    };
    let redact = with(empty_save(&f), "redactions", crate::kit::from_json(&region));
    assert_eq!(
        err(&t.invoke("pdf:save", vec![redact.clone()])),
        "pdf: permanent redaction requires Save As copy"
    );
    // on a granted copy target, other edits are refused, and a missing list throws as V8 does
    let target = t.path("red.pdf");
    pdf(&t.rt).request_save_as_outcome(t.view.view, &target, Box::new(|_| {}));
    let to_copy = with(redact.clone(), "targetPath", s(&target));
    let busy = with(
        to_copy.clone(),
        "deletedPages",
        IpcValue::Array(vec![1.0.into_ipc()]),
    );
    assert_eq!(
        err(&t.invoke("pdf:save", vec![busy])),
        "pdf: save other pending edits before applying redactions"
    );
    let thrown = obj([
        ("path", s(&f)),
        ("targetPath", s(&target)),
        ("redactions", crate::kit::from_json(&region)),
    ]);
    let e =
        t.rt.invoke_now("pdf:save", t.view, vec![thrown])
            .unwrap_err();
    assert_eq!(e.name.as_deref(), Some("TypeError"));
    // the copy is written and becomes the view's document
    assert!(ok(&t.invoke("pdf:save", vec![to_copy])));
    assert_eq!(pdf(&t.rt).0.open_path(t.view.view), Some(target.clone()));
    assert!(pdf(&t.rt).path_granted(t.view.view, &target));
    assert!(!pdf(&t.rt).path_granted(t.view.view, &f));
    assert!(t.calls().contains(&format!("redactionSaved 1 {target}")));
}

#[test]
fn redaction_copy_flow_marks_the_save_as_and_waits_for_the_renderer() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    t.rt.script().save.push_back(None);
    assert_eq!(
        t.invoke("pdf:request-redaction-copy", vec![s(&f)]),
        false.into_ipc()
    );
    assert_eq!(
        t.events(),
        vec![
            ("pdf:save-as-flow", vec![true.into_ipc()]),
            ("pdf:save-as-flow", vec![false.into_ipc()])
        ]
    );
    let target = t.path("doc-redacted.pdf");
    t.rt.script().save.push_back(Some(PathBuf::from(&target)));
    let pending =
        t.rt.invoke("pdf:request-redaction-copy", t.view, vec![s(&f)]);
    assert!(pending.take().is_none());
    // a second flow is refused while the first waits
    assert_eq!(
        t.invoke("pdf:request-redaction-copy", vec![s(&f)]),
        false.into_ipc()
    );
    t.send("pdf:save-as-result", vec![true.into_ipc()]);
    assert_eq!(pending.take(), Some(Ok(true.into_ipc())));
    let events = t.events();
    assert_eq!(events[1], ("pdf:save-as-request", vec![s(&target)]));
    assert_eq!(
        events.last().unwrap(),
        &("pdf:save-as-flow", vec![false.into_ipc()])
    );
    // the default name sits beside the file
    let asked = t.rt.script().calls.iter().find_map(|c| match c {
        HostCall::Save(_, d) => d.default_path.clone(),
        _ => None,
    });
    assert_eq!(asked, Some(PathBuf::from(t.path("doc-redacted.pdf"))));
}

// ---- close and flush ----

#[test]
fn close_of_a_dirty_view_asks_and_waits_for_the_renderer_save() {
    let mut t = setup(Value::Null);
    let view = t.view.view;
    let ed = super::editors::PdfEditors(pdf(&t.rt).0.clone());
    let (clean, then) = slot();
    ed.request_close(view, None, Box::new(move |r| then(r.unwrap())));
    assert_eq!(*clean.borrow(), Some(true));
    t.send("pdf:dirty-changed", vec![true.into_ipc()]);
    assert!(ed.is_dirty(view));

    t.rt.script().message.push_back(0);
    let (saved, then) = slot();
    ed.request_close(view, None, Box::new(move |r| then(r.unwrap())));
    assert_eq!(
        t.events(),
        vec![(
            "pdf:close-save-request",
            vec![obj([("flushAll", true.into_ipc())])]
        )]
    );
    assert_eq!(*saved.borrow(), None);
    t.send("pdf:close-save-result", vec![true.into_ipc()]);
    assert_eq!(*saved.borrow(), Some(true));

    t.rt.script().message.push_back(2);
    let (cancel, then) = slot();
    ed.request_close(view, None, Box::new(move |r| then(r.unwrap())));
    assert_eq!(*cancel.borrow(), Some(false));

    t.rt.script().message.push_back(1);
    let (dont, then) = slot();
    ed.request_close(view, None, Box::new(move |r| then(r.unwrap())));
    assert_eq!(*dont.borrow(), Some(true));
    assert_eq!(
        t.events(),
        vec![("pdf:recovery-dropped", vec![true.into_ipc()])]
    );
    ed.close_cancelled(view);
    assert_eq!(
        t.events(),
        vec![("pdf:recovery-dropped", vec![false.into_ipc()])]
    );
}

#[test]
fn flush_save_times_out_as_a_failure_and_clean_views_pass() {
    let mut t = setup(Value::Null);
    let ed = pdf(&t.rt);
    let (clean, then) = slot();
    ed.flush_save(t.view.view, true, then);
    assert_eq!(*clean.borrow(), Some(true));
    t.send("pdf:dirty-changed", vec![true.into_ipc()]);
    let (late, then) = slot();
    ed.flush_save(t.view.view, false, then);
    assert_eq!(
        t.events(),
        vec![(
            "pdf:close-save-request",
            vec![obj([("flushAll", false.into_ipc())])]
        )]
    );
    t.rt.advance(Duration::from_secs(120));
    assert_eq!(*late.borrow(), Some(false));
    // a result after the timeout reaches nobody
    t.send("pdf:close-save-result", vec![true.into_ipc()]);
}

#[test]
fn a_destroyed_view_fails_its_waiters_and_drops_its_state() {
    let mut t = setup(Value::Null);
    let (outcome, then) = slot();
    pdf(&t.rt).request_save_as_outcome(t.view.view, &t.path("x.pdf"), then);
    t.rt.destroy(t.view.view);
    assert_eq!(
        *outcome.borrow(),
        Some(super::editors::SaveAsOutcome::Failed)
    );
    assert!(editor_for(&t.rt.provided(), t.view.view).is_none());
    assert_eq!(pdf(&t.rt).0.open_path(t.view.view), None);
}

// ---- the DocumentEditors face ----

#[test]
fn document_editors_answer_for_their_views() {
    let mut t = setup(Value::Null);
    let view = t.view.view;
    let ed = editor_for(&t.rt.provided(), view).unwrap();
    assert_eq!(ed.document_path(view), Some(PathBuf::from(&t.file)));
    assert!(editor_for(&t.rt.provided(), ViewId(9)).is_none());

    let target = t.path("mcp.pdf");
    let (done, then) = slot();
    ed.save_to_path(
        view,
        PathBuf::from(&target),
        Box::new(move |r| then(r.is_ok())),
    );
    t.send("pdf:save-as-result", vec![s("failed")]);
    assert_eq!(*done.borrow(), Some(false));

    t.rt.script().save.push_back(Some(PathBuf::from(&target)));
    let (saved, then) = slot();
    ed.request_save(view, SaveMode::SaveAs, Box::new(move |r| then(r.unwrap())));
    t.send("pdf:save-as-result", vec![true.into_ipc()]);
    assert_eq!(*saved.borrow(), Some(true));

    let (text, then) = slot();
    ed.read_text(view, Box::new(move |r| then(r.is_err())));
    assert_eq!(*text.borrow(), Some(true));

    let renamed = t.path("moved.pdf");
    ed.file_renamed(view, Path::new(&t.file), Path::new(&renamed));
    assert_eq!(ed.document_path(view), Some(PathBuf::from(&renamed)));
    assert!(pdf(&t.rt).path_granted(view, &renamed));
    assert!(
        t.events()
            .contains(&("pdf:file-renamed", vec![s(&renamed)]))
    );
}

// ---- names and untitled documents ----

#[test]
fn auto_rename_base_names_are_safe() {
    assert_eq!(sanitize_auto_rename_base("  a/b:c  "), Some("a b c".into()));
    assert_eq!(
        sanitize_auto_rename_base("...Report..."),
        Some("Report".into())
    );
    assert_eq!(sanitize_auto_rename_base("con"), Some("con_".into()));
    assert_eq!(sanitize_auto_rename_base("COM1"), Some("COM1_".into()));
    assert_eq!(sanitize_auto_rename_base(" ... "), None);
    let long = "x".repeat(45);
    assert_eq!(sanitize_auto_rename_base(&long).unwrap().len(), 40);
}

#[test]
fn no_clobber_move_never_replaces_a_file() {
    let (rt, _) = rt_with(Value::Null);
    let a = rt.dir.join("a.pdf").to_string_lossy().into_owned();
    let b = rt.dir.join("b.pdf").to_string_lossy().into_owned();
    std::fs::write(&a, b"A").unwrap();
    std::fs::write(&b, b"B").unwrap();
    assert_eq!(move_pdf_file_no_clobber(&a, &b), NoClobber::Occupied);
    assert_eq!(std::fs::read(&b).unwrap(), b"B");
    let c = rt.dir.join("c.pdf").to_string_lossy().into_owned();
    assert_eq!(move_pdf_file_no_clobber(&a, &c), NoClobber::Moved);
    assert!(!Path::new(&a).exists());
    assert_eq!(std::fs::read(&c).unwrap(), b"A");
}

#[test]
fn only_untitled_blanks_rename_from_their_content() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    let not = obj([("renamed", false.into_ipc())]);
    assert_eq!(t.invoke("pdf:auto-rename", vec![s(&f), s("Budget")]), not);
    pdf(&t.rt).mark_untitled_path(&f);
    assert_eq!(t.invoke("pdf:is-untitled", vec![s(&f)]), true.into_ipc());
    assert_eq!(t.invoke("pdf:note-unsaved", vec![]), true.into_ipc());
    std::fs::write(t.path("Budget.pdf"), b"taken").unwrap();
    let renamed = t.invoke("pdf:auto-rename", vec![s(&f), s("Budget")]);
    let target = t.path("Budget-2.pdf");
    assert_eq!(
        renamed,
        obj([
            ("renamed", true.into_ipc()),
            ("path", s(&target)),
            ("name", s("Budget-2.pdf"))
        ])
    );
    assert_eq!(std::fs::read(&target).unwrap(), ORIGINAL);
    assert!(!pdf(&t.rt).path_granted(t.view.view, &f));
    assert_eq!(t.calls(), vec![format!("renamed 1 {f} {target}")]);
    // the blank moved along: still unsaved until its first save
    assert_eq!(t.invoke("pdf:note-unsaved", vec![]), true.into_ipc());
    assert!(ok(&t.invoke("pdf:save", vec![empty_save(&target)])));
    assert_eq!(t.invoke("pdf:note-unsaved", vec![]), false.into_ipc());
}

#[test]
fn an_untitled_copy_goes_where_the_person_picks() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    assert_eq!(
        t.invoke("pdf:is-untitled-copy", vec![s(&f)]),
        false.into_ipc()
    );
    pdf(&t.rt).mark_untitled_copy(&f);
    assert_eq!(
        t.invoke("pdf:is-untitled-copy", vec![s(&f)]),
        true.into_ipc()
    );
    assert_eq!(
        err(&t.invoke("pdf:adopt-untitled-copy", vec![s(&f)])),
        "pdf: no place was picked for this document"
    );
    t.rt.script().save.push_back(None);
    assert_eq!(
        t.invoke("pdf:pick-untitled-copy-target", vec![s(&f), s("Mine.pdf")]),
        false.into_ipc()
    );
    let picked = t.path("Kept");
    t.rt.script().save.push_back(Some(PathBuf::from(&picked)));
    assert_eq!(
        t.invoke("pdf:pick-untitled-copy-target", vec![s(&f), s("Mine.pdf")]),
        true.into_ipc()
    );
    let adopted = t.invoke("pdf:adopt-untitled-copy", vec![s(&f)]);
    let target = format!("{picked}.pdf");
    assert_eq!(
        adopted,
        obj([("ok", true.into_ipc()), ("path", s(&target))])
    );
    assert_eq!(std::fs::read(&target).unwrap(), ORIGINAL);
    assert_eq!(pdf(&t.rt).0.open_path(t.view.view), Some(target.clone()));
    assert_eq!(
        t.invoke("pdf:is-untitled-copy", vec![s(&target)]),
        false.into_ipc()
    );
    // the dialog started in the default save folder with the suggested name
    let default = t.rt.script().calls.iter().find_map(|c| match c {
        HostCall::Save(_, d) => d.default_path.clone(),
        _ => None,
    });
    let default = default.unwrap();
    assert!(
        default.starts_with(&t.rt.dir) && default.ends_with("Mine.pdf"),
        "{default:?}"
    );
}

// ---- page operations ----

#[test]
fn in_place_page_operations_are_this_views_own_writes() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    // nothing of this view's own on disk yet: a kept copy is not written back
    let restore = obj([
        ("path", s(&f)),
        (
            "bytes",
            IpcValue::Bytes(BytesKind::ArrayBuffer, b"old".to_vec()),
        ),
    ]);
    assert_eq!(
        err(&t.invoke("pdf:restore-file", vec![restore.clone()])),
        "external-modified"
    );
    let blank = t.invoke(
        "pdf:insert-blank-page",
        vec![obj([("path", s(&f)), ("afterPageIndex", 0.0.into_ipc())])],
    );
    assert!(ok(&blank));
    assert!(ok(&t.invoke("pdf:restore-file", vec![restore.clone()])));
    assert_eq!(std::fs::read(&f).unwrap(), b"old");
    // another program's write in between is not overwritten
    std::fs::write(&f, b"someone else, longer").unwrap();
    assert_eq!(
        err(&t.invoke("pdf:restore-file", vec![restore])),
        "external-modified"
    );
    // a Uint8Array is not the ArrayBuffer the renderer sends
    let wrong = obj([
        ("path", s(&f)),
        (
            "bytes",
            IpcValue::Bytes(BytesKind::Uint8Array, b"x".to_vec()),
        ),
    ]);
    assert_eq!(
        err(&t.invoke("pdf:restore-file", vec![wrong])),
        "pdf: path not granted to this view"
    );
}

#[test]
fn insert_pdf_asks_for_a_file_and_rewrites_the_document() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    let req = obj([("path", s(&f)), ("afterPageIndex", 0.0.into_ipc())]);
    t.rt.script().open.push_back(None);
    assert_eq!(
        t.invoke("pdf:insert-pdf", vec![req.clone()]),
        obj([("ok", true.into_ipc()), ("canceled", true.into_ipc())])
    );
    let other = t.path("other.pdf");
    std::fs::write(&other, b"+OTHER").unwrap();
    t.rt.script()
        .open
        .push_back(Some(vec![PathBuf::from(&other)]));
    assert_eq!(
        t.invoke("pdf:insert-pdf", vec![req]),
        obj([("ok", true.into_ipc()), ("insertedCount", 1.0.into_ipc())])
    );
    assert_eq!(std::fs::read(&f).unwrap(), [ORIGINAL, b"+OTHER"].concat());
    // the dialog opened in the folder of the last pick next time
    t.rt.script().open.push_back(None);
    t.invoke("pdf:insert-pdf", vec![obj([("path", s(&f))])]);
    let last = t.rt.script().calls.iter().rev().find_map(|c| match c {
        HostCall::Open(_, d) => Some(d.clone()),
        _ => None,
    });
    assert_eq!(last.unwrap().default_path, Some(t.rt.dir.clone()));
}

#[test]
fn copied_pages_paste_into_any_view() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    let paste = obj([("path", s(&f)), ("afterPageIndex", 0.0.into_ipc())]);
    assert_eq!(
        t.invoke("pdf:paste-pages", vec![paste.clone()]),
        obj([("ok", true.into_ipc()), ("insertedCount", 0.0.into_ipc())])
    );
    let source = obj([("path", s(&f))]);
    let protected = obj([("path", s(&f)), ("encryption", obj([]))]);
    let copy = |src: IpcValue| {
        obj([
            ("source", src),
            (
                "pages",
                IpcValue::Array(vec![0.0.into_ipc(), 1.0.into_ipc()]),
            ),
        ])
    };
    assert_eq!(
        field(
            &t.invoke("pdf:copy-pages", vec![copy(protected)]),
            "protected"
        ),
        &true.into_ipc()
    );
    assert_eq!(
        t.invoke("pdf:copy-pages", vec![copy(source)]),
        obj([("ok", true.into_ipc()), ("count", 2.0.into_ipc())])
    );
    assert_eq!(t.invoke("pdf:copied-page-count", vec![]), 2.0.into_ipc());
    assert!(ok(&t.invoke("pdf:paste-pages", vec![paste])));
    assert_eq!(std::fs::read(&f).unwrap(), [ORIGINAL, ORIGINAL].concat());
    let stranger = t.rt.view(2, Surface::Pdf);
    assert_eq!(
        t.rt.invoke_now("pdf:copied-page-count", stranger, vec![])
            .unwrap(),
        0.0.into_ipc()
    );
}

#[test]
fn generated_pdfs_go_to_the_save_folder_and_show() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    let answer = t.invoke(
        "pdf:extract-pages",
        vec![obj([
            ("path", s(&f)),
            ("pages", IpcValue::Array(vec![0.0.into_ipc()])),
            ("suggestedName", s("part.pdf")),
        ])],
    );
    let saved = crate::kit::as_str(field(&answer, "savedPath"))
        .unwrap()
        .to_owned();
    assert!(
        saved.starts_with(&*t.rt.dir.to_string_lossy()) && saved.ends_with("part.pdf"),
        "{saved}"
    );
    assert_eq!(std::fs::read(&saved).unwrap(), ORIGINAL);
    assert_eq!(t.calls(), vec![format!("openGeneratedPath {saved}")]);
    assert!(
        t.rt.script()
            .calls
            .contains(&HostCall::ShowItemInFolder(PathBuf::from(&saved)))
    );
    // argument checks of the grid operations
    let bad = |k: &str, v: IpcValue| obj([("path", s(&f)), (k, v)]);
    assert_eq!(
        err(&t.invoke("pdf:merge-pages", vec![bad("perSheet", 17.0.into_ipc())])),
        "pdf: pages-per-sheet must be 2-16"
    );
    assert_eq!(
        err(&t.invoke("pdf:split-pages", vec![bad("perPage", 3.0.into_ipc())])),
        "pdf: unsupported split grid"
    );
    assert_eq!(
        err(&t.invoke("pdf:set-page-size", vec![bad("width", (-1.0).into_ipc())])),
        "pdf: invalid page size"
    );
    assert_eq!(
        err(&t.invoke(
            "pdf:crop-pages",
            vec![bad("pages", IpcValue::Array(vec![]))]
        )),
        "pdf: path not granted to this view"
    );
}

#[test]
fn merges_refuse_inputs_over_the_size_budget_before_reading_them() {
    let (rt, _) = rt_with(Value::Null);
    let base = rt.dir.join("base.pdf");
    std::fs::write(&base, b"b").unwrap();
    let huge = rt.dir.join("huge.pdf");
    std::fs::File::create(&huge)
        .unwrap()
        .set_len(1_073_741_824)
        .unwrap();
    let e = super::pages::read_merge_inputs(
        &base.to_string_lossy(),
        &[huge.to_string_lossy().into_owned()],
    )
    .unwrap_err();
    assert_eq!(
        e,
        "pdf: merge too large \u{2014} the selected files total 1024 MB, over the 1024 MB merge limit"
    );
}

#[test]
fn split_writes_numbered_files_into_the_picked_folder() {
    let mut t = setup(json!({ "engine": { "splitPdf": [["one", "two"]] } }));
    let f = t.file.clone();
    let dir = t.path("out");
    std::fs::create_dir(&dir).unwrap();
    t.rt.script()
        .open
        .push_back(Some(vec![PathBuf::from(&dir)]));
    let answer = t.invoke(
        "pdf:split-pdf",
        vec![obj([("path", s(&f)), ("baseName", s("a:b"))])],
    );
    assert_eq!(
        answer,
        obj([
            ("ok", true.into_ipc()),
            ("savedDir", s(&dir)),
            ("count", 2.0.into_ipc())
        ])
    );
    assert_eq!(
        std::fs::read(Path::new(&dir).join("a_b-2.pdf")).unwrap(),
        b"two"
    );
}

#[test]
fn reduce_size_writes_only_a_smaller_copy() {
    let mut t =
        setup(json!({ "engine": { "shrink": [{}, { "bytes": "tiny", "imagesDownsampled": 2 }] } }));
    let f = t.file.clone();
    let target = t.path("doc-small.pdf");
    t.rt.script().save.push_back(Some(PathBuf::from(&target)));
    let same = t.invoke("pdf:reduce-file-size", vec![s(&f)]);
    assert_eq!(
        field(&same, "bytesAfter"),
        &(ORIGINAL.len() as f64).into_ipc()
    );
    assert!(!Path::new(&target).exists());
    t.rt.script().save.push_back(Some(PathBuf::from(&target)));
    let smaller = t.invoke("pdf:reduce-file-size", vec![s(&f)]);
    assert_eq!(field(&smaller, "imagesDownsampled"), &2.0.into_ipc());
    assert_eq!(std::fs::read(&target).unwrap(), b"tiny");
    t.rt.script().save.push_back(None);
    assert_eq!(
        t.invoke("pdf:reduce-file-size", vec![s(&f)]),
        obj([("ok", false.into_ipc()), ("canceled", true.into_ipc())])
    );
}

// ---- images and attachments ----

#[test]
fn page_images_from_save_as_use_the_name_the_shell_picked_once() {
    let mut t = setup(Value::Null);
    let images = IpcValue::Array(vec![s("aGk="), s("aGk=")]);
    let req = |save_as: bool| {
        obj([
            ("images", images.clone()),
            (
                "pageNumbers",
                IpcValue::Array(vec![1.0.into_ipc(), 2.0.into_ipc()]),
            ),
            ("baseName", s("doc")),
            ("saveAs", save_as.into_ipc()),
        ])
    };
    assert_eq!(
        err(&t.invoke("pdf:export-images", vec![req(true)])),
        "pdf: target not picked for this view"
    );
    let target = t.path("pages.png");
    assert!(!pdf(&t.rt).request_page_images(t.view.view, &t.path("pages.jpg")));
    assert!(pdf(&t.rt).request_page_images(t.view.view, &target));
    assert_eq!(t.events(), vec![("pdf:export-images-request", vec![])]);
    let answer = t.invoke("pdf:export-images", vec![req(true)]);
    assert_eq!(field(&answer, "count"), &2.0.into_ipc());
    let written: Vec<_> = std::fs::read_dir(&t.rt.dir)
        .unwrap()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "png"))
        .collect();
    assert_eq!(written.len(), 2);
    assert_eq!(
        err(&t.invoke("pdf:export-images", vec![req(true)])),
        "pdf: target not picked for this view"
    );
    let bad = obj([
        ("images", images),
        ("pageNumbers", IpcValue::Array(vec![1.0.into_ipc()])),
    ]);
    assert_eq!(
        err(&t.invoke("pdf:export-images", vec![bad])),
        "pdf: invalid page numbers"
    );
    assert_eq!(
        err(&t.invoke("pdf:export-images", vec![obj([])])),
        "pdf: no images"
    );
}

#[test]
fn attachments_travel_base64_through_main_side_dialogs() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    let file = t.path("note.txt");
    std::fs::write(&file, b"hi").unwrap();
    t.rt.script()
        .open
        .push_back(Some(vec![PathBuf::from(&file)]));
    assert_eq!(
        t.invoke("pdf:pick-attachment-file", vec![]),
        obj([
            ("ok", true.into_ipc()),
            ("name", s("note.txt")),
            ("bytesBase64", s("aGk="))
        ])
    );
    t.rt.script().open.push_back(None);
    assert_eq!(
        t.invoke("pdf:pick-attachment-file", vec![]),
        obj([("ok", false.into_ipc()), ("cancelled", true.into_ipc())])
    );
    let out = t.path("out.txt");
    t.rt.script().save.push_back(Some(PathBuf::from(&out)));
    let exported = t.invoke(
        "pdf:export-attachment",
        vec![s(&f), s("note.txt"), s("aGk=")],
    );
    assert_eq!(
        exported,
        obj([("ok", true.into_ipc()), ("targetPath", s(&out))])
    );
    assert_eq!(std::fs::read(&out).unwrap(), b"hi");
    assert_eq!(
        t.invoke("pdf:export-attachment", vec![s(&f), 1.0.into_ipc(), s("x")]),
        obj([
            ("ok", false.into_ipc()),
            ("reason", s("pdf: malformed export request"))
        ])
    );
}

#[test]
fn engine_reads_check_their_requests() {
    let mut t = setup(json!({ "engine": { "listPageImages": [{ "pageIndex": 0 }] } }));
    let f = t.file.clone();
    assert_eq!(
        t.invoke("pdf:list-page-images", vec![s(&f)]),
        crate::kit::from_json(&json!([{ "pageIndex": 0 }]))
    );
    let thrown = |t: &mut T, ch: &str, a: IpcValue| {
        t.rt.invoke_now(ch, t.view, vec![a]).unwrap_err().message
    };
    assert_eq!(
        thrown(&mut t, "pdf:annot-subjects", s("/nope.pdf")),
        "pdf: path not granted to this view"
    );
    let preview = obj([
        ("path", s(&f)),
        ("pageIndex", 0.0.into_ipc()),
        ("excludeRects", IpcValue::Array(vec![])),
    ]);
    assert_eq!(
        thrown(&mut t, "pdf:page-preview-png", preview),
        "pdf: path not granted to this view"
    );
    let image = obj([
        ("path", s(&f)),
        ("pageIndex", 0.0.into_ipc()),
        ("rect", IpcValue::Array(vec![])),
    ]);
    assert_eq!(t.invoke("pdf:page-image-png", vec![image]), IpcValue::Null);
    assert_eq!(
        t.invoke("pdf:can-draw-text", vec![1.0.into_ipc()]),
        false.into_ipc()
    );
    assert_eq!(
        t.invoke("pdf:can-draw-text", vec![s("가")]),
        true.into_ipc()
    );
    // a bad OCR payload is a failed page, a platform without an engine is null
    assert_eq!(
        t.invoke("pdf:ocr-page", vec![s("")]),
        IpcValue::Array(vec![])
    );
    assert_eq!(t.invoke("pdf:ocr-page", vec![s("iVBOR")]), IpcValue::Null);
}

#[test]
fn compare_reads_text_of_the_open_and_a_picked_document() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    let open = t.invoke("pdf:compare-read-open", vec![s(&f)]);
    assert_eq!(field(&open, "name"), &s("doc.pdf"));
    assert_eq!(
        field(&open, "pages"),
        &IpcValue::Array(vec![s("%PDF-1.7 original %%EOF")])
    );
    t.rt.script().open.push_back(None);
    assert_eq!(
        t.invoke("pdf:compare-read-pdf", vec![]),
        obj([("ok", false.into_ipc()), ("canceled", true.into_ipc())])
    );
    let stranger = t.rt.view(2, Surface::Pdf);
    let refused =
        t.rt.invoke_now("pdf:compare-read-pdf", stranger, vec![])
            .unwrap();
    assert_eq!(
        field(&refused, "reason"),
        &s("pdf: sender is not a registered PDF view")
    );
}

#[test]
fn decrypt_reports_why_it_refused() {
    let mut t =
        setup(json!({ "engine": { "decryptDocument": [{}, { "error": "wrong-password" }] } }));
    assert_eq!(
        field(&t.invoke("pdf:decrypt", vec![s("x"), s("p")]), "reason"),
        &s("pdf: malformed decrypt request")
    );
    let bytes = IpcValue::Bytes(BytesKind::Uint8Array, b"%PDF".to_vec());
    let opened = t.invoke("pdf:decrypt", vec![bytes.clone(), s("p")]);
    assert_eq!(field(&opened, "neededPassword"), &true.into_ipc());
    assert_eq!(
        field(&t.invoke("pdf:decrypt", vec![bytes, s("p")]), "reason"),
        &s("wrong-password")
    );
}

// ---- hand-offs to the shell ----

#[test]
fn create_document_validates_then_asks_the_shell() {
    let mut t = setup(json!({ "shell": { "createDocument": [{ "ok": true, "path": "/x.md" }] } }));
    let req = |title: &str| {
        obj([
            ("type", s("md")),
            ("title", s(title)),
            ("content", s("body")),
        ])
    };
    assert_eq!(
        err(&t.invoke("pdf:create-document", vec![req("  ")])),
        "pdf: invalid create-document request"
    );
    let long = "t".repeat(201);
    assert_eq!(
        err(&t.invoke("pdf:create-document", vec![req(&long)])),
        "pdf: invalid create-document request"
    );
    assert_eq!(
        t.invoke("pdf:create-document", vec![req(" Notes ")]),
        obj([("ok", true.into_ipc()), ("path", s("/x.md"))])
    );
    assert!(t.calls()[0].contains("String(\"Notes\")"));
    let (mut rt, _) = rt_with(Value::Null);
    let v = rt.view(3, Surface::Pdf);
    assert_eq!(
        err(&rt
            .invoke_now("pdf:create-document", v, vec![req("a")])
            .unwrap()),
        "pdf: sender is not a registered PDF view"
    );
    pdf(&rt).open_view(v.view, None);
    assert_eq!(
        err(&rt
            .invoke_now("pdf:create-document", v, vec![req("a")])
            .unwrap()),
        "pdf: document creation is unavailable in this host"
    );
}

#[test]
fn pdf_tools_open_only_for_a_listed_task() {
    let mut t = setup(json!({ "shell": { "openPdfTools": true } }));
    let f = t.file.clone();
    assert_eq!(
        t.invoke("pdf:open-in-pdf-tools", vec![s(&f), s("format-disk")]),
        false.into_ipc()
    );
    assert_eq!(
        t.invoke("pdf:open-in-pdf-tools", vec![s(&f), s("compress")]),
        true.into_ipc()
    );
    assert_eq!(t.calls(), vec![format!("openPdfTools {f} compress")]);
}

#[test]
fn notes_wait_for_a_saved_document_and_the_shell_hooks() {
    let mut t = setup(Value::Null);
    let refused = t.invoke("pdf:note-open", vec![obj([])]);
    assert_eq!(field(&refused, "reason"), &s("unavailable"));
    let bad = t.invoke("pdf:note-insert", vec![s("x")]);
    assert_eq!(
        bad,
        obj([
            ("ok", false.into_ipc()),
            ("reason", s("failed")),
            ("message", s("invalid request"))
        ])
    );
}

#[test]
fn external_links_go_to_the_browser_only_when_safe() {
    let t = setup(Value::Null);
    pdf(&t.rt).window_open("https://example.com/a");
    pdf(&t.rt).window_open("javascript:alert(1)");
    let opened: Vec<_> =
        t.rt.script()
            .calls
            .iter()
            .filter_map(|c| match c {
                HostCall::OpenExternal(u) => Some(u.clone()),
                _ => None,
            })
            .collect();
    assert_eq!(opened, vec!["https://example.com/a".to_owned()]);
}

// ---- watching the file ----

#[test]
fn another_programs_change_reaches_the_view_after_the_file_settles() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    t.invoke("pdf:read-file", vec![s(&f)]);
    assert_eq!(
        t.invoke("pdf:watch-disk-file", vec![s(&f)]),
        true.into_ipc()
    );
    std::fs::write(&f, b"%PDF-1.7 rewritten elsewhere %%EOF").unwrap();
    let fire = |t: &T| {
        let w = t.shell.watchers.lock().unwrap();
        (w[0].2)(Some("doc.pdf".into()));
    };
    fire(&t);
    t.rt.drain();
    for _ in 0..4 {
        t.rt.advance(Duration::from_millis(400));
    }
    let kind = obj([("path", s(&f)), ("kind", s("changed"))]);
    assert_eq!(t.events(), vec![("pdf:disk-file-changed", vec![kind])]);
    // the view's own write is not another program's change
    assert!(ok(
        &t.invoke("pdf:insert-blank-page", vec![obj([("path", s(&f))])])
    ));
    fire(&t);
    t.rt.drain();
    for _ in 0..4 {
        t.rt.advance(Duration::from_millis(400));
    }
    assert_eq!(t.events(), vec![]);
    // a reload stops the watch
    pdf(&t.rt).start_loading(t.view.view);
    assert!(t.shell.watchers.lock().unwrap().is_empty());
    // untitled copies are never watched
    pdf(&t.rt).mark_untitled_copy(&f);
    assert_eq!(
        t.invoke("pdf:watch-disk-file", vec![s(&f)]),
        false.into_ipc()
    );
}

// ---- recovery ----

fn copy_dir(t: &T) -> PathBuf {
    t.rt.dir.join("userData").join("pdf-autosave")
}

#[test]
fn a_copy_is_written_once_the_view_resolved_its_file_and_offered_on_reopen() {
    let mut t = setup(json!({ "engine": { "pdfBytesWithEditsOf": "%PDF edited %%EOF" } }));
    let f = t.file.clone();
    let req = empty_save(&f);
    assert_eq!(
        t.invoke("pdf:recovery-write-copy", vec![req.clone()]),
        s("skipped")
    );
    assert_eq!(t.invoke("pdf:consume-pending", vec![]), s(&f));
    assert_eq!(
        t.invoke("pdf:recovery-write-copy", vec![req.clone()]),
        s("written")
    );
    assert!(copy_dir(&t).exists());
    // a request carrying a password never gets a copy
    let protected = obj([("path", s(&f)), ("decryption", obj([]))]);
    assert_eq!(
        t.invoke("pdf:recovery-write-copy", vec![protected]),
        s("skipped")
    );

    // the tab crashes and its replacement opens the same file: the question is asked
    t.send("pdf:dirty-changed", vec![true.into_ipc()]);
    pdf(&t.rt).render_gone(t.view.view);
    t.rt.destroy(t.view.view);
    let again = t.rt.view(2, Surface::Pdf);
    pdf(&t.rt).open_view(again.view, Some(&f));
    t.rt.script().message.push_back(0);
    assert_eq!(
        t.rt.invoke_now("pdf:consume-pending", again, vec![])
            .unwrap(),
        s(&f)
    );
    let read =
        t.rt.invoke_now("pdf:read-file", again, vec![s(&f)])
            .unwrap();
    assert_eq!(
        read,
        IpcValue::Bytes(BytesKind::ArrayBuffer, b"%PDF edited %%EOF".to_vec())
    );
    let state =
        t.rt.invoke_now("pdf:recovery-state", again, vec![s(&f)])
            .unwrap();
    assert_eq!(state, obj([("unsaved", true.into_ipc())]));
    // saving in place writes the restored bytes and ends the restore
    assert!(ok(&t
        .rt
        .invoke_now("pdf:save", again, vec![empty_save(&f)])
        .unwrap()));
    assert_eq!(std::fs::read(&f).unwrap(), b"%PDF edited %%EOF");
    let state =
        t.rt.invoke_now("pdf:recovery-state", again, vec![s(&f)])
            .unwrap();
    assert_eq!(state, obj([("unsaved", false.into_ipc())]));
}

#[test]
fn an_encrypted_source_gets_no_copy_and_one_notice() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    std::fs::write(&f, b"%PDF trailer << /Encrypt 3 0 R >> %%EOF").unwrap();
    t.invoke("pdf:consume-pending", vec![]);
    assert_eq!(
        t.invoke("pdf:recovery-write-copy", vec![empty_save(&f)]),
        s("skipped")
    );
    let notice = t.invoke("pdf:recovery-unprotectable", vec![false.into_ipc()]);
    assert!(matches!(notice, IpcValue::String(_)));
    assert_eq!(
        t.invoke("pdf:recovery-unprotectable", vec![true.into_ipc()]),
        IpcValue::Null
    );
    assert!(pdf(&t.rt).is_unprotectable(t.view.view));
}

#[test]
fn dont_save_supersedes_copies_until_the_close_is_cancelled() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    t.invoke("pdf:consume-pending", vec![]);
    pdf(&t.rt).discard_recovery(t.view.view);
    assert_eq!(
        t.invoke("pdf:recovery-write-copy", vec![empty_save(&f)]),
        s("superseded")
    );
    assert_eq!(t.invoke("pdf:recovery-resume", vec![]), IpcValue::Undefined);
    assert_eq!(
        t.invoke("pdf:recovery-write-copy", vec![empty_save(&f)]),
        s("written")
    );
}

#[test]
fn copies_now_waits_for_each_dirty_view_or_its_timeout() {
    let mut t = setup(Value::Null);
    let ed = pdf(&t.rt);
    let (none, then) = slot();
    ed.write_copies_now(Box::new(move || then(())));
    assert_eq!(*none.borrow(), Some(()));
    t.send("pdf:dirty-changed", vec![true.into_ipc()]);
    let (answered, then) = slot();
    ed.write_copies_now(Box::new(move || then(())));
    assert_eq!(t.events(), vec![("pdf:recovery-flush-request", vec![])]);
    assert_eq!(*answered.borrow(), None);
    t.send("pdf:recovery-flush-done", vec![]);
    assert_eq!(*answered.borrow(), Some(()));
    let (timed, then) = slot();
    ed.write_copies_now(Box::new(move || then(())));
    t.rt.advance(Duration::from_secs(8));
    assert_eq!(*timed.borrow(), Some(()));
}

#[test]
fn a_launch_decision_reopens_a_view_that_already_read_its_file() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    t.invoke("pdf:consume-pending", vec![]);
    t.send("pdf:dirty-changed", vec![true.into_ipc()]);
    pdf(&t.rt).open_file_with_decision(t.view.view, &f, false);
    assert_eq!(t.calls(), vec!["reload 1".to_owned()]);
    assert!(!pdf(&t.rt).is_dirty(t.view.view));
    pdf(&t.rt).sweep_work_files();
}

// ---- signatures ----

#[test]
fn saved_signatures_persist_and_ignore_bad_input() {
    let mut t = setup(Value::Null);
    assert_eq!(
        t.invoke("pdf:list-signatures", vec![]),
        IpcValue::Array(vec![])
    );
    assert_eq!(
        t.invoke("pdf:add-signature", vec![s("nope")]),
        IpcValue::Array(vec![])
    );
    let data = crate::kit::from_json(
        &json!({ "kind": "image", "image": "data:x", "width": 10, "height": 5 }),
    );
    let added = t.invoke("pdf:add-signature", vec![data]);
    let IpcValue::Array(list) = &added else {
        panic!("{added:?}")
    };
    assert_eq!(list.len(), 1);
    assert!(t.rt.dir.join("userData/pdf-signatures.json").exists());
    assert_eq!(t.invoke("pdf:list-signatures", vec![]), added);
    let id = field(&list[0], "id").clone();
    assert_eq!(
        t.invoke("pdf:remove-signature", vec![id]),
        IpcValue::Array(vec![])
    );
}

#[test]
fn signing_needs_a_clean_view_and_writes_a_new_file() {
    let mut t = setup(Value::Null);
    let f = t.file.clone();
    let p12 = t.path("me.p12");
    std::fs::write(&p12, b"p12").unwrap();
    t.rt.script()
        .open
        .push_back(Some(vec![PathBuf::from(&p12)]));
    let picked = t.invoke("pdf:pick-certificate", vec![]);
    assert_eq!(field(&picked, "fileName"), &s("me.p12"));
    let cert_id = field(&picked, "certId").clone();
    assert_eq!(
        field(
            &t.invoke("pdf:inspect-certificate", vec![s("other"), s("pw")]),
            "error"
        ),
        &s("cert-invalid")
    );
    let inspected = t.invoke("pdf:inspect-certificate", vec![cert_id.clone(), s("pw")]);
    assert!(ok(&inspected));
    let req = |extra: Vec<(&str, IpcValue)>| {
        let mut r = vec![
            ("path".to_owned(), s(&f)),
            ("certId".to_owned(), cert_id.clone()),
            ("password".to_owned(), s("pw")),
        ];
        r.extend(extra.into_iter().map(|(k, v)| (k.to_owned(), v)));
        IpcValue::Object(r)
    };
    let bad = t.invoke(
        "pdf:sign-with-certificate",
        vec![req(vec![("certifyLevel", 4.0.into_ipc())])],
    );
    assert_eq!(field(&bad, "message"), &s("pdf: invalid sign request"));
    t.send("pdf:dirty-changed", vec![true.into_ipc()]);
    let dirty = t.invoke("pdf:sign-with-certificate", vec![req(vec![])]);
    assert_eq!(
        field(&dirty, "message"),
        &s("pdf: save pending edits before signing")
    );
    t.send("pdf:dirty-changed", vec![false.into_ipc()]);
    t.events();
    let target = t.path("doc-signed.pdf");
    t.rt.script().save.push_back(Some(PathBuf::from(&target)));
    let signed = t.invoke(
        "pdf:sign-with-certificate",
        vec![req(vec![("reason", s("  ok  "))])],
    );
    assert_eq!(signed, obj([("ok", true.into_ipc()), ("path", s(&target))]));
    assert_eq!(
        std::fs::read(&target).unwrap(),
        [ORIGINAL, b"%signed"].concat()
    );
    assert_eq!(std::fs::read(&f).unwrap(), ORIGINAL);
    assert_eq!(pdf(&t.rt).0.open_path(t.view.view), Some(target.clone()));
    assert_eq!(
        t.events(),
        vec![
            ("pdf:save-as-flow", vec![true.into_ipc()]),
            ("pdf:save-as-flow", vec![false.into_ipc()])
        ]
    );
    // picking the source itself is a cancel
    t.rt.script().save.push_back(Some(PathBuf::from(&target)));
    let same = t.invoke(
        "pdf:sign-with-certificate",
        vec![obj([
            ("path", s(&target)),
            ("certId", cert_id),
            ("password", s("pw")),
        ])],
    );
    assert_eq!(
        same,
        obj([("ok", false.into_ipc()), ("cancelled", true.into_ipc())])
    );
}

#[test]
fn sign_options_are_clamped_and_checked() {
    let parse = |v: Value| super::sign::parse_sign_options(&crate::kit::from_json(&v));
    let long = "r".repeat(600);
    let o = parse(json!({ "reason": long, "location": "  ", "certifyLevel": 2 })).unwrap();
    assert_eq!(o.reason.unwrap().len(), 500);
    assert_eq!(o.location, None);
    assert_eq!(o.certify_level, Some(2));
    let visible = |w: f64| json!({ "visible": { "pageIndex": 0, "position": "center", "width": w, "height": 30, "png": "aGk=" } });
    assert_eq!(parse(visible(60.0)).unwrap().visible.unwrap().png, b"hi");
    assert!(parse(visible(30.0)).is_none());
    assert!(parse(json!({ "visible": null })).is_none());
}

#[test]
fn a_restored_untitled_copy_reopens_the_view_as_unsaved() {
    let mut t = setup(json!({ "engine": { "pdfBytesWithEditsOf": "%PDF kept %%EOF" } }));
    let f = t.file.clone();
    let ed = pdf(&t.rt);
    // a template copy writes its copy under an untitled identity
    ed.mark_untitled_copy(&f);
    t.invoke("pdf:consume-pending", vec![]);
    assert_eq!(ed.recovery_identity(t.view.view), None);
    assert_eq!(
        t.invoke("pdf:recovery-write-copy", vec![empty_save(&f)]),
        s("written")
    );
    let copy = ed
        .recovery_identity(t.view.view)
        .expect("an untitled identity");

    let other = t.rt.view(2, Surface::Pdf);
    ed.open_view(other.view, None);
    ed.open_untitled_copy(other.view, &copy, "Template", None);
    let work = ed.0.open_path(other.view).expect("a working file");
    assert!(
        work.starts_with(
            &*t.rt
                .dir
                .join("temp")
                .join("seuoffice-pdf-recovery")
                .to_string_lossy()
        )
    );
    assert_eq!(std::fs::read(&work).unwrap(), b"%PDF kept %%EOF");
    assert_eq!(ed.recovery_identity(other.view), Some(copy));
    // unsaved without anything pending in its renderer
    assert!(ed.is_dirty(other.view));
    let state =
        t.rt.invoke_now("pdf:recovery-state", other, vec![s(&work)])
            .unwrap();
    assert_eq!(state, obj([("unsaved", true.into_ipc())]));
    // the renderer had not asked for its file yet: no reload
    assert!(!t.calls().iter().any(|c| c.starts_with("reload")));

    t.send("pdf:dirty-changed", vec![true.into_ipc()]);
    ed.clear_dirty(t.view.view);
    ed.set_save_as_in_flight(t.view.view, true);
    assert_eq!(
        t.events(),
        vec![("pdf:save-as-flow", vec![true.into_ipc()])]
    );
    // the working file goes with its view
    t.rt.destroy(other.view);
    assert!(!Path::new(&work).exists());
}
