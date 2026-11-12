//! `apps/docs/src/main/lazy-media-inline.ts`: exported HTML leaves the app,
//! so every lazily served picture it references travels as bytes.

use std::collections::HashMap;

use jscompat::{base64, js_regex};

/// The scheme of lazily served pictures: `LAZY_MEDIA_SCHEME` of
/// `packages/docx-engine/src/lazy-media.ts`, a constant copied here.
pub const LAZY_MEDIA_SCHEME: &str = "seuoffice-docx-media";

/// What the source serves for one URL: `{ body, mime }`.
#[derive(Debug, Clone, PartialEq)]
pub struct LazyMedia {
    pub body: Vec<u8>,
    pub mime: String,
}

/// `inlineLazyMediaInHtml(html, read)`: distinct URLs are read once, in order
/// of first appearance; one the source cannot serve (`None`) keeps its
/// reference. A `read` that throws answers `Err` with the message.
pub fn inline_lazy_media_in_html(
    html: &str,
    read: &mut dyn FnMut(&str) -> Result<Option<LazyMedia>, String>,
) -> Result<String, String> {
    // part names may carry apostrophes (encodeURIComponent keeps them): the
    // URL runs to the closing double quote, whitespace or a tag bracket.
    // `new RegExp(`${LAZY_MEDIA_SCHEME}://[^"\\s<>]+`, 'g')`
    let re = js_regex!(r#"seuoffice-docx-media://[^"\s<>]+"#, "g");
    let mut urls: Vec<&str> = Vec::new();
    for found in re.find_iter(html) {
        if !urls.contains(&found.as_str()) {
            urls.push(found.as_str());
        }
    }
    if urls.is_empty() {
        return Ok(html.to_owned());
    }
    let mut data_urls: HashMap<&str, String> = HashMap::new();
    for url in urls {
        if let Some(media) = read(url)? {
            data_urls.insert(
                url,
                format!("data:{};base64,{}", media.mime, base64(&media.body)),
            );
        }
    }
    Ok(re.replace_all(html, |found| {
        data_urls
            .get(found.as_str())
            .cloned()
            .unwrap_or_else(|| found.as_str().to_owned())
    }))
}
