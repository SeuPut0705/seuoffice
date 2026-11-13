//! `core/body.ts`: the position map over content.xml's body.
//!
//! `scan_odt_body` records, for `office:text`, every top-level child and the
//! structural elements nested inside it as ranges into the ORIGINAL decoded
//! string. Slicing the string by a node's range returns that element's exact
//! source.
//!
//! # Offsets (the rule for every layer)
//!
//! An `OdtNode` range (`start`, `open_end`, `name_end`, `close_start`, `end`)
//! holds UTF-8 BYTE offsets into `OdtBody.xml.text`. Inside the engine every
//! offset into a part string is a byte offset. A value that becomes JSON (a
//! `BridgeBlock`, a `BridgeParagraph`, a `BridgeMarker`, an `ext` record) holds
//! a `U16`, and the conversion is made where the value is written or read:
//! `IndexedText::to_u16(byte)` going out, `IndexedText::to_byte(u16)` coming
//! in (`OdtPartInfo.xml` and `OdtDocument.content_xml` are `IndexedText`).
//! `OdfToOoxmlContext::add_block` converts a node's range for its block.
//!
//! # The tree
//!
//! A node is an `Rc<OdtNode>`: `children` owns its recorded descendants and
//! `parent()` answers the nearest recorded ancestor. Compare two nodes with
//! `Rc::ptr_eq`. A node is immutable once `scan_odt_body` returns.

use std::cell::{OnceCell, RefCell};
use std::rc::{Rc, Weak};

use jscompat::{JsMap, JsObject, Radix, parse_int, trim};
use serde::{Deserialize, Serialize};

use super::errors::{OdtError, OdtOpenErrorCode};
use super::xml::CloseVerdict;
use super::xml::{
    ElementFrame, ElementRange, ElementVisitor, OpenVerdict, PrefixMap, XmlAttribute, XmlTokenKind,
    attribute_map, read_attributes, read_root, slice, walk_elements,
};
use crate::offset::IndexedText;

/// `OdtNodeKind`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OdtNodeKind {
    /// `text:p`
    Paragraph,
    /// `text:h`
    Heading,
    /// `text:list`
    List,
    /// `text:list-item`, `text:list-header`
    ListItem,
    /// `text:section`
    Section,
    /// `text:table-of-content` and the other `text:*-index` elements
    Index,
    /// `table:table`
    Table,
    /// `table:table-columns`, `table:table-header-columns`, `table:table-column-group`
    ColumnGroup,
    /// `table:table-column`
    TableColumn,
    /// `table:table-header-rows`, `table:table-rows`, `table:table-row-group`
    RowGroup,
    /// `table:table-row`
    TableRow,
    /// `table:table-cell`
    TableCell,
    /// `table:covered-table-cell` (hidden by a merge)
    CoveredCell,
    /// `draw:frame`
    Frame,
    /// `draw:text-box`
    TextBox,
    /// `draw:image`
    Image,
    /// `draw:object`, `draw:object-ole`
    Object,
    /// `draw:rect`, `draw:custom-shape`, `draw:g` ... and `dr3d:scene`
    Shape,
    /// `text:bookmark` (a point)
    Bookmark,
    /// `text:bookmark-start`
    BookmarkStart,
    /// `text:bookmark-end`
    BookmarkEnd,
    /// `office:annotation`
    Annotation,
    /// `office:annotation-end`
    AnnotationEnd,
    /// `text:note` (footnote / endnote)
    Note,
    /// any other element directly under `office:text`
    Other,
    /// a comment, CDATA, processing instruction or stray text directly under `office:text`
    Opaque,
}

impl OdtNodeKind {
    /// The string the TypeScript holds.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Paragraph => "paragraph",
            Self::Heading => "heading",
            Self::List => "list",
            Self::ListItem => "list-item",
            Self::Section => "section",
            Self::Index => "index",
            Self::Table => "table",
            Self::ColumnGroup => "column-group",
            Self::TableColumn => "table-column",
            Self::RowGroup => "row-group",
            Self::TableRow => "table-row",
            Self::TableCell => "table-cell",
            Self::CoveredCell => "covered-cell",
            Self::Frame => "frame",
            Self::TextBox => "text-box",
            Self::Image => "image",
            Self::Object => "object",
            Self::Shape => "shape",
            Self::Bookmark => "bookmark",
            Self::BookmarkStart => "bookmark-start",
            Self::BookmarkEnd => "bookmark-end",
            Self::Annotation => "annotation",
            Self::AnnotationEnd => "annotation-end",
            Self::Note => "note",
            Self::Other => "other",
            Self::Opaque => "opaque",
        }
    }
}

/// `ODT_NODE_KINDS`: canonical element name to node kind for the elements
/// recorded at any depth, in the order the TypeScript record lists them.
pub const ODT_NODE_KINDS: &[(&str, OdtNodeKind)] = &[
    ("text:p", OdtNodeKind::Paragraph),
    ("text:h", OdtNodeKind::Heading),
    ("text:list", OdtNodeKind::List),
    ("text:list-item", OdtNodeKind::ListItem),
    ("text:list-header", OdtNodeKind::ListItem),
    ("text:section", OdtNodeKind::Section),
    ("text:table-of-content", OdtNodeKind::Index),
    ("text:illustration-index", OdtNodeKind::Index),
    ("text:table-index", OdtNodeKind::Index),
    ("text:object-index", OdtNodeKind::Index),
    ("text:user-index", OdtNodeKind::Index),
    ("text:alphabetical-index", OdtNodeKind::Index),
    ("text:bibliography", OdtNodeKind::Index),
    ("table:table", OdtNodeKind::Table),
    ("table:table-columns", OdtNodeKind::ColumnGroup),
    ("table:table-header-columns", OdtNodeKind::ColumnGroup),
    ("table:table-column-group", OdtNodeKind::ColumnGroup),
    ("table:table-column", OdtNodeKind::TableColumn),
    ("table:table-header-rows", OdtNodeKind::RowGroup),
    ("table:table-rows", OdtNodeKind::RowGroup),
    ("table:table-row-group", OdtNodeKind::RowGroup),
    ("table:table-row", OdtNodeKind::TableRow),
    ("table:table-cell", OdtNodeKind::TableCell),
    ("table:covered-table-cell", OdtNodeKind::CoveredCell),
    ("draw:frame", OdtNodeKind::Frame),
    ("draw:text-box", OdtNodeKind::TextBox),
    ("draw:image", OdtNodeKind::Image),
    ("draw:object", OdtNodeKind::Object),
    ("draw:object-ole", OdtNodeKind::Object),
    ("draw:rect", OdtNodeKind::Shape),
    ("draw:line", OdtNodeKind::Shape),
    ("draw:polyline", OdtNodeKind::Shape),
    ("draw:polygon", OdtNodeKind::Shape),
    ("draw:regular-polygon", OdtNodeKind::Shape),
    ("draw:path", OdtNodeKind::Shape),
    ("draw:circle", OdtNodeKind::Shape),
    ("draw:ellipse", OdtNodeKind::Shape),
    ("draw:g", OdtNodeKind::Shape),
    ("draw:page-thumbnail", OdtNodeKind::Shape),
    ("draw:connector", OdtNodeKind::Shape),
    ("draw:caption", OdtNodeKind::Shape),
    ("draw:measure", OdtNodeKind::Shape),
    ("draw:control", OdtNodeKind::Shape),
    ("draw:custom-shape", OdtNodeKind::Shape),
    ("dr3d:scene", OdtNodeKind::Shape),
    ("text:bookmark", OdtNodeKind::Bookmark),
    ("text:bookmark-start", OdtNodeKind::BookmarkStart),
    ("text:bookmark-end", OdtNodeKind::BookmarkEnd),
    ("office:annotation", OdtNodeKind::Annotation),
    ("office:annotation-end", OdtNodeKind::AnnotationEnd),
    ("text:note", OdtNodeKind::Note),
];

/// `ODT_NODE_KINDS[name]`. (A name that is a member of `Object.prototype`,
/// `constructor` and the like, answers a function in the TypeScript; it
/// answers `None` here.)
pub fn odt_node_kind(name: &str) -> Option<OdtNodeKind> {
    ODT_NODE_KINDS
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, kind)| *kind)
}

/// `NodeSource`: shared by the nodes of one scan: the source string and its
/// prefix map.
pub struct NodeSource {
    pub xml: Rc<IndexedText>,
    pub prefixes: Rc<PrefixMap>,
}

/// `OdtNode`: one recorded element (or opaque top-level item). Offsets are
/// byte offsets into the decoded content.xml string. Attributes are parsed
/// lazily on first use.
pub struct OdtNode {
    parent: RefCell<Weak<OdtNode>>,
    /// recorded descendants whose nearest recorded ancestor is this node, in document order
    pub children: Vec<Rc<OdtNode>>,
    pub kind: OdtNodeKind,
    /// canonical qualified name (`text:p`), or `#comment` / `#cdata` / `#pi` / `#text` / `#doctype`
    pub name: String,
    /// qualified name as written in the file
    pub tag: String,
    pub start: usize,
    /// one past the start tag's `>` (equals `end` for self-closing and opaque nodes)
    pub open_end: usize,
    /// one past the element name inside the start tag
    pub name_end: usize,
    pub self_closing: bool,
    pub close_start: usize,
    pub end: usize,
    source: Rc<NodeSource>,
    attr_cache: OnceCell<JsObject<String>>,
}

impl OdtNode {
    /// `node.parent`: the nearest recorded ancestor; `None` for top-level blocks.
    pub fn parent(&self) -> Option<Rc<OdtNode>> {
        self.parent.borrow().upgrade()
    }

    /// The node as an `ElementRange`.
    pub fn range(&self) -> ElementRange {
        ElementRange {
            start: self.start,
            open_end: self.open_end,
            close_start: self.close_start,
            end: self.end,
            self_closing: self.self_closing,
        }
    }

    /// The source string every offset of the node indexes.
    pub fn source_xml(&self) -> &Rc<IndexedText> {
        &self.source.xml
    }

    /// The prefix map of the part.
    pub fn prefixes(&self) -> &PrefixMap {
        &self.source.prefixes
    }

    /// `node.attrs`: decoded attribute values keyed by canonical name.
    pub fn attrs(&self) -> &JsObject<String> {
        self.attr_cache.get_or_init(|| {
            if self.kind == OdtNodeKind::Opaque {
                JsObject::new()
            } else {
                attribute_map(
                    &self.source.xml.text,
                    self.name_end,
                    self.open_end,
                    &self.source.prefixes,
                )
            }
        })
    }

    /// `node.attr(name)`: a decoded attribute value by canonical name.
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs().get(name).map(String::as_str)
    }

    /// `node.attrRaw(name)`: the still-escaped attribute value exactly as
    /// written, by canonical name.
    pub fn attr_raw(&self, name: &str) -> Option<String> {
        self.attributes()
            .into_iter()
            .find(|a| self.source.prefixes.canonical(&a.name) == name)
            .map(|a| a.raw)
    }

    /// `node.attributes()`: the start tag's attributes with their source
    /// offsets (for narrow patching).
    pub fn attributes(&self) -> Vec<XmlAttribute> {
        if self.kind == OdtNodeKind::Opaque {
            return Vec::new();
        }
        read_attributes(&self.source.xml.text, self.name_end, self.open_end)
    }
}

/// `OdtBody`
pub struct OdtBody {
    /// the decoded content.xml string every offset refers to
    pub xml: Rc<IndexedText>,
    /// the `office:text` element itself
    pub text: ElementRange,
    /// direct children of `office:text`, in order
    pub blocks: Vec<Rc<OdtNode>>,
    /// tolerated malformed markup (unclosed or stray tags)
    pub warnings: Vec<String>,
    /// namespace prefixes of the part (canonical name lookup)
    pub prefixes: Rc<PrefixMap>,
}

/// A node under construction: the scan fills `close_start`/`end` at close and
/// the tree of `Rc` is made when the walk is over.
struct Pending {
    kind: OdtNodeKind,
    name: String,
    tag: String,
    start: usize,
    open_end: usize,
    name_end: usize,
    self_closing: bool,
    close_start: usize,
    end: usize,
    children: Vec<usize>,
}

struct Scan<'a> {
    xml: &'a str,
    /// start of `office:text` once seen
    text_start: Option<usize>,
    text: Option<ElementRange>,
    pending: Vec<Pending>,
    blocks: Vec<usize>,
    warnings: Vec<String>,
}

impl ElementVisitor for Scan<'_> {
    /// the nearest recorded ancestor (an index of `pending`), `None` for none
    type Data = Option<usize>;

    fn open(
        &mut self,
        el: &mut ElementFrame<Option<usize>>,
        parent: Option<&ElementFrame<Option<usize>>>,
    ) -> OpenVerdict {
        let Some(text_start) = self.text_start else {
            if el.name == "office:text" {
                self.text_start = Some(el.start);
                self.text = Some(ElementRange {
                    start: el.start,
                    open_end: el.open_end,
                    close_start: el.open_end,
                    end: el.open_end,
                    self_closing: el.self_closing,
                });
                return OpenVerdict::Continue;
            }
            // nothing outside the body is recorded here
            return if el.name == "office:automatic-styles" || el.name == "office:font-face-decls" {
                OpenVerdict::Skip
            } else {
                OpenVerdict::Continue
            };
        };
        let parent_is_text = parent.is_some_and(|p| p.start == text_start);
        let owner: Option<usize> = if parent_is_text {
            None
        } else {
            parent.and_then(|p| p.data.flatten())
        };
        let mut kind = odt_node_kind(&el.name);
        if kind.is_none() && parent_is_text {
            kind = Some(OdtNodeKind::Other);
        }
        let Some(kind) = kind else {
            el.data = Some(owner);
            return OpenVerdict::Continue;
        };
        let index = self.pending.len();
        self.pending.push(Pending {
            kind,
            name: el.name.clone(),
            tag: el.tag.clone(),
            start: el.start,
            open_end: el.open_end,
            name_end: el.name_end,
            self_closing: el.self_closing,
            close_start: el.open_end,
            end: el.open_end,
            children: Vec::new(),
        });
        match owner {
            Some(owner) => self.pending[owner].children.push(index),
            None => self.blocks.push(index),
        }
        el.data = Some(Some(index));
        OpenVerdict::Continue
    }

    fn close(
        &mut self,
        el: &mut ElementFrame<Option<usize>>,
        _parent: Option<&ElementFrame<Option<usize>>>,
    ) -> CloseVerdict {
        if self.text_start == Some(el.start) {
            if let Some(text) = self.text.as_mut() {
                text.close_start = el.close_start.unwrap_or(text.close_start);
                text.end = el.end.unwrap_or(text.end);
            }
            return CloseVerdict::Stop;
        }
        if let Some(Some(index)) = el.data {
            let node = &mut self.pending[index];
            if node.start == el.start {
                node.close_start = el.close_start.unwrap_or(node.close_start);
                node.end = el.end.unwrap_or(node.end);
            }
        }
        CloseVerdict::Continue
    }

    fn other(
        &mut self,
        kind: XmlTokenKind,
        start: usize,
        end: usize,
        parent: Option<&ElementFrame<Option<usize>>>,
    ) {
        let Some(text_start) = self.text_start else {
            return;
        };
        if parent.map(|p| p.start) != Some(text_start) {
            return;
        }
        if kind == XmlTokenKind::Text && trim(slice(self.xml, start, end)).is_empty() {
            return;
        }
        let name = match kind {
            XmlTokenKind::Comment => "#comment".to_owned(),
            XmlTokenKind::Cdata => "#cdata".to_owned(),
            XmlTokenKind::Pi => "#pi".to_owned(),
            XmlTokenKind::Doctype => "#doctype".to_owned(),
            XmlTokenKind::Text => "#text".to_owned(),
            other => format!("#{}", other.as_str()),
        };
        let index = self.pending.len();
        self.pending.push(Pending {
            kind: OdtNodeKind::Opaque,
            tag: name.clone(),
            name,
            start,
            open_end: end,
            name_end: start,
            self_closing: false,
            close_start: end,
            end,
            children: Vec::new(),
        });
        self.blocks.push(index);
    }

    fn warn(&mut self, message: &str) {
        self.warnings.push(message.to_owned());
    }
}

/// `scanOdtBody`: builds the position map of content.xml's `office:text`.
/// `Err(corrupt)` when there is no root or no `office:text`.
pub fn scan_odt_body(xml: Rc<IndexedText>) -> Result<OdtBody, OdtError> {
    let Some(root) = read_root(&xml.text) else {
        return Err(OdtError::open(
            OdtOpenErrorCode::Corrupt,
            "odt: content.xml has no root element",
        ));
    };
    let prefixes = root.prefixes;
    let mut scan = Scan {
        xml: &xml.text,
        text_start: None,
        text: None,
        pending: Vec::new(),
        blocks: Vec::new(),
        warnings: Vec::new(),
    };
    let len = xml.text.len();
    walk_elements(&xml.text, &prefixes, &mut scan, 0, len);
    let Scan {
        text,
        pending,
        blocks,
        warnings,
        ..
    } = scan;
    let Some(text) = text else {
        return Err(OdtError::open(
            OdtOpenErrorCode::Corrupt,
            "odt: content.xml has no office:text",
        ));
    };
    let source = Rc::new(NodeSource {
        xml: Rc::clone(&xml),
        prefixes: Rc::clone(&prefixes),
    });
    // children come after their parent in `pending`: built from the back, so
    // each node meets its children already made, with no recursion
    let mut built: Vec<Option<Rc<OdtNode>>> = vec![None; pending.len()];
    for (index, node) in pending.iter().enumerate().rev() {
        let children: Vec<Rc<OdtNode>> = node
            .children
            .iter()
            .map(|&child| {
                built[child]
                    .clone()
                    .expect("a child is built before its parent")
            })
            .collect();
        let rc = Rc::new(OdtNode {
            parent: RefCell::new(Weak::new()),
            children,
            kind: node.kind,
            name: node.name.clone(),
            tag: node.tag.clone(),
            start: node.start,
            open_end: node.open_end,
            name_end: node.name_end,
            self_closing: node.self_closing,
            close_start: node.close_start,
            end: node.end,
            source: Rc::clone(&source),
            attr_cache: OnceCell::new(),
        });
        for child in &rc.children {
            *child.parent.borrow_mut() = Rc::downgrade(&rc);
        }
        built[index] = Some(rc);
    }
    let blocks = blocks
        .into_iter()
        .map(|index| built[index].clone().expect("every block is built"))
        .collect();
    Ok(OdtBody {
        xml,
        text,
        blocks,
        warnings,
        prefixes,
    })
}

/// `sliceNode`: the exact source text of a node.
pub fn slice_node<'a>(xml: &'a str, node: &OdtNode) -> &'a str {
    slice(xml, node.start, node.end)
}

/// `sliceNode` for a bare range.
pub fn slice_range<'a>(xml: &'a str, range: &ElementRange) -> &'a str {
    slice(xml, range.start, range.end)
}

/// `walkNodes`: visits nodes depth first in document order. The visitor
/// answers `false` to skip a node's children.
pub fn walk_nodes(nodes: &[Rc<OdtNode>], mut visit: impl FnMut(&Rc<OdtNode>) -> bool) {
    let mut stack: Vec<&Rc<OdtNode>> = nodes.iter().rev().collect();
    while let Some(node) = stack.pop() {
        if !visit(node) {
            continue;
        }
        for child in node.children.iter().rev() {
            stack.push(child);
        }
    }
}

/// `nodesOfKind`: every node of `kind` at any depth, in document order.
pub fn nodes_of_kind(nodes: &[Rc<OdtNode>], kind: OdtNodeKind) -> Vec<Rc<OdtNode>> {
    let mut out = Vec::new();
    walk_nodes(nodes, |node| {
        if node.kind == kind {
            out.push(Rc::clone(node));
        }
        true
    });
    out
}

/// `anchorType`: `text:anchor-type` of a frame or shape, or `None`.
pub fn anchor_type(node: &OdtNode) -> Option<&str> {
    node.attr("text:anchor-type")
}

/// The result of `cellSpan`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellSpan {
    pub columns: usize,
    pub rows: usize,
}

/// `cellSpan`: column and row span of a cell; 1 when the attribute is
/// missing or invalid. (A span past `usize` saturates.)
pub fn cell_span(node: &OdtNode) -> CellSpan {
    let span = |value: Option<&str>| {
        let n = value.map_or(f64::NAN, |v| parse_int(v, Radix::Ten));
        if n.is_finite() && n > 0.0 {
            n as usize
        } else {
            1
        }
    };
    CellSpan {
        columns: span(node.attr("table:number-columns-spanned")),
        rows: span(node.attr("table:number-rows-spanned")),
    }
}

/// `bookmarkName`: the decoded `text:name` of a bookmark node.
pub fn bookmark_name(node: &OdtNode) -> Option<&str> {
    node.attr("text:name")
}

/// `BookmarkPair`
pub struct BookmarkPair {
    /// decoded bookmark name
    pub name: String,
    /// `text:bookmark-start`, or `None` for a point bookmark or an end without a start
    pub start: Option<Rc<OdtNode>>,
    /// the matching `text:bookmark-end`, or `None` when the file never closes it
    pub end: Option<Rc<OdtNode>>,
    /// a single `text:bookmark` (point)
    pub point: Option<Rc<OdtNode>>,
}

/// `pairBookmarks`: pairs bookmark starts and ends by name in document order.
pub fn pair_bookmarks(body: &OdtBody) -> Vec<BookmarkPair> {
    let mut out: Vec<BookmarkPair> = Vec::new();
    // name -> indexes into `out` of the starts not yet closed
    let mut open: JsMap<Vec<usize>> = JsMap::new();
    walk_nodes(&body.blocks, |node| {
        if !matches!(
            node.kind,
            OdtNodeKind::Bookmark | OdtNodeKind::BookmarkStart | OdtNodeKind::BookmarkEnd
        ) {
            return true;
        }
        let name = bookmark_name(node).unwrap_or("").to_owned();
        match node.kind {
            OdtNodeKind::Bookmark => out.push(BookmarkPair {
                name,
                start: None,
                end: None,
                point: Some(Rc::clone(node)),
            }),
            OdtNodeKind::BookmarkStart => {
                out.push(BookmarkPair {
                    name: name.clone(),
                    start: Some(Rc::clone(node)),
                    end: None,
                    point: None,
                });
                let index = out.len() - 1;
                match open.get_mut(&name) {
                    Some(list) => list.push(index),
                    None => open.set(name, vec![index]),
                }
            }
            _ => match open.get_mut(&name).and_then(Vec::pop) {
                Some(index) => out[index].end = Some(Rc::clone(node)),
                None => out.push(BookmarkPair {
                    name,
                    start: None,
                    end: Some(Rc::clone(node)),
                    point: None,
                }),
            },
        }
        true
    });
    out
}

/// `AnnotationPair`
pub struct AnnotationPair {
    /// decoded `office:name`, or `None` for an annotation without a range
    pub name: Option<String>,
    pub annotation: Rc<OdtNode>,
    /// the matching `office:annotation-end`, if any
    pub end: Option<Rc<OdtNode>>,
}

/// `pairAnnotations`: pairs each `office:annotation` with its
/// `office:annotation-end` by `office:name`.
pub fn pair_annotations(body: &OdtBody) -> Vec<AnnotationPair> {
    let mut out: Vec<AnnotationPair> = Vec::new();
    let mut open: JsMap<usize> = JsMap::new();
    walk_nodes(&body.blocks, |node| {
        if node.kind == OdtNodeKind::Annotation {
            let name = node.attr("office:name").map(str::to_owned);
            out.push(AnnotationPair {
                name: name.clone(),
                annotation: Rc::clone(node),
                end: None,
            });
            if let Some(name) = name {
                open.set(name, out.len() - 1);
            }
            // an annotation's own paragraphs never contain its end marker
            return false;
        }
        if node.kind == OdtNodeKind::AnnotationEnd
            && let Some(index) = node.attr("office:name").and_then(|n| open.get(n))
            && out[*index].end.is_none()
        {
            out[*index].end = Some(Rc::clone(node));
        }
        true
    });
    out
}
