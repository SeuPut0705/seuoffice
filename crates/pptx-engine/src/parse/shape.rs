//! The shape section of packages/pptx-engine/src/parse.ts (lines 299-339,
//! 347-1138 and 3378-3425): shape fragments, `p:sp`, strokes and arrow
//! ends, connectors, glow, reflection, shadow, scene3D, `a:avLst`, groups
//! and their children, `passthrough` and the `a:xfrm` helpers.

use jscompat::{
    JsNum, JsObject, Radix, base64, js_regex, number_truthy, parse_int, sort_by_number, to_number,
    try_js_regex, value_to_string, value_truthy,
};
use serde_json::Value;
use std::sync::Arc;

use super::context::{COORD_MAX, Node, ParseContext};
use crate::placeholder::{
    LevelTextStyle, PlaceholderAnchor, PlaceholderLayer, TextStyleLevels, placeholder_style_chain,
    resolve_placeholder_anchor, resolve_placeholder_anchor_ctr, resolve_placeholder_fill_sp_pr,
    resolve_placeholder_insets, resolve_placeholder_transform,
};
use crate::scan::SpElement;
use crate::types::{
    ArrowEnd, ArrowEndSize, BevelTop, ByteAnchor, Connection, ConnectionEnd, ElementType, EmuRect,
    Fill, GlowEffect, GroupElement, LineCap, LineCompound, LineJoin, Model3d, Model3dRotation,
    PassthroughElement, PassthroughKind, ReflectionEffect, Scene3D, SceneRotation, ShadowEffect,
    SlideElement, Stroke, TextAnchor, TextElement, Transform, assigned,
};

/// `node?.[key]`
fn get<'a>(node: Node<'a>, key: &str) -> Node<'a> {
    node.and_then(|node| node.get(key))
}

/// `key in node` for an object node (an array has no such key).
fn has(node: Node<'_>, key: &str) -> bool {
    matches!(node, Some(Value::Object(map)) if map.contains_key(key))
}

/// `node && typeof node === 'object'` over a parsed tree.
fn is_object(node: Node<'_>) -> bool {
    matches!(node, Some(Value::Object(_) | Value::Array(_)))
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

/// `parseInt(v, 10)`
fn int10(v: Node<'_>) -> f64 {
    parse_int(&value_to_string(v), Radix::Ten)
}

/// `x || 0`
fn or0(x: f64) -> f64 {
    if number_truthy(x) { x } else { 0.0 }
}

/// `node?.[key]` read as a string attribute.
fn attr<'a>(node: Node<'a>, key: &str) -> Option<&'a str> {
    get(node, key).and_then(Value::as_str)
}

/// `if (s)` for an optional string.
fn str_truthy(s: Option<&str>) -> bool {
    s.is_some_and(|s| !s.is_empty())
}

/// `list?.[i]` for an integer `i` that may be out of range.
fn at(list: Option<&Vec<Value>>, i: f64) -> Option<&Value> {
    let list = list?;
    if i >= 0.0 && i < list.len() as f64 {
        list.get(i as usize)
    } else {
        None
    }
}

/// `parseInt(String(ref?.['@_idx'] ?? '0'), 10) || 0`
fn style_ref_idx(r#ref: Node<'_>) -> f64 {
    match get(r#ref, "@_idx") {
        None | Some(Value::Null) => 0.0,
        idx => or0(int10(idx)),
    }
}

fn int_or(v: Node<'_>, dflt: f64) -> f64 {
    super::decor::int_or(v, dflt)
}

/// `isHiddenElement`
fn is_hidden_element(node: Node<'_>, tag_name: &str) -> bool {
    let nv_key = match tag_name {
        "p:sp" => "p:nvSpPr",
        "p:pic" => "p:nvPicPr",
        "p:grpSp" => "p:nvGrpSpPr",
        "p:graphicFrame" => "p:nvGraphicFramePr",
        "p:cxnSp" => "p:nvCxnSpPr",
        _ => return false,
    };
    let hidden = attr(get(get(node, nv_key), "p:cNvPr"), "@_hidden");
    hidden == Some("1") || hidden == Some("true")
}

/// `mathBlockAsRun`
fn math_block_as_run(block: &str) -> String {
    let fallback = js_regex!(r"<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>")
        .exec(block)
        .and_then(|m| m.get(1))
        .unwrap_or("");
    let texts = |m: &str| -> String {
        js_regex!(r"<(?:a|m):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:a|m):t>")
            .find_iter(m)
            .map(|x| x.get(1).unwrap_or(""))
            .collect()
    };
    let mut text = texts(fallback);
    if text.is_empty() {
        text = texts(block);
    }
    format!(
        "<a:r gxRaw=\"{}\"><a:rPr/><a:t>{text}</a:t></a:r>",
        utf8_to_base64(block)
    )
}

/// `utf8ToBase64`
fn utf8_to_base64(s: &str) -> String {
    base64(s.as_bytes())
}

/// `parseShapeFragment`
pub(super) fn parse_shape_fragment(
    sp: &SpElement<'_>,
    frag_xml: &str,
    anchor: ByteAnchor,
    ctx: &ParseContext<'_>,
) -> Result<Option<SlideElement>, String> {
    let semantic_xml = js_regex!(
        r"<mc:AlternateContent\b[^>]*>\s*<mc:Choice\b[^>]*>\s*<a14:m\b[\s\S]*?<\/mc:AlternateContent>"
    )
    .replace_all(frag_xml, |m| math_block_as_run(m.as_str()));
    let semantic_xml = js_regex!(r"<a:br\b[^>]*\/>|<a:br\b[\s\S]*?<\/a:br>")
        .replace_all(&semantic_xml, |_| "<a:r><a:t>\n</a:t></a:r>".to_owned());
    let semantic_xml = js_regex!(r"<a:fld\b").replace_all(&semantic_xml, |_| "<a:r".to_owned());
    let semantic_xml = js_regex!(r"<\/a:fld>").replace_all(&semantic_xml, |_| "</a:r>".to_owned());
    if sp.name == "p:grpSp" && group_exceeds_budget(frag_xml)? {
        return Ok(Some(SlideElement::Passthrough(Box::new(passthrough(
            anchor,
            PassthroughKind::Unknown,
            None,
            ctx,
        )))));
    }
    let doc = match super::context::parse_xml(&semantic_xml) {
        Ok(doc) => doc,
        Err(err) => {
            if sp.name == "p:grpSp" {
                return Ok(Some(SlideElement::Passthrough(Box::new(passthrough(
                    anchor,
                    PassthroughKind::Unknown,
                    None,
                    ctx,
                )))));
            }
            return Err(err);
        }
    };
    let raw = doc.get(sp.name);
    let node = if value_truthy(raw) { first(raw) } else { None };
    if !value_truthy(node) {
        return Ok(None);
    }

    if is_hidden_element(node, sp.name) {
        let mut silent = passthrough(anchor, PassthroughKind::Unknown, node, ctx);
        silent.no_chip.set(true);
        return Ok(Some(SlideElement::Passthrough(Box::new(silent))));
    }

    match sp.name {
        "p:sp" => Ok(Some(SlideElement::Text(Box::new(parse_sp_shape(
            node,
            anchor,
            ctx,
            Some(frag_xml),
        )?)))),
        "p:pic" => Ok(Some(SlideElement::Picture(Box::new(
            super::picture::parse_picture(node, anchor, ctx, Some(frag_xml))?,
        )))),
        "p:grpSp" => {
            let mut budget = GroupParseBudget {
                remaining: MAX_GROUP_DESCENDANTS as i64,
            };
            Ok(Some(SlideElement::Group(Box::new(parse_group(
                node,
                anchor,
                ctx,
                Some(frag_xml),
                0,
                &mut budget,
            )?))))
        }
        "p:graphicFrame" => Ok(Some(super::picture::graphic_frame_passthrough(
            node, anchor, ctx,
        )?)),
        "p:cxnSp" => Ok(Some(SlideElement::Text(Box::new(parse_connector(
            node, anchor, ctx,
        ))))),
        "mc:AlternateContent" => {
            let choices = as_list(get(node, "mc:Choice"));
            for ch in choices {
                let gf = first(get(Some(ch), "p:graphicFrame"));
                if !value_truthy(gf) {
                    continue;
                }
                let el = super::picture::graphic_frame_passthrough(gf, anchor.clone(), ctx)?;
                if !matches!(el, SlideElement::Passthrough(_)) {
                    return Ok(Some(el));
                }
            }
            let fb = get(node, "mc:Fallback");
            let pic = first(get(fb, "p:pic"));
            if value_truthy(pic) {
                let mut el = super::picture::parse_picture(pic, anchor, ctx, None)?;
                let model = choices
                    .iter()
                    .map(|ch| {
                        get(
                            get(
                                get(first(get(Some(ch), "p:graphicFrame")), "a:graphic"),
                                "a:graphicData",
                            ),
                            "am3d:model3d",
                        )
                    })
                    .find(|model| value_truthy(*model))
                    .flatten();
                if let Some(model) = model {
                    let rot = get(get(Some(model), "am3d:trans"), "am3d:rot");
                    let angle = |name: &str| -> f64 {
                        let raw = get(rot, &format!("@_{name}"));
                        let n = match raw {
                            None | Some(Value::Null) => 0.0,
                            raw => to_number(&value_to_string(raw)),
                        };
                        or0(n)
                    };
                    let embed = match get(Some(model), "@_r:embed") {
                        None | Some(Value::Null) => String::new(),
                        raw => value_to_string(raw),
                    };
                    let target = ctx
                        .model3d_rels
                        .and_then(|rels| rels.get(&embed))
                        .filter(|target| !target.is_empty())
                        .cloned();
                    el.model3d.set(Model3d {
                        target,
                        rot: Model3dRotation {
                            ax: JsNum(angle("ax")),
                            ay: JsNum(angle("ay")),
                            az: JsNum(angle("az")),
                        },
                    });
                    return Ok(Some(SlideElement::Picture(Box::new(el))));
                }
                let ink_xfrm = choices
                    .iter()
                    .map(|ch| get(first(get(Some(ch), "p:contentPart")), "p14:xfrm"))
                    .find(|xfrm| value_truthy(*xfrm))
                    .flatten();
                if ink_xfrm.is_some() {
                    el.transform.set(parse_xfrm(ink_xfrm));
                }
                return Ok(Some(SlideElement::Picture(Box::new(el))));
            }
            let sp2 = first(get(fb, "p:sp"));
            if value_truthy(sp2) {
                return Ok(Some(SlideElement::Text(Box::new(parse_sp_shape(
                    sp2, anchor, ctx, None,
                )?))));
            }
            let mut silent = passthrough(anchor, PassthroughKind::Unknown, node, ctx);
            silent.no_chip.set(true);
            Ok(Some(SlideElement::Passthrough(Box::new(silent))))
        }
        _ => Ok(Some(SlideElement::Passthrough(Box::new(passthrough(
            anchor,
            PassthroughKind::Unknown,
            node,
            ctx,
        ))))),
    }
}

/// `node[key] ?? {}`
fn or_empty<'a>(node: Node<'a>, key: &str, empty: &'a Value) -> &'a Value {
    match get(node, key) {
        None | Some(Value::Null) => empty,
        Some(value) => value,
    }
}

fn to_text_anchor(anchor: PlaceholderAnchor) -> TextAnchor {
    match anchor {
        PlaceholderAnchor::Top => TextAnchor::Top,
        PlaceholderAnchor::Middle => TextAnchor::Middle,
        PlaceholderAnchor::Bottom => TextAnchor::Bottom,
    }
}

/// `parseSpShape`
pub(super) fn parse_sp_shape(
    node: Node<'_>,
    anchor: ByteAnchor,
    ctx: &ParseContext<'_>,
    raw_xml: Option<&str>,
) -> Result<TextElement, String> {
    let empty = Value::Object(serde_json::Map::new());
    let sp_pr = Some(or_empty(node, "p:spPr", &empty));
    let nv = get(node, "p:nvSpPr");
    let ph = get(get(nv, "p:nvPr"), "p:ph");
    let ph_truthy = value_truthy(ph);
    let ph_type = attr(ph, "@_type");
    let ph_idx = match get(ph, "@_idx") {
        None | Some(Value::Null) => None,
        idx => Some(value_to_string(idx)),
    };
    let ph_idx = ph_idx.as_deref();
    let name = attr(get(nv, "p:cNvPr"), "@_name").map(str::to_owned);

    let mut transform = parse_xfrm(get(sp_pr, "a:xfrm"));
    if ph_truthy && lacks_ext(get(sp_pr, "a:xfrm")) {
        let inherited = resolve_placeholder_transform(
            ctx.layout_placeholders,
            ctx.master_placeholders,
            ph_type,
            ph_idx,
        );
        if let Some(inherited) = inherited {
            transform = with_inherited_ext(get(sp_pr, "a:xfrm"), transform, inherited);
        }
    }

    let prst_geom = get(sp_pr, "a:prstGeom");
    let preset_geometry = attr(prst_geom, "@_prst").map(str::to_owned);
    let adjust = parse_av_lst(get(prst_geom, "a:avLst"));
    let custom_geometry = match get(sp_pr, "a:custGeom") {
        None | Some(Value::Null) => None,
        Some(_) => {
            let xml = match raw_xml {
                Some(raw) if !raw.is_empty() => raw,
                _ => &anchor.original_xml,
            };
            crate::custgeom::parse_cust_geom(xml, transform.offset.cx.0, transform.offset.cy.0)
                .map_err(|limit| limit.to_string())?
        }
    };
    let mut fill = super::fill::parse_fill(sp_pr, ctx);
    let tx_body = get(node, "p:txBody");
    let ph_chain: Vec<TextStyleLevels> = if ph_truthy {
        placeholder_style_chain(
            ctx.layout_placeholders,
            ctx.master_placeholders,
            ctx.master_text_styles,
            ph_type,
            ph_idx,
        )
    } else if let Some(dts) = ctx.default_text_style {
        vec![TextStyleLevels {
            levels: dts.levels.clone(),
            src: Some("presentation defaultTextStyle".to_owned()),
        }]
    } else {
        Vec::new()
    };
    let font_ref_color =
        super::fill::resolve_color_node(get(get(node, "p:style"), "a:fontRef"), ctx);
    let chain_layers: Vec<TextStyleLevels> = match font_ref_color.as_deref() {
        Some(color) if !color.is_empty() => {
            let mut level = LevelTextStyle::default();
            level.color.set(color.to_owned());
            let mut layers = Vec::with_capacity(ph_chain.len() + 1);
            layers.push(TextStyleLevels {
                levels: vec![Some(level)],
                src: Some("shape style".to_owned()),
            });
            layers.extend(ph_chain);
            layers
        }
        _ => ph_chain,
    };
    let ph_insets = if ph_truthy {
        resolve_placeholder_insets(
            ctx.layout_placeholders,
            ctx.master_placeholders,
            ph_type,
            ph_idx,
        )
    } else {
        None
    };
    let mut text = if value_truthy(tx_body) {
        Some(super::text::parse_text_body(
            tx_body,
            ctx,
            &chain_layers,
            ph_insets.as_ref(),
        )?)
    } else {
        None
    };
    if ph_truthy
        && let Some(text) = text.as_mut()
        && text.anchor.is_none()
        && let Some(inherited) = resolve_placeholder_anchor(
            ctx.layout_placeholders,
            ctx.master_placeholders,
            ph_type,
            ph_idx,
        )
    {
        text.anchor.set(to_text_anchor(inherited));
    }
    if ph_truthy
        && let Some(text) = text.as_mut()
        && text.anchor_ctr.is_none()
        && let Some(inherited) = resolve_placeholder_anchor_ctr(
            ctx.layout_placeholders,
            ctx.master_placeholders,
            ph_type,
            ph_idx,
        )
    {
        text.anchor_ctr.set(inherited);
    }

    let mut stroke = parse_stroke(sp_pr, ctx, None);
    let mut shadow = parse_shadow(sp_pr, ctx);
    let mut glow = parse_glow(sp_pr, ctx);
    let reflection = parse_reflection(sp_pr);
    let scene3d = parse_scene3d(sp_pr, ctx);
    let soft_edge_rad = get(get(get(sp_pr, "a:effectLst"), "a:softEdge"), "@_rad");
    let overlay_node = get(get(sp_pr, "a:effectLst"), "a:fillOverlay");
    let fill_overlay = if value_truthy(overlay_node) {
        super::fill::parse_fill(overlay_node, ctx)
    } else {
        None
    };

    let style = get(node, "p:style");
    if is_object(style) {
        if fill.is_none() {
            let r#ref = get(style, "a:fillRef");
            let idx = style_ref_idx(r#ref);
            let ph_clr = super::fill::resolve_color_node(r#ref, ctx);
            if idx > 0.0 {
                let theme = ctx.theme;
                let tpl = if idx > 1000.0 {
                    at(theme.and_then(|t| t.bg_fill_styles.as_ref()), idx - 1001.0)
                } else {
                    at(theme.and_then(|t| t.fill_styles.as_ref()), idx - 1.0)
                };
                let tpl_fill = if value_truthy(tpl) {
                    let tpl_ctx = ParseContext {
                        ph_clr: ph_clr.as_deref(),
                        media_rels: ctx.theme_media_rels.or(ctx.media_rels),
                        ..*ctx
                    };
                    super::fill::parse_fill(tpl, &tpl_ctx)
                } else {
                    None
                };
                fill = tpl_fill.or_else(|| {
                    ph_clr
                        .as_deref()
                        .filter(|c| !c.is_empty())
                        .map(|color| Fill::Solid {
                            color: color.to_owned(),
                        })
                });
            }
        }
        if stroke.is_none() {
            stroke = style_ref_stroke(node, ctx).map(Some);
        }
        if shadow.is_none() && glow.is_none() {
            let r#ref = get(style, "a:effectRef");
            let idx = style_ref_idx(r#ref);
            let ph_clr = super::fill::resolve_color_node(r#ref, ctx);
            let es = if idx > 0.0 {
                get(
                    at(ctx.theme.and_then(|t| t.effect_styles.as_ref()), idx - 1.0),
                    "a:effectStyle",
                )
            } else {
                None
            };
            if value_truthy(es) {
                let tpl_ctx = ParseContext {
                    ph_clr: ph_clr.as_deref(),
                    ..*ctx
                };
                shadow = parse_shadow(es, &tpl_ctx);
                glow = parse_glow(es, &tpl_ctx);
            }
        }
        let font_color = super::fill::resolve_color_node(get(style, "a:fontRef"), ctx);
        if let Some(font_color) = font_color.filter(|c| !c.is_empty())
            && let Some(text) = text.as_mut()
            && let Some(mut paragraphs) = (*text.paragraphs).clone()
        {
            for p in paragraphs.iter_mut() {
                if let Some(mut runs) = (*p.runs).clone() {
                    for r in runs.iter_mut() {
                        if !str_truthy(r.color.as_deref()) {
                            r.color.set(font_color.clone());
                        }
                    }
                    p.runs.set(runs);
                }
            }
            text.paragraphs.set(paragraphs);
        }
    }

    if fill.is_none() && ph_truthy {
        let inh = resolve_placeholder_fill_sp_pr(
            ctx.layout_placeholders,
            ctx.master_placeholders,
            ph_type,
            ph_idx,
        );
        if let Some(inh) = inh {
            let layer_rels = match inh.layer {
                PlaceholderLayer::Layout => ctx.layout_media_rels,
                PlaceholderLayer::Master => ctx.master_media_rels,
            };
            let inh_ctx = ParseContext {
                media_rels: layer_rels.or(ctx.media_rels),
                ..*ctx
            };
            fill = super::fill::parse_fill(Some(inh.sp_pr), &inh_ctx);
        }
    }

    let tx_box = attr(get(nv, "p:cNvSpPr"), "@_txBox") == Some("1");
    let preset_truthy = str_truthy(preset_geometry.as_deref());
    let is_text_box = tx_box
        && custom_geometry.is_none()
        && (!preset_truthy || preset_geometry.as_deref() == Some("rect"));
    let use_bg_fill = matches!(attr(node, "@_useBgFill"), Some("1" | "true"));
    let r#type = if value_truthy(tx_body)
        && (is_text_box || (!preset_truthy && custom_geometry.is_none()))
    {
        ElementType::Text
    } else {
        ElementType::Shape
    };
    let no_geometry = !preset_truthy && custom_geometry.is_none() && !ph_truthy;
    let el = TextElement {
        id: jscompat::Slot::of(ctx.uid("sp")),
        r#type: jscompat::Slot::of(r#type),
        anchor: jscompat::Slot::of(anchor),
        transform: jscompat::Slot::of(transform),
        placeholder: assigned(ph_truthy.then(|| ph_type.unwrap_or("body").to_owned())),
        tx_box: jscompat::Slot::maybe(tx_box.then_some(true)),
        name: assigned(name),
        preset_geometry: assigned(preset_geometry),
        adjust: jscompat::Slot::maybe(adjust),
        custom_geometry: jscompat::Slot::maybe(custom_geometry),
        no_geometry: jscompat::Slot::maybe(no_geometry.then_some(true)),
        fill: assigned(fill),
        use_bg_fill: jscompat::Slot::maybe(use_bg_fill.then_some(true)),
        fill_overlay: jscompat::Slot::maybe(
            fill_overlay.filter(|overlay| !matches!(overlay, Fill::None)),
        ),
        stroke: jscompat::Slot::maybe(stroke.flatten()),
        shadow: jscompat::Slot::maybe(shadow),
        glow: jscompat::Slot::maybe(glow),
        reflection: jscompat::Slot::maybe(reflection),
        scene3d: jscompat::Slot::maybe(scene3d),
        soft_edge: jscompat::Slot::maybe(match soft_edge_rad {
            None | Some(Value::Null) => None,
            rad => Some(JsNum(int_or(rad, 0.0))),
        }),
        text: assigned(text),
        ..TextElement::default()
    };
    Ok(el)
}

/// `styleRefStroke`
fn style_ref_stroke(node: Node<'_>, ctx: &ParseContext<'_>) -> Option<Stroke> {
    let r#ref = get(get(node, "p:style"), "a:lnRef");
    let idx = style_ref_idx(r#ref);
    if idx <= 0.0 {
        return None;
    }
    let ph_clr = super::fill::resolve_color_node(r#ref, ctx);
    let tpl = at(ctx.theme.and_then(|t| t.ln_styles.as_ref()), idx - 1.0);
    let from_tpl = if value_truthy(tpl) {
        let tpl_ctx = ParseContext {
            ph_clr: ph_clr.as_deref(),
            ..*ctx
        };
        parse_stroke(tpl, &tpl_ctx, None).flatten()
    } else {
        None
    };
    from_tpl.or_else(|| {
        ph_clr.filter(|c| !c.is_empty()).map(|color| Stroke {
            fill: Fill::Solid { color },
            width: JsNum(12700.0),
            dash: None,
            cap: None,
            join: None,
            compound: None,
            head_end: None,
            tail_end: None,
        })
    })
}

/// `parseStroke`: `None` is `undefined`, `Some(None)` the `null` of an
/// explicit `<a:noFill/>`.
pub(super) fn parse_stroke(
    sp_pr: Node<'_>,
    ctx: &ParseContext<'_>,
    fallback_color: Option<&str>,
) -> Option<Option<Stroke>> {
    let ln = get(sp_pr, "a:ln");
    if !value_truthy(ln) || !is_object(ln) {
        return None;
    }
    if has(ln, "a:noFill") {
        return Some(None);
    }
    let mut fill = super::fill::parse_fill(ln, ctx);
    if matches!(fill, None | Some(Fill::None)) {
        let fallback = fallback_color.filter(|c| !c.is_empty())?;
        fill = Some(Fill::Solid {
            color: fallback.to_owned(),
        });
    }
    let fill = fill?;
    let dash = get(get(ln, "a:prstDash"), "@_val");
    // capMap, own keys only (parse.ts:678)
    let cap = if value_truthy(get(ln, "@_cap")) {
        match attr(ln, "@_cap") {
            Some("flat") => Some(LineCap::Flat),
            Some("rnd") => Some(LineCap::Round),
            Some("sq") => Some(LineCap::Square),
            _ => None,
        }
    } else {
        None
    };
    // cmpdMap, own keys only (parse.ts:686)
    let compound = if value_truthy(get(ln, "@_cmpd")) {
        match attr(ln, "@_cmpd") {
            Some("sng") => Some(LineCompound::Sng),
            Some("dbl") => Some(LineCompound::Dbl),
            Some("thickThin") => Some(LineCompound::ThickThin),
            Some("thinThick") => Some(LineCompound::ThinThick),
            Some("tri") => Some(LineCompound::Tri),
            _ => None,
        }
    } else {
        None
    };
    let join = if has(ln, "a:round") {
        Some(LineJoin::Round)
    } else if has(ln, "a:bevel") {
        Some(LineJoin::Bevel)
    } else if has(ln, "a:miter") {
        Some(LineJoin::Miter)
    } else {
        None
    };
    let head_end = parse_arrow_end(get(ln, "a:headEnd"));
    let tail_end = parse_arrow_end(get(ln, "a:tailEnd"));
    Some(Some(Stroke {
        fill,
        width: JsNum(int_or(get(ln, "@_w"), 12700.0)),
        dash: value_truthy(dash).then(|| value_to_string(dash)),
        cap,
        join,
        compound: compound.filter(|c| *c != LineCompound::Sng),
        head_end,
        tail_end,
    }))
}

/// `sizeMap[raw] ?? 'med'`, own keys only (parse.ts:713-714).
fn arrow_size(raw: Node<'_>) -> ArrowEndSize {
    match raw.and_then(Value::as_str) {
        Some("sm") => ArrowEndSize::Sm,
        Some("lg") => ArrowEndSize::Lg,
        _ => ArrowEndSize::Med,
    }
}

/// `parseArrowEnd`
fn parse_arrow_end(node: Node<'_>) -> Option<ArrowEnd> {
    if !value_truthy(node) || !is_object(node) {
        return None;
    }
    let r#type = match get(node, "@_type") {
        None | Some(Value::Null) => "none".to_owned(),
        t => value_to_string(t),
    };
    if r#type == "none" {
        return None;
    }
    let w_raw = get(node, "@_w");
    let len_raw = get(node, "@_len");
    Some(ArrowEnd {
        r#type,
        w: value_truthy(w_raw).then(|| arrow_size(w_raw)),
        len: value_truthy(len_raw).then(|| arrow_size(len_raw)),
    })
}

/// `cxnRef` of parseConnector
fn cxn_ref(n: Node<'_>) -> Option<ConnectionEnd> {
    match get(n, "@_id") {
        None | Some(Value::Null) => None,
        id => Some(ConnectionEnd {
            id: JsNum(int10(id)),
            idx: JsNum(int_or(get(n, "@_idx"), 0.0)),
        }),
    }
}

/// `parseConnector`
fn parse_connector(node: Node<'_>, anchor: ByteAnchor, ctx: &ParseContext<'_>) -> TextElement {
    let empty = Value::Object(serde_json::Map::new());
    let sp_pr = Some(or_empty(node, "p:spPr", &empty));
    let nv_cxn = get(node, "p:nvCxnSpPr");
    let name = attr(get(nv_cxn, "p:cNvPr"), "@_name").map(str::to_owned);
    let prst_geom = get(sp_pr, "a:prstGeom");
    let ref_stroke = style_ref_stroke(node, ctx);
    let fallback: String = match ref_stroke.as_ref().map(|s| &s.fill) {
        Some(Fill::Solid { color }) => color.clone(),
        _ => ctx
            .theme
            .and_then(|t| t.colors.as_ref())
            .and_then(|colors| colors.get("dk1"))
            .cloned()
            .unwrap_or_else(|| "#000000".to_owned()),
    };
    let explicit_stroke = parse_stroke(
        sp_pr,
        ctx,
        value_truthy(get(sp_pr, "a:ln")).then_some(fallback.as_str()),
    );
    let stroke = match explicit_stroke {
        Some(None) => None,
        Some(Some(stroke)) => Some(stroke),
        None => Some(ref_stroke.unwrap_or(Stroke {
            fill: Fill::Solid { color: fallback },
            width: JsNum(12700.0),
            dash: None,
            cap: None,
            join: None,
            compound: None,
            head_end: None,
            tail_end: None,
        })),
    };
    let cxn_pr = get(nv_cxn, "p:cNvCxnSpPr");
    let st = get(cxn_pr, "a:stCxn");
    let end = get(cxn_pr, "a:endCxn");
    let connection = (value_truthy(st) || value_truthy(end)).then(|| Connection {
        start: cxn_ref(st),
        end: cxn_ref(end),
    });
    let preset_geometry = match get(prst_geom, "@_prst") {
        None | Some(Value::Null) => "line".to_owned(),
        prst => value_to_string(prst),
    };
    TextElement {
        id: jscompat::Slot::of(ctx.uid("cxn")),
        r#type: jscompat::Slot::of(ElementType::Shape),
        anchor: jscompat::Slot::of(anchor),
        transform: jscompat::Slot::of(parse_xfrm(get(sp_pr, "a:xfrm"))),
        name: assigned(name),
        preset_geometry: jscompat::Slot::of(preset_geometry),
        adjust: jscompat::Slot::maybe(parse_av_lst(get(prst_geom, "a:avLst"))),
        connection: jscompat::Slot::maybe(connection),
        fill: jscompat::Slot::of(Fill::None),
        stroke: jscompat::Slot::maybe(stroke),
        ..TextElement::default()
    }
}

/// `parseGlow`
pub(super) fn parse_glow(sp_pr: Node<'_>, ctx: &ParseContext<'_>) -> Option<GlowEffect> {
    let glow = get(get(sp_pr, "a:effectLst"), "a:glow");
    if !value_truthy(glow) || !is_object(glow) {
        return None;
    }
    let color = super::fill::resolve_color_node(glow, ctx).filter(|c| !c.is_empty())?;
    let rad = match get(glow, "@_rad") {
        None | Some(Value::Null) => 0.0,
        rad => int10(rad),
    };
    Some(GlowEffect {
        color,
        radius: JsNum(if rad.is_finite() { rad } else { 0.0 }),
    })
}

/// `attr != null ? intOr(attr, dflt) / div : undefined`
fn scaled_attr(node: Node<'_>, key: &str, dflt: f64, div: f64) -> Option<f64> {
    match get(node, key) {
        None | Some(Value::Null) => None,
        v => Some(int_or(v, dflt) / div),
    }
}

/// `parseReflection`
pub(super) fn parse_reflection(sp_pr: Node<'_>) -> Option<ReflectionEffect> {
    let r = get(get(sp_pr, "a:effectLst"), "a:reflection");
    if !value_truthy(r) || !is_object(r) {
        return None;
    }
    Some(ReflectionEffect {
        blur_rad: JsNum(int_or(get(r, "@_blurRad"), 0.0)),
        start_a: JsNum(scaled_attr(r, "@_stA", 100000.0, 100000.0).unwrap_or(1.0)),
        end_pos: JsNum(scaled_attr(r, "@_endPos", 100000.0, 100000.0).unwrap_or(1.0)),
        dist: JsNum(int_or(get(r, "@_dist"), 0.0)),
    })
}

/// `parseShadow`
pub(super) fn parse_shadow(sp_pr: Node<'_>, ctx: &ParseContext<'_>) -> Option<ShadowEffect> {
    let effect_lst = get(sp_pr, "a:effectLst");
    let outer = match get(effect_lst, "a:outerShdw") {
        Some(Value::Null) => None,
        outer => outer,
    };
    let shdw = outer.or_else(|| get(effect_lst, "a:innerShdw"));
    if !value_truthy(shdw) || !is_object(shdw) {
        return None;
    }
    let color = super::fill::resolve_color_node(shdw, ctx).filter(|c| !c.is_empty())?;
    let sx = scaled_attr(shdw, "@_sx", 100000.0, 100000.0);
    let sy = scaled_attr(shdw, "@_sy", 100000.0, 100000.0);
    let kx = scaled_attr(shdw, "@_kx", 0.0, 60000.0);
    let ky = scaled_attr(shdw, "@_ky", 0.0, 60000.0);
    Some(ShadowEffect {
        color,
        blur_rad: JsNum(int_or(get(shdw, "@_blurRad"), 0.0)),
        dist: JsNum(int_or(get(shdw, "@_dist"), 0.0)),
        dir_deg: JsNum(int_or(get(shdw, "@_dir"), 0.0) / 60000.0),
        inner: (!value_truthy(outer)).then_some(true),
        sx: sx.map(JsNum),
        sy: sy.map(JsNum),
        kx_deg: kx.filter(|k| number_truthy(*k)).map(JsNum),
        ky_deg: ky.filter(|k| number_truthy(*k)).map(JsNum),
        algn: attr(shdw, "@_algn").map(str::to_owned),
    })
}

/// `rot` of parseScene3D
fn scene_rot(node: Node<'_>) -> Option<SceneRotation> {
    let r = get(node, "a:rot");
    if !value_truthy(r) || !is_object(r) {
        return None;
    }
    Some(SceneRotation {
        lat: JsNum(int_or(get(r, "@_lat"), 0.0)),
        lon: JsNum(int_or(get(r, "@_lon"), 0.0)),
        rev: JsNum(int_or(get(r, "@_rev"), 0.0)),
    })
}

/// `node?.[key]` when truthy, as `String(...)`.
fn truthy_string(node: Node<'_>, key: &str) -> Option<String> {
    let v = get(node, key);
    value_truthy(v).then(|| value_to_string(v))
}

/// `parseScene3D`
pub(super) fn parse_scene3d(sp_pr: Node<'_>, ctx: &ParseContext<'_>) -> Option<Scene3D> {
    let s3 = get(sp_pr, "a:scene3d");
    let camera = get(s3, "a:camera");
    let camera_preset = truthy_string(camera, "@_prst")?;
    let sp3d = get(sp_pr, "a:sp3d");
    let rig = get(s3, "a:lightRig");
    let bevel_t = get(sp3d, "a:bevelT");
    let extrusion_clr = get(sp3d, "a:extrusionClr");
    let extrusion_color = if value_truthy(extrusion_clr) && is_object(extrusion_clr) {
        super::fill::resolve_color_node(extrusion_clr, ctx)
    } else {
        None
    };
    let camera_rot = scene_rot(camera);
    let light_rot = scene_rot(rig);
    let present = |key: &str| !matches!(get(sp3d, key), None | Some(Value::Null));
    Some(Scene3D {
        camera_preset,
        camera_rot,
        light_rig: truthy_string(rig, "@_rig"),
        light_dir: truthy_string(rig, "@_dir"),
        light_rot,
        extrusion_emu: present("@_extrusionH")
            .then(|| JsNum(int_or(get(sp3d, "@_extrusionH"), 0.0))),
        z_emu: present("@_z").then(|| JsNum(int_or(get(sp3d, "@_z"), 0.0))),
        extrusion_color: extrusion_color.filter(|c| !c.is_empty()),
        material: truthy_string(sp3d, "@_prstMaterial"),
        bevel_top: bevel_t.map(|_| BevelTop {
            w_emu: JsNum(int_or(get(bevel_t, "@_w"), 76200.0)),
            h_emu: JsNum(int_or(get(bevel_t, "@_h"), 76200.0)),
            preset: attr(bevel_t, "@_prst").unwrap_or("circle").to_owned(),
        }),
    })
}

/// `parseAvLst`
pub(super) fn parse_av_lst(av_lst: Node<'_>) -> Option<JsObject<JsNum>> {
    let gd_raw = get(av_lst, "a:gd");
    if !value_truthy(gd_raw) {
        return None;
    }
    let list = match gd_raw {
        Some(Value::Array(items)) => items.as_slice(),
        Some(value) => std::slice::from_ref(value),
        None => &[],
    };
    let mut out: JsObject<JsNum> = JsObject::new();
    for gd in list {
        let gd = Some(gd);
        let name = get(gd, "@_name");
        let fmla = match get(gd, "@_fmla") {
            None | Some(Value::Null) => String::new(),
            fmla => value_to_string(fmla),
        };
        let m = js_regex!(r"^val\s+(-?\d+)").exec(&fmla);
        if value_truthy(name)
            && let Some(m) = m
        {
            // `setOwn`: a guide named `__proto__` is an entry like any other
            out.set(
                value_to_string(name),
                JsNum(parse_int(m.get(1).unwrap_or(""), Radix::Ten)),
            );
        }
    }
    (!out.is_empty()).then_some(out)
}

const GROUP_CHILD_TAGS: [&str; 5] = ["p:sp", "p:pic", "p:grpSp", "p:graphicFrame", "p:cxnSp"];
const MAX_GROUP_DEPTH: u32 = 64;
pub(super) const MAX_GROUP_DESCENDANTS: usize = 10_000;

/// `GroupParseBudget`
struct GroupParseBudget {
    remaining: i64,
}

/// `groupScaleWithinWriteRange`
fn group_scale_within_write_range(group_ext: &EmuRect, child_ext: &EmuRect) -> bool {
    let mapped = [
        group_ext.x,
        group_ext.y,
        group_ext.cx,
        group_ext.cy,
        child_ext.x,
        child_ext.y,
        child_ext.cx,
        child_ext.cy,
    ];
    if !mapped.iter().all(|v| v.0.is_finite()) {
        return false;
    }
    for (g, ch) in [
        (group_ext.cx.0, child_ext.cx.0),
        (group_ext.cy.0, child_ext.cy.0),
    ] {
        if ch <= 0.0 {
            continue;
        }
        if g * (g / ch) > COORD_MAX {
            return false;
        }
    }
    true
}

const GROUP_TAG_RE: &str = r#"<!--[\s\S]*?-->|<\/?(?:[^<>"']|"[^"]*"|'[^']*')*>"#;

/// `GROUP_NAME_RE.exec(tag)?.[1] ?? ''`
fn group_tag_name(tag: &str) -> &str {
    js_regex!(r"^<\/?\s*([A-Za-z_][\w:.-]*)")
        .exec(tag)
        .and_then(|m| m.get(1))
        .unwrap_or("")
}

fn skipped_tag(tag: &str) -> bool {
    tag.starts_with("<!--") || tag.starts_with("<![") || tag.starts_with("<?")
}

/// `groupExceedsBudget`; `Err` where the tag search passed the regex bound.
fn group_exceeds_budget(xml: &str) -> Result<bool, String> {
    let mut group_depth: i64 = 0;
    let mut descendants: usize = 0;
    for m in try_js_regex!(GROUP_TAG_RE).try_find_iter(xml) {
        let m = m.map_err(|limit| limit.to_string())?;
        let tag = m.as_str();
        if skipped_tag(tag) {
            continue;
        }
        let closing = tag.starts_with("</");
        let is_self = !closing && tag.ends_with("/>");
        let name = group_tag_name(tag);
        if closing {
            if name == "p:grpSp" {
                group_depth -= 1;
            }
            continue;
        }
        if name == "p:grpSp" {
            if group_depth > 0 {
                descendants += 1;
                if descendants > MAX_GROUP_DESCENDANTS {
                    return Ok(true);
                }
            }
            if !is_self {
                group_depth += 1;
                if group_depth > i64::from(MAX_GROUP_DEPTH) {
                    return Ok(true);
                }
            }
            continue;
        }
        if group_depth > 0 && GROUP_CHILD_TAGS.contains(&name) {
            descendants += 1;
            if descendants > MAX_GROUP_DESCENDANTS {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// `chOff ? parseInt(chOff[key], 10) || 0 : 0`
fn coord(node: Node<'_>, key: &str) -> JsNum {
    JsNum(if value_truthy(node) {
        or0(int10(get(node, key)))
    } else {
        0.0
    })
}

/// `parseGroup`. Callers pass the defaults `0` and
/// `GroupParseBudget { remaining: MAX_GROUP_DESCENDANTS }`.
fn parse_group(
    node: Node<'_>,
    anchor: ByteAnchor,
    ctx: &ParseContext<'_>,
    raw_xml: Option<&str>,
    depth: u32,
    budget: &mut GroupParseBudget,
) -> Result<GroupElement, String> {
    // `asXmlNode(node['p:grpSpPr'])`: an empty or text-only <p:grpSpPr> is a group
    // without properties
    let grp_sp_pr = Some(crate::xml_utils::as_xml_node(get(node, "p:grpSpPr")));
    let xfrm = get(grp_sp_pr, "a:xfrm");
    let transform = parse_xfrm(xfrm);
    let name = attr(get(get(node, "p:nvGrpSpPr"), "p:cNvPr"), "@_name").map(str::to_owned);
    let own_fill = if has(grp_sp_pr, "a:grpFill") {
        None
    } else {
        super::fill::parse_fill(grp_sp_pr, ctx)
    };
    let child_ctx = match own_fill.as_ref() {
        Some(fill) => ParseContext {
            group_fill: Some(fill),
            ..*ctx
        },
        None => *ctx,
    };

    let ch_off = get(xfrm, "a:chOff");
    let ch_ext = get(xfrm, "a:chExt");
    let mut child_offset = (value_truthy(ch_off) || value_truthy(ch_ext)).then(|| EmuRect {
        x: coord(ch_off, "@_x"),
        y: coord(ch_off, "@_y"),
        cx: coord(ch_ext, "@_cx"),
        cy: coord(ch_ext, "@_cy"),
    });
    if let Some(offset) = child_offset.as_ref()
        && !group_scale_within_write_range(&transform.offset, offset)
    {
        child_offset = None;
    }

    let mut group = GroupElement {
        id: jscompat::Slot::of(ctx.uid("grp")),
        r#type: jscompat::Slot::of(ElementType::Group),
        anchor: jscompat::Slot::of(anchor),
        transform: jscompat::Slot::of(transform),
        name: assigned(name),
        children: jscompat::Slot::of(Vec::new()),
        child_offset: jscompat::Slot::maybe(child_offset),
        ..GroupElement::default()
    };
    if depth >= MAX_GROUP_DEPTH || budget.remaining <= 0 {
        return Ok(group);
    }

    let group_xml: &str = match raw_xml {
        Some(raw) if !raw.is_empty() => raw,
        _ => group
            .anchor
            .as_ref()
            .map_or("", |anchor| &*anchor.original_xml),
    };
    let slices = slice_group_children(group_xml)?;
    let mut ordered: Vec<(SlideElement, f64)> = Vec::new();
    for tag in GROUP_CHILD_TAGS {
        let raw = get(node, tag);
        if !value_truthy(raw) {
            continue;
        }
        let list = match raw {
            Some(Value::Array(items)) => items.as_slice(),
            Some(value) => std::slice::from_ref(value),
            None => &[],
        };
        let mut by_tag = slices.iter().filter(|s| s.name == tag);
        for child in list {
            let slice = by_tag.next();
            if budget.remaining <= 0 {
                continue;
            }
            budget.remaining -= 1;
            let el = parse_group_child(
                tag,
                Some(child),
                &child_ctx,
                slice.map(|s| s.xml),
                depth + 1,
                budget,
            )?;
            if let Some(el) = el {
                let start = slice.map_or(9_007_199_254_740_991.0, |s| s.start as f64);
                ordered.push((el, start));
            }
        }
        if budget.remaining <= 0 {
            break;
        }
    }
    sort_by_number(&mut ordered, |a, b| a.1 - b.1);
    group
        .children
        .set(ordered.into_iter().map(|(el, _)| el).collect());
    Ok(group)
}

fn set_nv_id(el: &mut SlideElement, nv_id: String) {
    match el {
        SlideElement::Text(el) => el.nv_id.set(nv_id),
        SlideElement::Picture(el) => el.nv_id.set(nv_id),
        SlideElement::Group(el) => el.nv_id.set(nv_id),
        SlideElement::Table(el) => el.nv_id.set(nv_id),
        SlideElement::Chart(el) => el.nv_id.set(nv_id),
        SlideElement::Passthrough(el) => el.nv_id.set(nv_id),
    }
}

/// `parseGroupChild`
fn parse_group_child(
    tag: &str,
    child: Node<'_>,
    ctx: &ParseContext<'_>,
    raw_xml: Option<&str>,
    depth: u32,
    budget: &mut GroupParseBudget,
) -> Result<Option<SlideElement>, String> {
    if is_hidden_element(child, tag) {
        return Ok(None);
    }
    let mut el = if tag == "p:grpSp" {
        let child_anchor = ByteAnchor {
            sp_index: -1,
            original_xml: Arc::from(""),
            range: [0, 0],
            gap_after: None,
        };
        SlideElement::Group(Box::new(parse_group(
            child,
            child_anchor,
            ctx,
            raw_xml,
            depth,
            budget,
        )?))
    } else {
        match parse_leaf_child(tag, child, ctx, raw_xml)? {
            Some(el) => el,
            None => return Ok(None),
        }
    };
    if let Some(nv_id) = group_child_nv_id(child) {
        set_nv_id(&mut el, nv_id);
    }
    Ok(Some(el))
}

/// The arms of `parseGroupChild` that do not recurse. Their elements are
/// built in this frame, which is gone before a nested group recurses: kept
/// in `parse_group_child`, they cost every level of nesting several
/// kilobytes of the wasm stack.
#[inline(never)]
fn parse_leaf_child(
    tag: &str,
    child: Node<'_>,
    ctx: &ParseContext<'_>,
    raw_xml: Option<&str>,
) -> Result<Option<SlideElement>, String> {
    let child_anchor = ByteAnchor {
        sp_index: -1,
        original_xml: Arc::from(""),
        range: [0, 0],
        gap_after: None,
    };
    Ok(Some(match tag {
        "p:sp" => SlideElement::Text(Box::new(parse_sp_shape(child, child_anchor, ctx, raw_xml)?)),
        "p:pic" => SlideElement::Picture(Box::new(super::picture::parse_picture(
            child,
            child_anchor,
            ctx,
            raw_xml,
        )?)),
        "p:graphicFrame" => super::picture::graphic_frame_passthrough(child, child_anchor, ctx)?,
        "p:cxnSp" => SlideElement::Text(Box::new(parse_connector(child, child_anchor, ctx))),
        _ => return Ok(None),
    }))
}

/// `groupChildNvId`
fn group_child_nv_id(child: Node<'_>) -> Option<String> {
    for key in [
        "p:nvSpPr",
        "p:nvPicPr",
        "p:nvGrpSpPr",
        "p:nvGraphicFramePr",
        "p:nvCxnSpPr",
    ] {
        match get(get(get(child, key), "p:cNvPr"), "@_id") {
            None | Some(Value::Null) => {}
            id => return Some(value_to_string(id)),
        }
    }
    None
}

/// `GroupChildSlice`. `start` is a byte offset: it only orders.
struct GroupChildSlice<'a> {
    name: &'a str,
    xml: &'a str,
    start: u64,
}

/// `sliceGroupChildren`; `Err` where the tag search passed the regex bound.
fn slice_group_children(xml: &str) -> Result<Vec<GroupChildSlice<'_>>, String> {
    let mut out = Vec::new();
    let mut depth: i64 = 0;
    let mut start: usize = 0;
    let mut start_name = "";
    for m in try_js_regex!(GROUP_TAG_RE).try_find_iter(xml) {
        let m = m.map_err(|limit| limit.to_string())?;
        let tag = m.as_str();
        if skipped_tag(tag) {
            continue;
        }
        let closing = tag.starts_with("</");
        let is_self = !closing && tag.ends_with("/>");
        let name = group_tag_name(tag);
        if closing {
            depth -= 1;
            if depth == 1 && !start_name.is_empty() {
                if let Some(slice) = xml.get(start..m.end()) {
                    out.push(GroupChildSlice {
                        name: start_name,
                        xml: slice,
                        start: start as u64,
                    });
                }
                start_name = "";
            }
        } else if is_self {
            if depth == 1 && GROUP_CHILD_TAGS.contains(&name) {
                out.push(GroupChildSlice {
                    name,
                    xml: tag,
                    start: m.start() as u64,
                });
            }
        } else {
            if depth == 1 && GROUP_CHILD_TAGS.contains(&name) {
                start = m.start();
                start_name = name;
            }
            depth += 1;
        }
    }
    Ok(out)
}

/// `sliceGroupChildXmls`: the direct child fragments of a `p:grpSp` in
/// document order (nested groups stay one slice).
pub fn slice_group_child_xmls(grp_xml: &str) -> Result<Vec<&str>, String> {
    Ok(slice_group_children(grp_xml)?
        .into_iter()
        .map(|s| s.xml)
        .collect())
}

/// `passthrough`
pub(super) fn passthrough(
    anchor: ByteAnchor,
    kind: PassthroughKind,
    node: Node<'_>,
    ctx: &ParseContext<'_>,
) -> PassthroughElement {
    let sp_pr = match get(node, "p:spPr") {
        None | Some(Value::Null) => get(node, "p:grpSpPr"),
        sp_pr => sp_pr,
    };
    let transform = parse_xfrm(get(sp_pr, "a:xfrm"));
    PassthroughElement {
        id: jscompat::Slot::of(ctx.uid("pt")),
        r#type: jscompat::Slot::of(ElementType::Passthrough),
        anchor: jscompat::Slot::of(anchor),
        transform: jscompat::Slot::of(transform),
        kind: jscompat::Slot::of(kind),
        ..PassthroughElement::default()
    }
}

/// `parseXfrm`
pub(super) fn parse_xfrm(xfrm: Node<'_>) -> Transform {
    let zero = Transform {
        offset: EmuRect {
            x: JsNum(0.0),
            y: JsNum(0.0),
            cx: JsNum(0.0),
            cy: JsNum(0.0),
        },
        rot: JsNum(0.0),
        flip_h: false,
        flip_v: false,
    };
    if !value_truthy(xfrm) {
        return zero;
    }
    let off = get(xfrm, "a:off");
    let ext = get(xfrm, "a:ext");
    let flip_h = attr(xfrm, "@_flipH");
    let flip_v = attr(xfrm, "@_flipV");
    Transform {
        offset: EmuRect {
            x: coord(off, "@_x"),
            y: coord(off, "@_y"),
            cx: coord(ext, "@_cx"),
            cy: coord(ext, "@_cy"),
        },
        rot: JsNum(if value_truthy(get(xfrm, "@_rot")) {
            or0(int10(get(xfrm, "@_rot")))
        } else {
            0.0
        }),
        flip_h: flip_h == Some("1") || flip_h == Some("true"),
        flip_v: flip_v == Some("1") || flip_v == Some("true"),
    }
}

/// `lacksExt`
pub(super) fn lacks_ext(xfrm: Node<'_>) -> bool {
    !value_truthy(xfrm) || !value_truthy(get(xfrm, "a:ext"))
}

/// `withInheritedExt`
pub(super) fn with_inherited_ext(
    xfrm: Node<'_>,
    own: Transform,
    inherited: Transform,
) -> Transform {
    if !value_truthy(xfrm) {
        return inherited;
    }
    Transform {
        offset: EmuRect {
            cx: inherited.offset.cx,
            cy: inherited.offset.cy,
            ..own.offset
        },
        ..own
    }
}
