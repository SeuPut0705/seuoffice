//! `patchZoteroDocumentDataXml` of zotero-doc-props.ts: the write half. The
//! constants and the readers are in `crate::doc_properties::zotero`.

use jscompat::{RegexError, js_regex, to_number, try_js_regex};

pub use crate::doc_properties::zotero::{
    CUSTOM_PROPERTIES_CONTENT_TYPE, CUSTOM_PROPERTIES_PATH, CUSTOM_PROPERTIES_REL_TYPE,
};
use crate::doc_properties::zotero::{PROPERTY_RE, attr_name, attr_value};
use crate::generate::{escape_xml_attr, escape_xml_text};

/// `Number.isSafeInteger`
pub(crate) fn is_safe_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
}

/// The empty custom-properties part a document without one gets.
const EMPTY_CUSTOM_PROPERTIES: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/custom-properties\" xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\"></Properties>";

/// The greatest `pid` the properties of `xml` carry, 1 at least.
pub(crate) fn max_pid(xml: &str) -> Result<f64, RegexError> {
    let mut max = 1.0f64;
    for property in PROPERTY_RE.find_iter(xml) {
        // `Number(attrValue(property, 'pid'))`: no attribute is `Number(null)`, 0
        let pid = attr_value(property.as_str(), "pid")?.map_or(0.0, |pid| to_number(&pid));
        if is_safe_integer(pid) {
            max = max.max(pid);
        }
    }
    Ok(max)
}

/// `patchZoteroDocumentDataXml`: the custom-properties part with the Zotero
/// document data written into ZOTERO_PREF_n properties of at most 255 UTF-16
/// units each; `xml` is the part, `None` where the document has none.
pub fn patch_zotero_document_data_xml(xml: Option<&str>, data: &str) -> Result<String, RegexError> {
    let original = xml.unwrap_or(EMPTY_CUSTOM_PROPERTIES);
    let mut max_pid = max_pid(original)?;
    // the properties of the old data go
    let zotero_pref_name = js_regex!(r"^ZOTERO_PREF(?:_(\d+))?$");
    let mut without_old = String::new();
    let mut cursor = 0;
    for property in PROPERTY_RE.find_iter(original) {
        without_old.push_str(&original[cursor..property.start()]);
        let name = attr_name(property.as_str()).filter(|name| !name.is_empty());
        if !name.is_some_and(|name| zotero_pref_name.test(&name)) {
            without_old.push_str(property.as_str());
        }
        cursor = property.end();
    }
    without_old.push_str(&original[cursor..]);

    let units: Vec<u16> = data.encode_utf16().collect();
    let mut properties = String::new();
    let mut offset = 0;
    let mut index = 0;
    while offset < units.len() {
        let mut end = (offset + 255).min(units.len());
        if end < units.len() && (0xD800..=0xDBFF).contains(&units[end - 1]) {
            end -= 1;
        }
        let value = String::from_utf16_lossy(&units[offset..end]);
        index += 1;
        max_pid += 1.0;
        properties.push_str(&format!(
            "<property fmtid=\"{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}\" pid=\"{}\" name=\"{}\"><vt:lpwstr>{}</vt:lpwstr></property>",
            jscompat::number_to_string(max_pid),
            escape_xml_attr(&format!("ZOTERO_PREF_{index}")),
            escape_xml_text(&value),
        ));
        offset = end;
    }
    let self_closing = try_js_regex!(r"<((?:[A-Za-z_][\w.-]*:)?Properties)\b([^>]*?)\/>");
    if let Some(empty) = self_closing.try_exec(&without_old)? {
        return Ok(format!(
            "{}<{}{}>{properties}</{}>{}",
            &without_old[..empty.start()],
            empty.get(1).unwrap_or_default(),
            empty.get(2).unwrap_or_default(),
            empty.get(1).unwrap_or_default(),
            &without_old[empty.end()..],
        ));
    }
    Ok(
        match try_js_regex!(r"<\/(?:[A-Za-z_][\w.-]*:)?Properties\s*>").try_exec(&without_old)? {
            Some(close) => format!(
                "{}{properties}{}{}",
                &without_old[..close.start()],
                close.as_str(),
                &without_old[close.end()..]
            ),
            None => without_old,
        },
    )
}
