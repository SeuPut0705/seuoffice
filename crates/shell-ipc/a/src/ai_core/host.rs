//! What the shared AI channels reach that is neither `main-core` nor a shared
//! host: the libraries `main-core` does not hold (the search backends, the
//! page reader, the remote image download), the AI routing state of the
//! subscription service, the entry's own values, and the queue of AI content
//! the tabs hand to a new docs tab.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use jscompat::JsonValue;
use main_core::packages::ai_search::search_tools::{SearchAnswer, SearchOptions};
use main_core::packages::i18n::Lang;
use shell_contract::runtime::CancelToken;

/// The answer of `fetchRemoteImage(url)` for a response that is ok: its body
/// as `readBodyCapped(resp, MAX_REMOTE_IMAGE_BYTES)` read it, and its
/// `content-type` header (`""` when it has none)
pub struct RemoteImage {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

/// Batch A host of the shared AI channels. The calls that wait on the network
/// (`web_search`, `image_search`, `read_url`, `fetch_remote_image`) are
/// blocking: the port runs each on a worker and posts the answer back to the
/// core thread; `signal` is the call's `AbortController.signal`.
pub trait AiCoreHost: Send + Sync {
    /// `getUiLang()`
    fn ui_lang(&self) -> Lang;
    /// `sharedSubscriptionStatuses()`
    fn subscription_statuses(&self) -> JsonValue;
    /// `isHeadlessMode()`: a headless export changes no setting
    fn is_headless_mode(&self) -> bool;
    /// `aiToolCapabilities(settings, context)` of `@seuoffice/ai-search`: the
    /// routing state it asks (the Codex image backend) is the subscription
    /// service's. `context` is `{ path: 'screen', statuses }`.
    fn ai_tool_capabilities(&self, settings: &JsonValue, context: &JsonValue) -> JsonValue;
    /// `webSearch(query, maxResults, options)` of `@seuoffice/ai-search`
    /// (Serper, Serply, SearchApi, Tavily, Parallel, Exa, Firecrawl, Keenable,
    /// DuckDuckGo); `Err` is what it threw
    fn web_search(&self, query: &str, max_results: f64, options: &SearchOptions) -> SearchAnswer;
    /// `imageSearch(query, maxResults, options)`; `Err` is what it threw
    fn image_search(&self, query: &str, max_results: f64, options: &SearchOptions) -> SearchAnswer;
    /// `readUrlTool(settingsPath, url, offset, { signal })` of
    /// `@seuoffice/ai-search`; `Err` is what it threw
    fn read_url(
        &self,
        settings_path: &str,
        url: &str,
        offset: f64,
        signal: &CancelToken,
    ) -> Result<JsonValue, JsonValue>;
    /// `fetchRemoteImage(url)` and `readBodyCapped(resp, MAX_REMOTE_IMAGE_BYTES)`:
    /// `None` for a refused address, a response that is not ok, a body over
    /// the cap or a failure of any kind (the handler's `catch` makes them all
    /// `null`)
    fn fetch_remote_image(&self, url: &str) -> Option<RemoteImage>;
}

pub type AiCoreHostHandle = Arc<dyn AiCoreHost>;

/// `pendingAiDocContents` of docs-main: the AI-authored content a fresh blank
/// docs tab waits for, by the tab's view. The shell inserts one, and hands the
/// same to what carries out `queueDocsAiContent` for the tabs.
#[derive(Default)]
pub struct PendingAiDocs {
    contents: Mutex<HashMap<i64, serde_json::Value>>,
}

pub type PendingAiDocsHost = Arc<PendingAiDocs>;

impl PendingAiDocs {
    /// `queueDocsAiContent(wcId, content)`
    pub fn queue(&self, wc_id: i64, content: &serde_json::Value) {
        self.contents
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(wc_id, content.clone());
    }

    /// `pendingAiDocContents.get(id) ?? null`, then `delete(id)`
    pub fn consume(&self, wc_id: i64) -> Option<serde_json::Value> {
        self.contents
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&wc_id)
    }
}
