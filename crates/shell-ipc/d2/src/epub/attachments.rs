//! `apps/epub/src/main/ai-attachments.ts`: the AI panel's attachments.
//!
//! A file is accepted by extension and size; pictures (5 MB at most) go to
//! the model as pictures, every other kind is read as text through
//! `parseFileToText` ([`super::EpubEngine::parse_file_to_text`]). A file open
//! in a tab with unsaved changes is not read. One read hands back at most
//! 48,000 characters. The format list is `@seuoffice/file-parse`'s
//! `attachable.ts`.

use std::fs;

use jscompat::node_path::host::{basename, extname, join};
use main_core::node_fs::{namespaced, node_error};
use main_core::packages::electron_utils::dialog_memory::show_open_dialog_with_memory;
use main_core::packages::electron_utils::unsaved_files::{OpenFilesHolder, assert_file_saved};
use main_core::packages::i18n::Lang;
use main_core::shell::recent_files::StatInfo;
use shell_contract::ipc::Responder;
use shell_contract::runtime::PathName;
use shell_contract::{IpcError, IpcValue, ViewId};

use super::session::{object, slice16};
use super::{DialogAdapter, Epub, js_object, now_ms};
use crate::kit::{self, Args, IntoIpc};
use jscompat::JsonValue;

/// `ATTACHABLE_EXTS`, in its order (the dialog's filter lists them so)
const ATTACHABLE_EXTS: [&str; 49] = [
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
/// `ATTACHABLE_IMAGE_EXTS`
const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
/// formats read at any size (`SIZE_FREE_EXTS`)
const SIZE_FREE_EXTS: [&str; 9] = [
    "docx", "pptx", "xlsx", "xlsm", "hwpx", "odt", "epub", "xmind", "pdf",
];
/// `ATTACHABLE_MAX_BYTES`
const MAX_BYTES: u64 = 50 * 1024 * 1024;
/// `ATTACHABLE_IMAGE_MAX_BYTES`
const IMAGE_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// `ATTACHMENT_READ_MAX_CHARS`
const READ_MAX_CHARS: f64 = 48_000.0;
/// text kept by path (`textCache`), oldest dropped first
const TEXT_CACHE_SIZE: usize = 8;
const WEEK_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// The module state of `ai-attachments.ts`
#[derive(Default)]
pub(super) struct AttachState {
    /// `textCache`: path, `mtimeMs:size`, text, in insertion order
    text_cache: Vec<(String, String, String)>,
    /// `pastedImageSeq`
    pasted_seq: u64,
    /// `pastedDirPruned`
    pasted_pruned: bool,
}

/// `tm(key)` of `ATTACH_STRINGS`
fn tm(lang: Lang, key: &str) -> &'static str {
    let ko = lang == Lang::Ko;
    match key {
        "dlgAddAttachment" if ko => "첨부 파일 추가",
        "dlgAddAttachment" => "Add Attachments",
        "filterSupported" if ko => "지원되는 파일",
        "filterSupported" => "Supported Files",
        "filterAll" if ko => "모든 파일",
        "filterAll" => "All Files",
        "errUnsupportedExt" if ko => ".{ext} 형식은 지원되지 않습니다",
        "errUnsupportedExt" => ".{ext} files are not supported",
        "errNotFile" if ko => "파일이 아닙니다",
        "errNotFile" => "not a file",
        "errTooLarge" if ko => "{mb}MB 제한을 초과했습니다",
        "errTooLarge" => "exceeds the {mb}MB limit",
        "errImageTooLarge" if ko => "이미지가 5MB 제한을 초과했습니다",
        "errImageTooLarge" => "image exceeds the 5MB limit",
        "errUnreadable" if ko => "읽을 수 없습니다",
        "errUnreadable" => "cannot be read",
        "errFileTooLarge" if ko => "파일이 크기 제한을 초과했습니다",
        "errFileTooLarge" => "File exceeds the size limit",
        "errParseFailed" if ko => "파일을 분석하지 못했습니다",
        "errParseFailed" => "Failed to parse file",
        "errImageNoText" if ko => {
            "이미지 첨부 파일은 텍스트를 제공하지 않으며, 이미지 형태로 사용자 메시지와 함께 전송되므로 이미지를 직접 확인하면 됩니다"
        }
        "errImageNoText" => {
            "Image attachments have no text; the image is sent along with the user message"
        }
        "errNotImage" if ko => "지원되지 않는 이미지 형식입니다",
        "errNotImage" => "not a supported image type",
        _ => unreachable!("an ATTACH_STRINGS key"),
    }
}

fn is_image(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}

/// `attachableMaxBytes(ext)`
fn attachable_max_bytes(ext: &str) -> f64 {
    let clean = ext.strip_prefix('.').unwrap_or(ext).to_lowercase();
    if is_image(&clean) {
        IMAGE_MAX_BYTES as f64
    } else if SIZE_FREE_EXTS.contains(&clean.as_str()) {
        f64::INFINITY
    } else {
        MAX_BYTES as f64
    }
}

/// `diagramPictureExtOfName(fileName)`
fn diagram_picture_ext_of_name(name: &str) -> Option<&'static str> {
    let name = name.to_lowercase();
    if name.ends_with(".drawio.svg") {
        Some("drawio.svg")
    } else if name.ends_with(".drawio.png") {
        Some("drawio.png")
    } else {
        None
    }
}

/// `extOf(name)`
fn ext_of(name: &str) -> String {
    name.rsplit_once('.')
        .map_or(String::new(), |(_, ext)| ext.to_lowercase())
}

fn rejected(reason: &str) -> IpcValue {
    object(vec![
        ("accepted", IpcValue::Array(Vec::new())),
        ("rejected", vec![reason.into_ipc()].into_ipc()),
    ])
}

/// `Number(v)` of what a renderer sends
fn js_number(v: &IpcValue) -> f64 {
    match v {
        IpcValue::Number(n) => *n,
        IpcValue::Null => 0.0,
        IpcValue::Bool(b) => f64::from(u8::from(*b)),
        IpcValue::String(s) => jscompat::to_number(s),
        IpcValue::Date(ms) => *ms,
        _ => f64::NAN,
    }
}

/// `Math.floor(n) || fallback`
fn floor_or(n: f64, fallback: f64) -> f64 {
    let n = n.floor();
    if n == 0.0 || n.is_nan() { fallback } else { n }
}

/// What `savePastedImage` ended with
enum Pasted {
    Saved(String),
    TooLarge,
    NotImage,
}

impl Epub {
    /// `diagramPictureExtOf(filePath)`
    fn diagram_picture_ext_of(&self, path: &str) -> Option<&'static str> {
        let ext = diagram_picture_ext_of_name(&basename(path, None))?;
        match fs::metadata(namespaced(path)) {
            Ok(meta) if meta.len() <= MAX_BYTES => {
                self.engine.picture_holds_diagram(path).then_some(ext)
            }
            _ => Some(ext),
        }
    }

    /// `statAttachment(filePath)`
    fn stat_attachment(&self, path: &str) -> Result<IpcValue, String> {
        let lang = self.lang();
        let name = basename(path, None);
        let ext = self
            .diagram_picture_ext_of(path)
            .map_or_else(|| ext_of(&name), str::to_owned);
        if !ATTACHABLE_EXTS.contains(&ext.as_str()) {
            return Err(format!(
                "{name}: {}",
                tm(lang, "errUnsupportedExt").replace("{ext}", &ext)
            ));
        }
        let Ok(meta) = fs::metadata(namespaced(path)) else {
            return Err(format!("{name}: {}", tm(lang, "errUnreadable")));
        };
        if !meta.is_file() {
            return Err(format!("{name}: {}", tm(lang, "errNotFile")));
        }
        let size = meta.len() as f64;
        if !is_image(&ext) && size > attachable_max_bytes(&ext) {
            let mb = (MAX_BYTES / 1024 / 1024).to_string();
            return Err(format!(
                "{name}: {}",
                tm(lang, "errTooLarge").replace("{mb}", &mb)
            ));
        }
        if is_image(&ext) && size > IMAGE_MAX_BYTES as f64 {
            return Err(format!("{name}: {}", tm(lang, "errImageTooLarge")));
        }
        Ok(object(vec![
            ("path", path.into_ipc()),
            ("name", name.into_ipc()),
            ("ext", ext.into_ipc()),
            ("sizeBytes", size.into_ipc()),
        ]))
    }

    /// `collectAttachments(paths)`
    pub(super) fn collect_attachments(&self, paths: &[IpcValue]) -> IpcValue {
        let mut accepted = Vec::new();
        let mut rejected = Vec::new();
        for path in paths {
            let Some(path) = kit::as_str(path).filter(|p| !p.is_empty()) else {
                continue;
            };
            match self.stat_attachment(path) {
                Ok(meta) => accepted.push(meta),
                Err(error) => rejected.push(error.into_ipc()),
            }
        }
        object(vec![
            ("accepted", IpcValue::Array(accepted)),
            ("rejected", IpcValue::Array(rejected)),
        ])
    }

    /// `epub:files-pick`
    pub(super) fn files_pick(&self, view: ViewId) -> IpcValue {
        let lang = self.lang();
        let strings = |items: &[&str]| {
            JsonValue::Array(
                items
                    .iter()
                    .map(|s| JsonValue::String((*s).into()))
                    .collect(),
            )
        };
        let filter = |name: &str, exts: &[&str]| {
            JsonValue::Object(js_object(vec![
                ("name", JsonValue::String(name.into())),
                ("extensions", strings(exts)),
            ]))
        };
        let options = js_object(vec![
            (
                "title",
                JsonValue::String(tm(lang, "dlgAddAttachment").into()),
            ),
            (
                "filters",
                JsonValue::Array(vec![
                    filter(tm(lang, "filterSupported"), &ATTACHABLE_EXTS),
                    filter(tm(lang, "filterAll"), &["*"]),
                ]),
            ),
            ("properties", strings(&["openFile", "multiSelections"])),
        ]);
        let parent = self.parent(view);
        let result = show_open_dialog_with_memory(
            &mut self.state.borrow_mut().dialog_memory,
            &mut DialogAdapter(&*self.dialogs),
            parent.as_ref(),
            &options,
            None,
        );
        let JsonValue::Object(result) = result else {
            return IpcValue::Null;
        };
        let paths: Vec<IpcValue> = match result.get("filePaths") {
            Some(JsonValue::Array(paths)) => paths
                .iter()
                .filter_map(|p| match p {
                    JsonValue::String(p) => Some(p.as_str().into_ipc()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        if result.get("canceled").is_some_and(JsonValue::truthy) || paths.is_empty() {
            return IpcValue::Null;
        }
        self.collect_attachments(&paths)
    }

    /// `prunePastedImages(dir)`: pictures older than a week go, once per run
    fn prune_pasted_images(&self, dir: &str) {
        {
            let mut state = self.state.borrow_mut();
            if state.attach.pasted_pruned {
                return;
            }
            state.attach.pasted_pruned = true;
        }
        let cutoff = now_ms() - WEEK_MS;
        // the folder may not exist yet; another tab may have removed a file already
        let Ok(entries) = fs::read_dir(namespaced(dir)) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(meta) = fs::metadata(&path)
                && StatInfo::of(&meta).mtime_ms < cutoff
            {
                let _ = fs::remove_file(&path);
            }
        }
    }

    /// `savePastedImage(data, ext)`; `Err` is what the file system threw
    fn save_pasted_image(&self, data: &IpcValue, ext: &IpcValue) -> Result<Pasted, IpcError> {
        let clean = kit::as_str(ext).map(str::to_lowercase).unwrap_or_default();
        if !is_image(&clean) {
            return Ok(Pasted::NotImage);
        }
        let Some(bytes) = kit::as_bytes(data).filter(|b| !b.is_empty()) else {
            return Ok(Pasted::NotImage);
        };
        // the renderer decides what lands on disk here: the picture limit applies before anything is written
        if bytes.len() as u64 > IMAGE_MAX_BYTES {
            return Ok(Pasted::TooLarge);
        }
        let dir = join(&[
            &self.services.paths.path(PathName::Temp).to_string_lossy(),
            "seuoffice-pasted",
        ]);
        fs::create_dir_all(namespaced(&dir))
            .map_err(|e| kit::error(node_error(&e, "mkdir", &dir).message))?;
        self.prune_pasted_images(&dir);
        let iso = jscompat::to_iso_string(now_ms()).unwrap_or_default();
        let stamp = iso
            .chars()
            .take(19)
            .filter(|c| *c != '-' && *c != ':')
            .collect::<String>()
            .replacen('T', "-", 1);
        let seq = {
            let mut state = self.state.borrow_mut();
            state.attach.pasted_seq += 1;
            state.attach.pasted_seq
        };
        let path = join(&[&dir, &format!("pasted-{stamp}-{seq}.{clean}")]);
        fs::write(namespaced(&path), bytes)
            .map_err(|e| kit::error(node_error(&e, "open", &path).message))?;
        Ok(Pasted::Saved(path))
    }

    /// `epub:files-add-pasted-image`
    pub(super) fn files_add_pasted_image(
        &self,
        data: &IpcValue,
        ext: &IpcValue,
    ) -> Result<IpcValue, IpcError> {
        let lang = self.lang();
        Ok(match self.save_pasted_image(data, ext)? {
            Pasted::TooLarge => rejected(tm(lang, "errImageTooLarge")),
            Pasted::NotImage => rejected(tm(lang, "errNotImage")),
            Pasted::Saved(path) => self.collect_attachments(&[path.into_ipc()]),
        })
    }

    /// `readAttachmentPage(filePath, offset, maxChars)`
    pub(super) fn read_attachment_page(self: &std::rc::Rc<Self>, args: Args, reply: Responder) {
        let lang = self.lang();
        let fail =
            |error: &str| object(vec![("ok", false.into_ipc()), ("error", error.into_ipc())]);
        let Some(path) = args.str(0).filter(|p| !p.is_empty()).map(str::to_owned) else {
            return reply.reply(Ok(fail(tm(lang, "errUnreadable"))));
        };
        let name = basename(&path, None);
        let ext = self
            .diagram_picture_ext_of(&path)
            .map_or_else(|| ext_of(&name), str::to_owned);
        if !ATTACHABLE_EXTS.contains(&ext.as_str()) {
            return reply.reply(Ok(fail(
                &tm(lang, "errUnsupportedExt").replace("{ext}", &ext),
            )));
        }
        if is_image(&ext) {
            return reply.reply(Ok(fail(tm(lang, "errImageNoText"))));
        }
        let offset = js_number(args.get(1));
        let max_chars = js_number(args.get(2));
        self.attachment_text(path, move |text| {
            reply.reply(Ok(match text {
                Err(error) => fail(&error),
                Ok(text) => {
                    let units: Vec<u16> = text.encode_utf16().collect();
                    let start = floor_or(offset, 0.0).max(0.0);
                    // floor_or never answers NaN, so clamp cannot panic
                    let size = floor_or(max_chars, 1.0).clamp(1.0, READ_MAX_CHARS);
                    let at = start.min(units.len() as f64) as usize;
                    let end = (start + size).min(units.len() as f64) as usize;
                    object(vec![
                        ("ok", true.into_ipc()),
                        ("name", name.into_ipc()),
                        ("totalChars", (units.len() as f64).into_ipc()),
                        ("offset", start.into_ipc()),
                        ("text", slice16(&units, at, end).into_ipc()),
                    ])
                }
            }))
        });
    }

    /// `attachmentText(filePath)`: from the cache while the file keeps its
    /// time and size, else parsed on a worker
    fn attachment_text(
        self: &std::rc::Rc<Self>,
        path: String,
        then: impl FnOnce(Result<String, String>) + 'static,
    ) {
        let lang = self.lang();
        // a file open with unsaved changes is not read (before the cache): a
        // withholding mark only reaches the file on save
        let mut holder = OpenFilesHolder::new();
        if let Some(files) = self.shell.open_files() {
            holder.set_open_files_source(Some(Box::new(move || {
                files.clone().map_err(|()| {
                    main_core::packages::electron_utils::unsaved_files::OpenFilesSourceFailed
                })
            })));
        }
        if let Err(message) = assert_file_saved(&holder, &path) {
            return then(Err(message.to_owned()));
        }
        let meta = match fs::metadata(namespaced(&path)) {
            Ok(meta) => meta,
            Err(e) => return then(Err(node_error(&e, "stat", &path).message)),
        };
        let info = StatInfo::of(&meta);
        let stamp = format!(
            "{}:{}",
            jscompat::number_to_string(info.mtime_ms),
            info.size
        );
        let cached = self
            .state
            .borrow()
            .attach
            .text_cache
            .iter()
            .find(|(p, s, _)| *p == path && *s == stamp)
            .map(|(_, _, text)| text.clone());
        if let Some(text) = cached {
            return then(Ok(text));
        }
        let cap_ext =
            diagram_picture_ext_of_name(&path).map_or_else(|| extname(&path), str::to_owned);
        if info.size as f64 > attachable_max_bytes(&cap_ext) {
            return then(Err(tm(lang, "errFileTooLarge").to_owned()));
        }
        let engine = self.engine.clone();
        let epub = self.clone();
        let parse_path = path.clone();
        kit::on_worker(
            &self.services,
            move || engine.parse_file_to_text(&parse_path),
            move |parsed| match parsed {
                Err(error) => then(Err(
                    error.unwrap_or_else(|| tm(lang, "errParseFailed").to_owned())
                )),
                Ok(text) => {
                    {
                        let mut state = epub.state.borrow_mut();
                        let cache = &mut state.attach.text_cache;
                        // Map.set keeps an existing key where it was
                        match cache.iter_mut().find(|(p, _, _)| *p == path) {
                            Some(entry) => *entry = (path, stamp, text.clone()),
                            None => cache.push((path, stamp, text.clone())),
                        }
                        if cache.len() > TEXT_CACHE_SIZE {
                            cache.remove(0);
                        }
                    }
                    then(Ok(text))
                }
            },
        );
    }

    /// `readAttachmentImage(filePath)`
    pub(super) fn read_attachment_image(&self, file_path: &IpcValue) -> IpcValue {
        let lang = self.lang();
        let path = kit::as_str(file_path).unwrap_or("");
        let name = basename(path, None);
        let mime = match ext_of(&name).as_str() {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "webp" => Some("image/webp"),
            _ => None,
        };
        let fail = |key: &str| {
            object(vec![
                ("ok", false.into_ipc()),
                ("error", format!("{name}: {}", tm(lang, key)).into_ipc()),
            ])
        };
        let Some(mime) = mime.filter(|_| !path.is_empty()) else {
            return fail("errNotImage");
        };
        let read = fs::metadata(namespaced(path)).and_then(|meta| {
            if meta.len() > IMAGE_MAX_BYTES {
                return Ok(None);
            }
            fs::read(namespaced(path)).map(Some)
        });
        match read {
            Ok(Some(bytes)) => object(vec![
                ("ok", true.into_ipc()),
                ("base64", jscompat::base64(&bytes).into_ipc()),
                ("mime", mime.into_ipc()),
            ]),
            Ok(None) => fail("errImageTooLarge"),
            Err(_) => fail("errUnreadable"),
        }
    }
}
