//! The table section of parse.ts (3176-3377): `a:tbl` of a graphic frame.

use jscompat::{JsNum, Radix, Slot, parse_int, value_to_string, value_truthy};
use serde_json::{Map, Value};

use super::context::{Node, ParseContext};
use super::decor::int_or;
use super::fill::parse_fill;
use super::shape::{parse_stroke, parse_xfrm};
use super::text::parse_text_body;
use crate::placeholder::{LevelTextStyle, TextStyleLevels};
use crate::table_grid::{GridCell, table_row_grid_cols};
use crate::table_style::{
    CellStyleBorders, TablePartStyle, TableStyleFlags, cell_part_style, cell_style_borders,
    resolve_table_style,
};
use crate::theme::resolve_font_ref;
use crate::types::ByteAnchor;
use crate::types::{
    CellBevel, ElementType, Fill, TableCell, TableCellBorders, TableElement, TextAnchor,
    TextInsets, assigned,
};

/// `node?.[key]` where `node` is an element: a string or a list has no such
/// key (the keys read here are never indices or string methods).
fn get<'a>(node: Node<'a>, key: &str) -> Node<'a> {
    node.and_then(Value::as_object).and_then(|o| o.get(key))
}

/// `Array.isArray(raw) ? raw : raw ? [raw] : []`, items as they are.
fn list(raw: Node<'_>) -> Vec<&Value> {
    match raw {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(v) if value_truthy(Some(v)) => vec![v],
        _ => Vec::new(),
    }
}

/// `array[i]` with a number index: only a non-negative integer below the
/// length finds an item.
fn at(items: &[Value], i: f64) -> Option<&Value> {
    if i >= 0.0 && i.fract() == 0.0 && i < items.len() as f64 {
        items.get(i as usize)
    } else {
        None
    }
}

/// `tc['@_gridSpan'] ? parseInt(tc['@_gridSpan'], 10) : undefined`
fn span_attr(v: Node<'_>) -> Option<f64> {
    value_truthy(v).then(|| parse_int(&value_to_string(v), Radix::Ten))
}

/// `xsdBool`: PowerPoint writes "1", third-party writers "true"/"True".
fn xsd_bool(v: Node<'_>) -> bool {
    let s = match v {
        None | Some(Value::Null) => String::new(),
        v => value_to_string(v),
    }
    .to_lowercase();
    s == "1" || s == "true"
}

/// `parseTable`
pub(super) fn parse_table(
    node: Node<'_>,
    tbl: Node<'_>,
    anchor: ByteAnchor,
    ctx: &ParseContext<'_>,
) -> Result<Option<TableElement>, String> {
    if tbl.is_none_or(Value::is_null) {
        return Err(
            "TypeError: Cannot read properties of undefined (reading 'a:tblGrid')".to_owned(),
        );
    }
    let grid_raw = get(get(tbl, "a:tblGrid"), "a:gridCol");
    let col_widths: Vec<f64> = list(grid_raw)
        .into_iter()
        .map(|g| int_or(get(Some(g), "@_w"), 0.0))
        .collect();
    let trs = list(get(tbl, "a:tr"));
    if col_widths.is_empty() || trs.is_empty() {
        return Ok(None);
    }

    // Table style: the styleId referenced by tblPr
    let tbl_pr = get(tbl, "a:tblPr");
    let style_id_raw = get(tbl_pr, "a:tableStyleId");
    let style_id: Option<&str> = match style_id_raw {
        Some(Value::String(s)) => Some(s.as_str()),
        raw => get(raw, "#text").and_then(Value::as_str),
    };
    // No tableStyleId and no cell line of its own: "No Style, Table Grid"
    let cells_define_lines = trs.iter().any(|tr| {
        list(get(Some(tr), "a:tc")).into_iter().any(|tc| {
            ["a:lnL", "a:lnR", "a:lnT", "a:lnB"]
                .iter()
                .any(|k| get(get(Some(tc), "a:tcPr"), k).is_some())
        })
    });
    let style_def = resolve_table_style(
        style_id.or(if cells_define_lines {
            None
        } else {
            Some("{5940675A-B579-460E-94D1-54222C63F5DA}")
        }),
        ctx.table_styles,
        ctx.theme,
    );
    // <a:tblBg>: direct fill, or a fillRef instantiated from the theme fill styles
    let mut bg_fill: Option<Fill> = style_def.as_ref().and_then(|d| d.tbl_bg.as_ref().cloned());
    if bg_fill.is_none()
        && let Some(bg_ref) = style_def.as_ref().and_then(|d| d.tbl_bg_ref.as_ref())
    {
        let idx = bg_ref.idx.0;
        let ph_clr = bg_ref.ph_clr.as_deref();
        let tpl = if idx > 1000.0 {
            ctx.theme
                .and_then(|t| t.bg_fill_styles.as_ref())
                .and_then(|s| at(s, idx - 1001.0))
        } else {
            ctx.theme
                .and_then(|t| t.fill_styles.as_ref())
                .and_then(|s| at(s, idx - 1.0))
        };
        bg_fill = if value_truthy(tpl) {
            let tpl_ctx = ParseContext {
                ph_clr,
                media_rels: ctx.theme_media_rels.or(ctx.media_rels),
                ..*ctx
            };
            parse_fill(tpl, &tpl_ctx)
        } else {
            None
        };
        if bg_fill.is_none()
            && let Some(ph_clr) = ph_clr.filter(|s| !s.is_empty())
        {
            bg_fill = Some(Fill::Solid {
                color: ph_clr.to_owned(),
            });
        }
    }
    let flags = TableStyleFlags {
        first_row: xsd_bool(get(tbl_pr, "@_firstRow")),
        last_row: xsd_bool(get(tbl_pr, "@_lastRow")),
        first_col: xsd_bool(get(tbl_pr, "@_firstCol")),
        last_col: xsd_bool(get(tbl_pr, "@_lastCol")),
        band_row: xsd_bool(get(tbl_pr, "@_bandRow")),
        band_col: xsd_bool(get(tbl_pr, "@_bandCol")),
    };

    let n_rows = trs.len() as f64;
    let n_cols = col_widths.len() as f64;
    let row_heights: Vec<JsNum> = trs
        .iter()
        .map(|tr| JsNum(int_or(get(Some(tr), "@_h"), 0.0)))
        .collect();
    let mut rows: Vec<Vec<TableCell>> = Vec::with_capacity(trs.len());
    for (r, tr) in trs.iter().enumerate() {
        let tcs = list(get(Some(tr), "a:tc"));
        let cells: Vec<GridCell> = tcs
            .iter()
            .map(|tc| GridCell {
                grid_span: Some(match span_attr(get(Some(tc), "@_gridSpan")) {
                    Some(n) if n != 0.0 && !n.is_nan() => n,
                    _ => 1.0,
                }),
                merged: Some(
                    xsd_bool(get(Some(tc), "@_hMerge")) || xsd_bool(get(Some(tc), "@_vMerge")),
                ),
            })
            .collect();
        let grid_cols = table_row_grid_cols(&cells);
        let mut row = Vec::with_capacity(tcs.len());
        for (i, tc) in tcs.iter().enumerate() {
            let c = grid_cols.get(i).copied().unwrap_or(f64::NAN);
            let part = style_def
                .as_ref()
                .map(|d| cell_part_style(d, &flags, r as f64, c, n_rows, n_cols));
            let inside = style_def
                .as_ref()
                .map(|d| cell_style_borders(d, &flags, r as f64, c, n_rows, n_cols));
            row.push(parse_table_cell(
                Some(tc),
                ctx,
                part.as_ref(),
                inside.as_ref(),
            )?);
        }
        rows.push(row);
    }

    let id = ctx.uid("tbl");
    let Some(node) = node.filter(|v| !v.is_null()) else {
        return Err("TypeError: Cannot read properties of undefined (reading 'p:xfrm')".to_owned());
    };
    let name = get(
        get(get(Some(node), "p:nvGraphicFramePr"), "p:cNvPr"),
        "@_name",
    )
    .and_then(Value::as_str)
    .map(str::to_owned);
    Ok(Some(TableElement {
        id: Slot::of(id),
        r#type: Slot::of(ElementType::Table),
        anchor: Slot::of(anchor),
        transform: Slot::of(parse_xfrm(get(Some(node), "p:xfrm"))),
        name: assigned(name),
        col_widths: Slot::of(col_widths.into_iter().map(JsNum).collect()),
        row_heights: Slot::of(row_heights),
        rows: Slot::of(rows),
        style_id: Slot::maybe(style_id.filter(|s| !s.is_empty()).map(str::to_owned)),
        style_flags: Slot::of(flags),
        rtl: Slot::maybe(xsd_bool(get(tbl_pr, "@_rtl")).then_some(true)),
        bg_fill: Slot::maybe(bg_fill.filter(|f| !matches!(f, Fill::None))),
        ..TableElement::default()
    }))
}

/// `parseTableCell`
fn parse_table_cell(
    tc: Node<'_>,
    ctx: &ParseContext<'_>,
    part: Option<&TablePartStyle>,
    inside: Option<&CellStyleBorders>,
) -> Result<TableCell, String> {
    let empty = Value::Object(Map::new());
    let tc_pr = get(tc, "a:tcPr").filter(|v| !v.is_null()).unwrap_or(&empty);
    let tc_pr = Some(tc_pr);
    let mut cell = TableCell::default();

    let tx_body = get(tc, "a:txBody");
    if value_truthy(tx_body) {
        // Table-style text defaults injected at the end of the inheritance chain
        let mut style_chain: Vec<TextStyleLevels> = Vec::new();
        if let Some(part) = part.filter(|p| {
            p.bold.is_some()
                || p.text_color.as_deref().is_some_and(|s| !s.is_empty())
                || p.font_ref.as_deref().is_some_and(|s| !s.is_empty())
                || p.font.is_some()
        }) {
            let mut level = LevelTextStyle::default();
            if let Some(bold) = *part.bold {
                level.bold.set(bold);
            }
            if let Some(color) = part.text_color.as_deref().filter(|s| !s.is_empty()) {
                level.color.set(color.to_owned());
            }
            // fontRef picks the theme scheme as unresolved refs so a run re-resolves
            // +mn-ea with its own script
            if let Some(font_ref) = part.font_ref.as_deref().filter(|s| !s.is_empty()) {
                let pre = if font_ref == "major" { "+mj" } else { "+mn" };
                let lt = format!("{pre}-lt");
                let ea = format!("{pre}-ea");
                let cs = format!("{pre}-cs");
                let latin_font = resolve_font_ref(Some(&lt), ctx.theme, None).map(str::to_owned);
                let ea_font = resolve_font_ref(Some(&ea), ctx.theme, None).map(str::to_owned);
                let cs_font = resolve_font_ref(Some(&cs), ctx.theme, None).map(str::to_owned);
                if let Some(latin_font) = latin_font.filter(|s| !s.is_empty()) {
                    level.latin_font.set(latin_font);
                    level.latin_font_ref.set(lt);
                }
                if let Some(ea_font) = ea_font.filter(|s| !s.is_empty()) {
                    level.ea_font.set(ea_font);
                    level.ea_font_ref.set(ea);
                }
                if let Some(cs_font) = cs_font.filter(|s| !s.is_empty()) {
                    level.cs_font.set(cs_font);
                }
            }
            let font = part.font.as_ref();
            if let Some(latin) = font
                .and_then(|f| f.latin.as_deref())
                .filter(|s| !s.is_empty())
            {
                level.latin_font.set(latin.to_owned());
                level.latin_font_ref.delete();
            }
            if let Some(ea) = font.and_then(|f| f.ea.as_deref()).filter(|s| !s.is_empty()) {
                level.ea_font.set(ea.to_owned());
                level.ea_font_ref.delete();
            }
            if let Some(cs) = font.and_then(|f| f.cs.as_deref()).filter(|s| !s.is_empty()) {
                level.cs_font.set(cs.to_owned());
            }
            style_chain.push(TextStyleLevels {
                levels: vec![Some(level)],
                src: Some("table style".to_owned()),
            });
        }
        // Cell text without its own size sits on presentation.xml defaultTextStyle
        if let Some(dflt) = ctx.default_text_style {
            let mut levels = dflt.clone();
            levels.src = Some("presentation defaultTextStyle".to_owned());
            style_chain.push(levels);
        }
        let mut text = parse_text_body(tx_body, ctx, &style_chain, None)?;
        // Cell vertical alignment and insets come from tcPr. ledger
        // inherited-key-parse-3319: the TypeScript's anchorMap[v] answers for
        // `__proto__` (an `{}` anchor) and for `constructor`, `toString`...
        // (a function, which JSON drops); here only the own keys answer.
        let anchor = get(tc_pr, "@_anchor");
        if value_truthy(anchor) {
            text.anchor.assign(match anchor.and_then(Value::as_str) {
                Some("t") => Some(TextAnchor::Top),
                Some("ctr") => Some(TextAnchor::Middle),
                Some("b") => Some(TextAnchor::Bottom),
                _ => None,
            });
        }
        let mut insets = TextInsets::default();
        insets.l.set(JsNum(int_or(get(tc_pr, "@_marL"), 91440.0)));
        insets.r.set(JsNum(int_or(get(tc_pr, "@_marR"), 91440.0)));
        insets.t.set(JsNum(int_or(get(tc_pr, "@_marT"), 45720.0)));
        insets.b.set(JsNum(int_or(get(tc_pr, "@_marB"), 45720.0)));
        text.insets.set(insets);
        cell.text.set(text);
    }

    // Fill: explicit tcPr fill > table-style region fill; an explicit
    // <a:noFill/> still overrides the style fill
    if let Some(fill) = parse_fill(tc_pr, ctx) {
        if !matches!(fill, Fill::None) {
            cell.fill.set(fill);
        }
    } else if let Some(fill) = part.and_then(|p| p.fill.as_ref()) {
        cell.fill.set(fill.clone());
    }

    let cell3d = get(tc_pr, "a:cell3D");
    if matches!(cell3d, Some(Value::Object(_) | Value::Array(_))) {
        let bv = get(cell3d, "a:bevel");
        let preset = get(bv, "@_prst")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let dir = get(get(cell3d, "a:lightRig"), "@_dir")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        cell.bevel.set(CellBevel {
            width_emu: JsNum(int_or(get(bv, "@_w"), 76200.0)),
            preset: preset.map(str::to_owned),
            light_dir: dir.map(str::to_owned),
        });
    }

    // Borders on four edges: a:lnL/R/T/B share a:ln's structure; style
    // inside borders as fallback
    let mut borders = TableCellBorders::default();
    for (key, tag) in [
        ("l", "a:lnL"),
        ("r", "a:lnR"),
        ("t", "a:lnT"),
        ("b", "a:lnB"),
    ] {
        let Some(ln) = get(tc_pr, tag).filter(|v| matches!(v, Value::Object(_) | Value::Array(_)))
        else {
            continue;
        };
        // PowerPoint ignores a zero-width cell border and draws the style's line
        if get(Some(ln), "@_w").and_then(Value::as_str) == Some("0")
            && get(Some(ln), "a:noFill").is_none()
        {
            continue;
        }
        let mut wrapper = Map::new();
        wrapper.insert("a:ln".to_owned(), ln.clone());
        let wrapper = Value::Object(wrapper);
        if let Some(Some(stroke)) = parse_stroke(Some(&wrapper), ctx, None) {
            border_slot(&mut borders, key).set(stroke);
        }
    }
    if let Some(inside) = inside {
        for (key, own) in [
            ("l", &inside.l),
            ("r", &inside.r),
            ("t", &inside.t),
            ("b", &inside.b),
        ] {
            if let Some(stroke) = own.as_ref() {
                let slot = border_slot(&mut borders, key);
                if slot.is_none() {
                    slot.set(stroke.clone());
                }
            }
        }
    }
    if !borders.has_no_key() {
        cell.borders.set(borders);
    }

    let grid_span = span_attr(get(tc, "@_gridSpan"));
    let row_span = span_attr(get(tc, "@_rowSpan"));
    if let Some(n) = grid_span.filter(|n| *n > 1.0) {
        cell.grid_span.set(JsNum(n));
    }
    if let Some(n) = row_span.filter(|n| *n > 1.0) {
        cell.row_span.set(JsNum(n));
    }
    if xsd_bool(get(tc, "@_hMerge")) || xsd_bool(get(tc, "@_vMerge")) {
        cell.merged.set(true);
    }

    Ok(cell)
}

fn border_slot<'a>(
    borders: &'a mut TableCellBorders,
    key: &str,
) -> &'a mut Slot<crate::types::Stroke> {
    match key {
        "l" => &mut borders.l,
        "r" => &mut borders.r,
        "t" => &mut borders.t,
        _ => &mut borders.b,
    }
}
