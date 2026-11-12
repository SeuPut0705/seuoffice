//! The text boxes of headers, footers and notes: placement of a `wp:anchor`
//! or an absolutely positioned VML shape, text insets, and the paragraphs
//! nested in a textbox.

use std::sync::atomic::{AtomicU64, Ordering};

use jscompat::{JsMatch, JsNum, Radix, js_regex, parse_int};
use ooxml_xml::{XNode, serialize};

use super::picture::{read_anchor_pos, read_body_pr};
use super::vml::{vml_flag_off, vml_length_px, vml_stroke_child_off, vml_stroke_weight_px};
use crate::model::{HfImagePosH, HfImagePosHRel, HfImagePosV, HfImagePosVRel, HfImageWrap};
use crate::model::{HfParagraph, HfTextBox};
use crate::package::Thrown;
use crate::parse::text::{BuildContext, emu_to_px, extract_para_format, extract_runs_plain};
use crate::vml::{anchor_rel_h, anchor_rel_v, vml_color_hex, vml_rotation_deg};
use jscompat::math_round;

/// `hfTextBoxSeq`: module state of the TypeScript, counted over every parse
/// of the process.
static HF_TEXT_BOX_SEQ: AtomicU64 = AtomicU64::new(0);

/// `++hfTextBoxSeq`
fn next_text_box_id() -> JsNum {
    JsNum((HF_TEXT_BOX_SEQ.fetch_add(1, Ordering::Relaxed) + 1) as f64)
}

/// `TEXTBOX_INSETS_PX`: Word's textbox text insets (0.1in / 0.05in) when the
/// shape declares none.
const TEXTBOX_INSETS_PX: [f64; 4] = [9.6, 4.8, 9.6, 4.8];

fn capture<'t>(found: Option<JsMatch<'t>>) -> Option<&'t str> {
    found.and_then(|found| found.get(1))
}

/// `HfImage['posHRel']` of `anchorRelH`
fn hf_rel_h(rel: Option<&str>) -> HfImagePosHRel {
    match anchor_rel_h(rel) {
        "page" => HfImagePosHRel::Page,
        "leftMargin" => HfImagePosHRel::LeftMargin,
        "rightMargin" => HfImagePosHRel::RightMargin,
        _ => HfImagePosHRel::Margin,
    }
}

/// `HfImage['posVRel']` of `anchorRelV`
fn hf_rel_v(rel: Option<&str>) -> HfImagePosVRel {
    match anchor_rel_v(rel) {
        "page" => HfImagePosVRel::Page,
        "paragraph" => HfImagePosVRel::Paragraph,
        "topMargin" => HfImagePosVRel::TopMargin,
        "bottomMargin" => HfImagePosVRel::BottomMargin,
        _ => HfImagePosVRel::Margin,
    }
}

/// `hfTextBoxOfAnchor`: placement of a header/footer textbox from its
/// wp:anchor.
pub fn hf_text_box_of_anchor(anchor: &XNode) -> HfTextBox {
    let mut r#box = HfTextBox::default();
    r#box.id.set(next_text_box_id());
    if matches!(anchor.attr("behindDoc"), Some("1" | "true")) {
        r#box.behind.set(true);
    }
    let ext = anchor.find_child("wp:extent");
    let cx = parse_int(ext.and_then(|ext| ext.attr("cx")).unwrap_or(""), Radix::Ten);
    let cy = parse_int(ext.and_then(|ext| ext.attr("cy")).unwrap_or(""), Radix::Ten);
    if cx > 0.0 {
        r#box
            .width_px
            .set(JsNum(math_round(cx / super::EMU_PER_PX)));
    }
    if cy > 0.0 {
        r#box
            .height_px
            .set(JsNum(math_round(cy / super::EMU_PER_PX)));
    }
    // the shape's own spPr carries the display transform and outline: the
    // rotation and stroke the strip renderer draws (Word turns header shapes
    // like body ones, a rotated banner must not read as a straight one)
    let wsp = anchor
        .find_child("a:graphic")
        .and_then(|graphic| graphic.find_child("a:graphicData"))
        .and_then(|data| data.find_child("wps:wsp"));
    if let Some(sp_pr) = wsp.and_then(|wsp| wsp.find_child("wps:spPr")) {
        let rot = parse_int(
            sp_pr
                .find_child("a:xfrm")
                .and_then(|xfrm| xfrm.attr("rot"))
                .unwrap_or(""),
            Radix::Ten,
        );
        if rot.is_finite() && rot != 0.0 {
            r#box.rot_deg.set(JsNum(math_round(rot / 60000.0)));
        }
        let ln = sp_pr.find_child("a:ln");
        let ln_w = parse_int(ln.and_then(|ln| ln.attr("w")).unwrap_or(""), Radix::Ten);
        if ln_w.is_finite() && ln_w > 0.0 {
            r#box.border_width_px.set(JsNum(emu_to_px(ln_w)));
        }
        let stroke = ln
            .and_then(|ln| ln.find_child("a:solidFill"))
            .and_then(|fill| fill.find_child("a:srgbClr"))
            .and_then(|color| color.attr("val"));
        if let Some(stroke) = stroke.filter(|stroke| !stroke.is_empty()) {
            r#box.border_color.set(stroke.to_owned());
        }
    }
    for child in anchor.children() {
        let wrap = child
            .name()
            .and_then(|name| name.strip_prefix("wp:wrap"))
            .and_then(|kind| match kind {
                "None" => Some(HfImageWrap::None),
                "Square" => Some(HfImageWrap::Square),
                "Tight" => Some(HfImageWrap::Tight),
                "Through" => Some(HfImageWrap::Through),
                "TopAndBottom" => Some(HfImageWrap::TopBottom),
                _ => None,
            });
        if let Some(wrap) = wrap {
            r#box.wrap.set(wrap);
        }
    }
    read_anchor_pos(&serialize(anchor), &mut r#box);
    r#box
}

/// `hfTextBoxOfVml`: placement of a header/footer textbox from an absolutely
/// positioned VML shape's style.
pub fn hf_text_box_of_vml(shape: &XNode) -> Result<HfTextBox, Thrown> {
    let mut r#box = HfTextBox::default();
    r#box.id.set(next_text_box_id());
    let style = shape.attr("style").unwrap_or("");
    // `vmlLengthPx(new RegExp(`(?:^|;)\s*${prop}:([^;]+)`).exec(style)?.[1])`
    // rounded to whole px
    let px = |pattern: &jscompat::JsRegex| -> Option<f64> {
        let v = vml_length_px(capture(pattern.exec(style)))?;
        Some(math_round(v))
    };
    let w = px(js_regex!(r"(?:^|;)\s*width:([^;]+)"));
    let h = px(js_regex!(r"(?:^|;)\s*height:([^;]+)"));
    if let Some(w) = w.filter(|w| *w > 0.0) {
        r#box.width_px.set(JsNum(w));
    }
    if let Some(h) = h.filter(|h| *h > 0.0) {
        r#box.height_px.set(JsNum(h));
    }
    if js_regex!(r"z-index:\s*-").test(style) {
        r#box.behind.set(true);
    }
    let pos_h = capture(js_regex!(r"mso-position-horizontal:(\w+)").exec(style));
    let pos_v = capture(js_regex!(r"mso-position-vertical:(\w+)").exec(style));
    let rel_h = capture(js_regex!(r"mso-position-horizontal-relative:([\w-]+)").exec(style));
    let rel_v = capture(js_regex!(r"mso-position-vertical-relative:([\w-]+)").exec(style));
    let x = px(js_regex!(r"(?:^|;)\s*margin-left:([^;]+)"));
    let y = px(js_regex!(r"(?:^|;)\s*margin-top:([^;]+)"));
    match pos_h {
        Some("left") => r#box.pos_h.set(HfImagePosH::Left),
        Some("center") => r#box.pos_h.set(HfImagePosH::Center),
        Some("right") => r#box.pos_h.set(HfImagePosH::Right),
        _ => {
            if let Some(x) = x {
                r#box.pos_x_px.set(JsNum(x));
                r#box.pos_h_rel.set(hf_rel_h(rel_h));
            }
        }
    }
    match pos_v {
        Some("top") => r#box.pos_v.set(HfImagePosV::Top),
        Some("center") => r#box.pos_v.set(HfImagePosV::Center),
        Some("bottom") => r#box.pos_v.set(HfImagePosV::Bottom),
        _ => {
            if let Some(y) = y {
                r#box.pos_y_px.set(JsNum(y));
                r#box.pos_v_rel.set(if rel_v == Some("margin") {
                    HfImagePosVRel::Margin
                } else {
                    hf_rel_v(Some(rel_v.unwrap_or("text")))
                });
            }
        }
    }
    match shape
        .find_child("w10:wrap")
        .and_then(|wrap| wrap.attr("type"))
    {
        Some("none") => r#box.wrap.set(HfImageWrap::None),
        Some("square") => r#box.wrap.set(HfImageWrap::Square),
        Some("tight") => r#box.wrap.set(HfImageWrap::Tight),
        Some("through") => r#box.wrap.set(HfImageWrap::Through),
        Some("topAndBottom") => r#box.wrap.set(HfImageWrap::TopBottom),
        _ => {}
    }
    // the VML shape's own style carries the same display transform and stroke
    // as a DrawingML spPr (legacy .doc conversions rotate banners this way);
    // the shared helper normalizes the negative / 360+ and 1/65536-degree forms
    if let Some(rot) = vml_rotation_deg(style) {
        r#box.rot_deg.set(JsNum(rot));
    }
    // stroke lives on the shape's attributes (style-attribute stroke props are a
    // form Word does not write), gated like the body path: VML strokes default
    // to on/black unless stroked="f" or a v:stroke child switches them off
    if !vml_flag_off(shape.attr("stroked")) && !vml_stroke_child_off(shape) {
        r#box
            .border_color
            .set(vml_color_hex(shape.attr("strokecolor")).unwrap_or_else(|| "000000".to_owned()));
        if let Some(weight) = vml_stroke_weight_px(shape.attr("strokeweight")) {
            r#box.border_width_px.set(JsNum(weight));
        }
    }
    Ok(r#box)
}

/// `readVmlInset`: v:textbox inset="l,t,r,b" (pt / in / unitless pt; missing
/// entries keep Word's defaults).
pub fn read_vml_inset(textbox: &XNode, r#box: &mut HfTextBox) {
    if js_regex!(r"mso-fit-shape-to-text:\s*t").test(textbox.attr("style").unwrap_or("")) {
        r#box.autofit.set(true);
    }
    let Some(raw) = textbox.attr("inset").filter(|raw| !raw.is_empty()) else {
        return;
    };
    let parts: Vec<&str> = raw.split(',').collect();
    let inset =
        |index: usize| vml_length_px(parts.get(index).copied()).unwrap_or(TEXTBOX_INSETS_PX[index]);
    r#box.insets.set((
        JsNum(inset(0)),
        JsNum(inset(1)),
        JsNum(inset(2)),
        JsNum(inset(3)),
    ));
}

/// `textboxParagraphs`: the text paragraphs nested inside textbox shapes (VML
/// v:textbox / DrawingML wps:txbx, both holding a w:txbxContent).
///
/// A paragraph holds the box object of its shape, and `readBodyPr` /
/// `readVmlInset` write into that object after the paragraphs of the shape
/// were read (wps:bodyPr follows wps:txbx), so the boxes live in an arena and
/// every paragraph takes the state its box ends in.
pub fn textbox_paragraphs(
    p_node: &XNode,
    ctx: &BuildContext<'_>,
) -> Result<Vec<HfParagraph>, Thrown> {
    let mut boxes: Vec<HfTextBox> = Vec::new();
    let mut found: Vec<(HfParagraph, Option<usize>)> = Vec::new();
    walk(p_node, None, ctx, &mut boxes, &mut found)?;
    Ok(found
        .into_iter()
        .map(|(mut para, at)| {
            if let Some(at) = at {
                para.r#box.set(boxes[at].clone());
            }
            para
        })
        .collect())
}

fn walk(
    node: &XNode,
    r#box: Option<usize>,
    ctx: &BuildContext<'_>,
    boxes: &mut Vec<HfTextBox>,
    out: &mut Vec<(HfParagraph, Option<usize>)>,
) -> Result<(), Thrown> {
    let name = node.name();
    if name == Some("w:txbxContent") {
        for inner in node.find_children("w:p") {
            let runs = extract_runs_plain(inner, ctx, false)?;
            if runs.is_empty() {
                continue;
            }
            let p_pr = inner.find_child("w:pPr");
            // content of a floating box draws at the anchor, not in the strip
            // flow: it must not push the body down (Word), only display does
            let mut para = HfParagraph::default();
            if let Some(format) = p_pr
                .map(|p_pr| extract_para_format(p_pr, ctx.resolver.theme_colors.as_ref(), None))
                .transpose()?
                .flatten()
            {
                para.para_format.assign(&format);
            }
            para.runs.set(runs);
            if r#box.is_some() {
                // `box` itself is set once the box has its final state
                para.box_anchored.set(true);
            }
            out.push((para, r#box));
        }
        return Ok(());
    }
    let mut next = r#box;
    if name == Some("wp:anchor") {
        boxes.push(hf_text_box_of_anchor(node));
        next = Some(boxes.len() - 1);
    } else if name.is_some_and(|name| name.starts_with("v:"))
        && js_regex!(r"position:\s*absolute").test(node.attr("style").unwrap_or(""))
    {
        boxes.push(hf_text_box_of_vml(node)?);
        next = Some(boxes.len() - 1);
    } else if let Some(at) = r#box {
        if name == Some("wps:bodyPr") {
            read_body_pr(node, &mut boxes[at]);
        } else if name == Some("v:textbox") {
            read_vml_inset(node, &mut boxes[at]);
        }
    }
    for child in node.children() {
        walk(child, next, ctx, boxes, out)?;
    }
    Ok(())
}
