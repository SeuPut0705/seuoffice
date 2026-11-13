//! `packages/electron-utils/src/save-image.ts`: "Save Image As…" for any
//! image the renderer displays. Data URLs are decoded in place; everything
//! else (http(s), the app's asset schemes) goes through `net.fetch`, so the
//! custom protocol handlers keep enforcing their own access rules.
//!
//! `net.fetch` is the caller's ([`NetFetch`]), and so are the save dialog
//! ([`Dialog`]) and the memory of its last folder ([`DialogMemory`]).

use std::fs;

use jscompat::{
    JsObject, JsonValue, buffer_from_base64, decode_uri_component, inherited_string, js_regex,
    trim, try_js_regex,
};
use url::Url;

use super::dialog_memory::{Dialog, DialogMemory, FallbackDir, show_save_dialog_with_memory};
use super::remote_image::{MAX_REMOTE_IMAGE_BYTES, read_body_capped};
use super::safe_remote_url::Response;
use crate::node_fs::{namespaced, node_error};

/// `EXT_BY_MIME[key] ?? 'png'`; the table is a plain object, so a key that
/// names a member of `Object.prototype` finds that
fn ext_by_mime(key: &str) -> &'static str {
    match key {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        "image/tiff" => "tif",
        key => inherited_string(key).unwrap_or("png"),
    }
}

/// `SaveImageResult`
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SaveImageResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `isSavableImageUrl(url)`: file:// would let a page read arbitrary local
/// files; blob: lives in the renderer only.
pub fn is_savable_image_url(url: &str) -> bool {
    js_regex!(r"^[a-z][a-z0-9+.-]*:", "i").test(url)
        && !js_regex!(r"^(file|blob|javascript|about):", "i").test(url)
}

/// `urlFileName(url)`: the last segment of the decoded path, `""` when the
/// URL or its escapes do not parse
fn url_file_name(url: &str) -> String {
    let Ok(parsed) = Url::parse(url) else {
        return String::new();
    };
    match decode_uri_component(parsed.path()) {
        Ok(path) => path.rsplit('/').next().unwrap_or("").to_owned(),
        Err(_) => String::new(),
    }
}

/// `suggestImageFileName(url, mime)`: the URL's own file name when it carries
/// an image extension, else `image.<ext of the MIME type>`.
pub fn suggest_image_file_name(url: &str, mime: Option<&str>) -> String {
    let name = url_file_name(url);
    if !name.is_empty() && js_regex!(r"\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?)$", "i").test(&name)
    {
        return name;
    }
    let mime = mime.unwrap_or("");
    let key = trim(mime.split(';').next().unwrap_or("")).to_lowercase();
    format!("image.{}", ext_by_mime(&key))
}

/// `Math.ceil((MAX_REMOTE_IMAGE_BYTES * 4) / 3)`: the byte budget of a remote
/// image, checked on the encoded text before allocating
const MAX_DATA_URL_PAYLOAD_CHARS: u64 = (MAX_REMOTE_IMAGE_BYTES * 4).div_ceil(3);

/// what `decodeDataUrl` answers
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedImage {
    pub bytes: Vec<u8>,
    pub mime: Option<String>,
}

/// `decodeDataUrl(url)`: `None` for a malformed or oversized data URL. A
/// search past the backtrack bound (more than a million parameters) is
/// malformed too.
pub fn decode_data_url(url: &str) -> Option<DecodedImage> {
    // The parameter run is `;`-prefixed and its body excludes `;`, so each
    // iteration has exactly one possible length (see the TypeScript).
    let m = try_js_regex!(r"^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$", "i")
        .try_exec(url)
        .ok()??;
    let mime = m.get(1).filter(|mime| !mime.is_empty()).map(str::to_owned);
    let payload = m.get(3).unwrap_or("");
    if payload.encode_utf16().count() as u64 > MAX_DATA_URL_PAYLOAD_CHARS {
        return None;
    }
    let is_base64 = m
        .get(2)
        .unwrap_or("")
        .split(';')
        .any(|param| param.to_lowercase() == "base64");
    let bytes = if is_base64 {
        buffer_from_base64(payload)
    } else {
        // a stray `%` in a non-base64 payload makes decodeURIComponent throw:
        // the URL is malformed
        decode_uri_component(payload).ok()?.into_bytes()
    };
    if bytes.len() as u64 > MAX_REMOTE_IMAGE_BYTES {
        return None;
    }
    Some(DecodedImage { bytes, mime })
}

/// `net.fetch(url)`; an `Err` is the rejection, as `String(err)` writes it
/// (`TypeError: fetch failed`)
pub type NetFetch<'a> = &'a mut dyn FnMut(&str) -> Result<Box<dyn Response>, String>;

/// `fetchImageBytes(url)`; an `Err` is what it throws, as `String(err)`
/// writes it
fn fetch_image_bytes(url: &str, fetch: NetFetch<'_>) -> Result<DecodedImage, String> {
    if js_regex!(r"^data:", "i").test(url) {
        return decode_data_url(url).ok_or_else(|| "Error: malformed or oversized data URL".into());
    }
    let mut res = fetch(url)?;
    if !res.ok() {
        return Err(format!("Error: fetch failed: HTTP {}", res.status()));
    }
    let bytes = read_body_capped(res.as_mut(), MAX_REMOTE_IMAGE_BYTES as f64)
        .map_err(|e| format!("Error: {}", e.message()))?;
    Ok(DecodedImage {
        bytes,
        mime: res.header("content-type"),
    })
}

/// `opts` of `saveImageFromUrl`
pub struct SaveImageOptions<'a> {
    pub title: &'a str,
    pub fallback_dir: Option<&'a str>,
}

/// `saveImageFromUrl(parent, url, opts)`
pub fn save_image_from_url<D: Dialog>(
    memory: &mut DialogMemory,
    dialog: &mut D,
    fetch: NetFetch<'_>,
    parent: Option<&D::Window>,
    url: &str,
    opts: &SaveImageOptions<'_>,
) -> SaveImageResult {
    let failed = |error: String| SaveImageResult {
        ok: false,
        path: None,
        error: Some(error),
    };
    if !is_savable_image_url(url) {
        return failed("unsupported image url".into());
    }
    let DecodedImage { bytes, mime } = match fetch_image_bytes(url, fetch) {
        Ok(image) => image,
        Err(error) => return failed(error),
    };
    let name = suggest_image_file_name(url, mime.as_deref());
    let ext = &name[name.rfind('.').map_or(0, |dot| dot + 1)..];
    let mut filter = JsObject::new();
    filter.set("name", JsonValue::String(ext.to_uppercase()));
    filter.set(
        "extensions",
        JsonValue::Array(vec![JsonValue::String(ext.to_owned())]),
    );
    let mut options = JsObject::new();
    options.set("title", JsonValue::String(opts.title.to_owned()));
    options.set("defaultPath", JsonValue::String(name.clone()));
    options.set("filters", JsonValue::Array(vec![JsonValue::Object(filter)]));
    let fallback = opts.fallback_dir.map(FallbackDir::Dir);
    let picked = show_save_dialog_with_memory(memory, dialog, parent, &options, fallback.as_ref());
    let field = |key: &str| match &picked {
        JsonValue::Object(object) => object.get(key),
        _ => None,
    };
    let canceled = field("canceled").is_some_and(JsonValue::truthy);
    let file_path = match field("filePath") {
        Some(JsonValue::String(path)) => path.clone(),
        _ => String::new(),
    };
    if canceled || file_path.is_empty() {
        return SaveImageResult {
            ok: false,
            path: None,
            error: None,
        };
    }
    if let Err(e) = fs::write(namespaced(&file_path), &bytes) {
        return failed(format!(
            "Error: {}",
            node_error(&e, "open", &file_path).message
        ));
    }
    SaveImageResult {
        ok: true,
        path: Some(file_path),
        error: None,
    }
}
