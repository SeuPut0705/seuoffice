//! `apps/hwp/src/main/ai-image.ts`: picture search, generation and
//! understanding for the Hangul editor's AI panel: the channels the renderer
//! calls to bring a picture into the document or to ask what one in the
//! document shows.
//!
//! `ipcMain.handle` stays in TypeScript. The handler bodies are
//! [`generate_image`] and [`analyze_media`]; the `fetchImage` handler is
//! `fetchImageBytes(url)` and nothing else, called through the ported
//! `electron_utils::fetch_image_bytes`. `withMediaCallSignal` is
//! [`MediaCalls`] of the caller.
//!
//! Engine-waiting: `generateImageTool` and `analyzeMediaTool` (the vendors and
//! the Codex generator), behind [`HwpImageHost`].

use crate::packages::ai_provider::jsval::{js_string, object, prop, text, value_key};
use crate::packages::ai_search::media_call_abort::{MediaCallRun, MediaCalls};
use crate::packages::ai_search::media_tools::document_media_roots;
use jscompat::JsonValue;
use jscompat::node_path::host::join;

/// the options of `generateImageTool(settingsPath, op, options)`
#[derive(Debug, Clone, PartialEq)]
pub struct GenerateImageOp {
    pub prompt: String,
    /// `undefined` for `None`
    pub aspect_ratio: Option<String>,
}

/// the options of `analyzeMediaTool(settingsPath, op, options)`
#[derive(Debug, Clone, PartialEq)]
pub struct AnalyzeMediaOp {
    pub media_urls: Vec<String>,
    pub requirements: String,
}

/// `generateImageTool(settingsPath, op, { mediaRoots, context, signal })`:
/// `context` is `{ path: 'screen', statuses }`
#[derive(Debug, Clone, PartialEq)]
pub struct GenerateImageRequest {
    pub settings_path: String,
    pub op: GenerateImageOp,
    pub media_roots: Vec<String>,
    pub statuses: JsonValue,
}

/// a generation that has begun: the call to finish and what the engine is
/// asked
#[derive(Debug, Clone, PartialEq)]
pub struct GenerateImageStart {
    pub run: MediaCallRun,
    pub request: GenerateImageRequest,
}

/// `analyzeMediaTool(settingsPath, op, { context, signal })`
#[derive(Debug, Clone, PartialEq)]
pub struct AnalyzeMediaRequest {
    pub settings_path: String,
    pub op: AnalyzeMediaOp,
    pub statuses: JsonValue,
}

/// Where [`begin_analyze_media`] stands.
#[derive(Debug, Clone, PartialEq)]
pub enum AnalyzeMediaStep {
    /// the answer, with no engine call (and the call already forgotten)
    Done(JsonValue),
    /// the engine call to make, then [`finish_analyze_media`]
    Tool {
        run: MediaCallRun,
        request: AnalyzeMediaRequest,
    },
}

/// What the handlers reach outside this module.
pub trait HwpImageHost {
    /// `app.getPath('userData')`
    fn user_data_dir(&mut self) -> String;
    /// `app.getPath('temp')`
    fn temp_dir(&mut self) -> String;
    /// `options.filePathOf(webContentsId)`
    fn file_path_of(&mut self, web_contents_id: f64) -> Option<String>;
    /// `sharedSubscriptionStatuses()`
    fn subscription_statuses(&mut self) -> JsonValue;
    // `generateImageTool` and `analyzeMediaTool` are not host calls: they are
    // long and another handler can cancel them, so the handlers hand their
    // arguments out as requests (see `begin_generate_image`)
}

/// `SETTINGS_PATH()`
fn settings_path(host: &mut dyn HwpImageHost) -> String {
    join(&[&host.user_data_dir(), "ai-settings.json"])
}

/// the handler of `HWP_CHANNELS.aiGenerateImage` up to the engine call: `op`
/// is the renderer's payload; `sender_id` and `sender_destroyed` are
/// `e.sender`. The generation is a long call that `abortMediaCalls` from
/// another handler cancels, so the caller runs `generateImageTool` itself
/// between this and [`finish_generate_image`], with the signal of
/// [`MediaCalls::aborted`] (`run.call`).
pub fn begin_generate_image(
    host: &mut dyn HwpImageHost,
    calls: &mut MediaCalls,
    sender_id: f64,
    sender_destroyed: bool,
    op: Option<&JsonValue>,
) -> GenerateImageStart {
    let call = calls.begin(sender_id, sender_destroyed);
    let prompt = match op.and_then(|o| prop(o, "prompt")) {
        None | Some(JsonValue::Null) => String::new(),
        Some(value) => js_string(value),
    };
    let aspect_ratio = op
        .and_then(|o| prop(o, "aspectRatio"))
        .filter(|a| a.truthy())
        .map(js_string);
    let op = GenerateImageOp {
        prompt,
        aspect_ratio,
    };
    let path = settings_path(host);
    let file = host.file_path_of(sender_id);
    let temp = host.temp_dir();
    let roots = document_media_roots(file.as_deref(), Some(&join(&[&temp, "seuoffice-pasted"])));
    // screen path: the statuses of the process-wide subscription service
    // decide the route
    let statuses = host.subscription_statuses();
    GenerateImageStart {
        run: MediaCallRun { sender_id, call },
        request: GenerateImageRequest {
            settings_path: path,
            op,
            media_roots: roots,
            statuses,
        },
    }
}

/// the `finally` of the generate handler: the engine answered (or was
/// aborted); the call is forgotten and the answer is the handler's
pub fn finish_generate_image(
    calls: &mut MediaCalls,
    run: MediaCallRun,
    answer: JsonValue,
) -> JsonValue {
    calls.end(run.sender_id, run.call);
    answer
}

/// `/^data:image\//i`
fn is_image_data_url(url: &str) -> bool {
    url.get(..11)
        .is_some_and(|head| head.eq_ignore_ascii_case("data:image/"))
}

/// the handler of `HWP_CHANNELS.analyzeMedia` up to the engine call: the
/// panel takes a picture out of the document and sends it as an image data
/// URL. Only data URLs are taken (this editor has no path to hand over).
pub fn begin_analyze_media(
    host: &mut dyn HwpImageHost,
    calls: &mut MediaCalls,
    sender_id: f64,
    sender_destroyed: bool,
    op: Option<&JsonValue>,
) -> AnalyzeMediaStep {
    let call = calls.begin(sender_id, sender_destroyed);
    let run = MediaCallRun { sender_id, call };
    let urls: Vec<String> = match op.and_then(|o| prop(o, "mediaUrls")) {
        Some(JsonValue::Array(items)) => items.iter().map(js_string).collect(),
        _ => Vec::new(),
    };
    let media_urls: Vec<String> = urls
        .into_iter()
        .filter(|url| is_image_data_url(url))
        .collect();
    if media_urls.is_empty() {
        calls.end(sender_id, call);
        return AnalyzeMediaStep::Done(object(vec![(
            "error",
            text("no picture was given to look at"),
        )]));
    }
    let requirements = match op.and_then(|o| prop(o, "requirements")) {
        None | Some(JsonValue::Null) => String::new(),
        Some(value) => value_key(Some(value)),
    };
    let settings_path = settings_path(host);
    let statuses = host.subscription_statuses();
    AnalyzeMediaStep::Tool {
        run,
        request: AnalyzeMediaRequest {
            settings_path,
            op: AnalyzeMediaOp {
                media_urls,
                requirements,
            },
            statuses,
        },
    }
}

/// the `finally` of the analyze handler: the engine answered (or was
/// aborted); the call is forgotten and the answer is the handler's
pub fn finish_analyze_media(
    calls: &mut MediaCalls,
    run: MediaCallRun,
    answer: JsonValue,
) -> JsonValue {
    calls.end(run.sender_id, run.call);
    answer
}
