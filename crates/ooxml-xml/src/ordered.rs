//! The ordered element tree the TypeScript engine gets from fast-xml-parser, and
//! the serializer the engine applies to it.
//!
//! [`parse_ordered`] is a port of fast-xml-parser 5.10.1 `OrderedObjParser.parseXml`
//! with the options of packages/docx-engine/src/xml-utils.ts (`preserveOrder`,
//! attributes kept with no prefix, nothing trimmed or coerced). What that parser
//! tolerates, drops or rejects is observable in every fragment the engine stores,
//! so each rule below follows the original even where it is not what XML says.
//! [`serialize`] is `serializeXNode` of the same file.

use std::borrow::Cow;
use std::fmt;

use jscompat::{is_js_space, trim, trim_start};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum XNode {
    Element(XElement),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XElement {
    pub name: String,
    /// In the order a JavaScript object enumerates them: integer-like names
    /// first in numeric order, then the rest as written.
    pub attrs: Vec<(String, String)>,
    pub children: Vec<XNode>,
}

/// Dropping a tree must not recurse: table XML nests thousands of levels.
impl Drop for XElement {
    fn drop(&mut self) {
        let mut pending = std::mem::take(&mut self.children);
        while let Some(node) = pending.pop() {
            if let XNode::Element(mut element) = node {
                pending.append(&mut element.children);
            }
        }
    }
}

/// Why the original parser throws. The engine only asks whether it threw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    ClosingTagNotClosed,
    TagNotClosed,
    PiNotClosed,
    CommentNotClosed,
    CdataNotClosed,
    /// `__proto__`, `constructor` or `prototype` as a tag or attribute name.
    ReservedName(String),
    /// A tag named `#text`.
    InvalidTagName(String),
    MaxNestedTags,
    /// A tag, processing instruction or CDATA section after a closing tag
    /// closed the document itself (the original fails with a TypeError).
    NoOpenNode,
    /// `<!D...`: document type declarations are not ported.
    Doctype,
    /// The original would cut a surrogate pair in half, which a Rust string
    /// cannot hold.
    SplitSurrogatePair,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ClosingTagNotClosed => f.write_str("Closing Tag is not closed."),
            Self::TagNotClosed => f.write_str("tag is not closed"),
            Self::PiNotClosed => f.write_str("Pi Tag is not closed."),
            Self::CommentNotClosed => f.write_str("Comment is not closed."),
            Self::CdataNotClosed => f.write_str("CDATA is not closed."),
            Self::ReservedName(name) => write!(f, "[SECURITY] Invalid name: \"{name}\""),
            Self::InvalidTagName(name) => write!(f, "Invalid tag name: {name}"),
            Self::MaxNestedTags => f.write_str("Maximum nested tags exceeded"),
            Self::NoOpenNode => f.write_str("content after the document was closed"),
            Self::Doctype => f.write_str("document type declarations are not supported"),
            Self::SplitSurrogatePair => f.write_str("a surrogate pair would be split"),
        }
    }
}

impl std::error::Error for ParseError {}

/// Parses `xml` into the node list `xmlParser.parse(xml)` returns.
///
/// `max_nested_tags` is the parser's `maxNestedTags`: 100 for `xmlParser`,
/// 100 000 for `deepXmlParser`.
pub fn parse_ordered(xml: &str, max_nested_tags: usize) -> Result<Vec<XNode>, ParseError> {
    let source = normalize_newlines(xml);
    Parser {
        source: &source,
        max_nested_tags,
        root: Vec::new(),
        open: Vec::new(),
        detached: false,
        text: String::new(),
        xml_1_1: false,
    }
    .run()
}

/// `xmlData.replace(/\r\n?/g, "\n")`
pub(crate) fn normalize_newlines(xml: &str) -> Cow<'_, str> {
    if !xml.contains('\r') {
        return Cow::Borrowed(xml);
    }
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    while let Some(at) = rest.find('\r') {
        out.push_str(&rest[..at]);
        out.push('\n');
        rest = &rest[at + 1..];
        rest = rest.strip_prefix('\n').unwrap_or(rest);
    }
    out.push_str(rest);
    Cow::Owned(out)
}

struct Parser<'a> {
    source: &'a str,
    max_nested_tags: usize,
    root: Vec<XNode>,
    open: Vec<XElement>,
    /// A closing tag arrived with no element open: the original loses its
    /// current node, after which only text, comments and closing tags pass.
    detached: bool,
    /// Text collected since the last tag. Comments do not interrupt it.
    text: String,
    xml_1_1: bool,
}

impl Parser<'_> {
    fn run(mut self) -> Result<Vec<XNode>, ParseError> {
        let source = self.source;
        let mut cursor = 0;
        while let Some(found) = source[cursor..].find('<') {
            let at = cursor + found;
            self.text.push_str(&source[cursor..at]);
            let rest = &source[at..];
            cursor = if rest.starts_with("</") {
                self.closing_tag(at)?
            } else if rest.starts_with("<?") {
                self.processing_instruction(at)?
            } else if rest.starts_with("<!--") {
                let close = find_from(source, "-->", at + 4).ok_or(ParseError::CommentNotClosed)?;
                close + 3
            } else if rest.starts_with("<!D") {
                return Err(ParseError::Doctype);
            } else if rest.starts_with("<![") {
                self.cdata(at)?
            } else {
                self.opening_tag(at)?
            };
        }
        // text after the last tag is never stored
        while let Some(element) = self.open.pop() {
            self.children()?.push(XNode::Element(element));
        }
        Ok(self.root)
    }

    fn children(&mut self) -> Result<&mut Vec<XNode>, ParseError> {
        if self.detached {
            return Err(ParseError::NoOpenNode);
        }
        Ok(match self.open.last_mut() {
            Some(element) => &mut element.children,
            None => &mut self.root,
        })
    }

    fn flush_text(&mut self) -> Result<(), ParseError> {
        if self.text.is_empty() {
            return Ok(());
        }
        let text = std::mem::take(&mut self.text);
        let decoded = decode_entities(&text, self.xml_1_1);
        let children = self.children()?;
        if !decoded.is_empty() {
            children.push(XNode::Text(decoded.into_owned()));
        }
        Ok(())
    }

    /// The name inside a closing tag is never compared: it closes whatever is
    /// open. A reserved name is still rejected.
    fn closing_tag(&mut self, at: usize) -> Result<usize, ParseError> {
        let close = find_from(self.source, ">", at).ok_or(ParseError::ClosingTagNotClosed)?;
        sanitize_name(trim(&self.source[at + 2..close]))?;
        if !self.detached {
            self.flush_text()?;
        }
        match self.open.pop() {
            Some(element) => self.children()?.push(XNode::Element(element)),
            None => self.detached = true,
        }
        self.text.clear();
        Ok(close + 1)
    }

    fn processing_instruction(&mut self, at: usize) -> Result<usize, ParseError> {
        let (expression, close) =
            tag_expression(self.source, at + 1, b"?>").ok_or(ParseError::PiNotClosed)?;
        let (name, attribute_text) = split_tag_expression(&expression);
        self.flush_text()?;
        let attrs = self.attributes(attribute_text)?;
        if let Some(attrs) = &attrs {
            // `Number(version) || 1.0`, then anything but 1.1 means 1.0
            self.xml_1_1 = attrs
                .iter()
                .find(|(key, _)| key == "version")
                .is_some_and(|(_, value)| trim(value).parse::<f64>() == Ok(1.1));
        }
        let element = XElement {
            name: name.to_owned(),
            attrs: if name == attribute_text {
                Vec::new()
            } else {
                attrs.unwrap_or_default()
            },
            children: vec![XNode::Text(String::new())],
        };
        self.children()?.push(XNode::Element(element));
        Ok(close + 2)
    }

    /// Every `<![` is read as a 9-character CDATA opener, whatever follows it.
    fn cdata(&mut self, at: usize) -> Result<usize, ParseError> {
        let source = self.source;
        let close = find_from(source, "]]>", at).ok_or(ParseError::CdataNotClosed)?;
        let content_start = skip_utf16_units(source, at, 9)?;
        // `substring(start, end)` swaps its arguments when start > end
        let content = &source[content_start.min(close)..content_start.max(close)];
        self.flush_text()?;
        // no entity decoding inside CDATA, and an empty section still makes a node
        self.children()?.push(XNode::Text(content.to_owned()));
        Ok(close + 3)
    }

    fn opening_tag(&mut self, at: usize) -> Result<usize, ParseError> {
        let (expression, close) =
            tag_expression(self.source, at + 1, b">").ok_or(ParseError::TagNotClosed)?;
        let (raw_name, mut attribute_text) = split_tag_expression(&expression);
        let mut name = sanitize_name(raw_name)?;
        if name == "#text" {
            return Err(ParseError::InvalidTagName(name.into_owned()));
        }
        // text directly under the document node is dropped here, not stored
        if !self.detached && !self.open.is_empty() {
            self.flush_text()?;
        }

        let mut attributes_present = true;
        let self_closing = attribute_text.ends_with('/');
        if self_closing {
            match name.strip_suffix('/') {
                Some(stripped) => {
                    name = Cow::Owned(stripped.to_owned());
                    attribute_text = "";
                    attributes_present = false;
                }
                None => {
                    attribute_text = &attribute_text[..attribute_text.len() - 1];
                    attributes_present = *name != *attribute_text;
                }
            }
        } else if *name == *attribute_text {
            attributes_present = false;
        }
        let attrs = if attributes_present {
            self.attributes(attribute_text)?.unwrap_or_default()
        } else {
            Vec::new()
        };

        if self_closing {
            let element = XElement {
                name: sanitize_name(&name)?.into_owned(),
                attrs,
                children: Vec::new(),
            };
            self.children()?.push(XNode::Element(element));
        } else {
            if self.open.len() > self.max_nested_tags {
                return Err(ParseError::MaxNestedTags);
            }
            if self.detached {
                return Err(ParseError::NoOpenNode);
            }
            self.open.push(XElement {
                name: name.into_owned(),
                attrs,
                children: Vec::new(),
            });
        }
        self.text.clear();
        Ok(close + 1)
    }

    /// `buildAttributesMap`: `None` when no attribute has a quoted value.
    fn attributes(&self, text: &str) -> Result<Option<Vec<(String, String)>>, ParseError> {
        let mut map = AttributeMap::default();
        let mut position = 0;
        while let Some(token) = next_attribute(text, position) {
            position = token.end;
            // a reserved name throws even when the token has no value
            let name = sanitize_name(token.name)?;
            if let Some(value) = token.value {
                map.set(
                    name.into_owned(),
                    decode_entities(value, self.xml_1_1).into_owned(),
                );
            }
        }
        Ok(map.into_object_order())
    }
}

pub(crate) fn find_from(text: &str, needle: &str, from: usize) -> Option<usize> {
    text.get(from..)?.find(needle).map(|at| from + at)
}

pub(crate) fn skip_utf16_units(text: &str, from: usize, units: usize) -> Result<usize, ParseError> {
    let mut remaining = units;
    for (offset, ch) in text[from..].char_indices() {
        if remaining == 0 {
            return Ok(from + offset);
        }
        remaining = remaining
            .checked_sub(ch.len_utf16())
            .ok_or(ParseError::SplitSurrogatePair)?;
    }
    Ok(text.len())
}

/// `tagExpWithClosingIndex`: the text between `from` and the first `closing`
/// outside quotes, with tabs outside quotes turned into spaces, and the byte
/// offset of that `closing`.
pub(crate) fn tag_expression<'a>(
    text: &'a str,
    from: usize,
    closing: &[u8],
) -> Option<(Cow<'a, str>, usize)> {
    let bytes = text.as_bytes();
    let mut quote = 0u8;
    let mut tabs = false;
    let mut end = None;
    for (index, &byte) in bytes.iter().enumerate().skip(from) {
        if quote != 0 {
            if byte == quote {
                quote = 0;
            }
        } else if byte == b'"' || byte == b'\'' {
            quote = byte;
        } else if bytes[index..].starts_with(closing) {
            end = Some(index);
            break;
        } else if byte == b'\t' {
            tabs = true;
        }
    }
    let end = end?;
    let raw = &text[from..end];
    if !tabs {
        return Some((Cow::Borrowed(raw), end));
    }
    let mut quote = None;
    let spaced = raw
        .chars()
        .map(|ch| match quote {
            Some(open) => {
                if ch == open {
                    quote = None;
                }
                ch
            }
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                ch
            }
            None if ch == '\t' => ' ',
            None => ch,
        })
        .collect();
    Some((Cow::Owned(spaced), end))
}

/// `readTagExp`: the tag name and the attribute text. A tag with no whitespace
/// has its whole expression as both.
pub(crate) fn split_tag_expression(expression: &str) -> (&str, &str) {
    match expression.char_indices().find(|(_, ch)| is_js_space(*ch)) {
        Some((at, space)) => (
            &expression[..at],
            trim_start(&expression[at + space.len_utf8()..]),
        ),
        None => (expression, expression),
    }
}

const RESERVED_NAMES: [&str; 3] = ["__proto__", "constructor", "prototype"];
const RENAMED_NAMES: [&str; 7] = [
    "hasOwnProperty",
    "toString",
    "valueOf",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

/// `sanitizeName`: names that would collide with JavaScript object internals.
pub(crate) fn sanitize_name(name: &str) -> Result<Cow<'_, str>, ParseError> {
    if RESERVED_NAMES.contains(&name) {
        return Err(ParseError::ReservedName(name.to_owned()));
    }
    if RENAMED_NAMES.contains(&name) {
        return Ok(Cow::Owned(format!("__{name}")));
    }
    Ok(Cow::Borrowed(name))
}

pub(crate) struct AttributeToken<'a> {
    pub(crate) name: &'a str,
    pub(crate) value: Option<&'a str>,
    pub(crate) end: usize,
}

/// One match of `([^\s=]+)\s*(=\s*(['"])([\s\S]*?)\3)?` at or after `from`.
pub(crate) fn next_attribute(text: &str, from: usize) -> Option<AttributeToken<'_>> {
    let is_name_char = |ch: char| !is_js_space(ch) && ch != '=';
    let start = from + text[from..].find(is_name_char)?;
    let name_end = text[start..]
        .find(|ch: char| !is_name_char(ch))
        .map_or(text.len(), |length| start + length);
    let name = &text[start..name_end];
    let after_name = text.len() - trim_start(&text[name_end..]).len();
    let no_value = AttributeToken {
        name,
        value: None,
        end: after_name,
    };

    let Some(after_equals) = text[after_name..].strip_prefix('=') else {
        return Some(no_value);
    };
    let quoted = trim_start(after_equals);
    let Some(quote) = quoted.chars().next().filter(|ch| *ch == '"' || *ch == '\'') else {
        return Some(no_value);
    };
    let value_start = text.len() - quoted.len() + 1;
    let Some(length) = text[value_start..].find(quote) else {
        return Some(no_value);
    };
    Some(AttributeToken {
        name,
        value: Some(&text[value_start..value_start + length]),
        end: value_start + length + 1,
    })
}

/// Attributes of one tag, kept the way the original keeps them: in a JavaScript
/// object. A repeated name overwrites the value in its first position.
#[derive(Default)]
struct AttributeMap {
    entries: Vec<(String, String)>,
}

impl AttributeMap {
    fn set(&mut self, name: String, value: String) {
        match self.entries.iter_mut().find(|(key, _)| *key == name) {
            Some(entry) => entry.1 = value,
            None => self.entries.push((name, value)),
        }
    }

    /// Property enumeration order: array-index names ascending, then the rest
    /// in insertion order.
    fn into_object_order(mut self) -> Option<Vec<(String, String)>> {
        if self.entries.is_empty() {
            return None;
        }
        if self
            .entries
            .iter()
            .any(|(key, _)| array_index(key).is_some())
        {
            self.entries.sort_by_key(|(key, _)| match array_index(key) {
                Some(index) => (0, index),
                None => (1, 0),
            });
        }
        Some(self.entries)
    }
}

/// The canonical decimal form of an integer below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let canonical =
        key == "0" || (!key.starts_with('0') && key.bytes().all(|b| b.is_ascii_digit()));
    if !canonical || key.is_empty() {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// `EntityDecoder.decode` as the parser configures it: the five XML entities are
/// replaced; a numeric reference is left as written unless it names U+0000, a
/// surrogate or (in XML 1.0) a C0 control other than tab, LF and CR, which is
/// removed; everything else stays.
pub(crate) fn decode_entities(text: &str, xml_1_1: bool) -> Cow<'_, str> {
    let Some(first) = text.find('&') else {
        return Cow::Borrowed(text);
    };
    let mut out = String::new();
    let mut copied = 0;
    let mut cursor = first;
    while let Some(found) = text[cursor..].find('&') {
        let at = cursor + found;
        cursor = at + 1;
        let Some(token) = entity_token(&text[at + 1..]) else {
            continue;
        };
        let replacement = match token {
            "amp" => "&",
            "apos" => "'",
            "gt" => ">",
            "lt" => "<",
            "quot" => "\"",
            _ if token.starts_with('#') && removed_reference(token, xml_1_1) => "",
            _ => continue,
        };
        out.push_str(&text[copied..at]);
        out.push_str(replacement);
        copied = at + token.len() + 2;
        cursor = copied;
    }
    if copied == 0 {
        return Cow::Borrowed(text);
    }
    out.push_str(&text[copied..]);
    Cow::Owned(out)
}

/// The text between `&` and the first `;`, when it is 1 to 32 UTF-16 units long.
fn entity_token(after_ampersand: &str) -> Option<&str> {
    let mut units = 0;
    for (offset, ch) in after_ampersand.char_indices() {
        if ch == ';' {
            return (offset > 0).then(|| &after_ampersand[..offset]);
        }
        units += ch.len_utf16();
        if units > 32 {
            return None;
        }
    }
    None
}

fn removed_reference(token: &str, xml_1_1: bool) -> bool {
    let digits = &token[1..];
    let code_point = match digits.strip_prefix(['x', 'X']) {
        Some(hex) => parse_int(hex, 16),
        None => parse_int(digits, 10),
    };
    match code_point {
        Some(0) | Some(0xD800..=0xDFFF) => true,
        Some(0x09 | 0x0A | 0x0D) => false,
        Some(0x01..=0x1F) => !xml_1_1,
        _ => false,
    }
}

/// JavaScript `parseInt` for a result in `0..=0x10FFFF`; `None` for NaN and
/// for anything outside that range (the decoder leaves those references alone).
fn parse_int(text: &str, radix: u32) -> Option<u32> {
    let text = trim_start(text);
    let (negative, text) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let text = match radix {
        16 => text
            .strip_prefix("0x")
            .or_else(|| text.strip_prefix("0X"))
            .unwrap_or(text),
        _ => text,
    };
    let mut value: Option<u32> = None;
    for digit in text.chars().map_while(|ch| ch.to_digit(radix)) {
        let next = value
            .unwrap_or(0)
            .saturating_mul(radix)
            .saturating_add(digit);
        value = Some(next.min(0x11_0000));
    }
    // "-0" is zero; any other negative number is out of range
    value.filter(|value| *value <= 0x10_FFFF && !(negative && *value != 0))
}

/// `serializeXNode`: attributes in stored order, an element with no serialized
/// content self-closes, text is escaped after dropping the control characters
/// XML 1.0 forbids.
pub fn serialize(node: &XNode) -> String {
    let mut out = String::new();
    write(&mut out, vec![Step::Node(node)]);
    out
}

/// `serialize` for an element put together from parsed nodes: what the
/// TypeScript code builds as `{ [name]: children, ':@': attrs }`.
pub fn serialize_element(name: &str, attrs: &[(String, String)], children: &[&XNode]) -> String {
    let mut out = String::new();
    push_open_tag(&mut out, name, attrs);
    let mut steps = vec![Step::Close(name, out.len())];
    steps.extend(children.iter().rev().map(|child| Step::Node(child)));
    write(&mut out, steps);
    out
}

fn push_open_tag(out: &mut String, name: &str, attrs: &[(String, String)]) {
    out.push('<');
    out.push_str(name);
    for (name, value) in attrs {
        out.push(' ');
        out.push_str(name);
        out.push_str("=\"");
        push_escaped(out, value, true);
        out.push('"');
    }
    out.push('>');
}

fn write<'a>(out: &mut String, mut steps: Vec<Step<'a>>) {
    while let Some(step) = steps.pop() {
        match step {
            Step::Node(XNode::Text(text)) => push_escaped(out, text, false),
            // The serializer finds no element name in `""` and `":@"`, and reads
            // `"#text"` (only a self-closing tag can carry it) as empty text.
            Step::Node(XNode::Element(element))
                if matches!(&*element.name, "" | ":@" | "#text") => {}
            Step::Node(XNode::Element(element)) => {
                push_open_tag(out, &element.name, &element.attrs);
                steps.push(Step::Close(&element.name, out.len()));
                steps.extend(element.children.iter().rev().map(Step::Node));
            }
            Step::Close(name, content_start) => {
                if out.len() == content_start {
                    out.pop();
                    out.push_str("/>");
                } else {
                    out.push_str("</");
                    out.push_str(name);
                    out.push('>');
                }
            }
        }
    }
}

enum Step<'a> {
    Node(&'a XNode),
    /// The element name and where its content starts in the output.
    Close(&'a str, usize),
}

/// `escapeXmlText`, plus the quote of `escapeXmlAttr` for attribute values.
fn push_escaped(out: &mut String, text: &str, attribute: bool) {
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
}

#[cfg(test)]
mod tests;
