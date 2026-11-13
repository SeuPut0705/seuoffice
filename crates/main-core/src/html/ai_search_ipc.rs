//! `apps/html/src/main/ai-search-ipc.ts`: standalone search IPC for the html
//! main process: the shared `ai:*` channels are registered app-wide by the
//! docs main in shell mode, so tab mode must not register them again.
//!
//! `ipcMain.handle` stays in TypeScript; the handler bodies are
//! [`HtmlAiSearchIpc::web_search`] and [`HtmlAiSearchIpc::image_search`], and
//! the module-level `searchIpcRegistered` is [`HtmlAiSearchIpc`]. `env`
//! answers `process.env[name]`.
//!
//! Engine-waiting: the search backends ([`SearchBackend`]).

use crate::packages::ai_provider::jsval::{object, string_list, text, thrown_to_string, value_key};
use crate::packages::ai_search::search_tools::{SearchBackend, image_search_tool, web_search_tool};
use jscompat::{JsTypeError, JsonValue};

/// the channel of the web search handler
pub const AI_WEB_SEARCH_CHANNEL: &str = "ai:web-search";
/// the channel of the image search handler
pub const AI_IMAGE_SEARCH_CHANNEL: &str = "ai:image-search";

/// What the handlers reach outside this module.
pub trait HtmlAiSearchHost: SearchBackend {
    /// `readFileSync(join(app.getPath('userData'), 'ai-settings.json'))`;
    /// `None` where the file is missing or unreadable
    fn settings_file(&mut self) -> Option<String>;
}

/// `let searchIpcRegistered = false`
#[derive(Debug, Default)]
pub struct HtmlAiSearchIpc {
    registered: bool,
}

/// `typeof maxResults === 'number' ? maxResults : fallback`
fn max_results_of(max_results: Option<&JsonValue>, fallback: f64) -> f64 {
    match max_results {
        Some(JsonValue::Number(n)) => *n,
        _ => fallback,
    }
}

impl HtmlAiSearchIpc {
    pub fn new() -> Self {
        Self::default()
    }

    /// `registerHtmlAiSearchIpc()`: the channels to register; none on a
    /// second call.
    pub fn register(&mut self) -> Vec<&'static str> {
        if self.registered {
            return Vec::new();
        }
        self.registered = true;
        vec![AI_WEB_SEARCH_CHANNEL, AI_IMAGE_SEARCH_CHANNEL]
    }
}

/// the handler of `ai:web-search`: `query` and `max_results` are the
/// renderer's arguments; `Err` is the `TypeError` that `String(err)` throws
/// inside the `catch`
pub fn web_search(
    host: &mut dyn HtmlAiSearchHost,
    env: &dyn Fn(&str) -> Option<String>,
    query: Option<&JsonValue>,
    max_results: Option<&JsonValue>,
) -> Result<JsonValue, JsTypeError> {
    let file = host.settings_file();
    match web_search_tool(
        host,
        file.as_deref(),
        &value_key(query),
        Some(max_results_of(max_results, 6.0)),
        env,
    ) {
        Ok(answer) => Ok(answer),
        Err(thrown) => Ok(object(vec![
            ("results", string_list(&[])),
            ("method", text("error")),
            ("error", text(thrown_to_string(&thrown)?)),
        ])),
    }
}

/// the handler of `ai:image-search`; `Err` is the `TypeError` that
/// `String(err)` throws inside the `catch`
pub fn image_search(
    host: &mut dyn HtmlAiSearchHost,
    env: &dyn Fn(&str) -> Option<String>,
    query: Option<&JsonValue>,
    max_results: Option<&JsonValue>,
) -> Result<JsonValue, JsTypeError> {
    let file = host.settings_file();
    match image_search_tool(
        host,
        file.as_deref(),
        &value_key(query),
        Some(max_results_of(max_results, 8.0)),
        env,
    ) {
        Ok(answer) => Ok(answer),
        Err(thrown) => Ok(object(vec![
            ("images", string_list(&[])),
            ("method", text("error")),
            ("error", text(thrown_to_string(&thrown)?)),
        ])),
    }
}
