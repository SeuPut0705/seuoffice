//! The editors' file and window channels: `files:*` and `win:*`
//! (`apps/docs/src/main/docs-main.ts` `registerDocsIpc`) and `shell:*`
//! (`apps/sheets/src/main/sheets-main.ts` `registerSheetsIpc`). The `doc:attach-*`
//! channels belong to `doc_picker`: they share the picker window's state.
//!
//! Facts the shell owns come through hosts of this module: the docs tabs
//! (`setDocsShellHooks`), the open documents' dirty state (`setOpenFilesSource`),
//! `@seuoffice/file-parse`, the UI language, the clock, and the sheets tabs.

use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use jscompat::node_path::host::{basename, extname, is_absolute, join};
use jscompat::{JsObject, JsonValue, base64, to_iso_string};
use main_core::node_fs::node_error as fs_error;
use main_core::packages::electron_utils::dialog_memory::{Dialog, show_open_dialog_with_memory};

use crate::shared_dialog::{open_confirmed, with_shared_memory};
use main_core::packages::electron_utils::safe_external_url::safe_external_url;
use main_core::packages::electron_utils::unsaved_files::{
    OpenFileState, OpenFilesHolder, OpenFilesSourceFailed, assert_file_saved,
};
use main_core::packages::i18n::{I18n, Lang, create_i18n};
use shell_contract::error::IpcError;
use shell_contract::hosts::{FileDialog, FileFilter};
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::ipc::{CallContext, ChannelKind, Handler, RegisterError, Registry, Responder};
use shell_contract::runtime::{PathName, Services, Workers};
use shell_contract::{Batch, ContentsHost, DialogsHost, IpcValue, MainWindowHost, OsShellHost};

use crate::convert::field;
use crate::handle;

// ---- hosts ----

/// One entry of `win:list` (`DocsTabInfo`)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocsTab {
    pub id: String,
    pub title: String,
    pub focused: bool,
}

/// `setDocsShellHooks`: the shell's tab strip as the docs editor reaches it.
/// Called on the core thread.
pub trait DocsTabs: Send + Sync {
    /// `openTab(path, options)`: `new_blank` is `{ newBlank: true }`
    fn open_tab(&self, path: Option<&str>, new_blank: bool);
    /// the tabs that show a docs document, in tab order
    fn list_tabs(&self) -> Vec<DocsTab>;
    fn focus_tab(&self, id: &str);
}

pub type DocsTabsHost = Arc<dyn DocsTabs>;

/// `setOpenFilesSource`: every open document and whether it has unsaved
/// changes. Called from a worker; it may wait for the core thread.
pub trait OpenFiles: Send + Sync {
    fn open_files(&self) -> Result<Vec<OpenFileState>, OpenFilesSourceFailed>;
}

pub type OpenFilesHost = Arc<dyn OpenFiles>;

/// `ParsedFile` of `@seuoffice/file-parse`
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedFile {
    pub ok: bool,
    pub kind: ParsedKind,
    pub text: Option<String>,
    pub error: Option<String>,
    /// the file's container is damaged: the caller shows its own message
    pub damaged: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParsedKind {
    Text,
    Image,
    Unsupported,
}

/// `@seuoffice/file-parse`: not in `main-core` yet. Called from a worker.
pub trait FileParse: Send + Sync {
    /// `parseFileToText(path)`; `Err` is what it threw
    fn parse_file_to_text(&self, path: &Path) -> Result<ParsedFile, String>;
    /// `diagramPictureExtOf(path)`: `drawio.svg` or `drawio.png` when the file
    /// is named so and holds its diagram (reads the file)
    fn diagram_picture_ext(&self, path: &Path) -> Option<&'static str>;
}

pub type FileParseHost = Arc<dyn FileParse>;

/// `getUiLang()`
pub trait UiLanguage: Send + Sync {
    fn lang(&self) -> Lang;
}

pub type UiLanguageHost = Arc<dyn UiLanguage>;

/// `Date.now()`
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> f64;
}

pub type ClockHost = Arc<dyn Clock>;

/// What the sheets editor knows of its tabs (`sheetsTabs` of sheets-main)
pub trait SheetsTabs: Send + Sync {
    /// `sheetsTabs.has(wc.id)`
    fn is_tab(&self, view: ViewId) -> bool;
    /// The source file of external link `index` in workbook session
    /// `session_id` of the tab (`listExternalLinks` through the sidecar); none
    /// when the tab has no such session or the listing fails. Called from a
    /// worker.
    fn external_link_source(&self, view: ViewId, session_id: &str, index: u64) -> Option<String>;
}

pub type SheetsTabsHost = Arc<dyn SheetsTabs>;

// ---- strings (`createI18n` of docs-main and sheets-main) ----

fn strings() -> I18n {
    let table = |pairs: &[(&str, &str)]| -> JsObject<String> {
        let mut object = JsObject::new();
        for (key, text) in pairs {
            object.set(*key, (*text).to_owned());
        }
        object
    };
    create_i18n(
        table(&[
            ("dlgAddAttachment", "Add Attachments"),
            ("filterSupported", "Supported Files"),
            ("filterAll", "All Files"),
            ("errUnsupportedExt", ".{ext} files are not supported"),
            ("errNotFile", "not a file"),
            ("errTooLarge", "exceeds the {mb}MB limit"),
            ("errImageTooLarge", "image exceeds the 5MB limit"),
            ("errUnreadable", "cannot be read"),
            ("errFileTooLarge", "File exceeds the size limit"),
            ("errParseFailed", "Failed to parse file"),
            (
                "errImageNoText",
                "Image attachments have no text; the image is sent along with the user message",
            ),
            ("errNotImage", "not a supported image type"),
            ("errImgAbsPath", "Image path must be absolute."),
            ("errImgNotFound", "Image file not found: {path}"),
            (
                "errImgTooLarge20",
                "Image exceeds 20MB and cannot be inserted.",
            ),
            ("errImgBadType", "The file is not a PNG/JPEG/GIF image."),
        ]),
        table(&[
            ("dlgAddAttachment", "첨부 파일 추가"),
            ("filterSupported", "지원되는 파일"),
            ("filterAll", "모든 파일"),
            ("errUnsupportedExt", ".{ext} 형식은 지원되지 않습니다"),
            ("errNotFile", "파일이 아닙니다"),
            ("errTooLarge", "{mb}MB 제한을 초과했습니다"),
            ("errImageTooLarge", "이미지가 5MB 제한을 초과했습니다"),
            ("errUnreadable", "읽을 수 없습니다"),
            ("errFileTooLarge", "파일이 크기 제한을 초과했습니다"),
            ("errParseFailed", "파일을 분석하지 못했습니다"),
            (
                "errImageNoText",
                "이미지 첨부 파일은 텍스트를 제공하지 않으며, 이미지 형태로 사용자 메시지와 함께 전송되므로 이미지를 직접 확인하면 됩니다",
            ),
            ("errNotImage", "지원되지 않는 이미지 형식입니다"),
            ("errImgAbsPath", "이미지 경로는 절대 경로여야 합니다."),
            ("errImgNotFound", "이미지 파일을 찾을 수 없습니다: {path}"),
            (
                "errImgTooLarge20",
                "이미지가 20MB를 초과하여 삽입할 수 없습니다.",
            ),
            ("errImgBadType", "이 파일은 PNG/JPEG/GIF 이미지가 아닙니다."),
        ]),
    )
}

/// `tm(key, params)` with the UI language of the moment
#[derive(Clone)]
struct Tm {
    strings: Arc<I18n>,
    lang: UiLanguageHost,
}

impl Tm {
    fn say(&self, key: &str) -> String {
        self.strings.t(self.lang.lang(), key, None)
    }

    fn say_with(&self, key: &str, name: &str, value: JsonValue) -> String {
        let mut params = JsObject::new();
        params.set(name, value);
        self.strings.t(self.lang.lang(), key, Some(&params))
    }
}

// ---- values ----

fn text(value: impl Into<String>) -> IpcValue {
    IpcValue::String(value.into())
}

fn object(entries: Vec<(&str, IpcValue)>) -> IpcValue {
    IpcValue::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    )
}

fn error(message: impl Into<String>) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: message.into(),
    }
}

/// `The "path" argument must be of type string. Received ...` of a Node
/// `path` function handed something else
fn invalid_path(value: Option<&IpcValue>) -> IpcError {
    let received = match value {
        None | Some(IpcValue::Undefined) => "undefined".to_owned(),
        Some(IpcValue::Null) => "null".to_owned(),
        Some(IpcValue::Bool(b)) => format!("type boolean ({b})"),
        Some(IpcValue::Number(n)) => format!("type number ({})", jscompat::number_to_string(*n)),
        Some(IpcValue::Array(_)) => "an instance of Array".to_owned(),
        Some(IpcValue::Date(_)) => "an instance of Date".to_owned(),
        Some(IpcValue::Bytes(..)) => "an instance of Uint8Array".to_owned(),
        Some(IpcValue::Object(_)) => "an instance of Object".to_owned(),
        Some(IpcValue::String(_)) => unreachable!("a string is a path"),
    };
    IpcError {
        name: Some("TypeError [ERR_INVALID_ARG_TYPE]".into()),
        message: format!("The \"path\" argument must be of type string. Received {received}"),
    }
}

fn path_arg(value: Option<&IpcValue>) -> Result<&str, IpcError> {
    match value {
        Some(IpcValue::String(path)) => Ok(path),
        other => Err(invalid_path(other)),
    }
}

/// `Number(value)` of what a renderer sends for a count
fn js_number(value: Option<&IpcValue>) -> f64 {
    match value {
        Some(IpcValue::Number(n)) => *n,
        Some(IpcValue::Null) => 0.0,
        Some(IpcValue::Bool(b)) => f64::from(u8::from(*b)),
        Some(IpcValue::String(s)) => match s.trim() {
            "" => 0.0,
            t => t.parse().unwrap_or(f64::NAN),
        },
        _ => f64::NAN,
    }
}

/// `Math.floor(value) || fallback`
fn floor_or(value: f64, fallback: f64) -> f64 {
    let floored = value.floor();
    if floored.is_nan() || floored == 0.0 {
        fallback
    } else {
        floored
    }
}

// ---- the attachable formats (`@seuoffice/file-parse` attachable.ts) ----

const TEXT_EXTS: [&str; 27] = [
    "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log",
    "js", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp", "go", "rs", "rb", "sh", "sql", "css",
];
const OFFICE_EXTS: [&str; 13] = [
    "doc", "docx", "odt", "pdf", "pptx", "ppt", "xlsx", "xlsm", "xls", "xmind", "hwp", "hwpx",
    "epub",
];
const DIAGRAM_EXTS: [&str; 4] = ["drawio", "dio", "drawio.svg", "drawio.png"];
const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
/// formats read at any size
const SIZE_FREE_EXTS: [&str; 9] = [
    "docx", "pptx", "xlsx", "xlsm", "hwpx", "odt", "epub", "xmind", "pdf",
];
const ATTACHABLE_MAX_BYTES: f64 = 50.0 * 1024.0 * 1024.0;
const ATTACHABLE_IMAGE_MAX_BYTES: f64 = 5.0 * 1024.0 * 1024.0;

fn attachable_exts() -> impl Iterator<Item = &'static str> {
    TEXT_EXTS
        .into_iter()
        .chain(OFFICE_EXTS)
        .chain(DIAGRAM_EXTS)
        .chain(IMAGE_EXTS)
}

fn is_attachable(ext: &str) -> bool {
    attachable_exts().any(|e| e == ext)
}

fn is_image(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}

/// `attachableMaxBytes(ext)`
fn attachable_max_bytes(ext: &str) -> f64 {
    let clean = ext.strip_prefix('.').unwrap_or(ext).to_lowercase();
    if is_image(&clean) {
        ATTACHABLE_IMAGE_MAX_BYTES
    } else if SIZE_FREE_EXTS.contains(&clean.as_str()) {
        f64::INFINITY
    } else {
        ATTACHABLE_MAX_BYTES
    }
}

/// `diagramPictureExtOfName(fileName)`
fn diagram_picture_ext_of_name(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    if lower.ends_with(".drawio.svg") {
        Some("drawio.svg")
    } else if lower.ends_with(".drawio.png") {
        Some("drawio.png")
    } else {
        None
    }
}

/// `name.split('.').pop()?.toLowerCase()`
fn last_segment_lower(name: &str) -> String {
    name.rsplit('.').next().unwrap_or("").to_lowercase()
}

fn attachment_image_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

// ---- chat attachments ----

/// A path, the file's (mtime, size) stamp and its extracted text
type CachedText = (String, ((u128, u64), String));

/// What the attachment handlers need; cheap to clone into a worker
#[derive(Clone)]
struct Attachments {
    tm: Tm,
    parse: FileParseHost,
    open_files: OpenFilesHost,
    /// extracted text by path, invalidated by mtime and size; at most 8
    cache: Arc<Mutex<Vec<CachedText>>>,
}

impl Attachments {
    /// `statAttachment`: the file's meta, or why it is refused
    fn stat(&self, path: &str) -> Result<IpcValue, String> {
        let name = basename(path, None);
        // a draw.io picture that holds its diagram is read as diagram text
        let ext = self
            .parse
            .diagram_picture_ext(Path::new(path))
            .map_or_else(|| last_segment_lower(&name), str::to_owned);
        if !is_attachable(&ext) {
            let reason = self
                .tm
                .say_with("errUnsupportedExt", "ext", JsonValue::String(ext));
            return Err(format!("{name}: {reason}"));
        }
        let Ok(meta) = fs::metadata(path) else {
            return Err(format!("{name}: {}", self.tm.say("errUnreadable")));
        };
        if !meta.is_file() {
            return Err(format!("{name}: {}", self.tm.say("errNotFile")));
        }
        let size = meta.len() as f64;
        if !is_image(&ext) && size > attachable_max_bytes(&ext) {
            let mb = (ATTACHABLE_MAX_BYTES / 1024.0 / 1024.0).round();
            let reason = self.tm.say_with("errTooLarge", "mb", JsonValue::Number(mb));
            return Err(format!("{name}: {reason}"));
        }
        if is_image(&ext) && size > ATTACHABLE_IMAGE_MAX_BYTES {
            return Err(format!("{name}: {}", self.tm.say("errImageTooLarge")));
        }
        Ok(object(vec![
            ("path", text(path)),
            ("name", text(name)),
            ("ext", text(ext)),
            ("sizeBytes", IpcValue::Number(size)),
        ]))
    }

    /// `collectAttachments(paths)`
    fn collect(&self, paths: &[&str]) -> IpcValue {
        let mut accepted = Vec::new();
        let mut rejected = Vec::new();
        for path in paths {
            match self.stat(path) {
                Ok(meta) => accepted.push(meta),
                Err(reason) => rejected.push(text(reason)),
            }
        }
        object(vec![
            ("accepted", IpcValue::Array(accepted)),
            ("rejected", IpcValue::Array(rejected)),
        ])
    }

    /// `extractAttachmentText(path)`; `Err` is the message of what it threw
    fn extract_text(&self, path: &str) -> Result<String, String> {
        // a file open with unsaved changes is not read (before the cache)
        let mut holder = OpenFilesHolder::new();
        let source = self.open_files.clone();
        holder.set_open_files_source(Some(Box::new(move || source.open_files())));
        assert_file_saved(&holder, path).map_err(str::to_owned)?;
        let meta = fs::metadata(path).map_err(|e| fs_error(&e, "stat", path).message)?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos());
        let stamp = (modified, meta.len());
        {
            let cache = self.cache.lock().unwrap();
            if let Some((_, (cached, body))) = cache.iter().find(|(key, _)| key == path)
                && *cached == stamp
            {
                return Ok(body.clone());
            }
        }
        let cap_ext =
            diagram_picture_ext_of_name(path).map_or_else(|| extname(path), |ext| ext.to_owned());
        if meta.len() as f64 > attachable_max_bytes(&cap_ext) {
            return Err(self.tm.say("errFileTooLarge"));
        }
        let parsed = self.parse.parse_file_to_text(Path::new(path))?;
        let body = match (&parsed.text, parsed.ok, parsed.kind) {
            (Some(body), true, ParsedKind::Text) => body.clone(),
            _ => {
                let reason = match &parsed.error {
                    Some(error) if !parsed.damaged && !error.is_empty() => error.clone(),
                    _ => self.tm.say("errParseFailed"),
                };
                return Err(reason);
            }
        };
        let mut cache = self.cache.lock().unwrap();
        match cache.iter_mut().find(|(key, _)| key == path) {
            Some(entry) => entry.1 = (stamp, body.clone()),
            None => cache.push((path.to_owned(), (stamp, body.clone()))),
        }
        // a handful of recent files is plenty
        if cache.len() > 8 {
            cache.remove(0);
        }
        Ok(body)
    }

    /// `files:read`
    fn read(&self, args: &[IpcValue]) -> Result<IpcValue, IpcError> {
        let path = path_arg(args.first())?;
        let name = basename(path, None);
        let ext = self
            .parse
            .diagram_picture_ext(Path::new(path))
            .map_or_else(|| last_segment_lower(&name), str::to_owned);
        let refused = |reason: String| {
            Ok(object(vec![
                ("ok", IpcValue::Bool(false)),
                ("error", text(reason)),
            ]))
        };
        if !is_attachable(&ext) {
            return refused(
                self.tm
                    .say_with("errUnsupportedExt", "ext", JsonValue::String(ext)),
            );
        }
        if is_image(&ext) {
            return refused(self.tm.say("errImageNoText"));
        }
        let body = match self.extract_text(path) {
            Ok(body) => body,
            Err(message) => return refused(message),
        };
        let start = floor_or(js_number(args.get(1)), 0.0).max(0.0);
        let size = floor_or(js_number(args.get(2)), 1.0).clamp(1.0, 48_000.0);
        // `text.slice(start, start + size)` counts UTF-16 units
        let units: Vec<u16> = body.encode_utf16().collect();
        let total = units.len();
        let from = start.min(total as f64) as usize;
        let to = (start + size).min(total as f64) as usize;
        Ok(object(vec![
            ("ok", IpcValue::Bool(true)),
            ("name", text(name)),
            ("totalChars", IpcValue::Number(total as f64)),
            ("offset", IpcValue::Number(start)),
            ("text", text(String::from_utf16_lossy(&units[from..to]))),
        ]))
    }

    /// `files:read-image`
    fn read_image(&self, args: &[IpcValue]) -> Result<IpcValue, IpcError> {
        let path = path_arg(args.first())?;
        let name = basename(path, None);
        let ext = last_segment_lower(&name);
        let fail = |key: &str| {
            Ok(object(vec![
                ("ok", IpcValue::Bool(false)),
                ("error", text(format!("{name}: {}", self.tm.say(key)))),
            ]))
        };
        let Some(mime) = attachment_image_mime(&ext) else {
            return fail("errNotImage");
        };
        let size = fs::metadata(path).map(|m| m.len() as f64);
        let bytes = match size {
            Ok(size) if size > ATTACHABLE_IMAGE_MAX_BYTES => return fail("errImageTooLarge"),
            Ok(_) => fs::read(path),
            Err(e) => Err(e),
        };
        match bytes {
            Ok(bytes) => Ok(object(vec![
                ("ok", IpcValue::Bool(true)),
                ("base64", text(base64(&bytes))),
                ("mime", text(mime)),
            ])),
            Err(_) => fail("errUnreadable"),
        }
    }
}

/// The temp files of pasted pictures
struct PastedImages {
    dir: PathBuf,
    clock: ClockHost,
    seq: Cell<u64>,
    pruned: Cell<bool>,
}

impl PastedImages {
    /// `prunePastedImages(dir)`: drops what is older than 7 days, once per run
    fn prune(&self) {
        if self.pruned.replace(true) {
            return;
        }
        let cutoff = self.clock.now_ms() - 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(meta) = fs::metadata(&path)
                && mtime_ms(&meta) < cutoff
            {
                // another tab may have removed it already; a folder stays
                let _ = fs::remove_file(&path);
            }
        }
    }

    /// `savePastedImage(data, ext)`: the file written, none for a non-image
    fn save(
        &self,
        data: Option<&IpcValue>,
        ext: Option<&IpcValue>,
    ) -> Result<Option<String>, IpcError> {
        let clean = match ext {
            Some(IpcValue::String(ext)) => ext.to_lowercase(),
            _ => String::new(),
        };
        if !is_image(&clean) {
            return Ok(None);
        }
        let bytes = match data {
            Some(IpcValue::Bytes(_, bytes)) if !bytes.is_empty() => bytes,
            _ => return Ok(None),
        };
        let dir = self.dir.to_string_lossy().into_owned();
        fs::create_dir_all(&self.dir).map_err(|e| error(fs_error(&e, "mkdir", &dir).message))?;
        self.prune();
        let iso = to_iso_string(self.clock.now_ms()).unwrap_or_default();
        let stamp: String = iso
            .chars()
            .take(19)
            .filter(|c| *c != '-' && *c != ':')
            .map(|c| if c == 'T' { '-' } else { c })
            .collect();
        self.seq.set(self.seq.get() + 1);
        let file = join(&[&dir, &format!("pasted-{stamp}-{}.{clean}", self.seq.get())]);
        fs::write(&file, bytes).map_err(|e| error(fs_error(&e, "open", &file).message))?;
        Ok(Some(file))
    }
}

// ---- dialogs with memory ----

/// `dialog` as `showOpenDialogWithMemory` calls it, over the shared host
struct HostDialog(DialogsHost);

fn string_list(value: Option<&JsonValue>) -> Vec<String> {
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

impl Dialog for HostDialog {
    type Window = WindowId;

    fn show_open_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let string = |key: &str| match options.get(key) {
            Some(JsonValue::String(s)) => Some(s.clone()),
            _ => None,
        };
        let filters = match options.get("filters") {
            Some(JsonValue::Array(items)) => items
                .iter()
                .filter_map(|item| match item {
                    JsonValue::Object(f) => Some(FileFilter {
                        name: match f.get("name") {
                            Some(JsonValue::String(s)) => s.clone(),
                            _ => String::new(),
                        },
                        extensions: string_list(f.get("extensions")),
                    }),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let dialog = FileDialog {
            title: string("title"),
            default_path: string("defaultPath").map(PathBuf::from),
            button_label: string("buttonLabel"),
            filters,
            properties: string_list(options.get("properties")),
        };
        let picked = self.0.open(parent.copied(), &dialog);
        let mut result = JsObject::new();
        result.set("canceled", JsonValue::Bool(picked.is_none()));
        result.set(
            "filePaths",
            JsonValue::Array(
                picked
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| JsonValue::String(p.to_string_lossy().into_owned()))
                    .collect(),
            ),
        );
        JsonValue::Object(result)
    }

    fn show_save_dialog(&mut self, _: Option<&WindowId>, _: &JsObject<JsonValue>) -> JsonValue {
        unreachable!("the attachment picker only opens files")
    }
}

// ---- sheets ----

/// A zod issue as `JSON.stringify(error.issues, null, 2)` prints it
struct Issue {
    /// the members before `path`, as `"key": value` text
    head: Vec<(&'static str, String)>,
    path: Option<&'static str>,
    message: String,
}

fn json_text(value: &str) -> String {
    jscompat::json_to_string(&JsonValue::String(value.to_owned())).unwrap_or_default()
}

fn issues_text(issues: &[Issue]) -> String {
    let mut out = String::from("[\n");
    for (i, issue) in issues.iter().enumerate() {
        out.push_str("  {\n");
        for (key, value) in &issue.head {
            out.push_str(&format!("    \"{key}\": {value},\n"));
        }
        match issue.path {
            Some(path) => out.push_str(&format!(
                "    \"path\": [\n      {}\n    ],\n",
                json_text(path)
            )),
            None => out.push_str("    \"path\": [],\n"),
        }
        out.push_str(&format!(
            "    \"message\": {}\n  }}",
            json_text(&issue.message)
        ));
        out.push_str(if i + 1 < issues.len() { ",\n" } else { "\n" });
    }
    out.push(']');
    out
}

/// What zod calls the type of a value in "received ..."
fn received(value: Option<&IpcValue>) -> &'static str {
    match value {
        None | Some(IpcValue::Undefined) => "undefined",
        Some(IpcValue::Null) => "null",
        Some(IpcValue::Bool(_)) => "boolean",
        Some(IpcValue::Number(n)) if n.is_nan() => "nan",
        Some(IpcValue::Number(_)) => "number",
        Some(IpcValue::String(_)) => "string",
        Some(IpcValue::Array(_)) => "array",
        Some(IpcValue::Date(_)) => "date",
        Some(IpcValue::Bytes(..) | IpcValue::Object(_)) => "object",
    }
}

fn invalid_type(expected: &'static str, got: &'static str, path: Option<&'static str>) -> Issue {
    Issue {
        head: vec![
            ("expected", json_text(expected)),
            ("code", json_text("invalid_type")),
        ],
        path,
        message: format!("Invalid input: expected {expected}, received {got}"),
    }
}

/// `localImageRequestSchema.parse(input)`: `{ path: z.string().min(1).max(1024) }`, strict
fn local_image_path(input: Option<&IpcValue>) -> Result<String, IpcError> {
    let thrown = |issues: Vec<Issue>| error_without_name(issues_text(&issues));
    let Some(IpcValue::Object(entries)) = input else {
        let got = received(input);
        return Err(thrown(vec![invalid_type("object", got, None)]));
    };
    let mut issues = Vec::new();
    let mut path = None;
    match input.and_then(|v| field(v, "path")) {
        Some(IpcValue::String(p)) => {
            let units = p.encode_utf16().count();
            if units < 1 {
                issues.push(Issue {
                    head: vec![
                        ("origin", json_text("string")),
                        ("code", json_text("too_small")),
                        ("minimum", "1".into()),
                        ("inclusive", "true".into()),
                    ],
                    path: Some("path"),
                    message: "Too small: expected string to have >=1 characters".into(),
                });
            } else if units > 1024 {
                issues.push(Issue {
                    head: vec![
                        ("origin", json_text("string")),
                        ("code", json_text("too_big")),
                        ("maximum", "1024".into()),
                        ("inclusive", "true".into()),
                    ],
                    path: Some("path"),
                    message: "Too big: expected string to have <=1024 characters".into(),
                });
            } else {
                path = Some(p.clone());
            }
        }
        other => issues.push(invalid_type("string", received(other), Some("path"))),
    }
    let mut unknown: Vec<&str> = Vec::new();
    for (key, _) in entries {
        if key != "path" && !unknown.contains(&key.as_str()) {
            unknown.push(key);
        }
    }
    if !unknown.is_empty() {
        let keys: Vec<String> = unknown
            .iter()
            .map(|k| format!("      {}", json_text(k)))
            .collect();
        issues.push(Issue {
            head: vec![
                ("code", json_text("unrecognized_keys")),
                ("keys", format!("[\n{}\n    ]", keys.join(",\n"))),
            ],
            path: None,
            message: if unknown.len() == 1 {
                format!("Unrecognized key: {}", json_text(unknown[0]))
            } else {
                let list: Vec<String> = unknown.iter().map(|k| json_text(k)).collect();
                format!("Unrecognized keys: {}", list.join(", "))
            },
        });
    }
    match path {
        Some(path) if issues.is_empty() => Ok(path),
        _ => Err(thrown(issues)),
    }
}

/// A `ZodError` thrown: its message is the issues, and it has no `Error:` prefix
fn error_without_name(message: String) -> IpcError {
    IpcError {
        name: None,
        message,
    }
}

/// `z.string().uuid()`
fn is_uuid(value: &str) -> bool {
    if value == "00000000-0000-0000-0000-000000000000"
        || value.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff")
    {
        return true;
    }
    let groups: Vec<&str> = value.split('-').collect();
    let hex = |s: &str, n: usize| s.len() == n && s.chars().all(|c| c.is_ascii_hexdigit());
    groups.len() == 5
        && hex(groups[0], 8)
        && hex(groups[1], 4)
        && hex(groups[2], 4)
        && groups[2].starts_with(['1', '2', '3', '4', '5', '6', '7', '8'])
        && hex(groups[3], 4)
        && groups[3].starts_with(['8', '9', 'a', 'b', 'A', 'B'])
        && hex(groups[4], 12)
}

/// `externalLinkRevealRequestSchema.safeParse(input)`: a UUID and a positive safe integer, strict
fn reveal_request(input: Option<&IpcValue>) -> Option<(String, u64)> {
    let Some(IpcValue::Object(entries)) = input else {
        return None;
    };
    if entries
        .iter()
        .any(|(k, _)| k != "sessionId" && k != "index")
    {
        return None;
    }
    let session = match input.and_then(|v| field(v, "sessionId")) {
        Some(IpcValue::String(s)) if is_uuid(s) => s.clone(),
        _ => return None,
    };
    match input.and_then(|v| field(v, "index")) {
        Some(IpcValue::Number(n))
            if n.fract() == 0.0 && *n >= 1.0 && *n <= 9_007_199_254_740_991.0 =>
        {
            Some((session, *n as u64))
        }
        _ => None,
    }
}

/// `sniffImageType(bytes)`
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && bytes[..4] == [0x89, 0x50, 0x4e, 0x47] {
        Some("image/png")
    } else if bytes.len() >= 3 && bytes[..3] == [0xff, 0xd8, 0xff] {
        Some("image/jpeg")
    } else if bytes.len() >= 6 && bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else {
        None
    }
}

// ---- registration ----

/// A handler that answers from a worker, as an `ipcMain` listener that awaited
struct OnWorker<F> {
    workers: Arc<dyn Workers>,
    run: Arc<F>,
}

impl<F> Handler for OnWorker<F>
where
    F: Fn(&CallContext, Vec<IpcValue>) -> Result<IpcValue, IpcError> + Send + Sync + 'static,
{
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let (cx, run) = (cx.clone(), self.run.clone());
        self.workers
            .spawn(Box::new(move || reply.reply(run(&cx, args))));
    }
}

fn on_worker<F>(
    registry: &mut dyn Registry,
    services: &Services,
    channel: &'static str,
    kind: ChannelKind,
    run: F,
) -> Result<(), RegisterError>
where
    F: Fn(&CallContext, Vec<IpcValue>) -> Result<IpcValue, IpcError> + Send + Sync + 'static,
{
    let handler = OnWorker {
        workers: services.workers.clone(),
        run: Arc::new(run),
    };
    registry.register(Batch::W, channel, kind, Rc::new(handler))
}

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    let hosts = &services.hosts;
    let dialogs: DialogsHost = hosts.need(Batch::W)?;
    let os: OsShellHost = hosts.need(Batch::W)?;
    let contents: ContentsHost = hosts.need(Batch::W)?;
    let main_window: MainWindowHost = hosts.need(Batch::W)?;
    let tabs: DocsTabsHost = hosts.need(Batch::W)?;
    let sheets: SheetsTabsHost = hosts.need(Batch::W)?;
    let clock: ClockHost = hosts.need(Batch::W)?;
    let tm = Tm {
        strings: Arc::new(strings()),
        lang: hosts.need(Batch::W)?,
    };
    let attachments = Attachments {
        tm: tm.clone(),
        parse: hosts.need(Batch::W)?,
        open_files: hosts.need(Batch::W)?,
        cache: Arc::default(),
    };
    let memory: crate::SharedDialogMemory = hosts.need(Batch::W)?;
    let temp = services.paths.path(PathName::Temp);
    let home = services.paths.path(PathName::Home);

    // ---- docs: attachments ----

    let (a, tm_pick) = (attachments.clone(), tm.clone());
    handle(registry, "files:pick", ChannelKind::Invoke, move |cx, _| {
        // `dialogParent(event)`: the sender's window, else the shell window
        let parent = contents
            .window_of(cx.sender.view)
            .or_else(|| main_window.window());
        let mut options = JsObject::new();
        options.set("title", JsonValue::String(tm_pick.say("dlgAddAttachment")));
        let mut supported = JsObject::new();
        supported.set("name", JsonValue::String(tm_pick.say("filterSupported")));
        supported.set(
            "extensions",
            JsonValue::Array(
                attachable_exts()
                    .map(|e| JsonValue::String(e.to_owned()))
                    .collect(),
            ),
        );
        let mut all = JsObject::new();
        all.set("name", JsonValue::String(tm_pick.say("filterAll")));
        all.set(
            "extensions",
            JsonValue::Array(vec![JsonValue::String("*".into())]),
        );
        options.set(
            "filters",
            JsonValue::Array(vec![JsonValue::Object(supported), JsonValue::Object(all)]),
        );
        options.set(
            "properties",
            JsonValue::Array(
                ["openFile", "multiSelections"]
                    .map(|p| JsonValue::String(p.into()))
                    .to_vec(),
            ),
        );
        let mut dialog = HostDialog(dialogs.clone());
        let result = with_shared_memory(&memory, |memory| {
            let result =
                show_open_dialog_with_memory(memory, &mut dialog, parent.as_ref(), &options, None);
            let confirmed = open_confirmed(&result);
            (result, confirmed)
        });
        let JsonValue::Object(result) = result else {
            return Ok(IpcValue::Null);
        };
        let paths = string_list(result.get("filePaths"));
        if matches!(result.get("canceled"), Some(JsonValue::Bool(true))) || paths.is_empty() {
            return Ok(IpcValue::Null);
        }
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        Ok(a.collect(&refs))
    })?;

    let a = attachments.clone();
    handle(
        registry,
        "files:add",
        ChannelKind::Invoke,
        move |_, args| {
            let Some(IpcValue::Array(items)) = args.first() else {
                return Err(IpcError {
                    name: Some("TypeError".into()),
                    message: "paths is not iterable".into(),
                });
            };
            let mut paths = Vec::new();
            for item in items {
                paths.push(path_arg(Some(item))?);
            }
            Ok(a.collect(&paths))
        },
    )?;

    let a = attachments.clone();
    on_worker(
        registry,
        services,
        "files:read",
        ChannelKind::Invoke,
        move |_, args| a.read(&args),
    )?;

    let a = attachments.clone();
    handle(
        registry,
        "files:read-image",
        ChannelKind::Invoke,
        move |_, args| a.read_image(&args),
    )?;

    let a = attachments.clone();
    let tm_paste = tm.clone();
    let pasted = PastedImages {
        dir: temp.join("seuoffice-pasted"),
        clock,
        seq: Cell::new(0),
        pruned: Cell::new(false),
    };
    handle(
        registry,
        "files:add-pasted-image",
        ChannelKind::Invoke,
        move |_, args| match pasted.save(args.first(), args.get(1))? {
            Some(file) => Ok(a.collect(&[&file])),
            None => Ok(object(vec![
                ("accepted", IpcValue::Array(vec![])),
                (
                    "rejected",
                    IpcValue::Array(vec![text(tm_paste.say("errNotImage"))]),
                ),
            ])),
        },
    )?;

    // ---- docs: windows ----

    let t = tabs.clone();
    handle(registry, "win:new", ChannelKind::Invoke, move |_, args| {
        // `openPath ?? undefined`; a pathless tab starts as a blank document
        let path = match args.first() {
            Some(IpcValue::String(path)) => Some(path.as_str()),
            _ => None,
        };
        let blank = path.is_none_or(str::is_empty);
        t.open_tab(path, blank);
        Ok(IpcValue::Undefined)
    })?;

    let t = tabs.clone();
    handle(registry, "win:list", ChannelKind::Invoke, move |_, _| {
        Ok(IpcValue::Array(
            t.list_tabs()
                .into_iter()
                .map(|tab| {
                    object(vec![
                        ("id", text(tab.id)),
                        ("title", text(tab.title)),
                        ("focused", IpcValue::Bool(tab.focused)),
                    ])
                })
                .collect(),
        ))
    })?;

    handle(
        registry,
        "win:focus",
        ChannelKind::Invoke,
        move |_, args| {
            match args.first() {
                Some(IpcValue::String(id)) => tabs.focus_tab(id),
                other => tabs.focus_tab(&js_text(other)),
            }
            Ok(IpcValue::Undefined)
        },
    )?;

    // ---- sheets ----

    let trusted = sheets.clone();
    let untrusted = move |cx: &CallContext| -> Result<(), IpcError> {
        if trusted.is_tab(cx.sender.view) {
            Ok(())
        } else {
            Err(error("Untrusted IPC sender."))
        }
    };

    let check = untrusted.clone();
    handle(
        registry,
        "shell:open-external",
        ChannelKind::Invoke,
        move |cx, args| {
            check(cx)?;
            let url = match args.first() {
                Some(IpcValue::String(url)) => safe_external_url(Some(url), None),
                _ => None,
            };
            let Some(url) = url else {
                return Err(error("Only http(s) links can be opened."));
            };
            os.open_external(&url).map_err(error)?;
            Ok(IpcValue::Undefined)
        },
    )?;

    let check = untrusted.clone();
    let sheet_tm = tm.clone();
    on_worker(
        registry,
        services,
        "shell:read-local-image",
        ChannelKind::Invoke,
        move |cx, args| {
            check(cx)?;
            let requested = local_image_path(args.first())?;
            let resolved = match requested.strip_prefix("~/") {
                Some(rest) => join(&[&home.to_string_lossy(), rest]),
                None => requested.clone(),
            };
            if !is_absolute(&resolved) {
                return Err(error(sheet_tm.say("errImgAbsPath")));
            }
            let meta = fs::metadata(&resolved).ok().filter(fs::Metadata::is_file);
            let Some(meta) = meta else {
                return Err(error(sheet_tm.say_with(
                    "errImgNotFound",
                    "path",
                    JsonValue::String(requested),
                )));
            };
            if meta.len() > 20 * 1024 * 1024 {
                return Err(error(sheet_tm.say("errImgTooLarge20")));
            }
            let bytes =
                fs::read(&resolved).map_err(|e| error(fs_error(&e, "open", &resolved).message))?;
            let Some(media_type) = sniff_image(&bytes) else {
                return Err(error(sheet_tm.say("errImgBadType")));
            };
            Ok(object(vec![
                ("mediaType", text(media_type)),
                ("base64", text(base64(&bytes))),
            ]))
        },
    )?;

    let os_reveal: OsShellHost = hosts.need(Batch::W)?;
    on_worker(
        registry,
        services,
        "shell:reveal-link-source",
        ChannelKind::Send,
        move |cx, args| {
            let Some((session, index)) = reveal_request(args.first()) else {
                return Ok(IpcValue::Undefined);
            };
            if !sheets.is_tab(cx.sender.view) {
                return Ok(IpcValue::Undefined);
            }
            // Locate is best-effort: only a real file is revealed
            if let Some(source) = sheets.external_link_source(cx.sender.view, &session, index)
                && Path::new(&source).exists()
            {
                os_reveal.show_item_in_folder(Path::new(&source));
            }
            Ok(IpcValue::Undefined)
        },
    )
}

/// `String(value)` of a renderer-sent value that should have been a string
fn js_text(value: Option<&IpcValue>) -> String {
    match value {
        Some(IpcValue::String(s)) => s.clone(),
        Some(IpcValue::Number(n)) => jscompat::number_to_string(*n),
        Some(IpcValue::Bool(b)) => b.to_string(),
        Some(IpcValue::Null) => "null".into(),
        _ => "undefined".into(),
    }
}

// ---- the probe's fakes ----

#[cfg(feature = "probe")]
mod fakes {
    use std::sync::Mutex;

    use serde_json::{Value, json};

    use super::*;

    pub type ProbeLog = Arc<Mutex<Vec<Value>>>;

    pub struct FakeTabs {
        pub log: ProbeLog,
        pub tabs: Vec<DocsTab>,
    }

    impl DocsTabs for FakeTabs {
        fn open_tab(&self, path: Option<&str>, new_blank: bool) {
            let options = if new_blank {
                json!({ "newBlank": true })
            } else {
                Value::Null
            };
            self.log
                .lock()
                .unwrap()
                .push(json!(["docs.openTab", path, options]));
        }

        fn list_tabs(&self) -> Vec<DocsTab> {
            self.tabs.clone()
        }

        fn focus_tab(&self, id: &str) {
            self.log.lock().unwrap().push(json!(["docs.focusTab", id]));
        }
    }

    pub struct FakeOpenFiles(pub Option<Vec<OpenFileState>>);

    impl OpenFiles for FakeOpenFiles {
        fn open_files(&self) -> Result<Vec<OpenFileState>, OpenFilesSourceFailed> {
            self.0.clone().ok_or(OpenFilesSourceFailed)
        }
    }

    /// What `parseFileToText` does for a plain text file: its UTF-8 text
    pub struct FakeParse;

    impl FileParse for FakeParse {
        fn parse_file_to_text(&self, path: &Path) -> Result<ParsedFile, String> {
            let body = fs::read(path).map_err(|e| e.to_string())?;
            Ok(ParsedFile {
                ok: true,
                kind: ParsedKind::Text,
                text: Some(String::from_utf8_lossy(&body).into_owned()),
                error: None,
                damaged: false,
            })
        }

        fn diagram_picture_ext(&self, path: &Path) -> Option<&'static str> {
            diagram_picture_ext_of_name(&path.to_string_lossy())
        }
    }

    pub struct FakeLang(pub Lang);

    impl UiLanguage for FakeLang {
        fn lang(&self) -> Lang {
            self.0
        }
    }

    pub struct FakeClock(pub f64);

    impl Clock for FakeClock {
        fn now_ms(&self) -> f64 {
            self.0
        }
    }

    pub struct FakeSheets(pub Vec<u32>);

    impl SheetsTabs for FakeSheets {
        fn is_tab(&self, view: ViewId) -> bool {
            self.0.contains(&view.0)
        }

        fn external_link_source(&self, _: ViewId, _: &str, _: u64) -> Option<String> {
            None
        }
    }
}

/// `hosts.w`: `docsTabs` (`[{id, title, focused}]`), `lang`, `now` (ms),
/// `openFiles` (`[{filePath, dirty}]`, or `"fail"` when the source throws),
/// `sheetsTabs` (the views that are sheets tabs). Plain-text files stand for
/// what `parseFileToText` reads.
#[cfg(feature = "probe")]
pub fn probe_hosts(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    use fakes::*;
    type Log = Arc<Mutex<Vec<serde_json::Value>>>;
    let log = hosts
        .get::<Log>()
        .cloned()
        .expect("the probe inserts its log before the batches' fakes");
    let tabs: Vec<DocsTab> = case["docsTabs"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|t| DocsTab {
                    id: t["id"].as_str().unwrap_or_default().into(),
                    title: t["title"].as_str().unwrap_or_default().into(),
                    focused: t["focused"].as_bool().unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default();
    let tabs: DocsTabsHost = Arc::new(FakeTabs { log, tabs });
    hosts.insert(tabs);
    let open_files = match &case["openFiles"] {
        serde_json::Value::String(_) => None,
        list => Some(
            list.as_array()
                .map(|list| {
                    list.iter()
                        .map(|f| OpenFileState {
                            file_path: f["filePath"].as_str().map(String::from),
                            dirty: f["dirty"].as_bool().unwrap_or(false),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        ),
    };
    let open_files: OpenFilesHost = Arc::new(FakeOpenFiles(open_files));
    hosts.insert(open_files);
    let parse: FileParseHost = Arc::new(FakeParse);
    hosts.insert(parse);
    let lang = match case["lang"].as_str() {
        Some("en") => Lang::En,
        _ => Lang::Ko,
    };
    let lang: UiLanguageHost = Arc::new(FakeLang(lang));
    hosts.insert(lang);
    let clock: ClockHost = Arc::new(FakeClock(
        case["now"].as_f64().unwrap_or(1_800_000_000_000.0),
    ));
    hosts.insert(clock);
    let views = case["sheetsTabs"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_u64().map(|v| v as u32))
                .collect()
        })
        .unwrap_or_default();
    let sheets: SheetsTabsHost = Arc::new(FakeSheets(views));
    hosts.insert(sheets);
}
