//! The arguments of `@seuoffice/pptx-engine` that the engine changes, read from
//! what the binding sends and answered back for it to write into the caller's
//! objects (packages/pptx-engine/src/engine-adopt.ts). See
//! crates/pptx-engine/C2-PLAN.md, "What pptx adds".
//!
//! - An archive is `{ entries: [[path, {"$blob": n}], ...], originalHash }`;
//!   its answer is `{ changed: [[path, {"$blob": n} | null], ...], paths }`,
//!   only the parts whose bytes differ from the request.
//! - An opened deck is `{ deck, archive, saveSnapshot? }`, `deck` the
//!   `SlideDeck` as JSON and `saveSnapshot` what the last save patched (the
//!   TypeScript keeps it in a WeakMap keyed by the deck; the binding does).
//! - A row answers `{ "$result": value, "$out": { "<wire index>": answer } }`
//!   (B4's `$result`/`$parts`): `$out` holds the arguments the engine changed.
//! - A `{"$blob": n}` inside an argument object that is no archive is the
//!   request blob `n` as base64 text ([`inline_blobs`]): the option structs of
//!   the engine read their bytes fields through `pptx_engine::json_bytes`,
//!   which takes base64 (the smallest form of bytes a JSON value holds).

use std::borrow::Cow;
use std::cell::Cell;
use std::collections::HashMap;

use jscompat::JsMap;
use pptx_engine::deck::OpenedPptx;
use pptx_engine::parse::Uids;
use pptx_engine::types::SlideDeck;
use pptx_engine::zip::PackageArchive;
use serde_json::{Map, Value};

use super::InvokeEnv;

thread_local! {
    /// `uidCounter` of parse.ts: one counter for every slide parsed in this
    /// instance, as the TypeScript module has one per process.
    static UID_NEXT: Cell<u64> = const { Cell::new(0) };
}

/// The id counter, where the last call left it.
pub fn uids() -> Uids {
    Uids::starting_at(UID_NEXT.with(Cell::get))
}

/// Keeps where `uids` stopped for the next call: every call draws from
/// [`uids`], a deck opened included (`open_pptx_with`).
pub fn keep_uids(uids: &Uids) {
    UID_NEXT.with(|next| next.set(uids.next()));
}

/// An archive as it came, with the request bytes of each part to tell what changed.
pub struct SentArchive<'a> {
    pub archive: PackageArchive,
    pub sent: HashMap<String, &'a [u8]>,
}

fn field<'v>(value: &'v Value, key: &str) -> Result<&'v Value, String> {
    value
        .get(key)
        .ok_or_else(|| format!("TypeError: the argument has no {key}"))
}

/// `{ entries, originalHash }` as a `PackageArchive`.
pub fn read_archive<'a>(env: &InvokeEnv<'a>, value: &Value) -> Result<SentArchive<'a>, String> {
    let pairs = field(value, "entries")?
        .as_array()
        .ok_or("TypeError: archive.entries is not a list of entries")?;
    let hash = field(value, "originalHash")?
        .as_str()
        .ok_or("TypeError: archive.originalHash is not a string")?
        .to_owned();
    let mut sent = HashMap::with_capacity(pairs.len());
    let mut entries = Vec::with_capacity(pairs.len());
    for pair in pairs {
        let (Some(path), Some(blob)) = (pair.get(0).and_then(Value::as_str), pair.get(1)) else {
            return Err("TypeError: an archive entry is not [path, bytes]".to_owned());
        };
        let bytes = env.blob(blob)?;
        sent.insert(path.to_owned(), bytes);
        entries.push((path.to_owned(), bytes.to_vec()));
    }
    Ok(SentArchive {
        archive: PackageArchive::from_parts(entries, hash),
        sent,
    })
}

/// What changed in `archive` since it was sent: `{ changed, paths }`.
pub fn answer_archive(
    env: &mut InvokeEnv<'_>,
    sent: &HashMap<String, &[u8]>,
    archive: &PackageArchive,
) -> Value {
    let entries = archive.entries();
    let mut changed: Vec<(String, Value)> = Vec::new();
    for (path, bytes) in entries.iter() {
        if sent
            .get(path)
            .is_some_and(|before| *before == bytes.as_slice())
        {
            continue;
        }
        changed.push((path.to_owned(), env.put_blob(bytes.clone())));
    }
    for path in sent.keys() {
        if !entries.has(path) {
            changed.push((path.clone(), Value::Null));
        }
    }
    changed.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = Map::new();
    out.insert(
        "changed".to_owned(),
        Value::Array(
            changed
                .into_iter()
                .map(|(path, bytes)| Value::Array(vec![Value::String(path), bytes]))
                .collect(),
        ),
    );
    out.insert(
        "paths".to_owned(),
        Value::Array(
            entries
                .keys()
                .map(|path| Value::String(path.to_owned()))
                .collect(),
        ),
    );
    Value::Object(out)
}

/// An opened deck as it came.
pub struct SentOpened<'a> {
    pub opened: OpenedPptx,
    sent: HashMap<String, &'a [u8]>,
}

/// `{ deck, archive, saveSnapshot? }` as an `OpenedPptx` on the instance's id counter.
pub fn read_opened<'a>(env: &InvokeEnv<'a>, value: &Value) -> Result<SentOpened<'a>, String> {
    let deck: SlideDeck = serde_json::from_value(field(value, "deck")?.clone())
        .map_err(|error| format!("TypeError: deck: {error}"))?;
    let SentArchive { archive, sent } = read_archive(env, field(value, "archive")?)?;
    let save_snapshot = match value.get("saveSnapshot") {
        None | Some(Value::Null) => None,
        Some(snapshot) => {
            let pairs: Vec<(String, String)> = serde_json::from_value(snapshot.clone())
                .map_err(|error| format!("TypeError: saveSnapshot: {error}"))?;
            Some(pairs.into_iter().collect::<JsMap<String>>())
        }
    };
    Ok(SentOpened {
        opened: OpenedPptx {
            deck,
            archive,
            uids: uids(),
            save_snapshot,
        },
        sent,
    })
}

/// What `opened` is now: `{ deck, archive, saveSnapshot }`; keeps its id counter.
pub fn answer_opened(env: &mut InvokeEnv<'_>, sent: SentOpened<'_>) -> Result<Value, String> {
    let SentOpened { opened, sent } = sent;
    keep_uids(&opened.uids);
    let mut out = Map::new();
    out.insert(
        "deck".to_owned(),
        serde_json::to_value(&opened.deck).map_err(|error| error.to_string())?,
    );
    out.insert(
        "archive".to_owned(),
        answer_archive(env, &sent, &opened.archive),
    );
    out.insert(
        "saveSnapshot".to_owned(),
        match &opened.save_snapshot {
            None => Value::Null,
            Some(snapshot) => Value::Array(
                snapshot
                    .iter()
                    .map(|(path, xml)| {
                        Value::Array(vec![
                            Value::String(path.to_owned()),
                            Value::String(xml.clone()),
                        ])
                    })
                    .collect(),
            ),
        },
    );
    Ok(Value::Object(out))
}

/// An archive in full, as the binding builds a `PackageArchive` from it:
/// `{ entries: [[path, {"$blob": n}], ...], originalHash }`.
pub fn answer_archive_whole(env: &mut InvokeEnv<'_>, archive: &PackageArchive) -> Value {
    let entries = archive
        .entries()
        .iter()
        .map(|(path, bytes)| {
            Value::Array(vec![
                Value::String(path.to_owned()),
                env.put_blob(bytes.clone()),
            ])
        })
        .collect();
    let mut out = Map::new();
    out.insert("entries".to_owned(), Value::Array(entries));
    out.insert(
        "originalHash".to_owned(),
        Value::String(archive.original_hash().to_owned()),
    );
    Value::Object(out)
}

/// A deck the engine made (`openPptx`): `{ deck, archive }`, the archive in full.
/// Keeps its id counter.
pub fn answer_new_opened(env: &mut InvokeEnv<'_>, opened: &OpenedPptx) -> Result<Value, String> {
    keep_uids(&opened.uids);
    let mut out = Map::new();
    out.insert(
        "deck".to_owned(),
        serde_json::to_value(&opened.deck).map_err(|error| error.to_string())?,
    );
    out.insert(
        "archive".to_owned(),
        answer_archive_whole(env, &opened.archive),
    );
    Ok(Value::Object(out))
}

/// `args` with every `{"$blob": n}` below the top level of an argument written
/// as the base64 text of the blob. An archive (`entries` and `originalHash`)
/// keeps its blobs: `read_archive` reads them.
pub fn inline_blobs<'v>(
    env: &InvokeEnv<'_>,
    args: &'v [Value],
) -> Result<Cow<'v, [Value]>, String> {
    fn holds_blob(value: &Value) -> bool {
        match value {
            Value::Object(map)
                if map.contains_key("entries") && map.contains_key("originalHash") =>
            {
                false
            }
            Value::Object(map) if map.len() == 1 && map.contains_key("$blob") => true,
            Value::Object(map) => map.values().any(holds_blob),
            Value::Array(items) => items.iter().any(holds_blob),
            _ => false,
        }
    }
    fn inline(env: &InvokeEnv<'_>, value: &mut Value) -> Result<(), String> {
        match value {
            Value::Object(map)
                if map.contains_key("entries") && map.contains_key("originalHash") => {}
            Value::Object(map) if map.len() == 1 && map.contains_key("$blob") => {
                let bytes = env.blob(&Value::Object(map.clone()))?;
                *value = Value::String(jscompat::base64(bytes));
            }
            Value::Object(map) => {
                for inner in map.values_mut() {
                    inline(env, inner)?;
                }
            }
            Value::Array(items) => {
                for inner in items {
                    inline(env, inner)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    let nested = |arg: &Value| match arg {
        Value::Object(map) if map.len() == 1 && map.contains_key("$blob") => false,
        other => holds_blob(other),
    };
    if !args.iter().any(nested) {
        return Ok(Cow::Borrowed(args));
    }
    let mut out = args.to_vec();
    for arg in &mut out {
        if nested(arg) {
            inline(env, arg)?;
        }
    }
    Ok(Cow::Owned(out))
}

/// What a row answers: the value, and the arguments the engine changed by index.
pub fn answer(value: Option<Value>, out: Vec<(usize, Value)>) -> Value {
    let mut reply = Map::new();
    if let Some(value) = value {
        reply.insert("$result".to_owned(), value);
    }
    if !out.is_empty() {
        reply.insert(
            "$out".to_owned(),
            Value::Object(
                out.into_iter()
                    .map(|(index, value)| (index.to_string(), value))
                    .collect(),
            ),
        );
    }
    Value::Object(reply)
}
