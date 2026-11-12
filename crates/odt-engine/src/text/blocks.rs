//! `text/blocks.ts`: the text owner: the block converter for paragraphs,
//! headings and lists, and the free writer for new paragraphs.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use docx_engine::model::{Block, BlockType};
use jscompat::{math_max, math_min};

use crate::core::body::{OdtNode, OdtNodeKind, walk_nodes};
use crate::core::convert::{
    AlignedItem, BlockConverter, BlockEnv, BlockOoxml, BlockOoxmlElement, BridgeBlock,
    BridgeElementKind, BridgeListItem, BridgeMarkerKind, BridgeParagraph, ConversionRegistry,
    EditedItem, FlowEnv, FreeWriter, ItemRef, OdfToOoxmlContext, OoxmlToOdfContext,
};
use crate::core::errors::OdtError;
use crate::core::flow::{block_source, convert_node, paragraph_block_of};
use crate::core::styles::OdtStylePart;
use crate::core::xml::slice;
use crate::offset::u16_len;

use super::lists::{ListInstanceAttrs, list_instance, list_style_from_numbering};
use super::markers::{Placement, kept_characters, place_markers};
use super::paragraph_odf::{ParagraphWriteOptions, edited_paragraph_from_block, paragraph_to_odf};
use super::paragraph_ooxml::{ParagraphList, ParagraphOoxmlOptions, paragraph_to_ooxml};
use super::style_xml::{as_open_tag, tag_name};

/// `TEXT_OWNER`
pub const TEXT_OWNER: &str = "text";

// ---------------------------------------------------------------------------
// Forward

/// `listToOoxml`
fn list_to_ooxml(
    ctx: &mut OdfToOoxmlContext,
    node: &Rc<OdtNode>,
    block_id: usize,
) -> Result<BlockOoxml, OdtError> {
    let inst = list_instance(
        ctx,
        block_id,
        &ListInstanceAttrs {
            style_name: node.attr("text:style-name").map(str::to_owned),
            xml_id: node.attr("xml:id").map(str::to_owned),
            continue_list: node.attr("text:continue-list").map(str::to_owned),
            continue_numbering: node.attr("text:continue-numbering") == Some("true"),
        },
    );
    // `walk`
    fn walk(
        ctx: &mut OdfToOoxmlContext,
        inst: &super::lists::ListInstance,
        block_id: usize,
        list: &Rc<OdtNode>,
        depth: usize,
    ) -> Result<(), OdtError> {
        for item in &list.children {
            if item.kind != OdtNodeKind::ListItem {
                convert_node(ctx, item, Some(block_id))?;
                continue;
            }
            let header = item.name == "text:list-header";
            let mut first = true;
            for child in &item.children {
                if child.kind == OdtNodeKind::Paragraph || child.kind == OdtNodeKind::Heading {
                    let level = depth.min(8);
                    let made =
                        paragraph_to_ooxml(
                            ctx,
                            &child.range(),
                            &ParagraphOoxmlOptions {
                                part: OdtStylePart::ContentXml,
                                owner: None,
                                block: Some(block_id),
                                list: Some(ParagraphList {
                                    item: BridgeListItem {
                                        num_id: inst.num_id.clone(),
                                        level: depth,
                                        header,
                                        continuation: !first,
                                    },
                                    kind: inst.kinds.get(level).cloned().unwrap_or(
                                        docx_engine::model::GeneratedBlockListKind::Ordered,
                                    ),
                                }),
                            },
                        )?;
                    ctx.add_element(
                        block_id,
                        &made.xml,
                        Some(BridgeElementKind::Paragraph),
                        Some(made.paragraph.id),
                    );
                    first = false;
                } else if child.kind == OdtNodeKind::List {
                    walk(ctx, inst, block_id, child, depth + 1)?;
                } else if child.kind != OdtNodeKind::Bookmark
                    && child.kind != OdtNodeKind::BookmarkStart
                    && child.kind != OdtNodeKind::BookmarkEnd
                {
                    convert_node(ctx, child, Some(block_id))?;
                }
            }
        }
        Ok(())
    }
    walk(ctx, &inst, block_id, node, 0)?;
    Ok(BlockOoxml {
        elements: Vec::new(),
        data: Some(serde_json::json!({ "numId": inst.num_id })),
    })
}

// ---------------------------------------------------------------------------
// Reverse

/// `TextState`: the per-context state of the reverse direction.
#[derive(Default)]
struct TextState {
    used_list_tags: HashSet<usize>,
    nodes: Option<HashMap<usize, Rc<OdtNode>>>,
}

/// `nodeAt`: the body node starting at byte `start` (content.xml).
fn node_at(rctx: &OoxmlToOdfContext, start: usize) -> Option<Rc<OdtNode>> {
    let mut state = rctx.state::<TextState>();
    if state.nodes.is_none() {
        let mut nodes: HashMap<usize, Rc<OdtNode>> = HashMap::new();
        walk_nodes(&rctx.doc.body.blocks, |n| {
            nodes.insert(n.start, Rc::clone(n));
            true
        });
        state.nodes = Some(nodes);
    }
    state.nodes.as_ref().and_then(|n| n.get(&start).cloned())
}

/// `startTag`
fn start_tag(xml: &str, start: usize) -> String {
    let end = xml[start.min(xml.len())..]
        .find('>')
        .map_or(0, |gt| start + gt + 1);
    slice(xml, start, end).to_owned()
}

/// `tagName`
fn tag_name_of(tag: &str) -> &str {
    tag_name(tag).unwrap_or("text:list")
}

/// `ListEntry`
struct ListEntry {
    level: f64,
    xml: String,
    continuation: bool,
    header: bool,
    origin: Option<BridgeParagraph>,
}

/// `writeList`
fn write_list(
    rctx: &mut OoxmlToOdfContext,
    num_id: &str,
    entries: &[ListEntry],
) -> Result<String, OdtError> {
    let part = rctx.part(OdtStylePart::ContentXml);
    let xml: &str = &part.xml.text;
    let bridge_list = rctx.map.lists.iter().find(|l| l.num_id == num_id).cloned();
    let mut open: Option<String> = None;
    let mut candidates: Vec<Option<usize>> = entries
        .iter()
        .filter(|e| {
            e.origin
                .as_ref()
                .and_then(|o| o.list.as_ref())
                .is_some_and(|l| l.num_id == num_id)
        })
        .map(|e| e.origin.as_ref().and_then(|o| o.block))
        .collect();
    if let Some(list) = &bridge_list {
        candidates.extend(list.blocks.iter().map(|b| Some(*b)));
    }
    for block_id in candidates {
        let Some(block_id) = block_id else {
            continue;
        };
        if rctx.state::<TextState>().used_list_tags.contains(&block_id) {
            continue;
        }
        let block = &rctx.map.blocks[block_id];
        if block.name != "text:list" {
            continue;
        }
        let start = part.xml.to_byte(block.start);
        rctx.state::<TextState>().used_list_tags.insert(block_id);
        open = Some(start_tag(xml, start));
        break;
    }
    if open.is_none()
        && let Some(style) = bridge_list
            .as_ref()
            .and_then(|l| l.style_name.as_deref())
            .filter(|s| !s.is_empty())
    {
        open = Some(format!(
            "<text:list text:style-name=\"{}\" text:continue-numbering=\"true\">",
            style
                .replace('&', "&amp;")
                .replace('"', "&quot;")
                .replace('<', "&lt;")
        ));
    }
    let mut open = match open {
        Some(open) => open,
        None => {
            let edited = Rc::clone(&rctx.edited);
            let def = edited
                .numbering
                .0
                .iter()
                .find(|(k, _)| k == num_id)
                .map(|(_, v)| v);
            let name = list_style_from_numbering(rctx, def)?;
            format!("<text:list text:style-name=\"{name}\">")
        }
    };
    if open.ends_with("/>") {
        open = as_open_tag(&open);
    }
    let root_close = format!("</{}>", tag_name_of(&open));

    let mut out = open;
    let mut close_item: Vec<Option<String>> = vec![None];
    let mut depth = 0usize;
    fn set_close(close_item: &mut Vec<Option<String>>, depth: usize, value: Option<String>) {
        while close_item.len() <= depth {
            close_item.push(None);
        }
        close_item[depth] = value;
    }
    fn close_level(out: &mut String, close_item: &mut Vec<Option<String>>, depth: usize) {
        if let Some(Some(close)) = close_item.get(depth) {
            out.push_str(close);
        }
        set_close(close_item, depth, None);
    }
    for e in entries {
        let level = math_max(0.0, math_min(9.0, e.level)) as usize;
        let current_open = close_item
            .get(depth)
            .is_some_and(|c| c.as_deref().is_some_and(|s| !s.is_empty()));
        if e.continuation && current_open && depth == level {
            out.push_str(&e.xml);
            continue;
        }
        while depth > level {
            close_level(&mut out, &mut close_item, depth);
            out.push_str("</text:list>");
            depth -= 1;
        }
        if depth == level {
            close_level(&mut out, &mut close_item, depth);
        }
        while depth < level {
            if !close_item
                .get(depth)
                .is_some_and(|c| c.as_deref().is_some_and(|s| !s.is_empty()))
            {
                out.push_str("<text:list-item>");
                set_close(&mut close_item, depth, Some("</text:list-item>".to_owned()));
            }
            out.push_str("<text:list>");
            depth += 1;
            set_close(&mut close_item, depth, None);
        }
        let mut item_open = if e.header {
            "<text:list-header>".to_owned()
        } else {
            "<text:list-item>".to_owned()
        };
        if let Some(origin) = e.origin.as_ref().filter(|_| !e.continuation) {
            let parent = node_at(rctx, part.xml.to_byte(origin.start)).and_then(|n| n.parent());
            if let Some(parent) = parent
                && parent.kind == OdtNodeKind::ListItem
                && !parent.self_closing
            {
                item_open = start_tag(xml, parent.start);
            }
        }
        out.push_str(&item_open);
        let close = format!("</{}>", tag_name_of(&item_open));
        set_close(&mut close_item, depth, Some(close));
        out.push_str(&e.xml);
    }
    while depth > 0 {
        close_level(&mut out, &mut close_item, depth);
        out.push_str("</text:list>");
        depth -= 1;
    }
    close_level(&mut out, &mut close_item, depth);
    Ok(out + &root_close)
}

/// `group` of `writeTextItems`
struct Group {
    num_id: String,
    entries: Vec<ListEntry>,
}

/// `paragraphBlockOf` of an aligned item, as an owned block.
fn para_block(a: &AlignedItem) -> Option<Block> {
    paragraph_block_of(&a.item.borrow()).cloned()
}

/// `writeTextItems`: writes a run of aligned edited elements that the text owner
/// handles: paragraphs (unchanged ones byte for byte), lists regrouped by
/// `w:numId`, and, for non-paragraph elements met inside, their owners.
pub fn write_text_items(
    rctx: &mut OoxmlToOdfContext,
    items: &[AlignedItem],
    env: &FlowEnv,
) -> Result<String, OdtError> {
    let mut out = String::new();
    let mut group: Option<Group> = None;
    // `paragraphOf`: the paragraph record of a bridge element (an index of `map.elements`)
    fn paragraph_of(rctx: &OoxmlToOdfContext, element: Option<usize>) -> Option<BridgeParagraph> {
        let element = rctx.map.elements.get(element?)?;
        element
            .paragraph
            .and_then(|p| rctx.map.paragraphs.get(p).cloned())
    }
    let mut neighbour: Option<BridgeParagraph> =
        paragraph_of(rctx, env.neighbours.and_then(|n| n.before));
    // the original paragraph directly before (through consecutive new paragraphs)
    let mut follows: Option<BridgeParagraph> = neighbour.clone();
    let part = rctx.part(OdtStylePart::ContentXml);
    let xml: &str = &part.xml.text;
    let placements = sequence_placements(rctx, items)?;
    for (index, a) in items.iter().enumerate() {
        let block = para_block(a);
        let element = a.element.and_then(|e| rctx.map.elements.get(e).cloned());
        let origin: Option<BridgeParagraph> = element
            .as_ref()
            .and_then(|e| e.paragraph)
            .and_then(|p| rctx.map.paragraphs.get(p).cloned());
        let Some(block) = block.filter(|_| {
            !(element
                .as_ref()
                .is_some_and(|e| e.kind != BridgeElementKind::Paragraph)
                || (element.is_some() && origin.is_none()))
        }) else {
            if let Some(g) = group.take() {
                out.push_str(&write_list(rctx, &g.num_id, &g.entries)?);
            }
            follows = None;
            if let Some(element) = &element {
                let owned = rctx.map.blocks[element.block].clone();
                if a.unchanged {
                    out.push_str(&block_source(rctx, &owned));
                } else {
                    let registry = Rc::clone(&rctx.registry);
                    match registry.block_by_id(&owned.owner) {
                        Some(converter) => {
                            out.push_str(&converter.to_odf(
                                rctx,
                                &owned,
                                std::slice::from_ref(a),
                                env,
                            )?);
                        }
                        None => out.push_str(&block_source(rctx, &owned)),
                    }
                }
            } else {
                let registry = Rc::clone(&rctx.registry);
                let writer = registry.free_writer_for(&a.item.borrow());
                match writer.filter(|w| w.id() != TEXT_OWNER) {
                    Some(writer) => {
                        out.push_str(&writer.to_odf(rctx, std::slice::from_ref(&a.item), env)?);
                    }
                    None => {
                        let kind = a
                            .item
                            .borrow()
                            .blocks
                            .first()
                            .and_then(|b| (*b.r#type).as_ref().map(|t| t.as_str().to_owned()))
                            .unwrap_or_else(|| "element".to_owned());
                        rctx.warn(&format!("dropped a new {kind} with no writer"));
                    }
                }
            }
            continue;
        };
        if let Some(origin) = &origin {
            neighbour = Some(origin.clone());
        } else if neighbour.is_none() {
            let next = items[index + 1..].iter().find(|x| {
                x.element
                    .and_then(|e| rctx.map.elements.get(e))
                    .is_some_and(|e| e.paragraph.is_some())
            });
            neighbour = match next {
                Some(next) => paragraph_of(rctx, next.element),
                None => paragraph_of(rctx, env.neighbours.and_then(|n| n.after)),
            };
        }
        let odf = match (&origin, a.unchanged) {
            (Some(origin), true) => slice(
                xml,
                part.xml.to_byte(origin.start),
                part.xml.to_byte(origin.end),
            )
            .to_owned(),
            _ => paragraph_to_odf(
                rctx,
                &edited_paragraph_from_block(&block),
                origin.as_ref(),
                &ParagraphWriteOptions {
                    part: OdtStylePart::ContentXml,
                    neighbour: if origin.is_some() {
                        None
                    } else {
                        neighbour.as_ref()
                    },
                    follows: if origin.is_some() {
                        None
                    } else {
                        follows.as_ref()
                    },
                    placements: placements.get(&index).map(Vec::as_slice),
                },
            )?,
        };
        if let Some(origin) = &origin {
            follows = Some(origin.clone());
        }
        let block_type = (*block.r#type).as_ref();
        let list: Option<(String, f64, bool, bool)> =
            if block_type == Some(&BlockType::ListItem) && block.list.is_some() {
                block
                    .list
                    .as_ref()
                    .map(|l| (l.num_id.clone(), l.ilvl.0, false, false))
            } else if block_type == Some(&BlockType::Paragraph)
                && origin
                    .as_ref()
                    .and_then(|o| o.list.as_ref())
                    .is_some_and(|l| l.header || l.continuation)
            {
                origin
                    .as_ref()
                    .and_then(|o| o.list.as_ref())
                    .map(|l| (l.num_id.clone(), l.level as f64, l.continuation, l.header))
            } else {
                None
            };
        let Some((num_id, level, continuation, header)) = list else {
            if let Some(g) = group.take() {
                out.push_str(&write_list(rctx, &g.num_id, &g.entries)?);
            }
            out.push_str(&odf);
            continue;
        };
        if group.as_ref().is_some_and(|g| g.num_id != num_id)
            && let Some(g) = group.take()
        {
            out.push_str(&write_list(rctx, &g.num_id, &g.entries)?);
        }
        let g = group.get_or_insert_with(|| Group {
            num_id: num_id.clone(),
            entries: Vec::new(),
        });
        g.entries.push(ListEntry {
            level,
            xml: odf,
            continuation,
            header,
            origin,
        });
    }
    if let Some(g) = group.take() {
        out.push_str(&write_list(rctx, &g.num_id, &g.entries)?);
    }
    Ok(out)
}

/// `sequencePlacements`: marker placements for changed original paragraphs that
/// were split (followed by new paragraphs) or joined (followed in the original by
/// deleted paragraphs whose text survives in them), keyed by item index.
fn sequence_placements(
    rctx: &mut OoxmlToOdfContext,
    items: &[AlignedItem],
) -> Result<HashMap<usize, Vec<Placement>>, OdtError> {
    let mut out: HashMap<usize, Vec<Placement>> = HashMap::new();
    for (i, a) in items.iter().enumerate() {
        let origin: Option<BridgeParagraph> = a
            .element
            .and_then(|e| rctx.map.elements.get(e))
            .and_then(|e| e.paragraph)
            .and_then(|p| rctx.map.paragraphs.get(p).cloned());
        let Some(origin) = origin else {
            continue;
        };
        if a.unchanged || para_block(a).is_none() {
            continue;
        }
        let mut pieces = vec![i];
        let mut k = i + 1;
        while k < items.len() && items[k].element.is_none() && para_block(&items[k]).is_some() {
            pieces.push(k);
            k += 1;
        }
        // originals deleted right after this one: joined into it when their text survives
        let mut joined: Vec<BridgeParagraph> = Vec::new();
        let first_element = a.element.unwrap_or(0);
        for e in first_element + 1..rctx.map.elements.len() {
            let element = &rctx.map.elements[e];
            if rctx.matched.contains(&e) {
                break;
            }
            let Some(paragraph) = element.paragraph else {
                break;
            };
            let Some(record) = rctx.map.paragraphs.get(paragraph) else {
                break;
            };
            if record.part != origin.part {
                break;
            }
            joined.push(record.clone());
        }
        if pieces.len() == 1 && joined.is_empty() {
            continue;
        }
        let texts: Vec<String> = pieces
            .iter()
            .map(|k| {
                para_block(&items[*k])
                    .map(|b| {
                        (*b.runs)
                            .as_deref()
                            .unwrap_or(&[])
                            .iter()
                            .map(|r| r.text.as_deref().unwrap_or("").to_owned())
                            .collect::<String>()
                    })
                    .unwrap_or_default()
            })
            .collect();
        // a deleted paragraph whose text did not survive was deleted, not joined
        let mut all: Vec<&BridgeParagraph> = vec![&origin];
        all.extend(joined.iter());
        let kept = kept_characters(&all, &texts);
        let mut originals: Vec<&BridgeParagraph> = vec![&origin];
        let mut warnings: Vec<&str> = Vec::new();
        for (n, p) in joined.iter().enumerate() {
            let len = u16_len(&p.text).0 as usize;
            if len > 0 && kept[n + 1] * 2 >= len {
                originals.push(p);
            } else if kept[n + 1] > 0
                && p.markers.iter().any(|m| {
                    matches!(
                        m.kind,
                        BridgeMarkerKind::Bookmark
                            | BridgeMarkerKind::BookmarkStart
                            | BridgeMarkerKind::BookmarkEnd
                    )
                })
            {
                warnings.push(
                    "bookmarks of a deleted paragraph were dropped although part of its text survives",
                );
            }
        }
        for message in warnings {
            rctx.warn(message);
        }
        let placed = place_markers(rctx, &originals, &texts);
        for (n, k) in pieces.iter().enumerate() {
            out.insert(*k, placed.placements[n].clone());
        }
    }
    Ok(out)
}

/// `textBlockConverter`
pub struct TextBlockConverter;

impl BlockConverter for TextBlockConverter {
    fn id(&self) -> &str {
        TEXT_OWNER
    }

    fn matches(&self, node: &OdtNode, _ctx: &OdfToOoxmlContext) -> bool {
        node.kind == OdtNodeKind::Paragraph
            || node.kind == OdtNodeKind::Heading
            || node.kind == OdtNodeKind::List
    }

    fn to_ooxml(
        &self,
        ctx: &mut OdfToOoxmlContext,
        node: &Rc<OdtNode>,
        env: &BlockEnv,
    ) -> Result<BlockOoxml, OdtError> {
        if node.kind == OdtNodeKind::List {
            return list_to_ooxml(ctx, node, env.block_id);
        }
        let made = paragraph_to_ooxml(
            ctx,
            &node.range(),
            &ParagraphOoxmlOptions {
                part: OdtStylePart::ContentXml,
                block: Some(env.block_id),
                ..Default::default()
            },
        )?;
        Ok(BlockOoxml {
            elements: vec![BlockOoxmlElement {
                xml: made.xml,
                kind: Some(BridgeElementKind::Paragraph),
                paragraph: Some(made.paragraph.id),
            }],
            data: None,
        })
    }

    fn to_odf(
        &self,
        rctx: &mut OoxmlToOdfContext,
        _block: &BridgeBlock,
        items: &[AlignedItem],
        env: &FlowEnv,
    ) -> Result<String, OdtError> {
        write_text_items(rctx, items, env)
    }

    fn absorbs(
        &self,
        _rctx: &mut OoxmlToOdfContext,
        block: &BridgeBlock,
        item: &EditedItem,
    ) -> Result<bool, OdtError> {
        let Some(p) = paragraph_block_of(item) else {
            return Ok(false);
        };
        // a new paragraph next to a paragraph may hold its text (an Enter split):
        // written together so markers can follow the text
        if block.name != "text:list" {
            return Ok(block.kind == OdtNodeKind::Paragraph || block.kind == OdtNodeKind::Heading);
        }
        let num_id = block.data.get("numId").and_then(|v| v.as_str());
        Ok(*p.r#type == Some(BlockType::ListItem)
            && p.list.as_ref().map(|l| l.num_id.as_str()) == num_id)
    }
}

/// `textBlockConverter` as a registerable handler.
pub fn text_block_converter() -> Rc<dyn BlockConverter> {
    Rc::new(TextBlockConverter)
}

/// `textFreeWriter`: new paragraphs (no original) between blocks.
pub struct TextFreeWriter;

impl FreeWriter for TextFreeWriter {
    fn id(&self) -> &str {
        TEXT_OWNER
    }

    fn matches(&self, item: &EditedItem) -> bool {
        paragraph_block_of(item).is_some()
    }

    fn to_odf(
        &self,
        rctx: &mut OoxmlToOdfContext,
        items: &[ItemRef],
        env: &FlowEnv,
    ) -> Result<String, OdtError> {
        let aligned: Vec<AlignedItem> = items
            .iter()
            .map(|item| AlignedItem {
                item: Rc::clone(item),
                element: None,
                unchanged: false,
            })
            .collect();
        write_text_items(rctx, &aligned, env)
    }
}

/// `textFreeWriter` as a registerable handler.
pub fn text_free_writer() -> Rc<dyn FreeWriter> {
    Rc::new(TextFreeWriter)
}

/// `registerTextConverters`: registers the text owner (paragraphs, headings,
/// lists, new paragraphs).
pub fn register_text_converters(registry: &mut ConversionRegistry) -> &mut ConversionRegistry {
    registry.add_block(text_block_converter());
    registry.add_free_writer(text_free_writer())
}
