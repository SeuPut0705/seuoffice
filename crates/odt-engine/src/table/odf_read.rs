//! `table/odf-read.ts`: reading ODF tables from the core position map: the
//! cell grid (spans, covered cells, header rows, column definitions), the
//! content units of a cell, the "framed table" paragraphs Hancom writes, and
//! the style properties the bridge maps.
//!
//! Hancom places most tables in `text:p > draw:frame > draw:text-box >
//! table:table`; the paragraph usually holds nothing else. Covered cells are
//! explicit elements, one per grid column, so a cell's grid column is simply
//! its index in the row.

use jscompat::{JsObject, Radix, js_regex, parse_int, trim};

use crate::core::body::{OdtNode, OdtNodeKind, cell_span};
use crate::core::open::OdtDocument;
use crate::core::styles::OdtStyleScope;
use crate::core::xml::decode_xml_entities;
use crate::text::units::length_to_twips;

// ---------------------------------------------------------------------------
// Framed tables

/// `TableFrame`
#[derive(Clone, Copy)]
pub struct TableFrame<'a> {
    pub frame: &'a OdtNode,
    pub text_box: &'a OdtNode,
    pub table: &'a OdtNode,
}

/// `tableFrameOf`: the table of a `draw:frame` whose text box holds exactly
/// one table and nothing else, or `None`. Other layers (objects) must leave
/// such frames to the table layer.
pub fn table_frame_of(frame: &OdtNode) -> Option<TableFrame<'_>> {
    if frame.kind != OdtNodeKind::Frame || frame.children.len() != 1 {
        return None;
    }
    let text_box: &OdtNode = &frame.children[0];
    if text_box.kind != OdtNodeKind::TextBox || text_box.children.len() != 1 {
        return None;
    }
    let table: &OdtNode = &text_box.children[0];
    if table.kind != OdtNodeKind::Table || table.self_closing {
        return None;
    }
    Some(TableFrame {
        frame,
        text_box,
        table,
    })
}

/// `FrameHost`
#[derive(Clone)]
pub struct FrameHost<'a> {
    /// the paragraph
    pub node: &'a OdtNode,
    pub frames: Vec<TableFrame<'a>>,
    /// the paragraph holds nothing visible besides the framed tables
    pub pure: bool,
    /// the paragraph's own text starts before its first framed table
    pub paragraph_first: bool,
}

/// `BOOKMARK_KINDS`
fn is_bookmark_kind(kind: OdtNodeKind) -> bool {
    matches!(
        kind,
        OdtNodeKind::Bookmark | OdtNodeKind::BookmarkStart | OdtNodeKind::BookmarkEnd
    )
}

/// `visible`: visible text of a markup slice (tags dropped, entities
/// decoded), trimmed.
fn visible(xml: &str) -> String {
    let stripped = js_regex!(r"<[^>]*>", "g").replace_all(xml, |_| String::new());
    trim(&decode_xml_entities(&stripped)).to_string()
}

/// `frameHostOf`: a paragraph that holds framed tables, or `None`.
pub fn frame_host_of<'a>(node: &'a OdtNode, xml: &str) -> Option<FrameHost<'a>> {
    if (node.kind != OdtNodeKind::Paragraph && node.kind != OdtNodeKind::Heading)
        || node.self_closing
    {
        return None;
    }
    let mut frames: Vec<TableFrame<'a>> = Vec::new();
    let mut others = false;
    for child in &node.children {
        let child: &OdtNode = child;
        if let Some(found) = table_frame_of(child) {
            frames.push(found);
        } else if !is_bookmark_kind(child.kind) {
            others = true;
        }
    }
    if frames.is_empty() {
        return None;
    }
    let mut rest = String::new();
    let mut at = node.open_end;
    for f in &frames {
        rest.push_str(&xml[at..f.frame.start]);
        at = f.frame.end;
    }
    rest.push_str(&xml[at..node.close_start]);
    let pure = !others && visible(&rest).is_empty();
    let paragraph_first = !visible(&xml[node.open_end..frames[0].frame.start]).is_empty();
    Some(FrameHost {
        node,
        frames,
        pure,
        paragraph_first,
    })
}

// ---------------------------------------------------------------------------
// The grid

/// `OdfGridCell['kind']`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OdfCellKind {
    Cell,
    Covered,
    Filler,
}

/// `OdfGridCell`
#[derive(Clone)]
pub struct OdfGridCell<'a> {
    pub node: Option<&'a OdtNode>,
    pub kind: OdfCellKind,
    pub anchor: (usize, usize),
    pub col_span: usize,
    pub row_span: usize,
}

/// One entry of `OdfGrid.rows`.
#[derive(Clone)]
pub struct OdfGridRow<'a> {
    pub node: &'a OdtNode,
    pub header: bool,
}

/// One entry of `OdfGrid.columns`.
#[derive(Clone)]
pub struct OdfGridColumn<'a> {
    pub node: Option<&'a OdtNode>,
    pub repeated: bool,
}

/// `OdfGrid`
pub struct OdfGrid<'a> {
    pub table: &'a OdtNode,
    pub header_rows: Option<&'a OdtNode>,
    pub rows: Vec<OdfGridRow<'a>>,
    /// one per grid column (the element, possibly repeated); `None` when the ODT defines fewer
    pub columns: Vec<OdfGridColumn<'a>>,
    pub cells: Vec<Vec<OdfGridCell<'a>>>,
    pub structure_locked: Option<String>,
}

/// `repeatOf`
fn repeat_of(node: &OdtNode, attr: &str) -> usize {
    let n = parse_int(node.attr(attr).unwrap_or("1"), Radix::Ten);
    if n.is_finite() && n > 1.0 {
        n.min(1024.0) as usize
    } else {
        1
    }
}

struct GridState<'a> {
    rows: Vec<OdfGridRow<'a>>,
    columns: Vec<OdfGridColumn<'a>>,
    header_rows: Option<&'a OdtNode>,
    locked: Option<String>,
}

impl<'a> GridState<'a> {
    /// `lock`
    fn lock(&mut self, why: String) {
        if self.locked.is_none() {
            self.locked = Some(why);
        }
    }

    /// `addColumn`
    fn add_column(&mut self, node: &'a OdtNode) {
        let n = repeat_of(node, "table:number-columns-repeated");
        for _ in 0..n {
            self.columns.push(OdfGridColumn {
                node: Some(node),
                repeated: n > 1,
            });
        }
    }

    /// `walkRows`
    fn walk_rows(&mut self, table: &'a OdtNode, container: &'a OdtNode, header: bool) {
        for child in &container.children {
            let child: &'a OdtNode = child;
            if child.kind == OdtNodeKind::TableRow {
                if repeat_of(child, "table:number-rows-repeated") > 1 {
                    self.lock("repeated rows".to_string());
                }
                self.rows.push(OdfGridRow {
                    node: child,
                    header,
                });
            } else if child.kind == OdtNodeKind::RowGroup {
                let is_header = child.name == "table:table-header-rows";
                if is_header && self.header_rows.is_none() && std::ptr::eq(container, table) {
                    self.header_rows = Some(child);
                } else {
                    self.lock(format!("row group {}", child.name));
                }
                self.walk_rows(table, child, header || is_header);
            }
        }
    }
}

/// `readGrid`: reads the grid of a `table:table` node.
pub fn read_grid(table: &OdtNode) -> OdfGrid<'_> {
    let mut state = GridState {
        rows: Vec::new(),
        columns: Vec::new(),
        header_rows: None,
        locked: None,
    };
    for child in &table.children {
        let child: &OdtNode = child;
        if child.kind == OdtNodeKind::TableColumn {
            state.add_column(child);
        } else if child.kind == OdtNodeKind::ColumnGroup {
            state.lock(format!("column group {}", child.name));
            for c in &child.children {
                let c: &OdtNode = c;
                if c.kind == OdtNodeKind::TableColumn {
                    state.add_column(c);
                }
            }
        }
    }
    state.walk_rows(table, table, false);
    let GridState {
        rows,
        mut columns,
        header_rows,
        mut locked,
    } = state;

    // elements per row, repeated cells expanded
    let elements: Vec<Vec<&OdtNode>> = rows
        .iter()
        .map(|row| {
            let mut out: Vec<&OdtNode> = Vec::new();
            for c in &row.node.children {
                let c: &OdtNode = c;
                if c.kind != OdtNodeKind::TableCell && c.kind != OdtNodeKind::CoveredCell {
                    continue;
                }
                let n = repeat_of(c, "table:number-columns-repeated");
                if n > 1 && locked.is_none() {
                    locked = Some("repeated cells".to_string());
                }
                for _ in 0..n {
                    out.push(c);
                }
            }
            out
        })
        .collect();
    let width = elements
        .iter()
        .map(Vec::len)
        .fold(columns.len().max(1), usize::max);
    while columns.len() < width {
        columns.push(OdfGridColumn {
            node: None,
            repeated: false,
        });
    }

    let mut cells: Vec<Vec<OdfGridCell>> = elements
        .iter()
        .enumerate()
        .map(|(r, row)| {
            (0..width)
                .map(|c| match row.get(c) {
                    None => OdfGridCell {
                        node: None,
                        kind: OdfCellKind::Filler,
                        anchor: (r, c),
                        col_span: 1,
                        row_span: 1,
                    },
                    Some(&node) => OdfGridCell {
                        node: Some(node),
                        kind: if node.kind == OdtNodeKind::TableCell {
                            OdfCellKind::Cell
                        } else {
                            OdfCellKind::Covered
                        },
                        anchor: (r, c),
                        col_span: 1,
                        row_span: 1,
                    },
                })
                .collect()
        })
        .collect();
    // spans: a merge covers the explicit covered cells to its right and below
    let mut owned: Vec<Vec<bool>> = cells.iter().map(|row| vec![false; row.len()]).collect();
    let row_count = cells.len();
    for r in 0..row_count {
        for c in 0..width {
            let (kind, node) = (cells[r][c].kind, cells[r][c].node);
            let Some(node) = node else { continue };
            if kind != OdfCellKind::Cell || owned[r][c] {
                continue;
            }
            let span = cell_span(node);
            let mut cs = span.columns.min(width - c);
            let mut rs = span.rows.min(row_count - r);
            // stop at a real cell or a position another merge already took
            for k in 1..cs {
                let x = &cells[r][c + k];
                if x.kind != OdfCellKind::Covered || owned[r][c + k] {
                    cs = k;
                    break;
                }
            }
            for k in 1..rs {
                let mut ok = true;
                for j in 0..cs {
                    let x = &cells[r + k][c + j];
                    if x.kind != OdfCellKind::Covered || owned[r + k][c + j] {
                        ok = false;
                    }
                }
                if !ok {
                    rs = k;
                    break;
                }
            }
            cells[r][c].col_span = cs;
            cells[r][c].row_span = rs;
            for i in 0..rs {
                for j in 0..cs {
                    if i == 0 && j == 0 {
                        continue;
                    }
                    owned[r + i][c + j] = true;
                    cells[r + i][c + j].anchor = (r, c);
                }
            }
        }
    }
    OdfGrid {
        table,
        header_rows,
        rows,
        columns,
        cells,
        structure_locked: locked,
    }
}

/// `tcIndexes`: index of the `w:tc` that starts at each grid position (`None`
/// where none does): an anchor cell, the continuation of a vertical merge, a
/// covered cell no merge explains, or a filler.
pub fn tc_indexes(cells: &[Vec<OdfGridCell<'_>>]) -> Vec<Vec<Option<usize>>> {
    cells
        .iter()
        .enumerate()
        .map(|(r, row)| {
            let mut k = 0usize;
            row.iter()
                .enumerate()
                .map(|(c, cell)| {
                    let (ar, ac) = cell.anchor;
                    if ac != c {
                        return None;
                    }
                    if ar <= r {
                        let at = k;
                        k += 1;
                        return Some(at);
                    }
                    None
                })
                .collect()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Cell content

/// `UnitDraft['list']`: list membership inside the cell.
#[derive(Clone)]
pub struct UnitList<'a> {
    pub root: &'a OdtNode,
    pub depth: usize,
    pub header: bool,
    pub continuation: bool,
}

/// `UnitDraft`
#[derive(Clone)]
pub enum UnitDraft<'a> {
    P {
        node: &'a OdtNode,
        list: Option<UnitList<'a>>,
    },
    T {
        node: &'a OdtNode,
    },
    F {
        node: &'a OdtNode,
        host: FrameHost<'a>,
    },
}

/// `contentUnits`: the content units of a cell (paragraphs anywhere outside
/// nested tables, tables, framed tables).
pub fn content_units<'a>(container: &'a OdtNode, xml: &str) -> Vec<UnitDraft<'a>> {
    let mut out: Vec<UnitDraft<'a>> = Vec::new();
    for child in &container.children {
        walk(child, xml, &mut out);
    }
    out
}

/// `paragraph` of `contentUnits`
fn paragraph<'a>(
    node: &'a OdtNode,
    list: Option<UnitList<'a>>,
    xml: &str,
    out: &mut Vec<UnitDraft<'a>>,
) {
    match frame_host_of(node, xml) {
        Some(host) => out.push(UnitDraft::F { node, host }),
        None => out.push(UnitDraft::P { node, list }),
    }
}

/// `walkList` of `contentUnits`
fn walk_list<'a>(
    root: &'a OdtNode,
    list: &'a OdtNode,
    depth: usize,
    xml: &str,
    out: &mut Vec<UnitDraft<'a>>,
) {
    for item in &list.children {
        let item: &'a OdtNode = item;
        if item.kind != OdtNodeKind::ListItem {
            walk(item, xml, out);
            continue;
        }
        let header = item.name == "text:list-header";
        let mut first = true;
        for child in &item.children {
            let child: &'a OdtNode = child;
            if child.kind == OdtNodeKind::Paragraph || child.kind == OdtNodeKind::Heading {
                paragraph(
                    child,
                    Some(UnitList {
                        root,
                        depth,
                        header,
                        continuation: !first,
                    }),
                    xml,
                    out,
                );
                first = false;
            } else if child.kind == OdtNodeKind::List {
                walk_list(root, child, depth + 1, xml, out);
            } else {
                walk(child, xml, out);
            }
        }
    }
}

/// `walk` of `contentUnits`
fn walk<'a>(node: &'a OdtNode, xml: &str, out: &mut Vec<UnitDraft<'a>>) {
    match node.kind {
        OdtNodeKind::Paragraph | OdtNodeKind::Heading => paragraph(node, None, xml, out),
        OdtNodeKind::Table => out.push(UnitDraft::T { node }),
        OdtNodeKind::List => walk_list(node, node, 0, xml, out),
        OdtNodeKind::Section => {
            for c in &node.children {
                walk(c, xml, out);
            }
        }
        // bookmarks and anything else stay in the cell's bytes
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Style properties

/// `styleProps`: effective properties of an automatic or common style of
/// `family` (content.xml scope).
pub fn style_props(
    doc: &OdtDocument,
    name: Option<&str>,
    family: &str,
    path: &str,
) -> JsObject<String> {
    let Some(name) = name.filter(|n| !n.is_empty()) else {
        return JsObject::new();
    };
    doc.styles
        .resolve(name, family, OdtStyleScope::Content)
        .and_then(|style| style.properties.get(path).cloned())
        .unwrap_or_default()
}

/// `lengthCm`: a length in cm (unrounded), or `None`.
pub fn length_cm(value: Option<&str>) -> Option<f64> {
    length_to_twips(value).map(|t| (t * 2.54) / 1440.0)
}

/// `cellIsProtected`: whether a cell's own attribute or its style locks it.
pub fn cell_is_protected(doc: &OdtDocument, cell: &OdtNode, table_locked: bool) -> bool {
    if table_locked {
        return true;
    }
    if cell.attr("table:protected") == Some("true") {
        return true;
    }
    let props = style_props(
        doc,
        cell.attr("table:style-name"),
        "table-cell",
        "style:table-cell-properties",
    );
    match props.get("style:cell-protect") {
        Some(protect) => !protect.is_empty() && js_regex!(r"\bprotected\b").test(protect),
        None => false,
    }
}

/// The result of `rowHeightCm`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RowHeight {
    pub cm: f64,
    pub exact: bool,
}

/// `rowHeightCm`: row height (cm) from the row style: fixed height, else the minimum.
pub fn row_height_cm(doc: &OdtDocument, style_name: Option<&str>) -> Option<RowHeight> {
    let p = style_props(doc, style_name, "table-row", "style:table-row-properties");
    if let Some(cm) = length_cm(p.get("style:row-height").map(String::as_str)) {
        return Some(RowHeight { cm, exact: true });
    }
    length_cm(p.get("style:min-row-height").map(String::as_str))
        .map(|cm| RowHeight { cm, exact: false })
}
