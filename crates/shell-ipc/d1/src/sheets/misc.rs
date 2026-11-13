//! The smaller handlers of sheets-main.ts: cross-workbook range picking, the
//! queue and headless-export flags, the close guard's renderer side, the
//! chat attachments and screen capture.

use std::fs;

use jscompat::JsonValue;
use jscompat::node_path::host::{basename, extname, join};
use shell_contract::{IpcError, IpcValue, ViewId};

use super::core::{Core, Env, HeadlessReport};
use super::dialogs::{dialog_options, dialog_parent, json_filter, json_strings, open_dialog};
use super::recovery::io_err;
use super::schema;
use crate::value::{as_bytes, field, num, obj, string, thrown};

// ---- cross-workbook range picking ----

impl Core {
    /// `broadcastPickCancelled`
    fn broadcast_pick_cancelled(&self, pick_id: &str, except: ViewId) {
        for view in self.tab_views() {
            if view == except || !self.env.alive(view) {
                continue;
            }
            self.send(
                view,
                "workbook:pick-cancelled",
                vec![obj([("pickId", string(pick_id))])],
            );
        }
    }
}

/// `listWorkbookTabs`
pub fn list_tabs(core: &Core, view: ViewId) -> IpcValue {
    let tabs: Vec<(ViewId, String)> = core
        .state
        .borrow()
        .tabs
        .iter()
        .filter(|(id, _)| *id != view)
        .filter(|(id, _)| core.env.alive(*id))
        .filter_map(|(id, tab)| tab.current_path.clone().map(|path| (*id, path)))
        .collect();
    obj([(
        "tabs",
        IpcValue::Array(
            tabs.into_iter()
                .map(|(id, path)| {
                    obj([
                        ("wcId", num(f64::from(id.0))),
                        ("name", string(basename(&path, None))),
                        ("path", string(path)),
                    ])
                })
                .collect(),
        ),
    )])
}

/// `armWorkbookPick`
pub fn arm_pick(core: &Core, view: ViewId, input: &IpcValue) -> Result<IpcValue, IpcError> {
    schema::parse(&schema::strict(vec![("wcId", schema::int())]), input)?;
    let target = match field(input, "wcId") {
        IpcValue::Number(n) => ViewId(*n as u32),
        _ => view,
    };
    let pick_id = format!("pick-{}", core.env.uuid());
    let previous = core
        .state
        .borrow()
        .pending_pick
        .as_ref()
        .map(|p| p.pick_id.clone());
    if let Some(previous) = previous {
        core.broadcast_pick_cancelled(&previous, view);
    }
    core.state.borrow_mut().pending_pick = Some(super::core::PendingPick {
        pick_id: pick_id.clone(),
        source: view,
        target,
    });
    // only the tab holding the selected link's source workbook is armed
    let armed =
        core.state.borrow().tab(target).is_some() && target != view && core.env.alive(target);
    if armed {
        core.send(
            target,
            "workbook:pick-armed",
            vec![obj([("pickId", string(pick_id.clone()))])],
        );
    }
    Ok(obj([("pickId", string(pick_id))]))
}

/// `sendWorkbookPickSelection`
pub fn pick_select(core: &Core, view: ViewId, input: &IpcValue) -> Result<IpcValue, IpcError> {
    schema::parse(
        &schema::strict(vec![
            ("pickId", schema::string().min(1)),
            ("sheetName", schema::string().min(1)),
            ("startRow", schema::int().nonneg()),
            ("endRow", schema::int().nonneg()),
            ("startColumn", schema::int().nonneg()),
            ("endColumn", schema::int().nonneg()),
            ("rangeType", schema::int().optional()),
        ]),
        input,
    )?;
    let pick_id = match field(input, "pickId") {
        IpcValue::String(id) => id.clone(),
        _ => String::new(),
    };
    let pending = core
        .state
        .borrow()
        .pending_pick
        .as_ref()
        .map(|p| (p.pick_id.clone(), p.source, p.target));
    // only the tab the pick was armed against answers
    let Some((pending_id, source, target)) = pending else {
        return Ok(IpcValue::Undefined);
    };
    if pending_id != pick_id || view != target {
        return Ok(IpcValue::Undefined);
    }
    core.state.borrow_mut().pending_pick = None;
    if core.state.borrow().tab(source).is_some() && core.env.alive(source) {
        let mut selection = Vec::new();
        for key in [
            "pickId",
            "sheetName",
            "startRow",
            "endRow",
            "startColumn",
            "endColumn",
            "rangeType",
        ] {
            let value = field(input, key);
            if !matches!(value, IpcValue::Undefined) {
                selection.push((key.to_owned(), value.clone()));
            }
        }
        core.send(
            source,
            "workbook:pick-selected",
            vec![IpcValue::Object(selection)],
        );
    }
    core.broadcast_pick_cancelled(&pending_id, source);
    core.env.shell.activate_tab(source);
    Ok(IpcValue::Undefined)
}

/// `cancelWorkbookPick`
pub fn pick_cancel(core: &Core, view: ViewId, input: &IpcValue) -> Result<IpcValue, IpcError> {
    schema::parse(
        &schema::strict(vec![("pickId", schema::string().min(1))]),
        input,
    )?;
    let pick_id = match field(input, "pickId") {
        IpcValue::String(id) => id.clone(),
        _ => String::new(),
    };
    let matches = core
        .state
        .borrow()
        .pending_pick
        .as_ref()
        .is_some_and(|p| p.pick_id == pick_id);
    if !matches {
        return Ok(IpcValue::Undefined);
    }
    core.state.borrow_mut().pending_pick = None;
    core.broadcast_pick_cancelled(&pick_id, view);
    Ok(IpcValue::Undefined)
}

// ---- flags the shell and the renderer share ----

/// `failHeadlessExport`: end a headless run early
impl Core {
    pub fn fail_headless_export(&self, view: ViewId, message: &str) {
        let waiter = self.state.borrow_mut().headless_waiters.remove(&view);
        if let Some(settle) = waiter {
            settle(HeadlessReport {
                ok: false,
                error: Some(message.to_owned()),
            });
        }
    }
}

/// `sheets:headless-export-done`
pub fn headless_export_done(core: &Core, view: ViewId, result: &IpcValue) {
    let waiter = core.state.borrow_mut().headless_waiters.remove(&view);
    let Some(settle) = waiter else {
        return;
    };
    settle(HeadlessReport {
        ok: matches!(field(result, "ok"), IpcValue::Bool(true)),
        error: match field(result, "error") {
            IpcValue::String(error) => Some(error.clone()),
            _ => None,
        },
    });
}

/// `workbook:pending-edits`: the renderer mirrors its pending-save count here
pub fn pending_edits(core: &Core, view: ViewId, count: &IpcValue) {
    let IpcValue::Number(count) = count else {
        return;
    };
    if !count.is_finite() || *count < 0.0 {
        return;
    }
    let mut state = core.state.borrow_mut();
    state.pending_edit_counts.insert(view, count.floor());
    state.tracked_edit_senders.insert(view);
}

/// `workbook:close-save-result`
pub fn close_save_result(core: &Core, view: ViewId, ok: &IpcValue) {
    let waiter = core.state.borrow_mut().close_waiters.remove(&view);
    if let Some(waiter) = waiter {
        (waiter.resume)(matches!(ok, IpcValue::Bool(true)));
    }
}

/// `workbook:recovery-write-now-done`
pub fn recovery_write_now_done(core: &Core, view: ViewId, nonce: &IpcValue) {
    if core.state.borrow().tab(view).is_none() {
        return;
    }
    if let IpcValue::String(nonce) = nonce {
        let waiter = core.state.borrow_mut().write_now_waiters.remove(nonce);
        if let Some(done) = waiter {
            done();
        }
    }
}

// ---- chat attachments ----

const TEXT_EXTS: [&str; 27] = [
    "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log",
    "js", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp", "go", "rs", "rb", "sh", "sql", "css",
];
const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
const OFFICE_EXTS: [&str; 14] = [
    "doc", "docx", "odt", "pdf", "pptx", "ppt", "xlsx", "xlsm", "xls", "xmind", "hwp", "hwpx",
    "epub", "drawio",
];
const DIAGRAM_EXTS: [&str; 3] = ["dio", "drawio.svg", "drawio.png"];
const SIZE_FREE_EXTS: [&str; 9] = [
    "docx", "pptx", "xlsx", "xlsm", "hwpx", "odt", "epub", "xmind", "pdf",
];
const ATTACHABLE_MAX_BYTES: f64 = 50.0 * 1024.0 * 1024.0;
const IMAGE_MAX_BYTES: f64 = 5.0 * 1024.0 * 1024.0;

/// `ATTACHABLE_EXTS` in the set's order
fn attachable_exts() -> Vec<&'static str> {
    let mut all: Vec<&'static str> = TEXT_EXTS.to_vec();
    all.extend(OFFICE_EXTS);
    all.extend(DIAGRAM_EXTS);
    all.extend(IMAGE_EXTS);
    all
}

fn is_attachable(ext: &str) -> bool {
    attachable_exts().contains(&ext)
}

/// `attachableMaxBytes`
fn attachable_max_bytes(ext: &str) -> f64 {
    let clean = ext.trim_start_matches('.').to_lowercase();
    if IMAGE_EXTS.contains(&clean.as_str()) {
        return IMAGE_MAX_BYTES;
    }
    if SIZE_FREE_EXTS.contains(&clean.as_str()) {
        return f64::INFINITY;
    }
    ATTACHABLE_MAX_BYTES
}

/// `name.split('.').pop()?.toLowerCase()`
fn last_segment(name: &str) -> String {
    name.rsplit('.').next().unwrap_or_default().to_lowercase()
}

/// `diagramPictureExtOfName`: only the name
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

fn picture_ext(env: &Env, path: &str) -> String {
    env.engine
        .diagram_picture_ext_of(path)
        .map(str::to_owned)
        .unwrap_or_else(|| last_segment(&basename(path, None)))
}

/// `statAttachment`: `Ok(meta)` or `Err(message)`
fn stat_attachment(env: &Env, path: &str) -> Result<IpcValue, String> {
    let name = basename(path, None);
    let ext = picture_ext(env, path);
    if !is_attachable(&ext) {
        return Err(format!(
            "{name}: {}",
            env.tm
                .with("errUnsupportedExt", &[("ext", JsonValue::String(ext))])
        ));
    }
    let meta = fs::metadata(path).map_err(|_| format!("{name}: {}", env.tm.t("errUnreadable")))?;
    if !meta.is_file() {
        return Err(format!("{name}: {}", env.tm.t("errNotFile")));
    }
    let size = meta.len() as f64;
    let is_image = IMAGE_EXTS.contains(&ext.as_str());
    if !is_image && size > attachable_max_bytes(&ext) {
        return Err(format!(
            "{name}: {}",
            env.tm.with(
                "errTooLarge",
                &[(
                    "mb",
                    JsonValue::Number((ATTACHABLE_MAX_BYTES / 1024.0 / 1024.0).round())
                )]
            )
        ));
    }
    if is_image && size > IMAGE_MAX_BYTES {
        return Err(format!("{name}: {}", env.tm.t("errImageTooLarge")));
    }
    Ok(obj([
        ("path", string(path)),
        ("name", string(name)),
        ("ext", string(ext)),
        ("sizeBytes", num(size)),
    ]))
}

/// `collectAttachments`
fn collect_attachments(env: &Env, paths: &[String]) -> IpcValue {
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    for path in paths {
        match stat_attachment(env, path) {
            Ok(meta) => accepted.push(meta),
            Err(message) => rejected.push(string(message)),
        }
    }
    obj([
        ("accepted", IpcValue::Array(accepted)),
        ("rejected", IpcValue::Array(rejected)),
    ])
}

/// `sheets:files-pick`
pub fn files_pick(env: &Env, view: ViewId) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.require_tab(view))?;
    let exts = attachable_exts();
    let picked = open_dialog(
        env,
        dialog_parent(env, view),
        &dialog_options(&[
            ("title", JsonValue::String(env.tm.t("dlgAddAttachment"))),
            (
                "filters",
                JsonValue::Array(vec![
                    json_filter(&env.tm.t("filterSupported"), &exts),
                    json_filter(&env.tm.t("filterAll"), &["*"]),
                ]),
            ),
            ("properties", json_strings(&["openFile", "multiSelections"])),
        ]),
    );
    if picked.canceled || picked.paths.is_empty() {
        return Ok(IpcValue::Null);
    }
    Ok(collect_attachments(env, &picked.paths))
}

/// `sheets:files-add`
pub fn files_add(env: &Env, view: ViewId, paths: &IpcValue) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.require_tab(view))?;
    schema::parse(
        &schema::array(schema::string().min(1).max(1024)).max(50),
        paths,
    )?;
    let list: Vec<String> = match paths {
        IpcValue::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                IpcValue::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    Ok(collect_attachments(env, &list))
}

/// `savePastedImage`: the temp file written, or `None` for a non-image or empty data
fn save_pasted_image(env: &Env, data: &IpcValue, ext: &IpcValue) -> Option<String> {
    let clean_ext = match ext {
        IpcValue::String(text) => text.to_lowercase(),
        _ => String::new(),
    };
    if !IMAGE_EXTS.contains(&clean_ext.as_str()) {
        return None;
    }
    let bytes = as_bytes(data).filter(|bytes| !bytes.is_empty())?;
    let dir = join(&[&env.temp_dir(), "seuoffice-pasted"]);
    fs::create_dir_all(&dir).ok()?;
    let iso = jscompat::to_iso_string(env.shell.now_ms())?;
    let stamp: String = iso[..19]
        .chars()
        .filter(|c| *c != '-' && *c != ':')
        .map(|c| if c == 'T' { '-' } else { c })
        .collect();
    let seq = env.core(|core| {
        let mut state = core.state.borrow_mut();
        state.pasted_image_seq += 1;
        state.pasted_image_seq
    });
    let path = join(&[&dir, &format!("pasted-{stamp}-{seq}.{clean_ext}")]);
    fs::write(&path, bytes).ok()?;
    Some(path)
}

/// `sheets:files-add-pasted-image`
pub fn files_add_pasted_image(
    env: &Env,
    view: ViewId,
    data: &IpcValue,
    ext: &IpcValue,
) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.require_tab(view))?;
    Ok(pasted_image_result(env, data, ext))
}

fn pasted_image_result(env: &Env, data: &IpcValue, ext: &IpcValue) -> IpcValue {
    match save_pasted_image(env, data, ext) {
        Some(path) => collect_attachments(env, &[path]),
        None => obj([
            ("accepted", IpcValue::Array(Vec::new())),
            (
                "rejected",
                IpcValue::Array(vec![string(env.tm.t("errNotImage"))]),
            ),
        ]),
    }
}

/// `Number(value)`
fn js_number(value: &IpcValue) -> f64 {
    match value {
        IpcValue::Number(x) => *x,
        IpcValue::String(text) => jscompat::to_number(text),
        IpcValue::Bool(flag) => f64::from(u8::from(*flag)),
        IpcValue::Null => 0.0,
        _ => f64::NAN,
    }
}

/// `Math.floor(Number(value)) || fallback`
fn floor_or(value: &IpcValue, fallback: f64) -> f64 {
    let floored = js_number(value).floor();
    if floored.is_nan() || floored == 0.0 {
        fallback
    } else {
        floored
    }
}

/// `extractAttachmentText`
fn extract_attachment_text(env: &Env, path: &str) -> Result<String, IpcError> {
    // a file open with unsaved changes is not read: a withholding mark only reaches the file on save
    env.shell.assert_file_saved(path).map_err(thrown)?;
    let meta = fs::metadata(path).map_err(|e| io_err(e, "stat", path))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    let stamp = format!("{}:{}", jscompat::number_to_string(mtime), meta.len());
    let key = path.to_owned();
    let cached = env.core({
        let stamp = stamp.clone();
        move |core| {
            core.state
                .borrow()
                .attachment_text_cache
                .iter()
                .find(|(p, (s, _))| *p == key && *s == stamp)
                .map(|(_, (_, text))| text.clone())
        }
    });
    if let Some(text) = cached {
        return Ok(text);
    }
    let cap_ext = diagram_picture_ext_of_name(path)
        .map(str::to_owned)
        .unwrap_or_else(|| extname(path));
    if meta.len() as f64 > attachable_max_bytes(&cap_ext) {
        return Err(thrown(env.tm.t("errFileTooLarge")));
    }
    let parsed = env.engine.parse_file_to_text(path);
    let Some(text) = parsed.text.clone().filter(|_| parsed.ok && parsed.is_text) else {
        return Err(thrown(
            parsed
                .error
                .clone()
                .filter(|_| !parsed.damaged)
                .filter(|error| !error.is_empty())
                .unwrap_or_else(|| env.tm.t("errParseFailed")),
        ));
    };
    let (key, cached_text) = (path.to_owned(), text.clone());
    env.core(move |core| {
        let mut state = core.state.borrow_mut();
        state.attachment_text_cache.retain(|(p, _)| *p != key);
        state
            .attachment_text_cache
            .push((key, (stamp, cached_text)));
        // The cache is bounded (keeping a few recent files is enough)
        if state.attachment_text_cache.len() > 8 {
            state.attachment_text_cache.remove(0);
        }
    });
    Ok(text)
}

fn slice_utf16(text: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = end.min(units.len());
    let start = start.min(end);
    String::from_utf16_lossy(&units[start..end])
}

/// `sheets:files-read`
pub fn files_read(
    env: &Env,
    view: ViewId,
    file_path: &IpcValue,
    offset: &IpcValue,
    max_chars: &IpcValue,
) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.require_tab(view))?;
    schema::parse(&schema::string().min(1).max(1024), file_path)?;
    let IpcValue::String(path) = file_path else {
        return Ok(IpcValue::Undefined);
    };
    let name = basename(path, None);
    let ext = picture_ext(env, path);
    let failure =
        |message: String| obj([("ok", IpcValue::Bool(false)), ("error", string(message))]);
    if !is_attachable(&ext) {
        return Ok(failure(
            env.tm
                .with("errUnsupportedExt", &[("ext", JsonValue::String(ext))]),
        ));
    }
    if IMAGE_EXTS.contains(&ext.as_str()) {
        return Ok(failure(env.tm.t("errImageNoText")));
    }
    Ok(match extract_attachment_text(env, path) {
        Ok(text) => {
            let start = floor_or(offset, 0.0).max(0.0);
            let size = floor_or(max_chars, 1.0).clamp(1.0, 48_000.0);
            let total = text.encode_utf16().count();
            obj([
                ("ok", IpcValue::Bool(true)),
                ("name", string(name)),
                ("totalChars", num(total as f64)),
                ("offset", num(start)),
                (
                    "text",
                    string(slice_utf16(&text, start as usize, (start + size) as usize)),
                ),
            ])
        }
        Err(error) => failure(error.message),
    })
}

fn base64_of(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// `sheets:files-read-image`
pub fn files_read_image(
    env: &Env,
    view: ViewId,
    file_path: &IpcValue,
) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.require_tab(view))?;
    schema::parse(&schema::string().min(1).max(1024), file_path)?;
    let IpcValue::String(path) = file_path else {
        return Ok(IpcValue::Undefined);
    };
    let name = basename(path, None);
    let ext = last_segment(&name);
    let failure =
        |message: String| obj([("ok", IpcValue::Bool(false)), ("error", string(message))]);
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => {
            return Ok(failure(format!("{name}: {}", env.tm.t("errNotImage"))));
        }
    };
    let read = || -> Result<Result<Vec<u8>, ()>, ()> {
        let meta = fs::metadata(path).map_err(|_| ())?;
        if meta.len() as f64 > IMAGE_MAX_BYTES {
            return Ok(Err(()));
        }
        Ok(Ok(fs::read(path).map_err(|_| ())?))
    };
    Ok(match read() {
        Ok(Ok(bytes)) => obj([
            ("ok", IpcValue::Bool(true)),
            ("base64", string(base64_of(&bytes))),
            ("mime", string(mime)),
        ]),
        Ok(Err(())) => failure(format!("{name}: {}", env.tm.t("errImageTooLarge"))),
        Err(()) => failure(format!("{name}: {}", env.tm.t("errUnreadable"))),
    })
}

// ---- screen capture ----

/// `sheets:capture-screen-sources`
pub fn capture_screen_sources(env: &Env, view: ViewId) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.require_tab(view))?;
    Ok(capture_screen_sources_of(env, view))
}

fn capture_screen_sources_of(env: &Env, view: ViewId) -> IpcValue {
    let denied = || {
        obj([
            ("status", string("denied")),
            ("sources", IpcValue::Array(Vec::new())),
        ])
    };
    // macOS gates desktopCapturer behind the Screen Recording permission and
    // returns black frames instead of failing; elsewhere there is no gate
    let gated = cfg!(target_os = "macos");
    if gated {
        let status = env.screen.media_access_status();
        if status != "granted" && status != "not-determined" {
            return denied();
        }
    }
    let sources = env.screen.list_sources(dialog_parent(env, view));
    if gated && env.screen.media_access_status() != "granted" {
        return denied();
    }
    obj([
        ("status", string("ok")),
        (
            "sources",
            IpcValue::Array(
                sources
                    .into_iter()
                    .map(|source| {
                        let kind = if source.id.starts_with("screen") {
                            "screen"
                        } else {
                            "window"
                        };
                        obj([
                            ("id", string(source.id)),
                            ("name", string(source.name)),
                            ("kind", string(kind)),
                            ("thumbnail", string(source.thumbnail)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}

/// `sheets:capture-screen-source`
pub fn capture_screen_source(
    env: &Env,
    view: ViewId,
    input: &IpcValue,
) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.require_tab(view))?;
    schema::parse(
        &schema::strict(vec![("id", schema::string().min(1).max(256))]),
        input,
    )?;
    let id = match field(input, "id") {
        IpcValue::String(id) => id.clone(),
        _ => String::new(),
    };
    Ok(match env.screen.capture(&id) {
        None => IpcValue::Null,
        Some(image) => obj([
            ("mediaType", string("image/png")),
            ("base64", string(base64_of(&image.png))),
            ("width", num(image.width)),
            ("height", num(image.height)),
        ]),
    })
}
