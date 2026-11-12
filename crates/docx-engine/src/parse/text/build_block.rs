//! `buildBlock` of parse.ts: one body element as a block.

use jscompat::{JsNum, js_regex, trim, try_js_regex};
use serde::Serialize;
use serde_json::{Map, Value};

use super::context::BuildContext;
use super::convert::{into_map, json, model_of, num};
use super::paragraph::{anchor_line_of, anchored_rule_overlays, stray_anchor_line};
use super::paragraph_block::{
    BlockBase, build_text_paragraph, field_display_with_runs, stray_para_runs,
};
use super::{
    StrayParaRuns, ZoteroFieldParagraph, math_para_align, math_size_half_points, prop_change_info,
};
use crate::fields::{
    additive_spacing_of, direct_para_geometry, field_label, tag_attr, toc_level_of,
};
use crate::generate::split_xml_children;
use crate::ink::strip_ink_runs;
use crate::model::{Block, SectionSettings};
use crate::package::{Thrown, parse_part};
use crate::parse::drawings::diagram::{
    extract_diagram_drawing, extract_diagram_text, extract_locked_canvas,
};
use crate::parse::drawings::image::image_meta;
use crate::parse::drawings::media::{
    extract_chart, extract_image, has_resolvable_picture, media_data_url, ole_display,
    resolve_blip_media,
};
use crate::parse::drawings::picture::{
    aligned_picture_x_emu, picture_beside_float_table, picture_overhangs_column,
};
use crate::parse::drawings::textbox::{ExtractTextboxOpts, extract_textboxes, paragraph_stray_box};
use crate::parse::drawings::vml::{
    has_floating_vml_geometry, vml_image_meta, vml_picts_inline_only,
};
use crate::parse::tables::extract::extract_table;
use crate::parse::tables::table_summary;
use crate::props::{
    host_page_break, is_invisible_empty_shape, is_invisible_vml_pict, is_thin_rule,
    only_ole_fields, only_xe_fields, rule_display_of, strip_textboxes,
};
use crate::resolve::{ResolveParaOptions, resolve_paragraph_props_xml};
use crate::scan::BodyElement;
use crate::sdt::{parse_sdt_block, sdt_table_xml};
use crate::vml::shape::VML_PICT_RID_RE;
use crate::xml_text::{decode_entities, math_tokens, plain_text};
use omml::{omml_fragments_of, omml_to_latex, omml_to_mathml};

/// `INVISIBLE_BODY_MARKERS`
const INVISIBLE_BODY_MARKERS: [&str; 15] = [
    "w:bookmarkStart",
    "w:bookmarkEnd",
    "w:commentRangeStart",
    "w:commentRangeEnd",
    "w:proofErr",
    "w:permStart",
    "w:permEnd",
    "w:moveFromRangeStart",
    "w:moveFromRangeEnd",
    "w:moveToRangeStart",
    "w:moveToRangeEnd",
    "w:customXmlInsRangeStart",
    "w:customXmlInsRangeEnd",
    "w:customXmlDelRangeStart",
    "w:customXmlDelRangeEnd",
];

/// An object literal built key by key, as the TypeScript writes them.
struct Obj(Map<String, Value>);

impl Obj {
    fn of(base: &BlockBase) -> Self {
        Obj(base.map())
    }

    fn set(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.0.insert(key.to_owned(), value.into());
        self
    }

    fn json<T: Serialize>(mut self, key: &str, value: &T) -> Self {
        self.0.insert(key.to_owned(), json(value));
        self
    }

    /// `...spread`: a model value's own keys, in order.
    fn spread<T: Serialize>(mut self, value: &T) -> Self {
        for (key, value) in into_map(json(value)) {
            self.0.insert(key, value);
        }
        self
    }

    fn done(self) -> Result<Block, Thrown> {
        model_of(Value::Object(self.0))
    }
}

/// `r.text.trim() !== ''`
fn run_has_text(run: &crate::model::Run) -> bool {
    !trim(run.text.as_deref().unwrap_or("")).is_empty()
}

/// The text of each paragraph of a box: its runs' text joined.
fn box_para_texts(textbox: &crate::model::TextboxDisplay) -> Vec<String> {
    textbox
        .paras
        .iter()
        .flatten()
        .map(|p| {
            p.runs
                .iter()
                .map(|r| r.text.as_deref().unwrap_or(""))
                .collect::<String>()
        })
        .collect()
}

/// `RICH_DRAWING_RE`
fn rich_drawing(detect: &str) -> bool {
    js_regex!(r"<c:chart|<cx:chart|<dgm:|r:dm=|<lc:lockedCanvas|<wps:wsp|<w:txbxContent")
        .test(detect)
}

/// `buildBlock`
pub fn build_block(
    el: &BodyElement<'_>,
    index: usize,
    xml: &str,
    ctx: &BuildContext<'_>,
    zotero_field: Option<&ZoteroFieldParagraph>,
) -> Result<Block, Thrown> {
    let base = BlockBase {
        id: format!("b{index}"),
        docx_index: JsNum(index as f64),
        original_xml: xml.to_owned(),
    };
    if el.name == "w:ins" || el.name == "w:del" {
        let open_end = xml.find('>').map_or(0, |at| at + 1);
        let close = format!("</{}>", el.name);
        let inner_xml = match xml.rfind(&close) {
            Some(close_start) if close_start >= open_end => &xml[open_end..close_start],
            Some(_) => "",
            // `slice(openEnd, -1)`
            None => {
                let mut end = xml.len();
                if end > open_end {
                    end -= xml[..end].chars().next_back().map_or(0, char::len_utf8);
                }
                &xml[open_end..end.max(open_end)]
            }
        };
        let child = split_xml_children(inner_xml)
            .map_err(|limit| limit.to_string())?
            .into_iter()
            .find(|(name, _)| name == "w:p" || name == "w:tbl");
        if let Some((name, child_xml)) = child {
            // wrapper offsets keep sectionAt on the right section for the inner block
            let inner_el = BodyElement {
                name: &name,
                start: el.start,
                end: el.end,
            };
            let mut inner = build_block(&inner_el, index, &child_xml, ctx, None)?;
            let mut revision_attrs = Map::new();
            if let Ok(parsed) = parse_part(xml)
                && let Some(node) = parsed.iter().find(|node| node.name() == Some(el.name))
            {
                for (key, value) in node.attrs().unwrap_or(&[]) {
                    revision_attrs.insert(key.clone(), Value::from(value.as_str()));
                }
            }
            let attr = |key: &str| {
                revision_attrs
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty())
            };
            inner.original_xml.set(Some(xml.to_owned()));
            let mut revision = Map::new();
            revision.insert(
                "kind".to_owned(),
                Value::from(if el.name == "w:ins" { "ins" } else { "del" }),
            );
            revision.insert(
                "author".to_owned(),
                Value::from(
                    revision_attrs
                        .get("w:author")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                ),
            );
            for (a, k) in [
                ("w:date", "date"),
                ("w16du:dateUtc", "dateUtc"),
                ("w:id", "id"),
            ] {
                if let Some(v) = attr(a) {
                    revision.insert(k.to_owned(), Value::from(v));
                }
            }
            inner.block_revision.set(model_of(Value::Object(revision))?);
            return Ok(inner);
        }
    }

    if el.name == "w:sectPr" {
        let sect_pr_change = prop_change_info(xml, "w:sectPrChange");
        let mut obj = Obj::of(&base)
            .set("type", "passthrough")
            .set("label", "Section properties")
            .set("hidden", true);
        if let Some(change) = &sect_pr_change {
            obj = obj.json("sectPrChange", change);
        }
        return obj.done();
    }
    if el.name == "w:tbl" {
        let table = extract_table(xml, ctx, Some(el.start))?;
        let mut obj = Obj::of(&base)
            .set("type", "table")
            .spread(&table_summary(xml));
        if let Some(table) = &table {
            obj = obj.json("table", table);
        }
        return obj.done();
    }

    // --- SDT (structured document tag): extract sdtContent paragraph as editable ---
    if el.name == "w:sdt" {
        // sdtContent that starts with a table: display as a real table
        if let Some(tbl_xml) = sdt_table_xml(xml).filter(|t| !t.is_empty()) {
            let table = extract_table(&tbl_xml, ctx, Some(el.start))?;
            let mut obj = Obj::of(&base)
                .set("type", "table")
                .spread(&table_summary(&tbl_xml));
            if let Some(table) = &table {
                obj = obj.json("table", table);
            }
            return obj.done();
        }
        if let Some(sdt) = parse_sdt_block(xml).map_err(|limit| limit.to_string())? {
            // a synthetic BodyElement for the inner w:p; the sdt's own document offsets keep sectionAt right
            let synthetic = BodyElement {
                name: "w:p",
                start: el.start,
                end: el.end,
            };
            let mut inner = build_block(&synthetic, index, &sdt.p_xml, ctx, None)?;
            inner.original_xml.set(Some(xml.to_owned()));
            inner.sdt_shell.set(model_of(json(&sdt.shell))?);
            // a single-child control can still hold nested controls around its paragraph
            let chain: Vec<Value> = sdt
                .chain
                .iter()
                .enumerate()
                .map(|(depth, level)| {
                    let mut map = into_map(json(&level.shell));
                    map.insert("level".to_owned(), num(depth as f64));
                    map.insert("openBlock".to_owned(), num(index as f64));
                    map.insert("openOffset".to_owned(), num(level.range.open_start as f64));
                    map.insert("closeBlock".to_owned(), num(index as f64));
                    map.insert(
                        "closeOffset".to_owned(),
                        num(level.range.close_start as f64),
                    );
                    Value::Object(map)
                })
                .collect();
            inner.sdt_shells.set(model_of(Value::Array(chain))?);
            super::controls::attach_inline_content_controls(&mut inner, &sdt.p_xml)
                .map_err(|limit| limit.to_string())?;
            // label the block with the alias for UI affordance
            if !inner.label.as_deref().is_some_and(|l| !l.is_empty()) {
                let meta = &sdt.shell.meta;
                let label = if !meta.alias.is_empty() {
                    meta.alias.as_str()
                } else if !meta.tag.is_empty() {
                    meta.tag.as_str()
                } else {
                    "Content control"
                };
                inner.label.set(label.to_owned());
            }
            return Ok(inner);
        }
        // no usable paragraph found: passthrough; keep the text visible at least
        let preview = plain_text(xml);
        if trim(&preview).is_empty()
            && !xml.contains("<w:drawing")
            && !js_regex!(r"<w:pict[\s>]").test(xml)
        {
            return Obj::of(&base)
                .set("type", "passthrough")
                .set("label", "Content control")
                .set("invisibleMarker", true)
                .done();
        }
        return Obj::of(&base)
            .set("type", "passthrough")
            .set("label", "Content control")
            .set("previewText", preview)
            .done();
    }
    if INVISIBLE_BODY_MARKERS.contains(&el.name) {
        return Obj::of(&base)
            .set("type", "passthrough")
            .set("label", el.name)
            .set("invisibleMarker", true)
            .done();
    }
    if el.name == "w:br" {
        // Word honors a <w:br> sitting directly in the body: page-type turns the page
        if js_regex!(r#"w:type="page""#).test(xml) {
            let mut display = Map::new();
            display.insert("kind".to_owned(), Value::from("pageBreak"));
            return Obj::of(&base)
                .set("type", "passthrough")
                .set("label", "Page break")
                .set("fieldDisplay", Value::Object(display))
                .done();
        }
        return Obj::of(&base)
            .set("type", "passthrough")
            .set("label", el.name)
            .set("invisibleMarker", true)
            .done();
    }
    if el.name != "w:p" {
        return Obj::of(&base)
            .set("type", "passthrough")
            .set("label", el.name)
            .set("previewText", "")
            .done();
    }

    // Feature-detect on XML with mc:Fallback stripped
    let without_fallback = if xml.contains("<mc:Fallback") {
        js_regex!(r"<mc:Fallback[^>]*>[\s\S]*?<\/mc:Fallback>", "g")
            .replace_all(xml, |_| String::new())
    } else {
        xml.to_owned()
    };
    let detect_owned = strip_ink_runs(&without_fallback);
    let detect: &str = &detect_owned;

    // Only a content-less section-break paragraph is protected
    if detect.contains("<w:sectPr") && trim(&plain_text(detect)).is_empty() {
        // a picture is visible content too
        if !rich_drawing(detect) && has_resolvable_picture(detect, ctx)? {
            return build_text_paragraph(&base, xml, ctx, true, Some(el.start), None);
        }
        let sect_pr_change = prop_change_info(xml, "w:sectPrChange");
        let mut obj = Obj::of(&base)
            .set("type", "passthrough")
            .set("label", "Section break paragraph")
            .set("previewText", "");
        if let Some(change) = &sect_pr_change {
            obj = obj.json("sectPrChange", change);
        }
        return obj.done();
    }
    // Field chars inside textbox content don't make the paragraph itself a field paragraph
    let field_detect: String = if detect.contains("<w:txbxContent") {
        strip_textboxes(detect).into_owned()
    } else {
        detect.to_owned()
    };
    let has_fields = field_detect.contains("<w:fldChar")
        || field_detect.contains("<w:fldSimple")
        || field_detect.contains("<w:instrText");
    // Field paragraphs whose visible result is a picture should still display the image
    if has_fields
        && detect.contains("<w:drawing")
        && !detect.contains("<c:chart")
        && !detect.contains("r:dm=")
        && !detect.contains("<dgm:")
    {
        let visible = trim(&plain_text(&strip_textboxes(detect))).to_owned();
        let drawing_at = detect.find("<w:drawing").unwrap_or(0);
        let trailing_caption = !visible.is_empty()
            && detect.contains("<wp:inline")
            && !rich_drawing(detect)
            && trim(&plain_text(&strip_textboxes(&detect[..drawing_at]))).is_empty();
        let image = if visible.is_empty() || trailing_caption {
            extract_image(detect, ctx)?
        } else {
            None
        };
        if let Some(image) = image {
            let caption = if trailing_caption {
                field_display_with_runs(xml, ctx)?
            } else {
                None
            };
            let caption_is_text = caption
                .as_ref()
                .is_some_and(|c| c.kind == crate::model::FieldDisplayKind::Text);
            if !trailing_caption || caption_is_text {
                let mut obj = Obj::of(&base)
                    .set("type", "image")
                    .set("label", "Image")
                    .set("imageDataUrl", image)
                    .spread(&image_meta(detect, Some(ctx))?.block);
                if caption_is_text && let Some(caption) = &caption {
                    obj = obj.json("fieldDisplay", caption);
                }
                return obj.done();
            }
        }
    }
    let field_passthrough = || -> Result<Block, Thrown> {
        let p_style = tag_attr(xml, "w:pStyle", "w:val").map_err(|e| e.to_string())?;
        let field_display = field_display_with_runs(xml, ctx)?;
        let mut obj = Obj::of(&base)
            .set("type", "passthrough")
            .set("label", field_label(xml))
            .set("previewText", plain_text(xml));
        if let Some(display) = &field_display {
            obj = obj.json("fieldDisplay", display);
        }
        if let Some(style) = p_style.filter(|s| !s.is_empty()) {
            obj = obj.set("styleId", style);
        }
        obj.done()
    };
    // a chart sharing its paragraph with a caption field takes the chart branch below
    let has_chart = detect.contains("<c:chart") || detect.contains("<cx:chart");
    if has_fields && !has_chart && zotero_field.is_none() {
        // legacy field-form OLE: take the OLE display path
        if detect.contains("<w:object") && only_ole_fields(&field_detect) {
            return Obj::of(&base)
                .set("type", "passthrough")
                .set("label", "Embedded object")
                .set("previewText", plain_text(detect))
                .spread(&ole_display(detect, ctx)?)
                .done();
        }
        // XE (index entry) fields are invisible markers; a paragraph whose only fields are XE stays editable
        if !only_xe_fields(detect) {
            return field_passthrough();
        }
    }
    // TOC-styled paragraphs are part of a TOC field result even when they carry no field chars
    let toc_style_id = tag_attr(xml, "w:pStyle", "w:val").map_err(|e| e.to_string())?;
    if let Some(toc_style_id) = toc_style_id.filter(|s| !s.is_empty())
        && toc_level_of(toc_style_id, Some(&ctx.resolver.styles)).is_some()
    {
        let display = crate::fields::display::field_display_of(
            xml,
            Some(&ctx.resolver.styles),
            Some(&ctx.resolver),
        )?;
        let mut obj = Obj::of(&base)
            .set("type", "passthrough")
            .set("label", "TOC entry")
            .set("previewText", plain_text(xml));
        if let Some(display) = &display {
            obj = obj.json("fieldDisplay", display);
        }
        return obj.set("styleId", toc_style_id).done();
    }
    // only run-level revision constructs the run model cannot round-trip stay protected
    if js_regex!(r"<w:(delInstrText|cellIns|cellDel)[ />]").test(detect) {
        return Obj::of(&base)
            .set("type", "passthrough")
            .set("label", "Revised paragraph")
            .set("previewText", plain_text(detect))
            .done();
    }
    // display equations stay protected as a whole
    if detect.contains("<m:oMath")
        && (detect.contains("<m:oMathPara") || trim(&plain_text(detect)).is_empty())
    {
        let tokens = math_tokens(detect);
        let omml = omml_fragments_of(detect).join("");
        let mathml = if trim(&plain_text(detect)).is_empty() {
            omml_to_mathml(&omml)
        } else {
            String::new()
        };
        let latex = if omml.is_empty() {
            None
        } else {
            omml_to_latex(&omml)
        };
        let p_pr = js_regex!(r"<w:pPr>[\s\S]*?<\/w:pPr>")
            .exec(xml)
            .map_or("", |found| found.as_str());
        let style_id = tag_attr(p_pr, "w:pStyle", "w:val").map_err(|e| e.to_string())?;
        let align = math_para_align(detect, p_pr).map_err(|e| e.to_string())?;
        let eff = resolve_paragraph_props_xml(xml, &ctx.resolver, ResolveParaOptions::default())?;
        let mut display = Map::new();
        display.insert("tokens".to_owned(), json(&tokens));
        if !mathml.is_empty() {
            display.insert("mathml".to_owned(), Value::from(mathml));
        }
        if !omml.is_empty() {
            display.insert("omml".to_owned(), Value::from(omml.as_str()));
        }
        if let Some(latex) = latex.filter(|l| !l.is_empty()) {
            display.insert("latex".to_owned(), Value::from(latex));
        }
        let eff_model = super::eff_to_model(&eff)?;
        display.insert(
            "sizeHalfPoints".to_owned(),
            json(&math_size_half_points(&omml, &eff_model).map_err(|e| e.to_string())?),
        );
        display.insert("align".to_owned(), Value::from(align));
        for (k, v) in into_map(json(&direct_para_geometry(&eff))) {
            display.insert(k, v);
        }
        for (k, v) in into_map(json(&additive_spacing_of(&ctx.resolver))) {
            display.insert(k, v);
        }
        let mut obj = Obj::of(&base)
            .set("type", "passthrough")
            .set("label", "Equation")
            .set("previewText", tokens.join(""));
        if let Some(style_id) = style_id.filter(|s| !s.is_empty()) {
            obj = obj.set("styleId", style_id);
        }
        return obj.set("formulaDisplay", Value::Object(display)).done();
    }
    if detect.contains("<w:object") || js_regex!(r"<w:pict[\s>]").test(detect) {
        return pict_branch(&base, el, index, xml, detect, ctx);
    }
    if detect.contains("<w:drawing")
        && let Some(block) = drawing_branch(
            &base,
            el,
            index,
            xml,
            detect,
            has_fields,
            ctx,
            &field_passthrough,
        )?
    {
        return Ok(block);
    }
    build_text_paragraph(&base, xml, ctx, false, Some(el.start), zotero_field)
}

/// The `<w:object>` / `<w:pict>` branch of `buildBlock`.
fn pict_branch(
    base: &BlockBase,
    el: &BodyElement<'_>,
    index: usize,
    xml: &str,
    detect: &str,
    ctx: &BuildContext<'_>,
) -> Result<Block, Thrown> {
    let sect_at = |offset: usize| -> Option<SectionSettings> {
        ctx.section_at.as_ref().map(|section| section.at(offset))
    };
    let has_object = detect.contains("<w:object");
    // Legacy VML textboxes and WordArt in w:pict: extract the structured display model
    if !has_object
        && (detect.contains("<w:txbxContent")
            || crate::vml::shape::VML_WORDART_RE.test(detect)
            || has_floating_vml_geometry(detect))
    {
        // DrawingML pictures anchored next to the VML shape: resolve their media
        let host_xml = strip_textboxes(detect);
        let anchored_pics = host_xml.contains("<w:drawing")
            && (host_xml.contains("<pic:pic") || host_xml.contains("<a:blip"));
        if anchored_pics || VML_PICT_RID_RE.test(&host_xml) {
            resolve_blip_media(detect, ctx)?;
        }
        let first_page = index > 0 && ctx.first_page_break_at.is_none_or(|at| el.start < at);
        let section = sect_at(el.start);
        let floating = has_floating_vml_geometry(detect);
        let opts = if anchored_pics {
            ExtractTextboxOpts {
                shapes: true,
                pictures: true,
                section: section.as_ref(),
                doc_offset: Some(el.start),
                first_page,
            }
        } else {
            ExtractTextboxOpts {
                doc_offset: Some(el.start),
                shapes: floating,
                section: if host_xml.contains("<w:drawing") {
                    None
                } else {
                    section.as_ref()
                },
                ..ExtractTextboxOpts::default()
            }
        };
        let mut textboxes = extract_textboxes(detect, ctx, opts)?;
        let stray_text = trim(&plain_text(&strip_textboxes(detect))).to_owned();
        // paragraphs mixing an inline VML picture with real text stay on the editable run-image path below
        let keep_for_images = !stray_text.is_empty() && VML_PICT_RID_RE.test(detect);
        if !textboxes.is_empty() && !keep_for_images {
            let stray: Option<StrayParaRuns> = if stray_text.is_empty() {
                None
            } else {
                stray_para_runs(
                    &js_regex!(r"<w:pict>[\s\S]*?<\/w:pict>", "g")
                        .replace_all(detect, |_| String::new()),
                    ctx,
                    false,
                )
            };
            let list_stray = stray
                .as_ref()
                .filter(|s| s.list.is_some() && !s.runs.is_empty());
            if !stray_text.is_empty()
                && list_stray.is_none()
                && let Some(stray_box) = paragraph_stray_box(detect, ctx)?
            {
                textboxes.push(stray_box);
            }
            // host paragraph jc only
            let jc = js_regex!(r#"<w:jc w:val="([^"]+)""#)
                .exec(&strip_textboxes(detect))
                .and_then(|found| found.get(1).map(str::to_owned));
            let mut obj = Obj::of(base)
                .set("type", "passthrough")
                .set("label", "Text box");
            if el.name == "w:p"
                && let Some(line) = anchor_line_of(xml, ctx)?
            {
                obj = obj.json("anchorLine", &line);
            }
            let mut preview: Vec<String> = Vec::new();
            if list_stray.is_some() {
                preview.push(stray_text.clone());
            }
            for t in &textboxes {
                preview.extend(box_para_texts(t));
            }
            obj = obj
                .set("previewText", preview.join("\n"))
                .json("textboxes", &textboxes);
            if host_page_break(detect) {
                let mut display = Map::new();
                display.insert("kind".to_owned(), Value::from("pageBreak"));
                obj = obj.set("fieldDisplay", Value::Object(display));
            }
            match jc.as_deref() {
                Some("center") => obj = obj.set("imageAlign", "center"),
                Some("right" | "end") => obj = obj.set("imageAlign", "right"),
                _ => {}
            }
            if let Some(stray) = list_stray {
                obj = obj.json("strayRuns", &stray.runs);
                if let Some(style) = stray.style_id.as_deref().filter(|s| !s.is_empty()) {
                    obj = obj.set("strayStyleId", style);
                }
                if let Some(indent) = &stray.indent {
                    obj = obj.set("strayIndent", Value::Object(indent.clone()));
                }
                if let Some(align) = stray.align.as_deref() {
                    obj = obj.set("strayAlign", align);
                }
                if let Some(list) = &stray.list {
                    obj = obj.set("strayList", list.clone());
                }
            }
            return obj.done();
        }
    }
    // Plain VML picture (v:imagedata without OLE): stamps, watermark pictures, Word-2003-era inline images
    if !has_object && VML_PICT_RID_RE.test(detect) {
        if !trim(&plain_text(&strip_textboxes(detect))).is_empty() {
            // picture shares the paragraph with real text: keep the text editable with run-level images
            resolve_blip_media(detect, ctx)?;
            return build_text_paragraph(base, xml, ctx, true, Some(el.start), None);
        }
        let r_id = js_regex!(r#"<v:imagedata[^>]*r:id="([^"]+)""#)
            .exec(detect)
            .and_then(|found| found.get(1));
        let image = match r_id {
            Some(r_id) => media_data_url(
                ctx.zip,
                &ctx.rels,
                r_id,
                ctx.source_path.as_deref().unwrap_or("word/document.xml"),
                ctx.media,
            )?,
            None => None,
        };
        if let Some(image) = image.filter(|i| !i.is_empty()) {
            return Obj::of(base)
                .set("type", "image")
                .set("label", "Image")
                .set("imageDataUrl", image)
                .spread(&vml_image_meta(detect))
                .done();
        }
    }
    if !has_object && trim(&plain_text(detect)).is_empty() && is_invisible_vml_pict(detect) {
        let mut obj = Obj::of(base)
            .set("type", "passthrough")
            .set("label", "Drawing object")
            .set("invisibleMarker", true);
        if el.name == "w:p"
            && let Some(line) = anchor_line_of(xml, ctx)?
        {
            obj = obj.json("anchorLine", &line);
        }
        return obj.done();
    }
    // inline VML geometry and picts with no drawable shape at all: the paragraph stays text
    if !has_object && vml_picts_inline_only(detect, ctx.vml_shape_types.as_ref()) {
        return build_text_paragraph(base, xml, ctx, true, Some(el.start), None);
    }
    // VML horizontal rule: stays a text paragraph and the rule rides as a run image
    if !has_object && js_regex!(r#"<v:rect\b[^>]*\bo:hr="t"[^>]*>"#).test(detect) {
        if detect.contains("<a:blip") {
            resolve_blip_media(detect, ctx)?;
        }
        return build_text_paragraph(base, xml, ctx, true, Some(el.start), None);
    }
    // OLE embed sharing the paragraph with real text or another drawing
    if has_object
        && (!trim(&plain_text(&strip_textboxes(detect))).is_empty()
            || detect.contains("<w:drawing"))
    {
        resolve_blip_media(detect, ctx)?;
        let objects: Vec<&str> = js_regex!(r"<w:object[\s\S]*?<\/w:object>", "g")
            .find_iter(detect)
            .map(|found| found.as_str())
            .collect();
        let displayable = objects.iter().all(|o| {
            js_regex!(r#"<v:imagedata[^>]*r:id="([^"]+)""#)
                .exec(o)
                .and_then(|found| found.get(1))
                .is_some_and(|r_id| {
                    ctx.media_by_rid
                        .as_ref()
                        .is_some_and(|m| m.borrow().has(r_id))
                })
        });
        if displayable && !objects.is_empty() {
            return build_text_paragraph(base, xml, ctx, true, Some(el.start), None);
        }
    }
    Obj::of(base)
        .set("type", "passthrough")
        .set("label", "Embedded object")
        .set("previewText", plain_text(detect))
        .spread(&ole_display(detect, ctx)?)
        .done()
}

/// The `<w:drawing>` branch of `buildBlock`: `None` falls through to a text paragraph.
#[allow(clippy::too_many_arguments)]
fn drawing_branch(
    base: &BlockBase,
    el: &BodyElement<'_>,
    index: usize,
    xml: &str,
    detect: &str,
    has_fields: bool,
    ctx: &BuildContext<'_>,
    field_passthrough: &dyn Fn() -> Result<Block, Thrown>,
) -> Result<Option<Block>, Thrown> {
    let sect_at = |offset: usize| -> Option<SectionSettings> {
        ctx.section_at.as_ref().map(|section| section.at(offset))
    };
    if detect.contains("<c:chart")
        || detect.contains("<cx:chart")
        || detect.contains("r:dm=")
        || detect.contains("<dgm:")
    {
        let is_chart = detect.contains("<c:chart") || detect.contains("<cx:chart");
        // chartex: Word pairs the Choice with a pre-rendered picture fallback; prefer it
        if is_chart
            && !has_fields
            && detect.contains("/drawing/2014/chartex\"")
            && let Some(fb_image) = extract_image(xml, ctx)?
        {
            return Ok(Some(
                Obj::of(base)
                    .set("type", "image")
                    .set("label", "Image")
                    .set("imageDataUrl", fb_image)
                    .spread(&image_meta(xml, Some(ctx))?.block)
                    .done()?,
            ));
        }
        let chart_display = if is_chart {
            extract_chart(detect, ctx)?
        } else {
            None
        };
        // no drawable chart model: the caption field paragraph renders as before
        if is_chart && chart_display.is_none() && has_fields {
            return Ok(Some(field_passthrough()?));
        }
        let caption =
            if chart_display.is_some() && !trim(&plain_text(&strip_textboxes(detect))).is_empty() {
                field_display_with_runs(xml, ctx)?
            } else {
                None
            };
        let diagram_text = if is_chart {
            None
        } else {
            extract_diagram_text(detect, ctx)?
        };
        let mut diagram_display = if is_chart {
            None
        } else {
            extract_diagram_drawing(detect, ctx)?
        };
        // the diagram may share its paragraph with other anchored drawings
        let frags = crate::drawing_geometry::anchor::top_level_drawings(detect);
        let mut sibling_boxes = Vec::new();
        if !is_chart && frags.len() > 1 {
            if let Some(diagram) = diagram_display.as_mut() {
                let dm_frag = frags.iter().find(|f| f.contains("r:dm="));
                let meta = dm_frag.map(|f| crate::drawing_geometry::anchor::drawing_anchor_meta(f));
                if let Some(meta) = meta.filter(|m| m.anchored == Some(true)) {
                    diagram.offset_x_emu = meta.offset_x_emu;
                    diagram.offset_y_emu = meta.offset_y_emu;
                    diagram.floating = Some(true);
                }
            }
            resolve_blip_media(detect, ctx)?;
            let section = sect_at(el.start);
            sibling_boxes = extract_textboxes(
                detect,
                ctx,
                ExtractTextboxOpts {
                    shapes: true,
                    pictures: true,
                    section: section.as_ref(),
                    doc_offset: Some(el.start),
                    ..ExtractTextboxOpts::default()
                },
            )?;
        }
        let mut obj = Obj::of(base)
            .set("type", "passthrough")
            .set("label", if is_chart { "Chart" } else { "SmartArt" });
        if let Some(chart) = &chart_display {
            obj = obj.json("chartDisplay", chart);
            obj = obj.set(
                "previewText",
                chart.title.as_deref().unwrap_or("").to_owned(),
            );
        }
        if let Some(caption) = caption.filter(|c| c.kind == crate::model::FieldDisplayKind::Text) {
            obj = obj.json("fieldDisplay", &caption);
        }
        if let Some(text) = diagram_text.filter(|t| !t.is_empty()) {
            obj = obj.set("previewText", text);
        }
        if let Some(diagram) = &diagram_display {
            obj = obj.json("diagramDisplay", diagram);
        }
        if !sibling_boxes.is_empty() {
            obj = obj.json("textboxes", &sibling_boxes);
        }
        return Ok(Some(obj.done()?));
    }
    // drawing canvas (lockedCanvas): scaled child geometry + raw-size text
    if detect.contains("<lc:lockedCanvas") {
        resolve_blip_media(detect, ctx)?;
        if let Some(mut canvas) = extract_locked_canvas(detect, ctx)? {
            let frags = crate::drawing_geometry::anchor::top_level_drawings(detect);
            let meta = frags
                .first()
                .map(|f| crate::drawing_geometry::anchor::drawing_anchor_meta(f));
            if let Some(meta) = meta.filter(|m| m.anchored == Some(true)) {
                // horizontal anchor offset only: LO renders these canvases from the anchor paragraph's top
                canvas.offset_x_emu = meta.offset_x_emu;
                if meta.no_wrap == Some(true) {
                    canvas.floating = Some(true);
                }
            }
            let preview: Vec<String> = canvas
                .shapes
                .iter()
                .flat_map(|s| s.texts.clone().unwrap_or_default())
                .collect();
            return Ok(Some(
                Obj::of(base)
                    .set("type", "passthrough")
                    .set("label", "Drawing object")
                    .json("diagramDisplay", &canvas)
                    .set("previewText", preview.join("\n"))
                    .done()?,
            ));
        }
    }
    let image = extract_image(detect, ctx)?;
    // wps shapes would vanish on the plain-paragraph and single-image paths
    let has_wsp = detect.contains("<wps:wsp");
    let mut spanning_photo_row = false;
    if let Some(image_url) = &image {
        // shapes carrying textbox content alongside a blip: fall through to the textbox display
        let boxed = if detect.contains("<w:txbxContent") {
            extract_textboxes(detect, ctx, ExtractTextboxOpts::default())?
                .iter()
                .any(|t| {
                    t.paras.iter().flatten().any(|p| {
                        p.runs.iter().any(run_has_text)
                            || p.cells.as_ref().is_some_and(|cells| {
                                cells
                                    .iter()
                                    .any(|c| c.paras.iter().any(|rs| rs.iter().any(run_has_text)))
                            })
                    })
                })
        } else {
            false
        };
        if !boxed {
            let multi_pic = js_regex!(r"<a:blip[ />]", "g").find_iter(detect).count() > 1;
            let has_text = !trim(&plain_text(&strip_textboxes(detect))).is_empty();
            let drawings = crate::drawing_geometry::anchor::top_level_drawings(detect);
            let anchored_drawings = drawings.iter().filter(|f| f.contains("<wp:anchor")).count();
            let inline_beside_anchor = anchored_drawings == 1
                && drawings
                    .iter()
                    .any(|f| !f.contains("<wp:anchor") && f.contains("<pic:pic"));
            if (has_text && !has_wsp)
                || (multi_pic
                    && (!detect.contains("<wp:anchor") || (inline_beside_anchor && !has_wsp)))
            {
                resolve_blip_media(detect, ctx)?;
                let inline_pics = drawings
                    .iter()
                    .filter(|f| !f.contains("<wp:anchor") && f.contains("<pic:pic"))
                    .count();
                spanning_photo_row = if has_text && anchored_drawings >= 2 && inline_pics == 0 {
                    let section = sect_at(el.start);
                    extract_textboxes(
                        detect,
                        ctx,
                        ExtractTextboxOpts {
                            pictures: true,
                            section: section.as_ref(),
                            doc_offset: Some(el.start),
                            ..ExtractTextboxOpts::default()
                        },
                    )?
                    .iter()
                    .any(|b| b.band_bottom_px.is_some())
                } else {
                    false
                };
                if !spanning_photo_row {
                    return Ok(Some(build_text_paragraph(
                        base,
                        xml,
                        ctx,
                        true,
                        Some(el.start),
                        None,
                    )?));
                }
            }
            // several separately-anchored pictures in one paragraph take the photo-box route below
            if !has_wsp && anchored_drawings <= 1 {
                let mut meta = image_meta(detect, Some(ctx))?;
                let sect = sect_at(el.start);
                let beside = ctx
                    .float_table_ahead
                    .borrow()
                    .as_ref()
                    .is_some_and(|table| {
                        picture_beside_float_table(&meta.block, detect, table, sect.as_ref())
                    });
                if beside || picture_overhangs_column(&meta.block, detect, sect.as_ref()) {
                    meta.block.image_band.set(true);
                    // the band positions by offset: resolve a wp:align pair into one
                    if meta.block.image_offset_x_emu.is_none()
                        && let Some(sect) = &sect
                    {
                        meta.block
                            .image_offset_x_emu
                            .assign(aligned_picture_x_emu(&meta.block, detect, sect).map(JsNum));
                    }
                    if meta.block.image_offset_y_emu.is_none()
                        && js_regex!(r#"<wp:positionV[^>]*relativeFrom="page"[^>]*>\s*<wp:align>top<\/wp:align>"#)
                            .test(detect)
                    {
                        meta.block.image_offset_y_emu.set(JsNum(0.0));
                        meta.block.image_rel_v.set(crate::model::BlockImageRelV::Page);
                    }
                }
                let wrap = meta
                    .block
                    .image_wrap
                    .map(|w| w.as_str().to_owned())
                    .unwrap_or_default();
                let side_wrapped =
                    js_regex!(r"^(?:square|tight|through)-(?:left|right)$").test(&wrap);
                // the anchor paragraph's own (empty) line beside a side-wrapped picture or under a behind/in-front one
                let overlay = wrap == "front" || wrap == "behind";
                let mut obj = Obj::of(base)
                    .set("type", "image")
                    .set("label", "Image")
                    .set("imageDataUrl", image_url.as_str())
                    .spread(&meta.block);
                if ((side_wrapped && !meta.block.image_band.unwrap_or(false)) || overlay)
                    && let Some(line) = anchor_line_of(xml, ctx)?
                {
                    obj = obj.json("anchorLine", &line);
                }
                return Ok(Some(obj.done()?));
            }
        }
    }
    // picture fills inside shapes and sibling/grouped pic:pic blips resolve from pre-fetched media
    if detect.contains("<a:blip") {
        resolve_blip_media(detect, ctx)?;
    }
    let first_page = index > 0 && ctx.first_page_break_at.is_none_or(|at| el.start < at);
    let section = sect_at(el.start);
    let textboxes = extract_textboxes(
        detect,
        ctx,
        ExtractTextboxOpts {
            shapes: true,
            pictures: true,
            section: section.as_ref(),
            doc_offset: Some(el.start),
            first_page,
        },
    )?;
    let box_texts: Vec<String> = textboxes.iter().flat_map(box_para_texts).collect();
    let stray_text = trim(&plain_text(&strip_textboxes(detect))).to_owned();
    // anchored decorative shape in a paragraph that also carries real text: parse it as a normal paragraph
    if !stray_text.is_empty()
        && !spanning_photo_row
        && !box_texts.iter().any(|t| !trim(t).is_empty())
        && !(has_wsp && !textboxes.is_empty())
    {
        let block = build_text_paragraph(base, xml, ctx, true, Some(el.start), None)?;
        let overlays = anchored_rule_overlays(detect, ctx)?;
        if overlays.is_empty() {
            return Ok(Some(block));
        }
        return Ok(Some(
            Obj::of(base)
                .spread(&block)
                .json("ruleOverlays", &overlays)
                .done()?,
        ));
    }
    // anchored textboxes: extract a display-only model; the block stays protected
    if !textboxes.is_empty() {
        let inline_run_pics = detect.contains("<wp:anchor")
            && crate::drawing_geometry::anchor::top_level_drawings(detect)
                .iter()
                .any(|f| {
                    !f.contains("<wp:anchor")
                        && f.contains("<pic:pic")
                        && !f.contains("<w:txbxContent")
                });
        let stray = if !stray_text.is_empty() || inline_run_pics {
            stray_para_runs(detect, ctx, inline_run_pics)
        } else {
            None
        };
        let meta = image_meta(detect, Some(ctx))?;
        let wrap = meta
            .block
            .image_wrap
            .map(|w| w.as_str().to_owned())
            .unwrap_or_default();
        let anchor_line = if stray.as_ref().is_some_and(|s| !s.runs.is_empty())
            || (el.name == "w:p" && !js_regex!(r"-(?:left|right)$").test(&wrap))
        {
            stray_anchor_line(xml, ctx)?
        } else {
            None
        };
        let mut preview = Vec::new();
        if !stray_text.is_empty() {
            preview.push(stray_text.clone());
        }
        preview.extend(box_texts.iter().cloned());
        let mut obj = Obj::of(base)
            .set("type", "passthrough")
            .set("label", "Text box")
            .set("previewText", preview.join("\n"))
            .json("textboxes", &textboxes);
        if try_js_regex!(r#"^<w:p\b[^>]*>\s*<w:pPr>(?:(?!<\/w:pPr>)[\s\S])*?<w:snapToGrid w:val="(?:0|false)"\s*\/>"#)
            .try_test(xml)
            .map_err(|limit| limit.to_string())?
        {
            obj = obj.set("anchorSnapToGrid", false);
        }
        if host_page_break(detect) {
            let mut display = Map::new();
            display.insert("kind".to_owned(), Value::from("pageBreak"));
            obj = obj.set("fieldDisplay", Value::Object(display));
        }
        if let Some(line) = &anchor_line {
            obj = obj.json("anchorLine", line);
        }
        if let Some(stray) = stray.filter(|s| !s.runs.is_empty()) {
            obj = obj.json("strayRuns", &stray.runs);
            if let Some(style) = stray.style_id.as_deref().filter(|s| !s.is_empty()) {
                obj = obj.set("strayStyleId", style);
            }
            if let Some(indent) = &stray.indent {
                obj = obj.set("strayIndent", Value::Object(indent.clone()));
            }
            if let Some(align) = stray.align.as_deref() {
                obj = obj.set("strayAlign", align);
            }
            if let Some(list) = &stray.list {
                obj = obj.set("strayList", list.clone());
            }
        }
        return Ok(Some(obj.spread(&meta.block).done()?));
    }
    // wps paragraph whose shapes all turned out invisible: fall back to the plain image block
    if let Some(image) = &image {
        return Ok(Some(
            Obj::of(base)
                .set("type", "image")
                .set("label", "Image")
                .set("imageDataUrl", image.as_str())
                .spread(&image_meta(detect, Some(ctx))?.block)
                .done()?,
        ));
    }
    // Picture whose media cannot be shown: empty frame at the declared extent instead of a bare chip
    if detect.contains("<a:blip") || detect.contains("<pic:pic") {
        let doc_pr = js_regex!(r"<wp:docPr [^>]*\/?>")
            .exec(detect)
            .map_or("", |found| found.as_str());
        let alt = js_regex!(r#"\bdescr="([^"]+)""#)
            .exec(doc_pr)
            .and_then(|found| found.get(1))
            .or_else(|| {
                js_regex!(r#"\bname="([^"]+)""#)
                    .exec(doc_pr)
                    .and_then(|found| found.get(1))
            });
        let mut obj = Obj::of(base)
            .set("type", "passthrough")
            .set("label", "Image")
            .set("brokenImage", true);
        if let Some(alt) = alt.filter(|a| !a.is_empty()) {
            obj = obj.set("previewText", decode_entities(alt));
        }
        return Ok(Some(
            obj.spread(&image_meta(detect, Some(ctx))?.block).done()?,
        ));
    }
    if is_invisible_empty_shape(detect) {
        return Ok(Some(
            Obj::of(base)
                .set("type", "passthrough")
                .set("label", "Drawing object")
                .set("invisibleMarker", true)
                .done()?,
        ));
    }
    let decorative = is_thin_rule(detect);
    // a floating rule (connector line) leaves the paragraph's own empty line in the flow
    let anchored_rule = decorative && el.name == "w:p" && detect.contains("<wp:anchor");
    let rule_meta = if anchored_rule {
        Some(image_meta(detect, Some(ctx))?)
    } else {
        None
    };
    let mut obj = Obj::of(base)
        .set("type", "passthrough")
        .set("label", "Drawing object")
        .set("decorative", decorative);
    if decorative {
        obj = obj.spread(&rule_display_of(detect));
    }
    if anchored_rule {
        match anchor_line_of(xml, ctx)? {
            Some(line) => obj = obj.json("anchorLine", &line),
            None => obj = obj.set("anchorLine", Value::Object(Map::new())),
        }
    }
    if let Some(meta) = &rule_meta {
        if let Some(y) = *meta.block.image_offset_y_emu
            && meta.block.image_rel_v.is_none()
        {
            obj = obj.json("imageOffsetYEmu", &y);
        }
        if let Some(x) = *meta.block.image_offset_x_emu
            && meta.block.image_rel_h.is_none()
        {
            obj = obj.json("imageOffsetXEmu", &x);
        }
    }
    Ok(Some(obj.done()?))
}
