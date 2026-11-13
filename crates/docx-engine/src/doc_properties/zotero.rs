//! The Zotero document data a custom.xml part carries, and the pattern
//! readers the docProps parsers share (`zotero-doc-props.ts`).

use std::sync::LazyLock;

use jscompat::{JsMatch, JsRegex, Radix, RegexError, TryJsRegex, js_regex, parse_int, to_number};
use ooxml_pkg::{Package, ReadError};

pub const CUSTOM_PROPERTIES_PATH: &str = "docProps/custom.xml";
pub const CUSTOM_PROPERTIES_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties";
pub const CUSTOM_PROPERTIES_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.custom-properties+xml";

/// Every `<property>` element of a custom-properties part.
pub static PROPERTY_RE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        r"<(?:[A-Za-z_][\w.-]*:)?property\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?property\s*>",
        "",
    )
    .expect("a pattern literal that compiles")
});

/// One `&#x..;` (or `&#X..;`) reference with `hex`, one `&#..;` without, at
/// `at`: where it ends and its digits.
fn char_ref_at(units: &[u16], at: usize, hex: bool) -> Option<(usize, String)> {
    let unit = |offset: usize| units.get(at + offset).copied();
    if unit(0) != Some(u16::from(b'&')) || unit(1) != Some(u16::from(b'#')) {
        return None;
    }
    let start = if hex {
        if !matches!(unit(2), Some(x) if x == u16::from(b'x') || x == u16::from(b'X')) {
            return None;
        }
        at + 3
    } else {
        at + 2
    };
    let digits: String = units
        .get(start..)?
        .iter()
        .map_while(|unit| {
            char::from_u32(u32::from(*unit)).filter(|c| {
                if hex {
                    c.is_ascii_hexdigit()
                } else {
                    c.is_ascii_digit()
                }
            })
        })
        .collect();
    let end = start + digits.len();
    (!digits.is_empty() && units.get(end) == Some(&u16::from(b';'))).then_some((end + 1, digits))
}

/// `.replace(/&#x([0-9a-f]+);/gi, ...)` or `.replace(/&#(\d+);/g, ...)` over
/// UTF-16 code units: `String.fromCodePoint` of a surrogate leaves a lone code
/// unit that the next reference may complete.
fn replace_char_refs(units: &[u16], hex: bool) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut at = 0;
    while let Some(&unit) = units.get(at) {
        let Some((end, digits)) = char_ref_at(units, at, hex) else {
            out.push(unit);
            at += 1;
            continue;
        };
        let code = parse_int(&digits, if hex { Radix::Sixteen } else { Radix::Ten });
        if (0.0..=f64::from(0x10_FFFF)).contains(&code) {
            // in range, so the cast is exact
            let code = code as u32;
            match char::from_u32(code) {
                Some(c) => out.extend(c.encode_utf16(&mut [0; 2]).iter()),
                // a surrogate: one code unit
                None => out.push(code as u16),
            }
        } else {
            out.extend_from_slice(units.get(at..end).unwrap_or_default());
        }
        at = end;
    }
    out
}

/// `decodeXmlText`
pub fn decode_xml_text(value: &str) -> String {
    let units: Vec<u16> = value.encode_utf16().collect();
    let units = replace_char_refs(&replace_char_refs(&units, true), false);
    // `.replace(/[\uD800-\uDFFF]/gu, '\uFFFD')`: a unit left without its pair
    String::from_utf16_lossy(&units)
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn attr_with(xml: &str, pattern: &JsRegex) -> Option<String> {
    pattern.exec(xml).map(|found| attr_of(&found))
}

fn attr_of(found: &JsMatch<'_>) -> String {
    decode_xml_text(found.get(1).or(found.get(2)).unwrap_or(""))
}

/// `attrValue`: the pattern is built from `name`, so a name that is not a
/// valid pattern throws, and so does one whose search passes the bound.
pub fn attr_value(xml: &str, name: &str) -> Result<Option<String>, RegexError> {
    let pattern = TryJsRegex::new(&format!(r#"\b{name}\s*=\s*(?:"([^"]*)"|'([^']*)')"#), "")?;
    Ok(pattern.try_exec(xml)?.map(|found| attr_of(&found)))
}

/// `attrValue(xml, 'name')`
pub(crate) fn attr_name(xml: &str) -> Option<String> {
    attr_with(xml, js_regex!(r#"\bname\s*=\s*(?:"([^"]*)"|'([^']*)')"#))
}

/// `propertyText`
pub fn property_text(xml: &str) -> String {
    let lpwstr = js_regex!(
        r"<(?:[A-Za-z_][\w.-]*:)?lpwstr\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?lpwstr\s*>"
    );
    decode_xml_text(
        lpwstr
            .exec(xml)
            .and_then(|found| found.get(1))
            .unwrap_or(""),
    )
}

/// `parseZoteroDocumentDataXml`: the ZOTERO_PREF_n chunks in order of n,
/// or the single legacy ZOTERO_PREF property where there is no chunk.
pub fn parse_zotero_document_data_xml(xml: &str) -> String {
    let zotero_pref_name = js_regex!(r"^ZOTERO_PREF(?:_(\d+))?$");
    let mut chunks: Vec<(f64, String)> = Vec::new();
    let mut legacy = String::new();
    for property in PROPERTY_RE.find_iter(xml) {
        let property = property.as_str();
        let name = attr_name(property).filter(|name| !name.is_empty());
        let Some(found) = name.as_deref().and_then(|name| zotero_pref_name.exec(name)) else {
            continue;
        };
        let value = property_text(property);
        match found.get(1).filter(|index| !index.is_empty()) {
            Some(index) => chunks.push((to_number(index), value)),
            None => legacy = value,
        }
    }
    if chunks.is_empty() {
        return legacy;
    }
    // stable, as Array.prototype.sort; Infinity - Infinity is NaN, read as equal
    chunks.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    chunks.into_iter().map(|(_, value)| value).collect()
}

/// `readZoteroDocumentData`
pub fn read_zotero_document_data(package: &Package) -> Result<String, ReadError> {
    Ok(package
        .text(CUSTOM_PROPERTIES_PATH)?
        .map(parse_zotero_document_data_xml)
        .unwrap_or_default())
}
