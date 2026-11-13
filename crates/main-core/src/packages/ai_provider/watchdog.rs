//! `packages/ai-provider/src/watchdog.ts`: the timeouts of an LLM request,
//! the error a timeout raises, and the watchdog that aborts a request whose
//! connection went silent (its timer and signal live in `task::Rt`).

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

/// `new AiTimeoutError(ms)`
pub fn ai_timeout_error(ms: f64) -> super::task::JsError {
    super::task::JsError::new("AiTimeoutError", ai_timeout_error_message(ms))
        .with("ms", JsonValue::Number(ms))
}

/// `StreamWatchdog`, as `createStreamWatchdog` makes it: a connect timeout
/// until the response headers arrive, then an idle timeout re-armed on every
/// received byte.
#[derive(Clone)]
pub struct StreamWatchdog {
    rt: super::task::Rt,
    /// pass to fetch: aborts on caller cancel or on timeout
    pub signal: super::task::Signal,
    parent: Option<super::task::Signal>,
    parent_listener: Option<super::task::Id>,
    idle_ms: f64,
    timed_out_after: std::rc::Rc<std::cell::Cell<f64>>,
    timer: std::rc::Rc<std::cell::Cell<Option<super::task::Id>>>,
}

impl StreamWatchdog {
    /// `arm(ms)`
    fn arm(&self, ms: f64) {
        self.rt.clear_timeout(self.timer.get());
        let timed_out_after = self.timed_out_after.clone();
        let signal = self.signal.clone();
        self.timer.set(Some(self.rt.set_timeout(ms, move || {
            timed_out_after.set(ms);
            signal.abort(None);
        })));
    }

    /// data arrived: switch to (and re-arm) the idle timeout
    pub fn touch(&self) {
        self.arm(self.idle_ms);
    }

    /// `guard(run)`: a timeout abort surfaces as `AiTimeoutError`; always
    /// disposes the timer
    pub async fn guard<T>(
        &self,
        run: impl Future<Output = Result<T, super::task::JsError>>,
    ) -> Result<T, super::task::JsError> {
        let result = run.await;
        let result = match result {
            Err(_) if self.timed_out_after.get() > 0.0 => {
                Err(ai_timeout_error(self.timed_out_after.get()))
            }
            other => other,
        };
        self.rt.clear_timeout(self.timer.get());
        if let (Some(parent), Some(listener)) = (&self.parent, self.parent_listener) {
            parent.off(listener);
        }
        result
    }
}

/// `createStreamWatchdog(parent, connectMs, idleMs)`; `None` for a timeout is
/// its default.
pub fn create_stream_watchdog(
    rt: &super::task::Rt,
    parent: Option<&super::task::Signal>,
    connect_ms: Option<f64>,
    idle_ms: Option<f64>,
) -> StreamWatchdog {
    let normalized_connect_ms = normalize_watchdog_timeout(
        connect_ms.unwrap_or(AI_CONNECT_TIMEOUT_MS),
        AI_CONNECT_TIMEOUT_MS,
    );
    let normalized_idle_ms =
        normalize_watchdog_timeout(idle_ms.unwrap_or(AI_IDLE_TIMEOUT_MS), AI_IDLE_TIMEOUT_MS);
    let signal = rt.controller();
    let mut parent_listener = None;
    if let Some(parent) = parent {
        if parent.aborted() {
            signal.abort(None);
        } else {
            let target = signal.clone();
            parent_listener = Some(parent.on_abort(move |_| target.abort(None)));
        }
    }
    let wd = StreamWatchdog {
        rt: rt.clone(),
        signal,
        parent: parent.cloned(),
        parent_listener,
        idle_ms: normalized_idle_ms,
        timed_out_after: std::rc::Rc::new(std::cell::Cell::new(0.0)),
        timer: std::rc::Rc::new(std::cell::Cell::new(None)),
    };
    wd.arm(normalized_connect_ms);
    wd
}
