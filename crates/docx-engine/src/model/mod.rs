//! The Word model of `packages/docx-engine/src/types.ts`: what `parseDocx`
//! returns (`ParsedDocFull`) and the save side takes, as types that read and
//! write the JSON the TypeScript model crosses the wire as.
//!
//! `generated.rs` is written by `tools/docx-diff/model-gen.ts`; do not edit
//! it. Every object type is a struct whose fields have the types of the
//! TypeScript: a required key is `T`, an optional one `Option<T>`, `T | null`
//! is `Option<T>`, and an optional `T | null` is `Option<Option<T>>` (outer:
//! the key, inner: null). Numbers are [`jscompat::JsNum`], which reads null
//! as NaN (`JSON.stringify` writes NaN and the infinities as null), `Record`
//! is [`jscompat::JsObject`] ([`NumberRecord`] where its keys are numbers),
//! `Map` is [`MapEntries`], `Uint8Array` is [`Bytes`]. Reading an object type
//! is strict: an unknown key, a key twice, a missing required key, null where
//! the type has none, a value of another JSON kind and a string no enum holds
//! are refused. Three limits, none reachable from what `JSON.stringify`
//! writes of a parsed document of ordinary depth: a union (`AutoSpace`,
//! `StyleInfo.numPr`, `FinalBlock`) is read through a `serde_json::Value`,
//! where a key twice keeps its last value as `JSON.parse` does; a `Record`
//! and an opaque value keep the last value of a key twice too; and
//! `serde_json` refuses JSON nested deeper than 128 arrays and objects, which
//! a table nested about 25 deep in its cells reaches.
//!
//! An object writes its keys in the order `tools/docx-diff/model-orders.json`
//! commits for its type. A type marked `"input"` there writes them in the
//! order the TypeScript set them, which depends on the path its code took:
//! the struct has a `key_order` field, filled when read, and writes the keys
//! it lists first and any other it holds after them in declaration order.

#[rustfmt::skip]
mod generated;
mod wire;

pub use generated::*;
pub use wire::{Bytes, False, FieldKey, MapEntries, NumberRecord, True};
