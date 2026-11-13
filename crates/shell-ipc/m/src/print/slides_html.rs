//! `apps/slides/src/shared/print-html.ts`: the page assembly of the slides
//! print window (`buildPrintDocumentHtml`, `printPageSizeIn`). The options hold
//! what the TypeScript read off the renderer's `PrintSlidesOp`, so an operand
//! of the wrong type behaves as it did there (a coercion or a TypeError).

use jscompat::{math_round, number_to_string, to_number};
use shell_contract::{IpcError, IpcValue};

use crate::value::field;

/// `PrintLayout`; anything else the renderer sent prints as a one-up handout
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    Full,
    Handout(u8),
    Notes,
    Other,
}

impl Layout {
    /// `op.layout ?? 'full'`
    fn of(value: &IpcValue) -> Layout {
        match value {
            IpcValue::Undefined | IpcValue::Null => Layout::Full,
            IpcValue::String(s) => match s.as_str() {
                "full" => Layout::Full,
                "handout2" => Layout::Handout(2),
                "handout3" => Layout::Handout(3),
                "handout4" => Layout::Handout(4),
                "handout6" => Layout::Handout(6),
                "handout9" => Layout::Handout(9),
                "notes" => Layout::Notes,
                _ => Layout::Other,
            },
            _ => Layout::Other,
        }
    }

    /// `printThumbnailsPerPage`
    fn per_page(self) -> u8 {
        match self {
            Layout::Handout(n) => n,
            _ => 1,
        }
    }
}

/// What `buildPrintDocumentHtml` and `printPageSizeIn` read from the op
pub struct PrintDoc<'a> {
    srcs: Vec<String>,
    pub ratio: f64,
    pub layout: Layout,
    notes: Option<&'a IpcValue>,
    pub landscape_asked: bool,
    vertical: bool,
    frame: bool,
}

fn type_error(message: String) -> IpcError {
    IpcError {
        name: Some("TypeError".into()),
        message,
    }
}

/// `Number(value)` for the operands the renderer typed as numbers
fn js_number(value: &IpcValue) -> f64 {
    match value {
        IpcValue::Number(n) => *n,
        IpcValue::String(s) => to_number(s),
        IpcValue::Bool(b) => f64::from(u8::from(*b)),
        IpcValue::Null => 0.0,
        _ => f64::NAN,
    }
}

/// `String(value)` of a data URL operand
fn js_string(value: &IpcValue) -> String {
    let json = crate::value::to_serde(value);
    jscompat::value_to_string(json.as_ref())
}

fn truthy(value: &IpcValue) -> bool {
    match value {
        IpcValue::Undefined | IpcValue::Null => false,
        IpcValue::Bool(b) => *b,
        IpcValue::Number(n) => *n != 0.0 && !n.is_nan(),
        IpcValue::String(s) => !s.is_empty(),
        _ => true,
    }
}

impl<'a> PrintDoc<'a> {
    /// The argument list of `buildPrintDocumentHtml` as the `slides:print`
    /// handler builds it. A TypeError is what `op.pngsBase64.map(...)` threw.
    pub fn from_op(op: &'a IpcValue) -> Result<PrintDoc<'a>, IpcError> {
        let reading = |value: &IpcValue, name: &str| {
            let what = if matches!(value, IpcValue::Null) {
                "null"
            } else {
                "undefined"
            };
            type_error(format!(
                "Cannot read properties of {what} (reading '{name}')"
            ))
        };
        if matches!(op, IpcValue::Undefined | IpcValue::Null) {
            return Err(reading(op, "pngsBase64"));
        }
        let srcs = match field(op, "pngsBase64") {
            IpcValue::Array(items) => items
                .iter()
                .map(|b64| format!("data:image/png;base64,{}", js_string(b64)))
                .collect(),
            missing @ (IpcValue::Undefined | IpcValue::Null) => {
                return Err(reading(missing, "map"));
            }
            _ => return Err(type_error("op.pngsBase64.map is not a function".into())),
        };
        Ok(PrintDoc {
            srcs,
            ratio: js_number(field(op, "widthPx")) / js_number(field(op, "heightPx")),
            layout: Layout::of(field(op, "layout")),
            notes: Some(field(op, "notes")).filter(|n| truthy(n)),
            landscape_asked: matches!(field(op, "orientation"), IpcValue::String(s) if s == "landscape"),
            vertical: matches!(field(op, "order"), IpcValue::String(s) if s == "vertical"),
            frame: truthy(field(op, "frame")),
        })
    }

    /// `o.notes?.[i] ?? ''` followed by `esc(...)`, which throws on a
    /// non-string note
    fn note(&self, i: usize) -> Result<String, IpcError> {
        let item = match self.notes {
            None => IpcValue::Undefined,
            Some(IpcValue::Array(items)) => items.get(i).cloned().unwrap_or(IpcValue::Undefined),
            Some(IpcValue::String(s)) => {
                s.encode_utf16().nth(i).map_or(IpcValue::Undefined, |unit| {
                    IpcValue::String(String::from_utf16_lossy(&[unit]))
                })
            }
            Some(object @ IpcValue::Object(_)) => field(object, &i.to_string()).clone(),
            Some(_) => IpcValue::Undefined,
        };
        match item {
            IpcValue::Undefined | IpcValue::Null => Ok(String::new()),
            IpcValue::String(s) => Ok(s),
            _ => Err(type_error("x.replace is not a function".into())),
        }
    }
}

const A4_W: f64 = 8.27;
const A4_H: f64 = 11.69;
const SLIDE_H: f64 = 7.5;
const DEFAULT_PRINT_RATIO: f64 = 16.0 / 9.0;

/// `normalizePrintRatio`
fn normalize_print_ratio(ratio: f64) -> f64 {
    if !ratio.is_finite() || ratio <= 0.0 {
        return DEFAULT_PRINT_RATIO;
    }
    ratio.clamp(0.2, 5.0)
}

/// `printPageSizeIn(layout, orientation, ratio)`: (width, height) in inches
pub fn print_page_size_in(layout: Layout, landscape_asked: bool, ratio: f64) -> (f64, f64) {
    let is_full = layout == Layout::Full;
    let landscape = !is_full && landscape_asked;
    let slide_w = math_round(normalize_print_ratio(ratio) * SLIDE_H * 1000.0) / 1000.0;
    let width = if is_full {
        slide_w
    } else if landscape {
        A4_H
    } else {
        A4_W
    };
    let height = if is_full {
        SLIDE_H
    } else if landscape {
        A4_W
    } else {
        A4_H
    };
    (width, height)
}

/// `handoutGrid`: (columns, rows), none for what is not a grid
fn handout_grid(layout: Layout, landscape: bool, vertical: bool) -> Option<(u8, u8)> {
    match layout {
        Layout::Handout(2) => Some(if vertical || !landscape {
            (1, 2)
        } else {
            (2, 1)
        }),
        Layout::Handout(4) => Some((2, 2)),
        Layout::Handout(6) => Some(if landscape { (3, 2) } else { (2, 3) }),
        Layout::Handout(9) => Some((3, 3)),
        _ => None,
    }
}

fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
    }
    out
}

fn esc_attr(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

const TEMPLATE: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><style>
@page { size: @@W@@in @@H@@in; margin: 0; }
html, body { margin: 0; padding: 0; font-family: -apple-system, 'Segoe UI', sans-serif; }
.page { width: @@W@@in; height: @@H@@in; overflow: hidden; page-break-after: always; box-sizing: border-box; }
.page:last-of-type { page-break-after: auto; }
.page > img { display: block; width: 100%; height: 100%; }
.page.handout { padding: 0.4in; gap: 0.24in; }
.page.handout.h3 { display: flex; flex-direction: column; }
@@GRID@@
.page.handout .cell { display: flex; gap: 0.2in; align-items: center; flex: 1; min-width: 0; min-height: 0; }
.page.handout .cell img { border: 1px solid #bbb; object-fit: contain; max-height: 100%; }
.page.handout.h2 .cell img, .page.handout.h4 .cell img, .page.handout.h6 .cell img, .page.handout.h9 .cell img { width: 100%; height: auto; max-height: 100%; }
.page.handout.h3 .cell img { width: 55%; height: auto; }
.page.handout.h3 .rules {
  flex: 1; align-self: stretch;
  background: repeating-linear-gradient(#fff 0 0.28in, #ccc 0.28in calc(0.28in + 1px));
}
.page.notes { padding: 0.5in; display: flex; flex-direction: column; }
.page.notes img { width: @@NOTES_W@@; @@NOTES_IMG@@ border: 1px solid #bbb; }
.page.notes .note { margin-top: 0.3in; font-size: 11pt; line-height: 1.5; white-space: pre-wrap; }
@@FRAME@@
@@PREVIEW@@
</style></head><body>@@BODY@@</body></html>";

/// `buildPrintDocumentHtml(o)` with `preview` off
pub fn build_print_document_html(doc: &PrintDoc<'_>) -> Result<String, IpcError> {
    let layout = doc.layout;
    let is_full = layout == Layout::Full;
    let landscape = !is_full && doc.landscape_asked;
    let (page_w, page_h) = print_page_size_in(layout, doc.landscape_asked, doc.ratio);
    let per_page = usize::from(layout.per_page());

    let body = if is_full {
        doc.srcs
            .iter()
            .map(|src| format!("<div class=\"page\"><img src=\"{}\"></div>", esc_attr(src)))
            .collect::<String>()
    } else if layout == Layout::Notes {
        let mut body = String::new();
        for (i, src) in doc.srcs.iter().enumerate() {
            body.push_str(&format!(
                "<div class=\"page notes\"><img src=\"{}\"><div class=\"note\">{}</div></div>",
                esc_attr(src),
                esc(&doc.note(i)?).replace('\n', "<br>")
            ));
        }
        body
    } else {
        let mut body = String::new();
        for page in doc.srcs.chunks(per_page) {
            let cells: String = page
                .iter()
                .map(|src| {
                    format!(
                        "<div class=\"cell\"><img src=\"{}\">{}</div>",
                        esc_attr(src),
                        if per_page == 3 {
                            "<div class=\"rules\"></div>"
                        } else {
                            ""
                        }
                    )
                })
                .collect();
            body.push_str(&format!(
                "<div class=\"page handout h{per_page}\">{cells}</div>"
            ));
        }
        body
    };

    let grid = match handout_grid(layout, landscape, doc.vertical) {
        Some((cols, rows)) => {
            let tracks = |n: u8| vec!["1fr"; usize::from(n)].join(" ");
            format!(
                ".page.handout.h{per_page} {{ display: grid; grid-auto-flow: {}; grid-template-columns: {}; grid-template-rows: {}; }}",
                if doc.vertical { "column" } else { "row" },
                tracks(cols),
                tracks(rows)
            )
        }
        None => String::new(),
    };
    let frame = if doc.frame && is_full {
        ".page > img { border: 1px solid #bbb; }"
    } else {
        ""
    };
    let (w, h) = (number_to_string(page_w), number_to_string(page_h));
    Ok(TEMPLATE
        .replace("@@W@@", &w)
        .replace("@@H@@", &h)
        .replace("@@GRID@@", &grid)
        .replace("@@NOTES_W@@", if landscape { "auto" } else { "100%" })
        .replace(
            "@@NOTES_IMG@@",
            if landscape {
                "max-height: 55%; align-self: center;"
            } else {
                "height: auto;"
            },
        )
        .replace("@@FRAME@@", frame)
        .replace("@@PREVIEW@@", "")
        .replacen("@@BODY@@", &body, 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::{object, string};

    fn op(entries: Vec<(&str, IpcValue)>) -> IpcValue {
        IpcValue::Object(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
        )
    }

    fn pngs(n: usize) -> IpcValue {
        IpcValue::Array((0..n).map(|i| string(format!("p{i}"))).collect())
    }

    fn html(op: &IpcValue) -> String {
        build_print_document_html(&PrintDoc::from_op(op).unwrap()).unwrap()
    }

    #[test]
    fn full_pages_follow_the_slide_ratio_at_seven_and_a_half_inches() {
        let doc = op(vec![
            ("pngsBase64", pngs(2)),
            ("widthPx", IpcValue::Number(1600.0)),
            ("heightPx", IpcValue::Number(900.0)),
        ]);
        let out = html(&doc);
        assert!(
            out.contains("@page { size: 13.333in 7.5in; margin: 0; }"),
            "{out}"
        );
        assert!(out.contains(
            "<body><div class=\"page\"><img src=\"data:image/png;base64,p0\"></div><div class=\"page\"><img src=\"data:image/png;base64,p1\"></div></body>"
        ));
    }

    #[test]
    fn a_corrupt_ratio_falls_back_to_sixteen_by_nine_and_handouts_use_a4() {
        let doc = op(vec![
            ("pngsBase64", pngs(1)),
            ("widthPx", IpcValue::Number(0.0)),
            ("heightPx", IpcValue::Number(0.0)),
            ("layout", string("handout6")),
            ("orientation", string("landscape")),
            ("order", string("vertical")),
        ]);
        let out = html(&doc);
        assert!(out.contains("@page { size: 11.69in 8.27in; margin: 0; }"));
        assert!(out.contains(
            ".page.handout.h6 { display: grid; grid-auto-flow: column; grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1fr 1fr; }"
        ));
        assert_eq!(
            print_page_size_in(Layout::Full, false, f64::NAN),
            (13.333, 7.5)
        );
    }

    #[test]
    fn notes_are_escaped_and_a_missing_note_is_empty() {
        let doc = op(vec![
            ("pngsBase64", pngs(2)),
            ("widthPx", IpcValue::Number(4.0)),
            ("heightPx", IpcValue::Number(3.0)),
            ("layout", string("notes")),
            ("notes", IpcValue::Array(vec![string("a<b\nc & d")])),
        ]);
        let out = html(&doc);
        assert!(out.contains("<div class=\"note\">a&lt;b<br>c &amp; d</div>"));
        assert!(out.contains("<div class=\"note\"></div></div></body>"));
        assert!(out.contains(".page.notes img { width: 100%; height: auto; border"));
    }

    #[test]
    fn operands_of_the_wrong_type_throw_what_the_typescript_threw() {
        let missing = PrintDoc::from_op(&IpcValue::Undefined).err().unwrap();
        assert_eq!(missing.name.as_deref(), Some("TypeError"));
        assert_eq!(
            missing.message,
            "Cannot read properties of undefined (reading 'pngsBase64')"
        );
        let not_array = PrintDoc::from_op(&object([("pngsBase64", string("x"))]))
            .err()
            .unwrap();
        assert_eq!(not_array.message, "op.pngsBase64.map is not a function");
        let bad_note = op(vec![
            ("pngsBase64", pngs(1)),
            ("layout", string("notes")),
            ("notes", IpcValue::Array(vec![IpcValue::Number(5.0)])),
        ]);
        let err = build_print_document_html(&PrintDoc::from_op(&bad_note).unwrap()).unwrap_err();
        assert_eq!(err.message, "x.replace is not a function");
    }
}
