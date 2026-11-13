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
use crate::packages::ai_search::media_call_abort::{MediaCallId, MediaCalls};
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
    /// `generateImageTool(settingsPath, op, { mediaRoots, context, signal })`;
    /// `context` is `{ path: 'screen', statuses }`, `signal` is
    /// `calls.aborted(call)`
    fn generate_image_tool(
        &mut self,
        calls: &MediaCalls,
        call: MediaCallId,
        settings_path: &str,
        op: &GenerateImageOp,
        media_roots: &[String],
        statuses: &JsonValue,
    ) -> JsonValue;
    /// `analyzeMediaTool(settingsPath, op, { context, signal })`
    fn analyze_media_tool(
        &mut self,
        calls: &MediaCalls,
        call: MediaCallId,
        settings_path: &str,
        op: &AnalyzeMediaOp,
        statuses: &JsonValue,
    ) -> JsonValue;
}

/// `SETTINGS_PATH()`
fn settings_path(host: &mut dyn HwpImageHost) -> String {
    join(&[&host.user_data_dir(), "ai-settings.json"])
}

/// the handler of `HWP_CHANNELS.aiGenerateImage`: `op` is the renderer's
/// payload; `sender_id` and `sender_destroyed` are `e.sender`
pub fn generate_image(
    host: &mut dyn HwpImageHost,
    calls: &mut MediaCalls,
    sender_id: f64,
    sender_destroyed: bool,
    op: Option<&JsonValue>,
) -> JsonValue {
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
    let answer = host.generate_image_tool(calls, call, &path, &op, &roots, &statuses);
    calls.end(sender_id, call);
    answer
}

/// `/^data:image\//i`
fn is_image_data_url(url: &str) -> bool {
    url.get(..11)
        .is_some_and(|head| head.eq_ignore_ascii_case("data:image/"))
}

/// the handler of `HWP_CHANNELS.analyzeMedia`: the panel takes a picture out
/// of the document and sends it as an image data URL. Only data URLs are
/// taken (this editor has no path to hand over).
pub fn analyze_media(
    host: &mut dyn HwpImageHost,
    calls: &mut MediaCalls,
    sender_id: f64,
    sender_destroyed: bool,
    op: Option<&JsonValue>,
) -> JsonValue {
    let call = calls.begin(sender_id, sender_destroyed);
    let urls: Vec<String> = match op.and_then(|o| prop(o, "mediaUrls")) {
        Some(JsonValue::Array(items)) => items.iter().map(js_string).collect(),
        _ => Vec::new(),
    };
    let media_urls: Vec<String> = urls
        .into_iter()
        .filter(|url| is_image_data_url(url))
        .collect();
    let answer = if media_urls.is_empty() {
        object(vec![("error", text("no picture was given to look at"))])
    } else {
        let requirements = match op.and_then(|o| prop(o, "requirements")) {
            None | Some(JsonValue::Null) => String::new(),
            Some(value) => value_key(Some(value)),
        };
        let path = settings_path(host);
        let statuses = host.subscription_statuses();
        let request = AnalyzeMediaOp {
            media_urls,
            requirements,
        };
        host.analyze_media_tool(calls, call, &path, &request, &statuses)
    };
    calls.end(sender_id, call);
    answer
}
