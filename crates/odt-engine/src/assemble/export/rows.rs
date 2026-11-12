//! `assemble/export/rows.ts`: row height floors for exported tables.
//!
//! Word grows a row to hold its cells: every cell paragraph takes its spacing
//! before, its lines and its spacing after. Hancom, reading an ODT, drops the
//! last paragraph's bottom spacing and the extra line spacing of the last line
//! in a cell, so a table without row heights comes out much shorter there (a
//! 12pt cell line is a 12pt row). Hancom's own ODT files state a minimum height
//! for every row; this does the same with a floor that never exceeds what Word
//! lays out: one line per paragraph at the faces' single line (the font size
//! for faces not listed) times the line spacing, cell margins, and the
//! paragraph spacing. Content taller than the floor still grows the row, in
//! every reader.

use docx_engine::model::{
    ParaFormat, ParaFormatLineRule, ParsedDoc, Run, StyleDisplay, StyleDisplayLineRule,
    StyleInfoType, TableCell, TableCellHMerge, TableCellTextDirection, TableModel,
    TableModelRowHeightRulesItem, TableParaSpacing, TableParaSpacingLineRule, TableParagraph,
    TableStyleDisplay,
};
use jscompat::{JsNum, Slot, js_regex, math_max, math_min};

use super::styles::document_defaults;
use super::theme::style_of;

/// `Slot<JsNum>` read as `number | undefined`.
fn num(slot: &Slot<JsNum>) -> Option<f64> {
    slot.map(|n| n.0)
}

/// The three line fields the floor reads of a `ParaFormat`.
#[derive(Clone, Copy)]
enum LineRule {
    Auto,
    AtLeast,
    Exact,
}

/// The `lineRule`, `lineRawTwips` and `lineSpacing` of a `ParaFormat` the
/// functions below build and read (a `ParaFormat` literal in the TypeScript).
#[derive(Clone, Copy)]
struct Line {
    rule: Option<LineRule>,
    raw_twips: Option<f64>,
    spacing: Option<f64>,
}

/// `arr[r] = value` on a JavaScript array: past the end it leaves holes, which
/// read as `undefined` and are written as `null`.
fn set_at<T>(items: &mut Vec<Option<T>>, r: usize, value: T) {
    while items.len() <= r {
        items.push(None);
    }
    items[r] = Some(value);
}

/// `withRowFloors`: the table with a minimum height on every row that Word
/// would lay out taller than the row's own height; exact heights stay.
pub fn with_row_floors(model: &TableModel, parsed: &ParsedDoc) -> TableModel {
    let table = model
        .tbl_style_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .and_then(|id| style_of(parsed, id))
        .and_then(|style| style.table_display.as_ref());
    let mut heights: Vec<Option<JsNum>> = model.row_heights_twips.clone().unwrap_or_default();
    let mut rules: Vec<Option<TableModelRowHeightRulesItem>> =
        model.row_height_rules.clone().unwrap_or_default();
    let mut changed = false;
    for (r, row) in model.rows.iter().enumerate() {
        if matches!(
            rules.get(r),
            Some(Some(TableModelRowHeightRulesItem::Exact))
        ) {
            continue;
        }
        let mut floor = 0.0;
        for cell in row {
            // merged cells spread over rows, vertical text runs across: no floor from them
            if *cell.grid_gap == Some(true)
                || cell.v_merge.is_some()
                || *cell.h_merge == Some(TableCellHMerge::Continue)
            {
                continue;
            }
            if matches!(
                *cell.text_direction,
                Some(TableCellTextDirection::TbRl | TableCellTextDirection::BtLr)
            ) {
                continue;
            }
            floor = math_max(floor, cell_floor(model, cell, table, parsed));
        }
        floor = f64::floor(floor);
        let current = heights.get(r).copied().flatten().map_or(0.0, |n| n.0);
        if floor <= 0.0 || floor <= current {
            continue;
        }
        set_at(&mut heights, r, JsNum(floor));
        set_at(&mut rules, r, TableModelRowHeightRulesItem::AtLeast);
        changed = true;
    }
    if !changed {
        return model.clone();
    }
    while heights.len() < model.rows.len() {
        heights.push(None);
    }
    while rules.len() < model.rows.len() {
        rules.push(None);
    }
    let mut out = model.clone();
    out.row_heights_twips = Some(heights);
    out.row_height_rules = Some(rules);
    out
}

/// `cellFloor`
fn cell_floor(
    model: &TableModel,
    cell: &TableCell,
    table: Option<&TableStyleDisplay>,
    parsed: &ParsedDoc,
) -> f64 {
    let fallback: Vec<TableParagraph>;
    let paras: &[TableParagraph] = match &*cell.rich_paras {
        Some(rich) => rich,
        None => {
            fallback = cell
                .paras
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|text| {
                    let mut run = Run::default();
                    run.text.set(text.clone());
                    TableParagraph {
                        para_format: ParaFormat::default(),
                        style_id: None,
                        list: None,
                        runs: vec![run],
                    }
                })
                .collect();
            &fallback
        }
    };
    if paras.is_empty() {
        return 0.0;
    }
    let margins = cell
        .cell_mar_twips
        .as_ref()
        .or(model.cell_mar_twips.as_ref());
    let top = margins.and_then(|m| num(&m.top)).unwrap_or(0.0);
    let bottom = margins.and_then(|m| num(&m.bottom)).unwrap_or(0.0);
    let mut height = math_max(0.0, top) + math_max(0.0, bottom);
    for para in paras {
        height += paragraph_floor(para, table, parsed);
    }
    height
}

/// `paragraphFloor`: one paragraph's least height in Word: one line and its
/// spacing.
fn paragraph_floor(
    para: &TableParagraph,
    table: Option<&TableStyleDisplay>,
    parsed: &ParsedDoc,
) -> f64 {
    let base = document_defaults(parsed.doc_defaults.as_ref());
    let style_id: Option<String> = para
        .style_id
        .clone()
        .or_else(|| default_paragraph_style(parsed));
    let none = StyleDisplay::default();
    let display: &StyleDisplay = style_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .and_then(|id| style_of(parsed, id))
        .and_then(|style| style.display.as_ref())
        .unwrap_or(&none);
    let spacing: Option<&TableParaSpacing> = table.and_then(|t| t.para_spacing.as_ref());
    let pf = &para.para_format;
    // a table style's paragraph spacing sits between the defaults and the
    // paragraph style; either may win, so the floor takes the smaller one
    let space = |direct: Option<f64>,
                 auto: Option<bool>,
                 style: Option<f64>,
                 fallback: f64,
                 from_table: Option<f64>| {
        if auto == Some(true) {
            return 0.0;
        }
        if let Some(direct) = direct {
            return math_max(0.0, direct);
        }
        let own = style.unwrap_or(fallback);
        math_max(0.0, math_min(own, from_table.unwrap_or(own)))
    };
    let contextual = (*pf.contextual_spacing)
        .or(*display.contextual_spacing)
        .unwrap_or(false);
    let before = if contextual {
        0.0
    } else {
        space(
            num(&pf.space_before),
            (*pf.space_before_auto).or(*display.space_before_auto),
            num(&display.space_before_twips),
            num(&base.para.space_before).unwrap_or(0.0),
            spacing.and_then(|s| s.before_twips).map(|n| n.0),
        )
    };
    let after = if contextual {
        0.0
    } else {
        space(
            num(&pf.space_after),
            (*pf.space_after_auto).or(*display.space_after_auto),
            num(&display.space_after_twips),
            num(&base.para.space_after).unwrap_or(0.0),
            spacing.and_then(|s| s.after_twips).map(|n| n.0),
        )
    };

    // a table style may set a smaller size its runs do not carry
    let mut style_size = num(&display.size_half_points)
        .or(num(&base.text.size_half_points))
        .unwrap_or(20.0);
    if let Some(table) = table {
        let sizes = [
            table.whole_table.as_ref().and_then(|f| f.size_half_points),
            table.first_row.as_ref().and_then(|f| f.size_half_points),
            table.last_row.as_ref().and_then(|f| f.size_half_points),
            table.first_col.as_ref().and_then(|f| f.size_half_points),
        ];
        for size in sizes.into_iter().flatten() {
            // `if (f?.sizeHalfPoints)`
            if size.0 != 0.0 && !size.0.is_nan() {
                style_size = math_min(style_size, size.0);
            }
        }
    }
    let latin = display
        .font_ascii
        .as_deref()
        .or(display.font.as_deref())
        .or(base.text.font_ascii.as_deref());
    let east_asia = display
        .east_asia_font
        .as_deref()
        .or(base.text.east_asia_font.as_deref());
    let natural = natural_line(&para.runs, style_size, latin, east_asia);
    let own = line_floor(&line_of(pf, display, &base.para), natural);
    let from_table = match spacing {
        Some(spacing) if pf.line_rule.is_none() && pf.line_spacing.is_none() => {
            line_floor(&table_line(spacing), natural)
        }
        _ => own,
    };
    before + after + math_min(own, from_table)
}

/// `lineOf`: the line rule a paragraph uses: its own, its style's, the
/// defaults'.
fn line_of(para: &ParaFormat, display: &StyleDisplay, base: &ParaFormat) -> Line {
    let of = |f: &ParaFormat| Line {
        // any other string reads as the automatic rule (`lineFloor` falls through)
        rule: (*f.line_rule).as_ref().map(|rule| match rule {
            ParaFormatLineRule::Auto | ParaFormatLineRule::Unlisted(_) => LineRule::Auto,
            ParaFormatLineRule::AtLeast => LineRule::AtLeast,
            ParaFormatLineRule::Exact => LineRule::Exact,
        }),
        raw_twips: num(&f.line_raw_twips),
        spacing: num(&f.line_spacing),
    };
    if para.line_rule.is_some() || para.line_spacing.is_some() {
        return of(para);
    }
    match *display.line_rule {
        Some(StyleDisplayLineRule::Exact) => {
            return Line {
                rule: Some(LineRule::Exact),
                raw_twips: num(&display.line_raw_twips),
                spacing: None,
            };
        }
        Some(StyleDisplayLineRule::AtLeast) => {
            return Line {
                rule: Some(LineRule::AtLeast),
                raw_twips: num(&display.line_raw_twips),
                spacing: None,
            };
        }
        _ => {}
    }
    if let Some(spacing) = num(&display.line_spacing).filter(|n| *n != 0.0 && !n.is_nan()) {
        return Line {
            rule: Some(LineRule::Auto),
            raw_twips: None,
            spacing: Some(spacing),
        };
    }
    of(base)
}

/// `tableLine`
fn table_line(spacing: &TableParaSpacing) -> Line {
    match spacing.line_rule {
        Some(TableParaSpacingLineRule::Exact) => {
            return Line {
                rule: Some(LineRule::Exact),
                raw_twips: spacing.line_raw_twips.map(|n| n.0),
                spacing: None,
            };
        }
        Some(TableParaSpacingLineRule::AtLeast) => {
            return Line {
                rule: Some(LineRule::AtLeast),
                raw_twips: spacing.line_raw_twips.map(|n| n.0),
                spacing: None,
            };
        }
        _ => {}
    }
    if let Some(raw) = spacing
        .line_raw_twips
        .map(|n| n.0)
        .filter(|n| *n != 0.0 && !n.is_nan())
    {
        return Line {
            rule: Some(LineRule::Auto),
            raw_twips: None,
            spacing: Some(raw / 240.0),
        };
    }
    Line {
        rule: Some(LineRule::Auto),
        raw_twips: None,
        spacing: Some(1.0),
    }
}

/// `lineFloor`: the line a rule gives over the faces' single line.
fn line_floor(f: &Line, natural: f64) -> f64 {
    match f.rule {
        Some(LineRule::Exact) => math_max(0.0, f.raw_twips.unwrap_or(0.0)),
        Some(LineRule::AtLeast) => math_max(f.raw_twips.unwrap_or(0.0), natural),
        _ => natural * math_max(0.0, f.spacing.unwrap_or(1.0)),
    }
}

/// `FACE_LINE` read as `faceLine` does: a face's single line over its size, as
/// Windows measures it (OS/2 winAscent + winDescent; Word's line is never
/// shorter). Faces not listed count as 1.
///
/// `FACE_LINE[face.toLowerCase()]` is a plain object lookup, so the keys
/// `constructor` and `__proto__` answer a function and an object, which
/// `Math.max` turns into NaN.
fn face_line(face: Option<&str>) -> f64 {
    let Some(face) = face.filter(|face| !face.is_empty()) else {
        return 1.0;
    };

    match face.to_lowercase().as_str() {
        "calibri" | "calibri light" => 1.2207,
        "cambria" => 1.1724,
        "arial" => 1.1172,
        "times new roman" => 1.1074,
        "malgun gothic" | "\u{b9d1}\u{c740} \u{ace0}\u{b515}" => 1.3301,
        "microsoft yahei" | "\u{5fae}\u{8f6f}\u{96c5}\u{9ed1}" => 1.3198,
        "constructor" | "__proto__" => f64::NAN,
        _ => 1.0,
    }
}

/// `naturalLine`: the tallest single line of the paragraph's text, in twips:
/// each run's size times the line of the face its characters use. An empty
/// paragraph has its mark's size.
fn natural_line(
    runs: &[Run],
    style_size: f64,
    style_latin: Option<&str>,
    style_east_asia: Option<&str>,
) -> f64 {
    let mut line = 0.0;
    for run in runs {
        let text = run.text.as_deref().unwrap_or("");
        if run.image.is_some() || text.is_empty() {
            continue;
        }
        let size = num(&run.size_half_points).unwrap_or(style_size) * 10.0;
        let mut ratio = 1.0;
        if js_regex!(r"[\u0021-\u007e\u00a0-\u024f]").test(text) {
            ratio = math_max(ratio, face_line(run.font_ascii.as_deref().or(style_latin)));
        }
        if js_regex!(r"[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]")
            .test(text)
        {
            ratio = math_max(
                ratio,
                face_line(run.east_asia_font.as_deref().or(style_east_asia)),
            );
        }
        line = math_max(line, size * ratio);
    }
    // `line || style.size * 10`
    if line == 0.0 || line.is_nan() {
        style_size * 10.0
    } else {
        line
    }
}

/// `defaultParagraphStyle`
fn default_paragraph_style(parsed: &ParsedDoc) -> Option<String> {
    for (_, s) in &parsed.styles.0 {
        if s.r#type == StyleInfoType::Paragraph && s.is_default == Some(true) {
            return Some(s.style_id.clone());
        }
    }
    style_of(parsed, "Normal").map(|_| "Normal".to_owned())
}
