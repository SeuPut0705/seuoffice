//! Images and attachments in and out, the engine reads of the view's
//! document (page images, previews, text edits, annotation subjects, form
//! fills, compare text), OCR and AI image generation.

use std::rc::Rc;

use jscompat::node_path::host::{basename, dirname, join};
use jscompat::{JsonValue, buffer_from_base64};
use main_core::pdf::export_images::{
    build_export_image_paths, build_save_as_image_paths, has_valid_export_page_numbers,
};
use shell_contract::hosts::FileDialog;
use shell_contract::runtime::PathName;
use shell_contract::{IpcValue, ViewId};

use super::dialogs::{Dlg, options, pdf_filter, props, tm};
use super::{Editor, NOT_GRANTED, failed, read_file, refused, write_file};
use crate::kit::{self, Entry, IntoIpc, as_num, as_str, error, field, is_object, obj};

/// `ocr-page`'s payload cap, in UTF-16 units
const MAX_OCR_PNG_CHARS: usize = 64 * 1024 * 1024;

fn b64_of(v: &IpcValue) -> Vec<u8> {
    buffer_from_base64(&jscompat::value_to_string(kit::to_json(v).as_ref()))
}

impl Editor {
    /// An engine read of the view's document on a worker; a failure rejects
    fn engine_read(
        self: &Rc<Self>,
        view: ViewId,
        path: &str,
        read: impl FnOnce(&dyn super::hosts::PdfEngine, &[u8]) -> Result<IpcValue, String>
        + Send
        + 'static,
        reply: shell_contract::ipc::Responder,
    ) {
        let bytes = self.document_bytes(view, path);
        let engine = self.engine.clone();
        kit::on_worker(
            &self.services,
            move || read(&*engine, &bytes()?),
            move |result| reply.reply(result.map_err(error)),
        );
    }

    /// Compare: a document's per-page text through the pdfium engine
    fn compare_text(
        self: &Rc<Self>,
        file: String,
        password: Option<String>,
        reply: shell_contract::ipc::Responder,
    ) {
        let engine = self.engine.clone();
        kit::on_worker(
            &self.services,
            move || {
                let text = engine.read_pdf_text(&read_file(&file)?, password.as_deref())?;
                Ok((basename(&file, None), text))
            },
            move |result: Result<_, String>| {
                reply.reply(Ok(match result {
                    Ok((name, text)) => obj([
                        ("ok", true.into_ipc()),
                        ("name", name.into_ipc()),
                        ("pageCount", text.page_count.into_ipc()),
                        ("pages", text.pages.into_ipc()),
                    ]),
                    Err(m) => refused(m),
                }))
            },
        );
    }

    /// Writes base64 images to `paths` on a worker, reveals the first, answers
    fn write_images(
        self: &Rc<Self>,
        images: Vec<IpcValue>,
        paths: Vec<String>,
        saved_dir: String,
        reply: shell_contract::ipc::Responder,
    ) {
        let os = self.os.clone();
        let first = paths.first().cloned().unwrap_or_default();
        let count = images.len() as f64;
        kit::on_worker(
            &self.services,
            move || -> Result<(), String> {
                for (b64, path) in images.iter().zip(&paths) {
                    write_file(path, &b64_of(b64))?;
                }
                Ok(())
            },
            move |result| {
                reply.reply(Ok(match result {
                    Ok(()) => {
                        // reveal the exported images so success is never silent
                        os.show_item_in_folder(std::path::Path::new(&first));
                        obj([
                            ("ok", true.into_ipc()),
                            ("savedDir", saved_dir.into_ipc()),
                            ("count", count.into_ipc()),
                        ])
                    }
                    Err(m) => failed(m),
                }))
            },
        );
    }
}

pub(super) fn entries(ed: &Rc<Editor>) -> Vec<Entry> {
    let mut all = Vec::new();

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:export-images",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let images = match field(&request, "images") {
                IpcValue::Array(items) if !items.is_empty() => items.clone(),
                _ => return reply.reply(Ok(failed("pdf: no images"))),
            };
            let page_numbers =
                kit::to_js_json(field(&request, "pageNumbers")).unwrap_or(JsonValue::Null);
            if !has_valid_export_page_numbers(&page_numbers, images.len() as f64) {
                return reply.reply(Ok(failed("pdf: invalid page numbers")));
            }
            let format = as_str(field(&request, "format"));
            if field(&request, "saveAs") == &IpcValue::Bool(true) {
                // Save As > PNG page images: only the name the shell's dialog picked, once
                let target = e.with_view(view, |v| v.image_target.take());
                let paths = match &target {
                    Some(t) => match build_save_as_image_paths(t, images.len() as f64) {
                        Ok(paths) => paths,
                        Err(err) => return reply.reply(Err(kit::named_error("RangeError", err.0))),
                    },
                    None => None,
                };
                let (Some(target), Some(paths)) = (target, paths) else {
                    return reply.reply(Ok(failed("pdf: target not picked for this view")));
                };
                if format == Some("jpg") {
                    return reply.reply(Ok(failed("pdf: target not picked for this view")));
                }
                return e.write_images(images, paths, dirname(&target), reply);
            }
            let ext = if format == Some("jpg") { "jpg" } else { "png" };
            let picked = e.open_with_memory(
                view,
                options(vec![
                    (
                        "title",
                        JsonValue::String(tm(&e.lang(), Dlg::ExportImages).into()),
                    ),
                    ("properties", props(&["openDirectory", "createDirectory"])),
                ]),
            );
            let Some(dir) = picked.into_iter().next().filter(|p| !p.is_empty()) else {
                return reply.reply(Ok(obj([
                    ("ok", true.into_ipc()),
                    ("canceled", true.into_ipc()),
                ])));
            };
            let numbers = match &page_numbers {
                JsonValue::Array(items) => items.clone(),
                _ => Vec::new(),
            };
            let base_name = kit::to_js_json(field(&request, "baseName"));
            match build_export_image_paths(&dir, base_name.as_ref(), &numbers, ext) {
                Ok(paths) => e.write_images(images, paths, dir, reply),
                Err(err) => reply.reply(Ok(failed(err.0))),
            }
        },
    ));

    // the open dialog is main-side; the bytes travel base64
    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:pick-attachment-file",
        move |cx, _, reply| {
            let view = cx.sender.view;
            if !e.registered(view) {
                return reply.reply(Ok(refused("pdf: sender is not a registered PDF view")));
            }
            let picked =
                e.open_with_memory(view, options(vec![("properties", props(&["openFile"]))]));
            let Some(file) = picked.into_iter().next().filter(|p| !p.is_empty()) else {
                return reply.reply(Ok(obj([
                    ("ok", false.into_ipc()),
                    ("cancelled", true.into_ipc()),
                ])));
            };
            kit::on_worker(
                &e.services,
                move || read_file(&file).map(|b| (basename(&file, None), jscompat::base64(&b))),
                move |result| {
                    reply.reply(Ok(match result {
                        Ok((name, b64)) => obj([
                            ("ok", true.into_ipc()),
                            ("name", name.into_ipc()),
                            ("bytesBase64", b64.into_ipc()),
                        ]),
                        Err(m) => refused(m),
                    }))
                },
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:export-attachment",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let Some(path) = e.granted(view, args.get(0)) else {
                return reply.reply(Ok(refused(NOT_GRANTED)));
            };
            let (Some(name), Some(b64)) = (args.str(1), args.str(2)) else {
                return reply.reply(Ok(refused("pdf: malformed export request")));
            };
            let picked = e.dialogs.save(
                e.contents.window_of(view),
                &FileDialog {
                    default_path: Some(join(&[&dirname(&path), name]).into()),
                    ..Default::default()
                },
            );
            let Some(target) = picked
                .map(|p| p.to_string_lossy().into_owned())
                .filter(|p| !p.is_empty())
            else {
                return reply.reply(Ok(obj([
                    ("ok", false.into_ipc()),
                    ("cancelled", true.into_ipc()),
                ])));
            };
            let bytes = buffer_from_base64(b64);
            kit::on_worker(
                &e.services,
                {
                    let target = target.clone();
                    move || write_file(&target, &bytes)
                },
                move |result| {
                    reply.reply(Ok(match result {
                        Ok(()) => obj([("ok", true.into_ipc()), ("targetPath", target.into_ipc())]),
                        Err(m) => refused(m),
                    }))
                },
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:list-page-images",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let Some(path) = e.granted(view, args.get(0)) else {
                return reply.reply(Err(error(NOT_GRANTED)));
            };
            e.engine_read(
                view,
                &path,
                |engine, bytes| engine.list_page_images(bytes),
                reply,
            );
        },
    ));

    // the categories of accepted AI highlights (reading-assist 4.3)
    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:annot-subjects",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let Some(path) = e.granted(view, args.get(0)) else {
                return reply.reply(Err(error(NOT_GRANTED)));
            };
            e.engine_read(
                view,
                &path,
                |engine, bytes| engine.read_annot_subjects(bytes),
                reply,
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:list-static-form-fills",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let Some(path) = e.granted(view, args.get(0)) else {
                return reply.reply(Err(error(NOT_GRANTED)));
            };
            e.engine_read(
                view,
                &path,
                |engine, bytes| engine.read_static_form_fills(bytes),
                reply,
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:page-image-png",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let page_index = as_num(field(&request, "pageIndex"));
            let rect = field(&request, "rect").clone();
            let path = e.granted(view, field(&request, "path"));
            let (Some(path), Some(page_index), IpcValue::Array(_)) = (path, page_index, &rect)
            else {
                return reply.reply(Err(error(NOT_GRANTED)));
            };
            let scale = as_num(field(&request, "scale"))
                .filter(|s| s.is_finite())
                .unwrap_or(1.0);
            e.engine_read(
                view,
                &path,
                move |engine, bytes| engine.render_image_png(bytes, page_index, &rect, scale),
                reply,
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:page-preview-png",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let get = |k| field(&request, k).clone();
            let list_or_none = |v: &IpcValue| matches!(v, IpcValue::Undefined | IpcValue::Array(_));
            let (exclude_annots, exclude_text, clip) =
                (get("excludeAnnots"), get("excludeText"), get("clip"));
            let ok = as_num(&get("pageIndex")).is_some()
                && matches!(get("excludeRects"), IpcValue::Array(_))
                && list_or_none(&exclude_annots)
                && list_or_none(&exclude_text)
                && (is_object(&clip) || clip == IpcValue::Null)
                && as_num(&get("pxWidth")).is_some()
                && as_num(&get("rotate")).is_some();
            let Some(path) = e.granted(view, field(&request, "path")).filter(|_| ok) else {
                return reply.reply(Err(error(NOT_GRANTED)));
            };
            let preview = obj([
                ("pageIndex", get("pageIndex")),
                ("excludeRects", get("excludeRects")),
                ("excludeAnnots", exclude_annots),
                ("excludeText", exclude_text),
                ("clip", clip),
                ("pxWidth", get("pxWidth")),
                ("rotate", get("rotate")),
            ]);
            e.engine_read(
                view,
                &path,
                move |engine, bytes| engine.render_page_preview_png(bytes, &preview),
                reply,
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:validate-text-edits",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let edits = field(&request, "edits").clone();
            let path = e.granted(view, field(&request, "path"));
            let Some(path) = path.filter(|_| matches!(edits, IpcValue::Array(_))) else {
                return reply.reply(Err(error(NOT_GRANTED)));
            };
            e.engine_read(
                view,
                &path,
                move |engine, bytes| engine.validate_text_edits(bytes, &edits),
                reply,
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:can-draw-text",
        move |_, args, reply| {
            let Some(text) = args.str(0).map(str::to_owned) else {
                return reply.reply(Ok(false.into_ipc()));
            };
            let font = args.str(1).map(str::to_owned);
            let (bold, italic) = (args.bool(2) == Some(true), args.bool(3) == Some(true));
            let engine = e.engine.clone();
            kit::on_worker(
                &e.services,
                move || engine.can_draw_text(&text, font.as_deref(), bold, italic),
                move |r| reply.reply(r.map(IntoIpc::into_ipc).map_err(error)),
            );
        },
    ));

    // a bad payload is a failed page ([]), never "no engine" (null)
    let e = ed.clone();
    all.push(kit::invoke_later("pdf:ocr-page", move |_, args, reply| {
        let png = args
            .str(0)
            .filter(|p| !p.is_empty() && p.encode_utf16().count() <= MAX_OCR_PNG_CHARS)
            .map(str::to_owned);
        let Some(png) = png else {
            return reply.reply(Ok(IpcValue::Array(Vec::new())));
        };
        let ocr = e.ocr.clone();
        let env = e.shell.ocr_env();
        kit::on_worker(
            &e.services,
            move || {
                let mut bridge = ocr.lock().unwrap_or_else(|p| p.into_inner());
                bridge.ocr_page_png(&env, &png)
            },
            move |result| {
                reply.reply(match result {
                    Ok(None) => Ok(IpcValue::Null),
                    Ok(Some(lines)) => Ok(IpcValue::Array(
                        lines.iter().map(kit::from_js_json).collect(),
                    )),
                    Err(thrown) => Err(error(thrown.0)),
                })
            },
        );
    }));

    // pdf-owned: slides' ai:generate-image exists only once a slides view does
    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:generate-image",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let op = args.get(0);
            let prompt = match field(op, "prompt") {
                IpcValue::Undefined | IpcValue::Null => String::new(),
                v => jscompat::value_to_string(kit::to_json(v).as_ref()),
            };
            let aspect = field(op, "aspectRatio");
            let aspect = kit::truthy(aspect)
                .then(|| jscompat::value_to_string(kit::to_json(aspect).as_ref()));
            let settings = super::user_data_file(&e, "ai-settings.json");
            let pasted = join(&[&e.path(PathName::Temp), "seuoffice-pasted"]);
            let open = e.open_path(view);
            let engine = e.engine.clone();
            let cancel = cx.cancel.clone();
            kit::on_worker(
                &e.services,
                move || {
                    engine.generate_image(
                        &settings,
                        &prompt,
                        aspect.as_deref(),
                        open.as_deref(),
                        &pasted,
                        &cancel,
                    )
                },
                move |r| reply.reply(r.map_err(error)),
            );
        },
    ));

    // the bytes and the path stay here, the renderer gets text only
    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:compare-read-pdf",
        move |cx, _, reply| {
            let view = cx.sender.view;
            if !e.registered(view) {
                return reply.reply(Ok(refused("pdf: sender is not a registered PDF view")));
            }
            let picked = e.open_with_memory(
                view,
                options(vec![
                    ("filters", pdf_filter(tm(&e.lang(), Dlg::FilterPdf))),
                    ("properties", props(&["openFile"])),
                ]),
            );
            let Some(file) = picked.into_iter().next().filter(|p| !p.is_empty()) else {
                return reply.reply(Ok(obj([
                    ("ok", false.into_ipc()),
                    ("canceled", true.into_ipc()),
                ])));
            };
            e.compare_text(file, None, reply);
        },
    ));

    // the open document's own text through the same engine as the picked side
    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:compare-read-open",
        move |cx, args, reply| {
            let Some(path) = e.granted(cx.sender.view, args.get(0)) else {
                return reply.reply(Ok(refused(NOT_GRANTED)));
            };
            e.compare_text(path, args.str(1).map(str::to_owned), reply);
        },
    ));

    all
}
