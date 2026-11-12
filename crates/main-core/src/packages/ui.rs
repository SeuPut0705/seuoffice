//! `packages/ui/src/template-fonts.ts`: what the main process uses of it.

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
