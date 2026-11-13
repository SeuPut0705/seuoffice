//! The fill section of parse.ts: the blip helpers (1141-1170) and the fills
//! (3426-3677).

use jscompat::{
    JsNum, Radix, math_max, math_min, number_truthy, parse_int, slice_utf16, sort_by_number,
    value_to_string, value_truthy,
};
use serde_json::{Map, Value};

use super::context::{Node, ParseContext};
use super::decor::int_or;
use crate::types::{
    ClrChange, Fill, GradientFill, GradientPath, GradientStop, ImageFill, ImageMode, ImageTile,
    Insets, Lum, PatternFill,
};
use crate::xml_utils::percent_fraction;

/// `node?.[key]` where `node` is an element: a string or a list has no such
/// key (the keys read here are never indices or string methods).
fn get<'a>(node: Node<'a>, key: &str) -> Node<'a> {
    node.and_then(Value::as_object).and_then(|o| o.get(key))
}

/// `Array.isArray(raw) ? raw : raw ? [raw] : []`, items as they are.
fn list(raw: Node<'_>) -> Vec<&Value> {
    match raw {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(v) if value_truthy(Some(v)) => vec![v],
        _ => Vec::new(),
    }
}

/// `typeof v === 'object'` of a parsed value (a list is an object too).
fn is_object(v: Node<'_>) -> bool {
    matches!(v, Some(Value::Object(_) | Value::Array(_)))
}

/// `blipEmbedId`
pub(super) fn blip_embed_id<'a>(blip: Node<'a>) -> Option<&'a str> {
    let own = get(blip, "@_r:embed");
    if value_truthy(own) {
        return own.and_then(Value::as_str);
    }
    svg_blip_embed_id(blip)
}

/// `svgBlipEmbedId`
fn svg_blip_embed_id<'a>(blip: Node<'a>) -> Option<&'a str> {
    let exts = get(get(blip, "a:extLst"), "a:ext");
    for ext in list(exts) {
        let Some(entries) = ext.as_object() else {
            continue;
        };
        for (key, value) in entries {
            if key == "svgBlip" || key.ends_with(":svgBlip") {
                let id = get(Some(value), "@_r:embed");
                if value_truthy(id) {
                    return id.and_then(Value::as_str);
                }
            }
        }
    }
    None
}

/// `blipMediaRef`
pub(super) fn blip_media_ref<'a>(
    blip: Node<'_>,
    embed_id: Option<&str>,
    ctx: &ParseContext<'a>,
) -> &'a str {
    let lookup = |id: Option<&str>| -> Option<&'a str> {
        let id = id.filter(|s| !s.is_empty())?;
        ctx.media_rels?
            .get(id)
            .map(String::as_str)
            .filter(|s| !s.is_empty())
    };
    lookup(svg_blip_embed_id(blip))
        .or_else(|| lookup(embed_id))
        .unwrap_or("")
}

/// `parseLum`
pub(super) fn parse_lum(blip_node: Node<'_>) -> Option<Lum> {
    let lum = get(blip_node, "a:lum")?;
    let attrs = if is_object(Some(lum)) {
        Some(lum)
    } else {
        None
    };
    let pct = |v: Node<'_>| {
        let n = match v {
            Some(v) if !v.is_null() => {
                let n = parse_int(&value_to_string(Some(v)), Radix::Ten);
                if number_truthy(n) { n } else { 0.0 }
            }
            _ => 0.0,
        };
        math_max(-1.0, math_min(1.0, n / 100000.0))
    };
    let bright = pct(get(attrs, "@_bright"));
    let contrast = pct(get(attrs, "@_contrast"));
    if !number_truthy(bright) && !number_truthy(contrast) {
        return None;
    }
    Some(Lum {
        bright: JsNum(bright),
        contrast: JsNum(contrast),
    })
}

/// `parseBiLevel`
pub(super) fn parse_bi_level(blip_node: Node<'_>) -> Option<f64> {
    let bl = get(blip_node, "a:biLevel")?;
    // A bare self-closing <a:biLevel/> parses to '' and keeps the 50% default
    let thresh = if is_object(Some(bl)) {
        int_or(get(Some(bl), "@_thresh"), 50000.0)
    } else {
        50000.0
    };
    Some(math_max(0.0, math_min(1.0, thresh / 100000.0)))
}

/// `parseDuotone`
pub(super) fn parse_duotone(
    blip_node: Node<'_>,
    ctx: &ParseContext<'_>,
) -> Option<(String, String)> {
    let duo_raw = get(blip_node, "a:duotone");
    if !value_truthy(duo_raw) {
        return get(blip_node, "a:grayscl")
            .is_some()
            .then(|| ("#000000".to_owned(), "#FFFFFF".to_owned()));
    }
    let mut clrs: Vec<(String, &str)> = Vec::new();
    for tag in ["a:schemeClr", "a:srgbClr", "a:prstClr", "a:sysClr"] {
        for c in list(get(duo_raw, tag)) {
            let mut wrapper = Map::new();
            wrapper.insert(tag.to_owned(), c.clone());
            let wrapper = Value::Object(wrapper);
            if let Some(resolved) =
                resolve_color_node(Some(&wrapper), ctx).filter(|s| !s.is_empty())
            {
                clrs.push((resolved, tag));
            }
        }
    }
    if clrs.len() < 2 {
        return None;
    }
    clrs.truncate(2);
    let mut pair = clrs;
    if pair[0].1 != pair[1].1 {
        let lum = |h: &str| {
            0.299 * parse_int(&slice_utf16(h, 1.0, Some(3.0)), Radix::Sixteen)
                + 0.587 * parse_int(&slice_utf16(h, 3.0, Some(5.0)), Radix::Sixteen)
                + 0.114 * parse_int(&slice_utf16(h, 5.0, Some(7.0)), Radix::Sixteen)
        };
        sort_by_number(&mut pair, |a, b| lum(&a.0) - lum(&b.0));
    }
    let mut it = pair.into_iter();
    match (it.next(), it.next()) {
        (Some(a), Some(b)) => Some((a.0, b.0)),
        _ => None,
    }
}

/// `parseClrChange`
pub(super) fn parse_clr_change(blip_node: Node<'_>, ctx: &ParseContext<'_>) -> Option<ClrChange> {
    let cc = get(blip_node, "a:clrChange");
    if !value_truthy(cc) {
        return None;
    }
    let from = resolve_color_node(get(cc, "a:clrFrom"), ctx).filter(|s| !s.is_empty());
    let to = resolve_color_node(get(cc, "a:clrTo"), ctx).filter(|s| !s.is_empty());
    match (from, to) {
        (Some(from), Some(to)) => Some(ClrChange { from, to }),
        _ => None,
    }
}

/// `parseFill`. An element holding only text parses as a string: no fill of
/// its own.
pub(super) fn parse_fill(sp_pr: Node<'_>, ctx: &ParseContext<'_>) -> Option<Fill> {
    if !value_truthy(sp_pr) || !matches!(sp_pr, Some(Value::Object(_) | Value::Array(_))) {
        return None;
    }
    if get(sp_pr, "a:noFill").is_some() {
        return Some(Fill::None);
    }
    // <a:grpFill/>: inherit the enclosing group's grpSpPr fill
    if get(sp_pr, "a:grpFill").is_some() {
        return ctx.group_fill.cloned();
    }

    let solid = get(sp_pr, "a:solidFill");
    if value_truthy(solid)
        && let Some(color) = resolve_color_node(solid, ctx).filter(|s| !s.is_empty())
    {
        return Some(Fill::Solid { color });
    }

    let grad = get(sp_pr, "a:gradFill");
    if value_truthy(grad) {
        return parse_grad_fill(grad, ctx);
    }

    let blip = get(sp_pr, "a:blipFill");
    if value_truthy(blip) {
        let b = get(blip, "a:blip");
        let embed_id = blip_embed_id(b);
        let media_ref = blip_media_ref(b, embed_id, ctx);
        if !media_ref.is_empty() {
            let alpha_amt = get(get(b, "a:alphaModFix"), "@_amt");
            let alpha = match alpha_amt {
                Some(v) if !v.is_null() => Some(math_max(
                    0.0,
                    math_min(
                        1.0,
                        parse_int(&value_to_string(Some(v)), Radix::Ten) / 100000.0,
                    ),
                )),
                _ => None,
            };
            let duotone = parse_duotone(b, ctx);
            let clr_change = parse_clr_change(b, ctx);
            let lum = parse_lum(b);
            let bi_level = parse_bi_level(b);
            let fr = get(get(blip, "a:stretch"), "a:fillRect");
            let pct = |v: Node<'_>| match v {
                Some(v) if !v.is_null() => {
                    let n = parse_int(&value_to_string(Some(v)), Radix::Ten);
                    (if number_truthy(n) { n } else { 0.0 }) / 100000.0
                }
                _ => 0.0,
            };
            let present = |k: &str| get(fr, k).is_some_and(|v| !v.is_null());
            let fill_rect = (value_truthy(fr)
                && (present("@_l") || present("@_t") || present("@_r") || present("@_b")))
            .then(|| Insets {
                l: JsNum(pct(get(fr, "@_l"))),
                t: JsNum(pct(get(fr, "@_t"))),
                r: JsNum(pct(get(fr, "@_r"))),
                b: JsNum(pct(get(fr, "@_b"))),
            });
            let tl = get(blip, "a:tile");
            // A bare self-closing <a:tile/> parses to '' and still tiles with all defaults
            let tl_attrs = if is_object(tl) { tl } else { None };
            let tile = tl.map(|_| ImageTile {
                tx: JsNum(int_or(get(tl_attrs, "@_tx"), 0.0)),
                ty: JsNum(int_or(get(tl_attrs, "@_ty"), 0.0)),
                sx: JsNum(int_or(get(tl_attrs, "@_sx"), 100000.0) / 100000.0),
                sy: JsNum(int_or(get(tl_attrs, "@_sy"), 100000.0) / 100000.0),
                algn: match get(tl_attrs, "@_algn") {
                    Some(v) if !v.is_null() => value_to_string(Some(v)),
                    _ => "tl".to_owned(),
                },
            });
            return Some(Fill::Image(ImageFill {
                media_ref: media_ref.to_owned(),
                mode: Some(if get(blip, "a:tile").is_some() {
                    ImageMode::Tile
                } else {
                    ImageMode::Stretch
                }),
                alpha: alpha.filter(|a| *a < 1.0).map(JsNum),
                fill_rect,
                duotone,
                clr_change,
                lum,
                bi_level: bi_level.map(JsNum),
                tile,
            }));
        }
    }

    let pat = get(sp_pr, "a:pattFill");
    if value_truthy(pat) {
        let fg =
            resolve_color_node(get(pat, "a:fgClr"), ctx).unwrap_or_else(|| "#000000".to_owned());
        let bg =
            resolve_color_node(get(pat, "a:bgClr"), ctx).unwrap_or_else(|| "#FFFFFF".to_owned());
        let preset = match get(pat, "@_prst") {
            Some(v) if !v.is_null() => value_to_string(Some(v)),
            _ => "pct50".to_owned(),
        };
        return Some(Fill::Pattern(PatternFill { fg, bg, preset }));
    }

    None
}

/// `parseGradFill`
fn parse_grad_fill(grad: Node<'_>, ctx: &ParseContext<'_>) -> Option<Fill> {
    let gs_lst = get(get(grad, "a:gsLst"), "a:gs");
    let mut stops = Vec::new();
    for gs in list(gs_lst) {
        let pos = percent_fraction(get(Some(gs), "@_pos")).unwrap_or(0.0); // 0..100000 -> 0..1
        if let Some(color) = resolve_color_node(Some(gs), ctx).filter(|s| !s.is_empty()) {
            stops.push(GradientStop {
                pos: JsNum(pos),
                color,
            });
        }
    }
    if stops.is_empty() {
        return None;
    }
    // Linear gradient angle: <a:lin ang=""> (1/60000 degree). Neither a:lin
    // nor a:path renders top to bottom in PowerPoint.
    let lin = get(grad, "a:lin").filter(|v| !v.is_null());
    let path = get(grad, "a:path");
    let path_type = get(path, "@_path").and_then(Value::as_str);
    let angle = if lin.is_some() {
        let a = parse_int(&value_to_string(get(lin, "@_ang")), Radix::Ten);
        Some(if number_truthy(a) { a } else { 0.0 })
    } else if path.is_none_or(Value::is_null) {
        Some(5400000.0)
    } else {
        None
    };
    let scaled = lin.is_some()
        && matches!(
            get(lin, "@_scaled").and_then(Value::as_str),
            Some("1" | "true")
        );
    let ftr = get(path, "a:fillToRect");
    let frac = |v: Node<'_>| percent_fraction(v).unwrap_or(0.0);
    let tr = get(grad, "a:tileRect");
    let tile_rect = is_object(tr).then(|| Insets {
        l: JsNum(frac(get(tr, "@_l"))),
        t: JsNum(frac(get(tr, "@_t"))),
        r: JsNum(frac(get(tr, "@_r"))),
        b: JsNum(frac(get(tr, "@_b"))),
    });
    Some(Fill::Gradient(GradientFill {
        stops,
        angle: angle.map(JsNum),
        scaled: scaled.then_some(true),
        path: match path_type {
            Some("circle") => Some(GradientPath::Circle),
            Some("rect") => Some(GradientPath::Rect),
            Some("shape") => Some(GradientPath::Shape),
            _ => None,
        },
        fill_to: value_truthy(ftr).then(|| Insets {
            l: JsNum(frac(get(ftr, "@_l"))),
            t: JsNum(frac(get(ftr, "@_t"))),
            r: JsNum(frac(get(ftr, "@_r"))),
            b: JsNum(frac(get(ftr, "@_b"))),
        }),
        tile_rect: tile_rect.filter(|t| {
            number_truthy(t.l.0)
                || number_truthy(t.t.0)
                || number_truthy(t.r.0)
                || number_truthy(t.b.0)
        }),
    }))
}

/// `resolveColorNode`: color.ts's reader with the context's theme.
pub(super) fn resolve_color_node(node: Node<'_>, ctx: &ParseContext<'_>) -> Option<String> {
    crate::color::resolve_color_node(node, ctx.theme, ctx.ph_clr)
}

/// `COLOR_NODE_TAGS`
pub(super) const COLOR_NODE_TAGS: [&str; 6] = [
    "a:srgbClr",
    "a:schemeClr",
    "a:sysClr",
    "a:prstClr",
    "a:hslClr",
    "a:scrgbClr",
];

/// `xmlAttrEsc`
fn xml_attr_esc(v: &str) -> String {
    v.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('"', "&quot;")
}

/// `nonPlainColorNode`
pub(super) fn non_plain_color_node(container: Node<'_>) -> Option<String> {
    let container = container.filter(|v| !v.is_null())?;
    let srgb = get(Some(container), "a:srgbClr");
    let srgb_plain = match srgb {
        // Object.keys of a list are its indices
        Some(Value::Array(_)) => true,
        Some(Value::Object(o)) => !o.keys().any(|k| k.starts_with("a:")),
        _ => false,
    };
    if srgb_plain {
        return None;
    }
    color_node_xml(Some(container))
}

/// The ` name="value"` list of the `@_` keys of a node.
fn attrs_xml(node: &Value) -> String {
    let mut out = String::new();
    if let Some(o) = node.as_object() {
        for (k, v) in o {
            if let Some(name) = k.strip_prefix("@_") {
                out.push(' ');
                out.push_str(name);
                out.push_str("=\"");
                out.push_str(&xml_attr_esc(&value_to_string(Some(v))));
                out.push('"');
            }
        }
    }
    out
}

/// `colorNodeXml`
pub(super) fn color_node_xml(fill_node: Node<'_>) -> Option<String> {
    for tag in COLOR_NODE_TAGS {
        let Some(n) = get(fill_node, tag).filter(|v| !v.is_null()) else {
            continue;
        };
        let attrs = attrs_xml(n);
        let mut kids = String::new();
        if let Some(o) = n.as_object() {
            for (k, v) in o {
                if !k.starts_with("a:") {
                    continue;
                }
                let items: Vec<&Value> = match v {
                    Value::Array(items) => items.iter().collect(),
                    v => vec![v],
                };
                for c in items {
                    kids.push('<');
                    kids.push_str(k);
                    kids.push_str(&attrs_xml(c));
                    kids.push_str("/>");
                }
            }
        }
        return Some(if kids.is_empty() {
            format!("<{tag}{attrs}/>")
        } else {
            format!("<{tag}{attrs}>{kids}</{tag}>")
        });
    }
    None
}
