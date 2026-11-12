//! Shape editing of packages/pptx-engine/src/index.ts, lines 1155-1923: picture crop,
//! preset and custom geometry, adjust handles, text body properties, effects, fill,
//! picture/texture fill, redaction, picture opacity and picture replacement.

use std::sync::Arc;

use jscompat::{
    JsNum, JsObject, Slot, TryJsRegex, is_js_space, js_regex, math_max, math_min, math_round,
    number_to_string, number_truthy, regex_escape, replace_first_with, trim,
    try_replace_first_with,
};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use super::{
    OpenedPptx, image_rel_for, patch_anchor_xml, patch_group_child_xml, patch_slide_xml,
    patched_element_xml,
};
use crate::custgeom::{CustGeomPath, cust_geom_xml, parse_cust_geom, valid_cust_geom_path};
use crate::generate::{FillPatch, GradientFillPatch, patch_element_fill, top_level_children};
use crate::insert::add_image_media_and_rel;
use crate::preset_shape_types::is_preset_shape_type;
use crate::redaction_xml::{strip_redact_ext, sync_redact_ext};
use crate::resource_cleanup::cleanup_superseded_slide_resources;
use crate::types::{
    Autofit, ElementType, Fill, GlowEffect, GradientFill, ImageFill, ImageMode, ImageTile, Insets,
    ReflectionEffect, ShadowEffect, Slide, SlideElement, TextAnchor, TextInsets, TextVert,
};

// ── Shared helpers ─────────────────────────────────────────────────────

fn position(slide: &Slide, id: &str, accept: impl Fn(&SlideElement) -> bool) -> Option<usize> {
    slide
        .elements
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .position(|e| e.id() == id && accept(e))
}

fn element_at(slide: &mut Slide, at: usize) -> Option<&mut SlideElement> {
    slide.elements.as_mut()?.get_mut(at)
}

fn is_text_or_shape(el: &SlideElement) -> bool {
    matches!(el, SlideElement::Text(t)
        if matches!(*t.r#type, Some(ElementType::Text | ElementType::Shape)))
}

fn is_picture(el: &SlideElement) -> bool {
    matches!(el, SlideElement::Picture(p) if matches!(*p.r#type, Some(ElementType::Picture)))
}

fn is_group(el: &SlideElement) -> bool {
    matches!(el, SlideElement::Group(g) if matches!(*g.r#type, Some(ElementType::Group)))
}

fn has_text(el: &SlideElement) -> bool {
    matches!(el, SlideElement::Text(t) if t.text.is_some())
}

/// `el.dirty = el.dirtyTransform = el.dirtyFill = el.dirtyStroke = false; el.dirtyPPr = undefined`
/// (the chain assigns right to left: that is the order the keys appear in).
fn clear_dirty(el: &mut SlideElement) {
    crate::with_element!(el, e => {
        e.dirty_stroke.set(false);
        e.dirty_fill.set(false);
        e.dirty_transform.set(false);
        e.dirty.set(false);
        e.dirty_p_pr.assign(None);
    })
}

/// `el.anchor.originalXml = xml`
fn set_original_xml(el: &mut SlideElement, xml: &str) {
    crate::with_element!(el, e => {
        if let Some(anchor) = e.anchor.as_mut() {
            anchor.original_xml = Arc::from(xml);
        }
    })
}

fn slice(text: &str, from: usize, to: usize) -> &str {
    text.get(from..to).unwrap_or_default()
}

fn rnd(v: f64) -> String {
    number_to_string(math_round(v))
}

/// `Math.max(0, Math.round(v))`
fn rnd0(v: f64) -> f64 {
    math_max(0.0, math_round(v))
}

fn rnd0s(v: f64) -> String {
    number_to_string(rnd0(v))
}

// ── Picture crop ───────────────────────────────────────────────────────

pub fn edit_picture_src_rect(slide: &mut Slide, source_id: &str, src_rect: Option<Insets>) -> bool {
    let Some(at) = position(slide, source_id, is_picture) else {
        return false;
    };
    let Some(SlideElement::Picture(pic)) = element_at(slide, at) else {
        return false;
    };
    match src_rect {
        Some(r)
            if !number_truthy(r.l.0)
                && !number_truthy(r.t.0)
                && !number_truthy(r.r.0)
                && !number_truthy(r.b.0) =>
        {
            pic.src_rect.assign(None)
        }
        other => pic.src_rect.assign(other),
    }
    pic.dirty_src_rect.set(true);
    true
}

// ── Geometry ───────────────────────────────────────────────────────────

pub fn set_shape_preset_geometry(slide: &mut Slide, element_id: &str, prst: &str) -> bool {
    if !is_preset_shape_type(prst) {
        return false;
    }
    let Some(at) = position(slide, element_id, |_| true) else {
        return false;
    };
    let Some(el) = element_at(slide, at) else {
        return false;
    };
    if !is_text_or_shape(el) {
        return false;
    }
    let Some(xml) = swap_geometry_xml(&patched_element_xml(el), &preset_geom_xml(prst)) else {
        return false;
    };
    clear_dirty(el);
    set_original_xml(el, &xml);
    if let SlideElement::Text(shape) = el {
        shape.preset_geometry.set(prst.to_owned());
        shape.adjust.delete();
        shape.custom_geometry.delete();
    }
    slide.structure_dirty.set(true);
    true
}

/// `geom` is the `CustGeomPath` as JSON, validated as `validCustGeomPath` does.
pub fn set_shape_custom_geometry(
    slide: &mut Slide,
    element_id: &str,
    geom: Option<&Value>,
) -> Result<bool, String> {
    if !valid_cust_geom_path(geom)? {
        return Ok(false);
    }
    let Some(at) = position(slide, element_id, |_| true) else {
        return Ok(false);
    };
    let Some(el) = element_at(slide, at) else {
        return Ok(false);
    };
    if !is_text_or_shape(el) {
        return Ok(false);
    }
    let path: CustGeomPath = serde_json::from_value(geom.cloned().unwrap_or(Value::Null))
        .map_err(|error| error.to_string())?;
    let Some(xml) = swap_geometry_xml(&patched_element_xml(el), &cust_geom_xml(&path)) else {
        return Ok(false);
    };
    clear_dirty(el);
    set_original_xml(el, &xml);
    if let SlideElement::Text(shape) = el {
        apply_custom_geometry_model(shape, &xml)?;
    }
    slide.structure_dirty.set(true);
    Ok(true)
}

pub(crate) fn apply_custom_geometry_model(
    shape: &mut crate::types::TextElement,
    xml: &str,
) -> Result<(), String> {
    let Some(transform) = *shape.transform else {
        return Err("TypeError: Cannot read properties of undefined (reading 'offset')".to_owned());
    };
    let (cx, cy) = (transform.offset.cx.0, transform.offset.cy.0);
    shape.preset_geometry.delete();
    shape.adjust.delete();
    shape.no_geometry.delete();
    let parsed = parse_cust_geom(xml, cx, cy).map_err(|error| error.to_string())?;
    shape.custom_geometry.assign(parsed);
    Ok(())
}

fn av_lst_xml(adjust: &JsObject<f64>) -> String {
    let gds: String = adjust
        .entries()
        .into_iter()
        .map(|(n, v)| format!("<a:gd name=\"{n}\" fmla=\"val {}\"/>", rnd(*v)))
        .collect();
    format!("<a:avLst>{gds}</a:avLst>")
}

pub(crate) fn valid_adjust(adjust: &JsObject<f64>) -> bool {
    !adjust.is_empty()
        && adjust.entries().into_iter().all(|(n, v)| {
            !n.is_empty() && n.bytes().all(|b| b.is_ascii_alphanumeric()) && v.is_finite()
        })
}

pub(crate) fn swap_av_lst_xml(xml: &str, adjust: &JsObject<f64>) -> Option<String> {
    let open = js_regex!(r"<a:prstGeom\b[^>]*?(\/?)>").exec(xml)?;
    let av = av_lst_xml(adjust);
    let (start, end) = (open.start(), open.end());
    if open.get(1) == Some("/") {
        let whole = open.as_str();
        let tag = format!("{}>", slice(whole, 0, whole.len().saturating_sub(2)));
        return Some(format!(
            "{}{tag}{av}</a:prstGeom>{}",
            slice(xml, 0, start),
            xml.get(end..).unwrap_or_default()
        ));
    }
    let close = xml.get(start..)?.find("</a:prstGeom>")? + start;
    let inner = slice(xml, end, close);
    let av_re = js_regex!(r"<a:avLst\b[^>]*\/>|<a:avLst\b[\s\S]*?<\/a:avLst>");
    let new_inner = if av_re.test(inner) {
        replace_first_with(av_re, inner, |_| av.clone())
    } else {
        format!("{av}{inner}")
    };
    Some(format!(
        "{}{new_inner}{}",
        slice(xml, 0, end),
        xml.get(close..).unwrap_or_default()
    ))
}

pub fn set_shape_adjust_values(
    slide: &mut Slide,
    element_id: &str,
    adjust: &JsObject<f64>,
) -> bool {
    if !valid_adjust(adjust) {
        return false;
    }
    let Some(at) = position(slide, element_id, |_| true) else {
        return false;
    };
    let Some(el) = element_at(slide, at) else {
        return false;
    };
    if !is_text_or_shape(el) {
        return false;
    }
    let Some(xml) = swap_av_lst_xml(&patched_element_xml(el), adjust) else {
        return false;
    };
    clear_dirty(el);
    set_original_xml(el, &xml);
    if let SlideElement::Text(shape) = el {
        let copy: JsObject<JsNum> = adjust
            .entries()
            .into_iter()
            .map(|(k, v)| (k.to_owned(), JsNum(*v)))
            .collect();
        shape.adjust.set(copy);
    }
    slide.structure_dirty.set(true);
    true
}

pub(crate) fn preset_geom_xml(prst: &str) -> String {
    format!("<a:prstGeom prst=\"{prst}\"><a:avLst/></a:prstGeom>")
}

pub(crate) fn swap_geometry_xml(xml: &str, geom_xml: &str) -> Option<String> {
    let existing = js_regex!(
        r"<a:prstGeom\b[^>]*\/>|<a:prstGeom\b[\s\S]*?<\/a:prstGeom>|<a:custGeom\b[\s\S]*?<\/a:custGeom>"
    )
    .exec(xml);
    if let Some(m) = existing {
        return Some(format!(
            "{}{geom_xml}{}",
            slice(xml, 0, m.start()),
            xml.get(m.end()..).unwrap_or_default()
        ));
    }
    let close = js_regex!(r"<\/a:xfrm>").exec(xml)?;
    let at = close.end();
    Some(format!(
        "{}{geom_xml}{}",
        slice(xml, 0, at),
        xml.get(at..).unwrap_or_default()
    ))
}

// ── Text body ──────────────────────────────────────────────────────────

pub fn set_element_text_anchor(slide: &mut Slide, element_id: &str, anchor: TextAnchor) -> bool {
    let Some(at) = position(slide, element_id, |_| true) else {
        return false;
    };
    let Some(el) = element_at(slide, at) else {
        return false;
    };
    if !is_text_or_shape(el) || !has_text(el) {
        return false;
    }
    let xml = patched_element_xml(el);
    let val = match anchor {
        TextAnchor::Middle => "ctr",
        TextAnchor::Bottom => "b",
        TextAnchor::Top => "t",
    };
    let Some(m) = js_regex!(r"<a:bodyPr\b[^>]*?\/?>").exec(&xml) else {
        return false;
    };
    let stripped = replace_first_with(js_regex!(r#"\s+anchor="[^"]*""#), m.as_str(), |_| {
        String::new()
    });
    let tag = match stripped.strip_prefix("<a:bodyPr") {
        Some(rest) => format!("<a:bodyPr anchor=\"{val}\"{rest}"),
        None => stripped,
    };
    let xml = format!(
        "{}{tag}{}",
        slice(&xml, 0, m.start()),
        xml.get(m.end()..).unwrap_or_default()
    );
    clear_dirty(el);
    set_original_xml(el, &xml);
    if let SlideElement::Text(t) = el
        && let Some(text) = t.text.as_mut()
    {
        text.anchor.set(anchor);
    }
    slide.structure_dirty.set(true);
    true
}

const BODY_PR: &str = r"<a:bodyPr\b[^>]*?\/>|<a:bodyPr\b[^>]*>[\s\S]*?<\/a:bodyPr>";

pub fn autofit_generated_text_boxes(slide: &mut Slide) -> usize {
    let mut count = 0;
    let len = slide.elements.as_deref().map_or(0, <[SlideElement]>::len);
    for i in 0..len {
        let id = {
            let Some(el) = element_at(slide, i) else {
                continue;
            };
            let tx_box = matches!(el, SlideElement::Text(t) if matches!(*t.tx_box, Some(true)));
            if !is_text_or_shape(el) || !tx_box || !has_text(el) {
                continue;
            }
            let xml = patched_element_xml(el);
            let Some(body) = js_regex!(BODY_PR).exec(&xml) else {
                continue;
            };
            if js_regex!(r"<a:(?:noAutofit|normAutofit|spAutoFit)\b").test(body.as_str()) {
                continue;
            }
            el.id().to_owned()
        };
        let patch = TextBodyPropsPatch {
            autofit: Some(Autofit::Resize),
            ..TextBodyPropsPatch::default()
        };
        if set_element_text_body_props(slide, &id, &patch) {
            count += 1;
        }
    }
    count
}

/// `vert` of `TextBodyPropsPatch`: 'horz' clears the attribute.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum VertPatch {
    #[serde(rename = "horz")]
    Horz,
    #[serde(rename = "eaVert")]
    EaVert,
    #[serde(rename = "vert")]
    Vert,
    #[serde(rename = "vert270")]
    Vert270,
    #[serde(rename = "wordArtVert")]
    WordArtVert,
}

impl VertPatch {
    fn attr(self) -> &'static str {
        match self {
            Self::Horz => "horz",
            Self::EaVert => "eaVert",
            Self::Vert => "vert",
            Self::Vert270 => "vert270",
            Self::WordArtVert => "wordArtVert",
        }
    }
}

/// `Partial<{ l, t, r, b }>` of `TextBodyPropsPatch.insets`.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct InsetsPatch {
    pub l: Option<f64>,
    pub t: Option<f64>,
    pub r: Option<f64>,
    pub b: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBodyPropsPatch {
    pub vert: Option<VertPatch>,
    pub autofit: Option<Autofit>,
    pub insets: Option<InsetsPatch>,
    pub wrap: Option<bool>,
}

/// `openTag.replace(/\s+name="[^"]*"/, '')`, then `name="value"` first when given.
fn set_attr(open_tag: &mut String, name: &str, value: Option<&str>) {
    // `name` is one of the attributes this file sets: a literal pattern each
    macro_rules! attr_re {
        ($name:literal) => {
            js_regex!(concat!(r"\s+", $name, r#"="[^"]*""#))
        };
    }
    let re = match name {
        "vert" => Some(attr_re!("vert")),
        "wrap" => Some(attr_re!("wrap")),
        "lIns" => Some(attr_re!("lIns")),
        "tIns" => Some(attr_re!("tIns")),
        "rIns" => Some(attr_re!("rIns")),
        "bIns" => Some(attr_re!("bIns")),
        _ => None,
    };
    if let Some(re) = re {
        *open_tag = replace_first_with(re, open_tag, |_| String::new());
    }
    if let Some(value) = value
        && let Some(rest) = open_tag.strip_prefix("<a:bodyPr")
    {
        *open_tag = format!("<a:bodyPr {name}=\"{value}\"{rest}");
    }
}

pub fn set_element_text_body_props(
    slide: &mut Slide,
    element_id: &str,
    patch: &TextBodyPropsPatch,
) -> bool {
    let Some(at) = position(slide, element_id, |_| true) else {
        return false;
    };
    let Some(el) = element_at(slide, at) else {
        return false;
    };
    if !is_text_or_shape(el) || !has_text(el) {
        return false;
    }
    let xml = patched_element_xml(el);
    let (whole_start, whole_end, body_xml) = {
        let Some(whole) = js_regex!(BODY_PR).exec(&xml) else {
            return false;
        };
        (whole.start(), whole.end(), whole.as_str().to_owned())
    };
    let self_closing = !body_xml.contains("</a:bodyPr>");
    let gt = body_xml.find('>').map_or(0, |i| i + 1);
    let mut open_tag = if self_closing {
        format!(
            "{}>",
            slice(&body_xml, 0, body_xml.len().saturating_sub(2)).trim_end_matches(is_js_space)
        )
    } else {
        slice(&body_xml, 0, gt).to_owned()
    };
    let mut inner = if self_closing {
        String::new()
    } else {
        let last = body_xml.rfind("</a:bodyPr>").unwrap_or(0);
        slice(&body_xml, gt, last).to_owned()
    };

    if let Some(vert) = patch.vert {
        set_attr(
            &mut open_tag,
            "vert",
            (vert != VertPatch::Horz).then(|| vert.attr()),
        );
    }
    if let Some(wrap) = patch.wrap {
        set_attr(
            &mut open_tag,
            "wrap",
            Some(if wrap { "square" } else { "none" }),
        );
    }
    if let Some(ins) = &patch.insets {
        for (name, v) in [
            ("lIns", ins.l),
            ("tIns", ins.t),
            ("rIns", ins.r),
            ("bIns", ins.b),
        ] {
            if let Some(v) = v {
                set_attr(&mut open_tag, name, Some(&rnd0s(v)));
            }
        }
    }
    if let Some(autofit) = patch.autofit {
        inner = replace_first_with(
            js_regex!(
                r"<a:(?:noAutofit|normAutofit|spAutoFit)\b[^>]*?\/>|<a:(?:noAutofit|normAutofit|spAutoFit)\b[^>]*>[\s\S]*?<\/a:(?:noAutofit|normAutofit|spAutoFit)>"
            ),
            &inner,
            |_| String::new(),
        );
        let child = match autofit {
            Autofit::None => "<a:noAutofit/>",
            Autofit::Shrink => "<a:normAutofit/>",
            Autofit::Resize => "<a:spAutoFit/>",
        };
        let at = js_regex!(r"<a:prstTxWarp\b(?:[^>]*?\/>|[\s\S]*?<\/a:prstTxWarp>)")
            .exec(&inner)
            .map_or(0, |w| w.end());
        inner = format!(
            "{}{child}{}",
            slice(&inner, 0, at),
            inner.get(at..).unwrap_or_default()
        );
    }

    let rebuilt = if inner.is_empty() {
        format!(
            "{}/>",
            open_tag
                .get(..open_tag.len().saturating_sub(1))
                .unwrap_or_default()
                .trim_end_matches(is_js_space)
        )
    } else {
        format!("{open_tag}{inner}</a:bodyPr>")
    };
    let xml = format!(
        "{}{rebuilt}{}",
        slice(&xml, 0, whole_start),
        xml.get(whole_end..).unwrap_or_default()
    );
    clear_dirty(el);
    set_original_xml(el, &xml);
    if let SlideElement::Text(t) = el
        && let Some(text) = t.text.as_mut()
    {
        if let Some(vert) = patch.vert {
            match vert {
                VertPatch::Horz => text.vert.delete(),
                VertPatch::EaVert => text.vert.set(TextVert::EaVert),
                VertPatch::Vert => text.vert.set(TextVert::Vert),
                VertPatch::Vert270 => text.vert.set(TextVert::Vert270),
                VertPatch::WordArtVert => text.vert.set(TextVert::WordArtVert),
            }
        }
        if let Some(wrap) = patch.wrap {
            text.wrap.set(wrap);
        }
        if let Some(ins) = &patch.insets {
            let existing = (*text.insets).clone();
            let side = |cur: Option<&Slot<JsNum>>, default: f64, p: Option<f64>| {
                if let Some(v) = p {
                    return Some(JsNum(rnd0(v)));
                }
                match cur {
                    Some(s) if s.has_key() => **s,
                    _ => Some(JsNum(default)),
                }
            };
            let mut base = TextInsets::default();
            base.l
                .assign(side(existing.as_ref().map(|e| &e.l), 91440.0, ins.l));
            base.t
                .assign(side(existing.as_ref().map(|e| &e.t), 45720.0, ins.t));
            base.r
                .assign(side(existing.as_ref().map(|e| &e.r), 91440.0, ins.r));
            base.b
                .assign(side(existing.as_ref().map(|e| &e.b), 45720.0, ins.b));
            text.insets.set(base);
        }
        if let Some(autofit) = patch.autofit {
            text.autofit.set(autofit);
            if autofit != Autofit::Shrink {
                text.font_scale.delete();
                text.ln_spc_reduction.delete();
            }
        }
    }
    slide.structure_dirty.set(true);
    true
}

// ── Effects ────────────────────────────────────────────────────────────

fn nullable<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowPatch {
    pub color: String,
    pub blur_rad: f64,
    pub dist: f64,
    pub dir_deg: f64,
    pub inner: Option<bool>,
    pub sx: Option<f64>,
    pub sy: Option<f64>,
    pub kx_deg: Option<f64>,
    pub ky_deg: Option<f64>,
    pub algn: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GlowPatch {
    pub color: String,
    pub radius: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectionPatch {
    pub blur_rad: f64,
    pub start_a: f64,
    pub end_pos: f64,
    pub dist: f64,
}

/// `EffectsPatch`: `None` leaves an effect untouched, `Some(None)` (JSON null) clears it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectsPatch {
    #[serde(default, deserialize_with = "nullable")]
    pub shadow: Option<Option<ShadowPatch>>,
    #[serde(default, deserialize_with = "nullable")]
    pub glow: Option<Option<GlowPatch>>,
    #[serde(default, deserialize_with = "nullable")]
    pub reflection: Option<Option<ReflectionPatch>>,
    #[serde(default, deserialize_with = "nullable")]
    pub soft_edge: Option<Option<f64>>,
}

fn effect_color_xml(hex: &str) -> String {
    let m = js_regex!(r"^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$").exec(hex);
    let val = m
        .as_ref()
        .and_then(|m| m.get(1))
        .unwrap_or("000000")
        .to_ascii_uppercase();
    let alpha = match m.as_ref().and_then(|m| m.get(2)) {
        Some(a) => math_round(f64::from(u8::from_str_radix(a, 16).unwrap_or(0)) / 255.0 * 100000.0),
        None => 100000.0,
    };
    if alpha < 100000.0 {
        format!(
            "<a:srgbClr val=\"{val}\"><a:alpha val=\"{}\"/></a:srgbClr>",
            number_to_string(alpha)
        )
    } else {
        format!("<a:srgbClr val=\"{val}\"/>")
    }
}

const EFFECT_ORDER: [&str; 8] = [
    "blur",
    "fillOverlay",
    "glow",
    "innerShdw",
    "outerShdw",
    "prstShdw",
    "reflection",
    "softEdge",
];

/// A `Map<string, string>` in insertion order.
fn map_set(map: &mut Vec<(String, String)>, key: &str, value: String) {
    match map.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = value,
        None => map.push((key.to_owned(), value)),
    }
}

fn map_delete(map: &mut Vec<(String, String)>, key: &str) {
    map.retain(|(k, _)| k != key);
}

fn mod360(deg: f64) -> f64 {
    ((deg % 360.0) + 360.0) % 360.0
}

macro_rules! mirror_effects {
    ($e:ident, $patch:ident) => {{
        if let Some(shadow) = &$patch.shadow {
            match shadow {
                None => $e.shadow.delete(),
                Some(s) => {
                    let inner = s.inner == Some(true);
                    let kept = |v: Option<f64>| v.filter(|v| number_truthy(*v) && !inner);
                    $e.shadow.set(ShadowEffect {
                        color: s.color.clone(),
                        blur_rad: JsNum(rnd0(s.blur_rad)),
                        dist: JsNum(rnd0(s.dist)),
                        dir_deg: JsNum(mod360(s.dir_deg)),
                        inner: inner.then_some(true),
                        sx: s.sx.filter(|v| *v != 1.0 && !inner).map(JsNum),
                        sy: s.sy.filter(|v| *v != 1.0 && !inner).map(JsNum),
                        kx_deg: kept(s.kx_deg).map(JsNum),
                        ky_deg: kept(s.ky_deg).map(JsNum),
                        algn: s.algn.clone().filter(|a| !a.is_empty() && !inner),
                    });
                }
            }
        }
        if let Some(glow) = &$patch.glow {
            match glow {
                None => $e.glow.delete(),
                Some(g) => $e.glow.set(GlowEffect {
                    color: g.color.clone(),
                    radius: JsNum(rnd0(g.radius)),
                }),
            }
        }
        if let Some(reflection) = &$patch.reflection {
            match reflection {
                None => $e.reflection.delete(),
                Some(r) => $e.reflection.set(ReflectionEffect {
                    blur_rad: JsNum(rnd0(r.blur_rad)),
                    start_a: JsNum(math_max(0.0, math_min(1.0, r.start_a))),
                    end_pos: JsNum(math_max(0.0, math_min(1.0, r.end_pos))),
                    dist: JsNum(rnd0(r.dist)),
                }),
            }
        }
        if let Some(soft) = &$patch.soft_edge {
            match soft {
                None => $e.soft_edge.delete(),
                Some(v) => $e.soft_edge.set(JsNum(rnd0(*v))),
            }
        }
    }};
}

pub fn set_element_effects(
    slide: &mut Slide,
    element_id: &str,
    patch: &EffectsPatch,
) -> Result<bool, String> {
    let Some(at) = position(slide, element_id, |_| true) else {
        return Ok(false);
    };
    let Some(el) = element_at(slide, at) else {
        return Ok(false);
    };
    if !is_text_or_shape(el) && !is_picture(el) {
        return Ok(false);
    }
    let xml = patched_element_xml(el);
    let (sp_start, sp_end, mut sp_pr) = {
        let Some(m) = js_regex!(r"<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>").exec(&xml) else {
            return Ok(false);
        };
        (m.start(), m.end(), m.as_str().to_owned())
    };

    let mut children: Vec<(String, String)> = Vec::new();
    let inner_start = sp_pr.find('>').map_or(0, |i| i + 1);
    let inner_end = sp_pr.rfind("</p:spPr>").unwrap_or(0);
    let direct = top_level_children(&sp_pr, inner_start, inner_end)?;
    let lst = direct.iter().find(|c| c.name == "a:effectLst");
    let lst_inner = lst.and_then(|l| {
        js_regex!(r"^<a:effectLst\b[^>]*>([\s\S]*)<\/a:effectLst>$")
            .exec(slice(&sp_pr, l.start, l.end))
            .and_then(|m| m.get(1).map(str::to_owned))
    });
    if let Some(lst_inner) = lst_inner.filter(|s| !s.is_empty()) {
        for m in js_regex!(r"<a:(\w+)\b(?:[^>]*?\/>|[^>]*>[\s\S]*?<\/a:\1>)").find_iter(&lst_inner)
        {
            map_set(
                &mut children,
                m.get(1).unwrap_or_default(),
                m.as_str().to_owned(),
            );
        }
    }

    if let Some(shadow) = &patch.shadow {
        map_delete(&mut children, "outerShdw");
        map_delete(&mut children, "innerShdw");
        if let Some(s) = shadow {
            let base = [
                if number_truthy(s.blur_rad) {
                    format!(" blurRad=\"{}\"", rnd0s(s.blur_rad))
                } else {
                    String::new()
                },
                if number_truthy(s.dist) {
                    format!(" dist=\"{}\"", rnd0s(s.dist))
                } else {
                    String::new()
                },
                format!(" dir=\"{}\"", rnd(mod360(s.dir_deg) * 60000.0)),
            ]
            .concat();
            if s.inner == Some(true) {
                map_set(
                    &mut children,
                    "innerShdw",
                    format!(
                        "<a:innerShdw{base}>{}</a:innerShdw>",
                        effect_color_xml(&s.color)
                    ),
                );
            } else {
                let persp = [
                    s.sx.filter(|v| *v != 1.0)
                        .map_or(String::new(), |v| format!(" sx=\"{}\"", rnd(v * 100000.0))),
                    s.sy.filter(|v| *v != 1.0)
                        .map_or(String::new(), |v| format!(" sy=\"{}\"", rnd(v * 100000.0))),
                    s.kx_deg
                        .filter(|v| number_truthy(*v))
                        .map_or(String::new(), |v| format!(" kx=\"{}\"", rnd(v * 60000.0))),
                    s.ky_deg
                        .filter(|v| number_truthy(*v))
                        .map_or(String::new(), |v| format!(" ky=\"{}\"", rnd(v * 60000.0))),
                    s.algn
                        .as_deref()
                        .filter(|a| !a.is_empty())
                        .map_or(String::new(), |a| format!(" algn=\"{a}\"")),
                ]
                .concat();
                map_set(
                    &mut children,
                    "outerShdw",
                    format!(
                        "<a:outerShdw{base}{persp} rotWithShape=\"0\">{}</a:outerShdw>",
                        effect_color_xml(&s.color)
                    ),
                );
            }
        }
    }
    if let Some(glow) = &patch.glow {
        match glow {
            None => map_delete(&mut children, "glow"),
            Some(g) => map_set(
                &mut children,
                "glow",
                format!(
                    "<a:glow rad=\"{}\">{}</a:glow>",
                    rnd0s(g.radius),
                    effect_color_xml(&g.color)
                ),
            ),
        }
    }
    if let Some(reflection) = &patch.reflection {
        match reflection {
            None => map_delete(&mut children, "reflection"),
            Some(r) => {
                let clamp = |v: f64| {
                    number_to_string(math_max(0.0, math_min(100000.0, math_round(v * 100000.0))))
                };
                let attrs = [
                    if number_truthy(r.blur_rad) {
                        format!(" blurRad=\"{}\"", rnd0s(r.blur_rad))
                    } else {
                        String::new()
                    },
                    format!(" stA=\"{}\"", clamp(r.start_a)),
                    " endA=\"300\"".to_owned(),
                    format!(" endPos=\"{}\"", clamp(r.end_pos)),
                    if number_truthy(r.dist) {
                        format!(" dist=\"{}\"", rnd0s(r.dist))
                    } else {
                        String::new()
                    },
                    " dir=\"5400000\" sy=\"-100000\" algn=\"bl\" rotWithShape=\"0\"".to_owned(),
                ]
                .concat();
                map_set(
                    &mut children,
                    "reflection",
                    format!("<a:reflection{attrs}/>"),
                );
            }
        }
    }
    if let Some(soft) = &patch.soft_edge {
        match soft {
            None => map_delete(&mut children, "softEdge"),
            Some(v) => map_set(
                &mut children,
                "softEdge",
                format!("<a:softEdge rad=\"{}\"/>", rnd0s(*v)),
            ),
        }
    }

    // stable: the order of the Map breaks ties, as Array.prototype.sort does
    children.sort_by_key(|(name, _)| {
        EFFECT_ORDER
            .iter()
            .position(|n| *n == name)
            .map_or(EFFECT_ORDER.len() + 1, |i| i + 1)
    });
    let inner: String = children.iter().map(|(_, frag)| frag.as_str()).collect();
    let rebuilt = if inner.is_empty() {
        String::new()
    } else {
        format!("<a:effectLst>{inner}</a:effectLst>")
    };
    if let Some(l) = lst {
        sp_pr = format!(
            "{}{rebuilt}{}",
            slice(&sp_pr, 0, l.start),
            sp_pr.get(l.end..).unwrap_or_default()
        );
    } else if !rebuilt.is_empty() {
        let anchor = direct
            .iter()
            .find(|c| c.name == "a:scene3d" || c.name == "a:sp3d" || c.name == "a:extLst");
        let at = anchor.map_or(inner_end, |a| a.start);
        sp_pr = format!(
            "{}{rebuilt}{}",
            slice(&sp_pr, 0, at),
            sp_pr.get(at..).unwrap_or_default()
        );
    }
    let xml = format!(
        "{}{sp_pr}{}",
        slice(&xml, 0, sp_start),
        xml.get(sp_end..).unwrap_or_default()
    );
    clear_dirty(el);
    set_original_xml(el, &xml);

    match el {
        SlideElement::Text(e) => mirror_effects!(e, patch),
        SlideElement::Picture(e) => mirror_effects!(e, patch),
        _ => {}
    }
    slide.structure_dirty.set(true);
    Ok(true)
}

// ── Fill ───────────────────────────────────────────────────────────────

/// `string | GradientFillPatch`
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ElementFill {
    Color(String),
    Gradient(GradientFillPatch),
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FillOpts {
    pub group_id: Option<String>,
}

/// Where a fill edit lands: a top-level element, or a child of a top-level group.
enum Target {
    Top(usize),
    Child {
        group: usize,
        child: usize,
        nv_id: String,
    },
}

/// `findGroupChild`, then the checks of the fill functions.
fn resolve_target(slide: &Slide, element_id: &str, group_id: Option<&str>) -> Option<Target> {
    let elements = slide.elements.as_deref().unwrap_or(&[]);
    match group_id.filter(|g| !g.is_empty()) {
        Some(group_id) => {
            let group = elements
                .iter()
                .position(|e| e.id() == group_id && is_group(e))?;
            let SlideElement::Group(grp) = elements.get(group)? else {
                return None;
            };
            let children = grp.children.as_deref().unwrap_or(&[]);
            let child = children.iter().position(|c| c.id() == element_id)?;
            let c = children.get(child)?;
            if !is_text_or_shape(c) {
                return None;
            }
            let nv_id =
                crate::with_element!(c, e => (*e.nv_id).clone()).filter(|s| !s.is_empty())?;
            Some(Target::Child {
                group,
                child,
                nv_id,
            })
        }
        None => {
            let at = elements.iter().position(|e| e.id() == element_id)?;
            is_text_or_shape(elements.get(at)?).then_some(Target::Top(at))
        }
    }
}

/// Patch the target's XML and set its model fill; false when the group child slice is gone.
fn apply_fill(
    slide: &mut Slide,
    target: &Target,
    fill_patch: &FillPatch,
    model: Fill,
    clear: bool,
) -> Result<bool, String> {
    match target {
        Target::Child {
            group,
            child,
            nv_id,
        } => {
            let Some(SlideElement::Group(grp)) = element_at(slide, *group) else {
                return Ok(false);
            };
            if !patch_group_child_xml(grp, Some(nv_id.as_str()), |xml| {
                patch_element_fill(xml, fill_patch)
            })? {
                return Ok(false);
            }
            if let Some(SlideElement::Text(t)) = grp
                .children
                .as_mut()
                .and_then(|children| children.get_mut(*child))
            {
                t.fill.set(model);
            }
        }
        Target::Top(at) => {
            let Some(el) = element_at(slide, *at) else {
                return Ok(false);
            };
            let xml = patched_element_xml(el);
            let patched = patch_anchor_xml(el, &xml, |x| patch_element_fill(x, fill_patch), true)?;
            if clear {
                // setElementFill sets the model before it clears the flags
                set_original_xml(el, &patched);
                if let SlideElement::Text(t) = el {
                    t.fill.set(model);
                }
                clear_dirty(el);
            } else {
                clear_dirty(el);
                set_original_xml(el, &patched);
                if let SlideElement::Text(t) = el {
                    t.fill.set(model);
                }
            }
        }
    }
    Ok(true)
}

fn slide_mut(opened: &mut OpenedPptx, index: usize) -> Result<&mut Slide, String> {
    opened
        .deck
        .slides
        .get_mut(index)
        .ok_or_else(|| "TypeError: the slide is undefined".to_owned())
}

pub fn set_element_fill(
    opened: &mut OpenedPptx,
    slide_index: usize,
    element_id: &str,
    fill: &ElementFill,
    opts: &FillOpts,
) -> Result<bool, String> {
    let previous_xml;
    {
        let slide = slide_mut(opened, slide_index)?;
        let Some(target) = resolve_target(slide, element_id, opts.group_id.as_deref()) else {
            return Ok(false);
        };
        let (model, fill_patch) = match fill {
            ElementFill::Color(color) => (
                if color == "none" {
                    Fill::None
                } else {
                    Fill::Solid {
                        color: color.clone(),
                    }
                },
                FillPatch::Color(color.clone()),
            ),
            ElementFill::Gradient(g) => {
                let path = g.path.or_else(|| {
                    g.radial
                        .filter(|r| *r)
                        .map(|_| crate::types::GradientPath::Circle)
                });
                (
                    Fill::Gradient(GradientFill {
                        stops: g.stops.clone(),
                        angle: g.angle,
                        scaled: None,
                        path,
                        fill_to: if path.is_some() { g.fill_to } else { None },
                        tile_rect: None,
                    }),
                    FillPatch::Gradient(g.clone()),
                )
            }
        };
        previous_xml = patch_slide_xml(slide);
        if !apply_fill(slide, &target, &fill_patch, model, true)? {
            return Ok(false);
        }
        slide.structure_dirty.set(true);
    }
    let current = patch_slide_xml(slide_mut(opened, slide_index)?);
    cleanup_superseded_slide_resources(opened, slide_index, &previous_xml, &current)?;
    Ok(true)
}

/// `{ bytes, ext } | { mediaPath }`
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ImageFillSource {
    Bytes {
        bytes: Vec<u8>,
        ext: String,
    },
    MediaPath {
        #[serde(rename = "mediaPath")]
        media_path: String,
    },
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFillOpts {
    pub tile: Option<bool>,
    pub group_id: Option<String>,
}

pub fn set_element_image_fill(
    opened: &mut OpenedPptx,
    slide_index: usize,
    element_id: &str,
    source: &ImageFillSource,
    opts: &ImageFillOpts,
) -> Result<Option<String>, String> {
    let target;
    let previous_xml;
    {
        let slide = slide_mut(opened, slide_index)?;
        let Some(t) = resolve_target(slide, element_id, opts.group_id.as_deref()) else {
            return Ok(None);
        };
        target = t;
        previous_xml = patch_slide_xml(slide);
    }
    let (rid, media_path) = match source {
        ImageFillSource::Bytes { bytes, ext } => {
            match add_image_media_and_rel(opened, slide_index, bytes, ext)? {
                Some(added) => (added.rid, added.media_path),
                None => return Ok(None),
            }
        }
        ImageFillSource::MediaPath { media_path } => {
            if !opened.archive.entries().has(media_path) {
                return Ok(None);
            }
            let OpenedPptx { deck, archive, .. } = &mut *opened;
            let Some(slide) = deck.slides.get(slide_index) else {
                return Ok(None);
            };
            (
                image_rel_for(archive, slide, media_path)?,
                media_path.clone(),
            )
        }
    };
    let tile = opts.tile == Some(true);
    let raw_fill_xml = format!(
        "<a:blipFill rotWithShape=\"1\"><a:blip r:embed=\"{rid}\"/>{}</a:blipFill>",
        if tile {
            "<a:tile tx=\"0\" ty=\"0\" sx=\"100000\" sy=\"100000\" flip=\"none\" algn=\"tl\"/>"
        } else {
            "<a:stretch><a:fillRect/></a:stretch>"
        }
    );
    let model = Fill::Image(ImageFill {
        media_ref: media_path.clone(),
        mode: Some(if tile {
            ImageMode::Tile
        } else {
            ImageMode::Stretch
        }),
        alpha: None,
        fill_rect: None,
        duotone: None,
        clr_change: None,
        lum: None,
        bi_level: None,
        tile: tile.then(|| ImageTile {
            tx: JsNum(0.0),
            ty: JsNum(0.0),
            sx: JsNum(1.0),
            sy: JsNum(1.0),
            algn: "tl".to_owned(),
        }),
    });
    {
        let slide = slide_mut(opened, slide_index)?;
        if !apply_fill(slide, &target, &FillPatch::Raw(raw_fill_xml), model, false)? {
            return Ok(None);
        }
        slide.structure_dirty.set(true);
    }
    let current = patch_slide_xml(slide_mut(opened, slide_index)?);
    cleanup_superseded_slide_resources(opened, slide_index, &previous_xml, &current)?;
    Ok(Some(media_path))
}

// ── Pictures ───────────────────────────────────────────────────────────

pub fn set_element_redaction(
    slide: &mut Slide,
    source_id: &str,
    label: Option<&str>,
) -> Result<bool, String> {
    let Some(at) = position(slide, source_id, is_picture) else {
        return Ok(false);
    };
    let Some(el) = element_at(slide, at) else {
        return Ok(false);
    };
    let clean = trim(label.unwrap_or_default());
    let next = if clean.is_empty() {
        strip_redact_ext(&patched_element_xml(el)).map_err(|limit| limit.to_string())?
    } else {
        sync_redact_ext(&patched_element_xml(el), "p:spPr", Some(clean))
            .map_err(|error| error.to_string())?
    };
    if next == patched_element_xml(el) {
        return Ok(false);
    }
    if let SlideElement::Picture(pic) = el {
        if clean.is_empty() {
            pic.redact.delete();
        } else {
            pic.redact.set(clean.to_owned());
        }
    }
    clear_dirty(el);
    clear_src_rect_flag(el);
    set_original_xml(el, &next);
    slide.structure_dirty.set(true);
    Ok(true)
}

/// `el.dirtySrcRect = false`, set between the other flags as the TypeScript does.
fn clear_src_rect_flag(el: &mut SlideElement) {
    crate::with_element!(el, e => e.dirty_src_rect.set(false))
}

pub fn set_picture_opacity(slide: &mut Slide, source_id: &str, opacity: f64) -> bool {
    let Some(at) = position(slide, source_id, is_picture) else {
        return false;
    };
    let Some(el) = element_at(slide, at) else {
        return false;
    };
    let mut xml = patched_element_xml(el);
    xml = replace_first_with(
        js_regex!(r"<a:alphaModFix\b[^>]*\/>|<a:alphaModFix\b[^>]*>[\s\S]*?<\/a:alphaModFix>"),
        &xml,
        |_| String::new(),
    );
    let v = math_max(0.0, math_min(1.0, opacity));
    let mut set_opacity = false;
    if v < 0.999 {
        let amt = format!("<a:alphaModFix amt=\"{}\"/>", rnd(v * 100000.0));
        if js_regex!(r"<a:blip\b[^>]*\/>").test(&xml) {
            xml = replace_first_with(js_regex!(r"<a:blip\b([^>]*)\/>"), &xml, |m| {
                format!("<a:blip{}>{amt}</a:blip>", m.get(1).unwrap_or_default())
            });
        } else if js_regex!(r"<a:blip\b[^>]*>").test(&xml) {
            xml = replace_first_with(js_regex!(r"(<a:blip\b[^>]*>)"), &xml, |m| {
                format!("{}{amt}", m.get(1).unwrap_or_default())
            });
        } else {
            return false;
        }
        set_opacity = true;
    }
    if let SlideElement::Picture(pic) = el {
        if set_opacity {
            pic.opacity.set(JsNum(v));
        } else {
            pic.opacity.delete();
        }
    }
    clear_dirty(el);
    clear_src_rect_flag(el);
    set_original_xml(el, &xml);
    slide.structure_dirty.set(true);
    true
}

pub fn replace_picture_bytes(
    opened: &mut OpenedPptx,
    slide_index: usize,
    source_id: &str,
    bytes: &[u8],
    ext: &str,
    keep_src_rect: bool,
) -> Result<bool, String> {
    let at;
    let mut xml;
    let blip_start;
    let blip_end;
    let blip_tag;
    let has_model3d;
    let previous_xml;
    {
        let slide = slide_mut(opened, slide_index)?;
        let Some(i) = position(slide, source_id, is_picture) else {
            return Ok(false);
        };
        at = i;
        let Some(el) = element_at(slide, at) else {
            return Ok(false);
        };
        xml = patched_element_xml(el);
        has_model3d = matches!(el, SlideElement::Picture(p) if p.model3d.is_some());
        let Some(blip) = js_regex!(r"<a:blip\b[^>]*\/?>").exec(&xml) else {
            return Ok(false);
        };
        blip_start = blip.start();
        blip_end = blip.end();
        blip_tag = blip.as_str().to_owned();
        previous_xml = patch_slide_xml(slide);
    }
    let Some(added) = add_image_media_and_rel(opened, slide_index, bytes, ext)? else {
        return Ok(false);
    };
    let rid = &added.rid;
    let mut tag = blip_tag;
    let previous_rid = js_regex!(r#"r:embed="([^"]*)""#)
        .exec(&tag)
        .and_then(|m| m.get(1).map(str::to_owned));
    if js_regex!(r#"r:embed=""#).test(&tag) {
        tag = replace_first_with(js_regex!(r#"r:embed="[^"]*""#), &tag, |_| {
            format!("r:embed=\"{rid}\"")
        });
        tag = replace_first_with(js_regex!(r#"\s+r:link="[^"]*""#), &tag, |_| String::new());
    } else if js_regex!(r#"r:link=""#).test(&tag) {
        tag = replace_first_with(js_regex!(r#"r:link="[^"]*""#), &tag, |_| {
            format!("r:embed=\"{rid}\"")
        });
    } else {
        tag = replace_first_with(js_regex!(r"<a:blip\b"), &tag, |_| {
            format!("<a:blip r:embed=\"{rid}\"")
        });
    }
    xml = format!(
        "{}{tag}{}",
        slice(&xml, 0, blip_start),
        xml.get(blip_end..).unwrap_or_default()
    );
    if has_model3d && let Some(previous) = previous_rid.filter(|p| !p.is_empty()) {
        // the id comes from the document: escaped, not pasted
        let re = TryJsRegex::new(
            &format!(
                r#"(<am3d:blip\b[^>]*\br:embed="){}""#,
                regex_escape(&previous)
            ),
            "",
        )
        .map_err(|error| error.to_string())?;
        xml = try_replace_first_with(&re, &xml, |m| {
            format!("{}{rid}\"", m.get(1).unwrap_or_default())
        })
        .map_err(|limit| limit.to_string())?;
    }
    xml = replace_first_with(
        js_regex!(r"<a:ext\b[^>]*>\s*<\w+:svgBlip\b[\s\S]*?<\/a:ext>"),
        &xml,
        |_| String::new(),
    );
    xml = replace_first_with(js_regex!(r"<a:extLst>\s*<\/a:extLst>"), &xml, |_| {
        String::new()
    });
    let slide = slide_mut(opened, slide_index)?;
    let Some(el) = element_at(slide, at) else {
        return Ok(false);
    };
    if !keep_src_rect {
        xml = replace_first_with(
            js_regex!(r"<a:srcRect\b[^>]*\/>|<a:srcRect\b[^>]*>[\s\S]*?<\/a:srcRect>"),
            &xml,
            |_| String::new(),
        );
        if let SlideElement::Picture(pic) = el {
            pic.src_rect.delete();
        }
    }
    if let SlideElement::Picture(pic) = el {
        pic.media_ref.set(added.media_path.clone());
        pic.data_url.delete();
    }
    clear_dirty(el);
    clear_src_rect_flag(el);
    set_original_xml(el, &xml);
    slide.structure_dirty.set(true);
    let current = patch_slide_xml(slide_mut(opened, slide_index)?);
    cleanup_superseded_slide_resources(opened, slide_index, &previous_xml, &current)?;
    Ok(true)
}
