//! Chat attachment channels of the Hangul editor (`apps/hwp/src/main/attachments-ipc.ts`):
//! local files the user hands to the AI panel are validated and read here.
//!
//! What is not in Rust yet (the file parsers of `@seuoffice/file-parse`, the
//! draw.io reader, the host's list of open documents) is
//! [`super::HwpEngine`]. The constants and the size and extension rules of
//! `packages/file-parse/src/attachable.ts`, `statAttachment`,
//! `collectAttachments`, the text cache and the pasted-image counter are here.

use std::cell::{Cell, RefCell};
use std::fs;
use std::io::Read;
use std::rc::Rc;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use jscompat::node_path::host::{basename, extname};
use jscompat::{JsObject, JsonValue};
use main_core::hwp::dialog_strings::tm;
use main_core::node_fs::{node_error, node_error_fd};
use main_core::packages::electron_utils::dialog_memory::{
    DialogMemory, show_open_dialog_with_memory,
};
use main_core::packages::electron_utils::unsaved_files::{OpenFilesHolder, assert_file_saved};
use main_core::packages::i18n::{Lang, normalize_lang};
use shell_contract::hosts::{ContentsHost, DialogsHost};
use shell_contract::ipc::RegisterError;
use shell_contract::runtime::{PathName, Services};
use shell_contract::{Batch, IpcError, IpcValue};

use super::{FileDialogs, HwpEngine, HwpEngineHost, HwpShell, HwpShellHost};
use crate::kit::{self, Entry, IntoIpc, obj};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
// the shell's engine host makes them; this crate only reads them
#[cfg_attr(not(any(test, feature = "probe")), allow(dead_code))]
pub enum ParsedFileKind {
    Text,
    Image,
    Unsupported,
}

/// `ParsedFile` of `parseFileToText`, the members the attachment reader reads
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedFile {
    pub ok: bool,
    pub kind: ParsedFileKind,
    pub text: Option<String>,
    pub error: Option<String>,
    /// the container is damaged: `error` is not shown, the reader's own text is
    pub damaged: bool,
}

// ---- attachable.ts ----

/// plain-text extensions read as UTF-8
const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log",
    "js", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp", "go", "rs", "rb", "sh", "sql", "css",
];
const DOCUMENT_EXTS: &[&str] = &[
    "doc", "docx", "odt", "pdf", "pptx", "ppt", "xlsx", "xlsm", "xls", "xmind", "hwp", "hwpx",
    "epub",
];
const DIAGRAM_EXTS: &[&str] = &["drawio", "dio", "drawio.svg", "drawio.png"];
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
/// formats read at any size: their size is pictures, not words
const SIZE_FREE_EXTS: &[&str] = &[
    "docx", "pptx", "xlsx", "xlsm", "hwpx", "odt", "epub", "xmind", "pdf",
];

const ATTACHABLE_MAX_BYTES: u64 = 50 * 1024 * 1024;
const ATTACHABLE_IMAGE_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// the most characters one `hwp:files-read` call returns
const READ_MAX_CHARS: f64 = 48_000.0;
/// the extracted-text cache keeps this many files
const TEXT_CACHE_FILES: usize = 8;

/// `ATTACHABLE_EXTS` in the TypeScript set's order (the open dialog lists it)
fn attachable_exts() -> impl Iterator<Item = &'static str> {
    TEXT_EXTS
        .iter()
        .chain(DOCUMENT_EXTS)
        .chain(DIAGRAM_EXTS)
        .chain(IMAGE_EXTS)
        .copied()
}

fn is_attachable(ext: &str) -> bool {
    attachable_exts().any(|known| known == ext)
}

fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}

/// `size > attachableMaxBytes(ext)`: a picture's cap, no cap for the formats
/// read at any size, else the whole-file cap
fn exceeds_max_bytes(size: u64, ext: &str) -> bool {
    let clean = ext.strip_prefix('.').unwrap_or(ext).to_lowercase();
    if is_image_ext(&clean) {
        size > ATTACHABLE_IMAGE_MAX_BYTES
    } else if SIZE_FREE_EXTS.contains(&clean.as_str()) {
        false
    } else {
        size > ATTACHABLE_MAX_BYTES
    }
}

/// `diagramPictureExtOfName`: `drawio.svg` / `drawio.png` by the name's ending
fn diagram_picture_ext_of_name(file_name: &str) -> Option<&'static str> {
    let name = file_name.to_lowercase();
    if name.ends_with(".drawio.svg") {
        Some("drawio.svg")
    } else if name.ends_with(".drawio.png") {
        Some("drawio.png")
    } else {
        None
    }
}

/// `diagramPictureExtOf(filePath)`: the double extension of a draw.io picture
/// that holds its diagram. A file that cannot be read, or is past the cap,
/// keeps its diagram name; the text reader then reports why it fails.
fn diagram_picture_ext_of(engine: &dyn HwpEngine, path: &str) -> Option<&'static str> {
    let name = basename(path, None);
    let ext = diagram_picture_ext_of_name(&name)?;
    let no_original = (|| {
        if fs::metadata(path).ok()?.len() > ATTACHABLE_MAX_BYTES {
            return None;
        }
        let bytes = fs::read(path).ok()?;
        Some(engine.diagram_picture_has_no_original(name, bytes))
    })()
    .unwrap_or(false);
    (!no_original).then_some(ext)
}

/// `diagramPictureExtOf(filePath) ?? name.split('.').pop()?.toLowerCase() ?? ''`
fn attachment_ext(engine: &dyn HwpEngine, path: &str, name: &str) -> String {
    diagram_picture_ext_of(engine, path).map_or_else(|| last_ext(name), str::to_owned)
}

/// `name.split('.').pop().toLowerCase()`
fn last_ext(name: &str) -> String {
    name.rsplit('.').next().unwrap_or_default().to_lowercase()
}

// ---- replies ----

/// `AttachmentMeta`
struct AttachmentMeta {
    path: String,
    name: String,
    ext: String,
    size_bytes: u64,
}

impl IntoIpc for AttachmentMeta {
    fn into_ipc(self) -> IpcValue {
        obj([
            ("path", self.path.into_ipc()),
            ("name", self.name.into_ipc()),
            ("ext", self.ext.into_ipc()),
            ("sizeBytes", (self.size_bytes as f64).into_ipc()),
        ])
    }
}

/// `AttachmentAddResult`
struct AttachmentAddResult {
    accepted: Vec<AttachmentMeta>,
    rejected: Vec<String>,
}

impl IntoIpc for AttachmentAddResult {
    fn into_ipc(self) -> IpcValue {
        obj([
            ("accepted", self.accepted.into_ipc()),
            ("rejected", self.rejected.into_ipc()),
        ])
    }
}

/// `{ ok: false, error }` of the three read results
fn fail(error: impl Into<String>) -> IpcValue {
    obj([("ok", false.into_ipc()), ("error", error.into().into_ipc())])
}

fn tm_plain(lang: Lang, key: &str) -> String {
    tm(lang, key, None)
}

fn tm_ext(lang: Lang, ext: &str) -> String {
    let mut vars = JsObject::new();
    vars.set("ext", JsonValue::String(ext.to_owned()));
    tm(lang, "errUnsupportedExt", Some(&vars))
}

fn tm_too_large(lang: Lang) -> String {
    let mut vars = JsObject::new();
    // `Math.round(ATTACHABLE_MAX_BYTES / 1024 / 1024)`
    vars.set(
        "mb",
        JsonValue::Number((ATTACHABLE_MAX_BYTES / 1024 / 1024) as f64),
    );
    tm(lang, "errTooLarge", Some(&vars))
}

// ---- statAttachment / collectAttachments ----

fn stat_attachment(
    engine: &dyn HwpEngine,
    lang: Lang,
    path: &str,
) -> Result<AttachmentMeta, String> {
    let name = basename(path, None);
    let ext = attachment_ext(engine, path, &name);
    if !is_attachable(&ext) {
        return Err(format!("{name}: {}", tm_ext(lang, &ext)));
    }
    let Ok(stat) = fs::metadata(path) else {
        return Err(format!("{name}: {}", tm_plain(lang, "errUnreadable")));
    };
    if !stat.is_file() {
        return Err(format!("{name}: {}", tm_plain(lang, "errNotFile")));
    }
    let size = stat.len();
    if is_image_ext(&ext) {
        if size > ATTACHABLE_IMAGE_MAX_BYTES {
            return Err(format!("{name}: {}", tm_plain(lang, "errImageTooLarge")));
        }
    } else if exceeds_max_bytes(size, &ext) {
        return Err(format!("{name}: {}", tm_too_large(lang)));
    }
    Ok(AttachmentMeta {
        path: path.to_owned(),
        name,
        ext,
        size_bytes: size,
    })
}

fn collect_attachments<'a>(
    engine: &dyn HwpEngine,
    lang: Lang,
    paths: impl IntoIterator<Item = &'a str>,
) -> AttachmentAddResult {
    let mut result = AttachmentAddResult {
        accepted: Vec::new(),
        rejected: Vec::new(),
    };
    for path in paths {
        match stat_attachment(engine, lang, path) {
            Ok(meta) => result.accepted.push(meta),
            Err(error) => result.rejected.push(error),
        }
    }
    result
}

// ---- pasted images ----

/// `new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')`,
/// `Date.now()` being the shell's clock
fn pasted_stamp(ms: f64) -> String {
    jscompat::to_iso_string(ms)
        .unwrap_or_default()
        .chars()
        .take(19)
        .filter(|c| *c != '-' && *c != ':')
        .map(|c| if c == 'T' { '-' } else { c })
        .collect()
}

enum PasteRefused {
    TooLarge,
    Invalid,
}

/// `savePastedImage(data, ext)`: bytes of a clipboard picture to a temp file
fn save_pasted_image(
    temp: &std::path::Path,
    seq: &Cell<u64>,
    now_ms: f64,
    data: &IpcValue,
    ext: &IpcValue,
) -> Result<Result<String, PasteRefused>, IpcError> {
    let clean_ext = kit::as_str(ext).map(str::to_lowercase).unwrap_or_default();
    if !is_image_ext(&clean_ext) {
        return Ok(Err(PasteRefused::Invalid));
    }
    let bytes = match kit::as_bytes(data) {
        Some(bytes) if !bytes.is_empty() => bytes,
        _ => return Ok(Err(PasteRefused::Invalid)),
    };
    // Renderer-driven clipboard bytes hit the temp disk: the same 5MB image
    // cap as file attachments so pastes cannot fill the disk.
    if bytes.len() as u64 > ATTACHABLE_IMAGE_MAX_BYTES {
        return Ok(Err(PasteRefused::TooLarge));
    }
    let dir = temp.join("seuoffice-pasted");
    fs::create_dir_all(&dir)
        .map_err(|e| kit::error(node_error(&e, "mkdir", &dir.to_string_lossy()).message))?;
    seq.set(seq.get() + 1);
    let file = dir.join(format!(
        "pasted-{}-{}.{clean_ext}",
        pasted_stamp(now_ms),
        seq.get()
    ));
    fs::write(&file, bytes)
        .map_err(|e| kit::error(node_error(&e, "open", &file.to_string_lossy()).message))?;
    Ok(Ok(file.to_string_lossy().into_owned()))
}

// ---- extracted-text cache ----

struct CacheEntry {
    path: String,
    /// `${mtimeMs}:${size}`: the file changed when this does
    stamp: String,
    text: Rc<str>,
}

/// `attachmentTextCache`: a `Map` in insertion order, bounded by dropping the
/// oldest key. Setting a key that is there keeps its place, as `Map.set` does.
#[derive(Default)]
struct TextCache(Vec<CacheEntry>);

impl TextCache {
    fn get(&self, path: &str, stamp: &str) -> Option<Rc<str>> {
        self.0
            .iter()
            .find(|e| e.path == path && e.stamp == stamp)
            .map(|e| Rc::clone(&e.text))
    }

    fn set(&mut self, path: &str, stamp: String, text: Rc<str>) {
        match self.0.iter_mut().find(|e| e.path == path) {
            Some(entry) => {
                entry.stamp = stamp;
                entry.text = text;
            }
            None => self.0.push(CacheEntry {
                path: path.to_owned(),
                stamp,
                text,
            }),
        }
        if self.0.len() > TEXT_CACHE_FILES {
            self.0.remove(0);
        }
    }
}

/// `${stat.mtimeMs}:${stat.size}`
fn stamp_of(stat: &fs::Metadata) -> String {
    let mtime = stat
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    format!("{mtime}:{}", stat.len())
}

// ---- reading ----

/// `assertFileSaved(filePath)` over the host's open documents
fn assert_saved(engine: &dyn HwpEngine, path: &str) -> Result<(), String> {
    let Some(files) = engine.open_files() else {
        return Ok(());
    };
    let mut holder = OpenFilesHolder::new();
    holder.set_open_files_source(Some(Box::new(move || files.clone())));
    assert_file_saved(&holder, path).map_err(str::to_owned)
}

/// What `extractAttachmentText` needs before it parses
enum TextSource {
    Cached(Rc<str>),
    Parse { stamp: String },
}

/// `extractAttachmentText` up to the parse: unsaved check, stat, cache, size cap
fn text_source(
    engine: &dyn HwpEngine,
    lang: Lang,
    cache: &RefCell<TextCache>,
    path: &str,
) -> Result<TextSource, String> {
    // a file open with unsaved changes is not read (before the cache): a
    // withholding mark only reaches the file on save
    assert_saved(engine, path)?;
    let stat = fs::metadata(path).map_err(|e| node_error(&e, "stat", path).message)?;
    let stamp = stamp_of(&stat);
    if let Some(text) = cache.borrow().get(path, &stamp) {
        return Ok(TextSource::Cached(text));
    }
    let cap_ext = diagram_picture_ext_of_name(path).map_or_else(|| extname(path), str::to_owned);
    if exceeds_max_bytes(stat.len(), &cap_ext) {
        return Err(tm_plain(lang, "errFileTooLarge"));
    }
    Ok(TextSource::Parse { stamp })
}

/// The text of a parse that worked, else what the reader throws
fn parsed_text(parsed: ParsedFile, lang: Lang) -> Result<String, String> {
    match parsed {
        ParsedFile {
            ok: true,
            kind: ParsedFileKind::Text,
            text: Some(text),
            ..
        } => Ok(text),
        ParsedFile { damaged, error, .. } => Err(error
            .filter(|e| !damaged && !e.is_empty())
            .unwrap_or_else(|| tm_plain(lang, "errParseFailed"))),
    }
}

/// `Math.floor(x) || fallback`
fn floor_or(x: f64, fallback: f64) -> f64 {
    let floor = x.floor();
    if floor.is_nan() || floor == 0.0 {
        fallback
    } else {
        floor
    }
}

/// `Number(value)` of what a renderer may send in a number's place
fn to_number(v: &IpcValue) -> f64 {
    match v {
        IpcValue::Number(n) => *n,
        IpcValue::Date(ms) => *ms,
        IpcValue::Bool(b) => f64::from(u8::from(*b)),
        IpcValue::Null => 0.0,
        IpcValue::String(s) => jscompat::to_number(s),
        // `String([])` is empty and `String([x])` is `String(x)`
        IpcValue::Array(items) => match items.as_slice() {
            [] => 0.0,
            [IpcValue::Null | IpcValue::Undefined] => 0.0,
            [one] => to_number(one),
            _ => f64::NAN,
        },
        IpcValue::Undefined | IpcValue::Bytes(..) | IpcValue::Object(_) => f64::NAN,
    }
}

/// `{ ok: true, name, totalChars, offset, text: text.slice(start, start + size) }`.
/// A JavaScript string counts and slices in UTF-16 units.
fn read_reply(name: &str, text: &str, offset: f64, max_chars: f64) -> IpcValue {
    let start = floor_or(offset, 0.0).max(0.0);
    let size = floor_or(max_chars, 1.0).clamp(1.0, READ_MAX_CHARS);
    let total = text.encode_utf16().count();
    let slice = if start >= total as f64 {
        String::new()
    } else {
        let units: Vec<u16> = text
            .encode_utf16()
            .skip(start as usize)
            .take(size as usize)
            .collect();
        // a cut inside a surrogate pair cannot be a Rust string
        String::from_utf16_lossy(&units)
    };
    obj([
        ("ok", true.into_ipc()),
        ("name", name.into_ipc()),
        ("totalChars", (total as f64).into_ipc()),
        ("offset", start.into_ipc()),
        ("text", slice.into_ipc()),
    ])
}

/// `readFileSync(path)` with Node's error messages
fn read_file_sync(path: &str) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(path).map_err(|e| node_error(&e, "open", path).message)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| node_error_fd(&e, "read").message)?;
    Ok(bytes)
}

/// The `TypeError` `path.basename` throws for a value that is not a string
fn not_a_string_path(v: &IpcValue) -> IpcError {
    let received = match v {
        IpcValue::Undefined => "undefined".to_owned(),
        IpcValue::Null => "null".to_owned(),
        IpcValue::Bool(b) => format!("type boolean ({b})"),
        IpcValue::Number(n) => format!("type number ({})", jscompat::number_to_string(*n)),
        IpcValue::String(_) => unreachable!("a string is a path"),
        IpcValue::Bytes(kind, _) => match kind {
            shell_contract::BytesKind::ArrayBuffer => "an instance of ArrayBuffer".to_owned(),
            shell_contract::BytesKind::Uint8Array => "an instance of Uint8Array".to_owned(),
        },
        IpcValue::Date(_) => "an instance of Date".to_owned(),
        IpcValue::Array(_) => "an instance of Array".to_owned(),
        IpcValue::Object(_) => "an instance of Object".to_owned(),
    };
    kit::named_error(
        "TypeError [ERR_INVALID_ARG_TYPE]",
        format!("The \"path\" argument must be of type string. Received {received}"),
    )
}

// ---- the open dialog ----

/// `getUiLang()` as `tm` takes it
fn lang_of(shell: &dyn HwpShell) -> Lang {
    normalize_lang(Some(&shell.ui_lang()))
}

fn strings_of(value: Option<&JsonValue>) -> Vec<String> {
    match value {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsonValue::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn string_array(items: impl IntoIterator<Item = String>) -> JsonValue {
    JsonValue::Array(items.into_iter().map(JsonValue::String).collect())
}

fn pick_options(lang: Lang) -> JsObject<JsonValue> {
    let filter = |name: String, extensions: Vec<String>| {
        let mut f = JsObject::new();
        f.set("name", JsonValue::String(name));
        f.set("extensions", string_array(extensions));
        JsonValue::Object(f)
    };
    let mut options = JsObject::new();
    options.set(
        "title",
        JsonValue::String(tm_plain(lang, "dlgAddAttachment")),
    );
    options.set(
        "filters",
        JsonValue::Array(vec![
            filter(
                tm_plain(lang, "filterSupported"),
                attachable_exts().map(str::to_owned).collect(),
            ),
            filter(tm_plain(lang, "filterAll"), vec!["*".to_owned()]),
        ]),
    );
    options.set(
        "properties",
        string_array(["openFile".to_owned(), "multiSelections".to_owned()]),
    );
    options
}

/// `r.canceled || r.filePaths.length === 0 ? null : r.filePaths`
fn picked_paths(result: &JsonValue) -> Option<Vec<String>> {
    let JsonValue::Object(result) = result else {
        return None;
    };
    if result.get("canceled").is_some_and(JsonValue::truthy) {
        return None;
    }
    let paths = strings_of(result.get("filePaths"));
    (!paths.is_empty()).then_some(paths)
}

// ---- registration ----

#[cfg(test)]
pub(super) fn entries(services: &Services) -> Result<Vec<Entry>, RegisterError> {
    entries_with(services, Rc::default())
}

/// `entries` with the dialog memory the editor's other file dialogs share: the
/// TypeScript keeps one memory per `dialog` object, so the save dialogs and
/// this open dialog start in the directory of the last confirmed pick.
pub(super) fn entries_with(
    services: &Services,
    dialog_memory: Rc<RefCell<DialogMemory>>,
) -> Result<Vec<Entry>, RegisterError> {
    let engine = services.hosts.need::<HwpEngineHost>(Batch::D2)?;
    let dialogs = services.hosts.need::<DialogsHost>(Batch::D2)?;
    let contents = services.hosts.need::<ContentsHost>(Batch::D2)?;
    let shell = services.hosts.need::<HwpShellHost>(Batch::D2)?;
    let cache: Rc<RefCell<TextCache>> = Rc::default();
    let pasted_seq: Rc<Cell<u64>> = Rc::default();
    let mut entries = Vec::with_capacity(6);

    entries.push(kit::invoke("hwp:files-pick", {
        let engine = Arc::clone(&engine);
        let shell = Arc::clone(&shell);
        move |cx, _args| {
            let lang = lang_of(&*shell);
            // `BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getFocusedWindow()`
            let parent = contents
                .window_of(cx.sender.view)
                .or_else(|| shell.focused_window());
            let picked = show_open_dialog_with_memory(
                &mut dialog_memory.borrow_mut(),
                &mut FileDialogs(Arc::clone(&dialogs)),
                parent.as_ref(),
                &pick_options(lang),
                None,
            );
            Ok(match picked_paths(&picked) {
                Some(paths) => {
                    collect_attachments(&*engine, lang, paths.iter().map(String::as_str)).into_ipc()
                }
                None => IpcValue::Null,
            })
        }
    }));

    entries.push(kit::invoke("hwp:files-add", {
        let engine = Arc::clone(&engine);
        let shell = Arc::clone(&shell);
        move |_cx, args| {
            let paths: Vec<&str> = match args.get(0) {
                IpcValue::Array(items) => items.iter().filter_map(kit::as_str).collect(),
                _ => Vec::new(),
            };
            Ok(collect_attachments(&*engine, lang_of(&*shell), paths).into_ipc())
        }
    }));

    entries.push(kit::invoke("hwp:files-add-pasted-image", {
        let engine = Arc::clone(&engine);
        let shell = Arc::clone(&shell);
        let temp = Arc::clone(&services.paths);
        move |_cx, args| {
            let lang = lang_of(&*shell);
            let saved = save_pasted_image(
                &temp.path(PathName::Temp),
                &pasted_seq,
                shell.now_ms(),
                args.get(0),
                args.get(1),
            )?;
            Ok(match saved {
                Err(refused) => AttachmentAddResult {
                    accepted: Vec::new(),
                    rejected: vec![tm_plain(
                        lang,
                        match refused {
                            PasteRefused::TooLarge => "errImageTooLarge",
                            PasteRefused::Invalid => "errNotImage",
                        },
                    )],
                },
                Ok(path) => collect_attachments(&*engine, lang, [path.as_str()]),
            }
            .into_ipc())
        }
    }));

    entries.push(kit::invoke_later("hwp:files-read", {
        let engine = Arc::clone(&engine);
        let shell = Arc::clone(&shell);
        let services = services.clone();
        move |_cx, args, responder| {
            let Some(path) = args.str(0) else {
                return responder.reply(Err(not_a_string_path(args.get(0))));
            };
            let path = path.to_owned();
            let lang = lang_of(&*shell);
            let name = basename(&path, None);
            let ext = attachment_ext(&*engine, &path, &name);
            if !is_attachable(&ext) {
                return responder.reply(Ok(fail(tm_ext(lang, &ext))));
            }
            if is_image_ext(&ext) {
                return responder.reply(Ok(fail(tm_plain(lang, "errImageNoText"))));
            }
            let (offset, max_chars) = (to_number(args.get(1)), to_number(args.get(2)));
            match text_source(&*engine, lang, &cache, &path) {
                Err(error) => responder.reply(Ok(fail(error))),
                Ok(TextSource::Cached(text)) => {
                    responder.reply(Ok(read_reply(&name, &text, offset, max_chars)))
                }
                Ok(TextSource::Parse { stamp }) => {
                    let cache = Rc::clone(&cache);
                    let parser = Arc::clone(&engine);
                    let parse_path = path.clone();
                    kit::on_worker(
                        &services,
                        move || parser.parse_file_to_text(parse_path),
                        move |parsed| {
                            responder.reply(Ok(match parsed_text(parsed, lang) {
                                Err(error) => fail(error),
                                Ok(text) => {
                                    let text: Rc<str> = text.into();
                                    cache.borrow_mut().set(&path, stamp, Rc::clone(&text));
                                    read_reply(&name, &text, offset, max_chars)
                                }
                            }))
                        },
                    )
                }
            }
        }
    }));

    // Image attachments read raw bytes -> base64; the AI panel puts them into
    // the user message's images for a multimodal request
    entries.push(kit::invoke("hwp:files-read-image", {
        let shell = Arc::clone(&shell);
        move |_cx, args| {
            let Some(path) = args.str(0) else {
                return Err(not_a_string_path(args.get(0)));
            };
            let lang = lang_of(&*shell);
            let name = basename(path, None);
            let mime = match last_ext(&name).as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                _ => {
                    return Ok(fail(format!("{name}: {}", tm_plain(lang, "errNotImage"))));
                }
            };
            let read = fs::metadata(path).ok().and_then(|stat| {
                if stat.len() > ATTACHABLE_IMAGE_MAX_BYTES {
                    Some(Err("errImageTooLarge"))
                } else {
                    fs::read(path).ok().map(Ok)
                }
            });
            Ok(match read {
                Some(Ok(bytes)) => obj([
                    ("ok", true.into_ipc()),
                    ("base64", jscompat::base64(&bytes).into_ipc()),
                    ("mime", mime.into_ipc()),
                ]),
                Some(Err(key)) => fail(format!("{name}: {}", tm_plain(lang, key))),
                None => fail(format!("{name}: {}", tm_plain(lang, "errUnreadable"))),
            })
        }
    }));

    // An attached HWP / HWPX whole, for the editor's engine to read its
    // formatting: the same saved-file, size and content checks as its text
    entries.push(kit::invoke_later("hwp:files-read-document", {
        let engine = Arc::clone(&engine);
        let shell = Arc::clone(&shell);
        let services = services.clone();
        move |_cx, args, responder| {
            let Some(path) = args.str(0) else {
                return responder.reply(Err(not_a_string_path(args.get(0))));
            };
            let path = path.to_owned();
            let lang = lang_of(&*shell);
            let name = basename(&path, None);
            let ext = last_ext(&name);
            if ext != "hwp" && ext != "hwpx" {
                // read back by the model, not shown: read_attachment reads the text of other files
                return responder.reply(Ok(fail(format!(
                    "{name} is not an .hwp or .hwpx file: only those can be read for their formatting (read_attachment reads its text)"
                ))));
            }
            let checked = (|| {
                assert_saved(&*engine, &path)?;
                let stat = fs::metadata(&path).map_err(|e| node_error(&e, "stat", &path).message)?;
                if exceeds_max_bytes(stat.len(), &ext) {
                    return Err(tm_plain(lang, "errFileTooLarge"));
                }
                Ok(())
            })();
            if let Err(error) = checked {
                return responder.reply(Ok(fail(error)));
            }
            let checker = Arc::clone(&engine);
            kit::on_worker(
                &services,
                move || {
                    let bytes = read_file_sync(&path)?;
                    let bytes = checker.checked_hwp_bytes(bytes, ext)?;
                    Ok::<_, String>(jscompat::base64(&bytes))
                },
                move |result| {
                    responder.reply(Ok(match result {
                        Ok(base64) => obj([("ok", true.into_ipc()), ("base64", base64.into_ipc())]),
                        Err(error) => fail(error),
                    }))
                },
            )
        }
    }));

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;
    use shell_contract::runtime::Services;
    use shell_contract::{BytesKind, Provided, Surface, WindowId};

    use super::*;
    use crate::testing::{HostCall, Rt};

    fn reg(services: &Services, _provided: &Rc<Provided>) -> Result<Vec<Entry>, RegisterError> {
        super::entries(services)
    }

    fn rt(case: serde_json::Value) -> Rt {
        let mut rt = Rt::new(|h| crate::hwp::fakes(h, &case));
        rt.register(reg).unwrap();
        rt
    }

    fn s(text: &str) -> IpcValue {
        IpcValue::String(text.to_owned())
    }

    fn strs(items: &[&str]) -> IpcValue {
        IpcValue::Array(items.iter().map(|i| s(i)).collect())
    }

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// a file of `len` bytes without writing them
    fn sparse(dir: &Path, name: &str, len: u64) -> String {
        let path = dir.join(name);
        fs::File::create(&path).unwrap().set_len(len).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn add(rt: &mut Rt, paths: &[&str]) -> IpcValue {
        let from = rt.view(1, Surface::Hwp);
        rt.invoke_now("hwp:files-add", from, vec![strs(paths)])
            .unwrap()
    }

    fn rejected(result: &IpcValue) -> Vec<String> {
        match kit::field(result, "rejected") {
            IpcValue::Array(items) => items
                .iter()
                .map(|i| kit::as_str(i).unwrap().to_owned())
                .collect(),
            other => panic!("rejected is {other:?}"),
        }
    }

    fn accepted_names(result: &IpcValue) -> Vec<(String, String)> {
        match kit::field(result, "accepted") {
            IpcValue::Array(items) => items
                .iter()
                .map(|m| {
                    (
                        kit::as_str(kit::field(m, "name")).unwrap().to_owned(),
                        kit::as_str(kit::field(m, "ext")).unwrap().to_owned(),
                    )
                })
                .collect(),
            other => panic!("accepted is {other:?}"),
        }
    }

    #[test]
    fn add_splits_files_into_accepted_and_rejected_with_the_reasons() {
        let mut rt = rt(json!({}));
        let dir = rt.dir.clone();
        let ok = write(&dir, "Notes.TXT", b"hello");
        let exe = write(&dir, "tool.exe", b"MZ");
        fs::create_dir(dir.join("folder.txt")).unwrap();
        let folder = dir.join("folder.txt").to_string_lossy().into_owned();
        let missing = dir.join("gone.md").to_string_lossy().into_owned();
        let big_png = sparse(&dir, "big.png", 5 * 1024 * 1024 + 1);
        let big_txt = sparse(&dir, "big.txt", 50 * 1024 * 1024 + 1);
        // a zip-based document is read at any size
        let big_docx = sparse(&dir, "big.docx", 60 * 1024 * 1024);
        let from = rt.view(1, Surface::Hwp);

        let reply = rt
            .invoke_now(
                "hwp:files-add",
                from,
                vec![IpcValue::Array(vec![
                    s(&ok),
                    s(&exe),
                    IpcValue::Number(7.0),
                    s(&folder),
                    s(&missing),
                    s(&big_png),
                    s(&big_txt),
                    s(&big_docx),
                ])],
            )
            .unwrap();

        assert_eq!(
            accepted_names(&reply),
            vec![
                ("Notes.TXT".to_owned(), "txt".to_owned()),
                ("big.docx".to_owned(), "docx".to_owned())
            ]
        );
        assert_eq!(
            rejected(&reply),
            vec![
                "tool.exe: .exe files are not supported",
                "folder.txt: not a file",
                "gone.md: cannot be read",
                "big.png: image exceeds the 5MB limit",
                "big.txt: exceeds the 50MB limit",
            ]
        );
        let first = match kit::field(&reply, "accepted") {
            IpcValue::Array(items) => items[0].clone(),
            _ => unreachable!(),
        };
        assert_eq!(
            first,
            obj([
                ("path", s(&ok)),
                ("name", s("Notes.TXT")),
                ("ext", s("txt")),
                ("sizeBytes", IpcValue::Number(5.0)),
            ])
        );
    }

    #[test]
    fn add_takes_a_list_only() {
        let mut rt = rt(json!({}));
        let from = rt.view(1, Surface::Hwp);
        let reply = rt
            .invoke_now("hwp:files-add", from, vec![s("not-a-list")])
            .unwrap();
        assert_eq!(
            reply,
            obj([
                ("accepted", IpcValue::Array(vec![])),
                ("rejected", IpcValue::Array(vec![]))
            ])
        );
    }

    #[test]
    fn a_draw_io_picture_is_a_diagram_only_when_it_holds_the_diagram() {
        let mut rt = rt(json!({ "diagram_picture_has_no_original": [false, true] }));
        let dir = rt.dir.clone();
        let holds = write(&dir, "a.drawio.png", b"png");
        let plain = write(&dir, "b.drawio.png", b"png");
        let reply = add(&mut rt, &[&holds, &plain]);
        assert_eq!(
            accepted_names(&reply),
            vec![
                ("a.drawio.png".to_owned(), "drawio.png".to_owned()),
                ("b.drawio.png".to_owned(), "png".to_owned())
            ]
        );
    }

    #[test]
    fn errors_come_in_the_ui_language() {
        let mut rt = rt(json!({ "ui_lang": "ko" }));
        let exe = write(&rt.dir.clone(), "tool.exe", b"MZ");
        let reply = add(&mut rt, &[&exe]);
        let expected = format!("tool.exe: {}", tm_ext(Lang::Ko, "exe"));
        assert_eq!(rejected(&reply), vec![expected.clone()]);
        assert_ne!(expected, "tool.exe: .exe files are not supported");
    }

    #[test]
    fn size_caps_follow_the_extension() {
        assert!(exceeds_max_bytes(51 * 1024 * 1024, "txt"));
        assert!(!exceeds_max_bytes(50 * 1024 * 1024, ".TXT"));
        assert!(!exceeds_max_bytes(u64::MAX, "hwpx"));
        assert!(exceeds_max_bytes(51 * 1024 * 1024, "hwp"));
        assert!(exceeds_max_bytes(5 * 1024 * 1024 + 1, "jpg"));
        assert!(!exceeds_max_bytes(5 * 1024 * 1024, "jpg"));
    }

    #[test]
    fn pasted_images_are_saved_under_temp_and_counted() {
        let mut rt = rt(json!({}));
        let from = rt.view(1, Surface::Hwp);
        let png = IpcValue::Bytes(BytesKind::ArrayBuffer, vec![1, 2, 3]);

        let first = rt
            .invoke_now("hwp:files-add-pasted-image", from, vec![png, s("PNG")])
            .unwrap();
        let second = rt
            .invoke_now(
                "hwp:files-add-pasted-image",
                from,
                vec![
                    IpcValue::Bytes(BytesKind::Uint8Array, vec![9; 10]),
                    s("jpg"),
                ],
            )
            .unwrap();

        let path_of = |reply: &IpcValue| match kit::field(reply, "accepted") {
            IpcValue::Array(items) => kit::as_str(kit::field(&items[0], "path"))
                .unwrap()
                .to_owned(),
            other => panic!("accepted is {other:?}"),
        };
        let (p1, p2) = (path_of(&first), path_of(&second));
        let dir = rt.dir.join("temp").join("seuoffice-pasted");
        let name1 = Path::new(&p1)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let name2 = Path::new(&p2)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(Path::new(&p1).parent().unwrap(), dir);
        // pasted-YYYYMMDD-HHMMSS-<seq>.<ext>
        let shape = |name: &str, seq: &str, ext: &str| {
            let tail = format!("-{seq}.{ext}");
            let stamp = name
                .strip_prefix("pasted-")
                .and_then(|rest| rest.strip_suffix(tail.as_str()))
                .unwrap_or_else(|| panic!("{name}"));
            assert_eq!(stamp.len(), 15, "{name}");
            assert_eq!(stamp.as_bytes()[8], b'-', "{name}");
            assert!(
                stamp
                    .bytes()
                    .enumerate()
                    .all(|(i, b)| i == 8 || b.is_ascii_digit())
            );
        };
        shape(&name1, "1", "png");
        shape(&name2, "2", "jpg");
        assert_eq!(fs::read(&p1).unwrap(), vec![1, 2, 3]);
        assert_eq!(fs::read(&p2).unwrap(), vec![9; 10]);
        assert_eq!(accepted_names(&first), vec![(name1, "png".to_owned())]);
        assert_eq!(rejected(&first), Vec::<String>::new());
    }

    #[test]
    fn pasted_images_that_cannot_be_kept_say_why() {
        let mut rt = rt(json!({}));
        let from = rt.view(1, Surface::Hwp);
        let mut paste = |data: IpcValue, ext: IpcValue| {
            let reply = rt
                .invoke_now("hwp:files-add-pasted-image", from, vec![data, ext])
                .unwrap();
            assert_eq!(accepted_names(&reply), vec![]);
            rejected(&reply)
        };
        let bytes = |n: usize| IpcValue::Bytes(BytesKind::ArrayBuffer, vec![0; n]);
        assert_eq!(
            paste(bytes(4), s("bmp")),
            vec!["not a supported image type"]
        );
        assert_eq!(
            paste(bytes(4), IpcValue::Undefined),
            vec!["not a supported image type"]
        );
        assert_eq!(
            paste(bytes(0), s("png")),
            vec!["not a supported image type"]
        );
        assert_eq!(
            paste(s("bytes"), s("png")),
            vec!["not a supported image type"]
        );
        assert_eq!(
            paste(bytes(5 * 1024 * 1024 + 1), s("png")),
            vec!["image exceeds the 5MB limit"]
        );
        // a refused paste leaves no file and does not advance the counter
        assert!(!rt.dir.join("temp").join("seuoffice-pasted").exists());
    }

    #[test]
    fn pick_answers_the_chosen_files_or_null() {
        let mut rt = rt(json!({}));
        let from = rt.view(3, Surface::Hwp);
        let dir = rt.dir.clone();
        let a = write(&dir, "a.txt", b"a");
        let b = write(&dir, "b.exe", b"b");
        {
            let mut script = rt.script();
            script
                .open
                .push_back(Some(vec![a.clone().into(), b.clone().into()]));
            script.open.push_back(None);
            script.open.push_back(Some(vec![]));
        }

        let picked = rt.invoke_now("hwp:files-pick", from, vec![]).unwrap();
        assert_eq!(
            accepted_names(&picked),
            vec![("a.txt".to_owned(), "txt".to_owned())]
        );
        assert_eq!(
            rejected(&picked),
            vec!["b.exe: .exe files are not supported"]
        );
        assert_eq!(
            rt.invoke_now("hwp:files-pick", from, vec![]).unwrap(),
            IpcValue::Null
        );
        assert_eq!(
            rt.invoke_now("hwp:files-pick", from, vec![]).unwrap(),
            IpcValue::Null
        );

        let calls = rt.script().calls.clone();
        let HostCall::Open(parent, first) = &calls[0] else {
            panic!("{calls:?}")
        };
        assert_eq!(*parent, Some(WindowId(3)));
        assert_eq!(first.title.as_deref(), Some("Add Attachments"));
        assert_eq!(first.properties, vec!["openFile", "multiSelections"]);
        assert_eq!(first.filters[0].name, "Supported Files");
        assert_eq!(first.filters[0].extensions[0], "txt");
        assert!(
            first.filters[0]
                .extensions
                .iter()
                .any(|e| e == "drawio.png")
        );
        assert_eq!(first.filters[1].name, "All Files");
        assert_eq!(first.filters[1].extensions, vec!["*"]);
        // the next dialog opens where the last pick was
        let HostCall::Open(_, second) = &calls[1] else {
            panic!("{calls:?}")
        };
        assert_eq!(second.default_path.as_deref(), Some(dir.as_path()));
    }

    fn read(rt: &mut Rt, path: &str, offset: IpcValue, max: IpcValue) -> IpcValue {
        let from = rt.view(1, Surface::Hwp);
        rt.invoke_now("hwp:files-read", from, vec![s(path), offset, max])
            .unwrap()
    }

    fn num(n: f64) -> IpcValue {
        IpcValue::Number(n)
    }

    fn read_ok(name: &str, total: f64, offset: f64, text: &str) -> IpcValue {
        obj([
            ("ok", IpcValue::Bool(true)),
            ("name", s(name)),
            ("totalChars", num(total)),
            ("offset", num(offset)),
            ("text", s(text)),
        ])
    }

    fn read_err(error: &str) -> IpcValue {
        obj([("ok", IpcValue::Bool(false)), ("error", s(error))])
    }

    #[test]
    fn read_slices_the_text_in_utf16_units_and_clamps_the_window() {
        let mut rt = rt(json!({}));
        let path = write(
            &rt.dir.clone(),
            "doc.txt",
            "\u{AC00}\u{B098}\u{B2E4}\u{B77C}\u{B9C8}".as_bytes(),
        );
        assert_eq!(
            read(&mut rt, &path, num(1.0), num(2.0)),
            read_ok("doc.txt", 5.0, 1.0, "\u{B098}\u{B2E4}")
        );
        // negative offsets start at 0, a size of 0 or less reads one character
        assert_eq!(
            read(&mut rt, &path, num(-3.0), num(0.0)),
            read_ok("doc.txt", 5.0, 0.0, "\u{AC00}")
        );
        assert_eq!(
            read(&mut rt, &path, IpcValue::Undefined, num(2.9)),
            read_ok("doc.txt", 5.0, 0.0, "\u{AC00}\u{B098}")
        );
        // past the end is empty; an astral character counts as two units
        assert_eq!(
            read(&mut rt, &path, num(9.0), num(5.0)),
            read_ok("doc.txt", 5.0, 9.0, "")
        );
        let emoji = write(&rt.dir.clone(), "e.txt", "a\u{1F600}b".as_bytes());
        assert_eq!(
            read(&mut rt, &emoji, num(0.0), num(10.0)),
            read_ok("e.txt", 4.0, 0.0, "a\u{1F600}b")
        );
    }

    #[test]
    fn read_returns_at_most_48000_characters() {
        let mut rt = rt(json!({}));
        let path = write(&rt.dir.clone(), "long.txt", "x".repeat(50_000).as_bytes());
        let reply = read(&mut rt, &path, num(0.0), num(1_000_000.0));
        assert_eq!(kit::field(&reply, "totalChars"), &num(50_000.0));
        assert_eq!(
            kit::as_str(kit::field(&reply, "text")).unwrap().len(),
            48_000
        );
    }

    #[test]
    fn read_refuses_what_has_no_text() {
        let mut rt = rt(json!({}));
        let dir = rt.dir.clone();
        assert_eq!(
            read(&mut rt, "/x/tool.exe", num(0.0), num(5.0)),
            read_err(".exe files are not supported")
        );
        assert_eq!(
            read(&mut rt, "/x/pic.PNG", num(0.0), num(5.0)),
            read_err(
                "Image attachments have no text; the image is sent along with the user message"
            )
        );
        let big = sparse(&dir, "big.txt", 50 * 1024 * 1024 + 1);
        assert_eq!(
            read(&mut rt, &big, num(0.0), num(5.0)),
            read_err("File exceeds the size limit")
        );
        let missing = dir.join("none.txt").to_string_lossy().into_owned();
        assert_eq!(
            read(&mut rt, &missing, num(0.0), num(5.0)),
            read_err(&format!(
                "ENOENT: no such file or directory, stat '{missing}'"
            ))
        );
    }

    #[test]
    fn read_with_a_path_that_is_not_a_string_throws() {
        let mut rt = rt(json!({}));
        let from = rt.view(1, Surface::Hwp);
        for channel in [
            "hwp:files-read",
            "hwp:files-read-image",
            "hwp:files-read-document",
        ] {
            let err = rt
                .invoke_now(channel, from, vec![IpcValue::Number(5.0)])
                .unwrap_err();
            assert_eq!(
                err.name.as_deref(),
                Some("TypeError [ERR_INVALID_ARG_TYPE]"),
                "{channel}"
            );
            assert_eq!(
                err.message,
                "The \"path\" argument must be of type string. Received type number (5)"
            );
        }
        let err = rt.invoke_now("hwp:files-read", from, vec![]).unwrap_err();
        assert_eq!(
            err.message,
            "The \"path\" argument must be of type string. Received undefined"
        );
    }

    #[test]
    fn read_parses_once_until_the_file_changes() {
        let mut rt = rt(json!({ "parse_file_to_text": [
            { "ok": true, "kind": "text", "text": "first" },
            { "ok": true, "kind": "text", "text": "second" },
        ]}));
        let dir = rt.dir.clone();
        let path = write(&dir, "a.docx", b"v1");
        assert_eq!(
            read(&mut rt, &path, num(0.0), num(99.0)),
            read_ok("a.docx", 5.0, 0.0, "first")
        );
        // the same file is not parsed again
        assert_eq!(
            read(&mut rt, &path, num(1.0), num(99.0)),
            read_ok("a.docx", 5.0, 1.0, "irst")
        );
        // a changed size parses again
        write(&dir, "a.docx", b"version two");
        assert_eq!(
            read(&mut rt, &path, num(0.0), num(99.0)),
            read_ok("a.docx", 6.0, 0.0, "second")
        );
    }

    #[test]
    fn the_text_cache_keeps_eight_files_and_drops_the_oldest() {
        let answers: Vec<_> = (0..9)
            .map(|i| json!({ "ok": true, "kind": "text", "text": format!("t{i}") }))
            .chain([json!({ "ok": true, "kind": "text", "text": "again" })])
            .collect();
        let mut rt = rt(json!({ "parse_file_to_text": answers }));
        let dir = rt.dir.clone();
        let paths: Vec<String> = (0..9)
            .map(|i| write(&dir, &format!("f{i}.txt"), b"x"))
            .collect();
        for (i, path) in paths.iter().enumerate() {
            let name = format!("f{i}.txt");
            assert_eq!(
                read(&mut rt, path, num(0.0), num(9.0)),
                read_ok(&name, 2.0, 0.0, &format!("t{i}"))
            );
        }
        // the newest is still cached, the first was dropped
        assert_eq!(
            read(&mut rt, &paths[8], num(0.0), num(9.0)),
            read_ok("f8.txt", 2.0, 0.0, "t8")
        );
        assert_eq!(
            read(&mut rt, &paths[0], num(0.0), num(9.0)),
            read_ok("f0.txt", 5.0, 0.0, "again")
        );
    }

    #[test]
    fn read_reports_why_a_parse_failed() {
        let mut rt = rt(json!({ "parse_file_to_text": [
            { "ok": false, "kind": "text", "error": "Content mismatch: .pdf file has zip magic bytes" },
            { "ok": false, "kind": "text", "error": "technical detail", "damaged": true },
            { "ok": true, "kind": "image" },
            { "ok": false, "kind": "text", "error": "" },
        ]}));
        let dir = rt.dir.clone();
        let path = write(&dir, "a.pdf", b"x");
        assert_eq!(
            read(&mut rt, &path, num(0.0), num(9.0)),
            read_err("Content mismatch: .pdf file has zip magic bytes")
        );
        // a damaged container is not shown as the parser worded it
        for _ in 0..3 {
            assert_eq!(
                read(&mut rt, &path, num(0.0), num(9.0)),
                read_err("Failed to parse file")
            );
        }
    }

    #[test]
    fn read_and_read_document_refuse_a_file_open_with_unsaved_changes() {
        let dir = std::env::temp_dir().join(format!("hwp-unsaved-{}", kit::unique()));
        fs::create_dir_all(&dir).unwrap();
        let doc = write(&dir, "open.hwp", &[0xD0, 0xCF, 0x11, 0xE0]);
        let dirty_text = write(&dir, "dirty.txt", b"unsaved");
        let clean_text = write(&dir, "clean.txt", b"saved");
        let mut rt = rt(json!({ "open_files": { "files": [
            { "filePath": doc, "dirty": true },
            { "filePath": dirty_text, "dirty": true },
            { "filePath": clean_text, "dirty": false },
        ]}}));
        let from = rt.view(1, Surface::Hwp);
        let message = "This file is open with unsaved changes. Save it, then try again.";
        assert_eq!(
            rt.invoke_now("hwp:files-read-document", from, vec![s(&doc)])
                .unwrap(),
            read_err(message)
        );
        assert_eq!(
            read(&mut rt, &dirty_text, num(0.0), num(9.0)),
            read_err(message)
        );
        assert_eq!(
            read(&mut rt, &clean_text, num(0.0), num(9.0)),
            read_ok("clean.txt", 5.0, 0.0, "saved")
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failing_open_files_source_blocks_every_read() {
        let mut rt = rt(json!({ "open_files": { "failed": true } }));
        let path = write(&rt.dir.clone(), "t.txt", b"hi");
        assert_eq!(
            read(&mut rt, &path, num(0.0), num(9.0)),
            read_err("This file is open with unsaved changes. Save it, then try again.")
        );
    }

    #[test]
    fn read_image_answers_base64_and_mime() {
        let mut rt = rt(json!({}));
        let dir = rt.dir.clone();
        let from = rt.view(1, Surface::Hwp);
        let png = write(&dir, "a.png", &[1, 2, 3]);
        let jpg = write(&dir, "b.JPG", &[1, 2, 3]);
        let bmp = write(&dir, "c.bmp", &[1]);
        let big = sparse(&dir, "d.webp", 5 * 1024 * 1024 + 1);
        let missing = dir.join("e.gif").to_string_lossy().into_owned();
        let mut call = |path: &str| {
            rt.invoke_now("hwp:files-read-image", from, vec![s(path)])
                .unwrap()
        };
        assert_eq!(
            call(&png),
            obj([
                ("ok", IpcValue::Bool(true)),
                ("base64", s("AQID")),
                ("mime", s("image/png"))
            ])
        );
        assert_eq!(
            call(&jpg),
            obj([
                ("ok", IpcValue::Bool(true)),
                ("base64", s("AQID")),
                ("mime", s("image/jpeg"))
            ])
        );
        assert_eq!(call(&bmp), read_err("c.bmp: not a supported image type"));
        assert_eq!(call(&big), read_err("d.webp: image exceeds the 5MB limit"));
        assert_eq!(call(&missing), read_err("e.gif: cannot be read"));
    }

    #[test]
    fn read_document_answers_the_checked_bytes_of_hangul_files_only() {
        let mut rt = rt(
            json!({ "checked_hwp_bytes": [json!(null), json!("Content mismatch: the .hwpx file is not a Hangul document")] }),
        );
        let dir = rt.dir.clone();
        let from = rt.view(1, Surface::Hwp);
        let hwp = write(&dir, "a.hwp", &[1, 2, 3]);
        let hwpx = write(&dir, "b.hwpx", &[1, 2, 3]);
        let txt = write(&dir, "c.txt", &[1]);
        let big = sparse(&dir, "d.hwp", 50 * 1024 * 1024 + 1);
        let mut call = |path: &str| {
            rt.invoke_now("hwp:files-read-document", from, vec![s(path)])
                .unwrap()
        };
        assert_eq!(
            call(&hwp),
            obj([("ok", IpcValue::Bool(true)), ("base64", s("AQID"))])
        );
        assert_eq!(
            call(&hwpx),
            read_err("Content mismatch: the .hwpx file is not a Hangul document")
        );
        assert_eq!(
            call(&txt),
            read_err(
                "c.txt is not an .hwp or .hwpx file: only those can be read for their formatting (read_attachment reads its text)"
            )
        );
        assert_eq!(call(&big), read_err("File exceeds the size limit"));
        let missing = dir.join("m.hwp").to_string_lossy().into_owned();
        assert_eq!(
            call(&missing),
            read_err(&format!(
                "ENOENT: no such file or directory, stat '{missing}'"
            ))
        );
    }
}
