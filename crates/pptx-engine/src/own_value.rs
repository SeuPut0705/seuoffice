//! `own-value.ts`: a table answers its own keys only.
//!
//! A Rust table never inherits `constructor` or `__proto__`, so a read is the
//! plain lookup and a write stores an entry under any key, `__proto__` too.

use jscompat::JsMap;

/// `ownValue` over a map.
pub fn own_value<'a, V>(table: &'a JsMap<V>, key: &str) -> Option<&'a V> {
    table.get(key)
}

/// `ownValue` over a static table of pairs.
pub fn own_value_in<'a, V>(table: &'a [(&str, V)], key: &str) -> Option<&'a V> {
    table
        .iter()
        .find_map(|(name, value)| (*name == key).then_some(value))
}

/// `setOwn`: an own entry whatever the key.
pub fn set_own<V>(record: &mut JsMap<V>, key: &str, value: V) {
    record.set(key, value);
}
