//! `objects/pictures.ts`: pictures and locked placeholders inside paragraphs.
//!
//! Forward: a drawing element of a paragraph (`draw:frame`, shapes, groups
//! ...) becomes one picture run. A frame holding one displayable `draw:image`
//! is an editable picture (`odt-pic:<id>`); anything else the editor cannot
//! change is a placeholder (`odt-keep:<id>:<kind>`) showing the file's
//! preview picture or the neutral picture, at the object's size. A text box
//! holding a table is left to the table owner (the converter declines it).
//!
//! Save: a placeholder writes its original bytes (size changes are ignored);
//! a picture writes its original frame, with `svg:width`/`svg:height` (and
//! the offsets of a floating picture) patched when they changed and the image
//! reference re-pointed at a new `Pictures/` entry when its bytes were
//! replaced; a picture the bridge never had becomes a new frame and entry.

use std::collections::HashSet;

use docx_engine::model::Run;
use jscompat::{JsNum, JsObject, Radix, js_regex, math_max, parse_int};
use serde_json::Value;

use crate::core::convert::{
    Attach, BridgeMarkerKind, EditedParagraph, Injection, InlineConverter, InlineElement,
    InlineEnv, InlineOoxml, MapBias, OdfToOoxmlContext, OoxmlToOdfContext, ParagraphInjector,
    ParagraphWriteEnv, RunWriter,
};
use crate::core::errors::OdtError;
use crate::core::styles::OdtStylePart;
use crate::core::xml::escape_xml_attr;
use crate::offset::U16;
use crate::text::style_xml::patch_start_tag;

use super::analyze::{
    AnalysisPreview, AnalysisType, DRAW_OBJECT_NAMES, ObjectElement, analyze_object, anchor_of,
};
use super::geometry::{
    DrawingAnchor, DrawingFacts, DrawingSpec, drawing_xml, emu_to_cm, read_drawing,
};
use super::media::{ImageFormat, data_url_bytes, same_bytes, sniff_image};
use super::model::{
    OBJECTS_OWNER, ObjectPicture, ObjectPlaceholder, keep_name, parse_keep_name,
    parse_picture_name, picture_name,
};
use super::notes::notes_run_writer;
use super::state::{
    EditedNames, add_picture_entry, bridge_media, forward_state, neutral_media, save_state,
    slice_u16, source_of,
};

// ---------------------------------------------------------------------------
// Forward

/// `drawingInlineConverter`
pub struct DrawingInlineConverter;

impl InlineConverter for DrawingInlineConverter {
    fn id(&self) -> &str {
        OBJECTS_OWNER
    }

    fn names(&self) -> &[&'static str] {
        &DRAW_OBJECT_NAMES
    }

    fn to_ooxml(
        &self,
        ctx: &mut OdfToOoxmlContext,
        el: &InlineElement,
        env: &InlineEnv,
    ) -> Result<Option<InlineOoxml>, OdtError> {
        // pictures in headers/footers need the header part's relationships: kept for now
        if el.part != OdtStylePart::ContentXml {
            return Ok(None);
        }
        let st = forward_state(ctx);
        if st.borrow().nested > 0 {
            return Ok(None);
        }
        let info = ctx.part(el.part);
        let doc = ctx.doc.clone();
        let a = analyze_object(
            &doc,
            el.part,
            &info.xml.text,
            &info.prefixes,
            &ObjectElement {
                name: &el.name,
                start: el.start,
                name_end: el.name_end,
                open_end: el.open_end,
                close_start: el.close_start,
            },
        );
        if a.r#type == AnalysisType::Skip {
            return Ok(None);
        }
        let id = {
            let mut st = st.borrow_mut();
            st.seq += 1;
            st.seq.to_string()
        };
        let anchor = anchor_of(&doc, el.part, &a.anchor);
        if a.r#type == AnalysisType::Picture
            && let Some(image) = &a.image
        {
            let r_id = bridge_media(ctx, &image.entry, &image.bytes, &image.format);
            let record = ObjectPicture {
                id: id.clone(),
                name: picture_name(&id),
                part: el.part,
                start: info.xml.to_u16(el.start),
                end: info.xml.to_u16(el.end),
                open_end: info.xml.to_u16(el.open_end),
                image_start: info.xml.to_u16(image.start),
                image_open_end: info.xml.to_u16(image.open_end),
                href: image.href.clone(),
                entry: image.entry.clone(),
                r_id: r_id.clone(),
                width_emu: JsNum(a.width_emu),
                height_emu: JsNum(a.height_emu),
                anchored: anchor.is_some(),
                x_emu: anchor.as_ref().and_then(|x| x.h.offset),
                y_emu: anchor.as_ref().and_then(|x| x.v.offset),
                paragraph: Some(env.paragraph_id),
                entries: a.entries.clone(),
            };
            let doc_pr_id = {
                let mut st = st.borrow_mut();
                st.doc_pr_seq += 1;
                st.doc_pr_seq
            };
            let xml = format!(
                "<w:r>{}</w:r>",
                drawing_xml(&DrawingSpec {
                    doc_pr_id: JsNum(doc_pr_id as f64),
                    name: record.name.clone(),
                    descr: None,
                    r_id,
                    cx: JsNum(a.width_emu),
                    cy: JsNum(a.height_emu),
                    anchor,
                })
            );
            st.borrow_mut().ext.pictures.push(record);
            return Ok(Some(InlineOoxml::Xml {
                xml,
                text: String::new(),
            }));
        }
        let placeholder = ObjectPlaceholder {
            id: id.clone(),
            kind: a.kind,
            name: keep_name(&id, a.kind),
            part: el.part,
            start: info.xml.to_u16(el.start),
            end: info.xml.to_u16(el.end),
            paragraph: Some(env.paragraph_id),
            block: None,
            element: None,
            width_emu: JsNum(a.width_emu),
            height_emu: JsNum(a.height_emu),
            preview: a.preview.is_some(),
            entries: a.entries.clone(),
            final_text: None,
        };
        st.borrow_mut().ext.placeholders.push(placeholder.clone());
        Ok(Some(InlineOoxml::Xml {
            xml: format!(
                "<w:r>{}</w:r>",
                placeholder_drawing(ctx, &placeholder, a.preview.as_ref(), anchor.as_ref())
            ),
            text: String::new(),
        }))
    }
}

/// `placeholderDrawing`: the `<w:drawing>` of a placeholder.
pub fn placeholder_drawing(
    ctx: &mut OdfToOoxmlContext,
    p: &ObjectPlaceholder,
    preview: Option<&AnalysisPreview>,
    anchor: Option<&DrawingAnchor>,
) -> String {
    let st = forward_state(ctx);
    let r_id = match preview {
        Some(preview) => bridge_media(
            ctx,
            &format!("#preview:{}", p.id),
            &preview.bytes,
            &preview.format,
        ),
        None => neutral_media(ctx),
    };
    let doc_pr_id = {
        let mut st = st.borrow_mut();
        st.doc_pr_seq += 1;
        st.doc_pr_seq
    };
    drawing_xml(&DrawingSpec {
        doc_pr_id: JsNum(doc_pr_id as f64),
        name: p.name.clone(),
        descr: None,
        r_id,
        cx: p.width_emu,
        cy: p.height_emu,
        anchor: anchor.cloned(),
    })
}

// ---------------------------------------------------------------------------
// Save

/// `writeDrawing`: writes the ODF for one picture or placeholder drawing of
/// the edited docx.
pub fn write_drawing(
    rctx: &mut OoxmlToOdfContext,
    xml: &str,
    data_url: Option<&str>,
    part: OdtStylePart,
) -> Result<String, OdtError> {
    let st = save_state(rctx)?;
    let facts = read_drawing(xml);
    let keep = facts.name.as_deref().and_then(parse_keep_name);
    if let Some(name) = &facts.name {
        st.borrow_mut().emitted_names.insert(name.clone());
    }
    if let Some(keep) = keep {
        let p = st.borrow().placeholder(&keep.id).cloned();
        let Some(p) = p else {
            rctx.warn(&format!(
                "dropped an unknown locked object {}",
                facts.name.as_deref().unwrap_or("")
            ));
            return Ok(String::new());
        };
        if p.block.is_some() {
            rctx.warn("a locked block object moved into a paragraph was dropped");
            return Ok(String::new());
        }
        return Ok(source_of(rctx, p.part, p.start, p.end));
    }
    let pic_id = facts.name.as_deref().and_then(parse_picture_name);
    let pic = pic_id
        .as_deref()
        .and_then(|id| st.borrow().picture(id).cloned());
    if let Some(pic) = pic {
        return write_existing_picture(rctx, &pic, &facts, data_url);
    }
    write_new_picture(rctx, &facts, data_url, part)
}

/// `writeExistingPicture`
fn write_existing_picture(
    rctx: &mut OoxmlToOdfContext,
    pic: &ObjectPicture,
    facts: &DrawingFacts,
    data_url: Option<&str>,
) -> Result<String, OdtError> {
    let st = save_state(rctx)?;
    let info = rctx.part(pic.part);
    let xml = &info.xml;
    let copy = st.borrow().emitted_pictures.contains(&pic.id);
    st.borrow_mut().emitted_pictures.insert(pic.id.clone());
    let mut overrides: JsObject<Option<String>> = JsObject::new();
    let cx = facts.cx.map_or(pic.width_emu.0, |n| n.0);
    let cy = facts.cy.map_or(pic.height_emu.0, |n| n.0);
    if cx != pic.width_emu.0 || cy != pic.height_emu.0 {
        overrides.set("svg:width", Some(emu_to_cm(cx)));
        overrides.set("svg:height", Some(emu_to_cm(cy)));
    }
    if pic.anchored && facts.anchored {
        if let (Some(px), Some(fx)) = (pic.x_emu, facts.x_offset)
            && fx.0 != px.0
        {
            overrides.set("svg:x", Some(emu_to_cm(fx.0)));
        }
        if let (Some(py), Some(fy)) = (pic.y_emu, facts.y_offset)
            && fy.0 != py.0
        {
            overrides.set("svg:y", Some(emu_to_cm(fy.0)));
        }
    }
    let mut inner = slice_u16(xml, pic.open_end, pic.end).to_string();
    if let Some(r_id) = &facts.r_id
        && *r_id != pic.r_id
    {
        let bytes = data_url_bytes(data_url);
        let original = rctx.doc.pkg.get(&pic.entry).map(|e| e.bytes.clone());
        match bytes {
            None => rctx.warn("a replaced picture could not be read; kept the original picture"),
            Some(bytes) => {
                if original.as_deref().is_none_or(|o| !same_bytes(&bytes, o)) {
                    let format =
                        sniff_image(&bytes).unwrap_or_else(|| format_of_data_url(data_url));
                    let path = add_picture_entry(rctx, &bytes, &format)?;
                    let mut href: JsObject<Option<String>> = JsObject::new();
                    href.set("xlink:href", Some(path));
                    let tag = patch_start_tag(
                        slice_u16(xml, pic.image_start, pic.image_open_end),
                        &info.prefixes,
                        &href,
                    )?;
                    inner = format!(
                        "{}{}{}",
                        slice_u16(xml, pic.open_end, pic.image_start),
                        tag,
                        slice_u16(xml, pic.image_open_end, pic.end)
                    );
                }
            }
        }
    }
    let mut open = slice_u16(xml, pic.start, pic.open_end).to_string();
    if !overrides.is_empty() {
        open = patch_start_tag(&open, &info.prefixes, &overrides)?;
    }
    // a copy must not repeat a unique frame name
    if copy {
        let mut unique: JsObject<Option<String>> = JsObject::new();
        unique.set("draw:name", None);
        unique.set("xml:id", None);
        open = patch_start_tag(&open, &info.prefixes, &unique)?;
    }
    Ok(format!("{open}{inner}"))
}

/// `formatOfDataUrl`
fn format_of_data_url(url: Option<&str>) -> ImageFormat {
    let mime = js_regex!(r"^data:([^;,]+)")
        .exec(url.unwrap_or(""))
        .and_then(|m| m.get(1))
        .unwrap_or("image/png")
        .to_string();
    let ext = js_regex!(r"/(?:x-)?([a-z0-9]+)")
        .exec(&mime)
        .and_then(|m| m.get(1))
        .unwrap_or("png")
        .to_string();
    ImageFormat { ext, mime }
}

/// `writeNewPicture`: a new picture: a new `Pictures/` entry and a new frame
/// with its own graphic style.
fn write_new_picture(
    rctx: &mut OoxmlToOdfContext,
    facts: &DrawingFacts,
    data_url: Option<&str>,
    part: OdtStylePart,
) -> Result<String, OdtError> {
    let bytes = data_url_bytes(data_url);
    let bytes = match bytes {
        Some(bytes) if !bytes.is_empty() => bytes,
        _ => {
            rctx.warn("dropped a new picture whose bytes are not available");
            return Ok(String::new());
        }
    };
    let format = sniff_image(&bytes).unwrap_or_else(|| format_of_data_url(data_url));
    let path = add_picture_entry(rctx, &bytes, &format)?;
    let st = save_state(rctx)?;
    if st.borrow().z_index.is_none() {
        let mut max = -1.0;
        let doc = rctx.doc.clone();
        for m in js_regex!(r#"draw:z-index\s*=\s*"(\d+)""#, "g").find_iter(&doc.content_xml.text) {
            max = math_max(max, parse_int(m.get(1).unwrap_or(""), Radix::Ten));
        }
        st.borrow_mut().z_index = Some(max + 1.0);
    }
    let z = {
        let mut st = st.borrow_mut();
        let z = st.z_index.unwrap_or(0.0);
        st.z_index = Some(z + 1.0);
        z
    };
    let anchored = facts.anchored;
    let props = if anchored {
        "style:wrap=\"parallel\" style:horizontal-pos=\"from-left\" style:horizontal-rel=\"paragraph\" style:vertical-pos=\"from-top\" style:vertical-rel=\"paragraph\""
    } else {
        "style:vertical-pos=\"top\" style:vertical-rel=\"baseline\""
    };
    let style = rctx.derived_style(
        part,
        &format!("objects-graphic:{}", if anchored { "anchor" } else { "inline" }),
        "fr",
        |name| {
            format!(
                "<style:style style:name=\"{}\" style:family=\"graphic\"><style:graphic-properties {props} fo:border=\"none\" fo:padding=\"0cm\"/></style:style>",
                escape_xml_attr(name)
            )
        },
    );
    let cx = facts.cx.map_or(914400.0, |n| n.0);
    let cy = facts.cy.map_or(914400.0, |n| n.0);
    let position = if anchored {
        format!(
            " svg:x=\"{}\" svg:y=\"{}\"",
            emu_to_cm(facts.x_offset.map_or(0.0, |n| n.0)),
            emu_to_cm(facts.y_offset.map_or(0.0, |n| n.0))
        )
    } else {
        String::new()
    };
    Ok(format!(
        "<draw:frame draw:style-name=\"{}\" text:anchor-type=\"{}\"{position} svg:width=\"{}\" svg:height=\"{}\" draw:z-index=\"{}\">\
<draw:image xlink:href=\"{}\" xlink:type=\"simple\" xlink:show=\"embed\" xlink:actuate=\"onLoad\"/></draw:frame>",
        escape_xml_attr(&style),
        if anchored { "paragraph" } else { "as-char" },
        emu_to_cm(cx),
        emu_to_cm(cy),
        jscompat::number_to_string(z),
        escape_xml_attr(&path),
    ))
}

/// `objectsRunWriter`: picture runs and note references of edited paragraphs.
pub struct ObjectsRunWriter;

impl RunWriter for ObjectsRunWriter {
    fn id(&self) -> &str {
        OBJECTS_OWNER
    }

    fn matches(&self, run: &Run) -> bool {
        run.image.is_some() || run.note_ref.is_some()
    }

    fn to_odf(
        &self,
        rctx: &mut OoxmlToOdfContext,
        run: &Run,
        env: &ParagraphWriteEnv<'_>,
    ) -> Result<String, OdtError> {
        if let Some(note_ref) = run.note_ref.as_ref() {
            return notes_run_writer(rctx, note_ref, env);
        }
        let Some(image) = run.image.as_ref() else {
            return Ok(String::new());
        };
        if image.rule.is_some() || !js_regex!(r"<w:drawing>").test(&image.xml) {
            rctx.warn("dropped a picture the ODT cannot hold");
            return Ok(String::new());
        }
        write_drawing(rctx, &image.xml, Some(image.data_url.as_str()), env.part)
    }
}

// ---------------------------------------------------------------------------
// Pictures the engine could not read

/// `editedNames`: every `wp:docPr` name in the edited body XML, and those
/// carried by a picture run. The TypeScript walks the block objects; the
/// blocks are walked here as their JSON, which has the same objects, arrays
/// and keys.
fn edited_names(rctx: &OoxmlToOdfContext) -> Result<EditedNames, OdtError> {
    let st = save_state(rctx)?;
    if let Some(found) = st.borrow().edited_names.clone() {
        return Ok(found);
    }
    let mut xml: HashSet<String> = HashSet::new();
    let mut runs: HashSet<String> = HashSet::new();
    fn visit(value: &Value, runs: &mut HashSet<String>) {
        match value {
            Value::Array(items) => {
                for v in items {
                    visit(v, runs);
                }
            }
            Value::Object(o) => {
                let image_xml = o
                    .get("image")
                    .and_then(|image| image.get("xml"))
                    .and_then(Value::as_str);
                if let (Some(_), Some(image_xml)) =
                    (o.get("text").and_then(Value::as_str), image_xml)
                    && let Some(name) = read_drawing(image_xml).name
                {
                    runs.insert(name);
                }
                for (k, v) in o {
                    if k != "originalXml" && (v.is_object() || v.is_array() || v.is_null()) {
                        visit(v, runs);
                    }
                }
            }
            _ => {}
        }
    }
    let edited = rctx.edited.clone();
    for b in edited.blocks.iter() {
        let original = b
            .original_xml
            .as_ref()
            .and_then(|x| x.as_deref())
            .unwrap_or("");
        for m in js_regex!(r#"<wp:docPr\b[^>]*\bname="([^"]*)""#, "g").find_iter(original) {
            xml.insert(m.get(1).unwrap_or("").to_string());
        }
        if let Ok(value) = serde_json::to_value(b) {
            visit(&value, &mut runs);
        }
    }
    let names = EditedNames { xml, runs };
    st.borrow_mut().edited_names = Some(names.clone());
    Ok(names)
}

/// `droppedDrawingInjector`: a picture the docx engine cannot read where the
/// save runs (a metafile without a canvas, a broken picture) has no run in the
/// edited paragraph although its drawing is still in the edited XML. Such
/// objects are written back at their original position instead of being
/// dropped.
pub struct DroppedDrawingInjector;

impl ParagraphInjector for DroppedDrawingInjector {
    fn id(&self) -> &str {
        OBJECTS_OWNER
    }

    fn inject(
        &self,
        rctx: &mut OoxmlToOdfContext,
        _para: &EditedParagraph,
        env: &ParagraphWriteEnv<'_>,
    ) -> Result<Vec<Injection>, OdtError> {
        let Some(origin) = env.origin.as_ref() else {
            return Ok(Vec::new());
        };
        let handlers: Vec<_> = origin
            .markers
            .iter()
            .filter(|m| {
                m.kind == BridgeMarkerKind::Handler
                    && m.owner.as_deref() == Some(OBJECTS_OWNER)
                    && DRAW_OBJECT_NAMES.contains(&m.name.as_str())
            })
            .collect();
        if handlers.is_empty() {
            return Ok(Vec::new());
        }
        let st = save_state(rctx)?;
        let mut out = Vec::new();
        for m in handlers {
            let object: Option<(String, OdtStylePart, U16, U16)> = {
                let st = st.borrow();
                st.ext
                    .pictures
                    .iter()
                    .find(|p| p.part == origin.part && p.start == m.start)
                    .map(|p| (p.name.clone(), p.part, p.start, p.end))
                    .or_else(|| {
                        st.ext
                            .placeholders
                            .iter()
                            .find(|p| p.part == origin.part && p.start == m.start)
                            .map(|p| (p.name.clone(), p.part, p.start, p.end))
                    })
            };
            let Some((name, part, start, end)) = object else {
                continue;
            };
            if st.borrow().emitted_names.contains(&name) {
                continue;
            }
            let names = edited_names(rctx)?;
            if names.runs.contains(&name) || !names.xml.contains(&name) {
                continue;
            }
            st.borrow_mut().emitted_names.insert(name);
            out.push(Injection {
                offset: env.map_offset(m.offset, MapBias::Start),
                xml: source_of(rctx, part, start, end),
                attach: Some(Attach::Next),
            });
        }
        Ok(out)
    }
}
