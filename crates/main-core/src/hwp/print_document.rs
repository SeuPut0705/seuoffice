//! `apps/hwp/src/main/print-document.ts`: printing a document. The pages as
//! the editor draws them for print (SVG), one after another in one HTML page
//! sized page by page, which a hidden window with scripts off turns into a PDF
//! or hands to the system print dialog.
//!
//! The TypeScript's async functions are one synchronous function each here;
//! the order of the calls on the file system and on the window is the same.
//! `os.tmpdir()` is the caller's `tmp_dir`.

use jscompat::node_path::host::join;
use jscompat::{js_regex, math_round, number_to_string, to_number, trim_start};
use serde_json::{Map, Value};

use super::ipc::{MAX_PRINT_CHARS, MAX_PRINT_PAGES, PrintPage};
use crate::node_fs::node_error;
use crate::packages::electron_utils::print_window::{
    JsError, PrintReport, mkdtemp, rm_recursive_force,
};

/// Paper sides in mm: ISO A3-A5, JIS B4-B5, US Letter, Legal and Tabloid.
const PAPER_SIDES_MM: [f64; 11] = [
    148.0, 182.0, 210.0, 215.9, 257.0, 279.4, 297.0, 355.6, 364.0, 420.0, 431.8,
];
/// A side within this of a paper side is that side. The file keeps lengths in
/// whole HWPUNIT and the editor gives pages to a tenth of a pixel, so an A4
/// page comes out 296.99 mm; printed so, a printer takes it for a paper it
/// does not have.
const PAPER_SNAP_MM: f64 = 0.05;

/// A page side in CSS pixels as mm, on the paper side it is meant to be when it is one.
pub fn side_mm(px: f64) -> f64 {
    let mm = (px * 25.4) / 96.0;
    PAPER_SIDES_MM
        .iter()
        .copied()
        .find(|side| (side - mm).abs() <= PAPER_SNAP_MM)
        .unwrap_or_else(|| math_round(mm * 1000.0) / 1000.0)
}

/// The page's ids made its own: every page names its clip paths from the same
/// counter, so pages put in one HTML would clip with each other's. References
/// go with them.
pub fn own_ids(svg: &str, prefix: &str) -> String {
    let ids = js_regex!(r#"\bid="([^"]+)""#, "g").replace_all(svg, |m| {
        format!("id=\"{prefix}{}\"", m.get(1).unwrap_or(""))
    });
    let urls = js_regex!(r"url\(#([^)\s]+)\)", "g").replace_all(&ids, |m| {
        format!("url(#{prefix}{})", m.get(1).unwrap_or(""))
    });
    js_regex!(r##"\bhref="#([^"]+)""##, "g").replace_all(&urls, |m| {
        format!("href=\"#{prefix}{}\"", m.get(1).unwrap_or(""))
    })
}

/// The picture types written out as files; any other picture stays in the page.
fn image_file_ext(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/bmp" => Some("bmp"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        _ => None,
    }
}

/// The file a picture of the job is written to, or `None` when it stays a data URL.
pub fn image_file(data_url: &str, index: f64) -> Option<(String, Vec<u8>)> {
    let found =
        js_regex!(r"^data:(image/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]*)$").exec(data_url)?;
    let ext = image_file_ext(found.get(1)?)?;
    Some((
        format!("image-{}.{ext}", number_to_string(index)),
        jscompat::buffer_from_base64(found.get(2)?),
    ))
}

/// `value.length` of a string: UTF-16 code units
fn units(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

fn is_side(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Number(number)) => number
            .as_f64()
            .is_some_and(|x| x.is_finite() && x > 0.0 && x < 100_000.0),
        _ => false,
    }
}

/// Why a job from the renderer is not printed, or `None` when it may be.
pub fn bad_job(job: Option<&Value>) -> Option<&'static str> {
    let map: Option<&Map<String, Value>> = match job {
        Some(Value::Object(map)) => Some(map),
        // an array is an object with none of the keys
        Some(Value::Array(_)) => None,
        _ => return Some("not a print job"),
    };
    let get = |key: &str| map.and_then(|map| map.get(key));
    if !matches!(get("mode"), Some(Value::String(mode)) if mode == "pdf" || mode == "print") {
        return Some("unknown print mode");
    }
    let pages = match get("pages") {
        Some(Value::Array(pages)) if !pages.is_empty() => pages,
        _ => return Some("no pages"),
    };
    if pages.len() > MAX_PRINT_PAGES {
        return Some("too many pages");
    }
    let images = match get("images") {
        Some(Value::Array(images)) if images.iter().all(Value::is_string) => images,
        _ => return Some("bad pictures"),
    };
    let mut chars: u64 = images.iter().filter_map(Value::as_str).map(units).sum();
    for page in pages {
        // `(page ?? {})` destructured: only an object has the keys
        let object = match page {
            Value::Object(object) => Some(object),
            _ => None,
        };
        let field = |key: &str| object.and_then(|object| object.get(key));
        let svg = match field("svg") {
            Some(Value::String(svg)) if trim_start(svg).starts_with("<svg") => svg,
            _ => return Some("bad page"),
        };
        if !is_side(field("width")) || !is_side(field("height")) {
            return Some("bad page size");
        }
        chars += units(svg);
    }
    if chars > MAX_PRINT_CHARS {
        return Some("too large");
    }
    None
}

/// Pages and pictures load from the job's own folder; nothing else is fetched or run.
const PRINT_CSP: &str = "default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; font-src file: data:; base-uri 'none'; form-action 'none'";

fn mm(value: f64) -> String {
    format!("{}mm", number_to_string(value))
}

/// The HTML of the pages: each page on a paper of its own size with no margin,
/// the page's pictures pointing at `picture(i)` (a file name next to the HTML,
/// or the data URL).
pub fn printable_html(pages: &[PrintPage], picture: &mut dyn FnMut(f64) -> String) -> String {
    let mut rules: Vec<String> = Vec::new();
    let mut body: Vec<String> = Vec::new();
    for (index, page) in pages.iter().enumerate() {
        let width = mm(side_mm(page.width));
        let height = mm(side_mm(page.height));
        rules.push(format!(
            "@page p{index} {{ size: {width} {height}; margin: 0; }}"
        ));
        rules.push(format!(
            ".p{index} {{ page: p{index}; width: {width}; height: {height}; }}"
        ));
        let owned = own_ids(&page.svg, &format!("p{index}-"));
        let svg = js_regex!(r#"\bhref="ieum-image:(\d+)""#, "g").replace_all(&owned, |m| {
            format!("href=\"{}\"", picture(to_number(m.get(1).unwrap_or(""))))
        });
        body.push(format!("<div class=\"page p{index}\">{svg}</div>"));
    }
    let mut lines: Vec<String> = vec![
        "<!DOCTYPE html>".to_owned(),
        "<html>".to_owned(),
        "<head>".to_owned(),
        "<meta charset=\"utf-8\">".to_owned(),
        format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{PRINT_CSP}\">"),
        // what is printed is the document: the same in either app theme
        "<style>".to_owned(),
        "* { margin: 0; padding: 0; }".to_owned(),
        "body { background: #fff; }".to_owned(),
        ".page { overflow: hidden; break-after: page; }".to_owned(),
        ".page:last-child { break-after: auto; }".to_owned(),
        ".page > svg { display: block; width: 100%; height: 100%; }".to_owned(),
    ];
    lines.extend(rules);
    lines.push("</style>".to_owned());
    lines.push("</head>".to_owned());
    lines.push(format!("<body>{}</body>", body.join("")));
    lines.push("</html>".to_owned());
    lines.join("\n")
}

/// `PrintWindow`: the methods of the window the TypeScript calls.
pub trait PrintWindow {
    fn load_file(&mut self, path: &str) -> Result<(), JsError>;
    /// `webContents.printToPDF(options)`
    fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, JsError>;
    /// `webContents.print(options, callback)`: the arguments the callback got;
    /// `Err` is a `print` that throws
    fn print(&mut self, options: &Value) -> Result<PrintReport, JsError>;
    fn destroy(&mut self) -> Result<(), JsError>;
}

/// `PrintJob` without its mode, which these functions do not read.
#[derive(Debug, Clone)]
pub struct PrintJob {
    pub pages: Vec<PrintPage>,
    pub images: Vec<String>,
}

/// Put the job in a folder of its own (the HTML and its pictures), load it in
/// the window `create_window` makes (hidden, scripts off) and run `use_` on
/// it. The window and the folder are gone afterwards, whatever happened.
fn with_print_window<T, W: PrintWindow>(
    job: &PrintJob,
    tmp_dir: &str,
    create_window: &mut dyn FnMut() -> Result<W, JsError>,
    use_: impl FnOnce(&mut W) -> Result<T, JsError>,
) -> Result<T, JsError> {
    let dir = mkdtemp(&join(&[tmp_dir, "ieum-hwp-print-"]))?;
    let mut win: Option<W> = None;
    let outcome = (|| -> Result<T, JsError> {
        let mut names: Vec<String> = Vec::new();
        for (index, data_url) in job.images.iter().enumerate() {
            match image_file(data_url, index as f64) {
                None => names.push(data_url.clone()),
                Some((name, bytes)) => {
                    let path = join(&[&dir, &name]);
                    std::fs::write(&path, bytes).map_err(|e| node_error(&e, "open", &path))?;
                    names.push(name);
                }
            }
        }
        let html_path = join(&[&dir, "print.html"]);
        let html = printable_html(&job.pages, &mut |index| {
            if index >= 0.0 && index.fract() == 0.0 {
                names.get(index as usize).cloned().unwrap_or_default()
            } else {
                String::new()
            }
        });
        std::fs::write(&html_path, html).map_err(|e| node_error(&e, "open", &html_path))?;
        let window = win.insert(create_window()?);
        window.load_file(&html_path)?;
        use_(window)
    })();
    if let Some(window) = win.as_mut() {
        window.destroy()?;
    }
    rm_recursive_force(&dir)?;
    outcome
}

/// The pages as PDF bytes, each page on its own paper.
pub fn print_job_to_pdf<W: PrintWindow>(
    job: &PrintJob,
    tmp_dir: &str,
    create_window: &mut dyn FnMut() -> Result<W, JsError>,
) -> Result<Vec<u8>, JsError> {
    with_print_window(job, tmp_dir, create_window, |win| {
        let mut margins = Map::new();
        for side in ["top", "bottom", "left", "right"] {
            margins.insert(side.to_owned(), Value::from(0));
        }
        let mut options = Map::new();
        options.insert("preferCSSPageSize".to_owned(), Value::Bool(true));
        options.insert("printBackground".to_owned(), Value::Bool(true));
        options.insert("margins".to_owned(), Value::Object(margins));
        win.print_to_pdf(&Value::Object(options))
    })
}

/// The pages to the system print dialog. Answers when the dialog is done:
/// `true` when they were sent to a printer, `false` when the user canceled.
pub fn print_job_to_printer<W: PrintWindow>(
    job: &PrintJob,
    tmp_dir: &str,
    create_window: &mut dyn FnMut() -> Result<W, JsError>,
) -> Result<bool, JsError> {
    with_print_window(job, tmp_dir, create_window, |win| {
        let mut margins = Map::new();
        margins.insert("marginType".to_owned(), Value::from("none"));
        let mut options = Map::new();
        options.insert("silent".to_owned(), Value::Bool(false));
        options.insert("printBackground".to_owned(), Value::Bool(true));
        options.insert("margins".to_owned(), Value::Object(margins));
        let report = win.print(&Value::Object(options))?;
        if report.success || js_regex!("cancel", "i").test(&report.failure_reason) {
            Ok(report.success)
        } else if report.failure_reason.is_empty() {
            Err(JsError::plain("print failed"))
        } else {
            Err(JsError::plain(report.failure_reason))
        }
    })
}
