//! Tests of the mind map handlers: what a renderer observes.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use shell_contract::editors::{DocumentEditors, SaveMode};
use shell_contract::ipc::{Sender, Target};
use shell_contract::{IpcError, IpcValue, Surface, ViewId};

use super::hosts::ProbeLog;
use super::{MindmapApp, Seed, handle};
use crate::testkit::{Kit, TestRegistry, call, registered, temp_dir};
use crate::value::{buffer, field, obj, string};

struct H {
    kit: Kit,
    reg: TestRegistry,
    log: ProbeLog,
    sender: Sender,
    dir: PathBuf,
    app: MindmapApp,
}

fn harness(name: &str, case: impl FnOnce(&Path) -> Value) -> H {
    let dir = temp_dir(name);
    let case = case(&dir);
    let log: ProbeLog = Arc::default();
    let kit = Kit::new(&dir, |hosts| {
        // the other apps of the batch need their fakes to register
        crate::insert_fakes(hosts);
        hosts.insert::<ProbeLog>(log.clone());
        super::insert_fakes(hosts, &case);
    });
    let reg = registered(&kit);
    let sender = kit.view(1, Surface::Mindmap);
    let app = handle().expect("routes ran");
    H {
        kit,
        reg,
        log,
        sender,
        dir,
        app,
    }
}

fn plain(name: &str) -> H {
    harness(name, |_| Value::Null)
}

impl H {
    fn call(&self, channel: &str, args: Vec<IpcValue>) -> Result<IpcValue, IpcError> {
        call(&self.reg, self.sender, channel, args)
    }

    fn call_as(&self, sender: Sender, channel: &str, args: Vec<IpcValue>) -> IpcValue {
        call(&self.reg, sender, channel, args).expect("answered")
    }

    fn ok(&self, channel: &str, args: Vec<IpcValue>) -> IpcValue {
        self.call(channel, args).expect("answered")
    }

    fn pick_save(&self, path: Option<&Path>) {
        self.kit
            .dialogs
            .saves
            .lock()
            .unwrap()
            .push_back(path.map(Path::to_path_buf));
    }

    fn answer_message(&self, response: usize) {
        self.kit
            .dialogs
            .messages
            .lock()
            .unwrap()
            .push_back(response);
    }

    fn events(&self, channel: &str) -> Vec<Vec<IpcValue>> {
        self.kit
            .take_events()
            .into_iter()
            .filter(|(_, name, _)| *name == channel)
            .map(|(_, _, args)| args)
            .collect()
    }

    fn probe_log(&self) -> Vec<Value> {
        self.log.lock().unwrap().clone()
    }

    fn logged(&self, name: &str) -> Vec<Value> {
        self.probe_log()
            .into_iter()
            .filter(|line| line[0] == name)
            .collect()
    }

    fn userdata(&self) -> PathBuf {
        self.dir.join("userdata")
    }

    /// recovery copies on disk, without their metadata
    fn copies(&self) -> Vec<PathBuf> {
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if !path.to_string_lossy().ends_with(".meta.json") {
                    out.push(path);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.userdata().join("mindmap-autosave"), &mut out);
        out
    }

    /// the mind map's own editor: another app's editor may own the same view id in this registry
    fn editor(&self, view: u32) -> Rc<dyn DocumentEditors> {
        let editor: Rc<dyn DocumentEditors> =
            Rc::new(super::editors::MindmapEditors(self.app.clone()));
        assert!(editor.owns(ViewId(view)), "a mind map view");
        editor
    }
}

fn bytes(text: &str) -> IpcValue {
    buffer(text.as_bytes().to_vec())
}

fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn save_request(text: &str, mode: &str) -> IpcValue {
    obj([("bytes", bytes(text)), ("mode", string(mode))])
}

fn is_ok(value: &IpcValue) -> bool {
    field(value, "ok") == &IpcValue::Bool(true)
}

fn error_of(value: &IpcValue) -> String {
    match field(value, "error") {
        IpcValue::String(text) => text.clone(),
        other => panic!("no error in {value:?} ({other:?})"),
    }
}

type Slot<T> = Rc<RefCell<Option<Result<T, IpcError>>>>;
type Then<T> = Box<dyn FnOnce(Result<T, IpcError>)>;

fn slot<T: 'static>() -> (Slot<T>, Then<T>) {
    let slot: Slot<T> = Rc::default();
    let keep = slot.clone();
    (
        slot,
        Box::new(move |result| *keep.borrow_mut() = Some(result)),
    )
}

fn open_granted_file(h: &H, name: &str, content: &str) -> PathBuf {
    let file = h.dir.join(name);
    fs::write(&file, content).unwrap();
    h.app.create_view(h.sender.view, Some(&path_str(&file)));
    let opened = h.ok("mindmap:open-file", vec![string(path_str(&file))]);
    assert_eq!(field(&opened, "status"), &string("ok"));
    file
}

#[test]
fn a_granted_file_opens_and_saves_and_a_bad_one_is_never_written() {
    let h = plain("open-save");
    let file = h.dir.join("a.xmind");
    fs::write(&file, "XMIND-1").unwrap();
    h.app.create_view(ViewId(1), Some(&path_str(&file)));
    assert_eq!(
        h.ok("mindmap:consume-pending", vec![]),
        string(path_str(&file))
    );
    // a path that was not granted to the view is refused
    let refused = h
        .call(
            "mindmap:open-file",
            vec![string(path_str(&h.dir.join("other.xmind")))],
        )
        .unwrap_err();
    assert_eq!(refused.message, "mindmap: path not granted to this view");

    let opened = h.ok("mindmap:open-file", vec![string(path_str(&file))]);
    assert_eq!(
        opened,
        obj([("status", string("ok")), ("bytes", bytes("XMIND-1"))])
    );
    assert_eq!(h.app.file_path(ViewId(1)), Some(path_str(&file)));

    let saved = h.ok("mindmap:save", vec![save_request("XMIND-2", "save")]);
    assert_eq!(
        saved,
        obj([
            ("ok", IpcValue::Bool(true)),
            ("path", string(path_str(&file)))
        ])
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "XMIND-2");

    // bytes that would not open as a map never replace the file
    let refused = h.ok("mindmap:save", vec![save_request("junk", "save")]);
    assert_eq!(
        error_of(&refused),
        "mindmap: refusing to write a file that would not open (rejected)"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "XMIND-2");

    // a file that did not open is a view nothing is written for
    let broken = h.dir.join("b.xmind");
    fs::write(&broken, "junk").unwrap();
    let second = h.kit.view(2, Surface::Mindmap);
    h.app.create_view(ViewId(2), Some(&path_str(&broken)));
    let status = h.call_as(second, "mindmap:open-file", vec![string(path_str(&broken))]);
    assert_eq!(status, obj([("status", string("rejected"))]));
    let refused = h.call_as(
        second,
        "mindmap:save",
        vec![save_request("XMIND-3", "save")],
    );
    assert_eq!(
        error_of(&refused),
        "mindmap: the file did not open, nothing is written"
    );
    assert_eq!(fs::read_to_string(&broken).unwrap(), "junk");
    h.call_as(second, "mindmap:dirty-changed", vec![IpcValue::Bool(true)]);
    assert!(!h.app.is_dirty(ViewId(2)));
}

#[test]
fn an_untitled_map_asks_where_and_later_saves_go_to_that_file() {
    let h = plain("first-save");
    h.app.create_view(ViewId(1), None);
    assert_eq!(h.ok("mindmap:consume-pending", vec![]), IpcValue::Null);
    // a cancelled dialog writes nothing
    h.pick_save(None);
    let canceled = h.ok("mindmap:save", vec![save_request("XMIND-1", "save")]);
    assert_eq!(
        canceled,
        obj([
            ("ok", IpcValue::Bool(true)),
            ("canceled", IpcValue::Bool(true))
        ])
    );

    let target = h.dir.join("first");
    h.pick_save(Some(&target));
    let request = obj([
        ("bytes", bytes("XMIND-1")),
        ("mode", string("save")),
        ("defaultName", string("Plan/A")),
    ]);
    let saved = h.ok("mindmap:save", vec![request]);
    let written = h.dir.join("first.xmind");
    assert_eq!(
        saved,
        obj([
            ("ok", IpcValue::Bool(true)),
            ("path", string(path_str(&written)))
        ])
    );
    assert_eq!(fs::read_to_string(&written).unwrap(), "XMIND-1");
    assert_eq!(
        h.logged("mindmap-main.fileSavedHook"),
        vec![json!(["mindmap-main.fileSavedHook", 1, path_str(&written)])]
    );
    // the dialog suggested the sanitized name in the default folder
    let dialog_log = h.kit.take_log().join("\n");
    assert!(dialog_log.contains("Plan_A.xmind"), "{dialog_log}");

    // the next save has a target: no dialog
    let again = h.ok("mindmap:save", vec![save_request("XMIND-2", "save")]);
    assert!(is_ok(&again));
    assert!(
        !h.kit
            .take_log()
            .iter()
            .any(|line| line.starts_with("save "))
    );
    assert_eq!(fs::read_to_string(&written).unwrap(), "XMIND-2");
}

#[test]
fn save_as_an_export_type_grants_that_one_path_to_the_export() {
    let h = plain("export");
    h.app.create_view(ViewId(1), None);
    let target = h.dir.join("pic.png");
    h.pick_save(Some(&target));
    let picked = h.ok("mindmap:save", vec![save_request("XMIND-1", "saveAs")]);
    assert_eq!(
        picked,
        obj([
            ("ok", IpcValue::Bool(true)),
            (
                "export",
                obj([
                    ("format", string("png")),
                    ("path", string(path_str(&target)))
                ])
            ),
        ])
    );
    // Save As lists the export types after .xmind, and nothing was written yet
    let dialog_log = h.kit.take_log().join("\n");
    assert!(dialog_log.contains("PNG Image") && dialog_log.contains("Mind Maps"));
    assert!(!target.exists());

    let mut png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    png.extend_from_slice(b"data");
    let export = |path: IpcValue| {
        obj([
            ("bytes", buffer(png.clone())),
            ("suggestedName", string("m")),
            ("path", path),
        ])
    };
    // another path is not the one Save As picked
    let other = h.ok(
        "mindmap:export-png",
        vec![export(string(path_str(&h.dir.join("x.png"))))],
    );
    assert_eq!(
        error_of(&other),
        "mindmap: this export path was not picked in Save As"
    );
    let done = h.ok(
        "mindmap:export-png",
        vec![export(string(path_str(&target)))],
    );
    assert_eq!(
        done,
        obj([
            ("ok", IpcValue::Bool(true)),
            ("path", string(path_str(&target)))
        ])
    );
    assert_eq!(fs::read(&target).unwrap(), png);
    // taken once
    let twice = h.ok(
        "mindmap:export-png",
        vec![export(string(path_str(&target)))],
    );
    assert_eq!(
        error_of(&twice),
        "mindmap: this export path was not picked in Save As"
    );
}

#[test]
fn an_export_without_a_granted_path_asks_with_its_own_dialog() {
    let h = plain("export-dialog");
    let file = open_granted_file(&h, "m.xmind", "XMIND-1");
    let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><g/></svg>";
    let request = |svg: &str| obj([("svg", string(svg)), ("suggestedName", string("sheet"))]);

    // the dialog starts beside the map's file and takes the kind's extension
    h.pick_save(Some(&h.dir.join("out")));
    let done = h.ok("mindmap:export-svg", vec![request(svg)]);
    let out = h.dir.join("out.svg");
    assert_eq!(
        done,
        obj([
            ("ok", IpcValue::Bool(true)),
            ("path", string(path_str(&out)))
        ])
    );
    assert_eq!(
        fs::read_to_string(&out).unwrap(),
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n{svg}")
    );
    let dialog_log = h.kit.take_log().join("\n");
    assert!(
        dialog_log.contains(&path_str(&file.parent().unwrap().join("sheet.svg"))),
        "{dialog_log}"
    );

    // cancelled, and a page that is not a map's SVG
    assert_eq!(
        h.ok("mindmap:export-svg", vec![request(svg)]),
        obj([
            ("ok", IpcValue::Bool(true)),
            ("canceled", IpcValue::Bool(true))
        ])
    );
    let bad = h.ok(
        "mindmap:export-svg",
        vec![request("<svg><script>x</script></svg>")],
    );
    assert_eq!(error_of(&bad), "mindmap: bad SVG export request");

    // markdown and PDF write what the renderer sent (the PDF through the page renderer)
    h.pick_save(Some(&h.dir.join("outline.md")));
    let md = h.ok(
        "mindmap:export-markdown",
        vec![obj([
            ("text", string("# a")),
            ("suggestedName", string("o")),
        ])],
    );
    assert!(is_ok(&md));
    assert_eq!(fs::read_to_string(h.dir.join("outline.md")).unwrap(), "# a");
    h.pick_save(Some(&h.dir.join("doc")));
    let pdf = h.ok(
        "mindmap:export-pdf",
        vec![obj([
            ("html", string("<p>x</p>")),
            ("suggestedName", string("d")),
        ])],
    );
    assert_eq!(
        field(&pdf, "path"),
        &string(path_str(&h.dir.join("doc.pdf")))
    );
    assert_eq!(fs::read(h.dir.join("doc.pdf")).unwrap(), b"%PDF-1.7");
    assert_eq!(
        h.logged("export-main.pageToPdf"),
        vec![json!(["export-main.pageToPdf", "<p>x</p>"])]
    );
}

#[test]
fn a_menu_save_waits_for_the_renderer_and_its_ack_resumes_it() {
    let h = plain("save-round-trip");
    let file = open_granted_file(&h, "m.xmind", "XMIND-1");
    let editor = h.editor(1);

    // a clean map with a file has nothing to save: answered at once, nothing asked
    let (clean, then) = slot::<bool>();
    editor.request_save(ViewId(1), SaveMode::Save, then);
    assert_eq!(clean.borrow().clone(), Some(Ok(true)));
    assert!(h.events("mindmap:save-request").is_empty());

    // Save As asks the renderer; the ack of a save it declined resumes the wait
    let (waiting, then) = slot::<bool>();
    editor.request_save(ViewId(1), SaveMode::SaveAs, then);
    assert!(waiting.borrow().is_none());
    assert_eq!(
        h.events("mindmap:save-request"),
        vec![vec![string("saveAs")]]
    );
    h.ok("mindmap:save-request-ack", vec![IpcValue::Bool(false)]);
    assert_eq!(waiting.borrow().clone(), Some(Ok(false)));

    // a dirty map's save call is what answers: only a written map is true
    h.ok("mindmap:dirty-changed", vec![IpcValue::Bool(true)]);
    let (saving, then) = slot::<bool>();
    editor.request_save(ViewId(1), SaveMode::Save, then);
    assert_eq!(h.events("mindmap:save-request"), vec![vec![string("save")]]);
    h.ok("mindmap:save", vec![save_request("XMIND-2", "save")]);
    assert_eq!(saving.borrow().clone(), Some(Ok(true)));
    assert_eq!(fs::read_to_string(&file).unwrap(), "XMIND-2");
    assert!(!h.app.is_dirty(ViewId(1)));

    // a Save As that ends in the dialog's cancel is no save
    let (cancelled, then) = slot::<bool>();
    editor.request_save(ViewId(1), SaveMode::SaveAs, then);
    h.pick_save(None);
    h.ok("mindmap:save", vec![save_request("XMIND-3", "saveAs")]);
    assert_eq!(cancelled.borrow().clone(), Some(Ok(false)));

    // a renderer that never answers is given up on after 120 s
    let (silent, then) = slot::<bool>();
    editor.request_save(ViewId(1), SaveMode::SaveAs, then);
    h.app.run_due(Instant::now() + Duration::from_secs(60));
    assert!(silent.borrow().is_none());
    h.app.run_due(Instant::now() + Duration::from_secs(121));
    assert_eq!(silent.borrow().clone(), Some(Ok(false)));

    // the MCP server's save to a path points the target there, and gives it back when the save fails
    let (to_path, then) = slot::<()>();
    let target = h.dir.join("elsewhere.xmind");
    editor.save_to_path(ViewId(1), target.clone(), then);
    assert_eq!(h.app.file_path(ViewId(1)), Some(path_str(&target)));
    h.ok("mindmap:save-request-ack", vec![IpcValue::Bool(false)]);
    assert_eq!(
        to_path.borrow().clone().unwrap().unwrap_err().message,
        "could not save the map"
    );
    assert_eq!(h.app.file_path(ViewId(1)), Some(path_str(&file)));
}

#[test]
fn the_close_prompt_cancels_discards_or_saves_through_the_renderer() {
    let h = plain("close");
    let file = open_granted_file(&h, "m.xmind", "XMIND-1");
    let editor = h.editor(1);
    let parent = Some(h.sender.window);

    // clean: closes without a question
    let (clean, then) = slot::<bool>();
    editor.request_close(ViewId(1), parent, then);
    assert_eq!(clean.borrow().clone(), Some(Ok(true)));
    assert!(
        h.kit
            .take_log()
            .iter()
            .all(|line| !line.starts_with("message"))
    );

    h.ok("mindmap:dirty-changed", vec![IpcValue::Bool(true)]);
    // Cancel
    h.answer_message(2);
    let (cancel, then) = slot::<bool>();
    editor.request_close(ViewId(1), parent, then);
    assert_eq!(cancel.borrow().clone(), Some(Ok(false)));
    let prompt = h.kit.take_log().join("\n");
    assert!(
        prompt.contains("message Some(WindowId(1))") && prompt.contains("Don't Save"),
        "{prompt}"
    );

    // Don't Save: closes at once, the work is dropped
    h.answer_message(1);
    let (dropped, then) = slot::<bool>();
    editor.request_close(ViewId(1), parent, then);
    assert_eq!(dropped.borrow().clone(), Some(Ok(true)));

    // Save: the renderer is asked, and its result answers
    h.answer_message(0);
    let (saving, then) = slot::<bool>();
    editor.request_close(ViewId(1), parent, then);
    assert!(saving.borrow().is_none());
    assert_eq!(
        h.events("mindmap:close-save-request"),
        vec![Vec::<IpcValue>::new()]
    );
    h.ok("mindmap:close-save-result", vec![IpcValue::Bool(true)]);
    assert_eq!(saving.borrow().clone(), Some(Ok(true)));

    h.answer_message(0);
    let (failed, then) = slot::<bool>();
    editor.request_close(ViewId(1), parent, then);
    h.ok("mindmap:close-save-result", vec![IpcValue::Bool(false)]);
    assert_eq!(failed.borrow().clone(), Some(Ok(false)));
    drop(file);
}

#[test]
fn recovery_copies_are_kept_only_for_unsaved_maps_that_opened() {
    let h = plain("recovery-gate");
    h.app.create_view(ViewId(1), None);
    let copy = |name: &str| obj([("bytes", bytes("XMIND-copy")), ("name", string(name))]);
    // nothing unsaved: skipped
    assert_eq!(
        h.ok("mindmap:recovery-copy", vec![copy("My  map")]),
        string("skipped")
    );
    h.ok("mindmap:dirty-changed", vec![IpcValue::Bool(true)]);
    // no bytes: skipped
    assert_eq!(
        h.ok("mindmap:recovery-copy", vec![obj([("name", string("x"))])]),
        string("skipped")
    );
    assert_eq!(
        h.ok("mindmap:recovery-copy", vec![copy("My  map")]),
        string("written")
    );
    let copies = h.copies();
    assert_eq!(copies.len(), 1);
    assert!(copies[0].to_string_lossy().contains("untitled"));
    let meta = fs::read_to_string(format!("{}.meta.json", copies[0].display())).unwrap();
    assert!(meta.contains("My map"), "{meta}");

    // a view whose file did not open takes no copy, whatever it says
    let broken = h.dir.join("b.xmind");
    fs::write(&broken, "junk").unwrap();
    let second = h.kit.view(2, Surface::Mindmap);
    h.app.create_view(ViewId(2), Some(&path_str(&broken)));
    h.call_as(second, "mindmap:open-file", vec![string(path_str(&broken))]);
    h.call_as(second, "mindmap:dirty-changed", vec![IpcValue::Bool(true)]);
    assert_eq!(
        h.call_as(second, "mindmap:recovery-copy", vec![copy("x")]),
        string("skipped")
    );
    assert_eq!(h.copies().len(), 1);

    // the map reaching the disk takes its copy away
    h.pick_save(Some(&h.dir.join("saved")));
    assert!(is_ok(
        &h.ok("mindmap:save", vec![save_request("XMIND-1", "save")])
    ));
    assert!(h.copies().is_empty());

    // "Don't Save" drops the copy and holds new ones off until the hold ends
    h.ok("mindmap:dirty-changed", vec![IpcValue::Bool(true)]);
    assert_eq!(
        h.ok("mindmap:recovery-copy", vec![copy("x")]),
        string("written")
    );
    assert_eq!(h.copies().len(), 1);
    h.answer_message(1);
    let (closed, then) = slot::<bool>();
    h.editor(1).request_close(ViewId(1), None, then);
    assert_eq!(closed.borrow().clone(), Some(Ok(true)));
    assert!(h.copies().is_empty());
    assert_eq!(
        h.ok("mindmap:recovery-copy", vec![copy("x")]),
        string("superseded")
    );
    h.kit.take_events();
    h.app.run_due(Instant::now() + Duration::from_secs(6));
    assert_eq!(h.events("mindmap:recovery-reset").len(), 1);
    // the shared store still turns the copy away until the window's close is
    // cancelled (a later tab's Cancel), then the open tab copies again
    assert_eq!(
        h.ok("mindmap:recovery-copy", vec![copy("x")]),
        string("superseded")
    );
    main_core::packages::electron_utils::recovery_store::resume_discarded_copies(
        &h.app.recovery_state(),
    );
    assert_eq!(
        h.ok("mindmap:recovery-copy", vec![copy("x")]),
        string("written")
    );
}

#[test]
fn a_copy_left_for_a_file_is_asked_about_when_the_file_opens() {
    let h = plain("recovery-open");
    let file = open_granted_file(&h, "m.xmind", "XMIND-file");
    h.ok("mindmap:dirty-changed", vec![IpcValue::Bool(true)]);
    let copy = obj([("bytes", bytes("XMIND-copy"))]);
    assert_eq!(h.ok("mindmap:recovery-copy", vec![copy]), string("written"));
    // the view ends with unsaved changes: its copy stays
    h.kit.destroy(ViewId(1));
    assert_eq!(h.copies().len(), 1);
    h.kit.take_log();

    // the file reopens in another view: Restore (the default) loads the copy over the file
    let second = h.kit.view(2, Surface::Mindmap);
    h.app.create_view(ViewId(2), Some(&path_str(&file)));
    let restored = h.call_as(second, "mindmap:open-file", vec![string(path_str(&file))]);
    assert_eq!(
        restored,
        obj([
            ("status", string("ok")),
            ("bytes", bytes("XMIND-copy")),
            ("restored", string("file")),
        ])
    );
    assert!(
        h.kit
            .take_log()
            .iter()
            .any(|line| line.starts_with("message"))
    );
    assert_eq!(h.app.file_path(ViewId(2)), Some(path_str(&file)));
}

#[test]
fn a_discarded_copy_opens_the_file_as_saved() {
    let h = plain("recovery-discard");
    let file = open_granted_file(&h, "m.xmind", "XMIND-file");
    h.ok("mindmap:dirty-changed", vec![IpcValue::Bool(true)]);
    h.ok(
        "mindmap:recovery-copy",
        vec![obj([("bytes", bytes("XMIND-copy"))])],
    );
    h.kit.destroy(ViewId(1));
    let second = h.kit.view(2, Surface::Mindmap);
    h.app.create_view(ViewId(2), Some(&path_str(&file)));
    h.answer_message(1);
    let opened = h.call_as(second, "mindmap:open-file", vec![string(path_str(&file))]);
    assert_eq!(
        opened,
        obj([("status", string("ok")), ("bytes", bytes("XMIND-file"))])
    );
    assert!(h.copies().is_empty());
}

#[test]
fn a_view_that_is_gone_leaves_no_state_and_resumes_what_waited_on_it() {
    let h = plain("view-gone");
    // view 1: clean map with a copy, a pending save, a queued seed, a pending read
    h.app.create_view(ViewId(1), None);
    h.ok("mindmap:dirty-changed", vec![IpcValue::Bool(true)]);
    h.ok(
        "mindmap:recovery-copy",
        vec![obj([("bytes", bytes("XMIND-1"))])],
    );
    h.ok("mindmap:dirty-changed", vec![IpcValue::Bool(false)]);
    assert_eq!(h.copies().len(), 1);
    // view 2: unsaved when it ends
    let second = h.kit.view(2, Surface::Mindmap);
    h.app.create_view(ViewId(2), None);
    h.call_as(second, "mindmap:dirty-changed", vec![IpcValue::Bool(true)]);
    h.call_as(
        second,
        "mindmap:recovery-copy",
        vec![obj([("bytes", bytes("XMIND-2"))])],
    );
    assert_eq!(h.copies().len(), 2);

    let (saving, then) = slot::<bool>();
    h.editor(1).request_save(ViewId(1), SaveMode::SaveAs, then);
    h.app.queue_seed(ViewId(1), Seed::Outline("# a".into()));
    let (reading, then) = slot::<String>();
    h.editor(1).read_text(ViewId(1), then);
    assert!(saving.borrow().is_none() && reading.borrow().is_none());

    h.kit.destroy(ViewId(1));
    assert_eq!(saving.borrow().clone(), Some(Ok(false)));
    assert_eq!(
        reading.borrow().clone().unwrap().unwrap_err().message,
        "the map is no longer open"
    );
    // the clean view took its copy along; the unsaved one left it for the next launch
    assert_eq!(h.copies().len(), 1);
    assert_eq!(h.ok("mindmap:consume-pending", vec![]), IpcValue::Null);
    assert_eq!(h.ok("mindmap:seed-take", vec![]), IpcValue::Null);
    assert!(h.app.recovery_identity(ViewId(1)).is_none());
    assert!(h.app.recovery_identity(ViewId(2)).is_some());
    assert!(h.app.take_seed(ViewId(1)).is_none());
    h.kit.destroy(ViewId(2));
    assert_eq!(h.copies().len(), 1);
}

#[test]
fn the_outline_and_bytes_of_the_map_come_from_the_renderer_and_are_asked_again() {
    let h = plain("reads");
    h.app.create_view(ViewId(1), None);
    let editor = h.editor(1);
    let (outline, then) = slot::<String>();
    editor.read_text(ViewId(1), then);
    assert_eq!(h.events("mindmap:outline-request").len(), 1);
    // a reply that is not an answer changes nothing; an unanswered request is sent again
    h.ok("mindmap:outline-result", vec![string("nope")]);
    h.ok(
        "mindmap:outline-result",
        vec![obj([("other", string("x"))])],
    );
    assert!(outline.borrow().is_none());
    h.app.run_due(Instant::now() + Duration::from_millis(300));
    assert_eq!(h.events("mindmap:outline-request").len(), 1);
    h.ok(
        "mindmap:outline-result",
        vec![obj([("text", string("# map"))])],
    );
    assert_eq!(outline.borrow().clone(), Some(Ok("# map".to_owned())));

    let (failed, then) = slot::<String>();
    editor.read_text(ViewId(1), then);
    h.ok(
        "mindmap:outline-result",
        vec![obj([("error", string("boom"))])],
    );
    assert_eq!(
        failed.borrow().clone().unwrap().unwrap_err().message,
        "boom"
    );

    let (timed_out, then) = slot::<String>();
    editor.read_text(ViewId(1), then);
    h.app.run_due(Instant::now() + Duration::from_secs(31));
    assert_eq!(
        timed_out.borrow().clone().unwrap().unwrap_err().message,
        "timed out reading the map"
    );

    type Bytes = Rc<RefCell<Option<Result<Vec<u8>, String>>>>;
    let got: Bytes = Rc::default();
    let keep = got.clone();
    h.app
        .read_bytes(ViewId(1), Box::new(move |r| *keep.borrow_mut() = Some(r)));
    assert_eq!(h.events("mindmap:bytes-request").len(), 1);
    h.ok(
        "mindmap:bytes-result",
        vec![obj([("bytes", bytes("XMIND-live"))])],
    );
    assert_eq!(got.borrow().clone(), Some(Ok(b"XMIND-live".to_vec())));
}

#[test]
fn a_new_tab_takes_its_handoff_and_seed_once_and_a_file_tab_never() {
    let h = harness("handoff", |_| {
        json!({"mindmap": {"handoff": {"id": "h1", "text": "do it",
            "materials": [{"path": "/a.md", "name": "a.md"}]}}})
    });
    h.app.create_view(ViewId(1), None);
    let taken = h.ok("mindmap:handoff-take", vec![]);
    assert_eq!(
        taken,
        obj([
            ("id", string("h1")),
            ("sourcePaths", IpcValue::Array(vec![string("/a.md")])),
            ("prompt", string("do it")),
        ])
    );
    assert_eq!(h.ok("mindmap:handoff-take", vec![]), IpcValue::Null);
    let report = |id: &str| {
        obj([
            ("id", string(id)),
            (
                "attachedPaths",
                IpcValue::Array(vec![string("/a.md"), string(""), IpcValue::Number(3.0)]),
            ),
        ])
    };
    h.ok("mindmap:handoff-run-started", vec![report("other")]);
    assert!(
        h.logged("generate-handoff.reportGenerateRunStarted")
            .is_empty()
    );
    h.ok("mindmap:handoff-run-started", vec![report("h1")]);
    assert_eq!(
        h.logged("generate-handoff.reportGenerateRunStarted"),
        vec![json!([
            "generate-handoff.reportGenerateRunStarted",
            "mindmap",
            1,
            ["/a.md"]
        ])]
    );

    h.app.queue_seed(ViewId(1), Seed::Outline("# x".into()));
    assert_eq!(
        h.ok("mindmap:seed-take", vec![]),
        obj([("outline", string("# x"))])
    );
    assert_eq!(h.ok("mindmap:seed-take", vec![]), IpcValue::Null);

    // a view made for a file is not a new map
    let file = h.dir.join("f.xmind");
    fs::write(&file, "XMIND").unwrap();
    let second = h.kit.view(2, Surface::Mindmap);
    h.app.create_view(ViewId(2), Some(&path_str(&file)));
    h.app.queue_seed(ViewId(2), Seed::Copy(b"XMIND".to_vec()));
    assert_eq!(
        h.call_as(second, "mindmap:seed-take", vec![]),
        IpcValue::Null
    );
    assert_eq!(
        h.call_as(second, "mindmap:handoff-take", vec![]),
        IpcValue::Null
    );
}

#[test]
fn attachments_are_judged_by_extension_and_size_and_read_in_pages() {
    let h = harness(
        "attach",
        |dir| json!({"mindmap": {"unsaved": [path_str(&dir.join("open.txt"))]}}),
    );
    h.app.create_view(ViewId(1), None);
    let text = h.dir.join("n.txt");
    fs::write(&text, "0123456789").unwrap();
    let zip = h.dir.join("x.zip");
    fs::write(&zip, "zz").unwrap();
    let added = h.ok(
        "mindmap:files-add",
        vec![IpcValue::Array(vec![
            string(path_str(&text)),
            string(path_str(&zip)),
            IpcValue::Number(1.0),
        ])],
    );
    assert_eq!(
        added,
        obj([
            (
                "accepted",
                IpcValue::Array(vec![obj([
                    ("path", string(path_str(&text))),
                    ("name", string("n.txt")),
                    ("ext", string("txt")),
                    ("sizeBytes", IpcValue::Number(10.0)),
                ])])
            ),
            (
                "rejected",
                IpcValue::Array(vec![string("x.zip: .zip files are not supported")])
            ),
        ])
    );

    let page = h.ok(
        "mindmap:files-read",
        vec![
            string(path_str(&text)),
            IpcValue::Number(2.0),
            IpcValue::Number(3.0),
        ],
    );
    assert_eq!(
        page,
        obj([
            ("ok", IpcValue::Bool(true)),
            ("name", string("n.txt")),
            ("totalChars", IpcValue::Number(10.0)),
            ("offset", IpcValue::Number(2.0)),
            ("text", string("234")),
        ])
    );
    // the second page comes from the cache: the file is parsed once
    h.ok(
        "mindmap:files-read",
        vec![
            string(path_str(&text)),
            IpcValue::Number(5.0),
            IpcValue::Number(99.0),
        ],
    );
    assert_eq!(h.logged("file-parse.parseFileToText").len(), 1);

    // a file open with unsaved changes is not read
    let open = h.dir.join("open.txt");
    fs::write(&open, "x").unwrap();
    let refused = h.ok(
        "mindmap:files-read",
        vec![
            string(path_str(&open)),
            IpcValue::Number(0.0),
            IpcValue::Number(5.0),
        ],
    );
    assert_eq!(
        error_of(&refused),
        "This file is open with unsaved changes. Save it, then try again."
    );

    // pictures: pasted bytes land in the temp folder; the others are refused
    let pasted = h.ok(
        "mindmap:files-add-pasted-image",
        vec![bytes("png-bytes"), string("png")],
    );
    let accepted = match field(&pasted, "accepted") {
        IpcValue::Array(items) => items.clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(accepted.len(), 1);
    let pasted_path = match field(&accepted[0], "path") {
        IpcValue::String(path) => PathBuf::from(path),
        other => panic!("{other:?}"),
    };
    assert!(pasted_path.starts_with(h.dir.join("temp").join("seuoffice-pasted")));
    let image = h.ok(
        "mindmap:files-read-image",
        vec![string(path_str(&pasted_path))],
    );
    assert_eq!(field(&image, "mime"), &string("image/png"));
    let refused = h.ok(
        "mindmap:files-add-pasted-image",
        vec![bytes("x"), string("exe")],
    );
    assert_eq!(
        field(&refused, "rejected"),
        &IpcValue::Array(vec![string("not a supported image type")])
    );

    // the panel's first request names an untitled map
    h.ok("mindmap:provisional-title", vec![string("  My   plan ")]);
    assert_eq!(
        h.logged("ai-attachments.provisionalTitleHook"),
        vec![json!(["ai-attachments.provisionalTitleHook", 1, "My plan"])]
    );
}

#[test]
fn a_link_preview_reads_the_page_and_its_picture_and_links_open_by_protocol() {
    let h = harness("preview", |_| {
        json!({"mindmap": {
            "dns": {
                "example.com": [{"address": "93.184.216.34", "family": 4}],
                "inside.example": [{"address": "10.0.0.5", "family": 4}]},
            "network": {
                "https://example.com/p": {
                    "headers": {"content-type": "text/html; charset=utf-8"},
                    "body": "<title>T</title><meta property=\"og:image\" content=\"/i.png\">"},
                "https://example.com/i.png": {
                    "headers": {"content-type": "image/png"}, "body": "A"},
                "https://inside.example/p": {"headers": {"content-type": "text/html"}}}}})
    });
    h.app.create_view(ViewId(1), None);
    let preview = h.ok(
        "mindmap:read-link-preview",
        vec![string("https://example.com/p")],
    );
    assert_eq!(
        preview,
        obj([
            ("ok", IpcValue::Bool(true)),
            ("title", string("T")),
            (
                "picture",
                obj([("base64", string("QQ==")), ("mime", string("image/png"))])
            ),
        ])
    );
    let reason = |url: &str| {
        field(
            &h.ok("mindmap:read-link-preview", vec![string(url)]),
            "reason",
        )
        .clone()
    };
    assert_eq!(reason("ftp://example.com/p"), string("not-web"));
    assert_eq!(reason("https://example.com/none"), string("unreachable"));
    // a host that resolves into the intranet is never asked
    assert_eq!(reason("https://inside.example/p"), string("unreachable"));
    assert!(
        !h.logged("undici.fetch")
            .iter()
            .any(|line| line[1] == "https://inside.example/p")
    );

    assert_eq!(
        h.ok(
            "mindmap:fetch-image",
            vec![string("https://example.com/i.png")]
        ),
        obj([("base64", string("QQ==")), ("mime", string("image/png"))])
    );
    assert_eq!(
        h.ok("mindmap:fetch-image", vec![IpcValue::Number(1.0)]),
        IpcValue::Null
    );

    assert_eq!(
        h.ok("mindmap:open-link", vec![string("javascript:alert(1)")]),
        IpcValue::Bool(false)
    );
    assert_eq!(
        h.ok("mindmap:open-link", vec![string("mailto:a@b.c")]),
        IpcValue::Bool(true)
    );
    assert!(
        h.kit
            .os_shell
            .log
            .lock()
            .unwrap()
            .iter()
            .any(|l| l == "openExternal mailto:a@b.c")
    );
}

#[test]
fn a_new_map_goes_into_its_project_only_when_the_shell_has_one() {
    let without = plain("project-none");
    without.app.create_view(ViewId(1), None);
    let request = obj([("bytes", bytes("XMIND-1")), ("defaultName", string("Plan"))]);
    assert_eq!(
        without.ok("mindmap:save-into-project", vec![request.clone()]),
        obj([
            ("ok", IpcValue::Bool(false)),
            ("skipped", IpcValue::Bool(true))
        ])
    );

    let with = harness(
        "project-some",
        |dir| json!({"mindmap": {"writeNewDocument": {"path": path_str(&dir.join("proj").join("Plan.xmind"))}}}),
    );
    with.app.create_view(ViewId(1), None);
    let saved = with.ok("mindmap:save-into-project", vec![request]);
    let written = with.dir.join("proj").join("Plan.xmind");
    assert_eq!(
        saved,
        obj([
            ("ok", IpcValue::Bool(true)),
            ("path", string(path_str(&written)))
        ])
    );
    assert_eq!(
        with.logged("mindmap-main.writeNewDocument"),
        vec![json!(["mindmap-main.writeNewDocument", 1, "Plan.xmind", 7])]
    );
    assert_eq!(with.app.file_path(ViewId(1)), Some(path_str(&written)));
    // the map has a file now
    assert_eq!(
        with.ok(
            "mindmap:save-into-project",
            vec![obj([("bytes", bytes("XMIND-1"))])]
        ),
        obj([
            ("ok", IpcValue::Bool(false)),
            ("skipped", IpcValue::Bool(true))
        ])
    );
}

#[test]
fn an_imported_freemind_map_is_read_and_never_written() {
    let h = plain("freemind");
    let mm = h.dir.join("Ideas.MM");
    fs::write(&mm, "<map/>").unwrap();
    h.app.create_view(ViewId(1), Some(&path_str(&mm)));
    let opened = h.ok("mindmap:open-file", vec![string(path_str(&mm))]);
    assert_eq!(
        opened,
        obj([
            ("status", string("import")),
            ("importer", string("freemind")),
            ("bytes", bytes("<map/>")),
            ("title", string("Ideas")),
        ])
    );
    assert_eq!(h.app.file_path(ViewId(1)), None);
    // its first save is offered an .xmind beside the .mm
    h.pick_save(None);
    h.ok("mindmap:save", vec![save_request("XMIND-1", "save")]);
    let dialog_log = h.kit.take_log().join("\n");
    assert!(
        dialog_log.contains(&path_str(&h.dir.join("Ideas.xmind"))),
        "{dialog_log}"
    );
    assert_eq!(fs::read_to_string(&mm).unwrap(), "<map/>");
}

#[test]
fn a_map_open_in_two_panes_asks_before_overwriting_the_sibling_s_write() {
    let h = harness(
        "split",
        |dir| json!({"mindmap": {"openElsewhere": [path_str(&dir.join("m.xmind"))]}}),
    );
    let file = open_granted_file(&h, "m.xmind", "XMIND-1");
    // the sibling pane writes the file
    fs::write(&file, "XMIND-sibling-longer").unwrap();
    // an automatic save defers silently
    let auto = obj([
        ("bytes", bytes("XMIND-2")),
        ("mode", string("save")),
        ("auto", IpcValue::Bool(true)),
    ]);
    assert_eq!(
        error_of(&h.ok("mindmap:save", vec![auto])),
        "external-modified"
    );
    // a manual save asks: keeping the disk copy (Cancel, index 1) stops it, Overwrite goes on
    h.answer_message(1);
    assert_eq!(
        error_of(&h.ok("mindmap:save", vec![save_request("XMIND-2", "save")])),
        "external-modified"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "XMIND-sibling-longer");
    h.answer_message(0);
    assert!(is_ok(
        &h.ok("mindmap:save", vec![save_request("XMIND-2", "save")])
    ));
    assert_eq!(fs::read_to_string(&file).unwrap(), "XMIND-2");
}

#[test]
fn renamed_files_keep_their_grants_and_tell_the_renderer() {
    let h = plain("renamed");
    let file = open_granted_file(&h, "m.xmind", "XMIND-1");
    let moved = h.dir.join("n.xmind");
    h.editor(1).file_renamed(ViewId(1), &file, &moved);
    assert_eq!(h.editor(1).document_path(ViewId(1)), Some(moved.clone()));
    assert_eq!(
        h.ok("mindmap:consume-pending", vec![]),
        string(path_str(&moved))
    );
    assert_eq!(
        h.events("mindmap:file-renamed"),
        vec![vec![string(path_str(&moved))]]
    );
    h.editor(1).export_request(ViewId(1), "pdf");
    let events = h.kit.take_events();
    assert!(events.contains(&(
        Target::View(ViewId(1)),
        "mindmap:export-request",
        vec![string("pdf")]
    )));
}
