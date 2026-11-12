//! The VML geometry and colour readers of packages/docx-engine/src/parse-vml.ts
//! that the watermark readers stand on: `vmlLengthPx`, `vmlStyleProp`,
//! `vmlStyleDimPx`, `vmlRotationDeg`, `anchorRelH`, `anchorRelV`,
//! `vmlFloatAnchor`, `vmlFraction`, `vmlColorHex`.

use jscompat::{
    JsNum, JsRegex, RegexError, TryJsRegex, js_object, js_regex, math_round, parse_float, trim,
    truthy,
};
use serde::Deserialize;

pub mod shape;
pub mod word_art;

/// `vmlStyleProp(style, key)` for a literal key: the pattern compiles once per
/// call site instead of once per call.
macro_rules! style_prop {
    ($style:expr, $key:literal) => {
        $crate::vml::prop_in(
            $style,
            ::jscompat::js_regex!(concat!(r"(?:^|;)\s*", $key, ":([^;]+)")),
        )
    };
}
pub(crate) use style_prop;

/// `Math.max(a, b)`: NaN wins, and +0 is above -0.
pub fn math_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_positive() { a } else { b }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: NaN wins, and -0 is below +0.
pub fn math_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// VML length ("46pt", "16in", "2cm", "12px"; unitless = pt) as CSS px.
pub fn vml_length_px(value: Option<&str>) -> Option<f64> {
    let value = truthy(value)?;
    let found = js_regex!(r"^\s*(-?[\d.]+)(pt|px|in|mm|cm)?\s*$").exec(value)?;
    let v = parse_float(found.get(1).unwrap_or(""));
    if !v.is_finite() {
        return None;
    }
    Some(match found.get(2).unwrap_or("pt") {
        "px" => v,
        "in" => v * 96.0,
        "mm" => (v / 25.4) * 96.0,
        "cm" => (v / 2.54) * 96.0,
        _ => (v * 96.0) / 72.0,
    })
}

/// The trimmed first capture of `pattern` in a style attribute.
pub(crate) fn prop_in<'s>(style: &'s str, pattern: &JsRegex) -> Option<&'s str> {
    pattern.exec(style)?.get(1).map(trim)
}

/// One declaration of a VML style attribute ("rotation:315;width:4in", "width"
/// gives "4in"). `key` goes into the pattern unescaped, as in the original.
pub fn vml_style_prop<'s>(style: &'s str, key: &str) -> Result<Option<&'s str>, RegexError> {
    let pattern = TryJsRegex::new(&format!(r"(?:^|;)\s*{key}:([^;]+)"), "")?;
    Ok(pattern
        .try_exec(style)?
        .and_then(|found| found.get(1))
        .map(trim))
}

/// The two dimensions of a VML style box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Dim {
    Width,
    Height,
}

/// VML style="width:189.9pt;height:626pt" dimension as CSS px.
pub fn vml_style_dim_px(style: &str, key: Dim) -> Option<f64> {
    let prop = match key {
        Dim::Width => style_prop!(style, "width"),
        Dim::Height => style_prop!(style, "height"),
    };
    let px = vml_length_px(prop)?;
    (px > 0.0).then(|| math_round(px))
}

/// VML rotation ("315", "-45", "41366637fd" = 1/65536 degree units) as degrees
/// clockwise in (0, 360).
pub fn vml_rotation_deg(style: &str) -> Option<f64> {
    let rotation = style_prop!(style, "rotation").unwrap_or("");
    let found = js_regex!(r"^(-?[\d.]+)(fd)?$").exec(rotation)?;
    let mut deg = parse_float(found.get(1).unwrap_or(""));
    if found.get(2).is_some() {
        deg /= 65536.0;
    }
    if !deg.is_finite() {
        return None;
    }
    deg = math_round((((deg % 360.0) + 360.0) % 360.0) * 100.0) / 100.0;
    (deg > 0.0).then_some(deg)
}

/// wp:positionH relativeFrom / VML mso-position-horizontal-relative as a
/// placement band.
pub fn anchor_rel_h(rel: Option<&str>) -> &'static str {
    match rel {
        Some("page") => "page",
        Some("leftMargin" | "insideMargin" | "left-margin-area" | "inner-margin-area") => {
            "leftMargin"
        }
        Some("rightMargin" | "outsideMargin" | "right-margin-area" | "outer-margin-area") => {
            "rightMargin"
        }
        _ => "margin",
    }
}

/// wp:positionV relativeFrom / VML mso-position-vertical-relative as a
/// placement band.
pub fn anchor_rel_v(rel: Option<&str>) -> &'static str {
    match rel {
        Some("page") => "page",
        Some("paragraph" | "line" | "text") => "paragraph",
        Some("topMargin" | "insideMargin" | "top-margin-area" | "inner-margin-area") => "topMargin",
        Some("bottomMargin" | "outsideMargin" | "bottom-margin-area" | "outer-margin-area") => {
            "bottomMargin"
        }
        _ => "margin",
    }
}

js_object! {
    /// The float anchor fields of a header/footer image (`Pick<HfImage, 'posH' |
    /// 'posV' | 'posXPx' | 'posYPx' | 'posHRel' | 'posVRel'>`).
    #[derive(Debug, Clone, PartialEq)]
    pub struct FloatAnchor {
        pub pos_h: &'static str,
        pub pos_v: &'static str,
        pub pos_x_px: JsNum,
        pub pos_y_px: JsNum,
        pub pos_h_rel: &'static str,
        pub pos_v_rel: &'static str,
    }
}

/// `vmlFloatAnchor(style, out)` on any object that has the float anchor keys:
/// the keys are set on `out` itself, after the keys it has.
macro_rules! set_float_anchor {
    ($style:expr, $out:expr) => {{
        let style: &str = $style;
        $out.pos_h_rel
            .set($crate::vml::anchor_rel_h($crate::vml::style_prop!(
                style,
                "mso-position-horizontal-relative"
            )));
        $out.pos_v_rel
            .set($crate::vml::anchor_rel_v($crate::vml::style_prop!(
                style,
                "mso-position-vertical-relative"
            )));
        let pos_h = $crate::vml::style_prop!(style, "mso-position-horizontal");
        let pos_v = $crate::vml::style_prop!(style, "mso-position-vertical");
        match pos_h {
            Some("left") => $out.pos_h.set("left"),
            Some("center") => $out.pos_h.set("center"),
            Some("right") => $out.pos_h.set("right"),
            _ => {
                let px = $crate::vml::vml_length_px($crate::vml::style_prop!(style, "margin-left"))
                    .unwrap_or(0.0);
                $out.pos_x_px
                    .set(::jscompat::JsNum(::jscompat::math_round(px)));
            }
        }
        match pos_v {
            Some("top") => $out.pos_v.set("top"),
            Some("center") => $out.pos_v.set("center"),
            Some("bottom") => $out.pos_v.set("bottom"),
            _ => {
                let px = $crate::vml::vml_length_px($crate::vml::style_prop!(style, "margin-top"))
                    .unwrap_or(0.0);
                $out.pos_y_px
                    .set(::jscompat::JsNum(::jscompat::math_round(px)));
            }
        }
    }};
}
pub(crate) use set_float_anchor;

/// position:absolute placement of a VML shape as header/footer float anchor
/// fields. A keyword alignment wins over the margin offsets.
pub fn vml_float_anchor(style: &str, out: &mut FloatAnchor) {
    set_float_anchor!(style, out);
}

/// VML fixed-point, fraction or percentage ("32768f" = 0.5, ".5", "50%", "1") as a number.
pub fn vml_fraction(value: Option<&str>) -> Option<f64> {
    let found = js_regex!(r"^\s*(-?[\d.]+)(f|%)?\s*$").exec(value.unwrap_or(""))?;
    let v = parse_float(found.get(1).unwrap_or(""));
    if !v.is_finite() {
        return None;
    }
    Some(match found.get(2) {
        Some("f") => v / 65536.0,
        Some(_) => v / 100.0,
        None => v,
    })
}

/// The HTML colour names VML attributes use ("silver", "blue"...), read for
/// the table's own keys only (`ownValue`).
fn vml_named_color(name: &str) -> Option<&'static str> {
    Some(match name {
        "black" => "000000",
        "white" => "FFFFFF",
        "red" => "FF0000",
        "green" => "008000",
        "blue" => "0000FF",
        "yellow" => "FFFF00",
        "silver" => "C0C0C0",
        "gray" | "grey" => "808080",
        "maroon" => "800000",
        "olive" => "808000",
        "navy" => "000080",
        "purple" => "800080",
        "teal" => "008080",
        "fuchsia" => "FF00FF",
        "lime" => "00FF00",
        "aqua" | "cyan" => "00FFFF",
        "orange" => "FFA500",
        _ => return None,
    })
}

/// VML colour attribute ("#dbe5f1", "#aaa", "#dbe5f1 [3204]", "silver") as
/// hex without '#'.
pub fn vml_color_hex(value: Option<&str>) -> Option<String> {
    let v = trim(truthy(value)?);
    if let Some(found) = js_regex!(r"^#?([0-9a-fA-F]{6})").exec(v) {
        return found.get(1).map(str::to_owned);
    }
    if let Some(found) = js_regex!(r"^#([0-9a-fA-F]{3})(?![0-9a-fA-F])").exec(v) {
        return found.get(1).map(|short| {
            short
                .chars()
                .flat_map(|digit| [digit, digit])
                .collect::<String>()
        });
    }
    // v.split(/[\s[]/, 1)[0]: the text before the first separator
    let name = js_regex!(r"[\s\[]")
        .exec(v)
        .map_or(v, |separator| &v[..separator.start()]);
    vml_named_color(&name.to_lowercase()).map(str::to_owned)
}
