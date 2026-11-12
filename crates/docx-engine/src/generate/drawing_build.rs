//! The fresh drawing builders of generate.ts: a line, an inline picture, a
//! text box, an anchored text box region, a preset shape and WordArt.

use jscompat::{math_max as js_max, math_min as js_min, math_round, number_to_string, to_number};
use serde::{Deserialize, Deserializer, Serialize};

use super::props::{PPR_CHILD_ORDER, format_p_pr_children};
use super::runs::inline_runs_xml;
use super::{escape_xml_attr, escape_xml_text};
use crate::model::{ParaFormat, Run};

const EMU_PER_PX: f64 = 9525.0;
const EMU_PER_PT: f64 = 12700.0;

const MC_NS: &str = "xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\"";

/// `NEW_PICTURE_TOKEN_PREFIX`
pub const NEW_PICTURE_TOKEN_PREFIX: &str = "aidocs-new-pic-";

fn num(x: f64) -> String {
    number_to_string(x)
}

fn truthy(x: Option<f64>) -> bool {
    matches!(x, Some(x) if x != 0.0 && !x.is_nan())
}

fn str_truthy(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

/// An optional key whose `null` is kept apart from its absence.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<f64>>, D::Error> {
    wire_opt(d).map(Some)
}

/// A number that crossed the wire as JSON, or as text read with `Number`
/// (the only way NaN and the infinities cross).
#[derive(Deserialize)]
#[serde(untagged)]
enum WireNum {
    Number(f64),
    Text(String),
}

impl WireNum {
    fn value(self) -> f64 {
        match self {
            WireNum::Number(n) => n,
            WireNum::Text(text) => to_number(&text),
        }
    }
}

fn wire<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    WireNum::deserialize(d).map(WireNum::value)
}

fn wire_opt<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Option::<WireNum>::deserialize(d).map(|n| n.map(WireNum::value))
}

/// Main policy, ahead of the TypeScript fix: a non-finite value is ignored
/// (read as absent), never written as `NaN` or `Infinity`.
fn fin(x: Option<f64>) -> Option<f64> {
    x.filter(|x| x.is_finite())
}

/// A required non-finite number becomes `fallback`.
fn fin_or(x: f64, fallback: f64) -> f64 {
    if x.is_finite() { x } else { fallback }
}

/// One entry of `LINE_KINDS`.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct LineKind {
    pub prst: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tail: Option<bool>,
}

/// `ownValue(LINE_KINDS, kind)`
pub fn line_kind(kind: &str) -> Option<LineKind> {
    let (prst, head, tail) = match kind {
        "line" => ("line", None, None),
        "lineArrow" => ("straightConnector1", None, Some(true)),
        "lineArrowDouble" => ("straightConnector1", Some(true), Some(true)),
        "lineBent" => ("bentConnector3", None, None),
        "lineCurved" => ("curvedConnector3", None, None),
        _ => return None,
    };
    Some(LineKind { prst, head, tail })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineOptions {
    pub kind: String,
    #[serde(default, deserialize_with = "wire_opt")]
    pub width_emu: Option<f64>,
    #[serde(default, deserialize_with = "wire_opt")]
    pub height_emu: Option<f64>,
    #[serde(default, deserialize_with = "wire_opt")]
    pub id: Option<f64>,
    pub color_hex: Option<String>,
}

/// The `<wp:anchor>` the cursor-position builders share.
fn centered_anchor(width_emu: &str, height_emu: &str, doc_pr: &str, graphic: &str) -> String {
    format!(
        "<wp:anchor xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" distT=\"0\" distB=\"0\" distL=\"114300\" distR=\"114300\" simplePos=\"0\" relativeHeight=\"251658240\" behindDoc=\"0\" locked=\"0\" layoutInCell=\"1\" allowOverlap=\"1\"><wp:simplePos x=\"0\" y=\"0\"/><wp:positionH relativeFrom=\"column\"><wp:align>center</wp:align></wp:positionH><wp:positionV relativeFrom=\"paragraph\"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx=\"{width_emu}\" cy=\"{height_emu}\"/><wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/><wp:wrapSquare wrapText=\"bothSides\"/>{doc_pr}{graphic}</wp:anchor>"
    )
}

fn wps_graphic(wsp: &str) -> String {
    format!(
        "<a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:graphicData xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" uri=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\">{wsp}</a:graphicData></a:graphic>"
    )
}

fn alternate_paragraph(anchor: &str, vml: &str) -> String {
    format!(
        "<w:p><w:r><mc:AlternateContent {MC_NS}><mc:Choice Requires=\"wps\"><w:drawing>{anchor}</w:drawing></mc:Choice><mc:Fallback><w:pict>{vml}</w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>"
    )
}

/// `buildLineParagraphXml`
pub fn build_line_paragraph_xml(opts: &LineOptions) -> String {
    let def = line_kind(&opts.kind)
        .or_else(|| line_kind("line"))
        .expect("LINE_KINDS.line");
    let width_emu = fin(opts.width_emu).unwrap_or(1800000.0);
    let height_emu = fin(opts.height_emu).unwrap_or(114300.0);
    let id = num(fin(opts.id).unwrap_or(1.0));
    let color_hex = opts.color_hex.as_deref().unwrap_or("000000");
    let (w, h) = (num(width_emu), num(height_emu));

    let ln = format!(
        "<a:ln w=\"12700\"><a:solidFill><a:srgbClr val=\"{color_hex}\"/></a:solidFill>{}{}</a:ln>",
        if def.head == Some(true) {
            "<a:headEnd type=\"triangle\"/>"
        } else {
            ""
        },
        if def.tail == Some(true) {
            "<a:tailEnd type=\"triangle\"/>"
        } else {
            ""
        },
    );
    let sp_pr = format!(
        "<wps:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{w}\" cy=\"{h}\"/></a:xfrm><a:prstGeom prst=\"{}\"><a:avLst/></a:prstGeom><a:noFill/>{ln}</wps:spPr>",
        def.prst
    );
    let wsp = format!(
        "<wps:wsp xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\"><wps:cNvSpPr/>{sp_pr}<wps:bodyPr/></wps:wsp>"
    );
    let anchor = centered_anchor(
        &w,
        &h,
        &format!("<wp:docPr id=\"{id}\" name=\"{} {id}\"/>", def.prst),
        &wps_graphic(&wsp),
    );
    let vml_line = format!(
        "<v:line xmlns:v=\"urn:schemas-microsoft-com:vml\" from=\"0,0\" to=\"{}pt,{}pt\" strokecolor=\"#{color_hex}\"/>",
        num(math_round(width_emu / EMU_PER_PT)),
        num(math_round(height_emu / EMU_PER_PT)),
    );
    alternate_paragraph(&anchor, &vml_line)
}

/// `docPrId: string | number`
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum DocPrId {
    Text(String),
    Number(f64),
}

/// `InlinePictureXmlOptions`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlinePictureXmlOptions {
    pub r_id: String,
    pub doc_pr_id: DocPrId,
    #[serde(deserialize_with = "wire")]
    pub width_px: f64,
    #[serde(deserialize_with = "wire")]
    pub height_px: f64,
    pub alt_text: Option<String>,
    #[serde(default, deserialize_with = "wire_opt")]
    pub rot_deg: Option<f64>,
    pub flip_h: Option<bool>,
    pub flip_v: Option<bool>,
}

/// `inlinePictureDrawingXml`
pub fn inline_picture_drawing_xml(o: &InlinePictureXmlOptions) -> String {
    // a non-finite size takes the 1 EMU floor the TypeScript clamps to
    let cx = js_max(1.0, math_round(fin_or(o.width_px, 0.0) * EMU_PER_PX));
    let cy = js_max(1.0, math_round(fin_or(o.height_px, 0.0) * EMU_PER_PX));
    let rot_deg = fin(o.rot_deg);
    let rot = if truthy(rot_deg) {
        ((math_round(rot_deg.unwrap_or(f64::NAN)) % 360.0) + 360.0) % 360.0
    } else {
        0.0
    };
    let rad = (rot * std::f64::consts::PI) / 180.0;
    let bw = (cx * rad.cos()).abs() + (cy * rad.sin()).abs();
    let bh = (cx * rad.sin()).abs() + (cy * rad.cos()).abs();
    let ee_x = num(js_max(0.0, math_round((bw - cx) / 2.0)));
    let ee_y = num(js_max(0.0, math_round((bh - cy) / 2.0)));
    let id = match &o.doc_pr_id {
        DocPrId::Text(text) => text.clone(),
        DocPrId::Number(n) => num(*n),
    };
    let name = format!("Picture {id}");
    let (cx, cy) = (num(cx), num(cy));
    let descr = match str_truthy(&o.alt_text) {
        Some(alt) => format!(" descr=\"{}\"", escape_xml_attr(alt)),
        None => String::new(),
    };
    let rot_attr = if truthy(Some(rot)) {
        format!(" rot=\"{}\"", num(rot * 60000.0))
    } else {
        String::new()
    };
    let flip_h = if o.flip_h == Some(true) {
        " flipH=\"1\""
    } else {
        ""
    };
    let flip_v = if o.flip_v == Some(true) {
        " flipV=\"1\""
    } else {
        ""
    };
    format!(
        "<w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:effectExtent l=\"{ee_x}\" t=\"{ee_y}\" r=\"{ee_x}\" b=\"{ee_y}\"/><wp:docPr id=\"{id}\" name=\"{name}\"{descr}/><a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"{}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm{rot_attr}{flip_h}{flip_v}><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>",
        o.r_id
    )
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextboxOptions {
    #[serde(default, deserialize_with = "wire_opt")]
    pub width_emu: Option<f64>,
    #[serde(default, deserialize_with = "wire_opt")]
    pub height_emu: Option<f64>,
    #[serde(default, deserialize_with = "wire_opt")]
    pub id: Option<f64>,
    pub fill_hex: Option<String>,
    pub border_hex: Option<String>,
}

/// `buildTextboxParagraphXml`; `None` is `opts` undefined.
pub fn build_textbox_paragraph_xml(opts: Option<&TextboxOptions>) -> String {
    let default = TextboxOptions::default();
    let opts = opts.unwrap_or(&default);
    let width_emu = fin(opts.width_emu).unwrap_or(1800000.0);
    let height_emu = fin(opts.height_emu).unwrap_or(1080000.0);
    let id = num(fin(opts.id).unwrap_or(1.0));
    let fill_hex = opts.fill_hex.as_deref().unwrap_or("FFFFFF");
    let border_hex = opts.border_hex.as_deref().unwrap_or("000000");
    let (w, h) = (num(width_emu), num(height_emu));

    let sp_pr = format!(
        "<wps:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{w}\" cy=\"{h}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val=\"{fill_hex}\"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val=\"{border_hex}\"/></a:solidFill></a:ln></wps:spPr>"
    );
    let wsp = format!(
        "<wps:wsp xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\"><wps:cNvSpPr txBox=\"1\"/>{sp_pr}<wps:txbx><w:txbxContent><w:p><w:r><w:t xml:space=\"preserve\"> </w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp>"
    );
    let anchor = centered_anchor(
        &w,
        &h,
        &format!("<wp:docPr id=\"{id}\" name=\"TextBox {id}\"/>"),
        &wps_graphic(&wsp),
    );
    let vml_rect = format!(
        "<v:rect xmlns:v=\"urn:schemas-microsoft-com:vml\" style=\"position:absolute;width:{}pt;height:{}pt\" filled=\"t\" stroked=\"t\"><v:textbox><w:txbxContent><w:p><w:r><w:t xml:space=\"preserve\"> </w:t></w:r></w:p></w:txbxContent></v:textbox></v:rect>",
        num(width_emu / EMU_PER_PT),
        num(height_emu / EMU_PER_PT),
    );
    alternate_paragraph(&anchor, &vml_rect)
}

/// `TextboxContentParagraph`
#[derive(Debug, Clone, Deserialize)]
pub struct TextboxContentParagraph {
    pub runs: Vec<Run>,
    pub format: Option<ParaFormat>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Insets {
    #[serde(deserialize_with = "wire")]
    pub l: f64,
    #[serde(deserialize_with = "wire")]
    pub t: f64,
    #[serde(deserialize_with = "wire")]
    pub r: f64,
    #[serde(deserialize_with = "wire")]
    pub b: f64,
}

/// `AnchoredTextboxOptions`. `holder_line_twips` and
/// `holder_spacing_before_twips` keep `null` apart from absence: the
/// TypeScript tests them with `!== undefined`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchoredTextboxOptions {
    pub anchor: String,
    #[serde(deserialize_with = "wire")]
    pub x_emu: f64,
    #[serde(deserialize_with = "wire")]
    pub y_emu: f64,
    #[serde(deserialize_with = "wire")]
    pub width_emu: f64,
    #[serde(deserialize_with = "wire")]
    pub height_emu: f64,
    pub paragraphs: Vec<TextboxContentParagraph>,
    #[serde(default, deserialize_with = "wire_opt")]
    pub id: Option<f64>,
    pub fill_hex: Option<String>,
    pub border_hex: Option<String>,
    pub insets_emu: Option<Insets>,
    #[serde(default, deserialize_with = "wire_opt")]
    pub corner_radius_emu: Option<f64>,
    #[serde(default, deserialize_with = "wire_opt")]
    pub z_order: Option<f64>,
    pub behind_doc: Option<bool>,
    pub wrap: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub holder_line_twips: Option<Option<f64>>,
    #[serde(default, deserialize_with = "present")]
    pub holder_spacing_before_twips: Option<Option<f64>>,
    pub holder_page_break_before: Option<bool>,
}

fn content_para_xml(p: &TextboxContentParagraph) -> String {
    let mut children = format_p_pr_children(p.format.as_ref());
    let rank = |name: &str| {
        PPR_CHILD_ORDER
            .iter()
            .position(|n| *n == name)
            .map_or(-1, |i| i as i64)
    };
    children.sort_by_key(|(name, _)| rank(name));
    let p_pr = if children.is_empty() {
        String::new()
    } else {
        format!(
            "<w:pPr>{}</w:pPr>",
            children
                .iter()
                .map(|(_, xml)| xml.as_str())
                .collect::<String>()
        )
    };
    format!("<w:p>{p_pr}{}</w:p>", inline_runs_xml(&p.runs))
}

/// `buildAnchoredTextboxParagraphXml`
pub fn build_anchored_textbox_paragraph_xml(opts: &AnchoredTextboxOptions) -> String {
    let id = num(fin(opts.id).unwrap_or(1.0));
    // a required non-finite geometry value is written as 0
    let (x_emu, y_emu, width_emu, height_emu) = (
        fin_or(opts.x_emu, 0.0),
        fin_or(opts.y_emu, 0.0),
        fin_or(opts.width_emu, 0.0),
        fin_or(opts.height_emu, 0.0),
    );
    let (w, h) = (num(width_emu), num(height_emu));

    let txbx_content = format!(
        "<w:txbxContent>{}</w:txbxContent>",
        opts.paragraphs
            .iter()
            .map(content_para_xml)
            .collect::<String>()
    );
    // an infinite radius gives a valid 50000 or 0 in the TypeScript too
    let corner_radius_emu = opts.corner_radius_emu;
    let rounded = truthy(corner_radius_emu);
    let geom = if rounded {
        let radius = corner_radius_emu.unwrap_or(f64::NAN);
        let adj = js_min(
            50000.0,
            js_max(
                0.0,
                math_round((radius / js_max(1.0, js_min(width_emu, height_emu))) * 100000.0),
            ),
        );
        format!(
            "<a:prstGeom prst=\"roundRect\"><a:avLst><a:gd name=\"adj\" fmla=\"val {}\"/></a:avLst></a:prstGeom>",
            num(adj)
        )
    } else {
        "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom>".to_owned()
    };
    let fill_hex = str_truthy(&opts.fill_hex);
    let fill = match fill_hex {
        Some(hex) => format!(
            "<a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>",
            escape_xml_attr(hex)
        ),
        None => "<a:noFill/>".to_owned(),
    };
    let line = match str_truthy(&opts.border_hex) {
        Some(hex) => format!(
            "<a:ln><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill></a:ln>",
            escape_xml_attr(hex)
        ),
        None => "<a:ln><a:noFill/></a:ln>".to_owned(),
    };
    let sp_pr = format!(
        "<wps:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{w}\" cy=\"{h}\"/></a:xfrm>{geom}{fill}{line}</wps:spPr>"
    );
    let ins = match &opts.insets_emu {
        Some(i) => Insets {
            l: fin_or(i.l, 91440.0),
            t: fin_or(i.t, 45720.0),
            r: fin_or(i.r, 91440.0),
            b: fin_or(i.b, 45720.0),
        },
        None => Insets {
            l: 91440.0,
            t: 45720.0,
            r: 91440.0,
            b: 45720.0,
        },
    };
    let body_pr = format!(
        "<wps:bodyPr wrap=\"square\" lIns=\"{}\" tIns=\"{}\" rIns=\"{}\" bIns=\"{}\" anchor=\"t\"><a:noAutofit/></wps:bodyPr>",
        num(math_round(ins.l)),
        num(math_round(ins.t)),
        num(math_round(ins.r)),
        num(math_round(ins.b)),
    );
    let wsp = format!(
        "<wps:wsp xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\"><wps:cNvSpPr txBox=\"1\"/>{sp_pr}<wps:txbx>{txbx_content}</wps:txbx>{body_pr}</wps:wsp>"
    );
    let graphic = wps_graphic(&wsp);

    let page = opts.anchor == "page";
    let pos_h = format!(
        "<wp:positionH relativeFrom=\"{}\"><wp:posOffset>{}</wp:posOffset></wp:positionH>",
        if page { "page" } else { "column" },
        num(math_round(x_emu)),
    );
    let pos_v = format!(
        "<wp:positionV relativeFrom=\"{}\"><wp:posOffset>{}</wp:posOffset></wp:positionV>",
        if page { "page" } else { "paragraph" },
        num(math_round(y_emu)),
    );
    let wrap_mode = opts
        .wrap
        .as_deref()
        .unwrap_or(if page { "none" } else { "topAndBottom" });
    let wrap_el = if wrap_mode == "topAndBottom" {
        "<wp:wrapTopAndBottom/>"
    } else {
        "<wp:wrapNone/>"
    };
    let anchor = format!(
        "<wp:anchor xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\" simplePos=\"0\" relativeHeight=\"{}\" behindDoc=\"{}\" locked=\"0\" layoutInCell=\"1\" allowOverlap=\"1\"><wp:simplePos x=\"0\" y=\"0\"/>{pos_h}{pos_v}<wp:extent cx=\"{w}\" cy=\"{h}\"/><wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/>{wrap_el}<wp:docPr id=\"{id}\" name=\"Region {id}\"/>{graphic}</wp:anchor>",
        num(251658240.0 + fin(opts.z_order).unwrap_or(0.0)),
        if opts.behind_doc == Some(true) { 1 } else { 0 },
    );

    let vml_tag = if rounded { "v:roundrect" } else { "v:rect" };
    let vml_fill = match fill_hex {
        Some(hex) => format!(" fillcolor=\"#{}\" filled=\"t\"", escape_xml_attr(hex)),
        None => " filled=\"f\"".to_owned(),
    };
    let vml_rect = format!(
        "<{vml_tag} xmlns:v=\"urn:schemas-microsoft-com:vml\" style=\"position:absolute;margin-left:{}pt;margin-top:{}pt;width:{}pt;height:{}pt\"{vml_fill} stroked=\"f\"><v:textbox>{txbx_content}</v:textbox></{vml_tag}>",
        num(x_emu / EMU_PER_PT),
        num(y_emu / EMU_PER_PT),
        num(width_emu / EMU_PER_PT),
        num(height_emu / EMU_PER_PT),
    );
    let alternate_content = format!(
        "<mc:AlternateContent {MC_NS}><mc:Choice Requires=\"wps\"><w:drawing>{anchor}</w:drawing></mc:Choice><mc:Fallback><w:pict>{vml_rect}</w:pict></mc:Fallback></mc:AlternateContent>"
    );

    // `null` is a defined value there: Math.round(null) is 0. Main policy: a
    // non-finite value leaves out only the attribute it would write.
    let holder_spacing =
        if opts.holder_line_twips.is_some() || opts.holder_spacing_before_twips.is_some() {
            let before = opts.holder_spacing_before_twips.flatten();
            let before_twips = math_round(before.unwrap_or(f64::NAN));
            let before = if truthy(before) && before_twips.is_finite() {
                format!(" w:before=\"{}\"", num(before_twips))
            } else {
                String::new()
            };
            let line = match opts.holder_line_twips {
                Some(line) if math_round(line.unwrap_or(0.0)).is_finite() => {
                    format!(
                        " w:line=\"{}\" w:lineRule=\"exact\"",
                        num(math_round(line.unwrap_or(0.0)))
                    )
                }
                _ => String::new(),
            };
            format!("<w:spacing{before} w:after=\"0\"{line}/>")
        } else {
            String::new()
        };
    let holder_break = if opts.holder_page_break_before == Some(true) {
        "<w:pageBreakBefore/>"
    } else {
        ""
    };
    let holder_p_pr = if !holder_spacing.is_empty() || !holder_break.is_empty() {
        format!("<w:pPr>{holder_break}{holder_spacing}</w:pPr>")
    } else {
        String::new()
    };
    format!("<w:p>{holder_p_pr}<w:r>{alternate_content}</w:r></w:p>")
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeOptions {
    pub prst: String,
    #[serde(default, deserialize_with = "wire_opt")]
    pub width_emu: Option<f64>,
    #[serde(default, deserialize_with = "wire_opt")]
    pub height_emu: Option<f64>,
    #[serde(default, deserialize_with = "wire_opt")]
    pub id: Option<f64>,
    pub fill_hex: Option<String>,
    pub border_hex: Option<String>,
    pub with_textbox: Option<bool>,
}

/// `buildShapeParagraphXml`
pub fn build_shape_paragraph_xml(opts: &ShapeOptions) -> String {
    let width_emu = fin(opts.width_emu).unwrap_or(1800000.0);
    let height_emu = fin(opts.height_emu).unwrap_or(1080000.0);
    let id = num(fin(opts.id).unwrap_or(1.0));
    let fill_hex = opts.fill_hex.as_deref().unwrap_or("4472C4");
    let border_hex = opts.border_hex.as_deref().unwrap_or("2F5496");
    let (w, h) = (num(width_emu), num(height_emu));
    let prst = &opts.prst;
    let with_textbox = opts.with_textbox == Some(true);

    let sp_pr = format!(
        "<wps:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{w}\" cy=\"{h}\"/></a:xfrm><a:prstGeom prst=\"{prst}\"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val=\"{fill_hex}\"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val=\"{border_hex}\"/></a:solidFill></a:ln></wps:spPr>"
    );
    let seeded_para = "<w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr><w:r><w:t xml:space=\"preserve\"> </w:t></w:r></w:p>";
    let txbx_part = if with_textbox {
        format!("<wps:txbx><w:txbxContent>{seeded_para}</w:txbxContent></wps:txbx>")
    } else {
        String::new()
    };
    let style = "<wps:style><a:lnRef idx=\"2\"><a:schemeClr val=\"accent1\"/></a:lnRef><a:fillRef idx=\"1\"><a:schemeClr val=\"accent1\"/></a:fillRef><a:effectRef idx=\"0\"><a:schemeClr val=\"accent1\"/></a:effectRef><a:fontRef idx=\"minor\"><a:schemeClr val=\"lt1\"/></a:fontRef></wps:style>";
    let wsp = format!(
        "<wps:wsp xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\"><wps:cNvPr id=\"{id}\" name=\"{prst} {id}\"/><wps:cNvSpPr/>{sp_pr}{style}{txbx_part}<wps:bodyPr anchor=\"ctr\"/></wps:wsp>"
    );
    let anchor = centered_anchor(
        &w,
        &h,
        &format!("<wp:docPr id=\"{id}\" name=\"{prst} {id}\"/>"),
        &wps_graphic(&wsp),
    );
    let vml_rect = format!(
        "<v:rect xmlns:v=\"urn:schemas-microsoft-com:vml\" style=\"position:absolute;width:{}pt;height:{}pt\" filled=\"t\" stroked=\"t\">{}</v:rect>",
        num(width_emu / EMU_PER_PT),
        num(height_emu / EMU_PER_PT),
        if with_textbox {
            format!(
                "<v:textbox style=\"v-text-anchor:middle\"><w:txbxContent>{seeded_para}</w:txbxContent></v:textbox>"
            )
        } else {
            String::new()
        },
    );
    alternate_paragraph(&anchor, &vml_rect)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordArtOptions {
    pub text: Option<String>,
    pub color_hex: Option<String>,
    pub italic: Option<bool>,
    #[serde(default, deserialize_with = "wire_opt")]
    pub width_emu: Option<f64>,
    #[serde(default, deserialize_with = "wire_opt")]
    pub height_emu: Option<f64>,
    #[serde(default, deserialize_with = "wire_opt")]
    pub id: Option<f64>,
}

/// `buildWordArtParagraphXml`
pub fn build_word_art_paragraph_xml(opts: &WordArtOptions) -> String {
    let width_emu = fin(opts.width_emu).unwrap_or(2700000.0);
    let height_emu = fin(opts.height_emu).unwrap_or(720000.0);
    let id = num(fin(opts.id).unwrap_or(1.0));
    let color_hex = opts.color_hex.as_deref().unwrap_or("4472C4");
    let text = escape_xml_text(opts.text.as_deref().unwrap_or("WordArt"));
    let (w, h) = (num(width_emu), num(height_emu));

    let r_pr = format!(
        "<w:rPr><w:b/>{}<w:color w:val=\"{color_hex}\"/><w:sz w:val=\"72\"/><w:szCs w:val=\"72\"/></w:rPr>",
        if opts.italic == Some(true) {
            "<w:i/>"
        } else {
            ""
        },
    );
    let text_run = format!("<w:r>{r_pr}<w:t xml:space=\"preserve\">{text}</w:t></w:r>");
    let txbx_content = format!(
        "<w:txbxContent><w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr>{text_run}</w:p></w:txbxContent>"
    );
    let sp_pr = format!(
        "<wps:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{w}\" cy=\"{h}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>"
    );
    let wsp = format!(
        "<wps:wsp xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\"><wps:cNvSpPr txBox=\"1\"/>{sp_pr}<wps:txbx>{txbx_content}</wps:txbx><wps:bodyPr/></wps:wsp>"
    );
    let anchor = centered_anchor(
        &w,
        &h,
        &format!("<wp:docPr id=\"{id}\" name=\"WordArt {id}\"/>"),
        &wps_graphic(&wsp),
    );
    let vml_rect = format!(
        "<v:rect xmlns:v=\"urn:schemas-microsoft-com:vml\" style=\"position:absolute;width:{}pt;height:{}pt\" filled=\"f\" stroked=\"f\"><v:textbox><w:txbxContent><w:p><w:r>{r_pr}<w:t xml:space=\"preserve\">{text}</w:t></w:r></w:p></w:txbxContent></v:textbox></v:rect>",
        num(width_emu / EMU_PER_PT),
        num(height_emu / EMU_PER_PT),
    );
    alternate_paragraph(&anchor, &vml_rect)
}
