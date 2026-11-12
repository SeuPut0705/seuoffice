//! `text/props.ts`: formatting properties both ways, ODF property attributes
//! and the docx engine's own model (`ParaFormat`, the formatting fields of
//! `Run`).
//!
//! The engine model is the meeting point: ODF to OOXML builds engine models and
//! lets the engine write the OOXML; OOXML to ODF compares the edited model with
//! the model built from the original ODF style and writes back only the fields
//! that differ, as attribute overrides on a copy of the original style.
//! Comparisons go through `para_keys` / `text_keys`, which apply the same
//! rounding as the OOXML encoding, so an untouched value never reads as changed.

use docx_engine::model::{
    ParaAlign, ParaFormat, ParaFormatLineRule, Run, RunCaps, RunVertAlign, TabStop, TabStopLeader,
    TabStopVal,
};
use jscompat::{
    JsMap, JsNum, JsObject, Radix, js_regex, math_round, number_to_string, number_truthy,
    parse_int, trim,
};
use serde::{Deserialize, Serialize};

use crate::core::convert::unquote_family;

use super::units::{half_points_to_pt, length_to_twips, percent, twips, twips_to_cm, twips_to_pt};

/// `OdfAttrs`: decoded attributes of one property element, keyed by canonical name.
pub type OdfAttrs = JsObject<String>;

/// `AttrOverrides`: attribute overrides; a value sets, `None` (null) removes.
pub type AttrOverrides = JsObject<Option<String>>;

/// `TextFormat`: `Pick<Run, ...>` of the formatting fields this bridge maps; the
/// fields it never sets stay without a key.
pub type TextFormat = Run;

// ---------------------------------------------------------------------------
// Paragraph properties

/// `ALIGN_FROM_ODF[align]` for an own key; `None` where the table has none.
/// (A value naming an `Object.prototype` member, such as `constructor`, finds a
/// function in the TypeScript: see the report.)
fn align_from_odf(align: &str) -> Option<ParaAlign> {
    match align {
        "start" | "left" => Some(ParaAlign::Left),
        "end" | "right" => Some(ParaAlign::Right),
        "center" => Some(ParaAlign::Center),
        "justify" => Some(ParaAlign::Justify),
        _ => None,
    }
}

/// `hex`
fn hex(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    let m = js_regex!(r"^#?([0-9a-fA-F]{6})$").exec(trim(value))?;
    Some(m.get(1)?.to_uppercase())
}

/// `LEADER_FROM_ODF[style]` for an own key.
fn leader_from_odf(style: &str) -> Option<TabStopLeader> {
    match style {
        "dotted" | "dot" => Some(TabStopLeader::Dot),
        "dash" | "long-dash" | "dot-dash" | "dot-dot-dash" | "wave" => Some(TabStopLeader::Hyphen),
        "solid" => Some(TabStopLeader::Underscore),
        _ => None,
    }
}

/// `tabStopsFromOdf`: ODF tab stops (attribute maps) to engine tab stops;
/// positions become margin-relative twips.
pub fn tab_stops_from_odf(
    stops: Option<&[OdfAttrs]>,
    margin_left_twips: f64,
) -> Option<Vec<TabStop>> {
    let stops = stops.filter(|s| !s.is_empty())?;
    let mut out: Vec<TabStop> = Vec::new();
    for s in stops {
        let Some(pos) = length_to_twips(s.get("style:position").map(String::as_str)) else {
            continue;
        };
        let ty = s.get("style:type").map_or("left", String::as_str);
        let val = match ty {
            "right" => TabStopVal::Right,
            "center" => TabStopVal::Center,
            "char" => TabStopVal::Decimal,
            _ => TabStopVal::Left,
        };
        let mut leader = TabStopLeader::None;
        let style = s.get("style:leader-style").map(String::as_str);
        if let Some(style) = style.filter(|st| !st.is_empty() && *st != "none") {
            leader = leader_from_odf(style).unwrap_or(TabStopLeader::Dot);
        } else if style.is_none_or(str::is_empty) {
            if let Some(t) = s
                .get("style:leader-text")
                .map(String::as_str)
                .filter(|t| !t.is_empty())
            {
                leader = match t {
                    "." => TabStopLeader::Dot,
                    "-" => TabStopLeader::Hyphen,
                    "_" => TabStopLeader::Underscore,
                    _ => TabStopLeader::None,
                };
            }
        }
        out.push(TabStop {
            pos: JsNum(math_round(pos + margin_left_twips)),
            val,
            rel: None,
            leader: Some(leader),
            inherited: None,
        });
    }
    if out.is_empty() { None } else { Some(out) }
}

/// `paraFormatFromOdf`: `style:paragraph-properties` attributes (a style's own,
/// not inherited) to `ParaFormat`. `tab_stops` are the effective tab stops (ODF
/// replaces, never merges, a parent's list), `margin_left_twips` the effective
/// left margin they are relative to.
pub fn para_format_from_odf(
    pp: &OdfAttrs,
    tab_stops: Option<&[OdfAttrs]>,
    margin_left_twips: f64,
) -> ParaFormat {
    let attr = |name: &str| pp.get(name).map(String::as_str);
    let mut f = ParaFormat::default();
    let align = attr("fo:text-align");
    if let Some(mapped) = align.filter(|a| !a.is_empty()).and_then(align_from_odf) {
        f.align.set(mapped);
        if align == Some("justify") && attr("fo:text-align-last") == Some("justify") {
            f.align.set(ParaAlign::Distribute);
        }
    }
    if let Some(left) = twips(attr("fo:margin-left")) {
        f.indent_left.set(JsNum(left));
    }
    if let Some(right) = twips(attr("fo:margin-right")) {
        f.indent_right.set(JsNum(right));
    }
    if let Some(first) = twips(attr("fo:text-indent")) {
        f.indent_first_line.set(JsNum(first));
    }
    if let Some(before) = twips(attr("fo:margin-top")) {
        f.space_before.set(JsNum(before.max(0.0)));
    }
    if let Some(after) = twips(attr("fo:margin-bottom")) {
        f.space_after.set(JsNum(after.max(0.0)));
    }
    let lh = attr("fo:line-height");
    let lh_pct = percent(lh);
    let at_least = twips(attr("style:line-height-at-least"));
    if let Some(pct) = lh_pct.filter(|p| *p > 0.0) {
        f.line_spacing.set(JsNum(pct));
        f.line_rule.set(ParaFormatLineRule::Auto);
    } else if lh.is_some() && twips(lh).is_some_and(|t| t > 0.0) {
        f.line_rule.set(ParaFormatLineRule::Exact);
        f.line_raw_twips.assign(twips(lh).map(JsNum));
    } else if let Some(least) = at_least.filter(|a| *a > 0.0) {
        f.line_rule.set(ParaFormatLineRule::AtLeast);
        f.line_raw_twips.set(JsNum(least));
    }
    if attr("fo:keep-with-next") == Some("always") {
        f.keep_next.set(true);
    }
    if attr("fo:keep-together") == Some("always") {
        f.keep_lines.set(true);
    }
    if attr("fo:break-before") == Some("page") {
        f.page_break_before.set(true);
    }
    if let Some(bg) = hex(attr("fo:background-color")) {
        f.shading_fill.set(bg);
    }
    if let Some(tabs) = tab_stops_from_odf(tab_stops, margin_left_twips) {
        f.tab_stops.set(tabs);
    }
    f
}

/// `ParaKeys`: normalised comparison keys of the paragraph fields this bridge maps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParaKeys {
    pub align: Option<String>,
    pub indent_left: Option<JsNum>,
    pub indent_right: Option<JsNum>,
    pub indent_first_line: Option<JsNum>,
    pub space_before: Option<JsNum>,
    pub space_after: Option<JsNum>,
    /// `auto:<twips>` / `exact:<twips>` / `atLeast:<twips>`
    pub line: Option<String>,
    pub keep_next: bool,
    pub keep_lines: bool,
    pub page_break_before: bool,
    pub shading: Option<String>,
    /// `val:pos:leader;...` of the paragraph's own stops
    pub tabs: Option<String>,
}

/// `keyof ParaKeys`, in the order of the keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ParaKey {
    Align,
    IndentLeft,
    IndentRight,
    IndentFirstLine,
    SpaceBefore,
    SpaceAfter,
    Line,
    KeepNext,
    KeepLines,
    PageBreakBefore,
    Shading,
    Tabs,
}

/// `num`
fn num(n: Option<JsNum>) -> Option<JsNum> {
    n.filter(|n| n.0.is_finite())
        .map(|n| JsNum(math_round(n.0)))
}

/// `paraKeys`
pub fn para_keys(f: Option<&ParaFormat>) -> ParaKeys {
    let empty = ParaFormat::default();
    let fmt = f.unwrap_or(&empty);
    let mut line: Option<String> = None;
    let rule = *fmt.line_rule;
    let raw = fmt.line_raw_twips.map(|n| n.0);
    if matches!(
        rule,
        Some(ParaFormatLineRule::Exact | ParaFormatLineRule::AtLeast)
    ) && raw.is_some_and(number_truthy)
    {
        let name = if rule == Some(ParaFormatLineRule::Exact) {
            "exact"
        } else {
            "atLeast"
        };
        line = Some(format!(
            "{name}:{}",
            number_to_string(math_round(raw.unwrap_or(0.0)))
        ));
    } else if let Some(spacing) = fmt
        .line_spacing
        .map(|n| n.0)
        .filter(|s| number_truthy(*s) && *s > 0.0)
    {
        line = Some(format!(
            "auto:{}",
            number_to_string(math_round(spacing * 240.0))
        ));
    }
    let stops: Vec<&TabStop> = fmt
        .tab_stops
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|t| t.rel.is_none() && t.inherited.is_none())
        .collect();
    ParaKeys {
        align: fmt.align.map(|a| a.as_str().to_owned()),
        indent_left: num(*fmt.indent_left),
        indent_right: num(*fmt.indent_right),
        indent_first_line: num(*fmt.indent_first_line),
        // the engine never writes w:before="0", so an explicit 0 reads back as absent
        space_before: if fmt.space_before.is_some_and(|n| number_truthy(n.0)) {
            num(*fmt.space_before)
        } else {
            None
        },
        space_after: num(*fmt.space_after),
        line,
        keep_next: fmt.keep_next.unwrap_or(false),
        keep_lines: fmt.keep_lines.unwrap_or(false),
        page_break_before: fmt.page_break_before.unwrap_or(false),
        shading: fmt
            .shading_fill
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_uppercase),
        tabs: if stops.is_empty() {
            None
        } else {
            Some(
                stops
                    .iter()
                    .map(|t| {
                        format!(
                            "{}:{}:{}",
                            t.val.as_str(),
                            number_to_string(math_round(t.pos.0)),
                            t.leader.map_or("none", |l| l.as_str())
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(";"),
            )
        },
    }
}

/// `changedParaKeys`: keys whose edited value differs from the original. A
/// value the original had and the edited paragraph lacks was cleared in the
/// editor (null): an untouched paragraph never gets here, because the editor
/// writes its original pPr bytes back and the engine reads them as the same keys.
pub fn changed_para_keys(original: &ParaKeys, edited: &ParaKeys) -> Vec<ParaKey> {
    let mut out = Vec::new();
    if original.align != edited.align {
        out.push(ParaKey::Align);
    }
    if original.indent_left != edited.indent_left {
        out.push(ParaKey::IndentLeft);
    }
    if original.indent_right != edited.indent_right {
        out.push(ParaKey::IndentRight);
    }
    if original.indent_first_line != edited.indent_first_line {
        out.push(ParaKey::IndentFirstLine);
    }
    if original.space_before != edited.space_before {
        out.push(ParaKey::SpaceBefore);
    }
    if original.space_after != edited.space_after {
        out.push(ParaKey::SpaceAfter);
    }
    if original.line != edited.line {
        out.push(ParaKey::Line);
    }
    if original.keep_next != edited.keep_next {
        out.push(ParaKey::KeepNext);
    }
    if original.keep_lines != edited.keep_lines {
        out.push(ParaKey::KeepLines);
    }
    if original.page_break_before != edited.page_break_before {
        out.push(ParaKey::PageBreakBefore);
    }
    if original.shading != edited.shading {
        out.push(ParaKey::Shading);
    }
    if original.tabs != edited.tabs {
        out.push(ParaKey::Tabs);
    }
    out
}

/// `cm`: twips as centimetres, or null (remove) for a cleared value.
fn cm(value: Option<JsNum>) -> Option<String> {
    value.map(|v| twips_to_cm(v.0))
}

/// `ALIGN_TO_ODF[a]`
fn align_to_odf(a: ParaAlign) -> &'static str {
    match a {
        ParaAlign::Left => "start",
        ParaAlign::Right => "end",
        ParaAlign::Center => "center",
        ParaAlign::Justify | ParaAlign::Distribute => "justify",
    }
}

/// `tabStopsToOdf`: tab stops as the inner XML of `style:tab-stops` (positions
/// relative to `margin_left_twips`).
pub fn tab_stops_to_odf(stops: &[TabStop], margin_left_twips: f64) -> String {
    stops
        .iter()
        .filter(|t| t.rel.is_none() && t.inherited.is_none() && t.val != TabStopVal::Clear)
        .map(|t| {
            let ty = match t.val {
                TabStopVal::Right => "right",
                TabStopVal::Center => "center",
                TabStopVal::Decimal => "char",
                _ => "left",
            };
            let leader = match t.leader {
                Some(TabStopLeader::Dot | TabStopLeader::MiddleDot) => "dotted",
                Some(TabStopLeader::Hyphen) => "dash",
                Some(TabStopLeader::Underscore | TabStopLeader::Heavy) => "solid",
                _ => "none",
            };
            let ch = if ty == "char" { " style:char=\".\"" } else { "" };
            let leader_text = if leader == "none" {
                String::new()
            } else {
                format!(
                    " style:leader-text=\"{}\"",
                    if leader == "dotted" { "." } else if leader == "dash" { "-" } else { "_" }
                )
            };
            format!(
                "<style:tab-stop style:position=\"{}\" style:type=\"{ty}\"{ch} style:leader-style=\"{leader}\"{leader_text}/>",
                twips_to_cm(t.pos.0 - margin_left_twips)
            )
        })
        .collect()
}

/// `ParaOverrides`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParaOverrides {
    /// `style:paragraph-properties` attribute overrides
    pub attrs: AttrOverrides,
    /// new inner XML of `style:tab-stops`, or `None` to keep the list
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_stops: Option<String>,
}

/// `paraOverrides`: ODF overrides for the changed paragraph keys, taking the
/// values from the edited format. `margin_left_twips` is the effective left
/// margin after the edit (tab positions are relative to it).
pub fn para_overrides(
    keys: &[ParaKey],
    edited: &ParaFormat,
    margin_left_twips: f64,
    original: &ParaKeys,
) -> ParaOverrides {
    let mut attrs = AttrOverrides::new();
    let mut tab_stops: Option<String> = None;
    for key in keys {
        match key {
            // a cleared value removes the attribute: the paragraph then takes its
            // common style's value, as the docx paragraph takes its style's
            ParaKey::Align => {
                let a = *edited.align;
                attrs.set("fo:text-align", a.map(|a| align_to_odf(a).to_owned()));
                if a == Some(ParaAlign::Distribute) {
                    attrs.set("fo:text-align-last", Some("justify".to_owned()));
                } else if original.align.as_deref() == Some("distribute") {
                    attrs.set("fo:text-align-last", None);
                }
            }
            ParaKey::IndentLeft => attrs.set("fo:margin-left", cm(*edited.indent_left)),
            ParaKey::IndentRight => attrs.set("fo:margin-right", cm(*edited.indent_right)),
            ParaKey::IndentFirstLine => attrs.set("fo:text-indent", cm(*edited.indent_first_line)),
            ParaKey::SpaceBefore => {
                // the engine reads an absent w:before for 0
                attrs.set(
                    "fo:margin-top",
                    Some(twips_to_cm(edited.space_before.map_or(0.0, |n| n.0))),
                );
            }
            ParaKey::SpaceAfter => attrs.set("fo:margin-bottom", cm(*edited.space_after)),
            ParaKey::Line => {
                let rule = *edited.line_rule;
                let raw = edited.line_raw_twips.map(|n| n.0);
                if matches!(
                    rule,
                    Some(ParaFormatLineRule::Exact | ParaFormatLineRule::AtLeast)
                ) && raw.is_some_and(number_truthy)
                {
                    let raw = raw.unwrap_or(0.0);
                    if rule == Some(ParaFormatLineRule::Exact) {
                        attrs.set("fo:line-height", Some(twips_to_cm(raw)));
                        attrs.set("style:line-height-at-least", None);
                    } else {
                        attrs.set("style:line-height-at-least", Some(twips_to_cm(raw)));
                        attrs.set("fo:line-height", None);
                    }
                } else if let Some(spacing) = edited
                    .line_spacing
                    .map(|n| n.0)
                    .filter(|s| number_truthy(*s) && *s > 0.0)
                {
                    attrs.set(
                        "fo:line-height",
                        Some(format!(
                            "{}%",
                            number_to_string(math_round(spacing * 100.0))
                        )),
                    );
                    attrs.set("style:line-height-at-least", None);
                } else {
                    attrs.set("fo:line-height", None);
                    attrs.set("style:line-height-at-least", None);
                }
            }
            ParaKey::KeepNext => attrs.set(
                "fo:keep-with-next",
                Some(
                    if edited.keep_next.unwrap_or(false) {
                        "always"
                    } else {
                        "auto"
                    }
                    .to_owned(),
                ),
            ),
            ParaKey::KeepLines => attrs.set(
                "fo:keep-together",
                Some(
                    if edited.keep_lines.unwrap_or(false) {
                        "always"
                    } else {
                        "auto"
                    }
                    .to_owned(),
                ),
            ),
            ParaKey::PageBreakBefore => attrs.set(
                "fo:break-before",
                Some(
                    if edited.page_break_before.unwrap_or(false) {
                        "page"
                    } else {
                        "auto"
                    }
                    .to_owned(),
                ),
            ),
            ParaKey::Shading => attrs.set(
                "fo:background-color",
                edited
                    .shading_fill
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map(|s| format!("#{}", s.to_lowercase())),
            ),
            ParaKey::Tabs => {
                tab_stops = Some(tab_stops_to_odf(
                    edited.tab_stops.as_deref().unwrap_or(&[]),
                    margin_left_twips,
                ));
            }
        }
    }
    ParaOverrides { attrs, tab_stops }
}

// ---------------------------------------------------------------------------
// Text properties

/// `isBold`
fn is_bold(v: &str) -> bool {
    v == "bold" || (js_regex!(r"^\d+$").test(v) && parse_int(v, Radix::Ten) >= 600.0)
}

/// `textFormatFromOdf`: merged `style:text-properties` attributes to engine run
/// formatting. `font_faces` resolves `style:font-name*` through the part's
/// font-face declarations.
pub fn text_format_from_odf(tp: &OdfAttrs, font_faces: &JsMap<String>) -> TextFormat {
    let attr = |name: &str| tp.get(name).map(String::as_str);
    let mut f = TextFormat::default();
    let face = |name: Option<&str>, family: Option<&str>| -> Option<String> {
        if let Some(name) = name {
            return Some(
                font_faces
                    .get(name)
                    .cloned()
                    .unwrap_or_else(|| name.to_owned()),
            );
        }
        family.map(|family| unquote_family(family.split(',').next().unwrap_or("")))
    };
    let latin = face(attr("style:font-name"), attr("fo:font-family"));
    let ea = face(
        attr("style:font-name-asian"),
        attr("style:font-family-asian"),
    );
    let cs = face(
        attr("style:font-name-complex"),
        attr("style:font-family-complex"),
    );
    if let Some(latin) = latin.as_ref().filter(|s| !s.is_empty()) {
        f.font_ascii.set(latin.clone());
    }
    if let Some(ea) = ea.as_ref().filter(|s| !s.is_empty()) {
        f.east_asia_font.set(ea.clone());
    }
    if let Some(font) = ea.as_ref().or(latin.as_ref()).filter(|s| !s.is_empty()) {
        f.font.set(font.clone());
    }
    if let Some(cs) = cs.as_ref().filter(|s| !s.is_empty()) {
        f.font_cs.set(cs.clone());
    }
    let size = attr("fo:font-size").or(attr("style:font-size-asian"));
    if let Some(size) = size.filter(|s| !s.is_empty() && !s.ends_with('%')) {
        if let Some(t) = length_to_twips(Some(size)).filter(|t| *t > 0.0) {
            f.size_half_points.set(JsNum(math_round(t / 10.0).max(1.0)));
        }
    }
    let weight = attr("fo:font-weight").or(attr("style:font-weight-asian"));
    if let Some(weight) = weight {
        f.bold.set(is_bold(weight));
    }
    let style = attr("fo:font-style").or(attr("style:font-style-asian"));
    if let Some(style) = style {
        f.italic.set(style == "italic" || style == "oblique");
    }
    let u_style = attr("style:text-underline-style");
    let u_type = attr("style:text-underline-type");
    if u_style.is_some() || u_type.is_some() {
        f.underline
            .set(u_style.is_some_and(|s| s != "none") && u_type.is_none_or(|t| t != "none"));
    }
    let s_style = attr("style:text-line-through-style");
    let s_type = attr("style:text-line-through-type");
    if s_style.is_some() || s_type.is_some() {
        f.strike
            .set(s_style.is_some_and(|s| s != "none") && s_type.is_none_or(|t| t != "none"));
    }
    if let Some(color) = hex(attr("fo:color")) {
        f.color.set(color);
    }
    if let Some(ls) = attr("fo:letter-spacing") {
        let t = if ls == "normal" {
            Some(0.0)
        } else {
            twips(Some(ls))
        };
        if let Some(t) = t {
            f.char_spacing_twips.set(JsNum(t));
        }
    }
    let scale = percent(attr("style:text-scale"));
    if let Some(scale) = scale {
        if math_round(scale * 100.0) != 100.0 && scale > 0.0 {
            f.char_scale_pct.set(JsNum(math_round(scale * 100.0)));
        }
    }
    if let Some(bg) = hex(attr("fo:background-color")) {
        f.shading.set(bg);
    }
    if let Some(pos) = attr("style:text-position").filter(|p| !p.is_empty()) {
        let first = js_regex!(r"\s+")
            .split(trim(pos))
            .first()
            .copied()
            .unwrap_or("");
        if first == "super" {
            f.vert_align.set(RunVertAlign::Superscript);
        } else if first == "sub" {
            f.vert_align.set(RunVertAlign::Subscript);
        } else {
            let p = percent(Some(first));
            if p.is_some_and(|p| p > 0.0) {
                f.vert_align.set(RunVertAlign::Superscript);
            } else if p.is_some_and(|p| p < 0.0) {
                f.vert_align.set(RunVertAlign::Subscript);
            }
        }
    }
    if attr("fo:text-transform") == Some("uppercase") {
        f.caps.set(RunCaps::All);
    } else if attr("fo:font-variant") == Some("small-caps") {
        f.caps.set(RunCaps::Small);
    }
    f
}

/// `HIGHLIGHT_HEX`: hex values of the OOXML named highlight colours, in the
/// order the table lists them.
pub const HIGHLIGHT_HEX: [(&str, &str); 16] = [
    ("yellow", "FFFF00"),
    ("green", "00FF00"),
    ("cyan", "00FFFF"),
    ("magenta", "FF00FF"),
    ("blue", "0000FF"),
    ("red", "FF0000"),
    ("darkBlue", "000080"),
    ("darkCyan", "008080"),
    ("darkGreen", "008000"),
    ("darkMagenta", "800080"),
    ("darkRed", "800000"),
    ("darkYellow", "808000"),
    ("darkGray", "808080"),
    ("lightGray", "C0C0C0"),
    ("black", "000000"),
    ("white", "FFFFFF"),
];

/// `TextKeys`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextKeys {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub vert_align: Option<String>,
    pub caps: Option<String>,
    pub color: Option<String>,
    pub size: Option<JsNum>,
    pub font: Option<String>,
    pub font_ascii: Option<String>,
    pub font_cs: Option<String>,
    pub spacing: Option<JsNum>,
    pub scale: Option<JsNum>,
    pub background: Option<String>,
}

/// `keyof TextKeys`, in the order of the keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextKey {
    Bold,
    Italic,
    Underline,
    Strike,
    VertAlign,
    Caps,
    Color,
    Size,
    Font,
    FontAscii,
    FontCs,
    Spacing,
    Scale,
    Background,
}

/// `textKeys`
pub fn text_keys(f: Option<&TextFormat>) -> TextKeys {
    let empty = TextFormat::default();
    let r = f.unwrap_or(&empty);
    let highlight = r.highlight.as_deref().filter(|h| !h.is_empty());
    let background = if let Some(h) = highlight {
        HIGHLIGHT_HEX
            .iter()
            .find(|(name, _)| *name == h)
            .map(|(_, hex)| (*hex).to_owned())
    } else {
        r.shading
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_uppercase)
    };
    TextKeys {
        bold: r.bold.unwrap_or(false),
        italic: r.italic.unwrap_or(false),
        underline: r.underline.unwrap_or(false),
        strike: r.strike.unwrap_or(false),
        vert_align: r.vert_align.map(|v| v.as_str().to_owned()),
        caps: r
            .caps
            .filter(|c| *c != RunCaps::None)
            .map(|c| c.as_str().to_owned()),
        color: r
            .color
            .as_deref()
            .filter(|c| !c.is_empty() && *c != "auto")
            .map(str::to_uppercase),
        size: *r.size_half_points,
        font: (*r.east_asia_font).clone().or_else(|| (*r.font).clone()),
        font_ascii: (*r.font_ascii).clone(),
        font_cs: (*r.font_cs).clone(),
        spacing: r.char_spacing_twips.filter(|n| number_truthy(n.0)),
        scale: r
            .char_scale_pct
            .filter(|n| number_truthy(n.0) && n.0 != 100.0),
        background,
    }
}

/// `changedTextKeys`: text keys whose edited value differs from the original;
/// null in the edited keys = cleared.
pub fn changed_text_keys(original: &TextKeys, edited: &TextKeys) -> Vec<TextKey> {
    let mut out = Vec::new();
    if original.bold != edited.bold {
        out.push(TextKey::Bold);
    }
    if original.italic != edited.italic {
        out.push(TextKey::Italic);
    }
    if original.underline != edited.underline {
        out.push(TextKey::Underline);
    }
    if original.strike != edited.strike {
        out.push(TextKey::Strike);
    }
    if original.vert_align != edited.vert_align {
        out.push(TextKey::VertAlign);
    }
    if original.caps != edited.caps {
        out.push(TextKey::Caps);
    }
    if original.color != edited.color {
        out.push(TextKey::Color);
    }
    if original.size != edited.size {
        out.push(TextKey::Size);
    }
    if original.font != edited.font {
        out.push(TextKey::Font);
    }
    if original.font_ascii != edited.font_ascii {
        out.push(TextKey::FontAscii);
    }
    if original.font_cs != edited.font_cs {
        out.push(TextKey::FontCs);
    }
    if original.spacing != edited.spacing {
        out.push(TextKey::Spacing);
    }
    if original.scale != edited.scale {
        out.push(TextKey::Scale);
    }
    if original.background != edited.background {
        out.push(TextKey::Background);
    }
    out
}

/// `clearedToInherited`: the values to write for changed keys: the edited
/// value, or for a cleared one what the docx run then inherits from its
/// paragraph style chain (`inherited`; null there removes the attribute).
pub fn cleared_to_inherited(
    changed: &[TextKey],
    edited: &TextKeys,
    inherited: &TextKeys,
) -> TextKeys {
    let mut out = edited.clone();
    for key in changed {
        match key {
            // a boolean key is never null
            TextKey::Bold | TextKey::Italic | TextKey::Underline | TextKey::Strike => {}
            TextKey::VertAlign if edited.vert_align.is_none() => {
                out.vert_align.clone_from(&inherited.vert_align);
            }
            TextKey::Caps if edited.caps.is_none() => out.caps.clone_from(&inherited.caps),
            TextKey::Color if edited.color.is_none() => out.color.clone_from(&inherited.color),
            TextKey::Size if edited.size.is_none() => out.size = inherited.size,
            TextKey::Font if edited.font.is_none() => out.font.clone_from(&inherited.font),
            TextKey::FontAscii if edited.font_ascii.is_none() => {
                out.font_ascii.clone_from(&inherited.font_ascii);
            }
            TextKey::FontCs if edited.font_cs.is_none() => {
                out.font_cs.clone_from(&inherited.font_cs);
            }
            TextKey::Spacing if edited.spacing.is_none() => out.spacing = inherited.spacing,
            TextKey::Scale if edited.scale.is_none() => out.scale = inherited.scale,
            TextKey::Background if edited.background.is_none() => {
                out.background.clone_from(&inherited.background);
            }
            _ => {}
        }
    }
    out
}

/// `textOverrides`: ODF `style:text-properties` overrides for changed text
/// keys. `face` returns the `style:font-face` name to reference for a family
/// (declaring it if needed).
pub fn text_overrides(
    keys: &[TextKey],
    edited: &TextKeys,
    face: &mut dyn FnMut(&str) -> String,
) -> AttrOverrides {
    let mut o = AttrOverrides::new();
    // `trio`
    fn trio(o: &mut AttrOverrides, base: &str, value: Option<String>) {
        o.set(format!("fo:{base}"), value.clone());
        o.set(format!("style:{base}-asian"), value.clone());
        o.set(format!("style:{base}-complex"), value);
    }
    let some = |s: &str| Some(s.to_owned());
    for key in keys {
        match key {
            TextKey::Bold => trio(
                &mut o,
                "font-weight",
                some(if edited.bold { "bold" } else { "normal" }),
            ),
            TextKey::Italic => {
                trio(
                    &mut o,
                    "font-style",
                    some(if edited.italic { "italic" } else { "normal" }),
                );
            }
            TextKey::Underline => {
                o.set(
                    "style:text-underline-style",
                    some(if edited.underline { "solid" } else { "none" }),
                );
                o.set(
                    "style:text-underline-type",
                    some(if edited.underline { "single" } else { "none" }),
                );
                if edited.underline {
                    o.set("style:text-underline-width", some("auto"));
                    o.set("style:text-underline-color", some("font-color"));
                }
            }
            TextKey::Strike => {
                o.set(
                    "style:text-line-through-style",
                    some(if edited.strike { "solid" } else { "none" }),
                );
                o.set(
                    "style:text-line-through-type",
                    some(if edited.strike { "single" } else { "none" }),
                );
            }
            TextKey::VertAlign => {
                o.set(
                    "style:text-position",
                    some(match edited.vert_align.as_deref() {
                        Some("superscript") => "super 58%",
                        Some("subscript") => "sub 58%",
                        _ => "0% 100%",
                    }),
                );
            }
            TextKey::Caps => {
                o.set(
                    "fo:text-transform",
                    some(if edited.caps.as_deref() == Some("all") {
                        "uppercase"
                    } else {
                        "none"
                    }),
                );
                o.set(
                    "fo:font-variant",
                    some(if edited.caps.as_deref() == Some("small") {
                        "small-caps"
                    } else {
                        "normal"
                    }),
                );
            }
            TextKey::Color => {
                o.set(
                    "fo:color",
                    edited
                        .color
                        .as_deref()
                        .filter(|c| !c.is_empty())
                        .map(|c| format!("#{}", c.to_lowercase())),
                );
            }
            TextKey::Size => {
                let value = edited
                    .size
                    .filter(|s| number_truthy(s.0))
                    .map(|s| half_points_to_pt(s.0));
                trio(&mut o, "font-size", value);
            }
            TextKey::Font => {
                let font = edited.font.as_deref().filter(|f| !f.is_empty());
                o.set("style:font-name-asian", font.map(|f| face(f)));
                o.set("style:font-family-asian", font.map(quote_family));
            }
            TextKey::FontAscii => {
                let font = edited.font_ascii.as_deref().filter(|f| !f.is_empty());
                o.set("style:font-name", font.map(|f| face(f)));
                o.set("fo:font-family", font.map(quote_family));
            }
            TextKey::FontCs => {
                let font = edited.font_cs.as_deref().filter(|f| !f.is_empty());
                o.set("style:font-name-complex", font.map(|f| face(f)));
                o.set("style:font-family-complex", font.map(quote_family));
            }
            TextKey::Spacing => {
                o.set(
                    "fo:letter-spacing",
                    Some(twips_to_pt(edited.spacing.map_or(0.0, |n| n.0))),
                );
            }
            TextKey::Scale => {
                o.set(
                    "style:text-scale",
                    Some(format!(
                        "{}%",
                        number_to_string(edited.scale.map_or(100.0, |n| n.0))
                    )),
                );
            }
            TextKey::Background => {
                o.set(
                    "fo:background-color",
                    Some(
                        edited
                            .background
                            .as_deref()
                            .filter(|b| !b.is_empty())
                            .map_or_else(
                                || "transparent".to_owned(),
                                |b| format!("#{}", b.to_lowercase()),
                            ),
                    ),
                );
            }
        }
    }
    o
}

/// `quoteFamily`
pub fn quote_family(family: &str) -> String {
    if family.chars().any(jscompat::is_js_space) {
        format!("'{family}'")
    } else {
        family.to_owned()
    }
}
