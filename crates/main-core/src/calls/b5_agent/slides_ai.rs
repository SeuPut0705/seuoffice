//! The functions of the `b5-agent-slides-ai` part (tools/main-diff/groups/
//! b5-agent-slides-ai.ts): `slides/ai-ipc`, `slides/ai-proposal`, the two pure
//! functions of `slides/ai-stream`, `coverCropFractions` and the
//! `withStored*` functions of `packages/ai-provider`.
//!
//! The two modules are driven as a world: the session, the senders, the host
//! and a list of steps (see the specification). Each call of a fake is one
//! `logs` line, written as the TypeScript stubs write it. The clock of the
//! proposal module is virtual: a wait for writes moves it, as the
//! specification's clock does.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Value, json};

use super::super::{Answer, CallError, Context, arg};
use crate::packages::ai_provider::ai_settings_guard::GuardHost;
use crate::packages::ai_provider::jsval::{object, text as js_text};
use crate::packages::ai_provider::settings_secrets::AiSecretCodec;
use crate::packages::ai_provider::stored_settings::{
    with_stored_key_models, with_stored_main_fields, with_stored_subscription_off,
    with_stored_unknown_fields,
};
use crate::packages::ai_search::media_call_abort::MediaCalls;
use crate::packages::electron_utils::abort_on_destroyed::DestroyableSender;
use crate::packages::electron_utils::ai_run_guard::{AiRunGuardInput, AiRunGuardSlot};
use crate::packages::electron_utils::remote_image::MAX_REMOTE_IMAGE_BYTES;
use crate::packages::electron_utils::safe_remote_url::AbortSignal;
use crate::packages::pipelines::slides_cover_crop::{CoverCrop, cover_crop_fractions};
use crate::slides::ai_ipc::{
    ActiveStreams, AiIpcHost, AiSender, AiStreamRun, ImageDecoder, IpcError, MediaToolOptions,
    NativeImage, PictureDeck, PictureOffset, PictureSource, ai_analyze_media, ai_generate_image,
    ai_get_settings, ai_image_search, ai_ipc_setup, ai_list_style_templates,
    ai_load_style_template, ai_log_run_failure, ai_read_url, ai_save_sidecar,
    ai_save_style_template, ai_set_settings, ai_stream, ai_stream_cancel, ai_web_search,
    broadcast_to_windows, chat_gpt_open_browser, chat_gpt_sign_in_pages, insert_image_begin,
    insert_image_finish, read_ai_settings, replace_picture_begin, replace_picture_finish,
    slides_ai_default_fonts, slides_ai_tool_capabilities, stored_ai_settings,
    style_skill_sidecar_path, subscription_login_window_text, subscription_set_metered_accepted,
    with_metered_accepted,
};
use crate::slides::ai_proposal::{
    AI_REVIEW_SAVE_REASON, AiReview, HistoryMarker, RunBeginWake, SettleStep, WindowLives,
    accept_ai_proposal, assert_no_ai_run, begin_ai_run, begin_write, drop_ai_run_of, end_write,
    hold_ai_run, marker_of, reject_ai_proposal, run_begin_finish, run_begin_start, settle_deadline,
    settle_writes_step,
};
use crate::slides::session_state::{Deck, EngineThrew, OpRecord, OpSource, Session, SessionIds};

type Log = Rc<RefCell<Vec<Vec<Value>>>>;

static NULL: Value = Value::Null;

fn new_log() -> Log {
    Rc::new(RefCell::new(Vec::new()))
}

/// one `logs` line of the items, each as `JSON.stringify` writes it
macro_rules! logl {
    ($log:expr; $($item:expr),+ $(,)?) => {
        $log.borrow_mut().push(vec![$(serde_json::json!($item)),+])
    };
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| text.get(i * 2..i * 2 + 2))
        .filter_map(|pair| u8::from_str_radix(pair, 16).ok())
        .collect()
}

fn text<'a>(spec: &'a Value, key: &str) -> &'a str {
    spec.get(key).and_then(Value::as_str).unwrap_or("")
}

fn jv(value: &Value) -> JsonValue {
    json_value_from_serde(value)
}

fn sv(value: &JsonValue) -> Value {
    json_value_to_serde(value)
}

/// The argument at `i` as a JavaScript value; `None` is `undefined`.
fn opt_jv(args: &[Value], i: usize) -> Option<JsonValue> {
    args.get(i).map(json_value_from_serde)
}

fn error_value(message: &str) -> JsonValue {
    object(vec![
        ("$class", js_text("Error")),
        ("message", js_text(message)),
    ])
}

fn failure(error: &IpcError) -> Value {
    json!({ "error": error.message, "code": error.code })
}

// ---- the table ----

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "slides/ai-proposal.AI_REVIEW_SAVE_REASON" => Ok(Some(Value::from(AI_REVIEW_SAVE_REASON))),
        "slides/ai-proposal.beginAiRun"
        | "slides/ai-proposal.holdAiRun"
        | "slides/ai-proposal.acceptAiProposal"
        | "slides/ai-proposal.rejectAiProposal"
        | "slides/ai-proposal.dropAiRunOf"
        | "slides/ai-proposal.markerOf"
        | "slides/ai-proposal.assertNoAiRun"
        | "slides/ai-proposal.trackWrite"
        | "slides/ai-proposal.settleWrites"
        | "slides/ai-proposal.registerAiProposalIpc"
        | "slides/ai-ipc.registerAiIpc"
        | "slides/ai-ipc.registerSlidesOnlyAiIpc"
        | "slides/ai-ipc.styleSkillSidecarPath" => world_call(args, cx),
        "slides/ai-stream.storedAiSettings" => {
            let stored = jv(arg(args, 0).unwrap_or(&NULL));
            Ok(Some(sv(&stored_ai_settings(None, &stored))))
        }
        "slides/ai-stream.withMeteredAccepted" => {
            let settings = jv(arg(args, 0).unwrap_or(&NULL));
            let provider = arg(args, 1).and_then(Value::as_str).unwrap_or("");
            let accepted = matches!(arg(args, 2), Some(Value::Bool(true)));
            Ok(Some(sv(&with_metered_accepted(
                &settings, provider, accepted,
            ))))
        }
        "pipelines/slides/cover-crop.coverCropFractions" => {
            let n = |i: usize| arg(args, i).and_then(Value::as_f64).unwrap_or(f64::NAN);
            Ok(Some(match cover_crop_fractions(n(0), n(1), n(2), n(3)) {
                Some(crop) => json!({ "l": crop.l, "t": crop.t, "r": crop.r, "b": crop.b }),
                None => Value::Null,
            }))
        }
        "ai-provider/providers.withStoredUnknownFields" => {
            Ok(Some(sv(&with_stored_unknown_fields(
                &jv(arg(args, 0).unwrap_or(&NULL)),
                &jv(arg(args, 1).unwrap_or(&NULL)),
            ))))
        }
        "ai-provider/providers.withStoredSubscriptionOff" => {
            Ok(Some(sv(&with_stored_subscription_off(
                &jv(arg(args, 0).unwrap_or(&NULL)),
                &jv(arg(args, 1).unwrap_or(&NULL)),
            ))))
        }
        "ai-provider/key-model-refresh.withStoredKeyModels" => {
            Ok(Some(sv(&with_stored_key_models(
                &jv(arg(args, 0).unwrap_or(&NULL)),
                &jv(arg(args, 1).unwrap_or(&NULL)),
            ))))
        }
        "ai-provider/key-model-refresh.withStoredMainFields" => {
            Ok(Some(sv(&with_stored_main_fields(
                &jv(arg(args, 0).unwrap_or(&NULL)),
                &jv(arg(args, 1).unwrap_or(&NULL)),
            ))))
        }
        _ => return None,
    })
}

// ---- the session and its snapshots ----

/// `HistorySnapshot` as the specification projects it: `slides`, `size`,
/// `metaDirty` (the archive entries are always empty)
struct Snap {
    slides: Value,
    size: Value,
    meta_dirty: bool,
}

/// a snapshot is compared by identity
type Sn = Rc<Snap>;

fn snap_json(snap: &Snap) -> Value {
    json!({ "slides": snap.slides, "size": snap.size, "metaDirty": snap.meta_dirty })
}

/// The deck of a session: its pages as JSON, and the pptx engine the case describes.
struct FakeDeck {
    slides: Value,
    size: Value,
    fit: f64,
    engine: Value,
    log: Log,
}

impl FakeDeck {
    fn slide(&self, index: f64) -> Option<&Value> {
        if index >= 0.0 && index.fract() == 0.0 {
            self.slides.get(index as usize)
        } else {
            None
        }
    }

    fn slide_path(&self, index: f64) -> Value {
        self.slide(index)
            .and_then(|slide| slide.get("path"))
            .cloned()
            .unwrap_or(Value::Null)
    }

    fn engine(&self, key: &str) -> Option<&Value> {
        self.engine.get(key)
    }

    fn engine_throws(&self, key: &str) -> bool {
        matches!(self.engine(key), Some(Value::String(mode)) if mode == "throw")
    }
}

impl Deck<Sn> for FakeDeck {
    fn take_snapshot(&self, meta_dirty: bool) -> Sn {
        Rc::new(Snap {
            slides: self.slides.clone(),
            size: self.size.clone(),
            meta_dirty,
        })
    }

    fn restore_snapshot(&mut self, fresh: Sn) -> bool {
        self.slides = fresh.slides.clone();
        self.size = fresh.size.clone();
        fresh.meta_dirty
    }
}

impl PictureDeck for FakeDeck {
    fn has_slide(&self, index: f64) -> bool {
        self.slide(index).is_some()
    }

    fn size_cx(&self) -> f64 {
        self.size
            .get("cx")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN)
    }

    fn add_picture(
        &mut self,
        slide_index: f64,
        bytes: &[u8],
        ext: &str,
        offset: PictureOffset,
    ) -> Result<Option<String>, EngineThrew> {
        let path = self.slide_path(slide_index);
        let offset = json!({ "x": offset.x, "y": offset.y, "cx": offset.cx, "cy": offset.cy });
        logl!(self.log; "addPicture", path, hex(bytes), ext, offset);
        if self.engine_throws("addPicture") {
            return Err(EngineThrew);
        }
        Ok(match self.engine("addPicture") {
            Some(Value::Null) => None,
            Some(config) => Some(
                config
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("pic-new")
                    .to_owned(),
            ),
            None => Some("pic-new".to_owned()),
        })
    }

    fn edit_picture_src_rect(
        &mut self,
        slide_index: f64,
        id: &str,
        crop: &CoverCrop,
    ) -> Result<(), EngineThrew> {
        let path = self.slide_path(slide_index);
        let crop = json!({ "l": crop.l, "t": crop.t, "r": crop.r, "b": crop.b });
        logl!(self.log; "editPictureSrcRect", path, id, crop);
        if self.engine_throws("crop") {
            return Err(EngineThrew);
        }
        Ok(())
    }

    fn replace_picture_bytes(
        &mut self,
        slide_index: f64,
        id: &str,
        bytes: &[u8],
        ext: &str,
        keep_src_rect: bool,
    ) -> Result<bool, EngineThrew> {
        let path = self.slide_path(slide_index);
        let options = if keep_src_rect {
            json!({ "keepSrcRect": true })
        } else {
            Value::Null
        };
        logl!(self.log; "replacePictureBytes", path, id, hex(bytes), ext, options);
        if self.engine_throws("replace") {
            return Err(EngineThrew);
        }
        Ok(!matches!(self.engine("replace"), Some(Value::Bool(false))))
    }

    fn find_element_id(&self, slide_index: f64, reference: &str) -> Option<String> {
        self.slide(slide_index)?
            .get("elements")?
            .as_array()?
            .iter()
            .find(|el| el.get("ref").and_then(Value::as_str) == Some(reference))?
            .get("id")?
            .as_str()
            .map(str::to_owned)
    }

    fn picture_frame(&self, slide_index: f64, id: &str) -> Option<(f64, f64)> {
        let picture = self
            .slide(slide_index)?
            .get("elements")?
            .as_array()?
            .iter()
            .find(|el| {
                el.get("id").and_then(Value::as_str) == Some(id)
                    && el.get("type").and_then(Value::as_str) == Some("picture")
            })?;
        let offset = picture.get("transform")?.get("offset")?;
        if !matches!(offset, Value::Object(_) | Value::Array(_)) {
            return None;
        }
        let side = |key: &str| offset.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
        Some((side("cx"), side("cy")))
    }

    fn set_fit_width_px(&mut self, px: f64) {
        self.fit = px;
    }

    fn rebuild_slide(&mut self, slide_index: f64) -> Option<JsonValue> {
        logl!(self.log; "rebuildSlide", slide_index, self.fit);
        if matches!(self.engine("rebuild"), Some(Value::Null)) {
            return None;
        }
        Some(jv(&json!({ "rebuilt": slide_index, "fit": self.fit })))
    }
}

type Sess = Session<FakeDeck, Sn, Value, Value>;

/// a session and what ai-proposal.ts adds to it
struct Slot {
    session: Sess,
    review: AiReview<Sn>,
}

// ---- nativeImage ----

struct Natives {
    log: Log,
    conf: Value,
}

struct FakeImage {
    log: Log,
    empty: bool,
    png: Vec<u8>,
    size: (f64, f64),
}

impl NativeImage for FakeImage {
    fn is_empty(&self) -> bool {
        logl!(self.log; "isEmpty");
        self.empty
    }

    fn to_png(&self) -> Vec<u8> {
        logl!(self.log; "toPNG");
        self.png.clone()
    }

    fn size(&self) -> (f64, f64) {
        logl!(self.log; "getSize");
        self.size
    }
}

impl ImageDecoder for Natives {
    fn create_from_buffer(&self, bytes: &[u8]) -> Box<dyn NativeImage> {
        let key = hex(bytes);
        logl!(self.log; "createFromBuffer", key);
        let conf = self.conf.get(&key).unwrap_or(&NULL);
        let size = conf
            .get("size")
            .cloned()
            .unwrap_or_else(|| json!({ "width": 100, "height": 100 }));
        let side = |name: &str| size.get(name).and_then(Value::as_f64).unwrap_or(f64::NAN);
        Box::new(FakeImage {
            log: Rc::clone(&self.log),
            empty: matches!(conf.get("empty"), Some(Value::Bool(true))),
            png: unhex(
                conf.get("png")
                    .and_then(Value::as_str)
                    .unwrap_or("89504e47"),
            ),
            size: (side("width"), side("height")),
        })
    }
}

// ---- the senders ----

struct SenderState {
    id: f64,
    destroyed: bool,
    has_on: bool,
    no_is_destroyed: bool,
    /// the listeners of `destroyed`, by the number of `abort_on_destroyed`
    listeners: Vec<u64>,
}

type Senders = Rc<RefCell<Vec<(u64, Rc<RefCell<SenderState>>)>>>;

/// the name the TypeScript's function of a listener number has
fn listener_name(listener: u64) -> &'static str {
    match listener {
        1 => "onGone",
        2 => "onNavigation",
        _ => "onDestroyed",
    }
}

struct FakeSender {
    state: Rc<RefCell<SenderState>>,
    log: Log,
}

impl DestroyableSender for FakeSender {
    fn is_destroyed(&mut self) -> bool {
        let state = self.state.borrow();
        if state.no_is_destroyed {
            return false;
        }
        logl!(self.log; "isDestroyed", state.id);
        state.destroyed
    }

    fn once_destroyed(&mut self, listener: u64) {
        let mut state = self.state.borrow_mut();
        logl!(self.log; "once", state.id, "destroyed", listener_name(listener));
        state.listeners.push(listener);
    }

    fn remove_destroyed_listener(&mut self, listener: u64) {
        let mut state = self.state.borrow_mut();
        logl!(self.log; "removeListener", state.id, "destroyed", listener_name(listener));
        state.listeners.retain(|l| *l != listener);
    }

    fn on_navigation(&mut self, listener: u64) -> bool {
        let state = self.state.borrow();
        if !state.has_on {
            return false;
        }
        logl!(self.log; "on", state.id, "did-start-navigation", listener_name(listener));
        true
    }

    fn remove_navigation_listener(&mut self, listener: u64) {
        let state = self.state.borrow();
        logl!(self.log; "removeListener", state.id, "did-start-navigation", listener_name(listener));
    }
}

impl AiSender for FakeSender {
    fn id(&self) -> f64 {
        self.state.borrow().id
    }

    fn send(&mut self, channel: &str, payload: &JsonValue) {
        let id = self.state.borrow().id;
        let payload = sv(payload);
        logl!(self.log; "send", id, channel, payload);
    }
}

// ---- the host ----

/// `os.homedir()` and `statSync(path).isFile()`
struct RealGuard;

impl GuardHost for RealGuard {
    #[allow(deprecated)]
    fn home_dir(&self) -> String {
        std::env::home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    fn is_file(&self, path: &str) -> bool {
        std::fs::metadata(path)
            .map(|m| m.is_file())
            .unwrap_or(false)
    }
}

struct Host {
    spec: Value,
    log: Log,
    user_data: String,
    temp: String,
    windows: Vec<bool>,
    streams: ActiveStreams,
    calls: Rc<RefCell<MediaCalls>>,
    senders: Senders,
    guard: RealGuard,
}

impl Host {
    fn conf(&self, key: &str) -> Option<&Value> {
        self.spec.get(key)
    }

    /// a tool of the case: it throws or answers
    fn tool(
        &mut self,
        name: &str,
        args: Vec<Value>,
        aborted: Option<bool>,
    ) -> Result<JsonValue, JsonValue> {
        let mut line = vec![json!(name)];
        line.extend(args);
        if let Some(aborted) = aborted {
            line.push(json!(aborted));
        }
        self.log.borrow_mut().push(line);
        let conf = self
            .conf("tools")
            .and_then(|tools| tools.get(name))
            .unwrap_or(&NULL);
        if let Some(message) = conf.get("throws").and_then(Value::as_str) {
            return Err(error_value(message));
        }
        Ok(match conf.get("answer") {
            None | Some(Value::Null) => jv(&json!({ "ok": true })),
            Some(answer) => jv(answer),
        })
    }
}

impl AiIpcHost for Host {
    fn user_data_path(&self) -> String {
        self.user_data.clone()
    }

    fn temp_path(&self) -> String {
        self.temp.clone()
    }

    fn app_version(&self) -> String {
        self.conf("version")
            .and_then(Value::as_str)
            .unwrap_or("1.2.3")
            .to_owned()
    }

    fn product_name(&self) -> String {
        self.conf("product")
            .and_then(Value::as_str)
            .unwrap_or("SeuOffice")
            .to_owned()
    }

    fn document_locale(&mut self) -> String {
        logl!(self.log; "documentLocale");
        self.conf("locale")
            .and_then(Value::as_str)
            .unwrap_or("en")
            .to_owned()
    }

    fn ui_lang(&mut self) -> String {
        logl!(self.log; "getUiLang");
        self.conf("uiLang")
            .and_then(Value::as_str)
            .unwrap_or("en")
            .to_owned()
    }

    fn tm(&self, key: &str, name: Option<&str>) -> String {
        match name {
            Some(name) => format!("tm:{key}:{}", json!({ "name": name })),
            None => format!("tm:{key}"),
        }
    }

    fn secret_codec(&self) -> Option<&dyn AiSecretCodec> {
        None
    }

    fn guard_host(&self) -> &dyn GuardHost {
        &self.guard
    }

    fn warn(&mut self, message: &str) {
        logl!(self.log; "warn", message);
    }

    fn web_contents_count(&self) -> usize {
        self.windows.len()
    }

    fn web_contents_destroyed(&mut self, index: usize) -> bool {
        logl!(self.log; "wcIsDestroyed", index);
        self.windows[index]
    }

    fn web_contents_send(&mut self, index: usize, channel: &str, payload: Option<&JsonValue>) {
        match payload {
            Some(payload) => {
                let payload = sv(payload);
                logl!(self.log; "wcSend", index, channel, payload);
            }
            None => logl!(self.log; "wcSend", index, channel),
        }
    }

    fn shutdown_codex_on_quit(&mut self) {
        logl!(self.log; "appOnce", "before-quit");
    }

    fn set_rescue_fetch(&mut self) {
        logl!(self.log; "setRescueFetch");
    }

    fn set_ai_user_agent(&mut self, user_agent: &str) {
        logl!(self.log; "setAiUserAgent", user_agent);
    }

    fn ensure_subscription_ipc(&mut self, data_dir: &str) {
        logl!(self.log; "ensureSubscriptionIpc", data_dir);
    }

    fn shared_subscription_statuses(&mut self) -> JsonValue {
        logl!(self.log; "sharedSubscriptionStatuses");
        match self.conf("statuses") {
            Some(statuses) => jv(statuses),
            None => jv(&json!({})),
        }
    }

    fn ai_subscription_login_window_text(&mut self, lang: &str, provider: &str) -> JsonValue {
        logl!(self.log; "aiSubscriptionLoginWindowText", lang, provider);
        jv(&json!({ "lang": lang, "provider": provider }))
    }

    fn ai_chatgpt_sign_in_pages(&mut self, lang: &str) -> JsonValue {
        logl!(self.log; "aiChatGptSignInPages", lang);
        jv(&json!({ "pages": lang }))
    }

    fn open_external(&mut self, url: &str) -> bool {
        logl!(self.log; "openExternal", url);
        self.conf("openExternal").and_then(Value::as_str) != Some("reject")
    }

    fn run_ai_stream(
        &mut self,
        run: &AiStreamRun<'_>,
        send: &mut dyn FnMut(&JsonValue),
    ) -> Result<(), JsonValue> {
        let request = sv(run.request);
        let settings = sv(run.settings);
        let statuses = sv(&run.statuses);
        logl!(self.log; "runAiStream", request, settings, statuses);
        let script: Vec<Value> = self
            .conf("stream")
            .and_then(|stream| stream.get("script"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for op in &script {
            if let Some(chunk) = op.get("send") {
                send(&jv(chunk));
            } else if let Some(request_id) = op.get("cancel") {
                let sender = op.get("sender").and_then(Value::as_f64).unwrap_or(1.0);
                ai_stream_cancel(
                    &self.streams,
                    &mut self.calls.borrow_mut(),
                    sender,
                    Some(&jv(request_id)),
                );
            } else if let Some(id) = op.get("destroy").and_then(Value::as_f64) {
                // the window's `destroyed` event: the listener of this stream's
                // controller is the one `abort_on_destroyed` registered
                let found = self
                    .senders
                    .borrow()
                    .iter()
                    .find(|(key, _)| *key as f64 == id)
                    .map(|(_, state)| Rc::clone(state));
                if let Some(state) = found {
                    let mut state = state.borrow_mut();
                    state.destroyed = true;
                    let listeners = std::mem::take(&mut state.listeners);
                    if listeners.contains(&1) {
                        run.signal.abort();
                    }
                }
            } else if op.get("observe").is_some() {
                let aborted = run.signal.aborted();
                logl!(self.log; "aborted", aborted);
            } else if let Some(message) = op.get("throw").and_then(Value::as_str) {
                return Err(error_value(message));
            }
        }
        Ok(())
    }

    fn web_search_tool(
        &mut self,
        settings_path: &str,
        query: &str,
        max_results: f64,
    ) -> Result<JsonValue, JsonValue> {
        self.tool(
            "webSearchTool",
            vec![json!(settings_path), json!(query), json!(max_results)],
            None,
        )
    }

    fn image_search_tool(
        &mut self,
        settings_path: &str,
        query: &str,
        max_results: f64,
    ) -> Result<JsonValue, JsonValue> {
        self.tool(
            "imageSearchTool",
            vec![json!(settings_path), json!(query), json!(max_results)],
            None,
        )
    }

    fn read_url_tool(
        &mut self,
        settings_path: &str,
        url: &str,
        offset: f64,
        signal: &dyn AbortSignal,
    ) -> Result<JsonValue, JsonValue> {
        self.tool(
            "readUrlTool",
            vec![json!(settings_path), json!(url), json!(offset)],
            Some(signal.aborted()),
        )
    }

    fn generate_image_tool(
        &mut self,
        settings_path: &str,
        request: &JsonValue,
        options: &MediaToolOptions,
        signal: &dyn AbortSignal,
    ) -> Result<JsonValue, JsonValue> {
        let options = json!({ "mediaRoots": options.media_roots, "context": sv(&options.context) });
        self.tool(
            "generateImageTool",
            vec![json!(settings_path), sv(request), options],
            Some(signal.aborted()),
        )
    }

    fn analyze_media_tool(
        &mut self,
        settings_path: &str,
        request: &JsonValue,
        options: &MediaToolOptions,
        signal: &dyn AbortSignal,
    ) -> Result<JsonValue, JsonValue> {
        let options = json!({ "mediaRoots": options.media_roots, "context": sv(&options.context) });
        self.tool(
            "analyzeMediaTool",
            vec![json!(settings_path), sv(request), options],
            Some(signal.aborted()),
        )
    }

    fn ai_tool_capabilities(&mut self, settings: &JsonValue, context: &JsonValue) -> JsonValue {
        let (settings, context) = (sv(settings), sv(context));
        logl!(self.log; "aiToolCapabilities", settings, context);
        match self.conf("capabilities") {
            Some(capabilities) => jv(capabilities),
            None => jv(&json!({ "webSearch": { "available": true } })),
        }
    }
}

// ---- the world ----

struct SimWrite {
    id: u64,
    /// the virtual time it ends at; `None` never ends
    settle_at: Option<f64>,
}

struct World {
    spec: Value,
    log: Log,
    now_ms: f64,
    host: Host,
    natives: Natives,
    guard: AiRunGuardSlot,
    senders: Senders,
    streams: ActiveStreams,
    calls: Rc<RefCell<MediaCalls>>,
    /// the main session, and the other one a case can move a window to
    slots: Vec<Option<Slot>>,
    /// `sessions`: the window ids and the slot each is attached to
    wc: Vec<(f64, usize)>,
    ids: SessionIds,
    lives: WindowLives,
    clock: f64,
    writes: Vec<SimWrite>,
    setup_done: bool,
}

const DEFAULT_SIZE: &str = r#"{"cx":9144000,"cy":5143500}"#;

fn make_slot(conf: &Value, engine: &Value, log: &Log) -> Slot {
    let size = conf
        .get("size")
        .cloned()
        .unwrap_or_else(|| serde_json::from_str(DEFAULT_SIZE).expect("a size"));
    let slides = conf.get("slides").cloned().unwrap_or_else(|| json!([]));
    let deck = FakeDeck {
        slides,
        size,
        fit: conf.get("fit").and_then(Value::as_f64).unwrap_or(960.0),
        engine: engine.clone(),
        log: Rc::clone(log),
    };
    Slot {
        session: Session::new(text(conf, "path"), deck),
        review: AiReview::new(),
    }
}

/// the render slides of the deck as the specification's `buildAllRenderSlides` writes them
fn deck_json(session: &Sess) -> Value {
    let slides = session.deck.slides.as_array().cloned().unwrap_or_default();
    Value::Array(
        slides
            .iter()
            .enumerate()
            .map(|(i, slide)| {
                json!({
                    "partPath": slide.get("path"),
                    "slideNo": i + 1,
                    "fitWidthPx": session.deck.fit,
                })
            })
            .collect(),
    )
}

fn marker_json(session: &Sess, marker: &HistoryMarker<Sn>) -> Value {
    let top = marker.undo_top.as_ref().and_then(|top| {
        session
            .undo_stack
            .iter()
            .position(|snap| Rc::ptr_eq(snap, top))
    });
    json!({
        "undoTop": top.map_or(-1, |i| i as i64),
        "undoLen": marker.undo_len,
        "redoLen": marker.redo_len,
        "opSeq": marker.op_seq,
        "metaRev": marker.meta_rev,
    })
}

const GENERIC_CHANNELS: &[&str] = &[
    "ai:get-settings",
    "ai:set-settings",
    "ai:log-run-failure",
    "ai:stream",
    "ai:stream-cancel",
    "ai:web-search",
    "ai:read-url",
    "ai:image-search",
];

const REGISTERED_CHANNELS: &[&str] = &[
    "slides:ai-run-begin",
    "slides:ai-run-hold",
    "slides:ai-proposal-accept",
    "slides:ai-proposal-reject",
    "slides:ai-default-fonts",
    "slides:ai-tool-capabilities",
    "ai:generate-image",
    "ai:analyze-media",
    "ai:insert-image-url",
    "ai:replace-picture-url",
    "ai:save-sidecar",
    "ai:save-style-template",
    "ai:list-style-templates",
    "ai:load-style-template",
];

impl World {
    fn new(spec: &Value, now_ms: f64) -> World {
        let log = new_log();
        let host_spec = spec.get("host").cloned().unwrap_or(Value::Null);
        let engine = host_spec.get("engine").cloned().unwrap_or(Value::Null);
        let senders: Senders = Rc::new(RefCell::new(Vec::new()));
        let streams = ActiveStreams::new();
        let calls = Rc::new(RefCell::new(MediaCalls::new()));
        let windows = host_spec
            .get("windows")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|w| matches!(w.get("destroyed"), Some(Value::Bool(true))))
            .collect();
        let host = Host {
            user_data: text(&host_spec, "userData").to_owned(),
            temp: text(&host_spec, "temp").to_owned(),
            windows,
            spec: host_spec.clone(),
            log: Rc::clone(&log),
            streams: streams.clone(),
            calls: Rc::clone(&calls),
            senders: Rc::clone(&senders),
            guard: RealGuard,
        };
        let natives = Natives {
            log: Rc::clone(&log),
            conf: host_spec.get("native").cloned().unwrap_or(Value::Null),
        };
        let mut guard = AiRunGuardSlot::new();
        if let Some(refusals) = host_spec.get("guard").filter(|g| g.is_object()).cloned() {
            let guard_log = Rc::clone(&log);
            guard.set_ai_run_guard(Some(Box::new(move |input: &AiRunGuardInput| {
                let input_json = json!({
                    "senderId": input.sender_id,
                    "provider": input.provider,
                    "model": input.model,
                });
                logl!(guard_log; "aiRunGuard", input_json);
                refusals
                    .get(&input.provider)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })));
        }
        let empty = json!({});
        let main_conf = match spec.get("session") {
            None => Some(&empty),
            Some(Value::Null) => None,
            Some(conf) => Some(conf),
        };
        let main_wc = main_conf
            .and_then(|conf| conf.get("wc"))
            .and_then(Value::as_f64)
            .unwrap_or(1.0);
        let main = main_conf.map(|conf| make_slot(conf, &engine, &log));
        let other = make_slot(spec.get("other").unwrap_or(&empty), &engine, &log);
        let wc = if main.is_some() {
            vec![(main_wc, 0)]
        } else {
            Vec::new()
        };
        World {
            spec: spec.clone(),
            log,
            now_ms,
            host,
            natives,
            guard,
            senders,
            streams,
            calls,
            slots: vec![main, Some(other)],
            wc,
            ids: SessionIds::new(),
            lives: WindowLives::new(),
            clock: 0.0,
            writes: Vec::new(),
            setup_done: false,
        }
    }

    /// `senderOf(id)`
    fn sender(&self, id: f64) -> FakeSender {
        let key = id as u64;
        let existing = self
            .senders
            .borrow()
            .iter()
            .find(|(known, _)| *known == key)
            .map(|(_, state)| Rc::clone(state));
        let state = existing.unwrap_or_else(|| {
            let conf = self
                .spec
                .get("senders")
                .and_then(|senders| senders.get(key.to_string()))
                .unwrap_or(&NULL);
            let state = Rc::new(RefCell::new(SenderState {
                id,
                destroyed: matches!(conf.get("destroyed"), Some(Value::Bool(true))),
                has_on: !matches!(conf.get("hasOn"), Some(Value::Bool(false))),
                no_is_destroyed: matches!(conf.get("noIsDestroyed"), Some(Value::Bool(true))),
                listeners: Vec::new(),
            }));
            self.senders.borrow_mut().push((key, Rc::clone(&state)));
            state
        });
        FakeSender {
            state,
            log: Rc::clone(&self.log),
        }
    }

    /// `sessions.get(wcId)`
    fn slot_of(&self, wc: f64) -> Option<usize> {
        self.wc
            .iter()
            .find(|(id, _)| *id == wc)
            .map(|(_, slot)| *slot)
    }

    /// `sessions.get(wcId)?.path`
    fn session_path(&self, wc: f64) -> Option<String> {
        let slot = self.slot_of(wc)?;
        self.slots[slot]
            .as_ref()
            .map(|slot| slot.session.path.clone())
    }

    /// the writes that end by `self.clock` are no longer in flight
    fn settle_due(&mut self) {
        let clock = self.clock;
        let due: Vec<u64> = self
            .writes
            .iter()
            .filter(|write| write.settle_at.is_some_and(|at| at <= clock))
            .map(|write| write.id)
            .collect();
        for id in due {
            self.writes.retain(|write| write.id != id);
            if let Some(slot) = self.slots[0].as_mut() {
                end_write(&mut slot.review, id);
            }
        }
    }

    /// `settleWrites(session)` with the clock driven until it answers
    fn settle(&mut self) -> bool {
        let deadline = settle_deadline(self.clock);
        loop {
            let step = match self.slots[0].as_ref() {
                Some(slot) => settle_writes_step(&slot.review, self.clock, deadline),
                None => SettleStep::Quiet,
            };
            match step {
                SettleStep::Quiet => return true,
                SettleStep::TimedOut => return false,
                SettleStep::Wait { left_ms } => {
                    let end = self.clock + left_ms;
                    let latest = self
                        .writes
                        .iter()
                        .map(|write| write.settle_at)
                        .try_fold(f64::NEG_INFINITY, |latest, at| at.map(|at| latest.max(at)));
                    let wake = match latest {
                        Some(latest) if latest <= end => latest,
                        _ => end,
                    };
                    self.clock = self.clock.max(wake);
                    self.settle_due();
                }
            }
        }
    }

    /// the steps that run in one task: nothing here waits
    fn sync_step(&mut self, step: &Value) -> Result<Value, CallError> {
        let op = text(step, "op");
        let owner = step
            .get("owner")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN);
        let no_session = || CallError::plain("no session for this step");
        match op {
            "edit" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                if let Some(slides) = step.get("slides").filter(|s| !s.is_null()) {
                    slot.session.deck.slides = slides.clone();
                }
                if let Some(size) = step.get("size").filter(|s| !s.is_null()) {
                    slot.session.deck.size = size.clone();
                }
                Ok(Value::Null)
            }
            "push" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                slot.session.push_history();
                Ok(Value::Null)
            }
            "pushRedo" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                let snapshot = slot.session.take_snapshot();
                slot.session.redo_stack.push(snapshot);
                Ok(Value::Null)
            }
            "popUndo" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                slot.session.undo_stack.pop();
                Ok(Value::Null)
            }
            "meta" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                slot.session.mark_meta_dirty();
                Ok(Value::Null)
            }
            "journal" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                let records: Vec<OpRecord<Value>> = step
                    .get("records")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|record| OpRecord {
                        op: record.get("op").cloned().unwrap_or(Value::Null),
                        slide_id: record
                            .get("slideId")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        created: record.get("created").and_then(Value::as_array).map(|list| {
                            list.iter()
                                .filter_map(|id| id.as_str().map(str::to_owned))
                                .collect()
                        }),
                    })
                    .collect();
                slot.session.journal_ops(OpSource::Edit, records);
                Ok(Value::Null)
            }
            "masterEdit" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                slot.review.master_edit = matches!(step.get("on"), Some(Value::Bool(true)));
                Ok(Value::Null)
            }
            "batch" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                slot.session.begin_history_batch();
                Ok(Value::Null)
            }
            "registerAi" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                let snapshot = slot.session.take_snapshot();
                Ok(json!(
                    slot.session.register_ai_snapshot(&mut self.ids, &snapshot)
                ))
            }
            "begin" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                Ok(json!(begin_ai_run(
                    &mut slot.session,
                    &mut slot.review,
                    owner
                )))
            }
            "hold" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                Ok(json!(hold_ai_run(
                    &mut slot.session,
                    &mut slot.review,
                    owner
                )))
            }
            "accept" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                Ok(
                    match accept_ai_proposal(&mut slot.session, &mut slot.review, &mut self.ids) {
                        Some(id) => json!(id),
                        None => Value::Null,
                    },
                )
            }
            "reject" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                Ok(json!(reject_ai_proposal(&mut slot.review)))
            }
            "drop" => {
                let slot = self.slots[0].as_mut().ok_or_else(no_session)?;
                drop_ai_run_of(&mut slot.session, &mut slot.review, &mut self.lives, owner);
                Ok(Value::Null)
            }
            "marker" => {
                let slot = self.slots[0].as_ref().ok_or_else(no_session)?;
                Ok(marker_json(&slot.session, &marker_of(&slot.session)))
            }
            "assert" => {
                let slot = self.slots[0].as_ref().ok_or_else(no_session)?;
                Ok(match assert_no_ai_run(&slot.review) {
                    Ok(()) => json!({ "ok": true }),
                    Err(error) => json!({ "error": error.message() }),
                })
            }
            "sidecar" => Ok(match step.get("path").and_then(Value::as_str) {
                Some(path) => style_skill_sidecar_path(Some(path)).map_or(Value::Null, Value::from),
                None => Value::Null,
            }),
            "replaceSession" => {
                let wc = step.get("wc").and_then(Value::as_f64).unwrap_or(1.0);
                match self.wc.iter_mut().find(|(id, _)| *id == wc) {
                    Some(entry) => entry.1 = 1,
                    None => self.wc.push((wc, 1)),
                }
                Ok(Value::Null)
            }
            "destroy" => {
                let id = step.get("sender").and_then(Value::as_f64).unwrap_or(1.0);
                let sender = self.sender(id);
                sender.state.borrow_mut().destroyed = true;
                Ok(Value::Null)
            }
            other => Err(CallError::plain(format!("no such step: {other}"))),
        }
    }

    fn run_step(&mut self, step: &Value) -> Result<Value, CallError> {
        match text(step, "op") {
            "track" => {
                let after = step.get("after").and_then(Value::as_f64);
                let slot = self.slots[0]
                    .as_mut()
                    .ok_or_else(|| CallError::plain("no session for this step"))?;
                Ok(match begin_write(&mut slot.review) {
                    Ok(id) => {
                        self.writes.push(SimWrite {
                            id,
                            settle_at: after.map(|after| self.clock + after),
                        });
                        json!({ "started": true })
                    }
                    Err(error) => json!({ "error": error.message() }),
                })
            }
            "settle" => {
                let settled = self.settle();
                Ok(json!({ "settled": settled, "at": self.clock }))
            }
            "advance" => {
                let to = step.get("to").and_then(Value::as_f64).unwrap_or(0.0);
                self.clock = self.clock.max(to);
                self.settle_due();
                Ok(json!({ "at": self.clock }))
            }
            "setup" => {
                ai_ipc_setup(&mut self.host);
                self.setup_done = true;
                Ok(Value::Null)
            }
            "subDep" => Ok(self.sub_dep(step)),
            "invoke" => Ok(self.invoke(step)),
            _ => self.sync_step(step),
        }
    }

    /// a function of the deps `ensureSubscriptionIpc` was given
    fn sub_dep(&mut self, step: &Value) -> Value {
        let args: &[Value] = step
            .get("args")
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice);
        let arg_text = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or("");
        match text(step, "name") {
            "getSettings" => sv(&read_ai_settings(&self.host)),
            "setMeteredAccepted" => {
                let accepted = matches!(args.get(1), Some(Value::Bool(true)));
                match subscription_set_metered_accepted(&mut self.host, arg_text(0), accepted) {
                    Ok(()) => Value::Null,
                    Err(error) => failure(&error),
                }
            }
            "loginWindowText" => sv(&subscription_login_window_text(&mut self.host, arg_text(0))),
            "broadcast" => {
                let payload = opt_jv(args, 1);
                broadcast_to_windows(&mut self.host, arg_text(0), payload.as_ref());
                Value::Null
            }
            "openBrowser" => json!(chat_gpt_open_browser(&mut self.host, Some(arg_text(0)))),
            "pages" => sv(&chat_gpt_sign_in_pages(&mut self.host)),
            _ => Value::Null,
        }
    }

    /// the download of a picture handler: `fetchRemoteImage` and `readBodyCapped`.
    /// `during` runs while it is in flight.
    fn download(&mut self, url: &str, during: &[Value]) -> Option<Vec<u8>> {
        logl!(self.log; "fetchRemoteImage", url);
        for step in during {
            if self.sync_step(step).is_err() {
                return None;
            }
        }
        let response = self
            .host
            .conf("net")
            .and_then(|net| net.get(url))
            .cloned()?;
        if matches!(response.get("ok"), Some(Value::Bool(false))) {
            return None;
        }
        logl!(self.log; "readBodyCapped", MAX_REMOTE_IMAGE_BYTES);
        if matches!(response.get("tooLarge"), Some(Value::Bool(true))) {
            return None;
        }
        Some(unhex(text(&response, "hex")))
    }

    /// `handler(event, ...args)` of a channel
    fn invoke(&mut self, step: &Value) -> Value {
        let channel = text(step, "channel");
        let known = (GENERIC_CHANNELS.contains(&channel) && self.setup_done)
            || REGISTERED_CHANNELS.contains(&channel);
        if !known {
            return json!({ "error": format!("no handler: {channel}"), "code": null });
        }
        match self.handle(channel, step) {
            Ok(value) => value,
            Err(error) => failure(&error),
        }
    }

    fn handle(&mut self, channel: &str, step: &Value) -> Result<Value, IpcError> {
        let sender_id = step.get("sender").and_then(Value::as_f64).unwrap_or(1.0);
        let args: &[Value] = step
            .get("args")
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice);
        let during: Vec<Value> = step
            .get("during")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let first = opt_jv(args, 0);
        let second = opt_jv(args, 1);
        let mut sender = self.sender(sender_id);
        match channel {
            "slides:ai-run-begin" => Ok(json!(self.run_begin(sender_id, &mut sender, &during))),
            "slides:ai-run-hold" => {
                let Some(index) = self.slot_of(sender_id) else {
                    return Ok(Value::Null);
                };
                let Some(slot) = self.slots[index].as_mut() else {
                    return Ok(Value::Null);
                };
                Ok(
                    if hold_ai_run(&mut slot.session, &mut slot.review, sender_id) {
                        deck_json(&slot.session)
                    } else {
                        Value::Null
                    },
                )
            }
            "slides:ai-proposal-accept" => {
                let Some(index) = self.slot_of(sender_id) else {
                    return Ok(Value::Null);
                };
                let Some(slot) = self.slots[index].as_mut() else {
                    return Ok(Value::Null);
                };
                Ok(
                    match accept_ai_proposal(&mut slot.session, &mut slot.review, &mut self.ids) {
                        Some(snapshot_id) => {
                            json!({ "slides": deck_json(&slot.session), "snapshotId": snapshot_id })
                        }
                        None => Value::Null,
                    },
                )
            }
            "slides:ai-proposal-reject" => {
                let Some(index) = self.slot_of(sender_id) else {
                    return Ok(json!(false));
                };
                let Some(slot) = self.slots[index].as_mut() else {
                    return Ok(json!(false));
                };
                Ok(json!(reject_ai_proposal(&mut slot.review)))
            }
            "ai:get-settings" => Ok(sv(&ai_get_settings(&self.host))),
            "ai:set-settings" => {
                ai_set_settings(&mut self.host, first.as_ref())?;
                Ok(Value::Null)
            }
            "ai:log-run-failure" => {
                ai_log_run_failure(&self.host, first.as_ref(), self.now_ms);
                Ok(Value::Null)
            }
            "ai:stream" => {
                ai_stream(
                    &mut self.host,
                    &self.streams,
                    &self.guard,
                    &mut sender,
                    first.as_ref(),
                )?;
                Ok(Value::Null)
            }
            "ai:stream-cancel" => {
                ai_stream_cancel(
                    &self.streams,
                    &mut self.calls.borrow_mut(),
                    sender_id,
                    first.as_ref(),
                );
                Ok(Value::Null)
            }
            "ai:web-search" => Ok(sv(&ai_web_search(
                &mut self.host,
                first.as_ref(),
                second.as_ref(),
            )?)),
            "ai:image-search" => Ok(sv(&ai_image_search(
                &mut self.host,
                first.as_ref(),
                second.as_ref(),
            )?)),
            "ai:read-url" => Ok(sv(&ai_read_url(
                &mut self.host,
                &mut self.calls.borrow_mut(),
                &mut sender,
                first.as_ref(),
                second.as_ref(),
            ))),
            "slides:ai-default-fonts" => Ok(sv(&slides_ai_default_fonts(&mut self.host))),
            "slides:ai-tool-capabilities" => Ok(sv(&slides_ai_tool_capabilities(&mut self.host))),
            "ai:generate-image" => {
                let path = self.session_path(sender_id);
                Ok(sv(&ai_generate_image(
                    &mut self.host,
                    &mut self.calls.borrow_mut(),
                    &mut sender,
                    path.as_deref(),
                    first.as_ref(),
                )?))
            }
            "ai:analyze-media" => {
                let path = self.session_path(sender_id);
                Ok(sv(&ai_analyze_media(
                    &mut self.host,
                    &mut self.calls.borrow_mut(),
                    &mut sender,
                    path.as_deref(),
                    first.as_ref(),
                )?))
            }
            "ai:insert-image-url" | "ai:replace-picture-url" => {
                self.picture(channel == "ai:insert-image-url", sender_id, first, &during)
            }
            "ai:save-sidecar" => {
                let path = self.session_path(sender_id);
                Ok(sv(&ai_save_sidecar(path.as_deref(), first.as_ref())))
            }
            "ai:save-style-template" => Ok(sv(&ai_save_style_template(
                &self.host,
                first.as_ref(),
                second.as_ref(),
            ))),
            "ai:list-style-templates" => Ok(sv(&ai_list_style_templates(&self.host))),
            "ai:load-style-template" => Ok(sv(&ai_load_style_template(&self.host, first.as_ref()))),
            _ => Err(IpcError {
                code: None,
                message: format!("no handler: {channel}"),
            }),
        }
    }

    /// `slides:ai-run-begin`: the handler waits for the writes that began
    /// before it, and gives the run up when its window went away meanwhile.
    fn run_begin(&mut self, sender_id: f64, sender: &mut FakeSender, during: &[Value]) -> bool {
        let slot_at_start = self.slot_of(sender_id);
        let Some(ticket) = run_begin_start(&self.lives, sender_id, slot_at_start.is_some()) else {
            return false;
        };
        // what the window's task did before the handler went on
        for step in during {
            let _ = self.sync_step(step);
        }
        let settled = self.settle();
        let sender_destroyed = settled && sender.is_destroyed();
        let wake = RunBeginWake {
            settled,
            sender_destroyed,
            same_session: self.slot_of(sender_id) == slot_at_start,
        };
        let Some(slot) = slot_at_start.and_then(|index| self.slots[index].as_mut()) else {
            return false;
        };
        run_begin_finish(
            &mut slot.session,
            &mut slot.review,
            &self.lives,
            sender_id,
            ticket,
            wake,
        )
    }

    /// `ai:insert-image-url` (`insert`) and `ai:replace-picture-url`
    fn picture(
        &mut self,
        insert: bool,
        sender_id: f64,
        op: Option<JsonValue>,
        during: &[Value],
    ) -> Result<Value, IpcError> {
        let Some(index) = self.slot_of(sender_id) else {
            return Ok(Value::Null);
        };
        let begun = {
            let Some(slot) = self.slots[index].as_ref() else {
                return Ok(Value::Null);
            };
            if insert {
                insert_image_begin(&slot.session, &slot.review, &self.natives, op.as_ref())?
            } else {
                replace_picture_begin(&slot.session, &slot.review, &self.natives, op.as_ref())?
            }
        };
        let Some(ticket) = begun else {
            return Ok(Value::Null);
        };
        let downloaded = match ticket.source().clone() {
            PictureSource::Download { url } => self.download(&url, during),
            PictureSource::Bytes { .. } => None,
        };
        let Some(op) = op else {
            return Ok(Value::Null);
        };
        let Some(slot) = self.slots[index].as_mut() else {
            return Ok(Value::Null);
        };
        let answer = if insert {
            insert_image_finish(
                &mut slot.session,
                &slot.review,
                &self.natives,
                &op,
                ticket,
                downloaded,
            )
        } else {
            replace_picture_finish(
                &mut slot.session,
                &slot.review,
                &self.natives,
                &op,
                ticket,
                downloaded,
            )
        };
        Ok(answer.map_or(Value::Null, |answer| sv(&answer)))
    }

    /// the state of the main session as the specification projects it
    fn state_json(&self) -> Value {
        let Some(slot) = self.slots[0].as_ref() else {
            return Value::Null;
        };
        let session = &slot.session;
        let review = &slot.review;
        let ai_snapshots = session.ai_snapshots.as_ref().map(|snapshots| {
            Value::Array(
                snapshots
                    .iter()
                    .map(|(id, snap)| json!([id, snap_json(snap)]))
                    .collect(),
            )
        });
        let op_log = session.op_log.as_ref().map(|log| {
            Value::Array(
                log.iter()
                    .map(|entry| {
                        let ops: Vec<Value> = entry
                            .ops
                            .iter()
                            .map(|op| {
                                let mut out = serde_json::Map::new();
                                out.insert("op".to_owned(), op.op.clone());
                                if let Some(slide_id) = &op.slide_id {
                                    out.insert("slideId".to_owned(), json!(slide_id));
                                }
                                if let Some(created) = &op.created {
                                    out.insert("created".to_owned(), json!(created));
                                }
                                Value::Object(out)
                            })
                            .collect();
                        json!({ "seq": entry.seq, "source": entry.source.as_str(), "ops": ops })
                    })
                    .collect(),
            )
        });
        json!({
            "path": session.path,
            "undo": session.undo_stack.iter().map(|s| snap_json(s)).collect::<Vec<_>>(),
            "redo": session.redo_stack.iter().map(|s| snap_json(s)).collect::<Vec<_>>(),
            "batch": session.history_batch.as_ref().map(|batch| json!({
                "depth": batch.depth,
                "undoStart": batch.undo_start,
                "before": snap_json(&batch.before),
            })),
            "aiSnapshots": ai_snapshots,
            "aiRun": review.run.as_ref().map(|run| json!({
                "owner": run.owner,
                "before": snap_json(&run.before),
                "undo": run.undo.len(),
                "redo": run.redo.len(),
                "opSeq": run.op_seq,
                "metaRev": run.meta_rev,
                "known": run.known_snapshots,
            })),
            "proposal": review.proposal.as_ref().map(|proposal| json!({
                "owner": proposal.owner,
                "before": snap_json(&proposal.before),
                "after": snap_json(&proposal.after),
                "marker": marker_json(session, &proposal.marker),
            })),
            "masterEdit": review.master_edit,
            "metaDirty": session.meta_dirty,
            "metaRev": session.meta_rev,
            "opSeq": session.op_seq,
            "opLog": op_log,
            "notify": session.history_notify_scheduled,
            "broadcast": session.deck_broadcast_scheduled,
            "updates": session.deck_broadcast_updates.as_ref().map(Vec::len),
            "writes": review.writes_in_flight(),
            "fit": session.deck.fit,
            "deck": { "slides": session.deck.slides, "size": session.deck.size },
        })
    }
}

/// `[world]` where the world is `{ host, session, other, senders, steps }`: the
/// answer is `{ steps, state }`, one result per step.
fn world_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).unwrap_or(&NULL);
    let mut world = World::new(spec, cx.now_ms);
    let mut results: Vec<Value> = Vec::new();
    let mut outcome: Result<(), CallError> = Ok(());
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match world.run_step(step) {
            Ok(result) => results.push(result),
            Err(error) => {
                outcome = Err(error);
                break;
            }
        }
    }
    cx.logs.extend(world.log.take());
    outcome?;
    Ok(Some(
        json!({ "steps": results, "state": world.state_json() }),
    ))
}
