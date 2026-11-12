//! `edits.ts` of `packages/epub-engine`: block edits, each expressed as range
//! replacements on the chapter source.
//!
//! Nothing outside the edited blocks is rewritten: a text edit replaces the
//! block's inner range; split, merge, insert and delete only write the tags at
//! the seams they create. Flowing blocks (p, h1-h6, li, blockquote, div) take
//! every edit; structural text blocks (td, th, figcaption, dt, dd) only take
//! text edits, line breaks and bold/italic.
//!
//! `applyBlockEdit` re-reads the chapter with `parseXml` and `locate` calls
//! `textRawOffset`, which are not ported here: both go through an [`XmlHost`].

use jscompat::{is_js_space, js_regex, number_to_string};

use crate::blocks::{ChapterBlock, ChapterMap, OpenChapter, find_block, is_opaque, remap_chapter};
use crate::marks::toggle_mark_in_tree;
use crate::notation::{
    MarkName, NotationError, NotationOptions, block_notation, encode_block,
    new_block_notation_to_xhtml, notation_plain_text, notation_to_xhtml, notation_tree_to_xhtml,
};
use crate::ranges::{RangeReplacement, apply_replacements, compose_replacements};
use crate::utf16::{is_ascii_blank, is_blank, lossy, units};
use crate::xml_positions_types::{
    ElementId, Thrown, XmlDocument, XmlHost, XmlNode, XmlText, deeper, text_raw_offset,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Neighbour {
    Previous,
    Next,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkKind {
    Bold,
    Italic,
}

/// `BlockEdit`. Ids and texts are JavaScript strings, so they are units; the
/// offsets are numbers.
#[derive(Debug, Clone, PartialEq)]
pub enum BlockEdit {
    /// Replace the block's text with notation; its placeholders must match.
    Replace {
        block_id: Vec<u16>,
        text: Vec<u16>,
        /// `dropRuby === true`: only `true` drops.
        drop_ruby: bool,
    },
    /// Insert a new block of the same tag and attributes (minus id) after this one.
    InsertAfter { block_id: Vec<u16>, text: Vec<u16> },
    /// Delete the block; an id it had survives as an empty span in a flowing sibling.
    Delete { block_id: Vec<u16> },
    /// Enter: split the block at a plain-text offset.
    Split { block_id: Vec<u16>, offset: f64 },
    /// Backspace at the start (`previous`) or Delete at the end (`next`).
    Merge { block_id: Vec<u16>, with: Neighbour },
    /// Shift+Enter: a `br` at a plain-text offset.
    LineBreak { block_id: Vec<u16>, offset: f64 },
    /// Ctrl+B / Ctrl+I on the plain-text range `[start, end)`.
    ToggleMark {
        block_id: Vec<u16>,
        mark: MarkKind,
        start: f64,
        end: f64,
    },
}

impl BlockEdit {
    fn block_id(&self) -> &[u16] {
        match self {
            Self::Replace { block_id, .. }
            | Self::InsertAfter { block_id, .. }
            | Self::Delete { block_id }
            | Self::Split { block_id, .. }
            | Self::Merge { block_id, .. }
            | Self::LineBreak { block_id, .. }
            | Self::ToggleMark { block_id, .. } => block_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditRefusalCode {
    UnknownBlock,
    NotFlowing,
    InvalidNotation,
    NoNeighbour,
    NoAnchorHost,
    BadOffset,
    NotWellFormed,
}

impl EditRefusalCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnknownBlock => "unknown-block",
            Self::NotFlowing => "not-flowing",
            Self::InvalidNotation => "invalid-notation",
            Self::NoNeighbour => "no-neighbour",
            Self::NoAnchorHost => "no-anchor-host",
            Self::BadOffset => "bad-offset",
            Self::NotWellFormed => "not-well-formed",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EditRefusal {
    pub code: EditRefusalCode,
    pub message: Vec<u16>,
}

/// Why an edit did not give its replacements: it was refused (`{ ok: false,
/// refusal }`), or the TypeScript threw.
#[derive(Debug, Clone, PartialEq)]
pub enum EditFailure {
    Refused(EditRefusal),
    Thrown(Thrown),
}

impl From<Thrown> for EditFailure {
    fn from(thrown: Thrown) -> Self {
        Self::Thrown(thrown)
    }
}

impl From<EditRefusal> for EditFailure {
    fn from(refusal: EditRefusal) -> Self {
        Self::Refused(refusal)
    }
}

fn refusal(code: EditRefusalCode, message: Vec<u16>) -> EditRefusal {
    EditRefusal { code, message }
}

fn refuse<T>(code: EditRefusalCode, message: &str) -> Result<T, EditFailure> {
    Err(refusal(code, units(message)).into())
}

/// A notation that did not decode is a refusal; a throw stays a throw.
fn invalid_notation(error: NotationError) -> EditFailure {
    match error {
        NotationError::Invalid(message) => {
            refusal(EditRefusalCode::InvalidNotation, message).into()
        }
        NotationError::Thrown(thrown) => thrown.into(),
    }
}

type Edited<T> = Result<T, EditFailure>;

/// The tag text of a document that parsed: no lone surrogate.
fn tag_text(source: &[u16], start: usize, end: usize) -> String {
    lossy(&source[start..end])
}

/// The start tag as written, made non-self-closing.
fn open_tag(source: &[u16], doc: &XmlDocument, id: ElementId) -> String {
    let el = doc.element(id);
    if !el.self_closing {
        return tag_text(source, el.start, el.start_tag_end);
    }
    let written = tag_text(source, el.start, el.end - 2);
    format!("{}>", written.trim_end_matches(is_js_space))
}

fn open_tag_without_id(source: &[u16], doc: &XmlDocument, id: ElementId) -> String {
    js_regex!(r#"\s+(?:xml:)?id\s*=\s*(?:"[^"]*"|'[^']*')"#, "g")
        .replace_all(&open_tag(source, doc, id), |_| String::new())
}

fn close_tag(source: &[u16], doc: &XmlDocument, id: ElementId) -> String {
    let el = doc.element(id);
    if el.self_closing {
        format!("</{}>", el.name)
    } else {
        tag_text(source, el.end_tag_start, el.end)
    }
}

/// `<span id="..."></span>` carrying the block's id attribute as written, or '' without one.
fn id_anchor(source: &[u16], doc: &XmlDocument, id: ElementId) -> String {
    js_regex!(r#"\s(id\s*=\s*(?:"[^"]*"|'[^']*'))"#)
        .exec(&open_tag(source, doc, id))
        .map_or_else(String::new, |m| {
            format!("<span {}></span>", m.get(1).unwrap_or_default())
        })
}

/// Whitespace written before the block on its line (its indentation).
fn leading_whitespace(source: &[u16], offset: usize) -> usize {
    let mut i = offset;
    while i > 0 && is_ascii_blank(source[i - 1]) {
        i -= 1;
    }
    i
}

fn replacement(start: usize, end: usize, text: Vec<u16>) -> RangeReplacement {
    RangeReplacement {
        start: start as f64,
        end: end as f64,
        text,
    }
}

/// `>${markup}</${name}>`: a self-closing element turned into a start and end tag.
fn opened(markup: &[u16], name: &str) -> Vec<u16> {
    let mut text = units(">");
    text.extend_from_slice(markup);
    text.extend(units(&format!("</{name}>")));
    text
}

/// Replaces the block's content (turning a self-closing block into a start and end tag).
fn inner_replacement(
    source: &[u16],
    doc: &XmlDocument,
    block: &ChapterBlock,
    xhtml: &[u16],
) -> Vec<RangeReplacement> {
    let el = doc.element(block.element);
    if el.self_closing {
        if xhtml.is_empty() {
            return Vec::new();
        }
        return vec![replacement(el.end - 2, el.end, opened(xhtml, &el.name))];
    }
    if &source[block.inner.start..block.inner.end] == xhtml {
        return Vec::new();
    }
    vec![replacement(
        block.inner.start,
        block.inner.end,
        xhtml.to_vec(),
    )]
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum At {
    Start,
    End,
}

/// Inserts markup at the start or end of a block's content.
fn content_insertion(
    doc: &XmlDocument,
    block: &ChapterBlock,
    at: At,
    markup: &[u16],
) -> RangeReplacement {
    let el = doc.element(block.element);
    if el.self_closing {
        return replacement(el.end - 2, el.end, opened(markup, &el.name));
    }
    let offset = if at == At::Start {
        block.inner.start
    } else {
        block.inner.end
    };
    replacement(offset, offset, markup.to_vec())
}

struct Point {
    /// Source offset.
    pos: usize,
    /// Inline elements open at the point, outside first.
    open: Vec<ElementId>,
    /// The point is inside a CDATA section.
    cdata: bool,
}

struct Locator<'a> {
    host: &'a dyn XmlHost,
    doc: &'a XmlDocument,
    offset: usize,
    count: usize,
    best: Option<Point>,
}

impl Locator<'_> {
    fn consider(&mut self, pos: usize, open: &[ElementId]) {
        if self.count == self.offset && self.best.as_ref().is_none_or(|b| open.len() < b.open.len())
        {
            self.best = Some(Point {
                pos,
                open: open.to_vec(),
                cdata: false,
            });
        }
    }

    fn walk(
        &mut self,
        id: ElementId,
        open: &[ElementId],
        content_end: usize,
        depth: usize,
    ) -> Result<(), Thrown> {
        let depth = deeper(depth)?;
        let doc = self.doc;
        for child in &doc.element(id).children {
            match child {
                XmlNode::Text(text) => {
                    self.consider(text.start, open);
                    self.text(text, open)?;
                }
                XmlNode::Other(other) => self.consider(other.start, open),
                XmlNode::Element(child_id) => {
                    let el = doc.element(*child_id);
                    self.consider(el.start, open);
                    if !el.self_closing && !is_opaque(&el.local) {
                        let mut inner = open.to_vec();
                        inner.push(*child_id);
                        self.consider(el.start_tag_end, &inner);
                        self.walk(*child_id, &inner, el.end_tag_start, depth)?;
                    }
                }
            }
        }
        self.consider(content_end, open);
        Ok(())
    }

    fn text(&mut self, text: &XmlText, open: &[ElementId]) -> Result<(), Thrown> {
        let len = text.value.len();
        if self.count < self.offset && self.offset < self.count + len {
            self.best = Some(Point {
                pos: text_raw_offset(self.host, self.doc, text, self.offset - self.count)?,
                open: open.to_vec(),
                cdata: text.cdata,
            });
        }
        self.count += len;
        Ok(())
    }
}

/// The source point after `offset` plain-text characters. Among the points
/// with that many characters before them, the one outside the most inline
/// elements wins, and the first of those, so a split at the end of a link
/// happens after the link and a split before a line break leaves the break in
/// the second block.
fn locate(
    host: &dyn XmlHost,
    map: &OpenChapter,
    block: &ChapterBlock,
    offset: usize,
) -> Result<Option<Point>, Thrown> {
    if block.self_closing {
        return Ok((offset == 0).then(|| Point {
            pos: block.inner.start,
            open: Vec::new(),
            cdata: false,
        }));
    }
    let mut locator = Locator {
        host,
        doc: &map.doc,
        offset,
        count: 0,
        best: None,
    };
    locator.consider(block.inner.start, &[]);
    locator.walk(block.element, &[], block.inner.end, 0)?;
    Ok(locator.best)
}

fn plain_length(map: &OpenChapter, block: &ChapterBlock) -> Result<usize, Thrown> {
    Ok(notation_plain_text(&encode_block(map, block, NotationOptions::default())?.0)?.len())
}

fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

fn check_offset(
    map: &OpenChapter,
    block: &ChapterBlock,
    offset: f64,
) -> Result<Option<EditRefusal>, Thrown> {
    let length = plain_length(map, block)?;
    if !is_integer(offset) || offset < 0.0 || offset > length as f64 {
        return Ok(Some(refusal(
            EditRefusalCode::BadOffset,
            units(&format!(
                "offset {} is outside the block text (0\u{2013}{length})",
                number_to_string(offset)
            )),
        )));
    }
    Ok(None)
}

fn cat(parts: &[&[u16]]) -> Vec<u16> {
    parts.iter().flat_map(|p| p.iter().copied()).collect()
}

fn split_block(
    host: &dyn XmlHost,
    map: &OpenChapter,
    block: &ChapterBlock,
    offset: f64,
) -> Edited<Vec<RangeReplacement>> {
    if !block.flowing {
        return refuse(
            EditRefusalCode::NotFlowing,
            &format!("{} blocks cannot be split", block.kind.as_str()),
        );
    }
    if let Some(bad) = check_offset(map, block, offset)? {
        return Err(bad.into());
    }
    let source = map.source();
    let doc = &map.doc;
    let el = doc.element(block.element);
    let ws = &source[leading_whitespace(source, el.start)..el.start];
    if el.self_closing {
        let text = cat(&[
            &units(&format!("></{}>", el.name)),
            ws,
            &units(&open_tag_without_id(source, doc, block.element)),
            &units(&format!("</{}>", el.name)),
        ]);
        return Ok(vec![replacement(el.end - 2, el.end, text)]);
    }
    let Some(point) = locate(host, map, block, offset as usize)? else {
        // `point.open` of the null `locate` gave
        return Err(Thrown::new(
            "TypeError",
            "Cannot read properties of null (reading 'open')",
        )
        .into());
    };
    let closing: String = point
        .open
        .iter()
        .rev()
        .map(|&open| format!("</{}>", doc.element(open).name))
        .collect();
    let reopening: String = point
        .open
        .iter()
        .map(|&open| open_tag_without_id(source, doc, open))
        .collect();
    let text = cat(&[
        &units(if point.cdata { "]]>" } else { "" }),
        &units(&closing),
        &units(&close_tag(source, doc, block.element)),
        ws,
        &units(&open_tag_without_id(source, doc, block.element)),
        &units(&reopening),
        &units(if point.cdata { "<![CDATA[" } else { "" }),
    ]);
    Ok(vec![replacement(point.pos, point.pos, text)])
}

fn line_break(
    host: &dyn XmlHost,
    map: &OpenChapter,
    block: &ChapterBlock,
    offset: f64,
) -> Edited<Vec<RangeReplacement>> {
    if let Some(bad) = check_offset(map, block, offset)? {
        return Err(bad.into());
    }
    if block.self_closing {
        return Ok(vec![content_insertion(
            &map.doc,
            block,
            At::End,
            &units("<br/>"),
        )]);
    }
    let Some(point) = locate(host, map, block, offset as usize)? else {
        return Err(Thrown::new(
            "TypeError",
            "Cannot read properties of null (reading 'cdata')",
        )
        .into());
    };
    let text = if point.cdata {
        "]]><br/><![CDATA["
    } else {
        "<br/>"
    };
    Ok(vec![replacement(point.pos, point.pos, units(text))])
}

/// The editable block right next to this one under the same parent, with only whitespace between.
fn sibling_block<'a>(
    map: &'a OpenChapter,
    block: &ChapterBlock,
    direction: Neighbour,
) -> Option<&'a ChapterBlock> {
    let parent = map.doc.element(block.element).parent?;
    let siblings = &map.doc.element(parent).children;
    let index = siblings
        .iter()
        .position(|n| matches!(n, XmlNode::Element(id) if *id == block.element))?
        as isize;
    let step: isize = if direction == Neighbour::Next { 1 } else { -1 };
    let mut i = index + step;
    while i >= 0 && (i as usize) < siblings.len() {
        match &siblings[i as usize] {
            XmlNode::Text(text) if is_blank(&text.value) && !text.cdata => {}
            XmlNode::Element(id) => {
                return map.blocks.iter().find(|b| b.element == *id);
            }
            _ => return None,
        }
        i += step;
    }
    None
}

fn merge_blocks(
    map: &OpenChapter,
    block: &ChapterBlock,
    other: Neighbour,
) -> Edited<Vec<RangeReplacement>> {
    if !block.flowing {
        return refuse(
            EditRefusalCode::NotFlowing,
            &format!("{} blocks cannot be merged", block.kind.as_str()),
        );
    }
    let Some(neighbour) = sibling_block(map, block, other) else {
        return refuse(
            EditRefusalCode::NoNeighbour,
            &format!(
                "no neighbouring editable block under the same parent ({})",
                if other == Neighbour::Next {
                    "next"
                } else {
                    "previous"
                }
            ),
        );
    };
    if !neighbour.flowing {
        return refuse(
            EditRefusalCode::NotFlowing,
            &format!("{} blocks cannot be merged", neighbour.kind.as_str()),
        );
    }
    let (a, b) = if other == Neighbour::Next {
        (block, neighbour)
    } else {
        (neighbour, block)
    };
    let source = map.source();
    let doc = &map.doc;
    let (ae, be) = (doc.element(a.element), doc.element(b.element));
    let a_end = units(&close_tag(source, doc, a.element));
    let anchor = units(&id_anchor(source, doc, b.element));
    let seam = if ae.self_closing {
        ae.end - 2
    } else {
        a.inner.end
    };
    let opener = if ae.self_closing {
        units(">")
    } else {
        Vec::new()
    };
    let mut replacements = Vec::new();
    if be.self_closing {
        replacements.push(replacement(seam, be.end, cat(&[&opener, &anchor, &a_end])));
    } else {
        replacements.push(replacement(seam, b.inner.start, cat(&[&opener, &anchor])));
        if source[b.inner.end..be.end] != a_end[..] {
            replacements.push(replacement(b.inner.end, be.end, a_end));
        }
    }
    Ok(replacements)
}

fn insert_after(
    map: &OpenChapter,
    block: &ChapterBlock,
    text: &[u16],
) -> Edited<Vec<RangeReplacement>> {
    if !block.flowing {
        return refuse(
            EditRefusalCode::NotFlowing,
            &format!("cannot insert a block after a {}", block.kind.as_str()),
        );
    }
    let xhtml = new_block_notation_to_xhtml(text).map_err(invalid_notation)?;
    let source = map.source();
    let doc = &map.doc;
    let el = doc.element(block.element);
    let ws = &source[leading_whitespace(source, el.start)..el.start];
    let markup = cat(&[
        ws,
        &units(&open_tag_without_id(source, doc, block.element)),
        &xhtml,
        &units(&format!("</{}>", el.name)),
    ]);
    Ok(vec![replacement(el.end, el.end, markup)])
}

fn nearest_flowing_sibling<'a>(
    map: &'a OpenChapter,
    block: &ChapterBlock,
    direction: Neighbour,
) -> Option<&'a ChapterBlock> {
    let parent = map.doc.element(block.element).parent?;
    let siblings = &map.doc.element(parent).children;
    let index = siblings
        .iter()
        .position(|n| matches!(n, XmlNode::Element(id) if *id == block.element))?
        as isize;
    let step: isize = if direction == Neighbour::Next { 1 } else { -1 };
    let mut i = index + step;
    while i >= 0 && (i as usize) < siblings.len() {
        if let XmlNode::Element(id) = &siblings[i as usize]
            && let Some(found) = map.blocks.iter().find(|b| b.element == *id)
            && found.flowing
        {
            return Some(found);
        }
        i += step;
    }
    None
}

fn delete_block(map: &OpenChapter, block: &ChapterBlock) -> Edited<Vec<RangeReplacement>> {
    if !block.flowing {
        return refuse(
            EditRefusalCode::NotFlowing,
            &format!("{} blocks cannot be deleted", block.kind.as_str()),
        );
    }
    let source = map.source();
    let doc = &map.doc;
    let el = doc.element(block.element);
    let mut replacements = Vec::new();
    let anchor = id_anchor(source, doc, block.element);
    if !anchor.is_empty() {
        let previous = nearest_flowing_sibling(map, block, Neighbour::Previous);
        let next = if previous.is_some() {
            None
        } else {
            nearest_flowing_sibling(map, block, Neighbour::Next)
        };
        let anchor = units(&anchor);
        replacements.push(match (previous, next) {
            (Some(previous), _) => content_insertion(doc, previous, At::End, &anchor),
            (None, Some(next)) => content_insertion(doc, next, At::Start, &anchor),
            (None, None) => {
                return refuse(
                    EditRefusalCode::NoAnchorHost,
                    "the block has an id and no flowing sibling under the same parent to keep it",
                );
            }
        });
    }
    replacements.push(replacement(
        leading_whitespace(source, el.start),
        el.end,
        Vec::new(),
    ));
    Ok(replacements)
}

fn replace_text(
    map: &OpenChapter,
    block: &ChapterBlock,
    text: &[u16],
    drop_ruby: bool,
) -> Edited<Vec<RangeReplacement>> {
    let current = block_notation(map, block, NotationOptions { drop_ruby })?;
    if current.text == text {
        return Ok(Vec::new());
    }
    let xhtml = notation_to_xhtml(text, &current.context).map_err(invalid_notation)?;
    Ok(inner_replacement(map.source(), &map.doc, block, &xhtml))
}

fn toggle_mark(
    map: &OpenChapter,
    block: &ChapterBlock,
    mark: MarkKind,
    start: f64,
    end: f64,
) -> Edited<Vec<RangeReplacement>> {
    let length = plain_length(map, block)?;
    if !is_integer(start) || !is_integer(end) || start < 0.0 || end < start || end > length as f64 {
        return Err(refusal(
            EditRefusalCode::BadOffset,
            units(&format!(
                "range [{}, {}) is outside the block text (0\u{2013}{length})",
                number_to_string(start),
                number_to_string(end)
            )),
        )
        .into());
    }
    let (tree, context) = encode_block(map, block, NotationOptions::default())?;
    let name = if mark == MarkKind::Bold {
        MarkName::B
    } else {
        MarkName::I
    };
    let Some(toggled) = toggle_mark_in_tree(&tree, name, start, end)? else {
        return Ok(Vec::new());
    };
    let xhtml = notation_tree_to_xhtml(&toggled, &context)?;
    Ok(inner_replacement(map.source(), &map.doc, block, &xhtml))
}

/// `blockEditReplacements`: the replacements one edit makes on `map.source`,
/// or why it is refused.
pub fn block_edit_replacements(
    host: &dyn XmlHost,
    map: &OpenChapter,
    edit: &BlockEdit,
) -> Edited<Vec<RangeReplacement>> {
    let Some(block) = find_block(map, edit.block_id()) else {
        let mut message = units("no block ");
        message.extend_from_slice(edit.block_id());
        message.extend(units(" in this chapter"));
        return Err(refusal(EditRefusalCode::UnknownBlock, message).into());
    };
    match edit {
        BlockEdit::Replace {
            text, drop_ruby, ..
        } => replace_text(map, block, text, *drop_ruby),
        BlockEdit::InsertAfter { text, .. } => insert_after(map, block, text),
        BlockEdit::Delete { .. } => delete_block(map, block),
        BlockEdit::Split { offset, .. } => split_block(host, map, block, *offset),
        BlockEdit::Merge { with, .. } => merge_blocks(map, block, *with),
        BlockEdit::LineBreak { offset, .. } => line_break(host, map, block, *offset),
        BlockEdit::ToggleMark {
            mark, start, end, ..
        } => toggle_mark(map, block, *mark, *start, *end),
    }
}

/// `EditResult` of an edit that went through. `map` is `None` where the
/// TypeScript returns the map it was given (an edit with nothing to replace).
#[derive(Debug, Clone, PartialEq)]
pub struct EditApplied {
    pub map: Option<OpenChapter>,
    pub replacements: Vec<RangeReplacement>,
    pub created: Vec<String>,
}

/// `applyBlockEdit`: applies one edit: the new block map (ids carried over,
/// new blocks with fresh ids listed in `created`) and the replacements that
/// made it.
pub fn apply_block_edit(
    host: &dyn XmlHost,
    map: &OpenChapter,
    edit: &BlockEdit,
) -> Edited<EditApplied> {
    let replacements = block_edit_replacements(host, map, edit)?;
    if replacements.is_empty() {
        return Ok(EditApplied {
            map: None,
            replacements,
            created: Vec::new(),
        });
    }
    let source = apply_replacements(map.source(), &replacements)
        .map_err(|error| Thrown::new("RangeError", error.0))?;
    let next = match remap_chapter(host, map, &source, &replacements)? {
        ChapterMap::Open(next) => next,
        ChapterMap::Broken(broken) => {
            let mut message = units("the edit would break the chapter: ");
            message.extend(units(&broken.error));
            return Err(refusal(EditRefusalCode::NotWellFormed, message).into());
        }
    };
    let created = next
        .blocks
        .iter()
        .filter(|b| !map.blocks.iter().any(|old| old.id == b.id))
        .map(|b| b.id.clone())
        .collect();
    Ok(EditApplied {
        map: Some(next),
        replacements,
        created,
    })
}

/// What `applyBlockEdits` answers.
#[derive(Debug, Clone, PartialEq)]
pub enum EditsResult {
    Applied {
        map: OpenChapter,
        replacements: Vec<RangeReplacement>,
        created: Vec<String>,
    },
    /// `{ ok: false, index, refusal }`
    Refused { index: usize, refusal: EditRefusal },
}

/// `applyBlockEdits`: applies edits in order, all or nothing. Block ids in
/// later edits refer to the chapter as the earlier edits left it. The
/// replacements are composed into one list against the original `map.source`.
pub fn apply_block_edits(
    host: &dyn XmlHost,
    map: &OpenChapter,
    edits: &[BlockEdit],
) -> Result<EditsResult, Thrown> {
    let mut current: Option<OpenChapter> = None;
    let mut replacements: Vec<RangeReplacement> = Vec::new();
    let mut created: Vec<String> = Vec::new();
    for (index, edit) in edits.iter().enumerate() {
        let result = match apply_block_edit(host, current.as_ref().unwrap_or(map), edit) {
            Ok(result) => result,
            Err(EditFailure::Refused(refusal)) => {
                return Ok(EditsResult::Refused { index, refusal });
            }
            Err(EditFailure::Thrown(thrown)) => return Err(thrown),
        };
        replacements = compose_replacements(map.source(), &replacements, &result.replacements);
        created.extend(result.created);
        if let Some(next) = result.map {
            current = Some(next);
        }
    }
    let current = current.unwrap_or_else(|| map.clone());
    let created = created
        .into_iter()
        .filter(|id| current.blocks.iter().any(|b| &b.id == id))
        .collect();
    Ok(EditsResult::Applied {
        map: current,
        replacements,
        created,
    })
}
