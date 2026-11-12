//! `applyTocEntryNumbers` of parse-fields.ts.

use jscompat::{JsMap, JsNum, Radix, js_regex, parse_int};

use crate::list_markers::{ListItemRef, compute_list_markers};
use crate::model::{Block, BlockType};
use crate::numbering::NumberingDef;

/// `applyTocEntryNumbers`: TOC entries carry their outline number ("1.",
/// "1.1.") as w:numPr numbering; the marker is computed once at parse time
/// and stored on the tocLine FieldDisplay. Counters run document-wide in
/// block order, shared with editable list items.
pub fn apply_toc_entry_numbers(blocks: &mut [Block], numbering: &JsMap<NumberingDef>) {
    if numbering.is_empty() {
        return;
    }
    let mut items: Vec<ListItemRef> = Vec::new();
    let mut toc_at: Vec<(usize, usize)> = Vec::new();
    for (block_index, block) in blocks.iter().enumerate() {
        let list = match block.list.as_ref() {
            Some(list) if !list.num_id.is_empty() => Some((list.num_id.clone(), list.ilvl)),
            _ => block
                .stray_list
                .as_ref()
                .filter(|list| !list.num_id.is_empty())
                .map(|list| (list.num_id.clone(), list.ilvl)),
        };
        if let Some((num_id, ilvl)) = list {
            items.push(ListItemRef {
                num_id: Some(num_id),
                ilvl,
                deleted: None,
            });
            continue;
        }
        let is_toc = block
            .field_display
            .as_ref()
            .is_some_and(|fd| fd.kind == crate::model::FieldDisplayKind::TocLine);
        let original = (*block.original_xml).clone().flatten();
        if *block.r#type != Some(BlockType::Passthrough) || !is_toc {
            continue;
        }
        let Some(original) = original.filter(|xml| !xml.is_empty()) else {
            continue;
        };
        let Some(num_pr) = js_regex!(r"<w:numPr>[\s\S]*?<\/w:numPr>").exec(&original) else {
            continue;
        };
        let num_pr = num_pr.as_str();
        let Some(num_id) = js_regex!(r#"<w:numId w:val="([^"]+)""#)
            .exec(num_pr)
            .and_then(|found| found.get(1))
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let ilvl = parse_int(
            js_regex!(r#"<w:ilvl w:val="(\d+)""#)
                .exec(num_pr)
                .and_then(|found| found.get(1))
                .unwrap_or("0"),
            Radix::Ten,
        );
        toc_at.push((items.len(), block_index));
        items.push(ListItemRef {
            num_id: Some(num_id.to_owned()),
            ilvl: JsNum(ilvl),
            deleted: None,
        });
    }
    if toc_at.is_empty() {
        return;
    }
    let markers = compute_list_markers(&items, numbering);
    for (item_index, block_index) in toc_at {
        let marker = markers
            .get(item_index)
            .and_then(|m| m.clone())
            .filter(|m| !m.is_empty());
        // bullets make no sense in front of a TOC entry; only ordered markers show
        if let Some(marker) = marker
            && !js_regex!(r"^[\u2022\u25e6\u25aa\u27a2\u2756\u2713]$").test(&marker)
            && let Some(fd) = blocks[block_index].field_display.as_mut()
        {
            fd.num = Some(marker);
        }
    }
}
