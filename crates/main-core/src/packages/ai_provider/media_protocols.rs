//! `packages/ai-provider/src/media-protocols.ts`: the wire implementations of
//! the BYOK media providers. Image generation speaks four shapes (OpenAI
//! Images for OpenAI, Ark, Zhipu, xAI and custom endpoints; Gemini native
//! output and Imagen predict; DashScope multimodal-generation; MiniMax
//! image_generation) plus the Stability, FLUX (polled) and Microsoft MAI
//! endpoints. Understanding speaks two: OpenAI chat completions and Gemini
//! generateContent (inline, or through the Files API).
//!
//! `tldts.getDomain` has no Rust: the one place that reads it (the polling
//! address of a queued FLUX job) takes it as a [`RegistrableDomain`], the
//! answer of `getDomain(hostname, { allowPrivateDomains: true })`. The caller
//! owns the public suffix list.
//!
//! JSON replies are read as [`JsonValue`]; `asRecord(v)` is an object or an
//! array (both are `typeof 'object'`) and anything else is `{}`, which a
//! `Option<&JsonValue>` that is `None` stands for.
//!
//! The module state of `fetch.ts` ([`AiFetch`]) is handed to every call that
//! makes a request.

use std::borrow::Cow;
use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{
    JsonValue, base64, buffer_from_base64, encode_uri_component, inherited_string, js_regex,
    json_parse, json_stringify, math_max, math_round, number_to_string, replace_first_string,
    to_number, trim,
};

use super::fetch::{AiFetch, Init, KeyedFetchBase, ai_fetch, keyed_fetch};
use super::http_error::http_body_detail;
use super::jsval::{
    Obj, as_str, coalesce, js_string_or_empty, number, object, prop, slice_to, text, value_key,
};
use super::media::{
    AiMediaProviderMeta, BFL_BASE_URL, DASHSCOPE_BASE_URL, GEMINI_MEDIA_BASE_URL, MINIMAX_BASE_URL,
    OPENAI_IMAGES_BASE_URL, STABILITY_BASE_URL, get_media_provider_meta,
};
use super::protocols_shared::{
    CappedReadOptions, endpoint_url, open_ai_content_text, parse_url, read_capped_response_text,
};
use super::task::{FormPart, FormValue, Id, JsError, Request, RequestBody, Response, Rt, Signal};

/// `MediaBlob`
#[derive(Debug, Clone, PartialEq)]
pub struct MediaBlob {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub name: Option<String>,
}

/// `GenerateImageInput`
#[derive(Debug, Clone, PartialEq, Default)]
pub struct GenerateImageInput {
    pub prompt: String,
    /// 1:1 | 4:3 | 16:9 | 9:16 | 3:4 | 2:3 | 3:2 | auto
    pub aspect_ratio: Option<String>,
    /// images to edit / draw from
    pub references: Option<Vec<MediaBlob>>,
    /// ask for real PNG alpha where the API has a control for it
    pub transparent: Option<bool>,
}

/// `AnalyzeMediaInput`
#[derive(Debug, Clone, PartialEq)]
pub struct AnalyzeMediaInput {
    pub media: Vec<MediaBlob>,
    pub requirements: String,
}

/// `AiMediaProviderConfig`
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AiMediaProviderConfig {
    pub api_key: String,
    pub base_url: Option<String>,
    /// image generation model (empty = the provider default)
    pub image_model: String,
    /// image/video understanding model (empty = the provider default)
    pub analysis_model: String,
}

/// The answer of `testMediaProvider`: `{ ok, error? }`.
#[derive(Debug, Clone, PartialEq)]
pub struct MediaTestResult {
    pub ok: bool,
    pub error: Option<String>,
}

/// `getDomain(hostname, { allowPrivateDomains: true })` of `tldts`: the
/// registrable domain of a host name, `None` for an IP address or a name
/// without a public suffix to hang one on.
pub type RegistrableDomain<'a> = &'a dyn Fn(&str) -> Option<String>;

/// image generation can take minutes on the large models
const GENERATE_TIMEOUT_MS: f64 = 600_000.0;
const ANALYZE_TIMEOUT_MS: f64 = 300_000.0;
const TEST_TIMEOUT_MS: f64 = 20_000.0;
/// Gemini caps the whole inline request at 20 MB; bigger media goes through the Files API
const GEMINI_INLINE_LIMIT_BYTES: usize = 18 * 1024 * 1024;
const GEMINI_FILE_POLL_MS: f64 = 2_000.0;
const GEMINI_FILE_READY_TIMEOUT_MS: f64 = 180_000.0;

const MAX_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;

/// An error body is only ever read for a short diagnostic, so it is capped hard.
const MAX_ERROR_BODY_BYTES: f64 = 64.0 * 1024.0;

/// `trimSlash(url)`
fn trim_slash(url: &str) -> String {
    js_regex!(r"/+$").replace_all(url, |_| String::new())
}

/// `metaOf(provider)`
fn meta_of(provider: &str) -> Result<&'static AiMediaProviderMeta, JsError> {
    get_media_provider_meta(&text(provider))
        .ok_or_else(|| JsError::error(format!("Unknown media provider: {provider}")))
}

/// `url.pathname = path` of a URL that can have a path
fn set_pathname(url: &mut url::Url, path: &str) {
    if !url.cannot_be_a_base() {
        url.set_path(path);
    }
}

/// `openAiBase(provider, config)`: base URL of the OpenAI-shaped endpoints
/// (images + chat) for a provider
fn open_ai_base(provider: &str, config: &AiMediaProviderConfig) -> Result<String, JsError> {
    if provider == "qwen" {
        return endpoint_url(&dashscope_root(config)?, "/compatible-mode/v1", None);
    }
    let meta = meta_of(provider)?;
    Ok(trim_slash(
        &truthy_or(config.base_url.as_deref(), meta.default_base_url)
            .unwrap_or(OPENAI_IMAGES_BASE_URL)
            .to_owned(),
    ))
}

/// `a || b` over strings: `a` unless it is missing or empty. `None` when
/// both are.
fn truthy_or<'a>(a: Option<&'a str>, b: &'a str) -> Option<&'a str> {
    match a {
        Some(a) if !a.is_empty() => Some(a),
        _ if !b.is_empty() => Some(b),
        _ => None,
    }
}

/// `dashscopeRoot(config)`: the DashScope root; a pasted compatible-mode or
/// api/v1 URL is reduced to it. The suffixes are stripped from the pathname.
fn dashscope_root(config: &AiMediaProviderConfig) -> Result<String, JsError> {
    let given = truthy_or(config.base_url.as_deref(), DASHSCOPE_BASE_URL).unwrap_or_default();
    let mut url = parse_url(given)?;
    let path = js_regex!(r"(/compatible-mode/v1|/api/v1)$")
        .replace_all(&trim_slash(url.path()), |_| String::new());
    set_pathname(&mut url, &path);
    Ok(url.to_string())
}

/// `geminiBase(config)`
fn gemini_base(config: &AiMediaProviderConfig) -> String {
    trim_slash(truthy_or(config.base_url.as_deref(), GEMINI_MEDIA_BASE_URL).unwrap_or_default())
}

/// `geminiModelsProbeUrl(config)`: `?pageSize=1` set on the models listing
fn gemini_models_probe_url(config: &AiMediaProviderConfig) -> Result<String, JsError> {
    let mut url = parse_url(&endpoint_url(&gemini_base(config), "/models", None)?)?;
    // `url.searchParams.set('pageSize', '1')`: the first pair of the name is
    // replaced, the others go, and the whole query is written again
    let mut pairs: Vec<(String, String)> =
        url::form_urlencoded::parse(url.query().unwrap_or_default().as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
    match pairs.iter().position(|(k, _)| k == "pageSize") {
        Some(at) => {
            pairs[at].1 = "1".to_owned();
            let mut seen = false;
            pairs.retain(|(k, _)| {
                if k != "pageSize" {
                    return true;
                }
                let first = !seen;
                seen = true;
                first
            });
        }
        None => pairs.push(("pageSize".to_owned(), "1".to_owned())),
    }
    url.query_pairs_mut().clear().extend_pairs(pairs);
    Ok(url.to_string())
}

/// `bearer(config)`
fn bearer(config: &AiMediaProviderConfig) -> Vec<(String, String)> {
    if config.api_key.is_empty() {
        Vec::new()
    } else {
        vec![(
            "Authorization".to_owned(),
            format!("Bearer {}", config.api_key),
        )]
    }
}

/// `{ 'Content-Type': 'application/json', ...bearer(config) }`
fn json_bearer(config: &AiMediaProviderConfig) -> Vec<(String, String)> {
    let mut headers = vec![("Content-Type".to_owned(), "application/json".to_owned())];
    headers.extend(bearer(config));
    headers
}

fn pair(name: &str, value: &str) -> (String, String) {
    (name.to_owned(), value.to_owned())
}

/// `bytesToBase64(bytes)`: the Buffer branch (Node's `toString('base64')`);
/// the main process always has `Buffer`.
pub fn bytes_to_base64(bytes: &[u8]) -> String {
    base64(bytes)
}

/// `base64ToBytes(b64)`: the Buffer branch (Node's lenient decoder).
pub fn base64_to_bytes(b64: &str) -> Vec<u8> {
    buffer_from_base64(b64)
}

/// `dataUrl(blob)`
fn data_url(blob: &MediaBlob) -> String {
    format!("data:{};base64,{}", blob.mime, bytes_to_base64(&blob.bytes))
}

/// `sniffImageMime(bytes, fallback)`: image bytes declare their own format;
/// the vendor's declared mime is a fallback only. The TypeScript's default
/// for `fallback` is `image/png`.
pub fn sniff_image_mime(bytes: &[u8], fallback: &str) -> String {
    if bytes.len() > 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4e {
        return "image/png".to_owned();
    }
    if bytes.len() > 3 && bytes[0] == 0xff && bytes[1] == 0xd8 {
        return "image/jpeg".to_owned();
    }
    if bytes.len() > 6 && bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46 {
        return "image/gif".to_owned();
    }
    if bytes.len() > 12
        && bytes[8] == 0x57
        && bytes[9] == 0x45
        && bytes[10] == 0x42
        && bytes[11] == 0x50
    {
        return "image/webp".to_owned();
    }
    fallback.to_owned()
}

/// `failFrom(label, resp)`: the status and the head of the body as an error
async fn fail_from<T>(label: &str, resp: &Response) -> Result<T, JsError> {
    let body = read_capped_response_text(
        resp,
        &CappedReadOptions {
            max_bytes: Some(MAX_ERROR_BODY_BYTES),
            on_bytes: None,
            truncate: true,
        },
    )
    .await?;
    Err(JsError::error(format!(
        "{label} {}: {}",
        number_to_string(resp.status()),
        http_body_detail(&body)?
    )))
}

/// `asRecord(v)`: an object or an array stays, anything else is `{}` (`None`)
fn rec(v: Option<&JsonValue>) -> Option<&JsonValue> {
    match v {
        Some(v @ (JsonValue::Object(_) | JsonValue::Array(_))) => Some(v),
        _ => None,
    }
}

/// `record.key`
fn get<'a>(record: Option<&'a JsonValue>, key: &str) -> Option<&'a JsonValue> {
    record.and_then(|r| prop(r, key))
}

/// `(value as unknown[] | undefined)?.[0]`: also what a string or an object
/// with a `"0"` key answers
fn first(value: Option<&JsonValue>) -> Option<Cow<'_, JsonValue>> {
    match value? {
        JsonValue::Array(items) => items.first().map(Cow::Borrowed),
        JsonValue::Object(o) => o.get("0").map(Cow::Borrowed),
        JsonValue::String(s) => s.encode_utf16().next().map(|unit| {
            Cow::Owned(text(
                char::from_u32(u32::from(unit))
                    .unwrap_or(char::REPLACEMENT_CHARACTER)
                    .to_string(),
            ))
        }),
        _ => None,
    }
}

/// `typeof v === 'string' && v`
fn nonempty(v: Option<&JsonValue>) -> Option<&str> {
    as_str(v).filter(|s| !s.is_empty())
}

/// `JSON.stringify(json).slice(0, 200)`
fn head200(json: &JsonValue) -> String {
    slice_to(&json_stringify(json), 200)
}

/// `readJson(label, resp)`: the body read whole and parsed here; a body that
/// is no JSON is shaped through `httpBodyDetail`.
async fn read_json(label: &str, resp: &Response) -> Result<JsonValue, JsError> {
    let body = resp.text().await?;
    match json_parse(&body) {
        Ok(v @ (JsonValue::Object(_) | JsonValue::Array(_))) => Ok(v),
        Ok(_) => Ok(JsonValue::Object(Obj::new())),
        Err(_) => Err(JsError::error(format!(
            "{label} the response was not JSON: {}",
            http_body_detail(&body)?
        ))),
    }
}

/// `withTimeout(signal, ms)`
fn with_timeout(rt: &Rt, signal: Option<&Signal>, ms: f64) -> Signal {
    let timeout = rt.timeout_signal(ms);
    match signal {
        Some(signal) => rt.any_signal(&[signal, &timeout]),
        None => timeout,
    }
}

/// `readCapped(resp, label)`: the body counted as it streams and dropped past
/// the cap; a missing Content-Length is unknown, not zero.
async fn read_capped(resp: &Response, label: &str) -> Result<Vec<u8>, JsError> {
    let declared = match resp.header("content-length") {
        Some(v) => to_number(&v),
        None => f64::NAN,
    };
    if declared > MAX_DOWNLOAD_BYTES as f64 {
        resp.cancel();
        return Err(JsError::error(format!("{label} download too large")));
    }
    if !resp.has_body() {
        return resp.bytes().await;
    }
    let mut out: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.read().await? {
        if out.len() + chunk.len() > MAX_DOWNLOAD_BYTES {
            resp.cancel();
            return Err(JsError::error(format!("{label} download too large")));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// `keyedFetch(url, init)` with the default base
async fn send(
    rt: &Rt,
    fx: &AiFetch,
    url: &str,
    request: Request,
    signal: &Signal,
) -> Result<Response, JsError> {
    let init = Init {
        request,
        signal: Some(signal.clone()),
    };
    keyed_fetch(rt, fx, url, &init, None, &KeyedFetchBase::Ai).await
}

/// `{ method: 'POST', headers, body }`
fn post(headers: Vec<(String, String)>, body: RequestBody) -> Request {
    Request {
        method: Some("POST".to_owned()),
        headers,
        body: Some(body),
        redirect: None,
    }
}

/// `{ method: 'POST', headers, body: JSON.stringify(body) }`
fn post_json(headers: Vec<(String, String)>, body: &JsonValue) -> Request {
    post(headers, RequestBody::Text(json_stringify(body)))
}

/// `downloadImage(label, url, signal)`: vendors that return a URL instead of
/// bytes (the links are short-lived, so right away)
async fn download_image(
    rt: &Rt,
    fx: &AiFetch,
    label: &str,
    url: &str,
    signal: &Signal,
) -> Result<MediaBlob, JsError> {
    let init = Init {
        request: Request::default(),
        signal: Some(signal.clone()),
    };
    let img = ai_fetch(rt, fx, url, &init, None).await?;
    if !img.ok() {
        return fail_from(&format!("{label} download"), &img).await;
    }
    let bytes = read_capped(&img, label).await?;
    let mime = sniff_image_mime(
        &bytes,
        &img.header("content-type").unwrap_or("image/png".into()),
    );
    Ok(MediaBlob {
        bytes,
        mime,
        name: None,
    })
}

/// `fromBase64(b64, declaredMime)`
fn from_base64(b64: &str, declared_mime: Option<&JsonValue>) -> MediaBlob {
    let bytes = base64_to_bytes(b64);
    let mime = sniff_image_mime(&bytes, as_str(declared_mime).unwrap_or("image/png"));
    MediaBlob {
        bytes,
        mime,
        name: None,
    }
}

/// The type a `Blob` keeps of the `type` it is given: a type with a
/// character outside U+0020..U+007E is `''`, any other is lowercased.
fn blob_type(mime: &str) -> String {
    if mime.chars().any(|c| !('\u{20}'..='\u{7e}').contains(&c)) {
        String::new()
    } else {
        mime.to_ascii_lowercase()
    }
}

/// `form.append(field, new Blob([bytes], { type }), ref.name ?? `ref-${i}.${ext}`)`
fn form_reference(field: &str, reference: &MediaBlob, i: usize) -> FormPart {
    let filename = match &reference.name {
        Some(name) => name.clone(),
        None => {
            let ext = reference
                .mime
                .split('/')
                .nth(1)
                .map(|s| replace_first_string(s, "jpeg", "jpg"))
                .unwrap_or_else(|| "png".to_owned());
            format!("ref-{i}.{ext}")
        }
    };
    FormPart {
        name: field.to_owned(),
        value: FormValue::Blob {
            bytes: reference.bytes.clone(),
            mime: blob_type(&reference.mime),
            filename: Some(filename),
        },
    }
}

fn form_text(name: &str, value: &str) -> FormPart {
    FormPart {
        name: name.to_owned(),
        value: FormValue::Text(value.to_owned()),
    }
}

// ── size tables ─────────────────────────────────────────────────────

/// What `TABLE[ratio]` answers on a plain object literal: the entry, or what
/// `Object.prototype` has under the name (`constructor`, `__proto__`, ...).
enum Size {
    Text(String),
    /// a built-in function: `String()` writes its source text; JSON drops it
    Native(&'static str),
    /// `Object.prototype` itself (`__proto__`)
    Proto,
}

impl Size {
    /// `String(size)`
    fn string(&self) -> &str {
        match self {
            Size::Text(s) => s,
            Size::Native(t) => t,
            Size::Proto => "[object Object]",
        }
    }

    /// the value `JSON.stringify` writes for the property; `None`: left out
    fn json(&self) -> Option<JsonValue> {
        match self {
            Size::Text(s) => Some(text(s.clone())),
            Size::Native(_) => None,
            Size::Proto => Some(JsonValue::Object(Obj::new())),
        }
    }
}

/// `table[key]`
fn table_size(table: &[(&str, &str)], key: &str) -> Option<Size> {
    if let Some((_, v)) = table.iter().find(|(k, _)| *k == key) {
        return Some(Size::Text((*v).to_owned()));
    }
    inherited_string(key).map(|t| {
        if key == "__proto__" {
            Size::Proto
        } else {
            Size::Native(t)
        }
    })
}

/// `ratio ? TABLE[ratio] : undefined`
fn ratio_size(table: &[(&str, &str)], ratio: Option<&str>) -> Option<Size> {
    match ratio {
        Some(r) if !r.is_empty() => table_size(table, r),
        _ => None,
    }
}

/// `input.aspectRatio && input.aspectRatio !== 'auto' ? input.aspectRatio : undefined`
fn not_auto(ratio: Option<&str>) -> Option<&str> {
    ratio.filter(|r| !r.is_empty() && *r != "auto")
}

// ── OpenAI Images API family (openai, doubao/Ark, glm/Zhipu, xai, custom) ──

const OPENAI_SIZES: &[(&str, &str)] = &[
    ("1:1", "1024x1024"),
    ("16:9", "1536x1024"),
    ("3:2", "1536x1024"),
    ("4:3", "1536x1024"),
    ("9:16", "1024x1536"),
    ("2:3", "1024x1536"),
    ("3:4", "1024x1536"),
];
/// CogView accepts a fixed grid of WxH values
const GLM_SIZES: &[(&str, &str)] = &[
    ("1:1", "1024x1024"),
    ("16:9", "1344x768"),
    ("3:2", "1344x768"),
    ("4:3", "1152x864"),
    ("9:16", "768x1344"),
    ("2:3", "768x1344"),
    ("3:4", "864x1152"),
];
/// Seedream takes the aspect ratio itself as `size` (resolution defaults to 2K)
const ARK_RATIOS: &[&str] = &["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "21:9"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Edits {
    /// POST /images/edits with files
    Multipart,
    /// `image` data URLs in the generations body
    Inline,
    /// unsupported
    None,
}

/// `OpenAiImagesStyle`, with `size` already asked for the aspect ratio
struct OpenAiImagesStyle {
    size: Option<Size>,
    /// vendor-specific fields merged into the generations body
    body_extras: Vec<(&'static str, JsonValue)>,
    edits: Edits,
}

/// `openAiImagesStyle(provider)` and its `size(aspectRatio)`
fn open_ai_images_style(provider: &str, aspect_ratio: Option<&str>) -> OpenAiImagesStyle {
    match provider {
        "doubao" => OpenAiImagesStyle {
            size: Some(Size::Text(match aspect_ratio {
                Some(r) if !r.is_empty() && ARK_RATIOS.contains(&r) => r.to_owned(),
                _ => "2K".to_owned(),
            })),
            body_extras: vec![
                ("response_format", text("b64_json")),
                ("watermark", JsonValue::Bool(false)),
            ],
            edits: Edits::Inline,
        },
        "glm" => OpenAiImagesStyle {
            size: ratio_size(GLM_SIZES, aspect_ratio),
            body_extras: Vec::new(),
            edits: Edits::None,
        },
        // xAI rejects size/quality; bytes only on request
        "xai" => OpenAiImagesStyle {
            size: None,
            body_extras: vec![("response_format", text("b64_json"))],
            edits: Edits::None,
        },
        _ => OpenAiImagesStyle {
            size: ratio_size(OPENAI_SIZES, aspect_ratio),
            body_extras: Vec::new(),
            edits: Edits::Multipart,
        },
    }
}

/// `openAiImageResult(label, resp, signal)`
async fn open_ai_image_result(
    rt: &Rt,
    fx: &AiFetch,
    label: &str,
    resp: &Response,
    signal: &Signal,
) -> Result<MediaBlob, JsError> {
    if !resp.ok() {
        return fail_from(label, resp).await;
    }
    let json = read_json(label, resp).await?;
    let data = first(get(Some(&json), "data"));
    let entry = rec(data.as_deref());
    if let Some(b64) = nonempty(get(entry, "b64_json")) {
        return Ok(from_base64(b64, None));
    }
    if let Some(url) = nonempty(get(entry, "url")) {
        return download_image(rt, fx, label, url, signal).await;
    }
    Err(JsError::error(format!(
        "{label} returned no image: {}",
        head200(&json)
    )))
}

/// `generateImageOpenAi(provider, config, model, input, signal)`
async fn generate_image_open_ai(
    rt: &Rt,
    fx: &AiFetch,
    provider: &str,
    config: &AiMediaProviderConfig,
    model: &str,
    input: &GenerateImageInput,
    signal: &Signal,
) -> Result<MediaBlob, JsError> {
    let base = open_ai_base(provider, config)?;
    let style = open_ai_images_style(provider, input.aspect_ratio.as_deref());
    let refs: &[MediaBlob] = input.references.as_deref().unwrap_or_default();
    // `background` exists only on the gpt-image family; dall-e-3 and lookalike vendors 400 on it
    let transparent = input.transparent == Some(true) && js_regex!(r"gpt-image", "i").test(model);
    if !refs.is_empty() && style.edits == Edits::None {
        return Err(JsError::error(format!(
            "{} cannot edit or reference images here; generate from the prompt alone or pick another image provider.",
            meta_of(provider)?.label
        )));
    }
    if refs.is_empty() || style.edits == Edits::Inline {
        let url = endpoint_url(&base, "/images/generations", None)?;
        let mut body: Vec<(&str, JsonValue)> = vec![
            ("model", text(model)),
            ("prompt", text(input.prompt.as_str())),
            ("n", number(1.0)),
        ];
        if let Some(size) = style.size.as_ref().and_then(Size::json) {
            body.push(("size", size));
        }
        if transparent {
            body.push(("background", text("transparent")));
        }
        body.extend(style.body_extras);
        if !refs.is_empty() {
            body.push((
                "image",
                JsonValue::Array(refs.iter().map(|r| text(data_url(r))).collect()),
            ));
        }
        let resp = send(
            rt,
            fx,
            &url,
            post_json(json_bearer(config), &object(body)),
            signal,
        )
        .await?;
        return open_ai_image_result(rt, fx, "Image generation failed:", &resp, signal).await;
    }
    // edits take the source images as multipart files (image[] for several)
    let mut form = vec![
        form_text("model", model),
        form_text("prompt", &input.prompt),
    ];
    if let Some(size) = &style.size {
        form.push(form_text("size", size.string()));
    }
    if transparent {
        form.push(form_text("background", "transparent"));
    }
    let field = if refs.len() > 1 { "image[]" } else { "image" };
    for (i, reference) in refs.iter().enumerate() {
        form.push(form_reference(field, reference, i));
    }
    let url = endpoint_url(&base, "/images/edits", None)?;
    let resp = send(
        rt,
        fx,
        &url,
        post(bearer(config), RequestBody::Form(form)),
        signal,
    )
    .await?;
    open_ai_image_result(rt, fx, "Image edit failed:", &resp, signal).await
}

// ── DashScope multimodal-generation (Qwen-Image) ───────────────────

const DASHSCOPE_SIZES: &[(&str, &str)] = &[
    ("1:1", "1328*1328"),
    ("16:9", "1664*928"),
    ("3:2", "1664*928"),
    ("4:3", "1472*1104"),
    ("9:16", "928*1664"),
    ("2:3", "928*1664"),
    ("3:4", "1104*1472"),
];

/// `generateImageDashscope(config, model, input, signal)`
async fn generate_image_dashscope(
    rt: &Rt,
    fx: &AiFetch,
    config: &AiMediaProviderConfig,
    model: &str,
    input: &GenerateImageInput,
    signal: &Signal,
) -> Result<MediaBlob, JsError> {
    if input.references.as_deref().is_some_and(|r| !r.is_empty()) {
        return Err(JsError::error(
            "Qwen-Image here generates from the prompt alone; pick another image provider for edits.",
        ));
    }
    let size = ratio_size(DASHSCOPE_SIZES, input.aspect_ratio.as_deref());
    let url = endpoint_url(
        &dashscope_root(config)?,
        "/api/v1/services/aigc/multimodal-generation/generation",
        None,
    )?;
    let mut parameters = vec![("n", number(1.0)), ("watermark", JsonValue::Bool(false))];
    if let Some(size) = size.as_ref().and_then(Size::json) {
        parameters.push(("size", size));
    }
    let body = object(vec![
        ("model", text(model)),
        (
            "input",
            object(vec![(
                "messages",
                JsonValue::Array(vec![object(vec![
                    ("role", text("user")),
                    (
                        "content",
                        JsonValue::Array(vec![object(vec![("text", text(input.prompt.as_str()))])]),
                    ),
                ])]),
            )]),
        ),
        ("parameters", object(parameters)),
    ]);
    let resp = send(rt, fx, &url, post_json(json_bearer(config), &body), signal).await?;
    if !resp.ok() {
        return fail_from("Image generation failed:", &resp).await;
    }
    let json = read_json("Image generation failed:", &resp).await?;
    if let Some(code) = nonempty(get(Some(&json), "code")) {
        return Err(JsError::error(format!(
            "Image generation failed: {code} {}",
            js_string_or_empty(get(Some(&json), "message"))
        )));
    }
    let choices = first(get(rec(get(Some(&json), "output")), "choices"));
    let choice = rec(choices.as_deref());
    let content = get(rec(get(choice, "message")), "content");
    let image = match content {
        Some(JsonValue::Array(items)) => items
            .iter()
            .find_map(|c| as_str(get(rec(Some(c)), "image"))),
        _ => None,
    };
    let Some(image) = image else {
        return Err(JsError::error(format!(
            "Image generation returned no image: {}",
            head200(&json)
        )));
    };
    download_image(rt, fx, "Image generation failed:", image, signal).await
}

// ── MiniMax image_generation ───────────────────────────────────────

const MINIMAX_RATIOS: &[&str] = &["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"];

/// `generateImageMinimax(config, model, input, signal)`
async fn generate_image_minimax(
    rt: &Rt,
    fx: &AiFetch,
    config: &AiMediaProviderConfig,
    model: &str,
    input: &GenerateImageInput,
    signal: &Signal,
) -> Result<MediaBlob, JsError> {
    if input.references.as_deref().is_some_and(|r| !r.is_empty()) {
        return Err(JsError::error(
            "MiniMax image-01 here generates from the prompt alone; pick another image provider for edits.",
        ));
    }
    let base =
        trim_slash(truthy_or(config.base_url.as_deref(), MINIMAX_BASE_URL).unwrap_or_default());
    let ratio = input
        .aspect_ratio
        .as_deref()
        .filter(|r| !r.is_empty() && MINIMAX_RATIOS.contains(r));
    let url = endpoint_url(&base, "/image_generation", None)?;
    let mut body = vec![
        ("model", text(model)),
        ("prompt", text(input.prompt.as_str())),
        ("n", number(1.0)),
        ("response_format", text("base64")),
    ];
    if let Some(ratio) = ratio {
        body.push(("aspect_ratio", text(ratio)));
    }
    let resp = send(
        rt,
        fx,
        &url,
        post_json(json_bearer(config), &object(body)),
        signal,
    )
    .await?;
    if !resp.ok() {
        return fail_from("Image generation failed:", &resp).await;
    }
    let json = read_json("Image generation failed:", &resp).await?;
    let status = rec(get(Some(&json), "base_resp"));
    if let Some(JsonValue::Number(code)) = get(status, "status_code")
        && *code != 0.0
    {
        return Err(JsError::error(format!(
            "Image generation failed: {} {}",
            number_to_string(*code),
            js_string_or_empty(get(status, "status_msg"))
        )));
    }
    let data = rec(get(Some(&json), "data"));
    let b64 = first(get(data, "image_base64"));
    if let Some(b64) = nonempty(b64.as_deref()) {
        return Ok(from_base64(b64, None));
    }
    let url = first(get(data, "image_urls"));
    if let Some(url) = nonempty(url.as_deref()) {
        return download_image(rt, fx, "Image generation failed:", url, signal).await;
    }
    Err(JsError::error(format!(
        "Image generation returned no image: {}",
        head200(&json)
    )))
}

// ── OpenAI-compatible chat understanding ───────────────────────────

/// `analyzeMediaOpenAi(provider, config, model, input, signal)`
async fn analyze_media_open_ai(
    rt: &Rt,
    fx: &AiFetch,
    provider: &str,
    config: &AiMediaProviderConfig,
    model: &str,
    input: &AnalyzeMediaInput,
    signal: &Signal,
) -> Result<String, JsError> {
    let meta = meta_of(provider)?;
    let mut parts = vec![object(vec![
        ("type", text("text")),
        ("text", text(input.requirements.as_str())),
    ])];
    for m in &input.media {
        if m.mime.starts_with("image/") {
            parts.push(object(vec![
                ("type", text("image_url")),
                ("image_url", object(vec![("url", text(data_url(m)))])),
            ]));
        } else if m.mime.starts_with("video/") && meta.video_analysis {
            parts.push(object(vec![
                ("type", text("video_url")),
                ("video_url", object(vec![("url", text(data_url(m)))])),
            ]));
        } else {
            return Err(JsError::error(format!(
                "{} cannot analyze {} ({}) here; {} analysis needs Gemini.",
                meta.label,
                m.name.as_deref().unwrap_or(&m.mime),
                m.mime,
                if meta.video_analysis {
                    "audio"
                } else {
                    "video and audio"
                }
            )));
        }
    }
    let url = endpoint_url(&open_ai_base(provider, config)?, "/chat/completions", None)?;
    let body = object(vec![
        ("model", text(model)),
        (
            "messages",
            JsonValue::Array(vec![object(vec![
                ("role", text("user")),
                ("content", JsonValue::Array(parts)),
            ])]),
        ),
    ]);
    let resp = send(rt, fx, &url, post_json(json_bearer(config), &body), signal).await?;
    if !resp.ok() {
        return fail_from("Media analysis failed:", &resp).await;
    }
    let json = read_json("Media analysis failed:", &resp).await?;
    let choices = first(get(Some(&json), "choices"));
    let choice = rec(choices.as_deref());
    let answer = open_ai_content_text(get(rec(get(choice, "message")), "content"));
    let answer = trim(&answer);
    if answer.is_empty() {
        return Err(JsError::error("Media analysis returned an empty answer"));
    }
    Ok(answer.to_owned())
}

// ── Gemini (native image output, Imagen predict, multimodal understanding) ──

const GEMINI_ASPECT_RATIOS: &[&str] = &[
    "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
];

/// `geminiHeaders(config)`
fn gemini_headers(config: &AiMediaProviderConfig) -> Vec<(String, String)> {
    vec![
        pair("Content-Type", "application/json"),
        pair("x-goog-api-key", &config.api_key),
    ]
}

/// `geminiParts(candidate)`: each part as a record
fn gemini_parts(candidate: Option<&JsonValue>) -> Vec<Option<&JsonValue>> {
    let content = rec(get(rec(candidate), "content"));
    match get(content, "parts") {
        Some(JsonValue::Array(items)) => items.iter().map(|p| rec(Some(p))).collect(),
        _ => Vec::new(),
    }
}

/// `geminiBlockedReason(json)`
fn gemini_blocked_reason(json: &JsonValue) -> String {
    let feedback = rec(get(Some(json), "promptFeedback"));
    let candidates = first(get(Some(json), "candidates"));
    let candidate = rec(candidates.as_deref());
    let reason = coalesce(get(feedback, "blockReason"), get(candidate, "finishReason"));
    match as_str(reason) {
        Some(reason) if reason != "STOP" => format!(" ({reason})"),
        _ => String::new(),
    }
}

/// `p.text` of each part when it is a string, `''` otherwise
fn part_texts<'a>(parts: &[Option<&'a JsonValue>]) -> Vec<&'a str> {
    parts
        .iter()
        .map(|p| as_str(get(*p, "text")).unwrap_or(""))
        .collect()
}

/// `generateImageGemini(config, model, input, signal)`
async fn generate_image_gemini(
    rt: &Rt,
    fx: &AiFetch,
    config: &AiMediaProviderConfig,
    model: &str,
    input: &GenerateImageInput,
    signal: &Signal,
) -> Result<MediaBlob, JsError> {
    let base = gemini_base(config);
    let aspect_ratio = input
        .aspect_ratio
        .as_deref()
        .filter(|r| !r.is_empty() && GEMINI_ASPECT_RATIOS.contains(r));
    if model.starts_with("imagen-") {
        let url = endpoint_url(&base, &format!("/models/{model}:predict"), None)?;
        let mut parameters = vec![("sampleCount", number(1.0))];
        if let Some(ratio) = aspect_ratio {
            parameters.push(("aspectRatio", text(ratio)));
        }
        let body = object(vec![
            (
                "instances",
                JsonValue::Array(vec![object(vec![("prompt", text(input.prompt.as_str()))])]),
            ),
            ("parameters", object(parameters)),
        ]);
        let resp = send(
            rt,
            fx,
            &url,
            post_json(gemini_headers(config), &body),
            signal,
        )
        .await?;
        if !resp.ok() {
            return fail_from("Image generation failed:", &resp).await;
        }
        let json = read_json("Image generation failed:", &resp).await?;
        let predictions = first(get(Some(&json), "predictions"));
        let entry = rec(predictions.as_deref());
        let Some(b64) = as_str(get(entry, "bytesBase64Encoded")) else {
            return Err(JsError::error(format!(
                "Image generation returned no image: {}",
                head200(&json)
            )));
        };
        return Ok(from_base64(b64, get(entry, "mimeType")));
    }
    let url = endpoint_url(&base, &format!("/models/{model}:generateContent"), None)?;
    let mut parts = vec![object(vec![("text", text(input.prompt.as_str()))])];
    for reference in input.references.as_deref().unwrap_or_default() {
        parts.push(object(vec![(
            "inline_data",
            object(vec![
                ("mime_type", text(reference.mime.as_str())),
                ("data", text(bytes_to_base64(&reference.bytes))),
            ]),
        )]));
    }
    let mut generation_config = vec![(
        "responseModalities",
        JsonValue::Array(vec![text("TEXT"), text("IMAGE")]),
    )];
    if let Some(ratio) = aspect_ratio {
        generation_config.push(("imageConfig", object(vec![("aspectRatio", text(ratio))])));
    }
    let body = object(vec![
        (
            "contents",
            JsonValue::Array(vec![object(vec![
                ("role", text("user")),
                ("parts", JsonValue::Array(parts)),
            ])]),
        ),
        ("generationConfig", object(generation_config)),
    ]);
    let resp = send(
        rt,
        fx,
        &url,
        post_json(gemini_headers(config), &body),
        signal,
    )
    .await?;
    if !resp.ok() {
        return fail_from("Image generation failed:", &resp).await;
    }
    let json = read_json("Image generation failed:", &resp).await?;
    let candidates = first(get(Some(&json), "candidates"));
    let parts = gemini_parts(candidates.as_deref());
    let image = parts
        .iter()
        .find_map(|p| {
            let d = rec(coalesce(get(*p, "inlineData"), get(*p, "inline_data")));
            matches!(get(d, "data"), Some(JsonValue::String(_))).then_some(d)
        })
        .flatten();
    let Some(image) = image else {
        let joined = part_texts(&parts).join(" ");
        let joined = trim(&joined);
        let tail = if joined.is_empty() {
            String::new()
        } else {
            format!(": {}", slice_to(joined, 200))
        };
        return Err(JsError::error(format!(
            "Image generation returned no image{}{tail}",
            gemini_blocked_reason(&json)
        )));
    };
    let data = as_str(get(Some(image), "data")).unwrap_or_default();
    Ok(from_base64(
        data,
        coalesce(get(Some(image), "mimeType"), get(Some(image), "mime_type")),
    ))
}

/// `url.host` of a parsed URL: the host and a port that is not the default
fn url_host(url: &url::Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

/// `geminiUploadUrl(startUrl, named)`: where the bytes of a Files API upload
/// go. The address is used only on the origin the start request went to.
fn gemini_upload_url(start_url: &str, named: &str) -> Result<String, JsError> {
    let Ok(upload) = url::Url::parse(named) else {
        return Err(JsError::error(
            "Media upload failed: the provider answered with an upload address that is not a URL. The API key was not sent to it.",
        ));
    };
    if upload.origin().ascii_serialization() != parse_url(start_url)?.origin().ascii_serialization()
    {
        return Err(JsError::error(format!(
            "Media upload failed: the provider answered with an upload address that is not its own ({}://{}). The API key was not sent to it.",
            upload.scheme(),
            slice_to(&url_host(&upload), 100)
        )));
    }
    Ok(upload.to_string())
}

/// `geminiUploadFile(config, blob, signal)`: Files API resumable upload
/// (start, upload and finalize, wait for ACTIVE); the `file_data` part
async fn gemini_upload_file(
    rt: &Rt,
    fx: &AiFetch,
    config: &AiMediaProviderConfig,
    blob: &MediaBlob,
    signal: &Signal,
) -> Result<JsonValue, JsError> {
    let base = gemini_base(config);
    let mut root = parse_url(&base)?;
    let path = js_regex!(r"/v1(beta)?$").replace_all(&trim_slash(root.path()), |_| String::new());
    set_pathname(&mut root, &path);
    let start_url = endpoint_url(root.as_str(), "/upload/v1beta/files", None)?;
    let length = blob.bytes.len().to_string();
    let mut headers = gemini_headers(config);
    headers.push(pair("X-Goog-Upload-Protocol", "resumable"));
    headers.push(pair("X-Goog-Upload-Command", "start"));
    headers.push(pair("X-Goog-Upload-Header-Content-Length", &length));
    headers.push(pair("X-Goog-Upload-Header-Content-Type", &blob.mime));
    let body = object(vec![(
        "file",
        object(vec![(
            "display_name",
            text(blob.name.as_deref().unwrap_or("media")),
        )]),
    )]);
    let start = send(rt, fx, &start_url, post_json(headers, &body), signal).await?;
    if !start.ok() {
        return fail_from("Media upload failed:", &start).await;
    }
    let named = match start.header("x-goog-upload-url") {
        Some(named) if !named.is_empty() => named,
        _ => {
            return Err(JsError::error(
                "Media upload failed: no upload URL returned",
            ));
        }
    };
    let upload_url = gemini_upload_url(&start_url, &named)?;
    let upload = send(
        rt,
        fx,
        &upload_url,
        post(
            vec![
                pair("x-goog-api-key", &config.api_key),
                pair("Content-Length", &length),
                pair("X-Goog-Upload-Offset", "0"),
                pair("X-Goog-Upload-Command", "upload, finalize"),
            ],
            RequestBody::Bytes(blob.bytes.clone()),
        ),
        signal,
    )
    .await?;
    if !upload.ok() {
        return fail_from("Media upload failed:", &upload).await;
    }
    let uploaded = read_json("Media upload failed:", &upload).await?;
    let mut file = rec(get(Some(&uploaded), "file"))
        .cloned()
        .unwrap_or_else(|| JsonValue::Object(Obj::new()));
    let deadline = rt.now() + GEMINI_FILE_READY_TIMEOUT_MS;
    // videos are transcoded server-side before they can be referenced
    while as_str(prop(&file, "state")) == Some("PROCESSING") {
        if rt.now() > deadline {
            return Err(JsError::error(
                "Media upload timed out while the file was processing",
            ));
        }
        rt.sleep(GEMINI_FILE_POLL_MS).await;
        let url = endpoint_url(&base, &format!("/{}", value_key(prop(&file, "name"))), None)?;
        let poll = send(
            rt,
            fx,
            &url,
            Request {
                headers: vec![pair("x-goog-api-key", &config.api_key)],
                ..Request::default()
            },
            signal,
        )
        .await?;
        if !poll.ok() {
            return fail_from("Media upload failed:", &poll).await;
        }
        file = read_json("Media upload failed:", &poll).await?;
    }
    let uri = as_str(prop(&file, "uri"));
    if as_str(prop(&file, "state")) != Some("ACTIVE") || uri.is_none() {
        return Err(JsError::error(format!(
            "Media upload failed: file state {}",
            match coalesce(prop(&file, "state"), None) {
                None => "unknown".to_owned(),
                Some(state) => js_string_or_empty(Some(state)),
            }
        )));
    }
    let mime = match coalesce(prop(&file, "mimeType"), None) {
        None => blob.mime.clone(),
        Some(mime) => js_string_or_empty(Some(mime)),
    };
    Ok(object(vec![(
        "file_data",
        object(vec![
            ("mime_type", text(mime)),
            ("file_uri", text(uri.unwrap_or_default())),
        ]),
    )]))
}

/// `analyzeMediaGemini(config, model, input, signal)`
async fn analyze_media_gemini(
    rt: &Rt,
    fx: &AiFetch,
    config: &AiMediaProviderConfig,
    model: &str,
    input: &AnalyzeMediaInput,
    signal: &Signal,
) -> Result<String, JsError> {
    let total: usize = input.media.iter().map(|m| m.bytes.len()).sum();
    let inline = total <= GEMINI_INLINE_LIMIT_BYTES;
    let mut parts: Vec<JsonValue> = Vec::new();
    for blob in &input.media {
        parts.push(if inline {
            object(vec![(
                "inline_data",
                object(vec![
                    ("mime_type", text(blob.mime.as_str())),
                    ("data", text(bytes_to_base64(&blob.bytes))),
                ]),
            )])
        } else {
            gemini_upload_file(rt, fx, config, blob, signal).await?
        });
    }
    parts.push(object(vec![("text", text(input.requirements.as_str()))]));
    let url = endpoint_url(
        &gemini_base(config),
        &format!("/models/{model}:generateContent"),
        None,
    )?;
    let body = object(vec![(
        "contents",
        JsonValue::Array(vec![object(vec![
            ("role", text("user")),
            ("parts", JsonValue::Array(parts)),
        ])]),
    )]);
    let resp = send(
        rt,
        fx,
        &url,
        post_json(gemini_headers(config), &body),
        signal,
    )
    .await?;
    if !resp.ok() {
        return fail_from("Media analysis failed:", &resp).await;
    }
    let json = read_json("Media analysis failed:", &resp).await?;
    let candidates = first(get(Some(&json), "candidates"));
    let parts = gemini_parts(candidates.as_deref());
    let joined = part_texts(&parts).concat();
    let answer = trim(&joined);
    if answer.is_empty() {
        return Err(JsError::error(format!(
            "Media analysis returned an empty answer{}",
            gemini_blocked_reason(&json)
        )));
    }
    Ok(answer.to_owned())
}

// ── Microsoft Foundry MAI image API ─────────────────────────────────

/// MAI wants pixel width/height (min 768 each); this grid stays within the
/// tightest pixel cap (MAI-Image-2.5 models: 1,048,576 pixels)
const MAI_SIZES: &[(&str, &str)] = &[
    ("1:1", "1024x1024"),
    ("16:9", "1344x768"),
    ("3:2", "1152x768"),
    ("4:3", "1152x864"),
    ("9:16", "768x1344"),
    ("2:3", "768x1152"),
    ("3:4", "864x1152"),
];

/// `maiImageResult(label, resp)`
async fn mai_image_result(label: &str, resp: &Response) -> Result<MediaBlob, JsError> {
    if !resp.ok() {
        return fail_from(label, resp).await;
    }
    let json = read_json(label, resp).await?;
    let data = first(get(Some(&json), "data"));
    if let Some(b64) = nonempty(get(rec(data.as_deref()), "b64_json")) {
        return Ok(from_base64(b64, None));
    }
    Err(JsError::error(format!(
        "{label} returned no image: {}",
        head200(&json)
    )))
}

/// `generateImageMai(config, model, input, signal)`
async fn generate_image_mai(
    rt: &Rt,
    fx: &AiFetch,
    config: &AiMediaProviderConfig,
    model: &str,
    input: &GenerateImageInput,
    signal: &Signal,
) -> Result<MediaBlob, JsError> {
    let base = trim_slash(config.base_url.as_deref().unwrap_or_default());
    let size = not_auto(input.aspect_ratio.as_deref()).and_then(|r| table_size(MAI_SIZES, r));
    // `size.split('x').map(Number)`: a built-in answered by the table has no `split`
    let dimensions = match &size {
        Some(Size::Text(s)) => {
            let mut numbers = s.split('x').map(to_number);
            Some((numbers.next(), numbers.next()))
        }
        Some(_) => return Err(JsError::type_error("size.split is not a function")),
        None => None,
    };
    let auth = vec![pair("api-key", &config.api_key)];
    let references: &[MediaBlob] = input.references.as_deref().unwrap_or_default();
    if !references.is_empty() {
        // edits ride /mai/v1/images/edits: multipart with the reference images
        // repeated in the `image` field, at most five per request
        if references.len() > 5 {
            return Err(JsError::error(
                "MAI-Image accepts at most 5 reference images per edit",
            ));
        }
        let mut form = vec![
            form_text("model", model),
            form_text("prompt", &input.prompt),
        ];
        for (i, reference) in references.iter().enumerate() {
            form.push(form_reference("image", reference, i));
        }
        let resp = send(
            rt,
            fx,
            &format!("{base}/mai/v1/images/edits"),
            post(auth, RequestBody::Form(form)),
            signal,
        )
        .await?;
        return mai_image_result("MAI image edit failed:", &resp).await;
    }
    let mut headers = auth;
    headers.push(pair("Content-Type", "application/json"));
    let mut body = vec![
        ("model", text(model)),
        ("prompt", text(input.prompt.as_str())),
    ];
    if let Some((Some(width), Some(height))) = dimensions
        && width != 0.0
        && !width.is_nan()
        && height != 0.0
        && !height.is_nan()
    {
        body.push(("width", number(width)));
        body.push(("height", number(height)));
    }
    let resp = send(
        rt,
        fx,
        &format!("{base}/mai/v1/images/generations"),
        post_json(headers, &object(body)),
        signal,
    )
    .await?;
    mai_image_result("MAI image generation failed:", &resp).await
}

// ── dispatch ────────────────────────────────────────────────────────

/// `stabilityEndpointOf(model)`: Stability's generation endpoint per model
/// id; sd3.5 ids pick the model inside /sd3
fn stability_endpoint_of(model: &str) -> Result<(&'static str, Option<&str>), JsError> {
    match model {
        "stable-image-ultra" => Ok(("ultra", None)),
        "stable-image-core" => Ok(("core", None)),
        "sd3.5-large" | "sd3.5-large-turbo" | "sd3.5-medium" => Ok(("sd3", Some(model))),
        _ => Err(JsError::error(format!(
            "Unknown Stability AI image model: {model}"
        ))),
    }
}

/// Stability serves these aspect ratios on the generate endpoints; anything else omits the field
const STABILITY_ASPECT_RATIOS: &[&str] = &["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2"];

/// `generateImageStability(config, model, input, signal)`
async fn generate_image_stability(
    rt: &Rt,
    fx: &AiFetch,
    config: &AiMediaProviderConfig,
    model: &str,
    input: &GenerateImageInput,
    signal: &Signal,
) -> Result<MediaBlob, JsError> {
    if input.references.as_deref().is_some_and(|r| !r.is_empty()) {
        return Err(JsError::error(
            "Stability AI cannot edit or reference images here; generate from the prompt alone or pick another image provider.",
        ));
    }
    let (path, sd3_model) = stability_endpoint_of(model)?;
    let mut form = vec![
        form_text("prompt", &input.prompt),
        form_text("output_format", "png"),
    ];
    if let Some(sd3_model) = sd3_model {
        form.push(form_text("model", sd3_model));
    }
    if let Some(ratio) = not_auto(input.aspect_ratio.as_deref())
        && STABILITY_ASPECT_RATIOS.contains(&ratio)
    {
        form.push(form_text("aspect_ratio", ratio));
    }
    // Accept: image/* makes the API answer the rendered bytes directly instead of
    // a base64 JSON envelope
    let url = format!(
        "{}/v2beta/stable-image/generate/{path}",
        trim_slash(truthy_or(config.base_url.as_deref(), STABILITY_BASE_URL).unwrap_or_default())
    );
    let resp = send(
        rt,
        fx,
        &url,
        post(
            vec![
                pair("Accept", "image/*"),
                pair("Authorization", &format!("Bearer {}", config.api_key)),
            ],
            RequestBody::Form(form),
        ),
        signal,
    )
    .await?;
    if !resp.ok() {
        return fail_from("Stable Image generation failed:", &resp).await;
    }
    let bytes = read_capped(&resp, "Stable Image").await?;
    let mime = sniff_image_mime(
        &bytes,
        &resp.header("content-type").unwrap_or("image/png".into()),
    );
    Ok(MediaBlob {
        bytes,
        mime,
        name: None,
    })
}

const BFL_CANCELLED: &str = "FLUX generation timed out or was cancelled";

/// `BflPollWaits`: the waits between the polls of one queued FLUX job. The
/// guard carries ONE abort listener for the whole poll loop.
struct BflPollWaits {
    rt: Rt,
    guard: Signal,
    /// `cancelWait`: stops the wait in progress
    cancel_wait: Rc<RefCell<Option<Box<dyn FnOnce()>>>>,
    listener: Id,
}

impl BflPollWaits {
    /// `bflPollWaits(guard)`
    fn new(rt: &Rt, guard: &Signal) -> BflPollWaits {
        let cancel_wait: Rc<RefCell<Option<Box<dyn FnOnce()>>>> = Rc::new(RefCell::new(None));
        let slot = cancel_wait.clone();
        // `onAbort`: `cancelWait?.()`
        let listener = guard.on_abort(move |_| {
            let cancel = slot.borrow_mut().take();
            if let Some(cancel) = cancel {
                cancel();
            }
        });
        BflPollWaits {
            rt: rt.clone(),
            guard: guard.clone(),
            cancel_wait,
            listener,
        }
    }

    /// `next(ms)`: resolves after `ms`; rejects at once when the guard aborts
    async fn next(&self, ms: f64) -> Result<(), JsError> {
        if self.guard.aborted() {
            return Err(JsError::error(BFL_CANCELLED));
        }
        let (settle, wait) = self.rt.deferred::<Result<(), JsError>>();
        let slot = self.cancel_wait.clone();
        let on_time = settle.clone();
        let timer = self.rt.set_timeout(ms, move || {
            slot.borrow_mut().take();
            on_time.settle(Ok(()));
        });
        let rt = self.rt.clone();
        *self.cancel_wait.borrow_mut() = Some(Box::new(move || {
            rt.clear_timeout(Some(timer));
            settle.settle(Err(JsError::error(BFL_CANCELLED)));
        }));
        wait.await
    }

    /// `done()`: takes the listener off the guard
    fn done(&self) {
        self.guard.off(self.listener);
    }
}

/// `bflPollUrl(base, queued)`: where to poll a queued FLUX job. Every poll
/// carries the API key, so an address the provider's reply names is used only
/// when it is the provider's own: an `https:` host of the same registrable
/// domain. A base URL the person set is held to its own host the same way; an
/// IP address or a one-label name has to match exactly.
fn bfl_poll_url(
    base: &str,
    queued: &JsonValue,
    get_domain: RegistrableDomain<'_>,
) -> Result<String, JsError> {
    let address = match nonempty(prop(queued, "polling_url")) {
        Some(named) => named.to_owned(),
        None => format!(
            "{base}/v1/get_result?id={}",
            encode_uri_component(&js_string_or_empty(prop(queued, "id")))
        ),
    };
    let submitted = parse_url(base)?;
    let Ok(poll) = url::Url::parse(&address) else {
        return Err(JsError::error(
            "FLUX generation failed: the provider answered with a polling address that is not a URL. The API key was not sent to it.",
        ));
    };
    let submitted_host = submitted.host_str().unwrap_or_default();
    let poll_host = poll.host_str().unwrap_or_default();
    // Private suffixes keep separate hosted tenants from being treated as one provider.
    let site = get_domain(submitted_host);
    let same_site =
        poll_host == submitted_host || (site.is_some() && site == get_domain(poll_host));
    if poll.scheme() != "https" || !same_site {
        return Err(JsError::error(format!(
            "FLUX generation failed: the provider answered with a polling address that is not its own ({}://{}). The API key was not sent to it.",
            poll.scheme(),
            slice_to(&url_host(&poll), 100)
        )));
    }
    Ok(poll.to_string())
}

/// `bflDimensions(aspectRatio)`: FLUX.2 Pro / FLUX 1.1 take width/height
/// (256..1440, multiples of 32), not aspect_ratio; map the UI ratio onto a
/// 1024-long box.
fn bfl_dimensions(aspect_ratio: &str) -> Option<(f64, f64)> {
    let found = js_regex!(r"^(\d+):(\d+)$").exec(aspect_ratio)?;
    let ratio_w = to_number(found.get(1).unwrap_or_default());
    let ratio_h = to_number(found.get(2).unwrap_or_default());
    if ratio_w.is_nan() || ratio_w <= 0.0 || ratio_h.is_nan() || ratio_h <= 0.0 {
        return None;
    }
    let long = 1024.0;
    let round32 = |n: f64| math_max(256.0, math_round(n / 32.0) * 32.0);
    Some(if ratio_w >= ratio_h {
        (long, round32((long * ratio_h) / ratio_w))
    } else {
        (round32((long * ratio_w) / ratio_h), long)
    })
}

/// `generateImageBfl(config, model, input, signal)`
async fn generate_image_bfl(
    rt: &Rt,
    fx: &AiFetch,
    config: &AiMediaProviderConfig,
    model: &str,
    input: &GenerateImageInput,
    signal: &Signal,
    get_domain: RegistrableDomain<'_>,
) -> Result<MediaBlob, JsError> {
    if input.references.as_deref().is_some_and(|r| !r.is_empty()) {
        return Err(JsError::error(
            "FLUX cannot edit or reference images here; generate from the prompt alone or pick another image provider.",
        ));
    }
    let base = trim_slash(truthy_or(config.base_url.as_deref(), BFL_BASE_URL).unwrap_or_default());
    let headers = vec![
        pair("x-key", &config.api_key),
        pair("Content-Type", "application/json"),
        pair("accept", "application/json"),
    ];
    let mut body = vec![("prompt", text(input.prompt.as_str()))];
    if let Some(ratio) = not_auto(input.aspect_ratio.as_deref()) {
        // only FLUX 3 Image documents aspect_ratio; the others take width/height
        if model == "flux-3-image" {
            body.push(("aspect_ratio", text(ratio)));
        } else if let Some((width, height)) = bfl_dimensions(ratio) {
            body.push(("width", number(width)));
            body.push(("height", number(height)));
        }
    }
    let submit = send(
        rt,
        fx,
        &format!("{base}/v1/{model}"),
        post_json(headers, &object(body)),
        signal,
    )
    .await?;
    if !submit.ok() {
        return fail_from("FLUX generation failed:", &submit).await;
    }
    let queued = read_json("FLUX", &submit).await?;
    let poll_url = bfl_poll_url(&base, &queued, get_domain)?;
    // the job is queued server-side; results come as status Ready + sample_url
    let waits = BflPollWaits::new(rt, signal);
    let result = poll_bfl(rt, fx, config, &poll_url, signal, &waits).await;
    waits.done();
    result
}

/// The `for (;;)` of `generateImageBfl`
async fn poll_bfl(
    rt: &Rt,
    fx: &AiFetch,
    config: &AiMediaProviderConfig,
    poll_url: &str,
    signal: &Signal,
    waits: &BflPollWaits,
) -> Result<MediaBlob, JsError> {
    loop {
        waits.next(1_500.0).await?;
        let poll = send(
            rt,
            fx,
            poll_url,
            Request {
                headers: vec![pair("x-key", &config.api_key)],
                ..Request::default()
            },
            signal,
        )
        .await?;
        if !poll.ok() {
            return fail_from("FLUX generation failed:", &poll).await;
        }
        let json = read_json("FLUX result", &poll).await?;
        let status = js_string_or_empty(prop(&json, "status"));
        if status == "Ready" {
            // BFL's quick start: result.result.sample
            let result = coalesce(prop(&json, "result"), None);
            let sample = match nonempty(get(result, "sample")) {
                Some(sample) => Some(sample),
                None => nonempty(prop(&json, "sample_url")),
            };
            let Some(sample) = sample else {
                return Err(JsError::error(format!(
                    "FLUX returned no image URL: {}",
                    head200(&json)
                )));
            };
            return download_image(rt, fx, "FLUX", sample, signal).await;
        }
        if matches!(
            status.as_str(),
            "Error" | "Failed" | "No Card Generated" | "Content Moderated" | "Request Moderated"
        ) {
            return Err(JsError::error(format!("FLUX generation failed: {status}")));
        }
    }
}

/// `modelOf(meta, config, field)`
fn model_of(
    meta: &AiMediaProviderMeta,
    config: &AiMediaProviderConfig,
    image: bool,
) -> Result<String, JsError> {
    let (given, default) = if image {
        (&config.image_model, meta.default_image_model)
    } else {
        (&config.analysis_model, meta.default_analysis_model)
    };
    match truthy_or(Some(given.as_str()), default) {
        Some(model) => Ok(model.to_owned()),
        None => Err(JsError::error(format!(
            "No {} model configured for the {} media provider",
            if image { "image" } else { "analysis" },
            meta.label
        ))),
    }
}

/// `requireBaseUrl(meta, config)`
fn require_base_url(
    meta: &AiMediaProviderMeta,
    config: &AiMediaProviderConfig,
) -> Result<(), JsError> {
    if meta.needs_base_url && config.base_url.as_deref().is_none_or(str::is_empty) {
        return Err(JsError::error(format!(
            "The {} media provider requires a Base URL",
            meta.label
        )));
    }
    Ok(())
}

/// `generateImageWithProvider(provider, config, input, signal)`
pub async fn generate_image_with_provider(
    rt: &Rt,
    fx: &AiFetch,
    provider: &str,
    config: &AiMediaProviderConfig,
    input: &GenerateImageInput,
    signal: Option<&Signal>,
    get_domain: RegistrableDomain<'_>,
) -> Result<MediaBlob, JsError> {
    let meta = meta_of(provider)?;
    require_base_url(meta, config)?;
    let Some(protocol) = meta.image_protocol else {
        return Err(JsError::error(format!(
            "{} does not generate images",
            meta.label
        )));
    };
    let model = model_of(meta, config, true)?;
    let guard = with_timeout(rt, signal, GENERATE_TIMEOUT_MS);
    match protocol {
        "gemini" => generate_image_gemini(rt, fx, config, &model, input, &guard).await,
        "dashscope" => generate_image_dashscope(rt, fx, config, &model, input, &guard).await,
        "minimax" => generate_image_minimax(rt, fx, config, &model, input, &guard).await,
        "stability" => generate_image_stability(rt, fx, config, &model, input, &guard).await,
        "bfl" => generate_image_bfl(rt, fx, config, &model, input, &guard, get_domain).await,
        "mai" => generate_image_mai(rt, fx, config, &model, input, &guard).await,
        "openai-images" => {
            generate_image_open_ai(rt, fx, provider, config, &model, input, &guard).await
        }
        // the catalog holds no other protocol
        other => Err(JsError::type_error(format!(
            "Unknown image protocol: {other}"
        ))),
    }
}

/// `analyzeMediaWithProvider(provider, config, input, signal)`
pub async fn analyze_media_with_provider(
    rt: &Rt,
    fx: &AiFetch,
    provider: &str,
    config: &AiMediaProviderConfig,
    input: &AnalyzeMediaInput,
    signal: Option<&Signal>,
) -> Result<String, JsError> {
    let meta = meta_of(provider)?;
    require_base_url(meta, config)?;
    let Some(protocol) = meta.analysis_protocol else {
        return Err(JsError::error(format!(
            "{} does not analyze media",
            meta.label
        )));
    };
    let model = model_of(meta, config, false)?;
    let guard = with_timeout(rt, signal, ANALYZE_TIMEOUT_MS);
    if protocol == "gemini" {
        analyze_media_gemini(rt, fx, config, &model, input, &guard).await
    } else {
        analyze_media_open_ai(rt, fx, provider, config, &model, input, &guard).await
    }
}

/// `testMediaProvider(provider, config, signal)`: the cheap credential check
/// for the settings-UI connection test; no image is billed. A model listing
/// is the closest thing every vendor has. Vendors without one answer 404/405
/// even for a valid key, so only those two statuses count as a pass when the
/// response is not ok (BFL's probe authenticates the key, so only a 200 passes
/// there). Every other non-ok status is a failure with the status included.
pub async fn test_media_provider(
    rt: &Rt,
    fx: &AiFetch,
    provider: &str,
    config: &AiMediaProviderConfig,
    signal: Option<&Signal>,
) -> MediaTestResult {
    match probe_media_provider(rt, fx, provider, config, signal).await {
        Ok(result) => result,
        Err(e) => MediaTestResult {
            ok: false,
            error: Some(e.message_or_string()),
        },
    }
}

/// the `try` of `testMediaProvider`
async fn probe_media_provider(
    rt: &Rt,
    fx: &AiFetch,
    provider: &str,
    config: &AiMediaProviderConfig,
    signal: Option<&Signal>,
) -> Result<MediaTestResult, JsError> {
    let meta = meta_of(provider)?;
    require_base_url(meta, config)?;
    let guard = with_timeout(rt, signal, TEST_TIMEOUT_MS);
    // provider-aware credential probes: BFL authenticates with x-key and has
    // no model listing (the credits endpoint answers 403 without a valid
    // key and 200 with one), Microsoft Foundry with api-key rather than a
    // Bearer token
    let get_with = |headers: Vec<(String, String)>| Request {
        headers,
        ..Request::default()
    };
    let resp = if provider == "gemini" {
        send(
            rt,
            fx,
            &gemini_models_probe_url(config)?,
            get_with(vec![pair("x-goog-api-key", &config.api_key)]),
            &guard,
        )
        .await?
    } else if provider == "bfl" {
        // /v1/credits is the only cheap BFL endpoint that checks the key:
        // it answers 403 without a valid key, 422 for a malformed key and
        // 200 with the credit balance for a good one
        let base =
            trim_slash(truthy_or(config.base_url.as_deref(), BFL_BASE_URL).unwrap_or_default());
        send(
            rt,
            fx,
            &format!("{base}/v1/credits"),
            get_with(vec![pair("x-key", &config.api_key)]),
            &guard,
        )
        .await?
    } else if provider == "microsoft" {
        let url = endpoint_url(&open_ai_base(provider, config)?, "/models", None)?;
        send(
            rt,
            fx,
            &url,
            get_with(vec![pair("api-key", &config.api_key)]),
            &guard,
        )
        .await?
    } else {
        let url = endpoint_url(&open_ai_base(provider, config)?, "/models", None)?;
        send(rt, fx, &url, get_with(bearer(config)), &guard).await?
    };
    if resp.ok() {
        return Ok(MediaTestResult {
            ok: true,
            error: None,
        });
    }
    // Vendors without a model-listing endpoint answer 404/405 to a valid
    // key, so those statuses still mean the credentials are usable. BFL is
    // excluded: its probe endpoint authenticates the key.
    if provider != "bfl" && (resp.status() == 404.0 || resp.status() == 405.0) {
        return Ok(MediaTestResult {
            ok: true,
            error: None,
        });
    }
    let body = read_capped_response_text(
        &resp,
        &CappedReadOptions {
            max_bytes: Some(MAX_ERROR_BODY_BYTES),
            on_bytes: None,
            truncate: true,
        },
    )
    .await?;
    let detail = http_body_detail(&body)?;
    let status = number_to_string(resp.status());
    let error = if resp.status() == 429.0 {
        format!(
            "HTTP 429: rate limit exceeded, retry later{}",
            parenthesized(&detail)
        )
    } else if resp.status() >= 500.0 {
        format!(
            "HTTP {status}: server error, retry later{}",
            parenthesized(&detail)
        )
    } else {
        format!("HTTP {status}: {detail}")
    };
    Ok(MediaTestResult {
        ok: false,
        error: Some(error),
    })
}

/// `detail ? ` (${detail})` : ''`
fn parenthesized(detail: &str) -> String {
    if detail.is_empty() {
        String::new()
    } else {
        format!(" ({detail})")
    }
}
