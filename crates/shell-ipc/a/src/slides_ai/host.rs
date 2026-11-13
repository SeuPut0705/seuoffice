//! What the slides AI port reaches that is neither `main-core` nor a shared
//! host: the AI libraries that wait on the network (not ported into
//! `main-core`: its modules hand them out as requests), `nativeImage`, and the
//! entry's own values.

use std::sync::Arc;

use jscompat::JsonValue;
use main_core::packages::ai_provider::settings_secrets::AiSecretCodec;
use main_core::packages::i18n::Lang;
use main_core::slides::ai_ipc::{ImageDecoder, MediaToolOptions};
use shell_contract::runtime::CancelToken;

/// Batch A host of the slides AI. The two tool calls and the download are
/// blocking: the port runs them on a worker and posts the answer back to the
/// core thread; `signal` is the call's `AbortController.signal`.
pub trait SlidesAiHost: Send + Sync {
    /// `getUiLang()`
    fn ui_lang(&self) -> Lang;
    /// The registered `AiSecretCodec` of the entry (`setAiSecretCodec`), `None`
    /// where this PC cannot seal
    fn secret_codec(&self) -> Option<&dyn AiSecretCodec>;
    /// `sharedSubscriptionStatuses()`
    fn shared_subscription_statuses(&self) -> JsonValue;
    /// `aiToolCapabilities(settings, context)` of `@seuoffice/ai-search`: the
    /// routing state it asks (the Codex image backend) is the subscription
    /// service's
    fn ai_tool_capabilities(&self, settings: &JsonValue, context: &JsonValue) -> JsonValue;
    /// `generateImageTool(settingsPath, request, { mediaRoots, context, signal })`;
    /// `Err` is what it threw
    fn generate_image(
        &self,
        settings_path: &str,
        request: &JsonValue,
        options: &MediaToolOptions,
        signal: &CancelToken,
    ) -> Result<JsonValue, JsonValue>;
    /// `analyzeMediaTool(settingsPath, request, { mediaRoots, context, signal })`;
    /// `Err` is what it threw
    fn analyze_media(
        &self,
        settings_path: &str,
        request: &JsonValue,
        options: &MediaToolOptions,
        signal: &CancelToken,
    ) -> Result<JsonValue, JsonValue>;
    /// `fetchRemoteImage(url)` and `readBodyCapped(resp, MAX_REMOTE_IMAGE_BYTES)`:
    /// the bytes, `None` for a refused address, a failed status, a body over
    /// the cap or a failure of any kind (the handler's `catch` makes them all `null`)
    fn fetch_remote_image(&self, url: &str) -> Option<Vec<u8>>;
    /// `nativeImage.createFromBuffer(bytes)`: used on the core thread only
    fn image_decoder(&self) -> &dyn ImageDecoder;
}

pub type SlidesAiHostHandle = Arc<dyn SlidesAiHost>;
