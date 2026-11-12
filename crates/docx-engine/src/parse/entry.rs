//! `parseDocx` of parse.ts: a docx package as the document model.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

use jscompat::{JsMap, JsNum, JsObject, js_regex, number_to_string, to_number, trim};
use ooxml_pkg::Package;
use ooxml_xml::Utf16Map;
use serde_json::{Map, Value};

use super::drawings::host::{MediaEnv, MediaHost};
use super::drawings::media::{
    external_txbx_parts, media_data_url, resolve_pic_bullets, table_blip_media,
};
use super::drawings::settings::{
    parse_compatibility_mode, parse_layout_settings, parse_note_props, parse_settings_flag,
    parse_sources,
};
use super::tables::hf::hf_part_info;
use super::tables::hf_part::{HfPart, parse_all_hf_parts, read_header_footer_part};
use super::text::{
    BuildContext, SectionIndex, ZoteroFieldParagraph, apply_toc_entry_numbers, build_block,
    cross_paragraph_zotero_fields, fold_field_code_paragraphs, json, model_of, note_numbers_of,
    num, parse_notes_part,
};
use crate::block_passes::{
    apply_balanced_dbcs_spacing, apply_protected_leading_breaks, band_wrapped_boxes_before_tables,
    block_run_groups, float_table_column_span, normalize_image_z_orders,
};
use crate::doc_properties::read_document_properties;
use crate::doc_properties::zotero::read_zotero_document_data;
use crate::font_table::{FONT_TABLE_PART_PATH, parse_font_table, read_embedded_fonts};
use crate::ink::find_ink_runs;
use crate::inline_opaque::part_namespaces;
use crate::model::{Block, Bytes, ParsedDoc, ParsedDocFull};
use crate::notes::NoteKind;
use crate::numbering::{NumberingDef, parse_numbering};
use crate::package::{Thrown, parse_rels, rels_path_of, resolve_main_document_path};
use crate::props::part_xml_space_preserve;
use crate::resolve::{ResolveDoc, resolve_ctx_of};
use crate::scan::{BodyElement, scan_body};
use crate::sdt::{sdt_meta, split_sdt_parts};
use crate::section::HfKind;
use crate::section::xml_flag_on;
use crate::settings::{
    parse_comments, parse_protection, parse_remove_personal_info, parse_write_protection,
};
use crate::styles::{StyleInfo, parse_styles};
use crate::theme::parse_theme;
use crate::vml::shape::vml_shape_type_table;

/// `ParseOptions`
#[derive(Debug, Clone, Copy)]
pub struct ParseOptions {
    /// expand w:altChunk parts into display blocks (off inside the chunk's own parse)
    pub expand_alt_chunks: bool,
    /// run the property resolver beside the legacy path and collect disagreements in `extras.resolveDiff`
    pub shadow_resolve: bool,
}

impl Default for ParseOptions {
    fn default() -> Self {
        Self {
            expand_alt_chunks: true,
            shadow_resolve: false,
        }
    }
}

/// A parse with the engine-side maps the alt-chunk merge of a host document reads.
struct Parsed {
    doc: ParsedDocFull,
    styles: Vec<(String, StyleInfo)>,
    numbering: JsMap<NumberingDef>,
}

/// `parseDocx(bytes)` with its `extras`: `Err` is what the TypeScript throws.
pub fn parse_docx_full(bytes: &[u8], host: &dyn MediaHost) -> Result<ParsedDocFull, String> {
    parse_docx_with(bytes, host, ParseOptions::default()).map(|parsed| parsed.doc)
}

/// `parseDocx(bytes, options)` with its `extras`.
pub fn parse_docx_full_with(
    bytes: &[u8],
    host: &dyn MediaHost,
    options: ParseOptions,
) -> Result<ParsedDocFull, String> {
    parse_docx_with(bytes, host, options).map(|parsed| parsed.doc)
}

/// `parseDocx(bytes)` without its `extras`: the `ParsedDoc` of the model.
pub fn parse_docx(bytes: &[u8], host: &dyn MediaHost) -> Result<ParsedDoc, String> {
    let full = parse_docx_full(bytes, host)?;
    let mut value = json(&full);
    if let Some(object) = value.as_object_mut() {
        object.shift_remove("extras");
    }
    model_of(value)
}

fn entries<T: serde::Serialize>(items: impl Iterator<Item = (String, T)>) -> Value {
    Value::Array(
        items
            .map(|(key, value)| Value::Array(vec![Value::from(key), json(&value)]))
            .collect(),
    )
}

fn parse_docx_with(
    bytes: &[u8],
    host: &dyn MediaHost,
    options: ParseOptions,
) -> Result<Parsed, String> {
    let zip = ooxml_pkg::load_docx_package(bytes)?;
    let media = MediaEnv::new(host);
    let Some(doc_path) = resolve_main_document_path(&zip)? else {
        let mime = zip
            .text("mimetype")
            .map_err(|error| error.to_string())?
            .map(|text| trim(text).to_owned());
        if let Some(mime) = mime.filter(|m| m.starts_with("application/vnd.oasis.opendocument")) {
            return Err(format!(
                "OpenDocument file ({mime}), not OOXML \u{2014} save as .docx to open"
            ));
        }
        return Err("not a docx: missing word/document.xml".to_owned());
    };
    let document_xml = zip
        .text(&doc_path)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "TypeError: Cannot read properties of null (reading 'async')".to_owned())?
        .to_owned();

    let theme = parse_theme(&zip)?;
    let parsed_styles = parse_styles(&zip, theme.colors.as_ref(), theme.fonts.as_ref())?;
    let mut heading_style_ids: Vec<(f64, String)> = Vec::new();
    let mut list_paragraph_style_id: Option<String> = None;
    for (_, info) in &parsed_styles.styles {
        if let Some(level) = info.heading_level.filter(|l| l.0 != 0.0 && !l.0.is_nan())
            && !heading_style_ids.iter().any(|(l, _)| *l == level.0)
        {
            heading_style_ids.push((level.0, info.style_id.clone()));
        }
        if list_paragraph_style_id.is_none()
            && js_regex!(r"^listparagraph$", "i").test(&info.style_id)
        {
            list_paragraph_style_id = Some(info.style_id.clone());
        }
    }

    let rels = parse_rels(&zip, &rels_path_of(&doc_path))?;
    let numbering_read = parse_numbering(&zip)?;
    let num_formats = numbering_read.formats;
    let mut numbering = numbering_read.defs;
    resolve_pic_bullets(&zip, &mut numbering, &numbering_read.pic_bullets, &media)?;
    let comments = parse_comments(&zip)?;
    let protection = parse_protection(&zip)?;
    let write_protection = parse_write_protection(&zip)?;
    let remove_personal_info = parse_remove_personal_info(&zip)?;
    let sources = parse_sources(&zip)?;
    // a damaged docProps/custom.xml must not keep the document from opening
    let zotero_document_data = read_zotero_document_data(&zip).unwrap_or_default();
    // the same goes for the other docProps parts: a broken one is simply empty
    let properties: Value = match read_document_properties(&zip) {
        Ok(properties) => json(&properties),
        Err(_) => {
            let mut empty = Map::new();
            for key in ["core", "app", "custom", "customTypes"] {
                empty.insert(key.to_owned(), Value::Object(Map::new()));
            }
            Value::Object(empty)
        }
    };
    let font_table = match zip.text(FONT_TABLE_PART_PATH).map_err(|e| e.to_string())? {
        Some(text) => parse_font_table(text),
        None => Vec::new(),
    };
    let embedded_fonts = read_embedded_fonts(&zip, &font_table)?;

    let ranged_comment_ids: HashSet<String> = js_regex!(
        r#"<w:commentRangeStart\b[^>]*\bw:id\s*=\s*["']([^"']+)["']"#,
        "g"
    )
    .find_iter(&document_xml)
    .filter_map(|found| found.get(1).map(str::to_owned))
    .collect();
    let reference_only_comments: HashSet<String> = comments
        .iter()
        .map(|c| c.id.clone())
        .filter(|id| !ranged_comment_ids.contains(id))
        .collect();

    let scan = scan_body(&document_xml).map_err(|error| format!("{error:?}"))?;
    let media_by_rid = table_blip_media(
        &scan.elements,
        &document_xml,
        &zip,
        &rels,
        &doc_path,
        &media,
    )?;
    let external_txbx_by_rid = external_txbx_parts(&document_xml, &zip, &rels, Some(&doc_path))?;
    // sections end at their w:sectPr: the one governing an offset is the first sectPr at or after it
    let gutter_at_top = parse_settings_flag(&zip, "w:gutterAtTop")?;
    let section_at = SectionIndex::new(&document_xml, Some(gutter_at_top));
    let zotero_field_paragraphs = cross_paragraph_zotero_fields(&scan.elements, &document_xml);
    let compatibility_mode = parse_compatibility_mode(&zip)?;
    let layout_settings = parse_layout_settings(&zip)?;
    let resolver = Rc::new(resolve_ctx_of(ResolveDoc {
        styles: parsed_styles.styles.iter().cloned().collect(),
        doc_defaults: parsed_styles.doc_defaults.clone(),
        numbering: numbering.clone(),
        theme_fonts: theme.fonts.clone(),
        theme_colors: theme.colors.clone(),
        compatibility_mode: Some(JsNum(compatibility_mode)),
        do_not_use_html_paragraph_auto_spacing: layout_settings
            .do_not_use_html_paragraph_auto_spacing,
        indent_not_numbering_tab_stop: layout_settings.indent_not_numbering_tab_stop,
    }));
    // note paragraphs read through the same run extraction and resolver as the body
    let note_ctx = BuildContext::bare(&zip, Rc::clone(&resolver), &media);
    let footnotes = parse_notes_part(&zip, NoteKind::Footnote, &note_ctx)?;
    let endnotes = parse_notes_part(&zip, NoteKind::Endnote, &note_ctx)?;
    let note_props = parse_note_props(&zip, &document_xml)?;
    let (footnote_props, endnote_props) = (note_props.footnote_props, note_props.endnote_props);
    let note_numbers = note_numbers_of(
        &document_xml,
        &footnotes,
        &endnotes,
        footnote_props.as_ref(),
        endnote_props.as_ref(),
    );
    let first_page_break_at = {
        let br = js_regex!(
            r#"<w:br [^>]*w:type="page"|<w:pageBreakBefore[^>]*\/>|<w:lastRenderedPageBreak[^>]*\/>"#
        )
        .exec(&document_xml)
        .map(|found| found.start());
        let sect = document_xml.find("</w:sectPr>");
        [br, sect].into_iter().flatten().min()
    };
    let mut ctx = BuildContext {
        zip: &zip,
        source_path: Some(doc_path.clone()),
        resolver: Rc::clone(&resolver),
        has_numbering: true,
        rels: rels.clone(),
        num_formats: Some(num_formats),
        open_moves: RefCell::new(Vec::new()),
        chart_parts: RefCell::new(JsObject::new()),
        note_numbers: note_numbers.clone(),
        media_by_rid: Some(RefCell::new(media_by_rid)),
        external_txbx_by_rid: Some(external_txbx_by_rid),
        reference_only_comments: Some(reference_only_comments),
        section_at: Some(section_at),
        first_page_break_at,
        float_table_ahead: RefCell::new(None),
        sdt_group_seq: Cell::new(0.0),
        table_raw: RefCell::new(None),
        compatibility_mode: Some(JsNum(compatibility_mode)),
        resolve_diff: options
            .shadow_resolve
            .then(|| Rc::new(RefCell::new(Vec::new()))),
        xml_space_preserve: part_xml_space_preserve(&document_xml, "w:document")
            .map_err(|error| error.to_string())?,
        part_namespaces: Some(part_namespaces(&document_xml).map_err(|l| l.to_string())?),
        vml_shape_types: document_xml
            .contains("<v:shapetype")
            .then(|| vml_shape_type_table(&document_xml)),
        next_zotero_field_id: Cell::new(
            zotero_field_paragraphs
                .iter()
                .map(|(_, field)| f64::from(field.id))
                .fold(0.0, f64::max)
                + 1.0,
        ),
        media: &media,
    };

    let unconverted = Cell::new(0.0_f64);
    let mut elements: Vec<(String, usize, usize)> = Vec::new();
    let mut blocks: Vec<Block> = Vec::new();
    for el in &scan.elements {
        let xml = &document_xml[el.start..el.end];
        let sdt_parts = if el.name == "w:sdt" {
            split_sdt_parts(xml).map_err(|limit| limit.to_string())?
        } else {
            None
        };
        if let Some(sdt_parts) = sdt_parts {
            let meta = sdt_meta(xml);
            let group = ctx.sdt_group_seq.get();
            ctx.sdt_group_seq.set(group + 1.0);
            let first_part_index = elements.len();
            for part in &sdt_parts {
                let i = elements.len();
                elements.push((
                    part.name.clone(),
                    el.start + part.start,
                    el.start + part.end,
                ));
                let child_xml = &xml[part.child_start..part.child_end];
                // real document offsets (not 0): sectionAt resolves page geometry by them
                let child_el = BodyElement {
                    name: &part.name,
                    start: el.start + part.child_start,
                    end: el.start + part.child_end,
                };
                let mut block = build_block(&child_el, i, child_xml, &ctx, None)?;
                block
                    .original_xml
                    .set(Some(xml[part.start..part.end].to_owned()));
                // The control chain may be nested and a split control's bytes live on several parts:
                // record the owning block and offset per level
                let owner_index = |offset: usize| -> usize {
                    for (k, candidate) in sdt_parts.iter().enumerate() {
                        if offset >= candidate.start && offset < candidate.end {
                            return first_part_index + k;
                        }
                    }
                    i
                };
                let chain: Vec<Value> = part
                    .chain
                    .iter()
                    .enumerate()
                    .map(|(depth, level)| {
                        let open_block = owner_index(level.range.open_start);
                        let close_block = owner_index(level.range.close_start);
                        let mut map = super::text::into_map(json(&level.shell));
                        map.insert("level".to_owned(), num(depth as f64));
                        map.insert("group".to_owned(), num(group));
                        map.insert("openBlock".to_owned(), num(open_block as f64));
                        map.insert(
                            "openOffset".to_owned(),
                            num((level.range.open_start
                                - sdt_parts[open_block - first_part_index].start)
                                as f64),
                        );
                        map.insert("closeBlock".to_owned(), num(close_block as f64));
                        map.insert(
                            "closeOffset".to_owned(),
                            num((level.range.close_start
                                - sdt_parts[close_block - first_part_index].start)
                                as f64),
                        );
                        Value::Object(map)
                    })
                    .collect();
                let mut shell = super::text::into_map(json(&meta));
                shell.insert(
                    "openXml".to_owned(),
                    Value::from(&xml[part.start..part.child_start]),
                );
                shell.insert(
                    "closeXml".to_owned(),
                    Value::from(&xml[part.child_end..part.end]),
                );
                shell.insert("group".to_owned(), num(group));
                block.sdt_shell.set(model_of(Value::Object(shell))?);
                block.sdt_shells.set(model_of(Value::Array(chain))?);
                if part.name == "w:p" {
                    super::text::attach_inline_content_controls(&mut block, child_xml)
                        .map_err(|limit| limit.to_string())?;
                }
                if !block.label.as_deref().is_some_and(|l| !l.is_empty()) {
                    let label = if !meta.alias.is_empty() {
                        meta.alias.as_str()
                    } else if !meta.tag.is_empty() {
                        meta.tag.as_str()
                    } else {
                        "Content control"
                    };
                    block.label.set(label.to_owned());
                }
                let span = ctx
                    .section_at
                    .as_ref()
                    .map(|section| section.at(el.start))
                    .and_then(|sect| float_table_column_span(&block, &sect));
                blocks.push(block);
                *ctx.float_table_ahead.borrow_mut() =
                    span.map(|span| super::text::FloatTableAhead {
                        left_twips: span.left_twips,
                        right_twips: span.right_twips,
                    });
            }
            continue;
        }
        if el.name == "w:altChunk" && options.expand_alt_chunks {
            let expanded =
                expand_alt_chunk(xml, &zip, &rels, &mut ctx, &doc_path, host, &unconverted);
            if !expanded.is_empty() {
                // the chunk element keeps its bytes under the first block; the rest
                // anchor to empty ranges so an untouched save re-emits nothing for them
                for (k, mut block) in expanded.into_iter().enumerate() {
                    let i = elements.len();
                    elements.push(if k == 0 {
                        (el.name.to_owned(), el.start, el.end)
                    } else {
                        (el.name.to_owned(), el.end, el.end)
                    });
                    block.id.set(format!("b{i}"));
                    block.docx_index.set(Some(JsNum(i as f64)));
                    blocks.push(block);
                }
                continue;
            }
        }
        let i = elements.len();
        elements.push((el.name.to_owned(), el.start, el.end));
        let zotero: Option<&ZoteroFieldParagraph> = zotero_field_paragraphs
            .iter()
            .find(|(start, _)| *start == el.start)
            .map(|(_, field)| field);
        let mut block = build_block(el, i, xml, &ctx, zotero)?;
        if el.name == "w:p" {
            super::text::attach_inline_content_controls(&mut block, xml)
                .map_err(|limit| limit.to_string())?;
        }
        let span = ctx
            .section_at
            .as_ref()
            .map(|section| section.at(el.start))
            .and_then(|sect| float_table_column_span(&block, &sect));
        blocks.push(block);
        *ctx.float_table_ahead.borrow_mut() = span.map(|span| super::text::FloatTableAhead {
            left_twips: span.left_twips,
            right_twips: span.right_twips,
        });
    }
    fold_field_code_paragraphs(&mut blocks, &ctx)?;
    apply_toc_entry_numbers(&mut blocks, &ctx.resolver.numbering);
    band_wrapped_boxes_before_tables(&mut blocks);
    normalize_image_z_orders(&mut blocks);
    apply_protected_leading_breaks(&mut blocks).map_err(|limit| limit.to_string())?;

    // from here on the resolver is the final one (alt chunks may have extended it)
    let resolver = Rc::clone(&ctx.resolver);
    let read_hf = |kind: HfKind, hf_type: &str| -> Result<Option<HfPart>, Thrown> {
        read_header_footer_part(
            &zip,
            &document_xml,
            &rels,
            kind,
            hf_type,
            &resolver,
            compatibility_mode,
            &doc_path,
            &media,
        )
    };
    let mut header = read_hf(HfKind::Header, "default")?;
    let mut footer = read_hf(HfKind::Footer, "default")?;
    let mut header_first = read_hf(HfKind::Header, "first")?;
    let mut footer_first = read_hf(HfKind::Footer, "first")?;
    let mut header_even = read_hf(HfKind::Header, "even")?;
    let mut footer_even = read_hf(HfKind::Footer, "even")?;
    let title_pg = xml_flag_on(&document_xml, "w:titlePg").map_err(|e| e.to_string())?;
    let even_and_odd_headers = parse_settings_flag(&zip, "w:evenAndOddHeaders")?;
    let mirror_margins = parse_settings_flag(&zip, "w:mirrorMargins")?;
    let track_revisions = parse_settings_flag(&zip, "w:trackRevisions")?;
    let mut hf_parts = parse_all_hf_parts(
        &zip,
        &rels,
        &resolver,
        compatibility_mode,
        &doc_path,
        &media,
    )?;
    if layout_settings.balance_dbcs_spacing == Some(true) {
        let mut groups: Vec<Option<&mut Vec<crate::model::Run>>> = block_run_groups(&mut blocks);
        for part in [
            &mut header,
            &mut footer,
            &mut header_first,
            &mut footer_first,
            &mut header_even,
            &mut footer_even,
        ] {
            if let Some(part) = part.as_mut() {
                for para in &mut part.paras {
                    groups.push(para.runs.as_mut());
                    for cell in para.cells.as_mut().into_iter().flatten() {
                        for paras in cell.paras.iter_mut() {
                            groups.push(Some(paras));
                        }
                    }
                }
            }
        }
        for part in hf_parts.values_mut() {
            for para in &mut part.paras {
                groups.push(para.runs.as_mut());
                for cell in para.cells.as_mut().into_iter().flatten() {
                    for paras in cell.paras.iter_mut() {
                        groups.push(Some(paras));
                    }
                }
            }
        }
        let east_asia = resolver
            .doc_defaults
            .as_ref()
            .and_then(|d| (*d.east_asia_font).clone());
        apply_balanced_dbcs_spacing(groups, east_asia.as_deref());
    }

    // ink annotations (freehand strokes): our own anchored floating pictures
    let mut inks: Vec<Value> = Vec::new();
    for block in &blocks {
        let docx_index = *block.docx_index;
        let original = (*block.original_xml).clone().flatten();
        let (Some(Some(docx_index)), Some(original)) = (docx_index, original) else {
            continue;
        };
        if original.is_empty() {
            continue;
        }
        for run in find_ink_runs(&original) {
            let mut ink = Map::new();
            ink.insert("anchorIndex".to_owned(), json(&docx_index));
            ink.insert("offsetXPx".to_owned(), json(&run.offset_x_px));
            ink.insert("offsetYPx".to_owned(), json(&run.offset_y_px));
            ink.insert("widthPx".to_owned(), json(&run.width_px));
            ink.insert("heightPx".to_owned(), json(&run.height_px));
            let data_url = match run.embed_r_id.as_deref().filter(|r| !r.is_empty()) {
                Some(r_id) => media_data_url(&zip, &rels, r_id, &doc_path, &media)?,
                None => None,
            };
            ink.insert(
                "dataUrl".to_owned(),
                data_url.map_or(Value::Null, Value::from),
            );
            if let Some(payload) = &run.payload {
                ink.insert("payload".to_owned(), Value::from(payload.as_str()));
            }
            inks.push(Value::Object(ink));
        }
    }

    let units = Utf16Map::new(&document_xml);
    let hf_info = |part: Option<HfPart>| -> Value {
        let info = part.and_then(|part| {
            hf_part_info(Some(crate::model::HfPartInfo {
                text: part.text,
                has_page_number: part.has_page_number,
                paras: part.paras,
                images: part.images,
            }))
        });
        info.map_or(Value::Null, |info| json(&info))
    };

    let mut doc = Map::new();
    doc.insert("blocks".to_owned(), json(&blocks));
    doc.insert(
        "zoteroDocumentData".to_owned(),
        Value::from(zotero_document_data),
    );
    doc.insert("properties".to_owned(), properties);
    doc.insert("comments".to_owned(), json(&comments));
    // `protection: DocProtection | null`: the key is always there, null when none
    doc.insert("protection".to_owned(), protection.as_ref().map_or(Value::Null, json));
    doc.insert(
        "writeProtection".to_owned(),
        write_protection.as_ref().map_or(Value::Null, json),
    );
    doc.insert(
        "removePersonalInfo".to_owned(),
        Value::Bool(remove_personal_info),
    );
    doc.insert("footnotes".to_owned(), json(&footnotes));
    doc.insert("endnotes".to_owned(), json(&endnotes));
    if let Some(props) = &footnote_props {
        doc.insert("footnoteProps".to_owned(), json(props));
    }
    if let Some(props) = &endnote_props {
        doc.insert("endnoteProps".to_owned(), json(props));
    }
    let mut numbers = Map::new();
    for (key, value) in note_numbers.iter() {
        numbers.insert(key.to_owned(), json(value));
    }
    doc.insert("noteNumbers".to_owned(), Value::Object(numbers));
    doc.insert("sources".to_owned(), json(&sources));
    doc.insert("inks".to_owned(), Value::Array(inks));
    doc.insert(
        "themeFonts".to_owned(),
        theme.fonts.as_ref().map_or(Value::Null, json),
    );
    doc.insert(
        "themeColors".to_owned(),
        theme.colors.as_ref().map_or(Value::Null, json),
    );
    if !font_table.is_empty() {
        doc.insert("fontTable".to_owned(), json(&font_table));
    }
    if !embedded_fonts.is_empty() {
        let fonts: Vec<Value> = embedded_fonts
            .iter()
            .map(|font| {
                let mut map = Map::new();
                map.insert("family".to_owned(), Value::from(font.family.as_str()));
                map.insert("bold".to_owned(), Value::Bool(font.bold));
                map.insert("italic".to_owned(), Value::Bool(font.italic));
                map.insert("data".to_owned(), json(&Bytes(font.data.clone())));
                if let Some(metrics) = &font.line_metrics {
                    map.insert("lineMetrics".to_owned(), json(metrics));
                }
                Value::Object(map)
            })
            .collect();
        doc.insert("embeddedFonts".to_owned(), Value::Array(fonts));
    }
    let header_ref = header.as_ref();
    let footer_ref = footer.as_ref();
    doc.insert(
        "watermarkText".to_owned(),
        header_ref
            .and_then(|h| h.watermark.as_deref())
            .map_or(Value::Null, Value::from),
    );
    doc.insert(
        "watermarkPicture".to_owned(),
        header_ref
            .and_then(|h| h.watermark_picture.as_ref())
            .map_or(Value::Null, json),
    );
    doc.insert(
        "headerText".to_owned(),
        header_ref.map_or(Value::Null, |h| Value::from(h.text.as_str())),
    );
    doc.insert(
        "headerParas".to_owned(),
        header_ref.map_or(Value::Null, |h| json(&h.paras)),
    );
    doc.insert(
        "footerParas".to_owned(),
        footer_ref.map_or(Value::Null, |f| json(&f.paras)),
    );
    doc.insert(
        "headerImages".to_owned(),
        header_ref
            .and_then(|h| h.images.as_ref())
            .map_or(Value::Null, json),
    );
    doc.insert(
        "footerImages".to_owned(),
        footer_ref
            .and_then(|f| f.images.as_ref())
            .map_or(Value::Null, json),
    );
    doc.insert(
        "footerText".to_owned(),
        footer_ref.map_or(Value::Null, |f| Value::from(f.text.as_str())),
    );
    doc.insert(
        "footerHasPageNumber".to_owned(),
        Value::Bool(footer_ref.is_some_and(|f| f.has_page_number)),
    );
    doc.insert(
        "headerHasPageNumber".to_owned(),
        Value::Bool(header_ref.is_some_and(|h| h.has_page_number)),
    );
    doc.insert("titlePg".to_owned(), Value::Bool(title_pg));
    doc.insert(
        "evenAndOddHeaders".to_owned(),
        Value::Bool(even_and_odd_headers),
    );
    if mirror_margins {
        doc.insert("mirrorMargins".to_owned(), Value::Bool(true));
    }
    if track_revisions {
        doc.insert("trackRevisions".to_owned(), Value::Bool(true));
    }
    if gutter_at_top {
        doc.insert("gutterAtTop".to_owned(), Value::Bool(true));
    }
    doc.insert("compatibilityMode".to_owned(), num(compatibility_mode));
    for (key, value) in super::text::into_map(json(&layout_settings)) {
        doc.insert(key, value);
    }
    doc.insert("headerFirst".to_owned(), hf_info(header_first));
    doc.insert("footerFirst".to_owned(), hf_info(footer_first));
    doc.insert("headerEven".to_owned(), hf_info(header_even));
    doc.insert("footerEven".to_owned(), hf_info(footer_even));
    doc.insert("hfParts".to_owned(), json(&hf_parts));
    doc.insert(
        "styles".to_owned(),
        entries(
            ctx.resolver
                .styles
                .iter()
                .map(|(k, v)| (k.to_owned(), v.clone())),
        ),
    );
    if let Some(defaults) = &ctx.resolver.doc_defaults {
        doc.insert("docDefaults".to_owned(), json(defaults));
    }
    doc.insert(
        "headingStyleIds".to_owned(),
        Value::Array(
            heading_style_ids
                .iter()
                .map(|(level, id)| Value::Array(vec![num(*level), Value::from(id.as_str())]))
                .collect(),
        ),
    );
    if let Some(id) = &list_paragraph_style_id {
        doc.insert("listParagraphStyleId".to_owned(), Value::from(id.as_str()));
    }
    doc.insert(
        "numbering".to_owned(),
        entries(
            ctx.resolver
                .numbering
                .iter()
                .map(|(k, v)| (k.to_owned(), v.clone())),
        ),
    );
    let mut internal = Map::new();
    internal.insert("originalBytes".to_owned(), json(&Bytes(bytes.to_vec())));
    internal.insert("documentXml".to_owned(), Value::from(document_xml.as_str()));
    let at = |byte: usize| num(f64::from(units.to_utf16(byte)));
    internal.insert("bodyInnerStart".to_owned(), at(scan.inner_start));
    internal.insert("bodyInnerEnd".to_owned(), at(scan.inner_end));
    internal.insert("bodyContentStart".to_owned(), at(scan.body_content_start));
    internal.insert("bodyContentEnd".to_owned(), at(scan.body_content_end));
    doc.insert("internal".to_owned(), Value::Object(internal));

    let mut extras = Map::new();
    extras.insert(
        "elements".to_owned(),
        Value::Array(
            elements
                .iter()
                .map(|(name, start, end)| {
                    let mut el = Map::new();
                    el.insert("name".to_owned(), Value::from(name.as_str()));
                    el.insert("start".to_owned(), at(*start));
                    el.insert("end".to_owned(), at(*end));
                    Value::Object(el)
                })
                .collect(),
        ),
    );
    extras.insert(
        "opaqueRegions".to_owned(),
        Value::Array(
            scan.opaque_regions
                .iter()
                .map(|region| {
                    let mut r = Map::new();
                    r.insert("start".to_owned(), at(region.start));
                    r.insert("end".to_owned(), at(region.end));
                    Value::Object(r)
                })
                .collect(),
        ),
    );
    extras.insert("chartParts".to_owned(), json(&*ctx.chart_parts.borrow()));
    extras.insert("lazyMediaHashes".to_owned(), json(&media.lazy_hashes()));
    if unconverted.get() > 0.0 {
        extras.insert("altChunksNeedConverter".to_owned(), num(unconverted.get()));
    }
    if let Some(collector) = &ctx.resolve_diff {
        extras.insert(
            "resolveDiff".to_owned(),
            Value::Array(
                collector
                    .borrow()
                    .iter()
                    .map(|diff| {
                        let mut d = Map::new();
                        d.insert("key".to_owned(), Value::from(diff.key.as_str()));
                        if let Some(old) = &diff.old {
                            d.insert("old".to_owned(), old.clone());
                        }
                        if let Some(eff) = &diff.eff {
                            d.insert("eff".to_owned(), eff.clone());
                        }
                        d.insert("surface".to_owned(), Value::from(diff.surface));
                        d.insert("text".to_owned(), Value::from(diff.text.as_str()));
                        Value::Object(d)
                    })
                    .collect(),
            ),
        );
    }
    doc.insert("extras".to_owned(), Value::Object(extras));

    let styles_out: Vec<(String, StyleInfo)> = ctx
        .resolver
        .styles
        .iter()
        .map(|(k, v)| (k.to_owned(), v.clone()))
        .collect();
    let numbering_out = ctx.resolver.numbering.clone();
    Ok(Parsed {
        doc: model_of(Value::Object(doc))?,
        styles: styles_out,
        numbering: numbering_out,
    })
}

/// `expandAltChunk`: display blocks for a w:altChunk: the chunk becomes a docx
/// (directly, or via the host's HTML converter) and is parsed like a document
/// of its own. Styles and numbering it defines are adopted under ids the host
/// does not use. Any failure is no blocks.
fn expand_alt_chunk(
    xml: &str,
    zip: &Package,
    rels: &JsMap<crate::package::RelInfo>,
    ctx: &mut BuildContext<'_>,
    source_path: &str,
    host: &dyn MediaHost,
    unconverted: &Cell<f64>,
) -> Vec<Block> {
    expand_alt_chunk_inner(xml, zip, rels, ctx, source_path, host, unconverted).unwrap_or_default()
}

/// `MAX_CHUNK_BYTES`
const MAX_CHUNK_BYTES: usize = 64 * 1024 * 1024;

/// `altChunkToDocx`: the chunk as docx bytes, or none where the part is
/// missing, of an unsupported type, or no HTML converter is installed.
pub fn alt_chunk_to_docx(
    zip: &Package,
    rels: &JsMap<crate::package::RelInfo>,
    r_id: &str,
    source_path: &str,
    host: &dyn MediaHost,
) -> Result<Option<Vec<u8>>, Thrown> {
    use crate::alt_chunk::{
        AltChunkKind, alt_chunk_kind, alt_chunk_part_path, decode_html_bytes, decode_mht_to_html,
    };
    let Some(path) = alt_chunk_part_path(rels, r_id, Some(source_path)) else {
        return Ok(None);
    };
    let Some(bytes) = zip.bytes(&path).map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
        return Ok(None);
    }
    let types = crate::package::content_types_of(zip)?;
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    let content_type = types
        .overrides
        .get(&format!("/{path}"))
        .or_else(|| types.defaults.get(&ext))
        .map(String::as_str);
    let kind = alt_chunk_kind(&path, content_type, &bytes[..bytes.len().min(4096)]);
    match kind {
        Some(AltChunkKind::Docx) => return Ok(Some(bytes.to_vec())),
        None => return Ok(None),
        _ => {}
    }
    if !host.has_alt_chunk_html_converter() {
        return Ok(None);
    }
    let html = if kind == Some(AltChunkKind::Mht) {
        decode_mht_to_html(bytes)?
    } else {
        Some(decode_html_bytes(bytes))
    };
    let Some(html) = html.filter(|html| !trim(html).is_empty()) else {
        return Ok(None);
    };
    Ok(host.alt_chunk_html_to_docx(&html))
}

fn remap_table(value: &mut Value, remap: &mut dyn FnMut(&mut Value)) {
    let Some(rows) = value.get_mut("rows").and_then(Value::as_array_mut) else {
        return;
    };
    for row in rows {
        let Some(cells) = row.as_array_mut() else {
            continue;
        };
        for cell in cells {
            if let Some(paras) = cell.get_mut("richParas").and_then(Value::as_array_mut) {
                for para in paras {
                    if let Some(list) = para.get_mut("list")
                        && !list.is_null()
                    {
                        remap(list);
                    }
                }
            }
            if let Some(nested) = cell.get_mut("nestedTables").and_then(Value::as_array_mut) {
                for table in nested {
                    remap_table(table, remap);
                }
            }
        }
    }
}

fn expand_alt_chunk_inner(
    xml: &str,
    zip: &Package,
    rels: &JsMap<crate::package::RelInfo>,
    ctx: &mut BuildContext<'_>,
    source_path: &str,
    host: &dyn MediaHost,
    unconverted: &Cell<f64>,
) -> Result<Vec<Block>, Thrown> {
    let Some(r_id) = js_regex!(r#"\br:id\s*=\s*["']([^"']+)["']"#)
        .exec(xml)
        .and_then(|found| found.get(1))
    else {
        return Ok(Vec::new());
    };
    let Some(bytes) = alt_chunk_to_docx(zip, rels, r_id, source_path, host)? else {
        // no converter here (a Worker parse): the host parses again where one is installed
        if !host.has_alt_chunk_html_converter() {
            unconverted.set(unconverted.get() + 1.0);
        }
        return Ok(Vec::new());
    };
    let sub = parse_docx_with(
        &bytes,
        host,
        ParseOptions {
            expand_alt_chunks: false,
            shadow_resolve: false,
        },
    )?;
    let resolver = Rc::make_mut(&mut ctx.resolver);
    for (id, info) in &sub.styles {
        if !resolver.styles.has(id) {
            resolver.styles.set(id.clone(), info.clone());
        }
    }
    let mut next_num_id = 1.0_f64;
    for id in resolver.numbering.keys() {
        let n = to_number(id);
        next_num_id = next_num_id.max(if n == 0.0 || n.is_nan() { 0.0 } else { n } + 1.0);
    }
    // abstractNum ids are counter-sharing keys: keep chunk lists apart from host lists
    let abstract_prefix = format!("altChunk{}:", number_to_string(next_num_id));
    let mut num_id_map: Vec<(String, String)> = Vec::new();
    let sub_numbering = &sub.numbering;
    let mut remap = |list: &mut Value| {
        let Some(old) = list.get("numId").and_then(Value::as_str).map(str::to_owned) else {
            return;
        };
        let mapped = match num_id_map.iter().find(|(from, _)| *from == old) {
            Some((_, mapped)) if !mapped.is_empty() => mapped.clone(),
            _ => {
                let mapped = number_to_string(next_num_id);
                next_num_id += 1.0;
                if let Some(def) = sub_numbering.get(&old) {
                    let mut def = def.clone();
                    def.num_id = mapped.clone();
                    def.abstract_num_id = format!("{abstract_prefix}{}", def.abstract_num_id);
                    resolver.numbering.set(mapped.clone(), def);
                }
                num_id_map.push((old.clone(), mapped.clone()));
                mapped
            }
        };
        if let Some(object) = list.as_object_mut() {
            object.insert("numId".to_owned(), Value::from(mapped));
        }
    };
    let mut out = Vec::new();
    for block in sub
        .doc
        .blocks
        .into_iter()
        .filter(|b| !b.hidden.unwrap_or(false))
    {
        let mut value = json(&block);
        if let Some(object) = value.as_object_mut() {
            object.insert("altChunk".to_owned(), Value::Bool(true));
            if let Some(list) = object.get_mut("list") {
                remap(list);
            }
            if let Some(table) = object.get_mut("table") {
                remap_table(table, &mut remap);
            }
        }
        out.push(model_of(value)?);
    }
    Ok(out)
}
