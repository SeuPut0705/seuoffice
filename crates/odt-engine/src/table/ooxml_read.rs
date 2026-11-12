//! `table/ooxml-read.ts`: reading `w:tbl` fragments on save. The bridge table
//! (from the bridge map) and the edited one (from the edited docx) are split
//! into rows, cells and cell items by source position, so cells can be
//! compared byte for byte; the docx engine's `TableModel` of the edited table
//! supplies the parsed content (rich paragraphs, merges, widths) in the same
//! `w:tr`/`w:tc` order.

use std::borrow::Cow;
use std::collections::HashSet;

use docx_engine::model::{TableCell, TableCellVMerge, TableModel, TableParagraph};
use jscompat::{JsNum, js_regex, math_round};
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};

use crate::core::xml::{
    CloseVerdict, ElementFrame, ElementVisitor, OpenVerdict, PrefixMap, walk_elements,
};

/// `OxItem['kind']`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum OxItemKind {
    /// `w:p`
    #[serde(rename = "p")]
    P,
    /// `w:tbl`
    #[serde(rename = "tbl")]
    Tbl,
}

/// `OxItem`
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OxItem {
    pub kind: OxItemKind,
    /// exact source of the `w:p` / `w:tbl`
    pub xml: String,
}

/// `OxCell`
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OxCell {
    /// exact source of the `w:tc`
    pub xml: String,
    /// exact `w:tcPr` ('' when none)
    #[serde(rename = "tcPr")]
    pub tc_pr: String,
    /// `w:p` and `w:tbl` children in order
    pub items: Vec<OxItem>,
}

/// One row of `OxTable.rows`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OxRow {
    pub xml: String,
    pub cells: Vec<OxCell>,
}

/// `OxTable`
#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct OxTable {
    pub xml: String,
    pub rows: Vec<OxRow>,
}

/// `Seg`
struct Seg {
    name: String,
    start: usize,
    end: usize,
    children: Vec<usize>,
}

/// The visitor of `segmentTable`: segments live in an arena and the frame's
/// `data` slot holds the index of its segment.
struct Segmenter {
    segs: Vec<Seg>,
    roots: Vec<usize>,
}

const CONTAINER: [&str; 5] = ["w:tbl", "w:tr", "w:tc", "w:sdt", "w:sdtContent"];

impl ElementVisitor for Segmenter {
    type Data = usize;

    fn open(
        &mut self,
        el: &mut ElementFrame<usize>,
        parent: Option<&ElementFrame<usize>>,
    ) -> OpenVerdict {
        let id = self.segs.len();
        self.segs.push(Seg {
            name: el.name.clone(),
            start: el.start,
            end: el.start,
            children: Vec::new(),
        });
        el.data = Some(id);
        match parent.and_then(|p| p.data) {
            Some(owner) => self.segs[owner].children.push(id),
            None => self.roots.push(id),
        }
        // only the table skeleton is walked; paragraphs and nested tables are leaves
        if !CONTAINER.contains(&el.name.as_str()) || (el.name == "w:tbl" && parent.is_some()) {
            return OpenVerdict::Skip;
        }
        OpenVerdict::Continue
    }

    fn close(
        &mut self,
        el: &mut ElementFrame<usize>,
        _parent: Option<&ElementFrame<usize>>,
    ) -> CloseVerdict {
        if let (Some(id), Some(end)) = (el.data, el.end) {
            self.segs[id].end = end;
        }
        CloseVerdict::Continue
    }
}

/// `through`: content controls around rows or cells are looked through.
fn through(segs: &[Seg], ids: &[usize], name: &str) -> Vec<usize> {
    let mut out = Vec::new();
    for &id in ids {
        let s = &segs[id];
        if s.name == name {
            out.push(id);
        } else if s.name == "w:sdt" || s.name == "w:sdtContent" {
            out.extend(through(segs, &s.children, name));
        }
    }
    out
}

/// `collect`
fn collect(segs: &[Seg], ids: &[usize], xml: &str, items: &mut Vec<OxItem>) {
    for &id in ids {
        let c = &segs[id];
        if c.name == "w:p" {
            items.push(OxItem {
                kind: OxItemKind::P,
                xml: slice(xml, c),
            });
        } else if c.name == "w:tbl" {
            items.push(OxItem {
                kind: OxItemKind::Tbl,
                xml: slice(xml, c),
            });
        } else if c.name == "w:sdt" || c.name == "w:sdtContent" {
            collect(segs, &c.children, xml, items);
        }
    }
}

fn slice(xml: &str, s: &Seg) -> String {
    xml[s.start..s.end].to_string()
}

/// `segmentTable`: splits a `w:tbl` source into rows, cells and cell items.
pub fn segment_table(xml: &str) -> OxTable {
    let mut walker = Segmenter {
        segs: Vec::new(),
        roots: Vec::new(),
    };
    let identity = PrefixMap::new();
    walk_elements(xml, &identity, &mut walker, 0, xml.len());
    let segs = &walker.segs;
    let tbl = walker
        .roots
        .iter()
        .copied()
        .find(|&r| segs[r].name == "w:tbl");
    let mut out = OxTable {
        xml: xml.to_string(),
        rows: Vec::new(),
    };
    let Some(tbl) = tbl else {
        return out;
    };
    for tr in through(segs, &segs[tbl].children, "w:tr") {
        let mut cells = Vec::new();
        for tc in through(segs, &segs[tr].children, "w:tc") {
            let tc_pr = segs[tc]
                .children
                .iter()
                .copied()
                .find(|&c| segs[c].name == "w:tcPr");
            let mut items = Vec::new();
            collect(segs, &segs[tc].children, xml, &mut items);
            cells.push(OxCell {
                xml: slice(xml, &segs[tc]),
                tc_pr: tc_pr.map_or_else(String::new, |p| slice(xml, &segs[p])),
                items,
            });
        }
        out.rows.push(OxRow {
            xml: slice(xml, &segs[tr]),
            cells,
        });
    }
    out
}

/// `normalizedTcPr`: `w:tcPr` without the parts the grid decides (width,
/// spans), for comparing cell formatting.
pub fn normalized_tc_pr(tc_pr: &str) -> String {
    let none = |_: &jscompat::JsMatch<'_>| String::new();
    let a = js_regex!(r"<w:tcW\b[^>]*\/>", "g").replace_all(tc_pr, none);
    let b = js_regex!(r"<w:gridSpan\b[^>]*\/>", "g").replace_all(&a, none);
    let c = js_regex!(r"<w:vMerge\b[^>]*\/>", "g").replace_all(&b, none);
    js_regex!(r"^<w:tcPr\/>$").replace_all(&c, |_| "<w:tcPr></w:tcPr>".to_string())
}

/// `withoutBridgeBookmarks`: a `w:p` without the bridge's hidden `_odt...`
/// bookmarks (they never survive an editor rewrite).
pub fn without_bridge_bookmarks(p: &str) -> String {
    let mut ids: HashSet<String> = HashSet::new();
    let out = js_regex!(r"<w:bookmarkStart\b[^>]*\/>", "g").replace_all(p, |m| {
        let tag = m.as_str();
        let name = js_regex!(r#"\bw:name="([^"]*)""#)
            .exec(tag)
            .and_then(|m| m.get(1))
            .unwrap_or("");
        if !name.starts_with("_odt") {
            return tag.to_string();
        }
        if let Some(id) = js_regex!(r#"\bw:id="([^"]*)""#)
            .exec(tag)
            .and_then(|m| m.get(1))
        {
            ids.insert(id.to_string());
        }
        String::new()
    });
    js_regex!(r"<w:bookmarkEnd\b[^>]*\/>", "g").replace_all(&out, |m| {
        let tag = m.as_str();
        match js_regex!(r#"\bw:id="([^"]*)""#)
            .exec(tag)
            .and_then(|m| m.get(1))
        {
            Some(id) if ids.contains(id) => String::new(),
            _ => tag.to_string(),
        }
    })
}

// ---------------------------------------------------------------------------
// The edited grid

/// `EditedAnchor`
#[derive(Clone, Debug)]
pub struct EditedAnchor<'a> {
    pub row: usize,
    pub col: usize,
    pub col_span: usize,
    pub row_span: usize,
    /// index of the anchor's `w:tc` in its `w:tr`
    pub tc: usize,
    pub cell: &'a TableCell,
    pub ox: Option<&'a OxCell>,
}

impl Serialize for EditedAnchor<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(7))?;
        map.serialize_entry("row", &self.row)?;
        map.serialize_entry("col", &self.col)?;
        map.serialize_entry("colSpan", &self.col_span)?;
        map.serialize_entry("rowSpan", &self.row_span)?;
        map.serialize_entry("tc", &self.tc)?;
        map.serialize_entry("cell", self.cell)?;
        map.serialize_entry("ox", &self.ox)?;
        map.end()
    }
}

/// `EditedItem`
#[derive(Clone, Debug)]
pub struct EditedItem<'a> {
    pub kind: OxItemKind,
    /// source of the item in the edited docx
    pub xml: String,
    pub para: Option<Cow<'a, TableParagraph>>,
    pub table: Option<EditedTable<'a>>,
}

impl Serialize for EditedItem<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("kind", &self.kind)?;
        map.serialize_entry("xml", &self.xml)?;
        if let Some(para) = &self.para {
            map.serialize_entry("para", para)?;
        }
        if let Some(table) = &self.table {
            map.serialize_entry("table", table)?;
        }
        map.end()
    }
}

/// `EditedItem['table']`: the edited table model with its segmented source.
#[derive(Clone, Debug)]
pub struct EditedTable<'a> {
    pub model: &'a TableModel,
    pub ox: OxTable,
}

impl Serialize for EditedTable<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("model", self.model)?;
        map.serialize_entry("ox", &self.ox)?;
        map.end()
    }
}

/// `EditedGrid`
#[derive(Clone, Debug)]
pub struct EditedGrid<'a> {
    pub rows: usize,
    pub cols: usize,
    pub anchors: Vec<EditedAnchor<'a>>,
    /// grid position -> index of the covering anchor in `anchors` (None: the row is shorter)
    pub at: Vec<Vec<Option<usize>>>,
    pub widths: Vec<f64>,
}

impl Serialize for EditedGrid<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let at: Vec<Vec<Option<&EditedAnchor<'_>>>> = self
            .at
            .iter()
            .map(|line| line.iter().map(|i| i.map(|i| &self.anchors[i])).collect())
            .collect();
        let widths: Vec<JsNum> = self.widths.iter().map(|w| JsNum(*w)).collect();
        let mut map = serializer.serialize_map(Some(5))?;
        map.serialize_entry("rows", &self.rows)?;
        map.serialize_entry("cols", &self.cols)?;
        map.serialize_entry("anchors", &self.anchors)?;
        map.serialize_entry("at", &at)?;
        map.serialize_entry("widths", &widths)?;
        map.end()
    }
}

impl<'a> EditedGrid<'a> {
    /// `grid.at[r][c]`
    pub fn anchor_at(&self, r: usize, c: usize) -> Option<&EditedAnchor<'a>> {
        self.at[r][c].map(|i| &self.anchors[i])
    }
}

/// `editedGrid`: the merges of an edited table model as grid anchors.
pub fn edited_grid<'a>(model: &'a TableModel, ox: &'a OxTable) -> EditedGrid<'a> {
    let mut at: Vec<Vec<Option<usize>>> = Vec::new();
    let mut anchors: Vec<EditedAnchor<'a>> = Vec::new();
    let mut cols = 0usize;
    for (r, row) in model.rows.iter().enumerate() {
        let mut line: Vec<Option<usize>> = Vec::new();
        let mut c = 0usize;
        let mut tc = 0usize;
        for cell in row {
            let raw = cell.col_span.map_or(1.0, |n| n.0).floor();
            let raw = if raw.is_nan() || raw == 0.0 { 1.0 } else { raw };
            #[allow(clippy::manual_clamp)] // clamp would propagate NaN
            let span = raw.min(1000.0).max(1.0) as usize;
            if cell.grid_gap.unwrap_or(false) {
                c += span;
                continue;
            }
            let above = if r > 0 {
                at[r - 1].get(c).copied().flatten()
            } else {
                None
            };
            let continues = (*cell.v_merge).as_ref() == Some(&TableCellVMerge::Continue)
                && above.is_some_and(|a| {
                    let above = &anchors[a];
                    above.col == c && above.row + above.row_span == r
                });
            if continues {
                let a = above.expect("checked above");
                anchors[a].row_span += 1;
                let above_span = anchors[a].col_span;
                for k in 0..above_span {
                    set_at(&mut line, c + k, Some(a));
                }
                c += above_span;
            } else {
                let id = anchors.len();
                anchors.push(EditedAnchor {
                    row: r,
                    col: c,
                    col_span: span,
                    row_span: 1,
                    tc,
                    cell,
                    ox: ox.rows.get(r).and_then(|row| row.cells.get(tc)),
                });
                for k in 0..span {
                    set_at(&mut line, c + k, Some(id));
                }
                c += span;
            }
            tc += 1;
        }
        at.push(line);
        cols = cols.max(c);
    }
    cols = cols
        .max(model.col_widths_twips.as_ref().map_or(0, Vec::len))
        .max(1);
    for line in &mut at {
        while line.len() < cols {
            line.push(None);
        }
    }
    let widths: Vec<f64> = if model.col_widths_twips.as_ref().map(Vec::len) == Some(cols) {
        model
            .col_widths_twips
            .as_ref()
            .expect("checked above")
            .iter()
            .map(|w| math_round(w.0))
            .collect()
    } else if model.col_widths_pct.as_ref().map(Vec::len) == Some(cols) {
        let pct = model.col_widths_pct.as_ref().expect("checked above");
        let total: f64 = pct.iter().fold(0.0, |a, b| a + b.0);
        let sum = if total == 0.0 || total.is_nan() {
            100.0
        } else {
            total
        };
        pct.iter()
            .map(|p| math_round((p.0 / sum) * 9638.0))
            .collect()
    } else {
        (0..cols)
            .map(|_| math_round(9638.0 / cols as f64))
            .collect()
    };
    EditedGrid {
        rows: model.rows.len(),
        cols,
        anchors,
        at,
        widths,
    }
}

/// `line[index] = value` on a JavaScript array: the holes below stay empty
/// (`undefined`), which the TypeScript fills with `null` afterwards.
fn set_at(line: &mut Vec<Option<usize>>, index: usize, value: Option<usize>) {
    while line.len() <= index {
        line.push(None);
    }
    line[index] = value;
}

/// `editedItems`: the edited cell's visible items with their parsed content.
pub fn edited_items<'a>(cell: &'a TableCell, ox: Option<&'a OxCell>) -> Vec<EditedItem<'a>> {
    let paras: &'a [TableParagraph] = cell.rich_paras.as_deref().unwrap_or(&[]);
    let tables: &'a [TableModel] = cell.nested_tables.as_deref().unwrap_or(&[]);
    if let Some(ox) = ox {
        let mut p = 0usize;
        let mut t = 0usize;
        return ox
            .items
            .iter()
            .map(|item| {
                if item.kind == OxItemKind::P {
                    let para = paras.get(p);
                    p += 1;
                    return EditedItem {
                        kind: OxItemKind::P,
                        xml: item.xml.clone(),
                        para: Some(match para {
                            Some(para) => Cow::Borrowed(para),
                            None => Cow::Owned(TableParagraph::default()),
                        }),
                        table: None,
                    };
                }
                let model = tables.get(t);
                t += 1;
                EditedItem {
                    kind: OxItemKind::Tbl,
                    xml: item.xml.clone(),
                    para: None,
                    table: model.map(|model| EditedTable {
                        model,
                        ox: segment_table(&item.xml),
                    }),
                }
            })
            .collect();
    }
    // no source (should not happen for parsed tables): rebuild the order from anchors
    let mut out: Vec<EditedItem<'a>> = paras
        .iter()
        .map(|para| EditedItem {
            kind: OxItemKind::P,
            xml: String::new(),
            para: Some(Cow::Borrowed(para)),
            table: None,
        })
        .collect();
    let anchors: &[jscompat::JsNum] = cell
        .nested_table_anchors
        .as_ref()
        .map_or(&[][..], |v| v.as_slice());
    for i in (0..tables.len()).rev() {
        let want = anchors.get(i).map_or(out.len() as f64, |n| n.0);
        // `Math.min(anchors[i] ?? out.length, out.length)`, then `splice(at, 0, ...)`
        let at = want.min(out.len() as f64);
        let at = if at.is_nan() {
            0
        } else if at < 0.0 {
            // splice counts a negative start from the end
            (out.len() as f64 + at.trunc()).max(0.0) as usize
        } else {
            at.trunc() as usize
        };
        out.insert(
            at,
            EditedItem {
                kind: OxItemKind::Tbl,
                xml: String::new(),
                para: None,
                table: Some(EditedTable {
                    model: &tables[i],
                    ox: OxTable::default(),
                }),
            },
        );
    }
    out
}

/// `paraText`: text of a cell paragraph as the bridge compares it (run texts joined).
pub fn para_text(p: Option<&TableParagraph>) -> String {
    p.map_or_else(String::new, |p| {
        p.runs
            .iter()
            .map(|r| r.text.as_deref().unwrap_or(""))
            .collect::<Vec<_>>()
            .concat()
    })
}
