//! The exports: PDF (`docs:export-pdf`, `docs:save-merged-pdf`), HTML,
//! Markdown, Hangul (`docs:export-hwp`), page images (`docs:pick-export-
//! images-target`, `docs:take-export-pdf`, `docs:write-export-image`) and
//! `docs:save-image-as`. A target the renderer names must have been
//! authorized by a dialog first (`pdfWritablePaths`), the export's own or
//! Save As's.

use std::rc::Rc;

use jscompat::node_path::host::{dirname, join};
use jscompat::{JsonValue, base64, buffer_from_base64, encode_uri_component, js_regex};
use main_core::docs::atomic_write::atomic_write_file;
use main_core::docs::hwp_export::{HwpError, HwpFormat, hwp_loss_message_box};
use main_core::docs::lazy_media_inline::{LazyMedia, inline_lazy_media_in_html};
use main_core::docs::print_args::{print_scale_option, valid_print_geometry};
use main_core::docs::save_as_formats::{HwpExportFormat, hwp_export_filters, hwp_export_target};
use main_core::packages::electron_utils::dialog_memory::DialogMemory;
use main_core::packages::electron_utils::hwp_default_format::{
    HwpDefaultFormat, read_hwp_default_format,
};
use main_core::packages::electron_utils::safe_remote_url::Response;
use main_core::packages::electron_utils::save_image::{SaveImageOptions, save_image_from_url};
use shell_contract::hosts::MessageBox;
use shell_contract::ipc::{Reply, Responder};
use shell_contract::{IpcValue, ViewId};

use super::adapters::{HostDialog, Paths, picked_path};
use super::hosts::{DocsEngineHost, basename};
use super::{Docs, Obj, error_text, failed, js_filters, js_obj, js_str, node_text, not_ok};
use crate::kit::{self, Entry, IntoIpc};

/// `TWIPS_PER_INCH`
const TWIPS_PER_INCH: f64 = 1440.0;

/// `MARKDOWN_MEDIA_DIR_TOKEN` of `apps/docs/src/shared/ipc.ts`
const MARKDOWN_MEDIA_DIR_TOKEN: &str = "__seuoffice_media__";

/// `String(value)` of a primitive
fn js_string(v: &IpcValue) -> String {
    match v {
        IpcValue::Undefined => "undefined".into(),
        IpcValue::Null => "null".into(),
        IpcValue::Bool(b) => b.to_string(),
        IpcValue::Number(n) => jscompat::number_to_string(*n),
        IpcValue::String(s) => s.clone(),
        _ => "[object Object]".into(),
    }
}

/// `outPath ?? null`, then the authorization of a path the renderer names:
/// `Ok(None)` asks the export's own dialog
fn named_target(docs: &Docs, view: ViewId, out: &IpcValue) -> Result<Option<String>, IpcValue> {
    match out {
        IpcValue::Undefined | IpcValue::Null => Ok(None),
        IpcValue::String(p) if p.is_empty() => Ok(None),
        IpcValue::String(p) if docs.can_pdf_write(view, p) => Ok(Some(p.clone())),
        _ => Err(failed("export target is not an authorized path")),
    }
}

/// `defaultName.replace(re, '')`: a renderer that sent no string makes the
/// TypeScript throw
fn default_stem(name: &IpcValue, re: &jscompat::JsRegex) -> Result<String, Reply> {
    match name {
        IpcValue::String(s) => Ok(re.replace_all(s, |_| String::new())),
        _ => Err(Err(kit::named_error(
            "TypeError",
            "defaultName.replace is not a function",
        ))),
    }
}

impl Docs {
    /// The export's own save dialog: the picked path, now authorized
    fn export_dialog(
        &self,
        view: ViewId,
        title: &str,
        default_path: String,
        filter: (&str, &str),
    ) -> Option<String> {
        let result = self.save_dialog(
            view,
            js_obj(vec![
                ("title", js_str(self.tm(title))),
                ("defaultPath", js_str(default_path)),
                (
                    "filters",
                    js_filters(&[(filter.0.to_owned(), vec![filter.1])]),
                ),
            ]),
        );
        let path = picked_path(&result, "filePath")?;
        self.allow_pdf_write(view, &path);
        Some(path)
    }
}

/// `readLazyMedia` as `inlineLazyMediaInHtml` reads it
fn lazy_reader(
    engine: &DocsEngineHost,
) -> impl FnMut(&str) -> Result<Option<LazyMedia>, String> + '_ {
    |url| {
        engine.read_lazy_media(url).map(|m| {
            m.map(|m| LazyMedia {
                body: m.body,
                mime: m.mime,
            })
        })
    }
}

/// `writeMarkdownMedia(mdPath, images)`: pictures land in `<file>_files/`;
/// how many were written
fn write_markdown_media(
    engine: &DocsEngineHost,
    md_path: &str,
    images: &[(Option<String>, Option<String>)],
) -> Result<usize, String> {
    if images.is_empty() {
        return Ok(0);
    }
    let stem = js_regex!(r"\.md$", "i").replace_all(&basename(md_path), |_| String::new());
    let dir = join(&[&dirname(md_path), &format!("{stem}_files")]);
    let name_ok = js_regex!(r"^image\d+\.\w+$");
    let data_url = js_regex!(r"^data:image\/[\w.+-]+;base64,(.*)$", "s");
    let mut written = 0;
    for (name, src) in images {
        let (Some(name), Some(src)) = (name, src) else {
            continue;
        };
        if !name_ok.test(name) {
            continue;
        }
        let body = match data_url.exec(src).and_then(|m| m.get(1).map(str::to_owned)) {
            Some(b64) => buffer_from_base64(&b64),
            None => engine
                .read_lazy_media(src)
                .ok()
                .flatten()
                .map(|m| m.body)
                .unwrap_or_default(),
        };
        if body.is_empty() {
            continue;
        }
        if written == 0 {
            std::fs::create_dir_all(&dir)
                .map_err(|e| node_text(&super::fs_error(&e, "mkdir", &dir)))?;
        }
        atomic_write_file(&join(&[&dir, name]), &body).map_err(|e| node_text(&e))?;
        written += 1;
    }
    Ok(written)
}

/// `{ ok: false, error, path }` of a failed export write
fn failed_at(error: String, path: &str) -> IpcValue {
    Obj::new()
        .set("ok", false)
        .set("error", error)
        .set("path", path)
        .done()
}

fn hwp_failed(path: &str, err: &HwpError) -> IpcValue {
    let code = match err {
        HwpError::Failure { code, .. } => code.clone(),
        _ => "failed".into(),
    };
    Obj::new()
        .set("ok", false)
        .set("path", path)
        .set("code", code)
        .set("error", err.text())
        .done()
}

fn canceled() -> IpcValue {
    Obj::new().set("ok", false).set("canceled", true).done()
}

pub(super) fn entries(docs: &Rc<Docs>) -> Vec<Entry> {
    let mut all = Vec::new();

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:export-pdf",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let (w, h, scale) = (
                kit::to_js_json(args.get(1)),
                kit::to_js_json(args.get(2)),
                kit::to_js_json(args.get(4)),
            );
            if !valid_print_geometry(w.as_ref(), h.as_ref(), scale.as_ref()) {
                return responder.reply(Ok(failed("invalid page size or scale")));
            }
            let path = match named_target(&d, view, args.get(3)) {
                Err(reply) => return responder.reply(Ok(reply)),
                Ok(Some(p)) => p,
                Ok(None) => {
                    let stem = match default_stem(args.get(0), js_regex!(r"\.(?:docx|odt)$", "i")) {
                        Ok(s) => s,
                        Err(reply) => return responder.reply(reply),
                    };
                    match d.export_dialog(
                        view,
                        "dlgExportPdf",
                        format!("{stem}.pdf"),
                        ("PDF", "pdf"),
                    ) {
                        Some(p) => p,
                        None => return responder.reply(Ok(not_ok())),
                    }
                }
            };
            let mut options = vec![
                ("printBackground".to_owned(), true.into_ipc()),
                (
                    "pageSize".to_owned(),
                    Obj::new()
                        .set("width", args.num(1).unwrap_or(0.0) / TWIPS_PER_INCH)
                        .set("height", args.num(2).unwrap_or(0.0) / TWIPS_PER_INCH)
                        .done(),
                ),
                (
                    "margins".to_owned(),
                    Obj::new()
                        .set("top", 0.0)
                        .set("bottom", 0.0)
                        .set("left", 0.0)
                        .set("right", 0.0)
                        .done(),
                ),
            ];
            if let Some(scale) = print_scale_option(scale.as_ref()) {
                options.push(("scale".to_owned(), scale.into_ipc()));
            }
            let links = match args.get(5) {
                IpcValue::Array(items) if !items.is_empty() => kit::to_json(args.get(5)),
                _ => None,
            };
            let (contents, engine, target) = (d.contents.clone(), d.engine.clone(), path.clone());
            let d2 = d.clone();
            kit::on_worker(
                &d.services,
                move || -> Result<(), String> {
                    let printed = contents
                        .print_to_pdf(view, IpcValue::Object(options))
                        .map_err(|e| error_text(&e))?;
                    let data = match links {
                        Some(links) => engine
                            .add_pdf_internal_links(printed, links)
                            .map_err(|e| error_text(&e))?,
                        None => printed,
                    };
                    atomic_write_file(&target, &data).map_err(|e| node_text(&e))
                },
                move |result| {
                    responder.reply(Ok(match result {
                        Ok(()) => {
                            if !d2.is_image_temp(view, &path) {
                                d2.open_generated_file(&path);
                            }
                            Obj::new().set("ok", true).set("path", path).done()
                        }
                        // the path stays authorized: the renderer may retry in chunks
                        Err(e) => failed_at(e, &path),
                    }))
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:export-html",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let Some(html) = args.str(1).filter(|h| !h.is_empty()).map(str::to_owned) else {
                return responder.reply(Ok(failed("empty document")));
            };
            let path = match named_target(&d, view, args.get(2)) {
                Err(reply) => return responder.reply(Ok(reply)),
                Ok(Some(p)) => p,
                Ok(None) => {
                    let stem = match default_stem(args.get(0), js_regex!(r"\.(?:docx|odt)$", "i")) {
                        Ok(s) => s,
                        Err(reply) => return responder.reply(reply),
                    };
                    match d.export_dialog(
                        view,
                        "dlgExportHtml",
                        format!("{stem}.html"),
                        ("HTML", "html"),
                    ) {
                        Some(p) => p,
                        None => return responder.reply(Ok(not_ok())),
                    }
                }
            };
            let (engine, target) = (d.engine.clone(), path.clone());
            let d2 = d.clone();
            kit::on_worker(
                &d.services,
                move || -> Result<(), String> {
                    let inlined = inline_lazy_media_in_html(&html, &mut lazy_reader(&engine))
                        .map_err(|e| error_text(&e))?;
                    atomic_write_file(&target, inlined.as_bytes()).map_err(|e| node_text(&e))
                },
                move |result| {
                    responder.reply(Ok(match result {
                        Ok(()) => {
                            d2.open_generated_file(&path);
                            Obj::new().set("ok", true).set("path", path).done()
                        }
                        Err(e) => failed_at(e, &path),
                    }))
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:export-markdown",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let Some(markdown) = args.str(1).filter(|m| !m.is_empty()).map(str::to_owned) else {
                return responder.reply(Ok(failed("empty document")));
            };
            let IpcValue::Array(images) = args.get(2) else {
                return responder.reply(Ok(failed("bad image list")));
            };
            let images: Vec<(Option<String>, Option<String>)> = images
                .iter()
                .map(|i| {
                    (
                        kit::as_str(kit::field(i, "name")).map(str::to_owned),
                        kit::as_str(kit::field(i, "src")).map(str::to_owned),
                    )
                })
                .collect();
            let path = match named_target(&d, view, args.get(3)) {
                Err(reply) => return responder.reply(Ok(reply)),
                Ok(Some(p)) => p,
                Ok(None) => {
                    let stem = match default_stem(args.get(0), js_regex!(r"\.docx$", "i")) {
                        Ok(s) => s,
                        Err(reply) => return responder.reply(reply),
                    };
                    match d.export_dialog(
                        view,
                        "dlgExportMarkdown",
                        format!("{stem}.md"),
                        ("Markdown", "md"),
                    ) {
                        Some(p) => p,
                        None => return responder.reply(Ok(not_ok())),
                    }
                }
            };
            let (engine, target) = (d.engine.clone(), path.clone());
            let d2 = d.clone();
            kit::on_worker(
                &d.services,
                move || -> Result<usize, String> {
                    let written = write_markdown_media(&engine, &target, &images)?;
                    // the destination was escaped before the swap: parentheses must not survive it
                    let stem =
                        js_regex!(r"\.md$", "i").replace_all(&basename(&target), |_| String::new());
                    let media_dir = encode_uri_component(&format!("{stem}_files"))
                        .replace('(', "%28")
                        .replace(')', "%29");
                    let text = markdown
                        .split(&format!("{MARKDOWN_MEDIA_DIR_TOKEN}/"))
                        .collect::<Vec<_>>()
                        .join(&format!("{media_dir}/"));
                    atomic_write_file(&target, text.as_bytes()).map_err(|e| node_text(&e))?;
                    Ok(images.len() - written)
                },
                move |result| {
                    responder.reply(Ok(match result {
                        Ok(dropped) => {
                            d2.open_generated_file(&path);
                            Obj::new()
                                .set("ok", true)
                                .set("path", path)
                                .set("imagesDropped", dropped as f64)
                                .done()
                        }
                        Err(e) => failed_at(e, &path),
                    }))
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:export-hwp",
        move |cx, mut args, responder| {
            let view = cx.sender.view;
            if d.is_torn_down(view) {
                return responder.reply(Ok(not_ok()));
            }
            let out = args.get(2).clone();
            let (Some(name), Some(_)) = (
                args.str(0).map(str::to_owned),
                super::array_buffer(args.get(1)),
            ) else {
                return responder.reply(Ok(bad_hwp_request()));
            };
            let out = match out {
                IpcValue::Undefined | IpcValue::Null => None,
                IpcValue::String(p) => Some(p),
                _ => return responder.reply(Ok(bad_hwp_request())),
            };
            let password_set = args.get(3) == &IpcValue::Bool(true);
            let (path, format) = match out {
                Some(p) => {
                    if !d.can_pdf_write(view, &p) {
                        return responder.reply(Ok(Obj::new()
                            .set("ok", false)
                            .set("code", "unauthorized")
                            .set("error", "export target is not an authorized path")
                            .done()));
                    }
                    let format = if js_regex!(r"\.hwpx$", "i").test(&p) {
                        HwpFormat::Hwpx
                    } else {
                        HwpFormat::Hwp
                    };
                    (p, format)
                }
                None => match d.pick_hwp_path(view, &name) {
                    Some(target) => target,
                    None => return responder.reply(Ok(canceled())),
                },
            };
            let data = args.take(1);
            let engine = d.engine.clone();
            let d2 = d.clone();
            kit::on_worker(
                &d.services,
                move || {
                    let docx = kit::as_bytes(&data).unwrap_or_default().to_vec();
                    let whole = engine
                        .materialize_lazy_docx(docx)
                        .map_err(HwpError::Error)?
                        .bytes;
                    engine.convert_to_hwp(whole, format)
                },
                move |converted| {
                    let conversion = match converted {
                        Err(e) => return responder.reply(Ok(hwp_failed(&path, &e))),
                        Ok(c) => c,
                    };
                    // a closed tab's export writes nothing
                    if d2.is_torn_down(view) {
                        return responder.reply(Ok(canceled()));
                    }
                    if !conversion.losses.is_empty() || password_set {
                        let b = hwp_loss_message_box(&conversion.losses, password_set, d2.lang());
                        let response = d2.message(
                            d2.parent(view),
                            MessageBox {
                                kind: Some(b.kind.into()),
                                title: Some(b.title),
                                message: b.message,
                                detail: Some(b.detail),
                                buttons: b.buttons.to_vec(),
                                default_id: Some(b.default_id as usize),
                                cancel_id: Some(b.cancel_id as usize),
                                checkbox_label: None,
                            },
                        );
                        if response != 0 || d2.is_torn_down(view) {
                            return responder.reply(Ok(canceled()));
                        }
                    }
                    let target = path.clone();
                    let d3 = d2.clone();
                    kit::on_worker(
                        &d2.services,
                        move || atomic_write_file(&target, &conversion.bytes),
                        move |written| {
                            responder.reply(Ok(match written {
                                Err(e) => hwp_failed(&path, &HwpError::Error(e.message)),
                                Ok(()) => {
                                    d3.open_generated_file(&path);
                                    Obj::new().set("ok", true).set("path", path).done()
                                }
                            }))
                        },
                    );
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:save-merged-pdf",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let path = match named_target(&d, view, args.get(2)) {
                Err(reply) => return responder.reply(Ok(reply)),
                Ok(Some(p)) => p,
                Ok(None) => {
                    let stem = match default_stem(args.get(0), js_regex!(r"\.(?:docx|odt)$", "i")) {
                        Ok(s) => s,
                        Err(reply) => return responder.reply(reply),
                    };
                    match d.export_dialog(
                        view,
                        "dlgExportPdf",
                        format!("{stem}.pdf"),
                        ("PDF", "pdf"),
                    ) {
                        Some(p) => p,
                        None => return responder.reply(Ok(not_ok())),
                    }
                }
            };
            let parts: Option<Vec<String>> = match args.get(1) {
                IpcValue::Array(items) => Some(items.iter().map(js_string).collect()),
                _ => None,
            };
            let links = match args.get(3) {
                IpcValue::Array(items) if !items.is_empty() => kit::to_json(args.get(3)),
                _ => None,
            };
            let (engine, target) = (d.engine.clone(), path.clone());
            let d2 = d.clone();
            kit::on_worker(
                &d.services,
                move || -> Result<(), String> {
                    let parts =
                        parts.ok_or_else(|| "TypeError: base64Parts is not iterable".to_owned())?;
                    let parts = parts.iter().map(|b| buffer_from_base64(b)).collect();
                    let merged = engine
                        .merge_pdfs(parts, links)
                        .map_err(|e| error_text(&e))?;
                    atomic_write_file(&target, &merged).map_err(|e| node_text(&e))
                },
                move |result| {
                    responder.reply(Ok(match result {
                        Ok(()) => {
                            if !d2.is_image_temp(view, &path) {
                                d2.open_generated_file(&path);
                            }
                            Obj::new().set("ok", true).set("path", path).done()
                        }
                        Err(e) => failed(e),
                    }))
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke(
        "docs:pick-export-images-target",
        move |cx, _args| {
            let view = cx.sender.view;
            let dir = match &d.test_export_dir {
                Some(dir) => Some(dir.clone()),
                None => {
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
                }
            };
            let Some(dir) = dir else {
                return Ok(IpcValue::Null);
            };
            let pdf_path = join(&[
                &d.temp_dir(),
                &format!("seuoffice-docs-images-{}.pdf", d.shell.random_uuid()),
            ]);
            d.add_image_export(view, &pdf_path, &dir);
            Ok(Obj::new().set("dir", dir).set("pdfPath", pdf_path).done())
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:take-export-pdf",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let taken = args.str(0).filter(|p| {
                d.image_temps
                    .borrow_mut()
                    .get_mut(&view)
                    .is_some_and(|temps| temps.remove(*p))
            });
            let Some(path) = taken.map(str::to_owned) else {
                return responder.reply(Ok(failed("not an image-export temp file")));
            };
            kit::on_worker(
                &d.services,
                move || {
                    let read = std::fs::read(&path)
                        .map_err(|e| node_text(&super::fs_error(&e, "open", &path)));
                    let _ = std::fs::remove_file(&path);
                    read
                },
                move |read| {
                    responder.reply(Ok(match read {
                        Ok(bytes) => Obj::new()
                            .set("ok", true)
                            .set("base64", base64(&bytes))
                            .done(),
                        Err(e) => failed(e),
                    }))
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:write-export-image",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let Some(dir) = args
                .str(0)
                .filter(|dir| {
                    d.image_dirs
                        .with(view, |s| s.is_some_and(|s| s.contains(*dir)))
                })
                .map(str::to_owned)
            else {
                return responder.reply(Ok(failed("export target is not an authorized folder")));
            };
            let Some(name) = args
                .str(1)
                .filter(|n| basename(n) == *n && js_regex!(r"^[^/\\]+\.png$", "i").test(n))
                .map(str::to_owned)
            else {
                return responder.reply(Ok(failed("invalid image file name")));
            };
            let png = js_string(args.get(2));
            kit::on_worker(
                &d.services,
                move || {
                    let path = join(&[&dir, &name]);
                    atomic_write_file(&path, &buffer_from_base64(&png))
                        .map(|()| path)
                        .map_err(|e| node_text(&e))
                },
                move |result| {
                    responder.reply(Ok(match result {
                        Ok(path) => Obj::new().set("ok", true).set("path", path).done(),
                        Err(e) => failed(e),
                    }))
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:save-image-as",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let Some(url) = args
                .str(0)
                .filter(|_| !d.is_torn_down(view))
                .map(str::to_owned)
            else {
                return responder.reply(Ok(not_ok()));
            };
            save_image_as(&d, view, url, responder)
        },
    ));

    all
}

fn bad_hwp_request() -> IpcValue {
    Obj::new()
        .set("ok", false)
        .set("code", "failed")
        .set("error", "bad export request")
        .done()
}

impl Docs {
    /// `pickPath` of `docs:export-hwp`: the Hangul dialog, its pick authorized
    fn pick_hwp_path(&self, view: ViewId, name: &str) -> Option<(String, HwpFormat)> {
        let first = match read_hwp_default_format(&Paths(self.services.paths.as_ref())) {
            HwpDefaultFormat::Hwpx => HwpExportFormat::Hwpx,
            HwpDefaultFormat::Hwp => HwpExportFormat::Hwp,
        };
        let stem = js_regex!(r"\.(?:docx|odt)$", "i").replace_all(name, |_| String::new());
        let filters: Vec<(String, Vec<&str>)> = hwp_export_filters(first, &mut |k| self.tm(k))
            .into_iter()
            .map(|f| (f.name, f.extensions))
            .collect();
        let result = self.save_dialog(
            view,
            js_obj(vec![
                ("title", js_str(self.tm("dlgExportHwp"))),
                ("defaultPath", js_str(format!("{stem}.{}", first.as_str()))),
                ("filters", js_filters(&filters)),
            ]),
        );
        let picked = picked_path(&result, "filePath")?;
        let (path, format) = hwp_export_target(&picked, first);
        self.allow_pdf_write(view, &path);
        Some((
            path,
            match format {
                HwpExportFormat::Hwp => HwpFormat::Hwp,
                HwpExportFormat::Hwpx => HwpFormat::Hwpx,
            },
        ))
    }
}

/// `saveImageFromUrl(dialogParent(event), src, { title, fallbackDir })`: the
/// fetch, the dialog and the write run on a worker (the dialog through the
/// shared host, the memory behind its lock)
fn save_image_as(d: &Rc<Docs>, view: ViewId, url: String, responder: Responder) {
    let (dialogs, shell, memory) = (d.dialogs.clone(), d.shell.clone(), d.memory.clone());
    let parent = d.parent(view);
    let title = d.tm("dlgSaveAs");
    let fallback = d.default_save_dir().ok();
    kit::on_worker(
        &d.services,
        move || {
            let mut memory = memory.lock().unwrap_or_else(|e| e.into_inner());
            let memory: &mut DialogMemory = &mut memory;
            let mut fetch = |u: &str| shell.net_fetch(u).map(|r| r as Box<dyn Response>);
            save_image_from_url(
                memory,
                &mut HostDialog(&dialogs),
                &mut fetch,
                parent.as_ref(),
                &url,
                &SaveImageOptions {
                    title: &title,
                    fallback_dir: fallback.as_deref(),
                },
            )
        },
        move |result| {
            let mut reply = Obj::new().set("ok", result.ok);
            if let Some(path) = result.path {
                reply = reply.set("path", path);
            }
            if let Some(error) = result.error {
                reply = reply.set("error", error);
            }
            responder.reply(Ok(reply.done()))
        },
    );
}
