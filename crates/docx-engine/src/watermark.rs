//! The read side of packages/docx-engine/src/watermark.ts: text and picture
//! watermarks found in a header part, and the header images a pending
//! watermark previews as. Word implements a watermark as a VML shape inside
//! the page header that floats behind the body text.

use jscompat::{JsNum, Slot, js_object, js_regex, math_round, parse_float, truthy};
use serde::{Deserialize, Serialize};

use crate::vml::{
    Dim, math_max, math_min, set_float_anchor, style_prop, vml_color_hex, vml_fraction,
    vml_rotation_deg, vml_style_dim_px,
};

/// `new RegExp(`\\s${key}="([^"]*)"`).exec(tag)?.[1]` for a literal key.
macro_rules! shape_attr {
    ($tag:expr, $key:literal) => {
        js_regex!(concat!(r"\s", $key, r#"="([^"]*)""#))
            .exec($tag)
            .and_then(|found| found.get(1))
    };
}

/// v:imagedata gain / blacklevel as fractions (Word's washout preset).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Washout {
    pub gain: JsNum,
    pub black_level: JsNum,
}

/// v:textpath WordArt: the renderer stretches the string's glyph ink to the box.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordArt {
    pub text: String,
    pub color_hex: String,
    pub opacity: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
}

js_object! {
    /// A display-only image of a header/footer part: the fields the watermark
    /// readers set (`HfImage` of types.ts). Each reader writes its keys in an
    /// order of its own.
    #[derive(Debug, Clone, PartialEq)]
    pub struct HfImage {
        pub data_url: String,
        pub width_px: JsNum,
        pub height_px: JsNum,
        pub floating: bool,
        pub behind: bool,
        pub watermark: bool,
        pub pos_h: &'static str,
        pub pos_v: &'static str,
        pub pos_x_px: JsNum,
        pub pos_y_px: JsNum,
        pub pos_h_rel: &'static str,
        pub pos_v_rel: &'static str,
        pub washout: Washout,
        pub rotation_deg: JsNum,
        pub word_art: WordArt,
    }
}

/// A box in points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxPt {
    pub width_pt: JsNum,
    pub height_pt: JsNum,
}

/// Text watermark as written by set_watermark / the Design tab.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkSpec {
    pub text: String,
    pub font_family: Option<String>,
    /// hex without '#' (default silver)
    pub color_hex: Option<String>,
    /// 0..1 fill opacity (default 0.5)
    pub opacity: Option<f64>,
    /// rotated 315 degrees like Word's diagonal layout (default true)
    pub diagonal: Option<bool>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    /// shape box for an explicit font size; absent = Word's auto box
    pub box_pt: Option<BoxPt>,
    pub size_pt: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkImage {
    pub base64: String,
    pub mime: String,
    pub width_px: f64,
    pub height_px: f64,
}

/// Picture watermark as written by set_watermark / Word's Design tab.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PictureWatermarkSpec {
    pub image: WatermarkImage,
    /// percent of the image's natural size; absent = fit inside the margin box
    pub scale: Option<f64>,
    /// Word's washout look (default true)
    pub washout: Option<bool>,
}

/// `string | WatermarkSpec | PictureWatermarkSpec`. An object that carries
/// `image` is a picture spec, whatever else it holds.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Watermark {
    Text(String),
    Picture(PictureWatermarkSpec),
    Spec(WatermarkSpec),
}

/// Picture watermark found in a header part.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PictureWatermarkInfo {
    pub r_id: String,
    pub width_pt: JsNum,
    pub height_pt: JsNum,
    pub washout: bool,
}

/// The watermark text of a header part; `None` (null) when it has none.
pub fn read_watermark_text(header_xml: &str) -> Option<String> {
    if !header_xml.contains("<v:textpath") {
        return None;
    }
    let found = js_regex!(r#"<v:textpath[^>]*\bstring="([^"]*)""#).exec(header_xml)?;
    let text = found
        .get(1)
        .unwrap_or("")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&");
    (!text.is_empty()).then_some(text)
}

/// Display geometry of a WordArt watermark pict: box size, rotation, anchor,
/// fill colour and opacity, and the textpath font. Word stretches the glyph
/// ink to the box, so the declared font-size is irrelevant here.
pub fn read_watermark_shape(pict_xml: &str) -> Option<HfImage> {
    let text = read_watermark_text(pict_xml)?;
    let body = js_regex!(r"<v:shapetype\b[\s\S]*?<\/v:shapetype>")
        .replace_all(pict_xml, |_| String::new());
    let shape_tag = js_regex!(r"<v:shape\b[^>]*>").exec(&body)?.as_str();
    let style = shape_attr!(shape_tag, "style").unwrap_or("");
    let width_px = vml_style_dim_px(style, Dim::Width).filter(|px| *px != 0.0)?;
    let height_px = vml_style_dim_px(style, Dim::Height).filter(|px| *px != 0.0)?;
    let fill_tag = js_regex!(r"<v:fill\b[^>]*>")
        .exec(&body)
        .map(|found| found.as_str());
    let tp_tag = js_regex!(r#"<v:textpath\b[^>]*\bstring="[^>]*>"#)
        .exec(&body)
        .map_or("", |found| found.as_str());
    let tp_style = shape_attr!(tp_tag, "style")
        .unwrap_or("")
        .replace("&quot;", "\"")
        .replace("&amp;", "&");
    let family = style_prop!(&tp_style, "font-family")
        .map(|family| js_regex!(r#"^"|"$"#).replace_all(family, |_| String::new()));
    let color_hex = if shape_attr!(shape_tag, "filled") == Some("f") {
        "FFFFFF".to_owned()
    } else {
        vml_color_hex(shape_attr!(shape_tag, "fillcolor")).unwrap_or_else(|| "000000".to_owned())
    };
    let opacity = fill_tag
        .and_then(|fill_tag| vml_fraction(shape_attr!(fill_tag, "opacity")))
        .unwrap_or(1.0);
    let mut img = HfImage {
        data_url: Slot::of(String::new()),
        width_px: Slot::of(JsNum(width_px)),
        height_px: Slot::of(JsNum(height_px)),
        floating: Slot::of(true),
        word_art: Slot::of(WordArt {
            text,
            color_hex,
            opacity: JsNum(math_max(0.0, math_min(1.0, opacity))),
            font_family: family.filter(|family| !family.is_empty()),
            bold: js_regex!(r"font-weight:\s*bold")
                .test(&tp_style)
                .then_some(true),
            italic: js_regex!(r"font-style:\s*italic")
                .test(&tp_style)
                .then_some(true),
        }),
        ..HfImage::default()
    };
    if js_regex!(r"z-index:\s*-").test(style) {
        img.behind.set(true);
    }
    if let Some(rot) = vml_rotation_deg(style) {
        img.rotation_deg.set(JsNum(rot));
    }
    set_float_anchor!(style, img);
    Some(img)
}

pub fn is_picture_watermark(wm: &Watermark) -> bool {
    matches!(wm, Watermark::Picture(_))
}

/// The header part child that carries the watermark (Word wraps the paragraph
/// in a Watermarks-gallery sdt).
pub fn is_watermark_child(name: &str, xml: &str) -> bool {
    if name != "w:p" && name != "w:sdt" {
        return false;
    }
    if xml.contains("<v:textpath") {
        return true;
    }
    xml.contains("<v:imagedata")
        && (is_picture_watermark_shape(xml)
            || xml.contains(r#"<w:docPartGallery w:val="Watermarks"/>"#))
}

/// A VML shape written as a picture watermark (Word's or ours).
pub fn is_picture_watermark_shape(xml: &str) -> bool {
    js_regex!(r#"<v:shape\b[^>]*\bid="(?:WordPictureWatermark|PowerPlusWaterMarkObject)"#).test(xml)
}

/// The header image a pending picture watermark will parse back as.
pub fn picture_watermark_preview_image(
    spec: &PictureWatermarkSpec,
    margin_box: Option<&BoxPt>,
) -> HfImage {
    let size = picture_watermark_box_pt(spec, margin_box);
    HfImage {
        data_url: Slot::of(format!(
            "data:{};base64,{}",
            spec.image.mime, spec.image.base64
        )),
        width_px: Slot::of(JsNum(math_round((size.width_pt.0 * 96.0) / 72.0))),
        height_px: Slot::of(JsNum(math_round((size.height_pt.0 * 96.0) / 72.0))),
        floating: Slot::of(true),
        behind: Slot::of(true),
        watermark: Slot::of(true),
        pos_h: Slot::of("center"),
        pos_v: Slot::of("center"),
        pos_h_rel: Slot::of("margin"),
        pos_v_rel: Slot::of("margin"),
        washout: Slot::maybe((spec.washout != Some(false)).then_some(Washout {
            gain: JsNum(0.3),
            black_level: JsNum(0.35),
        })),
        ..HfImage::default()
    }
}

/// Box of the text watermark shape in points (explicit size, or Word's auto
/// box per layout).
pub fn text_watermark_box_pt(spec: &WatermarkSpec) -> BoxPt {
    if let Some(size) = spec.box_pt {
        return size;
    }
    if spec.diagonal != Some(false) {
        BoxPt {
            width_pt: JsNum(412.4),
            height_pt: JsNum(247.45),
        }
    } else {
        BoxPt {
            width_pt: JsNum(527.85),
            height_pt: JsNum(131.95),
        }
    }
}

/// The header image a pending text watermark parses back as.
pub fn text_watermark_preview_image(spec: &WatermarkSpec) -> HfImage {
    let size = text_watermark_box_pt(spec);
    let color = spec.color_hex.as_deref().unwrap_or("C0C0C0");
    HfImage {
        data_url: Slot::of(String::new()),
        width_px: Slot::of(JsNum(math_round((size.width_pt.0 * 96.0) / 72.0))),
        height_px: Slot::of(JsNum(math_round((size.height_pt.0 * 96.0) / 72.0))),
        floating: Slot::of(true),
        behind: Slot::of(true),
        pos_h: Slot::of("center"),
        pos_v: Slot::of("center"),
        pos_h_rel: Slot::of("margin"),
        pos_v_rel: Slot::of("margin"),
        rotation_deg: Slot::maybe((spec.diagonal != Some(false)).then_some(JsNum(315.0))),
        word_art: Slot::of(WordArt {
            text: spec.text.clone(),
            color_hex: color.strip_prefix('#').unwrap_or(color).to_uppercase(),
            opacity: JsNum(math_max(0.0, math_min(1.0, spec.opacity.unwrap_or(0.5)))),
            font_family: Some(
                spec.font_family
                    .clone()
                    .unwrap_or_else(|| "DengXian".to_owned()),
            ),
            bold: (spec.bold == Some(true)).then_some(true),
            italic: (spec.italic == Some(true)).then_some(true),
        }),
        ..HfImage::default()
    }
}

fn vml_style_dim_pt(style: &str, key: Dim) -> f64 {
    let pattern = match key {
        Dim::Width => js_regex!(r"(?:^|;)\s*width:\s*(-?[\d.]+)(pt|in|cm|mm|px)?"),
        Dim::Height => js_regex!(r"(?:^|;)\s*height:\s*(-?[\d.]+)(pt|in|cm|mm|px)?"),
    };
    let Some(found) = pattern.exec(style) else {
        return 0.0;
    };
    let pt_per_unit = match found.get(2).unwrap_or("pt") {
        "in" => 72.0,
        "cm" => 72.0 / 2.54,
        "mm" => 72.0 / 25.4,
        "px" => 0.75,
        _ => 1.0,
    };
    math_round(parse_float(found.get(1).unwrap_or("")) * pt_per_unit * 100.0) / 100.0
}

/// The picture watermark of a header part; `None` (null) when it has none.
/// r:id is read with either quote.
pub fn read_picture_watermark(header_xml: &str) -> Option<PictureWatermarkInfo> {
    for found in js_regex!(r"<v:shape\b[^>]*>[\s\S]*?<\/v:shape>").find_iter(header_xml) {
        let shape = found.as_str();
        if !is_picture_watermark_shape(shape) && !is_watermark_child("w:p", shape) {
            continue;
        }
        let r_id = js_regex!(r#"<v:imagedata[^>]*\br:id\s*=\s*(["'])([^"']+)\1"#)
            .exec(shape)
            .and_then(|found| found.get(2));
        let Some(r_id) = truthy(r_id).map(str::to_owned) else {
            continue;
        };
        let style = js_regex!(r#"\sstyle="([^"]*)""#)
            .exec(shape)
            .and_then(|found| found.get(1))
            .unwrap_or("");
        return Some(PictureWatermarkInfo {
            r_id,
            width_pt: JsNum(vml_style_dim_pt(style, Dim::Width)),
            height_pt: JsNum(vml_style_dim_pt(style, Dim::Height)),
            washout: js_regex!(r#"\sgain=""#).test(shape),
        });
    }
    None
}

/// Box the picture watermark occupies, in points: explicit scale, or fitted
/// inside the margin box.
pub fn picture_watermark_box_pt(spec: &PictureWatermarkSpec, margin_box: Option<&BoxPt>) -> BoxPt {
    let natural_w = (spec.image.width_px * 72.0) / 96.0;
    let natural_h = (spec.image.height_px * 72.0) / 96.0;
    let factor = match spec.scale {
        Some(scale) => scale / 100.0,
        None => {
            // Letter with 1in margins when the section has no usable page box
            let (width_pt, height_pt) =
                margin_box.map_or((468.0, 648.0), |size| (size.width_pt.0, size.height_pt.0));
            math_min(width_pt / natural_w, height_pt / natural_h)
        }
    };
    BoxPt {
        width_pt: JsNum(math_max(
            1.0,
            math_round(natural_w * factor * 100.0) / 100.0,
        )),
        height_pt: JsNum(math_max(
            1.0,
            math_round(natural_h * factor * 100.0) / 100.0,
        )),
    }
}
