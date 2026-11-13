//! `assemble/export/objects.ts`: objects of a docx that an ODT gets as
//! pictures: charts, equations, shapes and text boxes. The picture is, in
//! order of preference: what the editor rendered (`renderedObjects`), the
//! file's own fallback picture (`mc:Fallback`, an OLE preview), or a label box
//! naming the kind. Plain pictures stay pictures, read from the package by
//! their relationship.

use docx_engine::model::{Run, RunImage};
use jscompat::{
    JsRegex, Radix, js_regex, math_max, math_round, number_to_string, parse_float, parse_int,
};

use crate::assemble::zip::crc32;
use crate::core::xml::{escape_xml_attr, escape_xml_text};
use crate::core::{OdtError, OoxmlToOdfContext, ParagraphWriteEnv, RunWriter};
use crate::objects::media::{base64_encode, sniff_image};
use crate::offset::u16_len;
use crate::text::units::to_fixed;

/// `ExportObjectKind`: what a docx object becomes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportObjectKind {
    Chart,
    Equation,
    Shape,
    Textbox,
}

impl ExportObjectKind {
    /// The string the TypeScript holds.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chart => "chart",
            Self::Equation => "equation",
            Self::Shape => "shape",
            Self::Textbox => "textbox",
        }
    }

    /// `LABEL_TEXT[kind]`
    fn label_text(self) -> &'static str {
        match self {
            Self::Chart => "Chart",
            Self::Equation => "Equation",
            Self::Shape => "Shape",
            Self::Textbox => "Text box",
        }
    }
}

/// The result of `classifyObject`: an `ExportObjectKind` or `'picture'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectClass {
    Kind(ExportObjectKind),
    Picture,
}

impl ObjectClass {
    /// The string the TypeScript holds.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Kind(kind) => kind.as_str(),
            Self::Picture => "picture",
        }
    }
}

/// `RenderedObject`: a picture of an object as the editor shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderedObject {
    /// PNG bytes
    pub png: Vec<u8>,
    /// display size in EMU (914400 per inch)
    pub width_emu: f64,
    pub height_emu: f64,
}

/// An EMU size, `{ cx, cy }`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub cx: f64,
    pub cy: f64,
}

/// `LABEL_PREFIX`
pub const LABEL_PREFIX: &str = "odt-label:";

/// `chosen`: the part of an `mc:AlternateContent` the producer meant (its
/// first choice), else the XML.
fn chosen(xml: &str) -> &str {
    match js_regex!(r"<mc:Choice\b[^>]*>([\s\S]*?)<\/mc:Choice>").exec(xml) {
        Some(m) => m.get(1).unwrap_or(""),
        None => xml,
    }
}

/// `classifyObject`: the kind of a drawing, VML or math fragment: `Picture`
/// for plain pictures, `None` when it holds nothing drawable.
pub fn classify_object(xml: &str) -> Option<ObjectClass> {
    use ExportObjectKind::*;
    let x = chosen(xml);
    if js_regex!(r"<m:oMath\b").test(x) {
        return Some(ObjectClass::Kind(Equation));
    }
    if js_regex!(r"<w:object\b|<o:OLEObject\b").test(x) {
        let prog = js_regex!(r#"\bProgID="([^"]*)""#)
            .exec(x)
            .and_then(|m| m.get(1))
            .unwrap_or("");
        if js_regex!(r"^Equation\.", "i").test(prog) {
            return Some(ObjectClass::Kind(Equation));
        }
        if js_regex!(r"Chart|Excel", "i").test(prog) {
            return Some(ObjectClass::Kind(Chart));
        }
        return Some(ObjectClass::Kind(Shape));
    }
    if js_regex!(r#"graphicData\s+uri="[^"]*\/(?:chart|chartex)"|<c:chart\b|<cx:chart\b"#).test(x) {
        return Some(ObjectClass::Kind(Chart));
    }
    if js_regex!(r"<wps:txbx\b|<v:textbox\b|<w:txbxContent\b").test(x) {
        return Some(ObjectClass::Kind(Textbox));
    }
    if js_regex!(r#"<wps:wsp\b|<wpg:wgp\b|<wpc:wpc\b|<dgm:|graphicData\s+uri="[^"]*\/diagram""#)
        .test(x)
    {
        return Some(ObjectClass::Kind(Shape));
    }
    if js_regex!(r"<pic:pic\b|<a:blip\b").test(x) {
        return Some(ObjectClass::Picture);
    }
    if js_regex!(r"<v:imagedata\b").test(x) {
        return Some(ObjectClass::Picture);
    }
    if js_regex!(r"<v:(?:shape|rect|roundrect|oval|line|polyline|arc|curve|group)\b").test(x) {
        return Some(ObjectClass::Kind(Shape));
    }
    None
}

/// The `len` helper of `objectSize`: one CSS length of a VML style, in EMU.
fn style_length(style: &str, name: &str) -> Option<f64> {
    let regex: &JsRegex = match name {
        "width" => js_regex!(r"(?:^|;)\s*width\s*:\s*([\d.]+)(pt|in|cm|mm|px)?"),
        _ => js_regex!(r"(?:^|;)\s*height\s*:\s*([\d.]+)(pt|in|cm|mm|px)?"),
    };
    let m = regex.exec(style)?;
    let n = parse_float(m.get(1).unwrap_or(""));
    let per = match m.get(2).unwrap_or("px") {
        "pt" => 12700.0,
        "in" => 914400.0,
        "cm" => 360000.0,
        "mm" => 36000.0,
        _ => 9525.0,
    };
    Some(math_round(n * per))
}

/// `objectSize`: display size of a drawing or VML fragment in EMU, when it
/// states one.
pub fn object_size(xml: &str) -> Option<Size> {
    let x = chosen(xml);
    if let Some(ext) = js_regex!(r#"<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""#).exec(x) {
        return Some(Size {
            cx: parse_int(ext.get(1).unwrap_or(""), Radix::Ten),
            cy: parse_int(ext.get(2).unwrap_or(""), Radix::Ten),
        });
    }
    let style = js_regex!(r#"\bstyle="([^"]*)""#)
        .exec(x)
        .and_then(|m| m.get(1))
        .unwrap_or("");
    let w = style_length(style, "width");
    let h = style_length(style, "height");
    // `w && h ? { cx: w, cy: h } : null`
    let truthy = |n: Option<f64>| n.filter(|n| *n != 0.0 && !n.is_nan());
    match (truthy(w), truthy(h)) {
        (Some(cx), Some(cy)) => Some(Size { cx, cy }),
        _ => None,
    }
}

/// `fallbackPictureRId`: the relationship id of a fragment's fallback picture
/// (`mc:Fallback`, OLE preview, VML image).
pub fn fallback_picture_r_id(xml: &str) -> Option<&str> {
    let fallback = js_regex!(r"<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>")
        .exec(xml)
        .and_then(|m| m.get(1));
    let scope = match fallback {
        Some(fallback) => Some(fallback),
        None => js_regex!(r"<w:object\b").test(xml).then_some(xml),
    };
    let scope = scope.filter(|scope| !scope.is_empty())?;
    js_regex!(r#"<a:blip\b[^>]*\br:embed="([^"]+)""#)
        .exec(scope)
        .and_then(|m| m.get(1))
        .or_else(|| {
            js_regex!(r#"<v:imagedata\b[^>]*\br:id="([^"]+)""#)
                .exec(scope)
                .and_then(|m| m.get(1))
        })
}

/// `drawingXml`: a `w:drawing` the objects layer reads as a new picture of the
/// given size and name.
pub fn drawing_xml(cx: f64, cy: f64, name: &str) -> String {
    format!(
        "<w:drawing><wp:inline><wp:extent cx=\"{}\" cy=\"{}\"/><wp:docPr id=\"1\" name=\"{}\"/></wp:inline></w:drawing>",
        number_to_string(math_max(1.0, math_round(cx))),
        number_to_string(math_max(1.0, math_round(cy))),
        escape_xml_attr(name),
    )
}

/// `dataUrlOf`
pub fn data_url_of(bytes: &[u8]) -> String {
    let mime = sniff_image(bytes).map_or_else(|| "image/png".to_owned(), |format| format.mime);
    format!("data:{mime};base64,{}", base64_encode(bytes))
}

/// `pictureRun`: a picture run (written by the objects layer as a new frame).
pub fn picture_run(bytes: &[u8], cx: f64, cy: f64, name: &str) -> Run {
    let mut run = Run::default();
    run.text.set(String::new());
    run.image.set(RunImage {
        data_url: data_url_of(bytes).into(),
        xml: drawing_xml(cx, cy, name),
        ..RunImage::default()
    });
    run
}

/// `labelRun`: a label run naming the object kind (written by
/// `labelRunWriter`).
pub fn label_run(kind: ExportObjectKind, cx: f64, cy: f64) -> Run {
    let mut run = Run::default();
    run.text.set(String::new());
    run.image.set(RunImage {
        data_url: String::new().into(),
        xml: drawing_xml(cx, cy, &format!("{LABEL_PREFIX}{}", kind.as_str())),
        ..RunImage::default()
    });
    run
}

/// `defaultSize`: default sizes when an object states none (EMU).
pub fn default_size(kind: ExportObjectKind, text: &str) -> Size {
    if kind == ExportObjectKind::Equation {
        let wide = f64::from(u16_len(text).0) * 120000.0;
        return Size {
            cx: math_max(720000.0, wide.min(5400000.0)),
            cy: 288000.0,
        };
    }
    Size {
        cx: 1800000.0,
        cy: 1080000.0,
    }
}

/// `emuToCm`
fn emu_to_cm(emu: f64) -> String {
    format!("{}cm", to_fixed(emu / 360000.0, 3))
}

/// `labelRunWriter`: writes label runs as a framed text box with the kind's
/// name.
pub struct LabelRunWriter;

impl RunWriter for LabelRunWriter {
    fn id(&self) -> &str {
        "export-label"
    }

    fn matches(&self, run: &Run) -> bool {
        run.image
            .as_ref()
            .is_some_and(|image| image.xml.contains(&format!("name=\"{LABEL_PREFIX}")))
    }

    fn to_odf(
        &self,
        rctx: &mut OoxmlToOdfContext,
        run: &Run,
        env: &ParagraphWriteEnv<'_>,
    ) -> Result<String, OdtError> {
        let xml = run.image.as_ref().map_or("", |image| image.xml.as_str());
        let kind = js_regex!(r#"name="odt-label:([a-z]+)""#)
            .exec(xml)
            .and_then(|m| m.get(1))
            .unwrap_or("shape");
        let cx = js_regex!(r#"\bcx="(\d+)""#)
            .exec(xml)
            .and_then(|m| m.get(1))
            .map_or(1800000.0, |cx| parse_int(cx, Radix::Ten));
        let cy = js_regex!(r#"\bcy="(\d+)""#)
            .exec(xml)
            .and_then(|m| m.get(1))
            .map_or(1080000.0, |cy| parse_int(cy, Radix::Ten));
        let graphic = rctx.derived_style(
            env.part,
            "export-label-graphic",
            "fr",
            |name| {
                format!(
                    "<style:style style:name=\"{}\" style:family=\"graphic\">\
<style:graphic-properties style:vertical-pos=\"top\" style:vertical-rel=\"baseline\" \
fo:border=\"0.5pt solid #808080\" fo:padding=\"0.05cm\" draw:fill=\"solid\" draw:fill-color=\"#f2f2f2\" \
fo:background-color=\"#f2f2f2\"/></style:style>",
                    escape_xml_attr(name)
                )
            },
        );
        let parent = rctx.map.styles.base_paragraph_style.clone();
        let paragraph = rctx.derived_style(
            env.part,
            "export-label-paragraph",
            "P",
            |name| {
                format!(
                    "<style:style style:name=\"{}\" style:family=\"paragraph\"{}>\
<style:paragraph-properties fo:text-align=\"center\" fo:margin-top=\"0cm\" fo:margin-bottom=\"0cm\" fo:margin-left=\"0cm\" fo:margin-right=\"0cm\" fo:text-indent=\"0cm\" fo:line-height=\"100%\"/>\
<style:text-properties fo:color=\"#595959\" fo:font-size=\"9pt\" style:font-size-asian=\"9pt\" style:font-size-complex=\"9pt\"/></style:style>",
                    escape_xml_attr(name),
                    match parent.as_deref().filter(|parent| !parent.is_empty()) {
                        Some(parent) => format!(" style:parent-style-name=\"{}\"", escape_xml_attr(parent)),
                        None => String::new(),
                    }
                )
            },
        );
        // `LABEL_TEXT[kind]` of a name that is no kind is undefined, which
        // `escapeXmlText` cannot read
        let label = match kind {
            "chart" => ExportObjectKind::Chart.label_text(),
            "equation" => ExportObjectKind::Equation.label_text(),
            "shape" => ExportObjectKind::Shape.label_text(),
            "textbox" => ExportObjectKind::Textbox.label_text(),
            _ => {
                return Err(OdtError::thrown(
                    "Cannot read properties of undefined (reading 'replace')",
                ));
            }
        };
        Ok(format!(
            "<draw:frame draw:style-name=\"{}\" text:anchor-type=\"as-char\" svg:width=\"{}\" svg:height=\"{}\">\
<draw:text-box><text:p text:style-name=\"{}\">{}</text:p></draw:text-box></draw:frame>",
            escape_xml_attr(&graphic),
            emu_to_cm(cx),
            emu_to_cm(cy),
            escape_xml_attr(&paragraph),
            escape_xml_text(label),
        ))
    }
}

/// `ToUint32` of a number, as `>>> 0` and a `Uint8Array` store it.
fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    x.trunc().rem_euclid(4294967296.0) as u32
}

/// `solidPng`: a 1x1 PNG of one colour (stored zlib block), for drawn rules.
pub fn solid_png(r: f64, g: f64, b: f64) -> Vec<u8> {
    // `chunk`: the numbers of `data` become bytes where the Uint8Array is made
    let chunk = |kind: &str, data: &[f64]| -> Vec<u8> {
        let mut body: Vec<u8> = kind.bytes().collect();
        body.extend(data.iter().map(|d| to_uint32(*d) as u8));
        let crc = crc32(&body);
        let len = data.len() as u32;
        let mut out = Vec::with_capacity(body.len() + 8);
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc.to_be_bytes());
        out
    };
    let raw = [0.0, r, g, b];
    let mut a = 1.0_f64;
    let mut s = 0.0_f64;
    for x in raw {
        a = (a + x) % 65521.0;
        s = (s + a) % 65521.0;
    }
    let mut zlib: Vec<f64> = vec![
        f64::from(0x78),
        f64::from(0x01),
        f64::from(0x01),
        raw.len() as f64,
        0.0,
        f64::from(!(raw.len() as i32) & 255),
        f64::from(0xff),
    ];
    zlib.extend(raw);
    zlib.push(f64::from((to_uint32(s) >> 8) & 255));
    zlib.push(f64::from(to_uint32(s) & 255));
    zlib.push(f64::from((to_uint32(a) >> 8) & 255));
    zlib.push(f64::from(to_uint32(a) & 255));
    let mut out = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    out.extend(chunk(
        "IHDR",
        &[
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 8.0, 2.0, 0.0, 0.0, 0.0,
        ],
    ));
    out.extend(chunk("IDAT", &zlib));
    out.extend(chunk("IEND", &[]));
    out
}
