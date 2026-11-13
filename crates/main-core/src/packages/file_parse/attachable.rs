//! `packages/file-parse/src/attachable.ts`: the one attachable-format list of
//! every editor's main process.
//!
//! `diagramPictureExtOfName` is not here: it reads `@seuoffice/drawio-model`.

/// plain-text extensions read as UTF-8
const TEXT_EXTS: [&str; 27] = [
    "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log",
    "js", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp", "go", "rs", "rb", "sh", "sql", "css",
];

/// image extensions sent to the model as pictures, not extracted as text
pub const ATTACHABLE_IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// draw.io diagrams, read as the read table of their pages
const DIAGRAM_EXTS: [&str; 4] = ["drawio", "dio", "drawio.svg", "drawio.png"];

/// the formats of office and PDF files, whose text is extracted
const DOCUMENT_EXTS: [&str; 13] = [
    "doc", "docx", "odt", "pdf", "pptx", "ppt", "xlsx", "xlsm", "xls", "xmind", "hwp", "hwpx",
    "epub",
];

/// the largest file read whole as an attachment (formats in `SIZE_FREE_EXTS` excepted)
pub const ATTACHABLE_MAX_BYTES: f64 = 50.0 * 1024.0 * 1024.0;
/// the largest picture sent to the model with a message
pub const ATTACHABLE_IMAGE_MAX_BYTES: f64 = 5.0 * 1024.0 * 1024.0;

/// Formats read at any size. Their size is pictures, not words.
const SIZE_FREE_EXTS: [&str; 9] = [
    "docx", "pptx", "xlsx", "xlsm", "hwpx", "odt", "epub", "xmind", "pdf",
];

/// `ATTACHABLE_EXTS` in the order the `Set` is built: text, documents, diagrams, pictures
pub fn attachable_exts() -> Vec<&'static str> {
    TEXT_EXTS
        .iter()
        .chain(DOCUMENT_EXTS.iter())
        .chain(DIAGRAM_EXTS.iter())
        .chain(ATTACHABLE_IMAGE_EXTS.iter())
        .copied()
        .collect()
}

/// `ext.replace(/^\./, '').toLowerCase()`
fn clean(ext: &str) -> String {
    ext.strip_prefix('.').unwrap_or(ext).to_lowercase()
}

/// `ATTACHABLE_EXTS.has(ext)`, the extension as the set holds it
pub fn is_attachable_ext_exact(ext: &str) -> bool {
    attachable_exts().contains(&ext)
}

/// The largest file with this extension that is read for the AI: a picture's
/// cap, no cap (`Infinity`) for the formats read at any size, else
/// `ATTACHABLE_MAX_BYTES`.
pub fn attachable_max_bytes(ext: &str) -> f64 {
    let clean = clean(ext);
    if ATTACHABLE_IMAGE_EXTS.contains(&clean.as_str()) {
        return ATTACHABLE_IMAGE_MAX_BYTES;
    }
    if SIZE_FREE_EXTS.contains(&clean.as_str()) {
        return f64::INFINITY;
    }
    ATTACHABLE_MAX_BYTES
}

/// whether a file with this extension (with or without a leading dot) may be attached
pub fn is_attachable_ext(ext: &str) -> bool {
    is_attachable_ext_exact(&clean(ext))
}
