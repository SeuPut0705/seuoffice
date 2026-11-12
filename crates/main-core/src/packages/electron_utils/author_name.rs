//! `packages/electron-utils/src/author-name.ts`: the name written on comments
//! and tracked changes.

use std::fs;

use jscompat::node_path::host::join;
use jscompat::{JsonValue, js_regex, json_parse, trim};

/// `AUTHOR_NAME_KEY`
pub const AUTHOR_NAME_KEY: &str = "authorName";
/// `AUTHOR_NAME_MAX`
pub const AUTHOR_NAME_MAX: usize = 120;
const FALLBACK: &str = "User";

/// `sanitizeAuthorName(value)`: trimmed, white space runs as one space, the
/// first 120 UTF-16 units; `''` when nothing usable.
pub fn sanitize_author_name(value: Option<&JsonValue>) -> String {
    let Some(JsonValue::String(value)) = value else {
        return String::new();
    };
    sanitize_text(value)
}

fn sanitize_text(value: &str) -> String {
    let collapsed = js_regex!(r"\s+", "g").replace_all(trim(value), |_| " ".to_owned());
    // `slice(0, AUTHOR_NAME_MAX)`: a cut inside a surrogate pair leaves a lone
    // surrogate, which becomes U+FFFD where the text is written out as UTF-8
    jscompat::slice_utf16(&collapsed, 0.0, Some(AUTHOR_NAME_MAX as f64))
}

/// `readAuthorNameSetting(settingsPath)`
pub fn read_author_name_setting(settings_path: &str) -> String {
    let Ok(bytes) = fs::read(settings_path) else {
        return String::new();
    };
    let Ok(JsonValue::Object(raw)) = json_parse(&String::from_utf8_lossy(&bytes)) else {
        return String::new();
    };
    sanitize_author_name(raw.get(AUTHOR_NAME_KEY))
}

/// `systemAuthorName()` for the account name the OS reported (`None` when
/// `os.userInfo()` throws).
pub fn system_author_name(username: Option<&str>) -> String {
    let name = username.map(sanitize_text).unwrap_or_default();
    if name.is_empty() {
        FALLBACK.to_owned()
    } else {
        name
    }
}

/// `resolveAuthorName(settingsPath)`
pub fn resolve_author_name(settings_path: &str, username: Option<&str>) -> String {
    let configured = read_author_name_setting(settings_path);
    if configured.is_empty() {
        system_author_name(username)
    } else {
        configured
    }
}

/// `configuredAuthorName(app)` with `app.getPath('userData')` given
pub fn configured_author_name(user_data: &str, username: Option<&str>) -> String {
    resolve_author_name(&join(&[user_data, "app-settings.json"]), username)
}
