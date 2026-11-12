//! `apps/markdown/src/main/image-host.ts`: the bring-your-own image host for
//! Markdown pastes (S3-compatible stores, SM.MS, GitHub).
//!
//! The TypeScript takes a `fetch` and sends it through `keyedFetch` of
//! `@seuoffice/ai-provider`; here the `fetch` is a closure and `keyed_fetch`
//! is the part of `keyedFetch` that runs over a given base: one request that
//! follows nothing, and a refusal when the answer is a redirect.

use jscompat::{
    JsonValue, js_regex, json_parse, json_quote, number_to_string, slice_utf16, to_iso_string,
    to_number, trim,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use url::Url;

use super::fs_util::sha256_hex;

const UPLOAD_TIMEOUT_MS: u32 = 20_000;
/// one image upload, not a transfer service: a hard ceiling, well above the paste cap
pub const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;
/// responses beyond this are not JSON these hosts produce
const MAX_RESPONSE_BYTES: f64 = 1024.0 * 1024.0;

/// `ImageHostConfig`: the keys a kind carries, in the order the TypeScript sets them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImageHostConfig {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
    #[serde(rename = "accessKeyId", skip_serializing_if = "Option::is_none")]
    pub access_key_id: Option<String>,
    #[serde(rename = "secretAccessKey", skip_serializing_if = "Option::is_none")]
    pub secret_access_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(rename = "publicBase", skip_serializing_if = "Option::is_none")]
    pub public_base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(rename = "urlPrefix", skip_serializing_if = "Option::is_none")]
    pub url_prefix: Option<String>,
}

/// `ImageUploadResult`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImageUploadResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn failed(error: impl Into<String>) -> ImageUploadResult {
    ImageUploadResult {
        ok: false,
        url: None,
        error: Some(error.into()),
    }
}

/// `str(v, max)` of `normalizeImageHostConfig`
fn str_of(value: Option<&JsonValue>, max: f64) -> String {
    match value {
        Some(JsonValue::String(text)) => slice_utf16(trim(text), 0.0, Some(max)),
        _ => String::new(),
    }
}

/// `normalizeImageHostConfig(raw)`: the config file shape is what the dialog
/// hands over; anything malformed disables the host (`None` is `null`).
pub fn normalize_image_host_config(raw: Option<&JsonValue>) -> Option<ImageHostConfig> {
    let raw = raw?;
    if !matches!(raw, JsonValue::Object(_) | JsonValue::Array(_)) {
        return None;
    }
    let field = |key: &str| raw.get(key);
    let kind = match field("kind").as_deref() {
        Some(JsonValue::String(kind)) if matches!(kind.as_str(), "s3" | "smms" | "github") => {
            kind.clone()
        }
        _ => return None,
    };
    let s = |key: &str, max: f64| str_of(field(key).as_deref(), max);
    let or = |text: String, fallback: &str| {
        if text.is_empty() {
            fallback.to_owned()
        } else {
            text
        }
    };
    let mut config = ImageHostConfig {
        kind: kind.clone(),
        endpoint: None,
        region: None,
        bucket: None,
        access_key_id: None,
        secret_access_key: None,
        prefix: None,
        public_base: None,
        token: None,
        owner: None,
        repo: None,
        branch: None,
        dir: None,
        url_prefix: None,
    };
    if kind == "s3" {
        config.endpoint = Some(s("endpoint", 512.0));
        config.region = Some(or(s("region", 64.0), "auto"));
        config.bucket = Some(s("bucket", 128.0));
        config.access_key_id = Some(s("accessKeyId", 256.0));
        config.secret_access_key = Some(s("secretAccessKey", 256.0));
        config.prefix = Some(s("prefix", 256.0));
        config.public_base = Some(s("publicBase", 512.0));
        let empty = |v: &Option<String>| v.as_deref().is_none_or(str::is_empty);
        if empty(&config.endpoint)
            || empty(&config.bucket)
            || empty(&config.access_key_id)
            || empty(&config.secret_access_key)
        {
            return None;
        }
        if !js_regex!(r"^https:\/\/", "i").test(config.endpoint.as_deref().unwrap_or("")) {
            return None;
        }
    } else if kind == "smms" {
        config.token = Some(s("token", 256.0));
        if config.token.as_deref().unwrap_or("").is_empty() {
            return None;
        }
    } else {
        config.token = Some(s("token", 256.0));
        config.owner = Some(s("owner", 128.0));
        config.repo = Some(s("repo", 128.0));
        config.branch = Some(or(s("branch", 128.0), "main"));
        config.dir = Some(or(s("dir", 256.0), "images/"));
        config.url_prefix = Some(s("urlPrefix", 512.0));
        let empty = |v: &Option<String>| v.as_deref().is_none_or(str::is_empty);
        if empty(&config.token) || empty(&config.owner) || empty(&config.repo) {
            return None;
        }
    }
    Some(config)
}

/// `isImageHostUsable(config)`
pub fn is_image_host_usable(config: Option<&JsonValue>) -> bool {
    normalize_image_host_config(config).is_some()
}

/// `n.toString(36)` of an integer
fn to_base36(value: i64) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    let mut digits: Vec<u8> = Vec::new();
    let mut rest = value.unsigned_abs();
    while rest > 0 {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(rest % 36) as usize]);
        rest /= 36;
    }
    if value < 0 {
        digits.push(b'-');
    }
    digits.reverse();
    String::from_utf8(digits).expect("base 36 digits are ASCII")
}

/// What an operation throws that is not a network answer: a `RangeError` of an
/// invalid time, a `TypeError` of an invalid URL, the redirect refusal of
/// `keyedFetch`, or the reason the injected `fetch` failed.
#[derive(Debug, Clone, PartialEq)]
pub enum Thrown {
    /// an `Error` of any other class, by its message
    Error(String),
    /// `AiRedirectRefusedError`, by its message
    RedirectRefused(String),
    /// a value that is no `Error`
    NonError,
}

const INVALID_TIME: &str = "Invalid time value";
const INVALID_URL: &str = "Invalid URL";

/// `imageObjectKey(prefix, ext, now)`; `random` is `Math.random()`. `Err` is
/// the `RangeError` of an invalid date.
pub fn image_object_key(
    prefix: Option<&str>,
    ext: &str,
    now_ms: f64,
    random: f64,
) -> Result<String, Thrown> {
    let iso = to_iso_string(now_ms).ok_or_else(|| Thrown::Error(INVALID_TIME.to_owned()))?;
    let date: String = slice_utf16(&iso, 0.0, Some(10.0)).replace('-', "");
    let id = format!(
        "{}{}",
        to_base36(now_ms.trunc() as i64),
        to_base36((random * f64::from(0xffff_u32)).floor() as i64)
    );
    let prefix_text = prefix.unwrap_or("");
    let stripped = prefix_text.trim_matches('/');
    let slash = if prefix_text.is_empty() { "" } else { "/" };
    Ok(format!("{stripped}{slash}{date}/{id}.{ext}"))
}

fn trim_slash(text: &str) -> &str {
    text.trim_end_matches('/')
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    inner.update(data);
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// the `creds` of `sigV4`
pub struct SigV4Credentials<'a> {
    pub access_key_id: &'a str,
    pub secret_access_key: &'a str,
    pub region: &'a str,
    pub service: &'a str,
}

fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `url.host`: the host and, unless it is the scheme's default, the port
fn url_host(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

/// `sigV4(method, url, headers, payload, creds, amzDate)`: AWS Signature
/// Version 4, path-style PUT.
pub fn sig_v4(
    method: &str,
    url: &Url,
    headers: &[(String, String)],
    payload: &[u8],
    creds: &SigV4Credentials<'_>,
    amz_date: &str,
) -> String {
    let date_stamp = slice_utf16(amz_date, 0.0, Some(8.0));
    let payload_hash = sha256_hex(payload);
    let mut lowered: Vec<String> = headers.iter().map(|(k, _)| k.to_lowercase()).collect();
    lowered.sort_by(|a, b| utf16_cmp(a, b));
    let canonical_headers: String = lowered
        .iter()
        .map(|h| {
            let value = headers
                .iter()
                .find(|(k, _)| k.to_lowercase() == *h)
                .map_or("", |(_, v)| v.as_str());
            format!("{h}:{}\n", trim(value))
        })
        .collect();
    let signed_headers = lowered.join(";");
    let canonical_uri = {
        let joined = url
            .path()
            .split('/')
            .map(jscompat::encode_uri_component)
            .collect::<Vec<_>>()
            .join("/");
        if joined.is_empty() {
            "/".to_owned()
        } else {
            joined
        }
    };
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| {
            (
                jscompat::encode_uri_component(&k).replace("%20", "+"),
                jscompat::encode_uri_component(&v).replace("%20", "+"),
            )
        })
        .collect();
    pairs.sort_by(|a, b| utf16_cmp(&a.0, &b.0).then_with(|| utf16_cmp(&a.1, &b.1)));
    let canonical_query = pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let canonical_request = [
        method.to_uppercase(),
        canonical_uri,
        canonical_query,
        canonical_headers,
        signed_headers.clone(),
        payload_hash,
    ]
    .join("\n");
    let string_to_sign = [
        "AWS4-HMAC-SHA256".to_owned(),
        amz_date.to_owned(),
        format!(
            "{date_stamp}/{}/{}/aws4_request",
            creds.region, creds.service
        ),
        sha256_hex(canonical_request.as_bytes()),
    ]
    .join("\n");
    let k_date = hmac_sha256(
        format!("AWS4{}", creds.secret_access_key).as_bytes(),
        date_stamp.as_bytes(),
    );
    let k_region = hmac_sha256(&k_date, creds.region.as_bytes());
    let k_service = hmac_sha256(&k_region, creds.service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{date_stamp}/{}/{}/aws4_request, SignedHeaders={signed_headers}, Signature={signature}",
        creds.access_key_id, creds.region, creds.service
    )
}

// ---- the injected fetch ----

/// the body of a request: what the TypeScript hands `fetch`
#[derive(Debug, Clone, PartialEq)]
pub enum FetchBody<'a> {
    Bytes(&'a [u8]),
    Text(String),
    /// a `FormData` with one file entry
    Form {
        field: &'static str,
        file_name: String,
        /// the `Blob` type, already normalised
        mime: String,
        bytes: &'a [u8],
    },
}

/// the `init` the injected `fetch` receives
#[derive(Debug, Clone, PartialEq)]
pub struct FetchInit<'a> {
    pub method: &'static str,
    pub headers: Vec<(String, String)>,
    pub body: FetchBody<'a>,
    /// the abort deadline every adapter call carries
    pub timeout_ms: u32,
    /// `redirect: 'manual'`, which `keyedFetch` adds
    pub redirect: &'static str,
}

/// what `response.headers` is in the TypeScript's `FetchLike`
#[derive(Debug, Clone, PartialEq)]
pub enum ResponseHeaders {
    /// no `headers` property
    Absent,
    /// a `headers` object without a `get`
    NoGet,
    /// `get('location')` and `get('content-length')`; `None` is `null`
    Get {
        location: Option<String>,
        content_length: Option<String>,
    },
}

/// what the injected `fetch` resolves to
#[derive(Debug, Clone, PartialEq)]
pub struct FetchResponse {
    pub ok: bool,
    pub status: f64,
    /// `response.type === 'opaqueredirect'`
    pub opaque_redirect: bool,
    pub headers: ResponseHeaders,
    /// `text()`: `None` where the response has no such function, `Err` where it rejects
    pub text: Option<Result<String, String>>,
}

/// what the injected `fetch` rejects with
#[derive(Debug, Clone, PartialEq)]
pub enum FetchFailure {
    Error(String),
    NonError,
}

/// the injected `fetch`
pub type FetchLike<'f> =
    &'f mut dyn FnMut(&str, &FetchInit<'_>) -> Result<FetchResponse, FetchFailure>;

/// `refusedInsideFetch(error)`
fn refused_inside_fetch(message: &str) -> bool {
    message == "Redirect was cancelled"
        || message.starts_with("Attempted to redirect, but redirect policy was")
}

/// `new AiRedirectRefusedError(target)`, the default reason
fn redirect_refused(target: &str) -> Thrown {
    let to = if target.is_empty() {
        String::new()
    } else {
        format!(" to {target}")
    };
    Thrown::RedirectRefused(format!(
        "The provider answered with a redirect{to}, which a request carrying the API key does not follow. The API key was not sent on."
    ))
}

/// `siteOf(url)`: scheme and host of an address, for an error text
fn site_of(url: &Url) -> String {
    format!(
        "{}://{}",
        url.scheme(),
        slice_utf16(&url_host(url), 0.0, Some(100.0))
    )
}

/// `keyedFetch(url, init, undefined, base)`
fn keyed_fetch(
    fetch: FetchLike<'_>,
    url: &str,
    init: &FetchInit<'_>,
) -> Result<FetchResponse, Thrown> {
    let response = match fetch(url, init) {
        Ok(response) => response,
        Err(FetchFailure::Error(message)) if refused_inside_fetch(&message) => {
            return Err(redirect_refused(""));
        }
        Err(FetchFailure::Error(message)) => return Err(Thrown::Error(message)),
        Err(FetchFailure::NonError) => return Err(Thrown::NonError),
    };
    let location = match &response.headers {
        ResponseHeaders::Absent => {
            return Err(Thrown::Error(
                "Cannot read properties of undefined (reading 'get')".to_owned(),
            ));
        }
        ResponseHeaders::NoGet => {
            return Err(Thrown::Error(
                "response.headers.get is not a function".to_owned(),
            ));
        }
        ResponseHeaders::Get { location, .. } => location.clone(),
    };
    let redirected = response.opaque_redirect
        || (matches!(response.status as i64, 301 | 302 | 303 | 307 | 308)
            && response.status.fract() == 0.0
            && location.is_some());
    if !redirected {
        return Ok(response);
    }
    let mut target = String::new();
    if let Some(location) = &location
        && let Ok(base) = Url::parse(url)
        && let Ok(resolved) = base.join(location)
    {
        target = site_of(&resolved);
    }
    Err(redirect_refused(&target))
}

/// `readCapped(response)`: `None` where the TypeScript throws (every caller
/// turns that into an empty text)
fn read_capped(response: &FetchResponse) -> Option<String> {
    let declared = match &response.headers {
        ResponseHeaders::Get {
            content_length: Some(length),
            ..
        } => to_number(length),
        _ => 0.0,
    };
    if declared.is_finite() && declared > MAX_RESPONSE_BYTES {
        return None;
    }
    let text = match &response.text {
        None => String::new(),
        Some(Ok(text)) => text.clone(),
        Some(Err(_)) => return None,
    };
    if text.encode_utf16().count() as f64 > MAX_RESPONSE_BYTES {
        return None;
    }
    Some(text)
}

/// `jsonPath(json, path)`: a string at a dotted path
fn json_path(json: &JsonValue, path: &str) -> Option<String> {
    let mut cur: JsonValue = json.clone();
    for seg in path.split('.') {
        if !matches!(cur, JsonValue::Object(_) | JsonValue::Array(_)) {
            return None;
        }
        cur = cur.get(seg)?.into_owned();
    }
    match cur {
        JsonValue::String(text) => Some(text),
        _ => None,
    }
}

fn status_text(status: f64) -> String {
    number_to_string(status)
}

/// `blob type`: a type with a character outside U+0020..U+007E is empty, any other is lower case
fn blob_type(text: &str) -> String {
    if text.chars().any(|c| !('\u{20}'..='\u{7e}').contains(&c)) {
        String::new()
    } else {
        text.to_ascii_lowercase()
    }
}

fn upload_s3(
    config: &ImageHostConfig,
    bytes: &[u8],
    ext: &str,
    now_ms: f64,
    random: f64,
    fetch: FetchLike<'_>,
) -> Result<ImageUploadResult, Thrown> {
    let key = image_object_key(config.prefix.as_deref(), ext, now_ms, random)?;
    let endpoint = trim_slash(config.endpoint.as_deref().unwrap_or(""));
    let bucket = config.bucket.as_deref().unwrap_or("");
    let url = Url::parse(&format!("{endpoint}/{bucket}/{key}"))
        .map_err(|_| Thrown::Error(INVALID_URL.to_owned()))?;
    let iso = to_iso_string(now_ms).ok_or_else(|| Thrown::Error(INVALID_TIME.to_owned()))?;
    let squeezed: String = iso.chars().filter(|c| *c != '-' && *c != ':').collect();
    let amz_date = match js_regex!(r"\.\d{3}").exec(&squeezed) {
        Some(m) => format!("{}{}", &squeezed[..m.start()], &squeezed[m.end()..]),
        None => squeezed,
    };
    let mut headers: Vec<(String, String)> = vec![
        ("Host".to_owned(), url_host(&url)),
        ("x-amz-date".to_owned(), amz_date.clone()),
        ("x-amz-content-sha256".to_owned(), sha256_hex(bytes)),
    ];
    let region = config
        .region
        .as_deref()
        .filter(|r| !r.is_empty())
        .unwrap_or("auto");
    let authorization = sig_v4(
        "PUT",
        &url,
        &headers,
        bytes,
        &SigV4Credentials {
            access_key_id: config.access_key_id.as_deref().unwrap_or(""),
            secret_access_key: config.secret_access_key.as_deref().unwrap_or(""),
            region,
            service: "s3",
        },
        &amz_date,
    );
    headers.push(("Authorization".to_owned(), authorization));
    let init = FetchInit {
        method: "PUT",
        headers,
        body: FetchBody::Bytes(bytes),
        timeout_ms: UPLOAD_TIMEOUT_MS,
        redirect: "manual",
    };
    let response = keyed_fetch(fetch, url.as_str(), &init)?;
    if !response.ok {
        let body = read_capped(&response).unwrap_or_default();
        let cut = slice_utf16(&body, 0.0, Some(200.0));
        let shown = if cut.is_empty() {
            "upload rejected".to_owned()
        } else {
            cut
        };
        return Ok(failed(format!(
            "S3 {}: {shown}",
            status_text(response.status)
        )));
    }
    let base = match config.public_base.as_deref().filter(|b| !b.is_empty()) {
        Some(public_base) => trim_slash(public_base).to_owned(),
        None => format!("{endpoint}/{bucket}"),
    };
    Ok(ImageUploadResult {
        ok: true,
        url: Some(format!("{base}/{key}")),
        error: None,
    })
}

fn upload_smms(
    config: &ImageHostConfig,
    bytes: &[u8],
    ext: &str,
    fetch: FetchLike<'_>,
) -> Result<ImageUploadResult, Thrown> {
    let mime = blob_type(&format!(
        "image/{}",
        if ext == "jpg" { "jpeg" } else { ext }
    ));
    let init = FetchInit {
        method: "POST",
        headers: vec![(
            "Authorization".to_owned(),
            config.token.clone().unwrap_or_default(),
        )],
        body: FetchBody::Form {
            field: "smfile",
            file_name: format!("image.{ext}"),
            mime,
            bytes,
        },
        timeout_ms: UPLOAD_TIMEOUT_MS,
        redirect: "manual",
    };
    let response = keyed_fetch(fetch, "https://smms.app/api/v2/upload", &init)?;
    let text = read_capped(&response).unwrap_or_default();
    let Ok(json) = json_parse(&text) else {
        return Ok(failed(format!(
            "SM.MS {}: unparseable response",
            status_text(response.status)
        )));
    };
    let success_is_true = json_path(&json, "success").as_deref() == Some("true");
    let success_flag = matches!(json.get("success").as_deref(), Some(JsonValue::Bool(true)));
    if !success_is_true && !success_flag {
        let message = json_path(&json, "message").unwrap_or_else(|| "upload rejected".to_owned());
        return Ok(failed(format!(
            "SM.MS: {}",
            slice_utf16(&message, 0.0, Some(200.0))
        )));
    }
    let url = json_path(&json, "data.url").or_else(|| json_path(&json, "data.quilt_url"));
    match url.filter(|url| !url.is_empty()) {
        None => Ok(failed("SM.MS: no URL in response")),
        Some(url) => Ok(ImageUploadResult {
            ok: true,
            url: Some(url),
            error: None,
        }),
    }
}

fn upload_github(
    config: &ImageHostConfig,
    bytes: &[u8],
    ext: &str,
    now_ms: f64,
    random: f64,
    fetch: FetchLike<'_>,
) -> Result<ImageUploadResult, Thrown> {
    let path = image_object_key(config.dir.as_deref(), ext, now_ms, random)?;
    let branch = config
        .branch
        .as_deref()
        .filter(|b| !b.is_empty())
        .unwrap_or("main");
    let url = Url::parse(&format!(
        "https://api.github.com/repos/{}/{}/contents/{path}",
        config.owner.as_deref().unwrap_or(""),
        config.repo.as_deref().unwrap_or("")
    ))
    .map_err(|_| Thrown::Error(INVALID_URL.to_owned()))?;
    let iso = to_iso_string(now_ms).ok_or_else(|| Thrown::Error(INVALID_TIME.to_owned()))?;
    let body = format!(
        "{{\"message\":{},\"content\":{},\"branch\":{}}}",
        json_quote(&format!("image {iso}")),
        json_quote(&jscompat::base64(bytes)),
        json_quote(branch)
    );
    let init = FetchInit {
        method: "PUT",
        headers: vec![
            (
                "Authorization".to_owned(),
                format!("Bearer {}", config.token.as_deref().unwrap_or("")),
            ),
            (
                "Accept".to_owned(),
                "application/vnd.github+json".to_owned(),
            ),
            ("X-GitHub-Api-Version".to_owned(), "2022-11-28".to_owned()),
            ("Content-Type".to_owned(), "application/json".to_owned()),
        ],
        body: FetchBody::Text(body),
        timeout_ms: UPLOAD_TIMEOUT_MS,
        redirect: "manual",
    };
    let response = keyed_fetch(fetch, url.as_str(), &init)?;
    let text = read_capped(&response).unwrap_or_default();
    let Ok(json) = json_parse(&text) else {
        return Ok(failed(format!(
            "GitHub {}: unparseable response",
            status_text(response.status)
        )));
    };
    if !response.ok {
        let message = json_path(&json, "message").unwrap_or_else(|| "upload rejected".to_owned());
        return Ok(failed(format!(
            "GitHub {}: {}",
            status_text(response.status),
            slice_utf16(&message, 0.0, Some(200.0))
        )));
    }
    let Some(download) = json_path(&json, "content.download_url").filter(|d| !d.is_empty()) else {
        return Ok(failed("GitHub: no download_url in response"));
    };
    // a configured CDN base replaces the API's raw URL; the repo-relative path is identical
    let url2 = match config.url_prefix.as_deref().filter(|p| !p.is_empty()) {
        Some(prefix) => format!("{}/{path}", trim_slash(prefix)),
        None => download,
    };
    Ok(ImageUploadResult {
        ok: true,
        url: Some(url2),
        error: None,
    })
}

/// `uploadImageToHost(config, { bytes, ext, fetchImpl, now })`; `random` is
/// `Math.random()`, `now_ms` the Date (`getTime()`, NaN for an invalid one).
pub fn upload_image_to_host(
    config: Option<&JsonValue>,
    bytes: &[u8],
    ext: &str,
    fetch: FetchLike<'_>,
    now_ms: f64,
    random: &mut dyn FnMut() -> f64,
) -> ImageUploadResult {
    let Some(normalized) = normalize_image_host_config(config) else {
        return failed("no usable image host configured");
    };
    if bytes.is_empty() {
        return failed("empty image");
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return failed(format!(
            "image exceeds {} MB",
            MAX_UPLOAD_BYTES / 1024 / 1024
        ));
    }
    let run = match normalized.kind.as_str() {
        "s3" => upload_s3(&normalized, bytes, ext, now_ms, random(), fetch),
        "smms" => upload_smms(&normalized, bytes, ext, fetch),
        _ => upload_github(&normalized, bytes, ext, now_ms, random(), fetch),
    };
    match run {
        Ok(result) => result,
        Err(Thrown::RedirectRefused(message)) if normalized.kind == "github" => {
            // GitHub redirects the address of a repository that was renamed or moved
            failed(format!(
                "GitHub: the repository may have been renamed or moved; check the owner and repository of the image host. {message}"
            ))
        }
        Err(Thrown::Error(message) | Thrown::RedirectRefused(message)) => failed(message),
        Err(Thrown::NonError) => failed("upload failed"),
    }
}
