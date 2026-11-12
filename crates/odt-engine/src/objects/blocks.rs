//! `objects/blocks.ts`: block-level objects and picture paragraphs.
//!
//! - Block converter (`objects`): tables of contents and other indexes, frames
//!   and shapes standing directly in the flow, and paragraphs holding a
//!   tracked-change range each become ONE locked placeholder paragraph. Save:
//!   while the placeholder is present the block is written back as it was
//!   (resizes ignored); a deleted placeholder deletes the block.
//! - Free writer (`objects`): a paragraph holding only pictures comes back from
//!   the editor as a picture block rather than a paragraph, so a changed one
//!   (resized, replaced) no longer pairs with its bridge paragraph. It is
//!   written here: the original paragraph with the picture re-written when it
//!   held nothing else, else through the text layer with the original
//!   paragraph (found by the picture's name) as origin. New picture paragraphs
//!   are written the same way without an origin.

use docx_engine::model::{BlockType, Run, RunImage};
use std::rc::Rc;

use jscompat::{JsNum, js_regex, math_max, math_round};

use crate::core::body::{OdtNode, OdtNodeKind, nodes_of_kind, walk_nodes};
use crate::core::convert::{
    AlignedItem, BlockConverter, BlockEnv, BlockOoxml, BridgeBlock, BridgeElement,
    BridgeElementKind, BridgeMarkerKind, BridgeParagraph, EditedItem, EditedParagraph,
    EditedParagraphType, FlowEnv, FreeWriter, ItemRef, OdfToOoxmlContext, OoxmlToOdfContext,
};
use crate::core::errors::OdtError;
use crate::core::flow::{block_source, paragraph_block_of};
use crate::core::styles::OdtStylePart;
use crate::core::xml::{ElementFrame, ElementVisitor, OpenVerdict, walk_elements};
use crate::offset::{U16, u16_len};
use crate::text::paragraph_model::{ReadParagraphOptions, ReadParagraphSource, read_paragraph};
use crate::text::paragraph_odf::{ParagraphWriteOptions, paragraph_to_odf};
use crate::text::styles::read_ooxml_p_pr;

use super::analyze::{
    AnalysisPreview, AnalysisType, ObjectElement, analyze_object, anchor_of, text_width_emu,
};
use super::geometry::{DrawingAnchor, EMU_PER_CM, drawings_of, read_drawing};
use super::model::{
    OBJECTS_OWNER, ObjectKind, ObjectPlaceholder, keep_name, parse_keep_name, parse_picture_name,
};
use super::pictures::{placeholder_drawing, write_drawing};
use super::state::{forward_state, save_state, slice_u16};

/// `LINE`
fn line() -> f64 {
    math_round(0.6 * EMU_PER_CM)
}

/// `hasTable`
fn has_table(node: &OdtNode) -> bool {
    let mut found = false;
    walk_nodes(&node.children, |n| {
        if n.kind == OdtNodeKind::Table {
            found = true;
        }
        !found
    });
    found
}

/// `hasTrackedRange`: a paragraph holding a tracked-change range
/// (`text:change-start`).
fn has_tracked_range(ctx: &OdfToOoxmlContext, node: &OdtNode) -> bool {
    let st = forward_state(ctx);
    let doc = ctx.doc.clone();
    if st.borrow().change_starts.is_none() {
        let starts: Vec<usize> = js_regex!(r":change-start\b", "g")
            .find_iter(&doc.content_xml.text)
            .map(|m| m.start())
            .collect();
        st.borrow_mut().change_starts = Some(starts);
    }
    {
        let st = st.borrow();
        let starts = st.change_starts.as_deref().unwrap_or_default();
        if starts.is_empty() {
            return false;
        }
        let (mut lo, mut hi) = (0usize, starts.len());
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if starts[mid] < node.start {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo >= starts.len() || starts[lo] >= node.end || has_table(node) {
            return false;
        }
    }
    struct Find {
        found: bool,
    }
    impl ElementVisitor for Find {
        type Data = ();

        fn open(
            &mut self,
            el: &mut ElementFrame<()>,
            _parent: Option<&ElementFrame<()>>,
        ) -> OpenVerdict {
            if el.name == "text:change-start" {
                self.found = true;
                return OpenVerdict::Stop;
            }
            OpenVerdict::Continue
        }
    }
    let mut find = Find { found: false };
    walk_elements(
        &doc.content_xml.text,
        &doc.body.prefixes,
        &mut find,
        node.open_end,
        node.close_start,
    );
    find.found
}

/// `objectsBlockConverter`
pub struct ObjectsBlockConverter;

impl BlockConverter for ObjectsBlockConverter {
    fn id(&self) -> &str {
        OBJECTS_OWNER
    }

    fn matches(&self, node: &OdtNode, ctx: &OdfToOoxmlContext) -> bool {
        match node.kind {
            OdtNodeKind::Index => true,
            OdtNodeKind::Frame | OdtNodeKind::Shape => !has_table(node),
            OdtNodeKind::Paragraph | OdtNodeKind::Heading => {
                !node.self_closing && has_tracked_range(ctx, node)
            }
            _ => false,
        }
    }

    fn to_ooxml(
        &self,
        ctx: &mut OdfToOoxmlContext,
        node: &Rc<OdtNode>,
        env: &BlockEnv,
    ) -> Result<BlockOoxml, OdtError> {
        let st = forward_state(ctx);
        let id = {
            let mut st = st.borrow_mut();
            st.seq += 1;
            st.seq.to_string()
        };
        let info = ctx.part(OdtStylePart::ContentXml);
        let doc = ctx.doc.clone();
        let kind: ObjectKind;
        let mut width = text_width_emu(&doc);
        let height: f64;
        let mut preview: Option<AnalysisPreview> = None;
        let mut entries: Vec<String> = Vec::new();
        let mut final_text: Option<String> = None;
        let mut anchor: Option<DrawingAnchor> = None;
        match node.kind {
            OdtNodeKind::Index => {
                kind = if node.name == "text:table-of-content" {
                    ObjectKind::Toc
                } else {
                    ObjectKind::Object
                };
                height = math_max(
                    EMU_PER_CM,
                    nodes_of_kind(&node.children, OdtNodeKind::Paragraph).len() as f64 * line(),
                );
            }
            OdtNodeKind::Paragraph | OdtNodeKind::Heading => {
                kind = ObjectKind::Revision;
                let text = read_paragraph(
                    &ReadParagraphSource {
                        info: &info,
                        styles: &doc.styles,
                    },
                    node.range(),
                    ReadParagraphOptions::default(),
                )?
                .text;
                height = math_max(1.0, (f64::from(u16_len(&text).0) / 40.0).ceil()) * line();
                final_text = Some(text);
            }
            _ => {
                let a = analyze_object(
                    &doc,
                    OdtStylePart::ContentXml,
                    &info.xml.text,
                    &info.prefixes,
                    &ObjectElement {
                        name: &node.name,
                        start: node.start,
                        name_end: node.name_end,
                        open_end: node.open_end,
                        close_start: node.close_start,
                    },
                );
                kind = if a.r#type == AnalysisType::Picture {
                    ObjectKind::Object
                } else {
                    a.kind
                };
                width = a.width_emu;
                height = a.height_emu;
                preview = match a.preview {
                    Some(preview) => Some(preview),
                    None => a.image.as_ref().map(|image| AnalysisPreview {
                        bytes: image.bytes.clone(),
                        format: image.format.clone(),
                    }),
                };
                entries = a.entries.clone();
                anchor = anchor_of(&doc, OdtStylePart::ContentXml, &a.anchor);
            }
        }
        let mut placeholder = ObjectPlaceholder {
            id: id.clone(),
            kind,
            name: keep_name(&id, kind),
            part: OdtStylePart::ContentXml,
            start: info.xml.to_u16(node.start),
            end: info.xml.to_u16(node.end),
            paragraph: None,
            block: Some(env.block_id),
            element: None,
            width_emu: JsNum(width),
            height_emu: JsNum(height),
            preview: preview.is_some(),
            entries,
            final_text,
        };
        let xml = format!(
            "<w:p><w:r>{}</w:r></w:p>",
            placeholder_drawing(ctx, &placeholder, preview.as_ref(), anchor.as_ref())
        );
        placeholder.element =
            Some(ctx.add_element(env.block_id, &xml, Some(BridgeElementKind::Other), None));
        st.borrow_mut().ext.placeholders.push(placeholder);
        if kind == ObjectKind::Revision {
            ctx.warn(
                "a paragraph with tracked changes is shown locked (its final text is in the map)",
            );
        }
        Ok(BlockOoxml {
            elements: Vec::new(),
            data: None,
        })
    }

    fn to_odf(
        &self,
        rctx: &mut OoxmlToOdfContext,
        block: &BridgeBlock,
        _items: &[AlignedItem],
        _env: &FlowEnv,
    ) -> Result<String, OdtError> {
        // only reached while the placeholder is present (resized or moved): kept as it was
        save_state(rctx)?
            .borrow_mut()
            .emitted_blocks
            .insert(block.id);
        Ok(block_source(rctx, block))
    }

    fn identify(
        &self,
        rctx: &mut OoxmlToOdfContext,
        item: &EditedItem,
        candidates: &[BridgeElement],
    ) -> Result<Option<usize>, OdtError> {
        for d in drawings_of(&item.xml) {
            let name = read_drawing(&d).name;
            let keep = name.as_deref().and_then(parse_keep_name);
            let element = match keep {
                Some(keep) => save_state(rctx)?
                    .borrow()
                    .placeholder(&keep.id)
                    .and_then(|p| p.element),
                None => None,
            };
            if let Some(element) = element {
                if candidates.iter().any(|c| c.id == element) {
                    return Ok(Some(element));
                }
            }
        }
        Ok(None)
    }

    fn has_identify(&self) -> bool {
        true
    }
}

// ---------------------------------------------------------------------------
// Picture paragraphs

/// The original paragraph and object a picture item continues: `hostOf`'s
/// `{ paragraph, start, end }`.
struct Host {
    paragraph: BridgeParagraph,
    start: U16,
    end: U16,
}

/// `hostOf`: the original paragraph and object a picture item continues, when
/// it is free to continue it.
fn host_of(rctx: &OoxmlToOdfContext, drawing: &str) -> Result<Option<Host>, OdtError> {
    let st = save_state(rctx)?;
    let name = read_drawing(drawing).name.unwrap_or_default();
    let keep = parse_keep_name(&name);
    let pic_id = parse_picture_name(&name);
    // (paragraph, start, end) of the placeholder or picture
    let object: Option<(Option<usize>, U16, U16)> = {
        let st = st.borrow();
        match (keep, pic_id) {
            (Some(keep), _) => st
                .placeholder(&keep.id)
                .map(|p| (p.paragraph, p.start, p.end)),
            (None, Some(id)) => st.picture(&id).map(|p| (p.paragraph, p.start, p.end)),
            (None, None) => None,
        }
    };
    let Some((Some(paragraph_id), start, end)) = object else {
        return Ok(None);
    };
    let Some(paragraph) = rctx.map.paragraphs.get(paragraph_id).cloned() else {
        return Ok(None);
    };
    if st.borrow().claimed_hosts.contains(&paragraph.id) {
        return Ok(None);
    }
    let element = rctx
        .map
        .elements
        .iter()
        .find(|e| e.paragraph == Some(paragraph.id));
    // the host paragraph lives on as another edited element: this picture moved out of it
    Ok(match element {
        Some(element) if !rctx.matched.contains(&element.id) => Some(Host {
            paragraph,
            start,
            end,
        }),
        _ => None,
    })
}

/// `writeImageItem`
fn write_image_item(
    rctx: &mut OoxmlToOdfContext,
    item: &EditedItem,
    env: &FlowEnv,
) -> Result<String, OdtError> {
    let st = save_state(rctx)?;
    let drawings = drawings_of(&item.xml);
    if drawings.is_empty() {
        return Ok(String::new());
    }
    // a block placeholder (table of contents ...) that did not pair by itself
    if drawings.len() == 1 {
        let name = read_drawing(&drawings[0]).name;
        let keep = name.as_deref().and_then(parse_keep_name);
        let block = keep.and_then(|keep| st.borrow().placeholder(&keep.id).and_then(|p| p.block));
        if let Some(block) = block {
            if st.borrow().emitted_blocks.contains(&block) {
                return Ok(String::new());
            }
            st.borrow_mut().emitted_blocks.insert(block);
            let block = rctx.map.blocks[block].clone();
            return Ok(block_source(rctx, &block));
        }
    }
    let p_pr = js_regex!(r"^<w:p\b[^>]*>\s*(<w:pPr>[\s\S]*?</w:pPr>)")
        .exec(&item.xml)
        .and_then(|m| m.get(1))
        .unwrap_or("")
        .to_string();
    let host = host_of(rctx, &drawings[0])?;
    let data_url: Option<String> = item
        .blocks
        .first()
        .and_then(|b| b.image_data_url.as_ref().cloned());
    if let Some(host) = &host {
        st.borrow_mut().claimed_hosts.insert(host.paragraph.id);
    }
    let origin: Option<BridgeParagraph> = host.as_ref().map(|h| h.paragraph.clone());
    let info = rctx.part(OdtStylePart::ContentXml);
    let xml = &info.xml;
    // the paragraph held only this object and keeps its format: everything else as it was
    if let (Some(host), Some(origin)) = (&host, &origin) {
        if drawings.len() == 1
            && origin.text.is_empty()
            && p_pr == origin.p_pr
            && origin
                .markers
                .iter()
                .filter(|m| m.kind == BridgeMarkerKind::Handler)
                .count()
                == 1
        {
            let drawing = write_drawing(rctx, &drawings[0], data_url.as_deref(), origin.part)?;
            return Ok(format!(
                "{}{}{}",
                slice_u16(xml, origin.start, host.start),
                drawing,
                slice_u16(xml, host.end, origin.end)
            ));
        }
    }
    let runs: Vec<Run> = drawings
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let mut run = Run::default();
            run.text.set(String::new());
            run.image.set(RunImage {
                data_url: if i == 0 {
                    data_url.clone().unwrap_or_default()
                } else {
                    String::new()
                },
                xml: d.clone(),
                ..Default::default()
            });
            run
        })
        .collect();
    let style_id = js_regex!(r#"<w:pStyle w:val="([^"]*)""#)
        .exec(&p_pr)
        .and_then(|m| m.get(1))
        .and_then(|id| jscompat::truthy(Some(id)))
        .map(str::to_string);
    let para = EditedParagraph {
        r#type: EditedParagraphType::Paragraph,
        runs,
        raw_p_pr: Some(p_pr.clone()),
        format: Some(read_ooxml_p_pr(&p_pr)),
        style_id,
        level: None,
        outline_only: None,
        list: None,
        hidden_bookmarks: None,
    };
    // `env.neighbours?.before?.paragraph`: the neighbours are indexes of `map.elements`
    let before = env
        .neighbours
        .and_then(|n| n.before)
        .and_then(|e| rctx.map.elements.get(e))
        .and_then(|e| e.paragraph);
    let after = env
        .neighbours
        .and_then(|n| n.after)
        .and_then(|e| rctx.map.elements.get(e))
        .and_then(|e| e.paragraph);
    let neighbour: Option<BridgeParagraph> = match (before, after) {
        (Some(before), _) => rctx.map.paragraphs.get(before).cloned(),
        (None, Some(after)) => rctx.map.paragraphs.get(after).cloned(),
        (None, None) => None,
    };
    let follows: Option<BridgeParagraph> = match (&origin, before) {
        (None, Some(before)) => rctx.map.paragraphs.get(before).cloned(),
        _ => None,
    };
    paragraph_to_odf(
        rctx,
        &para,
        origin.as_ref(),
        &ParagraphWriteOptions {
            part: OdtStylePart::ContentXml,
            neighbour: if origin.is_some() {
                None
            } else {
                neighbour.as_ref()
            },
            follows: follows.as_ref(),
            ..Default::default()
        },
    )
}

/// `objectsFreeWriter`
pub struct ObjectsFreeWriter;

impl FreeWriter for ObjectsFreeWriter {
    fn id(&self) -> &str {
        OBJECTS_OWNER
    }

    fn matches(&self, item: &EditedItem) -> bool {
        if paragraph_block_of(item).is_some()
            || !item.xml.starts_with("<w:p")
            || !item.xml.contains("<w:drawing>")
        {
            return false;
        }
        item.blocks
            .first()
            .is_some_and(|b| matches!(*b.r#type, Some(BlockType::Image)))
            || js_regex!(r#"\bname="odt-(?:keep|pic):"#).test(&item.xml)
    }

    fn to_odf(
        &self,
        rctx: &mut OoxmlToOdfContext,
        items: &[ItemRef],
        env: &FlowEnv,
    ) -> Result<String, OdtError> {
        let mut out = String::new();
        for item in items {
            out.push_str(&write_image_item(rctx, &item.borrow(), env)?);
        }
        Ok(out)
    }
}
