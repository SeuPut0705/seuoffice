//! `saveDocx`, phase by phase (1): everything planned before the body is
//! written: headers and footers, numbering, styles, comments, notes,
//! bibliography sources and the theme.

use jscompat::{JsNum, Radix, js_regex, number_to_string, parse_int, try_js_regex};

use super::external::{
    THEME_REL_TYPE, apply_theme_colors, apply_theme_fonts, build_sources_xml, build_theme_xml,
    merge_default_fonts_xml, upsert_style_xml,
};
use super::helpers::{next_free_rel_id, rel_tag_with_id, replace_abstract_num_level};
use super::js::{dynamic, limit, replace_first, replace_first_with};
use super::notes_write::{build_notes_xml, note_part_path, note_rel_type};
use super::run_picture::patch_hf_pictures_xml;
use super::saver::{
    COMMENTS_EXT_REL_TYPE, COMMENTS_REL_TYPE, EMPTY_RELS_LF, FOOTER_REL_TYPE, HEADER_REL_TYPE,
    IMAGE_REL_TYPE, MediaSource, NUMBERING_REL_TYPE, PartOut, Saver, SourcesPart, image_ext,
};
use super::types::{HfKindOpt, HfVariant};
use super::xml_number_usable::usable_picture_size;
use crate::blank::{BLANK_NUMBERING_XML, abstract_num_xml, num_pic_bullet_xml};
use crate::generate::drawing_build::{
    DocPrId, InlinePictureXmlOptions, NEW_PICTURE_TOKEN_PREFIX, inline_picture_drawing_xml,
};
use crate::generate::escape_xml_attr as attr;
use crate::model::{CommentInfo, HeaderFooter, NewImageMime};
use crate::notes::NoteKind;
use crate::package::resolve_relationship_target_path;
use crate::save::parts::hf_parts::{header_footer_part_xml, hf_original_xml};
use crate::section::HfKind;
use crate::section::{hf_reference_r_id, hf_reference_tags, hf_reference_type};
use crate::sources::{CUSTOM_XML_REL_TYPE, find_sources_part};
use crate::theme::THEME_PART_PATH;
use crate::watermark::{BoxPt, Watermark, is_picture_watermark, read_picture_watermark};

pub const NUMBERING_PATH: &str = "word/numbering.xml";
pub const STYLES_PATH: &str = "word/styles.xml";
pub const COMMENTS_PATH: &str = "word/comments.xml";
pub const COMMENTS_EXT_PATH: &str = "word/commentsExtended.xml";

fn hf_kind(kind: HfKindOpt) -> HfKind {
    match kind {
        HfKindOpt::Header => HfKind::Header,
        HfKindOpt::Footer => HfKind::Footer,
    }
}

/// `partPath.replace(/^word\/([^/]+)$/, 'word/_rels/$1.rels')`
pub fn part_rels_path(part_path: &str) -> String {
    match part_path.strip_prefix("word/") {
        Some(name) if !name.contains('/') && !name.is_empty() => format!("word/_rels/{name}.rels"),
        _ => part_path.to_owned(),
    }
}

/// The reference a trailing or section sectPr holds for `variant`: Word's
/// non-schema `odd` and untyped references count as default.
pub fn existing_hf_reference(sect_pr: &str, kind: HfKindOpt, variant: HfVariant) -> Option<&str> {
    let refs = hf_reference_tags(sect_pr, hf_kind(kind));
    let found = refs
        .iter()
        .find(|r| hf_reference_type(r) == Some(variant.as_str()))
        .copied();
    if found.is_some() {
        return found;
    }
    if variant != HfVariant::Default {
        return None;
    }
    refs.iter()
        .find(|r| hf_reference_type(r) == Some("odd"))
        .or_else(|| refs.iter().find(|r| hf_reference_type(r).is_none()))
        .copied()
}

impl Saver<'_> {
    /// The page box the watermark is fitted to: the one this save writes.
    fn margin_box_pt(&self) -> Result<Option<BoxPt>, String> {
        let trailing = &self.out.trailing_sect_pr;
        let saved = match (&self.options.section, &self.options.trailing_sect_pr) {
            (Some(section), own) => super::section_write::apply_section_settings(
                own.as_deref().unwrap_or(trailing),
                section,
            )?,
            (None, own) => own.clone().unwrap_or_else(|| trailing.clone()),
        };
        let sect_attr = |name: &str, key: &str| -> Result<Option<f64>, String> {
            let Some(tag) =
                crate::xml_tag::find_start_tag(&saved, crate::xml_tag::TagName::Exact(name), 0)
            else {
                return Ok(None);
            };
            let re = dynamic(&format!(r#"\sw:{key}="(-?\d+)""#), "")?;
            Ok(re
                .try_exec(tag.text)
                .map_err(limit)?
                .and_then(|found| found.get(1).map(|v| parse_int(v, Radix::Ten))))
        };
        let pg_w = sect_attr("w:pgSz", "w")?;
        let pg_h = sect_attr("w:pgSz", "h")?;
        let truthy = |n: Option<f64>| n.filter(|n| *n != 0.0 && !n.is_nan());
        let (Some(w), Some(h)) = (truthy(pg_w), truthy(pg_h)) else {
            return Ok(None);
        };
        let margin =
            |key: &str| -> Result<f64, String> { Ok(sect_attr("w:pgMar", key)?.unwrap_or(1440.0)) };
        Ok(Some(BoxPt {
            width_pt: JsNum((w - margin("left")? - margin("right")?) / 20.0),
            height_pt: JsNum((h - margin("top")? - margin("bottom")?) / 20.0),
        }))
    }

    /// `watermarkXmlFor`: the watermark paragraph XML for a header part:
    /// '' = remove it, otherwise the regenerated sdt. A picture watermark
    /// lands its media part and an image relationship in the part's own
    /// rels; a superseded picture watermark's relationship is dropped.
    pub fn watermark_xml_for(
        &mut self,
        watermark: &Option<Watermark>,
        part_path: &str,
        original_xml: Option<&str>,
    ) -> Result<String, String> {
        let rels_path = part_rels_path(part_path);
        let mut rels_xml = match self.zip.text(&rels_path).map_err(|e| e.to_string())? {
            Some(text) => text.to_owned(),
            None => EMPTY_RELS_LF.to_owned(),
        };
        let mut rels_changed = false;
        let old = original_xml.and_then(read_picture_watermark);
        if let (Some(old), Some(original)) = (&old, original_xml) {
            let uses = dynamic(&format!(r#"r:id\s*=\s*(["']){}\1"#, old.r_id), "g")?;
            let mut count = 0;
            for found in uses.try_find_iter(original) {
                found.map_err(limit)?;
                count += 1;
            }
            if count == 1 {
                let before = rels_xml.clone();
                rels_xml = replace_first(&rel_tag_with_id(&old.r_id)?, 1, &rels_xml, "")?;
                rels_changed = rels_xml != before;
            }
        }
        let xml = match watermark {
            None => String::new(),
            Some(wm) if !is_picture_watermark(wm) => super::external::watermark_paragraph_xml(wm)?,
            Some(wm) => {
                let Watermark::Picture(spec) = wm else {
                    return Err("a picture watermark".to_owned());
                };
                let media_path = self.land_media(&MediaSource {
                    base64: &spec.image.base64,
                    mime: mime_of(&spec.image.mime),
                    source_part: None,
                });
                let r_id = next_free_rel_id(&rels_xml)?;
                let target = media_path.strip_prefix("word/").unwrap_or(&media_path);
                rels_xml = jscompat::replace_first_string(
                    &rels_xml,
                    "</Relationships>",
                    &format!(
                        "<Relationship Id=\"{r_id}\" Type=\"{IMAGE_REL_TYPE}\" Target=\"{target}\"/></Relationships>"
                    ),
                );
                rels_changed = true;
                let margin_box = self.margin_box_pt()?;
                super::external::picture_watermark_paragraph_xml(wm, &r_id, margin_box.as_ref())?
            }
        };
        if rels_changed {
            self.set_hf_rels_out(rels_path, rels_xml);
        }
        Ok(xml)
    }

    /// `hfRelsOut.set`: a path keeps its first place and takes the new text.
    pub fn set_hf_rels_out(&mut self, path: String, xml: String) {
        match self
            .out
            .hf_rels_out
            .iter_mut()
            .find(|(have, _)| *have == path)
        {
            Some(entry) => entry.1 = xml,
            None => self.out.hf_rels_out.push((path, xml)),
        }
    }

    /// `resolveHfNewPictures`: pictures the editor inserted into a
    /// header/footer part: land the bytes, add the image relationship to the
    /// part's own rels and swap in the real ids.
    fn resolve_hf_new_pictures(
        &mut self,
        part_path: &str,
        xml: String,
        hf: &HeaderFooter,
    ) -> Result<String, String> {
        let Some(pictures) = hf.new_pictures.as_ref() else {
            return Ok(xml);
        };
        if !xml.contains(NEW_PICTURE_TOKEN_PREFIX) {
            return Ok(xml);
        }
        let rels_path = part_rels_path(part_path);
        let mut rels_xml = match self
            .out
            .hf_rels_out
            .iter()
            .find(|(path, _)| *path == rels_path)
        {
            Some((_, text)) => text.clone(),
            None => match self.zip.text(&rels_path).map_err(|e| e.to_string())? {
                Some(text) => text.to_owned(),
                None => EMPTY_RELS_LF.to_owned(),
            },
        };
        let mut r_ids: Vec<(String, String)> = Vec::new();
        let mut doc_pr_ids: Vec<(String, f64)> = Vec::new();
        let re = dynamic(
            &format!(r#"(r:embed|id|name)="(Picture )?({NEW_PICTURE_TOKEN_PREFIX}[0-9]+)""#),
            "g",
        )?;
        let mut failure: Option<String> = None;
        let out = re
            .try_replace_all(&xml, |found| {
                let whole = found.as_str();
                let attr_name = found.get(1).unwrap_or_default();
                let prefix = found.get(2);
                let token = found.get(3).unwrap_or_default();
                let Some(picture) = pictures.get(token) else {
                    return whole.to_owned();
                };
                if attr_name == "r:embed" {
                    if let Some((_, r_id)) = r_ids.iter().find(|(have, _)| have == token) {
                        return format!("r:embed=\"{r_id}\"");
                    }
                    let r_id = match next_free_rel_id(&rels_xml) {
                        Ok(id) => id,
                        Err(error) => {
                            failure.get_or_insert(error);
                            return whole.to_owned();
                        }
                    };
                    let path = self.land_media(&MediaSource {
                        base64: &picture.base64,
                        mime: picture.mime,
                        source_part: None,
                    });
                    let target = path.strip_prefix("word/").unwrap_or(&path);
                    rels_xml = jscompat::replace_first_string(
                        &rels_xml,
                        "</Relationships>",
                        &format!("<Relationship Id=\"{r_id}\" Type=\"{IMAGE_REL_TYPE}\" Target=\"{target}\"/></Relationships>"),
                    );
                    r_ids.push((token.to_owned(), r_id.clone()));
                    return format!("r:embed=\"{r_id}\"");
                }
                let id = match doc_pr_ids.iter().find(|(have, _)| have == token) {
                    Some((_, id)) => *id,
                    None => {
                        let id = self.next_doc_pr_id();
                        doc_pr_ids.push((token.to_owned(), id));
                        id
                    }
                };
                format!("{attr_name}=\"{}{}\"", prefix.unwrap_or(""), number_to_string(id))
            })
            .map_err(limit)?;
        if let Some(error) = failure {
            return Err(error);
        }
        if !r_ids.is_empty() {
            self.set_hf_rels_out(rels_path, rels_xml);
        }
        Ok(out)
    }

    /// `editedHfPartXml`: an existing part after a strip edit: moved / resized
    /// floating pictures are patched into their drawings, and a picture-only
    /// edit keeps the text bytes.
    fn edited_hf_part_xml(
        &self,
        kind: HfKindOpt,
        hf: &HeaderFooter,
        original_xml: Option<String>,
    ) -> Result<String, String> {
        let base = match (&original_xml, &hf.picture_edits) {
            (Some(original), Some(edits)) if !original.is_empty() => {
                Some(patch_hf_pictures_xml(original, edits)?)
            }
            _ => original_xml,
        };
        if let Some(base) = &base
            && !base.is_empty()
            && (hf.picture_only == Some(true) || hf.keep_content.is_some())
        {
            return Ok(base.clone());
        }
        header_footer_part_xml(
            kind.as_str(),
            hf,
            None,
            base.as_deref(),
            self.options.page_count.map_or(1.0, |n| n.0),
        )
    }

    /// The first free `word/<kind>N.xml`.
    fn free_hf_filename(&self, kind: HfKindOpt) -> String {
        let mut n = 1u64;
        loop {
            let path = format!("word/{}{n}.xml", kind.as_str());
            if self.zip.file(&path).is_none() && !self.out.hf_parts.iter().any(|p| p.0 == path) {
                return format!("{}{n}.xml", kind.as_str());
            }
            n += 1;
        }
    }

    fn hf_rel_type(kind: HfKindOpt) -> &'static str {
        match kind {
            HfKindOpt::Header => HEADER_REL_TYPE,
            HfKindOpt::Footer => FOOTER_REL_TYPE,
        }
    }

    fn hf_override(kind: HfKindOpt, filename: &str) -> String {
        format!(
            "<Override PartName=\"/word/{filename}\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.{}+xml\"/>",
            kind.as_str()
        )
    }

    /// `planHeaderFooter`
    fn plan_header_footer(
        &mut self,
        kind: HfKindOpt,
        hf: Option<&HeaderFooter>,
        hf_type: HfVariant,
    ) -> Result<(), String> {
        let Some(hf) = hf else { return Ok(()) };
        let trailing = self.out.trailing_sect_pr.clone();
        let existing = existing_hf_reference(&trailing, kind, hf_type);
        let r_id = existing.and_then(hf_reference_r_id);
        let target = r_id.and_then(|id| self.out.rel_targets.get(id)).cloned();
        if let Some(target) = target {
            let Some(path) = resolve_relationship_target_path(&self.doc_path, &target) else {
                return Ok(());
            };
            let file = self
                .zip
                .text(&path)
                .map_err(|e| e.to_string())?
                .map(str::to_owned);
            let original_xml = hf_original_xml(hf, file.as_deref())?;
            let edited = self.edited_hf_part_xml(kind, hf, original_xml)?;
            let part_xml = self.resolve_hf_new_pictures(&path, edited, hf)?;
            self.out.hf_parts.push((path, part_xml));
        } else {
            let filename = self.free_hf_filename(kind);
            let generated = header_footer_part_xml(
                kind.as_str(),
                hf,
                None,
                None,
                self.options.page_count.map_or(1.0, |n| n.0),
            )?;
            let part_xml =
                self.resolve_hf_new_pictures(&format!("word/{filename}"), generated, hf)?;
            let new_r_id = self.next_rel_id();
            self.push_rel(new_r_id.clone(), Self::hf_rel_type(kind), filename.clone());
            self.out
                .hf_parts
                .push((format!("word/{filename}"), part_xml));
            self.out.hf_ref_tags.push(format!(
                "<w:{}Reference w:type=\"{}\" r:id=\"{new_r_id}\"/>",
                kind.as_str(),
                hf_type.as_str()
            ));
            self.out
                .hf_overrides
                .push(Self::hf_override(kind, &filename));
        }
        Ok(())
    }

    /// The trailing sectPr, the relationship targets, then the default,
    /// first and even header/footer parts and the per-section edits.
    pub fn plan_headers_footers(&mut self) -> Result<(), String> {
        let sect_block = self.parsed.blocks.iter().find(|b| {
            *b.hidden == Some(true)
                && b.original_xml
                    .as_ref()
                    .is_some_and(|xml| xml.as_ref().is_some_and(|xml| xml.contains("<w:sectPr")))
        });
        self.out.trailing_sect_pr = sect_block
            .and_then(|b| b.original_xml.as_ref().and_then(|xml| xml.clone()))
            .unwrap_or_default();
        for tag in js_regex!(r"<Relationship\b[^>]*\/>", "g").find_iter(&self.rels_xml) {
            let id = js_regex!(r#"\bId\s*=\s*(["'])([^"']*)\1"#)
                .exec(tag.as_str())
                .and_then(|found| found.get(2).filter(|id| !id.is_empty()).map(str::to_owned));
            let target = js_regex!(r#"\bTarget\s*=\s*(["'])([^"']*)\1"#)
                .exec(tag.as_str())
                .and_then(|found| found.get(2).filter(|t| !t.is_empty()).map(str::to_owned));
            if let (Some(id), Some(target)) = (id, target) {
                self.out.rel_targets.insert(id, target);
            }
        }
        // Header text edits keep each part's own watermark: a pending watermark is applied separately
        let options = self.options;
        self.plan_header_footer(
            HfKindOpt::Header,
            options.header.as_ref(),
            HfVariant::Default,
        )?;
        self.plan_header_footer(
            HfKindOpt::Footer,
            options.footer.as_ref(),
            HfVariant::Default,
        )?;
        self.plan_header_footer(
            HfKindOpt::Header,
            options.header_first.as_ref(),
            HfVariant::First,
        )?;
        self.plan_header_footer(
            HfKindOpt::Footer,
            options.footer_first.as_ref(),
            HfVariant::First,
        )?;
        self.plan_header_footer(
            HfKindOpt::Header,
            options.header_even.as_ref(),
            HfVariant::Even,
        )?;
        self.plan_header_footer(
            HfKindOpt::Footer,
            options.footer_even.as_ref(),
            HfVariant::Even,
        )?;

        // per-section header/footer (non-last sections): with a reference, rewrite the part;
        // without one, create a part and inject the reference
        for edit in options.section_hf.as_deref().unwrap_or_default() {
            let block =
                self.parsed.blocks.iter().find(
                    |b| matches!(*b.docx_index, Some(Some(n)) if n.0 == edit.last_block_index.0),
                );
            let sect_pr = match block
                .and_then(|b| b.original_xml.as_ref())
                .and_then(|xml| xml.clone())
            {
                Some(xml) => try_js_regex!(r"<w:sectPr[^>]*\/>|<w:sectPr[\s\S]*?<\/w:sectPr>")
                    .try_exec(&xml)
                    .map_err(limit)?
                    .map(|found| found.as_str().to_owned())
                    .unwrap_or_default(),
                None => String::new(),
            };
            let variant = edit.variant.unwrap_or(HfVariant::Default);
            let existing = existing_hf_reference(&sect_pr, edit.kind, variant);
            let r_id = existing.and_then(hf_reference_r_id);
            let target = r_id.and_then(|id| self.out.rel_targets.get(id)).cloned();
            if let Some(target) = target {
                let Some(path) = resolve_relationship_target_path(&self.doc_path, &target) else {
                    continue;
                };
                let file = self
                    .zip
                    .text(&path)
                    .map_err(|e| e.to_string())?
                    .map(str::to_owned);
                let original_xml = hf_original_xml(&edit.hf, file.as_deref())?;
                let edited = self.edited_hf_part_xml(edit.kind, &edit.hf, original_xml)?;
                let xml = self.resolve_hf_new_pictures(&path, edited, &edit.hf)?;
                self.out.hf_parts.push((path, xml));
            } else {
                let filename = self.free_hf_filename(edit.kind);
                let generated = header_footer_part_xml(
                    edit.kind.as_str(),
                    &edit.hf,
                    None,
                    None,
                    options.page_count.map_or(1.0, |n| n.0),
                )?;
                let part_xml =
                    self.resolve_hf_new_pictures(&format!("word/{filename}"), generated, &edit.hf)?;
                let new_r_id = self.next_rel_id();
                self.push_rel(
                    new_r_id.clone(),
                    Self::hf_rel_type(edit.kind),
                    filename.clone(),
                );
                self.out
                    .hf_parts
                    .push((format!("word/{filename}"), part_xml));
                self.out
                    .hf_overrides
                    .push(Self::hf_override(edit.kind, &filename));
                let tag = format!(
                    "<w:{}Reference w:type=\"{}\" r:id=\"{new_r_id}\"/>",
                    edit.kind.as_str(),
                    variant.as_str()
                );
                match self
                    .out
                    .section_ref_tags
                    .iter_mut()
                    .find(|(index, _)| *index == edit.last_block_index.0)
                {
                    Some((_, tags)) => tags.push(tag),
                    None => self
                        .out
                        .section_ref_tags
                        .push((edit.last_block_index.0, vec![tag])),
                }
            }
        }
        Ok(())
    }

    /// Numbering: append numbering definitions (create the part from the blank template when missing).
    pub fn plan_numbering(&mut self) -> Result<(), String> {
        let Some(numbering) = self.options.numbering.as_ref() else {
            return Ok(());
        };
        let count = |len: Option<usize>| len.unwrap_or(0);
        if count(numbering.new_defs.as_ref().map(Vec::len)) == 0
            && count(numbering.restart_nums.as_ref().map(Vec::len)) == 0
            && count(numbering.level_edits.as_ref().map(Vec::len)) == 0
            && count(numbering.pic_bullets.as_ref().map(Vec::len)) == 0
        {
            return Ok(());
        }
        let existing = self
            .zip
            .text(NUMBERING_PATH)
            .map_err(|e| e.to_string())?
            .map(str::to_owned);
        let mut xml = match existing {
            Some(xml) => xml,
            None => {
                self.out.numbering_is_new = true;
                let r_id = self.next_rel_id();
                self.push_rel(r_id, NUMBERING_REL_TYPE, "numbering.xml".to_owned());
                BLANK_NUMBERING_XML.clone()
            }
        };
        // new abstractNum ids are assigned by the engine
        let mut max_abs = -1.0;
        for found in
            try_js_regex!(r#"<w:abstractNum [^>]*w:abstractNumId="(\d+)""#, "g").try_find_iter(&xml)
        {
            let found = found.map_err(limit)?;
            max_abs = jscompat::math_max(
                max_abs,
                parse_int(found.get(1).unwrap_or_default(), Radix::Ten),
            );
        }
        let mut abs_xmls: Vec<String> = Vec::new();
        let mut num_xmls: Vec<String> = Vec::new();
        // the renderer names a not-yet-saved definition's abstractNum "pending-<numId>"
        let mut pending_abs: Vec<(String, String)> = Vec::new();
        for def in numbering.new_defs.as_deref().unwrap_or_default() {
            max_abs += 1.0;
            let abs_id = number_to_string(max_abs);
            let key = format!("pending-{}", def.num_id);
            match pending_abs.iter_mut().find(|(have, _)| *have == key) {
                Some(entry) => entry.1 = abs_id.clone(),
                None => pending_abs.push((key, abs_id.clone())),
            }
            abs_xmls.push(abstract_num_xml(&abs_id, &def.kind, def.levels.as_deref()));
            num_xmls.push(format!(
                "<w:num w:numId=\"{}\"><w:abstractNumId w:val=\"{abs_id}\"/></w:num>",
                def.num_id
            ));
        }
        for r in numbering.restart_nums.as_deref().unwrap_or_default() {
            let abs_id = pending_abs
                .iter()
                .find(|(key, _)| *key == r.abstract_num_id)
                .map_or(r.abstract_num_id.as_str(), |(_, id)| id.as_str());
            if abs_id.starts_with("pending-") {
                continue;
            }
            let overrides: String = r
                .start_overrides
                .0
                .entries()
                .iter()
                .map(|(ilvl, v)| {
                    format!(
                        "<w:lvlOverride w:ilvl=\"{ilvl}\"><w:startOverride w:val=\"{}\"/></w:lvlOverride>",
                        number_to_string(v.0)
                    )
                })
                .collect();
            num_xmls.push(format!(
                "<w:num w:numId=\"{}\"><w:abstractNumId w:val=\"{abs_id}\"/>{overrides}</w:num>",
                r.num_id
            ));
        }
        for edit in numbering.level_edits.as_deref().unwrap_or_default() {
            if edit.abstract_num_id.starts_with("pending-") {
                continue;
            }
            xml =
                replace_abstract_num_level(&xml, &edit.abstract_num_id, edit.ilvl.0, &edit.level)?;
        }
        if numbering
            .pic_bullets
            .as_ref()
            .is_some_and(|pics| !pics.is_empty())
        {
            let rels_path = "word/_rels/numbering.xml.rels";
            let rels_text = self
                .zip
                .text(rels_path)
                .map_err(|e| e.to_string())?
                .map(str::to_owned);
            let rels_is_new = rels_text.is_none();
            let mut rels_xml = rels_text.unwrap_or_else(|| {
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>".to_owned()
            });
            let mut rel_num = 1.0;
            for found in
                try_js_regex!(r#"\bId\s*=\s*(["'])rId(\d+)\1"#, "g").try_find_iter(&rels_xml)
            {
                let found = found.map_err(limit)?;
                rel_num = jscompat::math_max(
                    rel_num,
                    parse_int(found.get(2).unwrap_or_default(), Radix::Ten) + 1.0,
                );
            }
            let mut pic_xmls: Vec<String> = Vec::new();
            for pic in numbering.pic_bullets.as_deref().unwrap_or_default() {
                let media_path = self.land_media(&MediaSource {
                    base64: &pic.base64,
                    mime: pic.mime,
                    source_part: None,
                });
                let r_id = format!("rId{}", number_to_string(rel_num));
                rel_num += 1.0;
                let target = media_path.strip_prefix("word/").unwrap_or(&media_path);
                rels_xml = jscompat::replace_first_string(
                    &rels_xml,
                    "</Relationships>",
                    &format!(
                        "<Relationship Id=\"{r_id}\" Type=\"{IMAGE_REL_TYPE}\" Target=\"{}\"/></Relationships>",
                        attr(target)
                    ),
                );
                pic_xmls.push(num_pic_bullet_xml(pic.id.0, &r_id));
            }
            // schema order: numPicBullet* precedes abstractNum*
            let joined = pic_xmls.join("");
            let abstract_re = try_js_regex!(r"<w:abstractNum[\s>]");
            xml = if abstract_re.try_test(&xml).map_err(limit)? {
                replace_first_with(abstract_re, &xml, |found| {
                    format!("{joined}{}", found.as_str())
                })?
            } else {
                jscompat::replace_first_string(
                    &xml,
                    "</w:numbering>",
                    &format!("{joined}</w:numbering>"),
                )
            };
            self.out.numbering_rels_out = Some(PartOut {
                path: rels_path.to_owned(),
                xml: rels_xml,
                is_new: rels_is_new,
            });
        }
        // schema order: abstractNum* comes before num*: new abstracts go before the first w:num
        if !abs_xmls.is_empty() {
            let joined = abs_xmls.join("");
            let num_re = try_js_regex!(r"<w:num[\s>]");
            xml = if num_re.try_test(&xml).map_err(limit)? {
                replace_first_with(num_re, &xml, |found| format!("{joined}{}", found.as_str()))?
            } else {
                jscompat::replace_first_string(
                    &xml,
                    "</w:numbering>",
                    &format!("{joined}</w:numbering>"),
                )
            };
        }
        xml = jscompat::replace_first_string(
            &xml,
            "</w:numbering>",
            &format!("{}</w:numbering>", num_xmls.join("")),
        );
        self.out.numbering_xml_out = Some(xml);
        Ok(())
    }

    /// Styles: surgical upsert of word/styles.xml (create/modify styles).
    pub fn plan_styles(&mut self) -> Result<(), String> {
        if self.style_upserts.is_empty() && self.options.default_fonts.is_none() {
            return Ok(());
        }
        let mut xml = match self.zip.text(STYLES_PATH).map_err(|e| e.to_string())? {
            Some(xml) => xml.to_owned(),
            None => "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"></w:styles>".to_owned(),
        };
        for up in &self.style_upserts {
            xml = upsert_style_xml(&xml, up)?;
        }
        self.out.styles_xml_out = Some(match &self.options.default_fonts {
            Some(fonts) => merge_default_fonts_xml(&xml, fonts)?,
            None => xml,
        });
        Ok(())
    }

    /// Comments: regenerate word/comments.xml from the full desired list.
    pub fn plan_comments(&mut self) -> Result<(), String> {
        let Some(comments) = self.options.comments.as_ref() else {
            return Ok(());
        };
        // every comment has a paraId (the commentsExtended link key)
        let mut para_seq = 1.0;
        let with_para_ids: Vec<CommentInfo> = comments
            .iter()
            .map(|c| {
                if c.para_id.as_deref().is_some_and(|id| !id.is_empty()) {
                    return c.clone();
                }
                let id = parse_int(&c.id, Radix::Ten);
                let value = 0x1000_0000 as f64 + para_seq * 0x1111 as f64 + id;
                para_seq += 1.0;
                let hex = jscompat::to_string_radix16(value).to_uppercase();
                let mut with = c.clone();
                with.para_id = Some(jscompat::pad_start(&hex, 8, '0'));
                with
            })
            .collect();
        // comment pictures: the bytes land as media parts and their relationships live in the
        // comments part's own rels file, not the document's
        let comments_file = self
            .zip
            .text(COMMENTS_PATH)
            .map_err(|e| e.to_string())?
            .map(str::to_owned);
        let mut image_runs: Vec<(String, String)> = Vec::new();
        let image_comments: Vec<&CommentInfo> =
            with_para_ids.iter().filter(|c| c.image.is_some()).collect();
        // a comment whose text AND picture bytes are both unchanged keeps its original XML
        let mut original_image_bytes_of: Vec<(String, Option<String>)> = Vec::new();
        let mut kept_image_runs: Vec<(String, String)> = Vec::new();
        if let Some(original) = comments_file.as_deref().filter(|xml| !xml.is_empty()) {
            let orig_rels = self
                .zip
                .text("word/_rels/comments.xml.rels")
                .map_err(|e| e.to_string())?
                .map(str::to_owned);
            for found in try_js_regex!(r"<w:comment\s[^>]*>[\s\S]*?<\/w:comment>", "g")
                .try_find_iter(original)
            {
                let comment = found.map_err(limit)?.as_str().to_owned();
                let Some(id) = js_regex!(r#"w:id="([^"]+)""#)
                    .exec(&comment)
                    .and_then(|f| f.get(1).map(str::to_owned))
                else {
                    continue;
                };
                let blip_rel = js_regex!(r#"r:embed="([^"]+)""#)
                    .exec(&comment)
                    .and_then(|f| f.get(1).map(str::to_owned));
                let rel = match (&blip_rel, &orig_rels) {
                    (Some(blip), Some(rels)) => {
                        dynamic(&format!(r#"<Relationship\b[^>]*Id="{blip}"[^>]*/>"#), "")?
                            .try_exec(rels)
                            .map_err(limit)?
                            .map(|f| f.as_str().to_owned())
                    }
                    _ => None,
                };
                let target = rel.as_deref().and_then(|rel| {
                    js_regex!(r#"Target="([^"]+)""#)
                        .exec(rel)
                        .and_then(|f| f.get(1).map(str::to_owned))
                });
                let media_bytes = match target {
                    Some(target) => self
                        .zip
                        .bytes(&format!("word/{}", first_replace(&target)))
                        .map_err(|e| e.to_string())?
                        .map(jscompat::base64),
                    None => None,
                };
                match original_image_bytes_of
                    .iter_mut()
                    .find(|(have, _)| *have == id)
                {
                    Some(entry) => entry.1 = media_bytes,
                    None => original_image_bytes_of.push((id.clone(), media_bytes)),
                }
                if let Some(drawing) = try_js_regex!(r"<w:drawing>[\s\S]*?<\/w:drawing>")
                    .try_exec(&comment)
                    .map_err(limit)?
                {
                    let run = format!("<w:r>{}</w:r>", drawing.as_str());
                    match kept_image_runs.iter_mut().find(|(have, _)| *have == id) {
                        Some(entry) => entry.1 = run,
                        None => kept_image_runs.push((id, run)),
                    }
                }
            }
        }
        if !image_comments.is_empty() {
            let comments_rels_path = "word/_rels/comments.xml.rels";
            let rels_text = self
                .zip
                .text(comments_rels_path)
                .map_err(|e| e.to_string())?
                .map(str::to_owned);
            if rels_text.is_none() {
                self.out.comments_rels_is_new = true;
            }
            let mut rel_seq = 0.0;
            for found in try_js_regex!(r#"Id="rId(\d+)""#, "g")
                .try_find_iter(rels_text.as_deref().unwrap_or(""))
            {
                let found = found.map_err(limit)?;
                rel_seq = jscompat::math_max(
                    rel_seq,
                    parse_int(found.get(1).unwrap_or_default(), Radix::Ten),
                );
            }
            let mut added: Vec<String> = Vec::new();
            for c in &image_comments {
                let Some(image) = &c.image else { continue };
                let same = original_image_bytes_of
                    .iter()
                    .find(|(have, _)| *have == c.id)
                    .and_then(|(_, bytes)| bytes.as_deref())
                    == Some(image.base64.as_str());
                if same {
                    continue;
                }
                let media_path = self.land_media(&MediaSource {
                    base64: &image.base64,
                    mime: image.mime,
                    source_part: None,
                });
                self.note_extension(image_ext(image.mime));
                rel_seq += 1.0;
                let r_id = format!("rId{}", number_to_string(rel_seq));
                let target = media_path.strip_prefix("word/").unwrap_or(&media_path);
                added.push(format!(
                    "<Relationship Id=\"{r_id}\" Type=\"{IMAGE_REL_TYPE}\" Target=\"{target}\"/>"
                ));
                let (width, height) = usable_picture_size(image.width_px.0, image.height_px.0);
                let doc_pr_id = self.next_doc_pr_id();
                let drawing = inline_picture_drawing_xml(&InlinePictureXmlOptions {
                    r_id,
                    doc_pr_id: DocPrId::Number(doc_pr_id),
                    width_px: width,
                    height_px: height,
                    alt_text: None,
                    rot_deg: None,
                    flip_h: None,
                    flip_v: None,
                })?;
                let run = format!("<w:r>{drawing}</w:r>");
                match image_runs.iter_mut().find(|(have, _)| *have == c.id) {
                    Some(entry) => entry.1 = run,
                    None => image_runs.push((c.id.clone(), run)),
                }
            }
            let base = rels_text.unwrap_or_else(|| {
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>".to_owned()
            });
            self.out.comments_rels_xml = Some(jscompat::replace_first_string(
                &base,
                "</Relationships>",
                &format!("{}</Relationships>", added.join("")),
            ));
        }
        let image_map: std::collections::HashMap<String, String> = image_runs.into_iter().collect();
        let kept_map: std::collections::HashMap<String, String> =
            kept_image_runs.into_iter().collect();
        self.out.comments_xml = Some(crate::save::parts::comments::build_comments_xml(
            &with_para_ids,
            comments_file.as_deref(),
            Some(&image_map),
            Some(&kept_map),
        )?);
        if self.zip.file(COMMENTS_PATH).is_none() {
            self.out.comments_is_new = true;
            let r_id = self.next_rel_id();
            self.push_rel(r_id, COMMENTS_REL_TYPE, "comments.xml".to_owned());
        }
        // regenerate commentsExtended.xml in step when replies/resolved flags exist, or the part exists
        let need_ext = self.zip.file(COMMENTS_EXT_PATH).is_some()
            || with_para_ids
                .iter()
                .any(|c| c.parent_id.is_some() || c.done.is_some());
        if need_ext {
            self.out.comments_ext_xml = Some(
                crate::save::parts::comments::build_comments_extended_xml(&with_para_ids),
            );
            if self.zip.file(COMMENTS_EXT_PATH).is_none() {
                self.out.comments_ext_is_new = true;
                let r_id = self.next_rel_id();
                self.push_rel(
                    r_id,
                    COMMENTS_EXT_REL_TYPE,
                    "commentsExtended.xml".to_owned(),
                );
            }
        }
        Ok(())
    }

    /// Footnotes / endnotes: regenerate the part from the full desired list.
    pub fn plan_notes(&mut self) -> Result<(), String> {
        let options = self.options;
        for (kind, notes) in [
            (NoteKind::Footnote, &options.footnotes),
            (NoteKind::Endnote, &options.endnotes),
        ] {
            let Some(notes) = notes else { continue };
            let path = note_part_path(kind);
            let original = self
                .zip
                .text(path)
                .map_err(|e| e.to_string())?
                .map(str::to_owned);
            let xml = build_notes_xml(kind, notes, original.as_deref())?;
            let is_new = original.is_none();
            self.out.notes_parts.push((
                PartOut {
                    path: path.to_owned(),
                    xml,
                    is_new,
                },
                kind,
            ));
            if is_new {
                let r_id = self.next_rel_id();
                self.push_rel(
                    r_id,
                    note_rel_type(kind),
                    path.strip_prefix("word/").unwrap_or(path).to_owned(),
                );
            }
        }
        Ok(())
    }

    /// Bibliography sources: the b:Sources customXml part.
    pub fn plan_sources(&mut self) -> Result<(), String> {
        let Some(sources) = self.options.sources.as_ref() else {
            return Ok(());
        };
        let existing = find_sources_part(&self.zip).map_err(|e| e.to_string())?;
        let existing_xml = match &existing {
            Some(path) => self
                .zip
                .text(path)
                .map_err(|e| e.to_string())?
                .map(str::to_owned),
            None => None,
        };
        let xml = build_sources_xml(sources, existing_xml.as_deref())?;
        if let Some(existing) = existing {
            let n = js_regex!(r"item(\d+)\.xml$")
                .exec(&existing)
                .and_then(|f| f.get(1).map(str::to_owned))
                .unwrap_or_else(|| "1".to_owned());
            self.out.sources_part = Some(SourcesPart {
                path: existing,
                props_path: format!("customXml/itemProps{n}.xml"),
                xml,
                is_new: false,
            });
        } else {
            let mut n = 1u64;
            while self.zip.file(&format!("customXml/item{n}.xml")).is_some() {
                n += 1;
            }
            self.out.sources_part = Some(SourcesPart {
                path: format!("customXml/item{n}.xml"),
                props_path: format!("customXml/itemProps{n}.xml"),
                xml,
                is_new: true,
            });
            let r_id = self.next_rel_id();
            self.push_rel(
                r_id,
                CUSTOM_XML_REL_TYPE,
                format!("../customXml/item{n}.xml"),
            );
        }
        Ok(())
    }

    /// Theme fonts / colors: patch or create word/theme/theme1.xml.
    pub fn plan_theme(&mut self) -> Result<(), String> {
        let options = self.options;
        if options.theme_fonts.is_none() && options.theme_colors.is_none() {
            return Ok(());
        }
        match self
            .zip
            .text(THEME_PART_PATH)
            .map_err(|e| e.to_string())?
            .map(str::to_owned)
        {
            Some(mut xml) => {
                if let Some(fonts) = &options.theme_fonts {
                    xml = apply_theme_fonts(&xml, fonts)?;
                }
                if let Some(colors) = &options.theme_colors {
                    xml = apply_theme_colors(&xml, colors)?;
                }
                self.out.theme_part = Some((xml, false));
            }
            None => {
                let fonts =
                    options
                        .theme_fonts
                        .clone()
                        .unwrap_or_else(|| crate::model::ThemeFonts {
                            major: "Calibri Light".to_owned(),
                            minor: "Calibri".to_owned(),
                            east_asia: Some(String::new()),
                            ..Default::default()
                        });
                let colors = options.theme_colors.clone().unwrap_or_default();
                self.out.theme_part = Some((build_theme_xml(&fonts, &colors)?, true));
                let r_id = self.next_rel_id();
                self.push_rel(r_id, THEME_REL_TYPE, "theme/theme1.xml".to_owned());
            }
        }
        Ok(())
    }
}

/// `mime` of a watermark image spec as the media table knows it.
fn mime_of(mime: &str) -> NewImageMime {
    match mime {
        "image/png" => NewImageMime::ImagePng,
        "image/gif" => NewImageMime::ImageGif,
        _ => NewImageMime::ImageJpeg,
    }
}

/// `target.replace(/^\/?(?:word\/)?/, '')`
fn first_replace(target: &str) -> String {
    let rest = target.strip_prefix('/').unwrap_or(target);
    rest.strip_prefix("word/").unwrap_or(rest).to_owned()
}
