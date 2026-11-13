//! `apps/slides/src/main/element-clipboard.ts`: which clipboard content still
//! belongs to the element copy a renderer made, and the PNG written beside it.
//!
//! Electron's `clipboard` and `nativeImage` stay with the caller, behind
//! [`ClipboardHost`]: only the calls the TypeScript makes. A call that throws
//! is an `Err(HostThrew)`; the TypeScript catches every one of them.

use jscompat::{JsonValue, base64, buffer_from_base64, encode_uri_component, js_regex};

/// `ELEMENT_CLIPBOARD_FORMAT`
pub const ELEMENT_CLIPBOARD_FORMAT: &str = "io.seuoffice.slides.elements";

/// `ElementClipboardIdentity`: the token of the last copy and the renderer
/// (`senderId`, a `webContents.id`) that made it.
#[derive(Debug, Clone, PartialEq)]
pub struct ElementClipboardIdentity {
    pub token: String,
    pub sender_id: f64,
}

const MAX_TOKEN_LENGTH: usize = 256;
const MAX_PNG_BASE64_LENGTH: usize = 40 * 1024 * 1024;

/// A call of the clipboard or of `nativeImage` that threw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostThrew;

/// The Electron objects the module calls. `Image` is a `NativeImage`.
pub trait ClipboardHost {
    type Image;

    /// `clipboard.readBuffer(format)`
    fn read_buffer(&self, format: &str) -> Result<Vec<u8>, HostThrew>;
    /// `clipboard.readHTML()`
    fn read_html(&self) -> Result<String, HostThrew>;
    /// `nativeImage.createFromBuffer(bytes)`
    fn create_image_from_buffer(&self, bytes: &[u8]) -> Result<Self::Image, HostThrew>;
    /// `image.isEmpty()`
    fn image_is_empty(&self, image: &Self::Image) -> Result<bool, HostThrew>;
    /// `image.toPNG()`
    fn image_to_png(&self, image: &Self::Image) -> Result<Vec<u8>, HostThrew>;
    /// `clipboard.write({ image, html })`
    fn write_image_and_html(&mut self, image: &Self::Image, html: &str) -> Result<(), HostThrew>;
}

fn is_token_text(token: &str) -> bool {
    // `value.length` counts UTF-16 code units
    let length = token.encode_utf16().count();
    length > 0 && length <= MAX_TOKEN_LENGTH
}

/// `isElementClipboardToken(value)`
pub fn is_element_clipboard_token(value: Option<&JsonValue>) -> bool {
    matches!(value, Some(JsonValue::String(token)) if is_token_text(token))
}

fn marker_buffer_matches<H: ClipboardHost>(host: &H, token: &str) -> bool {
    match host.read_buffer(ELEMENT_CLIPBOARD_FORMAT) {
        Ok(bytes) => bytes == token.as_bytes(),
        Err(HostThrew) => false,
    }
}

fn marker_html_matches<H: ClipboardHost>(host: &H, token: &str) -> bool {
    let encoded_token = encode_uri_component(token);
    let Ok(html) = host.read_html() else {
        return false;
    };
    let images = js_regex!(
        r#"<img\b[^>]*\bdata-seuoffice-slides-elements\s*=\s*"([^"]*)"[^>]*>"#,
        "gi"
    );
    images
        .find_iter(&html)
        .any(|found| found.get(1) == Some(encoded_token.as_str()))
}

/// `elementClipboardMarkerMatches(token)`: whether the OS clipboard still
/// belongs to the supplied element-copy token.
pub fn element_clipboard_marker_matches<H: ClipboardHost>(host: &H, token: &str) -> bool {
    is_token_text(token) && (marker_buffer_matches(host, token) || marker_html_matches(host, token))
}

/// `canWriteElementClipboardImage(current, senderId, token)`
pub fn can_write_element_clipboard_image<H: ClipboardHost>(
    host: &H,
    current: Option<&ElementClipboardIdentity>,
    sender_id: f64,
    token: Option<&JsonValue>,
) -> bool {
    let Some(JsonValue::String(token)) = token else {
        return false;
    };
    is_token_text(token)
        && current.is_some_and(|current| current.sender_id == sender_id)
        && current.is_some_and(|current| &current.token == token)
        && element_clipboard_marker_matches(host, token)
}

fn decode_png_base64(png_base64: Option<&JsonValue>) -> Option<Vec<u8>> {
    let Some(JsonValue::String(text)) = png_base64 else {
        return None;
    };
    let length = text.encode_utf16().count();
    if length == 0
        || length > MAX_PNG_BASE64_LENGTH
        || length % 4 != 0
        || !js_regex!(r"^[A-Za-z0-9+/]*={0,2}$").test(text)
    {
        return None;
    }
    let bytes = buffer_from_base64(text);
    if bytes.is_empty() { None } else { Some(bytes) }
}

/// `writeElementClipboardImage(token, pngBase64)`: writes a standard image
/// and an HTML marker together so external apps can paste the image.
pub fn write_element_clipboard_image<H: ClipboardHost>(
    host: &mut H,
    token: &str,
    png_base64: Option<&JsonValue>,
) -> bool {
    if !is_token_text(token) {
        return false;
    }
    let Some(bytes) = decode_png_base64(png_base64) else {
        return false;
    };
    // the try block of the TypeScript: any call that throws is `false`
    let written = (|| -> Result<bool, HostThrew> {
        let decoded = host.create_image_from_buffer(&bytes)?;
        if host.image_is_empty(&decoded)? {
            return Ok(false);
        }
        let normalized_png = host.image_to_png(&decoded)?;
        if normalized_png.is_empty() {
            return Ok(false);
        }
        let html = format!(
            "<img src=\"data:image/png;base64,{}\" data-seuoffice-slides-elements=\"{}\">",
            base64(&normalized_png),
            encode_uri_component(token)
        );
        if !element_clipboard_marker_matches(&*host, token) {
            return Ok(false);
        }
        host.write_image_and_html(&decoded, &html)?;
        Ok(true)
    })();
    written.unwrap_or(false)
}
