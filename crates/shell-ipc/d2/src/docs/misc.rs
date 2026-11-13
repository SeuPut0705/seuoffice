//! The other document invokes: the altChunk HTML conversion, AI media
//! analysis, the page capture, picking a picture, the mail merge's data
//! source and output, copying a picture, and the AI's new documents
//! (`createAiDocument`).

use std::rc::Rc;

use jscompat::node_path::host::join;
use jscompat::{JsonValue, base64, buffer_from_base64, number_to_string};
use main_core::docs::copy_image_guard::{copy_image_display_size, valid_copy_image_data_url};
use main_core::docs::merge_output::{merge_output_file_name, merge_output_path};
use main_core::packages::electron_utils::print_html_pdf::build_printable_html;
use shell_contract::{IpcValue, ViewId};

use super::adapters::picked_path;
use super::hosts::{AnalyzeMediaRequest, basename};
use super::save::{sanitize_file_base, unique_path_in};
use super::{Docs, Obj, js_filters, js_obj, js_str};
use crate::kit::{self, Entry, IntoIpc};

/// `ALT_CHUNK_HTML_MAX_CHARS`
const ALT_CHUNK_HTML_MAX_CHARS: usize = 64 * 1024 * 1024;
/// `ALT_CHUNK_TIMEOUT_MS`
const ALT_CHUNK_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(120_000);

/// `Buffer.from(data)`'s refusal of a value that is no buffer (its message)
const NOT_A_BUFFER: &str = "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received undefined";

/// `String(value)` of a primitive (an object is `[object Object]`)
fn js_string(v: &IpcValue) -> String {
    match v {
        IpcValue::Undefined => "undefined".into(),
        IpcValue::Null => "null".into(),
        IpcValue::Bool(b) => b.to_string(),
        IpcValue::Number(n) => number_to_string(*n),
        IpcValue::String(s) => s.clone(),
        IpcValue::Array(items) => items
            .iter()
            .map(|i| match i {
                IpcValue::Undefined | IpcValue::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => "[object Object]".into(),
    }
}

/// `value ?? fallback` then `String(...)`
fn js_string_or(v: &IpcValue, fallback: &str) -> String {
    match v {
        IpcValue::Undefined | IpcValue::Null => fallback.to_owned(),
        other => js_string(other),
    }
}

/// `<img>` attribute text of the copy's layout meta
fn escape_attr(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
}

pub(super) fn entries(docs: &Rc<Docs>) -> Vec<Entry> {
    let mut all = Vec::new();

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:altchunk-html-to-docx",
        move |_cx, args, responder| {
            let Some(html) = args
                .str(0)
                .filter(|h| {
                    !jscompat::trim(h).is_empty()
                        && h.encode_utf16().count() <= ALT_CHUNK_HTML_MAX_CHARS
                })
                .map(str::to_owned)
            else {
                return responder.reply(Ok(IpcValue::Null));
            };
            let engine = d.engine.clone();
            let prefix = join(&[&d.temp_dir(), "seuoffice-altchunk-"]);
            kit::on_worker(
                &d.services,
                move || {
                    let dir = main_core::node_fs::mkdtemp_random(&prefix).ok()?;
                    let page = join(&[&dir, "chunk.html"]);
                    // the BOM outranks a stale <meta charset> left in the decoded markup
                    let docx = std::fs::write(&page, format!("\u{feff}{html}"))
                        .ok()
                        .and_then(|()| {
                            engine.html_to_docx(&page, ALT_CHUNK_TIMEOUT).ok().flatten()
                        });
                    let _ = std::fs::remove_dir_all(&dir);
                    docx
                },
                move |docx| responder.reply(Ok(docx.map_or(IpcValue::Null, kit::u8_array))),
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:analyze-media",
        move |cx, args, responder| {
            let op = args.get(0);
            if matches!(op, IpcValue::Undefined | IpcValue::Null) {
                let what = if op == &IpcValue::Null {
                    "null"
                } else {
                    "undefined"
                };
                return responder.reply(Err(kit::named_error(
                    "TypeError",
                    format!("Cannot read properties of {what} (reading 'mediaUrls')"),
                )));
            }
            let media_urls: Vec<String> = match kit::field(op, "mediaUrls") {
                IpcValue::Undefined | IpcValue::Null => Vec::new(),
                IpcValue::Array(items) => items
                    .iter()
                    .map(js_string)
                    .filter(|u| !u.is_empty())
                    .collect(),
                _ => {
                    return responder.reply(Err(kit::named_error(
                        "TypeError",
                        "(op.mediaUrls ?? []).map is not a function",
                    )));
                }
            };
            let request = AnalyzeMediaRequest {
                settings_path: d.user_data(&["ai-settings.json"]),
                media_urls,
                requirements: js_string_or(kit::field(op, "requirements"), ""),
                open_doc: d.open_doc.get(cx.sender.view),
                pasted_dir: join(&[&d.temp_dir(), "seuoffice-pasted"]),
            };
            let engine = d.engine.clone();
            let cancel = cx.cancel.clone();
            kit::on_worker(
                &d.services,
                move || {
                    // a lazily served picture is only addressable by this process: hand its bytes over
                    let resolved = request
                        .media_urls
                        .iter()
                        .map(|url| match engine.read_lazy_media(url).ok().flatten() {
                            Some(m) => format!("data:{};base64,{}", m.mime, base64(&m.body)),
                            None => url.clone(),
                        })
                        .collect();
                    engine.analyze_media(
                        AnalyzeMediaRequest {
                            media_urls: resolved,
                            ..request
                        },
                        cancel,
                    )
                },
                move |result| {
                    responder.reply(match result {
                        Ok(v) => Ok(kit::from_json(&v)),
                        Err(m) => Err(kit::error(m)),
                    })
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:capture-rect",
        move |cx, args, responder| {
            let view = cx.sender.view;
            if d.is_torn_down(view) || !d.alive(view) {
                return responder.reply(Ok(IpcValue::Null));
            }
            let rect = args.get(0);
            let nums: Vec<f64> = ["x", "y", "width", "height"]
                .iter()
                .filter_map(|k| kit::as_num(kit::field(rect, k)).filter(|n| n.is_finite()))
                .collect();
            let [x, y, width, height] = nums[..] else {
                return responder.reply(Ok(IpcValue::Null));
            };
            if !(1.0..=20000.0).contains(&width) || !(1.0..=20000.0).contains(&height) {
                return responder.reply(Ok(IpcValue::Null));
            }
            let shell = d.shell.clone();
            kit::on_worker(
                &d.services,
                move || {
                    shell
                        .capture_rect(
                            view,
                            x.floor().max(0.0),
                            y.floor().max(0.0),
                            width.ceil(),
                            height.ceil(),
                        )
                        .ok()
                        .flatten()
                },
                move |png| responder.reply(Ok(png.map_or(IpcValue::Null, kit::u8_array))),
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:pick-image",
        move |cx, _args, responder| {
            let result = d.open_dialog(
                cx.sender.view,
                js_obj(vec![
                    ("title", js_str(d.tm("dlgInsertImage"))),
                    (
                        "filters",
                        js_filters(&[(d.tm("filterImages"), vec!["png", "jpg", "jpeg", "gif"])]),
                    ),
                    ("properties", JsonValue::Array(vec![js_str("openFile")])),
                ]),
            );
            let Some(path) = picked_path(&result, "filePaths") else {
                return responder.reply(Ok(IpcValue::Null));
            };
            let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
            let mime = match ext.as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                _ => return responder.reply(Ok(IpcValue::Null)),
            };
            kit::on_worker(
                &d.services,
                move || {
                    std::fs::read(&path)
                        .map(|b| (base64(&b), path.clone()))
                        .map_err(|e| super::fs_error(&e, "open", &path).message)
                },
                move |read| {
                    responder.reply(match read {
                        Ok((b64, path)) => Ok(Obj::new()
                            .set("base64", b64)
                            .set("mime", mime)
                            .set("name", basename(&path))
                            .done()),
                        Err(m) => Err(kit::error(m)),
                    })
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:merge-data-source",
        move |cx, _args, responder| {
            let result = d.open_dialog(
                cx.sender.view,
                js_obj(vec![
                    ("title", js_str(d.tm("dlgMergeDataSource"))),
                    (
                        "filters",
                        js_filters(&[(d.tm("filterMergeDataSource"), vec!["xlsx", "csv"])]),
                    ),
                    ("properties", JsonValue::Array(vec![js_str("openFile")])),
                ]),
            );
            let Some(path) = picked_path(&result, "filePaths") else {
                return responder.reply(Ok(IpcValue::Null));
            };
            let engine = d.engine.clone();
            kit::on_worker(
                &d.services,
                move || engine.read_merge_data_source(&path),
                move |source| {
                    responder.reply(Ok(match source {
                        Ok(v) => Obj::new()
                            .set("ok", true)
                            .set("source", kit::from_json(&v))
                            .done(),
                        Err(e) => super::failed(e),
                    }))
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:merge-output",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let request = args.get(0);
            let files: Vec<(String, Option<Vec<u8>>)> = match kit::field(request, "files") {
                IpcValue::Array(items) => items
                    .iter()
                    .map(|f| {
                        (
                            js_string(kit::field(f, "name")),
                            kit::as_bytes(kit::field(f, "data")).map(<[u8]>::to_vec),
                        )
                    })
                    .collect(),
                _ => Vec::new(),
            };
            if files.is_empty() {
                return responder.reply(Ok(super::failed("nothing to write")));
            }
            let canceled = || Obj::new().set("ok", false).set("canceled", true).done();
            let mode = kit::as_str(kit::field(request, "mode"));
            let single = matches!(mode, Some("single" | "labels"));
            let place = if single {
                let name = merge_output_file_name(&files[0].0);
                let result = d.save_dialog(
                    view,
                    js_obj(vec![
                        ("title", js_str(d.tm("dlgSaveAs"))),
                        ("defaultPath", js_str(name)),
                        ("filters", js_filters(&[(d.tm("filterWord"), vec!["docx"])])),
                    ]),
                );
                picked_path(&result, "filePath")
            } else {
                let result = d.open_dialog(
                    view,
                    js_obj(vec![
                        ("title", js_str(d.tm("dlgPickExportDir"))),
                        (
                            "properties",
                            JsonValue::Array(vec![
                                js_str("openDirectory"),
                                js_str("createDirectory"),
                            ]),
                        ),
                    ]),
                );
                picked_path(&result, "filePaths")
            };
            let Some(place) = place else {
                return responder.reply(Ok(canceled()));
            };
            let engine = d.engine.clone();
            kit::on_worker(
                &d.services,
                move || -> Result<IpcValue, String> {
                    // the merged file is a document of its own: its lazy pictures go in
                    let write = |path: &str, data: Option<Vec<u8>>| -> Result<(), String> {
                        let bytes = engine
                            .materialize_lazy_docx(data.ok_or(NOT_A_BUFFER)?)?
                            .bytes;
                        std::fs::write(path, bytes)
                            .map_err(|e| super::fs_error(&e, "open", path).message)
                    };
                    if single {
                        let (_, data) = files.into_iter().next().unwrap_or_default();
                        write(&place, data)?;
                        return Ok(Obj::new()
                            .set("ok", true)
                            .set("path", place)
                            .set("count", 1.0)
                            .done());
                    }
                    let count = files.len();
                    for (name, data) in files {
                        write(&merge_output_path(&place, &name), data)?;
                    }
                    Ok(Obj::new()
                        .set("ok", true)
                        .set("folder", place)
                        .set("count", count as f64)
                        .done())
                },
                move |result| responder.reply(Ok(result.unwrap_or_else(super::failed))),
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:copy-image-to-clipboard",
        move |_cx, args, responder| {
            let url = kit::to_js_json(args.get(0));
            if !valid_copy_image_data_url(url.as_ref()) {
                return responder.reply(Ok(false.into_ipc()));
            }
            let url = args.str(0).unwrap_or("").to_owned();
            let meta = args.str(1).map(str::to_owned);
            let (engine, shell) = (d.engine.clone(), d.shell.clone());
            kit::on_worker(
                &d.services,
                move || {
                    let (bytes, html_src) = if url.starts_with("data:image/") {
                        let comma = url.find(',').map_or(0, |c| c + 1);
                        (buffer_from_base64(&url[comma..]), url.clone())
                    } else {
                        let Some(media) = engine.read_lazy_media(&url).ok().flatten() else {
                            return false;
                        };
                        // another document cannot resolve this document's lazy URL: inline the bytes
                        let src = format!("data:{};base64,{}", media.mime, base64(&media.body));
                        (media.body, src)
                    };
                    let Some((mut width, mut height)) = shell.image_size(&bytes) else {
                        return false;
                    };
                    let mut meta_attr = String::new();
                    if let Some(meta) = meta.filter(|m| m.encode_utf16().count() <= 2048) {
                        let size = copy_image_display_size(Some(&JsonValue::String(meta.clone())));
                        width = size.width.unwrap_or(width);
                        height = size.height.unwrap_or(height);
                        meta_attr = format!(" data-image-meta=\"{}\"", escape_attr(&meta));
                    }
                    let html = format!(
                        "<img src=\"{html_src}\" width=\"{}\" height=\"{}\"{meta_attr}>",
                        number_to_string(width),
                        number_to_string(height)
                    );
                    shell.write_clipboard_image(&bytes, &html);
                    true
                },
                move |ok| responder.reply(Ok(ok.into_ipc())),
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:create-document",
        move |cx, args, responder| {
            d.create_ai_document(
                args.get(0),
                cx.sender.view,
                Box::new(move |v| responder.reply(Ok(v))),
            );
        },
    ));

    all
}

impl Docs {
    /// `createAiDocument(request, ownerWebContentsId)`: a docx goes to a new
    /// blank tab that builds it; pdf, md and html are written here, into the
    /// owner's project folder when its panel has one
    pub(crate) fn create_ai_document(
        self: &Rc<Self>,
        request: &IpcValue,
        owner: ViewId,
        then: Box<dyn FnOnce(IpcValue)>,
    ) {
        let kind = kit::field(request, "type").clone();
        let title = sanitize_file_base(&js_string_or(kit::field(request, "title"), ""));
        let content = js_string_or(kit::field(request, "content"), "");
        if jscompat::trim(&content).is_empty() {
            return then(super::failed("content must not be empty"));
        }
        let ext = match kit::as_str(&kind) {
            Some("docx") => {
                let payload = serde_json::json!({ "title": title, "html": content });
                self.shell.open_ai_doc_tab(payload, owner);
                return then(Obj::new().set("ok", true).done());
            }
            Some(ext @ ("pdf" | "md" | "html")) => ext.to_owned(),
            _ => {
                return then(super::failed(format!(
                    "unsupported document type: {}",
                    js_string(&kind)
                )));
            }
        };
        let shell = self.shell.clone();
        let docs = Rc::clone(self);
        let file_name = format!("{title}.{ext}");
        let name = file_name.clone();
        // placeAiDocument first; the default folder only when nothing placed it
        kit::on_worker(
            &self.services,
            move || -> Result<(Vec<u8>, Option<String>), String> {
                let bytes = if ext == "pdf" {
                    shell.print_html_to_pdf(build_printable_html(&title, &content))?
                } else {
                    content.into_bytes()
                };
                match shell.write_new_document(owner, &name, bytes.clone()) {
                    Some(Ok(Some(placed))) => Ok((bytes, Some(placed))),
                    Some(Err(e)) => Err(e),
                    None | Some(Ok(None)) => Ok((bytes, None)),
                }
            },
            move |made| {
                let bytes = match made {
                    Err(e) => return then(super::failed(e)),
                    Ok((_, Some(placed))) => return docs.ai_document_written(Ok(placed), then),
                    Ok((bytes, None)) => bytes,
                };
                let dir = match docs.default_save_dir() {
                    Ok(dir) => dir,
                    Err(e) => return then(super::failed(e)),
                };
                let d = docs.clone();
                kit::on_worker(
                    &docs.services,
                    move || {
                        let path = unique_path_in(&dir, &file_name);
                        std::fs::write(&path, bytes)
                            .map(|()| path.clone())
                            .map_err(|e| super::fs_error(&e, "open", &path).message)
                    },
                    move |written| d.ai_document_written(written, then),
                );
            },
        );
    }

    /// `openGeneratedFile(filePath)` and the answer of `createAiDocument`
    fn ai_document_written(
        &self,
        written: Result<String, String>,
        then: Box<dyn FnOnce(IpcValue)>,
    ) {
        then(match written {
            Ok(path) => {
                self.open_generated_file(&path);
                Obj::new().set("ok", true).set("path", path).done()
            }
            Err(e) => super::failed(e),
        })
    }
}
