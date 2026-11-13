//! `packages/ai-provider/src/output-cap.ts`: providers 400 (not clamp) a
//! `max_tokens` above the model's output ceiling, and the 32k default is above
//! gpt-4o / claude-3.5 / deepseek-chat. The rejection body names the ceiling:
//! retry once there and remember it per endpoint and model.
//!
//! The module's `MODEL_CAPS` is [`OutputCaps`], which the caller owns and
//! hands to every call as `&Rc<RefCell<OutputCaps>>`.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsMap, js_regex, to_number};

use super::task::{JsError, Rt};

/// The module state of `output-cap.ts`: the ceiling learned per endpoint and
/// model.
#[derive(Debug, Clone, Default)]
pub struct OutputCaps {
    model_caps: JsMap<f64>,
}

impl OutputCaps {
    /// `resetOutputCaps()`
    pub fn reset_output_caps(&mut self) {
        self.model_caps.clear();
    }

    /// The ceiling remembered for an endpoint and a model.
    pub fn known(&self, base_url: &str, model: &str) -> Option<f64> {
        self.model_caps.get(&cap_key(base_url, model)).copied()
    }
}

/// `looksLikeCeiling(n)`: round like 8192 / 64000 / 128000, unlike model-name
/// dates such as 2024.
fn looks_like_ceiling(n: f64) -> bool {
    n >= 1024.0 && (n % 1024.0 == 0.0 || n % 1000.0 == 0.0)
}

/// `parseOutputCapRejection(message, requested)`: phrasing varies per vendor
/// ("32768 > 8192, which is the maximum", "supports at most 16384", "valid
/// range is [1, 8192]"): the largest round number below the request is the
/// ceiling.
pub fn parse_output_cap_rejection(message: &str, requested: f64) -> Option<f64> {
    if !js_regex!(
        r"\bHTTP 4(00|22)\b[\s\S]*(max_?tokens|max_completion_tokens|max_?output_?tokens|output tokens|completion tokens)",
        "i"
    )
    .test(message)
    {
        return None;
    }
    let mut best = 0.0;
    for m in js_regex!(r"\d[\d,]*", "g").find_iter(message) {
        let n = to_number(&m.as_str().replace(',', ""));
        if n < requested && looks_like_ceiling(n) && n > best {
            best = n;
        }
    }
    (best > 0.0).then_some(best)
}

/// `capKey(baseUrl, model)`
fn cap_key(base_url: &str, model: &str) -> String {
    format!("{base_url}\0{model}")
}

/// `withOutputCapFallback(baseUrl, model, requested, run)`: a 400 arrives
/// before any delta reaches the caller, so the retry is invisible.
pub async fn with_output_cap_fallback<T, F, Fut>(
    _rt: &Rt,
    caps: &Rc<RefCell<OutputCaps>>,
    base_url: &str,
    model: &str,
    requested: f64,
    mut run: F,
) -> Result<T, JsError>
where
    F: FnMut(f64) -> Fut,
    Fut: Future<Output = Result<T, JsError>>,
{
    let key = cap_key(base_url, model);
    let known = caps.borrow().model_caps.get(&key).copied();
    let first = match known {
        Some(known) if known < requested => known,
        _ => requested,
    };
    match run(first).await {
        Ok(value) => Ok(value),
        Err(e) => {
            let message = e.message_or_string();
            let Some(ceiling) = parse_output_cap_rejection(&message, first) else {
                return Err(e);
            };
            caps.borrow_mut().model_caps.set(key, ceiling);
            run(ceiling).await
        }
    }
}
