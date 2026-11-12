//! `core/xml.ts`: a lenient, position-preserving XML scanner.
//!
//! Nothing here builds a DOM or re-serialises XML. Every token and element is
//! reported as offsets into the ORIGINAL string, so slicing the string by a
//! reported range returns exactly the source text.
//!
//! Offsets: every offset here is a UTF-8 BYTE offset (the TypeScript counts
//! UTF-16 code units; every delimiter the scanner tests is ASCII, so a loop
//! over bytes stops at the same places). A part string that offsets are
//! converted for goes through `crate::offset::IndexedText`.
//!
//! Slicing: `slice` is `String.prototype.slice` for byte offsets: it clamps
//! and never panics, since an offset can come from a bridge map the host sent.
//!
//! Visitor shape: the TypeScript `ElementVisitor` is the trait `ElementVisitor`
//! with an associated `Data` type for the caller-owned `el.data` slot
//! (`None` is `undefined`).

use std::borrow::Cow;
use std::rc::Rc;

use jscompat::{JsMap, JsObject, Radix, parse_int};
use ooxml_xml::Utf16Index;

/// `s.slice(start, end)` over byte offsets: clamped to the string, an empty
/// answer for `start >= end`, and an offset inside a character moves to the
/// end of that character.
pub fn slice(text: &str, start: usize, end: usize) -> &str {
    let len = text.len();
    let mut start = start.min(len);
    let mut end = end.min(len);
    if start >= end {
        return "";
    }
    while !text.is_char_boundary(start) {
        start += 1;
    }
    while !text.is_char_boundary(end) {
        end += 1;
    }
    &text[start..end]
}

/// `XmlTokenKind`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum XmlTokenKind {
    Open,
    Close,
    Empty,
    Text,
    Comment,
    Cdata,
    Pi,
    Doctype,
}

impl XmlTokenKind {
    /// The string the TypeScript holds.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Close => "close",
            Self::Empty => "empty",
            Self::Text => "text",
            Self::Comment => "comment",
            Self::Cdata => "cdata",
            Self::Pi => "pi",
            Self::Doctype => "doctype",
        }
    }
}

const LT: u8 = b'<';
const GT: u8 = b'>';
const SLASH: u8 = b'/';
const BANG: u8 = b'!';
const QUESTION: u8 = b'?';
const DQUOTE: u8 = b'"';
const SQUOTE: u8 = b'\'';
const EQUALS: u8 = b'=';

/// `isSpace`
fn is_space(c: u8) -> bool {
    c == 32 || c == 9 || c == 10 || c == 13
}

/// `xml.charCodeAt(i)`: 0 past the end (no delimiter is 0).
fn byte_at(bytes: &[u8], i: usize) -> u8 {
    bytes.get(i).copied().unwrap_or(0)
}

/// `xml.indexOf(needle, from)` over bytes.
fn find_from(bytes: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    let from = from.min(bytes.len());
    let hay = &bytes[from..];
    if needle.len() == 1 {
        return hay.iter().position(|&b| b == needle[0]).map(|p| p + from);
    }
    hay.windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// `XmlScanner`: token-at-a-time cursor over `xml[from, to)`. The fields
/// describe the current token after each successful `next()`. `limit` may lie
/// past the end of the string, as in JavaScript: the code units past the end
/// are `NaN`, no delimiter, so a scan runs on to `limit` there and a text
/// token ends at `limit` (an offset past the end counts on as a byte offset).
pub struct XmlScanner<'a> {
    pub xml: &'a str,
    pub limit: usize,
    pub kind: XmlTokenKind,
    /// first character of the token
    pub start: usize,
    /// one past the token's last character
    pub end: usize,
    /// element or processing-instruction name as written (tags and PIs only)
    pub name: &'a str,
    /// one past the end of the name inside the tag
    pub name_end: usize,
    pos: usize,
}

impl<'a> XmlScanner<'a> {
    /// `new XmlScanner(xml, from, limit)`
    pub fn new(xml: &'a str, from: usize, limit: usize) -> Self {
        Self {
            xml,
            limit,
            kind: XmlTokenKind::Text,
            start: 0,
            end: 0,
            name: "",
            name_end: 0,
            pos: from,
        }
    }

    /// `new XmlScanner(xml)`
    pub fn whole(xml: &'a str) -> Self {
        Self::new(xml, 0, xml.len())
    }

    /// `next()`
    // Keeps the name of the ported `XmlScanner.next()`; not an `Iterator`.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> bool {
        let xml = self.xml;
        let bytes = xml.as_bytes();
        let limit = self.limit;
        let pos = self.pos;
        if pos >= limit {
            return false;
        }
        self.start = pos;
        self.name = "";
        if byte_at(bytes, pos) != LT {
            return self.text(pos + 1);
        }
        let c1 = byte_at(bytes, pos + 1);
        if c1 == BANG {
            if bytes[pos..].starts_with(b"<!--") {
                return self.until(XmlTokenKind::Comment, b"-->", pos + 4);
            }
            if bytes[pos..].starts_with(b"<![CDATA[") {
                return self.until(XmlTokenKind::Cdata, b"]]>", pos + 9);
            }
            return self.doctype(pos);
        }
        if c1 == QUESTION {
            let name_end = self.scan_name(pos + 2);
            self.name = slice(xml, pos + 2, name_end);
            return self.until(XmlTokenKind::Pi, b"?>", name_end);
        }
        if c1 == SLASH {
            let name_end = self.scan_name(pos + 2);
            if name_end == pos + 2 {
                return self.text(pos + 1);
            }
            let gt = find_from(bytes, b">", name_end);
            self.kind = XmlTokenKind::Close;
            self.name = slice(xml, pos + 2, name_end);
            self.name_end = name_end;
            self.end = match gt {
                Some(gt) if gt < limit => gt + 1,
                _ => limit,
            };
            self.pos = self.end;
            return true;
        }
        let name_end = self.scan_name(pos + 1);
        // `<` not followed by a name is malformed text; keep it as text
        if name_end == pos + 1 {
            return self.text(pos + 1);
        }
        let Some(gt) = self.find_tag_end(name_end) else {
            return self.text(pos + 1);
        };
        self.kind = if byte_at(bytes, gt - 1) == SLASH {
            XmlTokenKind::Empty
        } else {
            XmlTokenKind::Open
        };
        self.name = slice(xml, pos + 1, name_end);
        self.name_end = name_end;
        self.end = gt + 1;
        self.pos = self.end;
        true
    }

    fn text(&mut self, from: usize) -> bool {
        let lt = match find_from(self.xml.as_bytes(), b"<", from) {
            Some(lt) if lt <= self.limit => lt,
            _ => self.limit,
        };
        self.kind = XmlTokenKind::Text;
        self.end = lt;
        self.pos = lt;
        true
    }

    fn until(&mut self, kind: XmlTokenKind, terminator: &[u8], from: usize) -> bool {
        let at = find_from(self.xml.as_bytes(), terminator, from);
        self.kind = kind;
        self.end = match at {
            Some(at) if at + terminator.len() <= self.limit => at + terminator.len(),
            _ => self.limit,
        };
        self.pos = self.end;
        true
    }

    fn doctype(&mut self, pos: usize) -> bool {
        // `<!DOCTYPE ... [ ... ]>`: an internal subset may contain `>`
        let bytes = self.xml.as_bytes();
        let stop = self.limit.min(bytes.len());
        let mut depth = 0i64;
        let mut i = pos + 2;
        while i < stop {
            let c = bytes[i];
            if c == 91 {
                depth += 1;
            } else if c == 93 {
                depth -= 1;
            } else if c == GT && depth <= 0 {
                break;
            }
            i += 1;
        }
        // no delimiter past the end of the string: the loop ran to `limit`
        if i >= stop && i < self.limit {
            i = self.limit;
        }
        self.kind = XmlTokenKind::Doctype;
        self.end = (i + 1).min(self.limit);
        self.pos = self.end;
        true
    }

    fn scan_name(&self, from: usize) -> usize {
        let bytes = self.xml.as_bytes();
        let stop = self.limit.min(bytes.len());
        let mut i = from;
        while i < stop {
            let c = bytes[i];
            if is_space(c) || c == GT || c == SLASH || c == LT || c == EQUALS {
                return i;
            }
            if c == QUESTION && i > from {
                return i;
            }
            i += 1;
        }
        // no delimiter past the end of the string: the loop ran to `limit`
        i.max(self.limit)
    }

    /// Index of the `>` closing a start tag, honouring quoted attribute values.
    fn find_tag_end(&self, from: usize) -> Option<usize> {
        let bytes = self.xml.as_bytes();
        let stop = self.limit.min(bytes.len());
        let mut quote = 0u8;
        let mut i = from;
        while i < stop {
            let c = bytes[i];
            if quote != 0 {
                if c == quote {
                    quote = 0;
                }
            } else if c == DQUOTE || c == SQUOTE {
                quote = c;
            } else if c == GT {
                return Some(i);
            }
            i += 1;
        }
        // an unbalanced quote: fall back to the first `>` so one bad attribute
        // does not swallow the rest of the document
        match find_from(bytes, b">", from) {
            Some(gt) if gt < self.limit => Some(gt),
            _ => None,
        }
    }
}

/// `XmlAttribute`: one attribute of a start tag, with source offsets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct XmlAttribute {
    /// name as written (prefix not canonicalised)
    pub name: String,
    /// raw (still entity-escaped) value
    pub raw: String,
    pub name_start: usize,
    /// first character of the value (after the quote)
    pub value_start: usize,
    /// one past the value's last character (the closing quote's index)
    pub value_end: usize,
}

/// `readAttributes`: the attributes of the start tag whose name ends at
/// `name_end` and whose `>` is at `tag_end - 1`. Malformed attributes are
/// skipped, never an error.
pub fn read_attributes(xml: &str, name_end: usize, tag_end: usize) -> Vec<XmlAttribute> {
    let bytes = xml.as_bytes();
    let mut out = Vec::new();
    let mut i = name_end;
    let stop = tag_end;
    while i < stop {
        let mut c = byte_at(bytes, i);
        if is_space(c) || c == SLASH || c == GT {
            i += 1;
            continue;
        }
        let name_start = i;
        while i < stop {
            c = byte_at(bytes, i);
            if is_space(c) || c == EQUALS || c == GT || c == SLASH {
                break;
            }
            i += 1;
        }
        let name = slice(xml, name_start, i);
        while i < stop && is_space(byte_at(bytes, i)) {
            i += 1;
        }
        if byte_at(bytes, i) != EQUALS {
            if !name.is_empty() {
                out.push(XmlAttribute {
                    name: name.to_owned(),
                    raw: String::new(),
                    name_start,
                    value_start: i,
                    value_end: i,
                });
            }
            continue;
        }
        i += 1;
        while i < stop && is_space(byte_at(bytes, i)) {
            i += 1;
        }
        let quote = byte_at(bytes, i);
        if quote != DQUOTE && quote != SQUOTE {
            // unquoted value: read to whitespace or tag end
            let value_start = i;
            while i < stop && !is_space(byte_at(bytes, i)) && byte_at(bytes, i) != GT {
                i += 1;
            }
            out.push(XmlAttribute {
                name: name.to_owned(),
                raw: slice(xml, value_start, i).to_owned(),
                name_start,
                value_start,
                value_end: i,
            });
            continue;
        }
        let value_start = i + 1;
        let value_end = match find_from(bytes, &[quote], value_start) {
            Some(end) if end < stop => end,
            _ => value_start.max(before_unit(xml, stop)),
        };
        out.push(XmlAttribute {
            name: name.to_owned(),
            raw: slice(xml, value_start, value_end).to_owned(),
            name_start,
            value_start,
            value_end,
        });
        i = after_unit(xml, value_end);
    }
    out
}

/// `at - 1` as a byte offset: the start of the character before `at`, or one
/// byte back past the end of the string (no multi-byte character there). Zero
/// stays zero, as the caller takes the larger of this and a start.
fn before_unit(xml: &str, at: usize) -> usize {
    if at > xml.len() {
        return at - 1;
    }
    let mut i = at.saturating_sub(1);
    while !xml.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// `at + 1` as a byte offset: the end of the character at `at`, or one byte on
/// past the end of the string.
fn after_unit(xml: &str, at: usize) -> usize {
    match xml.get(at..).and_then(|rest| rest.chars().next()) {
        Some(c) => at + c.len_utf8(),
        None => at + 1,
    }
}

/// What `NAMED_ENTITIES[ref]` answers in JavaScript for a name that is a
/// member of `Object.prototype`: the replacement callback returns a function
/// (or the prototype object) and `String.prototype.replace` writes its string
/// form. Only `Object.prototype`'s own names reach here.
pub fn object_prototype_member(name: &str) -> Option<&'static str> {
    Some(match name {
        "constructor" => "function Object() { [native code] }",
        "hasOwnProperty" => "function hasOwnProperty() { [native code] }",
        "isPrototypeOf" => "function isPrototypeOf() { [native code] }",
        "propertyIsEnumerable" => "function propertyIsEnumerable() { [native code] }",
        "toLocaleString" => "function toLocaleString() { [native code] }",
        "toString" => "function toString() { [native code] }",
        "valueOf" => "function valueOf() { [native code] }",
        "__defineGetter__" => "function __defineGetter__() { [native code] }",
        "__defineSetter__" => "function __defineSetter__() { [native code] }",
        "__lookupGetter__" => "function __lookupGetter__() { [native code] }",
        "__lookupSetter__" => "function __lookupSetter__() { [native code] }",
        "__proto__" => "[object Object]",
        _ => return None,
    })
}

/// `decodeXmlEntities`: the five XML entities and numeric references; an
/// unknown reference stays verbatim. The pattern is
/// `&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);` (a lower-case `x` only,
/// so `&#X41;` stays), written as a hand scan: none of its classes holds `;`,
/// so there is nothing to backtrack. A reference to a surrogate code point
/// is one UTF-16 unit, joined with a neighbour reference into a pair as
/// JavaScript does, and U+FFFD where it stays alone (a Rust string holds no
/// lone surrogate). A name that is a
/// member of `Object.prototype` (`&constructor;`) decodes to the string form
/// of that member, as the TypeScript lookup does.
pub fn decode_xml_entities(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_owned();
    }
    let bytes = raw.as_bytes();
    // UTF-16 units, so that two references to the halves of a surrogate pair
    // written side by side join into the character, as the JavaScript
    // concatenation does; a half left alone becomes U+FFFD at the end
    let mut out: Vec<u16> = Vec::with_capacity(raw.len());
    let mut at = 0;
    while at < bytes.len() {
        let amp = match bytes[at..].iter().position(|&b| b == b'&') {
            Some(p) => at + p,
            None => break,
        };
        out.extend(raw[at..amp].encode_utf16());
        match entity_at(raw, amp) {
            Some((Replacement::Text(replacement), end)) => {
                out.extend(replacement.encode_utf16());
                at = end;
            }
            Some((Replacement::Unit(unit), end)) => {
                out.push(unit);
                at = end;
            }
            None => {
                out.push(u16::from(b'&'));
                at = amp + 1;
            }
        }
    }
    out.extend(raw[at..].encode_utf16());
    String::from_utf16_lossy(&out)
}

/// What a reference decodes to: text, or one UTF-16 unit (a surrogate half).
enum Replacement {
    Text(Cow<'static, str>),
    Unit(u16),
}

/// The reference starting at the `&` at `amp`: its replacement and the byte
/// after its `;`.
fn entity_at(raw: &str, amp: usize) -> Option<(Replacement, usize)> {
    let bytes = raw.as_bytes();
    let first = *bytes.get(amp + 1)?;
    let body = amp + 1;
    if first == b'#' {
        let (digits_from, radix, valid): (usize, Radix, fn(u8) -> bool) =
            if bytes.get(amp + 2) == Some(&b'x') {
                (amp + 3, Radix::Sixteen, |b| b.is_ascii_hexdigit())
            } else {
                (amp + 2, Radix::Ten, |b| b.is_ascii_digit())
            };
        let mut end = digits_from;
        while end < bytes.len() && valid(bytes[end]) {
            end += 1;
        }
        if end == digits_from || bytes.get(end) != Some(&b';') {
            return None;
        }
        let code = parse_int(&raw[digits_from..end], radix);
        if !code.is_finite() || !(0.0..=1_114_111.0).contains(&code) {
            return Some((
                Replacement::Text(Cow::Owned(raw[amp..=end].to_owned())),
                end + 1,
            ));
        }
        return Some(match char::from_u32(code as u32) {
            Some(c) => (Replacement::Text(Cow::Owned(c.to_string())), end + 1),
            None => (Replacement::Unit(code as u16), end + 1),
        });
    }
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let mut end = body + 1;
    while end < bytes.len() && bytes[end].is_ascii_alphanumeric() {
        end += 1;
    }
    if bytes.get(end) != Some(&b';') {
        return None;
    }
    let name = &raw[body..end];
    let replacement: Cow<'static, str> = match name {
        "lt" => Cow::Borrowed("<"),
        "gt" => Cow::Borrowed(">"),
        "amp" => Cow::Borrowed("&"),
        "quot" => Cow::Borrowed("\""),
        "apos" => Cow::Borrowed("'"),
        _ => match object_prototype_member(name) {
            Some(text) => Cow::Borrowed(text),
            None => Cow::Owned(raw[amp..=end].to_owned()),
        },
    };
    Some((Replacement::Text(replacement), end + 1))
}

/// `escapeXmlText`: control characters outside `\t \n \r` are dropped, then
/// `&`, `<`, `>` are escaped.
pub fn escape_xml_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\u{0}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' => {}
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
    }
    out
}

/// `escapeXmlAttr`: the text escape and `"`.
pub fn escape_xml_attr(text: &str) -> String {
    escape_xml_text(text).replace('"', "&quot;")
}

/// `ODF_NAMESPACES`: namespace URI and the prefix this package uses for it.
pub const ODF_NAMESPACES: &[(&str, &str)] = &[
    ("urn:oasis:names:tc:opendocument:xmlns:office:1.0", "office"),
    ("urn:oasis:names:tc:opendocument:xmlns:style:1.0", "style"),
    ("urn:oasis:names:tc:opendocument:xmlns:text:1.0", "text"),
    ("urn:oasis:names:tc:opendocument:xmlns:table:1.0", "table"),
    ("urn:oasis:names:tc:opendocument:xmlns:drawing:1.0", "draw"),
    (
        "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
        "fo",
    ),
    (
        "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
        "svg",
    ),
    (
        "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0",
        "number",
    ),
    ("urn:oasis:names:tc:opendocument:xmlns:meta:1.0", "meta"),
    (
        "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0",
        "manifest",
    ),
    ("urn:oasis:names:tc:opendocument:xmlns:config:1.0", "config"),
    ("urn:oasis:names:tc:opendocument:xmlns:chart:1.0", "chart"),
    ("urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0", "dr3d"),
    ("urn:oasis:names:tc:opendocument:xmlns:form:1.0", "form"),
    ("urn:oasis:names:tc:opendocument:xmlns:script:1.0", "script"),
    (
        "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
        "presentation",
    ),
    (
        "urn:oasis:names:tc:opendocument:xmlns:animation:1.0",
        "anim",
    ),
    (
        "urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0",
        "smil",
    ),
    ("http://www.w3.org/1999/xlink", "xlink"),
    ("http://purl.org/dc/elements/1.1/", "dc"),
    ("http://www.w3.org/1998/Math/MathML", "math"),
    ("http://www.w3.org/2002/xforms", "xforms"),
    ("http://www.w3.org/1999/xhtml", "xhtml"),
];

/// `ODF_NAMESPACES[uri]`, truthy answers only (a name that is a member of
/// `Object.prototype` answers its string form, as the lookup does).
fn namespace_prefix(uri: &str) -> Option<&'static str> {
    ODF_NAMESPACES
        .iter()
        .find(|(known, _)| *known == uri)
        .map(|(_, prefix)| *prefix)
        .or_else(|| object_prototype_member(uri))
}

/// `PrefixMap`: maps the prefixes a document declares on its root element to
/// the canonical ODF prefixes, so `t:p` in a document that binds `t` to the
/// text namespace is recognised as `text:p`. Identity for the usual case.
#[derive(Clone, Debug, Default)]
pub struct PrefixMap {
    rename: JsMap<String>,
}

impl PrefixMap {
    /// `new PrefixMap()`
    pub fn new() -> Self {
        Self::default()
    }

    /// `new PrefixMap(rootAttributes)`
    pub fn from_attributes(root_attributes: &[XmlAttribute]) -> Self {
        let mut rename = JsMap::new();
        for attr in root_attributes {
            let Some(prefix) = attr.name.strip_prefix("xmlns:") else {
                continue;
            };
            if let Some(canonical) = namespace_prefix(&decode_xml_entities(&attr.raw))
                && canonical != prefix
            {
                rename.set(prefix.to_owned(), canonical.to_owned());
            }
        }
        Self { rename }
    }

    /// `canonical(qname)`: the canonical form of a qualified name as written.
    pub fn canonical<'a>(&self, qname: &'a str) -> Cow<'a, str> {
        if self.rename.is_empty() {
            return Cow::Borrowed(qname);
        }
        let Some(colon) = qname.find(':') else {
            return Cow::Borrowed(qname);
        };
        match self.rename.get(&qname[..colon]) {
            Some(mapped) if !mapped.is_empty() => {
                Cow::Owned(format!("{mapped}{}", &qname[colon..]))
            }
            _ => Cow::Borrowed(qname),
        }
    }
}

/// `XmlRoot`: the root element of a part.
#[derive(Clone, Debug)]
pub struct XmlRoot {
    /// canonical name
    pub name: String,
    /// name as written
    pub tag: String,
    pub start: usize,
    pub end: usize,
    pub attributes: Vec<XmlAttribute>,
    pub prefixes: Rc<PrefixMap>,
}

/// `readRoot`: the document element (first start tag) of `xml`.
pub fn read_root(xml: &str) -> Option<XmlRoot> {
    let mut scanner = XmlScanner::whole(xml);
    while scanner.next() {
        if scanner.kind != XmlTokenKind::Open && scanner.kind != XmlTokenKind::Empty {
            continue;
        }
        let attributes = read_attributes(xml, scanner.name_end, scanner.end);
        let prefixes = PrefixMap::from_attributes(&attributes);
        return Some(XmlRoot {
            name: prefixes.canonical(scanner.name).into_owned(),
            tag: scanner.name.to_owned(),
            start: scanner.start,
            end: scanner.end,
            attributes,
            prefixes: Rc::new(prefixes),
        });
    }
    None
}

/// `name in {}`: whether a plain object already has `name` (its own or from
/// `Object.prototype`).
fn in_plain_object(map: &JsObject<String>, name: &str) -> bool {
    map.get(name).is_some() || object_prototype_member(name).is_some()
}

/// `attributeMap`: decoded attributes of a start tag, keyed by canonical
/// name; the first of a repeated name wins.
pub fn attribute_map(
    xml: &str,
    name_end: usize,
    tag_end: usize,
    prefixes: &PrefixMap,
) -> JsObject<String> {
    let mut out = JsObject::new();
    for attr in read_attributes(xml, name_end, tag_end) {
        let name = prefixes.canonical(&attr.name);
        if !in_plain_object(&out, &name) {
            out.set(name.into_owned(), decode_xml_entities(&attr.raw));
        }
    }
    out
}

/// `ElementRange`: source offsets of one element (bytes). For a self-closing
/// element `open_end == close_start == end`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ElementRange {
    /// `<` of the start tag
    pub start: usize,
    /// one past the start tag's `>`
    pub open_end: usize,
    /// `<` of the end tag (or `end` when self-closing or unclosed)
    pub close_start: usize,
    /// one past the end tag's `>`
    pub end: usize,
    pub self_closing: bool,
}

/// `ElementFrame`: an element being walked. `close_start` and `end` are
/// `None` (`-1` in the TypeScript) until the element closes.
#[derive(Clone, Debug)]
pub struct ElementFrame<D> {
    /// canonical qualified name
    pub name: String,
    /// qualified name as written
    pub tag: String,
    pub start: usize,
    /// one past the name inside the start tag
    pub name_end: usize,
    pub open_end: usize,
    pub close_start: Option<usize>,
    pub end: Option<usize>,
    pub self_closing: bool,
    /// caller-owned slot
    pub data: Option<D>,
}

impl<D> ElementFrame<D> {
    /// The range once the element has closed (`open_end` stands for an offset
    /// not yet known).
    pub fn range(&self) -> ElementRange {
        ElementRange {
            start: self.start,
            open_end: self.open_end,
            close_start: self.close_start.unwrap_or(self.open_end),
            end: self.end.unwrap_or(self.open_end),
            self_closing: self.self_closing,
        }
    }
}

/// What `open` answers: `undefined`, `'skip'` or `'stop'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenVerdict {
    Continue,
    /// walk the subtree silently
    Skip,
    /// end the walk
    Stop,
}

/// What `close` answers: `undefined` or `'stop'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseVerdict {
    Continue,
    Stop,
}

/// `ElementVisitor`
pub trait ElementVisitor {
    /// the type of the caller-owned `el.data` slot
    type Data;

    /// Called at a start tag. Self-closing elements get `close` right after.
    fn open(
        &mut self,
        el: &mut ElementFrame<Self::Data>,
        parent: Option<&ElementFrame<Self::Data>>,
    ) -> OpenVerdict;

    /// Called when the element's extent is known.
    fn close(
        &mut self,
        _el: &mut ElementFrame<Self::Data>,
        _parent: Option<&ElementFrame<Self::Data>>,
    ) -> CloseVerdict {
        CloseVerdict::Continue
    }

    /// Text, comments, CDATA, processing instructions and doctypes (not inside
    /// skipped subtrees).
    fn other(
        &mut self,
        _kind: XmlTokenKind,
        _start: usize,
        _end: usize,
        _parent: Option<&ElementFrame<Self::Data>>,
    ) {
    }

    /// Malformed markup that was tolerated.
    fn warn(&mut self, _message: &str) {}
}

/// `walkElements(xml, prefixes, visitor, from, to)`: the elements of
/// `xml[from, to)` in document order with lenient nesting. Returns the offset
/// where the walk ended.
pub fn walk_elements<V: ElementVisitor>(
    xml: &str,
    prefixes: &PrefixMap,
    visitor: &mut V,
    from: usize,
    to: usize,
) -> usize {
    let mut scanner = XmlScanner::new(xml, from, to);
    let mut stack: Vec<ElementFrame<V::Data>> = Vec::new();
    let mut units = WarnOffsets::new(xml);
    // depth (stack length) at which a skipped subtree started
    let mut skip_depth: Option<usize> = None;
    while scanner.next() {
        let kind = scanner.kind;
        if kind == XmlTokenKind::Open || kind == XmlTokenKind::Empty {
            let mut el = ElementFrame {
                name: prefixes.canonical(scanner.name).into_owned(),
                tag: scanner.name.to_owned(),
                start: scanner.start,
                name_end: scanner.name_end,
                open_end: scanner.end,
                close_start: None,
                end: None,
                self_closing: kind == XmlTokenKind::Empty,
                data: None,
            };
            if skip_depth.is_some() {
                if kind == XmlTokenKind::Open {
                    stack.push(el);
                }
                continue;
            }
            let verdict = visitor.open(&mut el, stack.last());
            if verdict == OpenVerdict::Stop {
                return scanner.end;
            }
            if kind == XmlTokenKind::Empty {
                el.close_start = Some(scanner.end);
                el.end = Some(scanner.end);
                if verdict != OpenVerdict::Skip
                    && visitor.close(&mut el, stack.last()) == CloseVerdict::Stop
                {
                    return scanner.end;
                }
                continue;
            }
            if verdict == OpenVerdict::Skip {
                skip_depth = Some(stack.len());
            }
            stack.push(el);
        } else if kind == XmlTokenKind::Close {
            let name = prefixes.canonical(scanner.name);
            let mut index = stack.len() as isize - 1;
            while index >= 0 && stack[index as usize].name != name {
                index -= 1;
            }
            if index < 0 {
                if skip_depth.is_none() {
                    let at = units.at(scanner.start);
                    visitor.warn(&format!("stray </{}> at {at}", scanner.name));
                }
                continue;
            }
            if finish_frames(
                &mut stack,
                &mut skip_depth,
                visitor,
                &mut units,
                index as usize,
                scanner.start,
                scanner.end,
            ) == CloseVerdict::Stop
            {
                return scanner.end;
            }
        } else if skip_depth.is_none() {
            visitor.other(kind, scanner.start, scanner.end, stack.last());
        }
    }
    if !stack.is_empty() {
        finish_frames(&mut stack, &mut skip_depth, visitor, &mut units, 0, to, to);
    }
    to
}

/// The UTF-16 offset of a byte offset, for the text of a warning (the
/// TypeScript prints a code-unit index). The index of the string is built at
/// the first warning only.
struct WarnOffsets<'a> {
    xml: &'a str,
    index: Option<Utf16Index>,
}

impl<'a> WarnOffsets<'a> {
    fn new(xml: &'a str) -> Self {
        Self { xml, index: None }
    }

    fn at(&mut self, byte: usize) -> u32 {
        let xml = self.xml;
        let index = self.index.get_or_insert_with(|| Utf16Index::new(xml));
        if byte > xml.len() {
            return index.len_utf16() + (byte - xml.len()) as u32;
        }
        index.to_utf16(xml, byte)
    }
}

/// Pops frames down to and including `index`. Frames above it were never
/// closed: they end where the closing tag begins.
fn finish_frames<V: ElementVisitor>(
    stack: &mut Vec<ElementFrame<V::Data>>,
    skip_depth: &mut Option<usize>,
    visitor: &mut V,
    units: &mut WarnOffsets<'_>,
    index: usize,
    close_start: usize,
    end: usize,
) -> CloseVerdict {
    while stack.len() > index {
        let mut el = stack.pop().expect("a frame above the index");
        let is_target = stack.len() == index && end != close_start;
        el.close_start = Some(close_start);
        el.end = Some(if is_target { end } else { close_start });
        let silent = skip_depth.is_some_and(|depth| stack.len() > depth);
        if *skip_depth == Some(stack.len()) {
            *skip_depth = None;
        }
        if silent {
            continue;
        }
        if !is_target {
            let at = units.at(el.start);
            visitor.warn(&format!("unclosed <{}> at {at}", el.tag));
        }
        if visitor.close(&mut el, stack.last()) == CloseVerdict::Stop {
            return CloseVerdict::Stop;
        }
    }
    CloseVerdict::Continue
}

/// `walkElements` over the whole string with only an `open` handler: the
/// closure answers the verdict for every start tag.
pub fn walk_open<D>(
    xml: &str,
    prefixes: &PrefixMap,
    from: usize,
    to: usize,
    open: impl FnMut(&mut ElementFrame<D>, Option<&ElementFrame<D>>) -> OpenVerdict,
) -> usize {
    struct OpenOnly<F, D>(F, std::marker::PhantomData<D>);
    impl<D, F> ElementVisitor for OpenOnly<F, D>
    where
        F: FnMut(&mut ElementFrame<D>, Option<&ElementFrame<D>>) -> OpenVerdict,
    {
        type Data = D;
        fn open(
            &mut self,
            el: &mut ElementFrame<D>,
            parent: Option<&ElementFrame<D>>,
        ) -> OpenVerdict {
            (self.0)(el, parent)
        }
    }
    walk_elements(
        xml,
        prefixes,
        &mut OpenOnly(open, std::marker::PhantomData),
        from,
        to,
    )
}
