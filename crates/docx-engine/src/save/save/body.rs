//! `saveDocx`, phase by phase (2): the body. The retained blocks, the opaque
//! markup between them, the content-control wraps, the generated blocks, the
//! trailing sectPr and the edits made to the document root afterwards.

use std::borrow::Cow;
use std::collections::HashSet;

use jscompat::{js_regex, number_to_string, slice_utf16, try_js_regex};

use super::external::{ControlShell, build_content_control_shell, next_content_control_id};
use super::helpers::{insert_before_closing_tag, mark_paragraph_revision, retarget_image_blip};
use super::js::{dynamic, len16, limit};
use super::saver::{MediaSource, NewRel, Saver, slice16};
use super::section_write::{
    apply_page_num_type, apply_section_settings, apply_section_start_type, apply_title_pg,
    inject_into_sect_pr,
};
use super::types::{HfVariant, SaveBlock, SaveBlockKind};
use crate::field_balance::balance_field_chars;
use crate::generate::escape_xml_attr as attr;
use crate::generate::paragraph::{GenerateContext, generate_paragraph_xml};
use crate::ink::{inject_ink_runs_into_paragraph, strip_ink_runs};
use crate::package::resolve_relationship_target_path;
use crate::revision_xml::resolve_prop_change_xml;
use crate::save::parts::comments::remove_deleted_comment_markers;
use crate::save::parts::hf_parts::{
    header_footer_part_xml, patch_watermark_in_part, remove_hf_reference,
};
use crate::section::HfKind;
use crate::section::{hf_reference_r_id, hf_reference_tags, hf_reference_type};
use crate::withheld::with_redact_root;
use crate::xml_tag::{TagName, find_start_tag};

/// `UnwrapSlice`: the bytes of a control shell on one block, by their place in it.
struct UnwrapSlice {
    offset: f64,
    length: usize,
    xml: String,
}

/// The unwrap bookkeeping of `options.contentControls.unwrap`.
#[derive(Default)]
struct Unwrap {
    tags: HashSet<String>,
    by_index: Vec<(f64, Vec<UnwrapSlice>)>,
    /// shell bytes of fragments saved without a docxIndex, stripped by content
    shell_bytes: Vec<String>,
}

impl Unwrap {
    fn add_slice(&mut self, docx_index: Option<f64>, offset: Option<f64>, xml: &str) {
        if xml.is_empty() {
            return;
        }
        if !self.shell_bytes.iter().any(|have| have == xml) {
            self.shell_bytes.push(xml.to_owned());
        }
        let (Some(docx_index), Some(offset)) = (docx_index, offset) else {
            return;
        };
        let length = len16(xml);
        let at = match self
            .by_index
            .iter()
            .position(|(index, _)| *index == docx_index)
        {
            Some(at) => at,
            None => {
                self.by_index.push((docx_index, Vec::new()));
                self.by_index.len() - 1
            }
        };
        let slices = &mut self.by_index[at].1;
        if slices
            .iter()
            .any(|slice| slice.offset == offset && slice.length == length)
        {
            return;
        }
        slices.push(UnwrapSlice {
            offset,
            length,
            xml: xml.to_owned(),
        });
    }

    fn strip_bytes(&self, mut xml: String) -> String {
        for bytes in &self.shell_bytes {
            if let Some(rest) = xml.strip_prefix(bytes.as_str()) {
                xml = rest.to_owned();
            } else if let Some(rest) = xml.strip_suffix(bytes.as_str()) {
                xml = rest.to_owned();
            }
        }
        xml
    }

    /// `stripUnwrappedShell`
    fn strip_shell(&self, mut xml: String, docx_index: Option<f64>) -> String {
        // a fragment without a docxIndex carries its own shell bytes: strip by content
        let Some(docx_index) = docx_index else {
            return self.strip_bytes(xml);
        };
        let Some((_, slices)) = self.by_index.iter().find(|(index, _)| *index == docx_index) else {
            return xml;
        };
        if slices.is_empty() {
            return xml;
        }
        let mut order: Vec<&UnwrapSlice> = slices.iter().collect();
        order.sort_by(|a, b| {
            b.offset
                .partial_cmp(&a.offset)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        for slice in order {
            let end = slice.offset + slice.length as f64;
            if slice_utf16(&xml, slice.offset, Some(end)) == slice.xml {
                xml = format!(
                    "{}{}",
                    slice_utf16(&xml, 0.0, Some(slice.offset)),
                    slice_utf16(&xml, end, None)
                );
                continue;
            }
            // the emitted xml no longer matches the original slice (edited block): first exact occurrence
            if let Some(at) = xml.find(slice.xml.as_str()) {
                xml = format!("{}{}", &xml[..at], &xml[at + slice.xml.len()..]);
            }
        }
        xml
    }

    fn any(&self) -> bool {
        !self.by_index.is_empty()
    }
}

struct ControlWrapPlan {
    shell: ControlShell,
    first: Option<usize>,
    last: Option<usize>,
}

fn key(n: f64) -> String {
    number_to_string(n)
}

fn push_to(map: &mut Vec<(String, Vec<String>)>, index: f64, xml: String) {
    let k = key(index);
    match map.iter_mut().find(|(have, _)| *have == k) {
        Some((_, list)) => list.push(xml),
        None => map.push((k, vec![xml])),
    }
}

fn joined(map: &[(String, Vec<String>)], index: f64) -> String {
    let k = key(index);
    map.iter()
        .find(|(have, _)| *have == k)
        .map(|(_, list)| list.join(""))
        .unwrap_or_default()
}

/// A body element by its docxIndex: `elements[index]` of the TypeScript.
fn element_at(len: usize, index: f64) -> Option<usize> {
    (index.fract() == 0.0 && index >= 0.0 && index < len as f64).then_some(index as usize)
}

/// `alloc` of the hyperlink allocator over the fields it uses.
fn alloc_hyperlink(new_rels: &mut Vec<NewRel>, next_rel_num: &mut f64, href: &str) -> String {
    if let Some(existing) = new_rels.iter().find(|r| r.external && r.target == href) {
        return existing.r_id.clone();
    }
    let r_id = format!("rId{}", number_to_string(*next_rel_num));
    *next_rel_num += 1.0;
    new_rels.push(NewRel {
        r_id: r_id.clone(),
        ty: super::saver::HYPERLINK_REL_TYPE.to_owned(),
        target: href.to_owned(),
        external: true,
    });
    r_id
}

impl Saver<'_> {
    /// `unlinkSectionHf`
    fn unlink_section_hf(&self, xml: &str, docx_index: f64) -> Result<String, String> {
        let mut out = xml.to_owned();
        for u in self
            .options
            .section_hf_unlink
            .as_deref()
            .unwrap_or_default()
        {
            if u.last_block_index.0 != docx_index {
                continue;
            }
            out = remove_hf_reference(
                &out,
                u.kind.as_str(),
                u.variant.unwrap_or(HfVariant::Default).as_str(),
            )?;
        }
        Ok(out)
    }

    /// The new document.xml: the retained, generated and trailing blocks put
    /// together between the original root and the original body's end, then the
    /// edits made to the root.
    pub fn build_document_xml(&mut self) -> Result<String, String> {
        let parsed = self.parsed;
        let blocks: &[SaveBlock] = self.blocks;
        let options = self.options;
        let document_xml = self.document_xml;
        let elements = &parsed.extras.elements;
        let body_content_start = parsed.internal.body_content_start.0;
        let body_content_end = parsed.internal.body_content_end.0;

        let mut retained_indexes: HashSet<String> = HashSet::new();
        for block in blocks {
            match &block.kind {
                SaveBlockKind::Original { docx_index } => {
                    retained_indexes.insert(key(docx_index.0));
                }
                SaveBlockKind::Xml {
                    docx_index: Some(index),
                    ..
                }
                | SaveBlockKind::Generated {
                    docx_index: Some(index),
                    ..
                } => {
                    retained_indexes.insert(key(index.0));
                }
                _ => {}
            }
        }
        for block in &parsed.blocks {
            if *block.hidden == Some(true)
                && let Some(Some(index)) = *block.docx_index
            {
                retained_indexes.insert(key(index.0));
            }
        }
        // an sdt shell is re-emitted from its raw openXml/closeXml bytes, so opaque
        // markup inside the shell is already carried along
        let mut sdt_shell_by_index: Vec<(f64, &crate::model::SdtShell)> = Vec::new();
        for block in &parsed.blocks {
            if let (Some(shell), Some(Some(index))) = (block.sdt_shell.as_ref(), *block.docx_index)
            {
                match sdt_shell_by_index
                    .iter_mut()
                    .find(|(have, _)| *have == index.0)
                {
                    Some(entry) => entry.1 = shell,
                    None => sdt_shell_by_index.push((index.0, shell)),
                }
            }
        }
        let inside_sdt_shell = |index: usize, start: f64, end: f64| -> bool {
            let Some((_, shell)) = sdt_shell_by_index
                .iter()
                .find(|(have, _)| *have == index as f64)
            else {
                return false;
            };
            let Some(element) = elements.get(index) else {
                return false;
            };
            end <= element.start.0 + len16(&shell.open_xml) as f64
                || start >= element.end.0 - len16(&shell.close_xml) as f64
        };
        let mut opaque_before: Vec<(String, Vec<String>)> = Vec::new();
        let mut opaque_after: Vec<(String, Vec<String>)> = Vec::new();
        let mut nested_opaque: Vec<(String, Vec<String>)> = Vec::new();
        let mut detached_opaque: Vec<String> = Vec::new();
        for region in &parsed.extras.opaque_regions {
            let (start, end) = (region.start.0, region.end.0);
            if start < body_content_start || end > body_content_end {
                continue;
            }
            let containing = elements
                .iter()
                .position(|el| start >= el.start.0 && end <= el.end.0);
            let xml = slice16(document_xml, &self.index, start, end).to_owned();
            if let Some(containing) = containing {
                if inside_sdt_shell(containing, start, end) {
                    continue;
                }
                if retained_indexes.contains(&key(containing as f64)) {
                    push_to(&mut nested_opaque, containing as f64, xml);
                } else {
                    detached_opaque.push(xml);
                }
                continue;
            }
            let mut after_index: Option<usize> = None;
            let mut before_index: Option<usize> = None;
            for (index, element) in elements.iter().enumerate() {
                if element.end.0 <= start {
                    after_index = Some(index);
                }
                if element.start.0 >= end {
                    before_index = Some(index);
                    break;
                }
            }
            if let Some(after) = after_index.filter(|i| retained_indexes.contains(&key(*i as f64)))
            {
                push_to(&mut opaque_after, after as f64, xml);
            } else if let Some(before) =
                before_index.filter(|i| retained_indexes.contains(&key(*i as f64)))
            {
                push_to(&mut opaque_before, before as f64, xml);
            } else {
                detached_opaque.push(xml);
            }
        }

        // block-level content controls: a new control wraps the blocks of one range, an unwrap
        // drops the wrapper of every control carrying that tag
        let mut unwrap = Unwrap {
            tags: options
                .content_controls
                .as_ref()
                .and_then(|c| c.unwrap.as_ref())
                .map(|list| list.iter().map(|u| u.tag.clone()).collect())
                .unwrap_or_default(),
            ..Unwrap::default()
        };
        for block in &parsed.blocks {
            let chain: Vec<&crate::model::SdtShell> = match block.sdt_shells.as_ref() {
                Some(shells) => shells.iter().collect(),
                None => block.sdt_shell.as_ref().into_iter().collect(),
            };
            for shell in chain {
                if !unwrap.tags.contains(&shell.tag) {
                    continue;
                }
                unwrap.add_slice(
                    shell.open_block.map(|n| n.0),
                    shell.open_offset.map(|n| n.0),
                    &shell.open_xml,
                );
                unwrap.add_slice(
                    shell.close_block.map(|n| n.0),
                    shell.close_offset.map(|n| n.0),
                    &shell.close_xml,
                );
            }
        }
        let mut next_control_id = next_content_control_id(document_xml)?;
        let mut control_wraps: Vec<ControlWrapPlan> = Vec::new();
        for wrap in options
            .content_controls
            .as_ref()
            .and_then(|c| c.wrap.as_deref())
            .unwrap_or_default()
        {
            let id = match &wrap.spec.id {
                Some(id) => id.clone(),
                None => {
                    let id = number_to_string(next_control_id);
                    next_control_id += 1.0;
                    id
                }
            };
            let shell = build_content_control_shell(&wrap.spec, id)?;
            let indexes: Vec<f64> = wrap.docx_indexes.iter().map(|n| n.0).collect();
            // the first and the last emitted block of the range carry the wrapper
            let mut first = None;
            let mut last = None;
            for (i, block) in blocks.iter().enumerate() {
                let Some(index) = block.docx_index() else {
                    continue;
                };
                if !indexes.contains(&index.0) {
                    continue;
                }
                if first.is_none() {
                    first = Some(i);
                }
                last = Some(i);
            }
            control_wraps.push(ControlWrapPlan { shell, first, last });
        }

        let mut parts: Vec<String> = detached_opaque;
        for (i, fb) in blocks.iter().enumerate() {
            let mut fb_docx_index: Option<f64> = None;
            let mut xml: String;
            match &fb.kind {
                SaveBlockKind::Original { docx_index } => {
                    let Some(at) = element_at(elements.len(), docx_index.0) else {
                        return Err(format!(
                            "invalid docxIndex {}",
                            number_to_string(docx_index.0)
                        ));
                    };
                    let el = &elements[at];
                    xml = slice16(document_xml, &self.index, el.start.0, el.end.0).to_owned();
                    fb_docx_index = Some(docx_index.0);
                    if unwrap.any() {
                        xml = unwrap.strip_shell(xml, Some(docx_index.0));
                    }
                }
                SaveBlockKind::Generated { block, docx_index } => {
                    if let Some(index) = docx_index {
                        fb_docx_index = Some(index.0);
                    }
                    {
                        let Saver {
                            new_rels,
                            next_rel_num,
                            bookmark_ids,
                            revision_ids,
                            heading_style_ids,
                            body_controls,
                            ..
                        } = &mut *self;
                        let mut hyperlink =
                            |href: &str| alloc_hyperlink(new_rels, next_rel_num, href);
                        let mut bookmark = |_name: &str| bookmark_ids.allocate();
                        let mut revision = || revision_ids.allocate();
                        let mut ctx = GenerateContext {
                            heading_style_ids,
                            list_paragraph_style_id: parsed.list_paragraph_style_id.as_deref(),
                            allocate_hyperlink_rel: &mut hyperlink,
                            allocate_bookmark_id: Some(&mut bookmark),
                            allocate_revision_id: Some(&mut revision),
                            part: Some(&*body_controls),
                        };
                        xml = generate_paragraph_xml(block, &mut ctx)?;
                    }
                    // an original paragraph inside a w:sdt shell is re-wrapped; the chain is flattened
                    // to the outermost shell
                    if let Some(shell) = &block.sdt_shell
                        && !unwrap.tags.contains(&shell.tag)
                    {
                        xml = format!("{}{xml}{}", shell.open_xml, shell.close_xml);
                    }
                }
                SaveBlockKind::Xml {
                    xml: own,
                    docx_index,
                    replace_image,
                } => {
                    xml = if unwrap.any() {
                        unwrap.strip_shell(own.clone(), docx_index.map(|n| n.0))
                    } else {
                        own.clone()
                    };
                    fb_docx_index = docx_index.map(|n| n.0);
                    if let Some(replace) = replace_image {
                        let r_id = self.embed_image_media(&MediaSource {
                            base64: &replace.base64,
                            mime: replace.mime.clone(),
                            source_part: None,
                        });
                        xml = retarget_image_blip(&xml, &r_id)?;
                    }
                }
                SaveBlockKind::Chart { chart, extent_px } => {
                    xml = self.embed_chart(chart, extent_px.as_ref().map(|e| (e.w.0, e.h.0)))?;
                }
                SaveBlockKind::Images { images } => {
                    xml = self.embed_images(images)?;
                }
                SaveBlockKind::Image { image } => {
                    xml = self.embed_image(image)?;
                }
            }
            xml = self.resolve_new_pictures(&xml)?;
            // newly created per-section header/footer references go first in the section's sectPr
            if let Some(index) = fb_docx_index {
                let tags = self
                    .out
                    .section_ref_tags
                    .iter()
                    .find(|(have, _)| *have == index)
                    .map(|(_, tags)| tags.join(""))
                    .filter(|tags| !tags.is_empty());
                if let Some(tags) = tags {
                    xml = inject_into_sect_pr(&xml, &tags);
                }
                xml = self.unlink_section_hf(&xml, index)?;
            }
            // the ink list is authoritative: old ink runs go away, the desired set is re-injected
            if options.inks.is_some() {
                xml = strip_ink_runs(&xml);
            }
            // check anchor viability BEFORE allocating media, so a non-paragraph anchor leaves no orphans
            if let Some(block_inks) = self.inks_by_block.get(&key(i as f64)).cloned()
                && js_regex!(r"^<w:p[\s/>]").test(&xml)
            {
                let mut runs = String::new();
                for ink in &block_inks {
                    runs.push_str(&self.ink_run_xml(ink)?);
                }
                if let Some(injected) = inject_ink_runs_into_paragraph(&xml, &runs) {
                    xml = injected;
                }
            }
            if let Some(revision) = &fb.revision {
                let kind = revision.kind.as_str();
                let starts_with_kind = dynamic(&format!(r"^<w:{kind}(?:\s|>)"), "")?
                    .try_test(&xml)
                    .map_err(limit)?;
                if !starts_with_kind {
                    let info = &revision.info;
                    let attrs = format!(
                        " w:id=\"{}\" w:author=\"{}\"{}{}",
                        attr(info.id.as_deref().unwrap_or("0")),
                        attr(&info.author),
                        info.date
                            .as_deref()
                            .filter(|d| !d.is_empty())
                            .map_or(String::new(), |d| format!(" w:date=\"{}\"", attr(d))),
                        info.date_utc
                            .as_deref()
                            .filter(|d| !d.is_empty())
                            .map_or(String::new(), |d| format!(" w16du:dateUtc=\"{}\"", attr(d))),
                    );
                    // a whole text paragraph's record rides the paragraph mark (w:pPr/w:rPr);
                    // a paragraph without run marks of its own stays on the wrapper
                    let marks = js_regex!(r"^<w:p[\s/>]").test(&xml)
                        && dynamic(&format!(r"<w:{kind}[\s>]"), "")?
                            .try_test(&xml)
                            .map_err(limit)?;
                    xml = if marks {
                        mark_paragraph_revision(&xml, kind, &attrs)?
                    } else {
                        format!("<w:{kind}{attrs}>{xml}</w:{kind}>")
                    };
                }
            }
            if let Some(index) = fb_docx_index
                && !matches!(fb.kind, SaveBlockKind::Original { .. })
            {
                let nested = joined(&nested_opaque, index);
                if !nested.is_empty() {
                    xml = insert_before_closing_tag(&xml, &nested);
                }
            }
            if let Some(index) = fb_docx_index {
                let leading = joined(&opaque_before, index);
                let trailing = joined(&opaque_after, index);
                if !leading.is_empty() || !trailing.is_empty() {
                    xml = format!("{leading}{xml}{trailing}");
                }
            }
            // a new block-level content control opens before the first block of its range
            // and closes after the last one
            for wrap in &control_wraps {
                if wrap.first == Some(i) {
                    xml = format!("{}{xml}", wrap.shell.open_xml);
                }
                if wrap.last == Some(i) {
                    xml = format!("{xml}{}", wrap.shell.close_xml);
                }
            }
            parts.push(xml);
        }
        // trailing hidden elements (w:sectPr) keep their original bytes and position,
        // unless the editor changed the page setup
        for block in &parsed.blocks {
            let Some(Some(index)) = *block.docx_index else {
                continue;
            };
            if *block.hidden != Some(true) {
                continue;
            }
            let Some(at) = element_at(elements.len(), index.0) else {
                return Err("Cannot read properties of undefined (reading 'start')".to_owned());
            };
            let el = &elements[at];
            let mut xml = slice16(document_xml, &self.index, el.start.0, el.end.0).to_owned();
            if xml.contains("<w:sectPr") {
                if let Some(own) = options
                    .trailing_sect_pr
                    .as_deref()
                    .filter(|own| !own.is_empty())
                {
                    xml = own.to_owned();
                }
                if let Some(resolution) = options.trailing_sect_pr_change {
                    xml = resolve_prop_change_xml(&xml, "w:sectPrChange", resolution.as_str())
                        .into_owned();
                }
                if let Some(section) = &options.section {
                    xml = apply_section_settings(&xml, section)?;
                }
                if let Some(start_type) = options
                    .section_start_type
                    .as_deref()
                    .filter(|t| !t.is_empty())
                {
                    xml = apply_section_start_type(&xml, start_type)?;
                }
                if let Some(pg) = &options.pg_num_type {
                    xml = apply_page_num_type(&xml, pg.fmt.as_deref(), pg.start.map(|n| n.0))?;
                }
                if let Some(on) = options.title_pg {
                    xml = apply_title_pg(&xml, on)?;
                }
                // headerReference/footerReference must be the first sectPr children
                if !self.out.hf_ref_tags.is_empty() {
                    xml = inject_into_sect_pr(&xml, &self.out.hf_ref_tags.join(""));
                }
                xml = self.unlink_section_hf(&xml, index.0)?;
            }
            let leading = joined(&opaque_before, index.0);
            let trailing = joined(&opaque_after, index.0);
            if !leading.is_empty() || !trailing.is_empty() {
                xml = format!("{leading}{xml}{trailing}");
            }
            parts.push(xml);
        }

        let finished = self.body_controls.finish(&parts.join("")).map_err(limit)?;
        let mut new_document_xml = format!(
            "{}{}{}",
            slice16(document_xml, &self.index, 0.0, body_content_start),
            balance_field_chars(&finished),
            slice16(document_xml, &self.index, body_content_end, f64::INFINITY),
        );

        // every ref-less body sectPr picks up the new header/footer references
        if options.hf_all_sections == Some(true) && !self.out.hf_ref_tags.is_empty() {
            let tags = self.out.hf_ref_tags.join("");
            new_document_xml = try_js_regex!(
                r"(<w:sectPr(?:\s[^>]*)?>)(?!<w:headerReference|<w:footerReference)",
                "g"
            )
            .try_replace_all(&new_document_xml, |found| {
                format!("{}{tags}", found.get(1).unwrap_or_default())
            })
            .map_err(limit)?;
        }

        if let Some(watermark) = &options.watermark {
            new_document_xml = self.apply_watermark(new_document_xml, watermark)?;
        }

        if let Some(comments) = &options.comments {
            let live: HashSet<String> = comments.iter().map(|c| c.id.clone()).collect();
            new_document_xml = remove_deleted_comment_markers(&new_document_xml, &live)?;
        }

        // editor-generated formulas need the math namespace on the document root
        if new_document_xml.contains("<m:")
            && !try_js_regex!(r"<w:document[^>]*xmlns:m=")
                .try_test(&new_document_xml)
                .map_err(limit)?
        {
            new_document_xml = jscompat::replace_first_string(
                &new_document_xml,
                "<w:document ",
                "<w:document xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\" ",
            );
        }

        // the root declares the mark's namespace and keeps it through a re-save
        if let Cow::Owned(marked) = with_redact_root(&new_document_xml) {
            new_document_xml = marked;
        }

        if new_document_xml.contains(" w16du:dateUtc=")
            && let Some(root) = find_start_tag(&new_document_xml, TagName::Exact("w:document"), 0)
            && !root.text.contains("xmlns:w16du=")
        {
            let patched = jscompat::replace_first_string(
                root.text,
                "<w:document",
                "<w:document xmlns:w16du=\"http://schemas.microsoft.com/office/word/2023/wordml/word16du\"",
            );
            new_document_xml = format!(
                "{}{patched}{}",
                &new_document_xml[..root.start],
                &new_document_xml[root.end..]
            );
        }

        if let Some(color) = &options.page_color {
            new_document_xml = crate::save::parts::settings::apply_page_color(
                &new_document_xml,
                color.as_deref(),
            )?;
        }
        let revision_ids = &mut self.revision_ids;
        new_document_xml =
            super::helpers::fill_revision_ids(&new_document_xml, &mut || revision_ids.allocate())?;
        Ok(new_document_xml)
    }

    /// The watermark of every active section's header.
    fn apply_watermark(
        &mut self,
        mut new_document_xml: String,
        watermark: &Option<crate::watermark::Watermark>,
    ) -> Result<String, String> {
        // missing references inherit the previous section's same variant
        let mut inherited: Vec<(String, String)> = Vec::new();
        let mut touched: Vec<String> = Vec::new();
        let section_re = try_js_regex!(
            r"<w:sectPr\b[^>]*\/>|<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>",
            "g"
        );
        let mut sections: Vec<String> = Vec::new();
        for found in section_re.try_find_iter(&new_document_xml) {
            sections.push(found.map_err(limit)?.as_str().to_owned());
        }
        let mut replacements: Vec<String> = Vec::new();
        let even = self
            .options
            .even_and_odd_headers
            .or(self.parsed.even_and_odd_headers)
            .unwrap_or(false);
        for mut section_xml in sections {
            for reference in hf_reference_tags(&section_xml, HfKind::Header) {
                let ty = hf_reference_type(reference);
                let id = hf_reference_r_id(reference);
                if let Some(id) = id {
                    let name = match ty {
                        None | Some("odd") => "default".to_owned(),
                        Some(other) => other.to_owned(),
                    };
                    match inherited.iter_mut().find(|(have, _)| *have == name) {
                        Some(entry) => entry.1 = id.to_owned(),
                        None => inherited.push((name, id.to_owned())),
                    }
                }
            }
            let title_tag = try_js_regex!(r"<w:titlePg\b[^>]*\/?\s*>")
                .try_exec(&section_xml)
                .map_err(limit)?
                .map(|found| found.as_str().to_owned());
            let first = title_tag.is_some_and(|tag| {
                !js_regex!(r#"\bw:val\s*=\s*["'](?:0|false|off)["']"#).test(&tag)
            });
            let mut variants = vec!["default"];
            if first {
                variants.push("first");
            }
            if even {
                variants.push("even");
            }
            for variant in variants {
                let id = inherited
                    .iter()
                    .find(|(have, _)| have == variant)
                    .map(|(_, id)| id.clone());
                let target = id.as_ref().and_then(|id| {
                    self.out.rel_targets.get(id).cloned().or_else(|| {
                        self.new_rels
                            .iter()
                            .find(|r| r.r_id == *id)
                            .map(|r| r.target.clone())
                    })
                });
                let mut path =
                    target.and_then(|t| resolve_relationship_target_path(&self.doc_path, &t));
                if path.is_none() {
                    // removing a watermark must not materialize otherwise blank headers
                    if watermark.is_none() || id.is_some() {
                        continue;
                    }
                    let mut n = 1u64;
                    while self.zip.file(&format!("word/header{n}.xml")).is_some()
                        || self
                            .out
                            .hf_parts
                            .iter()
                            .any(|p| p.0 == format!("word/header{n}.xml"))
                    {
                        n += 1;
                    }
                    let filename = format!("header{n}.xml");
                    let new_path = format!("word/{filename}");
                    let r_id = self.next_rel_id();
                    self.push_rel(r_id.clone(), super::saver::HEADER_REL_TYPE, filename);
                    self.out.hf_overrides.push(format!(
                        "<Override PartName=\"/{new_path}\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml\"/>"
                    ));
                    section_xml = inject_into_sect_pr(
                        &section_xml,
                        &format!("<w:headerReference w:type=\"{variant}\" r:id=\"{r_id}\"/>"),
                    );
                    match inherited.iter_mut().find(|(have, _)| have == variant) {
                        Some(entry) => entry.1 = r_id,
                        None => inherited.push((variant.to_owned(), r_id)),
                    }
                    path = Some(new_path);
                }
                let Some(path) = path else { continue };
                if touched.contains(&path) {
                    continue;
                }
                touched.push(path.clone());
                // apply after header text edits: shared/inherited parts are rewritten exactly once
                let pending = self.out.hf_parts.iter().position(|p| p.0 == path);
                let original_xml = match pending {
                    Some(at) => Some(self.out.hf_parts[at].1.clone()),
                    None => self
                        .zip
                        .text(&path)
                        .map_err(|e| e.to_string())?
                        .map(str::to_owned),
                };
                let wm_xml = self.watermark_xml_for(watermark, &path, original_xml.as_deref())?;
                let xml = match &original_xml {
                    Some(original) if !original.is_empty() => {
                        patch_watermark_in_part(original, &wm_xml)?
                    }
                    _ => Some(header_footer_part_xml(
                        "header",
                        &crate::model::HeaderFooter {
                            text: String::new(),
                            page_number: None,
                            paras: None,
                            new_pictures: None,
                            picture_edits: None,
                            picture_only: None,
                            revisions_resolved: None,
                            keep_content: None,
                        },
                        Some(&wm_xml),
                        None,
                        1.0,
                    )?),
                };
                let Some(xml) = xml else { continue };
                match pending {
                    Some(at) => self.out.hf_parts[at].1 = xml,
                    None => self.out.hf_parts.push((path, xml)),
                }
            }
            replacements.push(section_xml);
        }
        let mut section_index = 0;
        new_document_xml = section_re
            .try_replace_all(&new_document_xml, |_| {
                let out = replacements.get(section_index).cloned().unwrap_or_default();
                section_index += 1;
                out
            })
            .map_err(limit)?;
        Ok(new_document_xml)
    }
}
