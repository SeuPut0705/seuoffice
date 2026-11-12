//! `apps/diagram/src/main/network-guard.ts`: the diagram tab sends nothing
//! off this PC. The addresses are parsed as `new URL(...)` is (the `url`
//! crate follows the same standard).

use url::Url;

use super::drawio_protocol::{DRAWIO_HOST, DRAWIO_SCHEME};
use crate::packages::electron_utils::renderer_scheme::RENDERER_SCHEME;

/// The tab's session partition: draw.io's own storage stays in it.
pub const DIAGRAM_PARTITION: &str = "persist:ieum-diagram";

/// How many refused addresses the log keeps (the newest); `refused` counts them all.
pub const REFUSED_ADDRESSES_KEPT: usize = 100;

/// `ALWAYS_ALLOWED_SCHEMES`
fn always_allowed(protocol: &str) -> bool {
    protocol == format!("{RENDERER_SCHEME}:")
        || protocol == format!("{DRAWIO_SCHEME}:")
        || protocol == "data:"
        || protocol == "blob:"
}

/// `LOOPBACK`: loopback hosts a dev server may run on.
fn loopback(hostname: &str) -> bool {
    matches!(hostname, "localhost" | "127.0.0.1" | "[::1]")
}

/// `url.protocol`
fn protocol_of(url: &Url) -> String {
    format!("{}:", url.scheme())
}

/// `url.hostname`
fn hostname_of(url: &Url) -> &str {
    url.host_str().unwrap_or("")
}

/// `url.host`: the host and the port when it is not the scheme's default.
fn host_of(url: &Url) -> String {
    match url.port() {
        Some(port) => format!("{}:{port}", hostname_of(url)),
        None => hostname_of(url).to_owned(),
    }
}

/// `url.origin`: `"null"` for a scheme without an origin.
fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// The dev server origins a development run allows: loopback `http(s)`
/// origins of the given addresses. Nothing in a packaged app.
pub fn dev_server_origins(addresses: &[Option<&str>], packaged: bool) -> Vec<String> {
    if packaged {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    for address in addresses {
        // `if (!address) continue`
        let Some(address) = jscompat::truthy(*address) else {
            continue;
        };
        let Ok(url) = Url::parse(address) else {
            continue;
        };
        if (url.scheme() == "http" || url.scheme() == "https") && loopback(hostname_of(&url)) {
            let origin = origin_of(&url);
            if !out.contains(&origin) {
                out.push(origin);
            }
        }
    }
    out
}

/// Whether the diagram session lets a request through.
pub fn is_allowed_diagram_request(url: &str, dev_origins: &[String]) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    let protocol = protocol_of(&parsed);
    if always_allowed(&protocol) {
        return true;
    }
    // the dev server's page, scripts and hot-reload socket
    if protocol == "ws:" || protocol == "wss:" {
        let as_http = format!(
            "{}://{}",
            if protocol == "ws:" { "http" } else { "https" },
            host_of(&parsed)
        );
        return dev_origins.contains(&as_http);
    }
    dev_origins.contains(&origin_of(&parsed))
}

/// New windows from the tab: never, whatever the address (`{ action: 'deny' }`).
pub fn window_open_action() -> &'static str {
    "deny"
}

/// Whether a frame of the tab may go to `url`.
pub fn is_allowed_navigation(url: &str, is_main_frame: bool, current_url: &str) -> bool {
    if is_main_frame {
        return url == current_url;
    }
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    // a custom scheme has no URL origin in Node (`null`): compare scheme and host
    protocol_of(&parsed) == format!("{DRAWIO_SCHEME}:")
        && host_of(&parsed) == DRAWIO_HOST
        && parsed.path() == "/index.html"
}

/// `RequestLog`
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RequestLog {
    pub allowed: u64,
    /// every refused request since the log began
    pub refused: u64,
    /// the last `REFUSED_ADDRESSES_KEPT` refused addresses, oldest first
    pub blocked: Vec<String>,
    /// schemes seen among allowed requests, in the order first seen
    pub schemes: Vec<String>,
}

pub fn new_request_log() -> RequestLog {
    RequestLog::default()
}

/// Notes one request in the log and answers whether it may go.
pub fn screen_request(log: &mut RequestLog, url: &str, dev_origins: &[String]) -> bool {
    if is_allowed_diagram_request(url, dev_origins) {
        log.allowed += 1;
        if let Ok(parsed) = Url::parse(url) {
            let protocol = protocol_of(&parsed);
            if !log.schemes.contains(&protocol) {
                log.schemes.push(protocol);
            }
        }
        return true;
    }
    // keep the address short and never the query: it might carry content
    log.refused += 1;
    let head = url.split('?').next().unwrap_or("");
    log.blocked
        .push(jscompat::slice_utf16(head, 0.0, Some(200.0)));
    if log.blocked.len() > REFUSED_ADDRESSES_KEPT {
        log.blocked.remove(0);
    }
    false
}
