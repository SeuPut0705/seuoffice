//! `packages/ai-provider/src/registry.ts`: what the settings guard reads of
//! it: `normalizeBaseUrl`. The keys of `AI_PROVIDER_ADAPTERS` are the ids of
//! `AI_PROVIDERS` (`providers::provider_ids`) and each adapter's `meta` is
//! that catalog entry. The adapters' endpoint resolution belongs to the
//! request path and is not ported.

use super::jsval::length16;
use jscompat::trim;

/// `normalizeBaseUrl(raw, fallback)`: stored provider settings are user data:
/// a custom base URL must be a bounded http(s) URL. A query string is kept,
/// the fragment is dropped, embedded credentials are refused. The error is
/// the message the TypeScript throws.
pub fn normalize_base_url(raw: Option<&str>, fallback: &str) -> Result<String, String> {
    let candidate = trim(raw.unwrap_or(fallback));
    if candidate.is_empty() || length16(candidate) > 2048 {
        return Err("Base URL must be a non-empty http(s) URL under 2048 characters".to_owned());
    }
    let mut parsed = url::Url::parse(candidate)
        .map_err(|_| "Base URL must be a valid http(s) URL".to_owned())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Base URL must use http or https".to_owned());
    }
    if !parsed.username().is_empty() || parsed.password().is_some_and(|p| !p.is_empty()) {
        return Err(
            "Base URL must not embed credentials; put the key in the API key field".to_owned(),
        );
    }
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}
