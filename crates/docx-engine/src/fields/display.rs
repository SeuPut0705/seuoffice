//! `fieldDisplayOf` of packages/docx-engine/src/parse-fields.ts and the
//! private functions it stands on: the display hint of a protected field
//! paragraph (a TOC line, the visible result text, a page break marker).

use std::borrow::Cow;

use jscompat::{JsMap, JsNum, js_regex, to_number, trim, truthy};
use serde::Serialize;

use super::{
    AdditiveSpacing, DirectLine, ParaGeometry, additive_spacing_of, direct_line_of,
    direct_para_geometry, lone_field_end, r_pr_node_of, tag_attr, toc_level_of,
};
use crate::eq_field::inline_eq_field_results;
use crate::props::TabStop;
use crate::resolve::{
    EffectivePPr, EffectiveRPr, PropSource, ResolveCtx, ResolveDoc, ResolveParaOptions,
    resolve_ctx_of, resolve_paragraph_props_xml, resolve_run_props,
};
use crate::styles::StyleInfo;
use crate::xml_text::{decode_entities, plain_text};

/// `FieldDisplay`: model type, to be replaced by the generated model.
///
/// The fields are in the order `fieldDisplayOf` writes its keys. Each of its
/// three object literals writes a subset of them in this same order (the
/// tocLine has no `emptyLine` and no `align`, the text forms have none of the
/// TOC keys), and the spreads at the end add keys no earlier part wrote, so
/// one fixed order serves every path.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDisplay {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_tab_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hang_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mark_deleted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub empty_line: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sz_half_points: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ea_font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_style_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leader: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_tab_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<&'static str>,
    #[serde(flatten)]
    pub line: DirectLine,
    #[serde(flatten)]
    pub geometry: ParaGeometry,
    #[serde(flatten)]
    pub additive: AdditiveSpacing,
}

/// `resolverOrBare`: the resolver, else one over nothing (callers without a
/// document).
fn resolver_or_bare(resolver: Option<&ResolveCtx>) -> Cow<'_, ResolveCtx> {
    resolver.map_or_else(
        || Cow::Owned(resolve_ctx_of(ResolveDoc::default())),
        Cow::Borrowed,
    )
}

const TAB_LEADERS: [&str; 6] = ["none", "dot", "hyphen", "underscore", "heavy", "middleDot"];

/// `if (x)` on a number.
fn truthy_num(value: f64) -> bool {
    value != 0.0 && !value.is_nan()
}

/// `Math.max(a, b)`: NaN wins, and +0 is above -0.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { b } else { a }
    } else if b > a {
        b
    } else {
        a
    }
}

/// `Number(/\sw:pos=(?:"([^"]+)"|'([^']+)')/.exec(tag)?.slice(1, 3).find(Boolean))`
fn pos_of(tag: &str) -> f64 {
    js_regex!(r#"\sw:pos=(?:"([^"]+)"|'([^']+)')"#)
        .exec(tag)
        .and_then(|found| truthy(found.get(1)).or_else(|| truthy(found.get(2))))
        .map_or(f64::NAN, to_number)
}

/// `style?.display?.tabStops ?? inheritedStops`
fn style_or_inherited<'a>(
    style: Option<&'a StyleInfo>,
    inherited_stops: &'a [TabStop],
) -> &'a [TabStop] {
    style
        .and_then(|style| style.display.as_ref())
        .and_then(|display| (*display.tab_stops).as_ref())
        .map_or(inherited_stops, Vec::as_slice)
}

/// `styleStopsOf`: style (or inherited) stops minus the ones the paragraph's
/// own w:tabs clear.
fn style_stops_of<'a>(
    p_pr: &str,
    style: Option<&'a StyleInfo>,
    inherited_stops: &'a [TabStop],
) -> impl Iterator<Item = &'a TabStop> {
    let mut cleared: Vec<f64> = Vec::new();
    if let Some(tabs_xml) = js_regex!(r"<w:tabs>[\s\S]*?<\/w:tabs>").exec(p_pr) {
        for found in js_regex!(r"<w:tab\s[^>]*\/>", "g").find_iter(tabs_xml.as_str()) {
            if !js_regex!(r#"\sw:val=(?:"clear"|'clear')"#).test(found.as_str()) {
                continue;
            }
            let pos = pos_of(found.as_str());
            // a Set of numbers: SameValueZero, which f64 equality is on finite values
            if pos.is_finite() && !cleared.contains(&pos) {
                cleared.push(pos);
            }
        }
    }
    style_or_inherited(style, inherited_stops)
        .iter()
        .filter(move |stop| !cleared.contains(&stop.pos.0))
}

/// `tocRightTabOf`'s `{ leader, pos? }`.
struct RightTab<'a> {
    leader: &'a str,
    pos: Option<f64>,
}

/// `tocRightTabOf`: the page number's right tab stop: the last direct right
/// stop (a stop without w:leader is a bare tab), else the style's (or
/// inherited) unless cleared.
fn toc_right_tab_of<'a>(
    p_pr: &str,
    style: Option<&'a StyleInfo>,
    inherited_stops: &'a [TabStop],
) -> Option<RightTab<'a>> {
    if let Some(tabs_xml) = js_regex!(r"<w:tabs>[\s\S]*?<\/w:tabs>").exec(p_pr) {
        let last = js_regex!(r"<w:tab\s[^>]*\/>", "g")
            .find_iter(tabs_xml.as_str())
            .map(|found| found.as_str())
            .filter(|tab| js_regex!(r#"\sw:val=(?:"right"|'right')"#).test(tab))
            .last();
        if let Some(last) = last {
            let v = js_regex!(r#"\sw:leader=(?:"([^"]+)"|'([^']+)')"#)
                .exec(last)
                .and_then(|found| truthy(found.get(1)).or_else(|| truthy(found.get(2))))
                .unwrap_or("none");
            let pos = pos_of(last);
            return Some(RightTab {
                leader: TAB_LEADERS
                    .iter()
                    .copied()
                    .find(|leader| *leader == v)
                    .unwrap_or("none"),
                pos: (pos.is_finite() && pos > 0.0).then_some(pos),
            });
        }
    }
    let stop = style_stops_of(p_pr, style, inherited_stops)
        .filter(|stop| stop.val == "right")
        .last();
    if let Some(stop) = stop {
        return Some(RightTab {
            leader: stop.leader.as_deref().unwrap_or("none"),
            pos: (stop.pos.0 > 0.0 && truthy(stop.rel).is_none()).then_some(stop.pos.0),
        });
    }
    // a cleared right stop leaves the tab on Word's default stops: no leader
    let cleared = style_or_inherited(style, inherited_stops)
        .iter()
        .any(|stop| stop.val == "right");
    cleared.then_some(RightTab {
        leader: "none",
        pos: None,
    })
}

/// `tocNumTabOf`: position (twips, from the column edge) of the first left
/// tab stop the outline number's tab jumps to: direct w:tabs, else the
/// style's.
fn toc_num_tab_of(
    p_pr: &str,
    style: Option<&StyleInfo>,
    inherited_stops: &[TabStop],
) -> Option<f64> {
    if let Some(tabs_xml) = js_regex!(r"<w:tabs>[\s\S]*?<\/w:tabs>").exec(p_pr) {
        for found in js_regex!(r"<w:tab\s[^>]*\/>", "g").find_iter(tabs_xml.as_str()) {
            if !js_regex!(r#"\sw:val=(?:"left"|'left')"#).test(found.as_str()) {
                continue;
            }
            let pos = pos_of(found.as_str());
            if pos.is_finite() && pos > 0.0 {
                return Some(pos);
            }
        }
    }
    style_stops_of(p_pr, style, inherited_stops)
        .find(|stop| stop.val == "left" && stop.pos.0 > 0.0)
        .map(|stop| stop.pos.0)
}

/// `CJK_INK_RE.test(text)`
fn cjk_ink(text: &str) -> bool {
    js_regex!(r"[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]").test(text)
}

/// The `slot` argument of `directFont`.
#[derive(Clone, Copy)]
enum FontSlot {
    Ascii,
    EastAsia,
}

/// `directFont`: a face the run's own w:rFonts declares for the slot.
fn direct_font(r: &EffectiveRPr, slot: FontSlot) -> Option<&str> {
    let (key, font) = match slot {
        FontSlot::Ascii => ("ascii", &r.fonts.ascii),
        FontSlot::EastAsia => ("eastAsia", &r.fonts.east_asia),
    };
    if r.source.get(key) == Some(&PropSource::Direct) {
        font.as_deref()
    } else {
        None
    }
}

/// `leadingRunFont`: direct face of a run for its script: eastAsia for CJK
/// text, else ascii (hAnsi fallback).
fn leading_run_font<'r>(r: &'r EffectiveRPr, text: &str) -> Option<&'r str> {
    if r.source.get("ascii") != Some(&PropSource::Direct)
        && r.source.get("eastAsia") != Some(&PropSource::Direct)
    {
        return None;
    }
    let ea = if cjk_ink(text) {
        direct_font(r, FontSlot::EastAsia)
    } else {
        None
    };
    ea.or_else(|| direct_font(r, FontSlot::Ascii))
}

/// `cjkRunFont`: eastAsia face of a run that draws CJK ink.
fn cjk_run_font<'r>(r: &'r EffectiveRPr, text: &str) -> Option<&'r str> {
    if cjk_ink(text) {
        direct_font(r, FontSlot::EastAsia)
    } else {
        None
    }
}

/// `tocLineOf`: direct line rule, else the paragraph style's fixed one (an
/// auto multiple cascades via CSS).
fn toc_line_of(eff: &EffectivePPr) -> DirectLine {
    let direct = direct_line_of(eff);
    let Some(line) = &eff.spacing.line else {
        return direct;
    };
    if truthy(direct.line_rule.as_deref()).is_some()
        || eff.source.get("line") != Some(&PropSource::ParaStyle)
        || line.rule == "auto"
    {
        return direct;
    }
    DirectLine {
        line_rule: Some(line.rule.clone()),
        line_raw_twips: Some(line.raw),
        line_spacing: None,
    }
}

/// `unstyledTocEntry`: a TOC entry Word wrote without TOC styles: PAGEREF
/// page number behind a right tab stop. A stop that comes from a style also
/// needs a run-level tab, the one the page number sits behind.
fn unstyled_toc_entry(xml: &str, p_pr: &str, inherited_stops: &[TabStop]) -> bool {
    if !js_regex!(r"<w:instrText[^>]*>\s*PAGEREF\s").test(xml) {
        return false;
    }
    if js_regex!(r#"<w:tabs>[\s\S]*?<w:tab\s[^>]*w:val=(?:"right"|'right')"#).test(p_pr) {
        return true;
    }
    inherited_stops.iter().any(|stop| stop.val == "right")
        && js_regex!(r"<w:tab\s*[/]>|<w:tab>\s*<[/]w:tab>").test(xml)
}

/// `ResultRun`: a visible result run resolved through the chain; its direct
/// rPr decides what travels inline.
struct ResultRun {
    text: String,
    run: EffectiveRPr,
}

/// `directSize`
fn direct_size(r: &EffectiveRPr) -> f64 {
    if r.source.get("sizeHalfPoints") == Some(&PropSource::Direct) {
        r.size_half_points.0
    } else {
        0.0
    }
}

/// `resultRuns`: visible result runs (w:t / w:delText; field machinery
/// excluded) with their resolved rPr.
fn result_runs(xml: &str, eff: &EffectivePPr, ctx: &ResolveCtx, deleted: bool) -> Vec<ResultRun> {
    let mut out = Vec::new();
    let text_re = if deleted {
        js_regex!(r"<w:(?:t|delText)(?:\s|>)")
    } else {
        js_regex!(r"<w:t(?:\s|>)")
    };
    for run in js_regex!(r"<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>", "g").find_iter(xml) {
        let inner = run.get(1).unwrap_or("");
        if !text_re.test(inner) || inner.contains("<w:instrText") {
            continue;
        }
        let mut joined = String::new();
        for found in js_regex!(
            r"<w:(?:t|delText)(?:\s[^>]*)?>([\s\S]*?)<\/w:(?:t|delText)>",
            "g"
        )
        .find_iter(inner)
        {
            joined.push_str(found.get(1).unwrap_or(""));
        }
        let text = decode_entities(&joined);
        let r_pr = r_pr_node_of(inner);
        out.push(ResultRun {
            text,
            run: resolve_run_props(r_pr.as_ref(), eff.style_id.as_deref(), eff.bidi, ctx, false),
        });
    }
    out
}

/// `fieldDisplayOf`: display-only rendering hint for a protected field
/// paragraph. The visible field result (w:t runs; instruction text lives in
/// w:instrText and is excluded) is shown instead of a generic chip. `None`
/// where the paragraph has nothing to show.
pub fn field_display_of(
    xml: &str,
    styles: Option<&JsMap<StyleInfo>>,
    resolver: Option<&ResolveCtx>,
) -> Result<Option<FieldDisplay>, String> {
    let ctx = resolver_or_bare(resolver);
    let ctx = &*ctx;
    let style_id = tag_attr(xml, "w:pStyle", "w:val")
        .map_err(|error| error.to_string())?
        .unwrap_or("");
    let p_pr = js_regex!(r"<w:pPr>[\s\S]*?<\/w:pPr>")
        .exec(xml)
        .map_or("", |found| found.as_str());
    let eff = resolve_paragraph_props_xml(xml, ctx, ResolveParaOptions::default())?;
    let mut geometry = direct_para_geometry(&eff);
    let line = direct_line_of(&eff);
    let additive = additive_spacing_of(ctx);
    let styled_level = toc_level_of(style_id, styles);
    // unstyled entries indent through their own w:ind, styled ones through the level ladder;
    // a TOC-styled paragraph without a tab run (title, spacer) is a plain line with no leader
    let tab_run = js_regex!(r"<w:tab\s*[/]>|<w:tab>\s*<[/]w:tab>|<w:delText(?:\s|>)").test(xml);
    let toc_level = match styled_level {
        Some(level) if tab_run => Some(level),
        _ if unstyled_toc_entry(xml, p_pr, &eff.tab_stops) => Some(styled_level.unwrap_or(1.0)),
        _ => None,
    };
    if styled_level.is_some() {
        geometry.indent_left_twips = None;
        geometry.indent_right_twips = None;
        geometry.indent_first_line_twips = None;
    }
    if let Some(toc_level) = toc_level {
        // TOC entry: title <tab with dot leader> page number. The page number
        // follows the LAST tab: entries like "1.1.<tab>Title<tab>7" put a leading
        // outline number at the first tab stop, not the page number.
        // tracked deletions leave the result: an entry whose every run is deleted
        // shows its deleted text struck through (and vanishes in balloon view)
        let live = js_regex!(r"<w:del(?:\s[^>]*)?(?<!\/)>[\s\S]*?<\/w:del>", "g")
            .replace_all(xml, |_| String::new());
        let deleted =
            !js_regex!(r"<w:t(?:\s|>)").test(&live) && js_regex!(r"<w:delText(?:\s|>)").test(xml);
        let mut segs: Vec<String> = vec![String::new()];
        // run-level tab is attribute-less CT_Empty, but LO/Google converters emit
        // it spaced (<w:tab />) or paired (<w:tab></w:tab>): match those too, while
        // still excluding tab-stop definitions (<w:tab w:val=.../> in w:tabs).
        let re = js_regex!(
            r"<w:(?:t|delText)(?:\s[^>]*)?>([\s\S]*?)<[/]w:(?:t|delText)>|<w:tab\s*[/]>|<w:tab>\s*<[/]w:tab>",
            "g"
        );
        for found in re.find_iter(if deleted { xml } else { &live }) {
            match found.get(1) {
                None => segs.push(String::new()),
                Some(text) => {
                    if let Some(last) = segs.last_mut() {
                        last.push_str(text);
                    }
                }
            }
        }
        let right = if segs.len() > 1 {
            segs.pop().unwrap_or_default()
        } else {
            String::new()
        };
        let style = styles.and_then(|styles| styles.get(style_id));
        let num_tab = toc_num_tab_of(p_pr, style, &eff.tab_stops);
        // a short first segment (spaced too when a left stop exists for it) is the outline
        // number; it renders in the num cell so the title stays clean for heading matching
        let mut num: Option<String> = None;
        if segs.len() > 1 {
            let decoded = decode_entities(&segs[0]);
            let first = trim(&decoded);
            if js_regex!(r"^\S{1,15}$").test(first)
                || (num_tab.is_some() && js_regex!(r"^\S(?:[^\t]{0,18}\S)?$").test(first))
            {
                num = Some(first.to_owned());
                segs.remove(0);
            }
        }
        let mut left = String::new();
        for seg in &segs {
            let decoded = decode_entities(seg);
            let piece = trim(&decoded);
            if piece.is_empty() {
                continue;
            }
            if !left.is_empty() {
                left.push(' ');
            }
            left.push_str(piece);
        }
        let anchor = js_regex!(r#"<w:hyperlink [^>]*w:anchor="([^"]+)""#)
            .exec(xml)
            .and_then(|found| found.get(1));
        // direct pPr/run metrics: Word sizes TOC lines by them while the style
        // (html2docx exports) often carries nothing
        let right_tab = toc_right_tab_of(p_pr, style, &eff.tab_stops);
        let leader = right_tab.as_ref().map(|tab| tab.leader);
        let first_line = eff.indent.first_line.0;
        let first_line_start = eff.indent.left.0 + first_line;
        // font size from visible result runs only: field-machinery runs
        // (fldChar/instrText) often carry the target heading's size and would
        // inflate the whole line
        let runs = result_runs(xml, &eff, ctx, true);
        let sz = runs
            .iter()
            .fold(0.0, |max, r| js_max(max, direct_size(&r.run)));
        // face/weight of the leading visible run: Word draws the entry with the
        // result runs' rPr (a Times bold TOC under a Calibri body), the paragraph
        // style alone often says nothing
        let lead = runs.first();
        let font = lead.map(|lead| leading_run_font(&lead.run, &lead.text).unwrap_or(""));
        let bold = lead.is_some_and(|lead| {
            lead.run.source.get("bold") == Some(&PropSource::Direct) && lead.run.bold
        });
        let run_style_id = lead.and_then(|lead| truthy(lead.run.style_id.as_deref()));
        let mut ea_font = runs.iter().find_map(|r| cjk_run_font(&r.run, &r.text));
        if ea_font == font {
            ea_font = None;
        }
        let num_tab_twips = match (truthy(num.as_deref()), num_tab) {
            (Some(_), Some(num_tab)) if truthy_num(num_tab) => {
                Some(JsNum(js_max(0.0, num_tab - first_line_start)))
            }
            _ => None,
        };
        let font_family = truthy(font);
        return Ok(Some(FieldDisplay {
            kind: "tocLine",
            left: Some(left),
            right: Some(trim(&decode_entities(&right)).to_owned()),
            level: Some(JsNum(toc_level)),
            num: num.filter(|num| !num.is_empty()),
            num_tab_twips,
            hang_twips: truthy_num(first_line).then_some(JsNum(first_line)),
            anchor: anchor.map(str::to_owned),
            deleted: deleted.then_some(true),
            mark_deleted: (deleted && js_regex!(r"<w:del\b[^>]*\/>").test(p_pr)).then_some(true),
            sz_half_points: (sz > 0.0).then_some(JsNum(sz)),
            font_family: font_family.map(str::to_owned),
            ea_font_family: font_family.and_then(|_| truthy(ea_font)).map(str::to_owned),
            bold: bold.then_some(true),
            run_style_id: run_style_id.map(str::to_owned),
            leader: truthy(leader).map(str::to_owned),
            right_tab_twips: right_tab
                .and_then(|tab| tab.pos)
                .filter(|pos| truthy_num(*pos))
                .map(JsNum),
            line: toc_line_of(&eff),
            geometry,
            additive,
            ..FieldDisplay::default()
        }));
    }
    let xml = inline_eq_field_results(xml);
    let plain = plain_text(&xml);
    let visible = trim(&plain);
    if visible.is_empty() && js_regex!(r#"<w:br\s[^>]*w:type="page""#).test(&xml) {
        return Ok(Some(FieldDisplay {
            kind: "pageBreak",
            ..FieldDisplay::default()
        }));
    }
    if visible.is_empty() && (lone_field_end(&xml) || styled_level.is_some()) {
        // the paragraph mark's size sets the empty line (the end run's rPr does not)
        let sz = direct_size(&eff.mark);
        return Ok(Some(FieldDisplay {
            kind: "text",
            left: Some(String::new()),
            empty_line: Some(true),
            sz_half_points: (sz > 0.0).then_some(JsNum(sz)),
            line,
            geometry,
            additive,
            ..FieldDisplay::default()
        }));
    }
    if !visible.is_empty() {
        // face/size of the visible result runs (same rule as tocLine): without
        // them the passthrough div inherits the document default and a SimSun
        // field paragraph mis-snaps to a double cell on a typed line grid.
        // dominant size = the size covering the most text: a manual drop-cap letter
        // (one 48pt "L" before 10pt body) must not inflate the whole field's strut
        let runs = result_runs(&xml, &eff, ctx, false);
        let mut font: Option<&str> = None;
        // a Map keyed by number: SameValueZero, -0 stored as +0, NaN equal to NaN
        let mut sz_weights: Vec<(f64, f64)> = Vec::new();
        for ResultRun { text, run } in &runs {
            // unsized runs vote for the inherited default (key 0): one explicit
            // drop-cap letter must not out-vote a body of default-sized text
            let key = direct_size(run);
            let key = if key == 0.0 { 0.0 } else { key };
            let weight = js_max(text.encode_utf16().count() as f64, 1.0);
            match sz_weights
                .iter_mut()
                .find(|(k, _)| *k == key || (k.is_nan() && key.is_nan()))
            {
                Some((_, total)) => *total += weight,
                None => sz_weights.push((key, weight)),
            }
            if truthy(font).is_none() {
                font = direct_font(run, FontSlot::EastAsia)
                    .or_else(|| direct_font(run, FontSlot::Ascii));
            }
        }
        let mut sz = 0.0;
        let mut sz_weight = -1.0;
        for (v, w) in sz_weights {
            if w > sz_weight || (w == sz_weight && v > sz) {
                sz = v;
                sz_weight = w;
            }
        }
        // explicit paragraph alignment: the passthrough div would inherit the
        // document default (justify in CJK docs) and stretch short lines
        let direct = if eff.source.get("align") == Some(&PropSource::Direct) {
            eff.align
        } else {
            None
        };
        let align = if direct == Some("distribute") {
            Some("justify")
        } else {
            direct
        };
        return Ok(Some(FieldDisplay {
            kind: "text",
            left: Some(visible.to_owned()),
            sz_half_points: (sz > 0.0).then_some(JsNum(sz)),
            font_family: truthy(font).map(str::to_owned),
            align: truthy(align),
            line,
            geometry,
            additive,
            ..FieldDisplay::default()
        }));
    }
    Ok(None)
}
