//! Tables of generate.ts: `generateTableModelXml` (a whole table from the
//! editable model, keeping what the original tblPr / trPr / tcPr carried) and
//! `generateTableXml` (a fresh self-contained table).

use jscompat::{
    JsNum, RegexLimit, js_regex, math_round, number_to_string, pad_start, to_string_radix16, trim,
};

use super::props::merge_p_pr_format;
use super::runs::runs_xml_in;
use super::{escape_xml_attr, split_xml_children};
use crate::inline_opaque::ContentControlPart;
use crate::model::{
    CellBorder, CellBorders, CellMargins, ParaFormat, PropChangeInfo, PropChangeInfoResolved, Run,
    TableAutoFitMode, TableCell, TableCellTextDirection, TableCellVAlign, TableCellVMerge,
    TableLook, TableModel, TableModelAlign, TableModelFloatSide, TableModelRowHeightRulesItem,
    TableParagraphList,
};

/// What `generateTableModelXml` throws: a trPr whose head the edge insertion
/// cannot find (`head` is null and the TypeScript reads `head[0]`), or a
/// search past the regex bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableXmlError(pub String);

impl std::fmt::Display for TableXmlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TableXmlError {}

impl From<RegexLimit> for TableXmlError {
    fn from(limit: RegexLimit) -> Self {
        Self(limit.to_string())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableGenOptions {
    #[serde(default)]
    pub header_row: bool,
}

/// shading fill used for generated table header rows (hex without '#')
pub const TABLE_HEADER_FILL: &str = "F2F2F2";

/// `Math.max(a, b)`: NaN wins.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min(a, b)`: NaN wins.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

fn num(x: f64) -> String {
    number_to_string(x)
}

/// A number in a boolean position: 0 and NaN are false.
fn truthy_num(x: Option<JsNum>) -> bool {
    x.is_some_and(|x| x.0 != 0.0 && !x.0.is_nan())
}

/// `text.slice(0, at) + insert + text.slice(at)` where `at` may be -1 (the last code unit).
fn insert_at(text: &str, at: Option<usize>, insert: &str) -> String {
    let at = at.unwrap_or_else(|| text.char_indices().next_back().map_or(0, |(at, _)| at));
    format!("{}{insert}{}", &text[..at], &text[at..])
}

fn replace_first(regex: &jscompat::JsRegex, text: &str, with: &str) -> String {
    match regex.exec(text) {
        Some(m) => format!("{}{with}{}", &text[..m.start()], &text[m.end()..]),
        None => text.to_owned(),
    }
}

// ---- resolvePropChangeXml of revision-xml.ts, for the records a table carries ----

struct El {
    name: String,
    start: usize,
    end: usize,
    inner_start: usize,
    inner_end: usize,
    self_closing: bool,
    parent: Option<usize>,
}

struct Edit {
    start: usize,
    end: usize,
    text: String,
}

fn scan(xml: &str) -> Vec<El> {
    let mut out: Vec<El> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let tag = js_regex!(
        r"<(\/?)([A-Za-z][\w.-]*:?[\w.-]*)((?:\s+[^>]*?)?)(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>",
        "g"
    );
    for m in tag.find_iter(xml) {
        let Some(name) = m.get(2) else { continue };
        let (start, end) = (m.start(), m.end());
        if m.get(1).is_some_and(|close| !close.is_empty()) {
            if let Some(i) = stack.iter().rposition(|&at| out[at].name == name) {
                let el = &mut out[stack[i]];
                el.inner_end = start;
                el.end = end;
                stack.truncate(i);
            }
            continue;
        }
        let self_closing = m.get(4).is_some_and(|slash| !slash.is_empty());
        out.push(El {
            name: name.to_owned(),
            start,
            end,
            inner_start: end,
            inner_end: end,
            self_closing,
            parent: stack.last().copied(),
        });
        if !self_closing {
            stack.push(out.len() - 1);
        }
    }
    out
}

fn prop_change_holder(change_name: &str) -> Option<&'static str> {
    match change_name {
        "w:rPrChange" => Some("w:rPr"),
        "w:pPrChange" => Some("w:pPr"),
        "w:sectPrChange" => Some("w:sectPr"),
        "w:tblPrChange" => Some("w:tblPr"),
        "w:tblPrExChange" => Some("w:tblPrEx"),
        "w:trPrChange" => Some("w:trPr"),
        "w:tcPrChange" => Some("w:tcPr"),
        "w:tblGridChange" => Some("w:tblGrid"),
        _ => None,
    }
}

fn remove(el: &El) -> Edit {
    Edit {
        start: el.start,
        end: el.end,
        text: String::new(),
    }
}

fn children_of(els: &[El], parent: usize) -> impl Iterator<Item = (usize, &El)> {
    els.iter()
        .enumerate()
        .filter(move |(_, c)| c.parent == Some(parent))
}

/// restore the pre-change properties recorded in a *Change element
fn revert_prop_change(els: &[El], xml: &str, change_at: usize, holder_name: &str) -> Vec<Edit> {
    let change = &els[change_at];
    let Some(holder_at) = change.parent.filter(|&at| els[at].name == holder_name) else {
        return vec![remove(change)];
    };
    let holder = &els[holder_at];
    let old_inner = children_of(els, change_at)
        .find(|(_, c)| c.name == holder_name)
        .map_or("", |(_, old)| {
            &xml[old.inner_start..old.inner_end.max(old.inner_start)]
        });
    if holder_name == "w:pPr" {
        // the paragraph mark's rPr and the sectPr are not part of the record: keep them in place
        let keep_from = children_of(els, holder_at)
            .find(|&(at, c)| c.name == "w:rPr" || c.name == "w:sectPr" || at == change_at)
            .map_or(change.start, |(_, c)| c.start);
        return vec![
            Edit {
                start: holder.inner_start,
                end: keep_from,
                text: old_inner.to_owned(),
            },
            Edit {
                start: change.start,
                end: change.end,
                text: String::new(),
            },
        ];
    }
    if holder_name == "w:sectPr" {
        let refs: String = children_of(els, holder_at)
            .filter(|(_, c)| c.name == "w:headerReference" || c.name == "w:footerReference")
            .map(|(_, c)| &xml[c.start..c.end])
            .collect();
        return vec![Edit {
            start: holder.inner_start,
            end: holder.inner_end,
            text: refs + old_inner,
        }];
    }
    let is_marker = |c: &El| {
        c.self_closing
            && js_regex!(r"^w:(?:ins|del|moveFrom|moveTo|cellIns|cellDel|cellMerge)$").test(&c.name)
    };
    if children_of(els, holder_at).any(|(_, c)| is_marker(c)) {
        let mut edits: Vec<Edit> = children_of(els, holder_at)
            .filter(|(_, c)| !is_marker(c))
            .map(|(_, c)| remove(c))
            .collect();
        edits.push(Edit {
            start: holder.inner_end,
            end: holder.inner_end,
            text: old_inner.to_owned(),
        });
        return edits;
    }
    if trim(old_inner).is_empty() && holder_name != "w:tblPr" && holder_name != "w:tblGrid" {
        return vec![remove(holder)];
    }
    vec![Edit {
        start: holder.inner_start,
        end: holder.inner_end,
        text: old_inner.to_owned(),
    }]
}

fn apply_edits(xml: &str, mut edits: Vec<Edit>) -> String {
    edits.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    // an edit inside a region another edit replaces is moot
    let mut kept: Vec<Edit> = Vec::new();
    let mut cutoff: Option<usize> = None;
    for edit in edits {
        if cutoff.is_some_and(|cutoff| edit.start < cutoff) {
            continue;
        }
        cutoff = Some(cutoff.map_or(edit.end, |cutoff| cutoff.max(edit.end)));
        kept.push(edit);
    }
    let mut out = xml.to_owned();
    for edit in kept.iter().rev() {
        let end = edit.end.max(edit.start);
        out = format!("{}{}{}", &out[..edit.start], edit.text, &out[end..]);
    }
    out
}

/// `resolvePropChangeXml(xml, changeName, mode)`
fn resolve_prop_change_xml(xml: &str, change_name: &str, mode: PropChangeInfoResolved) -> String {
    if !xml.contains(&format!("<{change_name}")) {
        return xml.to_owned();
    }
    let els = scan(xml);
    let Some(change_at) = els.iter().position(|el| el.name == change_name) else {
        return xml.to_owned();
    };
    let edits = match prop_change_holder(change_name) {
        Some(holder) if mode == PropChangeInfoResolved::Reject => {
            revert_prop_change(&els, xml, change_at, holder)
        }
        _ => vec![remove(&els[change_at])],
    };
    let applied = apply_edits(xml, edits);
    js_regex!(r"<w:(rPr|trPr|tcPr|tblPrEx)><\/w:\1>", "g").replace_all(&applied, |_| String::new())
}

// ---- table helpers ----

/// CT_TcPr child schema order (modeled subset + relative positions of common unmodeled items)
const TCPR_ORDER: [&str; 17] = [
    "w:cnfStyle",
    "w:tcW",
    "w:gridSpan",
    "w:hMerge",
    "w:vMerge",
    "w:tcBorders",
    "w:shd",
    "w:noWrap",
    "w:tcMar",
    "w:textDirection",
    "w:tcFitText",
    "w:vAlign",
    "w:hideMark",
    "w:cellIns",
    "w:cellDel",
    "w:cellMerge",
    "w:tcPrChange",
];

fn order_of(order: &[&str], name: &str) -> Option<usize> {
    order.iter().position(|&tag| tag == name)
}

/// Replace/insert/delete a tcPr child in schema order (xml=None deletes)
fn set_tc_pr_child(children: &mut Vec<(String, String)>, name: &str, xml: Option<String>) {
    let idx = children.iter().position(|(child, _)| child == name);
    let Some(xml) = xml else {
        if let Some(idx) = idx {
            children.remove(idx);
        }
        return;
    };
    if let Some(idx) = idx {
        children[idx] = (name.to_owned(), xml);
        return;
    }
    let order = order_of(&TCPR_ORDER, name);
    let insert_at = children
        .iter()
        .position(|(child, _)| matches!((order_of(&TCPR_ORDER, child), order), (Some(oi), Some(order)) if oi > order))
        .unwrap_or(children.len());
    children.insert(insert_at, (name.to_owned(), xml));
}

fn cell_borders_xml(borders: &CellBorders) -> String {
    let side = |name: &str, b: &Option<CellBorder>| {
        let Some(b) = b else { return String::new() };
        let none = b.style == "none" || b.style == "nil";
        let sz = if none {
            String::new()
        } else {
            format!(
                " w:sz=\"{}\" w:space=\"0\"",
                num(b.sz_eighths.map_or(4.0, |n| n.0))
            )
        };
        let color = if none {
            String::new()
        } else {
            format!(
                " w:color=\"{}\"",
                escape_xml_attr(b.color.as_deref().unwrap_or("auto"))
            )
        };
        format!(
            "<w:{name} w:val=\"{}\"{sz}{color}/>",
            escape_xml_attr(&b.style)
        )
    };
    // CT_TcBorders is a sequence: top, left, bottom, right, tl2br, tr2bl
    format!(
        "<w:tcBorders>{}{}{}{}{}{}</w:tcBorders>",
        side("top", &borders.top),
        side("left", &borders.left),
        side("bottom", &borders.bottom),
        side("right", &borders.right),
        side("tl2br", &borders.tl2br),
        side("tr2bl", &borders.tr2bl)
    )
}

/// w:tcMar / w:tblCellMar with only the declared sides; None when nothing is declared
fn cell_margins_xml(tag: &str, margins: Option<&CellMargins>) -> Option<String> {
    let margins = margins?;
    let sides: String = [
        ("top", *margins.top),
        ("left", *margins.left),
        ("bottom", *margins.bottom),
        ("right", *margins.right),
    ]
    .into_iter()
    .filter_map(|(side, value)| {
        value.map(|value| {
            format!(
                "<w:{side} w:w=\"{}\" w:type=\"dxa\"/>",
                num(js_max(0.0, math_round(value.0)))
            )
        })
    })
    .collect();
    if sides.is_empty() {
        None
    } else {
        Some(format!("<{tag}>{sides}</{tag}>"))
    }
}

/// colSpan clamped to 1..1000 at every emit site
fn cell_span(cell: &TableCell) -> f64 {
    let span = cell.col_span.map_or(1.0, |n| n.0);
    if !span.is_finite() {
        return 1.0;
    }
    js_min(js_max(1.0, span.floor()), 1000.0)
}

/// a property-change record the editor resolved: null = accepted, else its `resolved` verdict
/// (`change`: None = undefined, Some(None) = null)
fn resolved_props(xml: &str, change_name: &str, change: Option<Option<&PropChangeInfo>>) -> String {
    let mode = match change {
        Some(None) => Some(PropChangeInfoResolved::Accept),
        Some(Some(change)) => change.resolved.clone(),
        None => None,
    };
    match mode {
        Some(mode) => resolve_prop_change_xml(xml, change_name, mode),
        None => xml.to_owned(),
    }
}

fn cell_merge_xml(record: &PropChangeInfo) -> String {
    let attr = |name: &str, value: Option<&str>| {
        value.map_or_else(String::new, |value| {
            format!(" {name}=\"{}\"", escape_xml_attr(value))
        })
    };
    format!(
        "<w:cellMerge{}{}{}{}{}{}/>",
        attr("w:id", Some(record.id.as_deref().unwrap_or("0"))),
        attr("w:author", Some(&record.author)),
        attr("w:date", record.date.as_deref()),
        attr("w16du:dateUtc", record.date_utc.as_deref()),
        attr(
            "w:vMerge",
            Some(record.v_merge.as_deref().unwrap_or("cont"))
        ),
        attr("w:vMergeOrig", record.v_merge_orig.as_deref())
    )
}

fn paragraph_xml(
    format: &ParaFormat,
    runs: &[Run],
    list: Option<&TableParagraphList>,
    part: &ContentControlPart,
) -> Result<String, TableXmlError> {
    let num_pr = list.map_or_else(String::new, |list| {
        format!(
            "<w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"{}\"/></w:numPr>",
            num(list.ilvl.0),
            escape_xml_attr(&list.num_id)
        )
    });
    // no cell.align fallback here: it is a display aggregate of the paragraphs' own jc values
    let p_pr = merge_p_pr_format(
        &format!("<w:pPr>{num_pr}</w:pPr>"),
        Some(format),
        None,
        None,
    )?;
    Ok(format!("<w:p>{p_pr}{}</w:p>", runs_xml_in(runs, part)?))
}

/// `items.splice(at, 0, …)` index for `at = Math.min(anchor, length)`.
fn splice_index(anchor: f64, para_count: usize, items_len: usize) -> usize {
    let at = js_min(anchor, para_count as f64);
    if at.is_nan() {
        return 0;
    }
    let at = at.trunc();
    if at < 0.0 {
        js_max(items_len as f64 + at, 0.0) as usize
    } else {
        (at as usize).min(items_len)
    }
}

fn table_cell_xml(
    cell: &TableCell,
    width: f64,
    part: &ContentControlPart,
) -> Result<String, TableXmlError> {
    // Surgical rawTcPr patch: modeled children are replaced/inserted in schema order;
    // unmodeled ones keep their original bytes
    let raw_tc_pr = match cell.raw_tc_pr.as_deref().filter(|raw| !raw.is_empty()) {
        Some(raw) => resolved_props(
            &resolved_props(
                raw,
                "w:tcPrChange",
                cell.tc_pr_change.as_ref().map(Option::as_ref),
            ),
            "w:cellMerge",
            cell.cell_merge.as_ref().map(Option::as_ref),
        ),
        None => String::new(),
    };
    let raw_inner = replace_first(
        js_regex!(r"<\/w:tcPr>$"),
        &replace_first(js_regex!(r"^<w:tcPr(?:\s[^>]*)?>"), &raw_tc_pr, ""),
        "",
    );
    let mut children = if raw_tc_pr.ends_with("</w:tcPr>") {
        split_xml_children(&raw_inner)?
    } else {
        Vec::new()
    };
    set_tc_pr_child(
        &mut children,
        "w:tcW",
        Some(format!("<w:tcW w:w=\"{}\" w:type=\"dxa\"/>", num(width))),
    );
    let span = cell_span(cell);
    set_tc_pr_child(
        &mut children,
        "w:gridSpan",
        (span > 1.0).then(|| format!("<w:gridSpan w:val=\"{}\"/>", num(span))),
    );
    let merge = (*cell.v_merge).clone();
    set_tc_pr_child(
        &mut children,
        "w:vMerge",
        match merge {
            Some(TableCellVMerge::Restart) => Some("<w:vMerge w:val=\"restart\"/>".to_owned()),
            Some(TableCellVMerge::Continue) => Some("<w:vMerge/>".to_owned()),
            Some(TableCellVMerge::Unlisted(_)) | None => None,
        },
    );
    // a merged-away cell rebuilt from its restart cell's bytes lost the merge record it carried
    if let Some(Some(cell_merge)) = &*cell.cell_merge
        && cell_merge.resolved.is_none()
        && merge == Some(TableCellVMerge::Continue)
        && !raw_tc_pr.contains("<w:cellMerge")
    {
        set_tc_pr_child(
            &mut children,
            "w:cellMerge",
            Some(cell_merge_xml(cell_merge)),
        );
    }
    // With borders unmodeled (undefined), leave the raw tcBorders alone
    if let Some(borders) = &*cell.borders {
        set_tc_pr_child(
            &mut children,
            "w:tcBorders",
            Some(cell_borders_xml(borders)),
        );
    }
    set_tc_pr_child(
        &mut children,
        "w:shd",
        cell.fill
            .as_deref()
            .filter(|fill| !fill.is_empty())
            .map(|fill| {
                format!(
                    "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{}\"/>",
                    escape_xml_attr(fill)
                )
            }),
    );
    set_tc_pr_child(
        &mut children,
        "w:vAlign",
        cell.v_align
            .as_ref()
            .filter(|v_align| **v_align != TableCellVAlign::Top)
            .map(|v_align| format!("<w:vAlign w:val=\"{}\"/>", v_align.as_str())),
    );
    if *cell.tc_pr_edited == Some(true) {
        set_tc_pr_child(
            &mut children,
            "w:textDirection",
            cell.text_direction
                .as_ref()
                .filter(|direction| **direction != TableCellTextDirection::LrTb)
                .map(|direction| format!("<w:textDirection w:val=\"{}\"/>", direction.as_str())),
        );
        set_tc_pr_child(
            &mut children,
            "w:tcMar",
            cell_margins_xml("w:tcMar", cell.cell_mar_twips.as_ref()),
        );
        set_tc_pr_child(
            &mut children,
            "w:noWrap",
            (*cell.no_wrap == Some(true)).then(|| "<w:noWrap/>".to_owned()),
        );
    }
    let tc_pr: String = children.into_iter().map(|(_, xml)| xml).collect();
    let para_xmls: Vec<String> = match cell.rich_paras.as_deref().filter(|paras| !paras.is_empty())
    {
        Some(rich) => rich
            .iter()
            .map(|p| paragraph_xml(&p.para_format, &p.runs, p.list.as_ref(), part))
            .collect::<Result<_, _>>()?,
        None => {
            let empty = [String::new()];
            let paras = cell.paras.as_deref().unwrap_or_default();
            let texts: &[String] = if paras.is_empty() { &empty } else { paras };
            let mut format = ParaFormat::default();
            format.align.assign((*cell.align).clone());
            texts
                .iter()
                .map(|text| {
                    let runs = if text.is_empty() {
                        Vec::new()
                    } else {
                        let mut run = Run::default();
                        run.text.set(text.clone());
                        run.bold.assign(*cell.bold);
                        run.color.assign((*cell.color).clone());
                        vec![run]
                    };
                    paragraph_xml(&format, &runs, None, part)
                })
                .collect::<Result<_, _>>()?
        }
    };
    // nested tables are regenerated from the model at their paragraph anchors (reverse
    // insertion keeps anchor indexes valid); OOXML requires tc to end with w:p
    let para_count = para_xmls.len();
    let mut items: Vec<(bool, String)> = para_xmls.into_iter().map(|xml| (false, xml)).collect();
    let nested = cell.nested_tables.as_deref().unwrap_or_default();
    for i in (0..nested.len()).rev() {
        let anchor = cell
            .nested_table_anchors
            .as_ref()
            .and_then(|anchors| anchors.get(i))
            .map_or(para_count as f64, |n| n.0);
        let at = splice_index(anchor, para_count, items.len());
        items.insert(
            at,
            (
                true,
                generate_table_model_xml(&nested[i], None, Some(part))?,
            ),
        );
    }
    let tail = if items.last().is_none_or(|(tbl, _)| *tbl) {
        "<w:p/>"
    } else {
        ""
    };
    let content: String = items.into_iter().map(|(_, xml)| xml).collect();
    Ok(format!(
        "<w:tc><w:tcPr>{tc_pr}</w:tcPr>{content}{tail}</w:tc>"
    ))
}

const TBL_PR_ORDER: [&str; 17] = [
    "w:tblStyle",
    "w:tblpPr",
    "w:tblOverlap",
    "w:bidiVisual",
    "w:tblStyleRowBandSize",
    "w:tblStyleColBandSize",
    "w:tblW",
    "w:jc",
    "w:tblCellSpacing",
    "w:tblInd",
    "w:tblBorders",
    "w:shd",
    "w:tblLayout",
    "w:tblCellMar",
    "w:tblLook",
    "w:tblCaption",
    "w:tblDescription",
];

/// Replace/remove/insert one tblPr child while keeping the OOXML schema order.
fn set_tbl_pr_child(tbl_pr: &str, name: &str, xml: Option<&str>) -> Result<String, TableXmlError> {
    let self_closing = js_regex!(r"^<w:tblPr(?:\s[^>]*)?\/>$").test(tbl_pr);
    let open = if self_closing {
        replace_first(js_regex!(r"\/>$"), tbl_pr, ">")
    } else {
        match js_regex!(r"^<w:tblPr(?:\s[^>]*)?>").exec(tbl_pr) {
            Some(open) => open.as_str().to_owned(),
            None => return Ok(tbl_pr.to_owned()),
        }
    };
    let inner = if self_closing {
        ""
    } else {
        // slice(open.length, lastIndexOf('</w:tblPr>')): -1 cuts off the last code unit
        let end = tbl_pr
            .rfind("</w:tblPr>")
            .unwrap_or_else(|| tbl_pr.char_indices().next_back().map_or(0, |(at, _)| at));
        if end > open.len() {
            &tbl_pr[open.len()..end]
        } else {
            ""
        }
    };
    let mut children: Vec<(String, String)> = split_xml_children(inner)?
        .into_iter()
        .filter(|(child, _)| child != name)
        .collect();
    if let Some(xml) = xml.filter(|xml| !xml.is_empty()) {
        let order = order_of(&TBL_PR_ORDER, name);
        let at = children
            .iter()
            .position(|(child, _)| {
                matches!((order, order_of(&TBL_PR_ORDER, child)), (Some(order), Some(child)) if child > order)
            })
            .unwrap_or(children.len());
        children.insert(at, (name.to_owned(), xml.to_owned()));
    }
    let body: String = children.into_iter().map(|(_, xml)| xml).collect();
    Ok(format!("{open}{body}</w:tblPr>"))
}

fn table_look_xml(look: &TableLook) -> String {
    let val = (if look.first_row { 0x20 } else { 0 })
        | (if look.last_row { 0x40 } else { 0 })
        | (if look.first_column { 0x80 } else { 0 })
        | (if look.last_column { 0x100 } else { 0 })
        | (if look.banded_rows { 0 } else { 0x200 })
        | (if look.banded_columns { 0 } else { 0x400 });
    let bit = |on: bool| if on { 1 } else { 0 };
    format!(
        "<w:tblLook w:val=\"{}\" w:firstRow=\"{}\" w:lastRow=\"{}\" w:firstColumn=\"{}\" w:lastColumn=\"{}\" w:noHBand=\"{}\" w:noVBand=\"{}\"/>",
        pad_start(&to_string_radix16(f64::from(val)).to_uppercase(), 4, '0'),
        bit(look.first_row),
        bit(look.last_row),
        bit(look.first_column),
        bit(look.last_column),
        bit(!look.banded_rows),
        bit(!look.banded_columns)
    )
}

/// the table's own <w:tblPr> (depth-aware: a w:tblPrChange nests another tblPr inside it)
fn original_tbl_pr_of(table_xml: &str) -> Result<Option<String>, TableXmlError> {
    let Some(open) = js_regex!(r"<w:tbl[\s>]").exec(table_xml) else {
        return Ok(None);
    };
    let inner_start = table_xml[open.start()..]
        .find('>')
        .map_or(0, |at| open.start() + at + 1);
    let Some(inner_end) = table_xml.rfind("</w:tbl>") else {
        return Ok(None);
    };
    if inner_start == 0 || inner_end < inner_start {
        return Ok(None);
    }
    Ok(split_xml_children(&table_xml[inner_start..inner_end])?
        .into_iter()
        .find(|(name, _)| name == "w:tblPr")
        .map(|(_, xml)| xml))
}

fn sum(values: impl Iterator<Item = f64>) -> f64 {
    values.fold(0.0, |total, value| total + value)
}

/// A `w:trPr` that holds nothing any more.
fn is_empty_tr_pr(tr_pr: &str) -> bool {
    js_regex!(r"^<w:trPr(?:\s[^>]*)?>\s*<\/w:trPr>$").test(tr_pr)
}

/// `values?.[ri]` of a per-row text array (null and absent alike: the caller writes `?? ''`)
fn row_text(values: &Option<Vec<Option<String>>>, ri: usize) -> Option<&str> {
    values
        .as_ref()
        .and_then(|values| values.get(ri))
        .and_then(Option::as_deref)
}

/// `changes?.[ri]`: None = undefined, Some(None) = null
fn row_change(
    changes: &Option<Vec<Option<PropChangeInfo>>>,
    ri: usize,
) -> Option<Option<&PropChangeInfo>> {
    changes
        .as_ref()
        .and_then(|changes| changes.get(ri))
        .map(Option::as_ref)
}

fn row_flag(values: &Option<Vec<Option<bool>>>, ri: usize) -> Option<bool> {
    values
        .as_ref()
        .and_then(|values| values.get(ri))
        .copied()
        .flatten()
}

fn row_xml(
    model: &TableModel,
    ri: usize,
    row: &[TableCell],
    widths: &[f64],
    part: &ContentControlPart,
) -> Result<String, TableXmlError> {
    let mut grid_column = 0.0;
    let mut cells = String::new();
    let mut cell_count = 0;
    // gridGap placeholders advance the grid but are never written as w:tc
    let (mut before, mut w_before, mut after, mut w_after) = (0.0, 0.0, 0.0, 0.0);
    for cell in row {
        let span = cell_span(cell);
        let from = (grid_column as usize).min(widths.len());
        let to = ((grid_column + span) as usize).min(widths.len()).max(from);
        let width = sum(widths[from..to].iter().copied());
        grid_column += span;
        if *cell.grid_gap == Some(true) {
            if cell_count == 0 {
                before += span;
                w_before += width;
            } else {
                after += span;
                w_after += width;
            }
            continue;
        }
        cells.push_str(&table_cell_xml(cell, width, part)?);
        cell_count += 1;
    }
    // trPr: original bytes passed through; row height is replaced/inserted/removed per the model
    let mut tr_pr = resolved_props(
        row_text(&model.raw_tr_prs, ri).unwrap_or(""),
        "w:trPrChange",
        row_change(&model.row_pr_changes, ri),
    );
    if !tr_pr.is_empty() && !tr_pr.ends_with("</w:trPr>") {
        tr_pr = String::new();
    }
    let mut tbl_pr_ex = resolved_props(
        row_text(&model.raw_tbl_pr_exs, ri).unwrap_or(""),
        "w:tblPrExChange",
        row_change(&model.row_tbl_pr_ex_changes, ri),
    );
    if !tbl_pr_ex.is_empty() && !tbl_pr_ex.ends_with("</w:tblPrEx>") {
        tbl_pr_ex = String::new();
    }
    // the placeholders are the truth for the grid edges
    tr_pr = js_regex!(r"<w:(?:gridBefore|gridAfter|wBefore|wAfter)\b[^>]*\/>", "g")
        .replace_all(&tr_pr, |_| String::new());
    if before > 0.0 || after > 0.0 {
        let mut edge_xml = String::new();
        if before > 0.0 {
            edge_xml.push_str(&format!("<w:gridBefore w:val=\"{}\"/>", num(before)));
        }
        if after > 0.0 {
            edge_xml.push_str(&format!("<w:gridAfter w:val=\"{}\"/>", num(after)));
        }
        if before > 0.0 {
            edge_xml.push_str(&format!(
                "<w:wBefore w:w=\"{}\" w:type=\"dxa\"/>",
                num(w_before)
            ));
        }
        if after > 0.0 {
            edge_xml.push_str(&format!(
                "<w:wAfter w:w=\"{}\" w:type=\"dxa\"/>",
                num(w_after)
            ));
        }
        if tr_pr.is_empty() {
            tr_pr = format!("<w:trPr>{edge_xml}</w:trPr>");
        } else {
            let head = js_regex!(
                r"^<w:trPr(?:\s[^>]*)?>(?:<w:cnfStyle\b[^>]*\/>)?(?:<w:divId\b[^>]*\/>)?"
            )
            .exec(&tr_pr)
            .map(|head| head.end())
            .ok_or_else(|| {
                TableXmlError("Cannot read properties of null (reading '0')".to_owned())
            })?;
            tr_pr = insert_at(&tr_pr, Some(head), &edge_xml);
        }
    } else if is_empty_tr_pr(&tr_pr) {
        tr_pr = String::new();
    }
    if let Some(repeat_header) = row_flag(&model.repeat_header_rows, ri) {
        tr_pr =
            js_regex!(r"<w:tblHeader(?:\s[^>]*)?\/>", "g").replace_all(&tr_pr, |_| String::new());
        if repeat_header {
            let tag = "<w:tblHeader/>";
            tr_pr = if tr_pr.is_empty() {
                format!("<w:trPr>{tag}</w:trPr>")
            } else {
                tr_pr.replacen("</w:trPr>", &format!("{tag}</w:trPr>"), 1)
            };
        } else if is_empty_tr_pr(&tr_pr) {
            tr_pr = String::new();
        }
    }
    if let Some(cant_split) = row_flag(&model.row_cant_split, ri) {
        tr_pr =
            js_regex!(r"<w:cantSplit(?:\s[^>]*)?\/>", "g").replace_all(&tr_pr, |_| String::new());
        if cant_split {
            // CT_TrPr: cantSplit precedes trHeight and tblHeader
            let tag = "<w:cantSplit/>";
            tr_pr = if tr_pr.is_empty() {
                format!("<w:trPr>{tag}</w:trPr>")
            } else {
                let at = js_regex!(r"<w:trHeight\b|<w:tblHeader\b|<\/w:trPr>")
                    .exec(&tr_pr)
                    .map(|m| m.start());
                insert_at(&tr_pr, at, tag)
            };
        } else if is_empty_tr_pr(&tr_pr) {
            tr_pr = String::new();
        }
    }
    let height = model
        .row_heights_twips
        .as_ref()
        .and_then(|v| v.get(ri))
        .copied()
        .flatten();
    match height {
        Some(h) if h.0 > 0.0 => {
            let exact = model
                .row_height_rules
                .as_ref()
                .and_then(|v| v.get(ri))
                .and_then(Option::as_ref)
                == Some(&TableModelRowHeightRulesItem::Exact);
            let rule = if exact { "exact" } else { "atLeast" };
            let tag = format!(
                "<w:trHeight w:val=\"{}\" w:hRule=\"{rule}\"/>",
                num(math_round(h.0))
            );
            if tr_pr.is_empty() {
                tr_pr = format!("<w:trPr>{tag}</w:trPr>");
            } else if js_regex!(r"<w:trHeight[^>]*\/>").test(&tr_pr) {
                tr_pr = replace_first(js_regex!(r"<w:trHeight[^>]*\/>"), &tr_pr, &tag);
            } else {
                tr_pr = tr_pr.replacen("</w:trPr>", &format!("{tag}</w:trPr>"), 1);
            }
        }
        _ if !tr_pr.is_empty() => {
            tr_pr = replace_first(js_regex!(r"<w:trHeight[^>]*\/>"), &tr_pr, "");
            if is_empty_tr_pr(&tr_pr) {
                tr_pr = String::new();
            }
        }
        _ => {}
    }
    Ok(format!("<w:tr>{tbl_pr_ex}{tr_pr}{cells}</w:tr>"))
}

/// Generate a complete table from the editable display model.
pub fn generate_table_model_xml(
    model: &TableModel,
    original_table_xml: Option<&str>,
    part: Option<&ContentControlPart>,
) -> Result<String, TableXmlError> {
    let own;
    let scope = match part {
        Some(part) => part,
        None => {
            own = ContentControlPart::new(&[original_table_xml.unwrap_or_default()], None);
            &own
        }
    };
    // the widest row decides the column count
    let pct = model.col_widths_pct.as_deref();
    let mut column_count = js_max(1.0, pct.map_or(0.0, |pct| pct.len() as f64));
    for row in &model.rows {
        let span = sum(row.iter().map(cell_span));
        if span > column_count {
            column_count = span;
        }
    }
    let count = column_count as usize;
    let percentages: Vec<f64> = match pct {
        Some(pct) if pct.len() as f64 == column_count => pct.iter().map(|n| n.0).collect(),
        _ => vec![100.0 / column_count; count],
    };
    let total = sum(percentages.iter().copied());
    let total_pct = if total == 0.0 || total.is_nan() {
        100.0
    } else {
        total
    };
    let widths: Vec<f64> = match model.col_widths_twips.as_deref() {
        Some(twips) if twips.len() as f64 == column_count => {
            twips.iter().map(|n| js_max(1.0, math_round(n.0))).collect()
        }
        _ => percentages
            .iter()
            .map(|value| js_max(1.0, math_round((value / total_pct) * 9360.0)))
            .collect(),
    };
    let total_width = sum(widths.iter().copied());
    // model borders win over the self-contained single-line default
    let border_of = |name: &str, b: &Option<CellBorder>| match b {
        None if model.borders.is_some() => String::new(),
        None => format!("<w:{name} w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>"),
        Some(b) => format!(
            "<w:{name} w:val=\"{}\"{} w:space=\"0\" w:color=\"{}\"/>",
            escape_xml_attr(&b.style),
            b.sz_eighths.map_or_else(String::new, |sz| format!(
                " w:sz=\"{}\"",
                num(math_round(sz.0))
            )),
            escape_xml_attr(b.color.as_deref().unwrap_or("auto"))
        ),
    };
    let none = None;
    let side = |pick: fn(&crate::model::TableBorders) -> &Option<CellBorder>| {
        model.borders.as_ref().map_or(&none, pick)
    };
    let borders = format!(
        "<w:tblBorders>{}{}{}{}{}{}</w:tblBorders>",
        border_of("top", side(|b| &b.top)),
        border_of("left", side(|b| &b.left)),
        border_of("bottom", side(|b| &b.bottom)),
        border_of("right", side(|b| &b.right)),
        border_of("insideH", side(|b| &b.inside_h)),
        border_of("insideV", side(|b| &b.inside_v))
    );
    let cell_mar = model
        .cell_mar_twips
        .as_ref()
        .map_or_else(String::new, |mar| {
            let side = |name: &str, w: Option<JsNum>| {
                w.map_or_else(String::new, |w| {
                    format!(
                        "<w:{name} w:w=\"{}\" w:type=\"dxa\"/>",
                        num(math_round(w.0))
                    )
                })
            };
            format!(
                "<w:tblCellMar>{}{}{}{}</w:tblCellMar>",
                side("top", *mar.top),
                side("left", *mar.left),
                side("bottom", *mar.bottom),
                side("right", *mar.right)
            )
        });
    let grid_record = match &model.tbl_grid_change {
        Some(Some(change)) if change.resolved.is_none() => format!(
            "<w:tblGridChange w:id=\"{}\"><w:tblGrid>{}</w:tblGrid></w:tblGridChange>",
            escape_xml_attr(change.id.as_deref().unwrap_or("0")),
            change.old_xml.as_deref().unwrap_or("")
        ),
        _ => String::new(),
    };
    let cols: String = widths
        .iter()
        .map(|width| format!("<w:gridCol w:w=\"{}\"/>", num(*width)))
        .collect();
    let grid = format!("<w:tblGrid>{cols}{grid_record}</w:tblGrid>");
    let mut rows = String::new();
    for (ri, row) in model.rows.iter().enumerate() {
        rows.push_str(&row_xml(model, ri, row, &widths, scope)?);
    }
    let original_tbl_pr = original_table_xml
        .filter(|xml| !xml.is_empty())
        .map(original_tbl_pr_of)
        .transpose()?
        .flatten();
    let tbl_ind = match model.indent_twips {
        Some(indent) if truthy_num(Some(indent)) && math_round(indent.0) != 0.0 => {
            format!(
                "<w:tblInd w:w=\"{}\" w:type=\"dxa\"/>",
                num(math_round(indent.0))
            )
        }
        _ => String::new(),
    };
    let mut tbl_pr = resolved_props(
        &original_tbl_pr.clone().unwrap_or_else(|| {
            format!(
                "<w:tblPr><w:tblW w:w=\"{}\" w:type=\"dxa\"/>{tbl_ind}{borders}</w:tblPr>",
                num(total_width)
            )
        }),
        "w:tblPrChange",
        model.tbl_pr_change.as_ref().map(Option::as_ref),
    );
    // Table style reference: '' = remove, non-empty = replace/insert
    if let Some(style) = &model.tbl_style_id {
        let tag = format!("<w:tblStyle w:val=\"{}\"/>", escape_xml_attr(style));
        tbl_pr = set_tbl_pr_child(
            &tbl_pr,
            "w:tblStyle",
            (!style.is_empty()).then_some(tag.as_str()),
        )?;
    }
    // Floating positioning + wrapping. null returns the table to the text flow;
    // undefined leaves an imported tblpPr intact.
    let requested: Option<Option<TableModelFloatSide>> = match (&model.float_side, &model.float_pos)
    {
        (None, Some(pos)) => Some(Some(if pos.x_twips.0 > 4680.0 {
            TableModelFloatSide::Right
        } else {
            TableModelFloatSide::Left
        })),
        (side, _) => side.clone(),
    };
    if requested.is_some() || (original_tbl_pr.is_none() && model.float_pos.is_some()) {
        match requested.flatten() {
            None => {
                tbl_pr = set_tbl_pr_child(&tbl_pr, "w:tblpPr", None)?;
                tbl_pr = set_tbl_pr_child(&tbl_pr, "w:tblOverlap", None)?;
            }
            Some(side) => {
                let (x, y, distance, vert, horz) = match &model.float_pos {
                    Some(pos) => (
                        pos.x_twips.0,
                        pos.y_twips.0,
                        pos.distance_twips.as_ref(),
                        pos.vert_anchor.as_ref().map_or("page", |a| a.as_str()),
                        pos.horz_anchor.as_ref().map_or("page", |a| a.as_str()),
                    ),
                    None => (
                        if side == TableModelFloatSide::Right {
                            js_max(0.0, 9360.0 - total_width)
                        } else {
                            0.0
                        },
                        0.0,
                        None,
                        "page",
                        "page",
                    ),
                };
                let attr = |name: &str, value: Option<JsNum>| {
                    value.map_or_else(String::new, |value| {
                        format!(" w:{name}=\"{}\"", num(js_max(0.0, math_round(value.0))))
                    })
                };
                let tag = format!(
                    "<w:tblpPr{}{}{}{} w:vertAnchor=\"{vert}\" w:horzAnchor=\"{horz}\" w:tblpX=\"{}\" w:tblpY=\"{}\"/>",
                    attr("leftFromText", distance.and_then(|d| *d.left)),
                    attr("rightFromText", distance.and_then(|d| *d.right)),
                    attr("topFromText", distance.and_then(|d| *d.top)),
                    attr("bottomFromText", distance.and_then(|d| *d.bottom)),
                    num(math_round(x)),
                    num(math_round(y))
                );
                tbl_pr = set_tbl_pr_child(&tbl_pr, "w:tblpPr", Some(&tag))?;
                tbl_pr = set_tbl_pr_child(
                    &tbl_pr,
                    "w:tblOverlap",
                    Some("<w:tblOverlap w:val=\"overlap\"/>"),
                )?;
            }
        }
    }
    let effective_auto_fit = model.auto_fit.clone().or_else(|| {
        original_tbl_pr.is_none().then(|| {
            if model.auto_layout == Some(true) {
                TableAutoFitMode::Contents
            } else {
                TableAutoFitMode::Fixed
            }
        })
    });
    if let Some(fit) = effective_auto_fit {
        let tbl_w = match fit {
            TableAutoFitMode::Window => "<w:tblW w:w=\"5000\" w:type=\"pct\"/>".to_owned(),
            TableAutoFitMode::Contents => "<w:tblW w:w=\"0\" w:type=\"auto\"/>".to_owned(),
            TableAutoFitMode::Fixed | TableAutoFitMode::Unlisted(_) => {
                format!("<w:tblW w:w=\"{}\" w:type=\"dxa\"/>", num(total_width))
            }
        };
        tbl_pr = set_tbl_pr_child(&tbl_pr, "w:tblW", Some(&tbl_w))?;
        let layout = if fit == TableAutoFitMode::Fixed {
            "fixed"
        } else {
            "autofit"
        };
        tbl_pr = set_tbl_pr_child(
            &tbl_pr,
            "w:tblLayout",
            Some(&format!("<w:tblLayout w:type=\"{layout}\"/>")),
        )?;
    }
    if model.cell_mar_twips.is_some() {
        tbl_pr = set_tbl_pr_child(&tbl_pr, "w:tblCellMar", Some(&cell_mar))?;
    }
    if let Some(look) = &model.table_look {
        tbl_pr = set_tbl_pr_child(&tbl_pr, "w:tblLook", Some(&table_look_xml(look)))?;
    } else if model
        .tbl_style_id
        .as_deref()
        .is_some_and(|style| !style.is_empty())
        && !js_regex!(r"<w:tblLook[\s/>]").test(&tbl_pr)
    {
        let look = TableLook {
            first_row: true,
            last_row: false,
            first_column: true,
            last_column: false,
            banded_rows: true,
            banded_columns: false,
        };
        tbl_pr = set_tbl_pr_child(&tbl_pr, "w:tblLook", Some(&table_look_xml(&look)))?;
    }
    // Table alignment (w:jc): explicit align replaces/removes the original
    if let Some(align) = &model.align {
        let jc = format!("<w:jc w:val=\"{}\"/>", align.as_str());
        tbl_pr = set_tbl_pr_child(
            &tbl_pr,
            "w:jc",
            (*align != TableModelAlign::Left).then_some(jc.as_str()),
        )?;
    }
    if let Some(caption) = &model.caption {
        let tag = format!("<w:tblCaption w:val=\"{}\"/>", escape_xml_attr(caption));
        tbl_pr = set_tbl_pr_child(
            &tbl_pr,
            "w:tblCaption",
            (!caption.is_empty()).then_some(tag.as_str()),
        )?;
    }
    if let Some(description) = &model.description {
        let tag = format!(
            "<w:tblDescription w:val=\"{}\"/>",
            escape_xml_attr(description)
        );
        tbl_pr = set_tbl_pr_child(
            &tbl_pr,
            "w:tblDescription",
            (!description.is_empty()).then_some(tag.as_str()),
        )?;
    }
    let xml = format!("<w:tbl>{tbl_pr}{grid}{rows}</w:tbl>");
    if part.is_some() {
        Ok(xml)
    } else {
        Ok(scope.finish(&xml)?)
    }
}

/// `String.prototype.repeat(count)` for a count already known not to be negative.
fn repeat(text: &str, count: f64) -> String {
    if count.is_nan() {
        String::new()
    } else {
        text.repeat(count.trunc() as usize)
    }
}

/// Generate a self-contained w:tbl fragment (inline borders, no style reference).
pub fn generate_table_xml(rows: f64, cols: f64, opts: TableGenOptions) -> String {
    let safe_rows = js_min(js_max(rows, 1.0), 50.0);
    let safe_cols = js_min(js_max(cols, 1.0), 20.0);
    let total_width = 9360.0; // 6.5in content width on US Letter
    let col_width = num((total_width / safe_cols).floor());
    let borders: String = ["top", "left", "bottom", "right", "insideH", "insideV"]
        .iter()
        .map(|name| {
            format!("<w:{name} w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>")
        })
        .collect();
    let grid = format!(
        "<w:tblGrid>{}</w:tblGrid>",
        repeat(&format!("<w:gridCol w:w=\"{col_width}\"/>"), safe_cols)
    );
    let cell = |header: bool| {
        format!(
            "<w:tc><w:tcPr><w:tcW w:w=\"{col_width}\" w:type=\"dxa\"/>{}</w:tcPr>{}</w:tc>",
            if header {
                format!("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{TABLE_HEADER_FILL}\"/>")
            } else {
                String::new()
            },
            if header {
                "<w:p><w:r><w:rPr><w:b/></w:rPr></w:r></w:p>"
            } else {
                "<w:p/>"
            }
        )
    };
    let row = |header: bool| format!("<w:tr>{}</w:tr>", repeat(&cell(header), safe_cols));
    let body = if opts.header_row {
        row(true) + &repeat(&row(false), js_max(safe_rows - 1.0, 0.0))
    } else {
        repeat(&row(false), safe_rows)
    };
    // Word requires a paragraph after a table before another table/sectPr
    format!(
        "<w:tbl><w:tblPr><w:tblW w:w=\"{}\" w:type=\"dxa\"/><w:tblBorders>{borders}</w:tblBorders><w:tblLayout w:type=\"fixed\"/></w:tblPr>{grid}{body}</w:tbl><w:p/>",
        num(total_width)
    )
}
