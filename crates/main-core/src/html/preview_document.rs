//! `apps/html/src/main/preview-document.ts`.
//!
//! The preview copy of the document: the buffer text with a `<base>` pointing
//! at the document's directory (so relative assets resolve through
//! `html-asset://`) unless the author already declared one. The saved file
//! never contains it. Offsets are UTF-8 bytes: every scan stops on an ASCII
//! character, so each one is a character boundary.

use jscompat::{encode_uri_component, index_of, js_regex, number_to_string};

pub const PREVIEW_SCHEME: &str = "html-preview";
pub const ASSET_SCHEME: &str = "html-asset";

/// `assetBaseHref(documentDir)`: an absolute directory as an html-asset base
/// URL with a trailing slash. The scheme is registered as standard, so it
/// needs a host; `local` is a fixed placeholder.
pub fn asset_base_href(document_dir: &str) -> String {
    let normalized = document_dir.replace('\\', "/");
    let normalized = js_regex!(r"/+$").replace_all(&normalized, |_| String::new());
    let path = if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    };
    let encoded = path
        .split('/')
        .map(|segment| {
            js_regex!(r"%3A", "i").replace_all(&encode_uri_component(segment), |_| ":".to_owned())
        })
        .collect::<Vec<_>>()
        .join("/");
    format!("{ASSET_SCHEME}://local{encoded}/")
}

/// `TagRange`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TagRange {
    start: usize,
    end: usize,
}

/// `tagEnd(text, start)`: where the tag that opens at `start` ends (after its
/// `>`), quotes honoured; `None` for a tag that never ends.
fn tag_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut quote: Option<u8> = None;
    for (index, &character) in bytes.iter().enumerate().skip(start + 1) {
        if let Some(open) = quote {
            if character == open {
                quote = None;
            }
            continue;
        }
        if character == b'"' || character == b'\'' {
            quote = Some(character);
            continue;
        }
        if character == b'>' {
            return Some(index + 1);
        }
    }
    None
}

const RAW_TEXT_TAGS: [&str; 4] = ["script", "style", "textarea", "title"];

/// `skipRawText(text, index, tagName)`: past the closing tag of a raw-text
/// element, or the end of the text
fn skip_raw_text(text: &str, index: usize, tag_name: &str) -> usize {
    let closing = match tag_name {
        "script" => js_regex!(r"</script\s*>", "i"),
        "style" => js_regex!(r"</style\s*>", "i"),
        "textarea" => js_regex!(r"</textarea\s*>", "i"),
        _ => js_regex!(r"</title\s*>", "i"),
    };
    match closing.exec(&text[index..]) {
        Some(found) => index + found.start() + found.as_str().len(),
        None => text.len(),
    }
}

/// `skipTemplate(text, index)`: past the `</template>` that closes the
/// template whose opening tag ended at `index`
fn skip_template(text: &str, mut index: usize) -> usize {
    let mut depth: i64 = 1;
    while index < text.len() {
        let Some(start) = index_of(text, "<", index) else {
            return text.len();
        };
        if text[start..].starts_with("<!--") {
            index = match index_of(text, "-->", start + 4) {
                None => text.len(),
                Some(end) => end + 3,
            };
            continue;
        }
        if text[start..].starts_with("<!") || text[start..].starts_with("<?") {
            index = tag_end(text, start).unwrap_or(text.len());
            continue;
        }
        let Some(found) = js_regex!(r"^<(/?)([A-Za-z][A-Za-z0-9:-]*)").exec(&text[start..]) else {
            index = start + 1;
            continue;
        };
        let Some(end) = tag_end(text, start) else {
            return text.len();
        };
        let closing = found.get(1) == Some("/");
        let tag_name = found.get(2).unwrap_or("").to_lowercase();
        if tag_name == "template" {
            if closing {
                depth -= 1;
                if depth == 0 {
                    return end;
                }
            } else {
                depth += 1;
            }
        }
        index = end;
        if !closing && RAW_TEXT_TAGS.contains(&tag_name.as_str()) {
            index = skip_raw_text(text, index, &tag_name);
        }
    }
    text.len()
}

/// `openingTag(text, name)`: the first opening tag of that name outside
/// comments, raw-text elements and templates
fn opening_tag(text: &str, name: &str) -> Option<TagRange> {
    let mut index = 0;
    while index < text.len() {
        let start = index_of(text, "<", index)?;
        if text[start..].starts_with("<!--") {
            index = match index_of(text, "-->", start + 4) {
                None => text.len(),
                Some(end) => end + 3,
            };
            continue;
        }
        if text[start..].starts_with("<!") || text[start..].starts_with("<?") {
            index = tag_end(text, start).unwrap_or(text.len());
            continue;
        }
        let Some(found) = js_regex!(r"^<([A-Za-z][A-Za-z0-9:-]*)").exec(&text[start..]) else {
            index = start + 1;
            continue;
        };
        let end = tag_end(text, start)?;
        let tag_name = found.get(1).unwrap_or("").to_lowercase();
        if tag_name == name.to_lowercase() {
            return Some(TagRange { start, end });
        }
        if tag_name == "template" {
            index = skip_template(text, end);
            continue;
        }
        index = end;
        if RAW_TEXT_TAGS.contains(&tag_name.as_str()) {
            index = skip_raw_text(text, index, &tag_name);
        }
    }
    None
}

/// `buildPreviewDocument(text, baseHref)`: the buffer text with a `<base>`
/// after `<head>` (or `<html>`, or in front of everything), unless the author
/// declared one. `None` and an empty `baseHref` leave the text as it is.
pub fn build_preview_document(text: &str, base_href: Option<&str>) -> String {
    let Some(base_href) = base_href.filter(|href| !href.is_empty()) else {
        return text.to_owned();
    };
    if opening_tag(text, "base").is_some() {
        return text.to_owned();
    }
    let tag = format!("<base href=\"{}\">", base_href.replace('"', "%22"));
    if let Some(head) = opening_tag(text, "head") {
        return format!("{}{tag}{}", &text[..head.end], &text[head.end..]);
    }
    if let Some(html) = opening_tag(text, "html") {
        return format!("{}{tag}{}", &text[..html.end], &text[html.end..]);
    }
    format!("{tag}{text}")
}

/// `previewUrlFor(webContentsId)`
pub fn preview_url_for(web_contents_id: f64) -> String {
    format!(
        "{PREVIEW_SCHEME}://view-{}/",
        number_to_string(web_contents_id)
    )
}
