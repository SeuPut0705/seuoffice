//! `markdown:save`, the image channels, the image host and the exports of
//! `markdown-main.ts` (`resolveSaveTarget`, `saveIntoProject`,
//! `takeSaveAsExportTarget`, `readRemoteImage`, the settings file of the
//! image host) and `apps/markdown/src/shared/export-image-mime.ts`.
//!
//! The plain save runs inline as in the HTML editor; prints, conversions and
//! the network run on workers.

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use jscompat::node_path::host::{basename, dirname, extname, join, resolve};
use jscompat::{JsObject, JsonValue};
use main_core::markdown::asset_lifecycle::{
    copy_image_into_owned_assets, extract_markdown_image_sources,
    pending_owned_assets_for_document, prepare_assets_for_save_as, reconcile_owned_assets,
    resolve_safe_relative_image_path, resolve_source_pending_after_save_as,
    rollback_prepared_save_as_assets, write_image_into_owned_assets,
};
use main_core::markdown::conversion_lifecycle::{
    SessionOptions, create_markdown_conversion_session, write_markdown_conversion,
};
use main_core::markdown::image_export::{ImageExportEnv, ImageExportSessions};
use main_core::markdown::image_host::{
    FetchInit, is_image_host_usable, normalize_image_host_config, upload_image_to_host,
};
use main_core::markdown::print_document::MarkdownPrintOptions;
use main_core::markdown::print_pdf::print_markdown_pdf;
use main_core::packages::electron_utils::atomic_write::atomic_write_file;
use main_core::packages::electron_utils::marked_odt::{
    MarkedOdtChoice, MarkedOdtText, marked_odt_box, marked_odt_choice,
};
use main_core::packages::electron_utils::print_html_pdf::PrintWindow;
use main_core::packages::electron_utils::print_window::JsError;
use main_core::packages::electron_utils::recovery_store::RecoveryIdentity;
use main_core::packages::electron_utils::remote_image::{
    MAX_REMOTE_IMAGE_BYTES, fetch_remote_image, read_body_capped,
};
use main_core::packages::electron_utils::save_image::{SaveImageOptions, save_image_from_url};
use shell_contract::hosts::OsShellHost;
use shell_contract::ipc::{RegisterError, Responder};
use shell_contract::runtime::{PathName, Services};
use shell_contract::{IpcValue, ViewId};

use super::{MarkdownEditors, MarkdownEngineHost, MarkdownShellHost, to_ipc};
use crate::html::odt_export::{OdtConversion, marked_box, odt_filter_name, odt_report_box};
use crate::html::save::has_scheme;
use crate::html::text_doc::{
    canceled, dialog_options, export_name, failure, file_name_base, js_string, saved_at, saved_ok,
    tr,
};
use crate::kit::{self, Entry, IntoIpc, ViewMap, field, obj};
use crate::text_recovery::ui::{Files, Parent, now_ms};

/// `MAX_PASTED_IMAGE_BYTES` of `apps/markdown/src/shared/ipc.ts`
const MAX_PASTED_IMAGE_BYTES: usize = 50 * 1024 * 1024;

/// `EXPORT_IMAGE_MIME_BY_EXT`, in its order (`EXPORT_IMAGE_EXTS` follows it)
const EXPORT_IMAGE_MIME_BY_EXT: [(&str, &str); 8] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("bmp", "image/bmp"),
    ("avif", "image/avif"),
];

fn export_image_exts() -> Vec<&'static str> {
    EXPORT_IMAGE_MIME_BY_EXT.iter().map(|(e, _)| *e).collect()
}

fn mime_of_ext(ext: &str) -> Option<&'static str> {
    EXPORT_IMAGE_MIME_BY_EXT
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, m)| *m)
}

/// `exportImageMime(mime)`
fn export_image_mime(mime: Option<&str>) -> Option<&'static str> {
    let bare = mime
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    match bare.as_str() {
        "" => None,
        "image/jpg" | "image/pjpeg" => Some("image/jpeg"),
        "image/svg" => Some("image/svg+xml"),
        "image/x-ms-bmp" | "image/x-bmp" => Some("image/bmp"),
        other => EXPORT_IMAGE_MIME_BY_EXT
            .iter()
            .find(|(_, m)| *m == other)
            .map(|(_, m)| *m),
    }
}

/// `exportImageMimeFromPath(path)`
fn export_image_mime_from_path(path: &str) -> Option<&'static str> {
    let clean = path.split(['?', '#']).next().unwrap_or_default();
    let dot = clean.rfind('.')?;
    mime_of_ext(&clean[dot + 1..].to_lowercase())
}

/// `sniffExportImageMime(bytes)`
fn sniff_export_image_mime(bytes: &[u8]) -> Option<&'static str> {
    let at = |offset: usize, sig: &[u8]| bytes.get(offset..offset + sig.len()) == Some(sig);
    if at(0, &[0x89, 0x50, 0x4e, 0x47]) {
        Some("image/png")
    } else if at(0, &[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if at(0, b"GIF8") {
        Some("image/gif")
    } else if at(0, b"BM") {
        Some("image/bmp")
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        Some("image/webp")
    } else if at(4, b"ftypavi") {
        Some("image/avif")
    } else {
        None
    }
}

/// `remoteExportImageMime(bytes, contentType, url)`
fn remote_export_image_mime(
    bytes: &[u8],
    content_type: Option<&str>,
    url: &str,
) -> Option<&'static str> {
    sniff_export_image_mime(bytes)
        .or_else(|| export_image_mime(content_type))
        .or_else(|| export_image_mime_from_path(url))
}

/// `Math.ceil(MAX_PASTED_IMAGE_BYTES / 3) * 4`: the longest base64 a paste may send
fn base64_too_long(base64: &str) -> bool {
    base64.encode_utf16().count() > MAX_PASTED_IMAGE_BYTES.div_ceil(3) * 4
}

/// `/^https?:/i`
fn is_http(src: &str) -> bool {
    let lower = src.get(..6).unwrap_or(src).to_ascii_lowercase();
    lower.starts_with("http:") || lower.starts_with("https:")
}

/// A boxed hidden window as `print_markdown_pdf` takes one
struct Window(Box<dyn PrintWindow + Send>);

impl PrintWindow for Window {
    fn load_file(&mut self, path: &str) -> Result<(), JsError> {
        self.0.load_file(path)
    }
    fn print_to_pdf(&mut self, options: &serde_json::Value) -> Result<Vec<u8>, JsError> {
        self.0.print_to_pdf(options)
    }
    fn destroy(&mut self) -> Result<(), JsError> {
        self.0.destroy()
    }
}

/// `printMarkdownPdf(html)`, on a worker
fn print_pdf(engine: &MarkdownEngineHost, html: &str, temp: &Path) -> Result<Vec<u8>, String> {
    // the OS temp folder always exists; a shell that roots it elsewhere may not have made it
    let _ = std::fs::create_dir_all(temp);
    print_markdown_pdf(
        || Ok(Window(engine.print_window())),
        html,
        &MarkdownPrintOptions::default(),
        &temp.to_string_lossy(),
    )
    .map_err(|e| e.message)
}

/// `{ ok: true, canceled: true }` or the error of what failed
type Exported = Box<dyn FnOnce(IpcValue)>;

/// The Save As exports the dialog approved (`saveAsExportTargets`)
#[derive(Clone)]
struct Approved {
    format: &'static str,
    path: String,
}

/// `takeSaveAsExportTarget`'s answer
enum Take {
    /// not a Save As export
    NotRequested,
    /// the request names a path the dialog did not approve
    Refused,
    Approved(String),
}

struct Md {
    e: Rc<MarkdownEditors>,
    engine: MarkdownEngineHost,
    os: OsShellHost,
    shell: MarkdownShellHost,
    services: Services,
    save_as: ViewMap<Approved>,
    images: Rc<RefCell<ImageExportSessions>>,
    /// `conversionSessionPromise`: made once per run; a failure stays, as the rejected promise did
    conversion: RefCell<Option<Result<String, String>>>,
}

fn random_suffix() -> String {
    jscompat::random_uuid()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(6)
        .collect()
}

impl Md {
    fn lang(&self) -> String {
        self.e.docs.lang()
    }

    fn untitled(&self) -> String {
        tr(&self.lang(), "Untitled", "제목 없음")
    }

    fn temp(&self) -> std::path::PathBuf {
        self.services.paths.path(PathName::Temp)
    }

    fn settings_path(&self) -> String {
        join(&[
            &self
                .services
                .paths
                .path(PathName::UserData)
                .to_string_lossy(),
            "markdown-settings.json",
        ])
    }

    /// the settings file as an object; anything unreadable is `{}`
    fn read_settings(&self) -> Option<JsObject<JsonValue>> {
        let text = std::fs::read_to_string(self.settings_path()).ok()?;
        match jscompat::json_parse(&text).ok()? {
            JsonValue::Object(o) => Some(o),
            _ => None,
        }
    }

    /// `readImageHostConfig()`
    fn image_host(&self) -> Option<JsonValue> {
        let settings = self.read_settings()?;
        let raw = settings
            .get("imageHost")
            .cloned()
            .unwrap_or(JsonValue::Null);
        let config = normalize_image_host_config(Some(&raw))?;
        serde_json::to_value(&config)
            .ok()
            .map(|v| jscompat::json_value_from_serde(&v))
    }

    /// `takeSaveAsExportTarget(wcId, format, requested)`
    fn take_save_as(&self, view: ViewId, format: &str, requested: &IpcValue) -> Take {
        if matches!(requested, IpcValue::Undefined) {
            return Take::NotRequested;
        }
        match self.save_as.get(view) {
            Some(a) if a.format == format && kit::as_str(requested) == Some(a.path.as_str()) => {
                self.save_as.remove(view);
                Take::Approved(a.path)
            }
            _ => Take::Refused,
        }
    }

    /// `openExportedPdf(path)`
    fn open_exported_pdf(&self, path: &str) {
        if self.e.docs.is_headless() || self.shell.open_generated_path(Path::new(path)) {
            return;
        }
        self.os.show_item_in_folder(Path::new(path))
    }

    /// prints `html` on a worker, writes it to `target`, opens it
    fn write_pdf(self: &Rc<Self>, html: String, target: String, then: Exported) {
        let (engine, temp, to) = (self.engine.clone(), self.temp(), target.clone());
        let me = Rc::clone(self);
        kit::on_worker(
            &self.services,
            move || {
                let pdf = print_pdf(&engine, &html, &temp)?;
                std::fs::write(&to, pdf).map_err(|e| e.to_string())
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

    /// `resolveSaveTarget(e, mode, suggestedName, offerExports, defaultName)`;
    /// None when cancelled
    fn resolve_save_target(
        &self,
        view: ViewId,
        save_as: bool,
        suggested: Option<&str>,
        offer_exports: bool,
        default_name: Option<&str>,
    ) -> Result<Option<String>, shell_contract::IpcError> {
        let docs = &self.e.docs;
        let current = docs.save_path(view);
        if !save_as && let Some(current) = &current {
            return Ok(Some(current.clone()));
        }
        // AI auto-naming: silent first save of an untitled document
        if !save_as
            && current.is_none()
            && let Some(suggested) = suggested
        {
            let base = file_name_base(suggested);
            if !base.is_empty() {
                let dir = docs.default_save_dir()?;
                let mut target = join(&[&dir, &format!("{base}.md")]);
                let mut n = 1;
                while Path::new(&target).exists() {
                    target = join(&[&dir, &format!("{base}-{n}.md")]);
                    n += 1;
                }
                return Ok(Some(target));
            }
        }
        let lang = self.lang();
        let recovered = if current.is_some() {
            None
        } else {
            docs.recovery().save_as_default_path(view)
        };
        let folder = match (&current, &recovered) {
            (Some(current), _) => dirname(current),
            (None, Some(recovered)) => dirname(recovered),
            (None, None) => match self.shell.new_document_dir(view) {
                Some(dir) => dir.to_string_lossy().into_owned(),
                None => docs.default_save_dir()?,
            },
        };
        let proposed = default_name.map(file_name_base).unwrap_or_default();
        let default_path = if !proposed.is_empty() {
            let ext = current.as_deref().map_or_else(|| ".md".to_owned(), extname);
            join(&[&folder, &format!("{proposed}{ext}")])
        } else if let Some(current) = &current {
            join(&[&dirname(current), &basename(current, None)])
        } else {
            recovered.unwrap_or_else(|| join(&[&folder, &format!("{}.md", self.untitled())]))
        };
        // with the exports offered, the file type chosen in the dialog
        // supplies the extension
        let suggested_path = if offer_exports {
            strip_markdown_ext(&default_path)
        } else {
            default_path
        };
        let mut filters = vec![(
            tr(
                &lang,
                "Text Files (Markdown, TXT, JSON)",
                "텍스트 파일 (Markdown, TXT, JSON)",
            ),
            vec!["md", "markdown", "txt", "json"],
        )];
        if offer_exports {
            filters.push((tr(&lang, "PDF Document", "PDF 문서"), vec!["pdf"]));
            filters.push((tr(&lang, "Word Document", "Word 문서"), vec!["docx"]));
            filters.push((odt_filter_name(&lang), vec!["odt"]));
            filters.push((
                tr(&lang, "Page Images (PNG)", "쪽 이미지 (PNG)"),
                vec!["png"],
            ));
        }
        let picked = docs.save_dialog(
            view,
            dialog_options(
                Some(tr(&lang, "Save Markdown Document", "Markdown 문서 저장")),
                Some(suggested_path),
                &filters,
                &[],
            ),
            None,
        );
        // a dialog that does not add the chosen type's extension leaves a
        // bare name: the default type is Markdown
        Ok(picked.map(|p| {
            if extname(&p).is_empty() {
                format!("{p}.md")
            } else {
                p
            }
        }))
    }

    /// `markdown:save`
    fn save(self: &Rc<Self>, view: ViewId, request: &IpcValue, done: Exported) {
        let docs = &self.e.docs;
        let IpcValue::String(text) = field(request, "text") else {
            return done(failure("markdown: bad save request"));
        };
        let image_sources = match field(request, "imageSources") {
            IpcValue::Undefined => Vec::new(),
            IpcValue::Array(items) if items.iter().all(|s| kit::as_str(s).is_some()) => items
                .iter()
                .filter_map(|s| kit::as_str(s).map(str::to_owned))
                .collect(),
            _ => return done(failure("markdown: bad image references")),
        };
        let save_as = kit::as_str(field(request, "mode")) == Some("saveAs");
        let auto = matches!(field(request, "auto"), IpcValue::Bool(true));
        // Save As › PDF (rendered documents only): the print HTML of the screen
        let pdf_html = match field(request, "pdfHtml") {
            IpcValue::String(h) if save_as && !h.is_empty() => Some(h.clone()),
            _ => None,
        };
        let path_at_request = docs.save_path(view);
        let recovery_at_request = docs.recovery().identity_of(view);
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
        let placed = match (&suggested, &path_at_request) {
            (Some(suggested), None) if !save_as => {
                let base = file_name_base(suggested);
                if base.is_empty() {
                    None
                } else {
                    self.shell
                        .write_new_document(view, &format!("{base}.md"), text.as_bytes())
                        .map(|p| p.to_string_lossy().into_owned())
                }
            }
            _ => None,
        };
        let default_name = kit::as_str(field(request, "defaultName")).map(str::to_owned);
        let target = match &placed {
            Some(placed) => placed.clone(),
            None => {
                let resolved = self.resolve_save_target(
                    view,
                    save_as,
                    suggested.as_deref(),
                    pdf_html.is_some(),
                    default_name.as_deref(),
                );
                match resolved {
                    Err(error) => return done(failure(error.message)),
                    Ok(None) => return done(canceled()),
                    Ok(Some(p)) if p.is_empty() => {
                        return done(failure("markdown: no save target"));
                    }
                    Ok(Some(p)) => p,
                }
            }
        };
        let ext = extname(&target).to_ascii_lowercase();
        if let Some(html) = pdf_html {
            if ext == ".pdf" {
                // Save As › PDF: a rendered copy of the screen; the document
                // keeps its path, unsaved edits and assets
                return self.write_pdf(
                    html,
                    target,
                    Box::new(move |written| {
                        done(if saved_ok(&written) {
                            let path = field(&written, "path").clone();
                            obj([
                                ("ok", true.into_ipc()),
                                ("path", path),
                                ("exported", "pdf".into_ipc()),
                            ])
                        } else {
                            written
                        })
                    }),
                );
            }
            let format = match ext.as_str() {
                ".docx" => Some("docx"),
                ".odt" => Some("odt"),
                ".png" => Some("png"),
                _ => None,
            };
            if let Some(format) = format {
                // Save As › Word, ODT or page images: the renderer builds the
                // copy and writes it to this approved path
                self.save_as.insert(
                    view,
                    Approved {
                        format,
                        path: target.clone(),
                    },
                );
                return done(obj([
                    ("ok", true.into_ipc()),
                    ("path", target.into_ipc()),
                    ("exportAs", format.into_ipc()),
                ]));
            }
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
        recovery_before: Option<&RecoveryIdentity>,
    ) -> IpcValue {
        let references = match extract_markdown_image_sources(text) {
            Ok(r) => r,
            Err(e) => return failure(e.message),
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
        // a note placed in the project was written by the project's write guard
        if !placed && let Err(error) = atomic_write_file(target, text_to_write.as_bytes()) {
            if let Some(p) = &prepared {
                let _ = rollback_prepared_save_as_assets(p);
            }
            return failure(error.message);
        }
        self.e
            .docs
            .saved_to(view, current.as_deref(), target, recovery_before);
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
                "[markdown] asset reconciliation incomplete: {:?}",
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
                    "[markdown] source asset reconciliation incomplete: {:?}",
                    resolved.errors
                );
            }
        }
        if current.as_deref() != Some(target) {
            self.shell.file_saved(view, Path::new(target));
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
                ("writtenText", p.text.into_ipc()),
            ]),
            None => saved_at(target),
        }
    }

    /// `markdownConversionSession()`
    fn conversion_session(&self) -> Result<String, String> {
        let mut slot = self.conversion.borrow_mut();
        slot.get_or_insert_with(|| {
            let root = join(&[
                &self
                    .services
                    .paths
                    .path(PathName::UserData)
                    .to_string_lossy(),
                "markdown-conversions",
            ]);
            create_markdown_conversion_session(
                &root,
                &SessionOptions::default(),
                now_ms(),
                &jscompat::random_uuid,
            )
            .map_err(|e| e.message)
        })
        .clone()
    }

    /// `askMarkedOdt(show)`
    fn ask_marked_odt(&self, view: ViewId) -> MarkedOdtChoice {
        let lang = self.lang();
        let b = marked_odt_box(&MarkedOdtText {
            title: tr(&lang, "Content hidden from AI", "AI에게 숨긴 내용"),
            message: tr(
                &lang,
                "This document has content hidden from AI, and an ODT file cannot keep that.",
                "이 문서에는 AI에게 숨긴 내용이 있는데, ODT 파일에는 이를 담을 수 없습니다.",
            ),
            detail: tr(
                &lang,
                "Exported as ODT, the hidden content would read as plain text to everyone, AI included. Export as Word (.docx) instead, which keeps the hiding, or clear the marks for the ODT copy. This document keeps its marks either way.",
                "ODT로 내보내면 숨긴 내용이 AI를 포함한 모두에게 일반 글자로 보입니다. 대신 숨김이 유지되는 Word(.docx)로 내보내거나, ODT 사본에서 표시를 지우세요. 어느 쪽이든 이 문서의 표시는 그대로 남습니다.",
            ),
            save_docx: Some(tr(
                &lang,
                "Export as Word (.docx)",
                "Word(.docx)로 내보내기",
            )),
            clear_marks: tr(
                &lang,
                "Clear marks and export as ODT",
                "표시 지우고 ODT로 내보내기",
            ),
            cancel: tr(&lang, "Cancel", "취소"),
        });
        marked_odt_choice(self.e.docs.message(view, &marked_box(&b)) as f64, true)
    }

    /// the save dialog of an export, with the default save folder as fallback
    fn export_dialog(
        &self,
        view: ViewId,
        default_name: String,
        filter: (String, Vec<&str>),
    ) -> Result<Option<String>, String> {
        let fallback = self.e.docs.default_save_dir().map_err(|e| e.message)?;
        Ok(self.e.docs.save_dialog(
            view,
            dialog_options(None, Some(default_name), &[filter], &[]),
            Some(&fallback),
        ))
    }
}

/// `/\.(md|markdown)$/i`
fn strip_markdown_ext(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    for ext in [".markdown", ".md"] {
        if lower.ends_with(ext) {
            return path[..path.len() - ext.len()].to_owned();
        }
    }
    path.to_owned()
}

fn reply_with(responder: Responder) -> Exported {
    Box::new(move |v| responder.reply(Ok(v)))
}

/// `String(data?.ext ?? '').toLowerCase()`
fn ext_of(data: &IpcValue) -> String {
    match field(data, "ext") {
        IpcValue::Undefined | IpcValue::Null => String::new(),
        v => js_string(v),
    }
    .to_lowercase()
}

pub(super) fn entries(
    services: &Services,
    editors: &Rc<MarkdownEditors>,
    engine: MarkdownEngineHost,
    os: OsShellHost,
    shell: MarkdownShellHost,
) -> Result<Vec<Entry>, RegisterError> {
    let md = Rc::new(Md {
        e: Rc::clone(editors),
        engine,
        os,
        shell,
        services: services.clone(),
        save_as: ViewMap::new(services),
        images: Rc::default(),
        conversion: RefCell::default(),
    });
    {
        let images = Rc::clone(&md.images);
        editors.docs.on_destroyed(move |view| {
            if let Err(error) = images.borrow_mut().dispose(f64::from(view.0)) {
                eprintln!("[markdown] image export cleanup: {}", error.message);
            }
        });
    }
    let mut out = Vec::new();

    let m = Rc::clone(&md);
    out.push(kit::invoke_later(
        "markdown:save",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let waiter = m.e.docs.take_save_waiter(view);
            let done: Exported = Box::new(move |result| {
                if let Some(waiter) = waiter {
                    waiter(saved_ok(&result))
                }
                responder.reply(Ok(result))
            });
            m.save(view, args.get(0), done)
        },
    ));

    let m = Rc::clone(&md);
    out.push(kit::invoke("markdown:pick-image", move |cx, _| {
        let view = cx.sender.view;
        let Some(doc) = m.e.docs.save_path(view) else {
            return Ok(IpcValue::Null);
        };
        let lang = m.lang();
        let picked = m.e.docs.open_dialog(
            view,
            dialog_options(
                Some(tr(&lang, "Choose an Image", "이미지 선택")),
                None,
                &[(tr(&lang, "Images", "이미지"), export_image_exts())],
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

    let m = Rc::clone(&md);
    out.push(kit::invoke_later(
        "markdown:save-image",
        move |cx, args, responder| {
            let data = args.get(0);
            let doc = m.e.docs.save_path(cx.sender.view);
            let ext = ext_of(data);
            let base64 = match field(data, "base64") {
                IpcValue::String(s) if !s.is_empty() => s.clone(),
                _ => return responder.reply(Ok(IpcValue::Null)),
            };
            let Some(doc) = doc else {
                return responder.reply(Ok(IpcValue::Null));
            };
            if mime_of_ext(&ext).is_none() || base64_too_long(&base64) {
                return responder.reply(Ok(IpcValue::Null));
            }
            kit::on_worker(
                &m.services,
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

    let m = Rc::clone(&md);
    out.push(kit::invoke("markdown:get-image-host", move |_, _| {
        Ok(m.image_host()
            .map_or(IpcValue::Null, |c| kit::from_js_json(&c)))
    }));

    let m = Rc::clone(&md);
    out.push(kit::invoke("markdown:set-image-host", move |_, args| {
        let config = args.get(0);
        // null clears the host: pastes return to the local-assets behaviour
        let raw = kit::to_js_json(config);
        let normalized = normalize_image_host_config(raw.as_ref());
        // an incomplete form is rejected without touching the stored host
        if normalized.is_none() && !matches!(config, IpcValue::Null) {
            return Ok(IpcValue::Null);
        }
        let normalized = normalized
            .and_then(|c| serde_json::to_value(&c).ok())
            .map_or(JsonValue::Null, |v| jscompat::json_value_from_serde(&v));
        let mut file = m.read_settings().unwrap_or_default();
        file.set("imageHost", normalized.clone());
        let text = jscompat::json_stringify_pretty(&JsonValue::Object(file), 2);
        atomic_write_file(&m.settings_path(), text.as_bytes())
            .map_err(|e| kit::error(e.message))?;
        Ok(kit::from_js_json(&normalized))
    }));

    let m = Rc::clone(&md);
    out.push(kit::invoke_later(
        "markdown:upload-image",
        move |_, args, responder| {
            let data = args.get(0);
            let ext = ext_of(data);
            let fail = |error: &str| obj([("ok", false.into_ipc()), ("error", error.into_ipc())]);
            if mime_of_ext(&ext).is_none() {
                return responder.reply(Ok(fail("unsupported image type")));
            }
            let base64 = match field(data, "base64") {
                IpcValue::String(s) if !s.is_empty() => s.clone(),
                _ => return responder.reply(Ok(fail("missing image data"))),
            };
            if base64_too_long(&base64) {
                return responder.reply(Ok(fail("image too large")));
            }
            let config = m.image_host();
            if !is_image_host_usable(config.as_ref()) {
                return responder.reply(Ok(fail("no usable image host configured")));
            }
            let engine = m.engine.clone();
            kit::on_worker(
                &m.services,
                move || {
                    let bytes = jscompat::buffer_from_base64(&base64);
                    let mut fetch =
                        |url: &str, init: &FetchInit<'_>| engine.upload_fetch(url, init);
                    let result = upload_image_to_host(
                        config.as_ref(),
                        &bytes,
                        &ext,
                        &mut fetch,
                        now_ms(),
                        &mut jscompat::math_random,
                    );
                    to_ipc(&result)
                },
                move |result| responder.reply(Ok(result)),
            );
        },
    ));

    let m = Rc::clone(&md);
    out.push(kit::invoke_later(
        "markdown:save-image-as",
        move |cx, args, responder| {
            let Some(src) = args.str(0).map(str::to_owned) else {
                return responder.reply(Ok(obj([("ok", false.into_ipc())])));
            };
            let fallback = match m.e.docs.default_save_dir() {
                Ok(dir) => dir,
                Err(error) => return responder.reply(Err(error)),
            };
            let title = tr(&m.lang(), "Save Image", "이미지 저장");
            let parent = m.e.docs.window_of(cx.sender.view).map(Parent);
            let (memory, dialogs, engine) =
                (m.e.docs.memory(), m.e.docs.dialogs(), m.engine.clone());
            kit::on_worker(
                &m.services,
                move || {
                    let mut memory = memory.lock().unwrap_or_else(|e| e.into_inner());
                    let mut fetch = |url: &str| engine.net_fetch(url);
                    let saved = save_image_from_url(
                        &mut memory,
                        &mut Files(dialogs),
                        &mut fetch,
                        parent.as_ref(),
                        &src,
                        &SaveImageOptions {
                            title: &title,
                            fallback_dir: Some(&fallback),
                        },
                    );
                    to_ipc(&saved)
                },
                move |saved| responder.reply(Ok(saved)),
            );
        },
    ));

    let m = Rc::clone(&md);
    out.push(kit::invoke_later(
        "markdown:read-image",
        move |cx, args, responder| {
            let Some(src) = args.str(0).map(str::to_owned) else {
                return responder.reply(Ok(IpcValue::Null));
            };
            if is_http(&src) {
                let (engine, temp) = (m.engine.clone(), m.temp().to_string_lossy().into_owned());
                return kit::on_worker(
                    &m.services,
                    move || read_remote_image(&engine, &temp, &src),
                    move |image| responder.reply(Ok(image)),
                );
            }
            let doc = m.e.docs.save_path(cx.sender.view);
            let Some(doc) = doc.filter(|_| !has_scheme(&src)) else {
                return responder.reply(Ok(IpcValue::Null));
            };
            kit::on_worker(
                &m.services,
                move || read_local_image(&doc, &src),
                move |image| responder.reply(Ok(image)),
            );
        },
    ));

    let m = Rc::clone(&md);
    out.push(kit::invoke_later(
        "markdown:export-docx",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let request = args.get(0);
            let base64 = match field(request, "base64") {
                IpcValue::String(s) if !s.is_empty() => s.clone(),
                _ => return responder.reply(Ok(failure("markdown: bad export request"))),
            };
            let safe_name = export_name(field(request, "suggestedName"), &m.untitled());
            let bytes = jscompat::buffer_from_base64(&base64);
            if kit::as_str(field(request, "mode")) == Some("openInDocs") {
                // each conversion gets an app-owned cache file; crash leftovers
                // expire when the next session starts
                let session = match m.conversion_session() {
                    Ok(dir) => dir,
                    Err(error) => return responder.reply(Ok(failure(error))),
                };
                let me = Rc::clone(&m);
                return kit::on_worker(
                    &m.services,
                    move || {
                        write_markdown_conversion(
                            &session,
                            &safe_name,
                            &bytes,
                            None,
                            &jscompat::random_uuid,
                        )
                        .map_err(|e| e.message)
                    },
                    move |written| {
                        responder.reply(Ok(match written {
                            Ok(target) => {
                                me.shell.docx_exported(Path::new(&target));
                                saved_at(&target)
                            }
                            Err(error) => failure(error),
                        }))
                    },
                );
            }
            // Save As › Word already chose (and approved) the path: no second dialog
            let target = match m.take_save_as(view, "docx", field(request, "saveAsTarget")) {
                Take::Refused => {
                    return responder.reply(Ok(failure("markdown: save target not approved")));
                }
                Take::Approved(path) => path,
                Take::NotRequested => {
                    match m.export_dialog(
                        view,
                        format!("{safe_name}.docx"),
                        ("Word".into(), vec!["docx"]),
                    ) {
                        Err(error) => return responder.reply(Ok(failure(error))),
                        Ok(None) => return responder.reply(Ok(canceled())),
                        Ok(Some(path)) => path,
                    }
                }
            };
            let to = target.clone();
            kit::on_worker(
                &m.services,
                move || std::fs::write(&to, bytes).map_err(|e| e.to_string()),
                move |written| {
                    responder.reply(Ok(match written {
                        Ok(()) => saved_at(&target),
                        Err(error) => failure(error),
                    }))
                },
            );
        },
    ));

    let m = Rc::clone(&md);
    out.push(kit::invoke_later(
        "markdown:export-odt",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let request = args.get(0);
            let base64 = match field(request, "base64") {
                IpcValue::String(s) if !s.is_empty() => s.clone(),
                _ => return responder.reply(Ok(failure("markdown: bad export request"))),
            };
            let safe_name = export_name(field(request, "suggestedName"), &m.untitled());
            // Save As › ODT already chose (and approved) the path: no second dialog
            let target = match m.take_save_as(view, "odt", field(request, "saveAsTarget")) {
                Take::Refused => {
                    return responder.reply(Ok(failure("markdown: save target not approved")));
                }
                Take::Approved(path) => path,
                Take::NotRequested => {
                    let filter = (odt_filter_name(&m.lang()), vec!["odt"]);
                    match m.export_dialog(view, format!("{safe_name}.odt"), filter) {
                        Err(error) => return responder.reply(Ok(failure(error))),
                        Ok(None) => return responder.reply(Ok(canceled())),
                        Ok(Some(path)) => path,
                    }
                }
            };
            let (engine, me) = (m.engine.clone(), Rc::clone(&m));
            kit::on_worker(
                &m.services,
                move || engine.docx_to_odt(jscompat::buffer_from_base64(&base64)),
                move |converted| {
                    let OdtConversion { odt, report } = match converted {
                        Ok(c) => c,
                        Err(error) => return responder.reply(Ok(failure(error))),
                    };
                    if !report.is_empty()
                        && me
                            .e
                            .docs
                            .message(view, &odt_report_box(&report, &me.lang()))
                            != 0
                    {
                        return responder.reply(Ok(canceled()));
                    }
                    let to = target.clone();
                    kit::on_worker(
                        &me.services,
                        move || std::fs::write(&to, odt).map_err(|e| e.to_string()),
                        move |written| {
                            responder.reply(Ok(match written {
                                Ok(()) => saved_at(&target),
                                Err(error) => failure(error),
                            }))
                        },
                    );
                },
            );
        },
    ));

    // a document with content hidden from AI is not written as ODT: one box
    // with the two ways out; the renderer carries the answer out
    let m = Rc::clone(&md);
    out.push(kit::invoke("markdown:confirm-marked-odt", move |cx, _| {
        // a headless export has no one to ask: nothing is written
        if m.e.docs.is_headless() {
            return Ok("cancel".into_ipc());
        }
        Ok(match m.ask_marked_odt(cx.sender.view) {
            MarkedOdtChoice::Docx => "docx",
            MarkedOdtChoice::Clear => "clear",
            MarkedOdtChoice::Cancel => "cancel",
        }
        .into_ipc())
    }));

    let m = Rc::clone(&md);
    out.push(kit::invoke_later(
        "markdown:export-pdf",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let request = args.get(0);
            let html = match field(request, "html") {
                IpcValue::String(h) if !h.is_empty() => h.clone(),
                _ => return responder.reply(Ok(failure("markdown: bad export request"))),
            };
            let safe_name = export_name(field(request, "suggestedName"), &m.untitled());
            // headless export has no dialog to authorize a path; the CLI already chose one
            let target = match field(request, "outPath") {
                IpcValue::String(out) if m.e.docs.is_headless() && !out.is_empty() => out.clone(),
                _ => {
                    let fallback = match m.e.docs.default_save_dir() {
                        Ok(dir) => dir,
                        Err(error) => return responder.reply(Err(error)),
                    };
                    let picked = m.e.docs.save_dialog(
                        view,
                        dialog_options(
                            None,
                            Some(format!("{safe_name}.pdf")),
                            &[("PDF".into(), vec!["pdf"])],
                            &[],
                        ),
                        Some(&fallback),
                    );
                    match picked {
                        None => return responder.reply(Ok(canceled())),
                        Some(p) => p,
                    }
                }
            };
            m.write_pdf(html, target, reply_with(responder))
        },
    ));

    let m = Rc::clone(&md);
    out.push(kit::invoke_later(
        "markdown:prepare-image-export",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let owner = f64::from(view.0);
            let request = args.get(0);
            let html = match field(request, "html") {
                IpcValue::String(h) if !h.is_empty() => h.clone(),
                _ => return responder.reply(Ok(failure("Empty document"))),
            };
            let env = ImageExportEnv {
                random_uuid: &jscompat::random_uuid,
                mkdtemp_suffix: &random_suffix,
            };
            // Save As › page images: the typed name, numbered per page beside it
            let started = match m.take_save_as(view, "png", field(request, "saveAsTarget")) {
                Take::Refused => {
                    return responder.reply(Ok(failure("markdown: save target not approved")));
                }
                Take::Approved(path) => m
                    .images
                    .borrow_mut()
                    .start_files(&env, owner, &path)
                    .map_err(|e| e.message),
                Take::NotRequested => {
                    let fallback = match m.e.docs.default_save_dir() {
                        Ok(dir) => dir,
                        Err(error) => return responder.reply(Ok(failure(error.message))),
                    };
                    let picked = m.e.docs.open_dialog(
                        view,
                        dialog_options(None, None, &[], &["openDirectory", "createDirectory"]),
                        Some(&fallback),
                    );
                    let Some(dir) = picked.and_then(|p| p.into_iter().next()) else {
                        return responder.reply(Ok(canceled()));
                    };
                    let suggested = field(request, "suggestedName");
                    let name = if kit::truthy(suggested) {
                        js_string(suggested)
                    } else {
                        m.untitled()
                    };
                    m.images
                        .borrow_mut()
                        .start(&env, owner, &dir, &name)
                        .map_err(|e| e.message)
                }
            };
            let id = match started {
                Ok(id) => id,
                Err(error) => return responder.reply(Ok(failure(error))),
            };
            let (engine, temp, me) = (m.engine.clone(), m.temp(), Rc::clone(&m));
            kit::on_worker(
                &m.services,
                move || print_pdf(&engine, &html, &temp),
                move |printed| {
                    let printed = printed.and_then(|pdf| {
                        if me.e.docs.is_destroyed(view) {
                            Err("Document closed during export".to_owned())
                        } else {
                            Ok(pdf)
                        }
                    });
                    responder.reply(Ok(match printed {
                        Ok(pdf) => obj([
                            ("ok", true.into_ipc()),
                            ("id", id.as_str().into_ipc()),
                            ("pdfBase64", jscompat::base64(&pdf).into_ipc()),
                        ]),
                        Err(error) => {
                            let _ = me.images.borrow_mut().finish(owner, &id, false);
                            failure(error)
                        }
                    }))
                },
            );
        },
    ));

    let m = Rc::clone(&md);
    out.push(kit::invoke(
        "markdown:write-export-image",
        move |cx, args| {
            let owner = f64::from(cx.sender.view.0);
            let written = m.images.borrow_mut().write(
                owner,
                args.str(0).unwrap_or_default(),
                args.num(1).unwrap_or(f64::NAN),
                args.str(2),
            );
            Ok(match written {
                Ok(()) => obj([("ok", true.into_ipc())]),
                Err(error) => failure(error.message),
            })
        },
    ));

    let m = Rc::clone(&md);
    out.push(kit::invoke(
        "markdown:finish-image-export",
        move |cx, args| {
            let owner = f64::from(cx.sender.view.0);
            let success = args.bool(1) == Some(true);
            let finished = m.images.borrow_mut().finish_export(
                owner,
                args.str(0).unwrap_or_default(),
                success,
            );
            Ok(match finished {
                Ok(None) => canceled(),
                Ok(Some(done)) => {
                    m.os.show_item_in_folder(Path::new(&done.first));
                    saved_at(&done.dir)
                }
                Err(error) => failure(error.message),
            })
        },
    ));
    Ok(out)
}

/// `readRemoteImage(url)`: downloaded here, behind the SSRF guard
fn read_remote_image(engine: &MarkdownEngineHost, temp: &str, url: &str) -> IpcValue {
    let (mut resolver, mut fetcher) = (engine.resolver(), engine.fetcher());
    let Some(mut resp) = fetch_remote_image(resolver.as_mut(), fetcher.as_mut(), temp, url, None)
    else {
        return IpcValue::Null;
    };
    if !resp.ok() {
        return IpcValue::Null;
    }
    let content_type = resp.header("content-type");
    let Ok(bytes) = read_body_capped(resp.as_mut(), MAX_REMOTE_IMAGE_BYTES as f64) else {
        return IpcValue::Null;
    };
    match remote_export_image_mime(&bytes, content_type.as_deref(), url) {
        Some(mime) => obj([
            ("base64", jscompat::base64(&bytes).into_ipc()),
            ("mime", mime.into_ipc()),
        ]),
        None => IpcValue::Null,
    }
}

/// `markdown:read-image`'s file part
fn read_local_image(doc: &str, src: &str) -> IpcValue {
    let Some(target) = resolve_safe_relative_image_path(doc, src) else {
        return IpcValue::Null;
    };
    let ext = extname(&target).to_lowercase();
    let Some(mime) = mime_of_ext(ext.strip_prefix('.').unwrap_or_default()) else {
        return IpcValue::Null;
    };
    match std::fs::read(&target) {
        Ok(bytes) => obj([
            ("base64", jscompat::base64(&bytes).into_ipc()),
            ("mime", mime.into_ipc()),
        ]),
        Err(_) => IpcValue::Null,
    }
}

#[cfg(test)]
mod mime_tests {
    use super::remote_export_image_mime;

    #[test]
    fn a_remote_picture_is_typed_by_signature_then_header_then_name() {
        let png = [0x89, 0x50, 0x4e, 0x47, 0, 0];
        assert_eq!(
            remote_export_image_mime(&png, Some("image/gif"), "x.jpg"),
            Some("image/png")
        );
        assert_eq!(
            remote_export_image_mime(b"<svg", Some("image/SVG; q=1"), "x"),
            Some("image/svg+xml")
        );
        assert_eq!(
            remote_export_image_mime(b"??", Some("text/html"), "a/b.WEBP?x#y"),
            Some("image/webp")
        );
        assert_eq!(remote_export_image_mime(b"??", None, "a/b"), None);
    }
}
