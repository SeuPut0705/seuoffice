//! The chat attachments of `html-main.ts` (`statAttachment`,
//! `collectAttachments`, `savePastedImage`, `prunePastedImages`,
//! `extractAttachmentText`, `attachmentTextCache`) and the attachable-format
//! list of `packages/file-parse/src/attachable.ts`, whose constants are
//! ported here; reading a document's text stays in [`super::HtmlEngine`].

use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, SystemTime};

use jscompat::node_path::host::{basename, extname, join};
use shell_contract::IpcValue;
use shell_contract::runtime::{PathName, Services};

use super::text_doc::{dialog_options, tr};
use super::{HtmlEditors, HtmlEngineHost};
use crate::kit::{self, Entry, IntoIpc, obj};

/// plain-text extensions read as UTF-8 (`TEXT_EXTS`)
const TEXT_EXTS: [&str; 27] = [
    "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log",
    "js", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp", "go", "rs", "rb", "sh", "sql", "css",
];
/// pictures sent to the model as pictures (`ATTACHABLE_IMAGE_EXTS`)
const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
/// documents whose text the parser extracts, then draw.io diagrams
const DOC_EXTS: [&str; 17] = [
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
];
/// formats read at any size (`SIZE_FREE_EXTS`)
const SIZE_FREE_EXTS: [&str; 9] = [
    "docx", "pptx", "xlsx", "xlsm", "hwpx", "odt", "epub", "xmind", "pdf",
];
/// `ATTACHABLE_MAX_BYTES`
const MAX_BYTES: f64 = 50.0 * 1024.0 * 1024.0;
/// `ATTACHABLE_IMAGE_MAX_BYTES`
const IMAGE_MAX_BYTES: f64 = 5.0 * 1024.0 * 1024.0;
/// pasted pictures older than this are swept once per run
const PASTED_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// the cached extracted texts
const TEXT_CACHE_SIZE: usize = 8;
/// the most text one read returns
const READ_MAX_CHARS: f64 = 48_000.0;

/// `ATTACHABLE_EXTS` in its insertion order (the open dialog's filter)
fn attachable_exts() -> Vec<&'static str> {
    TEXT_EXTS
        .iter()
        .chain(DOC_EXTS.iter())
        .chain(IMAGE_EXTS.iter())
        .copied()
        .collect()
}

fn is_attachable(ext: &str) -> bool {
    TEXT_EXTS.contains(&ext) || DOC_EXTS.contains(&ext) || IMAGE_EXTS.contains(&ext)
}

fn is_image(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}

/// `attachableMaxBytes(ext)`
fn attachable_max_bytes(ext: &str) -> f64 {
    let clean = ext.strip_prefix('.').unwrap_or(ext).to_lowercase();
    if is_image(&clean) {
        IMAGE_MAX_BYTES
    } else if SIZE_FREE_EXTS.contains(&clean.as_str()) {
        f64::INFINITY
    } else {
        MAX_BYTES
    }
}

/// `diagramPictureExtOfName(fileName)`
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

/// `name.split('.').pop()?.toLowerCase()`
fn last_ext(name: &str) -> String {
    name.rsplit('.').next().unwrap_or_default().to_lowercase()
}

/// The words of the attachment messages (the `err*` keys of `tDlg`)
struct Words(String);

impl Words {
    fn t(&self, en: &str, ko: &str) -> String {
        tr(&self.0, en, ko)
    }
    fn unsupported(&self, ext: &str) -> String {
        tr(
            &self.0,
            &format!(".{ext} files are not supported"),
            &format!(".{ext} 형식은 지원되지 않습니다"),
        )
    }
    fn not_file(&self) -> String {
        self.t("not a file", "파일이 아닙니다")
    }
    fn too_large(&self) -> String {
        let mb = (MAX_BYTES / 1024.0 / 1024.0).round();
        tr(
            &self.0,
            &format!("exceeds the {mb}MB limit"),
            &format!("{mb}MB 제한을 초과했습니다"),
        )
    }
    fn image_too_large(&self) -> String {
        self.t(
            "image exceeds the 5MB limit",
            "이미지가 5MB 제한을 초과했습니다",
        )
    }
    fn unreadable(&self) -> String {
        self.t("cannot be read", "읽을 수 없습니다")
    }
    fn not_image(&self) -> String {
        self.t(
            "not a supported image type",
            "지원되지 않는 이미지 형식입니다",
        )
    }
}

/// `statAttachment(filePath)`: the meta of an attachable file, or why not
fn stat_attachment(
    engine: &HtmlEngineHost,
    words: &Words,
    file_path: &str,
) -> Result<IpcValue, String> {
    let name = basename(file_path, None);
    // a draw.io picture that holds its diagram is read as diagram text
    let ext = engine
        .diagram_picture_ext_of(Path::new(file_path))
        .unwrap_or_else(|| last_ext(&name));
    if !is_attachable(&ext) {
        return Err(format!("{name}: {}", words.unsupported(&ext)));
    }
    let Ok(stat) = std::fs::metadata(file_path) else {
        return Err(format!("{name}: {}", words.unreadable()));
    };
    if !stat.is_file() {
        return Err(format!("{name}: {}", words.not_file()));
    }
    let size = stat.len() as f64;
    if !is_image(&ext) && size > attachable_max_bytes(&ext) {
        return Err(format!("{name}: {}", words.too_large()));
    }
    if is_image(&ext) && size > IMAGE_MAX_BYTES {
        return Err(format!("{name}: {}", words.image_too_large()));
    }
    Ok(obj([
        ("path", file_path.into_ipc()),
        ("name", name.into_ipc()),
        ("ext", ext.into_ipc()),
        ("sizeBytes", size.into_ipc()),
    ]))
}

/// `collectAttachments(paths)`
fn collect_attachments(engine: &HtmlEngineHost, lang: String, paths: &[String]) -> IpcValue {
    let words = Words(lang);
    let (mut accepted, mut rejected) = (Vec::new(), Vec::new());
    for p in paths {
        match stat_attachment(engine, &words, p) {
            Ok(meta) => accepted.push(meta),
            Err(error) => rejected.push(error.into_ipc()),
        }
    }
    obj([
        ("accepted", IpcValue::Array(accepted)),
        ("rejected", IpcValue::Array(rejected)),
    ])
}

/// `Number(v)` for the numbers a renderer passes
fn to_number(v: &IpcValue) -> f64 {
    match v {
        IpcValue::Number(n) => *n,
        IpcValue::Bool(b) => f64::from(u8::from(*b)),
        IpcValue::Null => 0.0,
        IpcValue::String(s) => {
            let t = jscompat::trim(s);
            if t.is_empty() {
                0.0
            } else {
                t.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

/// `Math.floor(n) || fallback`
fn floor_or(n: f64, fallback: f64) -> f64 {
    let f = n.floor();
    if f == 0.0 || f.is_nan() { fallback } else { f }
}

/// Node's `ERR_INVALID_ARG_TYPE` for a path that is not a string
fn path_type_error(v: &IpcValue) -> shell_contract::IpcError {
    let received = match v {
        IpcValue::Undefined => "undefined".to_owned(),
        IpcValue::Null => "null".to_owned(),
        IpcValue::Number(n) => format!("type number ({})", jscompat::number_to_string(*n)),
        IpcValue::Bool(b) => format!("type boolean ({b})"),
        IpcValue::Array(_) => "an instance of Array".to_owned(),
        _ => "an instance of Object".to_owned(),
    };
    kit::named_error(
        "TypeError",
        format!("The \"path\" argument must be of type string. Received {received}"),
    )
}

/// The cached texts by path, oldest first (`attachmentTextCache`)
#[derive(Default)]
struct TextCache(Vec<(String, String, String)>);

impl TextCache {
    fn get(&self, path: &str, stamp: &str) -> Option<String> {
        self.0
            .iter()
            .find(|(p, s, _)| p == path && s == stamp)
            .map(|(_, _, t)| t.clone())
    }

    fn set(&mut self, path: &str, stamp: String, text: String) {
        match self.0.iter_mut().find(|(p, ..)| p == path) {
            Some(entry) => {
                entry.1 = stamp;
                entry.2 = text;
            }
            None => self.0.push((path.to_owned(), stamp, text)),
        }
        if self.0.len() > TEXT_CACHE_SIZE {
            self.0.remove(0);
        }
    }
}

fn mtime_ms(stat: &std::fs::Metadata) -> f64 {
    stat.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// the pasted-image state: the sequence and the once-per-run sweep
#[derive(Default)]
struct Pasted {
    seq: Cell<u64>,
    pruned: Cell<bool>,
}

/// `prunePastedImages(dir)`: pasted files older than seven days go
fn prune_pasted(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let cutoff = SystemTime::now()
        .checked_sub(PASTED_MAX_AGE)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for entry in entries.flatten() {
        // another tab may have removed it already
        if entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| t < cutoff)
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// `new Date().toISOString().slice(0, 19)` without `-` and `:`, `T` as `-`
fn paste_stamp() -> String {
    let iso = jscompat::to_iso_string(crate::text_recovery::ui::now_ms()).unwrap_or_default();
    iso.chars()
        .take(19)
        .filter(|c| *c != '-' && *c != ':')
        .map(|c| if c == 'T' { '-' } else { c })
        .collect()
}

pub(super) fn entries(
    services: &Services,
    editors: &Rc<HtmlEditors>,
    engine: HtmlEngineHost,
) -> Vec<Entry> {
    let mut out = Vec::new();
    let cache: Rc<RefCell<TextCache>> = Rc::default();
    let pasted: Rc<Pasted> = Rc::default();

    let (e, en, sv) = (Rc::clone(editors), engine.clone(), services.clone());
    out.push(kit::invoke_later(
        "html:files-pick",
        move |cx, _, responder| {
            let lang = e.docs.lang();
            let picked = e.docs.open_dialog(
                cx.sender.view,
                dialog_options(
                    Some(tr(&lang, "Add Attachments", "첨부 파일 추가")),
                    None,
                    &[
                        (
                            tr(&lang, "Supported Files", "지원되는 파일"),
                            attachable_exts(),
                        ),
                        (tr(&lang, "All Files", "모든 파일"), vec!["*"]),
                    ],
                    &["openFile", "multiSelections"],
                ),
                None,
            );
            let Some(paths) = picked.filter(|p| !p.is_empty()) else {
                return responder.reply(Ok(IpcValue::Null));
            };
            let en = en.clone();
            kit::on_worker(
                &sv,
                move || collect_attachments(&en, lang, &paths),
                move |result| responder.reply(Ok(result)),
            );
        },
    ));

    let (e, en, sv) = (Rc::clone(editors), engine.clone(), services.clone());
    out.push(kit::invoke_later(
        "html:files-add",
        move |_, args, responder| {
            let paths: Vec<String> = match args.get(0) {
                IpcValue::Array(items) => items
                    .iter()
                    .filter_map(|p| kit::as_str(p).map(str::to_owned))
                    .collect(),
                _ => Vec::new(),
            };
            let (en, lang) = (en.clone(), e.docs.lang());
            kit::on_worker(
                &sv,
                move || collect_attachments(&en, lang, &paths),
                move |result| responder.reply(Ok(result)),
            );
        },
    ));

    let (e, en, sv, ps) = (
        Rc::clone(editors),
        engine.clone(),
        services.clone(),
        Rc::clone(&pasted),
    );
    out.push(kit::invoke_later(
        "html:files-add-pasted-image",
        move |_, args, responder| {
            let lang = e.docs.lang();
            let ext = args.str(1).map(str::to_lowercase).unwrap_or_default();
            let bytes = args
                .bytes(0)
                .filter(|b| !b.is_empty() && is_image(&ext))
                .map(<[u8]>::to_vec);
            let Some(bytes) = bytes else {
                return responder.reply(Ok(obj([
                    ("accepted", IpcValue::Array(Vec::new())),
                    (
                        "rejected",
                        IpcValue::Array(vec![Words(lang).not_image().into_ipc()]),
                    ),
                ])));
            };
            let dir = PathBuf::from(join(&[
                &sv.paths.path(PathName::Temp).to_string_lossy(),
                "seuoffice-pasted",
            ]));
            let prune = !ps.pruned.replace(true);
            ps.seq.set(ps.seq.get() + 1);
            let name = format!("pasted-{}-{}.{ext}", paste_stamp(), ps.seq.get());
            let en = en.clone();
            kit::on_worker(
                &sv,
                move || {
                    if let Err(error) = std::fs::create_dir_all(&dir) {
                        return Err(error.to_string());
                    }
                    if prune {
                        prune_pasted(&dir);
                    }
                    let path = dir.join(name).to_string_lossy().into_owned();
                    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
                    Ok(collect_attachments(&en, lang, &[path]))
                },
                move |result| responder.reply(result.map_err(kit::error)),
            );
        },
    ));

    let (e, en, sv, ca) = (
        Rc::clone(editors),
        engine.clone(),
        services.clone(),
        Rc::clone(&cache),
    );
    out.push(kit::invoke_later("html:files-read", move |_, args, responder| {
        let Some(file_path) = args.str(0).map(str::to_owned) else {
            return responder.reply(Err(path_type_error(args.get(0))));
        };
        let words = Words(e.docs.lang());
        let name = basename(&file_path, None);
        let ext = en
            .diagram_picture_ext_of(Path::new(&file_path))
            .unwrap_or_else(|| last_ext(&name));
        let fail = |error: String| obj([("ok", false.into_ipc()), ("error", error.into_ipc())]);
        if !is_attachable(&ext) {
            return responder.reply(Ok(fail(words.unsupported(&ext))));
        }
        if is_image(&ext) {
            return responder.reply(Ok(fail(words.t(
                "Image attachments have no text; the image is sent along with the user message",
                "이미지 첨부 파일은 텍스트를 제공하지 않으며, 이미지 형태로 사용자 메시지와 함께 전송되므로 이미지를 직접 확인하면 됩니다",
            ))));
        }
        // a file open with unsaved changes is not read (before the cache): a
        // withholding mark only reaches the file on save
        if let Err(error) = e.shell.assert_file_saved(&file_path) {
            return responder.reply(Ok(fail(error)));
        }
        let stat = match std::fs::metadata(&file_path) {
            Ok(stat) => stat,
            Err(error) => {
                let message = main_core::node_fs::node_error(&error, "stat", &file_path).message;
                return responder.reply(Ok(fail(message)));
            }
        };
        let size = stat.len() as f64;
        let stamp = format!(
            "{}:{}",
            jscompat::number_to_string(mtime_ms(&stat)),
            jscompat::number_to_string(size)
        );
        let (offset, max_chars) = (to_number(args.get(1)), to_number(args.get(2)));
        let slice = move |text: &str| {
            let start = floor_or(offset, 0.0).max(0.0);
            let size = floor_or(max_chars, 1.0).clamp(1.0, READ_MAX_CHARS);
            obj([
                ("ok", true.into_ipc()),
                ("name", name.clone().into_ipc()),
                ("totalChars", (text.encode_utf16().count() as f64).into_ipc()),
                ("offset", start.into_ipc()),
                ("text", jscompat::slice_utf16(text, start, Some(start + size)).into_ipc()),
            ])
        };
        if let Some(text) = ca.borrow().get(&file_path, &stamp) {
            return responder.reply(Ok(slice(&text)));
        }
        let cap_ext = diagram_picture_ext_of_name(&file_path)
            .map(str::to_owned)
            .unwrap_or_else(|| extname(&file_path));
        if size > attachable_max_bytes(&cap_ext) {
            return responder.reply(Ok(fail(words.t(
                "File exceeds the size limit",
                "파일이 크기 제한을 초과했습니다",
            ))));
        }
        let (en, ca) = (en.clone(), Rc::clone(&ca));
        let path = file_path.clone();
        kit::on_worker(
            &sv,
            move || en.parse_file_to_text(Path::new(&path)),
            move |parsed| {
                let text = match parsed {
                    p if p.ok && p.kind.as_deref() == Some("text") && p.text.is_some() => {
                        p.text.unwrap_or_default()
                    }
                    p => {
                        let error = p.error.filter(|e| !p.damaged && !e.is_empty()).unwrap_or_else(|| {
                            words.t("Failed to parse file", "파일을 분석하지 못했습니다")
                        });
                        return responder.reply(Ok(fail(error)));
                    }
                };
                ca.borrow_mut().set(&file_path, stamp, text.clone());
                responder.reply(Ok(slice(&text)))
            },
        );
    }));

    let (e, sv) = (Rc::clone(editors), services.clone());
    out.push(kit::invoke_later(
        "html:files-read-image",
        move |_, args, responder| {
            let Some(file_path) = args.str(0).map(str::to_owned) else {
                return responder.reply(Err(path_type_error(args.get(0))));
            };
            let words = Words(e.docs.lang());
            let name = basename(&file_path, None);
            let mime = match last_ext(&name).as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                _ => {
                    return responder.reply(Ok(obj([
                        ("ok", false.into_ipc()),
                        ("error", format!("{name}: {}", words.not_image()).into_ipc()),
                    ])));
                }
            };
            kit::on_worker(
                &sv,
                move || {
                    let fail = |error: String| {
                        obj([
                            ("ok", false.into_ipc()),
                            ("error", format!("{name}: {error}").into_ipc()),
                        ])
                    };
                    let Ok(stat) = std::fs::metadata(&file_path) else {
                        return fail(words.unreadable());
                    };
                    if stat.len() as f64 > IMAGE_MAX_BYTES {
                        return fail(words.image_too_large());
                    }
                    match std::fs::read(&file_path) {
                        Ok(bytes) => obj([
                            ("ok", true.into_ipc()),
                            ("base64", jscompat::base64(&bytes).into_ipc()),
                            ("mime", mime.into_ipc()),
                        ]),
                        Err(_) => fail(words.unreadable()),
                    }
                },
                move |result| responder.reply(Ok(result)),
            );
        },
    ));
    out
}
