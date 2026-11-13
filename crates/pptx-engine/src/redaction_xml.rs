//! The "withheld from the model" mark (packages/pptx-engine/src/redaction-xml.ts):
//! `<a:extLst><a:ext uri="..."><go:redact label="..."/></a:ext></a:extLst>`
//! inside a run's `<a:rPr>`, or inside a picture's `<p:spPr>`. The deck keeps
//! the real words; only the model's view swaps them for the label.

use jscompat::{TryJsRegex, is_js_space, js_regex, trim, truthy, try_js_regex};
use serde_json::Value;

use crate::xml_utils::{as_xml_node, attribute_of, element_range, escape_xml_attr, xml_array};

/// `REDACT_NS_WRITTEN` of packages/agent-core/src/redact-range.ts (the old
/// namespace, still the one written), which redaction-xml.ts re-exports.
pub const REDACT_NS_WRITTEN: &str = "https://genspark.ai/genoffice/redaction/2026";
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
        r#"<a:ext uri="{REDACT_EXT_URI}" xmlns:{REDACT_PREFIX}="{REDACT_NS_WRITTEN}"><{REDACT_EL} label="{}"/></a:ext>"#,
        escape_xml_attr(label)
    )
}

/// True when the fragment already carries our mark.
pub fn has_redact_ext_in(xml: &str) -> Result<bool, String> {
    Ok(!our_ext_ranges(xml)?.is_empty())
}

/// The label a SmartArt data part withholds its text under, or `None` when it
/// shows no trace of the mark. The shapes drawn for the diagram (its cached
/// drawing, or the layout made from the data) do not carry the data's marks,
/// so every word of the diagram is withheld under the first label the data
/// names (`private` when none can be read): a trace counts, whatever its
/// spelling.
pub fn diagram_data_redact_label(data_xml: Option<&str>) -> Result<Option<String>, String> {
    let Some(data_xml) = data_xml.filter(|xml| !xml.is_empty()) else {
        return Ok(None);
    };
    let text = js_regex!(r"&#(?:x([0-9a-fA-F]+)|(\d+));", "g").replace_all(data_xml, |m| {
        // a number past u32 is past 0x10FFFF too
        let code = match m.get(1) {
            Some(hex) => u32::from_str_radix(hex, 16).ok(),
            None => m.get(2).and_then(|dec| dec.parse::<u32>().ok()),
        };
        code.and_then(char::from_u32)
            .map_or_else(|| m.as_str().to_owned(), String::from)
    });
    if !text.contains(REDACT_EXT_URI) && !js_regex!(r"<(?:[\w.-]+:)?redact[\s/>]").test(&text) {
        return Ok(None);
    }
    let label =
        try_js_regex!(r#"<(?:[\w.-]+:)?redact\b[^>]*?\slabel\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
            .try_exec(&text)
            .map_err(|limit| limit.to_string())?;
    let value = label.and_then(|m| m.get(1).or_else(|| m.get(2)));
    Ok(Some(
        value
            .filter(|v| !v.is_empty())
            .unwrap_or("private")
            .to_owned(),
    ))
}

/// Sync our mark on the element named `tag` inside `xml`: `a:rPr` for a run,
/// `p:spPr` for a picture. No `label` removes it. `tag` is pasted into the
/// pattern unescaped, as the TypeScript does: one that does not compile
/// throws.
pub fn sync_redact_ext(xml: &str, tag: &str, label: Option<&str>) -> Result<String, String> {
    let Some(open) = TryJsRegex::new(
        &format!(r"<{tag}\b[^>]*?/>|<{tag}\b[^>]*?>[\s\S]*?</{tag}>"),
        "",
    )
    .map_err(|error| error.to_string())?
    .try_exec(xml)
    .map_err(|error| error.to_string())?
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

/// One `<a:ext>` matching our URI among the node's own extension lists. A node should hold one
/// list; a deck that holds two parses as an array, and reading it as a single node would miss a
/// mark in either.
fn our_ext(ext_lst: Option<&Value>) -> Option<&Value> {
    xml_array(ext_lst)
        .flat_map(|list| xml_array(list.get("a:ext")))
        .find(|ext| ext.get("@_uri").and_then(Value::as_str) == Some(REDACT_EXT_URI))
}

/// The label, read out of an already-parsed `<a:rPr>` or `<p:spPr>` node. The engine writes
/// `go:redact`; another writer may use another prefix or none, so the first key of our extension
/// that is `redact` under any prefix is the mark. Our extension exists only to carry the mark, so
/// one whose label cannot be read still withholds, as `private`.
pub fn read_redact_label(node: Option<&Value>) -> Option<&str> {
    let ext = our_ext(as_xml_node(node).get("a:extLst"))?;
    let mark = ext.as_object().and_then(|object| {
        object
            .keys()
            .find(|key| *key == REDACT_EL || js_regex!(r"^(?:[\w.-]+:)?redact$", "").test(key))
    });
    match mark.and_then(|key| as_xml_node(ext.get(key)).get("@_label")) {
        Some(Value::String(label)) if !label.is_empty() => Some(label.as_str()),
        _ => Some("private"),
    }
}

/// Where each of our `<a:ext>` lies in raw XML, self-closing or paired, in document order. An
/// extension is ours by its `uri` as XML reads it (`attribute_of`: any quotes, any white space
/// around `=`, references decoded), which is how the parser finds it on the way in.
fn our_ext_ranges(xml: &str) -> Result<Vec<(usize, usize)>, String> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    for open in try_js_regex!(r#"<a:ext\b(?:[^>"']|"[^"]*"|'[^']*')*>"#).try_find_iter(xml) {
        let open = open.map_err(|limit| limit.to_string())?;
        if open.start() < out.last().map_or(0, |range| range.1) {
            continue;
        }
        if attribute_of(open.as_str(), "uri").as_deref() != Some(REDACT_EXT_URI) {
            continue;
        }
        if let Some(ext) = element_range(xml, "a:ext", open.start())? {
            out.push((ext.start, ext.end));
        }
    }
    Ok(out)
}

/// `xml` without the ranges, which are in document order and do not overlap.
fn without(xml: &str, ranges: &[(usize, usize)]) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut at = 0;
    for &(start, end) in ranges {
        out.push_str(xml.get(at..start).unwrap_or_default());
        at = end;
    }
    out.push_str(xml.get(at..).unwrap_or_default());
    out
}

/// Remove our extension from a raw `<a:rPr>` or `<p:spPr>`, leaving
/// everything else.
pub fn strip_redact_ext(xml: &str) -> Result<String, String> {
    let mut out = xml.to_owned();
    // last first, so the offsets of the earlier ones stay valid
    for (ours_start, ours_end) in our_ext_ranges(xml)?.into_iter().rev() {
        let mut start = ours_start;
        let mut end = ours_end;
        // The list goes with it only when our extension was all it held: an apply/unapply
        // cycle would otherwise leave an empty <a:extLst> behind. A list that still holds
        // another extension, and every list we were never in, keeps its bytes.
        let open = js_regex!(r"<a:extLst\b[^>]*>\s*$").exec(out.get(..start).unwrap_or_default());
        let close = js_regex!(r"^\s*<\/a:extLst\s*>").exec(out.get(end..).unwrap_or_default());
        if let (Some(open), Some(close)) = (open, close) {
            start = open.start();
            end += close.as_str().len();
        }
        out = format!(
            "{}{}",
            out.get(..start).unwrap_or_default(),
            out.get(end..).unwrap_or_default()
        );
    }
    Ok(collapse_empty_props(&out))
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
pub fn set_redact_ext(props_xml: &str, label: &str) -> Result<String, String> {
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

/// The node's inner XML with the mark in the node's OWN extension list, replacing any mark
/// already in the node. The own list is the node's last child (both schemas put extLst last), and
/// it is the only one the reader looks in; a list earlier in the node belongs to a child.
fn splice_ext_lst(inner: &str, ext: &str) -> Result<String, String> {
    // a mark already in the node goes first, wherever it sits, so a re-apply replaces it
    let kept = without(inner, &our_ext_ranges(inner)?);
    let body = kept.trim_end_matches(is_js_space);
    let tail = kept.get(body.len()..).unwrap_or_default();
    // the last thing in the node closes its last child, so a list ending here is the node's own
    if let Some(close) = js_regex!(r"<\/a:extLst\s*>$").exec(body) {
        return Ok(format!(
            "{}{ext}{}{tail}",
            body.get(..close.start()).unwrap_or_default(),
            body.get(close.start()..).unwrap_or_default(),
        ));
    }
    if let Some(list) = js_regex!(r"<a:extLst\b[^>]*\/>$").exec(body) {
        let head = list.as_str().strip_suffix("/>").unwrap_or(list.as_str());
        return Ok(format!(
            "{}{head}>{ext}</a:extLst>{tail}",
            body.get(..list.start()).unwrap_or_default(),
        ));
    }
    // no list of its own: extLst is the last child both schemas allow here
    Ok(format!("{kept}<a:extLst>{ext}</a:extLst>"))
}
