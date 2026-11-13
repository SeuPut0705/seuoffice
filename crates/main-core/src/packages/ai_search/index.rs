//! `packages/ai-search/src/index.ts`: what of the search backends is judgment
//! rather than network: the environment key of a backend and the filter that
//! drops pictures too small to use. The backends themselves (Serper, Serply,
//! SearchApi, Tavily, Parallel, Exa, Firecrawl, Keenable, DuckDuckGo) are
//! engine-waiting.

use crate::packages::ai_provider::jsval::prop;
use jscompat::{JsonValue, to_primitive, trim};

/// the keys of `SearchOptions` and the ids of its `prefer`, in the order the
/// TypeScript lists the backends
pub const SEARCH_BACKENDS: [&str; 8] = [
    "serper",
    "serply",
    "searchapi",
    "tavily",
    "parallel",
    "exa",
    "firecrawl",
    "keenable",
];

/// the environment variable of a backend (`SERPER_KEY` ... `KEENABLE_KEY`)
fn env_name(backend: &str) -> Option<&'static str> {
    match backend {
        "serper" => Some("SERPER_API_KEY"),
        "serply" => Some("SERPLY_API_KEY"),
        "searchapi" => Some("SEARCHAPI_API_KEY"),
        "tavily" => Some("TAVILY_API_KEY"),
        "parallel" => Some("PARALLEL_API_KEY"),
        "exa" => Some("EXA_API_KEY"),
        "firecrawl" => Some("FIRECRAWL_API_KEY"),
        "keenable" => Some("KEENABLE_API_KEY"),
        _ => None,
    }
}

/// `searchEnvKey(backend)`: the environment key of one backend: a developer's
/// stand-in for the key of the provider selected in settings. `env` answers
/// `process.env[name]`. A `backend` that is not one of the eight is a
/// `TypeError` in the TypeScript (`keys[backend]` is not a function).
pub fn search_env_key(
    backend: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<String, String> {
    let name = env_name(backend).ok_or_else(|| "keys[backend] is not a function".to_owned())?;
    Ok(trim(&env(name).unwrap_or_default()).to_owned())
}

/// Icons, buttons and avatars render as junk when a slide crops them into a
/// content frame: anything a backend reports smaller than this is dropped.
pub const MIN_USABLE_IMAGE_PX: f64 = 200.0;

/// `(value ?? Infinity) >= MIN_USABLE_IMAGE_PX`
fn usable_extent(value: Option<&JsonValue>) -> bool {
    match value {
        None | Some(JsonValue::Null) => true,
        Some(v) => to_primitive(Some(v)).is_ok_and(|p| p.to_number() >= MIN_USABLE_IMAGE_PX),
    }
}

/// `filterUsableImages(images)`: entries without dimension metadata are kept
/// (no evidence, no verdict).
pub fn filter_usable_images(images: &[JsonValue]) -> Vec<JsonValue> {
    images
        .iter()
        .filter(|im| {
            let width = prop(im, "width");
            let height = prop(im, "height");
            if !matches!(width, Some(JsonValue::Number(_)))
                && !matches!(height, Some(JsonValue::Number(_)))
            {
                return true;
            }
            usable_extent(width) && usable_extent(height)
        })
        .cloned()
        .collect()
}
