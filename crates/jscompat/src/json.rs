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
        // JSON.stringify maps every non-finite number to null. NaN is its wire representative.
        Option::<f64>::deserialize(deserializer).map(|value| JsNum(value.unwrap_or(f64::NAN)))
    }
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
            JsNum(-0.0), JsNum(9_007_199_254_740_992.0), JsNum(1e21),
            JsNum(1e-7), JsNum(0.000001), JsNum(f64::NAN), JsNum(f64::INFINITY),
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
        let value: serde_json::Value = serde_json::from_str(
            r#"{"big":1e21,"small":1e-7,"integer":9007199254740992.0}"#,
        ).unwrap();
        assert_eq!(
            json_to_string(&value).unwrap(),
            r#"{"big":1e+21,"small":1e-7,"integer":9007199254740992}"#
        );
    }
}
