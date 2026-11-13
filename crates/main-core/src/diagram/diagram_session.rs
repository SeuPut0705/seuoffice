//! `apps/diagram/src/main/diagram-session.ts`: the diagram tab's own session,
//! a persistent partition where draw.io keeps what it stores, where only the
//! app's schemes, `data:` and `blob:` load, and where draw.io's files come
//! from `drawio-app://`.
//!
//! What the session does is split like this. The module's state (`installed`,
//! `requestLog`) is a [`DiagramSession`] value. Electron's `session` stays
//! with the caller, behind [`SessionHost`]: [`DiagramSession::install`] makes
//! the calls in the TypeScript's order, and the caller then routes each
//! request of the two schemes to [`serve_drawio`] / [`serve_renderer`], each
//! `onBeforeRequest` to [`DiagramSession::cancels_request`] and each
//! permission question to [`permission_granted`]. A [`DiagramReply`] is the
//! `Response` the caller builds: it streams the file of [`DiagramReply::File`].

use std::fs;

use super::drawio_protocol::{
    DRAWIO_SCHEME, DrawioTarget, content_type_of, drawio_csp, inject_bridge, print_page_csp,
    resolve_drawio_request, response_headers,
};
use super::network_guard::{DIAGRAM_PARTITION, RequestLog, new_request_log, screen_request};
use super::print_document::PrintDocuments;
use crate::packages::electron_utils::renderer_scheme::{RENDERER_SCHEME, resolve_renderer_file};

/// `DiagramSessionPaths`
#[derive(Debug, Clone, PartialEq)]
pub struct DiagramSessionPaths {
    /// the built renderer folder (`<module out>/renderer`)
    pub renderer_dir: String,
    /// the trimmed draw.io bundle (`<module out>/drawio`)
    pub drawio_dir: String,
    /// our bridge script (`<module out>/bridge/bridge.js`)
    pub bridge_file: String,
    /// dev server origins a development run lets through; empty in a packaged app
    pub dev_origins: Vec<String>,
}

/// What `diagramRequestLog()` answers, its keys in the order the literal
/// writes them.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct DiagramRequestLog {
    pub allowed: u64,
    pub refused: u64,
    pub blocked: Vec<String>,
    pub schemes: Vec<String>,
}

/// The `Response` a handler answers.
#[derive(Debug, Clone, PartialEq)]
pub enum DiagramReply {
    /// `new Response(null, { status })`
    Status(u16),
    /// a file of this folder, its headers as written; `head` answers them
    /// with no body, otherwise the body is the file's bytes
    File {
        path: String,
        headers: Vec<(String, String)>,
        head: bool,
    },
    /// a page with its text as body (`None` for a HEAD request)
    Page {
        body: Option<String>,
        headers: Vec<(String, String)>,
    },
}

/// The calls on the session `diagramSession` makes.
pub trait SessionHost {
    /// `session.fromPartition(partition)`
    fn session_from_partition(&mut self, partition: &str);
    /// `ses.protocol.handle(scheme, ...)`
    fn handle_protocol(&mut self, scheme: &str);
    /// `ses.webRequest.onBeforeRequest(...)`
    fn on_before_request(&mut self);
    /// `ses.setSpellCheckerEnabled(enabled)`
    fn set_spell_checker_enabled(&mut self, enabled: bool);
    /// `ses.setPermissionRequestHandler(...)`
    fn set_permission_request_handler(&mut self);
    /// `ses.setPermissionCheckHandler(...)`
    fn set_permission_check_handler(&mut self);
}

/// `installed` and `requestLog`.
#[derive(Debug, Default)]
pub struct DiagramSession {
    installed: Option<DiagramSessionPaths>,
    request_log: RequestLog,
}

impl DiagramSession {
    pub fn new() -> Self {
        DiagramSession {
            installed: None,
            request_log: new_request_log(),
        }
    }

    /// `diagramSession(paths)`: set up once. `true` when this call set the
    /// session up, `false` when it was installed before (its paths stay).
    pub fn install(&mut self, paths: &DiagramSessionPaths, host: &mut dyn SessionHost) -> bool {
        if self.installed.is_some() {
            return false;
        }
        host.session_from_partition(DIAGRAM_PARTITION);
        host.handle_protocol(DRAWIO_SCHEME);
        host.handle_protocol(RENDERER_SCHEME);
        host.on_before_request();
        // no spelling dictionaries fetched for this session
        host.set_spell_checker_enabled(false);
        // draw.io's copy (as picture) needs the clipboard; nothing else is granted
        host.set_permission_request_handler();
        host.set_permission_check_handler();
        self.installed = Some(paths.clone());
        true
    }

    /// `diagramRequestLog()`: what the session let through and refused since
    /// the app started.
    pub fn diagram_request_log(&self) -> DiagramRequestLog {
        let mut schemes = self.request_log.schemes.clone();
        schemes.sort();
        DiagramRequestLog {
            allowed: self.request_log.allowed,
            refused: self.request_log.refused,
            blocked: self.request_log.blocked.clone(),
            schemes,
        }
    }

    /// The `onBeforeRequest` callback: `callback({ cancel: !screenRequest(...) })`.
    pub fn cancels_request(&mut self, url: &str) -> bool {
        let dev_origins = self
            .installed
            .as_ref()
            .map(|paths| paths.dev_origins.clone())
            .unwrap_or_default();
        !screen_request(&mut self.request_log, url, &dev_origins)
    }
}

/// The permission request and check handlers: only the clipboard's sanitized
/// write is granted.
pub fn permission_granted(permission: &str) -> bool {
    permission == "clipboard-sanitized-write"
}

fn not_found(status: u16) -> DiagramReply {
    DiagramReply::Status(status)
}

fn pairs(headers: impl IntoIterator<Item = (&'static str, String)>) -> Vec<(String, String)> {
    headers
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect()
}

/// `fileResponse(path, csp, method)`
fn file_response(path: &str, csp: Option<&str>, method: &str) -> DiagramReply {
    match fs::metadata(path) {
        Ok(info) if info.is_file() => {}
        _ => return not_found(404),
    }
    // the renderer's page carries its own policy (index.html)
    let headers = match csp {
        None => vec![
            ("Content-Type".to_owned(), content_type_of(path).to_owned()),
            ("X-Content-Type-Options".to_owned(), "nosniff".to_owned()),
        ],
        Some(csp) => pairs(response_headers(content_type_of(path), csp)),
    };
    DiagramReply::File {
        path: path.to_owned(),
        headers,
        head: method == "HEAD",
    }
}

/// The handler of `drawio-app://`: `serveDrawio(request, paths)`.
pub fn serve_drawio(
    method: &str,
    request_url: &str,
    paths: &DiagramSessionPaths,
    print_documents: &mut PrintDocuments,
) -> DiagramReply {
    if method != "GET" && method != "HEAD" {
        return not_found(405);
    }
    let mut ancestors = vec![format!("{RENDERER_SCHEME}:")];
    ancestors.extend(paths.dev_origins.iter().cloned());
    let ancestors: Vec<&str> = ancestors.iter().map(String::as_str).collect();
    let csp = drawio_csp(&ancestors);
    match resolve_drawio_request(&paths.drawio_dir, request_url) {
        DrawioTarget::Refused { status } => not_found(status),
        DrawioTarget::Bridge => file_response(&paths.bridge_file, Some(&csp), method),
        DrawioTarget::Print { token } => match print_documents.take_print_document(&token) {
            None => not_found(404),
            Some(html) => DiagramReply::Page {
                body: Some(html),
                headers: pairs(response_headers(
                    "text/html; charset=utf-8",
                    &print_page_csp(),
                )),
            },
        },
        DrawioTarget::File { path, relative } => {
            if relative != "index.html" {
                return file_response(&path, Some(&csp), method);
            }
            let injected = fs::read(&path)
                .ok()
                // `readFile(path, 'utf8')` keeps a byte order mark, unlike a decoder
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .and_then(|text| inject_bridge(&text).ok());
            let Some(html) = injected else {
                return not_found(404);
            };
            DiagramReply::Page {
                body: if method == "HEAD" { None } else { Some(html) },
                headers: pairs(response_headers("text/html; charset=utf-8", &csp)),
            }
        }
    }
}

/// The handler of the renderer scheme in this session: `serveRenderer`.
pub fn serve_renderer(method: &str, request_url: &str, renderer_dir: &str) -> DiagramReply {
    let roots = vec![("diagram".to_owned(), renderer_dir.to_owned())];
    match resolve_renderer_file(&roots, request_url) {
        None => not_found(404),
        Some(file) => file_response(&file, None, method),
    }
}
