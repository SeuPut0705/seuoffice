//! `packages/electron-utils/src/fetch-image-bytes.ts`.

use jscompat::base64;
use serde::Serialize;

use super::remote_image::{MAX_REMOTE_IMAGE_BYTES, fetch_remote_image, read_body_capped};
use super::safe_remote_url::{Fetcher, Resolver};

/// The formats the editors' insert paths accept; anything else is downloaded as JPEG.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub enum FetchedImageMime {
    #[serde(rename = "image/png")]
    Png,
    #[serde(rename = "image/jpeg")]
    Jpeg,
    #[serde(rename = "image/gif")]
    Gif,
}

/// `FetchedImageBytes`; the fields in the order the TypeScript writes them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FetchedImageBytes {
    pub base64: String,
    pub mime: FetchedImageMime,
}

/// `fetchImageBytes(url)`; `url` is `None` where the TypeScript is given
/// something that is not a string. `tmpdir` is `os.tmpdir()`.
pub fn fetch_image_bytes(
    resolver: &mut dyn Resolver,
    fetcher: &mut dyn Fetcher,
    tmpdir: &str,
    url: Option<&str>,
) -> Option<FetchedImageBytes> {
    let url = url.filter(|url| !url.is_empty())?;
    let mut resp = fetch_remote_image(resolver, fetcher, tmpdir, url, None)?;
    if !resp.ok() {
        return None;
    }
    let ct = resp.header("content-type").unwrap_or_default();
    // remoteImageHeaders advertises only png/jpeg/gif, so anything else is a
    // mislabelled JPEG: the same rule the document editors' insert paths use
    let mime = if ct.contains("png") {
        FetchedImageMime::Png
    } else if ct.contains("gif") {
        FetchedImageMime::Gif
    } else {
        FetchedImageMime::Jpeg
    };
    let bytes = read_body_capped(resp.as_mut(), MAX_REMOTE_IMAGE_BYTES as f64).ok()?;
    Some(FetchedImageBytes {
        base64: base64(&bytes),
        mime,
    })
}
