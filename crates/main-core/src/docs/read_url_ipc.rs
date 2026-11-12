//! `apps/docs/src/main/read-url-ipc.ts`: the rules behind the shared
//! `ai:read-url` handler.

use jscompat::{JsonValue, trim};

/// `ReadUrlFailure`: `{ ok: false, error, errorCode }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadUrlFailure {
    pub error: &'static str,
    pub error_code: &'static str,
}

/// The answer to an exception the tool promised never to throw.
pub fn unexpected_read_url_failure() -> ReadUrlFailure {
    ReadUrlFailure {
        error: "The read failed.",
        error_code: "network",
    }
}

/// `ReadUrlRequest`
#[derive(Debug, Clone, PartialEq)]
pub enum ReadUrlRequest {
    Ok { url: String, offset: f64 },
    Failure(ReadUrlFailure),
}

/// A request with a usable address, or the refusal to answer with. The
/// address only has to be a non-blank string here.
pub fn normalize_read_url_request(
    url: Option<&JsonValue>,
    offset: Option<&JsonValue>,
) -> ReadUrlRequest {
    match url {
        Some(JsonValue::String(url)) if !trim(url).is_empty() => ReadUrlRequest::Ok {
            url: url.clone(),
            offset: match offset {
                Some(JsonValue::Number(x)) => *x,
                _ => 0.0,
            },
        },
        _ => ReadUrlRequest::Failure(ReadUrlFailure {
            error: "url must be a string",
            error_code: "invalid_url",
        }),
    }
}
