//! style-upsert.ts: create or modify one style in `word/styles.xml`. An
//! existing definition is patched property by property: children the patch does
//! not name (link, uiPriority, rsid, tblPr, ...) keep their bytes, and
//! `w:spacing` / `w:ind` / `w:rFonts` keep the attributes the patch does not set.
//!
//! A property of a patch that may be `null` in the TypeScript is an
//! `Option<Option<T>>`: `None` is absent (keeps), `Some(None)` is null (clears).

use std::collections::HashSet;

use jscompat::{
    TryJsRegex, js_regex, math_round, number_to_string, prefix_utf16, regex_escape, try_js_regex,
};
use serde::{Deserialize, Deserializer, Serialize};

use super::thrown;
use crate::generate::props::PPR_CHILD_ORDER;
use crate::generate::rpr::RPR_CHILD_ORDER;
use crate::generate::{escape_xml_attr, split_xml_children};
use crate::model::{TabStop, TabStopLeader, TabStopVal};

/// A key that is absent, `null` or a value.
fn nullable<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `StyleRunProps`: run properties of a style definition; a present key sets,
/// null clears, absent keeps.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleRunProps {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strike: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caps: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub small_caps: Option<bool>,
    /// hex without '#'
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub color: Option<Option<String>>,
    /// `w:highlight` color name
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub highlight: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "jscompat::js_f64_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub size_half_points: Option<Option<f64>>,
    /// Latin face (`w:ascii` / `w:hAnsi`); theme font attributes are dropped so it takes effect
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub font: Option<Option<String>>,
    /// East Asian face (`w:eastAsia`)
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub east_asia_font: Option<Option<String>>,
}

/// `StyleParaProps`: paragraph properties of a style definition.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleParaProps {
    /// left, center, right or justify
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub align: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "jscompat::js_f64_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub space_before_twips: Option<Option<f64>>,
    #[serde(
        default,
        deserialize_with = "jscompat::js_f64_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub space_after_twips: Option<Option<f64>>,
    /// line spacing as a multiple (auto)
    #[serde(
        default,
        deserialize_with = "jscompat::js_f64_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub line_spacing: Option<Option<f64>>,
    #[serde(
        default,
        deserialize_with = "jscompat::js_f64_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub indent_left_twips: Option<Option<f64>>,
    #[serde(
        default,
        deserialize_with = "jscompat::js_f64_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub indent_right_twips: Option<Option<f64>>,
    /// positive = first-line indent, negative = hanging indent
    #[serde(
        default,
        deserialize_with = "jscompat::js_f64_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub first_line_twips: Option<Option<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_next: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_lines: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_break_before: Option<bool>,
    /// 1-9 (`w:outlineLvl` val + 1)
    #[serde(
        default,
        deserialize_with = "jscompat::js_f64_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub outline_level: Option<Option<f64>>,
    /// list level linked to the style (`w:numPr`); null removes it
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub num_pr: Option<Option<StyleNumPr>>,
    /// `w:tabs` of the style; [] or null removes the element
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub tab_stops: Option<Option<Vec<TabStop>>>,
}

/// `StyleParaProps.numPr`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleNumPr {
    pub num_id: String,
    pub ilvl: f64,
}

/// `StyleHeadingInfo`: what an existing style says about its heading level.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleHeadingInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub based_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_level: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_level_inherited: Option<bool>,
    /// own `w:outlineLvl` 9 (body text)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_outline_off: Option<bool>,
}

/// `StyleUpsert`
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleUpsert {
    pub style_id: String,
    /// paragraph, character or table; used when creating (default paragraph)
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    /// display name; defaults to the id when creating
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// null removes `w:basedOn`
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub based_on: Option<Option<String>>,
    /// style of the following paragraph; null removes `w:next`
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub next: Option<Option<String>>,
    /// `w:qFormat`; new styles default to true
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_format: Option<bool>,
    /// one of Word's built-in styles (by name): created without `w:customStyle`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r_pr: Option<StyleRunProps>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p_pr: Option<StyleParaProps>,
}

/// `DefaultFonts`: only the default font slots to patch.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultFonts {
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub font: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub east_asia_font: Option<Option<String>>,
}

/// `headingLevelByName`: parse-styles reads "heading N" names and HeadingN ids
/// as that level, before any `w:outlineLvl`.
fn heading_level_by_name(name: Option<&str>, style_id: &str) -> Option<f64> {
    let by_name = name
        .filter(|name| !name.is_empty())
        .and_then(|name| js_regex!(r"^heading\s*([1-9])$", "i").exec(name))
        .and_then(|found| found.get(1).map(str::to_owned));
    let digit = match by_name {
        Some(digit) => digit,
        None => js_regex!(r"^Heading([1-9])$")
            .exec(style_id)?
            .get(1)?
            .to_owned(),
    };
    digit.parse::<f64>().ok()
}

fn truthy_level(level: Option<f64>) -> bool {
    level.is_some_and(|level| level != 0.0 && !level.is_nan())
}

/// `pendingHeadingLevel`: the heading level a pending paragraph style resolves
/// to once saved, mirroring parse-styles on reopen: heading name or id, else its
/// own outline level (`null` or an existing `w:outlineLvl` 9 = body text), else
/// the nearest basedOn ancestor's.
pub fn pending_heading_level(
    style_id: &str,
    pending: &dyn Fn(&str) -> Option<StyleUpsert>,
    existing: &dyn Fn(&str) -> Option<StyleHeadingInfo>,
    seen: &mut HashSet<String>,
) -> Option<f64> {
    if !seen.insert(style_id.to_owned()) {
        return None;
    }
    let up = pending(style_id);
    let cur = existing(style_id);
    let Some(up) = up else {
        return cur.and_then(|cur| cur.heading_level);
    };
    let name = up
        .name
        .as_deref()
        .or_else(|| cur.as_ref().and_then(|cur| cur.name.as_deref()));
    if let Some(named) = heading_level_by_name(name, style_id) {
        return Some(named);
    }
    if let Some(outline) = up.p_pr.as_ref().and_then(|pp| pp.outline_level) {
        return outline;
    }
    if cur
        .as_ref()
        .is_some_and(|cur| cur.heading_outline_off == Some(true))
    {
        return None;
    }
    if let Some(cur) = &cur
        && (up.based_on.is_none()
            || (truthy_level(cur.heading_level) && cur.heading_level_inherited != Some(true)))
    {
        return cur.heading_level;
    }
    let parent: Option<String> = match &up.based_on {
        None => cur.as_ref().and_then(|cur| cur.based_on.clone()),
        Some(based_on) => based_on.clone(),
    };
    match parent {
        Some(parent) if !parent.is_empty() => {
            pending_heading_level(&parent, pending, existing, seen)
        }
        _ => None,
    }
}

/// `BUILT_IN_HEADING_SIZES`: half-point sizes of the built-in headings, as the blank template defines them.
fn built_in_heading_size(level: f64) -> f64 {
    match level as i32 {
        1 => 32.0,
        2 => 28.0,
        3 => 26.0,
        4 => 24.0,
        _ => 22.0,
    }
}

/// `builtInHeadingStyleUpsert`: Word's built-in "heading N" for a document that
/// defines none, the definition the blank template ships. The id is HeadingN:
/// parse-styles reads that id as the level even without the name.
pub fn built_in_heading_style_upsert(
    level: f64,
    default_paragraph_style_id: Option<&str>,
) -> StyleUpsert {
    let rounded = math_round(level);
    let rounded = if rounded == 0.0 || rounded.is_nan() {
        1.0
    } else {
        rounded
    };
    let lvl = rounded.clamp(1.0, 9.0);
    let lvl_text = number_to_string(lvl);
    let based = default_paragraph_style_id
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    StyleUpsert {
        style_id: format!("Heading{lvl_text}"),
        r#type: Some("paragraph".to_owned()),
        name: Some(format!("heading {lvl_text}")),
        based_on: based.clone().map(Some),
        next: based.map(Some),
        quick_format: Some(true),
        built_in: Some(true),
        p_pr: Some(StyleParaProps {
            keep_next: Some(true),
            space_before_twips: Some(Some(if lvl <= 2.0 { 240.0 } else { 160.0 })),
            space_after_twips: Some(Some(120.0)),
            outline_level: Some(Some(lvl)),
            ..StyleParaProps::default()
        }),
        r_pr: Some(StyleRunProps {
            bold: Some(true),
            size_half_points: Some(Some(built_in_heading_size(lvl))),
            ..StyleRunProps::default()
        }),
    }
}

/// `STYLE_CHILD_ORDER`
const STYLE_CHILD_ORDER: [&str; 22] = [
    "w:name",
    "w:aliases",
    "w:basedOn",
    "w:next",
    "w:link",
    "w:autoRedefine",
    "w:hidden",
    "w:uiPriority",
    "w:semiHidden",
    "w:unhideWhenUsed",
    "w:qFormat",
    "w:locked",
    "w:personal",
    "w:personalCompose",
    "w:personalReply",
    "w:rsid",
    "w:pPr",
    "w:rPr",
    "w:tblPr",
    "w:trPr",
    "w:tcPr",
    "w:tblStylePr",
];

/// `Attrs`: attributes in the order they were set; a key set again keeps its place.
#[derive(Debug, Clone, Default)]
struct Attrs(Vec<(String, String)>);

impl Attrs {
    fn set(&mut self, key: &str, value: String) {
        match self.0.iter_mut().find(|(name, _)| name == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key.to_owned(), value)),
        }
    }

    fn delete(&mut self, key: &str) {
        self.0.retain(|(name, _)| name != key);
    }
}

struct ParsedTag {
    attrs: Attrs,
    self_closing: bool,
}

/// `parseTag`
fn parse_tag(xml: &str) -> Result<ParsedTag, String> {
    let tag = try_js_regex!(
        r#"^<([A-Za-z0-9:._-]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>"#
    );
    let Some(found) = tag.try_exec(xml).map_err(thrown)? else {
        return Err(format!(
            "style-upsert: not an element: {}",
            prefix_utf16(xml, 40)
        ));
    };
    let mut attrs = Attrs::default();
    for attr in js_regex!(r#"([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#, "g")
        .find_iter(found.get(2).unwrap_or_default())
    {
        let value = match attr.get(2) {
            Some(value) => value.to_owned(),
            None => attr.get(3).unwrap_or_default().replace('"', "&quot;"),
        };
        attrs.set(attr.get(1).unwrap_or_default(), value);
    }
    Ok(ParsedTag {
        attrs,
        self_closing: found.get(3) == Some("/"),
    })
}

/// `tag`: an element written from its attributes, `inner` None for a self-closing one.
fn tag(name: &str, attrs: &Attrs, inner: Option<&str>) -> String {
    let attrs: String = attrs
        .0
        .iter()
        .map(|(key, value)| format!(" {key}=\"{value}\""))
        .collect();
    match inner {
        None => format!("<{name}{attrs}/>"),
        Some(inner) => format!("<{name}{attrs}>{inner}</{name}>"),
    }
}

/// `xml.slice(from, to)` with an end that may be -1 (not found): a negative end counts from the end.
fn slice_between(xml: &str, from: usize, to: Option<usize>) -> &str {
    let to = match to {
        Some(to) => to,
        None => match xml.char_indices().next_back() {
            Some((at, _)) => at,
            None => 0,
        },
    };
    xml.get(from..to).unwrap_or_default()
}

/// `innerOf`
fn inner_of(xml: &str) -> Result<&str, String> {
    if parse_tag(xml)?.self_closing {
        return Ok("");
    }
    let from = xml.find('>').map_or(0, |at| at + 1);
    Ok(slice_between(xml, from, xml.rfind("</")))
}

/// `Children`: an ordered child list with single-instance replace and remove.
struct Children {
    items: Vec<(String, String)>,
    order: &'static [&'static str],
}

impl Children {
    fn new(items: Vec<(String, String)>, order: &'static [&'static str]) -> Self {
        Self { items, order }
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.items
            .iter()
            .find(|(item, _)| item == name)
            .map(|(_, xml)| xml.as_str())
    }

    fn set(&mut self, name: &str, xml: Option<String>) {
        let at = self.items.iter().position(|(item, _)| item == name);
        match (xml, at) {
            (None, Some(at)) => {
                self.items.remove(at);
            }
            (None, None) => {}
            (Some(xml), Some(at)) => self.items[at] = (name.to_owned(), xml),
            (Some(xml), None) => self.items.push((name.to_owned(), xml)),
        }
    }

    /// A self-closing on/off element: true = present, false = `w:val="0"`.
    fn flag(&mut self, name: &str, on: Option<bool>) {
        let Some(on) = on else {
            return;
        };
        self.set(
            name,
            Some(if on {
                format!("<{name}/>")
            } else {
                format!("<{name} w:val=\"0\"/>")
            }),
        );
    }

    /// Merge attributes into a self-closing element; a None value removes it.
    fn attrs(&mut self, name: &str, patch: &[(&str, Option<String>)]) -> Result<(), String> {
        let mut attrs = match self.get(name) {
            Some(cur) => parse_tag(cur)?.attrs,
            None => Attrs::default(),
        };
        for (key, value) in patch {
            match value {
                None => attrs.delete(key),
                Some(value) => attrs.set(key, value.clone()),
            }
        }
        let xml = if attrs.0.is_empty() {
            None
        } else {
            Some(tag(name, &attrs, None))
        };
        self.set(name, xml);
        Ok(())
    }

    fn to_xml(&self) -> String {
        let rank = |name: &str| {
            self.order
                .iter()
                .position(|item| *item == name)
                .unwrap_or(self.order.len())
        };
        let mut sorted: Vec<&(String, String)> = self.items.iter().collect();
        sorted.sort_by_key(|(name, _)| rank(name));
        sorted.into_iter().map(|(_, xml)| xml.as_str()).collect()
    }

    fn size(&self) -> usize {
        self.items.len()
    }
}

/// `num`
fn num(n: f64) -> Result<String, String> {
    if !n.is_finite() {
        return Err(format!("Invalid numeric value: {}", number_to_string(n)));
    }
    Ok(number_to_string(math_round(n)))
}

/// `clampFontSizeHalfPoints`: Word's size range is 1..1638 pt (2..3276 half-points).
fn clamp_font_size_half_points(v: f64) -> f64 {
    if v.is_nan() {
        return 2.0;
    }
    math_round(v).clamp(2.0, 3276.0)
}

fn some_value(value: &Option<Option<String>>) -> Option<Option<&str>> {
    value.as_ref().map(|value| value.as_deref())
}

/// `patchRun`
fn patch_run(children: &mut Children, rp: &StyleRunProps) -> Result<(), String> {
    children.flag("w:b", rp.bold);
    children.flag("w:bCs", rp.bold);
    children.flag("w:i", rp.italic);
    children.flag("w:iCs", rp.italic);
    children.flag("w:strike", rp.strike);
    children.flag("w:caps", rp.caps);
    children.flag("w:smallCaps", rp.small_caps);
    if let Some(underline) = rp.underline {
        children.set(
            "w:u",
            Some(format!(
                "<w:u w:val=\"{}\"/>",
                if underline { "single" } else { "none" }
            )),
        );
    }
    if let Some(color) = some_value(&rp.color) {
        children.set(
            "w:color",
            color.map(|color| format!("<w:color w:val=\"{}\"/>", escape_xml_attr(color))),
        );
    }
    if let Some(highlight) = some_value(&rp.highlight) {
        children.set(
            "w:highlight",
            highlight.map(|highlight| {
                format!("<w:highlight w:val=\"{}\"/>", escape_xml_attr(highlight))
            }),
        );
    }
    if let Some(size) = rp.size_half_points {
        let sz = size.map(clamp_font_size_half_points).map(number_to_string);
        children.set(
            "w:sz",
            sz.as_ref().map(|sz| format!("<w:sz w:val=\"{sz}\"/>")),
        );
        children.set(
            "w:szCs",
            sz.as_ref().map(|sz| format!("<w:szCs w:val=\"{sz}\"/>")),
        );
    }
    let mut fonts: Vec<(&str, Option<String>)> = Vec::new();
    if let Some(font) = some_value(&rp.font) {
        let f = font.map(escape_xml_attr);
        fonts.push(("w:ascii", f.clone()));
        fonts.push(("w:hAnsi", f));
        fonts.push(("w:asciiTheme", None));
        fonts.push(("w:hAnsiTheme", None));
    }
    if let Some(east_asia) = some_value(&rp.east_asia_font) {
        fonts.push(("w:eastAsia", east_asia.map(escape_xml_attr)));
        fonts.push(("w:eastAsiaTheme", None));
    }
    if !fonts.is_empty() {
        children.attrs("w:rFonts", &fonts)?;
    }
    Ok(())
}

/// `tabXml`
fn tab_xml(ts: &TabStop) -> Result<String, String> {
    let val = match ts.val {
        TabStopVal::Left => "left",
        TabStopVal::Center => "center",
        TabStopVal::Right => "right",
        TabStopVal::Decimal => "decimal",
        TabStopVal::Bar => "bar",
        TabStopVal::Clear => "clear",
    };
    let mut xml = format!(
        "<w:tab w:val=\"{}\" w:pos=\"{}\"",
        escape_xml_attr(val),
        num(ts.pos.0)?
    );
    let leader = match ts.leader {
        None | Some(TabStopLeader::None) => None,
        Some(TabStopLeader::Dot) => Some("dot"),
        Some(TabStopLeader::Hyphen) => Some("hyphen"),
        Some(TabStopLeader::Underscore) => Some("underscore"),
        Some(TabStopLeader::Heavy) => Some("heavy"),
        Some(TabStopLeader::MiddleDot) => Some("middleDot"),
    };
    if let Some(leader) = leader {
        xml.push_str(&format!(" w:leader=\"{}\"", escape_xml_attr(leader)));
    }
    xml.push_str("/>");
    Ok(xml)
}

fn opt_num(value: Option<f64>) -> Result<Option<String>, String> {
    value.map(num).transpose()
}

/// `patchPara`
fn patch_para(children: &mut Children, pp: &StyleParaProps) -> Result<(), String> {
    if let Some(num_pr) = &pp.num_pr {
        children.set(
            "w:numPr",
            num_pr.as_ref().map(|num_pr| {
                format!(
                    "<w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"{}\"/></w:numPr>",
                    number_to_string(num_pr.ilvl),
                    num_pr.num_id
                )
            }),
        );
    }
    if let Some(align) = some_value(&pp.align) {
        children.set(
            "w:jc",
            align.map(|align| {
                format!(
                    "<w:jc w:val=\"{}\"/>",
                    if align == "justify" { "both" } else { align }
                )
            }),
        );
    }
    let mut spacing: Vec<(&str, Option<String>)> = Vec::new();
    if let Some(before) = pp.space_before_twips {
        spacing.push(("w:before", opt_num(before)?));
    }
    if let Some(after) = pp.space_after_twips {
        spacing.push(("w:after", opt_num(after)?));
    }
    if let Some(line) = pp.line_spacing {
        spacing.push(("w:line", opt_num(line.map(|line| line * 240.0))?));
        spacing.push(("w:lineRule", line.map(|_| "auto".to_owned())));
    }
    if !spacing.is_empty() {
        children.attrs("w:spacing", &spacing)?;
    }
    let mut ind: Vec<(&str, Option<String>)> = Vec::new();
    if let Some(left) = pp.indent_left_twips {
        ind.push(("w:left", opt_num(left)?));
        ind.push(("w:start", None));
    }
    if let Some(right) = pp.indent_right_twips {
        ind.push(("w:right", opt_num(right)?));
        ind.push(("w:end", None));
    }
    if let Some(first_line) = pp.first_line_twips {
        ind.push((
            "w:firstLine",
            match first_line {
                Some(v) if v > 0.0 => Some(num(v)?),
                _ => None,
            },
        ));
        ind.push((
            "w:hanging",
            match first_line {
                Some(v) if v < 0.0 => Some(num(-v)?),
                _ => None,
            },
        ));
    }
    if !ind.is_empty() {
        children.attrs("w:ind", &ind)?;
    }
    children.flag("w:keepNext", pp.keep_next);
    children.flag("w:keepLines", pp.keep_lines);
    children.flag("w:pageBreakBefore", pp.page_break_before);
    if let Some(outline) = pp.outline_level {
        children.set(
            "w:outlineLvl",
            match outline {
                None => None,
                Some(level) => Some(format!("<w:outlineLvl w:val=\"{}\"/>", num(level - 1.0)?)),
            },
        );
    }
    if let Some(tab_stops) = &pp.tab_stops {
        let stops = tab_stops.as_deref().unwrap_or_default();
        let xml = if stops.is_empty() {
            None
        } else {
            let tabs: Result<Vec<String>, String> = stops.iter().map(tab_xml).collect();
            Some(format!("<w:tabs>{}</w:tabs>", tabs?.concat()))
        };
        children.set("w:tabs", xml);
    }
    Ok(())
}

fn split_children(xml: &str) -> Result<Vec<(String, String)>, String> {
    split_xml_children(xml).map_err(thrown)
}

/// `mergeStyleXml`: the `w:style` element after applying `up` to `existing` (None = create).
pub fn merge_style_xml(existing: Option<&str>, up: &StyleUpsert) -> Result<String, String> {
    let creating = existing.is_none();
    let mut attrs = Attrs::default();
    let items = match existing {
        None => {
            attrs.set(
                "w:type",
                up.r#type.clone().unwrap_or_else(|| "paragraph".to_owned()),
            );
            attrs.set("w:styleId", escape_xml_attr(&up.style_id));
            if up.built_in != Some(true) {
                attrs.set("w:customStyle", "1".to_owned());
            }
            Vec::new()
        }
        Some(existing) => {
            attrs = parse_tag(existing)?.attrs;
            split_children(inner_of(existing)?)?
        }
    };
    let mut children = Children::new(items, &STYLE_CHILD_ORDER);
    let name = match &up.name {
        Some(name) => Some(name.as_str()),
        None if creating => Some(up.style_id.as_str()),
        None => None,
    };
    if let Some(name) = name {
        children.set(
            "w:name",
            Some(format!("<w:name w:val=\"{}\"/>", escape_xml_attr(name))),
        );
    }
    if let Some(based_on) = some_value(&up.based_on) {
        children.set(
            "w:basedOn",
            based_on.map(|id| format!("<w:basedOn w:val=\"{}\"/>", escape_xml_attr(id))),
        );
    }
    if let Some(next) = some_value(&up.next) {
        children.set(
            "w:next",
            next.map(|id| format!("<w:next w:val=\"{}\"/>", escape_xml_attr(id))),
        );
    }
    let quick = up.quick_format.or(creating.then_some(true));
    if let Some(quick) = quick {
        children.set("w:qFormat", quick.then(|| "<w:qFormat/>".to_owned()));
    }
    if let Some(pp) = &up.p_pr {
        let items = match children.get("w:pPr") {
            Some(cur) => split_children(inner_of(cur)?)?,
            None => Vec::new(),
        };
        let mut inner = Children::new(items, &PPR_CHILD_ORDER);
        patch_para(&mut inner, pp)?;
        let xml = (inner.size() > 0).then(|| format!("<w:pPr>{}</w:pPr>", inner.to_xml()));
        children.set("w:pPr", xml);
    }
    if let Some(rp) = &up.r_pr {
        let items = match children.get("w:rPr") {
            Some(cur) => split_children(inner_of(cur)?)?,
            None => Vec::new(),
        };
        let mut inner = Children::new(items, &RPR_CHILD_ORDER);
        patch_run(&mut inner, rp)?;
        let xml = (inner.size() > 0).then(|| format!("<w:rPr>{}</w:rPr>", inner.to_xml()));
        children.set("w:rPr", xml);
    }
    Ok(tag("w:style", &attrs, Some(&children.to_xml())))
}

/// `upsertStyleXml`: `up` applied to `word/styles.xml`; a new style goes before `</w:styles>`.
pub fn upsert_style_xml(xml: &str, up: &StyleUpsert) -> Result<String, String> {
    let escaped_id = regex_escape(&up.style_id);
    let existing = TryJsRegex::new(
        &format!(
            r#"<w:style\b[^>]*\bw:styleId=(["']){escaped_id}\1[^>]*(?:\/>|>[\s\S]*?<\/w:style>)"#
        ),
        "",
    )
    .map_err(thrown)?;
    let found = existing.try_exec(xml).map_err(thrown)?;
    let style_xml = merge_style_xml(found.as_ref().map(|found| found.as_str()), up)?;
    Ok(match found {
        Some(found) => format!(
            "{}{style_xml}{}",
            &xml[..found.start()],
            &xml[found.end()..]
        ),
        None => match xml.find("</w:styles>") {
            Some(at) => format!("{}{style_xml}{}", &xml[..at], &xml[at..]),
            None => xml.to_owned(),
        },
    })
}

/// `mergeDefaultFontsXml`: patch only the requested default font slots, preserving all other defaults.
pub fn merge_default_fonts_xml(xml: &str, fonts: &DefaultFonts) -> Result<String, String> {
    let styles_at = xml.find("<w:styles");
    // `indexOf` answering -1 makes both slices count from the end
    let (declaration, root) = match styles_at {
        Some(at) => (&xml[..at], &xml[at..]),
        None => match xml.char_indices().next_back() {
            Some((last, _)) => (&xml[..last], &xml[last..]),
            None => ("", ""),
        },
    };
    let mut styles = Children::new(
        split_children(inner_of(root)?)?,
        &["w:docDefaults", "w:latentStyles", "w:style"],
    );
    let mut defaults = Children::new(
        split_children(inner_of(
            styles.get("w:docDefaults").unwrap_or("<w:docDefaults/>"),
        )?)?,
        &["w:rPrDefault", "w:pPrDefault"],
    );
    let mut run_default = Children::new(
        split_children(inner_of(
            defaults.get("w:rPrDefault").unwrap_or("<w:rPrDefault/>"),
        )?)?,
        &["w:rPr"],
    );
    let mut run = Children::new(
        split_children(inner_of(run_default.get("w:rPr").unwrap_or("<w:rPr/>"))?)?,
        &RPR_CHILD_ORDER,
    );
    patch_run(
        &mut run,
        &StyleRunProps {
            font: fonts.font.clone(),
            east_asia_font: fonts.east_asia_font.clone(),
            ..StyleRunProps::default()
        },
    )?;
    run_default.set("w:rPr", Some(format!("<w:rPr>{}</w:rPr>", run.to_xml())));
    defaults.set(
        "w:rPrDefault",
        Some(format!(
            "<w:rPrDefault>{}</w:rPrDefault>",
            run_default.to_xml()
        )),
    );
    styles.set(
        "w:docDefaults",
        Some(format!(
            "<w:docDefaults>{}</w:docDefaults>",
            defaults.to_xml()
        )),
    );
    Ok(format!(
        "{declaration}{}",
        tag("w:styles", &parse_tag(root)?.attrs, Some(&styles.to_xml()))
    ))
}
