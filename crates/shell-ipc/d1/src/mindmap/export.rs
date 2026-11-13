//! `export-main.ts`: where an export goes and what is written. The renderer
//! draws the map; this side asks where to put the file (unless Save As already
//! asked: `save_as_grants`) and writes it with the atomic writer.

use jscompat::node_path::host::extname;
use jscompat::{JsObject, JsonValue, js_regex, trim};
use main_core::mindmap::atomic_write::atomic_write_file;
use main_core::mindmap::save_as_formats::MapSaveAsKind;
use main_core::packages::electron_utils::dialog_memory::{FallbackDir, save_as_suggestion};
use shell_contract::IpcValue;
use shell_contract::ViewId;
use shell_contract::ipc::Responder;

use super::app::MindmapApp;
use super::handlers::pick_save_path;
use super::util::{slice, utf16_len};
use crate::route::{self, Route};
use crate::value::{Args, as_bytes, field, obj, string};

/// A page larger than this is no map page this editor wrote
const MAX_PAGE_CHARS: usize = 200 * 1024 * 1024;
/// An outline larger than this is no outline of a map that opened
const MAX_OUTLINE_CHARS: usize = 64 * 1024 * 1024;
/// A picture larger than this is no picture of one sheet this editor drew
const MAX_PNG_BYTES: usize = 512 * 1024 * 1024;
const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/// What an SVG file written here starts with
const XML_DECLARATION: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";

/// `EXPORT_KINDS`: the extension (with its dot) and the filter name of each kind
fn export_kind(kind: MapSaveAsKind) -> (&'static str, &'static str) {
    match kind {
        MapSaveAsKind::Png => (".png", "PNG"),
        MapSaveAsKind::Svg => (".svg", "SVG"),
        MapSaveAsKind::Pdf => (".pdf", "PDF"),
        MapSaveAsKind::Markdown => (".md", "Markdown"),
        MapSaveAsKind::Xmind => unreachable!("a map is saved, not exported"),
    }
}

/// `exportFileBase`: a suggested name as a file name: no path characters,
/// not too long, never empty
fn export_file_base(app: &MindmapApp, name: &IpcValue) -> String {
    let text = match name {
        IpcValue::String(text) => text.as_str(),
        _ => "",
    };
    let cleaned: String = text
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                || (c as u32) < 0x20
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let base = trim(&slice(&cleaned, 0, 80)).to_owned();
    // a name of dots alone is no name on Windows
    let base = js_regex!(r"^\.+$").replace_all(&base, |_| String::new());
    if base.is_empty() {
        app.tm("untitledFile")
    } else {
        base
    }
}

/// `withExportExtension`
fn with_export_extension(path: String, kind: MapSaveAsKind) -> String {
    let (extension, _) = export_kind(kind);
    if extname(&path).to_lowercase() == extension {
        path
    } else {
        format!("{path}{extension}")
    }
}

/// `pickTarget`: where the user wants the export, `None` when the dialog was cancelled
fn pick_target(
    app: &MindmapApp,
    view: ViewId,
    kind: MapSaveAsKind,
    suggested_name: &IpcValue,
) -> Result<Option<String>, String> {
    let (extension, filter) = export_kind(kind);
    let file_path = app.file_path(view);
    let default_path = save_as_suggestion(
        file_path.as_deref(),
        &format!("{}{extension}", export_file_base(app, suggested_name)),
    );
    let mut options = JsObject::new();
    options.set("defaultPath", JsonValue::String(default_path));
    let mut item = JsObject::new();
    item.set("name", JsonValue::String(filter.to_owned()));
    item.set(
        "extensions",
        JsonValue::Array(vec![JsonValue::String(extension[1..].to_owned())]),
    );
    options.set("filters", JsonValue::Array(vec![JsonValue::Object(item)]));
    let fallback = app.default_save_dir()?;
    Ok(
        pick_save_path(app, view, &options, Some(&FallbackDir::Dir(&fallback)))
            .map(|picked| with_export_extension(picked, kind)),
    )
}

/// `targetOf`: where the export goes: the path Save As granted, taken once
/// and only when it is exactly that path for this kind; without one, the
/// export's own dialog
fn target_of(
    app: &MindmapApp,
    view: ViewId,
    kind: MapSaveAsKind,
    request: &IpcValue,
) -> Result<Option<String>, String> {
    let given = field(request, "path");
    if matches!(given, IpcValue::Undefined) {
        return pick_target(app, view, kind, field(request, "suggestedName"));
    }
    let grant = app.0.state.borrow().save_as_grants.get(&view).cloned();
    match (given, grant) {
        (IpcValue::String(given), Some((granted_kind, path)))
            if granted_kind == kind && path == *given =>
        {
            app.0.state.borrow_mut().save_as_grants.remove(&view);
            Ok(Some(given.clone()))
        }
        _ => Err("mindmap: this export path was not picked in Save As".into()),
    }
}

fn export_failure(message: impl Into<String>) -> IpcValue {
    obj([("ok", IpcValue::Bool(false)), ("error", string(message))])
}

fn export_canceled() -> IpcValue {
    obj([
        ("ok", IpcValue::Bool(true)),
        ("canceled", IpcValue::Bool(true)),
    ])
}

fn export_written(path: String) -> IpcValue {
    obj([("ok", IpcValue::Bool(true)), ("path", string(path))])
}

fn is_png(bytes: &[u8]) -> bool {
    bytes.len() > PNG_SIGNATURE.len() && bytes.starts_with(&PNG_SIGNATURE)
}

/// `isMapSvg`: one SVG element from start to end, and no script anywhere
fn is_map_svg(text: &IpcValue) -> Option<&str> {
    let IpcValue::String(text) = text else {
        return None;
    };
    (utf16_len(text) <= MAX_PAGE_CHARS
        && text.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\"")
        && text.ends_with("</svg>")
        && !js_regex!(r"<script\b", "i").test(text))
    .then_some(text.as_str())
}

/// the whole of a handler whose write is small: target, write, answer
fn write_export(
    app: &MindmapApp,
    view: ViewId,
    kind: MapSaveAsKind,
    request: &IpcValue,
    bytes: &[u8],
) -> IpcValue {
    match target_of(app, view, kind, request) {
        Err(message) => export_failure(message),
        Ok(None) => export_canceled(),
        Ok(Some(target)) => match atomic_write_file(&target, bytes) {
            Ok(()) => export_written(target),
            Err(error) => export_failure(error.message),
        },
    }
}

fn export_pdf(app: &MindmapApp, view: ViewId, args: Args, responder: Responder) {
    let request = args.get(0);
    let html = match field(request, "html") {
        IpcValue::String(html) if !html.is_empty() && utf16_len(html) <= MAX_PAGE_CHARS => html,
        _ => {
            return responder.reply(Ok(export_failure("mindmap: bad PDF export request")));
        }
    };
    let target = match target_of(app, view, MapSaveAsKind::Pdf, request) {
        Err(message) => return responder.reply(Ok(export_failure(message))),
        Ok(None) => return responder.reply(Ok(export_canceled())),
        Ok(Some(target)) => target,
    };
    let renderer = app.0.renderer.clone();
    let html = html.clone();
    app.offload(
        move || -> Result<String, String> {
            let pdf = renderer.page_to_pdf(&html)?;
            atomic_write_file(&target, &pdf).map_err(|error| error.message)?;
            Ok(target)
        },
        move |_app, outcome| {
            responder.reply(Ok(match outcome {
                Ok(path) => export_written(path),
                Err(message) => export_failure(message),
            }))
        },
    );
}

pub(super) fn routes(app: &MindmapApp) -> Vec<Route> {
    let mut routes = Vec::new();

    let a = app.clone();
    routes.push(route::invoke("mindmap:export-png", move |cx, args| {
        let request = args.get(0);
        let bytes = match as_bytes(field(request, "bytes")) {
            Some(bytes) if is_png(bytes) && bytes.len() <= MAX_PNG_BYTES => bytes,
            _ => return Ok(export_failure("mindmap: bad picture export request")),
        };
        Ok(write_export(
            &a,
            cx.sender.view,
            MapSaveAsKind::Png,
            request,
            bytes,
        ))
    }));

    let a = app.clone();
    routes.push(route::invoke("mindmap:export-svg", move |cx, args| {
        let request = args.get(0);
        let Some(svg) = is_map_svg(field(request, "svg")) else {
            return Ok(export_failure("mindmap: bad SVG export request"));
        };
        let bytes = format!("{XML_DECLARATION}{svg}");
        Ok(write_export(
            &a,
            cx.sender.view,
            MapSaveAsKind::Svg,
            request,
            bytes.as_bytes(),
        ))
    }));

    let a = app.clone();
    routes.push(route::invoke_later(
        "mindmap:export-pdf",
        move |cx, args, responder| export_pdf(&a, cx.sender.view, args, responder),
    ));

    let a = app.clone();
    routes.push(route::invoke("mindmap:export-markdown", move |cx, args| {
        let request = args.get(0);
        let text = match field(request, "text") {
            IpcValue::String(text) if utf16_len(text) <= MAX_OUTLINE_CHARS => text,
            _ => return Ok(export_failure("mindmap: bad outline export request")),
        };
        Ok(write_export(
            &a,
            cx.sender.view,
            MapSaveAsKind::Markdown,
            request,
            text.as_bytes(),
        ))
    }));

    routes
}
