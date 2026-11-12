//! `packages/ai-provider/src/run-error.ts`: a failed run with a
//! machine-readable cause, and the error fields of a stream chunk for any
//! thrown value.

use super::free_ai::{free_limit_of, is_free_tier_model_refusal};
use super::jsval::{ErrorClass, Obj, error_class, number, prop, text};
use super::network_error::is_ai_network_error;
use super::overload_error::is_ai_overloaded_error;
use super::protocols_shared::is_ai_credits_error;
use super::watchdog::is_ai_timeout_error;
use jscompat::JsonValue;

/// `aiStreamErrorFields(err)`: the error fields of an 'error' stream chunk
/// for a thrown value: the kind and values of an `AiRunError`, or the code
/// the existing error classes map to. Empty when the error has no
/// machine-readable cause. `now_ms` is the clock `freeLimitOf` reads.
///
/// An `AiRunError` is `{"$class":"AiRunError","kind","message","provider"?,
/// "resetsAt"?}` (see `jsval::error_class`).
pub fn ai_stream_error_fields(err: &JsonValue, now_ms: f64) -> Obj {
    let mut out = Obj::new();
    if error_class(err) == ErrorClass::AiRunError {
        out.set(
            "errorCode",
            prop(err, "kind").cloned().unwrap_or(JsonValue::Null),
        );
        if let Some(provider) = prop(err, "provider") {
            out.set("errorProvider", provider.clone());
        }
        if let Some(resets_at) = prop(err, "resetsAt") {
            out.set("errorResetsAt", resets_at.clone());
        }
        return out;
    }
    if is_ai_timeout_error(err) {
        out.set("errorCode", text("timeout"));
        return out;
    }
    if is_ai_credits_error(err) {
        out.set("errorCode", text("credits"));
        return out;
    }
    if is_ai_network_error(err) {
        out.set("errorCode", text("network"));
        return out;
    }
    // also a 429, and no retry or wait helps: the model is not on the key's free tier
    if is_free_tier_model_refusal(err) {
        out.set("errorCode", text("free-tier-model"));
        return out;
    }
    // a used-up daily free allowance is also a 429: tell it apart before "busy, try again shortly"
    if let Some(free_limit) = free_limit_of(err, now_ms) {
        out.set("errorCode", text("free-limit"));
        if let Some(at) = free_limit.resets_at {
            out.set("errorResetsAt", number(at));
        }
        return out;
    }
    if is_ai_overloaded_error(err) {
        out.set("errorCode", text("overloaded"));
    }
    out
}
