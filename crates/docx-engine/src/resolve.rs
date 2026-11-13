//! Effective paragraph and run properties (packages/docx-engine/src/resolve-props.ts):
//! builtin, docDefaults, the table style (whole table, then its conditions),
//! the paragraph style chain, the numbering level and direct formatting, one
//! layer over the other. Runs continue with docDefaults, the table style's
//! run properties, the paragraph style, the character style and the direct
//! w:rPr; the toggle properties XOR across the style layers, and the Cs twins
//! are taken where the rtl chain says so.
//!
//! The TypeScript keeps two caches on the context, `cache` (the resolved
//! paragraph per w:pPr node) and `styleMemo` (the layer of a paragraph style
//! per style id). Neither is here: no caller writes through what they hold,
//! so they change no answer.

use std::rc::Rc;

use jscompat::{
    JsMap, JsNum, JsObject, Radix, js_regex, math_round, number_to_string, parse_int, truthy,
};
use ooxml_xml::{XNode, parse_ordered};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::numbering::{NumberingDef, NumberingLevel};
use crate::props::{
    AutoSpace, CharIndents, CharUnits, FirstLineFold, ParaBorderLine, ParaBorderSides, PerSide,
    TabStop, XML_PARSER_MAX_NESTED_TAGS, active_char_indents, auto_space_flags_of, auto_space_mode,
    char_indents_of, fold_char_indents, indent_twips_of, jc_align, merge_char_indents,
    para_border_sides_of, para_borders_of, shd_display_fill, tab_stops_of, themed_r_fonts,
};
use crate::styles::{
    DocDefaults, NumPr, RunBorder, StyleDisplay, StyleInfo, TableCondFormat, TableParaSpacing,
    TableStyleDisplay, WholeTable, run_border_of, style_run_format,
};
use crate::theme::{ThemeColors, ThemeFonts};
use crate::xml_text::{auto_color_of, color_from, line_twips_of, on_off_of, strip_hash};

/// A number of a resolved paragraph as it arrives in JSON: `null` stands for
/// the NaN or infinity `JSON.stringify` wrote there.
fn js_number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<JsNum, D::Error> {
    Option::<f64>::deserialize(deserializer).map(|number| JsNum(number.unwrap_or(f64::NAN)))
}

/// `if (x)` on a number.
fn truthy_num(value: JsNum) -> bool {
    value.0 != 0.0 && !value.0.is_nan()
}

/// `attrsOf(findChild(node, name) ?? {})[key]`
fn child_attr<'a>(node: &'a XNode, name: &str, key: &str) -> Option<&'a str> {
    node.find_child(name).and_then(|child| child.attr(key))
}

/// `PropSource`: the layer a resolved property came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PropSource {
    Direct,
    Numbering,
    ParaStyle,
    CharStyle,
    TableStyle,
    DocDefaults,
    Builtin,
}

/// `TableCond`: a condition of the table style that applies to a cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableCond {
    FirstRow,
    LastRow,
    FirstCol,
    LastCol,
}

impl TableCond {
    /// `t[cond]`
    fn format(self, t: &TableStyleDisplay) -> Option<&TableCondFormat> {
        match self {
            TableCond::FirstRow => t.first_row.as_ref(),
            TableCond::LastRow => t.last_row.as_ref(),
            TableCond::FirstCol => t.first_col.as_ref(),
            TableCond::LastCol => t.last_col.as_ref(),
        }
    }
}

/// `ResolveCompat`. Deserialize reads a missing flag as false, as the
/// TypeScript reads its `undefined`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveCompat {
    /// settings.xml compatibilityMode (0 = legacy layout)
    #[serde(default)]
    pub mode: JsNum,
    /// w:doNotUseHTMLParagraphAutoSpacing: before/after spacing adds instead of collapsing
    #[serde(default)]
    pub additive_para_spacing: bool,
    /// w:doNotUseIndentAsNumberingTabStop
    #[serde(default)]
    pub indent_not_numbering_tab_stop: bool,
}

/// `ResolveCtx['table']`: the table a cell paragraph sits in. The conditions
/// come in ascending precedence: the last one wins.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCtx {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
    /// `None` where the wire gave none: the TypeScript type requires it, and
    /// `cacheKey` throws without it while the run layers read `?? []`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cond: Option<Vec<TableCond>>,
}

/// `ResolveCtx`, without the two caches (see the module comment).
#[derive(Debug, Clone, Default)]
pub struct ResolveCtx {
    /// Shared: a table cell scopes a copy of the context to its conditions,
    /// and that copy must not copy the definitions.
    pub styles: Rc<JsMap<StyleInfo>>,
    /// `defaultParaStyle`, as its key in `styles`.
    pub default_para_style_key: Option<String>,
    pub doc_defaults: Option<DocDefaults>,
    /// Shared, as `styles` is.
    pub numbering: Rc<JsMap<NumberingDef>>,
    pub theme_fonts: Option<ThemeFonts>,
    pub theme_colors: Option<ThemeColors>,
    pub compat: ResolveCompat,
    pub table: Option<TableCtx>,
}

impl ResolveCtx {
    /// `ctx.defaultParaStyle`
    pub fn default_para_style(&self) -> Option<&StyleInfo> {
        self.styles.get(self.default_para_style_key.as_deref()?)
    }
}

/// In the order of the literal `resolveCtxOf` writes; `table` is set later by
/// the caller, so it goes last.
impl Serialize for ResolveCtx {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Literal<'a> {
            styles: &'a JsMap<StyleInfo>,
            #[serde(skip_serializing_if = "Option::is_none")]
            default_para_style: Option<&'a StyleInfo>,
            #[serde(skip_serializing_if = "Option::is_none")]
            doc_defaults: Option<&'a DocDefaults>,
            numbering: &'a JsMap<NumberingDef>,
            theme_fonts: Option<&'a ThemeFonts>,
            theme_colors: Option<&'a ThemeColors>,
            compat: &'a ResolveCompat,
            #[serde(skip_serializing_if = "Option::is_none")]
            table: Option<&'a TableCtx>,
        }
        Literal {
            styles: &self.styles,
            default_para_style: self.default_para_style(),
            doc_defaults: self.doc_defaults.as_ref(),
            numbering: &self.numbering,
            theme_fonts: self.theme_fonts.as_ref(),
            theme_colors: self.theme_colors.as_ref(),
            compat: &self.compat,
            table: self.table.as_ref(),
        }
        .serialize(serializer)
    }
}

/// The wire form of a context: what `Serialize` writes. The default
/// paragraph style is found among `styles` by its id.
impl<'de> Deserialize<'de> for ResolveCtx {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Literal {
            styles: JsMap<StyleInfo>,
            default_para_style: Option<StyleInfo>,
            doc_defaults: Option<DocDefaults>,
            numbering: JsMap<NumberingDef>,
            theme_fonts: Option<ThemeFonts>,
            theme_colors: Option<ThemeColors>,
            compat: ResolveCompat,
            table: Option<TableCtx>,
        }
        let literal = Literal::deserialize(deserializer)?;
        let default_para_style_key = literal.default_para_style.as_ref().and_then(|style| {
            literal
                .styles
                .iter()
                .find(|(_, candidate)| candidate.style_id == style.style_id)
                .map(|(key, _)| key.to_owned())
        });
        Ok(ResolveCtx {
            styles: Rc::new(literal.styles),
            default_para_style_key,
            doc_defaults: literal.doc_defaults,
            numbering: Rc::new(literal.numbering),
            theme_fonts: literal.theme_fonts,
            theme_colors: literal.theme_colors,
            compat: literal.compat,
            table: literal.table,
        })
    }
}

/// `LineSpacing`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LineSpacing {
    pub rule: String,
    #[serde(deserialize_with = "js_number")]
    pub raw: JsNum,
}

/// `EffectivePPr['indent']`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParaIndent {
    #[serde(deserialize_with = "js_number")]
    pub left: JsNum,
    #[serde(deserialize_with = "js_number")]
    pub right: JsNum,
    #[serde(deserialize_with = "js_number")]
    pub first_line: JsNum,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chars: Option<CharIndents>,
}

/// `EffectivePPr['spacing']`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParaSpacing {
    #[serde(deserialize_with = "js_number")]
    pub before: JsNum,
    #[serde(deserialize_with = "js_number")]
    pub after: JsNum,
    pub before_auto: bool,
    pub after_auto: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<LineSpacing>,
}

/// `EffectivePPr['list']`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRef {
    pub num_id: String,
    pub ilvl: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<NumberingLevel>,
}

/// `EffectivePPr`. Deserialize serves the readers that take a resolved
/// paragraph as an argument (fields.rs): it requires `indent`, `spacing` and
/// `source`, defaults a missing key, and leaves `align`, `tabStops`, `list`
/// and `mark` at their defaults, which none of those readers reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePPr {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub align: Option<&'static str>,
    #[serde(default)]
    pub bidi: bool,
    pub indent: ParaIndent,
    pub spacing: ParaSpacing,
    #[serde(default)]
    pub keep_next: bool,
    #[serde(default)]
    pub keep_lines: bool,
    #[serde(default)]
    pub page_break_before: bool,
    #[serde(default)]
    pub widow_control: bool,
    #[serde(default)]
    pub contextual_spacing: bool,
    #[serde(default)]
    pub suppress_line_numbers: bool,
    #[serde(default)]
    pub snap_to_grid: bool,
    #[serde(default)]
    pub auto_space_d_e: bool,
    #[serde(default)]
    pub auto_space_d_n: bool,
    #[serde(default)]
    pub word_wrap: bool,
    #[serde(default)]
    pub overflow_punct: bool,
    #[serde(skip_deserializing)]
    pub tab_stops: Vec<TabStop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub borders: Option<ParaBorderSides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shading: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_asia_lang: Option<String>,
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub list: Option<ListRef>,
    /// paragraph-mark rPr resolved through the same chain
    #[serde(skip_deserializing)]
    pub mark: EffectiveRPr,
    /// the mark is hidden (direct / style / default-style w:vanish, specVanish excluded)
    #[serde(default)]
    pub hidden: bool,
    pub source: JsObject<PropSource>,
}

/// `EffectiveRPr['fonts']`
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFonts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ascii: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub east_asia: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ea_slot_empty: Option<bool>,
}

/// `EffectiveRPr`
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveRPr {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
    pub cs: bool,
    pub bold: bool,
    pub italic: bool,
    pub size_half_points: JsNum,
    pub fonts: RunFonts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub underline: bool,
    pub strike: bool,
    pub caps: &'static str,
    pub vanish: bool,
    pub char_spacing_twips: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kern_half_points: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vert_align: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bdr: Option<RunBorder>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shading: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub east_asia_lang: Option<String>,
    /// toggles whose style-layer XOR inverted the winning layer's own value
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_xor: Option<Vec<&'static str>>,
    pub source: JsObject<PropSource>,
}

/// `ResolveParaOptions`
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveParaOptions {
    /// twips per character for *Chars indents; absent = character indents stay unresolved
    pub char_units: Option<CharUnits>,
}

/// `PLayer`: one layer of paragraph properties, every field tri-state.
#[derive(Debug, Clone, Default)]
struct PLayer {
    align: Option<&'static str>,
    bidi: Option<bool>,
    indent_left: Option<JsNum>,
    indent_right: Option<JsNum>,
    indent_first_line: Option<JsNum>,
    indent_chars: Option<CharIndents>,
    space_before: Option<JsNum>,
    space_after: Option<JsNum>,
    space_before_auto: Option<bool>,
    space_after_auto: Option<bool>,
    line: Option<LineSpacing>,
    keep_next: Option<bool>,
    keep_lines: Option<bool>,
    page_break_before: Option<bool>,
    widow_control: Option<bool>,
    contextual_spacing: Option<bool>,
    suppress_line_numbers: Option<bool>,
    snap_to_grid: Option<bool>,
    auto_space_d_e: Option<bool>,
    auto_space_d_n: Option<bool>,
    word_wrap: Option<bool>,
    overflow_punct: Option<bool>,
    tab_stops: Option<Vec<TabStop>>,
    borders: Option<ParaBorderSides>,
    shading: Option<String>,
    east_asia_lang: Option<String>,
}

/// `RLayer`: one layer of run properties, every field tri-state.
#[derive(Debug, Clone, Default)]
struct RLayer {
    bold: Option<bool>,
    italic: Option<bool>,
    size_half_points: Option<JsNum>,
    rtl: Option<bool>,
    ascii: Option<String>,
    east_asia: Option<String>,
    cs: Option<String>,
    ea_slot_empty: Option<bool>,
    color: Option<String>,
    underline: Option<bool>,
    strike: Option<bool>,
    caps: Option<&'static str>,
    vanish: Option<bool>,
    char_spacing_twips: Option<JsNum>,
    kern_half_points: Option<JsNum>,
    vert_align: Option<&'static str>,
    /// `null` (`Some(None)`) where a w:bdr reads as no border
    bdr: Option<Option<RunBorder>>,
    shading: Option<String>,
    east_asia_lang: Option<String>,
}

const WORD_DEFAULT_SIZE_HALF_POINTS: f64 = 20.0;
const TOGGLES: [&str; 4] = ["bold", "italic", "strike", "vanish"];

impl RLayer {
    /// `layer[t]` of a toggle.
    fn toggle(&self, name: &str) -> Option<bool> {
        match name {
            "bold" => self.bold,
            "italic" => self.italic,
            "strike" => self.strike,
            _ => self.vanish,
        }
    }

    fn toggle_mut(&mut self, name: &str) -> &mut Option<bool> {
        match name {
            "bold" => &mut self.bold,
            "italic" => &mut self.italic,
            "strike" => &mut self.strike,
            _ => &mut self.vanish,
        }
    }
}

// ---------------------------------------------------------------- layers

fn doc_defaults_p_layer(d: Option<&DocDefaults>) -> PLayer {
    let Some(d) = d else {
        return PLayer::default();
    };
    let mut out = PLayer::default();
    if let Some(v) = *d.widow_control {
        out.widow_control = Some(v);
    }
    if let Some(v) = *d.bidi {
        out.bidi = Some(v);
    }
    if let Some(v) = *d.indent_left_twips {
        out.indent_left = Some(v);
    }
    if let Some(v) = *d.indent_right_twips {
        out.indent_right = Some(v);
    }
    if let Some(v) = *d.indent_first_line_twips {
        out.indent_first_line = Some(v);
    }
    if let Some(chars) = &*d.indent_chars {
        out.indent_chars = Some(chars.clone());
    }
    if let Some(v) = *d.space_before_twips {
        out.space_before = Some(v);
    }
    if let Some(v) = *d.space_after_twips {
        out.space_after = Some(v);
    }
    if let Some(v) = *d.space_before_auto {
        out.space_before_auto = Some(v);
    }
    if let Some(v) = *d.space_after_auto {
        out.space_after_auto = Some(v);
    }
    let line = line_of(d.line_rule.as_deref(), *d.line_raw_twips, *d.line_spacing);
    if line.is_some() {
        out.line = line;
    }
    if let Some(sides) = &*d.border_sides {
        out.borders = Some(sides.clone());
    }
    if let Some(lang) = truthy(d.east_asia_lang.as_deref()) {
        out.east_asia_lang = Some(lang.to_owned());
    }
    out
}

fn line_of(rule: Option<&str>, raw: Option<JsNum>, multiple: Option<JsNum>) -> Option<LineSpacing> {
    if let Some(raw) = raw {
        return Some(LineSpacing {
            rule: rule.unwrap_or("auto").to_owned(),
            raw,
        });
    }
    if let Some(multiple) = multiple {
        return Some(LineSpacing {
            rule: "auto".to_owned(),
            raw: JsNum(math_round(multiple.0 * 240.0)),
        });
    }
    None
}

fn table_style_p_layer(ctx: &ResolveCtx) -> PLayer {
    let Some(t) = table_style_of(ctx).and_then(|style| style.table_display.as_ref()) else {
        return PLayer::default();
    };
    let mut out = PLayer::default();
    let mut apply = |ps: Option<&TableParaSpacing>, para_jc: Option<&str>| {
        if let Some(ps) = ps {
            if let Some(v) = *ps.before_twips {
                out.space_before = Some(v);
            }
            if let Some(v) = *ps.after_twips {
                out.space_after = Some(v);
            }
            let line = line_of(
                ps.line_rule.as_deref(),
                *ps.line_raw_twips,
                *ps.line_spacing,
            );
            if line.is_some() {
                out.line = line;
            }
        }
        if let Some(align) = truthy(para_jc).and_then(jc_align) {
            out.align = Some(align);
        }
    };
    apply(t.para_spacing.as_ref(), t.para_jc.as_deref());
    for cond in ctx
        .table
        .iter()
        .flat_map(|table| table.cond.iter().flatten())
    {
        if let Some(c) = cond.format(t) {
            apply(c.para_spacing.as_ref(), c.para_jc.as_deref());
        }
    }
    out
}

fn level_p_layer(level: Option<&NumberingLevel>) -> PLayer {
    let Some(level) = level else {
        return PLayer::default();
    };
    let mut out = PLayer::default();
    if let Some(v) = *level.indent_left {
        out.indent_left = Some(v);
    }
    if let Some(v) = *level.indent_right {
        out.indent_right = Some(v);
    }
    let hanging = *level.hanging;
    let first_line = *level.first_line;
    if let Some(hanging) = hanging.filter(|hanging| hanging.0 > 0.0) {
        out.indent_first_line = Some(JsNum(-hanging.0));
    } else if let Some(first_line) = first_line.filter(|first_line| first_line.0 > 0.0) {
        out.indent_first_line = Some(first_line);
    } else if hanging.is_some() || first_line.is_some() {
        out.indent_first_line = Some(JsNum(0.0));
    }
    if let Some(v) = *level.bidi {
        out.bidi = Some(v);
    }
    out
}

fn style_p_layer(info: Option<&StyleInfo>) -> PLayer {
    let Some(info) = info else {
        return PLayer::default();
    };
    let mut out = PLayer::default();
    if let Some(d) = &info.display {
        if let Some(align) = truthy(*d.align) {
            out.align = Some(align);
        }
        if let Some(v) = *d.bidi {
            out.bidi = Some(v);
        }
        if let Some(v) = *d.indent_left_twips {
            out.indent_left = Some(v);
        }
        if let Some(v) = *d.indent_right_twips {
            out.indent_right = Some(v);
        }
        if let Some(v) = *d.indent_first_line_twips {
            out.indent_first_line = Some(v);
        }
        if let Some(chars) = &*d.indent_chars {
            out.indent_chars = Some(chars.clone());
        }
        if let Some(v) = *d.space_before_twips {
            out.space_before = Some(v);
        }
        if let Some(v) = *d.space_after_twips {
            out.space_after = Some(v);
        }
        if let Some(v) = *d.space_before_auto {
            out.space_before_auto = Some(v);
        }
        if let Some(v) = *d.space_after_auto {
            out.space_after_auto = Some(v);
        }
        let line = line_of(d.line_rule.as_deref(), *d.line_raw_twips, *d.line_spacing);
        if line.is_some() {
            out.line = line;
        }
        out.keep_next = *d.keep_next;
        out.keep_lines = *d.keep_lines;
        out.page_break_before = *d.page_break_before;
        out.widow_control = *d.widow_control;
        out.contextual_spacing = *d.contextual_spacing;
        out.suppress_line_numbers = *d.suppress_line_numbers;
        out.auto_space_d_e = *d.auto_space_d_e;
        out.auto_space_d_n = *d.auto_space_d_n;
        out.word_wrap = *d.word_wrap;
        out.overflow_punct = *d.overflow_punct;
        if let Some(stops) = &*d.tab_stops {
            out.tab_stops = Some(stops.clone());
        }
        if let Some(sides) = &*d.border_sides {
            out.borders = Some(sides.clone());
        }
        if let Some(fill) = truthy(d.shading_fill.as_deref()) {
            out.shading = Some(fill.to_owned());
        }
        if let Some(lang) = truthy(d.east_asia_lang.as_deref()) {
            out.east_asia_lang = Some(lang.to_owned());
        }
    }
    out
}

/// The direct w:pPr as a layer (extractParaFormat's reading, jc kept logical).
fn direct_p_layer(p_pr: Option<&XNode>, theme: Option<&ThemeColors>) -> PLayer {
    let Some(p_pr) = p_pr else {
        return PLayer::default();
    };
    let mut out = PLayer::default();
    let bidi = on_off_of(p_pr, "w:bidi");
    if bidi.is_some() {
        out.bidi = bidi;
    }
    let jc = child_attr(p_pr, "w:jc", "w:val");
    if let Some(align) = truthy(jc).and_then(jc_align) {
        out.align = Some(align);
    }
    if let Some(spacing) = p_pr.find_child("w:spacing") {
        let rule = spacing.attr("w:lineRule").unwrap_or("auto");
        let line = line_twips_of(spacing.attr("w:line"));
        if line > 0.0 || (line == 0.0 && rule == "atLeast") {
            out.line = Some(LineSpacing {
                rule: rule.to_owned(),
                raw: JsNum(line),
            });
        }
        let auto_of = |v: Option<&str>| v.map(|v| v == "1" || v == "true");
        let ba = auto_of(spacing.attr("w:beforeAutospacing"));
        if ba.is_some() {
            out.space_before_auto = ba;
        }
        let aa = auto_of(spacing.attr("w:afterAutospacing"));
        if aa.is_some() {
            out.space_after_auto = aa;
        }
        let before = parse_int(spacing.attr("w:before").unwrap_or(""), Radix::Ten);
        if before >= 0.0 {
            out.space_before = Some(JsNum(before));
        }
        let after = parse_int(spacing.attr("w:after").unwrap_or(""), Radix::Ten);
        if after >= 0.0 {
            out.space_after = Some(JsNum(after));
        }
    }
    if let Some(ind) = p_pr.find_child("w:ind") {
        let indent = indent_twips_of(ind);
        if indent.left.is_some() {
            out.indent_left = indent.left;
        }
        if indent.right.is_some() {
            out.indent_right = indent.right;
        }
        if indent.first_line.is_some() {
            out.indent_first_line = indent.first_line;
        }
        let chars = char_indents_of(Some(ind));
        if chars.is_some() {
            out.indent_chars = chars;
        }
    }
    for (slot, tag) in [
        (&mut out.page_break_before, "w:pageBreakBefore"),
        (&mut out.keep_next, "w:keepNext"),
        (&mut out.keep_lines, "w:keepLines"),
        (&mut out.suppress_line_numbers, "w:suppressLineNumbers"),
        (&mut out.widow_control, "w:widowControl"),
        (&mut out.contextual_spacing, "w:contextualSpacing"),
        (&mut out.snap_to_grid, "w:snapToGrid"),
        (&mut out.word_wrap, "w:wordWrap"),
        (&mut out.overflow_punct, "w:overflowPunct"),
    ] {
        let v = on_off_of(p_pr, tag);
        if v.is_some() {
            *slot = v;
        }
    }
    let auto = auto_space_flags_of(p_pr);
    if auto.de.is_some() {
        out.auto_space_d_e = auto.de;
    }
    if auto.dn.is_some() {
        out.auto_space_d_n = auto.dn;
    }
    if let Some(shd) = p_pr.find_child("w:shd") {
        let fill = shd.attr("w:fill");
        let display = shd_display_fill(Some(shd), theme);
        out.shading = Some(display.unwrap_or_else(|| {
            truthy(fill)
                .filter(|fill| *fill != "auto")
                .map_or_else(String::new, |fill| strip_hash(fill).to_owned())
        }));
    }
    let sides = para_border_sides_of(p_pr, theme);
    if sides.is_some() {
        out.borders = sides;
    }
    let stops = tab_stops_of(p_pr);
    if stops.is_some() {
        out.tab_stops = stops;
    }
    out
}

// ---------------------------------------------------------------- merge

fn merge_tab_stops(base: Vec<TabStop>, over: Vec<TabStop>) -> Vec<TabStop> {
    let mut merged: Vec<TabStop> = base
        .into_iter()
        .filter(|s| !over.iter().any(|o| o.pos == s.pos))
        .collect();
    merged.extend(over.into_iter().filter(|s| s.val != "clear"));
    // `(a, b) => a.pos - b.pos`: -0 and 0 are one position, as the subtraction says
    merged.sort_by(|a, b| {
        (a.pos.0 - b.pos.0)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    merged
}

/// `{ ...(base ?? {}) }`, then each side `over` holds, in t, b, l, r order.
fn merge_borders(base: Option<ParaBorderSides>, over: &ParaBorderSides) -> ParaBorderSides {
    let mut out = base.unwrap_or_default();
    for (ch, side) in over.sides() {
        if let Some(side) = &**side {
            out.side_mut(ch).set(side.clone());
        }
    }
    out
}

/// `if (v !== undefined) { acc[k] = v; source[k] = src }`
fn put<T>(
    acc: &mut Option<T>,
    value: Option<T>,
    key: &str,
    src: PropSource,
    source: &mut JsObject<PropSource>,
) {
    if value.is_some() {
        *acc = value;
        source.set(key, src);
    }
}

fn apply_p_layer(
    acc: &mut PLayer,
    layer: PLayer,
    src: PropSource,
    source: &mut JsObject<PropSource>,
) {
    // PLAIN_PKEYS, in its order
    put(&mut acc.align, layer.align, "align", src, source);
    put(&mut acc.bidi, layer.bidi, "bidi", src, source);
    put(
        &mut acc.indent_left,
        layer.indent_left,
        "indentLeft",
        src,
        source,
    );
    put(
        &mut acc.indent_right,
        layer.indent_right,
        "indentRight",
        src,
        source,
    );
    put(
        &mut acc.indent_first_line,
        layer.indent_first_line,
        "indentFirstLine",
        src,
        source,
    );
    put(
        &mut acc.space_before,
        layer.space_before,
        "spaceBefore",
        src,
        source,
    );
    put(
        &mut acc.space_after,
        layer.space_after,
        "spaceAfter",
        src,
        source,
    );
    put(
        &mut acc.space_before_auto,
        layer.space_before_auto,
        "spaceBeforeAuto",
        src,
        source,
    );
    put(
        &mut acc.space_after_auto,
        layer.space_after_auto,
        "spaceAfterAuto",
        src,
        source,
    );
    put(&mut acc.line, layer.line, "line", src, source);
    put(&mut acc.keep_next, layer.keep_next, "keepNext", src, source);
    put(
        &mut acc.keep_lines,
        layer.keep_lines,
        "keepLines",
        src,
        source,
    );
    put(
        &mut acc.page_break_before,
        layer.page_break_before,
        "pageBreakBefore",
        src,
        source,
    );
    put(
        &mut acc.widow_control,
        layer.widow_control,
        "widowControl",
        src,
        source,
    );
    put(
        &mut acc.contextual_spacing,
        layer.contextual_spacing,
        "contextualSpacing",
        src,
        source,
    );
    put(
        &mut acc.suppress_line_numbers,
        layer.suppress_line_numbers,
        "suppressLineNumbers",
        src,
        source,
    );
    put(
        &mut acc.snap_to_grid,
        layer.snap_to_grid,
        "snapToGrid",
        src,
        source,
    );
    put(
        &mut acc.auto_space_d_e,
        layer.auto_space_d_e,
        "autoSpaceDE",
        src,
        source,
    );
    put(
        &mut acc.auto_space_d_n,
        layer.auto_space_d_n,
        "autoSpaceDN",
        src,
        source,
    );
    put(&mut acc.word_wrap, layer.word_wrap, "wordWrap", src, source);
    put(
        &mut acc.overflow_punct,
        layer.overflow_punct,
        "overflowPunct",
        src,
        source,
    );
    put(&mut acc.shading, layer.shading, "shading", src, source);
    put(
        &mut acc.east_asia_lang,
        layer.east_asia_lang,
        "eastAsiaLang",
        src,
        source,
    );
    if let Some(c) = layer.indent_chars {
        if c.left.is_some() {
            source.set("indentLeftChars", src);
        }
        if c.right.is_some() {
            source.set("indentRightChars", src);
        }
        if c.first_line.is_some() || c.hanging.is_some() {
            source.set("indentSpecialChars", src);
        }
        acc.indent_chars = merge_char_indents(acc.indent_chars.take(), Some(c));
    }
    if let Some(stops) = layer.tab_stops {
        acc.tab_stops = Some(merge_tab_stops(
            acc.tab_stops.take().unwrap_or_default(),
            stops,
        ));
        source.set("tabStops", src);
    }
    if let Some(borders) = &layer.borders {
        acc.borders = Some(merge_borders(acc.borders.take(), borders));
        source.set("borders", src);
    }
}

// ---------------------------------------------------------------- paragraphs

/// `{ numId, ilvl }` of the paragraph's list, direct numPr over the style's.
fn list_ref_of(p_pr: Option<&XNode>, style: Option<&StyleInfo>) -> Option<(String, JsNum)> {
    let num_pr = p_pr.and_then(|p_pr| p_pr.find_child("w:numPr"));
    let direct_num_id = num_pr.and_then(|num_pr| child_attr(num_pr, "w:numId", "w:val"));
    let direct_ilvl = num_pr.and_then(|num_pr| child_attr(num_pr, "w:ilvl", "w:val"));
    if direct_num_id == Some("0") {
        return None;
    }
    let style_num_pr = match style.and_then(|style| style.num_pr.as_ref()) {
        Some(NumPr::Num { num_id, ilvl }) => Some((num_id.as_str(), *ilvl)),
        _ => None,
    };
    let num_id = truthy(direct_num_id.or(style_num_pr.map(|(num_id, _)| num_id)))?;
    let ilvl = match direct_ilvl {
        // `parseInt(directIlvl, 10) || 0`
        Some(ilvl) => {
            let n = parse_int(ilvl, Radix::Ten);
            JsNum(if n == 0.0 || n.is_nan() { 0.0 } else { n })
        }
        None => style_num_pr.map_or(JsNum(0.0), |(_, ilvl)| ilvl),
    };
    Some((num_id.to_owned(), ilvl))
}

fn table_style_of(ctx: &ResolveCtx) -> Option<&StyleInfo> {
    let style_id = truthy(ctx.table.as_ref()?.style_id.as_deref())?;
    ctx.styles.get(style_id)
}

/// `resolveParagraphProps` (its cache aside: see the module comment). `Err`
/// where its `cacheKey` throws: a table context without conditions.
pub fn resolve_paragraph_props(
    p_pr: Option<&XNode>,
    ctx: &ResolveCtx,
    opts: ResolveParaOptions,
) -> Result<EffectivePPr, String> {
    // `ctx.table.cond.join(',')` of cacheKey
    if ctx.table.as_ref().is_some_and(|table| table.cond.is_none()) {
        return Err("TypeError: Cannot read properties of undefined (reading 'join')".to_owned());
    }
    let style_id = p_pr.and_then(|p_pr| child_attr(p_pr, "w:pStyle", "w:val"));
    let style = truthy(style_id)
        .and_then(|style_id| ctx.styles.get(style_id))
        .or_else(|| ctx.default_para_style());
    let list_ref = list_ref_of(p_pr, style);
    let level = list_ref.as_ref().and_then(|(num_id, ilvl)| {
        ctx.numbering
            .get(num_id)?
            .levels
            .get(&number_to_string(ilvl.0))
    });
    let mut source = JsObject::new();
    let mut acc = PLayer {
        bidi: Some(false),
        indent_left: Some(JsNum(0.0)),
        indent_right: Some(JsNum(0.0)),
        indent_first_line: Some(JsNum(0.0)),
        space_before: Some(JsNum(0.0)),
        space_after: Some(JsNum(0.0)),
        space_before_auto: Some(false),
        space_after_auto: Some(false),
        keep_next: Some(false),
        keep_lines: Some(false),
        page_break_before: Some(false),
        widow_control: Some(true),
        contextual_spacing: Some(false),
        suppress_line_numbers: Some(false),
        snap_to_grid: Some(true),
        auto_space_d_e: Some(true),
        auto_space_d_n: Some(true),
        word_wrap: Some(true),
        overflow_punct: Some(true),
        ..PLayer::default()
    };
    // `Object.keys(acc)`
    for key in [
        "bidi",
        "indentLeft",
        "indentRight",
        "indentFirstLine",
        "spaceBefore",
        "spaceAfter",
        "spaceBeforeAuto",
        "spaceAfterAuto",
        "keepNext",
        "keepLines",
        "pageBreakBefore",
        "widowControl",
        "contextualSpacing",
        "suppressLineNumbers",
        "snapToGrid",
        "autoSpaceDE",
        "autoSpaceDN",
        "wordWrap",
        "overflowPunct",
    ] {
        source.set(key, PropSource::Builtin);
    }
    apply_p_layer(
        &mut acc,
        doc_defaults_p_layer(ctx.doc_defaults.as_ref()),
        PropSource::DocDefaults,
        &mut source,
    );
    apply_p_layer(
        &mut acc,
        table_style_p_layer(ctx),
        PropSource::TableStyle,
        &mut source,
    );
    let mut style_layer = style_p_layer(style);
    // numbering owns a list item's indent: the style chain's character indents stay off it
    if list_ref.is_some() {
        style_layer.indent_chars = None;
    }
    apply_p_layer(&mut acc, style_layer, PropSource::ParaStyle, &mut source);
    // Word lays the level's w:ind over the paragraph style's, unlike the ECMA-376 order
    apply_p_layer(
        &mut acc,
        level_p_layer(level),
        PropSource::Numbering,
        &mut source,
    );
    apply_p_layer(
        &mut acc,
        direct_p_layer(p_pr, ctx.theme_colors.as_ref()),
        PropSource::Direct,
        &mut source,
    );

    // Word quirk: w:jc left/right are logical in bidi paragraphs; the model stores the visual side
    let mut align = acc.align;
    if acc.bidi == Some(true) && matches!(align, Some("left" | "right")) {
        align = Some(if align == Some("left") {
            "right"
        } else {
            "left"
        });
    }

    // set from the start: the layers only ever replace them
    let acc_left = acc.indent_left.unwrap_or_default();
    let acc_right = acc.indent_right.unwrap_or_default();
    let acc_first_line = acc.indent_first_line.unwrap_or_default();
    let mut indent = (acc_left, acc_right, acc_first_line);
    let chars = active_char_indents(acc.indent_chars.as_ref());
    if let (Some(chars), Some(units)) = (&chars, opts.char_units) {
        // `resolveCharIndents({ indentLeft, indentRight, indentFirstLine }, chars, units)`
        let fold = fold_char_indents(Some(acc_first_line.0), chars, units);
        let f_left = fold.left.unwrap_or(acc_left.0);
        let f_right = fold.right.unwrap_or(acc_right.0);
        // `undefined` once deleted
        let f_first_line = match fold.first_line {
            FirstLineFold::Set(first_line) => Some(first_line),
            FirstLineFold::Delete => None,
            FirstLineFold::Keep => Some(acc_first_line.0),
        };
        // `f.indentFirstLine ?? 0`; the other two are always there
        indent = (
            JsNum(f_left),
            JsNum(f_right),
            JsNum(f_first_line.unwrap_or(0.0)),
        );
        // each twips key takes the source of the character component that moved it
        let left_src = if chars.left.is_some() {
            source.get("indentLeftChars").copied()
        } else {
            source.get("indentSpecialChars").copied()
        };
        let by = [
            ("indentLeft", left_src, acc_left, Some(f_left)),
            (
                "indentRight",
                source.get("indentRightChars").copied(),
                acc_right,
                Some(f_right),
            ),
            (
                "indentFirstLine",
                source.get("indentSpecialChars").copied(),
                acc_first_line,
                f_first_line,
            ),
        ];
        for (key, src, before, after) in by {
            // `acc[k] !== f[k]`
            if let Some(src) = src
                && after.is_none_or(|after| before.0 != after)
            {
                source.set(key, src);
            }
        }
    }

    let style_id = truthy(style_id).map(str::to_owned);
    let mark_r_pr = p_pr.and_then(|p_pr| p_pr.find_child("w:rPr"));
    let mark = resolve_run_props(
        mark_r_pr,
        style_id.as_deref(),
        acc.bidi.unwrap_or_default(),
        ctx,
        true,
    );
    // a w:specVanish mark is a style separator, never a hidden paragraph
    let hidden =
        mark.vanish && !mark_r_pr.is_some_and(|r_pr| on_off_of(r_pr, "w:specVanish") == Some(true));
    Ok(EffectivePPr {
        style_id,
        align,
        bidi: acc.bidi.unwrap_or_default(),
        indent: ParaIndent {
            left: indent.0,
            right: indent.1,
            first_line: indent.2,
            chars,
        },
        spacing: ParaSpacing {
            before: acc.space_before.unwrap_or_default(),
            after: acc.space_after.unwrap_or_default(),
            before_auto: acc.space_before_auto.unwrap_or_default(),
            after_auto: acc.space_after_auto.unwrap_or_default(),
            line: acc.line,
        },
        keep_next: acc.keep_next.unwrap_or_default(),
        keep_lines: acc.keep_lines.unwrap_or_default(),
        page_break_before: acc.page_break_before.unwrap_or_default(),
        widow_control: acc.widow_control.unwrap_or_default(),
        contextual_spacing: acc.contextual_spacing.unwrap_or_default(),
        suppress_line_numbers: acc.suppress_line_numbers.unwrap_or_default(),
        snap_to_grid: acc.snap_to_grid.unwrap_or_default(),
        auto_space_d_e: acc.auto_space_d_e.unwrap_or_default(),
        auto_space_d_n: acc.auto_space_d_n.unwrap_or_default(),
        word_wrap: acc.word_wrap.unwrap_or_default(),
        overflow_punct: acc.overflow_punct.unwrap_or_default(),
        tab_stops: acc.tab_stops.unwrap_or_default(),
        borders: acc.borders,
        shading: acc.shading.filter(|shading| !shading.is_empty()),
        east_asia_lang: acc.east_asia_lang.filter(|lang| !lang.is_empty()),
        list: list_ref.map(|(num_id, ilvl)| ListRef {
            num_id,
            ilvl,
            level: level.cloned(),
        }),
        mark,
        hidden,
        source,
    })
}

/// `resolveParagraphPropsXml`: for callers holding a raw `<w:p>` / `<w:pPr>` XML slice.
pub fn resolve_paragraph_props_xml(
    xml: &str,
    ctx: &ResolveCtx,
    opts: ResolveParaOptions,
) -> Result<EffectivePPr, String> {
    let Some(found) = js_regex!(r"<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>|<w:pPr\s*\/>").exec(xml)
    else {
        return resolve_paragraph_props(None, ctx, opts);
    };
    // the parser refusing the slice is no pPr
    let parsed = parse_ordered(found.as_str(), XML_PARSER_MAX_NESTED_TAGS).ok();
    let p_pr = parsed
        .as_ref()
        .and_then(|nodes| nodes.iter().find(|node| node.name() == Some("w:pPr")));
    resolve_paragraph_props(p_pr, ctx, opts)
}

// ---------------------------------------------------------------- runs

fn style_r_layer(d: Option<&StyleDisplay>, cs: bool) -> RLayer {
    let Some(d) = d else {
        return RLayer::default();
    };
    let mut out = RLayer::default();
    let f = style_run_format(Some(d), cs);
    if f.bold.is_some() {
        out.bold = f.bold;
    }
    if f.italic.is_some() {
        out.italic = f.italic;
    }
    if f.size_half_points.is_some() {
        out.size_half_points = f.size_half_points;
    }
    if let Some(v) = *d.rtl {
        out.rtl = Some(v);
    }
    // `d.fontAscii ?? d.font`, then its truth
    if let Some(ascii) = truthy(d.font_ascii.as_deref().or(d.font.as_deref())) {
        out.ascii = Some(ascii.to_owned());
    }
    if let Some(east_asia) = truthy(d.east_asia_font.as_deref()) {
        out.east_asia = Some(east_asia.to_owned());
    }
    if let Some(v) = *d.ea_slot_empty {
        out.ea_slot_empty = Some(v);
    }
    if let Some(cs_font) = truthy(d.cs_font.as_deref()) {
        out.cs = Some(cs_font.to_owned());
    }
    if let Some(color) = truthy(d.color.as_deref()) {
        out.color = Some(color.to_owned());
    }
    if let Some(v) = *d.underline {
        out.underline = Some(v);
    }
    if let Some(v) = *d.strike {
        out.strike = Some(v);
    }
    if let Some(caps) = truthy(*d.caps) {
        out.caps = Some(caps);
    }
    if let Some(v) = *d.vanish {
        out.vanish = Some(v);
    }
    if let Some(v) = *d.char_spacing_twips {
        out.char_spacing_twips = Some(v);
    }
    if let Some(v) = *d.kern_half_points {
        out.kern_half_points = Some(v);
    }
    if let Some(bdr) = &*d.bdr {
        out.bdr = Some(Some(bdr.clone()));
    }
    if let Some(shading) = truthy(d.shading.as_deref()) {
        out.shading = Some(shading.to_owned());
    }
    if let Some(lang) = truthy(d.east_asia_lang.as_deref()) {
        out.east_asia_lang = Some(lang.to_owned());
    }
    out
}

fn doc_defaults_r_layer(d: Option<&DocDefaults>, cs: bool) -> RLayer {
    let mut out = RLayer::default();
    let Some(d) = d else {
        return out;
    };
    let bold = if cs { *d.bold_cs } else { *d.bold };
    let italic = if cs { *d.italic_cs } else { *d.italic };
    let size = if cs {
        *d.size_cs_half_points
    } else {
        *d.size_half_points
    };
    if bold.is_some() {
        out.bold = bold;
    }
    if italic.is_some() {
        out.italic = italic;
    }
    if size.is_some() {
        out.size_half_points = size;
    }
    if let Some(v) = *d.rtl {
        out.rtl = Some(v);
    }
    if let Some(ascii) = truthy(d.ascii_font.as_deref()) {
        out.ascii = Some(ascii.to_owned());
    }
    if let Some(east_asia) = truthy(d.east_asia_font.as_deref()) {
        out.east_asia = Some(east_asia.to_owned());
    }
    if let Some(v) = *d.ea_slot_empty {
        out.ea_slot_empty = Some(v);
    }
    if let Some(cs_font) = truthy(d.cs_font.as_deref()) {
        out.cs = Some(cs_font.to_owned());
    }
    if let Some(color) = truthy(d.color.as_deref()) {
        out.color = Some(color.to_owned());
    }
    if let Some(v) = *d.kern_half_points {
        out.kern_half_points = Some(v);
    }
    if let Some(lang) = truthy(d.east_asia_lang.as_deref()) {
        out.east_asia_lang = Some(lang.to_owned());
    }
    out
}

/// `CondLike`: what `condRLayer` reads of a whole-table or a condition format.
#[derive(Default)]
struct CondLike<'a> {
    bold: Option<bool>,
    italic: Option<bool>,
    size_half_points: Option<JsNum>,
    color: Option<&'a str>,
    caps: Option<&'static str>,
    font_ascii: Option<&'a str>,
    char_spacing_twips: Option<JsNum>,
    kern_half_points: Option<JsNum>,
}

impl<'a> From<&'a WholeTable> for CondLike<'a> {
    fn from(c: &'a WholeTable) -> Self {
        CondLike {
            bold: *c.bold,
            italic: *c.italic,
            size_half_points: *c.size_half_points,
            color: c.color.as_deref(),
            kern_half_points: *c.kern_half_points,
            ..CondLike::default()
        }
    }
}

impl<'a> From<&'a TableCondFormat> for CondLike<'a> {
    fn from(c: &'a TableCondFormat) -> Self {
        CondLike {
            bold: *c.bold,
            italic: *c.italic,
            size_half_points: *c.size_half_points,
            color: c.color.as_deref(),
            caps: *c.caps,
            font_ascii: c.font_ascii.as_deref(),
            char_spacing_twips: *c.char_spacing_twips,
            kern_half_points: None,
        }
    }
}

fn cond_r_layer(c: Option<CondLike<'_>>) -> RLayer {
    let mut out = RLayer::default();
    let Some(c) = c else {
        return out;
    };
    if c.bold.is_some() {
        out.bold = c.bold;
    }
    if c.italic.is_some() {
        out.italic = c.italic;
    }
    if c.size_half_points.is_some() {
        out.size_half_points = c.size_half_points;
    }
    if let Some(color) = truthy(c.color) {
        out.color = Some(color.to_owned());
    }
    if let Some(caps) = truthy(c.caps) {
        out.caps = Some(caps);
    }
    if let Some(ascii) = truthy(c.font_ascii) {
        out.ascii = Some(ascii.to_owned());
    }
    if c.char_spacing_twips.is_some() {
        out.char_spacing_twips = c.char_spacing_twips;
    }
    if c.kern_half_points.is_some() {
        out.kern_half_points = c.kern_half_points;
    }
    out
}

fn table_style_r_layer(ctx: &ResolveCtx) -> RLayer {
    let Some(t) = table_style_of(ctx).and_then(|style| style.table_display.as_ref()) else {
        return RLayer::default();
    };
    let mut out = cond_r_layer(t.whole_table.as_ref().map(CondLike::from));
    for cond in ctx
        .table
        .iter()
        .flat_map(|table| table.cond.iter().flatten())
    {
        // `Object.assign(out, condRLayer(t[cond]))`: condRLayer holds only these keys
        let c = cond_r_layer(cond.format(t).map(CondLike::from));
        if c.bold.is_some() {
            out.bold = c.bold;
        }
        if c.italic.is_some() {
            out.italic = c.italic;
        }
        if c.size_half_points.is_some() {
            out.size_half_points = c.size_half_points;
        }
        if c.color.is_some() {
            out.color = c.color;
        }
        if c.caps.is_some() {
            out.caps = c.caps;
        }
        if c.ascii.is_some() {
            out.ascii = c.ascii;
        }
        if c.char_spacing_twips.is_some() {
            out.char_spacing_twips = c.char_spacing_twips;
        }
        if c.kern_half_points.is_some() {
            out.kern_half_points = c.kern_half_points;
        }
    }
    out
}

fn direct_r_layer(
    r_pr: Option<&XNode>,
    cs: bool,
    theme_colors: Option<&ThemeColors>,
    theme_fonts: Option<&ThemeFonts>,
) -> RLayer {
    let mut out = RLayer::default();
    let Some(r_pr) = r_pr else {
        return out;
    };
    let bold = on_off_of(r_pr, if cs { "w:bCs" } else { "w:b" });
    if bold.is_some() {
        out.bold = bold;
    }
    let italic = on_off_of(r_pr, if cs { "w:iCs" } else { "w:i" });
    if italic.is_some() {
        out.italic = italic;
    }
    let sz = parse_int(
        child_attr(r_pr, if cs { "w:szCs" } else { "w:sz" }, "w:val").unwrap_or(""),
        Radix::Ten,
    );
    if sz.is_finite() {
        out.size_half_points = Some(JsNum(sz.max(1.0)));
    }
    let rtl = on_off_of(r_pr, "w:rtl");
    if rtl.is_some() {
        out.rtl = rtl;
    }
    if let Some(rf_node) = r_pr.find_child("w:rFonts") {
        let rf = themed_r_fonts(rf_node, theme_fonts);
        if truthy(rf.ascii.as_deref()).is_some() {
            out.ascii = rf.ascii;
        }
        if truthy(rf.east_asia.as_deref()).is_some() {
            out.east_asia = rf.east_asia;
        }
        if rf.ea_slot_empty {
            out.ea_slot_empty = Some(true);
        }
        if truthy(rf.cs.as_deref()).is_some() {
            out.cs = rf.cs;
        }
    }
    let color = color_from(Some(r_pr), theme_colors)
        .or_else(|| auto_color_of(Some(r_pr)).map(str::to_owned));
    if let Some(color) = color.filter(|color| !color.is_empty()) {
        out.color = Some(color);
    }
    // a w:u without w:val is not an underline
    if let Some(u) = child_attr(r_pr, "w:u", "w:val") {
        out.underline = Some(u != "none");
    }
    let strike = on_off_of(r_pr, "w:strike");
    if strike.is_some() {
        out.strike = strike;
    }
    let caps = on_off_of(r_pr, "w:caps");
    let small = on_off_of(r_pr, "w:smallCaps");
    if caps == Some(true) {
        out.caps = Some("all");
    } else if small == Some(true) {
        out.caps = Some("small");
    } else if caps == Some(false) || small == Some(false) {
        out.caps = Some("none");
    }
    if on_off_of(r_pr, "w:specVanish") != Some(true) {
        let vanish = on_off_of(r_pr, "w:vanish");
        if vanish.is_some() {
            out.vanish = vanish;
        }
    }
    let spacing = parse_int(
        child_attr(r_pr, "w:spacing", "w:val").unwrap_or(""),
        Radix::Ten,
    );
    if spacing.is_finite() {
        out.char_spacing_twips = Some(JsNum(spacing));
    }
    if let Some(kern) = child_attr(r_pr, "w:kern", "w:val") {
        // `parseInt(kern, 10) || 0`
        let n = parse_int(kern, Radix::Ten);
        out.kern_half_points = Some(JsNum(if n == 0.0 || n.is_nan() { 0.0 } else { n }));
    }
    if let Some(va) = child_attr(r_pr, "w:vertAlign", "w:val") {
        out.vert_align = match va {
            "superscript" => Some("superscript"),
            "subscript" => Some("subscript"),
            "baseline" => Some("baseline"),
            _ => None,
        };
    }
    if let Some(bdr_node) = r_pr.find_child("w:bdr") {
        out.bdr = Some(run_border_of(bdr_node));
    }
    if let Some(shd) = r_pr.find_child("w:shd") {
        let display = shd_display_fill(Some(shd), theme_colors);
        let fill = shd.attr("w:fill");
        out.shading = Some(display.unwrap_or_else(|| {
            truthy(fill)
                .filter(|fill| *fill != "auto")
                .map_or_else(String::new, |fill| strip_hash(fill).to_owned())
        }));
    }
    if let Some(lang) = truthy(child_attr(r_pr, "w:lang", "w:eastAsia")) {
        out.east_asia_lang = Some(lang.to_owned());
    }
    out
}

/// PLAIN_RKEYS of `layer` over `acc`, in its order. The values move out of
/// the layer; its toggles stay.
fn apply_r_layer(
    acc: &mut RLayer,
    layer: &mut RLayer,
    src: PropSource,
    source: &mut JsObject<PropSource>,
) {
    put(
        &mut acc.size_half_points,
        layer.size_half_points.take(),
        "sizeHalfPoints",
        src,
        source,
    );
    put(&mut acc.ascii, layer.ascii.take(), "ascii", src, source);
    put(
        &mut acc.east_asia,
        layer.east_asia.take(),
        "eastAsia",
        src,
        source,
    );
    put(&mut acc.cs, layer.cs.take(), "cs", src, source);
    put(
        &mut acc.ea_slot_empty,
        layer.ea_slot_empty.take(),
        "eaSlotEmpty",
        src,
        source,
    );
    put(&mut acc.color, layer.color.take(), "color", src, source);
    put(
        &mut acc.underline,
        layer.underline.take(),
        "underline",
        src,
        source,
    );
    put(&mut acc.caps, layer.caps.take(), "caps", src, source);
    put(
        &mut acc.char_spacing_twips,
        layer.char_spacing_twips.take(),
        "charSpacingTwips",
        src,
        source,
    );
    put(
        &mut acc.kern_half_points,
        layer.kern_half_points.take(),
        "kernHalfPoints",
        src,
        source,
    );
    put(
        &mut acc.vert_align,
        layer.vert_align.take(),
        "vertAlign",
        src,
        source,
    );
    put(&mut acc.bdr, layer.bdr.take(), "bdr", src, source);
    put(
        &mut acc.shading,
        layer.shading.take(),
        "shading",
        src,
        source,
    );
    put(
        &mut acc.east_asia_lang,
        layer.east_asia_lang.take(),
        "eastAsiaLang",
        src,
        source,
    );
}

/// `resolveRunProps(rPr, para, ctx, mark)`. Of `para` the TypeScript reads
/// `para.styleId` and `para.bidi` only, which is what this takes. A style id
/// the document does not have falls back to the default paragraph style, as it
/// does for the paragraph's own properties.
pub fn resolve_run_props(
    r_pr: Option<&XNode>,
    para_style_id: Option<&str>,
    para_bidi: bool,
    ctx: &ResolveCtx,
    mark: bool,
) -> EffectiveRPr {
    let r_style_id = r_pr.and_then(|r_pr| child_attr(r_pr, "w:rStyle", "w:val"));
    let char_style = truthy(r_style_id).and_then(|id| ctx.styles.get(id));
    let para_style = truthy(para_style_id)
        .and_then(|id| ctx.styles.get(id))
        .or_else(|| ctx.default_para_style());
    let display_rtl = |style: Option<&StyleInfo>| {
        style
            .and_then(|style| style.display.as_ref())
            .and_then(|d| *d.rtl)
    };
    // the mark of a bidi paragraph reads the Cs twins even with its own w:rtl
    // off; w:cs marks the run complex-script outright
    let cs = (mark && para_bidi)
        || r_pr.and_then(|r_pr| on_off_of(r_pr, "w:cs")) == Some(true)
        || r_pr
            .and_then(|r_pr| on_off_of(r_pr, "w:rtl"))
            .or_else(|| display_rtl(char_style))
            .or_else(|| display_rtl(para_style))
            .or_else(|| ctx.doc_defaults.as_ref().and_then(|d| *d.rtl))
            == Some(true);

    let mut source = JsObject::new();
    let mut acc = RLayer {
        bold: Some(false),
        italic: Some(false),
        size_half_points: Some(JsNum(WORD_DEFAULT_SIZE_HALF_POINTS)),
        underline: Some(false),
        strike: Some(false),
        caps: Some("none"),
        vanish: Some(false),
        char_spacing_twips: Some(JsNum(0.0)),
        ..RLayer::default()
    };
    // `Object.keys(acc)`
    for key in [
        "bold",
        "italic",
        "sizeHalfPoints",
        "underline",
        "strike",
        "caps",
        "vanish",
        "charSpacingTwips",
    ] {
        source.set(key, PropSource::Builtin);
    }
    let style_layers = [
        (table_style_r_layer(ctx), PropSource::TableStyle),
        (
            style_r_layer(para_style.and_then(|style| style.display.as_ref()), cs),
            PropSource::ParaStyle,
        ),
        (
            style_r_layer(char_style.and_then(|style| style.display.as_ref()), cs),
            PropSource::CharStyle,
        ),
    ];
    let mut defaults = doc_defaults_r_layer(ctx.doc_defaults.as_ref(), cs);
    apply_r_layer(
        &mut acc,
        &mut defaults,
        PropSource::DocDefaults,
        &mut source,
    );
    for t in TOGGLES {
        if let Some(v) = defaults.toggle(t) {
            *acc.toggle_mut(t) = Some(v);
            source.set(t, PropSource::DocDefaults);
        }
    }
    let mut layer_toggles = Vec::with_capacity(style_layers.len());
    for (mut layer, src) in style_layers {
        layer_toggles.push((src, TOGGLES.map(|t| layer.toggle(t))));
        apply_r_layer(&mut acc, &mut layer, src, &mut source);
        // toggle properties XOR across the style layers (ECMA-376 17.7.3)
        for t in TOGGLES {
            let Some(v) = layer.toggle(t) else {
                continue;
            };
            let base = match source.get(t) {
                Some(PropSource::Builtin | PropSource::DocDefaults) => false,
                _ => acc.toggle(t).unwrap_or_default(),
            };
            *acc.toggle_mut(t) = Some(base != v);
            source.set(t, src);
        }
    }
    let mut direct = direct_r_layer(
        r_pr,
        cs,
        ctx.theme_colors.as_ref(),
        ctx.theme_fonts.as_ref(),
    );
    apply_r_layer(&mut acc, &mut direct, PropSource::Direct, &mut source);
    for t in TOGGLES {
        if let Some(v) = direct.toggle(t) {
            *acc.toggle_mut(t) = Some(v);
            source.set(t, PropSource::Direct);
        }
    }

    // two style layers both turning a toggle on leave it off; an explicit style
    // off keeps the cascade's own result
    let mut style_xor = Vec::new();
    for (at, t) in TOGGLES.into_iter().enumerate() {
        let winner = layer_toggles
            .iter()
            .find(|(src, _)| Some(src) == source.get(t));
        if winner.is_some_and(|(_, toggles)| toggles[at] == Some(true))
            && !acc.toggle(t).unwrap_or_default()
        {
            style_xor.push(t);
        }
    }

    let fonts = RunFonts {
        ascii: acc.ascii.filter(|ascii| !ascii.is_empty()),
        east_asia: acc.east_asia.filter(|east_asia| !east_asia.is_empty()),
        cs: acc.cs.filter(|cs| !cs.is_empty()),
        ea_slot_empty: (acc.ea_slot_empty == Some(true)).then_some(true),
    };
    EffectiveRPr {
        style_id: truthy(r_style_id).map(str::to_owned),
        cs,
        bold: acc.bold.unwrap_or_default(),
        italic: acc.italic.unwrap_or_default(),
        size_half_points: acc.size_half_points.unwrap_or_default(),
        fonts,
        color: acc.color.filter(|color| !color.is_empty()),
        underline: acc.underline.unwrap_or_default(),
        strike: acc.strike.unwrap_or_default(),
        caps: acc.caps.unwrap_or_default(),
        vanish: acc.vanish.unwrap_or_default(),
        char_spacing_twips: acc.char_spacing_twips.unwrap_or_default(),
        kern_half_points: acc.kern_half_points,
        vert_align: acc.vert_align.filter(|va| *va != "baseline"),
        bdr: acc.bdr.flatten(),
        shading: acc.shading.filter(|shading| !shading.is_empty()),
        east_asia_lang: acc.east_asia_lang.filter(|lang| !lang.is_empty()),
        style_xor: (!style_xor.is_empty()).then_some(style_xor),
        source,
    }
}

// ---------------------------------------------------------------- direct view

/// `directParaFormat`'s `Pick<ParaFormat, ...>`, in the order its keys are set.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectParaFormat {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bidi: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bidi_inherited: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_raw_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_spacing: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_before_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_after_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_before: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_after: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_left: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_right: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_first_line: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_break_before: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_next: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_lines: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppress_line_numbers: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widow_control: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contextual_spacing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub word_wrap: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overflow_punct: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snap_to_grid: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_space_d_e: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_space_d_n: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_space: Option<AutoSpace>,
}

/// The paragraph's own w:pPr as the direct-only ParaFormat the model saves:
/// every key the resolver sourced from the direct layer. w:bidi inherited
/// from the chain surfaces as bidiInherited.
pub fn direct_para_format(eff: &EffectivePPr) -> DirectParaFormat {
    let direct = |k: &str| eff.source.get(k) == Some(&PropSource::Direct);
    let mut f = DirectParaFormat::default();
    if eff.bidi {
        if direct("bidi") {
            f.bidi = Some(true);
        } else {
            f.bidi_inherited = Some(true);
        }
    }
    if direct("align") && eff.align.is_some() {
        f.align = eff.align;
    }
    if direct("line") {
        let line = effective_line_format(eff.spacing.line.as_ref());
        f.line_rule = line.line_rule;
        f.line_raw_twips = line.line_raw_twips;
        f.line_spacing = line.line_spacing;
    }
    if direct("spaceBeforeAuto") {
        f.space_before_auto = Some(eff.spacing.before_auto);
    }
    if direct("spaceAfterAuto") {
        f.space_after_auto = Some(eff.spacing.after_auto);
    }
    if direct("spaceBefore") {
        f.space_before = Some(eff.spacing.before);
    }
    if direct("spaceAfter") {
        f.space_after = Some(eff.spacing.after);
    }
    if direct("indentLeft") {
        f.indent_left = Some(eff.indent.left);
    }
    if direct("indentRight") {
        f.indent_right = Some(eff.indent.right);
    }
    if direct("indentFirstLine") {
        f.indent_first_line = Some(eff.indent.first_line);
    }
    for (slot, key, value) in [
        (
            &mut f.page_break_before,
            "pageBreakBefore",
            eff.page_break_before,
        ),
        (&mut f.keep_next, "keepNext", eff.keep_next),
        (&mut f.keep_lines, "keepLines", eff.keep_lines),
        (
            &mut f.suppress_line_numbers,
            "suppressLineNumbers",
            eff.suppress_line_numbers,
        ),
        (&mut f.widow_control, "widowControl", eff.widow_control),
        (
            &mut f.contextual_spacing,
            "contextualSpacing",
            eff.contextual_spacing,
        ),
        (&mut f.word_wrap, "wordWrap", eff.word_wrap),
        (&mut f.overflow_punct, "overflowPunct", eff.overflow_punct),
    ] {
        if direct(key) {
            *slot = Some(value);
        }
    }
    if direct("snapToGrid") && !eff.snap_to_grid {
        f.snap_to_grid = Some(false);
    }
    let de = direct("autoSpaceDE").then_some(eff.auto_space_d_e);
    let dn = direct("autoSpaceDN").then_some(eff.auto_space_d_n);
    f.auto_space_d_e = de;
    f.auto_space_d_n = dn;
    f.auto_space = auto_space_mode(de, dn);
    f
}

/// `directRunFormat`'s `Pick<Run, ...>`, in the order its keys are set.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectRunFormat {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strike: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_half_points: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub east_asia_font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ea_slot_empty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_ascii: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cs_font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub char_spacing_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kern_half_points: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caps: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vert_align: Option<&'static str>,
}

/// The run's own w:rPr as the direct-only Run fields the model saves: every
/// key the resolver sourced from the direct layer (font is the
/// eastAsia-first display face).
pub fn direct_run_format(eff: &EffectiveRPr) -> DirectRunFormat {
    let direct = |k: &str| eff.source.get(k) == Some(&PropSource::Direct);
    let mut f = DirectRunFormat::default();
    if direct("bold") {
        f.bold = Some(eff.bold);
    }
    if direct("italic") {
        f.italic = Some(eff.italic);
    }
    if direct("underline") {
        f.underline = Some(eff.underline);
    }
    if direct("strike") {
        f.strike = Some(eff.strike);
    }
    if direct("sizeHalfPoints") {
        f.size_half_points = Some(eff.size_half_points);
    }
    let east_asia = if direct("eastAsia") {
        eff.fonts.east_asia.as_deref()
    } else {
        None
    };
    let ascii = if direct("ascii") {
        eff.fonts.ascii.as_deref()
    } else {
        None
    };
    if let Some(font) = truthy(east_asia.or(ascii)) {
        f.font = Some(font.to_owned());
    }
    if let Some(east_asia) = truthy(east_asia) {
        f.east_asia_font = Some(east_asia.to_owned());
        if direct("eaSlotEmpty") && eff.fonts.ea_slot_empty == Some(true) {
            f.ea_slot_empty = Some(true);
        }
    }
    if let Some(ascii) = truthy(ascii) {
        f.font_ascii = Some(ascii.to_owned());
    }
    if direct("cs")
        && let Some(cs) = truthy(eff.fonts.cs.as_deref())
    {
        f.cs_font = Some(cs.to_owned());
    }
    if direct("charSpacingTwips") {
        f.char_spacing_twips = Some(eff.char_spacing_twips);
    }
    if direct("kernHalfPoints") {
        f.kern_half_points = eff.kern_half_points;
    }
    if direct("caps") {
        f.caps = Some(eff.caps);
    }
    if direct("vertAlign") && eff.vert_align.is_some() {
        f.vert_align = eff.vert_align;
    }
    f
}

// ---------------------------------------------------------------- shadow

/// `ResolveDiff`, as `shadowCompare` writes it.
#[derive(Debug, PartialEq, Serialize)]
pub struct ResolveDiff {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eff: Option<Value>,
}

/// `object[key]` of a plain object, its prototype's members included: the
/// value as the gate's wire writes it, and `JSON.stringify` of it.
fn lookup(object: &Map<String, Value>, key: &str) -> (Option<Value>, Option<String>) {
    if let Some(value) = object.get(key) {
        return (Some(value.clone()), serde_json::to_string(value).ok());
    }
    match key {
        // `Object.prototype` itself
        "__proto__" => (Some(Value::Object(Map::new())), Some("{}".to_owned())),
        // functions: `JSON.stringify` gives undefined, the wire marks them
        "constructor"
        | "toString"
        | "toLocaleString"
        | "valueOf"
        | "hasOwnProperty"
        | "isPrototypeOf"
        | "propertyIsEnumerable"
        | "__defineGetter__"
        | "__defineSetter__"
        | "__lookupGetter__"
        | "__lookupSetter__" => (Some(Value::String("[function]".to_owned())), None),
        _ => (None, None),
    }
}

/// Key-by-key comparison of a legacy direct reader's output with the
/// resolver's. A value that is not an object reads as `{}`.
pub fn shadow_compare(
    legacy: Option<&Value>,
    resolved: Option<&Value>,
    keys: Option<&[String]>,
) -> Vec<ResolveDiff> {
    let empty = Map::new();
    let a = match legacy {
        Some(Value::Object(object)) => object,
        _ => &empty,
    };
    let b = match resolved {
        Some(Value::Object(object)) => object,
        _ => &empty,
    };
    // `new Set([...Object.keys(a), ...Object.keys(b)])`
    let own_keys: Vec<String>;
    let keys = match keys {
        Some(keys) => keys,
        None => {
            let mut seen = Vec::new();
            for key in a.keys().chain(b.keys()) {
                if !seen.contains(key) {
                    seen.push(key.clone());
                }
            }
            own_keys = seen;
            &own_keys
        }
    };
    let mut out = Vec::new();
    for key in keys {
        if key == "effective" {
            continue;
        }
        let (o, o_json) = lookup(a, key);
        let (e, e_json) = lookup(b, key);
        if o_json != e_json {
            out.push(ResolveDiff {
                key: key.clone(),
                old: o,
                eff: e,
            });
        }
    }
    out
}

// ---------------------------------------------------------------- context

/// The document `resolveCtxOf` is given.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveDoc {
    pub styles: JsMap<StyleInfo>,
    pub doc_defaults: Option<DocDefaults>,
    pub numbering: JsMap<NumberingDef>,
    pub theme_fonts: Option<ThemeFonts>,
    pub theme_colors: Option<ThemeColors>,
    pub compatibility_mode: Option<JsNum>,
    #[serde(rename = "doNotUseHTMLParagraphAutoSpacing")]
    pub do_not_use_html_paragraph_auto_spacing: Option<bool>,
    pub indent_not_numbering_tab_stop: Option<bool>,
}

/// `resolveCtxOf`: the ResolveCtx over a parsed document.
pub fn resolve_ctx_of(doc: ResolveDoc) -> ResolveCtx {
    let default_para_style_key = doc
        .styles
        .iter()
        .find(|(_, s)| s.kind == "paragraph" && s.is_default == Some(true))
        .map(|(key, _)| key.to_owned());
    ResolveCtx {
        styles: Rc::new(doc.styles),
        default_para_style_key,
        doc_defaults: doc.doc_defaults,
        numbering: Rc::new(doc.numbering),
        theme_fonts: doc.theme_fonts,
        theme_colors: doc.theme_colors,
        compat: ResolveCompat {
            mode: doc.compatibility_mode.unwrap_or(JsNum(0.0)),
            additive_para_spacing: doc.do_not_use_html_paragraph_auto_spacing == Some(true),
            indent_not_numbering_tab_stop: doc.indent_not_numbering_tab_stop == Some(true),
        },
        table: None,
    }
}

/// Word's HTML auto paragraph spacing (w:beforeAutospacing / w:afterAutospacing), twips.
pub const AUTO_SPACING_TWIPS: f64 = 280.0;

/// w:*Autospacing resolved for a document: Word's 14pt, 0 under doNotUseHTMLParagraphAutoSpacing.
pub fn auto_spacing_twips(compat: &ResolveCompat) -> f64 {
    if compat.additive_para_spacing {
        0.0
    } else {
        AUTO_SPACING_TWIPS
    }
}

/// `EffectiveSpacingTwips`
#[derive(Debug, PartialEq, Serialize)]
pub struct EffectiveSpacingTwips {
    pub before: JsNum,
    pub after: JsNum,
}

/// Before / after spacing with the auto flags folded in (twips).
pub fn effective_spacing_twips(
    eff: &EffectivePPr,
    compat: &ResolveCompat,
) -> EffectiveSpacingTwips {
    let auto = JsNum(auto_spacing_twips(compat));
    EffectiveSpacingTwips {
        before: if eff.spacing.before_auto {
            auto
        } else {
            eff.spacing.before
        },
        after: if eff.spacing.after_auto {
            auto
        } else {
            eff.spacing.after
        },
    }
}

/// `effectiveLineFormat`'s `Pick<ParaFormat, 'lineRule' | 'lineRawTwips' | 'lineSpacing'>`.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveLineFormat {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_raw_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_spacing: Option<JsNum>,
}

/// Line spacing in the ParaFormat triple (lineRule / lineRawTwips / lineSpacing multiple).
pub fn effective_line_format(line: Option<&LineSpacing>) -> EffectiveLineFormat {
    let Some(line) = line else {
        return EffectiveLineFormat::default();
    };
    EffectiveLineFormat {
        line_rule: Some(line.rule.clone()),
        line_raw_twips: Some(line.raw),
        line_spacing: (line.rule == "auto")
            .then(|| JsNum(math_round((line.raw.0 / 240.0) * 100.0) / 100.0)),
    }
}

fn effective_line_source(eff: &EffectivePPr, sources: Option<&[PropSource]>) -> bool {
    sources.is_none_or(|sources| {
        eff.source
            .get("line")
            .is_some_and(|line| sources.contains(line))
    })
}

/// The layers whose line spacing a header/footer surface carries inline: the
/// strip base already lays out Normal / docDefaults, a named style and the
/// direct pPr (plus the table style for cells) come on the paragraph.
pub fn hf_line_sources(eff: &EffectivePPr, in_table: bool) -> Vec<PropSource> {
    let mut out = vec![PropSource::Direct];
    if in_table {
        out.push(PropSource::TableStyle);
    }
    if eff.style_id.is_some() {
        out.push(PropSource::ParaStyle);
    }
    out
}

/// `EffectiveParaFormatOptions`
#[derive(Debug, Clone, Default)]
pub struct EffectiveParaFormatOptions {
    /// layers whose line spacing travels inline; absent = every layer
    pub line_sources: Option<Vec<PropSource>>,
}

/// `effectiveParaFormat`'s `Pick<ParaFormat, ...>`, in the order of its spreads.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveParaFormat {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bidi: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_left: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_right: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_first_line: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_before: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_after: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_raw_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_spacing: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub borders: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_lines: Option<PerSide<ParaBorderLine>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_pad: Option<PerSide<JsNum>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_reset: Option<String>,
}

/// The resolved paragraph as display-only ParaFormat keys (non-editable
/// surfaces: header/footer strips, cells, notes). Zero geometry is omitted so
/// the consumers' "absent = none" checks keep working.
pub fn effective_para_format(
    eff: &EffectivePPr,
    compat: &ResolveCompat,
    opts: &EffectiveParaFormatOptions,
) -> EffectiveParaFormat {
    let sp = effective_spacing_twips(eff, compat);
    let borders = eff
        .borders
        .as_ref()
        .map(para_borders_of)
        .unwrap_or_default();
    let line = if effective_line_source(eff, opts.line_sources.as_deref()) {
        eff.spacing.line.as_ref()
    } else {
        None
    };
    let line = effective_line_format(line);
    EffectiveParaFormat {
        align: eff.align,
        bidi: eff.bidi.then_some(true),
        indent_left: Some(eff.indent.left).filter(|v| truthy_num(*v)),
        indent_right: Some(eff.indent.right).filter(|v| truthy_num(*v)),
        indent_first_line: Some(eff.indent.first_line).filter(|v| truthy_num(*v)),
        space_before: Some(sp.before).filter(|v| truthy_num(*v)),
        space_after: Some(sp.after).filter(|v| truthy_num(*v)),
        line_rule: line.line_rule,
        line_raw_twips: line.line_raw_twips,
        line_spacing: line.line_spacing,
        borders: borders.borders.filter(|b| !b.is_empty()),
        border_lines: borders.border_lines,
        border_pad: borders.border_pad,
        border_reset: borders.border_reset.filter(|r| !r.is_empty()),
    }
}
