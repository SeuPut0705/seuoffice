//! Port of packages/pptx-engine/src/index.ts lines 1924-2385 (new slides,
//! copy/paste, merge from another deck, delete, reorder) and 2408-2719 for the
//! layout and size functions (`setSlideLayout`, `resetSlideLayout`,
//! `setSlideSize`). The connectors are in connectors.rs.
//!
//! A TypeScript `Slide | null` is the index of the slide in
//! `opened.deck.slides` here (`Some(index)`), the slide itself being
//! `opened.deck.slides[index]`. A plain numeric index argument is an `f64`, as
//! the TypeScript reads `deck.slides[index]` of any number.

use std::collections::HashSet;

use jscompat::{
    JsMap, js_regex, math_max, math_min, math_round, number_to_string, number_truthy,
    replace_first_with, slice_utf16, to_number,
};
use serde::{Deserialize, Serialize};

use crate::blank::BLANK_SLIDE_XML;
use crate::deck::{
    OpenedPptx, append_raw_elements, materialize_slide, parse_slide_from_archive, patch_slide_xml,
    patched_element_xml,
};
use crate::layout::{
    parse_layout_placeholders, placeholder_sp_xml, prepare_insert_slide_with_layout,
};
use crate::master_edit::{list_master_parts, parse_master_part};
use crate::resource_cleanup::remove_part_with_owned_resources;
use crate::sections::move_slide;
use crate::slide_ids::{can_list_slide, with_slide_listed, with_slide_unlisted};
use crate::slide_transfer::{
    SlideBundle, choose_layout, collect_slide_bundle, import_source_layout,
    materialize_slide_bundle,
};
use crate::types::{Paragraph, Slide, SlideElement, SlideSize, TextRun};
use crate::xml_utils::{
    attribute_of, escape_xml_attr, has_default_for, max_relationship_id_number,
    with_relationship_ids,
};
use crate::zip::{PackageArchive, Relationship, rels_path_for, resolve_target};
use jscompat::JsNum;

const SLIDE_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const SLIDE_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const IMAGE_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const LAYOUT_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const MEDIA_REL_SUFFIXES: [&str; 4] = ["/image", "/video", "/audio", "/media"];

const CT_PATH: &str = "[Content_Types].xml";
const PRES_PATH: &str = "ppt/presentation.xml";
const PRES_RELS_PATH: &str = "ppt/_rels/presentation.xml.rels";

const RELS_HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">";

// ── Small helpers (the JavaScript operation each stands for) ───────────

/// `slides[index]` of a number: the position when it names an element.
fn find_slide(len: usize, index: f64) -> Option<usize> {
    (index.is_finite() && index.fract() == 0.0 && index >= 0.0 && index < len as f64)
        .then_some(index as usize)
}

/// `slide.path`
fn path_of(slide: &Slide) -> String {
    slide.path.as_deref().unwrap_or_default().to_owned()
}

/// `archive.readText(path)` where the caller tests the result for truth: a
/// missing part and an empty one are both falsy.
fn read_nonempty(archive: &PackageArchive, path: &str) -> Option<String> {
    archive
        .read_text(path)
        .map(|text| text.into_owned())
        .filter(|text| !text.is_empty())
}

/// `archive.entries.set(path, Buffer.from(text, 'utf8'))`
fn set_entry(archive: &mut PackageArchive, path: &str, text: &str) {
    archive
        .entries_mut()
        .set(path.to_owned(), text.as_bytes().to_vec());
}

/// `text.replace(needle, () => replacement)` of a string needle: the first
/// occurrence, the replacement taken as written.
fn replace_literal(text: &str, needle: &str, replacement: &str) -> String {
    match text.find(needle) {
        Some(at) => format!(
            "{}{replacement}{}",
            text.get(..at).unwrap_or_default(),
            text.get(at + needle.len()..).unwrap_or_default()
        ),
        None => text.to_owned(),
    }
}

// ── New slides (duplicate an existing slide / blank slide) ─────────────

/// New slide part path: number = existing max + 1.
fn next_slide_path(archive: &PackageArchive) -> String {
    let mut max_num = 0.0;
    for path in archive.entries().keys() {
        if let Some(found) = js_regex!(r"^ppt\/slides\/slide(\d+)\.xml$").exec(path) {
            max_num = math_max(max_num, to_number(found.get(1).unwrap_or_default()));
        }
    }
    format!("ppt/slides/slide{}.xml", number_to_string(max_num + 1.0))
}

/// `canAddSlide`: whether a slide can be added to the deck: its slide list is one this engine
/// can write to (`canListSlide`). Everything that adds a slide asks first, before it writes a
/// part, so a deck that cannot take the slide is left exactly as it was.
fn can_add_slide(archive: &PackageArchive) -> bool {
    can_list_slide(archive.read_text(PRES_PATH).as_deref())
}

/// `registerNewSlide`: register a new slide part (already written into the
/// archive) with the package and insert it into the deck after the slide at
/// `source_index` (a number: a position that names no slide gives `None`).
/// Returns the position of the new slide.
fn register_new_slide(
    opened: &mut OpenedPptx,
    source_index: f64,
    new_path: &str,
) -> Result<Option<usize>, String> {
    let OpenedPptx {
        deck,
        archive,
        uids,
        ..
    } = opened;
    let Some(source_at) = find_slide(deck.slides.len(), source_index) else {
        return Ok(None);
    };
    let Some(src) = deck.slides.get(source_at) else {
        return Ok(None);
    };
    if !can_add_slide(archive) {
        return Ok(None);
    }
    let src_path = path_of(src);

    if let Some(ct) = read_nonempty(archive, CT_PATH) {
        let overridden =
            format!("<Override PartName=\"/{new_path}\" ContentType=\"{SLIDE_CONTENT_TYPE}\"/>");
        let next = replace_literal(&ct, "</Types>", &format!("{overridden}</Types>"));
        set_entry(archive, CT_PATH, &next);
    }

    let pres_rels = read_nonempty(archive, PRES_RELS_PATH);
    let pres = read_nonempty(archive, PRES_PATH);
    let (Some(pres_rels), Some(pres)) = (pres_rels, pres) else {
        return Ok(None);
    };
    let max_rid = max_relationship_id_number(&pres_rels);
    let new_rid = format!("rId{}", number_to_string(max_rid + 1.0));
    // Listed after the source slide; at the end of the list when that one is not found
    let src_rid = archive
        .read_rels(PRES_PATH)?
        .values()
        .find(|r| resolve_target(PRES_PATH, &r.target) == src_path)
        .map(|r| r.id.clone());
    let Some(next_pres) = with_slide_listed(&pres, &new_rid, src_rid.as_deref())
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let rel_xml = format!(
        "<Relationship Id=\"{new_rid}\" Type=\"{SLIDE_REL_TYPE}\" Target=\"{}\"/>",
        slice_utf16(new_path, 4.0, None)
    );
    let next_rels = replace_literal(
        &pres_rels,
        "</Relationships>",
        &format!("{rel_xml}</Relationships>"),
    );
    set_entry(archive, PRES_RELS_PATH, &next_rels);

    set_entry(archive, PRES_PATH, &next_pres);

    let Some(slide) = parse_slide_from_archive(archive, new_path, uids)? else {
        return Ok(None);
    };
    deck.slides.insert(source_at + 1, slide);
    Ok(Some(source_at + 1))
}

/// Options of [`duplicate_slide`].
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateSlideOptions {
    pub clear_text: Option<bool>,
}

/// `duplicateSlide`: duplicate the `source_index` slide as a new slide
/// inserted after it. The new slideK.xml includes the source slide's unsaved
/// patches; rels are copied verbatim but with notesSlide removed.
pub fn duplicate_slide(
    opened: &mut OpenedPptx,
    source_index: f64,
    opts: Option<&DuplicateSlideOptions>,
) -> Result<Option<usize>, String> {
    let new_path;
    {
        let OpenedPptx { deck, archive, .. } = &mut *opened;
        let Some(source_at) = find_slide(deck.slides.len(), source_index) else {
            return Ok(None);
        };
        let Some(src) = deck.slides.get_mut(source_at) else {
            return Ok(None);
        };
        if !can_add_slide(archive) {
            return Ok(None);
        }
        new_path = next_slide_path(archive);
        let xml = patch_slide_xml(src);
        set_entry(archive, &new_path, &xml);

        let src_path = path_of(src);
        if let Some(src_rels) = read_nonempty(archive, &rels_path_for(&src_path)) {
            let cleaned = js_regex!(r#"<Relationship\s[^>]*\/notesSlide"[^>]*\/>"#, "g")
                .replace_all(&src_rels, |_| String::new());
            set_entry(archive, &rels_path_for(&new_path), &cleaned);
        }
    }

    let Some(at) = register_new_slide(opened, source_index, &new_path)? else {
        return Ok(None);
    };
    if opts.and_then(|o| o.clear_text) == Some(true)
        && let Some(slide) = opened.deck.slides.get_mut(at)
        && let Some(elements) = slide.elements.as_mut()
    {
        for el in elements.iter_mut() {
            let SlideElement::Text(e) = el else {
                continue;
            };
            let had_text = e
                .text
                .as_mut()
                .map(|body| {
                    let mut run = TextRun::default();
                    run.text.set(String::new());
                    let mut paragraph = Paragraph::default();
                    paragraph.runs.set(vec![run]);
                    body.paragraphs.set(vec![paragraph]);
                })
                .is_some();
            if had_text {
                e.dirty.set(true);
            }
        }
    }
    Ok(Some(at))
}

/// `copySlide`: snapshot a slide for pasting into another deck (or back into
/// this one), including its unsaved edits and every part it references.
pub fn copy_slide(
    opened: &mut OpenedPptx,
    source_index: f64,
) -> Result<Option<SlideBundle>, String> {
    let OpenedPptx { deck, archive, .. } = opened;
    let Some(source_at) = find_slide(deck.slides.len(), source_index) else {
        return Ok(None);
    };
    let Some(slide) = deck.slides.get_mut(source_at) else {
        return Ok(None);
    };
    let xml = patch_slide_xml(slide);
    let path = path_of(slide);
    collect_slide_bundle(archive, &path, &xml).map(Some)
}

/// Options of [`paste_slide`].
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteSlideOptions {
    pub keep_source_formatting: Option<bool>,
}

/// `pasteSlide`: paste a bundle after `after_index` (-1 pastes at the front).
/// By default the slide adopts a layout from this deck; with
/// `keepSourceFormatting` the bundled layout→master→theme chain is imported.
pub fn paste_slide(
    opened: &mut OpenedPptx,
    after_index: f64,
    bundle: &SlideBundle,
    opts: Option<&PasteSlideOptions>,
) -> Result<Option<usize>, String> {
    let anchor_index;
    let layout_path;
    let new_path;
    {
        let OpenedPptx { deck, archive, .. } = &mut *opened;
        if deck.slides.is_empty() || !can_add_slide(archive) {
            return Ok(None);
        }
        anchor_index = math_min(math_max(after_index, -1.0), deck.slides.len() as f64 - 1.0);
        let neighbour = find_slide(deck.slides.len(), anchor_index)
            .and_then(|at| deck.slides.get(at))
            .or_else(|| deck.slides.first());
        let neighbour_path = neighbour.map(path_of);
        let imported = if opts.and_then(|o| o.keep_source_formatting) == Some(true) {
            import_source_layout(archive, bundle)?
        } else {
            None
        };
        let chosen = match imported {
            Some(path) => Some(path),
            None => choose_layout(archive, bundle, neighbour_path.as_deref())?,
        };
        match chosen.filter(|path| !path.is_empty()) {
            Some(path) => layout_path = path,
            None => return Ok(None),
        }

        new_path = next_slide_path(archive);
        let rels_xml = materialize_slide_bundle(archive, bundle, &new_path, &layout_path)?;
        set_entry(archive, &new_path, &bundle.slide_xml);
        set_entry(archive, &rels_path_for(&new_path), &rels_xml);
    }

    if anchor_index < 0.0 {
        // registerNewSlide can only insert after a slide, so land at 1 and move up
        let Some(at) = register_new_slide(opened, 0.0, &new_path)? else {
            return Ok(None);
        };
        let moved = move_slide(opened, at as f64, 0.0, &mut crate::deck::random_uuid)?;
        return Ok(Some(if moved { 0 } else { at }));
    }
    register_new_slide(opened, anchor_index, &new_path)
}

/// `insertBlankSlide`: insert a truly blank slide after the `source_index`
/// slide: content is an empty spTree, rels only point at the source slide's
/// slideLayout.
pub fn insert_blank_slide(
    opened: &mut OpenedPptx,
    source_index: f64,
) -> Result<Option<usize>, String> {
    let new_path;
    {
        let OpenedPptx { deck, archive, .. } = &mut *opened;
        let Some(src) =
            find_slide(deck.slides.len(), source_index).and_then(|at| deck.slides.get(at))
        else {
            return Ok(None);
        };
        if !can_add_slide(archive) {
            return Ok(None);
        }
        new_path = next_slide_path(archive);
        set_entry(archive, &new_path, BLANK_SLIDE_XML);

        // Both slides live under ppt/slides/, so the source layout relationship's relative Target can be reused directly
        let layout = archive
            .read_rels(&path_of(src))?
            .values()
            .find(|r| r.r#type.ends_with("/slideLayout"))
            .cloned();
        let mut rels = String::from(RELS_HEAD);
        if let Some(layout) = layout {
            rels.push_str(&format!(
                "<Relationship Id=\"rId1\" Type=\"{}\" Target=\"{}\"/>",
                layout.r#type,
                escape_xml_attr(&layout.target)
            ));
        }
        rels.push_str("</Relationships>");
        set_entry(archive, &rels_path_for(&new_path), &rels);
    }
    register_new_slide(opened, source_index, &new_path)
}

/// Next non-conflicting media path in the target archive (keeping the extension).
pub(crate) fn next_media_path(archive: &PackageArchive, ext: &str) -> String {
    let mut max_num = 0.0;
    for path in archive.entries().keys() {
        if let Some(found) = js_regex!(r"^ppt\/media\/merged(\d+)\.").exec(path) {
            max_num = math_max(max_num, to_number(found.get(1).unwrap_or_default()));
        }
    }
    format!("ppt/media/merged{}.{ext}", number_to_string(max_num + 1.0))
}

/// Ensure [Content_Types].xml has a Default for this extension (required for images/media).
pub(crate) fn ensure_default_content_type(
    archive: &mut PackageArchive,
    ext: &str,
    content_type: &str,
) -> Result<(), String> {
    let Some(ct) = read_nonempty(archive, CT_PATH) else {
        return Ok(());
    };
    if has_default_for(&ct, ext) {
        return Ok(());
    }
    // Insert before </Types>, never after the XML declaration's closing angle bracket
    let default = format!("<Default Extension=\"{ext}\" ContentType=\"{content_type}\"/>");
    let next = replace_literal(&ct, "</Types>", &format!("{default}</Types>"));
    set_entry(archive, CT_PATH, &next);
    Ok(())
}

/// `MIME_BY_EXT[ext]`, an own key only.
fn mime_by_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "tif" => "image/tiff",
        "tiff" => "image/tiff",
        "emf" => "image/x-emf",
        "wmf" => "image/x-wmf",
        _ => return None,
    })
}

/// `MergeSlideOptions`. `layout_from` is the path of the target slide whose
/// layout the merged slide takes (the TypeScript passes the slide and reads
/// its path only); default: the last slide.
#[derive(Debug, Clone, Copy, Default)]
pub struct MergeSlideOptions<'a> {
    pub layout_from: Option<&'a str>,
}

/// One referenced media file of a [`MergeSlideSource`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MergeSlideMedia {
    pub path: String,
    #[serde(deserialize_with = "crate::json_bytes::bytes")]
    pub bytes: Vec<u8>,
}

/// One layout→master→theme chain part of a [`MergeSlideSource`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MergeSlideChainPart {
    pub path: String,
    #[serde(deserialize_with = "crate::json_bytes::bytes")]
    pub bytes: Vec<u8>,
    #[serde(
        default,
        deserialize_with = "crate::json_bytes::optional_bytes",
        skip_serializing_if = "Option::is_none"
    )]
    pub rels: Option<Vec<u8>>,
}

/// `MergeSlideSource`: a single-slide pptx reduced to the plain data the merge needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSlideSource {
    pub src_slide_path: String,
    pub slide_xml: String,
    pub rels: Vec<Relationship>,
    /// Referenced media bytes keyed by their resolved source path
    pub media: Vec<MergeSlideMedia>,
    /// Source layout→master→theme chain parts (used only when the target has no layout)
    pub layout_chain: Vec<MergeSlideChainPart>,
}

/// `mergeSlideFromPptx`: merge the single slide of a one-slide pptx into the
/// target deck (appended at the end).
pub fn merge_slide_from_pptx(
    target: &mut OpenedPptx,
    source_bytes: &[u8],
    opts: &MergeSlideOptions<'_>,
) -> Result<Option<usize>, String> {
    match extract_merge_slide_source(source_bytes)? {
        Some(source) => merge_slide_from_source(target, &source, opts),
        None => Ok(None),
    }
}

/// `extractMergeSlideSource`: unzip the source and extract everything the
/// sync half needs. Pure read.
pub fn extract_merge_slide_source(source_bytes: &[u8]) -> Result<Option<MergeSlideSource>, String> {
    let src = PackageArchive::open(source_bytes)?;
    let presentation = src.read_presentation()?;
    let Some(src_slide_path) = presentation
        .slide_paths
        .first()
        .filter(|p| !p.is_empty())
        .cloned()
    else {
        return Ok(None);
    };
    let Some(slide_xml) = src.read_text(&src_slide_path).map(|text| text.into_owned()) else {
        return Ok(None);
    };
    let rels: Vec<Relationship> = src.read_rels(&src_slide_path)?.values().cloned().collect();
    let mut media = Vec::new();
    for rel in &rels {
        if !MEDIA_REL_SUFFIXES.iter().any(|s| rel.r#type.ends_with(s)) {
            continue;
        }
        let path = resolve_target(&src_slide_path, &rel.target);
        if let Some(bytes) = src.read_bytes(&path) {
            media.push(MergeSlideMedia {
                path,
                bytes: bytes.to_vec(),
            });
        }
    }
    let mut layout_chain = Vec::new();
    let chain = src.resolve_slide_chain(&src_slide_path)?;
    for p in [chain.layout_path, chain.master_path, chain.theme_path] {
        let Some(p) = p.filter(|p| !p.is_empty()) else {
            continue;
        };
        let Some(bytes) = src.read_bytes(&p) else {
            continue;
        };
        let rels_bytes = src.read_bytes(&rels_path_for(&p)).map(<[u8]>::to_vec);
        layout_chain.push(MergeSlideChainPart {
            bytes: bytes.to_vec(),
            rels: rels_bytes,
            path: p,
        });
    }
    Ok(Some(MergeSlideSource {
        src_slide_path,
        slide_xml,
        rels,
        media,
        layout_chain,
    }))
}

/// `mergeSlideFromSource`: land an extracted source into the target deck
/// (appended at the end).
pub fn merge_slide_from_source(
    target: &mut OpenedPptx,
    source: &MergeSlideSource,
    opts: &MergeSlideOptions<'_>,
) -> Result<Option<usize>, String> {
    let new_path;
    {
        let OpenedPptx { deck, archive, .. } = &mut *target;
        if !can_add_slide(archive) {
            return Ok(None);
        }
        let mut slide_xml = source.slide_xml.clone();

        // Relative Target of an existing target slide's slideLayout (the appended slide reuses the same layout)
        let anchor_path = match opts.layout_from {
            Some(path) => Some(path.to_owned()),
            None => deck.slides.last().map(path_of),
        };
        let layout_target = match anchor_path {
            Some(path) => archive
                .read_rels(&path)?
                .values()
                .find(|r| r.r#type.ends_with("/slideLayout"))
                .map(|r| r.target.clone()),
            None => None,
        };

        new_path = next_slide_path(archive);
        let mut new_rels_lines: Vec<String> = Vec::new();
        let mut rid_seq: u64 = 0;
        let mut next_rid = || {
            rid_seq += 1;
            format!("rId{rid_seq}")
        };
        // source rId -> the rId the same media has in the new slide's rels
        let mut rid_map: JsMap<String> = JsMap::new();

        for rel in &source.rels {
            if MEDIA_REL_SUFFIXES.iter().any(|s| rel.r#type.ends_with(s)) {
                // Media: move source bytes into the target, assign a non-conflicting path, remap the rId
                let src_media_path = resolve_target(&source.src_slide_path, &rel.target);
                // the last entry of a path wins, as the Map built from the list
                let Some(bytes) = source
                    .media
                    .iter()
                    .rev()
                    .find(|m| m.path == src_media_path)
                    .map(|m| m.bytes.as_slice())
                else {
                    continue;
                };
                let last = src_media_path.rsplit('.').next().unwrap_or_default();
                let ext = if last.is_empty() { "png" } else { last }.to_lowercase();
                let dest_path = next_media_path(archive, &ext);
                archive.entries_mut().set(dest_path.clone(), bytes.to_vec());
                // the extension is the source deck's: the table answers its own extensions only
                let mime = mime_by_ext(&ext).unwrap_or("application/octet-stream");
                ensure_default_content_type(archive, &ext, mime)?;
                let new_rid = next_rid();
                rid_map.set(rel.id.clone(), new_rid.clone());
                let rel_target = format!("../media/{}", slice_utf16(&dest_path, 10.0, None));
                new_rels_lines.push(format!(
                    "<Relationship Id=\"{new_rid}\" Type=\"{IMAGE_REL_TYPE}\" Target=\"{}\"/>",
                    escape_xml_attr(&rel_target)
                ));
            } else if rel.r#type.ends_with("/slideLayout") {
                // Reuse the target's existing layout; with none, the source's own target
                let t = layout_target.clone().unwrap_or_else(|| rel.target.clone());
                new_rels_lines.push(format!(
                    "<Relationship Id=\"{}\" Type=\"{LAYOUT_REL_TYPE}\" Target=\"{}\"/>",
                    next_rid(),
                    escape_xml_attr(&t)
                ));
                // With no target layout (rare: empty deck), move the source's whole layout→master→theme chain over
                if layout_target.as_deref().is_none_or(str::is_empty) {
                    import_layout_chain(archive, source);
                }
            }
            // notesSlide and others (e.g. comments) are dropped
        }
        // Re-point the r:embed / r:link references in the slide XML at the new rIds
        slide_xml = with_relationship_ids(&slide_xml, &["embed", "link"], &rid_map);

        // Write the new slide XML + rels
        set_entry(archive, &new_path, &slide_xml);
        let rels_xml = format!("{RELS_HEAD}{}</Relationships>", new_rels_lines.join(""));
        set_entry(archive, &rels_path_for(&new_path), &rels_xml);
    }

    // Register with the package: Content_Types Override + new sldId/rId in presentation.xml(.rels), inserted at the end
    let last = target.deck.slides.len() as f64 - 1.0;
    register_new_slide(target, last, &new_path)
}

/// Starting from an empty deck: move the source single slide's layout→master→theme chain into the target verbatim (rare branch).
fn import_layout_chain(archive: &mut PackageArchive, source: &MergeSlideSource) {
    for part in &source.layout_chain {
        if !archive.has(&part.path) {
            archive
                .entries_mut()
                .set(part.path.clone(), part.bytes.clone());
        }
        let rp = rels_path_for(&part.path);
        if let Some(rels) = &part.rels
            && !archive.has(&rp)
        {
            archive.entries_mut().set(rp, rels.clone());
        }
    }
}

/// `insertSlideWithLayout`: insert a blank slide after the `source_index`
/// slide, with rels pointing at the given layout. The layout itself is read-only.
pub fn insert_slide_with_layout(
    opened: &mut OpenedPptx,
    source_index: f64,
    layout_path: &str,
) -> Result<Option<usize>, String> {
    let OpenedPptx {
        deck,
        archive,
        uids,
        ..
    } = opened;
    let Some(source_at) = find_slide(deck.slides.len(), source_index) else {
        return Ok(None);
    };
    let Some(new_path) = prepare_insert_slide_with_layout(archive, deck, source_at, layout_path)?
    else {
        return Ok(None);
    };
    let Some(slide) = parse_slide_from_archive(archive, &new_path, uids)? else {
        return Ok(None);
    };
    // prepareInsertSlideWithLayout already registered presentation.xml
    // Here we only splice into deck.slides (no further archive changes needed)
    let at = match find_slide(deck.slides.len(), source_index) {
        Some(source_at) => source_at + 1,
        None => deck.slides.len(),
    };
    deck.slides.insert(at, slide);
    Ok(Some(at))
}

/// `deleteSlide`: the sldId in presentation.xml, the presentation rels, the
/// [Content_Types] Override, the slide part and its rels are all removed;
/// deck.slides synced. Refused when only one slide remains.
pub fn delete_slide(opened: &mut OpenedPptx, index: f64) -> Result<bool, String> {
    let OpenedPptx { deck, archive, .. } = opened;
    let Some(at) = find_slide(deck.slides.len(), index) else {
        return Ok(false);
    };
    let Some(slide) = deck.slides.get(at) else {
        return Ok(false);
    };
    if deck.slides.len() <= 1 {
        return Ok(false);
    }
    let slide_path = path_of(slide);

    let pres = read_nonempty(archive, PRES_PATH);
    let pres_rels = read_nonempty(archive, PRES_RELS_PATH);
    let (Some(pres), Some(pres_rels)) = (pres, pres_rels) else {
        return Ok(false);
    };
    let Some(rid) = archive
        .read_rels(PRES_PATH)?
        .values()
        .find(|r| resolve_target(PRES_PATH, &r.target) == slide_path)
        .map(|r| r.id.clone())
        .filter(|id| !id.is_empty())
    else {
        return Ok(false);
    };

    let Some(next_pres) = with_slide_unlisted(&pres, &rid) else {
        return Ok(false);
    };
    set_entry(archive, PRES_PATH, &next_pres);
    let next_rels = js_regex!(r"<Relationship\b[^>]*\/\s*>", "g").replace_all(&pres_rels, |tag| {
        if attribute_of(tag.as_str(), "Id").as_deref() == Some(rid.as_str()) {
            String::new()
        } else {
            tag.as_str().to_owned()
        }
    });
    if next_rels != pres_rels {
        set_entry(archive, PRES_RELS_PATH, &next_rels);
    }

    remove_part_with_owned_resources(archive, &slide_path)?;
    deck.slides.remove(at);
    Ok(true)
}

/// `ReorderDirection`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReorderDirection {
    Front,
    Back,
    Forward,
    Backward,
}

/// `reorderElement`: adjust an element's z-order (the elements array order is
/// the spTree order); returns whether anything changed.
pub fn reorder_element(slide: &mut Slide, element_id: &str, dir: ReorderDirection) -> bool {
    let Some(elements) = slide.elements.as_mut() else {
        return false;
    };
    let Some(idx) = elements.iter().position(|e| e.id() == element_id) else {
        return false;
    };
    let len = elements.len() as isize;
    let idx_i = idx as isize;
    let to = match dir {
        ReorderDirection::Front => len - 1,
        ReorderDirection::Back => 0,
        ReorderDirection::Forward => idx_i + 1,
        ReorderDirection::Backward => idx_i - 1,
    };
    if to == idx_i || to < 0 || to >= len {
        return false;
    }
    let el = elements.remove(idx);
    elements.insert(to as usize, el);
    slide.structure_dirty.set(true);
    true
}

// ── Layout and slide size ──────────────────────────────────────────────

/// title/ctrTitle share one slot; content placeholders (body/obj/subTitle/untyped) match by idx
fn ph_slot_key(ty: &str, idx: &str) -> String {
    if ty == "title" || ty == "ctrTitle" {
        "title".to_owned()
    } else {
        format!("body:{idx}")
    }
}

/// `setSlideLayout`: point the slide rels' slideLayout relationship at the
/// new layout, then reparse. Placeholder positions are kept; layout
/// placeholders with no counterpart on the slide are added as empty prompt
/// boxes (PowerPoint semantics).
pub fn set_slide_layout(
    opened: &mut OpenedPptx,
    slide_index: f64,
    layout_path: &str,
) -> Result<Option<usize>, String> {
    let Some(at) = find_slide(opened.deck.slides.len(), slide_index) else {
        return Ok(None);
    };
    let layout_phs;
    let mut taken: HashSet<String> = HashSet::new();
    let mut max_id = 1.0;
    {
        let OpenedPptx { deck, archive, .. } = &mut *opened;
        let Some(slide) = deck.slides.get_mut(at) else {
            return Ok(None);
        };
        if read_nonempty(archive, layout_path).is_none() {
            return Ok(None);
        }
        let rels_path = rels_path_for(&path_of(slide));
        let Some(rels) = read_nonempty(archive, &rels_path) else {
            return Ok(None);
        };
        let rel_target = format!("../{}", slice_utf16(layout_path, 4.0, None));
        let existing = js_regex!(
            r#"<Relationship\b[^>]*Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"[^>]*/>|<Relationship\b[^>]*/>"#,
            "g"
        );
        let mut next: Option<String> = None;
        for found in existing.find_iter(&rels) {
            if !found.as_str().contains("slideLayout") {
                continue;
            }
            let retargeted =
                replace_first_with(js_regex!(r#"\bTarget="[^"]*""#), found.as_str(), |_| {
                    format!("Target=\"{}\"", escape_xml_attr(&rel_target))
                });
            next = Some(format!(
                "{}{retargeted}{}",
                rels.get(..found.start()).unwrap_or_default(),
                rels.get(found.end()..).unwrap_or_default()
            ));
            break;
        }
        let next = match next {
            Some(next) => next,
            None => {
                let max_rid = max_relationship_id_number(&rels);
                replace_literal(
                    &rels,
                    "</Relationships>",
                    &format!(
                        "<Relationship Id=\"rId{}\" Type=\"{LAYOUT_REL_TYPE}\" Target=\"{}\"/></Relationships>",
                        number_to_string(max_rid + 1.0),
                        escape_xml_attr(&rel_target)
                    ),
                )
            }
        };
        set_entry(archive, &rels_path, &next);

        layout_phs = parse_layout_placeholders(
            archive
                .read_text(layout_path)
                .as_deref()
                .unwrap_or_default(),
        );
        if let Some(elements) = slide.elements.as_mut() {
            for el in elements.iter_mut() {
                let xml = patched_element_xml(el);
                let ph = js_regex!(r"<p:ph\b([^>]*?)\/?>").exec(&xml);
                let ty = match &ph {
                    Some(m) => js_regex!(r#"\btype="([^"]*)""#)
                        .exec(m.get(1).unwrap_or_default())
                        .and_then(|t| t.get(1))
                        .unwrap_or_default()
                        .to_owned(),
                    None => String::new(),
                };
                // ftr/sldNum/dt live outside the content-slot namespace (their idx 2/3/4 must not block body slots)
                if let Some(m) = &ph
                    && !["ftr", "sldNum", "dt"].contains(&ty.as_str())
                {
                    let idx = js_regex!(r#"\bidx="([^"]*)""#)
                        .exec(m.get(1).unwrap_or_default())
                        .and_then(|t| t.get(1))
                        .unwrap_or_default();
                    taken.insert(ph_slot_key(&ty, idx));
                }
                for idm in js_regex!(r#"<p:cNvPr\s[^>]*\bid=["'](\d+)["']"#, "g").find_iter(&xml) {
                    max_id = math_max(max_id, to_number(idm.get(1).unwrap_or_default()));
                }
            }
        }
    }
    let missing: Vec<_> = layout_phs
        .iter()
        .filter(|ph| !taken.contains(&ph_slot_key(&ph.r#type, &ph.idx)))
        .collect();
    if !missing.is_empty() {
        let xmls: Vec<String> = missing
            .iter()
            .enumerate()
            .map(|(i, ph)| placeholder_sp_xml(ph, max_id + 1.0 + i as f64))
            .collect();
        if append_raw_elements(opened, at, &xmls)?.is_some() {
            return Ok(Some(at));
        }
    }
    Ok(materialize_slide(opened, at)?.then_some(at))
}

/// `resetSlideLayout`: placeholder elements drop their explicit `<a:xfrm>`,
/// geometry falls back to layout/master inheritance.
pub fn reset_slide_layout(
    opened: &mut OpenedPptx,
    slide_index: f64,
) -> Result<Option<usize>, String> {
    let Some(at) = find_slide(opened.deck.slides.len(), slide_index) else {
        return Ok(None);
    };
    let mut changed = false;
    {
        let Some(slide) = opened.deck.slides.get_mut(at) else {
            return Ok(None);
        };
        if let Some(elements) = slide.elements.as_mut() {
            for el in elements.iter_mut() {
                let placeholder = match &*el {
                    SlideElement::Text(e) => {
                        e.placeholder.as_deref().is_some_and(|p| !p.is_empty())
                    }
                    _ => false,
                };
                if !placeholder {
                    continue;
                }
                let xml = patched_element_xml(el);
                // spPr's xfrm is the first <a:xfrm> in the <p:sp> (txBody has no xfrm)
                let stripped = replace_first_with(
                    js_regex!(r"<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>"),
                    &xml,
                    |_| String::new(),
                );
                if stripped == xml {
                    continue;
                }
                let SlideElement::Text(e) = el else {
                    continue;
                };
                e.dirty_stroke.set(false);
                e.dirty_fill.set(false);
                e.dirty_transform.set(false);
                e.dirty.set(false);
                e.dirty_p_pr.assign(None);
                if let Some(anchor) = e.anchor.as_mut() {
                    anchor.original_xml = stripped.into();
                }
                changed = true;
            }
        }
        if !changed {
            return Ok(Some(at));
        }
        slide.structure_dirty.set(true);
    }
    Ok(materialize_slide(opened, at)?.then_some(at))
}

/// `scaleOffset`
fn scale_offset(o: &mut crate::types::EmuRect, sx: f64, sy: f64) {
    o.x = JsNum(math_round(o.x.0 * sx));
    o.y = JsNum(math_round(o.y.0 * sy));
    o.cx = JsNum(math_round(o.cx.0 * sx));
    o.cy = JsNum(math_round(o.cy.0 * sy));
}

/// Scale the offset of every element of `elements` that has an extent; whether any did.
fn scale_elements(elements: &mut [SlideElement], sx: f64, sy: f64) -> bool {
    let mut touched = false;
    for el in elements.iter_mut() {
        crate::with_element!(el, e => {
            if let Some(t) = e.transform.as_mut() {
                let o = &mut t.offset;
                if !number_truthy(o.cx.0) && !number_truthy(o.cy.0) {
                    continue;
                }
                scale_offset(o, sx, sy);
            } else {
                continue;
            }
            e.dirty_transform.set(true);
        });
        touched = true;
    }
    touched
}

/// `setSlideSize`: edits `<p:sldSz>` in presentation.xml. Content reflows
/// with the canvas: each axis scales independently.
pub fn set_slide_size(opened: &mut OpenedPptx, cx: f64, cy: f64) -> Result<bool, String> {
    {
        let OpenedPptx {
            deck,
            archive,
            uids,
            ..
        } = &mut *opened;
        let old = deck.size;
        if old.cx.0 == cx && old.cy.0 == cy {
            return Ok(false);
        }
        let Some(pres) = read_nonempty(archive, PRES_PATH) else {
            return Ok(false);
        };
        let Some(sld_sz) = js_regex!(r"<p:sldSz\b[^>]*?\/?>")
            .exec(&pres)
            .map(|found| found.as_str().to_owned())
        else {
            return Ok(false);
        };
        // re-emit the tag from its parsed attributes: cx=/cy= are rewritten whatever
        // quote style they were written in, and a tag carrying neither cannot be resized
        let has_cx = js_regex!(r#"\bcx=["']\d+["']"#).test(&sld_sz);
        let has_cy = js_regex!(r#"\bcy=["']\d+["']"#).test(&sld_sz);
        if !has_cx && !has_cy {
            return Ok(false);
        }
        let with_cx = replace_first_with(js_regex!(r#"\bcx=["']\d+["']"#), &sld_sz, |_| {
            format!("cx=\"{}\"", number_to_string(cx))
        });
        let with_cy = replace_first_with(js_regex!(r#"\bcy=["']\d+["']"#), &with_cx, |_| {
            format!("cy=\"{}\"", number_to_string(cy))
        });
        let next = replace_literal(&pres, &sld_sz, &with_cy);
        set_entry(archive, PRES_PATH, &next);
        deck.size = SlideSize {
            cx: JsNum(cx),
            cy: JsNum(cy),
        };

        let sx = cx / old.cx.0;
        let sy = cy / old.cy.0;
        for slide in deck.slides.iter_mut() {
            if let Some(elements) = slide.elements.as_mut() {
                scale_elements(elements, sx, sy);
            }
        }

        // layout/master scaled in sync (PowerPoint also rewrites masters on resize;
        // otherwise decorations/inherited placeholders still lay out at the old size).
        // A deliberate user action that is the exception to the never-write-masters rule.
        for part in list_master_parts(archive)? {
            let Some(mut part_slide) = parse_master_part(archive, &part.part_path, uids)? else {
                continue;
            };
            let touched = match part_slide.elements.as_mut() {
                Some(elements) => scale_elements(elements, sx, sy),
                None => false,
            };
            if touched {
                let xml = patch_slide_xml(&mut part_slide);
                set_entry(archive, &part.part_path, &xml);
            }
        }
    }
    let count = opened.deck.slides.len();
    for i in 0..count {
        materialize_slide(opened, i)?;
    }
    Ok(true)
}
