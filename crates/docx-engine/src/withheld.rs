//! Text a person marked "hidden from AI" outside the body (withheld.ts), and
//! the comment entries of a comments part (comment-slices.ts).
//!
//! Everything here reads the parser's tree, never the XML by pattern: a
//! pattern that reads a tag differently from the parser (quotes, white space,
//! `>` inside a value, comments, CDATA) has handed a model the words the
//! parser then showed, or made up an entry out of markup inside CDATA.

use std::borrow::Cow;

use jscompat::{
    JsMap, RegexLimit, is_js_space, js_regex, replace_first_string, trim, try_js_regex,
};
use ooxml_xml::{XElement, XNode, mask_opaque, parse_ordered};
use serde::Serialize;

use crate::generate::escape_xml_attr;
use crate::props::XML_PARSER_MAX_NESTED_TAGS;
use crate::xml_tag::{TagName, find_start_tag, is_name_char};
use crate::xml_text::decode_entities;

/// `REDACT_PREFIX` of packages/agent-core/src/redact-range.ts.
pub(crate) const REDACT_PREFIX: &str = "go";
/// `REDACT_EL`
pub(crate) const REDACT_EL: &str = "go:redact";
/// `OWN_REDACT_NS`: the namespace this product owns for the label.
pub(crate) const OWN_REDACT_NS: &str = "https://github.com/SeuPut0705/seuoffice/redaction/2026";
/// `REDACT_NS_WRITTEN`: the namespace a label is written under.
pub(crate) const REDACT_NS_WRITTEN: &str = "https://genspark.ai/genoffice/redaction/2026";
/// `REDACT_NAMESPACES`: every namespace a saved label may be under.
pub(crate) const REDACT_NAMESPACES: [&str; 2] = [OWN_REDACT_NS, REDACT_NS_WRITTEN];

/// `WITHHELD_ENTRY_TEXT`: what a model reads for an entry whose marks cannot
/// all be read, the whole entry withheld (`placeholderSource('private')`).
pub const WITHHELD_ENTRY_TEXT: &str = "{{private}}";

/// The longest label a placeholder carries, `MAX_LABEL_LENGTH` of
/// packages/agent-core/src/redact-core.ts.
const MAX_LABEL_LENGTH: usize = 40;

/// `placeholderSource` of packages/agent-core/src/redact-core.ts: what a model
/// reads in place of the withheld words, the label cleaned of the characters
/// that would make the marker ambiguous.
pub fn placeholder_source(label: &str) -> String {
    let cleaned = sanitize_label(label);
    let label = if cleaned.is_empty() {
        "private"
    } else {
        &cleaned
    };
    format!("{{{{{label}}}}}")
}

/// `sanitizeLabel` without its options: the label of a placeholder.
pub(crate) fn sanitize_label(raw: &str) -> String {
    let stripped = js_regex!(r#"[{}<>="']"#, "g").replace_all(raw, |_| String::new());
    let spaced = js_regex!(r"\s+", "g").replace_all(&stripped, |_| " ".to_owned());
    trim(&cut_label(trim(&spaced))).to_owned()
}

/// `cutLabel`: the first `MAX_LABEL_LENGTH` UTF-16 units, without half of a
/// surrogate pair at the end.
fn cut_label(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= MAX_LABEL_LENGTH {
        return text.to_owned();
    }
    let mut end = MAX_LABEL_LENGTH;
    if (0xD800..=0xDBFF).contains(&units[end - 1]) {
        end -= 1;
    }
    String::from_utf16_lossy(&units[..end])
}

/// The mark under any prefix or none. The editor writes `go:redact`, but
/// another writer may bind the namespace to another prefix, declare it as the
/// mark's default, or inherit it from an element around it; a reader that
/// cannot tell which withholds the words rather than hand them over.
const MARK_RE: &str = r"<(?:[\w.-]+:)?redact\b";

/// `withheldLabelOf`: the label of a run whose rPr carries the mark, or
/// `None` when the run reads as itself. For the rPr the engine's parser
/// serialised (`Run.rawRPr`), so its spelling is the serialiser's; a mark
/// whose label is not read is withheld as `private`.
pub fn withheld_label_of(r_pr_xml: Option<&str>) -> Option<String> {
    let r_pr_xml = r_pr_xml.filter(|xml| !xml.is_empty())?;
    if !js_regex!(MARK_RE).test(r_pr_xml) {
        return None;
    }
    let label = js_regex!(r#"<(?:[\w.-]+:)?redact\b[^>]*?\sw:label="([^"]*)""#)
        .exec(r_pr_xml)
        .and_then(|found| found.get(1))
        .unwrap_or("private");
    Some(decode_entities(label))
}

/// `withheldPartLabel`: the label of the mark in a part that holds a drawing's
/// rich text (a chart part), or `None` when the part holds none. The drawing is
/// shown whole, so a mark anywhere in the part hides all of it; the label is
/// read off the first mark element (`label`, or `w:label`), else `private`.
pub fn withheld_part_label(part_xml: &str) -> Option<String> {
    if !has_withheld_trace(part_xml) {
        return None;
    }
    let found =
        js_regex!(r#"<(?:[\w.-]+:)?redact\b[^>]*?\s(?:w:)?label\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
            .exec(part_xml);
    let label = found
        .and_then(|found| found.get(1).or(found.get(2)))
        .unwrap_or("private");
    let label = decode_entities(label);
    Some(if label.is_empty() {
        "private".to_owned()
    } else {
        label
    })
}

/// `hasWithheldTrace`: whether the raw XML holds anything that looks like the
/// mark, comments and CDATA included.
pub fn has_withheld_trace(xml: &str) -> bool {
    js_regex!(MARK_RE).test(xml)
}

/// `nameOf(node)`: the empty name of `<>` is a name (its element has no
/// children, as `childrenOf` finds none), `None` only for a text node.
fn name_of(node: &XNode) -> Option<&str> {
    match node {
        XNode::Element(element) if !matches!(&*element.name, ":@" | "#text") => Some(&element.name),
        _ => None,
    }
}

fn is_mark(name: &str) -> bool {
    name == "redact" || name.ends_with(":redact")
}

/// The first mark element in the subtree.
fn mark_in(node: &XNode) -> Option<&XNode> {
    let name = name_of(node)?;
    if is_mark(name) {
        return Some(node);
    }
    node.children().iter().find_map(mark_in)
}

/// `hasMarkElement`: whether a parsed subtree holds a mark element.
pub fn has_mark_element(node: &XNode) -> bool {
    mark_in(node).is_some()
}

fn element(name: &str, children: Vec<XNode>) -> XNode {
    XNode::Element(XElement {
        name: name.to_owned(),
        attrs: Vec::new(),
        children,
    })
}

/// A run that holds a placeholder.
fn placeholder_run(label: &str) -> XNode {
    element(
        "w:r",
        vec![element("w:t", vec![XNode::Text(placeholder_source(label))])],
    )
}

/// A run's label, or `None` when the run reads as itself.
fn run_label(run: &XNode) -> Option<String> {
    let mark = mark_in(run.find_child("w:rPr")?)?;
    Some(match mark.attr("w:label") {
        Some(label) if !label.is_empty() => label.to_owned(),
        _ => "private".to_owned(),
    })
}

/// The element `node` is, with its children replaced.
fn with_children(node: &XNode, children: Vec<XNode>) -> XNode {
    match node {
        XNode::Element(element) => XNode::Element(XElement {
            name: element.name.clone(),
            attrs: element.attrs.clone(),
            children,
        }),
        XNode::Text(_) => node.clone(),
    }
}

fn withheld_children(nodes: &[XNode]) -> Option<Vec<XNode>> {
    let mut out = Vec::with_capacity(nodes.len());
    // the label of the placeholder just written: neighbours under one label read as one
    let mut last: Option<String> = None;
    for child in nodes {
        let Some(name) = name_of(child) else {
            out.push(child.clone());
            if let XNode::Text(text) = child
                && !trim(text).is_empty()
            {
                last = None;
            }
            continue;
        };
        // a mark on a paragraph mark: no words to withhold
        if name == "w:pPr" {
            out.push(child.clone());
            continue;
        }
        if is_mark(name) {
            return None;
        }
        let label = if name == "w:r" {
            run_label(child)
        } else {
            None
        };
        if let Some(label) = label {
            if last.as_deref() != Some(label.as_str()) {
                out.push(placeholder_run(&label));
            }
            last = Some(label);
            continue;
        }
        let inner = withheld_children(child.children())?;
        out.push(with_children(child, inner));
        last = None;
    }
    Some(out)
}

/// `withheldNode`: a parsed entry with every run hidden from AI replaced by a
/// run that holds its placeholder (neighbours under one label as one;
/// everything inside a hidden run goes with it, a nested text box included).
/// `None` when a mark sits anywhere but a run's properties or a paragraph
/// mark: the caller withholds the whole entry rather than guess which words
/// it meant.
pub fn withheld_node(node: &XNode) -> Option<XNode> {
    let Some(name) = name_of(node) else {
        return Some(node.clone());
    };
    if is_mark(name) {
        return None;
    }
    Some(with_children(node, withheld_children(node.children())?))
}

fn first_marked_run_label(node: &XNode) -> Option<String> {
    for child in node.children() {
        if name_of(child).is_none() {
            continue;
        }
        let label = if name_of(child) == Some("w:r") {
            run_label(child)
        } else {
            None
        };
        if label.is_some() {
            return label;
        }
        if let Some(inner) = first_marked_run_label(child) {
            return Some(inner);
        }
    }
    None
}

/// `withheldBlockLabel`: the label of the first run marked hidden from AI
/// anywhere in a block's XML (a text box's paragraphs and a field's cached
/// result included); `None` when no run is. A block that does not parse and
/// shows a trace of the mark is withheld as `private`.
pub fn withheld_block_label(block_xml: &str) -> Option<String> {
    match parse_entry(block_xml) {
        None => has_withheld_trace(block_xml).then(|| "private".to_owned()),
        Some(node) => first_marked_run_label(&node),
    }
}

/// `hiddenRunProperties`: the run properties of a run a person hid from AI, as
/// the Docs editor writes them: the character border and the mark carrying the
/// label.
pub fn hidden_run_properties(label: &str) -> String {
    let cleaned = sanitize_label(label);
    let label = if cleaned.is_empty() {
        "private"
    } else {
        &cleaned
    };
    format!(
        "<w:rPr><w:bdr w:val=\"single\" w:sz=\"6\" w:color=\"6B4FC0\"/><{REDACT_EL} w:label=\"{}\"/></w:rPr>",
        escape_xml_attr(label)
    )
}

/// `runsText`: the run text of a subtree as Word shows it: w:t, outside field
/// codes and deletions.
pub fn runs_text(node: &XNode) -> String {
    let mut out = String::new();
    for child in node.children() {
        match child {
            XNode::Text(_) => {}
            XNode::Element(_) => match child.name() {
                Some("w:t") => out.push_str(&child.text()),
                Some("w:instrText" | "w:delInstrText" | "w:delText") => {}
                _ => out.push_str(&runs_text(child)),
            },
        }
    }
    out
}

/// `parseEntry`: the first element of an XML text (a declaration skipped),
/// parsed; `None` when it does not parse.
pub fn parse_entry(xml: &str) -> Option<XNode> {
    parse_ordered(xml, XML_PARSER_MAX_NESTED_TAGS)
        .ok()?
        .into_iter()
        .find(|node| name_of(node).is_some_and(|name| !name.starts_with('?')))
}

/// `withheldText`: what a model reads of a parsed entry, given how its reader
/// reads text (`text_of`): `None` when the entry carries no mark, else its text
/// with each hidden run as its placeholder, or the whole entry withheld when
/// a mark sits where no run accounts for it. It is `Some` whenever a mark is
/// there, also when it reads as the entry's own words.
pub fn withheld_text(node: &XNode, text_of: &dyn Fn(&XNode) -> String) -> Option<String> {
    if !has_mark_element(node) {
        return None;
    }
    Some(match withheld_node(node) {
        None => WITHHELD_ENTRY_TEXT.to_owned(),
        Some(view) => text_of(&view),
    })
}

/// `firstMarkLabel`: the label of the first mark in an entry's XML, `private`
/// when it carries none that is read.
pub fn first_mark_label(entry_xml: &str) -> String {
    let label = parse_entry(entry_xml)
        .as_ref()
        .and_then(mark_in)
        .and_then(|mark| mark.attr("w:label").filter(|label| !label.is_empty()))
        .map(str::to_owned);
    label.unwrap_or_else(|| "private".to_owned())
}

/// `overWithheldModelText`: what a model reads of an entry written whole under
/// one mark (`over_withheld`): one placeholder per line that holds words (a
/// blank line reads as it is).
pub fn over_withheld_model_text(text: &str, label: &str) -> String {
    text.split('\n')
        .map(|line| {
            if js_regex!(r"\S").test(line) {
                placeholder_source(label)
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `overWithheld`: an entry written anew from its text, with every run that
/// holds words hidden under `label`. For an edit that cannot be patched around
/// an entry's hidden runs (a paragraph added, a change across hidden and plain
/// words): which of the new words are the hidden ones is no longer known, so
/// all of them are, and the person can show them to AI again. `entry_xml` is
/// the entry as this engine generates it (one run per text piece, no comments
/// or CDATA).
pub fn over_withheld(entry_xml: &str, label: &str) -> String {
    let mark = format!(
        "<w:bdr w:val=\"single\" w:sz=\"6\" w:color=\"6B4FC0\"/><{REDACT_EL} xmlns:{REDACT_PREFIX}=\"{REDACT_NS_WRITTEN}\" w:label=\"{}\"/>",
        escape_xml_attr(label)
    );
    js_regex!(r"<w:r(\s[^>]*)?>([\s\S]*?)<\/w:r>", "g").replace_all(entry_xml, |found| {
        let run = found.as_str();
        let inner = found.get(2).unwrap_or("");
        // a run with no content (a reference mark, a spacer) stays as it is
        if !js_regex!(
            r"<w:t(?:\s[^>]*)?>[^<]*\S[^<]*<\/w:t>|<w:(?:drawing|pict|object|sym)[\s>/]|<mc:AlternateContent[\s>]"
        )
        .test(inner)
        {
            return run.to_owned();
        }
        let marked = if inner.contains("</w:rPr>") {
            replace_first_string(inner, "</w:rPr>", &format!("{mark}</w:rPr>"))
        } else {
            format!("<w:rPr>{mark}</w:rPr>{inner}")
        };
        format!("<w:r{}>{marked}</w:r>", found.get(1).unwrap_or(""))
    })
}

/// `MC_NS`: the markup-compatibility namespace.
const MC_NS: &str = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/// One attribute of a start tag: its value, and where the value sits in the tag.
struct Attribute<'t> {
    value: &'t str,
    start: usize,
    end: usize,
}

/// `tagAttributes`: a start tag's attributes in order, each read through its
/// quotes; a name written twice keeps its first place and its last value.
fn tag_attributes(tag: &str) -> JsMap<Attribute<'_>> {
    let mut out = JsMap::new();
    for found in js_regex!(r#"\s([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#, "g").find_iter(tag) {
        let value = found.get(2).or(found.get(3)).unwrap_or("");
        // the closing quote of the value
        let end = found.end() - 1;
        out.set(
            found.get(1).unwrap_or(""),
            Attribute {
                value,
                start: end - value.len(),
                end,
            },
        );
    }
    out
}

/// The root start tag of a part, edited in place the way `withRedactRoot` edits it.
struct RootTag {
    text: String,
    /// the length of the element's name, which follows the `<`
    name_len: usize,
}

impl RootTag {
    fn new(text: &str) -> Self {
        let name_len = text.as_bytes()[1..]
            .iter()
            .take_while(|byte| is_name_char(**byte))
            .count();
        Self {
            text: text.to_owned(),
            name_len,
        }
    }

    /// `add`: an attribute right after the element's name.
    fn add(&mut self, attr: &str) {
        self.text.insert_str(1 + self.name_len, &format!(" {attr}"));
    }

    fn has(&self, name: &str) -> bool {
        tag_attributes(&self.text).has(name)
    }

    /// `prefixOf`: the prefix bound to `uri`, a URI compared as the parser reads
    /// it (character references decoded) and the prefix as it is written.
    fn prefix_of(&self, uri: &str) -> Option<String> {
        tag_attributes(&self.text)
            .iter()
            .find_map(|(name, attr)| {
                name.strip_prefix("xmlns:")
                    .filter(|_| decode_entities(attr.value) == uri)
            })
            .map(str::to_owned)
    }

    /// `ensure`: `token` in the list `mc:list`, once, the producer's own tokens kept.
    fn ensure(&mut self, mc: &str, list: &str, token: &str) {
        let name = format!("{mc}:{list}");
        // `None`: no such list; `Some(None)`: the list holds the token already
        let extended = tag_attributes(&self.text).get(&name).map(|attr| {
            let mut tokens: Vec<&str> = attr
                .value
                .split(is_js_space)
                .filter(|listed| !listed.is_empty())
                .collect();
            (!tokens.contains(&token)).then(|| {
                tokens.push(token);
                (attr.start..attr.end, tokens.join(" "))
            })
        });
        match extended {
            None => self.add(&format!("{name}=\"{token}\"")),
            Some(None) => {}
            Some(Some((value, joined))) => self.text.replace_range(value, &joined),
        }
    }
}

/// `withRedactRoot`: a written story part whose runs carry the mark, with its
/// root declaring what a consumer needs to keep that mark: the mark's
/// namespace, that namespace as ignorable (a consumer that does not know it
/// skips the element instead of rejecting the run) and the mark element as
/// preserved (a consumer that re-saves keeps it instead of dropping every
/// ignorable element). Both lists name the mark by the namespace it is really
/// in: the editor's own `go:` mark leans on the root for its namespace, and a
/// mark that declares its own (another writer, an older release) gets a root
/// prefix bound to that namespace. The root is read through its quoted values
/// whatever its name or quotes, and an existing markup-compatibility prefix
/// and lists are extended.
///
/// Borrowed exactly when the root needs no change, so a caller keeps the
/// original bytes of a part it did not write.
pub fn with_redact_root(part_xml: &str) -> Cow<'_, str> {
    if !has_withheld_trace(part_xml) {
        return Cow::Borrowed(part_xml);
    }
    let masked = mask_opaque(part_xml);
    let Some(found) = find_start_tag(&masked, TagName::Any, 0) else {
        return Cow::Borrowed(part_xml);
    };
    if found.self_closing {
        return Cow::Borrowed(part_xml);
    }
    let (start, end) = (found.start, found.end);
    let mut root = RootTag::new(&part_xml[start..end]);
    let own_prefix = root.has(&format!("xmlns:{REDACT_PREFIX}"));
    // the namespaces the part's marks are in
    let decoded = decode_entities(part_xml);
    let mut used: Vec<&str> = REDACT_NAMESPACES
        .into_iter()
        .filter(|ns| decoded.contains(ns))
        .collect();
    if !own_prefix && part_xml.contains(&format!("<{REDACT_EL}")) {
        root.add(&format!("xmlns:{REDACT_PREFIX}=\"{REDACT_NS_WRITTEN}\""));
        if !used.contains(&REDACT_NS_WRITTEN) {
            used.insert(0, REDACT_NS_WRITTEN);
        }
    }
    if used.is_empty() {
        return Cow::Borrowed(part_xml);
    }
    let mc = root.prefix_of(MC_NS).unwrap_or_else(|| {
        let mc = if root.has("xmlns:mc") { "mce" } else { "mc" };
        root.add(&format!("xmlns:{mc}=\"{MC_NS}\""));
        mc.to_owned()
    });
    for uri in used {
        let prefix = root.prefix_of(uri).unwrap_or_else(|| {
            let mut n = 1;
            while root.has(&format!("xmlns:{REDACT_PREFIX}{n}")) {
                n += 1;
            }
            let prefix = format!("{REDACT_PREFIX}{n}");
            root.add(&format!("xmlns:{prefix}=\"{uri}\""));
            prefix
        });
        root.ensure(&mc, "Ignorable", &prefix);
        root.ensure(&mc, "PreserveElements", &format!("{prefix}:redact"));
    }
    if root.text == part_xml[start..end] {
        return Cow::Borrowed(part_xml);
    }
    Cow::Owned(format!(
        "{}{}{}",
        &part_xml[..start],
        root.text,
        &part_xml[end..]
    ))
}

/// One `<w:comment>` of a comments part: its id and its exact bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommentEntry {
    pub id: String,
    pub xml: String,
}

/// `commentEntries`: each `<w:comment>` of a comments part with its id, read
/// the way the parser reads the tag (any quotes, white space around =, '>'
/// inside a value): a comment the save cannot find is written anew from its
/// plain text, and loses its runs, a hidden-from-AI mark included.
pub fn comment_entries(xml: &str) -> Result<Vec<CommentEntry>, RegexLimit> {
    let mut out = Vec::new();
    // tags are found where comments and CDATA cannot fake one; bytes come from xml
    let masked = mask_opaque(xml);
    let open = try_js_regex!(r#"<w:comment\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>"#, "g");
    // where the next search starts: past the comment just read
    let mut floor = 0;
    let mut matches = open.try_find_iter(&masked);
    while let Some(found) = matches.next() {
        let found = found?;
        if found.start() < floor {
            // a match that began inside the last comment and ends beyond it hides
            // what a search from its end would find
            if found.end() > floor {
                matches = open.try_find_from(&masked, floor);
            }
            continue;
        }
        let mut close = found.end();
        if found.get(2).unwrap_or("").is_empty() {
            let Some(end_tag) = js_regex!(r"<\/w:comment\s*>", "g")
                .find_from(&masked, found.end())
                .next()
            else {
                break;
            };
            close = end_tag.end();
        }
        let id = js_regex!(r#"(?:^|\s)w:id\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
            .exec(found.get(1).unwrap_or(""))
            .and_then(|id| id.get(1).or(id.get(2)))
            .filter(|value| !value.is_empty());
        if let Some(id) = id {
            out.push(CommentEntry {
                id: decode_entities(id),
                xml: xml[found.start()..close].to_owned(),
            });
        }
        floor = close;
    }
    Ok(out)
}
