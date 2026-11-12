//! The text section of parse.ts: `base64ToUtf8` (340-345) and the readers of
//! a text body, its paragraphs and its runs (3678-4327).

use std::borrow::Cow;

use jscompat::{
    JsNum, JsObject, Radix, atob, js_regex, math_max, math_min, number_truthy, parse_int,
    sort_by_number, text_decoder_decode, to_int32, trim, value_to_string, value_truthy,
};
use serde_json::Value;

use super::context::{DEFAULT_BODY_INSETS, Node, ParseContext};
use super::decor::int_or;
use super::fill::{
    blip_embed_id, color_node_xml, non_plain_color_node, parse_fill, resolve_color_node,
};
use super::shape::{parse_glow, parse_shadow};
use crate::named_action::named_action_of;
use crate::placeholder::{
    BulletType, LevelTextStyle, LstStyleSource, MAX_AUTO_NUM_START, PlaceholderInsets, StyleSource,
    TextStyleLevels, ea_lang_of, merge_text_style_chain, parse_def_r_pr_style,
    parse_lst_style_levels,
};
use crate::redaction_xml::read_redact_label;
use crate::theme::{EaScript, ea_script_of_lang, resolve_font_ref};
use crate::types::{
    Autofit, Extrusion3d, Fill, FontScriptHint, PPrExplicit, Paragraph, ParagraphBullet,
    ParagraphDefaultRunProps, RunGradient, RunStyleSource, ShadowEffect, TabStop, TextAlign,
    TextAnchor, TextBody, TextInsets, TextOutline, TextRun, TextVert, TxWarp,
};
use crate::xml_utils::percent_fraction;

/// `node?.[key]` where `node` is an element: a string or a list has no such
/// key (the keys read here are never indices or string methods).
fn get<'a>(node: Node<'a>, key: &str) -> Node<'a> {
    node.and_then(Value::as_object).and_then(|o| o.get(key))
}

/// `v` where `v != null`.
fn defined(v: Node<'_>) -> Node<'_> {
    v.filter(|v| !v.is_null())
}

/// `v === text`
fn is(v: Node<'_>, text: &str) -> bool {
    matches!(v, Some(Value::String(s)) if s == text)
}

/// `typeof v === 'object'` of a value that is there (a list is an object).
fn is_object(v: Node<'_>) -> bool {
    matches!(v, Some(Value::Object(_) | Value::Array(_)))
}

/// `Array.isArray(raw) ? raw : raw ? [raw] : []`
fn list(raw: Node<'_>) -> &[Value] {
    match raw {
        Some(Value::Array(items)) => items,
        Some(v) if value_truthy(Some(v)) => std::slice::from_ref(v),
        _ => &[],
    }
}

/// `parseInt(v, 10)`: `undefined` reads as NaN.
fn int(v: Node<'_>) -> f64 {
    match v {
        Some(Value::String(s)) => parse_int(s, Radix::Ten),
        _ => parse_int(&value_to_string(v), Radix::Ten),
    }
}

/// `x || 0` over a number
fn or0(x: f64) -> f64 {
    if number_truthy(x) { x } else { 0.0 }
}

/// `if (s)` over a string that may be `undefined`.
fn filled(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|s| !s.is_empty())
}

/// `base64ToUtf8`: `atob`, then the bytes as UTF-8 through `TextDecoder`.
/// `Err` where `atob` throws.
pub(crate) fn base64_to_utf8(b64: &str) -> Result<String, String> {
    let bytes = atob(b64).map_err(|error| error.to_string())?;
    Ok(text_decoder_decode(&bytes).into_owned())
}

/// `anchorMap[key]` for its own keys only.
fn anchor_of(key: &str) -> Option<TextAnchor> {
    match key {
        "t" => Some(TextAnchor::Top),
        "ctr" => Some(TextAnchor::Middle),
        "b" => Some(TextAnchor::Bottom),
        _ => None,
    }
}

/// `alignMap[key]` for its own keys only.
fn align_of(key: &str) -> Option<TextAlign> {
    match key {
        "l" => Some(TextAlign::Left),
        "ctr" => Some(TextAlign::Center),
        "r" => Some(TextAlign::Right),
        "just" => Some(TextAlign::Justify),
        _ => None,
    }
}

/// `parseTextBody`. `ph_chain` is the placeholder layout/master chain (the
/// TypeScript default `[]`); `inherited_insets` the bodyPr insets of the
/// placeholder chain, read only for the attributes this bodyPr lacks.
pub(crate) fn parse_text_body(
    tx_body: Node<'_>,
    ctx: &ParseContext<'_>,
    ph_chain: &[TextStyleLevels],
    inherited_insets: Option<&PlaceholderInsets>,
) -> Result<TextBody, String> {
    let body_pr_raw = get(tx_body, "a:bodyPr");
    // `{}` where bodyPr is not an object: `None` reads the same
    let body_pr = if value_truthy(body_pr_raw) && is_object(body_pr_raw) {
        body_pr_raw
    } else {
        None
    };
    let paras = list(get(tx_body, "a:p"));
    let own_style = parse_lst_style_levels(
        get(tx_body, "a:lstStyle"),
        ctx.theme,
        Some(&LstStyleSource {
            media_rels: ctx.media_rels,
            foreign_part: false,
        }),
    );
    let mut chain: Vec<Option<TextStyleLevels>> = Vec::with_capacity(ph_chain.len() + 1);
    chain.push(own_style.map(|own| TextStyleLevels {
        src: Some("shape lstStyle".to_owned()),
        ..own
    }));
    chain.extend(ph_chain.iter().cloned().map(Some));
    let paragraphs = paras
        .iter()
        .map(|p| parse_paragraph(Some(p), ctx, &chain))
        .collect::<Result<Vec<_>, _>>()?;

    let mut autofit = Autofit::None;
    if get(body_pr, "a:normAutofit").is_some() {
        autofit = Autofit::Shrink;
    } else if get(body_pr, "a:spAutoFit").is_some() {
        autofit = Autofit::Resize;
    }
    let naf = get(body_pr, "a:normAutofit");
    let naf_attr = |k: &str| -> Option<f64> {
        let v = if value_truthy(naf) && is_object(naf) {
            get(naf, k)
        } else {
            None
        };
        percent_fraction(v).filter(|&ratio| ratio > 0.0)
    };
    let font_scale = naf_attr("@_fontScale");
    let ln_spc_reduction = naf_attr("@_lnSpcReduction");
    let vert = match get(body_pr, "@_vert") {
        Some(Value::String(v)) => match v.as_str() {
            "eaVert" => Some(TextVert::EaVert),
            "vert" => Some(TextVert::Vert),
            "vert270" => Some(TextVert::Vert270),
            "wordArtVert" => Some(TextVert::WordArtVert),
            _ => None,
        },
        _ => None,
    };

    let mut extrusion3d = None;
    let body_sp3d = get(body_pr, "a:sp3d");
    let depth_emu = if value_truthy(body_sp3d) {
        int_or(get(body_sp3d, "@_extrusionH"), 0.0)
    } else {
        0.0
    };
    if depth_emu > 0.0 {
        let ext_clr = get(body_sp3d, "a:extrusionClr");
        let color = if value_truthy(ext_clr) && is_object(ext_clr) {
            resolve_color_node(ext_clr, ctx)
        } else {
            None
        }
        .unwrap_or_else(|| "#808080".to_owned());
        let rot = get(get(get(body_pr, "a:scene3d"), "a:camera"), "a:rot");
        extrusion3d = Some(Extrusion3d {
            color,
            depth_emu: JsNum(depth_emu),
            lat_deg: JsNum(int_or(get(rot, "@_lat"), 0.0) / 60000.0),
            lon_deg: JsNum(int_or(get(rot, "@_lon"), 0.0) / 60000.0),
        });
    }

    let mut tx_warp = None;
    let warp_node = get(body_pr, "a:prstTxWarp");
    if value_truthy(warp_node) && is_object(warp_node) && value_truthy(get(warp_node, "@_prst")) {
        let prst = value_to_string(get(warp_node, "@_prst"));
        if prst != "textNoShape" && prst != "textPlain" {
            let mut adj: JsObject<JsNum> = JsObject::new();
            let gds = get(get(warp_node, "a:avLst"), "a:gd");
            for gd in list(gds) {
                let fmla = defined(get(Some(gd), "@_fmla"))
                    .map_or_else(String::new, |v| value_to_string(Some(v)));
                let name = get(Some(gd), "@_name");
                if value_truthy(name)
                    && let Some(m) = js_regex!(r"^val (-?\d+)$").exec(&fmla)
                {
                    // `setOwn`: a guide named `__proto__` is an entry like any other
                    adj.set(
                        value_to_string(name),
                        JsNum(parse_int(m.get(1).unwrap_or_default(), Radix::Ten)),
                    );
                }
            }
            tx_warp = Some(TxWarp {
                prst,
                adj: (!adj.is_empty()).then_some(adj),
            });
        }
    }

    let mut body = TextBody::default();
    body.paragraphs.set(paragraphs);
    let anchor = get(body_pr, "@_anchor");
    body.anchor.assign(if value_truthy(anchor) {
        anchor_of(&value_to_string(anchor))
    } else {
        None
    });
    if let Some(anchor_ctr) = defined(get(body_pr, "@_anchorCtr")) {
        body.anchor_ctr
            .set(value_to_string(Some(anchor_ctr)) == "1" || is(Some(anchor_ctr), "true"));
    }
    let inherited = |side: fn(&PlaceholderInsets) -> Option<JsNum>, dflt: JsNum| {
        inherited_insets.and_then(side).unwrap_or(dflt).0
    };
    let mut insets = TextInsets::default();
    insets.l.set(JsNum(int_or(
        get(body_pr, "@_lIns"),
        inherited(|i| *i.l, DEFAULT_BODY_INSETS.l),
    )));
    insets.t.set(JsNum(int_or(
        get(body_pr, "@_tIns"),
        inherited(|i| *i.t, DEFAULT_BODY_INSETS.t),
    )));
    insets.r.set(JsNum(int_or(
        get(body_pr, "@_rIns"),
        inherited(|i| *i.r, DEFAULT_BODY_INSETS.r),
    )));
    insets.b.set(JsNum(int_or(
        get(body_pr, "@_bIns"),
        inherited(|i| *i.b, DEFAULT_BODY_INSETS.b),
    )));
    body.insets.set(insets);
    body.autofit.set(autofit);
    body.font_scale.set_some(font_scale.map(JsNum));
    body.ln_spc_reduction.set_some(ln_spc_reduction.map(JsNum));
    body.wrap.set(!is(get(body_pr, "@_wrap"), "none"));
    body.vert.set_some(vert);
    let num_col = int_or(get(body_pr, "@_numCol"), 1.0);
    if num_col > 1.0 {
        body.num_col.set(JsNum(num_col));
        body.spc_col
            .set(JsNum(int_or(get(body_pr, "@_spcCol"), 0.0)));
    }
    body.extrusion3d.set_some(extrusion3d);
    body.tx_warp.set_some(tx_warp);
    Ok(body)
}

/// `spcPct`: `<a:spcPct val="150000"/>` or `val="150%"` as 150 (%).
pub(crate) fn spc_pct(node: Node<'_>) -> Option<f64> {
    let ratio = percent_fraction(get(get(node, "a:spcPct"), "@_val"))?;
    Some(ratio * 100.0)
}

/// `hundredthsOr`: `sz`/`spc` are integer hundredths of a point; a malformed
/// value falls back rather than poisoning layout with NaN.
fn hundredths_or(v: Node<'_>, dflt: Option<f64>) -> Option<f64> {
    let Some(v) = defined(v) else {
        return dflt;
    };
    let n = parse_int(&value_to_string(Some(v)), Radix::Ten);
    if n.is_nan() { dflt } else { Some(n / 100.0) }
}

/// `spcPts`: `<a:spcPts val="2400"/>` as 24 (pt).
pub(crate) fn spc_pts(node: Node<'_>) -> Option<f64> {
    let v = defined(get(get(node, "a:spcPts"), "@_val"))?;
    Some(or0(int(Some(v))) / 100.0)
}

/// `parseParagraph`. `Err` where the `gxRaw` of a run is not base64.
pub(crate) fn parse_paragraph(
    p: Node<'_>,
    ctx: &ParseContext<'_>,
    chain: &[Option<TextStyleLevels>],
) -> Result<Paragraph, String> {
    // `p['a:pPr'] ?? {}`: a text or a list reads as `{}` does
    let p_pr = get(p, "a:pPr");
    let lvl = get(p_pr, "@_lvl");
    let parsed_level = value_truthy(lvl).then(|| int(lvl));
    let level = parsed_level
        .filter(|l| l.is_finite())
        .map(|l| math_max(0.0, math_min(8.0, l)));
    let dflt = merge_text_style_chain(chain, level.unwrap_or(0.0));
    let def_r_pr_node = get(p_pr, "a:defRPr");
    let para_style = parse_def_r_pr_style(def_r_pr_node, ctx.theme, ctx.ph_clr);
    let run_dflt: Option<Cow<'_, LevelTextStyle>> = match &para_style {
        Some(para_style) => {
            let mut run_dflt = dflt.clone().unwrap_or_default();
            run_dflt.assign(para_style);
            run_dflt
                .src
                .set(paragraph_sources(dflt.as_ref(), para_style));
            if filled(&para_style.ea_font) && !filled(&para_style.ea_font_ref) {
                run_dflt.ea_font_ref.delete();
            }
            if filled(&para_style.latin_font) && !filled(&para_style.latin_font_ref) {
                run_dflt.latin_font_ref.delete();
            }
            Some(Cow::Owned(run_dflt))
        }
        None => dflt.as_ref().map(Cow::Borrowed),
    };
    let def_r_pr = para_style
        .as_ref()
        .map(|para_style| parse_paragraph_def_r_pr(def_r_pr_node, para_style));
    let mut runs: Vec<TextRun> = Vec::new();
    for r in list(get(p, "a:r")) {
        let mut run = parse_run(Some(r), ctx, run_dflt.as_deref());
        // a:fld rewritten to a:r by parseShapeFragment
        let field = get(Some(r), "@_type");
        if value_truthy(field) {
            run.field.set(value_to_string(field));
        }
        let gx_raw = get(Some(r), "@_gxRaw");
        if value_truthy(gx_raw) {
            run.raw_xml.set(base64_to_utf8(&value_to_string(gx_raw))?);
        }
        runs.push(run);
    }
    for f in list(get(p, "a:fld")) {
        let mut run = parse_run(Some(f), ctx, run_dflt.as_deref());
        let field = get(Some(f), "@_type");
        if value_truthy(field) {
            run.field.set(value_to_string(field));
        }
        runs.push(run);
    }

    let end_pr = get(p, "a:endParaRPr");
    if value_truthy(end_pr)
        && is_object(end_pr)
        && runs
            .iter()
            .all(|r| !filled(&r.text) && !filled(&r.field) && !filled(&r.raw_xml))
    {
        // `{ 'a:rPr': endPr, 'a:t': '' }`: an `a:t` of '' reads as one that is absent
        let mut mark = run_of(end_pr, None, ctx, run_dflt.as_deref());
        mark.para_mark.set(true);
        runs.clear();
        runs.push(mark);
    }

    let ln_spc_node = get(p_pr, "a:lnSpc");
    let has_ln_spc = value_truthy(ln_spc_node);
    let line_height = if has_ln_spc {
        spc_pct(ln_spc_node)
    } else {
        dflt.as_ref().and_then(|d| *d.line_height).map(|n| n.0)
    };
    let line_exact = if has_ln_spc {
        spc_pts(ln_spc_node)
    } else {
        dflt.as_ref().and_then(|d| *d.line_exact).map(|n| n.0)
    };
    let bef_node = get(p_pr, "a:spcBef");
    let has_bef = value_truthy(bef_node);
    let space_before = if has_bef {
        spc_pts(bef_node)
    } else {
        dflt.as_ref().and_then(|d| *d.space_before).map(|n| n.0)
    };
    let space_before_pct = if has_bef {
        spc_pct(bef_node)
    } else {
        dflt.as_ref().and_then(|d| *d.space_before_pct).map(|n| n.0)
    };
    let aft_node = get(p_pr, "a:spcAft");
    let has_aft = value_truthy(aft_node);
    let space_after = if has_aft {
        spc_pts(aft_node)
    } else {
        dflt.as_ref().and_then(|d| *d.space_after).map(|n| n.0)
    };
    let space_after_pct = if has_aft {
        spc_pct(aft_node)
    } else {
        dflt.as_ref().and_then(|d| *d.space_after_pct).map(|n| n.0)
    };

    let mut bullet: Option<ParagraphBullet> = None;
    let bu_char = defined(get(get(p_pr, "a:buChar"), "@_char"));
    let bu_auto_num = get(p_pr, "a:buAutoNum");
    if get(p_pr, "a:buNone").is_some() {
        let mut b = ParagraphBullet::default();
        b.r#type.set(BulletType::None);
        bullet = Some(b);
    } else if let Some(ch) = bu_char {
        let mut b = ParagraphBullet::default();
        b.r#type.set(BulletType::Char);
        b.char.set(value_to_string(Some(ch)));
        bullet = Some(b);
    } else if value_truthy(bu_auto_num) {
        let mut b = ParagraphBullet::default();
        b.r#type.set(BulletType::Number);
        let num_type = get(bu_auto_num, "@_type");
        if value_truthy(num_type) {
            b.num_type.set(value_to_string(num_type));
        }
        let start_at = int(get(bu_auto_num, "@_startAt"));
        if start_at.is_finite() && start_at > 1.0 {
            b.start_at
                .set(JsNum(math_min(start_at, MAX_AUTO_NUM_START)));
        }
        bullet = Some(b);
    } else if get(p_pr, "a:buBlip").is_some() {
        let mut b = ParagraphBullet::default();
        b.r#type.set(BulletType::Blip);
        let embed = blip_embed_id(get(get(p_pr, "a:buBlip"), "a:blip"));
        if let Some(embed) = embed.filter(|e| !e.is_empty()) {
            b.blip_embed_id.set(embed.to_owned());
            let media_ref = ctx.media_rels.and_then(|rels| rels.get(embed));
            if let Some(media_ref) = media_ref.filter(|r| !r.is_empty()) {
                b.media_ref.set(media_ref.clone());
            }
        }
        bullet = Some(b);
    }
    if let Some(b) = bullet
        .as_mut()
        .filter(|b| *b.r#type != Some(BulletType::None))
    {
        let bu_clr = get(p_pr, "a:buClr");
        if value_truthy(bu_clr) {
            if let Some(c) = resolve_color_node(bu_clr, ctx).filter(|c| !c.is_empty()) {
                b.color.set(c);
            }
            if let Some(node) = non_plain_color_node(bu_clr).filter(|n| !n.is_empty()) {
                b.color_node_xml.set(node);
            }
        }
        let typeface = get(get(p_pr, "a:buFont"), "@_typeface");
        if value_truthy(typeface) {
            b.font.set(value_to_string(typeface));
        }
        let size_pct = get(get(p_pr, "a:buSzPct"), "@_val");
        if value_truthy(size_pct) {
            let v = int(size_pct);
            if v.is_finite() {
                b.size_pct.set(JsNum(v / 1000.0));
            }
        }
        let size_pt = get(get(p_pr, "a:buSzPts"), "@_val");
        if value_truthy(size_pt) {
            let v = int(size_pt);
            if v.is_finite() {
                b.size_pt.set(JsNum(v / 100.0));
            }
        }
    }

    let int_attr = |key: &str| defined(get(p_pr, key)).map(|v| int(Some(v)));
    let mar_l_raw = int_attr("@_marL");
    let mar_r_raw = int_attr("@_marR");
    let indent_raw = int_attr("@_indent");
    let def_tab_sz_raw = int_attr("@_defTabSz");
    let tab_nodes = get(get(p_pr, "a:tabLst"), "a:tab");
    let mut tab_stops: Vec<TabStop> = list(tab_nodes)
        .iter()
        .map(|t| {
            let algn = get(Some(t), "@_algn");
            TabStop {
                pos: JsNum(int(get(Some(t), "@_pos"))),
                algn: value_truthy(algn).then(|| value_to_string(algn)),
            }
        })
        .filter(|t| t.pos.0.is_finite())
        .collect();
    sort_by_number(&mut tab_stops, |a, b| a.pos.0 - b.pos.0);
    let has_bullet = bullet.is_some();
    let mut eff_bullet = bullet.or_else(|| {
        dflt.as_ref()
            .and_then(|d| d.bullet.as_ref())
            .map(ParagraphBullet::from)
    });
    if !has_bullet
        && let Some(eff) = eff_bullet.as_mut()
        && *eff.r#type != Some(BulletType::None)
    {
        let tx = |key: &str| get(p_pr, key).is_some();
        // `{ ...effBullet }` before the deletes: `eff` is already a copy
        if tx("a:buFontTx") {
            eff.font.delete();
        }
        if tx("a:buSzTx") {
            eff.size_pct.delete();
            eff.size_pt.delete();
        }
        if tx("a:buClrTx") {
            eff.color.delete();
        }
    }
    let has_mar_l = mar_l_raw.is_some_and(|v| !v.is_nan());
    let has_mar_r = mar_r_raw.is_some_and(|v| !v.is_nan());
    let has_indent = indent_raw.is_some_and(|v| !v.is_nan());
    let has_def_tab_sz = def_tab_sz_raw.is_some_and(|v| !v.is_nan());
    let mar_l = if has_mar_l {
        mar_l_raw
    } else {
        dflt.as_ref().and_then(|d| *d.mar_l).map(|n| n.0)
    };
    let indent = if has_indent {
        indent_raw
    } else {
        dflt.as_ref().and_then(|d| *d.indent).map(|n| n.0)
    };

    let rtl_attr = get(p_pr, "@_rtl");
    let rtl = if is(rtl_attr, "1") || is(rtl_attr, "true") {
        Some(true)
    } else if is(rtl_attr, "0") || is(rtl_attr, "false") {
        Some(false)
    } else {
        None
    };
    let brk_flag = |key: &str, inherited: Option<bool>| {
        let v = get(p_pr, key);
        if is(v, "1") || is(v, "true") {
            Some(true)
        } else if is(v, "0") || is(v, "false") {
            Some(false)
        } else {
            inherited
        }
    };
    let hanging_punct = brk_flag(
        "@_hangingPunct",
        dflt.as_ref().and_then(|d| *d.hanging_punct),
    );
    let latin_ln_brk = brk_flag("@_latinLnBrk", dflt.as_ref().and_then(|d| *d.latin_ln_brk));
    let ea_ln_brk = brk_flag("@_eaLnBrk", dflt.as_ref().and_then(|d| *d.ea_ln_brk));

    let algn = get(p_pr, "@_algn");
    let has_algn = value_truthy(algn);
    let mut explicit = PPrExplicit::default();
    if has_algn {
        explicit.align.set(true);
    }
    if has_ln_spc {
        explicit.ln_spc.set(true);
    }
    if has_bef {
        explicit.spc_bef.set(true);
    }
    if has_aft {
        explicit.spc_aft.set(true);
    }
    if has_bullet {
        explicit.bullet.set(true);
    }
    if has_mar_l {
        explicit.mar_l.set(true);
    }
    if has_mar_r {
        explicit.mar_r.set(true);
    }
    if has_indent {
        explicit.indent.set(true);
    }
    if !tab_stops.is_empty() {
        explicit.tab_lst.set(true);
    }
    if has_def_tab_sz {
        explicit.def_tab_sz.set(true);
    }
    if defined(get(p_pr, "@_hangingPunct")).is_some() {
        explicit.hanging_punct.set(true);
    }
    if defined(get(p_pr, "@_latinLnBrk")).is_some() {
        explicit.latin_ln_brk.set(true);
    }
    if defined(get(p_pr, "@_eaLnBrk")).is_some() {
        explicit.ea_ln_brk.set(true);
    }

    let dflt_align = dflt.as_ref().and_then(|d| *d.align);
    let mut out = Paragraph::default();
    out.runs.set(runs);
    out.align.assign(if has_algn {
        align_of(&value_to_string(algn))
    } else {
        dflt_align
    });
    if has_algn || dflt_align.is_some() {
        out.align_src.set(if has_algn {
            "paragraph".to_owned()
        } else {
            dflt.as_ref()
                .and_then(|d| d.src.as_ref())
                .and_then(|src| src.align.as_ref())
                .map_or_else(|| "inherited".to_owned(), String::clone)
        });
    }
    out.rtl.set_some(rtl);
    out.hanging_punct.set_some(hanging_punct);
    out.latin_ln_brk.set_some(latin_ln_brk);
    out.ea_ln_brk.set_some(ea_ln_brk);
    out.level.assign(level.map(JsNum));
    out.p_pr_explicit.set(explicit);
    out.line_height.set_some(line_height.map(JsNum));
    out.line_exact.set_some(line_exact.map(JsNum));
    out.space_before.set_some(space_before.map(JsNum));
    out.space_after.set_some(space_after.map(JsNum));
    out.space_before_pct.set_some(space_before_pct.map(JsNum));
    out.space_after_pct.set_some(space_after_pct.map(JsNum));
    out.bullet.set_some(eff_bullet);
    out.mar_l.set_some(mar_l.map(JsNum));
    if has_mar_r {
        out.mar_r.set_some(mar_r_raw.map(JsNum));
    }
    out.indent.set_some(indent.map(JsNum));
    if !tab_stops.is_empty() {
        out.tab_stops.set(tab_stops);
    }
    if has_def_tab_sz {
        out.def_tab_sz.set_some(def_tab_sz_raw.map(JsNum));
    }
    out.def_r_pr.set_some(def_r_pr);
    Ok(out)
}

/// `parseParagraphDefRPr`: a paragraph's `<a:pPr><a:defRPr>` for write-back,
/// the resolved display values and the raw typefaces.
pub(crate) fn parse_paragraph_def_r_pr(
    def_r_pr_node: Node<'_>,
    style: &LevelTextStyle,
) -> ParagraphDefaultRunProps {
    let typeface = |slot: &str| {
        defined(get(get(def_r_pr_node, slot), "@_typeface"))
            .filter(|v| !is(Some(v), ""))
            .map(|v| value_to_string(Some(v)))
            .filter(|v| !v.is_empty())
    };
    let latin_font = typeface("a:latin");
    let ea_font = typeface("a:ea");
    let cs_font = typeface("a:cs");
    let color_node =
        non_plain_color_node(get(def_r_pr_node, "a:solidFill")).filter(|n| !n.is_empty());
    ParagraphDefaultRunProps {
        font_size: *style.font_size,
        bold: *style.bold,
        italic: *style.italic,
        cap: style.cap.as_ref().cloned(),
        color: style.color.as_ref().cloned(),
        color_node_xml: color_node,
        latin_font,
        ea_font,
        cs_font,
    }
}

/// `paragraphSources`: the paragraph's own defRPr names itself the source of
/// the `SOURCE_FIELDS` it sets.
pub(crate) fn paragraph_sources(
    dflt: Option<&LevelTextStyle>,
    para_style: &LevelTextStyle,
) -> StyleSource {
    let mut src = dflt
        .and_then(|d| d.src.as_ref())
        .cloned()
        .unwrap_or_default();
    let fields = [
        (para_style.font_size.is_some(), &mut src.font_size),
        (para_style.bold.is_some(), &mut src.bold),
        (para_style.italic.is_some(), &mut src.italic),
        (para_style.color.is_some(), &mut src.color),
        (para_style.latin_font.is_some(), &mut src.latin_font),
        (para_style.ea_font.is_some(), &mut src.ea_font),
        (para_style.cs_font.is_some(), &mut src.cs_font),
        (para_style.align.is_some(), &mut src.align),
    ];
    for (set, field) in fields {
        if set {
            field.set("paragraph defRPr".to_owned());
        }
    }
    src
}

/// `themeFontSource`
pub(crate) fn theme_font_source(r#ref: Option<&str>) -> Option<&'static str> {
    let r#ref = r#ref?;
    if !r#ref.starts_with('+') {
        return None;
    }
    Some(if r#ref.starts_with("+mj") {
        "theme major"
    } else {
        "theme minor"
    })
}

/// `CHARSET_SCRIPT[n]` of parseRun: its keys are numbers, so a lookup by
/// `n & 0xff` can name nothing inherited.
fn charset_script(n: i32) -> Option<FontScriptHint> {
    match n {
        128 => Some(FontScriptHint::Ja),
        129 | 130 => Some(FontScriptHint::Ko),
        134 => Some(FontScriptHint::Sc),
        136 => Some(FontScriptHint::Tc),
        _ => None,
    }
}

/// The run's own East Asian language as a substitution hint (`eaScriptOfLang`
/// never gives `han`).
fn hint_of(script: EaScript) -> Option<FontScriptHint> {
    match script {
        EaScript::Ja => Some(FontScriptHint::Ja),
        EaScript::Ko => Some(FontScriptHint::Ko),
        EaScript::Sc => Some(FontScriptHint::Sc),
        EaScript::Tc => Some(FontScriptHint::Tc),
        EaScript::Han => None,
    }
}

/// `{ f, cset, decl }` of parseRun: a font bucket's family and its hints.
struct FontPair {
    f: String,
    cset: Option<FontScriptHint>,
    decl: Option<FontScriptHint>,
}

/// Which object `picked` is in parseRun (it compares them by identity).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Picked {
    Sym,
    Cs,
    Ea,
    Latin,
    ThemeMinor,
}

/// `parseRun`
pub(crate) fn parse_run(
    r: Node<'_>,
    ctx: &ParseContext<'_>,
    dflt: Option<&LevelTextStyle>,
) -> TextRun {
    // `r['a:rPr'] ?? {}`: `None` reads as `{}` does
    run_of(defined(get(r, "a:rPr")), get(r, "a:t"), ctx, dflt)
}

/// parseRun over the two things it reads of `r`: `rPr` and `a:t`.
fn run_of(
    r_pr: Node<'_>,
    raw_t: Node<'_>,
    ctx: &ParseContext<'_>,
    dflt: Option<&LevelTextStyle>,
) -> TextRun {
    let redact_label = read_redact_label(r_pr);
    let text = match raw_t {
        Some(Value::String(t)) => Cow::Borrowed(t.as_str()),
        None | Some(Value::Null) => Cow::Borrowed(""),
        Some(t @ (Value::Object(_) | Value::Array(_))) => Cow::Owned(
            defined(get(Some(t), "#text")).map_or_else(String::new, |t| value_to_string(Some(t))),
        ),
        Some(t) => Cow::Owned(value_to_string(Some(t))),
    };
    let hlink = get(r_pr, "a:hlinkClick");
    let action = get(hlink, "@_action");
    let action_text = value_truthy(action).then(|| value_to_string(action));
    let hlink_named_action = named_action_of(action_text.as_deref());
    let r_id = get(hlink, "@_r:id");
    let hlink_target: Option<String> = if let Some(named) = hlink_named_action {
        Some(format!("action:{named}"))
    } else if value_truthy(r_id) {
        ctx.hlink_rels
            .and_then(|rels| rels.get(&value_to_string(r_id)))
            .cloned()
    } else {
        None
    };
    let fill = get(r_pr, "a:solidFill");
    let grad_fill = get(r_pr, "a:gradFill");
    let mut gradient: Option<RunGradient> = None;
    if value_truthy(grad_fill)
        && is_object(grad_fill)
        && let Some(Fill::Gradient(g)) = parse_fill(r_pr, ctx)
        && !g.stops.is_empty()
    {
        gradient = Some(RunGradient {
            stops: g.stops,
            angle: g.angle,
            scaled: (g.scaled == Some(true)).then_some(true),
        });
    }
    let theme_hlink = ctx
        .theme
        .and_then(|theme| theme.colors.as_ref())
        .and_then(|colors| colors.get("hlink"));
    let color: Option<String> = if value_truthy(fill) {
        resolve_color_node(fill, ctx)
    } else {
        None
    }
    .or_else(|| {
        gradient
            .as_ref()
            .and_then(|g| g.stops.get(g.stops.len() / 2))
            .map(|stop| stop.color.clone())
    })
    .or_else(|| {
        if filled(&hlink_target) {
            theme_hlink.cloned()
        } else {
            None
        }
    })
    .or_else(|| dflt.and_then(|d| d.color.as_ref().cloned()));
    let srgb = get(fill, "a:srgbClr");
    let srgb_has_mods =
        matches!(srgb, Some(Value::Object(o)) if o.keys().any(|k| k.starts_with("a:")));
    let color_follows_theme =
        color.is_some() && (!(value_truthy(fill) && value_truthy(srgb)) || srgb_has_mods);
    let color_inherited = color.is_some() && !value_truthy(fill);
    let highlight_node = get(r_pr, "a:highlight");
    let highlight = if value_truthy(highlight_node) {
        resolve_color_node(highlight_node, ctx)
    } else {
        None
    };
    let run_lang_script = ea_script_of_lang(get(r_pr, "@_altLang"))
        .or_else(|| ea_script_of_lang(get(r_pr, "@_lang")));
    // Line-breaking rules follow the language tag alone (not the text's script): a run's own
    // lang/altLang overrides the inherited level default (an explicit en-US has no EA rules);
    // no tag anywhere leaves eaLang unset for the layout's default editing language
    let own_lang =
        defined(get(r_pr, "@_altLang")).is_some() || defined(get(r_pr, "@_lang")).is_some();
    let ea_lang = if own_lang {
        Some(ea_lang_of(run_lang_script))
    } else {
        dflt.and_then(|d| *d.ea_lang)
    };
    let ea_script = run_lang_script
        .or_else(|| {
            if js_regex!(r"[\u3040-\u30ff\u31f0-\u31ff]").test(&text) {
                Some(EaScript::Ja)
            } else if js_regex!(r"[\uac00-\ud7af\u1100-\u11ff]").test(&text) {
                Some(EaScript::Ko)
            } else {
                None
            }
        })
        .or_else(|| dflt.and_then(|d| *d.ea_script))
        .or_else(|| {
            js_regex!(r"[\u3400-\u9fff\uf900-\ufaff]")
                .test(&text)
                .then_some(EaScript::Han)
        });
    let typeface = |bucket: &str| get(get(r_pr, bucket), "@_typeface");
    let latin = resolve_font_ref(
        typeface("a:latin").and_then(Value::as_str),
        ctx.theme,
        ea_script,
    )
    .map(str::to_owned)
    .or_else(|| dflt.and_then(|d| d.latin_font.as_ref().cloned()));
    let ea_face = match defined(typeface("a:ea")) {
        Some(face) => face.as_str(),
        None => dflt.and_then(|d| d.ea_font_ref.as_deref()),
    };
    let ea = resolve_font_ref(ea_face, ctx.theme, ea_script)
        .map(str::to_owned)
        .or_else(|| dflt.and_then(|d| d.ea_font.as_ref().cloned()));
    let cs = resolve_font_ref(
        typeface("a:cs").and_then(Value::as_str),
        ctx.theme,
        ea_script,
    )
    .map(str::to_owned)
    .or_else(|| dflt.and_then(|d| d.cs_font.as_ref().cloned()));
    let sym = resolve_font_ref(typeface("a:sym").and_then(Value::as_str), ctx.theme, None)
        .map(str::to_owned);
    let pua_only = sym.is_some()
        && js_regex!(r"^[\uf000-\uf0ff]+$")
            .test(&js_regex!(r"\s+").replace_all(&text, |_| String::new()))
        && !trim(&text).is_empty();
    let charset_attr_of = |bucket: &str| -> Option<FontScriptHint> {
        let v = defined(get(get(r_pr, bucket), "@_charset"));
        defined(typeface(bucket))?;
        let n = int(Some(v?));
        if n.is_finite() {
            charset_script(to_int32(n) & 0xff)
        } else {
            None
        }
    };
    let charset_of = |bucket: &str| -> Option<FontScriptHint> {
        match run_lang_script {
            Some(script) => hint_of(script),
            None => charset_attr_of(bucket),
        }
    };
    let pair = |f: String, bucket: &str| FontPair {
        f,
        cset: charset_of(bucket),
        decl: charset_attr_of(bucket),
    };
    let cs_pair = cs.map(|f| pair(f, "a:cs"));
    let ea_pair = ea.map(|f| pair(f, "a:ea"));
    let latin_pair = latin.map(|f| pair(f, "a:latin"));
    let is_cjk = js_regex!(
        r"[\u1100-\u11ff\u2e80-\u303e\u3041-\u33ff\u3400-\u9fff\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]"
    )
    .test(&text);
    let picked = if pua_only {
        sym.is_some().then_some(Picked::Sym)
    } else {
        let cs_p = cs_pair.is_some().then_some(Picked::Cs);
        let ea_p = ea_pair.is_some().then_some(Picked::Ea);
        let latin_p = latin_pair.is_some().then_some(Picked::Latin);
        let is_cs = js_regex!(
            r"[\u0590-\u07bf\u08a0-\u08ff\u0900-\u0dff\u0e00-\u0eff\u1000-\u109f\u1780-\u17ff\ufb1d-\ufdff\ufe70-\ufeff]"
        )
        .test(&text);
        let by_script = if is_cs {
            cs_p.or(latin_p).or(ea_p)
        } else if is_cjk {
            ea_p.or(latin_p)
        } else {
            latin_p.or(ea_p)
        };
        by_script.or_else(|| {
            ctx.theme
                .and_then(|theme| theme.minor_font.as_ref())
                .map(|_| Picked::ThemeMinor)
        })
    };
    let picked_pair = match picked {
        Some(Picked::Cs) => cs_pair.as_ref(),
        Some(Picked::Ea) => ea_pair.as_ref(),
        Some(Picked::Latin) => latin_pair.as_ref(),
        _ => None,
    };
    let font_family: Option<String> = match picked {
        None => None,
        Some(Picked::Sym) => sym.clone(),
        Some(Picked::ThemeMinor) => ctx
            .theme
            .and_then(|theme| theme.minor_font.as_ref().cloned()),
        Some(_) => picked_pair.map(|p| p.f.clone()),
    };
    let latin_family = match (picked, &latin_pair, picked_pair) {
        (Some(Picked::Ea), Some(latin_pair), Some(ea_pair)) if latin_pair.f != ea_pair.f => {
            Some(latin_pair.f.clone())
        }
        _ => None,
    };
    let font_script_hint = if is_cjk {
        picked_pair.and_then(|p| p.cset)
    } else {
        picked_pair.and_then(|p| p.decl)
    };
    let b_attr = defined(get(r_pr, "@_b"));
    let i_attr = defined(get(r_pr, "@_i"));
    let mut outline = None;
    let ln_node = get(r_pr, "a:ln");
    let ln_fill = get(ln_node, "a:solidFill");
    if value_truthy(ln_node)
        && is_object(ln_node)
        && value_truthy(ln_fill)
        && let Some(ln_color) = resolve_color_node(ln_fill, ctx).filter(|c| !c.is_empty())
    {
        let w = defined(get(ln_node, "@_w")).map_or(9525.0, |w| int(Some(w)));
        outline = Some(TextOutline {
            color: ln_color,
            width_emu: JsNum(if w.is_finite() { w } else { 9525.0 }),
        });
    }
    let run_shadow = parse_shadow(r_pr, ctx)
        .or_else(|| dflt.and_then(|d| d.shadow.as_ref()).map(ShadowEffect::from));
    let run_glow = parse_glow(r_pr, ctx);
    let reflection = defined(get(get(r_pr, "a:effectLst"), "a:reflection")).is_some();
    let u_attr = get(r_pr, "@_u");
    let strike_attr = get(r_pr, "@_strike");
    let has_strike = strike_attr.is_some() && !is(strike_attr, "noStrike");
    let latin_raw = typeface("a:latin");
    let ea_raw = typeface("a:ea");
    let cs_raw = typeface("a:cs");
    let link_underline = hlink_target.is_some() && u_attr.is_none();
    let src = dflt.and_then(|d| d.src.as_ref());
    let inherited = |layer: Option<&String>, has: bool| -> String {
        if has {
            layer.map_or_else(|| "inherited".to_owned(), String::clone)
        } else {
            "default".to_owned()
        }
    };
    let font_source = || -> String {
        let Some(which) = picked else {
            return "default".to_owned();
        };
        if pua_only {
            return "run".to_owned();
        }
        let slot = match which {
            Picked::Cs => "a:cs",
            Picked::Ea => "a:ea",
            Picked::Latin => "a:latin",
            Picked::Sym | Picked::ThemeMinor => return "theme minor".to_owned(),
        };
        if let Some(own) = defined(get(get(r_pr, slot), "@_typeface")) {
            let own = value_to_string(Some(own));
            return theme_font_source(Some(own.as_str()))
                .unwrap_or("run")
                .to_owned();
        }
        let r#ref = match which {
            Picked::Latin => dflt.and_then(|d| d.latin_font_ref.as_deref()),
            Picked::Ea => dflt.and_then(|d| d.ea_font_ref.as_deref()),
            _ => None,
        };
        let layer = match which {
            Picked::Latin => src.and_then(|s| s.latin_font.as_deref()),
            Picked::Ea => src.and_then(|s| s.ea_font.as_deref()),
            _ => src.and_then(|s| s.cs_font.as_deref()),
        };
        [theme_font_source(r#ref), Some(layer.unwrap_or("inherited"))]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" via ")
    };
    // sz/spc are integer hundredths. `?? dflt` does not catch NaN, so one malformed
    // attribute used to put NaN into every downstream glyph size and line height.
    let own_font_size = hundredths_or(get(r_pr, "@_sz"), None);
    let own_letter_spacing = hundredths_or(get(r_pr, "@_spc"), None);
    let style_src = RunStyleSource {
        font_size: if own_font_size.is_some() {
            "run".to_owned()
        } else {
            inherited(
                src.and_then(|s| s.font_size.as_ref()),
                dflt.is_some_and(|d| d.font_size.is_some()),
            )
        },
        bold: if b_attr.is_some() {
            "run".to_owned()
        } else {
            inherited(
                src.and_then(|s| s.bold.as_ref()),
                dflt.is_some_and(|d| d.bold.is_some()),
            )
        },
        italic: if i_attr.is_some() {
            "run".to_owned()
        } else {
            inherited(
                src.and_then(|s| s.italic.as_ref()),
                dflt.is_some_and(|d| d.italic.is_some()),
            )
        },
        color: if value_truthy(fill) || gradient.is_some() {
            "run".to_owned()
        } else if filled(&hlink_target) && theme_hlink.is_some_and(|c| !c.is_empty()) {
            "theme hlink".to_owned()
        } else {
            inherited(
                src.and_then(|s| s.color.as_ref()),
                dflt.is_some_and(|d| d.color.is_some()),
            )
        },
        font_family: font_source(),
    };

    let mut run = TextRun::default();
    run.text.set(text.into_owned());
    run.style_src.set(style_src);
    run.bold.set(match b_attr {
        Some(b) => is(Some(b), "1") || is(Some(b), "true"),
        None => dflt.and_then(|d| *d.bold).unwrap_or(false),
    });
    if b_attr.is_none() {
        run.bold_implicit.set(true);
    }
    run.italic.set(match i_attr {
        Some(i) => is(Some(i), "1") || is(Some(i), "true"),
        None => dflt.and_then(|d| *d.italic).unwrap_or(false),
    });
    if i_attr.is_none() {
        run.italic_implicit.set(true);
    }
    let cap_attr = defined(get(r_pr, "@_cap"));
    let cap = match cap_attr {
        Some(cap) => Some(value_to_string(Some(cap))),
        None => dflt.and_then(|d| d.cap.as_ref().cloned()),
    };
    if let Some(cap) = cap.filter(|cap| !cap.is_empty() && cap != "none") {
        run.cap.set(cap);
    }
    if let Some(cap) = cap_attr {
        run.cap_explicit.set(value_to_string(Some(cap)));
    }
    let underline_set = u_attr.is_some() && !is(u_attr, "none");
    run.underline.set(underline_set || link_underline);
    if underline_set {
        run.underline_style.set(value_to_string(u_attr));
    }
    if is(u_attr, "none") {
        run.underline_explicit_none.set(true);
    }
    if link_underline {
        run.underline_implicit.set(true);
    }
    if let Some(label) = redact_label {
        run.redact.set(label.to_owned());
    }
    if has_strike {
        run.strike.set(true);
        run.strike_style.set(value_to_string(strike_attr));
    }
    if is(strike_attr, "noStrike") {
        run.strike_explicit_none.set(true);
    }
    if value_truthy(latin_raw) {
        run.latin_font.set(value_to_string(latin_raw));
    }
    if value_truthy(ea_raw) {
        run.ea_font.set(value_to_string(ea_raw));
    }
    if value_truthy(cs_raw) {
        run.cs_font.set(value_to_string(cs_raw));
    }
    if !value_truthy(latin_raw) && !value_truthy(ea_raw) {
        run.font_implicit.set(true);
    }
    run.font_size.assign(match own_font_size {
        Some(size) => Some(JsNum(size)),
        None => dflt.and_then(|d| *d.font_size),
    });
    if own_font_size.is_none() {
        run.font_size_implicit.set(true);
    }
    if let Some(spacing) = own_letter_spacing {
        run.letter_spacing.set(JsNum(spacing));
    }
    if let Some(kern) = defined(get(r_pr, "@_kern")) {
        run.kern.set(JsNum(or0(int(Some(kern))) / 100.0));
    }
    let baseline = get(r_pr, "@_baseline");
    if value_truthy(baseline) {
        run.baseline
            .set(JsNum(percent_fraction(baseline).unwrap_or(0.0) * 100.0));
    }
    run.font_family.assign(font_family);
    if let Some(latin_family) = latin_family.filter(|f| !f.is_empty()) {
        run.latin_family.set(latin_family);
    }
    run.font_script_hint.set_some(font_script_hint);
    run.ea_lang.set_some(ea_lang);
    if let Some(lang) = defined(get(r_pr, "@_lang")) {
        run.lang.set(value_to_string(Some(lang)));
    }
    if let Some(alt_lang) = defined(get(r_pr, "@_altLang")) {
        run.alt_lang.set(value_to_string(Some(alt_lang)));
    }
    run.color.assign(color);
    if color_follows_theme {
        run.color_follows_theme.set(true);
    }
    if value_truthy(fill)
        && !(defined(srgb).is_some() && !srgb_has_mods)
        && let Some(raw) = color_node_xml(fill).filter(|raw| !raw.is_empty())
    {
        run.color_node_xml.set(raw);
    }
    if color_inherited {
        run.color_inherited.set(true);
    }
    if let Some(highlight) = highlight.filter(|h| !h.is_empty()) {
        run.highlight.set(highlight);
    }
    run.outline.set_some(outline);
    run.shadow.set_some(run_shadow);
    run.gradient.set_some(gradient);
    run.glow.set_some(run_glow);
    if reflection {
        run.reflection.set(true);
    }
    if value_truthy(hlink) && (defined(r_id).is_some() || hlink_named_action.is_some()) {
        run.hyperlink_r_id
            .set(defined(r_id).map_or_else(String::new, |v| value_to_string(Some(v))));
        if let Some(target) = hlink_target.filter(|t| !t.is_empty()) {
            run.hyperlink.set(target);
        }
        if let Some(action) = action_text {
            run.hyperlink_action.set(action);
        }
        let tooltip = get(hlink, "@_tooltip");
        if value_truthy(tooltip) {
            run.hyperlink_tooltip.set(value_to_string(tooltip));
        }
    }
    run
}
