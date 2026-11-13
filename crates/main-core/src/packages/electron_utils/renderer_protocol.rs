//! `packages/electron-utils/src/renderer-protocol.ts`: the custom scheme that
//! serves each module's built renderer. Electron's `protocol` and `net` stay
//! with the caller: it registers [`renderer_scheme_privileges`] before the app
//! is ready, and answers each request of the scheme as
//! [`renderer_protocol_answer`] says.

use super::generated_images::path_to_file_url;
use super::renderer_scheme::{
    CustomScheme, docx_media_scheme_privilege, renderer_scheme_privilege, resolve_renderer_file,
    slide_media_scheme_privilege,
};

/// The list `registerRendererScheme` hands `protocol.registerSchemesAsPrivileged`.
/// A process may call that only once, so hosts that register other schemes
/// put these into their own list instead.
pub fn renderer_scheme_privileges() -> [CustomScheme; 3] {
    [
        renderer_scheme_privilege(),
        docx_media_scheme_privilege(),
        slide_media_scheme_privilege(),
    ]
}

/// What the handler `installRendererProtocol` installs answers for a request
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RendererProtocolAnswer {
    /// `new Response(null, { status: 404 })`
    NotFound,
    /// `net.fetch(url)` of this file URL; a rejected fetch is a 404 too
    Fetch(String),
}

/// The handler of `installRendererProtocol(roots)` for one request URL.
/// `roots` maps a renderer host to its built directory.
pub fn renderer_protocol_answer(
    roots: &[(String, String)],
    request_url: &str,
) -> RendererProtocolAnswer {
    match resolve_renderer_file(roots, request_url) {
        None => RendererProtocolAnswer::NotFound,
        Some(file) => RendererProtocolAnswer::Fetch(path_to_file_url(&file).to_string()),
    }
}
