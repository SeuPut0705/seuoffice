//! `link-preview.ts`: the picture and the title a web page names for itself,
//! read once when the person asks for it in the link dialog. The network
//! (the SSRF gate, redirects, the head of the page, the picture download) is
//! the [`LinkNet`](super::hosts::LinkNet) host; what is read from the page is here.

use jscompat::{js_regex, trim};
use url::Url;

use shell_contract::IpcValue;

use super::app::MindmapApp;
use super::hosts::LinkNet;
use super::util::{slice, utf16_len};
use crate::route::{self, Route};
use crate::value::{obj, string};

/// The longest title taken from a page
const TITLE_MAX: usize = 200;

/// The tags that name a page's picture, the first found wins
const PICTURE_KEYS: [&str; 5] = [
    "og:image:secure_url",
    "og:image",
    "og:image:url",
    "twitter:image",
    "twitter:image:src",
];
/// The tags that name a page's title, before its `<title>`
const TITLE_KEYS: [&str; 2] = ["og:title", "twitter:title"];

/// `PagePreview`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PagePreview {
    /// an http(s) address, already made absolute
    pub picture_url: Option<String>,
    pub title: Option<String>,
}

fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        _ => return None,
    })
}

/// `decodeEntities`: the text of an attribute or a title, with the character
/// references a page writes in it
pub fn decode_entities(text: &str) -> String {
    js_regex!(r"&(#x[0-9a-f]+|#[0-9]+|[a-z]+);", "i").replace_all(text, |found| {
        let whole = found.as_str().to_owned();
        let reference = found.get(1).unwrap_or("");
        if let Some(number) = reference.strip_prefix('#') {
            let code = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok(),
                None => number.parse::<u32>().ok(),
            };
            return match code.filter(|c| *c > 0).and_then(char::from_u32) {
                Some(c) => c.to_string(),
                None => whole,
            };
        }
        named_entity(&reference.to_lowercase()).map_or(whole, str::to_owned)
    })
}

/// The attributes of one start tag, names in lower case; the first of a name wins
fn attributes_of(tag: &str) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = Vec::new();
    let pattern =
        js_regex!(r#"([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#);
    for attribute in pattern.find_iter(tag) {
        let name = attribute.get(1).unwrap_or("").to_lowercase();
        if !found.iter().any(|(n, _)| *n == name) {
            let value = attribute
                .get(2)
                .or(attribute.get(3))
                .or(attribute.get(4))
                .unwrap_or("");
            found.push((name, decode_entities(value)));
        }
    }
    found
}

fn attribute<'a>(attributes: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, value)| value.as_str())
}

fn one_line(text: &str) -> Option<String> {
    let flat = js_regex!(r"\s+").replace_all(text, |_| " ".to_owned());
    let flat = trim(&flat);
    if flat.is_empty() {
        return None;
    }
    Some(if utf16_len(flat) > TITLE_MAX {
        format!("{}…", slice(flat, 0, TITLE_MAX - 1))
    } else {
        flat.to_owned()
    })
}

/// `webAddress`: a web address for the picture, relative ones read against
/// the page; `None` for any other kind
fn web_address(value: &str, base: &str) -> Option<String> {
    let base = Url::parse(base).ok()?;
    let url = Url::options()
        .base_url(Some(&base))
        .parse(trim(value))
        .ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

/// `parsePagePreview`: what a page says about itself, read from its markup as
/// text: nothing in it runs and nothing it names is fetched here
pub fn parse_page_preview(html: &str, page_url: &str) -> PagePreview {
    let mut meta: Vec<(String, String)> = Vec::new();
    for tag in js_regex!(r"<meta\b[^>]*>", "i").find_iter(html) {
        let attributes = attributes_of(tag.as_str());
        let key = trim(
            attribute(&attributes, "property")
                .or(attribute(&attributes, "name"))
                .unwrap_or(""),
        )
        .to_lowercase();
        let content = attribute(&attributes, "content");
        if let Some(content) = content
            && !key.is_empty()
            && !trim(content).is_empty()
            && !meta.iter().any(|(k, _)| *k == key)
        {
            meta.push((key, content.to_owned()));
        }
    }
    let meta_of = |key: &str| meta.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    let mut picture_url = None;
    for key in PICTURE_KEYS {
        picture_url = meta_of(key).and_then(|value| web_address(value, page_url));
        if picture_url.is_some() {
            break;
        }
    }
    if picture_url.is_none() {
        for tag in js_regex!(r"<link\b[^>]*>", "i").find_iter(html) {
            let attributes = attributes_of(tag.as_str());
            let rel = attribute(&attributes, "rel").unwrap_or("").to_lowercase();
            let is_image_src = js_regex!(r"\s+").split(&rel).contains(&"image_src");
            if is_image_src
                && let Some(href) = attribute(&attributes, "href").filter(|h| !h.is_empty())
            {
                picture_url = web_address(href, page_url);
            }
            if picture_url.is_some() {
                break;
            }
        }
    }
    let mut title = None;
    for key in TITLE_KEYS {
        title = meta_of(key).and_then(one_line);
        if title.is_some() {
            break;
        }
    }
    if title.is_none()
        && let Some(tag) = js_regex!(r"<title\b[^>]*>([\s\S]*?)<\/title\s*>", "i").exec(html)
    {
        title = one_line(&decode_entities(tag.get(1).unwrap_or("")));
    }
    PagePreview { picture_url, title }
}

/// `pageCharset`: the character set a page declares in its header or in its first bytes
pub fn page_charset(content_type: &str, head: &[u8]) -> String {
    if let Some(found) = js_regex!(r#"charset\s*=\s*["']?([\w-]+)"#, "i").exec(content_type) {
        return found.get(1).unwrap_or("").to_lowercase();
    }
    let start: String = head.iter().take(4096).map(|b| char::from(*b)).collect();
    match js_regex!(r#"<meta\b[^>]*charset\s*=\s*["']?([\w-]+)"#, "i").exec(&start) {
        Some(found) => found.get(1).unwrap_or("").to_lowercase(),
        None => "utf-8".to_owned(),
    }
}

/// `decodePage`: `new TextDecoder(charset).decode(bytes)`, UTF-8 for a label the decoder does not know
fn decode_page(bytes: &[u8], content_type: &str) -> String {
    let label = page_charset(content_type, bytes);
    let encoding = encoding_rs::Encoding::for_label(label.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    encoding.decode(bytes).0.into_owned()
}

fn reason(reason: &str) -> IpcValue {
    obj([("ok", IpcValue::Bool(false)), ("reason", string(reason))])
}

/// How much of a page is read at most: the tags sit in its head, far before this
pub const PAGE_READ_LIMIT: usize = 512 * 1024;

/// `readHead`: the start of a body: up to the end of the page's head, or
/// `limit` bytes. The rest is never downloaded.
fn read_head(mut body: impl Iterator<Item = Vec<u8>>, limit: usize) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut tail = String::new();
    while out.len() < limit {
        let Some(chunk) = body.next() else {
            break;
        };
        // the end of the head can straddle two chunks: keep a little of the last one
        let seen: String = tail
            .chars()
            .chain(chunk.iter().map(|b| char::from(*b)))
            .collect();
        out.extend_from_slice(&chunk);
        if js_regex!(r"<\/head\s*>", "i").test(&seen) {
            break;
        }
        let keep = seen.chars().count().saturating_sub(16);
        tail = seen.chars().skip(keep).collect();
    }
    out.truncate(limit);
    out
}

/// `readLinkPreview`: reads the page at `url` and downloads the picture it
/// names. Blocks on the network: run it on a worker.
pub fn read_link_preview(net: &dyn LinkNet, url: Option<&str>) -> IpcValue {
    let raw = url.map_or("", trim);
    // only a web address written out in full
    let address = if js_regex!(r"^https?://", "i").test(raw) {
        web_address(raw, raw)
    } else {
        None
    };
    let Some(address) = address else {
        return reason("not-web");
    };
    let Ok(Some(resp)) = net.fetch_with_ssrf_guard(&address) else {
        return reason("unreachable");
    };
    if !resp.ok {
        return reason("unreachable");
    }
    if !js_regex!(r"html", "i").test(&resp.content_type) {
        return reason("not-page");
    }
    let content_type = resp.content_type;
    let final_url = resp.url;
    let head = read_head(resp.body, PAGE_READ_LIMIT);
    let html = decode_page(&head, &content_type);
    // a redirect moved the page: its own addresses are relative to where it ended
    let base = if js_regex!(r"^https?:", "i").test(&final_url) {
        final_url
    } else {
        address
    };
    let preview = parse_page_preview(&html, &base);
    let picture = preview
        .picture_url
        .as_deref()
        .and_then(|picture_url| net.fetch_image_bytes(Some(picture_url)));
    obj([
        ("ok", IpcValue::Bool(true)),
        ("title", preview.title.map_or(IpcValue::Null, string)),
        (
            "picture",
            match picture {
                Some(picture) => obj([
                    ("base64", string(picture.base64)),
                    ("mime", string(picture.mime)),
                ]),
                None => IpcValue::Null,
            },
        ),
    ])
}

pub(super) fn routes(app: &MindmapApp) -> Vec<Route> {
    let a = app.clone();
    vec![route::invoke_later(
        "mindmap:read-link-preview",
        move |_cx, args, responder| {
            let net = a.0.net.clone();
            let url = args.str(0).map(str::to_owned);
            a.offload(
                move || read_link_preview(&*net, url.as_deref()),
                move |_app, answer| responder.reply(Ok(answer)),
            );
        },
    )]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_names_its_picture_and_title() {
        let html = r#"<html><head><title> Fallback &amp; title </title>
            <meta property="og:title" content="Real &quot;title&quot;">
            <meta property="og:image" content="/img/a.png"></head></html>"#;
        let preview = parse_page_preview(html, "https://example.com/dir/page");
        assert_eq!(preview.title.as_deref(), Some("Real \"title\""));
        assert_eq!(
            preview.picture_url.as_deref(),
            Some("https://example.com/img/a.png")
        );
        let plain = parse_page_preview("<title>Only &amp; this</title>", "https://example.com/");
        assert_eq!(plain.title.as_deref(), Some("Only & this"));
        assert_eq!(plain.picture_url, None);
    }

    #[test]
    fn the_declared_charset_decodes_the_page() {
        assert_eq!(page_charset("text/html; charset=EUC-KR", b""), "euc-kr");
        assert_eq!(
            page_charset("text/html", b"<meta charset=\"utf-8\">"),
            "utf-8"
        );
        assert_eq!(
            decode_page(&[0xb0, 0xa1], "text/html; charset=euc-kr"),
            "가"
        );
    }
}
