//! What the generated model types read and write through: the strict key
//! reading of an object, and the wire forms of `Map`, `Uint8Array`, `true`
//! and `false` as a type.

use std::fmt;
use std::marker::PhantomData;
use std::sync::Arc;

use jscompat::JsObject;
use serde::de::{DeserializeOwned, Error as _, MapAccess, Unexpected, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The keys of one model object type, as a fieldless enum in declaration
/// order.
pub trait FieldKey: Copy + 'static {
    /// The keys as the TypeScript writes them, in declaration order.
    const NAMES: &'static [&'static str];

    fn from_name(name: &str) -> Option<Self>;

    /// The place of the key in declaration order.
    fn index(self) -> usize;

    fn name(self) -> &'static str {
        Self::NAMES[self.index()]
    }
}

/// A key of an object being read: a key the type does not have is refused,
/// or skipped (`None`) inside `jscompat::reading_leniently`.
pub(super) struct Key<K>(pub(super) Option<K>);

impl<'de, K: FieldKey> Deserialize<'de> for Key<K> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Name<K>(PhantomData<K>);
        impl<K: FieldKey> Visitor<'_> for Name<K> {
            type Value = Key<K>;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a key")
            }

            fn visit_str<E: serde::de::Error>(self, name: &str) -> Result<Key<K>, E> {
                match K::from_name(name) {
                    Some(key) => Ok(Key(Some(key))),
                    None if jscompat::lenient() => Ok(Key(None)),
                    None => Err(E::unknown_field(name, K::NAMES)),
                }
            }
        }
        deserializer.deserialize_identifier(Name(PhantomData))
    }
}

/// The most keys an object type may have: what [`Seen`] holds. Every
/// generated key enum asserts it at compile time.
pub(super) const MAX_KEYS: usize = 256;

/// The keys of one object met so far, by their index.
#[derive(Default)]
pub(super) struct Seen([u64; MAX_KEYS / 64]);

impl Seen {
    /// False where the key was met before.
    pub(super) fn insert(&mut self, index: usize) -> bool {
        let (word, bit) = (index / 64, 1u64 << (index % 64));
        let new = self.0[word] & bit == 0;
        self.0[word] |= bit;
        new
    }
}

/// The one candidate a union value reads as.
pub(super) fn one_of<T, E: serde::de::Error, const N: usize>(
    name: &str,
    candidates: [Option<T>; N],
) -> Result<T, E> {
    let mut matching = candidates.into_iter().flatten();
    match (matching.next(), matching.next()) {
        (Some(value), None) => Ok(value),
        (None, _) => Err(E::custom(format_args!(
            "no variant of {name} reads the value"
        ))),
        (Some(_), Some(_)) => Err(E::custom(format_args!(
            "more than one variant of {name} reads the value"
        ))),
    }
}

/// Reads an enum of strings from a JSON string and nothing else. The reader
/// serde derives also takes `{"value": null}`, which `JSON.stringify` never
/// writes for a string. A string the enum does not name is refused, or held
/// as `unlisted` inside `jscompat::reading_leniently`.
pub(super) fn string_enum<'de, D: Deserializer<'de>, T>(
    deserializer: D,
    name: &'static str,
    unlisted: fn(std::sync::Arc<String>) -> T,
    parse: fn(&str) -> Option<T>,
) -> Result<T, D::Error> {
    struct Text<T>(
        &'static str,
        fn(std::sync::Arc<String>) -> T,
        fn(&str) -> Option<T>,
    );
    impl<T> Visitor<'_> for Text<T> {
        type Value = T;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            write!(formatter, "a string of {}", self.0)
        }

        fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<T, E> {
            match (self.2)(text) {
                Some(value) => Ok(value),
                None if jscompat::lenient() => Ok((self.1)(std::sync::Arc::new(text.to_owned()))),
                None => Err(E::invalid_value(Unexpected::Str(text), &self)),
            }
        }
    }
    deserializer.deserialize_str(Text(name, unlisted, parse))
}

/// A value of a field whose type has no null: `None` where the JSON holds
/// `null`, read inside `jscompat::reading_leniently` as the TypeScript holds
/// it (a caller's object may carry null where the type says a string);
/// outside it null is refused as the type's own reader refuses it.
pub(super) struct OrAbsent<T>(pub Option<T>);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for OrAbsent<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if jscompat::lenient() {
            Option::<T>::deserialize(deserializer).map(OrAbsent)
        } else {
            T::deserialize(deserializer).map(|value| OrAbsent(Some(value)))
        }
    }
}

/// A required field the object lacks: read leniently it is the TypeScript's
/// undefined, which the caller stands in for; strictly it is refused.
pub(super) fn absent<E: serde::de::Error>(key: &'static str) -> Result<(), E> {
    if jscompat::lenient() {
        Ok(())
    } else {
        Err(E::missing_field(key))
    }
}

/// A `Record<number, V>`: a [`JsObject`] every key of which is a number as
/// JavaScript writes one (`String(Number(key)) === key`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct NumberRecord<V>(pub JsObject<V>);

impl<V> Default for NumberRecord<V> {
    fn default() -> Self {
        Self(JsObject::new())
    }
}

impl<V> std::ops::Deref for NumberRecord<V> {
    type Target = JsObject<V>;

    fn deref(&self) -> &JsObject<V> {
        &self.0
    }
}

impl<V> std::ops::DerefMut for NumberRecord<V> {
    fn deref_mut(&mut self) -> &mut JsObject<V> {
        &mut self.0
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for NumberRecord<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let record = JsObject::<V>::deserialize(deserializer)?;
        for (key, _) in record.entries() {
            if jscompat::number_to_string(jscompat::to_number(key)) != key {
                return Err(D::Error::custom(format_args!(
                    "the key {key:?} is no number"
                )));
            }
        }
        Ok(Self(record))
    }
}

/// Reads `json` as `T` and writes it again as `JSON.stringify` would, numbers
/// inside opaque values too.
pub(super) fn round_trip<T: DeserializeOwned + Serialize>(json: &str) -> Result<String, String> {
    let value: T = serde_json::from_str(json).map_err(|error| error.to_string())?;
    jscompat::json_to_string(&value).map_err(|error| error.to_string())
}

/// A JavaScript `Map` as its entries, `[[key, value], ...]`, in insertion
/// order. The entries are read as they are, a key the same as an earlier
/// one too: `JSON.stringify` writes the distinct keys NaN, Infinity and
/// -Infinity of one Map all as `null`, so keys equal on the wire do not mean
/// a key twice in the Map.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MapEntries<K, V>(pub Vec<(K, V)>);

impl<K, V> Default for MapEntries<K, V> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

/// A string held once however many values refer to it: the data URL of a media
/// part. The TypeScript has one string per part and every image points at
/// it; cloning this clones the pointer, and the JSON it writes and reads is the
/// plain string.
#[derive(Clone, Default, PartialEq, Eq, Hash)]
pub struct SharedStr(Arc<str>);

impl SharedStr {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether both values are the one allocation.
    pub fn ptr_eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    /// How many values hold this allocation.
    pub fn holders(&self) -> usize {
        Arc::strong_count(&self.0)
    }
}

impl std::ops::Deref for SharedStr {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for SharedStr {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SharedStr {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        fmt::Debug::fmt(&*self.0, formatter)
    }
}

impl fmt::Display for SharedStr {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        fmt::Display::fmt(&*self.0, formatter)
    }
}

impl From<String> for SharedStr {
    fn from(text: String) -> Self {
        Self(Arc::from(text))
    }
}

impl From<&str> for SharedStr {
    fn from(text: &str) -> Self {
        Self(Arc::from(text))
    }
}

impl PartialEq<str> for SharedStr {
    fn eq(&self, other: &str) -> bool {
        &*self.0 == other
    }
}

impl PartialEq<&str> for SharedStr {
    fn eq(&self, other: &&str) -> bool {
        &*self.0 == *other
    }
}

impl Serialize for SharedStr {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SharedStr {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Text;
        impl Visitor<'_> for Text {
            type Value = SharedStr;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a string")
            }

            fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<SharedStr, E> {
                Ok(SharedStr::from(text))
            }

            fn visit_string<E: serde::de::Error>(self, text: String) -> Result<SharedStr, E> {
                Ok(SharedStr::from(text))
            }
        }
        deserializer.deserialize_str(Text)
    }
}

/// A `Uint8Array`: on the wire `{ "$bytes": base64 }`, padded, canonical.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Bytes(pub Vec<u8>);

const BYTES_KEY: &str = "$bytes";

impl Serialize for Bytes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry(BYTES_KEY, &jscompat::base64(&self.0))?;
        map.end()
    }
}

impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = Bytes;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("{ \"$bytes\": base64 }")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Bytes, A::Error> {
                let mut bytes = None;
                while let Some(key) = map.next_key::<String>()? {
                    if key != BYTES_KEY {
                        return Err(A::Error::unknown_field(&key, &[BYTES_KEY]));
                    }
                    if bytes.is_some() {
                        return Err(A::Error::duplicate_field(BYTES_KEY));
                    }
                    let text: String = map.next_value()?;
                    let decoded = decode_base64(&text)
                        .ok_or_else(|| A::Error::custom("not padded, canonical base64"))?;
                    bytes = Some(Bytes(decoded));
                }
                bytes.ok_or_else(|| A::Error::missing_field(BYTES_KEY))
            }
        }
        deserializer.deserialize_map(Fields)
    }
}

/// Standard base64 with padding, in the one form `jscompat::base64` writes:
/// the bits the padding leaves unused are zero.
fn decode_base64(text: &str) -> Option<Vec<u8>> {
    fn sextet(byte: u8) -> Option<u32> {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        Some(u32::from(value))
    }
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let groups = bytes.len() / 4;
    let mut out = Vec::with_capacity(groups * 3);
    for (at, group) in bytes.chunks(4).enumerate() {
        let padding = group.iter().rev().take_while(|&&byte| byte == b'=').count();
        if padding > 2 || (padding > 0 && at + 1 != groups) {
            return None;
        }
        let mut bits = 0u32;
        for &byte in &group[..4 - padding] {
            bits = (bits << 6) | sextet(byte)?;
        }
        // "==" leaves the low 4 bits of the last sextet unused, "=" the low 2
        let unused = [0, 0b11, 0b1111][padding];
        if bits & unused != 0 {
            return None;
        }
        bits <<= 6 * padding;
        let [_, first, second, third] = bits.to_be_bytes();
        out.extend_from_slice(&[first, second, third][..3 - padding]);
    }
    Some(out)
}

/// The literal type `true`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct True;

/// The literal type `false`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct False;

impl Serialize for True {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for True {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? {
            Ok(True)
        } else {
            Err(D::Error::invalid_value(Unexpected::Bool(false), &"true"))
        }
    }
}

impl Serialize for False {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(false)
    }
}

impl<'de> Deserialize<'de> for False {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? {
            Err(D::Error::invalid_value(Unexpected::Bool(true), &"false"))
        } else {
            Ok(False)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_reads_only_what_it_would_write() {
        assert_eq!(decode_base64("").unwrap(), b"");
        assert_eq!(decode_base64("AAEC/w==").unwrap(), [0, 1, 2, 255]);
        assert_eq!(decode_base64("YWJj").unwrap(), b"abc");
        assert_eq!(decode_base64("YWI=").unwrap(), b"ab");
        for refused in [
            "YWJ", "YQ=", "YR==", "YWJ=", "Y===", "YQ==YQ==", "YW J", "Y=Q=",
        ] {
            assert_eq!(decode_base64(refused), None, "{refused}");
        }
    }

    #[test]
    fn a_map_keeps_its_entries_in_order() {
        let entries: MapEntries<String, u8> = serde_json::from_str(r#"[["b",1],["a",2]]"#).unwrap();
        assert_eq!(
            serde_json::to_string(&entries).unwrap(),
            r#"[["b",1],["a",2]]"#
        );
        let numbers = |json: &str| serde_json::from_str::<MapEntries<jscompat::JsNum, u8>>(json);
        // new Map([[NaN, 1], [Infinity, 2], [-Infinity, 3]]) as JSON.stringify writes its entries
        let nonfinite = r#"[[null,1],[null,2],[null,3]]"#;
        assert_eq!(
            serde_json::to_string(&numbers(nonfinite).unwrap()).unwrap(),
            nonfinite
        );
        assert!(
            numbers(r#"[["2",1]]"#).is_err(),
            "a string key in a Map of numbers"
        );
        assert!(serde_json::from_str::<MapEntries<String, u8>>(r#"[[2,1]]"#).is_err());
        assert!(numbers(r#"[[2]]"#).is_err(), "an entry without a value");
        assert!(
            numbers(r#"[[2,1,0]]"#).is_err(),
            "an entry with more than a key and a value"
        );
    }

    #[test]
    fn a_literal_type_reads_only_its_value() {
        assert!(serde_json::from_str::<True>("true").is_ok());
        assert!(serde_json::from_str::<True>("false").is_err());
        assert!(serde_json::from_str::<False>("false").is_ok());
        assert!(serde_json::from_str::<False>("null").is_err());
    }
}
