//! Byte fields of the option structs as they cross JSON: a number array
//! (`JSON.stringify` of a `Uint8Array` spread into an array), a
//! `{"$bytes": "<base64>"}` wrapper, or a bare base64 string. One decoder
//! serves every struct holding bytes.

use std::fmt;

use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};

struct BytesVisitor;

impl<'de> Visitor<'de> for BytesVisitor {
    type Value = Vec<u8>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a byte array, a {\"$bytes\": base64} object or a base64 string")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<u8>, A::Error> {
        let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(1 << 20));
        while let Some(byte) = seq.next_element::<u8>()? {
            out.push(byte);
        }
        Ok(out)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Vec<u8>, A::Error> {
        let mut decoded = None;
        while let Some(key) = map.next_key::<String>()? {
            if key != "$bytes" {
                return Err(de::Error::unknown_field(&key, &["$bytes"]));
            }
            let text: String = map.next_value()?;
            decoded = Some(jscompat::atob(&text).map_err(de::Error::custom)?);
        }
        decoded.ok_or_else(|| de::Error::missing_field("$bytes"))
    }

    fn visit_str<E: de::Error>(self, text: &str) -> Result<Vec<u8>, E> {
        jscompat::atob(text).map_err(de::Error::custom)
    }
}

/// `deserialize_with` for a `Vec<u8>` field.
pub fn bytes<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
    d.deserialize_any(BytesVisitor)
}

struct OptionalVisitor;

impl<'de> Visitor<'de> for OptionalVisitor {
    type Value = Option<Vec<u8>>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("null or bytes")
    }

    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        bytes(d).map(Some)
    }
}

/// `deserialize_with` for an `Option<Vec<u8>>` field (pair with `default`).
pub fn optional_bytes<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
    d.deserialize_option(OptionalVisitor)
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Holder {
        #[serde(deserialize_with = "super::bytes")]
        b: Vec<u8>,
        #[serde(default, deserialize_with = "super::optional_bytes")]
        o: Option<Vec<u8>>,
    }

    fn parse(json: &str) -> Result<Holder, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn accepts_number_array_and_base64_forms() {
        assert_eq!(parse(r#"{"b":[1,2,255]}"#).unwrap().b, [1, 2, 255]);
        let h = parse(r#"{"b":{"$bytes":"AQL/"},"o":{"$bytes":"AQ=="}}"#).unwrap();
        assert_eq!(h.b, [1, 2, 255]);
        assert_eq!(h.o.unwrap(), [1]);
        assert_eq!(parse(r#"{"b":"AQL/"}"#).unwrap().b, [1, 2, 255]);
        assert!(parse(r#"{"b":[],"o":null}"#).unwrap().o.is_none());
    }

    #[test]
    fn rejects_invalid_input() {
        assert!(parse(r#"{"b":{"$bytes":"@@@@"}}"#).is_err());
        assert!(parse(r#"{"b":{"$bytes":"A"}}"#).is_err());
        assert!(parse(r#"{"b":[256]}"#).is_err());
        assert!(parse(r#"{"b":{"other":"AQ=="}}"#).is_err());
    }
}
