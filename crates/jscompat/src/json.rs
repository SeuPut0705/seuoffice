use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::io;

use crate::number_to_string;

/// A JavaScript number in a model value. It serializes the way
/// `JSON.stringify` writes it: NaN and the infinities as `null`, -0 as `0`.
#[derive(Debug, Clone, Copy, Default, PartialEq, PartialOrd)]
pub struct JsNum(pub f64);

impl Serialize for JsNum {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let x = self.0;
        if !x.is_finite() {
            serializer.serialize_unit()
        } else if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
            serializer.serialize_i64(x as i64)
        } else {
            serializer.serialize_f64(x)
        }
    }
}

impl<'de> Deserialize<'de> for JsNum {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // JSON.stringify maps every non-finite number to null, NaN's wire
        // representative; a caller that must keep an infinity spells it.
        match Option::<WireNumber>::deserialize(deserializer)? {
            None => Ok(JsNum(f64::NAN)),
            Some(WireNumber::Number(value)) => Ok(JsNum(value)),
            Some(WireNumber::Text(text)) => match spelled(&text) {
                Some(value) => Ok(JsNum(value)),
                // a product caller handed a text where a number is declared:
                // the TypeScript wrote it into the XML as it was
                None if lenient() => Ok(JsNum(crate::to_number(&text))),
                None => Err(serde::de::Error::custom(format!("a number, not the text {text:?}"))),
            },
        }
    }
}

std::thread_local! {
    static LENIENT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether values are read inside [`reading_leniently`].
pub fn lenient() -> bool {
    LENIENT.with(std::cell::Cell::get)
}

/// Runs `read` with values read as the TypeScript reads what it is handed:
/// its types are structural and unchecked at run time, so a model object may
/// carry keys its type does not have (they are skipped) and a number field a
/// text (read as `Number(text)`). Outside it a value is read strictly, as the
/// gate's comparison (h) demands.
pub fn reading_leniently<T>(read: impl FnOnce() -> T) -> T {
    let was = LENIENT.with(|flag| flag.replace(true));
    let out = read();
    LENIENT.with(|flag| flag.set(was));
    out
}

/// A number or a text, read without buffering (an untagged enum would copy every number of a model first).
enum WireNumber {
    Number(f64),
    Text(String),
}

impl<'de> Deserialize<'de> for WireNumber {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visit;
        impl serde::de::Visitor<'_> for Visit {
            type Value = WireNumber;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a number")
            }
            fn visit_f64<E>(self, value: f64) -> Result<WireNumber, E> {
                Ok(WireNumber::Number(value))
            }
            fn visit_i64<E>(self, value: i64) -> Result<WireNumber, E> {
                Ok(WireNumber::Number(value as f64))
            }
            fn visit_u64<E>(self, value: u64) -> Result<WireNumber, E> {
                Ok(WireNumber::Number(value as f64))
            }
            fn visit_str<E>(self, value: &str) -> Result<WireNumber, E> {
                Ok(WireNumber::Text(value.to_owned()))
            }
        }
        deserializer.deserialize_any(Visit)
    }
}

/// The JavaScript spelling of a number JSON cannot carry: `String(NaN)`, `String(Infinity)`, `String(-Infinity)`.
fn spelled(text: &str) -> Option<f64> {
    match text {
        "NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

/// A `number` field as a host sends it: a JSON number, `null` for NaN, or
/// the spelling of NaN or an infinity. Any other text is NaN: the
/// TypeScript reads such a field through `typeof value === 'number'`, so a
/// string there is a number it cannot use.
pub fn js_f64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    Ok(match Option::<WireNumber>::deserialize(deserializer)? {
        None => f64::NAN,
        Some(WireNumber::Number(value)) => value,
        Some(WireNumber::Text(text)) => spelled(&text).unwrap_or(f64::NAN),
    })
}

/// `js_f64` for an optional field: `null` or no key is `None`.
pub fn js_f64_opt<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    Ok(match Option::<WireNumber>::deserialize(deserializer)? {
        None => None,
        Some(WireNumber::Number(value)) => Some(value),
        Some(WireNumber::Text(text)) => Some(spelled(&text).unwrap_or(f64::NAN)),
    })
}

/// `js_f64` for a field where `null` and no key differ: no key is `None`
/// (with `#[serde(default)]`), `null` is `Some(None)`.
pub fn js_f64_nullable<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<f64>>, D::Error> {
    Ok(Some(match Option::<WireNumber>::deserialize(deserializer)? {
        None => None,
        Some(WireNumber::Number(value)) => Some(value),
        Some(WireNumber::Text(text)) => Some(spelled(&text).unwrap_or(f64::NAN)),
    }))
}

/// `JSON.stringify` number spelling, including numbers stored inside a JSON value.
#[derive(Default)]
struct JsFormatter;

impl serde_json::ser::Formatter for JsFormatter {
    fn write_f32<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f32) -> io::Result<()> {
        self.write_f64(writer, f64::from(value))
    }

    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(number_to_string(value).as_bytes())
    }
}

/// Serializes a model directly, without passing through `serde_json::Value` and reordering it.
pub fn json_to_string<T: ?Sized + Serialize>(value: &T) -> serde_json::Result<String> {
    let mut bytes = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, JsFormatter);
    value.serialize(&mut serializer)?;
    // The JSON serializer emits UTF-8; no user input can introduce an invalid byte here.
    Ok(String::from_utf8(bytes).expect("a JSON serializer emits UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_numbers_keep_javascript_json_spelling() {
        let numbers = [
            JsNum(-0.0),
            JsNum(9_007_199_254_740_992.0),
            JsNum(1e21),
            JsNum(1e-7),
            JsNum(0.000001),
            JsNum(f64::NAN),
            JsNum(f64::INFINITY),
        ];
        assert_eq!(
            json_to_string(&numbers).unwrap(),
            "[0,9007199254740992,1e+21,1e-7,0.000001,null,null]"
        );
        let number: JsNum = serde_json::from_str("null").unwrap();
        assert!(number.0.is_nan());
        assert_eq!(json_to_string(&number).unwrap(), "null");
    }

    #[test]
    fn opaque_model_numbers_use_the_same_formatter() {
        let value: serde_json::Value =
            serde_json::from_str(r#"{"big":1e21,"small":1e-7,"integer":9007199254740992.0}"#)
                .unwrap();
        assert_eq!(
            json_to_string(&value).unwrap(),
            r#"{"big":1e+21,"small":1e-7,"integer":9007199254740992}"#
        );
    }
}
