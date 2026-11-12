//! The read side of packages/docx-engine/src/chart.ts: the display model of a
//! chart part (word/charts/chartN.xml, and the cx: chart extension), read
//! from the caches Word writes next to the data references, and the colour
//! transforms charts use.

use jscompat::{
    JsNum, Radix, Slot, js_regex, math_max, math_min, math_round, number_to_string, pad_start,
    parse_int, to_number, to_string_radix16, trim, utc_date_parts,
};
use ooxml_xml::{XNode, parse_ordered};

use crate::model::{
    ChartAxis, ChartDisplay, ChartDisplayDataLabels, ChartDisplayDataTable, ChartDisplayGrouping,
    ChartDisplayKind, ChartDisplayLegendPos, ChartDisplayRadarStyle, ChartSeries,
};
use crate::props::XML_PARSER_MAX_NESTED_TAGS;
use crate::theme::ThemeColors;

/// `CHART_KINDS[name] ?? 'other'`
fn chart_kind(name: &str) -> ChartDisplayKind {
    match name {
        "c:barChart" | "c:bar3DChart" => ChartDisplayKind::Bar,
        "c:lineChart" | "c:line3DChart" => ChartDisplayKind::Line,
        "c:pieChart" | "c:pie3DChart" | "c:doughnutChart" => ChartDisplayKind::Pie,
        "c:areaChart" | "c:area3DChart" => ChartDisplayKind::Area,
        "c:scatterChart" => ChartDisplayKind::Scatter,
        "c:bubbleChart" => ChartDisplayKind::Bubble,
        "c:radarChart" => ChartDisplayKind::Radar,
        _ => ChartDisplayKind::Other,
    }
}

/// `DEFAULT_FRAME_LINE`: Word's chart-area border when c:chartSpace carries no c:spPr.
pub const DEFAULT_FRAME_LINE: &str = "868686";
/// `MAX_CHART_CACHE_POINTS`: the largest point index honored (a full Excel column).
pub const MAX_CHART_CACHE_POINTS: f64 = 1_048_576.0;
/// `MAX_CHART_SERIES`: the largest series count honored.
pub const MAX_CHART_SERIES: usize = 256;

fn is_hex6(text: &str) -> bool {
    js_regex!(r"^[0-9A-Fa-f]{6}$", "").test(text)
}

/// `parseChartPartXml(xml, partPath, theme)`: `Err` where the parser refuses.
pub fn parse_chart_part_xml(
    xml: &str,
    part_path: &str,
    theme: Option<&ThemeColors>,
) -> Result<Option<ChartDisplay>, String> {
    let parsed =
        parse_ordered(xml, XML_PARSER_MAX_NESTED_TAGS).map_err(|error| error.to_string())?;
    if xml.contains("<cx:chartSpace") {
        return Ok(parse_chartex_part_xml(&parsed, part_path));
    }
    let space = parsed.iter().find(|n| n.name() == Some("c:chartSpace"));
    let chart = space.and_then(|space| space.find_child("c:chart"));
    let plot_area = chart.and_then(|chart| chart.find_child("c:plotArea"));
    let (Some(space), Some(chart), Some(plot_area)) = (space, chart, plot_area) else {
        return Ok(None);
    };

    // first plotted chart type wins (combo charts render their primary series)
    let Some(plot) = plot_area
        .children()
        .iter()
        .find(|c| c.name().unwrap_or("").ends_with("Chart"))
    else {
        return Ok(None);
    };
    let plot_name = plot.name().unwrap_or("");
    let kind = chart_kind(plot_name);
    let child_val = |name: &str| plot.find_child(name).and_then(|n| n.attr("val"));
    let horizontal = kind == ChartDisplayKind::Bar && child_val("c:barDir") == Some("bar");
    let grouping_val = child_val("c:grouping");
    let grouping = if matches!(
        kind,
        ChartDisplayKind::Bar | ChartDisplayKind::Area | ChartDisplayKind::Line
    ) {
        match grouping_val {
            Some("stacked") => Some(ChartDisplayGrouping::Stacked),
            Some("percentStacked") => Some(ChartDisplayGrouping::PercentStacked),
            _ => None,
        }
    } else {
        None
    };
    let scatter_style = child_val("c:scatterStyle");
    let radar_style_val = child_val("c:radarStyle");
    let radar_style = (kind == ChartDisplayKind::Radar).then_some(match radar_style_val {
        Some("filled") => ChartDisplayRadarStyle::Filled,
        Some("marker") => ChartDisplayRadarStyle::Marker,
        _ => ChartDisplayRadarStyle::Standard,
    });
    // every series switching its symbol off overrides the plot-level marker flag
    let symbols_off = plot.find_children("c:ser").all(|ser| {
        ser.find_child("c:marker")
            .and_then(|marker| marker.find_child("c:symbol"))
            .and_then(|symbol| symbol.attr("val"))
            == Some("none")
    });
    let markers = match kind {
        ChartDisplayKind::Line => child_val("c:marker") == Some("1") && !symbols_off,
        ChartDisplayKind::Scatter => {
            // toLowerCase: no character outside ASCII lowers into "marker" differently
            (scatter_style.is_none_or(|style| style.to_lowercase().contains("marker")))
                && !symbols_off
        }
        ChartDisplayKind::Radar => {
            radar_style == Some(ChartDisplayRadarStyle::Marker) && !symbols_off
        }
        _ => false,
    };
    let scatter_lines = kind == ChartDisplayKind::Scatter
        && js_regex!(r"line|smooth", "i").test(scatter_style.unwrap_or(""));
    let hole_val = child_val("c:holeSize");
    // The spec default hole is 50%; an unparseable value falls back to it
    let hole_parsed = hole_val.map_or(f64::NAN, |val| parse_int(val, Radix::Ten));
    let hole_pct = if plot_name == "c:doughnutChart" {
        if hole_parsed.is_finite() {
            hole_parsed
        } else {
            50.0
        }
    } else {
        0.0
    };
    let legend_pos = legend_pos_of(chart);
    let legend_font_pt = text_props(
        chart
            .find_child("c:legend")
            .and_then(|legend| legend.find_child("c:txPr")),
        None,
    )
    .0;
    let data_labels = data_labels_of(plot, theme);
    let frame_line = line_hex(space.find_child("c:spPr"), theme, DEFAULT_FRAME_LINE);
    let axes = axes_of(plot_area, theme);
    let d_table = plot_area.find_child("c:dTable");
    let table_line = d_table
        .and_then(|d_table| line_hex(d_table.find_child("c:spPr"), theme, &auto_line_hex(theme)));
    let data_table = d_table.map(|d_table| ChartDisplayDataTable {
        keys: bool_flag(d_table, "c:showKeys"),
        horz: bool_flag(d_table, "c:showHorzBorder"),
        vert: bool_flag(d_table, "c:showVertBorder"),
        outline: bool_flag(d_table, "c:showOutline"),
        line: table_line.filter(|line| !line.is_empty()),
    });
    let mut explosion_pct: Option<f64> = None;

    let mut categories: Vec<String> = Vec::new();
    let mut series: Vec<ChartSeries> = Vec::new();
    let sers: Vec<&XNode> = plot.find_children("c:ser").collect();
    // split the point budget over the series, so the total stays bounded
    let max_points = math_max(
        1.0,
        (MAX_CHART_CACHE_POINTS / sers.len().min(MAX_CHART_SERIES) as f64).floor(),
    );
    for ser in sers {
        if series.len() >= MAX_CHART_SERIES {
            break;
        }
        // scatter/bubble series carry x/y pairs instead of category/value caches
        let val = ser.find_child("c:val").or_else(|| ser.find_child("c:yVal"));
        let values = val.map_or_else(Vec::new, |val| cache_numbers(val, max_points));
        if values.is_empty() {
            continue;
        }
        let cat = ser.find_child("c:cat").or_else(|| ser.find_child("c:xVal"));
        if let Some(cat) = cat
            && categories.is_empty()
        {
            categories = cache_points(cat, max_points)
                .into_iter()
                .map(Option::unwrap_or_default)
                .collect();
            // date-formatted numeric caches hold Excel serials; display them as dates
            let fmt = cat_format_code(cat);
            if let Some(fmt) = fmt.filter(|fmt| !fmt.is_empty())
                && js_regex!(r"[yd]", "i").test(&fmt)
            {
                categories = categories
                    .into_iter()
                    .map(|v| serial_date_text(&v).unwrap_or(v))
                    .collect();
            } else if cat.name() == Some("c:xVal") {
                // x caches carry raw doubles (0.70000000000000062); trim for display
                categories = categories
                    .into_iter()
                    .map(|v| {
                        let n = to_number(&v);
                        if !v.is_empty() && n.is_finite() {
                            number_to_string(math_round(n * 10000.0) / 10000.0)
                        } else {
                            v
                        }
                    })
                    .collect();
            }
        }
        let name = series_name(ser);
        let mut entry = ChartSeries {
            name,
            values,
            ..ChartSeries::default()
        };
        let color = solid_fill_hex(ser.find_child("c:spPr"), theme);
        if let Some(color) = color.filter(|color| !color.is_empty()) {
            entry.color = Some(color);
        }
        entry.point_colors = data_point_colors(ser, theme, max_points);
        if kind == ChartDisplayKind::Pie && series.is_empty() {
            let expl = parse_int(
                ser.find_child("c:explosion")
                    .and_then(|n| n.attr("val"))
                    .unwrap_or(""),
                Radix::Ten,
            );
            if expl > 0.0 {
                explosion_pct = Some(expl);
            }
        }
        if matches!(kind, ChartDisplayKind::Scatter | ChartDisplayKind::Bubble) {
            let x_val = ser.find_child("c:xVal");
            let x_values = x_val.map_or_else(Vec::new, |x| cache_numbers(x, max_points));
            if x_values.iter().any(Option::is_some) {
                entry.x_values = Some(x_values);
            }
            let size_val = ser.find_child("c:bubbleSize");
            let sizes = size_val.map_or_else(Vec::new, |s| cache_numbers(s, max_points));
            if sizes.iter().any(Option::is_some) {
                entry.sizes = Some(sizes);
            }
            if scatter_lines && !series_line_hidden(ser) {
                entry.line = Some(true);
            }
        }
        series.push(entry);
    }
    if series.is_empty() {
        return Ok(None);
    }

    let palette = chart_palette(chart_style_val(space), theme);
    let title_font_pt = text_props(chart.find_child("c:title"), None).0;
    let mut title = chart_title(chart);
    // Office names a single-series chart's auto title after the series
    if title.as_deref() == Some("Chart Title")
        && series.len() == 1
        && let Some(name) = series[0].name.as_ref().filter(|name| !name.is_empty())
    {
        title = Some(name.clone());
    }
    let mut out = ChartDisplay {
        part_path: Slot::of(part_path.to_owned()),
        kind: Slot::of(kind),
        horizontal: Slot::maybe(horizontal.then_some(true)),
        grouping: Slot::maybe(grouping),
        markers: Slot::maybe(markers.then_some(true)),
        radar_style: Slot::maybe(radar_style),
        hole_pct: Slot::maybe((hole_pct > 0.0).then_some(JsNum(hole_pct))),
        explosion_pct: Slot::maybe(explosion_pct.map(JsNum)),
        data_labels: Slot::maybe(data_labels),
        legend_pos: Slot::maybe(legend_pos),
        no_legend: Slot::maybe(legend_pos.is_none().then_some(true)),
        legend_font_pt: Slot::maybe(legend_font_pt.map(JsNum)),
        frame_line: Slot::maybe(frame_line.filter(|line| !line.is_empty())),
        ..ChartDisplay::default()
    };
    // `...axes`: the keys in the order axesOf set them
    for (slot, axis) in axes {
        match slot {
            AxisSlot::X => out.x_axis.set(axis),
            AxisSlot::Y => out.y_axis.set(axis),
        }
    }
    out.data_table.set_some(data_table);
    out.title.set_some(title);
    out.title_font_pt.set_some(title_font_pt.map(JsNum));
    out.categories.set(categories);
    out.series.set(series);
    out.palette.set_some(palette);
    Ok(Some(out))
}

/// `boolFlag`: CT_Boolean child: absent = false, a val-less element or val="1"/"true" = true
fn bool_flag(parent: &XNode, tag: &str) -> bool {
    let Some(node) = parent.find_child(tag) else {
        return false;
    };
    matches!(node.attr("val"), None | Some("1" | "true"))
}

/// The first a:defRPr / a:rPr below `node`, depth first.
fn first_r_pr(node: &XNode) -> Option<&XNode> {
    for child in node.children() {
        match child.name() {
            Some("a:defRPr" | "a:rPr") => return Some(child),
            _ => {
                if let Some(found) = first_r_pr(child) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// `textProps`: size (pt) and solid colour of the first a:defRPr / a:rPr
fn text_props(node: Option<&XNode>, theme: Option<&ThemeColors>) -> (Option<f64>, Option<String>) {
    let Some(node) = node else {
        return (None, None);
    };
    let Some(r_pr) = first_r_pr(node) else {
        return (None, None);
    };
    let sz = parse_int(r_pr.attr("sz").unwrap_or(""), Radix::Ten);
    let color = solid_fill_hex(Some(r_pr), theme);
    (
        (sz > 0.0).then(|| sz / 100.0),
        color.filter(|color| !color.is_empty()),
    )
}

#[derive(Clone, Copy)]
struct LabelFlags {
    val: bool,
    pct: bool,
    cat: bool,
}

fn flags_of(n: &XNode) -> LabelFlags {
    LabelFlags {
        val: bool_flag(n, "c:showVal"),
        pct: bool_flag(n, "c:showPercent"),
        cat: bool_flag(n, "c:showCatName"),
    }
}

/// `dataLabelsOf`: c:dLbls show* flags; the first series' own dLbls beats the plot-level block.
fn data_labels_of(plot: &XNode, theme: Option<&ThemeColors>) -> Option<ChartDisplayDataLabels> {
    let ser = plot.find_child("c:ser");
    let d_lbls = ser
        .and_then(|ser| ser.find_child("c:dLbls"))
        .or_else(|| plot.find_child("c:dLbls"))?;
    if bool_flag(d_lbls, "c:delete") {
        return None;
    }
    let val = ser.and_then(|ser| ser.find_child("c:val").or_else(|| ser.find_child("c:yVal")));
    let points = val.map_or(0, |val| cache_sparse(val, MAX_CHART_CACHE_POINTS).1);
    let per_point: Vec<&XNode> = d_lbls
        .find_children("c:dLbl")
        .filter(|d| !bool_flag(d, "c:delete"))
        .collect();
    let mut source = d_lbls;
    let mut flags = flags_of(d_lbls);
    if points > 0 && per_point.len() >= points {
        source = per_point[0];
        flags = per_point
            .iter()
            .map(|d| flags_of(d))
            .reduce(|a, f| LabelFlags {
                val: a.val || f.val,
                pct: a.pct || f.pct,
                cat: a.cat || f.cat,
            })
            .unwrap_or(flags);
    }
    if !flags.val && !flags.pct && !flags.cat {
        return None;
    }
    let mut out = ChartDisplayDataLabels::default();
    if flags.val {
        out.val = Some(true);
    }
    if flags.pct {
        out.pct = Some(true);
    }
    if flags.cat {
        out.cat = Some(true);
    }
    let text = text_props(
        source
            .find_child("c:txPr")
            .or_else(|| d_lbls.find_child("c:txPr")),
        theme,
    );
    out.font_pt = text.0.map(JsNum);
    out.color = text.1;
    let num_fmt = source
        .find_child("c:numFmt")
        .or_else(|| d_lbls.find_child("c:numFmt"))
        .and_then(|n| n.attr("formatCode"));
    if let Some(num_fmt) = num_fmt.filter(|f| !f.is_empty()) {
        out.num_fmt = Some(num_fmt.to_owned());
    }
    Some(out)
}

/// The key of `axesOf`'s result an axis goes under.
#[derive(Clone, Copy, PartialEq)]
enum AxisSlot {
    X,
    Y,
}

/// `axesOf`: bottom/left axes by c:axPos, in the order their keys are set.
fn axes_of(plot_area: &XNode, theme: Option<&ThemeColors>) -> Vec<(AxisSlot, ChartAxis)> {
    let mut out: Vec<(AxisSlot, ChartAxis)> = Vec::new();
    let auto_line = auto_line_hex(theme);
    for ax in plot_area.children() {
        let name = ax.name();
        if !matches!(name, Some("c:catAx" | "c:valAx" | "c:dateAx" | "c:serAx")) {
            continue;
        }
        let pos = ax.find_child("c:axPos").and_then(|n| n.attr("val"));
        let slot = match pos {
            Some("b" | "t") => AxisSlot::X,
            Some("l" | "r") => AxisSlot::Y,
            _ => continue,
        };
        if out.iter().any(|(taken, _)| *taken == slot) {
            continue;
        }
        let mut axis = ChartAxis::default();
        if let Some(title) = ax.find_child("c:title") {
            let text = rich_text(title);
            axis.title = Some(if text.is_empty() {
                "Axis Title".to_owned()
            } else {
                text
            });
        }
        axis.line = line_hex(ax.find_child("c:spPr"), theme, &auto_line).filter(|l| !l.is_empty());
        if bool_flag(ax, "c:delete") {
            axis.deleted = Some(true);
        }
        let text = text_props(ax.find_child("c:txPr"), theme);
        axis.font_pt = text.0.map(JsNum);
        axis.color = text.1;
        if let Some(gridlines) = ax.find_child("c:majorGridlines") {
            let grid = line_hex(gridlines.find_child("c:spPr"), theme, &auto_grid_hex(theme));
            axis.grid_line = grid.filter(|g| !g.is_empty());
        }
        out.push((slot, axis));
    }
    out
}

/// `theme?.dk1` where it reads as six hex digits, else black.
fn tx1(theme: Option<&ThemeColors>) -> &str {
    match theme.and_then(|theme| theme.dk1.as_deref()) {
        Some(dk1) if !dk1.is_empty() && is_hex6(dk1) => dk1,
        _ => "000000",
    }
}

/// `autoGridHex`: Office's automatic major gridline: tx1 at 15% tint
fn auto_grid_hex(theme: Option<&ThemeColors>) -> String {
    tint_hex(tx1(theme), 0.15)
}

/// `autoLineHex`: Office's automatic axis / data-table line: tx1 at 75% tint
fn auto_line_hex(theme: Option<&ThemeColors>) -> String {
    tint_hex(tx1(theme), 0.75)
}

fn collect_texts(node: &XNode, tag: &str, texts: &mut Vec<String>) {
    for child in node.children() {
        if child.name() == Some(tag) {
            texts.push(child.text());
        } else {
            collect_texts(child, tag, texts);
        }
    }
}

/// `richText`: a:t / cached c:v texts under a title-like element, concatenated
fn rich_text(node: &XNode) -> String {
    let mut texts = Vec::new();
    collect_texts(node, "a:t", &mut texts);
    if texts.is_empty() {
        collect_texts(node, "c:v", &mut texts);
    }
    texts.concat()
}

/// `lineHex`: a:noFill is `None`, solid is resolved, absent is `auto`.
fn line_hex(sp_pr: Option<&XNode>, theme: Option<&ThemeColors>, auto: &str) -> Option<String> {
    let Some(ln) = sp_pr.and_then(|sp_pr| sp_pr.find_child("a:ln")) else {
        return Some(auto.to_owned());
    };
    if ln.find_child("a:noFill").is_some() {
        return None;
    }
    Some(solid_fill_hex(Some(ln), theme).unwrap_or_else(|| auto.to_owned()))
}

/// `LEGEND_POSITIONS`
pub const LEGEND_POSITIONS: [&str; 5] = ["b", "l", "r", "t", "tr"];

/// `legendPosOf`: the schema default when c:legendPos is absent is "r"
fn legend_pos_of(chart: &XNode) -> Option<ChartDisplayLegendPos> {
    let legend = chart.find_child("c:legend")?;
    let val = legend.find_child("c:legendPos").and_then(|n| n.attr("val"));
    Some(match val {
        Some("b") => ChartDisplayLegendPos::B,
        Some("l") => ChartDisplayLegendPos::L,
        Some("t") => ChartDisplayLegendPos::T,
        Some("tr") => ChartDisplayLegendPos::Tr,
        _ => ChartDisplayLegendPos::R,
    })
}

/// `cacheNumbers`: numeric cache of a c:val / c:yVal / c:xVal / c:bubbleSize container
fn cache_numbers(container: &XNode, max_points: f64) -> Vec<Option<JsNum>> {
    cache_points(container, max_points)
        .into_iter()
        .map(|v| {
            let v = v?;
            if trim(&v).is_empty() {
                return None;
            }
            let n = to_number(&v);
            n.is_finite().then_some(JsNum(n))
        })
        .collect()
}

/// `seriesLineHidden`: the series a:ln is an explicit a:noFill
fn series_line_hidden(ser: &XNode) -> bool {
    ser.find_child("c:spPr")
        .and_then(|sp_pr| sp_pr.find_child("a:ln"))
        .is_some_and(|ln| ln.find_child("a:noFill").is_some())
}

/// `dataPointColors`: c:dPt explicit fills, sparse by point index
fn data_point_colors(
    ser: &XNode,
    theme: Option<&ThemeColors>,
    max_points: f64,
) -> Option<Vec<Option<String>>> {
    let mut out: Vec<Option<String>> = Vec::new();
    let mut any = false;
    for d_pt in ser.find_children("c:dPt") {
        let idx = parse_int(
            d_pt.find_child("c:idx")
                .and_then(|n| n.attr("val"))
                .unwrap_or(""),
            Radix::Ten,
        );
        if !idx.is_finite() || idx < 0.0 || idx >= max_points {
            continue;
        }
        let Some(color) =
            solid_fill_hex(d_pt.find_child("c:spPr"), theme).filter(|color| !color.is_empty())
        else {
            continue;
        };
        let idx = idx as usize;
        if idx >= out.len() {
            out.resize(idx + 1, None);
        }
        out[idx] = Some(color);
        any = true;
    }
    any.then_some(out)
}

/// `ownValue(SCHEME_SLOTS, val)`, read from the theme.
fn scheme_slot<'t>(theme: &'t ThemeColors, val: &str) -> Option<&'t Option<String>> {
    Some(match val {
        "accent1" => &theme.accent1,
        "accent2" => &theme.accent2,
        "accent3" => &theme.accent3,
        "accent4" => &theme.accent4,
        "accent5" => &theme.accent5,
        "accent6" => &theme.accent6,
        "dk1" | "tx1" => &theme.dk1,
        "lt1" | "bg1" => &theme.lt1,
        "dk2" | "tx2" => &theme.dk2,
        "lt2" | "bg2" => &theme.lt2,
        _ => return None,
    })
}

/// `solidFillHex`: an spPr solid fill as hex (no '#'); schemeClr goes through the theme
fn solid_fill_hex(sp_pr: Option<&XNode>, theme: Option<&ThemeColors>) -> Option<String> {
    let fill = sp_pr?.find_child("a:solidFill")?;
    for clr in fill.children() {
        let base: Option<&str> = match clr.name() {
            Some("a:srgbClr") => clr.attr("val"),
            Some("a:sysClr") => clr.attr("lastClr"),
            Some("a:schemeClr") => theme.and_then(|theme| {
                scheme_slot(theme, clr.attr("val").unwrap_or("")).and_then(|slot| slot.as_deref())
            }),
            _ => None,
        };
        let base_trimmed = trim(base.unwrap_or(""));
        if base_trimmed.is_empty() || !is_hex6(base_trimmed) {
            continue;
        }
        return Some(apply_color_mods(&base_trimmed.to_ascii_uppercase(), clr));
    }
    None
}

/// `applyColorMods`: lumMod/lumOff/shade/tint on a hex colour
fn apply_color_mods(hex: &str, clr: &XNode) -> String {
    let mut lum_mod: Option<f64> = None;
    let mut lum_off: Option<f64> = None;
    let mut shade_v: Option<f64> = None;
    let mut tint_v: Option<f64> = None;
    for child in clr.children() {
        let v = parse_int(child.attr("val").unwrap_or(""), Radix::Ten);
        if !v.is_finite() {
            continue;
        }
        match child.name() {
            Some("a:lumMod") => lum_mod = Some(v / 100000.0),
            Some("a:lumOff") => lum_off = Some(v / 100000.0),
            Some("a:shade") => shade_v = Some(v / 100000.0),
            Some("a:tint") => tint_v = Some(v / 100000.0),
            _ => {}
        }
    }
    let mut out = hex.to_owned();
    if let Some(shade) = shade_v {
        out = shade_hex(&out, shade);
    }
    if let Some(tint) = tint_v {
        out = tint_hex(&out, tint);
    }
    if lum_mod.is_some() || lum_off.is_some() {
        out = lum_hex(&out, lum_mod.unwrap_or(1.0), lum_off.unwrap_or(0.0));
    }
    out
}

/// `hexRgb`: `parseInt` of the UTF-16 slices [0, 2), [2, 4), [4, 6).
fn hex_rgb(hex: &str) -> [f64; 3] {
    let units: Vec<u16> = hex.encode_utf16().take(6).collect();
    let part = |from: usize, to: usize| {
        let slice = &units[from.min(units.len())..to.min(units.len())];
        // a half pair parses as no digit, as U+FFFD does
        parse_int(&String::from_utf16_lossy(slice), Radix::Sixteen)
    };
    [part(0, 2), part(2, 4), part(4, 6)]
}

fn rgb_hex(r: f64, g: f64, b: f64) -> String {
    [r, g, b]
        .into_iter()
        .map(|c| {
            pad_start(
                &to_string_radix16(math_max(0.0, math_min(255.0, math_round(c)))),
                2,
                '0',
            )
        })
        .collect::<String>()
        .to_ascii_uppercase()
}

/// `shadeHex`: a:shade, scale toward black
pub fn shade_hex(hex: &str, factor: f64) -> String {
    let [r, g, b] = hex_rgb(hex);
    rgb_hex(r * factor, g * factor, b * factor)
}

/// `tintHex`: a:tint, scale toward white
pub fn tint_hex(hex: &str, factor: f64) -> String {
    let [r, g, b] = hex_rgb(hex);
    let t = |c: f64| c * factor + 255.0 * (1.0 - factor);
    rgb_hex(t(r), t(g), t(b))
}

/// `lumHex`: a:lumMod/a:lumOff, HSL luminance L' = L*mod + off
pub fn lum_hex(hex: &str, r#mod: f64, off: f64) -> String {
    let [r, g, b] = hex_rgb(hex).map(|c| c / 255.0);
    let max = math_max(math_max(r, g), b);
    let min = math_min(math_min(r, g), b);
    let mut h = 0.0;
    let l0 = (max + min) / 2.0;
    let d = max - min;
    let mut s = 0.0;
    if d != 0.0 {
        s = d / (1.0 - (2.0 * l0 - 1.0).abs());
        if max == r {
            h = ((g - b) / d) % 6.0;
        } else if max == g {
            h = (b - r) / d + 2.0;
        } else {
            h = (r - g) / d + 4.0;
        }
        h *= 60.0;
        if h < 0.0 {
            h += 360.0;
        }
    }
    let l = math_max(0.0, math_min(1.0, l0 * r#mod + off));
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - (((h / 60.0) % 2.0) - 1.0).abs());
    let m = l - c / 2.0;
    let seg = if h < 60.0 {
        [c, x, 0.0]
    } else if h < 120.0 {
        [x, c, 0.0]
    } else if h < 180.0 {
        [0.0, c, x]
    } else if h < 240.0 {
        [0.0, x, c]
    } else if h < 300.0 {
        [x, 0.0, c]
    } else {
        [c, 0.0, x]
    };
    rgb_hex(
        (seg[0] + m) * 255.0,
        (seg[1] + m) * 255.0,
        (seg[2] + m) * 255.0,
    )
}

/// `chartStyleVal`: c:style 1-48 (Word 2010 wraps it: mc:Choice c14:style 101-148)
fn chart_style_val(space: &XNode) -> Option<f64> {
    let mut node = space.find_child("c:style");
    if node.is_none() {
        let alt = space.find_child("mc:AlternateContent");
        let choice = alt.and_then(|alt| alt.find_child("mc:Choice"));
        let fallback = alt.and_then(|alt| alt.find_child("mc:Fallback"));
        node = choice
            .and_then(|choice| {
                choice
                    .children()
                    .iter()
                    .find(|c| c.name().unwrap_or("").ends_with(":style"))
            })
            .or_else(|| fallback.and_then(|fallback| fallback.find_child("c:style")));
    }
    let mut v = parse_int(node.and_then(|n| n.attr("val")).unwrap_or(""), Radix::Ten);
    if v > 100.0 {
        v -= 100.0;
    }
    (v.is_finite() && (1.0..=48.0).contains(&v)).then_some(v)
}

/// `GRAYSCALE_PALETTE`: Word's grayscale chart-style series colours (style column 1)
pub const GRAYSCALE_PALETTE: [&str; 6] =
    ["595959", "D9D9D9", "A6A6A6", "404040", "BFBFBF", "8C8C8C"];

/// `chartPalette`: series colour cycle for a chart style column, from the theme accents
fn chart_palette(style_val: Option<f64>, theme: Option<&ThemeColors>) -> Option<Vec<String>> {
    let pos = style_val.map_or(2.0, |v| ((v - 1.0) % 8.0) + 1.0);
    if pos == 1.0 {
        return Some(GRAYSCALE_PALETTE.map(str::to_owned).to_vec());
    }
    let accents = theme.map_or([None; 6], |theme| {
        [
            theme.accent1.as_deref(),
            theme.accent2.as_deref(),
            theme.accent3.as_deref(),
            theme.accent4.as_deref(),
            theme.accent5.as_deref(),
            theme.accent6.as_deref(),
        ]
    });
    if accents
        .iter()
        .any(|a| a.is_none_or(|a| a.is_empty() || !is_hex6(a)))
    {
        return None;
    }
    let list: Vec<String> = accents
        .iter()
        .map(|a| a.unwrap_or("").to_ascii_uppercase())
        .collect();
    if pos == 2.0 {
        return Some(list);
    }
    let base = &list[pos as usize - 3];
    // monochromatic column: one hue, tint/shade ladder between series
    Some(vec![
        base.clone(),
        tint_hex(base, 0.6),
        shade_hex(base, 0.75),
        tint_hex(base, 0.3),
        shade_hex(base, 0.5),
        tint_hex(base, 0.8),
    ])
}

/// `ownValue(CHARTEX_KINDS, layoutId)`
fn chartex_kind(layout: &str) -> Option<ChartDisplayKind> {
    match layout {
        "clusteredColumn" | "boxWhisker" | "waterfall" | "funnel" => Some(ChartDisplayKind::Bar),
        "paretoLine" => Some(ChartDisplayKind::Line),
        "sunburst" | "treemap" => Some(ChartDisplayKind::Pie),
        _ => None,
    }
}

/// One cx:data: its category texts and values.
struct ChartexData {
    cats: Vec<String>,
    vals: Vec<Option<JsNum>>,
}

/// `ptsOf`: the cx:pt texts of a dimension's first cx:lvl, sparse by idx.
fn chartex_points(dim: &XNode) -> Vec<Option<String>> {
    let Some(lvl) = dim.find_child("cx:lvl") else {
        return Vec::new();
    };
    let mut out: Vec<Option<String>> = Vec::new();
    for pt in lvl.find_children("cx:pt") {
        let idx = parse_int(pt.attr("idx").unwrap_or(""), Radix::Ten);
        if idx.is_finite() && (0.0..MAX_CHART_CACHE_POINTS).contains(&idx) {
            let idx = idx as usize;
            if idx >= out.len() {
                out.resize(idx + 1, None);
            }
            out[idx] = Some(pt.text());
        }
    }
    out
}

/// `parseChartexPartXml`: the cx: chart extension degraded to the classic model.
fn parse_chartex_part_xml(parsed: &[XNode], part_path: &str) -> Option<ChartDisplay> {
    let space = parsed.iter().find(|n| n.name() == Some("cx:chartSpace"))?;
    // lenient lookup: accept any child that carries cx:data
    let chart_data = space.find_child("cx:chartData").or_else(|| {
        space
            .children()
            .iter()
            .find(|c| c.find_child("cx:data").is_some())
    });
    // a Map: a later cx:data of the same id replaces the earlier one
    let mut data_by_id: Vec<(String, ChartexData)> = Vec::new();
    for data in chart_data
        .into_iter()
        .flat_map(|chart_data| chart_data.find_children("cx:data"))
    {
        let id = data.attr("id").unwrap_or("").to_owned();
        let mut entry = ChartexData {
            cats: Vec::new(),
            vals: Vec::new(),
        };
        for dim in data.children() {
            match dim.name() {
                // a hole of the sparse array stays a hole in the TypeScript,
                // which JSON writes as null; the model's string[] holds ""
                Some("cx:strDim") => {
                    entry.cats = chartex_points(dim)
                        .into_iter()
                        .map(Option::unwrap_or_default)
                        .collect();
                }
                Some("cx:numDim") => {
                    entry.vals = chartex_points(dim)
                        .into_iter()
                        .map(|v| {
                            let v = v?;
                            if trim(&v).is_empty() {
                                return None;
                            }
                            let n = to_number(&v);
                            n.is_finite().then_some(JsNum(n))
                        })
                        .collect();
                }
                _ => {}
            }
        }
        match data_by_id.iter_mut().find(|(key, _)| *key == id) {
            Some((_, slot)) => *slot = entry,
            None => data_by_id.push((id, entry)),
        }
    }
    let chart = space.find_child("cx:chart");
    let plot_region = chart.and_then(|chart| {
        chart
            .find_child("cx:plotArea")
            .and_then(|plot_area| plot_area.find_child("cx:plotAreaRegion"))
    });
    let mut kind = ChartDisplayKind::Other;
    let mut categories: Vec<String> = Vec::new();
    let mut series: Vec<ChartSeries> = Vec::new();
    for ser in plot_region
        .into_iter()
        .flat_map(|region| region.find_children("cx:series"))
    {
        let layout_kind = chartex_kind(ser.attr("layoutId").unwrap_or(""));
        if kind == ChartDisplayKind::Other
            && let Some(layout_kind) = layout_kind
        {
            kind = layout_kind;
        }
        let data_id = ser
            .find_child("cx:dataId")
            .and_then(|n| n.attr("val"))
            .unwrap_or("");
        let Some((_, data)) = data_by_id.iter().find(|(key, _)| key == data_id) else {
            continue;
        };
        if data.vals.is_empty() {
            continue;
        }
        if categories.is_empty() {
            categories = data.cats.clone();
        }
        let name = ser
            .find_child("cx:tx")
            .and_then(|tx| tx.find_child("cx:txData"))
            .and_then(|tx_data| tx_data.find_child("cx:v"))
            .map_or_else(String::new, XNode::text);
        series.push(ChartSeries {
            name: (!name.is_empty()).then_some(name),
            values: data.vals.clone(),
            ..ChartSeries::default()
        });
    }
    if series.is_empty() {
        return None;
    }
    // cx:title holds a full a:t rich body like classic charts
    let title = chart.and_then(chartex_title);
    Some(ChartDisplay {
        part_path: Slot::of(part_path.to_owned()),
        kind: Slot::of(kind),
        title: Slot::maybe(title),
        categories: Slot::of(categories),
        series: Slot::of(series),
        ..ChartDisplay::default()
    })
}

/// `chartexTitle`
fn chartex_title(chart: &XNode) -> Option<String> {
    let title = chart.find_child("cx:title")?;
    let mut texts = Vec::new();
    collect_texts(title, "a:t", &mut texts);
    let joined = texts.concat();
    (!joined.is_empty()).then_some(joined)
}

/// `catFormatCode`: c:formatCode of a category cache (numCache/numLit), if any
fn cat_format_code(container: &XNode) -> Option<String> {
    let cache = match container.find_child("c:numRef") {
        Some(r#ref) => r#ref.find_child("c:numCache"),
        None => container.find_child("c:numLit"),
    };
    cache
        .and_then(|cache| cache.find_child("c:formatCode"))
        .map(XNode::text)
}

/// `serialDateText`: Excel date serial as "m/d/yyyy"
fn serial_date_text(v: &str) -> Option<String> {
    let n = to_number(v);
    if !n.is_finite() || n <= 0.0 || n > 80000.0 {
        return None;
    }
    // Date.UTC(1899, 11, 31) and Date.UTC(1899, 11, 30), in days
    let base: i64 = if n < 61.0 { -25_568 } else { -25_569 };
    let (year, month, day) = utc_date_parts((base + math_round(n) as i64) as f64 * 86_400_000.0)?;
    Some(format!("{}/{day}/{year}", month + 1.0))
}

/// The points `cachePoints` sets, sparse by idx, and the length it pads them to.
fn cache_sparse(container: &XNode, max_points: f64) -> (Vec<Option<String>>, usize) {
    let cache = match container
        .find_child("c:strRef")
        .or_else(|| container.find_child("c:numRef"))
    {
        Some(r#ref) => r#ref
            .find_child("c:strCache")
            .or_else(|| r#ref.find_child("c:numCache")),
        None => container
            .find_child("c:strLit")
            .or_else(|| container.find_child("c:numLit")),
    };
    let Some(cache) = cache else {
        return (Vec::new(), 0);
    };
    let count = parse_int(
        cache
            .find_child("c:ptCount")
            .and_then(|n| n.attr("val"))
            .unwrap_or(""),
        Radix::Ten,
    );
    let mut points: Vec<Option<String>> = Vec::new();
    for pt in cache.find_children("c:pt") {
        let idx = parse_int(pt.attr("idx").unwrap_or(""), Radix::Ten);
        if !idx.is_finite() || idx < 0.0 || idx >= max_points {
            continue;
        }
        let idx = idx as usize;
        if idx >= points.len() {
            points.resize(idx + 1, None);
        }
        points[idx] = Some(pt.find_child("c:v").map_or_else(String::new, XNode::text));
    }
    let set = points.len() as f64;
    let requested_length = if count.is_finite() {
        math_max(count, set)
    } else {
        set
    };
    let length = math_min(math_max(requested_length, 0.0), max_points);
    (points, length as usize)
}

/// `cachePoints`: cached point texts of a c:cat / c:val / c:tx container, in idx order
fn cache_points(container: &XNode, max_points: f64) -> Vec<Option<String>> {
    let (mut points, length) = cache_sparse(container, max_points);
    points.resize(length, None);
    points
}

/// `seriesName`
fn series_name(ser: &XNode) -> Option<String> {
    let tx = ser.find_child("c:tx")?;
    if let Some(literal) = tx.find_child("c:v") {
        return Some(literal.text());
    }
    // `cachePoints(tx)[0] ?? undefined`: the point at idx 0, where one is set
    cache_sparse(tx, MAX_CHART_CACHE_POINTS)
        .0
        .into_iter()
        .next()
        .flatten()
}

/// `chartTitle`
fn chart_title(chart: &XNode) -> Option<String> {
    let title = chart.find_child("c:title")?;
    // strRef titles carry the cached text in c:strCache c:v, not a:t
    let joined = rich_text(title);
    if !joined.is_empty() {
        return Some(joined);
    }
    // text-less c:title = auto title, unless the auto title was deleted
    let deleted = chart
        .find_child("c:autoTitleDeleted")
        .is_some_and(|del| matches!(del.attr("val"), None | Some("1" | "true")));
    (!deleted).then(|| "Chart Title".to_owned())
}
