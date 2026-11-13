//! `apps/sheets/src/main/template-fonts.ts`: the bundled template fonts on the
//! main side: a standalone app's answer to a renderer's template-font URL, and
//! the `@font-face` rules the hidden PDF export / print window needs.
//!
//! `app`, `process.resourcesPath` and `protocol` stay with the caller: the
//! folder comes from [`sheets_template_fonts_dir`] over their values, and the
//! handler `installStandaloneTemplateFontProtocol` registers is
//! [`TemplateFontProtocol::answer`].

use jscompat::js_regex;
use jscompat::node_path::host::join;

use crate::packages::electron_utils::generated_images::path_to_file_url;
use crate::packages::electron_utils::template_font_response::{
    TemplateFontResponse, template_font_response,
};
use crate::packages::electron_utils::template_fonts_dir::{TemplateFontsHost, template_fonts_dir};
use crate::packages::ui::TEMPLATE_FONT_SCHEME;

/// `TEMPLATE_FONT_FACE_REGISTRATIONS` of `packages/ui/src/template-fonts.ts`
/// as `(family, file, weight)`: every face under its family at its own
/// weight, a variable file over its `wght` range.
pub const TEMPLATE_FONT_FACE_REGISTRATIONS: [(&str, &str, &str); 13] = [
    ("Pretendard", "Pretendard-Regular.otf", "400"),
    ("Pretendard", "Pretendard-Bold.otf", "700"),
    ("Noto Serif KR", "NotoSerifKR-Regular.otf", "400"),
    ("Noto Serif KR", "NotoSerifKR-Bold.otf", "700"),
    ("Black Han Sans", "BlackHanSans-Regular.ttf", "400"),
    ("Do Hyeon", "DoHyeon-Regular.ttf", "400"),
    ("Gowun Dodum", "GowunDodum-Regular.ttf", "400"),
    ("Gowun Batang", "GowunBatang-Regular.ttf", "400"),
    ("Gowun Batang", "GowunBatang-Bold.ttf", "700"),
    ("Bebas Neue", "BebasNeue-Regular.ttf", "400"),
    ("Space Grotesk", "SpaceGrotesk-Bold.ttf", "700"),
    ("Playfair Display", "PlayfairDisplay[wght].ttf", "400 900"),
    ("Archivo Black", "ArchivoBlack-Regular.ttf", "400"),
];

struct AppHost<'a> {
    is_packaged: bool,
    get_app_path: &'a dyn Fn() -> String,
    resources_path: &'a str,
}

impl TemplateFontsHost for AppHost<'_> {
    fn is_packaged(&self) -> bool {
        self.is_packaged
    }

    fn get_app_path(&self) -> String {
        (self.get_app_path)()
    }

    fn resources_path(&self) -> String {
        self.resources_path.to_owned()
    }
}

/// `sheetsTemplateFontsDir()`: the installed folder (resources/template-fonts),
/// or the checkout's in a dev run. `get_app_path` is `app.getAppPath()`, read
/// only when the app is not packaged.
pub fn sheets_template_fonts_dir(
    is_packaged: bool,
    get_app_path: &dyn Fn() -> String,
    resources_path: &str,
) -> String {
    template_fonts_dir(&AppHost {
        is_packaged,
        get_app_path,
        resources_path,
    })
}

/// What `installStandaloneTemplateFontProtocol()` registers: the handler of
/// `TEMPLATE_FONT_SCHEME` over the folder it was installed with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateFontProtocol {
    pub scheme: &'static str,
    dir: String,
}

/// `installStandaloneTemplateFontProtocol()`: the folder is read first, then
/// the handler is registered under the scheme.
pub fn install_standalone_template_font_protocol(dir: String) -> TemplateFontProtocol {
    TemplateFontProtocol {
        scheme: TEMPLATE_FONT_SCHEME,
        dir,
    }
}

impl TemplateFontProtocol {
    /// The handler: `(await templateFontResponse(request.url, dir)) ??
    /// new Response(null, { status: 404 })`.
    pub fn answer(
        &self,
        url: &str,
        read: &mut dyn FnMut(&str) -> Result<Vec<u8>, ()>,
    ) -> TemplateFontResponse {
        template_font_response(url, &self.dir, read).unwrap_or(TemplateFontResponse {
            status: 404,
            headers: Vec::new(),
            body: Vec::new(),
        })
    }
}

/// `templateFontFaceCss(dir)`: the rules name the files by file URL.
pub fn template_font_face_css(dir: &str) -> String {
    TEMPLATE_FONT_FACE_REGISTRATIONS
        .iter()
        .map(|(family, file, weight)| {
            format!(
                "@font-face {{ font-family: '{family}'; src: url(\"{}\"); font-weight: {weight}; }}",
                path_to_file_url(&join(&[dir, file]))
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `withTemplateFontFaces(html, dir)`: the print HTML with the bundled faces
/// declared ahead of its own styles.
pub fn with_template_font_faces(html: &str, dir: &str) -> String {
    let style = format!("<style>\n{}\n</style>", template_font_face_css(dir));
    // after <head>, else after the doctype (a style ahead of it would switch the page to quirks mode)
    let anchor = js_regex!(r"<head\b[^>]*>", "i")
        .exec(html)
        .or_else(|| js_regex!(r"^\s*<!doctype[^>]*>", "i").exec(html));
    let at = anchor.map_or(0, |found| found.end());
    format!("{}{style}{}", &html[..at], &html[at..])
}
