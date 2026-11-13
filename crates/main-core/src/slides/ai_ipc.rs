//! `apps/slides/src/main/ai-ipc.ts`: AI IPC for the slides main process:
//! settings persistence, the streaming proxy, the search and media tools, and
//! the slides-only `ai:*` channels (image generation, media analysis, picture
//! insertion, style templates).
//!
//! `ipcMain.handle` registration stays in TypeScript; each handler's body is a
//! function here. What a handler asks of Electron and of the libraries is
//! [`AiIpcHost`] (the app paths, the window list, the settings guard, the
//! subscription connections), the sender of the request is
//! an [`AiSender`], and the pptx engine behind the picture handlers is
//! [`PictureDeck`] (a `Deck` of the session) with [`ImageDecoder`] for
//! `nativeImage`.
//!
//! Module state becomes values the caller owns: `activeAiStreams` is an
//! [`ActiveStreams`] (shared, so a cancel can arrive while a stream runs) and
//! the media calls in flight are a `MediaCalls`. A handler that awaits a
//! download is two functions ([`insert_image_begin`] and
//! [`insert_image_finish`], [`replace_picture_begin`] and
//! [`replace_picture_finish`]): the caller downloads between them (the host's
//! `fetchRemoteImage` and `readBodyCapped(MAX_REMOTE_IMAGE_BYTES)`; any failure
//! is `None`, as the TypeScript's `catch` makes every one of them `null`) and
//! may run anything else, such as an `ai-run-hold`, there.
//!
//! A call that runs long while other IPC must land (`runAiStream`, and the
//! search and media tools, which `ai:stream-cancel` cancels through
//! `abortMediaCalls`) is a begin/finish pair: `*_begin` does all the judgment
//! before the await (registers the controller or the media call, and answers
//! what the caller must run: a [`StreamRun`], a [`SearchRequest`], a
//! [`MediaRequest`]), the caller runs it on its own time, and `*_finish` takes
//! the outcome (the result, or what the call threw) and runs the `finally`
//! cleanup in the TypeScript's order. Those libraries are the caller's, not
//! [`AiIpcHost`] methods.
//!
//! The pure functions of `ai-stream.ts` the handlers use (`storedAiSettings`,
//! `withMeteredAccepted`) are here ([`stored_ai_settings`],
//! [`with_metered_accepted`]); `runAiStream` itself is the engine-waiting part
//! of that module and is run by the caller.

use std::cell::{Cell, RefCell};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::rc::Rc;

use jscompat::node_path::host::join;
use jscompat::{
    JsMap, JsTypeError, JsonValue, buffer_from_base64, js_regex, json_parse, json_stringify,
    json_stringify_pretty, math_max, math_round, number_to_string, slice_utf16, to_iso_string,
    trim,
};

use crate::node_fs::NodeError;
use crate::packages::ai_provider::ai_settings_guard::{GuardHost, sanitize_ai_settings};
use crate::packages::ai_provider::jsval::{
    Obj, as_str, coalesce, js_string_checked, js_string_or_empty_checked, length16, object, prop,
    spread, text, thrown_message, thrown_to_string, without,
};
use crate::packages::ai_provider::legacy_settings::normalize_ai_settings;
use crate::packages::ai_provider::settings_secrets::{AiSecretCodec, seal_ai_secrets};
use crate::packages::ai_provider::stored_settings::{
    with_stored_main_fields, with_stored_unknown_fields,
};
use crate::packages::ai_search::media_call_abort::{MediaCallId, MediaCalls};
use crate::packages::ai_search::media_tools::document_media_roots;
use crate::packages::electron_utils::abort_on_destroyed::Disposer;
use crate::packages::electron_utils::abort_on_destroyed::{DestroyableSender, abort_on_destroyed};
use crate::packages::electron_utils::ai_run_guard::{AiRunGuardInput, AiRunGuardSlot};
use crate::packages::electron_utils::atomic_write::write_json_atomic;
use crate::packages::electron_utils::safe_external_url::safe_external_url;
use crate::packages::electron_utils::safe_remote_url::AbortSignal;
use crate::packages::pipelines::slides_cover_crop::{CoverCrop, cover_crop_fractions};
use crate::slides::ai_default_fonts::{SettingsPathProvider, read_slides_ai_fonts};
use crate::slides::ai_proposal::AiReview;
use crate::slides::media_mime::raster_image_ext;
use crate::slides::session_state::{Deck, EngineThrew, Session};

/// `AI_SETTINGS_PATH`: the file under userData
pub const AI_SETTINGS_FILE: &str = "ai-settings.json";
/// `AI_RUN_FAILURES_PATH`: the file under userData
pub const AI_RUN_FAILURES_FILE: &str = "ai-run-failures.jsonl";
/// `STYLE_TEMPLATES_DIR`: the folder under userData
pub const STYLE_TEMPLATES_DIR: &str = "style-templates";
/// The folder under the temp path where slides stages pasted images.
pub const PASTED_IMAGES_DIR: &str = "seuoffice-pasted";
/// `RUN_FAILURE_TEXT_MAX`: enough of a repetition blowup to recognize the
/// pattern, without storing megabytes
pub const RUN_FAILURE_TEXT_MAX: usize = 20_000;
/// `RUN_FAILURES_MAX_BYTES`: rotated (one generation kept) rather than grown
/// without bound
pub const RUN_FAILURES_MAX_BYTES: u64 = 2_000_000;
/// `EMU_PER_PX_96` of `@seuoffice/pptx-render`: 914400 / 96
pub const EMU_PER_PX_96: f64 = 9525.0;
/// The listener the media call of a window registers for `destroyed`
/// (`onDestroyed` of `withMediaCallSignal`).
pub const MEDIA_DESTROYED_LISTENER: u64 = 3;

/// What a handler throws: the `code` and `message` of the error.
#[derive(Debug, Clone, PartialEq)]
pub struct IpcError {
    pub code: Option<String>,
    pub message: String,
}

impl IpcError {
    fn type_error(message: impl Into<String>) -> Self {
        IpcError {
            code: None,
            message: message.into(),
        }
    }
}

impl From<JsTypeError> for IpcError {
    fn from(error: JsTypeError) -> Self {
        IpcError {
            code: None,
            message: error.0,
        }
    }
}

impl From<NodeError> for IpcError {
    fn from(error: NodeError) -> Self {
        IpcError {
            code: error.code.map(str::to_owned),
            message: error.message,
        }
    }
}

/// The error a value thrown by a library call becomes in the handler that
/// does not catch it (`err.message`).
fn thrown_error(value: &JsonValue) -> IpcError {
    let message = match thrown_message(value) {
        Some(JsonValue::String(message)) => message,
        _ => thrown_to_string(value).unwrap_or_default(),
    };
    IpcError {
        code: None,
        message,
    }
}

/// `value.key` of a handler's argument: reading a property of `undefined` or
/// `null` throws.
fn read_prop<'a>(
    value: Option<&'a JsonValue>,
    key: &str,
) -> Result<Option<&'a JsonValue>, IpcError> {
    match value {
        None => Err(IpcError::type_error(format!(
            "Cannot read properties of undefined (reading '{key}')"
        ))),
        Some(JsonValue::Null) => Err(IpcError::type_error(format!(
            "Cannot read properties of null (reading '{key}')"
        ))),
        Some(other) => Ok(prop(other, key)),
    }
}

/// `String(value)`, `undefined` included.
fn string_of(value: Option<&JsonValue>) -> Result<String, JsTypeError> {
    match value {
        None => Ok("undefined".to_owned()),
        Some(value) => js_string_checked(value),
    }
}

/// A number the handler's type says it is: anything else reads as NaN in
/// arithmetic.
fn number_of(value: Option<&JsonValue>) -> f64 {
    match value {
        Some(JsonValue::Number(x)) => *x,
        _ => f64::NAN,
    }
}

/// `typeof value === 'number' ? value : fallback`
fn number_or(value: Option<&JsonValue>, fallback: f64) -> f64 {
    match value {
        Some(JsonValue::Number(x)) => *x,
        _ => fallback,
    }
}

// ---- the process around the handlers ----

/// The sender of a request (`event.sender`).
pub trait AiSender: DestroyableSender {
    /// `sender.id`
    fn id(&self) -> f64;
    /// `sender.send(channel, payload)`
    fn send(&mut self, channel: &str, payload: &JsonValue);
}

/// The `options` of `generateImageTool` and `analyzeMediaTool` (without the
/// signal).
pub struct MediaToolOptions {
    pub media_roots: Vec<String>,
    pub context: JsonValue,
}

/// What the handlers call that is quick and local (paths, the window list,
/// the connection statuses, `console.warn`, `shell.openExternal`). The long
/// calls are not here: the caller runs them between a handler's begin and finish.
pub trait AiIpcHost {
    /// `app.getPath('userData')`
    fn user_data_path(&self) -> String;
    /// `app.getPath('temp')`
    fn temp_path(&self) -> String;
    /// `app.getVersion()`
    fn app_version(&self) -> String;
    /// `PRODUCT_NAME`
    fn product_name(&self) -> String;
    /// `documentLocale()`
    fn document_locale(&mut self) -> String;
    /// `getUiLang()`
    fn ui_lang(&mut self) -> String;
    /// `tm(key)` or `tm(key, { name })`
    fn tm(&self, key: &str, name: Option<&str>) -> String;
    /// the registered `AiSecretCodec`, `None` for none
    fn secret_codec(&self) -> Option<&dyn AiSecretCodec>;
    /// `os.homedir()` and `statSync(path).isFile()` for the settings guard
    fn guard_host(&self) -> &dyn GuardHost;
    /// `console.warn(message)`
    fn warn(&mut self, message: &str);

    /// `webContents.getAllWebContents().length`
    fn web_contents_count(&self) -> usize;
    /// `getAllWebContents()[index].isDestroyed()`
    fn web_contents_destroyed(&mut self, index: usize) -> bool;
    /// `getAllWebContents()[index].send(channel)` or `.send(channel, payload)`
    fn web_contents_send(&mut self, index: usize, channel: &str, payload: Option<&JsonValue>);

    /// `app.once('before-quit', shutdownCodexAppServers)`
    fn shutdown_codex_on_quit(&mut self);
    /// `setRescueFetch((url, init) => net.fetch(url, init))`
    fn set_rescue_fetch(&mut self);
    /// `setAiUserAgent(userAgent)`
    fn set_ai_user_agent(&mut self, user_agent: &str);
    /// `ensureSubscriptionIpc(ipcMain, deps)` with the functions of this module
    /// as the deps
    fn ensure_subscription_ipc(&mut self, data_dir: &str);
    /// `sharedSubscriptionStatuses()`
    fn shared_subscription_statuses(&mut self) -> JsonValue;
    /// `aiSubscriptionLoginWindowText(lang, provider)`
    fn ai_subscription_login_window_text(&mut self, lang: &str, provider: &str) -> JsonValue;
    /// `aiChatGptSignInPages(lang)`
    fn ai_chatgpt_sign_in_pages(&mut self, lang: &str) -> JsonValue;
    /// `shell.openExternal(url)`: `true` when it resolved, `false` when it rejected
    fn open_external(&mut self, url: &str) -> bool;

    /// `aiToolCapabilities(settings, context)`
    fn ai_tool_capabilities(&mut self, settings: &JsonValue, context: &JsonValue) -> JsonValue;
}

/// `userData` as the `app` of `readSlidesAiFonts`
struct UserData(String);

impl SettingsPathProvider for UserData {
    fn user_data_path(&self) -> String {
        self.0.clone()
    }
}

/// What `nativeImage.createFromBuffer(bytes)` gives.
pub trait NativeImage {
    /// `.isEmpty()`
    fn is_empty(&self) -> bool;
    /// `.toPNG()`
    fn to_png(&self) -> Vec<u8>;
    /// `.getSize()`: width and height
    fn size(&self) -> (f64, f64);
}

/// `nativeImage.createFromBuffer(bytes)`
pub trait ImageDecoder {
    fn create_from_buffer(&self, bytes: &[u8]) -> Box<dyn NativeImage>;
}

/// An `AbortController` of `ai:stream`.
#[derive(Debug, Clone, Default)]
pub struct StreamController(Rc<Cell<bool>>);

impl StreamController {
    pub fn new() -> Self {
        Self::default()
    }

    /// `controller.abort()`
    pub fn abort(&self) {
        self.0.set(true);
    }

    /// `controller.signal.aborted`
    pub fn aborted(&self) -> bool {
        self.0.get()
    }
}

impl AbortSignal for StreamController {
    fn aborted(&self) -> bool {
        self.0.get()
    }
}

/// `activeAiStreams`: the stream of each request id in flight. A handle to
/// one map, so a cancel can reach it while a stream runs.
#[derive(Debug, Clone, Default)]
pub struct ActiveStreams(Rc<RefCell<JsMap<StreamController>>>);

/// The key a request id has in the map: the types stay apart (`1` is not `"1"`).
fn stream_key(request_id: Option<&JsonValue>) -> String {
    match request_id {
        None => "undefined".to_owned(),
        Some(JsonValue::String(id)) => format!("s:{id}"),
        Some(JsonValue::Number(x)) => format!("n:{}", number_to_string(*x)),
        Some(other) => format!("j:{}", json_stringify(other)),
    }
}

impl ActiveStreams {
    pub fn new() -> Self {
        Self::default()
    }

    /// `activeAiStreams.set(requestId, controller)`
    fn set(&self, key: &str, controller: StreamController) {
        self.0.borrow_mut().set(key, controller);
    }

    /// `activeAiStreams.get(requestId)`
    fn get(&self, key: &str) -> Option<StreamController> {
        self.0.borrow().get(key).cloned()
    }

    /// `activeAiStreams.delete(requestId)`
    fn delete(&self, key: &str) {
        self.0.borrow_mut().delete(key);
    }

    /// How many streams are in flight.
    pub fn len(&self) -> usize {
        self.0.borrow().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

// ---- settings and logs on disk ----

/// `AI_SETTINGS_PATH()`
fn ai_settings_path(host: &dyn AiIpcHost) -> String {
    join(&[host.user_data_path().as_str(), AI_SETTINGS_FILE])
}

/// `readJson(path, fallback)`: `None` is the fallback (a missing, unreadable
/// or damaged file).
fn read_json(path: &str) -> Option<JsonValue> {
    if !Path::new(path).exists() {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    // readFileSync(path, 'utf-8'): ill-formed bytes become U+FFFD, a BOM stays
    json_parse(&String::from_utf8_lossy(&bytes)).ok()
}

/// `readJson(path, {})`
fn read_json_or_empty(path: &str) -> JsonValue {
    read_json(path).unwrap_or_else(|| JsonValue::Object(Obj::new()))
}

/// `storedAiSettings(stored)` of ai-stream.ts: what ai-settings.json holds, as
/// the app reads it: removed and unknown selections fall to their defaults.
pub fn stored_ai_settings(codec: Option<&dyn AiSecretCodec>, stored: &JsonValue) -> JsonValue {
    normalize_ai_settings(codec, Some(stored), None)
}

/// `withMeteredAccepted(settings, provider, accepted)` of ai-stream.ts: the
/// settings to persist after "use anyway" on a metered login (or taking it back).
pub fn with_metered_accepted(settings: &JsonValue, provider: &str, accepted: bool) -> JsonValue {
    let mut metered = spread(prop(settings, "meteredAccepted"));
    metered.set(provider, JsonValue::Bool(accepted));
    let mut out = spread(Some(settings));
    out.set("meteredAccepted", JsonValue::Object(metered));
    JsonValue::Object(out)
}

/// `readAiSettings()`: ai-settings.json as the app reads it
pub fn read_ai_settings(host: &dyn AiIpcHost) -> JsonValue {
    let stored = read_json_or_empty(&ai_settings_path(host));
    stored_ai_settings(host.secret_codec(), &stored)
}

/// `writeAiSettingsFile(settings)`: the only write of the settings file: keys
/// and tokens go to disk sealed, and fields a newer build wrote stay as they are.
pub fn write_ai_settings_file(host: &dyn AiIpcHost, settings: &JsonValue) -> Result<(), NodeError> {
    let path = ai_settings_path(host);
    let stored = read_json_or_empty(&path);
    write_json_atomic(
        &path,
        &seal_ai_secrets(
            host.secret_codec(),
            &with_stored_unknown_fields(settings, &stored),
        ),
    )
}

/// `broadcastToWindows(channel, payload?)`
pub fn broadcast_to_windows(host: &mut dyn AiIpcHost, channel: &str, payload: Option<&JsonValue>) {
    for index in 0..host.web_contents_count() {
        if host.web_contents_destroyed(index) {
            continue;
        }
        host.web_contents_send(index, channel, payload);
    }
}

/// `screenToolContext()`: who is asking the image/media tools: a window of this
/// process, with its subscription connections.
fn screen_tool_context(host: &mut dyn AiIpcHost) -> JsonValue {
    object(vec![
        ("path", text("screen")),
        ("statuses", host.shared_subscription_statuses()),
    ])
}

/// `slidesMediaRoots(wcId)`: `session_path` is `sessions.get(wcId)?.path`.
fn slides_media_roots(host: &dyn AiIpcHost, session_path: Option<&str>) -> Vec<String> {
    let staged = join(&[host.temp_path().as_str(), PASTED_IMAGES_DIR]);
    document_media_roots(session_path, Some(staged.as_str()))
}

/// `appendRunFailure(entry)`: one line of the post-mortem log; diagnostics
/// must never break a run, so a failure is dropped. `now_ms` is `new Date()`.
pub fn append_run_failure(host: &dyn AiIpcHost, entry: &JsonValue, now_ms: f64) {
    let path = join(&[host.user_data_path().as_str(), AI_RUN_FAILURES_FILE]);
    let _ = write_run_failure(&path, entry, now_ms);
}

/// `text.slice(0, RUN_FAILURE_TEXT_MAX)` and `text.length` of a string or an
/// array; anything else has no `slice` (a `TypeError`).
fn clipped(value: Option<&JsonValue>) -> Option<(JsonValue, f64)> {
    match value? {
        JsonValue::String(text_value) => Some((
            JsonValue::String(slice_utf16(
                text_value,
                0.0,
                Some(RUN_FAILURE_TEXT_MAX as f64),
            )),
            length16(text_value) as f64,
        )),
        JsonValue::Array(items) => Some((
            JsonValue::Array(items.iter().take(RUN_FAILURE_TEXT_MAX).cloned().collect()),
            items.len() as f64,
        )),
        _ => None,
    }
}

fn write_run_failure(path: &str, entry: &JsonValue, now_ms: f64) -> Option<()> {
    if Path::new(path).exists() && fs::metadata(path).ok()?.len() > RUN_FAILURES_MAX_BYTES {
        fs::rename(path, format!("{path}.1")).ok()?;
    }
    let mut record = Obj::new();
    record.set("ts", text(to_iso_string(now_ms)?));
    record.assign(&spread(Some(entry)));
    let (instruction, _) = clipped(prop(entry, "instruction"))?;
    record.set("instruction", instruction);
    let (streamed, streamed_chars) = clipped(prop(entry, "streamed"))?;
    record.set("streamed", streamed);
    record.set("streamedChars", JsonValue::Number(streamed_chars));
    let mut line = json_stringify(&JsonValue::Object(record));
    line.push('\n');
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .ok()?;
    file.write_all(line.as_bytes()).ok()
}

// ---- the generic ai:* handlers ----

/// What `registerAiIpc` does before it registers its handlers: the quit hook,
/// the rescue fetch, the user agent, and the subscription connections.
pub fn ai_ipc_setup(host: &mut dyn AiIpcHost) {
    host.shutdown_codex_on_quit();
    // Node fetch (undici) direct connections get reset under VPN/tun setups; retry over Chromium's stack
    host.set_rescue_fetch();
    let user_agent = format!("{}/{}", host.product_name(), host.app_version());
    host.set_ai_user_agent(&user_agent);
    let data_dir = host.user_data_path();
    host.ensure_subscription_ipc(&data_dir);
}

/// `setMeteredAccepted(provider, accepted)` of the subscription deps
pub fn subscription_set_metered_accepted(
    host: &mut dyn AiIpcHost,
    provider: &str,
    accepted: bool,
) -> Result<(), IpcError> {
    let settings = with_metered_accepted(&read_ai_settings(host), provider, accepted);
    write_ai_settings_file(host, &settings)?;
    broadcast_to_windows(host, "ai:settings-changed", None);
    Ok(())
}

/// `loginWindowText(provider)` of the subscription deps
pub fn subscription_login_window_text(host: &mut dyn AiIpcHost, provider: &str) -> JsonValue {
    let lang = host.ui_lang();
    host.ai_subscription_login_window_text(&lang, provider)
}

/// `chatGptSignIn.openBrowser(url)`: OpenAI's page in the system browser; a
/// URL that is not http(s) is refused.
pub fn chat_gpt_open_browser(host: &mut dyn AiIpcHost, url: Option<&str>) -> bool {
    let Some(target) = safe_external_url(url, None) else {
        return false;
    };
    host.open_external(&target)
}

/// `chatGptSignIn.pages()`
pub fn chat_gpt_sign_in_pages(host: &mut dyn AiIpcHost) -> JsonValue {
    let lang = host.ui_lang();
    host.ai_chatgpt_sign_in_pages(&lang)
}

/// `ai:get-settings`
pub fn ai_get_settings(host: &dyn AiIpcHost) -> JsonValue {
    read_ai_settings(host)
}

/// `ai:set-settings`: renderer payloads are schema-checked in the main process.
/// The settings file feeds cliPath into spawn() and baseUrl receives the
/// provider's API key, so the renderer's copy is sanitized before it touches disk.
pub fn ai_set_settings(
    host: &mut dyn AiIpcHost,
    settings: Option<&JsonValue>,
) -> Result<(), IpcError> {
    let null = JsonValue::Null;
    let Some(sanitized) = sanitize_ai_settings(host.guard_host(), settings.unwrap_or(&null))?
    else {
        host.warn("[ai] rejected invalid ai:set-settings payload");
        return Ok(());
    };
    // the live model lists and the CLIs turned off are the main process's: the file's copy is kept
    let next = with_stored_main_fields(&sanitized, &read_ai_settings(host));
    write_ai_settings_file(host, &next)?;
    broadcast_to_windows(host, "ai:settings-changed", None);
    Ok(())
}

/// `ai:log-run-failure`
pub fn ai_log_run_failure(host: &dyn AiIpcHost, entry: Option<&JsonValue>, now_ms: f64) {
    // an absent entry reads as `undefined`: the log still rotates, then
    // `entry.instruction` throws and the log drops the record
    append_run_failure(host, entry.unwrap_or(&JsonValue::Null), now_ms);
}

/// The error chunk `{ requestId, type: 'error', error }`.
fn error_chunk(request_id: Option<&JsonValue>, error: &str) -> JsonValue {
    let mut chunk = Obj::new();
    if let Some(request_id) = request_id {
        chunk.set("requestId", request_id.clone());
    }
    chunk.set("type", text("error"));
    chunk.set("error", text(error));
    JsonValue::Object(chunk)
}

/// `send(chunk)` of `ai:stream`: a window that went away gets nothing.
fn send_chunk<S: AiSender>(sender: &mut S, chunk: &JsonValue) {
    if !sender.is_destroyed() {
        sender.send("ai:stream-chunk", chunk);
    }
}

/// What `ai:stream` holds across the await of `runAiStream`: the run the
/// caller performs, and what the `finally` cleans up afterwards.
pub struct StreamRun {
    pub request: JsonValue,
    /// the request's settings after the schema check
    pub settings: JsonValue,
    pub statuses: JsonValue,
    /// `controller.signal`: aborted by `ai:stream-cancel` or when the window goes away
    pub signal: StreamController,
    key: String,
    unwatch: Disposer,
}

/// What the first half of `ai:stream` comes to.
pub enum StreamStart {
    /// an error chunk was sent (or nothing to run): the handler is over
    Done,
    /// the caller runs `runAiStream` with [`ai_stream_send`] as its `send`
    /// (taking `ai:stream-cancel` meanwhile), then calls [`ai_stream_finish`]
    Run(Box<StreamRun>),
}

/// `ai:stream`, up to the call of `runAiStream`.
pub fn ai_stream_begin<S: AiSender>(
    host: &mut dyn AiIpcHost,
    streams: &ActiveStreams,
    guard: &AiRunGuardSlot,
    sender: &mut S,
    request: Option<&JsonValue>,
) -> Result<StreamStart, IpcError> {
    // per-request settings get the same schema check as the persisted ones: a
    // compromised renderer could otherwise hand cliPath/baseUrl straight to
    // the provider layer without ever touching the settings file
    let null = JsonValue::Null;
    let raw_settings = read_prop(request, "settings")?.unwrap_or(&null);
    let request = request.unwrap_or(&null);
    let request_id = prop(request, "requestId");
    let Some(settings) = sanitize_ai_settings(host.guard_host(), raw_settings)? else {
        sender.send(
            "ai:stream-chunk",
            &error_chunk(request_id, "invalid AI settings payload"),
        );
        return Ok(StreamStart::Done);
    };
    // a free provider is only ever the explicit selection, never what `auto` lands on
    let provider = as_str(prop(&settings, "provider"))
        .unwrap_or_default()
        .to_owned();
    let model = as_str(
        prop(&settings, "providers")
            .and_then(|providers| prop(providers, &provider))
            .and_then(|config| prop(config, "model")),
    )
    .unwrap_or_default()
    .to_owned();
    let refusal = guard.ai_run_refusal(&AiRunGuardInput {
        sender_id: sender.id(),
        provider,
        model,
    });
    if let Some(refusal) = refusal {
        send_chunk(sender, &error_chunk(request_id, &refusal));
        return Ok(StreamStart::Done);
    }
    let key = stream_key(request_id);
    let controller = StreamController::new();
    streams.set(&key, controller.clone());
    let to_abort = controller.clone();
    let unwatch = abort_on_destroyed(sender, &mut || to_abort.abort());
    let statuses = host.shared_subscription_statuses();
    Ok(StreamStart::Run(Box::new(StreamRun {
        request: request.clone(),
        settings,
        statuses,
        signal: controller,
        key,
        unwatch,
    })))
}

/// `send(chunk)` of `ai:stream`, for the caller to hand to `runAiStream`:
/// a window that went away gets nothing.
pub fn ai_stream_send<S: AiSender>(sender: &mut S, chunk: &JsonValue) {
    send_chunk(sender, chunk);
}

/// `ai:stream`, after `runAiStream` settled (`outcome` is its rejection, if
/// any): the `finally` runs in the TypeScript's order (the sender's
/// listeners, then the request's entry), then the handler fails with the error.
pub fn ai_stream_finish<S: AiSender>(
    streams: &ActiveStreams,
    sender: &mut S,
    run: StreamRun,
    outcome: Result<(), JsonValue>,
) -> Result<(), IpcError> {
    run.unwatch.dispose(sender);
    streams.delete(&run.key);
    outcome.map_err(|thrown| thrown_error(&thrown))
}

/// `ai:stream-cancel`: stop while a tool runs names a turn that already ended:
/// end the window's media calls too.
pub fn ai_stream_cancel(
    streams: &ActiveStreams,
    media_calls: &mut MediaCalls,
    sender_id: f64,
    request_id: Option<&JsonValue>,
) {
    if let Some(controller) = streams.get(&stream_key(request_id)) {
        controller.abort();
    }
    media_calls.abort_media_calls(sender_id);
}

/// What `String(err)` makes of a value a tool threw (a `catch (err)`).
fn thrown_text(thrown: &JsonValue) -> Result<String, IpcError> {
    thrown_to_string(thrown).map_err(IpcError::from)
}

/// The answer of a search handler whose tool threw: `{ [list]: [], method: 'error', error }`
fn search_failure(list: &str, error: String) -> JsonValue {
    object(vec![
        (list, JsonValue::Array(Vec::new())),
        ("method", text("error")),
        ("error", text(error)),
    ])
}

/// What a search handler runs: `webSearchTool` or `imageSearchTool`
/// `(settingsPath, query, maxResults)`.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchRequest {
    pub settings_path: String,
    pub query: String,
    pub max_results: f64,
}

/// What a search handler's first half comes to.
#[derive(Debug, Clone, PartialEq)]
pub enum SearchStart {
    /// the caller runs the tool, then calls the handler's `finish`
    Run(SearchRequest),
    /// the query could not become text: the answer of the `catch`
    Answer(JsonValue),
}

fn search_begin(
    host: &dyn AiIpcHost,
    list: &str,
    default_max: f64,
    query: Option<&JsonValue>,
    max_results: Option<&JsonValue>,
) -> SearchStart {
    let settings_path = ai_settings_path(host);
    match string_of(query) {
        Ok(query) => SearchStart::Run(SearchRequest {
            settings_path,
            query,
            max_results: number_or(max_results, default_max),
        }),
        Err(error) => SearchStart::Answer(search_failure(list, format!("TypeError: {}", error.0))),
    }
}

fn search_finish(list: &str, outcome: Result<JsonValue, JsonValue>) -> Result<JsonValue, IpcError> {
    match outcome {
        Ok(answer) => Ok(answer),
        Err(thrown) => Ok(search_failure(list, thrown_text(&thrown)?)),
    }
}

/// `ai:web-search`, up to the tool: Serper with DuckDuckGo fallback
pub fn ai_web_search_begin(
    host: &dyn AiIpcHost,
    query: Option<&JsonValue>,
    max_results: Option<&JsonValue>,
) -> SearchStart {
    search_begin(host, "results", 6.0, query, max_results)
}

/// `ai:web-search`, after the tool (`Err` is what it threw)
pub fn ai_web_search_finish(outcome: Result<JsonValue, JsonValue>) -> Result<JsonValue, IpcError> {
    search_finish("results", outcome)
}

/// `ai:image-search`, up to the tool
pub fn ai_image_search_begin(
    host: &dyn AiIpcHost,
    query: Option<&JsonValue>,
    max_results: Option<&JsonValue>,
) -> SearchStart {
    search_begin(host, "images", 8.0, query, max_results)
}

/// `ai:image-search`, after the tool
pub fn ai_image_search_finish(
    outcome: Result<JsonValue, JsonValue>,
) -> Result<JsonValue, IpcError> {
    search_finish("images", outcome)
}

/// The media call of `withMediaCallSignal(sender, run)` up to the call of `run`.
fn media_call_begin(media_calls: &mut MediaCalls, sender: &mut dyn AiSender) -> MediaCallId {
    let destroyed = sender.is_destroyed();
    let call = media_calls.begin(sender.id(), destroyed);
    if !destroyed {
        sender.once_destroyed(MEDIA_DESTROYED_LISTENER);
    }
    call
}

/// The `finally` of `withMediaCallSignal`.
fn media_call_end(media_calls: &mut MediaCalls, sender: &mut dyn AiSender, call: MediaCallId) {
    sender.remove_destroyed_listener(MEDIA_DESTROYED_LISTENER);
    media_calls.end(sender.id(), call);
}

/// `ai:read-url`, up to the tool: a long download ends with the window or
/// when the window's AI run is stopped. The caller runs the returned request,
/// and may take an `ai:stream-cancel` meanwhile, then calls
/// [`ai_read_url_finish`].
pub fn ai_read_url_begin(
    host: &mut dyn AiIpcHost,
    media_calls: &mut MediaCalls,
    sender: &mut dyn AiSender,
    url: Option<&JsonValue>,
    offset: Option<&JsonValue>,
) -> (MediaStart, Option<MediaRequest>) {
    media_begin(media_calls, sender, || {
        let settings_path = ai_settings_path(host);
        let url = string_of(url)?;
        Ok(MediaRequest::ReadUrl {
            settings_path,
            url,
            offset: number_or(offset, 0.0),
        })
    })
}

/// `ai:read-url`, after the tool: the `finally` of the call, then the answer;
/// a read that failed (or never started) answers a network failure.
pub fn ai_read_url_finish(
    media_calls: &mut MediaCalls,
    sender: &mut dyn AiSender,
    start: MediaStart,
    outcome: Option<Result<JsonValue, JsonValue>>,
) -> JsonValue {
    media_call_end(media_calls, sender, start.call);
    match outcome {
        Some(Ok(answer)) => answer,
        _ => object(vec![
            ("ok", JsonValue::Bool(false)),
            ("error", text("The read failed.")),
            ("errorCode", text("network")),
        ]),
    }
}

/// `String(value)` over each item of an array
fn strings_of(items: &[JsonValue]) -> Result<JsonValue, JsTypeError> {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        out.push(text(js_string_checked(item)?));
    }
    Ok(JsonValue::Array(out))
}

/// The request `ai:generate-image` hands to `generateImageTool`.
fn generate_image_request(op: Option<&JsonValue>) -> Result<JsonValue, IpcError> {
    let prompt = string_of(read_prop(op, "prompt")?)?;
    let mut request = Obj::new();
    request.set("prompt", text(prompt));
    if let Some(model) = prop_of(op, "model").filter(|value| value.truthy()) {
        request.set("model", text(js_string_checked(model)?));
    }
    if let Some(JsonValue::Array(urls)) = prop_of(op, "referenceImageUrls") {
        request.set("referenceImageUrls", strings_of(urls)?);
    }
    if let Some(ratio) = prop_of(op, "aspectRatio").filter(|value| value.truthy()) {
        request.set("aspectRatio", text(js_string_checked(ratio)?));
    }
    if let Some(size) = prop_of(op, "imageSize").filter(|value| value.truthy()) {
        request.set("imageSize", text(js_string_checked(size)?));
    }
    request.set(
        "transparentBackground",
        JsonValue::Bool(matches!(
            prop_of(op, "transparentBackground"),
            Some(JsonValue::Bool(true))
        )),
    );
    Ok(JsonValue::Object(request))
}

/// `op.key` of an argument already known not to be null.
fn prop_of<'a>(op: Option<&'a JsonValue>, key: &str) -> Option<&'a JsonValue> {
    op.and_then(|value| prop(value, key))
}

/// The request `ai:analyze-media` hands to `analyzeMediaTool`.
fn analyze_media_request(op: Option<&JsonValue>) -> Result<JsonValue, IpcError> {
    let urls = match read_prop(op, "mediaUrls")? {
        None | Some(JsonValue::Null) => JsonValue::Array(Vec::new()),
        Some(JsonValue::Array(items)) => strings_of(items)?,
        Some(_) => {
            return Err(IpcError::type_error(
                "(op.mediaUrls ?? []).map is not a function",
            ));
        }
    };
    let requirements = js_string_or_empty_checked(prop_of(op, "requirements"))?;
    Ok(object(vec![
        ("mediaUrls", urls),
        ("requirements", text(requirements)),
    ]))
}

/// What a media tool call runs: the tool of the handler and what it is given
/// (without the signal, which is [`MediaCalls::aborted`] of the call).
pub enum MediaRequest {
    /// `readUrlTool(settingsPath, url, offset, { signal })`
    ReadUrl {
        settings_path: String,
        url: String,
        offset: f64,
    },
    /// `generateImageTool(settingsPath, request, { mediaRoots, context, signal })`
    GenerateImage {
        settings_path: String,
        request: JsonValue,
        options: MediaToolOptions,
    },
    /// `analyzeMediaTool(settingsPath, request, { mediaRoots, context, signal })`
    AnalyzeMedia {
        settings_path: String,
        request: JsonValue,
        options: MediaToolOptions,
    },
}

/// What `withMediaCallSignal(sender, run)` holds across the await of `run`:
/// the call in flight, and the error the request's preparation threw (the
/// callback failed before it reached the tool).
#[derive(Debug)]
pub struct MediaStart {
    call: MediaCallId,
    prep_error: Option<IpcError>,
}

impl MediaStart {
    /// the call to ask [`MediaCalls::aborted`] about, for the tool's signal
    pub fn call(&self) -> MediaCallId {
        self.call
    }
}

/// The part of `withMediaCallSignal` before `run` and the preparation of
/// `run` itself: the caller runs the request (when there is one) on its own
/// time, so a cancel can land meanwhile, then calls the `finish` of the handler.
fn media_begin(
    media_calls: &mut MediaCalls,
    sender: &mut dyn AiSender,
    prepare: impl FnOnce() -> Result<MediaRequest, IpcError>,
) -> (MediaStart, Option<MediaRequest>) {
    let call = media_call_begin(media_calls, sender);
    match prepare() {
        Ok(request) => (
            MediaStart {
                call,
                prep_error: None,
            },
            Some(request),
        ),
        Err(error) => (
            MediaStart {
                call,
                prep_error: Some(error),
            },
            None,
        ),
    }
}

/// The `request` of `ai:generate-image` or `ai:analyze-media`.
fn media_tool_request(
    host: &mut dyn AiIpcHost,
    session_path: Option<&str>,
    op: Option<&JsonValue>,
    analyze: bool,
) -> Result<MediaRequest, IpcError> {
    let settings_path = ai_settings_path(host);
    let request = if analyze {
        analyze_media_request(op)?
    } else {
        generate_image_request(op)?
    };
    let media_roots = slides_media_roots(host, session_path);
    let context = screen_tool_context(host);
    let options = MediaToolOptions {
        media_roots,
        context,
    };
    Ok(if analyze {
        MediaRequest::AnalyzeMedia {
            settings_path,
            request,
            options,
        }
    } else {
        MediaRequest::GenerateImage {
            settings_path,
            request,
            options,
        }
    })
}

/// The `finally` of `withMediaCallSignal`, then the outcome of a media tool
/// handler: `outcome` is what the tool did (`None` when it was never run).
fn media_tool_finish(
    media_calls: &mut MediaCalls,
    sender: &mut dyn AiSender,
    start: MediaStart,
    outcome: Option<Result<JsonValue, JsonValue>>,
) -> Result<JsonValue, IpcError> {
    media_call_end(media_calls, sender, start.call);
    match (outcome, start.prep_error) {
        (Some(Ok(answer)), _) => Ok(answer),
        (Some(Err(thrown)), _) => Err(thrown_error(&thrown)),
        (None, Some(error)) => Err(error),
        (None, None) => Err(IpcError::type_error("the media tool was not run")),
    }
}

/// `ai:generate-image`, up to the tool: answers with an error text when no
/// route is available. The call ends with its window, or when the window's AI
/// run is stopped.
pub fn ai_generate_image_begin(
    host: &mut dyn AiIpcHost,
    media_calls: &mut MediaCalls,
    sender: &mut dyn AiSender,
    session_path: Option<&str>,
    op: Option<&JsonValue>,
) -> (MediaStart, Option<MediaRequest>) {
    media_begin(media_calls, sender, || {
        media_tool_request(host, session_path, op, false)
    })
}

/// `ai:generate-image`, after the tool (`outcome` as for [`media_tool_finish`]).
pub fn ai_generate_image_finish(
    media_calls: &mut MediaCalls,
    sender: &mut dyn AiSender,
    start: MediaStart,
    outcome: Option<Result<JsonValue, JsonValue>>,
) -> Result<JsonValue, IpcError> {
    media_tool_finish(media_calls, sender, start, outcome)
}

/// `ai:analyze-media`, up to the tool
pub fn ai_analyze_media_begin(
    host: &mut dyn AiIpcHost,
    media_calls: &mut MediaCalls,
    sender: &mut dyn AiSender,
    session_path: Option<&str>,
    op: Option<&JsonValue>,
) -> (MediaStart, Option<MediaRequest>) {
    media_begin(media_calls, sender, || {
        media_tool_request(host, session_path, op, true)
    })
}

/// `ai:analyze-media`, after the tool
pub fn ai_analyze_media_finish(
    media_calls: &mut MediaCalls,
    sender: &mut dyn AiSender,
    start: MediaStart,
    outcome: Option<Result<JsonValue, JsonValue>>,
) -> Result<JsonValue, IpcError> {
    media_tool_finish(media_calls, sender, start, outcome)
}

// ---- the slides-only handlers ----

/// `slides:ai-default-fonts`: the fonts generation uses when the request names
/// none (Settings, General); before a choice is stored the language documents
/// are read for picks the default.
pub fn slides_ai_default_fonts(host: &mut dyn AiIpcHost) -> JsonValue {
    let lang = host.document_locale();
    let app = UserData(host.user_data_path());
    read_slides_ai_fonts(&app, &lang).to_json()
}

/// `slides:ai-tool-capabilities`: what the search/image/media tools can do
/// right now (settings and subscription connections).
pub fn slides_ai_tool_capabilities(host: &mut dyn AiIpcHost) -> JsonValue {
    let settings = read_ai_settings(host);
    let context = screen_tool_context(host);
    host.ai_tool_capabilities(&settings, &context)
}

/// `styleSkillSidecarPath(draftPath)`: the same-named `.styleskill.json` beside
/// a draft deck, or `None` when the path is not a pptx.
pub fn style_skill_sidecar_path(draft_path: Option<&str>) -> Option<String> {
    let draft_path = draft_path.filter(|path| !path.is_empty())?;
    if !js_regex!(r"\.pptx$", "i").test(draft_path) {
        return None;
    }
    Some(js_regex!(r"\.pptx$", "ig").replace_all(draft_path, |_| ".styleskill.json".to_owned()))
}

/// `ai:save-sidecar`: write a same-named .styleskill.json next to the draft
/// (fail-open). `session_path` is `sessions.get(event.sender.id)?.path`.
pub fn ai_save_sidecar(session_path: Option<&str>, data: Option<&JsonValue>) -> JsonValue {
    let saved = (|| {
        let sidecar_path = style_skill_sidecar_path(session_path)?;
        // `JSON.stringify(undefined)` is `undefined`, which `writeFileSync` refuses
        let json = json_stringify_pretty(data?, 2);
        fs::write(sidecar_path, json).ok()
    })();
    object(vec![("ok", JsonValue::Bool(saved.is_some()))])
}

/// `savedStyleBasedOn(value)`: a saved style's `basedOn` as it is stored and
/// answered: a non-empty id, or nothing.
fn saved_style_based_on(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(id)) if !trim(id).is_empty() => Some(trim(id).to_owned()),
        _ => None,
    }
}

/// `name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 64)`: the file name of a style.
fn style_file_name(name: Option<&JsonValue>) -> Result<String, IpcError> {
    let name = match name {
        None => {
            return Err(IpcError::type_error(
                "Cannot read properties of undefined (reading 'replace')",
            ));
        }
        Some(JsonValue::Null) => {
            return Err(IpcError::type_error(
                "Cannot read properties of null (reading 'replace')",
            ));
        }
        Some(JsonValue::String(name)) => name,
        Some(_) => return Err(IpcError::type_error("name.replace is not a function")),
    };
    // Filename: replace illegal characters in the name with _ then truncate to 64 chars
    let replaced = js_regex!(r#"[/\\:*?"<>|]"#, "g").replace_all(name, |_| "_".to_owned());
    Ok(slice_utf16(&replaced, 0.0, Some(64.0)))
}

fn style_templates_dir(host: &dyn AiIpcHost) -> String {
    join(&[host.user_data_path().as_str(), STYLE_TEMPLATES_DIR])
}

fn failure(error: String) -> JsonValue {
    object(vec![("ok", JsonValue::Bool(false)), ("error", text(error))])
}

/// `ai:save-style-template`: stored in userData/style-templates/<name>.json
pub fn ai_save_style_template(
    host: &dyn AiIpcHost,
    name: Option<&JsonValue>,
    data: Option<&JsonValue>,
) -> JsonValue {
    let saved = (|| -> Result<JsonValue, IpcError> {
        let dir = style_templates_dir(host);
        let safe_name = style_file_name(name)?;
        if safe_name.is_empty() {
            return Ok(failure(host.tm("errTplNameInvalid", None)));
        }
        // `layout` (the deck's chrome skeleton) rides along verbatim when present.
        // `basedOn` (the id of the built-in design template the style was saved
        // from) is optional: it is written only when it is one, so every other
        // style's file stays as it always was.
        let data = match data {
            None => {
                return Err(IpcError::type_error(
                    "Cannot destructure property 'basedOn' of 'data' as it is undefined.",
                ));
            }
            Some(JsonValue::Null) => {
                return Err(IpcError::type_error(
                    "Cannot destructure property 'basedOn' of 'data' as it is null.",
                ));
            }
            Some(data) => data,
        };
        let based_on = saved_style_based_on(prop(data, "basedOn"));
        let mut record = without(&spread(Some(data)), &["basedOn"]);
        if let Some(based_on) = based_on {
            record.set("basedOn", text(based_on));
        }
        record.set("name", text(safe_name.as_str()));
        write_json_atomic(
            &join(&[dir.as_str(), format!("{safe_name}.json").as_str()]),
            &JsonValue::Object(record),
        )?;
        Ok(object(vec![("ok", JsonValue::Bool(true))]))
    })();
    saved.unwrap_or_else(|error| failure(error.message))
}

/// `ai:list-style-templates`
pub fn ai_list_style_templates(host: &dyn AiIpcHost) -> JsonValue {
    let dir = style_templates_dir(host);
    if !Path::new(&dir).exists() {
        return JsonValue::Array(Vec::new());
    }
    let Ok(entries) = fs::read_dir(&dir) else {
        return JsonValue::Array(Vec::new());
    };
    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            return JsonValue::Array(Vec::new());
        };
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    // readdirSync lists a folder in name order
    names.sort();
    let listed = names
        .iter()
        .filter(|file| file.ends_with(".json"))
        .filter_map(|file| {
            let raw = read_json_or_empty_at(&dir, file);
            // `raw.name` of a file that holds `null` throws: that file is left out
            if matches!(raw, JsonValue::Null) {
                return None;
            }
            let name = match coalesce(prop(&raw, "name"), None) {
                Some(name) => name.clone(),
                None => text(js_regex!(r"\.json$").replace_all(file, |_| String::new())),
            };
            let topic = coalesce(prop(&raw, "topic"), None)
                .cloned()
                .unwrap_or_else(|| text(""));
            let created_at = coalesce(prop(&raw, "createdAt"), None)
                .cloned()
                .unwrap_or_else(|| text(""));
            Some(object(vec![
                ("name", name),
                ("topic", topic),
                ("createdAt", created_at),
            ]))
        })
        .collect();
    JsonValue::Array(listed)
}

fn read_json_or_empty_at(dir: &str, file: &str) -> JsonValue {
    read_json_or_empty(&join(&[dir, file]))
}

/// `ai:load-style-template`
pub fn ai_load_style_template(host: &dyn AiIpcHost, name: Option<&JsonValue>) -> JsonValue {
    let loaded = (|| -> Result<JsonValue, IpcError> {
        let dir = style_templates_dir(host);
        let safe_name = style_file_name(name)?;
        let file_path = join(&[dir.as_str(), format!("{safe_name}.json").as_str()]);
        // `name` is a string here: `style_file_name` found its `replace`
        let name = as_str(name).unwrap_or_default();
        if !Path::new(&file_path).exists() {
            return Ok(failure(host.tm("errTplMissing", Some(name))));
        }
        let raw = read_json_or_empty(&file_path);
        if matches!(raw, JsonValue::Null) {
            return Err(IpcError::type_error(
                "Cannot read properties of null (reading 'styleSkill')",
            ));
        }
        let Some(style_skill) = prop(&raw, "styleSkill").filter(|skill| skill.truthy()) else {
            return Ok(failure(host.tm("errTplNoSkill", Some(name))));
        };
        // absent in files saved before the field existed, and in styles not saved from a template
        let based_on = saved_style_based_on(prop(&raw, "basedOn"));
        let mut answer = Obj::new();
        answer.set("ok", JsonValue::Bool(true));
        answer.set("styleSkill", style_skill.clone());
        answer.set(
            "topic",
            coalesce(prop(&raw, "topic"), None)
                .cloned()
                .unwrap_or_else(|| text("")),
        );
        if let Some(layout) = prop(&raw, "layout").filter(|layout| **layout != JsonValue::Null) {
            answer.set("layout", layout.clone());
        }
        if let Some(based_on) = based_on {
            answer.set("basedOn", text(based_on));
        }
        Ok(JsonValue::Object(answer))
    })();
    loaded.unwrap_or_else(|error| failure(error.message))
}

// ---- picture insertion ----

/// The `frame` of `addPicture`'s offset
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PictureOffset {
    pub x: f64,
    pub y: f64,
    pub cx: f64,
    pub cy: f64,
}

/// What the picture handlers use of the session's deck and the pptx engine. A
/// call of the engine that throws is an `Err`.
pub trait PictureDeck {
    /// `session.opened.deck.slides[index]` is there
    fn has_slide(&self, index: f64) -> bool;
    /// `session.opened.deck.size.cx`
    fn size_cx(&self) -> f64;
    /// `addPicture(opened, slide, { bytes, ext, offset })`: the id of the new
    /// element, `None` when the engine added nothing
    fn add_picture(
        &mut self,
        slide_index: f64,
        bytes: &[u8],
        ext: &str,
        offset: PictureOffset,
    ) -> Result<Option<String>, EngineThrew>;
    /// `editPictureSrcRect(slide, id, crop)`
    fn edit_picture_src_rect(
        &mut self,
        slide_index: f64,
        id: &str,
        crop: &CoverCrop,
    ) -> Result<(), EngineThrew>;
    /// `replacePictureBytes(opened, slide, id, bytes, ext, keepSrcRect ? { keepSrcRect: true } : undefined)`
    fn replace_picture_bytes(
        &mut self,
        slide_index: f64,
        id: &str,
        bytes: &[u8],
        ext: &str,
        keep_src_rect: bool,
    ) -> Result<bool, EngineThrew>;
    /// `slide.elements.find((el) => matchesElementRef(el, reference))?.id`
    fn find_element_id(&self, slide_index: f64, reference: &str) -> Option<String>;
    /// `slide.elements.find((el) => el.id === id && el.type === 'picture')?.transform?.offset`:
    /// the frame's `cx` and `cy` (NaN for one that is not a number)
    fn picture_frame(&self, slide_index: f64, id: &str) -> Option<(f64, f64)>;
    /// `session.fitWidthPx = px`
    fn set_fit_width_px(&mut self, px: f64);
    /// `rebuildSlide(session, slideIndex)`: the render slide, `None` for `null`
    fn rebuild_slide(&mut self, slide_index: f64) -> Option<JsonValue>;
}

/// Where the bytes of a picture come from.
#[derive(Debug, Clone, PartialEq)]
pub enum PictureSource {
    /// the host downloads it: `fetchRemoteImage(url)` and `readBodyCapped`
    Download { url: String },
    /// a user attachment the renderer resolved: no network fetch
    Bytes { bytes: Vec<u8>, ext: String },
}

/// What a picture handler worked out before its download.
#[derive(Debug, Clone, PartialEq)]
pub struct PictureTicket {
    /// the run this write belongs to: if it ended during the download, its
    /// edits are held or dropped and a late write would make the proposal
    /// stale (or land in the next run)
    run: Option<u64>,
    source: PictureSource,
    slide_index: f64,
    /// the element a replacement targets
    target_id: String,
}

impl PictureTicket {
    /// Where the bytes come from.
    pub fn source(&self) -> &PictureSource {
        &self.source
    }
}

/// `attachmentImageBytes(base64, ext)`: bytes of a user attachment the
/// renderer resolved (attachment://): keep pptx-native formats as-is, convert
/// anything else (webp/bmp/...) to PNG. `Err` is a `TypeError` of `String()`.
fn attachment_image_bytes(
    images: &dyn ImageDecoder,
    base64: &JsonValue,
    ext: Option<&JsonValue>,
) -> Result<Option<(Vec<u8>, String)>, JsTypeError> {
    let buf = buffer_from_base64(&js_string_checked(base64)?);
    if buf.is_empty() {
        return Ok(None);
    }
    let lowered = js_string_or_empty_checked(ext)?.to_lowercase();
    let norm = js_regex!(r"^jpeg$").replace_all(&lowered, |_| "jpg".to_owned());
    if norm == "png" || norm == "gif" || norm == "jpg" {
        return Ok(Some((buf, norm)));
    }
    let image = images.create_from_buffer(&buf);
    if image.is_empty() {
        return Ok(None);
    }
    Ok(Some((image.to_png(), "png".to_owned())))
}

/// The bytes source of a picture handler, or `None` for `return null`.
fn picture_source(images: &dyn ImageDecoder, op: &JsonValue) -> Option<PictureSource> {
    match prop(op, "base64").filter(|value| **value != JsonValue::Null) {
        Some(base64) => {
            let (bytes, ext) = attachment_image_bytes(images, base64, prop(op, "ext"))
                .ok()
                .flatten()?;
            Some(PictureSource::Bytes { bytes, ext })
        }
        None => {
            // the URL originates from AI tool calls (prompt-injectable via image
            // search results): the host's download refuses non-http schemes and
            // private/link-local targets
            let url = string_of(prop(op, "url")).ok()?;
            Some(PictureSource::Download { url })
        }
    }
}

/// The bytes and the extension of a picture after its download: magic bytes
/// decide, since a header-informed extension would happily store an HTML error
/// page (or an attacker "image") as a .jpg in the deck.
fn picture_bytes(source: PictureSource, downloaded: Option<Vec<u8>>) -> Option<(Vec<u8>, String)> {
    match source {
        PictureSource::Bytes { bytes, ext } => Some((bytes, ext)),
        PictureSource::Download { .. } => {
            let buf = downloaded?;
            let kind = raster_image_ext(&buf)?;
            Some((buf, kind.to_owned()))
        }
    }
}

/// The checks both picture handlers start with: `op.aiRunExpected`, the slide.
fn picture_start<D: Deck<S> + PictureDeck, S: Clone, O: Clone, R>(
    session: &Session<D, S, O, R>,
    review: &AiReview<S>,
    op: Option<&JsonValue>,
) -> Result<Option<f64>, IpcError> {
    let expected = read_prop(op, "aiRunExpected")?.is_some_and(JsonValue::truthy);
    if expected && review.run.is_none() {
        return Ok(None);
    }
    let slide_index = number_of(prop_of(op, "slideIndex"));
    if !session.deck.has_slide(slide_index) {
        return Ok(None);
    }
    Ok(Some(slide_index))
}

/// `ai:insert-image-url`, up to the download: downloads an image from a URL
/// and inserts it into the given page (image search -> insert in one step;
/// download in the main process avoids CORS). `None` answers `null`. `Err` is
/// what the handler throws before its `try`.
pub fn insert_image_begin<D: Deck<S> + PictureDeck, S: Clone, O: Clone, R>(
    session: &Session<D, S, O, R>,
    review: &AiReview<S>,
    images: &dyn ImageDecoder,
    op: Option<&JsonValue>,
) -> Result<Option<PictureTicket>, IpcError> {
    let Some(slide_index) = picture_start(session, review, op)? else {
        return Ok(None);
    };
    let run = review.run.as_ref().map(|run| run.id);
    let Some(op) = op else {
        return Ok(None);
    };
    Ok(picture_source(images, op).map(|source| PictureTicket {
        run,
        source,
        slide_index,
        target_id: String::new(),
    }))
}

/// `ai:insert-image-url`, after the download (`downloaded` is the bytes of a
/// [`PictureSource::Download`], `None` where the download failed). The answer
/// is `{ slide, sourceId }`, or `None` for `null`.
pub fn insert_image_finish<D: Deck<S> + PictureDeck, S: Clone, O: Clone, R>(
    session: &mut Session<D, S, O, R>,
    review: &AiReview<S>,
    images: &dyn ImageDecoder,
    op: &JsonValue,
    ticket: PictureTicket,
    downloaded: Option<Vec<u8>>,
) -> Option<JsonValue> {
    let slide_index = ticket.slide_index;
    let run = ticket.run;
    let (buf, ext) = picture_bytes(ticket.source, downloaded)?;
    if review.run.as_ref().map(|current| current.id) != run {
        return None;
    }
    let fit_width_px = number_of(prop(op, "fitWidthPx"));
    let (x_px, y_px) = (number_of(prop(op, "xPx")), number_of(prop(op, "yPx")));
    let (w_px, h_px) = (number_of(prop(op, "wPx")), number_of(prop(op, "hPx")));
    let base_width_px = session.deck.size_cx() / EMU_PER_PX_96;
    let scale = fit_width_px / base_width_px;
    let to_emu = |px: f64| math_round((px / scale) * EMU_PER_PX_96);
    session.push_history();
    let inserted = (|| -> Result<Option<JsonValue>, EngineThrew> {
        let offset = PictureOffset {
            x: to_emu(x_px),
            y: to_emu(y_px),
            cx: math_max(1.0, to_emu(w_px)),
            cy: math_max(1.0, to_emu(h_px)),
        };
        let Some(id) = session.deck.add_picture(slide_index, &buf, &ext, offset)? else {
            session.undo_stack.pop();
            session.schedule_history_notify();
            return Ok(None);
        };
        // The requested frame rarely matches the image's aspect ratio; never
        // stretch: fill the frame and center-crop the overflow (object-fit:
        // cover) so the layout box stays exactly where the model placed it.
        let (natural_w, natural_h) = images.create_from_buffer(&buf).size();
        if let Some(crop) = cover_crop_fractions(natural_w, natural_h, w_px, h_px) {
            session
                .deck
                .edit_picture_src_rect(slide_index, &id, &crop)?;
        }
        session.deck.set_fit_width_px(fit_width_px);
        Ok(session
            .deck
            .rebuild_slide(slide_index)
            .map(|slide| object(vec![("slide", slide), ("sourceId", text(id))])))
    })();
    inserted.unwrap_or(None)
}

/// `ai:replace-picture-url`, up to the download: downloads an image from a URL
/// and swaps it into an existing picture in place (frame/z-order/effects
/// survive). Same URL hardening as `ai:insert-image-url`.
pub fn replace_picture_begin<D: Deck<S> + PictureDeck, S: Clone, O: Clone, R>(
    session: &Session<D, S, O, R>,
    review: &AiReview<S>,
    images: &dyn ImageDecoder,
    op: Option<&JsonValue>,
) -> Result<Option<PictureTicket>, IpcError> {
    let Some(slide_index) = picture_start(session, review, op)? else {
        return Ok(None);
    };
    let Some(op) = op else {
        return Ok(None);
    };
    // The AI layer may address the picture by its durable id: translate to the
    // parse-time id the engine matches
    let reference = string_of(prop(op, "sourceId"))?;
    let target_id = session
        .deck
        .find_element_id(slide_index, &reference)
        .unwrap_or(reference);
    // same guard as ai:insert-image-url: no write after the run it belongs to ended
    let run = review.run.as_ref().map(|run| run.id);
    Ok(picture_source(images, op).map(|source| PictureTicket {
        run,
        source,
        slide_index,
        target_id,
    }))
}

/// `ai:replace-picture-url`, after the download. The answer is the rebuilt
/// render slide, or `None` for `null`.
pub fn replace_picture_finish<D: Deck<S> + PictureDeck, S: Clone, O: Clone, R>(
    session: &mut Session<D, S, O, R>,
    review: &AiReview<S>,
    images: &dyn ImageDecoder,
    op: &JsonValue,
    ticket: PictureTicket,
    downloaded: Option<Vec<u8>>,
) -> Option<JsonValue> {
    let slide_index = ticket.slide_index;
    let run = ticket.run;
    let target_id = ticket.target_id;
    let (buf, ext) = picture_bytes(ticket.source, downloaded)?;
    if review.run.as_ref().map(|current| current.id) != run {
        return None;
    }
    let keep_src_rect = prop(op, "keepSrcRect").is_some_and(JsonValue::truthy);
    session.push_history();
    let replaced = (|| -> Result<Option<JsonValue>, EngineThrew> {
        let ok = session.deck.replace_picture_bytes(
            slide_index,
            &target_id,
            &buf,
            &ext,
            keep_src_rect,
        )?;
        if !ok {
            session.undo_stack.pop();
            session.schedule_history_notify();
            return Ok(None);
        }
        // A replacement with a different aspect ratio would be stretched into
        // the surviving frame: center-crop it to cover the frame instead.
        if !keep_src_rect
            && let Some((frame_cx, frame_cy)) = session.deck.picture_frame(slide_index, &target_id)
        {
            let (natural_w, natural_h) = images.create_from_buffer(&buf).size();
            if let Some(crop) = cover_crop_fractions(natural_w, natural_h, frame_cx, frame_cy) {
                session
                    .deck
                    .edit_picture_src_rect(slide_index, &target_id, &crop)?;
            }
        }
        Ok(session.deck.rebuild_slide(slide_index))
    })();
    replaced.unwrap_or(None)
}
