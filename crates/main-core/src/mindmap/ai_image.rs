//! `apps/mindmap/src/main/ai-image.ts`: image search/generation for the mind
//! map's AI panel: the two channels the renderer calls to bring a picture
//! into the map file.
//!
//! `ipcMain.handle` stays in TypeScript. The body of the generate handler is
//! [`begin_generate_image`] / [`finish_generate_image`]; the `fetchImage`
//! handler is `fetchImageBytes(url)` and nothing else, called through the
//! ported `electron_utils::fetch_image_bytes`. `withMediaCallSignal` is
//! [`MediaCalls`] of the caller.
//!
//! Engine-waiting: `generateImageTool` (the vendors and the Codex
//! generator), which the caller runs between the begin and its finish.

use crate::packages::ai_provider::jsval::{js_string_checked, prop};
use crate::packages::ai_search::media_call_abort::{MediaCallRun, MediaCalls};
use crate::packages::ai_search::media_tools::document_media_roots;
use jscompat::node_path::host::join;
use jscompat::{JsTypeError, JsonValue};

/// the op of `generateImageTool(settingsPath, op, options)`
#[derive(Debug, Clone, PartialEq)]
pub struct GenerateImageOp {
    pub prompt: String,
    /// `undefined` for `None`
    pub aspect_ratio: Option<String>,
}

/// What the handler reaches outside this module.
pub trait MindmapImageHost {
    /// `app.getPath('userData')`
    fn user_data_dir(&mut self) -> String;
    /// `options.filePathOf(webContentsId)`: the map file this view has open,
    /// for the media roots; `None` while it has none
    fn file_path_of(&mut self, web_contents_id: f64) -> Option<String>;
    /// `sharedSubscriptionStatuses()`
    fn subscription_statuses(&mut self) -> JsonValue;
    // `generateImageTool` is not a host call: it is long and another handler
    // can cancel it, so the handler hands its arguments out as a request
    // (see `begin_generate_image`)
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

/// the handler of `MINDMAP_CHANNELS.aiGenerateImage` up to the engine call:
/// `op` is the renderer's payload; `sender_id` and `sender_destroyed` are
/// `e.sender`; `pasted_image_dir` is `options.pastedImageDir` (where a pasted
/// picture waits, the same folder the attachment reader uses). The
/// generation is a long call that `abortMediaCalls` from another handler
/// cancels, so the caller runs `generateImageTool` itself between this and
/// [`finish_generate_image`], with the signal of [`MediaCalls::aborted`]
/// (`run.call`). `Err` is the `TypeError` of a `String()` the handler
/// rejects with; the call is forgotten by then.
pub fn begin_generate_image(
    host: &mut dyn MindmapImageHost,
    calls: &mut MediaCalls,
    pasted_image_dir: &str,
    sender_id: f64,
    sender_destroyed: bool,
    op: Option<&JsonValue>,
) -> Result<GenerateImageStart, JsTypeError> {
    let call = calls.begin(sender_id, sender_destroyed);
    let request = generate_request(host, pasted_image_dir, sender_id, op);
    // the `finally` of `withMediaCallSignal` when its callback throws
    if request.is_err() {
        calls.end(sender_id, call);
    }
    Ok(GenerateImageStart {
        run: MediaCallRun { sender_id, call },
        request: request?,
    })
}

/// the arguments of `generateImageTool` in the order JavaScript evaluates
/// them: the settings path, the op (whose `String()` may throw), the options
fn generate_request(
    host: &mut dyn MindmapImageHost,
    pasted_image_dir: &str,
    sender_id: f64,
    op: Option<&JsonValue>,
) -> Result<GenerateImageRequest, JsTypeError> {
    let path = join(&[&host.user_data_dir(), "ai-settings.json"]);
    let prompt = match op.and_then(|o| prop(o, "prompt")) {
        None | Some(JsonValue::Null) => String::new(),
        Some(value) => js_string_checked(value)?,
    };
    let aspect_ratio = op
        .and_then(|o| prop(o, "aspectRatio"))
        .filter(|a| a.truthy())
        .map(js_string_checked)
        .transpose()?;
    let op = GenerateImageOp {
        prompt,
        aspect_ratio,
    };
    let file = host.file_path_of(sender_id);
    let roots = document_media_roots(file.as_deref(), Some(pasted_image_dir));
    // screen path: the statuses of the process-wide subscription service
    // decide the route
    let statuses = host.subscription_statuses();
    Ok(GenerateImageRequest {
        settings_path: path,
        op,
        media_roots: roots,
        statuses,
    })
}

/// the `finally` of the handler: the engine answered (or was aborted); the
/// call is forgotten and the answer is the handler's
pub fn finish_generate_image(
    calls: &mut MediaCalls,
    run: MediaCallRun,
    answer: JsonValue,
) -> JsonValue {
    calls.end(run.sender_id, run.call);
    answer
}
