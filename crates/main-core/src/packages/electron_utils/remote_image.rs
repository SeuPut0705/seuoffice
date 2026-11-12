//! `packages/electron-utils/src/remote-image.ts`.
//!
//! The downloads go through [`fetch_with_ssrf_guard`], so the resolver and the
//! fetcher are the caller's. The retry sleep is the fetcher's (`Fetcher::sleep`).

use jscompat::{math_round, number_to_string, to_number};

use super::generated_images::read_generated_image;
use super::safe_remote_url::{
    FetchWithSsrfGuardOptions, Fetcher, Resolver, Response, fetch_with_ssrf_guard,
};

const RETRY_DELAYS_MS: [f64; 2] = [500.0, 1500.0];

/// Cap for a single downloaded picture; the model can point any insert path at an arbitrary URL.
pub const MAX_REMOTE_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

/// `ResponseTooLargeError`
#[derive(Debug, Clone, PartialEq)]
pub struct ResponseTooLargeError {
    pub max_bytes: f64,
}

impl ResponseTooLargeError {
    /// `error.message`
    pub fn message(&self) -> String {
        format!(
            "response larger than {} MB",
            number_to_string(math_round(self.max_bytes / (1024.0 * 1024.0)))
        )
    }
}

/// What `readBodyCapped` throws.
#[derive(Debug, Clone, PartialEq)]
pub enum BodyError {
    TooLarge(ResponseTooLargeError),
    /// the body's stream failed: the message of the error it was rejected with
    Stream(String),
}

impl BodyError {
    pub fn message(&self) -> String {
        match self {
            BodyError::TooLarge(e) => e.message(),
            BodyError::Stream(message) => message.clone(),
        }
    }
}

fn declared_length(resp: &dyn Response) -> Option<f64> {
    let raw = resp.header("content-length")?;
    let n = to_number(&raw);
    (n.is_finite() && n >= 0.0).then_some(n)
}

/// Body bytes of `resp`, capped at `max_bytes`. A Content-Length above the cap
/// is refused before reading; otherwise (chunked transfers carry none, and a
/// header can lie) the stream is counted as it arrives and cancelled the
/// moment the cap is passed.
pub fn read_body_capped(resp: &mut dyn Response, max_bytes: f64) -> Result<Vec<u8>, BodyError> {
    let declared = declared_length(resp);
    if declared.is_some_and(|declared| declared > max_bytes) {
        resp.cancel_body();
        return Err(BodyError::TooLarge(ResponseTooLargeError { max_bytes }));
    }
    if !resp.has_body() {
        let bytes = resp.array_buffer().map_err(|e| BodyError::Stream(e.0))?;
        if bytes.len() as f64 > max_bytes {
            return Err(BodyError::TooLarge(ResponseTooLargeError { max_bytes }));
        }
        return Ok(bytes);
    }
    let mut out: Vec<u8> = Vec::new();
    let mut total = 0f64;
    loop {
        let chunk = resp.read_chunk().map_err(|e| BodyError::Stream(e.0))?;
        let Some(value) = chunk else { break };
        total += value.len() as f64;
        if total > max_bytes {
            resp.cancel_body();
            return Err(BodyError::TooLarge(ResponseTooLargeError { max_bytes }));
        }
        out.extend_from_slice(&value);
    }
    Ok(out)
}

pub fn remote_image_headers() -> Vec<(String, String)> {
    vec![
        ("User-Agent".to_owned(), "Mozilla/5.0".to_owned()),
        // Only advertise formats the insert pipelines can label correctly: callers
        // map non-png/gif responses to JPEG, so preferring avif/webp would invite
        // content-negotiating CDNs to send bytes that end up mislabeled.
        (
            "Accept".to_owned(),
            "image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.5".to_owned(),
        ),
    ]
}

/// A `Response` over bytes in memory, as `new Response(bytes, { status: 200,
/// headers })` is.
pub struct MemoryResponse {
    status: u16,
    headers: Vec<(String, String)>,
    bytes: Option<Vec<u8>>,
}

impl MemoryResponse {
    pub fn new(status: u16, headers: Vec<(String, String)>, bytes: Vec<u8>) -> Self {
        MemoryResponse {
            status,
            headers,
            bytes: Some(bytes),
        }
    }
}

impl Response for MemoryResponse {
    fn status(&self) -> u16 {
        self.status
    }

    fn header(&self, name: &str) -> Option<String> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(key, _)| key.to_ascii_lowercase() == name)
            .map(|(_, value)| value.clone())
    }

    fn has_body(&self) -> bool {
        true
    }

    fn cancel_body(&mut self) {
        self.bytes = None;
    }

    fn read_chunk(&mut self) -> Result<Option<Vec<u8>>, super::safe_remote_url::FetchError> {
        Ok(self.bytes.take().filter(|bytes| !bytes.is_empty()))
    }

    fn array_buffer(&mut self) -> Result<Vec<u8>, super::safe_remote_url::FetchError> {
        Ok(self.bytes.take().unwrap_or_default())
    }
}

/// fetchWithSsrfGuard specialized for image downloads: browser-like headers
/// and retries on transient failures (network errors, 403/408/429, 5xx). An
/// SSRF-blocked URL still returns none immediately. `tmpdir` is
/// `os.tmpdir()`, where the generated-image store lives; `retry_delays_ms` is
/// `None` for the default.
pub fn fetch_remote_image(
    resolver: &mut dyn Resolver,
    fetcher: &mut dyn Fetcher,
    tmpdir: &str,
    raw_url: &str,
    retry_delays_ms: Option<&[f64]>,
) -> Option<Box<dyn Response>> {
    let retry_delays_ms = retry_delays_ms.unwrap_or(&RETRY_DELAYS_MS);
    // BYOK-generated images live in the local store; only its own files resolve
    if raw_url.starts_with("file:") {
        let local = read_generated_image(tmpdir, raw_url)?;
        let length = local.bytes.len().to_string();
        return Some(Box::new(MemoryResponse::new(
            200,
            vec![
                ("content-type".to_owned(), local.mime.clone()),
                ("content-length".to_owned(), length),
            ],
            local.bytes,
        )));
    }
    let headers = remote_image_headers();
    let mut attempt = 0usize;
    loop {
        let mut options = FetchWithSsrfGuardOptions {
            headers: Some(headers.clone()),
            ..FetchWithSsrfGuardOptions::default()
        };
        let (resp, threw) = match fetch_with_ssrf_guard(resolver, fetcher, raw_url, &mut options) {
            Ok(resp) => (resp, false),
            Err(_) => (None, true),
        };
        if resp.as_ref().is_some_and(|r| r.ok()) {
            return resp;
        }
        if resp.is_none() && !threw {
            return None; // blocked by the SSRF guard: permanent
        }
        let transient = threw
            || resp.as_ref().is_some_and(|r| {
                let status = r.status();
                status == 403 || status == 408 || status == 429 || status >= 500
            });
        let delay = retry_delays_ms.get(attempt).copied();
        let Some(delay) = delay.filter(|_| transient) else {
            return resp;
        };
        fetcher.sleep(delay);
        attempt += 1;
    }
}
