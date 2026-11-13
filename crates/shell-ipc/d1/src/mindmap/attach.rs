//! `ai-attachments.ts` and the fetch of `ai-image.ts`: the AI panel's
//! attachments, the provisional name of an untitled map, and a picture by
//! address.

use std::fs;
use std::time::{Duration, UNIX_EPOCH};

use jscompat::node_path::host::{basename, extname, join};
use jscompat::{JsObject, JsonValue, base64, to_iso_string};
use main_core::node_fs::node_error;
use main_core::packages::electron_utils::dialog_memory::show_open_dialog_with_memory;
use main_core::packages::electron_utils::fetch_image_bytes::fetch_image_bytes;
use shell_contract::IpcValue;
use shell_contract::ipc::Responder;
use shell_contract::runtime::PathName;

use super::app::{MindmapApp, now_ms};
use super::text::attach_text;
use super::util::{js_number, one_line, slice, utf16_len};
use crate::host::{HostDialog, path_string};
use crate::route::{self, Route};
use crate::value::{Args, as_bytes, num, obj, string, thrown};

/// The most characters one read hands back; the panel asks for less
const READ_MAX_CHARS: f64 = 48_000.0;
const TEXT_CACHE_SIZE: usize = 8;

const IMAGE_MIME: [(&str, &str); 5] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];

fn ext_of(name: &str) -> String {
    if name.contains('.') {
        name.rsplit('.').next().unwrap_or("").to_lowercase()
    } else {
        String::new()
    }
}

impl MindmapApp {
    fn at(&self, key: &str, vars: &[(&str, String)]) -> String {
        attach_text(self.lang(), key, vars)
    }

    /// the extension a file is judged by: a draw.io picture that holds its
    /// diagram is read as diagram text
    fn attachment_ext(&self, path: &str, name: &str) -> String {
        self.0
            .parse
            .diagram_picture_ext_of(path)
            .unwrap_or_else(|| ext_of(name))
    }

    /// `statAttachment`
    fn stat_attachment(&self, path: &str) -> Result<IpcValue, String> {
        let name = basename(path, None);
        let ext = self.attachment_ext(path, &name);
        let parse = &self.0.parse;
        if !parse.attachable_exts().contains(&ext) {
            return Err(format!(
                "{name}: {}",
                self.at("errUnsupportedExt", &[("ext", ext)])
            ));
        }
        let Ok(meta) = fs::metadata(path) else {
            return Err(format!("{name}: {}", self.at("errUnreadable", &[])));
        };
        if !meta.is_file() {
            return Err(format!("{name}: {}", self.at("errNotFile", &[])));
        }
        let size = meta.len();
        let is_image = parse.attachable_image_exts().contains(&ext);
        if !is_image && size > parse.attachable_max_bytes(&ext) {
            let mb = (parse.attachable_max_bytes_default() as f64 / 1024.0 / 1024.0 + 0.5).floor();
            return Err(format!(
                "{name}: {}",
                self.at("errTooLarge", &[("mb", format!("{mb}"))])
            ));
        }
        if is_image && size > parse.attachable_image_max_bytes() {
            return Err(format!("{name}: {}", self.at("errImageTooLarge", &[])));
        }
        Ok(obj([
            ("path", string(path)),
            ("name", string(name)),
            ("ext", string(ext)),
            ("sizeBytes", num(size as f64)),
        ]))
    }

    /// `collectAttachments`: the files that may be attached, with a reason for each that may not
    fn collect_attachments(&self, paths: &[IpcValue]) -> IpcValue {
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
                Err(error) => rejected.push(string(error)),
            }
        }
        obj([
            ("accepted", IpcValue::Array(accepted)),
            ("rejected", IpcValue::Array(rejected)),
        ])
    }

    /// Pasted pictures older than a week are removed, once per run of the app
    fn prune_pasted_images(&self, dir: &str) {
        if std::mem::replace(&mut self.0.state.borrow_mut().pasted_pruned, true) {
            return;
        }
        let cutoff = UNIX_EPOCH
            + Duration::from_millis((now_ms() - 7.0 * 24.0 * 3600.0 * 1000.0).max(0.0) as u64);
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .is_ok_and(|modified| modified < cutoff)
            {
                let _ = fs::remove_file(&path);
            }
        }
    }

    /// `savePastedImage`: a picture pasted from the clipboard goes to a
    /// temporary file; `Ok(Err(()))` is 'too-large', `Ok(Ok(None))` is null
    fn save_pasted_image(
        &self,
        data: &IpcValue,
        ext: &IpcValue,
    ) -> Result<Result<Option<String>, ()>, String> {
        let clean_ext = match ext {
            IpcValue::String(ext) => ext.to_lowercase(),
            _ => String::new(),
        };
        let parse = &self.0.parse;
        if !parse.attachable_image_exts().contains(&clean_ext) {
            return Ok(Ok(None));
        }
        let Some(bytes) = as_bytes(data).filter(|b| !b.is_empty()) else {
            return Ok(Ok(None));
        };
        // the renderer decides what lands on disk here: the picture limit applies before anything is written
        if bytes.len() as u64 > parse.attachable_image_max_bytes() {
            return Ok(Err(()));
        }
        let temp = path_string(self.0.services.paths.path(PathName::Temp));
        let dir = join(&[&temp, "seuoffice-pasted"]);
        fs::create_dir_all(&dir).map_err(|e| node_error(&e, "mkdir", &dir).message)?;
        self.prune_pasted_images(&dir);
        let stamp: String = to_iso_string(now_ms())
            .unwrap_or_default()
            .chars()
            .take(19)
            .filter(|c| *c != '-' && *c != ':')
            .map(|c| if c == 'T' { '-' } else { c })
            .collect();
        let seq = {
            let mut state = self.0.state.borrow_mut();
            state.pasted_seq += 1;
            state.pasted_seq
        };
        let path = join(&[&dir, &format!("pasted-{stamp}-{seq}.{clean_ext}")]);
        fs::write(&path, bytes).map_err(|e| node_error(&e, "open", &path).message)?;
        Ok(Ok(Some(path)))
    }

    fn read_failure(&self, message: String) -> IpcValue {
        obj([("ok", IpcValue::Bool(false)), ("error", string(message))])
    }
}

/// One page of an attachment's text: from `offset`, at most `max_chars`
/// (and never more than 48,000)
fn read_page(name: &str, text: &str, offset: f64, max_chars: f64) -> IpcValue {
    let floor_or = |x: f64, fallback: f64| {
        let x = x.floor();
        if x.is_nan() || x == 0.0 { fallback } else { x }
    };
    let start = floor_or(offset, 0.0).max(0.0);
    let size = floor_or(max_chars, 1.0).clamp(1.0, READ_MAX_CHARS);
    let total = utf16_len(text);
    let from = (start.min(total as f64)) as usize;
    let to = ((start + size).min(total as f64)) as usize;
    obj([
        ("ok", IpcValue::Bool(true)),
        ("name", string(name)),
        ("totalChars", num(total as f64)),
        ("offset", num(start)),
        ("text", string(slice(text, from, to))),
    ])
}

fn files_read(app: &MindmapApp, args: Args, responder: Responder) {
    let path = match args.get(0) {
        IpcValue::String(path) if !path.is_empty() => path.clone(),
        _ => return responder.reply(Ok(app.read_failure(app.at("errUnreadable", &[])))),
    };
    let name = basename(&path, None);
    let parse = &app.0.parse;
    let ext = app.attachment_ext(&path, &name);
    if !parse.attachable_exts().contains(&ext) {
        return responder.reply(Ok(
            app.read_failure(app.at("errUnsupportedExt", &[("ext", ext)]))
        ));
    }
    if parse.attachable_image_exts().contains(&ext) {
        return responder.reply(Ok(app.read_failure(app.at("errImageNoText", &[]))));
    }
    let offset = js_number(args.get(1));
    let max_chars = js_number(args.get(2));
    // a file open with unsaved changes is not read (before the cache): a
    // withholding mark only reaches the file on save
    if let Err(message) = app.0.shell.assert_file_saved(&path) {
        return responder.reply(Ok(app.read_failure(message)));
    }
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(error) => {
            return responder.reply(Ok(
                app.read_failure(node_error(&error, "stat", &path).message)
            ));
        }
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    let stamp = format!("{mtime_ms}:{}", meta.len());
    let cached = app
        .0
        .state
        .borrow()
        .text_cache
        .iter()
        .find(|(cached_path, (cached_stamp, _))| *cached_path == path && *cached_stamp == stamp)
        .map(|(_, (_, text))| text.clone());
    if let Some(text) = cached {
        return responder.reply(Ok(read_page(&name, &text, offset, max_chars)));
    }
    let cap_ext = parse
        .diagram_picture_ext_of_name(&path)
        .unwrap_or_else(|| extname(&path));
    if meta.len() > parse.attachable_max_bytes(&cap_ext) {
        return responder.reply(Ok(app.read_failure(app.at("errFileTooLarge", &[]))));
    }
    let engine = app.0.parse.clone();
    let parse_path = path.clone();
    let lang = app.lang();
    app.offload(
        move || engine.parse_file_to_text(&parse_path),
        move |app, parsed| {
            let text = match (parsed.ok, parsed.kind.as_deref(), parsed.text) {
                (true, Some("text"), Some(text)) => text,
                _ => {
                    let message = match parsed.error {
                        Some(error) if !parsed.damaged && !error.is_empty() => error,
                        _ => attach_text(lang, "errParseFailed", &[]),
                    };
                    return responder.reply(Ok(app.read_failure(message)));
                }
            };
            {
                let mut state = app.0.state.borrow_mut();
                match state.text_cache.iter_mut().find(|(p, _)| *p == path) {
                    Some(entry) => entry.1 = (stamp, text.clone()),
                    None => state.text_cache.push((path, (stamp, text.clone()))),
                }
                if state.text_cache.len() > TEXT_CACHE_SIZE {
                    state.text_cache.remove(0);
                }
            }
            responder.reply(Ok(read_page(&name, &text, offset, max_chars)))
        },
    );
}

fn files_read_image(app: &MindmapApp, args: Args) -> IpcValue {
    let path = args.str(0).unwrap_or("");
    let name = basename(path, None);
    let mime = IMAGE_MIME
        .iter()
        .find(|(ext, _)| *ext == ext_of(&name))
        .map(|(_, mime)| *mime);
    let Some(mime) = mime.filter(|_| !path.is_empty()) else {
        return app.read_failure(format!("{name}: {}", app.at("errNotImage", &[])));
    };
    let Ok(meta) = fs::metadata(path) else {
        return app.read_failure(format!("{name}: {}", app.at("errUnreadable", &[])));
    };
    if meta.len() > app.0.parse.attachable_image_max_bytes() {
        return app.read_failure(format!("{name}: {}", app.at("errImageTooLarge", &[])));
    }
    match fs::read(path) {
        Ok(bytes) => obj([
            ("ok", IpcValue::Bool(true)),
            ("base64", string(base64(&bytes))),
            ("mime", string(mime)),
        ]),
        Err(_) => app.read_failure(format!("{name}: {}", app.at("errUnreadable", &[]))),
    }
}

fn files_pick(app: &MindmapApp, view: shell_contract::ViewId) -> IpcValue {
    let mut options = JsObject::new();
    options.set("title", JsonValue::String(app.at("dlgAddAttachment", &[])));
    let mut supported = JsObject::new();
    supported.set("name", JsonValue::String(app.at("filterSupported", &[])));
    supported.set(
        "extensions",
        JsonValue::Array(
            app.0
                .parse
                .attachable_exts()
                .into_iter()
                .map(JsonValue::String)
                .collect(),
        ),
    );
    let mut all = JsObject::new();
    all.set("name", JsonValue::String(app.at("filterAll", &[])));
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
        JsonValue::Array(vec![
            JsonValue::String("openFile".into()),
            JsonValue::String("multiSelections".into()),
        ]),
    );
    let parent = app.window_of(view);
    let picked = {
        let mut memory = app
            .0
            .shared
            .dialog_memory
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut dialog = HostDialog(&*app.0.dialogs);
        show_open_dialog_with_memory(&mut memory, &mut dialog, parent.as_ref(), &options, None)
    };
    let JsonValue::Object(picked) = &picked else {
        return IpcValue::Null;
    };
    if picked.get("canceled").is_some_and(JsonValue::truthy) {
        return IpcValue::Null;
    }
    let paths: Vec<IpcValue> = match picked.get("filePaths") {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsonValue::String(path) => Some(string(path.clone())),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    if paths.is_empty() {
        return IpcValue::Null;
    }
    app.collect_attachments(&paths)
}

pub(super) fn routes(app: &MindmapApp) -> Vec<Route> {
    let mut routes = Vec::new();

    let a = app.clone();
    routes.push(route::invoke("mindmap:files-pick", move |cx, _args| {
        Ok(files_pick(&a, cx.sender.view))
    }));

    let a = app.clone();
    routes.push(route::invoke("mindmap:files-add", move |_cx, args| {
        Ok(match args.get(0) {
            IpcValue::Array(paths) => a.collect_attachments(paths),
            _ => a.collect_attachments(&[]),
        })
    }));

    let a = app.clone();
    routes.push(route::invoke(
        "mindmap:files-add-pasted-image",
        move |_cx, args| {
            let rejected = |message: String| {
                obj([
                    ("accepted", IpcValue::Array(vec![])),
                    ("rejected", IpcValue::Array(vec![string(message)])),
                ])
            };
            match a.save_pasted_image(args.get(0), args.get(1)) {
                Err(message) => Err(thrown(message)),
                Ok(Err(())) => Ok(rejected(a.at("errImageTooLarge", &[]))),
                Ok(Ok(Some(path))) => Ok(a.collect_attachments(&[string(path)])),
                Ok(Ok(None)) => Ok(rejected(a.at("errNotImage", &[]))),
            }
        },
    ));

    let a = app.clone();
    routes.push(route::invoke_later(
        "mindmap:files-read",
        move |_cx, args, responder| files_read(&a, args, responder),
    ));

    let a = app.clone();
    routes.push(route::invoke(
        "mindmap:files-read-image",
        move |_cx, args| Ok(files_read_image(&a, args)),
    ));

    // an untitled map got a provisional name from the user's first AI request: the shell titles its tab
    let a = app.clone();
    routes.push(route::send("mindmap:provisional-title", move |cx, args| {
        let view = cx.sender.view;
        let Some(title) = args.str(0) else {
            return Ok(());
        };
        if a.file_path(view).is_some() {
            return Ok(());
        }
        let clean = slice(&one_line(title), 0, 80);
        if !clean.is_empty() {
            a.0.shell.provisional_title(view, &clean);
        }
        Ok(())
    }));

    let a = app.clone();
    routes.push(route::invoke_later(
        "mindmap:fetch-image",
        move |_cx, args, responder| {
            let net = a.0.net.clone();
            let tmpdir = path_string(a.0.services.paths.path(PathName::Temp));
            let url = args.str(0).map(str::to_owned);
            a.offload(
                move || {
                    let mut resolver = net.resolver();
                    let mut fetcher = net.fetcher();
                    fetch_image_bytes(&mut *resolver, &mut *fetcher, &tmpdir, url.as_deref())
                },
                move |_app, image| {
                    responder.reply(Ok(match image {
                        Some(image) => super::preview::image_value(image),
                        None => IpcValue::Null,
                    }))
                },
            );
        },
    ));

    routes
}
