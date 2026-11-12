//! The paragraph property builders of generate.ts: `PPR_CHILD_ORDER` through
//! `setPPrChange`.

use jscompat::{
    JsNum, Radix, RegexLimit, get_substitution, js_regex, math_max, math_min, math_round,
    number_to_string, parse_int, replace_first_string, to_number, trim,
};
use serde_json::Value;

use super::rpr::{js_slice, raw_attr, raw_bool};
use super::{escape_xml_attr, split_xml_children};
use crate::model::{CharIndents, ParaBorderLine, ParaFormat, ParaFrame, TabStop};
use crate::xml_tag::remove_elements;

pub const PPR_CHILD_ORDER: [&str; 36] = [
    "w:pStyle",
    "w:keepNext",
    "w:keepLines",
    "w:pageBreakBefore",
    "w:framePr",
    "w:widowControl",
    "w:numPr",
    "w:suppressLineNumbers",
    "w:pBdr",
    "w:shd",
    "w:tabs",
    "w:suppressAutoHyphens",
    "w:kinsoku",
    "w:wordWrap",
    "w:overflowPunct",
    "w:topLinePunct",
    "w:autoSpaceDE",
    "w:autoSpaceDN",
    "w:bidi",
    "w:adjustRightInd",
    "w:snapToGrid",
    "w:spacing",
    "w:ind",
    "w:contextualSpacing",
    "w:mirrorIndents",
    "w:suppressOverlap",
    "w:jc",
    "w:textDirection",
    "w:textAlignment",
    "w:textboxTightWrap",
    "w:outlineLvl",
    "w:divId",
    "w:cnfStyle",
    "w:rPr",
    "w:sectPr",
    "w:pPrChange",
];

fn rank(name: &str) -> i64 {
    PPR_CHILD_ORDER
        .iter()
        .position(|n| *n == name)
        .map_or(-1, |i| i as i64)
}

/// `String(Math.round(x))`
fn round(x: f64) -> String {
    number_to_string(math_round(x))
}

fn n(x: Option<JsNum>) -> Option<f64> {
    x.map(|x| x.0)
}

fn num_truthy(x: Option<JsNum>) -> bool {
    x.is_some_and(|x| x.0 != 0.0 && !x.0.is_nan())
}

/// `a === b` for numbers that may be undefined
fn same(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// tri-state pPr flags, in the key order of PPR_FLAG_FIELDS
const PPR_FLAG_TAGS: [&str; 5] = [
    "w:keepNext",
    "w:keepLines",
    "w:widowControl",
    "w:suppressLineNumbers",
    "w:contextualSpacing",
];

fn flag(format: &ParaFormat, tag: &str) -> Option<bool> {
    match tag {
        "w:keepNext" => *format.keep_next,
        "w:keepLines" => *format.keep_lines,
        "w:widowControl" => *format.widow_control,
        "w:suppressLineNumbers" => *format.suppress_line_numbers,
        "w:contextualSpacing" => *format.contextual_spacing,
        _ => None,
    }
}

const FORMAT_MANAGED_TAGS: [&str; 7] = [
    "w:pageBreakBefore",
    "w:pBdr",
    "w:shd",
    "w:bidi",
    "w:spacing",
    "w:ind",
    "w:jc",
];

fn border_line(format: &ParaFormat, ch: char) -> Option<&ParaBorderLine> {
    let lines = format.border_lines.as_ref()?;
    match ch {
        't' => lines.t.as_ref(),
        'b' => lines.b.as_ref(),
        'l' => lines.l.as_ref(),
        _ => lines.r.as_ref(),
    }
}

/// w:spacing element for a ParaFormat ('' when nothing is set)
fn para_spacing_xml(format: &ParaFormat) -> String {
    let mut attrs: Vec<String> = Vec::new();
    if let Some(before) = n(*format.space_before).filter(|b| *b > 0.0) {
        attrs.push(format!("w:before=\"{}\"", round(before)));
    }
    if let Some(auto) = *format.space_before_auto {
        attrs.push(format!("w:beforeAutospacing=\"{}\"", u8::from(auto)));
    }
    if let Some(after) = n(*format.space_after).filter(|a| *a >= 0.0) {
        attrs.push(format!("w:after=\"{}\"", round(after)));
    }
    if let Some(auto) = *format.space_after_auto {
        attrs.push(format!("w:afterAutospacing=\"{}\"", u8::from(auto)));
    }
    let rule = format.line_rule.as_ref().map(|r| r.as_str());
    if (rule == Some("exact") || rule == Some("atLeast")) && num_truthy(*format.line_raw_twips) {
        attrs.push(format!(
            "w:line=\"{}\"",
            round(format.line_raw_twips.unwrap().0)
        ));
        attrs.push(format!("w:lineRule=\"{}\"", rule.unwrap()));
    } else if let Some(spacing) = n(*format.line_spacing).filter(|s| *s > 0.0) {
        attrs.push(format!("w:line=\"{}\"", round(spacing * 240.0)));
        attrs.push("w:lineRule=\"auto\"".to_owned());
    }
    if attrs.is_empty() {
        String::new()
    } else {
        format!("<w:spacing {}/>", attrs.join(" "))
    }
}

/// pPr children the ParaFormat model owns, as (name, xml)
pub(crate) fn format_p_pr_children(format: Option<&ParaFormat>) -> Vec<(String, String)> {
    let Some(format) = format else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = Vec::new();
    let mut push = |name: &str, xml: String| out.push((name.to_owned(), xml));
    if *format.page_break_before == Some(true) {
        push("w:pageBreakBefore", "<w:pageBreakBefore/>".to_owned());
    }
    for tag in PPR_FLAG_TAGS {
        if let Some(v) = flag(format, tag) {
            push(
                tag,
                if v {
                    format!("<{tag}/>")
                } else {
                    format!("<{tag} w:val=\"0\"/>")
                },
            );
        }
    }
    if let Some(borders) = format.borders.as_deref().filter(|b| !b.is_empty()) {
        let style = format.border_style.as_ref();
        let default_sz = math_max(
            2.0,
            math_round(style.and_then(|s| n(s.sz_eighths)).unwrap_or(4.0)),
        );
        let space = math_min(
            31.0,
            math_max(
                0.0,
                math_round(style.and_then(|s| n(s.space_pt)).unwrap_or(0.0)),
            ),
        );
        let default_color = match style.and_then(|s| s.color.as_deref()) {
            Some(c) if !c.is_empty() => escape_xml_attr(c),
            _ => "auto".to_owned(),
        };
        let line = |side: &str, ch: char| -> String {
            let declared = border_line(format, ch);
            let sz = match declared.and_then(|d| d.sz_pt) {
                Some(sz) if num_truthy(Some(sz)) => math_max(1.0, math_round(sz.0 * 8.0)),
                _ => default_sz,
            };
            let color = match declared.and_then(|d| d.color.as_deref()) {
                Some(c) if !c.is_empty() => escape_xml_attr(c),
                _ => default_color.clone(),
            };
            let sp = match declared.and_then(|d| n(d.space_pt)) {
                Some(sp) => math_min(31.0, math_max(0.0, math_round(sp))),
                None => space,
            };
            format!(
                "<w:{side} w:val=\"single\" w:sz=\"{}\" w:space=\"{}\" w:color=\"{color}\"/>",
                number_to_string(sz),
                number_to_string(sp)
            )
        };
        let mut sides = String::new();
        for (side, ch) in [("top", 't'), ("left", 'l'), ("bottom", 'b'), ("right", 'r')] {
            if borders.contains(ch) {
                sides.push_str(&line(side, ch));
            }
        }
        if !sides.is_empty() {
            push("w:pBdr", format!("<w:pBdr>{sides}</w:pBdr>"));
        }
    }
    if let Some(fill) = format.shading_fill.as_deref().filter(|f| !f.is_empty()) {
        push(
            "w:shd",
            format!(
                "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{}\"/>",
                escape_xml_attr(fill)
            ),
        );
    }
    if *format.bidi == Some(true) {
        push("w:bidi", "<w:bidi/>".to_owned());
    }
    let spacing = para_spacing_xml(format);
    if !spacing.is_empty() {
        push("w:spacing", spacing);
    }
    let mut ind: Vec<String> = Vec::new();
    if let Some(left) = n(*format.indent_left) {
        ind.push(format!("w:left=\"{}\"", round(left)));
    }
    if let Some(right) = n(*format.indent_right) {
        ind.push(format!("w:right=\"{}\"", round(right)));
    }
    if let Some(first) = format.char_indents.as_ref().and_then(|c| c.first_line)
        && num_truthy(Some(first))
    {
        ind.push(format!("w:firstLineChars=\"{}\"", round(first.0)));
    }
    if let Some(first) = n(*format.indent_first_line) {
        if first >= 0.0 {
            ind.push(format!("w:firstLine=\"{}\"", round(first)));
        } else {
            ind.push(format!("w:hanging=\"{}\"", round(-first)));
        }
    }
    if !ind.is_empty() {
        push("w:ind", format!("<w:ind {}/>", ind.join(" ")));
    }
    if let Some(align) = format.align.as_ref() {
        let mut jc = match align.as_str() {
            "justify" => "both",
            other => other,
        };
        if (*format.bidi == Some(true) || *format.bidi_inherited == Some(true))
            && (jc == "left" || jc == "right")
        {
            jc = if jc == "left" { "right" } else { "left" };
        }
        push("w:jc", format!("<w:jc w:val=\"{jc}\"/>"));
    }
    let real_stops: Vec<&TabStop> = real_stops(format);
    if !real_stops.is_empty() {
        let mut tabs = String::new();
        for ts in real_stops {
            tabs.push_str(&format!(
                "<w:tab w:val=\"{}\" w:pos=\"{}\"",
                escape_xml_attr(ts.val.as_str()),
                number_to_string(ts.pos.0)
            ));
            if let Some(leader) = ts.leader.as_ref().map(|l| l.as_str())
                && leader != "none"
            {
                tabs.push_str(&format!(" w:leader=\"{}\"", escape_xml_attr(leader)));
            }
            tabs.push_str("/>");
        }
        push("w:tabs", format!("<w:tabs>{tabs}</w:tabs>"));
    }
    if let Some(dir) = format.text_direction.as_ref() {
        push(
            "w:textDirection",
            format!("<w:textDirection w:val=\"{}\"/>", dir.as_str()),
        );
    }
    if let Some(frame) = format.frame.as_ref() {
        push("w:framePr", frame_pr_xml(frame));
    } else if let Some(drop_cap) = format.drop_cap.as_ref() {
        push(
            "w:framePr",
            format!(
                "<w:framePr w:dropCap=\"{}\" w:lines=\"{}\" w:wrap=\"around\" w:vAnchor=\"text\" w:hAnchor=\"text\"/>",
                drop_cap.r#type.as_str(),
                number_to_string(drop_cap.lines.0)
            ),
        );
    }
    if num_truthy(*format.empty_run_size_half_points) {
        let sz = round(format.empty_run_size_half_points.unwrap().0);
        push(
            "w:rPr",
            format!("<w:rPr><w:sz w:val=\"{sz}\"/><w:szCs w:val=\"{sz}\"/></w:rPr>"),
        );
    }
    out
}

fn real_stops(format: &ParaFormat) -> Vec<&TabStop> {
    format
        .tab_stops
        .iter()
        .flatten()
        .filter(|ts| ts.rel.is_none() && ts.inherited.is_none())
        .collect()
}

/// positioned paragraph frame: w:framePr with absolute x/y, Word's attribute order
fn frame_pr_xml(frame: &ParaFrame) -> String {
    let mut attrs = vec![format!("w:w=\"{}\"", round(frame.w_twips.0))];
    if let Some(h) = n(frame.h_twips) {
        attrs.push(format!("w:h=\"{}\"", round(h)));
        attrs.push(format!(
            "w:hRule=\"{}\"",
            frame.h_rule.as_ref().map_or("atLeast", |r| r.as_str())
        ));
    }
    if num_truthy(frame.v_space_twips) {
        attrs.push(format!(
            "w:vSpace=\"{}\"",
            round(frame.v_space_twips.unwrap().0)
        ));
    }
    if num_truthy(frame.h_space_twips) {
        attrs.push(format!(
            "w:hSpace=\"{}\"",
            round(frame.h_space_twips.unwrap().0)
        ));
    }
    attrs.push(format!(
        "w:wrap=\"{}\"",
        frame.wrap.as_ref().map_or("none", |w| w.as_str())
    ));
    attrs.push(format!(
        "w:vAnchor=\"{}\"",
        frame.v_anchor.as_ref().map_or("page", |a| a.as_str())
    ));
    attrs.push(format!(
        "w:hAnchor=\"{}\"",
        frame.h_anchor.as_ref().map_or("page", |a| a.as_str())
    ));
    attrs.push(format!("w:x=\"{}\"", round(frame.x_twips.0)));
    if let Some(x_align) = frame.x_align.as_ref() {
        attrs.push(format!("w:xAlign=\"{}\"", x_align.as_str()));
    }
    attrs.push(format!("w:y=\"{}\"", round(frame.y_twips.0)));
    if let Some(y_align) = frame.y_align.as_ref() {
        attrs.push(format!("w:yAlign=\"{}\"", y_align.as_str()));
    }
    if frame.anchor_lock == Some(true) {
        attrs.push("w:anchorLock=\"1\"".to_owned());
    }
    format!("<w:framePr {}/>", attrs.join(" "))
}

/// JC_TO_ALIGN, own keys only
fn jc_to_align(val: &str) -> Option<&'static str> {
    Some(match val {
        "left" | "start" => "left",
        "center" => "center",
        "right" | "end" => "right",
        "both" | "lowKashida" | "mediumKashida" | "highKashida" | "thaiDistribute" => "justify",
        "distribute" => "distribute",
        _ => return None,
    })
}

fn parse_attr(raw: Option<&str>, attr: &str) -> f64 {
    parse_int(raw_attr(raw, attr).unwrap_or(""), Radix::Ten)
}

fn finite(x: f64) -> Option<f64> {
    x.is_finite().then_some(x)
}

fn raw_spacing_unchanged(raw: Option<&str>, f: &ParaFormat) -> bool {
    let rule = raw_attr(raw, "w:lineRule").unwrap_or("auto");
    let line = parse_attr(raw, "w:line");
    let before = parse_attr(raw, "w:before");
    let after_str = raw_attr(raw, "w:after");
    let after = parse_int(after_str.unwrap_or(""), Radix::Ten);
    let raw_before = (before > 0.0).then_some(before);
    let raw_after = (after_str.is_some() && after >= 0.0).then_some(after);
    let f_before = n(*f.space_before).filter(|b| *b > 0.0).map(math_round);
    let f_after = n(*f.space_after).filter(|a| *a >= 0.0).map(math_round);
    if !same(raw_before, f_before) || !same(raw_after, f_after) {
        return false;
    }
    let raw_auto = |v: Option<&str>| v.map(|v| v == "1" || v == "true");
    if raw_auto(raw_attr(raw, "w:beforeAutospacing")) != *f.space_before_auto {
        return false;
    }
    if raw_auto(raw_attr(raw, "w:afterAutospacing")) != *f.space_after_auto {
        return false;
    }
    let f_rule = f.line_rule.as_ref().map(|r| r.as_str());
    if (f_rule == Some("exact") || f_rule == Some("atLeast")) && num_truthy(*f.line_raw_twips) {
        return line > 0.0
            && Some(rule) == f_rule
            && line == math_round(f.line_raw_twips.unwrap().0);
    }
    if let Some(spacing) = n(*f.line_spacing).filter(|s| *s > 0.0) {
        return line > 0.0
            && rule == "auto"
            && math_round((line / 240.0) * 100.0) / 100.0 == spacing;
    }
    // `!(line > 0)`: a NaN is not above zero either
    line.is_nan() || line <= 0.0
}

fn raw_ind_unchanged(raw: Option<&str>, f: &ParaFormat) -> bool {
    let either = |a: &str, b: &str| {
        parse_int(
            raw_attr(raw, a).or(raw_attr(raw, b)).unwrap_or(""),
            Radix::Ten,
        )
    };
    let left = either("w:left", "w:start");
    let right = either("w:right", "w:end");
    let first_line = parse_attr(raw, "w:firstLine");
    let hanging = parse_attr(raw, "w:hanging");
    let raw_first = if hanging > 0.0 {
        Some(-hanging)
    } else if first_line > 0.0 {
        Some(first_line)
    } else if first_line.is_finite() || hanging.is_finite() {
        Some(0.0)
    } else {
        None
    };
    same(finite(left), n(*f.indent_left).map(math_round))
        && same(finite(right), n(*f.indent_right).map(math_round))
        && same(raw_first, n(*f.indent_first_line).map(math_round))
}

/// `s.replace(re, '')` for a regex anchored at one end, without the g flag
fn strip_first(re: &jscompat::JsRegex, s: &str) -> String {
    match re.exec(s) {
        Some(m) => format!("{}{}", &s[..m.start()], &s[m.end()..]),
        None => s.to_owned(),
    }
}

type LineKey = (Option<String>, Option<JsNum>, Option<JsNum>);

fn raw_p_bdr_unchanged(raw: Option<&str>, f: &ParaFormat) -> Result<bool, RegexLimit> {
    let mut raw_borders = String::new();
    let mut raw_lines: [LineKey; 4] = Default::default();
    let index = |ch: char| match ch {
        't' => 0,
        'b' => 1,
        'l' => 2,
        _ => 3,
    };
    if let Some(raw) = raw.filter(|r| !r.is_empty()) {
        let inner = strip_first(js_regex!(r"^<w:pBdr[^>]*>"), raw);
        let inner = strip_first(js_regex!(r"<\/w:pBdr>$"), &inner);
        let kids = split_xml_children(&inner)?;
        for (side, ch) in [("top", 't'), ("bottom", 'b'), ("left", 'l'), ("right", 'r')] {
            let tag = format!("w:{side}");
            let Some((_, el)) = kids.iter().find(|(name, _)| *name == tag) else {
                continue;
            };
            let el = Some(el.as_str());
            let val = raw_attr(el, "w:val");
            if val == Some("none") || val == Some("nil") {
                continue;
            }
            raw_borders.push(ch);
            let color = raw_attr(el, "w:color").filter(|c| !c.is_empty() && *c != "auto");
            let sz = parse_attr(el, "w:sz");
            let sz_pt = (sz.is_finite() && sz > 0.0).then(|| JsNum(sz / 8.0));
            let space = parse_attr(el, "w:space");
            let space_pt = (space.is_finite() && space > 0.0).then_some(JsNum(space));
            if color.is_some() || sz_pt.is_some() || space_pt.is_some() {
                raw_lines[index(ch)] = (color.map(str::to_owned), sz_pt, space_pt);
            }
        }
    }
    // [...new Set(s)].sort().join(''): code points, sorted as UTF-16 strings
    let norm = |s: Option<&str>| -> String {
        let mut seen: Vec<char> = Vec::new();
        for c in s.unwrap_or("").chars() {
            if !seen.contains(&c) {
                seen.push(c);
            }
        }
        seen.sort_by(|a, b| {
            let mut x = [0u16; 2];
            let mut y = [0u16; 2];
            a.encode_utf16(&mut x).cmp(&b.encode_utf16(&mut y))
        });
        seen.into_iter().collect()
    };
    if norm(Some(&raw_borders)) != norm(f.borders.as_deref()) {
        return Ok(false);
    }
    let model_lines: [LineKey; 4] = ['t', 'b', 'l', 'r'].map(|ch| {
        border_line(f, ch).map_or((None, None, None), |l| {
            (l.color.clone(), l.sz_pt, l.space_pt)
        })
    });
    // JSON.stringify of both: NaN prints as null
    Ok(serde_json::to_string(&raw_lines).ok() == serde_json::to_string(&model_lines).ok())
}

fn raw_tabs_unchanged(raw: Option<&str>, f: &ParaFormat) -> Result<bool, RegexLimit> {
    let stops = real_stops(f);
    let mut raw_stops: Vec<(f64, String, Option<String>)> = Vec::new();
    if let Some(raw) = raw.filter(|r| !r.is_empty()) {
        let inner = strip_first(js_regex!(r"^<w:tabs[^>]*>"), raw);
        let inner = strip_first(js_regex!(r"<\/w:tabs>$"), &inner);
        for (name, xml) in split_xml_children(&inner)? {
            if name != "w:tab" {
                continue;
            }
            let el = Some(xml.as_str());
            let pos = parse_attr(el, "w:pos");
            if !pos.is_finite() {
                continue;
            }
            let leader = raw_attr(el, "w:leader")
                .filter(|l| !l.is_empty() && *l != "none")
                .map(str::to_owned);
            raw_stops.push((
                pos,
                raw_attr(el, "w:val").unwrap_or("left").to_owned(),
                leader,
            ));
        }
    }
    if raw_stops.len() != stops.len() {
        return Ok(false);
    }
    Ok(raw_stops
        .iter()
        .zip(stops)
        .all(|((pos, val, leader), stop)| {
            *pos == stop.pos.0
                && val == stop.val.as_str()
                && leader.as_deref()
                    == stop
                        .leader
                        .as_ref()
                        .map(|l| l.as_str())
                        .filter(|l| *l != "none")
        }))
}

fn raw_frame_pr_unchanged(raw: Option<&str>, f: &ParaFormat) -> bool {
    if let Some(frame) = f.frame.as_ref() {
        return raw.is_some_and(|raw| raw == frame_pr_xml(frame));
    }
    let val = raw_attr(raw, "w:dropCap");
    let raw_dc = match val {
        Some(v @ ("drop" | "margin")) => {
            let lines = parse_int(raw_attr(raw, "w:lines").unwrap_or("3"), Radix::Ten);
            Some((
                v,
                if lines.is_nan() || lines == 0.0 {
                    3.0
                } else {
                    lines
                },
            ))
        }
        _ => None,
    };
    let model = f.drop_cap.as_ref();
    raw_dc.map(|d| d.0) == model.map(|d| d.r#type.as_str())
        && same(raw_dc.map(|d| d.1), model.map(|d| d.lines.0))
}

fn same_indent(a: &ParaFormat, b: &ParaFormat) -> bool {
    let norm = |v: Option<JsNum>| n(v).map(math_round);
    same(norm(*a.indent_left), norm(*b.indent_left))
        && same(norm(*a.indent_right), norm(*b.indent_right))
        && same(norm(*a.indent_first_line), norm(*b.indent_first_line))
}

fn char_indent_cancel_attrs(
    original: &CharIndents,
    format: Option<&ParaFormat>,
) -> Vec<&'static str> {
    let kept = format.and_then(|f| f.char_indents.as_ref());
    let k = |get: fn(&CharIndents) -> Option<JsNum>| num_truthy(kept.and_then(get));
    let mut out = Vec::new();
    if num_truthy(original.left) && !k(|c| c.left) {
        out.push("w:leftChars=\"0\"");
    }
    if num_truthy(original.right) && !k(|c| c.right) {
        out.push("w:rightChars=\"0\"");
    }
    if (num_truthy(original.hanging) || num_truthy(original.first_line))
        && !k(|c| c.hanging)
        && !k(|c| c.first_line)
    {
        out.push(if num_truthy(original.hanging) {
            "w:hangingChars=\"0\""
        } else {
            "w:firstLineChars=\"0\""
        });
    }
    out
}

fn ppr_group_unchanged(
    tag: &str,
    raw: Option<&str>,
    f: &ParaFormat,
    original: Option<&ParaFormat>,
) -> Result<bool, RegexLimit> {
    Ok(match tag {
        "w:pageBreakBefore" => raw_bool(raw) == (*f.page_break_before == Some(true)),
        "w:keepNext"
        | "w:keepLines"
        | "w:widowControl"
        | "w:suppressLineNumbers"
        | "w:contextualSpacing" => match flag(f, tag) {
            None => original.and_then(|o| flag(o, tag)).is_none(),
            Some(v) => raw.is_some() && raw_bool(raw) == v,
        },
        "w:bidi" => raw_bool(raw) == (*f.bidi == Some(true)),
        "w:jc" => {
            let val = raw_attr(raw, "w:val");
            let mut raw_align = val.filter(|v| !v.is_empty()).and_then(jc_to_align);
            if (*f.bidi == Some(true) || *f.bidi_inherited == Some(true))
                && (raw_align == Some("left") || raw_align == Some("right"))
            {
                raw_align = Some(if raw_align == Some("left") {
                    "right"
                } else {
                    "left"
                });
            }
            raw_align == f.align.as_ref().map(|a| a.as_str())
        }
        "w:spacing" => raw_spacing_unchanged(raw, f),
        "w:ind" => {
            if let Some(original) = original {
                if same_indent(original, f) {
                    return Ok(true);
                }
                if original.char_indents.is_some() {
                    return Ok(false);
                }
            }
            raw_ind_unchanged(raw, f)
        }
        "w:pBdr" => raw_p_bdr_unchanged(raw, f)?,
        "w:shd" => {
            let fill = raw_attr(raw, "w:fill").filter(|f| !f.is_empty() && *f != "auto");
            fill == f.shading_fill.as_deref()
        }
        "w:tabs" => raw_tabs_unchanged(raw, f)?,
        "w:framePr" => raw_frame_pr_unchanged(raw, f),
        "w:rPr" => {
            let m = raw
                .filter(|r| !r.is_empty())
                .and_then(|r| js_regex!(r#"<w:sz\b[^>]*w:val="(\d+)""#).exec(r));
            same(
                m.map(|m| parse_int(m.get(1).unwrap_or_default(), Radix::Ten)),
                n(*f.empty_run_size_half_points),
            )
        }
        _ => false,
    })
}

/// pPr groups a header/footer cell paragraph models, by the format fields that feed them
const CELL_PPR_GROUPS: [(&str, &[&str]); 4] = [
    ("w:jc", &["align"]),
    (
        "w:spacing",
        &[
            "spaceBefore",
            "spaceAfter",
            "lineSpacing",
            "lineRule",
            "lineRawTwips",
        ],
    ),
    ("w:ind", &["indentLeft", "indentFirstLine"]),
    ("w:tabs", &["tabStops"]),
];

type AttrGroup = (&'static [&'static str], &'static [&'static str]);

fn cell_modeled_attr_groups(tag: &str) -> &'static [AttrGroup] {
    match tag {
        "w:ind" => &[
            (
                &["w:left", "w:start", "w:leftChars", "w:startChars"],
                &["indentLeft"],
            ),
            (
                &[
                    "w:firstLine",
                    "w:hanging",
                    "w:firstLineChars",
                    "w:hangingChars",
                ],
                &["indentFirstLine"],
            ),
        ],
        _ => &[
            (
                &["w:before", "w:beforeLines", "w:beforeAutospacing"],
                &["spaceBefore"],
            ),
            (
                &["w:after", "w:afterLines", "w:afterAutospacing"],
                &["spaceAfter"],
            ),
            (
                &["w:line", "w:lineRule"],
                &["lineSpacing", "lineRule", "lineRawTwips"],
            ),
        ],
    }
}

/// `JSON.stringify(format[k] ?? null)` for the fields the cell groups read
fn field_json(format: Option<&ParaFormat>, key: &str) -> String {
    let json = |v: Result<String, serde_json::Error>| v.unwrap_or_default();
    let Some(f) = format else {
        return "null".to_owned();
    };
    match key {
        "align" => json(serde_json::to_string(&*f.align)),
        "spaceBefore" => json(serde_json::to_string(&*f.space_before)),
        "spaceAfter" => json(serde_json::to_string(&*f.space_after)),
        "lineSpacing" => json(serde_json::to_string(&*f.line_spacing)),
        "lineRule" => json(serde_json::to_string(&*f.line_rule)),
        "lineRawTwips" => json(serde_json::to_string(&*f.line_raw_twips)),
        "indentLeft" => json(serde_json::to_string(&*f.indent_left)),
        "indentFirstLine" => json(serde_json::to_string(&*f.indent_first_line)),
        _ => json(serde_json::to_string(&*f.tab_stops)),
    }
}

fn element_attrs(xml: &str) -> Vec<(String, String)> {
    js_regex!(r#"([\w:]+)="([^"]*)""#, "g")
        .find_iter(xml)
        .map(|m| {
            (
                m.get(1).unwrap_or_default().to_owned(),
                m.get(2).unwrap_or_default().to_owned(),
            )
        })
        .collect()
}

/// `s.replace(re, replacement)` without the g flag, a string replacement; `re` has no groups
fn replace_re(re: &jscompat::JsRegex, s: &str, replacement: &str) -> String {
    match re.exec(s) {
        Some(m) => {
            let rep = get_substitution(m.as_str(), s, m.start(), &[], replacement);
            format!("{}{rep}{}", &s[..m.start()], &s[m.end()..])
        }
        None => s.to_owned(),
    }
}

/// `s.replace(re, (_m, inner) => f(inner))` without the g flag
fn replace_re_with(re: &jscompat::JsRegex, s: &str, f: impl FnOnce(&str) -> String) -> String {
    match re.exec(s) {
        Some(m) => format!(
            "{}{}{}",
            &s[..m.start()],
            f(m.get(1).unwrap_or_default()),
            &s[m.end()..]
        ),
        None => s.to_owned(),
    }
}

fn merge_cell_element_attrs(
    p_pr: &str,
    tag: &str,
    fresh_el: Option<&str>,
    rebuilt: &[&str],
) -> Result<String, RegexLimit> {
    let el_re = match tag {
        "w:spacing" => js_regex!(r"<w:spacing(?:\s[^>]*)?/>"),
        "w:ind" => js_regex!(r"<w:ind(?:\s[^>]*)?/>"),
        _ => unreachable!("merge_cell_element_attrs reads w:spacing and w:ind"),
    };
    let raw_el = el_re.exec(p_pr).map(|m| m.as_str().to_owned());
    let fresh: Vec<(String, String)> = element_attrs(fresh_el.unwrap_or(""))
        .into_iter()
        .filter(|(n, _)| rebuilt.contains(&n.as_str()))
        .collect();
    let kept: Vec<(String, String)> = element_attrs(raw_el.as_deref().unwrap_or(""))
        .into_iter()
        .filter(|(n, _)| !rebuilt.contains(&n.as_str()) && !fresh.iter().any(|(f, _)| f == n))
        .collect();
    let attrs: Vec<String> = fresh
        .iter()
        .chain(kept.iter())
        .map(|(n, v)| format!("{n}=\"{v}\""))
        .collect();
    if attrs.is_empty() {
        return Ok(match raw_el {
            Some(raw_el) => replace_first_string(p_pr, &raw_el, ""),
            None => p_pr.to_owned(),
        });
    }
    let merged = format!("<{tag} {}/>", attrs.join(" "));
    if let Some(raw_el) = raw_el {
        return Ok(replace_first_string(p_pr, &raw_el, &merged));
    }
    let open = js_regex!(r"^<w:pPr(?: [^>]*)?>")
        .exec(p_pr)
        .map_or("<w:pPr>", |m| m.as_str());
    let inner = if p_pr.starts_with(open) {
        js_slice(
            p_pr,
            open.encode_utf16().count() as i64,
            p_pr.encode_utf16().count() as i64 - "</w:pPr>".len() as i64,
        )
    } else {
        String::new()
    };
    let kids = split_xml_children(&inner)?;
    let mut children: Vec<String> = kids.iter().map(|(_, xml)| xml.clone()).collect();
    let at = kids
        .iter()
        .position(|(name, _)| rank(name) > rank(tag))
        .unwrap_or(children.len());
    children.insert(at, merged);
    Ok(format!("{open}{}</w:pPr>", children.concat()))
}

/// Paragraph format edit inside a layout-table cell
pub fn merge_cell_para_format(
    raw_p_pr: &str,
    format: &ParaFormat,
    original: Option<&ParaFormat>,
) -> Result<String, RegexLimit> {
    let differs = |k: &str| field_json(Some(format), k) != field_json(original, k);
    let mut tags: Vec<&str> = CELL_PPR_GROUPS
        .iter()
        .filter(|(_, fields)| fields.iter().any(|k| differs(k)))
        .map(|(tag, _)| *tag)
        .collect();
    if tags.is_empty() {
        return Ok(raw_p_pr.to_owned());
    }
    let mut out = if raw_p_pr.is_empty() || js_regex!(r"^<w:pPr(?:\s[^>]*)?\/>$").test(raw_p_pr) {
        "<w:pPr></w:pPr>".to_owned()
    } else {
        raw_p_pr.to_owned()
    };
    if tags.contains(&"w:tabs") && real_stops(format).is_empty() {
        out = replace_re(
            js_regex!(r"<w:tabs>[\s\S]*?<\/w:tabs>|<w:tabs\/>"),
            &out,
            "",
        );
        tags.retain(|t| *t != "w:tabs");
    }
    let via_merge: Vec<String> = tags
        .iter()
        .filter(|t| **t == "w:jc" || **t == "w:tabs")
        .map(|t| (*t).to_owned())
        .collect();
    if !via_merge.is_empty() {
        out = merge_p_pr_format(&out, Some(format), None, Some(&via_merge))?;
        if out.is_empty() {
            out = "<w:pPr></w:pPr>".to_owned();
        }
    }
    let fresh = format_p_pr_children(Some(format));
    for tag in ["w:spacing", "w:ind"] {
        if !tags.contains(&tag) {
            continue;
        }
        let rebuilt: Vec<&str> = cell_modeled_attr_groups(tag)
            .iter()
            .filter(|(_, fields)| fields.iter().any(|k| differs(k)))
            .flat_map(|(attrs, _)| attrs.iter().copied())
            .collect();
        let fresh_el = fresh
            .iter()
            .find(|(name, _)| name == tag)
            .map(|(_, xml)| xml.as_str());
        out = merge_cell_element_attrs(&out, tag, fresh_el, &rebuilt)?;
    }
    Ok(if js_regex!(r"^<w:pPr(?: [^>]*)?><\/w:pPr>$").test(&out) {
        String::new()
    } else {
        out
    })
}

/// Merge format-model changes into an original <w:pPr> slice
pub fn merge_p_pr_format(
    raw_p_pr: &str,
    format: Option<&ParaFormat>,
    original: Option<&ParaFormat>,
    only_tags: Option<&[String]>,
) -> Result<String, RegexLimit> {
    let open = js_regex!(r"^<w:pPr(?: [^>]*)?>")
        .exec(raw_p_pr)
        .map(|m| m.as_str());
    let mut fresh = format_p_pr_children(format);
    let empty = ParaFormat::default();
    let f = format.unwrap_or(&empty);
    if let Some(original) = original
        && let Some(char_indents) = original.char_indents.as_ref()
        && !same_indent(original, f)
    {
        let cancel = char_indent_cancel_attrs(char_indents, format).join(" ");
        if !cancel.is_empty() {
            match fresh.iter().position(|(name, _)| name == "w:ind") {
                None => fresh.push(("w:ind".to_owned(), format!("<w:ind {cancel}/>"))),
                Some(at) => {
                    let xml = &fresh[at].1;
                    let xml = format!("{} {cancel}/>", &xml[..xml.len() - 2]);
                    fresh[at] = ("w:ind".to_owned(), xml);
                }
            }
        }
    }
    let Some(open) = open else {
        fresh.sort_by_key(|(name, _)| rank(name));
        if fresh.is_empty() {
            return Ok(String::new());
        }
        let joined: String = fresh.iter().map(|(_, xml)| xml.as_str()).collect();
        return Ok(format!("<w:pPr>{joined}</w:pPr>"));
    };
    let inner = js_slice(
        raw_p_pr,
        open.encode_utf16().count() as i64,
        raw_p_pr.encode_utf16().count() as i64 - "</w:pPr>".len() as i64,
    );
    let mut managed: Vec<&str> = FORMAT_MANAGED_TAGS.to_vec();
    let mut add = |tag: &'static str| {
        if !managed.contains(&tag) {
            managed.push(tag);
        }
    };
    if format.is_some_and(|f| f.tab_stops.is_some()) {
        add("w:tabs");
    }
    for tag in PPR_FLAG_TAGS {
        if format.and_then(|f| flag(f, tag)).is_some()
            || original.and_then(|o| flag(o, tag)).is_some()
        {
            add(tag);
        }
    }
    if format.is_some_and(|f| f.drop_cap.is_some() || f.frame.is_some()) {
        add("w:framePr");
    }
    if format.is_some_and(|f| f.text_direction.is_some()) {
        add("w:textDirection");
    }
    if format.is_some_and(|f| f.empty_run_size_half_points.is_some()) {
        add("w:rPr");
    }
    if let Some(only) = only_tags {
        managed.retain(|tag| only.iter().any(|o| o == tag));
    }
    let raw_children = split_xml_children(&inner)?;
    let raw_of = |tag: &str| {
        raw_children
            .iter()
            .find(|(name, _)| name == tag)
            .map(|(_, xml)| xml.as_str())
    };
    let mut rebuilt: Vec<&str> = Vec::new();
    for tag in managed {
        if !ppr_group_unchanged(tag, raw_of(tag), f, original)? {
            rebuilt.push(tag);
        }
    }
    let mut fresh_out: Vec<(String, String)> = fresh
        .into_iter()
        .filter(|(name, _)| rebuilt.contains(&name.as_str()))
        .collect();
    fresh_out.sort_by_key(|(name, _)| rank(name));
    let mut parts = String::new();
    let mut any = false;
    let mut fi = 0;
    let mut prev_rank = -1;
    for (name, xml) in raw_children
        .iter()
        .filter(|(name, _)| !rebuilt.contains(&name.as_str()))
    {
        let own = rank(name);
        let effective = if own == -1 {
            prev_rank
        } else {
            own.max(prev_rank)
        };
        while fi < fresh_out.len() && rank(&fresh_out[fi].0) < effective {
            parts.push_str(&fresh_out[fi].1);
            fi += 1;
        }
        parts.push_str(xml);
        any = true;
        prev_rank = effective;
    }
    while fi < fresh_out.len() {
        parts.push_str(&fresh_out[fi].1);
        fi += 1;
        any = true;
    }
    if !any {
        return Ok(String::new());
    }
    Ok(format!("{open}{parts}</w:pPr>"))
}

/// (live, tail): the pPr before its first `<w:pPrChange`, and the rest
fn split_change(raw: &str) -> (&str, &str) {
    match raw.find("<w:pPrChange") {
        Some(at) => (&raw[..at], &raw[at..]),
        None => (raw, ""),
    }
}

/// hex color of the paragraph mark (pPr/rPr w:color), ignoring the pPrChange history
pub fn para_mark_color(raw_p_pr: &str) -> Option<String> {
    let live = strip_p_pr_change(raw_p_pr);
    let r_pr = js_regex!(r"<w:rPr>([\s\S]*?)<\/w:rPr>")
        .exec(&live)
        .and_then(|m| m.get(1));
    let color = r_pr
        .filter(|r| !r.is_empty())
        .and_then(|r| js_regex!(r##"<w:color\b[^>]*\bw:val="#?([^"]+)""##).exec(r))
        .and_then(|m| m.get(1));
    color
        .filter(|c| !c.is_empty() && *c != "auto")
        .map(str::to_uppercase)
}

/// Drop the paragraph mark's w:color (pPr/rPr)
pub fn strip_para_mark_color(raw_p_pr: &str) -> String {
    let (live, tail) = split_change(raw_p_pr);
    let stripped = replace_re_with(js_regex!(r"<w:rPr>([\s\S]*?)<\/w:rPr>"), live, |inner| {
        let rest = replace_re(
            js_regex!(r"<w:color\b[^>]*(?:\/>|>[\s\S]*?<\/w:color>)"),
            inner,
            "",
        );
        if trim(&rest).is_empty() {
            String::new()
        } else {
            format!("<w:rPr>{rest}</w:rPr>")
        }
    });
    stripped + tail
}

/// w:del / w:ins marker for a paragraph mark the editor tracked
pub fn para_mark_revision_xml(
    kind: &str,
    record: Option<&str>,
    mint_id: &mut dyn FnMut() -> String,
) -> String {
    let Some(record) = record.filter(|r| !r.is_empty()) else {
        return String::new();
    };
    let Ok(info) = serde_json::from_str::<Value>(record) else {
        return String::new();
    };
    // property reads as JavaScript does them: null throws, a primitive has neither key
    let get = |key: &str| match &info {
        Value::Object(map) => Some(map.get(key)),
        Value::Null => None,
        _ => Some(None),
    };
    let Some(date) = get("date") else {
        return String::new();
    };
    let date = match date {
        Some(v) if value_truthy(v) => match v {
            Value::String(s) => format!(" w:date=\"{}\"", escape_xml_attr(s)),
            // escapeXmlAttr of a non-string throws
            _ => return String::new(),
        },
        _ => String::new(),
    };
    let id = mint_id();
    let author = match get("author").flatten() {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => escape_xml_attr(s),
        Some(_) => return String::new(),
    };
    format!("<w:{kind} w:id=\"{id}\" w:author=\"{author}\"{date}/>")
}

fn value_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// add a tracked paragraph-mark marker to raw pPr bytes
pub fn set_para_mark_revision(raw_p_pr: &str, marker_xml: &str) -> String {
    if marker_xml.is_empty() {
        return raw_p_pr.to_owned();
    }
    let (live, tail) = split_change(raw_p_pr);
    let mut live = live.to_owned();
    if live.is_empty() || js_regex!(r"^<w:pPr(?:\s[^>]*)?\/>$").test(&live) {
        live = "<w:pPr></w:pPr>".to_owned();
    }
    if live.contains("<w:rPr/>") {
        live = replace_re(
            js_regex!(r"<w:rPr\/>"),
            &live,
            &format!("<w:rPr>{marker_xml}</w:rPr>"),
        );
    } else if live.contains("<w:rPr>") {
        live = replace_first_string(&live, "<w:rPr>", &format!("<w:rPr>{marker_xml}"));
    } else {
        let r_pr = format!("<w:rPr>{marker_xml}</w:rPr>");
        if let Some(sect_at) = live.find("<w:sectPr") {
            live = format!("{}{r_pr}{}", &live[..sect_at], &live[sect_at..]);
        } else if let Some(body) = live.strip_suffix("</w:pPr>") {
            live = format!("{body}{r_pr}</w:pPr>");
        } else {
            live.push_str(&r_pr);
        }
    }
    live + tail
}

/// drop the paragraph mark's tracked w:del / w:ins record (pPr/rPr)
pub fn strip_para_mark_revision(raw_p_pr: &str, kind: &str) -> String {
    let (live, tail) = split_change(raw_p_pr);
    let marker = if kind == "del" {
        js_regex!(r"<w:(?:del|moveFrom)\b[^>]*/>")
    } else {
        js_regex!(r"<w:(?:ins|moveTo)\b[^>]*/>")
    };
    let stripped = replace_re_with(js_regex!(r"<w:rPr>([\s\S]*?)<\/w:rPr>"), live, |inner| {
        let rest = replace_re(marker, inner, "");
        if trim(&rest).is_empty() {
            String::new()
        } else {
            format!("<w:rPr>{rest}</w:rPr>")
        }
    });
    stripped + tail
}

/// Resolve the paragraph mark's tracked formatting change (pPr/rPr/rPrChange)
pub fn resolve_para_mark_r_pr_change(raw_p_pr: &str, mode: &str) -> String {
    let (live, tail) = split_change(raw_p_pr);
    let Some(open) = live.find("<w:rPr>") else {
        return raw_p_pr.to_owned();
    };
    let Some(record_at) = live[open..].find("<w:rPrChange").map(|i| i + open) else {
        return raw_p_pr.to_owned();
    };
    let self_closing = js_regex!(r"^<w:rPrChange\b[^>]*\/>")
        .exec(&live[record_at..])
        .map(|m| m.as_str().len());
    let close_tag = live[record_at..]
        .find("</w:rPrChange>")
        .map(|i| i + record_at);
    let record_end = match (self_closing, close_tag) {
        (Some(len), _) => record_at + len,
        (None, Some(close)) => close + "</w:rPrChange>".len(),
        (None, None) => return raw_p_pr.to_owned(),
    };
    let Some(close) = live[record_end..].find("</w:rPr>").map(|i| i + record_end) else {
        return raw_p_pr.to_owned();
    };
    let record = &live[record_at..record_end];
    let rest = format!(
        "{}{}",
        &live[open + "<w:rPr>".len()..record_at],
        &live[record_end..close]
    );
    let next = if mode == "reject" {
        let markers: String = js_regex!(r"<w:(?:ins|del|moveFrom|moveTo)\b[^>]*\/>", "g")
            .find_iter(&rest)
            .map(|m| m.as_str())
            .collect();
        let old = js_regex!(r"<w:rPr>([\s\S]*?)<\/w:rPr>")
            .exec(record)
            .and_then(|m| m.get(1))
            .unwrap_or("");
        format!("{markers}{old}")
    } else {
        rest
    };
    let r_pr = if trim(&next).is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{next}</w:rPr>")
    };
    format!(
        "{}{r_pr}{}{tail}",
        &live[..open],
        &live[close + "</w:rPr>".len()..]
    )
}

pub fn strip_p_pr_change(raw_p_pr: &str) -> String {
    // pPrChange nests a <w:pPr> inside it; a self-closing record is one element
    remove_elements(raw_p_pr, "w:pPrChange", Some(1))
}

/// The ParaFormat keys: an unchecked cast reads these and nothing else.
const PARA_FORMAT_KEYS: [&str; 45] = [
    "align",
    "lineSpacing",
    "lineRule",
    "lineRawTwips",
    "indentLeft",
    "indentRight",
    "indentFirstLine",
    "charIndents",
    "directCharIndents",
    "spaceBefore",
    "spaceAfter",
    "spaceBeforeAuto",
    "spaceAfterAuto",
    "pageBreakBefore",
    "keepNext",
    "keepLines",
    "suppressLineNumbers",
    "widowControl",
    "snapToGrid",
    "autoSpace",
    "autoSpaceDE",
    "autoSpaceDN",
    "wordWrap",
    "overflowPunct",
    "eastAsiaLang",
    "contextualSpacing",
    "shadingFill",
    "shadingDisplay",
    "shadingClear",
    "borders",
    "borderStyle",
    "borderLines",
    "borderReset",
    "borderPad",
    "tabStops",
    "dropCap",
    "frame",
    "frameBox",
    "textDirection",
    "bidi",
    "bidiInherited",
    "emptyRunSizeHalfPoints",
    "emptyRunFontFamily",
    "markSizeHalfPoints",
    "effective",
];

/// `String(v)` of a JSON value
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|i| match i {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `Number(v)` of a JSON value
fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => to_number(s),
        Some(array @ Value::Array(_)) => to_number(&js_string(array)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// Build a pPrChange child from the editor's JSON snapshot of the previous properties.
/// `Ok(None)` where the JSON does not parse; `Err` where the TypeScript throws.
pub(crate) fn revision_p_pr_change_xml(change_json: &str) -> Result<Option<String>, String> {
    let Ok(change) = serde_json::from_str::<Value>(change_json) else {
        return Ok(None);
    };
    let empty = serde_json::Map::new();
    let change_map = match &change {
        Value::Null => return Err("Cannot read properties of null (reading 'old')".to_owned()),
        Value::Object(map) => map,
        _ => &empty,
    };
    let old_value = match change_map.get("old") {
        None | Some(Value::Null) => Value::Object(serde_json::Map::new()),
        Some(v) => v.clone(),
    };
    let old_map = match &old_value {
        Value::Object(map) => map,
        _ => &empty,
    };
    let old_format = match old_map.get("format") {
        Some(f @ Value::Object(_)) if value_truthy(f) => f,
        Some(f @ Value::Array(_)) => f,
        _ => &old_value,
    };
    let mut children: Vec<(String, String)> = Vec::new();
    if let Some(style_id) = old_map.get("styleId").filter(|v| value_truthy(v)) {
        children.push((
            "w:pStyle".to_owned(),
            format!(
                "<w:pStyle w:val=\"{}\"/>",
                escape_xml_attr(&js_string(style_id))
            ),
        ));
    }
    if old_map.get("type") == Some(&Value::String("docListItem".to_owned()))
        && let Some(num_id) = old_map.get("numId").filter(|v| value_truthy(v))
    {
        let raw = js_number(old_map.get("ilvl"));
        let ilvl = math_min(
            math_max(if raw.is_nan() || raw == 0.0 { 0.0 } else { raw }, 0.0),
            8.0,
        );
        children.push((
            "w:numPr".to_owned(),
            format!(
                "<w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"{}\"/></w:numPr>",
                number_to_string(ilvl),
                escape_xml_attr(&js_string(num_id))
            ),
        ));
    }
    if let Value::Object(map) = old_format {
        let known: serde_json::Map<String, Value> = map
            .iter()
            .filter(|(k, _)| PARA_FORMAT_KEYS.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let format: ParaFormat = serde_json::from_value(Value::Object(known))
            .map_err(|error| format!("old format: {error}"))?;
        children.extend(format_p_pr_children(Some(&format)));
    }
    children.sort_by_key(|(name, _)| rank(name));
    let attr = |key: &str, fallback: &str| match change_map.get(key) {
        None | Some(Value::Null) => fallback.to_owned(),
        Some(v) => js_string(v),
    };
    let mut attrs = format!(
        " w:id=\"{}\" w:author=\"{}\"",
        escape_xml_attr(&attr("id", "0")),
        escape_xml_attr(&attr("author", ""))
    );
    if let Some(date) = change_map.get("date").filter(|v| value_truthy(v)) {
        attrs.push_str(&format!(
            " w:date=\"{}\"",
            escape_xml_attr(&js_string(date))
        ));
    }
    if let Some(utc) = change_map.get("dateUtc").filter(|v| value_truthy(v)) {
        attrs.push_str(&format!(
            " w16du:dateUtc=\"{}\"",
            escape_xml_attr(&js_string(utc))
        ));
    }
    let inner: String = children.iter().map(|(_, xml)| xml.as_str()).collect();
    Ok(Some(format!(
        "<w:pPrChange{attrs}><w:pPr>{inner}</w:pPr></w:pPrChange>"
    )))
}

/// Insert or replace the live paragraph-property revision in a raw pPr slice
pub fn set_p_pr_change(raw_p_pr: &str, change_json: &str) -> Result<String, String> {
    let Some(change) = revision_p_pr_change_xml(change_json)? else {
        return Ok(raw_p_pr.to_owned());
    };
    let clean = strip_p_pr_change(raw_p_pr);
    if clean.is_empty() || clean == "<w:pPr/>" {
        return Ok(format!("<w:pPr>{change}</w:pPr>"));
    }
    let Some(close) = clean.rfind("</w:pPr>") else {
        return Ok(format!("<w:pPr>{change}</w:pPr>"));
    };
    Ok(format!("{}{change}{}", &clean[..close], &clean[close..]))
}
