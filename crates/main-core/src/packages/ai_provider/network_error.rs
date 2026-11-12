//! `packages/ai-provider/src/network-error.ts`: classifies transport-level
//! connectivity failures (DNS, refused or reset connections, dead proxies)
//! so the apps can show a "network problem" message.

use super::jsval::{thrown_cause, thrown_code, thrown_message};
use jscompat::{JsRegex, JsonValue, js_regex};

// Node/undici error codes plus Chromium net-stack error names (net.fetch rescue path)
fn pattern() -> &'static JsRegex {
    js_regex!(
        r"fetch failed|socket hang up|network error|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EHOSTDOWN|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_CLOSED|UND_ERR_DESTROYED|ERR_NETWORK|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_[A-Z_]+|ERR_PROXY_CONNECTION_FAILED|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE",
        "i"
    )
}

/// `isAiNetworkError(err)`: true when the error (or anything in its `cause`
/// chain) looks like a network connectivity failure. The message text is
/// checked as well as the structured `code`.
pub fn is_ai_network_error(err: &JsonValue) -> bool {
    let pattern = pattern();
    let mut current: Option<&JsonValue> = Some(err);
    let mut depth = 0;
    while let Some(value) = current.filter(|c| c.truthy()) {
        if depth >= 5 {
            break;
        }
        if let Some(JsonValue::String(code)) = thrown_code(value)
            && pattern.test(code)
        {
            return true;
        }
        if let Some(JsonValue::String(message)) = thrown_message(value).as_ref()
            && pattern.test(message)
        {
            return true;
        }
        if let JsonValue::String(text) = value
            && pattern.test(text)
        {
            return true;
        }
        current = thrown_cause(value);
        depth += 1;
    }
    false
}
