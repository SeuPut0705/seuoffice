//! `export-main.ts`: picture and PDF export. The renderer hands over the
//! pages it made; the main side asks where, and writes the files.

use std::collections::HashSet;
use std::path::Path;

use jscompat::node_path::host::{basename, dirname, extname, join};
use jscompat::{JsObject, JsonValue};
use main_core::diagram::export_paths::page_file_paths;
use main_core::diagram::print_document::{PrintPage, is_print_page};
use main_core::packages::electron_utils::atomic_write::atomic_write_file;
use shell_contract::hosts::MessageBox;
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::{IpcError, IpcValue, ViewId};

use super::DiagramViews;
use super::files::json_filters;
use super::formats::safe_file_name_base;
use super::queries::js_string;
use crate::value::{Args, as_bytes, as_num, field, obj, string, thrown, to_json};

type Reply = Result<IpcValue, IpcError>;

const PNG_SIGNATURE: [u8; 4] = [0x89, 0x50, 0x4e, 0x47];

fn failure(error: impl Into<String>) -> IpcValue {
    obj([("ok", IpcValue::Bool(false)), ("error", string(error))])
}

fn canceled() -> IpcValue {
    obj([
        ("ok", IpcValue::Bool(true)),
        ("canceled", IpcValue::Bool(true)),
    ])
}

fn written(paths: Vec<String>) -> IpcValue {
    obj([
        ("ok", IpcValue::Bool(true)),
        (
            "paths",
            IpcValue::Array(paths.into_iter().map(IpcValue::String).collect()),
        ),
    ])
}

/// `looksLike(format, bytes)`: whether bytes a renderer sent are a picture of that format
fn looks_like(format: &str, bytes: &[u8]) -> bool {
    if format == "png" {
        return bytes.starts_with(&PNG_SIGNATURE);
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).into_owned();
    let head = head.trim_start_matches(jscompat::is_js_space);
    head.starts_with("<svg") || head.starts_with("<?xml") || head.starts_with("<!DOCTYPE svg")
}

/// `Number.isSafeInteger(value)`
fn safe_integer(value: &IpcValue) -> Option<f64> {
    let x = as_num(value)?;
    (x.is_finite() && x.trunc() == x && x.abs() <= 9_007_199_254_740_991.0).then_some(x)
}

/// `printPagesOf(value)`: a non-empty list of pages that can be printed
fn print_pages_of(value: &IpcValue) -> Option<Vec<PrintPage>> {
    let IpcValue::Array(items) = value else {
        return None;
    };
    if items.is_empty() {
        return None;
    }
    items
        .iter()
        .map(|item| {
            let json = to_json(item)?;
            if !is_print_page(Some(&json)) {
                return None;
            }
            let number = |key| as_num(field(item, key));
            Some(PrintPage {
                svg: match field(item, "svg") {
                    IpcValue::String(svg) => svg.clone(),
                    _ => return None,
                },
                width: number("width")?,
                height: number("height")?,
                page_width: number("pageWidth")?,
                page_height: number("pageHeight")?,
            })
        })
        .collect()
}

impl DiagramViews {
    /// `defaultExportPath(filePathOf, wcId, name, ext)`; `Err` is what
    /// `configuredDefaultSaveDir` threw
    fn default_export_path(&self, view: ViewId, name: &str, ext: &str) -> Result<String, String> {
        let dir = match self.file_path(view) {
            Some(file) => dirname(&file),
            None => self.default_save_dir()?,
        };
        let mut base = safe_file_name_base(Some(name));
        if base.is_empty() {
            base = self.tm("untitled");
        }
        Ok(join(&[&dir, &format!("{base}.{ext}")]))
    }

    /// `confirmReplace(contents, paths)`
    fn confirm_replace(&self, view: ViewId, paths: &[String]) -> bool {
        let existing: Vec<&String> = paths.iter().filter(|p| Path::new(p).exists()).collect();
        if existing.is_empty() {
            return true;
        }
        let mut detail = vec![self.tm("exportReplaceDetail")];
        detail.extend(existing.iter().take(5).map(|p| basename(p, None)));
        let options = MessageBox {
            kind: Some("warning".into()),
            message: super::strings::export_replace_message(self.lang(), existing.len()),
            detail: Some(detail.join("\n")),
            buttons: vec![self.tm("btnReplace"), self.tm("btnCancel")],
            default_id: Some(1),
            cancel_id: Some(1),
            ..MessageBox::default()
        };
        self.0
            .dialogs
            .message(self.window_of(view), &options)
            .response
            == 0
    }

    /// The export dialog: where to write, none when cancelled
    fn export_dialog(
        &self,
        view: ViewId,
        default_path: String,
        filter: (String, &str),
    ) -> Option<String> {
        let mut options = JsObject::new();
        options.set("title", JsonValue::String(self.tm("dlgExportTitle")));
        options.set("defaultPath", JsonValue::String(default_path));
        options.set(
            "filters",
            json_filters(vec![(filter.0, vec![filter.1.to_owned()])]),
        );
        self.save_dialog(view, &options)
    }

    pub(super) fn export_images(&self, cx: &CallContext, args: Args) -> Reply {
        let view = cx.sender.view;
        let request = args.get(0);
        let format = match field(request, "format") {
            IpcValue::String(format) if format == "png" || format == "svg" => format.as_str(),
            _ => return Ok(failure("bad export format")),
        };
        let pages: &[IpcValue] = match field(request, "pages") {
            IpcValue::Array(pages) => pages,
            _ => &[],
        };
        let mut files: Vec<(f64, &[u8])> = Vec::new();
        for page in pages {
            let bytes = as_bytes(field(page, "bytes"));
            let number = safe_integer(field(page, "number")).filter(|n| *n >= 1.0);
            let (Some(bytes), Some(number)) = (bytes, number) else {
                return Ok(failure("bad export page"));
            };
            if !looks_like(format, bytes) {
                return Ok(failure(format!("not a {format} picture")));
            }
            files.push((number, bytes));
        }
        let distinct: HashSet<u64> = files.iter().map(|(n, _)| n.to_bits()).collect();
        if files.is_empty() || distinct.len() != files.len() {
            return Ok(failure("bad export pages"));
        }
        let suggested = suggested_name(request);
        let default_path = self
            .default_export_path(view, &suggested, format)
            .map_err(thrown)?;
        let filter_key = if format == "png" {
            "filterPng"
        } else {
            "filterSvg"
        };
        let Some(picked) = self.export_dialog(view, default_path, (self.tm(filter_key), format))
        else {
            return Ok(canceled());
        };
        let chosen = if extname(&picked).to_lowercase() == format!(".{format}") {
            picked
        } else {
            format!("{picked}.{format}")
        };
        // all pages: a file per page (a one-page diagram too); the page on screen: the chosen file
        let numbers: Vec<f64> = files.iter().map(|(n, _)| *n).collect();
        let per_page = !matches!(field(request, "scope"), IpcValue::String(s) if s == "current");
        let paths = page_file_paths(&chosen, format, &numbers, per_page);
        // the dialog already asked about the one chosen name
        let unasked = paths.len() != 1 || paths[0] != chosen;
        if unasked && !self.confirm_replace(view, &paths) {
            return Ok(canceled());
        }
        for (index, (_, bytes)) in files.iter().enumerate() {
            if let Err(err) = atomic_write_file(&paths[index], bytes) {
                return Ok(failure(err.message));
            }
        }
        Ok(written(paths))
    }

    pub(super) fn export_pdf(&self, cx: &CallContext, args: Args, reply: Responder) {
        match self.export_pdf_prepare(cx, &args) {
            Err(early) => reply.reply(early),
            Ok((pages, suggested, target)) => {
                // the print document renders in a hidden window: not on the core thread
                let shell = self.0.shell.clone();
                self.0.services.workers.spawn(Box::new(move || {
                    reply.reply(Ok(match shell.render_pdf(&pages, &suggested) {
                        Ok(pdf) => match atomic_write_file(&target, &pdf) {
                            Ok(()) => written(vec![target]),
                            Err(err) => failure(err.message),
                        },
                        Err(message) => failure(message),
                    }));
                }));
            }
        }
    }

    /// The part of `diagram:export-pdf` before the render: the checks and the
    /// dialog. `Err` is the answer when there is nothing to render.
    fn export_pdf_prepare(
        &self,
        cx: &CallContext,
        args: &Args,
    ) -> Result<(Vec<PrintPage>, String, String), Reply> {
        let view = cx.sender.view;
        let request = args.get(0);
        let Some(pages) = print_pages_of(field(request, "pages")) else {
            return Err(Ok(failure("bad export pages")));
        };
        let suggested = suggested_name(request);
        let default_path = self
            .default_export_path(view, &suggested, "pdf")
            .map_err(|message| Err(thrown(message)))?;
        let Some(picked) = self.export_dialog(view, default_path, (self.tm("filterPdf"), "pdf"))
        else {
            return Err(Ok(canceled()));
        };
        let target = if extname(&picked).to_lowercase() == ".pdf" {
            picked
        } else {
            format!("{picked}.pdf")
        };
        Ok((pages, suggested, target))
    }
}

/// `String(request.suggestedName ?? '')`
fn suggested_name(request: &IpcValue) -> String {
    match field(request, "suggestedName") {
        IpcValue::Undefined | IpcValue::Null => String::new(),
        other => js_string(other),
    }
}
