//! `parseFileToText` of packages/file-parse/src/parse.ts: an attachment to its
//! text, or why it cannot be read.
//!
//! The TypeScript reads the file from disk; here the caller passes the file's
//! path (for its extension and its draw.io name) and its bytes. The size and
//! the zip check that decide `readZipTextParts` for a large zip-based document
//! are taken from the bytes, which gives the same answers.
//!
//! Three readers are the host's, because they await in the TypeScript and an
//! import of a wasm module cannot: PDF (pdfjs), mind maps (xmind-engine) and
//! OpenDocument text (odt-engine). The host runs the one the extension names
//! before the call and passes what it read as `hosted`: `{"text": ...}`, or
//! `{"error": {"name", "message", "code"?, "mediaType"?}}` with the `code` of an
//! `OdtOpenError` and the `mediaType` of an `OdtNotTextError`. Everything the
//! TypeScript checks before that reader (the extension, the magic bytes) is
//! checked here first, in the same order, so a mismatched file never reaches
//! what the host read. The draw.io readers do not await: they are host steps
//! (`fileparse.diagramFormatOf`, `fileparse.readDiagramText`).
//!
//! The answer is the `ParsedFile` object, its keys in the order each branch of
//! the TypeScript writes them.

use encoding_rs::{UTF_8, UTF_16BE, WINDOWS_1252};
use serde_json::{Map, Value, json};

use crate::csv::decode_csv_buffer;

/// Up to this size a zip-based document is read whole; a larger one is read
/// for its text parts only (`WHOLE_ZIP_READ_MAX_BYTES`).
pub const WHOLE_ZIP_READ_MAX_BYTES: f64 = 50.0 * 1024.0 * 1024.0;

/// The prefix of `DamagedFileError`'s message.
const DAMAGED: &str = "The file is damaged or is not a valid ";

/// `ParseFileOptions`; `None` where the TypeScript has `undefined`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ParseFileOptions {
    pub max_chars: Option<f64>,
    pub whole_zip_max_bytes: Option<f64>,
}

fn object(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect::<Map<_, _>>(),
    )
}

fn read_ok(text: String) -> Value {
    object([
        ("ok", json!(true)),
        ("kind", json!("text")),
        ("text", Value::String(text)),
    ])
}

fn read_failed(error: String) -> Value {
    object([
        ("ok", json!(false)),
        ("kind", json!("text")),
        ("error", Value::String(error)),
    ])
}

/// `extname(filePath).slice(1)`: after the last dot of the last segment,
/// unless that dot opens the name. Both separators end a segment, as Node's
/// win32 `path` reads them.
fn extension_of(file_path: &str) -> &str {
    let name = basename(file_path);
    match name.rfind('.') {
        Some(0) | None => "",
        Some(at) => &name[at + 1..],
    }
}

/// `basename(filePath)` for both separators, without a trailing one.
fn basename(file_path: &str) -> &str {
    let trimmed = file_path.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().unwrap_or("")
}

/// `IMAGE_MIMES[ext]`
fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// `TEXT_EXTS.has(ext)`
fn is_text_ext(ext: &str) -> bool {
    matches!(
        ext,
        "txt" | "md" | "markdown" | "csv" | "tsv" | "json" | "xml" | "html" | "htm" | "log" | "py"
    )
}

/// A text reader's redaction: the source with every withheld span rewritten.
type TextRedactor = fn(&str) -> Result<String, String>;

/// `TEXT_REDACTORS[ext]`
fn text_redactor(ext: &str) -> Option<TextRedactor> {
    match ext {
        "md" | "markdown" | "txt" | "json" => Some(crate::markdown::redact_markdown_source),
        "html" | "htm" => Some(crate::html::redact_html_source),
        _ => None,
    }
}

/// `ZIP_DOCUMENT_EXTS.has(ext)`
fn is_zip_document_ext(ext: &str) -> bool {
    matches!(
        ext,
        "docx" | "pptx" | "xlsx" | "xlsm" | "hwpx" | "odt" | "epub" | "xmind" | "doc" | "hwp"
    )
}

/// `isUtf32BomDeclared(bytes)`
fn is_utf32_bom_declared(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0, 0, 0xfe, 0xff]) || bytes.starts_with(&[0xff, 0xfe, 0, 0])
}

/// `decodeTextBytes(bytes)`; `None` for a BOM-declared UTF-32 file.
///
/// A UTF-16LE text is `Buffer.toString('utf16le', 2)`, which drops an odd last
/// byte and keeps a lone surrogate; a Rust string cannot hold one, so it is
/// U+FFFD here.
fn decode_text_bytes(bytes: &[u8]) -> Option<String> {
    if is_utf32_bom_declared(bytes) {
        return None;
    }
    if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
        let units: Vec<u16> = rest
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        return Some(String::from_utf16_lossy(&units));
    }
    if let Some(rest) = bytes.strip_prefix(&[0xfe, 0xff]) {
        return Some(UTF_16BE.decode_with_bom_removal(rest).0.into_owned());
    }
    let payload = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    // a fatal TextDecoder drops one more BOM, and fails on any error
    let (text, had_errors) = UTF_8.decode_with_bom_removal(payload);
    if !had_errors {
        return Some(text.into_owned());
    }
    Some(
        WINDOWS_1252
            .decode_without_bom_handling(payload)
            .0
            .into_owned(),
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BinaryKind {
    Zip,
    Pdf,
    Ole2,
    Hwp3,
    Unknown,
}

impl BinaryKind {
    fn name(self) -> &'static str {
        match self {
            BinaryKind::Zip => "zip",
            BinaryKind::Pdf => "pdf",
            BinaryKind::Ole2 => "ole2",
            BinaryKind::Hwp3 => "hwp3",
            BinaryKind::Unknown => "unknown",
        }
    }
}

/// `sniffBinary(bytes)`
fn sniff_binary(bytes: &[u8]) -> BinaryKind {
    if bytes.starts_with(b"PK") {
        return BinaryKind::Zip;
    }
    // pdf.js scans the first 1024 bytes for the header
    if bytes[..bytes.len().min(1024)]
        .windows(5)
        .any(|window| window == b"%PDF-")
    {
        return BinaryKind::Pdf;
    }
    if bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0]) {
        return BinaryKind::Ole2;
    }
    if bytes.starts_with(b"HWP Document File") {
        return BinaryKind::Hwp3;
    }
    BinaryKind::Unknown
}

/// `bytes.includes(ENCRYPTED_PACKAGE_STREAM)`: the stream an encrypted OOXML
/// package lives in, its name in UTF-16LE.
fn holds_encrypted_package(bytes: &[u8]) -> bool {
    let name: Vec<u8> = "EncryptedPackage"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    bytes.windows(name.len()).any(|window| window == name)
}

/// What a read that threw answers: its message, and `damaged` for a
/// `DamagedFileError`.
fn thrown(message: String, damaged: bool) -> Value {
    let mut out = read_failed(message);
    if damaged {
        out["damaged"] = json!(true);
    }
    out
}

/// The text the host read, or what it threw as `(message, damaged)`.
fn hosted_text(hosted: Option<&Value>, reader: &str) -> Result<String, (String, bool)> {
    let Some(hosted) = hosted else {
        return Err((format!("the host passed no {reader} result"), false));
    };
    if let Some(text) = hosted.get("text").and_then(Value::as_str) {
        return Ok(text.to_owned());
    }
    let error = hosted.get("error");
    let field = |key: &str| {
        error
            .and_then(|error| error.get(key))
            .and_then(Value::as_str)
    };
    Err((
        field("message").unwrap_or_default().to_owned(),
        field("name") == Some("DamagedFileError"),
    ))
}

/// `parseOdt(bytes)` over what the host's odt-engine read.
fn parse_odt(hosted: Option<&Value>) -> Result<Value, (String, bool)> {
    let error = hosted.and_then(|hosted| hosted.get("error"));
    let field = |key: &str| {
        error
            .and_then(|error| error.get(key))
            .and_then(Value::as_str)
    };
    match field("code") {
        Some("not-odt-text") => {
            return Ok(read_failed(format!(
                "Content mismatch: .odt file is not an OpenDocument text document (media type {})",
                field("mediaType").unwrap_or("missing")
            )));
        }
        Some("encrypted") => {
            return Ok(read_failed(
                "Password-protected ODT: remove the password and attach it again".to_owned(),
            ));
        }
        _ => {}
    }
    hosted_text(hosted, "odt").map(read_ok)
}

/// `readDiagramText` through the host, as `parseFileToText` uses it:
/// `Some(answer)` where it decides the read, `None` for a picture that only
/// carries the name (`no_original`), which is read on by its last extension.
fn read_diagram(file_path: &str, bytes: &[u8]) -> Option<Value> {
    let read = seu_host::call(
        "fileparse.readDiagramText",
        &json!({ "fileName": file_path, "bytesBase64": jscompat::base64(bytes) }),
    );
    let read = match read {
        Ok(read) => read,
        Err(error) => return Some(read_failed(error.message)),
    };
    if read.get("ok") == Some(&json!(true)) {
        return Some(read_ok(
            read.get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        ));
    }
    let field = |key: &str| read.get(key).and_then(Value::as_str).unwrap_or_default();
    if field("reason") == "no_original" {
        return None;
    }
    Some(read_failed(format!(
        "Cannot read diagram ({}): {}",
        field("reason"),
        field("message")
    )))
}

/// `parseFileToText(filePath, opts)` over the file's `bytes`; `hosted` is what
/// the host read for a PDF, a mind map or an OpenDocument text.
pub fn parse_file_to_text(
    file_path: &str,
    bytes: &[u8],
    opts: ParseFileOptions,
    hosted: Option<&Value>,
) -> Value {
    let ext = extension_of(file_path).to_lowercase();
    let ext = ext.as_str();
    // a draw.io diagram is named first: `.drawio.png` and `.drawio.svg` are read
    // as diagram text, not by their last extension
    match seu_host::call(
        "fileparse.diagramFormatOf",
        &json!({ "filePath": file_path }),
    ) {
        Ok(Value::Null) => {}
        Ok(_) => {
            if let Some(answer) = read_diagram(file_path, bytes) {
                return answer;
            }
        }
        Err(error) => return read_failed(error.message),
    }
    if let Some(mime) = image_mime(ext) {
        return object([
            ("ok", json!(true)),
            ("kind", json!("image")),
            ("mime", json!(mime)),
        ]);
    }
    match read(ext, bytes, opts, hosted) {
        Ok(Some(answer)) => answer,
        Ok(None) => object([
            ("ok", json!(false)),
            ("kind", json!("unsupported")),
            (
                "error",
                Value::String(format!(
                    "Unsupported file type: .{}",
                    if ext.is_empty() { "unknown" } else { ext }
                )),
            ),
        ]),
        Err((message, damaged)) => thrown(message, damaged),
    }
}

/// The `try` block of `parseFileToText`: `Ok(None)` where it falls through to
/// "Unsupported file type", `Err` what it caught.
fn read(
    ext: &str,
    bytes: &[u8],
    opts: ParseFileOptions,
    hosted: Option<&Value>,
) -> Result<Option<Value>, (String, bool)> {
    let caught = |message: String| {
        let damaged = message.starts_with(DAMAGED);
        (message, damaged)
    };
    // `e instanceof Error ? e.message : String(e)`: a thrown string is its own message
    let caught_js = |error: crate::compound_gate::JsError| {
        let damaged = error.name == "DamagedFileError";
        (error.message, damaged)
    };
    if is_text_ext(ext) {
        let text = if ext == "csv" || ext == "tsv" {
            (!is_utf32_bom_declared(bytes)).then(|| decode_csv_buffer(bytes, None))
        } else {
            decode_text_bytes(bytes)
        };
        let Some(text) = text else {
            return Ok(Some(read_failed(
                "Unsupported text encoding: BOM-declared UTF-32 cannot be decoded (UTF-8 and UTF-16 are supported)".to_owned(),
            )));
        };
        let text = match text_redactor(ext) {
            Some(redact) => redact(&text).map_err(caught)?,
            None => text,
        };
        return Ok(Some(read_ok(text)));
    }
    // the file's bytes, or for a large zip-based document its text parts only
    let limit = opts.whole_zip_max_bytes.unwrap_or(WHOLE_ZIP_READ_MAX_BYTES);
    let parts;
    let bytes =
        if is_zip_document_ext(ext) && bytes.len() as f64 > limit && bytes.starts_with(b"PK") {
            parts = crate::zip_text_parts::read_zip_text_parts(bytes).map_err(caught)?;
            parts.as_slice()
        } else {
            bytes
        };
    let sniffed = sniff_binary(bytes);
    let mismatch = || {
        Ok(Some(read_failed(format!(
            "Content mismatch: .{ext} file has {} magic bytes",
            sniffed.name()
        ))))
    };
    if ext == "pdf" && sniffed != BinaryKind::Pdf {
        return mismatch();
    }
    if matches!(ext, "docx" | "odt" | "pptx" | "xlsx" | "xlsm") && sniffed != BinaryKind::Zip {
        // an OOXML file with an open password is an OLE2 container around the
        // encrypted package, not a mislabeled file
        if sniffed == BinaryKind::Ole2 && holds_encrypted_package(bytes) {
            return Ok(Some(read_failed(format!(
                "Password-protected .{ext}: open it in its editor with the password, or remove the password and attach it again"
            ))));
        }
        return mismatch();
    }
    if matches!(ext, "xmind" | "epub") && sniffed != BinaryKind::Zip {
        return mismatch();
    }
    // a DOCX saved under a .doc name is common enough that it parses as OOXML
    if (ext == "doc" && sniffed != BinaryKind::Ole2 && sniffed != BinaryKind::Zip)
        || (ext == "ppt" && sniffed != BinaryKind::Ole2)
    {
        return mismatch();
    }
    // .hwpx is a zip; a .hwp is Hangul 5 (OLE2) or Hangul 3, and now and then
    // an HWPX saved under the old name, which the engine reads by its content
    if (ext == "hwpx" && sniffed != BinaryKind::Zip)
        || (ext == "hwp"
            && !matches!(
                sniffed,
                BinaryKind::Ole2 | BinaryKind::Hwp3 | BinaryKind::Zip
            ))
    {
        return mismatch();
    }
    let text = match ext {
        "hwp" | "hwpx" => crate::hwp::hwp_to_text(bytes).map_err(caught)?,
        "doc" if sniffed == BinaryKind::Zip => {
            crate::docx::docx_to_text(bytes, opts.max_chars).map_err(caught)?
        }
        "doc" => crate::doc::doc_to_text(bytes).map_err(caught_js)?,
        "docx" => crate::docx::docx_to_text(bytes, opts.max_chars).map_err(caught)?,
        "odt" => return parse_odt(hosted).map(Some),
        "ppt" => crate::ppt::ppt_to_text(bytes).map_err(caught_js)?,
        "pptx" => crate::pptx::pptx_to_text(bytes).map_err(caught)?,
        "xlsx" | "xlsm" => {
            crate::xlsx::xlsx_to_text(bytes, opts.max_chars, None).map_err(caught)?
        }
        "pdf" => hosted_text(hosted, "pdf")?,
        "xmind" => hosted_text(hosted, "xmind")?,
        "epub" => crate::epub::epub_to_text(bytes).map_err(caught)?,
        _ => return Ok(None),
    };
    Ok(Some(read_ok(text)))
}
