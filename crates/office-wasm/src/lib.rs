//! JavaScript entry point of the document engines, built for wasm32-wasip1 as a
//! reactor. The call convention is the one of apps/sheets/native/xlsx-wasm:
//! `seu_alloc`, `seu_free`, `seu_call`, one buffer in and one buffer out.
//!
//! A buffer is a frame, the same in both directions, little endian:
//! `u32 header length | header JSON | u32 blob count | (u32 length | bytes)*`.
//! Blobs carry document bytes and long texts; JSON carries everything else.
//! Every offset in a reply counts UTF-16 code units, as JavaScript strings do.
//!
//! The release profile aborts on panic, which traps and poisons the instance:
//! input errors are replies, never panics.

use std::collections::HashMap;

#[cfg(target_arch = "wasm32")]
mod grow;

#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOCATOR: grow::Doubling = grow::Doubling;

use docx_engine::scan::{BodyScan, scan_body};
use ooxml_pkg::{decode_text, needs_ooxml_normalization, normalize_ooxml_xml, read_entries};
use ooxml_xml::{Utf16Map, parse_ordered, serialize};
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod calls;
mod epub;
mod epub_pure;
mod epub_xml;
mod file_parse;
mod file_parse_hwp;
mod file_parse_legacy;
mod invoke;
mod package;
mod props;
mod saxes_calls;

const PROTOCOL_VERSION: u8 = 1;

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Command {
    /// Blob 0: the main document part as UTF-8.
    ScanBody,
    RoundTripXml {
        fragments: Vec<String>,
        max_nested_tags: usize,
    },
    /// Blob 0: a zip container. Reply blob `i`: the text of entry `i` as UTF-16LE.
    ZipEntries,
    /// Calls the property readers. The reply has one list of outcomes per input.
    Props { inputs: Vec<props::Input> },
    /// Blob 0: a docx. The reply is the package as `loadDocxZip` opens it and
    /// the values `parseDocx` reads from it before the body, or the refusal.
    Package,
    /// Blob 0: a pptx, opened through its metered zip gate.
    PptxPackage,
    /// The same values for a package given as named texts, without a zip.
    PackageParts { parts: Vec<package::WirePart> },
    /// Every blob: a part as UTF-8. Reply blob `i`: part `i` as
    /// `normalizeOoxmlXml` rewrites it, as UTF-8.
    NormalizeOoxml,
    /// Attachment readers. Blob 0 holds the input file where the reader takes bytes.
    FileParse {
        function: String,
        #[serde(default)]
        text: String,
        #[serde(default)]
        args: serde_json::Value,
    },
    /// EPUB engine functions, called the same way.
    EpubCall {
        function: String,
        #[serde(default)]
        text: String,
        #[serde(default)]
        args: serde_json::Value,
    },
    /// Blob 0: one model value as JSON. Reply blob 0: typed value serialized again.
    ModelRoundTrip { type_name: String },
    /// Blob 0: a docx (blobs 1..: what `resolved` names). Reply blob 0: the
    /// `ParsedDocFull` `parseDocx` returns for it, as the model comparison's
    /// JSON (a Map as its entries, bytes as `{ "$bytes" }`; with `blobRefs`,
    /// bytes are `{ "$blob": n }` reply blobs and `internal.originalBytes` is
    /// `{ "$input": 0 }`). The media converters only the host has are
    /// two-pass: a conversion owed answers `pending` and no model; call again
    /// with `resolved` (conversion id to `null`, a data URL or a blob).
    ParseDocx {
        #[serde(default)]
        options: ParseOptionsWire,
        #[serde(default)]
        alt_chunk_converter: bool,
        #[serde(default)]
        resolved: HashMap<String, Value>,
        #[serde(default)]
        blob_refs: bool,
    },
    /// A TypeScript export by name with its arguments positionally (see
    /// `invoke`). Blobs: the `Uint8Array` arguments.
    Invoke {
        #[serde(rename = "fn")]
        function: String,
        #[serde(default)]
        args: Vec<Value>,
        #[serde(default)]
        callbacks: HashMap<String, u32>,
        #[serde(default)]
        now_ms: f64,
        #[serde(default)]
        resolved: HashMap<String, Value>,
        #[serde(default)]
        alt_chunk_converter: bool,
    },
    /// Blob 0: the original docx. Blob 1: the `ParsedDocFull` of it as the
    /// model comparison's JSON (its `internal.originalBytes` is taken from
    /// blob 0). Header: `blocks` (`SaveBlock[]`), `options` (`SaveOptions`) and
    /// `nowMs`, the clock `saveDocx` reads. Reply blob 0: the docx it writes.
    SaveDocx {
        blocks: serde_json::Value,
        options: serde_json::Value,
        now_ms: f64,
    },
    /// Blobs 0 and 1: the original docx and its `ParsedDocFull` JSON; blobs 2
    /// and 3: the revised docx and its model. Header: `options`
    /// (`CompareOptions`) and `nowMs`. Reply blob 0: the redline docx; reply
    /// blob 1: the summary as JSON.
    CompareDocuments {
        options: Option<serde_json::Value>,
        now_ms: f64,
    },
}

/// `ParseOptions` of parse.ts on the wire.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ParseOptionsWire {
    expand_alt_chunks: Option<bool>,
    shadow_resolve: Option<bool>,
}

#[derive(Deserialize)]
struct Request {
    version: u8,
    #[serde(flatten)]
    command: Command,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Reply<'a> {
    Scan {
        scan: WireScan<'a>,
    },
    RoundTrip {
        results: Vec<RoundTrip>,
    },
    Entries {
        entries: Vec<WireEntry>,
    },
    Props {
        results: Vec<Vec<props::Outcome>>,
    },
    Package {
        package: package::Opened,
    },
    /// Per part, what `needsOoxmlNormalization` answers.
    Normalized {
        needed: Vec<bool>,
    },
    ModelRoundTrip {
        model: bool,
    },
    /// `parseDocx`: the model is reply blob 0 unless conversions are owed.
    Parsed {
        model: bool,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        pending: Vec<invoke::host::Pending>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        warnings: Vec<String>,
    },
    /// `invoke`: the value of the call, `undefined` as absent.
    Invoked {
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        pending: Vec<invoke::host::Pending>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        warnings: Vec<String>,
    },
    Failure {
        error: Failure,
    },
}

#[derive(Serialize)]
struct Failure {
    code: &'static str,
    message: String,
}

impl Reply<'_> {
    fn failure(code: &'static str, message: impl ToString) -> Self {
        Self::Failure {
            error: Failure {
                code,
                message: message.to_string(),
            },
        }
    }
}

#[derive(Serialize)]
struct WireSpan<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    start: u32,
    end: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireScan<'a> {
    elements: Vec<WireSpan<'a>>,
    opaque_regions: Vec<WireSpan<'a>>,
    inner_start: u32,
    inner_end: u32,
    body_content_start: u32,
    body_content_end: u32,
}

impl<'a> WireScan<'a> {
    fn new(scan: &BodyScan<'a>, map: &Utf16Map<'_>) -> Self {
        let at = |byte| map.to_utf16(byte);
        Self {
            elements: scan
                .elements
                .iter()
                .map(|e| WireSpan {
                    name: Some(e.name),
                    start: at(e.start),
                    end: at(e.end),
                })
                .collect(),
            opaque_regions: scan
                .opaque_regions
                .iter()
                .map(|r| WireSpan {
                    name: None,
                    start: at(r.start),
                    end: at(r.end),
                })
                .collect(),
            inner_start: at(scan.inner_start),
            inner_end: at(scan.inner_end),
            body_content_start: at(scan.body_content_start),
            body_content_end: at(scan.body_content_end),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum RoundTrip {
    Xml(String),
    Error(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireEntry {
    /// The stored file name bytes in hex: decoding them is the caller's rule.
    raw_name: String,
    dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct Frame<'a> {
    header: &'a [u8],
    blobs: Vec<&'a [u8]>,
}

fn take<'a>(input: &mut &'a [u8], length: usize) -> Option<&'a [u8]> {
    let (head, tail) = input.split_at_checked(length)?;
    *input = tail;
    Some(head)
}

fn take_u32(input: &mut &[u8]) -> Option<usize> {
    Some(u32::from_le_bytes(take(input, 4)?.try_into().ok()?) as usize)
}

fn decode_frame(mut input: &[u8]) -> Option<Frame<'_>> {
    let header_length = take_u32(&mut input)?;
    let header = take(&mut input, header_length)?;
    let count = take_u32(&mut input)?;
    let mut blobs = Vec::new();
    for _ in 0..count {
        let length = take_u32(&mut input)?;
        blobs.push(take(&mut input, length)?);
    }
    input.is_empty().then_some(Frame { header, blobs })
}

/// A first reply blob at least this large becomes the frame itself.
const IN_PLACE_FRAME: usize = 1 << 20;

fn encode_frame(header: &[u8], mut blobs: Vec<Vec<u8>>) -> Vec<u8> {
    let size = 8 + header.len() + blobs.iter().map(|blob| 4 + blob.len()).sum::<usize>();
    let mut prefix = Vec::with_capacity(12 + header.len());
    prefix.extend_from_slice(&(header.len() as u32).to_le_bytes());
    prefix.extend_from_slice(header);
    prefix.extend_from_slice(&(blobs.len() as u32).to_le_bytes());
    // a large first blob (a document, a decoded part) is moved right in its
    // own buffer instead of copied into a new one: the memory never holds it
    // twice, and a wasm memory never shrinks
    let mut out = match blobs.first().map(Vec::len) {
        Some(first) if first >= IN_PLACE_FRAME => {
            let mut out = blobs.remove(0);
            prefix.extend_from_slice(&(first as u32).to_le_bytes());
            out.reserve_exact(size - first);
            out.resize(first + prefix.len(), 0);
            out.copy_within(..first, prefix.len());
            out[..prefix.len()].copy_from_slice(&prefix);
            out
        }
        _ => {
            let mut out = Vec::with_capacity(size);
            out.extend_from_slice(&prefix);
            out
        }
    };
    for blob in blobs {
        out.extend_from_slice(&(blob.len() as u32).to_le_bytes());
        out.extend_from_slice(&blob);
    }
    out
}

fn json(reply: &Reply<'_>) -> Vec<u8> {
    serde_json::to_vec(reply).unwrap_or_else(|_| b"{}".to_vec())
}

fn scan(xml: &[u8]) -> Vec<u8> {
    let xml = match std::str::from_utf8(xml) {
        Ok(xml) => xml,
        Err(error) => return json(&Reply::failure("invalid_request", error)),
    };
    match scan_body(xml) {
        Ok(scan) => json(&Reply::Scan {
            scan: WireScan::new(&scan, &Utf16Map::new(xml)),
        }),
        Err(error) => json(&Reply::failure("scan_failed", error)),
    }
}

fn round_trip(fragments: &[String], max_nested_tags: usize) -> Vec<u8> {
    let results = fragments
        .iter()
        .map(|fragment| match parse_ordered(fragment, max_nested_tags) {
            Ok(nodes) => RoundTrip::Xml(nodes.iter().map(serialize).collect()),
            Err(error) => RoundTrip::Error(error.to_string()),
        })
        .collect();
    json(&Reply::RoundTrip { results })
}

fn zip_entries(container: &[u8], reply_blobs: &mut Vec<Vec<u8>>) -> Vec<u8> {
    let entries = match read_entries(container) {
        Ok(entries) => entries,
        Err(error) => return json(&Reply::failure("zip_failed", error)),
    };
    let entries = entries
        .into_iter()
        .map(|entry| {
            let (text, error) = match &entry.content {
                Ok(bytes) => (
                    decode_text(bytes)
                        .encode_utf16()
                        .flat_map(u16::to_le_bytes)
                        .collect(),
                    None,
                ),
                Err(error) => (Vec::new(), Some(error.clone())),
            };
            reply_blobs.push(text);
            WireEntry {
                raw_name: entry
                    .raw_name
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
                dir: entry.is_dir,
                error,
            }
        })
        .collect();
    json(&Reply::Entries { entries })
}

fn pptx_package(container: &[u8], reply_blobs: &mut Vec<Vec<u8>>) -> Vec<u8> {
    let opened = match pptx_engine::zip::PackageArchive::open(container) {
        Ok(opened) => opened,
        Err(reason) => {
            return serde_json::to_vec(&serde_json::json!({ "refused": reason }))
                .unwrap_or_else(|_| b"{}".to_vec());
        }
    };
    let (hash, parts) = opened.into_parts();
    let mut entries = Vec::with_capacity(parts.len());
    for (name, bytes) in parts {
        entries.push(name);
        reply_blobs.push(bytes);
    }
    serde_json::to_vec(&serde_json::json!({
        "hash": hash,
        "entries": entries,
    }))
    .unwrap_or_else(|_| b"{}".to_vec())
}
fn normalize(parts: &[&[u8]], reply_blobs: &mut Vec<Vec<u8>>) -> Vec<u8> {
    let mut needed = Vec::with_capacity(parts.len());
    for part in parts {
        let xml = match std::str::from_utf8(part) {
            Ok(xml) => xml,
            Err(error) => return json(&Reply::failure("invalid_request", error)),
        };
        needed.push(needs_ooxml_normalization(xml));
        reply_blobs.push(normalize_ooxml_xml(xml).into_bytes());
    }
    json(&Reply::Normalized { needed })
}

/// `saveDocx` over the model of `docx` (blob 1) with the blocks and options of the request.
fn save_docx(
    docx: &[u8],
    model: Option<&&[u8]>,
    blocks: serde_json::Value,
    options: serde_json::Value,
    now_ms: f64,
) -> Result<Vec<u8>, String> {
    let model = model.ok_or("blob 1 is missing")?;
    let mut parsed: docx_engine::model::ParsedDocFull =
        serde_json::from_slice(model).map_err(|error| format!("model: {error}"))?;
    parsed.internal.original_bytes = docx_engine::model::Bytes(docx.to_vec());
    let blocks: Vec<docx_engine::save::save::SaveBlock> =
        serde_json::from_value(blocks).map_err(|error| format!("blocks: {error}"))?;
    let options: docx_engine::save::save::SaveOptions =
        serde_json::from_value(options).map_err(|error| format!("options: {error}"))?;
    docx_engine::save::save::save_docx(&parsed, &blocks, &options, now_ms)
}

/// `compareDocuments` over two documents given as blobs (docx, model) each.
fn compare_documents(
    blobs: &[&[u8]],
    options: Option<&serde_json::Value>,
    now_ms: f64,
) -> Result<(Vec<u8>, serde_json::Value), String> {
    let model_of = |docx: Option<&&[u8]>,
                    model: Option<&&[u8]>|
     -> Result<docx_engine::model::ParsedDocFull, String> {
        let (docx, model) = docx.zip(model).ok_or("a docx and its model are missing")?;
        let mut parsed: docx_engine::model::ParsedDocFull =
            serde_json::from_slice(model).map_err(|error| format!("model: {error}"))?;
        parsed.internal.original_bytes = docx_engine::model::Bytes(docx.to_vec());
        Ok(parsed)
    };
    let original = model_of(blobs.first(), blobs.get(1))?;
    let revised = model_of(blobs.get(2), blobs.get(3))?;
    calls::save::features::compare_documents(original, revised, options, now_ms)
}

/// What the host resolved of the conversions an earlier pass owed.
fn resolved_of(
    resolved: &HashMap<String, Value>,
    blobs: &[&[u8]],
) -> Result<HashMap<String, invoke::host::Resolved>, String> {
    resolved
        .iter()
        .map(|(id, value)| {
            let answer = match value {
                Value::Null => invoke::host::Resolved::Null,
                Value::String(url) => invoke::host::Resolved::Text(url.clone()),
                other => {
                    let index = other
                        .get("$blob")
                        .and_then(Value::as_u64)
                        .ok_or("resolved: a null, a string or a blob")?;
                    let bytes = blobs
                        .get(index as usize)
                        .ok_or("resolved: blob is missing")?;
                    invoke::host::Resolved::Bytes(bytes.to_vec())
                }
            };
            Ok((id.clone(), answer))
        })
        .collect()
}

/// The conversions a pass recorded, as pending entries with reply blobs holding their inputs.
fn pending_of(
    media: &invoke::host::RecordingHost,
    reply_blobs: &mut Vec<Vec<u8>>,
) -> Vec<invoke::host::Pending> {
    media
        .take_recorded()
        .into_iter()
        .map(|recorded| {
            let blob = reply_blobs.len();
            reply_blobs.push(recorded.input);
            invoke::host::Pending {
                id: recorded.id,
                kind: recorded.kind,
                mime: recorded.mime,
                blob,
            }
        })
        .collect()
}

/// `parseDocx(bytes, options)`: the reply and its blobs.
fn parse_docx_command(
    docx: &[u8],
    blobs: &[&[u8]],
    options: &ParseOptionsWire,
    alt_chunk_converter: bool,
    resolved: &HashMap<String, Value>,
    blob_refs: bool,
) -> Result<(Reply<'static>, Vec<Vec<u8>>), String> {
    docx_engine::warnings::take();
    let sequences = docx_engine::sequences::save();
    let media =
        invoke::host::RecordingHost::new(resolved_of(resolved, blobs)?, alt_chunk_converter);
    let parsed = docx_engine::parse::parse_docx_full_with(
        docx,
        &media,
        docx_engine::parse::ParseOptions {
            expand_alt_chunks: options.expand_alt_chunks != Some(false),
            shadow_resolve: options.shadow_resolve == Some(true),
        },
    );
    let warnings = docx_engine::warnings::take();
    let model = parsed?;
    // blob 0 is the model: the conversions owed follow it
    let mut reply_blobs: Vec<Vec<u8>> = vec![Vec::new()];
    let pending = pending_of(&media, &mut reply_blobs);
    if !pending.is_empty() {
        // the model of a pass that owes conversions is not the answer, and
        // what it counted is counted again by the pass that is
        docx_engine::sequences::restore(sequences);
        return Ok((
            Reply::Parsed {
                model: false,
                pending,
                warnings,
            },
            reply_blobs,
        ));
    }
    let text = if blob_refs {
        let mut value = jscompat::writing_for_host(|| serde_json::to_value(&model))
            .map_err(|error| error.to_string())?;
        if let Some(internal) = value.get_mut("internal").and_then(Value::as_object_mut) {
            internal.insert(
                "originalBytes".to_owned(),
                serde_json::json!({ "$input": 0 }),
            );
        }
        invoke::blobify(&mut value, &mut reply_blobs);
        value.to_string()
    } else {
        jscompat::writing_for_host(|| serde_json::to_string(&model))
            .map_err(|error| error.to_string())?
    };
    reply_blobs[0] = text.into_bytes();
    Ok((
        Reply::Parsed {
            model: true,
            pending,
            warnings,
        },
        reply_blobs,
    ))
}

/// One `invoke`: the reply and its blobs.
fn invoke_command(
    blobs: &[&[u8]],
    function: &str,
    mut args: Vec<Value>,
    callbacks: HashMap<String, u32>,
    now_ms: f64,
    resolved: &HashMap<String, Value>,
    alt_chunk_converter: bool,
) -> Result<(Reply<'static>, Vec<Vec<u8>>), String> {
    let args = invoke::Args::new(&mut args, blobs)?;
    docx_engine::warnings::take();
    let sequences = docx_engine::sequences::save();
    let media =
        invoke::host::RecordingHost::new(resolved_of(resolved, blobs)?, alt_chunk_converter);
    let mut env = invoke::InvokeEnv::new(blobs, callbacks, now_ms, media);
    // the product's calls: a model value read as the TypeScript reads it (wire.rs)
    let result = jscompat::reading_leniently(|| match function.split_once('.') {
        Some(("fileParse", name)) => args
            .resolved()
            .and_then(|values| invoke::file_parse::invoke(&mut env, name, &values)),
        Some(("pptx", name)) => invoke::pptx_table::invoke(&mut env, name, args),
        _ => invoke::table::invoke(&mut env, function, args),
    });
    let warnings = docx_engine::warnings::take();
    let value = result?;
    let (mut reply_blobs, media) = env.into_reply_blobs();
    let pending = pending_of(&media, &mut reply_blobs);
    if !pending.is_empty() {
        // this pass is called again with the answers: it must not have counted
        docx_engine::sequences::restore(sequences);
    }
    Ok((
        Reply::Invoked {
            value,
            pending,
            warnings,
        },
        reply_blobs,
    ))
}

/// The deepest a request may nest: deeper than any document the TypeScript
/// reads (a SmartArt tree of hundreds of levels). Reading one level takes
/// stack of the host's own (V8 overflows near 4,000 levels on Node's main
/// thread) and of the wasm build's (build.rs): this keeps both well clear.
const MAX_ARGUMENT_DEPTH: usize = 1024;

/// The request of a header, past serde_json's default bound of 128 levels. A
/// deeper one than `MAX_ARGUMENT_DEPTH` is refused as the TypeScript fails on
/// it, before anything recursive runs: an overflow of the wasm stack leaves
/// the instance unusable.
fn request_of(header: &[u8]) -> Result<Request, String> {
    if nesting_of(header) > MAX_ARGUMENT_DEPTH {
        return Err("RangeError: Maximum call stack size exceeded".to_owned());
    }
    let mut reader = serde_json::Deserializer::from_slice(header);
    reader.disable_recursion_limit();
    let request = Request::deserialize(&mut reader).map_err(|error| error.to_string())?;
    reader.end().map_err(|error| error.to_string())?;
    Ok(request)
}

/// The deepest nesting of arrays and objects in a JSON text, brackets inside
/// strings not counted.
fn nesting_of(json: &[u8]) -> usize {
    let (mut depth, mut deepest, mut in_string, mut escaped) = (0usize, 0usize, false, false);
    for &byte in json {
        if in_string {
            match (escaped, byte) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    deepest
}

fn respond(input: &[u8]) -> Vec<u8> {
    let mut reply_blobs = Vec::new();
    let header = match decode_frame(input) {
        None => json(&Reply::failure("invalid_request", "malformed frame")),
        Some(frame) => match request_of(frame.header) {
            Err(error) => json(&Reply::failure("invalid_request", error)),
            Ok(request) if request.version != PROTOCOL_VERSION => {
                json(&Reply::failure("unsupported_version", request.version))
            }
            Ok(request) => match (request.command, frame.blobs.first()) {
                (
                    Command::RoundTripXml {
                        fragments,
                        max_nested_tags,
                    },
                    _,
                ) => round_trip(&fragments, max_nested_tags),
                (Command::Props { inputs }, _) => json(&Reply::Props {
                    results: inputs.iter().map(props::run).collect(),
                }),
                (Command::PackageParts { parts }, _) => json(&Reply::Package {
                    package: package::from_parts(parts),
                }),
                (
                    Command::FileParse {
                        function,
                        text,
                        args,
                    },
                    blob,
                ) => file_parse::run(&function, &text, blob.copied().unwrap_or_default(), &args),
                (
                    Command::EpubCall {
                        function,
                        text,
                        args,
                    },
                    blob,
                ) => epub::run(&function, &text, blob.copied().unwrap_or_default(), &args),
                (Command::NormalizeOoxml, _) => normalize(&frame.blobs, &mut reply_blobs),
                (Command::ModelRoundTrip { type_name }, Some(bytes)) => {
                    match std::str::from_utf8(bytes)
                        .map_err(|error| error.to_string())
                        .and_then(|text| docx_engine::model::round_trip(&type_name, text))
                    {
                        Ok(text) => {
                            reply_blobs.push(text.into_bytes());
                            json(&Reply::ModelRoundTrip { model: true })
                        }
                        Err(error) => json(&Reply::failure("model_refused", error)),
                    }
                }
                (
                    Command::ParseDocx {
                        options,
                        alt_chunk_converter,
                        resolved,
                        blob_refs,
                    },
                    Some(docx),
                ) => match parse_docx_command(
                    docx,
                    &frame.blobs,
                    &options,
                    alt_chunk_converter,
                    &resolved,
                    blob_refs,
                ) {
                    Ok((reply, blobs)) => {
                        reply_blobs = blobs;
                        json(&reply)
                    }
                    Err(error) => json(&Reply::failure("parse_refused", error)),
                },
                (
                    Command::Invoke {
                        function,
                        args,
                        callbacks,
                        now_ms,
                        resolved,
                        alt_chunk_converter,
                    },
                    _,
                ) => match invoke_command(
                    &frame.blobs,
                    &function,
                    args,
                    callbacks,
                    now_ms,
                    &resolved,
                    alt_chunk_converter,
                ) {
                    Ok((reply, blobs)) => {
                        reply_blobs = blobs;
                        json(&reply)
                    }
                    Err(error) => json(&Reply::failure("thrown", error)),
                },
                (
                    Command::SaveDocx {
                        blocks,
                        options,
                        now_ms,
                    },
                    Some(docx),
                ) => match jscompat::reading_leniently(|| {
                    save_docx(docx, frame.blobs.get(1), blocks, options, now_ms)
                }) {
                    Ok(saved) => {
                        reply_blobs.push(saved);
                        json(&Reply::ModelRoundTrip { model: true })
                    }
                    Err(error) => json(&Reply::failure("save_refused", error)),
                },
                (Command::CompareDocuments { options, now_ms }, _) => {
                    match jscompat::reading_leniently(|| {
                        compare_documents(&frame.blobs, options.as_ref(), now_ms)
                    }) {
                        Ok((docx, summary)) => {
                            reply_blobs.push(docx);
                            reply_blobs.push(summary.to_string().into_bytes());
                            json(&Reply::ModelRoundTrip { model: true })
                        }
                        Err(error) => json(&Reply::failure("compare_refused", error)),
                    }
                }
                (Command::ScanBody, Some(xml)) => scan(xml),
                (Command::ZipEntries, Some(container)) => zip_entries(container, &mut reply_blobs),
                (Command::PptxPackage, Some(container)) => {
                    pptx_package(container, &mut reply_blobs)
                }
                (Command::Package, Some(docx)) => json(&Reply::Package {
                    package: package::open(docx),
                }),
                (
                    Command::ScanBody
                    | Command::ZipEntries
                    | Command::Package
                    | Command::ModelRoundTrip { .. }
                    | Command::ParseDocx { .. }
                    | Command::SaveDocx { .. }
                    | Command::PptxPackage,
                    None,
                ) => json(&Reply::failure("invalid_request", "blob 0 is missing")),
            },
        },
    };
    encode_frame(&header, reply_blobs)
}

/// Hands the host a buffer of `len` bytes to fill before calling `seu_call`.
#[unsafe(no_mangle)]
pub extern "C" fn seu_alloc(len: u32) -> *mut u8 {
    Box::into_raw(vec![0u8; len as usize].into_boxed_slice()).cast::<u8>()
}

/// Releases a buffer from `seu_alloc` or a response from `seu_call`, with the same length.
///
/// # Safety
/// `ptr` and `len` must be exactly a pointer and length this module handed out, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn seu_free(ptr: *mut u8, len: u32) {
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len as usize)) });
}

/// Runs one framed request and returns `(response pointer << 32) | response length`.
///
/// # Safety
/// `ptr` and `len` must describe a readable buffer, normally one from `seu_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn seu_call(ptr: *const u8, len: u32) -> u64 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    let body = respond(input);
    let length = body.len() as u64;
    let pointer = Box::into_raw(body.into_boxed_slice()).cast::<u8>() as usize as u64;
    (pointer << 32) | length
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use serde_json::{Value, json};
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    use super::*;

    fn frame(header: &Value, blobs: &[&[u8]]) -> Vec<u8> {
        let blobs: Vec<Vec<u8>> = blobs.iter().map(|blob| blob.to_vec()).collect();
        encode_frame(&serde_json::to_vec(header).unwrap(), blobs)
    }

    fn call(header: Value, blobs: &[&[u8]]) -> (Value, Vec<Vec<u8>>) {
        let reply = respond(&frame(&header, blobs));
        let reply = decode_frame(&reply).expect("the reply is a well-formed frame");
        let blobs = reply.blobs.iter().map(|blob| blob.to_vec()).collect();
        (serde_json::from_slice(reply.header).unwrap(), blobs)
    }

    #[test]
    fn a_frame_whose_first_blob_is_large_reads_back_the_same() {
        let large: Vec<u8> = (0..IN_PLACE_FRAME + 7).map(|i| (i % 251) as u8).collect();
        let header = br#"{"value":1}"#;
        let frame = encode_frame(header, vec![large.clone(), b"tail".to_vec(), Vec::new()]);
        let read = decode_frame(&frame).expect("a well-formed frame");
        assert_eq!(read.header, header);
        assert_eq!(read.blobs, vec![&large[..], b"tail", b""]);
    }

    #[test]
    fn scan_offsets_count_utf16_units() {
        let xml = "<w:document><w:body><w:p>\u{1F600}</w:p><w:tbl a=\">\"/><!-- c --></w:body></w:document>";
        let (reply, _) = call(
            json!({ "version": 1, "cmd": "scanBody" }),
            &[xml.as_bytes()],
        );
        assert_eq!(
            reply,
            json!({ "scan": {
                "elements": [
                    { "name": "w:p", "start": 20, "end": 33 },
                    { "name": "w:tbl", "start": 33, "end": 47 },
                ],
                "opaqueRegions": [{ "start": 47, "end": 57 }],
                "innerStart": 20,
                "innerEnd": 47,
                "bodyContentStart": 20,
                "bodyContentEnd": 57,
            } })
        );
    }

    #[test]
    fn a_scan_failure_carries_the_engine_message() {
        let xml = "<w:document><w:body></w:p></w:body></w:document>";
        let (reply, _) = call(
            json!({ "version": 1, "cmd": "scanBody" }),
            &[xml.as_bytes()],
        );
        assert_eq!(
            reply,
            json!({ "error": { "code": "scan_failed", "message": "unexpected closing tag </w:p> at body level" } })
        );
    }

    #[test]
    fn round_trip_results_keep_the_order_of_the_fragments() {
        let (reply, _) = call(
            json!({
                "version": 1,
                "cmd": "roundTripXml",
                "fragments": ["<w:rPr ><w:b /></w:rPr>", "<w:a", "<a><a>"],
                "maxNestedTags": 0,
            }),
            &[],
        );
        assert_eq!(
            reply,
            json!({ "results": [
                { "xml": "<w:rPr><w:b/></w:rPr>" },
                { "error": "tag is not closed" },
                { "error": "Maximum nested tags exceeded" },
            ] })
        );
    }

    #[test]
    fn zip_entry_text_comes_back_as_utf16le_blobs() {
        let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("a.xml", SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(b"\xEF\xBB\xBF<a>\xF0\x9F\x98\x80\x80</a>")
            .unwrap();
        writer
            .add_directory("dir/", SimpleFileOptions::default())
            .unwrap();
        let container = writer.finish().unwrap().into_inner();

        let (reply, blobs) = call(json!({ "version": 1, "cmd": "zipEntries" }), &[&container]);
        assert_eq!(
            reply,
            json!({ "entries": [
                { "rawName": "612e786d6c", "dir": false },
                { "rawName": "6469722f", "dir": true },
            ] })
        );
        let units: Vec<u16> = blobs[0]
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let expected: Vec<u16> = "\u{FEFF}<a>\u{1F600}\u{FFFD}</a>".encode_utf16().collect();
        assert_eq!(units, expected);
        assert!(blobs[1].is_empty());
    }

    #[test]
    fn malformed_requests_are_answered_not_trapped() {
        let scan = json!({ "version": 1, "cmd": "scanBody" });
        let code_of = |request: &[u8]| {
            let reply = respond(request);
            let header: Value =
                serde_json::from_slice(decode_frame(&reply).unwrap().header).unwrap();
            header["error"]["code"].as_str().map(str::to_owned)
        };
        let invalid = Some("invalid_request".to_owned());

        let whole = frame(&scan, &[b"<w:body/>"]);
        assert_eq!(code_of(&whole), None);
        for length in 0..whole.len() {
            assert_eq!(code_of(&whole[..length]), invalid, "truncated to {length}");
        }
        assert_eq!(code_of(&[&whole[..], b"x"].concat()), invalid);
        let mut lying = whole.clone();
        let blob_length_at = lying.len() - b"<w:body/>".len() - 4;
        lying[blob_length_at..blob_length_at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(code_of(&lying), invalid);

        assert_eq!(code_of(&frame(&scan, &[])), invalid);
        assert_eq!(code_of(&frame(&scan, &[b"\xFF"])), invalid);
        assert_eq!(
            code_of(&frame(&json!({ "version": 1, "cmd": "nope" }), &[])),
            invalid
        );
        assert_eq!(
            code_of(&frame(&json!({ "cmd": "scanBody" }), &[b""])),
            invalid
        );
        assert_eq!(code_of(&frame(&json!("text"), &[])), invalid);
        assert_eq!(
            code_of(&frame(&json!({ "version": 2, "cmd": "scanBody" }), &[b""])),
            Some("unsupported_version".to_owned())
        );
        assert_eq!(
            code_of(&frame(
                &json!({ "version": 1, "cmd": "zipEntries" }),
                &[b"not a zip"]
            )),
            Some("zip_failed".to_owned())
        );
    }
}
