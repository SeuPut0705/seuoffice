//! `AiCoreHost` and `SlidesAiHost`: the two hosts that share what the AI
//! libraries of `@seuoffice/ai-search` answer. The tool capabilities and the
//! remote image download are main-core's; the search backends, the page
//! reader and the media tools are not in main-core and stay stubs.

use jscompat::JsonValue;
use main_core::packages::ai_provider::settings_secrets::AiSecretCodec;
use main_core::packages::ai_search::search_tools::{SearchAnswer, SearchOptions};
use main_core::packages::ai_search::tool_capabilities::ai_tool_capabilities;
use main_core::packages::ai_search::tool_routing::{
    AiToolCallContext, AiToolCallPath, ToolRoutingState,
};
use main_core::packages::i18n::Lang;
use main_core::slides::ai_ipc::{ImageDecoder, MediaToolOptions};
use shell_contract::runtime::CancelToken;
use shell_ipc_a::ai_core::{AiCoreHost, RemoteImage};
use shell_ipc_a::slides_ai::SlidesAiHost;

use super::native_image::Decoder;
use super::{
    UiLang, codec, codex_image_available, fetch, not_built, subscription_statuses, unbuilt,
};

/// `{ path, statuses?, dataDir? }`
fn context_of(value: &JsonValue) -> AiToolCallContext {
    let field = |key: &str| match value {
        JsonValue::Object(object) => object.get(key),
        _ => None,
    };
    AiToolCallContext {
        path: match field("path") {
            Some(JsonValue::String(path)) if path == "headless" => AiToolCallPath::Headless,
            _ => AiToolCallPath::Screen,
        },
        statuses: field("statuses").cloned(),
        data_dir: match field("dataDir") {
            Some(JsonValue::String(dir)) => Some(dir.clone()),
            _ => None,
        },
    }
}

/// `aiToolCapabilities(settings, context)`: main-core's, over the Codex image
/// state of the subscription service. The Codex generator is not built, so
/// none is registered.
fn tool_capabilities(settings: &JsonValue, context: &JsonValue) -> JsonValue {
    let mut state = ToolRoutingState::default();
    state
        .image_backend
        .set_codex_image_generation_available(codex_image_available());
    match ai_tool_capabilities(&state, Some(settings), &context_of(context), &|name| {
        std::env::var(name).ok()
    }) {
        Ok(capabilities) => capabilities,
        Err(message) => {
            // `getProviderAdapter` threw for an id the registry lacks: the host has no way to throw
            eprintln!("shell: aiToolCapabilities: {message}");
            JsonValue::Object(jscompat::JsObject::new())
        }
    }
}

/// `fetchRemoteImage(url)` with the temp folder the generated images live in
fn remote_image(url: &str) -> Option<RemoteImage> {
    fetch::remote_image(url, &std::env::temp_dir().to_string_lossy())
}

pub struct AiCore {
    pub lang: UiLang,
}

impl AiCoreHost for AiCore {
    fn ui_lang(&self) -> Lang {
        self.lang.get()
    }

    fn subscription_statuses(&self) -> JsonValue {
        subscription_statuses()
    }

    /// The shell has no `--headless-export` entry
    fn is_headless_mode(&self) -> bool {
        false
    }

    fn ai_tool_capabilities(&self, settings: &JsonValue, context: &JsonValue) -> JsonValue {
        tool_capabilities(settings, context)
    }

    fn web_search(&self, _: &str, _: f64, _: &SearchOptions) -> SearchAnswer {
        unbuilt("AiCoreHost::web_search");
        Err(not_built())
    }

    fn image_search(&self, _: &str, _: f64, _: &SearchOptions) -> SearchAnswer {
        unbuilt("AiCoreHost::image_search");
        Err(not_built())
    }

    fn read_url(&self, _: &str, _: &str, _: f64, _: &CancelToken) -> Result<JsonValue, JsonValue> {
        unbuilt("AiCoreHost::read_url");
        Err(not_built())
    }

    fn fetch_remote_image(&self, url: &str) -> Option<RemoteImage> {
        remote_image(url)
    }
}

pub struct Slides {
    lang: UiLang,
    decoder: Decoder,
}

impl Slides {
    pub fn new(lang: UiLang) -> Slides {
        Slides {
            lang,
            decoder: Decoder,
        }
    }
}

impl SlidesAiHost for Slides {
    fn ui_lang(&self) -> Lang {
        self.lang.get()
    }

    fn secret_codec(&self) -> Option<&dyn AiSecretCodec> {
        codec()
    }

    fn shared_subscription_statuses(&self) -> JsonValue {
        subscription_statuses()
    }

    fn ai_tool_capabilities(&self, settings: &JsonValue, context: &JsonValue) -> JsonValue {
        tool_capabilities(settings, context)
    }

    fn generate_image(
        &self,
        _: &str,
        _: &JsonValue,
        _: &MediaToolOptions,
        _: &CancelToken,
    ) -> Result<JsonValue, JsonValue> {
        unbuilt("SlidesAiHost::generate_image");
        Err(not_built())
    }

    fn analyze_media(
        &self,
        _: &str,
        _: &JsonValue,
        _: &MediaToolOptions,
        _: &CancelToken,
    ) -> Result<JsonValue, JsonValue> {
        unbuilt("SlidesAiHost::analyze_media");
        Err(not_built())
    }

    fn fetch_remote_image(&self, url: &str) -> Option<Vec<u8>> {
        remote_image(url).map(|image| image.bytes)
    }

    fn image_decoder(&self) -> &dyn ImageDecoder {
        &self.decoder
    }
}
