//! `blocks.ts` of `packages/epub-engine`: the block map of one chapter.
//!
//! `openChapter` and `remapChapter` parse the chapter with `parseXml`, which
//! is not ported here: both take the parse side as an [`XmlHost`].

use std::collections::HashMap;

use crate::ranges::{RangeReplacement, map_offset};
use crate::utf16::{is_blank, units};
use crate::xml_positions_types::{
    ElementId, Thrown, XmlAttribute, XmlDocument, XmlElement, XmlHost, XmlNode, XmlParseResult,
    deeper,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    P,
    H1,
    H2,
    H3,
    H4,
    H5,
    H6,
    Li,
    Blockquote,
    Td,
    Th,
    Figcaption,
    Dt,
    Dd,
    Div,
}

impl BlockKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::P => "p",
            Self::H1 => "h1",
            Self::H2 => "h2",
            Self::H3 => "h3",
            Self::H4 => "h4",
            Self::H5 => "h5",
            Self::H6 => "h6",
            Self::Li => "li",
            Self::Blockquote => "blockquote",
            Self::Td => "td",
            Self::Th => "th",
            Self::Figcaption => "figcaption",
            Self::Dt => "dt",
            Self::Dd => "dd",
            Self::Div => "div",
        }
    }

    /// The kind of an element with this local name, if it has one.
    fn of_local(local: &str) -> Option<Self> {
        Some(match local {
            "p" => Self::P,
            "h1" => Self::H1,
            "h2" => Self::H2,
            "h3" => Self::H3,
            "h4" => Self::H4,
            "h5" => Self::H5,
            "h6" => Self::H6,
            "li" => Self::Li,
            "blockquote" => Self::Blockquote,
            "td" => Self::Td,
            "th" => Self::Th,
            "figcaption" => Self::Figcaption,
            "dt" => Self::Dt,
            "dd" => Self::Dd,
            "div" => Self::Div,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChapterBlock {
    /// Engine id, unique in the chapter and stable while the chapter stays open.
    pub id: String,
    /// Tag name without prefix.
    pub kind: BlockKind,
    /// Qualified tag name as written.
    pub tag: String,
    pub attributes: Vec<XmlAttribute>,
    /// p, h1-h6, li, blockquote, div; false for td, th, figcaption, dt, dd.
    pub flowing: bool,
    pub self_closing: bool,
    /// The whole element.
    pub outer: SourceRange,
    /// The content between the tags (empty, at the `/>`, for a self-closing element).
    pub inner: SourceRange,
    /// The element in `OpenChapter::doc`.
    pub element: ElementId,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenChapter {
    pub doc: XmlDocument,
    pub blocks: Vec<ChapterBlock>,
    /// Counter for the next fresh block id.
    pub next_id: usize,
}

impl OpenChapter {
    /// `source` of the TypeScript object: the text its document was parsed from.
    pub fn source(&self) -> &[u16] {
        &self.doc.source
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BrokenChapter {
    pub source: Vec<u16>,
    pub error: String,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChapterMap {
    Open(OpenChapter),
    Broken(BrokenChapter),
}

const FLOWING_KINDS: [&str; 10] = [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "blockquote",
    "div",
];
const STRUCTURAL_KINDS: [&str; 5] = ["td", "th", "figcaption", "dt", "dd"];

/// Elements that make their parent a block container rather than inline content.
const BLOCK_LEVEL: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "body",
    "caption",
    "center",
    "col",
    "colgroup",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hgroup",
    "hr",
    "html",
    "legend",
    "li",
    "main",
    "menu",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
];

/// Inline elements whose content is not text of the block (pictures, formulas,
/// code). They stay one opaque unit: never searched for blocks, never counted
/// as block text, written as an empty placeholder in the notation.
pub const OPAQUE_ELEMENTS: [&str; 5] = ["svg", "math", "script", "style", "template"];

pub fn is_opaque(local: &str) -> bool {
    OPAQUE_ELEMENTS.contains(&local)
}

/// `SKIPPED`: `head` and the opaque elements.
fn is_skipped(local: &str) -> bool {
    local == "head" || is_opaque(local)
}

pub fn is_flowing_kind(kind: &str) -> bool {
    FLOWING_KINDS.contains(&kind)
}

fn is_inline_only(doc: &XmlDocument, id: ElementId, depth: usize) -> Result<bool, Thrown> {
    let depth = deeper(depth)?;
    for child in &doc.element(id).children {
        let XmlNode::Element(child_id) = child else {
            continue;
        };
        let local = doc.element(*child_id).local.as_str();
        if BLOCK_LEVEL.contains(&local) {
            return Ok(false);
        }
        if is_opaque(local) {
            continue;
        }
        if !is_inline_only(doc, *child_id, depth)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn has_text(doc: &XmlDocument, id: ElementId, depth: usize) -> Result<bool, Thrown> {
    let depth = deeper(depth)?;
    for child in &doc.element(id).children {
        let found = match child {
            XmlNode::Text(text) => !is_blank(&text.value),
            XmlNode::Element(child_id) => {
                !is_opaque(&doc.element(*child_id).local) && has_text(doc, *child_id, depth)?
            }
            XmlNode::Other(_) => false,
        };
        if found {
            return Ok(true);
        }
    }
    Ok(false)
}

fn is_block(doc: &XmlDocument, id: ElementId) -> Result<bool, Thrown> {
    let el = doc.element(id);
    if !FLOWING_KINDS.contains(&el.local.as_str()) && !STRUCTURAL_KINDS.contains(&el.local.as_str())
    {
        return Ok(false);
    }
    if !is_inline_only(doc, id, 0)? {
        return Ok(false);
    }
    Ok(el.local != "div" || has_text(doc, id, 0)?)
}

fn collect_block_elements(
    doc: &XmlDocument,
    id: ElementId,
    out: &mut Vec<ElementId>,
    depth: usize,
) -> Result<(), Thrown> {
    let depth = deeper(depth)?;
    if is_skipped(&doc.element(id).local) {
        return Ok(());
    }
    if is_block(doc, id)? {
        out.push(id);
        return Ok(());
    }
    for child in &doc.element(id).children {
        if let XmlNode::Element(child_id) = child {
            collect_block_elements(doc, *child_id, out, depth)?;
        }
    }
    Ok(())
}

fn to_block(doc: &XmlDocument, id: ElementId, block_id: String) -> ChapterBlock {
    let el: &XmlElement = doc.element(id);
    let inner = if el.self_closing {
        SourceRange {
            start: el.end - 2,
            end: el.end - 2,
        }
    } else {
        SourceRange {
            start: el.start_tag_end,
            end: el.end_tag_start,
        }
    };
    ChapterBlock {
        id: block_id,
        // `isBlock` let only the elements of a kind through
        kind: BlockKind::of_local(&el.local).expect("a block element has a kind"),
        tag: el.name.clone(),
        attributes: el.attributes.clone(),
        flowing: FLOWING_KINDS.contains(&el.local.as_str()),
        self_closing: el.self_closing,
        outer: SourceRange {
            start: el.start,
            end: el.end,
        },
        inner,
        element: id,
    }
}

enum Parsed {
    Chapter(XmlDocument, Vec<ElementId>),
    Broken(BrokenChapter),
}

fn parse_blocks(host: &dyn XmlHost, source: &[u16]) -> Result<Parsed, Thrown> {
    match host.parse_xml(source)? {
        XmlParseResult::Err { error, offset } => Ok(Parsed::Broken(BrokenChapter {
            source: source.to_vec(),
            error,
            offset,
        })),
        XmlParseResult::Ok(doc) => {
            let mut elements = Vec::new();
            collect_block_elements(&doc, doc.root, &mut elements, 0)?;
            Ok(Parsed::Chapter(doc, elements))
        }
    }
}

/// Reads a chapter and numbers its blocks `b1`, `b2`, ... in reading order.
pub fn open_chapter(host: &dyn XmlHost, source: &[u16]) -> Result<ChapterMap, Thrown> {
    Ok(match parse_blocks(host, source)? {
        Parsed::Broken(broken) => ChapterMap::Broken(broken),
        Parsed::Chapter(doc, elements) => {
            let blocks: Vec<ChapterBlock> = elements
                .iter()
                .enumerate()
                .map(|(i, &el)| to_block(&doc, el, format!("b{}", i + 1)))
                .collect();
            let next_id = blocks.len() + 1;
            ChapterMap::Open(OpenChapter {
                doc,
                blocks,
                next_id,
            })
        }
    })
}

/// `Map` keys are compared as SameValueZero.
fn map_key(x: f64) -> u64 {
    if x == 0.0 {
        0
    } else if x.is_nan() {
        f64::NAN.to_bits()
    } else {
        x.to_bits()
    }
}

/// Re-reads a chapter after `replacements` (in the coordinates of
/// `previous.source`) turned it into `source`. A block whose start tag offset
/// was not inside a replaced range keeps its id; every other block gets a fresh
/// one.
pub fn remap_chapter(
    host: &dyn XmlHost,
    previous: &OpenChapter,
    source: &[u16],
    replacements: &[RangeReplacement],
) -> Result<ChapterMap, Thrown> {
    let (doc, elements) = match parse_blocks(host, source)? {
        Parsed::Broken(broken) => return Ok(ChapterMap::Broken(broken)),
        Parsed::Chapter(doc, elements) => (doc, elements),
    };
    let mut carried: HashMap<u64, String> = HashMap::new();
    for block in &previous.blocks {
        if let Some(at) = map_offset(block.outer.start as f64, replacements) {
            carried.insert(map_key(at), block.id.clone());
        }
    }
    let mut next_id = previous.next_id;
    let blocks = elements
        .iter()
        .map(|&el| {
            if let Some(id) = carried.remove(&map_key(doc.element(el).start as f64)) {
                return to_block(&doc, el, id);
            }
            let fresh = format!("b{next_id}");
            next_id += 1;
            to_block(&doc, el, fresh)
        })
        .collect();
    Ok(ChapterMap::Open(OpenChapter {
        doc,
        blocks,
        next_id,
    }))
}

pub fn find_block<'a>(map: &'a OpenChapter, id: &[u16]) -> Option<&'a ChapterBlock> {
    map.blocks.iter().find(|b| units(&b.id) == id)
}
