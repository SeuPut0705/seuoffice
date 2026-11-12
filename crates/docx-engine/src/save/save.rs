//! The entry point of the write side and the helpers of patch.ts it owns:
//! `saveDocx` ported in phases (`plan`, `body`, `finish`) over the state in
//! `saver`.

pub mod body;
pub mod external;
pub mod finish;
pub mod helpers;
pub mod js;
pub mod notes_write;
pub mod plan;
pub mod run_picture;
pub mod saver;
pub mod section_write;
pub mod types;
pub mod xml_number_usable;

use std::collections::HashMap;

use jscompat::number_to_string;
use ooxml_pkg::load_docx_package;

use self::external::{
    CUSTOM_PROPERTIES_PATH, CUSTOM_PROPERTIES_REL_TYPE, built_in_heading_style_upsert,
    patch_zotero_document_data_xml, plan_remove_parts, remove_parts_refusal_message_for,
};
use self::helpers::{
    BookmarkIds, RevisionIds, default_paragraph_style_id, has_orphan_move_ranges, max_rel_id,
    missing_heading_levels, next_doc_pr_seq, next_image_seq, story_parts_xml,
};
use self::saver::{EMPTY_RELS_NONE, Outputs, Saver, Utf16Index};
pub use self::types::{
    ExtentPx, ReplaceImage, RevisionKind, SaveBlock, SaveBlockKind, SaveOptions, SaveRevision,
};
use crate::inline_opaque::{ContentControlPart, part_namespaces};
use crate::model::{MapEntries, ParsedDocFull};
use crate::package::resolve_main_document_path;

/// Whether the save changes nothing: the blocks are the original visible
/// ones in order and no option asks for a change.
fn is_unchanged(parsed: &ParsedDocFull, blocks: &[SaveBlock], options: &SaveOptions) -> bool {
    let visible: Vec<Option<f64>> = parsed
        .blocks
        .iter()
        .filter(|b| *b.hidden != Some(true))
        .map(|b| (*b.docx_index).flatten().map(|n| n.0))
        .collect();
    let blocks_same = blocks.len() == visible.len()
        && blocks.iter().zip(&visible).all(|(fb, original)| {
            matches!(&fb.kind, SaveBlockKind::Original { docx_index } if Some(docx_index.0) == *original)
                && fb.revision.is_none()
        });
    let empty = |len: Option<usize>| len.is_none_or(|len| len == 0);
    blocks_same
        && options.section.is_none()
        && options.trailing_sect_pr.is_none()
        && options.trailing_sect_pr_change.is_none()
        && options.zotero_document_data.is_none()
        && options.section_start_type.is_none()
        && options.pg_num_type.is_none()
        && options.page_color.is_none()
        && options.header.is_none()
        && options.footer.is_none()
        && options.header_first.is_none()
        && options.footer_first.is_none()
        && options.header_even.is_none()
        && options.footer_even.is_none()
        && options.title_pg.is_none()
        && empty(options.section_hf.as_ref().map(Vec::len))
        && empty(options.section_hf_unlink.as_ref().map(Vec::len))
        && options.numbering.is_none()
        && options.default_fonts.is_none()
        && empty(options.style_upserts.as_ref().map(Vec::len))
        && options.even_and_odd_headers.is_none()
        && options.mirror_margins.is_none()
        && options.track_revisions.is_none()
        && options.comments.is_none()
        && options.protection.is_none()
        && options.write_protection.is_none()
        && options.remove_personal_info.is_none()
        && options.footnotes.is_none()
        && options.endnotes.is_none()
        && options.watermark.is_none()
        && options.inks.is_none()
        && options.sources.is_none()
        && options.theme_fonts.is_none()
        && options.theme_colors.is_none()
        && options.properties.is_none()
        && options.content_controls.is_none()
        && empty(options.part_xml.as_ref().map(|map| map.len()))
        && empty(options.part_binary.as_ref().map(|map| map.len()))
}

/// `saveDocx`: paragraph-patch save.
///
/// Blocks marked `original` are copied as the exact substring of the
/// original word/document.xml; `generated` blocks become fresh OOXML
/// fragments referencing only styles that exist in the document (a heading
/// level the document has no style for gets Word's built-in definition);
/// `xml` blocks are inserted verbatim; `image` blocks add media entries and
/// relationships. Every other entry is copied without modification. If
/// nothing changed at all the original bytes are returned untouched.
/// `now_ms` stands for the clock (`new Date()`): the save time of
/// core.xml when `savedAt` is absent and the date stamped on the entries.
pub fn save_docx(
    parsed: &ParsedDocFull,
    blocks: &[SaveBlock],
    options: &SaveOptions,
    now_ms: f64,
) -> Result<Vec<u8>, String> {
    let original_bytes = &parsed.internal.original_bytes.0;
    let scrub_personal_info = options
        .remove_personal_info
        .unwrap_or(parsed.remove_personal_info);

    let mut preloaded = None;
    if is_unchanged(parsed, blocks, options) && !scrub_personal_info {
        // remove_parts or the orphan move-range sweep may be the only requested change: when
        // neither finds anything the original bytes are the right answer
        let mut pending = false;
        if let Some(remove) = &options.remove_parts {
            let plan = plan_remove_parts(original_bytes, remove)?;
            if !plan.refused_paths.is_empty() {
                return Err(remove_parts_refusal_message_for(&plan.refused_paths));
            }
            pending = !plan.removed_paths.is_empty();
        }
        if !pending && options.drop_orphan_move_ranges == Some(true) {
            let zip = load_docx_package(original_bytes)?;
            let doc_path =
                resolve_main_document_path(&zip)?.unwrap_or_else(|| "word/document.xml".to_owned());
            pending = has_orphan_move_ranges(&zip, &doc_path)?;
            preloaded = Some(zip);
        }
        if !pending {
            return Ok(original_bytes.clone());
        }
    }

    let zip = match preloaded {
        Some(zip) => zip,
        None => load_docx_package(original_bytes)?,
    };
    // the declared sizes were already checked as the package loaded
    let doc_path =
        resolve_main_document_path(&zip)?.unwrap_or_else(|| "word/document.xml".to_owned());
    let document_xml: &str = &parsed.internal.document_xml;

    let custom_properties_entry = zip
        .text(CUSTOM_PROPERTIES_PATH)
        .map_err(|e| e.to_string())?
        .map(str::to_owned);
    let custom_entry_present = zip.file(CUSTOM_PROPERTIES_PATH).is_some();
    let should_write_zotero = options
        .zotero_document_data
        .as_deref()
        .is_some_and(|data| !data.is_empty() || custom_entry_present);
    let custom_properties_xml = if should_write_zotero {
        Some(patch_zotero_document_data_xml(
            custom_properties_entry.as_deref(),
            options.zotero_document_data.as_deref().unwrap_or_default(),
        )?)
    } else {
        None
    };
    let custom_properties_is_new = custom_properties_xml.is_some() && !custom_entry_present;
    let mut root_rels_xml: Option<String> = None;
    if custom_properties_is_new
        && let Some(text) = zip.text("_rels/.rels").map_err(|e| e.to_string())?
    {
        let mut xml = text.to_owned();
        if !xml.contains(CUSTOM_PROPERTIES_REL_TYPE) {
            let r_id = format!("rId{}", number_to_string(max_rel_id(Some(&xml))? + 1.0));
            xml = jscompat::replace_first_string(
                &xml,
                "</Relationships>",
                &format!(
                    "<Relationship Id=\"{r_id}\" Type=\"{CUSTOM_PROPERTIES_REL_TYPE}\" Target=\"{CUSTOM_PROPERTIES_PATH}\"/></Relationships>"
                ),
            );
        }
        root_rels_xml = Some(xml);
    }

    // relationship allocation for newly created hyperlinks and images
    let rels_path = match doc_path.rfind('/') {
        Some(at) => format!("{}/_rels/{}.rels", &doc_path[..at], &doc_path[at + 1..]),
        None => format!("_rels/{doc_path}.rels"),
    };
    let rels_present = zip.file(&rels_path).is_some();
    // fall back to an empty part so newly allocated rIds are never dangling
    let rels_xml = match zip.text(&rels_path).map_err(|e| e.to_string())? {
        Some(xml) => xml.to_owned(),
        None => EMPTY_RELS_NONE.to_owned(),
    };
    let next_rel_num = max_rel_id(Some(&rels_xml))? + 1.0;

    // a heading level the document has no style for gets Word's built-in definition
    let mut heading_style_ids = MapEntries(parsed.heading_style_ids.0.clone());
    let mut heading_upserts = Vec::new();
    let default_style = default_paragraph_style_id(&parsed.styles).map(str::to_owned);
    for level in missing_heading_levels(blocks, &heading_style_ids) {
        let up = built_in_heading_style_upsert(level, default_style.as_deref());
        match heading_style_ids
            .0
            .iter_mut()
            .find(|(key, _)| key.0 == level)
        {
            Some(entry) => entry.1 = up.style_id.clone(),
            None => heading_style_ids
                .0
                .push((jscompat::JsNum(level), up.style_id.clone())),
        }
        heading_upserts.push(up);
    }
    let mut style_upserts = options.style_upserts.clone().unwrap_or_default();
    style_upserts.extend(heading_upserts);

    // the body as the run writer sees it: what the document root declares, and the bytes
    // copied into it as they are (their control ids are taken)
    let mut sources: Vec<&str> = vec![document_xml];
    for block in blocks {
        if let SaveBlockKind::Xml { xml, .. } = &block.kind {
            sources.push(xml);
        }
    }
    let body_controls = ContentControlPart::new(
        &sources,
        Some(part_namespaces(document_xml).map_err(|e| e.to_string())?),
    );
    let bookmark_ids = BookmarkIds::new(document_xml)?;
    let mut story = vec![document_xml.to_owned()];
    story.extend(story_parts_xml(&zip)?);
    let revision_ids = RevisionIds::new(&story, options.revision_id_floor.map_or(0.0, |n| n.0))?;

    let image_seq = next_image_seq(&zip);
    // docPr ids are minted from their own counter, which starts clear of both the media
    // sequence and the ids already in the document
    let doc_pr_seq = next_doc_pr_seq(&zip, document_xml)?;
    let mut inks_by_block: HashMap<String, Vec<crate::model::NewInkImage>> = HashMap::new();
    for ink in options.inks.as_deref().unwrap_or_default() {
        inks_by_block
            .entry(number_to_string(ink.block_index.0))
            .or_default()
            .push(ink.clone());
    }

    let mut saver = Saver {
        parsed,
        blocks,
        options,
        now_ms,
        zip,
        doc_path,
        document_xml,
        index: Utf16Index::new(document_xml),
        custom_properties_xml,
        custom_properties_is_new,
        root_rels_xml,
        rels_path,
        rels_present,
        rels_xml,
        new_rels: Vec::new(),
        next_rel_num,
        heading_style_ids,
        style_upserts,
        body_controls,
        bookmark_ids,
        revision_ids,
        new_media: Vec::new(),
        used_extensions: Vec::new(),
        media_rel_by_content: HashMap::new(),
        media_path_by_content: HashMap::new(),
        image_seq,
        doc_pr_seq,
        new_picture_doc_pr_ids: HashMap::new(),
        new_chart_parts: Vec::new(),
        new_chart_workbooks: Vec::new(),
        inks_by_block,
        ink_seq: 1.0,
        out: Outputs::default(),
    };
    saver.plan_headers_footers()?;
    saver.plan_numbering()?;
    saver.plan_styles()?;
    saver.plan_comments()?;
    saver.plan_notes()?;
    saver.plan_sources()?;
    saver.plan_theme()?;
    let new_document_xml = saver.build_document_xml()?;
    saver.assemble(new_document_xml)
}
