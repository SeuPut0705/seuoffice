//! `packages/ai-provider/src/overload-error.ts`: classifies capacity and
//! rate-limit failures (HTTP 429/503/529, gateway "engine overloaded"
//! notices, provider rate limits) so the apps can show a localized "busy"
//! message instead of the raw HTTP body.
//!
//! A thrown value is a JSON value as `jsval::error_class` describes.

use super::jsval::{thrown_cause, thrown_message};
use jscompat::{JsonValue, js_regex};

fn matches(text: &str) -> bool {
    // Status markers embedded by the protocol layers plus the notice texts
    // the gateways and providers put in error bodies.
    let overloaded = js_regex!(
        r"\bHTTP (429|503|529)\b|overload|rate.?limit|too many requests|resource.{0,12}exhausted|quota exceeded",
        "i"
    );
    if !overloaded.test(text) {
        return false;
    }
    // "credits per minute exceeded" is a rate limit; only the exhausted or
    // insufficient wording is billing.
    let credits_exhausted = js_regex!(
        r"(credits?[^\n]{0,40}(exhausted|insufficient)|(exhausted|insufficient)[^\n]{0,40}credits?)",
        "i"
    );
    if credits_exhausted.test(text) {
        return false;
    }
    // A bare 429/503/529 status marker makes it transient even when credits are named.
    let credits = js_regex!(r"credit|pricing", "i");
    let http_status = js_regex!(r"\bHTTP (429|503|529)\b", "i");
    !(credits.test(text) && !http_status.test(text))
}

/// `isAiOverloadedError(err)`: true when the error (an Error, its `cause`
/// chain, or a plain error string) looks like a transient capacity or
/// rate-limit failure that a later retry can resolve.
pub fn is_ai_overloaded_error(err: &JsonValue) -> bool {
    let mut current: Option<&JsonValue> = Some(err);
    let mut depth = 0;
    while let Some(value) = current.filter(|c| c.truthy()) {
        if depth >= 5 {
            break;
        }
        if let JsonValue::String(text) = value {
            return matches(text);
        }
        if let Some(JsonValue::String(message)) = thrown_message(value).as_ref()
            && matches(message)
        {
            return true;
        }
        current = thrown_cause(value);
        depth += 1;
    }
    false
}
