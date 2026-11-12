//! Table editing of index.ts (lines 2756-2911 and 3722-4178): cell text, table
//! style, row/column structure, merge/split, column/row sizes, resize and the
//! cell anchor. The XML surgery works on byte offsets of one string, as the
//! TypeScript works on UTF-16 offsets of one string: every offset comes from a
//! search of the same text, so a slice is the same piece.

use std::sync::Arc;

use jscompat::{
    JsNum, JsRegex, index_of, js_regex, last_index_of, math_max, math_round, number_to_string,
    number_truthy, replace_first, replace_first_with, to_number,
};
use serde::{Deserialize, Serialize};

use crate::deck::{OpenedPptx, materialize_slide, patched_element_xml};
use crate::generate::generate_paragraph_xml;
use crate::notes::replace_literal;
use crate::table_edit::{TableStyleEdit, ensure_table_style_xml, patch_table_style_xml};
use crate::types::{
    Paragraph, Slide, SlideElement, TableCell, TableElement, TextAnchor, TextBody, TextInsets,
    TextRun,
};
use crate::xml_utils::{has_content_type_override, max_relationship_id_number};

// ── Offsets ─────────────────────────────────────────────────────────────

/// `text.slice(start, end)` for offsets of this very text: a reversed range is empty.
fn sl(text: &str, start: usize, end: usize) -> &str {
    if start >= end {
        return "";
    }
    text.get(start..end).unwrap_or("")
}

/// `text.slice(start)`
fn tail(text: &str, start: usize) -> &str {
    text.get(start..).unwrap_or("")
}

/// `text.slice(0, end)`
fn head(text: &str, end: usize) -> &str {
    text.get(..end).unwrap_or("")
}

/// `array[n]` where `n` is a number: the index when it is an integer inside the array.
fn index_in(n: f64, len: usize) -> Option<usize> {
    (n >= 0.0 && n.fract() == 0.0 && n < len as f64).then_some(n as usize)
}

// ── Spans ───────────────────────────────────────────────────────────────

/// One `<a:gridCol>` of `gridColSpans`.
struct GridColSpan {
    start: usize,
    end: usize,
    open: String,
}

/// All <a:gridCol> spans in document order. gridCol comes in both forms —
/// self-closing, and paired when it carries children — so each is read as the
/// TypeScript reads it: a paired one runs to its close tag and the scan resumes
/// after it (matches starting inside are skipped; a match cannot reach past the
/// `>` that ends the span, so one pass finds what the restarted scan finds).
fn grid_col_spans(xml: &str) -> Vec<GridColSpan> {
    let mut spans = Vec::new();
    let mut resume = 0usize;
    for m in js_regex!(r"<a:gridCol\b[^>]*?(\/)?>").find_iter(xml) {
        if m.start() < resume {
            continue;
        }
        if m.get(1).is_some() {
            spans.push(GridColSpan {
                start: m.start(),
                end: m.end(),
                open: m.as_str().to_owned(),
            });
        } else {
            let Some(close) = index_of(xml, "</a:gridCol>", m.end()) else {
                break;
            };
            let end = close + "</a:gridCol>".len();
            spans.push(GridColSpan {
                start: m.start(),
                end,
                open: m.as_str().to_owned(),
            });
            resume = end;
        }
    }
    spans
}

/// Locate the nth <tag>…</tag> span in the xml (a:tr/a:tc never self-nest, so a
/// sequential scan suffices). `n` is a number: only an integer inside the count
/// is ever found.
fn nth_tag_span(xml: &str, tag: &str, n: f64) -> Option<(usize, usize)> {
    // every caller names `a:tr` or `a:tc`
    let open_re: &JsRegex = match tag {
        "a:tr" => js_regex!(r"<a:tr(?:\s[^>]*)?>"),
        _ => js_regex!(r"<a:tc(?:\s[^>]*)?>"),
    };
    let close_tag = format!("</{tag}>");
    let mut i = 0usize;
    let mut resume = 0usize;
    for m in open_re.find_iter(xml) {
        if m.start() < resume {
            continue;
        }
        let close = index_of(xml, &close_tag, m.end())?;
        let end = close + close_tag.len();
        if i as f64 == n {
            return Some((m.start(), end));
        }
        i += 1;
        resume = end;
    }
    None
}

// ── Element access ──────────────────────────────────────────────────────

/// `slide.elements.find((e) => e.id === elementId)` when it is a table.
fn find_table<'a>(slide: &'a mut Slide, element_id: &str) -> Option<&'a mut SlideElement> {
    let el = slide
        .elements
        .as_mut()?
        .iter_mut()
        .find(|e| e.id() == element_id)?;
    if matches!(&*el, SlideElement::Table(_)) {
        Some(el)
    } else {
        None
    }
}

fn table_mut(el: &mut SlideElement) -> Option<&mut TableElement> {
    match el {
        SlideElement::Table(t) => Some(&mut **t),
        _ => None,
    }
}

/// `table.rows[row]?.[col]`
fn cell_at(table: &TableElement, row: f64, col: f64) -> Option<&TableCell> {
    let rows = table.rows.as_ref()?;
    let r = rows.get(index_in(row, rows.len())?)?;
    r.get(index_in(col, r.len())?)
}

fn cell_at_mut(table: &mut TableElement, row: f64, col: f64) -> Option<&mut TableCell> {
    let rows = table.rows.as_mut()?;
    let ri = index_in(row, rows.len())?;
    let r = rows.get_mut(ri)?;
    let ci = index_in(col, r.len())?;
    r.get_mut(ci)
}

fn original_xml(table: &TableElement) -> Option<String> {
    table.anchor.as_ref().map(|a| a.original_xml.to_string())
}

fn set_original_xml(table: &mut TableElement, xml: String) {
    if let Some(a) = table.anchor.as_mut() {
        a.original_xml = Arc::from(xml);
    }
}

/// `el.dirty = el.dirtyTransform = el.dirtyFill = el.dirtyStroke = false; el.dirtyPPr = undefined`
/// (the chain assigns right to left).
fn clear_dirty(table: &mut TableElement) {
    table.dirty_stroke.set(false);
    table.dirty_fill.set(false);
    table.dirty_transform.set(false);
    table.dirty.set(false);
    table.dirty_p_pr.assign(None);
}

fn sum_of(values: &[JsNum]) -> f64 {
    let mut sum = 0.0;
    for v in values {
        sum += v.0;
    }
    sum
}

// ── Table cell text editing ─────────────────────────────────────────────

/// Rewrite table cell text: XML surgery (replacing the txBody paragraphs of the
/// col-th a:tc inside the row-th a:tr, keeping bodyPr/lstStyle/tcPr) with the model
/// synced. col is the tc index (not the logical column).
pub fn edit_table_cell_text(
    slide: &mut Slide,
    element_id: &str,
    row: f64,
    col: f64,
    paragraphs: &[Paragraph],
) -> bool {
    let Some(el) = find_table(slide, element_id) else {
        return false;
    };
    let Some(table) = table_mut(el) else {
        return false;
    };
    match cell_at(table, row, col) {
        Some(cell) if *cell.merged != Some(true) => {}
        _ => return false,
    }
    let Some(xml) = original_xml(table) else {
        return false;
    };
    let Some((tr_start, tr_end)) = nth_tag_span(&xml, "a:tr", row) else {
        return false;
    };
    let tr_xml = sl(&xml, tr_start, tr_end);
    let Some((tc_start, tc_end)) = nth_tag_span(tr_xml, "a:tc", col) else {
        return false;
    };
    let tc_xml = sl(tr_xml, tc_start, tc_end);

    let Some(tx_open) = js_regex!(r"<a:txBody(\s[^>]*)?>").exec(tc_xml) else {
        return false;
    };
    let Some(tx_end) = last_index_of(tc_xml, "</a:txBody>", i64::MAX) else {
        return false;
    };
    let inner = sl(tc_xml, tx_open.end(), tx_end);
    let body_pr = js_regex!(r"<a:bodyPr\b(?:[^>]*?)(?:\/>|>[\s\S]*?<\/a:bodyPr>)")
        .exec(inner)
        .map_or("<a:bodyPr/>", |m| m.as_str());
    let lst_style = js_regex!(r"<a:lstStyle\b(?:[^>]*?)(?:\/>|>[\s\S]*?<\/a:lstStyle>)")
        .exec(inner)
        .map_or("", |m| m.as_str());
    let mut paras = String::new();
    if paragraphs.is_empty() {
        let mut run = TextRun::default();
        run.text.set(String::new());
        let mut empty = Paragraph::default();
        empty.runs.set(vec![run]);
        paras.push_str(&generate_paragraph_xml(&empty));
    } else {
        for p in paragraphs {
            paras.push_str(&generate_paragraph_xml(p));
        }
    }

    let new_tc = format!(
        "{}{}{}{}{}",
        sl(tc_xml, 0, tx_open.end()),
        body_pr,
        lst_style,
        paras,
        tail(tc_xml, tx_end)
    );
    let new_tr = format!(
        "{}{}{}",
        head(tr_xml, tc_start),
        new_tc,
        tail(tr_xml, tc_end)
    );
    let new_xml = format!("{}{}{}", head(&xml, tr_start), new_tr, tail(&xml, tr_end));
    set_original_xml(table, new_xml);

    // Model sync: keep anchor/insets (for render layout), replace paragraphs
    if let Some(cell) = cell_at_mut(table, row, col) {
        let mut text = match cell.text.as_ref() {
            Some(old) => old.clone(),
            None => {
                let mut fresh = TextBody::default();
                let mut insets = TextInsets::default();
                insets.l.set(JsNum(91440.0));
                insets.r.set(JsNum(91440.0));
                insets.t.set(JsNum(45720.0));
                insets.b.set(JsNum(45720.0));
                fresh.insets.set(insets);
                fresh
            }
        };
        text.paragraphs.set(paragraphs.to_vec());
        cell.text.set(text);
    }
    slide.structure_dirty.set(true);
    true
}

/// Table style editing (surgical patch of a:tblPr + a:tcPr): apply a preset
/// style or change firstRow/bandRow/shading/borders without touching cell text.
pub fn edit_table_style(slide: &mut Slide, element_id: &str, edit: &TableStyleEdit) -> bool {
    let Some(el) = find_table(slide, element_id) else {
        return false;
    };
    let Some(table) = table_mut(el) else {
        return false;
    };
    let Some(xml) = original_xml(table) else {
        return false;
    };
    set_original_xml(table, patch_table_style_xml(&xml, edit));
    slide.structure_dirty.set(true);
    true
}

/// Ensure ppt/tableStyles.xml contains the given custom style (injected the first
/// time a preset is applied). Creates the part when missing, adding the
/// [Content_Types].xml Override and presentation rels.
pub fn ensure_table_style_part(opened: &mut OpenedPptx, style_id: &str, style_def_xml: &str) {
    let archive = &mut opened.archive;
    let path = "ppt/tableStyles.xml";
    let existing: Option<String> = archive.read_text(path).map(|text| text.into_owned());
    let next = ensure_table_style_xml(existing.as_deref(), style_id, style_def_xml);
    if existing.as_deref() == Some(next.as_str()) {
        return;
    }
    archive.entries_mut().set(path, next.into_bytes());
    if existing.as_deref().is_some_and(|text| !text.is_empty()) {
        return;
    }
    let ct_path = "[Content_Types].xml";
    let ct: Option<String> = archive.read_text(ct_path).map(|text| text.into_owned());
    if let Some(ct) = ct.filter(|ct| !ct.is_empty())
        && !has_content_type_override(&ct, path)
    {
        let patched = replace_literal(
            &ct,
            "</Types>",
            &format!(
                "<Override PartName=\"/{path}\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml\"/></Types>"
            ),
        );
        archive.entries_mut().set(ct_path, patched.into_bytes());
    }
    let pres_rels_path = "ppt/_rels/presentation.xml.rels";
    let pres_rels: Option<String> = archive
        .read_text(pres_rels_path)
        .map(|text| text.into_owned());
    if let Some(pres_rels) = pres_rels.filter(|rels| !rels.is_empty())
        && !pres_rels.contains("/relationships/tableStyles\"")
    {
        let max_rid = max_relationship_id_number(&pres_rels);
        let rel = format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles\" Target=\"tableStyles.xml\"/>",
            number_to_string(max_rid + 1.0)
        );
        let patched = replace_literal(
            &pres_rels,
            "</Relationships>",
            &format!("{rel}</Relationships>"),
        );
        archive
            .entries_mut()
            .set(pres_rels_path, patched.into_bytes());
    }
}

// ── Table row/column structure editing ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TableStructureOp {
    InsertRow {
        index: f64,
        #[serde(default)]
        before: Option<bool>,
    },
    DeleteRow {
        index: f64,
    },
    InsertCol {
        index: f64,
        #[serde(default)]
        before: Option<bool>,
    },
    DeleteCol {
        index: f64,
    },
}

impl TableStructureOp {
    fn index(&self) -> f64 {
        match self {
            Self::InsertRow { index, .. }
            | Self::DeleteRow { index }
            | Self::InsertCol { index, .. }
            | Self::DeleteCol { index } => *index,
        }
    }

    /// `op.before` is truthy.
    fn before(&self) -> bool {
        match self {
            Self::InsertRow { before, .. } | Self::InsertCol { before, .. } => {
                *before == Some(true)
            }
            _ => false,
        }
    }

    fn is_row(&self) -> bool {
        matches!(self, Self::InsertRow { .. } | Self::DeleteRow { .. })
    }

    fn is_insert(&self) -> bool {
        matches!(self, Self::InsertRow { .. } | Self::InsertCol { .. })
    }
}

/// Row/column surgery is unsafe when the table has merged cells (gridSpan/rowSpan/hMerge/vMerge); refuse.
fn table_has_merges(xml: &str) -> bool {
    js_regex!(r#"\b(?:gridSpan|rowSpan|hMerge|vMerge)=""#).test(xml)
}

/// Clear the text of every tc in a table XML fragment (keeping tcPr formatting), used when cloning a reference row/column.
fn clear_tc_text(xml: &str) -> String {
    js_regex!(r"<a:txBody(\s[^>]*)?>[\s\S]*?<\/a:txBody>").replace_all(xml, |_| {
        "<a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody>".to_owned()
    })
}

/// The frame dimension `<p:xfrm><a:ext>` carries.
#[derive(Clone, Copy)]
enum Dim {
    Cx,
    Cy,
}

impl Dim {
    fn name(self) -> &'static str {
        match self {
            Self::Cx => "cx",
            Self::Cy => "cy",
        }
    }

    /// `\b${attr}="(-?\d+)"`
    fn attr_re(self) -> &'static JsRegex {
        match self {
            Self::Cx => js_regex!(r#"\bcx="(-?\d+)""#),
            Self::Cy => js_regex!(r#"\bcy="(-?\d+)""#),
        }
    }

    /// `(<p:xfrm[^>]*>[\s\S]*?<a:ext\s[^>]*\b${attr}=")-?\d+(")`
    fn ext_re(self) -> &'static JsRegex {
        match self {
            Self::Cx => js_regex!(r#"(<p:xfrm[^>]*>[\s\S]*?<a:ext\s[^>]*\bcx=")-?\d+(")"#),
            Self::Cy => js_regex!(r#"(<p:xfrm[^>]*>[\s\S]*?<a:ext\s[^>]*\bcy=")-?\d+(")"#),
        }
    }
}

/// Adjust one dimension of the graphicFrame <p:xfrm><a:ext> (cx/cy delta, EMU).
fn bump_frame_ext(xml: &str, attr: Dim, delta: f64) -> String {
    let Some(m) = js_regex!(r"<p:xfrm[^>]*>[\s\S]*?<a:ext\s[^>]*\/>").exec(xml) else {
        return xml.to_owned();
    };
    let patched = replace_first_with(attr.attr_re(), m.as_str(), |a| {
        let v = to_number(a.get(1).unwrap_or(""));
        format!(
            "{}=\"{}\"",
            attr.name(),
            number_to_string(math_max(1.0, v + delta))
        )
    });
    format!("{}{}{}", head(xml, m.start()), patched, tail(xml, m.end()))
}

/// The pure part of editTableStructure: the table XML after the op, `None` for a refusal.
fn structure_xml(mut xml: String, op: &TableStructureOp) -> Result<Option<String>, String> {
    if table_has_merges(&xml) {
        return Ok(None);
    }

    let mut tr_spans: Vec<(usize, usize)> = Vec::new();
    while let Some(span) = nth_tag_span(&xml, "a:tr", tr_spans.len() as f64) {
        tr_spans.push(span);
    }
    let n_rows = tr_spans.len();
    let grid_cols = grid_col_spans(&xml);
    let n_cols = grid_cols.len();
    if n_rows == 0 || n_cols == 0 {
        return Ok(None);
    }

    if op.is_row() {
        let Some(at) = index_in(op.index(), n_rows) else {
            return Ok(None);
        };
        let Some(&(ref_start, ref_end)) = tr_spans.get(at) else {
            return Ok(None);
        };
        let ref_xml = sl(&xml, ref_start, ref_end).to_owned();
        let row_h = to_number(
            js_regex!(r#"<a:tr\s[^>]*\bh="(\d+)""#)
                .exec(&ref_xml)
                .and_then(|m| m.get(1))
                .unwrap_or("0"),
        );
        if op.is_insert() {
            let clone = clear_tc_text(&ref_xml);
            let insert_at = if op.before() { ref_start } else { ref_end };
            xml = format!(
                "{}{}{}",
                head(&xml, insert_at),
                clone,
                tail(&xml, insert_at)
            );
            xml = bump_frame_ext(&xml, Dim::Cy, row_h);
        } else {
            if n_rows <= 1 {
                return Ok(None);
            }
            xml = format!("{}{}", head(&xml, ref_start), tail(&xml, ref_end));
            xml = bump_frame_ext(&xml, Dim::Cy, -row_h);
        }
    } else {
        let Some(at) = index_in(op.index(), n_cols) else {
            return Ok(None);
        };
        let Some(ref_col) = grid_cols.get(at) else {
            return Ok(None);
        };
        let col_w = to_number(
            js_regex!(r#"\bw="(\d+)""#)
                .exec(&ref_col.open)
                .and_then(|m| m.get(1))
                .unwrap_or("0"),
        );
        if !op.is_insert() && n_cols <= 1 {
            return Ok(None);
        }

        // Process tc row by row (replace back-to-front so offsets stay valid)
        for r in (0..n_rows).rev() {
            let Some((tr_start, tr_end)) = nth_tag_span(&xml, "a:tr", r as f64) else {
                return Ok(None);
            };
            let tr_xml = sl(&xml, tr_start, tr_end);
            let Some((tc_start, tc_end)) = nth_tag_span(tr_xml, "a:tc", at as f64) else {
                return Ok(None);
            };
            let new_tr = if op.is_insert() {
                let clone = clear_tc_text(sl(tr_xml, tc_start, tc_end));
                let insert_at = if op.before() { tc_start } else { tc_end };
                format!(
                    "{}{}{}",
                    head(tr_xml, insert_at),
                    clone,
                    tail(tr_xml, insert_at)
                )
            } else {
                format!("{}{}", head(tr_xml, tc_start), tail(tr_xml, tc_end))
            };
            xml = format!("{}{}{}", head(&xml, tr_start), new_tr, tail(&xml, tr_end));
        }
        // gridCol and frame width
        let spans = grid_col_spans(&xml);
        let Some(gc) = spans.get(at) else {
            return Err("Cannot read properties of undefined (reading 'start')".to_owned());
        };
        if op.is_insert() {
            // Fresh self-closing clone: copying the full span would duplicate the
            // reference column's a16:colId, which must stay unique per column
            let insert_at = if op.before() { gc.start } else { gc.end };
            xml = format!(
                "{}<a:gridCol w=\"{}\"/>{}",
                head(&xml, insert_at),
                number_to_string(col_w),
                tail(&xml, insert_at)
            );
            xml = bump_frame_ext(&xml, Dim::Cx, col_w);
        } else {
            xml = format!("{}{}", head(&xml, gc.start), tail(&xml, gc.end));
            xml = bump_frame_ext(&xml, Dim::Cx, -col_w);
        }
    }
    Ok(Some(xml))
}

/// The end of editTableStructure and mergeTableCells: bake `xml` into the
/// element, reparse the slide, and answer the id the element has now.
fn finish_structure(
    opened: &mut OpenedPptx,
    slide_index: usize,
    el_index: usize,
    xml: String,
) -> Result<Option<String>, String> {
    {
        let Some(slide) = opened.deck.slides.get_mut(slide_index) else {
            return Ok(None);
        };
        let Some(el) = slide
            .elements
            .as_mut()
            .and_then(|elements| elements.get_mut(el_index))
        else {
            return Ok(None);
        };
        if let Some(table) = table_mut(el) {
            clear_dirty(table);
            set_original_xml(table, xml);
        }
        slide.structure_dirty.set(true);
    }
    if !materialize_slide(opened, slide_index)? {
        return Ok(None);
    }
    Ok(opened
        .deck
        .slides
        .get(slide_index)
        .and_then(|slide| slide.elements.as_ref())
        .and_then(|elements| elements.get(el_index))
        .map(|el| el.id().to_owned()))
}

/// The slide index and the element index of a table by id, and its baked XML.
fn table_xml_of(
    opened: &mut OpenedPptx,
    slide_index: usize,
    element_id: &str,
) -> Option<(usize, String)> {
    let slide = opened.deck.slides.get_mut(slide_index)?;
    let elements = slide.elements.as_mut()?;
    let el_index = elements.iter().position(|e| e.id() == element_id)?;
    let el = elements.get_mut(el_index)?;
    if !matches!(&*el, SlideElement::Table(_)) {
        return None;
    }
    // Bake the element's unsaved patches into the slice first; the surgery works on the latest bytes
    Some((el_index, patched_element_xml(el)))
}

/// Table row/column insert/delete (XML surgery + materialize/reparse):
/// - Inserted rows/columns clone the reference row/column's formatting with text
///   cleared; the table frame grows/shrinks with the total row height/column width.
/// - Deleting is refused when only 1 row/column remains; tables with merged cells
///   are always refused.
///
/// Answers the id the table has after the reparse (the slide is
/// `opened.deck.slides[slide_index]`); `None` is the TypeScript `null`.
pub fn edit_table_structure(
    opened: &mut OpenedPptx,
    slide_index: usize,
    element_id: &str,
    op: &TableStructureOp,
) -> Result<Option<String>, String> {
    let Some((el_index, xml)) = table_xml_of(opened, slide_index, element_id) else {
        return Ok(None);
    };
    let Some(xml) = structure_xml(xml, op)? else {
        return Ok(None);
    };
    finish_structure(opened, slide_index, el_index, xml)
}

// ── Table merge/split cells ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TableMergeOp {
    MergeRight { row: f64, col: f64 },
    MergeDown { row: f64, col: f64 },
    Split { row: f64, col: f64 },
}

impl TableMergeOp {
    fn row(&self) -> f64 {
        match self {
            Self::MergeRight { row, .. }
            | Self::MergeDown { row, .. }
            | Self::Split { row, .. } => *row,
        }
    }

    fn col(&self) -> f64 {
        match self {
            Self::MergeRight { col, .. }
            | Self::MergeDown { col, .. }
            | Self::Split { col, .. } => *col,
        }
    }
}

/// The attributes of an `<a:tc>` the merge code reads and writes.
#[derive(Clone, Copy)]
enum TcAttr {
    GridSpan,
    RowSpan,
    HMerge,
    VMerge,
}

impl TcAttr {
    fn name(self) -> &'static str {
        match self {
            Self::GridSpan => "gridSpan",
            Self::RowSpan => "rowSpan",
            Self::HMerge => "hMerge",
            Self::VMerge => "vMerge",
        }
    }

    /// `\b${name}="(\d+)"`
    fn value_re(self) -> &'static JsRegex {
        match self {
            Self::GridSpan => js_regex!(r#"\bgridSpan="(\d+)""#),
            Self::RowSpan => js_regex!(r#"\browSpan="(\d+)""#),
            Self::HMerge => js_regex!(r#"\bhMerge="(\d+)""#),
            Self::VMerge => js_regex!(r#"\bvMerge="(\d+)""#),
        }
    }

    /// `\s${name}="[^"]*"`
    fn strip_re(self) -> &'static JsRegex {
        match self {
            Self::GridSpan => js_regex!(r#"\sgridSpan="[^"]*""#),
            Self::RowSpan => js_regex!(r#"\srowSpan="[^"]*""#),
            Self::HMerge => js_regex!(r#"\shMerge="[^"]*""#),
            Self::VMerge => js_regex!(r#"\svMerge="[^"]*""#),
        }
    }
}

fn tc_attr(tc_open: &str, name: TcAttr) -> f64 {
    name.value_re()
        .exec(tc_open)
        .map_or(0.0, |m| to_number(m.get(1).unwrap_or("")))
}

/// Change an <a:tc> open-tag attribute: val=None removes it, otherwise sets it. Returns the whole tc XML.
fn set_tc_attr_xml(tc_xml: &str, name: TcAttr, val: Option<f64>) -> String {
    replace_first_with(js_regex!(r"<a:tc(\s[^>]*)?>"), tc_xml, |m| {
        let open = m.as_str();
        let cleaned = replace_first(name.strip_re(), 0, open, "");
        match val {
            None => cleaned,
            Some(val) => replace_first(
                js_regex!(r"^<a:tc"),
                0,
                &cleaned,
                &format!("<a:tc {}=\"{}\"", name.name(), number_to_string(val)),
            ),
        }
    })
}

/// Extract non-empty paragraphs from a tc (merging folds the absorbed cell's content into the anchor cell).
fn tc_paragraphs_xml(tc_xml: &str) -> String {
    let body = js_regex!(r"<a:txBody(?:\s[^>]*)?>([\s\S]*?)<\/a:txBody>")
        .exec(tc_xml)
        .and_then(|m| m.get(1))
        .unwrap_or("");
    let mut out = String::new();
    for p in js_regex!(r"<a:p>[\s\S]*?<\/a:p>|<a:p\/>").find_iter(body) {
        if js_regex!(r"<a:t>(?=[^<]*\S)[^<]*<\/a:t>").test(p.as_str()) {
            out.push_str(p.as_str());
        }
    }
    out
}

/// `/<a:tc(\s[^>]*)?>/.exec(tcXml)![0]`
fn tc_open(tc_xml: &str) -> Result<&str, String> {
    js_regex!(r"<a:tc(\s[^>]*)?>")
        .exec(tc_xml)
        .map(|m| m.as_str())
        .ok_or_else(|| "Cannot read properties of null (reading '0')".to_owned())
}

fn is_plain_tc(tc_xml: &str) -> Result<bool, String> {
    Ok(!table_has_merges(tc_open(tc_xml)?))
}

/// Clear text + set the merge continuation flag.
fn to_covered(tc_xml: &str, mark: TcAttr) -> String {
    set_tc_attr_xml(&clear_tc_text(tc_xml), mark, Some(1.0))
}

fn append_to_anchor(anchor_xml: &str, paras_xml: &str) -> String {
    if paras_xml.is_empty() {
        return anchor_xml.to_owned();
    }
    // ledger tablemerge-dollar: the TypeScript passes the paragraphs as a
    // replacement string, so a `$&`, `$'` or `` $` `` in the cell text expands
    // into markup; spliced here as written.
    replace_first_with(js_regex!(r"<\/a:txBody>"), anchor_xml, |_| {
        format!("{paras_xml}</a:txBody>")
    })
}

/// The pure part of mergeTableCells: the table XML after the op, `None` for a refusal.
fn merge_xml(mut xml: String, op: &TableMergeOp) -> Result<Option<String>, String> {
    let (row, col) = (op.row(), op.col());
    let Some((tr_start, tr_end)) = nth_tag_span(&xml, "a:tr", row) else {
        return Ok(None);
    };
    let mut tr_xml = sl(&xml, tr_start, tr_end).to_owned();
    let Some((anchor_start, anchor_end)) = nth_tag_span(&tr_xml, "a:tc", col) else {
        return Ok(None);
    };
    let mut anchor_xml = sl(&tr_xml, anchor_start, anchor_end).to_owned();
    let anchor_open = tc_open(&anchor_xml)?.to_owned();
    if js_regex!(r#"\b[hv]Merge=""#).test(&anchor_open) {
        return Ok(None);
    }
    let mut g = tc_attr(&anchor_open, TcAttr::GridSpan);
    if !number_truthy(g) {
        g = 1.0;
    }
    let mut v = tc_attr(&anchor_open, TcAttr::RowSpan);
    if !number_truthy(v) {
        v = 1.0;
    }

    match op {
        TableMergeOp::MergeRight { .. } => {
            if v != 1.0 {
                return Ok(None);
            }
            let Some((target_start, target_end)) = nth_tag_span(&tr_xml, "a:tc", col + g) else {
                return Ok(None);
            };
            let target_xml = sl(&tr_xml, target_start, target_end).to_owned();
            if !is_plain_tc(&target_xml)? {
                return Ok(None);
            }
            anchor_xml = append_to_anchor(&anchor_xml, &tc_paragraphs_xml(&target_xml));
            anchor_xml = set_tc_attr_xml(&anchor_xml, TcAttr::GridSpan, Some(g + 1.0));
            tr_xml = format!(
                "{}{}{}{}{}",
                head(&tr_xml, anchor_start),
                anchor_xml,
                sl(&tr_xml, anchor_end, target_start),
                to_covered(&target_xml, TcAttr::HMerge),
                tail(&tr_xml, target_end)
            );
            xml = format!("{}{}{}", head(&xml, tr_start), tr_xml, tail(&xml, tr_end));
        }
        TableMergeOp::MergeDown { .. } => {
            if g != 1.0 {
                return Ok(None);
            }
            let Some((tr2_start, tr2_end)) = nth_tag_span(&xml, "a:tr", row + v) else {
                return Ok(None);
            };
            let mut tr2_xml = sl(&xml, tr2_start, tr2_end).to_owned();
            let Some((target_start, target_end)) = nth_tag_span(&tr2_xml, "a:tc", col) else {
                return Ok(None);
            };
            let target_xml = sl(&tr2_xml, target_start, target_end).to_owned();
            if !is_plain_tc(&target_xml)? {
                return Ok(None);
            }
            anchor_xml = append_to_anchor(&anchor_xml, &tc_paragraphs_xml(&target_xml));
            anchor_xml = set_tc_attr_xml(&anchor_xml, TcAttr::RowSpan, Some(v + 1.0));
            tr_xml = format!(
                "{}{}{}",
                head(&tr_xml, anchor_start),
                anchor_xml,
                tail(&tr_xml, anchor_end)
            );
            tr2_xml = format!(
                "{}{}{}",
                head(&tr2_xml, target_start),
                to_covered(&target_xml, TcAttr::VMerge),
                tail(&tr2_xml, target_end)
            );
            // The later row goes first so the earlier offsets stay valid
            xml = format!(
                "{}{}{}",
                head(&xml, tr2_start),
                tr2_xml,
                tail(&xml, tr2_end)
            );
            xml = format!("{}{}{}", head(&xml, tr_start), tr_xml, tail(&xml, tr_end));
        }
        TableMergeOp::Split { .. } => {
            if g <= 1.0 && v <= 1.0 {
                return Ok(None);
            }
            // Process rows back-to-front so offsets stay valid
            let mut r = row + v - 1.0;
            while r >= row {
                let Some((row_start, row_end)) = nth_tag_span(&xml, "a:tr", r) else {
                    return Ok(None);
                };
                let mut row_xml = sl(&xml, row_start, row_end).to_owned();
                let mut c = col + g - 1.0;
                while c >= col {
                    let Some((start, end)) = nth_tag_span(&row_xml, "a:tc", c) else {
                        return Ok(None);
                    };
                    let mut tc_xml = sl(&row_xml, start, end).to_owned();
                    if r == row && c == col {
                        tc_xml = set_tc_attr_xml(
                            &set_tc_attr_xml(&tc_xml, TcAttr::GridSpan, None),
                            TcAttr::RowSpan,
                            None,
                        );
                    } else {
                        tc_xml = set_tc_attr_xml(
                            &set_tc_attr_xml(&tc_xml, TcAttr::HMerge, None),
                            TcAttr::VMerge,
                            None,
                        );
                    }
                    row_xml = format!("{}{}{}", head(&row_xml, start), tc_xml, tail(&row_xml, end));
                    c -= 1.0;
                }
                xml = format!(
                    "{}{}{}",
                    head(&xml, row_start),
                    row_xml,
                    tail(&xml, row_end)
                );
                r -= 1.0;
            }
        }
    }
    Ok(Some(xml))
}

/// Merge/split cells (XML surgery + materialize/reparse). v1 constraints:
/// merge-right requires anchor rowSpan=1 and a plain right neighbor; merge-down
/// requires anchor gridSpan=1 and a plain neighbor below (an already-merged anchor
/// can keep extending). The absorbed cell's text folds into the anchor.
///
/// Answers the id the table has after the reparse (the slide is
/// `opened.deck.slides[slide_index]`); `None` is the TypeScript `null`.
pub fn merge_table_cells(
    opened: &mut OpenedPptx,
    slide_index: usize,
    element_id: &str,
    op: &TableMergeOp,
) -> Result<Option<String>, String> {
    let Some((el_index, xml)) = table_xml_of(opened, slide_index, element_id) else {
        return Ok(None);
    };
    let Some(xml) = merge_xml(xml, op)? else {
        return Ok(None);
    };
    finish_structure(opened, slide_index, el_index, xml)
}

// ── Column/row sizes ────────────────────────────────────────────────────

/// Set a column's width (EMU): gridCol w + frame ext.cx synced, model updated in
/// place (no reparse, element ids stable — good for drag resizing).
pub fn set_table_col_width(slide: &mut Slide, element_id: &str, col: f64, w_emu: f64) -> bool {
    let Some(el) = find_table(slide, element_id) else {
        return false;
    };
    let n_cols = match table_mut(el) {
        Some(table) => table.col_widths.as_ref().map_or(0, Vec::len),
        None => return false,
    };
    if col < 0.0 || col >= n_cols as f64 {
        return false;
    }
    // a non-finite EMU (NaN, 1e308 overflow) would serialize verbatim into w=
    if !w_emu.is_finite() {
        return false;
    }

    let mut xml = patched_element_xml(el);
    let spans = grid_col_spans(&xml);
    let Some(gc) = index_in(col, spans.len()).and_then(|at| spans.get(at)) else {
        return false;
    };
    let Some(table) = table_mut(el) else {
        return false;
    };
    let Some(ci) = index_in(col, n_cols) else {
        return false;
    };
    clear_dirty(table);
    let w = math_max(1.0, math_round(w_emu));
    let patched = replace_first(
        js_regex!(r#"\bw="-?\d+""#),
        0,
        &gc.open,
        &format!("w=\"{}\"", number_to_string(w)),
    );
    xml = format!(
        "{}{}{}",
        head(&xml, gc.start),
        patched,
        tail(&xml, gc.start + gc.open.len())
    );

    let rtl = *table.rtl == Some(true);
    let Some(widths) = table.col_widths.as_mut() else {
        return false;
    };
    let Some(slot) = widths.get_mut(ci) else {
        return false;
    };
    let dx_rtl = if rtl { w - slot.0 } else { 0.0 };
    *slot = JsNum(w);
    let sum = sum_of(widths);
    xml = replace_first_with(Dim::Cx.ext_re(), &xml, |m| {
        format!(
            "{}{}{}",
            m.get(1).unwrap_or(""),
            number_to_string(sum),
            m.get(2).unwrap_or("")
        )
    });
    // rtl mirroring anchors the table's visual-right edge: growing a column extends the
    // frame leftward, so the origin shifts by the width delta (LTR keeps the origin and
    // extends rightward)
    if number_truthy(dx_rtl) {
        let old_x = table.transform.as_ref().map_or(f64::NAN, |t| t.offset.x.0);
        let new_x = old_x - dx_rtl;
        xml = replace_first_with(
            js_regex!(r#"(<p:xfrm[^>]*>[\s\S]*?<a:off\s[^>]*\bx=")-?\d+(")"#),
            &xml,
            |m| {
                format!(
                    "{}{}{}",
                    m.get(1).unwrap_or(""),
                    number_to_string(new_x),
                    m.get(2).unwrap_or("")
                )
            },
        );
        if let Some(t) = table.transform.as_mut() {
            t.offset.x = JsNum(new_x);
        }
    }
    set_original_xml(table, xml);
    if let Some(t) = table.transform.as_mut() {
        t.offset.cx = JsNum(sum);
    }
    slide.structure_dirty.set(true);
    true
}

/// Set a row's height (EMU): <a:tr h> + frame ext.cy synced (matching setTableColWidth semantics).
pub fn set_table_row_height(slide: &mut Slide, element_id: &str, row: f64, h_emu: f64) -> bool {
    let Some(el) = find_table(slide, element_id) else {
        return false;
    };
    let n_rows = match table_mut(el) {
        Some(table) => table.row_heights.as_ref().map_or(0, Vec::len),
        None => return false,
    };
    if row < 0.0 || row >= n_rows as f64 {
        return false;
    }
    if !h_emu.is_finite() {
        return false;
    }

    let mut xml = patched_element_xml(el);
    let Some((tr_start, tr_end)) = nth_tag_span(&xml, "a:tr", row) else {
        return false;
    };
    let Some(table) = table_mut(el) else {
        return false;
    };
    clear_dirty(table);
    let h = math_max(1.0, math_round(h_emu));
    let h_text = number_to_string(h);
    let Some(tr_open) = js_regex!(r"<a:tr(\s[^>]*)?>")
        .exec(sl(&xml, tr_start, tr_end))
        .map(|m| m.as_str().to_owned())
    else {
        return false;
    };
    let patched_open = if js_regex!(r#"\bh="-?\d+""#).test(&tr_open) {
        replace_first(
            js_regex!(r#"\bh="-?\d+""#),
            0,
            &tr_open,
            &format!("h=\"{h_text}\""),
        )
    } else {
        replace_first(
            js_regex!(r"^<a:tr"),
            0,
            &tr_open,
            &format!("<a:tr h=\"{h_text}\""),
        )
    };
    xml = format!(
        "{}{}{}",
        head(&xml, tr_start),
        patched_open,
        tail(&xml, tr_start + tr_open.len())
    );

    let Some(ri) = index_in(row, n_rows) else {
        return false;
    };
    let Some(heights) = table.row_heights.as_mut() else {
        return false;
    };
    if let Some(slot) = heights.get_mut(ri) {
        *slot = JsNum(h);
    }
    let sum = sum_of(heights);
    xml = replace_first_with(Dim::Cy.ext_re(), &xml, |m| {
        format!(
            "{}{}{}",
            m.get(1).unwrap_or(""),
            number_to_string(sum),
            m.get(2).unwrap_or("")
        )
    });
    set_original_xml(table, xml);
    if let Some(t) = table.transform.as_mut() {
        t.offset.cy = JsNum(sum);
    }
    slide.structure_dirty.set(true);
    true
}

/// Scale values so they sum exactly to target (>=1 each; the last entry absorbs rounding drift).
fn scale_to_sum(values: &[JsNum], target: f64) -> Vec<JsNum> {
    let sum = sum_of(values);
    if sum <= 0.0 {
        return values.to_vec();
    }
    let mut out: Vec<JsNum> = values
        .iter()
        .map(|v| JsNum(math_max(1.0, math_round((v.0 * target) / sum))))
        .collect();
    let drift = target - sum_of(&out);
    if let Some(last) = out.last_mut() {
        *last = JsNum(math_max(1.0, last.0 + drift));
    }
    out
}

/// Resize a table by proportionally redistributing <a:gridCol w> and <a:tr h>
/// (PowerPoint's behavior). The frame ext is synced to the redistributed sums.
pub fn resize_table(slide: &mut Slide, element_id: &str, cx: f64, cy: f64) -> bool {
    let Some(el) = find_table(slide, element_id) else {
        return false;
    };
    let (col_widths, row_heights) = match table_mut(el) {
        Some(table) => (
            table.col_widths.as_ref().cloned().unwrap_or_default(),
            table.row_heights.as_ref().cloned().unwrap_or_default(),
        ),
        None => return false,
    };
    if col_widths.is_empty() || row_heights.is_empty() {
        return false;
    }
    let target_cx = math_max(col_widths.len() as f64, math_round(cx));
    let target_cy = math_max(row_heights.len() as f64, math_round(cy));

    let mut xml = patched_element_xml(el);
    let Some(table) = table_mut(el) else {
        return false;
    };
    clear_dirty(table);

    let widths = scale_to_sum(&col_widths, target_cx);
    let mut ci = 0usize;
    // Opening tags only — paired-form gridCols (extLst children) must scale too
    // `ci` moves on only where the tag has a `w` the replacement consumes:
    // a gridCol without one keeps the width for the next
    xml = js_regex!(r"<a:gridCol\b[^>]*>").replace_all(&xml, |m| match widths.get(ci) {
        Some(w) if js_regex!(r#"\bw="-?\d+""#).test(m.as_str()) => {
            ci += 1;
            replace_first(
                js_regex!(r#"\bw="-?\d+""#),
                0,
                m.as_str(),
                &format!("w=\"{}\"", number_to_string(w.0)),
            )
        }
        _ => m.as_str().to_owned(),
    });

    let heights = scale_to_sum(&row_heights, target_cy);
    let mut ri = 0usize;
    xml = js_regex!(r"<a:tr(\s[^>]*)?>").replace_all(&xml, |m| {
        let Some(h) = heights.get(ri) else {
            return m.as_str().to_owned();
        };
        ri += 1;
        let h_text = number_to_string(h.0);
        if js_regex!(r#"\bh="-?\d+""#).test(m.as_str()) {
            replace_first(
                js_regex!(r#"\bh="-?\d+""#),
                0,
                m.as_str(),
                &format!("h=\"{h_text}\""),
            )
        } else {
            replace_first(
                js_regex!(r"^<a:tr"),
                0,
                m.as_str(),
                &format!("<a:tr h=\"{h_text}\""),
            )
        }
    });

    let sum_w = sum_of(&widths);
    let sum_h = sum_of(&heights);
    for (dim, sum) in [(Dim::Cx, sum_w), (Dim::Cy, sum_h)] {
        xml = replace_first_with(dim.ext_re(), &xml, |m| {
            format!(
                "{}{}{}",
                m.get(1).unwrap_or(""),
                number_to_string(sum),
                m.get(2).unwrap_or("")
            )
        });
    }

    table.col_widths.set(widths);
    table.row_heights.set(heights);
    set_original_xml(table, xml);
    if let Some(t) = table.transform.as_mut() {
        t.offset.cx = JsNum(sum_w);
        t.offset.cy = JsNum(sum_h);
    }
    slide.structure_dirty.set(true);
    true
}

/// Cell text vertical alignment (tcPr anchor: t/ctr/b). Byte surgery + model sync.
pub fn set_table_cell_anchor(
    slide: &mut Slide,
    element_id: &str,
    row: f64,
    col: f64,
    anchor: TextAnchor,
) -> bool {
    let Some(el) = find_table(slide, element_id) else {
        return false;
    };
    match table_mut(el).and_then(|table| cell_at(table, row, col)) {
        Some(cell) if *cell.merged != Some(true) => {}
        _ => return false,
    }

    let xml = patched_element_xml(el);
    let Some((tr_start, tr_end)) = nth_tag_span(&xml, "a:tr", row) else {
        return false;
    };
    let tr_xml = sl(&xml, tr_start, tr_end);
    let Some((tc_start, tc_end)) = nth_tag_span(tr_xml, "a:tc", col) else {
        return false;
    };
    let mut tc_xml = sl(tr_xml, tc_start, tc_end).to_owned();
    let val = match anchor {
        TextAnchor::Middle => "ctr",
        TextAnchor::Bottom => "b",
        TextAnchor::Top => "t",
    };
    if let Some(tc_pr) = js_regex!(r"<a:tcPr(\s[^>]*)?\/?>").exec(&tc_xml) {
        let tag = replace_first(js_regex!(r#"\s+anchor="[^"]*""#), 0, tc_pr.as_str(), "");
        let tag = replace_first(
            js_regex!(r"^<a:tcPr"),
            0,
            &tag,
            &format!("<a:tcPr anchor=\"{val}\""),
        );
        tc_xml = format!(
            "{}{}{}",
            head(&tc_xml, tc_pr.start()),
            tag,
            tail(&tc_xml, tc_pr.end())
        );
    } else {
        tc_xml = replace_first(
            js_regex!(r"<\/a:tc>$"),
            0,
            &tc_xml,
            &format!("<a:tcPr anchor=\"{val}\"/></a:tc>"),
        );
    }
    let new_tr = format!(
        "{}{}{}",
        head(tr_xml, tc_start),
        tc_xml,
        tail(tr_xml, tc_end)
    );
    let xml = format!("{}{}{}", head(&xml, tr_start), new_tr, tail(&xml, tr_end));

    let Some(table) = table_mut(el) else {
        return false;
    };
    clear_dirty(table);
    set_original_xml(table, xml);
    if let Some(cell) = cell_at_mut(table, row, col)
        && let Some(text) = cell.text.as_mut()
    {
        text.anchor.set(anchor);
    }
    slide.structure_dirty.set(true);
    true
}
