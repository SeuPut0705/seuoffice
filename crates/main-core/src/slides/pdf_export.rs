//! `apps/slides/src/main/pdf-export.ts`.
//!
//! The hidden window is a [`PdfExportWindow`]: the methods the TypeScript calls
//! on it. A call that never settles is [`Step::Hangs`]: the watchdog timer of
//! the TypeScript then wins its race, which is the explicit step the timer
//! becomes here. `os.tmpdir()` is a parameter.

use jscompat::node_path::host::join;
use jscompat::{js_regex, math_round, number_to_string};
use serde_json::{Map, Number, Value};

use crate::node_fs::node_error;
use crate::packages::electron_utils::print_window::{JsError, rm_recursive_force};

/// one clickable overlay: fractions of the page box and the target
#[derive(Debug, Clone, PartialEq)]
pub struct ExportPdfLink {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub href: String,
}

/// `ExportPdfPage`: vector SVG markup or a base64 PNG fallback
#[derive(Debug, Clone, PartialEq)]
pub enum ExportPdfPage {
    Svg(String),
    Png(String),
}

/// What a call of the window did: settled, or never.
pub enum Step<T> {
    Done(Result<T, JsError>),
    Hangs,
}

/// `PdfExportWindow`
pub trait PdfExportWindow {
    fn load_file(&mut self, path: &str) -> Step<()>;
    /// `webContents.executeJavaScript(script, userGesture)`
    fn execute_javascript(&mut self, script: &str, user_gesture: bool) -> Step<()>;
    /// `webContents.printToPDF(options)`; `options` is the plain object the TypeScript passes
    fn print_to_pdf(&mut self, options: &Value) -> Step<Vec<u8>>;
    fn destroy(&mut self) -> Result<(), JsError>;
}

/// `ExportSlidesPdfResult`
#[derive(Debug, Clone, PartialEq)]
pub struct ExportSlidesPdfResult {
    pub ok: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Fraction (0..1) → CSS percentage; NaN/Infinity would corrupt the markup, so reject the rect.
fn pct(v: f64) -> Option<String> {
    if v.is_finite() {
        Some(format!(
            "{}%",
            number_to_string(math_round(v * 100000.0) / 1000.0)
        ))
    } else {
        None
    }
}

/// `buildPdfLinkOverlays(links)`
pub fn build_pdf_link_overlays(links: Option<&[ExportPdfLink]>) -> String {
    let Some(links) = links.filter(|links| !links.is_empty()) else {
        return String::new();
    };
    links
        .iter()
        .map(|l| {
            let (x, y, w, h) = (pct(l.x), pct(l.y), pct(l.w), pct(l.h));
            let (Some(x), Some(y), Some(w), Some(h)) = (x, y, w, h) else {
                return String::new();
            };
            if l.href.is_empty() {
                return String::new();
            }
            format!(
                "<a href=\"{}\" style=\"left:{x};top:{y};width:{w};height:{h}\"></a>",
                escape_attr(&l.href)
            )
        })
        .collect()
}

/// A `</style>` inside the font CSS would end the block early; it cannot occur in valid rules.
fn safe_css(css: Option<&str>) -> String {
    match css {
        Some(css) if !css.is_empty() => {
            js_regex!(r"<\/style", "gi").replace_all(css, |_| String::new())
        }
        _ => String::new(),
    }
}

fn page_markup(page: &ExportPdfPage) -> String {
    match page {
        ExportPdfPage::Svg(svg) => svg.clone(),
        ExportPdfPage::Png(png) => format!("<img src=\"data:image/png;base64,{png}\">"),
    }
}

/// `buildPdfExportHtml(pages, widthIn, heightIn, links, fontCss)`
pub fn build_pdf_export_html(
    pages: &[ExportPdfPage],
    width_in: f64,
    height_in: f64,
    links: Option<&[Vec<ExportPdfLink>]>,
    font_css: Option<&str>,
) -> String {
    let width_in = number_to_string(width_in);
    let height_in = number_to_string(height_in);
    let body: String = pages
        .iter()
        .enumerate()
        .map(|(i, page)| {
            let overlays = build_pdf_link_overlays(links.and_then(|l| l.get(i)).map(Vec::as_slice));
            format!(
                "<div class=\"page\" id=\"pg{}\">{}{}</div>",
                i + 1,
                page_markup(page),
                overlays
            )
        })
        .collect();
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>\n{}\n@page {{ size: {width_in}in {height_in}in; margin: 0; }}\nhtml, body {{ margin: 0; padding: 0; }}\n.page {{ position: relative; width: {width_in}in; height: {height_in}in; overflow: hidden; page-break-after: always; }}\n.page:last-child {{ page-break-after: auto; }}\n.page img, .page > svg {{ display: block; width: 100%; height: 100%; }}\n.page a {{ position: absolute; display: block; }}\n</style></head><body>{body}</body></html>",
        safe_css(font_css)
    )
}

/// Fonts and every bitmap decoded before printing, or pages print blank.
pub const PRINT_READY_SCRIPT: &str = r##"Promise.all([
  document.fonts.ready,
  ...Array.from(document.images).map((i) => i.decode().catch(() => {})),
  ...Array.from(document.querySelectorAll('svg image')).map((el) => {
    const href = el.getAttribute('href') || el.getAttribute('xlink:href')
    if (!href) return Promise.resolve()
    const img = new Image()
    img.src = href
    return img.decode().catch(() => {})
  }),
]).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))"##;

/// PDF page size: fixed 7.5in height, width by slide ratio
pub const PDF_EXPORT_HEIGHT_IN: f64 = 7.5;

/// `exportPageWidthIn(widthPx, heightPx)`
pub fn export_page_width_in(width_px: f64, height_px: f64) -> f64 {
    let ratio = if width_px.is_finite() && height_px.is_finite() && height_px > 0.0 {
        width_px / height_px
    } else {
        16.0 / 9.0
    };
    let safe = if ratio.is_finite() && ratio > 0.0 {
        jscompat::math_min(jscompat::math_max(ratio, 0.2), 5.0)
    } else {
        16.0 / 9.0
    };
    math_round(safe * PDF_EXPORT_HEIGHT_IN * 1000.0) / 1000.0
}

/// Hidden export window watchdog (ms)
pub const PDF_EXPORT_TIMEOUT_MS: f64 = 300_000.0;

/// `ExportSlidesPdfOptions`, without the two callbacks
pub struct ExportSlidesPdfOptions<'a> {
    pub pages: &'a [ExportPdfPage],
    pub width_px: f64,
    pub height_px: f64,
    pub file_path: &'a str,
    pub links: Option<&'a [Vec<ExportPdfLink>]>,
    pub font_css: Option<&'a str>,
    /// `timeoutMs`, `PDF_EXPORT_TIMEOUT_MS` when left out
    pub timeout_ms: f64,
    /// `os.tmpdir()`
    pub tmp_dir: &'a str,
}

fn number(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn print_options(width_in: f64, height_in: f64) -> Value {
    let mut page_size = Map::new();
    page_size.insert("width".into(), number(width_in));
    page_size.insert("height".into(), number(height_in));
    let mut margins = Map::new();
    for side in ["top", "bottom", "left", "right"] {
        margins.insert(side.into(), Value::from(0));
    }
    let mut options = Map::new();
    // The page size is already landscape (width > height); passing landscape would rotate a second time
    options.insert("landscape".into(), Value::Bool(false));
    options.insert("printBackground".into(), Value::Bool(true));
    options.insert("pageSize".into(), Value::Object(page_size));
    options.insert("margins".into(), Value::Object(margins));
    options.insert("preferCSSPageSize".into(), Value::Bool(false));
    Value::Object(options)
}

/// `String(err)` of an `Error`
fn error_text(error: &JsError) -> String {
    format!("Error: {}", error.message)
}

/// `exportSlidesPdf(options)`. `Err` is a rejection: `createWindow` throwing,
/// or `destroy` / the removal of the temp folder throwing in the `finally`.
pub fn export_slides_pdf<W: PdfExportWindow>(
    options: &ExportSlidesPdfOptions,
    create_window: impl FnOnce() -> Result<W, JsError>,
    open_exported_pdf: &mut dyn FnMut(&str) -> Result<(), JsError>,
) -> Result<ExportSlidesPdfResult, JsError> {
    // PDF page size: fixed 7.5in height, width by slide ratio (16:9 -> 13.333in, 4:3 -> 10in)
    let height_in = PDF_EXPORT_HEIGHT_IN;
    let width_in = export_page_width_in(options.width_px, options.height_px);
    let mut win = create_window()?;
    let mut temp_dir: Option<String> = None;
    let outcome = (|| -> Result<ExportSlidesPdfResult, JsError> {
        let dir =
            crate::node_fs::mkdtemp_random(&join(&[options.tmp_dir, "seuoffice-slides-pdf-"]))?;
        let dir = temp_dir.insert(dir).as_str();
        let html_path = join(&[dir, "slides.html"]);
        let html = build_pdf_export_html(
            options.pages,
            width_in,
            height_in,
            options.links,
            options.font_css,
        );
        std::fs::write(&html_path, html).map_err(|e| node_error(&e, "open", &html_path))?;
        let timed_out = || {
            JsError::plain(format!(
                "slides PDF export timed out after {}ms",
                number_to_string(options.timeout_ms)
            ))
        };
        match win.load_file(&html_path) {
            Step::Done(result) => result?,
            Step::Hangs => return Err(timed_out()),
        }
        match win.execute_javascript(PRINT_READY_SCRIPT, true) {
            Step::Done(result) => result?,
            Step::Hangs => return Err(timed_out()),
        }
        let pdf = match win.print_to_pdf(&print_options(width_in, height_in)) {
            Step::Done(result) => result?,
            Step::Hangs => return Err(timed_out()),
        };
        std::fs::write(options.file_path, pdf)
            .map_err(|e| node_error(&e, "open", options.file_path))?;
        open_exported_pdf(options.file_path)?;
        Ok(ExportSlidesPdfResult {
            ok: true,
            path: Some(options.file_path.to_owned()),
            error: None,
        })
    })();
    let result = outcome.unwrap_or_else(|error| ExportSlidesPdfResult {
        ok: false,
        path: None,
        error: Some(error_text(&error)),
    });
    // finally: the window goes first, then the temp folder, also when destroy threw
    let destroyed = win.destroy();
    let removed = match temp_dir.as_deref() {
        Some(dir) => rm_recursive_force(dir).map_err(JsError::from),
        None => Ok(()),
    };
    removed?;
    destroyed?;
    Ok(result)
}
