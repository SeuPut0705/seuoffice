//! The parser side of `xml-positions.ts`: the position-tracking reader over
//! saxes (`parseXml`, `checkWellFormed`) and the decoding of character data
//! (`decodeCharacterData`, `resolveHtmlEntity`). The data shapes and
//! `textRawOffset` are in `xml_positions_types.rs`.
//!
//! saxes reports `parser.position` as the offset of the next unread UTF-16
//! code unit of the text it was given, so every position is an offset into the
//! units of the source. Every markup item is reported when its closing `>` has
//! been read; its start is the first `<` after the previous item, because
//! character data never contains a literal `<`. Text nodes are the gaps between
//! markup items, decoded here.
//!
//! The HTML named entities of a chapter with a doctype are resolved by the
//! host's parse5: `resolveHtmlEntity` keeps the cache of the TypeScript and
//! asks the step `epub.parseFragmentText` for the one thing parse5 computes
//! there.

use std::cell::RefCell;
use std::collections::HashMap;

use saxes::{Error as SaxError, Handler, HandlerResult, Options, Parser, Str, Tag};
use serde_json::{Value, json};

use crate::utf16::{index_of, is_space, lossy, to_wire, units};
use crate::xml::host_thrown;
use crate::xml_positions_types::{
    ElementId, OtherKind, Thrown, XmlAttribute, XmlDocument, XmlElement, XmlHost, XmlNode,
    XmlOther, XmlParseResult, XmlText, resolve_reference,
};

thread_local! {
    /// `htmlEntityCache`, which holds an answer for the life of the process.
    static HTML_ENTITY_CACHE: RefCell<HashMap<Vec<u16>, Option<String>>> =
        RefCell::new(HashMap::new());
}

/// `/^[A-Za-z][A-Za-z0-9]*$/`
fn is_entity_name(name: &[u16]) -> bool {
    let ascii = |unit: u16| u8::try_from(unit).ok();
    match name.split_first() {
        Some((first, rest)) => {
            ascii(*first).is_some_and(|b| b.is_ascii_alphabetic())
                && rest
                    .iter()
                    .all(|&unit| ascii(unit).is_some_and(|b| b.is_ascii_alphanumeric()))
        }
        None => false,
    }
}

/// `resolveHtmlEntity`: an HTML named entity (`nbsp`, `eacute`, ...) through
/// parse5's tokenizer, `None` where there is no such entity.
pub fn resolve_html_entity(name: &[u16]) -> Result<Option<String>, Thrown> {
    if let Some(known) = HTML_ENTITY_CACHE.with(|cache| cache.borrow().get(name).cloned()) {
        return Ok(known);
    }
    let mut value = None;
    if is_entity_name(name) {
        let name_text = lossy(name);
        let reference = format!("&{name_text};");
        let decoded = seu_host::call("epub.parseFragmentText", &json!({ "html": reference }))
            .map_err(host_thrown)?;
        // a legacy prefix match (`&notin` read as `&not` + `in;`) leaves the `;` behind
        if let Some(decoded) = decoded.as_str()
            && decoded != reference
            && (!decoded.ends_with(';') || name_text == "semi")
        {
            value = Some(decoded.to_owned());
        }
    }
    HTML_ENTITY_CACHE.with(|cache| cache.borrow_mut().insert(name.to_vec(), value.clone()));
    Ok(value)
}

/// What a parse of `xml-positions.ts` asks of the host: the real parser, and
/// the entity step.
pub struct PositionsHost;

impl XmlHost for PositionsHost {
    fn parse_xml(&self, source: &[u16]) -> Result<XmlParseResult, Thrown> {
        Ok(parse_xml(source))
    }

    fn resolve_html_entity(&self, name: &str) -> Result<Option<String>, Thrown> {
        resolve_html_entity(&units(name))
    }
}

fn normalize_newlines(raw: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == 0x0D {
            out.push(0x0A);
            if raw.get(i + 1) == Some(&0x0A) {
                i += 1;
            }
        } else {
            out.push(raw[i]);
        }
        i += 1;
    }
    out
}

/// A unit `[^\s&;<]` does not match.
fn ends_reference(unit: u16) -> bool {
    is_space(unit) || matches!(unit, 0x26 | 0x3B | 0x3C)
}

/// `decodeCharacterData`: line ends become `\n`, references are resolved. The
/// three alternatives of `REFERENCE` all read one run of `[^\s&;<]` after the
/// `&` and a `;`, so a reference is that run.
pub fn decode_character_data(raw: &[u16], with_html: bool) -> Result<Vec<u16>, Thrown> {
    let text = normalize_newlines(raw);
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text[i] == 0x26 {
            let mut end = i + 1;
            while end < text.len() && !ends_reference(text[end]) {
                end += 1;
            }
            if end > i + 1 && text.get(end) == Some(&0x3B) {
                out.extend(resolve_reference(
                    &PositionsHost,
                    &text[i + 1..end],
                    with_html,
                )?);
                i = end + 1;
                continue;
            }
        }
        out.push(text[i]);
        i += 1;
    }
    Ok(out)
}

/// `localName`
fn local_name(name: &str) -> &str {
    name.find(':').map_or(name, |colon| &name[colon + 1..])
}

fn sax_error(error: Thrown) -> SaxError {
    SaxError {
        name: match error.name.as_str() {
            "RangeError" => "RangeError",
            "TypeError" => "TypeError",
            _ => "Error",
        },
        message: units(&error.message),
    }
}

/// How the end of a markup item is known.
#[derive(Clone, Copy)]
enum End {
    /// The parser's position.
    Position,
    /// A comment ends at `-->`: saxes reports it on its closing `--`.
    Comment,
}

struct Reader<'a> {
    source: &'a [u16],
    elements: Vec<XmlElement>,
    stack: Vec<ElementId>,
    root: Option<ElementId>,
    last_end: usize,
    /// Whether a start tag is self-closing is only known from its `/>`.
    pending_self_closing: Option<ElementId>,
    has_doctype: bool,
    error: Option<(String, usize)>,
}

impl Reader<'_> {
    fn markup_start(&self) -> usize {
        index_of(self.source, &[0x3C], self.last_end).unwrap_or(self.last_end)
    }

    fn add_text(&mut self, start: usize, end: usize) -> HandlerResult {
        let Some(&parent) = self.stack.last() else {
            return Ok(());
        };
        if end <= start {
            return Ok(());
        }
        let length = self.source.len();
        let raw = &self.source[start.min(length)..end.min(length)];
        let value = decode_character_data(raw, self.has_doctype).map_err(sax_error)?;
        self.elements[parent].children.push(XmlNode::Text(XmlText {
            start,
            end,
            value,
            cdata: false,
        }));
        Ok(())
    }

    /// Records a markup item that ended at the parser's position (or where
    /// `end` says).
    fn markup(&mut self, cx: &Parser, end: End) -> Result<(usize, usize), SaxError> {
        let start = self.markup_start();
        self.add_text(self.last_end, start)?;
        let end = match end {
            End::Position => cx.position() as usize,
            End::Comment => index_of(self.source, &units("-->"), start + 4).map_or(2, |at| at + 3),
        };
        self.last_end = end;
        Ok((start, end))
    }

    fn add_other(&mut self, kind: OtherKind, start: usize, end: usize) {
        if let Some(&parent) = self.stack.last() {
            self.elements[parent]
                .children
                .push(XmlNode::Other(XmlOther { kind, start, end }));
        }
    }
}

impl Handler for Reader<'_> {
    fn wants_error(&self) -> bool {
        true
    }

    fn entity(&mut self, name: &[u16]) -> Result<Option<Str>, SaxError> {
        if !self.has_doctype {
            return Ok(None);
        }
        Ok(resolve_html_entity(name)
            .map_err(sax_error)?
            .map(|value| units(&value)))
    }

    fn error(&mut self, cx: &mut Parser, error: &SaxError) -> HandlerResult {
        if self.error.is_none() {
            self.error = Some((error.message_lossy(), cx.position() as usize));
        }
        Ok(())
    }

    fn xmldecl(&mut self, cx: &mut Parser, _decl: &saxes::XmlDecl) -> HandlerResult {
        self.markup(cx, End::Position)?;
        Ok(())
    }

    fn doctype(&mut self, cx: &mut Parser, _doctype: &[u16]) -> HandlerResult {
        self.markup(cx, End::Position)?;
        self.has_doctype = true;
        Ok(())
    }

    fn processinginstruction(
        &mut self,
        cx: &mut Parser,
        _target: &[u16],
        _body: &[u16],
    ) -> HandlerResult {
        let (start, end) = self.markup(cx, End::Position)?;
        self.add_other(OtherKind::Pi, start, end);
        Ok(())
    }

    fn comment(&mut self, cx: &mut Parser, _comment: &[u16]) -> HandlerResult {
        let (start, end) = self.markup(cx, End::Comment)?;
        self.add_other(OtherKind::Comment, start, end);
        Ok(())
    }

    fn cdata(&mut self, cx: &mut Parser, _cdata: &[u16]) -> HandlerResult {
        let (start, end) = self.markup(cx, End::Position)?;
        if let Some(&parent) = self.stack.last() {
            let from = (start + 9).min(self.source.len());
            let to = end.saturating_sub(3).min(self.source.len());
            let value = normalize_newlines(&self.source[from..to.max(from)]);
            self.elements[parent].children.push(XmlNode::Text(XmlText {
                start,
                end,
                value,
                cdata: true,
            }));
        }
        Ok(())
    }

    fn opentag(&mut self, cx: &mut Parser, tag: &Tag) -> HandlerResult {
        let (start, end) = self.markup(cx, End::Position)?;
        let parent = self.stack.last().copied();
        let name = lossy(&tag.name);
        let id = self.elements.len();
        self.elements.push(XmlElement {
            local: local_name(&name).to_owned(),
            name,
            attributes: tag
                .attributes
                .iter()
                .map(|attribute| XmlAttribute {
                    name: lossy(&attribute.name),
                    value: lossy(&attribute.value),
                })
                .collect(),
            start,
            start_tag_end: end,
            end_tag_start: end,
            end,
            self_closing: tag.is_self_closing,
            children: Vec::new(),
            parent,
        });
        if let Some(parent) = parent {
            self.elements[parent].children.push(XmlNode::Element(id));
        } else if self.root.is_none() {
            self.root = Some(id);
        }
        self.stack.push(id);
        self.pending_self_closing = tag.is_self_closing.then_some(id);
        Ok(())
    }

    fn closetag(&mut self, cx: &mut Parser, _tag: &Tag) -> HandlerResult {
        let Some(&id) = self.stack.last() else {
            return Ok(());
        };
        if self.pending_self_closing == Some(id) {
            self.pending_self_closing = None;
            self.stack.pop();
            return Ok(());
        }
        // text before the end tag belongs to the closing element, so it is recorded before popping
        let (start, end) = self.markup(cx, End::Position)?;
        self.stack.pop();
        self.elements[id].end_tag_start = start;
        self.elements[id].end = end;
        Ok(())
    }
}

/// `parseXml(source)`: one XML document with exact UTF-16 source ranges for
/// every node. It never throws: what the parser or a step of the host throws
/// is the error of the result.
pub fn parse_xml(source: &[u16]) -> XmlParseResult {
    let mut reader = Reader {
        source,
        elements: Vec::new(),
        stack: Vec::new(),
        root: None,
        last_end: 0,
        pending_self_closing: None,
        has_doctype: false,
        error: None,
    };
    let options = Options {
        position: true,
        ..Options::default()
    };
    let mut parser = match Parser::new(options) {
        Ok(parser) => parser,
        Err(error) => {
            return XmlParseResult::Err {
                error: error.message_lossy(),
                offset: 0,
            };
        }
    };
    let ran = parser
        .write(&mut reader, source)
        .and_then(|()| parser.close(&mut reader));
    if let Err(error) = ran
        && reader.error.is_none()
    {
        reader.error = Some((error.message_lossy(), parser.position() as usize));
    }
    if let Some((error, offset)) = reader.error {
        return XmlParseResult::Err { error, offset };
    }
    let Some(root) = reader.root else {
        return XmlParseResult::Err {
            error: "document has no root element".to_owned(),
            offset: 0,
        };
    };
    XmlParseResult::Ok(XmlDocument {
        source: source.to_vec(),
        elements: reader.elements,
        root,
        has_doctype: reader.has_doctype,
    })
}

/// `checkWellFormed(source)`: `Err` holds `{ error, offset }`.
pub fn check_well_formed(source: &[u16]) -> Result<(), (String, usize)> {
    match parse_xml(source) {
        XmlParseResult::Ok(_) => Ok(()),
        XmlParseResult::Err { error, offset } => Err((error, offset)),
    }
}

/// The result of `parseXml(source)` as the gate writes it, flat so that no
/// nesting reaches JSON: `{ ok: false, error, offset }`, or `{ ok: true,
/// hasDoctype, root, elements }` with the elements in document order, each
/// naming its children by position (the shape `parse_result_from_wire` reads).
pub fn parse_result_to_wire(result: &XmlParseResult) -> Value {
    let document = match result {
        XmlParseResult::Err { error, offset } => {
            return json!({ "ok": false, "error": error, "offset": offset });
        }
        XmlParseResult::Ok(document) => document,
    };
    let elements: Vec<Value> = document
        .elements
        .iter()
        .map(|element| {
            let children: Vec<Value> = element
                .children
                .iter()
                .map(|child| match child {
                    XmlNode::Element(id) => json!({ "element": id }),
                    XmlNode::Text(text) => json!({
                        "type": "text", "start": text.start, "end": text.end,
                        "value": to_wire(&text.value), "cdata": text.cdata,
                    }),
                    XmlNode::Other(other) => json!({
                        "type": match other.kind {
                            OtherKind::Comment => "comment",
                            OtherKind::Pi => "pi",
                        },
                        "start": other.start, "end": other.end,
                    }),
                })
                .collect();
            json!({
                "name": element.name, "local": element.local,
                "attributes": element.attributes.iter()
                    .map(|a| json!({ "name": a.name, "value": a.value })).collect::<Vec<_>>(),
                "start": element.start, "startTagEnd": element.start_tag_end,
                "endTagStart": element.end_tag_start, "end": element.end,
                "selfClosing": element.self_closing, "parent": element.parent,
                "children": children,
            })
        })
        .collect();
    json!({
        "ok": true, "hasDoctype": document.has_doctype, "root": document.root,
        "elements": elements,
    })
}
