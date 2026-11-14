//! Gate-only calls into the XML half of the EPUB engine (feature `book`), by
//! the name of the TypeScript function, as `package::call` and `ranges::call`
//! answer for theirs.
//!
//! The wire follows `ranges.rs`: a JavaScript string that can hold a lone
//! surrogate crosses as a list of UTF-16 units; a number JSON has no form for
//! crosses as its text (`"NaN"`, `"-0"`). What a TypeScript function returns as
//! an object that points to itself (a tree with its parents) crosses flat: the
//! elements in document order, each naming its children by position. A book
//! crosses as its plain data, then as a digest of what each entry reads as; a
//! zip a save writes crosses as the description of its records (`describe_zip`),
//! where the compressed bytes of an entry the writer deflates again are left
//! out, since the deflate stream is zlib-rs, not pako.
//!
//! An error is answered as `(name, message)`.

use crate::open::{EPUB_ZIP_LIMITS, EpubOpenResult, open_epub};
use crate::primitives::sha1;
use crate::save::{
    EpubSaveOptions, EpubSaveResult, SaveOriginal, format_modified_timestamp,
    mask_undefined_entities, modified_replacements, save_epub,
};
use crate::text::extract_chapter_text;
use crate::utf16::{from_wire, to_wire};
use crate::xml::{parse_html, parse_xml};
use crate::xml_positions::{
    PositionsHost, check_well_formed, decode_character_data, parse_result_to_wire,
    parse_xml as parse_positions, resolve_html_entity,
};
use crate::xml_positions_types::{
    Thrown, XmlDocument, XmlNode, XmlParseResult, XmlText, text_raw_offset,
};
use jscompat::to_number;
use serde_json::{Map, Value, json};

type Named = (String, String);

fn named(error: Thrown) -> Named {
    (error.name, error.message)
}

fn error_of(message: impl Into<String>) -> Named {
    ("Error".to_owned(), message.into())
}

fn number_of(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => Some(to_number(text)),
        _ => None,
    }
}

fn number_arg(args: &Value, key: &str) -> Result<f64, Named> {
    number_of(args.get(key)).ok_or_else(|| error_of(format!("args.{key} is not a number")))
}

/// The zip gate appends the host's own text to "cannot be inflated": Node
/// gives the bare name `TypeError`, Rust its own sentence. The gate compares
/// only what the TypeScript wrote itself, as it does for an error.
fn without_host_text(detail: &str) -> String {
    const MARK: &str = "cannot be inflated:";
    detail.find(MARK).map_or_else(
        || detail.to_owned(),
        |at| detail[..at + MARK.len()].to_owned(),
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha1_hex(bytes: &[u8]) -> String {
    hex(&sha1(bytes))
}

/// The text nodes of a document in document order.
fn text_nodes(document: &XmlDocument) -> Vec<&XmlText> {
    let mut out = Vec::new();
    let mut stack = vec![document.element(document.root).children.iter()];
    while let Some(children) = stack.last_mut() {
        match children.next() {
            Some(XmlNode::Text(text)) => out.push(text),
            Some(XmlNode::Element(id)) => stack.push(document.element(*id).children.iter()),
            Some(XmlNode::Other(_)) => {}
            None => {
                stack.pop();
            }
        }
    }
    out
}

fn replacement_value(r: &crate::ranges::RangeReplacement) -> Value {
    let number = |x: f64| {
        if x.fract() == 0.0 && x.abs() < 9e15 {
            json!(x as i64)
        } else {
            json!(x)
        }
    };
    json!({ "start": number(r.start), "end": number(r.end), "text": to_wire(&r.text) })
}

fn replacements_arg(value: &Value) -> Option<Vec<crate::ranges::RangeReplacement>> {
    value
        .as_array()?
        .iter()
        .map(|item| {
            Some(crate::ranges::RangeReplacement {
                start: number_of(item.get("start"))?,
                end: number_of(item.get("end"))?,
                text: match item.get("text")? {
                    Value::String(text) => text.encode_utf16().collect(),
                    units => from_wire(units)?,
                },
            })
        })
        .collect()
}

/// What a read of a book gives, as digests: the entry's bytes, its text and
/// the bytes to draw with.
fn entry_digest(book: &crate::types::EpubBook, name: &str) -> Result<Value, Named> {
    let bytes = book.read(name).map_err(error_of)?;
    let text = book.read_text(name).map_err(error_of)?;
    let rendering = book.read_for_rendering(name).map_err(error_of)?;
    Ok(json!({
        "name": name,
        "bytes": bytes.as_deref().map(sha1_hex),
        "text": text.map(|decoded| json!({
            "encoding": decoded.encoding.label(),
            "valid": decoded.valid,
            "length": decoded.text.encode_utf16().count(),
            "sha1": sha1_hex(decoded.text.as_bytes()),
        })),
        "rendering": rendering.as_deref().map(sha1_hex),
    }))
}

/// The paths `has` is asked about, from the entry names alone.
fn probes(names: &[String]) -> Vec<String> {
    names
        .iter()
        .take(40)
        .flat_map(|name| {
            [
                name.clone(),
                name.to_ascii_uppercase(),
                format!("./{name}"),
                format!("x/../{name}"),
                format!("{name}~"),
            ]
        })
        .collect()
}

fn open_value(bytes: &[u8]) -> Result<Value, Named> {
    let book = match open_epub(bytes, &EPUB_ZIP_LIMITS) {
        EpubOpenResult::Opened(book) => book,
        EpubOpenResult::Refused { reason, detail } => {
            return Ok(
                json!({ "ok": false, "reason": reason.as_str(), "detail": without_host_text(&detail) }),
            );
        }
    };
    let names = &book.info.entry_names;
    let entries = names
        .iter()
        .take(60)
        .map(|name| entry_digest(&book, name))
        .collect::<Result<Vec<_>, _>>()?;
    let has: Vec<Value> = probes(names)
        .iter()
        .map(|path| json!([path, book.has(path)]))
        .collect();
    let info = serde_json::to_value(&book.info).map_err(|error| error_of(error.to_string()))?;
    Ok(json!({ "ok": true, "info": info, "entries": entries, "has": has }))
}

/// One record of a zip, read from its headers.
struct Record<'a> {
    made_by: u16,
    needed: u16,
    flags: u16,
    method: u16,
    time: u16,
    date: u16,
    crc32: u32,
    compressed_size: u32,
    uncompressed_size: u32,
    internal: u16,
    external: u32,
    name: &'a [u8],
    extra: &'a [u8],
    comment: &'a [u8],
    local_needed: u16,
    local_flags: u16,
    local_method: u16,
    local_time: u16,
    local_date: u16,
    local_crc32: u32,
    local_compressed_size: u32,
    local_uncompressed_size: u32,
    local_name: &'a [u8],
    local_extra: &'a [u8],
    data: &'a [u8],
}

fn u16_at(bytes: &[u8], at: usize) -> Result<u16, String> {
    bytes
        .get(at..at + 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .ok_or_else(|| format!("a zip field at {at} is cut short"))
}

fn u32_at(bytes: &[u8], at: usize) -> Result<u32, String> {
    bytes
        .get(at..at + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| format!("a zip field at {at} is cut short"))
}

fn slice(bytes: &[u8], at: usize, length: usize) -> Result<&[u8], String> {
    bytes
        .get(at..at + length)
        .ok_or_else(|| format!("a zip field at {at} is cut short"))
}

fn records(bytes: &[u8]) -> Result<Vec<Record<'_>>, String> {
    let end = (0..bytes.len().saturating_sub(21))
        .rev()
        .find(|&at| bytes[at..].starts_with(b"PK\x05\x06"))
        .ok_or("no end of central directory")?;
    let count = usize::from(u16_at(bytes, end + 10)?);
    let mut at = u32_at(bytes, end + 16)? as usize;
    let mut out = Vec::new();
    for _ in 0..count {
        if !bytes
            .get(at..)
            .is_some_and(|rest| rest.starts_with(b"PK\x01\x02"))
        {
            return Err("no central record".to_owned());
        }
        let name_length = usize::from(u16_at(bytes, at + 28)?);
        let extra_length = usize::from(u16_at(bytes, at + 30)?);
        let comment_length = usize::from(u16_at(bytes, at + 32)?);
        let local = u32_at(bytes, at + 42)? as usize;
        if !bytes
            .get(local..)
            .is_some_and(|rest| rest.starts_with(b"PK\x03\x04"))
        {
            return Err("no local record".to_owned());
        }
        let local_name_length = usize::from(u16_at(bytes, local + 26)?);
        let local_extra_length = usize::from(u16_at(bytes, local + 28)?);
        let compressed_size = u32_at(bytes, at + 20)?;
        let data_at = local + 30 + local_name_length + local_extra_length;
        out.push(Record {
            made_by: u16_at(bytes, at + 4)?,
            needed: u16_at(bytes, at + 6)?,
            flags: u16_at(bytes, at + 8)?,
            method: u16_at(bytes, at + 10)?,
            time: u16_at(bytes, at + 12)?,
            date: u16_at(bytes, at + 14)?,
            crc32: u32_at(bytes, at + 16)?,
            compressed_size,
            uncompressed_size: u32_at(bytes, at + 24)?,
            internal: u16_at(bytes, at + 36)?,
            external: u32_at(bytes, at + 38)?,
            name: slice(bytes, at + 46, name_length)?,
            extra: slice(bytes, at + 46 + name_length, extra_length)?,
            comment: slice(bytes, at + 46 + name_length + extra_length, comment_length)?,
            local_needed: u16_at(bytes, local + 4)?,
            local_flags: u16_at(bytes, local + 6)?,
            local_method: u16_at(bytes, local + 8)?,
            local_time: u16_at(bytes, local + 10)?,
            local_date: u16_at(bytes, local + 12)?,
            local_crc32: u32_at(bytes, local + 14)?,
            local_compressed_size: u32_at(bytes, local + 18)?,
            local_uncompressed_size: u32_at(bytes, local + 22)?,
            local_name: slice(bytes, local + 30, local_name_length)?,
            local_extra: slice(bytes, local + 30 + local_name_length, local_extra_length)?,
            data: slice(bytes, data_at, compressed_size as usize)?,
        });
        at += 46 + name_length + extra_length + comment_length;
    }
    Ok(out)
}

/// The records of the zip `bytes` as JSON: every header field, what each entry
/// inflates to, and for an entry stored or copied through from `original`
/// (the same name, method and compressed bytes) its compressed size and
/// digest. The offsets are left out: they follow from the deflate streams.
fn describe_zip(bytes: &[u8], original: &[u8]) -> Result<Value, Named> {
    let written = records(bytes).map_err(error_of)?;
    // an original with bytes before its first record has none the writer could copy
    let before = records(original).unwrap_or_default();
    let inflated = ooxml_pkg::read_entries(bytes).map_err(|error| error_of(error.to_string()))?;
    let described = written
        .iter()
        .zip(&inflated)
        .map(|(record, entry)| {
            let copied = before.iter().any(|b| {
                b.name == record.name && b.method == record.method && b.data == record.data
            });
            let content = match &entry.content {
                Ok(content) => json!({ "size": content.len(), "sha1": sha1_hex(content) }),
                Err(message) => json!({ "error": message }),
            };
            let mut object = Map::new();
            let mut put = |key: &str, value: Value| {
                object.insert(key.to_owned(), value);
            };
            put("name", json!(String::from_utf8_lossy(record.name)));
            put("madeBy", json!(record.made_by));
            put("needed", json!(record.needed));
            put("flags", json!(record.flags));
            put("method", json!(record.method));
            put("time", json!(record.time));
            put("date", json!(record.date));
            put("crc32", json!(record.crc32));
            put("uncompressedSize", json!(record.uncompressed_size));
            put("extra", json!(hex(record.extra)));
            put("comment", json!(String::from_utf8_lossy(record.comment)));
            put("internal", json!(record.internal));
            put("external", json!(record.external));
            put(
                "local",
                json!({
                    "needed": record.local_needed, "flags": record.local_flags,
                    "method": record.local_method, "time": record.local_time,
                    "date": record.local_date, "crc32": record.local_crc32,
                    "uncompressedSize": record.local_uncompressed_size,
                    "name": String::from_utf8_lossy(record.local_name),
                    "extra": hex(record.local_extra),
                    "compressedSizeAgrees": record.local_compressed_size == record.compressed_size,
                }),
            );
            put("copied", json!(copied));
            if copied || record.method == 0 {
                put("compressedSize", json!(record.compressed_size));
                put("compressedSha1", json!(sha1_hex(record.data)));
            }
            put("inflated", content);
            Value::Object(object)
        })
        .collect::<Vec<_>>();
    Ok(Value::Array(described))
}

/// The save time of an input that gives none: `Date.UTC(2026, 5, 15, 12, 30, 45)`.
pub const DEFAULT_NOW: f64 = 1_781_526_645_000.0;

/// For an input that gives no edits: a comment after the start tag of the first chapter.
fn derived_edits(bytes: &[u8]) -> Value {
    let EpubOpenResult::Opened(book) = open_epub(bytes, &EPUB_ZIP_LIMITS) else {
        return json!([]);
    };
    let path = &book.info.spine.items[0].path;
    let Ok(Some(chapter)) = book.read_text(path) else {
        return json!([]);
    };
    let XmlParseResult::Ok(document) =
        parse_positions(&chapter.text.encode_utf16().collect::<Vec<_>>())
    else {
        return json!([]);
    };
    let at = document.element(document.root).start_tag_end;
    json!([[path, [{ "start": at, "end": at, "text": to_wire(&"<!--gate-->".encode_utf16().collect::<Vec<_>>()) }]]])
}

fn save_value(bytes: &[u8], args: &Value) -> Result<Value, Named> {
    let mut edits: Vec<(String, Vec<crate::ranges::RangeReplacement>)> = Vec::new();
    let given = match args.get("edits") {
        Some(edits) => edits.clone(),
        None => derived_edits(bytes),
    };
    for item in given
        .as_array()
        .ok_or_else(|| error_of("args.edits is not a list"))?
    {
        let path = item
            .get(0)
            .and_then(Value::as_str)
            .ok_or_else(|| error_of("an edit has no path"))?;
        let replacements = item
            .get(1)
            .and_then(replacements_arg)
            .ok_or_else(|| error_of("an edit has no replacements"))?;
        edits.push((path.to_owned(), replacements));
    }
    let options = EpubSaveOptions {
        limits: &EPUB_ZIP_LIMITS,
        now: number_of(args.get("now")).unwrap_or(DEFAULT_NOW),
    };
    Ok(
        match save_epub(SaveOriginal::Bytes(bytes), &edits, &options).map_err(named)? {
            EpubSaveResult::Refused {
                reason,
                path,
                detail,
            } => {
                json!({ "ok": false, "reason": reason.as_str(), "path": path, "detail": without_host_text(&detail) })
            }
            EpubSaveResult::Unchanged => json!({ "ok": true, "changed": false }),
            EpubSaveResult::Saved {
                bytes: saved,
                changed_chapters,
            } => json!({
                "ok": true, "changed": true, "changedChapters": changed_chapters,
                "zip": describe_zip(&saved, bytes)?,
            }),
        },
    )
}

/// The gate's entry: `function` is the TypeScript export name; an error is
/// `(name, message)`; a name this file does not know is answered as
/// `package::call` answers it: an `Error` "unknown function {name}".
pub fn call(function: &str, text: &str, bytes: &[u8], args: &Value) -> Result<Value, Named> {
    let text_units: Vec<u16> = text.encode_utf16().collect();
    Ok(match function {
        "parseXml" => serde_json::to_value(parse_xml(text).map_err(named)?)
            .map_err(|error| error_of(error.to_string()))?,
        "parseHtml" => serde_json::to_value(parse_html(text).map_err(named)?)
            .map_err(|error| error_of(error.to_string()))?,
        "resolveHtmlEntity" => resolve_html_entity(&text.encode_utf16().collect::<Vec<_>>())
            .map_err(named)?
            .map_or(Value::Null, Value::String),
        "decodeCharacterData" => to_wire(
            &decode_character_data(
                &text_units,
                args.get("withHtml")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
            .map_err(named)?,
        ),
        "parseXmlPositions" => parse_result_to_wire(&parse_positions(&text_units)),
        "checkWellFormed" => match check_well_formed(&text_units) {
            Ok(()) => json!({ "ok": true }),
            Err((error, offset)) => json!({ "ok": false, "error": error, "offset": offset }),
        },
        "textRawOffset" => {
            let XmlParseResult::Ok(document) = parse_positions(&text_units) else {
                return Ok(Value::Null);
            };
            let texts = text_nodes(&document);
            if texts.is_empty() {
                return Ok(Value::Null);
            }
            let picked = number_of(args.get("index")).unwrap_or(0.0) as usize % texts.len();
            let k = number_of(args.get("k")).unwrap_or(0.0);
            json!(
                text_raw_offset(&PositionsHost, &document, texts[picked], k as usize)
                    .map_err(named)?
            )
        }
        "extractChapterText" => Value::String(extract_chapter_text(text).map_err(named)?),
        "maskUndefinedEntities" => to_wire(&mask_undefined_entities(&text_units)),
        "formatModifiedTimestamp" => {
            Value::String(format_modified_timestamp(number_arg(args, "time")?).map_err(named)?)
        }
        "modifiedReplacements" => match modified_replacements(
            &text_units,
            args.get("timestamp")
                .and_then(Value::as_str)
                .unwrap_or("2026-06-15T12:30:45Z"),
        ) {
            Some(replacements) => {
                Value::Array(replacements.iter().map(replacement_value).collect())
            }
            None => Value::Null,
        },
        "openEpub" => open_value(bytes)?,
        "saveEpub" => save_value(bytes, args)?,
        _ => return translate_call(function, bytes, args, &text_units, text),
    })
}

#[cfg(not(feature = "book-translate"))]
fn translate_call(
    function: &str,
    _bytes: &[u8],
    _args: &Value,
    _text_units: &[u16],
    _text: &str,
) -> Result<Value, Named> {
    Err(error_of(format!("unknown function {function}")))
}

/// The book translation: the units of a book, the book built from stored
/// results, the batcher, the model call and what they read model answers and
/// count tokens with (feature `book-translate`).
#[cfg(feature = "book-translate")]
fn translate_call(
    function: &str,
    bytes: &[u8],
    args: &Value,
    text_units: &[u16],
    text: &str,
) -> Result<Value, Named> {
    use crate::notation::NotationContext;
    use crate::pdf_structure::TranslationMode;
    use crate::translate::book_units::epub_translation_units;
    use crate::translate::call::{
        CallFailure, EpubCallUnit, TranslationBlockResult, TranslationJobItem,
        batch_epub_translation_items, create_epub_translation_model_call, estimate_tokens,
        parse_translation_output,
    };
    use crate::translate::keys::epub_block_key_string;
    use crate::translate::output::{
        BuildTranslatedEpubOptions, BuildTranslatedEpubResult, EpubTranslationOutcome,
        EpubTranslationOutputKind, build_translated_epub,
    };
    use crate::translate::units::{EpubTranslationUnit, EpubUnitSource};
    use crate::utf16::{lossy, units};
    use std::collections::HashMap;

    let number_value = |x: f64| {
        if x.fract() == 0.0 && x.abs() < 9e15 {
            json!(x as i64)
        } else {
            json!(x)
        }
    };
    let chapters_arg = || -> Option<Vec<f64>> {
        args.get("chapters")?
            .as_array()?
            .iter()
            .map(|n| number_of(Some(n)))
            .collect()
    };
    let opened = || match open_epub(bytes, &EPUB_ZIP_LIMITS) {
        EpubOpenResult::Opened(book) => Some(book),
        EpubOpenResult::Refused { .. } => None,
    };
    let source_json = |source: &EpubUnitSource| match source {
        EpubUnitSource::Block {
            spine_index,
            path,
            block_id,
        } => {
            json!({ "kind": "block", "spineIndex": number_value(*spine_index), "path": path, "blockId": block_id })
        }
        EpubUnitSource::Title { index } => json!({ "kind": "title", "index": index }),
        EpubUnitSource::Nav { index } => json!({ "kind": "nav", "index": index }),
        EpubUnitSource::Ncx { index } => json!({ "kind": "ncx", "index": index }),
    };
    let summary = |unit: &EpubTranslationUnit| {
        json!({
            "key": epub_block_key_string(&unit.key), "page": number_value(unit.page),
            "text": to_wire(&unit.text), "plainText": to_wire(&unit.plain_text),
            "sources": unit.sources.iter().map(source_json).collect::<Vec<_>>(),
        })
    };
    let concat = |parts: &[&[u16]]| parts.concat();
    Ok(match function {
        "epubTranslationUnits" => {
            let Some(book) = opened() else {
                return Ok(Value::Null);
            };
            let result = epub_translation_units(&book, chapters_arg().as_deref()).map_err(named)?;
            json!({
                "units": result.units.iter().map(summary).collect::<Vec<_>>(),
                "skipped": result.skipped.iter()
                    .map(|s| json!({ "index": s.index, "path": s.path, "reason": s.reason }))
                    .collect::<Vec<_>>(),
            })
        }
        "buildTranslatedEpub" => {
            let all = match opened() {
                Some(book) => epub_translation_units(&book, None).map_err(named)?.units,
                None => Vec::new(),
            };
            let variant = args.get("variant").and_then(Value::as_str).unwrap_or("all");
            let mut results: HashMap<String, EpubTranslationOutcome> = HashMap::new();
            for (index, unit) in all.iter().enumerate() {
                let key = epub_block_key_string(&unit.key);
                let translated = EpubTranslationOutcome {
                    translated: true,
                    text: Some(concat(&[&units("T: "), &unit.text])),
                    reason: None,
                };
                let failed = |reason: Option<&str>| EpubTranslationOutcome {
                    translated: false,
                    text: None,
                    reason: reason.map(str::to_owned),
                };
                let with_text = |text: Option<Vec<u16>>| EpubTranslationOutcome {
                    translated: true,
                    text,
                    reason: None,
                };
                let outcome = match variant {
                    "all" => Some(translated),
                    "half" => (index % 2 == 0).then_some(translated),
                    "failed" => Some(if index % 2 == 0 {
                        translated
                    } else {
                        failed(Some("gave-up"))
                    }),
                    "failed-without-reason" => Some(if index % 3 == 0 {
                        failed(None)
                    } else {
                        translated
                    }),
                    "mismatch" => Some(if unit.context.placeholders.is_empty() {
                        translated
                    } else {
                        with_text(Some(units("no placeholders here")))
                    }),
                    "empty" => Some(if index % 2 == 0 {
                        with_text(Some(units("   ")))
                    } else {
                        translated
                    }),
                    "no-text" => Some(if index % 2 == 0 {
                        with_text(None)
                    } else {
                        translated
                    }),
                    "markup" => Some(with_text(Some(concat(&[
                        &units(&format!("<b>T</b>\u{e9} &amp; {index}<br/>")),
                        &unit.text,
                    ])))),
                    "rtl-labels" => Some(with_text(Some(units(&format!(
                        "\u{5e9}\u{5dc}\u{5d5}\u{5dd} {index} <b>x</b>"
                    ))))),
                    _ => None,
                };
                if let Some(outcome) = outcome {
                    results.insert(key, outcome);
                }
            }
            let lang = args.get("lang").and_then(Value::as_str).unwrap_or("fr");
            let chapters = chapters_arg();
            let options = BuildTranslatedEpubOptions {
                limits: &EPUB_ZIP_LIMITS,
                kind: if args.get("kind").and_then(Value::as_str) == Some("bilingual") {
                    EpubTranslationOutputKind::Bilingual
                } else {
                    EpubTranslationOutputKind::Translated
                },
                lang,
                chapters: chapters.as_deref(),
                results: &results,
                now: number_of(args.get("now")).unwrap_or(DEFAULT_NOW),
                uuid: args
                    .get("uuid")
                    .and_then(Value::as_str)
                    .unwrap_or("FEDCBA98-7654-4321-8ABC-0123456789ab"),
                mode: if args.get("mode").and_then(Value::as_str) == Some("easy") {
                    TranslationMode::Easy
                } else {
                    TranslationMode::Translate
                },
            };
            match build_translated_epub(bytes, &options).map_err(named)? {
                BuildTranslatedEpubResult::Refused { reason, detail } => {
                    json!({ "ok": false, "reason": reason.as_str(), "detail": without_host_text(&detail) })
                }
                BuildTranslatedEpubResult::Built {
                    bytes: built,
                    report,
                    identifier,
                } => json!({
                    "ok": true, "identifier": identifier,
                    "report": {
                        "translatedBlocks": report.translated_blocks,
                        "untranslatedBlocks": report.untranslated_blocks.iter().map(|b| json!({
                            "chapter": b.chapter, "path": b.path, "blockId": b.block_id, "reason": b.reason,
                        })).collect::<Vec<_>>(),
                        "originalChapters": report.original_chapters.iter().map(|c| json!({
                            "chapter": c.chapter, "path": c.path, "reason": c.reason,
                        })).collect::<Vec<_>>(),
                    },
                    "zip": describe_zip(&built, bytes)?,
                }),
            }
        }
        "parseTranslationOutput" => {
            let mut entries: Vec<(String, Vec<u16>)> = parse_translation_output(text)
                .unwrap_or_default()
                .into_iter()
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Array(
                entries
                    .iter()
                    .map(|(id, value)| json!([id, to_wire(value)]))
                    .collect(),
            )
        }
        "estimateTokens" => number_value(estimate_tokens(text_units)),
        "batchEpubTranslationItems" => {
            struct Item {
                text: Vec<u16>,
                context: NotationContext,
            }
            impl EpubCallUnit for Item {
                fn text(&self) -> &[u16] {
                    &self.text
                }
                fn context(&self) -> &NotationContext {
                    &self.context
                }
            }
            let items: Vec<TranslationJobItem<Item>> = args
                .get("texts")
                .and_then(Value::as_array)
                .ok_or_else(|| error_of("args.texts is not a list"))?
                .iter()
                .enumerate()
                .map(|(i, text)| TranslationJobItem {
                    block: Item {
                        text: units(text.as_str().unwrap_or_default()),
                        context: NotationContext::default(),
                    },
                    key: crate::pdf_structure::TranslationBlockKey {
                        page_fingerprint: "p".to_owned(),
                        text_hash: i.to_string(),
                        occurrence: 0,
                    },
                })
                .collect();
            let batches = batch_epub_translation_items(&items, number_of(args.get("maxTokens")))
                .map_err(named)?;
            Value::Array(
                batches
                    .iter()
                    .map(|batch| {
                        Value::Array(
                            batch
                                .iter()
                                .map(|item| json!(item.key.text_hash.parse::<usize>().unwrap_or(0)))
                                .collect(),
                        )
                    })
                    .collect(),
            )
        }
        "createEpubTranslationModelCall" => {
            let all: Vec<EpubTranslationUnit> = match opened() {
                Some(book) => epub_translation_units(&book, None)
                    .map_err(named)?
                    .units
                    .into_iter()
                    .filter(|unit| {
                        matches!(unit.sources.first(), Some(EpubUnitSource::Block { .. }))
                    })
                    .take(4)
                    .collect(),
                None => Vec::new(),
            };
            let items: Vec<TranslationJobItem<EpubTranslationUnit>> = all
                .iter()
                .map(|unit| TranslationJobItem {
                    block: unit.clone(),
                    key: unit.key.clone(),
                })
                .collect();
            let ids: Vec<String> = (1..=items.len()).map(|n| n.to_string()).collect();
            let good = |i: usize| lossy(&concat(&[&units("T: "), &all[i].text]));
            let as_json = |entries: Vec<Value>| json!({ "translations": entries }).to_string();
            let answer_for = |id: &str| -> String {
                match id {
                    "GOOD" => as_json(ids.iter().enumerate().map(|(i, x)| json!({ "id": x, "text": good(i) })).collect()),
                    "PARTIAL" => as_json(ids.iter().take(1).enumerate().map(|(i, x)| json!({ "id": x, "text": good(i) })).collect()),
                    "MISMATCH" => as_json(ids.iter().map(|x| json!({ "id": x, "text": "no placeholders <x9/>" })).collect()),
                    "EMPTY" => as_json(ids.iter().map(|x| json!({ "id": x, "text": "  " })).collect()),
                    "MAP" => json!({ "translations": ids.iter().enumerate().map(|(i, x)| (x.clone(), json!(good(i)))).collect::<serde_json::Map<_, _>>() }).to_string(),
                    "LIST" => Value::Array(ids.iter().enumerate().map(|(i, x)| json!({ "id": x, "text": good(i) })).collect()).to_string(),
                    "NUMERIC" => as_json(ids.iter().enumerate().map(|(i, x)| json!({
                        "id": x.parse::<f64>().unwrap_or(0.0) as i64,
                        "text": if i == 0 { json!(5) } else { json!(good(i)) },
                    })).collect()),
                    other => other.to_owned(),
                }
            };
            let answers: Vec<Value> = args
                .get("answers")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| error_of("args.answers is not a list"))?;
            let mut requests: Vec<Value> = Vec::new();
            let mut call_number = 0usize;
            let easy = args.get("mode").and_then(Value::as_str) == Some("easy");
            let made = create_epub_translation_model_call(
                args.get("lang").and_then(Value::as_str).unwrap_or("fr"),
                |request: &crate::translate::call::TranslationModelRequest| -> Result<String, String> {
                    requests.push(json!({
                        "attempt": request.attempt, "lang": request.lang,
                        "mode": if request.easy { json!("easy") } else { Value::Null },
                        "system": sha1_hex(request.system.as_bytes()),
                        "prompt": sha1_hex(request.prompt.as_bytes()),
                    }));
                    let answer = &answers[call_number.min(answers.len() - 1)];
                    call_number += 1;
                    match answer.get("throw").and_then(Value::as_str) {
                        Some(message) => Err(message.to_owned()),
                        None => Ok(answer_for(answer.as_str().unwrap_or_default())),
                    }
                },
                number_of(args.get("maxResends")),
                if easy { TranslationMode::Easy } else { TranslationMode::Translate },
            );
            let outcome = match made {
                Err(error) => Err(CallFailure::Thrown(error)),
                Ok(mut run) => {
                    let batch: Vec<&TranslationJobItem<EpubTranslationUnit>> =
                        items.iter().collect();
                    run.call(&batch, &|| None::<String>)
                }
            };
            match outcome {
                Ok(results) => json!({
                    "ok": true,
                    "results": results.iter().map(|r| match r {
                        TranslationBlockResult::Translated { text } => json!({ "status": "translated", "text": to_wire(text) }),
                        TranslationBlockResult::Failed { reason } => json!({ "status": "failed", "reason": reason }),
                    }).collect::<Vec<_>>(),
                    "requests": requests,
                }),
                Err(CallFailure::JobUnitFailure(failure)) => json!({
                    "ok": false, "name": "JobUnitFailure", "message": failure.message(),
                    "reason": failure.reason, "requests": requests,
                }),
                Err(CallFailure::Run(message)) => json!({
                    "ok": false, "name": "Error", "message": message, "reason": Value::Null, "requests": requests,
                }),
                Err(CallFailure::Thrown(error)) => json!({
                    "ok": false, "name": error.name, "message": error.message, "reason": Value::Null, "requests": requests,
                }),
            }
        }
        _ => return Err(error_of(format!("unknown function {function}"))),
    })
}
