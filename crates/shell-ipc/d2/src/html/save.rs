//! `html:save`, the image channels and the exports of `html-main.ts`
//! (`resolveSaveTarget`, `saveIntoProject`, `writeHtmlPdf/Docx/Odt`,
//! `renderPrintPdf`, `renderHtmlDocx`, `exportFileName`).
//!
//! The plain save runs inline: the text and the asset manifest are small
//! files, and the dialogs it may show are synchronous on the core thread
//! anyway (contract section 3). The renders (print, html2docx, docxToOdt)
//! and their writes run on workers.

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use jscompat::node_path::host::{basename, dirname, extname, join, resolve};
use main_core::html::asset_lifecycle::{
    copy_image_into_owned_assets, extract_html_asset_references, pending_owned_assets_for_document,
    prepare_assets_for_save_as, reconcile_owned_assets, resolve_safe_relative_image_path,
    resolve_source_pending_after_save_as, rollback_prepared_save_as_assets,
    write_image_into_owned_assets,
};
use main_core::html::asset_mime::{ASSET_SNIFF_BYTES, editable_image_mime};
use main_core::html::marked_html::{
    MarkedExportChoice, MarkedExportPlan, MarksLeft, plan_marked_export,
};
use main_core::html::preview_document::{asset_base_href, build_preview_document};
use main_core::html::single_file_html::{
    inline_images_for_single_file, single_file_export_base_name,
};
use main_core::packages::electron_utils::atomic_write::atomic_write_file;
use main_core::packages::electron_utils::fetch_image_bytes::fetch_image_bytes;
use shell_contract::hosts::OsShellHost;
use shell_contract::ipc::{RegisterError, Responder};
use shell_contract::runtime::{PathName, Services};
use shell_contract::{IpcValue, ViewId};

use super::odt_export::{
    MarkedFormat, OdtConversion, marked_export_box, marked_export_clears, marked_export_refusal,
    odt_filter_name, odt_report_box,
};
use super::text_doc::{
    canceled, dialog_options, failure, file_name_base, js_string, saved_at, saved_ok, tr,
};
use super::{HtmlEditors, HtmlEngineHost};
use crate::kit::{self, Entry, IntoIpc, field, obj, truthy};

/// A renderer that never yields must not strand the export (`HTML_EXPORT_TIMEOUT_MS`)
pub(crate) const HTML_EXPORT_TIMEOUT: Duration = Duration::from_millis(180_000);

/// the picture formats the editor authors (the DOCX export can keep them)
const EDITABLE_IMAGE_EXTS: [&str; 4] = ["png", "jpg", "jpeg", "gif"];

type Reply = Box<dyn FnOnce(IpcValue)>;

/// The export steps with what they reach
pub(super) struct Exporter {
    e: Rc<HtmlEditors>,
    engine: HtmlEngineHost,
    os: OsShellHost,
    services: Services,
}

fn message(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Exporter {
    fn lang(&self) -> String {
        self.e.docs.lang()
    }

    fn untitled(&self) -> String {
        tr(&self.lang(), "Untitled", "제목 없음")
    }

    /// `exportFileName(suggested)`
    fn export_file_name(&self, suggested: &IpcValue) -> String {
        let raw = if truthy(suggested) {
            js_string(suggested)
        } else {
            self.untitled()
        };
        let base = file_name_base(&raw);
        if base.is_empty() {
            self.untitled()
        } else {
            base
        }
    }

    /// a fresh work folder under the temp folder (`mkdtemp(join(tmpdir(), prefix))`)
    fn work_dir(&self, prefix: &str) -> Result<String, String> {
        let temp = self.services.paths.path(PathName::Temp);
        // the OS temp folder always exists; a shell that roots it elsewhere may not have made it
        let _ = std::fs::create_dir_all(&temp);
        main_core::node_fs::mkdtemp_random(&join(&[&temp.to_string_lossy(), prefix]))
            .map_err(|e| e.message)
    }

    /// `openExportedPdf(path)`: a PDF tab in the shell, else the folder
    fn open_exported_pdf(&self, path: &str) {
        if self.e.docs.is_headless() {
            return;
        }
        if self.e.shell.open_generated_path(Path::new(path)) {
            return;
        }
        self.os.show_item_in_folder(Path::new(path))
    }

    /// `openExportedDocx(path)`: the shell's docs tab, else the folder
    fn open_exported_docx(&self, path: &str) {
        if self.e.docs.is_headless() {
            return;
        }
        if self.e.shell.docx_exported(Path::new(path)) {
            return;
        }
        self.os.show_item_in_folder(Path::new(path))
    }

    /// the page as the preview shows it, written into `work_dir`
    fn preview_file(
        html: &str,
        doc_path: Option<&str>,
        work_dir: &str,
        name: &str,
    ) -> Result<PathBuf, String> {
        let base = doc_path.map(|p| asset_base_href(&dirname(p)));
        let path = PathBuf::from(join(&[work_dir, name]));
        std::fs::write(&path, build_preview_document(html, base.as_deref())).map_err(message)?;
        Ok(path)
    }

    /// `writeHtmlPdf(html, docPath, target)`
    fn write_pdf(
        self: &Rc<Self>,
        html: String,
        doc_path: Option<String>,
        target: String,
        then: Reply,
    ) {
        let (engine, work) = (self.engine.clone(), self.work_dir("seuoffice-html-pdf-"));
        let me = Rc::clone(self);
        let to = target.clone();
        kit::on_worker(
            &self.services,
            move || -> Result<(), String> {
                let work = work?;
                let printed = Self::preview_file(&html, doc_path.as_deref(), &work, "print.html")
                    .and_then(|file| engine.print_pdf(&file))
                    .and_then(|pdf| std::fs::write(&to, pdf).map_err(message));
                let _ = std::fs::remove_dir_all(&work);
                printed
            },
            move |written| match written {
                Ok(()) => {
                    me.open_exported_pdf(&target);
                    then(saved_at(&target))
                }
                Err(error) => then(failure(error)),
            },
        );
    }

    /// `renderHtmlDocx(html, docPath, workDir)` with its watchdog
    fn render_docx(
        self: &Rc<Self>,
        html: String,
        doc_path: Option<String>,
        then: Box<dyn FnOnce(Result<Vec<u8>, String>)>,
    ) {
        let slot = Rc::new(std::cell::RefCell::new(Some(then)));
        let on_time = Rc::clone(&slot);
        let watchdog = kit::after(&self.services, HTML_EXPORT_TIMEOUT, move || {
            let then = on_time.borrow_mut().take();
            if let Some(then) = then {
                then(Err("html export timed out".into()))
            }
        });
        let (engine, work) = (self.engine.clone(), self.work_dir("seuoffice-html-docx-"));
        kit::on_worker(
            &self.services,
            move || -> Result<Vec<u8>, String> {
                let work = work?;
                let docx = Self::preview_file(&html, doc_path.as_deref(), &work, "export.html")
                    .and_then(|file| engine.html_to_docx(&file));
                let _ = std::fs::remove_dir_all(&work);
                docx
            },
            move |docx| {
                kit::clear(watchdog);
                let then = slot.borrow_mut().take();
                if let Some(then) = then {
                    then(docx)
                }
            },
        );
    }

    /// `askMarkedExport(format, show)`: true clears the marks for this copy
    fn ask_marked(&self, view: ViewId, format: MarkedFormat) -> MarkedExportChoice {
        let response = self
            .e
            .docs
            .message(view, &marked_export_box(format, &self.lang()));
        if marked_export_clears(response) {
            MarkedExportChoice::Clear
        } else {
            MarkedExportChoice::Cancel
        }
    }

    /// `planMarkedExport(html, ask)`: `None` asks nobody (declined when marked)
    fn plan(
        &self,
        view: ViewId,
        html: &str,
        format: MarkedFormat,
        ask: bool,
    ) -> Result<Option<String>, String> {
        let asked = ask.then_some(|| Ok::<_, PlanError>(self.ask_marked(view, format)));
        match plan_marked_export::<PlanError>(html, asked) {
            Ok(MarkedExportPlan::Write { html }) => Ok(Some(html)),
            Ok(MarkedExportPlan::Declined) => Ok(None),
            Err(PlanError) => Err("the hidden marks could not be cleared".into()),
        }
    }

    /// `writeHtmlDocx(html, docPath, target, win)`
    fn write_docx(
        self: &Rc<Self>,
        view: ViewId,
        html: String,
        doc_path: Option<String>,
        target: String,
        then: Reply,
    ) {
        let headless = self.e.docs.is_headless();
        let html = match self.plan(view, &html, MarkedFormat::Docx, !headless) {
            Ok(Some(html)) => html,
            Ok(None) => {
                return then(if headless {
                    failure(marked_export_refusal(&self.lang()))
                } else {
                    canceled()
                });
            }
            Err(error) => return then(failure(error)),
        };
        let me = Rc::clone(self);
        self.e.shell.docx_export_prepare(
            &PathBuf::from(&target),
            Box::new(move |go| {
                if !go {
                    return then(canceled());
                }
                let me2 = Rc::clone(&me);
                me.render_docx(
                    html,
                    doc_path,
                    Box::new(move |docx| match docx {
                        Err(error) => then(failure(error)),
                        Ok(docx) => {
                            let to = target.clone();
                            kit::on_worker(
                                &me2.services.clone(),
                                move || std::fs::write(&to, docx).map_err(message),
                                move |written| match written {
                                    Ok(()) => {
                                        me2.open_exported_docx(&target);
                                        then(saved_at(&target))
                                    }
                                    Err(error) => then(failure(error)),
                                },
                            );
                        }
                    }),
                );
            }),
        );
    }

    /// `writeHtmlOdt(html, docPath, win, pickPath, skipConfirm)`: the Word
    /// export's bytes through `docxToOdt`, a non-empty report confirmed
    fn write_odt(
        self: &Rc<Self>,
        view: ViewId,
        html: String,
        pick_path: Box<dyn FnOnce() -> Option<String>>,
        skip_confirm: bool,
        then: Reply,
    ) {
        let html = match self.plan(view, &html, MarkedFormat::Odt, !skip_confirm) {
            Ok(Some(html)) => html,
            Ok(None) => {
                return then(if skip_confirm {
                    failure(marked_export_refusal(&self.lang()))
                } else {
                    canceled()
                });
            }
            Err(error) => return then(failure(error)),
        };
        // exportOdt: pick → docx → ODT → confirm → prepare → write
        let Some(path) = pick_path() else {
            return then(canceled());
        };
        let me = Rc::clone(self);
        // the document path is read when the docx is rendered, after the pick
        let doc_path = self.e.docs.save_path(view);
        self.render_docx(
            html,
            doc_path,
            Box::new(move |docx| {
                let docx = match docx {
                    Ok(docx) => docx,
                    Err(error) => return then(failure(error)),
                };
                let engine = me.engine.clone();
                let me2 = Rc::clone(&me);
                kit::on_worker(
                    &me.services,
                    move || engine.docx_to_odt(docx),
                    move |converted| {
                        let OdtConversion { odt, report } = match converted {
                            Ok(c) => c,
                            Err(error) => return then(failure(error)),
                        };
                        if !report.is_empty() && !skip_confirm {
                            let b = odt_report_box(&report, &me2.lang());
                            if me2.e.docs.message(view, &b) != 0 {
                                return then(canceled());
                            }
                        }
                        let me3 = Rc::clone(&me2);
                        // a docs tab showing the target is closed first, as for the Word export
                        me2.e.shell.docx_export_prepare(
                            &PathBuf::from(&path),
                            Box::new(move |go| {
                                if !go {
                                    return then(canceled());
                                }
                                let to = path.clone();
                                kit::on_worker(
                                    &me3.services.clone(),
                                    move || std::fs::write(&to, odt).map_err(message),
                                    move |written| match written {
                                        Ok(()) => {
                                            me3.open_exported_docx(&path);
                                            then(saved_at(&path))
                                        }
                                        Err(error) => then(failure(error)),
                                    },
                                );
                            }),
                        );
                    },
                );
            }),
        );
    }

    /// the dialog an export asks for its target, unless a headless run named it
    fn export_target(
        &self,
        view: ViewId,
        request: &IpcValue,
        default_name: String,
        filter: (String, Vec<&str>),
    ) -> Result<Option<String>, shell_contract::IpcError> {
        if self.e.docs.is_headless()
            && let IpcValue::String(out) = field(request, "outPath")
            && !out.is_empty()
        {
            return Ok(Some(out.clone()));
        }
        let fallback = self.e.docs.default_save_dir()?;
        Ok(self.e.docs.save_dialog(
            view,
            dialog_options(None, Some(default_name), &[filter], &[]),
            Some(&fallback),
        ))
    }
}

/// what `planMarkedExport`'s ask throws: the marks did not all clear
struct PlanError;

impl From<MarksLeft> for PlanError {
    fn from(_: MarksLeft) -> Self {
        PlanError
    }
}

/// `resolveSaveTarget`'s answer
enum SaveTarget {
    Canceled,
    Path(String),
}

/// `exportHtmlOfSaveText(text)`: the renderer's `serializeDocText` undone
fn export_html_of_save_text(text: &str) -> String {
    let body = text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .replace("\r\n", "\n");
    match body.strip_suffix('\n') {
        Some(cut) => cut.to_owned(),
        None => body,
    }
}

/// `/\.html?$/i`
fn strip_html_ext(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    for ext in [".html", ".htm"] {
        if lower.ends_with(ext) {
            return path[..path.len() - ext.len()].to_owned();
        }
    }
    path.to_owned()
}

impl Exporter {
    /// `resolveSaveTarget(e, mode, suggestedName, defaultName, offerExports)`
    fn resolve_save_target(
        &self,
        view: ViewId,
        save_as: bool,
        suggested: Option<&str>,
        default_name: Option<&str>,
    ) -> Result<SaveTarget, shell_contract::IpcError> {
        let docs = &self.e.docs;
        let current = docs.save_path(view);
        if !save_as && let Some(current) = &current {
            return Ok(SaveTarget::Path(current.clone()));
        }
        // AI auto-naming: silent first save of an untitled document
        if !save_as
            && current.is_none()
            && let Some(suggested) = suggested
        {
            let base = file_name_base(suggested);
            if !base.is_empty() {
                let dir = docs.default_save_dir()?;
                let mut target = join(&[&dir, &format!("{base}.html")]);
                let mut n = 1;
                while Path::new(&target).exists() {
                    target = join(&[&dir, &format!("{base}-{n}.html")]);
                    n += 1;
                }
                return Ok(SaveTarget::Path(target));
            }
        }
        let offer_exports = save_as;
        let lang = self.lang();
        // an untitled page starts in the folder a recovered copy came from,
        // else in its panel's project, else in the default save folder
        let recovered = if current.is_some() {
            None
        } else {
            docs.recovery().save_as_default_path(view)
        };
        let folder = match (&current, &recovered) {
            (Some(current), _) => dirname(current),
            (None, Some(recovered)) => dirname(recovered),
            (None, None) => match self.e.shell.new_document_dir(view) {
                Some(dir) => dir.to_string_lossy().into_owned(),
                None => docs.default_save_dir()?,
            },
        };
        let proposed = default_name.map(file_name_base).unwrap_or_default();
        let default_path = if !proposed.is_empty() {
            let ext = current
                .as_deref()
                .map_or_else(|| ".html".to_owned(), extname);
            join(&[&folder, &format!("{proposed}{ext}")])
        } else if let Some(current) = &current {
            join(&[&dirname(current), &basename(current, None)])
        } else {
            recovered.unwrap_or_else(|| {
                join(&[
                    &folder,
                    &format!("{}.html", tr(&lang, "Untitled", "제목 없음")),
                ])
            })
        };
        let mut filters = vec![(
            tr(&lang, "HTML Documents", "HTML 문서"),
            vec!["html", "htm"],
        )];
        if offer_exports {
            filters.push((tr(&lang, "PDF Document", "PDF 문서"), vec!["pdf"]));
            filters.push((tr(&lang, "Word Document", "Word 문서"), vec!["docx"]));
            filters.push((odt_filter_name(&lang), vec!["odt"]));
        }
        let picked = docs.save_dialog(
            view,
            dialog_options(
                Some(tr(&lang, "Save HTML Document", "HTML 문서 저장")),
                Some(if offer_exports {
                    strip_html_ext(&default_path)
                } else {
                    default_path
                }),
                &filters,
                &[],
            ),
            None,
        );
        let Some(picked) = picked else {
            return Ok(SaveTarget::Canceled);
        };
        // a dialog that does not add the chosen type's extension leaves a
        // bare name: the default type is HTML
        Ok(SaveTarget::Path(
            if offer_exports && extname(&picked).is_empty() {
                format!("{picked}.html")
            } else {
                picked
            },
        ))
    }

    /// `html:save`
    fn save(self: &Rc<Self>, view: ViewId, request: &IpcValue, done: Reply) {
        let docs = &self.e.docs;
        let IpcValue::String(text) = field(request, "text") else {
            return done(failure("html: bad save request"));
        };
        let image_sources = match field(request, "imageSources") {
            IpcValue::Undefined => Vec::new(),
            IpcValue::Array(items) if items.iter().all(|s| kit::as_str(s).is_some()) => items
                .iter()
                .filter_map(|s| kit::as_str(s).map(str::to_owned))
                .collect(),
            _ => return done(failure("html: bad image references")),
        };
        let save_as = kit::as_str(field(request, "mode")) == Some("saveAs");
        // request input is untrusted: only an explicit automatic-save flag counts
        let auto = matches!(field(request, "auto"), IpcValue::Bool(true));
        let path_at_request = docs.save_path(view);
        let recovery_at_request = docs.recovery().identity_of(view);
        // a copy pair saving onto the document's own path settles the
        // conflict before anything is prepared or written
        if !save_as
            && let Some(path) = &path_at_request
            && docs.conflict_stops_save(view, path, auto)
        {
            return done(failure("external-modified"));
        }
        let pending_at_request = path_at_request
            .as_deref()
            .map(pending_owned_assets_for_document)
            .unwrap_or_default();
        let suggested = kit::as_str(field(request, "suggestedName")).map(str::to_owned);
        let default_name = kit::as_str(field(request, "defaultName")).map(str::to_owned);
        // the AI's silent first save lands in the panel's project when it has one
        let placed = match (&suggested, &path_at_request) {
            (Some(suggested), None) if !save_as => {
                let base = file_name_base(suggested);
                if base.is_empty() {
                    None
                } else {
                    self.e
                        .shell
                        .write_new_document(view, &format!("{base}.html"), text.as_bytes())
                        .map(|p| p.to_string_lossy().into_owned())
                }
            }
            _ => None,
        };
        let target = match &placed {
            Some(placed) => placed.clone(),
            None => match self.resolve_save_target(
                view,
                save_as,
                suggested.as_deref(),
                default_name.as_deref(),
            ) {
                Err(error) => return done(failure(error.message)),
                Ok(SaveTarget::Canceled) => return done(canceled()),
                Ok(SaveTarget::Path(p)) if p.is_empty() => {
                    return done(failure("html: no save target"));
                }
                Ok(SaveTarget::Path(p)) => p,
            },
        };
        let export_as = if save_as {
            match extname(&target).to_ascii_lowercase().as_str() {
                ".pdf" => Some("pdf"),
                ".docx" => Some("docx"),
                ".odt" => Some("odt"),
                _ => None,
            }
        } else {
            None
        };
        if let Some(format) = export_as {
            // Save As › PDF, Word or ODT: a copy written by the export menu's
            // code; the page keeps its path, unsaved edits, copy and assets
            let html = export_html_of_save_text(text);
            let finish: Reply = Box::new(move |exported: IpcValue| {
                let path = kit::as_str(field(&exported, "path")).map(str::to_owned);
                match path {
                    Some(path) if saved_ok(&exported) => done(obj([
                        ("ok", true.into_ipc()),
                        ("path", path.into_ipc()),
                        ("exported", format.into_ipc()),
                    ])),
                    _ => done(exported),
                }
            });
            return match format {
                "pdf" => self.write_pdf(html, path_at_request, target, finish),
                "docx" => self.write_docx(view, html, path_at_request, target, finish),
                _ => self.write_odt(view, html, Box::new(move || Some(target)), false, finish),
            };
        }
        done(self.write_save(
            view,
            text,
            image_sources,
            &path_at_request,
            &target,
            placed.is_some(),
            save_as,
            &pending_at_request,
            recovery_at_request.as_ref(),
        ))
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the TypeScript's locals of one handler"
    )]
    fn write_save(
        &self,
        view: ViewId,
        text: &str,
        mut image_sources: Vec<String>,
        current: &Option<String>,
        target: &str,
        placed: bool,
        save_as: bool,
        pending_at_request: &[String],
        recovery_before: Option<
            &main_core::packages::electron_utils::recovery_store::RecoveryIdentity,
        >,
    ) -> IpcValue {
        let docs = &self.e.docs;
        let references = match extract_html_asset_references(text) {
            Ok(r) => r,
            Err(e) => return failure(format!("{e:?}")),
        };
        for source in references {
            if !image_sources.contains(&source) {
                image_sources.push(source);
            }
        }
        let prepared = match current {
            Some(current) if resolve(&[&dirname(current)]) != resolve(&[&dirname(target)]) => {
                match prepare_assets_for_save_as(current, target, text, &image_sources) {
                    Ok(p) => Some(p),
                    Err(e) => return failure(e.message),
                }
            }
            _ => None,
        };
        let text_to_write = prepared.as_ref().map_or(text, |p| p.text.as_str());
        let saved_sources = prepared
            .as_ref()
            .map_or_else(|| image_sources.clone(), |p| p.image_sources.clone());
        // a page placed in the project was written by the project's write guard
        if !placed && let Err(error) = atomic_write_file(target, text_to_write.as_bytes()) {
            if let Some(p) = &prepared {
                let _ = rollback_prepared_save_as_assets(p);
            }
            return failure(error.message);
        }
        docs.saved_to(view, current.as_deref(), target, recovery_before);
        let pending_names: Vec<String> = match (&prepared, current) {
            (Some(p), _) => p.created.iter().map(|r| r.name.clone()).collect(),
            (None, Some(current)) if resolve(&[current]) == resolve(&[target]) => {
                pending_at_request.to_vec()
            }
            _ => Vec::new(),
        };
        let reconciled = reconcile_owned_assets(target, &saved_sources, Some(&pending_names));
        if !reconciled.errors.is_empty() {
            eprintln!(
                "[html] asset reconciliation incomplete: {:?}",
                reconciled.errors
            );
        }
        if save_as
            && let Some(current) = current
            && resolve(&[current]) != resolve(&[target])
        {
            let resolved = resolve_source_pending_after_save_as(current, pending_at_request);
            if !resolved.errors.is_empty() {
                eprintln!(
                    "[html] source asset reconciliation incomplete: {:?}",
                    resolved.errors
                );
            }
        }
        if current.as_deref() != Some(target) {
            self.e.shell.file_saved(view, Path::new(target));
        }
        match prepared.filter(|p| !p.rewrites.is_empty()) {
            Some(p) => obj([
                ("ok", true.into_ipc()),
                ("path", target.into_ipc()),
                (
                    "imageRewrites",
                    IpcValue::Array(
                        p.rewrites
                            .iter()
                            .map(|r| {
                                obj([
                                    ("from", r.from.as_str().into_ipc()),
                                    ("to", r.to.as_str().into_ipc()),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ]),
            None => saved_at(target),
        }
    }
}

fn reply_with(responder: Responder) -> Reply {
    Box::new(move |v| responder.reply(Ok(v)))
}

pub(super) fn entries(
    services: &Services,
    editors: &Rc<HtmlEditors>,
    engine: HtmlEngineHost,
    os: OsShellHost,
) -> Result<Vec<Entry>, RegisterError> {
    let x = Rc::new(Exporter {
        e: Rc::clone(editors),
        engine,
        os,
        services: services.clone(),
    });
    let mut out = Vec::new();

    let ex = Rc::clone(&x);
    out.push(kit::invoke_later(
        "html:save",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let waiter = ex.e.docs.take_save_waiter(view);
            let done: Reply = Box::new(move |result| {
                if let Some(waiter) = waiter {
                    waiter(saved_ok(&result))
                }
                responder.reply(Ok(result))
            });
            ex.save(view, args.get(0), done)
        },
    ));

    let ex = Rc::clone(&x);
    out.push(kit::invoke("html:pick-image", move |cx, _| {
        let view = cx.sender.view;
        let Some(doc) = ex.e.docs.save_path(view) else {
            return Ok(IpcValue::Null);
        };
        let lang = ex.lang();
        let picked = ex.e.docs.open_dialog(
            view,
            dialog_options(
                Some(tr(&lang, "Choose an Image", "이미지 선택")),
                None,
                // only formats readImage and the DOCX export can round-trip
                &[(tr(&lang, "Images", "이미지"), EDITABLE_IMAGE_EXTS.to_vec())],
                &["openFile"],
            ),
            None,
        );
        let Some(source) = picked.and_then(|p| p.into_iter().next()) else {
            return Ok(IpcValue::Null);
        };
        copy_image_into_owned_assets(&doc, &source)
            .map(IntoIpc::into_ipc)
            .map_err(|e| kit::error(e.message))
    }));

    let ex = Rc::clone(&x);
    out.push(kit::invoke_later(
        "html:save-image",
        move |cx, args, responder| {
            let data = args.get(0);
            let doc = ex.e.docs.save_path(cx.sender.view);
            let ext = match field(data, "ext") {
                IpcValue::Undefined | IpcValue::Null => String::new(),
                v => js_string(v),
            }
            .to_lowercase();
            let base64 = match field(data, "base64") {
                IpcValue::String(s) if !s.is_empty() => s.clone(),
                _ => return responder.reply(Ok(IpcValue::Null)),
            };
            let Some(doc) = doc else {
                return responder.reply(Ok(IpcValue::Null));
            };
            // every authored asset must stay DOCX-exportable
            if !EDITABLE_IMAGE_EXTS.contains(&ext.as_str()) {
                return responder.reply(Ok(IpcValue::Null));
            }
            kit::on_worker(
                &ex.services,
                move || {
                    let bytes = jscompat::buffer_from_base64(&base64);
                    write_image_into_owned_assets(&doc, &format!("image.{ext}"), &bytes)
                },
                move |written| {
                    responder.reply(
                        written
                            .map(IntoIpc::into_ipc)
                            .map_err(|e| kit::error(e.message)),
                    )
                },
            );
        },
    ));

    let ex = Rc::clone(&x);
    out.push(kit::invoke_later(
        "html:read-image",
        move |cx, args, responder| {
            let doc = ex.e.docs.save_path(cx.sender.view);
            let (Some(doc), Some(src)) = (doc, args.str(0)) else {
                return responder.reply(Ok(IpcValue::Null));
            };
            if has_scheme(src) {
                return responder.reply(Ok(IpcValue::Null));
            }
            let src = src.to_owned();
            kit::on_worker(
                &ex.services,
                move || read_image(&doc, &src),
                move |image| responder.reply(Ok(image)),
            );
        },
    ));

    // remote pictures are downloaded here: the frame's fetch is CORS-bound,
    // and fetchImageBytes gates both the download and the generated store
    let ex = Rc::clone(&x);
    out.push(kit::invoke_later(
        "html:fetch-image",
        move |_, args, responder| {
            let url = args.str(0).map(str::to_owned);
            let engine = ex.engine.clone();
            let temp = ex
                .services
                .paths
                .path(PathName::Temp)
                .to_string_lossy()
                .into_owned();
            kit::on_worker(
                &ex.services,
                move || {
                    let (mut resolver, mut fetcher) = (engine.resolver(), engine.fetcher());
                    fetch_image_bytes(resolver.as_mut(), fetcher.as_mut(), &temp, url.as_deref())
                        .map(|image| (image.base64, mime_text(&image.mime)))
                },
                move |image| {
                    responder.reply(Ok(match image {
                        Some((base64, mime)) => {
                            obj([("base64", base64.into_ipc()), ("mime", mime.into_ipc())])
                        }
                        None => IpcValue::Null,
                    }))
                },
            );
        },
    ));

    let ex = Rc::clone(&x);
    out.push(kit::invoke_later(
        "html:export-docx",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let request = args.get(0);
            let IpcValue::String(html) = field(request, "html") else {
                return responder.reply(Ok(failure("html: bad export request")));
            };
            let name = format!(
                "{}.docx",
                ex.export_file_name(field(request, "suggestedName"))
            );
            let target = match ex.export_target(view, request, name, ("Word".into(), vec!["docx"]))
            {
                Err(error) => return responder.reply(Err(error)),
                Ok(None) => return responder.reply(Ok(canceled())),
                Ok(Some(t)) => t,
            };
            let doc = ex.e.docs.save_path(view);
            ex.write_docx(view, html.clone(), doc, target, reply_with(responder))
        },
    ));

    let ex = Rc::clone(&x);
    out.push(kit::invoke_later(
        "html:export-odt",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let request = args.get(0).clone();
            let IpcValue::String(html) = field(&request, "html").clone() else {
                return responder.reply(Ok(failure("html: bad export request")));
            };
            // a headless export has no dialog to authorize a path or confirm
            let headless_path = match field(&request, "outPath") {
                IpcValue::String(p) if ex.e.docs.is_headless() && !p.is_empty() => Some(p.clone()),
                _ => None,
            };
            let skip = headless_path.is_some();
            let picker = Rc::clone(&ex);
            let pick: Box<dyn FnOnce() -> Option<String>> = Box::new(move || {
                if let Some(path) = headless_path {
                    return Some(path);
                }
                let name = format!(
                    "{}.odt",
                    picker.export_file_name(field(&request, "suggestedName"))
                );
                let fallback = picker.e.docs.default_save_dir().ok();
                picker.e.docs.save_dialog(
                    view,
                    dialog_options(
                        None,
                        Some(name),
                        &[(odt_filter_name(&picker.lang()), vec!["odt"])],
                        &[],
                    ),
                    fallback.as_deref(),
                )
            });
            ex.write_odt(view, html, pick, skip, reply_with(responder))
        },
    ));

    let ex = Rc::clone(&x);
    out.push(kit::invoke_later(
        "html:export-pdf",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let request = args.get(0);
            let IpcValue::String(html) = field(request, "html") else {
                return responder.reply(Ok(failure("html: bad export request")));
            };
            let name = format!(
                "{}.pdf",
                ex.export_file_name(field(request, "suggestedName"))
            );
            let target = match ex.export_target(view, request, name, ("PDF".into(), vec!["pdf"])) {
                Err(error) => return responder.reply(Err(error)),
                Ok(None) => return responder.reply(Ok(canceled())),
                Ok(Some(t)) => t,
            };
            let doc = ex.e.docs.save_path(view);
            ex.write_pdf(html.clone(), doc, target, reply_with(responder))
        },
    ));

    let ex = Rc::clone(&x);
    out.push(kit::invoke_later(
        "html:export-html",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let request = args.get(0);
            let IpcValue::String(html) = field(request, "html") else {
                return responder.reply(Ok(failure("html: bad export request")));
            };
            let name = format!(
                "{}.html",
                single_file_export_base_name(&ex.export_file_name(field(request, "suggestedName")))
            );
            let target = match ex.export_target(view, request, name, ("HTML".into(), vec!["html"]))
            {
                Err(error) => return responder.reply(Err(error)),
                Ok(None) => return responder.reply(Ok(canceled())),
                Ok(Some(t)) => t,
            };
            let doc = ex.e.docs.save_path(view);
            // inlining the document into itself would silently rewrite the working file
            if doc
                .as_deref()
                .is_some_and(|d| resolve(&[&target]) == resolve(&[d]))
            {
                return responder.reply(Ok(failure(
                    "single-file export cannot overwrite the open document",
                )));
            }
            let (html, me) = (html.clone(), Rc::clone(&ex));
            let to = target.clone();
            kit::on_worker(
                &ex.services,
                move || {
                    let result = inline_images_for_single_file(&html, doc.as_deref());
                    std::fs::write(&to, result.html)
                        .map(|()| result.skipped)
                        .map_err(message)
                },
                move |written| {
                    responder.reply(Ok(match written {
                        Err(error) => failure(error),
                        Ok(skipped) => {
                            if !me.e.docs.is_headless() {
                                me.os.show_item_in_folder(Path::new(&target));
                            }
                            if skipped.is_empty() {
                                saved_at(&target)
                            } else {
                                obj([
                                    ("ok", true.into_ipc()),
                                    ("path", target.into_ipc()),
                                    ("skipped", skipped.into_ipc()),
                                ])
                            }
                        }
                    }))
                },
            );
        },
    ));
    Ok(out)
}

/// `/^[a-z][a-z0-9+.-]*:/i`
pub(crate) fn has_scheme(src: &str) -> bool {
    let mut chars = src.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

fn mime_text(
    mime: &main_core::packages::electron_utils::fetch_image_bytes::FetchedImageMime,
) -> &'static str {
    use main_core::packages::electron_utils::fetch_image_bytes::FetchedImageMime;
    match mime {
        FetchedImageMime::Png => "image/png",
        FetchedImageMime::Jpeg => "image/jpeg",
        FetchedImageMime::Gif => "image/gif",
    }
}

/// `html:read-image`'s file part: an authored picture beside the document
fn read_image(doc: &str, src: &str) -> IpcValue {
    let Some(target) = resolve_safe_relative_image_path(doc, src) else {
        return IpcValue::Null;
    };
    if !Path::new(&target).exists() {
        return IpcValue::Null;
    }
    let by_ext = match extname(&target).to_ascii_lowercase().as_str() {
        ".png" => Some("image/png"),
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".gif" => Some("image/gif"),
        _ => None,
    };
    let Ok(bytes) = std::fs::read(&target) else {
        return IpcValue::Null;
    };
    // "save page as, complete" assets have no extension: type them from the signature
    let mime = by_ext.or_else(|| editable_image_mime(&bytes[..bytes.len().min(ASSET_SNIFF_BYTES)]));
    match mime {
        Some(mime) => obj([
            ("base64", jscompat::base64(&bytes).into_ipc()),
            ("mime", mime.into_ipc()),
        ]),
        None => IpcValue::Null,
    }
}
