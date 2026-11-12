//! `apps/docs/src/main/copy-image-guard.ts`: the guards of
//! `docs:copy-image-to-clipboard`.

use jscompat::{JsonValue, js_regex, json_parse, math_round};
use serde::Serialize;

/// The renderer re-encodes via canvas.toDataURL, so photos routinely exceed 15 MB.
pub const MAX_COPY_IMAGE_DATA_URL: usize = 64 * 1024 * 1024;

/// `dataUrl.length` in UTF-16 code units, compared with `max`: the code units
/// are never more than the bytes, so the count is made only for a long text.
fn longer_than(text: &str, max: usize) -> bool {
    text.len() > max && text.encode_utf16().count() > max
}

/// `validCopyImageDataUrl(dataUrl)`
pub fn valid_copy_image_data_url(data_url: Option<&JsonValue>) -> bool {
    let Some(JsonValue::String(data_url)) = data_url else {
        return false;
    };
    if longer_than(data_url, MAX_COPY_IMAGE_DATA_URL) {
        return false;
    }
    // Non-data URLs are lazy-media ids resolved server-side; data URLs must be
    // raster images (never data:text/html or svg scripts).
    if data_url.starts_with("data:")
        && !js_regex!(r"^data:image\/(png|jpe?g|gif|webp|bmp);", "i").test(data_url)
    {
        return false;
    }
    true
}

/// `{ width?, height? }`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DisplaySize {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

/// `typeof n === 'number' && Number.isFinite(n) && n > 0`, then
/// `Math.min(Math.round(n), 100000)`
fn clamped(parsed: &JsonValue, key: &str) -> Option<f64> {
    let value = parsed.get(key)?;
    match &*value {
        JsonValue::Number(x) if x.is_finite() && *x > 0.0 => Some(math_round(*x).min(100_000.0)),
        _ => None,
    }
}

/// `copyImageDisplaySize(meta)`: display-size overrides for the pasted
/// `<img>`: finite, clamped to 100000px. A value that is not JSON, or is
/// `null` (reading a key of it throws), gives `{}`.
pub fn copy_image_display_size(meta: Option<&JsonValue>) -> DisplaySize {
    let none = DisplaySize {
        width: None,
        height: None,
    };
    let Some(JsonValue::String(meta)) = meta else {
        return none;
    };
    if longer_than(meta, 2048) {
        return none;
    }
    let Ok(parsed) = json_parse(meta) else {
        return none;
    };
    if parsed == JsonValue::Null {
        return none;
    }
    DisplaySize {
        width: clamped(&parsed, "imageWidthPx"),
        height: clamped(&parsed, "imageHeightPx"),
    }
}
