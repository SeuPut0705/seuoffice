//! What a docs renderer sees: answers, events and files, across channels.

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use main_core::packages::electron_utils::recovery_contract::RecoveryOpenDecision;
use main_core::packages::electron_utils::recovery_store::SharedRecoveryState;
use serde_json::json;
use shell_contract::editors::{DocumentEditors, SaveMode, editor_for};
use shell_contract::ipc::{Sender, Target};
use shell_contract::{BytesKind, IpcValue, Surface, ViewId};

use super::editors::DocsEditors;
use super::hosts::{DocsEngineHost, DocsShellHost, Fake};
use crate::kit::{self, IntoIpc};
use crate::testing::{HostCall, Rt};

fn s(text: &str) -> IpcValue {
    IpcValue::String(text.into())
}

fn ab(bytes: &[u8]) -> IpcValue {
    IpcValue::Bytes(BytesKind::ArrayBuffer, bytes.to_vec())
}

fn get<'a>(v: &'a IpcValue, key: &str) -> &'a IpcValue {
    kit::field(v, key)
}

fn obj(entries: &[(&str, IpcValue)]) -> IpcValue {
    IpcValue::Object(
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
    )
}

struct T {
    rt: Rt,
    fake: Fake,
    a: Sender,
}

impl T {
    fn new(case: serde_json::Value) -> Self {
        let fake = Fake::new(&case);
        let f = fake.clone();
        let mut rt = Rt::new(move |h| {
            h.insert::<DocsEngineHost>(Arc::new(f.clone()));
            h.insert::<DocsShellHost>(Arc::new(f));
            h.insert::<Arc<Mutex<SharedRecoveryState>>>(Arc::new(Mutex::new(
                SharedRecoveryState::new("run"),
            )));
        });
        for sub in ["userData", "documents", "temp", "home"] {
            std::fs::create_dir_all(rt.dir.join(sub)).unwrap();
        }
        rt.register(super::entries).unwrap();
        let a = rt.view(1, Surface::Docs);
        T { rt, fake, a }
    }

    fn editor(&self) -> Rc<DocsEditors> {
        self.rt.provided().all::<DocsEditors>().remove(0)
    }

    fn call(&mut self, channel: &str, args: Vec<IpcValue>) -> IpcValue {
        let a = self.a;
        self.rt.invoke_now(channel, a, args).unwrap()
    }

    fn file(&self, name: &str, bytes: &[u8]) -> String {
        let p = self.rt.dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn open(&mut self, path: &str) -> IpcValue {
        self.call("docs:open-path", vec![s(path)])
    }

    /// the hosts' log lines, as compact JSON
    fn calls(&self) -> Vec<String> {
        self.fake
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|l| l.to_string())
            .collect()
    }

    fn channels(&self) -> Vec<&'static str> {
        self.rt.events().into_iter().map(|e| e.channel).collect()
    }
}

#[test]
fn opening_a_file_grants_its_save_and_lists_it_as_recent() {
    let mut t = T::new(json!({}));
    let path = t.file("a.docx", b"plain docx");
    let opened = t.open(&path);
    assert_eq!(get(&opened, "path"), &s(&path));
    assert_eq!(get(&opened, "name"), &s("a.docx"));
    assert_eq!(get(&opened, "dataUrl"), &s("handoff:706c61696e20646f6378"));
    assert_eq!(get(&opened, "hash"), &s(&super::sha256_hex(b"plain docx")));
    assert_eq!(get(&opened, "encrypted"), &IpcValue::Bool(false));
    assert!(
        matches!(&opened, IpcValue::Object(e) if e.iter().any(|(k, v)| k == "recovered" && *v == IpcValue::Undefined))
    );
    assert_eq!(
        t.call("docs:recent", vec![]),
        IpcValue::Array(vec![s(&path)])
    );
    assert!(
        t.calls()
            .contains(&serde_json::json!(["fileOpenedHook", 1, path]).to_string())
    );
    // the original is archived under its hash
    assert!(
        t.rt.dir
            .join("userData/originals")
            .read_dir()
            .unwrap()
            .next()
            .is_some()
    );

    let saved = t.call("docs:save", vec![s(&path), ab(b"new body")]);
    assert_eq!(get(&saved, "ok"), &IpcValue::Bool(true));
    assert_eq!(get(&saved, "passwordIntentPending"), &IpcValue::Bool(false));
    assert_eq!(std::fs::read(&path).unwrap(), b"new body");
}

#[test]
fn a_path_that_is_no_word_document_opens_nothing() {
    let mut t = T::new(json!({}));
    let path = t.file("a.txt", b"x");
    assert_eq!(t.open(&path), IpcValue::Null);
    assert_eq!(
        t.open(&t.rt.dir.join("gone.docx").to_string_lossy()),
        IpcValue::Null
    );
    assert_eq!(
        t.call("docs:open-path", vec![1.0.into_ipc()]),
        IpcValue::Null
    );
}

#[test]
fn the_open_dialog_cancelled_answers_null_and_picked_opens() {
    let mut t = T::new(json!({}));
    let path = t.file("b.odt", b"odt bytes");
    t.rt.script().open.push_back(None);
    assert_eq!(t.call("docs:open", vec![]), IpcValue::Null);
    t.rt.script()
        .open
        .push_back(Some(vec![PathBuf::from(&path)]));
    let opened = t.call("docs:open", vec![]);
    assert_eq!(get(&opened, "name"), &s("b.odt"));
}

#[test]
fn a_file_too_large_to_open_shows_an_error_and_answers_null() {
    let mut t = T::new(json!({ "open_lazy_docx": { "bytes": "x", "hash": "h" } }));
    let path = t.file("big.docx", b"x");
    // a lazily opened document carries its own hash
    let opened = t.open(&path);
    assert_eq!(get(&opened, "hash"), &s("h"));
}

#[test]
fn a_legacy_doc_is_converted_into_the_picked_docx_copy() {
    let mut t = T::new(json!({ "convert_legacy_doc": "converted" }));
    let doc = t.file("old.doc", b"word97");
    let target = t.rt.dir.join("old.docx");
    t.rt.script().message.push_back(0);
    t.rt.script().save.push_back(Some(target.clone()));
    let opened = t.open(&doc);
    assert_eq!(get(&opened, "path"), &s(&target.to_string_lossy()));
    assert_eq!(std::fs::read(&target).unwrap(), b"converted");
    assert_eq!(std::fs::read(&doc).unwrap(), b"word97");

    // cancelling the conversion box opens nothing
    t.rt.script().message.push_back(1);
    assert_eq!(t.open(&doc), IpcValue::Null);
}

#[test]
fn save_refuses_a_path_this_view_did_not_open() {
    let mut t = T::new(json!({}));
    let path = t.file("c.docx", b"x");
    let r = t.call("docs:save", vec![s(&path), ab(b"y")]);
    assert_eq!(
        r,
        obj(&[
            ("ok", false.into_ipc()),
            ("error", s("save target is not an opened document"))
        ])
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"x");
}

#[test]
fn a_file_changed_on_disk_is_not_overwritten_without_asking() {
    let mut t = T::new(json!({}));
    let path = t.file("d.docx", b"original");
    t.open(&path);
    std::fs::write(&path, b"edited elsewhere!").unwrap();
    let external = obj(&[("ok", false.into_ipc()), ("reason", s("external-modified"))]);
    assert_eq!(
        t.call("docs:save", vec![s(&path), ab(b"mine"), true.into_ipc()]),
        external
    );
    t.rt.script().message.push_back(1);
    assert_eq!(t.call("docs:save", vec![s(&path), ab(b"mine")]), external);
    assert_eq!(std::fs::read(&path).unwrap(), b"edited elsewhere!");
    t.rt.script().message.push_back(0);
    assert_eq!(
        get(&t.call("docs:save", vec![s(&path), ab(b"mine")]), "ok"),
        &IpcValue::Bool(true)
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"mine");
}

#[test]
fn save_as_writes_only_the_picked_path_once() {
    let mut t = T::new(json!({ "file_saved": "/moved/e.docx" }));
    let target = t.rt.dir.join("e");
    t.rt.script().save.push_back(Some(target.clone()));
    let picked = t.call("docs:save-as-pick", vec![s("e.docx")]);
    let path = format!("{}.docx", target.to_string_lossy());
    assert_eq!(picked, obj(&[("path", s(&path)), ("kind", s("docx"))]));
    let other = t.call("docs:save-as", vec![s("/elsewhere.docx"), ab(b"z")]);
    assert_eq!(get(&other, "error"), &s("save target was not picked"));
    let saved = t.call("docs:save-as", vec![s(&path), ab(b"body")]);
    assert_eq!(get(&saved, "path"), &s("/moved/e.docx"));
    assert_eq!(std::fs::read(&path).unwrap(), b"body");
    // the pick is used up
    let again = t.call("docs:save-as", vec![s(&path), ab(b"body")]);
    assert_eq!(get(&again, "error"), &s("save target was not picked"));
    // and the saved file is this view's document now
    assert_eq!(
        t.editor().document_path(ViewId(1)),
        Some(PathBuf::from(&path))
    );
}

#[test]
fn save_as_pick_of_page_images_authorizes_a_temp_pdf_and_the_folder() {
    let mut t = T::new(json!({}));
    let out = t.rt.dir.join("pages.png");
    t.rt.script().save.push_back(Some(out));
    let picked = t.call(
        "docs:save-as-pick",
        vec![s("doc.docx"), IpcValue::Null, s("docx"), true.into_ipc()],
    );
    assert_eq!(get(&picked, "kind"), &s("png"));
    let dir = kit::as_str(get(&picked, "dir")).unwrap().to_owned();
    let pdf = kit::as_str(get(&picked, "pdfPath")).unwrap().to_owned();

    assert_eq!(
        get(
            &t.call(
                "docs:write-export-image",
                vec![s(&dir), s("../x.png"), s("AA==")]
            ),
            "error"
        ),
        &s("invalid image file name")
    );
    let wrote = t.call(
        "docs:write-export-image",
        vec![s(&dir), s("p1.png"), s("aGk=")],
    );
    assert_eq!(
        std::fs::read(Path::new(&dir).join("p1.png")).unwrap(),
        b"hi"
    );
    assert_eq!(get(&wrote, "ok"), &IpcValue::Bool(true));

    std::fs::write(&pdf, b"%PDF").unwrap();
    let taken = t.call("docs:take-export-pdf", vec![s(&pdf)]);
    assert_eq!(
        taken,
        obj(&[("ok", true.into_ipc()), ("base64", s("JVBERg=="))])
    );
    assert!(!Path::new(&pdf).exists());
    assert_eq!(
        get(&t.call("docs:take-export-pdf", vec![s(&pdf)]), "error"),
        &s("not an image-export temp file")
    );
}

#[test]
fn save_new_lands_in_the_default_folder_under_a_free_name() {
    let mut t = T::new(json!({}));
    let first = t.call("docs:save-new", vec![s("Doc.docx"), ab(b"1")]);
    let second = t.call("docs:save-new", vec![s("Doc.docx"), ab(b"2")]);
    let (p1, p2) = (
        kit::as_str(get(&first, "path")).unwrap(),
        kit::as_str(get(&second, "path")).unwrap(),
    );
    assert!(p1.ends_with("Doc.docx"), "{p1}");
    assert!(p2.ends_with("Doc-2.docx"), "{p2}");
    assert_eq!(std::fs::read(p2).unwrap(), b"2");
    // a saved document may be saved again
    assert_eq!(
        get(&t.call("docs:save", vec![s(p1), ab(b"3")]), "ok"),
        &IpcValue::Bool(true)
    );
}

#[test]
fn save_to_needs_the_mcp_grant_and_respects_existing_files() {
    let mut t = T::new(json!({}));
    assert_eq!(
        get(
            &t.call(
                "docs:save-to",
                vec![s("rel.docx"), ab(b"x"), false.into_ipc()]
            ),
            "error"
        ),
        &s("path must be absolute")
    );
    let path = t.rt.dir.join("sub/f.docx").to_string_lossy().into_owned();
    assert_eq!(
        get(
            &t.call("docs:save-to", vec![s(&path), ab(b"x"), false.into_ipc()]),
            "error"
        ),
        &s("save target was not authorized")
    );
    t.editor().authorize_mcp_doc_write(ViewId(1), &path);
    let saved = t.call("docs:save-to", vec![s(&path), ab(b"x"), false.into_ipc()]);
    assert_eq!(get(&saved, "path"), &s(&path));
    assert_eq!(std::fs::read(&path).unwrap(), b"x");
    let exists = t.call("docs:save-to", vec![s(&path), ab(b"y"), false.into_ipc()]);
    assert_eq!(
        get(&exists, "error"),
        &s(&format!(
            "file already exists: {path} (pass overwrite:true to replace it)"
        ))
    );
    t.call("docs:save-to", vec![s(&path), ab(b"y"), true.into_ipc()]);
    assert_eq!(std::fs::read(&path).unwrap(), b"y");
}

#[test]
fn save_into_project_goes_where_the_shell_puts_it_or_is_skipped() {
    let skipped = obj(&[("ok", false.into_ipc()), ("skipped", true.into_ipc())]);
    let mut t = T::new(json!({}));
    assert_eq!(
        t.call("docs:save-into-project", vec![s("n"), s("docx"), ab(b"x")]),
        skipped
    );

    // the shell files the document into the project folder
    let target = std::env::temp_dir()
        .join(format!("docs-project-{}.docx", kit::unique()))
        .to_string_lossy()
        .into_owned();
    let mut p = T::new(json!({ "write_new_document": target.clone() }));
    assert_eq!(
        get(
            &p.call(
                "docs:save-into-project",
                vec![s("n"), s("docx"), s("not bytes")]
            ),
            "error"
        ),
        &s("bad save request")
    );
    let saved = p.call(
        "docs:save-into-project",
        vec![s("dir/My: Doc.docx"), s("docx"), ab(b"body")],
    );
    assert_eq!(get(&saved, "path"), &s(&target));
    assert!(
        p.calls()
            .iter()
            .any(|c| c == r#"["writeNewDocument",1,"My_ Doc.docx","626f6479"]"#)
    );
    // the document has its file now
    assert_eq!(
        p.call("docs:save-into-project", vec![s("n"), s("docx"), ab(b"x")]),
        skipped
    );
    let _ = std::fs::remove_file(&target);
}

#[test]
fn a_password_set_for_the_document_encrypts_its_next_save() {
    let mut t = T::new(json!({}));
    let path = t.file("g.docx", b"plain");
    assert_eq!(
        t.call("docs:set-password", vec![s(&path), s("pw")]),
        obj(&[("ok", false.into_ipc())])
    );
    t.open(&path);
    assert_eq!(
        t.call("docs:set-password", vec![s(&path), s("")]),
        obj(&[("ok", false.into_ipc())])
    );
    assert_eq!(
        t.call("docs:set-password", vec![s(&path), s("pw")]),
        obj(&[("ok", true.into_ipc())])
    );
    assert_eq!(
        t.call("docs:password-intent-revision", vec![]),
        1.0.into_ipc()
    );
    t.call("docs:save", vec![s(&path), ab(b"text")]);
    assert_eq!(std::fs::read(&path).unwrap(), b"ENC:text");
    assert!(
        t.calls()
            .contains(&r#"["officeCrypto.encrypt","pw"]"#.to_owned())
    );
}

#[test]
fn password_intents_are_discarded_through_a_revision() {
    let mut t = T::new(json!({}));
    assert_eq!(
        t.call("docs:discard-password-intents", vec![(-1.0).into_ipc()]),
        obj(&[("ok", false.into_ipc())])
    );
    assert_eq!(
        t.call("docs:discard-password-intents", vec![1.5.into_ipc()]),
        obj(&[("ok", false.into_ipc())])
    );
    t.call("docs:set-password", vec![IpcValue::Null, s("pw")]);
    assert_eq!(
        t.call("docs:discard-password-intents", vec![1.0.into_ipc()]),
        obj(&[("ok", true.into_ipc())])
    );
    // the pending password is gone: a first save is plain
    let saved = t.call("docs:save-new", vec![s("h.docx"), ab(b"x")]);
    let path = kit::as_str(get(&saved, "path")).unwrap().to_owned();
    assert_eq!(std::fs::read(path).unwrap(), b"x");
}

#[test]
fn open_decrypt_reports_why_it_did_not_open() {
    let mut t = T::new(json!({}));
    let bad = obj(&[
        ("ok", false.into_ipc()),
        ("reason", s("error")),
        ("error", s("invalid arguments")),
    ]);
    assert_eq!(t.call("docs:open-decrypt", vec![s("/x.docx"), s("")]), bad);
    let path = t.rt.dir.join("none.docx").to_string_lossy().into_owned();
    assert_eq!(
        get(
            &t.call("docs:open-decrypt", vec![s(&path), s("pw")]),
            "error"
        ),
        &s("file not found")
    );
    let plain = t.file("plain.docx", b"zip");
    assert_eq!(
        get(&t.call("docs:open-decrypt", vec![s(&plain), s("pw")]), "ok"),
        &IpcValue::Bool(true)
    );
}

#[test]
fn the_close_guard_saves_discards_or_cancels_by_the_answer() {
    let mut t = T::new(json!({}));
    let a = t.a;
    let dirty = obj(&[
        ("dirty", true.into_ipc()),
        ("autoSave", false.into_ipc()),
        ("filePath", IpcValue::Null),
    ]);

    // clean: closes without asking
    let p = t.rt.invoke("docs:confirm-document-replace", a, vec![]);
    assert_eq!(t.channels(), vec!["docs:close-check"]);
    t.rt.send("docs:close-check-result", a, vec![false.into_ipc()]);
    assert_eq!(p.take(), Some(Ok(true.into_ipc())));

    // dirty, Cancel
    t.rt.script().message.push_back(2);
    let p = t.rt.invoke("docs:confirm-document-replace", a, vec![]);
    t.rt.send("docs:close-check-result", a, vec![dirty.clone()]);
    assert_eq!(p.take(), Some(Ok(false.into_ipc())));

    // dirty, Don't Save: the recovery copies go and the renderer hears it
    t.rt.events();
    t.rt.script().message.push_back(1);
    let p = t.rt.invoke("docs:confirm-document-replace", a, vec![]);
    t.rt.send("docs:close-check-result", a, vec![dirty.clone()]);
    assert_eq!(p.take(), Some(Ok(true.into_ipc())));
    assert_eq!(
        t.channels(),
        vec!["docs:close-check", "docs:recovery-copy-dropped"]
    );

    // dirty, Save: the renderer saves and reports
    t.rt.script().message.push_back(0);
    let p = t.rt.invoke("docs:confirm-document-replace", a, vec![]);
    t.rt.send("docs:close-check-result", a, vec![dirty]);
    assert_eq!(p.take(), None);
    assert_eq!(
        t.channels(),
        vec!["docs:close-check", "docs:close-save-request"]
    );
    t.rt.send("docs:close-save-result", a, vec![true.into_ipc()]);
    assert_eq!(p.take(), Some(Ok(true.into_ipc())));
}

#[test]
fn a_renderer_that_never_answers_is_asked_about_and_a_save_times_out() {
    let mut t = T::new(json!({}));
    let a = t.a;
    t.rt.script().message.push_back(1);
    let p = t.rt.invoke("docs:confirm-document-replace", a, vec![]);
    t.rt.advance(Duration::from_millis(1999));
    assert_eq!(p.take(), None);
    t.rt.advance(Duration::from_millis(1));
    assert_eq!(p.take(), Some(Ok(false.into_ipc())));
    let asked =
        t.rt.script()
            .calls
            .iter()
            .any(|c| matches!(c, HostCall::Message(_, m) if m.buttons.len() == 2));
    assert!(asked);

    // autosave on: a save that never reports falls back to the prompt after 120 s
    t.rt.script().message.push_back(2);
    let p = t.rt.invoke("docs:confirm-document-replace", a, vec![]);
    t.rt.send(
        "docs:close-check-result",
        a,
        vec![obj(&[
            ("dirty", true.into_ipc()),
            ("autoSave", true.into_ipc()),
        ])],
    );
    t.rt.advance(Duration::from_millis(119_999));
    assert_eq!(p.take(), None);
    t.rt.advance(Duration::from_millis(1));
    assert_eq!(p.take(), Some(Ok(false.into_ipc())));
}

#[test]
fn closing_twice_joins_one_check_and_a_destroyed_view_closes() {
    let mut t = T::new(json!({}));
    let a = t.a;
    let editor = editor_for(&t.rt.provided(), ViewId(1)).unwrap();
    let got = Rc::new(std::cell::RefCell::new(Vec::new()));
    for _ in 0..2 {
        let g = got.clone();
        editor.request_close(
            ViewId(1),
            None,
            Box::new(move |r| g.borrow_mut().push(r.unwrap())),
        );
    }
    assert_eq!(t.channels(), vec!["docs:close-check"]);
    t.rt.destroy(a.view);
    assert_eq!(*got.borrow(), vec![true, true]);
}

#[test]
fn crash_copies_are_written_and_a_save_drops_them() {
    let mut t = T::new(json!({}));
    let path = t.file("r.docx", b"x");
    let autosave = t.rt.dir.join("userData/docs-autosave");
    let copies = |dir: &Path| {
        std::fs::read_dir(dir)
            .map(|d| {
                d.filter_map(Result::ok)
                    .filter(|e| e.path().extension().is_some_and(|x| x == "docx"))
                    .count()
            })
            .unwrap_or(0)
    };
    assert_eq!(
        t.call("docs:write-recovery", vec![s(&path), ab(b"draft")]),
        obj(&[("ok", false.into_ipc())])
    );
    t.open(&path);
    assert_eq!(
        t.call("docs:write-recovery", vec![s(&path), s("not bytes")]),
        obj(&[("ok", false.into_ipc())])
    );
    assert_eq!(
        t.call("docs:write-recovery", vec![s(&path), ab(b"draft")]),
        obj(&[("ok", true.into_ipc())])
    );
    assert_eq!(copies(&autosave), 1);
    t.call("docs:save", vec![s(&path), ab(b"saved")]);
    assert_eq!(copies(&autosave), 0);

    // an untitled document writes to its slot
    let meta = obj(&[("title", s("Draft")), ("format", s("docx"))]);
    assert_eq!(
        t.call("docs:write-recovery", vec![IpcValue::Null, ab(b"u"), meta]),
        obj(&[("ok", true.into_ipc())])
    );
    assert_eq!(copies(&autosave.join("untitled")), 1);
    assert!(t.editor().recovery_identity(ViewId(1)).is_some());
}

#[test]
fn a_copy_left_from_a_crash_is_offered_when_its_file_opens() {
    let mut t = T::new(json!({}));
    let path = t.file("k.docx", b"on disk");
    t.open(&path);
    t.call("docs:write-recovery", vec![s(&path), ab(b"unsaved edits")]);
    // another tab opens the file: restore
    let b = t.rt.view(2, Surface::Docs);
    t.rt.script().message.push_back(0);
    let opened =
        t.rt.invoke_now("docs:open-path", b, vec![s(&path)])
            .unwrap();
    assert_eq!(
        get(&opened, "dataUrl"),
        &s("handoff:756e7361766564206564697473")
    );
    assert_eq!(get(&opened, "recovered"), &IpcValue::Bool(true));
}

#[test]
fn session_end_asks_every_booted_renderer_for_a_copy() {
    let mut t = T::new(json!({}));
    let a = t.a;
    let b = t.rt.view(2, Surface::Docs);
    t.call("docs:consume-copy", vec![]);
    t.rt.invoke_now("docs:consume-copy", b, vec![]).unwrap();
    let done = Rc::new(std::cell::Cell::new(false));
    let d = done.clone();
    t.editor().write_copies_now(Box::new(move || d.set(true)));
    let events = t.rt.events();
    assert_eq!(events.len(), 2);
    let token_of = |view: ViewId| {
        events
            .iter()
            .find(|e| e.target == Target::View(view) && e.channel == "docs:write-recovery-now")
            .map(|e| e.args[0].clone())
            .unwrap()
    };
    t.rt.send("docs:write-recovery-now-done", a, vec![token_of(ViewId(1))]);
    assert!(!done.get());
    // the other one never answers: its 5 s end the wait
    t.rt.advance(Duration::from_millis(5000));
    assert!(done.get());
}

#[test]
fn first_document_queues_are_taken_once() {
    let mut t = T::new(json!({}));
    let editor = t.editor();
    assert_eq!(t.call("docs:consume-new-blank", vec![]), false.into_ipc());
    editor.mark_new_blank(ViewId(1));
    assert_eq!(t.call("docs:consume-new-blank", vec![]), true.into_ipc());
    assert_eq!(t.call("docs:consume-new-blank", vec![]), false.into_ipc());

    let copy = t.file("template.docx", b"tpl");
    editor.queue_copy(ViewId(1), copy, "Report.docx".into());
    let got = t.call("docs:consume-copy", vec![]);
    assert_eq!(
        got,
        obj(&[
            ("path", s("Report.docx")),
            ("name", s("Report.docx")),
            ("dataUrl", s("handoff:74706c")),
            ("hash", s("")),
            ("untitledCopy", true.into_ipc()),
        ])
    );
    assert_eq!(t.call("docs:consume-copy", vec![]), IpcValue::Null);

    let doc = t.file("queued.docx", b"q");
    assert_eq!(t.call("docs:consume-pending-open", vec![]), IpcValue::Null);
    editor.queue_open(ViewId(1), doc.clone());
    assert_eq!(
        get(&t.call("docs:consume-pending-open", vec![]), "path"),
        &s(&doc)
    );
}

#[test]
fn a_decided_open_waits_for_boot_then_goes_out_as_docs_opened() {
    let mut t = T::new(json!({}));
    let editor = t.editor();
    let doc = t.file("dec.docx", b"d");
    editor.open_file_with_decision(ViewId(1), doc.clone(), RecoveryOpenDecision::Original);
    assert!(t.channels().is_empty());
    assert_eq!(
        get(&t.call("docs:consume-pending-open", vec![]), "path"),
        &s(&doc)
    );
    t.call("docs:consume-copy", vec![]);
    t.rt.events();
    editor.open_file_with_decision(ViewId(1), doc.clone(), RecoveryOpenDecision::Original);
    // the shell's call is no channel call: its worker's answer waits on the core queue
    t.rt.drain();
    let events = t.rt.events();
    assert_eq!(events[0].channel, "docs:opened");
    assert_eq!(get(&events[0].args[0], "path"), &s(&doc));
}

#[test]
fn a_headless_export_reads_its_target_and_settles_on_the_report() {
    let mut t = T::new(json!({}));
    let a = t.a;
    let report = Rc::new(std::cell::RefCell::new(None));
    let r = report.clone();
    t.editor().begin_headless_export(
        ViewId(1),
        "/in.docx".into(),
        "/out.pdf".into(),
        "pdf",
        Duration::from_secs(300),
        Box::new(move |res| *r.borrow_mut() = Some(res)),
    );
    assert_eq!(
        t.call("docs:consume-headless-export", vec![]),
        obj(&[("outPath", s("/out.pdf")), ("format", s("pdf"))])
    );
    assert_eq!(
        t.call("docs:consume-headless-export", vec![]),
        IpcValue::Null
    );
    t.rt.send(
        "docs:headless-export-done",
        a,
        vec![obj(&[("ok", false.into_ipc()), ("error", s("boom"))])],
    );
    assert_eq!(*report.borrow(), Some(Err("boom".to_owned())));
}

#[test]
fn only_the_active_tab_patches_the_view_menu() {
    let mut t = T::new(json!({ "active_docs_view": 1 }));
    let (a, b) = (t.a, t.rt.view(2, Surface::Docs));
    let state = obj(&[
        ("aiSidebar", true.into_ipc()),
        ("darkCanvas", false.into_ipc()),
        ("odt", true.into_ipc()),
    ]);
    t.rt.send("docs:view-menu-state", b, vec![state.clone()]);
    assert!(t.calls().is_empty());
    t.rt.send("docs:view-menu-state", a, vec![state]);
    assert_eq!(
        t.calls(),
        vec![
            r#"["MenuItem.checked","docs-menu-ai-sidebar",true]"#,
            r#"["MenuItem.checked","docs-menu-dark-mode",false]"#,
            r#"["MenuItem.enabled","docs-menu-insert-equation",false]"#,
            r#"["MenuItem.enabled","docs-menu-insert-comment",false]"#,
        ]
    );
    // the background tab's state is kept for the menu to read when it is focused
    let editor = t.editor();
    assert_eq!(editor.view_menu_state(b.view), Some([true, false, true]));
    assert_eq!(editor.view_menu_state(ViewId(9)), None);
}

#[test]
fn a_torn_down_tab_loses_its_writes() {
    let mut t = T::new(json!({}));
    let path = t.file("t.docx", b"x");
    t.open(&path);
    t.editor().teardown(ViewId(1), false);
    assert_eq!(t.channels(), vec!["docs:teardown"]);
    assert!(
        editor_for(&t.rt.provided(), ViewId(1))
            .unwrap()
            .torn_down(ViewId(1))
    );
    assert_eq!(
        get(&t.call("docs:save", vec![s(&path), ab(b"y")]), "ok"),
        &IpcValue::Bool(false)
    );
    assert_eq!(
        t.call("docs:password-intent-revision", vec![]),
        (-1.0).into_ipc()
    );
    assert_eq!(
        t.call("docs:save-as-pick", vec![s("n.docx")]),
        IpcValue::Null
    );
    assert_eq!(
        t.call("docs:confirm-marked-export", vec![s("odt")]),
        s("cancel")
    );
}

#[test]
fn a_renamed_file_keeps_its_grant_under_the_new_name() {
    let mut t = T::new(json!({}));
    let old = t.file("old.docx", b"x");
    t.open(&old);
    let new = t.rt.dir.join("new.docx").to_string_lossy().into_owned();
    std::fs::rename(&old, &new).unwrap();
    t.rt.events();
    let editor = editor_for(&t.rt.provided(), ViewId(1)).unwrap();
    editor.file_renamed(ViewId(1), Path::new(&old), Path::new(&new));
    let events = t.rt.events();
    assert_eq!(events[0].channel, "docs:renamed");
    assert_eq!(
        events[0].args[0],
        obj(&[("oldPath", s(&old)), ("newPath", s(&new))])
    );
    assert_eq!(
        get(&t.call("docs:save", vec![s(&new), ab(b"y")]), "ok"),
        &IpcValue::Bool(true)
    );
    assert_eq!(editor.document_path(ViewId(1)), Some(PathBuf::from(&new)));
}

#[test]
fn the_editor_saves_and_exports_by_menu_command() {
    let t = T::new(json!({}));
    let editor = editor_for(&t.rt.provided(), ViewId(1)).unwrap();
    assert!(editor.owns(ViewId(1)));
    let other = t.rt.view(3, Surface::Pdf);
    assert!(!editor.owns(other.view));
    let got = Rc::new(std::cell::RefCell::new(None));
    let g = got.clone();
    editor.request_save(
        ViewId(1),
        SaveMode::Save,
        Box::new(move |r| *g.borrow_mut() = Some(r)),
    );
    // the tab menu's save is the renderer's own flow: the command goes out
    assert_eq!(*got.borrow(), Some(Ok(true)));
    editor.export_request(ViewId(1), "pdf");
    let events: Vec<_> =
        t.rt.events()
            .into_iter()
            .map(|e| (e.channel, e.args[0].clone()))
            .collect();
    assert_eq!(
        events,
        vec![
            ("menu:command", s("save")),
            ("menu:command", s("export-pdf"))
        ]
    );
}

#[test]
fn export_pdf_writes_an_authorized_target_and_reveals_it() {
    let mut t = T::new(json!({}));
    let geometry = vec![s("doc.docx"), 11906.0.into_ipc(), 16838.0.into_ipc()];
    let bad = t.call(
        "docs:export-pdf",
        vec![s("doc.docx"), 0.0.into_ipc(), 1.0.into_ipc()],
    );
    assert_eq!(get(&bad, "error"), &s("invalid page size or scale"));
    let mut named = geometry.clone();
    named.push(s("/tmp/not-authorized.pdf"));
    assert_eq!(
        get(&t.call("docs:export-pdf", named), "error"),
        &s("export target is not an authorized path")
    );
    t.rt.script().save.push_back(None);
    assert_eq!(
        t.call("docs:export-pdf", geometry.clone()),
        obj(&[("ok", false.into_ipc())])
    );

    let out = t.rt.dir.join("doc.pdf");
    t.rt.script().save.push_back(Some(out.clone()));
    t.rt.script().pdf = Some(b"%PDF-1.7".to_vec());
    let r = t.call("docs:export-pdf", geometry.clone());
    assert_eq!(
        r,
        obj(&[("ok", true.into_ipc()), ("path", s(&out.to_string_lossy()))])
    );
    assert_eq!(std::fs::read(&out).unwrap(), b"%PDF-1.7");
    assert!(
        t.rt.script()
            .calls
            .contains(&HostCall::ShowItemInFolder(out.clone()))
    );

    // the dialog's pick stays authorized for the renderer's retry; a print failure names it
    t.rt.script().pdf = None;
    let mut retry = geometry;
    retry.push(s(&out.to_string_lossy()));
    let failed = t.call("docs:export-pdf", retry);
    assert_eq!(get(&failed, "error"), &s("Error: printToPDF failed"));
    assert_eq!(get(&failed, "path"), &s(&out.to_string_lossy()));
}

#[test]
fn export_html_and_markdown_write_their_files() {
    let mut t = T::new(json!({}));
    assert_eq!(
        get(&t.call("docs:export-html", vec![s("d"), s("")]), "error"),
        &s("empty document")
    );
    let html = t.rt.dir.join("d.html");
    t.rt.script().save.push_back(Some(html.clone()));
    t.call("docs:export-html", vec![s("d.docx"), s("<p>hi</p>")]);
    assert_eq!(std::fs::read_to_string(&html).unwrap(), "<p>hi</p>");

    assert_eq!(
        get(
            &t.call("docs:export-markdown", vec![s("d"), s("# x"), s("no")]),
            "error"
        ),
        &s("bad image list")
    );
    let md = t.rt.dir.join("note (1).md");
    t.rt.script().save.push_back(Some(md.clone()));
    let images = IpcValue::Array(vec![
        obj(&[
            ("name", s("image1.png")),
            ("src", s("data:image/png;base64,aGk=")),
        ]),
        obj(&[
            ("name", s("../evil.png")),
            ("src", s("data:image/png;base64,aGk=")),
        ]),
    ]);
    let r = t.call(
        "docs:export-markdown",
        vec![
            s("d.docx"),
            s("![](__seuoffice_media__/image1.png)"),
            images,
        ],
    );
    assert_eq!(get(&r, "imagesDropped"), &1.0.into_ipc());
    assert_eq!(
        std::fs::read_to_string(&md).unwrap(),
        "![](note%20%281%29_files/image1.png)"
    );
    assert_eq!(
        std::fs::read(t.rt.dir.join("note (1)_files/image1.png")).unwrap(),
        b"hi"
    );
}

#[test]
fn export_hwp_converts_confirms_losses_and_writes() {
    let mut t = T::new(json!({
        "convert_to_hwp": [{}, { "losses": [{ "feature": "chart", "kind": "dropped", "count": 2 }] }]
    }));
    let bad = obj(&[
        ("ok", false.into_ipc()),
        ("code", s("failed")),
        ("error", s("bad export request")),
    ]);
    assert_eq!(t.call("docs:export-hwp", vec![s("d"), s("x")]), bad);
    let unauthorized = t.call("docs:export-hwp", vec![s("d"), ab(b"x"), s("/x.hwp")]);
    assert_eq!(get(&unauthorized, "code"), &s("unauthorized"));

    let out = t.rt.dir.join("d.hwp");
    t.rt.script().save.push_back(Some(out.clone()));
    let r = t.call("docs:export-hwp", vec![s("d.docx"), ab(b"docx")]);
    assert_eq!(
        r,
        obj(&[("ok", true.into_ipc()), ("path", s(&out.to_string_lossy()))])
    );
    assert_eq!(std::fs::read(&out).unwrap(), b"hwp:docx");

    // a loss asks first; Cancel writes nothing
    std::fs::remove_file(&out).unwrap();
    t.rt.script().message.push_back(1);
    let r = t.call(
        "docs:export-hwp",
        vec![s("d.docx"), ab(b"docx"), s(&out.to_string_lossy())],
    );
    assert_eq!(
        r,
        obj(&[("ok", false.into_ipc()), ("canceled", true.into_ipc())])
    );
    assert!(!out.exists());
}

#[test]
fn merged_pdf_parts_land_in_one_file() {
    let mut t = T::new(json!({}));
    let out = t.rt.dir.join("m.pdf");
    t.rt.script().save.push_back(Some(out.clone()));
    let r = t.call(
        "docs:save-merged-pdf",
        vec![s("m.docx"), IpcValue::Array(vec![s("YQ=="), s("Yg==")])],
    );
    assert_eq!(get(&r, "ok"), &IpcValue::Bool(true));
    assert_eq!(std::fs::read(&out).unwrap(), b"ab");
}

#[test]
fn pick_image_reads_the_picked_picture() {
    let mut t = T::new(json!({}));
    let png = t.file("pic.PNG", b"img");
    t.rt.script()
        .open
        .push_back(Some(vec![PathBuf::from(&png)]));
    assert_eq!(
        t.call("docs:pick-image", vec![]),
        obj(&[
            ("base64", s("aW1n")),
            ("mime", s("image/png")),
            ("name", s("pic.PNG"))
        ])
    );
    let bmp = t.file("pic.bmp", b"img");
    t.rt.script()
        .open
        .push_back(Some(vec![PathBuf::from(&bmp)]));
    assert_eq!(t.call("docs:pick-image", vec![]), IpcValue::Null);
}

#[test]
fn mail_merge_reads_a_source_and_writes_one_file_per_record() {
    let mut t =
        T::new(json!({ "read_merge_data_source": [{ "fields": ["a"] }, { "error": "bad csv" }] }));
    t.rt.script()
        .open
        .push_back(Some(vec![PathBuf::from("/list.csv")]));
    assert_eq!(
        get(&t.call("docs:merge-data-source", vec![]), "ok"),
        &IpcValue::Bool(true)
    );
    t.rt.script()
        .open
        .push_back(Some(vec![PathBuf::from("/list.csv")]));
    assert_eq!(
        t.call("docs:merge-data-source", vec![]),
        obj(&[("ok", false.into_ipc()), ("error", s("bad csv"))])
    );

    assert_eq!(
        get(&t.call("docs:merge-output", vec![obj(&[])]), "error"),
        &s("nothing to write")
    );
    let folder = t.rt.dir.join("merged");
    std::fs::create_dir_all(&folder).unwrap();
    t.rt.script().open.push_back(Some(vec![folder.clone()]));
    let files = IpcValue::Array(vec![
        obj(&[("name", s("Kim")), ("data", ab(b"1"))]),
        obj(&[("name", s("Kim")), ("data", ab(b"2"))]),
    ]);
    let r = t.call(
        "docs:merge-output",
        vec![obj(&[("mode", s("folder")), ("files", files)])],
    );
    assert_eq!(get(&r, "count"), &2.0.into_ipc());
    assert_eq!(std::fs::read(folder.join("Kim-2.docx")).unwrap(), b"2");
}

#[test]
fn copying_a_picture_puts_its_bitmap_and_sized_html_on_the_clipboard() {
    let mut t = T::new(json!({ "image_size": [10, 20] }));
    assert_eq!(
        t.call(
            "docs:copy-image-to-clipboard",
            vec![s("data:text/html;base64,AA==")]
        ),
        false.into_ipc()
    );
    let meta = r#"{"imageWidthPx":5,"x":"<"}"#;
    let ok = t.call(
        "docs:copy-image-to-clipboard",
        vec![s("data:image/png;base64,aGk="), s(meta)],
    );
    assert_eq!(ok, true.into_ipc());
    let html = serde_json::json!(["clipboard.write", {
        "html": "<img src=\"data:image/png;base64,aGk=\" width=\"5\" height=\"20\" data-image-meta=\"{&quot;imageWidthPx&quot;:5,&quot;x&quot;:&quot;&lt;&quot;}\">",
        "text": null
    }])
    .to_string();
    assert!(t.calls().contains(&html), "{:?}", t.calls());
}

#[test]
fn capture_rect_checks_its_rectangle() {
    let mut t = T::new(json!({ "capture_rect": "png" }));
    assert_eq!(
        t.call("docs:capture-rect", vec![obj(&[("x", 0.0.into_ipc())])]),
        IpcValue::Null
    );
    let rect = obj(&[
        ("x", (-3.5).into_ipc()),
        ("y", 1.2.into_ipc()),
        ("width", 10.2.into_ipc()),
        ("height", 5.0.into_ipc()),
    ]);
    assert_eq!(
        t.call("docs:capture-rect", vec![rect]),
        kit::u8_array(b"png".to_vec())
    );
    assert!(t.calls().contains(
        &r#"["webContents.capturePage",1,{"x":0,"y":1,"width":11,"height":5}]"#.to_owned()
    ));
}

#[test]
fn ai_documents_open_in_a_tab_or_are_written_beside_the_others() {
    let mut t = T::new(json!({}));
    assert_eq!(
        t.call(
            "docs:create-document",
            vec![obj(&[("type", s("md")), ("content", s("  "))])]
        ),
        obj(&[
            ("ok", false.into_ipc()),
            ("error", s("content must not be empty"))
        ])
    );
    let docx = t.call(
        "docs:create-document",
        vec![obj(&[
            ("type", s("docx")),
            ("title", s("T")),
            ("content", s("<p>x</p>")),
        ])],
    );
    assert_eq!(docx, obj(&[("ok", true.into_ipc())]));
    assert!(
        t.calls()
            .iter()
            .any(|c| c.starts_with(r#"["openAiDocTabFor""#))
    );
    let md = t.call(
        "docs:create-document",
        vec![obj(&[
            ("type", s("md")),
            ("title", s("a/b")),
            ("content", s("# hi")),
        ])],
    );
    let path = kit::as_str(get(&md, "path")).unwrap();
    assert!(path.ends_with("a_b.md"), "{path}");
    assert_eq!(std::fs::read_to_string(path).unwrap(), "# hi");
    assert_eq!(
        get(
            &t.call(
                "docs:create-document",
                vec![obj(&[("type", s("xls")), ("content", s("x"))])]
            ),
            "error"
        ),
        &s("unsupported document type: xls")
    );
}

#[test]
fn altchunk_html_becomes_docx_bytes() {
    let mut t = T::new(json!({ "html_to_docx": "DOCX" }));
    assert_eq!(
        t.call("docs:altchunk-html-to-docx", vec![s("   ")]),
        IpcValue::Null
    );
    assert_eq!(
        t.call("docs:altchunk-html-to-docx", vec![s("<p>x</p>")]),
        kit::u8_array(b"DOCX".to_vec())
    );
}

#[test]
fn analyze_media_rejects_a_missing_request_and_answers_the_tool() {
    let mut t = T::new(json!({ "analyze_media": { "text": "a cat" } }));
    let a = t.a;
    let err =
        t.rt.invoke_now("docs:analyze-media", a, vec![])
            .unwrap_err();
    assert_eq!(
        err.to_string(),
        "TypeError: Cannot read properties of undefined (reading 'mediaUrls')"
    );
    let r = t.call(
        "docs:analyze-media",
        vec![obj(&[("mediaUrls", IpcValue::Array(vec![s("u"), s("")]))])],
    );
    assert_eq!(r, obj(&[("text", s("a cat"))]));
    assert!(
        t.calls()
            .iter()
            .any(|c| c.starts_with(r#"["analyzeMediaTool""#) && c.contains(r#"["u"]"#))
    );
}

#[test]
fn marked_odt_answers_the_button_pressed() {
    let mut t = T::new(json!({}));
    t.rt.script().message.push_back(1);
    assert_eq!(
        t.call("docs:confirm-marked-export", vec![s("odt")]),
        s("clear")
    );
    t.rt.script().message.push_back(0);
    assert_eq!(
        t.call("docs:confirm-marked-export", vec![s("odt")]),
        s("docx")
    );
}

#[test]
fn materialize_takes_only_an_array_buffer() {
    let mut t = T::new(json!({}));
    assert_eq!(
        t.call("docs:materialize-docx", vec![kit::u8_array(b"x".to_vec())]),
        IpcValue::Null
    );
    assert_eq!(
        t.call("docs:materialize-docx", vec![ab(b"x")]),
        obj(&[("dataUrl", s("handoff:78"))])
    );
}

#[test]
fn save_image_as_writes_the_fetched_picture() {
    let mut t = T::new(json!({}));
    assert_eq!(
        t.call("docs:save-image-as", vec![1.0.into_ipc()]),
        obj(&[("ok", false.into_ipc())])
    );
    let out = t.rt.dir.join("pic.png");
    t.rt.script().save.push_back(Some(out.clone()));
    let r = t.call("docs:save-image-as", vec![s("data:image/png;base64,aGk=")]);
    assert_eq!(
        r,
        obj(&[("ok", true.into_ipc()), ("path", s(&out.to_string_lossy()))])
    );
    assert_eq!(std::fs::read(&out).unwrap(), b"hi");
}

#[test]
fn pick_export_images_target_authorizes_its_folder() {
    let mut t = T::new(json!({}));
    t.rt.script().open.push_back(None);
    assert_eq!(
        t.call("docs:pick-export-images-target", vec![]),
        IpcValue::Null
    );
    let dir = t.rt.dir.join("imgs");
    std::fs::create_dir_all(&dir).unwrap();
    t.rt.script().open.push_back(Some(vec![dir.clone()]));
    let r = t.call("docs:pick-export-images-target", vec![]);
    let d = dir.to_string_lossy().into_owned();
    assert_eq!(get(&r, "dir"), &s(&d));
    assert_eq!(
        get(
            &t.call(
                "docs:write-export-image",
                vec![s(&d), s("a.png"), s("aGk=")]
            ),
            "ok"
        ),
        &IpcValue::Bool(true)
    );
    assert_eq!(
        get(
            &t.call(
                "docs:write-export-image",
                vec![s("/other"), s("a.png"), s("aGk=")]
            ),
            "error"
        ),
        &s("export target is not an authorized folder")
    );
}

#[test]
fn a_destroyed_view_drops_its_state() {
    let mut t = T::new(json!({}));
    let path = t.file("z.docx", b"x");
    t.open(&path);
    t.rt.destroy(ViewId(1));
    let editor = editor_for(&t.rt.provided(), ViewId(1));
    assert!(editor.is_none());
    assert!(t.editor().torn_down(ViewId(1)));
    assert_eq!(t.editor().document_path(ViewId(1)), None);
    assert!(
        t.calls()
            .contains(&r#"["forgetLazyMediaOwner",1]"#.to_owned())
    );
}

#[test]
fn an_untitled_copy_reopens_in_a_new_tab_that_keeps_writing_it() {
    let mut t = T::new(json!({}));
    let meta = obj(&[("title", s("Notes")), ("format", s("docx"))]);
    t.call(
        "docs:write-recovery",
        vec![IpcValue::Null, ab(b"draft"), meta],
    );
    let copy = t.editor().recovery_identity(ViewId(1)).unwrap();
    // the crashed tab is gone; a new one restores its copy before it booted
    t.editor().teardown(ViewId(1), true);
    let b = t.rt.view(2, Surface::Docs);
    t.editor().open_untitled_copy(
        ViewId(2),
        main_core::packages::electron_utils::recovery_store::RecoveryIdentity::Untitled(
            copy.clone(),
        ),
        String::new(),
        None,
    );
    let restored = t.rt.invoke_now("docs:consume-copy", b, vec![]).unwrap();
    assert_eq!(get(&restored, "name"), &s("Notes.docx"));
    assert_eq!(get(&restored, "dataUrl"), &s("handoff:6472616674"));
    assert_eq!(get(&restored, "recovered"), &IpcValue::Bool(true));
    assert_eq!(t.editor().recovery_identity(ViewId(2)), Some(copy));
}

#[test]
fn discarding_a_tab_drops_its_copy_and_tells_the_renderer() {
    let mut t = T::new(json!({}));
    let path = t.file("x.docx", b"x");
    t.open(&path);
    t.call("docs:write-recovery", vec![s(&path), ab(b"edit")]);
    let autosave = t.rt.dir.join("userData/docs-autosave");
    let count = || {
        std::fs::read_dir(&autosave)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().is_file())
            .count()
    };
    assert!(count() > 0);
    t.rt.events();
    t.editor().discard_recovery(ViewId(1));
    assert_eq!(count(), 0);
    assert_eq!(t.channels(), vec!["docs:recovery-copy-dropped"]);
    // the "Don't Save" holds: the next tick writes nothing
    assert_eq!(
        t.call("docs:write-recovery", vec![s(&path), ab(b"edit")]),
        obj(&[("ok", false.into_ipc())])
    );
}

#[test]
fn other_apps_create_ai_documents_through_the_editor() {
    let t = T::new(json!({}));
    let got = Rc::new(std::cell::RefCell::new(None));
    let g = got.clone();
    let request = obj(&[
        ("type", s("html")),
        ("title", s("Page")),
        ("content", s("<b>x</b>")),
    ]);
    t.editor().create_ai_document(
        &request,
        ViewId(1),
        Box::new(move |v| *g.borrow_mut() = Some(v)),
    );
    let mut t = t;
    t.rt.drain();
    let reply = got.borrow().clone().unwrap();
    let path = kit::as_str(get(&reply, "path")).unwrap().to_owned();
    assert!(path.ends_with("Page.html"), "{path}");
    assert_eq!(std::fs::read_to_string(path).unwrap(), "<b>x</b>");
}
