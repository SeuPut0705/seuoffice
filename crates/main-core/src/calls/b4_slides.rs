//! The functions of group `b4-slides` (tools/main-diff/groups/b4-slides.ts).
//!
//! Bytes cross as hex strings. A `null` argument is an argument left out
//! where the TypeScript has a default. Names of files that another app also
//! has are prefixed `slides/`.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::{JsonValue, json_value_from_serde};
use serde_json::{Map, Number, Value};

use super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::electron_utils::generate_handoff::HandoffWebContents;
use crate::packages::electron_utils::print_window::{JsError, rm_recursive_force};
use crate::packages::electron_utils::recovery_store::{
    RecoveryEditorKind, RecoveryFileIdentity, RecoveryIdentity, RecoveryUntitledIdentity,
};
use crate::slides::cfb_sniff::{cfb_kind, is_cfb_header};
use crate::slides::export_images::build_export_image_paths;
use crate::slides::font_scan::{ScanResult, ScanTask, scan_font_dirs};
use crate::slides::generated_page_temp::{GENERATED_PAGE_TTL_MS, cleanup_expired_generated_pages};
use crate::slides::jpeg_orientation::neutralize_jpeg_orientation;
use crate::slides::media_mime::{DisplayMime, display_mime, raster_image_ext, sniff_image_mime};
use crate::slides::metafile_fonts::{
    MAX_METAFILE_GUNZIP_BYTES, MetafileFontRequest, list_metafile_fonts, scan_metafile_fonts,
};
use crate::slides::mp4_audio_sniff::{
    VideoSize, audio_sample_formats, mp4_video_size, unplayable_audio_codec,
};
use crate::slides::paste_cascade::{
    PasteCascade, new_paste_cascade, page_key, paste_shift_px, record_paste,
};
use crate::slides::pdf_export::{
    ExportPdfLink, ExportPdfPage, ExportSlidesPdfOptions, PDF_EXPORT_HEIGHT_IN,
    PDF_EXPORT_TIMEOUT_MS, PRINT_READY_SCRIPT, PdfExportWindow, Step, build_pdf_export_html,
    build_pdf_link_overlays, export_page_width_in, export_slides_pdf,
};
use crate::slides::picture_frame::{
    DEFAULT_PICTURE_DPI, ImageDpi, PictureFrameOptions, picture_frame,
};
use crate::slides::save_as_formats::{
    SaveAsImageTargets, resolve_slides_save_as_pick, slides_save_as_filters,
    slides_save_as_suggestion,
};
use crate::slides::seed_queue::{SeedEntry, SeedQueue, SlidesSeedOptions};
use crate::slides::template_selection::{TemplateSelection, TemplateSelectionKind};
use crate::slides::template_selection_store::{
    TEMPLATE_SELECTION_FILE, TEMPLATE_SELECTION_MAX_DOCUMENTS,
    TEMPLATE_SELECTION_TOUCH_INTERVAL_MS, TemplateSelectionDocument, TemplateSelectionMemory,
    TemplateSelectionStore, TemplateSelectionStoreOptions,
};
use crate::slides::video_size::{Frame, Point, Size, audio_frame, video_frame, video_size};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "cfb-sniff.isCfbHeader" => hex_arg(args, 0).map(|b| Some(Value::Bool(is_cfb_header(&b)))),
        "cfb-sniff.cfbKind" => hex_arg(args, 0)
            .map(|b| Some(cfb_kind(&b).map_or(Value::Null, |k| Value::from(k.as_str())))),

        "slides/export-images.buildExportImagePaths" => export_images(args),

        "font-scan.scanFontDirs" => font_scan(args),

        "generated-page-temp.GENERATED_PAGE_TTL_MS" => Ok(Some(num(GENERATED_PAGE_TTL_MS))),
        "generated-page-temp.cleanupExpiredGeneratedPages" => cleanup(args),

        "jpeg-orientation.neutralizeJpegOrientation" => {
            hex_arg(args, 0).map(|b| Some(Value::from(hex(&neutralize_jpeg_orientation(&b)))))
        }

        "media-mime.sniffImageMime" => {
            hex_arg(args, 0).map(|b| Some(sniff_image_mime(&b).map_or(Value::Null, Value::from)))
        }
        "media-mime.rasterImageExt" => {
            hex_arg(args, 0).map(|b| Some(raster_image_ext(&b).map_or(Value::Null, Value::from)))
        }
        "media-mime.displayMime" => display_mime_call(args),

        "metafile-fonts.MAX_METAFILE_GUNZIP_BYTES" => {
            Ok(Some(num(MAX_METAFILE_GUNZIP_BYTES as f64)))
        }
        "metafile-fonts.scanMetafileFonts" => {
            hex_arg(args, 0).map(|b| Some(fonts_json(&scan_metafile_fonts(&b))))
        }
        "metafile-fonts.listMetafileFonts" => list_fonts(args),

        "mp4-audio-sniff.audioSampleFormats" => hex_arg(args, 0).map(|b| {
            Some(Value::Array(
                audio_sample_formats(&b)
                    .into_iter()
                    .map(Value::from)
                    .collect(),
            ))
        }),
        "mp4-audio-sniff.mp4VideoSize" => {
            hex_arg(args, 0).map(|b| Some(mp4_video_size(&b).map_or(Value::Null, size_json)))
        }
        "mp4-audio-sniff.unplayableAudioCodec" => hex_arg(args, 0)
            .map(|b| Some(unplayable_audio_codec(&b).map_or(Value::Null, Value::from))),

        "paste-cascade.newPasteCascade" => new_cascade(args),
        "paste-cascade.pageKey" => page_key_call(args),
        "paste-cascade.pasteShiftPx" => cascade_script(args, false),
        "paste-cascade.recordPaste" => cascade_script(args, true),

        "slides/pdf-export.buildPdfLinkOverlays" => overlays(args),
        "slides/pdf-export.buildPdfExportHtml" => export_html(args),
        "slides/pdf-export.PRINT_READY_SCRIPT" => Ok(Some(Value::from(PRINT_READY_SCRIPT))),
        "slides/pdf-export.PDF_EXPORT_HEIGHT_IN" => Ok(Some(num(PDF_EXPORT_HEIGHT_IN))),
        "slides/pdf-export.PDF_EXPORT_TIMEOUT_MS" => Ok(Some(num(PDF_EXPORT_TIMEOUT_MS))),
        "slides/pdf-export.exportPageWidthIn" => width_in(args),
        "slides/pdf-export.exportSlidesPdf" => export_pdf(args, cx),

        "picture-frame.DEFAULT_PICTURE_DPI" => Ok(Some(num(DEFAULT_PICTURE_DPI))),
        "picture-frame.pictureFrame" => picture_frame_call(args),

        "slides/save-as-formats.slidesSaveAsFilters" => save_as_filters(args),
        "slides/save-as-formats.slidesSaveAsSuggestion" => {
            str_arg(args, 0).map(|p| Some(Value::from(slides_save_as_suggestion(p))))
        }
        "slides/save-as-formats.resolveSlidesSaveAsPick" => str_arg(args, 0).map(|p| {
            let pick = resolve_slides_save_as_pick(p);
            let mut out = Map::new();
            out.insert("kind".into(), Value::from(pick.kind));
            out.insert("path".into(), Value::from(pick.path));
            Some(Value::Object(out))
        }),
        "slides/save-as-formats.SaveAsImageTargets" => image_targets(args),

        "seed-queue.queueSlidesSeedFor"
        | "seed-queue.takeSlidesSeed"
        | "seed-queue.takeSlidesSeedEntry" => seed_script(args),

        "template-selection-store.TEMPLATE_SELECTION_FILE" => {
            Ok(Some(Value::from(TEMPLATE_SELECTION_FILE)))
        }
        "template-selection-store.TEMPLATE_SELECTION_MAX_DOCUMENTS" => {
            Ok(Some(num(TEMPLATE_SELECTION_MAX_DOCUMENTS)))
        }
        "template-selection-store.TEMPLATE_SELECTION_TOUCH_INTERVAL_MS" => {
            Ok(Some(num(TEMPLATE_SELECTION_TOUCH_INTERVAL_MS)))
        }
        "template-selection-store.TemplateSelectionStore" => store_script(args, cx),
        "template-selection-store.TemplateSelectionMemory" => memory_script(args, cx),

        "video-size.videoSize" => video_size_call(args),
        "video-size.videoFrame" => video_frame_call(args),
        "video-size.audioFrame" => audio_frame_call(args),

        _ => return None,
    })
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Result<Vec<u8>, CallError> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return Err(bad("hex"));
    }
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).map_err(|_| bad("hex")))
        .collect()
}

fn hex_arg(args: &[Value], i: usize) -> Result<Vec<u8>, CallError> {
    unhex(str_arg(args, i)?)
}

fn f64_of(value: Option<&Value>, what: &str) -> Result<f64, CallError> {
    value.and_then(Value::as_f64).ok_or_else(|| bad(what))
}

fn num_arg(args: &[Value], i: usize) -> Result<f64, CallError> {
    f64_of(arg(args, i), "a number")
}

/// a key that is a number, or `None` where it is missing or `null`
fn opt_f64(value: &Value, key: &str) -> Result<Option<f64>, CallError> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_f64().map(Some).ok_or_else(|| bad(key)),
    }
}

fn string_list(value: Option<&Value>) -> Result<Vec<String>, CallError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list"))?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad("a string")))
        .collect()
}

fn size_of(value: Option<&Value>) -> Result<Size, CallError> {
    let value = value.ok_or_else(|| bad("a size"))?;
    Ok(Size {
        width: f64_of(value.get("width"), "width")?,
        height: f64_of(value.get("height"), "height")?,
    })
}

fn point_of(value: Option<&Value>) -> Result<Option<Point>, CallError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(Point {
            x: f64_of(v.get("x"), "x")?,
            y: f64_of(v.get("y"), "y")?,
        })),
    }
}

fn size_json(size: VideoSize) -> Value {
    let mut out = Map::new();
    out.insert("width".into(), num(size.width));
    out.insert("height".into(), num(size.height));
    Value::Object(out)
}

fn frame_json(frame: Frame) -> Value {
    let mut out = Map::new();
    out.insert("x".into(), num(frame.x));
    out.insert("y".into(), num(frame.y));
    out.insert("cx".into(), num(frame.cx));
    out.insert("cy".into(), num(frame.cy));
    Value::Object(out)
}

fn strings(items: Vec<String>) -> Value {
    Value::Array(items.into_iter().map(Value::from).collect())
}

/// `[dir, baseName, count, ext]`; a `null` count is `Math.max(0, null)`, 0
fn export_images(args: &[Value]) -> Answer {
    let count = match arg(args, 2) {
        Some(Value::Null) => 0.0,
        other => f64_of(other, "a count")?,
    };
    Ok(Some(strings(build_export_image_paths(
        str_arg(args, 0)?,
        str_arg(args, 1)?,
        count,
        str_arg(args, 3)?,
    ))))
}

/// `[tasks, deadlineMs]`
fn font_scan(args: &[Value]) -> Answer {
    let tasks = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("tasks"))?
        .iter()
        .map(|task| {
            let text = |key: &str| {
                task.get(key)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| bad(key))
            };
            match task.get("kind").and_then(Value::as_str) {
                Some("flat") => Ok(ScanTask::Flat { dir: text("dir")? }),
                Some("cloud") => Ok(ScanTask::Cloud {
                    base: text("base")?,
                    sub: text("sub")?,
                }),
                _ => Err(bad("a task kind")),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let results = scan_font_dirs(&tasks, num_arg(args, 1)?);
    Ok(Some(Value::Array(
        results
            .into_iter()
            .map(|result| match result {
                None => Value::Null,
                Some(ScanResult::Flat { files }) => {
                    let mut out = Map::new();
                    out.insert("kind".into(), Value::from("flat"));
                    out.insert("files".into(), strings(files));
                    Value::Object(out)
                }
                Some(ScanResult::Cloud { roots }) => {
                    let roots = roots
                        .into_iter()
                        .map(|root| {
                            let families = root
                                .families
                                .into_iter()
                                .map(|(family, files)| {
                                    Value::Array(vec![Value::from(family), strings(files)])
                                })
                                .collect();
                            let mut out = Map::new();
                            out.insert("root".into(), Value::from(root.root));
                            out.insert("families".into(), Value::Array(families));
                            Value::Object(out)
                        })
                        .collect();
                    let mut out = Map::new();
                    out.insert("kind".into(), Value::from("cloud"));
                    out.insert("roots".into(), Value::Array(roots));
                    Value::Object(out)
                }
            })
            .collect(),
    )))
}

/// `[tempRoot, now]`
fn cleanup(args: &[Value]) -> Answer {
    Ok(Some(strings(cleanup_expired_generated_pages(
        str_arg(args, 0)?,
        num_arg(args, 1)?,
    ))))
}

/// `[mediaRef, hex]`: a function or `Object.prototype` found in the table has
/// no string form: the function is no value, the prototype is `{}`
fn display_mime_call(args: &[Value]) -> Answer {
    let bytes = hex_arg(args, 1)?;
    Ok(match display_mime(str_arg(args, 0)?, &bytes) {
        DisplayMime::Mime(mime) => Some(Value::from(mime)),
        DisplayMime::ObjectConstructor => None,
        DisplayMime::ObjectPrototype => Some(Value::Object(Map::new())),
    })
}

fn fonts_json(fonts: &[MetafileFontRequest]) -> Value {
    Value::Array(
        fonts
            .iter()
            .map(|f| {
                let mut out = Map::new();
                out.insert("family".into(), Value::from(f.family.as_str()));
                out.insert("bold".into(), Value::Bool(f.bold));
                out.insert("italic".into(), Value::Bool(f.italic));
                Value::Object(out)
            })
            .collect(),
    )
}

/// `[[path, hex], ...]`: the entries of the archive in their order
fn list_fonts(args: &[Value]) -> Answer {
    let entries = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("entries"))?
        .iter()
        .map(|entry| {
            let path = entry
                .get(0)
                .and_then(Value::as_str)
                .ok_or_else(|| bad("a path"))?
                .to_owned();
            let bytes = unhex(
                entry
                    .get(1)
                    .and_then(Value::as_str)
                    .ok_or_else(|| bad("hex"))?,
            )?;
            Ok((path, bytes))
        })
        .collect::<Result<Vec<_>, CallError>>()?;
    Ok(Some(fonts_json(&list_metafile_fonts(&entries))))
}

fn counts_json(clip: &PasteCascade) -> Value {
    Value::Array(
        clip.counts
            .iter()
            .map(|(key, count)| Value::Array(vec![Value::from(key), num(*count)]))
            .collect(),
    )
}

fn cascade_of(args: &[Value]) -> Result<PasteCascade, CallError> {
    let source = match arg(args, 0) {
        None | Some(Value::Null) => None,
        Some(Value::String(key)) => Some(key.clone()),
        Some(_) => return Err(bad("a source key")),
    };
    let mut clip = new_paste_cascade(source);
    for key in string_list(arg(args, 1))? {
        record_paste(&mut clip, &key);
    }
    Ok(clip)
}

/// `[sourceKey | null]`: `{ sourceKey, counts }` with the counts as entries
fn new_cascade(args: &[Value]) -> Answer {
    let clip = cascade_of(&[
        arg(args, 0).cloned().unwrap_or(Value::Null),
        Value::Array(vec![]),
    ])?;
    let mut out = Map::new();
    out.insert(
        "sourceKey".into(),
        clip.source_key.clone().map_or(Value::Null, Value::from),
    );
    out.insert("counts".into(), counts_json(&clip));
    Ok(Some(Value::Object(out)))
}

fn page_key_call(args: &[Value]) -> Answer {
    Ok(Some(Value::from(page_key(
        num_arg(args, 0)?,
        num_arg(args, 1)?,
    ))))
}

/// `[sourceKey | null, records, targetKey]`: a clipboard with those pastes
/// recorded; `pasteShiftPx` answers the shift of the target, `recordPaste`
/// records one more there and answers the counts
fn cascade_script(args: &[Value], record: bool) -> Answer {
    let mut clip = cascade_of(args)?;
    let target = str_arg(args, 2)?;
    if record {
        record_paste(&mut clip, target);
        Ok(Some(counts_json(&clip)))
    } else {
        Ok(Some(num(paste_shift_px(&clip, target))))
    }
}

fn link_of(value: &Value) -> Result<ExportPdfLink, CallError> {
    // a `null` is a number JSON cannot carry: NaN
    let n = |key: &str| match value.get(key) {
        Some(Value::Null) => Ok(f64::NAN),
        other => f64_of(other, key),
    };
    Ok(ExportPdfLink {
        x: n("x")?,
        y: n("y")?,
        w: n("w")?,
        h: n("h")?,
        href: value
            .get("href")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("href"))?
            .to_owned(),
    })
}

fn links_of(value: Option<&Value>) -> Result<Option<Vec<ExportPdfLink>>, CallError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => Ok(Some(
            items.iter().map(link_of).collect::<Result<Vec<_>, _>>()?,
        )),
        Some(_) => Err(bad("links")),
    }
}

fn page_links_of(value: Option<&Value>) -> Result<Option<Vec<Vec<ExportPdfLink>>>, CallError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => Ok(Some(
            items
                .iter()
                .map(|page| links_of(Some(page)).map(Option::unwrap_or_default))
                .collect::<Result<Vec<_>, _>>()?,
        )),
        Some(_) => Err(bad("links")),
    }
}

fn pages_of(value: Option<&Value>) -> Result<Vec<ExportPdfPage>, CallError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| bad("pages"))?
        .iter()
        .map(|page| {
            if let Some(svg) = page.get("svg").and_then(Value::as_str) {
                Ok(ExportPdfPage::Svg(svg.to_owned()))
            } else if let Some(png) = page.get("png").and_then(Value::as_str) {
                Ok(ExportPdfPage::Png(png.to_owned()))
            } else {
                Err(bad("a page"))
            }
        })
        .collect()
}

fn optional_str(value: Option<&Value>) -> Result<Option<String>, CallError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(bad("a string")),
    }
}

/// `[links | null]`
fn overlays(args: &[Value]) -> Answer {
    let links = links_of(arg(args, 0))?;
    Ok(Some(Value::from(build_pdf_link_overlays(links.as_deref()))))
}

/// `[pages, widthIn, heightIn, links | null, fontCss | null]`
fn export_html(args: &[Value]) -> Answer {
    let pages = pages_of(arg(args, 0))?;
    let links = page_links_of(arg(args, 3))?;
    let font_css = optional_str(arg(args, 4))?;
    Ok(Some(Value::from(build_pdf_export_html(
        &pages,
        num_arg(args, 1)?,
        num_arg(args, 2)?,
        links.as_deref(),
        font_css.as_deref(),
    ))))
}

/// `[widthPx, heightPx]`; a `null` is a number JSON cannot carry (NaN)
fn width_in(args: &[Value]) -> Answer {
    let n = |i: usize| match arg(args, i) {
        Some(Value::Null) => Ok(f64::NAN),
        other => f64_of(other, "a number"),
    };
    Ok(Some(num(export_page_width_in(n(0)?, n(1)?))))
}

// ---- exportSlidesPdf ----

type Logs = RefCell<Vec<Vec<Value>>>;

/// `/seuoffice-slides-pdf-<6 random characters>` written `<rand>`
fn mask_rand(text: &str) -> String {
    let re = jscompat::js_regex!(r"seuoffice-slides-pdf-[A-Za-z0-9]{6}", "g");
    re.replace_all(text, |_| "seuoffice-slides-pdf-<rand>".to_owned())
}

fn mask_value(value: &mut Value) {
    match value {
        Value::String(text) => *text = mask_rand(text),
        Value::Array(items) => items.iter_mut().for_each(mask_value),
        Value::Object(map) => map.values_mut().for_each(mask_value),
        _ => {}
    }
}

fn os_tmpdir() -> String {
    let dir = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "/tmp".to_owned());
    if dir.len() > 1 && dir.ends_with('/') {
        dir[..dir.len() - 1].to_owned()
    } else {
        dir
    }
}

struct FakePdfWindow<'a> {
    script: &'a Value,
    logs: &'a Logs,
    work_dir: &'a RefCell<Option<String>>,
}

impl FakePdfWindow<'_> {
    fn log(&self, line: Vec<Value>) {
        self.logs.borrow_mut().push(line);
    }
    fn mode(&self, key: &str) -> Option<&str> {
        self.script.get(key).and_then(Value::as_str)
    }
    fn step<T>(&self, key: &str, ok: impl FnOnce() -> T, failure: &str) -> Step<T> {
        match self.mode(key) {
            Some("throws") => Step::Done(Err(JsError::plain(failure))),
            Some("hangs") => Step::Hangs,
            _ => Step::Done(Ok(ok())),
        }
    }
}

impl PdfExportWindow for FakePdfWindow<'_> {
    fn load_file(&mut self, path: &str) -> Step<()> {
        *self.work_dir.borrow_mut() = path.rsplit_once('/').map(|(dir, _)| dir.to_owned());
        let html = std::fs::read_to_string(path).unwrap_or_default();
        self.log(vec![
            Value::from("loadFile"),
            Value::from(mask_rand(path)),
            Value::from(html),
        ]);
        self.step("loadFile", || (), "load failed")
    }

    fn execute_javascript(&mut self, script: &str, user_gesture: bool) -> Step<()> {
        self.log(vec![
            Value::from("executeJavaScript"),
            Value::from(script),
            Value::Bool(user_gesture),
        ]);
        self.step("executeJavaScript", || (), "execute failed")
    }

    fn print_to_pdf(&mut self, options: &Value) -> Step<Vec<u8>> {
        self.log(vec![Value::from("printToPDF"), options.clone()]);
        let pdf = self
            .script
            .get("pdfHex")
            .and_then(Value::as_str)
            .and_then(|text| unhex(text).ok())
            .unwrap_or_default();
        self.step("printToPDF", || pdf, "printToPDF threw")
    }

    fn destroy(&mut self) -> Result<(), JsError> {
        self.log(vec![Value::from("destroy")]);
        if matches!(self.script.get("destroyThrows"), Some(Value::Bool(true))) {
            return Err(JsError::plain("destroy threw"));
        }
        Ok(())
    }
}

/// `[{ pages, widthPx, heightPx, filePath, links?, fontCss?, timeoutMs?, script }]`
fn export_pdf(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("the options"))?;
    let script = spec.get("script").ok_or_else(|| bad("a script"))?;
    let pages = pages_of(spec.get("pages"))?;
    let links = page_links_of(spec.get("links"))?;
    let font_css = optional_str(spec.get("fontCss"))?;
    let file_path = spec
        .get("filePath")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("filePath"))?;
    let tmp = os_tmpdir();
    let options = ExportSlidesPdfOptions {
        pages: &pages,
        width_px: f64_of(spec.get("widthPx"), "widthPx")?,
        height_px: f64_of(spec.get("heightPx"), "heightPx")?,
        file_path,
        links: links.as_deref(),
        font_css: font_css.as_deref(),
        timeout_ms: opt_f64(spec, "timeoutMs")?.unwrap_or(PDF_EXPORT_TIMEOUT_MS),
        tmp_dir: &tmp,
    };
    let logs: Logs = RefCell::new(Vec::new());
    let work_dir: RefCell<Option<String>> = RefCell::new(None);
    let create = || -> Result<FakePdfWindow<'_>, JsError> {
        logs.borrow_mut().push(vec![Value::from("createWindow")]);
        if matches!(script.get("createWindow"), Some(Value::String(mode)) if mode == "throws") {
            return Err(JsError::plain("createWindow threw"));
        }
        Ok(FakePdfWindow {
            script,
            logs: &logs,
            work_dir: &work_dir,
        })
    };
    let mut open = |path: &str| -> Result<(), JsError> {
        logs.borrow_mut()
            .push(vec![Value::from("openExportedPdf"), Value::from(path)]);
        if matches!(script.get("openThrows"), Some(Value::Bool(true))) {
            return Err(JsError::plain("open threw"));
        }
        Ok(())
    };
    let result = export_slides_pdf(&options, create, &mut open);
    if let Some(dir) = work_dir.borrow().as_deref() {
        let _ = rm_recursive_force(dir);
    }
    cx.logs
        .extend(logs.into_inner().into_iter().map(|mut line| {
            line.iter_mut().for_each(mask_value);
            line
        }));
    match result {
        Ok(result) => {
            let mut out = Map::new();
            out.insert("ok".into(), Value::Bool(result.ok));
            if let Some(path) = result.path {
                out.insert("path".into(), Value::from(path));
            }
            if let Some(error) = result.error {
                out.insert("error".into(), Value::from(error));
            }
            let mut value = Value::Object(out);
            mask_value(&mut value);
            Ok(Some(value))
        }
        Err(error) => Err(CallError {
            code: error.code,
            message: mask_rand(&error.message),
        }),
    }
}

// ---- picture-frame, video-size ----

/// `[slide, naturalPx | null, dpi | null, fallbackDpi | null, options | null]`
fn picture_frame_call(args: &[Value]) -> Answer {
    let slide = size_of(arg(args, 0))?;
    let natural = match arg(args, 1) {
        None | Some(Value::Null) => None,
        other => Some(size_of(other)?),
    };
    let dpi = match arg(args, 2) {
        None | Some(Value::Null) => None,
        Some(v) => Some(ImageDpi {
            x: f64_of(v.get("x"), "x")?,
            y: f64_of(v.get("y"), "y")?,
        }),
    };
    let fallback = match arg(args, 3) {
        None | Some(Value::Null) => DEFAULT_PICTURE_DPI,
        other => f64_of(other, "fallbackDpi")?,
    };
    let options = match arg(args, 4) {
        None | Some(Value::Null) => PictureFrameOptions::default(),
        Some(v) => PictureFrameOptions {
            center: point_of(v.get("center"))?,
            min_emu: opt_f64(v, "minEmu")?,
        },
    };
    Ok(Some(frame_json(picture_frame(
        slide, natural, dpi, fallback, options,
    ))))
}

/// `[hex, ext]`
fn video_size_call(args: &[Value]) -> Answer {
    let bytes = hex_arg(args, 0)?;
    Ok(Some(
        video_size(&bytes, str_arg(args, 1)?).map_or(Value::Null, size_json),
    ))
}

/// `[slide, natural | null, center | null]`
fn video_frame_call(args: &[Value]) -> Answer {
    let natural = match arg(args, 1) {
        None | Some(Value::Null) => None,
        other => Some(size_of(other)?),
    };
    Ok(Some(frame_json(video_frame(
        size_of(arg(args, 0))?,
        natural,
        point_of(arg(args, 2))?,
    ))))
}

/// `[slide, center | null]`
fn audio_frame_call(args: &[Value]) -> Answer {
    Ok(Some(frame_json(audio_frame(
        size_of(arg(args, 0))?,
        point_of(arg(args, 1))?,
    ))))
}

// ---- save-as-formats ----

/// `[prefix]`: the label function answers `<prefix>:<key>`
fn save_as_filters(args: &[Value]) -> Answer {
    let prefix = str_arg(args, 0)?;
    let label = |key: &str| format!("{prefix}:{key}");
    let filters = slides_save_as_filters(&label);
    Ok(Some(Value::Array(
        filters
            .into_iter()
            .map(|f| {
                let mut out = Map::new();
                out.insert("name".into(), Value::from(f.name));
                out.insert("extensions".into(), strings(f.extensions));
                Value::Object(out)
            })
            .collect(),
    )))
}

/// `[ops]`: `{ op: "authorize", wcId, path }`, `{ op: "take", wcId, path, count }`
/// (a list of paths, `null`, or `{ throws }` for the `RangeError`) and
/// `{ op: "forget", wcId }`; the answer is one result per op
fn image_targets(args: &[Value]) -> Answer {
    let ops = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let mut targets = SaveAsImageTargets::new();
    let mut results = Vec::new();
    for op in ops {
        let wc_id = f64_of(op.get("wcId"), "wcId")?;
        let path = || {
            op.get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("path"))
        };
        match op.get("op").and_then(Value::as_str) {
            Some("authorize") => {
                targets.authorize(wc_id, path()?);
                results.push(Value::Null);
            }
            Some("take") => {
                let count = match op.get("count") {
                    Some(Value::Null) => f64::NAN,
                    other => f64_of(other, "count")?,
                };
                results.push(match targets.take(wc_id, path()?, count) {
                    Ok(Some(paths)) => strings(paths),
                    Ok(None) => Value::Null,
                    Err(error) => {
                        let mut out = Map::new();
                        out.insert("throws".into(), Value::from(error.0));
                        Value::Object(out)
                    }
                });
            }
            Some("forget") => {
                targets.forget(wc_id);
                results.push(Value::Null);
            }
            _ => return Err(bad("an op")),
        }
    }
    Ok(Some(Value::Array(results)))
}

// ---- seed-queue ----

struct FakeContents {
    id: f64,
    destroyed: bool,
    /// the listeners `once('destroyed')` registered
    listeners: u32,
}

impl HandoffWebContents for FakeContents {
    fn id(&self) -> f64 {
        self.id
    }
    fn is_destroyed(&self) -> bool {
        self.destroyed
    }
    fn once_destroyed(&mut self) {
        self.listeners += 1;
    }
}

fn identity_of(value: &Value) -> Result<RecoveryIdentity, CallError> {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| bad(key))
    };
    let kind: RecoveryEditorKind = text("kind")?;
    if value
        .as_object()
        .is_some_and(|o| o.contains_key("untitledId"))
    {
        return Ok(RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
            kind,
            untitled_id: text("untitledId")?,
            ext: text("ext")?,
        }));
    }
    Ok(RecoveryIdentity::File(RecoveryFileIdentity {
        kind,
        file_path: text("filePath")?,
    }))
}

fn identity_json(identity: &RecoveryIdentity) -> Value {
    let mut out = Map::new();
    match identity {
        RecoveryIdentity::File(f) => {
            out.insert("kind".into(), Value::from(f.kind.as_str()));
            out.insert("filePath".into(), Value::from(f.file_path.as_str()));
        }
        RecoveryIdentity::Untitled(u) => {
            out.insert("kind".into(), Value::from(u.kind.as_str()));
            out.insert("untitledId".into(), Value::from(u.untitled_id.as_str()));
            out.insert("ext".into(), Value::from(u.ext.as_str()));
        }
    }
    Value::Object(out)
}

fn seed_options_of(value: Option<&Value>) -> Result<SlidesSeedOptions, CallError> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(SlidesSeedOptions::default());
    };
    Ok(SlidesSeedOptions {
        ask_path_on_first_save: match value.get("askPathOnFirstSave") {
            None | Some(Value::Null) => None,
            Some(Value::Bool(flag)) => Some(*flag),
            Some(_) => return Err(bad("askPathOnFirstSave")),
        },
        suggested_name: optional_str(value.get("suggestedName"))?,
        recovery_id: match value.get("recoveryId") {
            None | Some(Value::Null) => None,
            Some(id) => Some(identity_of(id)?),
        },
        password: optional_str(value.get("password"))?,
    })
}

fn seed_options_json(options: &SlidesSeedOptions) -> Value {
    let mut out = Map::new();
    if let Some(flag) = options.ask_path_on_first_save {
        out.insert("askPathOnFirstSave".into(), Value::Bool(flag));
    }
    if let Some(name) = &options.suggested_name {
        out.insert("suggestedName".into(), Value::from(name.as_str()));
    }
    if let Some(id) = &options.recovery_id {
        out.insert("recoveryId".into(), identity_json(id));
    }
    if let Some(password) = &options.password {
        out.insert("password".into(), Value::from(password.as_str()));
    }
    Value::Object(out)
}

fn seed_entry_json(entry: SeedEntry) -> Value {
    let mut out = Map::new();
    out.insert("deck".into(), Value::from(hex(&entry.deck)));
    out.insert("options".into(), seed_options_json(&entry.options));
    Value::Object(out)
}

/// `[ops]`: `{ op: "queue", id, destroyed, deck, options }` (answers how many
/// listeners the contents holds), `{ op: "emit", c }` (the `destroyed` event
/// of the c-th contents queued; answers how many listeners it called),
/// `{ op: "take", id }` and `{ op: "takeEntry", id }`; one result per op
fn seed_script(args: &[Value]) -> Answer {
    let ops = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let mut queue = SeedQueue::new();
    let mut contents: Vec<FakeContents> = Vec::new();
    let mut results = Vec::new();
    for op in ops {
        match op.get("op").and_then(Value::as_str) {
            Some("queue") => {
                let mut fake = FakeContents {
                    id: f64_of(op.get("id"), "id")?,
                    destroyed: matches!(op.get("destroyed"), Some(Value::Bool(true))),
                    listeners: 0,
                };
                let deck = unhex(
                    op.get("deck")
                        .and_then(Value::as_str)
                        .ok_or_else(|| bad("deck"))?,
                )?;
                let options = seed_options_of(op.get("options"))?;
                queue.queue_slides_seed_for(&mut fake, deck, options);
                results.push(Value::from(fake.listeners));
                contents.push(fake);
            }
            Some("emit") => {
                let c = f64_of(op.get("c"), "c")? as usize;
                let fake = contents.get_mut(c).ok_or_else(|| bad("c"))?;
                let fired = fake.listeners;
                for _ in 0..fired {
                    queue.forget(fake.id);
                }
                fake.listeners = 0;
                results.push(Value::from(fired));
            }
            Some("take") => {
                let id = f64_of(op.get("id"), "id")?;
                results.push(
                    queue
                        .take_slides_seed(id)
                        .map_or(Value::Null, |deck| Value::from(hex(&deck))),
                );
            }
            Some("takeEntry") => {
                let id = f64_of(op.get("id"), "id")?;
                results.push(
                    queue
                        .take_slides_seed_entry(id)
                        .map_or(Value::Null, seed_entry_json),
                );
            }
            _ => return Err(bad("an op")),
        }
    }
    Ok(Some(Value::Array(results)))
}

// ---- template-selection-store ----

fn selection_json(selection: &TemplateSelection) -> Value {
    let mut out = Map::new();
    out.insert("kind".into(), Value::from(selection.kind.as_str()));
    out.insert("key".into(), Value::from(selection.key.as_str()));
    out.insert("adjustments".into(), strings(selection.adjustments.clone()));
    out.insert("updatedAt".into(), num(selection.updated_at));
    Value::Object(out)
}

fn optional_selection_json(selection: Option<TemplateSelection>) -> Value {
    selection.as_ref().map_or(Value::Null, selection_json)
}

fn error_json(error: &crate::node_fs::NodeError) -> Value {
    let mut out = Map::new();
    let mut inner = Map::new();
    inner.insert("code".into(), error.code.map_or(Value::Null, Value::from));
    inner.insert("message".into(), Value::from(error.message.as_str()));
    out.insert("error".into(), Value::Object(inner));
    Value::Object(out)
}

/// the options of a script: `userData`, `maxDocuments`, and a clock that
/// counts up from the clock of the call by one a call
fn store_options(
    script: &Value,
    cx: &Context,
) -> Result<(String, TemplateSelectionStoreOptions), CallError> {
    let user_data = script
        .get("userData")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("userData"))?
        .to_owned();
    let clock = Rc::new(Cell::new(cx.now_ms));
    let now: Box<dyn Fn() -> f64> = Box::new(move || {
        let t = clock.get();
        clock.set(t + 1.0);
        t
    });
    Ok((
        user_data,
        TemplateSelectionStoreOptions {
            max_documents: opt_f64(script, "maxDocuments")?,
            now: Some(now),
        },
    ))
}

fn selection_of_json(value: &Value) -> Result<TemplateSelection, CallError> {
    let kind = match value.get("kind").and_then(Value::as_str) {
        Some("builtin") => TemplateSelectionKind::Builtin,
        Some("saved") => TemplateSelectionKind::Saved,
        _ => return Err(bad("kind")),
    };
    Ok(TemplateSelection {
        kind,
        key: value
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("key"))?
            .to_owned(),
        adjustments: string_list(value.get("adjustments"))?,
        updated_at: f64_of(value.get("updatedAt"), "updatedAt")?,
    })
}

/// the `input` of an op as a JavaScript value; `None` is `undefined`
fn input_of(op: &Value) -> Option<JsonValue> {
    op.get("input").map(json_value_from_serde)
}

/// `[{ userData, maxDocuments?, ops }]`: ops are `get`, `set`, `put`, `copy`,
/// `move` on the store; one result per op, `{ error }` where it throws
fn store_script(args: &[Value], cx: &Context) -> Answer {
    let script = arg(args, 0).ok_or_else(|| bad("the script"))?;
    let (user_data, options) = store_options(script, cx)?;
    let store = TemplateSelectionStore::new(&user_data, options);
    let ops = script
        .get("ops")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let mut results = Vec::new();
    for op in ops {
        let path = |key: &str| op.get(key).and_then(Value::as_str).ok_or_else(|| bad(key));
        let result = match op.get("op").and_then(Value::as_str) {
            Some("get") => store.get(path("path")?).map(optional_selection_json),
            Some("set") => {
                let input = input_of(op);
                store
                    .set(path("path")?, input.as_ref())
                    .map(optional_selection_json)
            }
            Some("put") => {
                let selection = match op.get("selection") {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(selection_of_json(v)?),
                };
                store.put(path("path")?, selection).map(|()| Value::Null)
            }
            Some("copy") => store.copy(path("from")?, path("to")?).map(|()| Value::Null),
            Some("move") => store
                .move_record(path("from")?, path("to")?)
                .map(|()| Value::Null),
            _ => return Err(bad("an op")),
        };
        results.push(result.unwrap_or_else(|e| error_json(&e)));
    }
    Ok(Some(Value::Array(results)))
}

/// `[{ userData, maxDocuments?, docs: { name: path }, ops }]`: ops are
/// `get`, `set`, `follow`, `inherit`, `moved` on the memory, and `setPath`
/// which changes the `path` of a document as its window would
fn memory_script(args: &[Value], cx: &Context) -> Answer {
    let script = arg(args, 0).ok_or_else(|| bad("the script"))?;
    let (user_data, options) = store_options(script, cx)?;
    let mut memory = TemplateSelectionMemory::new(&user_data, options);
    let mut docs: Vec<(String, TemplateSelectionDocument)> = Vec::new();
    for (id, (name, path)) in script
        .get("docs")
        .and_then(Value::as_object)
        .ok_or_else(|| bad("docs"))?
        .iter()
        .enumerate()
    {
        docs.push((
            name.clone(),
            TemplateSelectionDocument {
                id: id as u64,
                path: path.as_str().ok_or_else(|| bad("a path"))?.to_owned(),
            },
        ));
    }
    let find = |docs: &[(String, TemplateSelectionDocument)], name: &str| {
        docs.iter()
            .position(|(n, _)| n == name)
            .ok_or_else(|| bad("a document"))
    };
    let ops = script
        .get("ops")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let mut results = Vec::new();
    for op in ops {
        let text = |key: &str| op.get(key).and_then(Value::as_str).ok_or_else(|| bad(key));
        let doc_at = |docs: &[(String, TemplateSelectionDocument)]| find(docs, text("doc")?);
        match op.get("op").and_then(Value::as_str) {
            Some("get") => {
                let at = doc_at(&docs)?;
                results.push(optional_selection_json(memory.get(&docs[at].1)));
            }
            Some("set") => {
                let at = doc_at(&docs)?;
                let input = input_of(op);
                results.push(optional_selection_json(
                    memory.set(&docs[at].1, input.as_ref()),
                ));
            }
            Some("follow") => {
                let at = doc_at(&docs)?;
                memory.follow(&docs[at].1, text("from")?, text("to")?);
                results.push(Value::Null);
            }
            Some("inherit") => {
                let at = doc_at(&docs)?;
                let previous = match op.get("previous") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(name)) => Some(docs[find(&docs, name)?].1.clone()),
                    Some(_) => return Err(bad("previous")),
                };
                memory.inherit(previous.as_ref(), &docs[at].1.clone());
                results.push(Value::Null);
            }
            Some("moved") => {
                memory.moved(text("old")?, text("new")?);
                results.push(Value::Null);
            }
            Some("setPath") => {
                let at = doc_at(&docs)?;
                docs[at].1.path = text("path")?.to_owned();
                results.push(Value::Null);
            }
            _ => return Err(bad("an op")),
        }
    }
    Ok(Some(Value::Array(results)))
}
