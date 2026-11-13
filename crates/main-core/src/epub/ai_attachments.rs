//! `apps/epub/src/main/ai-attachments.ts`: the AI panel's attachments, on the
//! main-process side. The same contract as the other editors' attachment
//! readers:
//!
//! - A file is accepted by extension and size; pictures (5 MB at most) go to
//!   the model as pictures with the user message, every other kind is read as
//!   text.
//! - Text comes from `parseFileToText` and nowhere else; a file open in a tab
//!   with unsaved changes is not read (`assertFileSaved`).
//! - One read hands back at most 48,000 characters.
//!
//! `ipcMain.handle` stays in TypeScript. The handler bodies are
//! [`pick_attachments`], [`collect_attachments`],
//! [`AiAttachments::add_pasted_image`], [`AiAttachments::read_attachment_page`]
//! and [`read_attachment_image`]. The module-level state of the
//! TypeScript (`pastedImageSeq`, `pastedDirPruned`, `textCache`) is
//! [`AiAttachments`], which the caller owns.
//!
//! Engine-waiting: `parseFileToText` (the file readers), the draw.io engine
//! behind `diagramPictureExtOf`, and the file system, behind
//! [`AttachmentsHost`].

use crate::packages::ai_provider::jsval::{length16, number, object, prop, text};
use crate::packages::electron_utils::dialog_memory::{
    Dialog, DialogMemory, show_open_dialog_with_memory,
};
use crate::packages::electron_utils::unsaved_files::{OpenFilesHolder, assert_file_saved};
use crate::packages::file_parse::attachable::{
    ATTACHABLE_IMAGE_EXTS, ATTACHABLE_IMAGE_MAX_BYTES, ATTACHABLE_MAX_BYTES, attachable_exts,
    attachable_max_bytes, is_attachable_ext_exact,
};
use crate::packages::file_parse::diagram::diagram_picture_ext_of_name;
use crate::packages::i18n::{I18n, Lang, create_i18n};
use jscompat::node_path::host::{basename, extname, join};
use jscompat::{
    JsObject, JsonValue, base64, js_regex, math_round, number_to_string, slice_utf16,
    to_iso_string, to_primitive,
};

/// `ATTACH_STRINGS` as `(key, en, ko)`, the keys in the order of the
/// TypeScript's dictionaries. Non-ASCII text is written as escapes.
const ATTACH_STRINGS: &[(&str, &str, &str)] = &[
    (
        "dlgAddAttachment",
        "Add Attachments",
        "\u{CCA8}\u{BD80} \u{D30C}\u{C77C} \u{CD94}\u{AC00}",
    ),
    (
        "filterSupported",
        "Supported Files",
        "\u{C9C0}\u{C6D0}\u{B418}\u{B294} \u{D30C}\u{C77C}",
    ),
    (
        "filterAll",
        "All Files",
        "\u{BAA8}\u{B4E0} \u{D30C}\u{C77C}",
    ),
    (
        "errUnsupportedExt",
        ".{ext} files are not supported",
        ".{ext} \u{D615}\u{C2DD}\u{C740} \u{C9C0}\u{C6D0}\u{B418}\u{C9C0} \u{C54A}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "errNotFile",
        "not a file",
        "\u{D30C}\u{C77C}\u{C774} \u{C544}\u{B2D9}\u{B2C8}\u{B2E4}",
    ),
    (
        "errTooLarge",
        "exceeds the {mb}MB limit",
        "{mb}MB \u{C81C}\u{D55C}\u{C744} \u{CD08}\u{ACFC}\u{D588}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "errImageTooLarge",
        "image exceeds the 5MB limit",
        "\u{C774}\u{BBF8}\u{C9C0}\u{AC00} 5MB \u{C81C}\u{D55C}\u{C744} \u{CD08}\u{ACFC}\u{D588}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "errUnreadable",
        "cannot be read",
        "\u{C77D}\u{C744} \u{C218} \u{C5C6}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "errFileTooLarge",
        "File exceeds the size limit",
        "\u{D30C}\u{C77C}\u{C774} \u{D06C}\u{AE30} \u{C81C}\u{D55C}\u{C744} \u{CD08}\u{ACFC}\u{D588}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "errParseFailed",
        "Failed to parse file",
        "\u{D30C}\u{C77C}\u{C744} \u{BD84}\u{C11D}\u{D558}\u{C9C0} \u{BABB}\u{D588}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "errImageNoText",
        "Image attachments have no text; the image is sent along with the user message",
        "\u{C774}\u{BBF8}\u{C9C0} \u{CCA8}\u{BD80} \u{D30C}\u{C77C}\u{C740} \u{D14D}\u{C2A4}\u{D2B8}\u{B97C} \u{C81C}\u{ACF5}\u{D558}\u{C9C0} \u{C54A}\u{C73C}\u{BA70}, \u{C774}\u{BBF8}\u{C9C0} \u{D615}\u{D0DC}\u{B85C} \u{C0AC}\u{C6A9}\u{C790} \u{BA54}\u{C2DC}\u{C9C0}\u{C640} \u{D568}\u{AED8} \u{C804}\u{C1A1}\u{B418}\u{BBC0}\u{B85C} \u{C774}\u{BBF8}\u{C9C0}\u{B97C} \u{C9C1}\u{C811} \u{D655}\u{C778}\u{D558}\u{BA74} \u{B429}\u{B2C8}\u{B2E4}",
    ),
    (
        "errNotImage",
        "not a supported image type",
        "\u{C9C0}\u{C6D0}\u{B418}\u{C9C0} \u{C54A}\u{B294} \u{C774}\u{BBF8}\u{C9C0} \u{D615}\u{C2DD}\u{C785}\u{B2C8}\u{B2E4}",
    ),
];

/// `createI18n(ATTACH_STRINGS)`
fn attach_i18n() -> I18n {
    let mut en = JsObject::new();
    let mut ko = JsObject::new();
    for (key, en_text, ko_text) in ATTACH_STRINGS {
        en.set(*key, (*en_text).to_owned());
        ko.set(*key, (*ko_text).to_owned());
    }
    create_i18n(en, ko)
}

/// `ATTACHMENT_MAX_BYTES`: the largest file read as an attachment
pub const ATTACHMENT_MAX_BYTES: f64 = ATTACHABLE_MAX_BYTES;
/// `ATTACHMENT_IMAGE_MAX_BYTES`: the largest picture sent to the model with a
/// message
pub const ATTACHMENT_IMAGE_MAX_BYTES: f64 = ATTACHABLE_IMAGE_MAX_BYTES;
/// `ATTACHMENT_READ_MAX_CHARS`: the most characters one read hands back; the
/// panel asks for less
pub const ATTACHMENT_READ_MAX_CHARS: f64 = 48_000.0;

/// `ATTACHMENT_EXTS`: what an attachment may be, in the order of the set
pub fn attachment_exts() -> Vec<&'static str> {
    attachable_exts()
}

/// `statSync(path)`: what the module reads of it
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FileStat {
    pub size: f64,
    pub mtime_ms: f64,
    pub is_file: bool,
}

/// what `parseFileToText` answered
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedText {
    pub ok: bool,
    pub kind: Option<String>,
    pub text: Option<String>,
    pub damaged: bool,
    pub error: Option<String>,
}

/// What the module reaches outside itself. A `Result` is `Err` where the
/// TypeScript call throws; the message is the error's.
pub trait AttachmentsHost {
    /// `getUiLang()`
    fn lang(&mut self) -> Lang;
    /// `statSync(path)`
    fn stat(&mut self, path: &str) -> Result<FileStat, String>;
    /// `diagramPictureExtOf(path)`: reads the file
    fn diagram_picture_ext_of(&mut self, path: &str) -> Option<&'static str>;
    /// `app.getPath('temp')`
    fn temp_dir(&mut self) -> String;
    /// `Date.now()`
    fn now_ms(&mut self) -> f64;
    /// `mkdirSync(dir, { recursive: true })`
    fn make_dir(&mut self, dir: &str) -> Result<(), String>;
    /// `readdirSync(dir)`
    fn read_dir(&mut self, dir: &str) -> Result<Vec<String>, String>;
    /// `unlinkSync(path)`
    fn unlink(&mut self, path: &str) -> Result<(), String>;
    /// `writeFileSync(path, bytes)`
    fn write_file(&mut self, path: &str, bytes: &[u8]) -> Result<(), String>;
    /// `readFileSync(path)`
    fn read_file(&mut self, path: &str) -> Result<Vec<u8>, String>;
    /// `parseFileToText(path)`
    fn parse_file_to_text(&mut self, path: &str) -> Result<ParsedText, String>;
}

/// `tm(key, vars)`
fn tm(host: &mut dyn AttachmentsHost, key: &str, vars: Option<&JsObject<JsonValue>>) -> String {
    let lang = host.lang();
    attach_i18n().t(lang, key, vars)
}

/// `{ name: value }`: the variables of a template
fn var(name: &str, value: JsonValue) -> JsObject<JsonValue> {
    let mut vars = JsObject::new();
    vars.set(name, value);
    vars
}

/// `extOf(name)`
fn ext_of(name: &str) -> String {
    if name.contains('.') {
        name.split('.')
            .next_back()
            .map(str::to_lowercase)
            .unwrap_or_default()
    } else {
        String::new()
    }
}

/// `ATTACHABLE_IMAGE_EXTS.has(ext)`
fn is_image_ext(ext: &str) -> bool {
    ATTACHABLE_IMAGE_EXTS.contains(&ext)
}

/// `diagramPictureExtOf(filePath) ?? extOf(name)`
fn attachment_ext(host: &mut dyn AttachmentsHost, file_path: &str, name: &str) -> String {
    match host.diagram_picture_ext_of(file_path) {
        Some(ext) => ext.to_owned(),
        None => ext_of(name),
    }
}

/// `statAttachment(filePath)`: `Ok` is `{ meta }`, `Err` is `{ error }`
fn stat_attachment(host: &mut dyn AttachmentsHost, file_path: &str) -> Result<JsonValue, String> {
    let name = basename(file_path, None);
    // a draw.io picture that holds its diagram is read as diagram text
    let ext = attachment_ext(host, file_path, &name);
    if !is_attachable_ext_exact(&ext) {
        let reason = tm(
            host,
            "errUnsupportedExt",
            Some(&var("ext", text(ext.as_str()))),
        );
        return Err(format!("{name}: {reason}"));
    }
    let Ok(stat) = host.stat(file_path) else {
        let reason = tm(host, "errUnreadable", None);
        return Err(format!("{name}: {reason}"));
    };
    if !stat.is_file {
        let reason = tm(host, "errNotFile", None);
        return Err(format!("{name}: {reason}"));
    }
    if !is_image_ext(&ext) && stat.size > attachable_max_bytes(&ext) {
        let mb = math_round(ATTACHABLE_MAX_BYTES / 1024.0 / 1024.0);
        let reason = tm(host, "errTooLarge", Some(&var("mb", number(mb))));
        return Err(format!("{name}: {reason}"));
    }
    if is_image_ext(&ext) && stat.size > ATTACHABLE_IMAGE_MAX_BYTES {
        let reason = tm(host, "errImageTooLarge", None);
        return Err(format!("{name}: {reason}"));
    }
    Ok(object(vec![
        ("path", text(file_path)),
        ("name", text(name)),
        ("ext", text(ext)),
        ("sizeBytes", number(stat.size)),
    ]))
}

/// `collectAttachments(paths)`: the files that may be attached, with a reason
/// for each one that may not.
pub fn collect_attachments(host: &mut dyn AttachmentsHost, paths: &[JsonValue]) -> JsonValue {
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    for path in paths {
        let JsonValue::String(path) = path else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        match stat_attachment(host, path) {
            Ok(meta) => accepted.push(meta),
            Err(error) => rejected.push(text(error)),
        }
    }
    object(vec![
        ("accepted", JsonValue::Array(accepted)),
        ("rejected", JsonValue::Array(rejected)),
    ])
}

/// text already read, by path: `{ stamp, text }`
#[derive(Debug, Clone, PartialEq)]
struct CachedText {
    path: String,
    stamp: String,
    text: String,
}

/// the module-level state: `pastedImageSeq`, `pastedDirPruned`, `textCache`
#[derive(Debug, Default)]
pub struct AiAttachments {
    pasted_image_seq: f64,
    pasted_dir_pruned: bool,
    /// a changed file (time or size) is read again; the oldest of more than
    /// eight is dropped
    text_cache: Vec<CachedText>,
}

/// A picture pasted from the clipboard, as it was saved.
#[derive(Debug, Clone, PartialEq)]
pub enum PastedImage {
    /// the temporary file it went to
    Path(String),
    TooLarge,
    /// not a picture of a kind that is taken
    Refused,
}

impl AiAttachments {
    pub fn new() -> Self {
        Self::default()
    }

    /// `prunePastedImages(dir)`: pasted pictures older than a week are
    /// removed, once per run of the app.
    fn prune_pasted_images(&mut self, host: &mut dyn AttachmentsHost, dir: &str) {
        if self.pasted_dir_pruned {
            return;
        }
        self.pasted_dir_pruned = true;
        let cutoff = host.now_ms() - 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
        // the folder may not exist yet
        let Ok(names) = host.read_dir(dir) else {
            return;
        };
        for name in names {
            let path = join(&[dir, &name]);
            // another tab may have removed it already
            if let Ok(stat) = host.stat(&path)
                && stat.mtime_ms < cutoff
            {
                let _ = host.unlink(&path);
            }
        }
    }

    /// `savePastedImage(data, ext)`: a picture pasted from the clipboard (no
    /// file of its own) goes to a temporary file, then the usual way. `data`
    /// is `None` where it is neither an `ArrayBuffer` nor a view of one.
    /// `Err` is a failure of the folder or the write.
    pub fn save_pasted_image(
        &mut self,
        host: &mut dyn AttachmentsHost,
        data: Option<&[u8]>,
        ext: Option<&JsonValue>,
    ) -> Result<PastedImage, String> {
        let clean_ext = match ext {
            Some(JsonValue::String(ext)) => ext.to_lowercase(),
            _ => String::new(),
        };
        if !is_image_ext(&clean_ext) {
            return Ok(PastedImage::Refused);
        }
        let Some(bytes) = data.filter(|bytes| !bytes.is_empty()) else {
            return Ok(PastedImage::Refused);
        };
        // the renderer decides what lands on disk here: the picture limit
        // applies before anything is written
        if bytes.len() as f64 > ATTACHABLE_IMAGE_MAX_BYTES {
            return Ok(PastedImage::TooLarge);
        }
        let dir = join(&[&host.temp_dir(), "seuoffice-pasted"]);
        host.make_dir(&dir)?;
        self.prune_pasted_images(host, &dir);
        let iso = to_iso_string(host.now_ms()).unwrap_or_default();
        let stamp = js_regex!(r"[-:]", "g")
            .replace_all(&slice_utf16(&iso, 0.0, Some(19.0)), |_| String::new());
        let stamp = stamp.replacen('T', "-", 1);
        self.pasted_image_seq += 1.0;
        let seq = number_to_string(self.pasted_image_seq);
        let path = join(&[&dir, &format!("pasted-{stamp}-{seq}.{clean_ext}")]);
        host.write_file(&path, bytes)?;
        Ok(PastedImage::Path(path))
    }

    /// the handler of `filesAddPastedImage`
    pub fn add_pasted_image(
        &mut self,
        host: &mut dyn AttachmentsHost,
        data: Option<&[u8]>,
        ext: Option<&JsonValue>,
    ) -> Result<JsonValue, String> {
        let saved = self.save_pasted_image(host, data, ext)?;
        Ok(match saved {
            PastedImage::TooLarge => {
                let reason = tm(host, "errImageTooLarge", None);
                object(vec![
                    ("accepted", JsonValue::Array(Vec::new())),
                    ("rejected", JsonValue::Array(vec![text(reason)])),
                ])
            }
            PastedImage::Path(path) => collect_attachments(host, &[text(path)]),
            PastedImage::Refused => {
                let reason = tm(host, "errNotImage", None);
                object(vec![
                    ("accepted", JsonValue::Array(Vec::new())),
                    ("rejected", JsonValue::Array(vec![text(reason)])),
                ])
            }
        })
    }

    /// `attachmentText(filePath)`
    fn attachment_text(
        &mut self,
        host: &mut dyn AttachmentsHost,
        open_files: &OpenFilesHolder,
        file_path: &str,
    ) -> Result<String, String> {
        // a file open with unsaved changes is not read (before the cache): a
        // withholding mark only reaches the file on save
        assert_file_saved(open_files, file_path).map_err(str::to_owned)?;
        let stat = host.stat(file_path)?;
        let stamp = format!(
            "{}:{}",
            number_to_string(stat.mtime_ms),
            number_to_string(stat.size)
        );
        if let Some(cached) = self
            .text_cache
            .iter()
            .find(|c| c.path == file_path && c.stamp == stamp)
        {
            return Ok(cached.text.clone());
        }
        let cap_ext = match diagram_picture_ext_of_name(file_path) {
            Some(ext) => ext.to_owned(),
            None => extname(file_path),
        };
        if stat.size > attachable_max_bytes(&cap_ext) {
            return Err(tm(host, "errFileTooLarge", None));
        }
        let parsed = host.parse_file_to_text(file_path)?;
        let text_of = match (&parsed.kind, &parsed.text) {
            (Some(kind), Some(text)) if parsed.ok && kind == "text" => Some(text.clone()),
            _ => None,
        };
        let Some(parsed_text) = text_of else {
            let own = match &parsed.error {
                Some(error) if !parsed.damaged && !error.is_empty() => Some(error.clone()),
                _ => None,
            };
            return Err(match own {
                Some(error) => error,
                None => tm(host, "errParseFailed", None),
            });
        };
        match self.text_cache.iter_mut().find(|c| c.path == file_path) {
            Some(entry) => {
                entry.stamp = stamp;
                entry.text = parsed_text.clone();
            }
            None => self.text_cache.push(CachedText {
                path: file_path.to_owned(),
                stamp,
                text: parsed_text.clone(),
            }),
        }
        if self.text_cache.len() > 8 {
            self.text_cache.remove(0);
        }
        Ok(parsed_text)
    }

    /// `readAttachmentPage(filePath, offset, maxChars)`: one page of an
    /// attachment's text: from `offset`, at most `maxChars` (and never more
    /// than 48,000). `open_files` is the shell's list of open documents,
    /// filled by the caller before the call (`assertFileSaved` reads it).
    pub fn read_attachment_page(
        &mut self,
        host: &mut dyn AttachmentsHost,
        open_files: &OpenFilesHolder,
        file_path: Option<&JsonValue>,
        offset: Option<&JsonValue>,
        max_chars: Option<&JsonValue>,
    ) -> JsonValue {
        let file_path = match file_path {
            Some(JsonValue::String(path)) if !path.is_empty() => path.as_str(),
            _ => {
                let error = tm(host, "errUnreadable", None);
                return failure(error);
            }
        };
        let name = basename(file_path, None);
        let ext = attachment_ext(host, file_path, &name);
        if !is_attachable_ext_exact(&ext) {
            let error = tm(
                host,
                "errUnsupportedExt",
                Some(&var("ext", text(ext.as_str()))),
            );
            return failure(error);
        }
        if is_image_ext(&ext) {
            let error = tm(host, "errImageNoText", None);
            return failure(error);
        }
        match self.attachment_text(host, open_files, file_path) {
            Ok(page_text) => {
                let start = number_or_zero(offset).max(0.0);
                let size = number_or_one(max_chars).clamp(1.0, ATTACHMENT_READ_MAX_CHARS);
                object(vec![
                    ("ok", JsonValue::Bool(true)),
                    ("name", text(name)),
                    ("totalChars", number(length16(&page_text) as f64)),
                    ("offset", number(start)),
                    (
                        "text",
                        text(slice_utf16(&page_text, start, Some(start + size))),
                    ),
                ])
            }
            Err(error) => failure(error),
        }
    }
}

/// `{ ok: false, error }`
fn failure(error: String) -> JsonValue {
    object(vec![("ok", JsonValue::Bool(false)), ("error", text(error))])
}

/// `Number(value)`
fn to_number_of(value: Option<&JsonValue>) -> f64 {
    to_primitive(value).map_or(f64::NAN, |p| p.to_number())
}

/// `Math.floor(Number(value)) || 0`
fn number_or_zero(value: Option<&JsonValue>) -> f64 {
    let n = to_number_of(value).floor();
    if n.is_nan() || n == 0.0 { 0.0 } else { n }
}

/// `Math.floor(Number(value)) || 1`
fn number_or_one(value: Option<&JsonValue>) -> f64 {
    let n = to_number_of(value).floor();
    if n.is_nan() || n == 0.0 { 1.0 } else { n }
}

/// What `ATTACHMENT_IMAGE_MIME[ext]` reads: a picture type, or a property
/// every object inherits (the extension is lower case, so only `constructor`
/// and `__proto__` match), or nothing.
enum Mime {
    Known(&'static str),
    InheritedFunction,
    InheritedObject,
    Absent,
}

fn mime_of(ext: &str) -> Mime {
    match ext {
        "png" => Mime::Known("image/png"),
        "jpg" | "jpeg" => Mime::Known("image/jpeg"),
        "gif" => Mime::Known("image/gif"),
        "webp" => Mime::Known("image/webp"),
        "constructor" => Mime::InheritedFunction,
        "__proto__" => Mime::InheritedObject,
        _ => Mime::Absent,
    }
}

/// `readAttachmentImage(filePath)`: a picture attachment as base64, for the
/// user message. `mime` of an inherited property is what `JSON.stringify`
/// makes of a function (the key is left out) or of `Object.prototype` (`{}`).
pub fn read_attachment_image(
    host: &mut dyn AttachmentsHost,
    file_path: Option<&JsonValue>,
) -> JsonValue {
    let path = match file_path {
        Some(JsonValue::String(path)) => path.as_str(),
        _ => "",
    };
    let name = basename(path, None);
    let mime = mime_of(&ext_of(&name));
    if path.is_empty() || matches!(mime, Mime::Absent) {
        let reason = tm(host, "errNotImage", None);
        return failure(format!("{name}: {reason}"));
    }
    let Ok(stat) = host.stat(path) else {
        let reason = tm(host, "errUnreadable", None);
        return failure(format!("{name}: {reason}"));
    };
    if stat.size > ATTACHABLE_IMAGE_MAX_BYTES {
        let reason = tm(host, "errImageTooLarge", None);
        return failure(format!("{name}: {reason}"));
    }
    let Ok(bytes) = host.read_file(path) else {
        let reason = tm(host, "errUnreadable", None);
        return failure(format!("{name}: {reason}"));
    };
    let mut entries = vec![
        ("ok", JsonValue::Bool(true)),
        ("base64", text(base64(&bytes))),
    ];
    match mime {
        Mime::Known(mime) => entries.push(("mime", text(mime))),
        Mime::InheritedObject => entries.push(("mime", object(Vec::new()))),
        Mime::InheritedFunction | Mime::Absent => {}
    }
    object(entries)
}

/// the handler of `filesPick`: the dialog, then the files it picked; `None`
/// where nothing was picked. `parent` is `BrowserWindow.fromWebContents(
/// e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined`. `Err` is the
/// `TypeError` of a dialog answer without `filePaths`.
pub fn pick_attachments<D: Dialog>(
    host: &mut dyn AttachmentsHost,
    memory: &mut DialogMemory,
    dialog: &mut D,
    parent: Option<&D::Window>,
) -> Result<Option<JsonValue>, String> {
    let title = tm(host, "dlgAddAttachment", None);
    let supported = tm(host, "filterSupported", None);
    let all = tm(host, "filterAll", None);
    let extensions: Vec<JsonValue> = attachable_exts().into_iter().map(text).collect();
    let mut options = JsObject::new();
    options.set("title", text(title));
    options.set(
        "filters",
        JsonValue::Array(vec![
            object(vec![
                ("name", text(supported)),
                ("extensions", JsonValue::Array(extensions)),
            ]),
            object(vec![
                ("name", text(all)),
                ("extensions", JsonValue::Array(vec![text("*")])),
            ]),
        ]),
    );
    options.set(
        "properties",
        JsonValue::Array(vec![text("openFile"), text("multiSelections")]),
    );
    let picked = show_open_dialog_with_memory(memory, dialog, parent, &options, None);
    let canceled = prop(&picked, "canceled").is_some_and(JsonValue::truthy);
    let paths = match prop(&picked, "filePaths") {
        Some(JsonValue::Array(paths)) => paths.clone(),
        _ if canceled => return Ok(None),
        other => {
            return Err(match other {
                None => "Cannot read properties of undefined (reading 'length')".to_owned(),
                Some(_) => "filePaths is not an array".to_owned(),
            });
        }
    };
    if canceled || paths.is_empty() {
        return Ok(None);
    }
    Ok(Some(collect_attachments(host, &paths)))
}
