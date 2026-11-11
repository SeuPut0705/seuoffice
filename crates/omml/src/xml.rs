//! The XML helpers math.ts takes from xml-utils.ts, and the property readers
//! both OMML converters share.

use ooxml_xml::XNode;

/// `maxNestedTags` of the TypeScript engine's `xmlParser`.
pub const XML_PARSER_MAX_NESTED_TAGS: usize = 100;

/// `escapeXmlText`, and with `attribute` `escapeXmlAttr`: drops the control
/// characters XML 1.0 forbids, escapes `&`, `<`, `>` and for an attribute `"`.
/// A duplicate of the escaping inside `ooxml_xml::serialize`, which that
/// crate does not export.
pub fn escape_xml(text: &str, attribute: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\u{0}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' => {}
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if attribute => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

/// `contentChildren`: child elements that are content, not `m:*Pr` property
/// bags or text between elements.
pub fn content_children(node: &XNode) -> impl Iterator<Item = &XNode> {
    node.children()
        .iter()
        .filter(|child| child.name().is_some_and(|name| !name.ends_with("Pr")))
}

/// `propVal`: the `m:val` of `childName` inside the property bag `prName`.
pub fn prop_val<'a>(node: &'a XNode, pr_name: &str, child_name: &str) -> Option<&'a str> {
    node.find_child(pr_name)?
        .find_child(child_name)?
        .attr("m:val")
}

/// `propOn`: present and not `0`, `false` or `off` in any case.
pub fn prop_on(node: &XNode, pr_name: &str, child_name: &str) -> bool {
    prop_val(node, pr_name, child_name)
        .is_some_and(|val| !matches!(&*val.to_lowercase(), "0" | "false" | "off"))
}

/// Whether a run is upright text: `m:sty="p"` or an `m:nor` in its `m:rPr`.
pub fn run_is_plain(run: &XNode) -> bool {
    prop_val(run, "m:rPr", "m:sty") == Some("p")
        || run
            .find_child("m:rPr")
            .and_then(|pr| pr.find_child("m:nor"))
            .is_some()
}
