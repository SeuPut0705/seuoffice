//! The renderer bundles of the apps, served to the webviews (the stage 3
//! shell contract, `renderer-protocol`).
//!
//! The Electron build served `genoffice-app://<host>/<file>` and every handler
//! still names its pages that way (`main_core`'s `renderer_url`). The CEF
//! runtime serves a custom scheme only as `http://<scheme>.localhost/`, so
//! each host gets a scheme of its own, `genoffice-app-<host>`: the page is
//! `http://genoffice-app-<host>.localhost/<file>`. One origin per host keeps
//! what the host's origin owned in Electron (localStorage, IndexedDB, the
//! permission grants) apart from the other hosts. [`webview_url`] and
//! [`electron_url`] translate between the two forms; nothing else has to
//! know the difference.

use std::path::PathBuf;

use main_core::packages::electron_utils::renderer_scheme::{
    RENDERER_HOSTS, RENDERER_SCHEME, resolve_renderer_file,
};
use tauri::Url;
use tauri::http::{self, StatusCode};

/// The scheme prefix of a host: `genoffice-app-docs`
pub const SCHEME_PREFIX: &str = "genoffice-app-";

/// The shell's own pages (the shell window, the update window, the dialogs'
/// windows). Electron loaded them from the file system; here they are a host
/// like the others.
pub const SHELL_HOST: &str = "shell";

/// Every host the shell serves: the renderer hosts of `main_core` and the shell's own
pub fn hosts() -> impl Iterator<Item = &'static str> {
    RENDERER_HOSTS.iter().copied().chain([SHELL_HOST])
}

pub fn scheme_of(host: &str) -> String {
    format!("{SCHEME_PREFIX}{host}")
}

/// The apps folder (`SEUOFFICE_APPS_DIR`, else the checkout the shell was built from)
fn apps_dir() -> PathBuf {
    std::env::var_os("SEUOFFICE_APPS_DIR").map_or_else(
        || PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../apps")),
        PathBuf::from,
    )
}

/// The folder of one host's bundle. A packaged shell carries them where the
/// Electron build did, `<resources>/modules/<app>/renderer` (batch U's bundle
/// job; `resources` is [`crate::paths::resources_path`]); a shell run from a
/// checkout reads `apps/<app>/out/renderer`, where electron-vite builds them.
/// `help` is the shell's own bundle (help mode), as in the Electron build.
fn root_of(host: &str, resources: Option<&PathBuf>) -> PathBuf {
    let app = if host == "help" { SHELL_HOST } else { host };
    if let Some(resources) = resources {
        let packaged = resources.join("modules").join(app).join("renderer");
        if packaged.is_dir() {
            return packaged;
        }
    }
    apps_dir().join(app).join("out").join("renderer")
}

/// `(host, folder)` for every host, in the form `resolve_renderer_file` takes.
///
/// `measure_page` serves the measurement's page as the `shell` host
/// (`--measure-dialog`, `frontend/`), so that page takes the road the real
/// pages take: the host's scheme, the file handler, the bridge in the HTML.
pub fn roots(resources: Option<PathBuf>, measure_page: bool) -> Vec<(String, String)> {
    hosts()
        .map(|host| {
            let root = if measure_page && host == SHELL_HOST {
                PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/frontend"))
            } else {
                root_of(host, resources.as_ref())
            };
            (host.to_owned(), root.to_string_lossy().into_owned())
        })
        .collect()
}

/// `genoffice-app://docs/index.html?x` as the webview loads it:
/// `http://genoffice-app-docs.localhost/index.html?x`. None for any other URL.
pub fn webview_url(electron_url: &str) -> Option<Url> {
    let url = Url::parse(electron_url).ok()?;
    if url.scheme() != RENDERER_SCHEME {
        return None;
    }
    let host = url.host_str()?;
    let mut out = Url::parse(&format!("http://{}.localhost/", scheme_of(host))).ok()?;
    out.set_path(url.path());
    out.set_query(url.query());
    out.set_fragment(url.fragment());
    Some(out)
}

/// The reverse: a page URL of the webview as the handlers know it
#[allow(dead_code)] // `webContents.getURL()` of the handlers that read a view's page: the WindowsHost
pub fn electron_url(url: &Url) -> Option<String> {
    let host = url
        .host_str()?
        .strip_suffix(".localhost")?
        .strip_prefix(SCHEME_PREFIX)?;
    let mut out = Url::parse(&format!("{RENDERER_SCHEME}://{host}/")).ok()?;
    out.set_path(url.path());
    out.set_query(url.query());
    out.set_fragment(url.fragment());
    Some(out.to_string())
}

/// Whether a navigation stays on the shell's own pages: a webview with a bridge
/// goes nowhere else (the contract, section 2, "permissions")
pub fn is_own_page(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str().is_some_and(|h| {
            h.ends_with(".localhost") && (h.starts_with(SCHEME_PREFIX) || h == "tauri.localhost")
        })
}

fn mime_of(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" | "webmanifest" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "bin" | "dat" | "docx" | "xlsx" | "pptx" | "zip" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

fn status(code: StatusCode) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(code)
        .body(Vec::new())
        .expect("a response of fixed parts")
}

/// One `Range: bytes=a-b` (or `a-`, or `-n`) of a body of `len` bytes
fn byte_range(header: &str, len: usize) -> Option<(usize, usize)> {
    let spec = header.strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    let (start, end) = if start.is_empty() {
        let n: usize = end.parse().ok()?;
        (len.saturating_sub(n), len.checked_sub(1)?)
    } else {
        let start: usize = start.parse().ok()?;
        let end = if end.is_empty() {
            len.checked_sub(1)?
        } else {
            end.parse().ok()?
        };
        (start, end.min(len.checked_sub(1)?))
    };
    (start <= end).then_some((start, end))
}

/// The answer to one request of `host`'s scheme. Reads the file, so it runs
/// off the UI thread.
pub fn serve(
    roots: &[(String, String)],
    host: &str,
    request: &http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    if request.method() != http::Method::GET && request.method() != http::Method::HEAD {
        return status(StatusCode::METHOD_NOT_ALLOWED);
    }
    // the same containment as the Electron build's handler: unknown hosts and
    // paths that leave the folder are a 404
    let url = format!("{RENDERER_SCHEME}://{host}{}", request.uri().path());
    let Some(file) = resolve_renderer_file(roots, &url) else {
        return status(StatusCode::NOT_FOUND);
    };
    let Ok(bytes) = std::fs::read(&file) else {
        return status(StatusCode::NOT_FOUND);
    };
    let builder = http::Response::builder()
        .header(http::header::CONTENT_TYPE, mime_of(&file))
        .header(http::header::ACCEPT_RANGES, "bytes");
    let range = request
        .headers()
        .get(http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| byte_range(v, bytes.len()));
    match range {
        Some((start, end)) => builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header(
                http::header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{}", bytes.len()),
            )
            .body(bytes[start..=end].to_vec()),
        None => builder.status(StatusCode::OK).body(bytes),
    }
    .expect("a response of fixed parts")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_translate_both_ways() {
        let url = webview_url("genoffice-app://docs/index.html?mode=tab#top").unwrap();
        assert_eq!(
            url.as_str(),
            "http://genoffice-app-docs.localhost/index.html?mode=tab#top"
        );
        assert_eq!(
            electron_url(&url).as_deref(),
            Some("genoffice-app://docs/index.html?mode=tab#top")
        );
        assert!(webview_url("https://example.com/").is_none());
        assert!(electron_url(&Url::parse("http://example.localhost/").unwrap()).is_none());
        assert!(is_own_page(&url));
        assert!(!is_own_page(
            &Url::parse("http://genoffice-app-docs.example.com/").unwrap()
        ));
        assert!(!is_own_page(
            &Url::parse("https://genoffice-app-docs.localhost/").unwrap()
        ));
    }

    #[test]
    fn ranges() {
        assert_eq!(byte_range("bytes=0-3", 10), Some((0, 3)));
        assert_eq!(byte_range("bytes=4-", 10), Some((4, 9)));
        assert_eq!(byte_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(byte_range("bytes=2-99", 10), Some((2, 9)));
        assert_eq!(byte_range("bytes=5-2", 10), None);
        assert_eq!(byte_range("items=0-1", 10), None);
    }

    #[test]
    fn a_packaged_shell_serves_each_host_from_its_modules_folder() {
        let resources = std::env::temp_dir().join(format!("w-app-scheme-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&resources);
        let folder = |host: &str| {
            let app = if host == "help" { SHELL_HOST } else { host };
            resources.join("modules").join(app).join("renderer")
        };
        for host in hosts() {
            std::fs::create_dir_all(folder(host)).unwrap();
        }
        let served = roots(Some(resources.clone()), false);
        assert_eq!(served.len(), hosts().count());
        for (host, root) in served {
            assert_eq!(PathBuf::from(root), folder(&host), "{host}");
        }
        let _ = std::fs::remove_dir_all(&resources);
    }

    #[test]
    fn a_path_outside_the_folder_is_a_404() {
        let base = std::env::temp_dir().join(format!("shell-scheme-{}", std::process::id()));
        let dir = base.join("docs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"hi").unwrap();
        std::fs::write(base.join("outside.txt"), b"no").unwrap();
        let roots = vec![("docs".to_owned(), dir.to_string_lossy().into_owned())];
        let get = |path: &str| {
            let request = http::Request::builder().uri(path).body(Vec::new()).unwrap();
            serve(&roots, "docs", &request)
        };
        assert_eq!(get("/a.txt").body(), b"hi");
        assert_eq!(get("/../outside.txt").status(), StatusCode::NOT_FOUND);
        assert_eq!(get("/%2e%2e/outside.txt").status(), StatusCode::NOT_FOUND);
        assert_eq!(get("/%5c..%5coutside.txt").status(), StatusCode::NOT_FOUND);
        assert_eq!(get("/missing.txt").status(), StatusCode::NOT_FOUND);
        assert_eq!(get("/").status(), StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(base).unwrap();
    }
}
