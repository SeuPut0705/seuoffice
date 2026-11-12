//! `apps/diagram/src/main/drawio-protocol.ts`: the `drawio-app://` scheme,
//! draw.io's files for the diagram tab.
//!
//! The constants of `apps/diagram/src/shared/bridge-protocol.ts` that it
//! imports (`DRAWIO_SCHEME`, `DRAWIO_HOST`, `BRIDGE_PREFIX`,
//! `BRIDGE_SCRIPT_PATH`) are copied here.
//!
//! `MIME_BY_EXT` answers for its own keys: the TypeScript's plain object also
//! answers for a name every object has (`x.constructor` gives the `Object`
//! function), which no draw.io file carries.

use jscompat::node_path::host;
use jscompat::{decode_uri_component, js_regex};
use url::Url;

use crate::packages::electron_utils::renderer_scheme::{CustomScheme, SchemePrivileges};

pub const DRAWIO_SCHEME: &str = "drawio-app";
pub const DRAWIO_HOST: &str = "editor";
pub const BRIDGE_PREFIX: &str = "/__ieum/";
pub const BRIDGE_SCRIPT_PATH: &str = "/__ieum/bridge.js";

/// Standard and secure, so draw.io gets a real origin with its own storage,
/// and may fetch its own files.
pub fn drawio_scheme_privilege() -> CustomScheme {
    CustomScheme {
        scheme: DRAWIO_SCHEME,
        privileges: SchemePrivileges {
            standard: true,
            secure: true,
            support_fetch_api: true,
            cors_enabled: true,
            stream: true,
            code_cache: None,
        },
    }
}

/// The policy on draw.io's pages. Scripts only from our scheme; no frame,
/// worker, form or connection anywhere else.
pub fn drawio_csp(frame_ancestors: &[&str]) -> String {
    let own = format!("{DRAWIO_SCHEME}:");
    let ancestors = if frame_ancestors.is_empty() {
        "'none'".to_owned()
    } else {
        frame_ancestors.join(" ")
    };
    [
        "default-src 'none'".to_owned(),
        format!("script-src {own}"),
        format!("style-src {own} 'unsafe-inline'"),
        format!("img-src {own} data: blob:"),
        format!("font-src {own} data:"),
        format!("connect-src {own} data: blob:"),
        format!("media-src {own} data: blob:"),
        format!("worker-src {own} blob:"),
        format!("frame-src {own} blob: data:"),
        format!("child-src {own} blob: data:"),
        "object-src 'none'".to_owned(),
        "form-action 'none'".to_owned(),
        "base-uri 'none'".to_owned(),
        format!("frame-ancestors {ancestors}"),
    ]
    .join("; ")
}

/// The policy on a page the app prints: pictures and styles only, no script
/// at all (`PRINT_PAGE_CSP`).
pub fn print_page_csp() -> String {
    [
        "default-src 'none'".to_owned(),
        format!("img-src {DRAWIO_SCHEME}: data: blob:"),
        "style-src 'unsafe-inline'".to_owned(),
        format!("font-src {DRAWIO_SCHEME}: data:"),
        "script-src 'none'".to_owned(),
        "connect-src 'none'".to_owned(),
        "object-src 'none'".to_owned(),
        "base-uri 'none'".to_owned(),
        "form-action 'none'".to_owned(),
    ]
    .join("; ")
}

/// `MIME_BY_EXT`
fn mime_by_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "gif" => "image/gif",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        "wasm" => "application/wasm",
        _ => return None,
    })
}

pub fn content_type_of(path: &str) -> &'static str {
    let name = path.rfind('/').map_or(path, |at| &path[at + 1..]);
    let ext = match name.rfind('.') {
        Some(dot) => name[dot + 1..].to_lowercase(),
        None => String::new(),
    };
    mime_by_ext(&ext).unwrap_or("application/octet-stream")
}

/// `DrawioTarget`
#[derive(Debug, Clone, PartialEq)]
pub enum DrawioTarget {
    File { path: String, relative: String },
    Bridge,
    Print { token: String },
    Refused { status: u16 },
}

/// What an address names: a file under `root`, the bridge, a print page, or
/// nothing servable. Refuses other hosts, encoded separators and NUL, `..`
/// that leaves the folder, and the folder itself.
pub fn resolve_drawio_request(root: &str, request_url: &str) -> DrawioTarget {
    let refused = |status| DrawioTarget::Refused { status };
    let Ok(url) = Url::parse(request_url) else {
        return refused(400);
    };
    if url.scheme() != DRAWIO_SCHEME || url.host_str().unwrap_or("") != DRAWIO_HOST {
        return refused(404);
    }
    let raw = url.path();
    // encoded separators and NUL never name a draw.io file
    if js_regex!(r"%2f|%5c|%00", "i").test(raw) {
        return refused(400);
    }
    let Ok(pathname) = decode_uri_component(raw) else {
        return refused(400);
    };
    if pathname.encode_utf16().count() > 4096 || pathname.contains('\0') || pathname.contains('\\')
    {
        return refused(400);
    }
    if pathname == BRIDGE_SCRIPT_PATH {
        return DrawioTarget::Bridge;
    }
    if let Some(token) = pathname.strip_prefix(&format!("{BRIDGE_PREFIX}print/")) {
        return if js_regex!(r"^[0-9a-f]{32}$").test(token) {
            DrawioTarget::Print {
                token: token.to_owned(),
            }
        } else {
            refused(404)
        };
    }
    if pathname.starts_with(BRIDGE_PREFIX) {
        return refused(404);
    }
    let relative = js_regex!(r"^\/+").replace_all(&pathname, |_| String::new());
    if relative.is_empty() {
        return refused(404);
    }
    let base = host::resolve(&[root]);
    let file = host::resolve(&[&base, &relative]);
    if file == base || !file.starts_with(&format!("{base}{}", host::SEP)) {
        return refused(403);
    }
    DrawioTarget::File {
        path: file,
        relative: relative.split(host::SEP).collect::<Vec<_>>().join("/"),
    }
}

/// draw.io's start page with our bridge loaded before anything of draw.io's.
/// `Err` is the message of the error thrown.
pub fn inject_bridge(index_html: &str) -> Result<String, String> {
    let tag = format!("<script src=\"{BRIDGE_SCRIPT_PATH}\"></script>");
    let Some(head) = js_regex!(r"<head(\s[^>]*)?>", "i").exec(index_html) else {
        return Err("draw.io index.html has no <head>".to_owned());
    };
    let at = head.end();
    Ok(format!("{}\n{tag}{}", &index_html[..at], &index_html[at..]))
}

/// `responseHeaders(contentType, csp)`: the headers in the order written.
pub fn response_headers(content_type: &str, csp: &str) -> [(&'static str, String); 4] {
    [
        ("Content-Type", content_type.to_owned()),
        ("Content-Security-Policy", csp.to_owned()),
        ("X-Content-Type-Options", "nosniff".to_owned()),
        ("Cache-Control", "no-cache".to_owned()),
    ]
}
