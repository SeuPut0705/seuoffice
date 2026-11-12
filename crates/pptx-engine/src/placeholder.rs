//! Placeholder inheritance (packages/pptx-engine/src/placeholder.ts): the
//! geometry, bodyPr anchors and insets, fill, preset shape and text styles a
//! slide placeholder takes from its layout and master, matched by (type, idx)
//! as PowerPoint does: exact first, then idx, then type, then the title and
//! body families. Read-only: nothing here writes a part.

use jscompat::{
    JsMap, JsNum, Radix, Slot, js_object, math_min, number_truthy, parse_int, truthy,
    value_to_string, value_truthy,
};
use ooxml_xml::{ObjectOptions, parse_object};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::color::resolve_color_node;
use crate::theme::{EaScript, Theme, ea_script_of_lang, resolve_font_ref};
use crate::types::{EaLang, EmuRect, TextAlign, Transform};
use crate::xml_utils::{as_xml_node, decode_numeric_char_refs, percent_fraction, xml_array};

/// `MAX_AUTO_NUM_START`: the spec (and PowerPoint UI) ceiling for
/// `<a:buAutoNum startAt>`.
pub const MAX_AUTO_NUM_START: f64 = 32767.0;

const PH_ARRAY_NAMES: [&str; 3] = ["p:sp", "p:graphicFrame", "p:pic"];

/// `phParser.parse(xml)`: the default options with `isArray` for the three
/// shape kinds of a shape tree.
fn ph_parse(xml: &str) -> Result<Value, String> {
    parse_object(
        xml,
        &ObjectOptions {
            trim_values: true,
            parse_tag_value: true,
            array_names: &PH_ARRAY_NAMES,
        },
    )
    .map_err(|error| error.to_string())
}

/// `v` unless it is `null`: the left side of `v ?? fallback`, and `v != null`.
fn defined(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

/// `v === text`
fn is_str(v: Option<&Value>, text: &str) -> bool {
    matches!(v, Some(Value::String(s)) if s == text)
}

/// `typeof v === 'object'` for a value that is truthy.
fn is_object(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_) | Value::Array(_)))
}

/// `String(v ?? '')`
fn string_or_empty(v: Option<&Value>) -> String {
    defined(v).map_or_else(String::new, |v| value_to_string(Some(v)))
}

/// `parseInt(text, 10) || 0`
fn int_or_zero(text: &str) -> f64 {
    let v = parse_int(text, Radix::Ten);
    if number_truthy(v) { v } else { 0.0 }
}

js_object! {
    deserialize;
    /// `Partial<Record<StyleSourceField, string>>`: which chain layer supplied
    /// each field. Its fields are the `StyleSourceField` union.
    #[derive(Debug, Clone, PartialEq)]
    pub struct StyleSource {
        pub font_size: String,
        pub bold: String,
        pub italic: String,
        pub color: String,
        pub latin_font: String,
        pub ea_font: String,
        pub cs_font: String,
        pub align: String,
    }
}

/// `type` of a `LevelTextStyle` bullet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BulletType {
    None,
    Char,
    Number,
    Blip,
}

js_object! {
    deserialize;
    /// `bullet` of `LevelTextStyle`: its keys follow the kind of bullet.
    #[derive(Debug, Clone, PartialEq)]
    pub struct Bullet {
        pub r#type: BulletType,
        pub char: String,
        pub media_ref: String,
        pub blip_embed_id: String,
        pub font: String,
        pub color: String,
        pub size_pct: JsNum,
        pub size_pt: JsNum,
        pub num_type: String,
        pub start_at: JsNum,
    }
}

/// `ShadowEffect` of types.ts with the fields `parseDefRPrStyle` writes; the
/// model port replaces it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowEffect {
    pub color: String,
    pub blur_rad: JsNum,
    pub dist: JsNum,
    pub dir_deg: JsNum,
}

js_object! {
    deserialize;
    /// `LevelTextStyle`: the default run and paragraph style of one indent
    /// level. Its keys come in the order the code that built it set them.
    #[derive(Debug, Clone, PartialEq)]
    pub struct LevelTextStyle {
        pub src: StyleSource,
        pub latin_font_ref: String,
        pub font_size: JsNum,
        pub bold: bool,
        pub italic: bool,
        pub cap: String,
        pub color: String,
        pub shadow: ShadowEffect,
        pub latin_font: String,
        pub ea_font: String,
        pub ea_font_ref: String,
        pub cs_font: String,
        pub ea_script: EaScript,
        pub ea_lang: EaLang,
        pub align: TextAlign,
        pub bullet: Bullet,
        pub mar_l: JsNum,
        pub indent: JsNum,
        pub line_height: JsNum,
        pub line_exact: JsNum,
        pub space_before: JsNum,
        pub space_after: JsNum,
        pub space_before_pct: JsNum,
        pub space_after_pct: JsNum,
        pub hanging_punct: bool,
        pub latin_ln_brk: bool,
        pub ea_ln_brk: bool,
    }
}

/// `TextStyleLevels`: the styles of the 9 levels (index = level, 0-based).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextStyleLevels {
    pub levels: Vec<Option<LevelTextStyle>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
}

/// `MasterTextStyles`: the title, body and other families of `<p:txStyles>`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct MasterTextStyles {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<TextStyleLevels>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<TextStyleLevels>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other: Option<TextStyleLevels>,
}

/// `PlaceholderGeom['anchor']`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaceholderAnchor {
    Top,
    Middle,
    Bottom,
}

js_object! {
    /// `PlaceholderGeom['insets']`: explicit bodyPr insets (EMU). A merge of
    /// two puts the keys of the second it lacked after its own.
    #[derive(Debug, Clone, PartialEq)]
    pub struct PlaceholderInsets {
        pub l: JsNum,
        pub t: JsNum,
        pub r: JsNum,
        pub b: JsNum,
    }
}

/// `PlaceholderGeom['presetGeom']`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetGeom {
    pub prst: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub av_lst_raw: Option<Value>,
}

/// `PlaceholderGeom`: one placeholder of a layout or master.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceholderGeom {
    /// ph type, `body` when missing
    pub r#type: String,
    /// ph idx, empty when missing
    pub idx: String,
    pub transform: Option<Transform>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_style: Option<TextStyleLevels>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<PlaceholderAnchor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_ctr: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insets: Option<PlaceholderInsets>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill_sp_pr: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_geom: Option<PresetGeom>,
}

/// `PlaceholderMap`: the placeholder table of one layer (layout or master).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlaceholderMap {
    pub entries: Vec<PlaceholderGeom>,
}

/// `LstStyleSource`: where a list style lives. Only the slide part's own
/// rIds may be written back into slide XML.
#[derive(Debug, Clone, Copy, Default)]
pub struct LstStyleSource<'a> {
    pub media_rels: Option<&'a JsMap<String>>,
    /// Layout/master part: picture bullets resolve their image but keep no rId
    pub foreign_part: bool,
}

const TITLE_TYPES: [&str; 2] = ["title", "ctrTitle"];
const BODY_TYPES: [&str; 4] = ["body", "subTitle", "obj", ""];
/// Placeholders a slide never renders text into. They can still carry a
/// lstStyle, so the idx-only step must skip them: a master's `dt idx="2"`
/// must not hand its date style to a body placeholder that shares idx="2".
const FUNCTION_TYPES: [&str; 12] = [
    "dt", "ftr", "sldNum", "sldImg", "hdr", "clipArt", "dgm", "media", "oleObj", "chart", "tbl",
    "pic",
];

fn is_title(t: &str) -> bool {
    TITLE_TYPES.contains(&t)
}

fn is_body(t: &str) -> bool {
    BODY_TYPES.contains(&t)
}

fn is_function(t: &str) -> bool {
    FUNCTION_TYPES.contains(&t)
}

/// `ANCHOR_MAP[key]` for its own keys.
fn anchor_of(key: &str) -> Option<PlaceholderAnchor> {
    // ledger inherited-key-placeholder-233: the TypeScript table also answers
    // for `constructor`, `toString`, `__proto__`... (a function or
    // Object.prototype); the table here answers for its own keys only.
    match key {
        "t" => Some(PlaceholderAnchor::Top),
        "ctr" => Some(PlaceholderAnchor::Middle),
        "b" => Some(PlaceholderAnchor::Bottom),
        _ => None,
    }
}

const FILL_TAGS: [&str; 5] = [
    "a:solidFill",
    "a:gradFill",
    "a:blipFill",
    "a:pattFill",
    "a:noFill",
];

fn parse_xfrm_node(xfrm_raw: Option<&Value>) -> Option<Transform> {
    if !value_truthy(xfrm_raw) {
        return None;
    }
    let xfrm = as_xml_node(xfrm_raw);
    let off_raw = xfrm.get("a:off");
    let ext_raw = xfrm.get("a:ext");
    if !value_truthy(off_raw) && !value_truthy(ext_raw) {
        return None;
    }
    let off = as_xml_node(off_raw);
    let ext = as_xml_node(ext_raw);
    let read = |raw: Option<&Value>, node: &Value, key: &str| {
        if value_truthy(raw) {
            int_or_zero(&value_to_string(node.get(key)))
        } else {
            0.0
        }
    };
    Some(Transform {
        offset: EmuRect {
            x: JsNum(read(off_raw, off, "@_x")),
            y: JsNum(read(off_raw, off, "@_y")),
            cx: JsNum(read(ext_raw, ext, "@_cx")),
            cy: JsNum(read(ext_raw, ext, "@_cy")),
        },
        rot: JsNum(if value_truthy(xfrm.get("@_rot")) {
            int_or_zero(&value_to_string(xfrm.get("@_rot")))
        } else {
            0.0
        }),
        flip_h: is_str(xfrm.get("@_flipH"), "1") || is_str(xfrm.get("@_flipH"), "true"),
        flip_v: is_str(xfrm.get("@_flipV"), "1") || is_str(xfrm.get("@_flipV"), "true"),
    })
}

/// `parsePlaceholderMap`: the placeholder table and lstStyle defaults of a
/// layout's or master's XML. Collects the shapes that carry `<p:ph>` and at
/// least one inheritable property; a part the parser refuses has none.
pub fn parse_placeholder_map(
    layout_or_master_xml: &str,
    theme: Option<&Theme>,
    media_rels: Option<&JsMap<String>>,
) -> PlaceholderMap {
    let src = LstStyleSource {
        media_rels,
        foreign_part: true,
    };
    let mut entries = Vec::new();
    let Ok(doc) = ph_parse(layout_or_master_xml) else {
        return PlaceholderMap { entries };
    };
    let doc = as_xml_node(Some(&doc));
    let root = as_xml_node(defined(doc.get("p:sldLayout")).or_else(|| doc.get("p:sldMaster")));
    let sp_tree_raw = as_xml_node(root.get("p:cSld")).get("p:spTree");
    if !value_truthy(sp_tree_raw) {
        return PlaceholderMap { entries };
    }
    let sp_tree = as_xml_node(sp_tree_raw);
    let shapes = xml_array(sp_tree.get("p:sp"))
        .map(|node| (node, "p:nvSpPr", false))
        .chain(
            xml_array(sp_tree.get("p:graphicFrame")).map(|node| (node, "p:nvGraphicFramePr", true)),
        )
        .chain(xml_array(sp_tree.get("p:pic")).map(|node| (node, "p:nvPicPr", false)));
    for (sp, nv_key, frame) in shapes {
        let ph_raw = as_xml_node(as_xml_node(sp.get(nv_key)).get("p:nvPr")).get("p:ph");
        if !value_truthy(ph_raw) {
            continue;
        }
        let ph = as_xml_node(ph_raw);
        let r#type = defined(ph.get("@_type"))
            .map_or_else(|| "body".to_owned(), |v| value_to_string(Some(v)));
        let idx = defined(ph.get("@_idx")).map_or_else(String::new, |v| value_to_string(Some(v)));
        let sp_pr = as_xml_node(sp.get("p:spPr"));
        let transform = if frame {
            parse_xfrm_node(sp.get("p:xfrm"))
        } else {
            parse_xfrm_node(sp_pr.get("a:xfrm"))
        };
        let text_style = parse_lst_style_levels(
            as_xml_node(sp.get("p:txBody")).get("a:lstStyle"),
            theme,
            Some(&src),
        );
        let body_pr_node = as_xml_node(as_xml_node(sp.get("p:txBody")).get("a:bodyPr"));
        let anchor = anchor_of(&string_or_empty(body_pr_node.get("@_anchor")));
        let anchor_ctr = defined(body_pr_node.get("@_anchorCtr"))
            .map(|raw| value_to_string(Some(raw)) == "1" || is_str(Some(raw), "true"));
        let mut insets = PlaceholderInsets::default();
        for (key, slot) in [
            ("@_lIns", &mut insets.l),
            ("@_tIns", &mut insets.t),
            ("@_rIns", &mut insets.r),
            ("@_bIns", &mut insets.b),
        ] {
            let n = defined(body_pr_node.get(key)).map_or(f64::NAN, |v| {
                parse_int(&value_to_string(Some(v)), Radix::Ten)
            });
            if n.is_finite() {
                slot.set(JsNum(n));
            }
        }
        let insets = (!insets.has_no_key()).then_some(insets);
        let has_fill = FILL_TAGS.iter().any(|tag| {
            sp_pr
                .as_object()
                .is_some_and(|node| node.contains_key(*tag))
        });
        let prst_geom_node = as_xml_node(sp_pr.get("a:prstGeom"));
        let prst = defined(prst_geom_node.get("@_prst")).map(|v| value_to_string(Some(v)));
        let preset_geom = prst
            .filter(|prst| !prst.is_empty() && prst != "rect")
            .map(|prst| PresetGeom {
                prst,
                av_lst_raw: prst_geom_node.get("a:avLst").cloned(),
            });
        if transform.is_none()
            && text_style.is_none()
            && anchor.is_none()
            && anchor_ctr.is_none()
            && insets.is_none()
            && !has_fill
            && preset_geom.is_none()
        {
            continue;
        }
        entries.push(PlaceholderGeom {
            r#type,
            idx,
            transform,
            text_style,
            anchor,
            anchor_ctr,
            insets,
            fill_sp_pr: has_fill.then(|| sp_pr.clone()),
            preset_geom,
        });
    }
    PlaceholderMap { entries }
}

/// `ALIGN_MAP[key]` for its own keys.
fn align_of(key: &str) -> Option<TextAlign> {
    // ledger inherited-key-placeholder-317: the TypeScript table also answers
    // for `constructor`, `toString`, `__proto__`... (a function or
    // Object.prototype); the table here answers for its own keys only.
    match key {
        "l" => Some(TextAlign::Left),
        "ctr" => Some(TextAlign::Center),
        "r" => Some(TextAlign::Right),
        "just" => Some(TextAlign::Justify),
        _ => None,
    }
}

/// `<a:spcPct val="150000"/>` or `val="150%"` as 150 (%).
fn spc_pct_val(node: Option<&Value>) -> Option<f64> {
    let ratio = percent_fraction(as_xml_node(as_xml_node(node).get("a:spcPct")).get("@_val"))?;
    Some(ratio * 100.0)
}

/// `eaScript ?? 'none'`; `han` is never produced by `eaScriptOfLang`.
pub(crate) fn ea_lang_of(script: Option<EaScript>) -> EaLang {
    match script {
        Some(EaScript::Ja) => EaLang::Ja,
        Some(EaScript::Ko) => EaLang::Ko,
        Some(EaScript::Sc) => EaLang::Sc,
        Some(EaScript::Tc) => EaLang::Tc,
        Some(EaScript::Han) | None => EaLang::None,
    }
}

/// `<a:spcPts val="2400"/>` as 24 (pt).
fn spc_pts_val(node: Option<&Value>) -> Option<f64> {
    let v = defined(as_xml_node(as_xml_node(node).get("a:spcPts")).get("@_val"))?;
    Some(parse_int(&value_to_string(Some(v)), Radix::Ten) / 100.0)
}

/// The `typeface` attribute of e.g. `<a:latin typeface="..."/>` as a string.
fn typeface_attr(node: Option<&Value>) -> Option<String> {
    defined(as_xml_node(node).get("@_typeface")).map(|v| value_to_string(Some(v)))
}

/// `<a:lvlNpPr>` (its defRPr included) as a `LevelTextStyle`.
fn parse_lvl_ppr(
    p_pr_raw: Option<&Value>,
    theme: Option<&Theme>,
    src: Option<&LstStyleSource<'_>>,
) -> Option<LevelTextStyle> {
    if !value_truthy(p_pr_raw) || !is_object(p_pr_raw) {
        return None;
    }
    let p_pr = as_xml_node(p_pr_raw);
    let mut out = LevelTextStyle::default();
    let algn = string_or_empty(p_pr.get("@_algn"));
    if !algn.is_empty()
        && let Some(align) = align_of(&algn)
    {
        out.align.set(align);
    }
    let line_height = spc_pct_val(p_pr.get("a:lnSpc"));
    let line_exact = spc_pts_val(p_pr.get("a:lnSpc"));
    out.line_height.set_some(line_height.map(JsNum));
    out.line_exact.set_some(line_exact.map(JsNum));
    let spc_bef = p_pr.get("a:spcBef");
    let spc_aft = p_pr.get("a:spcAft");
    out.space_before.set_some(spc_pts_val(spc_bef).map(JsNum));
    out.space_before_pct
        .set_some(spc_pct_val(spc_bef).map(JsNum));
    out.space_after.set_some(spc_pts_val(spc_aft).map(JsNum));
    out.space_after_pct
        .set_some(spc_pct_val(spc_aft).map(JsNum));
    // Bullet and indent defaults: a body placeholder's bullets mostly come from here
    let bu_char = defined(as_xml_node(p_pr.get("a:buChar")).get("@_char"));
    let mut bullet: Option<Bullet> = None;
    if p_pr.get("a:buNone").is_some() {
        let mut b = Bullet::default();
        b.r#type.set(BulletType::None);
        bullet = Some(b);
    } else if let Some(bu_char) = bu_char {
        let mut b = Bullet::default();
        b.r#type.set(BulletType::Char);
        b.char
            .set(decode_numeric_char_refs(&value_to_string(Some(bu_char))));
        bullet = Some(b);
    } else if value_truthy(p_pr.get("a:buAutoNum")) {
        let mut b = Bullet::default();
        b.r#type.set(BulletType::Number);
        let an = as_xml_node(p_pr.get("a:buAutoNum"));
        if let Some(num_type) = defined(an.get("@_type")) {
            b.num_type.set(value_to_string(Some(num_type)));
        }
        let start_at = parse_int(&value_to_string(an.get("@_startAt")), Radix::Ten);
        if start_at.is_finite() && start_at > 1.0 {
            b.start_at
                .set(JsNum(math_min(start_at, MAX_AUTO_NUM_START)));
        }
        bullet = Some(b);
    } else if p_pr.get("a:buBlip").is_some() {
        let mut b = Bullet::default();
        b.r#type.set(BulletType::Blip);
        let blip = as_xml_node(as_xml_node(p_pr.get("a:buBlip")).get("a:blip"));
        let embed = defined(blip.get("@_r:embed"));
        if let Some(embed) = embed {
            let embed = value_to_string(Some(embed));
            if !src.is_some_and(|src| src.foreign_part) {
                b.blip_embed_id.set(embed.clone());
            }
            let media_ref = src
                .and_then(|src| src.media_rels)
                .and_then(|rels| rels.get(&embed));
            if let Some(media_ref) = truthy(media_ref.map(String::as_str)) {
                b.media_ref.set(media_ref.to_owned());
            }
        }
        bullet = Some(b);
    }
    if let Some(b) = bullet.as_mut()
        && *b.r#type != Some(BulletType::None)
    {
        if let Some(font) = truthy(typeface_attr(p_pr.get("a:buFont")).as_deref()) {
            b.font.set(font.to_owned());
        }
        let bu_color = resolve_color_node(p_pr.get("a:buClr"), theme, None);
        if let Some(color) = truthy(bu_color.as_deref()) {
            b.color.set(color.to_owned());
        }
        if let Some(bu_sz) = defined(as_xml_node(p_pr.get("a:buSzPct")).get("@_val")) {
            b.size_pct
                .set(JsNum(int_or_zero(&value_to_string(Some(bu_sz))) / 1000.0));
        }
        if let Some(bu_sz_pts) = defined(as_xml_node(p_pr.get("a:buSzPts")).get("@_val")) {
            b.size_pt.set(JsNum(
                int_or_zero(&value_to_string(Some(bu_sz_pts))) / 100.0,
            ));
        }
    }
    out.bullet.set_some(bullet);
    if let Some(mar_l) = defined(p_pr.get("@_marL")) {
        let v = parse_int(&value_to_string(Some(mar_l)), Radix::Ten);
        if !v.is_nan() {
            out.mar_l.set(JsNum(v));
        }
    }
    if let Some(indent) = defined(p_pr.get("@_indent")) {
        let v = parse_int(&value_to_string(Some(indent)), Radix::Ten);
        if !v.is_nan() {
            out.indent.set(JsNum(v));
        }
    }
    for (key, slot) in [
        ("@_hangingPunct", &mut out.hanging_punct),
        ("@_latinLnBrk", &mut out.latin_ln_brk),
        ("@_eaLnBrk", &mut out.ea_ln_brk),
    ] {
        let v = p_pr.get(key);
        if is_str(v, "1") || is_str(v, "true") {
            slot.set(true);
        } else if is_str(v, "0") || is_str(v, "false") {
            slot.set(false);
        }
    }
    if let Some(def_r_pr) = parse_def_r_pr_style(p_pr.get("a:defRPr"), theme, None) {
        out.assign(&def_r_pr);
    }
    (!out.has_no_key()).then_some(out)
}

/// `parseDefRPrStyle`: `<a:defRPr>` (the default run properties of a
/// lstStyle level or of a paragraph's own `<a:pPr>`) as the run-level subset
/// of `LevelTextStyle`, colours and theme fonts resolved; `None` when the
/// node is absent or gives nothing.
pub fn parse_def_r_pr_style(
    def_r_pr_raw: Option<&Value>,
    theme: Option<&Theme>,
    ph_clr: Option<&str>,
) -> Option<LevelTextStyle> {
    if !value_truthy(def_r_pr_raw) || !is_object(def_r_pr_raw) {
        return None;
    }
    let def_r_pr = as_xml_node(def_r_pr_raw);
    let mut out = LevelTextStyle::default();
    if value_truthy(def_r_pr.get("@_sz")) {
        out.font_size.set(JsNum(
            parse_int(&value_to_string(def_r_pr.get("@_sz")), Radix::Ten) / 100.0,
        ));
    }
    if let Some(b) = defined(def_r_pr.get("@_b")) {
        out.bold
            .set(is_str(Some(b), "1") || is_str(Some(b), "true"));
    }
    if let Some(i) = defined(def_r_pr.get("@_i")) {
        out.italic
            .set(is_str(Some(i), "1") || is_str(Some(i), "true"));
    }
    if let Some(cap) = defined(def_r_pr.get("@_cap")) {
        out.cap.set(value_to_string(Some(cap)));
    }
    let color = resolve_color_node(def_r_pr.get("a:solidFill"), theme, ph_clr);
    if let Some(color) = truthy(color.as_deref()) {
        out.color.set(color.to_owned());
    }
    let shdw = as_xml_node(as_xml_node(def_r_pr.get("a:effectLst")).get("a:outerShdw"));
    let shdw_color = resolve_color_node(Some(shdw), theme, ph_clr);
    if let Some(shdw_color) = truthy(shdw_color.as_deref()) {
        let num = |k: &str| {
            let v = parse_int(&string_or_empty(shdw.get(k)), Radix::Ten);
            if v.is_finite() { v } else { 0.0 }
        };
        out.shadow.set(ShadowEffect {
            color: shdw_color.to_owned(),
            blur_rad: JsNum(num("@_blurRad")),
            dist: JsNum(num("@_dist")),
            dir_deg: JsNum(num("@_dir") / 60000.0),
        });
    }
    let ea_script = ea_script_of_lang(def_r_pr.get("@_altLang"))
        .or_else(|| ea_script_of_lang(def_r_pr.get("@_lang")));
    out.ea_script.set_some(ea_script);
    if defined(def_r_pr.get("@_altLang")).is_some() || defined(def_r_pr.get("@_lang")).is_some() {
        out.ea_lang.set(ea_lang_of(ea_script));
    }
    let latin_attr = typeface_attr(def_r_pr.get("a:latin"));
    if let Some(latin) = truthy(resolve_font_ref(latin_attr.as_deref(), theme, ea_script)) {
        out.latin_font.set(latin.to_owned());
    }
    if let Some(latin_attr) = latin_attr.filter(|attr| attr.starts_with('+')) {
        out.latin_font_ref.set(latin_attr);
    }
    let ea_attr = typeface_attr(def_r_pr.get("a:ea"));
    if let Some(ea) = truthy(resolve_font_ref(ea_attr.as_deref(), theme, ea_script)) {
        out.ea_font.set(ea.to_owned());
    }
    if let Some(ea_attr) = ea_attr.filter(|attr| attr.starts_with('+')) {
        out.ea_font_ref.set(ea_attr);
    }
    let cs_attr = typeface_attr(def_r_pr.get("a:cs"));
    if let Some(cs) = truthy(resolve_font_ref(cs_attr.as_deref(), theme, ea_script)) {
        out.cs_font.set(cs.to_owned());
    }
    (!out.has_no_key()).then_some(out)
}

/// `parseLstStyleLevels`: `<a:lstStyle>` (or one txStyles family) as the
/// 9-level style table; `None` when no level gives anything.
pub fn parse_lst_style_levels(
    lst: Option<&Value>,
    theme: Option<&Theme>,
    src: Option<&LstStyleSource<'_>>,
) -> Option<TextStyleLevels> {
    if !value_truthy(lst) || !is_object(lst) {
        return None;
    }
    let l = as_xml_node(lst);
    let levels: Vec<Option<LevelTextStyle>> = (1..=9)
        .map(|i| parse_lvl_ppr(l.get(format!("a:lvl{i}pPr").as_str()), theme, src))
        .collect();
    levels
        .iter()
        .any(Option::is_some)
        .then_some(TextStyleLevels { levels, src: None })
}

/// `parseDefaultTextStyle`: presentation.xml `<p:defaultTextStyle>`, the
/// base defaults of text that is not in a placeholder.
pub fn parse_default_text_style(
    presentation_xml: &str,
    theme: Option<&Theme>,
) -> Option<TextStyleLevels> {
    let doc = ph_parse(presentation_xml).ok()?;
    let doc = as_xml_node(Some(&doc));
    parse_lst_style_levels(
        as_xml_node(doc.get("p:presentation")).get("p:defaultTextStyle"),
        theme,
        None,
    )
}

/// `parseMasterTextStyles`: master `<p:txStyles>` as the title, body and
/// other families.
pub fn parse_master_text_styles(
    master_xml: &str,
    theme: Option<&Theme>,
    media_rels: Option<&JsMap<String>>,
) -> MasterTextStyles {
    let src = LstStyleSource {
        media_rels,
        foreign_part: true,
    };
    let Ok(doc) = ph_parse(master_xml) else {
        return MasterTextStyles::default();
    };
    let doc = as_xml_node(Some(&doc));
    let tx_raw = as_xml_node(doc.get("p:sldMaster")).get("p:txStyles");
    if !value_truthy(tx_raw) {
        return MasterTextStyles::default();
    }
    let tx = as_xml_node(tx_raw);
    MasterTextStyles {
        title: parse_lst_style_levels(tx.get("p:titleStyle"), theme, Some(&src)),
        body: parse_lst_style_levels(tx.get("p:bodyStyle"), theme, Some(&src)),
        other: parse_lst_style_levels(tx.get("p:otherStyle"), theme, Some(&src)),
    }
}

/// The lstStyle of a layer's placeholder (type, idx). The idx-only step skips
/// FUNCTION_TYPES, which never render slide text and would otherwise donate
/// their style by index collision.
fn find_style_in_map<'a>(
    map: Option<&'a PlaceholderMap>,
    r#type: Option<&str>,
    idx: Option<&str>,
) -> Option<&'a TextStyleLevels> {
    let map = map.filter(|map| !map.entries.is_empty())?;
    let t = r#type.unwrap_or("body");
    let i = idx.unwrap_or("");
    let styled = || map.entries.iter().filter(|e| e.text_style.is_some());
    let mut hit = styled().find(|e| e.r#type == t && e.idx == i);
    if hit.is_none() && !i.is_empty() {
        hit = styled().find(|e| e.idx == i && !is_function(&e.r#type));
    }
    if hit.is_none() {
        hit = styled().find(|e| e.r#type == t);
    }
    if hit.is_none() && is_title(t) {
        hit = styled().find(|e| is_title(&e.r#type));
    }
    if hit.is_none() && is_body(t) {
        hit = styled().find(|e| is_body(&e.r#type));
    }
    hit.and_then(|e| e.text_style.as_ref())
}

/// The layer has the placeholder this one inherits from (same type and idx).
/// Its bodyPr decides even where it leaves an attribute unset: the chain
/// then goes on to the master, not to a same-type sibling.
fn has_exact_entry(map: &PlaceholderMap, t: &str, i: &str) -> bool {
    !i.is_empty() && map.entries.iter().any(|e| e.r#type == t && e.idx == i)
}

/// The bodyPr anchor of a layer's placeholder (type, idx). No idx-only step:
/// masters reuse idx values across types.
fn find_anchor_in_map(
    map: Option<&PlaceholderMap>,
    r#type: Option<&str>,
    idx: Option<&str>,
) -> Option<PlaceholderAnchor> {
    let map = map.filter(|map| !map.entries.is_empty())?;
    let t = r#type.unwrap_or("body");
    let i = idx.unwrap_or("");
    let anchored = || map.entries.iter().filter(|e| e.anchor.is_some());
    let mut hit = anchored().find(|e| e.r#type == t && e.idx == i);
    if hit.is_none() && has_exact_entry(map, t, i) {
        return None;
    }
    if hit.is_none() {
        hit = anchored().find(|e| e.r#type == t);
    }
    if hit.is_none() && is_title(t) {
        hit = anchored().find(|e| is_title(&e.r#type));
    }
    if hit.is_none() && is_body(t) {
        hit = anchored().find(|e| is_body(&e.r#type));
    }
    hit.and_then(|e| e.anchor)
}

/// The bodyPr insets of a layer's placeholder, matched as the anchor is.
fn find_insets_in_map<'a>(
    map: Option<&'a PlaceholderMap>,
    r#type: Option<&str>,
    idx: Option<&str>,
) -> Option<&'a PlaceholderInsets> {
    let map = map.filter(|map| !map.entries.is_empty())?;
    let t = r#type.unwrap_or("body");
    let i = idx.unwrap_or("");
    let carriers = || map.entries.iter().filter(|e| e.insets.is_some());
    let mut hit = carriers().find(|e| e.r#type == t && e.idx == i);
    if hit.is_none() && has_exact_entry(map, t, i) {
        return None;
    }
    if hit.is_none() {
        hit = carriers().find(|e| e.r#type == t);
    }
    if hit.is_none() && is_title(t) {
        hit = carriers().find(|e| is_title(&e.r#type));
    }
    if hit.is_none() && is_body(t) {
        hit = carriers().find(|e| is_body(&e.r#type));
    }
    hit.and_then(|e| e.insets.as_ref())
}

/// `resolvePlaceholderInsets`: the inherited bodyPr insets, merged attribute
/// by attribute (layout over master).
pub fn resolve_placeholder_insets(
    layout: Option<&PlaceholderMap>,
    master: Option<&PlaceholderMap>,
    r#type: Option<&str>,
    idx: Option<&str>,
) -> Option<PlaceholderInsets> {
    let from_layout = find_insets_in_map(layout, r#type, idx);
    let from_master = find_insets_in_map(master, r#type, idx);
    let (Some(from_layout), Some(from_master)) = (from_layout, from_master) else {
        return from_layout.or(from_master).cloned();
    };
    let mut merged = from_master.clone();
    merged.assign(from_layout);
    Some(merged)
}

/// `resolvePlaceholderAnchor`: the inherited vertical anchor, layout first.
pub fn resolve_placeholder_anchor(
    layout: Option<&PlaceholderMap>,
    master: Option<&PlaceholderMap>,
    r#type: Option<&str>,
    idx: Option<&str>,
) -> Option<PlaceholderAnchor> {
    find_anchor_in_map(layout, r#type, idx).or_else(|| find_anchor_in_map(master, r#type, idx))
}

/// The anchorCtr of a layer's placeholder, matched as the anchor is (an
/// explicit 0 in the layout wins over a master 1).
fn find_anchor_ctr_in_map(
    map: Option<&PlaceholderMap>,
    r#type: Option<&str>,
    idx: Option<&str>,
) -> Option<bool> {
    let map = map.filter(|map| !map.entries.is_empty())?;
    let t = r#type.unwrap_or("body");
    let i = idx.unwrap_or("");
    let marked = || map.entries.iter().filter(|e| e.anchor_ctr.is_some());
    let mut hit = marked().find(|e| e.r#type == t && e.idx == i);
    if hit.is_none() && has_exact_entry(map, t, i) {
        return None;
    }
    if hit.is_none() {
        hit = marked().find(|e| e.r#type == t);
    }
    if hit.is_none() && is_title(t) {
        hit = marked().find(|e| is_title(&e.r#type));
    }
    if hit.is_none() && is_body(t) {
        hit = marked().find(|e| is_body(&e.r#type));
    }
    hit.and_then(|e| e.anchor_ctr)
}

/// `resolvePlaceholderAnchorCtr`: the inherited anchorCtr, layout first.
pub fn resolve_placeholder_anchor_ctr(
    layout: Option<&PlaceholderMap>,
    master: Option<&PlaceholderMap>,
    r#type: Option<&str>,
    idx: Option<&str>,
) -> Option<bool> {
    find_anchor_ctr_in_map(layout, r#type, idx)
        .or_else(|| find_anchor_ctr_in_map(master, r#type, idx))
}

/// `placeholderStyleChain`: the text style chain of a placeholder, highest
/// priority first: layout placeholder lstStyle, master placeholder
/// lstStyle, the master txStyles family of its type.
pub fn placeholder_style_chain(
    layout: Option<&PlaceholderMap>,
    master: Option<&PlaceholderMap>,
    master_tx: Option<&MasterTextStyles>,
    r#type: Option<&str>,
    idx: Option<&str>,
) -> Vec<TextStyleLevels> {
    let mut chain = Vec::new();
    let with_src = |layer: &TextStyleLevels, src: &str| TextStyleLevels {
        levels: layer.levels.clone(),
        src: Some(src.to_owned()),
    };
    if let Some(from_layout) = find_style_in_map(layout, r#type, idx) {
        chain.push(with_src(from_layout, "layout placeholder"));
    }
    if let Some(from_master) = find_style_in_map(master, r#type, idx) {
        chain.push(with_src(from_master, "master placeholder"));
    }
    let t = r#type.unwrap_or("body");
    let (family, family_src) = if is_title(t) {
        (
            master_tx.and_then(|tx| tx.title.as_ref()),
            "master titleStyle",
        )
    } else if is_body(t) {
        (
            master_tx.and_then(|tx| tx.body.as_ref()),
            "master bodyStyle",
        )
    } else {
        (
            master_tx.and_then(|tx| tx.other.as_ref()),
            "master otherStyle",
        )
    };
    if let Some(family) = family {
        chain.push(with_src(family, family_src));
    }
    chain
}

/// `levels[level]`: an own element only at an integer index from 0 below the
/// length (`-0` reads index 0, as the key "0").
fn level_at(levels: &[Option<LevelTextStyle>], level: f64) -> Option<&LevelTextStyle> {
    if level >= 0.0 && level.fract() == 0.0 && level < levels.len() as f64 {
        levels.get(level as usize)?.as_ref()
    } else {
        None
    }
}

/// `if (out.k == null && lvl.k != null) out.k = lvl.k`; whether it took it.
fn inherit<T: Clone>(out: &mut Slot<T>, lvl: &Slot<T>) -> bool {
    if out.is_none()
        && let Some(value) = &**lvl
    {
        out.set(value.clone());
        return true;
    }
    false
}

/// `mergeTextStyleChain`: one level's default style merged field by field
/// along the chain, earlier layers first. A layer without the level gives
/// its lvl1 instead.
pub fn merge_text_style_chain(
    chain: &[Option<TextStyleLevels>],
    level: f64,
) -> Option<LevelTextStyle> {
    let mut out = LevelTextStyle::default();
    let mut src = StyleSource::default();
    let mut any = false;
    for layer in chain.iter().flatten() {
        let Some(lvl) = level_at(&layer.levels, level)
            .or_else(|| layer.levels.first().and_then(Option::as_ref))
        else {
            continue;
        };
        any = true;
        let from = layer.src.as_deref().unwrap_or("inherited");
        if inherit(&mut out.font_size, &lvl.font_size) {
            src.font_size.set(from.to_owned());
        }
        if inherit(&mut out.bold, &lvl.bold) {
            src.bold.set(from.to_owned());
        }
        if inherit(&mut out.italic, &lvl.italic) {
            src.italic.set(from.to_owned());
        }
        inherit(&mut out.cap, &lvl.cap);
        if inherit(&mut out.color, &lvl.color) {
            src.color.set(from.to_owned());
        }
        inherit(&mut out.shadow, &lvl.shadow);
        if inherit(&mut out.latin_font, &lvl.latin_font) {
            out.latin_font_ref.set_some((*lvl.latin_font_ref).clone());
            src.latin_font.set(from.to_owned());
        }
        if inherit(&mut out.ea_font, &lvl.ea_font) {
            out.ea_font_ref.set_some((*lvl.ea_font_ref).clone());
            src.ea_font.set(from.to_owned());
        }
        if inherit(&mut out.cs_font, &lvl.cs_font) {
            src.cs_font.set(from.to_owned());
        }
        inherit(&mut out.ea_script, &lvl.ea_script);
        inherit(&mut out.ea_lang, &lvl.ea_lang);
        if inherit(&mut out.align, &lvl.align) {
            src.align.set(from.to_owned());
        }
        inherit(&mut out.bullet, &lvl.bullet);
        inherit(&mut out.mar_l, &lvl.mar_l);
        inherit(&mut out.indent, &lvl.indent);
        inherit(&mut out.hanging_punct, &lvl.hanging_punct);
        inherit(&mut out.latin_ln_brk, &lvl.latin_ln_brk);
        inherit(&mut out.ea_ln_brk, &lvl.ea_ln_brk);
        // Line and paragraph spacing inherit as pairs: pct and pts are two
        // forms of the same lnSpc/spcBef/spcAft node
        if out.line_height.is_none()
            && out.line_exact.is_none()
            && (lvl.line_height.is_some() || lvl.line_exact.is_some())
        {
            out.line_height.set_some(*lvl.line_height);
            out.line_exact.set_some(*lvl.line_exact);
        }
        if out.space_before.is_none()
            && out.space_before_pct.is_none()
            && (lvl.space_before.is_some() || lvl.space_before_pct.is_some())
        {
            out.space_before.set_some(*lvl.space_before);
            out.space_before_pct.set_some(*lvl.space_before_pct);
        }
        if out.space_after.is_none()
            && out.space_after_pct.is_none()
            && (lvl.space_after.is_some() || lvl.space_after_pct.is_some())
        {
            out.space_after.set_some(*lvl.space_after);
            out.space_after_pct.set_some(*lvl.space_after_pct);
        }
    }
    if !src.has_no_key() {
        out.src.set(src);
    }
    any.then_some(out)
}

/// The geometry of a layer's placeholder (type, idx): only entries with a
/// transform take part.
fn find_in_map(
    map: Option<&PlaceholderMap>,
    r#type: Option<&str>,
    idx: Option<&str>,
) -> Option<Transform> {
    let map = map.filter(|map| !map.entries.is_empty())?;
    let t = r#type.unwrap_or("body");
    let i = idx.unwrap_or("");
    let geo = || map.entries.iter().filter(|e| e.transform.is_some());
    // 1. Exact (type, idx)
    if let Some(hit) = geo().find(|e| e.r#type == t && e.idx == i) {
        return hit.transform;
    }
    // 2. By idx, skipping function placeholders so style and geometry agree
    if !i.is_empty()
        && let Some(hit) = geo().find(|e| e.idx == i && !is_function(&e.r#type))
    {
        return hit.transform;
    }
    // 3. By type
    if let Some(hit) = geo().find(|e| e.r#type == t) {
        return hit.transform;
    }
    // 4. Family fallback
    if is_title(t)
        && let Some(hit) = geo().find(|e| is_title(&e.r#type))
    {
        return hit.transform;
    }
    if is_body(t)
        && let Some(hit) = geo().find(|e| is_body(&e.r#type))
    {
        return hit.transform;
    }
    None
}

/// The layer `resolvePlaceholderFillSpPr` found the fill in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaceholderLayer {
    Layout,
    Master,
}

/// What `resolvePlaceholderFillSpPr` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceholderFill<'a> {
    pub sp_pr: &'a Value,
    pub layer: PlaceholderLayer,
}

/// `resolvePlaceholderFillSpPr`: the nearest layer (layout, then master)
/// whose matching placeholder spPr carries an explicit fill, `<a:noFill>`
/// included. The placeholder is matched first, then its fill is taken.
pub fn resolve_placeholder_fill_sp_pr<'a>(
    layout: Option<&'a PlaceholderMap>,
    master: Option<&'a PlaceholderMap>,
    r#type: Option<&str>,
    idx: Option<&str>,
) -> Option<PlaceholderFill<'a>> {
    let t = r#type.unwrap_or("body");
    let i = idx.unwrap_or("");
    for (map, layer) in [
        (layout, PlaceholderLayer::Layout),
        (master, PlaceholderLayer::Master),
    ] {
        let Some(map) = map else {
            continue;
        };
        let entries = &map.entries;
        let hit = entries
            .iter()
            .find(|e| e.r#type == t && e.idx == i)
            .or_else(|| {
                (!i.is_empty())
                    .then(|| entries.iter().find(|e| e.idx == i))
                    .flatten()
            })
            .or_else(|| entries.iter().find(|e| e.r#type == t))
            .or_else(|| {
                is_title(t)
                    .then(|| entries.iter().find(|e| is_title(&e.r#type)))
                    .flatten()
            })
            .or_else(|| {
                is_body(t)
                    .then(|| entries.iter().find(|e| is_body(&e.r#type)))
                    .flatten()
            });
        if let Some(sp_pr) = hit.and_then(|hit| hit.fill_sp_pr.as_ref()) {
            return Some(PlaceholderFill { sp_pr, layer });
        }
    }
    None
}

/// `resolvePlaceholderTransform`: the inherited geometry, layout first.
/// `None`: neither layer has inheritable geometry.
pub fn resolve_placeholder_transform(
    layout: Option<&PlaceholderMap>,
    master: Option<&PlaceholderMap>,
    r#type: Option<&str>,
    idx: Option<&str>,
) -> Option<Transform> {
    find_in_map(layout, r#type, idx).or_else(|| find_in_map(master, r#type, idx))
}

/// `resolvePlaceholderPresetGeom`: the inherited preset geometry, layout
/// first. The placeholder is matched first, so an unrelated sibling never
/// donates its shape, and a matched placeholder without one ends the search.
pub fn resolve_placeholder_preset_geom<'a>(
    layout: Option<&'a PlaceholderMap>,
    master: Option<&'a PlaceholderMap>,
    r#type: Option<&str>,
    idx: Option<&str>,
) -> Option<&'a PresetGeom> {
    let t = r#type.unwrap_or("body");
    let i = idx.unwrap_or("");
    for map in [layout, master] {
        let Some(map) = map else {
            continue;
        };
        let entries = &map.entries;
        let hit = entries
            .iter()
            .find(|e| e.r#type == t && e.idx == i)
            .or_else(|| {
                (!i.is_empty())
                    .then(|| entries.iter().find(|e| e.idx == i))
                    .flatten()
            })
            .or_else(|| entries.iter().find(|e| e.r#type == t))
            .or_else(|| {
                is_title(t)
                    .then(|| entries.iter().find(|e| is_title(&e.r#type)))
                    .flatten()
            })
            .or_else(|| {
                is_body(t)
                    .then(|| entries.iter().find(|e| is_body(&e.r#type)))
                    .flatten()
            });
        if let Some(preset_geom) = hit.and_then(|hit| hit.preset_geom.as_ref()) {
            return Some(preset_geom);
        }
        if hit.is_some() {
            return None;
        }
    }
    None
}
