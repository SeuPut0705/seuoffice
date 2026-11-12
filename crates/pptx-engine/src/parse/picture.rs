//! The picture section of packages/pptx-engine/src/parse.ts (lines
//! 1171-1742 and 3162-3175): pictures, `a:srcRect`, the user lines and
//! shapes of a chart, `p:graphicFrame` (tables, charts, SmartArt, OLE), the
//! SmartArt drawing preview and `findDescendantPic`.

use jscompat::{
    JsMap, JsNum, Radix, Slot, js_regex, math_max, math_min, math_round, number_to_string,
    number_truthy, parse_float, parse_int, trim, truthy, value_to_string, value_truthy,
};
use serde_json::{Map, Value, json};
use std::sync::Arc;

use super::context::{Node, ParseContext, parse_xml};
use super::decor::int_or;
use super::fill::{
    blip_embed_id, blip_media_ref, parse_bi_level, parse_clr_change, parse_duotone, parse_fill,
    parse_lum, resolve_color_node,
};
use super::shape::{
    lacks_ext, parse_av_lst, parse_glow, parse_reflection, parse_scene3d, parse_shadow,
    parse_sp_shape, parse_stroke, parse_xfrm, with_inherited_ext,
};
use crate::chart::{ResolveFill, UserLine, parse_chart_xml};
use crate::chartex::parse_chart_ex_xml;
use crate::custgeom::parse_cust_geom;
use crate::placeholder::{resolve_placeholder_preset_geom, resolve_placeholder_transform};
use crate::redaction_xml::read_redact_label;
use crate::theme::{Theme, theme_with_override};
use crate::types::{
    ByteAnchor, ChartElement, ElementType, Insets, MediaKind, Paragraph, PassthroughElement,
    PassthroughKind, PictureElement, PictureMedia, SlideElement, TextBody, TextElement, TextRun,
    Transform, assigned,
};

/// `DGM_PARA_BREAK`
const DGM_PARA_BREAK: char = '\u{2029}';

/// `node?.[key]` where `node` is an element: a text or a list has none of
/// the keys read here.
fn get<'a>(node: Node<'a>, key: &str) -> Node<'a> {
    node.and_then(Value::as_object).and_then(|o| o.get(key))
}

/// `node?.[key]` read as a string attribute.
fn attr<'a>(node: Node<'a>, key: &str) -> Option<&'a str> {
    get(node, key).and_then(Value::as_str)
}

/// `Array.isArray(raw) ? raw[0] : raw`
fn first(raw: Node<'_>) -> Node<'_> {
    match raw {
        Some(Value::Array(items)) => items.first(),
        other => other,
    }
}

/// `Array.isArray(raw) ? raw : raw ? [raw] : []`
fn as_list(raw: Node<'_>) -> &[Value] {
    match raw {
        Some(Value::Array(items)) => items.as_slice(),
        Some(value) if value_truthy(Some(value)) => std::slice::from_ref(value),
        _ => &[],
    }
}

/// `node && typeof node === 'object'` over a parsed tree.
fn is_object(node: Node<'_>) -> bool {
    matches!(node, Some(Value::Object(_) | Value::Array(_)))
}

/// `parseInt(v, 10)`
fn int10(v: Node<'_>) -> f64 {
    match v {
        Some(Value::String(text)) => parse_int(text, Radix::Ten),
        other => parse_int(&value_to_string(other), Radix::Ten),
    }
}

/// `(n) => { const v = parseFloat(String(n ?? '')); return Number.isFinite(v) ? v : 0 }`
fn finite_or0(n: Node<'_>) -> f64 {
    let v = match n {
        None | Some(Value::Null) => parse_float(""),
        Some(Value::String(text)) => parse_float(text),
        other => parse_float(&value_to_string(other)),
    };
    if v.is_finite() { v } else { 0.0 }
}

/// `{ ...v }`: an object's own keys, a list's or a text's indices (one
/// UTF-16 unit each), nothing for anything else. Indices only appear for a
/// text or a list where the parser gave an element, and nothing reads them.
fn spread(v: Node<'_>) -> Map<String, Value> {
    match v {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(i, item)| (i.to_string(), item.clone()))
            .collect(),
        Some(Value::String(text)) => text
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| {
                (
                    i.to_string(),
                    Value::String(String::from_utf16_lossy(&[unit])),
                )
            })
            .collect(),
        _ => Map::new(),
    }
}

/// `key ? map?.get(String(key)) : undefined`
fn lookup<'m, V>(map: Option<&'m JsMap<V>>, key: Node<'_>) -> Option<&'m V> {
    if !value_truthy(key) {
        return None;
    }
    map?.get(&value_to_string(key))
}

/// `parsePicture`
pub(super) fn parse_picture(
    node: Node<'_>,
    anchor: ByteAnchor,
    ctx: &ParseContext<'_>,
    raw_xml: Option<&str>,
) -> Result<PictureElement, String> {
    let empty = Value::Object(Map::new());
    let sp_pr = Some(get(node, "p:spPr").unwrap_or(&empty));
    let xfrm = get(sp_pr, "a:xfrm");
    let mut transform = parse_xfrm(xfrm);
    // Pictures dropped into a placeholder may omit <a:xfrm> entirely; geometry comes from layout/master
    let pic_ph = get(get(get(node, "p:nvPicPr"), "p:nvPr"), "p:ph");
    let ph_type = attr(pic_ph, "@_type");
    let ph_idx = attr(pic_ph, "@_idx");
    if value_truthy(pic_ph) && lacks_ext(xfrm) {
        let inherited = resolve_placeholder_transform(
            ctx.layout_placeholders,
            ctx.master_placeholders,
            ph_type,
            ph_idx,
        );
        if let Some(inherited) = inherited {
            transform = with_inherited_ext(xfrm, transform, inherited);
        }
    }
    let blip_fill = get(node, "p:blipFill");
    let blip = get(blip_fill, "a:blip");
    let embed_id = blip_embed_id(blip);
    let media_ref = blip_media_ref(blip, embed_id, ctx);
    let c_nv_pr = get(get(node, "p:nvPicPr"), "p:cNvPr");
    let name = attr(c_nv_pr, "@_name");
    let descr = attr(c_nv_pr, "@_descr");
    let src_rect = parse_src_rect(get(blip_fill, "a:srcRect"));
    let prst_geom = get(sp_pr, "a:prstGeom");
    let mut pic_geom = attr(prst_geom, "@_prst");
    let mut pic_adjust = parse_av_lst(get(prst_geom, "a:avLst"));
    // Placeholder pictures without their own geometry clip to the layout/master
    // placeholder's shape (e.g. a parallelogram picture placeholder)
    if truthy(pic_geom).is_none() && !value_truthy(get(sp_pr, "a:custGeom")) && value_truthy(pic_ph)
    {
        let inherited_geom = resolve_placeholder_preset_geom(
            ctx.layout_placeholders,
            ctx.master_placeholders,
            ph_type,
            ph_idx,
        );
        if let Some(inherited_geom) = inherited_geom {
            pic_geom = Some(inherited_geom.prst.as_str());
            pic_adjust = parse_av_lst(inherited_geom.av_lst_raw.as_ref());
        }
    }
    let custom_geometry = if get(sp_pr, "a:custGeom").is_some() {
        parse_cust_geom(
            truthy(raw_xml).unwrap_or(&anchor.original_xml),
            transform.offset.cx.0,
            transform.offset.cy.0,
        )
        .map_err(|limit| limit.to_string())?
    } else {
        None
    };
    let scene3d = parse_scene3d(sp_pr, ctx);
    let soft_edge_rad = get(get(get(sp_pr, "a:effectLst"), "a:softEdge"), "@_rad");
    let alpha_amt = get(get(blip, "a:alphaModFix"), "@_amt");
    let opacity = alpha_amt.map(|amt| math_max(0.0, math_min(1.0, int10(Some(amt)) / 100000.0)));
    let stroke = parse_stroke(sp_pr, ctx, None).flatten();
    let shadow = parse_shadow(sp_pr, ctx);
    let glow = parse_glow(sp_pr, ctx);
    let reflection = parse_reflection(sp_pr);
    let redact = read_redact_label(sp_pr);
    // Pic's own spPr fill: PowerPoint draws it as a backdrop behind the (possibly translucent) blip
    let fill = parse_fill(sp_pr, ctx);
    let duotone = parse_duotone(blip, ctx);
    let clr_change = parse_clr_change(blip, ctx);
    let lum = parse_lum(blip);
    let bi_level = parse_bi_level(blip);
    let nv_pr = get(get(node, "p:nvPicPr"), "p:nvPr");
    let video = get(nv_pr, "a:videoFile");
    let av_node = video.or_else(|| get(nv_pr, "a:audioFile"));
    let media = if let Some(av_node) = av_node {
        let kind = if video.is_some() {
            MediaKind::Video
        } else {
            MediaKind::Audio
        };
        let rel = lookup(ctx.av_rels, get(Some(av_node), "@_r:link"));
        Some(PictureMedia {
            kind,
            target: rel.map(|rel| rel.target.clone()),
            external: rel.and_then(|rel| (rel.external == Some(true)).then_some(true)),
        })
    } else {
        let embed = as_list(get(get(nv_pr, "p:extLst"), "p:ext"))
            .iter()
            .find_map(|e| get(get(Some(e), "p14:media"), "@_r:embed"));
        let rel = embed.and_then(|embed| ctx.av_rels?.get(&value_to_string(Some(embed))));
        rel.map(|rel| {
            let kind = if js_regex!(r"\.(mp3|wav|m4a|aac|ogg|flac|wma)$", "i").test(&rel.target) {
                MediaKind::Audio
            } else {
                MediaKind::Video
            };
            PictureMedia {
                kind,
                target: Some(rel.target.clone()),
                external: (rel.external == Some(true)).then_some(true),
            }
        })
    };
    let tile = matches!(blip_fill, Some(Value::Object(map)) if map.contains_key("a:tile"));
    let geometry = truthy(pic_geom).filter(|geom| *geom != "rect");
    Ok(PictureElement {
        id: Slot::of(ctx.uid("pic")),
        r#type: Slot::of(ElementType::Picture),
        anchor: Slot::of(anchor),
        transform: Slot::of(transform),
        name: assigned(name.map(str::to_owned)),
        descr: Slot::maybe(truthy(descr).map(str::to_owned)),
        redact: Slot::maybe(truthy(redact).map(str::to_owned)),
        media_ref: Slot::of(media_ref.to_owned()),
        src_rect: Slot::maybe(src_rect),
        tile: Slot::maybe(tile.then_some(true)),
        preset_geometry: Slot::maybe(geometry.map(str::to_owned)),
        adjust: Slot::maybe(if geometry.is_some() { pic_adjust } else { None }),
        custom_geometry: Slot::maybe(custom_geometry),
        scene3d: Slot::maybe(scene3d),
        opacity: Slot::maybe(opacity.filter(|o| *o < 1.0).map(JsNum)),
        soft_edge: Slot::maybe(soft_edge_rad.map(|rad| JsNum(int_or(Some(rad), 0.0)))),
        media: Slot::maybe(media),
        fill: Slot::maybe(fill),
        duotone: Slot::maybe(duotone),
        clr_change: Slot::maybe(clr_change),
        lum: Slot::maybe(lum),
        bi_level: Slot::maybe(bi_level.map(JsNum)),
        stroke: Slot::maybe(stroke),
        shadow: Slot::maybe(shadow),
        glow: Slot::maybe(glow),
        reflection: Slot::maybe(reflection),
        ..PictureElement::default()
    })
}

/// `parseSrcRect`: `<a:srcRect l/t/r/b>` (1/1000 %) as 0..1 fractions; all
/// zero is `None`.
fn parse_src_rect(sr: Node<'_>) -> Option<Insets> {
    if !value_truthy(sr) || !is_object(sr) {
        return None;
    }
    let f = |k: &str| int_or(get(sr, k), 0.0) / 100000.0;
    let rect = Insets {
        l: JsNum(f("@_l")),
        t: JsNum(f("@_t")),
        r: JsNum(f("@_r")),
        b: JsNum(f("@_b")),
    };
    if !number_truthy(rect.l.0)
        && !number_truthy(rect.t.0)
        && !number_truthy(rect.r.0)
        && !number_truthy(rect.b.0)
    {
        return None;
    }
    Some(rect)
}

/// `parseChartUserLines`: the straight lines of a chart's user shapes
/// (`cdr:relSizeAnchor` from/to are fractions of the chart frame).
fn parse_chart_user_lines(us_xml: &str, ctx: &ParseContext<'_>) -> Vec<UserLine> {
    let Ok(doc) = parse_xml(us_xml) else {
        return Vec::new();
    };
    let anchors = as_list(get(get(Some(&doc), "c:userShapes"), "cdr:relSizeAnchor"));
    let mut out = Vec::new();
    for a in anchors {
        let a = Some(a);
        let sp = first(get(a, "cdr:sp"));
        let sp_pr = get(sp, "cdr:spPr");
        let prst = attr(get(sp_pr, "a:prstGeom"), "@_prst");
        if prst != Some("line") && prst != Some("straightConnector1") {
            continue;
        }
        let Some(color) = resolve_color_node(get(get(sp_pr, "a:ln"), "a:solidFill"), ctx)
            .filter(|color| !color.is_empty())
        else {
            continue;
        };
        let w = int10(get(get(sp_pr, "a:ln"), "@_w"));
        out.push(UserLine {
            x1: JsNum(finite_or0(get(get(a, "cdr:from"), "cdr:x"))),
            y1: JsNum(finite_or0(get(get(a, "cdr:from"), "cdr:y"))),
            x2: JsNum(finite_or0(get(get(a, "cdr:to"), "cdr:x"))),
            y2: JsNum(finite_or0(get(get(a, "cdr:to"), "cdr:y"))),
            color,
            width_emu: JsNum(if w.is_finite() && w > 0.0 { w } else { 9525.0 }),
        });
    }
    out
}

/// The slide rectangle a user shape of a chart is mapped to.
struct UserShapeRect {
    x: f64,
    y: f64,
    cx: f64,
    cy: f64,
}

/// `parseChartUserShapes`: the text boxes and shapes of a chart's user
/// shapes (anything but the straight lines above), anchored by frame
/// fractions (`relSizeAnchor`) or fractions and an EMU extent
/// (`absSizeAnchor`), mapped into slide coordinates and read as `p:sp`.
fn parse_chart_user_shapes(
    us_xml: &str,
    frame: &Transform,
    anchor: &ByteAnchor,
    ctx: &ParseContext<'_>,
) -> Result<Vec<TextElement>, String> {
    let Ok(doc) = parse_xml(us_xml) else {
        return Ok(Vec::new());
    };
    let root = get(Some(&doc), "c:userShapes");
    let (fx0, fy0, fcx, fcy) = (
        frame.offset.x.0,
        frame.offset.y.0,
        frame.offset.cx.0,
        frame.offset.cy.0,
    );
    if !value_truthy(root) || !number_truthy(fcx) || !number_truthy(fcy) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut build = |a: Node<'_>, rect: UserShapeRect| -> Result<(), String> {
        for sp in as_list(get(a, "cdr:sp")) {
            let sp = Some(sp);
            let sp_pr = get(sp, "cdr:spPr");
            let prst = attr(get(sp_pr, "a:prstGeom"), "@_prst");
            if prst == Some("line") || prst == Some("straightConnector1") {
                continue;
            }
            if rect.cx <= 0.0 || rect.cy <= 0.0 {
                continue;
            }
            let xfrm = get(sp_pr, "a:xfrm");
            let nv = get(sp, "cdr:nvSpPr");
            let mut nv_sp_pr = Map::new();
            nv_sp_pr.insert(
                "p:cNvPr".to_owned(),
                get(nv, "cdr:cNvPr").cloned().unwrap_or_else(|| json!({})),
            );
            nv_sp_pr.insert(
                "p:cNvSpPr".to_owned(),
                get(nv, "cdr:cNvSpPr").cloned().unwrap_or_else(|| json!({})),
            );
            nv_sp_pr.insert("p:nvPr".to_owned(), json!({}));
            let mut new_xfrm = Map::new();
            for key in ["@_rot", "@_flipH", "@_flipV"] {
                let v = get(xfrm, key);
                if let Some(v) = v.filter(|v| value_truthy(Some(*v))) {
                    new_xfrm.insert(key.to_owned(), v.clone());
                }
            }
            new_xfrm.insert(
                "a:off".to_owned(),
                json!({
                    "@_x": number_to_string(math_round(rect.x)),
                    "@_y": number_to_string(math_round(rect.y)),
                }),
            );
            new_xfrm.insert(
                "a:ext".to_owned(),
                json!({
                    "@_cx": number_to_string(math_round(rect.cx)),
                    "@_cy": number_to_string(math_round(rect.cy)),
                }),
            );
            let mut new_sp_pr = spread(sp_pr);
            new_sp_pr.insert("a:xfrm".to_owned(), Value::Object(new_xfrm));
            let mut p_node = Map::new();
            p_node.insert("p:nvSpPr".to_owned(), Value::Object(nv_sp_pr));
            p_node.insert("p:spPr".to_owned(), Value::Object(new_sp_pr));
            if let Some(style) = get(sp, "cdr:style").filter(|v| value_truthy(Some(*v))) {
                p_node.insert("p:style".to_owned(), style.clone());
            }
            if let Some(tx_body) = get(sp, "cdr:txBody").filter(|v| value_truthy(Some(*v))) {
                p_node.insert("p:txBody".to_owned(), tx_body.clone());
            }
            let p_node = Value::Object(p_node);
            let el = parse_sp_shape(Some(&p_node), anchor.clone(), ctx, None)?;
            if matches!(*el.r#type, Some(ElementType::Text | ElementType::Shape)) {
                out.push(el);
            }
        }
        Ok(())
    };
    for a in as_list(get(root, "cdr:relSizeAnchor")) {
        let a = Some(a);
        let fx = finite_or0(get(get(a, "cdr:from"), "cdr:x"));
        let fy = finite_or0(get(get(a, "cdr:from"), "cdr:y"));
        let tx = finite_or0(get(get(a, "cdr:to"), "cdr:x"));
        let ty = finite_or0(get(get(a, "cdr:to"), "cdr:y"));
        build(
            a,
            UserShapeRect {
                x: fx0 + fx * fcx,
                y: fy0 + fy * fcy,
                cx: (tx - fx) * fcx,
                cy: (ty - fy) * fcy,
            },
        )?;
    }
    for a in as_list(get(root, "cdr:absSizeAnchor")) {
        let a = Some(a);
        let fx = finite_or0(get(get(a, "cdr:from"), "cdr:x"));
        let fy = finite_or0(get(get(a, "cdr:from"), "cdr:y"));
        build(
            a,
            UserShapeRect {
                x: fx0 + fx * fcx,
                y: fy0 + fy * fcy,
                cx: finite_or0(get(get(a, "cdr:ext"), "@_cx")),
                cy: finite_or0(get(get(a, "cdr:ext"), "@_cy")),
            },
        )?;
    }
    Ok(out)
}

/// `graphicFramePassthrough`
pub(super) fn graphic_frame_passthrough(
    node: Node<'_>,
    anchor: ByteAnchor,
    ctx: &ParseContext<'_>,
) -> Result<SlideElement, String> {
    let data = get(get(node, "a:graphic"), "a:graphicData");
    let uri = attr(data, "@_uri").unwrap_or("");
    // Table: semantic parsing (read-only render; save still uses the anchor's original bytes)
    if uri.contains("/table") && value_truthy(get(data, "a:tbl")) {
        let table = super::table::parse_table(node, get(data, "a:tbl"), anchor.clone(), ctx)?;
        if let Some(table) = table {
            return Ok(SlideElement::Table(Box::new(table)));
        }
    }
    // chartEx (cx namespace, e.g. funnel/sunburst): same read-only semantics as classic charts
    if uri.contains("/chartex") {
        let rid = get(get(data, "cx:chart"), "@_r:id");
        let chart_xml = lookup(ctx.chart_xmls, rid);
        let ov_xml = lookup(ctx.chart_theme_overrides, rid);
        let override_theme: Option<Theme> = match truthy(ov_xml.map(String::as_str)) {
            Some(ov_xml) => Some(theme_with_override(ctx.theme, ov_xml)?),
            None => None,
        };
        let chart_theme = override_theme.as_ref().or(ctx.theme);
        let model = match truthy(chart_xml.map(String::as_str)) {
            Some(chart_xml) => parse_chart_ex_xml(chart_xml, chart_theme)?,
            None => None,
        };
        if let Some(model) = model {
            let c_nv_pr = get(get(node, "p:nvGraphicFramePr"), "p:cNvPr");
            return Ok(SlideElement::Chart(Box::new(ChartElement {
                id: Slot::of(ctx.uid("chart")),
                r#type: Slot::of(ElementType::Chart),
                anchor: Slot::of(anchor),
                transform: Slot::of(parse_xfrm(get(node, "p:xfrm"))),
                name: assigned(attr(c_nv_pr, "@_name").map(str::to_owned)),
                chart: Slot::of(model),
                ..ChartElement::default()
            })));
        }
    }
    // Chart: read the referenced chart part for semantic parsing (read-only render; save uses original bytes)
    if uri.contains("/chart") {
        let rid = get(get(data, "c:chart"), "@_r:id");
        let rid_text = value_to_string(rid);
        let chart_xml = lookup(ctx.chart_xmls, rid);
        let ov_xml = lookup(ctx.chart_theme_overrides, rid);
        let override_theme: Option<Theme> = match truthy(ov_xml.map(String::as_str)) {
            Some(ov_xml) => Some(theme_with_override(ctx.theme, ov_xml)?),
            None => None,
        };
        let chart_theme = override_theme.as_ref().or(ctx.theme);
        // Fill resolver bound to the chart part's own rels (blip rIds live there, not on
        // the slide) and to the chart-local theme (accents may be remapped per chart)
        let chart_fill_ctx = ParseContext {
            media_rels: ctx.chart_media_rels.and_then(|rels| rels.get(&rid_text)),
            theme: chart_theme,
            ..*ctx
        };
        let resolve_fill: ResolveFill<'_> = &|sp_pr| parse_fill(sp_pr, &chart_fill_ctx);
        let mut model = match truthy(chart_xml.map(String::as_str)) {
            Some(chart_xml) => parse_chart_xml(chart_xml, chart_theme, Some(resolve_fill))?,
            None => None,
        };
        if let Some(model) = model.as_mut()
            && ctx
                .chart_style_rels
                .is_some_and(|rels| rels.contains(&rid_text))
        {
            model.has_style_part.set(true);
        }
        let mut user_shapes: Vec<TextElement> = Vec::new();
        let frame_xfrm = parse_xfrm(get(node, "p:xfrm"));
        if let Some(model) = model.as_mut() {
            let us_xml = lookup(ctx.chart_user_shapes, rid);
            if let Some(us_xml) = truthy(us_xml.map(String::as_str)) {
                let lines = parse_chart_user_lines(us_xml, ctx);
                if !lines.is_empty() {
                    model.user_lines.set(lines);
                }
                user_shapes = parse_chart_user_shapes(us_xml, &frame_xfrm, &anchor, ctx)?;
            }
        }
        if let Some(model) = model {
            let c_nv_pr = get(get(node, "p:nvGraphicFramePr"), "p:cNvPr");
            let descr = truthy(attr(c_nv_pr, "@_descr"));
            return Ok(SlideElement::Chart(Box::new(ChartElement {
                id: Slot::of(ctx.uid("chart")),
                r#type: Slot::of(ElementType::Chart),
                anchor: Slot::of(anchor),
                transform: Slot::of(frame_xfrm),
                name: assigned(attr(c_nv_pr, "@_name").map(str::to_owned)),
                descr: Slot::maybe(descr.map(str::to_owned)),
                chart: Slot::of(model),
                user_shapes: Slot::maybe((!user_shapes.is_empty()).then_some(user_shapes)),
                ..ChartElement::default()
            })));
        }
    }
    let kind = if uri.contains("/table") {
        PassthroughKind::Table
    } else if uri.contains("/chart") {
        PassthroughKind::Chart
    } else if uri.contains("/diagram") || uri.contains("SmartArt") {
        PassthroughKind::Smartart
    } else if uri.contains("/ole") {
        PassthroughKind::Ole
    } else {
        PassthroughKind::Unknown
    };
    let transform = parse_xfrm(get(node, "p:xfrm"));
    // The OLE preview picture holds the anchor too; no other kind reads it again.
    let (el_anchor, ole_anchor) = if kind == PassthroughKind::Ole {
        (anchor.clone(), Some(anchor))
    } else {
        (anchor, None)
    };
    let mut el = PassthroughElement {
        id: Slot::of(ctx.uid("gf")),
        r#type: Slot::of(ElementType::Passthrough),
        anchor: Slot::of(el_anchor),
        transform: Slot::of(transform),
        kind: Slot::of(kind),
        ..PassthroughElement::default()
    };
    // SmartArt read-only preview: dgm:relIds@r:dm → prerendered drawing part (assembled in index.ts)
    if kind == PassthroughKind::Smartart {
        let rel_ids = get(data, "dgm:relIds");
        let dm = get(rel_ids, "@_r:dm");
        let drawing_xml = lookup(ctx.diagram_drawings, dm);
        if let Some(drawing_xml) = truthy(drawing_xml.map(String::as_str)) {
            // Picture-fill rIds inside the drawing resolve against the drawing part's own rels
            let drawing_rels = lookup(ctx.diagram_media_rels, dm);
            // PowerPoint re-renders SmartArt from data+colors, so the drawing part's cached
            // text color can be stale: resolve the truth per modelId from the color part
            let cs_rel = get(rel_ids, "@_r:cs");
            let tx_colors = diagram_text_colors(
                lookup(ctx.diagram_datas, dm).map(String::as_str),
                lookup(ctx.diagram_colors, cs_rel).map(String::as_str),
                ctx,
            );
            let drawing_ctx;
            let shapes = parse_diagram_drawing(
                drawing_xml,
                match drawing_rels {
                    Some(rels) => {
                        drawing_ctx = ParseContext {
                            media_rels: Some(rels),
                            ..*ctx
                        };
                        &drawing_ctx
                    }
                    None => ctx,
                },
                Some(&tx_colors),
            )?;
            // A single text-less shape is a stub (writers emit just a background rect);
            // fall through to the layout fallback instead of drawing one giant block
            let meaningful = shapes.len() > 1 || shapes.iter().any(has_visible_text);
            if !shapes.is_empty() && meaningful {
                el.preview_shapes.set(shapes);
            }
        }
        if (*el.preview_shapes).as_ref().is_none_or(Vec::is_empty) {
            // No prerendered drawing, or an empty one (unfinished writers): lay the
            // node tree out ourselves, dispatched on the layout part's uniqueId
            let data_xml = lookup(ctx.diagram_datas, dm);
            if let Some(data_xml) = truthy(data_xml.map(String::as_str)) {
                let lo = get(rel_ids, "@_r:lo");
                let cs = get(rel_ids, "@_r:cs");
                let layout_xml = lookup(ctx.diagram_layouts, lo).map(String::as_str);
                let unique_id = truthy(layout_xml)
                    .and_then(|layout_xml| js_regex!(r#"\buniqueId="([^"]+)""#).exec(layout_xml))
                    .and_then(|m| m.get(1))
                    .and_then(|id| id.split('/').next_back());
                let colors_xml = lookup(ctx.diagram_colors, cs).map(String::as_str);
                let shapes = super::diagram::layout_diagram_fallback(
                    data_xml,
                    ctx,
                    transform.offset.cx.0,
                    transform.offset.cy.0,
                    unique_id,
                    colors_xml,
                    layout_xml,
                )?;
                if !shapes.is_empty() {
                    el.preview_shapes.set(shapes);
                }
            }
        }
    }
    // OLE read-only preview: p:pic embedded in graphicData (often inside mc:AlternateContent/mc:Fallback),
    // or, in legacy converted decks, a VML shape keyed by the oleObj spid (v:imagedata, usually WMF/EMF)
    if let Some(anchor) = ole_anchor {
        // A substitute pic without a blip (Aspose writes an empty one) must not
        // short-circuit the VML spid preview path
        let pic = find_descendant_pic(data, 0);
        let has_blip = get(get(get(pic, "p:blipFill"), "a:blip"), "@_r:embed").is_some();
        if value_truthy(pic) && has_blip {
            el.preview_picture
                .set(parse_picture(pic, anchor, ctx, None)?);
        } else {
            let alternate = get(data, "mc:AlternateContent");
            let ole_obj = get(data, "p:oleObj")
                .or_else(|| get(get(alternate, "mc:Choice"), "p:oleObj"))
                .or_else(|| get(get(alternate, "mc:Fallback"), "p:oleObj"));
            let spid = get(ole_obj, "@_spid");
            let media_ref =
                spid.and_then(|spid| ctx.vml_previews?.get(&value_to_string(Some(spid))));
            if let Some(media_ref) = truthy(media_ref.map(String::as_str)) {
                el.preview_picture.set(PictureElement {
                    id: Slot::of(ctx.uid("olepic")),
                    r#type: Slot::of(ElementType::Picture),
                    anchor: Slot::of(anchor),
                    transform: Slot::of(transform),
                    media_ref: Slot::of(media_ref.to_owned()),
                    ..PictureElement::default()
                });
            }
        }
    }
    Ok(SlideElement::Passthrough(Box::new(el)))
}

/// `sh.text?.paragraphs?.some((par) => par.runs?.some((r) => r.text?.trim()))`
fn has_visible_text(sh: &SlideElement) -> bool {
    let SlideElement::Text(el) = sh else {
        return false;
    };
    let Some(body) = &*el.text else {
        return false;
    };
    (*body.paragraphs).iter().flatten().any(|par| {
        (*par.runs)
            .iter()
            .flatten()
            .any(|r| (*r.text).as_deref().is_some_and(|t| !trim(t).is_empty()))
    })
}

/// `diagramTextColors`: SmartArt text color truth, dsp modelId to the
/// diagram colors part's styleLbl txFillClrLst color, through the data
/// part's presentation points (presStyleLbl).
fn diagram_text_colors(
    data_xml: Option<&str>,
    colors_xml: Option<&str>,
    ctx: &ParseContext<'_>,
) -> JsMap<String> {
    let mut out = JsMap::new();
    let (Some(data_xml), Some(colors_xml)) = (truthy(data_xml), truthy(colors_xml)) else {
        return out;
    };
    let mut lbl_color: JsMap<String> = JsMap::new();
    for m in js_regex!(r#"<dgm:styleLbl name="([^"]+)">([\s\S]*?)<\/dgm:styleLbl>"#)
        .find_iter(colors_xml)
    {
        let lst = js_regex!(r"<dgm:txFillClrLst[^>]*>([\s\S]*?)<\/dgm:txFillClrLst>")
            .exec(m.get(2).unwrap_or_default())
            .and_then(|lst| lst.get(1));
        let Some(lst) = truthy(lst) else {
            continue;
        };
        let Some(cm) =
            js_regex!(r#"<a:schemeClr val="([^"]+)"|<a:srgbClr val="([^"]+)""#).exec(lst)
        else {
            continue;
        };
        let c = match truthy(cm.get(1)) {
            Some(scheme) => {
                resolve_color_node(Some(&json!({ "a:schemeClr": { "@_val": scheme } })), ctx)
            }
            None => Some(format!(
                "#{}",
                cm.get(2).unwrap_or("undefined").to_uppercase()
            )),
        };
        if let Some(c) = c.filter(|c| !c.is_empty()) {
            lbl_color.set(m.get(1).unwrap_or_default(), c);
        }
    }
    if lbl_color.is_empty() {
        return out;
    }
    for m in
        js_regex!(r#"<dgm:pt modelId="([^"]+)" type="pres"[\s\S]*?<\/dgm:pt>"#).find_iter(data_xml)
    {
        let lbl = js_regex!(r#"presStyleLbl="([^"]+)""#)
            .exec(m.as_str())
            .and_then(|lbl| lbl.get(1));
        let c = truthy(lbl).and_then(|lbl| lbl_color.get(lbl));
        if let Some(c) = c.filter(|c| !c.is_empty()) {
            // decoded: looked up by the drawing shape's modelId, which the parser reads
            out.set(
                crate::xml_utils::decode_xml(m.get(1).unwrap_or_default()),
                c.clone(),
            );
        }
    }
    out
}

/// `parseDiagramDrawing`: SmartArt's prerendered drawing part
/// (diagrams/drawingN.xml, dsp namespace) as read-only shapes. dsp:sp is
/// isomorphic to p:sp, so after a prefix swap the p:sp reader is reused.
fn parse_diagram_drawing(
    drawing_xml: &str,
    parent_ctx: &ParseContext<'_>,
    tx_colors: Option<&JsMap<String>>,
) -> Result<Vec<SlideElement>, String> {
    // SmartArt text inherits from the diagram's own text styles (theme minor font), not the
    // presentation defaultTextStyle
    let ctx = ParseContext {
        default_text_style: None,
        ..*parent_ctx
    };
    // Hard returns inside one a:t are paragraph breaks in SmartArt, marked before
    // parsing so they stay apart from the <a:br/> soft-break sentinel.
    let xml = js_regex!(r"<(\/?)dsp:").replace_all(drawing_xml, |m| {
        format!("<{}p:", m.get(1).unwrap_or_default())
    });
    let xml = js_regex!(r"<a:t(\s[^>]*)?>([^<]*\n[^<]*)<\/a:t>").replace_all(&xml, |m| {
        let attrs = m.get(1).unwrap_or_default();
        let t = js_regex!(r"\r?\n")
            .replace_all(m.get(2).unwrap_or_default(), |_| DGM_PARA_BREAK.to_string());
        format!("<a:t{attrs}>{t}</a:t>")
    });
    let Ok(doc) = parse_xml(&xml) else {
        return Ok(Vec::new());
    };
    let sp_tree = get(get(Some(&doc), "p:drawing"), "p:spTree");
    if !value_truthy(sp_tree) {
        return Ok(Vec::new());
    }
    let sps = as_list(get(sp_tree, "p:sp"));
    let mut out: Vec<TextElement> = Vec::new();
    for sp in sps {
        // The preview layer has no byte fidelity (never written back); the anchor is a placeholder
        let anchor = ByteAnchor {
            sp_index: -1,
            original_xml: Arc::from(""),
            range: [0, 0],
            gap_after: None,
        };
        // Text color truth comes from the color part (see diagramTextColors); explicit run
        // colors in the txBody still win since the fontRef is only the inherited fallback
        let model_id =
            get(Some(sp), "@_modelId").map_or_else(String::new, |id| value_to_string(Some(id)));
        let tx_c = tx_colors.and_then(|colors| colors.get(&model_id));
        let recolored;
        let sp = match tx_c.filter(|c| !c.is_empty()) {
            Some(tx_c) if value_truthy(get(Some(sp), "p:txBody")) => {
                let mut style = spread(get(Some(sp), "p:style"));
                style.insert(
                    "a:fontRef".to_owned(),
                    json!({ "@_idx": "minor", "a:srgbClr": { "@_val": tx_c.replacen('#', "", 1) } }),
                );
                let mut next = spread(Some(sp));
                next.insert("p:style".to_owned(), Value::Object(style));
                recolored = Value::Object(next);
                &recolored
            }
            _ => sp,
        };
        // dsp:txXfrm gives the text its own frame; split text off the shape so both
        // render with their proper transforms (text rotation is shape rot + txXfrm rot)
        let tx_xfrm = get(Some(sp), "p:txXfrm");
        let tx_body = get(Some(sp), "p:txBody");
        if value_truthy(tx_xfrm) && is_object(tx_xfrm) && value_truthy(tx_body) {
            let shape_only = Value::Object(
                spread(Some(sp))
                    .into_iter()
                    .filter(|(key, _)| key != "p:txBody")
                    .collect(),
            );
            let shape_el = parse_sp_shape(Some(&shape_only), anchor.clone(), &ctx, None)?;
            if *shape_el.r#type != Some(ElementType::Passthrough) {
                out.push(shape_el);
            }
            let rot = |v: Node<'_>| {
                let n = match v {
                    Some(v) => int10(Some(v)),
                    None => parse_int("0", Radix::Ten),
                };
                if number_truthy(n) { n } else { 0.0 }
            };
            let sp_rot = rot(get(get(get(Some(sp), "p:spPr"), "a:xfrm"), "@_rot"));
            let tx_rot = rot(get(tx_xfrm, "@_rot"));
            let mut text_xfrm = spread(tx_xfrm);
            text_xfrm.insert(
                "@_rot".to_owned(),
                Value::String(number_to_string(sp_rot + tx_rot)),
            );
            // Keep fontRef for the text color only. Copying the whole p:style still
            // applies effectRef, so the split text frame would redraw the shape's shadow/glow.
            let font_ref = get(get(Some(sp), "p:style"), "a:fontRef");
            let mut text_sp = Map::new();
            if let Some(nv_sp_pr) = get(Some(sp), "p:nvSpPr") {
                text_sp.insert("p:nvSpPr".to_owned(), nv_sp_pr.clone());
            }
            text_sp.insert(
                "p:spPr".to_owned(),
                json!({
                    "a:xfrm": Value::Object(text_xfrm),
                    "a:prstGeom": { "@_prst": "rect" },
                    "a:noFill": {},
                    "a:ln": { "a:noFill": {} },
                }),
            );
            if let Some(font_ref) = font_ref.filter(|v| value_truthy(Some(*v))) {
                text_sp.insert("p:style".to_owned(), json!({ "a:fontRef": font_ref }));
            }
            if let Some(tx_body) = tx_body {
                text_sp.insert("p:txBody".to_owned(), tx_body.clone());
            }
            let text_sp = Value::Object(text_sp);
            let text_el = parse_sp_shape(Some(&text_sp), anchor, &ctx, None)?;
            if *text_el.r#type != Some(ElementType::Passthrough) {
                out.push(text_el);
            }
            continue;
        }
        let el = parse_sp_shape(Some(sp), anchor, &ctx, None)?;
        if *el.r#type != Some(ElementType::Passthrough) {
            out.push(el);
        }
    }
    Ok(out
        .into_iter()
        .map(|mut el| {
            if let Some(mut body) = (*el.text).clone() {
                split_diagram_paragraphs(&mut body);
                el.text.set(body);
            }
            SlideElement::Text(Box::new(el))
        })
        .collect())
}

/// `splitDiagramParagraphs`: each DGM_PARA_BREAK ends a paragraph; the
/// pieces keep the paragraph's and the run's other keys.
fn split_diagram_paragraphs(body: &mut TextBody) {
    let paragraphs = (*body.paragraphs).as_deref().unwrap_or_default();
    if !paragraphs.iter().any(|p| {
        (*p.runs).iter().flatten().any(|r| {
            (*r.text)
                .as_deref()
                .is_some_and(|t| t.contains(DGM_PARA_BREAK))
        })
    }) {
        return;
    }
    let mut out: Vec<Paragraph> = Vec::new();
    for p in paragraphs {
        // `{ ...p, runs: [] }`: the key keeps its place
        let mut shell = p.clone();
        shell.runs.set(Vec::new());
        let mut cur = shell.clone();
        let mut cur_runs = Vec::new();
        for r in (*p.runs).iter().flatten() {
            let text = (*r.text).as_deref().unwrap_or_default();
            // the run without its text, cloned per piece: cloning the run
            // itself would copy its whole text once per hard return
            let mut run_shell: Option<TextRun> = None;
            for (i, part) in text.split(DGM_PARA_BREAK).enumerate() {
                if i > 0 {
                    cur.runs.set(std::mem::take(&mut cur_runs));
                    out.push(std::mem::replace(&mut cur, shell.clone()));
                }
                if !part.is_empty() {
                    let mut run = run_shell
                        .get_or_insert_with(|| {
                            let mut empty = r.clone();
                            empty.text.set(String::new());
                            empty
                        })
                        .clone();
                    run.text.set(part.to_owned());
                    cur_runs.push(run);
                }
            }
        }
        cur.runs.set(cur_runs);
        out.push(cur);
    }
    body.paragraphs.set(out);
}

/// `findDescendantPic`: the first p:pic in a graphicData subtree, through
/// wrappers like mc:AlternateContent. The depth stops at 6.
fn find_descendant_pic(node: Node<'_>, depth: u32) -> Node<'_> {
    if !value_truthy(node) || !is_object(node) || depth > 6 {
        return None;
    }
    if let Some(Value::Array(pics)) = get(node, "p:pic")
        && let Some(pic) = pics.first()
    {
        return Some(pic);
    }
    match node {
        Some(Value::Object(map)) => map
            .iter()
            .filter(|(key, _)| !key.starts_with("@_"))
            .find_map(|(_, value)| find_pic_under(value, depth)),
        Some(Value::Array(items)) => items.iter().find_map(|value| find_pic_under(value, depth)),
        _ => None,
    }
}

/// One entry of `Object.entries(node)` in findDescendantPic: each of its
/// items (a list) or itself, searched one level down; the first truthy find.
fn find_pic_under(v: &Value, depth: u32) -> Node<'_> {
    let children = match v {
        Value::Array(items) => items.as_slice(),
        other => std::slice::from_ref(other),
    };
    children
        .iter()
        .map(|child| find_descendant_pic(Some(child), depth + 1))
        .find(|found| value_truthy(*found))
        .flatten()
}
