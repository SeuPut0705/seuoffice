//! What a renderer and the shell observe of the Markdown editor's handlers.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use shell_contract::editors::SaveMode;
use shell_contract::ipc::{Sender, Target};
use shell_contract::{IpcValue, Surface, editor_for};

use super::fake::FakeMarkdown;
use crate::html::text_doc::{canceled, failure};
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

fn fake(rt: &Rt) -> Arc<FakeMarkdown> {
    rt.services
        .hosts
        .get::<Arc<FakeMarkdown>>()
        .unwrap()
        .clone()
}

fn md(rt: &Rt) -> Rc<super::MarkdownEditors> {
    rt.provided().all::<super::MarkdownEditors>().remove(0)
}

fn s(text: &str) -> IpcValue {
    text.into_ipc()
}

fn vault(rt: &Rt) -> PathBuf {
    rt.dir.join("documents").join("SeuOffice")
}

fn note(rt: &Rt, rel: &str, text: &str) -> String {
    let path = vault(rt).join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, text).unwrap();
    path.to_string_lossy().into_owned()
}

fn view_on(rt: &Rt, id: u32, path: Option<&str>) -> Sender {
    let sender = rt.view(id, Surface::Markdown);
    md(rt).track_view(sender.view, path.map(Path::new));
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

const PNG: &str = "iVBORw0KGgoAAAANSUhEUg==";

#[test]
fn a_note_opens_reads_and_saves_through_the_shared_document_state() {
    let mut rt = rt();
    let path = note(&rt, "a.md", "# A");
    let v = view_on(&rt, 1, Some(&path));
    assert_eq!(
        rt.invoke_now("markdown:consume-pending", v, vec![]),
        Ok(s(&path))
    );
    assert_eq!(
        rt.invoke_now("markdown:read-file", v, vec![s(&path)]),
        Ok(s("# A"))
    );
    let refused = rt
        .invoke_now("markdown:read-file", v, vec![s("/etc/hosts")])
        .unwrap_err();
    assert_eq!(refused.message, "markdown: path not granted to this view");
    rt.send("markdown:dirty-changed", v, vec![true.into_ipc()]);
    let e = editor_for(&rt.provided(), v.view).unwrap();
    let (got, then) = catch();
    e.request_save(v.view, SaveMode::Save, then);
    assert_eq!(rt.events()[0].channel, "markdown:save-request");
    let reply = rt.invoke_now("markdown:save", v, vec![obj([("text", s("# B"))])]);
    assert_eq!(reply, Ok(ok_path(&path)));
    assert_eq!(*got.borrow(), Some(Ok(true)));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "# B");
    assert_eq!(e.document_path(v.view), Some(PathBuf::from(&path)));
    assert_eq!(
        rt.invoke_now("markdown:save", v, vec![obj([("text", 1.0.into_ipc())])]),
        Ok(failure("markdown: bad save request"))
    );
}

#[test]
fn save_as_to_a_rendered_format_approves_one_export() {
    let mut rt = rt();
    let path = note(&rt, "x.md", "x");
    let v = view_on(&rt, 1, Some(&path));
    let target = vault(&rt).join("x.docx");
    let target_s = target.to_string_lossy().into_owned();
    rt.script().save.push_back(Some(target.clone()));
    let request = obj([
        ("text", s("x")),
        ("mode", s("saveAs")),
        ("pdfHtml", s("<p>x</p>")),
    ]);
    let reply = rt.invoke_now("markdown:save", v, vec![request]).unwrap();
    assert_eq!(
        reply,
        obj([
            ("ok", true.into_ipc()),
            ("path", s(&target_s)),
            ("exportAs", s("docx"))
        ])
    );
    // the document keeps its path
    assert_eq!(
        rt.invoke_now("markdown:consume-pending", v, vec![]),
        Ok(s(&path))
    );
    let export = |to: &str| obj([("base64", s("UEsDBA==")), ("saveAsTarget", s(to))]);
    assert_eq!(
        rt.invoke_now("markdown:export-docx", v, vec![export("/elsewhere.docx")]),
        Ok(failure("markdown: save target not approved"))
    );
    // a refused request leaves the approval for the right path
    assert_eq!(
        rt.invoke_now("markdown:export-docx", v, vec![export(&target_s)]),
        Ok(ok_path(&target_s))
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"PK\x03\x04");
    assert_eq!(
        rt.invoke_now("markdown:export-docx", v, vec![export(&target_s)]),
        Ok(failure("markdown: save target not approved")),
        "taken once"
    );
    // the offered filters include the rendered formats
    let calls = rt.script().calls.clone();
    let HostCall::Save(_, dialog) = &calls[0] else {
        panic!()
    };
    assert_eq!(dialog.filters.len(), 5);
}

#[test]
fn save_as_pdf_prints_the_screen_and_opens_it() {
    let mut rt = rt_with(json!({ "open_generated_path": true }));
    let v = view_on(&rt, 1, None);
    let target = rt.dir.join("p.pdf");
    rt.script().save.push_back(Some(target.clone()));
    let request = obj([
        ("text", s("x")),
        ("mode", s("saveAs")),
        ("pdfHtml", s("<p>x</p>")),
    ]);
    let reply = rt.invoke_now("markdown:save", v, vec![request]).unwrap();
    assert_eq!(field(&reply, "exported"), &s("pdf"));
    assert_eq!(std::fs::read(&target).unwrap(), b"%PDF");
    assert_eq!(fake(&rt).answers.called("open_generated_path").len(), 1);
    assert!(
        editor_for(&rt.provided(), v.view)
            .unwrap()
            .document_path(v.view)
            .is_none()
    );
}

#[test]
fn an_unnamed_first_save_with_a_suggestion_lands_beside_the_others() {
    let mut rt = rt();
    note(&rt, "Plan.md", "taken");
    let v = view_on(&rt, 1, None);
    let request = obj([("text", s("new")), ("suggestedName", s("Plan"))]);
    let reply = rt.invoke_now("markdown:save", v, vec![request]).unwrap();
    let written = vault(&rt).join("Plan-1.md");
    assert_eq!(reply, ok_path(&written.to_string_lossy()));
    assert_eq!(std::fs::read_to_string(written).unwrap(), "new");
    assert!(rt.script().calls.is_empty(), "no dialog");
}

#[test]
fn seeds_and_note_appends_reach_only_their_views() {
    let mut rt = rt();
    let path = note(&rt, "n.md", "x");
    let file = view_on(&rt, 1, Some(&path));
    let fresh = view_on(&rt, 2, None);
    md(&rt).queue_seed(fresh.view, "outline");
    md(&rt).queue_seed(file.view, "outline");
    assert_eq!(
        rt.invoke_now("markdown:seed-take", file, vec![]),
        Ok(IpcValue::Null)
    );
    assert_eq!(
        rt.invoke_now("markdown:seed-take", fresh, vec![]),
        Ok(s("outline"))
    );
    assert_eq!(
        rt.invoke_now("markdown:seed-take", fresh, vec![]),
        Ok(IpcValue::Null)
    );
    md(&rt).queue_note_append(file.view, &path, "one");
    md(&rt).queue_note_append(file.view, &path, "two");
    assert_eq!(
        rt.events(),
        vec![
            Event {
                target: Target::View(file.view),
                channel: "markdown:note-append-ready",
                args: vec![]
            };
            2
        ]
    );
    md(&rt).queue_note_append(fresh.view, &path, "lost");
    let empty = IpcValue::Array(Vec::new());
    assert_eq!(
        rt.invoke_now("markdown:note-append-take", fresh, vec![]),
        Ok(empty.clone())
    );
    assert_eq!(
        rt.invoke_now("markdown:note-append-take", file, vec![]),
        Ok(IpcValue::Array(vec![s("one"), s("two")]))
    );
    assert_eq!(
        rt.invoke_now("markdown:note-append-take", file, vec![]),
        Ok(empty)
    );
}

#[test]
fn wiki_links_resolve_and_notes_get_created_in_the_vault() {
    let mut rt = rt();
    let a = note(&rt, "a.md", "see [[b#Intro]] #tag");
    let b = note(&rt, "sub/b.md", "# Intro\ntext");
    let v = view_on(&rt, 1, Some(&a));
    let request = obj([
        ("fromPath", s(&a)),
        (
            "targets",
            IpcValue::Array(vec![s("b#Intro"), s("missing"), 3.0.into_ipc()]),
        ),
    ]);
    let resolved = rt
        .invoke_now("markdown:resolve-wiki-links", v, vec![request])
        .unwrap();
    assert_eq!(field(field(&resolved, "b#Intro"), "path"), &s(&b));
    assert_eq!(
        field(field(&resolved, "missing"), "found"),
        &false.into_ipc()
    );
    let IpcValue::Array(notes) = rt
        .invoke_now("markdown:list-wiki-notes", v, vec![])
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(notes.len(), 2);
    let heads = rt
        .invoke_now(
            "markdown:wiki-heads",
            v,
            vec![obj([("target", s("b")), ("fromPath", s(&a))])],
        )
        .unwrap();
    assert_ne!(heads, IpcValue::Array(Vec::new()));
    let IpcValue::Array(links) = rt
        .invoke_now("markdown:wiki-backlinks", v, vec![s(&b)])
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(links.len(), 1);
    assert_eq!(
        rt.invoke_now("markdown:wiki-backlinks", v, vec![IpcValue::Null]),
        Ok(IpcValue::Array(vec![]))
    );
    let IpcValue::Array(tags) = rt.invoke_now("markdown:wiki-tags", v, vec![]).unwrap() else {
        panic!()
    };
    assert_eq!(field(&tags[0], "tag"), &s("tag"));
    let graph = rt.invoke_now("markdown:wiki-graph", v, vec![]).unwrap();
    assert!(matches!(field(&graph, "nodes"), IpcValue::Array(n) if n.len() == 2));
    let made = rt
        .invoke_now(
            "markdown:create-wiki-note",
            v,
            vec![obj([("target", s("fresh"))])],
        )
        .unwrap();
    assert_eq!(field(&made, "ok"), &true.into_ipc());
    assert!(Path::new(kit_str(field(&made, "path"))).exists());
    assert_eq!(
        rt.invoke_now(
            "markdown:create-wiki-note",
            v,
            vec![obj([("target", s(""))])]
        ),
        Ok(obj([("ok", false.into_ipc())]))
    );
}

fn kit_str(v: &IpcValue) -> &str {
    crate::kit::as_str(v).unwrap()
}

#[test]
fn a_wiki_fragment_is_taken_once() {
    let mut rt = rt();
    let v = view_on(&rt, 1, None);
    rt.invoke_now(
        "markdown:remember-wiki-fragment",
        v,
        vec![s("/n.md"), s("Intro")],
    )
    .unwrap();
    rt.invoke_now(
        "markdown:remember-wiki-fragment",
        v,
        vec![s("/n.md"), 1.0.into_ipc()],
    )
    .unwrap();
    assert_eq!(
        rt.invoke_now("markdown:take-wiki-fragment", v, vec![s("/n.md")]),
        Ok(s("Intro"))
    );
    assert_eq!(
        rt.invoke_now("markdown:take-wiki-fragment", v, vec![s("/n.md")]),
        Ok(s(""))
    );
    assert_eq!(
        rt.invoke_now("markdown:take-wiki-fragment", v, vec![IpcValue::Null]),
        Ok(s(""))
    );
}

#[test]
fn the_image_host_is_stored_beside_other_settings() {
    let mut rt = rt();
    let v = view_on(&rt, 1, None);
    let settings = rt.dir.join("userData").join("markdown-settings.json");
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    std::fs::write(&settings, r#"{"markdownTheme":"paper"}"#).unwrap();
    assert_eq!(
        rt.invoke_now("markdown:get-image-host", v, vec![]),
        Ok(IpcValue::Null)
    );
    let incomplete = obj([("kind", s("s3"))]);
    assert_eq!(
        rt.invoke_now("markdown:set-image-host", v, vec![incomplete]),
        Ok(IpcValue::Null)
    );
    assert_eq!(
        std::fs::read_to_string(&settings).unwrap(),
        r#"{"markdownTheme":"paper"}"#
    );
    let config = obj([
        ("kind", s("github")),
        ("token", s("t")),
        ("owner", s("o")),
        ("repo", s("r")),
    ]);
    let stored = rt
        .invoke_now("markdown:set-image-host", v, vec![config])
        .unwrap();
    assert_eq!(field(&stored, "kind"), &s("github"));
    assert_eq!(
        rt.invoke_now("markdown:get-image-host", v, vec![]),
        Ok(stored)
    );
    let file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
    assert_eq!(file["markdownTheme"], "paper");
    // null clears it
    assert_eq!(
        rt.invoke_now("markdown:set-image-host", v, vec![IpcValue::Null]),
        Ok(IpcValue::Null)
    );
    assert_eq!(
        rt.invoke_now("markdown:get-image-host", v, vec![]),
        Ok(IpcValue::Null)
    );
}

#[test]
fn uploads_check_the_picture_and_the_host() {
    let mut rt = rt();
    let v = view_on(&rt, 1, None);
    // the app's data folder exists in every running app
    std::fs::create_dir_all(rt.dir.join("userData")).unwrap();
    let upload = |ext: &str, base64: &str| obj([("base64", s(base64)), ("ext", s(ext))]);
    let error = |rt: &mut Rt, req| {
        field(
            &rt.invoke_now("markdown:upload-image", v, vec![req])
                .unwrap(),
            "error",
        )
        .clone()
    };
    assert_eq!(
        error(&mut rt, upload("exe", PNG)),
        s("unsupported image type")
    );
    assert_eq!(error(&mut rt, upload("PNG", "")), s("missing image data"));
    assert_eq!(
        error(&mut rt, upload("png", PNG)),
        s("no usable image host configured")
    );
    let config = obj([
        ("kind", s("github")),
        ("token", s("t")),
        ("owner", s("o")),
        ("repo", s("r")),
    ]);
    rt.invoke_now("markdown:set-image-host", v, vec![config])
        .unwrap();
    let reply = rt
        .invoke_now("markdown:upload-image", v, vec![upload("png", PNG)])
        .unwrap();
    assert_eq!(
        field(&reply, "ok"),
        &false.into_ipc(),
        "the fake network is down"
    );
    assert_eq!(fake(&rt).answers.called("upload_fetch").len(), 1);
}

#[test]
fn pictures_are_kept_beside_a_saved_note_and_read_back() {
    let mut rt = rt();
    let fresh = view_on(&rt, 2, None);
    let png = obj([("base64", s(PNG)), ("ext", s("png"))]);
    assert_eq!(
        rt.invoke_now("markdown:save-image", fresh, vec![png.clone()]),
        Ok(IpcValue::Null)
    );
    let path = note(&rt, "i.md", "x");
    let v = view_on(&rt, 1, Some(&path));
    let IpcValue::String(rel) = rt.invoke_now("markdown:save-image", v, vec![png]).unwrap() else {
        panic!()
    };
    let read = rt
        .invoke_now("markdown:read-image", v, vec![s(&rel)])
        .unwrap();
    assert_eq!(read, obj([("base64", s(PNG)), ("mime", s("image/png"))]));
    let huge = "A".repeat(50 * 1024 * 1024 / 3 * 4 + 8);
    let too_big = obj([("base64", s(&huge)), ("ext", s("png"))]);
    assert_eq!(
        rt.invoke_now("markdown:save-image", v, vec![too_big]),
        Ok(IpcValue::Null)
    );
    assert_eq!(
        rt.invoke_now("markdown:read-image", v, vec![s("https://127.0.0.1/a.png")]),
        Ok(IpcValue::Null)
    );
    assert_eq!(
        rt.invoke_now("markdown:read-image", v, vec![s("data:image/png;base64,x")]),
        Ok(IpcValue::Null)
    );
    assert_eq!(
        rt.invoke_now("markdown:save-image-as", v, vec![IpcValue::Null]),
        Ok(obj([("ok", false.into_ipc())]))
    );
    let saved = rt
        .invoke_now("markdown:save-image-as", v, vec![s("md-asset:///x.png")])
        .unwrap();
    assert_eq!(field(&saved, "ok"), &false.into_ipc());
    assert_eq!(
        fake(&rt).answers.called("net_fetch"),
        vec!["net_fetch md-asset:///x.png"]
    );
}

#[test]
fn open_in_docs_writes_a_cached_conversion_for_the_shell() {
    let mut rt = rt();
    let v = view_on(&rt, 1, None);
    let request = obj([
        ("base64", s("UEsDBA==")),
        ("suggestedName", s("A/B")),
        ("mode", s("openInDocs")),
    ]);
    let reply = rt
        .invoke_now("markdown:export-docx", v, vec![request])
        .unwrap();
    let path = kit_str(field(&reply, "path")).to_owned();
    assert!(path.contains("markdown-conversions"), "{path}");
    assert!(path.ends_with(".docx"));
    assert_eq!(
        fake(&rt).answers.called("docx_exported"),
        vec![format!("docx_exported {path}")]
    );
    assert_eq!(
        rt.invoke_now("markdown:export-docx", v, vec![obj([("base64", s(""))])]),
        Ok(failure("markdown: bad export request"))
    );
}

#[test]
fn an_odt_export_confirms_its_report() {
    let mut rt = rt_with(json!({
        "docx_to_odt": { "odt": "ODT", "report": [{ "kind": "converted", "feature": "toc", "count": 1 }] }
    }));
    let v = view_on(&rt, 1, None);
    let target = rt.dir.join("o.odt");
    rt.script()
        .save
        .extend([Some(target.clone()), Some(target.clone()), None]);
    rt.script().message.extend([1, 0]);
    let request = obj([("base64", s("UEsDBA=="))]);
    assert_eq!(
        rt.invoke_now("markdown:export-odt", v, vec![request.clone()]),
        Ok(canceled())
    );
    assert!(!target.exists());
    assert_eq!(
        rt.invoke_now("markdown:export-odt", v, vec![request.clone()]),
        Ok(ok_path(&target.to_string_lossy()))
    );
    assert_eq!(
        rt.invoke_now("markdown:export-odt", v, vec![request]),
        Ok(canceled()),
        "no path"
    );
}

#[test]
fn the_marked_odt_box_answers_the_pressed_way_out() {
    let mut rt = rt();
    let v = view_on(&rt, 1, None);
    rt.script().message.extend([0, 1, 2]);
    for want in ["docx", "clear", "cancel"] {
        assert_eq!(
            rt.invoke_now("markdown:confirm-marked-odt", v, vec![]),
            Ok(s(want))
        );
    }
    let mut rt = rt_with(json!({ "is_headless": true }));
    let v = view_on(&rt, 1, None);
    assert_eq!(
        rt.invoke_now("markdown:confirm-marked-odt", v, vec![]),
        Ok(s("cancel"))
    );
    assert!(rt.script().calls.is_empty());
}

#[test]
fn a_pdf_export_prints_to_the_chosen_path() {
    let mut rt = rt();
    let v = view_on(&rt, 1, None);
    let target = rt.dir.join("e.pdf");
    rt.script().save.push_back(Some(target.clone()));
    let request = obj([("html", s("<p>x</p>"))]);
    assert_eq!(
        rt.invoke_now("markdown:export-pdf", v, vec![request.clone()]),
        Ok(ok_path(&target.to_string_lossy()))
    );
    assert!(
        rt.script()
            .calls
            .contains(&HostCall::ShowItemInFolder(target))
    );
    let mut rt = rt_with(json!({ "print_pdf": { "error": "no printer" } }));
    let v = view_on(&rt, 1, None);
    rt.script().save.push_back(Some(rt.dir.join("f.pdf")));
    assert_eq!(
        rt.invoke_now("markdown:export-pdf", v, vec![request]),
        Ok(failure("no printer"))
    );
}

#[test]
fn page_images_are_written_in_order_and_finished_into_their_folder() {
    let mut rt = rt();
    let v = view_on(&rt, 1, None);
    let other = view_on(&rt, 2, None);
    let parent = rt.dir.join("out");
    std::fs::create_dir_all(&parent).unwrap();
    rt.script().open.push_back(Some(vec![parent.clone()]));
    let request = obj([("html", s("<p>x</p>")), ("suggestedName", s("Deck"))]);
    let prepared = rt
        .invoke_now("markdown:prepare-image-export", v, vec![request])
        .unwrap();
    assert_eq!(field(&prepared, "pdfBase64"), &s("JVBERg=="));
    let id = field(&prepared, "id").clone();
    let page = |n: f64| vec![id.clone(), n.into_ipc(), s(PNG)];
    let not_owner = rt
        .invoke_now("markdown:write-export-image", other, page(1.0))
        .unwrap();
    assert_eq!(not_owner, failure("Export session is not authorized"));
    assert_eq!(
        rt.invoke_now("markdown:write-export-image", v, page(2.0)),
        Ok(failure("Invalid export page number"))
    );
    assert_eq!(
        rt.invoke_now("markdown:write-export-image", v, page(1.0)),
        Ok(obj([("ok", true.into_ipc())]))
    );
    let done = rt
        .invoke_now("markdown:finish-image-export", v, vec![id, true.into_ipc()])
        .unwrap();
    let dir = kit_str(field(&done, "path")).to_owned();
    assert!(dir.starts_with(&*parent.to_string_lossy()), "{dir}");
    assert!(std::fs::read_dir(&dir).unwrap().count() == 1);
    assert!(
        rt.script()
            .calls
            .iter()
            .any(|c| matches!(c, HostCall::ShowItemInFolder(_)))
    );
    assert_eq!(
        rt.invoke_now(
            "markdown:prepare-image-export",
            v,
            vec![obj([("html", s(""))])]
        ),
        Ok(failure("Empty document"))
    );
}

#[test]
fn closing_reading_and_renaming_go_through_the_renderer() {
    let mut rt = rt();
    let old = note(&rt, "r.md", "x");
    let v = view_on(&rt, 1, Some(&old));
    let e = editor_for(&rt.provided(), v.view).unwrap();
    rt.send("markdown:dirty-changed", v, vec![true.into_ipc()]);
    rt.script().message.push_back(0);
    let (closed, then) = catch();
    e.request_close(v.view, None, then);
    assert_eq!(rt.events()[0].channel, "markdown:close-save-request");
    rt.advance(Duration::from_millis(120_000));
    assert_eq!(*closed.borrow(), Some(Ok(false)), "timed out");
    let (text, then) = catch();
    e.read_text(v.view, then);
    rt.send(
        "markdown:read-text-result",
        v,
        vec![obj([("text", s("live"))])],
    );
    assert_eq!(*text.borrow(), Some(Ok("live".to_owned())));
    let new = vault(&rt).join("renamed.md");
    std::fs::rename(&old, &new).unwrap();
    rt.events();
    e.file_renamed(v.view, Path::new(&old), &new);
    assert_eq!(rt.events().last().unwrap().channel, "markdown:file-renamed");
    assert_eq!(e.document_path(v.view), Some(new));
    e.export_request(v.view, "docx");
    assert_eq!(
        rt.events(),
        vec![Event {
            target: Target::View(v.view),
            channel: "markdown:export-request",
            args: vec![s("docx")]
        }]
    );
}

#[test]
fn a_headless_pdf_export_takes_its_path_once() {
    let mut rt = rt();
    let input = note(&rt, "h.md", "x");
    let v = rt.view(1, Surface::Markdown);
    let (got, then) = catch::<()>();
    let then: Box<dyn FnOnce(Result<(), String>)> =
        Box::new(move |r| then(r.map_err(crate::kit::error)));
    md(&rt).export_pdf_headless(v.view, &input, "/o.pdf", Duration::from_secs(5), then);
    assert_eq!(
        rt.invoke_now("markdown:consume-headless-export", v, vec![]),
        Ok(s("/o.pdf"))
    );
    assert_eq!(
        rt.invoke_now("markdown:consume-headless-export", v, vec![]),
        Ok(IpcValue::Null)
    );
    rt.send(
        "markdown:headless-export-done",
        v,
        vec![obj([("ok", true.into_ipc())])],
    );
    assert_eq!(*got.borrow(), Some(Ok(())));
}

/// The start-up check of this batch, for the two text editors: every html
/// and markdown channel of D2 a renderer invokes or sends to has a handler of
/// that kind, and nothing else is registered
#[test]
fn registers_every_text_editor_channel_and_nothing_else() {
    use std::collections::BTreeSet;

    use shell_contract::ipc::ChannelKind;
    use shell_contract::{Batch, CHANNELS};

    let mut rt = Rt::new(|h| {
        crate::text_recovery::test_hosts(h);
        crate::html::fakes(h, &serde_json::Value::Null);
        super::fakes(h, &serde_json::Value::Null);
    });
    rt.register(crate::html::entries).unwrap();
    rt.register(super::entries).unwrap();
    let got: BTreeSet<_> = rt
        .registered()
        .into_iter()
        .map(|(c, k)| (c, format!("{k:?}")))
        .collect();
    let want: BTreeSet<_> = CHANNELS
        .iter()
        .filter(|s| s.batch == Batch::D2)
        .filter(|s| s.name.starts_with("html:") || s.name.starts_with("markdown:"))
        .flat_map(|s| {
            s.kinds
                .iter()
                .filter(|k| **k != ChannelKind::Event)
                .map(move |k| (s.name, format!("{k:?}")))
        })
        .collect();
    assert_eq!(got, want);
}

/// runs `d2/markdown:<what>` as ipc-probe's trigger step does
fn trigger(rt: &mut Rt, what: &str, view: u32, args: serde_json::Value) -> Got<IpcValue> {
    let (got, then) = catch();
    let known = super::probe_trigger(
        what,
        shell_contract::ViewId(view),
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
fn triggers_queue_note_appends_and_run_headless_exports() {
    let mut rt = rt();
    let path = note(&rt, "t.md", "x");
    let v = rt.view(1, Surface::Markdown);
    trigger(&mut rt, "open-view", 1, json!([path]));
    trigger(&mut rt, "queue-note-append", 1, json!([path, "quote"]));
    assert_eq!(rt.events()[0].channel, "markdown:note-append-ready");
    assert_eq!(
        rt.invoke_now("markdown:note-append-take", v, vec![]),
        Ok(IpcValue::Array(vec![s("quote")]))
    );
    let w = rt.view(2, Surface::Markdown);
    let done = trigger(
        &mut rt,
        "export-pdf-headless",
        2,
        json!([path, "/o.pdf", 1000]),
    );
    assert_eq!(
        rt.invoke_now("markdown:consume-headless-export", w, vec![]),
        Ok(s("/o.pdf"))
    );
    rt.advance(Duration::from_millis(1000));
    let error = done.borrow().clone().unwrap().unwrap_err();
    assert_eq!(error.message, "markdown export timed out after 1000ms");
    let renamed = vault(&rt).join("u.md");
    trigger(&mut rt, "file-renamed", 1, json!([path, renamed]));
    assert_eq!(rt.events().last().unwrap().channel, "markdown:file-renamed");
}
