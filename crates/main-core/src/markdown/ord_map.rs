//! A `Map<string, V>` that can also delete: insertion order, a key set again
//! keeps its place, a key deleted and set again goes to the end. `jscompat`'s
//! `JsMap` and `JsObject` have no delete.

use std::collections::HashMap;

pub struct OrdMap<V> {
    slots: Vec<Option<(String, V)>>,
    index: HashMap<String, usize>,
}

impl<V> Default for OrdMap<V> {
    fn default() -> Self {
        OrdMap {
            slots: Vec::new(),
            index: HashMap::new(),
        }
    }
}

impl<V> OrdMap<V> {
    pub fn new() -> Self {
        Self::default()
    }

    /// `map.get(key)`
    pub fn get(&self, key: &str) -> Option<&V> {
        let at = *self.index.get(key)?;
        self.slots[at].as_ref().map(|(_, value)| value)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        let at = *self.index.get(key)?;
        self.slots[at].as_mut().map(|(_, value)| value)
    }

    /// `map.has(key)`
    pub fn has(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }

    /// `map.set(key, value)`
    pub fn set(&mut self, key: &str, value: V) {
        if let Some(&at) = self.index.get(key) {
            if let Some(slot) = self.slots[at].as_mut() {
                slot.1 = value;
            }
            return;
        }
        self.index.insert(key.to_owned(), self.slots.len());
        self.slots.push(Some((key.to_owned(), value)));
    }

    /// `map.delete(key)`
    pub fn remove(&mut self, key: &str) -> Option<V> {
        let at = self.index.remove(key)?;
        self.slots[at].take().map(|(_, value)| value)
    }

    /// `map.size`
    pub fn len(&self) -> usize {
        self.index.len()
    }

    pub fn is_empty(&self) -> bool {
        self.index.is_empty()
    }

    /// `map.clear()`
    pub fn clear(&mut self) {
        self.slots.clear();
        self.index.clear();
    }

    /// The entries in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.slots
            .iter()
            .filter_map(|slot| slot.as_ref().map(|(key, value)| (key.as_str(), value)))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.iter().map(|(key, _)| key)
    }

    /// `Object.entries(record)` when the map is a record: array indices
    /// first, ascending, then the other keys in the order they were set.
    pub fn js_entries(&self) -> Vec<(&str, &V)> {
        let mut entries: Vec<(&str, &V)> = self.iter().collect();
        if entries
            .iter()
            .any(|(key, _)| jscompat::array_index(key).is_some())
        {
            entries.sort_by_key(|(key, _)| match jscompat::array_index(key) {
                Some(index) => (0, index),
                None => (1, 0),
            });
        }
        entries
    }
}
