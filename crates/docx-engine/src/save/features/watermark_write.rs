//! The write half of watermark.ts: the paragraphs of a text and a picture
//! watermark. The readers and the boxes are in `crate::watermark`.

use jscompat::{math_max, math_min, number_to_string};

use crate::generate::escape_xml_attr;
use crate::watermark::{
    BoxPt, PictureWatermarkSpec, Watermark, WatermarkSpec, picture_watermark_box_pt,
    text_watermark_box_pt,
};

/// The Watermarks building-block sdt around the paragraph a watermark lives in.
fn watermark_sdt(shapetype: &str, shape: &str) -> String {
    format!(
        "<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val=\"Watermarks\"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent><w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr><w:r><w:pict>{shapetype}{shape}</w:pict></w:r></w:p></w:sdtContent></w:sdt>"
    )
}

/// `pictureWatermarkParagraphXml`: the picture watermark Word generates
/// (shapetype 75 = picture frame) in the Watermarks building-block sdt,
/// centered on the margin box behind the body. `r_id` is the image
/// relationship in the header part's own rels.
pub fn picture_watermark_paragraph_xml(
    watermark: &Watermark,
    r_id: &str,
    margin_box: Option<&BoxPt>,
) -> Result<String, String> {
    let Watermark::Picture(spec) = watermark else {
        return Err(
            "TypeError: Cannot read properties of undefined (reading 'widthPx')".to_owned(),
        );
    };
    Ok(picture_paragraph_xml(spec, r_id, margin_box))
}

fn picture_paragraph_xml(
    spec: &PictureWatermarkSpec,
    r_id: &str,
    margin_box: Option<&BoxPt>,
) -> String {
    let boxed = picture_watermark_box_pt(spec, margin_box);
    let washout = if spec.washout != Some(false) {
        " gain=\"19661f\" blacklevel=\"22938f\""
    } else {
        ""
    };
    let shapetype = "<v:shapetype id=\"_x0000_t75\" coordsize=\"21600,21600\" o:spt=\"75\" o:preferrelative=\"t\" path=\"m@4@5l@4@11@9@11@9@5xe\" filled=\"f\" stroked=\"f\"><v:stroke joinstyle=\"miter\"/><v:formulas><v:f eqn=\"if lineDrawn pixelLineWidth 0\"/><v:f eqn=\"sum @0 1 0\"/><v:f eqn=\"sum 0 0 @1\"/><v:f eqn=\"prod @2 1 2\"/><v:f eqn=\"prod @3 21600 pixelWidth\"/><v:f eqn=\"prod @3 21600 pixelHeight\"/><v:f eqn=\"sum @0 0 1\"/><v:f eqn=\"prod @6 1 2\"/><v:f eqn=\"prod @7 21600 pixelWidth\"/><v:f eqn=\"sum @8 21600 0\"/><v:f eqn=\"prod @7 21600 pixelHeight\"/><v:f eqn=\"sum @10 21600 0\"/></v:formulas><v:path o:extrusionok=\"f\" gradientshapeok=\"t\" o:connecttype=\"rect\"/><o:lock v:ext=\"edit\" aspectratio=\"t\"/></v:shapetype>";
    let shape = format!(
        "<v:shape id=\"WordPictureWatermark1\" o:spid=\"_x0000_s2050\" type=\"#_x0000_t75\" style=\"position:absolute;margin-left:0;margin-top:0;width:{}pt;height:{}pt;z-index:-251657216;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin\" o:allowincell=\"f\"><v:imagedata r:id=\"{}\" o:title=\"watermark\"{washout}/></v:shape>",
        number_to_string(boxed.width_pt.0),
        number_to_string(boxed.height_pt.0),
        escape_xml_attr(r_id)
    );
    watermark_sdt(shapetype, &shape)
}

/// `watermarkParagraphXml`: the gray text watermark Word generates (shapetype
/// 136 = text-on-path), wrapped in the Watermarks building-block sdt so Word's
/// Design tab recognizes and replaces it. Lives as the first child of the
/// header part.
pub fn watermark_paragraph_xml(watermark: &Watermark) -> Result<String, String> {
    let bare;
    let wm: &WatermarkSpec = match watermark {
        Watermark::Text(text) => {
            bare = WatermarkSpec {
                text: text.clone(),
                font_family: None,
                color_hex: None,
                opacity: None,
                diagonal: None,
                bold: None,
                italic: None,
                box_pt: None,
                size_pt: None,
            };
            &bare
        }
        Watermark::Spec(spec) => spec,
        Watermark::Picture(_) => {
            return Err(
                "TypeError: Cannot read properties of undefined (reading 'length')".to_owned(),
            );
        }
    };
    let diagonal = wm.diagonal != Some(false);
    let boxed = text_watermark_box_pt(wm);
    let box_style = format!(
        "width:{}pt;height:{}pt;{}",
        number_to_string(boxed.width_pt.0),
        number_to_string(boxed.height_pt.0),
        if diagonal { "rotation:315;" } else { "" }
    );
    let opacity = math_max(0.0, math_min(1.0, wm.opacity.unwrap_or(0.5)));
    let fill = match wm.color_hex.as_deref().filter(|hex| !hex.is_empty()) {
        Some(hex) => format!("#{}", hex.strip_prefix('#').unwrap_or(hex)),
        None => "silver".to_owned(),
    };
    let font = escape_xml_attr(wm.font_family.as_deref().unwrap_or("DengXian"));
    let tp_style = format!(
        "font-family:&quot;{font}&quot;;font-size:1pt{}{}",
        if wm.bold == Some(true) {
            ";font-weight:bold"
        } else {
            ""
        },
        if wm.italic == Some(true) {
            ";font-style:italic"
        } else {
            ""
        }
    );
    let shape = format!(
        "<v:shape id=\"PowerPlusWaterMarkObject1\" o:spid=\"_x0000_s2049\" type=\"#_x0000_t136\" style=\"position:absolute;left:0;text-align:left;margin-left:0;margin-top:0;{box_style}z-index:-251656192;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin\" o:allowincell=\"f\" fillcolor=\"{}\" stroked=\"f\"><v:fill opacity=\"{}\"/><v:textpath style=\"{tp_style}\" string=\"{}\"/></v:shape>",
        escape_xml_attr(&fill),
        number_to_string(opacity),
        escape_xml_attr(&wm.text),
    );
    let shapetype = "<v:shapetype id=\"_x0000_t136\" coordsize=\"21600,21600\" o:spt=\"136\" adj=\"10800\" path=\"m@7,l@8,m@5,21600l@6,21600e\"><v:formulas><v:f eqn=\"sum #0 0 10800\"/><v:f eqn=\"prod #0 2 1\"/><v:f eqn=\"sum 21600 0 @1\"/><v:f eqn=\"sum 0 0 @2\"/><v:f eqn=\"sum 21600 0 @3\"/><v:f eqn=\"if @0 @3 0\"/><v:f eqn=\"if @0 21600 @1\"/><v:f eqn=\"if @0 0 @2\"/><v:f eqn=\"if @0 @4 21600\"/><v:f eqn=\"mid @5 @6\"/><v:f eqn=\"mid @8 @5\"/><v:f eqn=\"mid @7 @8\"/><v:f eqn=\"mid @6 @7\"/><v:f eqn=\"sum @6 0 @5\"/></v:formulas><v:path textpathok=\"t\" o:connecttype=\"custom\" o:connectlocs=\"@9,0;@10,10800;@11,21600;@12,10800\" o:connectangles=\"270,180,90,0\"/><v:textpath on=\"t\" fitshape=\"t\"/><v:handles><v:h position=\"#0,bottomRight\" xrange=\"6629,14971\"/></v:handles><o:lock v:ext=\"edit\" text=\"t\" shapetype=\"t\"/></v:shapetype>";
    Ok(watermark_sdt(shapetype, &shape))
}
