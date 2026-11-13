//! What a renderer and the shell observe of the HTML editor's handlers.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use shell_contract::editors::SaveMode;
use shell_contract::ipc::{Sender, Target};
use shell_contract::{IpcValue, Surface, ViewId, editor_for};

use super::fake::FakeHtml;
use crate::kit::{IntoIpc, field, obj};
use crate::testing::{Event, HostCall, Rt};

fn rt_with(case: serde_json::Value) -> Rt {
    let mut rt = Rt::new(|h| {
        crate::text_recovery::test_hosts(h);
        super::fakes(h, &case)
    });
    rt.register(super::entries).unwrap();
    rt
}

fn rt() -> Rt {
    rt_with(json!({}))
}

fn fake(rt: &Rt) -> Arc<FakeHtml> {
    rt.services.hosts.get::<Arc<FakeHtml>>().unwrap().clone()
}

fn editors(rt: &Rt) -> Rc<dyn shell_contract::DocumentEditors> {
    rt.provided()
        .all::<dyn shell_contract::DocumentEditors>()
        .into_iter()
        .next()
        .unwrap()
}

/// the concrete editors, for the calls the trait does not carry
fn html(rt: &Rt) -> Rc<super::HtmlEditors> {
    rt.provided().all::<super::HtmlEditors>().remove(0)
}

fn s(text: &str) -> IpcValue {
    text.into_ipc()
}

fn doc(rt: &Rt, name: &str, text: &str) -> String {
    let path = rt.dir.join(name);
    std::fs::write(&path, text).unwrap();
    path.to_string_lossy().into_owned()
}

fn view_on(rt: &Rt, id: u32, path: Option<&str>) -> Sender {
    let sender = rt.view(id, Surface::Html);
    html(rt).track_view(sender.view, path.map(Path::new));
    sender
}

fn ok_path(path: &str) -> IpcValue {
    obj([("ok", true.into_ipc()), ("path", s(path))])
}

type Got<T> = Rc<RefCell<Option<Result<T, shell_contract::IpcError>>>>;

fn catch<T: 'static>() -> (Got<T>, shell_contract::editors::Then<T>) {
    let got: Got<T> = Rc::default();
    let g = Rc::clone(&got);
    (got, Box::new(move |r| *g.borrow_mut() = Some(r)))
}

#[test]
fn a_view_reads_only_the_files_it_was_granted() {
    let mut rt = rt();
    let path = doc(&rt, "a.html", "<p>hi</p>");
    let v = view_on(&rt, 1, Some(&path));
    let other = view_on(&rt, 2, None);
    assert_eq!(
        rt.invoke_now("html:consume-pending", v, vec![]),
        Ok(s(&path))
    );
    assert_eq!(
        rt.invoke_now("html:consume-pending", other, vec![]),
        Ok(IpcValue::Null)
    );
    assert_eq!(
        rt.invoke_now("html:read-file", v, vec![s(&path)]),
        Ok(s("<p>hi</p>"))
    );
    let refused = rt
        .invoke_now("html:read-file", other, vec![s(&path)])
        .unwrap_err();
    assert_eq!(refused.message, "html: path not granted to this view");
    let missing = view_on(&rt, 3, Some("/no/such.html"));
    assert_eq!(
        rt.invoke_now("html:consume-pending", missing, vec![]),
        Ok(IpcValue::Null)
    );
}

#[test]
fn a_save_writes_the_file_and_clears_the_dirty_flag() {
    let mut rt = rt();
    let path = doc(&rt, "s.html", "old");
    let v = view_on(&rt, 1, Some(&path));
    rt.send("html:dirty-changed", v, vec![true.into_ipc()]);
    let e = editor_for(&rt.provided(), v.view).unwrap();
    assert!(editor_for(&rt.provided(), ViewId(99)).is_none());
    let request = obj([("text", s("new")), ("mode", s("save"))]);
    assert_eq!(
        rt.invoke_now("html:save", v, vec![request]),
        Ok(ok_path(&path))
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    // clean and saved: a menu save answers at once
    let (got, then) = catch();
    e.request_save(v.view, SaveMode::Save, then);
    assert_eq!(*got.borrow(), Some(Ok(true)));
    assert!(rt.events().is_empty());
    assert_eq!(e.document_path(v.view), Some(PathBuf::from(&path)));
}

#[test]
fn bad_save_requests_are_answered_with_their_errors() {
    let mut rt = rt();
    let v = view_on(&rt, 1, None);
    assert_eq!(
        rt.invoke_now("html:save", v, vec![IpcValue::Null]),
        Ok(super::text_doc::failure("html: bad save request"))
    );
    let request = obj([
        ("text", s("x")),
        ("imageSources", IpcValue::Array(vec![1.0.into_ipc()])),
    ]);
    assert_eq!(
        rt.invoke_now("html:save", v, vec![request]),
        Ok(super::text_doc::failure("html: bad image references"))
    );
}

#[test]
fn an_untitled_save_asks_for_a_path_and_tells_the_shell() {
    let mut rt = rt();
    let v = view_on(&rt, 1, None);
    let target = rt.dir.join("picked.html");
    rt.script().save.push_back(None);
    let request = obj([("text", s("x")), ("mode", s("save"))]);
    assert_eq!(
        rt.invoke_now("html:save", v, vec![request.clone()]),
        Ok(super::text_doc::canceled())
    );
    rt.script().save.push_back(Some(target.clone()));
    let path = target.to_string_lossy().into_owned();
    assert_eq!(
        rt.invoke_now("html:save", v, vec![request]),
        Ok(ok_path(&path))
    );
    assert_eq!(
        fake(&rt).answers.called("file_saved"),
        vec![format!("file_saved 1 {path}")]
    );
    // the dialog offered HTML only for a plain save, titled for the editor
    let calls = rt.script().calls.clone();
    let HostCall::Save(_, dialog) = &calls[0] else {
        panic!("{calls:?}")
    };
    assert_eq!(dialog.title.as_deref(), Some("Save HTML Document"));
    assert_eq!(dialog.filters.len(), 1);
}

#[test]
fn a_menu_save_waits_for_the_renderers_save_or_its_ack() {
    let mut rt = rt();
    let path = doc(&rt, "m.html", "a");
    let v = view_on(&rt, 1, Some(&path));
    rt.send("html:dirty-changed", v, vec![true.into_ipc()]);
    let e = editors(&rt);
    let (got, then) = catch();
    e.request_save(v.view, SaveMode::Save, then);
    assert_eq!(
        rt.events(),
        vec![Event {
            target: Target::View(v.view),
            channel: "html:save-request",
            args: vec![s("save")]
        }]
    );
    assert!(got.borrow().is_none());
    let request = obj([("text", s("b"))]);
    rt.invoke_now("html:save", v, vec![request]).unwrap();
    assert_eq!(*got.borrow(), Some(Ok(true)));
    // a declined save answers through the ack; a missing answer times out
    rt.send("html:dirty-changed", v, vec![true.into_ipc()]);
    let (got, then) = catch();
    e.request_save(v.view, SaveMode::SaveAs, then);
    rt.send("html:save-request-ack", v, vec![false.into_ipc()]);
    assert_eq!(*got.borrow(), Some(Ok(false)));
    let (got, then) = catch();
    e.request_save(v.view, SaveMode::Save, then);
    rt.advance(Duration::from_millis(119_999));
    assert!(got.borrow().is_none());
    rt.advance(Duration::from_millis(1));
    assert_eq!(*got.borrow(), Some(Ok(false)));
}

#[test]
fn closing_a_dirty_view_asks_and_follows_the_answer() {
    let mut rt = rt();
    let path = doc(&rt, "c.html", "a");
    let v = view_on(&rt, 1, Some(&path));
    let e = editors(&rt);
    let (got, then) = catch();
    e.request_close(v.view, None, then);
    assert_eq!(*got.borrow(), Some(Ok(true)), "clean views close");
    rt.send("html:dirty-changed", v, vec![true.into_ipc()]);
    rt.script().message.extend([2, 1, 0]);
    let (got, then) = catch();
    e.request_close(v.view, None, then);
    assert_eq!(*got.borrow(), Some(Ok(false)), "cancel");
    let (got, then) = catch();
    e.request_close(v.view, None, then);
    assert_eq!(*got.borrow(), Some(Ok(true)), "don't save");
    let (got, then) = catch();
    e.request_close(v.view, None, then);
    assert_eq!(rt.events()[0].channel, "html:close-save-request");
    rt.send("html:close-save-result", v, vec![true.into_ipc()]);
    assert_eq!(*got.borrow(), Some(Ok(true)), "saved");
    // a view that dies while asked to save does not close cleanly
    let (got, then) = catch();
    rt.script().message.push_back(0);
    e.request_close(v.view, None, then);
    rt.destroy(v.view);
    assert_eq!(*got.borrow(), Some(Ok(false)));
}

#[test]
fn reads_share_one_request_retry_and_time_out() {
    let mut rt = rt();
    let v = view_on(&rt, 1, None);
    let e = editors(&rt);
    let (a, then_a) = catch();
    let (b, then_b) = catch();
    e.read_text(v.view, then_a);
    e.read_text(v.view, then_b);
    assert_eq!(rt.events().len(), 1);
    rt.advance(Duration::from_millis(500));
    assert_eq!(rt.events().len(), 2, "re-sent every 250 ms");
    rt.send(
        "html:read-text-result",
        v,
        vec![obj([("text", 42.0.into_ipc())])],
    );
    assert_eq!(*a.borrow(), Some(Ok("42".into())));
    assert_eq!(*b.borrow(), Some(Ok("42".into())));
    let (c, then_c) = catch::<String>();
    e.read_text(v.view, then_c);
    rt.send("html:read-text-result", v, vec![IpcValue::Null]);
    assert_eq!(
        c.borrow().as_ref().unwrap().as_ref().unwrap_err().message,
        "the document could not be read"
    );
    let (d, then_d) = catch::<String>();
    e.read_text(v.view, then_d);
    rt.advance(Duration::from_millis(30_000));
    assert_eq!(
        d.borrow().as_ref().unwrap().as_ref().unwrap_err().message,
        "timed out reading the document"
    );
}

#[test]
fn save_to_path_points_the_save_and_restores_on_failure() {
    let mut rt = rt();
    let path = doc(&rt, "p.html", "a");
    let v = view_on(&rt, 1, Some(&path));
    let e = editors(&rt);
    let elsewhere = rt.dir.join("mcp.html");
    let (got, then) = catch();
    e.save_to_path(v.view, elsewhere.clone(), then);
    assert_eq!(e.document_path(v.view), Some(elsewhere.clone()));
    rt.send("html:save-request-ack", v, vec![false.into_ipc()]);
    assert_eq!(
        got.borrow().as_ref().unwrap().as_ref().unwrap_err().message,
        "could not save the document"
    );
    assert_eq!(e.document_path(v.view), Some(PathBuf::from(&path)));
    // the renderer's own save lands at the given path without a dialog
    let (got, then) = catch();
    e.save_to_path(v.view, elsewhere.clone(), then);
    rt.invoke_now("html:save", v, vec![obj([("text", s("z"))])])
        .unwrap();
    assert_eq!(*got.borrow(), Some(Ok(())));
    assert_eq!(std::fs::read_to_string(&elsewhere).unwrap(), "z");
    assert!(rt.script().calls.is_empty());
}

#[test]
fn a_rename_moves_the_grant_and_tells_the_renderer() {
    let mut rt = rt();
    let old = doc(&rt, "old.html", "a");
    let v = view_on(&rt, 1, Some(&old));
    let new = rt.dir.join("new.html");
    std::fs::rename(&old, &new).unwrap();
    editors(&rt).file_renamed(v.view, Path::new(&old), &new);
    let new = new.to_string_lossy().into_owned();
    assert_eq!(
        rt.events(),
        vec![Event {
            target: Target::View(v.view),
            channel: "html:file-renamed",
            args: vec![s(&new)]
        }]
    );
    assert_eq!(
        rt.invoke_now("html:read-file", v, vec![s(&new)]),
        Ok(s("a"))
    );
    assert_eq!(
        rt.invoke_now("html:consume-pending", v, vec![]),
        Ok(s(&new))
    );
}

#[test]
fn present_views_show_their_owners_preview_and_close_with_it() {
    let mut rt = rt_with(json!({ "open_present_window": 7 }));
    let owner = view_on(&rt, 1, None);
    let present = rt.view(7, Surface::Html);
    assert_eq!(
        rt.invoke_now("html:present-new-tab", owner, vec![s("Deck")]),
        Ok(true.into_ipc())
    );
    let url = |rt: &mut Rt, from| {
        field(
            &rt.invoke_now("html:preview-info", from, vec![]).unwrap(),
            "url",
        )
        .clone()
    };
    assert_eq!(url(&mut rt, present), url(&mut rt, owner));
    // a presenting view takes no export request and saves as a no-op
    editors(&rt).export_request(present.view, "pdf");
    editors(&rt).export_request(owner.view, "pdf");
    assert_eq!(rt.events().len(), 1);
    let (got, then) = catch();
    html(&rt)
        .docs
        .request_save(present.view, SaveMode::Save, then);
    assert_eq!(*got.borrow(), Some(Ok(true)));
    rt.destroy(owner.view);
    assert_eq!(
        fake(&rt).answers.called("close_present_view"),
        vec!["close_present_view 7"]
    );
}

#[test]
fn present_full_screen_snaps_and_releases_after_a_delay() {
    let mut rt = rt();
    let v = view_on(&rt, 1, None);
    rt.invoke_now("html:present-fullscreen", v, vec![true.into_ipc()])
        .unwrap();
    rt.advance(Duration::from_millis(50));
    let focus = rt
        .script()
        .calls
        .iter()
        .filter(|c| matches!(c, HostCall::Focus(_)))
        .count();
    assert_eq!(focus, 2);
    rt.invoke_now("html:present-fullscreen", v, vec![false.into_ipc()])
        .unwrap();
    assert!(fake(&rt).answers.called("present_leave").is_empty());
    rt.advance(Duration::from_millis(150));
    assert_eq!(
        fake(&rt).answers.called("present_leave"),
        vec!["present_leave_full_screen 1"]
    );
    assert_eq!(
        fake(&rt).answers.called("present_set_bleed"),
        vec!["present_set_bleed 1 true", "present_set_bleed 1 false"]
    );
}

#[test]
fn seeds_and_handoffs_go_only_to_untitled_views_once() {
    let mut rt = rt_with(json!({
        "take_generate_handoff": { "2": { "id": "h1", "text": "make", "materials": [{ "path": "/a.pdf", "name": "a.pdf" }] } },
        "report_generate_run_started": true
    }));
    let path = doc(&rt, "f.html", "x");
    let file = view_on(&rt, 1, Some(&path));
    let fresh = view_on(&rt, 2, None);
    html(&rt).queue_seed(file.view, "seed");
    html(&rt).queue_seed(fresh.view, "seed");
    assert_eq!(
        rt.invoke_now("html:seed-take", file, vec![]),
        Ok(IpcValue::Null)
    );
    assert_eq!(
        rt.invoke_now("html:seed-take", fresh, vec![]),
        Ok(s("seed"))
    );
    assert_eq!(
        rt.invoke_now("html:seed-take", fresh, vec![]),
        Ok(IpcValue::Null)
    );
    assert_eq!(
        rt.invoke_now("html:handoff-take", file, vec![]),
        Ok(IpcValue::Null)
    );
    let taken = rt.invoke_now("html:handoff-take", fresh, vec![]).unwrap();
    assert_eq!(field(&taken, "id"), &s("h1"));
    assert_eq!(
        rt.invoke_now("html:handoff-run-started", fresh, vec![s("not an array")]),
        Ok(false.into_ipc())
    );
    let paths = IpcValue::Array(vec![s("/a.pdf"), 3.0.into_ipc()]);
    assert_eq!(
        rt.invoke_now("html:handoff-run-started", fresh, vec![paths]),
        Ok(true.into_ipc())
    );
    assert_eq!(
        fake(&rt).answers.called("report_generate"),
        vec!["report_generate_run_started 2 /a.pdf"]
    );
}

#[test]
fn provisional_titles_name_only_untitled_documents() {
    let mut rt = rt();
    let path = doc(&rt, "t.html", "x");
    let file = view_on(&rt, 1, Some(&path));
    let fresh = view_on(&rt, 2, None);
    rt.send("html:provisional-title", file, vec![s("Ignored")]);
    rt.send("html:provisional-title", fresh, vec![s("  A \n  plan  ")]);
    rt.send("html:provisional-title", fresh, vec![s("   ")]);
    assert_eq!(
        fake(&rt).answers.called("provisional_title"),
        vec!["provisional_title 2 A plan"]
    );
}

#[test]
fn exports_ask_for_a_target_and_write_what_the_engine_renders() {
    let mut rt = rt();
    let v = view_on(&rt, 1, None);
    let target = rt.dir.join("out.pdf");
    rt.script().save.push_back(Some(target.clone()));
    let request = obj([("html", s("<p>x</p>")), ("suggestedName", s("a/b"))]);
    let reply = rt
        .invoke("html:export-pdf", v, vec![request.clone()])
        .take()
        .unwrap();
    assert_eq!(reply, Ok(ok_path(&target.to_string_lossy())));
    assert_eq!(std::fs::read(&target).unwrap(), b"%PDF");
    let calls = rt.script().calls.clone();
    let HostCall::Save(_, dialog) = &calls[0] else {
        panic!()
    };
    assert!(dialog.default_path.as_ref().unwrap().ends_with("a_b.pdf"));
    assert!(calls.contains(&HostCall::ShowItemInFolder(target.clone())));
    // cancelled, and a request without markup
    rt.script().save.push_back(None);
    assert_eq!(
        rt.invoke_now("html:export-pdf", v, vec![request]),
        Ok(super::text_doc::canceled())
    );
    assert_eq!(
        rt.invoke_now("html:export-docx", v, vec![IpcValue::Null]),
        Ok(super::text_doc::failure("html: bad export request"))
    );
}

#[test]
fn a_word_export_of_a_marked_page_asks_and_headless_refuses() {
    let marked = "<p data-gx-redact>secret</p>";
    let mut rt = rt();
    let v = view_on(&rt, 1, None);
    let target = rt.dir.join("w.docx");
    rt.script().save.push_back(Some(target.clone()));
    rt.script().message.push_back(1);
    let request = obj([("html", s(marked))]);
    assert_eq!(
        rt.invoke_now("html:export-docx", v, vec![request]),
        Ok(super::text_doc::canceled())
    );
    assert!(!target.exists());

    let mut rt = rt_with(json!({ "is_headless": true }));
    let v = view_on(&rt, 1, None);
    let out = rt.dir.join("h.docx").to_string_lossy().into_owned();
    let request = obj([("html", s(marked)), ("outPath", s(&out))]);
    let reply = rt.invoke_now("html:export-docx", v, vec![request]).unwrap();
    assert_eq!(field(&reply, "ok"), &false.into_ipc());
    let plain = obj([("html", s("<p>x</p>")), ("outPath", s(&out))]);
    assert_eq!(
        rt.invoke_now("html:export-docx", v, vec![plain]),
        Ok(ok_path(&out))
    );
    assert_eq!(std::fs::read(&out).unwrap(), b"DOCX");
    assert!(rt.script().calls.is_empty(), "no dialog, no reveal");
}

#[test]
fn an_odt_export_confirms_a_conversion_report() {
    let mut rt = rt_with(json!({
        "docx_to_odt": { "odt": "ODT!", "report": [{ "kind": "dropped", "feature": "ink", "count": 1 }] }
    }));
    let v = view_on(&rt, 1, None);
    let target = rt.dir.join("o.odt");
    rt.script()
        .save
        .extend([Some(target.clone()), Some(target.clone())]);
    rt.script().message.extend([1, 0]);
    let request = obj([("html", s("<p>x</p>"))]);
    assert_eq!(
        rt.invoke_now("html:export-odt", v, vec![request.clone()]),
        Ok(super::text_doc::canceled())
    );
    assert_eq!(
        rt.invoke_now("html:export-odt", v, vec![request]),
        Ok(ok_path(&target.to_string_lossy()))
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"ODT!");
}

#[test]
fn a_single_file_export_refuses_to_overwrite_the_document() {
    let mut rt = rt();
    let path = doc(&rt, "d.html", "x");
    let v = view_on(&rt, 1, Some(&path));
    rt.script().save.push_back(Some(PathBuf::from(&path)));
    let request = obj([("html", s("<p>x</p>"))]);
    assert_eq!(
        rt.invoke_now("html:export-html", v, vec![request.clone()]),
        Ok(super::text_doc::failure(
            "single-file export cannot overwrite the open document"
        ))
    );
    let out = rt.dir.join("single.html");
    rt.script().save.push_back(Some(out.clone()));
    assert_eq!(
        rt.invoke_now("html:export-html", v, vec![request]),
        Ok(ok_path(&out.to_string_lossy()))
    );
}

#[test]
fn images_live_beside_a_saved_document_only() {
    let mut rt = rt();
    let fresh = view_on(&rt, 2, None);
    let png = obj([("base64", s("iVBORw0KGgo=")), ("ext", s("png"))]);
    assert_eq!(
        rt.invoke_now("html:save-image", fresh, vec![png.clone()]),
        Ok(IpcValue::Null)
    );
    let path = doc(&rt, "i.html", "x");
    let v = view_on(&rt, 1, Some(&path));
    let svg = obj([("base64", s("PHN2Zz4=")), ("ext", s("svg"))]);
    assert_eq!(
        rt.invoke_now("html:save-image", v, vec![svg]),
        Ok(IpcValue::Null)
    );
    let IpcValue::String(rel) = rt.invoke_now("html:save-image", v, vec![png]).unwrap() else {
        panic!()
    };
    let image = rt.invoke_now("html:read-image", v, vec![s(&rel)]).unwrap();
    assert_eq!(field(&image, "mime"), &s("image/png"));
    assert_eq!(field(&image, "base64"), &s("iVBORw0KGgo="));
    assert_eq!(
        rt.invoke_now("html:read-image", v, vec![s("https://x/y.png")]),
        Ok(IpcValue::Null)
    );
    assert_eq!(
        rt.invoke_now("html:read-image", v, vec![s("../escape.png")]),
        Ok(IpcValue::Null)
    );
    assert_eq!(
        rt.invoke_now("html:fetch-image", v, vec![1.0.into_ipc()]),
        Ok(IpcValue::Null)
    );
}

#[test]
fn attachments_are_checked_by_type_and_size() {
    let mut rt =
        rt_with(json!({ "parse_file_to_text": { "ok": true, "kind": "text", "text": "abcdef" } }));
    let v = view_on(&rt, 1, None);
    let txt = doc(&rt, "notes.txt", "abcdef");
    let exe = doc(&rt, "tool.exe", "x");
    let added = rt
        .invoke_now(
            "html:files-add",
            v,
            vec![IpcValue::Array(vec![s(&txt), s(&exe), 5.0.into_ipc()])],
        )
        .unwrap();
    let IpcValue::Array(accepted) = field(&added, "accepted") else {
        panic!()
    };
    assert_eq!(accepted.len(), 1);
    assert_eq!(field(&accepted[0], "ext"), &s("txt"));
    assert_eq!(
        field(&added, "rejected"),
        &IpcValue::Array(vec![s("tool.exe: .exe files are not supported")])
    );
    let read = rt
        .invoke_now(
            "html:files-read",
            v,
            vec![s(&txt), 2.0.into_ipc(), 3.0.into_ipc()],
        )
        .unwrap();
    assert_eq!(field(&read, "text"), &s("cde"));
    assert_eq!(field(&read, "totalChars"), &6.0.into_ipc());
    let image = rt
        .invoke_now(
            "html:files-read",
            v,
            vec![s("/x/a.png"), 0.0.into_ipc(), 1.0.into_ipc()],
        )
        .unwrap();
    assert_eq!(field(&image, "ok"), &false.into_ipc());
    let thrown = rt
        .invoke_now("html:files-read", v, vec![IpcValue::Undefined])
        .unwrap_err();
    assert_eq!(
        thrown.name.as_deref(),
        Some("TypeError [ERR_INVALID_ARG_TYPE]")
    );
    let not_image = rt
        .invoke_now("html:files-read-image", v, vec![s(&txt)])
        .unwrap();
    assert_eq!(
        field(&not_image, "error"),
        &s("notes.txt: not a supported image type")
    );
    let pasted = rt
        .invoke_now(
            "html:files-add-pasted-image",
            v,
            vec![
                IpcValue::Bytes(shell_contract::BytesKind::ArrayBuffer, vec![1, 2]),
                s("PNG"),
            ],
        )
        .unwrap();
    let IpcValue::Array(accepted) = field(&pasted, "accepted") else {
        panic!()
    };
    assert_eq!(field(&accepted[0], "ext"), &s("png"));
    let refused = rt
        .invoke_now(
            "html:files-add-pasted-image",
            v,
            vec![IpcValue::Null, s("png")],
        )
        .unwrap();
    assert_eq!(
        field(&refused, "rejected"),
        &IpcValue::Array(vec![s("not a supported image type")])
    );
}

#[test]
fn a_headless_export_hands_its_target_once_and_settles_on_the_report() {
    let mut rt = rt();
    let input = doc(&rt, "in.html", "x");
    let v = rt.view(1, Surface::Html);
    let (got, then) = catch::<()>();
    let then: Box<dyn FnOnce(Result<(), String>)> =
        Box::new(move |r| then(r.map_err(crate::kit::error)));
    html(&rt).export_headless(
        v.view,
        &input,
        "/out.pdf",
        "pdf",
        Duration::from_secs(5),
        then,
    );
    let target = rt
        .invoke_now("html:consume-headless-export", v, vec![])
        .unwrap();
    assert_eq!(
        target,
        obj([("outPath", s("/out.pdf")), ("format", s("pdf"))])
    );
    assert_eq!(
        rt.invoke_now("html:consume-headless-export", v, vec![]),
        Ok(IpcValue::Null)
    );
    rt.send(
        "html:headless-export-done",
        v,
        vec![obj([("ok", false.into_ipc()), ("error", s("boom"))])],
    );
    assert_eq!(
        got.borrow().as_ref().unwrap().as_ref().unwrap_err().message,
        "boom"
    );
    let (got, then) = catch::<()>();
    let then: Box<dyn FnOnce(Result<(), String>)> =
        Box::new(move |r| then(r.map_err(crate::kit::error)));
    html(&rt).export_headless(
        v.view,
        &input,
        "/out.pdf",
        "pdf",
        Duration::from_secs(5),
        then,
    );
    rt.advance(Duration::from_secs(5));
    assert_eq!(
        got.borrow().as_ref().unwrap().as_ref().unwrap_err().message,
        "html export timed out after 5000ms"
    );
}

#[test]
fn recovery_copies_follow_the_dirty_flag() {
    let mut rt = rt();
    let path = doc(&rt, "r.html", "x");
    let v = view_on(&rt, 1, Some(&path));
    assert_eq!(
        rt.invoke_now("html:recovery-write", v, vec![s("t")]),
        Ok(s("skipped"))
    );
    rt.send("html:dirty-changed", v, vec![true.into_ipc()]);
    assert_eq!(
        rt.invoke_now("html:recovery-write", v, vec![s("t")]),
        Ok(s("written"))
    );
    assert_eq!(
        rt.invoke_now("html:recovery-write", v, vec![s("t")]),
        Ok(s("unchanged"))
    );
    // opening the file again asks about the copy this view wrote
    rt.script().message.push_back(0);
    let restored = rt.invoke_now("html:recovery-open", v, vec![]).unwrap();
    assert_eq!(restored, obj([("text", s("t"))]));
}

#[test]
fn the_shells_calls_see_the_renderers_state() {
    let mut rt = rt();
    let path = doc(&rt, "k.html", "x");
    let v = view_on(&rt, 1, Some(&path));
    let h = html(&rt);
    rt.send("html:preview-update", v, vec![1.0.into_ipc()]);
    assert_eq!(h.preview_text(v.view), None);
    rt.send("html:preview-update", v, vec![s("<p>live</p>")]);
    assert_eq!(h.preview_text(v.view).as_deref(), Some("<p>live</p>"));
    rt.send("html:dirty-changed", v, vec![true.into_ipc()]);
    assert!(h.is_dirty(v.view));
    rt.invoke_now("html:recovery-write", v, vec![s("t")])
        .unwrap();
    // closing without saving drops the copy and blocks the next one
    h.discard_pending_assets(v.view);
    assert_eq!(
        rt.invoke_now("html:recovery-write", v, vec![s("t2")]),
        Ok(s("superseded"))
    );
    // a renderer that dies fails the headless export it was running
    let (got, then) = catch::<()>();
    let then: Box<dyn FnOnce(Result<(), String>)> =
        Box::new(move |r| then(r.map_err(crate::kit::error)));
    h.export_headless(v.view, &path, "/o.pdf", "pdf", Duration::from_secs(9), then);
    h.renderer_gone(v.view, "crashed");
    assert_eq!(
        got.borrow().as_ref().unwrap().as_ref().unwrap_err().message,
        "html renderer stopped (crashed)"
    );
    rt.destroy(v.view);
    assert_eq!(h.preview_text(v.view), None);
    assert!(!h.is_dirty(v.view));
}

/// runs `d2/html:<what>` as ipc-probe's trigger step does
fn trigger(rt: &mut Rt, what: &str, view: u32, args: serde_json::Value) -> Got<IpcValue> {
    let (got, then) = catch();
    let known = super::probe_trigger(
        what,
        ViewId(view),
        &args,
        &rt.services,
        &rt.provided(),
        then,
    );
    assert!(known, "{what}");
    rt.drain();
    got
}

#[test]
fn triggers_run_the_shells_calls_and_report_their_outcome() {
    let mut rt = rt();
    let path = doc(&rt, "t.html", "x");
    let v = rt.view(1, Surface::Html);
    assert!(
        !super::probe_trigger(
            "no-such",
            v.view,
            &json!([]),
            &rt.services,
            &rt.provided(),
            Box::new(|_| {})
        ),
        "an unknown name"
    );
    trigger(&mut rt, "open-view", 1, json!([path]));
    assert_eq!(
        rt.invoke_now("html:consume-pending", v, vec![]),
        Ok(s(&path))
    );
    rt.send("html:dirty-changed", v, vec![true.into_ipc()]);
    let saved = trigger(&mut rt, "request-save", 1, json!(["saveAs"]));
    assert_eq!(rt.events()[0].args, vec![s("saveAs")]);
    rt.send("html:save-request-ack", v, vec![true.into_ipc()]);
    assert_eq!(*saved.borrow(), Some(Ok(true.into_ipc())));
    let text = trigger(&mut rt, "read-text", 1, json!([]));
    rt.send("html:read-text-result", v, vec![obj([("text", s("live"))])]);
    assert_eq!(*text.borrow(), Some(Ok(s("live"))));
    let fresh = rt.view(2, Surface::Html);
    trigger(&mut rt, "queue-seed", 2, json!(["seed"]));
    assert_eq!(
        rt.invoke_now("html:seed-take", fresh, vec![]),
        Ok(s("seed"))
    );
    let failed = trigger(&mut rt, "save-to-path", 1, json!(["/elsewhere.html"]));
    rt.send("html:save-request-ack", v, vec![false.into_ipc()]);
    let error = failed.borrow().clone().unwrap().unwrap_err();
    assert_eq!(error.message, "could not save the document");
    let dirty = trigger(&mut rt, "is-dirty", 1, json!([]));
    assert_eq!(*dirty.borrow(), Some(Ok(true.into_ipc())));
}
