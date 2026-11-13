//! `packages/ai-provider/src/http-error.ts`: the detail text of a non-OK HTTP
//! response body. Real API errors (JSON or plain text) are surfaced as they
//! are, truncated; an HTML body (an edge or WAF block page, a login page
//! served instead of an API response) is replaced with a short readable note.
//!
//! The two patterns that read past `error code` / `ray id` skip any number of
//! tags, so a search over a body of megabytes can stop at the backtrack limit
//! of the regex engine where V8 throws a `RangeError` past a larger bound:
//! that is the error returned here, never a default text.

use jscompat::{RegexLimit, js_regex, trim, trim_start, try_js_regex};

use super::jsval::slice_to;
use super::task::JsError;

/// What V8 throws when a regular expression runs out of its backtrack stack.
fn regex_overflow(_limit: RegexLimit) -> JsError {
    JsError::new("RangeError", "Maximum call stack size exceeded")
}

/// `httpBodyDetail(body)`
pub fn http_body_detail(body: &str) -> Result<String, JsError> {
    let head = slice_to(trim_start(body), 30).to_lowercase();
    let is_html = ["<!doctype", "<html", "<head", "<body"]
        .iter()
        .any(|tag| head.starts_with(tag));
    if is_html {
        return Ok(format!(
            "the service returned a web page{} instead of an API response (likely a temporary network or gateway block) — check your connection and retry",
            describe_block_page(body)?
        ));
    }
    Ok(slice_to(body, 500))
}

/// `describeBlockPage(body)`: page title plus Cloudflare's error code / Ray
/// ID when present: enough to tell who blocked the call.
fn describe_block_page(body: &str) -> Result<String, JsError> {
    let title = js_regex!(r"<title[^>]*>([^<]*)<\/title>", "i")
        .exec(body)
        .and_then(|m| m.get(1))
        .map(|t| trim(&js_regex!(r"\s+").replace_all(t, |_| " ".to_owned())).to_owned());
    let code = try_js_regex!(r"error code:?\s*(?:<[^>]+>\s*)*(\d{3,5})", "i")
        .try_exec(body)
        .map_err(regex_overflow)?
        .and_then(|m| m.get(1));
    let ray = try_js_regex!(r"ray id:?\s*(?:<[^>]+>\s*)*([a-f0-9]{16})", "i")
        .try_exec(body)
        .map_err(regex_overflow)?
        .and_then(|m| m.get(1));
    let mut parts: Vec<String> = Vec::new();
    if let Some(title) = title.filter(|t| !t.is_empty()) {
        parts.push(format!("\"{}\"", slice_to(&title, 60)));
    }
    if let Some(code) = code {
        parts.push(format!("error code {code}"));
    }
    if let Some(ray) = ray {
        parts.push(format!("ray {ray}"));
    }
    Ok(if parts.is_empty() {
        String::new()
    } else {
        format!(" ({})", parts.join(", "))
    })
}
