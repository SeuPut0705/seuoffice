//! JavaScript objects whose key order shows.
//!
//! An object keeps its keys in the order they were first set, with the keys
//! that are array indices ("0", "17") moved to the front in numeric order.
//! `JSON.stringify`, `Object.keys` and a spread all go by that order, so a
//! result that is to equal the TypeScript's has to keep it.
//!
//! - [`JsObject`] is an object keyed by data: `Record<string, V>`.
//! - [`js_object!`] declares an object with the keys of a TypeScript
//!   interface, where the order of the keys depends on the path the code
//!   took: a key set under a condition, a spread, a `delete`. An object whose
//!   keys are always written in one order is a plain struct with its fields
//!   in that order.

use std::fmt;
use std::marker::PhantomData;
use std::ops::Deref;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, Serializer};

use crate::JsMap;

/// The index a JavaScript object orders a key by, when the key is an array
/// index: the canonical decimal form of an integer below 2^32 - 1 ("0", "17",
/// not "017").
pub fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || !key.starts_with('0');
    let all_digits = !key.is_empty() && key.bytes().all(|byte| byte.is_ascii_digit());
    (canonical && all_digits)
        .then(|| key.parse::<u32>().ok())
        .flatten()
        .filter(|index| *index != u32::MAX)
}

/// A plain JavaScript object used as a table: `Record<string, V>`, written
/// with `record[key] = value` or `setOwn(record, key, value)`. Every key is
/// an own entry, `__proto__` too.
///
/// It serializes as a JSON object in the order of `Object.keys`.
#[derive(Debug, Clone)]
pub struct JsObject<V>(JsMap<V>);

impl<V> Default for JsObject<V> {
    fn default() -> Self {
        Self(JsMap::new())
    }
}

impl<V: PartialEq> PartialEq for JsObject<V> {
    fn eq(&self, other: &Self) -> bool {
        self.0.len() == other.0.len()
            && self
                .0
                .iter()
                .all(|(key, value)| other.get(key) == Some(value))
    }
}

impl<V: Eq> Eq for JsObject<V> {}

impl<V> JsObject<V> {
    pub fn new() -> Self {
        Self::default()
    }

    /// `record[key] = value`: a key that is there keeps its place.
    pub fn set(&mut self, key: impl Into<String>, value: V) {
        self.0.set(key, value);
    }

    /// `record[key]` for an own key.
    pub fn get(&self, key: &str) -> Option<&V> {
        self.0.get(key)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.0.get_mut(key)
    }

    /// `Object.keys(record).length`
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut V> {
        self.0.values_mut()
    }

    /// `Object.assign(record, source)`; a spread `{ ...a, ...b }` is a clone
    /// of `a` with `b` assigned.
    pub fn assign(&mut self, source: &Self)
    where
        V: Clone,
    {
        for (key, value) in source.entries() {
            self.set(key, value.clone());
        }
    }

    /// `Object.entries(record)`: array indices first, ascending, then the
    /// other keys in the order they were set.
    pub fn entries(&self) -> Vec<(&str, &V)> {
        let mut entries: Vec<(&str, &V)> = self.0.iter().collect();
        if entries.iter().any(|(key, _)| array_index(key).is_some()) {
            // stable: the keys that are no index keep the order they were set in
            entries.sort_by_key(|(key, _)| match array_index(key) {
                Some(index) => (0, index),
                None => (1, 0),
            });
        }
        entries
    }
}

impl<V> FromIterator<(String, V)> for JsObject<V> {
    fn from_iter<I: IntoIterator<Item = (String, V)>>(entries: I) -> Self {
        Self(entries.into_iter().collect())
    }
}

impl<V: Serialize> Serialize for JsObject<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let entries = self.entries();
        let mut map = serializer.serialize_map(Some(entries.len()))?;
        for (key, value) in entries {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for JsObject<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Entries<V>(PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for Entries<V> {
            type Value = JsObject<V>;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("an object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<JsObject<V>, A::Error> {
                let mut out = JsObject::new();
                while let Some((key, value)) = map.next_entry::<String, V>()? {
                    out.set(key, value);
                }
                Ok(out)
            }
        }
        deserializer.deserialize_map(Entries(PhantomData))
    }
}

/// Counts the keys set in this process: a key set later has a higher number.
static KEYS_SET: AtomicU64 = AtomicU64::new(1);

/// One key of an object declared with [`js_object!`].
///
/// It reads as an `Option`: `None` where the object has no such key, and
/// where the key holds `undefined`. It is written through the methods below,
/// each named by the JavaScript it stands for, and they keep track of when
/// the key was first set: that is its place among the keys of the object.
#[derive(Debug, Clone, Copy)]
pub struct Slot<T> {
    value: Option<T>,
    /// 0 where the object has no such key.
    set_at: u64,
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Self {
            value: None,
            set_at: 0,
        }
    }
}

/// The same key state and value; when the key was set is not compared.
impl<T: PartialEq> PartialEq for Slot<T> {
    fn eq(&self, other: &Self) -> bool {
        self.has_key() == other.has_key() && self.value == other.value
    }
}

impl<T> Deref for Slot<T> {
    type Target = Option<T>;

    fn deref(&self) -> &Option<T> {
        &self.value
    }
}

impl<T> Slot<T> {
    /// `{ key: value }`: a key written in an object literal. The fields of a
    /// Rust struct expression are evaluated in the order they are written, so
    /// writing them in the order of the TypeScript literal gives its order.
    pub fn of(value: T) -> Self {
        let mut slot = Self::default();
        slot.set(value);
        slot
    }

    /// `...(value !== undefined ? { key: value } : {})`
    pub fn maybe(value: Option<T>) -> Self {
        value.map_or_else(Self::default, Self::of)
    }

    /// `object.key = value`: a new key goes last, a key that is there keeps
    /// its place.
    pub fn set(&mut self, value: T) {
        self.assign(Some(value));
    }

    /// `object.key = value` where the value may be `undefined`: the object
    /// has the key either way.
    pub fn assign(&mut self, value: Option<T>) {
        if self.set_at == 0 {
            self.set_at = KEYS_SET.fetch_add(1, Ordering::Relaxed);
        }
        self.value = value;
    }

    /// `if (value !== undefined) object.key = value`
    pub fn set_some(&mut self, value: Option<T>) {
        if value.is_some() {
            self.assign(value);
        }
    }

    /// `delete object.key`
    pub fn delete(&mut self) {
        *self = Self::default();
    }

    /// `'key' in object`: also true where the key holds `undefined`.
    pub fn has_key(&self) -> bool {
        self.set_at != 0
    }

    /// `object.key.inner = value`: the value of a key mutated in place; the
    /// key keeps its place. `None` where the object has no such key or it
    /// holds `undefined`.
    pub fn as_mut(&mut self) -> Option<&mut T> {
        self.value.as_mut()
    }

    pub fn into_option(self) -> Option<T> {
        self.value
    }

    /// When the key was set, for ordering the keys of one object.
    #[doc(hidden)]
    pub fn set_at(&self) -> Option<u64> {
        self.has_key().then_some(self.set_at)
    }
}

/// The length of a field name as a key: without its underscores and without
/// the `r#` of a raw identifier.
#[doc(hidden)]
pub const fn camel_len(snake: &str) -> usize {
    let bytes = snake.as_bytes();
    let mut at = raw_prefix(bytes);
    let mut len = 0;
    while at < bytes.len() {
        if bytes[at] != b'_' {
            len += 1;
        }
        at += 1;
    }
    len
}

/// A field name as the key the TypeScript writes: `first_line` is `firstLine`.
#[doc(hidden)]
pub const fn camel<const N: usize>(snake: &str) -> [u8; N] {
    let bytes = snake.as_bytes();
    let mut out = [0; N];
    let mut at = raw_prefix(bytes);
    let mut len = 0;
    let mut upper = false;
    while at < bytes.len() {
        if bytes[at] == b'_' {
            upper = true;
        } else {
            out[len] = if upper {
                bytes[at].to_ascii_uppercase()
            } else {
                bytes[at]
            };
            len += 1;
            upper = false;
        }
        at += 1;
    }
    out
}

const fn raw_prefix(bytes: &[u8]) -> usize {
    if bytes.len() > 2 && bytes[0] == b'r' && bytes[1] == b'#' {
        2
    } else {
        0
    }
}

/// Declares a JavaScript object with the keys of a TypeScript interface whose
/// order depends on the path the code took.
///
/// ```
/// jscompat::js_object! {
///     /// Character-unit indents.
///     #[derive(Debug, Clone, PartialEq)]
///     pub struct Indents {
///         pub left: f64,
///         pub first_line: f64,
///     }
/// }
/// let mut indents = Indents::default();
/// indents.first_line.set(2.0);
/// indents.left.set(1.0);
/// assert_eq!(serde_json::to_string(&indents).unwrap(), r#"{"firstLine":2.0,"left":1.0}"#);
/// ```
///
/// Every field is a [`Slot`] of the type written, and its key is the field
/// name in camel case. The macro gives the struct `Default` (no key),
/// `Serialize` (the keys in the order they were set, without those that hold
/// `undefined`), and `keys`, `has_no_key` and `assign`. With `deserialize;`
/// before the struct it also gives `Deserialize`, which sets the keys in the
/// order of the input and reads `null` as no key.
#[macro_export]
macro_rules! js_object {
    (
        deserialize;
        $($declaration:tt)*
    ) => {
        $crate::js_object! { @declare [deserialize] $($declaration)* }
    };
    (
        @declare [$($deserialize:ident)?]
        $(#[$meta:meta])*
        $vis:vis struct $name:ident {
            $(
                $(#[$field_meta:meta])*
                $field_vis:vis $field:ident : $ty:ty
            ),* $(,)?
        }
    ) => {
        $(#[$meta])*
        $vis struct $name {
            $(
                $(#[$field_meta])*
                $field_vis $field: $crate::Slot<$ty>,
            )*
        }

        const _: () = {
            #[allow(non_camel_case_types, dead_code)]
            #[derive(Clone, Copy, PartialEq)]
            enum Key {
                $($field,)*
            }

            const KEYS: &[(Key, &str)] = &[
                $((Key::$field, {
                    const SNAKE: &str = stringify!($field);
                    const LEN: usize = $crate::camel_len(SNAKE);
                    const BYTES: [u8; LEN] = $crate::camel::<LEN>(SNAKE);
                    match ::core::str::from_utf8(&BYTES) {
                        Ok(key) => key,
                        Err(_) => panic!("a field name is ASCII"),
                    }
                }),)*
            ];

            impl ::core::default::Default for $name {
                fn default() -> Self {
                    Self {
                        $($field: $crate::Slot::default(),)*
                    }
                }
            }

            impl $name {
                /// The keys the object has, in the order they were set.
                fn keys_set(&self) -> ::std::vec::Vec<(Key, &'static str)> {
                    let mut set: ::std::vec::Vec<(u64, (Key, &'static str))> = KEYS
                        .iter()
                        .filter_map(|&(key, name)| {
                            let set_at = match key {
                                $(Key::$field => self.$field.set_at(),)*
                            };
                            set_at.map(|set_at| (set_at, (key, name)))
                        })
                        .collect();
                    set.sort_unstable_by_key(|&(set_at, _)| set_at);
                    set.into_iter().map(|(_, key)| key).collect()
                }

                /// `Object.keys(this)`, the keys that hold `undefined` included.
                #[allow(dead_code)]
                pub fn keys(&self) -> ::std::vec::Vec<&'static str> {
                    self.keys_set().into_iter().map(|(_, name)| name).collect()
                }

                /// `Object.keys(this).length === 0`
                #[allow(dead_code)]
                pub fn has_no_key(&self) -> bool {
                    true $(&& !self.$field.has_key())*
                }

                /// `Object.assign(this, source)`: the keys of `source` in its
                /// order, each keeping its place here or going last. A spread
                /// `{ ...a, ...b }` is a clone of `a` with `b` assigned.
                #[allow(dead_code)]
                pub fn assign(&mut self, source: &Self) {
                    for (key, _) in source.keys_set() {
                        match key {
                            $(Key::$field => self.$field.assign((*source.$field).clone()),)*
                        }
                    }
                }
            }

            impl $crate::serde::Serialize for $name {
                fn serialize<S: $crate::serde::Serializer>(
                    &self,
                    serializer: S,
                ) -> ::core::result::Result<S::Ok, S::Error> {
                    use $crate::serde::ser::SerializeMap as _;
                    let mut map = serializer.serialize_map(::core::option::Option::None)?;
                    for (key, name) in self.keys_set() {
                        match key {
                            $(Key::$field => {
                                // JSON.stringify leaves out a key that holds undefined
                                if let ::core::option::Option::Some(value) = &*self.$field {
                                    map.serialize_entry(name, value)?;
                                }
                            })*
                        }
                    }
                    map.end()
                }
            }

            $crate::js_object! { @deserialize [$($deserialize)?] $name { $($field : $ty),* } }
        };
    };
    (@deserialize [] $name:ident { $($field:ident : $ty:ty),* }) => {};
    (@deserialize [deserialize] $name:ident { $($field:ident : $ty:ty),* }) => {
        impl<'de> $crate::serde::Deserialize<'de> for $name {
            fn deserialize<D: $crate::serde::Deserializer<'de>>(
                deserializer: D,
            ) -> ::core::result::Result<Self, D::Error> {
                struct Keys;
                impl<'de> $crate::serde::de::Visitor<'de> for Keys {
                    type Value = $name;

                    fn expecting(
                        &self,
                        formatter: &mut ::core::fmt::Formatter,
                    ) -> ::core::fmt::Result {
                        formatter.write_str(concat!("an object: ", stringify!($name)))
                    }

                    fn visit_map<A: $crate::serde::de::MapAccess<'de>>(
                        self,
                        mut map: A,
                    ) -> ::core::result::Result<$name, A::Error> {
                        // the expansion uses one or both, by the field types
                        #[allow(unused_imports)]
                        use $crate::wire::{Owned as _, StaticStrRead as _};
                        let mut out = <$name>::default();
                        while let ::core::option::Option::Some(name) =
                            map.next_key::<::std::string::String>()?
                        {
                            let key = KEYS.iter().find(|(_, key)| *key == name);
                            match key {
                                $(::core::option::Option::Some((Key::$field, _)) => {
                                    out.$field.set_some(
                                        (&$crate::wire::Probe::<$ty>::new()).read(&mut map)?,
                                    );
                                })*
                                ::core::option::Option::None => {
                                    map.next_value::<$crate::serde::de::IgnoredAny>()?;
                                }
                            }
                        }
                        ::core::result::Result::Ok(out)
                    }
                }
                deserializer.deserialize_map(Keys)
            }
        }
    };
    ($(#[$meta:meta])* $vis:vis struct $($rest:tt)*) => {
        $crate::js_object! { @declare [] $(#[$meta])* $vis struct $($rest)* }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    js_object! {
        deserialize;
        #[derive(Debug, Clone, PartialEq)]
        struct Indents {
            left: f64,
            right: f64,
            first_line: f64,
            r#type: String,
        }
    }

    fn json(value: &impl Serialize) -> String {
        serde_json::to_string(value).unwrap_or_default()
    }

    #[test]
    fn a_record_lists_array_indices_first_and_the_rest_as_set() {
        let mut record = JsObject::new();
        for key in ["b", "10", "__proto__", "2", "a", "01", "4294967295", "b"] {
            record.set(key, key.len());
        }
        assert_eq!(
            json(&record),
            r#"{"2":1,"10":2,"b":1,"__proto__":9,"a":1,"01":2,"4294967295":10}"#
        );
        let again: JsObject<usize> = serde_json::from_str(&json(&record)).unwrap_or_default();
        assert_eq!(again, record);
        assert_eq!(again.get("__proto__"), Some(&9));
    }

    #[test]
    fn keys_are_written_in_the_order_they_were_set() {
        let mut indents = Indents::default();
        assert!(indents.has_no_key());
        indents.first_line.set(2.0);
        indents.left.set(1.0);
        indents.r#type.set("x".into());
        // a key that is there keeps its place
        indents.first_line.set(3.0);
        assert_eq!(json(&indents), r#"{"firstLine":3.0,"left":1.0,"type":"x"}"#);
        // deleted and set again, it goes last
        indents.first_line.delete();
        indents.first_line.set(4.0);
        assert_eq!(json(&indents), r#"{"left":1.0,"type":"x","firstLine":4.0}"#);
        assert_eq!(indents.keys(), ["left", "type", "firstLine"]);
        // a value mutated in place keeps its key where it was
        if let Some(left) = indents.left.as_mut() {
            *left = 5.0;
        }
        assert_eq!(json(&indents), r#"{"left":5.0,"type":"x","firstLine":4.0}"#);
    }

    #[test]
    fn a_literal_has_the_order_it_is_written_in() {
        let indents = Indents {
            right: Slot::of(1.0),
            left: Slot::maybe(Some(2.0)),
            first_line: Slot::maybe(None),
            r#type: Slot::default(),
        };
        assert_eq!(json(&indents), r#"{"right":1.0,"left":2.0}"#);
    }

    #[test]
    fn a_key_holding_undefined_is_a_key_and_is_not_written() {
        let mut indents = Indents::default();
        indents.left.assign(None);
        indents.right.set(1.0);
        assert!(indents.left.has_key());
        assert_eq!(*indents.left, None);
        assert_eq!(indents.keys(), ["left", "right"]);
        assert_eq!(json(&indents), r#"{"right":1.0}"#);
        indents.left.set_some(None);
        indents.left.set(5.0);
        assert_eq!(json(&indents), r#"{"left":5.0,"right":1.0}"#);
    }

    #[test]
    fn assign_is_a_spread_of_the_source_over_the_target() {
        let base: Indents = serde_json::from_str(r#"{"right":1,"left":2}"#).unwrap_or_default();
        let mut over = Indents::default();
        over.first_line.set(9.0);
        over.left.set(8.0);
        over.r#type.assign(None);
        let mut merged = base.clone();
        merged.assign(&over);
        // { ...base, ...over }: the keys of base in its order, then the new keys of over in its order
        assert_eq!(merged.keys(), ["right", "left", "firstLine", "type"]);
        assert_eq!(json(&merged), r#"{"right":1.0,"left":8.0,"firstLine":9.0}"#);
        // the other way round
        let mut merged = over.clone();
        merged.assign(&base);
        assert_eq!(json(&merged), r#"{"firstLine":9.0,"left":2.0,"right":1.0}"#);
    }

    #[test]
    fn reading_sets_the_keys_in_the_order_of_the_input() {
        let read: Indents = serde_json::from_str(
            r#"{"firstLine":1,"unknown":[1,{"a":2}],"left":null,"right":3,"firstLine":4}"#,
        )
        .unwrap_or_default();
        assert_eq!(json(&read), r#"{"firstLine":4.0,"right":3.0}"#);
        assert!(!read.left.has_key());
        assert!(serde_json::from_str::<Indents>(r#"{"left":"x"}"#).is_err());
        assert!(serde_json::from_str::<Indents>("[]").is_err());
    }
}
