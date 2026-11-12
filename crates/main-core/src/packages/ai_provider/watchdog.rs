//! `packages/ai-provider/src/watchdog.ts`: the timeouts of an LLM request and
//! the error a timeout raises. `createStreamWatchdog` itself drives a timer
//! and an abort signal over a network stream and is not ported.

use super::jsval::{ErrorClass, error_class};
use jscompat::{JsonValue, math_round, number_to_string};

pub const AI_CONNECT_TIMEOUT_MS: f64 = 60_000.0;
/// Generous on purpose: on long-context requests the gateway can legitimately
/// go silent for minutes.
pub const AI_IDLE_TIMEOUT_MS: f64 = 180_000.0;
/// Non-streaming chat waits for the full generation before headers arrive
pub const AI_CHAT_RESPONSE_TIMEOUT_MS: f64 = 180_000.0;
/// Floor for watchdog timeouts: values in (0, floor) are raised to the floor.
pub const AI_WATCHDOG_MIN_TIMEOUT_MS: f64 = 1_000.0;
/// Cap for watchdog timeouts: infinite or huge values are lowered to the cap.
pub const AI_WATCHDOG_MAX_TIMEOUT_MS: f64 = 600_000.0;

/// `normalizeWatchdogTimeout(ms, fallbackMs)`: a sane finite positive value.
/// NaN and values <= 0 fall back to the caller default; infinity and values
/// above the cap are lowered to the cap; small positives below the floor are
/// raised to the floor.
pub fn normalize_watchdog_timeout(ms: f64, fallback_ms: f64) -> f64 {
    if ms.is_nan() || ms <= 0.0 {
        return fallback_ms;
    }
    if !ms.is_finite() || ms > AI_WATCHDOG_MAX_TIMEOUT_MS {
        return AI_WATCHDOG_MAX_TIMEOUT_MS;
    }
    if ms < AI_WATCHDOG_MIN_TIMEOUT_MS {
        return AI_WATCHDOG_MIN_TIMEOUT_MS;
    }
    ms
}

/// The message of `new AiTimeoutError(ms)`.
pub fn ai_timeout_error_message(ms: f64) -> String {
    format!(
        "AI request timed out: no data received from the network for {}s",
        number_to_string(math_round(ms / 1000.0))
    )
}

/// `err instanceof AiTimeoutError`
pub fn is_ai_timeout_error(err: &JsonValue) -> bool {
    error_class(err) == ErrorClass::AiTimeoutError
}
