//! `core/convert.ts`: the shared conversion skeleton of the ODT bridge.
//!
//! # How the TypeScript's registry and contexts are laid out here
//!
//! **Handlers.** The five handler kinds are traits of the same names:
//! `BlockConverter`, `InlineConverter`, `RunWriter`, `ParagraphInjector` and
//! `FreeWriter`. Methods are in snake case and take `&self`. A method that
//! throws in the TypeScript returns `Result<_, OdtError>`; the pure
//! predicates (`matches`, `names`, `id`) answer a plain value. An optional
//! method (`absorbs?`, `identify?`) is a trait method whose default answers
//! as the absence does (`false`, `None`). `match` is `matches`.
//!
//! **Registry.** `ConversionRegistry` holds `Vec<Rc<dyn ...>>` of each kind
//! (`add_block(Rc<dyn BlockConverter>)` ...), later registrations first as in
//! the TypeScript. A decorator (the page layer wraps the text converter) is a
//! struct holding the `Rc<dyn BlockConverter>` it wraps.
//!
//! **Contexts.** `OdfToOoxmlContext` and `OoxmlToOdfContext` each hold
//! `doc: Rc<OdtDocument>` and `registry: Rc<ConversionRegistry>`
//! (`OoxmlToOdfContext` also `edited: Rc<ParsedDoc>`), so no lifetime
//! parameter spreads through the layers. A handler gets its context as
//! `&mut`, and what it reads from the document (`&OdtNode`, a style) borrows
//! from `ctx.doc`: **clone the `Rc` out of the context before borrowing**,
//! `let doc = Rc::clone(&ctx.doc);`, and the same for `ctx.registry` before
//! calling a handler with the context (`flow.rs` does so). Nodes are
//! `Rc<OdtNode>` and need no clone of the document.
//!
//! **Offsets.** A `Bridge*` struct is the JSON of the bridge map, so every
//! offset it holds is a `U16` (`crate::offset`); a node, a style or a part
//! string of the engine uses byte offsets (`core/body.rs`). `add_block`
//! converts a node's range for its block (`ctx.doc.content_xml.to_u16`);
//! going back, `ctx.byte(part, u16)` / `rctx.byte(part, u16)` answer the
//! byte offset in the part string. A character offset inside a paragraph
//! text (`BridgeMarker.offset`, the `ParagraphWriteEnv` offsets) is a `U16`
//! of that text on both sides.
//!
//! **`ext`.** A layer keeps its `ext` slot as its own typed struct (serde,
//! fields in the TypeScript's key order). Forward,
//! `ctx.ext_shared::<T>(key, init) -> Rc<RefCell<T>>` (on `&self`) stores the
//! slot in the order keys were first used; `ctx.flush_ext()` / `ctx.take_map()`
//! write the slots into `map.ext` (a `serde_json::Map`, first use first)
//! when the map leaves the context. Save side,
//! `rctx.ext::<T>(key) -> Result<Option<Rc<T>>, OdtError>` reads the slot
//! from the bridge it was given, once, and answers the same `Rc` after. A
//! function that takes a whole `BridgeMap` reads `map.ext[key]` with
//! `serde_json::from_value`.
//!
//! **Scratch.** `ctx.state::<T>()` and `ParagraphWriteEnv.scratch.state::<T>()`
//! are typed per-context scratch (`T: Default`, one per type), the Rust form
//! of a `WeakMap` keyed by the context or the env.
//!
//! Invariants (as in the TypeScript): the `BridgeMap` is plain JSON that
//! crosses between open and save; offsets in it index the decoded part
//! strings of the ORIGINAL ODT; nothing here changes `docx-engine`.

use std::any::{Any, TypeId};
use std::cell::{RefCell, RefMut};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use docx_engine::generate::paragraph::{GenerateContext, generate_paragraph_xml};
use docx_engine::model::{
    Block, BlockList, GeneratedBlock, MapEntries, ParaFormat, ParsedDoc, Run,
};
use jscompat::{JsMap, JsNum, js_regex, truthy};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::body::{OdtNode, OdtNodeKind};
use super::errors::OdtError;
use super::meta::OdtGenerator;
use super::open::OdtDocument;
use super::styles::{OdtStylePart, OdtStyleScope, PerPart};
use super::xml::{
    ElementFrame, ElementRange, ElementVisitor, OpenVerdict, PrefixMap, decode_xml_entities,
    read_root, slice, walk_elements,
};
use crate::offset::{IndexedText, U16};

// ---------------------------------------------------------------------------
// JSON

/// `JsonValue`: a JSON value. Everything stored in the bridge map has this shape.
pub type JsonValue = serde_json::Value;

// ---------------------------------------------------------------------------
// The bridge map

/// `BRIDGE_MAP_VERSION`
pub const BRIDGE_MAP_VERSION: u32 = 1;

/// `BridgeOwner`: which feature module converted a block or paragraph (the
/// `id` of its converter).
pub type BridgeOwner = String;

/// `BridgeBlock`: one ODF block of a flow (a child of `office:text`, or of a
/// container block such as a section).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeBlock {
    /// index in `BridgeMap.blocks`
    pub id: usize,
    /// enclosing container block, or `None` (`null`) for a direct child of `office:text`
    pub parent: Option<usize>,
    /// part whose string `start`/`end` index (the body is always content.xml)
    pub part: OdtStylePart,
    /// canonical element name (`text:p`, `table:table`) or `#comment`/`#text`/... for opaque items
    pub name: String,
    pub kind: OdtNodeKind,
    /// source range of the whole block in the part string
    pub start: U16,
    pub end: U16,
    /// converter id that produced the block's OOXML; `keep` = no OOXML, copied verbatim on save
    pub owner: BridgeOwner,
    /// bridge elements produced directly by this block, in order
    pub elements: Vec<usize>,
    /// nested blocks of a container (section ...), in order
    pub children: Vec<usize>,
    /// owner-specific data (JSON)
    pub data: JsonValue,
}

/// `BridgeElementKind`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BridgeElementKind {
    #[serde(rename = "paragraph")]
    Paragraph,
    #[serde(rename = "table")]
    Table,
    #[serde(rename = "other")]
    Other,
}

/// `BridgeElement`: one top-level body element (`w:p`, `w:tbl` ...) of the bridge docx.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeElement {
    /// index in `BridgeMap.elements` = position among the bridge docx's body elements
    pub id: usize,
    /// the innermost bridge block that produced it
    pub block: usize,
    /// exact OOXML of the element as written into the bridge docx's document.xml
    pub xml: String,
    pub kind: BridgeElementKind,
    /// paragraph record (`BridgeMap.paragraphs`) when the element is a converted paragraph
    pub paragraph: Option<usize>,
}

/// `BridgeMarkerKind`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BridgeMarkerKind {
    /// `text:bookmark-start`
    #[serde(rename = "bookmark-start")]
    BookmarkStart,
    /// `text:bookmark-end`
    #[serde(rename = "bookmark-end")]
    BookmarkEnd,
    /// `text:bookmark`
    #[serde(rename = "bookmark")]
    Bookmark,
    /// an inline element with no OOXML form: re-emitted at its mapped offset
    #[serde(rename = "keep")]
    Keep,
    /// an inline element whose text is shown as plain text; re-emitted verbatim while that text is intact
    #[serde(rename = "text")]
    Text,
    /// an inline element converted by a registered inline converter (`owner`)
    #[serde(rename = "handler")]
    Handler,
}

/// `BridgeMarker`: something inside a paragraph that is not plain formatted
/// text, anchored at a character offset of the paragraph's text.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeMarker {
    pub kind: BridgeMarkerKind,
    /// decoded bookmark name, or the canonical element name for other kinds
    pub name: String,
    /// character offset in `BridgeParagraph.text` where the element sits
    pub offset: U16,
    /// characters of `BridgeParagraph.text` the element produced (`text`/`handler`; 0 otherwise)
    pub length: U16,
    /// source range of the element in the paragraph's part string
    pub start: U16,
    pub end: U16,
    /// index (in this paragraph's `markers`) of the matching start/end bookmark, or `None`
    pub pair: Option<usize>,
    /// a Hancom form field: a `NormalField...` bookmark
    pub field: bool,
    /// converter id for `handler` markers, else `None`
    pub owner: Option<String>,
    /// hidden (`_`-prefixed) OOXML bookmark that marks the position in the bridge docx, or `None`
    /// (written after `owner`: the TypeScript spreads it on last)
    pub ooxml_name: Option<String>,
}

/// `BridgeParagraph['element']`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BridgeParagraphElement {
    #[serde(rename = "text:p")]
    TextP,
    #[serde(rename = "text:h")]
    TextH,
}

/// `BridgeParagraph`: a converted paragraph (`text:p` / `text:h`), wherever it
/// lives (body, list, cell, header).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeParagraph {
    /// index in `BridgeMap.paragraphs`; also the identity bookmark `_odtp<id>` in the bridge docx
    pub id: usize,
    pub part: OdtStylePart,
    /// source range of the `text:p` / `text:h` element
    pub start: U16,
    pub end: U16,
    pub element: BridgeParagraphElement,
    /// decoded `text:style-name`, or `None`
    pub style_name: Option<String>,
    /// the paragraph's text as the docx engine reads it back from the bridge docx (Run texts joined)
    pub text: String,
    pub markers: Vec<BridgeMarker>,
    /// exact `<w:pPr>...</w:pPr>` written for the paragraph (`""` when none)
    #[serde(rename = "pPr")]
    pub p_pr: String,
    /// list membership (body lists) or `None`
    pub list: Option<BridgeListItem>,
    /// converter id that recorded the paragraph
    pub owner: BridgeOwner,
    /// the bridge block that contains the paragraph, or `None` (headers, notes ...)
    pub block: Option<usize>,
}

impl BridgeParagraph {
    /// What fills an id reserved but not yet recorded (see `add_paragraph`).
    fn placeholder(id: usize) -> Self {
        Self {
            id,
            part: OdtStylePart::ContentXml,
            start: U16(0),
            end: U16(0),
            element: BridgeParagraphElement::TextP,
            style_name: None,
            text: String::new(),
            markers: Vec::new(),
            p_pr: String::new(),
            list: None,
            owner: String::new(),
            block: None,
        }
    }
}

/// `BridgeListItem`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeListItem {
    /// `w:numId` of the list instance
    pub num_id: String,
    /// 0-based level (`w:ilvl`)
    pub level: usize,
    /// a `text:list-header` paragraph (no number)
    pub header: bool,
    /// not the first paragraph of its `text:list-item`
    pub continuation: bool,
}

/// `BridgeStyleEntry`: a docx paragraph style written into the bridge docx's styles.xml.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStyleEntry {
    pub style_id: String,
    /// the ODF common paragraph style it mirrors, or `None` for synthetic styles
    pub odf_name: Option<String>,
    /// synthetic heading style (Hancom documents have none), with its level
    pub heading_level: Option<u32>,
    /// exact `<w:style>...</w:style>` written
    pub xml: String,
}

/// `BridgeStyles`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStyles {
    pub paragraph: Vec<BridgeStyleEntry>,
    /// exact `<w:docDefaults>...</w:docDefaults>` written
    pub doc_defaults: String,
    /// family of the ODF `style:default-style` mirrored by docDefaults, or `None`
    pub default_family: Option<String>,
    /// ODF common paragraph style used as parent of brand-new paragraphs, or `None`
    pub base_paragraph_style: Option<String>,
}

/// `BridgeList`: one list instance (`w:num`) of the bridge docx.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeList {
    pub num_id: String,
    pub abstract_num_id: String,
    /// ODF list style name (`text:list-style`), or `None`
    pub style_name: Option<String>,
    /// top-level list blocks that use this instance (continued lists share one)
    pub blocks: Vec<usize>,
}

/// `BridgeMap`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeMap {
    /// always `BRIDGE_MAP_VERSION`
    pub version: u32,
    /// `meta:generator` of the ODT
    pub generator: Option<String>,
    pub blocks: Vec<BridgeBlock>,
    pub elements: Vec<BridgeElement>,
    pub paragraphs: Vec<BridgeParagraph>,
    pub styles: BridgeStyles,
    pub lists: Vec<BridgeList>,
    /// human-readable notes about what was approximated or kept opaque
    pub warnings: Vec<String>,
    /// per-feature data; each feature module owns one key (`table`, `objects`, `page` ...)
    pub ext: serde_json::Map<String, JsonValue>,
}

/// `createBridgeMap` (it reads only `doc.generator`)
pub fn create_bridge_map(generator: &OdtGenerator) -> BridgeMap {
    BridgeMap {
        version: BRIDGE_MAP_VERSION,
        generator: generator.name.clone(),
        blocks: Vec::new(),
        elements: Vec::new(),
        paragraphs: Vec::new(),
        styles: BridgeStyles {
            paragraph: Vec::new(),
            doc_defaults: String::new(),
            default_family: None,
            base_paragraph_style: None,
        },
        lists: Vec::new(),
        warnings: Vec::new(),
        ext: serde_json::Map::new(),
    }
}

/// `paragraphIdentityName`: hidden OOXML bookmark name carrying a paragraph's
/// identity through the editor.
pub fn paragraph_identity_name(id: usize) -> String {
    format!("_odtp{id}")
}

/// `markerBookmarkName`: hidden OOXML bookmark name marking marker `index` of
/// paragraph `id`.
pub fn marker_bookmark_name(id: usize, index: usize) -> String {
    format!("_odtm{id}_{index}")
}

/// `paragraphIdFromBookmarks`: the paragraph id carried by a hidden identity
/// bookmark name (`^_odtp(\d+)$`), or `None`. A number past `usize` is not
/// an id of any paragraph, so it answers `None`.
pub fn paragraph_id_from_bookmarks(names: Option<&[String]>) -> Option<usize> {
    for name in names.unwrap_or_default() {
        let Some(digits) = name.strip_prefix("_odtp") else {
            continue;
        };
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        return digits.parse::<usize>().ok();
    }
    None
}

// ---------------------------------------------------------------------------
// Part helpers shared by both directions

/// `OdtPartInfo`
pub struct OdtPartInfo {
    pub part: OdtStylePart,
    /// the decoded part string every offset indexes (byte offsets inside the engine)
    pub xml: Rc<IndexedText>,
    pub prefixes: Rc<PrefixMap>,
    /// `style:font-face` name to font family (quotes removed)
    pub font_faces: JsMap<String>,
    /// automatic styles of this part are visible from this scope
    pub scope: OdtStyleScope,
}

struct FontFaces<'a> {
    xml: &'a str,
    prefixes: &'a PrefixMap,
    out: JsMap<String>,
}

impl ElementVisitor for FontFaces<'_> {
    type Data = ();

    fn open(
        &mut self,
        el: &mut ElementFrame<()>,
        _parent: Option<&ElementFrame<()>>,
    ) -> OpenVerdict {
        if el.name == "office:body" || el.name == "office:master-styles" {
            return OpenVerdict::Stop;
        }
        if el.name != "style:font-face" {
            return OpenVerdict::Continue;
        }
        let mut name: Option<String> = None;
        let mut family: Option<String> = None;
        let attrs = slice(self.xml, el.name_end, el.open_end);
        for m in js_regex!(r#"([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')"#).find_iter(attrs) {
            let key = self.prefixes.canonical(m.get(1).unwrap_or(""));
            let value = decode_xml_entities(m.get(3).or_else(|| m.get(4)).unwrap_or(""));
            if key == "style:name" {
                name = Some(value);
            } else if key == "svg:font-family" {
                family = Some(value);
            }
        }
        if let Some(name) = name {
            let family = unquote_family(family.as_deref().unwrap_or(&name));
            self.out.set(name, family);
        }
        OpenVerdict::Continue
    }
}

/// `readFontFaces`
fn read_font_faces(xml: &str, prefixes: &PrefixMap) -> JsMap<String> {
    let mut visitor = FontFaces {
        xml,
        prefixes,
        out: JsMap::new(),
    };
    walk_elements(xml, prefixes, &mut visitor, 0, xml.len());
    visitor.out
}

/// `unquoteFamily`: `'Malgun Gothic'` is `Malgun Gothic`.
pub fn unquote_family(family: &str) -> String {
    let t = jscompat::trim(family);
    let mut chars = t.chars();
    if let (Some(first), Some(last)) = (chars.next(), t.chars().next_back()) {
        if t.chars().count() >= 2 && (first == '\'' || first == '"') && last == first {
            return t[first.len_utf8()..t.len() - last.len_utf8()].to_owned();
        }
    }
    t.to_owned()
}

/// `PartCache`
struct PartCache {
    doc: Rc<OdtDocument>,
    cache: RefCell<HashMap<OdtStylePart, Rc<OdtPartInfo>>>,
}

impl PartCache {
    fn new(doc: Rc<OdtDocument>) -> Self {
        Self {
            doc,
            cache: RefCell::new(HashMap::new()),
        }
    }

    fn get(&self, part: OdtStylePart) -> Rc<OdtPartInfo> {
        if let Some(info) = self.cache.borrow().get(&part) {
            return Rc::clone(info);
        }
        let xml: Rc<IndexedText> = match part {
            OdtStylePart::ContentXml => Rc::clone(&self.doc.content_xml),
            OdtStylePart::StylesXml => match &self.doc.styles_xml {
                Some(xml) => Rc::clone(xml),
                None => Rc::new(IndexedText::new(String::new())),
            },
        };
        let prefixes = match part {
            OdtStylePart::ContentXml => Rc::clone(&self.doc.body.prefixes),
            OdtStylePart::StylesXml => read_root(&xml.text)
                .map(|root| root.prefixes)
                .unwrap_or_else(|| Rc::new(PrefixMap::new())),
        };
        let info = Rc::new(OdtPartInfo {
            part,
            font_faces: read_font_faces(&xml.text, &prefixes),
            scope: part.scope(),
            xml,
            prefixes,
        });
        self.cache.borrow_mut().insert(part, Rc::clone(&info));
        info
    }
}

/// Typed per-context scratch: one value per type, made with `Default` on
/// first use. The Rust form of a `WeakMap` keyed by a context or an env.
#[derive(Default)]
pub struct Scratch {
    slots: RefCell<HashMap<TypeId, Box<dyn Any>>>,
}

impl Scratch {
    /// The scratch value of type `T`.
    pub fn state<T: Default + 'static>(&self) -> RefMut<'_, T> {
        let mut slots = self.slots.borrow_mut();
        slots
            .entry(TypeId::of::<T>())
            .or_insert_with(|| Box::new(T::default()));
        RefMut::map(slots, |slots| {
            slots
                .get_mut(&TypeId::of::<T>())
                .and_then(|slot| slot.downcast_mut::<T>())
                .expect("a scratch slot holds the type it is keyed by")
        })
    }
}

// ---------------------------------------------------------------------------
// The registry

/// `BlockEnv`: where a block is being converted (forward).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockEnv {
    /// id of the bridge block created for the node (already in `ctx.map.blocks`)
    pub block_id: usize,
    /// enclosing container block, or `None`
    pub parent: Option<usize>,
}

/// `BlockOoxml['elements'][number]`
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BlockOoxmlElement {
    pub xml: String,
    /// `None` is `'other'`
    pub kind: Option<BridgeElementKind>,
    /// `None` is `null`
    pub paragraph: Option<usize>,
}

/// `BlockOoxml`
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BlockOoxml {
    /// top-level OOXML body elements, in order (may be empty: then the block is carried verbatim)
    pub elements: Vec<BlockOoxmlElement>,
    /// owner-specific data stored in `BridgeBlock.data` (`None` leaves it `null`)
    pub data: Option<JsonValue>,
}

/// `EditedItem`: one body element of the EDITED docx.
#[derive(Clone, Debug, PartialEq)]
pub struct EditedItem {
    /// index of the element among the edited docx's body elements (`-1` when unknown)
    pub index: i64,
    /// exact OOXML of the element in the edited docx (`Block.originalXml`)
    pub xml: String,
    /// engine blocks parsed from the element (usually exactly one)
    pub blocks: Vec<Block>,
}

/// An edited element as the TypeScript shares it: `editedItems` pushes more
/// blocks onto the item it returned, and the reverse writers mutate it.
pub type ItemRef = Rc<RefCell<EditedItem>>;

/// `AlignedItem`: an edited element aligned with the bridge.
#[derive(Clone, Debug)]
pub struct AlignedItem {
    pub item: ItemRef,
    /// the bridge element (an index of `map.elements`) this edited element
    /// continues, or `None` for a new element
    pub element: Option<usize>,
    /// the edited XML is identical to the bridge element's XML
    pub unchanged: bool,
}

/// `FlowEnv`: where blocks are being written back (reverse).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FlowEnv {
    /// container block whose children are rebuilt, or `None` for `office:text`
    pub parent: Option<usize>,
    /// For free writers: the nearest edited elements before and after the new
    /// ones that continue bridge elements (style templates for new content),
    /// as indexes of `map.elements`.
    pub neighbours: Option<Neighbours>,
}

/// `FlowEnv['neighbours']`
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Neighbours {
    pub before: Option<usize>,
    pub after: Option<usize>,
}

/// `BlockConverter`: converts one kind of ODF block both ways. The flow
/// walkers pick the newest registered converter whose `matches` accepts the
/// node, so later registrations override earlier ones.
pub trait BlockConverter {
    /// stable owner id recorded in the map (`text`, `table`, `objects`, `page` ...)
    fn id(&self) -> &str;

    /// `match(node, ctx)`
    fn matches(&self, node: &OdtNode, ctx: &OdfToOoxmlContext) -> bool;

    /// `toOoxml(ctx, node, env)`
    fn to_ooxml(
        &self,
        ctx: &mut OdfToOoxmlContext,
        node: &Rc<OdtNode>,
        env: &BlockEnv,
    ) -> Result<BlockOoxml, OdtError>;

    /// `toOdf(rctx, block, items, env)`: the ODF for a block whose edited
    /// elements are not an unchanged, complete, in-order copy of its bridge
    /// elements. Returns ODF XML that replaces the block's source range.
    fn to_odf(
        &self,
        rctx: &mut OoxmlToOdfContext,
        block: &BridgeBlock,
        items: &[AlignedItem],
        env: &FlowEnv,
    ) -> Result<String, OdtError>;

    /// `absorbs?`: whether a NEW edited element directly after (or before)
    /// this block's elements continues the block. Absent: `false`.
    fn absorbs(
        &self,
        _rctx: &mut OoxmlToOdfContext,
        _block: &BridgeBlock,
        _item: &EditedItem,
    ) -> Result<bool, OdtError> {
        Ok(false)
    }

    /// `identify?`: claim a changed edited element that has no exact XML
    /// match as one of this owner's bridge elements (`candidates` are the
    /// unclaimed bridge elements of this owner between the neighbouring
    /// matched elements). Returns a bridge element id or `None` (also when
    /// the method is absent).
    fn identify(
        &self,
        _rctx: &mut OoxmlToOdfContext,
        _item: &EditedItem,
        _candidates: &[BridgeElement],
    ) -> Result<Option<usize>, OdtError> {
        Ok(None)
    }

    /// Whether `identify` is present (`converter.identify` is truthy). `flow.rs`
    /// skips a converter without it.
    fn has_identify(&self) -> bool {
        false
    }
}

/// `InlineElement`: an inline element met while walking a paragraph (forward).
/// Offsets are byte offsets into `xml`.
#[derive(Clone)]
pub struct InlineElement {
    pub start: usize,
    pub open_end: usize,
    pub close_start: usize,
    pub end: usize,
    pub self_closing: bool,
    /// canonical name
    pub name: String,
    /// name as written
    pub tag: String,
    /// one past the name inside the start tag
    pub name_end: usize,
    pub part: OdtStylePart,
    /// the part string the offsets index
    pub xml: Rc<IndexedText>,
}

impl InlineElement {
    pub fn range(&self) -> ElementRange {
        ElementRange {
            start: self.start,
            open_end: self.open_end,
            close_start: self.close_start,
            end: self.end,
            self_closing: self.self_closing,
        }
    }
}

/// `InlineEnv`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InlineEnv {
    /// paragraph record being built (its id; the record is pushed when the paragraph finishes)
    pub paragraph_id: usize,
    /// character offset in the paragraph text where the element sits
    pub offset: U16,
}

/// `InlineOoxml`
#[derive(Clone, Debug)]
pub enum InlineOoxml {
    /// Raw OOXML spliced into the paragraph at the element's position. `text`
    /// is exactly what the docx engine reads back from it as run text.
    Xml { xml: String, text: String },
    /// Engine runs inserted at the position (formatted by the generator).
    Runs { runs: Vec<Run> },
    /// The safe default: no OOXML; the element is re-emitted at its mapped offset on save.
    Keep,
}

/// `InlineConverter`
pub trait InlineConverter {
    fn id(&self) -> &str;

    /// canonical element names taken (`draw:frame`, `text:note`, `office:annotation` ...)
    fn names(&self) -> &[&str];

    /// `toOoxml(ctx, el, env)`: `None` is the safe default for the element.
    fn to_ooxml(
        &self,
        ctx: &mut OdfToOoxmlContext,
        el: &InlineElement,
        env: &InlineEnv,
    ) -> Result<Option<InlineOoxml>, OdtError>;
}

/// `EditedParagraph['type']`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditedParagraphType {
    Paragraph,
    Heading,
    ListItem,
}

/// `EditedParagraph`: a paragraph of the edited docx, as the reverse paragraph writer takes it.
#[derive(Clone, Debug)]
pub struct EditedParagraph {
    pub r#type: EditedParagraphType,
    pub runs: Vec<Run>,
    pub format: Option<ParaFormat>,
    pub style_id: Option<String>,
    pub level: Option<JsNum>,
    pub outline_only: Option<bool>,
    pub list: Option<BlockList>,
    /// exact `<w:pPr>` of the edited paragraph when known (equal to the bridge's: format untouched)
    pub raw_p_pr: Option<String>,
    pub hidden_bookmarks: Option<Vec<String>>,
}

/// `ParagraphWriteEnv.mapOffset`'s `bias`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MapBias {
    /// start of the change
    Start,
    /// end of the change
    End,
}

/// `ParagraphWriteEnv`
pub struct ParagraphWriteEnv<'a> {
    /// the original paragraph this one continues, or `None`
    pub origin: Option<BridgeParagraph>,
    pub part: OdtStylePart,
    /// the edited paragraph's text (Run texts joined)
    pub text: String,
    /// `mapOffset(offset, bias)`: maps a character offset of the ORIGINAL
    /// paragraph text onto the edited text (common prefix/suffix). `bias`
    /// decides offsets inside the changed region: `Start` is the start of
    /// the change, `End` its end. Offsets are `U16` of the texts.
    pub map_offset: Box<dyn Fn(U16, MapBias) -> U16 + 'a>,
    /// typed scratch of this env
    pub scratch: Scratch,
}

impl ParagraphWriteEnv<'_> {
    /// `env.mapOffset(offset, bias)`
    pub fn map_offset(&self, offset: U16, bias: MapBias) -> U16 {
        (self.map_offset)(offset, bias)
    }

    /// The scratch value of type `T` of this env.
    pub fn state<T: Default + 'static>(&self) -> RefMut<'_, T> {
        self.scratch.state::<T>()
    }
}

/// `RunWriter`: writes an atomic edited run (picture, note reference ...) as
/// ODF; its text is not emitted.
pub trait RunWriter {
    fn id(&self) -> &str;
    fn matches(&self, run: &Run) -> bool;
    fn to_odf(
        &self,
        rctx: &mut OoxmlToOdfContext,
        run: &Run,
        env: &ParagraphWriteEnv<'_>,
    ) -> Result<String, OdtError>;
}

/// `ParagraphInjector`'s `attach`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attach {
    Prev,
    Next,
}

/// One result of `ParagraphInjector.inject`: `{ offset, xml, attach? }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Injection {
    /// character offset in the edited paragraph's text
    pub offset: U16,
    pub xml: String,
    pub attach: Option<Attach>,
}

/// `ParagraphInjector`: injects raw ODF at offsets of an edited paragraph
/// (comment anchors ...).
pub trait ParagraphInjector {
    fn id(&self) -> &str;
    fn inject(
        &self,
        rctx: &mut OoxmlToOdfContext,
        para: &EditedParagraph,
        env: &ParagraphWriteEnv<'_>,
    ) -> Result<Vec<Injection>, OdtError>;
}

/// `FreeWriter`: writes consecutive NEW edited elements (no bridge origin)
/// that this writer matches.
pub trait FreeWriter {
    fn id(&self) -> &str;
    fn matches(&self, item: &EditedItem) -> bool;
    fn to_odf(
        &self,
        rctx: &mut OoxmlToOdfContext,
        items: &[ItemRef],
        env: &FlowEnv,
    ) -> Result<String, OdtError>;
}

/// `ConversionRegistry`
#[derive(Default)]
pub struct ConversionRegistry {
    pub blocks: Vec<Rc<dyn BlockConverter>>,
    pub inline: Vec<Rc<dyn InlineConverter>>,
    pub run_writers: Vec<Rc<dyn RunWriter>>,
    pub injectors: Vec<Rc<dyn ParagraphInjector>>,
    pub free_writers: Vec<Rc<dyn FreeWriter>>,
}

impl ConversionRegistry {
    /// `new ConversionRegistry()`
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_block(&mut self, converter: Rc<dyn BlockConverter>) -> &mut Self {
        self.blocks.push(converter);
        self
    }

    pub fn add_inline(&mut self, converter: Rc<dyn InlineConverter>) -> &mut Self {
        self.inline.push(converter);
        self
    }

    pub fn add_run_writer(&mut self, writer: Rc<dyn RunWriter>) -> &mut Self {
        self.run_writers.push(writer);
        self
    }

    pub fn add_injector(&mut self, injector: Rc<dyn ParagraphInjector>) -> &mut Self {
        self.injectors.push(injector);
        self
    }

    pub fn add_free_writer(&mut self, writer: Rc<dyn FreeWriter>) -> &mut Self {
        self.free_writers.push(writer);
        self
    }

    /// `blockFor`: the newest block converter accepting the node.
    pub fn block_for(
        &self,
        node: &OdtNode,
        ctx: &OdfToOoxmlContext,
    ) -> Option<Rc<dyn BlockConverter>> {
        self.blocks
            .iter()
            .rev()
            .find(|converter| converter.matches(node, ctx))
            .cloned()
    }

    /// `blockById`
    pub fn block_by_id(&self, id: &str) -> Option<Rc<dyn BlockConverter>> {
        self.blocks
            .iter()
            .rev()
            .find(|converter| converter.id() == id)
            .cloned()
    }

    /// `inlineFor`: the inline converters taking `name`, newest first.
    pub fn inline_for(&self, name: &str) -> Vec<Rc<dyn InlineConverter>> {
        let mut found: Vec<Rc<dyn InlineConverter>> = self
            .inline
            .iter()
            .filter(|converter| converter.names().contains(&name))
            .cloned()
            .collect();
        found.reverse();
        found
    }

    /// `runWriterFor`
    pub fn run_writer_for(&self, run: &Run) -> Option<Rc<dyn RunWriter>> {
        self.run_writers
            .iter()
            .rev()
            .find(|writer| writer.matches(run))
            .cloned()
    }

    /// `freeWriterFor`
    pub fn free_writer_for(&self, item: &EditedItem) -> Option<Rc<dyn FreeWriter>> {
        self.free_writers
            .iter()
            .rev()
            .find(|writer| writer.matches(item))
            .cloned()
    }
}

// ---------------------------------------------------------------------------
// ODF to OOXML

/// `DocxRelationship`
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocxRelationship {
    pub id: String,
    pub r#type: String,
    pub target: String,
    pub external: bool,
}

/// `DocxExtraPart['data']`: `string | Uint8Array`
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DocxPartData {
    Text(String),
    Bytes(Vec<u8>),
}

/// `DocxExtraPart`: a part added to the bridge docx besides
/// document/styles/numbering (headers, comments ...).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocxExtraPart {
    /// zip path, e.g. `word/header1.xml`
    pub path: String,
    pub data: DocxPartData,
    /// content type override (`None` for media covered by a Default extension)
    pub content_type: Option<String>,
}

/// `DocxAccumulator`: everything the bridge docx is assembled from (see
/// `build_bridge_docx`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DocxAccumulator {
    /// `<w:style>` elements, in order
    pub styles: Vec<String>,
    /// `<w:docDefaults>...</w:docDefaults>` (`""`: an empty one)
    pub doc_defaults: String,
    /// `<w:abstractNum>` elements
    pub abstract_nums: Vec<String>,
    /// `<w:num>` elements
    pub nums: Vec<String>,
    /// relationships of word/document.xml (styles/numbering are added automatically)
    pub relationships: Vec<DocxRelationship>,
    /// other parts (media, headers, footers, notes, comments)
    pub parts: Vec<DocxExtraPart>,
    /// the body's final `<w:sectPr>`; `None`: derived from the default page layout
    pub sect_pr: Option<String>,
    /// extra namespace declarations for the `w:document` root (`xmlns:x="..."`)
    pub namespaces: Vec<String>,
}

const HYPERLINK_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

/// One typed `ext` slot of an `OdfToOoxmlContext`.
struct ExtSlot {
    key: String,
    /// an `Rc<RefCell<T>>`
    value: Rc<dyn Any>,
    to_json: fn(&dyn Any) -> Result<JsonValue, serde_json::Error>,
}

fn slot_to_json<T: Serialize + 'static>(value: &dyn Any) -> Result<JsonValue, serde_json::Error> {
    serde_json::to_value(
        &*value
            .downcast_ref::<RefCell<T>>()
            .expect("a slot holds its own type")
            .borrow(),
    )
}

/// `addRelationship`/`addHyperlink` over the parts of the accumulator the
/// generator closure borrows.
fn add_relationship(
    relationships: &mut Vec<DocxRelationship>,
    rel_seq: &mut usize,
    r#type: &str,
    target: &str,
    external: bool,
) -> String {
    *rel_seq += 1;
    let id = format!("rId{rel_seq}");
    relationships.push(DocxRelationship {
        id: id.clone(),
        r#type: r#type.to_owned(),
        target: target.to_owned(),
        external,
    });
    id
}

fn add_hyperlink(
    relationships: &mut Vec<DocxRelationship>,
    rel_seq: &mut usize,
    href: &str,
) -> String {
    if let Some(found) = relationships
        .iter()
        .find(|r| r.external && r.r#type == HYPERLINK_REL && r.target == href)
    {
        return found.id.clone();
    }
    add_relationship(relationships, rel_seq, HYPERLINK_REL, href, true)
}

/// `OdfToOoxmlContext`: state of one ODF to OOXML conversion. Feature modules
/// write their output into `docx` and their records into `map`; nothing here
/// is serialised except `map` (and the `ext` slots written into it).
pub struct OdfToOoxmlContext {
    pub doc: Rc<OdtDocument>,
    pub registry: Rc<ConversionRegistry>,
    pub map: BridgeMap,
    pub docx: DocxAccumulator,
    /// `ctx.generate.headingStyleIds`: heading level to docx style id
    pub heading_style_ids: MapEntries<JsNum, String>,
    /// typed scratch of the context
    pub scratch: Scratch,
    parts: PartCache,
    bookmark_seq: u64,
    /// relationship ids 1 and 2 are reserved for styles and numbering
    rel_seq: usize,
    paragraph_seq: usize,
    ext_slots: RefCell<Vec<ExtSlot>>,
}

impl OdfToOoxmlContext {
    /// `new OdfToOoxmlContext(doc, registry)`
    pub fn new(doc: Rc<OdtDocument>, registry: Rc<ConversionRegistry>) -> Self {
        Self {
            map: create_bridge_map(&doc.generator),
            parts: PartCache::new(Rc::clone(&doc)),
            doc,
            registry,
            docx: DocxAccumulator::default(),
            heading_style_ids: MapEntries::default(),
            scratch: Scratch::default(),
            bookmark_seq: 0,
            rel_seq: 2,
            paragraph_seq: 0,
            ext_slots: RefCell::new(Vec::new()),
        }
    }

    /// `ctx.generate` for `generateParagraphXml`: the paragraph XML of `block`
    /// with the context's hyperlink and bookmark allocators wired in.
    pub fn generate_paragraph_xml(&mut self, block: &GeneratedBlock) -> Result<String, OdtError> {
        let mut allocate_rel =
            |href: &str| add_hyperlink(&mut self.docx.relationships, &mut self.rel_seq, href);
        let mut allocate_bookmark = |_name: &str| {
            self.bookmark_seq += 1;
            self.bookmark_seq as f64
        };
        let mut generate = GenerateContext {
            heading_style_ids: &self.heading_style_ids,
            list_paragraph_style_id: None,
            allocate_hyperlink_rel: &mut allocate_rel,
            allocate_bookmark_id: Some(&mut allocate_bookmark),
            allocate_revision_id: None,
            part: None,
        };
        generate_paragraph_xml(block, &mut generate).map_err(OdtError::Thrown)
    }

    /// `part(part)`
    pub fn part(&self, part: OdtStylePart) -> Rc<OdtPartInfo> {
        self.parts.get(part)
    }

    /// The byte offset in the part string of a `U16` offset a bridge record holds.
    pub fn byte(&self, part: OdtStylePart, at: U16) -> usize {
        self.parts.get(part).xml.to_byte(at)
    }

    /// The typed scratch value of this context.
    pub fn state<T: Default + 'static>(&self) -> RefMut<'_, T> {
        self.scratch.state::<T>()
    }

    /// `allocateBookmarkId`
    pub fn allocate_bookmark_id(&mut self) -> u64 {
        self.bookmark_seq += 1;
        self.bookmark_seq
    }

    /// `addRelationship`: adds a relationship of word/document.xml and returns its id.
    pub fn add_relationship(&mut self, r#type: &str, target: &str, external: bool) -> String {
        add_relationship(
            &mut self.docx.relationships,
            &mut self.rel_seq,
            r#type,
            target,
            external,
        )
    }

    /// `addHyperlink`: relationship id for an external hyperlink target (one per target).
    pub fn add_hyperlink(&mut self, href: &str) -> String {
        add_hyperlink(&mut self.docx.relationships, &mut self.rel_seq, href)
    }

    /// `addBlock`: records a bridge block (before its converter runs, so
    /// nested blocks can point at it). Returns the block id, an index of
    /// `map.blocks`.
    pub fn add_block(&mut self, node: &OdtNode, parent: Option<usize>, owner: &str) -> usize {
        let id = self.map.blocks.len();
        let xml = &self.doc.content_xml;
        let block = BridgeBlock {
            id,
            parent,
            part: OdtStylePart::ContentXml,
            name: node.name.clone(),
            kind: node.kind,
            start: xml.to_u16(node.start),
            end: xml.to_u16(node.end),
            owner: owner.to_owned(),
            elements: Vec::new(),
            children: Vec::new(),
            data: JsonValue::Null,
        };
        self.map.blocks.push(block);
        if let Some(parent) = parent {
            self.map.blocks[parent].children.push(id);
        }
        id
    }

    /// `addElement`: records a top-level body element of the bridge docx
    /// (`kind` defaults to `Other`, `paragraph` to `None`). Returns its id.
    pub fn add_element(
        &mut self,
        block_id: usize,
        xml: &str,
        kind: Option<BridgeElementKind>,
        paragraph: Option<usize>,
    ) -> usize {
        let id = self.map.elements.len();
        self.map.elements.push(BridgeElement {
            id,
            block: block_id,
            xml: xml.to_owned(),
            kind: kind.unwrap_or(BridgeElementKind::Other),
            paragraph,
        });
        self.map.blocks[block_id].elements.push(id);
        id
    }

    /// `reserveParagraphId`: reserves a paragraph id. Ids are reserved when a
    /// paragraph starts (nested paragraphs, e.g. note bodies, may finish
    /// first) and every reserved id must be filled with `add_paragraph`.
    pub fn reserve_paragraph_id(&mut self) -> usize {
        let id = self.paragraph_seq;
        self.paragraph_seq += 1;
        id
    }

    /// `addParagraph`: stores a paragraph record under its reserved id.
    pub fn add_paragraph(&mut self, record: BridgeParagraph) {
        let id = record.id;
        while self.map.paragraphs.len() <= id {
            let next = self.map.paragraphs.len();
            self.map.paragraphs.push(BridgeParagraph::placeholder(next));
        }
        self.map.paragraphs[id] = record;
    }

    /// `warn`
    pub fn warn(&mut self, message: &str) {
        if !self.map.warnings.iter().any(|w| w == message) {
            self.map.warnings.push(message.to_owned());
        }
    }

    /// `ext(key, init)`: the typed slot of a feature module, created on first
    /// use (`&self`, so a `matches` handler can create it too). The slot is
    /// shared: `borrow_mut()` to change it. Slots are written into `map.ext`
    /// in the order their keys were first used.
    pub fn ext_shared<T: Serialize + 'static>(
        &self,
        key: &str,
        init: impl FnOnce() -> T,
    ) -> Rc<RefCell<T>> {
        let found = self
            .ext_slots
            .borrow()
            .iter()
            .find(|slot| slot.key == key)
            .map(|slot| Rc::clone(&slot.value));
        if let Some(found) = found {
            return found
                .downcast::<RefCell<T>>()
                .unwrap_or_else(|_| panic!("ext slot {key} is read as the type it was made with"));
        }
        let value = Rc::new(RefCell::new(init()));
        self.ext_slots.borrow_mut().push(ExtSlot {
            key: key.to_owned(),
            value: Rc::clone(&value) as Rc<dyn Any>,
            to_json: slot_to_json::<T>,
        });
        value
    }

    /// Writes every `ext` slot into `map.ext`, in the order keys were first
    /// used. Idempotent; `take_map` calls it.
    pub fn flush_ext(&mut self) -> Result<(), OdtError> {
        for slot in self.ext_slots.borrow().iter() {
            let value =
                (slot.to_json)(slot.value.as_ref()).map_err(|e| OdtError::thrown(e.to_string()))?;
            self.map.ext.insert(slot.key.clone(), value);
        }
        Ok(())
    }

    /// The bridge map as it leaves the context: the `ext` slots written into
    /// it. Call after `build_bridge_docx` (which reads `map.elements`); the
    /// context's own map is left empty.
    pub fn take_map(&mut self) -> Result<BridgeMap, OdtError> {
        self.flush_ext()?;
        let empty = create_bridge_map(&self.doc.generator);
        Ok(std::mem::replace(&mut self.map, empty))
    }
}

// ---------------------------------------------------------------------------
// OOXML to ODF

/// `TextPatch`: a replacement of `[start, end)` of a part string (an
/// insertion when `start == end`). Offsets are byte offsets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextPatch {
    pub part: OdtStylePart,
    pub start: usize,
    pub end: usize,
    pub xml: String,
}

/// `applyTextPatches`, answering the start of the overlapping patch as the
/// error. Used by `apply_text_patches` and by a caller that words the error
/// with offsets of its own kind.
pub fn apply_text_patches_checked(text: &str, patches: &[TextPatch]) -> Result<String, usize> {
    if patches.is_empty() {
        return Ok(text.to_owned());
    }
    let mut sorted: Vec<&TextPatch> = patches.iter().collect();
    // stable: insertions at the same offset keep their order
    sorted.sort_by(|a, b| a.start.cmp(&b.start).then(a.end.cmp(&b.end)));
    let mut out = String::new();
    let mut at = 0usize;
    for p in sorted {
        if p.start < at {
            return Err(p.start);
        }
        out.push_str(slice(text, at, p.start));
        out.push_str(&p.xml);
        at = p.end;
    }
    out.push_str(slice(text, at, text.len()));
    Ok(out)
}

/// `applyTextPatches`: applies non-overlapping patches to `text`. Insertions
/// at the same offset keep their order. Throws on overlapping replacements.
pub fn apply_text_patches(text: &str, patches: &[TextPatch]) -> Result<String, OdtError> {
    apply_text_patches_checked(text, patches)
        .map_err(|start| OdtError::thrown(format!("odt: overlapping patches at {start}")))
}

/// `OUTPUT_NAMESPACES`: the standard namespace URIs for the prefixes written into new ODF markup.
fn output_namespace(prefix: &str) -> Option<&'static str> {
    Some(match prefix {
        "office" => "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
        "style" => "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
        "text" => "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
        "table" => "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
        "draw" => "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
        "fo" => "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
        "svg" => "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
        "xlink" => "http://www.w3.org/1999/xlink",
        _ => return None,
    })
}

/// `OoxmlToOdfOptions`
#[derive(Clone, Debug, Default)]
pub struct OoxmlToOdfOptions {
    /// raw word/styles.xml of the edited docx (style and default-font edits)
    pub edited_styles_xml: Option<String>,
}

/// `OoxmlToOdfContext`: state of one OOXML to ODF write-back into the
/// original ODT. Converters add narrow patches (`patch`) and new automatic
/// styles (`add_automatic_style`); `finish()` returns all patches per part,
/// ready for `apply_text_patches`.
pub struct OoxmlToOdfContext {
    pub doc: Rc<OdtDocument>,
    pub map: BridgeMap,
    pub edited: Rc<ParsedDoc>,
    pub registry: Rc<ConversionRegistry>,
    pub options: OoxmlToOdfOptions,
    pub patches: Vec<TextPatch>,
    /// bridge elements some edited element continues (filled by `align_items`); the rest were deleted
    pub matched: HashSet<usize>,
    pub warnings: Vec<String>,
    /// typed scratch of the context
    pub scratch: Scratch,
    parts: PartCache,
    used_names: HashSet<String>,
    new_styles: PerPart<Vec<String>>,
    new_fonts: PerPart<JsMap<String>>,
    /// dedup cache for derived styles: key to name
    derived: JsMap<String>,
    used_prefixes: PerPart<JsMap<()>>,
    ext_cache: RefCell<JsMap<Rc<dyn Any>>>,
}

impl OoxmlToOdfContext {
    /// `new OoxmlToOdfContext(doc, map, edited, registry, options)`
    pub fn new(
        doc: Rc<OdtDocument>,
        map: BridgeMap,
        edited: Rc<ParsedDoc>,
        registry: Rc<ConversionRegistry>,
        options: OoxmlToOdfOptions,
    ) -> Self {
        let mut used_names = HashSet::new();
        for s in &doc.styles.all {
            if !s.name.is_empty() {
                used_names.insert(s.name.clone());
            }
        }
        for m in &doc.styles.master_pages {
            if !m.name.is_empty() {
                used_names.insert(m.name.clone());
            }
        }
        Self {
            parts: PartCache::new(Rc::clone(&doc)),
            doc,
            map,
            edited,
            registry,
            options,
            patches: Vec::new(),
            matched: HashSet::new(),
            warnings: Vec::new(),
            scratch: Scratch::default(),
            used_names,
            new_styles: PerPart::default(),
            new_fonts: PerPart::default(),
            derived: JsMap::new(),
            used_prefixes: PerPart::default(),
            ext_cache: RefCell::new(JsMap::new()),
        }
    }

    /// `part(part)`
    pub fn part(&self, part: OdtStylePart) -> Rc<OdtPartInfo> {
        self.parts.get(part)
    }

    /// The byte offset in the part string of a `U16` offset a bridge record holds.
    pub fn byte(&self, part: OdtStylePart, at: U16) -> usize {
        self.parts.get(part).xml.to_byte(at)
    }

    /// The typed scratch value of this context.
    pub fn state<T: Default + 'static>(&self) -> RefMut<'_, T> {
        self.scratch.state::<T>()
    }

    /// `allocateStyleName`: a style name not used by any existing or new
    /// style of either part (`<base>_io<n>`; the stem is made a valid NCName).
    pub fn allocate_style_name(&mut self, base: &str) -> String {
        let stem = js_regex!(r"_io\d+$").replace_all(base, |_| String::new());
        let stem =
            js_regex!("[^\\w.\\-\u{B7}\u{C0}-\u{FFFF}]").replace_all(&stem, |_| "_".to_owned());
        let stem = js_regex!("^(?=[\\d.\\-\u{B7}])").replace_all(&stem, |_| "_".to_owned());
        let mut n = 1usize;
        loop {
            let name = format!("{stem}_io{n}");
            if !self.used_names.contains(&name) {
                self.used_names.insert(name.clone());
                return name;
            }
            n += 1;
        }
    }

    /// `derivedStyle`: a style name for derived style XML: the same `key`
    /// returns the same name, so identical edits share one new style. `build`
    /// receives the allocated name and returns the complete style element.
    pub fn derived_style(
        &mut self,
        part: OdtStylePart,
        key: &str,
        base: &str,
        build: impl FnOnce(&str) -> String,
    ) -> String {
        let cache_key = format!("{}\u{0}{key}", part.as_str());
        if let Some(found) = truthy(self.derived.get(&cache_key).map(String::as_str)) {
            return found.to_owned();
        }
        let name = self.allocate_style_name(base);
        self.derived.set(cache_key, name.clone());
        let xml = build(&name);
        self.add_automatic_style(part, &xml);
        name
    }

    /// `newAutomaticStyles`: the new automatic style elements queued for
    /// `part` so far.
    pub fn new_automatic_styles(&self, part: OdtStylePart) -> &[String] {
        self.new_styles.get(part)
    }

    /// `addAutomaticStyle`: queues a new automatic style (or list style) element for `part`.
    pub fn add_automatic_style(&mut self, part: OdtStylePart, xml: &str) {
        self.new_styles.get_mut(part).push(xml.to_owned());
        self.note_prefixes(part, xml);
    }

    /// `fontFace`: declares a font face for `family` in `part` when none maps
    /// to it, and returns the `style:name` to use in `style:font-name*`.
    pub fn font_face(&mut self, part: OdtStylePart, family: &str) -> String {
        let info = self.part(part);
        for (name, fam) in info.font_faces.iter() {
            if fam == family {
                return name.to_owned();
            }
        }
        if let Some(added) = truthy(self.new_fonts.get(part).get(family).map(String::as_str)) {
            return added.to_owned();
        }
        let mut name = family.to_owned();
        let mut n = 2usize;
        while info.font_faces.has(&name)
            || self
                .new_fonts
                .get(part)
                .values()
                .any(|value| *value == name)
        {
            name = format!("{family} {n}");
            n += 1;
        }
        self.new_fonts
            .get_mut(part)
            .set(family.to_owned(), name.clone());
        name
    }

    /// `patch`: queues a narrow replacement of a part's source range
    /// (byte offsets).
    pub fn patch(&mut self, part: OdtStylePart, start: usize, end: usize, xml: &str) {
        self.patches.push(TextPatch {
            part,
            start,
            end,
            xml: xml.to_owned(),
        });
        self.note_prefixes(part, xml);
    }

    /// `notePrefixes`: records which namespace prefixes new markup uses, so
    /// `finish` can declare missing ones.
    pub fn note_prefixes(&mut self, part: OdtStylePart, xml: &str) {
        let used = self.used_prefixes.get_mut(part);
        for m in js_regex!(r"</?([a-z]+):").find_iter(xml) {
            used.set(m.get(1).unwrap_or("").to_owned(), ());
        }
        for m in js_regex!(r#"\s([a-z]+):[\w-]+=""#).find_iter(xml) {
            used.set(m.get(1).unwrap_or("").to_owned(), ());
        }
    }

    /// `warn`
    pub fn warn(&mut self, message: &str) {
        if !self.warnings.iter().any(|w| w == message) {
            self.warnings.push(message.to_owned());
        }
    }

    /// `ext(key)`: the slot of a feature module read from the bridge it was
    /// given, once; later calls answer the same `Rc`. `None` when the bridge
    /// has no such key.
    pub fn ext<T: DeserializeOwned + 'static>(&self, key: &str) -> Result<Option<Rc<T>>, OdtError> {
        if let Some(cached) = self.ext_cache.borrow().get(key) {
            if let Ok(typed) = Rc::clone(cached).downcast::<T>() {
                return Ok(Some(typed));
            }
        }
        let Some(value) = self.map.ext.get(key) else {
            return Ok(None);
        };
        let typed: Rc<T> = Rc::new(
            serde_json::from_value(value.clone()).map_err(|e| OdtError::thrown(e.to_string()))?,
        );
        self.ext_cache
            .borrow_mut()
            .set(key.to_owned(), Rc::clone(&typed) as Rc<dyn Any>);
        Ok(Some(typed))
    }

    /// `finish`: all patches per part: the converters' patches plus the
    /// insertion of new automatic styles and font faces, plus namespace
    /// declarations the original root lacks.
    pub fn finish(&mut self) -> PerPart<Vec<TextPatch>> {
        let mut out: PerPart<Vec<TextPatch>> = PerPart::default();
        for p in &self.patches {
            out.get_mut(p.part).push(p.clone());
        }
        for part in OdtStylePart::BOTH {
            let info = self.part(part);
            let xml: &str = &info.xml.text;
            if xml.is_empty() {
                continue;
            }
            let containers = self.doc.styles.containers.get(part).clone();
            let fonts: Vec<String> = self
                .new_fonts
                .get(part)
                .iter()
                .map(|(family, name)| {
                    let shown = if js_regex!(r"\s").test(family) {
                        format!("'{family}'")
                    } else {
                        family.to_owned()
                    };
                    format!(
                        "<style:font-face style:name=\"{}\" svg:font-family=\"{}\"/>",
                        esc_attr(name),
                        esc_attr(&shown)
                    )
                })
                .collect();
            if !fonts.is_empty() {
                let joined = fonts.concat();
                self.note_prefixes(part, &joined);
                out.get_mut(part).push(container_insert(
                    part,
                    xml,
                    containers.font_face_decls,
                    "office:font-face-decls",
                    &joined,
                    &[
                        "office:styles",
                        "office:automatic-styles",
                        "office:master-styles",
                        "office:body",
                    ],
                ));
            }
            let styles = self.new_styles.get(part);
            if !styles.is_empty() {
                out.get_mut(part).push(container_insert(
                    part,
                    xml,
                    containers.automatic_styles,
                    "office:automatic-styles",
                    &styles.concat(),
                    &["office:master-styles", "office:body"],
                ));
            }
            let used: Vec<String> = self
                .used_prefixes
                .get(part)
                .iter()
                .map(|(prefix, _)| prefix.to_owned())
                .collect();
            if let Some(decl) = namespace_declarations(xml, &used) {
                out.get_mut(part).push(decl.into_patch(part));
            }
        }
        out
    }
}

/// `escAttr`
fn esc_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

struct FirstOf<'a> {
    before: &'a [&'a str],
    at: Option<usize>,
}

impl ElementVisitor for FirstOf<'_> {
    type Data = ();

    fn open(
        &mut self,
        el: &mut ElementFrame<()>,
        parent: Option<&ElementFrame<()>>,
    ) -> OpenVerdict {
        if parent.is_none() {
            return OpenVerdict::Continue;
        }
        if self.before.contains(&el.name.as_str()) {
            self.at = Some(el.start);
            return OpenVerdict::Stop;
        }
        OpenVerdict::Skip
    }
}

/// `containerInsert`: inserts `inner` at the end of a container, creating it
/// before the first of `before` when missing.
fn container_insert(
    part: OdtStylePart,
    xml: &str,
    range: Option<ElementRange>,
    name: &str,
    inner: &str,
    before: &[&str],
) -> TextPatch {
    if let Some(range) = range {
        if !range.self_closing {
            return TextPatch {
                part,
                start: range.close_start,
                end: range.close_start,
                xml: inner.to_owned(),
            };
        }
        return TextPatch {
            part,
            start: range.start,
            end: range.end,
            xml: format!("<{name}>{inner}</{name}>"),
        };
    }
    let root = read_root(xml);
    let mut at: Option<usize> = None;
    if let Some(root) = &root {
        let mut visitor = FirstOf { before, at: None };
        walk_elements(xml, &root.prefixes, &mut visitor, 0, xml.len());
        at = visitor.at;
    }
    let at = at.unwrap_or_else(|| root.as_ref().map_or(xml.len(), |r| r.end));
    TextPatch {
        part,
        start: at,
        end: at,
        xml: format!("<{name}>{inner}</{name}>"),
    }
}

struct NamespaceDeclarations {
    at: usize,
    text: String,
}

impl NamespaceDeclarations {
    fn into_patch(self, part: OdtStylePart) -> TextPatch {
        TextPatch {
            part,
            start: self.at,
            end: self.at,
            xml: self.text,
        }
    }
}

/// `namespaceDeclarations`
fn namespace_declarations(xml: &str, used: &[String]) -> Option<NamespaceDeclarations> {
    let root = read_root(xml)?;
    let mut declared: JsMap<String> = JsMap::new();
    for a in &root.attributes {
        if let Some(prefix) = a.name.strip_prefix("xmlns:") {
            declared.set(prefix.to_owned(), decode_xml_entities(&a.raw));
        }
    }
    let missing: Vec<&String> = used
        .iter()
        .filter(|p| output_namespace(p).is_some() && !declared.has(p))
        .collect();
    if missing.is_empty() {
        return None;
    }
    let slash = xml.as_bytes().get(root.end.wrapping_sub(2)) == Some(&b'/');
    let at = root.end - if slash { 2 } else { 1 };
    let text: String = missing
        .iter()
        .map(|p| format!(" xmlns:{p}=\"{}\"", output_namespace(p).unwrap_or("")))
        .collect();
    Some(NamespaceDeclarations { at, text })
}

/// Reads one of the typed parts of a `BridgeMap` once (`serde_json::from_value`
/// of `map.ext[key]`), for a function that takes a whole `BridgeMap`.
pub fn read_ext<T: DeserializeOwned>(map: &BridgeMap, key: &str) -> Result<Option<T>, OdtError> {
    match map.ext.get(key) {
        None => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|e| OdtError::thrown(e.to_string())),
    }
}
