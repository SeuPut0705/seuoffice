//! `packages/electron-utils/src/safe-external-url.ts`.

use jscompat::trim;
use url::Url;

/// `SafeExternalUrlOptions`: the protocol allowlist, with the trailing colon.
#[derive(Debug, Clone, Default)]
pub struct SafeExternalUrlOptions {
    /// `None` is the default, http and https only.
    pub allowed_protocols: Option<Vec<String>>,
}

const DEFAULT_PROTOCOLS: [&str; 2] = ["http:", "https:"];

/// Returns the trimmed URL string when it parses and its protocol is on the
/// allowlist, otherwise none. `url` is `None` where the TypeScript is given
/// something that is not a string.
pub fn safe_external_url(
    url: Option<&str>,
    options: Option<&SafeExternalUrlOptions>,
) -> Option<String> {
    let text = trim(url?);
    let parsed = Url::parse(text).ok()?;
    let protocol = format!("{}:", parsed.scheme());
    let allowed = match options.and_then(|o| o.allowed_protocols.as_ref()) {
        Some(list) => list.contains(&protocol),
        None => DEFAULT_PROTOCOLS.contains(&protocol.as_str()),
    };
    allowed.then(|| text.to_owned())
}
