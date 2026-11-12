//! `apps/slides/src/main/media-mime.ts`.

fn starts_with(bytes: &[u8], sig: &[u8], offset: usize) -> bool {
    if bytes.len() < offset + sig.len() {
        return false;
    }
    &bytes[offset..offset + sig.len()] == sig
}

/// `sniffImageMime(bytes)`: `None` is `null`
pub fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if starts_with(bytes, &[0x89, 0x50, 0x4e, 0x47], 0) {
        return Some("image/png");
    }
    if starts_with(bytes, &[0xff, 0xd8, 0xff], 0) {
        return Some("image/jpeg");
    }
    if starts_with(bytes, &[0x47, 0x49, 0x46, 0x38], 0) {
        return Some("image/gif");
    }
    if starts_with(bytes, &[0x42, 0x4d], 0) {
        return Some("image/bmp");
    }
    if starts_with(bytes, &[0x52, 0x49, 0x46, 0x46], 0)
        && starts_with(bytes, &[0x57, 0x45, 0x42, 0x50], 8)
    {
        return Some("image/webp");
    }
    if starts_with(bytes, &[0x49, 0x49, 0x2a, 0x00], 0)
        || starts_with(bytes, &[0x4d, 0x4d, 0x00, 0x2a], 0)
    {
        return Some("image/tiff");
    }
    // EMF: record type 1 (EMR_HEADER) + " EMF" signature at offset 40
    if starts_with(bytes, &[0x01, 0x00, 0x00, 0x00], 0)
        && starts_with(bytes, &[0x20, 0x45, 0x4d, 0x46], 40)
    {
        return Some("image/x-emf");
    }
    // Placeable WMF
    if starts_with(bytes, &[0xd7, 0xcd, 0xc6, 0x9a], 0) {
        return Some("image/x-wmf");
    }
    None
}

/// `rasterImageExt(bytes)`: `None` is `null`
pub fn raster_image_ext(bytes: &[u8]) -> Option<&'static str> {
    match sniff_image_mime(bytes) {
        Some("image/png") => Some("png"),
        Some("image/jpeg") => Some("jpg"),
        Some("image/gif") => Some("gif"),
        _ => None,
    }
}

/// What `displayMime` answers. `EXT_MIME` is a plain object, so an extension
/// that names an own property of `Object.prototype` finds that, not a string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DisplayMime {
    Mime(&'static str),
    /// `EXT_MIME['constructor']`: the `Object` function (no JSON form)
    ObjectConstructor,
    /// `EXT_MIME['__proto__']`: `Object.prototype` (JSON `{}`)
    ObjectPrototype,
}

/// `displayMime(mediaRef, bytes)`
pub fn display_mime(media_ref: &str, bytes: &[u8]) -> DisplayMime {
    if let Some(sniffed) = sniff_image_mime(bytes) {
        return DisplayMime::Mime(sniffed);
    }
    // mediaRef.split('.').pop()?.toLowerCase() ?? ''
    let ext = media_ref
        .rsplit('.')
        .next()
        .map(str::to_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "png" => DisplayMime::Mime("image/png"),
        "jpg" | "jpeg" => DisplayMime::Mime("image/jpeg"),
        "gif" => DisplayMime::Mime("image/gif"),
        "bmp" => DisplayMime::Mime("image/bmp"),
        "webp" => DisplayMime::Mime("image/webp"),
        "svg" => DisplayMime::Mime("image/svg+xml"),
        "tif" | "tiff" => DisplayMime::Mime("image/tiff"),
        "emf" => DisplayMime::Mime("image/x-emf"),
        "wmf" => DisplayMime::Mime("image/x-wmf"),
        "constructor" => DisplayMime::ObjectConstructor,
        "__proto__" => DisplayMime::ObjectPrototype,
        _ => DisplayMime::Mime("image/png"),
    }
}
