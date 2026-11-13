//! `packages/file-parse/src/attachable.ts`: the one attachable-format list
//! every editor's main process shares.

/// plain-text extensions read as UTF-8
const TEXT_EXTS: [&str; 27] = [
    "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log",
    "js", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp", "go", "rs", "rb", "sh", "sql", "css",
];

/// `ATTACHABLE_IMAGE_EXTS`
const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// the draw.io forms; the two picture forms are known by their double extension
const DIAGRAM_EXTS: [&str; 4] = ["drawio", "dio", "drawio.svg", "drawio.png"];

const OFFICE_EXTS: [&str; 13] = [
    "doc", "docx", "odt", "pdf", "pptx", "ppt", "xlsx", "xlsm", "xls", "xmind", "hwp", "hwpx",
    "epub",
];

/// `ATTACHABLE_MAX_BYTES`
pub const ATTACHABLE_MAX_BYTES: f64 = 50.0 * 1024.0 * 1024.0;
/// `ATTACHABLE_IMAGE_MAX_BYTES`
pub const ATTACHABLE_IMAGE_MAX_BYTES: f64 = 5.0 * 1024.0 * 1024.0;

/// formats read at any size: their size is pictures, not words
const SIZE_FREE_EXTS: [&str; 9] = [
    "docx", "pptx", "xlsx", "xlsm", "hwpx", "odt", "epub", "xmind", "pdf",
];

/// `ATTACHABLE_IMAGE_EXTS.has(ext)`
pub fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}

/// `ATTACHABLE_EXTS.has(ext)`
pub fn is_attachable_ext_exact(ext: &str) -> bool {
    TEXT_EXTS.contains(&ext)
        || OFFICE_EXTS.contains(&ext)
        || DIAGRAM_EXTS.contains(&ext)
        || IMAGE_EXTS.contains(&ext)
}

/// `diagramPictureExtOfName(fileName)`: `drawio.svg` or `drawio.png` when the
/// name ends so (any case)
pub fn diagram_picture_ext_of_name(file_name: &str) -> Option<&'static str> {
    let name = file_name.to_lowercase();
    if name.ends_with(".drawio.svg") {
        Some("drawio.svg")
    } else if name.ends_with(".drawio.png") {
        Some("drawio.png")
    } else {
        None
    }
}

/// `attachableMaxBytes(ext)`: a picture's cap, no cap (infinity) for the
/// formats read at any size, else [`ATTACHABLE_MAX_BYTES`]
pub fn attachable_max_bytes(ext: &str) -> f64 {
    let clean = ext.strip_prefix('.').unwrap_or(ext).to_lowercase();
    if is_image_ext(&clean) {
        ATTACHABLE_IMAGE_MAX_BYTES
    } else if SIZE_FREE_EXTS.contains(&clean.as_str()) {
        f64::INFINITY
    } else {
        ATTACHABLE_MAX_BYTES
    }
}
