//! hidden-content.ts: whether a .docx holds content a person marked "hidden
//! from AI", and a copy of it with the marks taken off.
//!
//! A part is judged by the mark's traces in its XML, not by what the parser
//! makes of it: the namespace the mark is written in, or a `redact` element
//! under any prefix. A spelling the readers do not understand still counts, and
//! a trace inside a comment or CDATA is counted too: a false alarm asks the
//! person, a miss would write the words out.

use jscompat::{Radix, js_regex, parse_int, try_js_regex};
use ooxml_pkg::{DEFAULT_ZIP_LIMITS, Package, load_package, write::generate};

use crate::withheld::REDACT_NAMESPACES;

/// `spelledOut`: the numeric character references that name a character
/// written out as it, so that a mark spelled with references is read as one.
fn spelled_out(xml: &str) -> String {
    if !xml.contains("&#") {
        return xml.to_owned();
    }
    js_regex!(r"&#(?:x([0-9a-fA-F]+)|(\d+));", "g").replace_all(xml, |found| {
        let code = match found.get(1) {
            Some(hex) => parse_int(hex, Radix::Sixteen),
            None => parse_int(found.get(2).unwrap_or(""), Radix::Ten),
        };
        let kept = || found.as_str().to_owned();
        if code <= f64::from(0x10ffff_u32) {
            // a surrogate is no character: `char::from_u32` refuses it as the original keeps it
            char::from_u32(code as u32).map_or_else(kept, String::from)
        } else {
            kept()
        }
    })
}

/// `holdsMark`: the namespace declarations are taken out first (a prefix bound
/// to the mark's namespace is no sign of a mark by itself).
fn holds_mark(xml: &str) -> bool {
    let spelled = spelled_out(xml);
    let text = js_regex!(
        r#"\sxmlns(?::[\w.-]+)?\s*=\s*(?:"(?:https://github\.com/SeuPut0705/seuoffice/redaction/2026|https://genspark\.ai/genoffice/redaction/2026)"|'(?:https://github\.com/SeuPut0705/seuoffice/redaction/2026|https://genspark\.ai/genoffice/redaction/2026)')"#,
        "g"
    )
    .replace_all(&spelled, |_| String::new());
    REDACT_NAMESPACES.iter().any(|ns| text.contains(ns))
        || js_regex!(r"<(?:[\w.-]+:)?redact[\s/>]").test(&text)
}

/// The non-folder parts under `word/` that end in `.xml`, in package order.
fn word_parts(package: &Package) -> Vec<&str> {
    package
        .parts()
        .iter()
        .filter(|part| js_regex!(r"^word\/.*\.xml$").test(&part.name) && !part.is_dir)
        .map(|part| part.name.as_str())
        .collect()
}

fn open(bytes: &[u8]) -> Result<Package, String> {
    load_package(bytes, &DEFAULT_ZIP_LIMITS, |_| Ok(()))
}

/// `cutMarks`: `xml` with every mark element cut out of its markup. A CDATA
/// section is words, not markup: no mark is cut from it. A character reference
/// of the rest stays as written.
fn cut_marks(xml: &str) -> Result<String, String> {
    let mark_tag = try_js_regex!(
        r#"(?:<w:bdr\s+w:val="single"\s+w:sz="6"\s+w:color="6B4FC0"\s*/>\s*)?<(?:[\w.-]+:)?redact(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*)?(?:/>|>\s*</(?:[\w.-]+:)?redact\s*>)"#,
        "g"
    );
    let cut = |piece: &str| {
        mark_tag
            .try_replace_all(piece, |_| String::new())
            .map_err(|limit| limit.to_string())
    };
    let mut out = String::with_capacity(xml.len());
    let mut at = 0;
    for section in js_regex!(r"<!\[CDATA\[[\s\S]*?\]\]>", "g").find_iter(xml) {
        out.push_str(&cut(&xml[at..section.start()])?);
        out.push_str(section.as_str());
        at = section.end();
    }
    out.push_str(&cut(&xml[at..])?);
    Ok(out)
}

/// `docxHoldsHiddenContent`: whether any part of the package (body, headers,
/// footers, comments, notes) holds the mark.
pub fn docx_holds_hidden_content(bytes: &[u8]) -> Result<bool, String> {
    let package = open(bytes)?;
    for path in word_parts(&package) {
        let text = package.text(path).map_err(|error| error.to_string())?;
        if text.is_some_and(holds_mark) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `clearHiddenMarks`: the package with every mark taken off, the words left
/// readable by anyone. The marks are cut out of each part as it is: the decoded
/// copy only tells whether a trace is left. The namespace declaration stays (an ignorable prefix
/// must stay declared). Fails when a trace of the mark is left in a part, so
/// that a copy never claims to be clear when it is not. `now` stamps the parts
/// it rewrites, as `zip.file` does.
pub fn clear_hidden_marks(bytes: &[u8], now: f64) -> Result<Vec<u8>, String> {
    let mut package = open(bytes)?;
    let paths: Vec<String> = word_parts(&package)
        .into_iter()
        .map(str::to_owned)
        .collect();
    for path in paths {
        let Some(xml) = package.text(&path).map_err(|error| error.to_string())? else {
            continue;
        };
        if !holds_mark(xml) {
            continue;
        }
        let cleared = cut_marks(xml)?;
        if holds_mark(&cleared) {
            return Err(format!("could not clear the marks in {path}"));
        }
        package.set_file(path, cleared.into_bytes());
    }
    generate(&package, now).map_err(|error| error.to_string())
}
