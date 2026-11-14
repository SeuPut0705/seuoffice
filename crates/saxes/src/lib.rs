//! saxes 6.0.0 (ISC, Louis-Dominique Dubeau), ported line by line from
//! `node_modules/saxes/saxes.js`, with the character classes of xmlchars 2.2.0
//! (`xml/1.0/ed5`, `xml/1.1/ed2`, `xmlns/1.0/ed3`, MIT) it reads. The licence
//! of saxes is in `LICENSE` beside this crate's manifest.
//!
//! The parser is a state machine over UTF-16 code units, as the JavaScript is
//! over a `string`: positions are indexes into the units, an astral character
//! is two of them, and a lone surrogate is kept as it is. Every string the
//! parser hands out is therefore a [`Str`], a `Vec<u16>`.
//!
//! # Events
//!
//! JavaScript registers one function per event with `parser.on`. Here the
//! caller passes a [`Handler`] to [`Parser::write`] and [`Parser::close`]; an
//! event is a method of it that receives the parser, so `position`, `line` and
//! `column` can be read at every event, and a handler may call
//! [`Parser::fail`] as a JavaScript handler calls `parser.fail`.
//!
//! * A JavaScript handler that throws aborts `write`; a handler method that
//!   returns `Err` does the same.
//! * `saxes` behaves differently when no `text` handler or no `error` handler
//!   is set (without an `error` handler `fail` throws). A [`Handler`] says
//!   whether it has them with [`Handler::wants_text`] and
//!   [`Handler::wants_error`].
//! * `parser.fail` called inside a handler delivers its `error` event when the
//!   handler returns (before the parser reads another character), not in the
//!   middle of the handler; with no `error` handler it returns `Err` at once.
//! * Where V8 throws a `RangeError` from `String.fromCodePoint` (a code point
//!   beyond U+10FFFF, or the NaN the JavaScript computes for a high surrogate
//!   that ends the input), the port returns that error.
//!
//! The tag a handler receives is a snapshot of the fields JavaScript has set
//! at that event; a handler cannot keep the JavaScript object and see it
//! change later.

#[cfg(feature = "record")]
pub mod record;

use std::collections::VecDeque;

/// A JavaScript string: UTF-16 code units, lone surrogates included.
pub type Str = Vec<u16>;

/// The units of a Rust string.
pub fn units(text: &str) -> Str {
    text.encode_utf16().collect()
}

/// A JavaScript `Error` as saxes throws or reports it: `name` is `Error`
/// except for the `RangeError` and `TypeError` V8 raises.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub name: &'static str,
    pub message: Str,
}

impl Error {
    fn plain(name: &'static str, message: &str) -> Error {
        Error {
            name,
            message: units(message),
        }
    }

    /// The message with a lone surrogate written as U+FFFD.
    pub fn message_lossy(&self) -> String {
        String::from_utf16_lossy(&self.message)
    }
}

/// A string-keyed record that keeps the place of a key set again, as a
/// JavaScript object does (the integer keys JavaScript lists first are the
/// caller's business: this keeps the order of writing).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ns {
    entries: Vec<(Str, Str)>,
}

impl Ns {
    pub fn get(&self, key: &[u16]) -> Option<&Str> {
        self.entries
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    pub fn set(&mut self, key: Str, value: Str) {
        match self.entries.iter_mut().find(|(name, _)| *name == key) {
            Some(entry) => entry.1 = value,
            None => self.entries.push((key, value)),
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = &(Str, Str)> {
        self.entries.iter()
    }
}

/// `SaxesAttributePlain` (`name`, `value`) or `SaxesAttributeNS` (all five;
/// `uri` is set only once the tag is complete, so the `attribute` event has
/// none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attribute {
    pub name: Str,
    pub value: Str,
    pub prefix: Option<Str>,
    pub local: Option<Str>,
    pub uri: Option<Str>,
}

/// `SaxesTag`: `attributes` is in the order the names first appeared; a
/// duplicate keeps the place of the first and holds the value of the last.
/// `ns` is set with the `xmlns` option; `prefix`, `local` and `uri` are set
/// once the attributes were processed, so `opentagstart` has none of them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Tag {
    pub name: Str,
    pub attributes: Vec<Attribute>,
    pub ns: Option<Ns>,
    pub prefix: Option<Str>,
    pub local: Option<Str>,
    pub uri: Option<Str>,
    pub is_self_closing: bool,
}

/// `XMLDecl`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct XmlDecl {
    pub version: Option<Str>,
    pub encoding: Option<Str>,
    pub standalone: Option<Str>,
}

/// `resolvePrefix`: the URI of a prefix no declaration binds.
pub type ResolvePrefix = Box<dyn Fn(&[u16]) -> Option<Str>>;

/// `SaxesOptions`.
pub struct Options {
    pub fragment: bool,
    pub xmlns: bool,
    /// `position !== false`: only the text of an error depends on it.
    pub position: bool,
    pub file_name: Option<Str>,
    /// In the order `Object.keys` lists them; read with `xmlns` only.
    pub additional_namespaces: Option<Vec<(Str, Str)>>,
    pub resolve_prefix: Option<ResolvePrefix>,
    pub default_xml_version: Option<Str>,
    pub force_xml_version: bool,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            fragment: false,
            xmlns: false,
            position: true,
            file_name: None,
            additional_namespaces: None,
            resolve_prefix: None,
            default_xml_version: None,
            force_xml_version: false,
        }
    }
}

/// The result of an event method: `Err` is what a JavaScript handler throws.
pub type HandlerResult = Result<(), Error>;

/// One method per event of saxes. Every method does nothing by default.
#[allow(unused_variables)]
pub trait Handler {
    /// Whether a `text` handler is set.
    fn wants_text(&self) -> bool {
        false
    }
    /// Whether an `error` handler is set.
    fn wants_error(&self) -> bool {
        false
    }
    fn xmldecl(&mut self, cx: &mut Parser, decl: &XmlDecl) -> HandlerResult {
        Ok(())
    }
    fn text(&mut self, cx: &mut Parser, text: &[u16]) -> HandlerResult {
        Ok(())
    }
    fn processinginstruction(
        &mut self,
        cx: &mut Parser,
        target: &[u16],
        body: &[u16],
    ) -> HandlerResult {
        Ok(())
    }
    fn doctype(&mut self, cx: &mut Parser, doctype: &[u16]) -> HandlerResult {
        Ok(())
    }
    fn comment(&mut self, cx: &mut Parser, comment: &[u16]) -> HandlerResult {
        Ok(())
    }
    fn opentagstart(&mut self, cx: &mut Parser, tag: &Tag) -> HandlerResult {
        Ok(())
    }
    fn attribute(&mut self, cx: &mut Parser, attribute: &Attribute) -> HandlerResult {
        Ok(())
    }
    fn opentag(&mut self, cx: &mut Parser, tag: &Tag) -> HandlerResult {
        Ok(())
    }
    fn closetag(&mut self, cx: &mut Parser, tag: &Tag) -> HandlerResult {
        Ok(())
    }
    fn cdata(&mut self, cx: &mut Parser, cdata: &[u16]) -> HandlerResult {
        Ok(())
    }
    fn error(&mut self, cx: &mut Parser, error: &Error) -> HandlerResult {
        Ok(())
    }
    fn end(&mut self, cx: &mut Parser) -> HandlerResult {
        Ok(())
    }
    fn ready(&mut self, cx: &mut Parser) -> HandlerResult {
        Ok(())
    }
    /// `parser.ENTITIES[name]` for a name that is not one of the five
    /// entities of XML: the replacement text an assignment to `ENTITIES`
    /// gives it, or `None` where the table holds nothing under that name. An
    /// `Err` is what a getter of `ENTITIES` throws.
    fn entity(&mut self, name: &[u16]) -> Result<Option<Str>, Error> {
        Ok(None)
    }
}

// EOC: end-of-chunk
const EOC: i32 = -1;
const NL_LIKE: i32 = -2;
/// The NaN JavaScript computes for a high surrogate with nothing after it.
const NAN_CODE: i32 = -3;
/// A quote that is not there: `null` in `[this.q, QUESTION]`.
const NO_CHAR: i32 = -4;

const S_BEGIN: u8 = 0;
const S_BEGIN_WHITESPACE: u8 = 1;
const S_DOCTYPE: u8 = 2;
const S_DOCTYPE_QUOTE: u8 = 3;
const S_DTD: u8 = 4;
const S_DTD_QUOTED: u8 = 5;
const S_DTD_OPEN_WAKA: u8 = 6;
const S_DTD_OPEN_WAKA_BANG: u8 = 7;
const S_DTD_COMMENT: u8 = 8;
const S_DTD_COMMENT_ENDING: u8 = 9;
const S_DTD_COMMENT_ENDED: u8 = 10;
const S_DTD_PI: u8 = 11;
const S_DTD_PI_ENDING: u8 = 12;
const S_TEXT: u8 = 13;
const S_ENTITY: u8 = 14;
const S_OPEN_WAKA: u8 = 15;
const S_OPEN_WAKA_BANG: u8 = 16;
const S_COMMENT: u8 = 17;
const S_COMMENT_ENDING: u8 = 18;
const S_COMMENT_ENDED: u8 = 19;
const S_CDATA: u8 = 20;
const S_CDATA_ENDING: u8 = 21;
const S_CDATA_ENDING_2: u8 = 22;
const S_PI_FIRST_CHAR: u8 = 23;
const S_PI_REST: u8 = 24;
const S_PI_BODY: u8 = 25;
const S_PI_ENDING: u8 = 26;
const S_XML_DECL_NAME_START: u8 = 27;
const S_XML_DECL_NAME: u8 = 28;
const S_XML_DECL_EQ: u8 = 29;
const S_XML_DECL_VALUE_START: u8 = 30;
const S_XML_DECL_VALUE: u8 = 31;
const S_XML_DECL_SEPARATOR: u8 = 32;
const S_XML_DECL_ENDING: u8 = 33;
const S_OPEN_TAG: u8 = 34;
const S_OPEN_TAG_SLASH: u8 = 35;
const S_ATTRIB: u8 = 36;
const S_ATTRIB_NAME: u8 = 37;
const S_ATTRIB_NAME_SAW_WHITE: u8 = 38;
const S_ATTRIB_VALUE: u8 = 39;
const S_ATTRIB_VALUE_QUOTED: u8 = 40;
const S_ATTRIB_VALUE_CLOSED: u8 = 41;
const S_ATTRIB_VALUE_UNQUOTED: u8 = 42;
const S_CLOSE_TAG: u8 = 43;
const S_CLOSE_TAG_SAW_WHITE: u8 = 44;

const TAB: i32 = 9;
const NL: i32 = 0xA;
const CR: i32 = 0xD;
const SPACE: i32 = 0x20;
const BANG: i32 = 0x21;
const DQUOTE: i32 = 0x22;
const AMP: i32 = 0x26;
const SQUOTE: i32 = 0x27;
const MINUS: i32 = 0x2D;
const FORWARD_SLASH: i32 = 0x2F;
const SEMICOLON: i32 = 0x3B;
const LESS: i32 = 0x3C;
const EQUAL: i32 = 0x3D;
const GREATER: i32 = 0x3E;
const QUESTION: i32 = 0x3F;
const OPEN_BRACKET: i32 = 0x5B;
const CLOSE_BRACKET: i32 = 0x5D;
const NEL: i32 = 0x85;
const LS: i32 = 0x2028;

const DOCTYPE_TERMINATOR: [i32; 4] = [DQUOTE, SQUOTE, OPEN_BRACKET, GREATER];
const DTD_TERMINATOR: [i32; 4] = [DQUOTE, SQUOTE, LESS, CLOSE_BRACKET];
const XML_DECL_NAME_TERMINATOR: [i32; 6] = [EQUAL, QUESTION, SPACE, NL, CR, TAB];
const ATTRIB_VALUE_UNQUOTED_TERMINATOR: [i32; 7] = [SPACE, NL, CR, TAB, GREATER, AMP, LESS];

const FORBIDDEN_START: u8 = 0;
const FORBIDDEN_BRACKET: u8 = 1;
const FORBIDDEN_BRACKET_BRACKET: u8 = 2;

const XML_NAMESPACE: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE: &str = "http://www.w3.org/2000/xmlns/";

fn is_quote(c: i32) -> bool {
    c == DQUOTE || c == SQUOTE
}

// xmlchars `xml/1.0/ed5`
fn is_s(c: i32) -> bool {
    c == SPACE || c == NL || c == CR || c == TAB
}

fn is_char10(c: i32) -> bool {
    (SPACE..=0xD7FF).contains(&c)
        || c == NL
        || c == CR
        || c == TAB
        || (0xE000..=0xFFFD).contains(&c)
        || (0x10000..=0x10FFFF).contains(&c)
}

fn is_name_start_char(c: i32) -> bool {
    (0x41..=0x5A).contains(&c)
        || (0x61..=0x7A).contains(&c)
        || c == 0x3A
        || c == 0x5F
        || c == 0x200C
        || c == 0x200D
        || (0xC0..=0xD6).contains(&c)
        || (0xD8..=0xF6).contains(&c)
        || (0xF8..=0x2FF).contains(&c)
        || (0x370..=0x37D).contains(&c)
        || (0x37F..=0x1FFF).contains(&c)
        || (0x2070..=0x218F).contains(&c)
        || (0x2C00..=0x2FEF).contains(&c)
        || (0x3001..=0xD7FF).contains(&c)
        || (0xF900..=0xFDCF).contains(&c)
        || (0xFDF0..=0xFFFD).contains(&c)
        || (0x10000..=0xEFFFF).contains(&c)
}

fn is_name_char(c: i32) -> bool {
    is_name_start_char(c)
        || (0x30..=0x39).contains(&c)
        || c == 0x2D
        || c == 0x2E
        || c == 0xB7
        || (0x300..=0x36F).contains(&c)
        || (0x203F..=0x2040).contains(&c)
}

// xmlchars `xml/1.1/ed2`
fn is_char11(c: i32) -> bool {
    (0x1..=0xD7FF).contains(&c)
        || (0xE000..=0xFFFD).contains(&c)
        || (0x10000..=0x10FFFF).contains(&c)
}

// xmlchars `xmlns/1.0/ed3`
fn is_nc_name_start_char(c: i32) -> bool {
    (0x41..=0x5A).contains(&c)
        || c == 0x5F
        || (0x61..=0x7A).contains(&c)
        || (0xC0..=0xD6).contains(&c)
        || (0xD8..=0xF6).contains(&c)
        || (0xF8..=0x2FF).contains(&c)
        || (0x370..=0x37D).contains(&c)
        || (0x37F..=0x1FFF).contains(&c)
        || (0x200C..=0x200D).contains(&c)
        || (0x2070..=0x218F).contains(&c)
        || (0x2C00..=0x2FEF).contains(&c)
        || (0x3001..=0xD7FF).contains(&c)
        || (0xF900..=0xFDCF).contains(&c)
        || (0xFDF0..=0xFFFD).contains(&c)
        || (0x10000..=0xEFFFF).contains(&c)
}

fn is_nc_name_char(c: i32) -> bool {
    is_nc_name_start_char(c)
        || c == 0x2D
        || c == 0x2E
        || (0x30..=0x39).contains(&c)
        || c == 0xB7
        || (0x300..=0x36F).contains(&c)
        || (0x203F..=0x2040).contains(&c)
}

/// The code points of a string as a regular expression with the `u` flag
/// reads it: a pair is one, a lone surrogate is itself.
fn code_points(text: &[u16]) -> Vec<i32> {
    let mut out = Vec::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let unit = i32::from(text[at]);
        if (0xD800..=0xDBFF).contains(&unit)
            && at + 1 < text.len()
            && (0xDC00..=0xDFFF).contains(&i32::from(text[at + 1]))
        {
            out.push(0x10000 + ((unit - 0xD800) << 10) + (i32::from(text[at + 1]) - 0xDC00));
            at += 2;
        } else {
            out.push(unit);
            at += 1;
        }
    }
    out
}

type CharClass = fn(i32) -> bool;

/// `NAME_RE` (`xmlns`: `NC_NAME_RE`) of xmlchars.
fn matches_name(text: &[u16], xmlns: bool) -> bool {
    let points = code_points(text);
    let (start, rest): (CharClass, CharClass) = if xmlns {
        (is_nc_name_start_char, is_nc_name_char)
    } else {
        (is_name_start_char, is_name_char)
    };
    match points.split_first() {
        Some((first, tail)) => start(*first) && tail.iter().all(|c| rest(*c)),
        None => false,
    }
}

/// `String.fromCodePoint(c)` appended to `out`.
fn push_code_point(out: &mut Str, c: i32) -> Result<(), Error> {
    if c == NAN_CODE {
        return Err(Error::plain("RangeError", "Invalid code point NaN"));
    }
    if !(0..=0x10FFFF).contains(&c) {
        return Err(Error::plain(
            "RangeError",
            &format!("Invalid code point {c}"),
        ));
    }
    if c < 0x10000 {
        out.push(c as u16);
    } else {
        let offset = c - 0x10000;
        out.push(0xD800 + (offset >> 10) as u16);
        out.push(0xDC00 + (offset & 0x3FF) as u16);
    }
    Ok(())
}

/// A string of ASCII letters as the units of a JavaScript string.
fn eq(units: &[u16], ascii: &str) -> bool {
    units.len() == ascii.len()
        && units
            .iter()
            .zip(ascii.bytes())
            .all(|(a, b)| *a == u16::from(b))
}

fn concat(parts: &[&[u16]]) -> Str {
    parts.concat()
}

fn contains_units(haystack: &[u16], needle: &str) -> bool {
    let needle = units(needle);
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// `JSON.stringify(text)` for a string.
fn json_quote(text: &[u16]) -> Str {
    let mut out = units("\"");
    let mut at = 0;
    while at < text.len() {
        let unit = text[at];
        let paired = (0xD800..=0xDBFF).contains(&unit)
            && at + 1 < text.len()
            && (0xDC00..=0xDFFF).contains(&text[at + 1]);
        if paired {
            out.push(unit);
            out.push(text[at + 1]);
            at += 2;
            continue;
        }
        at += 1;
        match unit {
            0x22 => out.extend(units("\\\"")),
            0x5C => out.extend(units("\\\\")),
            0x08 => out.extend(units("\\b")),
            0x0C => out.extend(units("\\f")),
            0x0A => out.extend(units("\\n")),
            0x0D => out.extend(units("\\r")),
            0x09 => out.extend(units("\\t")),
            0..=0x1F | 0xD800..=0xDFFF => out.extend(units(&format!("\\u{unit:04x}"))),
            _ => out.push(unit),
        }
    }
    out.push(0x22);
    out
}

/// `/^1\.[0-9]+$/`
fn is_version_number(text: &[u16]) -> bool {
    text.len() >= 3
        && text[0] == u16::from(b'1')
        && text[1] == u16::from(b'.')
        && text[2..].iter().all(|u| (0x30..=0x39).contains(u))
}

/// `/^[A-Za-z][A-Za-z0-9._-]*$/`
fn is_encoding_name(text: &[u16]) -> bool {
    let letter = |u: u16| u8::try_from(u).is_ok_and(|b| b.is_ascii_alphabetic());
    match text.split_first() {
        Some((first, rest)) => {
            letter(*first)
                && rest.iter().all(|u| {
                    letter(*u)
                        || (0x30..=0x39).contains(u)
                        || *u == u16::from(b'.')
                        || *u == u16::from(b'_')
                        || *u == u16::from(b'-')
                })
        }
        None => false,
    }
}

/// `parseInt` of a string of digits, which stays above U+10FFFF once it is
/// beyond it.
fn parse_digits(digits: &[u16], radix: u64) -> u64 {
    digits.iter().fold(0u64, |number, unit| {
        let digit = char::from_u32(u32::from(*unit))
            .and_then(|c| c.to_digit(16))
            .map_or(0, u64::from);
        number.saturating_mul(radix).saturating_add(digit)
    })
}

/// `s.trim()`.
fn trim_units(text: &[u16]) -> &[u16] {
    let space = |u: &u16| char::from_u32(u32::from(*u)).is_some_and(jscompat::is_js_space);
    let start = text.iter().position(|u| !space(u)).unwrap_or(text.len());
    let end = text
        .iter()
        .rposition(|u| !space(u))
        .map_or(start, |i| i + 1);
    &text[start..end]
}

/// The messages `nsPairCheck` fails with, in the order it fails with them.
fn ns_pair_messages(prefix: &[u16], uri: &[u16]) -> Vec<String> {
    let mut out = Vec::new();
    if eq(prefix, "xml") {
        if !eq(uri, XML_NAMESPACE) {
            out.push(format!("xml prefix must be bound to {XML_NAMESPACE}."));
        }
    } else if eq(prefix, "xmlns") && !eq(uri, XMLNS_NAMESPACE) {
        out.push(format!("xmlns prefix must be bound to {XMLNS_NAMESPACE}."));
    }
    if eq(uri, XMLNS_NAMESPACE) {
        out.push(if prefix.is_empty() {
            format!(
                "the default namespace may not be set to {uri}.",
                uri = XMLNS_NAMESPACE
            )
        } else {
            format!("may not assign a prefix (even \"xmlns\") to the URI {XMLNS_NAMESPACE}.")
        });
    } else if eq(uri, XML_NAMESPACE) {
        if eq(prefix, "xml") {
        } else if prefix.is_empty() {
            out.push(format!(
                "the default namespace may not be set to {XML_NAMESPACE}."
            ));
        } else {
            out.push("may not assign the xml namespace to another prefix.".to_owned());
        }
    }
    out
}

/// `makeError`, with a line and column that are `undefined` before `_init` ran.
fn make_error(
    file_name: Option<&[u16]>,
    track_position: bool,
    line_column: Option<(i64, i64)>,
    message: &[u16],
) -> Error {
    let mut msg: Str = file_name.map(<[u16]>::to_vec).unwrap_or_default();
    if track_position {
        if !msg.is_empty() {
            msg.push(u16::from(b':'));
        }
        let position = match line_column {
            Some((line, column)) => format!("{line}:{column}"),
            None => "undefined:undefined".to_owned(),
        };
        msg.extend(units(&position));
    }
    if !msg.is_empty() {
        msg.extend(units(": "));
    }
    msg.extend_from_slice(message);
    Error {
        name: "Error",
        message: msg,
    }
}

pub struct Parser {
    // options
    fragment_opt: bool,
    xmlns_opt: bool,
    track_position: bool,
    file_name: Option<Str>,
    force_xml_version: bool,
    default_xml_version: Option<Str>,
    resolve_prefix: Option<ResolvePrefix>,
    ns: Ns,
    // whether the handler has a `text` or an `error` handler
    text_handler: bool,
    error_handler: bool,
    // errors `fail` raised inside a handler, to be delivered when it returns
    pending: VecDeque<Error>,

    open_waka_bang: Str,
    text: Str,
    name: Str,
    pi_target: Str,
    entity: Str,
    q: Option<i32>,
    tags: Vec<Tag>,
    tag: Option<Tag>,
    top_ns: Option<Ns>,
    chunk: Vec<u16>,
    chunk_position: i64,
    i: usize,
    prev_i: usize,
    carried_from_previous: Option<u16>,
    forbidden_state: u8,
    attrib_list: Vec<Attribute>,
    state: u8,
    reported_text_before_root: bool,
    reported_text_after_root: bool,
    closed_root: bool,
    saw_root: bool,
    xml_decl_possible: bool,
    xml_decl_expects: Vec<&'static str>,
    entity_return_state: u8,
    position_at_new_line: i64,
    doctype: bool,
    closed: bool,
    xml_decl: XmlDecl,
    line: i64,
    column: i64,
    current_xml_version: Str,
    xml10: bool,
}

impl Parser {
    /// `new SaxesParser(opt)`. Fails as the constructor throws: a bad
    /// `additionalNamespaces` entry, or `forceXMLVersion` without a
    /// `defaultXMLVersion`.
    pub fn new(opt: Options) -> Result<Parser, Error> {
        let mut ns = Ns::default();
        if opt.xmlns {
            ns.set(units("xml"), units(XML_NAMESPACE));
            ns.set(units("xmlns"), units(XMLNS_NAMESPACE));
            if let Some(additional) = &opt.additional_namespaces {
                for (local, uri) in additional {
                    if let Some(message) = ns_pair_messages(local, uri).first() {
                        // no error handler yet, so fail throws; line and column are not set
                        return Err(make_error(
                            opt.file_name.as_deref(),
                            opt.position,
                            None,
                            &units(message),
                        ));
                    }
                }
                for (local, uri) in additional {
                    ns.set(local.clone(), uri.clone());
                }
            }
        }
        let mut parser = Parser {
            fragment_opt: opt.fragment,
            xmlns_opt: opt.xmlns,
            track_position: opt.position,
            file_name: opt.file_name,
            force_xml_version: opt.force_xml_version,
            default_xml_version: opt.default_xml_version,
            resolve_prefix: opt.resolve_prefix,
            ns,
            text_handler: false,
            error_handler: false,
            pending: VecDeque::new(),
            open_waka_bang: Str::new(),
            text: Str::new(),
            name: Str::new(),
            pi_target: Str::new(),
            entity: Str::new(),
            q: None,
            tags: Vec::new(),
            tag: None,
            top_ns: None,
            chunk: Vec::new(),
            chunk_position: 0,
            i: 0,
            prev_i: 0,
            carried_from_previous: None,
            forbidden_state: FORBIDDEN_START,
            attrib_list: Vec::new(),
            state: S_BEGIN,
            reported_text_before_root: false,
            reported_text_after_root: false,
            closed_root: false,
            saw_root: false,
            xml_decl_possible: false,
            xml_decl_expects: Vec::new(),
            entity_return_state: S_TEXT,
            position_at_new_line: 0,
            doctype: false,
            closed: false,
            xml_decl: XmlDecl::default(),
            line: 1,
            column: 0,
            current_xml_version: units("1.0"),
            xml10: true,
        };
        parser.init()?;
        Ok(parser)
    }

    /// `_init` without the `ready` event.
    fn init(&mut self) -> Result<(), Error> {
        self.open_waka_bang.clear();
        self.text.clear();
        self.name.clear();
        self.pi_target.clear();
        self.entity.clear();
        self.q = None;
        self.tags.clear();
        self.tag = None;
        self.top_ns = None;
        self.chunk.clear();
        self.chunk_position = 0;
        self.i = 0;
        self.prev_i = 0;
        self.carried_from_previous = None;
        self.forbidden_state = FORBIDDEN_START;
        self.attrib_list.clear();
        let fragment = self.fragment_opt;
        self.state = if fragment { S_TEXT } else { S_BEGIN };
        self.reported_text_before_root = fragment;
        self.reported_text_after_root = fragment;
        self.closed_root = fragment;
        self.saw_root = fragment;
        self.xml_decl_possible = !fragment;
        self.xml_decl_expects = vec!["version"];
        self.entity_return_state = S_TEXT;
        let version = match &self.default_xml_version {
            Some(version) => version.clone(),
            None => {
                if self.force_xml_version {
                    return Err(Error::plain(
                        "Error",
                        "forceXMLVersion set but defaultXMLVersion is not set",
                    ));
                }
                units("1.0")
            }
        };
        self.set_xml_version(version);
        self.position_at_new_line = 0;
        self.doctype = false;
        self.closed = false;
        self.xml_decl = XmlDecl::default();
        self.line = 1;
        self.column = 0;
        Ok(())
    }

    /// `_init` as `end` runs it: the `ready` event follows.
    fn reinit(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        self.init()?;
        h.ready(self)?;
        self.flush(h)
    }

    /// Indicates whether or not the parser is closed.
    pub fn closed(&self) -> bool {
        self.closed
    }

    /// The stream position the parser is currently looking at, in UTF-16
    /// units.
    pub fn position(&self) -> i64 {
        self.chunk_position + self.i as i64
    }

    pub fn line(&self) -> i64 {
        self.line
    }

    pub fn column(&self) -> i64 {
        self.column
    }

    pub fn column_index(&self) -> i64 {
        self.position() - self.position_at_new_line
    }

    fn sync_handler(&mut self, h: &dyn Handler) {
        self.text_handler = h.wants_text();
        self.error_handler = h.wants_error();
    }

    fn error_for(&self, message: &[u16]) -> Error {
        make_error(
            self.file_name.as_deref(),
            self.track_position,
            Some((self.line, self.column)),
            message,
        )
    }

    /// `makeError`.
    pub fn make_error(&self, message: &[u16]) -> Error {
        self.error_for(message)
    }

    /// `parser.fail(message)` called from inside a handler. With an `error`
    /// handler the event is delivered when the handler returns; without one
    /// the error is returned, as JavaScript throws it.
    pub fn fail(&mut self, message: &[u16]) -> Result<(), Error> {
        let error = self.error_for(message);
        if !self.error_handler {
            return Err(error);
        }
        self.pending.push_back(error);
        Ok(())
    }

    pub fn fail_str(&mut self, message: &str) -> Result<(), Error> {
        self.fail(&units(message))
    }

    /// `parser.fail(message)` called from outside a handler: the error event
    /// is delivered at once.
    pub fn fail_with(&mut self, h: &mut dyn Handler, message: &[u16]) -> Result<(), Error> {
        self.sync_handler(h);
        self.fail_units(h, message)
    }

    /// Delivers the errors a handler raised with [`Parser::fail`].
    fn flush(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        while !self.pending.is_empty() {
            let errors: Vec<Error> = self.pending.drain(..).collect();
            for error in errors {
                h.error(self, &error)?;
            }
        }
        Ok(())
    }

    fn fail_units(&mut self, h: &mut dyn Handler, message: &[u16]) -> Result<(), Error> {
        let error = self.error_for(message);
        if !self.error_handler {
            return Err(error);
        }
        h.error(self, &error)?;
        self.flush(h)
    }

    fn fail_to(&mut self, h: &mut dyn Handler, message: &str) -> Result<(), Error> {
        self.fail_units(h, &units(message))
    }

    /// Write XML data to the parser.
    pub fn write(&mut self, h: &mut dyn Handler, chunk: &[u16]) -> Result<(), Error> {
        self.write_inner(h, Some(chunk))
    }

    pub fn write_str(&mut self, h: &mut dyn Handler, chunk: &str) -> Result<(), Error> {
        self.write(h, &units(chunk))
    }

    /// `write(null)`: final well-formedness checks, then the parser is reset.
    pub fn close(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        self.write_inner(h, None)
    }

    fn write_inner(&mut self, h: &mut dyn Handler, given: Option<&[u16]>) -> Result<(), Error> {
        self.sync_handler(h);
        if self.closed {
            return self.fail_to(h, "cannot write after close; assign an onready handler.");
        }
        let end = given.is_none();
        let mut chunk: Vec<u16> = given.map(<[u16]>::to_vec).unwrap_or_default();
        if let Some(carried) = self.carried_from_previous.take() {
            chunk.insert(0, carried);
        }
        let mut limit = chunk.len();
        let last = if limit > 0 { chunk[limit - 1] } else { 0 };
        if !end && limit > 0 && (last == CR as u16 || (0xD800..=0xDBFF).contains(&last)) {
            self.carried_from_previous = Some(last);
            limit -= 1;
            chunk.truncate(limit);
        }
        self.chunk = chunk;
        self.i = 0;
        while self.i < limit {
            self.dispatch(h)?;
        }
        self.chunk_position += limit as i64;
        if end { self.end(h) } else { Ok(()) }
    }

    fn dispatch(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        match self.state {
            S_BEGIN => self.s_begin(),
            S_BEGIN_WHITESPACE => self.s_begin_whitespace(h),
            S_DOCTYPE => self.s_doctype(h),
            S_DOCTYPE_QUOTE => self.s_doctype_quote(h),
            S_DTD => self.s_dtd(h),
            S_DTD_QUOTED => self.s_dtd_quoted(h),
            S_DTD_OPEN_WAKA => self.s_dtd_open_waka(h),
            S_DTD_OPEN_WAKA_BANG => self.s_dtd_open_waka_bang(h),
            S_DTD_COMMENT => self.s_dtd_comment(h),
            S_DTD_COMMENT_ENDING => self.s_dtd_comment_ending(h),
            S_DTD_COMMENT_ENDED => self.s_dtd_comment_ended(h),
            S_DTD_PI => self.s_dtd_pi(h),
            S_DTD_PI_ENDING => self.s_dtd_pi_ending(h),
            S_TEXT => self.s_text(h),
            S_ENTITY => self.s_entity(h),
            S_OPEN_WAKA => self.s_open_waka(h),
            S_OPEN_WAKA_BANG => self.s_open_waka_bang(h),
            S_COMMENT => self.s_comment(h),
            S_COMMENT_ENDING => self.s_comment_ending(h),
            S_COMMENT_ENDED => self.s_comment_ended(h),
            S_CDATA => self.s_cdata(h),
            S_CDATA_ENDING => self.s_cdata_ending(h),
            S_CDATA_ENDING_2 => self.s_cdata_ending_2(h),
            S_PI_FIRST_CHAR => self.s_pi_first_char(h),
            S_PI_REST => self.s_pi_rest(h),
            S_PI_BODY => self.s_pi_body(h),
            S_PI_ENDING => self.s_pi_ending(h),
            S_XML_DECL_NAME_START => self.s_xml_decl_name_start(h),
            S_XML_DECL_NAME => self.s_xml_decl_name(h),
            S_XML_DECL_EQ => self.s_xml_decl_eq(h),
            S_XML_DECL_VALUE_START => self.s_xml_decl_value_start(h),
            S_XML_DECL_VALUE => self.s_xml_decl_value(h),
            S_XML_DECL_SEPARATOR => self.s_xml_decl_separator(h),
            S_XML_DECL_ENDING => self.s_xml_decl_ending(h),
            S_OPEN_TAG => self.s_open_tag(h),
            S_OPEN_TAG_SLASH => self.s_open_tag_slash(h),
            S_ATTRIB => self.s_attrib(h),
            S_ATTRIB_NAME => self.s_attrib_name(h),
            S_ATTRIB_NAME_SAW_WHITE => self.s_attrib_name_saw_white(h),
            S_ATTRIB_VALUE => self.s_attrib_value(h),
            S_ATTRIB_VALUE_QUOTED => self.s_attrib_value_quoted(h),
            S_ATTRIB_VALUE_CLOSED => self.s_attrib_value_closed(h),
            S_ATTRIB_VALUE_UNQUOTED => self.s_attrib_value_unquoted(h),
            S_CLOSE_TAG => self.s_close_tag(h),
            S_CLOSE_TAG_SAW_WHITE => self.s_close_tag_saw_white(h),
            _ => unreachable!("every state number has a handler"),
        }
    }

    /// `chunk.slice(start, end)` of the current chunk.
    fn slice_range(&self, start: usize, end: usize) -> (usize, usize) {
        let length = self.chunk.len();
        let start = start.min(length);
        let end = end.min(length);
        if start >= end { (0, 0) } else { (start, end) }
    }

    /// `this.text += chunk.slice(start, end)`
    fn text_append(&mut self, start: usize, end: usize) {
        let (a, b) = self.slice_range(start, end);
        self.text.extend_from_slice(&self.chunk[a..b]);
    }

    fn name_append(&mut self, start: usize, end: usize) {
        let (a, b) = self.slice_range(start, end);
        self.name.extend_from_slice(&self.chunk[a..b]);
    }

    fn entity_append(&mut self, start: usize, end: usize) {
        let (a, b) = self.slice_range(start, end);
        self.entity.extend_from_slice(&self.chunk[a..b]);
    }

    fn pi_target_append(&mut self, start: usize, end: usize) {
        let (a, b) = self.slice_range(start, end);
        self.pi_target.extend_from_slice(&self.chunk[a..b]);
    }

    fn chunk_slice(&self, start: usize, end: usize) -> Str {
        let (a, b) = self.slice_range(start, end);
        self.chunk[a..b].to_vec()
    }

    /// Get a single code point out of the current chunk (`getCode10`,
    /// `getCode11`), updating the position.
    fn get_code(&mut self, h: &mut dyn Handler) -> Result<i32, Error> {
        let i = self.i;
        self.prev_i = i;
        self.i = i + 1;
        if i >= self.chunk.len() {
            return Ok(EOC);
        }
        let code = i32::from(self.chunk[i]);
        self.column += 1;
        if code < 0xD800 {
            if self.xml10 {
                if code >= SPACE || code == TAB {
                    return Ok(code);
                }
                match code {
                    NL => {
                        self.line += 1;
                        self.column = 0;
                        self.position_at_new_line = self.position();
                        Ok(NL)
                    }
                    CR => {
                        if self.chunk.get(i + 1) == Some(&(NL as u16)) {
                            self.i = i + 2;
                        }
                        self.line += 1;
                        self.column = 0;
                        self.position_at_new_line = self.position();
                        Ok(NL_LIKE)
                    }
                    _ => {
                        self.fail_to(h, "disallowed character.")?;
                        Ok(code)
                    }
                }
            } else {
                if (code > 0x1F && code < 0x7F) || (code > 0x9F && code != LS) || code == TAB {
                    return Ok(code);
                }
                match code {
                    NL => {
                        self.line += 1;
                        self.column = 0;
                        self.position_at_new_line = self.position();
                        Ok(NL)
                    }
                    CR | NEL | LS => {
                        if code == CR {
                            let next = self.chunk.get(i + 1).map(|u| i32::from(*u));
                            if next == Some(NL) || next == Some(NEL) {
                                self.i = i + 2;
                            }
                        }
                        self.line += 1;
                        self.column = 0;
                        self.position_at_new_line = self.position();
                        Ok(NL_LIKE)
                    }
                    _ => {
                        self.fail_to(h, "disallowed character.")?;
                        Ok(code)
                    }
                }
            }
        } else if code > 0xDBFF {
            if !(0xE000..=0xFFFD).contains(&code) {
                self.fail_to(h, "disallowed character.")?;
            }
            Ok(code)
        } else {
            let Some(next) = self.chunk.get(i + 1).map(|u| i32::from(*u)) else {
                // 0x10000 + ... + (NaN - 0xDC00)
                self.i = i + 2;
                return Ok(NAN_CODE);
            };
            let last = 0x10000 + ((code - 0xD800) * 0x400) + (next - 0xDC00);
            self.i = i + 2;
            if last > 0x10FFFF {
                self.fail_to(h, "disallowed character.")?;
            }
            Ok(last)
        }
    }

    /// `getCode` with `NL` returned for `NL_LIKE`.
    fn get_code_norm(&mut self, h: &mut dyn Handler) -> Result<i32, Error> {
        let c = self.get_code(h)?;
        Ok(if c == NL_LIKE { NL } else { c })
    }

    fn unget(&mut self) {
        self.i = self.prev_i;
        self.column -= 1;
    }

    /// Capture characters into `text` until one of `chars` (or the end of the
    /// chunk, `EOC`) is read.
    fn capture_to(&mut self, h: &mut dyn Handler, chars: &[i32]) -> Result<i32, Error> {
        let mut start = self.i;
        loop {
            let c = self.get_code(h)?;
            let is_nl_like = c == NL_LIKE;
            let last = if is_nl_like { NL } else { c };
            if last == EOC || chars.contains(&last) {
                self.text_append(start, self.prev_i);
                return Ok(last);
            }
            if is_nl_like {
                self.text_append(start, self.prev_i);
                self.text.push(NL as u16);
                start = self.i;
            }
        }
    }

    /// Capture characters into `text` until `char`; `false` at the end of the
    /// chunk.
    fn capture_to_char(&mut self, h: &mut dyn Handler, char: i32) -> Result<bool, Error> {
        let mut start = self.i;
        loop {
            let mut c = self.get_code(h)?;
            match c {
                NL_LIKE => {
                    self.text_append(start, self.prev_i);
                    self.text.push(NL as u16);
                    start = self.i;
                    c = NL;
                }
                EOC => {
                    self.text_append(start, usize::MAX);
                    return Ok(false);
                }
                _ => {}
            }
            if c == char {
                self.text_append(start, self.prev_i);
                return Ok(true);
            }
        }
    }

    /// Capture `isNameChar` characters into `name`; the character that made
    /// the test fail, or `EOC`.
    fn capture_name_chars(&mut self, h: &mut dyn Handler) -> Result<i32, Error> {
        let start = self.i;
        loop {
            let c = self.get_code(h)?;
            if c == EOC {
                self.name_append(start, usize::MAX);
                return Ok(EOC);
            }
            if !is_name_char(c) {
                self.name_append(start, self.prev_i);
                return Ok(if c == NL_LIKE { NL } else { c });
            }
        }
    }

    fn skip_spaces(&mut self, h: &mut dyn Handler) -> Result<i32, Error> {
        loop {
            let c = self.get_code_norm(h)?;
            if c == EOC || !is_s(c) {
                return Ok(c);
            }
        }
    }

    fn set_xml_version(&mut self, version: Str) {
        self.xml10 = eq(&version, "1.0");
        self.current_xml_version = version;
    }

    fn is_char(&self, num: Option<u64>) -> bool {
        match num {
            Some(n) if n <= 0x10FFFF => {
                if self.xml10 {
                    is_char10(n as i32)
                } else {
                    is_char11(n as i32)
                }
            }
            _ => false,
        }
    }

    fn name_start_check(&self, c: i32) -> bool {
        if self.xmlns_opt {
            is_nc_name_start_char(c)
        } else {
            is_name_start_char(c)
        }
    }

    fn name_check(&self, c: i32) -> bool {
        if self.xmlns_opt {
            is_nc_name_char(c)
        } else {
            is_name_char(c)
        }
    }

    // STATE ENGINE METHODS

    fn s_begin(&mut self) -> Result<(), Error> {
        if self.chunk.first() == Some(&0xFEFF) {
            self.i += 1;
            self.column += 1;
        }
        self.state = S_BEGIN_WHITESPACE;
        Ok(())
    }

    fn s_begin_whitespace(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let i_before = self.i;
        let c = self.skip_spaces(h)?;
        if self.prev_i != i_before {
            self.xml_decl_possible = false;
        }
        match c {
            LESS => {
                self.state = S_OPEN_WAKA;
                if !self.text.is_empty() {
                    return Err(Error::plain("Error", "no-empty text at start"));
                }
            }
            EOC => {}
            _ => {
                self.unget();
                self.state = S_TEXT;
                self.xml_decl_possible = false;
            }
        }
        Ok(())
    }

    fn s_doctype(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.capture_to(h, &DOCTYPE_TERMINATOR)?;
        match c {
            GREATER => {
                let text = self.text.clone();
                h.doctype(self, &text)?;
                self.flush(h)?;
                self.text.clear();
                self.state = S_TEXT;
                self.doctype = true;
            }
            EOC => {}
            _ => {
                push_code_point(&mut self.text, c)?;
                if c == OPEN_BRACKET {
                    self.state = S_DTD;
                } else if is_quote(c) {
                    self.state = S_DOCTYPE_QUOTE;
                    self.q = Some(c);
                }
            }
        }
        Ok(())
    }

    fn s_doctype_quote(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let q = self.q.unwrap_or(NO_CHAR);
        if self.capture_to_char(h, q)? {
            push_code_point(&mut self.text, q)?;
            self.q = None;
            self.state = S_DOCTYPE;
        }
        Ok(())
    }

    fn s_dtd(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.capture_to(h, &DTD_TERMINATOR)?;
        if c == EOC {
            return Ok(());
        }
        push_code_point(&mut self.text, c)?;
        if c == CLOSE_BRACKET {
            self.state = S_DOCTYPE;
        } else if c == LESS {
            self.state = S_DTD_OPEN_WAKA;
        } else if is_quote(c) {
            self.state = S_DTD_QUOTED;
            self.q = Some(c);
        }
        Ok(())
    }

    fn s_dtd_quoted(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let q = self.q.unwrap_or(NO_CHAR);
        if self.capture_to_char(h, q)? {
            push_code_point(&mut self.text, q)?;
            self.state = S_DTD;
            self.q = None;
        }
        Ok(())
    }

    fn s_dtd_open_waka(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        push_code_point(&mut self.text, c)?;
        match c {
            BANG => {
                self.state = S_DTD_OPEN_WAKA_BANG;
                self.open_waka_bang.clear();
            }
            QUESTION => self.state = S_DTD_PI,
            _ => self.state = S_DTD,
        }
        Ok(())
    }

    fn s_dtd_open_waka_bang(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        let mut char = Str::new();
        push_code_point(&mut char, c)?;
        self.open_waka_bang.extend_from_slice(&char);
        self.text.extend_from_slice(&char);
        if !eq(&self.open_waka_bang, "-") {
            self.state = if eq(&self.open_waka_bang, "--") {
                S_DTD_COMMENT
            } else {
                S_DTD
            };
            self.open_waka_bang.clear();
        }
        Ok(())
    }

    fn s_dtd_comment(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        if self.capture_to_char(h, MINUS)? {
            self.text.push(MINUS as u16);
            self.state = S_DTD_COMMENT_ENDING;
        }
        Ok(())
    }

    fn s_dtd_comment_ending(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        push_code_point(&mut self.text, c)?;
        self.state = if c == MINUS {
            S_DTD_COMMENT_ENDED
        } else {
            S_DTD_COMMENT
        };
        Ok(())
    }

    fn s_dtd_comment_ended(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        push_code_point(&mut self.text, c)?;
        if c == GREATER {
            self.state = S_DTD;
        } else {
            self.fail_to(h, "malformed comment.")?;
            self.state = S_DTD_COMMENT;
        }
        Ok(())
    }

    fn s_dtd_pi(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        if self.capture_to_char(h, QUESTION)? {
            self.text.push(QUESTION as u16);
            self.state = S_DTD_PI_ENDING;
        }
        Ok(())
    }

    fn s_dtd_pi_ending(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        push_code_point(&mut self.text, c)?;
        if c == GREATER {
            self.state = S_DTD;
        }
        Ok(())
    }

    fn s_text(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        if !self.tags.is_empty() {
            self.handle_text_in_root(h)
        } else {
            self.handle_text_outside_root(h)
        }
    }

    fn s_entity(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let mut start = self.i;
        loop {
            match self.get_code(h)? {
                NL_LIKE => {
                    self.entity_append(start, self.prev_i);
                    self.entity.push(NL as u16);
                    start = self.i;
                }
                SEMICOLON => {
                    let entity_return_state = self.entity_return_state;
                    let mut entity = std::mem::take(&mut self.entity);
                    let (a, b) = self.slice_range(start, self.prev_i);
                    entity.extend_from_slice(&self.chunk[a..b]);
                    self.state = entity_return_state;
                    let parsed;
                    if entity.is_empty() {
                        self.fail_to(h, "empty entity name.")?;
                        parsed = units("&;");
                    } else {
                        parsed = self.parse_entity(h, &entity)?;
                        self.entity.clear();
                    }
                    if entity_return_state != S_TEXT || self.text_handler {
                        self.text.extend_from_slice(&parsed);
                    }
                    break;
                }
                EOC => {
                    self.entity_append(start, usize::MAX);
                    break;
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn s_open_waka(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code(h)?;
        if is_name_start_char(c) {
            self.state = S_OPEN_TAG;
            self.unget();
            self.xml_decl_possible = false;
        } else {
            match c {
                FORWARD_SLASH => {
                    self.state = S_CLOSE_TAG;
                    self.xml_decl_possible = false;
                }
                BANG => {
                    self.state = S_OPEN_WAKA_BANG;
                    self.open_waka_bang.clear();
                    self.xml_decl_possible = false;
                }
                QUESTION => self.state = S_PI_FIRST_CHAR,
                _ => {
                    self.fail_to(h, "disallowed character in tag name")?;
                    self.state = S_TEXT;
                    self.xml_decl_possible = false;
                }
            }
        }
        Ok(())
    }

    fn s_open_waka_bang(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        push_code_point(&mut self.open_waka_bang, c)?;
        if eq(&self.open_waka_bang, "[CDATA[") {
            if !self.saw_root && !self.reported_text_before_root {
                self.fail_to(h, "text data outside of root node.")?;
                self.reported_text_before_root = true;
            }
            if self.closed_root && !self.reported_text_after_root {
                self.fail_to(h, "text data outside of root node.")?;
                self.reported_text_after_root = true;
            }
            self.state = S_CDATA;
            self.open_waka_bang.clear();
        } else if eq(&self.open_waka_bang, "--") {
            self.state = S_COMMENT;
            self.open_waka_bang.clear();
        } else if eq(&self.open_waka_bang, "DOCTYPE") {
            self.state = S_DOCTYPE;
            if self.doctype || self.saw_root {
                self.fail_to(h, "inappropriately located doctype declaration.")?;
            }
            self.open_waka_bang.clear();
        } else if self.open_waka_bang.len() >= 7 {
            // 7 happens to be the maximum length of the string that can possibly
            // match one of the cases above.
            self.fail_to(h, "incorrect syntax.")?;
        }
        Ok(())
    }

    fn s_comment(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        if self.capture_to_char(h, MINUS)? {
            self.state = S_COMMENT_ENDING;
        }
        Ok(())
    }

    fn s_comment_ending(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        if c == MINUS {
            self.state = S_COMMENT_ENDED;
            let text = self.text.clone();
            h.comment(self, &text)?;
            self.flush(h)?;
            self.text.clear();
        } else {
            self.text.push(MINUS as u16);
            push_code_point(&mut self.text, c)?;
            self.state = S_COMMENT;
        }
        Ok(())
    }

    fn s_comment_ended(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        if c != GREATER {
            self.fail_to(h, "malformed comment.")?;
            self.text.extend(units("--"));
            push_code_point(&mut self.text, c)?;
            self.state = S_COMMENT;
        } else {
            self.state = S_TEXT;
        }
        Ok(())
    }

    fn s_cdata(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        if self.capture_to_char(h, CLOSE_BRACKET)? {
            self.state = S_CDATA_ENDING;
        }
        Ok(())
    }

    fn s_cdata_ending(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        if c == CLOSE_BRACKET {
            self.state = S_CDATA_ENDING_2;
        } else {
            self.text.push(CLOSE_BRACKET as u16);
            push_code_point(&mut self.text, c)?;
            self.state = S_CDATA;
        }
        Ok(())
    }

    fn s_cdata_ending_2(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        match c {
            GREATER => {
                let text = self.text.clone();
                h.cdata(self, &text)?;
                self.flush(h)?;
                self.text.clear();
                self.state = S_TEXT;
            }
            CLOSE_BRACKET => self.text.push(CLOSE_BRACKET as u16),
            _ => {
                self.text.extend(units("]]"));
                push_code_point(&mut self.text, c)?;
                self.state = S_CDATA;
            }
        }
        Ok(())
    }

    // We need this separate state to check the first character of the pi target
    // with this.nameStartCheck which allows less characters than this.nameCheck.
    fn s_pi_first_char(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        if self.name_start_check(c) {
            push_code_point(&mut self.pi_target, c)?;
            self.state = S_PI_REST;
        } else if c == QUESTION || is_s(c) {
            self.fail_to(h, "processing instruction without a target.")?;
            self.state = if c == QUESTION {
                S_PI_ENDING
            } else {
                S_PI_BODY
            };
        } else {
            self.fail_to(h, "disallowed character in processing instruction name.")?;
            push_code_point(&mut self.pi_target, c)?;
            self.state = S_PI_REST;
        }
        Ok(())
    }

    fn s_pi_rest(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let start = self.i;
        loop {
            let c = self.get_code_norm(h)?;
            if c == EOC {
                self.pi_target_append(start, usize::MAX);
                return Ok(());
            }
            if !self.name_check(c) {
                self.pi_target_append(start, self.prev_i);
                let is_question = c == QUESTION;
                if is_question || is_s(c) {
                    if eq(&self.pi_target, "xml") {
                        if !self.xml_decl_possible {
                            self.fail_to(
                                h,
                                "an XML declaration must be at the start of the document.",
                            )?;
                        }
                        self.state = if is_question {
                            S_XML_DECL_ENDING
                        } else {
                            S_XML_DECL_NAME_START
                        };
                    } else {
                        self.state = if is_question { S_PI_ENDING } else { S_PI_BODY };
                    }
                } else {
                    self.fail_to(h, "disallowed character in processing instruction name.")?;
                    push_code_point(&mut self.pi_target, c)?;
                }
                break;
            }
        }
        Ok(())
    }

    fn s_pi_body(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        if self.text.is_empty() {
            let c = self.get_code_norm(h)?;
            if c == QUESTION {
                self.state = S_PI_ENDING;
            } else if !is_s(c) {
                self.text.clear();
                push_code_point(&mut self.text, c)?;
            }
        }
        // The question mark character is not valid inside any of the XML
        // declaration name/value pairs.
        else if self.capture_to_char(h, QUESTION)? {
            self.state = S_PI_ENDING;
        }
        Ok(())
    }

    fn s_pi_ending(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        if c == GREATER {
            let pi_target = self.pi_target.clone();
            if pi_target.len() == 3
                && pi_target.iter().zip("xml".bytes()).all(|(unit, lower)| {
                    *unit == u16::from(lower) || *unit == u16::from(lower - 32)
                })
            {
                self.fail_to(
                    h,
                    "the XML declaration must appear at the start of the document.",
                )?;
            }
            let body = self.text.clone();
            h.processinginstruction(self, &pi_target, &body)?;
            self.flush(h)?;
            self.pi_target.clear();
            self.text.clear();
            self.state = S_TEXT;
        } else if c == QUESTION {
            // We ran into ?? as part of a processing instruction. We initially took
            // the first ? as a sign that the PI was ending, but it is not. So we have
            // to add it to the body but we take the new ? as a sign that the PI is
            // ending.
            self.text.push(QUESTION as u16);
        } else {
            self.text.push(QUESTION as u16);
            push_code_point(&mut self.text, c)?;
            self.state = S_PI_BODY;
        }
        self.xml_decl_possible = false;
        Ok(())
    }

    fn s_xml_decl_name_start(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.skip_spaces(h)?;
        // The question mark character is not valid inside any of the XML
        // declaration name/value pairs.
        if c == QUESTION {
            // It is valid to go to S_XML_DECL_ENDING from this state.
            self.state = S_XML_DECL_ENDING;
            return Ok(());
        }
        if c != EOC {
            self.state = S_XML_DECL_NAME;
            self.name.clear();
            push_code_point(&mut self.name, c)?;
        }
        Ok(())
    }

    fn s_xml_decl_name(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.capture_to(h, &XML_DECL_NAME_TERMINATOR)?;
        // The question mark character is not valid inside any of the XML
        // declaration name/value pairs.
        if c == QUESTION {
            self.state = S_XML_DECL_ENDING;
            let text = std::mem::take(&mut self.text);
            self.name.extend_from_slice(&text);
            self.fail_to(h, "XML declaration is incomplete.")?;
            return Ok(());
        }
        if !(is_s(c) || c == EQUAL) {
            return Ok(());
        }
        let text = std::mem::take(&mut self.text);
        self.name.extend_from_slice(&text);
        if !self
            .xml_decl_expects
            .iter()
            .any(|name| eq(&self.name, name))
        {
            match self.name.len() {
                0 => self.fail_to(h, "did not expect any more name/value pairs.")?,
                1 => {
                    let expected = self
                        .xml_decl_expects
                        .first()
                        .copied()
                        .unwrap_or("undefined");
                    self.fail_to(h, &format!("expected the name {expected}."))?;
                }
                _ => {
                    let expected = self.xml_decl_expects.join(", ");
                    self.fail_to(h, &format!("expected one of {expected}"))?;
                }
            }
        }
        self.state = if c == EQUAL {
            S_XML_DECL_VALUE_START
        } else {
            S_XML_DECL_EQ
        };
        Ok(())
    }

    fn s_xml_decl_eq(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        // The question mark character is not valid inside any of the XML
        // declaration name/value pairs.
        if c == QUESTION {
            self.state = S_XML_DECL_ENDING;
            self.fail_to(h, "XML declaration is incomplete.")?;
            return Ok(());
        }
        if is_s(c) {
            return Ok(());
        }
        if c != EQUAL {
            self.fail_to(h, "value required.")?;
        }
        self.state = S_XML_DECL_VALUE_START;
        Ok(())
    }

    fn s_xml_decl_value_start(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        // The question mark character is not valid inside any of the XML
        // declaration name/value pairs.
        if c == QUESTION {
            self.state = S_XML_DECL_ENDING;
            self.fail_to(h, "XML declaration is incomplete.")?;
            return Ok(());
        }
        if is_s(c) {
            return Ok(());
        }
        if !is_quote(c) {
            self.fail_to(h, "value must be quoted.")?;
            self.q = Some(SPACE);
        } else {
            self.q = Some(c);
        }
        self.state = S_XML_DECL_VALUE;
        Ok(())
    }

    fn s_xml_decl_value(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let q = self.q.unwrap_or(NO_CHAR);
        let c = self.capture_to(h, &[q, QUESTION])?;
        // The question mark character is not valid inside any of the XML
        // declaration name/value pairs.
        if c == QUESTION {
            self.state = S_XML_DECL_ENDING;
            self.text.clear();
            self.fail_to(h, "XML declaration is incomplete.")?;
            return Ok(());
        }
        if c == EOC {
            return Ok(());
        }
        let value = std::mem::take(&mut self.text);
        if eq(&self.name, "version") {
            self.xml_decl_expects = vec!["encoding", "standalone"];
            self.xml_decl.version = Some(value.clone());
            // This is the test specified by XML 1.0 but it is fine for XML 1.1.
            if !is_version_number(&value) {
                self.fail_to(h, "version number must match /^1\\.[0-9]+$/.")?;
            }
            // When forceXMLVersion is set, the XML declaration is ignored.
            else if !self.force_xml_version {
                self.set_xml_version(value);
            }
        } else if eq(&self.name, "encoding") {
            if !is_encoding_name(&value) {
                self.fail_to(
                    h,
                    "encoding value must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/.",
                )?;
            }
            self.xml_decl_expects = vec!["standalone"];
            self.xml_decl.encoding = Some(value);
        } else if eq(&self.name, "standalone") {
            if !eq(&value, "yes") && !eq(&value, "no") {
                self.fail_to(h, "standalone value must match \"yes\" or \"no\".")?;
            }
            self.xml_decl_expects = Vec::new();
            self.xml_decl.standalone = Some(value);
        }
        // We don't need to raise an error here since we've already raised one
        // when checking what name was expected.
        self.name.clear();
        self.state = S_XML_DECL_SEPARATOR;
        Ok(())
    }

    fn s_xml_decl_separator(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        // The question mark character is not valid inside any of the XML
        // declaration name/value pairs.
        if c == QUESTION {
            // It is valid to go to S_XML_DECL_ENDING from this state.
            self.state = S_XML_DECL_ENDING;
            return Ok(());
        }
        if !is_s(c) {
            self.fail_to(h, "whitespace required.")?;
            self.unget();
        }
        self.state = S_XML_DECL_NAME_START;
        Ok(())
    }

    fn s_xml_decl_ending(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        if c == GREATER {
            if !eq(&self.pi_target, "xml") {
                self.fail_to(h, "processing instructions are not allowed before root.")?;
            } else if !eq(&self.name, "version") && self.xml_decl_expects.contains(&"version") {
                self.fail_to(h, "XML declaration must contain a version.")?;
            }
            let decl = self.xml_decl.clone();
            h.xmldecl(self, &decl)?;
            self.flush(h)?;
            self.name.clear();
            self.pi_target.clear();
            self.text.clear();
            self.state = S_TEXT;
        } else {
            // We got here because the previous character was a ?, but the question
            // mark character is not valid inside any of the XML declaration
            // name/value pairs.
            self.fail_to(
                h,
                "The character ? is disallowed anywhere in XML declarations.",
            )?;
        }
        self.xml_decl_possible = false;
        Ok(())
    }

    fn s_open_tag(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.capture_name_chars(h)?;
        if c == EOC {
            return Ok(());
        }
        let tag = Tag {
            name: std::mem::take(&mut self.name),
            ns: self.xmlns_opt.then(Ns::default),
            ..Tag::default()
        };
        if self.xmlns_opt {
            self.top_ns = Some(Ns::default());
        }
        self.tag = Some(tag);
        self.emit_tag(h, TagEvent::OpenTagStart)?;
        self.saw_root = true;
        if !self.fragment_opt && self.closed_root {
            self.fail_to(h, "documents may contain only one root.")?;
        }
        match c {
            GREATER => self.open_tag(h)?,
            FORWARD_SLASH => self.state = S_OPEN_TAG_SLASH,
            _ => {
                if !is_s(c) {
                    self.fail_to(h, "disallowed character in tag name.")?;
                }
                self.state = S_ATTRIB;
            }
        }
        Ok(())
    }

    fn s_open_tag_slash(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        if self.get_code(h)? == GREATER {
            self.open_self_closing_tag(h)?;
        } else {
            self.fail_to(h, "forward-slash in opening tag not followed by >.")?;
            self.state = S_ATTRIB;
        }
        Ok(())
    }

    fn s_attrib(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.skip_spaces(h)?;
        if c == EOC {
            return Ok(());
        }
        if is_name_start_char(c) {
            self.unget();
            self.state = S_ATTRIB_NAME;
        } else if c == GREATER {
            self.open_tag(h)?;
        } else if c == FORWARD_SLASH {
            self.state = S_OPEN_TAG_SLASH;
        } else {
            self.fail_to(h, "disallowed character in attribute name.")?;
        }
        Ok(())
    }

    fn s_attrib_name(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.capture_name_chars(h)?;
        if c == EQUAL {
            self.state = S_ATTRIB_VALUE;
        } else if is_s(c) {
            self.state = S_ATTRIB_NAME_SAW_WHITE;
        } else if c == GREATER {
            self.fail_to(h, "attribute without value.")?;
            let name = self.name.clone();
            self.push_attrib(h, name.clone(), name)?;
            self.name.clear();
            self.text.clear();
            self.open_tag(h)?;
        } else if c != EOC {
            self.fail_to(h, "disallowed character in attribute name.")?;
        }
        Ok(())
    }

    fn s_attrib_name_saw_white(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.skip_spaces(h)?;
        match c {
            EOC => {}
            EQUAL => self.state = S_ATTRIB_VALUE,
            _ => {
                self.fail_to(h, "attribute without value.")?;
                // Should we do this???
                // this.tag.attributes[this.name] = "";
                self.text.clear();
                self.name.clear();
                if c == GREATER {
                    self.open_tag(h)?;
                } else if is_name_start_char(c) {
                    self.unget();
                    self.state = S_ATTRIB_NAME;
                } else {
                    self.fail_to(h, "disallowed character in attribute name.")?;
                    self.state = S_ATTRIB;
                }
            }
        }
        Ok(())
    }

    fn s_attrib_value(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        if is_quote(c) {
            self.q = Some(c);
            self.state = S_ATTRIB_VALUE_QUOTED;
        } else if !is_s(c) {
            self.fail_to(h, "unquoted attribute value.")?;
            self.state = S_ATTRIB_VALUE_UNQUOTED;
            self.unget();
        }
        Ok(())
    }

    fn s_attrib_value_quoted(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let q = self.q.unwrap_or(NO_CHAR);
        let mut start = self.i;
        loop {
            let c = self.get_code(h)?;
            if c == q {
                let mut value = self.text.clone();
                let (a, b) = self.slice_range(start, self.prev_i);
                value.extend_from_slice(&self.chunk[a..b]);
                let name = self.name.clone();
                self.push_attrib(h, name, value)?;
                self.name.clear();
                self.text.clear();
                self.q = None;
                self.state = S_ATTRIB_VALUE_CLOSED;
                return Ok(());
            }
            match c {
                AMP => {
                    self.text_append(start, self.prev_i);
                    self.state = S_ENTITY;
                    self.entity_return_state = S_ATTRIB_VALUE_QUOTED;
                    return Ok(());
                }
                NL | NL_LIKE | TAB => {
                    self.text_append(start, self.prev_i);
                    self.text.push(SPACE as u16);
                    start = self.i;
                }
                LESS => {
                    self.text_append(start, self.prev_i);
                    self.fail_to(h, "disallowed character.")?;
                    return Ok(());
                }
                EOC => {
                    self.text_append(start, usize::MAX);
                    return Ok(());
                }
                _ => {}
            }
        }
    }

    fn s_attrib_value_closed(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.get_code_norm(h)?;
        if is_s(c) {
            self.state = S_ATTRIB;
        } else if c == GREATER {
            self.open_tag(h)?;
        } else if c == FORWARD_SLASH {
            self.state = S_OPEN_TAG_SLASH;
        } else if is_name_start_char(c) {
            self.fail_to(h, "no whitespace between attributes.")?;
            self.unget();
            self.state = S_ATTRIB_NAME;
        } else {
            self.fail_to(h, "disallowed character in attribute name.")?;
        }
        Ok(())
    }

    fn s_attrib_value_unquoted(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        // We don't do anything regarding EOL or space handling for unquoted
        // attributes. We already have failed by the time we get here, and the
        // contract that saxes upholds states that upon failure, it is not safe to
        // rely on the data passed to event handlers (other than
        // ``onerror``). Passing "bad" data is not a problem.
        let c = self.capture_to(h, &ATTRIB_VALUE_UNQUOTED_TERMINATOR)?;
        match c {
            AMP => {
                self.state = S_ENTITY;
                self.entity_return_state = S_ATTRIB_VALUE_UNQUOTED;
            }
            LESS => self.fail_to(h, "disallowed character.")?,
            EOC => {}
            _ => {
                if contains_units(&self.text, "]]>") {
                    self.fail_to(h, "the string \"]]>\" is disallowed in char data.")?;
                }
                let (name, text) = (self.name.clone(), self.text.clone());
                self.push_attrib(h, name, text)?;
                self.name.clear();
                self.text.clear();
                if c == GREATER {
                    self.open_tag(h)?;
                } else {
                    self.state = S_ATTRIB;
                }
            }
        }
        Ok(())
    }

    fn s_close_tag(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let c = self.capture_name_chars(h)?;
        if c == GREATER {
            self.close_tag(h)?;
        } else if is_s(c) {
            self.state = S_CLOSE_TAG_SAW_WHITE;
        } else if c != EOC {
            self.fail_to(h, "disallowed character in closing tag.")?;
        }
        Ok(())
    }

    fn s_close_tag_saw_white(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        match self.skip_spaces(h)? {
            GREATER => self.close_tag(h)?,
            EOC => {}
            _ => self.fail_to(h, "disallowed character in closing tag.")?,
        }
        Ok(())
    }

    // END OF STATE ENGINE METHODS

    /// Calls the `text` handler with the text read since the last `<`.
    fn emit_text(&mut self, h: &mut dyn Handler, start: usize) -> Result<(), Error> {
        let slice = self.chunk_slice(start, self.prev_i);
        if !self.text.is_empty() {
            let mut text = self.text.clone();
            text.extend_from_slice(&slice);
            h.text(self, &text)?;
            self.flush(h)?;
            self.text.clear();
        } else if !slice.is_empty() {
            h.text(self, &slice)?;
            self.flush(h)?;
        }
        Ok(())
    }

    fn handle_text_in_root(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        // This is essentially a specialized version of captureTo which is optimized
        // for performing the ]]> check.
        let mut start = self.i;
        let mut forbidden_state = self.forbidden_state;
        let handler = self.text_handler;
        loop {
            match self.get_code(h)? {
                LESS => {
                    self.state = S_OPEN_WAKA;
                    if handler {
                        self.emit_text(h, start)?;
                    }
                    forbidden_state = FORBIDDEN_START;
                    break;
                }
                AMP => {
                    self.state = S_ENTITY;
                    self.entity_return_state = S_TEXT;
                    if handler {
                        self.text_append(start, self.prev_i);
                    }
                    forbidden_state = FORBIDDEN_START;
                    break;
                }
                CLOSE_BRACKET => match forbidden_state {
                    FORBIDDEN_START => forbidden_state = FORBIDDEN_BRACKET,
                    FORBIDDEN_BRACKET => forbidden_state = FORBIDDEN_BRACKET_BRACKET,
                    FORBIDDEN_BRACKET_BRACKET => {}
                    _ => return Err(Error::plain("Error", "impossible state")),
                },
                GREATER => {
                    if forbidden_state == FORBIDDEN_BRACKET_BRACKET {
                        self.fail_to(h, "the string \"]]>\" is disallowed in char data.")?;
                    }
                    forbidden_state = FORBIDDEN_START;
                }
                NL_LIKE => {
                    if handler {
                        self.text_append(start, self.prev_i);
                        self.text.push(NL as u16);
                    }
                    start = self.i;
                    forbidden_state = FORBIDDEN_START;
                }
                EOC => {
                    if handler {
                        self.text_append(start, usize::MAX);
                    }
                    break;
                }
                _ => forbidden_state = FORBIDDEN_START,
            }
        }
        self.forbidden_state = forbidden_state;
        Ok(())
    }

    fn handle_text_outside_root(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        // This is essentially a specialized version of captureTo which is optimized
        // for a specialized task. We keep track of the presence of non-space
        // characters in the text since these are errors when appearing outside the
        // document root element.
        let mut start = self.i;
        let handler = self.text_handler;
        let mut non_space = false;
        loop {
            let code = self.get_code(h)?;
            match code {
                LESS => {
                    self.state = S_OPEN_WAKA;
                    if handler {
                        self.emit_text(h, start)?;
                    }
                    break;
                }
                AMP => {
                    self.state = S_ENTITY;
                    self.entity_return_state = S_TEXT;
                    if handler {
                        self.text_append(start, self.prev_i);
                    }
                    non_space = true;
                    break;
                }
                NL_LIKE => {
                    if handler {
                        self.text_append(start, self.prev_i);
                        self.text.push(NL as u16);
                    }
                    start = self.i;
                }
                EOC => {
                    if handler {
                        self.text_append(start, usize::MAX);
                    }
                    break;
                }
                _ => {
                    if !is_s(code) {
                        non_space = true;
                    }
                }
            }
        }
        if !non_space {
            return Ok(());
        }
        // We use the reportedTextBeforeRoot and reportedTextAfterRoot flags
        // to avoid reporting errors for every single character that is out of
        // place.
        if !self.saw_root && !self.reported_text_before_root {
            self.fail_to(h, "text data outside of root node.")?;
            self.reported_text_before_root = true;
        }
        if self.closed_root && !self.reported_text_after_root {
            self.fail_to(h, "text data outside of root node.")?;
            self.reported_text_after_root = true;
        }
        Ok(())
    }

    fn push_attrib(&mut self, h: &mut dyn Handler, name: Str, value: Str) -> Result<(), Error> {
        if self.xmlns_opt {
            self.push_attrib_ns(h, name, value)
        } else {
            let attr = Attribute {
                name,
                value,
                prefix: None,
                local: None,
                uri: None,
            };
            self.attrib_list.push(attr.clone());
            h.attribute(self, &attr)?;
            self.flush(h)
        }
    }

    fn push_attrib_ns(&mut self, h: &mut dyn Handler, name: Str, value: Str) -> Result<(), Error> {
        let (prefix, local) = self.qname(h, &name)?;
        let attr = Attribute {
            name: name.clone(),
            value: value.clone(),
            prefix: Some(prefix.clone()),
            local: Some(local.clone()),
            uri: None,
        };
        self.attrib_list.push(attr.clone());
        h.attribute(self, &attr)?;
        self.flush(h)?;
        if eq(&prefix, "xmlns") {
            let trimmed = trim_units(&value).to_vec();
            if eq(&self.current_xml_version, "1.0") && trimmed.is_empty() {
                self.fail_to(h, "invalid attempt to undefine prefix in XML 1.0")?;
            }
            self.set_top_ns(local.clone(), trimmed.clone());
            self.ns_pair_check(h, &local, &trimmed)?;
        } else if eq(&name, "xmlns") {
            let trimmed = trim_units(&value).to_vec();
            self.set_top_ns(Str::new(), trimmed.clone());
            self.ns_pair_check(h, &[], &trimmed)?;
        }
        Ok(())
    }

    /// `this.topNS[key] = value`; `topNS` is the `ns` of the tag being read.
    fn set_top_ns(&mut self, key: Str, value: Str) {
        if let Some(ns) = self.top_ns.as_mut() {
            ns.set(key.clone(), value.clone());
        }
        if let Some(ns) = self.tag.as_mut().and_then(|tag| tag.ns.as_mut()) {
            ns.set(key, value);
        }
    }

    fn ns_pair_check(
        &mut self,
        h: &mut dyn Handler,
        prefix: &[u16],
        uri: &[u16],
    ) -> Result<(), Error> {
        for message in ns_pair_messages(prefix, uri) {
            self.fail_to(h, &message)?;
        }
        Ok(())
    }

    /// End parsing: final well-formedness checks, the `end` event, and the
    /// parser is reset (`ready`).
    fn end(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        if !self.saw_root {
            self.fail_to(h, "document must contain a root element.")?;
        }
        while let Some(tag) = self.tags.pop() {
            let message = concat(&[&units("unclosed tag: "), &tag.name]);
            self.fail_units(h, &message)?;
        }
        if self.state != S_BEGIN && self.state != S_TEXT {
            self.fail_to(h, "unexpected end.")?;
        }
        if !self.text.is_empty() {
            let text = self.text.clone();
            if self.text_handler {
                h.text(self, &text)?;
                self.flush(h)?;
            }
            self.text.clear();
        }
        self.closed = true;
        h.end(self)?;
        self.flush(h)?;
        self.reinit(h)
    }

    /// Resolve a namespace prefix: the URI, or `None` where it is not defined.
    /// Before any tag was read `topNS` is `null`, which JavaScript cannot
    /// index.
    pub fn resolve(&self, prefix: &[u16]) -> Result<Option<Str>, Error> {
        let Some(top) = &self.top_ns else {
            return Err(Error {
                name: "TypeError",
                message: concat(&[
                    &units("Cannot read properties of null (reading '"),
                    prefix,
                    &units("')"),
                ]),
            });
        };
        if let Some(uri) = top.get(prefix) {
            return Ok(Some(uri.clone()));
        }
        for tag in self.tags.iter().rev() {
            if let Some(uri) = tag.ns.as_ref().and_then(|ns| ns.get(prefix)) {
                return Ok(Some(uri.clone()));
            }
        }
        if let Some(uri) = self.ns.get(prefix) {
            return Ok(Some(uri.clone()));
        }
        Ok(self
            .resolve_prefix
            .as_ref()
            .and_then(|resolve| resolve(prefix)))
    }

    /// Parse a qname into its prefix and local name parts.
    fn qname(&mut self, h: &mut dyn Handler, name: &[u16]) -> Result<(Str, Str), Error> {
        let Some(colon) = name.iter().position(|u| *u == u16::from(b':')) else {
            return Ok((Str::new(), name.to_vec()));
        };
        let local = name[colon + 1..].to_vec();
        let prefix = name[..colon].to_vec();
        if prefix.is_empty() || local.is_empty() || local.contains(&u16::from(b':')) {
            let message = concat(&[&units("malformed name: "), name, &units(".")]);
            self.fail_units(h, &message)?;
        }
        Ok((prefix, local))
    }

    fn process_attribs(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let mut tag = self.tag.take().expect("a tag is open");
        let result = if self.xmlns_opt {
            self.process_attribs_ns(h, &mut tag)
        } else {
            self.process_attribs_plain(h, &mut tag)
        };
        self.tag = Some(tag);
        result
    }

    fn process_attribs_ns(&mut self, h: &mut dyn Handler, tag: &mut Tag) -> Result<(), Error> {
        {
            // add namespace info to tag
            let (prefix, local) = self.qname(h, &tag.name.clone())?;
            tag.prefix = Some(prefix.clone());
            tag.local = Some(local);
            let uri = self.resolve(&prefix)?.unwrap_or_default();
            tag.uri = Some(uri.clone());
            if !prefix.is_empty() {
                if eq(&prefix, "xmlns") {
                    self.fail_to(h, "tags may not have \"xmlns\" as prefix.")?;
                }
                if uri.is_empty() {
                    let message = concat(&[
                        &units("unbound namespace prefix: "),
                        &json_quote(&prefix),
                        &units("."),
                    ]);
                    self.fail_units(h, &message)?;
                    tag.uri = Some(prefix);
                }
            }
        }
        if self.attrib_list.is_empty() {
            return Ok(());
        }
        let list = self.attrib_list.clone();
        let mut seen: Vec<Str> = Vec::new();
        // Note: do not apply default ns to attributes:
        //   http://www.w3.org/TR/REC-xml-names/#defaulting
        for mut attr in list {
            let name = attr.name.clone();
            let prefix = attr.prefix.clone().unwrap_or_default();
            let local = attr.local.clone().unwrap_or_default();
            let uri: Str;
            let eqname: Str;
            if prefix.is_empty() {
                uri = if eq(&name, "xmlns") {
                    units(XMLNS_NAMESPACE)
                } else {
                    Str::new()
                };
                eqname = name.clone();
            } else {
                let resolved = match self.resolve(&prefix)? {
                    Some(uri) => uri,
                    None => {
                        // if there's any attributes with an undefined namespace,
                        // then fail on them now.
                        let message = concat(&[
                            &units("unbound namespace prefix: "),
                            &json_quote(&prefix),
                            &units("."),
                        ]);
                        self.fail_units(h, &message)?;
                        prefix.clone()
                    }
                };
                eqname = concat(&[&units("{"), &resolved, &units("}"), &local]);
                uri = resolved;
            }
            if seen.contains(&eqname) {
                let message = concat(&[&units("duplicate attribute: "), &eqname, &units(".")]);
                self.fail_units(h, &message)?;
            }
            seen.push(eqname);
            attr.uri = Some(uri);
            set_attribute(&mut tag.attributes, attr);
        }
        self.attrib_list.clear();
        Ok(())
    }

    fn process_attribs_plain(&mut self, h: &mut dyn Handler, tag: &mut Tag) -> Result<(), Error> {
        let list = self.attrib_list.clone();
        for attr in list {
            if tag.attributes.iter().any(|a| a.name == attr.name) {
                let message = concat(&[&units("duplicate attribute: "), &attr.name, &units(".")]);
                self.fail_units(h, &message)?;
            }
            set_attribute(&mut tag.attributes, attr);
        }
        self.attrib_list.clear();
        Ok(())
    }

    /// Calls the handler of a tag event with the tag in `self.tag`, which is
    /// back in place after the call.
    fn emit_tag(&mut self, h: &mut dyn Handler, event: TagEvent) -> Result<(), Error> {
        let tag = self.tag.take().expect("a tag is open");
        let result = self.call_tag(h, &tag, event);
        self.tag = Some(tag);
        result
    }

    fn call_tag(&mut self, h: &mut dyn Handler, tag: &Tag, event: TagEvent) -> Result<(), Error> {
        match event {
            TagEvent::OpenTagStart => h.opentagstart(self, tag)?,
            TagEvent::OpenTag => h.opentag(self, tag)?,
            TagEvent::CloseTag => h.closetag(self, tag)?,
        }
        self.flush(h)
    }

    /// Handle a complete open tag, then emit `opentag`.
    fn open_tag(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        self.process_attribs(h)?;
        let mut tag = self.tag.take().expect("a tag is open");
        tag.is_self_closing = false;
        // There cannot be any pending text here due to the onopentagstart that was
        // necessarily emitted before we get here. So we do not check text.
        if let Err(error) = self.call_tag(h, &tag, TagEvent::OpenTag) {
            self.tag = Some(tag);
            return Err(error);
        }
        self.tags.push(tag);
        self.state = S_TEXT;
        self.name.clear();
        Ok(())
    }

    /// Handle a complete self-closing tag: `opentag` and `closetag`.
    fn open_self_closing_tag(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        self.process_attribs(h)?;
        let mut tag = self.tag.take().expect("a tag is open");
        tag.is_self_closing = true;
        let result = self
            .call_tag(h, &tag, TagEvent::OpenTag)
            .and_then(|()| self.call_tag(h, &tag, TagEvent::CloseTag));
        if let Err(error) = result {
            self.tag = Some(tag);
            return Err(error);
        }
        if self.tags.is_empty() {
            self.closed_root = true;
        }
        self.state = S_TEXT;
        self.name.clear();
        Ok(())
    }

    /// Handle a complete close tag, then emit `closetag`.
    fn close_tag(&mut self, h: &mut dyn Handler) -> Result<(), Error> {
        let name = std::mem::take(&mut self.name);
        // Our state after this will be S_TEXT, no matter what, and we can clear
        // tagName now.
        self.state = S_TEXT;
        if name.is_empty() {
            self.fail_to(h, "weird empty close tag.")?;
            self.text.extend(units("</>"));
            return Ok(());
        }
        let mut l = self.tags.len() as isize;
        loop {
            let before = l;
            l -= 1;
            if before <= 0 {
                break;
            }
            let tag = self.tags.pop().expect("l counts the open tags");
            self.top_ns = tag.ns.clone();
            self.call_tag(h, &tag, TagEvent::CloseTag)?;
            if tag.name == name {
                break;
            }
            self.fail_to(h, "unexpected close tag.")?;
        }
        if l == 0 {
            self.closed_root = true;
        } else if l < 0 {
            let message = concat(&[&units("unmatched closing tag: "), &name, &units(".")]);
            self.fail_units(h, &message)?;
            self.text.extend(units("</"));
            self.text.extend_from_slice(&name);
            self.text.push(GREATER as u16);
        }
        Ok(())
    }

    /// Resolves an entity. Makes any necessary well-formedness checks.
    fn parse_entity(&mut self, h: &mut dyn Handler, entity: &[u16]) -> Result<Str, Error> {
        // startsWith would be significantly slower for this test.
        if entity.first() != Some(&u16::from(b'#')) {
            let defined = match String::from_utf16(entity).as_deref() {
                Ok("amp") => Some("&"),
                Ok("gt") => Some(">"),
                Ok("lt") => Some("<"),
                Ok("quot") => Some("\""),
                Ok("apos") => Some("'"),
                _ => None,
            };
            if let Some(defined) = defined {
                return Ok(units(defined));
            }
            if let Some(defined) = h.entity(entity)? {
                return Ok(defined);
            }
            self.fail_to(
                h,
                if matches_name(entity, self.xmlns_opt) {
                    "undefined entity."
                } else {
                    "disallowed character in entity name."
                },
            )?;
            return Ok(concat(&[&units("&"), entity, &units(";")]));
        }
        let mut num: Option<u64> = None;
        let hex = |u: &u16| u8::try_from(*u).is_ok_and(|b| b.is_ascii_hexdigit());
        let dec = |u: &u16| (0x30..=0x39).contains(u);
        if entity.get(1) == Some(&u16::from(b'x'))
            && entity.len() > 2
            && entity[2..].iter().all(hex)
        {
            num = Some(parse_digits(&entity[2..], 16));
        } else if entity.len() > 1 && entity[1..].iter().all(dec) {
            num = Some(parse_digits(&entity[1..], 10));
        }
        // The character reference is required to match the CHAR production.
        if !self.is_char(num) {
            self.fail_to(h, "malformed character entity.")?;
            return Ok(concat(&[&units("&"), entity, &units(";")]));
        }
        let mut out = Str::new();
        push_code_point(&mut out, num.expect("is_char holds for a number") as i32)?;
        Ok(out)
    }
}

#[derive(Clone, Copy)]
enum TagEvent {
    OpenTagStart,
    OpenTag,
    CloseTag,
}

/// `attributes[name] = value`: the first place of a name is kept.
fn set_attribute(attributes: &mut Vec<Attribute>, attr: Attribute) {
    match attributes.iter_mut().find(|a| a.name == attr.name) {
        Some(existing) => *existing = attr,
        None => attributes.push(attr),
    }
}
