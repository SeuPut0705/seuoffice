//! styles.xml: paragraph, character and table style resolution
//! (packages/docx-engine/src/parse-styles.ts).

mod display;
mod headings;
mod model;

pub use headings::{HeadingStyles, heading_styles_of};

use std::collections::{HashMap, HashSet};

use jscompat::{JsNum, Radix, Slot, js_regex, parse_int, truthy};
use ooxml_pkg::Package;
use ooxml_xml::{XNode, parse_ordered};
use serde::{Deserialize, Serialize};

pub use model::{
    DocDefaults, NumPr, StyleDisplay, StyleInfo, TableCondFormat, TableParaSpacing,
    TableStyleDisplay, WholeTable,
};

use crate::props::{
    XML_PARSER_MAX_NESTED_TAGS, char_indents_of, ea_lang_default_font, indent_twips_of,
    merge_char_indents, para_border_sides_of, theme_lang_ea_slot_font, themed_r_fonts,
};
use crate::section::xml_flag_on;
use crate::theme::{ThemeColors, ThemeFonts};
use crate::xml_text::{color_from, line_twips_of, on_off_of, strip_hash};
use display::{style_display_of, table_style_display_of};
use model::{merge_table_display, run_keys_fill};

/// A JavaScript `Map` keyed by string: a later `set` on a key keeps its
/// first position, `delete` drops the entry.
struct JsMap<V>(Vec<(String, V)>);

impl<V> JsMap<V> {
    fn new() -> Self {
        JsMap(Vec::new())
    }

    fn get(&self, key: &str) -> Option<&V> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn set(&mut self, key: &str, value: V) {
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key.to_owned(), value)),
        }
    }

    fn delete(&mut self, key: &str) {
        self.0.retain(|(k, _)| k != key);
    }
}

/// Word probe 2026-09-04: a styles part with no w:pPrDefault element at all
/// lays paragraphs out with Word's built-in Normal spacing (after 8pt, and 1.15
/// for paragraphs without their own w:line), for every font and compat mode;
/// an empty `<w:pPrDefault/>` or any explicit spacing switches the built-in off.
fn built_in_para_defaults() -> DocDefaults {
    DocDefaults {
        space_after_twips: Slot::of(JsNum(160.0)),
        line_raw_twips: Slot::of(JsNum(276.0)),
        line_rule: Slot::of("auto".to_owned()),
        line_spacing: Slot::of(JsNum(1.15)),
        ..DocDefaults::default()
    }
}

/// Word probe 2026-09-12 (Word 365): a package with no styles part at all lays
/// its text out in Word's built-in Normal, Aptos 12pt on top of the spacing above.
fn built_in_doc_defaults() -> DocDefaults {
    let mut dd = DocDefaults {
        ascii_font: Slot::of("Aptos".to_owned()),
        size_half_points: Slot::of(JsNum(24.0)),
        ..DocDefaults::default()
    };
    dd.assign(&built_in_para_defaults());
    dd
}

/// Word probe 2026-10-20: settings.xml w:linkStyles with no w:attachedTemplate
/// swaps the package's docDefaults and its default styles for Normal.dotm's on
/// open. Stock Normal.dotm: 12pt, kern 2, after 8pt, line 278 auto.
const NORMAL_TEMPLATE_SPACE_AFTER_TWIPS: f64 = 160.0;
const NORMAL_TEMPLATE_LINE_RAW_TWIPS: f64 = 278.0;

fn normal_template_defaults() -> DocDefaults {
    DocDefaults {
        size_half_points: Slot::of(JsNum(24.0)),
        size_cs_half_points: Slot::of(JsNum(24.0)),
        kern_half_points: Slot::of(JsNum(2.0)),
        space_after_twips: Slot::of(JsNum(NORMAL_TEMPLATE_SPACE_AFTER_TWIPS)),
        line_raw_twips: Slot::of(JsNum(NORMAL_TEMPLATE_LINE_RAW_TWIPS)),
        line_rule: Slot::of("auto".to_owned()),
        line_spacing: Slot::of(JsNum(NORMAL_TEMPLATE_LINE_RAW_TWIPS / 240.0)),
        ..DocDefaults::default()
    }
}

/// `Err` where reading settings.xml throws.
fn links_normal_template(package: &Package) -> Result<bool, String> {
    let Some(xml) = package
        .text("word/settings.xml")
        .map_err(|e| e.to_string())?
    else {
        return Ok(false);
    };
    let flag = xml_flag_on(xml, "w:linkStyles").map_err(|e| e.to_string())?;
    Ok(flag && !js_regex!(r"<w:attachedTemplate\b").test(xml))
}

/// Word probe 2026-10-20: the swap keeps the template look for every
/// pPrDefault spacing value the package declared differently by writing that
/// value onto Normal itself, so it outranks a table style's w:pPr.
fn normal_template_overrides(dd: &DocDefaults) -> Option<StyleDisplay> {
    let mut own = StyleDisplay::default();
    if dd
        .space_after_twips
        .is_some_and(|after| after.0 != NORMAL_TEMPLATE_SPACE_AFTER_TWIPS)
    {
        own.space_after_twips
            .set(JsNum(NORMAL_TEMPLATE_SPACE_AFTER_TWIPS));
    }
    let same_line = *dd.line_raw_twips == Some(JsNum(NORMAL_TEMPLATE_LINE_RAW_TWIPS))
        && dd.line_rule.as_deref().unwrap_or("auto") == "auto";
    if dd.line_raw_twips.is_some() && !same_line {
        own.line_raw_twips
            .set(JsNum(NORMAL_TEMPLATE_LINE_RAW_TWIPS));
        own.line_rule.set("auto".to_owned());
        own.line_spacing
            .set(JsNum(NORMAL_TEMPLATE_LINE_RAW_TWIPS / 240.0));
    }
    (!own.has_no_key()).then_some(own)
}

/// `{ ...kept, ...NORMAL_TEMPLATE_DEFAULTS }`, `kept` being `dd` without the
/// keys the template drops.
fn apply_normal_template(mut dd: DocDefaults) -> DocDefaults {
    dd.space_before_twips.delete();
    dd.space_before_auto.delete();
    dd.space_after_auto.delete();
    dd.bold.delete();
    dd.italic.delete();
    dd.color.delete();
    dd.border_sides.delete();
    dd.indent_left_twips.delete();
    dd.indent_right_twips.delete();
    dd.indent_first_line_twips.delete();
    dd.widow_control.delete();
    dd.suppress_auto_hyphens.delete();
    dd.assign(&normal_template_defaults());
    dd
}

/// w:numPr as declared on one style (either child may be absent).
#[derive(Debug, Clone, Default)]
struct OwnNumPr {
    num_id: Option<String>,
    ilvl: Option<f64>,
}

/// Word inherits numId and ilvl through basedOn as separate properties: a
/// heading style may declare only w:ilvl and take the numId from its parent.
fn merge_num_pr(own: &OwnNumPr, parent: Option<&NumPr>) -> Option<NumPr> {
    if own.num_id.is_none() && parent == Some(&NumPr::None) {
        return Some(NumPr::None);
    }
    let inherited = match parent {
        Some(NumPr::Num { num_id, ilvl }) => Some((num_id, ilvl)),
        _ => None,
    };
    let num_id = own.num_id.as_ref().or(inherited.map(|(num_id, _)| num_id));
    if num_id.map(String::as_str) == Some("0") {
        return Some(NumPr::None);
    }
    let num_id = truthy(num_id.map(String::as_str))?;
    Some(NumPr::Num {
        num_id: num_id.to_owned(),
        ilvl: own
            .ilvl
            .map(JsNum)
            .or(inherited.map(|(_, ilvl)| *ilvl))
            .unwrap_or(JsNum(0.0)),
    })
}

/// `attrsOf(findChild(node, name) ?? {})[key]`
fn child_attr<'a>(node: &'a XNode, name: &str, key: &str) -> Option<&'a str> {
    node.find_child(name).and_then(|child| child.attr(key))
}

/// `parseInt(x, 10) || undefined`
fn int_or_undefined(text: &str) -> Option<JsNum> {
    let n = parse_int(text, Radix::Ten);
    (n != 0.0 && !n.is_nan()).then_some(JsNum(n))
}

/// `parseInt(x, 10) || 0`
fn int_or_zero(text: &str) -> JsNum {
    let n = parse_int(text, Radix::Ten);
    JsNum(if n.is_nan() { 0.0 } else { n })
}

pub struct ParsedStyles {
    /// `styles` of parseStyles: the Map entries in insertion order.
    pub styles: Vec<(String, StyleInfo)>,
    pub doc_defaults: Option<DocDefaults>,
}

impl ParsedStyles {
    fn degraded() -> Self {
        ParsedStyles {
            styles: Vec::new(),
            doc_defaults: Some(built_in_doc_defaults()),
        }
    }
}

/// The basedOn resolution state of parseStyles.
struct Resolver<'a> {
    styles: &'a mut [(String, StyleInfo)],
    index: &'a HashMap<String, usize>,
    based_on_ids: &'a JsMap<String>,
    own_num_prs: &'a JsMap<OwnNumPr>,
    resolved: HashSet<String>,
}

impl Resolver<'_> {
    /// Resolve basedOn chains: a style inherits every display prop it doesn't set itself.
    fn resolve(&mut self, style_id: &str, seen: &mut HashSet<String>) -> Option<usize> {
        let idx = *self.index.get(style_id)?;
        let parent_id = self.based_on_ids.get(style_id);
        let Some(parent_id) =
            parent_id.filter(|_| !self.resolved.contains(style_id) && !seen.contains(style_id))
        else {
            return Some(idx);
        };
        seen.insert(style_id.to_owned());
        let parent = self
            .resolve(parent_id, seen)
            .map(|parent| self.styles[parent].1.clone());
        self.resolved.insert(style_id.to_owned());
        let own_num_pr = self.own_num_prs.get(style_id);
        let info = &mut self.styles[idx].1;
        if let Some(parent_display) = parent.as_ref().and_then(|parent| parent.display.as_ref()) {
            let own = info.display.take();
            let mut merged = parent_display.clone();
            if let Some(own) = &own {
                merged.assign(own);
            }
            // w:ind character attributes layer per component: a child's
            // twips-only w:ind keeps the parent's *Chars, a child's explicit zero cancels it
            if let (Some(parent_chars), Some(own_chars)) = (
                &*parent_display.indent_chars,
                own.as_ref().and_then(|own| own.indent_chars.as_ref()),
            ) {
                merged.indent_chars.assign(merge_char_indents(
                    Some(parent_chars.clone()),
                    Some(own_chars.clone()),
                ));
            }
            // pBdr merges per side too: a child's explicit none cancels one parent side only
            if let (Some(parent_sides), Some(own_sides)) = (
                &*parent_display.border_sides,
                own.as_ref().and_then(|own| own.border_sides.as_ref()),
            ) {
                let mut sides = parent_sides.clone();
                sides.assign(own_sides);
                merged.border_sides.set(sides);
            }
            // w:tabs merge per position: a child stop (or w:val="clear") replaces
            // the parent's stop at that position, the rest of the parent's stops stay
            if let (Some(parent_stops), Some(own_stops)) = (
                &*parent_display.tab_stops,
                own.as_ref().and_then(|own| own.tab_stops.as_ref()),
            ) {
                let mut stops: Vec<_> = parent_stops
                    .iter()
                    .filter(|p| !own_stops.iter().any(|o| o.pos == p.pos))
                    .chain(own_stops.iter().filter(|o| o.val != "clear"))
                    .cloned()
                    .collect();
                // positions are finite, so the comparator is total
                stops.sort_by(|a, b| a.pos.0.total_cmp(&b.pos.0));
                if stops.is_empty() {
                    merged.tab_stops.delete();
                } else {
                    merged.tab_stops.set(stops);
                }
            }
            info.display = (!merged.has_no_key()).then_some(merged);
        }
        if let Some(parent_table) = parent
            .as_ref()
            .and_then(|parent| parent.table_display.as_ref())
        {
            info.table_display = merge_table_display(parent_table, info.table_display.as_ref());
        }
        if info.kind == "paragraph"
            && info.heading_level.is_none()
            && info.heading_outline_off != Some(true)
            && let Some(level) = parent
                .as_ref()
                .and_then(|parent| parent.heading_level)
                .filter(|level| level.0 != 0.0 && !level.0.is_nan())
        {
            info.heading_level = Some(level);
            info.heading_level_inherited = Some(true);
        }
        let parent_num_pr = parent.as_ref().and_then(|parent| parent.num_pr.as_ref());
        if info.kind == "paragraph" && (own_num_pr.is_some() || parent_num_pr.is_some()) {
            info.num_pr = merge_num_pr(&own_num_pr.cloned().unwrap_or_default(), parent_num_pr);
        }
        Some(idx)
    }
}

/// `parseStyles(zip, theme, themeFonts)`. `Err` where the TypeScript throws.
pub fn parse_styles(
    package: &Package,
    theme: Option<&ThemeColors>,
    theme_fonts: Option<&ThemeFonts>,
) -> Result<ParsedStyles, String> {
    // the TypeScript reads the part inside its try: a damaged part degrades too
    let xml = match package.text("word/styles.xml") {
        Ok(Some(xml)) => xml,
        Ok(None) => return Ok(ParsedStyles::degraded()),
        Err(error) => {
            crate::warnings::warn(format!(
                "styles.xml unparseable, styles degraded to empty: {error}"
            ));
            return Ok(ParsedStyles::degraded());
        }
    };
    let parsed = match parse_ordered(xml, XML_PARSER_MAX_NESTED_TAGS) {
        Ok(parsed) => parsed,
        Err(error) => {
            crate::warnings::warn(format!(
                "styles.xml unparseable, styles degraded to empty: {error}"
            ));
            return Ok(ParsedStyles::degraded());
        }
    };
    let Some(root) = parsed.iter().find(|node| node.name() == Some("w:styles")) else {
        return Ok(ParsedStyles::degraded());
    };
    let empty = XNode::empty();

    let mut doc_defaults: Option<DocDefaults>;
    let mut declared_p_pr_default = false;
    let defaults_node = root.find_child("w:docDefaults");
    if let Some(defaults_node) = defaults_node {
        let mut dd = DocDefaults::default();
        let r_pr = defaults_node
            .find_child("w:rPrDefault")
            .and_then(|r_pr_default| r_pr_default.find_child("w:rPr"));
        let sz = r_pr.and_then(|r_pr| child_attr(r_pr, "w:sz", "w:val"));
        if let Some(sz) = truthy(sz) {
            dd.size_half_points.assign(int_or_undefined(sz));
        }
        let sz_cs = r_pr.and_then(|r_pr| child_attr(r_pr, "w:szCs", "w:val"));
        if let Some(sz_cs) = truthy(sz_cs) {
            dd.size_cs_half_points.assign(int_or_undefined(sz_cs));
        }
        let rf_attrs = r_pr
            .and_then(|r_pr| r_pr.find_child("w:rFonts"))
            .unwrap_or(&empty);
        let dd_rf = themed_r_fonts(rf_attrs, theme_fonts);
        if let Some(ascii) = truthy(dd_rf.ascii.as_deref().or(dd_rf.h_ansi.as_deref())) {
            dd.ascii_font.set(ascii.to_owned());
        }
        // no Latin slot at all and no theme to take it from (docx-npm output):
        // Word falls back to its legacy Times New Roman, not the Office theme body face
        else if truthy(theme_fonts.map(|fonts| fonts.minor.as_str())).is_none()
            && truthy(rf_attrs.attr("w:asciiTheme")).is_none()
            && truthy(rf_attrs.attr("w:hAnsiTheme")).is_none()
        {
            dd.ascii_font.set("Times New Roman".to_owned());
            if truthy(sz).is_none() {
                dd.size_half_points.set(JsNum(20.0));
            }
        }
        // docDefaults keeps the lang-based backfill below for the empty-slot case
        if let Some(east_asia) = truthy(dd_rf.east_asia.as_deref()).filter(|_| !dd_rf.ea_slot_empty)
        {
            dd.east_asia_font.set(east_asia.to_owned());
        }
        if truthy(rf_attrs.attr("w:eastAsiaTheme")).is_some() {
            dd.ea_theme_slot.set(true);
        }
        if let Some(cs) = truthy(dd_rf.cs.as_deref()) {
            dd.cs_font.set(cs.to_owned());
        }
        // Empty EA slot + w:lang w:eastAsia backfill: when the backfill would
        // fire, a face settings.xml themeFontLang resolves outranks the
        // often-stale docDefaults w:lang. Without a firing backfill the slot
        // stays empty: themeFontLang alone must not invent a doc-level EA face.
        let ea_lang = r_pr.and_then(|r_pr| child_attr(r_pr, "w:lang", "w:eastAsia"));
        if let Some(ea_lang) = truthy(ea_lang) {
            dd.east_asia_lang.set(ea_lang.to_owned());
        }
        if let (None, Some(ea_lang)) = (&*dd.east_asia_font, truthy(ea_lang))
            && let Some(ea_default) = ea_lang_default_font(&ea_lang.to_lowercase())
        {
            let dd_ea_theme = match theme_fonts {
                Some(fonts) if dd_rf.ea_slot_empty => theme_lang_ea_slot_font(
                    fonts,
                    r_pr.and_then(|r_pr| child_attr(r_pr, "w:rFonts", "w:eastAsiaTheme")),
                ),
                _ => None,
            };
            dd.east_asia_font
                .set(dd_ea_theme.unwrap_or_else(|| ea_default.to_owned()));
            dd.ea_from_lang.set(true);
            if dd_rf.ea_slot_empty {
                dd.ea_slot_empty.set(true);
            }
        }
        if let Some(r_pr) = r_pr {
            if on_off_of(r_pr, "w:b") == Some(true) {
                dd.bold.set(true);
            }
            if on_off_of(r_pr, "w:i") == Some(true) {
                dd.italic.set(true);
            }
            if on_off_of(r_pr, "w:bCs") == Some(true) {
                dd.bold_cs.set(true);
            }
            if on_off_of(r_pr, "w:iCs") == Some(true) {
                dd.italic_cs.set(true);
            }
            let color = color_from(Some(r_pr), theme).filter(|color| !color.is_empty());
            dd.color.set_some(color);
            let kern = child_attr(r_pr, "w:kern", "w:val");
            if let Some(kern) = kern {
                dd.kern_half_points.set(int_or_zero(kern));
            }
            let lang = child_attr(r_pr, "w:lang", "w:val");
            if let Some(lang) = truthy(lang) {
                dd.lang.set(lang.to_owned());
            }
            if on_off_of(r_pr, "w:rtl") == Some(true) {
                dd.rtl.set(true);
            }
        }
        let p_pr_default = defaults_node.find_child("w:pPrDefault");
        if p_pr_default.is_none() {
            dd.assign(&built_in_para_defaults());
        } else {
            declared_p_pr_default = true;
        }
        let p_pr = p_pr_default.and_then(|p_pr_default| p_pr_default.find_child("w:pPr"));
        let spacing = p_pr.and_then(|p_pr| p_pr.find_child("w:spacing"));
        let spacing_attr = |key| spacing.and_then(|spacing| spacing.attr(key));
        if let Some(line) = truthy(spacing_attr("w:line")) {
            let line = line_twips_of(Some(line));
            let rule = spacing_attr("w:lineRule").unwrap_or("auto");
            if line > 0.0 {
                dd.line_raw_twips.set(JsNum(line));
                dd.line_rule.set(rule.to_owned());
                if rule == "auto" {
                    dd.line_spacing.set(JsNum(line / 240.0));
                }
            }
        }
        if let Some(before) = spacing_attr("w:before") {
            dd.space_before_twips.set(int_or_zero(before));
        }
        if let Some(after) = spacing_attr("w:after") {
            dd.space_after_twips.set(int_or_zero(after));
        }
        if let Some(auto) = spacing_attr("w:beforeAutospacing") {
            dd.space_before_auto.set(auto == "1" || auto == "true");
        }
        if let Some(auto) = spacing_attr("w:afterAutospacing") {
            dd.space_after_auto.set(auto == "1" || auto == "true");
        }
        if p_pr.is_some_and(|p_pr| on_off_of(p_pr, "w:suppressAutoHyphens") == Some(true)) {
            dd.suppress_auto_hyphens.set(true);
        }
        if p_pr.is_some_and(|p_pr| on_off_of(p_pr, "w:bidi") == Some(true)) {
            dd.bidi.set(true);
        }
        if p_pr.is_some_and(|p_pr| on_off_of(p_pr, "w:widowControl") == Some(false)) {
            dd.widow_control.set(false);
        }
        let dd_borders = p_pr.and_then(|p_pr| para_border_sides_of(p_pr, theme));
        dd.border_sides.set_some(dd_borders);
        let dd_ind = p_pr.and_then(|p_pr| p_pr.find_child("w:ind"));
        if let Some(dd_ind) = dd_ind {
            let indent = indent_twips_of(dd_ind);
            dd.indent_left_twips.set_some(indent.left);
            dd.indent_right_twips.set_some(indent.right);
            dd.indent_first_line_twips.set_some(indent.first_line);
            dd.indent_chars.set_some(char_indents_of(Some(dd_ind)));
        }
        doc_defaults = (!dd.has_no_key()).then_some(dd);
    } else {
        doc_defaults = Some(built_in_para_defaults());
    }
    let linked_template = links_normal_template(package)?;
    // only values the package wrote itself count; the built-in fallback above is not a declaration
    let normal_overrides = if linked_template && declared_p_pr_default {
        normal_template_overrides(&doc_defaults.clone().unwrap_or_default())
    } else {
        None
    };
    if linked_template {
        doc_defaults = Some(apply_normal_template(doc_defaults.unwrap_or_default()));
    }

    let mut styles: Vec<(String, StyleInfo)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut based_on_ids: JsMap<String> = JsMap::new();
    let mut own_num_prs: JsMap<OwnNumPr> = JsMap::new();
    let mut linked_ids: JsMap<String> = JsMap::new();
    // styles with an explicit w:outlineLvl 9 (body text, e.g. TOCHeading basedOn Heading1)
    let mut outline_off_ids: HashSet<String> = HashSet::new();
    for style_node in root.find_children("w:style") {
        let kind = match style_node.attr("w:type") {
            Some("paragraph") => "paragraph",
            Some("character") => "character",
            Some("table") => "table",
            _ => continue,
        };
        let Some(style_id) = truthy(style_node.attr("w:styleId")) else {
            continue;
        };
        let name = child_attr(style_node, "w:name", "w:val").unwrap_or(style_id);
        let mut heading_level = None;
        if kind == "paragraph" {
            let name_match = js_regex!(r"^heading\s*([1-9])$", "i")
                .exec(name)
                .or_else(|| js_regex!(r"^Heading([1-9])$").exec(style_id));
            if let Some(name_match) = name_match {
                heading_level = Some(JsNum(parse_int(
                    name_match.get(1).unwrap_or(""),
                    Radix::Ten,
                )));
            } else {
                let p_pr = style_node.find_child("w:pPr");
                let outline = p_pr.and_then(|p_pr| child_attr(p_pr, "w:outlineLvl", "w:val"));
                if let Some(outline) = outline {
                    let lvl = parse_int(outline, Radix::Ten);
                    if (0.0..=8.0).contains(&lvl) {
                        heading_level = Some(JsNum(lvl + 1.0));
                    } else {
                        outline_off_ids.insert(style_id.to_owned());
                    }
                }
            }
        }
        let based_on = truthy(child_attr(style_node, "w:basedOn", "w:val"));
        if let Some(based_on) = based_on {
            based_on_ids.set(style_id, based_on.to_owned());
        }
        let link = truthy(child_attr(style_node, "w:link", "w:val"));
        if let Some(link) = link {
            linked_ids.set(style_id, link.to_owned());
        }
        let ui_priority_raw = child_attr(style_node, "w:uiPriority", "w:val");
        let ui_priority = ui_priority_raw
            .filter(|raw| js_regex!(r"^\d+$").test(raw))
            .map(|raw| JsNum(parse_int(raw, Radix::Ten)));
        let mut num_pr = None;
        if kind == "paragraph" {
            let style_num_pr = style_node
                .find_child("w:pPr")
                .and_then(|p_pr| p_pr.find_child("w:numPr"));
            if let Some(style_num_pr) = style_num_pr {
                let num_id = child_attr(style_num_pr, "w:numId", "w:val");
                let ilvl_raw = child_attr(style_num_pr, "w:ilvl", "w:val");
                let own = OwnNumPr {
                    num_id: num_id.map(str::to_owned),
                    ilvl: ilvl_raw.map(|ilvl| int_or_zero(ilvl).0),
                };
                num_pr = merge_num_pr(&own, None);
                own_num_prs.set(style_id, own);
            }
        }
        let attr_on = |key| matches!(style_node.attr(key), Some("1" | "true"));
        let info = StyleInfo {
            style_id: style_id.to_owned(),
            name: name.to_owned(),
            kind,
            heading_level,
            heading_outline_off: outline_off_ids.contains(style_id).then_some(true),
            based_on: based_on.map(str::to_owned),
            semi_hidden: on_off_of(style_node, "w:semiHidden"),
            q_format: on_off_of(style_node, "w:qFormat"),
            ui_priority,
            unhide_when_used: on_off_of(style_node, "w:unhideWhenUsed"),
            custom: attr_on("w:customStyle").then_some(true),
            display: if kind == "table" {
                None
            } else {
                style_display_of(style_node, theme, theme_fonts)
            },
            table_display: if kind == "table" {
                table_style_display_of(style_node, theme, theme_fonts)
            } else {
                None
            },
            num_pr,
            is_default: attr_on("w:default").then_some(true),
            heading_level_inherited: None,
            linked_char_shell: None,
        };
        match index.get(style_id) {
            Some(&at) => styles[at].1 = info,
            None => {
                index.insert(style_id.to_owned(), styles.len());
                styles.push((style_id.to_owned(), info));
            }
        }
    }

    // Word's effective default per style type: the last w:default="1" wins.
    // When a type declares none, Word does NOT use ECMA-376's first-of-type
    // rule: it falls back to a style id/named "Normal", else to built-in
    // defaults (docDefaults only).
    {
        let mut declared: JsMap<usize> = JsMap::new();
        let mut normal_of_type: JsMap<usize> = JsMap::new();
        for (at, (_, info)) in styles.iter_mut().enumerate() {
            if info.is_default == Some(true) {
                declared.set(info.kind, at);
            }
            if normal_of_type.get(info.kind).is_none()
                && (info.style_id.to_lowercase() == "normal"
                    || info.name.to_lowercase() == "normal")
            {
                normal_of_type.set(info.kind, at);
            }
            info.is_default = None;
        }
        for kind in ["paragraph", "character", "table"] {
            if let Some(&pick) = declared.get(kind).or(normal_of_type.get(kind)) {
                styles[pick].1.is_default = Some(true);
            }
        }
        // Normal.dotm's Normal has no own props and no basedOn; drop the parent
        // link too, or basedOn resolution below copies the parent's props straight back
        let normal = normal_of_type
            .get("paragraph")
            .or(declared.get("paragraph"))
            .filter(|_| linked_template);
        if let Some(&normal) = normal {
            let normal = &mut styles[normal].1;
            normal.display = normal_overrides;
            normal.based_on = None;
            based_on_ids.delete(&normal.style_id);
            own_num_prs.delete(&normal.style_id);
            normal.num_pr = None;
        }
    }

    let style_ids: Vec<String> = styles.iter().map(|(id, _)| id.clone()).collect();
    let mut resolver = Resolver {
        styles: &mut styles,
        index: &index,
        based_on_ids: &based_on_ids,
        own_num_prs: &own_num_prs,
        resolved: HashSet::new(),
    };
    for style_id in &style_ids {
        resolver.resolve(style_id, &mut HashSet::new());
    }
    // pPrDefault w:ind is the root of every paragraph style's indent chain
    // (Word probe 2026-10-29: Normal, a Normal-based style and a style without
    // w:basedOn all take it; a style's own w:ind overrides per attribute)
    if let Some(dd) = doc_defaults.as_ref().filter(|dd| {
        dd.indent_left_twips.is_some()
            || dd.indent_right_twips.is_some()
            || dd.indent_first_line_twips.is_some()
            || dd.indent_chars.is_some()
    }) {
        for (_, info) in styles.iter_mut() {
            if info.kind != "paragraph" {
                continue;
            }
            let mut d = info.display.take().unwrap_or_default();
            if d.indent_left_twips.is_none() && dd.indent_left_twips.is_some() {
                d.indent_left_twips.assign(*dd.indent_left_twips);
            }
            if d.indent_right_twips.is_none() && dd.indent_right_twips.is_some() {
                d.indent_right_twips.assign(*dd.indent_right_twips);
            }
            if d.indent_first_line_twips.is_none() && dd.indent_first_line_twips.is_some() {
                d.indent_first_line_twips
                    .assign(*dd.indent_first_line_twips);
            }
            if let Some(dd_chars) = &*dd.indent_chars {
                let chars = match d.indent_chars.as_ref() {
                    Some(chars) => merge_char_indents(Some(dd_chars.clone()), Some(chars.clone())),
                    None => Some(dd_chars.clone()),
                };
                d.indent_chars.assign(chars);
            }
            info.display = Some(d);
        }
    }
    if let Some(dd_sides) = doc_defaults
        .as_ref()
        .and_then(|dd| dd.border_sides.as_ref())
    {
        for (_, info) in styles.iter_mut() {
            if info.kind != "paragraph" {
                continue;
            }
            let mut d = info.display.take().unwrap_or_default();
            let mut sides = dd_sides.clone();
            if let Some(own) = &*d.border_sides {
                sides.assign(own);
            }
            d.border_sides.set(sides);
            info.display = Some(d);
        }
    }

    // linkedStyle (w:link): a paragraph style and a character style form one
    // unit. A character-style shell with no rPr of its own takes the run
    // properties of its linked paragraph style. The reverse never happens.
    for (from_id, to_id) in &linked_ids.0 {
        let (Some(&a), Some(&b)) = (index.get(from_id), index.get(to_id)) else {
            continue;
        };
        // Word pairs linked styles both ways; a stray one-way w:link contributes nothing
        if linked_ids.get(to_id).is_some_and(|back| back != from_id) {
            continue;
        }
        for (own, other) in [(a, b), (b, a)] {
            if styles[own].1.kind != "character" || styles[other].1.kind != "paragraph" {
                continue;
            }
            let Some(other_display) = &styles[other].1.display else {
                continue;
            };
            let mut fill = run_keys_fill(styles[own].1.display.as_ref(), other_display);
            if !fill.has_no_key() {
                if let Some(display) = &styles[own].1.display {
                    fill.assign(display);
                }
                styles[own].1.display = Some(fill);
            }
        }
        if styles[a].1.kind == "character" && styles[b].1.kind == "paragraph" {
            styles[a].1.linked_char_shell = Some(true);
        }
        if styles[b].1.kind == "character" && styles[a].1.kind == "paragraph" {
            styles[b].1.linked_char_shell = Some(true);
        }
    }

    Ok(ParsedStyles {
        styles,
        doc_defaults,
    })
}

/// `styleRunFormat`'s result: the set a run reads under Word's rtl selection.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleRunFormat {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_half_points: Option<JsNum>,
}

/// Style-chain run props under Word's rtl selection (probed, Word for Mac
/// 2026-08): rtl runs read only the Cs twins, non-rtl runs read only the base
/// props, no cross-fallback.
pub fn style_run_format(display: Option<&StyleDisplay>, cs: bool) -> StyleRunFormat {
    let Some(display) = display else {
        return StyleRunFormat::default();
    };
    if cs {
        StyleRunFormat {
            bold: *display.bold_cs,
            italic: *display.italic_cs,
            size_half_points: *display.size_cs_half_points,
        }
    } else {
        StyleRunFormat {
            bold: *display.bold,
            italic: *display.italic,
            size_half_points: *display.size_half_points,
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsFormat {
    pub size_half_points: JsNum,
    pub bold: bool,
    pub italic: bool,
}

/// Cs set a paragraph hands its rtl runs for the twins they do not carry:
/// paragraph style, then docDefaults. A twin nobody sets is regular / 10pt.
pub fn para_cs_format(
    para_style: Option<&StyleDisplay>,
    doc_defaults: Option<&DocDefaults>,
) -> CsFormat {
    let p = style_run_format(para_style, true);
    CsFormat {
        size_half_points: p
            .size_half_points
            .or(doc_defaults.and_then(|dd| *dd.size_cs_half_points))
            .unwrap_or(JsNum(20.0)),
        bold: p
            .bold
            .or(doc_defaults.and_then(|dd| *dd.bold_cs))
            .unwrap_or(false),
        italic: p
            .italic
            .or(doc_defaults.and_then(|dd| *dd.italic_cs))
            .unwrap_or(false),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunBorder {
    pub val: String,
    pub sz: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space: Option<JsNum>,
}

/// w:bdr as `Run.bdr`; `None` for none and nil.
pub fn run_border_of(bdr: &XNode) -> Option<RunBorder> {
    let val = truthy(bdr.attr("w:val")).filter(|val| !matches!(*val, "none" | "nil"))?;
    let sz = parse_int(bdr.attr("w:sz").unwrap_or(""), Radix::Ten);
    let space = parse_int(bdr.attr("w:space").unwrap_or(""), Radix::Ten);
    Some(RunBorder {
        val: val.to_owned(),
        // `parseInt(...) || 4`: NaN and 0 both fall back
        sz: JsNum(if sz.is_nan() || sz == 0.0 { 4.0 } else { sz }),
        color: truthy(bdr.attr("w:color"))
            .filter(|color| *color != "auto")
            .map(|color| strip_hash(color).to_owned()),
        space: (space > 0.0).then_some(JsNum(space)),
    })
}
