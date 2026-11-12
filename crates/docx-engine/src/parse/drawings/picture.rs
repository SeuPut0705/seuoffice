//! The DrawingML readers of parse.ts: anchor placement, textbox body
//! properties, picture crop, outline, transform and group layers, and the
//! vector decoration of a header/footer drawing.

use jscompat::{
    JsMap, JsNum, JsRegex, Radix, RegexError, RegexLimit, Slot, TryJsRegex, js_object, js_regex,
    math_max, math_round, number_to_string, parse_float, parse_int, to_number,
};
use ooxml_xml::XNode;
use pptx_engine::custgeom::parse_cust_geom;
use serde::Serialize;

use super::{EMU_PER_PT, EMU_PER_PX, EMU_PER_TWIP};
use crate::drawing_geometry::anchor::{IDENTITY_CTM, MIN_WRAP_SLIVER_EMU, compose_group_ctm};
use crate::model::{
    Block, HfImage, HfImagePosH, HfImagePosHRel, HfImagePosV, HfImagePosVRel, HfTextBox,
    HfTextBoxVAlign, ImageWrap, RunImageBorder, RunImageLayersItem, SectionSettings, SharedStr,
    TextboxParaDisplay,
};
use crate::parse::text::FloatTableAhead;
use crate::props::collect_nodes;
use crate::vml::shape::encode_uri_component;
use crate::vml::{anchor_rel_h, anchor_rel_v};

/// `alignedPictureXEmu`: the column-relative X (EMU) of a `wp:align`
/// positioned anchor (no posOffset): left/center/right (inside/outside read as
/// left/right) within the column, margin box or paper.
pub fn aligned_picture_x_emu(meta: &Block, xml: &str, sect: &SectionSettings) -> Option<f64> {
    let pos_h =
        js_regex!(r#"<wp:positionH[^>]*relativeFrom="([^"]+)"[^>]*>([\s\S]*?)<\/wp:positionH>"#)
            .exec(xml)?;
    let align = js_regex!(r"<wp:align>(\w+)<\/wp:align>")
        .exec(pos_h.get(2).unwrap_or(""))
        .and_then(|found| found.get(1))?;
    let width = meta.image_width_px.map_or(0.0, |width| width.0);
    if width == 0.0 || width.is_nan() {
        return None;
    }
    let col_w_emu = (sect.page_width.0 - sect.margin_left.0 - sect.margin_right.0) * EMU_PER_TWIP;
    let from_page = pos_h.get(1) == Some("page");
    let frame_x = if from_page {
        -sect.margin_left.0 * EMU_PER_TWIP
    } else {
        0.0
    };
    let frame_w = if from_page {
        sect.page_width.0 * EMU_PER_TWIP
    } else {
        col_w_emu
    };
    let pic_w = width * EMU_PER_PX;
    Some(match align {
        "center" => math_round(frame_x + (frame_w - pic_w) / 2.0),
        "right" | "outside" => math_round(frame_x + frame_w - pic_w),
        _ => frame_x,
    })
}

/// What `pictureColumnGeom` returns: the column-relative X extent (EMU) of a
/// side-wrapped anchored picture, and its text clearance.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PictureColumnGeom {
    pub x: JsNum,
    pub right: JsNum,
    pub dist_l: JsNum,
    pub dist_r: JsNum,
    #[serde(rename = "colWEmu")]
    pub col_w_emu: JsNum,
}

/// `pictureColumnGeom`: the column-relative X extent (EMU) of a side-wrapped
/// anchored picture in a single-column section.
pub fn picture_column_geom(
    meta: &Block,
    xml: &str,
    sect: Option<&SectionSettings>,
) -> Option<PictureColumnGeom> {
    let sect = sect?;
    if sect.columns.0 > 1.0 {
        return None;
    }
    if !matches!(
        *meta.image_wrap,
        Some(
            ImageWrap::SquareLeft
                | ImageWrap::SquareRight
                | ImageWrap::TightLeft
                | ImageWrap::TightRight
                | ImageWrap::ThroughLeft
                | ImageWrap::ThroughRight
        )
    ) {
        return None;
    }
    let width = meta.image_width_px.map_or(0.0, |width| width.0);
    if width == 0.0 || width.is_nan() {
        return None;
    }
    let col_w_emu = (sect.page_width.0 - sect.margin_left.0 - sect.margin_right.0) * EMU_PER_TWIP;
    let from_page = js_regex!(r#"<wp:positionH[^>]*relativeFrom="page""#).test(xml);
    let x = match *meta.image_offset_x_emu {
        Some(offset) => {
            offset.0
                - if from_page {
                    sect.margin_left.0 * EMU_PER_TWIP
                } else {
                    0.0
                }
        }
        None => aligned_picture_x_emu(meta, xml, sect)?,
    };
    // a quarter-turned picture wraps around its turned bounding box (Word turns
    // the extent about its centre), not the wp:extent
    let height = meta.image_height_px.map_or(0.0, |height| height.0);
    let turned = height != 0.0
        && !height.is_nan()
        && meta.image_rot_deg.map_or(0.0, |rot| rot.0) % 180.0 == 90.0;
    let bbox_w = if turned { height } else { width };
    let inset = if turned {
        ((width - height) / 2.0) * EMU_PER_PX
    } else {
        0.0
    };
    Some(PictureColumnGeom {
        x: JsNum(x + inset),
        right: JsNum(x + inset + bbox_w * EMU_PER_PX),
        dist_l: JsNum(meta.image_wrap_dist_left_emu.map_or(0.0, |dist| dist.0)),
        dist_r: JsNum(meta.image_wrap_dist_right_emu.map_or(0.0, |dist| dist.0)),
        col_w_emu: JsNum(col_w_emu),
    })
}

/// `pictureBesideFloatTable`: a side-wrapped picture sharing its anchor
/// paragraph's column with a floating table, when the widest remaining gap is
/// a sliver no text fits beside them, so Word resumes the text below both.
pub fn picture_beside_float_table(
    meta: &Block,
    xml: &str,
    table: &FloatTableAhead,
    sect: Option<&SectionSettings>,
) -> bool {
    let Some(geo) = picture_column_geom(meta, xml, sect) else {
        return false;
    };
    let picture = [geo.x.0 - geo.dist_l.0, geo.right.0 + geo.dist_r.0];
    let tbl = [
        table.left_twips.0 * EMU_PER_TWIP,
        table.right_twips.0 * EMU_PER_TWIP,
    ];
    // `.sort((a, b) => a[0] - b[0])`: a NaN difference leaves the order
    let spans = if tbl[0] - picture[0] > 0.0 {
        [picture, tbl]
    } else {
        [tbl, picture]
    };
    let mut gap = 0.0;
    let mut cursor = 0.0;
    for [a, b] in spans {
        gap = math_max(gap, a - cursor);
        cursor = math_max(cursor, b);
    }
    math_max(gap, geo.col_w_emu.0 - cursor) < MIN_WRAP_SLIVER_EMU
}

/// `pictureOverhangsColumn`: a picture reaching past a column edge with no
/// text room left beside it (cover art pinned to the paper); a CSS float
/// would cap it at the column, so it takes the band route and keeps its
/// extent.
pub fn picture_overhangs_column(meta: &Block, xml: &str, sect: Option<&SectionSettings>) -> bool {
    let Some(geo) = picture_column_geom(meta, xml, sect) else {
        return false;
    };
    if geo.x.0 >= 0.0 && geo.right.0 <= geo.col_w_emu.0 {
        return false;
    }
    math_max(
        geo.x.0 - geo.dist_l.0,
        geo.col_w_emu.0 - geo.right.0 - geo.dist_r.0,
    ) < MIN_WRAP_SLIVER_EMU
}

/// `txbxParaVisible`: a paragraph the box shows, text runs or a table row.
pub fn txbx_para_visible(p: &TextboxParaDisplay) -> bool {
    p.runs.as_ref().is_some_and(|runs| !runs.is_empty()) || p.cells.as_ref().map_or(0, Vec::len) > 0
}

js_object! {
    deserialize;
    /// `Pick<HfImage, 'posH' | 'posV' | 'posXPx' | 'posYPx' | 'posHRel' | 'posVRel'>`
    #[derive(Debug, Clone, PartialEq)]
    pub struct AnchorPos {
        pub pos_h: HfImagePosH,
        pub pos_v: HfImagePosV,
        pub pos_x_px: JsNum,
        pub pos_y_px: JsNum,
        pub pos_h_rel: HfImagePosHRel,
        pub pos_v_rel: HfImagePosVRel,
    }
}

/// The anchor keys of an object `readAnchorPos` writes.
pub struct AnchorPosSlots<'a> {
    pub pos_h: &'a mut Slot<HfImagePosH>,
    pub pos_v: &'a mut Slot<HfImagePosV>,
    pub pos_x_px: &'a mut Slot<JsNum>,
    pub pos_y_px: &'a mut Slot<JsNum>,
    pub pos_h_rel: &'a mut Slot<HfImagePosHRel>,
    pub pos_v_rel: &'a mut Slot<HfImagePosVRel>,
}

/// An object with the anchor keys of `HfImage`.
pub trait AnchorPosTarget {
    fn anchor_pos(&mut self) -> AnchorPosSlots<'_>;
}

macro_rules! anchor_pos_target {
    ($($target:ty),*) => {$(
        impl AnchorPosTarget for $target {
            fn anchor_pos(&mut self) -> AnchorPosSlots<'_> {
                AnchorPosSlots {
                    pos_h: &mut self.pos_h,
                    pos_v: &mut self.pos_v,
                    pos_x_px: &mut self.pos_x_px,
                    pos_y_px: &mut self.pos_y_px,
                    pos_h_rel: &mut self.pos_h_rel,
                    pos_v_rel: &mut self.pos_v_rel,
                }
            }
        }
    )*};
}
anchor_pos_target!(AnchorPos, HfImage, HfTextBox);

/// `anchorRelH` as the model's value.
fn rel_h(rel: &str) -> HfImagePosHRel {
    match anchor_rel_h(Some(rel)) {
        "page" => HfImagePosHRel::Page,
        "leftMargin" => HfImagePosHRel::LeftMargin,
        "rightMargin" => HfImagePosHRel::RightMargin,
        _ => HfImagePosHRel::Margin,
    }
}

/// `anchorRelV` as the model's value.
fn rel_v(rel: &str) -> HfImagePosVRel {
    match anchor_rel_v(Some(rel)) {
        "page" => HfImagePosVRel::Page,
        "paragraph" => HfImagePosVRel::Paragraph,
        "topMargin" => HfImagePosVRel::TopMargin,
        "bottomMargin" => HfImagePosVRel::BottomMargin,
        _ => HfImagePosVRel::Margin,
    }
}

/// `readAnchorPos`: wp:anchor wp:positionH/V of a header/footer image.
/// wp:align keeps the alignment fields, wp:posOffset (EMU) becomes a px
/// offset from the band `anchorRelH`/`anchorRelV` name.
pub fn read_anchor_pos(frag: &str, image: &mut impl AnchorPosTarget) {
    let image = image.anchor_pos();
    for horizontal in [true, false] {
        let position = if horizontal {
            js_regex!(r#"<wp:positionH[^>]*relativeFrom="([^"]+)"[^>]*>([\s\S]*?)</wp:positionH>"#)
        } else {
            js_regex!(r#"<wp:positionV[^>]*relativeFrom="([^"]+)"[^>]*>([\s\S]*?)</wp:positionV>"#)
        };
        let Some(m) = position.exec(frag) else {
            continue;
        };
        let relative_from = m.get(1).unwrap_or("");
        let inner = m.get(2).unwrap_or("");
        let align = js_regex!(r"<wp:align>(\w+)<\/wp:align>")
            .exec(inner)
            .and_then(|found| found.get(1));
        let offset = js_regex!(r"<wp:posOffset>(-?\d+)<\/wp:posOffset>")
            .exec(inner)
            .and_then(|found| found.get(1));
        if let Some(align) = align {
            if horizontal {
                let pos_h = match align {
                    "left" => Some(HfImagePosH::Left),
                    "center" => Some(HfImagePosH::Center),
                    "right" => Some(HfImagePosH::Right),
                    _ => None,
                };
                if let Some(pos_h) = pos_h {
                    image.pos_h.set(pos_h);
                    image.pos_h_rel.set(rel_h(relative_from));
                }
            } else {
                let pos_v = match align {
                    "top" => Some(HfImagePosV::Top),
                    "center" => Some(HfImagePosV::Center),
                    "bottom" => Some(HfImagePosV::Bottom),
                    _ => None,
                };
                if let Some(pos_v) = pos_v {
                    image.pos_v.set(pos_v);
                    image.pos_v_rel.set(rel_v(relative_from));
                }
            }
        } else if let Some(offset) = offset {
            let px = JsNum(math_round(to_number(offset) / EMU_PER_PX));
            if horizontal {
                image.pos_x_px.set(px);
                image.pos_h_rel.set(rel_h(relative_from));
            } else {
                image.pos_y_px.set(px);
                image.pos_v_rel.set(rel_v(relative_from));
            }
        }
    }
}

/// `readBodyPr`: wps:bodyPr insets (EMU) and vertical anchor of a DrawingML
/// textbox.
pub fn read_body_pr(body_pr: &XNode, box_: &mut HfTextBox) {
    let ins = |name: &str, dflt: f64| {
        let v = parse_int(body_pr.attr(name).unwrap_or(""), Radix::Ten);
        JsNum(math_round((if v.is_finite() { v } else { dflt } / EMU_PER_PX) * 100.0) / 100.0)
    };
    box_.insets.set((
        ins("lIns", 91440.0),
        ins("tIns", 45720.0),
        ins("rIns", 91440.0),
        ins("bIns", 45720.0),
    ));
    match body_pr.attr("anchor") {
        Some("ctr") => box_.v_align.set(HfTextBoxVAlign::Center),
        Some("b") => box_.v_align.set(HfTextBoxVAlign::Bottom),
        _ => {}
    }
    if body_pr.attr("wrap") == Some("none") {
        box_.nowrap.set(true);
    }
    if body_pr.find_child("a:spAutoFit").is_some() {
        box_.autofit.set(true);
    }
}

/// `rectFrac`: an a:srcRect / a:fillRect attribute (1000ths of a percent;
/// some writers emit decimals) as a fraction. `name` goes into the pattern
/// unescaped, as in the original.
pub fn rect_frac(tag: &str, name: &str) -> Result<f64, RegexError> {
    let pattern = TryJsRegex::new(&format!(r#"\b{name}="(-?[\d.]+)""#), "")?;
    let v = parse_float(
        pattern
            .try_exec(tag)?
            .and_then(|found| found.get(1))
            .unwrap_or(""),
    );
    Ok(if v.is_finite() { v / 100000.0 } else { 0.0 })
}

/// `picBorderOf`: the picture outline (an a:ln with a solid fill on the pic's
/// own spPr). A theme-coloured outline is left out.
pub fn pic_border_of(xml: &str) -> Option<RunImageBorder> {
    let pic_sp_pr = js_regex!(r"<pic:spPr[^>]*>([\s\S]*?)<\/pic:spPr>")
        .exec(xml)
        .and_then(|found| found.get(1))
        .filter(|sp_pr| !sp_pr.is_empty())?;
    let pic_ln = js_regex!(r"<a:ln\b[^>]*>[\s\S]*?<\/a:ln>")
        .exec(pic_sp_pr)?
        .as_str();
    if js_regex!(r"<a:noFill\s*\/>").test(pic_ln) {
        return None;
    }
    let color = js_regex!(r#"<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})""#)
        .exec(pic_ln)
        .and_then(|found| found.get(1))?;
    let w = parse_int(
        js_regex!(r#"<a:ln\b[^>]*\bw="(\d+)""#)
            .exec(pic_ln)
            .and_then(|found| found.get(1))
            .unwrap_or(""),
        Radix::Ten,
    );
    // DrawingML's default stroke width is 0.75pt (9525 EMU)
    Some(RunImageBorder {
        color: color.to_ascii_uppercase(),
        width_pt: JsNum(if w.is_finite() && w > 0.0 {
            w / EMU_PER_PT
        } else {
            0.75
        }),
    })
}

/// `first` of `groupPictureLayers`: the first node named `name` at or below
/// `root`, in document order.
fn first_node<'a>(root: &'a XNode, name: &str) -> Option<&'a XNode> {
    let mut found = Vec::new();
    collect_nodes(std::slice::from_ref(root), name, &mut found);
    found.first().copied()
}

/// `groupPictureLayers`: a wpg group made only of pictures, each mapped
/// through the group transform into fractions of the wp:extent box, bottom
/// first. `None` (null) for a group with shapes, nesting or turned pictures.
pub fn group_picture_layers(
    drawing: &XNode,
    media_by_rid: &JsMap<SharedStr>,
) -> Option<Vec<RunImageLayersItem>> {
    let group = first_node(drawing, "wpg:wgp")?;
    let mut pics = Vec::new();
    collect_nodes(std::slice::from_ref(group), "pic:pic", &mut pics);
    if pics.len() < 2
        || first_node(group, "wps:wsp").is_some()
        || first_node(group, "wpg:grpSp").is_some()
    {
        return None;
    }
    let extent = first_node(drawing, "wp:extent");
    let int_attr = |node: Option<&XNode>, key: &str| {
        parse_int(
            node.and_then(|node| node.attr(key)).unwrap_or(""),
            Radix::Ten,
        )
    };
    let ext_cx = int_attr(extent, "cx");
    let ext_cy = int_attr(extent, "cy");
    if ext_cx.is_nan() || ext_cx <= 0.0 || ext_cy.is_nan() || ext_cy <= 0.0 {
        return None;
    }
    let ctm = compose_group_ctm(group, &IDENTITY_CTM)?;
    let frac = |v: f64| JsNum(math_round(v * 10000.0) / 10000.0);
    let or_zero = |v: f64| if v.is_nan() || v == 0.0 { 0.0 } else { v };
    let mut layers = Vec::new();
    for pic in pics {
        let blip = pic
            .find_child("pic:blipFill")
            .and_then(|fill| fill.find_child("a:blip"));
        let r_id = blip
            .and_then(|blip| blip.attr("r:embed"))
            .or_else(|| blip.and_then(|blip| blip.attr("r:link")));
        let data_url = r_id
            .filter(|r_id| !r_id.is_empty())
            .and_then(|r_id| media_by_rid.get(r_id))
            .filter(|data_url| !data_url.is_empty())?;
        let xfrm = pic
            .find_child("pic:spPr")
            .and_then(|sp_pr| sp_pr.find_child("a:xfrm"));
        let truthy_attr = |key: &str| {
            xfrm.and_then(|xfrm| xfrm.attr(key))
                .is_some_and(|v| !v.is_empty())
        };
        if or_zero(int_attr(xfrm, "rot")) != 0.0 || truthy_attr("flipH") || truthy_attr("flipV") {
            return None;
        }
        let off = xfrm.and_then(|xfrm| xfrm.find_child("a:off"));
        let ext = xfrm.and_then(|xfrm| xfrm.find_child("a:ext"));
        let cx = int_attr(ext, "cx");
        let cy = int_attr(ext, "cy");
        if cx.is_nan() || cx <= 0.0 || cy.is_nan() || cy <= 0.0 {
            return None;
        }
        layers.push(RunImageLayersItem {
            data_url: data_url.clone(),
            x: frac((ctm.tx.0 + or_zero(int_attr(off, "x")) * ctm.sx.0) / ext_cx),
            y: frac((ctm.ty.0 + or_zero(int_attr(off, "y")) * ctm.sy.0) / ext_cy),
            w: frac((cx * ctm.sx.0) / ext_cx),
            h: frac((cy * ctm.sy.0) / ext_cy),
        });
    }
    Some(layers)
}

/// What `picTransformOf` returns.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PicTransform {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rot_deg: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flip_h: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flip_v: Option<bool>,
}

/// `picTransformOf`: rotation and flips on the pic's own xfrm (an anchored
/// textbox sibling has its own wps xfrm).
pub fn pic_transform_of(xml: &str) -> PicTransform {
    let mut out = PicTransform::default();
    let Some(pic_xfrm) = js_regex!(r"<pic:spPr[^>]*>[\s\S]*?<a:xfrm([^>]*)>")
        .exec(xml)
        .and_then(|found| found.get(1))
        .filter(|xfrm| !xfrm.is_empty())
    else {
        return out;
    };
    let rot = parse_int(
        js_regex!(r#"\brot="(-?\d+)""#)
            .exec(pic_xfrm)
            .and_then(|found| found.get(1))
            .unwrap_or(""),
        Radix::Ten,
    );
    if rot.is_finite() && rot != 0.0 {
        out.rot_deg = Some(JsNum(((math_round(rot / 60000.0) % 360.0) + 360.0) % 360.0));
    }
    if js_regex!(r#"\bflipH="(?:1|true)""#).test(pic_xfrm) {
        out.flip_h = Some(true);
    }
    if js_regex!(r#"\bflipV="(?:1|true)""#).test(pic_xfrm) {
        out.flip_v = Some(true);
    }
    out
}

/// The attributes `attrNum` of `hfShapeDrawingSvg` reads.
#[derive(Clone, Copy)]
enum NumAttr {
    Cx,
    Cy,
    X,
    Y,
    W,
}

/// `attrNum(tag, key)` of `hfShapeDrawingSvg`: `${key}="(-?\d+)"`, with no
/// word boundary before the key, as in the original.
fn attr_num(tag: &str, key: NumAttr) -> Option<f64> {
    let pattern = match key {
        NumAttr::Cx => js_regex!(r#"cx="(-?\d+)""#),
        NumAttr::Cy => js_regex!(r#"cy="(-?\d+)""#),
        NumAttr::X => js_regex!(r#"x="(-?\d+)""#),
        NumAttr::Y => js_regex!(r#"y="(-?\d+)""#),
        NumAttr::W => js_regex!(r#"w="(-?\d+)""#),
    };
    let v = pattern.exec(tag)?.get(1)?;
    Some(parse_int(v, Radix::Ten))
}

/// `px` of `hfShapeDrawingSvg`: EMU as px rounded to 1/100.
fn emu_px(emu: f64) -> f64 {
    math_round((emu / EMU_PER_PX) * 100.0) / 100.0
}

/// `placePath` of `hfShapeDrawingSvg`: normalized 0..1 path tokens as a px
/// path inside the shape's rect.
fn place_path(d: &str, x: f64, y: f64, w: f64, h: f64) -> String {
    let mut axis = 0u64;
    d.split(' ')
        .map(|tok| {
            let n = to_number(tok);
            if !n.is_finite() {
                axis = 0;
                return tok.to_owned();
            }
            let even = axis.is_multiple_of(2);
            axis += 1;
            number_to_string(if even {
                math_round((x + n * w) * 100.0) / 100.0
            } else {
                math_round((y + n * h) * 100.0) / 100.0
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `hfShapeDrawingSvg`: textless vector decoration in a header/footer drawing
/// (a wpg group of solid-fill custGeom wps shapes) composed into one SVG data
/// URL at the wp:extent size. `None` (null) on any piece it cannot draw:
/// rotation, flips, text, a missing fill or geometry.
pub fn hf_shape_drawing_svg(frag: &str) -> Result<Option<String>, RegexLimit> {
    if !frag.contains("<wps:wsp") || frag.contains("<w:txbxContent") {
        return Ok(None);
    }
    // Word pairs DrawingML shapes with a VML twin in mc:Fallback
    let body = js_regex!(r"<mc:Fallback[^>]*>[\s\S]*?<\/mc:Fallback>")
        .replace_all(frag, |_| String::new());
    let whole = |pattern: &JsRegex, text: &str| {
        pattern
            .exec(text)
            .map_or_else(String::new, |found| found.as_str().to_owned())
    };
    let extent = whole(js_regex!(r"<wp:extent[^>]*\/?>"), &body);
    let ext_cx = attr_num(&extent, NumAttr::Cx).unwrap_or(0.0);
    let ext_cy = attr_num(&extent, NumAttr::Cy).unwrap_or(0.0);
    if ext_cx <= 0.0 || ext_cy <= 0.0 {
        return Ok(None);
    }
    if js_regex!(r#"rot="-?[1-9]|flipH="(?:1|true)"|flipV="(?:1|true)""#).test(&body) {
        return Ok(None);
    }
    // group child space -> drawing space (wpg:grpSpPr a:xfrm)
    let (mut sx, mut sy, mut tx, mut ty) = (1.0, 1.0, 0.0, 0.0);
    let grp_xfrm = js_regex!(r"<wpg:grpSpPr[^>]*>[\s\S]*?<a:xfrm[^>]*>([\s\S]*?)<\/a:xfrm>")
        .exec(&body)
        .and_then(|found| found.get(1))
        .filter(|xfrm| !xfrm.is_empty());
    if let Some(grp_xfrm) = grp_xfrm {
        let ext = whole(js_regex!(r"<a:ext[^>]*/>"), grp_xfrm);
        let ch_ext = whole(js_regex!(r"<a:chExt[^>]*/>"), grp_xfrm);
        let off = whole(js_regex!(r"<a:off[^>]*/>"), grp_xfrm);
        let ch_off = whole(js_regex!(r"<a:chOff[^>]*/>"), grp_xfrm);
        let num = |tag: &str, key| attr_num(tag, key).unwrap_or(0.0);
        let (ext_x, ext_y) = (num(&ext, NumAttr::Cx), num(&ext, NumAttr::Cy));
        let (ch_ext_x, ch_ext_y) = (num(&ch_ext, NumAttr::Cx), num(&ch_ext, NumAttr::Cy));
        sx = if ext_x > 0.0 && ch_ext_x > 0.0 {
            ext_x / ch_ext_x
        } else {
            1.0
        };
        sy = if ext_y > 0.0 && ch_ext_y > 0.0 {
            ext_y / ch_ext_y
        } else {
            1.0
        };
        tx = num(&off, NumAttr::X) - num(&ch_off, NumAttr::X) * sx;
        ty = num(&off, NumAttr::Y) - num(&ch_off, NumAttr::Y) * sy;
    }
    let solid_fill = js_regex!(r#"<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})""#);
    let mut paths = Vec::new();
    for shape in js_regex!(r"<wps:wsp[\s>][\s\S]*?<\/wps:wsp>").find_iter(&body) {
        let wsp = shape.as_str();
        let sp_pr = whole(js_regex!(r"<wps:spPr[\s\S]*?<\/wps:spPr>"), wsp);
        let xfrm = whole(js_regex!(r"<a:xfrm[^>]*>[\s\S]*?<\/a:xfrm>"), &sp_pr);
        let off = whole(js_regex!(r"<a:off[^>]*\/>"), &xfrm);
        let ext = whole(js_regex!(r"<a:ext[^>]*\/>"), &xfrm);
        let cx = attr_num(&ext, NumAttr::Cx).unwrap_or(0.0);
        let cy = attr_num(&ext, NumAttr::Cy).unwrap_or(0.0);
        let ln_tag = whole(js_regex!(r"<a:ln[\s>][\s\S]*?<\/a:ln>"), &sp_pr);
        let fill = solid_fill
            .exec(&sp_pr.replacen(&ln_tag, "", 1))
            .and_then(|found| found.get(1).map(str::to_owned));
        // open rule shapes (cy=0 horizontal lines) carry only a stroke, colored
        // either inline or through the wps:style line reference
        let mut stroke = String::new();
        let ln_w = if !ln_tag.is_empty() && !ln_tag.contains("<a:noFill") {
            attr_num(&ln_tag, NumAttr::W).unwrap_or(0.0)
        } else {
            0.0
        };
        if ln_w > 0.0 {
            let color = solid_fill
                .exec(&ln_tag)
                .and_then(|found| found.get(1))
                .or_else(|| {
                    js_regex!(r#"<a:lnRef idx="[1-9]\d*">\s*<a:srgbClr val="([0-9A-Fa-f]{6})""#)
                        .exec(wsp)
                        .and_then(|found| found.get(1))
                });
            if let Some(color) = color {
                stroke = format!(
                    r##" stroke="#{color}" stroke-width="{}""##,
                    number_to_string(emu_px(ln_w))
                );
            }
        }
        if fill.is_none() && stroke.is_empty() {
            return Ok(None);
        }
        if cx < 0.0 || cy < 0.0 || cx + cy <= 0.0 {
            return Ok(None);
        }
        if (cx == 0.0 || cy == 0.0) && stroke.is_empty() {
            return Ok(None);
        }
        let geom = parse_cust_geom(wsp, cx, cy)?;
        let d = geom
            .iter()
            .flat_map(|geom| [geom.path.as_deref(), geom.fill_path.as_deref()])
            .flatten()
            .filter(|d| !d.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if d.is_empty() {
            return Ok(None);
        }
        // a zero-extent rule's centered stroke would hang half outside the box
        // the <img> clips to; the group extent is sized for the stroke, so centre it
        let x = emu_px(
            attr_num(&off, NumAttr::X).unwrap_or(0.0) * sx
                + tx
                + if cx == 0.0 { ln_w / 2.0 } else { 0.0 },
        );
        let y = emu_px(
            attr_num(&off, NumAttr::Y).unwrap_or(0.0) * sy
                + ty
                + if cy == 0.0 { ln_w / 2.0 } else { 0.0 },
        );
        let fill = fill.map_or_else(|| "none".to_owned(), |fill| format!("#{fill}"));
        paths.push(format!(
            r#"<path d="{}" fill="{fill}"{stroke}/>"#,
            place_path(&d, x, y, emu_px(cx * sx), emu_px(cy * sy)),
        ));
    }
    if paths.is_empty() {
        return Ok(None);
    }
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {} {}">{}</svg>"#,
        number_to_string(emu_px(ext_cx)),
        number_to_string(emu_px(ext_cy)),
        paths.concat(),
    );
    Ok(Some(format!(
        "data:image/svg+xml,{}",
        encode_uri_component(&svg)
    )))
}
