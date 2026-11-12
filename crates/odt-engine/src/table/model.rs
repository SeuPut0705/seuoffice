//! `table/model.ts`: the table layer's slot in the bridge map,
//! `BridgeMap.ext.table`.
//!
//! Everything here is plain JSON (it crosses IPC between open and save).
//! Offsets index the decoded content.xml string of the ORIGINAL ODT, like
//! every other offset of the bridge: they are `U16`, counts of UTF-16 code
//! units. A record whose TypeScript holds `-1` for "no element" (a column the
//! ODT does not define, a gap a row leaves out) carries a `Pos` instead.
//!
//! Addressing: a top-level table is the bridge element (`BridgeMap.elements`
//! index) of its `w:tbl`; a cell is (grid row, grid column) of that table,
//! header rows included, 0-based. Tables nested in cells are reached through a
//! `path` of host cells. `protectedCells` is the published list of cells
//! Hancom locked; the editor and the CLI read it to refuse edits there.

use jscompat::{JsNum, JsObject};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::offset::U16;

/// `TABLE_OWNER`
pub const TABLE_OWNER: &str = "table";
/// `TABLE_EXT_VERSION`
pub const TABLE_EXT_VERSION: u32 = 1;

/// An offset that may be `-1` ("there is no element"): the number the
/// TypeScript writes, as `U16` or as nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pos(pub Option<U16>);

impl Pos {
    /// `-1`
    pub const NONE: Pos = Pos(None);

    /// `value >= 0`
    pub fn is_some(self) -> bool {
        self.0.is_some()
    }

    /// `value < 0`
    pub fn is_none(self) -> bool {
        self.0.is_none()
    }
}

impl From<U16> for Pos {
    fn from(at: U16) -> Self {
        Pos(Some(at))
    }
}

impl Serialize for Pos {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            Some(at) => at.serialize(serializer),
            None => serializer.serialize_i64(-1),
        }
    }
}

impl<'de> Deserialize<'de> for Pos {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let n = i64::deserialize(deserializer)?;
        Ok(if n < 0 {
            Pos(None)
        } else {
            Pos(Some(U16(n as u32)))
        })
    }
}

/// `RangeRecord`: a source range in content.xml.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RangeRecord {
    pub start: U16,
    pub end: U16,
}

/// `RangeRecord` where the TypeScript holds `-1` for a missing element.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PosRange {
    pub start: Pos,
    pub end: Pos,
}

/// `ElementRecord`: a source range with the end of the start tag and the start
/// of the end tag.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementRecord {
    pub start: U16,
    pub end: U16,
    pub open_end: U16,
    pub close_start: U16,
    pub self_closing: bool,
}

/// `ElementRecord` where the TypeScript holds `-1` for a missing element
/// (`ColumnRecord`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PosElement {
    pub start: Pos,
    pub end: Pos,
    pub open_end: Pos,
    pub close_start: Pos,
    pub self_closing: bool,
}

/// `NestedStep`: one step from a table into a table nested in one of its cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NestedStep {
    /// grid row of the host cell
    pub row: usize,
    /// grid column of the host cell
    pub col: usize,
    /// which table of the host cell (0-based, in reading order)
    pub index: usize,
}

/// `ProtectedCellRef`: a cell Hancom locked (`table:protected="true"` on the
/// cell, a cell style whose `style:cell-protect` protects it, or
/// `table:protected="true"` on the whole table). Nothing may change its
/// content or its place in the grid.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtectedCellRef {
    /// bridge element id (`BridgeMap.elements` index) of the top-level `w:tbl`
    pub table: usize,
    /// host cells leading into nested tables, outermost first; empty for the top-level table
    pub path: Vec<NestedStep>,
    /// grid row in the innermost table (0-based, header rows included)
    pub row: usize,
    /// grid column of the cell's first column (0-based)
    pub col: usize,
    /// index of the cell's `w:tc` in its `w:tr`
    pub tc: usize,
}

/// `UnitRecord`: one unit of a cell's (or the body's) content as the bridge shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum UnitRecord {
    /// a paragraph (`text:p`/`text:h`), possibly inside a list in the cell
    #[serde(rename = "p")]
    P {
        paragraph: usize,
        start: U16,
        end: U16,
    },
    /// a table placed directly in the cell
    #[serde(rename = "t")]
    T { table: usize, start: U16, end: U16 },
    /// a paragraph holding tables in frames
    /// (`text:p > draw:frame > draw:text-box > table:table`)
    #[serde(rename = "f", rename_all = "camelCase")]
    F {
        start: U16,
        end: U16,
        /// the paragraph's own text as a bridge paragraph, or null when it holds nothing else
        paragraph: Option<usize>,
        /// the paragraph's text is shown before its tables (else after them)
        paragraph_first: bool,
        tables: Vec<usize>,
    },
}

impl UnitRecord {
    /// `u.start`
    pub fn start(&self) -> U16 {
        match self {
            UnitRecord::P { start, .. }
            | UnitRecord::T { start, .. }
            | UnitRecord::F { start, .. } => *start,
        }
    }

    /// `u.end`
    pub fn end(&self) -> U16 {
        match self {
            UnitRecord::P { end, .. } | UnitRecord::T { end, .. } | UnitRecord::F { end, .. } => {
                *end
            }
        }
    }

    /// `u.kind === 'p' ? u.paragraph : u.kind === 'f' ? u.paragraph : null`
    pub fn paragraph_id(&self) -> Option<usize> {
        match self {
            UnitRecord::P { paragraph, .. } => Some(*paragraph),
            UnitRecord::F { paragraph, .. } => *paragraph,
            UnitRecord::T { .. } => None,
        }
    }
}

/// `AnchorCellRecord['synthetic']`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Synthetic {
    /// after a last nested table (OOXML cells end with a paragraph)
    #[serde(rename = "trailing")]
    Trailing,
    /// in a cell with no paragraph at all
    #[serde(rename = "empty")]
    Empty,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// `AnchorCellRecord`: a real cell (`table:table-cell`); it anchors its own
/// merge. Defaults are omitted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorCellRecord {
    #[serde(flatten)]
    pub element: ElementRecord,
    /// index of the cell's `w:tc` in its `w:tr`
    pub tc: usize,
    /// decoded `table:style-name`
    pub style: Option<String>,
    /// content units
    pub units: Vec<UnitRecord>,
    /// merge size; omitted when 1
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub col_span: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_span: Option<usize>,
    /// Hancom locked the cell; omitted when not
    #[serde(default, skip_serializing_if = "is_false")]
    pub protected: bool,
    /// the bridge added an empty `w:p` the ODT does not have; omitted when none
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synthetic: Option<Synthetic>,
}

/// `CoveredCellRecord`: a grid position hidden by the merge of the cell at
/// `anchor` (`table:covered-table-cell`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoveredCellRecord {
    #[serde(flatten)]
    pub range: PosRange,
    /// grid position of the merged cell covering this one
    pub anchor: (usize, usize),
    /// a vertical merge continues here as its own `w:tc` (`w:vMerge`), else null
    pub tc: Option<usize>,
}

/// `EmptyCellRecord`: a covered cell no merge explains (`orphan`) or a
/// position its row leaves out (`filler`, no element: start = end = -1). The
/// bridge shows an empty cell; nothing typed there is written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmptyCellRecord {
    #[serde(flatten)]
    pub range: PosRange,
    pub tc: usize,
}

/// `CellRecord`
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum CellRecord {
    #[serde(rename = "cell")]
    Cell(AnchorCellRecord),
    #[serde(rename = "covered")]
    Covered(CoveredCellRecord),
    #[serde(rename = "orphan")]
    Orphan(EmptyCellRecord),
    #[serde(rename = "filler")]
    Filler(EmptyCellRecord),
}

impl CellRecord {
    /// `cell.tc` (null for a covered cell that starts no `w:tc`)
    pub fn tc(&self) -> Option<usize> {
        match self {
            CellRecord::Cell(c) => Some(c.tc),
            CellRecord::Covered(c) => c.tc,
            CellRecord::Orphan(c) | CellRecord::Filler(c) => Some(c.tc),
        }
    }

    /// The range of the cell's element, `-1` where it has none.
    pub fn range(&self) -> PosRange {
        match self {
            CellRecord::Cell(c) => PosRange {
                start: c.element.start.into(),
                end: c.element.end.into(),
            },
            CellRecord::Covered(c) => c.range,
            CellRecord::Orphan(c) | CellRecord::Filler(c) => c.range,
        }
    }
}

/// `anchorOf`: grid position of the cell that owns position (`row`, `col`).
pub fn anchor_of(cell: &CellRecord, row: usize, col: usize) -> (usize, usize) {
    match cell {
        CellRecord::Covered(c) => c.anchor,
        _ => (row, col),
    }
}

/// The result of `spanOf`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub col_span: usize,
    pub row_span: usize,
}

/// `spanOf`: merge size of a cell record (1x1 for anything but a merged real cell).
pub fn span_of(cell: &CellRecord) -> Span {
    match cell {
        CellRecord::Cell(c) => Span {
            col_span: c.col_span.unwrap_or(1),
            row_span: c.row_span.unwrap_or(1),
        },
        _ => Span {
            col_span: 1,
            row_span: 1,
        },
    }
}

/// `RowRecord`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowRecord {
    #[serde(flatten)]
    pub element: ElementRecord,
    /// inside `table:table-header-rows`
    pub header: bool,
    /// decoded `table:style-name`
    pub style: Option<String>,
    /// row height from its style (`style:row-height`, else `style:min-row-height`) in cm, or null
    pub height_cm: Option<JsNum>,
}

/// `ColumnRecord`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnRecord {
    #[serde(flatten)]
    pub element: PosElement,
    /// decoded `table:style-name`
    pub style: Option<String>,
    /// the element carries `table:number-columns-repeated` (it stands for several grid columns)
    pub repeated: bool,
    /// width written into the bridge grid (twips)
    pub width_twips: JsNum,
}

/// `FrameRecord`: the frame a table sits in:
/// `text:p > draw:frame > draw:text-box > table:table`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrameRecord {
    /// the paragraph holding the frame
    pub paragraph: RangeRecord,
    /// the `draw:frame` element
    pub frame: ElementRecord,
    /// decoded `draw:style-name` of the frame
    pub style: Option<String>,
    /// `text:anchor-type` of the frame
    pub anchor: Option<String>,
}

/// `TableRecord['host']`: for a nested table, the host cell and the table's index there.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostRef {
    pub table: usize,
    pub row: usize,
    pub col: usize,
    pub index: usize,
}

/// `TableRecord`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRecord {
    #[serde(flatten)]
    pub element: ElementRecord,
    /// index in `TableExt.tables`
    pub id: usize,
    /// bridge block that converted the table (or its frame paragraph)
    pub block: usize,
    /// bridge element id of the top-level `w:tbl`; null for nested tables
    #[serde(rename = "element")]
    pub element_id: Option<usize>,
    /// for a nested table: the host cell and the table's index there
    pub host: Option<HostRef>,
    pub frame: Option<FrameRecord>,
    /// the `table:table-header-rows` element, or null
    pub header_rows: Option<ElementRecord>,
    pub rows: Vec<RowRecord>,
    /// one per grid column
    pub columns: Vec<ColumnRecord>,
    /// `[row][col]` for every grid position
    pub cells: Vec<Vec<CellRecord>>,
    /// total grid width (twips)
    pub width_twips: JsNum,
    /// why structural rewrites are refused (row groups, repeated rows/cells), or null
    pub structure_locked: Option<String>,
}

/// `TableExt`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableExt {
    pub version: u32,
    /// every converted table, top-level and nested, in conversion order
    pub tables: Vec<TableRecord>,
    /// bridge element id (as a string key) -> table id, for top-level tables
    pub elements: JsObject<usize>,
    /// cells Hancom locked; see `ProtectedCellRef`
    pub protected_cells: Vec<ProtectedCellRef>,
}

/// `TableBlockData['kind']`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TableBlockKind {
    /// a bare `table:table`
    #[serde(rename = "table")]
    Table,
    /// a paragraph holding framed tables
    #[serde(rename = "frames")]
    Frames,
}

/// `TableBlockData`: `BridgeBlock.data` of a block the table owner converted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableBlockData {
    pub kind: TableBlockKind,
    /// the frame paragraph's own text record (mixed paragraphs), else null
    pub paragraph: Option<usize>,
    /// the paragraph's text is shown before its tables (else after them)
    pub paragraph_first: bool,
    pub tables: Vec<usize>,
}

/// `emptyTableExt`
pub fn empty_table_ext() -> TableExt {
    TableExt {
        version: TABLE_EXT_VERSION,
        tables: Vec::new(),
        elements: JsObject::new(),
        protected_cells: Vec::new(),
    }
}

/// `asJson`: a record as the JSON value type of the bridge map.
pub fn as_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a table record serializes")
}
