//! `vmlWordArtBox` of packages/docx-engine/src/parse-vml.ts: v:textpath shapes
//! (shapetype 136 family) as plain styled text, without path warp or 3D.

use jscompat::{JsNum, Slot, js_regex, math_max, math_min, math_round, parse_float, trim, truthy};
use ooxml_xml::XNode;

use super::{Dim, vml_color_hex, vml_style_dim_px};
use crate::model::{ParaAlign, Run, TextboxDisplay, TextboxDisplayTextOutline, TextboxParaDisplay};
use crate::xml_text::EMU_PER_PX;

/// `if (n)` on a number.
fn num_truthy(n: Option<f64>) -> Option<f64> {
    n.filter(|n| *n != 0.0 && !n.is_nan())
}

/// `{ runs: [run], align: 'center' }`
fn centered_para(run: Run) -> TextboxParaDisplay {
    let mut para = TextboxParaDisplay {
        runs: vec![run],
        ..TextboxParaDisplay::default()
    };
    para.para_format.align.set(ParaAlign::Center);
    para
}

/// `vmlWordArtBox(shape)`
pub fn vml_word_art_box(shape: &XNode) -> Option<TextboxDisplay> {
    let tp = shape.find_child("v:textpath")?;
    let text = truthy(tp.attr("string"))?;
    if trim(text).is_empty() {
        return None;
    }
    let style = shape.attr("style").unwrap_or("");
    let mut r#box = TextboxDisplay {
        paras: Slot::of(Vec::new()),
        read_only: Slot::of(true),
        inset_top_px: Slot::of(JsNum(0.0)),
        inset_right_px: Slot::of(JsNum(0.0)),
        inset_bottom_px: Slot::of(JsNum(0.0)),
        inset_left_px: Slot::of(JsNum(0.0)),
        ..TextboxDisplay::default()
    };
    let w = num_truthy(vml_style_dim_px(style, Dim::Width));
    if let Some(w) = w {
        r#box.width_px.set(JsNum(w));
    }
    let h = num_truthy(vml_style_dim_px(style, Dim::Height));
    if let Some(h) = h {
        r#box.height_px.set(JsNum(h));
    }
    // floating WordArt keeps the flow like other absolute shapes
    if js_regex!(r"position:\s*absolute").test(style) {
        r#box.floating.set(true);
        let margin_px = |pt: f64| {
            if pt.is_finite() {
                (pt / 72.0) * 96.0
            } else {
                0.0
            }
        };
        let left = js_regex!(r"(?:^|;)\s*margin-left:(-?[\d.]+)pt").exec(style);
        let left = parse_float(left.as_ref().and_then(|m| m.get(1)).unwrap_or(""));
        r#box
            .offset_x_emu
            .set(JsNum(math_round(margin_px(left) * EMU_PER_PX)));
        let top = js_regex!(r"(?:^|;)\s*margin-top:(-?[\d.]+)pt").exec(style);
        let top = parse_float(top.as_ref().and_then(|m| m.get(1)).unwrap_or(""));
        r#box
            .offset_y_emu
            .set(JsNum(math_round(margin_px(top) * EMU_PER_PX)));
    }
    let tp_style = tp.attr("style").unwrap_or("");
    let family = js_regex!(r#"font-family:\s*"?([^;"]+)"?"#).exec(tp_style);
    let family = family.as_ref().and_then(|m| m.get(1)).map(trim);
    let size = js_regex!(r"font-size:\s*([\d.]+)pt").exec(tp_style);
    let size_pt = parse_float(size.as_ref().and_then(|m| m.get(1)).unwrap_or(""));
    // fill becomes the *text* color: fillcolor, else the v:fill color/color2
    let fill_node = shape.find_child("v:fill");
    let fill_attr = |key: &str| fill_node.and_then(|fill| fill.attr(key));
    let fill = if shape.attr("filled") == Some("f") {
        None
    } else {
        vml_color_hex(shape.attr("fillcolor"))
            .or_else(|| vml_color_hex(fill_attr("color")))
            .or_else(|| vml_color_hex(fill_attr("color2")))
    };
    if shape.attr("stroked") != Some("f") {
        let stroke_color =
            vml_color_hex(shape.attr("strokecolor")).unwrap_or_else(|| "000000".to_owned());
        let weight = js_regex!(r"^([\d.]+)(?:pt)?$").exec(shape.attr("strokeweight").unwrap_or(""));
        let weight_pt = parse_float(weight.as_ref().and_then(|m| m.get(1)).unwrap_or(""));
        r#box.text_outline.set(TextboxDisplayTextOutline {
            color_hex: stroke_color,
            width_px: JsNum(if weight_pt.is_finite() && weight_pt > 0.0 {
                math_round((weight_pt / 72.0) * 96.0 * 100.0) / 100.0
            } else {
                1.0
            }),
        });
    }
    let height_pt = h.map_or(f64::NAN, |h| (h / 96.0) * 72.0);
    let mut run = Run {
        text: Slot::of(text.to_owned()),
        ..Run::default()
    };
    // fitshape sizes the glyphs to the box; the declared font-size matches it in
    // practice (box height ~ font-size x line factor), so prefer the declared pt
    let mut pt = if size_pt.is_finite() && size_pt > 0.0 {
        size_pt
    } else if height_pt > 0.0 {
        height_pt / 1.4
    } else {
        f64::NAN
    };
    // fitpath compresses long strings into the box; approximate by shrinking the
    // font until the single line fits the declared width (~0.62 em per glyph)
    let width_pt = w.map_or(f64::NAN, |w| (w / 96.0) * 72.0);
    // text.length counts UTF-16 code units
    let length = text.encode_utf16().count() as f64;
    if pt.is_finite() && width_pt > 0.0 && length > 0.0 {
        pt = math_max(6.0, math_min(pt, width_pt / (0.62 * length)));
    }
    if pt.is_finite() && pt > 0.0 {
        run.size_half_points.set(JsNum(math_round(pt * 2.0)));
    }
    r#box.nowrap.set(true);
    if let Some(family) = truthy(family) {
        run.font_ascii.set(family.to_owned());
    }
    if let Some(fill) = fill.filter(|fill| !fill.is_empty()) {
        run.color.set(fill);
    }
    if js_regex!(r"font-weight:\s*bold").test(tp_style) {
        run.bold.set(true);
    }
    if js_regex!(r"font-style:\s*italic").test(tp_style) {
        run.italic.set(true);
    }
    // box.paras.push(...) on the empty array: the key keeps its place
    r#box.paras.set(vec![centered_para(run)]);
    Some(r#box)
}
