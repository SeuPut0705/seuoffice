//! The harness of the operations on an opened deck: what
//! tools/pptx-diff/deck-ops.ts does on the TypeScript side, read from the same
//! arguments. Every dispatch of a deck operation opens its input with
//! [`deck_op`] and answers `{ value, deck, parts, paths }`.

use jscompat::{JsMap, atob};
use pptx_engine::deck::{OpenedPptx, open_archive, with_uuid};
use pptx_engine::zip::PackageArchive;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::{Returned, arg, required};

/// What `crypto.randomUUID` answers while an operation runs: patching an element's
/// bytes mints its creationId, which must be the same on both sides.
const DECK_UUID: &str = "0b8f1c2e-4d5a-4e6f-8a7b-9c0d1e2f3a4b";

/// The nesting a returned tree may have before `deck_op` refuses it.
const MAX_TREE_DEPTH: u32 = 2048;

/// The archive of `args.deck` with `text` under `args.textPart`, its hash 'gate'.
fn archive_of(text: &str, args: &Value) -> Result<PackageArchive, String> {
    let deck: String = required(args, "deck")?;
    let bytes = atob(&deck).map_err(|error| error.to_string())?;
    let opened = PackageArchive::open(&bytes)?;
    let (_, mut entries) = opened.into_parts();
    if let Some(part) = arg::<String>(args, "textPart")? {
        entries.set(part, text.as_bytes().to_vec());
    }
    Ok(PackageArchive::from_parts(entries, "gate".to_owned()))
}

/// The id of element `element` of slide `slide`, as it is now; '' when there is none.
pub(super) fn element_id(opened: &OpenedPptx, slide: usize, element: usize) -> String {
    opened
        .deck
        .slides
        .get(slide)
        .and_then(|s| (*s.elements).as_ref())
        .and_then(|elements| elements.get(element))
        .map(|el| el.id().to_owned())
        .unwrap_or_default()
}

fn part_value(path: &str, bytes: Option<&Vec<u8>>) -> Value {
    let Some(bytes) = bytes else {
        return Value::Null;
    };
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".xml") || lower.ends_with(".rels") {
        return Value::String(jscompat::text_decoder_decode(bytes).into_owned());
    }
    Value::String(format!("bytes {} {:x}", bytes.len(), Sha256::digest(bytes)))
}

/// Every anchor's range left out, as the TypeScript side does.
fn drop_ranges(node: &mut Value, depth: u32) -> Result<(), String> {
    if depth > MAX_TREE_DEPTH {
        return Err("the returned tree is too deep".to_owned());
    }
    match node {
        Value::Array(items) => {
            for item in items {
                drop_ranges(item, depth + 1)?;
            }
        }
        Value::Object(object) => {
            if let Some(Value::Object(anchor)) = object.get_mut("anchor") {
                anchor.shift_remove("range");
            }
            for value in object.values_mut() {
                drop_ranges(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Open the deck of an input, run `op`, and answer what both sides compare.
pub(super) fn deck_op(
    text: &str,
    args: &Value,
    op: impl FnOnce(&mut OpenedPptx) -> Result<Value, String>,
) -> Returned {
    let mut opened = open_archive(archive_of(text, args)?)?;
    let before: JsMap<Vec<u8>> = opened.archive.entries().clone();
    let value = with_uuid(DECK_UUID, || op(&mut opened))?;
    let after = opened.archive.entries();
    let mut paths: Vec<&str> = before.keys().collect();
    for path in after.keys() {
        if !before.has(path) {
            paths.push(path);
        }
    }
    let mut parts: Vec<(&str, Value)> = paths
        .into_iter()
        .filter(|path| before.get(path) != after.get(path))
        .map(|path| (path, part_value(path, after.get(path))))
        .collect();
    // the TypeScript sorts by code units; paths are compared the same way
    parts.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    let mut result = Map::new();
    result.insert("value".to_owned(), value);
    result.insert(
        "deck".to_owned(),
        serde_json::to_value(&opened.deck).map_err(|error| error.to_string())?,
    );
    result.insert(
        "parts".to_owned(),
        Value::Array(
            parts
                .into_iter()
                .map(|(path, value)| Value::Array(vec![Value::String(path.to_owned()), value]))
                .collect(),
        ),
    );
    result.insert(
        "paths".to_owned(),
        Value::Array(after.keys().map(|p| Value::String(p.to_owned())).collect()),
    );
    let mut result = Value::Object(result);
    drop_ranges(&mut result, 0)?;
    Ok(Some(result))
}
