//! `assemble/export/blocks.ts`: the body of a docx as the ODF writers take it:
//! one `EditedItem` per body element, with everything an ODT cannot hold
//! already turned into what it becomes.
//!
//! - Tracked changes: deleted text and blocks go, inserted text stays (the
//!   final text). Comments are left out.
//! - Character styles are folded into their runs (ODF runs get their own
//!   automatic styles; the docx character style has no ODF counterpart here).
//! - Charts, equations, shapes and text boxes become picture runs (rendered,
//!   fallback picture, or a label box); horizontal rules a thin picture.
//! - Fields shown as protected paragraphs (table of contents lines, other
//!   field results) become plain paragraphs; locked paragraphs the editor
//!   cannot read are rebuilt from their text runs and objects.
//! - A paragraph's section break (`w:sectPr`) is removed; sections are
//!   handled by the page writer.
//!
//! The TypeScript is async only for reading package media; here the media
//! reader is a plain function.

use std::cell::RefCell;

use docx_engine::model::{
    Block, BlockBlockRevisionKind, BlockImageAlign, BlockType, FieldDisplayKind, ParaAlign,
    ParaFormat, ParsedDoc, Run, RunCaps, StyleDisplayCaps, TabStop, TabStopLeader, TabStopVal,
    TableModel, TableParagraph,
};
use jscompat::{JsNum, Radix, js_regex, number_to_string, parse_int, replace_first};

use super::objects::{
    ExportObjectKind, ObjectClass, RenderedObject, classify_object, default_size,
    fallback_picture_r_id, label_run, object_size, picture_run, solid_png,
};
use super::rows::with_row_floors;
use super::theme::style_of;
use crate::assemble::report::{ReportBuilder, ReportFeature, ReportKind};
use crate::core::convert::EditedItem;
use crate::core::xml::{
    CloseVerdict, ElementFrame, ElementVisitor, OpenVerdict, PrefixMap, decode_xml_entities,
    walk_elements,
};
use crate::page::sectpr::strip_paragraph_sect_pr;
use crate::text::styles::{read_ooxml_p_pr, read_ooxml_r_pr};

/// `MediaReader`: reads package bytes of a document relationship (`None` when
/// missing).
pub type MediaReader<'a> = Box<dyn Fn(&str) -> Option<Vec<u8>> + 'a>;

/// Looks up a rendered object by key.
pub type RenderedLookup<'a> = Box<dyn Fn(&str) -> Option<&'a RenderedObject> + 'a>;

/// `NormaliseEnv`
pub struct NormaliseEnv<'a> {
    pub parsed: &'a ParsedDoc,
    pub media: MediaReader<'a>,
    pub rendered: RenderedLookup<'a>,
    /// shared with the caller, which adds to it between the normaliser's calls
    pub report: &'a RefCell<ReportBuilder>,
}

/// A page break as the docx engine reads it in run text.
const FF: char = '\u{c}';

/// `anonymous`: a drawing without the bridge's identity names (`odt-pic:`,
/// `odt-keep:`): in a new document every picture is new content.
fn anonymous(drawing: Option<&str>) -> Option<String> {
    drawing.map(|drawing| {
        replace_first(
            js_regex!(r#"(<wp:docPr\b[^>]*\bname=")odt-[^"]*""#),
            1,
            drawing,
            "$1docx-picture\"",
        )
    })
}

/// `ObjectKeys`: objects of one body element are numbered in document order:
/// `<docxIndex>:<n>`.
pub struct ObjectKeys {
    n: usize,
    index: Option<f64>,
}

impl ObjectKeys {
    pub fn new(index: Option<f64>) -> Self {
        Self { n: 0, index }
    }

    /// `ObjectKeys.next`
    pub fn next_key(&mut self) -> String {
        let key = format!(
            "{}:{}",
            number_to_string(self.index.unwrap_or(-1.0)),
            self.n
        );
        self.n += 1;
        key
    }
}

/// `b.originalXml ?? ''`
fn original_xml(b: &Block) -> &str {
    b.original_xml
        .as_ref()
        .and_then(|xml| xml.as_deref())
        .unwrap_or("")
}

/// `b.docxIndex` as `number | undefined` (`null` and `undefined` alike).
fn docx_index(b: &Block) -> Option<f64> {
    (*b.docx_index).flatten().map(|n| n.0)
}

/// The leading `<w:pPr>` of a paragraph's XML, or `''`.
fn leading_p_pr(xml: &str) -> &str {
    js_regex!(r"^<w:p\b[^>]*>\s*(<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>)")
        .exec(xml)
        .and_then(|m| m.get(1))
        .unwrap_or("")
}

/// The `w:pStyle` value of a `w:pPr`.
fn p_style_of(p_pr: &str) -> Option<&str> {
    js_regex!(r#"<w:pStyle\s+w:val="([^"]*)""#)
        .exec(p_pr)
        .and_then(|m| m.get(1))
}

/// `{ ...block, type: 'paragraph', runs: [], table: undefined, format: { pageBreakBefore: true },
/// rawPPr: undefined, originalXml: '' }`
fn page_break_paragraph(block: &Block) -> Block {
    let mut out = block.clone();
    out.r#type.set(BlockType::Paragraph);
    out.runs.set(Vec::new());
    out.table.assign(None);
    let mut format = ParaFormat::default();
    format.page_break_before.set(true);
    out.format.set(format);
    out.raw_p_pr.assign(None);
    out.original_xml.set(Some(String::new()));
    out
}

/// A piece of a rebuilt paragraph.
enum Piece {
    Text(Box<Run>),
    Object(String),
}

/// The outer walk of `rebuilt`.
struct PieceCollector<'a> {
    xml: &'a str,
    pieces: Vec<Piece>,
}

impl ElementVisitor for PieceCollector<'_> {
    type Data = bool;

    fn open(
        &mut self,
        el: &mut ElementFrame<bool>,
        parent: Option<&ElementFrame<bool>>,
    ) -> OpenVerdict {
        if parent.is_none() {
            return OpenVerdict::Continue;
        }
        if el.name == "w:pPr" || el.name == "w:del" || el.name == "w:moveFrom" {
            return OpenVerdict::Skip;
        }
        if el.name == "m:oMathPara" || el.name == "m:oMath" || el.name == "w:r" {
            el.data = Some(true);
            return OpenVerdict::Skip;
        }
        OpenVerdict::Continue
    }

    fn close(
        &mut self,
        el: &mut ElementFrame<bool>,
        _parent: Option<&ElementFrame<bool>>,
    ) -> CloseVerdict {
        if el.data != Some(true) {
            return CloseVerdict::Continue;
        }
        let range = el.range();
        let fragment = &self.xml[range.start..range.end];
        if el.name != "w:r"
            || js_regex!(r"<w:drawing\b|<w:pict\b|<mc:AlternateContent\b|<w:object\b")
                .test(fragment)
        {
            self.pieces.push(Piece::Object(fragment.to_owned()));
            return CloseVerdict::Continue;
        }
        let mut inner = RunText {
            fragment,
            text: String::new(),
        };
        walk_elements(fragment, &PrefixMap::new(), &mut inner, 0, fragment.len());
        let text = inner.text;
        if text.is_empty() {
            return CloseVerdict::Continue;
        }
        let r_pr = js_regex!(r"<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>")
            .exec(fragment)
            .map_or("", |m| m.as_str());
        let r_style = js_regex!(r#"<w:rStyle\s+w:val="([^"]*)""#)
            .exec(r_pr)
            .and_then(|m| m.get(1));
        let mut run = Run::default();
        run.text.set(text);
        run.assign(&read_ooxml_r_pr(r_pr));
        if let Some(style) = r_style.filter(|style| !style.is_empty()) {
            run.style_id.set(style.to_owned());
        }
        self.pieces.push(Piece::Text(Box::new(run)));
        CloseVerdict::Continue
    }
}

/// The inner walk of `rebuilt`: the text of one `w:r`.
struct RunText<'a> {
    fragment: &'a str,
    text: String,
}

impl ElementVisitor for RunText<'_> {
    type Data = bool;

    fn open(
        &mut self,
        inner: &mut ElementFrame<bool>,
        _parent: Option<&ElementFrame<bool>>,
    ) -> OpenVerdict {
        if inner.name == "w:t" {
            inner.data = Some(true);
            return OpenVerdict::Skip;
        }
        if inner.name == "w:tab" {
            self.text.push('\t');
        } else if inner.name == "w:br" || inner.name == "w:cr" {
            let tag = &self.fragment[inner.start..inner.open_end];
            self.text.push(if js_regex!(r#"w:type="page""#).test(tag) {
                '\u{c}'
            } else {
                '\n'
            });
        } else if inner.name == "w:noBreakHyphen" {
            self.text.push('\u{2011}');
        }
        if inner.name == "w:rPr" || inner.name == "w:instrText" || inner.name == "w:delText" {
            return OpenVerdict::Skip;
        }
        OpenVerdict::Continue
    }

    fn close(
        &mut self,
        inner: &mut ElementFrame<bool>,
        _parent: Option<&ElementFrame<bool>>,
    ) -> CloseVerdict {
        if inner.data == Some(true) && !inner.self_closing {
            let range = inner.range();
            self.text.push_str(&decode_xml_entities(
                &self.fragment[range.open_end..range.close_start],
            ));
        }
        CloseVerdict::Continue
    }
}

/// `BlockNormaliser`
pub struct BlockNormaliser<'a> {
    env: NormaliseEnv<'a>,
    pub revisions: usize,
    /// a page break (`\f`) seen at the end of the previous element, for the next one
    pending_break: bool,
    /// the last element written (its index and its first block)
    last: Option<(i64, Block)>,
}

impl<'a> BlockNormaliser<'a> {
    pub fn new(env: NormaliseEnv<'a>) -> Self {
        Self {
            env,
            revisions: 0,
            pending_break: false,
            last: None,
        }
    }

    fn report(&self, feature: ReportFeature) {
        self.env
            .report
            .borrow_mut()
            .add(ReportKind::Converted, feature, 1);
    }

    /// `styled`: a run with its character style folded in.
    fn styled(&self, run: &Run) -> Run {
        let Some(style_id) = run.style_id.as_deref().filter(|id| !id.is_empty()) else {
            return run.clone();
        };
        let Some(display) = style_of(self.env.parsed, style_id).and_then(|s| s.display.as_ref())
        else {
            return run.clone();
        };
        let mut out = run.clone();
        // `target[key] === undefined && source[key] !== undefined && source[key] !== 'auto'`
        if out.bold.is_none()
            && let Some(v) = *display.bold
        {
            out.bold.set(v);
        }
        if out.italic.is_none()
            && let Some(v) = *display.italic
        {
            out.italic.set(v);
        }
        if out.underline.is_none()
            && let Some(v) = *display.underline
        {
            out.underline.set(v);
        }
        if out.strike.is_none()
            && let Some(v) = *display.strike
        {
            out.strike.set(v);
        }
        if out.color.is_none()
            && let Some(v) = display.color.as_deref().filter(|v| *v != "auto")
        {
            out.color.set(v.to_owned());
        }
        if out.size_half_points.is_none()
            && let Some(v) = *display.size_half_points
        {
            out.size_half_points.set(v);
        }
        if out.font.is_none()
            && let Some(v) = display.font.as_deref().filter(|v| *v != "auto")
        {
            out.font.set(v.to_owned());
        }
        if out.font_ascii.is_none()
            && let Some(v) = display.font_ascii.as_deref().filter(|v| *v != "auto")
        {
            out.font_ascii.set(v.to_owned());
        }
        if out.east_asia_font.is_none()
            && let Some(v) = display.east_asia_font.as_deref().filter(|v| *v != "auto")
        {
            out.east_asia_font.set(v.to_owned());
        }
        if out.char_spacing_twips.is_none()
            && let Some(v) = *display.char_spacing_twips
        {
            out.char_spacing_twips.set(v);
        }
        if out.caps.is_none()
            && let Some(v) = (*display.caps).as_ref().filter(|v| v.as_str() != "auto")
        {
            out.caps.set(match v {
                StyleDisplayCaps::All => RunCaps::All,
                StyleDisplayCaps::Small => RunCaps::Small,
                StyleDisplayCaps::None => RunCaps::None,
                StyleDisplayCaps::Unlisted(s) => RunCaps::Unlisted(s.clone()),
            });
        }
        if out.shading.is_none()
            && let Some(v) = display.shading.as_deref().filter(|v| *v != "auto")
        {
            out.shading.set(v.to_owned());
        }
        if out.font_cs.is_none()
            && let Some(cs) = display.cs_font.as_deref().filter(|cs| !cs.is_empty())
        {
            out.font_cs.set(cs.to_owned());
        }
        out
    }

    /// `objectRun`: the object a fragment becomes: rendered picture, fallback
    /// picture, or a label.
    pub fn object_run(&self, kind: ExportObjectKind, xml: &str, key: &str, text: &str) -> Run {
        self.report(match kind {
            ExportObjectKind::Chart => ReportFeature::Chart,
            ExportObjectKind::Equation => ReportFeature::Equation,
            ExportObjectKind::Shape => ReportFeature::Shape,
            ExportObjectKind::Textbox => ReportFeature::Textbox,
        });
        let stripped = key.strip_suffix(":0").unwrap_or(key);
        let rendered = (self.env.rendered)(key).or_else(|| (self.env.rendered)(stripped));
        let size = object_size(xml).unwrap_or_else(|| default_size(kind, text));
        let name = format!("docx-{}", kind.as_str());
        if let Some(rendered) = rendered {
            return picture_run(
                &rendered.png,
                rendered.width_emu,
                rendered.height_emu,
                &name,
            );
        }
        let bytes = fallback_picture_r_id(xml)
            .filter(|r_id| !r_id.is_empty())
            .and_then(|r_id| (self.env.media)(r_id));
        if let Some(bytes) = bytes.filter(|bytes| !bytes.is_empty()) {
            return picture_run(&bytes, size.cx, size.cy, &name);
        }
        label_run(kind, size.cx, size.cy)
    }

    /// `pictureFromXml`: a picture run read from the package (its
    /// relationship), else from the engine's data URL.
    fn picture_from_xml(&self, xml: &str, data_url: Option<&str>) -> Option<Run> {
        // a bridge docx's locked object (`odt-keep:<id>:<kind>`) is a picture here
        let keep = js_regex!(r#"<wp:docPr\b[^>]*\bname="odt-keep:[^":]*:([a-z]+)""#)
            .exec(xml)
            .and_then(|m| m.get(1));
        match keep {
            Some("chart") => self.report(ReportFeature::Chart),
            Some("equation") => self.report(ReportFeature::Equation),
            Some("shape") => self.report(ReportFeature::Shape),
            Some("textbox") => self.report(ReportFeature::Textbox),
            Some("toc") => self.report(ReportFeature::Toc),
            _ => {}
        }
        let r_id = js_regex!(r#"<a:blip\b[^>]*\br:embed="([^"]+)""#)
            .exec(xml)
            .and_then(|m| m.get(1))
            .or_else(|| {
                js_regex!(r#"<v:imagedata\b[^>]*\br:id="([^"]+)""#)
                    .exec(xml)
                    .and_then(|m| m.get(1))
            });
        let bytes = r_id
            .filter(|r_id| !r_id.is_empty())
            .and_then(|r_id| (self.env.media)(r_id));
        let size = object_size(xml).unwrap_or(super::objects::Size {
            cx: 914400.0,
            cy: 914400.0,
        });
        let drawing_of = || {
            anonymous(
                js_regex!(r"<w:drawing>[\s\S]*?<\/w:drawing>")
                    .exec(xml)
                    .map(|m| m.as_str()),
            )
        };
        if let Some(bytes) = bytes.filter(|bytes| !bytes.is_empty()) {
            // keep the original drawing (anchoring, offsets) when it is one
            let drawing = drawing_of();
            let mut run = picture_run(&bytes, size.cx, size.cy, "docx-picture");
            if let (Some(drawing), Some(image)) =
                (drawing.filter(|d| !d.is_empty()), run.image.as_mut())
            {
                image.xml = drawing;
            }
            return Some(run);
        }
        if let Some(data_url) =
            data_url.filter(|url| !url.is_empty() && js_regex!(r"^data:").test(url))
        {
            let drawing = drawing_of();
            let mut run = Run::default();
            run.text.set(String::new());
            run.image.set(docx_engine::model::RunImage {
                data_url: data_url.into(),
                xml: drawing.unwrap_or_else(|| {
                    format!(
                        "<w:drawing><wp:inline><wp:extent cx=\"{}\" cy=\"{}\"/></wp:inline></w:drawing>",
                        number_to_string(size.cx),
                        number_to_string(size.cy)
                    )
                }),
                ..docx_engine::model::RunImage::default()
            });
            return Some(run);
        }
        None
    }

    /// `runs`: the runs as the ODT writer takes them.
    pub fn runs(&mut self, runs: &[Run], keys: &mut ObjectKeys) -> Vec<Run> {
        let mut out = Vec::new();
        for original in runs {
            if original.del.is_some() {
                self.revisions += 1;
                continue;
            }
            let mut run = original.clone();
            if run.ins.is_some() || run.r_pr_change.is_some() {
                self.revisions += 1;
                run.ins.delete();
                run.r_pr_change.delete();
            }
            let run = self.styled(&run);
            if let Some(math) = run.math.as_ref() {
                out.push(self.object_run(
                    ExportObjectKind::Equation,
                    &math.omml,
                    &keys.next_key(),
                    run.text.as_deref().unwrap_or(""),
                ));
                continue;
            }
            if let Some(image) = run.image.as_ref() {
                if image.rule.is_some() {
                    let cx = js_regex!(r#"\bcx="(\d+)""#)
                        .exec(&image.xml)
                        .and_then(|m| m.get(1))
                        .filter(|cx| !cx.is_empty());
                    out.push(picture_run(
                        &solid_png(128.0, 128.0, 128.0),
                        cx.map_or(5400000.0, |cx| parse_int(cx, Radix::Ten)),
                        12700.0,
                        "docx-rule",
                    ));
                    continue;
                }
                if let Some(ObjectClass::Kind(kind)) = classify_object(&image.xml) {
                    out.push(self.object_run(kind, &image.xml, &keys.next_key(), ""));
                    continue;
                }
                if let Some(picture) = self.picture_from_xml(&image.xml, Some(&image.data_url)) {
                    out.push(picture);
                }
                continue;
            }
            out.push(run);
        }
        out
    }

    /// `paragraph`: a paragraph-like block with its runs normalised.
    fn paragraph(&mut self, b: &Block) -> Block {
        let mut keys = ObjectKeys::new(docx_index(b));
        let source: &[Run] = b.runs.as_deref().unwrap_or_default();
        let runs = self.runs(source, &mut keys);
        if b.p_pr_change_info.is_some() {
            self.revisions += 1;
        }
        let mut out = b.clone();
        out.runs.set(runs);
        out.raw_p_pr.assign(None);
        out.original_xml
            .set(Some(strip_paragraph_sect_pr(original_xml(b))));
        out
    }

    /// `tableModel`
    fn table_model(&mut self, model: &TableModel, keys: &mut ObjectKeys) -> TableModel {
        let mut rows = Vec::with_capacity(model.rows.len());
        for row in &model.rows {
            let mut cells = Vec::with_capacity(row.len());
            for cell in row {
                let mut paras: Vec<TableParagraph> = Vec::new();
                for para in cell.rich_paras.as_deref().unwrap_or_default() {
                    let mut p = para.clone();
                    p.runs = self.runs(&para.runs, keys);
                    paras.push(p);
                }
                let mut nested = Vec::new();
                for t in cell.nested_tables.as_deref().unwrap_or_default() {
                    nested.push(self.table_model(t, keys));
                }
                let mut next = cell.clone();
                if cell.rich_paras.is_some() {
                    next.rich_paras.set(paras);
                }
                if cell.nested_tables.is_some() {
                    next.nested_tables.set(nested);
                }
                cells.push(next);
            }
            rows.push(cells);
        }
        let mut next = model.clone();
        next.rows = rows;
        with_row_floors(&next, self.env.parsed)
    }

    /// `rebuilt`: a protected paragraph rebuilt from its XML: text runs keep
    /// their own formatting, drawings, VML and math become objects or pictures.
    fn rebuilt(&mut self, b: &Block, xml: &str) -> Block {
        let mut keys = ObjectKeys::new(docx_index(b));
        let p_pr = leading_p_pr(xml);
        let style_id = p_style_of(p_pr);
        let mut collector = PieceCollector {
            xml,
            pieces: Vec::new(),
        };
        walk_elements(xml, &PrefixMap::new(), &mut collector, 0, xml.len());
        let mut runs: Vec<Run> = Vec::new();
        for piece in collector.pieces {
            match piece {
                Piece::Text(run) => {
                    runs.extend(self.runs(std::slice::from_ref(&*run), &mut keys));
                }
                Piece::Object(fragment) => match classify_object(&fragment) {
                    Some(ObjectClass::Picture) => {
                        if let Some(picture) = self.picture_from_xml(&fragment, None) {
                            runs.push(picture);
                        }
                    }
                    Some(ObjectClass::Kind(kind)) => {
                        let text = js_regex!(r"<m:t\b[^>]*>([^<]*)")
                            .exec(&fragment)
                            .and_then(|m| m.get(1))
                            .unwrap_or("")
                            .to_owned();
                        runs.push(self.object_run(kind, &fragment, &keys.next_key(), &text));
                    }
                    None => {}
                },
            }
        }
        let format: ParaFormat = read_ooxml_p_pr(p_pr);
        let mut out = b.clone();
        out.r#type.set(BlockType::Paragraph);
        out.runs.set(runs);
        out.format.set(format);
        if let Some(style_id) = style_id.filter(|id| !id.is_empty()) {
            out.style_id.set(style_id.to_owned());
        }
        out.raw_p_pr.assign(None);
        out.original_xml.set(Some(strip_paragraph_sect_pr(xml)));
        out
    }

    /// `block`: one body element to the items the writers take. A page break
    /// inside a paragraph (`w:br w:type="page"`) splits it: the text after the
    /// break is a paragraph of its own that starts a page (`fo:break-before`,
    /// which Hancom and LibreOffice both honour). A break at the end starts the
    /// next element's page; a paragraph holding only a break leaves no empty
    /// paragraph behind (as Hancom reads such a docx).
    pub fn block(&mut self, b: &Block) -> Vec<EditedItem> {
        let Some(one) = self.single(b) else {
            return Vec::new();
        };
        if let Some(first) = one.blocks.first() {
            self.last = Some((one.index, first.clone()));
        }
        let block = one.blocks[0].clone();
        let mut out: Vec<EditedItem> = Vec::new();
        let paragraph_like = matches!(
            *block.r#type,
            Some(BlockType::Paragraph | BlockType::Heading | BlockType::ListItem)
        );
        if !paragraph_like {
            if self.pending_break {
                self.pending_break = false;
                out.push(EditedItem {
                    index: one.index,
                    xml: String::new(),
                    blocks: vec![page_break_paragraph(&block)],
                });
            }
            out.push(one);
            return out;
        }
        let mut pieces: Vec<Vec<Run>> = vec![Vec::new()];
        for run in block.runs.as_deref().unwrap_or_default() {
            let text = run.text.as_deref().unwrap_or("");
            if !text.contains(FF) {
                if let Some(last) = pieces.last_mut() {
                    last.push(run.clone());
                }
                continue;
            }
            for (k, part) in text.split(FF).enumerate() {
                if k > 0 {
                    pieces.push(Vec::new());
                }
                if !part.is_empty() {
                    let mut piece_run = run.clone();
                    piece_run.text.set(part.to_owned());
                    if let Some(last) = pieces.last_mut() {
                        last.push(piece_run);
                    }
                }
            }
        }
        let mut break_before = self.pending_break;
        self.pending_break = false;
        let count = pieces.len();
        for (k, runs) in pieces.into_iter().enumerate() {
            let last = k == count - 1;
            if count > 1 && runs.is_empty() && (k == 0 || last) {
                // a break at the start belongs to the next piece, one at the end to the next element
                if last {
                    self.pending_break = true;
                } else {
                    break_before = true;
                }
                continue;
            }
            let mut format = (*block.format).clone().unwrap_or_default();
            if break_before || k > 0 {
                format.page_break_before.set(true);
            }
            break_before = false;
            let mut piece = block.clone();
            if k == 0 {
                piece.runs.set(runs);
                piece.format.set(format);
            } else {
                piece.runs.set(runs);
                piece.format.set(format);
                piece
                    .r#type
                    .set(if (*block.r#type).as_ref() == Some(&BlockType::ListItem) {
                        BlockType::Paragraph
                    } else {
                        (*block.r#type).clone().unwrap_or(BlockType::Paragraph)
                    });
                piece.list.assign(None);
            }
            out.push(EditedItem {
                index: one.index,
                xml: if k == 0 {
                    one.xml.clone()
                } else {
                    String::new()
                },
                blocks: vec![piece],
            });
        }
        out
    }

    /// `end`: after the last body element: a page break that ended the
    /// document starts one more page, which holds the empty paragraph Word
    /// shows there.
    pub fn end(&mut self) -> Vec<EditedItem> {
        let Some((index, last)) = self.last.as_ref() else {
            return Vec::new();
        };
        if !self.pending_break {
            return Vec::new();
        }
        let index = *index;
        let mut block = last.clone();
        self.pending_break = false;
        block.r#type.set(BlockType::Paragraph);
        block.runs.set(Vec::new());
        block.table.assign(None);
        block.list.assign(None);
        let mut format = ParaFormat::default();
        format.page_break_before.set(true);
        block.format.set(format);
        block.raw_p_pr.assign(None);
        block.original_xml.set(Some(String::new()));
        vec![EditedItem {
            index,
            xml: String::new(),
            blocks: vec![block],
        }]
    }

    /// `single`: one body element to the item the writers take (`None`:
    /// nothing to write).
    fn single(&mut self, b: &Block) -> Option<EditedItem> {
        if *b.hidden == Some(true) || *b.invisible_marker == Some(true) {
            return None;
        }
        if let Some(revision) = b.block_revision.as_ref() {
            self.revisions += 1;
            if revision.kind == BlockBlockRevisionKind::Del {
                return None;
            }
        }
        let index = docx_index(b).map_or(-1, |n| n as i64);
        let item = |block: Block| -> EditedItem {
            EditedItem {
                index,
                xml: original_xml(&block).to_owned(),
                blocks: vec![block],
            }
        };
        let kind = (*b.r#type).as_ref();
        if matches!(
            kind,
            Some(BlockType::Paragraph | BlockType::Heading | BlockType::ListItem)
        ) {
            let paragraph = self.paragraph(b);
            return Some(item(paragraph));
        }
        if kind == Some(&BlockType::Table)
            && let Some(model) = b.table.as_ref()
        {
            let table = self.table_model(model, &mut ObjectKeys::new(docx_index(b)));
            let mut next = b.clone();
            next.table.set(table);
            return Some(item(next));
        }
        if kind == Some(&BlockType::Image) {
            let xml = original_xml(b);
            let picture = self.picture_from_xml(xml, b.image_data_url.as_deref())?;
            let p_pr = leading_p_pr(xml);
            let style_id = p_style_of(p_pr);
            let mut format = read_ooxml_p_pr(p_pr);
            if format.align.is_none()
                && let Some(align) = (*b.image_align).as_ref().filter(|a| !a.as_str().is_empty())
            {
                format.align.set(match align {
                    BlockImageAlign::Left => ParaAlign::Left,
                    BlockImageAlign::Center => ParaAlign::Center,
                    BlockImageAlign::Right => ParaAlign::Right,
                    BlockImageAlign::Unlisted(s) => ParaAlign::Unlisted(s.clone()),
                });
            }
            let mut next = b.clone();
            next.r#type.set(BlockType::Paragraph);
            next.runs.set(vec![picture]);
            next.format.set(format);
            if let Some(style_id) = style_id.filter(|id| !id.is_empty()) {
                next.style_id.set(style_id.to_owned());
            }
            next.raw_p_pr.assign(None);
            return Some(item(next));
        }
        // protected paragraphs: fields, objects, section breaks
        if let Some(fd) = b.field_display.as_ref() {
            if fd.kind == FieldDisplayKind::PageBreak {
                return None;
            }
            if fd.kind == FieldDisplayKind::TocLine {
                let left = fd.left.as_deref().unwrap_or("");
                let right = fd.right.as_deref().unwrap_or("");
                // the field's first paragraph without an entry still takes a line
                if left.is_empty() && right.is_empty() {
                    let mut next = b.clone();
                    next.r#type.set(BlockType::Paragraph);
                    next.runs.set(Vec::new());
                    next.raw_p_pr.assign(None);
                    return Some(item(next));
                }
                let mut first = Run::default();
                first.text.set(left.to_owned());
                if fd.bold == Some(true) {
                    first.bold.set(true);
                }
                let mut runs = vec![first];
                if !right.is_empty() {
                    let mut tail = Run::default();
                    tail.text.set(format!("\t{right}"));
                    runs.push(tail);
                }
                let leader = fd.leader.clone().unwrap_or(TabStopLeader::Dot);
                let mut format = (*b.format).clone().unwrap_or_default();
                format.tab_stops.set(vec![TabStop {
                    pos: JsNum(9000.0),
                    val: TabStopVal::Right,
                    rel: None,
                    leader: Some(leader.clone()),
                    inherited: None,
                }]);
                let xml = original_xml(b);
                let p_pr = leading_p_pr(xml);
                format.assign(&read_ooxml_p_pr(p_pr));
                let tabs = js_regex!(r#"<w:tab\b[^>]*w:val="right"[^>]*w:pos="(\d+)""#)
                    .exec(p_pr)
                    .and_then(|m| m.get(1))
                    .filter(|tabs| !tabs.is_empty());
                if let Some(tabs) = tabs {
                    format.tab_stops.set(vec![TabStop {
                        pos: JsNum(parse_int(tabs, Radix::Ten)),
                        val: TabStopVal::Right,
                        rel: None,
                        leader: Some(leader),
                        inherited: None,
                    }]);
                }
                let mut next = b.clone();
                next.r#type.set(BlockType::Paragraph);
                next.runs.set(runs);
                next.format.set(format);
                next.raw_p_pr.assign(None);
                return Some(item(next));
            }
            let runs: Vec<Run> = match fd.runs.as_deref().filter(|runs| !runs.is_empty()) {
                Some(field_runs) => field_runs
                    .iter()
                    .map(|r| {
                        let mut run = Run::default();
                        run.text.set(r.text.clone());
                        if let Some(v) = r.bold {
                            run.bold.set(v);
                        }
                        if let Some(v) = r.italic {
                            run.italic.set(v);
                        }
                        if let Some(v) = r.underline {
                            run.underline.set(v);
                        }
                        if let Some(v) = r.color.clone() {
                            run.color.set(v);
                        }
                        if let Some(v) = r.size_half_points {
                            run.size_half_points.set(v);
                        }
                        if let Some(v) = r.font.clone() {
                            run.font.set(v);
                        }
                        if let Some(v) = r.font_ascii.clone() {
                            run.font_ascii.set(v);
                        }
                        if let Some(v) = r.cs_font.clone() {
                            run.cs_font.set(v);
                        }
                        if let Some(v) = r.link.clone() {
                            run.link.set(v);
                        }
                        if let Some(v) = r.style_id.clone() {
                            run.style_id.set(v);
                        }
                        if let Some(v) = r.math.clone() {
                            run.math.set(v);
                        }
                        run
                    })
                    .collect(),
                None => {
                    let mut run = Run::default();
                    run.text.set(fd.left.clone().unwrap_or_default());
                    vec![run]
                }
            };
            let mut next = b.clone();
            next.r#type.set(BlockType::Paragraph);
            next.runs.set(runs);
            next.raw_p_pr.assign(None);
            return Some(item(next));
        }
        let xml = original_xml(b);
        if js_regex!(r"^<w:p[\s>/]").test(xml) {
            let rebuilt = self.rebuilt(b, xml);
            return Some(item(rebuilt));
        }
        if js_regex!(r"^<w:tbl[\s>]").test(xml) || xml.is_empty() {
            return None;
        }
        // anything else drawable outside a paragraph (rare): its object picture
        let class = classify_object(xml)?;
        let mut keys = ObjectKeys::new(docx_index(b));
        let run = match class {
            ObjectClass::Picture => self.picture_from_xml(xml, b.image_data_url.as_deref()),
            ObjectClass::Kind(kind) => Some(self.object_run(kind, xml, &keys.next_key(), "")),
        };
        let run = run?;
        let mut next = b.clone();
        next.r#type.set(BlockType::Paragraph);
        next.runs.set(vec![run]);
        next.raw_p_pr.assign(None);
        Some(item(next))
    }
}
