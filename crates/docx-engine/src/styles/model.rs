//! The values parse-styles.ts returns (`StyleInfo`, `StyleDisplay`,
//! `TableStyleDisplay`, `DocDefaults` of packages/docx-engine/src/types.ts).

use jscompat::{JsNum, Slot, js_object};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::drawing_geometry::TextOutline;
use crate::props::{Borders, CellMargins, CharIndents, ParaBorderSides, TabStop};
use crate::styles::RunBorder;

js_object! {
    deserialize;
    /// Display-only formatting a paragraph or character style contributes.
    /// Its keys follow the code that made it: the basedOn spread, the
    /// docDefaults indent and border fill-in, the linked-style run fill.
    #[derive(Debug, Clone, PartialEq)]
    pub struct StyleDisplay {
        pub size_half_points: JsNum,
        pub color: String,
        pub bold: bool,
        pub italic: bool,
        pub bold_cs: bool,
        pub italic_cs: bool,
        pub size_cs_half_points: JsNum,
        pub rtl: bool,
        pub underline: bool,
        pub strike: bool,
        pub bdr: RunBorder,
        pub font_ascii: String,
        pub east_asia_font: String,
        pub cs_font: String,
        pub font: String,
        pub ea_slot_empty: bool,
        pub char_spacing_twips: JsNum,
        pub kern_half_points: JsNum,
        pub east_asia_lang: String,
        pub caps: &'static str,
        pub shading: String,
        pub text_outline: TextOutline,
        pub vanish: bool,
        pub line_rule: String,
        pub line_raw_twips: JsNum,
        pub line_spacing: JsNum,
        pub space_before_twips: JsNum,
        pub space_after_twips: JsNum,
        pub space_before_auto: bool,
        pub space_after_auto: bool,
        pub keep_next: bool,
        pub keep_lines: bool,
        pub suppress_line_numbers: bool,
        pub page_break_before: bool,
        pub widow_control: bool,
        pub suppress_auto_hyphens: bool,
        pub contextual_spacing: bool,
        /// `autoSpaceDE`
        pub auto_space_d_e: bool,
        /// `autoSpaceDN`
        pub auto_space_d_n: bool,
        pub word_wrap: bool,
        pub overflow_punct: bool,
        pub align: &'static str,
        pub bidi: bool,
        pub shading_fill: String,
        pub border_sides: ParaBorderSides,
        pub tab_stops: Vec<TabStop>,
        pub indent_left_twips: JsNum,
        pub indent_right_twips: JsNum,
        pub indent_first_line_twips: JsNum,
        pub indent_chars: CharIndents,
    }
}

/// The `fill` a linked character style takes from its paragraph twin: each
/// RUN_KEYS key, in that order, that `own` holds no value for and `other` does.
pub(crate) fn run_keys_fill(own: Option<&StyleDisplay>, other: &StyleDisplay) -> StyleDisplay {
    fn take<T: Clone>(fill: &mut Slot<T>, own: &Slot<T>, other: &Slot<T>) {
        if let (None, Some(value)) = (&**own, &**other) {
            fill.set(value.clone());
        }
    }
    let none = StyleDisplay::default();
    let own = own.unwrap_or(&none);
    let mut fill = StyleDisplay::default();
    take(
        &mut fill.size_half_points,
        &own.size_half_points,
        &other.size_half_points,
    );
    take(&mut fill.color, &own.color, &other.color);
    take(&mut fill.bold, &own.bold, &other.bold);
    take(&mut fill.italic, &own.italic, &other.italic);
    take(&mut fill.bold_cs, &own.bold_cs, &other.bold_cs);
    take(&mut fill.italic_cs, &own.italic_cs, &other.italic_cs);
    take(
        &mut fill.size_cs_half_points,
        &own.size_cs_half_points,
        &other.size_cs_half_points,
    );
    take(&mut fill.rtl, &own.rtl, &other.rtl);
    take(&mut fill.underline, &own.underline, &other.underline);
    take(&mut fill.strike, &own.strike, &other.strike);
    take(&mut fill.font, &own.font, &other.font);
    take(&mut fill.font_ascii, &own.font_ascii, &other.font_ascii);
    take(
        &mut fill.east_asia_font,
        &own.east_asia_font,
        &other.east_asia_font,
    );
    take(&mut fill.cs_font, &own.cs_font, &other.cs_font);
    take(&mut fill.caps, &own.caps, &other.caps);
    take(&mut fill.bdr, &own.bdr, &other.bdr);
    take(&mut fill.shading, &own.shading, &other.shading);
    take(
        &mut fill.text_outline,
        &own.text_outline,
        &other.text_outline,
    );
    fill
}

js_object! {
    deserialize;
    /// `TableCondFormat['paraSpacing']`; mergeTableDisplay spreads it.
    #[derive(Debug, Clone, PartialEq)]
    pub struct TableParaSpacing {
        pub before_twips: JsNum,
        pub after_twips: JsNum,
        pub line_raw_twips: JsNum,
        pub line_rule: String,
        pub line_spacing: JsNum,
    }
}

js_object! {
    deserialize;
    /// Run and cell formatting one w:tblStylePr condition contributes;
    /// mergeTableDisplay spreads it.
    #[derive(Debug, Clone, PartialEq)]
    pub struct TableCondFormat {
        pub fill: String,
        pub bold: bool,
        pub italic: bool,
        pub color: String,
        pub size_half_points: JsNum,
        pub caps: &'static str,
        pub font_ascii: String,
        pub char_spacing_twips: JsNum,
        pub borders: Borders,
        pub cell_mar_twips: CellMargins,
        pub para_jc: String,
        pub para_spacing: TableParaSpacing,
    }
}

js_object! {
    deserialize;
    /// `TableStyleDisplay['wholeTable']`; mergeTableDisplay spreads it.
    #[derive(Debug, Clone, PartialEq)]
    pub struct WholeTable {
        pub color: String,
        pub bold: bool,
        pub italic: bool,
        pub size_half_points: JsNum,
        pub kern_half_points: JsNum,
    }
}

js_object! {
    deserialize;
    /// Display-only formatting a table style contributes. The conditions
    /// come in document order, and mergeTableDisplay spreads it.
    #[derive(Debug, Clone, PartialEq)]
    pub struct TableStyleDisplay {
        pub fill: String,
        pub whole_table: WholeTable,
        pub first_row: TableCondFormat,
        pub first_col: TableCondFormat,
        pub last_col: TableCondFormat,
        pub last_row: TableCondFormat,
        pub band1_fill: String,
        pub band2_fill: String,
        pub band1_horz: TableCondFormat,
        pub band2_horz: TableCondFormat,
        pub row_band_size: JsNum,
        pub borders: Borders,
        pub cell_mar_twips: CellMargins,
        pub para_jc: String,
        pub para_spacing: TableParaSpacing,
    }
}

/// `{ ...(a ?? {}), ...(b ?? {}) }` of one DEEP key, `None` when both are absent.
fn deep<T: Clone + Default>(a: Option<&T>, b: Option<&T>, assign: fn(&mut T, &T)) -> Option<T> {
    if a.is_none() && b.is_none() {
        return None;
    }
    let mut m = a.cloned().unwrap_or_default();
    if let Some(b) = b {
        assign(&mut m, b);
    }
    Some(m)
}

/// `deep` of a TableCondFormat, with `borders` and `cellMarTwips` spread per
/// side when both hold them.
fn deep_cond(a: Option<&TableCondFormat>, b: Option<&TableCondFormat>) -> Option<TableCondFormat> {
    let mut m = deep(a, b, TableCondFormat::assign)?;
    if let (Some(a), Some(b)) = (a, b) {
        if let (Some(a_side), Some(b_side)) = (&*a.borders, &*b.borders) {
            let mut side = a_side.clone();
            side.assign(b_side);
            m.borders.set(side);
        }
        if let (Some(a_side), Some(b_side)) = (&*a.cell_mar_twips, &*b.cell_mar_twips) {
            let mut side = a_side.clone();
            side.assign(b_side);
            m.cell_mar_twips.set(side);
        }
    }
    Some(m)
}

/// `mergeTableDisplay`.
pub(crate) fn merge_table_display(
    parent: &TableStyleDisplay,
    child: Option<&TableStyleDisplay>,
) -> Option<TableStyleDisplay> {
    let mut merged = parent.clone();
    if let Some(child) = child {
        merged.assign(child);
    }
    // `child?.[key]`: no child holds no key
    let none = TableStyleDisplay::default();
    let (a, b) = (parent, child.unwrap_or(&none));
    if let Some(m) = deep(
        a.whole_table.as_ref(),
        b.whole_table.as_ref(),
        WholeTable::assign,
    ) {
        merged.whole_table.set(m);
    }
    if let Some(m) = deep_cond(a.first_row.as_ref(), b.first_row.as_ref()) {
        merged.first_row.set(m);
    }
    if let Some(m) = deep_cond(a.first_col.as_ref(), b.first_col.as_ref()) {
        merged.first_col.set(m);
    }
    if let Some(m) = deep_cond(a.last_col.as_ref(), b.last_col.as_ref()) {
        merged.last_col.set(m);
    }
    if let Some(m) = deep_cond(a.last_row.as_ref(), b.last_row.as_ref()) {
        merged.last_row.set(m);
    }
    if let Some(m) = deep_cond(a.band1_horz.as_ref(), b.band1_horz.as_ref()) {
        merged.band1_horz.set(m);
    }
    if let Some(m) = deep_cond(a.band2_horz.as_ref(), b.band2_horz.as_ref()) {
        merged.band2_horz.set(m);
    }
    if let Some(m) = deep(
        a.para_spacing.as_ref(),
        b.para_spacing.as_ref(),
        TableParaSpacing::assign,
    ) {
        merged.para_spacing.set(m);
    }
    (!merged.has_no_key()).then_some(merged)
}

/// `StyleInfo['numPr']`: `'none'` is an explicit w:numId 0.
#[derive(Debug, Clone, PartialEq)]
pub enum NumPr {
    None,
    Num { num_id: String, ilvl: JsNum },
}

impl<'de> Deserialize<'de> for NumPr {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Text(serde::de::IgnoredAny),
            #[serde(rename_all = "camelCase")]
            Num {
                num_id: String,
                ilvl: JsNum,
            },
        }
        Ok(match Wire::deserialize(deserializer)? {
            Wire::Text(_) => NumPr::None,
            Wire::Num { num_id, ilvl } => NumPr::Num { num_id, ilvl },
        })
    }
}

impl Serialize for NumPr {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            NumPr::None => serializer.serialize_str("none"),
            NumPr::Num { num_id, ilvl } => {
                let mut out = serializer.serialize_struct("NumPr", 2)?;
                out.serialize_field("numId", num_id)?;
                out.serialize_field("ilvl", ilvl)?;
                out.end()
            }
        }
    }
}

/// The fields in the order of the object literal parseStyles writes, then the
/// two keys it adds later in the order it adds them; every other later write
/// replaces a key the literal already holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleInfo {
    pub style_id: String,
    pub name: String,
    #[serde(rename = "type", deserialize_with = "jscompat::wire::static_str")]
    pub kind: jscompat::wire::StaticStr,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading_level: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading_outline_off: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub based_on: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semi_hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q_format: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_priority: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unhide_when_used: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<StyleDisplay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table_display: Option<TableStyleDisplay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_pr: Option<NumPr>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading_level_inherited: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_char_shell: Option<bool>,
}

js_object! {
    deserialize;
    /// Document-wide defaults from styles.xml w:docDefaults. Its keys follow
    /// the code that made it: sizeHalfPoints and eastAsiaFont are each set at
    /// two places, and the built-in defaults are spread or assigned in.
    #[derive(Debug, Clone, PartialEq)]
    pub struct DocDefaults {
        pub size_half_points: JsNum,
        pub size_cs_half_points: JsNum,
        pub ascii_font: String,
        pub east_asia_font: String,
        pub ea_theme_slot: bool,
        pub cs_font: String,
        pub east_asia_lang: String,
        pub ea_from_lang: bool,
        pub ea_slot_empty: bool,
        pub bold: bool,
        pub italic: bool,
        pub bold_cs: bool,
        pub italic_cs: bool,
        pub color: String,
        pub kern_half_points: JsNum,
        pub lang: String,
        pub rtl: bool,
        pub line_raw_twips: JsNum,
        pub line_rule: String,
        pub line_spacing: JsNum,
        pub space_before_twips: JsNum,
        pub space_after_twips: JsNum,
        pub space_before_auto: bool,
        pub space_after_auto: bool,
        pub suppress_auto_hyphens: bool,
        pub bidi: bool,
        pub widow_control: bool,
        pub border_sides: ParaBorderSides,
        pub indent_left_twips: JsNum,
        pub indent_right_twips: JsNum,
        pub indent_first_line_twips: JsNum,
        pub indent_chars: CharIndents,
    }
}
