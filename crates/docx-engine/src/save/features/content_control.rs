//! content-control.ts: block-level content controls (w:sdt): the metadata a
//! control carries and the bytes a newly created one is written as.

use jscompat::serde::{Deserialize, Serialize};
use jscompat::{js_regex, to_number, try_js_regex};

/// `CONTENT_CONTROL_LOCKS`: the lock states a block-level content control can
/// carry (w:sdtPr/w:lock @w:val). 'none' writes no w:lock element at all.
pub const CONTENT_CONTROL_LOCKS: [&str; 4] =
    ["none", "sdtLocked", "contentLocked", "sdtContentLocked"];

/// `ContentControlSpec`: what a content control carries
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(crate = "jscompat::serde")]
pub struct ContentControlSpec {
    /// programmatic tag (w:sdtPr/w:tag @w:val)
    pub tag: Option<String>,
    /// human-visible title (w:sdtPr/w:alias @w:val)
    pub title: Option<String>,
    /// lock state; 'none' (the default) writes no w:lock element
    pub lock: Option<String>,
    /// control id (w:sdtPr/w:id @w:val); empty = the caller assigns one
    pub id: Option<String>,
}

/// `isContentControlLock`: the lock states a control can carry, 'none' included
pub fn is_content_control_lock(value: &str) -> bool {
    CONTENT_CONTROL_LOCKS.contains(&value)
}

/// `ContentControlShell`: the opening and closing bytes of a block-level
/// content control
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(crate = "jscompat::serde", rename_all = "camelCase")]
pub struct ContentControlShell {
    /// `<w:sdt><w:sdtPr>…</w:sdtPr><w:sdtContent>`
    pub open_xml: String,
    /// `</w:sdtContent></w:sdt>`
    pub close_xml: String,
}

/// `escapeAttr`
fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `buildContentControlXml`: the opening and closing bytes of a block-level
/// content control (w:sdt). The w:sdtPr children follow the CT_SdtPr order
/// (alias, tag, id, lock, then the control type), so Word accepts the control
/// as written.
pub fn build_content_control_xml(spec: &ContentControlSpec) -> Result<ContentControlShell, String> {
    let mut pr = String::new();
    if let Some(title) = spec.title.as_deref().filter(|title| !title.is_empty()) {
        pr.push_str(&format!("<w:alias w:val=\"{}\"/>", escape_attr(title)));
    }
    if let Some(tag) = spec.tag.as_deref().filter(|tag| !tag.is_empty()) {
        pr.push_str(&format!("<w:tag w:val=\"{}\"/>", escape_attr(tag)));
    }
    if let Some(id) = spec.id.as_deref().filter(|id| !id.is_empty()) {
        pr.push_str(&format!("<w:id w:val=\"{}\"/>", escape_attr(id)));
    }
    if let Some(lock) = spec
        .lock
        .as_deref()
        .filter(|lock| !lock.is_empty() && *lock != "none")
    {
        pr.push_str(&format!("<w:lock w:val=\"{lock}\"/>"));
    }
    pr.push_str("<w:richText/>");
    Ok(ContentControlShell {
        open_xml: format!("<w:sdt><w:sdtPr>{pr}</w:sdtPr><w:sdtContent>"),
        close_xml: "</w:sdtContent></w:sdt>".to_owned(),
    })
}

/// `nextContentControlId`: the next free control id (w:sdtPr/w:id) in a
/// document: Word keeps the ids unique across the file, so a new control takes
/// the next number.
pub fn next_content_control_id(document_xml: &str) -> Result<f64, String> {
    let mut max = 0.0f64;
    let id_re = js_regex!(r#"<w:id[^>]*\bw:val=(?:"(\d+)"|'(\d+)')"#);
    for found in try_js_regex!(r"<w:sdtPr>([\s\S]*?)<\/w:sdtPr>", "g").try_find_iter(document_xml) {
        let found = found.map_err(|limit| limit.to_string())?;
        let id = id_re.exec(found.get(1).unwrap_or_default());
        let digits = id
            .as_ref()
            .and_then(|id| id.get(1).or_else(|| id.get(2)))
            .unwrap_or("0");
        let value = to_number(digits);
        if value.is_finite() {
            max = max.max(value);
        }
    }
    Ok(max + 1.0)
}
