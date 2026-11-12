//! Ink drawings (packages/docx-engine/src/ink.ts). Each saved annotation is
//! a floating picture, an anchored `<w:drawing>` run in its paragraph, whose
//! wp:docPr name starts with `aidocs-ink` and whose descr carries the
//! editor's stroke payload.

use jscompat::{JsNum, JsRegex, Radix, js_regex, math_max, math_round, parse_int};
use serde::Serialize;

use crate::generate::escape_xml_attr;
use crate::model::NewInkImage;
use crate::xml_number::{
    non_finite, xml_id, xml_position_offset, xml_positive_coordinate, xml_unsigned_int,
};

/// `INK_NAME_PREFIX`
pub const INK_NAME_PREFIX: &str = "aidocs-ink";

/// `INK_MEDIA_PREFIX`: media filename prefix for ink PNGs.
pub const INK_MEDIA_PREFIX: &str = "aidocsink";

/// `INK_REL_RE`: a document.xml.rels entry that targets an ink media part.
/// The TypeScript builds it from `INK_MEDIA_PREFIX`; the pattern is that text.
pub fn ink_rel_re() -> &'static JsRegex {
    js_regex!(
        r#"<Relationship [^>]*Target="media/aidocsink\d+\.png"[^>]*/>"#,
        "g"
    )
}

/// `INK_MEDIA_PATH_RE`: an ink media part's zip path.
pub fn ink_media_path_re() -> &'static JsRegex {
    js_regex!(r"^word/media/aidocsink\d+\.png$", "")
}

const EMU_PER_PX: f64 = 9525.0;

const A_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const WP_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const R_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// `anchoredInkRunXml`: the anchored-picture run for one ink annotation.
/// Reads only widthPx, heightPx, offsetXPx, offsetYPx and payload of `ink`.
/// A number with no XML text (`xml_number`) refuses the call, as the
/// TypeScript throws `RangeError`.
pub fn anchored_ink_run_xml(
    ink: &NewInkImage,
    r_id: &str,
    doc_pr_id: JsNum,
) -> Result<String, String> {
    let safe_px = |v: JsNum, fallback: f64| -> f64 {
        if v.0.is_finite() {
            math_round(v.0 * EMU_PER_PX)
        } else {
            fallback
        }
    };
    let cx = xml_positive_coordinate(math_max(1.0, safe_px(ink.width_px, 1.0)))
        .ok_or_else(|| non_finite("widthPx"))?;
    let cy = xml_positive_coordinate(math_max(1.0, safe_px(ink.height_px, 1.0)))
        .ok_or_else(|| non_finite("heightPx"))?;
    let x = xml_position_offset(safe_px(ink.offset_x_px, 0.0))
        .ok_or_else(|| non_finite("offsetXPx"))?;
    let y = xml_position_offset(safe_px(ink.offset_y_px, 0.0))
        .ok_or_else(|| non_finite("offsetYPx"))?;
    let id = xml_id(doc_pr_id.0).ok_or_else(|| non_finite("docPrId"))?;
    let relative_height =
        xml_unsigned_int(251658240.0 + doc_pr_id.0).ok_or_else(|| non_finite("docPrId"))?;
    let name = format!("{INK_NAME_PREFIX} {id}");
    let descr = match ink.payload.as_deref() {
        Some(payload) if !payload.is_empty() => format!(" descr=\"{}\"", escape_xml_attr(payload)),
        _ => String::new(),
    };
    Ok(String::from("<w:r><w:drawing>")
        + &format!(
            "<wp:anchor xmlns:wp=\"{WP_NS}\" distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\" simplePos=\"0\""
        )
        + &format!(
            " relativeHeight=\"{relative_height}\" behindDoc=\"0\" locked=\"0\" layoutInCell=\"1\" allowOverlap=\"1\">"
        )
        + "<wp:simplePos x=\"0\" y=\"0\"/>"
        + &format!(
            "<wp:positionH relativeFrom=\"column\"><wp:posOffset>{x}</wp:posOffset></wp:positionH>"
        )
        + &format!(
            "<wp:positionV relativeFrom=\"paragraph\"><wp:posOffset>{y}</wp:posOffset></wp:positionV>"
        )
        + &format!("<wp:extent cx=\"{cx}\" cy=\"{cy}\"/>")
        + "<wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/>"
        + "<wp:wrapNone/>"
        + &format!("<wp:docPr id=\"{id}\" name=\"{name}\"{descr}/>")
        + "<wp:cNvGraphicFramePr/>"
        + &format!("<a:graphic xmlns:a=\"{A_NS}\">")
        + &format!("<a:graphicData uri=\"{PIC_NS}\">")
        + &format!("<pic:pic xmlns:pic=\"{PIC_NS}\">")
        + &format!(
            "<pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr>"
        )
        + &format!(
            "<pic:blipFill><a:blip xmlns:r=\"{R_NS}\" r:embed=\"{r_id}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>"
        )
        + &format!(
            "<pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>"
        )
        + "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>"
        + "</pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>")
}

/// `ANCHOR_RUN_RE`
fn anchor_run_re() -> &'static JsRegex {
    js_regex!(
        r"<w:r><w:drawing><wp:anchor[\s\S]*?<\/wp:anchor><\/w:drawing><\/w:r>",
        "g"
    )
}

/// `isInkRun`
fn is_ink_run(run: &str) -> bool {
    run.contains(&format!("name=\"{INK_NAME_PREFIX}"))
}

/// `stripInkRuns`: remove every aidocs-ink run from a body-element XML slice.
pub fn strip_ink_runs(xml: &str) -> String {
    if !xml.contains(INK_NAME_PREFIX) {
        return xml.to_owned();
    }
    anchor_run_re().replace_all(xml, |found| {
        let run = found.as_str();
        if is_ink_run(run) {
            String::new()
        } else {
            run.to_owned()
        }
    })
}

/// `InkRunMatch`: one raw ink run found in a paragraph's XML.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InkRunMatch {
    pub xml: String,
    pub offset_x_px: JsNum,
    pub offset_y_px: JsNum,
    pub width_px: JsNum,
    pub height_px: JsNum,
    pub payload: Option<String>,
    pub embed_r_id: Option<String>,
}

/// `findInkRuns`: aidocs-ink anchored runs inside one paragraph's XML.
pub fn find_ink_runs(paragraph_xml: &str) -> Vec<InkRunMatch> {
    if !paragraph_xml.contains(INK_NAME_PREFIX) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for found in anchor_run_re().find_iter(paragraph_xml) {
        let run = found.as_str();
        if !is_ink_run(run) {
            continue;
        }
        // parseInt(value ?? '0', 10) || 0: NaN and -0 are 0
        let emu = |value: Option<&str>| -> f64 {
            let n = parse_int(value.unwrap_or("0"), Radix::Ten);
            if n == 0.0 || n.is_nan() { 0.0 } else { n }
        };
        let descr = js_regex!(r#"<wp:docPr [^>]*descr="([^"]*)""#, "")
            .exec(run)
            .and_then(|m| m.get(1));
        let extent = js_regex!(r"<wp:extent[^>]*\/?>", "")
            .exec(run)
            .map_or("", |m| m.as_str());
        out.push(InkRunMatch {
            xml: run.to_owned(),
            offset_x_px: JsNum(
                emu(js_regex!(r"<wp:positionH[^>]*><wp:posOffset>(-?\d+)", "")
                    .exec(run)
                    .and_then(|m| m.get(1)))
                    / EMU_PER_PX,
            ),
            offset_y_px: JsNum(
                emu(js_regex!(r"<wp:positionV[^>]*><wp:posOffset>(-?\d+)", "")
                    .exec(run)
                    .and_then(|m| m.get(1)))
                    / EMU_PER_PX,
            ),
            width_px: JsNum(
                emu(js_regex!(r#"\bcx="(\d+)""#, "")
                    .exec(extent)
                    .and_then(|m| m.get(1)))
                    / EMU_PER_PX,
            ),
            height_px: JsNum(
                emu(js_regex!(r#"\bcy="(\d+)""#, "")
                    .exec(extent)
                    .and_then(|m| m.get(1)))
                    / EMU_PER_PX,
            ),
            payload: match descr {
                Some(descr) if !descr.is_empty() => Some(decode_xml_entities(descr)),
                _ => None,
            },
            embed_r_id: js_regex!(r#"r:embed="([^"]+)""#, "")
                .exec(run)
                .and_then(|m| m.get(1))
                .map(str::to_owned),
        });
    }
    out
}

/// `injectInkRunsIntoParagraph`: ink runs at the end of a paragraph fragment,
/// or `None` (null) where the fragment's root is not a w:p.
pub fn inject_ink_runs_into_paragraph(xml: &str, runs_xml: &str) -> Option<String> {
    if !js_regex!(r"^<w:p[\s/>]", "").test(xml) {
        return None;
    }
    if let Some(open) = xml.strip_suffix("/>") {
        return Some(format!("{open}>{runs_xml}</w:p>"));
    }
    let close = xml.rfind("</w:p>")?;
    Some(format!("{}{runs_xml}{}", &xml[..close], &xml[close..]))
}

/// `decodeXmlEntities`: `&amp;` last, so `&amp;lt;` reads as `&lt;`.
fn decode_xml_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}
