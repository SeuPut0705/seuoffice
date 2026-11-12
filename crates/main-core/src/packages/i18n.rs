//! `packages/i18n/src`: what the main process uses of it (index.ts, product.ts,
//! old-names.ts, document-locale.ts).
//!
//! The process-wide UI language (`getUiLang`, `setUiLang`) is not held here:
//! the language is an explicit parameter of [`I18n::t`].

use jscompat::{JsObject, JsonValue, Primitive, js_regex, number_to_string, to_primitive, trim};

// ---- index.ts ----

/// `Lang`: `'en' | 'ko'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Lang {
    #[serde(rename = "en")]
    En,
    #[serde(rename = "ko")]
    Ko,
}

impl Lang {
    pub fn as_str(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::Ko => "ko",
        }
    }
}

/// `LANGS`
pub const LANGS: [Lang; 2] = [Lang::En, Lang::Ko];

/// `isLang(value)` of a string: one of `LANGS`, exactly.
pub fn is_lang(value: &str) -> bool {
    LANGS.iter().any(|lang| lang.as_str() == value)
}

/// `isLang(value)` of any value: only a string can be a language.
pub fn is_lang_value(value: Option<&JsonValue>) -> bool {
    matches!(value, Some(JsonValue::String(text)) if is_lang(text))
}

/// `normalizeLang(raw)`
pub fn normalize_lang(raw: Option<&str>) -> Lang {
    let value = raw.map(|text| trim(text).to_lowercase());
    match value {
        Some(v) if v == "ko" || v.starts_with("ko-") || v.starts_with("ko_") => Lang::Ko,
        _ => Lang::En,
    }
}

/// `requestedLanguage(stored, system)`
pub fn requested_language(stored: Option<&JsonValue>, system: Option<&str>) -> String {
    match stored {
        Some(JsonValue::String(text)) if !trim(text).is_empty() => text.clone(),
        _ => system.unwrap_or("").to_string(),
    }
}

/// `installLang(stored, system)`
pub fn install_lang(stored: Option<&JsonValue>, system: Option<&str>) -> Lang {
    normalize_lang(Some(&requested_language(stored, system)))
}

/// `htmlLang(lang)`
pub fn html_lang(lang: Lang) -> &'static str {
    match lang {
        Lang::En => "en-US",
        Lang::Ko => "ko-KR",
    }
}

const RTL_LANGS: [&str; 2] = ["ar", "he"];

/// `isRtlLang(lang)`
pub fn is_rtl_lang(lang: Option<&str>) -> bool {
    RTL_LANGS.contains(&lang.unwrap_or(""))
}

/// `htmlDir(lang)`
pub fn html_dir(lang: Option<&str>) -> &'static str {
    if is_rtl_lang(lang) { "rtl" } else { "ltr" }
}

fn mac_key_name(key: &str) -> Option<&'static str> {
    match key {
        "\u{232B}" => Some("Backspace"),
        "\u{2326}" => Some("Delete"),
        "\u{23CE}" => Some("Enter"),
        "\u{21A9}" => Some("Enter"),
        "\u{2423}" => Some("Space"),
        _ => None,
    }
}

fn chord_to_win(mods: &str, key: Option<&str>) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if mods.contains('\u{2318}') || mods.contains('\u{2303}') {
        parts.push("Ctrl");
    }
    if mods.contains('\u{2325}') {
        parts.push("Alt");
    }
    if mods.contains('\u{21E7}') {
        parts.push("Shift");
    }
    if let Some(key) = key.filter(|key| !key.is_empty()) {
        parts.push(mac_key_name(key).unwrap_or(key));
    }
    parts.join("+")
}

/// `macShortcutsToWin(text)`
pub fn mac_shortcuts_to_win(text: &str) -> String {
    let has_mac_symbol =
        js_regex!("[\u{2318}\u{2303}\u{2325}\u{21E7}\u{232B}\u{2326}\u{23CE}\u{21A9}\u{2423}]");
    if !has_mac_symbol.test(text) {
        return text.to_string();
    }
    // "<cmd>/Ctrl+Enter" dual-platform listings: keep the Ctrl side
    let dual = js_regex!("\u{2318}/(?=\\p{L}{2})", "gu");
    let chord = js_regex!(
        "([\u{2318}\u{2303}\u{2325}\u{21E7}]+)(F\\d{1,2}|[A-Za-z0-9\u{B1}=`'\\\\,./;[\\]\\-\u{2190}\u{2191}\u{2192}\u{2193}\u{232B}\u{2326}\u{23CE}\u{21A9}\u{2423}]|\\+)?",
        "g"
    );
    let glyph = js_regex!("[\u{232B}\u{2326}\u{23CE}\u{21A9}\u{2423}]", "g");
    let step1 = dual.replace_all(text, |_| String::new());
    let step2 = chord.replace_all(&step1, |m| {
        let mods = m.get(1).unwrap_or("");
        let key = m.get(2);
        if key == Some("+") {
            format!("{}+", chord_to_win(mods, None))
        } else {
            chord_to_win(mods, key)
        }
    });
    glyph.replace_all(&step2, |m| {
        let found = m.as_str();
        mac_key_name(found).unwrap_or(found).to_string()
    })
}

/// `IS_MAC`: macOS Node reports `navigator.platform` as "MacIntel".
pub const IS_MAC: bool = cfg!(target_os = "macos");

/// `platformShortcuts(text)`: identity on macOS.
pub fn platform_shortcuts(text: &str) -> String {
    if IS_MAC {
        text.to_string()
    } else {
        mac_shortcuts_to_win(text)
    }
}

/// `format(template, params)`: fills `{name}` placeholders; an unknown or
/// nullish one is left as it is. (`params` of `undefined` is the caller
/// returning the template without calling this.)
pub fn format(template: &str, params: &JsObject<JsonValue>) -> String {
    js_regex!(r"\{(\w+)\}", "g").replace_all(template, |m| {
        let name = m.get(1).unwrap_or("");
        match params.get(name) {
            None | Some(JsonValue::Null) => m.as_str().to_string(),
            Some(value) => match to_primitive(Some(value)) {
                Ok(Primitive::Number(x)) => number_to_string(x),
                Ok(other) => other.to_js_string(),
                // a value that cannot become a string is no `Params` value
                Err(_) => m.as_str().to_string(),
            },
        }
    })
}

/// `createI18n(dicts)`: the dictionaries of each language. `en` defines the
/// key set.
#[derive(Debug, Clone, Default)]
pub struct I18n {
    pub en: JsObject<String>,
    pub ko: JsObject<String>,
}

/// `createI18n(dicts)`
pub fn create_i18n(en: JsObject<String>, ko: JsObject<String>) -> I18n {
    I18n { en, ko }
}

impl I18n {
    fn dict(&self, lang: Lang) -> &JsObject<String> {
        match lang {
            Lang::En => &self.en,
            Lang::Ko => &self.ko,
        }
    }

    /// The translator `createI18n` returns, for `lang`: the text of `lang`,
    /// else English, else the key itself; shortcut hints for the platform,
    /// then the placeholders filled.
    pub fn t(&self, lang: Lang, key: &str, params: Option<&JsObject<JsonValue>>) -> String {
        let text = self
            .dict(lang)
            .get(key)
            .or_else(|| self.en.get(key))
            .map_or(key, String::as_str);
        let text = platform_shortcuts(text);
        match params {
            None => text,
            Some(params) => format(&text, params),
        }
    }
}

// ---- document-locale.ts ----

const DOCUMENT_LOCALES: [&str; 19] = [
    "zh", "ja", "ko", "fr", "de", "es", "th", "id", "ru", "ar", "pt", "it", "pl", "cs", "nl", "ms",
    "he", "hi", "vi",
];

/// `documentLocaleFor(requested)`
pub fn document_locale_for(requested: Option<&str>) -> String {
    let Some(value) = requested.map(|text| trim(text).to_lowercase()) else {
        return "en".to_string();
    };
    if value.is_empty() {
        return "en".to_string();
    }
    if js_regex!(r"^zh[-_](tw|hk|mo|hant)").test(&value) {
        return "zh-TW".to_string();
    }
    for code in DOCUMENT_LOCALES {
        if value == code
            || value
                .strip_prefix(code)
                .is_some_and(|rest| rest.starts_with(['-', '_']))
        {
            return code.to_string();
        }
    }
    if js_regex!(r"^in\b").test(&value) || js_regex!(r"^in[-_]").test(&value) {
        return "id".to_string();
    }
    if js_regex!(r"^iw\b").test(&value) || js_regex!(r"^iw[-_]").test(&value) {
        return "he".to_string();
    }
    "en".to_string()
}

/// `documentLocale()` with the process-wide requested locale as a parameter.
pub fn document_locale(requested_locale: &str) -> String {
    document_locale_for(Some(requested_locale))
}

// ---- product.ts ----

pub const UPSTREAM_PRODUCT_NAME: &str = "GenOffice";
pub const PRODUCT_NAME: &str = "SeuOffice";

/// `LOCALIZED_PRODUCT_NAMES`: empty, SeuOffice has no localized name yet.
const LOCALIZED_PRODUCT_NAMES: [(&str, &str); 0] = [];

/// `productName(lang)`
pub fn product_name(lang: Option<&str>) -> &'static str {
    let lowered = lang.map(|text| trim(text).to_lowercase());
    let base = lowered
        .as_deref()
        .map_or("", |text| text.split(['-', '_']).next().unwrap_or(""));
    LOCALIZED_PRODUCT_NAMES
        .iter()
        .find(|(key, _)| *key == base)
        .map_or(PRODUCT_NAME, |(_, name)| name)
}

pub const USER_DATA_DIR_NAME: &str = "seuoffice";
pub const DEV_USER_DATA_DIR_NAME: &str = "seuoffice-Dev";
pub const PRODUCT_REPO_OWNER: &str = "SeuPut0705";
pub const PRODUCT_REPO_NAME: &str = "seuoffice";
pub const PRODUCT_REPO_SLUG: &str = "SeuPut0705/seuoffice";

// ---- old-names.ts ----

pub const OLD_ENV_PREFIX: &str = "GENOFFICE_";
pub const ENV_PREFIX: &str = "SEUOFFICE_";

pub const OLD_ENV_NAMES: [&str; 14] = [
    "AI_SETTINGS",
    "ALLOWED_ROOTS",
    "APP_BIN",
    "AUDIT_LOG",
    "AUTH_DIR",
    "HB_SUBSET_WASM",
    "HOME",
    "LANG",
    "MCP_COMPACT_SCHEMAS",
    "MCP_TOKEN",
    "PDFIUM_WASM",
    "RHWP_WASM",
    "TRUST_PROXY_HEADERS",
    "USER_DATA",
];

/// `adoptOldEnv(env)`: an absent key is `undefined`.
pub fn adopt_old_env(env: &mut JsObject<String>) -> Vec<String> {
    let mut adopted = Vec::new();
    for name in OLD_ENV_NAMES {
        let old = format!("{OLD_ENV_PREFIX}{name}");
        let new = format!("{ENV_PREFIX}{name}");
        let Some(value) = env.get(&old).cloned() else {
            continue;
        };
        if env.get(&new).is_some() {
            continue;
        }
        env.set(new.clone(), value);
        adopted.push(new);
    }
    adopted
}

pub const OLD_HOME_DIR_NAMES: [&str; 1] = [".ieumoffice"];
pub const OLD_PROJECT_DATA_DIR_NAMES: [&str; 1] = [".ieumoffice"];
pub const OLD_CLI_COMMANDS: [&str; 1] = ["ieumoffice"];
pub const OLD_CLI_BUNDLE_FILES: [&str; 1] = ["genoffice.cjs"];
pub const OLD_MCP_SERVER_NAMES: [&str; 1] = ["ieumoffice"];
pub const OLD_APP_MCP_SERVER_NAMES: [&str; 1] = ["ieumoffice-editor"];
pub const OLD_SKILL_NAMES: [&str; 1] = ["ieumoffice"];

/// `OLD_MCP_TOOL_NAMES`, as (old, new) pairs.
pub const OLD_MCP_TOOL_NAMES: [(&str, &str); 1] = [("open_in_genoffice", "open_in_seuoffice")];

/// `OLD_MCP_RESOURCE_SCHEMES`: the scheme of the MCP resources
/// (`<scheme>://guide/...`) the agent skill of an earlier version names.
pub const OLD_MCP_RESOURCE_SCHEMES: [&str; 1] = ["ieumoffice"];

/// `existingOrCurrent(current, oldNames, exists)`
pub fn existing_or_current(
    current: &str,
    old_names: &[&str],
    mut exists: impl FnMut(&str) -> bool,
    in_use: Option<&mut dyn FnMut(&str) -> bool>,
) -> String {
    // `inUse` defaults to `exists`: the current name wins once it is in use
    let current_in_use = match in_use {
        Some(in_use) => in_use(current),
        None => exists(current),
    };
    if current_in_use {
        return current.to_string();
    }
    old_names
        .iter()
        .find(|name| exists(name))
        .map_or(current, |name| name)
        .to_string()
}
