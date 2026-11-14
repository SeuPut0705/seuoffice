//! The data shapes of `xml-positions.ts` (`XmlAttribute`, `XmlElement`,
//! `XmlText`, `XmlOther`, `XmlNode`, `XmlDocument`, `XmlParseResult`), the one
//! non-parser function the editors need from it (`textRawOffset`, with
//! `resolveReference`), and the two steps the parser side stays to the host
//! until it is ported.
//!
//! The TypeScript tree points from a child to its parent. Here the elements of
//! a document live in one list, `XmlDocument::elements`, and a reference to an
//! element is its index there (`ElementId`): `XmlElement::parent` and
//! `XmlNode::Element` hold one. Two elements are the same object in TypeScript
//! exactly when they have the same index here. Every other field has the
//! name and the meaning of the interface, in snake case; `type` is the variant
//! of `XmlNode`. Offsets are UTF-16 offsets into `XmlDocument::source`.
//!
//! Text can hold a lone surrogate, so a text node's value and the source are
//! units; names and attribute values come from a document that parsed, which
//! has none, and are `String`s.

use jscompat::{Radix, number_to_string, parse_int};
use serde_json::Value;

use crate::utf16::{index_of, lossy, units};

/// What a step of the TypeScript threw: its error name and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thrown {
    pub name: String,
    pub message: String,
}

impl Thrown {
    pub fn new(name: &str, message: impl Into<String>) -> Self {
        Self {
            name: name.to_owned(),
            message: message.into(),
        }
    }

    /// What V8 throws when the recursion of a function uses the whole stack.
    pub fn stack_overflow() -> Self {
        Self::new("RangeError", "Maximum call stack size exceeded")
    }
}

/// How deep the recursive functions of this crate go before they answer
/// [`Thrown::stack_overflow`]. V8 gives up between 3,000 and 6,000 levels,
/// depending on the function and on how warm it is; the limit here is below
/// that so that no input of a real document reaches it, and a recursion of this
/// crate is kept to a frame small enough for this many levels to fit half the
/// 1 MiB stack of a wasm32 instance. A nesting between the two limits is
/// answered by the TypeScript and refused here. `marks.rs` keeps its own,
/// lower one.
pub const MAX_DEPTH: usize = 1000;

/// One level deeper, or the stack overflow of the TypeScript.
pub fn deeper(depth: usize) -> Result<usize, Thrown> {
    if depth >= MAX_DEPTH {
        Err(Thrown::stack_overflow())
    } else {
        Ok(depth + 1)
    }
}

/// Index of an element in `XmlDocument::elements`.
pub type ElementId = usize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XmlAttribute {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct XmlElement {
    /// Qualified name as written (`p`, `epub:switch`).
    pub name: String,
    /// Part after the prefix (`switch` for `epub:switch`).
    pub local: String,
    /// Decoded attribute values, in source order.
    pub attributes: Vec<XmlAttribute>,
    /// Offset of `<` of the start tag.
    pub start: usize,
    /// Offset just after the start tag's `>` (equals `end` for a self-closing tag).
    pub start_tag_end: usize,
    /// Offset of `</` of the end tag (equals `end` for a self-closing tag).
    pub end_tag_start: usize,
    /// Offset just after the end tag (or the self-closing tag).
    pub end: usize,
    pub self_closing: bool,
    pub children: Vec<XmlNode>,
    pub parent: Option<ElementId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XmlText {
    /// Raw source range; for CDATA it includes `<![CDATA[` and `]]>`.
    pub start: usize,
    pub end: usize,
    /// Decoded character data.
    pub value: Vec<u16>,
    pub cdata: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OtherKind {
    Comment,
    Pi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct XmlOther {
    pub kind: OtherKind,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum XmlNode {
    Element(ElementId),
    Text(XmlText),
    Other(XmlOther),
}

#[derive(Debug, Clone, PartialEq)]
pub struct XmlDocument {
    pub source: Vec<u16>,
    pub elements: Vec<XmlElement>,
    pub root: ElementId,
    /// HTML named entities are resolved only when the chapter declares a doctype.
    pub has_doctype: bool,
}

impl XmlDocument {
    pub fn element(&self, id: ElementId) -> &XmlElement {
        &self.elements[id]
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum XmlParseResult {
    Ok(XmlDocument),
    Err { error: String, offset: usize },
}

/// What `xml-positions.ts` does with a text, left to its parser side: the
/// position-tracking parse (saxes) and the HTML entity table (parse5).
pub trait XmlHost {
    /// `parseXml(source)`.
    fn parse_xml(&self, source: &[u16]) -> Result<XmlParseResult, Thrown>;
    /// `resolveHtmlEntity(name)`.
    fn resolve_html_entity(&self, name: &str) -> Result<Option<String>, Thrown>;
}

/// `String.fromCodePoint(code)`: the units, or the `RangeError` for a number
/// that is not a code point.
pub fn from_code_point(code: f64) -> Result<Vec<u16>, Thrown> {
    if code.fract() != 0.0 || !(0.0..=1_114_111.0).contains(&code) || code.is_nan() {
        return Err(Thrown::new(
            "RangeError",
            format!("Invalid code point {}", number_to_string(code)),
        ));
    }
    let code = code as u32;
    Ok(match char::from_u32(code) {
        Some(c) => c.encode_utf16(&mut [0; 2]).to_vec(),
        None => vec![code as u16],
    })
}

/// `resolveReference(ref, withHtml)` of `xml-positions.ts`.
pub fn resolve_reference(
    host: &dyn XmlHost,
    reference: &[u16],
    with_html: bool,
) -> Result<Vec<u16>, Thrown> {
    let text = lossy(reference);
    // a reference read from the source of a document that parsed has no lone surrogate
    if text.starts_with("#x") || text.starts_with("#X") {
        return from_code_point(parse_int(&text[2..], Radix::Sixteen));
    }
    if let Some(digits) = text.strip_prefix('#') {
        return from_code_point(parse_int(digits, Radix::Ten));
    }
    let xml = match text.as_str() {
        "amp" => Some("&"),
        "lt" => Some("<"),
        "gt" => Some(">"),
        "quot" => Some("\""),
        "apos" => Some("'"),
        _ => None,
    };
    if let Some(value) = xml {
        return Ok(units(value));
    }
    let html = if with_html {
        host.resolve_html_entity(&text)?
    } else {
        None
    };
    Ok(units(&html.unwrap_or_else(|| format!("&{text};"))))
}

/// `textRawOffset(doc, text, k)`: the source offset at which `k` decoded
/// characters of `text` lie before it. An offset that would fall inside one
/// reference's expansion or between the two halves of a surrogate pair moves
/// forward past it.
pub fn text_raw_offset(
    host: &dyn XmlHost,
    doc: &XmlDocument,
    text: &XmlText,
    k: usize,
) -> Result<usize, Thrown> {
    let source = &doc.source;
    let mut i = if text.cdata {
        text.start + 9
    } else {
        text.start
    };
    let end = if text.cdata { text.end - 3 } else { text.end };
    let mut count = 0usize;
    while i < end && count < k {
        let ch = source.get(i).copied().unwrap_or(0);
        if ch == 0x0D {
            i += if source.get(i + 1) == Some(&0x0A) {
                2
            } else {
                1
            };
            count += 1;
        } else if ch == 0x26 && !text.cdata {
            let semi = index_of(source, &[0x3B], i);
            // `source.slice(i + 1, semi)`, where -1 counts from the end
            let to = semi.unwrap_or(source.len().saturating_sub(1));
            let reference = source.get(i + 1..to).unwrap_or(&[]);
            count += resolve_reference(host, reference, doc.has_doctype)?.len();
            i = semi.map_or(0, |at| at + 1);
        } else if (0xD800..=0xDBFF).contains(&ch) {
            i += 2;
            count += 2;
        } else {
            i += 1;
            count += 1;
        }
    }
    Ok(i)
}

/// The document the host's `parseXmlPositions` step answers, over `source`:
/// `{ ok: false, error, offset }`, or `{ ok: true, hasDoctype, root, elements }`
/// with the elements flat, in document order, each
/// `{ name, local, attributes: [{ name, value }], start, startTagEnd,
/// endTagStart, end, selfClosing, parent, children }`, a child being
/// `{ element: id }`, `{ type: "text", start, end, value: units, cdata }` or
/// `{ type: "comment" | "pi", start, end }`.
pub fn parse_result_from_wire(source: Vec<u16>, value: &Value) -> Result<XmlParseResult, String> {
    let get = |value: &'_ Value, key: &str| -> Result<Value, String> {
        value
            .get(key)
            .cloned()
            .ok_or_else(|| format!("the parse has no {key}"))
    };
    let number = |value: &Value, key: &str| -> Result<usize, String> {
        value
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| format!("{key} is not an offset"))
    };
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        return Ok(XmlParseResult::Err {
            error: get(value, "error")?
                .as_str()
                .ok_or("error is not a string")?
                .to_owned(),
            offset: number(value, "offset")?,
        });
    }
    let length = source.len();
    let listed = get(value, "elements")?;
    let listed = listed.as_array().ok_or("elements is not a list")?;
    let within = |offset: usize| -> Result<usize, String> {
        if offset <= length {
            Ok(offset)
        } else {
            Err(format!("offset {offset} is past the source ({length})"))
        }
    };
    let mut elements = Vec::with_capacity(listed.len());
    for (id, item) in listed.iter().enumerate() {
        let text_of = |key: &str| -> Result<String, String> {
            item.get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| format!("{key} is not a string"))
        };
        let mut attributes = Vec::new();
        for attribute in item
            .get("attributes")
            .and_then(Value::as_array)
            .ok_or("attributes is not a list")?
        {
            attributes.push(XmlAttribute {
                name: attribute
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or("attribute name is not a string")?
                    .to_owned(),
                value: attribute
                    .get("value")
                    .and_then(Value::as_str)
                    .ok_or("attribute value is not a string")?
                    .to_owned(),
            });
        }
        let start = within(number(item, "start")?)?;
        let start_tag_end = within(number(item, "startTagEnd")?)?;
        let end_tag_start = within(number(item, "endTagStart")?)?;
        let end = within(number(item, "end")?)?;
        let self_closing = item
            .get("selfClosing")
            .and_then(Value::as_bool)
            .ok_or("selfClosing is not a boolean")?;
        if !(start <= start_tag_end && start_tag_end <= end_tag_start && end_tag_start <= end)
            || (self_closing && end - start < 2)
        {
            return Err(format!("element {id} has inconsistent offsets"));
        }
        let mut children = Vec::new();
        for child in item
            .get("children")
            .and_then(Value::as_array)
            .ok_or("children is not a list")?
        {
            if let Some(element) = child.get("element").and_then(Value::as_u64) {
                let element = usize::try_from(element).map_err(|_| "bad element id")?;
                if element <= id || element >= listed.len() {
                    return Err(format!("element {id} lists the child {element}"));
                }
                children.push(XmlNode::Element(element));
                continue;
            }
            let kind = child
                .get("type")
                .and_then(Value::as_str)
                .ok_or("a child has no type")?;
            let (from, to) = (
                within(number(child, "start")?)?,
                within(number(child, "end")?)?,
            );
            children.push(match kind {
                "text" => XmlNode::Text(XmlText {
                    start: from,
                    end: to,
                    value: crate::utf16::from_wire(&get(child, "value")?)
                        .ok_or("text value is not a list of units")?,
                    cdata: child
                        .get("cdata")
                        .and_then(Value::as_bool)
                        .ok_or("cdata is not a boolean")?,
                }),
                "comment" | "pi" => XmlNode::Other(XmlOther {
                    kind: if kind == "pi" {
                        OtherKind::Pi
                    } else {
                        OtherKind::Comment
                    },
                    start: from,
                    end: to,
                }),
                other => return Err(format!("a child has the type {other}")),
            });
        }
        let parent = match item.get("parent") {
            Some(Value::Null) | None => None,
            Some(parent) => Some(
                parent
                    .as_u64()
                    .and_then(|p| usize::try_from(p).ok())
                    .filter(|&p| p < id)
                    .ok_or("parent is not an earlier element")?,
            ),
        };
        elements.push(XmlElement {
            name: text_of("name")?,
            local: text_of("local")?,
            attributes,
            start,
            start_tag_end,
            end_tag_start,
            end,
            self_closing,
            children,
            parent,
        });
    }
    let root = number(value, "root")?;
    if root >= elements.len() {
        return Err("root is not an element".to_owned());
    }
    Ok(XmlParseResult::Ok(XmlDocument {
        source,
        elements,
        root,
        has_doctype: get(value, "hasDoctype")?
            .as_bool()
            .ok_or("hasDoctype is not a boolean")?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoHost;
    impl XmlHost for NoHost {
        fn parse_xml(&self, _: &[u16]) -> Result<XmlParseResult, Thrown> {
            unreachable!("not used")
        }
        fn resolve_html_entity(&self, name: &str) -> Result<Option<String>, Thrown> {
            Ok(match name {
                "nbsp" => Some("\u{a0}".to_owned()),
                "eacute" => Some("é".to_owned()),
                _ => None,
            })
        }
    }

    fn text_of(source: &str, cdata: bool) -> (XmlDocument, XmlText) {
        let source = units(source);
        let text = XmlText {
            start: 0,
            end: source.len(),
            value: Vec::new(),
            cdata,
        };
        let doc = XmlDocument {
            source,
            elements: Vec::new(),
            root: 0,
            has_doctype: true,
        };
        (doc, text)
    }

    #[test]
    fn code_points_outside_the_range_throw() {
        assert_eq!(from_code_point(65.0).unwrap(), vec![65]);
        assert_eq!(
            from_code_point(f64::from(0x1F600)).unwrap(),
            vec![0xD83D, 0xDE00]
        );
        assert_eq!(from_code_point(f64::from(0xD800)).unwrap(), vec![0xD800]);
        assert_eq!(
            from_code_point(f64::NAN).unwrap_err().message,
            "Invalid code point NaN"
        );
        assert_eq!(
            from_code_point(1_114_112.0).unwrap_err().message,
            "Invalid code point 1114112"
        );
    }

    #[test]
    fn raw_offset_skips_a_reference_and_a_pair_whole() {
        // what `textRawOffset` answers over this source in a document with a doctype
        let (doc, text) = text_of("a&amp;b\r\nc&#x1F600;d&nbsp;e", false);
        let at = |k| text_raw_offset(&NoHost, &doc, &text, k).unwrap();
        let answers: Vec<usize> = (0..13).map(at).collect();
        assert_eq!(answers, [0, 1, 6, 7, 9, 10, 19, 19, 20, 26, 27, 27, 27]);
    }

    #[test]
    fn raw_offset_in_cdata_reads_ampersand_as_text() {
        let (doc, text) = text_of("<![CDATA[a&b\r\n]]>", true);
        let at = |k| text_raw_offset(&NoHost, &doc, &text, k).unwrap();
        let answers: Vec<usize> = (0..6).map(at).collect();
        assert_eq!(answers, [9, 10, 11, 12, 14, 14]);
    }
}
