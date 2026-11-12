//! `packages/ui/src/template-fonts.ts` and `slides-ai-fonts.ts`: what the main
//! process uses of them.

use jscompat::{decode_uri_component, js_regex};

/// `TEMPLATE_FONT_SCHEME`
pub const TEMPLATE_FONT_SCHEME: &str = "seuoffice-docx-media";
/// `TEMPLATE_FONT_HOST`
pub const TEMPLATE_FONT_HOST: &str = "template-fonts";

/// `TEMPLATE_FONT_FILES`: each bundled font file once.
pub const TEMPLATE_FONT_FILES: [&str; 13] = [
    "Pretendard-Regular.otf",
    "Pretendard-Bold.otf",
    "NotoSerifKR-Regular.otf",
    "NotoSerifKR-Bold.otf",
    "BlackHanSans-Regular.ttf",
    "DoHyeon-Regular.ttf",
    "GowunDodum-Regular.ttf",
    "GowunBatang-Regular.ttf",
    "GowunBatang-Bold.ttf",
    "BebasNeue-Regular.ttf",
    "SpaceGrotesk-Bold.ttf",
    "PlayfairDisplay[wght].ttf",
    "ArchivoBlack-Regular.ttf",
];

/// `templateFontFileOf(url)`: the listed font file a URL names, or `None` for
/// any other URL.
pub fn template_font_file_of(url: &str) -> Option<String> {
    // `new URL(url)` throws on a URL it cannot parse
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != TEMPLATE_FONT_SCHEME || parsed.host_str() != Some(TEMPLATE_FONT_HOST) {
        return None;
    }
    let pathname = parsed.path().to_owned();
    let name =
        decode_uri_component(&js_regex!(r"^\/+").replace_all(&pathname, |_| String::new())).ok()?;
    TEMPLATE_FONT_FILES.contains(&name.as_str()).then_some(name)
}

// ---- slides-ai-fonts.ts ----

use crate::packages::ai_provider::jsval::{as_record, as_str, length16, object, text};
use jscompat::{JsonValue, trim};

/// `SlidesAiFontMode`: auto: the model picks; sans/serif: every text in that
/// face; serifTitle: serif titles over sans body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlidesAiFontMode {
    Auto,
    Sans,
    Serif,
    SerifTitle,
}

impl SlidesAiFontMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SlidesAiFontMode::Auto => "auto",
            SlidesAiFontMode::Sans => "sans",
            SlidesAiFontMode::Serif => "serif",
            SlidesAiFontMode::SerifTitle => "serifTitle",
        }
    }
}

/// `SLIDES_AI_FONT_MODES`
pub const SLIDES_AI_FONT_MODES: [SlidesAiFontMode; 4] = [
    SlidesAiFontMode::Auto,
    SlidesAiFontMode::Sans,
    SlidesAiFontMode::Serif,
    SlidesAiFontMode::SerifTitle,
];

/// `SlidesAiFonts`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlidesAiFonts {
    pub mode: SlidesAiFontMode,
    /// the sans-serif (gothic) family
    pub sans: String,
    /// the serif (myeongjo) family
    pub serif: String,
}

impl SlidesAiFonts {
    /// The object the TypeScript builds: `mode`, `sans`, `serif`.
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            ("mode", text(self.mode.as_str())),
            ("sans", text(self.sans.as_str())),
            ("serif", text(self.serif.as_str())),
        ])
    }
}

/// `SlidesAiFontRoles`: the two theme roles a deck has: title text and every
/// other text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlidesAiFontRoles {
    pub title: String,
    pub body: String,
}

/// `SLIDES_AI_FONTS_KEY`
pub const SLIDES_AI_FONTS_KEY: &str = "slidesAiFonts";

/// `DEFAULT_SANS_FONT`
pub const DEFAULT_SANS_FONT: &str = "Pretendard";
/// `DEFAULT_SERIF_FONT`
pub const DEFAULT_SERIF_FONT: &str = "Noto Serif KR";

/// Longest family name kept
const MAX_FAMILY_LENGTH: usize = 80;

/// `defaultSlidesAiFonts(lang)`: the bundled gothic face where the language
/// documents are read for is one its glyphs cover (Korean, English); `auto`
/// elsewhere.
pub fn default_slides_ai_fonts(lang: &str) -> SlidesAiFonts {
    SlidesAiFonts {
        mode: if lang == "ko" || lang == "en" {
            SlidesAiFontMode::Sans
        } else {
            SlidesAiFontMode::Auto
        },
        sans: DEFAULT_SANS_FONT.to_owned(),
        serif: DEFAULT_SERIF_FONT.to_owned(),
    }
}

fn family_or(value: Option<&JsonValue>, fallback: &str) -> String {
    let Some(value) = as_str(value) else {
        return fallback.to_owned();
    };
    // a family name never holds control characters or quotes, and the prompt quotes it
    let name: String = value
        .chars()
        .filter(|ch| {
            // `ch.charCodeAt(0)`: the first code unit
            let code = ch.encode_utf16(&mut [0u16; 2])[0];
            code >= 0x20 && code != 0x7f && *ch != '"'
        })
        .collect();
    let name = trim(&name);
    if !name.is_empty() && length16(name) <= MAX_FAMILY_LENGTH {
        name.to_owned()
    } else {
        fallback.to_owned()
    }
}

/// `normalizeSlidesAiFonts(value, lang)`: reads a stored value; anything
/// absent or unknown falls back to the language's default.
pub fn normalize_slides_ai_fonts(value: Option<&JsonValue>, lang: &str) -> SlidesAiFonts {
    let base = default_slides_ai_fonts(lang);
    let Some(v) = value.and_then(as_record) else {
        return base;
    };
    let mode = match as_str(v.get("mode")) {
        Some(m) => SLIDES_AI_FONT_MODES
            .iter()
            .copied()
            .find(|candidate| candidate.as_str() == m)
            .unwrap_or(base.mode),
        None => base.mode,
    };
    SlidesAiFonts {
        mode,
        sans: family_or(v.get("sans"), &base.sans),
        serif: family_or(v.get("serif"), &base.serif),
    }
}
