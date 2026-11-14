//! packages/file-parse/src/attachable.ts.

pub const ATTACHABLE_MAX_BYTES: u64 = 50 * 1024 * 1024;
pub const ATTACHABLE_IMAGE_MAX_BYTES: u64 = 5 * 1024 * 1024;
pub const ATTACHABLE_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
pub const ATTACHABLE_EXTS: &[&str] = &[
    "txt",
    "md",
    "markdown",
    "csv",
    "tsv",
    "json",
    "yaml",
    "yml",
    "xml",
    "html",
    "htm",
    "log",
    "js",
    "ts",
    "tsx",
    "jsx",
    "py",
    "java",
    "c",
    "h",
    "cpp",
    "go",
    "rs",
    "rb",
    "sh",
    "sql",
    "css",
    "doc",
    "docx",
    "odt",
    "pdf",
    "pptx",
    "ppt",
    "xlsx",
    "xlsm",
    "xls",
    "xmind",
    "hwp",
    "hwpx",
    "epub",
    "drawio",
    "dio",
    "drawio.svg",
    "drawio.png",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
];
const SIZE_FREE_EXTS: &[&str] = &[
    "docx", "pptx", "xlsx", "xlsm", "hwpx", "odt", "epub", "xmind", "pdf",
];

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

pub fn attachable_max_bytes(ext: &str) -> f64 {
    let clean = ext.strip_prefix('.').unwrap_or(ext).to_lowercase();
    if ATTACHABLE_IMAGE_EXTS.contains(&clean.as_str()) {
        ATTACHABLE_IMAGE_MAX_BYTES as f64
    } else if SIZE_FREE_EXTS.contains(&clean.as_str()) {
        f64::INFINITY
    } else {
        ATTACHABLE_MAX_BYTES as f64
    }
}

pub fn is_attachable_ext(ext: &str) -> bool {
    let clean = ext.strip_prefix('.').unwrap_or(ext).to_lowercase();
    ATTACHABLE_EXTS.contains(&clean.as_str())
}
