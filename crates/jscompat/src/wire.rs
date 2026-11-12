//! What `js_object!`'s `Deserialize` reads a field with: a field of the type
//! `&'static str` (a value the Rust side writes from a closed list of
//! literals) reads a string and interns it, every other field its own type.

use std::cell::RefCell;
use std::collections::HashSet;
use std::marker::PhantomData;

use serde::Deserialize;
use serde::de::{DeserializeOwned, Deserializer, MapAccess};

thread_local! {
    static INTERNED: RefCell<HashSet<&'static str>> = RefCell::new(HashSet::new());
}

/// `text` as a `&'static str`: one allocation per distinct value.
fn intern(text: String) -> &'static str {
    INTERNED.with(|set| {
        let mut set = set.borrow_mut();
        if let Some(known) = set.get(text.as_str()) {
            return *known;
        }
        let leaked: &'static str = Box::leak(text.into_boxed_str());
        set.insert(leaked);
        leaked
    })
}

pub struct Probe<T>(PhantomData<T>);

impl<T> Probe<T> {
    pub fn new() -> Self {
        Self(PhantomData)
    }
}

impl<T> Default for Probe<T> {
    fn default() -> Self {
        Self::new()
    }
}

/// Picked first by method resolution, for `&'static str` only.
pub trait StaticStrRead {
    fn read<'de, A: MapAccess<'de>>(self, map: &mut A) -> Result<Option<&'static str>, A::Error>;
}

impl StaticStrRead for &Probe<&'static str> {
    fn read<'de, A: MapAccess<'de>>(self, map: &mut A) -> Result<Option<&'static str>, A::Error> {
        Ok(map.next_value::<Option<String>>()?.map(intern))
    }
}

/// The fallback, through one more autoref.
pub trait Owned<T> {
    fn read<'de, A: MapAccess<'de>>(&self, map: &mut A) -> Result<Option<T>, A::Error>;
}

impl<T: DeserializeOwned> Owned<T> for &Probe<T> {
    fn read<'de, A: MapAccess<'de>>(&self, map: &mut A) -> Result<Option<T>, A::Error> {
        map.next_value::<Option<T>>()
    }
}

/// `deserialize_with` for a `&'static str` field.
pub fn static_str<'de, D: Deserializer<'de>>(deserializer: D) -> Result<&'static str, D::Error> {
    String::deserialize(deserializer).map(intern)
}

/// `deserialize_with` for an `Option<&'static str>` field.
pub fn static_str_opt<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<&'static str>, D::Error> {
    Option::<String>::deserialize(deserializer).map(|text| text.map(intern))
}

/// `&'static str`, spelled so that `#[derive(Deserialize)]` does not take the
/// field for one that borrows from its input.
pub type StaticStr = &'static str;
