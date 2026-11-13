//! SmartArt (simplified) (packages/pptx-engine/src/smartart.ts): a `<p:grpSp>`
//! shape group generated from a preset layout.

use jscompat::{math_round, number_to_string};
use serde::{Deserialize, Serialize};

use crate::deck::{OpenedPptx, append_raw_elements};
use crate::generate::hangul_lang;
use crate::insert::next_c_nv_pr_id;
use crate::smartart_layout::{SmartArtChildShape, layout_shapes};
use crate::types::{EmuRect, Slide};
use crate::xml_utils::{creation_id_xml, escape_xml_attr, escape_xml_text};

/// `SmartArtLayout`: list / process / cycle / hierarchy / pyramid / matrix / venn.
pub type SmartArtLayout = String;

/// `NewSmartArtOptions`
#[derive(Debug, Clone, Deserialize)]
pub struct NewSmartArtOptions {
    pub layout: SmartArtLayout,
    /// Text for each node (determines node count, 1..8)
    pub items: Vec<String>,
    pub offset: EmuRect,
}

fn num(x: f64) -> String {
    number_to_string(x)
}

/// Fragment for a single child shape (in child coordinate space).
fn child_sp_xml(id: f64, s: &SmartArtChildShape) -> String {
    let para = match s.text.as_deref().filter(|t| !t.is_empty()) {
        Some(text) => format!(
            "<a:p><a:pPr algn=\"ctr\"/><a:r><a:rPr{} sz=\"{}\" b=\"1\">\
             <a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill></a:rPr>\
             <a:t>{}</a:t></a:r></a:p>",
            hangul_lang(text).map_or_else(String::new, |lang| format!(" lang=\"{lang}\"")),
            num(math_round(s.font_size.map_or(14.0, |f| f.0) * 100.0)),
            escape_xml_text(text)
        ),
        None => "<a:p/>".to_owned(),
    };
    let alpha = match s.alpha {
        Some(a) if a.0 < 1.0 => format!("<a:alpha val=\"{}\"/>", num(math_round(a.0 * 100000.0))),
        _ => String::new(),
    };
    let id_text = num(id);
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id_text}\" name=\"{name}\"/>\
         <p:cNvSpPr/><p:nvPr/></p:nvSpPr>\
         <p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
         <a:prstGeom prst=\"{prst}\"><a:avLst/></a:prstGeom>\
         <a:solidFill><a:srgbClr val=\"{color}\">{alpha}</a:srgbClr></a:solidFill></p:spPr>\
         <p:txBody><a:bodyPr wrap=\"square\" anchor=\"ctr\" rtlCol=\"0\"><a:normAutofit/></a:bodyPr>\
         <a:lstStyle/>{para}</p:txBody></p:sp>",
        name = escape_xml_attr(&format!("SmartShape {id_text}")),
        x = num(s.r#box.x.0),
        y = num(s.r#box.y.0),
        cx = num(s.r#box.cx.0),
        cy = num(s.r#box.cy.0),
        prst = s.prst,
        color = s.color,
    )
}

/// Build the grpSp group fragment. `uuid` is what `crypto.randomUUID()` gives
/// `creationIdXml`.
pub fn build_smart_art_xml(slide: &Slide, opts: &NewSmartArtOptions, uuid: &str) -> String {
    let base_id = next_c_nv_pr_id(slide);
    let o = &opts.offset;
    let shapes = layout_shapes(&opts.layout, &opts.items, o.cx.0, o.cy.0);
    let children: String = shapes
        .iter()
        .enumerate()
        .map(|(i, s)| child_sp_xml(base_id + 1.0 + i as f64, s))
        .collect();
    let base = num(base_id);
    format!(
        "<p:grpSp><p:nvGrpSpPr><p:cNvPr id=\"{base}\" name=\"SmartArt {base}\">{creation}</p:cNvPr>\
         <p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\
         <p:grpSpPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/>\
         <a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm></p:grpSpPr>\
         {children}</p:grpSp>",
        creation = creation_id_xml(uuid),
        x = num(o.x.0),
        y = num(o.y.0),
        cx = num(o.cx.0),
        cy = num(o.cy.0),
    )
}

/// `{ slide, elementId }` of `addSmartArt` without the slide (it is
/// `opened.deck.slides[slide_index]`). `elementId` is absent when the reparse
/// kept no new element.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartArtAdded {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_id: Option<String>,
}

/// Insert SmartArt (shape-group version): append + reparse. `None` where the
/// slide is missing or `items` is empty.
pub fn add_smart_art(
    opened: &mut OpenedPptx,
    slide_index: usize,
    opts: &NewSmartArtOptions,
    uuid: &str,
) -> Result<Option<SmartArtAdded>, String> {
    let xml = {
        let Some(slide) = opened.deck.slides.get(slide_index) else {
            return Ok(None);
        };
        if opts.items.is_empty() {
            return Ok(None);
        }
        build_smart_art_xml(slide, opts, uuid)
    };
    let ids = append_raw_elements(opened, slide_index, &[xml])?;
    Ok(ids.map(|ids| SmartArtAdded {
        element_id: ids.last().cloned(),
    }))
}
