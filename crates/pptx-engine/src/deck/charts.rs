//! index.ts 2906-3171: chart editing, the element's own `p:cNvPr`
//! (hidden, name) and the chart data echo-back.

use std::sync::Arc;

use jscompat::{JsNum, JsObject, TryJsRegex, js_regex, replace_first, to_number};
use serde::{Deserialize, Serialize};

use crate::chart::ChartKind;
use crate::chart_insert::{
    NewChartKind, NewChartOptions, NewChartSeries, build_chart_space_xml, write_chart_workbook,
};
use crate::deck::OpenedPptx;
use crate::types::{EmuRect, Slide, SlideElement};
use crate::with_element;
use crate::xml_utils::escape_xml_attr;
use crate::zip::{rels_path_for, resolve_target};

/// The `descr` of a chart this app created: only those are rebuilt.
const APP_CHART: &str = "aislides-chart";

/// The largest series or point index a `pointColors` patch may reach. The
/// TypeScript fills a sparse array; here the rows are dense.
const MAX_POINT_INDEX: usize = 65_536;

/// `escapeRegex`: escape RegExp special characters (`.*+?^${}()|[]\`).
pub(crate) fn escape_regex(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(
            c,
            '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `patch` of `editChartElement`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartEditPatch {
    pub kind: Option<NewChartKind>,
    /// Bar direction for an explicit type change ('bar' = horizontal)
    pub bar_dir: Option<String>,
    pub categories: Option<Vec<String>>,
    pub series: Option<Vec<NewChartSeries>>,
    pub title: Option<String>,
    pub color_scheme: Option<Vec<String>>,
    pub legend_pos: Option<String>,
    pub data_labels: Option<bool>,
    pub gridlines: Option<bool>,
    /// '' = clear
    pub cat_axis_title: Option<String>,
    pub val_axis_title: Option<String>,
    pub gap_width_pct: Option<f64>,
    /// Doughnut hole size percent (kept from the existing chart when unspecified)
    pub hole_size_pct: Option<f64>,
    /// Swap rows/columns: categories and series
    pub switch_row_col: Option<bool>,
    /// Per-point fill overrides, seriesIdx -> pointIdx -> color; null clears back to the series color
    pub point_colors: Option<JsObject<JsObject<Option<String>>>>,
}

/// `Number(key)` as the index of an array, when it is one.
fn array_index_of(key: &str) -> Option<usize> {
    let n = to_number(key);
    (n.fract() == 0.0 && (0.0..4_294_967_295.0).contains(&n)).then_some(n as usize)
}

/// `array[index] = value` on a sparse array: the holes between are `None`.
fn put<T>(items: &mut Vec<Option<T>>, index: usize, value: Option<T>) {
    while items.len() <= index {
        items.push(None);
    }
    if let Some(slot) = items.get_mut(index) {
        *slot = value;
    }
}

fn truthy(s: Option<&str>) -> Option<&str> {
    s.filter(|s| !s.is_empty())
}

/// Chart editing (charts created by this app, rebuilding the chart part):
/// find the element's chart part path (via slide rels), rebuild the XML with
/// the new data/type/colors, and write it back to the archive.
/// structureDirty=true triggers a reparse.
pub fn edit_chart_element(
    opened: &mut OpenedPptx,
    slide_index: usize,
    element_id: &str,
    patch: &ChartEditPatch,
) -> Result<bool, String> {
    let (chart_path, opts) = {
        let Some(slide) = opened.deck.slides.get(slide_index) else {
            return Ok(false);
        };
        let Some(el) = slide
            .elements
            .as_deref()
            .and_then(|els| els.iter().find(|e| e.id() == element_id))
        else {
            return Ok(false);
        };
        let SlideElement::Chart(chart_el) = el else {
            return Ok(false);
        };
        if chart_el.descr.as_deref() != Some(APP_CHART) {
            return Ok(false); // only charts created by this app are editable
        }
        let slide_path = slide.path.as_deref().unwrap_or("");

        // Find the chart part path (looked up from the slide rels)
        let rels = opened.archive.read_text(&rels_path_for(slide_path));
        let Some(rels) = rels.filter(|r| !r.is_empty()) else {
            return Ok(false);
        };

        // Find the r:id in originalXml
        let xml: &str = chart_el
            .anchor
            .as_ref()
            .map(|a| &*a.original_xml)
            .unwrap_or("");
        let Some(r_id_match) = js_regex!(r#"r:id=["']([^"']+)["']"#).exec(xml) else {
            return Ok(false);
        };
        let r_id = r_id_match.get(1).unwrap_or("");

        // Find the chart part path in the rels
        let rel_re = TryJsRegex::new(
            &format!(
                r#"Id=["']{}["'][^>]*Target=["']([^"']+)["']"#,
                escape_regex(r_id)
            ),
            "",
        )
        .map_err(|e| e.to_string())?;
        let Some(rel_match) = rel_re.try_exec(&rels).map_err(|e| e.to_string())? else {
            return Ok(false);
        };
        let chart_path = resolve_target(slide_path, rel_match.get(1).unwrap_or(""));

        // Read existing chart data (used to fill unspecified fields)
        let Some(existing) = chart_el.chart.as_ref() else {
            return Err("the chart element has no chart".to_owned());
        };
        let series: &[crate::chart::ChartSeries] = existing.series.as_deref().unwrap_or(&[]);
        let existing_kind: Option<ChartKind> = *existing.kind;
        // Combo charts (bar+line) parse with main kind 'bar' and line series carrying plotKind='line':
        // when the type isn't explicitly changed, rebuild as comboBarLine so data/color-only edits
        // don't degrade combos into plain bar charts; likewise stacked bar -> barStacked and pie with
        // a hole -> doughnut, so style-only edits don't lose the type subvariant
        let is_combo = existing_kind == Some(ChartKind::Bar)
            && series.iter().any(|s| *s.plot_kind == Some(ChartKind::Line));
        let pseudo_3d = existing.pseudo3_d.unwrap_or(false);
        let grouping = existing.grouping.as_deref();
        // funnel and sunburst have no NewChartKind: the TypeScript hands the string on and the
        // builder takes its plain column branch, where barDir means nothing
        let mut kind_without_bar_dir = false;
        let derived_kind = match existing_kind {
            Some(ChartKind::Unknown) | None => NewChartKind::Bar,
            _ if is_combo => NewChartKind::ComboBarLine,
            Some(ChartKind::Bar) => {
                if grouping == Some("percentStacked") {
                    NewChartKind::BarPercentStacked
                } else if grouping == Some("stacked") {
                    NewChartKind::BarStacked
                } else if pseudo_3d {
                    // 3-D column survives data/style-only rebuilds (stacked 3-D degrades to 2-D stacked)
                    NewChartKind::Bar3D
                } else {
                    NewChartKind::Bar
                }
            }
            Some(ChartKind::Pie) => {
                if existing.hole_pct.map_or(0.0, |n| n.0) > 0.0 {
                    NewChartKind::Doughnut
                } else if pseudo_3d {
                    NewChartKind::Pie3D
                } else {
                    NewChartKind::Pie
                }
            }
            Some(ChartKind::Line) => NewChartKind::Line,
            Some(ChartKind::Area) => NewChartKind::Area,
            Some(ChartKind::Scatter) => NewChartKind::Scatter,
            Some(ChartKind::Radar) => NewChartKind::Radar,
            Some(ChartKind::Funnel) | Some(ChartKind::Sunburst) => {
                kind_without_bar_dir = true;
                NewChartKind::Bar
            }
        };
        let kind = patch.kind.unwrap_or(derived_kind);
        // Horizontal bar direction is preserved through rebuilds; an explicit type change resets it
        // unless the patch asks for barDir 'bar' (the gallery's horizontal-bar entry)
        let bar_dir: Option<String> = match &patch.bar_dir {
            Some(d) => Some(d.clone()),
            None => (patch.kind.is_none()
                && existing_kind == Some(ChartKind::Bar)
                && existing.bar_dir.as_deref() == Some("bar")
                && !is_combo
                && !kind_without_bar_dir)
                .then(|| "bar".to_owned()),
        };
        let mut categories: Vec<String> = match &patch.categories {
            Some(c) => c.clone(),
            None => existing.categories.as_deref().unwrap_or(&[]).to_vec(),
        };
        let mut series_out: Vec<NewChartSeries> = match &patch.series {
            Some(s) => s.clone(),
            None => series
                .iter()
                .map(|s| NewChartSeries {
                    name: s.name.as_deref().unwrap_or("").to_owned(),
                    values: s
                        .values
                        .as_deref()
                        .unwrap_or(&[])
                        .iter()
                        .map(|v| v.map_or(0.0, |n| n.0))
                        .collect(),
                })
                .collect(),
        };
        // Per-point colors survive every rebuild (parsed <c:dPt> back-fill), with patch overrides on top
        let mut point_colors: Vec<Option<Vec<Option<String>>>> =
            series.iter().map(|s| (*s.point_colors).clone()).collect();
        if let Some(overrides) = &patch.point_colors {
            for (si, pts) in overrides.entries() {
                let Some(si) = array_index_of(si) else {
                    continue; // a key that is no index is a property the builder never reads
                };
                if si > MAX_POINT_INDEX {
                    return Err("pointColors: series index too large".to_owned());
                }
                while point_colors.len() <= si {
                    point_colors.push(None);
                }
                let Some(row) = point_colors.get_mut(si) else {
                    continue;
                };
                let row = row.get_or_insert_with(Vec::new);
                for (pi, c) in pts.entries() {
                    let Some(pi) = array_index_of(pi) else {
                        continue;
                    };
                    if pi > MAX_POINT_INDEX {
                        return Err("pointColors: point index too large".to_owned());
                    }
                    put(row, pi, c.clone());
                }
            }
        }
        if patch.switch_row_col == Some(true) {
            let cats = std::mem::take(&mut categories);
            categories = series_out.iter().map(|s| s.name.clone()).collect();
            let cell = |row: &Option<Vec<Option<String>>>, ci: usize| -> Option<String> {
                row.as_ref().and_then(|r| r.get(ci)).cloned().flatten()
            };
            let transposed: Vec<Option<Vec<Option<String>>>> = (0..cats.len())
                .map(|ci| {
                    point_colors
                        .iter()
                        .any(|row| cell(row, ci).is_some())
                        .then(|| point_colors.iter().map(|row| cell(row, ci)).collect())
                })
                .collect();
            series_out = cats
                .iter()
                .enumerate()
                .map(|(ci, cat)| NewChartSeries {
                    name: cat.clone(),
                    values: series_out
                        .iter()
                        .map(|s| s.values.get(ci).copied().unwrap_or(0.0))
                        .collect(),
                })
                .collect();
            point_colors = transposed;
        }
        let title: Option<String> = patch.title.clone().or_else(|| (*existing.title).clone());

        // Style: fields not in the patch keep the values parsed from the existing part (rebuild loses no style)
        let legend_pos: String = match &patch.legend_pos {
            Some(p) => p.clone(),
            None => match existing.legend_pos.as_deref() {
                None => "none".to_owned(),
                Some("tr") => "r".to_owned(),
                Some(p) => p.to_owned(),
            },
        };
        let data_labels = patch
            .data_labels
            .unwrap_or_else(|| existing.data_labels.unwrap_or(false));
        let gridlines = patch.gridlines.unwrap_or_else(|| {
            existing
                .val_axis
                .as_ref()
                .and_then(|a| a.grid_color.as_deref())
                .is_some_and(|c| !c.is_empty())
        });
        let cat_axis_title: Option<String> = patch
            .cat_axis_title
            .clone()
            .or_else(|| existing.cat_axis.as_ref().and_then(|a| a.title.clone()));
        let val_axis_title: Option<String> = patch
            .val_axis_title
            .clone()
            .or_else(|| existing.val_axis.as_ref().and_then(|a| a.title.clone()));
        let gap_width_pct: Option<f64> = patch
            .gap_width_pct
            .or_else(|| existing.gap_width_pct.map(|n| n.0));
        // Colors: when unspecified and every existing series has an explicit color, rebuild with
        // those colors (type/data changes keep the palette)
        let color_scheme: Option<Vec<String>> = match &patch.color_scheme {
            Some(c) => Some(c.clone()),
            None => {
                let colors: Vec<&str> = series
                    .iter()
                    .filter_map(|s| truthy(s.color.as_deref()))
                    .collect();
                (colors.len() == series.len())
                    .then(|| colors.into_iter().map(str::to_owned).collect())
            }
        };
        // A custom doughnut hole used to reset to the build default on every rebuild.
        // A plain pie parses as holePct 0 - forwarding that would clamp a pie->doughnut
        // switch to a 1% hole, so only a real (nonzero) hole is preserved.
        let hole_size_pct: Option<f64> = patch.hole_size_pct.or_else(|| {
            existing
                .hole_pct
                .map(|n| n.0)
                .filter(|n| *n != 0.0 && !n.is_nan())
        });

        let opts = NewChartOptions {
            kind,
            title,
            categories,
            series: series_out,
            offset: EmuRect {
                x: JsNum(0.0),
                y: JsNum(0.0),
                cx: JsNum(0.0),
                cy: JsNum(0.0),
            },
            legend_pos: Some(legend_pos),
            data_labels: Some(data_labels),
            gridlines: Some(gridlines),
            cat_axis_title: cat_axis_title.filter(|t| !t.is_empty()),
            val_axis_title: val_axis_title.filter(|t| !t.is_empty()),
            gap_width_pct,
            bar_dir: bar_dir.filter(|d| !d.is_empty()),
            point_colors: point_colors
                .iter()
                .any(|row| row.as_ref().is_some_and(|r| r.iter().any(Option::is_some)))
                .then_some(point_colors),
            color_scheme,
            hole_size_pct,
        };
        (chart_path, opts)
    };
    let workbook_r_id = write_chart_workbook(opened, &chart_path, &opts)?;
    let xml = build_chart_space_xml(&opts, Some(&workbook_r_id));
    opened
        .archive
        .entries_mut()
        .set(chart_path, xml.into_bytes());
    if let Some(slide) = opened.deck.slides.get_mut(slide_index) {
        slide.structure_dirty.set(true);
    }
    Ok(true)
}

/// Mark a chart not created by this app as editable (cNvPr descr="aislides-chart"):
/// only tags it without rewriting the chart part (the conversion itself is
/// lossless); subsequent edits go through editChartElement's rebuild template, and
/// fine-grained formatting beyond the parsed model (number formats/per-point
/// styles etc.) is dropped at that point.
pub fn mark_chart_editable(slide: &mut Slide, element_id: &str) -> bool {
    let Some(elements) = slide.elements.as_mut() else {
        return false;
    };
    let Some(el) = elements.iter_mut().find(|e| e.id() == element_id) else {
        return false;
    };
    let SlideElement::Chart(chart_el) = el else {
        return false;
    };
    if chart_el.descr.as_deref() == Some(APP_CHART) {
        return true;
    }
    let xml: Arc<str> = match chart_el.anchor.as_ref() {
        Some(a) => a.original_xml.clone(),
        None => return false,
    };
    let Some(m) = js_regex!(r"<p:cNvPr\b[^>]*\/?>").exec(&xml) else {
        return false;
    };
    let tag = if m.as_str().contains("descr=\"") {
        replace_first(
            js_regex!(r#"descr="[^"]*""#),
            0,
            m.as_str(),
            "descr=\"aislides-chart\"",
        )
    } else {
        replace_first(
            js_regex!(r"(\/?>)$"),
            1,
            m.as_str(),
            " descr=\"aislides-chart\"$1",
        )
    };
    let head = xml.get(..m.start()).unwrap_or("");
    let tail = xml.get(m.end()..).unwrap_or("");
    let patched = format!("{head}{tag}{tail}");
    if let Some(a) = chart_el.anchor.as_mut() {
        a.original_xml = Arc::from(patched);
    }
    chart_el.descr.set(APP_CHART.to_owned());
    slide.structure_dirty.set(true);
    true
}

/// Rewrite one attribute of a top-level element's OWN <p:cNvPr> (the first one in its
/// bytes: a group's nvGrpSpPr precedes its children). value None removes it.
/// Returns false when the element or its cNvPr is missing; unchanged bytes stay as is.
///
/// The TypeScript puts `value` into a replacement string, where `$&`, `$1`,
/// `$$` expand; here it is written as given (ledger cnvpr-attr-dollar).
pub(crate) fn patch_own_c_nv_pr_attr(
    slide: &mut Slide,
    element_id: &str,
    name: &str,
    value: Option<&str>,
) -> Result<bool, String> {
    let Some(elements) = slide.elements.as_mut() else {
        return Ok(false);
    };
    let Some(el) = elements.iter_mut().find(|e| e.id() == element_id) else {
        return Ok(false);
    };
    let xml: Arc<str> = match with_element!(&*el, e => e.anchor.as_ref().map(|a| a.original_xml.clone()))
    {
        Some(xml) if !xml.is_empty() => xml,
        _ => return Ok(false),
    };
    let Some(m) = js_regex!(r"<p:cNvPr\b[^>]*?\/?>").exec(&xml) else {
        return Ok(false);
    };
    let tag_text = m.as_str();
    let re = TryJsRegex::new(&format!(r#"\s{name}="[^"]*""#), "").map_err(|e| e.to_string())?;
    let found = re.try_exec(tag_text).map_err(|e| e.to_string())?;
    let tag: String = match (value, &found) {
        (None, Some(f)) => format!(
            "{}{}",
            tag_text.get(..f.start()).unwrap_or(""),
            tag_text.get(f.end()..).unwrap_or("")
        ),
        (None, None) => tag_text.to_owned(),
        (Some(v), Some(f)) => format!(
            "{} {name}=\"{}\"{}",
            tag_text.get(..f.start()).unwrap_or(""),
            escape_xml_attr(v),
            tag_text.get(f.end()..).unwrap_or("")
        ),
        (Some(v), None) => match js_regex!(r"(\s*\/?>)$").exec(tag_text) {
            Some(end) => format!(
                "{} {name}=\"{}\"{}",
                tag_text.get(..end.start()).unwrap_or(""),
                escape_xml_attr(v),
                tag_text.get(end.start()..).unwrap_or("")
            ),
            None => tag_text.to_owned(),
        },
    };
    if tag == tag_text {
        return Ok(true);
    }
    let patched = format!(
        "{}{tag}{}",
        xml.get(..m.start()).unwrap_or(""),
        xml.get(m.end()..).unwrap_or("")
    );
    with_element!(el, e => {
        if let Some(a) = e.anchor.as_mut() {
            a.original_xml = Arc::from(patched);
        }
    });
    slide.structure_dirty.set(true);
    Ok(true)
}

/// Show or hide a top-level element (<p:cNvPr hidden="1">, PowerPoint's Selection Pane eye).
/// Only the element's own cNvPr changes. A hidden element parses as a silent passthrough
/// (never drawn), so the caller rematerializes the slide afterwards (materializeSlide) to
/// bring the model in line - which also renews every element id on the slide.
pub fn set_element_hidden(
    slide: &mut Slide,
    element_id: &str,
    hidden: bool,
) -> Result<bool, String> {
    patch_own_c_nv_pr_attr(slide, element_id, "hidden", hidden.then_some("1"))
}

/// Rename a top-level element (<p:cNvPr name>, the name the Selection Pane shows).
pub fn set_element_name(slide: &mut Slide, element_id: &str, name: &str) -> Result<bool, String> {
    if !patch_own_c_nv_pr_attr(slide, element_id, "name", Some(name))? {
        return Ok(false);
    }
    if let Some(el) = slide
        .elements
        .as_mut()
        .and_then(|els| els.iter_mut().find(|e| e.id() == element_id))
    {
        with_element!(el, e => e.name.set(name.to_owned()));
    }
    Ok(true)
}

/// One series of [`ChartElementData`].
#[derive(Debug, Clone, Serialize)]
pub struct ChartElementSeries {
    pub name: String,
    pub values: Vec<JsNum>,
}

/// What `getChartElementData` answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartElementData {
    pub kind: ChartKind,
    pub title: String,
    pub categories: Vec<String>,
    pub series: Vec<ChartElementSeries>,
    pub series_colors: Vec<Option<String>>,
    pub point_colors: Vec<Option<Vec<Option<String>>>>,
}

/// Read a chart element's current data (for dialog echo-back).
pub fn get_chart_element_data(slide: &Slide, element_id: &str) -> Option<ChartElementData> {
    let el = slide
        .elements
        .as_deref()?
        .iter()
        .find(|e| e.id() == element_id)?;
    let SlideElement::Chart(chart_el) = el else {
        return None;
    };
    let chart = chart_el.chart.as_ref()?;
    let series: &[crate::chart::ChartSeries] = chart.series.as_deref().unwrap_or(&[]);
    Some(ChartElementData {
        kind: (*chart.kind).unwrap_or(ChartKind::Unknown),
        title: chart.title.as_deref().unwrap_or("").to_owned(),
        categories: chart.categories.as_deref().unwrap_or(&[]).to_vec(),
        series: series
            .iter()
            .map(|s| ChartElementSeries {
                name: s.name.as_deref().unwrap_or("").to_owned(),
                values: s
                    .values
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .map(|v| v.unwrap_or(JsNum(0.0)))
                    .collect(),
            })
            .collect(),
        series_colors: series.iter().map(|s| (*s.color).clone()).collect(),
        point_colors: series.iter().map(|s| (*s.point_colors).clone()).collect(),
    })
}
