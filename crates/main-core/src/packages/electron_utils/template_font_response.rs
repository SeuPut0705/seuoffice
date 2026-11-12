//! `packages/electron-utils/src/template-font-response.ts`: the main-process
//! answer to a renderer's template-font URL.

use crate::packages::ui::template_font_file_of;
use jscompat::node_path::host::join;

/// The `Response` the TypeScript builds: its status, its headers in the order
/// they were given, and its body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateFontResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// `FONT_MIME`
fn font_mime(extension: &str) -> Option<&'static str> {
    match extension {
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        _ => None,
    }
}

/// `templateFontResponse(url, dir, read)`: `None` is `null`. `read` is the
/// file reader (`readFile`); an `Err` from it is a 404.
pub fn template_font_response(
    url: &str,
    dir: &str,
    read: &mut dyn FnMut(&str) -> Result<Vec<u8>, ()>,
) -> Option<TemplateFontResponse> {
    let file = template_font_file_of(url)?;
    let bytes = match read(&join(&[dir, &file])) {
        Ok(bytes) => bytes,
        Err(()) => {
            return Some(TemplateFontResponse {
                status: 404,
                headers: Vec::new(),
                body: Vec::new(),
            });
        }
    };
    let extension = file.rsplit('.').next().unwrap_or("").to_lowercase();
    Some(TemplateFontResponse {
        status: 200,
        headers: vec![
            (
                "Content-Type".to_owned(),
                font_mime(&extension).unwrap_or("font/sfnt").to_owned(),
            ),
            ("Content-Length".to_owned(), bytes.len().to_string()),
            ("Access-Control-Allow-Origin".to_owned(), "*".to_owned()),
        ],
        body: bytes,
    })
}
