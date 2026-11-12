//! Anchored-drawing placement of packages/docx-engine/src/parse-drawing-geometry.ts:
//! the line presets, the top-level `<w:drawing>` fragments of a paragraph, the
//! anchor metadata of one fragment, its page/margin-relative position and the
//! child-to-anchor transform of a wpg group.

use jscompat::{JsNum, JsRegex, Radix, index_of, js_regex, math_round, parse_int, to_number};
use ooxml_xml::XNode;
use serde::{Deserialize, Serialize};

use crate::section::SectionSettings;

/// `LINE_PRSTS_RE.source` (the regex has no flags).
pub const LINE_PRSTS_RE_SOURCE: &str =
    r#"<a:prstGeom[^>]*prst="(?:line|straightConnector1|bentConnector[234]|curvedConnector[234])""#;

/// `LINE_PRSTS_RE`
pub fn line_prsts_re() -> &'static JsRegex {
    js_regex!(LINE_PRSTS_RE_SOURCE)
}

/// `LINE_PRSTS`: stroke-only line/connector prsts shown as display boxes
/// despite no text body, in insertion order.
pub const LINE_PRSTS: [&str; 8] = [
    "line",
    "straightConnector1",
    "bentConnector2",
    "bentConnector3",
    "bentConnector4",
    "curvedConnector2",
    "curvedConnector3",
    "curvedConnector4",
];

/// `DrawingAnchorMeta`: anchored-drawing placement of one top-level w:drawing
/// fragment. The fields are in the order `drawingAnchorMeta` sets them, which
/// is the order JSON writes them; `pageXEmu`/`pageYEmu` are never set there.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DrawingAnchorMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchored: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset_x_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset_y_emu: Option<JsNum>,
    /// wp:anchor distL/distR/distT/distB: text clearance around a side-wrapped drawing
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dist_l_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dist_r_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dist_t_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dist_b_emu: Option<JsNum>,
    /// wp:positionH relativeFrom
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rel_h: Option<String>,
    /// wp:align inside wp:positionH
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align_h: Option<String>,
    /// wp14:pctPosHOffset in 1/1000 of a percent of the reference frame
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pct_h: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rel_v: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align_v: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pct_v: Option<JsNum>,
    /// wp:extent (drawing size)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extent_x_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extent_y_emu: Option<JsNum>,
    /// wrapNone (front) / behindDoc anchors leave the text flow entirely
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_wrap: Option<bool>,
    /// behindDoc="1": paints under the body text (z-order only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<bool>,
    /// relativeHeight minus Word's 251658240 base: paint order among overlapping anchors
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z: Option<JsNum>,
    /// wp:wrapTopAndBottom: body text is excluded from the drawing's vertical band
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_bottom: Option<bool>,
    /// layoutInCell="0": a cell-anchored drawing positions against the page/column, not its cell
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outside_cell: Option<bool>,
    /// raw page coordinates for a first-page page-anchored cover drawing
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_x_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_y_emu: Option<JsNum>,
}

/// `drawingOpenAt`: next `<w:drawing>` open tag at or after `from`, attributes
/// tolerated.
fn drawing_open_at(xml: &str, from: usize) -> Option<usize> {
    js_regex!(r"<w:drawing[\s>]")
        .find_from(xml, from)
        .next()
        .map(|found| found.start())
}

/// `topLevelDrawings`: the top-level `<w:drawing>` fragments of a paragraph,
/// balanced (a textbox's txbxContent may nest further drawings, which stay
/// inside their parent fragment).
pub fn top_level_drawings(xml: &str) -> Vec<&str> {
    const CLOSE: &str = "</w:drawing>";
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(start) = drawing_open_at(xml, i) {
        let mut depth: usize = 0;
        let mut j = start;
        loop {
            // j is the offset of a `<`, so j + 1 is a character boundary
            let open = drawing_open_at(xml, j + 1);
            let Some(close) = index_of(xml, CLOSE, j + 1) else {
                // malformed; bail with what we have
                return out;
            };
            match open {
                Some(open) if open < close => {
                    depth += 1;
                    j = open;
                }
                _ if depth > 0 => {
                    depth -= 1;
                    j = close;
                }
                _ => {
                    let end = close + CLOSE.len();
                    out.push(xml.get(start..end).unwrap_or(""));
                    i = end;
                    break;
                }
            }
        }
    }
    out
}

/// `parseInt(m?.[1] ?? '', 10)` of the first match of `pattern` in `text`.
fn int_group(pattern: &JsRegex, text: &str) -> f64 {
    parse_int(
        pattern
            .exec(text)
            .and_then(|found| found.get(1))
            .unwrap_or(""),
        Radix::Ten,
    )
}

/// `Number.isFinite(v) ? v : undefined`
fn finite(v: f64) -> Option<JsNum> {
    v.is_finite().then_some(JsNum(v))
}

/// `drawingAnchorMeta`
pub fn drawing_anchor_meta(frag: &str) -> DrawingAnchorMeta {
    let Some(anchor_tag) = js_regex!(r"<wp:anchor[^>]*>")
        .exec(frag)
        .map(|found| found.as_str())
    else {
        return DrawingAnchorMeta::default();
    };
    let mut meta = DrawingAnchorMeta {
        anchored: Some(true),
        ..DrawingAnchorMeta::default()
    };
    // posOf: `m ? parseInt(m[1], 10) : NaN`, the group always takes part
    meta.offset_x_emu = finite(int_group(
        js_regex!(r"<wp:positionH[^>]*>\s*<wp:posOffset>(-?\d+)</wp:posOffset>"),
        frag,
    ));
    meta.offset_y_emu = finite(int_group(
        js_regex!(r"<wp:positionV[^>]*>\s*<wp:posOffset>(-?\d+)</wp:posOffset>"),
        frag,
    ));
    for (pattern, slot) in [
        (
            js_regex!(r#"\bdistL\s*=\s*["'](\d+)["']"#),
            &mut meta.dist_l_emu,
        ),
        (
            js_regex!(r#"\bdistR\s*=\s*["'](\d+)["']"#),
            &mut meta.dist_r_emu,
        ),
        (
            js_regex!(r#"\bdistT\s*=\s*["'](\d+)["']"#),
            &mut meta.dist_t_emu,
        ),
        (
            js_regex!(r#"\bdistB\s*=\s*["'](\d+)["']"#),
            &mut meta.dist_b_emu,
        ),
    ] {
        let v = int_group(pattern, anchor_tag);
        if v.is_finite() {
            *slot = Some(JsNum(v));
        }
    }
    let positions = [
        (
            js_regex!(r"<wp:positionH\b([^>]*)>([\s\S]*?)</wp:positionH>"),
            js_regex!(r"<wp14:pctPosHOffset[^>]*>(-?\d+)<"),
            (&mut meta.rel_h, &mut meta.align_h, &mut meta.pct_h),
        ),
        (
            js_regex!(r"<wp:positionV\b([^>]*)>([\s\S]*?)</wp:positionV>"),
            js_regex!(r"<wp14:pctPosVOffset[^>]*>(-?\d+)<"),
            (&mut meta.rel_v, &mut meta.align_v, &mut meta.pct_v),
        ),
    ];
    for (block, pct_pattern, (rel_slot, align_slot, pct_slot)) in positions {
        let Some(m) = block.exec(frag) else {
            continue;
        };
        let attrs = m.get(1).unwrap_or("");
        let body = m.get(2).unwrap_or("");
        let rel = js_regex!(r#"relativeFrom\s*=\s*["'](\w+)["']"#)
            .exec(attrs)
            .and_then(|found| found.get(1));
        let align = js_regex!(r"<wp:align>(\w+)<\/wp:align>")
            .exec(body)
            .and_then(|found| found.get(1));
        let pct = int_group(pct_pattern, body);
        *rel_slot = rel.map(str::to_owned);
        *align_slot = align.map(str::to_owned);
        if pct.is_finite() {
            *pct_slot = Some(JsNum(pct));
        }
    }
    let extent_tag = js_regex!(r"<wp:extent[^>]*\/?>")
        .exec(frag)
        .map_or("", |found| found.as_str());
    let extent_x = int_group(js_regex!(r#"\bcx\s*=\s*["'](\d+)["']"#), extent_tag);
    let extent_y = int_group(js_regex!(r#"\bcy\s*=\s*["'](\d+)["']"#), extent_tag);
    if extent_x.is_finite() {
        meta.extent_x_emu = Some(JsNum(extent_x));
    }
    if extent_y.is_finite() {
        meta.extent_y_emu = Some(JsNum(extent_y));
    }
    // the anchor's own wrap element sits before a:graphic; a nested drawing's
    // wrap must not leak up. behindDoc is z-order only: a behind-text picture
    // with wrapTight/wrapSquare/wrapTopAndBottom still excludes the text.
    // The TypeScript looks for wrapNone in the whole fragment, so the one of a
    // nested drawing does leak there (divergences.json: `wrap-none-of-a-nested-drawing`).
    let own_xml = frag
        .find("<a:graphic")
        .map_or(frag, |graphic_at| frag.get(..graphic_at).unwrap_or(frag));
    let behind = js_regex!(r#"behindDoc\s*=\s*["'](?:1|true)["']"#).test(anchor_tag);
    let own_wrapped = js_regex!(r"<wp:wrap(?:Square|Tight|Through|TopAndBottom)\b").test(own_xml);
    if own_xml.contains("<wp:wrapNone") || (behind && !own_wrapped) {
        meta.no_wrap = Some(true);
    }
    if behind {
        meta.behind = Some(true);
    }
    let rel_height = js_regex!(r#"relativeHeight\s*=\s*["'](\d+)["']"#)
        .exec(anchor_tag)
        .and_then(|found| found.get(1))
        .map_or(f64::NAN, to_number);
    if rel_height.is_finite() && rel_height - 251658240.0 != 0.0 {
        meta.z = Some(JsNum(rel_height - 251658240.0));
    }
    if own_xml.contains("<wp:wrapTopAndBottom") {
        meta.top_bottom = Some(true);
    }
    if js_regex!(r#"layoutInCell\s*=\s*["'](?:0|false)["']"#).test(anchor_tag) {
        meta.outside_cell = Some(true);
    }
    meta
}

/// `EMU_PER_TWIP`
pub const EMU_PER_TWIP: f64 = 635.0;

/// `MIN_WRAP_SLIVER_EMU`: narrowest column gap beside a float that Word still
/// fills with text (36px).
pub const MIN_WRAP_SLIVER_EMU: f64 = 36.0 * 9525.0;
/// `DEFAULT_WRAP_DIST_EMU`: Word's default distL/distR clearance (0.125 in).
pub const DEFAULT_WRAP_DIST_EMU: f64 = 114300.0;

/// `ResolvedAnchorPos`: anchor position resolved to EMU offsets from the
/// paragraph flow origin. Fields in the order `resolveAnchorPagePos` writes
/// them: `yEmu` is set after the literal.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAnchorPos {
    pub x_emu: JsNum,
    /// the drawing lies horizontally outside the body column (sidebar layout)
    pub outside_column: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y_emu: Option<JsNum>,
}

/// `resolveAnchorPagePos`: page/margin-anchored placement (wp14:pctPosH/VOffset
/// or wp:align) resolved against the section's page geometry.
pub fn resolve_anchor_page_pos(
    meta: &DrawingAnchorMeta,
    sect: Option<&SectionSettings>,
) -> Option<ResolvedAnchorPos> {
    let sect = sect?;
    // column-relative align in a single-column section: the column IS the margin
    // box, so it resolves identically
    let rel_h =
        if meta.rel_h.as_deref() == Some("column") && sect.columns.0 <= 1.0 && meta.pct_h.is_none()
        {
            Some("margin")
        } else {
            meta.rel_h.as_deref()
        };
    let page = rel_h == Some("page");
    if !page && rel_h != Some("margin") {
        return None;
    }
    if meta.pct_h.is_none() && meta.align_h.is_none() {
        return None;
    }
    let page_w = sect.page_width.0 * EMU_PER_TWIP;
    let mar_l = sect.margin_left.0 * EMU_PER_TWIP;
    let mar_r = sect.margin_right.0 * EMU_PER_TWIP;
    let w = meta.extent_x_emu.map_or(0.0, |w| w.0);
    let ref_w = if page { page_w } else { page_w - mar_l - mar_r };
    let rel_x = match (meta.pct_h, meta.align_h.as_deref()) {
        (Some(pct), _) => math_round((ref_w * pct.0) / 100000.0),
        (None, Some("center")) => math_round((ref_w - w) / 2.0),
        (None, Some("right" | "outside")) => ref_w - w,
        (None, _) => 0.0,
    };
    let page_x = if page { rel_x } else { mar_l + rel_x };
    Some(ResolvedAnchorPos {
        x_emu: JsNum(page_x - mar_l),
        outside_column: page_x + w <= mar_l || page_x >= page_w - mar_r,
        y_emu: resolve_anchor_page_y_emu(meta, Some(sect)).map(JsNum),
    })
}

/// `resolveAnchorPageYEmu`: page/margin-relative V placement as an EMU offset
/// from the body top. `None` for plain posOffset or paragraph/line-relative
/// anchors.
pub fn resolve_anchor_page_y_emu(
    meta: &DrawingAnchorMeta,
    sect: Option<&SectionSettings>,
) -> Option<f64> {
    let sect = sect?;
    let page = meta.rel_v.as_deref() == Some("page");
    if !page && meta.rel_v.as_deref() != Some("margin") {
        return None;
    }
    if meta.pct_v.is_none() && meta.align_v.is_none() {
        return None;
    }
    let page_h = sect.page_height.0 * EMU_PER_TWIP;
    let mar_t = sect.margin_top.0 * EMU_PER_TWIP;
    let mar_b = sect.margin_bottom.0 * EMU_PER_TWIP;
    let h = meta.extent_y_emu.map_or(0.0, |h| h.0);
    let ref_h = if page { page_h } else { page_h - mar_t - mar_b };
    let rel_y = match (meta.pct_v, meta.align_v.as_deref()) {
        (Some(pct), _) => math_round((ref_h * pct.0) / 100000.0),
        (None, Some("center")) => math_round((ref_h - h) / 2.0),
        (None, Some("bottom" | "outside")) => ref_h - h,
        (None, _) => 0.0,
    };
    Some((if page { rel_y } else { mar_t + rel_y }) - mar_t)
}

/// `GroupCtm`: child-EMU to anchor-EMU affine transform of a wpg group
/// (X = tx + x * sx).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GroupCtm {
    pub sx: JsNum,
    pub sy: JsNum,
    pub tx: JsNum,
    pub ty: JsNum,
}

/// `IDENTITY_CTM`
pub const IDENTITY_CTM: GroupCtm = GroupCtm {
    sx: JsNum(1.0),
    sy: JsNum(1.0),
    tx: JsNum(0.0),
    ty: JsNum(0.0),
};

/// `composeGroupCtm`: wpg:wgp / wpg:grpSp xfrm (off/ext vs chOff/chExt)
/// composed onto `outer`.
pub fn compose_group_ctm(group: &XNode, outer: &GroupCtm) -> Option<GroupCtm> {
    let xfrm = group.find_child("wpg:grpSpPr")?.find_child("a:xfrm")?;
    let num = |node: Option<&XNode>, key: &str, dflt: f64| {
        let v = parse_int(
            node.and_then(|node| node.attr(key)).unwrap_or(""),
            Radix::Ten,
        );
        if v.is_finite() { v } else { dflt }
    };
    let ox = num(xfrm.find_child("a:off"), "x", 0.0);
    let oy = num(xfrm.find_child("a:off"), "y", 0.0);
    let ex = num(xfrm.find_child("a:ext"), "cx", 0.0);
    let ey = num(xfrm.find_child("a:ext"), "cy", 0.0);
    let ch_off_x = num(xfrm.find_child("a:chOff"), "x", 0.0);
    let ch_off_y = num(xfrm.find_child("a:chOff"), "y", 0.0);
    let ch_ext_x = num(xfrm.find_child("a:chExt"), "cx", 0.0);
    let ch_ext_y = num(xfrm.find_child("a:chExt"), "cy", 0.0);
    let sx = if ex > 0.0 && ch_ext_x > 0.0 {
        ex / ch_ext_x
    } else {
        1.0
    };
    let sy = if ey > 0.0 && ch_ext_y > 0.0 {
        ey / ch_ext_y
    } else {
        1.0
    };
    Some(GroupCtm {
        sx: JsNum(outer.sx.0 * sx),
        sy: JsNum(outer.sy.0 * sy),
        tx: JsNum(outer.tx.0 + outer.sx.0 * (ox - ch_off_x * sx)),
        ty: JsNum(outer.ty.0 + outer.sy.0 * (oy - ch_off_y * sy)),
    })
}
