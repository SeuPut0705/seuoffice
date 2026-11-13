//! `apps/html/src/main/preview-protocol.ts`: the schemes the html editor's
//! preview needs, and the answer of the preview scheme's handler.
//!
//! `protocol` stays with the caller: it registers [`privileged_schemes`] before
//! app ready (a process may do that only once, so `extra` carries the other
//! editors' schemes) and answers each request of `PREVIEW_SCHEME` as
//! [`preview_answer`] says.

use jscompat::{js_regex, to_number};
use serde::Serialize;
use url::Url;

use super::preview_document::{ASSET_SCHEME, PREVIEW_SCHEME, build_preview_document};
use crate::packages::electron_utils::renderer_scheme::{
    CustomScheme, docx_media_scheme_privilege, renderer_scheme_privilege,
    slide_media_scheme_privilege,
};

/// The privileges of the html schemes, in the order the literals write them;
/// `stream` is left out of the preview scheme's.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PreviewPrivileges {
    pub standard: bool,
    pub secure: bool,
    #[serde(rename = "supportFetchAPI")]
    pub support_fetch_api: bool,
    #[serde(rename = "corsEnabled")]
    pub cors_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
}

/// One of the html editor's own schemes.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HtmlScheme {
    pub scheme: &'static str,
    pub privileges: PreviewPrivileges,
}

/// An entry of the list `registerSchemesAsPrivileged` is given: a scheme of
/// the shared utilities, one of this editor's, or one of `extra`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PrivilegedScheme<E> {
    Shared(CustomScheme),
    Html(HtmlScheme),
    Extra(E),
}

/// `registerPrivilegedSchemes(extra)`: the list handed to
/// `protocol.registerSchemesAsPrivileged`. Both html schemes are secure: a
/// secure preview document loading stylesheets and scripts from a non-secure
/// scheme would be blocked as mixed content.
pub fn privileged_schemes<E: Clone>(extra: &[E]) -> Vec<PrivilegedScheme<E>> {
    let mut list = vec![
        PrivilegedScheme::Shared(renderer_scheme_privilege()),
        PrivilegedScheme::Shared(docx_media_scheme_privilege()),
        PrivilegedScheme::Shared(slide_media_scheme_privilege()),
        PrivilegedScheme::Html(HtmlScheme {
            scheme: PREVIEW_SCHEME,
            privileges: PreviewPrivileges {
                standard: true,
                secure: true,
                support_fetch_api: true,
                cors_enabled: true,
                stream: None,
            },
        }),
        PrivilegedScheme::Html(HtmlScheme {
            scheme: ASSET_SCHEME,
            privileges: PreviewPrivileges {
                standard: true,
                secure: true,
                support_fetch_api: true,
                cors_enabled: true,
                stream: Some(true),
            },
        }),
    ];
    list.extend(extra.iter().cloned().map(PrivilegedScheme::Extra));
    list
}

/// What `resolve(webContentsId)` answers: the document's text and the base
/// its relative addresses resolve against.
#[derive(Debug, Clone, PartialEq)]
pub struct PreviewEntry {
    pub text: String,
    pub base_href: Option<String>,
}

/// The `Response` of the handler.
#[derive(Debug, Clone, PartialEq)]
pub enum PreviewAnswer {
    /// `new Response(null, { status })`: 400 for an address that does not
    /// parse, 404 for a host that is no view
    Status(u16),
    /// `new Response(buildPreviewDocument(...), { headers })`
    Document { body: String },
}

/// The headers of a [`PreviewAnswer::Document`], in the order written.
pub const PREVIEW_DOCUMENT_HEADERS: [(&str, &str); 2] = [
    ("Content-Type", "text/html; charset=utf-8"),
    ("Cache-Control", "no-store"),
];

/// The handler `registerPreviewProtocol(resolve)` installs, for one request URL.
pub fn preview_answer(
    request_url: &str,
    resolve: &mut dyn FnMut(f64) -> Option<PreviewEntry>,
) -> PreviewAnswer {
    // `new URL(request.url).host`
    let Ok(parsed) = Url::parse(request_url) else {
        return PreviewAnswer::Status(400);
    };
    let host = match (parsed.host_str(), parsed.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_owned(),
        (None, _) => String::new(),
    };
    let matched = js_regex!(r"^view-(\d+)$").exec(&host);
    let entry = match matched {
        Some(found) => resolve(to_number(found.get(1).unwrap_or(""))),
        None => None,
    };
    match entry {
        None => PreviewAnswer::Status(404),
        Some(entry) => PreviewAnswer::Document {
            body: build_preview_document(&entry.text, entry.base_href.as_deref()),
        },
    }
}
