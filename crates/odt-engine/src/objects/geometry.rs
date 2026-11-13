//! `objects/geometry.ts`: lengths and the OOXML drawing markup of bridge
//! pictures.

use jscompat::{
    JsNum, Radix, js_regex, math_max, math_min, math_round, number_to_string, parse_float,
    parse_int,
};
use serde::{Deserialize, Serialize};

use crate::core::xml::escape_xml_attr;

/// `EMU_PER_CM`
pub const EMU_PER_CM: f64 = 360000.0;

/// `lengthToEmu`: an ODF length (`4.547cm`, `12pt`, `1in` ...) in EMU, or
/// `None`.
pub fn length_to_emu(value: Option<&str>) -> Option<f64> {
    let value = jscompat::truthy(value)?;
    let m = js_regex!(r"^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(cm|mm|in|inch|pt|pc|px)?\s*$")
        .exec(value)?;
    let n = parse_float(m.get(1)?);
    if !n.is_finite() {
        return None;
    }
    let unit = m.get(2).unwrap_or("cm");
    // an own-key table of the six units
    let per = match unit {
        "cm" => EMU_PER_CM,
        "mm" => 36000.0,
        "in" => 914400.0,
        "inch" => 914400.0,
        "pt" => 12700.0,
        "pc" => 152400.0,
        "px" => 9525.0,
        _ => f64::NAN,
    };
    Some(math_round(n * per))
}

/// `emuToCm`: EMU as an ODF centimetre length with at most three decimals
/// (`2cm`, `4.763cm`).
pub fn emu_to_cm(emu: f64) -> String {
    let cm = math_round((emu / EMU_PER_CM) * 1000.0) / 1000.0;
    format!("{}cm", number_to_string(cm))
}

/// `DrawingAnchor.h` / `.v`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorAxis {
    pub relative_from: String,
    pub offset: Option<JsNum>,
    pub align: Option<String>,
}

/// `DrawingAnchor.wrap`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AnchorWrap {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "square")]
    Square,
    #[serde(rename = "topAndBottom")]
    TopAndBottom,
}

/// `DrawingAnchor`: placement of a floating drawing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DrawingAnchor {
    pub h: AnchorAxis,
    pub v: AnchorAxis,
    pub wrap: AnchorWrap,
    pub behind: bool,
    pub z: JsNum,
}

/// `DrawingSpec`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawingSpec {
    pub doc_pr_id: JsNum,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub descr: Option<String>,
    pub r_id: String,
    pub cx: JsNum,
    pub cy: JsNum,
    /// `None` is inline (`wp:inline`)
    pub anchor: Option<DrawingAnchor>,
}

const PIC_URI: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";

/// `drawingXml`: the `<w:drawing>` of one picture.
pub fn drawing_xml(spec: &DrawingSpec) -> String {
    let cx = number_to_string(math_max(1.0, math_round(spec.cx.0)));
    let cy = number_to_string(math_max(1.0, math_round(spec.cy.0)));
    let name = escape_xml_attr(&spec.name);
    let descr = match jscompat::truthy(spec.descr.as_deref()) {
        Some(d) => format!(" descr=\"{}\"", escape_xml_attr(d)),
        None => String::new(),
    };
    let doc_pr_id = number_to_string(spec.doc_pr_id.0);
    let doc_pr = format!("<wp:docPr id=\"{doc_pr_id}\" name=\"{name}\"{descr}/>");
    let graphic = format!(
        "<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>\
<a:graphic><a:graphicData uri=\"{PIC_URI}\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"{doc_pr_id}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr>\
<pic:blipFill><a:blip r:embed=\"{}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
<pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>\
</pic:pic></a:graphicData></a:graphic>",
        escape_xml_attr(&spec.r_id)
    );
    let extent = format!(
        "<wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/>"
    );
    let Some(a) = &spec.anchor else {
        return format!(
            "<w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">{extent}{doc_pr}{graphic}</wp:inline></w:drawing>"
        );
    };
    let pos = |axis: char, p: &AnchorAxis| {
        let inner = match &p.align {
            Some(align) => format!("<wp:align>{align}</wp:align>"),
            None => format!(
                "<wp:posOffset>{}</wp:posOffset>",
                number_to_string(math_round(p.offset.map_or(0.0, |o| o.0)))
            ),
        };
        format!(
            "<wp:position{axis} relativeFrom=\"{}\">{inner}</wp:position{axis}>",
            p.relative_from
        )
    };
    let wrap = match a.wrap {
        AnchorWrap::None => "<wp:wrapNone/>",
        AnchorWrap::Square => "<wp:wrapSquare wrapText=\"bothSides\"/>",
        AnchorWrap::TopAndBottom => "<wp:wrapTopAndBottom/>",
    };
    format!(
        "<w:drawing><wp:anchor distT=\"0\" distB=\"0\" distL=\"114300\" distR=\"114300\" simplePos=\"0\" relativeHeight=\"{}\" \
behindDoc=\"{}\" locked=\"0\" layoutInCell=\"1\" allowOverlap=\"1\"><wp:simplePos x=\"0\" y=\"0\"/>\
{}{}{extent}{wrap}{doc_pr}{graphic}</wp:anchor></w:drawing>",
        number_to_string(251658240.0 + math_max(0.0, math_min(1000000.0, a.z.0))),
        if a.behind { 1 } else { 0 },
        pos('H', &a.h),
        pos('V', &a.v),
    )
}

/// `DrawingFacts`: facts the save path reads back from an edited
/// `<w:drawing>`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawingFacts {
    pub name: Option<String>,
    pub cx: Option<JsNum>,
    pub cy: Option<JsNum>,
    pub r_id: Option<String>,
    pub anchored: bool,
    pub x_offset: Option<JsNum>,
    pub y_offset: Option<JsNum>,
}

/// `decodeAttr`
fn decode_attr(v: &str) -> String {
    v.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// `readDrawing`
pub fn read_drawing(xml: &str) -> DrawingFacts {
    let doc_pr = js_regex!(r"<wp:docPr\b[^>]*>")
        .exec(xml)
        .map_or("", |m| m.as_str());
    let name = js_regex!(r#"\bname\s*=\s*"([^"]*)""#)
        .exec(doc_pr)
        .and_then(|m| m.get(1));
    let extent = js_regex!(r"<wp:extent\b[^>]*>")
        .exec(xml)
        .map_or("", |m| m.as_str());
    let num = |tag: &str, attr: &str| -> Option<JsNum> {
        let found = match attr {
            "cx" => js_regex!(r#"\bcx\s*=\s*"(-?\d+)""#).exec(tag),
            _ => js_regex!(r#"\bcy\s*=\s*"(-?\d+)""#).exec(tag),
        };
        found
            .and_then(|m| m.get(1))
            .map(|v| JsNum(parse_int(v, Radix::Ten)))
    };
    let offset = |axis: char| -> Option<JsNum> {
        let found =
            match axis {
                'H' => js_regex!(r"<wp:positionH\b[^>]*>\s*<wp:posOffset>(-?\d+)</wp:posOffset>")
                    .exec(xml),
                _ => js_regex!(r"<wp:positionV\b[^>]*>\s*<wp:posOffset>(-?\d+)</wp:posOffset>")
                    .exec(xml),
            };
        found
            .and_then(|m| m.get(1))
            .map(|v| JsNum(parse_int(v, Radix::Ten)))
    };
    DrawingFacts {
        name: name.map(decode_attr),
        cx: num(extent, "cx"),
        cy: num(extent, "cy"),
        r_id: js_regex!(r#"<a:blip\b[^>]*\br:embed\s*=\s*"([^"]+)""#)
            .exec(xml)
            .and_then(|m| m.get(1))
            .map(str::to_string),
        anchored: js_regex!(r"<wp:anchor\b").test(xml),
        x_offset: offset('H'),
        y_offset: offset('V'),
    }
}

/// `drawingsOf`: every `<w:drawing>` fragment of an OOXML string, in order.
pub fn drawings_of(xml: &str) -> Vec<String> {
    js_regex!(r"<w:drawing>[\s\S]*?</w:drawing>", "g")
        .find_iter(xml)
        .map(|m| m.as_str().to_string())
        .collect()
}
