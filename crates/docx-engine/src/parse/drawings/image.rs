//! The display model of a picture paragraph: size, wrap, anchor and
//! recolor of a `w:drawing`, and the floating geometry a run picture carries.

use std::ops::{Deref, DerefMut};

use jscompat::{JsMatch, JsNum, Radix, js_regex, math_round, parse_int, to_number, try_js_regex};
use serde::Serialize;

use super::EMU_PER_PX;
use super::picture::{pic_border_of, pic_transform_of, rect_frac};
use crate::fields::{direct_line_of, direct_para_geometry, r_pr_node_of};
use crate::model::{
    Block, BlockImageAlign, BlockImageBorder, BlockImageCrop, BlockImageFillRect,
    BlockImageParagraphLineRule, BlockImagePosH, BlockImagePosV, BlockImageRelH, BlockImageRelV,
    ImageEffects, ImageWrap, RunImagePosH, RunImagePosV, RunImageRelH, RunImageRelV,
};
use crate::package::Thrown;
use crate::parse::text::{BuildContext, emu_to_px};
use crate::resolve::{
    PropSource, ResolveParaOptions, resolve_paragraph_props_xml, resolve_run_props,
};
use crate::xml_text::plain_text;

/// `ImageMeta`: the `image*` keys of a `Block` and `imageNoOverlap`, the one
/// key no `Block` declares.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImageMeta {
    pub block: Block,
    /// `imageNoOverlap`: wp:anchor allowOverlap="0"
    pub image_no_overlap: bool,
}

/// The keys `imageMeta` sets after `imageNoOverlap`: where the key goes
/// among the others when the meta is written.
const AFTER_NO_OVERLAP: [&str; 9] = [
    "imageAnchorLocked",
    "imageZOrder",
    "imageWrap",
    "imageOffsetXEmu",
    "imageOffsetYEmu",
    "imageRelV",
    "imagePosV",
    "imageRelH",
    "imagePosH",
];

/// `imageNoOverlap` goes before the first key set after it, as in the
/// TypeScript object; no `Block` declares it, so it cannot ride in the slot
/// order of the block.
impl Serialize for ImageMeta {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{Error as _, SerializeMap as _};
        let json = serde_json::to_value(&self.block).map_err(S::Error::custom)?;
        let serde_json::Value::Object(map) = json else {
            return Err(S::Error::custom("a Block is an object"));
        };
        let mut out = serializer.serialize_map(None)?;
        let mut written = !self.image_no_overlap;
        for (key, value) in &map {
            if !written && AFTER_NO_OVERLAP.contains(&key.as_str()) {
                out.serialize_entry("imageNoOverlap", &true)?;
                written = true;
            }
            out.serialize_entry(key, value)?;
        }
        if !written {
            out.serialize_entry("imageNoOverlap", &true)?;
        }
        out.end()
    }
}

impl Deref for ImageMeta {
    type Target = Block;

    fn deref(&self) -> &Block {
        &self.block
    }
}

impl DerefMut for ImageMeta {
    fn deref_mut(&mut self) -> &mut Block {
        &mut self.block
    }
}

fn capture<'t>(found: Option<JsMatch<'t>>) -> Option<&'t str> {
    found.and_then(|found| found.get(1))
}

fn to_thrown(error: impl std::fmt::Display) -> Thrown {
    error.to_string()
}

/// `blipEffectsOf`: a:lum / a:grayscl / a:biLevel inside the picture's a:blip
/// as a display recolor.
pub fn blip_effects_of(xml: &str) -> Result<Option<ImageEffects>, Thrown> {
    // a self-closing first blip must not span to a later picture's closing tag
    let Some(blip) = capture(js_regex!(r"<a:blip\b[^>]*[^/>]>([\s\S]*?)<\/a:blip>").exec(xml))
    else {
        return Ok(None);
    };
    let mut out = ImageEffects::default();
    if let Some(lum) = js_regex!(r"<a:lum\b[^>]*\/?>")
        .exec(blip)
        .map(|found| found.as_str())
    {
        let bright = rect_frac(lum, "bright").map_err(to_thrown)?;
        let contrast = rect_frac(lum, "contrast").map_err(to_thrown)?;
        if bright != 0.0 && !bright.is_nan() {
            out.bright = Some(JsNum(bright));
        }
        if contrast != 0.0 && !contrast.is_nan() {
            out.contrast = Some(JsNum(contrast));
        }
    }
    if js_regex!(r"<a:grayscl\b").test(blip) {
        out.grayscale = Some(true);
    }
    if let Some(bi_level) = js_regex!(r"<a:biLevel\b[^>]*\/?>")
        .exec(blip)
        .map(|found| found.as_str())
    {
        out.bi_level_thresh = Some(JsNum(if js_regex!(r#"\bthresh=""#).test(bi_level) {
            rect_frac(bi_level, "thresh").map_err(to_thrown)?
        } else {
            0.5
        }));
    }
    let any = out.bright.is_some()
        || out.contrast.is_some()
        || out.grayscale.is_some()
        || out.bi_level_thresh.is_some();
    Ok(any.then_some(out))
}

/// The four fractions of an a:srcRect or a:fillRect, `None` where all four
/// are 0.
fn fractions(tag: &str) -> Result<Option<[f64; 4]>, Thrown> {
    let l = rect_frac(tag, "l").map_err(to_thrown)?;
    let t = rect_frac(tag, "t").map_err(to_thrown)?;
    let r = rect_frac(tag, "r").map_err(to_thrown)?;
    let b = rect_frac(tag, "b").map_err(to_thrown)?;
    let truthy = |v: f64| v != 0.0 && !v.is_nan();
    Ok((truthy(l) || truthy(t) || truthy(r) || truthy(b)).then_some([l, t, r, b]))
}

/// `Number(match ?? NaN)`
fn number_or_nan(found: Option<&str>) -> f64 {
    found.map_or(f64::NAN, to_number)
}

/// `imageMeta`: size, alignment, wrap, anchor and recolor of a picture
/// paragraph. With a context it also carries the host paragraph's indents,
/// spacing and mark font, which a wrapper with no data-style cannot bring.
pub fn image_meta(xml: &str, ctx: Option<&BuildContext<'_>>) -> Result<ImageMeta, Thrown> {
    let mut meta = ImageMeta::default();
    let drawing_at = js_regex!(r"<w:(?:drawing|pict)[\s>]")
        .exec(xml)
        .map(|found| found.start());
    if let Some(drawing_at) = drawing_at
        && js_regex!(r"^<w:p[\s>]").test(xml)
    {
        let leading_xml = &xml[..drawing_at];
        // a leading tab keeps its line when the picture does not fit beside it
        let tabs = js_regex!(r"<w:tab\s*\/>|<w:tab>\s*<\/w:tab>")
            .replace_all(leading_xml, |_| "<w:t>\t</w:t>".to_owned());
        let leading_text = plain_text(&tabs);
        if !leading_text.is_empty() {
            meta.image_leading_text.set(leading_text);
        }
        let leading_fonts = js_regex!(r"<w:rFonts\b[^>]*\/?>")
            .find_iter(leading_xml)
            .last()
            .map_or("", |found| found.as_str());
        meta.image_leading_font.assign(
            capture(js_regex!(r#"w:eastAsia="([^"]+)""#).exec(leading_fonts))
                .or_else(|| capture(js_regex!(r#"w:ascii="([^"]+)""#).exec(leading_fonts)))
                .map(str::to_owned),
        );
        let mut explicit_space_width_px = 0.0;
        let mut implicit_space_count = 0.0;
        for run in js_regex!(r"<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>").find_iter(leading_xml) {
            let run_body = run.get(1).unwrap_or("");
            let text = plain_text(&format!("<w:r>{run_body}</w:r>"));
            if text.is_empty() || !text.chars().all(|c| c == ' ') {
                continue;
            }
            let r_pr = js_regex!(r"<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>")
                .exec(run_body)
                .map_or("", |found| found.as_str());
            let size_half_points = number_or_nan(capture(
                js_regex!(r#"<w:sz\b[^>]*w:val="(\d+)""#).exec(r_pr),
            ));
            let length = text.encode_utf16().count() as f64;
            if size_half_points.is_finite() {
                // Word's CJK single-byte spaces are half-em: half-points / 3 = CSS px
                explicit_space_width_px += (length * size_half_points) / 3.0;
            } else {
                implicit_space_count += length;
            }
        }
        if explicit_space_width_px > 0.0 {
            meta.image_leading_explicit_space_width_px
                .set(JsNum(explicit_space_width_px));
        }
        if implicit_space_count > 0.0 {
            meta.image_leading_implicit_space_count
                .set(JsNum(implicit_space_count));
        }
        if let Some(ctx) = ctx {
            host_paragraph_geometry(&mut meta, xml, leading_xml, ctx)?;
        }
    }
    let extent = js_regex!(r"<wp:extent[^>]*\/?>")
        .exec(xml)
        .map(|found| found.as_str());
    if let Some(extent) = extent {
        let cx = parse_int(
            capture(js_regex!(r#"\bcx\s*=\s*["'](\d+)["']"#).exec(extent)).unwrap_or(""),
            Radix::Ten,
        );
        let cy = parse_int(
            capture(js_regex!(r#"\bcy\s*=\s*["'](\d+)["']"#).exec(extent)).unwrap_or(""),
            Radix::Ten,
        );
        if cx.is_finite() && cx > 0.0 {
            meta.image_width_px.set(JsNum(emu_to_px(cx)));
        }
        if cy.is_finite() && cy > 0.0 {
            meta.image_height_px.set(JsNum(emu_to_px(cy)));
        }
    }
    let effect =
        capture(js_regex!(r"<wp:inline\b[^>]*>[\s\S]*?<wp:effectExtent\b([^>]*)\/?>").exec(xml));
    if let Some(effect) = effect.filter(|effect| !effect.is_empty()) {
        let px = |pattern: &jscompat::JsRegex| {
            let v = parse_int(capture(pattern.exec(effect)).unwrap_or(""), Radix::Ten);
            if v.is_finite() && v > 0.0 {
                math_round((v / EMU_PER_PX) * 100.0) / 100.0
            } else {
                0.0
            }
        };
        let t = px(js_regex!(r#"\bt="(\d+)""#));
        let b = px(js_regex!(r#"\bb="(\d+)""#));
        if t != 0.0 {
            meta.image_effect_extent_top_px.set(JsNum(t));
        }
        if b != 0.0 {
            meta.image_effect_extent_bottom_px.set(JsNum(b));
        }
    }
    let xf = pic_transform_of(xml);
    if let Some(rot) = xf.rot_deg {
        meta.image_rot_deg.set(rot);
    }
    if xf.flip_h == Some(true) {
        meta.image_flip_h.set(true);
    }
    if xf.flip_v == Some(true) {
        meta.image_flip_v.set(true);
    }
    if let Some(border) = pic_border_of(xml) {
        meta.image_border.set(BlockImageBorder {
            color: border.color,
            width_pt: border.width_pt,
        });
    }
    // source crop (a:srcRect) and fill placement (a:stretch/a:fillRect): applied
    // by the renderer as an overflow-hidden window over a scaled/offset image
    if let Some(src_rect) = js_regex!(r"<a:srcRect\s[^>]*\/>")
        .exec(xml)
        .map(|found| found.as_str())
        && let Some([l, t, r, b]) = fractions(src_rect)?
    {
        meta.image_crop.set(BlockImageCrop {
            l: JsNum(l),
            t: JsNum(t),
            r: JsNum(r),
            b: JsNum(b),
        });
    }
    if let Some(effects) = blip_effects_of(xml)? {
        meta.image_effects.set(effects);
    }
    if let Some(fill_rect) = js_regex!(r"<a:stretch>\s*<a:fillRect\s[^>]*\/>")
        .exec(xml)
        .map(|found| found.as_str())
        && let Some([l, t, r, b]) = fractions(fill_rect)?
    {
        meta.image_fill_rect.set(BlockImageFillRect {
            l: JsNum(l),
            t: JsNum(t),
            r: JsNum(r),
            b: JsNum(b),
        });
    }
    if let Some(anchor) = js_regex!(r"<wp:anchor[^>]*>")
        .exec(xml)
        .map(|found| found.as_str())
    {
        anchor_meta(&mut meta, xml, anchor)?;
    }
    Ok(meta)
}

/// The `if (ctx) { ... }` block of `imageMeta`: the host paragraph's indents,
/// spacing, mark font and alignment.
fn host_paragraph_geometry(
    meta: &mut ImageMeta,
    xml: &str,
    leading_xml: &str,
    ctx: &BuildContext<'_>,
) -> Result<(), Thrown> {
    let rctx = &*ctx.resolver;
    // the host pPr only: a text box's own paragraphs carry their own properties
    let host_p_pr =
        capture(js_regex!(r"^<w:p\b[^>]*>\s*(<w:pPr>[\s\S]*?<\/w:pPr>)").exec(xml)).unwrap_or("");
    let eff = resolve_paragraph_props_xml(host_p_pr, rctx, ResolveParaOptions::default())?;
    let g = direct_para_geometry(&eff);
    let floating = js_regex!(r"<wp:anchor[\s>]").test(xml);
    // an in-line picture sits on a text line, which takes the chain's indents
    // (style, docDefaults) like any other: a centered picture under a
    // docDefaults first-line indent shifts right by half of it in Word. The
    // wrapper has no data-style to bring them, so they travel inline; a float
    // positions against the column and keeps only its direct ones
    let (indent_left, indent_right, indent_first_line) = if !floating && eff.indent.chars.is_none()
    {
        (
            Some(eff.indent.left),
            Some(eff.indent.right),
            Some(eff.indent.first_line),
        )
    } else {
        (
            g.indent_left_twips,
            g.indent_right_twips,
            g.indent_first_line_twips,
        )
    };
    // zero indents stay off the model: the wrapper has no style indent to cancel
    let nonzero = |value: Option<JsNum>| value.filter(|v| v.0 != 0.0 && !v.0.is_nan());
    if let Some(v) = nonzero(indent_left) {
        meta.image_paragraph_indent_left.set(v);
    }
    if let Some(v) = nonzero(indent_right) {
        meta.image_paragraph_indent_right.set(v);
    }
    if let Some(v) = nonzero(indent_first_line) {
        meta.image_paragraph_indent_first_line.set(v);
    }
    // the picture node carries no data-style, so the chain's spacing (style,
    // docDefaults, builtin 0) has to travel inline. An unstyled floating
    // picture takes only its direct spacing: the base rule skips floats
    // because the anchor line inside already carries the default spacing
    let chain = !floating || eff.style_id.is_some();
    let direct = |key: &str| eff.source.get(key) == Some(&PropSource::Direct);
    if chain || direct("spaceBefore") || direct("spaceBeforeAuto") {
        meta.image_paragraph_space_before.set(eff.spacing.before);
        if eff.spacing.before_auto {
            meta.image_paragraph_space_before_auto.set(true);
        }
    }
    if chain || direct("spaceAfter") || direct("spaceAfterAuto") {
        meta.image_paragraph_space_after.set(eff.spacing.after);
        if eff.spacing.after_auto {
            meta.image_paragraph_space_after_auto.set(true);
        }
    }
    if rctx.compat.additive_para_spacing {
        meta.image_paragraph_additive_spacing.set(true);
    }
    let line = direct_line_of(&eff);
    if let Some(raw) = line.line_raw_twips {
        meta.image_paragraph_line_twips.set(raw);
        meta.image_paragraph_line_rule
            .assign(match line.line_rule.as_deref() {
                Some("auto") => Some(BlockImageParagraphLineRule::Auto),
                Some("atLeast") => Some(BlockImageParagraphLineRule::AtLeast),
                Some("exact") => Some(BlockImageParagraphLineRule::Exact),
                _ => None,
            });
    }
    // the (m - 1) x single extra under an auto-multiple picture line follows the
    // drawing run's face and size (inherited through the paragraph style), not
    // the paragraph mark's: a Calibri 12 mark over a Book Antiqua 10 style adds
    // 12.1 pt, not 14.65 (Word, two-picture pages)
    let run_start = try_js_regex!(r"<w:r(?:\s[^>]*)?>(?:(?!<\/w:r>)[\s\S])*$")
        .try_exec(leading_xml)
        .map_err(to_thrown)?
        .map(|found| found.start());
    let r_pr = run_start.and_then(|start| r_pr_node_of(&leading_xml[start..]));
    let run = resolve_run_props(
        r_pr.as_ref(),
        eff.style_id.as_deref(),
        eff.bidi,
        rctx,
        false,
    );
    // the mark is the last resort when neither the run chain nor the defaults declare a face
    let font = run
        .fonts
        .ascii
        .clone()
        .or_else(|| eff.mark.fonts.ascii.clone());
    if let Some(font) = font.filter(|font| !font.is_empty()) {
        meta.image_mark_font.set(font);
    }
    let east_asia = run
        .fonts
        .east_asia
        .clone()
        .or_else(|| eff.mark.fonts.east_asia.clone());
    if let Some(east_asia) = east_asia.filter(|face| !face.is_empty()) {
        meta.image_mark_font_east_asia.set(east_asia);
    }
    let declared = |r: &crate::resolve::EffectiveRPr| {
        (r.source.get("sizeHalfPoints") != Some(&PropSource::Builtin)).then_some(r.size_half_points)
    };
    let size = declared(&run).or_else(|| declared(&eff.mark));
    if let Some(size) = size.filter(|size| size.0 != 0.0 && !size.0.is_nan()) {
        meta.image_mark_size_half_points.set(size);
    }
    match eff.align {
        Some("center") => meta.image_align.set(BlockImageAlign::Center),
        Some("right") => meta.image_align.set(BlockImageAlign::Right),
        _ => {}
    }
    // an inline text box starts at the host paragraph's indent like any inline content
    if let Some(left) = g.indent_left_twips.filter(|left| left.0 > 0.0) {
        meta.image_indent_left_twips.set(left);
    }
    Ok(())
}

/// The `if (anchor) { ... }` block of `imageMeta`: wrap, distances, z-order
/// and the position of a floating picture.
fn anchor_meta(meta: &mut ImageMeta, xml: &str, anchor: &str) -> Result<(), Thrown> {
    let wrap_distance = |pattern: &jscompat::JsRegex| {
        let value = number_or_nan(capture(pattern.exec(anchor)));
        value.is_finite().then_some(JsNum(value))
    };
    meta.image_wrap_dist_top_emu
        .assign(wrap_distance(js_regex!(r#"\bdistT\s*=\s*["'](\d+)["']"#)));
    meta.image_wrap_dist_bottom_emu
        .assign(wrap_distance(js_regex!(r#"\bdistB\s*=\s*["'](\d+)["']"#)));
    meta.image_wrap_dist_left_emu
        .assign(wrap_distance(js_regex!(r#"\bdistL\s*=\s*["'](\d+)["']"#)));
    meta.image_wrap_dist_right_emu
        .assign(wrap_distance(js_regex!(r#"\bdistR\s*=\s*["'](\d+)["']"#)));
    if js_regex!(r#"allowOverlap\s*=\s*["'](?:0|false)["']"#).test(anchor) {
        meta.image_no_overlap = true;
    }
    if js_regex!(r#"\blocked\s*=\s*["'](?:1|true)["']"#).test(anchor) {
        meta.image_anchor_locked.set(true);
    }
    // relativeHeight = 251658240 base + zOrder; keep the delta so overlapping
    // anchors round-trip their paint order and the editor can reorder them
    let rel_height = number_or_nan(capture(
        js_regex!(r#"relativeHeight\s*=\s*["'](\d+)["']"#).exec(anchor),
    ));
    if rel_height.is_finite() {
        let z = rel_height - 251_658_240.0;
        if z != 0.0 {
            meta.image_z_order.set(JsNum(z));
        }
    }
    // an explicit wrap element wins over behindDoc: Word draws a
    // behindDoc+wrapTight object behind the text and still wraps around it
    if js_regex!(r#"behindDoc\s*=\s*["']1["']"#).test(anchor)
        && !js_regex!(r"<wp:wrap(Square|Tight|Through|TopAndBottom)").test(xml)
    {
        meta.image_wrap.set(ImageWrap::Behind);
    } else if js_regex!(r"<wp:wrapTopAndBottom").test(xml) {
        meta.image_wrap.set(ImageWrap::TopBottom);
    } else if let Some(kind) = capture(js_regex!(r"<wp:wrap(Square|Tight|Through)").exec(xml)) {
        let align_right = try_js_regex!(
            r"<wp:positionH[^>]*>(?:(?!<\/wp:positionH>)[\s\S])*?<wp:align>right<\/wp:align>"
        )
        .try_test(xml)
        .map_err(to_thrown)?;
        // column-relative only: margin/page align pairs are the position-gallery
        // presets and keep their square wrap (imagePosH/V round-trip)
        let align_center = try_js_regex!(
            r#"<wp:positionH[^>]*relativeFrom\s*=\s*["']column["'][^>]*>(?:(?!<\/wp:positionH>)[\s\S])*?<wp:align>center<\/wp:align>"#
        )
        .try_test(xml)
        .map_err(to_thrown)?;
        // wrapText names the side the text goes on, the object floats opposite;
        // with bothSides, the object's CENTER past mid-body (~4680 twips usable
        // half on Letter/A4) means it hugs the right side
        let wrap_text = capture(
            js_regex!(r#"<wp:wrap(?:Square|Tight|Through)[^>]*wrapText\s*=\s*["']([^"']+)["']"#)
                .exec(xml),
        );
        let pos_h = capture(js_regex!(r"<wp:positionH[^>]*>([\s\S]*?)<\/wp:positionH>").exec(xml))
            .unwrap_or("");
        let off_x = number_or_nan(capture(
            js_regex!(r"<wp:posOffset>(-?\d+)<\/wp:posOffset>").exec(pos_h),
        ));
        let extent_cx = number_or_nan(capture(
            js_regex!(r#"<wp:extent[^>]*\bcx\s*=\s*["'](\d+)["']"#).exec(xml),
        ));
        let center_x = off_x
            + if extent_cx.is_finite() {
                extent_cx / 2.0
            } else {
                0.0
            };
        let left = align_right
            || wrap_text == Some("left")
            || (wrap_text != Some("right") && center_x > 4680.0 * 635.0);
        // centered object wrapping both sides: no both-side wrap in the
        // renderer, so approximate with the topBottom centered slot
        let wrap = if align_center {
            ImageWrap::TopBottom
        } else {
            match (kind, left) {
                ("Tight", true) => ImageWrap::TightRight,
                ("Tight", false) => ImageWrap::TightLeft,
                ("Through", true) => ImageWrap::ThroughRight,
                ("Through", false) => ImageWrap::ThroughLeft,
                (_, true) => ImageWrap::SquareRight,
                (_, false) => ImageWrap::SquareLeft,
            }
        };
        meta.image_wrap.set(wrap);
    } else {
        meta.image_wrap.set(ImageWrap::Front);
    }
    // numeric posOffset for free-position floating images
    let pos_h_body = capture(js_regex!(r"<wp:positionH[^>]*>([\s\S]*?)<\/wp:positionH>").exec(xml))
        .unwrap_or("");
    let pos_v_body = capture(js_regex!(r"<wp:positionV[^>]*>([\s\S]*?)<\/wp:positionV>").exec(xml))
        .unwrap_or("");
    let offset_x = capture(js_regex!(r"<wp:posOffset>(-?\d+)<\/wp:posOffset>").exec(pos_h_body));
    let offset_y = capture(js_regex!(r"<wp:posOffset>(-?\d+)<\/wp:posOffset>").exec(pos_v_body));
    if let Some(offset_x) = offset_x {
        meta.image_offset_x_emu
            .set(JsNum(parse_int(offset_x, Radix::Ten)));
    }
    if let Some(offset_y) = offset_y {
        meta.image_offset_y_emu
            .set(JsNum(parse_int(offset_y, Radix::Ten)));
    }
    // margin-relative wp:align pair = Word position-gallery preset
    let pos_h_from = capture(js_regex!(r#"<wp:positionH[^>]*relativeFrom="([^"]+)""#).exec(xml));
    let pos_v_from = capture(js_regex!(r#"<wp:positionV[^>]*relativeFrom="([^"]+)""#).exec(xml));
    let align_h = capture(js_regex!(r"<wp:align>(left|center|right)<\/wp:align>").exec(pos_h_body));
    let align_v = capture(js_regex!(r"<wp:align>(top|center|bottom)<\/wp:align>").exec(pos_v_body));
    // line-relative offsets measure from the anchor line, paragraph-relative
    // ones from the paragraph top above its spacing-before (the renderer
    // distinguishes them; both default to the hosting paragraph's box)
    if matches!(pos_v_from, Some("page" | "margin" | "line"))
        && offset_y.is_some()
        && align_v.is_none()
    {
        meta.image_rel_v.set(match pos_v_from {
            Some("page") => BlockImageRelV::Page,
            Some("margin") => BlockImageRelV::Margin,
            _ => BlockImageRelV::Line,
        });
    }
    // wp:align on the page/margin bands is a page position like a posOffset
    // (probe 2026-10-29: center/bottom of the margin band = body centre /
    // body bottom, top = the band top); the renderer resolves it on the
    // anchor's page. A column/paragraph-relative keyword aligns in the column.
    if matches!(pos_v_from, Some("page" | "margin"))
        && let Some(align_v) = align_v
        && offset_y.is_none()
    {
        meta.image_rel_v.set(if pos_v_from == Some("page") {
            BlockImageRelV::Page
        } else {
            BlockImageRelV::Margin
        });
        meta.image_pos_v.set(match align_v {
            "top" => BlockImagePosV::Top,
            "center" => BlockImagePosV::Center,
            _ => BlockImagePosV::Bottom,
        });
    }
    if matches!(pos_h_from, Some("page" | "margin")) && offset_x.is_some() && align_h.is_none() {
        meta.image_rel_h.set(if pos_h_from == Some("page") {
            BlockImageRelH::Page
        } else {
            BlockImageRelH::Margin
        });
    }
    if let Some(align_h) = align_h
        && offset_x.is_none()
    {
        if matches!(pos_h_from, Some("page" | "margin")) {
            meta.image_rel_h.set(if pos_h_from == Some("page") {
                BlockImageRelH::Page
            } else {
                BlockImageRelH::Margin
            });
        }
        meta.image_pos_h.set(match align_h {
            "left" => BlockImagePosH::Left,
            "center" => BlockImagePosH::Center,
            _ => BlockImagePosH::Right,
        });
    }
    Ok(())
}

/// `RunPictureAnchor`: the floating geometry an anchored picture carries on
/// `Run.image`, its keys in the order `runPictureAnchorOf` sets them.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPictureAnchor {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap: Option<ImageWrap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset_x_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset_y_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rel_v: Option<RunImageRelV>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rel_h: Option<RunImageRelH>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos_h: Option<RunImagePosH>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos_v: Option<RunImagePosV>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap_dist_top_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap_dist_bottom_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap_dist_left_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap_dist_right_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_center_v: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_overlap: Option<bool>,
}

/// `runPictureAnchorOf`: wrap kind and anchor offsets of a run-level
/// `<w:drawing>` (empty for an in-line picture). The save diffs the editor's
/// geometry against this, so a picture nobody moved keeps its bytes.
pub fn run_picture_anchor_of(drawing_xml: &str) -> Result<RunPictureAnchor, Thrown> {
    let mut anchor = RunPictureAnchor::default();
    if !js_regex!(r"<wp:anchor[\s>]").test(drawing_xml) {
        return Ok(anchor);
    }
    let meta = image_meta(drawing_xml, None)?;
    anchor.wrap = *meta.image_wrap;
    anchor.offset_x_emu = *meta.image_offset_x_emu;
    anchor.offset_y_emu = *meta.image_offset_y_emu;
    anchor.rel_v = meta.image_rel_v.map(|rel| match rel {
        BlockImageRelV::Page => RunImageRelV::Page,
        BlockImageRelV::Margin => RunImageRelV::Margin,
        BlockImageRelV::Line => RunImageRelV::Line,
    });
    anchor.rel_h = meta.image_rel_h.map(|rel| match rel {
        BlockImageRelH::Page => RunImageRelH::Page,
        BlockImageRelH::Margin => RunImageRelH::Margin,
    });
    anchor.pos_h = meta.image_pos_h.map(|pos| match pos {
        BlockImagePosH::Left => RunImagePosH::Left,
        BlockImagePosH::Center => RunImagePosH::Center,
        BlockImagePosH::Right => RunImagePosH::Right,
    });
    anchor.pos_v = meta.image_pos_v.map(|pos| match pos {
        BlockImagePosV::Top => RunImagePosV::Top,
        BlockImagePosV::Center => RunImagePosV::Center,
        BlockImagePosV::Bottom => RunImagePosV::Bottom,
    });
    anchor.wrap_dist_top_emu = *meta.image_wrap_dist_top_emu;
    anchor.wrap_dist_bottom_emu = *meta.image_wrap_dist_bottom_emu;
    anchor.wrap_dist_left_emu = *meta.image_wrap_dist_left_emu;
    anchor.wrap_dist_right_emu = *meta.image_wrap_dist_right_emu;
    // Word centers the object on the anchor line (tdf#162551: the picture
    // juts above the line rather than hanging below it)
    if js_regex!(
        r#"<wp:positionV[^>]*relativeFrom\s*=\s*["']line["'][^>]*>\s*<wp:align>center<\/wp:align>"#
    )
    .test(drawing_xml)
    {
        anchor.line_center_v = Some(true);
    }
    if meta.image_no_overlap {
        anchor.no_overlap = Some(true);
    }
    Ok(anchor)
}
