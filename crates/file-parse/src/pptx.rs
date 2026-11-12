//! packages/file-parse/src/pptx.ts.
//!
//! The TypeScript reads every part with fast-xml-parser 5.10.1 under four
//! option sets. `ooxml_xml::parse_ordered` is that parser under the docx
//! options (no namespace stripping, attributes kept with no prefix), so each
//! part goes through two passes here: [`element_names`] walks the markup the
//! way the original walks it, giving the names its options produce
//! (`removeNSPrefix`, `transformTagName`) and the error it throws first,
//! including those raised on a stripped name and the TypeError of markup after
//! the document closed; `parse_ordered` builds the tree, whose elements then
//! take those names in document order and have their attributes rewritten the
//! way each option set keeps them.

use std::cmp::Ordering;
use std::collections::HashSet;

use jscompat::{
    JsMap, JsObject, RegexLimit, is_js_space, js_regex, number_to_string, to_number, trim,
    trim_start, try_js_regex,
};
use ooxml_pkg::{Package, load_zip_package};
use ooxml_xml::{AttributeMode, ParseError, XElement, XNode, parse_ordered_with_attributes};

use crate::opc::resolve_target;
use crate::pptx_redaction::redact_pptx_part_xml;

/// The parser's default `maxNestedTags`.
const MAX_NESTED_TAGS: usize = 100;

/// The option sets of the TypeScript's parsers.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Dialect {
    /// `parser`: `removeNSPrefix`, `ignoreAttributes`.
    Slide,
    /// `notesParser` and `commentParser`: `removeNSPrefix`, attributes kept
    /// under `@_` (stored here without the prefix).
    Stripped,
    /// `manifestParser`: names through `stripNamespacePrefix`, attribute
    /// names as written under `@_`, attribute values trimmed. Not
    /// order-preserving: read through [`manifest_parse`].
    Manifest,
}

fn strip_namespace_prefix(name: &str) -> &str {
    name.find(':')
        .map_or(name, |separator| &name[separator + 1..])
}

fn reserved_message(name: &str) -> String {
    format!(
        "[SECURITY] Invalid name: \"{name}\" is a reserved JavaScript keyword that could cause prototype pollution"
    )
}

/// `sanitizeName` with the default `onDangerousProperty`.
fn sanitize_name(name: &str) -> Result<String, String> {
    if matches!(name, "__proto__" | "constructor" | "prototype") {
        return Err(reserved_message(name));
    }
    if matches!(
        name,
        "hasOwnProperty"
            | "toString"
            | "valueOf"
            | "__defineGetter__"
            | "__defineSetter__"
            | "__lookupGetter__"
            | "__lookupSetter__"
    ) {
        return Ok(format!("__{name}"));
    }
    Ok(name.to_owned())
}

fn type_error(property: &str) -> String {
    format!("Cannot read properties of undefined (reading '{property}')")
}

/// `xmlData.replace(/\r\n?/g, "\n")`
fn normalize_newlines(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    while let Some(at) = rest.find('\r') {
        out.push_str(&rest[..at]);
        out.push('\n');
        rest = &rest[at + 1..];
        rest = rest.strip_prefix('\n').unwrap_or(rest);
    }
    out.push_str(rest);
    out
}

fn find_from(text: &str, needle: &str, from: usize) -> Option<usize> {
    text.get(from..)?.find(needle).map(|at| from + at)
}

/// `tagExpWithClosingIndex`: where the first `closing` outside quotes starts.
fn tag_end(source: &str, from: usize, closing: &[u8]) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut quote = 0u8;
    for index in from..bytes.len() {
        let byte = bytes[index];
        if quote != 0 {
            if byte == quote {
                quote = 0;
            }
        } else if byte == b'"' || byte == b'\'' {
            quote = byte;
        } else if bytes[index..].starts_with(closing) {
            return Some(index);
        }
    }
    None
}

/// What the original throws when an opening tag never closes. The context is
/// cut in UTF-16 units, so it can split a surrogate pair a Rust string cannot
/// hold.
fn unclosed_tag_message(source: &str, at: usize) -> String {
    let position = source[..at].encode_utf16().count();
    let units: Vec<u16> = source.encode_utf16().collect();
    let context = &units[position.saturating_sub(50)..units.len().min(position + 50)];
    match String::from_utf16(context) {
        Ok(context) => {
            format!("readTagExp returned undefined at position {position}. Context: \"{context}\"")
        }
        Err(_) => ParseError::SplitSurrogatePair.to_string(),
    }
}

/// The name the original gives each element, in document order (`None`: a
/// processing instruction, named as written), or the message of the first
/// thing it throws on.
fn element_names(xml: &str, dialect: Dialect) -> Result<Vec<Option<String>>, String> {
    let source = normalize_newlines(xml);
    let source = source.as_str();
    let mut names = Vec::new();
    let mut depth = 0usize;
    // a closing tag closed the document node: the original's current node is
    // undefined from here on
    let mut detached = false;
    let mut text_pending = false;
    let mut cursor = 0;
    while let Some(found) = source[cursor..].find('<') {
        let at = cursor + found;
        if found > 0 {
            text_pending = true;
        }
        let rest = &source[at..];
        if rest.starts_with("</") {
            let close = find_from(source, ">", at).ok_or("Closing Tag is not closed.")?;
            sanitize_name(strip_namespace_prefix(trim(&source[at + 2..close])))?;
            if depth > 0 {
                depth -= 1;
            } else {
                detached = true;
            }
            text_pending = false;
            cursor = close + 1;
        } else if rest.starts_with("<?") {
            let close = tag_end(source, at + 1, b"?>").ok_or("Pi Tag is not closed.")?;
            if detached {
                return Err(type_error(if text_pending { "child" } else { "addChild" }));
            }
            names.push(None);
            text_pending = false;
            cursor = close + 2;
        } else if rest.starts_with("<!--") {
            let close = find_from(source, "-->", at + 4).ok_or("Comment is not closed.")?;
            cursor = close + 3;
        } else if rest.starts_with("<!D") {
            return Err(ParseError::Doctype.to_string());
        } else if rest.starts_with("<![") {
            let close = find_from(source, "]]>", at).ok_or("CDATA is not closed.")?;
            if detached {
                return Err(type_error(if text_pending { "child" } else { "tagname" }));
            }
            text_pending = false;
            cursor = close + 3;
        } else {
            let Some(close) = tag_end(source, at + 1, b">") else {
                return Err(unclosed_tag_message(source, at));
            };
            let expression = &source[at + 1..close];
            let (raw_name, tag_exp) =
                match expression.char_indices().find(|(_, ch)| is_js_space(*ch)) {
                    Some((index, space)) => (
                        &expression[..index],
                        trim_start(&expression[index + space.len_utf8()..]),
                    ),
                    None => (expression, expression),
                };
            let first = sanitize_name(strip_namespace_prefix(raw_name))?;
            if first == "#text" {
                return Err(format!("Invalid tag name: {first}"));
            }
            let self_closing = tag_exp.ends_with('/');
            let name = if self_closing {
                let bare = first.strip_suffix('/').unwrap_or(&first);
                // the self-closing branch runs the name transform a second time
                if dialect == Dialect::Manifest {
                    sanitize_name(strip_namespace_prefix(bare))?
                } else {
                    sanitize_name(bare)?
                }
            } else {
                if depth > MAX_NESTED_TAGS {
                    return Err(ParseError::MaxNestedTags.to_string());
                }
                first
            };
            if detached {
                return Err(type_error("addChild"));
            }
            if !self_closing {
                depth += 1;
            }
            names.push(Some(name));
            text_pending = false;
            cursor = close + 1;
        }
    }
    Ok(names)
}

/// Only reached where [`element_names`] saw nothing to throw on, which leaves
/// what the docx options refuse and these options do not.
fn parser_message(error: ParseError) -> String {
    match error {
        ParseError::ReservedName(name) => reserved_message(&name),
        other => other.to_string(),
    }
}

fn rename(nodes: &mut [XNode], names: &mut impl Iterator<Item = Option<String>>, dialect: Dialect) {
    for node in nodes {
        if let XNode::Element(element) = node {
            if let Some(Some(name)) = names.next() {
                element.name = name;
            }
            if dialect == Dialect::Manifest {
                for (_, value) in &mut element.attrs {
                    *value = trim(value).to_owned();
                }
            }
            rename(&mut element.children, names, dialect);
        }
    }
}

/// `new XMLParser(options).parse(xml)` with `preserveOrder`.
fn parse_part(xml: &str, dialect: Dialect) -> Result<Vec<XNode>, String> {
    let names = element_names(xml, dialect)?;
    let mode = match dialect {
        Dialect::Slide => AttributeMode::Ignored,
        Dialect::Stripped => AttributeMode::Stripped,
        Dialect::Manifest => AttributeMode::Prefixed,
    };
    let mut tree =
        parse_ordered_with_attributes(xml, MAX_NESTED_TAGS, mode).map_err(parser_message)?;
    rename(&mut tree, &mut names.into_iter(), dialect);
    Ok(tree)
}

/// A value of the object `manifestParser` returns.
enum JVal {
    Str(String),
    Arr(Vec<JVal>),
    Obj(JsObject<JVal>),
}

/// `String(value)`
fn js_string(value: &JVal) -> String {
    match value {
        JVal::Str(text) => text.clone(),
        JVal::Arr(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        JVal::Obj(_) => "[object Object]".to_owned(),
    }
}

/// `compress` of node2json: the object, and what goes under `#text` once
/// the element keys are in.
fn compress(nodes: &[XNode]) -> (JsObject<JVal>, Option<JVal>) {
    let mut text: Option<JVal> = None;
    let mut object: JsObject<JVal> = JsObject::new();
    for node in nodes {
        let element = match node {
            XNode::Text(value) => {
                text = Some(match text {
                    None => JVal::Str(value.clone()),
                    Some(before) => JVal::Str(js_string(&before) + value),
                });
                continue;
            }
            XNode::Element(element) => element,
        };
        // `{ ':@': ... }` has no property name the walk sees
        if element.name == ":@" {
            continue;
        }
        // only a self-closing `#text` element parses, so its value is `[]`
        if element.name == "#text" {
            text = Some(match text {
                None => JVal::Arr(Vec::new()),
                Some(before) => JVal::Str(js_string(&before)),
            });
            continue;
        }
        let (mut map, own_text) = compress(&element.children);
        let value = if !element.attrs.is_empty() {
            if let Some(own_text) = own_text {
                map.set("#text", own_text);
            }
            for (name, value) in &element.attrs {
                map.set(format!("@_{name}"), JVal::Str(value.clone()));
            }
            JVal::Obj(map)
        } else if let Some(own_text) = own_text {
            if map.is_empty() {
                own_text
            } else {
                map.set("#text", own_text);
                JVal::Obj(map)
            }
        } else if map.is_empty() {
            JVal::Str(String::new())
        } else {
            JVal::Obj(map)
        };
        match object.get_mut(&element.name) {
            Some(JVal::Arr(items)) => items.push(value),
            Some(existing) => {
                let first = std::mem::replace(existing, JVal::Arr(Vec::new()));
                *existing = JVal::Arr(vec![first, value]);
            }
            None => object.set(element.name.clone(), value),
        }
    }
    let text = match text {
        Some(JVal::Str(text)) if text.is_empty() => None,
        other => other,
    };
    (object, text)
}

fn manifest_parse(xml: &str) -> Result<JsObject<JVal>, String> {
    let tree = parse_part(xml, Dialect::Manifest)?;
    let (mut root, text) = compress(&tree);
    if let Some(text) = text {
        root.set("#text", text);
    }
    Ok(root)
}

/// `value?.[key]`: only an object has the keys read here.
fn prop<'a>(value: Option<&'a JVal>, key: &str) -> Option<&'a JVal> {
    match value {
        Some(JVal::Obj(map)) => map.get(key),
        _ => None,
    }
}

/// `String(node[key] ?? '')`
fn field(node: &JVal, key: &str) -> String {
    prop(Some(node), key).map(js_string).unwrap_or_default()
}

fn as_array(value: Option<&JVal>) -> Vec<&JVal> {
    match value {
        None => Vec::new(),
        Some(JVal::Arr(items)) => items.iter().collect(),
        Some(value) => vec![value],
    }
}

fn relationship_id(node: &JVal) -> String {
    let JVal::Obj(map) = node else {
        return String::new();
    };
    let qualified = map
        .entries()
        .into_iter()
        .find(|(key, _)| js_regex!(r"^@_[^:]+:id$").test(key));
    match qualified {
        Some((_, value)) => js_string(value),
        None => map.get("@_id").map(js_string).unwrap_or_default(),
    }
}

fn slide_number(path: &str) -> f64 {
    js_regex!(r"slide(\d+)\.xml$")
        .exec(path)
        .map_or(0.0, |found| to_number(found.get(1).unwrap_or_default()))
}

/// `zip.files[path]?.async('text')`
fn zip_text<'a>(zip: &'a Package, path: &str) -> Result<Option<&'a str>, String> {
    zip.text(path).map_err(|error| error.reason)
}

struct Relationship {
    target: String,
    kind: String,
    external: bool,
}

fn is_external(node: &JVal) -> bool {
    field(node, "@_TargetMode").to_lowercase() == "external"
}

fn presentation_slide_entries(zip: &Package) -> Result<Option<Vec<Option<String>>>, String> {
    let Some(pres_xml) = zip_text(zip, "ppt/presentation.xml")? else {
        return Ok(None);
    };
    let pres = manifest_parse(pres_xml)?;
    let slide_ids = as_array(prop(prop(pres.get("presentation"), "sldIdLst"), "sldId"));

    let mut rels: JsMap<Relationship> = JsMap::new();
    let rels_xml = zip_text(zip, "ppt/_rels/presentation.xml.rels")?;
    if let Some(rels_xml) = rels_xml.filter(|xml| !xml.is_empty()) {
        let doc = manifest_parse(rels_xml)?;
        for rel in as_array(prop(doc.get("Relationships"), "Relationship")) {
            let id = field(rel, "@_Id");
            if id.is_empty() {
                continue;
            }
            rels.set(
                id,
                Relationship {
                    target: field(rel, "@_Target"),
                    kind: field(rel, "@_Type"),
                    external: is_external(rel),
                },
            );
        }
    }

    let entries = slide_ids
        .into_iter()
        .map(|sld_id| {
            rels.get(&relationship_id(sld_id))
                .filter(|rel| {
                    !rel.external && !rel.target.is_empty() && rel.kind.ends_with("/slide")
                })
                .map(|rel| resolve_target("ppt/presentation.xml", &rel.target))
        })
        .collect();
    Ok(Some(entries))
}

fn legacy_slide_paths(zip: &Package) -> Vec<&str> {
    let mut paths: Vec<&str> = zip
        .parts()
        .iter()
        .map(|part| part.name.as_str())
        .filter(|path| js_regex!(r"^ppt/slides/slide\d+\.xml$").test(path))
        .collect();
    paths.sort_by(|a, b| {
        let difference = slide_number(a) - slide_number(b);
        difference.partial_cmp(&0.0).unwrap_or(Ordering::Equal)
    });
    paths
}

const NOTES_SLIDE_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
const COMMENT_AUTHOR_PATHS: [&str; 2] = ["ppt/commentAuthors.xml", "ppt/authors.xml"];

/// 2006 (`.../relationships/comments`) and Office 365 (`.../2018/10/relationships/comments`).
fn is_comments_relationship(kind: &str) -> bool {
    js_regex!(r"/comments$", "i").test(kind)
}

/// The .rels part that belongs to a package part. `None` where the
/// TypeScript's name ends in half a surrogate pair, which no part can be named.
fn rels_path_for(part_path: &str) -> Option<String> {
    match part_path.rfind('/') {
        Some(slash) => Some(format!(
            "{}/_rels/{}.rels",
            &part_path[..slash],
            &part_path[slash + 1..]
        )),
        // `slice(0, -1)` drops the last UTF-16 unit
        None => {
            let last = part_path.chars().next_back();
            if last.is_some_and(|ch| ch.len_utf16() == 2) {
                return None;
            }
            let head = &part_path[..part_path.len() - last.map_or(0, char::len_utf8)];
            Some(format!("{head}/_rels/{part_path}.rels"))
        }
    }
}

fn rels_text<'a>(zip: &'a Package, slide_path: &str) -> Result<Option<&'a str>, String> {
    match rels_path_for(slide_path) {
        Some(path) => zip_text(zip, &path),
        None => Ok(None),
    }
}

fn notes_xml_for_slide<'a>(zip: &'a Package, slide_path: &str) -> Result<Option<&'a str>, String> {
    let Some(rels_xml) = rels_text(zip, slide_path)?.filter(|xml| !xml.is_empty()) else {
        return Ok(None);
    };
    let doc = manifest_parse(rels_xml)?;
    for rel in as_array(prop(doc.get("Relationships"), "Relationship")) {
        if field(rel, "@_Type") != NOTES_SLIDE_REL {
            continue;
        }
        if is_external(rel) {
            continue;
        }
        let target = field(rel, "@_Target");
        return if target.is_empty() {
            Ok(None)
        } else {
            zip_text(zip, &resolve_target(slide_path, &target))
        };
    }
    Ok(None)
}

/// body placeholder only: the notes page's slide-number field would read as a stray digit
fn notes_paragraphs(notes_xml: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let tree = parse_part(notes_xml, Dialect::Stripped)?;
    let shapes = child(child(child(&tree, "notes"), "cSld"), "spTree");
    walk_shapes(shapes, &mut out);
    Ok(out)
}

fn walk_shapes(nodes: &[XNode], out: &mut Vec<String>) {
    for shape in nodes {
        if let Some(group) = children_named(shape, "grpSp") {
            walk_shapes(group, out);
        }
        if let Some(alternate) = children_named(shape, "AlternateContent") {
            walk_shapes(mc_branch(alternate), out);
        }
        let Some(children) = children_named(shape, "sp") else {
            continue;
        };
        let properties = child(child(children, "nvSpPr"), "nvPr");
        let placeholder = properties
            .iter()
            .find(|node| children_named(node, "ph").is_some());
        if placeholder.and_then(|node| attr(node, "type")) != Some("body") {
            continue;
        }
        collect_paragraphs(child(children, "txBody"), out);
    }
}

/// An element named `:@` with attributes is `{ ':@': attrs }` in the
/// original: the attributes overwrite its children.
fn shadowed(element: &XElement) -> bool {
    element.name == ":@" && !element.attrs.is_empty()
}

/// `node[name]` when it is an array: the children of an element named `name`.
fn children_named<'a>(node: &'a XNode, name: &str) -> Option<&'a [XNode]> {
    match node {
        XNode::Element(element) if element.name == name && !shadowed(element) => {
            Some(&element.children)
        }
        _ => None,
    }
}

/// the first element named `name`'s own children, or none if there is no such element
fn child<'a>(nodes: &'a [XNode], name: &str) -> &'a [XNode] {
    nodes
        .iter()
        .find_map(|node| children_named(node, name))
        .unwrap_or(&[])
}

/// every sibling in `nodes` named `name`, in document order
fn elements_named<'a>(nodes: &'a [XNode], name: &'a str) -> impl Iterator<Item = &'a [XNode]> + 'a {
    nodes
        .iter()
        .filter_map(move |node| children_named(node, name))
}

fn attr<'a>(node: &'a XNode, key: &str) -> Option<&'a str> {
    match node {
        XNode::Element(element) => element
            .attrs
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str()),
        XNode::Text(_) => None,
    }
}

/// A comments/author part is optional decoration on a deck. Missing, malformed or
/// unreadable parts just mean there is nothing to add, never a failed attachment.
fn parse_comment_part(xml: Option<&str>) -> Option<Vec<XNode>> {
    let xml = xml?;
    // a part too large to validate is an unreadable part
    if !xml_validates(xml).ok()? {
        return None;
    }
    parse_part(xml, Dialect::Stripped).ok()
}

struct SlideCommentLine {
    author: String,
    dt: String,
    text: String,
}

/// 2006 `<p:text>`: plain character data, no sub-elements. None when there is no such element.
fn plain_comment_text(children: &[XNode]) -> Option<String> {
    let parts = elements_named(children, "text").next()?;
    Some(
        parts
            .iter()
            .map(|part| match part {
                XNode::Text(text) => text.as_str(),
                XNode::Element(_) => "",
            })
            .collect(),
    )
}

/// Office 365 `<p188:txBody>`: read the same order-preserving walk as slide and notes text.
fn rich_comment_text(children: &[XNode]) -> Option<String> {
    let body = elements_named(children, "txBody").next()?;
    let mut paras = Vec::new();
    collect_paragraphs(body, &mut paras);
    Some(paras.join("\n"))
}

fn comment_body_text(children: &[XNode]) -> String {
    plain_comment_text(children)
        .or_else(|| rich_comment_text(children))
        .unwrap_or_default()
}

fn comment_timestamp(node: &XNode) -> String {
    if let Some(dt) = attr(node, "dt").filter(|dt| !dt.is_empty()) {
        return dt.to_owned();
    }
    attr(node, "created").unwrap_or_default().to_owned()
}

/// `node` is one `<p:cm>` or `<p188:reply>`.
fn push_comment(
    out: &mut Vec<SlideCommentLine>,
    node: &XNode,
    children: &[XNode],
    authors: &JsMap<String>,
) {
    let author_id = attr(node, "authorId").unwrap_or_default();
    let known = if author_id.is_empty() {
        None
    } else {
        authors.get(author_id)
    };
    out.push(SlideCommentLine {
        author: known
            .filter(|name| !trim(name).is_empty())
            .cloned()
            .unwrap_or_else(|| "Unknown author".to_owned()),
        dt: comment_timestamp(node),
        text: comment_body_text(children),
    });
}

/// every sibling element named `name` with its children
fn nodes_named<'a>(
    nodes: &'a [XNode],
    name: &'a str,
) -> impl Iterator<Item = (&'a XNode, &'a [XNode])> + 'a {
    nodes
        .iter()
        .filter_map(move |node| children_named(node, name).map(|children| (node, children)))
}

fn add_authors(authors: &mut JsMap<String>, tree: Option<Vec<XNode>>) {
    let Some(tree) = tree else {
        return;
    };
    for list_tag in ["cmAuthorLst", "authorLst"] {
        let list = child(&tree, list_tag);
        for entry_tag in ["cmAuthor", "author"] {
            for (entry, _) in nodes_named(list, entry_tag) {
                let (Some(id), Some(name)) = (attr(entry, "id"), attr(entry, "name")) else {
                    continue;
                };
                if !id.is_empty() && !trim(name).is_empty() {
                    authors.set(id, name.to_owned());
                }
            }
        }
    }
}

/// author table shared by every comments part; a missing table leaves ids unresolved
fn comment_authors(zip: &Package) -> JsMap<String> {
    let mut authors = JsMap::new();
    for path in COMMENT_AUTHOR_PATHS {
        let Ok(xml) = zip_text(zip, path) else {
            continue;
        };
        add_authors(&mut authors, parse_comment_part(xml));
    }
    authors
}

fn comments_xml_for_slide<'a>(zip: &'a Package, slide_path: &str) -> Option<&'a str> {
    let rels_xml = rels_text(zip, slide_path).ok()??;
    if rels_xml.is_empty() {
        return None;
    }
    let doc = manifest_parse(rels_xml).ok()?;
    for rel in as_array(prop(doc.get("Relationships"), "Relationship")) {
        if !is_comments_relationship(&field(rel, "@_Type")) {
            continue;
        }
        if is_external(rel) {
            continue;
        }
        let target = field(rel, "@_Target");
        return if target.is_empty() {
            None
        } else {
            zip_text(zip, &resolve_target(slide_path, &target)).ok()?
        };
    }
    None
}

fn slide_comments_for_slide(
    zip: &Package,
    slide_path: &str,
    authors: &JsMap<String>,
) -> Result<Vec<SlideCommentLine>, String> {
    let raw_xml = comments_xml_for_slide(zip, slide_path);
    // Withheld runs become their {{label}} marker before anything reads the
    // part. A mark that cannot be processed fails the deck; only the zip-read
    // and malformed-XML failures above count as "nothing to add".
    let xml = raw_xml.map(redact_pptx_part_xml).transpose()?;
    let tree = parse_comment_part(xml.as_deref());
    let mut out = Vec::new();
    let Some(tree) = tree else {
        return Ok(out);
    };
    let cm_list = child(&tree, "cmLst");
    for (cm, cm_children) in nodes_named(cm_list, "cm") {
        push_comment(&mut out, cm, cm_children, authors);
        let reply_list = child(cm_children, "replyLst");
        for (reply, reply_children) in nodes_named(reply_list, "reply") {
            push_comment(&mut out, reply, reply_children, authors);
        }
    }
    Ok(out)
}

fn comment_lines(comments: &[SlideCommentLine]) -> Vec<String> {
    if comments.is_empty() {
        return Vec::new();
    }
    let mut lines = vec!["### Comments".to_owned()];
    lines.extend(comments.iter().map(|comment| {
        if comment.dt.is_empty() {
            format!("- {}: {}", comment.author, comment.text)
        } else {
            format!("- {} ({}): {}", comment.author, comment.dt, comment.text)
        }
    }));
    lines
}

/// One compatibility branch of an mc:AlternateContent element: the Fallback when the
/// producer wrote one, else the first Choice. Reading both branches would duplicate
/// every run and every picture the element carries.
fn mc_branch(value: &[XNode]) -> &[XNode] {
    let mut choice = None;
    for entry in value {
        let XNode::Element(element) = entry else {
            continue;
        };
        if shadowed(element) {
            continue;
        }
        if element.name == "Fallback" {
            return &element.children;
        }
        if element.name == "Choice" && choice.is_none() {
            choice = Some(element.children.as_slice());
        }
    }
    choice.unwrap_or(&[])
}

/// One paragraph's text in document order. Only text directly under a:t counts.
fn collect_text(nodes: &[XNode], out: &mut String, is_text: bool) {
    for node in nodes {
        match node {
            XNode::Text(text) => {
                if is_text {
                    out.push_str(text);
                }
            }
            XNode::Element(element) => {
                if shadowed(element) {
                    continue;
                }
                match element.name.as_str() {
                    // only a self-closing `#text` element parses: String([]) adds nothing
                    "#text" => {}
                    "br" => out.push('\n'),
                    "tab" => out.push('\t'),
                    "AlternateContent" => collect_text(mc_branch(&element.children), out, false),
                    name => collect_text(&element.children, out, name == "t"),
                }
            }
        }
    }
}

/// walk the slide tree; each a:p paragraph becomes one output entry (a:br splits it further)
fn collect_paragraphs(nodes: &[XNode], out: &mut Vec<String>) {
    for node in nodes {
        let XNode::Element(element) = node else {
            continue;
        };
        if shadowed(element) {
            continue;
        }
        if element.name == "p" {
            let mut line = String::new();
            collect_text(&element.children, &mut line, false);
            if !trim(&line).is_empty() {
                out.push(line);
            }
        } else if element.name == "AlternateContent" {
            collect_paragraphs(mc_branch(&element.children), out);
        } else {
            collect_paragraphs(&element.children, out);
        }
    }
}

fn count_pictures(nodes: &[XNode]) -> usize {
    let mut count = 0;
    for node in nodes {
        let XNode::Element(element) = node else {
            continue;
        };
        if shadowed(element) {
            continue;
        }
        if element.name == "pic" {
            count += 1;
        } else if element.name == "AlternateContent" {
            count += count_pictures(mc_branch(&element.children));
        } else {
            count += count_pictures(&element.children);
        }
    }
    count
}

struct SlideSection {
    section: String,
    has_text: bool,
    pictures: usize,
}

fn slide_section(
    heading: String,
    xml: &str,
    notes_xml: Option<&str>,
    comments: &[SlideCommentLine],
) -> Result<SlideSection, String> {
    // withheld runs become their {{label}} marker before anything reads the part;
    // a mark that cannot be processed throws, so the deck fails instead of leaking
    let xml = redact_pptx_part_xml(xml)?;
    let notes_xml = match notes_xml {
        Some(notes) if !notes.is_empty() => Some(redact_pptx_part_xml(notes)?),
        _ => None,
    };
    let tree = parse_part(&xml, Dialect::Slide)?;
    let mut paras = Vec::new();
    collect_paragraphs(&tree, &mut paras);
    let notes = match notes_xml.as_deref() {
        Some(notes) if !notes.is_empty() => notes_paragraphs(notes)?,
        _ => Vec::new(),
    };
    let notes_count = notes.len();
    let mut extras = Vec::new();
    if !notes.is_empty() {
        extras.push("### Notes".to_owned());
        extras.extend(notes);
    }
    extras.extend(comment_lines(comments));
    if !paras.is_empty() {
        let mut lines = vec![heading];
        lines.extend(paras);
        lines.extend(extras);
        return Ok(SlideSection {
            section: lines.join("\n"),
            has_text: true,
            pictures: 0,
        });
    }
    let pictures = count_pictures(&tree);
    let mut lines = vec![heading];
    if pictures > 0 {
        let plural = if pictures == 1 { "" } else { "s" };
        lines.push(format!(
            "[picture-only slide: {pictures} image{plural}, no extractable text]"
        ));
    }
    lines.extend(extras);
    Ok(SlideSection {
        section: lines.join("\n"),
        has_text: notes_count > 0 || !comments.is_empty(),
        pictures,
    })
}

fn join_sections(sections: &[SlideSection]) -> String {
    let body = sections
        .iter()
        .map(|section| section.section.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    if sections.iter().any(|section| section.has_text)
        || !sections.iter().any(|section| section.pictures > 0)
    {
        return body;
    }
    let n = sections.len();
    let plural = if n == 1 { "" } else { "s" };
    format!(
        "[No extractable text: none of the {n} slide{plural} carries text; the content is in embedded images, which this extraction does not read.]\n\n{body}"
    )
}

/// extract slide text from a pptx: one "## Slide N" section per slide, a line per paragraph
pub fn pptx_to_text(bytes: &[u8]) -> Result<String, String> {
    let zip = load_zip_package(bytes)?;
    let slide_entries = presentation_slide_entries(&zip)?;
    let authors = comment_authors(&zip);
    let mut sections = Vec::new();
    if let Some(slide_entries) = slide_entries {
        for (index, path) in slide_entries.iter().enumerate() {
            let Some(path) = path else {
                continue;
            };
            let Some(xml) = zip_text(&zip, path)?.filter(|xml| !xml.is_empty()) else {
                continue;
            };
            let notes = notes_xml_for_slide(&zip, path)?;
            let comments = slide_comments_for_slide(&zip, path, &authors)?;
            sections.push(slide_section(
                format!("## Slide {}", index + 1),
                xml,
                notes,
                &comments,
            )?);
        }
        return Ok(join_sections(&sections));
    }
    for path in legacy_slide_paths(&zip) {
        let Some(xml) = zip_text(&zip, path)?.filter(|xml| !xml.is_empty()) else {
            continue;
        };
        let notes = notes_xml_for_slide(&zip, path)?;
        let comments = slide_comments_for_slide(&zip, path, &authors)?;
        sections.push(slide_section(
            format!("## Slide {}", number_to_string(slide_number(path))),
            xml,
            notes,
            &comments,
        )?);
    }
    Ok(join_sections(&sections))
}

// fast-xml-parser's XMLValidator.validate, as far as whether it answers true.
// It walks UTF-16 code units, so it is ported over them.

fn unit_is(data: &[u16], index: usize, ch: u8) -> bool {
    data.get(index) == Some(&u16::from(ch))
}

fn is_white_space(unit: u16) -> bool {
    matches!(unit, 0x20 | 0x09 | 0x0A | 0x0D)
}

fn is_name_start_char(ch: char) -> bool {
    matches!(ch,
        ':' | 'A'..='Z' | '_' | 'a'..='z'
        | '\u{C0}'..='\u{D6}' | '\u{D8}'..='\u{F6}' | '\u{F8}'..='\u{2FF}'
        | '\u{370}'..='\u{37D}' | '\u{37F}'..='\u{1FFF}' | '\u{200C}'..='\u{200D}'
        | '\u{2070}'..='\u{218F}' | '\u{2C00}'..='\u{2FEF}' | '\u{3001}'..='\u{D7FF}'
        | '\u{F900}'..='\u{FDCF}' | '\u{FDF0}'..='\u{FFFD}')
}

fn is_name_char(ch: char) -> bool {
    is_name_start_char(ch)
        || matches!(ch, '-' | '.' | '0'..='9' | '\u{B7}' | '\u{300}'..='\u{36F}' | '\u{203F}'..='\u{2040}')
}

/// `isName`. A character outside the BMP is two surrogate units there, and
/// neither is in the name ranges.
fn is_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(is_name_start_char) && chars.all(is_name_char)
}

/// `readPI`: `None` for its error object.
fn read_pi(data: &[u16], start: usize) -> Option<usize> {
    let mut i = start;
    while i < data.len() {
        if unit_is(data, i, b'?') || unit_is(data, i, b' ') {
            let tag_name = &data[start..i];
            if i > 5 && tag_name == [u16::from(b'x'), u16::from(b'm'), u16::from(b'l')] {
                return None;
            } else if unit_is(data, i, b'?') && unit_is(data, i + 1, b'>') {
                i += 1;
                break;
            }
        }
        i += 1;
    }
    Some(i)
}

fn units_are(data: &[u16], from: usize, text: &str) -> bool {
    text.bytes()
        .enumerate()
        .all(|(offset, byte)| unit_is(data, from + offset, byte))
}

fn read_comment_and_cdata(data: &[u16], mut i: usize) -> usize {
    let len = data.len();
    if len > i + 5 && unit_is(data, i + 1, b'-') && unit_is(data, i + 2, b'-') {
        i += 3;
        while i < len {
            if units_are(data, i, "-->") {
                i += 2;
                break;
            }
            i += 1;
        }
    } else if len > i + 8 && units_are(data, i + 1, "DOCTYPE") {
        let mut angle_brackets = 1;
        i += 8;
        while i < len {
            if unit_is(data, i, b'<') {
                angle_brackets += 1;
            } else if unit_is(data, i, b'>') {
                angle_brackets -= 1;
                if angle_brackets == 0 {
                    break;
                }
            }
            i += 1;
        }
    } else if len > i + 9 && units_are(data, i + 1, "[CDATA[") {
        i += 8;
        while i < len {
            if units_are(data, i, "]]>") {
                i += 2;
                break;
            }
            i += 1;
        }
    }
    i
}

/// `readAttributeStr`: the text up to the first `>` outside quotes, where it
/// stopped, and whether a `>` stopped it. `None` for an open quote.
fn read_attribute_str(data: &[u16], start: usize) -> Option<(String, usize, bool)> {
    let mut i = start;
    let mut quote: Option<u16> = None;
    let mut tag_closed = false;
    while i < data.len() {
        let unit = data[i];
        if unit == u16::from(b'"') || unit == u16::from(b'\'') {
            match quote {
                None => quote = Some(unit),
                Some(open) if open != unit => {}
                Some(_) => quote = None,
            }
        } else if unit == u16::from(b'>') && quote.is_none() {
            tag_closed = true;
            break;
        }
        i += 1;
    }
    if quote.is_some() {
        return None;
    }
    Some((String::from_utf16_lossy(&data[start..i]), i, tag_closed))
}

/// A quoted value of more than about a million characters passes the bound
/// of one search.
fn attribute_string_is_valid(attributes: &str) -> Result<bool, RegexLimit> {
    let mut names: HashSet<&str> = HashSet::new();
    for found in try_js_regex!(r#"(\s*)([^\s=]+)(\s*=)?(\s*(['"])(([\s\S])*?)\5)?"#, "g")
        .try_find_iter(attributes)
    {
        let found = found?;
        if found.get(1).is_none_or(str::is_empty) {
            return Ok(false);
        }
        if found.get(3).is_some() && found.get(4).is_none() {
            return Ok(false);
        }
        if found.get(3).is_none() {
            return Ok(false);
        }
        let name = found.get(2).unwrap_or_default();
        if !is_name(name) {
            return Ok(false);
        }
        // `attrNames[name] = 1` on a plain object: `__proto__` sets the
        // prototype, never an own key, so it is never seen as repeated
        if name != "__proto__" && !names.insert(name) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `validateAmpersand`: `None` for its -1.
fn validate_ampersand(data: &[u16], at: usize) -> Option<usize> {
    let mut i = at + 1;
    if unit_is(data, i, b';') {
        return None;
    }
    if unit_is(data, i, b'#') {
        i += 1;
        let hex = unit_is(data, i, b'x');
        if hex {
            i += 1;
        }
        while i < data.len() {
            if unit_is(data, i, b';') {
                return Some(i);
            }
            let digit = u8::try_from(data[i]).is_ok_and(|byte| {
                if hex {
                    byte.is_ascii_hexdigit()
                } else {
                    byte.is_ascii_digit()
                }
            });
            if !digit {
                break;
            }
            i += 1;
        }
        return None;
    }
    let mut count = 0;
    while i < data.len() {
        let word =
            u8::try_from(data[i]).is_ok_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        if word && count < 20 {
            i += 1;
            count += 1;
            continue;
        }
        if unit_is(data, i, b';') {
            break;
        }
        return None;
    }
    Some(i)
}

/// `XMLValidator.validate(xml) === true` with the default options.
fn xml_validates(xml: &str) -> Result<bool, RegexLimit> {
    let mut units: Vec<u16> = xml.encode_utf16().collect();
    if units.first() == Some(&0xFEFF) {
        units.remove(0);
    }
    let data = units.as_slice();
    let mut tags: Vec<String> = Vec::new();
    let mut tag_found = false;
    let mut reached_root = false;
    let mut i = 0;
    while i < data.len() {
        if unit_is(data, i, b'<') && unit_is(data, i + 1, b'?') {
            match read_pi(data, i + 2) {
                Some(next) => i = next,
                None => return Ok(false),
            }
        } else if unit_is(data, i, b'<') {
            i += 1;
            if unit_is(data, i, b'!') {
                i = read_comment_and_cdata(data, i) + 1;
                continue;
            }
            let closing = unit_is(data, i, b'/');
            if closing {
                i += 1;
            }
            let name_start = i;
            while i < data.len() && !matches!(data[i], 0x3E | 0x20 | 0x09 | 0x0A | 0x0D) {
                i += 1;
            }
            let raw_name = String::from_utf16_lossy(&data[name_start..i]);
            let mut tag_name = trim(&raw_name).to_owned();
            if tag_name.ends_with('/') {
                tag_name.pop();
                i -= 1;
            }
            if !is_name(&tag_name) {
                return Ok(false);
            }
            let Some((mut attribute_text, next, tag_closed)) = read_attribute_str(data, i) else {
                return Ok(false);
            };
            i = next;
            if attribute_text.ends_with('/') {
                attribute_text.pop();
                if !attribute_string_is_valid(&attribute_text)? {
                    return Ok(false);
                }
                tag_found = true;
            } else if closing {
                if !tag_closed || !trim(&attribute_text).is_empty() {
                    return Ok(false);
                }
                let Some(open) = tags.pop() else {
                    return Ok(false);
                };
                if tag_name != open {
                    return Ok(false);
                }
                if tags.is_empty() {
                    reached_root = true;
                }
            } else {
                if !attribute_string_is_valid(&attribute_text)? || reached_root {
                    return Ok(false);
                }
                tags.push(tag_name);
                tag_found = true;
            }

            i += 1;
            while i < data.len() {
                if unit_is(data, i, b'<') {
                    if unit_is(data, i + 1, b'!') {
                        i = read_comment_and_cdata(data, i + 1) + 1;
                        continue;
                    } else if unit_is(data, i + 1, b'?') {
                        match read_pi(data, i + 1) {
                            Some(next) => i = next,
                            None => return Ok(false),
                        }
                    } else {
                        break;
                    }
                } else if unit_is(data, i, b'&') {
                    match validate_ampersand(data, i) {
                        Some(next) => i = next,
                        None => return Ok(false),
                    }
                } else if reached_root && !is_white_space(data[i]) {
                    return Ok(false);
                }
                i += 1;
            }
            if unit_is(data, i, b'<') {
                i -= 1;
            }
        } else if !is_white_space(data[i]) {
            return Ok(false);
        }
        i += 1;
    }
    Ok(tag_found && tags.is_empty())
}
