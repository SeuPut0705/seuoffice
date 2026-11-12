//! The object tree the slides engine gets from fast-xml-parser: `new
//! XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', ... })`.
//!
//! [`parse_object`] is a port of fast-xml-parser 5.10.1 `OrderedObjParser.parseXml`
//! followed by `node2json.compress`, with number coercion from strnum 2.4.1. It
//! shares the lexer of [`crate::parse_ordered`] but not its tree: that tree has
//! already decoded entities (this mode trims before decoding), cannot tell CDATA
//! from text (CDATA is neither trimmed nor decoded, but is coerced), and checks
//! attribute names unprefixed (here `@_constructor` is a harmless name).

use std::borrow::Cow;

use jscompat::{JsNum, Radix, array_index, js_regex, number_to_string, parse_int, to_number, trim};
use serde_json::{Map, Value};

use crate::ordered::{
    ParseError, decode_entities, find_from, next_attribute, normalize_newlines, sanitize_name,
    skip_utf16_units, split_tag_expression, tag_expression,
};

/// The options the engine varies; every other option is the library default.
#[derive(Debug, Clone, Copy)]
pub struct ObjectOptions<'a> {
    /// `trimValues`
    pub trim_values: bool,
    /// `parseTagValue`
    pub parse_tag_value: bool,
    /// `isArray: (name) => arrayNames.includes(name)`
    pub array_names: &'a [&'a str],
}

impl Default for ObjectOptions<'_> {
    fn default() -> Self {
        Self {
            trim_values: true,
            parse_tag_value: true,
            array_names: &[],
        }
    }
}

/// `maxNestedTags`, which no engine parser sets.
const MAX_NESTED_TAGS: usize = 100;
const ATTRIBUTE_PREFIX: &str = "@_";
const TEXT_NODE_NAME: &str = "#text";
/// The tag name of the document node.
const DOCUMENT: &str = "!xml";

/// `parser.parse(xml)`
pub fn parse_object(xml: &str, options: &ObjectOptions<'_>) -> Result<Value, ParseError> {
    let source = normalize_newlines(xml);
    let root = Parser {
        source: &source,
        options,
        root: Vec::new(),
        open: Vec::new(),
        detached: false,
        text: String::new(),
        xml_1_1: false,
    }
    .run()?;
    Ok(Value::Object(compress(root, options)))
}

/// A text value after `parseValue`: a string, or what strnum made of it. Or
/// the child list of a `<#text/>` element, which `compress` takes for text.
#[derive(Debug)]
enum Scalar {
    Str(String),
    Num(f64),
    Bool(bool),
    /// `[]`: only a self-closing tag can be named `#text`, so the list is empty.
    EmptyList,
}

impl Scalar {
    /// `"" + value`
    fn into_js_string(self) -> String {
        match self {
            Self::Str(text) => text,
            Self::Num(number) => number_to_string(number),
            Self::Bool(flag) => flag.to_string(),
            Self::EmptyList => String::new(),
        }
    }

    fn into_value(self) -> Value {
        match self {
            Self::Str(text) => Value::String(text),
            Self::Num(number) => serde_json::to_value(JsNum(number)).unwrap_or(Value::Null),
            Self::Bool(flag) => Value::Bool(flag),
            Self::EmptyList => Value::Array(Vec::new()),
        }
    }
}

/// An entry of `xmlNode.child`.
enum Child {
    Text(Scalar),
    Element(Element),
}

/// An `xmlNode`. `attrs` holds the prefixed names; empty where `':@'` is absent.
struct Element {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<Child>,
}

struct Parser<'a> {
    source: &'a str,
    options: &'a ObjectOptions<'a>,
    root: Vec<Child>,
    /// The `tagsNodeStack` above the document node, and `currentNode` last.
    /// An element joins its parent when it closes, which is the place it
    /// took when it opened: nothing else is added to the parent meanwhile.
    open: Vec<Element>,
    /// A closing tag arrived with no element open: `currentNode` is undefined.
    detached: bool,
    /// `textData`
    text: String,
    xml_1_1: bool,
}

impl Parser<'_> {
    fn run(mut self) -> Result<Vec<Child>, ParseError> {
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
                // no `commentPropName`: the comment goes, the text around it stays
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
            self.children()?.push(Child::Element(element));
        }
        Ok(self.root)
    }

    fn children(&mut self) -> Result<&mut Vec<Child>, ParseError> {
        if self.detached {
            return Err(ParseError::NoOpenNode);
        }
        Ok(match self.open.last_mut() {
            Some(element) => &mut element.children,
            None => &mut self.root,
        })
    }

    /// `saveTextToParentTag`
    fn save_text(&mut self) -> Result<(), ParseError> {
        if self.text.is_empty() {
            return Ok(());
        }
        let text = std::mem::take(&mut self.text);
        let value = self.parse_text(&text, false, false);
        let children = self.children()?;
        match value {
            None => {}
            Some(Scalar::Str(text)) if text.is_empty() => {}
            Some(value) => children.push(Child::Text(value)),
        }
        Ok(())
    }

    /// `parseTextData` with the default `tagValueProcessor`, which hands the
    /// value back unchanged. `None` where it returns undefined.
    fn parse_text(&self, raw: &str, dont_trim: bool, escape_entities: bool) -> Option<Scalar> {
        let trim_values = self.options.trim_values;
        let value = if trim_values && !dont_trim {
            trim(raw)
        } else {
            raw
        };
        if value.is_empty() {
            return None;
        }
        let value = if escape_entities {
            Cow::Borrowed(value)
        } else {
            decode_entities(value, self.xml_1_1)
        };
        Some(if trim_values || trim(&value) == value {
            parse_value(&value, self.options.parse_tag_value)
        } else {
            Scalar::Str(value.into_owned())
        })
    }

    fn closing_tag(&mut self, at: usize) -> Result<usize, ParseError> {
        let close = find_from(self.source, ">", at).ok_or(ParseError::ClosingTagNotClosed)?;
        sanitize_name(trim(&self.source[at + 2..close]))?;
        if !self.detached {
            self.save_text()?;
        }
        match self.open.pop() {
            Some(element) => self.children()?.push(Child::Element(element)),
            None => self.detached = true,
        }
        self.text.clear();
        Ok(close + 1)
    }

    fn processing_instruction(&mut self, at: usize) -> Result<usize, ParseError> {
        let (expression, close) =
            tag_expression(self.source, at + 1, b"?>").ok_or(ParseError::PiNotClosed)?;
        let (name, attribute_text) = split_tag_expression(&expression);
        self.save_text()?;
        let attrs = self.attributes(attribute_text);
        if let Some(attrs) = &attrs {
            // `Number(version) || 1.0`, then anything but 1.1 means 1.0
            self.xml_1_1 = attrs
                .iter()
                .find(|(key, _)| key == "@_version")
                .is_some_and(|(_, value)| to_number(value) == 1.1);
        }
        let element = Element {
            name: name.to_owned(),
            attrs: if name == attribute_text {
                Vec::new()
            } else {
                attrs.unwrap_or_default()
            },
            children: vec![Child::Text(Scalar::Str(String::new()))],
        };
        self.children()?.push(Child::Element(element));
        Ok(close + 2)
    }

    /// Every `<![` is read as a 9-character CDATA opener, whatever follows it.
    fn cdata(&mut self, at: usize) -> Result<usize, ParseError> {
        let source = self.source;
        let close = find_from(source, "]]>", at).ok_or(ParseError::CdataNotClosed)?;
        let content_start = skip_utf16_units(source, at, 9)?;
        // `substring(start, end)` swaps its arguments when start > end
        let content = &source[content_start.min(close)..content_start.max(close)];
        self.save_text()?;
        // an empty section still adds an empty text
        let value = self
            .parse_text(content, true, true)
            .unwrap_or(Scalar::Str(String::new()));
        self.children()?.push(Child::Text(value));
        Ok(close + 3)
    }

    fn opening_tag(&mut self, at: usize) -> Result<usize, ParseError> {
        let (expression, close) =
            tag_expression(self.source, at + 1, b">").ok_or(ParseError::TagNotClosed)?;
        let (raw_name, mut attribute_text) = split_tag_expression(&expression);
        let mut name = sanitize_name(raw_name)?;
        if name == TEXT_NODE_NAME {
            return Err(ParseError::InvalidTagName(name.into_owned()));
        }
        // text directly under the document node, or under an element that
        // happens to share its name, is dropped here, not stored
        if !self.detached
            && self
                .open
                .last()
                .is_some_and(|element| element.name != DOCUMENT)
        {
            self.save_text()?;
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
            self.attributes(attribute_text).unwrap_or_default()
        } else {
            Vec::new()
        };

        if self_closing {
            let element = Element {
                name: sanitize_name(&name)?.into_owned(),
                attrs,
                children: Vec::new(),
            };
            self.children()?.push(Child::Element(element));
        } else {
            if self.open.len() > MAX_NESTED_TAGS {
                return Err(ParseError::MaxNestedTags);
            }
            if self.detached {
                return Err(ParseError::NoOpenNode);
            }
            self.open.push(Element {
                name: name.into_owned(),
                attrs,
                children: Vec::new(),
            });
        }
        self.text.clear();
        Ok(close + 1)
    }

    /// `buildAttributesMap`: `None` when no attribute has a quoted value. A
    /// value is trimmed before its entities are decoded. A repeated name
    /// overwrites the value in its first position. The prefix keeps every name
    /// clear of `sanitizeName` and of integer keys, so the entries stay in the
    /// order they were first written.
    fn attributes(&self, text: &str) -> Option<Vec<(String, String)>> {
        let mut attrs: Vec<(String, String)> = Vec::new();
        let mut position = 0;
        while let Some(token) = next_attribute(text, position) {
            position = token.end;
            let Some(value) = token.value else {
                continue;
            };
            let value = if self.options.trim_values {
                trim(value)
            } else {
                value
            };
            let value = decode_entities(value, self.xml_1_1).into_owned();
            let name = format!("{ATTRIBUTE_PREFIX}{}", token.name);
            match attrs.iter_mut().find(|(key, _)| *key == name) {
                Some(entry) => entry.1 = value,
                None => attrs.push((name, value)),
            }
        }
        (!attrs.is_empty()).then_some(attrs)
    }
}

/// `node2json.compress`: one key per child element name in the order the
/// names first appear, a repeated name gathering its values in an array, then
/// the concatenated text. Keys are own entries only: a tag named like an
/// inherited property (`isPrototypeOf`) is a key like any other.
fn compress(children: Vec<Child>, options: &ObjectOptions<'_>) -> Map<String, Value> {
    let mut object = Map::new();
    let mut text: Option<Scalar> = None;
    for child in children {
        let child = match child {
            Child::Element(element) if element.name == TEXT_NODE_NAME => {
                Child::Text(Scalar::EmptyList)
            }
            child => child,
        };
        let element = match child {
            Child::Text(value) => {
                text = Some(match text {
                    None => value,
                    Some(before) => {
                        let mut joined = before.into_js_string();
                        joined.push_str(&value.into_js_string());
                        Scalar::Str(joined)
                    }
                });
                continue;
            }
            // `{ ":@": ... }` has no key but `:@`, so `propName` finds no name
            Child::Element(element) if element.name == ":@" => continue,
            Child::Element(element) => element,
        };
        let mut content = compress(element.children, options);
        let value = if !element.attrs.is_empty() {
            for (name, value) in element.attrs {
                let value = array_if_listed(options, &name, Value::String(value));
                content.insert(name, value);
            }
            Value::Object(content)
        } else if content.len() == 1 && content.contains_key(TEXT_NODE_NAME) {
            content
                .remove(TEXT_NODE_NAME)
                .unwrap_or(Value::String(String::new()))
        } else if content.is_empty() {
            Value::String(String::new())
        } else {
            Value::Object(content)
        };
        match object.get_mut(&element.name) {
            Some(existing) => {
                if !existing.is_array() {
                    *existing = Value::Array(vec![existing.take()]);
                }
                if let Value::Array(items) = existing {
                    items.push(value);
                }
            }
            None => {
                let value = array_if_listed(options, &element.name, value);
                object.insert(element.name, value);
            }
        }
    }
    match text {
        Some(Scalar::Str(text)) if text.is_empty() => {}
        Some(text) => {
            object.insert(TEXT_NODE_NAME.to_owned(), text.into_value());
        }
        None => {}
    }
    in_property_order(object)
}

/// `isArray(name)` decides for the first value under a name only.
fn array_if_listed(options: &ObjectOptions<'_>, name: &str, value: Value) -> Value {
    if options.array_names.contains(&name) {
        Value::Array(vec![value])
    } else {
        value
    }
}

/// A JavaScript object enumerates array-index keys first, ascending. Only an
/// element name can be one: `<1>` is a tag the parser accepts.
fn in_property_order(object: Map<String, Value>) -> Map<String, Value> {
    if !object.keys().any(|key| array_index(key).is_some()) {
        return object;
    }
    let mut entries: Vec<(String, Value)> = object.into_iter().collect();
    entries.sort_by_key(|(key, _)| match array_index(key) {
        Some(index) => (0, index),
        None => (1, 0),
    });
    entries.into_iter().collect()
}

/// `parseValue` for a tag value: `true` and `false` by their trimmed text,
/// anything else through strnum.
fn parse_value(value: &str, should_parse: bool) -> Scalar {
    if !should_parse {
        return Scalar::Str(value.to_owned());
    }
    match trim(value) {
        "true" => Scalar::Bool(true),
        "false" => Scalar::Bool(false),
        _ => strnum_to_number(value),
    }
}

/// strnum 2.4.1 `toNumber` with the `numberParseOptions` fast-xml-parser
/// passes by default: hexadecimal, leading zeros and exponents read, binary
/// and octal not, an infinite result kept as the original text.
fn strnum_to_number(text: &str) -> Scalar {
    let original = || Scalar::Str(text.to_owned());
    let trimmed = trim(text);
    if trimmed.is_empty() {
        return original();
    }
    if trimmed == "0" {
        return Scalar::Num(0.0);
    }
    if js_regex!(r"^[-+]?0x[a-fA-F0-9]+$").test(trimmed) {
        return Scalar::Num(parse_int(trimmed, Radix::Sixteen));
    }
    // `isFinite(trimmedStr)`; NaN takes this branch too
    let number = to_number(trimmed);
    if !number.is_finite() {
        return original();
    }
    if trimmed.contains(['e', 'E']) {
        return resolve_e_notation(text, trimmed);
    }
    let Some(found) = js_regex!(r"^([\-\+])?(0*)([0-9]*(\.[0-9]*)?)$").exec(trimmed) else {
        return original();
    };
    let sign = found.get(1).unwrap_or("");
    let leading_zeros = found.get(2).unwrap_or("");
    let without_zeros = trim_zeros(found.get(3).unwrap_or(""));
    // with `leadingZeros` on, the branch that refuses them never runs
    let printed = number_to_string(number);
    if number == 0.0 || printed.contains(['e', 'E']) {
        return Scalar::Num(number);
    }
    let kept = if trimmed.contains('.') {
        printed == "0" || printed == without_zeros || printed == format!("{sign}{without_zeros}")
    } else if !leading_zeros.is_empty() {
        without_zeros == printed || format!("{sign}{without_zeros}") == printed
    } else {
        trimmed == printed || trimmed == format!("{sign}{printed}")
    };
    if kept {
        Scalar::Num(number)
    } else {
        original()
    }
}

/// `resolveEnotation`. It looks for the exponent letter in `text` before it
/// was trimmed, which differs from the trimmed text only for CDATA.
fn resolve_e_notation(text: &str, trimmed: &str) -> Scalar {
    let Some(notation) = js_regex!(r"^([-+])?(0*)(\d*(\.\d*)?[eE][-\+]?\d+)$").exec(trimmed) else {
        return Scalar::Str(text.to_owned());
    };
    let sign = notation.get(1).unwrap_or("");
    let leading_zeros = notation.get(2).unwrap_or("").len();
    let rest = notation.get(3).unwrap_or("");
    let e_char = if rest.contains('e') { b'e' } else { b'E' };
    let at = if sign.is_empty() {
        leading_zeros
    } else {
        leading_zeros + 1
    };
    let e_adjacent = text.encode_utf16().nth(at) == Some(u16::from(e_char));
    if leading_zeros > 1 && e_adjacent {
        Scalar::Str(text.to_owned())
    } else if leading_zeros == 1
        && (rest.as_bytes().first() == Some(&e_char)
            || rest.as_bytes().starts_with(&[b'.', e_char]))
    {
        Scalar::Num(to_number(trimmed))
    } else if leading_zeros > 0 {
        if e_adjacent {
            Scalar::Str(text.to_owned())
        } else {
            Scalar::Num(to_number(&format!("{sign}{rest}")))
        }
    } else {
        Scalar::Num(to_number(trimmed))
    }
}

/// `trimZeros`: the trailing zeros of a fraction, and a bare point, go.
fn trim_zeros(digits: &str) -> Cow<'_, str> {
    if !digits.contains('.') {
        return Cow::Borrowed(digits);
    }
    let digits = digits.trim_end_matches('0');
    if digits == "." {
        Cow::Borrowed("0")
    } else if digits.starts_with('.') {
        Cow::Owned(format!("0{digits}"))
    } else {
        Cow::Borrowed(digits.strip_suffix('.').unwrap_or(digits))
    }
}
