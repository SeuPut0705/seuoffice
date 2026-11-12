//! The state of one `saveDocx` call and what the phases share: the new
//! relationships, the media parts, the id counters and the offsets of the
//! original body.

use std::collections::HashMap;

use jscompat::{JsNum, number_to_string};
use ooxml_pkg::Package;

use super::external::{
    CHART_WORKBOOK_REL_TYPE, StyleUpsert, build_chart_part_xml, build_chart_workbook_xlsx_base64,
};
use super::helpers::{BookmarkIds, DOCPR_ID_BASE, RevisionIds, usable_new_image};
use super::js::{dynamic, limit};
use super::types::{SaveBlock, SaveOptions};
use super::xml_number_usable::{EMU_PER_PX, usable_picture_size, usable_position_offset};
use crate::generate::drawing_build::{
    DocPrId, InlinePictureXmlOptions, NEW_PICTURE_TOKEN_PREFIX, inline_picture_drawing_xml,
};
use crate::generate::drawing_patch::{MarginAlign, PosOffset, apply_image_wrap};
use crate::ink::{INK_MEDIA_PREFIX, anchored_ink_run_xml};
use crate::inline_opaque::ContentControlPart;
use crate::model::{MapEntries, NewChart, NewImage, NewImageMime, NewInkImage, ParsedDocFull};
use crate::xml_number::xml_positive_coordinate;

pub const HYPERLINK_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
pub const IMAGE_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
pub const CHART_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
pub const NUMBERING_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering";
pub const COMMENTS_EXT_REL_TYPE: &str =
    "http://schemas.microsoft.com/office/2011/relationships/commentsExtended";
pub const COMMENTS_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
pub const SETTINGS_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings";
pub const HEADER_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header";
pub const FOOTER_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer";
pub const CHART_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
pub const XLSX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/// An empty relationships part, with the declaration's line ending as the call site writes it.
pub const EMPTY_RELS_LF: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>";
pub const EMPTY_RELS_NONE: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>";

/// `IMAGE_EXT`
pub fn image_ext(mime: NewImageMime) -> &'static str {
    match mime {
        NewImageMime::ImagePng => "png",
        NewImageMime::ImageJpeg => "jpg",
        NewImageMime::ImageGif => "gif",
    }
}

/// A relationship the save adds to the document's rels part.
pub struct NewRel {
    pub r_id: String,
    pub ty: String,
    pub target: String,
    pub external: bool,
}

/// An embedded chart workbook with the rels part of its chart.
pub struct ChartWorkbook {
    pub xlsx_path: String,
    pub rels_path: String,
    pub rels_xml: String,
    pub base64: String,
}

/// `{ base64, mime, sourcePart? }`: what `landMedia` takes.
pub struct MediaSource<'a> {
    pub base64: &'a str,
    pub mime: NewImageMime,
    pub source_part: Option<&'a str>,
}

impl<'a> MediaSource<'a> {
    pub fn of_image(image: &'a NewImage) -> Self {
        Self {
            base64: &image.base64,
            mime: image.mime,
            source_part: image.source_part.as_deref(),
        }
    }
}

/// A UTF-16 offset of the original body as a byte offset.
pub struct Utf16Index {
    /// `bytes[i]`: byte offset of UTF-16 unit `i`; absent for an ASCII text
    bytes: Option<Vec<usize>>,
    len: usize,
}

impl Utf16Index {
    pub fn new(text: &str) -> Self {
        if text.is_ascii() {
            return Self {
                bytes: None,
                len: text.len(),
            };
        }
        let mut bytes = Vec::with_capacity(text.len() + 1);
        for (at, ch) in text.char_indices() {
            for _ in 0..ch.len_utf16() {
                bytes.push(at);
            }
        }
        let len = bytes.len();
        bytes.push(text.len());
        Self {
            bytes: Some(bytes),
            len,
        }
    }

    /// The byte offset of the unit offset `unit`, as `slice` clamps it.
    pub fn byte(&self, unit: f64) -> usize {
        let unit = if unit.is_nan() { 0.0 } else { unit.trunc() };
        let at = if unit < 0.0 {
            (self.len as f64 + unit).max(0.0)
        } else {
            unit.min(self.len as f64)
        } as usize;
        match &self.bytes {
            None => at,
            Some(bytes) => bytes[at],
        }
    }
}

/// `documentXml.slice(start, end)` over UTF-16 offsets.
pub fn slice16<'t>(text: &'t str, index: &Utf16Index, start: f64, end: f64) -> &'t str {
    let (from, to) = (index.byte(start), index.byte(end));
    if to <= from { "" } else { &text[from..to] }
}

pub struct Saver<'a> {
    pub parsed: &'a ParsedDocFull,
    pub blocks: &'a [SaveBlock],
    pub options: &'a SaveOptions,
    pub now_ms: f64,
    /// the original package, read only
    pub zip: Package,
    pub doc_path: String,
    pub document_xml: &'a str,
    pub index: Utf16Index,
    pub custom_properties_xml: Option<String>,
    pub custom_properties_is_new: bool,
    pub root_rels_xml: Option<String>,
    pub rels_path: String,
    pub rels_present: bool,
    pub rels_xml: String,
    pub new_rels: Vec<NewRel>,
    pub next_rel_num: f64,
    pub heading_style_ids: MapEntries<JsNum, String>,
    pub style_upserts: Vec<StyleUpsert>,
    pub body_controls: ContentControlPart,
    pub bookmark_ids: BookmarkIds,
    pub revision_ids: RevisionIds,
    pub new_media: Vec<(String, String)>,
    pub used_extensions: Vec<String>,
    pub media_rel_by_content: HashMap<String, String>,
    pub media_path_by_content: HashMap<String, String>,
    pub image_seq: f64,
    pub doc_pr_seq: f64,
    pub new_picture_doc_pr_ids: HashMap<String, f64>,
    pub new_chart_parts: Vec<(String, String)>,
    pub new_chart_workbooks: Vec<ChartWorkbook>,
    pub inks_by_block: HashMap<String, Vec<NewInkImage>>,
    pub ink_seq: f64,
    pub out: Outputs,
}

/// A part the save rewrites or adds, with whether the package had it.
pub struct PartOut {
    pub path: String,
    pub xml: String,
    pub is_new: bool,
}

/// What the phases produce for the final assembly.
#[derive(Default)]
pub struct Outputs {
    /// the trailing sectPr's original XML
    pub trailing_sect_pr: String,
    pub rel_targets: HashMap<String, String>,
    pub hf_parts: Vec<(String, String)>,
    pub hf_ref_tags: Vec<String>,
    pub hf_overrides: Vec<String>,
    /// header-part rels rewritten for a picture watermark (path -> xml), in the order set
    pub hf_rels_out: Vec<(String, String)>,
    /// new per-section header/footer reference tags by the section's docxIndex
    pub section_ref_tags: Vec<(f64, Vec<String>)>,
    pub numbering_xml_out: Option<String>,
    pub numbering_is_new: bool,
    pub numbering_rels_out: Option<PartOut>,
    pub styles_xml_out: Option<String>,
    pub comments_xml: Option<String>,
    pub comments_is_new: bool,
    pub comments_rels_xml: Option<String>,
    pub comments_rels_is_new: bool,
    pub comments_ext_xml: Option<String>,
    pub comments_ext_is_new: bool,
    pub notes_parts: Vec<(PartOut, crate::notes::NoteKind)>,
    pub sources_part: Option<SourcesPart>,
    pub theme_part: Option<(String, bool)>,
}

pub struct SourcesPart {
    pub path: String,
    pub props_path: String,
    pub xml: String,
    pub is_new: bool,
}

impl Saver<'_> {
    /// `embedImageMedia` of the allocator: a fresh `rIdN` for the document.
    pub fn next_rel_id(&mut self) -> String {
        let id = format!("rId{}", number_to_string(self.next_rel_num));
        self.next_rel_num += 1.0;
        id
    }

    pub fn push_rel(&mut self, r_id: String, ty: &str, target: String) {
        self.new_rels.push(NewRel {
            r_id,
            ty: ty.to_owned(),
            target,
            external: false,
        });
    }

    pub fn note_extension(&mut self, ext: &str) {
        if !self.used_extensions.iter().any(|have| have == ext) {
            self.used_extensions.push(ext.to_owned());
        }
    }

    /// `docPrId` minted per call: `DOCPR_ID_BASE + ++docPrSeq`.
    pub fn next_doc_pr_id(&mut self) -> f64 {
        self.doc_pr_seq += 1.0;
        DOCPR_ID_BASE + self.doc_pr_seq
    }

    /// `landMedia`: land image bytes as a media part (no relationship);
    /// identical bytes share one part.
    pub fn land_media(&mut self, image: &MediaSource<'_>) -> String {
        if let Some(source) = image.source_part.filter(|part| !part.is_empty()) {
            return source.to_owned();
        }
        let content_key = format!("{}:{}", image.mime.as_str(), image.base64);
        if let Some(path) = self.media_path_by_content.get(&content_key) {
            return path.clone();
        }
        let ext = image_ext(image.mime);
        let path = format!(
            "word/media/aidocs{}.{ext}",
            number_to_string(self.image_seq)
        );
        self.image_seq += 1.0;
        self.new_media.push((path.clone(), image.base64.to_owned()));
        self.note_extension(ext);
        self.media_path_by_content.insert(content_key, path.clone());
        path
    }

    /// `embedImageMedia`: land image bytes as a media part plus a document
    /// relationship; returns the rId. Identical bytes reuse one part.
    pub fn embed_image_media(&mut self, image: &MediaSource<'_>) -> String {
        let content_key = match image.source_part.filter(|part| !part.is_empty()) {
            Some(part) => format!("part:{part}"),
            None => format!("{}:{}", image.mime.as_str(), image.base64),
        };
        if let Some(r_id) = self.media_rel_by_content.get(&content_key) {
            return r_id.clone();
        }
        let media_path = self.land_media(image);
        let r_id = self.next_rel_id();
        let target = media_path
            .strip_prefix("word/")
            .unwrap_or(&media_path)
            .to_owned();
        self.push_rel(r_id.clone(), IMAGE_REL_TYPE, target);
        self.media_rel_by_content.insert(content_key, r_id.clone());
        r_id
    }

    /// `embedImage`: a new picture's paragraph.
    pub fn embed_image(&mut self, editor_image: &NewImage) -> Result<String, String> {
        let image = usable_new_image(editor_image);
        let r_id = self.embed_image_media(&MediaSource::of_image(&image));
        // dedup means imageSeq does not advance for repeated bytes: docPr ids have their own counter
        let doc_pr_id = self.next_doc_pr_id();
        let mut spacing_attrs: Vec<String> = Vec::new();
        if let Some(ps) = &image.para_spacing {
            if let Some(before) = ps.before_twips.filter(|n| n.0 != 0.0 && !n.0.is_nan())
                && before.0 > 0.0
            {
                spacing_attrs.push(format!(
                    "w:before=\"{}\"",
                    number_to_string(jscompat::math_round(before.0))
                ));
            }
            if let Some(after) = ps.after_twips
                && after.0 >= 0.0
            {
                spacing_attrs.push(format!(
                    "w:after=\"{}\"",
                    number_to_string(jscompat::math_round(after.0))
                ));
            }
            if let Some(line) = ps.line_twips.filter(|n| n.0 != 0.0 && !n.0.is_nan())
                && let Some(rule) = ps.line_rule
            {
                spacing_attrs.push(format!(
                    "w:line=\"{}\"",
                    number_to_string(jscompat::math_round(line.0))
                ));
                spacing_attrs.push(format!("w:lineRule=\"{}\"", rule.as_str()));
            }
        }
        // schema order inside pPr: w:spacing before w:jc
        let spacing = if spacing_attrs.is_empty() {
            String::new()
        } else {
            format!("<w:spacing {}/>", spacing_attrs.join(" "))
        };
        let jc = match image.align {
            Some(align) if align.as_str() != "left" => {
                format!("<w:jc w:val=\"{}\"/>", align.as_str())
            }
            _ => String::new(),
        };
        let p_pr = if spacing.is_empty() && jc.is_empty() {
            String::new()
        } else {
            format!("<w:pPr>{spacing}{jc}</w:pPr>")
        };
        let drawing = inline_picture_drawing_xml(&InlinePictureXmlOptions {
            r_id,
            doc_pr_id: DocPrId::Number(doc_pr_id),
            width_px: image.width_px.0,
            height_px: image.height_px.0,
            alt_text: image.alt_text.clone(),
            rot_deg: image.rot_deg.map(|n| n.0),
            flip_h: image.flip_h,
            flip_v: image.flip_v,
        })?;
        let xml = format!("<w:p>{p_pr}<w:r>{drawing}</w:r></w:p>");
        // posH/posV are the margin-relative align pair; applyImageWrap prefers posOffset when both are set
        let margin_align = match (&image.pos_offset_emu, image.pos_h, image.pos_v) {
            (None, Some(h), Some(v)) => Some(MarginAlign {
                h: h.as_str().to_owned(),
                v: v.as_str().to_owned(),
            }),
            _ => None,
        };
        let pos_offset = image.pos_offset_emu.as_ref().map(|off| PosOffset {
            x: off.x.0,
            y: off.y.0,
            relative_to: off.relative_to.map(|rel| rel.as_str().to_owned()),
        });
        Ok(match image.wrap {
            Some(wrap) => apply_image_wrap(
                &xml,
                Some(wrap),
                pos_offset.as_ref(),
                margin_align.as_ref(),
                image.z_order.map(|n| n.0),
            ),
            None => xml,
        })
    }

    /// `resolveNewPictures`: pictures the editor inserted into existing
    /// paragraphs carry a placeholder token for r:embed and the docPr id;
    /// land their bytes and swap in the real ids.
    pub fn resolve_new_pictures(&mut self, xml: &str) -> Result<String, String> {
        let options = self.options;
        let Some(pictures) = options.new_pictures.as_ref() else {
            return Ok(xml.to_owned());
        };
        if !xml.contains(NEW_PICTURE_TOKEN_PREFIX) {
            return Ok(xml.to_owned());
        }
        let pattern = format!(
            r#"(r:embed|id|name)="(Picture )?({}[0-9]+)""#,
            NEW_PICTURE_TOKEN_PREFIX
        );
        let re = dynamic(&pattern, "g")?;
        re.try_replace_all(xml, |found| {
            let whole = found.as_str();
            let attr = found.get(1).unwrap_or_default();
            let prefix = found.get(2);
            let token = found.get(3).unwrap_or_default();
            let Some(picture) = pictures.get(token) else {
                return whole.to_owned();
            };
            if attr == "r:embed" {
                let r_id = self.embed_image_media(&MediaSource {
                    base64: &picture.base64,
                    mime: picture.mime,
                    source_part: None,
                });
                return format!("r:embed=\"{r_id}\"");
            }
            let id = match self.new_picture_doc_pr_ids.get(token) {
                Some(id) => *id,
                None => {
                    let id = self.next_doc_pr_id();
                    self.new_picture_doc_pr_ids.insert(token.to_owned(), id);
                    id
                }
            };
            format!(
                "{attr}=\"{}{}\"",
                prefix.unwrap_or(""),
                number_to_string(id)
            )
        })
        .map_err(limit)
    }

    /// `embedImages`: the pictures' runs collected into the first picture's holder paragraph.
    pub fn embed_images(&mut self, images: &[NewImage]) -> Result<String, String> {
        let mut paras = Vec::with_capacity(images.len());
        for image in images {
            paras.push(self.embed_image(image)?);
        }
        if paras.len() <= 1 {
            return Ok(paras.into_iter().next().unwrap_or_default());
        }
        let run_of = |para: &str| -> String {
            // slice(indexOf('<w:r>'), lastIndexOf('</w:p>')): a missing marker reads as -1
            let from = para.find("<w:r>");
            let to = para.rfind("</w:p>");
            let len = para.len() as i64;
            let a = from.map_or(len - 1, |at| at as i64).max(0) as usize;
            let b = to.map_or(len - 1, |at| at as i64).max(0) as usize;
            if b <= a {
                String::new()
            } else {
                para[a..b].to_owned()
            }
        };
        let first = &paras[0];
        let cut = first
            .rfind("</w:p>")
            .unwrap_or((first.len() as i64 - 1).max(0) as usize);
        let rest: String = paras[1..].iter().map(|para| run_of(para)).collect();
        Ok(format!("{}{rest}</w:p>", &first[..cut]))
    }

    /// `embedChart`: a new embedded chart: chart part, workbook, relationship and the drawing paragraph.
    pub fn embed_chart(
        &mut self,
        chart: &NewChart,
        extent_px: Option<(f64, f64)>,
    ) -> Result<String, String> {
        let mut n = 1u64;
        loop {
            let path = format!("word/charts/chart{n}.xml");
            if self.zip.file(&path).is_none() && !self.new_chart_parts.iter().any(|p| p.0 == path) {
                break;
            }
            n += 1;
        }
        let path = format!("word/charts/chart{n}.xml");
        let r_id = self.next_rel_id();
        self.push_rel(r_id.clone(), CHART_REL_TYPE, format!("charts/chart{n}.xml"));

        // the embedded workbook and the rels part of the chart
        let wb_base64 = build_chart_workbook_xlsx_base64(chart, self.now_ms)?;
        let xlsx_path = format!("word/charts/embeddings/workbook{n}.xlsx");
        let wb_r_id = "rId1";
        let chart_rels_xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"{wb_r_id}\" Type=\"{CHART_WORKBOOK_REL_TYPE}\" Target=\"embeddings/workbook{n}.xlsx\"/></Relationships>"
        );
        self.new_chart_parts
            .push((path, build_chart_part_xml(chart, wb_r_id)?));
        self.new_chart_workbooks.push(ChartWorkbook {
            xlsx_path,
            rels_path: format!("word/charts/_rels/chart{n}.xml.rels"),
            rels_xml: chart_rels_xml,
            base64: wb_base64,
        });

        let doc_pr_id = number_to_string(self.next_doc_pr_id());
        // a size past the widest extent (or none) takes the default chart size
        let extent = |axis: Option<f64>, fallback: &str| -> String {
            axis.and_then(|px| xml_positive_coordinate(jscompat::math_max(1.0, px * EMU_PER_PX)))
                .filter(|text| !text.is_empty() && text != "0")
                .unwrap_or_else(|| fallback.to_owned())
        };
        let cx = extent(extent_px.map(|e| e.0), "5486400");
        let cy = extent(extent_px.map(|e| e.1), "3200400");
        Ok(format!(
            "<w:p><w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:docPr id=\"{doc_pr_id}\" name=\"Chart {doc_pr_id}\"/><a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/chart\"><c:chart xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\" r:id=\"{r_id}\"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
        ))
    }

    /// `inkRunXml`: media and a relationship for one ink PNG, and its anchored run.
    pub fn ink_run_xml(&mut self, ink: &NewInkImage) -> Result<String, String> {
        let media_path = format!(
            "word/media/{INK_MEDIA_PREFIX}{}.png",
            number_to_string(self.ink_seq)
        );
        self.ink_seq += 1.0;
        let r_id = self.next_rel_id();
        let target = media_path
            .strip_prefix("word/")
            .unwrap_or(&media_path)
            .to_owned();
        self.push_rel(r_id.clone(), IMAGE_REL_TYPE, target);
        self.new_media.push((media_path, ink.base64.clone()));
        self.note_extension("png");
        let (width, height) = usable_picture_size(ink.width_px.0, ink.height_px.0);
        let mut usable = ink.clone();
        usable.width_px = JsNum(width);
        usable.height_px = JsNum(height);
        usable.offset_x_px =
            JsNum(usable_position_offset(ink.offset_x_px.0, EMU_PER_PX).unwrap_or(0.0));
        usable.offset_y_px =
            JsNum(usable_position_offset(ink.offset_y_px.0, EMU_PER_PX).unwrap_or(0.0));
        anchored_ink_run_xml(&usable, &r_id, JsNum(9000.0 + self.ink_seq))
    }

    /// `allocateHyperlinkRel`
    pub fn allocate_hyperlink_rel(&mut self, href: &str) -> String {
        if let Some(existing) = self
            .new_rels
            .iter()
            .find(|r| r.external && r.target == href)
        {
            return existing.r_id.clone();
        }
        let r_id = self.next_rel_id();
        self.new_rels.push(NewRel {
            r_id: r_id.clone(),
            ty: HYPERLINK_REL_TYPE.to_owned(),
            target: href.to_owned(),
            external: true,
        });
        r_id
    }
}
