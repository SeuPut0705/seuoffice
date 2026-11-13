//! `page/forward.ts`: ODF to OOXML for pages: page runs (master pages) and
//! `text:section`s become docx sections, master page regions become
//! header/footer parts.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use jscompat::{JsObject, js_regex};

use crate::core::convert::{
    BridgeElement, BridgeMap, DocxExtraPart, DocxPartData, OdfToOoxmlContext, OdtPartInfo,
};
use crate::core::docx_package::BRIDGE_DOCUMENT_NAMESPACES;
use crate::core::errors::OdtError;
use crate::core::styles::{OdtMasterPage, OdtStylePart, OdtStyleScope, OdtStyleTable};
use crate::core::xml::escape_xml_attr;
use crate::text::lists::num_fmt_from_odf;
use crate::text::paragraph_ooxml::{ParagraphOoxmlOptions, paragraph_to_ooxml};

use super::geometry::{PageGeometry, columns_of, layout_geometry};
use super::model::{
    DocxSection, HfFill, HfKindName, HfRegion, PAGE_EXT_KEY, PAGE_OWNER, PageExt, PageHfPart,
    PageRun, StartFamily, master_region,
};
use super::odf::{
    child_elements, even_odd_of, master_of, page_number_of, start_tag_at, title_pg_of,
};
use super::sectpr::{
    ColumnsSpec, PageNumberSpec, SectPrSpec, build_sect_pr, inject_paragraph_sect_pr,
};

const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n";
const REL_BASE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT_BASE: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml";

/// `defaultMasterPage`: the master page used where no paragraph names one.
pub fn default_master_page(styles: &OdtStyleTable) -> Option<Rc<OdtMasterPage>> {
    styles
        .master_page("Standard")
        .or_else(|| styles.master_pages.first().cloned())
}

/// `RunStart`
#[derive(Debug, Clone)]
struct RunStart {
    master: String,
    paragraph: Option<usize>,
    block: Option<usize>,
    style: String,
    family: StartFamily,
}

/// `Draft`
struct Draft {
    run: usize,
    region: Option<usize>,
    continuous: bool,
    elements: Vec<usize>,
}

/// `isParagraph`
fn is_paragraph(map: &BridgeMap, id: usize) -> bool {
    js_regex!(r"^<w:p[\s>/]").test(&map.elements[id].xml)
}

fn block_start(
    map: &BridgeMap,
    styles: &OdtStyleTable,
    content: &OdtPartInfo,
    block_id: usize,
) -> Option<RunStart> {
    let block = &map.blocks[block_id];
    if block.part != OdtStylePart::ContentXml {
        return None;
    }
    let tag = start_tag_at(
        &content.xml.text,
        content.xml.to_byte(block.start),
        &content.prefixes,
    )?;
    let family = match tag.name.as_str() {
        "text:p" | "text:h" => StartFamily::Paragraph,
        "table:table" => StartFamily::Table,
        _ => return None,
    };
    let style = tag.attrs.get(if family == StartFamily::Paragraph {
        "text:style-name"
    } else {
        "table:style-name"
    })?;
    let master = master_of(
        styles
            .find(style, family.as_str(), OdtStyleScope::Content)
            .as_deref(),
    )?;
    Some(RunStart {
        master,
        paragraph: None,
        block: Some(block_id),
        style: style.clone(),
        family,
    })
}

fn element_start(
    map: &BridgeMap,
    styles: &OdtStyleTable,
    content: &OdtPartInfo,
    el: &BridgeElement,
    first_of_block: bool,
) -> Option<RunStart> {
    if let Some(paragraph) = el.paragraph {
        let rec = map.paragraphs.get(paragraph)?;
        if rec.part == OdtStylePart::ContentXml
            && let Some(style_name) = &rec.style_name
        {
            let master = master_of(
                styles
                    .find(style_name, "paragraph", OdtStyleScope::Content)
                    .as_deref(),
            )?;
            return Some(RunStart {
                master,
                paragraph: Some(rec.id),
                block: rec.block,
                style: style_name.clone(),
                family: StartFamily::Paragraph,
            });
        }
        return None;
    }
    if first_of_block {
        block_start(map, styles, content, el.block)
    } else {
        None
    }
}

fn subtree_has_elements(map: &BridgeMap, id: usize) -> bool {
    let b = &map.blocks[id];
    !b.elements.is_empty() || b.children.iter().any(|c| subtree_has_elements(map, *c))
}

fn region_of(map: &BridgeMap, block_id: usize) -> Option<usize> {
    let mut b = map.blocks.get(block_id);
    while let Some(block) = b {
        if block.name == "text:section" {
            return Some(block.id);
        }
        b = map.blocks.get(block.parent?);
    }
    None
}

/// `convertOdtPage`: converts page runs, sections and headers/footers. Call
/// after `convertOdtBody` (it reads the bridge elements) and before
/// `buildBridgeDocx`.
pub fn convert_odt_page(ctx: &mut OdfToOoxmlContext) -> Result<(), OdtError> {
    let doc = ctx.doc.clone();
    let styles = &doc.styles;
    let content = ctx.part(OdtStylePart::ContentXml);

    // ---- where page runs start
    // blocks without any element (kept verbatim) can still switch the master
    // page: the switch shows from the next element on
    let mut pending_before: HashMap<usize, RunStart> = HashMap::new();
    {
        let map = &ctx.map;
        let mut pending: Option<RunStart> = None;
        let mut next_element = 0usize;
        for block in &map.blocks {
            while next_element < map.elements.len() && map.elements[next_element].block < block.id {
                if let Some(p) = pending.take() {
                    pending_before.insert(next_element, p);
                }
                next_element += 1;
            }
            if !subtree_has_elements(map, block.id)
                && let Some(s) = block_start(map, styles, &content, block.id)
            {
                pending = Some(s);
            }
        }
        if let Some(p) = pending
            && next_element < map.elements.len()
        {
            pending_before.insert(next_element, p);
        }
    }

    // ---- page runs and docx sections
    let default_master = default_master_page(styles);
    let make_run = |start: Option<&RunStart>| -> PageRun {
        let name: Option<String> = match start {
            Some(s) => Some(s.master.clone()),
            None => default_master.as_ref().map(|m| m.name.clone()),
        };
        PageRun {
            master: name.clone(),
            layout: name
                .as_deref()
                .and_then(|n| styles.master_page(n))
                .and_then(|m| m.page_layout_name.clone()),
            start_paragraph: start.and_then(|s| s.paragraph),
            start_block: start.and_then(|s| s.block),
            start_style: start.map(|s| s.style.clone()),
            start_family: start.map(|s| s.family),
            hidden: false,
            slots: JsObject::new(),
        }
    };
    let mut runs: Vec<PageRun> = vec![make_run(None)];
    let mut run_page_number: Vec<Option<f64>> = vec![None];
    let mut drafts: Vec<Draft> = Vec::new();
    {
        let map = &ctx.map;
        let mut seen_blocks: HashSet<usize> = HashSet::new();
        for (index, el) in map.elements.iter().enumerate() {
            let first_of_block = !seen_blocks.contains(&el.block);
            seen_blocks.insert(el.block);
            let start = element_start(map, styles, &content, el, first_of_block)
                .or_else(|| pending_before.get(&index).cloned());
            let region = region_of(map, el.block);
            let current = drafts.last().map(|d| (d.region, d.run));
            if let Some(start) = &start {
                let r = make_run(Some(start));
                let number = page_number_of(styles, &start.style, start.family.as_str());
                if index == 0 {
                    runs[0] = r;
                    run_page_number[0] = number;
                } else {
                    runs.push(r);
                    run_page_number.push(number);
                }
                if current.is_some() {
                    drafts.push(Draft {
                        run: runs.len() - 1,
                        region,
                        continuous: false,
                        elements: vec![el.id],
                    });
                    continue;
                }
            } else if let Some((current_region, current_run)) = current
                && current_region != region
            {
                drafts.push(Draft {
                    run: current_run,
                    region,
                    continuous: true,
                    elements: vec![el.id],
                });
                continue;
            }
            if current.is_none() {
                drafts.push(Draft {
                    run: runs.len() - 1,
                    region,
                    continuous: false,
                    elements: vec![el.id],
                });
                continue;
            }
            if let Some(last) = drafts.last_mut() {
                last.elements.push(el.id);
            }
        }
    }
    if drafts.is_empty() {
        drafts.push(Draft {
            run: 0,
            region: None,
            continuous: false,
            elements: Vec::new(),
        });
    }

    // a section needs a paragraph to carry its break: one without any joins the next
    for i in (0..drafts.len().saturating_sub(1)).rev() {
        if drafts[i]
            .elements
            .iter()
            .any(|e| is_paragraph(&ctx.map, *e))
        {
            continue;
        }
        let removed = drafts.remove(i);
        let next = &mut drafts[i];
        let mut joined = removed.elements;
        joined.append(&mut next.elements);
        next.elements = joined;
        next.continuous = removed.continuous;
    }
    let shown: HashSet<usize> = drafts.iter().map(|d| d.run).collect();
    for (i, r) in runs.iter_mut().enumerate() {
        r.hidden = !shown.contains(&i);
    }

    // ---- header / footer parts
    let master_of_run = |r: &PageRun| master_page(styles, r.master.as_deref());
    let even_and_odd = runs
        .iter()
        .any(|r| !r.hidden && even_odd_of(master_of_run(r).as_deref()));
    let mut parts: JsObject<PageHfPart> = JsObject::new();
    let mut counters = (0usize, 0usize);
    let mut emitted: HashSet<HfRegion> = HashSet::new();
    for r in runs.iter_mut() {
        if r.hidden {
            continue;
        }
        let master = master_page(styles, r.master.as_deref());
        let has = |region: HfRegion| {
            master
                .as_deref()
                .is_some_and(|m| master_region(m, region).is_some())
        };
        for kind in [HfKindName::Header, HfKindName::Footer] {
            let header = kind == HfKindName::Header;
            let slots: [(HfRegion, bool); 3] = [
                (
                    if header {
                        HfRegion::Header
                    } else {
                        HfRegion::Footer
                    },
                    true,
                ),
                (
                    if header {
                        HfRegion::HeaderFirst
                    } else {
                        HfRegion::FooterFirst
                    },
                    title_pg_of(master.as_deref()),
                ),
                (
                    if header {
                        HfRegion::HeaderLeft
                    } else {
                        HfRegion::FooterLeft
                    },
                    even_and_odd,
                ),
            ];
            let kind_region = slots[0].0;
            for (slot, active) in slots {
                if !active {
                    continue;
                }
                let source: Option<HfRegion>;
                let mut fill = HfFill::Content;
                if has(slot) {
                    source = Some(slot);
                } else if slot != kind_region && has(kind_region) {
                    source = Some(kind_region);
                    fill = HfFill::Fallback;
                } else if emitted.contains(&slot) {
                    source = None;
                    fill = HfFill::Empty;
                } else {
                    continue;
                }
                let n = if header {
                    counters.0 += 1;
                    counters.0
                } else {
                    counters.1 += 1;
                    counters.1
                };
                let part = make_part(ctx, kind, n, master.as_deref(), source, fill)?;
                r.slots.set(slot.as_str(), part.r_id.clone());
                parts.set(part.r_id.clone(), part);
                emitted.insert(slot);
            }
        }
    }
    if even_and_odd {
        add_settings(ctx);
    }

    // ---- sectPr per docx section
    let mut sections: Vec<DocxSection> = Vec::new();
    let mut first_of_run: HashSet<usize> = HashSet::new();
    for i in 0..drafts.len() {
        let (d_run, d_region, d_continuous) =
            (drafts[i].run, drafts[i].region, drafts[i].continuous);
        let r = &runs[d_run];
        let master = master_of_run(r);
        let layout = r.layout.as_deref().and_then(|l| styles.page_layout(l));
        let geometry: PageGeometry = layout_geometry(layout.as_deref());
        let is_first_of_run = !first_of_run.contains(&d_run);
        first_of_run.insert(d_run);
        let mut references: Vec<String> = Vec::new();
        for slot in [
            HfRegion::Header,
            HfRegion::HeaderFirst,
            HfRegion::HeaderLeft,
            HfRegion::Footer,
            HfRegion::FooterFirst,
            HfRegion::FooterLeft,
        ] {
            let Some(r_id) = r.slots.get(slot.as_str()).filter(|id| !id.is_empty()) else {
                continue;
            };
            let name = slot.as_str();
            let kind = if name.starts_with("header") {
                "header"
            } else {
                "footer"
            };
            let ty = if name.ends_with("-first") {
                "first"
            } else if name.ends_with("-left") {
                "even"
            } else {
                "default"
            };
            references.push(format!(
                "<w:{kind}Reference w:type=\"{ty}\" r:id=\"{}\"/>",
                escape_xml_attr(r_id)
            ));
        }
        let start = if is_first_of_run {
            run_page_number[d_run]
        } else {
            None
        };
        let sect_pr = build_sect_pr(&SectPrSpec {
            references,
            continuous: d_continuous,
            columns: match d_region {
                Some(region) => section_columns(ctx, region),
                None => None,
            },
            page_number: PageNumberSpec {
                fmt: geometry
                    .num_format
                    .as_deref()
                    .map(|f| num_fmt_from_odf(Some(f))),
                start,
            },
            title_pg: is_first_of_run && title_pg_of(master.as_deref()),
            geometry,
        });
        let last = i == drafts.len() - 1;
        let mut carrier: Option<usize> = None;
        if !last {
            carrier = drafts[i]
                .elements
                .iter()
                .rev()
                .find(|e| is_paragraph(&ctx.map, **e))
                .copied();
            if let Some(c) = carrier {
                let el = &mut ctx.map.elements[c];
                el.xml = inject_paragraph_sect_pr(&el.xml, &sect_pr);
                // elements after the break paragraph (a table ending the run)
                // show in the next docx section: record them there, as the
                // edited docx will have them
                let at = drafts[i].elements.iter().position(|e| *e == c).unwrap_or(0);
                let trailing: Vec<usize> = drafts[i].elements.split_off(at + 1);
                if !trailing.is_empty() {
                    let next = &mut drafts[i + 1].elements;
                    let mut joined = trailing;
                    joined.append(next);
                    *next = joined;
                }
            }
        } else {
            ctx.docx.sect_pr = Some(sect_pr.clone());
        }
        sections.push(DocxSection {
            run: d_run,
            region: d_region,
            continuous: d_continuous,
            first: drafts[i].elements.first().copied(),
            last: drafts[i].elements.last().copied(),
            carrier,
            sect_pr,
        });
    }

    let ext = PageExt {
        version: 1,
        default_master: default_master.as_ref().map(|m| m.name.clone()),
        even_and_odd,
        runs,
        sections,
        parts,
    };
    ctx.ext_shared(PAGE_EXT_KEY, move || ext);
    Ok(())
}

/// `masterPage`
pub fn master_page(styles: &OdtStyleTable, name: Option<&str>) -> Option<Rc<OdtMasterPage>> {
    name.and_then(|n| styles.master_page(n))
}

/// `sectionColumns`: column count and gap of a `text:section` (its section
/// style), in twips.
fn section_columns(ctx: &OdfToOoxmlContext, block_id: usize) -> Option<ColumnsSpec> {
    let content = ctx.part(OdtStylePart::ContentXml);
    let block = &ctx.map.blocks[block_id];
    let tag = start_tag_at(
        &content.xml.text,
        content.xml.to_byte(block.start),
        &content.prefixes,
    )?;
    let name = tag.attrs.get("text:style-name")?;
    let resolved = ctx
        .doc
        .styles
        .resolve(name, "section", OdtStyleScope::Content);
    let cols = resolved
        .as_ref()
        .and_then(|r| r.properties.get("style:section-properties/style:columns"))?;
    Some(columns_of(Some(cols)).into())
}

/// `makePart`: converts one master page region into a header/footer part and
/// registers it.
fn make_part(
    ctx: &mut OdfToOoxmlContext,
    kind: HfKindName,
    n: usize,
    master: Option<&OdtMasterPage>,
    region: Option<HfRegion>,
    fill: HfFill,
) -> Result<PageHfPart, OdtError> {
    let info = ctx.part(OdtStylePart::StylesXml);
    let mut paragraphs: Vec<usize> = Vec::new();
    let mut body = String::new();
    let range = region.and_then(|r| master.and_then(|m| master_region(m, r)));
    if let Some(range) = range
        && !range.self_closing
    {
        for child in child_elements(
            &info.xml.text,
            &info.prefixes,
            range.open_end,
            range.close_start,
        ) {
            if child.name != "text:p" && child.name != "text:h" {
                continue;
            }
            let made = paragraph_to_ooxml(
                ctx,
                &child.range(),
                &ParagraphOoxmlOptions {
                    part: OdtStylePart::StylesXml,
                    owner: Some(PAGE_OWNER.to_owned()),
                    ..Default::default()
                },
            )?;
            paragraphs.push(made.paragraph.id);
            body.push_str(&made.xml);
        }
    }
    if body.is_empty() {
        body = "<w:p/>".to_owned();
    }
    let file = format!("{}{n}.xml", kind.as_str());
    let root = if kind == HfKindName::Header {
        "w:hdr"
    } else {
        "w:ftr"
    };
    let ns: Vec<&str> = BRIDGE_DOCUMENT_NAMESPACES
        .iter()
        .copied()
        .chain(ctx.docx.namespaces.iter().map(String::as_str))
        .collect();
    let xml = format!("{XML_DECL}<{root} {}>{body}</{root}>", ns.join(" "));
    let r_id = ctx.add_relationship(&format!("{REL_BASE}/{}", kind.as_str()), &file, false);
    ctx.docx.parts.push(DocxExtraPart {
        path: format!("word/{file}"),
        data: DocxPartData::Text(xml.clone()),
        content_type: Some(format!("{CT_BASE}.{}+xml", kind.as_str())),
    });
    // relationships the part's content uses (links, pictures) must be its own
    let mut used: HashSet<String> = HashSet::new();
    for m in js_regex!(r#"\br:(?:id|embed|link)="([^"]+)""#).find_iter(&body) {
        if let Some(id) = m.get(1) {
            used.insert(id.to_owned());
        }
    }
    let rels: Vec<_> = ctx
        .docx
        .relationships
        .iter()
        .filter(|r| used.contains(&r.id))
        .collect();
    if !rels.is_empty() {
        let data = format!(
            "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{}</Relationships>",
            rels.iter()
                .map(|r| format!(
                    "<Relationship Id=\"{}\" Type=\"{}\" Target=\"{}\"{}/>",
                    escape_xml_attr(&r.id),
                    escape_xml_attr(&r.r#type),
                    escape_xml_attr(&r.target),
                    if r.external {
                        " TargetMode=\"External\""
                    } else {
                        ""
                    }
                ))
                .collect::<String>()
        );
        ctx.docx.parts.push(DocxExtraPart {
            path: format!("word/_rels/{file}.rels"),
            data: DocxPartData::Text(data),
            content_type: None,
        });
    }
    Ok(PageHfPart {
        r_id,
        path: format!("word/{file}"),
        kind,
        master: master.map(|m| m.name.clone()).unwrap_or_default(),
        region,
        fill,
        paragraphs,
        xml,
    })
}

/// `addSettings`: settings.xml with `w:evenAndOddHeaders` (the bridge docx has
/// no settings part otherwise).
fn add_settings(ctx: &mut OdfToOoxmlContext) {
    ctx.add_relationship(&format!("{REL_BASE}/settings"), "settings.xml", false);
    ctx.docx.parts.push(DocxExtraPart {
        path: "word/settings.xml".to_owned(),
        data: DocxPartData::Text(format!(
            "{XML_DECL}<w:settings xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:evenAndOddHeaders/></w:settings>"
        )),
        content_type: Some(format!("{CT_BASE}.settings+xml")),
    });
}
