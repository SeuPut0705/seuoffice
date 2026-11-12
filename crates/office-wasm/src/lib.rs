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

use docx_engine::scan::{BodyScan, scan_body};
use ooxml_pkg::{decode_text, needs_ooxml_normalization, normalize_ooxml_xml, read_entries};
use ooxml_xml::{Utf16Map, parse_ordered, serialize};
use serde::{Deserialize, Serialize};

mod calls;
mod package;
mod props;

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

fn encode_frame(header: &[u8], blobs: &[Vec<u8>]) -> Vec<u8> {
    let size = 8 + header.len() + blobs.iter().map(|blob| 4 + blob.len()).sum::<usize>();
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(header);
    out.extend_from_slice(&(blobs.len() as u32).to_le_bytes());
    for blob in blobs {
        out.extend_from_slice(&(blob.len() as u32).to_le_bytes());
        out.extend_from_slice(blob);
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

fn respond(input: &[u8]) -> Vec<u8> {
    let mut reply_blobs = Vec::new();
    let header = match decode_frame(input) {
        None => json(&Reply::failure("invalid_request", "malformed frame")),
        Some(frame) => match serde_json::from_slice::<Request>(frame.header) {
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
                (Command::NormalizeOoxml, _) => normalize(&frame.blobs, &mut reply_blobs),
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
                    | Command::PptxPackage,
                    None,
                ) => json(&Reply::failure("invalid_request", "blob 0 is missing")),
            },
        },
    };
    encode_frame(&header, &reply_blobs)
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
        encode_frame(&serde_json::to_vec(header).unwrap(), &blobs)
    }

    fn call(header: Value, blobs: &[&[u8]]) -> (Value, Vec<Vec<u8>>) {
        let reply = respond(&frame(&header, blobs));
        let reply = decode_frame(&reply).expect("the reply is a well-formed frame");
        let blobs = reply.blobs.iter().map(|blob| blob.to_vec()).collect();
        (serde_json::from_slice(reply.header).unwrap(), blobs)
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
