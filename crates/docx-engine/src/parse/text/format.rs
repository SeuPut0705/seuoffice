//! A paragraph's direct format: the resolved paragraph folded in, tab stops,
//! frames and property-change records.

use std::cmp::Ordering;

use jscompat::{JsNum, Radix, js_regex, parse_int, truthy};
use ooxml_xml::XNode;

use crate::model::{
    AutoSpace, CharIndents, EffectivePPr, ParaAlign, ParaFormat, ParaFrame, ParaFrameBox,
    ParaFrameBoxFloatSide, ParaFrameBoxHRule, ParaFrameHAnchor, ParaFrameHRule, ParaFrameVAnchor,
    ParaFrameWrap, ParaFrameXAlign, ParaFrameYAlign, PropChangeInfo, PropSource, RevisionInfo,
    TabStop, TabStopVal, True,
};
use crate::props::{self, auto_space_mode, char_indents_of};
use crate::revision_xml::read_prop_change_xml;
use crate::xml_text::on_off_of;

/// `(a, b) => a.pos - b.pos` as `Array.prototype.sort` reads it: NaN orders
/// as equal.
fn by_pos(a: &TabStop, b: &TabStop) -> Ordering {
    let difference = a.pos.0 - b.pos.0;
    if difference < 0.0 {
        Ordering::Less
    } else if difference > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// `CharIndents` as the model holds it.
fn model_char_indents(indents: &props::CharIndents) -> CharIndents {
    CharIndents {
        left: *indents.left,
        right: *indents.right,
        first_line: *indents.first_line,
        hanging: *indents.hanging,
    }
}

/// `AutoSpace` as the model holds it.
fn model_auto_space(mode: props::AutoSpace) -> AutoSpace {
    match mode {
        props::AutoSpace::Both(on) => AutoSpace::Bool(on),
        props::AutoSpace::Only("latin") => AutoSpace::Latin,
        props::AutoSpace::Only(_) => AutoSpace::Digits,
    }
}

/// `foldEffectiveFormat`: the direct format with what the renderer reads of
/// the resolved paragraph (the direction, the display flags, the style
/// chain's tab stops, the twips of character-unit indents) and the resolved
/// paragraph itself.
pub fn fold_effective_format(
    format: Option<&ParaFormat>,
    p_pr: Option<&XNode>,
    eff: &EffectivePPr,
) -> ParaFormat {
    let mut out = format.cloned().unwrap_or_default();
    // a paragraph without its own w:bidi takes the resolved direction; the
    // generator needs the flag to write the logical jc Word expects
    if eff.bidi && !out.bidi.unwrap_or(false) && !out.bidi_inherited.unwrap_or(false) {
        out.bidi_inherited.set(true);
        match *out.align {
            Some(ParaAlign::Left) => out.align.set(ParaAlign::Right),
            Some(ParaAlign::Right) => out.align.set(ParaAlign::Left),
            _ => {}
        }
    }
    let auto_space = auto_space_mode(Some(eff.auto_space_d_e), Some(eff.auto_space_d_n));
    if let Some(mode) = auto_space.filter(|mode| *mode != props::AutoSpace::Both(true)) {
        out.auto_space.set(model_auto_space(mode));
    }
    if !eff.word_wrap && out.word_wrap.is_none() {
        out.word_wrap.set(false);
    }
    if !eff.overflow_punct && out.overflow_punct.is_none() {
        out.overflow_punct.set(false);
    }
    // docDefaults w:lang stays off the paragraph: the renderer's default already covers it
    if out.east_asia_lang.is_none()
        && let Some(lang) = truthy(eff.east_asia_lang.as_deref())
        && eff.source.get("eastAsiaLang") != Some(&PropSource::DocDefaults)
    {
        out.east_asia_lang.set(lang.to_owned());
    }
    let direct = (*out.tab_stops).clone().unwrap_or_default();
    let inherited: Vec<TabStop> = eff
        .tab_stops
        .iter()
        .filter(|s| !direct.iter().any(|d| d.pos.0 == s.pos.0))
        .map(|s| TabStop {
            inherited: Some(True),
            ..s.clone()
        })
        .collect();
    if !inherited.is_empty() {
        let mut stops = direct;
        stops.extend(inherited);
        stops.sort_by(by_pos);
        out.tab_stops.set(stops);
    }
    if let Some(chars) = &eff.indent.chars {
        if chars.left.is_some() || chars.hanging.is_some() {
            out.indent_left.set(eff.indent.left);
        }
        // an explicit zero (direct w:firstLine/hanging="0") cancels the style
        // indent and must survive as a value, unlike an unset first line
        if eff.indent.first_line.0 != 0.0
            || eff.source.get("indentFirstLine") == Some(&PropSource::Direct)
        {
            out.indent_first_line.set(eff.indent.first_line);
        } else {
            out.indent_first_line.delete();
        }
        if chars.right.is_some() {
            out.indent_right.set(eff.indent.right);
        }
        // the save path cancels these when it rebuilds w:ind in twips
        out.char_indents.set(chars.clone());
        // the editor's direct-formatting mirror: only what the paragraph's own
        // w:ind declares (an indent the style chain provides must not become
        // direct formatting on a round trip)
        let own = char_indents_of(p_pr.and_then(|p_pr| p_pr.find_child("w:ind")));
        if let Some(own) = own {
            out.direct_char_indents.set(model_char_indents(&own));
        }
    }
    out.effective.set(eff.clone());
    out
}

/// `markSizeOf`: the size the paragraph mark declares for an empty line or a
/// list marker: its own w:sz, or the Cs chain where the paragraph is bidi or
/// the mark is w:rtl itself.
pub fn mark_size_of(eff: &EffectivePPr, p_pr: Option<&XNode>) -> Option<JsNum> {
    if eff.mark.source.get("sizeHalfPoints") == Some(&PropSource::Direct) {
        return Some(eff.mark.size_half_points);
    }
    let mark_r_pr = p_pr.and_then(|p_pr| p_pr.find_child("w:rPr"));
    if eff.bidi || mark_r_pr.is_some_and(|r_pr| on_off_of(r_pr, "w:rtl") == Some(true)) {
        return Some(eff.mark.size_half_points);
    }
    None
}

/// `mergeTabStops`: the style chain's stops under the direct ones (direct wins
/// per position, w:val="clear" removes).
pub fn merge_tab_stops(
    style: Option<&[TabStop]>,
    direct: Option<&[TabStop]>,
) -> Option<Vec<TabStop>> {
    let kept = |s: &&TabStop| s.val != TabStopVal::Clear;
    let (Some(style), Some(direct)) = (
        style.filter(|style| !style.is_empty()),
        direct.filter(|direct| !direct.is_empty()),
    ) else {
        let only = direct.or(style)?;
        return Some(only.iter().filter(kept).cloned().collect());
    };
    let mut merged: Vec<TabStop> = style
        .iter()
        .filter(|s| !direct.iter().any(|o| o.pos.0 == s.pos.0))
        .chain(direct)
        .filter(kept)
        .cloned()
        .collect();
    merged.sort_by(by_pos);
    // duplicated positions inside one list (seen in production pPr) collapse to the first
    let mut out: Vec<TabStop> = Vec::with_capacity(merged.len());
    for (i, s) in merged.iter().enumerate() {
        if i == 0 || s.pos.0 != merged[i - 1].pos.0 {
            out.push(s.clone());
        }
    }
    (!out.is_empty()).then_some(out)
}

/// `frameBoxOf`: the box a sized w:framePr (not a drop cap) lays the
/// paragraph out in.
pub fn frame_box_of(p_pr: &XNode) -> Option<ParaFrameBox> {
    let frame_pr = p_pr.find_child("w:framePr")?;
    let a = |name: &str| frame_pr.attr(name);
    if truthy(a("w:dropCap")).is_some() {
        return None;
    }
    let twips = |name: &str| {
        let v = parse_int(a(name).unwrap_or(""), Radix::Ten);
        (v.is_finite() && v > 0.0).then_some(JsNum(v))
    };
    let mut out = ParaFrameBox::default();
    let w = twips("w:w");
    let h = twips("w:h");
    if w.is_some() {
        out.w_twips = w;
    }
    if h.is_some() {
        out.h_twips = h;
        if a("w:hRule") == Some("exact") {
            out.h_rule = Some(ParaFrameBoxHRule::Exact);
        }
    }
    if w.is_none() && h.is_none() {
        return None;
    }
    out.h_space_twips = twips("w:hSpace");
    out.v_space_twips = twips("w:vSpace");
    // the frame keeps the paragraph's own flow position only when anchored to
    // the text; page/margin frames carry absolute offsets this does not place
    if a("w:vAnchor") == Some("text")
        && js_regex!(r"^(around|auto|through|tight)$").test(a("w:wrap").unwrap_or(""))
    {
        out.float_side = Some(if matches!(a("w:xAlign"), Some("right" | "outside")) {
            ParaFrameBoxFloatSide::Right
        } else {
            ParaFrameBoxFloatSide::Left
        });
    }
    Some(out)
}

/// `paraFrameOf`: the positioned frame of a w:framePr's attributes `a`;
/// frames without a width are not modeled.
pub fn para_frame_of(a: &XNode) -> Option<ParaFrame> {
    let attr = |key: &str| a.attr(key);
    let num = |key: &str| {
        let n = parse_int(attr(key).unwrap_or(""), Radix::Ten);
        n.is_finite().then_some(n)
    };
    let w = num("w:w").filter(|w| *w > 0.0)?;
    let mut frame = ParaFrame {
        w_twips: JsNum(w),
        x_twips: JsNum(num("w:x").unwrap_or(0.0)),
        y_twips: JsNum(num("w:y").unwrap_or(0.0)),
        h_twips: None,
        h_rule: None,
        h_anchor: None,
        v_anchor: None,
        wrap: None,
        h_space_twips: None,
        v_space_twips: None,
        x_align: None,
        y_align: None,
        anchor_lock: None,
    };
    if let Some(h) = num("w:h").filter(|h| *h > 0.0) {
        frame.h_twips = Some(JsNum(h));
        frame.h_rule = Some(if attr("w:hRule") == Some("exact") {
            ParaFrameHRule::Exact
        } else {
            ParaFrameHRule::AtLeast
        });
    }
    frame.h_anchor = match attr("w:hAnchor") {
        Some("margin") => Some(ParaFrameHAnchor::Margin),
        Some("text") => Some(ParaFrameHAnchor::Text),
        _ => None,
    };
    frame.v_anchor = match attr("w:vAnchor") {
        Some("margin") => Some(ParaFrameVAnchor::Margin),
        Some("text") => Some(ParaFrameVAnchor::Text),
        _ => None,
    };
    frame.wrap = match attr("w:wrap") {
        Some("around") => Some(ParaFrameWrap::Around),
        Some("through") => Some(ParaFrameWrap::Through),
        Some("notBeside") => Some(ParaFrameWrap::NotBeside),
        Some("auto") => Some(ParaFrameWrap::Auto),
        Some("tight") => Some(ParaFrameWrap::Tight),
        _ => None,
    };
    frame.h_space_twips = num("w:hSpace").filter(|n| *n != 0.0).map(JsNum);
    frame.v_space_twips = num("w:vSpace").filter(|n| *n != 0.0).map(JsNum);
    frame.x_align = match attr("w:xAlign") {
        Some("left") => Some(ParaFrameXAlign::Left),
        Some("center") => Some(ParaFrameXAlign::Center),
        Some("right") => Some(ParaFrameXAlign::Right),
        Some("inside") => Some(ParaFrameXAlign::Inside),
        Some("outside") => Some(ParaFrameXAlign::Outside),
        _ => None,
    };
    frame.y_align = match attr("w:yAlign") {
        Some("top") => Some(ParaFrameYAlign::Top),
        Some("center") => Some(ParaFrameYAlign::Center),
        Some("bottom") => Some(ParaFrameYAlign::Bottom),
        Some("inside") => Some(ParaFrameYAlign::Inside),
        Some("outside") => Some(ParaFrameYAlign::Outside),
        Some("inline") => Some(ParaFrameYAlign::Inline),
        _ => None,
    };
    if matches!(attr("w:anchorLock"), Some("1" | "true")) {
        frame.anchor_lock = Some(true);
    }
    Some(frame)
}

/// `propChangeInfo`: the first `change_name` record of a property fragment,
/// its previous properties kept only where there are some.
pub fn prop_change_info(xml: &str, change_name: &str) -> Option<PropChangeInfo> {
    let record = read_prop_change_xml(xml, change_name)?;
    Some(PropChangeInfo {
        revision_info: RevisionInfo {
            author: record.author.to_owned(),
            date: record.date.map(str::to_owned),
            date_utc: record.date_utc.map(str::to_owned),
            id: record.id.map(str::to_owned),
            r#move: None,
        },
        v_merge: record.v_merge.map(str::to_owned),
        v_merge_orig: record.v_merge_orig.map(str::to_owned),
        old_xml: truthy(Some(record.old_xml)).map(str::to_owned),
        resolved: None,
    })
}
