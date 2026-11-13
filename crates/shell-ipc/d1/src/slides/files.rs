//! `attachments-ipc.ts`: the slides:files-* channels of the AI panel's
//! attachments. A file is accepted by extension and size; pictures go to the
//! model as pictures, every other kind is read as text by `parseFileToText`
//! (the engine's `parse_file_text`). A file open in a tab with unsaved
//! changes is not read.

use std::fs;
use std::sync::{Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use jscompat::node_path::host::{basename, extname, join};
use jscompat::{JsonValue, js_regex, slice_utf16, to_iso_string, trim};
use main_core::node_fs::node_error;
use shell_contract::IpcError;
use shell_contract::IpcValue;
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::runtime::PathName;

use super::dialog::{filter_of, jstr, options};
use super::state::App;
use crate::host::path_string;
use crate::value::{Args, num, obj, string, thrown};

type Reply = Result<IpcValue, IpcError>;

const MAX_BYTES: u64 = 50 * 1024 * 1024;
const IMAGE_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// the most characters one read hands back
const READ_MAX_CHARS: f64 = 48_000.0;

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

/// `attachableMaxBytes(ext)`
fn attachable_max_bytes(ext: &str) -> f64 {
    let clean = ext.strip_prefix('.').unwrap_or(ext).to_lowercase();
    if is_image_ext(&clean) {
        IMAGE_MAX_BYTES as f64
    } else if SIZE_FREE_EXTS.contains(&clean.as_str()) {
        f64::INFINITY
    } else {
        MAX_BYTES as f64
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

/// `name.split('.').pop()?.toLowerCase() ?? ''`
fn ext_of(name: &str) -> String {
    name.rsplit('.').next().unwrap_or("").to_lowercase()
}

/// `diagramPictureExtOfName(fileName)`
fn picture_ext_of_name(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    if lower.ends_with(".drawio.svg") {
        Some("drawio.svg")
    } else if lower.ends_with(".drawio.png") {
        Some("drawio.png")
    } else {
        None
    }
}

/// Text already read, by path; a changed file (time or size) is read again.
/// At most eight files, the oldest dropped first.
#[derive(Default)]
pub struct TextCache {
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

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

impl App {
    fn ext_for(&self, path: &str, name: &str) -> String {
        match self.engine.diagram_picture_ext_of(path) {
            Some(ext) => ext,
            None => ext_of(name),
        }
    }

    /// `statAttachment(filePath)`
    fn stat_attachment(&self, path: &str) -> Result<IpcValue, String> {
        let name = basename(path, None);
        let ext = self.ext_for(path, &name);
        if !is_attachable(&ext) {
            return Err(format!(
                "{name}: {}",
                self.tm("errUnsupportedExt", &[("ext", JsonValue::String(ext))])
            ));
        }
        let Ok(meta) = fs::metadata(path) else {
            return Err(format!("{name}: {}", self.tm("errUnreadable", &[])));
        };
        if !meta.is_file() {
            return Err(format!("{name}: {}", self.tm("errNotFile", &[])));
        }
        let size = meta.len();
        if !is_image_ext(&ext) && size as f64 > attachable_max_bytes(&ext) {
            let mb = (MAX_BYTES as f64 / 1024.0 / 1024.0).round();
            return Err(format!(
                "{name}: {}",
                self.tm("errTooLarge", &[("mb", JsonValue::Number(mb))])
            ));
        }
        if is_image_ext(&ext) && size > IMAGE_MAX_BYTES {
            return Err(format!("{name}: {}", self.tm("errImageTooLarge", &[])));
        }
        Ok(obj([
            ("path", string(path)),
            ("name", string(name)),
            ("ext", string(ext)),
            ("sizeBytes", num(size as f64)),
        ]))
    }

    /// `collectAttachments(paths)`
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
                Err(reason) => rejected.push(string(reason)),
            }
        }
        obj([
            ("accepted", IpcValue::Array(accepted)),
            ("rejected", IpcValue::Array(rejected)),
        ])
    }
}

pub fn files_pick(app: &App, _cx: &CallContext, _args: Args) -> Reply {
    let supported: Vec<String> = attachable_exts().map(str::to_owned).collect();
    let paths = app.pick_open(&options([
        ("title", jstr(app.tm("dlgAddAttachment", &[]))),
        (
            "filters",
            JsonValue::Array(vec![
                filter_of(app.tm("filterSupported", &[]), supported),
                filter_of(app.tm("filterAll", &[]), vec!["*".into()]),
            ]),
        ),
        (
            "properties",
            JsonValue::Array(vec![jstr("openFile"), jstr("multiSelections")]),
        ),
    ]));
    if paths.is_empty() {
        return Ok(IpcValue::Null);
    }
    let values: Vec<IpcValue> = paths.into_iter().map(string).collect();
    Ok(app.collect_attachments(&values))
}

pub fn files_add(app: &App, _cx: &CallContext, args: Args) -> Reply {
    Ok(match args.get(0) {
        IpcValue::Array(paths) => app.collect_attachments(paths),
        _ => app.collect_attachments([]),
    })
}

pub fn files_add_pasted_image(app: &App, _cx: &CallContext, args: Args) -> Reply {
    let rejected = |text: String| {
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
        _ => return Ok(rejected(app.tm("errNotImage", &[]))),
    };
    // the renderer decides what lands on disk here: the picture limit applies first
    if bytes.len() as u64 > IMAGE_MAX_BYTES {
        return Ok(rejected(app.tm("errImageTooLarge", &[])));
    }
    let temp = path_string(app.services.paths.path(PathName::Temp));
    let dir = join(&[&temp, "seuoffice-pasted"]);
    fs::create_dir_all(&dir).map_err(|e| thrown(node_error(&e, "mkdir", &dir).message))?;
    let now = super::recovery::now_ms();
    // `new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')`
    let iso = to_iso_string(now).unwrap_or_default();
    let stamp = js_regex!(r"[-:]", "g")
        .replace_all(&slice_utf16(&iso, 0.0, Some(19.0)), |_| String::new())
        .replacen('T', "-", 1);
    let seq = {
        let mut state = app.state.borrow_mut();
        state.pasted_image_seq += 1;
        state.pasted_image_seq
    };
    let path = join(&[&dir, &format!("pasted-{stamp}-{seq}.{ext}")]);
    fs::write(&path, bytes).map_err(|e| thrown(node_error(&e, "open", &path).message))?;
    Ok(app.collect_attachments([&string(path)]))
}

pub fn files_read(app: &App, _cx: &CallContext, args: Args, reply: Responder) {
    let IpcValue::String(path) = args.get(0) else {
        // `basename(undefined)` throws in the TypeScript: the invoke rejects
        return reply.reply(Err(IpcError {
            name: Some("TypeError".into()),
            message: "The \"path\" argument must be of type string".into(),
        }));
    };
    let name = basename(path, None);
    let ext = app.ext_for(path, &name);
    if !is_attachable(&ext) {
        return reply.reply(Ok(read_error(
            app.tm("errUnsupportedExt", &[("ext", JsonValue::String(ext))]),
        )));
    }
    if is_image_ext(&ext) {
        return reply.reply(Ok(read_error(app.tm("errImageNoText", &[]))));
    }
    // a file open with unsaved changes is not read (before the cache): a
    // withholding mark only reaches the file on save
    if let Err(message) = app.shell.assert_file_saved(path) {
        return reply.reply(Ok(read_error(message)));
    }
    let start = floor_or(args.get(1), 0.0).max(0.0);
    let size = floor_or(args.get(2), 1.0).clamp(1.0, READ_MAX_CHARS);
    let engine = app.engine.clone();
    let cache = app.text_cache.clone();
    let too_large = app.tm("errFileTooLarge", &[]);
    let parse_failed = app.tm("errParseFailed", &[]);
    let path = path.clone();
    app.services.workers.spawn(Box::new(move || {
        let text = (|| -> Result<String, String> {
            let meta = fs::metadata(&path).map_err(|e| node_error(&e, "stat", &path).message)?;
            let stamp = format!(
                "{}:{}",
                jscompat::number_to_string(mtime_ms(&meta)),
                meta.len()
            );
            if let Some(text) = cache
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&path, &stamp)
            {
                return Ok(text);
            }
            let cap_ext = match picture_ext_of_name(&basename(&path, None)) {
                Some(ext) => ext.to_owned(),
                None => extname(&path),
            };
            if meta.len() as f64 > attachable_max_bytes(&cap_ext) {
                return Err(too_large);
            }
            let text = match engine.parse_file_text(&path) {
                Ok(text) => text,
                Err(error) if !error.is_empty() => return Err(error),
                Err(_) => return Err(parse_failed),
            };
            cache
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .put(&path, stamp, text.clone());
            Ok(text)
        })();
        reply.reply(Ok(match text {
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

pub fn files_read_image(app: &App, _cx: &CallContext, args: Args) -> Reply {
    let path = args.str(0).unwrap_or("");
    let name = basename(path, None);
    let Some(mime) = image_mime(&ext_of(&name)) else {
        return Ok(read_error(format!(
            "{name}: {}",
            app.tm("errNotImage", &[])
        )));
    };
    let Ok(meta) = fs::metadata(path) else {
        return Ok(read_error(format!(
            "{name}: {}",
            app.tm("errUnreadable", &[])
        )));
    };
    if meta.len() > IMAGE_MAX_BYTES {
        return Ok(read_error(format!(
            "{name}: {}",
            app.tm("errImageTooLarge", &[])
        )));
    }
    Ok(match fs::read(path) {
        Ok(bytes) => obj([
            ("ok", IpcValue::Bool(true)),
            ("base64", string(jscompat::base64(&bytes))),
            ("mime", string(mime)),
        ]),
        Err(_) => read_error(format!("{name}: {}", app.tm("errUnreadable", &[]))),
    })
}

/// shared state of the text cache
pub type SharedTextCache = std::sync::Arc<Mutex<TextCache>>;
