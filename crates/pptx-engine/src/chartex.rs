//! chartEx parsing (packages/pptx-engine/src/chartex.ts): the 2014 cx
//! namespace, ppt/charts/chartExN.xml as a `ChartModel`. Supported
//! layoutIds: funnel and sunburst; any other is `None` (the chip).

use jscompat::{JsNum, parse_float};
use ooxml_xml::{ObjectOptions, parse_object};
use serde_json::Value;

use crate::chart::{
    ChartKind, ChartModel, ChartSeries, Node, SparseColors, Sunburst, get, int, list, string_of,
    try_collect, try_with_capacity,
};
use crate::color::resolve_color_node;
use crate::theme::Theme;

/// `isArray` of `cxParser`.
const CX_ARRAY_NAMES: [&str; 5] = ["cx:data", "cx:lvl", "cx:pt", "cx:series", "cx:dataPt"];

/// Largest level size honored: a hostile ptCount must not allocate the array.
const MAX_CHARTEX_POINTS: f64 = 10000.0;

/// Deepest element walk `collectAT` takes. The parser refuses a tree nested
/// deeper than this already, so the bound only guards the stack.
const MAX_WALK_DEPTH: usize = 512;

/// One cx:lvl: ptCount + sparse idx-to-text points as a dense list ('' for gaps).
fn read_lvl(lvl: Node<'_>) -> Result<Vec<String>, String> {
    let parsed = int(get(lvl, "@_ptCount"));
    let parsed = if parsed == 0.0 || parsed.is_nan() {
        0.0
    } else {
        parsed
    };
    // 0 <= n <= MAX_CHARTEX_POINTS, an integer
    let n = jscompat::math_min(jscompat::math_max(0.0, parsed), MAX_CHARTEX_POINTS) as usize;
    let mut out = try_with_capacity(n)?;
    out.resize(n, String::new());
    for pt in list(get(lvl, "cx:pt")) {
        let i = int(get(Some(pt), "@_idx"));
        // Negative or out-of-range idx would set expando props or grow the
        // array: only dense in-range entries are honored.
        if !i.is_nan() && i >= 0.0 && i < n as f64 {
            let text = if pt.is_object() || pt.is_array() {
                match get(Some(pt), "#text") {
                    None | Some(Value::Null) => String::new(),
                    some => string_of(some),
                }
            } else {
                String::new()
            };
            if let Some(slot) = out.get_mut(i as usize) {
                *slot = text;
            }
        }
    }
    Ok(out)
}

/// All a:t text values in a parsed subtree (handles xml:space="preserve" object form).
fn collect_at(node: Node<'_>) -> Result<Vec<String>, String> {
    fn walk(n: &Value, out: &mut Vec<String>, depth: usize) -> Result<(), String> {
        if depth > MAX_WALK_DEPTH {
            return Err("RangeError: Maximum call stack size exceeded".to_owned());
        }
        let entries: Box<dyn Iterator<Item = (&str, &Value)> + '_> = match n {
            Value::Object(map) => Box::new(map.iter().map(|(k, v)| (k.as_str(), v))),
            // Object.entries of a list: its items under "0", "1", ...
            Value::Array(items) => Box::new(items.iter().map(|v| ("", v))),
            _ => return Ok(()),
        };
        for (k, v) in entries {
            if k.starts_with("@_") {
                continue;
            }
            let items = match v {
                Value::Array(items) => items.as_slice(),
                single => std::slice::from_ref(single),
            };
            if k == "a:t" {
                for t in items {
                    match t {
                        Value::String(text) => out.push(text.clone()),
                        Value::Object(_) | Value::Array(_) => {
                            out.push(match get(Some(t), "#text") {
                                None | Some(Value::Null) => String::new(),
                                some => string_of(some),
                            })
                        }
                        _ => {}
                    }
                }
            } else {
                for c in items {
                    walk(c, out, depth + 1)?;
                }
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    if let Some(node) = node {
        walk(node, &mut out, 0)?;
    }
    Ok(out)
}

/// `parseChartExXml`. `None` is the TypeScript's `null`.
pub fn parse_chart_ex_xml(xml: &str, theme: Option<&Theme>) -> Result<Option<ChartModel>, String> {
    let options = ObjectOptions {
        trim_values: false,
        parse_tag_value: false,
        array_names: &CX_ARRAY_NAMES,
    };
    let Ok(doc) = parse_object(xml, &options) else {
        return Ok(None);
    };
    let space = get(Some(&doc), "cx:chartSpace");
    let region = get(
        get(get(space, "cx:chart"), "cx:plotArea"),
        "cx:plotAreaRegion",
    );
    let series_raw = get(region, "cx:series");
    let ser = match series_raw {
        Some(Value::Array(items)) => items.first(),
        other => other,
    };
    let layout_id = get(ser, "@_layoutId");
    let kind = match layout_id {
        Some(Value::String(id)) if id == "funnel" => ChartKind::Funnel,
        Some(Value::String(id)) if id == "sunburst" => ChartKind::Sunburst,
        _ => return Ok(None),
    };

    // String(d?.['@_id']) === String(dataId), where a missing id reads "undefined"
    let data_id = match get(get(ser, "cx:dataId"), "@_val") {
        Some(id) => string_of(Some(id)),
        None => "0".to_owned(),
    };
    let datas: &[Value] = match get(get(space, "cx:chartData"), "cx:data") {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let data = datas
        .iter()
        .find(|d| string_of(get(Some(*d), "@_id")) == data_id)
        .or_else(|| datas.first());
    let Some(data) = data.filter(|d| jscompat::value_truthy(Some(*d))) else {
        return Ok(None);
    };
    let data = Some(data);
    let str_lvls: Vec<Vec<String>> = match get(get(data, "cx:strDim"), "cx:lvl") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            let mut lvls = try_with_capacity(items.len())?;
            for lvl in items {
                lvls.push(read_lvl(Some(lvl))?);
            }
            lvls
        }
        Some(single) => vec![read_lvl(Some(single))?],
    };
    let num_lvl = match get(get(data, "cx:numDim"), "cx:lvl") {
        Some(Value::Array(items)) => items.first(),
        other => other,
    };
    let values: Vec<Option<JsNum>> = try_collect(read_lvl(num_lvl)?.iter().map(|v| {
        let n = parse_float(v);
        n.is_finite().then_some(JsNum(n))
    }))?;
    if !values.iter().any(Option::is_some) {
        return Ok(None);
    }

    let mut model = ChartModel::default();
    model.kind.set(kind);
    model
        .categories
        .set(str_lvls.first().cloned().unwrap_or_default());
    let mut only = ChartSeries::default();
    only.values.set(values.clone());
    model.series.set(vec![only]);
    // <cx:title/> with no rich text still renders as PowerPoint's placeholder title
    let title = get(get(space, "cx:chart"), "cx:title");
    if title.is_some() {
        let text = collect_at(get(title, "cx:tx"))?.concat();
        model.title.set(if text.is_empty() {
            "Chart Title".to_owned()
        } else {
            text
        });
    }
    if kind == ChartKind::Sunburst {
        let mut point_colors = SparseColors::default();
        let d_pts: &[Value] = match get(ser, "cx:dataPt") {
            None => &[],
            Some(Value::Array(items)) => items,
            Some(single) => std::slice::from_ref(single),
        };
        for d_pt in d_pts {
            let d_pt = Some(d_pt);
            let i = int(get(d_pt, "@_idx"));
            let c = resolve_color_node(get(get(d_pt, "cx:spPr"), "a:solidFill"), theme, None);
            if let Some(c) = c.filter(|_| !i.is_nan()) {
                // pointColors[i] = c: an array index (0 to 2^32 - 2) is an element; any other
                // i (negative, Infinity, 2^32 - 1 and above) a property JSON leaves out
                if (0.0..=4_294_967_294.0).contains(&i) {
                    point_colors.set(i as u32, c);
                }
            }
        }
        model.sunburst.set(Sunburst {
            levels: str_lvls,
            sizes: values,
            point_colors: (!point_colors.is_empty()).then_some(point_colors),
        });
    }
    if kind == ChartKind::Funnel {
        let axis = get(get(get(space, "cx:chart"), "cx:plotArea"), "cx:axis");
        let gap = parse_float(&string_of(get(get(axis, "cx:catScaling"), "@_gapWidth")));
        if gap.is_finite() && gap >= 0.0 {
            model.gap_width_pct.set(JsNum(gap * 100.0));
        }
    }
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
    Ok(Some(model))
}
