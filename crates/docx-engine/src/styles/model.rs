//! The values parse-styles.ts returns (`StyleInfo`, `StyleDisplay`,
//! `TableStyleDisplay`, `DocDefaults` of packages/docx-engine/src/types.ts).

use jscompat::JsNum;
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

use crate::drawing_geometry::TextOutline;
use crate::props::{Borders, CellMargins, CharIndents, ParaBorderSides, TabStop};
use crate::styles::RunBorder;

/// A field the TypeScript can hold as a key with the value `undefined`
/// (`parseInt(sz, 10) || undefined`). Such a key is absent from the JSON but
/// still wins an object spread and still counts in `Object.keys`:
/// `None` is no key, `Some(None)` the key holding `undefined`.
pub type SpreadSlot<T> = Option<Option<T>>;

fn unset<T: Copy>(slot: &SpreadSlot<T>) -> bool {
    slot.flatten().is_none()
}

/// Display-only formatting a paragraph or character style contributes.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleDisplay {
    #[serde(skip_serializing_if = "unset")]
    pub size_half_points: SpreadSlot<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kern_half_points: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold_cs: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic_cs: Option<bool>,
    #[serde(skip_serializing_if = "unset")]
    pub size_cs_half_points: SpreadSlot<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rtl: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strike: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bdr: Option<RunBorder>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub east_asia_font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_ascii: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ea_slot_empty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cs_font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub char_spacing_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_stops: Option<TabStops>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caps: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shading: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_outline: Option<TextOutline>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_spacing: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_raw_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_before_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_after_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_before_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_after_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_left_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_right_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_first_line_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_chars: Option<CharIndents>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_next: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_lines: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppress_line_numbers: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_break_before: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widow_control: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppress_auto_hyphens: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contextual_spacing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bidi: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shading_fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_sides: Option<ParaBorderSides>,
    #[serde(rename = "autoSpaceDE", skip_serializing_if = "Option::is_none")]
    pub auto_space_de: Option<bool>,
    #[serde(rename = "autoSpaceDN", skip_serializing_if = "Option::is_none")]
    pub auto_space_dn: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub word_wrap: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overflow_punct: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub east_asia_lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vanish: Option<bool>,
}

impl StyleDisplay {
    /// `Object.keys(display).length === 0`
    pub fn has_no_key(&self) -> bool {
        *self == Self::default()
    }

    /// `{ ...parent, ...self }`: every key `self` holds wins.
    pub fn over(self, parent: &StyleDisplay) -> StyleDisplay {
        let p = parent.clone();
        StyleDisplay {
            size_half_points: self.size_half_points.or(p.size_half_points),
            kern_half_points: self.kern_half_points.or(p.kern_half_points),
            color: self.color.or(p.color),
            bold: self.bold.or(p.bold),
            italic: self.italic.or(p.italic),
            bold_cs: self.bold_cs.or(p.bold_cs),
            italic_cs: self.italic_cs.or(p.italic_cs),
            size_cs_half_points: self.size_cs_half_points.or(p.size_cs_half_points),
            rtl: self.rtl.or(p.rtl),
            underline: self.underline.or(p.underline),
            strike: self.strike.or(p.strike),
            bdr: self.bdr.or(p.bdr),
            east_asia_font: self.east_asia_font.or(p.east_asia_font),
            font: self.font.or(p.font),
            font_ascii: self.font_ascii.or(p.font_ascii),
            ea_slot_empty: self.ea_slot_empty.or(p.ea_slot_empty),
            cs_font: self.cs_font.or(p.cs_font),
            char_spacing_twips: self.char_spacing_twips.or(p.char_spacing_twips),
            tab_stops: self.tab_stops.or(p.tab_stops),
            caps: self.caps.or(p.caps),
            shading: self.shading.or(p.shading),
            text_outline: self.text_outline.or(p.text_outline),
            line_spacing: self.line_spacing.or(p.line_spacing),
            line_rule: self.line_rule.or(p.line_rule),
            line_raw_twips: self.line_raw_twips.or(p.line_raw_twips),
            space_before_twips: self.space_before_twips.or(p.space_before_twips),
            space_after_twips: self.space_after_twips.or(p.space_after_twips),
            space_before_auto: self.space_before_auto.or(p.space_before_auto),
            space_after_auto: self.space_after_auto.or(p.space_after_auto),
            indent_left_twips: self.indent_left_twips.or(p.indent_left_twips),
            indent_right_twips: self.indent_right_twips.or(p.indent_right_twips),
            indent_first_line_twips: self.indent_first_line_twips.or(p.indent_first_line_twips),
            indent_chars: self.indent_chars.or(p.indent_chars),
            keep_next: self.keep_next.or(p.keep_next),
            keep_lines: self.keep_lines.or(p.keep_lines),
            suppress_line_numbers: self.suppress_line_numbers.or(p.suppress_line_numbers),
            page_break_before: self.page_break_before.or(p.page_break_before),
            widow_control: self.widow_control.or(p.widow_control),
            suppress_auto_hyphens: self.suppress_auto_hyphens.or(p.suppress_auto_hyphens),
            contextual_spacing: self.contextual_spacing.or(p.contextual_spacing),
            align: self.align.or(p.align),
            bidi: self.bidi.or(p.bidi),
            shading_fill: self.shading_fill.or(p.shading_fill),
            border_sides: self.border_sides.or(p.border_sides),
            auto_space_de: self.auto_space_de.or(p.auto_space_de),
            auto_space_dn: self.auto_space_dn.or(p.auto_space_dn),
            word_wrap: self.word_wrap.or(p.word_wrap),
            overflow_punct: self.overflow_punct.or(p.overflow_punct),
            east_asia_lang: self.east_asia_lang.or(p.east_asia_lang),
            vanish: self.vanish.or(p.vanish),
        }
    }

    /// The RUN_KEYS a linked character style takes from its paragraph twin:
    /// a key `self` does not hold at all takes `other`'s defined value.
    /// Returns whether any key was filled (`Object.keys(fill).length > 0`).
    pub fn fill_run_keys(&mut self, other: &StyleDisplay) -> bool {
        fn fill<T: Clone>(own: &mut Option<T>, other: &Option<T>, any: &mut bool) {
            if own.is_none() && other.is_some() {
                *own = other.clone();
                *any = true;
            }
        }
        // `self.display?.[key] === undefined`: a key holding undefined is
        // undefined here, yet the later `{ ...fill, ...self }` lets it win
        fn fill_slot(own: &mut SpreadSlot<JsNum>, other: &SpreadSlot<JsNum>, any: &mut bool) {
            if own.flatten().is_none() && other.flatten().is_some() {
                *any = true;
                if own.is_none() {
                    *own = *other;
                }
            }
        }
        let mut any = false;
        fill_slot(
            &mut self.size_half_points,
            &other.size_half_points,
            &mut any,
        );
        fill(&mut self.color, &other.color, &mut any);
        fill(&mut self.bold, &other.bold, &mut any);
        fill(&mut self.italic, &other.italic, &mut any);
        fill(&mut self.bold_cs, &other.bold_cs, &mut any);
        fill(&mut self.italic_cs, &other.italic_cs, &mut any);
        fill_slot(
            &mut self.size_cs_half_points,
            &other.size_cs_half_points,
            &mut any,
        );
        fill(&mut self.rtl, &other.rtl, &mut any);
        fill(&mut self.underline, &other.underline, &mut any);
        fill(&mut self.strike, &other.strike, &mut any);
        fill(&mut self.font, &other.font, &mut any);
        fill(&mut self.font_ascii, &other.font_ascii, &mut any);
        fill(&mut self.east_asia_font, &other.east_asia_font, &mut any);
        fill(&mut self.cs_font, &other.cs_font, &mut any);
        fill(&mut self.caps, &other.caps, &mut any);
        fill(&mut self.bdr, &other.bdr, &mut any);
        fill(&mut self.shading, &other.shading, &mut any);
        fill(&mut self.text_outline, &other.text_outline, &mut any);
        any
    }
}

/// `TabStop[]`; the props type carries no `Clone`.
#[derive(Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct TabStops(pub Vec<TabStop>);

impl Clone for TabStops {
    fn clone(&self) -> Self {
        TabStops(self.0.iter().map(clone_tab_stop).collect())
    }
}

pub(crate) fn clone_tab_stop(stop: &TabStop) -> TabStop {
    TabStop {
        pos: stop.pos,
        val: stop.val.clone(),
        leader: stop.leader.clone(),
        rel: stop.rel,
    }
}

/// `CellMargins`; the props type carries no `Clone`.
#[derive(Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Margins(pub CellMargins);

impl Clone for Margins {
    fn clone(&self) -> Self {
        Margins(CellMargins {
            top: self.0.top,
            left: self.0.left,
            bottom: self.0.bottom,
            right: self.0.right,
        })
    }
}

impl Margins {
    /// `{ ...parent, ...self }`
    fn over(&self, parent: &Margins) -> Margins {
        Margins(CellMargins {
            top: self.0.top.or(parent.0.top),
            left: self.0.left.or(parent.0.left),
            bottom: self.0.bottom.or(parent.0.bottom),
            right: self.0.right.or(parent.0.right),
        })
    }
}

/// `{ ...parent, ...child }` of two border sets.
fn borders_over(child: &Borders, parent: &Borders) -> Borders {
    let c = child.clone();
    let p = parent.clone();
    Borders {
        top: c.top.or(p.top),
        left: c.left.or(p.left),
        bottom: c.bottom.or(p.bottom),
        right: c.right.or(p.right),
        inside_h: c.inside_h.or(p.inside_h),
        inside_v: c.inside_v.or(p.inside_v),
        tl2br: c.tl2br.or(p.tl2br),
        tr2bl: c.tr2bl.or(p.tr2bl),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableParaSpacing {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_raw_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_spacing: Option<JsNum>,
}

/// Run and cell formatting one w:tblStylePr condition contributes.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCondFormat {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_half_points: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caps: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_ascii: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub char_spacing_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub borders: Option<Borders>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_mar_twips: Option<Margins>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub para_spacing: Option<TableParaSpacing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub para_jc: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WholeTable {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_half_points: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kern_half_points: Option<JsNum>,
}

/// Display-only formatting a table style contributes.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStyleDisplay {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whole_table: Option<WholeTable>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_row: Option<TableCondFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_col: Option<TableCondFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_col: Option<TableCondFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_row: Option<TableCondFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub band1_fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub band2_fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_band_size: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub borders: Option<Borders>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_mar_twips: Option<Margins>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub para_spacing: Option<TableParaSpacing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub para_jc: Option<String>,
}

/// `{ ...(a ?? {}), ...(b ?? {}) }` of one DEEP key, `None` when both are absent.
fn deep<T: Clone>(a: &Option<T>, b: &Option<T>, over: impl Fn(&T, &T) -> T) -> Option<T> {
    match (a, b) {
        (Some(a), Some(b)) => Some(over(b, a)),
        _ => b.clone().or_else(|| a.clone()),
    }
}

/// `{ ...a, ...b }` of a TableCondFormat, with `borders` and `cellMarTwips`
/// merged per side when both hold them.
fn cond_over(b: &TableCondFormat, a: &TableCondFormat) -> TableCondFormat {
    let (b, a) = (b.clone(), a.clone());
    TableCondFormat {
        fill: b.fill.or(a.fill),
        bold: b.bold.or(a.bold),
        italic: b.italic.or(a.italic),
        color: b.color.or(a.color),
        size_half_points: b.size_half_points.or(a.size_half_points),
        caps: b.caps.or(a.caps),
        font_ascii: b.font_ascii.or(a.font_ascii),
        char_spacing_twips: b.char_spacing_twips.or(a.char_spacing_twips),
        borders: match (&a.borders, &b.borders) {
            (Some(ab), Some(bb)) => Some(borders_over(bb, ab)),
            _ => b.borders.or(a.borders),
        },
        cell_mar_twips: match (&a.cell_mar_twips, &b.cell_mar_twips) {
            (Some(am), Some(bm)) => Some(bm.over(am)),
            _ => b.cell_mar_twips.or(a.cell_mar_twips),
        },
        para_spacing: b.para_spacing.or(a.para_spacing),
        para_jc: b.para_jc.or(a.para_jc),
    }
}

fn whole_table_over(b: &WholeTable, a: &WholeTable) -> WholeTable {
    let (b, a) = (b.clone(), a.clone());
    WholeTable {
        color: b.color.or(a.color),
        bold: b.bold.or(a.bold),
        italic: b.italic.or(a.italic),
        size_half_points: b.size_half_points.or(a.size_half_points),
        kern_half_points: b.kern_half_points.or(a.kern_half_points),
    }
}

fn para_spacing_over(b: &TableParaSpacing, a: &TableParaSpacing) -> TableParaSpacing {
    let (b, a) = (b.clone(), a.clone());
    TableParaSpacing {
        before_twips: b.before_twips.or(a.before_twips),
        after_twips: b.after_twips.or(a.after_twips),
        line_raw_twips: b.line_raw_twips.or(a.line_raw_twips),
        line_rule: b.line_rule.or(a.line_rule),
        line_spacing: b.line_spacing.or(a.line_spacing),
    }
}

/// `mergeTableDisplay`. The parent is never empty, so neither is the result.
pub(crate) fn merge_table_display(
    parent: &TableStyleDisplay,
    child: Option<&TableStyleDisplay>,
) -> Option<TableStyleDisplay> {
    let empty = TableStyleDisplay::default();
    let c = child.unwrap_or(&empty);
    let merged = TableStyleDisplay {
        fill: c.fill.clone().or_else(|| parent.fill.clone()),
        whole_table: deep(&parent.whole_table, &c.whole_table, whole_table_over),
        first_row: deep(&parent.first_row, &c.first_row, cond_over),
        first_col: deep(&parent.first_col, &c.first_col, cond_over),
        last_col: deep(&parent.last_col, &c.last_col, cond_over),
        last_row: deep(&parent.last_row, &c.last_row, cond_over),
        band1_fill: c.band1_fill.clone().or_else(|| parent.band1_fill.clone()),
        band2_fill: c.band2_fill.clone().or_else(|| parent.band2_fill.clone()),
        row_band_size: c.row_band_size.or(parent.row_band_size),
        borders: c.borders.clone().or_else(|| parent.borders.clone()),
        cell_mar_twips: c
            .cell_mar_twips
            .clone()
            .or_else(|| parent.cell_mar_twips.clone()),
        para_spacing: deep(&parent.para_spacing, &c.para_spacing, para_spacing_over),
        para_jc: c.para_jc.clone().or_else(|| parent.para_jc.clone()),
    };
    (merged != empty).then_some(merged)
}

/// `StyleInfo['numPr']`: `'none'` is an explicit w:numId 0.
#[derive(Debug, Clone, PartialEq)]
pub enum NumPr {
    None,
    Num { num_id: String, ilvl: JsNum },
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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleInfo {
    pub style_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
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

/// Document-wide defaults from styles.xml w:docDefaults.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocDefaults {
    #[serde(skip_serializing_if = "unset")]
    pub size_half_points: SpreadSlot<JsNum>,
    #[serde(skip_serializing_if = "unset")]
    pub size_cs_half_points: SpreadSlot<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold_cs: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic_cs: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widow_control: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_left_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_right_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_first_line_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_chars: Option<CharIndents>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kern_half_points: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ascii_font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub east_asia_font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ea_slot_empty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ea_from_lang: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ea_theme_slot: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cs_font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_spacing: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_raw_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_before_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_after_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_before_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_after_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rtl: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bidi: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub east_asia_lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppress_auto_hyphens: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_sides: Option<ParaBorderSides>,
}
