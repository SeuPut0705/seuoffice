//! Page operations on the saved file: in place through `writeOwnFile`
//! (insert, paste, blank page, replace, page size, crop), or into a new
//! generated file (extract, split, merge, merge pages, split pages, reduce
//! size), and the app-wide page clipboard.

use std::rc::Rc;
use std::sync::Arc;

use jscompat::node_path::host::join;
use jscompat::{JsonValue, value_to_string};
use main_core::packages::electron_utils::dialog_memory::show_open_dialog_with_memory;
use main_core::pdf::atomic_write::write_pdf_atomically;
use main_core::pdf::generated_output::{exists_sync, unique_generated_pdf_path};
use shell_contract::hosts::{FileDialog, FileFilter};
use shell_contract::{IpcValue, ViewId};

use super::dialogs::{Dlg, Files, options, pdf_filter, picked_paths, props, tm};
use super::editors::stem;
use super::recovery::pdf_looks_encrypted;
use super::{Editor, NOT_GRANTED, failed, read_file, refused, write_file};
use crate::kit::{self, Entry, IntoIpc, as_num, field, obj, truthy};

/// `copiedPagesOf`'s answer: the pages' PDF and their count, or no pages
type Copied = Option<(Vec<u8>, f64)>;

/// `MAX_MERGE_TOTAL_BYTES`
const MAX_MERGE_TOTAL_BYTES: f64 = 1_073_741_824.0;

fn canceled() -> IpcValue {
    obj([("ok", true.into_ipc()), ("canceled", true.into_ipc())])
}

fn protected() -> IpcValue {
    obj([
        ("ok", false.into_ipc()),
        ("error", "pdf: protected".into_ipc()),
        ("protected", true.into_ipc()),
    ])
}

/// `String(value)`
fn js_string(v: &IpcValue) -> String {
    value_to_string(kit::to_json(v).as_ref())
}

/// `typeof v === 'number' ? v : -1`
fn after_index(v: &IpcValue) -> f64 {
    as_num(v).unwrap_or(-1.0)
}

/// `readMergeInputs(basePath, pickedPaths)`: sizes summed before anything
/// is read, then the picked files one at a time, then the base
pub(super) fn read_merge_inputs(
    base: &str,
    picked: &[String],
) -> Result<(Vec<u8>, Vec<Vec<u8>>), String> {
    let as_mb = |bytes: f64| (bytes / (1024.0 * 1024.0)).round();
    let mut total = 0.0;
    for input in std::iter::once(base).chain(picked.iter().map(String::as_str)) {
        let meta = std::fs::metadata(main_core::node_fs::namespaced(input))
            .map_err(|e| main_core::node_fs::node_error(&e, "stat", input).message)?;
        total += meta.len() as f64;
        if total > MAX_MERGE_TOTAL_BYTES {
            return Err(format!(
                "pdf: merge too large \u{2014} the selected files total {} MB, over the {} MB merge limit",
                as_mb(total),
                as_mb(MAX_MERGE_TOTAL_BYTES)
            ));
        }
    }
    let others = picked
        .iter()
        .map(|p| read_file(p))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((read_file(base)?, others))
}

impl Editor {
    /// `showOpenDialogWithMemory(dialog, win, options)`: the picked paths
    pub(super) fn open_with_memory(
        &self,
        view: ViewId,
        options: jscompat::JsObject<JsonValue>,
    ) -> Vec<String> {
        let parent = self.contents.window_of(view);
        let mut memory = std::mem::take(&mut self.st.borrow_mut().memory);
        let result = show_open_dialog_with_memory(
            &mut memory,
            &mut Files(&*self.dialogs),
            parent.as_ref(),
            &options,
            None,
        );
        self.st.borrow_mut().memory = memory;
        picked_paths(&result)
    }

    /// `uniqueGeneratedPdfPath(configuredDefaultSaveDir(app), String(name || fallback))`
    fn generated_path(&self, suggested: &IpcValue, fallback: &str) -> Result<String, String> {
        let dir = self.default_save_dir()?;
        let name = if truthy(suggested) {
            js_string(suggested)
        } else {
            fallback.to_owned()
        };
        unique_generated_pdf_path(&dir, Some(&JsonValue::String(name)), &exists_sync)
            .map_err(|e| e.0)
    }

    /// An operation on the file's bytes whose result replaces the file, as this view
    fn rewrite<T: Send + 'static>(
        self: &Rc<Self>,
        view: ViewId,
        path: String,
        op: impl FnOnce(Vec<u8>) -> Result<(Vec<u8>, T), Result<IpcValue, String>> + Send + 'static,
        answer: impl FnOnce(T) -> IpcValue + 'static,
        reply: shell_contract::ipc::Responder,
    ) {
        let ed = self.clone();
        let p = path.clone();
        kit::on_worker(
            &self.services,
            move || read_file(&p).map_err(Err).and_then(op),
            move |result| match result {
                Ok((bytes, extra)) => {
                    let target = path.clone();
                    ed.write_own_file(
                        view,
                        &path,
                        move || write_pdf_atomically(&target, &bytes).map_err(|e| e.message),
                        move |written| {
                            reply.reply(Ok(match written {
                                Ok(()) => answer(extra),
                                Err(m) => failed(m),
                            }))
                        },
                    )
                }
                Err(Ok(early)) => reply.reply(Ok(early)),
                Err(Err(m)) => reply.reply(Ok(failed(m))),
            },
        );
    }

    /// An operation that writes a new generated PDF and opens it
    fn generate(
        self: &Rc<Self>,
        path: String,
        suggested: IpcValue,
        fallback: &'static str,
        op: impl FnOnce(Vec<u8>) -> Result<Vec<u8>, String> + Send + 'static,
        reply: shell_contract::ipc::Responder,
    ) {
        let ed = self.clone();
        kit::on_worker(
            &self.services,
            move || read_file(&path).and_then(op),
            move |bytes| {
                let result = bytes.and_then(|bytes| {
                    let target = ed.generated_path(&suggested, fallback)?;
                    write_file(&target, &bytes)?;
                    Ok(target)
                });
                match result {
                    Ok(target) => {
                        ed.open_generated_pdf(&target);
                        reply.reply(Ok(obj([
                            ("ok", true.into_ipc()),
                            ("savedPath", target.into_ipc()),
                        ])))
                    }
                    Err(m) => reply.reply(Ok(failed(m))),
                }
            },
        );
    }
}

pub(super) fn entries(ed: &Rc<Editor>) -> Vec<Entry> {
    let mut all = Vec::new();

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:extract-pages",
        move |cx, mut args, reply| {
            let request = args.take(0);
            let pages = field(&request, "pages").clone();
            let path = e.granted(cx.sender.view, field(&request, "path"));
            let Some(path) = path.filter(|_| matches!(pages, IpcValue::Array(_))) else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            let engine = e.engine.clone();
            let suggested = field(&request, "suggestedName").clone();
            e.generate(
                path,
                suggested,
                "pages.pdf",
                move |b| engine.extract_pages(&b, &pages),
                reply,
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:insert-pdf",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let Some(path) = e.granted(view, field(&request, "path")) else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            let lang = e.lang();
            let picked = e.open_with_memory(
                view,
                options(vec![
                    ("title", JsonValue::String(tm(&lang, Dlg::Insert).into())),
                    ("filters", pdf_filter(tm(&lang, Dlg::FilterPdf))),
                    ("properties", props(&["openFile"])),
                ]),
            );
            let Some(other) = picked.into_iter().next().filter(|p| !p.is_empty()) else {
                return reply.reply(Ok(canceled()));
            };
            let after = after_index(field(&request, "afterPageIndex"));
            let engine = e.engine.clone();
            e.rewrite(
                view,
                path,
                move |target| {
                    let other = read_file(&other).map_err(Err)?;
                    engine.insert_pdf(&target, &other, after).map_err(Err)
                },
                |count| obj([("ok", true.into_ipc()), ("insertedCount", count.into_ipc())]),
                reply,
            );
        },
    ));

    // the copied pages stay here, so a paste in any PDF view reads no path from the renderer
    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:copy-pages",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let source = field(&request, "source").clone();
            let pages = field(&request, "pages").clone();
            let path = e.granted(view, field(&source, "path"));
            let Some(path) = path.filter(|_| {
                field(&source, "targetPath") == &IpcValue::Undefined
                    && matches!(pages, IpcValue::Array(_))
            }) else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            if super::save::carries_protection(&source) {
                return reply.reply(Ok(protected()));
            }
            let read = e.document_bytes(view, &path);
            let engine = e.engine.clone();
            let ed = e.clone();
            kit::on_worker(
                &e.services,
                move || -> Result<Option<Copied>, String> {
                    let bytes = read()?;
                    if pdf_looks_encrypted(&bytes) {
                        return Ok(None);
                    }
                    engine.copied_pages_of(&bytes, &source, &pages).map(Some)
                },
                move |result| {
                    reply.reply(Ok(match result {
                        Ok(None) => protected(),
                        Ok(Some(None)) => failed("pdf: no such pages"),
                        Ok(Some(Some((bytes, count)))) => {
                            ed.st.borrow_mut().held = Some((Arc::new(bytes), count));
                            obj([("ok", true.into_ipc()), ("count", count.into_ipc())])
                        }
                        Err(m) => failed(m),
                    }))
                },
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:paste-pages",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let Some(path) = e.granted(view, field(&request, "path")) else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            let Some((held, _)) = e.st.borrow().held.clone() else {
                return reply.reply(Ok(obj([
                    ("ok", true.into_ipc()),
                    ("insertedCount", 0.0.into_ipc()),
                ])));
            };
            let after = after_index(field(&request, "afterPageIndex"));
            let engine = e.engine.clone();
            e.rewrite(
                view,
                path,
                move |target| {
                    if pdf_looks_encrypted(&target) {
                        return Err(Ok(protected()));
                    }
                    engine.insert_pdf(&target, &held, after).map_err(Err)
                },
                |count| obj([("ok", true.into_ipc()), ("insertedCount", count.into_ipc())]),
                reply,
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke("pdf:copied-page-count", move |cx, _| {
        let count = if e.registered(cx.sender.view) {
            e.st.borrow().held.as_ref().map_or(0.0, |(_, n)| *n)
        } else {
            0.0
        };
        Ok(count.into_ipc())
    }));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:insert-blank-page",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let Some(path) = e.granted(view, field(&request, "path")) else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            let after = after_index(field(&request, "afterPageIndex"));
            let engine = e.engine.clone();
            e.rewrite(
                view,
                path,
                move |b| {
                    engine
                        .insert_blank_page(&b, after)
                        .map(|b| (b, ()))
                        .map_err(Err)
                },
                |()| obj([("ok", true.into_ipc())]),
                reply,
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:split-pdf",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let Some(path) = e.granted(view, field(&request, "path")) else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            let picked = e.open_with_memory(
                view,
                options(vec![
                    ("title", JsonValue::String(tm(&e.lang(), Dlg::Split).into())),
                    ("properties", props(&["openDirectory", "createDirectory"])),
                ]),
            );
            let Some(dir) = picked.into_iter().next().filter(|p| !p.is_empty()) else {
                return reply.reply(Ok(canceled()));
            };
            let chunk = as_num(field(&request, "chunkSize")).unwrap_or(1.0);
            let base_name = field(&request, "baseName");
            let base = if truthy(base_name) {
                js_string(base_name)
            } else {
                "split".into()
            };
            let safe: String = base
                .chars()
                .map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c })
                .collect();
            let engine = e.engine.clone();
            let os = e.os.clone();
            let first = join(&[&dir, &format!("{safe}-1.pdf")]);
            let saved_dir = dir.clone();
            kit::on_worker(
                &e.services,
                move || -> Result<f64, String> {
                    let parts = engine.split_pdf(&read_file(&path)?, chunk)?;
                    for (i, bytes) in parts.iter().enumerate() {
                        write_file(&join(&[&dir, &format!("{safe}-{}.pdf", i + 1)]), bytes)?;
                    }
                    Ok(parts.len() as f64)
                },
                move |result| {
                    reply.reply(Ok(match result {
                        Ok(count) => {
                            // many files: no tabs, reveal them so success is never silent
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
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:merge-pdf",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let Some(path) = e.granted(view, field(&request, "path")) else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            let lang = e.lang();
            let picked = e.open_with_memory(
                view,
                options(vec![
                    ("title", JsonValue::String(tm(&lang, Dlg::Merge).into())),
                    ("filters", pdf_filter(tm(&lang, Dlg::FilterPdf))),
                    ("properties", props(&["openFile", "multiSelections"])),
                ]),
            );
            if picked.is_empty() {
                return reply.reply(Ok(canceled()));
            }
            let engine = e.engine.clone();
            let ed = e.clone();
            let suggested = field(&request, "suggestedName").clone();
            kit::on_worker(
                &e.services,
                move || {
                    let (base, others) = read_merge_inputs(&path, &picked)?;
                    engine.merge_pdf(&base, &others)
                },
                move |merged| {
                    let result = merged.and_then(|(bytes, appended)| {
                        let target = ed.generated_path(&suggested, "merged.pdf")?;
                        write_file(&target, &bytes)?;
                        Ok((target, appended))
                    });
                    reply.reply(Ok(match result {
                        Ok((target, appended)) => {
                            ed.open_generated_pdf(&target);
                            obj([
                                ("ok", true.into_ipc()),
                                ("savedPath", target.into_ipc()),
                                ("appendedCount", appended.into_ipc()),
                            ])
                        }
                        Err(m) => failed(m),
                    }))
                },
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:merge-pages",
        move |cx, mut args, reply| {
            let request = args.take(0);
            let Some(path) = e.granted(cx.sender.view, field(&request, "path")) else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            let per_sheet = as_num(field(&request, "perSheet"))
                .filter(|n| n.fract() == 0.0 && (2.0..=16.0).contains(n));
            let Some(per_sheet) = per_sheet else {
                return reply.reply(Ok(failed("pdf: pages-per-sheet must be 2-16")));
            };
            let horizontal = kit::as_str(field(&request, "direction")) == Some("horizontal");
            let separator = field(&request, "separator") == &IpcValue::Bool(true);
            let engine = e.engine.clone();
            let suggested = field(&request, "suggestedName").clone();
            e.generate(
                path,
                suggested,
                "merged-pages.pdf",
                move |b| engine.merge_pages(&b, per_sheet, horizontal, separator),
                reply,
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:replace-pages",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let pages = field(&request, "pages").clone();
            let path = e.granted(view, field(&request, "path"));
            let Some(path) = path.filter(|_| matches!(&pages, IpcValue::Array(p) if !p.is_empty()))
            else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            let lang = e.lang();
            let picked = e.open_with_memory(
                view,
                options(vec![
                    ("title", JsonValue::String(tm(&lang, Dlg::Replace).into())),
                    ("filters", pdf_filter(tm(&lang, Dlg::FilterPdf))),
                    ("properties", props(&["openFile"])),
                ]),
            );
            let Some(other) = picked.into_iter().next().filter(|p| !p.is_empty()) else {
                return reply.reply(Ok(canceled()));
            };
            let engine = e.engine.clone();
            e.rewrite(
                view,
                path,
                move |target| {
                    let other = read_file(&other).map_err(Err)?;
                    engine
                        .replace_pages(&target, &other, &pages)
                        .map(|(b, removed, inserted)| (b, (removed, inserted)))
                        .map_err(Err)
                },
                |(removed, inserted)| {
                    obj([
                        ("ok", true.into_ipc()),
                        ("removed", removed),
                        ("inserted", inserted),
                    ])
                },
                reply,
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:set-page-size",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let Some(path) = e.granted(view, field(&request, "path")) else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            let positive = |k| as_num(field(&request, k)).filter(|n| n.is_finite() && *n > 0.0);
            let (Some(width), Some(height)) = (positive("width"), positive("height")) else {
                return reply.reply(Ok(failed("pdf: invalid page size")));
            };
            let engine = e.engine.clone();
            e.rewrite(
                view,
                path,
                move |b| {
                    engine
                        .set_page_size(&b, width, height)
                        .map(|b| (b, ()))
                        .map_err(Err)
                },
                |()| obj([("ok", true.into_ipc())]),
                reply,
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:split-pages",
        move |cx, mut args, reply| {
            let request = args.take(0);
            let Some(path) = e.granted(cx.sender.view, field(&request, "path")) else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            let Some(per_page) =
                as_num(field(&request, "perPage")).filter(|n| [2.0, 4.0, 9.0].contains(n))
            else {
                return reply.reply(Ok(failed("pdf: unsupported split grid")));
            };
            let engine = e.engine.clone();
            let suggested = field(&request, "suggestedName").clone();
            e.generate(
                path,
                suggested,
                "split-pages.pdf",
                move |b| engine.split_pages(&b, per_page),
                reply,
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:crop-pages",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let pages = field(&request, "pages").clone();
            let rect = field(&request, "rect").clone();
            let path = e.granted(view, field(&request, "path"));
            let ok = matches!(&pages, IpcValue::Array(p) if !p.is_empty()) && truthy(&rect);
            let Some(path) = path.filter(|_| ok) else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            let engine = e.engine.clone();
            e.rewrite(
                view,
                path,
                move |b| {
                    engine
                        .crop_pages(&b, &pages, &rect)
                        .map(|b| (b, ()))
                        .map_err(Err)
                },
                |()| obj([("ok", true.into_ipc())]),
                reply,
            );
        },
    ));

    // shrink a copy picked through the save dialog; the open document is untouched
    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:reduce-file-size",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let Some(path) = e.granted(view, args.get(0)) else {
                return reply.reply(Ok(refused(NOT_GRANTED)));
            };
            let picked = e.dialogs.save(
                e.contents.window_of(view),
                &FileDialog {
                    default_path: Some(format!("{}-small.pdf", stem(&path)).into()),
                    filters: vec![FileFilter {
                        name: tm(&e.lang(), Dlg::FilterPdf).into(),
                        extensions: vec!["pdf".into()],
                    }],
                    ..Default::default()
                },
            );
            let Some(target) = picked
                .map(|p| p.to_string_lossy().into_owned())
                .filter(|p| !p.is_empty())
            else {
                return reply.reply(Ok(obj([
                    ("ok", false.into_ipc()),
                    ("canceled", true.into_ipc()),
                ])));
            };
            let engine = e.engine.clone();
            kit::on_worker(
                &e.services,
                {
                    let target = target.clone();
                    move || -> Result<_, String> {
                        let source = read_file(&path)?;
                        let shrunk = engine.shrink(&source)?;
                        // a run that does not come out smaller writes nothing
                        if shrunk.bytes.len() < source.len() {
                            write_pdf_atomically(&target, &shrunk.bytes).map_err(|e| e.message)?;
                        }
                        Ok((source.len() as f64, shrunk))
                    }
                },
                move |result| {
                    reply.reply(Ok(match result {
                        Ok((before, shrunk)) => obj([
                            ("ok", true.into_ipc()),
                            ("targetPath", target.into_ipc()),
                            ("bytesBefore", before.into_ipc()),
                            ("bytesAfter", (shrunk.bytes.len() as f64).into_ipc()),
                            (
                                "streamsRecompressed",
                                shrunk.streams_recompressed.into_ipc(),
                            ),
                            ("imagesDownsampled", shrunk.images_downsampled.into_ipc()),
                        ]),
                        Err(m) => refused(m),
                    }))
                },
            );
        },
    ));

    all
}
