//! `core/flow.ts`: the flow walkers: the generic part of both directions that
//! only dispatches.
//!
//! Forward (`convert_odt_body` / `convert_flow`): every child of
//! `office:text` (and of a container block such as `text:section`) becomes a
//! `BridgeBlock`; the newest registered `BlockConverter` that matches converts
//! it to OOXML body elements. Without a converter, sections are converted as
//! containers and everything else is kept verbatim with no OOXML (`keep`).
//!
//! Reverse (`rebuild_odt_body` / `rebuild_flow`): the edited docx's body
//! elements are aligned with the bridge elements (exact XML, then the
//! paragraph identity bookmark, then the owners' `identify`, then a 1:1
//! fallback inside a gap). Edited elements are grouped by the ODF block they
//! continue; a block whose elements all come back unchanged, complete and in
//! order is copied byte for byte, any other block goes to its owner's
//! `to_odf`. New elements between blocks go to the registered `FreeWriter`s.
//! Blocks that never had OOXML are re-emitted at their original place among
//! the surviving blocks.
//!
//! Offsets: a `BridgeBlock` holds `U16`; every offset used here is turned
//! into a byte offset of the part string with `rctx.byte`.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use docx_engine::model::{Block, BlockType, ParsedDoc};
use jscompat::{js_regex, trim};

use super::body::{OdtNode, OdtNodeKind};
use super::convert::{
    AlignedItem, BridgeBlock, BridgeElement, BridgeElementKind, EditedItem, FlowEnv, ItemRef,
    Neighbours, OdfToOoxmlContext, OoxmlToOdfContext, paragraph_id_from_bookmarks,
};
use super::errors::OdtError;
use super::styles::OdtStylePart;
use super::xml::slice;

// ---------------------------------------------------------------------------
// Forward

/// `CONTAINER_KINDS`
fn is_container_kind(kind: OdtNodeKind) -> bool {
    kind == OdtNodeKind::Section
}

/// The owner id of the default container conversion (`convertContainer`'s
/// default `owner`).
pub const CONTAINER_OWNER: &str = "container";

/// `convertOdtBody`: converts the whole body (`office:text`).
pub fn convert_odt_body(ctx: &mut OdfToOoxmlContext) -> Result<(), OdtError> {
    let doc = Rc::clone(&ctx.doc);
    convert_flow(ctx, &doc.body.blocks, None)
}

/// `convertFlow`: converts a sequence of sibling flow nodes, recording them
/// under `parent`.
pub fn convert_flow(
    ctx: &mut OdfToOoxmlContext,
    nodes: &[Rc<OdtNode>],
    parent: Option<usize>,
) -> Result<(), OdtError> {
    for node in nodes {
        convert_node(ctx, node, parent)?;
    }
    Ok(())
}

/// `convertNode`: converts one flow node into a bridge block and its
/// elements. Returns the block id (an index of `ctx.map.blocks`).
pub fn convert_node(
    ctx: &mut OdfToOoxmlContext,
    node: &Rc<OdtNode>,
    parent: Option<usize>,
) -> Result<usize, OdtError> {
    let registry = Rc::clone(&ctx.registry);
    let converter = if node.kind == OdtNodeKind::Opaque {
        None
    } else {
        registry.block_for(node, ctx)
    };
    if let Some(converter) = converter {
        let block = ctx.add_block(node, parent, converter.id());
        let out = converter.to_ooxml(
            ctx,
            node,
            &super::convert::BlockEnv {
                block_id: block,
                parent,
            },
        )?;
        for e in &out.elements {
            ctx.add_element(
                block,
                &e.xml,
                Some(e.kind.unwrap_or(BridgeElementKind::Other)),
                e.paragraph,
            );
        }
        if let Some(data) = out.data {
            ctx.map.blocks[block].data = data;
        }
        return Ok(block);
    }
    if is_container_kind(node.kind) && !node.self_closing {
        return convert_container(ctx, node, parent, CONTAINER_OWNER);
    }
    let block = ctx.add_block(node, parent, "keep");
    if node.kind != OdtNodeKind::Other && node.kind != OdtNodeKind::Opaque {
        ctx.warn(&format!("kept without conversion: {}", node.name));
    }
    Ok(block)
}

/// `convertContainer`: default container conversion: the node's flow
/// children become nested blocks. Its own markup around them is copied on
/// save. `owner` is `CONTAINER_OWNER` by default.
pub fn convert_container(
    ctx: &mut OdfToOoxmlContext,
    node: &Rc<OdtNode>,
    parent: Option<usize>,
    owner: &str,
) -> Result<usize, OdtError> {
    let block = ctx.add_block(node, parent, owner);
    convert_flow(ctx, &flow_children(node), Some(block))?;
    Ok(block)
}

/// `flowChildren`: children of a container that are flow content (direct
/// recorded children).
pub fn flow_children(node: &OdtNode) -> Vec<Rc<OdtNode>> {
    node.children
        .iter()
        .filter(|c| c.kind != OdtNodeKind::Bookmark && c.kind != OdtNodeKind::AnnotationEnd)
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// Reverse: alignment

/// `editedItems`: the body elements of an edited docx, from its parse.
pub fn edited_items(edited: &ParsedDoc) -> Vec<ItemRef> {
    edited_items_of_blocks(&edited.blocks)
}

/// `editedItems(edited)` for anything with `blocks` (`Pick<ParsedDoc, 'blocks'>`).
pub fn edited_items_of_blocks(blocks: &[Block]) -> Vec<ItemRef> {
    let mut out: Vec<ItemRef> = Vec::new();
    let mut last: Option<ItemRef> = None;
    for b in blocks {
        if b.hidden.unwrap_or(false) {
            continue;
        }
        let index = (*b.docx_index).flatten().map_or(-1, |n| n.0 as i64);
        if let Some(last) = &last
            && index >= 0
            && last.borrow().index == index
        {
            last.borrow_mut().blocks.push(b.clone());
            continue;
        }
        let item = Rc::new(RefCell::new(EditedItem {
            index,
            xml: (*b.original_xml).clone().flatten().unwrap_or_default(),
            blocks: vec![b.clone()],
        }));
        out.push(Rc::clone(&item));
        last = Some(item);
    }
    out
}

/// `paragraphBlockOf`: the paragraph-like engine block of an item, or `None`.
pub fn paragraph_block_of(item: &EditedItem) -> Option<&Block> {
    if item.blocks.len() != 1 {
        return None;
    }
    let b = &item.blocks[0];
    match *b.r#type {
        Some(BlockType::Paragraph | BlockType::Heading | BlockType::ListItem) => Some(b),
        _ => None,
    }
}

/// `itemKind`
fn item_kind(item: &EditedItem) -> BridgeElementKind {
    if paragraph_block_of(item).is_some() {
        BridgeElementKind::Paragraph
    } else if item
        .blocks
        .first()
        .is_some_and(|b| *b.r#type == Some(BlockType::Table))
    {
        BridgeElementKind::Table
    } else {
        BridgeElementKind::Other
    }
}

/// `alignItems`: aligns edited elements with bridge elements.
pub fn align_items(
    rctx: &mut OoxmlToOdfContext,
    items: &[ItemRef],
) -> Result<Vec<AlignedItem>, OdtError> {
    let element_count = rctx.map.elements.len();
    let mut used: HashSet<usize> = HashSet::new();
    let mut matched: Vec<Option<usize>> = vec![None; items.len()];

    // 1. exact XML
    {
        let elements = &rctx.map.elements;
        let mut by_xml: HashMap<&str, Vec<usize>> = HashMap::new();
        for e in elements {
            by_xml.entry(e.xml.as_str()).or_default().push(e.id);
        }
        let mut last_exact: i64 = -1;
        for (i, item) in items.iter().enumerate() {
            let item = item.borrow();
            let Some(ids) = by_xml.get(item.xml.as_str()) else {
                continue;
            };
            let id = ids
                .iter()
                .find(|&&x| !used.contains(&x) && x as i64 > last_exact)
                .or_else(|| ids.iter().find(|&&x| !used.contains(&x)));
            let Some(&id) = id else {
                continue;
            };
            used.insert(id);
            matched[i] = Some(id);
            last_exact = id as i64;
        }
    }

    // 2. paragraph identity bookmark
    {
        let mut by_paragraph: HashMap<usize, usize> = HashMap::new();
        for e in &rctx.map.elements {
            if let Some(paragraph) = e.paragraph {
                by_paragraph.insert(paragraph, e.id);
            }
        }
        for (i, item) in items.iter().enumerate() {
            if matched[i].is_some() {
                continue;
            }
            let item = item.borrow();
            let pid = paragraph_block_of(&item)
                .and_then(|b| paragraph_id_from_bookmarks(b.hidden_bookmarks.as_deref()));
            let id = pid.and_then(|pid| by_paragraph.get(&pid).copied());
            let Some(id) = id else {
                continue;
            };
            if used.contains(&id) {
                continue;
            }
            used.insert(id);
            matched[i] = Some(id);
        }
    }

    // 3/4. owner identify, then a 1:1 fallback, within each gap between matches
    let gap_candidates =
        |matched: &[Option<usize>], used: &HashSet<usize>, i: usize| -> Vec<usize> {
            let mut lo: i64 = -1;
            for k in (0..i).rev() {
                if let Some(m) = matched[k] {
                    lo = m as i64;
                    break;
                }
            }
            let mut hi: i64 = element_count as i64;
            for slot in matched.iter().skip(i + 1) {
                if let Some(m) = *slot {
                    hi = m as i64;
                    break;
                }
            }
            (0..element_count)
                .filter(|&id| (id as i64) > lo && (id as i64) < hi && !used.contains(&id))
                .collect()
        };
    let registry = Rc::clone(&rctx.registry);
    for (i, item) in items.iter().enumerate() {
        if matched[i].is_some() {
            continue;
        }
        let candidates = gap_candidates(&matched, &used, i);
        'converters: for converter in &registry.blocks {
            if !converter.has_identify() {
                continue;
            }
            // the element's own block or any block around it (a table inside a section or a list)
            let own: Vec<BridgeElement> = candidates
                .iter()
                .filter(|&&id| owned_by(rctx, rctx.map.elements[id].block, converter.id()))
                .map(|&id| rctx.map.elements[id].clone())
                .collect();
            if own.is_empty() {
                continue;
            }
            let found = converter.identify(rctx, &item.borrow(), &own)?;
            if let Some(id) = found
                && !used.contains(&id)
            {
                used.insert(id);
                matched[i] = Some(id);
                break 'converters;
            }
        }
    }
    for (i, item) in items.iter().enumerate() {
        if matched[i].is_some() {
            continue;
        }
        let candidates = gap_candidates(&matched, &used, i);
        if candidates.len() != 1
            || rctx.map.elements[candidates[0]].kind != item_kind(&item.borrow())
        {
            continue;
        }
        // only a lone unmatched edited element in the same gap
        let mut others = 0;
        let mut k = i;
        while k > 0 && matched[k - 1].is_none() {
            others += 1;
            k -= 1;
        }
        let mut k = i + 1;
        while k < items.len() && matched[k].is_none() {
            others += 1;
            k += 1;
        }
        if others > 0 {
            continue;
        }
        used.insert(candidates[0]);
        matched[i] = Some(candidates[0]);
    }

    for id in &used {
        rctx.matched.insert(*id);
    }
    Ok(items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let element = matched[i];
            let unchanged =
                element.is_some_and(|id| rctx.map.elements[id].xml == item.borrow().xml);
            AlignedItem {
                item: Rc::clone(item),
                element,
                unchanged,
            }
        })
        .collect())
}

/// `ownedBy`: whether a block or one of its enclosing blocks belongs to `owner`.
fn owned_by(rctx: &OoxmlToOdfContext, id: usize, owner: &str) -> bool {
    let mut b = rctx.map.blocks.get(id);
    while let Some(block) = b {
        if block.owner == owner {
            return true;
        }
        b = block.parent.and_then(|p| rctx.map.blocks.get(p));
    }
    false
}

/// `ancestorIn`: the ancestor of `block_id` (or itself) whose parent is
/// `parent`, or `None`.
fn ancestor_in(rctx: &OoxmlToOdfContext, block_id: usize, parent: Option<usize>) -> Option<usize> {
    let mut b = rctx.map.blocks.get(block_id);
    while let Some(block) = b {
        if block.parent == parent {
            return Some(block.id);
        }
        let next = block.parent?;
        b = rctx.map.blocks.get(next);
    }
    None
}

/// `blockElements`: every bridge element of a block and its descendants, in order.
pub fn block_elements(rctx: &OoxmlToOdfContext, block: &BridgeBlock) -> Vec<usize> {
    let mut out: Vec<usize> = block.elements.clone();
    let mut stack: Vec<usize> = block.children.iter().rev().copied().collect();
    while let Some(id) = stack.pop() {
        let Some(child) = rctx.map.blocks.get(id) else {
            continue;
        };
        out.extend(child.elements.iter().copied());
        stack.extend(child.children.iter().rev().copied());
    }
    out.sort_unstable();
    out
}

// ---------------------------------------------------------------------------
// Reverse: rebuilding

/// `blockSource`: source text of a bridge block.
pub fn block_source(rctx: &OoxmlToOdfContext, block: &BridgeBlock) -> String {
    let xml = rctx.part(block.part).xml.clone();
    slice(&xml.text, xml.to_byte(block.start), xml.to_byte(block.end)).to_owned()
}

/// `rebuildOdtBody`: rewrites `office:text` from the edited docx and queues
/// the patch (none when the result equals the original). Returns the aligned
/// items. `items` defaults to `edited_items(&rctx.edited)`.
pub fn rebuild_odt_body(
    rctx: &mut OoxmlToOdfContext,
    items: Option<Vec<ItemRef>>,
) -> Result<Vec<AlignedItem>, OdtError> {
    let items = items.unwrap_or_else(|| edited_items(&rctx.edited));
    let aligned = align_items(rctx, &items)?;
    let doc = Rc::clone(&rctx.doc);
    let text = doc.body.text;
    let xml: &str = &doc.content_xml.text;
    let trimmed = without_trailing_filler(rctx, &aligned);
    let inner = rebuild_flow(rctx, trimmed, &FlowEnv::default())?;
    let original = slice(xml, text.open_end, text.close_start);
    if inner == original {
        return Ok(aligned);
    }
    if text.self_closing {
        let open =
            js_regex!(r"\s*\/>$").replace_all(slice(xml, text.start, text.end), |_| ">".to_owned());
        let name = js_regex!(r"^<([^\s/>]+)")
            .exec(&open)
            .and_then(|m| m.get(1))
            .unwrap_or("office:text")
            .to_owned();
        rctx.patch(
            OdtStylePart::ContentXml,
            text.start,
            text.end,
            &format!("{open}{inner}</{name}>"),
        );
    } else {
        rctx.patch(
            OdtStylePart::ContentXml,
            text.open_end,
            text.close_start,
            &inner,
        );
    }
    Ok(aligned)
}

/// `withoutTrailingFiller`: the editor cannot end a document with a table: it
/// keeps an empty paragraph after it and saves that as a bare `<w:p></w:p>`
/// the bridge never had. When the bridge docx ends with something other than
/// a paragraph, such a last new element is that filler, not content, and is
/// not written.
fn without_trailing_filler<'a>(
    rctx: &OoxmlToOdfContext,
    aligned: &'a [AlignedItem],
) -> &'a [AlignedItem] {
    let Some(last) = aligned.last() else {
        return aligned;
    };
    if last.element.is_some() {
        return aligned;
    }
    let Some(bridge_last) = rctx.map.elements.last() else {
        return aligned;
    };
    if bridge_last.kind == BridgeElementKind::Paragraph {
        return aligned;
    }
    let item_xml = last.item.borrow().xml.clone();
    let stripped =
        js_regex!(r"<w:bookmark(?:Start|End)\b[^>]*\/>").replace_all(&item_xml, |_| String::new());
    let stripped =
        js_regex!(r"<w:pPr>\s*<\/w:pPr>|<w:pPr\/>").replace_all(&stripped, |_| String::new());
    let bare = trim(&stripped);
    if !js_regex!(r"^(?:<w:p(?:\s[^>]*)?>\s*<\/w:p>|<w:p(?:\s[^>]*)?\/>)$").test(bare) {
        return aligned;
    }
    &aligned[..aligned.len() - 1]
}

/// `rebuildFlow`: rebuilds the flow whose blocks have parent `env.parent`
/// from the aligned items belonging to it.
pub fn rebuild_flow(
    rctx: &mut OoxmlToOdfContext,
    aligned: &[AlignedItem],
    env: &FlowEnv,
) -> Result<String, OdtError> {
    let blocks: Vec<usize> = rctx
        .map
        .blocks
        .iter()
        .filter(|b| b.parent == env.parent)
        .map(|b| b.id)
        .collect();
    let content = rctx.part(OdtStylePart::ContentXml);
    let xml: &str = &content.xml.text;
    let doc = Rc::clone(&rctx.doc);
    let owners: Vec<Option<usize>> = aligned
        .iter()
        .map(|a| {
            a.element
                .and_then(|e| ancestor_in(rctx, rctx.map.elements[e].block, env.parent))
        })
        .collect();
    // new items sandwiched between items of the same block belong to it
    let mut assigned: Vec<Option<usize>> = owners
        .iter()
        .enumerate()
        .map(|(i, o)| {
            if o.is_some() {
                return *o;
            }
            let before = owners[..i].iter().rev().find_map(|x| *x);
            let after = owners[i + 1..].iter().find_map(|x| *x);
            if before.is_some() && before == after {
                before
            } else {
                None
            }
        })
        .collect();
    // new items next to a block that absorbs them (a list item typed after a list)
    let registry = Rc::clone(&rctx.registry);
    let absorbs =
        |rctx: &mut OoxmlToOdfContext, owner: usize, item: &ItemRef| -> Result<bool, OdtError> {
            let block = rctx.map.blocks[owner].clone();
            match registry.block_by_id(&block.owner) {
                Some(converter) => converter.absorbs(rctx, &block, &item.borrow()),
                None => Ok(false),
            }
        };
    for k in 1..assigned.len() {
        if let (None, Some(prev)) = (assigned[k], assigned[k - 1])
            && absorbs(rctx, prev, &aligned[k].item)?
        {
            assigned[k] = Some(prev);
        }
    }
    for k in (0..assigned.len().saturating_sub(1)).rev() {
        if let (None, Some(next)) = (assigned[k], assigned[k + 1])
            && absorbs(rctx, next, &aligned[k].item)?
        {
            assigned[k] = Some(next);
        }
    }

    let carried: Vec<usize> = blocks
        .iter()
        .copied()
        .filter(|&b| block_elements(rctx, &rctx.map.blocks[b]).is_empty())
        .collect();
    let mut flow = Emit {
        out: String::new(),
        // -1: the flow start; `None`: null
        last_verbatim: Some(-1),
        carry: 0,
    };

    let mut i = 0;
    while i < aligned.len() {
        let owner = assigned[i];
        let mut j = i + 1;
        while j < aligned.len() && assigned[j] == owner {
            j += 1;
        }
        let group = &aligned[i..j];
        match owner {
            None => {
                let before = aligned[..i].iter().rev().find_map(|a| a.element);
                let after = aligned[j..].iter().find_map(|a| a.element);
                let free_env = FlowEnv {
                    parent: env.parent,
                    neighbours: Some(Neighbours { before, after }),
                };
                let written = write_free(rctx, group, &free_env)?;
                flow.out.push_str(&written);
                flow.last_verbatim = None;
            }
            Some(owner) => {
                let block_id = rctx.map.blocks[owner].id;
                flow.flush_carried(rctx, &doc, xml, &blocks, &carried, Some(block_id), env);
                let block = rctx.map.blocks[owner].clone();
                let expected = block_elements(rctx, &block);
                let verbatim = group.len() == expected.len()
                    && group
                        .iter()
                        .enumerate()
                        .all(|(k, a)| a.unchanged && a.element == Some(expected[k]));
                if verbatim {
                    flow.emit_verbatim(rctx, &doc, xml, &blocks, &block, env);
                } else {
                    let written = write_block(rctx, &block, group, env)?;
                    flow.out.push_str(&written);
                    flow.last_verbatim = None;
                }
            }
        }
        i = j;
    }
    flow.flush_carried(rctx, &doc, xml, &blocks, &carried, None, env);
    let text = doc.body.text;
    if env.parent.is_none() && !blocks.is_empty() {
        let last = rctx.map.blocks[*blocks.last().expect("a last block")].clone();
        if flow.last_verbatim == Some(last.id as i64) {
            let end = rctx.byte(last.part, last.end);
            flow.out.push_str(slice(xml, end, text.close_start));
            return Ok(flow.out);
        }
    }
    if env.parent.is_none() && blocks.is_empty() && aligned.is_empty() {
        flow.out
            .push_str(slice(xml, text.open_end, text.close_start));
    }
    Ok(flow.out)
}

/// The state `rebuildFlow` threads through its closures.
struct Emit {
    out: String,
    last_verbatim: Option<i64>,
    carry: usize,
}

impl Emit {
    /// `emitVerbatim`
    fn emit_verbatim(
        &mut self,
        rctx: &OoxmlToOdfContext,
        doc: &Rc<super::open::OdtDocument>,
        xml: &str,
        blocks: &[usize],
        b: &BridgeBlock,
        env: &FlowEnv,
    ) {
        let at = blocks.iter().position(|&x| x == b.id);
        let prev_sibling: i64 = match at {
            Some(i) if i > 0 => blocks[i - 1] as i64,
            _ => -1,
        };
        if self.last_verbatim == Some(prev_sibling) {
            // `leadFrom`
            let from: Option<usize> = match at {
                Some(i) if i > 0 => {
                    let prev = &rctx.map.blocks[blocks[i - 1]];
                    Some(rctx.byte(prev.part, prev.end))
                }
                _ if env.parent.is_none() => Some(doc.body.text.open_end),
                _ => None,
            };
            let start = rctx.byte(b.part, b.start);
            if let Some(from) = from
                && from <= start
            {
                self.out.push_str(slice(xml, from, start));
            }
        }
        self.out.push_str(&block_source(rctx, b));
        self.last_verbatim = Some(b.id as i64);
    }

    /// `flushCarried`
    #[allow(clippy::too_many_arguments)]
    fn flush_carried(
        &mut self,
        rctx: &OoxmlToOdfContext,
        doc: &Rc<super::open::OdtDocument>,
        xml: &str,
        blocks: &[usize],
        carried: &[usize],
        before_id: Option<usize>,
        env: &FlowEnv,
    ) {
        while self.carry < carried.len()
            && before_id.is_none_or(|before| carried[self.carry] < before)
        {
            let block = rctx.map.blocks[carried[self.carry]].clone();
            self.carry += 1;
            self.emit_verbatim(rctx, doc, xml, blocks, &block, env);
        }
    }
}

/// `writeBlock`
fn write_block(
    rctx: &mut OoxmlToOdfContext,
    block: &BridgeBlock,
    items: &[AlignedItem],
    env: &FlowEnv,
) -> Result<String, OdtError> {
    if block.owner == super::flow::CONTAINER_OWNER {
        return rebuild_container(rctx, block, items);
    }
    let registry = Rc::clone(&rctx.registry);
    let Some(converter) = registry.block_by_id(&block.owner) else {
        rctx.warn(&format!(
            "no converter \"{}\" for {}; kept the original",
            block.owner, block.name
        ));
        return Ok(block_source(rctx, block));
    };
    converter.to_odf(rctx, block, items, env)
}

/// `rebuildContainer`: default container write-back: the original markup
/// around freshly rebuilt children.
pub fn rebuild_container(
    rctx: &mut OoxmlToOdfContext,
    block: &BridgeBlock,
    items: &[AlignedItem],
) -> Result<String, OdtError> {
    let info = rctx.part(block.part);
    let xml: &str = &info.xml.text;
    let children: Vec<BridgeBlock> = block
        .children
        .iter()
        .map(|&c| rctx.map.blocks[c].clone())
        .collect();
    let inner = rebuild_flow(
        rctx,
        items,
        &FlowEnv {
            parent: Some(block.id),
            neighbours: None,
        },
    )?;
    let block_start = info.xml.to_byte(block.start);
    let block_end = info.xml.to_byte(block.end);
    let (Some(first), Some(last)) = (children.first(), children.last()) else {
        let open = js_regex!(r"^<[^>]*>")
            .exec(slice(xml, block_start, block_end))
            .map_or("", |m| m.as_str());
        let name = js_regex!(r"^<([^\s/>]+)")
            .exec(open)
            .and_then(|m| m.get(1))
            .unwrap_or(&block.name)
            .to_owned();
        let open = js_regex!(r"\s*\/>$").replace_all(open, |_| ">".to_owned());
        return Ok(format!("{open}{inner}</{name}>"));
    };
    Ok(format!(
        "{}{inner}{}",
        slice(xml, block_start, info.xml.to_byte(first.start)),
        slice(xml, info.xml.to_byte(last.end), block_end)
    ))
}

/// `writeFree`
fn write_free(
    rctx: &mut OoxmlToOdfContext,
    group: &[AlignedItem],
    env: &FlowEnv,
) -> Result<String, OdtError> {
    let registry = Rc::clone(&rctx.registry);
    let mut out = String::new();
    let mut k = 0;
    while k < group.len() {
        let writer = registry.free_writer_for(&group[k].item.borrow());
        let mut m = k + 1;
        while m < group.len() {
            let next = registry.free_writer_for(&group[m].item.borrow());
            let same = match (&writer, &next) {
                (None, None) => true,
                (Some(a), Some(b)) => Rc::ptr_eq(a, b),
                _ => false,
            };
            if !same {
                break;
            }
            m += 1;
        }
        match writer {
            Some(writer) => {
                let items: Vec<ItemRef> = group[k..m].iter().map(|a| Rc::clone(&a.item)).collect();
                out.push_str(&writer.to_odf(rctx, &items, env)?);
            }
            None => {
                let kind = group[k]
                    .item
                    .borrow()
                    .blocks
                    .first()
                    .and_then(|b| (*b.r#type).map(BlockType::as_str))
                    .unwrap_or("element");
                rctx.warn(&format!("dropped a new {kind} with no writer"));
            }
        }
        k = m;
    }
    Ok(out)
}
