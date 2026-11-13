//! Whole header/footer parts: the display content of a part and the parts a
//! document's sections and relationships point at.

use std::rc::Rc;

use jscompat::{JsMap, JsObject, js_regex};
use ooxml_pkg::Package;

use super::hf::{bind_hf_image_anchors, strip_hf_deletions};
use super::hf_fields::{
    PAGE_MARK, SECTION_PAGES_MARK, TOTAL_PAGES_MARK, parse_field_tree, render_field,
};
use super::hf_images::{hf_images, hf_table_media};
use super::hf_paras::hf_paragraphs;
use crate::model::{HfImage, HfParagraph, HfPartInfo, PictureWatermarkInfo, SharedStr};
use crate::package::{RelInfo, Thrown, canonical_part_text, resolve_relationship_target_path};
use crate::parse::drawings::host::MediaEnv;
use crate::parse::text::bridge;
use crate::resolve::ResolveCtx;
use crate::section::{HfKind, hf_reference_r_id, hf_reference_tags, hf_reference_type};
use crate::watermark::{read_picture_watermark, read_watermark_text};
use crate::xml_tag::remove_segments;
use crate::xml_text::plain_text;

/// What `hfContentFromXml` returns, with the module-level weak maps the
/// TypeScript keeps beside its paragraphs.
#[derive(Debug)]
pub struct HfContent {
    pub text: String,
    pub has_page_number: bool,
    pub watermark: Option<String>,
    pub watermark_picture: Option<PictureWatermarkInfo>,
    pub paras: Vec<HfParagraph>,
    row_anchor_ids: Vec<Option<Vec<String>>>,
    run_image_ids: std::collections::HashSet<String>,
}

/// What `readHeaderFooterPart` returns.
#[derive(Debug)]
pub struct HfPart {
    pub text: String,
    pub has_page_number: bool,
    pub watermark: Option<String>,
    pub watermark_picture: Option<PictureWatermarkInfo>,
    pub paras: Vec<HfParagraph>,
    pub images: Option<Vec<HfImage>>,
}

/// `hfContentFromXml`: header/footer part XML to its display content (PAGE
/// fields shown as `PAGE_MARK`). `resolver` is the document's, which holds the
/// styles, theme and compat the TypeScript passes beside it.
pub fn hf_content_from_xml(
    xml: &str,
    kind: HfKind,
    zip: &Package,
    resolver: &Rc<ResolveCtx>,
    table_media: Option<&JsMap<SharedStr>>,
    compatibility_mode: f64,
    media: &MediaEnv<'_>,
) -> Result<HfContent, Thrown> {
    // Rewrite each field span (begin..end) for display. PAGE and NUMPAGES become
    // private-use markers (the renderer substitutes real numbers; a literal '#'
    // in the part text must never be mistaken for the field), dropping their
    // stale cached results; other fields (DATE, STYLEREF, ...) keep their cached
    // result runs (Word refreshes them on open). fldChar attribute matching is
    // tolerant (Pages writes w:fldLock="0" etc.; LibreOffice writes the begin
    // marker as an empty element pair, not self-closing).
    // hasPageNumber is set by the same match that emits PAGE_MARK, so the two
    // can't drift (Word may split "PAGE" across several instrText runs).
    let mut has_page_number = false;
    // mc:AlternateContent carries the same textbox twice (DrawingML Choice + VML
    // Fallback); keeping both prints the content twice (e.g. duplicated "— PAGE —"
    // page numbers), so only the Choice branch feeds text/paragraph extraction
    let mut cleaned = remove_segments(xml, "mc:Fallback").into_owned();
    // rewrite the complex fields by nesting depth: a child's end must not close
    // its parent (genoffice#2458: the lazy begin-to-end span stopped at the
    // nested end and took the child's separate/cache for the parent's)
    if cleaned.contains("<w:fldChar") {
        let mut page = false;
        let tree = parse_field_tree(&cleaned);
        let mut out = String::new();
        let mut pos = 0;
        for &root in &tree.roots {
            let field = &tree.frames[root];
            if field.end < 0 {
                continue;
            }
            out.push_str(&cleaned[pos..field.start]);
            out.push_str(&render_field(&cleaned, field, &tree, &mut page, 0)?);
            pos = field.end as usize;
        }
        out.push_str(&cleaned[pos..]);
        cleaned = out;
        has_page_number = page;
    }
    // <w:fldSimple w:instr=" PAGE "> single-element field form
    cleaned = js_regex!(
        r#"<w:fldSimple[^>]*w:instr\s*=\s*["']([^"']*)["'][^>]*(?:\/>|>([\s\S]*?)<\/w:fldSimple>)"#,
        "g"
    )
    .replace_all(&cleaned, |found| {
        let instr = found.get(1).unwrap_or("");
        let inner = found.get(2);
        let r_pr = match inner.filter(|inner| !inner.is_empty()) {
            Some(inner) => js_regex!(r"<w:rPr>[\s\S]*?<\/w:rPr>")
                .exec(inner)
                .map_or("", |found| found.as_str()),
            None => "",
        };
        if js_regex!(r"^\s*SECTIONPAGES\b").test(instr) {
            return format!("<w:r>{r_pr}<w:t>{SECTION_PAGES_MARK}</w:t></w:r>");
        }
        if js_regex!(r"^\s*NUMPAGES\b").test(instr) {
            return format!("<w:r>{r_pr}<w:t>{TOTAL_PAGES_MARK}</w:t></w:r>");
        }
        if js_regex!(r"^\s*PAGE\b").test(instr) {
            has_page_number = true;
            return format!("<w:r>{r_pr}<w:t>{PAGE_MARK}</w:t></w:r>");
        }
        inner.unwrap_or(found.as_str()).to_owned()
    });
    // legacy <w:pgNum/> run element (pre-field page number) renders as a PAGE field
    cleaned = js_regex!(r"<w:pgNum\s*\/>", "g").replace_all(&cleaned, |_| {
        has_page_number = true;
        format!("<w:t>{PAGE_MARK}</w:t>")
    });
    let text = plain_text(&cleaned);
    let header = kind == HfKind::Header;
    let watermark = if header {
        read_watermark_text(xml)
    } else {
        None
    };
    let watermark_picture = match header.then(|| read_picture_watermark(xml)).flatten() {
        Some(picture) => Some(bridge::<_, PictureWatermarkInfo>(&picture)?),
        None => None,
    };
    // strip leftover field chars so the page marker parses as plain text
    let stripped = js_regex!(r"<w:fldChar[^>]*?(?:\/>|>\s*<\/w:fldChar>)", "g")
        .replace_all(&cleaned, |_| String::new());
    let list = hf_paragraphs(
        &stripped,
        zip,
        resolver,
        table_media,
        compatibility_mode,
        media,
    )?;
    Ok(HfContent {
        text,
        has_page_number,
        watermark,
        watermark_picture,
        paras: list.paras,
        row_anchor_ids: list.row_anchor_ids,
        run_image_ids: list.run_image_ids,
    })
}

/// The images of a part, bound to the rows holding their anchors:
/// `bindHfImageAnchors(await hfImages(zip, path, xml, content.paras), content.paras)`.
fn bound_images(
    zip: &Package,
    path: &str,
    xml: &str,
    content: &HfContent,
    media: &MediaEnv<'_>,
) -> Result<Vec<HfImage>, Thrown> {
    let found = hf_images(zip, path, xml, Some(&content.run_image_ids), media)?;
    let mut images = found.images;
    bind_hf_image_anchors(
        &mut images,
        &found.image_anchor_ids,
        &content.row_anchor_ids,
    );
    Ok(images)
}

/// `readHeaderFooterPart`: the content of the header/footer part a `sectPr`
/// references (`hf_type` is `default`, `first` or `even`); `None` where there
/// is no such reference or part.
#[allow(clippy::too_many_arguments)]
pub fn read_header_footer_part(
    zip: &Package,
    document_xml: &str,
    rels: &JsMap<RelInfo>,
    kind: HfKind,
    hf_type: &str,
    resolver: &Rc<ResolveCtx>,
    compatibility_mode: f64,
    source_path: &str,
    media: &MediaEnv<'_>,
) -> Result<Option<HfPart>, Thrown> {
    let refs = hf_reference_tags(document_xml, kind);
    let typed = refs
        .iter()
        .find(|r| hf_reference_type(r) == Some(hf_type))
        .copied();
    // untyped references count as default (w:type is technically required but often
    // omitted); non-schema w:type="odd" is Word's default (odd-page) part too
    let reference = if hf_type == "default" {
        typed
            .or_else(|| {
                refs.iter()
                    .find(|r| hf_reference_type(r) == Some("odd"))
                    .copied()
            })
            .or_else(|| {
                refs.iter()
                    .find(|r| hf_reference_type(r).is_none())
                    .copied()
            })
    } else {
        typed
    };
    let Some(reference) = reference else {
        return Ok(None);
    };
    let target = hf_reference_r_id(reference)
        .and_then(|r_id| rels.get(r_id))
        .map(|rel| rel.target.as_str())
        .filter(|target| !target.is_empty());
    let Some(target) = target else {
        return Ok(None);
    };
    let Some(path) = resolve_relationship_target_path(source_path, target) else {
        return Ok(None);
    };
    let Some(text) = canonical_part_text(zip, &path)? else {
        return Ok(None);
    };
    let xml = strip_hf_deletions(&text).map_err(|limit| limit.to_string())?;
    let table_media = hf_table_media(zip, &path, &xml, media)?;
    let content = hf_content_from_xml(
        &xml,
        kind,
        zip,
        resolver,
        table_media.as_ref(),
        compatibility_mode,
        media,
    )?;
    let images = bound_images(zip, &path, &xml, &content, media)?;
    Ok(Some(HfPart {
        text: content.text,
        has_page_number: content.has_page_number,
        watermark: content.watermark,
        watermark_picture: content.watermark_picture,
        paras: content.paras,
        images: (!images.is_empty()).then_some(images),
    }))
}

/// `parseAllHfParts`: all header/footer parts by rId (multi-section documents
/// look them up via each section's sectPr refs).
pub fn parse_all_hf_parts(
    zip: &Package,
    rels: &JsMap<RelInfo>,
    resolver: &Rc<ResolveCtx>,
    compatibility_mode: f64,
    source_path: &str,
    media: &MediaEnv<'_>,
) -> Result<JsObject<HfPartInfo>, Thrown> {
    let mut out: JsObject<HfPartInfo> = JsObject::new();
    for (r_id, rel) in rels.iter() {
        let kind = if rel.rel_type.ends_with("/header") {
            HfKind::Header
        } else if rel.rel_type.ends_with("/footer") {
            HfKind::Footer
        } else {
            continue;
        };
        let Some(path) = resolve_relationship_target_path(source_path, &rel.target) else {
            continue;
        };
        let Some(text) = canonical_part_text(zip, &path)? else {
            continue;
        };
        let xml = strip_hf_deletions(&text).map_err(|limit| limit.to_string())?;
        let table_media = hf_table_media(zip, &path, &xml, media)?;
        let content = hf_content_from_xml(
            &xml,
            kind,
            zip,
            resolver,
            table_media.as_ref(),
            compatibility_mode,
            media,
        )?;
        let images = bound_images(zip, &path, &xml, &content, media)?;
        out.set(
            r_id,
            HfPartInfo {
                text: content.text,
                has_page_number: content.has_page_number,
                paras: content.paras,
                images: (!images.is_empty()).then_some(images),
            },
        );
    }
    Ok(out)
}
