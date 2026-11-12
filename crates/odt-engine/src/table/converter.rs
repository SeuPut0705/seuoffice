//! `table/converter.ts`: the table owner: the block converter for body-level
//! tables and paragraphs holding framed tables, and the free writer for
//! tables the editor created.

use std::collections::HashMap;
use std::rc::Rc;

use docx_engine::model::{Block, BlockType};
use jscompat::js_regex;

use crate::core::body::{OdtNode, OdtNodeKind};
use crate::core::convert::{
    AlignedItem, BlockConverter, BlockEnv, BlockOoxml, BridgeBlock, BridgeElement,
    BridgeElementKind, EditedItem, FlowEnv, FreeWriter, ItemRef, OdfToOoxmlContext,
    OoxmlToOdfContext,
};
use crate::core::errors::OdtError;
use crate::core::flow::{block_source, paragraph_block_of};
use crate::core::styles::OdtStylePart;
use crate::text::paragraph_odf::{
    ParagraphWriteOptions, edited_paragraph_from_block, paragraph_to_odf,
};

use super::forward::{
    ConvertedTable, FramePartKind, NestedTableResult, TableEnv, convert_frame_host, convert_table,
};
use super::model::{
    ProtectedCellRef, TABLE_OWNER, TableBlockData, TableBlockKind, TableExt, UnitRecord, as_json,
    empty_table_ext,
};
use super::odf_read::frame_host_of;
use super::ooxml_read::{EditedTable, edited_grid, para_text, segment_table};
use super::reverse::{
    FrameHostRange, ParaOutcome, TableOutcome, new_table_odf, table_ext, write_frame_host,
    write_table,
};

/// `publish`: publishes a converted top-level table: its element id, its
/// locked cells.
fn publish(ext: &mut TableExt, converted: &ConvertedTable, element_id: usize) {
    ext.tables[converted.record_id].element_id = Some(element_id);
    ext.elements
        .set(element_id.to_string(), converted.record_id);
    for p in &converted.protected_cells {
        ext.protected_cells.push(ProtectedCellRef {
            table: element_id,
            path: p.path.clone(),
            row: p.row,
            col: p.col,
            tc: p.tc,
        });
    }
}

/// `tableBlockOf`
fn table_block_of(item: &EditedItem) -> Option<&Block> {
    if item.blocks.len() == 1
        && *item.blocks[0].r#type == Some(BlockType::Table)
        && item.blocks[0].table.is_some()
    {
        Some(&item.blocks[0])
    } else {
        None
    }
}

/// `isHostPictureParagraph`: a paragraph holding only pictures comes back from
/// the editor as a picture block that no bookmark ties to its paragraph. When
/// its pictures (`odt-pic:` / `odt-keep:` names) come from the text paragraph
/// of a frame host, it is that paragraph: the host writes it, with the
/// pictures as the objects layer writes them, instead of the paragraph coming
/// out twice (once from the host, once as a new picture paragraph holding the
/// frames again).
fn is_host_picture_paragraph(
    rctx: &OoxmlToOdfContext,
    paragraph: usize,
    item: &EditedItem,
) -> bool {
    if paragraph_block_of(item).is_some()
        || !item.xml.starts_with("<w:p")
        || !item.xml.contains("<w:drawing>")
    {
        return false;
    }
    let objects = rctx.map.ext.get("objects");
    let mut owners: HashMap<String, Option<usize>> = HashMap::new();
    for key in ["pictures", "placeholders"] {
        let list = objects.and_then(|o| o.get(key)).and_then(|l| l.as_array());
        for o in list.into_iter().flatten() {
            if let Some(name) = o.get("name").and_then(|n| n.as_str()) {
                let owner = o
                    .get("paragraph")
                    .and_then(|p| p.as_u64())
                    .map(|p| p as usize);
                owners.insert(name.to_string(), owner);
            }
        }
    }
    let names: Vec<&str> = js_regex!(r#"\bname="(odt-(?:pic|keep):[^"]+)""#)
        .find_iter(&item.xml)
        .filter_map(|m| m.get(1))
        .collect();
    !names.is_empty()
        && names
            .iter()
            .all(|n| owners.get(*n).is_some_and(|o| *o == Some(paragraph)))
}

fn block_data(block: &BridgeBlock) -> Option<TableBlockData> {
    serde_json::from_value(block.data.clone()).ok()
}

/// `tableBlockConverter`
pub struct TableBlockConverter;

/// `tableBlockConverter`
pub fn table_block_converter() -> Rc<dyn BlockConverter> {
    Rc::new(TableBlockConverter)
}

/// `tableFreeWriter`
pub struct TableFreeWriter;

/// `tableFreeWriter`
pub fn table_free_writer() -> Rc<dyn FreeWriter> {
    Rc::new(TableFreeWriter)
}

impl BlockConverter for TableBlockConverter {
    fn id(&self) -> &str {
        TABLE_OWNER
    }

    fn matches(&self, node: &OdtNode, ctx: &OdfToOoxmlContext) -> bool {
        if node.kind == OdtNodeKind::Table {
            return !node.self_closing;
        }
        frame_host_of(node, &ctx.part(OdtStylePart::ContentXml).xml.text).is_some()
    }

    fn to_ooxml(
        &self,
        ctx: &mut OdfToOoxmlContext,
        node: &Rc<OdtNode>,
        env: &BlockEnv,
    ) -> Result<BlockOoxml, OdtError> {
        let slot = ctx.ext_shared(TABLE_OWNER, empty_table_ext);
        let mut ext = slot.borrow_mut();
        if node.kind == OdtNodeKind::Table {
            let converted = convert_table(
                ctx,
                node,
                &mut TableEnv {
                    block_id: env.block_id,
                    ext: &mut ext,
                    host: None,
                    frame: None,
                    align: None,
                    locked: false,
                },
            )?;
            let element = ctx.add_element(
                env.block_id,
                &converted.xml,
                Some(BridgeElementKind::Table),
                None,
            );
            publish(&mut ext, &converted, element);
            let data = TableBlockData {
                kind: TableBlockKind::Table,
                paragraph: None,
                paragraph_first: false,
                tables: vec![converted.record_id],
            };
            return Ok(BlockOoxml {
                elements: Vec::new(),
                data: Some(as_json(&data)),
            });
        }
        let xml = ctx.part(OdtStylePart::ContentXml).xml.clone();
        let host = frame_host_of(node, &xml.text).expect("matches() found a frame host");
        let mut converted: HashMap<usize, ConvertedTable> = HashMap::new();
        let block_id = env.block_id;
        let res = {
            let ext_ref: &mut TableExt = &mut ext;
            convert_frame_host(
                ctx,
                &host,
                block_id,
                &xml,
                &mut |ctx: &mut OdfToOoxmlContext, table, frame, align| {
                    let t = convert_table(
                        ctx,
                        table,
                        &mut TableEnv {
                            block_id,
                            ext: &mut *ext_ref,
                            host: None,
                            frame,
                            align,
                            locked: false,
                        },
                    )?;
                    let out = NestedTableResult {
                        id: t.record_id,
                        xml: t.xml.clone(),
                    };
                    converted.insert(t.record_id, t);
                    Ok(out)
                },
            )?
        };
        let UnitRecord::F {
            paragraph,
            paragraph_first,
            tables,
            ..
        } = &res.unit
        else {
            unreachable!("convertFrameHost answers a frame unit")
        };
        let mut next = 0usize;
        for part in &res.parts {
            let element = ctx.add_element(
                block_id,
                &part.xml,
                Some(match part.kind {
                    FramePartKind::Paragraph => BridgeElementKind::Paragraph,
                    FramePartKind::Table => BridgeElementKind::Table,
                }),
                part.paragraph,
            );
            if part.kind == FramePartKind::Table {
                let id = tables[next];
                next += 1;
                publish(&mut ext, &converted[&id], element);
            }
        }
        let data = TableBlockData {
            kind: TableBlockKind::Frames,
            paragraph: *paragraph,
            paragraph_first: *paragraph_first,
            tables: tables.clone(),
        };
        Ok(BlockOoxml {
            elements: Vec::new(),
            data: Some(as_json(&data)),
        })
    }

    fn to_odf(
        &self,
        rctx: &mut OoxmlToOdfContext,
        block: &BridgeBlock,
        items: &[AlignedItem],
        env: &FlowEnv,
    ) -> Result<String, OdtError> {
        let ext = table_ext(rctx)?;
        let data = block_data(block)
            .ok_or_else(|| OdtError::thrown("odt: the table block holds no table data"))?;
        let mut tables: HashMap<usize, TableOutcome> = HashMap::new();
        for id in &data.tables {
            tables.insert(*id, TableOutcome::Deleted);
        }
        let mut para = if data.paragraph.is_none() {
            ParaOutcome::Unchanged
        } else {
            ParaOutcome::Deleted
        };
        let mut extra: Vec<ItemRef> = Vec::new();
        let registry = rctx.registry.clone();
        for a in items {
            let element: Option<BridgeElement> =
                a.element.and_then(|id| rctx.map.elements.get(id).cloned());
            if element.is_none()
                && data.kind == TableBlockKind::Frames
                && matches!(para, ParaOutcome::Deleted)
                && let Some(paragraph) = data.paragraph
                && is_host_picture_paragraph(rctx, paragraph, &a.item.borrow())
            {
                let writer = registry.free_writer_for(&a.item.borrow());
                if let Some(writer) = writer {
                    let xml = writer.to_odf(rctx, std::slice::from_ref(&a.item), env)?;
                    para = ParaOutcome::Changed { xml };
                    continue;
                }
            }
            let Some(element) = element.filter(|e| e.block == block.id) else {
                extra.push(a.item.clone());
                continue;
            };
            let item = a.item.borrow();
            if element.kind == BridgeElementKind::Table {
                let id = ext.elements.get(&element.id.to_string()).copied();
                let Some(id) = id else { continue };
                let Some(rec) = ext.tables.get(id) else {
                    continue;
                };
                let edited = table_block_of(&item);
                if a.unchanged {
                    tables.insert(id, TableOutcome::Unchanged);
                } else if let Some(model) = edited.and_then(|b| b.table.as_ref()) {
                    let res = write_table(
                        rctx,
                        &ext,
                        rec,
                        &EditedTable {
                            model,
                            ox: segment_table(&item.xml),
                        },
                        Some(&segment_table(&element.xml)),
                    )?;
                    tables.insert(
                        id,
                        if res.changed {
                            TableOutcome::Result(res)
                        } else {
                            TableOutcome::Unchanged
                        },
                    );
                } else {
                    rctx.warn("a table came back as something else; the original table was kept");
                    tables.insert(id, TableOutcome::Unchanged);
                }
            } else if data.paragraph.is_some() && element.paragraph == data.paragraph {
                let origin = data
                    .paragraph
                    .and_then(|p| rctx.map.paragraphs.get(p).cloned());
                let p = paragraph_block_of(&item);
                match (p, origin) {
                    (Some(p), Some(origin)) if !a.unchanged => {
                        let xml = paragraph_to_odf(
                            rctx,
                            &edited_paragraph_from_block(p),
                            Some(&origin),
                            &ParagraphWriteOptions {
                                part: OdtStylePart::ContentXml,
                                neighbour: None,
                                follows: None,
                                placements: None,
                            },
                        )?;
                        let content = rctx.part(OdtStylePart::ContentXml).xml.clone();
                        let source = &content.text
                            [content.to_byte(origin.start)..content.to_byte(origin.end)];
                        para = if xml == source {
                            ParaOutcome::Unchanged
                        } else {
                            ParaOutcome::Changed { xml }
                        };
                    }
                    _ => para = ParaOutcome::Unchanged,
                }
            }
        }
        let mut out: String;
        if data.kind == TableBlockKind::Table {
            let r = data.tables.first().and_then(|t| tables.get(t));
            out = match r {
                Some(TableOutcome::Deleted) => String::new(),
                None | Some(TableOutcome::Unchanged) => block_source(rctx, block),
                Some(TableOutcome::Result(r)) => r.xml.clone(),
            };
        } else {
            out = write_frame_host(
                rctx,
                &ext,
                &FrameHostRange {
                    start: block.start,
                    end: block.end,
                    paragraph: data.paragraph,
                    tables: data.tables.clone(),
                },
                &para,
                &tables,
            )?
            .xml;
        }
        if !extra.is_empty() {
            if data.kind == TableBlockKind::Frames {
                rctx.warn("content inserted among the tables of one frame paragraph was placed after them");
            }
            let writers: Vec<Option<Rc<dyn FreeWriter>>> = extra
                .iter()
                .map(|e| registry.free_writer_for(&e.borrow()))
                .collect();
            let same = |a: &Option<Rc<dyn FreeWriter>>, b: &Option<Rc<dyn FreeWriter>>| match (a, b)
            {
                (None, None) => true,
                (Some(a), Some(b)) => {
                    std::ptr::eq(Rc::as_ptr(a) as *const (), Rc::as_ptr(b) as *const ())
                }
                _ => false,
            };
            let mut k = 0usize;
            while k < extra.len() {
                let writer = &writers[k];
                let mut m = k + 1;
                while m < extra.len() && same(&writers[m], writer) {
                    m += 1;
                }
                match writer {
                    Some(writer) => out.push_str(&writer.to_odf(rctx, &extra[k..m], env)?),
                    None => rctx.warn(&format!(
                        "dropped a new {} with no writer",
                        extra[k]
                            .borrow()
                            .blocks
                            .first()
                            .and_then(|b| (*b.r#type).as_ref().map(BlockType::as_str))
                            .unwrap_or("element")
                    )),
                }
                k = m;
            }
        }
        Ok(out)
    }

    fn absorbs(
        &self,
        rctx: &mut OoxmlToOdfContext,
        block: &BridgeBlock,
        item: &EditedItem,
    ) -> Result<bool, OdtError> {
        let data = block_data(block);
        Ok(match data {
            Some(data) if data.kind == TableBlockKind::Frames => match data.paragraph {
                Some(paragraph) => is_host_picture_paragraph(rctx, paragraph, item),
                None => false,
            },
            _ => false,
        })
    }

    fn identify(
        &self,
        rctx: &mut OoxmlToOdfContext,
        item: &EditedItem,
        candidates: &[BridgeElement],
    ) -> Result<Option<usize>, OdtError> {
        let Some(model) = table_block_of(item).and_then(|b| b.table.as_ref()) else {
            return Ok(None);
        };
        let tables: Vec<&BridgeElement> = candidates
            .iter()
            .filter(|c| c.kind == BridgeElementKind::Table)
            .collect();
        if tables.len() <= 1 {
            return Ok(tables.first().map(|t| t.id));
        }
        let ext = table_ext(rctx)?;
        let ox = segment_table(&item.xml);
        let grid = edited_grid(model, &ox);
        let mut best = tables[0].id;
        let mut best_score: i64 = -1;
        for c in &tables {
            let Some(rec) = ext
                .elements
                .get(&c.id.to_string())
                .and_then(|id| ext.tables.get(*id))
            else {
                continue;
            };
            let mut score: i64 = if grid.rows == rec.rows.len() { 1 } else { 0 };
            for a in &grid.anchors {
                let Some(super::model::CellRecord::Cell(cell)) =
                    rec.cells.get(a.row).and_then(|row| row.get(a.col))
                else {
                    continue;
                };
                let text = cell
                    .units
                    .iter()
                    .map(|u| match u {
                        UnitRecord::P { paragraph, .. } => rctx
                            .map
                            .paragraphs
                            .get(*paragraph)
                            .map_or("", |p| p.text.as_str()),
                        _ => "",
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let mine = a
                    .cell
                    .rich_paras
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .map(|p| para_text(Some(p)))
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.is_empty() && text == mine {
                    score += 2;
                }
            }
            if score > best_score {
                best_score = score;
                best = c.id;
            }
        }
        Ok(Some(best))
    }

    fn has_identify(&self) -> bool {
        true
    }
}

impl FreeWriter for TableFreeWriter {
    fn id(&self) -> &str {
        TABLE_OWNER
    }

    fn matches(&self, item: &EditedItem) -> bool {
        table_block_of(item).is_some()
    }

    fn to_odf(
        &self,
        rctx: &mut OoxmlToOdfContext,
        items: &[ItemRef],
        _env: &FlowEnv,
    ) -> Result<String, OdtError> {
        let mut out = String::new();
        for item in items {
            let item = item.borrow();
            if let Some(model) = table_block_of(&item).and_then(|b| b.table.as_ref()) {
                out.push_str(&new_table_odf(
                    rctx,
                    &EditedTable {
                        model,
                        ox: segment_table(&item.xml),
                    },
                )?);
            }
        }
        Ok(out)
    }
}
