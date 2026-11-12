//! `saveDocx`, phase by phase (3): settings, relationships, content types,
//! core properties, and the output package.

use jscompat::js_regex;
use ooxml_pkg::{Package, Part};

use super::external::{
    CUSTOM_PROPERTIES_CONTENT_TYPE, CUSTOM_PROPERTIES_PATH, THEME_CONTENT_TYPE,
    apply_property_changes, apply_remove_parts, build_sources_item_props_xml,
    cleanup_docx_owned_resources, referenced_relationship_ids,
};
use super::helpers::{clean_story_move_ranges, patch_core_props};
use super::js::jszip_base64;
use super::notes_write::note_content_type;
use super::plan::{COMMENTS_EXT_PATH, COMMENTS_PATH, NUMBERING_PATH, STYLES_PATH};
use super::saver::{CHART_CONTENT_TYPE, SETTINGS_REL_TYPE, Saver, XLSX_CONTENT_TYPE};
use crate::generate::escape_xml_attr as attr;
use crate::save::parts::scrub::scrub_personal_metadata;
use crate::save::parts::settings::{
    apply_even_and_odd_headers, apply_protection, apply_remove_personal_info, apply_settings_flag,
    apply_write_protection, insert_settings_child,
};
use crate::theme::THEME_PART_PATH;

const CORE_PROPS_PATH: &str = "docProps/core.xml";
const SETTINGS_PATH: &str = "word/settings.xml";
const CONTENT_TYPES_PATH: &str = "[Content_Types].xml";
const ROOT_RELS_PATH: &str = "_rels/.rels";

impl Saver<'_> {
    /// settings.xml: the flags the options set, each at its CT_Settings position.
    /// Returns the new text and whether the part is new.
    fn settings_xml(&mut self) -> Result<(Option<String>, bool), String> {
        let options = self.options;
        let page_color = options
            .page_color
            .as_ref()
            .and_then(|c| c.as_deref())
            .is_some_and(|c| !c.is_empty());
        if !(page_color
            || options.protection.is_some()
            || options.write_protection.is_some()
            || options.remove_personal_info.is_some()
            || options.even_and_odd_headers.is_some()
            || options.mirror_margins.is_some()
            || options.track_revisions.is_some())
        {
            return Ok((None, false));
        }
        let mut is_new = false;
        let mut touched = false;
        let mut xml = match self.zip.text(SETTINGS_PATH).map_err(|e| e.to_string())? {
            Some(xml) => xml.to_owned(),
            None => {
                is_new = true;
                touched = true;
                let r_id = self.next_rel_id();
                self.push_rel(r_id, SETTINGS_REL_TYPE, "settings.xml".to_owned());
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:settings xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"></w:settings>".to_owned()
            }
        };
        // Word only renders w:background when settings.xml opts in
        if page_color && !xml.contains("<w:displayBackgroundShape") {
            xml = insert_settings_child(
                &xml,
                "displayBackgroundShape",
                "<w:displayBackgroundShape/>",
            )?;
            touched = true;
        }
        if let Some(protection) = &options.protection {
            xml = apply_protection(&xml, protection.as_ref())?;
            touched = true;
        }
        if let Some(on) = options.remove_personal_info {
            xml = apply_remove_personal_info(&xml, on)?;
            touched = true;
        }
        if let Some(write) = &options.write_protection {
            xml = apply_write_protection(&xml, write.as_ref())?;
            touched = true;
        }
        if let Some(on) = options.even_and_odd_headers {
            xml = apply_even_and_odd_headers(&xml, on)?;
            touched = true;
        }
        if let Some(on) = options.mirror_margins {
            xml = apply_settings_flag(&xml, "w:mirrorMargins", on)?;
            touched = true;
        }
        if let Some(on) = options.track_revisions {
            xml = apply_settings_flag(&xml, "w:trackRevisions", on)?;
            touched = true;
        }
        Ok((touched.then_some(xml), is_new))
    }

    /// The package the save writes: every original part with what the phases
    /// changed, then the parts the phases added.
    pub fn assemble(&mut self, new_document_xml: String) -> Result<Vec<u8>, String> {
        let options = self.options;
        let (settings_xml, settings_is_new) = self.settings_xml()?;

        let mut rels_changed = false;
        if !self.new_rels.is_empty() && !self.rels_xml.is_empty() {
            let inserts: String = self
                .new_rels
                .iter()
                .map(|r| {
                    format!(
                        "<Relationship Id=\"{}\" Type=\"{}\" Target=\"{}\"{}/>",
                        attr(&r.r_id),
                        r.ty,
                        attr(&r.target),
                        if r.external {
                            " TargetMode=\"External\""
                        } else {
                            ""
                        }
                    )
                })
                .collect();
            self.rels_xml = jscompat::replace_first_string(
                &self.rels_xml,
                "</Relationships>",
                &format!("{inserts}</Relationships>"),
            );
            rels_changed = true;
        }

        let out_state = &self.out;
        let has_new_parts = !self.used_extensions.is_empty()
            || !out_state.hf_overrides.is_empty()
            || !self.new_chart_parts.is_empty()
            || !self.new_chart_workbooks.is_empty()
            || settings_is_new
            || out_state.comments_is_new
            || out_state.comments_ext_is_new
            || out_state.numbering_is_new
            || out_state.notes_parts.iter().any(|(p, _)| p.is_new)
            || out_state.sources_part.as_ref().is_some_and(|p| p.is_new)
            || out_state
                .theme_part
                .as_ref()
                .is_some_and(|(_, is_new)| *is_new)
            || self.custom_properties_is_new;
        let mut content_types_xml: Option<String> = None;
        if has_new_parts
            && let Some(text) = self
                .zip
                .text(CONTENT_TYPES_PATH)
                .map_err(|e| e.to_string())?
        {
            let mut xml = text.to_owned();
            let add_override = |xml: &mut String, part_name: &str, content_type: &str| {
                if !xml.contains(&format!("PartName=\"{part_name}\"")) {
                    *xml = jscompat::replace_first_string(
                        xml,
                        "</Types>",
                        &format!(
                            "<Override PartName=\"{part_name}\" ContentType=\"{content_type}\"/></Types>"
                        ),
                    );
                }
            };
            for ext in &self.used_extensions {
                if !xml.contains(&format!("Extension=\"{ext}\"")) {
                    let mime = match ext.as_str() {
                        "png" => "image/png",
                        "gif" => "image/gif",
                        _ => "image/jpeg",
                    };
                    xml = jscompat::replace_first_string(
                        &xml,
                        "</Types>",
                        &format!("<Default Extension=\"{ext}\" ContentType=\"{mime}\"/></Types>"),
                    );
                }
            }
            for over in &out_state.hf_overrides {
                let part_name = js_regex!(r#"PartName="([^"]+)""#)
                    .exec(over)
                    .and_then(|f| f.get(1).map(str::to_owned))
                    .unwrap_or_default();
                if !xml.contains(&format!("PartName=\"{part_name}\"")) {
                    xml = jscompat::replace_first_string(
                        &xml,
                        "</Types>",
                        &format!("{over}</Types>"),
                    );
                }
            }
            if out_state.comments_is_new {
                add_override(
                    &mut xml,
                    "/word/comments.xml",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
                );
            }
            if out_state.comments_ext_is_new {
                add_override(
                    &mut xml,
                    "/word/commentsExtended.xml",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml",
                );
            }
            if settings_is_new {
                add_override(
                    &mut xml,
                    "/word/settings.xml",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
                );
            }
            if out_state.numbering_is_new {
                add_override(
                    &mut xml,
                    "/word/numbering.xml",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
                );
            }
            for (path, _) in &self.new_chart_parts {
                add_override(&mut xml, &format!("/{path}"), CHART_CONTENT_TYPE);
            }
            for wb in &self.new_chart_workbooks {
                add_override(&mut xml, &format!("/{}", wb.xlsx_path), XLSX_CONTENT_TYPE);
            }
            for (part, kind) in &out_state.notes_parts {
                if part.is_new {
                    add_override(
                        &mut xml,
                        &format!("/{}", part.path),
                        note_content_type(*kind),
                    );
                }
            }
            if let Some(sources) = out_state.sources_part.as_ref().filter(|p| p.is_new) {
                add_override(
                    &mut xml,
                    &format!("/{}", sources.props_path),
                    "application/vnd.openxmlformats-officedocument.customXmlProperties+xml",
                );
            }
            if out_state
                .theme_part
                .as_ref()
                .is_some_and(|(_, is_new)| *is_new)
            {
                add_override(&mut xml, &format!("/{THEME_PART_PATH}"), THEME_CONTENT_TYPE);
            }
            if self.custom_properties_is_new {
                add_override(
                    &mut xml,
                    &format!("/{CUSTOM_PROPERTIES_PATH}"),
                    CUSTOM_PROPERTIES_CONTENT_TYPE,
                );
            }
            content_types_xml = Some(xml);
        }

        let core_xml_out = match self.zip.text(CORE_PROPS_PATH).map_err(|e| e.to_string())? {
            Some(xml) => patch_core_props(xml, options.saved_at.as_deref(), self.now_ms)?,
            None => None,
        };

        let out_state = &self.out;
        let mut out = Package::default();
        // source folder entries are not copied over: Word does not write them
        for entry in self.zip.parts() {
            if entry.is_dir {
                continue;
            }
            let name = entry.name.as_str();
            let text = |xml: &str| xml.as_bytes().to_vec();
            let bytes: Vec<u8> = if name == self.doc_path {
                text(&new_document_xml)
            } else if let Some((_, xml)) = out_state.hf_parts.iter().find(|(path, _)| path == name)
            {
                text(xml)
            } else if let Some((_, xml)) =
                out_state.hf_rels_out.iter().find(|(path, _)| path == name)
            {
                text(xml)
            } else if name == self.rels_path && rels_changed && !self.rels_xml.is_empty() {
                text(&self.rels_xml)
            } else if name == CONTENT_TYPES_PATH && content_types_xml.is_some() {
                text(content_types_xml.as_deref().unwrap_or_default())
            } else if name == ROOT_RELS_PATH && self.root_rels_xml.is_some() {
                text(self.root_rels_xml.as_deref().unwrap_or_default())
            } else if name == SETTINGS_PATH && settings_xml.is_some() {
                text(settings_xml.as_deref().unwrap_or_default())
            } else if name == COMMENTS_PATH && out_state.comments_xml.is_some() {
                text(out_state.comments_xml.as_deref().unwrap_or_default())
            } else if name == COMMENTS_EXT_PATH && out_state.comments_ext_xml.is_some() {
                text(out_state.comments_ext_xml.as_deref().unwrap_or_default())
            } else if name == "word/_rels/comments.xml.rels"
                && out_state.comments_rels_xml.is_some()
            {
                text(out_state.comments_rels_xml.as_deref().unwrap_or_default())
            } else if name == NUMBERING_PATH && out_state.numbering_xml_out.is_some() {
                text(out_state.numbering_xml_out.as_deref().unwrap_or_default())
            } else if let Some(rels) = out_state
                .numbering_rels_out
                .as_ref()
                .filter(|r| r.path == name)
            {
                text(&rels.xml)
            } else if name == STYLES_PATH && out_state.styles_xml_out.is_some() {
                text(out_state.styles_xml_out.as_deref().unwrap_or_default())
            } else if let Some((part, _)) =
                out_state.notes_parts.iter().find(|(p, _)| p.path == name)
            {
                text(&part.xml)
            } else if let Some(sources) = out_state.sources_part.as_ref().filter(|p| p.path == name)
            {
                text(&sources.xml)
            } else if name == THEME_PART_PATH && out_state.theme_part.is_some() {
                text(
                    &out_state
                        .theme_part
                        .as_ref()
                        .map(|(xml, _)| xml.clone())
                        .unwrap_or_default(),
                )
            } else if name == CUSTOM_PROPERTIES_PATH && self.custom_properties_xml.is_some() {
                text(self.custom_properties_xml.as_deref().unwrap_or_default())
            } else if name == CORE_PROPS_PATH && core_xml_out.is_some() {
                text(core_xml_out.as_deref().unwrap_or_default())
            } else if let Some(xml) = options.part_xml.as_ref().and_then(|map| map.get(name)) {
                text(xml)
            } else if let Some(base64) = options.part_binary.as_ref().and_then(|map| map.get(name))
            {
                jszip_base64(base64)?
            } else {
                entry.bytes().map_err(|e| e.to_string())?.to_vec()
            };
            // `out.file(name, data, { date: entry.date })`: two saves of one
            // source write the same bytes
            out.set_file_dated(name.to_owned(), bytes, entry.date);
        }
        for (path, base64) in &self.new_media {
            out.set_file(path.clone(), jszip_base64(base64)?);
        }
        for (path, xml) in &out_state.hf_parts {
            if self.zip.file(path).is_none() {
                out.set_file(path.clone(), xml.as_bytes().to_vec());
            }
        }
        for (path, xml) in &out_state.hf_rels_out {
            if self.zip.file(path).is_none() {
                out.set_file(path.clone(), xml.as_bytes().to_vec());
            }
        }
        if rels_changed && !self.rels_xml.is_empty() && self.zip.file(&self.rels_path).is_none() {
            out.set_file(self.rels_path.clone(), self.rels_xml.as_bytes().to_vec());
        }
        if out_state.comments_is_new
            && let Some(xml) = &out_state.comments_xml
        {
            out.set_file(COMMENTS_PATH.to_owned(), xml.as_bytes().to_vec());
        }
        if out_state.comments_ext_is_new
            && let Some(xml) = &out_state.comments_ext_xml
        {
            out.set_file(COMMENTS_EXT_PATH.to_owned(), xml.as_bytes().to_vec());
        }
        if out_state.comments_rels_is_new
            && let Some(xml) = &out_state.comments_rels_xml
        {
            out.set_file(
                "word/_rels/comments.xml.rels".to_owned(),
                xml.as_bytes().to_vec(),
            );
        }
        if out_state.numbering_is_new
            && let Some(xml) = &out_state.numbering_xml_out
        {
            out.set_file(NUMBERING_PATH.to_owned(), xml.as_bytes().to_vec());
        }
        if let Some(rels) = out_state.numbering_rels_out.as_ref().filter(|r| r.is_new) {
            out.set_file(rels.path.clone(), rels.xml.as_bytes().to_vec());
        }
        if let Some(xml) = &out_state.styles_xml_out
            && self.zip.file(STYLES_PATH).is_none()
        {
            out.set_file(STYLES_PATH.to_owned(), xml.as_bytes().to_vec());
        }
        if settings_is_new && let Some(xml) = &settings_xml {
            out.set_file(SETTINGS_PATH.to_owned(), xml.as_bytes().to_vec());
        }
        for (path, xml) in &self.new_chart_parts {
            out.set_file(path.clone(), xml.as_bytes().to_vec());
        }
        for wb in &self.new_chart_workbooks {
            if self.zip.file(&wb.rels_path).is_none() {
                out.set_file(wb.rels_path.clone(), wb.rels_xml.as_bytes().to_vec());
            }
            out.set_file(wb.xlsx_path.clone(), jszip_base64(&wb.base64)?);
        }
        for (part, _) in &out_state.notes_parts {
            if part.is_new {
                out.set_file(part.path.clone(), part.xml.as_bytes().to_vec());
            }
        }
        if let Some(sources) = out_state.sources_part.as_ref().filter(|p| p.is_new) {
            out.set_file(sources.path.clone(), sources.xml.as_bytes().to_vec());
            out.set_file(
                sources.props_path.clone(),
                build_sources_item_props_xml().into_bytes(),
            );
            let rels_name = sources
                .path
                .strip_prefix("customXml/")
                .unwrap_or(&sources.path);
            let rels_name = rels_name.strip_suffix(".xml").unwrap_or(rels_name);
            let target = sources
                .props_path
                .strip_prefix("customXml/")
                .unwrap_or(&sources.props_path);
            out.set_file(
                format!("customXml/_rels/{rels_name}.xml.rels"),
                format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps\" Target=\"{target}\"/></Relationships>"
                )
                .into_bytes(),
            );
        }
        if let Some((xml, true)) = &out_state.theme_part {
            out.set_file(THEME_PART_PATH.to_owned(), xml.as_bytes().to_vec());
        }
        if self.custom_properties_is_new
            && let Some(xml) = &self.custom_properties_xml
        {
            out.set_file(CUSTOM_PROPERTIES_PATH.to_owned(), xml.as_bytes().to_vec());
        }

        // the resource sweep prunes only what this save broke: a relationship the source
        // document already did not reference is a pre-existing orphan
        let source_referenced = match self.zip.text(&self.doc_path).map_err(|e| e.to_string())? {
            Some(xml) => Some(referenced_relationship_ids(xml)?),
            None => None,
        };
        cleanup_docx_owned_resources(&mut out, &self.doc_path, source_referenced.as_ref())?;
        clean_story_move_ranges(&mut out, &self.doc_path)?;
        let scrub = options
            .remove_personal_info
            .unwrap_or(self.parsed.remove_personal_info);
        if scrub {
            scrub_personal_metadata(&mut out)?;
        }
        // metadata scrubs come after every generated/copied part is in place
        if let Some(remove) = &options.remove_parts {
            apply_remove_parts(&mut out, remove)?;
        }
        // the property write comes last: what the caller asked for wins over the scrub
        if let Some(properties) = &options.properties {
            apply_property_changes(&mut out, properties)?;
        }
        // Word does not write folder entries and they carry no content
        let mut flat = Package::default();
        for part in out.into_parts() {
            if !part.is_dir {
                flat.set(
                    Part::new(
                        part.name.clone(),
                        false,
                        part.bytes().map(<[u8]>::to_vec).map_err(|e| e.reason),
                    )
                    .with_date(part.date),
                );
            }
        }
        ooxml_pkg::write::generate(&flat, self.now_ms).map_err(|e| e.to_string())
    }
}
