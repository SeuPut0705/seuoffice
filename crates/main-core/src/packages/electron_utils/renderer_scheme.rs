//! `packages/electron-utils/src/renderer-scheme.ts`.

use jscompat::node_path::host;
use jscompat::{decode_uri_component, js_regex};
use serde::Serialize;
use url::Url;

/// Origin the built renderers are served from (`genoffice-app://<module>/index.html`).
pub const RENDERER_SCHEME: &str = "genoffice-app";

/// The privileges of an Electron `CustomScheme`, in the order the TypeScript
/// writes them; a field the TypeScript leaves out is `None`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SchemePrivileges {
    pub standard: bool,
    pub secure: bool,
    #[serde(rename = "supportFetchAPI")]
    pub support_fetch_api: bool,
    #[serde(rename = "corsEnabled")]
    pub cors_enabled: bool,
    pub stream: bool,
    #[serde(rename = "codeCache", skip_serializing_if = "Option::is_none")]
    pub code_cache: Option<bool>,
}

/// Electron's `CustomScheme`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CustomScheme {
    pub scheme: &'static str,
    pub privileges: SchemePrivileges,
}

/// Chromium persists V8 code caches only for http(s) and for privileged custom
/// schemes; a file:// renderer recompiled its whole bundle on every open.
pub fn renderer_scheme_privilege() -> CustomScheme {
    CustomScheme {
        scheme: RENDERER_SCHEME,
        privileges: SchemePrivileges {
            standard: true,
            secure: true,
            support_fetch_api: true,
            cors_enabled: true,
            stream: true,
            code_cache: Some(true),
        },
    }
}

fn media_privileges(scheme: &'static str) -> CustomScheme {
    CustomScheme {
        scheme,
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

/// docs' lazily served pictures; a secure page may only load pictures from
/// another secure scheme
pub fn docx_media_scheme_privilege() -> CustomScheme {
    media_privileges("seuoffice-docx-media")
}

/// Slides serves archive pictures outside structured-clone IPC payloads.
pub fn slide_media_scheme_privilege() -> CustomScheme {
    media_privileges("seuoffice-slide-media")
}

/// `RendererHost`
pub const RENDERER_HOSTS: [&str; 11] = [
    "docs", "sheets", "slides", "pdf", "markdown", "html", "mindmap", "hwp", "epub", "diagram",
    "help",
];

pub const MAX_RENDERER_QUERY_ENTRIES: usize = 20;
pub const MAX_RENDERER_QUERY_CHARS: usize = 4_000;

/// The `Error` message of a refused `rendererUrl`.
#[derive(Debug, Clone, PartialEq)]
pub struct RendererUrlError(pub String);

/// `url.searchParams.set(key, value)`: the query is parsed as
/// `application/x-www-form-urlencoded`, the first pair of that name takes the
/// value and the others go, a name not there is appended, and the whole list
/// is written back.
fn search_params_set(url: &mut Url, key: &str, value: &str) {
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    match pairs.iter().position(|(k, _)| k == key) {
        Some(first) => {
            pairs[first].1 = value.to_owned();
            let mut index = 0;
            pairs.retain(|(k, _)| {
                let keep = index <= first || k != key;
                index += 1;
                keep
            });
        }
        None => pairs.push((key.to_owned(), value.to_owned())),
    }
    let mut serializer = url.query_pairs_mut();
    serializer.clear();
    serializer.extend_pairs(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
}

/// Dev server URL when one is configured, otherwise the module's scheme URL;
/// the query is appended either way so a dev URL that already carries params
/// stays valid. `query` is `Object.entries(query ?? {})` in JavaScript's key
/// order.
pub fn renderer_url(
    dev_url: Option<&str>,
    host: &str,
    query: &[(String, String)],
) -> Result<String, RendererUrlError> {
    let default_url = format!("{RENDERER_SCHEME}://{host}/index.html");
    let mut url = match Url::parse(dev_url.unwrap_or(&default_url)) {
        Ok(url) => url,
        Err(_) => {
            return Err(RendererUrlError(format!(
                "Invalid dev URL for renderer \"{}\": \"{}\"",
                host,
                dev_url.unwrap_or("undefined")
            )));
        }
    };
    if query.len() > MAX_RENDERER_QUERY_ENTRIES {
        return Err(RendererUrlError(format!(
            "Too many renderer query params ({}, cap {})",
            query.len(),
            MAX_RENDERER_QUERY_ENTRIES
        )));
    }
    for (key, value) in query {
        if key.encode_utf16().count() > 256
            || value.encode_utf16().count() > MAX_RENDERER_QUERY_CHARS
        {
            return Err(RendererUrlError("Renderer query param too long".to_owned()));
        }
        search_params_set(&mut url, key, value);
    }
    Ok(url.to_string())
}

/// Map a scheme request onto a file under the host's renderer directory; none
/// for unknown hosts and for paths that escape the directory.
pub fn resolve_renderer_file(roots: &[(String, String)], request_url: &str) -> Option<String> {
    let url = Url::parse(request_url).ok()?;
    let hostname = url.host_str().unwrap_or("");
    let root = roots
        .iter()
        .find(|(host_name, _)| host_name == hostname)
        .map(|(_, root)| root.as_str())
        .filter(|root| !root.is_empty())?;
    let pathname = decode_uri_component(url.path()).ok()?;
    if pathname.encode_utf16().count() > 4096 || pathname.contains('\0') {
        return None;
    }
    // Treat backslashes as separators too: %5c decodes to `\`, which resolves
    // as a directory separator on Windows but not on POSIX.
    let slashed = js_regex!(r"\\", "g").replace_all(&pathname, |_| "/".to_owned());
    let relative = js_regex!(r"^\/+").replace_all(&slashed, |_| String::new());
    // Normalize the root first so trailing slashes or mixed separators cannot
    // break the containment check below.
    let base = host::resolve(&[root]);
    let file = host::resolve(&[&base, &relative]);
    // The root itself is a directory, not a file to serve.
    if file == base {
        return None;
    }
    file.starts_with(&format!("{}{}", base, host::SEP))
        .then_some(file)
}
