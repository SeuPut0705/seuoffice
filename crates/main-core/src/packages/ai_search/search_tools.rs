//! `packages/ai-search/src/search-tools.ts`: `ai:web-search` / `ai:image-search`
//! for the editors' main processes: the search provider choice turned into
//! `SearchOptions`. The default is the keyless chain (free Parallel MCP, then
//! DuckDuckGo); a key provider the user selected runs first.
//!
//! The backends are engine-waiting: [`SearchBackend`] is what the caller
//! implements. `env` answers `process.env[name]`.

use super::index::{SEARCH_BACKENDS, search_env_key};
use super::media_tools::read_ai_settings_file;
use crate::packages::ai_provider::jsval::{as_str, object, prop, prop2, str_trim, text, value_key};
use crate::packages::ai_provider::search_settings::AI_SEARCH_PROVIDERS;
use jscompat::{JsonValue, trim};

/// `SearchOptions`: every key spelled out, and the backend that runs first
#[derive(Debug, Clone, PartialEq)]
pub struct SearchOptions {
    pub serper_key: String,
    pub serply_key: String,
    pub searchapi_key: String,
    pub tavily_key: String,
    pub parallel_key: String,
    pub exa_key: String,
    pub firecrawl_key: String,
    pub keenable_key: String,
    pub prefer: &'static str,
}

impl SearchOptions {
    /// `NO_SEARCH_KEYS`: every key spelled out as absent, so the environment
    /// fills none in behind the user's selection
    fn no_keys(prefer: &'static str) -> Self {
        SearchOptions {
            serper_key: String::new(),
            serply_key: String::new(),
            searchapi_key: String::new(),
            tavily_key: String::new(),
            parallel_key: String::new(),
            exa_key: String::new(),
            firecrawl_key: String::new(),
            keenable_key: String::new(),
            prefer,
        }
    }

    /// The object the TypeScript builds, its keys in the order it writes them.
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            ("serperKey", text(self.serper_key.as_str())),
            ("serplyKey", text(self.serply_key.as_str())),
            ("searchapiKey", text(self.searchapi_key.as_str())),
            ("tavilyKey", text(self.tavily_key.as_str())),
            ("parallelKey", text(self.parallel_key.as_str())),
            ("exaKey", text(self.exa_key.as_str())),
            ("firecrawlKey", text(self.firecrawl_key.as_str())),
            ("keenableKey", text(self.keenable_key.as_str())),
            ("prefer", text(self.prefer)),
        ])
    }

    /// `{ ...NO_SEARCH_KEYS, [`${provider}Key`]: key, prefer: provider }`
    fn with_key(provider: &'static str, key: String) -> Self {
        let mut options = SearchOptions::no_keys(provider);
        match provider {
            "serper" => options.serper_key = key,
            "serply" => options.serply_key = key,
            "searchapi" => options.searchapi_key = key,
            "tavily" => options.tavily_key = key,
            "parallel" => options.parallel_key = key,
            "exa" => options.exa_key = key,
            "firecrawl" => options.firecrawl_key = key,
            _ => options.keenable_key = key,
        }
        options
    }
}

/// `keylessSearchBackend(settings)`: the backend the keyless chain starts on:
/// Keenable when it is the selected provider (its free endpoint runs only
/// then), else free Parallel search.
pub fn keyless_search_backend(settings: &JsonValue) -> &'static str {
    match prop2(Some(settings), "search", "provider") {
        Some(JsonValue::String(p)) if p == "keenable" => "keenable",
        _ => "parallel",
    }
}

/// `selectedSearchKey(settings)`: the key search provider the user selected,
/// with the key it runs on, or `None` when the search is the keyless one. The
/// stored key wins; without one, the environment key of that same provider
/// stands in. Parallel with no stored key is the free route itself, so no
/// environment key may turn it into a paid one.
pub fn selected_search_key(
    settings: &JsonValue,
    env: &dyn Fn(&str) -> Option<String>,
) -> Option<(&'static str, String)> {
    let stored = prop2(Some(settings), "search", "provider");
    let provider = AI_SEARCH_PROVIDERS
        .iter()
        .find(|meta| as_str(stored) == Some(meta.id))?
        .id;
    let stored_key = str_trim(
        prop(settings, "search")
            .and_then(|s| prop(s, "providers"))
            .and_then(|p| prop(p, provider))
            .and_then(|c| prop(c, "apiKey")),
    );
    let key = if stored_key.is_empty() {
        if provider == "parallel" {
            String::new()
        } else {
            search_env_key(provider, env).ok()?
        }
    } else {
        stored_key
    };
    (!key.is_empty()).then_some((provider, key))
}

/// `searchOptionsFromSettings(settings)`
pub fn search_options_from_settings(
    settings: &JsonValue,
    env: &dyn Fn(&str) -> Option<String>,
) -> SearchOptions {
    match selected_search_key(settings, env) {
        None => SearchOptions::no_keys(keyless_search_backend(settings)),
        Some((provider, key)) => SearchOptions::with_key(provider, key),
    }
}

/// What a backend call settles with: the answer, or the value the backend
/// threw (an `Error` is a `{ $class: 'Error', message }` object, see
/// `jsval::error_class`), so `String(err)` of it stays the caller's.
pub type SearchAnswer = Result<JsonValue, JsonValue>;

/// The search backends: engine-waiting. `Err` is a rejection; the answer is
/// the backend's own object (`{ results, method, error? }` or
/// `{ images, method, error? }`).
pub trait SearchBackend {
    /// `webSearch(query, maxResults, options)`
    fn web_search(
        &mut self,
        query: &str,
        max_results: f64,
        options: &SearchOptions,
    ) -> SearchAnswer;
    /// `imageSearch(query, maxResults, options)`
    fn image_search(
        &mut self,
        query: &str,
        max_results: f64,
        options: &SearchOptions,
    ) -> SearchAnswer;
}

/// `webSearchTool(settingsPath, query, maxResults = 6)`; `settings_file` is
/// what `readFileSync` of the path gave (`None` where the file is missing or
/// unreadable).
pub fn web_search_tool(
    backend: &mut dyn SearchBackend,
    settings_file: Option<&str>,
    query: &str,
    max_results: Option<f64>,
    env: &dyn Fn(&str) -> Option<String>,
) -> SearchAnswer {
    let options = search_options_from_settings(&read_ai_settings_file(settings_file), env);
    backend.web_search(query, max_results.unwrap_or(6.0), &options)
}

/// `imageSearchTool(settingsPath, query, maxResults = 8)`
pub fn image_search_tool(
    backend: &mut dyn SearchBackend,
    settings_file: Option<&str>,
    query: &str,
    max_results: Option<f64>,
    env: &dyn Fn(&str) -> Option<String>,
) -> SearchAnswer {
    let options = search_options_from_settings(&read_ai_settings_file(settings_file), env);
    backend.image_search(query, max_results.unwrap_or(8.0), &options)
}

/// A word every backend has results for.
const KEY_TEST_QUERY: &str = "weather";

/// `testSearchProvider(provider, apiKey)`: settings-UI test: the selected
/// backend (keyed or free) must answer one minimal query. The answer is
/// `{ ok: true }` or `{ ok: false, error }`; `Err` is a rejection of the
/// backend.
pub fn test_search_provider(
    backend: &mut dyn SearchBackend,
    provider: &str,
    api_key: &str,
) -> SearchAnswer {
    let api_key = trim(api_key);
    if api_key.is_empty() && provider != "parallel" && provider != "keenable" {
        return Ok(object(vec![
            ("ok", JsonValue::Bool(false)),
            ("error", text("API key is empty")),
        ]));
    }
    let key = |id: &str| {
        if provider == id {
            api_key.to_owned()
        } else {
            String::new()
        }
    };
    // `prefer: provider` of an id outside the eight reaches the backend as it is
    let prefer = SEARCH_BACKENDS
        .iter()
        .find(|id| **id == provider)
        .copied()
        .unwrap_or("serper");
    let options = SearchOptions {
        serper_key: key("serper"),
        serply_key: key("serply"),
        searchapi_key: key("searchapi"),
        tavily_key: key("tavily"),
        parallel_key: key("parallel"),
        exa_key: key("exa"),
        firecrawl_key: key("firecrawl"),
        keenable_key: key("keenable"),
        prefer,
    };
    let answer = backend.web_search(KEY_TEST_QUERY, 1.0, &options)?;
    let method = prop(&answer, "method");
    if as_str(method) == Some(provider) {
        return Ok(object(vec![("ok", JsonValue::Bool(true))]));
    }
    let error = if as_str(method) == Some("error") {
        match prop(&answer, "error") {
            Some(JsonValue::Null) | None => text("search failed"),
            Some(value) => value.clone(),
        }
    } else {
        text(format!(
            "{provider} did not answer (service unavailable, key rejected or quota exhausted); fell back to {}",
            value_key(method)
        ))
    };
    Ok(object(vec![
        ("ok", JsonValue::Bool(false)),
        ("error", error),
    ]))
}
