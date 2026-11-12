//! `parseDataTable`, `letterSpacingPt`, `serColor`, `labelBox`, `parseAxis`
//! and `collectText` of chart.ts, in its order (the point readers between
//! them are in `points.rs`).

use jscompat::{JsNum, trim};
use serde_json::Value;

use super::model::{ChartAxisStyle, ChartDataTable};
use super::node::{
    Node, as_str, at0, ct_boolean, first, get, has_key, int, is, is_object, list, number,
    string_of, truthy, val, xsd_boolean,
};
use super::points::read_str_points;
use crate::color::resolve_color_node;
use crate::theme::Theme;

fn color(node: Node<'_>, theme: Option<&Theme>) -> Option<String> {
    resolve_color_node(node, theme, None)
}

pub(crate) fn parse_data_table(node: Node<'_>, theme: Option<&Theme>) -> ChartDataTable {
    let on = |k: &str| ct_boolean(get(node, k), true, true);
    let mut out = ChartDataTable {
        show_keys: on("c:showKeys"),
        horz_border: on("c:showHorzBorder"),
        vert_border: on("c:showVertBorder"),
        outline: on("c:showOutline"),
        size_pt: None,
        text_color: None,
        line_color: None,
    };
    let p = get(get(node, "c:txPr"), "a:p");
    let r_pr = get(get(first(p), "a:pPr"), "a:defRPr");
    let sz = int(get(r_pr, "@_sz"));
    if sz.is_finite() && sz > 0.0 {
        out.size_pt = Some(JsNum(sz / 100.0));
    }
    out.text_color = color(get(r_pr, "a:solidFill"), theme);
    out.line_color = color(get(get(get(node, "c:spPr"), "a:ln"), "a:solidFill"), theme);
    out
}

/// a:rPr spc (1/100 pt) as pt; 0/absent is `None`.
pub(crate) fn letter_spacing_pt(raw: Node<'_>) -> Option<f64> {
    // String(raw ?? '')
    let text = match raw {
        None | Some(Value::Null) => String::new(),
        some => string_of(some),
    };
    let v = jscompat::parse_int(&text, jscompat::Radix::Ten);
    (v.is_finite() && v != 0.0).then(|| v / 100.0)
}

/// Series main color: line-family series read the ln stroke first; bars/pies read the
/// solidFill first (their ln is a segment outline, e.g. black borders around bars).
pub(crate) fn ser_color(ser: &Value, theme: Option<&Theme>, prefer_line: bool) -> Option<String> {
    let sp_pr = get(Some(ser), "c:spPr");
    if !truthy(sp_pr) {
        return None;
    }
    let ln_color = color(get(get(sp_pr, "a:ln"), "a:solidFill"), theme);
    let fill_color = color(get(sp_pr, "a:solidFill"), theme);
    if prefer_line {
        ln_color.or(fill_color)
    } else {
        fill_color.or(ln_color)
    }
}

/// `labelBox`: `fill`/`border` absent = inherit, `Some(None)` = explicit
/// a:noFill (`null`).
#[derive(Debug, Default)]
pub(crate) struct LabelBox {
    pub fill: Option<Option<String>>,
    pub border: Option<Option<String>>,
}

/// c:dLbls / c:dLbl spPr: solid label-box fill and outline colors.
pub(crate) fn label_box(sp_pr: Node<'_>, theme: Option<&Theme>) -> Result<LabelBox, String> {
    let mut out = LabelBox::default();
    let Some(sp) = sp_pr.filter(|sp| is_object(Some(*sp))) else {
        return Ok(out);
    };
    // empty elements parse as '' — test for presence, not truthiness
    if has_key(sp, "a:noFill")? {
        out.fill = Some(None);
    } else if let Some(fill) = color(get(Some(sp), "a:solidFill"), theme) {
        out.fill = Some(Some(fill));
    }
    let ln = get(Some(sp), "a:ln");
    if let Some(ln) = ln.filter(|ln| truthy(Some(*ln)) && is_object(Some(*ln))) {
        if has_key(ln, "a:noFill")? {
            out.border = Some(None);
        } else if let Some(border) = color(get(Some(ln), "a:solidFill"), theme) {
            out.border = Some(Some(border));
        }
    }
    Ok(out)
}

pub(crate) fn parse_axis(
    ax: Node<'_>,
    theme: Option<&Theme>,
    budget: &mut f64,
) -> Result<Option<ChartAxisStyle>, String> {
    if !truthy(ax) || !is_object(ax) {
        return Ok(None);
    }
    let mut out = ChartAxisStyle::default();
    if ct_boolean(get(ax, "c:delete"), false, false) {
        out.hidden = Some(true);
    }
    let scaling = get(ax, "c:scaling");
    // Corrupt axis bounds (c:min val="Infinity") would poison chart scale math:
    // assign only finite values, else the axis auto-scales.
    let min_raw = val(scaling, "c:min");
    let min = number(min_raw);
    if min_raw.is_some() && min.is_finite() {
        out.min = Some(JsNum(min));
    }
    let max_raw = val(scaling, "c:max");
    let max = number(max_raw);
    if max_raw.is_some() && max.is_finite() {
        out.max = Some(JsNum(max));
    }
    if is(val(scaling, "c:orientation"), "maxMin") {
        out.reversed = Some(true);
    }
    let log_base = number(val(scaling, "c:logBase"));
    if log_base.is_finite() && (2.0..=1000.0).contains(&log_base) {
        out.log_base = Some(JsNum(log_base));
    }
    let crosses = val(ax, "c:crosses");
    if let Some(crosses @ ("autoZero" | "min" | "max")) = as_str(crosses) {
        out.crosses = Some(crosses.to_owned());
    }
    let tick_lbl_pos = as_str(val(ax, "c:tickLblPos"));
    match tick_lbl_pos {
        Some("none") => out.tick_lbl_hidden = Some(true),
        Some(pos @ ("low" | "high")) => out.tick_lbl_pos = Some(pos.to_owned()),
        _ => {}
    }
    let tx_p = get(get(ax, "c:txPr"), "a:p");
    let def_r_pr =
        get(get(at0(tx_p), "a:pPr"), "a:defRPr").or_else(|| get(get(tx_p, "a:pPr"), "a:defRPr"));
    if truthy(def_r_pr) {
        if let Some(c) = color(get(def_r_pr, "a:solidFill"), theme) {
            out.label_color = Some(c);
        }
        // sz="auto" parses to NaN, and a NaN labelSizePt beats the render default
        let ax_sz = int(get(def_r_pr, "@_sz"));
        if ax_sz.is_finite() && ax_sz > 0.0 {
            out.label_size_pt = Some(JsNum(ax_sz / 100.0));
        }
        if xsd_boolean(get(def_r_pr, "@_b"), false) {
            out.label_bold = Some(true);
        }
        if is(get(def_r_pr, "@_cap"), "all") {
            out.label_caps = Some(true);
        }
        if let Some(spc) = letter_spacing_pt(get(def_r_pr, "@_spc")) {
            out.label_spc_pt = Some(JsNum(spc));
        }
        // INT_MIN baseline sentinel (Aspose-written): PowerPoint reserves the label space
        // but renders nothing there
        if is(get(def_r_pr, "@_baseline"), "-2147483648") {
            out.tick_lbl_garbage = Some(true);
        }
    }
    // rot outside +-90 deg (e.g. Office's auto marker -60000000) is not an explicit rotation
    let rot = int(get(get(get(ax, "c:txPr"), "a:bodyPr"), "@_rot"));
    if rot.is_finite() && rot != 0.0 && rot.abs() <= 5_400_000.0 {
        out.label_rot_deg = Some(JsNum(rot / 60000.0));
    }
    if let Some(num_fmt) = as_str(get(get(ax, "c:numFmt"), "@_formatCode"))
        && !num_fmt.is_empty()
        && num_fmt != "General"
    {
        out.num_fmt = Some(num_fmt.to_owned());
    }
    out.line_color = color(get(get(get(ax, "c:spPr"), "a:ln"), "a:solidFill"), theme);
    let ax_ln = get(get(ax, "c:spPr"), "a:ln");
    if let Some(ax_ln) = ax_ln.filter(|ln| truthy(Some(*ln)) && is_object(Some(*ln)))
        && has_key(ax_ln, "a:noFill")?
    {
        out.line_hidden = Some(true);
    }
    // A self-closing <c:majorGridlines/> (no spPr) parses to an empty string; still counts as having gridlines
    let grid = get(ax, "c:majorGridlines");
    if grid.is_some() {
        let ln = if is_object(grid) {
            get(get(grid, "c:spPr"), "a:ln")
        } else {
            None
        };
        let gc = color(get(ln, "a:solidFill"), theme);
        out.grid_color = Some(gc.clone().unwrap_or_else(|| "#E6E6E6".to_owned()));
        if gc.is_none() {
            out.grid_color_auto = Some(true);
        }
        let dash = val(ln, "a:prstDash");
        if truthy(dash) && !is(dash, "solid") {
            out.grid_dash = Some(true);
            out.grid_dash_val = Some(string_of(dash));
        }
        let w = int(get(ln, "@_w"));
        if w.is_finite() && w > 0.0 {
            out.grid_width_emu = Some(JsNum(w));
        }
    }
    let minor = get(ax, "c:minorGridlines");
    if minor.is_some() {
        let ln = if is_object(minor) {
            get(get(minor, "c:spPr"), "a:ln")
        } else {
            None
        };
        if let Some(gc) = color(get(ln, "a:solidFill"), theme) {
            out.minor_grid_color = Some(gc);
            let w = int(get(ln, "@_w"));
            if w.is_finite() && w > 0.0 {
                out.minor_grid_width_emu = Some(JsNum(w));
            }
        } else {
            out.minor_grid_auto = Some(true);
        }
    }
    let major_unit = number(val(ax, "c:majorUnit"));
    if major_unit.is_finite() && major_unit > 0.0 {
        out.major_unit = Some(JsNum(major_unit));
    }
    let minor_unit = number(val(ax, "c:minorUnit"));
    if minor_unit.is_finite() && minor_unit > 0.0 {
        out.minor_unit = Some(JsNum(minor_unit));
    }
    let lbl_skip = int(val(ax, "c:tickLblSkip"));
    if lbl_skip.is_finite() && lbl_skip > 1.0 {
        out.tick_lbl_skip = Some(JsNum(lbl_skip));
    }
    let mark_skip = int(val(ax, "c:tickMarkSkip"));
    if mark_skip.is_finite() && mark_skip > 1.0 {
        out.tick_mark_skip = Some(JsNum(mark_skip));
    }
    // Axis title: rich text, else a cell-linked strRef cache; a <c:title> with no c:tx at all
    // shows PowerPoint's "Axis Title" placeholder
    let title_node = get(ax, "c:title");
    let title = match collect_text(get(get(title_node, "c:tx"), "c:rich"), "") {
        Some(text) => Some(text),
        None => match read_str_points(get(title_node, "c:tx"), false, budget)?
            .into_iter()
            .next()
        {
            Some(text) => Some(text),
            None => (truthy(title_node) && !truthy(get(title_node, "c:tx")))
                .then(|| "Axis Title".to_owned()),
        },
    };
    if let Some(title) = title.filter(|t| !t.is_empty()) {
        out.title = Some(title);
        if ct_boolean(get(title_node, "c:overlay"), false, false) {
            out.title_overlay = Some(true);
        }
        let tp0 = first(get(get(get(title_node, "c:tx"), "c:rich"), "a:p"));
        let tr0 = first(get(tp0, "a:r"));
        let txp = get(get(title_node, "c:txPr"), "a:p");
        let r_pr = get(tr0, "a:rPr")
            .or_else(|| get(get(tp0, "a:pPr"), "a:defRPr"))
            .or_else(|| get(get(first(txp), "a:pPr"), "a:defRPr"));
        if truthy(r_pr) {
            let sz = int(get(r_pr, "@_sz"));
            if sz.is_finite() && sz > 0.0 {
                out.title_size_pt = Some(JsNum(sz / 100.0));
            }
            if xsd_boolean(get(r_pr, "@_b"), false) {
                out.title_bold = Some(true);
            }
            if xsd_boolean(get(r_pr, "@_i"), false) {
                out.title_italic = Some(true);
            }
            out.title_color = color(get(r_pr, "a:solidFill"), theme);
        }
    }
    Ok((!out.is_empty()).then_some(out))
}

/// Collect all a:t inside a rich text node, paragraphs joined by `para_sep`.
pub(crate) fn collect_text(rich: Node<'_>, para_sep: &str) -> Option<String> {
    if !truthy(rich) {
        return None;
    }
    let mut para_texts: Vec<String> = Vec::new();
    for p in list(get(rich, "a:p")) {
        let mut parts = String::new();
        for r in list(get(Some(p), "a:r")) {
            match get(Some(r), "a:t") {
                Some(Value::String(t)) => parts.push_str(t),
                t => match get(t, "#text") {
                    None | Some(Value::Null) => {}
                    some => parts.push_str(&string_of(some)),
                },
            }
        }
        para_texts.push(parts);
    }
    let s = para_texts.join(para_sep);
    (!trim(&s).is_empty()).then_some(s)
}
