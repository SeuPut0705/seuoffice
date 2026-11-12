//! `assemble/export/index.ts`: docx to a new ODT (no original ODT): "save as"
//! as ODT, new documents, markdown/HTML export through docx, CLI convert.
//!
//! It shares the writers of the narrow-patch save. A minimal ODT skeleton is
//! built from the docx's styles and page setup (document defaults, paragraph
//! styles, page layouts and master pages), opened like a received ODT with an
//! empty bridge, and every body element is written as new content by the
//! layers' free writers (paragraphs, lists, tables, pictures, notes). Headers
//! and footers fill the master pages through the page layer's region writer.
//! Each page section's first element points at its master page.
//!
//! What an ODT cannot hold (charts, equations, shapes, text boxes, tracked
//! changes, comments ...) is converted or dropped and listed in the report.

pub mod blocks;
pub mod headings;
pub mod objects;
pub mod rows;
pub mod styles;
pub mod theme;

use std::cell::RefCell;
use std::rc::Rc;

use docx_engine::model::{Block, HfParagraph, ParsedDoc};
use docx_engine::parse::drawings::host::NoHost;
use docx_engine::parse::parse_docx;
use docx_engine::section::{
    SectionBlock, SectionInfo, SectionSettings, read_page_color, read_sections,
};
use jscompat::{
    JsMap, JsNum, JsObject, js_regex, number_to_string, replace_first_string, replace_first_with,
    trim,
};
use ooxml_pkg::{DEFAULT_ZIP_LIMITS, Package};

pub use objects::RenderedObject;

use self::blocks::{BlockNormaliser, NormaliseEnv};
use self::headings::headings_as_paragraphs;
use self::objects::LabelRunWriter;
use self::styles::{
    FontSet, MasterSpec, PageColumns, columns_xml, default_style_xml, master_page_xml,
    outline_style_xml, page_layout_xml, paragraph_styles_xml,
};
use self::theme::{ThemeSources, unresolved_theme_references};
use super::registry::odt_registry;
use super::report::{ConversionReport, ReportBuilder, ReportFeature, ReportKind};
use super::zip::{ZipEntryInput, write_zip};
use crate::core::convert::{
    AlignedItem, BridgeStyleEntry, BridgeStyles, FlowEnv, ItemRef, OoxmlToOdfContext,
    OoxmlToOdfOptions, apply_text_patches, create_bridge_map,
};
use crate::core::styles::{OdtMasterPageRegionName, OdtStylePart};
use crate::core::xml::{PrefixMap, decode_xml_entities, escape_xml_attr, escape_xml_text};
use crate::core::{HostNow, OdtError, OpenOdtOptions, open_odt, rebuild_flow};
use crate::objects::package::{FinalParts, object_package_changes};
use crate::page::hf::region_inner_xml;
use crate::page::register::{StartChange, start_style};
use crate::text::style_xml::{StyleXmlEdit, edit_style_xml};

/// `DocxToOdtResult`
#[derive(Debug)]
pub struct DocxToOdtResult {
    pub odt_bytes: Vec<u8>,
    /// what the ODT does not keep as it was
    pub report: ConversionReport,
}

/// `ODT_MEDIA_TYPE`
const ODT_MEDIA_TYPE: &str = "application/vnd.oasis.opendocument.text";
/// `ODF_VERSION`
const ODF_VERSION: &str = "1.3";

/// `NAMESPACES`
const NAMESPACES: &str = "xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" \
xmlns:style=\"urn:oasis:names:tc:opendocument:xmlns:style:1.0\" \
xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\" \
xmlns:table=\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\" \
xmlns:draw=\"urn:oasis:names:tc:opendocument:xmlns:drawing:1.0\" \
xmlns:fo=\"urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0\" \
xmlns:xlink=\"http://www.w3.org/1999/xlink\" \
xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
xmlns:meta=\"urn:oasis:names:tc:opendocument:xmlns:meta:1.0\" \
xmlns:number=\"urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0\" \
xmlns:svg=\"urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0\"";

/// `XML_DECL`
const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>";

/// `SEQUENCE_DECLS`
fn sequence_decls() -> String {
    let mut out = String::from("<text:sequence-decls>");
    for n in ["Illustration", "Table", "Text", "Drawing", "Figure"] {
        out.push_str(&format!(
            "<text:sequence-decl text:display-outline-level=\"0\" text:name=\"{n}\"/>"
        ));
    }
    out.push_str("</text:sequence-decls>");
    out
}

/// `Number.MAX_SAFE_INTEGER`
const MAX_SAFE_INTEGER: f64 = 9007199254740991.0;

type Region = OdtMasterPageRegionName;

/// One sub-run of a page group: a docx section with its own columns.
struct Subsection {
    first: f64,
    last: f64,
    columns: PageColumns,
}

/// `PageGroup`: a run of pages under one master page: docx sections joined by
/// continuous breaks.
struct PageGroup {
    last: f64,
    section: SectionInfo,
    master: MasterSpec,
    /// region to the header/footer part shown there (`None`: an empty region)
    parts: Vec<(Region, Option<String>)>,
    /// the docx sections of the run (continuous breaks), with their text columns
    subsections: Vec<Subsection>,
}

impl PageGroup {
    /// `group.parts[region]`: `None` when the key is not there.
    fn part_of(&self, region: Region) -> Option<&Option<String>> {
        self.parts
            .iter()
            .find(|(r, _)| *r == region)
            .map(|(_, part)| part)
    }
}

/// `docxToOdt`: converts a whole docx into a new ODT. Fails when the bytes are
/// not a readable docx. `rendered` is `options.renderedObjects`: pictures the
/// editor rendered for objects an ODT cannot hold (charts, equations, shapes,
/// text boxes), keyed by body position: `"<docxIndex>:<n>"` is the n-th such
/// object (0-based, document order, table cells included) inside the body
/// element with that `Block.docxIndex`; `"<docxIndex>"` alone stands for its
/// first object.
pub fn docx_to_odt(
    docx_bytes: &[u8],
    rendered: &JsMap<RenderedObject>,
    now: HostNow,
) -> Result<DocxToOdtResult, OdtError> {
    let parsed = parse_docx(docx_bytes, &NoHost).map_err(OdtError::thrown)?;
    // `JSZip.loadAsync(docxBytes)`: the entries as they are, with no Strict
    // normalization (`parseDocx` already passed the gate)
    let zip = ooxml_pkg::load_package(docx_bytes, &DEFAULT_ZIP_LIMITS, |_| Ok(()))
        .map_err(OdtError::thrown)?;
    let rels = document_relationships(&zip)?;
    let report = RefCell::new(ReportBuilder::new());

    let media_zip = &zip;
    let media_rels = &rels;
    let mut normaliser = BlockNormaliser::new(NormaliseEnv {
        parsed: &parsed,
        rendered: Box::new(|key| rendered.get(key)),
        report: &report,
        media: Box::new(move |r_id| {
            let target = media_rels.get(r_id)?;
            let part = media_zip.file(target)?;
            part.bytes().ok().map(|bytes| bytes.to_vec())
        }),
    });

    // ---- body elements
    let mut items: Vec<ItemRef> = Vec::new();
    let mut blocks: Vec<Block> = Vec::new();
    for b in &parsed.blocks {
        for item in normaliser.block(b) {
            blocks.extend(item.blocks.iter().cloned());
            items.push(Rc::new(RefCell::new(item)));
        }
    }
    for item in normaliser.end() {
        blocks.extend(item.blocks.iter().cloned());
        items.push(Rc::new(RefCell::new(item)));
    }
    count_tocs(&parsed, &mut report.borrow_mut());

    // ---- page groups and master pages
    let section_blocks: Vec<SectionBlock> = parsed
        .blocks
        .iter()
        .map(|b| SectionBlock {
            hidden: *b.hidden,
            original_xml: (*b.original_xml).clone().flatten(),
            docx_index: (*b.docx_index).flatten().map(|n| n.0),
        })
        .collect();
    let sections = read_sections(&section_blocks, parsed.gutter_at_top);
    let groups = page_groups(&parsed, &sections, &mut report.borrow_mut());
    let mut hf_paras: JsMap<Vec<HfParagraph>> = JsMap::new();
    if let Some(hf_parts) = parsed.hf_parts.as_ref() {
        for (r_id, part) in hf_parts.entries() {
            let mut paras: Vec<HfParagraph> = Vec::new();
            for p in part.paras.iter().filter(|x| x.cells.is_none()) {
                let source: &[docx_engine::model::Run] = p.runs.as_deref().unwrap_or_default();
                let runs = normaliser.runs(source, &mut blocks::ObjectKeys::new(None));
                let mut next = p.clone();
                next.runs.set(runs);
                paras.push(next);
            }
            hf_paras.set(r_id, paras);
        }
    }
    report.borrow_mut().add(
        ReportKind::Dropped,
        ReportFeature::Revision,
        normaliser.revisions,
    );
    drop(normaliser);
    let document_xml = read_part(&zip, "word/document.xml")?;
    document_level_report(&parsed, &mut report.borrow_mut(), &document_xml);
    let mut hf_xml: Vec<String> = Vec::new();
    if let Some(hf_parts) = parsed.hf_parts.as_ref() {
        for (r_id, _) in hf_parts.entries() {
            if let Some(target) = rels.get(r_id) {
                hf_xml.push(read_part(&zip, target)?);
            }
        }
    }
    let styles_part = read_part(&zip, "word/styles.xml")?;
    let theme_count = unresolved_theme_references(
        &parsed,
        &ThemeSources {
            document_xml: &document_xml,
            styles_xml: &styles_part,
            parts: hf_xml.iter().map(String::as_str).collect(),
        },
    );
    report
        .borrow_mut()
        .add(ReportKind::Converted, ReportFeature::Theme, theme_count);

    // ---- the skeleton
    let mut fonts = FontSet::new();
    let defaults = default_style_xml(parsed.doc_defaults.as_ref(), &mut fonts)?;
    let paragraph_styles = paragraph_styles_xml(&parsed, &mut fonts)?;
    let mut masters: JsMap<&MasterSpec> = JsMap::new();
    for g in &groups {
        masters.set(g.master.name.as_str(), &g.master);
    }
    let masters: Vec<&MasterSpec> = masters.values().copied().collect();
    let styles_xml = format!(
        "{XML_DECL}<office:document-styles {NAMESPACES} office:version=\"{ODF_VERSION}\">\
<office:font-face-decls>{}</office:font-face-decls>\
<office:styles>{defaults}{}{}</office:styles>\
<office:automatic-styles>{}</office:automatic-styles>\
<office:master-styles>{}</office:master-styles>\
</office:document-styles>",
        fonts.decls(),
        paragraph_styles.xml,
        outline_style_xml(),
        masters
            .iter()
            .map(|m| page_layout_xml(m))
            .collect::<String>(),
        masters
            .iter()
            .map(|m| master_page_xml(m))
            .collect::<String>(),
    );
    let content_xml = format!(
        "{XML_DECL}<office:document-content {NAMESPACES} office:version=\"{ODF_VERSION}\">\
<office:font-face-decls/><office:automatic-styles/>\
<office:body><office:text>{}</office:text></office:body></office:document-content>",
        sequence_decls()
    );
    let manifest = |extra: &[(&str, &str)]| -> String {
        let mut out = format!(
            "{XML_DECL}<manifest:manifest xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\" manifest:version=\"{ODF_VERSION}\">\
<manifest:file-entry manifest:full-path=\"/\" manifest:version=\"{ODF_VERSION}\" manifest:media-type=\"{ODT_MEDIA_TYPE}\"/>"
        );
        for p in ["content.xml", "styles.xml", "meta.xml"] {
            out.push_str(&format!(
                "<manifest:file-entry manifest:full-path=\"{p}\" manifest:media-type=\"text/xml\"/>"
            ));
        }
        for (path, media_type) in extra {
            out.push_str(&format!(
                "<manifest:file-entry manifest:full-path=\"{}\" manifest:media-type=\"{}\"/>",
                escape_xml_attr(path),
                escape_xml_attr(media_type)
            ));
        }
        out.push_str("</manifest:manifest>");
        out
    };
    let meta_xml = build_meta_xml(&zip, &parsed)?;
    let skeleton = write_zip(
        &[
            data_entry("mimetype", ODT_MEDIA_TYPE.as_bytes().to_vec(), true),
            data_entry("META-INF/manifest.xml", manifest(&[]).into_bytes(), false),
            data_entry("content.xml", content_xml.into_bytes(), false),
            data_entry("styles.xml", styles_xml.into_bytes(), false),
            data_entry("meta.xml", meta_xml.clone().into_bytes(), false),
        ],
        now,
    )?;
    let doc = Rc::new(open_odt(&skeleton, &OpenOdtOptions::default())?);

    // ---- write the body and the master page regions as new content
    let mut map = create_bridge_map(&doc.generator);
    map.styles = BridgeStyles {
        paragraph: paragraph_styles
            .names
            .iter()
            .map(|(style_id, odf_name)| BridgeStyleEntry {
                style_id: style_id.to_owned(),
                odf_name: Some(odf_name.clone()),
                heading_level: None,
                xml: String::new(),
            })
            .collect(),
        doc_defaults: String::new(),
        default_family: Some("paragraph".to_owned()),
        base_paragraph_style: Some(paragraph_styles.base.clone()),
    };
    // `{ ...parsed, blocks }`
    let edited = Rc::new(ParsedDoc { blocks, ..parsed });
    let mut registry = odt_registry();
    registry.add_run_writer(Rc::new(LabelRunWriter));
    let mut rctx = OoxmlToOdfContext::new(
        Rc::clone(&doc),
        map,
        Rc::clone(&edited),
        Rc::new(registry),
        OoxmlToOdfOptions::default(),
    );
    let mut body = String::new();
    let mut section_seq = 0;
    for (i, g) in groups.iter().enumerate() {
        let mut xml = String::new();
        for sub in &g.subsections {
            let own: Vec<AlignedItem> = items
                .iter()
                .filter(|it| {
                    let index = it.borrow().index as f64;
                    index >= sub.first && index <= sub.last
                })
                .map(|item| AlignedItem {
                    item: Rc::clone(item),
                    element: None,
                    unchanged: false,
                })
                .collect();
            if own.is_empty() {
                continue;
            }
            let flow = rebuild_flow(
                &mut rctx,
                &own,
                &FlowEnv {
                    parent: None,
                    neighbours: None,
                },
            )?;
            // a continuous section with its own columns is a text:section of the page run
            if g.subsections.len() > 1 && sub.columns.count > 1.0 {
                let columns = columns_xml(&sub.columns);
                let style = rctx.derived_style(
                    OdtStylePart::ContentXml,
                    &format!(
                        "export-section:{}:{}",
                        number_to_string(sub.columns.count),
                        number_to_string(sub.columns.gap)
                    ),
                    "Sect",
                    |name| {
                        format!(
                            "<style:style style:name=\"{name}\" style:family=\"section\"><style:section-properties>{columns}</style:section-properties></style:style>"
                        )
                    },
                );
                section_seq += 1;
                xml.push_str(&format!(
                    "<text:section text:style-name=\"{style}\" text:name=\"Section{section_seq}\">{flow}</text:section>"
                ));
            } else {
                xml.push_str(&flow);
            }
        }
        if xml.is_empty() {
            continue;
        }
        let start = i > 0 || g.master.name != "Standard" || g.section.page_number_start.is_some();
        if start {
            xml = start_page_run(
                &mut rctx,
                &xml,
                &g.master.name,
                g.section.page_number_start.map(|n| n.0),
            )?;
        }
        body.push_str(&xml);
    }
    let text = doc.body.text;
    rctx.patch(
        OdtStylePart::ContentXml,
        text.close_start,
        text.close_start,
        &body,
    );
    for m in &masters {
        let Some(master) = doc.styles.master_page(&m.name) else {
            continue;
        };
        let Some(group) = groups.iter().find(|g| g.master.name == m.name) else {
            continue;
        };
        for region in &m.regions {
            let range = master
                .regions
                .iter()
                .find(|(name, _)| name == region)
                .map(|(_, range)| range);
            let r_id = group
                .part_of(*region)
                .and_then(|part| part.as_deref())
                .filter(|r_id| !r_id.is_empty());
            let (Some(range), Some(r_id)) = (range, r_id) else {
                continue;
            };
            let empty: Vec<HfParagraph> = Vec::new();
            let edited_paras = hf_paras.get(r_id).unwrap_or(&empty);
            let inner = region_inner_xml(&mut rctx, None, &[], None, edited_paras)?;
            if !inner.is_empty() {
                let name = region.as_str();
                rctx.patch(
                    OdtStylePart::StylesXml,
                    range.start,
                    range.end,
                    &format!("<style:{name}>{inner}</style:{name}>"),
                );
            }
        }
    }
    let patches = rctx.finish();
    // headings as Hancom writes them (it numbers every text:h)
    let mut levels: JsMap<f64> = JsMap::new();
    for (style_id, odf_name) in paragraph_styles.names.iter() {
        let level = theme::style_of(&edited, style_id)
            .and_then(|s| s.heading_level)
            .map(|n| n.0)
            .filter(|n| *n != 0.0 && !n.is_nan());
        if let Some(level) = level {
            levels.set(odf_name.as_str(), level);
        }
    }
    let content = headings_as_paragraphs(
        &apply_text_patches(&doc.content_xml.text, &patches.content)?,
        &levels,
    )
    .map_err(|e| OdtError::thrown(e.to_string()))?;
    let styles = headings_as_paragraphs(
        &apply_text_patches(
            doc.styles_xml.as_ref().map_or("", |s| s.text.as_str()),
            &patches.styles,
        )?,
        &levels,
    )
    .map_err(|e| OdtError::thrown(e.to_string()))?;
    let changes = object_package_changes(
        &mut rctx,
        &FinalParts {
            content_xml: &content,
            styles_xml: Some(&styles),
        },
    )?;

    let extra: Vec<(&str, &str)> = changes
        .add
        .iter()
        .map(|a| (a.path.as_str(), a.media_type.as_str()))
        .collect();
    let mut entries: Vec<ZipEntryInput<'_>> = vec![
        data_entry("mimetype", ODT_MEDIA_TYPE.as_bytes().to_vec(), true),
        data_entry(
            "META-INF/manifest.xml",
            manifest(&extra).into_bytes(),
            false,
        ),
        data_entry("content.xml", content.into_bytes(), false),
        data_entry("styles.xml", styles.into_bytes(), false),
        data_entry("meta.xml", meta_xml.into_bytes(), false),
    ];
    for a in &changes.add {
        entries.push(data_entry(&a.path, a.data.clone(), true));
    }
    let odt_bytes = write_zip(&entries, now)?;
    let report = report.borrow().build();
    Ok(DocxToOdtResult { odt_bytes, report })
}

/// A `{ kind: 'data', name, data, store }` zip input.
fn data_entry(name: &str, data: Vec<u8>, store: bool) -> ZipEntryInput<'static> {
    ZipEntryInput::Data {
        name: name.to_owned(),
        data: std::borrow::Cow::Owned(data),
        store,
        dos_date_time: None,
    }
}

// ---------------------------------------------------------------------------

/// `readPart`: the text of a part, `''` when it is missing.
fn read_part(zip: &Package, path: &str) -> Result<String, OdtError> {
    match zip.text(path) {
        Ok(text) => Ok(text.unwrap_or("").to_owned()),
        Err(error) => Err(OdtError::thrown(error.to_string())),
    }
}

/// `documentRelationships`: relationship id to package path of
/// word/document.xml's relationships.
fn document_relationships(zip: &Package) -> Result<JsMap<String>, OdtError> {
    let mut out = JsMap::new();
    let xml = read_part(zip, "word/_rels/document.xml.rels")?;
    for m in js_regex!(r"<Relationship\b[^>]*>", "g").find_iter(&xml) {
        let tag = m.as_str();
        let id = js_regex!(r#"\bId="([^"]*)""#)
            .exec(tag)
            .and_then(|m| m.get(1));
        let target = js_regex!(r#"\bTarget="([^"]*)""#)
            .exec(tag)
            .and_then(|m| m.get(1));
        let (Some(id), Some(target)) = (
            id.filter(|id| !id.is_empty()),
            target.filter(|target| !target.is_empty()),
        ) else {
            continue;
        };
        if js_regex!(r#"TargetMode="External""#).test(tag) {
            continue;
        }
        let t = decode_xml_entities(target);
        let path = match t.strip_prefix('/') {
            Some(rest) => rest.to_owned(),
            None => format!("word/{}", t.strip_prefix("./").unwrap_or(&t)),
        };
        out.set(id, path);
    }
    Ok(out)
}

/// The three slots of `effectiveRef`.
#[derive(Clone, Copy)]
enum Variant {
    Default,
    First,
    Even,
}

/// `effectiveRef`: the part a section shows in a slot, inherited from earlier
/// sections as Word does.
fn effective_ref(
    sections: &[SectionInfo],
    index: usize,
    header: bool,
    variant: Variant,
) -> Option<String> {
    for j in (0..=index).rev() {
        let refs = if header {
            &sections[j].header_refs
        } else {
            &sections[j].footer_refs
        };
        let found = refs.get(match variant {
            Variant::Default => "default",
            Variant::First => "first",
            Variant::Even => "even",
        });
        if let Some(found) = found.filter(|f| !f.is_empty()) {
            return Some(found.clone());
        }
    }
    None
}

/// `REGION_ORDER`
const REGION_ORDER: [Region; 6] = [
    Region::Header,
    Region::HeaderLeft,
    Region::HeaderFirst,
    Region::Footer,
    Region::FooterLeft,
    Region::FooterFirst,
];

/// `pageGroups`: docx sections to page groups (continuous breaks join the
/// previous group) with their masters.
fn page_groups(
    parsed: &ParsedDoc,
    sections: &[SectionInfo],
    report: &mut ReportBuilder,
) -> Vec<PageGroup> {
    let even_odd = parsed.even_and_odd_headers == Some(true);
    let mut groups: Vec<PageGroup> = Vec::new();
    let mut unequal = 0usize;
    let mut columns_of = |s: &SectionInfo| -> PageColumns {
        let st = &s.settings;
        if st.columns.0 > 1.0
            && let Some(widths) = st.col_widths.as_ref()
        {
            // `new Set(st.colWidths).size > 1`: SameValueZero
            let mut distinct: Vec<f64> = Vec::new();
            for w in widths {
                if !distinct
                    .iter()
                    .any(|d| *d == w.0 || (d.is_nan() && w.0.is_nan()))
                {
                    distinct.push(w.0);
                }
            }
            if distinct.len() > 1 {
                unequal += 1;
            }
        }
        let count = if st.columns.0 == 0.0 || st.columns.0.is_nan() {
            1.0
        } else {
            st.columns.0
        };
        PageColumns {
            count: jscompat::math_max(1.0, count),
            gap: st.col_space.map_or(720.0, |n| n.0),
        }
    };
    for (i, s) in sections.iter().enumerate() {
        if let Some(prev) = groups.last_mut()
            && matches!(s.start_type, "continuous" | "nextColumn")
        {
            prev.last = s.last_block_index.0;
            prev.subsections.push(Subsection {
                first: s.first_block_index.0,
                last: s.last_block_index.0,
                columns: columns_of(s),
            });
            // a page run of several column layouts gets them from its sections
            prev.master.columns = PageColumns {
                count: 1.0,
                gap: 0.0,
            };
            continue;
        }
        let mut parts: Vec<(Region, Option<String>)> = Vec::new();
        for header in [true, false] {
            let (plain, first, left) = if header {
                (Region::Header, Region::HeaderFirst, Region::HeaderLeft)
            } else {
                (Region::Footer, Region::FooterFirst, Region::FooterLeft)
            };
            if let Some(def) = effective_ref(sections, i, header, Variant::Default) {
                parts.push((plain, Some(def)));
            }
            if s.title_pg {
                parts.push((first, effective_ref(sections, i, header, Variant::First)));
            }
            if even_odd {
                parts.push((left, effective_ref(sections, i, header, Variant::Even)));
            }
        }
        let mut regions: Vec<Region> = parts.iter().map(|(r, _)| *r).collect();
        regions.sort_by_key(|r| REGION_ORDER.iter().position(|o| o == r));
        // one master page per docx page section, so the sections stay sections
        let n = groups.len() + 1;
        let columns = columns_of(s);
        let master = MasterSpec {
            name: if n == 1 {
                "Standard".to_owned()
            } else {
                format!("MP{n}")
            },
            layout_name: format!("Mpm{n}"),
            settings: s.settings.clone(),
            header: regions
                .iter()
                .any(|r| matches!(r, Region::Header | Region::HeaderLeft | Region::HeaderFirst)),
            footer: regions
                .iter()
                .any(|r| matches!(r, Region::Footer | Region::FooterLeft | Region::FooterFirst)),
            regions,
            num_format: s.page_number_fmt.clone(),
            mirrored: parsed.mirror_margins == Some(true),
            columns,
        };
        groups.push(PageGroup {
            last: s.last_block_index.0,
            section: s.clone(),
            master,
            parts,
            subsections: vec![Subsection {
                first: s.first_block_index.0,
                last: s.last_block_index.0,
                columns,
            }],
        });
    }
    if groups.is_empty() {
        let fallback = MasterSpec {
            name: "Standard".to_owned(),
            layout_name: "Mpm1".to_owned(),
            settings: SectionSettings {
                page_width: JsNum(11906.0),
                page_height: JsNum(16838.0),
                orientation: "portrait",
                margin_top: JsNum(1440.0),
                margin_right: JsNum(1440.0),
                margin_bottom: JsNum(1440.0),
                margin_left: JsNum(1440.0),
                margin_top_fixed: None,
                margin_bottom_fixed: None,
                gutter: None,
                gutter_at_top: None,
                page_border: false,
                page_border_props: None,
                columns: JsNum(1.0),
                col_space: None,
                col_widths: None,
                line_numbers: None,
                bidi: None,
                header_dist: None,
                footer_dist: None,
                v_align: None,
                doc_grid: None,
                text_direction: None,
                footnote_pr: None,
                endnote_pr: None,
            },
            header: false,
            footer: false,
            regions: Vec::new(),
            num_format: None,
            mirrored: false,
            columns: PageColumns {
                count: 1.0,
                gap: 0.0,
            },
        };
        groups.push(PageGroup {
            last: MAX_SAFE_INTEGER,
            section: SectionInfo {
                settings: fallback.settings.clone(),
                start_type: "nextPage",
                first_block_index: JsNum(0.0),
                last_block_index: JsNum(MAX_SAFE_INTEGER),
                sect_pr_xml: String::new(),
                title_pg: false,
                page_number_start: None,
                page_number_fmt: None,
                header_refs: JsObject::new(),
                footer_refs: JsObject::new(),
            },
            master: fallback,
            parts: Vec::new(),
            subsections: vec![Subsection {
                first: 0.0,
                last: MAX_SAFE_INTEGER,
                columns: PageColumns {
                    count: 1.0,
                    gap: 0.0,
                },
            }],
        });
    }
    // the last group takes everything after it (trailing elements)
    if let Some(last_group) = groups.last_mut() {
        last_group.last = MAX_SAFE_INTEGER;
        if let Some(sub) = last_group.subsections.last_mut() {
            sub.last = MAX_SAFE_INTEGER;
        }
    }
    // ODF columns are equal: unequal docx column widths become equal ones
    report.add(ReportKind::Converted, ReportFeature::Columns, unequal);
    // mirror margins are style:page-usage="mirrored": kept as they are, not reported
    groups
}

/// `startPageRun`: points the first element of a page run at its master page
/// (and page number start).
fn start_page_run(
    rctx: &mut OoxmlToOdfContext,
    xml: &str,
    master: &str,
    page_number: Option<f64>,
) -> Result<String, OdtError> {
    let change = StartChange {
        paragraph: 0,
        master: Some(Some(master.to_owned())),
        page_number: page_number.map(|n| Some(number_to_string(n))),
    };
    if let Some(table) = js_regex!(r"^<table:table\b[^>]*>").exec(xml) {
        let table = table.as_str();
        let name = js_regex!(r#"\stable:style-name="([^"]*)""#)
            .exec(table)
            .and_then(|m| m.get(1))
            .filter(|name| !name.is_empty());
        let queued: Option<String> = name.and_then(|name| {
            let prefix = format!("<style:style style:name=\"{name}\"");
            rctx.new_automatic_styles(OdtStylePart::ContentXml)
                .iter()
                .find(|s| s.starts_with(&prefix))
                .cloned()
        });
        let (Some(name), Some(queued)) = (name, queued) else {
            return Ok(xml.to_owned());
        };
        let mut failure: Option<OdtError> = None;
        let derived = rctx.derived_style(
            OdtStylePart::ContentXml,
            &format!("page-start-table:{name}:{master}"),
            name,
            |n| {
                let mut attrs = crate::text::props::AttrOverrides::new();
                attrs.set("style:master-page-name", Some(master.to_owned()));
                match edit_style_xml(
                    &queued,
                    &PrefixMap::new(),
                    &StyleXmlEdit {
                        name: Some(n.to_owned()),
                        attrs: Some(attrs),
                        ..StyleXmlEdit::default()
                    },
                ) {
                    Ok(style) => style,
                    Err(error) => {
                        failure = Some(error);
                        String::new()
                    }
                }
            },
        );
        if let Some(error) = failure {
            return Err(error);
        }
        let replaced = replace_first_string(
            table,
            &format!("table:style-name=\"{name}\""),
            &format!("table:style-name=\"{derived}\""),
        );
        return Ok(replace_first_string(xml, table, &replaced));
    }
    let Some(m) = js_regex!(r"<(text:p|text:h)(?=[\s/>])[^>]*>").exec(xml) else {
        return Ok(xml.to_owned());
    };
    let m0 = m.as_str();
    let raw = js_regex!(r#"\stext:style-name="([^"]*)""#)
        .exec(m0)
        .and_then(|found| found.get(1));
    let current = raw.map(decode_xml_entities);
    let name = start_style(rctx, current.as_deref(), &change)?;
    let attr = format!("text:style-name=\"{}\"", escape_xml_attr(&name));
    let tag = match raw {
        None => replace_first_with(js_regex!(r"^<(text:p|text:h)"), m0, |open| {
            format!("{} {attr}", open.as_str())
        }),
        Some(raw) => replace_first_string(m0, &format!("text:style-name=\"{raw}\""), &attr),
    };
    Ok(format!("{}{tag}{}", &xml[..m.start()], &xml[m.end()..]))
}

/// `countTocs`: one table of contents per run of TOC lines.
fn count_tocs(parsed: &ParsedDoc, report: &mut ReportBuilder) {
    let mut in_toc = false;
    for b in &parsed.blocks {
        let toc = b
            .field_display
            .as_ref()
            .is_some_and(|fd| fd.kind == docx_engine::model::FieldDisplayKind::TocLine);
        if toc && !in_toc {
            report.add(ReportKind::Converted, ReportFeature::Toc, 1);
        }
        if *b.hidden != Some(true) {
            in_toc = toc;
        }
    }
}

/// `documentLevelReport`: document-level features: fields, comments, page
/// colour, theme, ink, watermark, protection.
fn document_level_report(parsed: &ParsedDoc, report: &mut ReportBuilder, document_xml: &str) {
    let mut citations = 0usize;
    let mut references = 0usize;
    let mut instructions: Vec<&str> = js_regex!(r"<w:instrText\b[^>]*>([^<]*)<\/w:instrText>", "g")
        .find_iter(document_xml)
        .map(|m| m.get(1).unwrap_or(""))
        .collect();
    instructions.extend(
        js_regex!(r#"<w:fldSimple\b[^>]*\bw:instr="([^"]*)""#, "g")
            .find_iter(document_xml)
            .map(|m| m.get(1).unwrap_or("")),
    );
    for raw in instructions {
        let instr = decode_xml_entities(raw);
        let instr = trim(&instr);
        if js_regex!(
            r"^(?:CITATION|BIBLIOGRAPHY)\b|^ADDIN\s+(?:ZOTERO|EN\.CITE|CSL|Mendeley)",
            "i"
        )
        .test(instr)
        {
            citations += 1;
        } else if js_regex!(r"^(?:REF|NOTEREF|SEQ)\b", "i").test(instr)
            || js_regex!(r"^PAGEREF\s+(?!_Toc)", "i").test(instr)
        {
            references += 1;
        }
    }
    citations += js_regex!(r"<w:citation\b", "g")
        .find_iter(document_xml)
        .count();
    report.add(ReportKind::Converted, ReportFeature::Citation, citations);
    report.add(
        ReportKind::Converted,
        ReportFeature::CrossReference,
        references,
    );
    report.add(
        ReportKind::Dropped,
        ReportFeature::PageColor,
        usize::from(read_page_color(&parsed.internal.document_xml).is_some()),
    );
    report.add(
        ReportKind::Dropped,
        ReportFeature::Comment,
        parsed.comments.len(),
    );
    report.add(ReportKind::Dropped, ReportFeature::Ink, parsed.inks.len());
    let watermark_text = parsed
        .watermark_text
        .as_ref()
        .and_then(|t| t.as_deref())
        .is_some_and(|t| !t.is_empty());
    let watermark_picture = parsed
        .watermark_picture
        .as_ref()
        .is_some_and(|p| p.is_some());
    if watermark_text || watermark_picture {
        report.add(ReportKind::Dropped, ReportFeature::Watermark, 1);
    }
    let has_hash = |h: Option<&String>| h.is_some_and(|h| !h.is_empty());
    let passwords = usize::from(has_hash(
        parsed.protection.as_ref().and_then(|p| p.hash.as_ref()),
    )) + usize::from(has_hash(
        parsed
            .write_protection
            .as_ref()
            .and_then(|p| p.hash.as_ref()),
    ));
    report.add(ReportKind::Dropped, ReportFeature::Password, passwords);
    let restrictions = usize::from(parsed.protection.as_ref().is_some_and(|p| p.enforced))
        + usize::from(
            parsed
                .write_protection
                .as_ref()
                .is_some_and(|p| p.recommended == Some(true)),
        );
    report.add(ReportKind::Dropped, ReportFeature::Protection, restrictions);
}

/// `buildMetaXml`: meta.xml from docx core properties (people fields only when
/// not asked to remove them).
fn build_meta_xml(zip: &Package, parsed: &ParsedDoc) -> Result<String, OdtError> {
    let core = read_part(zip, "docProps/core.xml")?;
    let field = |tag: &str| -> String {
        // the tags are the five fixed names below
        let m = match tag {
            "dc:title" => js_regex!(r"<dc:title\b[^>]*>([^<]*)</dc:title>").exec(&core),
            "dc:creator" => js_regex!(r"<dc:creator\b[^>]*>([^<]*)</dc:creator>").exec(&core),
            "cp:lastModifiedBy" => {
                js_regex!(r"<cp:lastModifiedBy\b[^>]*>([^<]*)</cp:lastModifiedBy>").exec(&core)
            }
            "dcterms:created" => {
                js_regex!(r"<dcterms:created\b[^>]*>([^<]*)</dcterms:created>").exec(&core)
            }
            _ => js_regex!(r"<dcterms:modified\b[^>]*>([^<]*)</dcterms:modified>").exec(&core),
        };
        match m {
            Some(m) => trim(&decode_xml_entities(m.get(1).unwrap_or(""))).to_owned(),
            None => String::new(),
        }
    };
    let remove = parsed.remove_personal_info;
    let title = field("dc:title");
    let creator = if remove {
        String::new()
    } else {
        field("dc:creator")
    };
    let modifier = if remove {
        String::new()
    } else {
        field("cp:lastModifiedBy")
    };
    let strip_z = |s: String| js_regex!(r"Z$").replace_all(&s, |_| String::new());
    let created = strip_z(field("dcterms:created"));
    let modified = strip_z(field("dcterms:modified"));
    let date_like = js_regex!(r"^\d{4}-\d{2}-\d{2}T");
    let mut out = format!(
        "{XML_DECL}<office:document-meta {NAMESPACES} office:version=\"{ODF_VERSION}\"><office:meta><meta:generator>seuoffice</meta:generator>"
    );
    if !title.is_empty() {
        out.push_str(&format!("<dc:title>{}</dc:title>", escape_xml_text(&title)));
    }
    if !creator.is_empty() {
        out.push_str(&format!(
            "<meta:initial-creator>{}</meta:initial-creator>",
            escape_xml_text(&creator)
        ));
    }
    if !modifier.is_empty() {
        out.push_str(&format!(
            "<dc:creator>{}</dc:creator>",
            escape_xml_text(&modifier)
        ));
    }
    if date_like.test(&created) {
        out.push_str(&format!(
            "<meta:creation-date>{created}</meta:creation-date>"
        ));
    }
    if date_like.test(&modified) {
        out.push_str(&format!("<dc:date>{modified}</dc:date>"));
    }
    out.push_str("</office:meta></office:document-meta>");
    Ok(out)
}
