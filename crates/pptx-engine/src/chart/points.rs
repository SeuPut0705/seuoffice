//! The caches of a series: `cacheFormatCode`, `readNumPoints`,
//! `readStrPoints`, `readDateSerials`, `sortByDate`, `formatDateSerial` and
//! `readPoints` of chart.ts, in its order.

use jscompat::{
    JsNum, js_regex, math_max, math_min, number_to_string, pad_start, sort_by_number,
    utc_date_parts,
};
use serde_json::Value;

use super::model::ChartSeries;
use super::node::{Node, get, int, list, or0, string_of, truthy, val};

/// What V8 throws when it cannot allocate an array's backing store.
pub(crate) const ALLOC_FAILED: &str = "RangeError: Array buffer allocation failed";

/// `Vec::with_capacity(n)` that reports an allocation failure instead of aborting.
pub(crate) fn try_with_capacity<T>(n: usize) -> Result<Vec<T>, String> {
    let mut out = Vec::new();
    out.try_reserve_exact(n)
        .map_err(|_| ALLOC_FAILED.to_owned())?;
    Ok(out)
}

/// `collect()` into a `Vec` that reports an allocation failure instead of aborting.
pub(crate) fn try_collect<T>(items: impl ExactSizeIterator<Item = T>) -> Result<Vec<T>, String> {
    let mut out = try_with_capacity(items.len())?;
    out.extend(items);
    Ok(out)
}

/// Non-General c:formatCode of a value cache.
pub(crate) fn cache_format_code(node: Node<'_>) -> Option<String> {
    let cache = get(get(node, "c:numRef"), "c:numCache").or_else(|| get(node, "c:numLit"));
    let fmt = get(cache, "c:formatCode");
    let text = match fmt {
        Some(Value::String(text)) => text.clone(),
        _ => match get(fmt, "#text") {
            Some(Value::Null) | None => String::new(),
            some => string_of(some),
        },
    };
    (!text.is_empty() && text != "General").then_some(text)
}

/// Numeric cache inside <c:val>/<c:cat>/<c:tx> as numbers (idx order kept,
/// empty points null).
pub(crate) fn read_num_points(
    node: Node<'_>,
    budget: &mut f64,
) -> Result<Vec<Option<JsNum>>, String> {
    let cache = get(get(node, "c:numRef"), "c:numCache").or_else(|| get(node, "c:numLit"));
    if !truthy(cache) {
        return Ok(Vec::new());
    }
    try_collect(read_points(cache, budget)?.into_iter().map(|v| {
        let v = v.filter(|v| !v.is_empty())?;
        let n = jscompat::to_number(&v);
        n.is_finite().then_some(JsNum(n))
    }))
}

/// String cache (strRef/strCache or the innermost lvl of multiLvlStrRef).
pub(crate) fn read_str_points(
    node: Node<'_>,
    date1904: bool,
    budget: &mut f64,
) -> Result<Vec<String>, String> {
    let str_cache = get(get(node, "c:strRef"), "c:strCache").or_else(|| get(node, "c:strLit"));
    if truthy(str_cache) {
        return try_collect(
            read_points(str_cache, budget)?
                .into_iter()
                .map(Option::unwrap_or_default),
        );
    }
    let lit = get(node, "c:v");
    if let Some(lit) = lit {
        let text = match lit {
            Value::String(text) => text.clone(),
            other => match get(Some(other), "#text") {
                Some(Value::Null) | None => string_of(Some(other)),
                some => string_of(some),
            },
        };
        return Ok(vec![text]);
    }
    let multi = get(get(node, "c:multiLvlStrRef"), "c:multiLvlStrCache");
    if truthy(multi) {
        // The innermost (first lvl) holds the leaf categories
        if let Some(first) = list(get(multi, "c:lvl")).first() {
            return try_collect(
                read_points(Some(first), budget)?
                    .into_iter()
                    .map(Option::unwrap_or_default),
            );
        }
    }
    let num_cache = get(get(node, "c:numRef"), "c:numCache");
    if truthy(num_cache) {
        // Date categories: numeric serials + a date formatCode in the cache
        let fmt_str = format_code_text(num_cache);
        let is_date =
            js_regex!(r"[ymd]", "i").test(&fmt_str) && !js_regex!(r"[#0?]").test(&fmt_str);
        return try_collect(read_points(num_cache, budget)?.into_iter().map(|v| {
            let Some(v) = v else { return String::new() };
            if !is_date {
                return v;
            }
            let serial = jscompat::parse_float(&v);
            if serial.is_finite() {
                format_date_serial(serial, &fmt_str, date1904)
            } else {
                v
            }
        }));
    }
    Ok(Vec::new())
}

/// `typeof fmt === 'string' ? fmt : String(fmt?.['#text'] ?? '')`
fn format_code_text(num_cache: Node<'_>) -> String {
    let fmt = get(num_cache, "c:formatCode");
    match fmt {
        Some(Value::String(text)) => text.clone(),
        _ => match get(fmt, "#text") {
            Some(Value::Null) | None => String::new(),
            some => string_of(some),
        },
    }
}

/// Numeric date serials of a category cache (`None` unless every point is a
/// dated number).
pub(crate) fn read_date_serials(
    node: Node<'_>,
    budget: &mut f64,
) -> Result<Option<Vec<f64>>, String> {
    let num_cache = get(get(node, "c:numRef"), "c:numCache");
    if !truthy(num_cache) {
        return Ok(None);
    }
    let fmt_str = format_code_text(num_cache);
    if !js_regex!(r"[ymd]", "i").test(&fmt_str) || js_regex!(r"[#0?]").test(&fmt_str) {
        return Ok(None);
    }
    let serials: Vec<f64> = try_collect(
        read_points(num_cache, budget)?
            .into_iter()
            .map(|v| v.map_or(f64::NAN, |v| jscompat::parse_float(&v))),
    )?;
    Ok(serials.iter().all(|v| v.is_finite()).then_some(serials))
}

/// `[...order.map((i) => arr[i]), ...arr.slice(n)]`, `None` being `undefined`.
fn permute<T: Clone>(
    arr: &[Option<T>],
    order: &[usize],
    n: usize,
) -> Result<Vec<Option<T>>, String> {
    let mut out = try_with_capacity(order.len() + arr.len().saturating_sub(n))?;
    out.extend(order.iter().map(|&i| arr.get(i).cloned().flatten()));
    out.extend(arr.iter().skip(n).cloned());
    Ok(out)
}

/// `pick`: permuted, trailing gaps trimmed, `undefined` when nothing is left.
fn pick<T: Clone>(
    arr: Option<&Vec<Option<T>>>,
    order: &[usize],
    n: usize,
) -> Result<Option<Vec<Option<T>>>, String> {
    let Some(arr) = arr else { return Ok(None) };
    let mut out = permute(arr, order, n)?;
    let end = out.iter().rposition(Option::is_some).map_or(0, |at| at + 1);
    if end == 0 {
        return Ok(None);
    }
    out.truncate(end);
    Ok(Some(out))
}

/// Reorder categories and every per-point series array chronologically.
/// `categories` and `series` are `model.categories` and `model.series`.
pub(crate) fn sort_by_date(
    categories: &mut Vec<String>,
    series: &mut [ChartSeries],
    serials: &[f64],
) -> Result<(), String> {
    let n = categories.len();
    if serials.len() != n {
        return Ok(());
    }
    let mut order: Vec<usize> = try_collect(0..n)?;
    sort_by_number(&mut order, |&a, &b| serials[a] - serials[b]);
    if order.iter().enumerate().all(|(k, &i)| i == k) {
        return Ok(());
    }
    // Indexed arrays follow the sheet point index; points beyond the categories keep their
    // slot. Per-point arrays are sparse, so trailing gaps are trimmed again.
    let sorted: Vec<String> = try_collect(order.iter().map(|&i| categories[i].clone()))?;
    *categories = sorted;
    // new_idx[i] is the sorted position of sheet point i
    let mut new_idx: Vec<usize> = try_collect(0..n)?;
    for (k, &i) in order.iter().enumerate() {
        new_idx[i] = k;
    }
    for s in series.iter_mut() {
        if let Some(values) = s.values.as_ref() {
            let permuted = permute(values, &order, n)?;
            s.values.set(permuted);
        }
        if let Some(labels) = s.point_labels.as_ref() {
            let permuted = permute(labels, &order, n)?;
            s.point_labels.set(permuted);
        }
        let colors = pick(s.point_colors.as_ref(), &order, n)?;
        s.point_colors.assign(colors);
        let fills = pick(s.point_fills.as_ref(), &order, n)?;
        s.point_fills.assign(fills);
        let no_fill = pick(s.point_no_fill.as_ref(), &order, n)?;
        s.point_no_fill.assign(no_fill);
        let lines = pick(s.point_lines.as_ref(), &order, n)?;
        s.point_lines.assign(lines);
        let expl = pick(s.point_explosion_pct.as_ref(), &order, n)?;
        s.point_explosion_pct.assign(expl);
        if let Some(overrides) = s.d_lbl_overrides.as_ref() {
            let moved = overrides
                .iter()
                .map(|d| {
                    let mut d = d.clone();
                    // Map keys are the integers 0..n; -0 finds 0
                    let at = d.idx.0;
                    if at.fract() == 0.0 && at >= 0.0 && at < n as f64 {
                        // an integer in 0..n
                        d.idx = JsNum(new_idx[at as usize] as f64);
                    }
                    d
                })
                .collect();
            s.d_lbl_overrides.set(moved);
        }
    }
    Ok(())
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// `String(x).padStart(2, '0')`
fn two_digits(x: f64) -> String {
    pad_start(&number_to_string(x), 2, '0')
}

pub(crate) fn format_date_serial(serial: f64, fmt: &str, date1904: bool) -> String {
    let ms = (serial - if date1904 { 24107.0 } else { 25569.0 }) * 86_400_000.0;
    let (yyyy, month, day_num) = utc_date_parts(ms).unwrap_or((f64::NAN, f64::NAN, f64::NAN));
    let m_num = month + 1.0;
    // MONTHS[NaN] is undefined, which the replacement writes as "undefined"
    let month_name = if month.is_nan() {
        "undefined"
    } else {
        MONTHS[month as usize]
    };
    let out = js_regex!(r"\\", "g").replace_all(fmt, |_| String::new());
    let out = js_regex!(r"yyyy", "gi").replace_all(&out, |_| number_to_string(yyyy));
    let out = js_regex!(r"yy", "gi").replace_all(&out, |_| two_digits(yyyy % 100.0));
    let out = js_regex!(r"mmm", "gi").replace_all(&out, |_| month_name.to_owned());
    let out = js_regex!(r"mm", "gi").replace_all(&out, |_| two_digits(m_num));
    let out =
        js_regex!(r"(?<![a-z])m(?![a-z])", "gi").replace_all(&out, |_| number_to_string(m_num));
    let out = js_regex!(r"dd", "gi").replace_all(&out, |_| two_digits(day_num));
    js_regex!(r"(?<![a-z])d(?![a-z])", "gi").replace_all(&out, |_| number_to_string(day_num))
}

/// Largest point count honored: a hostile ptCount must not allocate the array.
pub(crate) const MAX_CHART_POINTS: f64 = 1_048_576.0;
/// Empty slots a chart's declared counts may add past their real points, in total.
pub(crate) const MAX_TAIL_PADDING: f64 = MAX_CHART_POINTS;
/// Largest series count honored: bounds the series spreads and per-series work.
pub(crate) const MAX_CHART_SERIES: usize = 256;

/// c:pt list as values ordered by idx. `budget` is `tailPaddingLeft`.
pub(crate) fn read_points(
    cache: Node<'_>,
    budget: &mut f64,
) -> Result<Vec<Option<String>>, String> {
    let pts = list(get(cache, "c:pt"));
    let count = val(cache, "c:ptCount");
    // Allocation follows the data, not the declaration alone: the declared count
    // may only pad past the real points while the chart-wide budget lasts.
    let declared_raw = if count.is_some() {
        int(count)
    } else {
        pts.len() as f64
    };
    let declared = if declared_raw.is_finite() {
        math_max(0.0, declared_raw)
    } else {
        pts.len() as f64
    };
    let max_idx = pts
        .iter()
        .fold(-1.0, |m, pt| math_max(m, or0(int(get(Some(pt), "@_idx")))));
    let n = math_min(
        math_min(math_max(declared, max_idx + 1.0), max_idx + 1.0 + *budget),
        MAX_CHART_POINTS,
    );
    *budget -= math_max(0.0, n - (max_idx + 1.0));
    // 0 <= n <= MAX_CHART_POINTS, an integer
    let n = n as usize;
    let mut out: Vec<Option<String>> = try_with_capacity(n)?;
    out.resize(n, None);
    for pt in pts {
        let idx = or0(int(get(Some(pt), "@_idx")));
        // A sparse hostile idx would grow the array without bound: ignore
        // out-of-range entries instead.
        if idx < 0.0 || idx >= n as f64 {
            continue;
        }
        let v = get(Some(pt), "c:v");
        let text = match v {
            Some(Value::String(text)) => Some(text.clone()),
            Some(other) => Some(match get(Some(other), "#text") {
                Some(Value::Null) | None => string_of(Some(other)),
                some => string_of(some),
            }),
            None => None,
        };
        if let Some(slot) = out.get_mut(idx as usize) {
            *slot = text;
        }
    }
    Ok(out)
}
