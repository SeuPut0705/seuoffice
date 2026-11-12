//! `apps/diagram/src/main/print-document.ts`: the pages the app prints or turns
//! into a PDF, one sheet per diagram page, always in light colors.
//!
//! The module's `documents` map is a [`PrintDocuments`] value, and
//! `randomBytes(16).toString('hex')` is the `token` parameter. A title cut by
//! `slice(0, 200)` in the middle of a surrogate pair keeps a lone surrogate in
//! JavaScript; here it is U+FFFD.

use std::collections::HashMap;

use jscompat::{JsonValue, js_regex, math_round, number_to_string, slice_utf16};

const MAX_UNITS: f64 = 100_000.0;

fn units(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value > 0.0 && value <= MAX_UNITS {
        value
    } else {
        fallback
    }
}

/// `${Math.round(value * 100) / 10000}in`
fn inches(value: f64) -> String {
    format!(
        "{}in",
        number_to_string(math_round(value * 100.0) / 10000.0)
    )
}

/// `PrintPage`: one page for a PDF or print, a light-colored SVG and the
/// sheet size in draw.io units (1/100 inch).
#[derive(Debug, Clone, PartialEq)]
pub struct PrintPage {
    pub svg: String,
    /// the drawing's own size in draw.io units
    pub width: f64,
    pub height: f64,
    /// the page format the diagram sets, in draw.io units
    pub page_width: f64,
    pub page_height: f64,
}

/// `isPrintPage(value)`: whether a page sent by a renderer can be printed.
pub fn is_print_page(value: Option<&JsonValue>) -> bool {
    let Some(page) = value else {
        return false;
    };
    // `typeof value !== 'object' || value === null`: an array is an object
    if !matches!(page, JsonValue::Object(_) | JsonValue::Array(_)) {
        return false;
    }
    let svg = page.get("svg");
    let svg_ok = match svg.as_deref() {
        Some(JsonValue::String(svg)) => js_regex!(r"^\s*<svg[\s>]", "i").test(svg),
        _ => false,
    };
    svg_ok
        && ["width", "height", "pageWidth", "pageHeight"]
            .iter()
            .all(|key| matches!(page.get(key).as_deref(), Some(JsonValue::Number(_))))
}

/// Drops what never belongs in a printed picture: scripts and event attributes.
pub fn inert_svg(svg: &str) -> String {
    let svg =
        js_regex!(r"<script\b[\s\S]*?<\/script\s*>", "gi").replace_all(svg, |_| String::new());
    let svg = js_regex!(r"<script\b[^>]*\/>", "gi").replace_all(&svg, |_| String::new());
    js_regex!(r#"\son[a-z]+\s*=\s*("[^"]*"|'[^']*')"#, "gi").replace_all(&svg, |_| String::new())
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The document: one sheet per page, each with its own size, white, light
/// colors. `title` names the PDF.
pub fn build_print_html(pages: &[PrintPage], title: &str) -> String {
    let mut rules: Vec<String> = vec![
        "html, body { margin: 0; padding: 0; background: #ffffff; color-scheme: light; }"
            .to_owned(),
        ".sheet { display: flex; align-items: center; justify-content: center; overflow: hidden;"
            .to_owned(),
        "  box-sizing: border-box; background: #ffffff; break-after: page; }".to_owned(),
        ".sheet:last-child { break-after: auto; }".to_owned(),
        ".sheet > svg { display: block; max-width: 100%; max-height: 100%; }".to_owned(),
    ];
    let mut sheets: Vec<String> = Vec::new();
    for (index, page) in pages.iter().enumerate() {
        let name = format!("p{}", index + 1);
        let sheet_width = units(page.page_width, 827.0);
        let sheet_height = units(page.page_height, 1169.0);
        let width = units(page.width, sheet_width);
        let height = units(page.height, sheet_height);
        rules.push(format!(
            "@page {name} {{ size: {} {}; margin: 0; }}",
            inches(sheet_width),
            inches(sheet_height)
        ));
        rules.push(format!(
            ".{name} {{ page: {name}; width: {}; height: {}; }}",
            inches(sheet_width),
            inches(sheet_height)
        ));
        rules.push(format!(
            ".{name} > svg {{ width: {}; height: {}; }}",
            inches(width),
            inches(height)
        ));
        sheets.push(format!(
            "<div class=\"sheet {name}\">{}</div>",
            inert_svg(&page.svg)
        ));
    }
    [
        "<!doctype html>".to_owned(),
        "<html><head><meta charset=\"utf-8\">".to_owned(),
        format!(
            "<title>{}</title>",
            escape_html(&slice_utf16(title, 0.0, Some(200.0)))
        ),
        format!("<style>\n{}\n</style>", rules.join("\n")),
        "</head><body>".to_owned(),
        sheets.join("\n"),
        "</body></html>".to_owned(),
    ]
    .join("\n")
}

/// `isPrintCancel(failureReason)`: whether a print that did not happen was the
/// person closing the print dialog.
pub fn is_print_cancel(failure_reason: Option<&JsonValue>) -> bool {
    matches!(failure_reason, Some(JsonValue::String(reason)) if js_regex!(r"cancel", "i").test(reason))
}

/// Documents waiting to be shown once, by token.
#[derive(Debug, Default)]
pub struct PrintDocuments {
    documents: HashMap<String, String>,
}

impl PrintDocuments {
    pub fn new() -> Self {
        Self::default()
    }

    /// `holdPrintDocument(html)`: keeps a document for one load under `token`
    /// (the random 32 hex digits) and answers the token.
    pub fn hold_print_document(&mut self, html: &str, token: String) -> String {
        self.documents.insert(token.clone(), html.to_owned());
        token
    }

    /// The document for a token, once.
    pub fn take_print_document(&mut self, token: &str) -> Option<String> {
        self.documents.remove(token)
    }

    pub fn drop_print_document(&mut self, token: &str) {
        self.documents.remove(token);
    }
}
