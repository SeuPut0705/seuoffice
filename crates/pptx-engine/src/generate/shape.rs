//! Shape half of generate.ts: fill, stroke, crop, geometry and autofit patches of an
//! element's original XML, and the branch scan of an `<mc:AlternateContent>` anchor.

use jscompat::{
    JsNum, index_of, js_regex, last_index_of, math_max, math_min, math_round, number_truthy,
    replace_first_with, try_js_regex,
};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::{
    TopLevelChild, angle_attr, clamp_int, emu_attr, escape_xml_attr, from_, hex6, is_fill_tag, lim,
    n, pos_emu_attr, sl, srgb_clr_xml, top_level_children, upto,
};
use crate::types::{GradientPath, GradientStop, Insets, SlideElement, Transform};
use crate::with_element;

// ── Alternate content ────────────────────────────────────────────────────

/// A branch root of an element anchored to a whole `<mc:AlternateContent>` block.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AlternateContentBranch {
    pub name: String,
    /// Byte range of the branch root (the p:sp / p:pic / p:graphicFrame inside the wrapper)
    pub start: usize,
    pub end: usize,
    pub tag: String,
    pub fallback: bool,
}

/// Branch roots of an element anchored to a whole `<mc:AlternateContent>` block, or `None`
/// for any other anchor.
pub fn alternate_content_branches(
    xml: &str,
) -> Result<Option<Vec<AlternateContentBranch>>, String> {
    let open_re = try_js_regex!(r#"^<mc:AlternateContent\b(?:"[^"]*"|'[^']*'|[^"'>])*>"#);
    let Some(open) = open_re.try_exec(xml).map_err(lim)? else {
        return Ok(None);
    };
    let Some(end) = last_index_of(xml, "</mc:AlternateContent>", i64::MAX) else {
        return Ok(None);
    };
    let mut out = Vec::new();
    let w_open_re = try_js_regex!(r#"^<[^\s/>]+(?:"[^"]*"|'[^']*'|[^"'>])*?>"#);
    for w in top_level_children(xml, open.end(), end)? {
        if w.name != "mc:Choice" && w.name != "mc:Fallback" {
            continue;
        }
        let Some(w_open) = w_open_re
            .try_exec(sl(xml, w.start, w.end))
            .map_err(lim)?
            .map(|m| m.as_str())
        else {
            continue;
        };
        if w_open.ends_with("/>") {
            continue;
        }
        let Some(close) = last_index_of(xml, "</", i64::try_from(w.end).unwrap_or(i64::MAX)) else {
            continue;
        };
        let root = top_level_children(xml, w.start + w_open.len(), close)?
            .into_iter()
            .next();
        if let Some(root) = root {
            out.push(AlternateContentBranch {
                tag: root.name.clone(),
                name: root.name,
                start: root.start,
                end: root.end,
                fallback: w.name == "mc:Fallback",
            });
        }
    }
    Ok(if out.is_empty() { None } else { Some(out) })
}

/// Expand a self-closing `<p:spPr/>` (common on placeholders) into a pair for child injection.
fn expand_empty_sp_pr(xml: &str) -> String {
    replace_first_with(js_regex!(r"<p:spPr(\s[^>]*?)?\/>"), xml, |m| {
        format!("<p:spPr{}></p:spPr>", m.get(1).unwrap_or_default())
    })
}

// ── Fill ─────────────────────────────────────────────────────────────────

/// Gradient fill write-back parameters (subset of the model's Fill gradient).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradientFillPatch {
    pub stops: Vec<GradientStop>,
    /// 1/60000 degree (for linear)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub angle: Option<JsNum>,
    /// Radial (alias for path: 'circle')
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<GradientPath>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill_to: Option<Insets>,
}

/// `FillPatch`: `'none' | string | GradientFillPatch | { rawFillXml }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum FillPatch {
    /// `'none'` or a color string
    Color(String),
    Gradient(GradientFillPatch),
    /// `{ rawFillXml }`
    Raw(String),
}

impl<'de> Deserialize<'de> for FillPatch {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match Value::deserialize(deserializer)? {
            Value::String(color) => Ok(Self::Color(color)),
            Value::Object(map) => {
                if let Some(raw) = map.get("rawFillXml") {
                    return match raw {
                        Value::String(raw) => Ok(Self::Raw(raw.clone())),
                        _ => Err(D::Error::custom("rawFillXml is not a string")),
                    };
                }
                serde_json::from_value(Value::Object(map))
                    .map(Self::Gradient)
                    .map_err(D::Error::custom)
            }
            _ => Err(D::Error::custom("not a fill patch")),
        }
    }
}

fn path_kind(p: GradientPath) -> &'static str {
    match p {
        GradientPath::Circle => "circle",
        GradientPath::Rect => "rect",
        GradientPath::Shape => "shape",
    }
}

fn gs_lst_xml(stops: &[GradientStop]) -> String {
    // srgbClrXml keeps an #RRGGBBAA stop's alpha as <a:alpha>
    let mut out = String::from("<a:gsLst>");
    for s in stops {
        out += &format!(
            "<a:gs pos=\"{}\">{}</a:gs>",
            n(math_round(
                math_max(0.0, math_min(1.0, s.pos.0)) * 100_000.0
            )),
            srgb_clr_xml(&s.color)
        );
    }
    out += "</a:gsLst>";
    out
}

/// Path gradient (circle/rect/shape) focused on fillTo (default: centered)
fn grad_path_xml(kind: &str, fill_to: Option<&Insets>) -> String {
    let pct = |v: f64| n(math_round(v * 100_000.0));
    let ftr = fill_to.copied().unwrap_or(Insets {
        l: JsNum(0.5),
        t: JsNum(0.5),
        r: JsNum(0.5),
        b: JsNum(0.5),
    });
    format!(
        "<a:path path=\"{kind}\"><a:fillToRect l=\"{}\" t=\"{}\" r=\"{}\" b=\"{}\"/></a:path>",
        pct(ftr.l.0),
        pct(ftr.t.0),
        pct(ftr.r.0),
        pct(ftr.b.0)
    )
}

/// Requested path kind of a gradient patch (radial is a legacy alias for circle).
fn grad_path_kind(patch: &GradientFillPatch) -> Option<&'static str> {
    match patch.path {
        Some(p) => Some(path_kind(p)),
        None => (patch.radial == Some(true)).then_some("circle"),
    }
}

fn lin_xml(angle: Option<JsNum>, scaled: &str) -> String {
    format!(
        "<a:lin ang=\"{}\" scaled=\"{scaled}\"/>",
        n(math_round(angle.map_or(0.0, |a| a.0)))
    )
}

pub(crate) fn build_fill_xml(fill: &FillPatch) -> String {
    match fill {
        FillPatch::Raw(raw) => raw.clone(),
        FillPatch::Gradient(g) => build_gradient_xml(g),
        FillPatch::Color(c) if c == "none" => "<a:noFill/>".to_owned(),
        FillPatch::Color(c) => format!("<a:solidFill>{}</a:solidFill>", srgb_clr_xml(c)),
    }
}

pub(crate) fn build_gradient_xml(g: &GradientFillPatch) -> String {
    let shade = match grad_path_kind(g) {
        Some(kind) => grad_path_xml(kind, g.fill_to.as_ref()),
        None => lin_xml(g.angle, "1"),
    };
    format!(
        "<a:gradFill rotWithShape=\"1\">{}{shade}</a:gradFill>",
        gs_lst_xml(&g.stops)
    )
}

/// In-place patch between fills of the same kind, preserving unmodeled parameters.
fn patch_fill_node_xml(
    existing_xml: &str,
    existing_name: &str,
    fill: &FillPatch,
) -> Result<String, String> {
    if let FillPatch::Color(color) = fill
        && color != "none"
        && existing_name == "a:solidFill"
    {
        // An 8-digit color carries an explicit alpha (FF = explicitly opaque); a 6-digit
        // color is a plain color change and keeps the original alpha.
        let digits = color.strip_prefix('#').unwrap_or(color);
        if digits.encode_utf16().count() >= 8 {
            return Ok(format!(
                "<a:solidFill>{}</a:solidFill>",
                srgb_clr_xml(color)
            ));
        }
        let alpha = js_regex!(r"<a:alpha\s[^>]*\/>")
            .exec(existing_xml)
            .map(|m| m.as_str());
        return Ok(match alpha {
            Some(alpha) => format!(
                "<a:solidFill><a:srgbClr val=\"{}\">{alpha}</a:srgbClr></a:solidFill>",
                hex6(color)
            ),
            None => format!(
                "<a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>",
                hex6(color)
            ),
        });
    }
    if let FillPatch::Gradient(g) = fill
        && existing_name == "a:gradFill"
    {
        return patch_grad_fill_xml(existing_xml, g);
    }
    Ok(build_fill_xml(fill))
}

fn patch_grad_fill_xml(grad_xml: &str, patch: &GradientFillPatch) -> Result<String, String> {
    let open_re = try_js_regex!(r#"^<a:gradFill((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>"#);
    let Some(open) = open_re.try_exec(grad_xml).map_err(lim)? else {
        return Ok(build_gradient_xml(patch));
    };
    if open.get(2) == Some("/") {
        return Ok(build_gradient_xml(patch));
    }
    let inner_start = open.end();
    let Some(inner_end) = last_index_of(grad_xml, "</a:gradFill>", i64::MAX) else {
        return Ok(build_gradient_xml(patch));
    };
    let children = top_level_children(grad_xml, inner_start, inner_end)?;

    let mut parts: Vec<String> = Vec::new();
    let mut gs_idx: Option<usize> = None;
    let mut has_shade = false;
    for c in &children {
        let seg = sl(grad_xml, c.start, c.end);
        if c.name == "a:gsLst" {
            gs_idx = Some(parts.len());
            parts.push(gs_lst_xml(&patch.stops));
        } else if c.name == "a:lin" || c.name == "a:path" {
            if let Some(kind) = grad_path_kind(patch) {
                if c.name == "a:path" {
                    let existing_kind = js_regex!(r#"path="([^"]*)""#)
                        .exec(seg)
                        .and_then(|m| m.get(1));
                    // The same (or legacy radial's unspecified) path kind keeps the original
                    // node; an explicit kind change or focus change replaces it.
                    let keep = match patch.path {
                        Some(p) => existing_kind == Some(path_kind(p)) && patch.fill_to.is_none(),
                        None => patch.fill_to.is_none(),
                    };
                    parts.push(if keep {
                        seg.to_owned()
                    } else {
                        grad_path_xml(patch.path.map_or(kind, path_kind), patch.fill_to.as_ref())
                    });
                    has_shade = true;
                }
            } else if c.name == "a:lin" {
                let scaled = js_regex!(r#"\sscaled="([^"]*)""#)
                    .exec(seg)
                    .and_then(|m| m.get(1))
                    .unwrap_or("1");
                parts.push(lin_xml(patch.angle, scaled));
                has_shade = true;
            }
        } else {
            parts.push(seg.to_owned());
        }
    }
    let Some(gs_idx) = gs_idx else {
        return Ok(build_gradient_xml(patch));
    };
    if !has_shade {
        let shade = match grad_path_kind(patch) {
            Some(kind) => grad_path_xml(kind, patch.fill_to.as_ref()),
            None => lin_xml(patch.angle, "1"),
        };
        // in the lin/path sequence it immediately follows gsLst
        parts.insert(gs_idx + 1, shade);
    }
    Ok(format!(
        "<a:gradFill{}>{}</a:gradFill>",
        open.get(1).unwrap_or_default(),
        parts.concat()
    ))
}

/// The `<p:spPr>` of a fragment: the content range, when it has one.
fn sp_pr_range(xml: &str) -> Option<(usize, usize)> {
    let open = js_regex!(r"<p:spPr(\s[^>]*)?>").exec(xml)?;
    let inner_start = open.end();
    let close = index_of(xml, "</p:spPr>", inner_start)?;
    Some((inner_start, close))
}

/// In-place patch of an element's shape fill (the fill node that is a direct child of spPr).
pub fn patch_element_fill(original_xml: &str, fill: &FillPatch) -> Result<String, String> {
    let original_xml = expand_empty_sp_pr(original_xml);
    let Some((inner_start, sp_pr_close)) = sp_pr_range(&original_xml) else {
        return Ok(original_xml);
    };
    let children = top_level_children(&original_xml, inner_start, sp_pr_close)?;
    if let Some(existing) = children.iter().find(|c| is_fill_tag(&c.name)) {
        let fill_xml = patch_fill_node_xml(
            sl(&original_xml, existing.start, existing.end),
            &existing.name,
            fill,
        )?;
        return Ok(format!(
            "{}{fill_xml}{}",
            upto(&original_xml, existing.start),
            from_(&original_xml, existing.end)
        ));
    }
    let fill_xml = build_fill_xml(fill);
    // Insert after the geometry (OOXML order: xfrm → geom → fill → ln)
    let anchor = children
        .iter()
        .find(|c| c.name == "a:prstGeom" || c.name == "a:custGeom")
        .or_else(|| children.iter().find(|c| c.name == "a:xfrm"));
    let at = anchor.map_or(inner_start, |c| c.end);
    Ok(format!(
        "{}{fill_xml}{}",
        upto(&original_xml, at),
        from_(&original_xml, at)
    ))
}

// ── Stroke ───────────────────────────────────────────────────────────────

/// Gradient line of a `StrokePatch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrokeGradient {
    pub stops: Vec<GradientStop>,
    /// 1/60000°
    pub angle: JsNum,
}

/// Stroke write-back parameters.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrokePatch {
    pub color: String,
    pub width_emu: JsNum,
    /// prstDash preset name; 'solid' removes the prstDash node; absent keeps the original bytes
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dash: Option<String>,
    /// Line cap attribute ('flat' | 'rnd' | 'sq'; absent keeps the original bytes)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap: Option<String>,
    /// Compound type attribute ('sng' removes it; absent keeps the original bytes)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compound: Option<String>,
    /// Join child element ('round' | 'bevel' | 'miter'; absent keeps the original bytes)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient: Option<StrokeGradient>,
}

/// `JOIN_XML[join]`; a key outside the table reads `undefined`, which a template prints.
fn join_xml(join: &str) -> &'static str {
    match join {
        "round" => "<a:round/>",
        "bevel" => "<a:bevel/>",
        // PowerPoint's default miter limit (8×)
        "miter" => "<a:miter lim=\"800000\"/>",
        _ => "undefined",
    }
}

/// The `<a:ln>` fill child for a stroke patch: gradient line, solid color (alpha kept), or noFill.
fn stroke_fill_xml(stroke: Option<&StrokePatch>) -> String {
    let Some(stroke) = stroke else {
        return "<a:noFill/>".to_owned();
    };
    if let Some(g) = stroke.gradient.as_ref() {
        return build_gradient_xml(&GradientFillPatch {
            stops: g.stops.clone(),
            angle: Some(g.angle),
            ..GradientFillPatch::default()
        });
    }
    format!("<a:solidFill>{}</a:solidFill>", srgb_clr_xml(&stroke.color))
}

/// Set/replace/remove one attribute inside an `<a:ln>` attribute string; the value goes in as given.
fn set_ln_attr(attrs: &str, name: &str, value: Option<&str>) -> Result<String, String> {
    // `name` is one of the attributes of an `<a:ln>` this file sets: a literal pattern each
    macro_rules! attr_re {
        ($name:literal) => {
            js_regex!(concat!(r"\s", $name, r#"="[^"]*""#))
        };
    }
    let re = match name {
        "w" => attr_re!("w"),
        "cap" => attr_re!("cap"),
        "cmpd" => attr_re!("cmpd"),
        _ => return Err(format!("no attribute pattern for {name}")),
    };
    let Some(value) = value else {
        return Ok(replace_first_with(re, attrs, |_| String::new()));
    };
    let decl = format!("{name}=\"{value}\"");
    Ok(if re.test(attrs) {
        replace_first_with(re, attrs, |_| format!(" {decl}"))
    } else {
        format!(" {decl}{attrs}")
    })
}

fn truthy(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

/// `inner.indexOf(fill_xml) + fill_xml.length`, -1 reading as the JavaScript does.
fn after_fill(inner: &str, fill_xml: &str) -> usize {
    match index_of(inner, fill_xml, 0) {
        Some(at) => at + fill_xml.len(),
        None => fill_xml.len().saturating_sub(1),
    }
}

/// In-place patch of `<a:ln>`: change the w/cap/cmpd attributes, replace the fill child and
/// (when requested) the prstDash / join children; all other bytes are kept.
fn patch_ln_xml(ln_xml: &str, stroke: Option<&StrokePatch>) -> Result<String, String> {
    let open_re = try_js_regex!(r#"^<a:ln((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>"#);
    let Some(open) = open_re.try_exec(ln_xml).map_err(lim)? else {
        return Ok(ln_xml.to_owned());
    };
    let mut attrs = open.get(1).unwrap_or_default().to_owned();
    if let Some(stroke) = stroke {
        attrs = set_ln_attr(
            &attrs,
            "w",
            Some(&n(clamp_int(stroke.width_emu.0, 0.0, 20_116_800.0))),
        )?;
        if let Some(cap) = stroke.cap.as_deref() {
            attrs = set_ln_attr(&attrs, "cap", Some(cap))?;
        }
        if let Some(compound) = stroke.compound.as_deref() {
            attrs = set_ln_attr(
                &attrs,
                "cmpd",
                if compound == "sng" {
                    None
                } else {
                    Some(compound)
                },
            )?;
        }
    }
    let fill_xml = stroke_fill_xml(stroke);
    let dash_xml = match stroke.and_then(|s| truthy(&s.dash)) {
        Some(d) if d != "solid" => format!("<a:prstDash val=\"{}\"/>", escape_xml_attr(d)),
        _ => String::new(),
    };
    let join_xml_text = stroke
        .and_then(|s| truthy(&s.join))
        .map_or("", join_xml)
        .to_owned();
    if open.get(2) == Some("/") {
        return Ok(format!(
            "<a:ln{attrs}>{fill_xml}{dash_xml}{join_xml_text}</a:ln>"
        ));
    }
    let inner_start = open.end();
    let Some(inner_end) = last_index_of(ln_xml, "</a:ln>", i64::MAX) else {
        return Ok(ln_xml.to_owned());
    };
    let children = top_level_children(ln_xml, inner_start, inner_end)?;
    let fill = children.iter().find(|c| is_fill_tag(&c.name));
    // fill is the first child in the CT_LineProperties sequence; insert at the front when missing
    let mut inner = match fill {
        Some(f) => format!(
            "{}{fill_xml}{}",
            sl(ln_xml, inner_start, f.start),
            sl(ln_xml, f.end, inner_end)
        ),
        None => format!("{fill_xml}{}", sl(ln_xml, inner_start, inner_end)),
    };
    let dash_re = js_regex!(r"<a:prstDash\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/a:prstDash>)");
    if let Some(s) = stroke
        && s.dash.is_some()
    {
        inner = replace_first_with(dash_re, &inner, |_| String::new());
        if !dash_xml.is_empty() {
            // CT_LineProperties order: fill → prstDash → join → headEnd → tailEnd
            let fill_end = after_fill(&inner, &fill_xml);
            inner = format!(
                "{}{dash_xml}{}",
                upto(&inner, fill_end),
                from_(&inner, fill_end)
            );
        }
    }
    if let Some(s) = stroke
        && s.join.is_some()
    {
        inner = replace_first_with(
            js_regex!(
                r"<a:(?:round|bevel|miter)\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/a:(?:round|bevel|miter)>)"
            ),
            &inner,
            |_| String::new(),
        );
        // join sits after prstDash (when present), otherwise right after the fill
        let at = match dash_re.exec(&inner) {
            Some(d) => d.end(),
            None => after_fill(&inner, &fill_xml),
        };
        inner = format!("{}{join_xml_text}{}", upto(&inner, at), from_(&inner, at));
    }
    Ok(format!("<a:ln{attrs}>{inner}</a:ln>"))
}

/// In-place patch of an element's stroke (the `<a:ln>` direct child of spPr).
pub fn patch_element_stroke(
    original_xml: &str,
    stroke: Option<&StrokePatch>,
) -> Result<String, String> {
    let original_xml = expand_empty_sp_pr(original_xml);
    let Some((inner_start, sp_pr_close)) = sp_pr_range(&original_xml) else {
        return Ok(original_xml);
    };
    let children = top_level_children(&original_xml, inner_start, sp_pr_close)?;
    if let Some(existing) = children.iter().find(|c| c.name == "a:ln") {
        let patched = patch_ln_xml(sl(&original_xml, existing.start, existing.end), stroke)?;
        return Ok(format!(
            "{}{patched}{}",
            upto(&original_xml, existing.start),
            from_(&original_xml, existing.end)
        ));
    }

    let ln_xml = match stroke {
        Some(s) => {
            let mut ln = format!(
                "<a:ln w=\"{}\"",
                n(clamp_int(s.width_emu.0, 0.0, 20_116_800.0))
            );
            if let Some(cap) = truthy(&s.cap) {
                ln += &format!(" cap=\"{cap}\"");
            }
            if let Some(c) = truthy(&s.compound)
                && c != "sng"
            {
                ln += &format!(" cmpd=\"{c}\"");
            }
            ln += &format!(">{}", stroke_fill_xml(stroke));
            if let Some(d) = truthy(&s.dash)
                && d != "solid"
            {
                ln += &format!("<a:prstDash val=\"{}\"/>", escape_xml_attr(d));
            }
            if let Some(j) = truthy(&s.join) {
                ln += join_xml(j);
            }
            ln += "</a:ln>";
            ln
        }
        None => "<a:ln><a:noFill/></a:ln>".to_owned(),
    };
    // Insert after fill / geometry / xfrm (OOXML order: xfrm → geom → fill → ln)
    let anchor = children
        .iter()
        .find(|c| is_fill_tag(&c.name))
        .or_else(|| {
            children
                .iter()
                .find(|c| c.name == "a:prstGeom" || c.name == "a:custGeom")
        })
        .or_else(|| children.iter().find(|c| c.name == "a:xfrm"));
    let at = anchor.map_or(inner_start, |c: &TopLevelChild| c.end);
    Ok(format!(
        "{}{ln_xml}{}",
        upto(&original_xml, at),
        from_(&original_xml, at)
    ))
}

// ── Picture crop ─────────────────────────────────────────────────────────

/// In-place patch of the `<a:srcRect>` inside a `<p:pic>`'s `<p:blipFill>`:
/// `None` removes the srcRect; otherwise writes the l/t/r/b attributes (1/1000 %).
pub fn patch_picture_src_rect(
    original_xml: &str,
    src_rect: Option<&Insets>,
) -> Result<String, String> {
    let blip_fill_re = js_regex!(r"<p:blipFill(\s[^>]*)?>");
    let Some(open) = blip_fill_re.exec(original_xml) else {
        return Ok(original_xml.to_owned());
    };
    let inner_start = open.end();
    let Some(blip_fill_close) = index_of(original_xml, "</p:blipFill>", inner_start) else {
        return Ok(original_xml.to_owned());
    };

    // Remove the old srcRect
    let window = sl(
        original_xml,
        open.start(),
        blip_fill_close + "</p:blipFill>".len(),
    );
    let existing =
        js_regex!(r"<a:srcRect[^/]*\/>|<a:srcRect[^>]*>[\s\S]*?<\/a:srcRect>").exec(window);
    let mut xml_inner = original_xml.to_owned();
    if let Some(existing) = existing {
        let abs_start = open.start() + existing.start();
        xml_inner = format!(
            "{}{}",
            upto(original_xml, abs_start),
            from_(original_xml, abs_start + existing.as_str().len())
        );
    }

    let Some(src_rect) = src_rect else {
        return Ok(xml_inner);
    };

    // 0 values are omitted (OOXML minimalism)
    let to5 = |v: f64| math_round(math_max(0.0, math_min(1.0, v)) * 100_000.0);
    let mut attrs = String::new();
    for (name, v) in [
        ("l", src_rect.l.0),
        ("t", src_rect.t.0),
        ("r", src_rect.r.0),
        ("b", src_rect.b.0),
    ] {
        let v = to5(v);
        if number_truthy(v) {
            attrs += &format!(" {name}=\"{}\"", n(v));
        }
    }
    let src_rect_xml = format!("<a:srcRect{attrs}/>");

    // Insert after <a:blip> (OOXML blipFill order: blip → srcRect → fillMode)
    let Some(open_new) = blip_fill_re.exec(&xml_inner) else {
        return Ok(xml_inner);
    };
    let inner_start_new = open_new.end();
    let Some(close_new) = index_of(&xml_inner, "</p:blipFill>", inner_start_new) else {
        return Ok(xml_inner);
    };
    let children = top_level_children(&xml_inner, inner_start_new, close_new)?;
    let insert_at = children
        .iter()
        .find(|c| c.name == "a:blip")
        .map_or(inner_start_new, |c| c.end);
    Ok(format!(
        "{}{src_rect_xml}{}",
        upto(&xml_inner, insert_at),
        from_(&xml_inner, insert_at)
    ))
}

// ── Geometry ─────────────────────────────────────────────────────────────

fn xfrm_attrs(t: &Transform) -> String {
    let mut attrs = String::new();
    if number_truthy(t.rot.0) {
        attrs += &format!(" rot=\"{}\"", angle_attr(t.rot.0));
    }
    if t.flip_h {
        attrs += " flipH=\"1\"";
    }
    if t.flip_v {
        attrs += " flipV=\"1\"";
    }
    attrs
}

fn off_ext_xml(t: &Transform) -> String {
    let o = &t.offset;
    format!(
        "<a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/>",
        emu_attr(o.x.0),
        emu_attr(o.y.0),
        pos_emu_attr(o.cx.0),
        pos_emu_attr(o.cy.0)
    )
}

pub fn generate_xfrm_xml(t: &Transform, tag: &str) -> String {
    format!("<{tag}{}>{}</{tag}>", xfrm_attrs(t), off_ext_xml(t))
}

/// In-place patch of an element's xfrm (off/ext/rot/flip all taken from the model).
pub fn patch_element_xfrm(el: &SlideElement, original_xml: &str) -> String {
    let Some(t) = with_element!(el, e => *e.transform) else {
        return original_xml.to_owned();
    };
    use crate::types::ElementType;
    let is_frame = matches!(
        el.element_type(),
        Some(ElementType::Table | ElementType::Chart | ElementType::Passthrough)
    );
    let xfrm_tag = if is_frame { "p:xfrm" } else { "a:xfrm" };
    let open_re = if is_frame {
        js_regex!(r"<p:xfrm(\s[^>]*)?>")
    } else {
        js_regex!(r"<a:xfrm(\s[^>]*)?>")
    };
    if let Some(open) = open_re.exec(original_xml) {
        let start = open.start();
        let close_tag = format!("</{xfrm_tag}>");
        let Some(close) = index_of(original_xml, &close_tag, start) else {
            return original_xml.to_owned();
        };
        let end = close + close_tag.len();
        let inner = sl(original_xml, open.end(), close);
        // Keep children other than off/ext (chOff/chExt…)
        let rest =
            js_regex!(r"<a:off\s[^>]*\/>|<a:ext\s[^>]*\/>").replace_all(inner, |_| String::new());
        let replaced = format!(
            "<{xfrm_tag}{}>{}{rest}</{xfrm_tag}>",
            xfrm_attrs(&t),
            off_ext_xml(&t)
        );
        return format!(
            "{}{replaced}{}",
            upto(original_xml, start),
            from_(original_xml, end)
        );
    }
    if is_frame {
        return original_xml.to_owned();
    }
    // No xfrm: inject after the spPr / grpSpPr open tag (self-closing <p:spPr/> expanded first)
    let Some(sp_pr) =
        js_regex!(r"<(p:spPr|p:grpSpPr|pic:spPr)(\s[^>]*?)?(\/?)>").exec(original_xml)
    else {
        return original_xml.to_owned();
    };
    let tag = sp_pr.get(1).unwrap_or_default();
    if sp_pr.get(3) == Some("/") {
        return format!(
            "{}<{tag}{}>{}</{tag}>{}",
            upto(original_xml, sp_pr.start()),
            sp_pr.get(2).unwrap_or_default(),
            generate_xfrm_xml(&t, "a:xfrm"),
            from_(original_xml, sp_pr.end())
        );
    }
    let insert_at = sp_pr.end();
    format!(
        "{}{}{}",
        upto(original_xml, insert_at),
        generate_xfrm_xml(&t, "a:xfrm"),
        from_(original_xml, insert_at)
    )
}

/// Write back `<a:normAutofit>`'s fontScale/lnSpcReduction (thousandths of a percent).
pub fn patch_body_pr_autofit(xml: &str, font_scale: f64, ln_spc_reduction: Option<f64>) -> String {
    let mut attrs = String::new();
    if font_scale < 0.999 {
        attrs += &format!(
            " fontScale=\"{}\"",
            n(clamp_int(font_scale * 100_000.0, 1000.0, 100_000.0))
        );
    }
    if let Some(l) = ln_spc_reduction
        && number_truthy(l)
    {
        attrs += &format!(
            " lnSpcReduction=\"{}\"",
            n(clamp_int(l * 100_000.0, 0.0, 13_200_000.0))
        );
    }
    replace_first_with(
        js_regex!(r"<a:normAutofit\b[^>]*?(?:\/>|>\s*<\/a:normAutofit>)"),
        xml,
        |_| format!("<a:normAutofit{attrs}/>"),
    )
}
