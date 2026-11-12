//! `packages/ai-provider/src/search-settings.ts`

use super::jsval::{Obj, as_str, coalesce, object, prop, prop2, text};
use jscompat::JsonValue;

/// `AiSearchProviderMeta`
#[derive(Debug, Clone, Copy)]
pub struct AiSearchProviderMeta {
    pub id: &'static str,
    pub label: &'static str,
    pub key_placeholder: &'static str,
    pub image_search: bool,
}

/// `AI_SEARCH_PROVIDERS`
pub const AI_SEARCH_PROVIDERS: &[AiSearchProviderMeta] = &[
    AiSearchProviderMeta {
        id: "serper",
        label: "Serper",
        key_placeholder: "Serper API key",
        image_search: true,
    },
    AiSearchProviderMeta {
        id: "serply",
        label: "Serply",
        key_placeholder: "Serply API key",
        image_search: true,
    },
    AiSearchProviderMeta {
        id: "searchapi",
        label: "SearchApi",
        key_placeholder: "SearchApi API key",
        image_search: true,
    },
    AiSearchProviderMeta {
        id: "tavily",
        label: "Tavily",
        key_placeholder: "tvly-...",
        image_search: false,
    },
    AiSearchProviderMeta {
        id: "parallel",
        label: "Parallel",
        key_placeholder: "Parallel API key",
        image_search: false,
    },
    AiSearchProviderMeta {
        id: "exa",
        label: "Exa",
        key_placeholder: "Exa API key",
        image_search: false,
    },
    AiSearchProviderMeta {
        id: "firecrawl",
        label: "Firecrawl",
        key_placeholder: "fc-...",
        image_search: false,
    },
    AiSearchProviderMeta {
        id: "keenable",
        label: "Keenable",
        key_placeholder: "Keenable API key",
        image_search: false,
    },
];

impl AiSearchProviderMeta {
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            ("id", text(self.id)),
            ("label", text(self.label)),
            ("keyPlaceholder", text(self.key_placeholder)),
            ("imageSearch", JsonValue::Bool(self.image_search)),
        ])
    }
}

/// `defaultAiSearchSettings()`
pub fn default_ai_search_settings() -> JsonValue {
    let mut providers = Obj::new();
    for meta in AI_SEARCH_PROVIDERS {
        providers.set(meta.id, object(vec![("apiKey", text(""))]));
    }
    object(vec![
        ("provider", text("parallel")),
        ("providers", JsonValue::Object(providers)),
    ])
}

/// `resolveAiSearchSettings(stored)`: `stored` is anything the settings
/// file held in `search`, `None` for `undefined`.
pub fn resolve_ai_search_settings(stored: Option<&JsonValue>) -> JsonValue {
    let defaults = default_ai_search_settings();
    // `if (!stored)`
    let Some(stored) = stored.filter(|s| s.truthy()) else {
        return defaults;
    };
    let default_providers = prop(&defaults, "providers")
        .cloned()
        .unwrap_or(JsonValue::Null);
    let JsonValue::Object(mut providers) = default_providers else {
        return defaults;
    };
    for meta in AI_SEARCH_PROVIDERS {
        let key = prop2(prop(stored, "providers"), meta.id, "apiKey");
        if let Some(key) = as_str(key) {
            providers.set(meta.id, object(vec![("apiKey", text(jscompat::trim(key)))]));
        }
    }
    let provider = coalesce(prop(stored, "provider"), prop(&defaults, "provider"));
    object(vec![
        ("provider", provider.cloned().unwrap_or(JsonValue::Null)),
        ("providers", JsonValue::Object(providers)),
    ])
}
