//! `lineBoxOf` of packages/docx-engine/src/parse-drawing-geometry.ts: a wps
//! line shape as a display-only line box (the synthetic prst carries the
//! arrow ends).

use jscompat::{JsNum, Radix, Slot, math_round, parse_int};
use ooxml_xml::XNode;

use super::anchor::LINE_PRSTS;
use super::fill::color_node_hex;
use crate::model::TextboxDisplay;
use crate::theme::ThemeColors;
use crate::xml_text::EMU_PER_PX;

/// `lineBoxOf(shape, theme)`
pub fn line_box_of(shape: &XNode, theme: Option<&ThemeColors>) -> Option<TextboxDisplay> {
    let sp_pr = shape.find_child("wps:spPr")?;
    let prst = sp_pr
        .find_child("a:prstGeom")
        .and_then(|geom| geom.attr("prst"));
    let prst = match prst {
        Some(prst) if !prst.is_empty() && LINE_PRSTS.contains(&prst) => prst,
        _ => return None,
    };
    let mut r#box = TextboxDisplay {
        paras: Slot::of(Vec::new()),
        read_only: Slot::of(true),
        ..TextboxDisplay::default()
    };
    let ln = sp_pr.find_child("a:ln");
    let border = ln
        .and_then(|ln| ln.find_child("a:solidFill"))
        .and_then(|fill| fill.find_child("a:srgbClr"))
        .and_then(|srgb| srgb.attr("val"))
        .map(str::to_owned)
        // theme-styled connectors (Word gallery): stroke from wps:style a:lnRef
        .or_else(|| {
            color_node_hex(
                shape
                    .find_child("wps:style")
                    .and_then(|style| style.find_child("a:lnRef")),
                theme,
            )
        });
    r#box
        .border_color
        .set(border.unwrap_or_else(|| "000000".to_owned()));
    let arrow_end = |name: &str| {
        let kind = ln
            .and_then(|ln| ln.find_child(name))
            .and_then(|end| end.attr("type"));
        matches!(kind, Some(kind) if !kind.is_empty() && kind != "none")
    };
    let head = arrow_end("a:headEnd");
    let tail = arrow_end("a:tailEnd");
    r#box.prst.set(
        if prst.starts_with("bentConnector") {
            "lineBent"
        } else if prst.starts_with("curvedConnector") {
            "lineCurved"
        } else if head && tail {
            "lineArrowDouble"
        } else if head || tail {
            "lineArrow"
        } else {
            "line"
        }
        .to_owned(),
    );
    let xfrm = sp_pr.find_child("a:xfrm");
    let xfrm_attr = |key: &str| xfrm.and_then(|xfrm| xfrm.attr(key));
    let ext = xfrm.and_then(|xfrm| xfrm.find_child("a:ext"));
    let cx = ext.map_or(f64::NAN, |ext| {
        parse_int(ext.attr("cx").unwrap_or(""), Radix::Ten)
    });
    let cy = ext.map_or(f64::NAN, |ext| {
        parse_int(ext.attr("cy").unwrap_or(""), Radix::Ten)
    });
    if cx.is_finite() && cx > 0.0 {
        r#box.width_px.set(JsNum(math_round(cx / EMU_PER_PX)));
    }
    let straight = matches!(
        r#box.prst.as_deref(),
        Some("line" | "lineArrow" | "lineArrowDouble")
    );
    // flips apply at any height: Word's horizontal lines carry cy="0", and a
    // flipH there still reverses which tip holds the arrow
    if straight {
        if matches!(xfrm_attr("flipH"), Some("1" | "true")) {
            r#box.flip_h.set(true);
        }
        if matches!(xfrm_attr("flipV"), Some("1" | "true")) {
            r#box.flip_v.set(true);
        }
    }
    // a:xfrm rot (60000ths of a degree) and a:ln w (EMU) round-trip on lines the
    // same way they do on text-bearing shapes
    let rot = parse_int(xfrm_attr("rot").unwrap_or(""), Radix::Ten);
    if rot.is_finite() && rot != 0.0 {
        r#box.rot_deg.set(JsNum(math_round(rot / 60000.0)));
    }
    let ln_w = parse_int(ln.map_or("", |ln| ln.attr("w").unwrap_or("")), Radix::Ten);
    if ln_w.is_finite() && ln_w > 0.0 {
        r#box
            .border_width_px
            .set(JsNum(math_round((ln_w / EMU_PER_PX) * 100.0) / 100.0));
    }
    if cy.is_finite() && cy > 0.0 {
        let height_px = math_round(cy / EMU_PER_PX);
        r#box.height_px.set(JsNum(height_px));
        r#box.min_height_px.set(JsNum(height_px));
        // a real vertical extent means the connector runs corner to corner
        // (12 px or less stays level: inserted lines keep a 12 px grab band)
        if straight
            && (height_px > 12.0 || *r#box.flip_h == Some(true) || *r#box.flip_v == Some(true))
        {
            r#box.line_diag.set(true);
        }
    } else {
        // zero-height extent = Word's horizontal line; keep a 12 px grab band
        r#box.height_px.set(JsNum(12.0));
    }
    // a:headEnd decorates the start point: a head-only arrow renders as the
    // reversed segment so the renderer's single arrowhead lands on the right tip
    if head && !tail && r#box.prst.as_deref() == Some("lineArrow") {
        let fh = *r#box.flip_h != Some(true);
        let fv = *r#box.flip_v != Some(true);
        r#box.flip_h.delete();
        r#box.flip_v.delete();
        if fh {
            r#box.flip_h.set(true);
        }
        if fv {
            r#box.flip_v.set(true);
        }
    }
    r#box.inset_top_px.set(JsNum(0.0));
    r#box.inset_right_px.set(JsNum(0.0));
    r#box.inset_bottom_px.set(JsNum(0.0));
    r#box.inset_left_px.set(JsNum(0.0));
    Some(r#box)
}
