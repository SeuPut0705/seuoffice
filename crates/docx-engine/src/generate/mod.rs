//! XML builders ported from packages/docx-engine/src/generate.ts.

use jscompat::{RegexLimit, js_regex, try_js_regex};
use ooxml_xml::mask_opaque;

pub mod drawing_build;
pub mod drawing_patch;
pub mod fields;
pub mod paragraph;
pub mod props;
pub mod rpr;
pub mod runs;
pub mod table;
pub mod text_patch;

/// `escapeXmlText` from xml-utils.ts. The replacement order is part of the contract.
pub(crate) fn escape_xml_text(text: &str) -> String {
    js_regex!(r"[\u0000-\u0008\u000B\u000C\u000E-\u001F]", "g")
        .replace_all(text, |_| String::new())
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(crate) fn escape_xml_attr(text: &str) -> String {
    escape_xml_text(text).replace('"', "&quot;")
}

/// Top-level XML children, preserving the original bytes and the TypeScript scanner's quirks.
/// A tag with more than about a million characters of attributes passes the
/// bound of one search.
pub fn split_xml_children(xml: &str) -> Result<Vec<(String, String)>, RegexLimit> {
    let mut out = Vec::new();
    let mut depth = 0i64;
    let mut start = None;
    let mut name = String::new();
    // tags are found where comments and CDATA cannot fake one; bytes come from xml
    let masked = mask_opaque(xml);
    for found in try_js_regex!(
        r#"<(\/?)([A-Za-z0-9:._-]+)((?:"[^"]*"|'[^']*'|[^"'>])*)>"#,
        "g"
    )
    .try_find_iter(&masked)
    {
        let found = found?;
        let closing = found.get(1) == Some("/");
        let self_closing = found.get(3).is_some_and(|attrs| attrs.ends_with('/'));
        if closing {
            depth -= 1;
            if depth == 0 {
                // JS slice(-1, end) starts at the last code unit if malformed tags drove depth below zero.
                let from =
                    start.unwrap_or_else(|| xml.char_indices().next_back().map_or(0, |(at, _)| at));
                out.push((name.clone(), xml[from..found.end()].to_owned()));
            }
        } else if self_closing {
            if depth == 0 {
                out.push((
                    found.get(2).unwrap_or_default().to_owned(),
                    xml[found.start()..found.end()].to_owned(),
                ));
            }
        } else {
            if depth == 0 {
                start = Some(found.start());
                name = found.get(2).unwrap_or_default().to_owned();
            }
            depth += 1;
        }
    }
    Ok(out)
}
