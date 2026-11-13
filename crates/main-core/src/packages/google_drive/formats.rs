//! `packages/google-drive/src/formats.ts`: which Drive files the app can open,
//! and how. Office, PDF, Markdown, HTML, mind map, Hangul, EPUB and draw.io
//! diagram files download as they are; Google's own documents have no file to
//! download and are exported to the matching Office format.

use jscompat::{js_regex, replace_first, slice_utf16, trim};

use crate::packages::ai_provider::jsval::slice_to;

pub const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
pub const SHORTCUT_MIME: &str = "application/vnd.google-apps.shortcut";

const DOCX_MIME: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME: &str = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/// The Office file a Google format is exported to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GoogleExport {
    pub mime: &'static str,
    pub extension: &'static str,
}

/// `GOOGLE_EXPORTS`: Google's own formats and the Office file each one is
/// exported to, in the order the table lists them.
pub const GOOGLE_EXPORTS: [(&str, GoogleExport); 3] = [
    (
        "application/vnd.google-apps.document",
        GoogleExport {
            mime: DOCX_MIME,
            extension: ".docx",
        },
    ),
    (
        "application/vnd.google-apps.spreadsheet",
        GoogleExport {
            mime: XLSX_MIME,
            extension: ".xlsx",
        },
    ),
    (
        "application/vnd.google-apps.presentation",
        GoogleExport {
            mime: PPTX_MIME,
            extension: ".pptx",
        },
    ),
];

/// `OPENABLE_EXTENSIONS`: extensions the app's editors open; a Drive file
/// outside this list is listed but not opened.
pub const OPENABLE_EXTENSIONS: [&str; 20] = [
    ".docx",
    ".xlsx",
    ".xlsm",
    ".xls",
    ".csv",
    ".tsv",
    ".pptx",
    ".pdf",
    ".md",
    ".markdown",
    ".txt",
    ".json",
    ".html",
    ".htm",
    ".xmind",
    ".hwp",
    ".hwpx",
    ".epub",
    ".drawio",
    ".dio",
];

/// `UPLOAD_MIME`: the upload type for an extension the app saves.
const UPLOAD_MIME: [(&str, &str); 10] = [
    (".docx", DOCX_MIME),
    (".xlsx", XLSX_MIME),
    (".pptx", PPTX_MIME),
    (".pdf", "application/pdf"),
    (".md", "text/markdown"),
    (".markdown", "text/markdown"),
    (".txt", "text/plain"),
    (".csv", "text/csv"),
    (".html", "text/html"),
    (".htm", "text/html"),
];

/// The own property names of `Object.prototype`: `GOOGLE_EXPORTS[name]` is a
/// truthy value for each of them, an object with no `mime` and no `extension`.
const INHERITED: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// `isGoogleNative(mimeType)`
pub fn is_google_native(mime_type: &str) -> bool {
    mime_type.starts_with("application/vnd.google-apps.")
}

/// `extensionOf(name)`: the last dot and what follows it, lower-cased; none
/// for a name that has a dot only at its start, or none at all.
pub fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot..].to_lowercase(),
        _ => String::new(),
    }
}

/// `OpenPlan`: how the app gets a file's bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenPlan {
    Download {
        extension: String,
    },
    /// `mime` and `extension` are `undefined` for a mime type that names a
    /// property `Object.prototype` has (`GOOGLE_EXPORTS["constructor"]`)
    Export {
        mime: Option<String>,
        extension: Option<String>,
    },
    None,
}

/// `openPlan(file)`: download as is, export to Office, or not at all
/// (folders, forms, drawings, and formats no editor opens).
pub fn open_plan(name: &str, mime_type: &str) -> OpenPlan {
    if let Some((_, exported)) = GOOGLE_EXPORTS.iter().find(|(mime, _)| *mime == mime_type) {
        return OpenPlan::Export {
            mime: Some(exported.mime.to_owned()),
            extension: Some(exported.extension.to_owned()),
        };
    }
    if INHERITED.contains(&mime_type) {
        return OpenPlan::Export {
            mime: None,
            extension: None,
        };
    }
    if is_google_native(mime_type) {
        return OpenPlan::None;
    }
    let extension = extension_of(name);
    if OPENABLE_EXTENSIONS.contains(&extension.as_str()) {
        OpenPlan::Download { extension }
    } else {
        OpenPlan::None
    }
}

/// `uploadMime(name)`: octet-stream lets Drive keep its own guess.
pub fn upload_mime(name: &str) -> String {
    let extension = extension_of(name);
    UPLOAD_MIME
        .iter()
        .find(|(known, _)| *known == extension)
        .map_or("application/octet-stream", |(_, mime)| *mime)
        .to_owned()
}

/// `localFileName(driveName, extension)`: the Drive name, made safe for
/// Windows, ending in the extension the bytes really have.
pub fn local_file_name(drive_name: &str, extension: &str) -> String {
    let replaced =
        js_regex!(r#"[<>:"/\\|?*\p{Cc}]"#, "gu").replace_all(drive_name, |_| "_".to_owned());
    let stripped = replace_first(js_regex!(r"[. ]+$"), 0, &replaced, "");
    let cleaned = trim(&stripped);
    let length = extension.encode_utf16().count();
    // `cleaned.slice(0, -extension.length)`: an empty extension keeps nothing
    let base = if extension_of(cleaned) == extension {
        slice_utf16(cleaned, 0.0, Some(-(length as f64)))
    } else {
        cleaned.to_owned()
    };
    let reserved = js_regex!(r"^(con|prn|aux|nul|com\d|lpt\d)$", "i").test(&base);
    let named = if reserved { format!("_{base}") } else { base };
    let mut safe = slice_to(&named, 120);
    if safe.is_empty() {
        safe = "document".to_owned();
    }
    format!("{safe}{extension}")
}

/// `officeCopyName(driveName, extension)`: the Office copy a Google document
/// is saved to: same name with the Office extension.
pub fn office_copy_name(drive_name: &str, extension: &str) -> String {
    if extension_of(drive_name) == extension {
        drive_name.to_owned()
    } else {
        format!("{drive_name}{extension}")
    }
}
