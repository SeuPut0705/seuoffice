//! The "withheld from the model" mark (packages/pptx-engine/src/redaction-xml.ts):
//! `<a:extLst><a:ext uri="..."><go:redact label="..."/></a:ext></a:extLst>`
//! inside a run's `<a:rPr>`, or inside a picture's `<p:spPr>`. The deck keeps
//! the real words; only the model's view swaps them for the label.

use jscompat::{
    RegexError, RegexLimit, TryJsRegex, is_js_space, js_regex, replace_first_with, trim, truthy,
    try_js_regex,
};
use serde_json::Value;

use crate::xml_utils::{as_xml_node, escape_xml_attr, xml_array};

/// `REDACT_NS` of packages/agent-core/src/redact-range.ts, which
/// redaction-xml.ts re-exports.
pub const REDACT_NS: &str = "https://genspark.ai/genoffice/redaction/2026";
/// `REDACT_PREFIX` of packages/agent-core/src/redact-range.ts.
pub const REDACT_PREFIX: &str = "go";
/// `REDACT_EL` of packages/agent-core/src/redact-range.ts:
/// `${REDACT_PREFIX}:redact`.
pub const REDACT_EL: &str = "go:redact";

/// A fixed URI: a deck that round-trips through the engine lands on the same
/// value.
pub const REDACT_EXT_URI: &str = "{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}";

/// The whole extension node, for splicing into an `<a:extLst>`. The prefix is
/// declared on the `a:ext` itself; `label` is unprefixed on purpose.
pub fn redact_ext_xml(label: &str) -> String {
    format!(
        r#"<a:ext uri="{REDACT_EXT_URI}" xmlns:{REDACT_PREFIX}="{REDACT_NS}"><{REDACT_EL} label="{}"/></a:ext>"#,
        escape_xml_attr(label)
    )
}

/// True when the fragment already carries our mark.
pub fn has_redact_ext_in(xml: &str) -> Result<bool, RegexLimit> {
    our_ext_re().try_test(xml)
}

/// Sync our mark on the element named `tag` inside `xml`: `a:rPr` for a run,
/// `p:spPr` for a picture. No `label` removes it. `tag` is pasted into the
/// pattern unescaped, as the TypeScript does: one that does not compile
/// throws.
pub fn sync_redact_ext(xml: &str, tag: &str, label: Option<&str>) -> Result<String, RegexError> {
    let Some(open) = TryJsRegex::new(
        &format!(r"<{tag}\b[^>]*?/>|<{tag}\b[^>]*?>[\s\S]*?</{tag}>"),
        "",
    )?
    .try_exec(xml)?
    else {
        return Ok(xml.to_owned());
    };
    let next = match truthy(label) {
        Some(label) => set_redact_ext(open.as_str(), label)?,
        None => strip_redact_ext(open.as_str())?,
    };
    if next == open.as_str() {
        return Ok(xml.to_owned());
    }
    Ok(format!(
        "{}{next}{}",
        xml.get(..open.start()).unwrap_or_default(),
        xml.get(open.end()..).unwrap_or_default(),
    ))
}

/// One `<a:ext>` matching our URI.
fn our_ext(ext_lst: Option<&Value>) -> Option<&Value> {
    xml_array(as_xml_node(ext_lst).get("a:ext"))
        .find(|ext| ext.get("@_uri").and_then(Value::as_str) == Some(REDACT_EXT_URI))
}

/// The label, read out of an already-parsed `<a:rPr>` or `<p:spPr>` node.
pub fn read_redact_label(node: Option<&Value>) -> Option<&str> {
    let ext = our_ext(as_xml_node(node).get("a:extLst"))?;
    match as_xml_node(ext.get(REDACT_EL)).get("@_label") {
        Some(Value::String(label)) if !label.is_empty() => Some(label.as_str()),
        _ => None,
    }
}

/// Our `<a:ext>`, whether self-closing or paired. After the `uri` attribute, a
/// well-formed tag that closes itself is attributes (`(?:\s+name=value)*`), then
/// white space, then `/>`.
const OUR_EXT_PATTERN: &str = r#"<a:ext\b[^>]*\buri="{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}"(?:(?:\s+[^\s=<>"'/]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*/>|[^>]*(?:/>|>[\s\S]*?</a:ext>))"#;

/// The opening tag of an `<a:extLst>` that is well-formed: attributes, then
/// white space, then `>`.
const WELL_FORMED_EXTLST_OPEN: &str =
    r#"^<a:extLst(?:\s+[^\s=<>"'/]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*>"#;

/// Our `<a:ext>` as raw bytes, whether self-closing or paired.
///
/// ledger redact-self-closing-ext-swallows-next: the TypeScript pattern is
/// the second alternative alone. Its `[^>]*` takes the `/` of a self-closing
/// tag and then reads `>` as the end of an opening tag, so a self-closing
/// extension of ours followed by another extension matches through that one's
/// `</a:ext>`. Here a well-formed tag that closes itself is the whole match;
/// text that is not such a tag is read as the TypeScript reads it.
fn our_ext_re() -> &'static TryJsRegex {
    try_js_regex!(OUR_EXT_PATTERN)
}

/// Remove our extension from a raw `<a:rPr>` or `<p:spPr>`, leaving
/// everything else.
pub fn strip_redact_ext(xml: &str) -> Result<String, RegexLimit> {
    let without_ours = our_ext_re().try_replace_all(xml, |_| String::new())?;
    let mut stopped = None;
    // an apply/unapply cycle would otherwise leave an empty <a:extLst> behind.
    // ledger redact-strip-drops-extlst-attributes: the TypeScript writes a list
    // that still holds something back as `<a:extLst>inner</a:extLst>`, without
    // the attributes it had (a namespace declaration its content may need).
    // A list whose opening tag is well-formed is kept as it is here.
    let pruned = js_regex!(r"<a:extLst\b[^>]*?\/>|<a:extLst\b[^>]*>([\s\S]*?)<\/a:extLst>")
        .replace_all(&without_ours, |list| match list.get(1) {
            Some(inner) if !trim(inner).is_empty() => {
                match try_js_regex!(WELL_FORMED_EXTLST_OPEN).try_test(list.as_str()) {
                    Ok(true) => list.as_str().to_owned(),
                    Ok(false) => format!("<a:extLst>{inner}</a:extLst>"),
                    Err(limit) => {
                        stopped = Some(limit);
                        String::new()
                    }
                }
            }
            _ => String::new(),
        });
    if let Some(limit) = stopped {
        return Err(limit);
    }
    Ok(collapse_empty_props(&pruned))
}

/// Adding the mark gives a self-closing `<a:rPr/>` the paired form; take it
/// back once the mark is gone. Only an empty node is collapsed.
fn collapse_empty_props(xml: &str) -> String {
    js_regex!(r"<([\w:]+)\b([^>]*?)>([\s\S]*?)<\/\1>").replace_all(xml, |all| {
        if !trim(all.get(3).unwrap_or_default()).is_empty() {
            return all.as_str().to_owned();
        }
        format!(
            "<{}{}/>",
            all.get(1).unwrap_or_default(),
            all.get(2).unwrap_or_default().trim_end_matches(is_js_space),
        )
    })
}

/// Put the mark in a raw `<a:rPr>` (or `nvPr`) string, replacing any
/// previous one. The node's inner XML is kept verbatim; a self-closing node
/// gains a paired form because the mark needs a child.
pub fn set_redact_ext(props_xml: &str, label: &str) -> Result<String, RegexLimit> {
    let ext = redact_ext_xml(label);
    let Some(open) = js_regex!(r"<([\w:]+)\b[^>]*?(\/?)>").exec(props_xml) else {
        return Ok(props_xml.to_owned());
    };
    let whole = open.as_str();
    let tag = open.get(1).unwrap_or_default();
    let at = open.start();
    if open.get(2) == Some("/") {
        let head = format!("{}>", whole.strip_suffix("/>").unwrap_or(whole));
        return Ok(format!(
            "{}{head}<a:extLst>{ext}</a:extLst></{tag}>{}",
            props_xml.get(..at).unwrap_or_default(),
            props_xml.get(at + whole.len()..).unwrap_or_default(),
        ));
    }
    let close = format!("</{tag}>");
    let Some(close_at) = props_xml.rfind(&close) else {
        return Ok(props_xml.to_owned());
    };
    // a closing tag before the open one leaves an empty inner, as slice does
    let inner = props_xml
        .get(at + whole.len()..close_at)
        .unwrap_or_default();
    Ok(format!(
        "{}{whole}{}{close}{}",
        props_xml.get(..at).unwrap_or_default(),
        splice_ext_lst(inner, &ext)?,
        props_xml.get(close_at + close.len()..).unwrap_or_default(),
    ))
}

/// Replace our extension inside an existing `<a:extLst>`, or add one to the
/// inner XML.
fn splice_ext_lst(inner: &str, ext: &str) -> Result<String, RegexLimit> {
    let Some(list) = js_regex!(r"<a:extLst\b[^>]*?(?:\/>|>[\s\S]*?<\/a:extLst>)").exec(inner)
    else {
        // extLst is the last child both schemas allow here
        return Ok(format!("{inner}<a:extLst>{ext}</a:extLst>"));
    };
    let kept = our_ext_re().try_replace_all(list.as_str(), |_| String::new())?;
    // our own extension goes last so a re-apply replaces rather than appends.
    // ledger redact-label-dollar: the TypeScript passes it to replace as a
    // replacement string, which reads `$$`, `$&`, `` $` `` and `$'` in the
    // label as patterns; it goes in as written here.
    let next = if kept.contains("</a:extLst>") {
        kept.replacen("</a:extLst>", &format!("{ext}</a:extLst>"), 1)
    } else {
        replace_first_with(js_regex!(r"\/>$"), &kept, |_| format!(">{ext}</a:extLst>"))
    };
    Ok(format!(
        "{}{next}{}",
        inner.get(..list.start()).unwrap_or_default(),
        inner.get(list.end()..).unwrap_or_default(),
    ))
}
