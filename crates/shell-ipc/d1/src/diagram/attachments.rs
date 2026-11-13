//! `ai-attachments.ts`: the AI panel's attachments and the untitled diagram's
//! provisional name. A file is accepted by extension and size; pictures (5 MB
//! at most) go to the model as pictures, every other kind is read as text
//! (by `parseFileToText`, so what a reader withholds from a model is withheld
//! here too). A file open in a tab with unsaved changes is not read. One read
//! hands back at most 48,000 characters.

use std::fs;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jscompat::node_path::host::{basename, extname, join};
use jscompat::{JsObject, JsonValue, js_regex, slice_utf16, to_iso_string, trim};
use main_core::node_fs::node_error;
use main_core::packages::electron_utils::dialog_memory::show_open_dialog_with_memory;
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::{IpcError, IpcValue};

use super::DiagramViews;
use super::engine::DiagramEngineHost;
use super::files::json_filters;
use super::formats::{Detected, DiagramFormat, detect_format};
use super::strings::{Attach, attach, too_large, unsupported_ext};
use crate::host::{HostDialog, LocaleHost, path_string};
use crate::value::{Args, num, obj, string, thrown};
use shell_contract::runtime::PathName;

/// The largest file read as an attachment (`ATTACHABLE_MAX_BYTES`)
pub const ATTACHMENT_MAX_BYTES: u64 = 50 * 1024 * 1024;
/// The largest picture sent to the model with a message
pub const ATTACHMENT_IMAGE_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// The most characters one read hands back; the panel asks for less
pub const ATTACHMENT_READ_MAX_CHARS: f64 = 48_000.0;

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
/// formats read at any size: their size is pictures, not words
const SIZE_FREE_EXTS: [&str; 9] = [
    "docx", "pptx", "xlsx", "xlsm", "hwpx", "odt", "epub", "xmind", "pdf",
];

/// `ATTACHABLE_EXTS`, in the order the dialog filter lists them
fn attachable_exts() -> impl Iterator<Item = &'static str> {
    TEXT_EXTS
        .into_iter()
        .chain(OFFICE_EXTS)
        .chain(DIAGRAM_EXTS)
        .chain(IMAGE_EXTS)
}

fn is_attachable(ext: &str) -> bool {
    attachable_exts().any(|known| known == ext)
}

fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}

/// `attachableMaxBytes(ext)`: a picture's cap, no cap for the formats read at
/// any size, else `ATTACHABLE_MAX_BYTES`
fn attachable_max_bytes(ext: &str) -> f64 {
    let clean = ext.strip_prefix('.').unwrap_or(ext).to_lowercase();
    if is_image_ext(&clean) {
        ATTACHMENT_IMAGE_MAX_BYTES as f64
    } else if SIZE_FREE_EXTS.contains(&clean.as_str()) {
        f64::INFINITY
    } else {
        ATTACHMENT_MAX_BYTES as f64
    }
}

fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// `extOf(name)`
fn ext_of(name: &str) -> String {
    if name.contains('.') {
        name.rsplit('.').next().unwrap_or("").to_lowercase()
    } else {
        String::new()
    }
}

/// Text already read, by path; a changed file (time or size) is read again.
/// At most eight files, the oldest dropped first.
#[derive(Default)]
pub(super) struct TextCache {
    entries: Vec<(String, String, String)>,
}

impl TextCache {
    fn get(&self, path: &str, stamp: &str) -> Option<String> {
        self.entries
            .iter()
            .find(|(p, s, _)| p == path && s == stamp)
            .map(|(_, _, text)| text.clone())
    }

    fn put(&mut self, path: &str, stamp: String, text: String) {
        match self.entries.iter_mut().find(|(p, _, _)| p == path) {
            Some(entry) => *entry = (path.to_owned(), stamp, text),
            None => self.entries.push((path.to_owned(), stamp, text)),
        }
        if self.entries.len() > 8 {
            self.entries.remove(0);
        }
    }
}

/// `Math.floor(Number(value)) || 0`
fn floor_or(value: &IpcValue, fallback: f64) -> f64 {
    let number = match value {
        IpcValue::Number(x) => *x,
        IpcValue::Bool(flag) => f64::from(u8::from(*flag)),
        IpcValue::Null => 0.0,
        IpcValue::String(text) => {
            let text = trim(text);
            if text.is_empty() {
                0.0
            } else {
                text.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    };
    let floored = number.floor();
    if floored.is_nan() || floored == 0.0 {
        fallback
    } else {
        floored
    }
}

fn read_error(error: impl Into<String>) -> IpcValue {
    obj([("ok", IpcValue::Bool(false)), ("error", string(error))])
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(char::from(TABLE[(n >> 18) as usize & 63]));
        out.push(char::from(TABLE[(n >> 12) as usize & 63]));
        out.push(if chunk.len() > 1 {
            char::from(TABLE[(n >> 6) as usize & 63])
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            char::from(TABLE[n as usize & 63])
        } else {
            '='
        });
    }
    out
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// `diagramPictureExtOfName(fileName)` as the extension string
fn picture_ext_of_name(name: &str) -> Option<&'static str> {
    match detect_format(name) {
        Some(Detected::Format(f @ (DiagramFormat::DrawioSvg | DiagramFormat::DrawioPng))) => {
            Some(f.as_str())
        }
        _ => None,
    }
}

/// Everything a worker needs to read one attachment's text
struct TextJob {
    engine: DiagramEngineHost,
    locale: LocaleHost,
    cache: Arc<Mutex<TextCache>>,
}

impl TextJob {
    fn tm(&self, key: Attach) -> &'static str {
        attach(self.locale.ui_lang(), key)
    }

    /// `attachmentText(filePath)` after the unsaved-changes check
    fn text(&self, path: &str) -> Result<String, String> {
        let meta = fs::metadata(path).map_err(|e| node_error(&e, "stat", path).message)?;
        let stamp = format!(
            "{}:{}",
            jscompat::number_to_string(mtime_ms(&meta)),
            meta.len()
        );
        if let Some(text) = self
            .cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(path, &stamp)
        {
            return Ok(text);
        }
        let cap_ext = match picture_ext_of_name(&basename(path, None)) {
            Some(ext) => ext.to_owned(),
            None => extname(path),
        };
        if meta.len() as f64 > attachable_max_bytes(&cap_ext) {
            return Err(self.tm(Attach::ErrFileTooLarge).to_owned());
        }
        let parsed = self.engine.parse_file_to_text(path);
        let text = match parsed.text {
            Some(text) if parsed.ok && parsed.is_text => text,
            _ => {
                return Err(match parsed.error {
                    Some(error) if !parsed.damaged && !error.is_empty() => error,
                    _ => self.tm(Attach::ErrParseFailed).to_owned(),
                });
            }
        };
        self.cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .put(path, stamp, text.clone());
        Ok(text)
    }
}

impl DiagramViews {
    fn attach_tm(&self, key: Attach) -> &'static str {
        attach(self.lang(), key)
    }

    /// `statAttachment(filePath)`: the metadata, or the reason it may not be attached
    fn stat_attachment(&self, path: &str) -> Result<IpcValue, String> {
        let lang = self.lang();
        let name = basename(path, None);
        // a draw.io picture that holds its diagram is read as diagram text
        let ext = match self.0.engine.diagram_picture_ext_of(path) {
            Some(format) => format.as_str().to_owned(),
            None => ext_of(&name),
        };
        if !is_attachable(&ext) {
            return Err(format!("{name}: {}", unsupported_ext(lang, &ext)));
        }
        let Ok(meta) = fs::metadata(path) else {
            return Err(format!("{name}: {}", attach(lang, Attach::ErrUnreadable)));
        };
        if !meta.is_file() {
            return Err(format!("{name}: {}", attach(lang, Attach::ErrNotFile)));
        }
        let size = meta.len();
        if !is_image_ext(&ext) && size as f64 > attachable_max_bytes(&ext) {
            let mb = (ATTACHMENT_MAX_BYTES as f64 / 1024.0 / 1024.0).round();
            return Err(format!("{name}: {}", too_large(lang, mb)));
        }
        if is_image_ext(&ext) && size > ATTACHMENT_IMAGE_MAX_BYTES {
            return Err(format!(
                "{name}: {}",
                attach(lang, Attach::ErrImageTooLarge)
            ));
        }
        Ok(obj([
            ("path", string(path)),
            ("name", string(name)),
            ("ext", string(ext)),
            ("sizeBytes", num(size as f64)),
        ]))
    }

    /// `collectAttachments(paths)`: the files that may be attached, with a
    /// reason for each one that may not
    fn collect_attachments<'a>(&self, paths: impl IntoIterator<Item = &'a IpcValue>) -> IpcValue {
        let mut accepted = Vec::new();
        let mut rejected = Vec::new();
        for path in paths {
            let IpcValue::String(path) = path else {
                continue;
            };
            if path.is_empty() {
                continue;
            }
            match self.stat_attachment(path) {
                Ok(meta) => accepted.push(meta),
                Err(reason) => rejected.push(IpcValue::String(reason)),
            }
        }
        obj([
            ("accepted", IpcValue::Array(accepted)),
            ("rejected", IpcValue::Array(rejected)),
        ])
    }

    /// Pasted pictures older than a week are removed, once per run of the app
    fn prune_pasted_images(&self, dir: &str) {
        if self.with_state(|state| std::mem::replace(&mut state.pasted_pruned, true)) {
            return;
        }
        let cutoff = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
            - Duration::from_secs(7 * 24 * 60 * 60).as_secs_f64() * 1000.0;
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if fs::metadata(&path).is_ok_and(|meta| mtime_ms(&meta) < cutoff) {
                let _ = fs::remove_file(&path);
            }
        }
    }

    // ---- handlers ----

    pub(super) fn files_pick(&self, cx: &CallContext, _args: Args) -> Result<IpcValue, IpcError> {
        let supported: Vec<String> = attachable_exts().map(str::to_owned).collect();
        let mut options = JsObject::new();
        options.set(
            "title",
            JsonValue::String(self.attach_tm(Attach::DlgAddAttachment).to_owned()),
        );
        options.set(
            "filters",
            json_filters(vec![
                (
                    self.attach_tm(Attach::FilterSupported).to_owned(),
                    supported,
                ),
                (
                    self.attach_tm(Attach::FilterAll).to_owned(),
                    vec!["*".into()],
                ),
            ]),
        );
        options.set(
            "properties",
            JsonValue::Array(vec![
                JsonValue::String("openFile".into()),
                JsonValue::String("multiSelections".into()),
            ]),
        );
        let result = {
            let mut memory = self
                .0
                .shared
                .dialog_memory
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            show_open_dialog_with_memory(
                &mut memory,
                &mut HostDialog(&*self.0.dialogs),
                Some(&cx.sender.window),
                &options,
                None,
            )
        };
        let JsonValue::Object(result) = result else {
            return Ok(IpcValue::Null);
        };
        let paths: Vec<IpcValue> = match result.get("filePaths") {
            Some(JsonValue::Array(paths)) => paths
                .iter()
                .filter_map(|p| match p {
                    JsonValue::String(p) => Some(IpcValue::String(p.clone())),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        if result.get("canceled").is_some_and(JsonValue::truthy) || paths.is_empty() {
            return Ok(IpcValue::Null);
        }
        Ok(self.collect_attachments(&paths))
    }

    pub(super) fn files_add(&self, _cx: &CallContext, args: Args) -> Result<IpcValue, IpcError> {
        Ok(match args.get(0) {
            IpcValue::Array(paths) => self.collect_attachments(paths),
            _ => self.collect_attachments([]),
        })
    }

    pub(super) fn files_add_pasted_image(
        &self,
        _cx: &CallContext,
        args: Args,
    ) -> Result<IpcValue, IpcError> {
        let lang = self.lang();
        let rejected = |text: &str| {
            obj([
                ("accepted", IpcValue::Array(vec![])),
                ("rejected", IpcValue::Array(vec![string(text)])),
            ])
        };
        let ext = match args.get(1) {
            IpcValue::String(ext) => ext.to_lowercase(),
            _ => String::new(),
        };
        let bytes = match args.get(0) {
            IpcValue::Bytes(_, bytes) if is_image_ext(&ext) && !bytes.is_empty() => bytes,
            _ => return Ok(rejected(attach(lang, Attach::ErrNotImage))),
        };
        // the renderer decides what lands on disk here: the picture limit applies before anything is written
        if bytes.len() as u64 > ATTACHMENT_IMAGE_MAX_BYTES {
            return Ok(rejected(attach(lang, Attach::ErrImageTooLarge)));
        }
        let temp = path_string(self.0.services.paths.path(PathName::Temp));
        let dir = join(&[&temp, "seuoffice-pasted"]);
        fs::create_dir_all(&dir).map_err(|e| thrown(node_error(&e, "mkdir", &dir).message))?;
        self.prune_pasted_images(&dir);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0.0, |d| d.as_millis() as f64);
        // `new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')`
        let iso = to_iso_string(now).unwrap_or_default();
        let stamp = js_regex!(r"[-:]", "g")
            .replace_all(&slice_utf16(&iso, 0.0, Some(19.0)), |_| String::new())
            .replacen('T', "-", 1);
        let seq = self.with_state(|state| {
            state.pasted_seq += 1;
            state.pasted_seq
        });
        let path = join(&[&dir, &format!("pasted-{stamp}-{seq}.{ext}")]);
        fs::write(&path, bytes).map_err(|e| thrown(node_error(&e, "open", &path).message))?;
        Ok(self.collect_attachments([&string(path)]))
    }

    pub(super) fn files_read(&self, _cx: &CallContext, args: Args, reply: Responder) {
        let lang = self.lang();
        let IpcValue::String(path) = args.get(0) else {
            return reply.reply(Ok(read_error(attach(lang, Attach::ErrUnreadable))));
        };
        if path.is_empty() {
            return reply.reply(Ok(read_error(attach(lang, Attach::ErrUnreadable))));
        }
        let name = basename(path, None);
        let ext = match self.0.engine.diagram_picture_ext_of(path) {
            Some(format) => format.as_str().to_owned(),
            None => ext_of(&name),
        };
        if !is_attachable(&ext) {
            return reply.reply(Ok(read_error(unsupported_ext(lang, &ext))));
        }
        if is_image_ext(&ext) {
            return reply.reply(Ok(read_error(attach(lang, Attach::ErrImageNoText))));
        }
        // a file open with unsaved changes is not read (before the cache): a
        // withholding mark only reaches the file on save
        if let Err(message) = self.0.shell.assert_file_saved(path) {
            return reply.reply(Ok(read_error(message)));
        }
        let start = floor_or(args.get(1), 0.0).max(0.0);
        let size = floor_or(args.get(2), 1.0).clamp(1.0, ATTACHMENT_READ_MAX_CHARS);
        let job = TextJob {
            engine: self.0.engine.clone(),
            locale: self.0.locale.clone(),
            cache: self.0.text_cache.clone(),
        };
        let path = path.clone();
        self.0.services.workers.spawn(Box::new(move || {
            reply.reply(Ok(match job.text(&path) {
                Ok(text) => {
                    let total = text.encode_utf16().count();
                    obj([
                        ("ok", IpcValue::Bool(true)),
                        ("name", string(name)),
                        ("totalChars", num(total as f64)),
                        ("offset", num(start)),
                        (
                            "text",
                            string(slice_utf16(&text, start, Some(start + size))),
                        ),
                    ])
                }
                Err(message) => read_error(message),
            }));
        }));
    }

    pub(super) fn files_read_image(
        &self,
        _cx: &CallContext,
        args: Args,
    ) -> Result<IpcValue, IpcError> {
        let lang = self.lang();
        let path = args.str(0).unwrap_or("");
        let name = basename(path, None);
        let mime = image_mime(&ext_of(&name));
        let (false, Some(mime)) = (path.is_empty(), mime) else {
            return Ok(read_error(format!(
                "{name}: {}",
                attach(lang, Attach::ErrNotImage)
            )));
        };
        let Ok(meta) = fs::metadata(path) else {
            return Ok(read_error(format!(
                "{name}: {}",
                attach(lang, Attach::ErrUnreadable)
            )));
        };
        if meta.len() > ATTACHMENT_IMAGE_MAX_BYTES {
            return Ok(read_error(format!(
                "{name}: {}",
                attach(lang, Attach::ErrImageTooLarge)
            )));
        }
        Ok(match fs::read(path) {
            Ok(bytes) => obj([
                ("ok", IpcValue::Bool(true)),
                ("base64", string(base64(&bytes))),
                ("mime", string(mime)),
            ]),
            Err(_) => read_error(format!("{name}: {}", attach(lang, Attach::ErrUnreadable))),
        })
    }

    pub(super) fn provisional_title(&self, cx: &CallContext, args: Args) -> Result<(), IpcError> {
        let view = cx.sender.view;
        let Some(title) = args.str(0) else {
            return Ok(());
        };
        let has_file = self.with_state(|state| {
            state
                .views
                .get(&view)
                .is_some_and(|v| v.save_path.is_some() || v.import.is_some())
        });
        if has_file {
            return Ok(());
        }
        let squeezed = js_regex!(r"\s+", "g").replace_all(title, |_| " ".to_owned());
        let clean = slice_utf16(trim(&squeezed), 0.0, Some(80.0));
        if !clean.is_empty() {
            self.0.shell.provisional_title(view, &clean);
        }
        Ok(())
    }
}
