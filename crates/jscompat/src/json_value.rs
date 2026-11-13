//! `JSON.parse` and the values it gives, the conversions an operator, a
//! property read or a `for...of` applies to such a value, `TextDecoder` and
//! `String.fromCharCode`.
//!
//! A JavaScript string can hold a lone surrogate and a Rust string cannot:
//! where JavaScript would make one (a `\uD800` escape without its other half,
//! one code unit of a pair), these give U+FFFD. Both read as NaN as numbers
//! and both count one code unit, so arithmetic and lengths agree; a key or a
//! value printed with one does not.

use std::borrow::Cow;
use std::fmt;

use serde::ser::{Serialize, SerializeSeq, Serializer};

use crate::{JsNum, JsObject, array_index, number_to_string, to_int32, to_number};

/// `new TextDecoder().decode(bytes)`: UTF-8, not fatal, a leading byte order
/// mark dropped, each ill-formed subsequence one U+FFFD as the Encoding
/// Standard counts them (the standard library counts them the same way).
pub fn text_decoder_decode(bytes: &[u8]) -> Cow<'_, str> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8_lossy(bytes)
}

/// `String.fromCharCode(code)` of one code: the code unit `ToUint16(code)`.
/// A surrogate unit is U+FFFD (see the module).
pub fn string_from_char_code(code: f64) -> char {
    // ToUint16 is ToInt32 modulo 2^16: 2^16 divides 2^32
    let unit = to_int32(code) as u16;
    char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER)
}

/// A value `JSON.parse` gives. A number is a double: `1e400` is Infinity.
/// An object keeps its keys as JavaScript orders them, an own `__proto__`
/// included.
#[derive(Debug, Clone, PartialEq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsonValue>),
    Object(JsObject<JsonValue>),
}

/// What `JSON.parse` throws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonSyntaxError;

impl fmt::Display for JsonSyntaxError {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("SyntaxError: not JSON")
    }
}

/// A `TypeError` the language throws: a value that is not iterable, a
/// property read on `null`, an object that converts to no primitive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsTypeError(pub String);

impl fmt::Display for JsTypeError {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        write!(formatter, "TypeError: {}", self.0)
    }
}

impl JsonValue {
    /// `if (value)`
    pub fn truthy(&self) -> bool {
        match self {
            JsonValue::Null => false,
            JsonValue::Bool(flag) => *flag,
            JsonValue::Number(x) => *x != 0.0 && !x.is_nan(),
            JsonValue::String(text) => !text.is_empty(),
            JsonValue::Array(_) | JsonValue::Object(_) => true,
        }
    }

    /// `value[key]` for what the value holds itself: an own key of an object,
    /// an item or the `length` of an array, a code unit or the `length` (in
    /// UTF-16 code units) of a string. `None` is `undefined`, and so is what
    /// a prototype would answer (`constructor`, `toString`, ...): a caller
    /// reads only names no prototype has, or names whose inherited answer
    /// does to it what `undefined` does. On `null` it is `None` too, which is
    /// `null?.[key]`; where JavaScript reads without `?.` the caller throws.
    pub fn get(&self, key: &str) -> Option<Cow<'_, JsonValue>> {
        match self {
            JsonValue::Object(object) => object.get(key).map(Cow::Borrowed),
            JsonValue::Array(items) if key == "length" => {
                Some(Cow::Owned(JsonValue::Number(items.len() as f64)))
            }
            JsonValue::Array(items) => array_index(key)
                .and_then(|index| usize::try_from(index).ok())
                .and_then(|index| items.get(index))
                .map(Cow::Borrowed),
            JsonValue::String(text) if key == "length" => Some(Cow::Owned(JsonValue::Number(
                text.encode_utf16().count() as f64,
            ))),
            JsonValue::String(text) => array_index(key)
                .and_then(|index| usize::try_from(index).ok())
                .and_then(|index| text.encode_utf16().nth(index))
                .map(|unit| {
                    let unit =
                        char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER);
                    Cow::Owned(JsonValue::String(unit.to_string()))
                }),
            JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) => None,
        }
    }

    /// The values `for (const item of value)` and `const [a, b] = value`
    /// take: the items of an array, the code points of a string (each a
    /// string). Anything else is not iterable.
    pub fn iterate(&self) -> Result<Vec<Cow<'_, JsonValue>>, JsTypeError> {
        match self {
            JsonValue::Array(items) => Ok(items.iter().map(Cow::Borrowed).collect()),
            JsonValue::String(text) => Ok(text
                .chars()
                .map(|point| Cow::Owned(JsonValue::String(point.to_string())))
                .collect()),
            JsonValue::Null => Err(JsTypeError("null is not iterable".to_owned())),
            JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::Object(_) => {
                Err(JsTypeError("value is not iterable".to_owned()))
            }
        }
    }
}

impl Serialize for JsonValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            JsonValue::Null => serializer.serialize_unit(),
            JsonValue::Bool(flag) => serializer.serialize_bool(*flag),
            JsonValue::Number(x) => JsNum(*x).serialize(serializer),
            JsonValue::String(text) => serializer.serialize_str(text),
            JsonValue::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            JsonValue::Object(object) => object.serialize(serializer),
        }
    }
}

/// A primitive value: what `ToPrimitive` leaves.
#[derive(Debug, Clone, PartialEq)]
pub enum Primitive {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
}

impl Primitive {
    /// `ToNumber`
    pub fn to_number(&self) -> f64 {
        match self {
            Primitive::Undefined => f64::NAN,
            Primitive::Null => 0.0,
            Primitive::Bool(flag) => f64::from(u8::from(*flag)),
            Primitive::Number(x) => *x,
            Primitive::String(text) => to_number(text),
        }
    }

    /// `ToString`
    pub fn to_js_string(&self) -> String {
        match self {
            Primitive::Undefined => "undefined".to_owned(),
            Primitive::Null => "null".to_owned(),
            Primitive::Bool(flag) => flag.to_string(),
            Primitive::Number(x) => number_to_string(*x),
            Primitive::String(text) => text.clone(),
        }
    }

    /// `a + b` of two primitives: a string on either side joins the two as
    /// strings, else the numbers add.
    pub fn add(&self, other: &Primitive) -> Primitive {
        if matches!(self, Primitive::String(_)) || matches!(other, Primitive::String(_)) {
            Primitive::String(self.to_js_string() + &other.to_js_string())
        } else {
            Primitive::Number(self.to_number() + other.to_number())
        }
    }
}

/// `ToPrimitive(value)`, `None` being `undefined`. An array or object from
/// `JSON.parse` inherits a `valueOf` that answers the object itself, so its
/// `toString` decides with any hint: an array joins its items (a `null` item
/// as nothing), an object is "[object Object]". An own `toString` key holds
/// no function, so an object with one converts to nothing: a TypeError.
pub fn to_primitive(value: Option<&JsonValue>) -> Result<Primitive, JsTypeError> {
    Ok(match value {
        None => Primitive::Undefined,
        Some(JsonValue::Null) => Primitive::Null,
        Some(JsonValue::Bool(flag)) => Primitive::Bool(*flag),
        Some(JsonValue::Number(x)) => Primitive::Number(*x),
        Some(JsonValue::String(text)) => Primitive::String(text.clone()),
        Some(JsonValue::Array(items)) => {
            let mut joined = String::new();
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    joined.push(',');
                }
                if !matches!(item, JsonValue::Null) {
                    joined.push_str(&to_primitive(Some(item))?.to_js_string());
                }
            }
            Primitive::String(joined)
        }
        Some(JsonValue::Object(object)) => {
            if object.get("toString").is_some() {
                return Err(JsTypeError(
                    "Cannot convert object to primitive value".to_owned(),
                ));
            }
            Primitive::String("[object Object]".to_owned())
        }
    })
}

/// `ToPropertyKey(value)`: the key `table[value]` reads.
pub fn to_property_key(value: &JsonValue) -> Result<String, JsTypeError> {
    Ok(to_primitive(Some(value))?.to_js_string())
}

/// How deep `json_parse` nests arrays and objects. V8 parses deeper; the
/// values read here are dropped and written by recursion, which a deeper
/// tree would overflow. No glTF file nests a tenth as deep.
pub const JSON_MAX_DEPTH: usize = 128;

/// `JSON.parse(text)`: RFC 8259 JSON with no extension, white space being
/// space, tab, line feed and carriage return only. A number is the double
/// nearest its digits (`1e400` is Infinity); a key set twice keeps its first
/// place and its last value; `__proto__` is an own key like any other.
/// Nesting deeper than [`JSON_MAX_DEPTH`] is refused.
pub fn json_parse(text: &str) -> Result<JsonValue, JsonSyntaxError> {
    let mut parser = Parser {
        text,
        bytes: text.as_bytes(),
        at: 0,
    };
    parser.space();
    let value = parser.value(0)?;
    parser.space();
    if parser.at == parser.bytes.len() {
        Ok(value)
    } else {
        Err(JsonSyntaxError)
    }
}

struct Parser<'a> {
    text: &'a str,
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), JsonSyntaxError> {
        if self.peek() == Some(byte) {
            self.at += 1;
            Ok(())
        } else {
            Err(JsonSyntaxError)
        }
    }

    fn literal(&mut self, word: &str, value: JsonValue) -> Result<JsonValue, JsonSyntaxError> {
        if self.bytes.get(self.at..self.at + word.len()) == Some(word.as_bytes()) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(JsonSyntaxError)
        }
    }

    fn value(&mut self, depth: usize) -> Result<JsonValue, JsonSyntaxError> {
        match self.peek() {
            Some(b'{') => self.object(depth + 1),
            Some(b'[') => self.array(depth + 1),
            Some(b'"') => {
                self.at += 1;
                self.string().map(JsonValue::String)
            }
            Some(b't') => self.literal("true", JsonValue::Bool(true)),
            Some(b'f') => self.literal("false", JsonValue::Bool(false)),
            Some(b'n') => self.literal("null", JsonValue::Null),
            Some(b'-' | b'0'..=b'9') => self.number().map(JsonValue::Number),
            _ => Err(JsonSyntaxError),
        }
    }

    fn object(&mut self, depth: usize) -> Result<JsonValue, JsonSyntaxError> {
        if depth > JSON_MAX_DEPTH {
            return Err(JsonSyntaxError);
        }
        self.at += 1;
        let mut object = JsObject::new();
        self.space();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(JsonValue::Object(object));
        }
        loop {
            self.expect(b'"')?;
            let key = self.string()?;
            self.space();
            self.expect(b':')?;
            self.space();
            let value = self.value(depth)?;
            object.set(key, value);
            self.space();
            match self.peek() {
                Some(b',') => {
                    self.at += 1;
                    self.space();
                }
                Some(b'}') => {
                    self.at += 1;
                    return Ok(JsonValue::Object(object));
                }
                _ => return Err(JsonSyntaxError),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<JsonValue, JsonSyntaxError> {
        if depth > JSON_MAX_DEPTH {
            return Err(JsonSyntaxError);
        }
        self.at += 1;
        let mut items = Vec::new();
        self.space();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(JsonValue::Array(items));
        }
        loop {
            items.push(self.value(depth)?);
            self.space();
            match self.peek() {
                Some(b',') => {
                    self.at += 1;
                    self.space();
                }
                Some(b']') => {
                    self.at += 1;
                    return Ok(JsonValue::Array(items));
                }
                _ => return Err(JsonSyntaxError),
            }
        }
    }

    fn digits(&mut self) -> usize {
        let from = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        self.at - from
    }

    fn number(&mut self) -> Result<f64, JsonSyntaxError> {
        let from = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek() {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(JsonSyntaxError),
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return Err(JsonSyntaxError);
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(JsonSyntaxError);
            }
        }
        // the JSON number grammar is a part of Number()'s, with the same value
        self.text
            .get(from..self.at)
            .map(to_number)
            .ok_or(JsonSyntaxError)
    }

    fn hex4(&mut self) -> Result<u16, JsonSyntaxError> {
        let mut unit = 0u16;
        for _ in 0..4 {
            let digit = self
                .peek()
                .and_then(|byte| char::from(byte).to_digit(16))
                .ok_or(JsonSyntaxError)?;
            unit = unit << 4 | digit as u16;
            self.at += 1;
        }
        Ok(unit)
    }

    /// The string after its opening quote, up to and past its closing one.
    fn string(&mut self) -> Result<String, JsonSyntaxError> {
        let mut out = String::new();
        // a \u escape of a high surrogate, waiting for a \u escape of a low one
        let mut high: Option<u16> = None;
        let flush = |out: &mut String, high: &mut Option<u16>| {
            if high.take().is_some() {
                out.push(char::REPLACEMENT_CHARACTER);
            }
        };
        loop {
            let from = self.at;
            while matches!(self.peek(), Some(byte) if byte != b'"' && byte != b'\\' && byte >= 0x20)
            {
                self.at += 1;
            }
            if self.at > from {
                flush(&mut out, &mut high);
                // the run stops at an ASCII byte, so it ends on a character boundary
                out.push_str(self.text.get(from..self.at).ok_or(JsonSyntaxError)?);
            }
            match self.peek() {
                Some(b'"') => {
                    self.at += 1;
                    flush(&mut out, &mut high);
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.at += 1;
                    let escape = self.peek().ok_or(JsonSyntaxError)?;
                    self.at += 1;
                    let plain = match escape {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let unit = self.hex4()?;
                            if let Some(first) = high.take() {
                                if (0xDC00..0xE000).contains(&unit) {
                                    let point = 0x10000
                                        + ((u32::from(first) - 0xD800) << 10)
                                        + (u32::from(unit) - 0xDC00);
                                    out.push(
                                        char::from_u32(point)
                                            .unwrap_or(char::REPLACEMENT_CHARACTER),
                                    );
                                    continue;
                                }
                                out.push(char::REPLACEMENT_CHARACTER);
                            }
                            if (0xD800..0xDC00).contains(&unit) {
                                high = Some(unit);
                            } else {
                                out.push(
                                    char::from_u32(u32::from(unit))
                                        .unwrap_or(char::REPLACEMENT_CHARACTER),
                                );
                            }
                            continue;
                        }
                        _ => return Err(JsonSyntaxError),
                    };
                    flush(&mut out, &mut high);
                    out.push(plain);
                }
                // the end of the text, or a control character
                _ => return Err(JsonSyntaxError),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(text: &str) -> String {
        serde_json::to_string(&json_parse(text).unwrap()).unwrap()
    }

    #[test]
    fn parses_as_json_parse_does() {
        assert_eq!(
            parsed(r#"{"b":1,"2":0,"1":0,"a":2,"b":3}"#),
            r#"{"1":0,"2":0,"b":3,"a":2}"#
        );
        assert_eq!(parsed("[1e400,-0,0.1]"), "[null,0,0.1]");
        assert_eq!(parsed(r#""\ud83d\ude00\ud800x""#), "\"\u{1F600}\u{FFFD}x\"");
        assert_eq!(parsed(r#"{"__proto__":1}"#), r#"{"__proto__":1}"#);
        for refused in [
            "", "[1,]", "[01]", "[.5]", "[1.]", "\u{a0}1", "\"\t\"", "{} x", r#""\x""#,
        ] {
            assert!(json_parse(refused).is_err(), "{refused:?}");
        }
    }

    #[test]
    fn converts_as_javascript_does() {
        let object = json_parse(r#"{"toString":1}"#).unwrap();
        assert!(to_primitive(Some(&object)).is_err());
        let array = json_parse(r#"[1,null,[2,"a"],{}]"#).unwrap();
        assert_eq!(to_property_key(&array).unwrap(), "1,,2,a,[object Object]");
        let one = Primitive::String("1".to_owned());
        assert_eq!(one.add(&one).to_number(), 11.0);
        assert_eq!(text_decoder_decode(b"\xEF\xBB\xBFa\xFF"), "a\u{FFFD}");
    }
}
