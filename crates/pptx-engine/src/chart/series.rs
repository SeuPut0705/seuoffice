//! `parsePlotSeries`, the closure of `parseChartXml` that reads the series
//! of one plot node.

use jscompat::{JsNum, sort_by_number};
use serde_json::Value;

use super::ResolveFill;
use super::model::{CategoryGroup, ChartKind, ChartSeries, DLblOverride, PointLine};
use super::node::{
    Node, as_str, ct_boolean, first, get, has_key, int, is, is_object, list, or0, string_of,
    truthy, val, xsd_boolean,
};
use super::points::{
    ALLOC_FAILED, MAX_CHART_SERIES, cache_format_code, read_date_serials, read_num_points,
    read_points, read_str_points, try_collect,
};
use super::style::{collect_text, label_box, ser_color};
use crate::color::resolve_color_node;
use crate::theme::Theme;
use crate::types::Fill;

/// One of `plotGroups`.
pub(crate) struct PlotGroup {
    pub start: usize,
    pub end: usize,
    pub stacked: bool,
    pub hbar: bool,
}

/// What `parsePlotSeries` reads from and writes to in `parseChartXml`.
pub(crate) struct SeriesState<'t> {
    pub theme: Option<&'t Theme>,
    pub resolve_fill: Option<ResolveFill<'t>>,
    pub date1904: bool,
    /// `tailPaddingLeft`
    pub budget: f64,
    pub series: Vec<ChartSeries>,
    pub plot_groups: Vec<PlotGroup>,
    pub categories: Vec<String>,
    pub cat_serials: Option<Vec<f64>>,
    pub category_groups: Option<Vec<CategoryGroup>>,
}

fn color(node: Node<'_>, theme: Option<&Theme>) -> Option<String> {
    resolve_color_node(node, theme, None)
}

/// `arr[idx] = value` on a sparse array, `idx` below the length of the
/// series' values.
fn set_at<T: Clone>(arr: &mut Vec<Option<T>>, idx: usize, value: T) -> Result<(), String> {
    if arr.len() <= idx {
        arr.try_reserve_exact(idx + 1 - arr.len())
            .map_err(|_| ALLOC_FAILED.to_owned())?;
        arr.resize(idx + 1, None);
    }
    arr[idx] = Some(value);
    Ok(())
}

/// `dlOn`
fn dl_on(d: Node<'_>) -> bool {
    truthy(d)
        && is_object(d)
        && !ct_boolean(get(d, "c:delete"), false, false)
        && (ct_boolean(get(d, "c:showVal"), false, false)
            || ct_boolean(get(d, "c:showPercent"), false, false))
}

/// One `c:dLbl` as an override, `None` where the map gives `null`.
fn d_lbl_override(d: &Value, theme: Option<&Theme>) -> Result<Option<DLblOverride>, String> {
    let d = Some(d);
    let idx = int(val(d, "c:idx"));
    if !idx.is_finite() {
        return Ok(None);
    }
    let idx = JsNum(idx);
    let mut out = DLblOverride {
        idx,
        hidden: None,
        val: None,
        cat: None,
        ser: None,
        pct: None,
        text: None,
        bold: None,
        size_pt: None,
        color: None,
        fill: None,
        border: None,
    };
    if ct_boolean(get(d, "c:delete"), false, false) {
        out.hidden = Some(true);
        return Ok(Some(out));
    }
    let flag = |k: &str| ct_boolean(get(d, k), false, false);
    // A rich-text label is authored text: PowerPoint shows it verbatim, styled by its first run
    let rich = get(get(d, "c:tx"), "c:rich");
    let rich_text = if truthy(rich) {
        collect_text(rich, "")
    } else {
        None
    };
    if rich_text.is_none() {
        let mut any = false;
        for k in [
            "c:showVal",
            "c:showCatName",
            "c:showSerName",
            "c:showPercent",
        ] {
            // d holds a c:idx, so it is an element node
            if let Some(node) = d
                && has_key(node, k)?
            {
                any = true;
                break;
            }
        }
        if !any {
            return Ok(None);
        }
    }
    let d_p = get(get(d, "c:txPr"), "a:p");
    let r_p = get(rich, "a:p");
    let r_p0 = first(r_p);
    let r_r0 = first(get(r_p0, "a:r"));
    let r_pr = get(r_r0, "a:rPr")
        .or_else(|| get(get(r_p0, "a:pPr"), "a:defRPr"))
        .or_else(|| get(get(first(d_p), "a:pPr"), "a:defRPr"));
    let sz = int(get(r_pr, "@_sz"));
    let c = color(get(r_pr, "a:solidFill"), theme);
    let label = label_box(get(d, "c:spPr"), theme)?;
    out.val = Some(flag("c:showVal"));
    out.cat = Some(flag("c:showCatName"));
    out.ser = Some(flag("c:showSerName"));
    out.pct = Some(flag("c:showPercent"));
    if let Some(text) = rich_text {
        out.text = Some(text);
        out.bold = Some(xsd_boolean(get(r_pr, "@_b"), false));
    }
    if sz.is_finite() && sz > 0.0 {
        out.size_pt = Some(JsNum(sz / 100.0));
    }
    out.color = c;
    out.fill = label.fill;
    out.border = label.border;
    Ok(Some(out))
}

impl SeriesState<'_> {
    pub(crate) fn parse_plot_series(
        &mut self,
        plot_node: &Value,
        plot_kind: ChartKind,
        tag_plot_kind: bool,
        secondary: bool,
        from_stock: bool,
    ) -> Result<(), String> {
        let theme = self.theme;
        let plot_node = Some(plot_node);
        let group_start = self.series.len();
        let sers = list(get(plot_node, "c:ser"));
        let plot_marker_node = get(plot_node, "c:marker");
        let plot_marker = ct_boolean(plot_marker_node, false, true);
        let scatter = plot_kind == ChartKind::Scatter;
        for ser_value in sers {
            if self.series.len() >= MAX_CHART_SERIES {
                break;
            }
            let ser = Some(ser_value);
            // Scatter: y values in c:yVal, x values in c:xVal; other types use c:val
            let values_node = get(ser, if scatter { "c:yVal" } else { "c:val" });
            let values = read_num_points(values_node, &mut self.budget)?;
            // A numRef with no numCache has no renderable data: PowerPoint plots nothing and
            // omits the series from the legend (external workbook data is never re-fetched)
            if values.is_empty() {
                continue;
            }
            let values_len = values.len();
            let mut s = ChartSeries::default();
            s.values.set(values);
            if let Some(val_fmt) = cache_format_code(values_node) {
                s.val_fmt.set(val_fmt);
            }
            if tag_plot_kind {
                s.plot_kind.set(plot_kind);
            }
            // Excel/PowerPoint pick automatic series colors by c:idx, not document order
            let pal_idx = int(val(ser, "c:idx"));
            if pal_idx.is_finite() {
                s.palette_idx.set(JsNum(pal_idx));
            }
            if secondary {
                s.secondary_axis.set(true);
            }
            if plot_kind == ChartKind::Bar {
                // an element holding only text parses as a string: no `in` test
                let sp_pr = get(ser, "c:spPr");
                if let Some(sp_pr) = sp_pr.filter(|sp| truthy(Some(*sp)) && is_object(Some(*sp)))
                    && has_key(sp_pr, "a:noFill")?
                {
                    s.no_fill.set(true);
                }
            }
            if from_stock {
                s.from_stock.set(true);
            }
            if scatter {
                let xs = read_num_points(get(ser, "c:xVal"), &mut self.budget)?;
                if !xs.is_empty() {
                    s.x_values.set(xs);
                }
                let sizes = read_num_points(get(ser, "c:bubbleSize"), &mut self.budget)?;
                if !sizes.is_empty() {
                    s.bubble_sizes.set(sizes);
                }
            }
            if let Some(name) = read_str_points(get(ser, "c:tx"), false, &mut self.budget)?
                .into_iter()
                .next()
            {
                s.name.set(name);
            }
            // Bubble color is the fill (the line is only the outline), unlike line/scatter/radar
            let prefer_line = s.bubble_sizes.is_none()
                && matches!(
                    plot_kind,
                    ChartKind::Line | ChartKind::Scatter | ChartKind::Radar
                );
            if let Some(c) = ser_color(ser_value, theme, prefer_line) {
                s.color.set(c);
            }
            if ct_boolean(get(ser, "c:smooth"), false, false) {
                s.smooth.set(true);
            }
            // Value-from-cells data labels (2012 c15 extension): strings live in the range cache,
            // gated by c15:showDataLabelsRange on the series dLbls
            let range_cache = list(get(get(ser, "c:extLst"), "c:ext"))
                .iter()
                .map(|e| get(get(Some(e), "c15:datalabelsRange"), "c15:dlblRangeCache"))
                .find(|cache| truthy(*cache))
                .flatten();
            let show_range = list(get(get(get(ser, "c:dLbls"), "c:extLst"), "c:ext"))
                .iter()
                .any(|e| ct_boolean(get(Some(e), "c15:showDataLabelsRange"), false, false));
            if truthy(range_cache) && show_range {
                let labs: Vec<Option<String>> = try_collect(
                    read_points(range_cache, &mut self.budget)?
                        .into_iter()
                        .map(|v| Some(v.unwrap_or_default())),
                )?;
                if labs
                    .iter()
                    .any(|v| v.as_deref().is_some_and(|v| !v.is_empty()))
                {
                    s.point_labels.set(labs);
                }
            }
            let ser_ln = get(get(ser, "c:spPr"), "a:ln");
            if let Some(dash) = as_str(val(ser_ln, "a:prstDash"))
                && dash != "solid"
            {
                s.dash.set(dash.to_owned());
            }
            let ser_ln_w = int(get(ser_ln, "@_w"));
            if ser_ln_w.is_finite() && ser_ln_w > 0.0 {
                s.line_width_pt.set(JsNum(ser_ln_w / 12700.0));
            }
            // Data-label visibility is per series: a combo chart shows labels only on the
            // series that carry c:dLbls (acsa: bar series labeled, the index line not)
            let ser_dl = get(ser, "c:dLbls");
            let ser_dl_object = truthy(ser_dl) && is_object(ser_dl);
            s.data_labels.set(if ser_dl_object {
                dl_on(ser_dl)
            } else {
                dl_on(get(plot_node, "c:dLbls"))
            });
            if ser_dl_object {
                if let Some(fmt) = as_str(get(get(ser_dl, "c:numFmt"), "@_formatCode"))
                    && !fmt.is_empty()
                    && fmt != "General"
                {
                    s.data_label_fmt.set(fmt.to_owned());
                }
                let label = label_box(get(ser_dl, "c:spPr"), theme)?;
                if let Some(Some(fill)) = label.fill {
                    s.data_label_fill.set(fill);
                }
                if let Some(Some(border)) = label.border {
                    s.data_label_border.set(border);
                }
            }
            let mut overrides: Vec<DLblOverride> = Vec::new();
            for d in list(get(ser_dl, "c:dLbl")) {
                if let Some(o) = d_lbl_override(d, theme)? {
                    overrides.push(o);
                }
            }
            if !overrides.is_empty() {
                let ser_shows_any = ser_dl_object
                    && !ct_boolean(get(ser_dl, "c:delete"), false, false)
                    && [
                        "c:showVal",
                        "c:showPercent",
                        "c:showCatName",
                        "c:showSerName",
                    ]
                    .iter()
                    .any(|k| ct_boolean(get(ser_dl, k), false, false));
                let any_shown = overrides.iter().any(|o| {
                    o.hidden != Some(true)
                        && (o.val == Some(true)
                            || o.cat == Some(true)
                            || o.ser == Some(true)
                            || o.pct == Some(true)
                            || o.text.is_some())
                });
                s.d_lbl_overrides.set(overrides);
                if any_shown {
                    s.data_labels.set(true);
                    if !ser_shows_any {
                        s.d_lbl_only_points.set(true);
                    }
                }
            }
            let marker_sym = val(get(ser, "c:marker"), "c:symbol");
            if plot_kind == ChartKind::Line {
                // Stock OHLC series show markers by default (PowerPoint draws marker-only lines);
                // otherwise a series without an explicit c:symbol takes the automatic marker when the
                // plot-level <c:marker val="1"/> is on (PowerPoint's "Line" preset writes symbol=none)
                // `fromStock ? sym !== 'none' : sym != null ? sym !== 'none' : plotMarker`
                s.marker.set(if from_stock || marker_sym.is_some() {
                    !is(marker_sym, "none")
                } else {
                    plot_marker
                });
            } else if matches!(plot_kind, ChartKind::Scatter | ChartKind::Radar)
                && marker_sym.is_some()
            {
                // scatter/radar: default marker decided by style; only set for explicit symbol
                s.marker.set(!is(marker_sym, "none"));
            }
            let expl = int(val(ser, "c:explosion"));
            if expl.is_finite() && expl > 0.0 {
                s.explosion_pct.set(JsNum(expl));
            }
            // Per-data-point colors (one color per pie slice)
            let d_pts = list(get(ser, "c:dPt"));
            if !d_pts.is_empty() {
                let mut point_colors: Vec<Option<String>> = Vec::new();
                let mut point_fills: Vec<Option<Fill>> = Vec::new();
                let mut point_no_fill: Vec<Option<bool>> = Vec::new();
                let mut point_lines: Vec<Option<PointLine>> = Vec::new();
                let mut point_expl: Vec<Option<JsNum>> = Vec::new();
                for d_pt in d_pts {
                    let d_pt = Some(d_pt);
                    let idx = int(val(d_pt, "c:idx"));
                    if !idx.is_finite() || idx < 0.0 || idx >= values_len as f64 {
                        continue;
                    }
                    // an integer in 0..values_len
                    let idx = idx as usize;
                    // an element holding only text parses as a string: properties of none
                    let d_sp = get(d_pt, "c:spPr").filter(|sp| is_object(Some(*sp)));
                    let c = color(get(d_sp, "a:solidFill"), theme);
                    if let Some(c) = c.clone() {
                        set_at(&mut point_colors, idx, c)?;
                    }
                    let sp_truthy = d_sp.filter(|sp| truthy(Some(*sp)));
                    let no_fill = match sp_truthy {
                        Some(sp) => has_key(sp, "a:noFill")?,
                        None => false,
                    };
                    if no_fill {
                        set_at(&mut point_no_fill, idx, true)?;
                    } else if sp_truthy.is_some() && c.is_none() {
                        let f = self.resolve_fill.and_then(|resolve| resolve(d_sp));
                        if let Some(f) = f.filter(|f| *f != Fill::None) {
                            set_at(&mut point_fills, idx, f)?;
                        }
                    }
                    let d_ln = get(d_sp, "a:ln");
                    if let Some(ln) = d_ln.filter(|ln| truthy(Some(*ln)) && is_object(Some(*ln))) {
                        let ln_color = if has_key(ln, "a:noFill")? {
                            Some(None)
                        } else {
                            color(get(Some(ln), "a:solidFill"), theme).map(Some)
                        };
                        let ln_w = int(get(Some(ln), "@_w"));
                        if let Some(ln_color) = ln_color {
                            set_at(
                                &mut point_lines,
                                idx,
                                PointLine {
                                    color: ln_color,
                                    width_pt: (ln_w.is_finite() && ln_w > 0.0)
                                        .then(|| JsNum(ln_w / 12700.0)),
                                },
                            )?;
                        }
                    }
                    let pe = int(val(d_pt, "c:explosion"));
                    if pe.is_finite() {
                        set_at(&mut point_expl, idx, JsNum(pe))?;
                    }
                }
                if !point_colors.is_empty() {
                    s.point_colors.set(point_colors);
                }
                if !point_fills.is_empty() {
                    s.point_fills.set(point_fills);
                }
                if !point_no_fill.is_empty() {
                    s.point_no_fill.set(point_no_fill);
                }
                if !point_lines.is_empty() {
                    s.point_lines.set(point_lines);
                }
                if !point_expl.is_empty() {
                    s.point_explosion_pct.set(point_expl);
                }
            }
            self.series.push(s);
            // Categories: take the first non-empty series' cat
            if self.categories.is_empty() {
                self.categories =
                    read_str_points(get(ser, "c:cat"), self.date1904, &mut self.budget)?;
                self.cat_serials = read_date_serials(get(ser, "c:cat"), &mut self.budget)?;
            }
            // Multi-level category axis: the outer level groups leaf categories (CA | SF, LA)
            if self.category_groups.is_none() {
                let multi = get(
                    get(get(ser, "c:cat"), "c:multiLvlStrRef"),
                    "c:multiLvlStrCache",
                );
                let lvls = list(get(multi, "c:lvl"));
                if lvls.len() > 1 {
                    let mut groups: Vec<CategoryGroup> = list(get(lvls.get(1), "c:pt"))
                        .iter()
                        .map(|pt| {
                            let pt = Some(pt);
                            let v = get(pt, "c:v");
                            let label = match v {
                                Some(Value::String(text)) => text.clone(),
                                Some(_) => match get(v, "#text") {
                                    None | Some(Value::Null) => String::new(),
                                    some => string_of(some),
                                },
                                None => String::new(),
                            };
                            CategoryGroup {
                                label,
                                start: JsNum(or0(int(get(pt, "@_idx")))),
                            }
                        })
                        .collect();
                    sort_by_number(&mut groups, |a, b| a.start.0 - b.start.0);
                    if !groups.is_empty() {
                        self.category_groups = Some(groups);
                    }
                }
            }
        }
        let grouping = val(plot_node, "c:grouping");
        self.plot_groups.push(PlotGroup {
            start: group_start,
            end: self.series.len(),
            stacked: matches!(plot_kind, ChartKind::Bar | ChartKind::Area)
                && (is(grouping, "stacked") || is(grouping, "percentStacked")),
            hbar: plot_kind == ChartKind::Bar && is(val(plot_node, "c:barDir"), "bar"),
        });
        Ok(())
    }
}
