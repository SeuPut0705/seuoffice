//! The write half of chart.ts: a new chart part, a patch of the caches of an
//! existing one, and the embedded workbook beside it. The display model that
//! the read side builds from a chart part is in `crate::chart`.

use jscompat::{JsNum, RegexLimit, TryJsRegex, number_to_string, try_js_regex};
use ooxml_pkg::{DEFAULT_ZIP_LIMITS, Package, load_package};
use pptx_engine::chart_workbook::{ChartWorkbookData, ChartWorkbookSeries, chart_workbook_parts};
use serde::Deserialize;

use crate::generate::escape_xml_text;
use crate::model::{NewChart, NewChartKind, NewChartSeriesItem};

pub use pptx_engine::chart_workbook::{CHART_WORKBOOK_REL_TYPE, col_letter};

/// `strCacheXml`
fn str_cache_xml(values: &[String], f: &str) -> String {
    let points: String = values
        .iter()
        .enumerate()
        .map(|(i, v)| format!("<c:pt idx=\"{i}\"><c:v>{}</c:v></c:pt>", escape_xml_text(v)))
        .collect();
    format!(
        "<c:strRef><c:f>{}</c:f><c:strCache><c:ptCount val=\"{}\"/>{points}</c:strCache></c:strRef>",
        escape_xml_text(f),
        values.len()
    )
}

/// `numCacheXml`
fn num_cache_xml(values: &[Option<JsNum>], f: &str) -> String {
    let points: String = values
        .iter()
        .enumerate()
        .map(|(i, v)| match v {
            None => String::new(),
            Some(v) => format!(
                "<c:pt idx=\"{i}\"><c:v>{}</c:v></c:pt>",
                number_to_string(v.0)
            ),
        })
        .collect();
    format!(
        "<c:numRef><c:f>{}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val=\"{}\"/>{points}</c:numCache></c:numRef>",
        escape_xml_text(f),
        values.len()
    )
}

/// `buildChartPartXml`: build a complete chart part (word/charts/chartN.xml)
/// from data. The chart references an embedded workbook via c:externalData so
/// Word's "Edit Data" works. Pass `external_data_r_id` to wire the
/// c:externalData relationship; pass "" when the workbook will be added in a
/// separate step.
pub fn build_chart_part_xml(chart: &NewChart, external_data_r_id: &str) -> Result<String, String> {
    let rows = chart.categories.len();
    let sers: String = chart
        .series
        .iter()
        .enumerate()
        .map(|(i, ser)| {
            let col = col_letter(i as f64);
            let values = &ser.values[..ser.values.len().min(rows)];
            format!(
                "<c:ser><c:idx val=\"{i}\"/><c:order val=\"{i}\"/><c:tx>{}</c:tx><c:cat>{}</c:cat><c:val>{}</c:val></c:ser>",
                str_cache_xml(std::slice::from_ref(&ser.name), &format!("Sheet1!${col}$1")),
                str_cache_xml(&chart.categories, &format!("Sheet1!$A$2:$A${}", rows + 1)),
                num_cache_xml(values, &format!("Sheet1!${col}$2:${col}${}", rows + 1)),
            )
        })
        .collect();

    let plot = if chart.kind == NewChartKind::Pie {
        format!(
            "<c:pieChart><c:varyColors val=\"1\"/>{sers}<c:firstSliceAng val=\"0\"/></c:pieChart>"
        )
    } else {
        let axes = "<c:catAx><c:axId val=\"111111111\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:delete val=\"0\"/><c:axPos val=\"b\"/><c:crossAx val=\"222222222\"/></c:catAx><c:valAx><c:axId val=\"222222222\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:delete val=\"0\"/><c:axPos val=\"l\"/><c:crossAx val=\"111111111\"/></c:valAx>";
        let inner = if chart.kind == NewChartKind::Bar {
            format!(
                "<c:barChart><c:barDir val=\"col\"/><c:grouping val=\"clustered\"/><c:varyColors val=\"0\"/>{sers}<c:axId val=\"111111111\"/><c:axId val=\"222222222\"/></c:barChart>"
            )
        } else {
            format!(
                "<c:lineChart><c:grouping val=\"standard\"/><c:varyColors val=\"0\"/>{sers}<c:marker val=\"1\"/><c:axId val=\"111111111\"/><c:axId val=\"222222222\"/></c:lineChart>"
            )
        };
        format!("{inner}{axes}")
    };

    let title = match chart.title.as_deref().filter(|title| !title.is_empty()) {
        Some(title) => format!(
            "<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val=\"0\"/></c:title><c:autoTitleDeleted val=\"0\"/>",
            escape_xml_text(title)
        ),
        None => String::new(),
    };

    let external = if external_data_r_id.is_empty() {
        String::new()
    } else {
        format!(
            "<c:externalData r:id=\"{external_data_r_id}\"><c:autoUpdate val=\"0\"/></c:externalData>"
        )
    };
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<c:chartSpace xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><c:chart>{title}<c:plotArea><c:layout/>{plot}</c:plotArea><c:legend><c:legendPos val=\"b\"/><c:overlay val=\"0\"/></c:legend><c:plotVisOnly val=\"1\"/><c:dispBlanksAs val=\"gap\"/></c:chart>{external}</c:chartSpace>"
    ))
}

/// `ChartSeriesPatch`
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ChartSeriesPatch {
    pub name: Option<String>,
    /// aligned with ChartSeries.values; null = keep the original value
    pub values: Option<Vec<Option<JsNum>>>,
}

/// `ChartPatch`
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ChartPatch {
    pub title: Option<String>,
    /// aligned with ChartDisplay.categories; null = keep
    pub categories: Option<Vec<Option<String>>>,
    /// aligned with ChartDisplay.series; null = keep that series untouched
    pub series: Option<Vec<Option<ChartSeriesPatch>>>,
}

/// A byte range of the part.
#[derive(Debug, Clone, Copy)]
struct Range {
    start: usize,
    end: usize,
}

struct Edit {
    range: Range,
    text: String,
}

/// `tagRange`: first depth-0 range of `tag` in [from, to); charts never nest these tags
fn tag_range(xml: &str, tag: &str, from: usize, to: usize) -> Option<Range> {
    let open_prefix = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut i = from;
    while i < to {
        let o = i + xml.get(i..)?.find(&open_prefix)?;
        if o >= to {
            return None;
        }
        let after = xml[o + open_prefix.len()..].chars().next();
        if !matches!(after, Some('>' | ' ' | '/')) {
            // prefix of a longer tag (c:tx vs c:txPr)
            i = o + open_prefix.len();
            continue;
        }
        let end = o + xml[o..].find(&close)?;
        if end >= to {
            return None;
        }
        return Some(Range {
            start: o,
            end: end + tag.len() + 3,
        });
    }
    None
}

/// `tagRanges`: all depth-0 ranges of `tag` (used for c:ser, which never nests)
fn tag_ranges(xml: &str, tag: &str) -> Vec<Range> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(range) = tag_range(xml, tag, from, xml.len()) {
        from = range.end;
        out.push(range);
    }
    out
}

/// `innerTextRanges`: inner-text ranges (between open and close tag) of every
/// `tag` in [from, to)
fn inner_text_ranges(
    xml: &str,
    tag: &str,
    from: usize,
    to: usize,
) -> Result<Vec<Range>, RegexLimit> {
    let re = TryJsRegex::new(&format!(r"<{tag}(?:\s[^>]*)?>([\s\S]*?)</{tag}>"), "g")
        .expect("a pattern built from a tag name compiles");
    let mut out = Vec::new();
    for found in re.try_find_from(xml, from) {
        let found = found?;
        if found.start() >= to {
            break;
        }
        let open_end = found.start() + found.as_str().find('>').unwrap_or(0) + 1;
        out.push(Range {
            start: open_end,
            end: open_end + found.get(1).unwrap_or_default().len(),
        });
    }
    Ok(out)
}

/// `pushPointEdits`: queue edits for the c:v of each indexed cache point
/// present in [range]
fn push_point_edits(
    xml: &str,
    range: Range,
    texts: &[Option<String>],
    edits: &mut Vec<Edit>,
) -> Result<(), RegexLimit> {
    let re = try_js_regex!(r#"<c:pt idx="(\d+)"[^>]*>([\s\S]*?)<\/c:pt>"#, "g");
    for found in re.try_find_from(xml, range.start) {
        let found = found?;
        if found.start() >= range.end {
            break;
        }
        let index = jscompat::parse_int(found.get(1).unwrap_or("0"), jscompat::Radix::Ten);
        let text = if index >= 0.0 {
            texts.get(index as usize).and_then(Option::as_ref)
        } else {
            None
        };
        let Some(text) = text else { continue };
        let inner = inner_text_ranges(xml, "c:v", found.start(), found.end())?;
        if let Some(first) = inner.first() {
            edits.push(Edit {
                range: *first,
                text: text.clone(),
            });
        }
    }
    Ok(())
}

/// `patchChartPartXml`: patch cached texts/numbers of a chart part while
/// keeping the structure — data references (c:f), styling, layout —
/// byte-identical. Anything the patch cannot anchor (missing title, missing
/// cache point) is left as-is. The embedded workbook is intentionally not
/// touched: Word renders from these caches, but "Edit Data" will show the
/// original sheet numbers.
pub fn patch_chart_part_xml(xml: &str, patch: &ChartPatch) -> Result<String, RegexLimit> {
    let mut xml = xml.to_owned();
    // a text-less title (auto title / strRef with no rich body) has no a:t to
    // rewrite: give it one first, then patch it like any other title
    if let Some(title_text) = patch.title.as_deref()
        && let Some(t) = tag_range(&xml, "c:title", 0, xml.len())
        && inner_text_ranges(&xml, "a:t", t.start, t.end)?.is_empty()
        && inner_text_ranges(&xml, "c:v", t.start, t.end)?.is_empty()
    {
        let run_xml = format!("<a:r><a:t>{}</a:t></a:r>", escape_xml_text(title_text));
        let tx = tag_range(&xml, "c:tx", t.start, t.end);
        let p = tx.and_then(|tx| tag_range(&xml, "a:p", tx.start, tx.end));
        if let Some(p) = p {
            // Word auto titles carry an empty c:tx/c:rich paragraph (only
            // a:endParaRPr); CT_Title allows one c:tx, so inject the run there,
            // before a:endParaRPr per schema order
            let end_pr = xml[p.start..].find("<a:endParaRPr").map(|at| p.start + at);
            let at = match end_pr {
                Some(end_pr) if end_pr < p.end => end_pr,
                _ => p.end - "</a:p>".len(),
            };
            xml = format!("{}{run_xml}{}", &xml[..at], &xml[at..]);
        } else {
            let rich = format!(
                "<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p>{run_xml}</a:p></c:rich></c:tx>"
            );
            if let Some(tx) = tx {
                // cache-less strRef tx (no a:p, no c:v): nothing to inject into —
                // replace the whole c:tx with a rich body (CT_Tx is a choice)
                xml = format!("{}{rich}{}", &xml[..tx.start], &xml[tx.end..]);
            } else {
                let open_end = t.start + xml[t.start..].find('>').map_or(0, |at| at + 1);
                xml = format!("{}{rich}{}", &xml[..open_end], &xml[open_end..]);
            }
        }
    }

    let mut edits: Vec<Edit> = Vec::new();

    if let Some(title_text) = patch.title.as_deref()
        && let Some(title) = tag_range(&xml, "c:title", 0, xml.len())
    {
        let mut texts = inner_text_ranges(&xml, "a:t", title.start, title.end)?;
        // strRef titles keep the text in the c:strCache c:v cache instead
        if texts.is_empty() {
            texts = inner_text_ranges(&xml, "c:v", title.start, title.end)?;
        }
        // whole title into the first run, remaining runs blanked
        for (i, range) in texts.into_iter().enumerate() {
            edits.push(Edit {
                range,
                text: if i == 0 {
                    title_text.to_owned()
                } else {
                    String::new()
                },
            });
        }
    }

    for (i, ser) in tag_ranges(&xml, "c:ser").into_iter().enumerate() {
        let ser_patch = patch
            .series
            .as_ref()
            .and_then(|series| series.get(i))
            .and_then(Option::as_ref);
        if let Some(name) = ser_patch.and_then(|patch| patch.name.as_deref())
            && let Some(tx) = tag_range(&xml, "c:tx", ser.start, ser.end)
        {
            let texts = inner_text_ranges(&xml, "c:v", tx.start, tx.end)?;
            if let Some(first) = texts.first() {
                edits.push(Edit {
                    range: *first,
                    text: name.to_owned(),
                });
            }
        }
        if let Some(values) = ser_patch.and_then(|patch| patch.values.as_ref())
            && let Some(val) = tag_range(&xml, "c:val", ser.start, ser.end)
        {
            let texts: Vec<Option<String>> = values
                .iter()
                .map(|v| v.map(|v| number_to_string(v.0)))
                .collect();
            push_point_edits(&xml, val, &texts, &mut edits)?;
        }
        // categories are cached per series; every copy must agree
        if let Some(categories) = patch.categories.as_ref()
            && let Some(cat) = tag_range(&xml, "c:cat", ser.start, ser.end)
        {
            push_point_edits(&xml, cat, categories, &mut edits)?;
        }
    }

    if edits.is_empty() {
        return Ok(xml);
    }
    // later edits first, as `edits.sort((a, b) => b.start - a.start)` (stable)
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.range.start));
    let mut out = xml;
    for edit in edits {
        out = format!(
            "{}{}{}",
            &out[..edit.range.start],
            escape_xml_text(&edit.text),
            &out[edit.range.end..]
        );
    }
    Ok(out)
}

/// `zipToBase64`: the package as a zip (DEFLATE, every entry stamped `now_ms`),
/// base64-encoded.
fn zip_to_base64(package: &Package, now_ms: f64) -> Result<String, String> {
    let bytes = ooxml_pkg::write::generate(package, now_ms).map_err(|error| error.to_string())?;
    Ok(jscompat::base64(&bytes))
}

/// `buildChartWorkbookXlsxBase64`: the chart's embedded workbook (pptx-engine's
/// chart-workbook.ts), base64-encoded. JSZip stamps each entry with the clock:
/// `now_ms` is what `new Date()` holds.
pub fn build_chart_workbook_xlsx_base64(
    categories: &[String],
    series: &[NewChartSeriesItem],
    now_ms: f64,
) -> Result<String, String> {
    let parts = chart_workbook_parts(&ChartWorkbookData {
        categories: categories.to_vec(),
        series: series
            .iter()
            .map(|ser| ChartWorkbookSeries {
                name: ser.name.clone(),
                values: ser.values.clone(),
            })
            .collect(),
        x_values: None,
    });
    let package = Package::from_parts(
        parts
            .entries()
            .into_iter()
            .map(|(path, xml)| (path.to_owned(), xml.clone().into_bytes())),
    );
    zip_to_base64(&package, now_ms)
}

/// `patchChartWorkbookXlsxBase64`: patch the Sheet1 sheetData inside an
/// embedded xlsx file (base64). Rewrites category column A and each series
/// column with the provided values. Returns the updated base64, or `None` on
/// failure.
pub fn patch_chart_workbook_xlsx_base64(
    base64: &str,
    categories: &[String],
    series: &[NewChartSeriesItem],
    now_ms: f64,
) -> Option<String> {
    let bytes = jscompat::atob(base64).ok()?;
    // The workbook came out of the document, so it is held to the document's
    // limits. JSZip is not given an archive the gate refuses.
    let mut package = load_package(&bytes, &DEFAULT_ZIP_LIMITS, |_| Ok(())).ok()?;
    let sheet_xml = package.text("xl/worksheets/sheet1.xml").ok()??.to_owned();

    // Replace only Sheet1's sheetData in place, using inline strings so
    // sharedStrings.xml (and every other part: styles, extra sheets, defined
    // names) survives untouched.
    let inline_str = |reference: &str, text: &str| {
        format!(
            "<c r=\"{reference}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
            escape_xml_text(text)
        )
    };
    let mut header_cells = vec![inline_str("A1", "")];
    for (j, ser) in series.iter().enumerate() {
        header_cells.push(inline_str(&format!("{}1", col_letter(j as f64)), &ser.name));
    }
    let mut data_rows = Vec::new();
    for (i, category) in categories.iter().enumerate() {
        let row_num = i + 2;
        let mut cells = vec![inline_str(&format!("A{row_num}"), category)];
        for (j, ser) in series.iter().enumerate() {
            if let Some(Some(val)) = ser.values.get(i) {
                cells.push(format!(
                    "<c r=\"{}{row_num}\"><v>{}</v></c>",
                    col_letter(j as f64),
                    number_to_string(val.0)
                ));
            }
        }
        data_rows.push(format!("<row r=\"{row_num}\">{}</row>", cells.concat()));
    }
    let new_sheet_data = format!(
        "<sheetData><row r=\"1\">{}</row>{}</sheetData>",
        header_cells.concat(),
        data_rows.concat()
    );

    if !try_js_regex!(r"<sheetData\/>|<sheetData[\s>]")
        .try_test(&sheet_xml)
        .ok()?
    {
        return None;
    }
    let sheet_data = try_js_regex!(r"<sheetData\/>|<sheetData[^>]*>[\s\S]*?<\/sheetData>")
        .try_exec(&sheet_xml)
        .ok()?;
    let mut updated_sheet = match sheet_data {
        Some(found) => format!(
            "{}{new_sheet_data}{}",
            &sheet_xml[..found.start()],
            &sheet_xml[found.end()..]
        ),
        None => sheet_xml,
    };
    let last_col = if series.is_empty() {
        "A".to_owned()
    } else {
        col_letter((series.len() - 1) as f64)
    };
    let last_ref = format!("{last_col}{}", categories.len() + 1);
    let dimension = try_js_regex!(r"<dimension[^>]*\/>")
        .try_exec(&updated_sheet)
        .ok()?;
    if let Some(found) = dimension {
        updated_sheet = format!(
            "{}<dimension ref=\"A1:{last_ref}\"/>{}",
            &updated_sheet[..found.start()],
            &updated_sheet[found.end()..]
        );
    }
    package.set_file(
        "xl/worksheets/sheet1.xml".to_owned(),
        updated_sheet.into_bytes(),
    );
    zip_to_base64(&package, now_ms).ok()
}
