//! `translate/output-markup.ts`: small source-level helpers for building a
//! translated book: reading and rewriting one start tag as written, removing
//! ids from a markup fragment, and walking the position-tracking tree.
//! Everything works on the source text, so what is not rewritten keeps its
//! exact characters.
//!
//! Markup is a JavaScript string that can hold a lone surrogate (a model wrote
//! it), so it is units, and the sticky patterns of the TypeScript are read by
//! hand: `jscompat::JsRegex` searches a `&str`.

use std::collections::HashSet;

use crate::ranges::RangeReplacement;
use crate::utf16::{index_of, is_ascii_blank, is_space, last_index_of_unit, units};
use crate::xml_positions_types::{ElementId, Thrown, XmlDocument, XmlNode, deeper};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartTagAttribute {
    pub name: Vec<u16>,
    /// the attribute as written, with the whitespace before it
    pub raw: Vec<u16>,
    /// the value as written between the quotes (references not resolved)
    pub value: Vec<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartTag {
    pub name: Vec<u16>,
    pub attributes: Vec<StartTagAttribute>,
    /// what follows the last attribute: optional whitespace, then `>` or `/>`
    pub tail: Vec<u16>,
}

const LT: u16 = 0x3C;
const GT: u16 = 0x3E;
const SLASH: u16 = 0x2F;
const EQUALS: u16 = 0x3D;
const DQUOTE: u16 = 0x22;
const SQUOTE: u16 = 0x27;

fn skip_spaces(text: &[u16], mut at: usize) -> usize {
    while text.get(at).is_some_and(|&u| is_space(u)) {
        at += 1;
    }
    at
}

/// `ATTRIBUTE`, sticky at `at`: `/\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y`.
/// The end of the match, the name and the value.
fn match_attribute(markup: &[u16], at: usize) -> Option<(usize, Vec<u16>, Vec<u16>)> {
    let name_from = skip_spaces(markup, at);
    if name_from == at {
        return None;
    }
    let mut name_to = name_from;
    while markup
        .get(name_to)
        .is_some_and(|&u| !is_space(u) && u != EQUALS && u != SLASH && u != GT)
    {
        name_to += 1;
    }
    if name_to == name_from {
        return None;
    }
    let equals = skip_spaces(markup, name_to);
    if markup.get(equals) != Some(&EQUALS) {
        return None;
    }
    let quote_at = skip_spaces(markup, equals + 1);
    let quote = *markup.get(quote_at)?;
    if quote != DQUOTE && quote != SQUOTE {
        return None;
    }
    let close = markup[quote_at + 1..].iter().position(|&u| u == quote)? + quote_at + 1;
    Some((
        close + 1,
        markup[name_from..name_to].to_vec(),
        markup[quote_at + 1..close].to_vec(),
    ))
}

/// `readStartTag`: reads the start tag that begins at `at` (a `<` followed by
/// a name). Attribute values are always quoted in XML, so the attributes are
/// read in sequence and a `>` inside a value is never taken for the tag's end.
pub fn read_start_tag(markup: &[u16], at: usize) -> Option<(StartTag, usize)> {
    // TAG_NAME: /<([^\s/>]+)/y
    if markup.get(at) != Some(&LT) {
        return None;
    }
    let mut i = at + 1;
    while markup
        .get(i)
        .is_some_and(|&u| !is_space(u) && u != SLASH && u != GT)
    {
        i += 1;
    }
    if i == at + 1 {
        return None;
    }
    let name = markup[at + 1..i].to_vec();
    let mut attributes = Vec::new();
    while let Some((end, attribute_name, value)) = match_attribute(markup, i) {
        attributes.push(StartTagAttribute {
            name: attribute_name,
            raw: markup[i..end].to_vec(),
            value,
        });
        i = end;
    }
    // TAG_CLOSE: /\s*\/?>/y
    let mut j = skip_spaces(markup, i);
    if markup.get(j) == Some(&SLASH) {
        j += 1;
    }
    if markup.get(j) != Some(&GT) {
        return None;
    }
    Some((
        StartTag {
            name,
            attributes,
            tail: markup[i..=j].to_vec(),
        },
        j + 1,
    ))
}

/// `writeStartTag`
pub fn write_start_tag(tag: &StartTag) -> Vec<u16> {
    let mut out = vec![LT];
    out.extend_from_slice(&tag.name);
    for attribute in &tag.attributes {
        out.extend_from_slice(&attribute.raw);
    }
    out.extend_from_slice(&tag.tail);
    out
}

/// `escapeAttribute`: `&`, `<` and `"` escaped for a double-quoted attribute value.
pub fn escape_attribute(value: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(value.len());
    for &unit in value {
        match unit {
            0x26 => out.extend(units("&amp;")),
            LT => out.extend(units("&lt;")),
            DQUOTE => out.extend(units("&quot;")),
            _ => out.push(unit),
        }
    }
    out
}

/// `tagAttribute`
pub fn tag_attribute<'a>(tag: &'a StartTag, name: &[u16]) -> Option<&'a [u16]> {
    tag.attributes
        .iter()
        .find(|a| a.name == name)
        .map(|a| a.value.as_slice())
}

/// `setTagAttribute`: sets an attribute to an already escaped value: in place
/// when the tag has it (keeping the whitespace before it), else added after the last one.
pub fn set_tag_attribute(tag: &mut StartTag, name: &[u16], escaped: &[u16]) -> Result<(), Thrown> {
    let written = |lead: &[u16]| {
        let mut raw = lead.to_vec();
        raw.extend_from_slice(name);
        raw.extend(units("=\""));
        raw.extend_from_slice(escaped);
        raw.push(DQUOTE);
        raw
    };
    if let Some(existing) = tag.attributes.iter_mut().find(|a| a.name == name) {
        let lead_end = skip_spaces(&existing.raw, 0);
        if lead_end == 0 {
            // `/^\s+/.exec(existing.raw)![0]` of a null match
            return Err(Thrown::new(
                "TypeError",
                "Cannot read properties of null (reading '0')",
            ));
        }
        existing.raw = written(&existing.raw[..lead_end]);
        existing.value = escaped.to_vec();
        return Ok(());
    }
    tag.attributes.push(StartTagAttribute {
        name: name.to_vec(),
        raw: written(&[0x20]),
        value: escaped.to_vec(),
    });
    Ok(())
}

/// `removeTagAttributes`
pub fn remove_tag_attributes(tag: &mut StartTag, names: &HashSet<Vec<u16>>) {
    tag.attributes.retain(|a| !names.contains(&a.name));
}

/// `ID_ATTRIBUTES`
pub fn id_attributes() -> HashSet<Vec<u16>> {
    [units("id"), units("xml:id")].into_iter().collect()
}

fn skip_to(markup: &[u16], from: usize, terminator: &str) -> usize {
    let terminator = units(terminator);
    index_of(markup, &terminator, from).map_or(markup.len(), |at| at + terminator.len())
}

fn starts_with_at(markup: &[u16], at: usize, literal: &str) -> bool {
    let literal = units(literal);
    markup
        .get(at..at + literal.len())
        .is_some_and(|s| s == literal)
}

/// `removeIds`: the markup fragment with every `id` and `xml:id` attribute
/// removed from its start tags. Comments, CDATA sections, processing
/// instructions and end tags are copied as they are; text never holds a
/// literal `<`.
pub fn remove_ids(markup: &[u16]) -> Vec<u16> {
    let ids = id_attributes();
    let mut out = Vec::with_capacity(markup.len());
    let mut i = 0;
    while i < markup.len() {
        let Some(lt) = index_of(markup, &[LT], i) else {
            out.extend_from_slice(&markup[i..]);
            break;
        };
        out.extend_from_slice(&markup[i..lt]);
        let end = if starts_with_at(markup, lt, "<!--") {
            skip_to(markup, lt + 4, "-->")
        } else if starts_with_at(markup, lt, "<![CDATA[") {
            skip_to(markup, lt + 9, "]]>")
        } else if starts_with_at(markup, lt, "<?") {
            skip_to(markup, lt + 2, "?>")
        } else if starts_with_at(markup, lt, "</") || starts_with_at(markup, lt, "<!") {
            skip_to(markup, lt + 2, ">")
        } else {
            if let Some((mut tag, end)) = read_start_tag(markup, lt) {
                remove_tag_attributes(&mut tag, &ids);
                out.extend(write_start_tag(&tag));
                i = end;
                continue;
            }
            lt + 1
        };
        out.extend_from_slice(&markup[lt..end]);
        i = end;
    }
    out
}

// ---------------------------------------------------------------------------
// The position-tracking tree

/// `childElements`
pub fn child_elements(doc: &XmlDocument, el: ElementId) -> Vec<ElementId> {
    doc.element(el)
        .children
        .iter()
        .filter_map(|c| match c {
            XmlNode::Element(id) => Some(*id),
            _ => None,
        })
        .collect()
}

/// `walkElements`: depth-first, document order, including `el` itself.
pub fn walk_elements(doc: &XmlDocument, el: ElementId) -> Result<Vec<ElementId>, Thrown> {
    fn walk(
        doc: &XmlDocument,
        el: ElementId,
        out: &mut Vec<ElementId>,
        depth: usize,
    ) -> Result<(), Thrown> {
        let depth = deeper(depth)?;
        out.push(el);
        for child in child_elements(doc, el) {
            walk(doc, child, out, depth)?;
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(doc, el, &mut out, 0)?;
    Ok(out)
}

/// `attributeOf`
pub fn attribute_of<'a>(doc: &'a XmlDocument, el: ElementId, name: &str) -> Option<&'a str> {
    doc.element(el)
        .attributes
        .iter()
        .find(|a| a.name == name)
        .map(|a| a.value.as_str())
}

/// `localIs`: `el.local.toLowerCase() === local`.
pub fn local_is(doc: &XmlDocument, el: ElementId, local: &str) -> bool {
    doc.element(el).local.to_lowercase() == local
}

/// `prefixOf`: `dc:` for `dc:title`, '' for an unprefixed name.
pub fn prefix_of(name: &str) -> String {
    match name.find(':') {
        None => String::new(),
        Some(colon) => name[..=colon].to_owned(),
    }
}

/// `namespaceOf`: the namespace a prefix ('' for the default) is bound to at
/// `el`, or `None`.
pub fn namespace_of(doc: &XmlDocument, el: ElementId, prefix: &str) -> Option<String> {
    let name = if prefix.is_empty() {
        "xmlns".to_owned()
    } else {
        format!("xmlns:{prefix}")
    };
    let mut e = Some(el);
    while let Some(id) = e {
        if let Some(value) = attribute_of(doc, id, &name) {
            return if value.is_empty() {
                None
            } else {
                Some(value.to_owned())
            };
        }
        e = doc.element(id).parent;
    }
    None
}

/// `elementText`: all descendant text, leaving out elements named in `skip`
/// (by lower-case local name).
pub fn element_text(
    doc: &XmlDocument,
    el: ElementId,
    skip: &HashSet<String>,
    depth: usize,
) -> Result<Vec<u16>, Thrown> {
    let depth = deeper(depth)?;
    let mut out = Vec::new();
    for child in &doc.element(el).children {
        match child {
            XmlNode::Text(text) => out.extend_from_slice(&text.value),
            XmlNode::Element(id) if !skip.contains(&doc.element(*id).local.to_lowercase()) => {
                out.extend(element_text(doc, *id, skip, depth)?);
            }
            _ => {}
        }
    }
    Ok(out)
}

/// `whitespaceStart`: offset of the start of the whitespace run that ends at `offset`.
pub fn whitespace_start(source: &[u16], offset: usize) -> usize {
    let mut i = offset;
    // past the end `source[i - 1]` is undefined, which `/[ \t\r\n]/.test` reads as "undefined"
    while i > 0 && source.get(i - 1).is_some_and(|&u| is_ascii_blank(u)) {
        i -= 1;
    }
    i
}

/// `startTagReplacement`: the start tag of `el` rewritten by `change`, as one replacement.
pub fn start_tag_replacement(
    doc: &XmlDocument,
    el: ElementId,
    change: impl FnOnce(&mut StartTag) -> Result<(), Thrown>,
) -> Result<Option<RangeReplacement>, Thrown> {
    let element = doc.element(el);
    let end = if element.self_closing {
        element.end
    } else {
        element.start_tag_end
    };
    let Some((mut tag, _)) = read_start_tag(&doc.source[element.start..end], 0) else {
        return Ok(None);
    };
    change(&mut tag)?;
    Ok(Some(RangeReplacement {
        start: element.start as f64,
        end: end as f64,
        text: write_start_tag(&tag),
    }))
}

/// `elementTextReplacement`: the replacements that make `el`'s content
/// `escaped`: the content range, or the whole element when it is self-closing.
pub fn element_text_replacement(
    doc: &XmlDocument,
    el: ElementId,
    escaped: &[u16],
) -> Result<RangeReplacement, Thrown> {
    let element = doc.element(el);
    if !element.self_closing {
        return Ok(RangeReplacement {
            start: element.start_tag_end as f64,
            end: element.end_tag_start as f64,
            text: escaped.to_vec(),
        });
    }
    let Some((mut tag, _)) = read_start_tag(&doc.source[element.start..element.end], 0) else {
        return Err(Thrown::new(
            "TypeError",
            "Cannot read properties of null (reading 'tag')",
        ));
    };
    // `tail.replace(/\s*\/>$/, '>')`
    if tag.tail.ends_with(&[SLASH, GT]) {
        let blank = tag.tail[..tag.tail.len() - 2].iter().all(|&u| is_space(u));
        if blank {
            tag.tail = vec![GT];
        }
    }
    let mut text = write_start_tag(&tag);
    text.extend_from_slice(escaped);
    text.extend(units(&format!("</{}>", element.name)));
    Ok(RangeReplacement {
        start: element.start as f64,
        end: element.end as f64,
        text,
    })
}

/// `insertionAfter`: inserts `markup` right after `el`: on a line of its own
/// with `el`'s indentation and line end when `el` starts its line, else
/// directly after it.
pub fn insertion_after(doc: &XmlDocument, el: ElementId, markup: &[u16]) -> RangeReplacement {
    let source = &doc.source;
    let element = doc.element(el);
    let line_start =
        last_index_of_unit(source, 0x0A, element.start as isize - 1).map_or(0, |at| at + 1);
    let indent = &source[line_start..element.start];
    if line_start == 0 || indent.iter().any(|&u| !is_space(u)) {
        return RangeReplacement {
            start: element.end as f64,
            end: element.end as f64,
            text: markup.to_vec(),
        };
    }
    let before = line_start.checked_sub(2).and_then(|at| source.get(at));
    let mut text = if before == Some(&0x0D) {
        vec![0x0D, 0x0A]
    } else {
        vec![0x0A]
    };
    text.extend_from_slice(indent);
    text.extend_from_slice(markup);
    RangeReplacement {
        start: element.end as f64,
        end: element.end as f64,
        text,
    }
}
