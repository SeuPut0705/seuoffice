use std::collections::HashMap;

use serde::ser::{SerializeSeq, Serializer};
use serde::{Deserialize, Deserializer, Serialize};

/// A JavaScript `Map` with string keys: entries stay in insertion order, and
/// setting a key again keeps its place and replaces the value.
///
/// It serializes as `[...map]`, a list of `[key, value]` pairs, so the order
/// survives JSON.
#[derive(Debug, Clone)]
pub struct JsMap<V> {
    entries: Vec<(String, V)>,
    index: HashMap<String, usize>,
}

impl<V> Default for JsMap<V> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            index: HashMap::new(),
        }
    }
}

impl<V> JsMap<V> {
    pub fn new() -> Self {
        Self::default()
    }

    /// `map.set(key, value)`
    pub fn set(&mut self, key: impl Into<String>, value: V) {
        let key = key.into();
        match self.index.get(&key) {
            Some(&at) => self.entries[at].1 = value,
            None => {
                self.index.insert(key.clone(), self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    /// `map.get(key)`
    pub fn get(&self, key: &str) -> Option<&V> {
        self.index.get(key).map(|&at| &self.entries[at].1)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.index.get(key).map(|&at| &mut self.entries[at].1)
    }

    /// `map.has(key)`
    pub fn has(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }

    /// `map.delete(key)`: the entry leaves the order; set again, the key goes
    /// to the end. Nothing is left behind, so deleting and setting again does
    /// not grow the map.
    pub fn delete(&mut self, key: &str) -> Option<V> {
        let at = self.index.remove(key)?;
        let (_, value) = self.entries.remove(at);
        for later in self.index.values_mut() {
            if *later > at {
                *later -= 1;
            }
        }
        Some(value)
    }

    /// `map.clear()`
    pub fn clear(&mut self) {
        self.entries.clear();
        self.index.clear();
    }

    /// `map.size`
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// `map.entries()`
    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.entries.iter().map(|(key, value)| (&**key, value))
    }

    /// `map.keys()`
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(key, _)| &**key)
    }

    /// `map.values()`
    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.entries.iter().map(|(_, value)| value)
    }

    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut V> {
        self.entries.iter_mut().map(|(_, value)| value)
    }
}

impl<V> IntoIterator for JsMap<V> {
    type Item = (String, V);
    type IntoIter = std::vec::IntoIter<Self::Item>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter()
    }
}

impl<V: Serialize> Serialize for JsMap<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut pairs = serializer.serialize_seq(Some(self.entries.len()))?;
        for entry in &self.entries {
            pairs.serialize_element(entry)?;
        }
        pairs.end()
    }
}

/// `new Map(entries)` over the `[key, value]` pairs the map serializes as.
impl<'de, V: Deserialize<'de>> Deserialize<'de> for JsMap<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let pairs = Vec::<(String, V)>::deserialize(deserializer)?;
        Ok(pairs.into_iter().collect())
    }
}

impl<V> FromIterator<(String, V)> for JsMap<V> {
    fn from_iter<I: IntoIterator<Item = (String, V)>>(entries: I) -> Self {
        let mut map = Self::new();
        for (key, value) in entries {
            map.set(key, value);
        }
        map
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_set_again_keeps_its_place() {
        let mut map = JsMap::new();
        map.set("b", 1);
        map.set("a", 2);
        map.set("b", 3);
        assert_eq!(map.iter().collect::<Vec<_>>(), [("b", &3), ("a", &2)]);
        assert_eq!(map.get("b"), Some(&3));
        assert!(!map.has("c"));
        assert_eq!(serde_json::to_string(&map).unwrap(), r#"[["b",3],["a",2]]"#);
    }

    #[test]
    fn a_key_deleted_and_set_again_goes_to_the_end() {
        let mut map = JsMap::new();
        for key in ["a", "b", "c"] {
            map.set(key, key.len());
        }
        assert_eq!(map.delete("a"), Some(1));
        assert_eq!(map.delete("a"), None);
        map.set("a", 9);
        assert_eq!(map.keys().collect::<Vec<_>>(), ["b", "c", "a"]);
        assert_eq!(map.get("c"), Some(&1));
        // an edit loop: delete and set the same keys many times
        for round in 0..1000 {
            map.delete("b");
            map.set("b", round);
        }
        assert_eq!(map.len(), 3);
        assert_eq!(map.keys().collect::<Vec<_>>(), ["c", "a", "b"]);
        assert_eq!(map.get("b"), Some(&999));
        map.clear();
        assert!(map.is_empty() && !map.has("c"));
    }
}
