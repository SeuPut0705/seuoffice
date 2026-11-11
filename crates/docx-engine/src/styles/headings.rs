use jscompat::{JsNum, js_regex};
use serde::Serialize;

use super::StyleInfo;

/// What `parseDocx` derives from the style table before it reads the body.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingStyles {
    /// Heading level to the first style of that level, in style order.
    pub heading_style_ids: Vec<(JsNum, String)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_paragraph_style_id: Option<String>,
}

pub fn heading_styles_of(styles: &[(String, StyleInfo)]) -> HeadingStyles {
    let mut out = HeadingStyles::default();
    for (_, info) in styles {
        let level = info
            .heading_level
            .filter(|level| level.0 != 0.0 && !level.0.is_nan());
        if let Some(level) = level
            && !out
                .heading_style_ids
                .iter()
                .any(|(existing, _)| *existing == level)
        {
            out.heading_style_ids.push((level, info.style_id.clone()));
        }
        if out.list_paragraph_style_id.is_none()
            && js_regex!("^listparagraph$", "i").test(&info.style_id)
        {
            out.list_paragraph_style_id = Some(info.style_id.clone());
        }
    }
    out
}
