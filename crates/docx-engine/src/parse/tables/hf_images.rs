//! The display images of a header/footer part (logos, watermarks, floating
//! art): `hfImages`, `hfGroupPictures` and the media its layout tables use.
//! Offsets are byte offsets of the part text.

use std::collections::HashSet;

use jscompat::{JsMap, JsNum, Radix, js_regex, math_round, parse_int, to_number};
use ooxml_pkg::Package;

use super::hf::{hf_cell_column_left_px_at, hf_movable_picture_frag, hf_tbl_ranges_bytes};
use crate::model::{
    HfImage, HfImageAlign, HfImageCrop, HfImagePosH, HfImagePosHRel, HfImagePosV, HfImagePosVRel,
    HfImageWashout, HfImageWrap, HfImageWrapDistPx, SharedStr,
};
use crate::package::{RelInfo, Thrown, parse_rels, part_text, rels_path_of};
use crate::parse::drawings::host::MediaEnv;
use crate::parse::drawings::media::media_data_url;
use crate::parse::drawings::picture::{
    AnchorPos, hf_shape_drawing_svg, read_anchor_pos, rect_frac,
};
use crate::parse::text::{bridge, emu_to_px};
use crate::vml::shape::vml_shape_svg;
use crate::vml::{
    Dim, FloatAnchor, vml_float_anchor, vml_fraction, vml_rotation_deg, vml_style_dim_px,
};
use crate::watermark::{is_picture_watermark_shape, read_watermark_shape};
use crate::xml_tag::remove_segments;
use crate::xml_text::EMU_PER_PX;

/// `HF_DRAWING_RE`: the `<w:drawing>` elements of a header/footer part, in the
/// order `HfImage.drawing` counts them.
pub const HF_DRAWING_RE: &str = r"<w:drawing[\s>][\s\S]*?<\/w:drawing>";

/// What `hfImages` produces: the images and, beside them, the `wp:docPr` id
/// of the anchor each image was bound to (`hfImageAnchorId`).
#[derive(Debug, Default)]
pub struct HfImages {
    pub images: Vec<HfImage>,
    /// one entry per image
    pub image_anchor_ids: Vec<Option<String>>,
}

/// `text.lastIndexOf(search, from)`: the last occurrence that starts at or
/// before byte `from`.
fn last_index_of(text: &str, search: &str, from: usize) -> Option<usize> {
    let mut end = from.saturating_add(search.len()).min(text.len());
    while !text.is_char_boundary(end) {
        end += 1;
    }
    text[..end].rfind(search)
}

/// `m.index` of the first capture group named by a regex over `frag`.
fn first_capture<'t>(found: Option<jscompat::JsMatch<'t>>) -> Option<&'t str> {
    found.and_then(|found| found.get(1))
}

/// `Number.isFinite(n) && n > 0`
fn positive(n: f64) -> bool {
    n.is_finite() && n > 0.0
}

/// The wrapping a `wp:wrapNone` ... `wp:wrapTopAndBottom` element names.
fn wrap_of(frag: &str) -> Option<HfImageWrap> {
    let name = first_capture(
        js_regex!(r"<wp:wrap(None|Square|Tight|Through|TopAndBottom)[\s/>]").exec(frag),
    )?;
    Some(match name {
        "None" => HfImageWrap::None,
        "Square" => HfImageWrap::Square,
        "Tight" => HfImageWrap::Tight,
        "Through" => HfImageWrap::Through,
        _ => HfImageWrap::TopBottom,
    })
}

/// `{ l: rectFrac(srcRect, 'l'), t, r, b }` kept when any side is truthy.
fn crop_of(src_rect: &str) -> Result<Option<HfImageCrop>, Thrown> {
    let side = |name: &str| rect_frac(src_rect, name).map_err(|error| error.to_string());
    let (l, t, r, b) = (side("l")?, side("t")?, side("r")?, side("b")?);
    let truthy = |n: f64| n != 0.0 && !n.is_nan();
    Ok(
        (truthy(l) || truthy(t) || truthy(r) || truthy(b)).then_some(HfImageCrop {
            l: JsNum(l),
            t: JsNum(t),
            r: JsNum(r),
            b: JsNum(b),
        }),
    )
}

/// `Math.round(Number(new RegExp(`\\b${attr}="(\\d+)"`).exec(anchorTag)?.[1] ?? 0) / EMU_PER_PX)`
fn dist_px(anchor_tag: &str, attr: &str) -> f64 {
    let found = match attr {
        "distL" => js_regex!(r#"\bdistL="(\d+)""#).exec(anchor_tag),
        "distR" => js_regex!(r#"\bdistR="(\d+)""#).exec(anchor_tag),
        "distT" => js_regex!(r#"\bdistT="(\d+)""#).exec(anchor_tag),
        _ => js_regex!(r#"\bdistB="(\d+)""#).exec(anchor_tag),
    };
    let value = first_capture(found).map_or(0.0, to_number);
    math_round(value / EMU_PER_PX)
}

/// The `wp:docPr` id of a fragment: `/<wp:docPr\s[^>]*\bid="([^"]+)"/`.
fn doc_pr_id(frag: &str) -> Option<&str> {
    first_capture(js_regex!(r#"<wp:docPr\s[^>]*\bid="([^"]+)""#).exec(frag))
}

/// `mc:AlternateContent` blocks of a part: the Choice is authoritative; its
/// Fallback re-emits the same picture, so a Fallback counts only where nothing
/// in the same block's Choice resolved.
struct AlternateContent {
    /// `[start, end, fbStart, fbEnd]` of each block (`fb*` are -1 without a Fallback)
    blocks: Vec<(isize, isize, isize, isize)>,
    choice_produced: HashSet<usize>,
}

impl AlternateContent {
    fn of(part_xml: &str) -> Self {
        let blocks = js_regex!(
            r"<mc:AlternateContent[\s>][\s\S]*?<\/mc:AlternateContent>",
            "g"
        )
        .find_iter(part_xml)
        .map(|found| {
            let start = found.start() as isize;
            let end = found.end() as isize;
            match js_regex!(r"<mc:Fallback>[\s\S]*?<\/mc:Fallback>").exec(found.as_str()) {
                Some(fb) => (
                    start,
                    end,
                    start + fb.start() as isize,
                    start + fb.end() as isize,
                ),
                None => (start, end, -1, -1),
            }
        })
        .collect();
        Self {
            blocks,
            choice_produced: HashSet::new(),
        }
    }

    fn ac_at(&self, at: usize) -> Option<usize> {
        let at = at as isize;
        self.blocks
            .iter()
            .position(|&(start, end, ..)| at > start && at < end)
    }

    fn in_fallback_of(&self, at: usize) -> Option<usize> {
        let at = at as isize;
        self.blocks
            .iter()
            .position(|&(_, _, fb_start, fb_end)| at > fb_start && at < fb_end)
    }

    /// true = skip this match (its Choice sibling already produced an image)
    fn fallback_dup(&self, at: usize) -> bool {
        self.in_fallback_of(at)
            .is_some_and(|fb| self.choice_produced.contains(&fb))
    }

    fn record_produced(&mut self, at: usize) {
        if let Some(ac) = self.ac_at(at)
            && self.in_fallback_of(at).is_none()
        {
            self.choice_produced.insert(ac);
        }
    }
}

/// `vmlFloatAnchor(style, image)` on an `HfImage`: the keys the VML anchor
/// reads are set on the image, after the keys it has.
pub fn float_anchor(style: &str, image: &mut HfImage) {
    let mut anchor = FloatAnchor::default();
    vml_float_anchor(style, &mut anchor);
    for key in anchor.keys() {
        match key {
            "posHRel" => image
                .pos_h_rel
                .assign(anchor.pos_h_rel.map(|rel| match rel {
                    "page" => HfImagePosHRel::Page,
                    "leftMargin" => HfImagePosHRel::LeftMargin,
                    "rightMargin" => HfImagePosHRel::RightMargin,
                    _ => HfImagePosHRel::Margin,
                })),
            "posVRel" => image
                .pos_v_rel
                .assign(anchor.pos_v_rel.map(|rel| match rel {
                    "page" => HfImagePosVRel::Page,
                    "paragraph" => HfImagePosVRel::Paragraph,
                    "topMargin" => HfImagePosVRel::TopMargin,
                    "bottomMargin" => HfImagePosVRel::BottomMargin,
                    _ => HfImagePosVRel::Margin,
                })),
            "posH" => image.pos_h.assign(anchor.pos_h.map(|pos| match pos {
                "left" => HfImagePosH::Left,
                "center" => HfImagePosH::Center,
                _ => HfImagePosH::Right,
            })),
            "posV" => image.pos_v.assign(anchor.pos_v.map(|pos| match pos {
                "top" => HfImagePosV::Top,
                "center" => HfImagePosV::Center,
                _ => HfImagePosV::Bottom,
            })),
            "posXPx" => image.pos_x_px.assign(*anchor.pos_x_px),
            "posYPx" => image.pos_y_px.assign(*anchor.pos_y_px),
            _ => {}
        }
    }
}

/// `hfGroupPictures`: an anchored wpg group of pictures (logo strips): one
/// `HfImage` per child picture at its own mapped offset, size and a:srcRect
/// crop. `None` (the caller falls back to the single-image path) unless the
/// anchor uses posOffset on both axes and every child picture has a plain
/// xfrm.
pub fn hf_group_pictures(
    zip: &Package,
    rels: &JsMap<RelInfo>,
    frag: &str,
    source_path: &str,
    media: &MediaEnv<'_>,
) -> Result<Option<Vec<HfImage>>, Thrown> {
    let body = remove_segments(frag, "mc:Fallback");
    let mut anchor = AnchorPos::default();
    read_anchor_pos(&body, &mut anchor);
    let (Some(anchor_x), Some(anchor_y)) = (*anchor.pos_x_px, *anchor.pos_y_px) else {
        return Ok(None);
    };
    let attr_num = |tag: &str, key: &str| -> Option<f64> {
        let found = match key {
            "cx" => js_regex!(r#"cx="(-?\d+)""#).exec(tag),
            "cy" => js_regex!(r#"cy="(-?\d+)""#).exec(tag),
            "x" => js_regex!(r#"x="(-?\d+)""#).exec(tag),
            _ => js_regex!(r#"y="(-?\d+)""#).exec(tag),
        };
        first_capture(found).map(|v| parse_int(v, Radix::Ten))
    };
    let Some(grp_xfrm) = first_capture(
        js_regex!(r"<wpg:grpSpPr[^>]*>[\s\S]*?<a:xfrm[^>]*>([\s\S]*?)<\/a:xfrm>").exec(&body),
    ) else {
        return Ok(None);
    };
    let el = |name: &str| -> &str {
        let found = match name {
            "ext" => js_regex!(r"<a:ext[^>]*/>").exec(grp_xfrm),
            "chExt" => js_regex!(r"<a:chExt[^>]*/>").exec(grp_xfrm),
            "off" => js_regex!(r"<a:off[^>]*/>").exec(grp_xfrm),
            _ => js_regex!(r"<a:chOff[^>]*/>").exec(grp_xfrm),
        };
        found.map_or("", |found| found.as_str())
    };
    let (ext_x, ext_y) = (
        attr_num(el("ext"), "cx").unwrap_or(0.0),
        attr_num(el("ext"), "cy").unwrap_or(0.0),
    );
    let (ch_ext_x, ch_ext_y) = (
        attr_num(el("chExt"), "cx").unwrap_or(0.0),
        attr_num(el("chExt"), "cy").unwrap_or(0.0),
    );
    let sx = if ext_x > 0.0 && ch_ext_x > 0.0 {
        ext_x / ch_ext_x
    } else {
        1.0
    };
    let sy = if ext_y > 0.0 && ch_ext_y > 0.0 {
        ext_y / ch_ext_y
    } else {
        1.0
    };
    let tx =
        attr_num(el("off"), "x").unwrap_or(0.0) - attr_num(el("chOff"), "x").unwrap_or(0.0) * sx;
    let ty =
        attr_num(el("off"), "y").unwrap_or(0.0) - attr_num(el("chOff"), "y").unwrap_or(0.0) * sy;
    let anchor_tag = js_regex!(r"<wp:anchor[^>]*>")
        .exec(&body)
        .map_or("", |found| found.as_str());
    let behind = js_regex!(r#"behindDoc="(?:1|true)""#).test(anchor_tag);
    let wrap = wrap_of(&body);
    let mut out: Vec<HfImage> = Vec::new();
    for pm in js_regex!(r"<pic:pic[\s>][\s\S]*?<\/pic:pic>", "g").find_iter(&body) {
        let pic = pm.as_str();
        let Some(xfrm) =
            js_regex!(r"<pic:spPr[^>]*>[\s\S]*?<a:xfrm([^>]*)>([\s\S]*?)<\/a:xfrm>").exec(pic)
        else {
            return Ok(None);
        };
        if js_regex!(r#"\brot="-?[1-9]"#).test(xfrm.get(1).unwrap_or("")) {
            return Ok(None);
        }
        let inner = xfrm.get(2).unwrap_or("");
        let off = js_regex!(r"<a:off[^>]*\/>")
            .exec(inner)
            .map_or("", |found| found.as_str());
        let size = js_regex!(r"<a:ext[^>]*\/>")
            .exec(inner)
            .map_or("", |found| found.as_str());
        let cx = attr_num(size, "cx").unwrap_or(0.0) * sx;
        let cy = attr_num(size, "cy").unwrap_or(0.0) * sy;
        if cx <= 0.0 || cy <= 0.0 {
            return Ok(None);
        }
        let r_id =
            first_capture(js_regex!(r#"<a:blip[^>]*r:embed\s*=\s*["']([^"']+)["']"#).exec(pic));
        let data_url = match r_id {
            Some(r_id) => media_data_url(zip, rels, r_id, source_path, media)?,
            None => None,
        };
        let Some(data_url) = data_url.filter(|url| !url.is_empty()) else {
            continue;
        };
        let mut image = HfImage::default();
        image.data_url.set(data_url);
        image.width_px.set(JsNum(emu_to_px(cx)));
        image.height_px.set(JsNum(emu_to_px(cy)));
        image.floating.set(true);
        image.pos_x_px.set(JsNum(
            anchor_x.0 + math_round((attr_num(off, "x").unwrap_or(0.0) * sx + tx) / EMU_PER_PX),
        ));
        image.pos_y_px.set(JsNum(
            anchor_y.0 + math_round((attr_num(off, "y").unwrap_or(0.0) * sy + ty) / EMU_PER_PX),
        ));
        image.pos_h_rel.assign((*anchor.pos_h_rel).clone());
        image.pos_v_rel.assign((*anchor.pos_v_rel).clone());
        if behind {
            image.behind.set(true);
        }
        if let Some(wrap) = &wrap {
            image.wrap.set(wrap.clone());
        }
        if let Some(src_rect) = js_regex!(r"<a:srcRect\s[^>]*\/>").exec(pic)
            && let Some(crop) = crop_of(src_rect.as_str())?
        {
            image.crop.set(crop);
        }
        out.push(image);
    }
    Ok((!out.is_empty()).then_some(out))
}

/// `hfImages`: the display-only images of a header/footer part (logos etc.):
/// resolves `a:blip r:embed` and VML `v:imagedata r:id` from the part's own
/// rels; watermarks (`v:textpath`) are read as watermark shapes. The save path
/// does not go through here: image paragraphs keep their original bytes when
/// the part is regenerated.
///
/// `run_image_ids` is `hfRunImageIds.get(paras)`: the `wp:docPr` ids of the
/// inline pictures the part's text paragraphs keep on their runs.
pub fn hf_images(
    zip: &Package,
    part_path: &str,
    part_xml: &str,
    run_image_ids: Option<&HashSet<String>>,
    media: &MediaEnv<'_>,
) -> Result<HfImages, Thrown> {
    if !part_xml.contains("<a:blip")
        && !part_xml.contains("<wps:wsp")
        && !js_regex!(r"<w:(?:pict|object)[\s>]").test(part_xml)
    {
        return Ok(HfImages::default());
    }
    let rels = parse_rels(zip, &rels_path_of(part_path))?;
    // inline pictures in layout tables (nested ones included) live on their cell
    // runs (hfTableRowParagraphs); floating ones still position through this
    // part-level list
    let tbls = hf_tbl_ranges_bytes(part_xml);
    let on_cell_run = |at: usize| tbls.iter().any(|&(s, e)| at > s && at < e);
    let on_text_run = |frag: &str| {
        doc_pr_id(frag).is_some_and(|id| run_image_ids.is_some_and(|ids| ids.contains(id)))
    };
    // mc:AlternateContent: the Choice is authoritative; its Fallback re-emits the
    // same picture (an anchored logo shape falls back to an inline copy), doubling
    // the drawn image and inflating the strip's reserved height (prod100r4/43).
    // Fallback content only counts when nothing in the same block's Choice
    // resolved (mac Word PDF Choice + PNG Fallback keeps working: those blips
    // share one w:drawing and are tried in order above).
    let mut alt = AlternateContent::of(part_xml);
    let mut result = HfImages::default();
    let push = |result: &mut HfImages, image: HfImage, anchor_id: Option<String>| {
        result.images.push(image);
        result.image_anchor_ids.push(anchor_id);
    };
    // w:jc of the paragraph containing offset `at` (inline images follow it)
    let para_align_at = |at: usize| -> Option<HfImageAlign> {
        let p_start = match (
            last_index_of(part_xml, "<w:p ", at),
            last_index_of(part_xml, "<w:p>", at),
        ) {
            (Some(a), Some(b)) => a.max(b),
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => return None,
        };
        let jc = first_capture(
            js_regex!(r#"<w:jc w:val="(\w+)""#).exec(part_xml.get(p_start..at).unwrap_or("")),
        );
        match jc {
            Some("left") => Some(HfImageAlign::Left),
            Some("center") => Some(HfImageAlign::Center),
            Some("right") => Some(HfImageAlign::Right),
            _ => None,
        }
    };
    let mut drawing_ordinal: i64 = -1;
    for m in js_regex!(r"<w:drawing[\s>][\s\S]*?<\/w:drawing>", "g").find_iter(part_xml) {
        let frag = m.as_str();
        let at = m.start();
        drawing_ordinal += 1;
        if alt.fallback_dup(at) {
            continue;
        }
        let is_anchor = js_regex!(r"<wp:anchor[\s>]").test(frag);
        if !is_anchor && on_cell_run(at) {
            continue;
        }
        if !is_anchor && on_text_run(frag) {
            continue;
        }
        if is_anchor && frag.contains("<wpg:wgp") {
            let children = hf_group_pictures(zip, &rels, frag, part_path, media)?;
            if let Some(children) = children {
                for child in children {
                    push(&mut result, child, None);
                }
                alt.record_produced(at);
                continue;
            }
        }
        // mc:AlternateContent may hold several blips (mac Word: PDF Choice + PNG
        // Fallback); use the first one whose media resolves
        let mut data_url: Option<SharedStr> = None;
        for b in js_regex!(r#"<a:blip[^>]*r:embed\s*=\s*["']([^"']+)["']"#, "g").find_iter(frag) {
            data_url = media_data_url(zip, &rels, b.get(1).unwrap_or(""), part_path, media)?
                .filter(|url| !url.is_empty());
            if data_url.is_some() {
                break;
            }
        }
        // textless vector decorations (wpg group of custGeom shapes) render as one SVG
        if data_url.is_none() {
            data_url = hf_shape_drawing_svg(frag)
                .map_err(|limit| limit.to_string())?
                .filter(|url| !url.is_empty())
                .map(SharedStr::from);
        }
        let Some(data_url) = data_url else {
            continue;
        };
        let mut image = HfImage::default();
        image.data_url.set(data_url);
        let extent = js_regex!(r"<wp:extent[^>]*\/?>")
            .exec(frag)
            .map_or("", |found| found.as_str());
        let cx = parse_int(
            first_capture(js_regex!(r#"\bcx\s*=\s*["'](\d+)["']"#).exec(extent)).unwrap_or(""),
            Radix::Ten,
        );
        let cy = parse_int(
            first_capture(js_regex!(r#"\bcy\s*=\s*["'](\d+)["']"#).exec(extent)).unwrap_or(""),
            Radix::Ten,
        );
        if positive(cx) {
            image.width_px.set(JsNum(emu_to_px(cx)));
        }
        if positive(cy) {
            image.height_px.set(JsNum(emu_to_px(cy)));
        }
        // a:srcRect source crop: two same-image anchors cropped to different
        // regions read as duplicated pictures without it (prod100r1 sample 90)
        if let Some(src_rect) = js_regex!(r"<a:srcRect\s[^>]*\/>").exec(frag)
            && let Some(crop) = crop_of(src_rect.as_str())?
        {
            image.crop.set(crop);
        }
        let mut anchor_id: Option<String> = None;
        if is_anchor {
            image.floating.set(true);
            let anchor_tag = js_regex!(r"<wp:anchor[^>]*>")
                .exec(frag)
                .map_or("", |found| found.as_str());
            if js_regex!(r#"behindDoc="(?:1|true)""#).test(anchor_tag) {
                image.behind.set(true);
            }
            if let Some(wrap) = wrap_of(frag) {
                image.wrap.set(wrap);
            }
            let (l, r, t, b) = (
                dist_px(anchor_tag, "distL"),
                dist_px(anchor_tag, "distR"),
                dist_px(anchor_tag, "distT"),
                dist_px(anchor_tag, "distB"),
            );
            if [l, r, t, b].iter().any(|v| *v > 0.0) {
                image.wrap_dist_px.set(HfImageWrapDistPx {
                    l: JsNum(l),
                    r: JsNum(r),
                    t: JsNum(t),
                    b: JsNum(b),
                });
            }
            read_anchor_pos(frag, &mut image);
            // the strip can move and resize it (patchHfPicturesXml finds it again by this ordinal)
            if hf_movable_picture_frag(frag) {
                image.drawing.set(JsNum(drawing_ordinal as f64));
            }
            // inside a layout-table cell, column/margin offsets measure from that cell's text column
            if let Some(x) = *image.pos_x_px
                && *image.pos_h_rel == Some(HfImagePosHRel::Margin)
                && on_cell_run(at)
            {
                image
                    .pos_x_px
                    .set(JsNum(x.0 + hf_cell_column_left_px_at(part_xml, at)));
            }
            if *image.pos_v_rel == Some(HfImagePosVRel::Paragraph)
                && image.pos_y_px.is_some()
                && on_cell_run(at)
                && let Some(id) = doc_pr_id(frag).filter(|id| !id.is_empty())
            {
                anchor_id = Some(id.to_owned());
            }
        } else if let Some(align) = para_align_at(at) {
            image.align.set(align);
        }
        alt.record_produced(at);
        push(&mut result, image, anchor_id);
    }
    // an inline OLE embed (w:object) previews through the same v:imagedata as a
    // legacy VML picture; Word paints the preview in the strip like any picture
    for m in js_regex!(
        r"<w:pict[\s>][\s\S]*?<\/w:pict>|<w:object[\s>][\s\S]*?<\/w:object>",
        "g"
    )
    .find_iter(part_xml)
    {
        let frag = m.as_str();
        let at = m.start();
        if alt.fallback_dup(at) {
            continue;
        }
        if frag.contains("<v:textpath") {
            if let Some(wm) = read_watermark_shape(frag) {
                alt.record_produced(at);
                push(&mut result, bridge(&wm)?, None);
            }
            continue;
        }
        if !js_regex!(r"position:\s*absolute").test(frag) && on_cell_run(at) {
            continue;
        }
        let r_id = first_capture(js_regex!(r#"<v:imagedata[^>]*r:id="([^"]+)""#).exec(frag))
            .filter(|id| !id.is_empty());
        let Some(r_id) = r_id else {
            // textless vector shape (mc:Fallback twin of a wps shape the Choice
            // path could not draw, or a plain VML decoration)
            let Some(shape) = vml_shape_svg(frag, None) else {
                continue;
            };
            if !js_regex!(r"position:\s*absolute").test(&shape.style) {
                continue;
            }
            let mut image = HfImage::default();
            image.data_url.set(shape.data_url.as_str().into());
            image.width_px.set(shape.width_px);
            image.height_px.set(shape.height_px);
            image.floating.set(true);
            if js_regex!(r"z-index:\s*-").test(&shape.style) {
                image.behind.set(true);
            }
            if let Some(rot) = vml_rotation_deg(&shape.style) {
                image.rotation_deg.set(JsNum(rot));
            }
            float_anchor(&shape.style, &mut image);
            alt.record_produced(at);
            push(&mut result, image, None);
            continue;
        };
        let Some(data_url) =
            media_data_url(zip, &rels, r_id, part_path, media)?.filter(|url| !url.is_empty())
        else {
            continue;
        };
        // VML dimensions live in the v:shape style attribute (pt, in, cm...)
        let style =
            first_capture(js_regex!(r#"<v:shape[^>]*style="([^"]*)""#).exec(frag)).unwrap_or("");
        let mut image = HfImage::default();
        image.data_url.set(data_url);
        let w = vml_style_dim_px(style, Dim::Width);
        let h = vml_style_dim_px(style, Dim::Height);
        // w:object declares its size in twips when the v:shape style is absent
        let obj_attrs = js_regex!(r"<w:object\b[^>]*>")
            .exec(frag)
            .map_or("", |found| found.as_str());
        let w_tw = parse_int(
            first_capture(js_regex!(r#"w:dxaOrig="(\d+)""#).exec(obj_attrs)).unwrap_or(""),
            Radix::Ten,
        );
        let h_tw = parse_int(
            first_capture(js_regex!(r#"w:dyaOrig="(\d+)""#).exec(obj_attrs)).unwrap_or(""),
            Radix::Ten,
        );
        if let Some(w) = w.filter(|w| *w != 0.0) {
            image.width_px.set(JsNum(w));
        } else if w_tw > 0.0 {
            image.width_px.set(JsNum(math_round(w_tw / 15.0)));
        }
        if let Some(h) = h.filter(|h| *h != 0.0) {
            image.height_px.set(JsNum(h));
        } else if h_tw > 0.0 {
            image.height_px.set(JsNum(math_round(h_tw / 15.0)));
        }
        // absolute-positioned shapes (picture watermarks): must not stack into the
        // header strip nor count toward the header height estimate
        if js_regex!(r"position:absolute").test(style) {
            image.floating.set(true);
            if js_regex!(r"z-index:\s*-").test(style) {
                image.behind.set(true);
            }
            if is_picture_watermark_shape(frag) {
                image.watermark.set(true);
            }
            if let Some(rot) = vml_rotation_deg(style) {
                image.rotation_deg.set(JsNum(rot));
            }
            float_anchor(style, &mut image);
        } else if let Some(align) = para_align_at(at) {
            image.align.set(align);
        }
        let imagedata = js_regex!(r"<v:imagedata[^>]*>")
            .exec(frag)
            .map_or("", |found| found.as_str());
        let gain = vml_fraction(first_capture(
            js_regex!(r#"\sgain="([^"]*)""#).exec(imagedata),
        ));
        let black_level = vml_fraction(first_capture(
            js_regex!(r#"\sblacklevel="([^"]*)""#).exec(imagedata),
        ));
        if gain.is_some() || black_level.is_some() {
            image.washout.set(HfImageWashout {
                gain: JsNum(gain.unwrap_or(1.0)),
                black_level: JsNum(black_level.unwrap_or(0.0)),
            });
        }
        alt.record_produced(at);
        push(&mut result, image, None);
    }
    Ok(result)
}

/// `hfTableMedia`: the pre-resolved image media (rId to data/external URL) for
/// pictures inside a header/footer part's layout tables, so the sync cell-run
/// extraction can attach them (mirrors `tableBlipMedia`).
pub fn hf_table_media(
    zip: &Package,
    part_path: &str,
    part_xml: &str,
    media: &MediaEnv<'_>,
) -> Result<Option<JsMap<SharedStr>>, Thrown> {
    if !part_xml.contains("<w:tbl") && !part_xml.contains("<wp:inline") {
        return Ok(None);
    }
    if !part_xml.contains("<a:blip") && !part_xml.contains("<v:imagedata") {
        return Ok(None);
    }
    let rels = parse_rels(zip, &rels_path_of(part_path))?;
    let mut out: JsMap<SharedStr> = JsMap::new();
    // inline pictures sharing a text paragraph become run images too, so a part
    // without tables still needs its media
    let mut ranges = if part_xml.contains("<w:tbl") {
        hf_tbl_ranges_bytes(part_xml)
    } else {
        Vec::new()
    };
    if part_xml.contains("<wp:inline") {
        ranges.push((0, part_xml.len()));
    }
    for (start, end) in ranges {
        let slice = &part_xml[start..end];
        let blips = js_regex!(
            r#"<a:blip[^>]*r:(?:embed|link)\s*=\s*["']([^"']+)["']"#,
            "g"
        )
        .find_iter(slice);
        let datas =
            js_regex!(r#"<v:imagedata[^>]*r:id\s*=\s*["']([^"']+)["']"#, "g").find_iter(slice);
        for m in blips.chain(datas) {
            let r_id = m.get(1).unwrap_or("");
            if out.has(r_id) {
                continue;
            }
            let Some(rel) = rels.get(r_id) else {
                continue;
            };
            if rel.target_mode.as_deref() == Some("External")
                || js_regex!(r"^https?:\/\/", "i").test(&rel.target)
            {
                out.set(r_id, SharedStr::from(rel.target.as_str()));
                continue;
            }
            if let Some(data_url) =
                media_data_url(zip, &rels, r_id, part_path, media)?.filter(|url| !url.is_empty())
            {
                out.set(r_id, data_url);
            }
        }
    }
    Ok((!out.is_empty()).then_some(out))
}

/// Reads a part of the package as text (`await file.async('string')`).
pub fn read_part(zip: &Package, path: &str) -> Result<Option<String>, Thrown> {
    Ok(part_text(zip, path)?.map(str::to_owned))
}
