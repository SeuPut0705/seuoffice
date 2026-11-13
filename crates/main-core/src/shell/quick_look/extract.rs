//! `extractQuickLook` and the thumbnail readers of `extract.ts`.

use std::fs;

use jscompat::node_path::host::{basename, extname, is_absolute, resolve};
use jscompat::{base64, slice_utf16};

use super::parse::{
    parse_doc_blocks_from_text, parse_mindmap_from_text, parse_sheets_from_text,
    parse_slides_from_text,
};
use super::{ErrorCode, Family, QuickLookPayload, quick_look_family_of};
use crate::hwp::cfb;
use crate::hwp::zlib::inflate_raw_sync;
use crate::packages::compound_file::assert_compound_file;
use crate::shell::recent_files::StatInfo;

const MAX_DOCUMENT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: usize = 5 * 1024 * 1024;
const MAX_PLAIN_CHARS: usize = 12_000;
const MAX_CACHE_ENTRIES: usize = 24;

/// `ParsedFile` of `@seuoffice/file-parse`, what the preview reads of it
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedFile {
    pub ok: bool,
    pub text: Option<String>,
    pub error: Option<String>,
}

/// One ZIP archive that passed the inflation gate
pub trait ZipArchive {
    /// `zip.file(name)` or else the file whose name equals it without case;
    /// `Err` is the message where reading the entry threw
    fn entry(&self, name: &str) -> Result<Option<Vec<u8>>, String>;
}

/// What `extract.ts` reads a file with that this crate does not have
pub trait QuickLookEngines {
    /// `parseFileToText(path)`; `Err` is the message of what it threw
    fn parse_file_to_text(&self, path: &str) -> Result<ParsedFile, String>;
    /// `assertZipInflatesWithinLimits(bytes)` then `JSZip.loadAsync(bytes)`;
    /// `None` where either threw
    fn open_zip(&self, bytes: &[u8]) -> Option<Box<dyn ZipArchive>>;
}

/// The payloads the preview kept, the oldest out first
#[derive(Debug, Default)]
pub struct QuickLookCache(Vec<(String, QuickLookPayload)>);

impl QuickLookCache {
    /// `clearQuickLookCache()`
    pub fn clear(&mut self) {
        self.0.clear();
    }

    fn get(&self, key: &str) -> Option<&QuickLookPayload> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, p)| p)
    }

    /// `rememberPayload(key, payload)`: a key set again moves to the end
    fn remember(&mut self, key: String, payload: QuickLookPayload) {
        self.0.retain(|(k, _)| *k != key);
        self.0.push((key, payload));
        if self.0.len() > MAX_CACHE_ENTRIES {
            self.0.remove(0);
        }
    }
}

fn cache_key_of(file_path: &str, size: f64, mtime_ms: f64) -> String {
    let norm = resolve(&[file_path]);
    let norm = if cfg!(windows) {
        norm.to_lowercase()
    } else {
        norm
    };
    // the numbers print as JavaScript prints them
    format!(
        "{norm}|{}|{}",
        jscompat::number_to_string(size),
        jscompat::number_to_string(mtime_ms)
    )
}

fn image_mime_of_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// `sniffImageMime(bytes)`
fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 4 {
        return None;
    }
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(&[0x47, 0x49, 0x46, 0x38]) {
        return Some("image/gif");
    }
    if bytes.starts_with(&[0x42, 0x4d]) {
        return Some("image/bmp");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// `toDataUrl(bytes, mime)`
fn to_data_url(bytes: &[u8], mime: &str) -> Option<String> {
    if bytes.is_empty() || bytes.len() > MAX_THUMBNAIL_BYTES {
        return None;
    }
    Some(format!("data:{mime};base64,{}", base64(bytes)))
}

/// `extractHwp5Thumbnail(bytes)`: the `/PrvImage` stream of the container
fn extract_hwp5_thumbnail(bytes: &[u8]) -> Option<String> {
    // through the compound-file gate: a container whose chains loop is refused
    assert_compound_file(bytes).ok()?;
    let container = cfb::read(bytes).ok()?;
    let entry = cfb::find(&container, "/PrvImage").or_else(|| cfb::find(&container, "PrvImage"))?;
    let raw = container.file_index[entry].content.as_deref()?;
    if raw.len() < 8 {
        return None;
    }
    if let Some(mime) = sniff_image_mime(raw) {
        return to_data_url(raw, mime);
    }
    // some writers deflate PrvImage; it stops at the largest picture to_data_url shows
    let inflated = inflate_raw_sync(raw, MAX_THUMBNAIL_BYTES).ok()?;
    let mime = sniff_image_mime(&inflated)?;
    to_data_url(&inflated, mime)
}

const ZIP_THUMBNAIL_CANDIDATES: [&str; 12] = [
    "Preview/PrvImage.png",
    "Preview/PrvImage.bmp",
    "Preview/PrvImage.gif",
    "Preview/PrvImage.jpg",
    "Preview/PrvImage.jpeg",
    "Thumbnails/thumbnail.png",
    "Thumbnails/thumbnail.jpg",
    "Thumbnails/thumbnail.jpeg",
    "docProps/thumbnail.png",
    "docProps/thumbnail.jpeg",
    "docProps/thumbnail.jpg",
    "docProps/thumbnail.gif",
];

/// `extractZipThumbnail(bytes)`
fn extract_zip_thumbnail(engines: &dyn QuickLookEngines, bytes: &[u8]) -> Option<String> {
    let archive = engines.open_zip(bytes)?;
    for candidate in ZIP_THUMBNAIL_CANDIDATES {
        let Ok(entry) = archive.entry(candidate) else {
            return None;
        };
        let Some(image) = entry else {
            continue;
        };
        if let Some(mime) = sniff_image_mime(&image)
            && let Some(url) = to_data_url(&image, mime)
        {
            return Some(url);
        }
    }
    None
}

/// `extractEmbeddedThumbnail(ext, bytes)`
pub fn extract_embedded_thumbnail(
    engines: &dyn QuickLookEngines,
    ext: &str,
    bytes: &[u8],
) -> Option<String> {
    if bytes.len() < 4 {
        return None;
    }
    let is_zip = bytes[0] == 0x50 && bytes[1] == 0x4b;
    let is_ole = bytes[..4] == [0xd0, 0xcf, 0x11, 0xe0];
    if ext == "hwp" && is_ole {
        return extract_hwp5_thumbnail(bytes);
    }
    if is_zip
        && matches!(
            ext,
            "hwpx" | "hwp" | "docx" | "doc" | "pptx" | "xlsx" | "xlsm" | "odt" | "xmind"
        )
    {
        return extract_zip_thumbnail(engines, bytes);
    }
    None
}

/// `classifyParseError(error)`
fn classify_parse_error(error: Option<&str>) -> ErrorCode {
    let Some(error) = error.filter(|e| !e.is_empty()) else {
        return ErrorCode::Unreadable;
    };
    let lower = error.to_ascii_lowercase();
    if lower.contains("password") || lower.contains("encrypted") || error.contains("암호") {
        ErrorCode::Encrypted
    } else if lower.contains("unsupported file type") {
        ErrorCode::Unsupported
    } else {
        ErrorCode::Unreadable
    }
}

/// `extractQuickLook(filePath)`; the result is cached when `cache` is given
pub fn extract_quick_look(
    engines: &dyn QuickLookEngines,
    file_path: &str,
    mut cache: Option<&mut QuickLookCache>,
) -> QuickLookPayload {
    let ext = extname(file_path)
        .strip_prefix('.')
        .unwrap_or("")
        .to_lowercase();
    let family = quick_look_family_of(&ext);
    let name = {
        let base = basename(file_path, None);
        if base.is_empty() {
            file_path.to_owned()
        } else {
            base
        }
    };
    let base = QuickLookPayload {
        ok: false,
        path: file_path.to_owned(),
        name: name.clone(),
        ext: ext.clone(),
        family,
        size_bytes: 0.0,
        mtime_ms: 0.0,
        thumbnail_data_url: None,
        doc_blocks: None,
        sheets: None,
        slides: None,
        mindmap: None,
        plain_text: None,
        truncated: None,
        error: None,
        error_message: None,
    };
    let failed = |payload: &QuickLookPayload, error: ErrorCode| QuickLookPayload {
        error: Some(error),
        ..payload.clone()
    };

    if file_path.is_empty() || !is_absolute(file_path) {
        return failed(&base, ErrorCode::Missing);
    }
    if family == Family::Unsupported {
        return failed(&base, ErrorCode::Unsupported);
    }

    let Ok(meta) = fs::metadata(file_path) else {
        return failed(&base, ErrorCode::Missing);
    };
    if !meta.is_file() {
        return failed(&base, ErrorCode::Missing);
    }
    let info = StatInfo::of(&meta);
    let sized = QuickLookPayload {
        size_bytes: info.size as f64,
        mtime_ms: info.mtime_ms,
        ..base
    };
    let max_bytes = if family == Family::Image {
        MAX_IMAGE_BYTES
    } else {
        MAX_DOCUMENT_BYTES
    };
    if info.size > max_bytes {
        return QuickLookPayload {
            error: Some(ErrorCode::Unreadable),
            error_message: Some(Some("File is too large for Quick Look preview".to_owned())),
            ..sized
        };
    }

    let key = cache
        .as_ref()
        .map(|_| cache_key_of(file_path, sized.size_bytes, sized.mtime_ms));
    if let (Some(cache), Some(key)) = (cache.as_deref(), key.as_deref())
        && let Some(hit) = cache.get(key)
    {
        return hit.clone();
    }
    let mut remember = |payload: &QuickLookPayload| {
        if let (Some(cache), Some(key)) = (cache.as_deref_mut(), key.as_ref()) {
            cache.remember(key.clone(), payload.clone());
        }
    };

    if family == Family::Image {
        let Ok(bytes) = fs::read(file_path) else {
            return failed(&sized, ErrorCode::Unreadable);
        };
        let mime = sniff_image_mime(&bytes)
            .or_else(|| image_mime_of_ext(&ext))
            .unwrap_or("image/png");
        let result = QuickLookPayload {
            ok: true,
            thumbnail_data_url: Some(format!("data:{mime};base64,{}", base64(&bytes))),
            ..sized
        };
        remember(&result);
        return result;
    }

    // the embedded thumbnail, read before the text as the TypeScript starts it first
    let thumbnail = if matches!(
        family,
        Family::Hwp | Family::Docx | Family::Pptx | Family::Xlsx | Family::Xmind
    ) {
        fs::read(file_path)
            .ok()
            .and_then(|bytes| extract_embedded_thumbnail(engines, &ext, &bytes))
    } else {
        None
    };

    let parsed = match engines.parse_file_to_text(file_path) {
        Ok(parsed) => parsed,
        Err(message) => {
            return QuickLookPayload {
                error: Some(classify_parse_error(Some(&message))),
                error_message: Some(Some(message)),
                ..sized
            };
        }
    };

    if !parsed.ok {
        // an Office or HWP file whose text could not be read still shows its preview image
        if thumbnail.is_some()
            && classify_parse_error(parsed.error.as_deref()) != ErrorCode::Encrypted
        {
            let partial = QuickLookPayload {
                ok: true,
                thumbnail_data_url: thumbnail,
                ..sized
            };
            remember(&partial);
            return partial;
        }
        return QuickLookPayload {
            error: Some(classify_parse_error(parsed.error.as_deref())),
            error_message: Some(parsed.error),
            ..sized
        };
    }

    let raw_text = parsed.text.unwrap_or_default();
    let plain_truncated = raw_text.encode_utf16().count() > MAX_PLAIN_CHARS;
    let plain_text = if plain_truncated {
        slice_utf16(&raw_text, 0.0, Some(MAX_PLAIN_CHARS as f64))
    } else {
        raw_text.clone()
    };

    let mut result = QuickLookPayload {
        ok: true,
        thumbnail_data_url: thumbnail,
        ..sized
    };
    match family {
        Family::Xlsx => {
            let (sheets, truncated) = parse_sheets_from_text(&raw_text, &ext, &name);
            result.sheets = Some(sheets);
            result.truncated = Some(truncated || plain_truncated);
        }
        Family::Pptx => {
            let (slides, truncated) = parse_slides_from_text(&raw_text);
            result.slides = Some(slides);
            result.truncated = Some(truncated || plain_truncated);
        }
        Family::Xmind => {
            let (mindmap, truncated) = parse_mindmap_from_text(&raw_text);
            result.mindmap = Some(mindmap);
            result.truncated = Some(truncated || plain_truncated);
        }
        Family::Docx | Family::Hwp | Family::Md | Family::Pdf => {
            let (blocks, truncated) = parse_doc_blocks_from_text(&plain_text);
            result.doc_blocks = Some(blocks);
            result.plain_text = Some(plain_text);
            result.truncated = Some(truncated || plain_truncated);
        }
        _ => {
            result.plain_text = Some(plain_text);
            result.truncated = Some(plain_truncated);
        }
    }
    remember(&result);
    result
}
