//! `apps/shell/src/main/drive/drive-consent.ts`: whether the AI the person
//! chose may be given Drive files (decision 0085). Free tiers may use what
//! they receive to improve their models and offer no way to turn that off,
//! and Google's Workspace policy forbids handing Drive data to a service that
//! trains on it, so Drive files are not given to them.

use jscompat::{JsonValue, trim};

/// `isOpenRouterFreeModel(model)` of `packages/ai-provider`: OpenRouter bills
/// nothing for a model id with this suffix
fn is_open_router_free_model(model: Option<&str>) -> bool {
    model.is_some_and(|m| trim(m).ends_with(":free"))
}

/// `isFreeAi(provider, model)`. OpenRouter counts only on a `:free` model; a
/// Gemini key carries no free marker, so Gemini always counts.
pub fn is_free_ai(provider: &str, model: Option<&str>) -> bool {
    if provider == "gemini" {
        return true;
    }
    provider == "openrouter" && is_open_router_free_model(model)
}

/// `freeAiInUse(settings)`: whether the AI the person chose is a free
/// connection; `auto` never lands on one. `settings` is the stored AI
/// settings (`provider`, `providers[provider].model`).
pub fn free_ai_in_use(settings: &JsonValue) -> bool {
    let Some(JsonValue::String(provider)) = settings.get("provider").map(|v| v.into_owned()) else {
        return false;
    };
    if provider != "gemini" && provider != "openrouter" {
        return false;
    }
    let model = settings
        .get("providers")
        .and_then(|providers| providers.get(&provider).map(|v| v.into_owned()))
        .and_then(|config| config.get("model").map(|v| v.into_owned()));
    let model = match &model {
        Some(JsonValue::String(m)) => Some(m.as_str()),
        _ => None,
    };
    is_free_ai(&provider, model)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(text: &str) -> JsonValue {
        jscompat::json_parse(text).unwrap()
    }

    #[test]
    fn gemini_always_counts_and_openrouter_only_on_a_free_model() {
        assert!(is_free_ai("gemini", Some("gemini-3.5-pro")));
        assert!(is_free_ai("openrouter", Some("meta/llama:free")));
        assert!(is_free_ai("openrouter", Some("  meta/llama:free ")));
        assert!(!is_free_ai("openrouter", Some("openai/gpt-5")));
        assert!(!is_free_ai("openrouter", None));
        assert!(!is_free_ai("anthropic", Some("x:free")));
    }

    #[test]
    fn the_chosen_provider_decides_and_auto_never_lands_on_a_free_one() {
        let free =
            settings(r#"{"provider":"openrouter","providers":{"openrouter":{"model":"a:free"}}}"#);
        assert!(free_ai_in_use(&free));
        let paid =
            settings(r#"{"provider":"openrouter","providers":{"openrouter":{"model":"a"}}}"#);
        assert!(!free_ai_in_use(&paid));
        let gemini = settings(r#"{"provider":"gemini","providers":{}}"#);
        assert!(free_ai_in_use(&gemini));
        let auto = settings(
            r#"{"provider":"auto","providers":{"gemini":{"model":"g"},"openrouter":{"model":"a:free"}}}"#,
        );
        assert!(!free_ai_in_use(&auto));
        assert!(!free_ai_in_use(&settings("{}")));
    }
}
