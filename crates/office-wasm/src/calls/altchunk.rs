//! `altchunk.*`: alt-chunk.ts. A byte argument is `args.bytes`, an array of
//! numbers, or else the text as UTF-8 (what `TextEncoder` gives).

use std::borrow::Cow;

use docx_engine::alt_chunk;
use docx_engine::package::RelInfo;
use jscompat::JsMap;
use serde_json::Value;

use super::{Returned, arg, required, value};

fn bytes_of<'a>(text: &'a str, args: &Value) -> Result<Cow<'a, [u8]>, String> {
    Ok(match arg::<Vec<u8>>(args, "bytes")? {
        Some(bytes) => Cow::Owned(bytes),
        None => Cow::Borrowed(text.as_bytes()),
    })
}

/// `new Map(args.rels)`: `[id, { target, type, targetMode? }]` pairs.
fn rels_of(args: &Value) -> Result<JsMap<RelInfo>, String> {
    let entries: Vec<(String, Value)> = required(args, "rels")?;
    let mut rels = JsMap::new();
    for (id, rel) in entries {
        rels.set(
            id,
            RelInfo {
                target: required(&rel, "target")?,
                rel_type: required(&rel, "type")?,
                target_mode: arg(&rel, "targetMode")?,
            },
        );
    }
    Ok(rels)
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "altChunkKind" => value(alt_chunk::alt_chunk_kind(
            &required::<String>(args, "path")?,
            arg::<String>(args, "contentType")?.as_deref(),
            &bytes_of(text, args)?,
        )),
        "decodeHtmlBytes" => value(alt_chunk::decode_html_bytes(&bytes_of(text, args)?)),
        "decodeQuotedPrintable" => value(alt_chunk::decode_quoted_printable(text)),
        "decodeMhtToHtml" => value(alt_chunk::decode_mht_to_html(&bytes_of(text, args)?)?),
        "altChunkPartPath" => value(alt_chunk::alt_chunk_part_path(
            &rels_of(args)?,
            &required::<String>(args, "rId")?,
            arg::<String>(args, "sourcePath")?.as_deref(),
        )),
        _ => Err(format!("no function {function}")),
    }
}
