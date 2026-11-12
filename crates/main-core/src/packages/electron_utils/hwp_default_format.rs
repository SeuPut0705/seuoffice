//! `packages/electron-utils/src/hwp-default-format.ts`: what a brand-new
//! Hangul document is saved as the first time.

use std::fs;

use jscompat::node_path::host::join;
use jscompat::{JsonValue, json_parse};

pub use super::default_save_dir::PathProvider as SettingsPathProvider;

/// `HWP_DEFAULT_FORMAT_KEY`
pub const HWP_DEFAULT_FORMAT_KEY: &str = "hwpDefaultFormat";

/// `HwpDefaultFormat`
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum HwpDefaultFormat {
    #[serde(rename = "hwp")]
    Hwp,
    #[serde(rename = "hwpx")]
    Hwpx,
}

/// `normalizeHwpDefaultFormat(value)`
pub fn normalize_hwp_default_format(value: Option<&JsonValue>) -> HwpDefaultFormat {
    match value {
        Some(JsonValue::String(s)) if s == "hwpx" => HwpDefaultFormat::Hwpx,
        _ => HwpDefaultFormat::Hwp,
    }
}

/// `readHwpDefaultFormat(app)`
pub fn read_hwp_default_format(app: &dyn SettingsPathProvider) -> HwpDefaultFormat {
    let Ok(user_data) = app.get_path("userData") else {
        return HwpDefaultFormat::Hwp;
    };
    let path = join(&[&user_data, "app-settings.json"]);
    let Ok(bytes) = fs::read(&path) else {
        return HwpDefaultFormat::Hwp;
    };
    match json_parse(&String::from_utf8_lossy(&bytes)) {
        Ok(JsonValue::Object(raw)) => normalize_hwp_default_format(raw.get(HWP_DEFAULT_FORMAT_KEY)),
        _ => HwpDefaultFormat::Hwp,
    }
}
