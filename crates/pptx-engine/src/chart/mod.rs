//! Chart parsing (packages/pptx-engine/src/chart.ts): ppt/charts/chartN.xml
//! as a `ChartModel`.
//!
//! `model.rs` holds the exported types, `series.rs` the series of one plot,
//! `points.rs` the caches, `style.rs` axes, data tables and rich text.
//! `tailPaddingLeft`, a module variable of the TypeScript reset by every
//! parse, is a value carried through the one parse here.

mod model;
mod node;
mod points;
mod series;
mod style;

use crate::xml_utils::xml_parse_object as parse_object;
use jscompat::{JsNum, math_min, trim};
use ooxml_xml::ObjectOptions;
use serde_json::{Value, json};

use crate::color::{apply_color_mods, resolve_color_node, scale_luminance};
use crate::theme::{Theme, resolve_font_ref};
use crate::types::Fill;

pub use model::{
    Area3D, Bar3D, CategoryGroup, ChartAxisStyle, ChartBorder, ChartDataTable, ChartKind,
    ChartModel, ChartSeries, ChartStock, DLblOverride, LegendLayout, OfPie, PlotLayout, PointLine,
    SparseColors, Sunburst, UserLine,
};
pub use node::{ct_boolean, xsd_boolean};

pub(crate) use node::{Node, get, int, list, string_of};
use node::{as_str, first, is, is_object, not_same, number, or0, truthy, val};
use points::{MAX_TAIL_PADDING, read_str_points, sort_by_date};
pub(crate) use points::{try_collect, try_with_capacity};
use series::SeriesState;
use style::{collect_text, letter_spacing_pt, parse_axis, parse_data_table};

/// The DrawingML fill resolver parse.ts injects, so chart-part blip rIds
/// resolve correctly: `(spPr) => Fill | undefined`.
pub type ResolveFill<'a> = &'a dyn Fn(Option<&Value>) -> Option<Fill>;

/// `isArray` of `chartParser`.
const CHART_ARRAY_NAMES: [&str; 4] = ["c:ser", "c:pt", "c:lvl", "c:dPt"];

fn color(node: Node<'_>, theme: Option<&Theme>) -> Option<String> {
    resolve_color_node(node, theme, None)
}

/// What `dLblsInfo` answers for one owner of a `c:dLbls`.
#[derive(Debug, Default)]
struct DLblsInfo {
    on: bool,
    pct: bool,
    val_pct: bool,
    ser: bool,
    cat: bool,
    val: bool,
    fmt: Option<String>,
    size_pt: Option<f64>,
    bold: Option<bool>,
    rot_deg: Option<f64>,
    caps: Option<bool>,
    spc_pt: Option<f64>,
}

/// Data labels: plot-level or any series-level c:dLbls (delete=1 counts as none).
fn d_lbls_info(owner: Node<'_>) -> DLblsInfo {
    let d = get(owner, "c:dLbls");
    if !truthy(d) || !is_object(d) || ct_boolean(get(d, "c:delete"), false, false) {
        return DLblsInfo::default();
    }
    let show_val = ct_boolean(get(d, "c:showVal"), false, false);
    let show_pct = ct_boolean(get(d, "c:showPercent"), false, false);
    let show_ser = ct_boolean(get(d, "c:showSerName"), false, false);
    let show_cat = ct_boolean(get(d, "c:showCatName"), false, false);
    let fmt = as_str(get(get(d, "c:numFmt"), "@_formatCode"));
    let d_p = get(get(d, "c:txPr"), "a:p");
    let d_r_pr = get(get(first(d_p), "a:pPr"), "a:defRPr");
    let d_sz = int(get(d_r_pr, "@_sz"));
    let d_rot = int(get(get(get(d, "c:txPr"), "a:bodyPr"), "@_rot"));
    let d_spc = letter_spacing_pt(get(d_r_pr, "@_spc"));
    DLblsInfo {
        on: show_val || show_pct || show_ser || show_cat,
        pct: show_pct && !show_val,
        val_pct: show_pct && show_val,
        ser: show_ser,
        cat: show_cat,
        val: show_val || show_pct,
        fmt: fmt
            .filter(|f| !f.is_empty() && *f != "General")
            .map(str::to_owned),
        size_pt: (d_sz.is_finite() && d_sz > 0.0).then(|| d_sz / 100.0),
        bold: xsd_boolean(get(d_r_pr, "@_b"), false).then_some(true),
        rot_deg: (d_rot.is_finite() && d_rot != 0.0 && d_rot.abs() <= 5_400_000.0)
            .then(|| d_rot / 60000.0),
        caps: is(get(d_r_pr, "@_cap"), "all").then_some(true),
        spc_pt: d_spc,
    }
}

/// `latinOf`: the typeface of the first run, else of the paragraph default.
fn latin_of(tx_pr: Node<'_>, theme: Option<&Theme>) -> Option<String> {
    let p0 = first(get(tx_pr, "a:p"));
    let r_pr = get(first(get(p0, "a:r")), "a:rPr");
    let face = get(get(r_pr, "a:latin"), "@_typeface").or_else(|| {
        get(
            get(get(get(p0, "a:pPr"), "a:defRPr"), "a:latin"),
            "@_typeface",
        )
    });
    let face = as_str(face).filter(|face| !face.is_empty())?;
    resolve_font_ref(Some(face), theme, None).map(str::to_owned)
}

/// The plot nodes of one kind: `Array.isArray(n) ? n : n ? [n] : []`.
fn plots(node: Node<'_>) -> &[Value] {
    list(node)
}

/// Parse one chartN.xml. `None` is the TypeScript's `null`: unrecognized plot
/// types (the caller falls back to a placeholder chip). `Err` where it throws.
pub fn parse_chart_xml(
    xml: &str,
    theme: Option<&Theme>,
    resolve_fill: Option<ResolveFill<'_>>,
) -> Result<Option<ChartModel>, String> {
    let options = ObjectOptions {
        trim_values: false,
        parse_tag_value: false,
        array_names: &CHART_ARRAY_NAMES,
    };
    let Ok(doc) = parse_object(xml, &options) else {
        return Ok(None);
    };
    let doc = Some(&doc);
    let budget = MAX_TAIL_PADDING;
    let chart_space = get(doc, "c:chartSpace");
    let date1904_node = get(chart_space, "c:date1904");
    // String(node['@_val'] ?? '').trim().toLowerCase(), compared with ASCII
    // words only: no other character lowercases to one of them
    let date1904_raw = if is_object(date1904_node) {
        let raw = match get(date1904_node, "@_val") {
            None | Some(Value::Null) => String::new(),
            some => string_of(some),
        };
        trim(&raw).to_lowercase()
    } else {
        String::new()
    };
    let date1904 =
        date1904_node.is_some() && matches!(date1904_raw.as_str(), "" | "1" | "true" | "on");
    let chart = get(chart_space, "c:chart");
    let plot_area = get(chart, "c:plotArea");
    if !truthy(plot_area) {
        return Ok(None);
    }

    // Cartesian types (bar/area/line) may coexist combined (e.g. column+line combo); pie/scatter/radar
    // stand alone. The same plot type may appear twice in one plotArea (primary + secondary-axis
    // group): each node is its own combo entry.
    struct Cartesian<'v> {
        kind: ChartKind,
        plot: &'v Value,
        stock: bool,
    }
    let mut cartesian: Vec<Cartesian<'_>> = Vec::new();
    // Stock (open-)high-low-close rides the line pipeline
    let stock_plot = get(plot_area, "c:stockChart");
    for p in plots(get(plot_area, "c:barChart").or_else(|| get(plot_area, "c:bar3DChart"))) {
        cartesian.push(Cartesian {
            kind: ChartKind::Bar,
            plot: p,
            stock: false,
        });
    }
    for p in plots(get(plot_area, "c:areaChart").or_else(|| get(plot_area, "c:area3DChart"))) {
        cartesian.push(Cartesian {
            kind: ChartKind::Area,
            plot: p,
            stock: false,
        });
    }
    for p in plots(get(plot_area, "c:lineChart").or_else(|| get(plot_area, "c:line3DChart"))) {
        cartesian.push(Cartesian {
            kind: ChartKind::Line,
            plot: p,
            stock: false,
        });
    }
    for p in plots(stock_plot) {
        cartesian.push(Cartesian {
            kind: ChartKind::Line,
            plot: p,
            stock: true,
        });
    }

    // Pie-of-pie / bar-of-pie draw their primary pie only
    let pie_plot = get(plot_area, "c:pieChart")
        .or_else(|| get(plot_area, "c:pie3DChart"))
        .or_else(|| get(plot_area, "c:doughnutChart"))
        .or_else(|| get(plot_area, "c:ofPieChart"));

    let is_3d = truthy(get(plot_area, "c:bar3DChart"))
        || truthy(get(plot_area, "c:area3DChart"))
        || truthy(get(plot_area, "c:line3DChart"))
        || truthy(get(plot_area, "c:pie3DChart"));

    let kind: ChartKind;
    let plot: &Value;
    let mut of_pie: Option<OfPie> = None;
    if let Some(primary) = cartesian.first() {
        // Primary type is the first (bar > area > line)
        kind = primary.kind;
        plot = primary.plot;
    } else if let Some(pie) = pie_plot.filter(|p| truthy(Some(*p))) {
        kind = ChartKind::Pie;
        plot = pie;
        if truthy(get(plot_area, "c:ofPieChart")) {
            let num = |k: &str, dflt: f64| {
                let v = int(val(Some(pie), k));
                if v.is_finite() && v > 0.0 { v } else { dflt }
            };
            of_pie = Some(OfPie {
                split_pos: JsNum(num("c:splitPos", 2.0)),
                second_pie_size: JsNum(num("c:secondPieSize", 75.0)),
                gap_width: JsNum(num("c:gapWidth", 150.0)),
            });
        }
    } else if truthy(get(plot_area, "c:scatterChart")) || truthy(get(plot_area, "c:bubbleChart")) {
        // Bubble rides the scatter pipeline: same x/y value model, sized markers via bubbleSizes
        kind = ChartKind::Scatter;
        match get(plot_area, "c:scatterChart").or_else(|| get(plot_area, "c:bubbleChart")) {
            Some(p) => plot = p,
            None => return Ok(None),
        }
    } else if let Some(radar) = get(plot_area, "c:radarChart").filter(|p| truthy(Some(*p))) {
        kind = ChartKind::Radar;
        plot = radar;
    } else {
        return Ok(None);
    }

    // Value axis nodes up front: combo dual axes need the secondary value axis's axId
    // (axPos=r and not deleted) so series parsing can tell primary from secondary
    let val_axes = list(get(plot_area, "c:valAx"));
    let sec_val_ax_node: Node<'_> = if kind != ChartKind::Scatter && cartesian.len() > 1 {
        val_axes.iter().find(|a| {
            let a = Some(*a);
            is(val(a, "c:axPos"), "r") && !ct_boolean(get(a, "c:delete"), false, false)
        })
    } else {
        None
    };
    let sec_ax_id = val(sec_val_ax_node, "c:axId");
    let mut state = SeriesState {
        theme,
        resolve_fill,
        date1904,
        budget,
        series: Vec::new(),
        plot_groups: Vec::new(),
        categories: Vec::new(),
        cat_serials: None,
        category_groups: None,
    };
    if cartesian.len() > 1 {
        for c in &cartesian {
            let secondary = sec_ax_id.is_some_and(|id| plot_ax_ids(c.plot).contains(&id));
            state.parse_plot_series(c.plot, c.kind, true, secondary, c.stock)?;
        }
    } else {
        let stock = cartesian.first().is_some_and(|c| c.stock);
        state.parse_plot_series(plot, kind, false, false, stock)?;
    }
    if state.series.is_empty() {
        return Ok(None);
    }
    let mut budget = state.budget;
    let mut series = std::mem::take(&mut state.series);
    let mut categories = std::mem::take(&mut state.categories);
    let plot_groups = std::mem::take(&mut state.plot_groups);
    let cat_serials = state.cat_serials.take();
    let category_groups = state.category_groups.take();
    if categories.is_empty() {
        // With no category cache, keep names empty (length from the longest series)
        let n = series
            .iter()
            .map(|s| s.values.as_ref().map_or(0, Vec::len))
            .max()
            .unwrap_or(0);
        categories = try_with_capacity(n)?;
        categories.resize(n, String::new());
    }

    // `categories` and `series` take their keys here; their values are set at the end
    let mut model = ChartModel::default();
    model.kind.set(kind);
    model.categories.set(Vec::new());
    model.series.set(Vec::new());
    if let Some(of_pie) = of_pie {
        model.of_pie.set(of_pie);
    }
    if let Some(groups) = category_groups.clone() {
        model.category_groups.set(groups);
    }

    if is_3d {
        model.pseudo3_d.set(true);
        let v3 = get(chart, "c:view3D");
        let rot_x = int(val(v3, "c:rotX"));
        if rot_x.is_finite() {
            model.rot_x_deg.set(JsNum(rot_x));
        }
        let b3 = get(plot_area, "c:bar3DChart");
        let a3 = get(plot_area, "c:area3DChart");
        let num = |node: Node<'_>, dflt: f64| {
            let v = int(get(node, "@_val"));
            JsNum(if v.is_finite() { v } else { dflt })
        };
        let ser_ax = get(plot_area, "c:serAx");
        let ser_ax_labels = ser_ax.is_some()
            && !ct_boolean(get(ser_ax, "c:delete"), false, false)
            && !is(val(ser_ax, "c:tickLblPos"), "none");
        if truthy(b3) {
            model.bar3_d.set(Bar3D {
                rot_x: num(get(v3, "c:rotX"), 15.0),
                rot_y: num(get(v3, "c:rotY"), 20.0),
                depth_pct: num(get(v3, "c:depthPercent"), 100.0),
                r_ang_ax: ct_boolean(get(v3, "c:rAngAx"), true, true),
                gap_depth_pct: num(get(b3, "c:gapDepth"), 150.0),
                ser_ax_labels,
            });
        }
        if truthy(a3) {
            model.area3_d.set(Area3D {
                rot_x: num(get(v3, "c:rotX"), 15.0),
                rot_y: num(get(v3, "c:rotY"), 20.0),
                gap_depth_pct: num(get(a3, "c:gapDepth"), 150.0),
                ser_ax_labels,
            });
        }
    }

    let plot_node = Some(plot);
    if matches!(kind, ChartKind::Bar | ChartKind::Area | ChartKind::Line) {
        let grouping = val(plot_node, "c:grouping");
        if truthy(grouping) {
            model.grouping.set(string_of(grouping));
        }
    }
    if kind == ChartKind::Bar {
        let dir = val(plot_node, "c:barDir");
        model
            .bar_dir
            .set(if is(dir, "bar") { "bar" } else { "col" }.to_owned());
        // A malformed c:gapWidth parses to NaN, which would make every bar disappear
        let gap = int(val(plot_node, "c:gapWidth"));
        model
            .gap_width_pct
            .set(JsNum(if gap.is_finite() { gap } else { 150.0 }));
        let ov = val(plot_node, "c:overlap");
        if ov.is_some() {
            model.overlap_pct.set(JsNum(or0(int(ov))));
        }
    }

    if kind == ChartKind::Pie {
        let hole = val(plot_node, "c:holeSize");
        model.hole_pct.set(JsNum(if hole.is_some() {
            or0(int(hole))
        } else if truthy(get(plot_area, "c:doughnutChart")) {
            50.0
        } else {
            0.0
        }));
        let first_ang = val(plot_node, "c:firstSliceAng");
        if first_ang.is_some() {
            model.first_slice_ang_deg.set(JsNum(or0(int(first_ang))));
        }
        // vary === '0' || vary === 'false', which is the xsd reading already
        if !ct_boolean(get(plot_node, "c:varyColors"), true, true) {
            model.vary_colors.set(false);
        }
    }

    if kind == ChartKind::Scatter {
        let st = val(plot_node, "c:scatterStyle");
        if truthy(st) {
            model.scatter_style.set(string_of(st));
        }
        let b_scale = int(val(plot_node, "c:bubbleScale"));
        if b_scale.is_finite() && b_scale > 0.0 {
            model.bubble_scale.set(JsNum(b_scale));
        }
        if is(val(plot_node, "c:sizeRepresents"), "w") {
            model.bubble_size_is_width.set(true);
        }
    }

    if kind == ChartKind::Radar {
        let st = val(plot_node, "c:radarStyle");
        model.radar_style.set(
            if is(st, "filled") {
                "filled"
            } else if is(st, "marker") {
                "marker"
            } else {
                "standard"
            }
            .to_owned(),
        );
    }

    if truthy(stock_plot) {
        // Empty elements (<c:hiLowLines/>) parse to "": presence, not truthiness
        let udb = get(stock_plot, "c:upDownBars");
        let gw = int(val(udb, "c:gapWidth"));
        model.stock.set(ChartStock {
            hi_low_lines: get(stock_plot, "c:hiLowLines").is_some(),
            up_down_bars: udb.is_some(),
            gap_width_pct: (gw.is_finite() && gw >= 0.0).then_some(JsNum(gw)),
        });
    }

    let legend_node = get(chart, "c:legend");
    let legend_pos = val(legend_node, "c:legendPos");
    if truthy(legend_node) {
        model.legend_pos.set(match legend_pos {
            Some(pos) => string_of(Some(pos)),
            None => "r".to_owned(),
        });
        // Measured PowerPoint behavior: explicit <c:overlay val="1"/> floats the legend, and so does
        // a legend with no <c:legendPos> at all (unless overlay is explicitly 0)
        let overlay_node = get(legend_node, "c:overlay");
        let floats = match overlay_node {
            None => legend_pos.is_none(),
            Some(_) => ct_boolean(overlay_node, false, false),
        };
        if floats {
            model.legend_overlay.set(true);
        }
        let man = get(get(legend_node, "c:layout"), "c:manualLayout");
        if truthy(man) {
            let frac = |k: &str| {
                let v = number(val(man, k));
                v.is_finite().then_some(v)
            };
            let mode = |k: &str| {
                (if is(val(man, k), "edge") {
                    "edge"
                } else {
                    "factor"
                })
                .to_owned()
            };
            let (lx, ly, lw, lh) = (frac("c:x"), frac("c:y"), frac("c:w"), frac("c:h"));
            if lx.is_some() || ly.is_some() {
                model.legend_layout.set(LegendLayout {
                    x: lx.map(JsNum),
                    x_mode: lx.map(|_| mode("c:xMode")),
                    y: ly.map(JsNum),
                    y_mode: ly.map(|_| mode("c:yMode")),
                    w: lw.filter(|w| *w > 0.0).map(JsNum),
                    h: lh.filter(|h| *h > 0.0).map(JsNum),
                });
            }
        }
        let leg_p = get(get(legend_node, "c:txPr"), "a:p");
        let leg_p_pr = get(first(leg_p), "a:pPr");
        let leg_r_pr = get(leg_p_pr, "a:defRPr");
        // INT_MIN baseline sentinel: PowerPoint renders no legend at all
        if is(get(leg_r_pr, "@_baseline"), "-2147483648") {
            model.legend_pos.delete();
        }
        let leg_sz = int(get(leg_r_pr, "@_sz"));
        if leg_sz.is_finite() && leg_sz > 0.0 {
            model.legend_pt.set(JsNum(leg_sz / 100.0));
        }
        if xsd_boolean(get(leg_r_pr, "@_b"), false) {
            model.legend_bold.set(true);
        }
        if let Some(c) = color(get(leg_r_pr, "a:solidFill"), theme) {
            model.legend_color.set(c);
        }
        if xsd_boolean(get(leg_p_pr, "@_rtl"), false) {
            model.legend_rtl.set(true);
        }
        // PowerPoint lists entries per plot group; a stacked group next to a side legend runs
        // top-of-stack first (reversed). c:legendEntry idx counts positions in that display order
        let side_legend = matches!(model.legend_pos.as_deref(), Some("r" | "l" | "tr"));
        // A maxMin category axis puts series 1 on top of each bar group, so the bottom-up
        // listing flips back to document order
        let cat_reversed = list(get(plot_area, "c:catAx"))
            .iter()
            .chain(list(get(plot_area, "c:dateAx")))
            .any(|ax| {
                let ax = Some(ax);
                !ct_boolean(get(ax, "c:delete"), false, false)
                    && is(val(get(ax, "c:scaling"), "c:orientation"), "maxMin")
            });
        let mut order: Vec<usize> = Vec::new();
        for g in &plot_groups {
            let idx: Vec<usize> = (g.start..g.end).collect();
            // horizontal bars list bottom-up (Series N first), like the renderer stacks them
            if (g.hbar && !cat_reversed) || (g.stacked && side_legend) {
                order.extend(idx.into_iter().rev());
            } else {
                order.extend(idx);
            }
        }
        let deleted: Vec<f64> = list(get(legend_node, "c:legendEntry"))
            .iter()
            .filter(|e| ct_boolean(get(Some(*e), "c:delete"), false, false))
            .map(|e| int(val(Some(e), "c:idx")))
            .collect();
        let shown: Vec<usize> = order
            .iter()
            .enumerate()
            .filter(|(pos, _)| !deleted.contains(&(*pos as f64)))
            .map(|(_, &si)| si)
            .collect();
        if shown.len() != series.len() || shown.iter().enumerate().any(|(k, &si)| si != k) {
            model
                .legend_order
                .set(shown.into_iter().map(|si| JsNum(si as f64)).collect());
        }
    }

    // Plot-area inner rectangle (edge-mode fractions of the chart frame)
    let m_lay = get(get(plot_area, "c:layout"), "c:manualLayout");
    if is(val(m_lay, "c:layoutTarget"), "inner") {
        let frac = |k: &str| number(val(m_lay, k));
        let edge_mode = |k: &str| {
            let m = val(m_lay, k);
            m.is_none() || is(m, "edge")
        };
        let (lx, ly, lw, lh) = (frac("c:x"), frac("c:y"), frac("c:w"), frac("c:h"));
        if edge_mode("c:xMode")
            && edge_mode("c:yMode")
            && [lx, ly, lw, lh].iter().all(|v| v.is_finite())
            && lw > 0.0
            && lh > 0.0
        {
            model.plot_layout.set(PlotLayout {
                x: JsNum(lx),
                y: JsNum(ly),
                w: JsNum(lw),
                h: JsNum(lh),
            });
        }
    }

    // Plot-area fill/border (c:plotArea's own spPr)
    let pa_sp_pr = get(plot_area, "c:spPr");
    let pa_fill = resolve_fill
        .and_then(|resolve| resolve(pa_sp_pr))
        .or_else(|| color(get(pa_sp_pr, "a:solidFill"), theme).map(|c| Fill::Solid { color: c }));
    if let Some(fill) = pa_fill.clone().filter(|f| *f != Fill::None) {
        model.plot_fill.set(fill);
    }
    let pa_ln = get(pa_sp_pr, "a:ln");
    // `paLn && !paLn['a:noFill'] && resolveColorNode(...)`: an empty <a:noFill/> is '' and
    // does not stop it
    if truthy(pa_ln)
        && !truthy(get(pa_ln, "a:noFill"))
        && let Some(c) = color(get(pa_ln, "a:solidFill"), theme)
    {
        let w = int(get(pa_ln, "@_w"));
        model.plot_border.set(ChartBorder {
            color: c,
            width_emu: JsNum(if w.is_finite() && w > 0.0 { w } else { 9525.0 }),
        });
    }

    // Whole-chart background (chartSpace-level spPr); no spPr is transparent
    let cs_sp_pr = get(chart_space, "c:spPr");
    let bg_fill = resolve_fill.and_then(|resolve| resolve(cs_sp_pr));
    if let Some(fill) = bg_fill.filter(|f| *f != Fill::None) {
        model.bg_fill.set(fill);
    }
    // Whole-chart frame border (chartSpace-level ln)
    let sp_ln = get(cs_sp_pr, "a:ln");
    if truthy(sp_ln)
        && !truthy(get(sp_ln, "a:noFill"))
        && let Some(c) = color(get(sp_ln, "a:solidFill"), theme)
    {
        let w = int(get(sp_ln, "@_w"));
        model.border.set(ChartBorder {
            color: c,
            width_emu: JsNum(if w.is_finite() && w > 0.0 { w } else { 9525.0 }),
        });
    }

    // Theme accents: default series/wedge colors follow the file's theme
    if let Some(theme) = theme {
        let accents: Vec<String> = [
            "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
        ]
        .iter()
        .filter_map(|k| theme.colors.as_ref().and_then(|c| c.get(k)))
        .filter(|c| !c.is_empty())
        .cloned()
        .collect();
        if accents.len() == 6 {
            model.theme_palette.set(accents);
        }
    }
    // Legacy 2007 <c:style>: columns 3-8 color every series with a monochrome luminance
    // ramp of accent1-6 (dark to light in plot order)
    let style_val = int(val(chart_space, "c:style"));
    let style_col = if style_val.is_finite() {
        (style_val - 1.0) % 8.0
    } else {
        -1.0
    };
    if style_col >= 2.0
        && !series.is_empty()
        && series.iter().all(|s| !truthy_str(s.color.as_deref()))
    {
        // 2 <= style_col <= 7: an index of the six accents
        let base = model
            .theme_palette
            .as_ref()
            .and_then(|palette| palette.get(style_col as usize - 2))
            .cloned();
        if let Some(base) = base.filter(|b| !b.is_empty()) {
            const ANCHORS: [f64; 4] = [0.77, 0.93, 1.44, 1.92];
            let lum_at = |p: f64| -> f64 {
                let x = p * 3.0;
                let i = math_min(x.floor(), 2.0);
                let at = i as usize;
                ANCHORS[at] + (ANCHORS[at + 1] - ANCHORS[at]) * (x - i)
            };
            let count = series.len();
            for (i, s) in series.iter_mut().enumerate() {
                let factor = if count == 1 {
                    1.0
                } else {
                    lum_at(i as f64 / (count - 1) as f64)
                };
                s.color.set(scale_luminance(&base, factor));
            }
        }
    }
    // chartSpace-level default text size (hundredths of a pt) and color
    let tx_def_r_pr = get(
        get(first(get(get(chart_space, "c:txPr"), "a:p")), "a:pPr"),
        "a:defRPr",
    );
    let def_sz = int(get(tx_def_r_pr, "@_sz"));
    if def_sz.is_finite() && def_sz > 0.0 {
        model.default_text_pt.set(JsNum(def_sz / 100.0));
    }
    if let Some(c) = color(get(tx_def_r_pr, "a:solidFill"), theme) {
        model.default_text_color.set(c);
    }
    // Office 2007 style table, bottom row (41-48): black chart area with white text
    // unless the part spells out its own chartSpace fill / text color
    if (41.0..=48.0).contains(&style_val) {
        let explicit_fill = match cs_sp_pr.filter(|sp| truthy(Some(*sp))) {
            Some(sp) => {
                let mut any = false;
                for k in [
                    "a:noFill",
                    "a:solidFill",
                    "a:gradFill",
                    "a:blipFill",
                    "a:pattFill",
                ] {
                    if node::has_key(sp, k)? {
                        any = true;
                        break;
                    }
                }
                any
            }
            None => false,
        };
        let dk1 = theme
            .and_then(|t| t.colors.as_ref())
            .and_then(|c| c.get("dk1"))
            .cloned()
            .unwrap_or_else(|| "#000000".to_owned());
        if !explicit_fill {
            model.bg_fill.set(Fill::Solid { color: dk1.clone() });
        }
        // Plot area: dk1 lumMod 75% lumOff 25%
        if pa_fill.is_none() && !truthy(get(pa_sp_pr, "a:noFill")) {
            let mods =
                json!({ "a:lumMod": { "@_val": "75000" }, "a:lumOff": { "@_val": "25000" } });
            model.plot_fill.set(Fill::Solid {
                color: apply_color_mods(&dk1, Some(&mods)),
            });
        }
        if !truthy_str(model.default_text_color.as_deref()) {
            let lt1 = theme
                .and_then(|t| t.colors.as_ref())
                .and_then(|c| c.get("lt1"))
                .cloned()
                .unwrap_or_else(|| "#FFFFFF".to_owned());
            model.default_text_color.set(lt1);
        }
    }

    // Title text: rich text, or the cached cell-linked string (c:tx/c:strRef);
    // each title paragraph is its own line
    let title_node = get(chart, "c:title");
    let chart_title = match collect_text(get(get(title_node, "c:tx"), "c:rich"), "\n") {
        Some(text) => Some(text),
        None => read_str_points(get(title_node, "c:tx"), false, &mut budget)?
            .into_iter()
            .next(),
    };
    if ct_boolean(get(title_node, "c:overlay"), false, false) {
        model.title_overlay.set(true);
    }
    if let Some(title) = chart_title.filter(|t| !t.is_empty()) {
        model.title.set(title);
    } else if truthy(title_node)
        && !truthy(get(title_node, "c:tx"))
        && !ct_boolean(get(chart, "c:autoTitleDeleted"), false, false)
    {
        // Auto title: the sole series name; with several series the literal "Chart Title"
        let name = if series.len() == 1 {
            series[0].name.as_ref().filter(|n| !n.is_empty()).cloned()
        } else {
            None
        };
        model
            .title
            .set(name.unwrap_or_else(|| "Chart Title".to_owned()));
    }
    if truthy_str(model.title.as_deref()) {
        let tit_p = get(get(title_node, "c:txPr"), "a:p");
        let tit_def_r_pr = get(get(first(tit_p), "a:pPr"), "a:defRPr");
        let title_sz = int(get(tit_def_r_pr, "@_sz"));
        if title_sz.is_finite() && title_sz > 0.0 {
            model.title_pt.set(JsNum(title_sz / 100.0));
        }
        // Rich-text titles usually carry the styling on the first run, not on txPr
        let rich = get(get(title_node, "c:tx"), "c:rich");
        let p0 = first(get(rich, "a:p"));
        let r0 = first(get(p0, "a:r"));
        let p0_def = get(get(p0, "a:pPr"), "a:defRPr");
        let title_r_pr = get(r0, "a:rPr").or(p0_def);
        if !model
            .title_pt
            .as_ref()
            .is_some_and(|pt| number_truthy(pt.0))
        {
            let run_sz = int(get(title_r_pr, "@_sz").or_else(|| get(p0_def, "@_sz")));
            if run_sz.is_finite() && run_sz > 0.0 {
                model.title_pt.set(JsNum(run_sz / 100.0));
            }
        }
        // Run rPr, paragraph defRPr, txPr defRPr, attribute by attribute
        let style_layers: Vec<&Value> = [get(r0, "a:rPr"), p0_def, tit_def_r_pr]
            .into_iter()
            .flatten()
            .filter(|l| truthy(Some(*l)))
            .collect();
        let style_attr = |k: &str| style_attr(&style_layers, k);
        let b = style_attr("@_b");
        if b.is_some() {
            model.title_bold.set(xsd_boolean(b, false));
        }
        if xsd_boolean(style_attr("@_i"), false) {
            model.title_italic.set(true);
        }
        if let Some(c) = color(style_attr("a:solidFill"), theme) {
            model.title_color.set(c);
        }
        if is(style_attr("@_cap"), "all") {
            model.title_caps.set(true);
        }
        if let Some(spc) = letter_spacing_pt(style_attr("@_spc")) {
            model.title_spc_pt.set(JsNum(spc));
        }
    }

    // Series-level c:dLbls override the plot-level block (PowerPoint reads the series first)
    let owner_plots: Vec<&Value> = if cartesian.len() > 1 {
        cartesian.iter().map(|c| c.plot).collect()
    } else {
        vec![plot]
    };
    let d_lbl_owners: Vec<&Value> = owner_plots
        .iter()
        .flat_map(|p| {
            list(get(Some(*p), "c:ser"))
                .iter()
                .chain(std::iter::once(*p))
        })
        .collect();
    let d_lbl_results: Vec<DLblsInfo> =
        d_lbl_owners.iter().map(|o| d_lbls_info(Some(*o))).collect();
    let axis_nodes: Vec<&Value> = ["c:catAx", "c:valAx", "c:dateAx", "c:serAx"]
        .iter()
        .flat_map(|k| list(get(plot_area, k)))
        .collect();
    // Tick labels size the plot, so the axis face outranks the title's when chartSpace names none
    let font_family = latin_of(get(chart_space, "c:txPr"), theme)
        .or_else(|| {
            axis_nodes
                .iter()
                .map(|a| latin_of(get(Some(*a), "c:txPr"), theme))
                .find(|f| truthy_str(f.as_deref()))
                .flatten()
        })
        .or_else(|| latin_of(get(legend_node, "c:txPr"), theme))
        .or_else(|| {
            d_lbl_owners
                .iter()
                .map(|o| latin_of(get(get(Some(*o), "c:dLbls"), "c:txPr"), theme))
                .find(|f| truthy_str(f.as_deref()))
                .flatten()
        })
        .or_else(|| latin_of(get(get(title_node, "c:tx"), "c:rich"), theme))
        .or_else(|| latin_of(get(title_node, "c:txPr"), theme));
    if let Some(face) = font_family.filter(|f| !f.is_empty()) {
        model.font_family.set(face);
    }
    if let Some(found) = d_lbl_results.iter().find(|r| r.on) {
        model.data_labels.set(true);
        if found.pct {
            model.data_labels_pct.set(true);
        }
        if found.val_pct {
            model.data_labels_val_pct.set(true);
        }
        if found.ser {
            model.data_label_ser_name.set(true);
        }
        if found.cat {
            model.data_label_cat_name.set(true);
        }
        if found.on && !found.val {
            model.data_label_no_value.set(true);
        }
        let fmt = found
            .fmt
            .clone()
            .or_else(|| d_lbl_results.iter().find_map(|r| r.fmt.clone()));
        if let Some(fmt) = fmt {
            model.data_label_fmt.set(fmt);
        }
        let size_pt = found
            .size_pt
            .or_else(|| d_lbl_results.iter().find_map(|r| r.size_pt));
        if let Some(size_pt) = size_pt.filter(|v| number_truthy(*v)) {
            model.data_label_pt.set(JsNum(size_pt));
        }
        if found
            .bold
            .unwrap_or_else(|| d_lbl_results.iter().any(|r| r.bold == Some(true)))
        {
            model.data_label_bold.set(true);
        }
        let rot_deg = found
            .rot_deg
            .or_else(|| d_lbl_results.iter().find_map(|r| r.rot_deg));
        if let Some(rot_deg) = rot_deg.filter(|v| number_truthy(*v)) {
            model.data_label_rot_deg.set(JsNum(rot_deg));
        }
        if found
            .caps
            .unwrap_or_else(|| d_lbl_results.iter().any(|r| r.caps == Some(true)))
        {
            model.data_label_caps.set(true);
        }
        let spc_pt = found
            .spc_pt
            .or_else(|| d_lbl_results.iter().find_map(|r| r.spc_pt));
        if let Some(spc_pt) = spc_pt.filter(|v| number_truthy(*v)) {
            model.data_label_spc_pt.set(JsNum(spc_pt));
        }
    }

    // Axes: scatter charts have dual value axes (x at the bottom axPos=b, y on the left);
    // the x axis goes in the catAxis slot
    if kind == ChartKind::Scatter && val_axes.len() >= 2 {
        let x_ax_node = val_axes
            .iter()
            .find(|a| is(val(Some(*a), "c:axPos"), "b"))
            .or_else(|| val_axes.first());
        let y_ax_node = val_axes
            .iter()
            .find(|a| not_same(Some(*a), x_ax_node))
            .or_else(|| val_axes.get(1));
        if let Some(x_ax) = parse_axis(x_ax_node, theme, &mut budget)? {
            model.cat_axis.set(x_ax);
        }
        if let Some(y_ax) = parse_axis(y_ax_node, theme, &mut budget)? {
            model.val_axis.set(y_ax);
        }
    } else {
        // A combo chart has two axis pairs: the value axis is the left primary (axPos=l), the
        // category axis is the non-deleted one
        let val_ax_node = val_axes
            .iter()
            .find(|a| is(val(Some(*a), "c:axPos"), "l"))
            .or_else(|| val_axes.first());
        if let Some(val_ax) = parse_axis(val_ax_node, theme, &mut budget)? {
            model.val_axis.set(val_ax);
        }
        // Secondary value axis (combo dual axes)
        if truthy(sec_val_ax_node)
            && let Some(val_ax2) = parse_axis(sec_val_ax_node, theme, &mut budget)?
        {
            model.val_axis2.set(val_ax2);
        }
        // A date axis is a category axis with time semantics; pick the first non-deleted
        // candidate across the two lists
        let cat_cands: Vec<(&Value, bool)> = list(get(plot_area, "c:catAx"))
            .iter()
            .map(|n| (n, false))
            .chain(list(get(plot_area, "c:dateAx")).iter().map(|n| (n, true)))
            .collect();
        let pick = cat_cands
            .iter()
            .find(|(n, _)| !ct_boolean(get(Some(*n), "c:delete"), false, false))
            .or_else(|| cat_cands.first());
        let is_date = pick.is_some_and(|(_, date)| *date);
        let cat_ax = parse_axis(pick.map(|(n, _)| *n), theme, &mut budget)?;
        if cat_ax.is_some() || is_date {
            let mut axis = cat_ax.unwrap_or_default();
            if is_date {
                axis.is_date = Some(true);
            }
            model.cat_axis.set(axis);
        }
        // A date axis plots chronologically whatever the sheet order
        if is_date
            && category_groups.is_none()
            && let Some(serials) = &cat_serials
        {
            sort_by_date(&mut categories, &mut series, serials)?;
        }
    }
    // Source-linked data labels inherit the value axis's number format
    if *model.data_labels == Some(true) && !truthy_str(model.data_label_fmt.as_deref()) {
        let num_fmt = model.val_axis.as_ref().and_then(|ax| ax.num_fmt.clone());
        if let Some(num_fmt) = num_fmt.filter(|f| !f.is_empty()) {
            model.data_label_fmt.set(num_fmt);
        }
    }

    let d_table = get(plot_area, "c:dTable");
    if d_table.is_some() && kind != ChartKind::Pie {
        model.data_table.set(parse_data_table(d_table, theme));
    }

    model.categories.set(categories);
    model.series.set(series);
    Ok(Some(model))
}

/// `if (text)` over an optional string.
fn truthy_str(text: Option<&str>) -> bool {
    text.is_some_and(|t| !t.is_empty())
}

/// `if (x)` over a number.
fn number_truthy(x: f64) -> bool {
    jscompat::number_truthy(x)
}

/// Axes attached to a plot node (two c:axIds: category axis + value axis).
fn plot_ax_ids(plot_node: &Value) -> Vec<&Value> {
    list(get(Some(plot_node), "c:axId"))
        .iter()
        .filter_map(|a| get(Some(a), "@_val"))
        .collect()
}

/// `styleAttr`: the first layer that sets `k`.
fn style_attr<'a>(layers: &[&'a Value], k: &str) -> Node<'a> {
    layers
        .iter()
        .map(|l| get(Some(*l), k))
        .find(|v| !matches!(v, None | Some(Value::Null)))
        .flatten()
}
