//! Boundaries of the section, watermark, notes and VML readers. Every expected
//! value is what the TypeScript function returned for the same input, printed
//! with `JSON.stringify` by a `npx tsx` script calling section.ts, watermark.ts,
//! notes.ts and parse-vml.ts.

use docx_engine::notes::{NoteInfo, NoteKind, next_note_id, parse_notes_xml, root_attributes};
use docx_engine::section::{
    NotePrTag, SectionBlock, line_numbering_of, note_props_from_xml, read_sections,
    section_from_sect_pr, section_settings_from_xml,
};
use docx_engine::vml::{vml_color_hex, vml_rotation_deg, vml_style_prop};
use docx_engine::watermark::{
    PictureWatermarkSpec, WatermarkImage, picture_watermark_box_pt, read_picture_watermark,
    read_watermark_shape,
};
use serde::Serialize;
use serde_json::{Value, json};

fn as_json(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("the result serializes")
}

/// A tie rounds up (-1440.5 is -1440), the gutter goes to the top, an art
/// border keeps w:sz in points and a fractional column width rounds.
#[test]
fn page_setup_rounds_and_folds_the_gutter() {
    let xml = r#"<w:sectPr><w:pgMar w:top="-1440.5" w:bottom="720" w:left="1987.1997" w:gutter="360" w:header="abc"/><w:pgBorders w:display="firstPage"><w:top w:val="gems" w:sz="20" w:space="5"/><w:left w:val="double" w:sz="12" w:color="00ff00"/><w:right w:val="none"/></w:pgBorders><w:cols w:num="2"><w:col w:w="2000"/><w:col w:w="3000.5"/></w:cols></w:sectPr>"#;
    assert_eq!(
        as_json(section_settings_from_xml(xml, Some(true))),
        json!({
            "pageWidth": 12240, "pageHeight": 15840, "orientation": "portrait",
            "marginTop": 1800, "marginRight": 1440, "marginBottom": 720, "marginLeft": 1987,
            "marginTopFixed": true, "gutter": 360, "gutterAtTop": true,
            "headerDist": 720, "footerDist": 720, "pageBorder": true,
            "pageBorderProps": {
                "display": "firstPage", "spacePt": 5, "widthPt": 20, "color": "00ff00",
                "sides": {
                    "top": {"val": "gems", "widthPt": 20, "spacePt": 5, "art": true},
                    "left": {"val": "double", "widthPt": 1.5, "spacePt": 0, "color": "00ff00"}
                }
            },
            "columns": 2, "colSpace": 720, "colWidths": [2000, 3001]
        })
    );
}

#[test]
fn note_props_and_line_numbering_clamp() {
    let props = r#"<w:footnotePr><w:numStart w:val="03"/><w:pos w:val="bogus"/></w:footnotePr>"#;
    assert_eq!(
        as_json(note_props_from_xml(props, NotePrTag::Footnote)),
        json!({"numStart": 3})
    );
    let negative = r#"<w:footnotePr><w:numStart w:val="-1"/></w:footnotePr>"#;
    assert_eq!(note_props_from_xml(negative, NotePrTag::Footnote), None);
    let numbering = r#"<w:lnNumType w:countBy="0" w:start="-2" w:restart="newSection"/>"#;
    assert_eq!(
        as_json(line_numbering_of(numbering)),
        json!({"countBy": 1, "start": 1, "restart": "newSection"})
    );
}

/// Without a sectPr the one section spans up to the last block's index; an
/// empty r:id leaves its variant unset and w:val="0" switches titlePg off.
#[test]
fn sections_default_and_references() {
    let blocks = [SectionBlock {
        docx_index: Some(4.0),
        ..SectionBlock::default()
    }];
    let sections = as_json(read_sections(&blocks, None));
    assert_eq!(sections[0]["lastBlockIndex"], json!(4));
    assert_eq!(sections[0]["sectPrXml"], json!(""));
    let xml = r#"<w:sectPr><w:headerReference w:type="first" r:id="rId1"/><w:headerReference r:id="rId2"/><w:headerReference w:type="even" r:id=""/><w:type w:val="oddPage"/><w:pgNumType w:start="05" w:fmt="upperRoman"/><w:titlePg w:val="0"/></w:sectPr>"#;
    let section = as_json(section_from_sect_pr(xml, 1.0, 3.0, None));
    assert_eq!(section["startType"], json!("oddPage"));
    assert_eq!(section["titlePg"], json!(false));
    assert_eq!(section["pageNumberStart"], json!(5));
    // an object filled in file order, as the TypeScript writes it
    assert_eq!(
        section["headerRefs"],
        json!({"first": "rId1", "default": "rId2"})
    );
}

#[test]
fn vml_readers() {
    assert_eq!(vml_rotation_deg("rotation:41366637fd"), Some(271.2));
    assert_eq!(vml_rotation_deg("rotation:-45"), Some(315.0));
    assert_eq!(vml_rotation_deg("rotation:360"), None);
    assert_eq!(vml_color_hex(Some("#abc")).as_deref(), Some("aabbcc"));
    assert_eq!(vml_color_hex(Some("Red [3204]")).as_deref(), Some("FF0000"));
    assert_eq!(
        vml_color_hex(Some("#dbe5f1 [3204]")).as_deref(),
        Some("dbe5f1")
    );
    assert_eq!(vml_style_prop("a:1; width : 2in ;b:2", "width"), Ok(None));
    assert!(vml_style_prop("a:1", "w(").is_err());
}

#[test]
fn watermarks() {
    let pict = r#"<w:pict><v:shape id="x" style="width:6in;height:2in;rotation:315;z-index:-5;mso-position-horizontal:center;margin-top:1in" fillcolor="silver"><v:fill opacity=".5"/><v:textpath style="font-family:&quot;Arial&quot;;font-weight:bold" string="A &amp;lt; B"/></v:shape></w:pict>"#;
    assert_eq!(
        as_json(read_watermark_shape(pict)),
        json!({
            "dataUrl": "", "widthPx": 576, "heightPx": 192, "floating": true,
            "wordArt": {
                "text": "A &lt; B", "colorHex": "C0C0C0", "opacity": 0.5,
                "fontFamily": "Arial", "bold": true
            },
            "behind": true, "rotationDeg": 315, "posHRel": "margin", "posVRel": "margin",
            "posH": "center", "posYPx": 96
        })
    );
    let header = r#"<w:hdr><v:shape id="WordPictureWatermark1" style="width:4in;height:3cm"><v:imagedata r:id='rId9' gain="1"/></v:shape></w:hdr>"#;
    assert_eq!(
        as_json(read_picture_watermark(header)),
        json!({"rId": "rId9", "widthPt": 288, "heightPt": 85.04, "washout": true})
    );
    let spec = |width_px, height_px| PictureWatermarkSpec {
        image: WatermarkImage {
            base64: String::new(),
            mime: "image/png".to_owned(),
            width_px,
            height_px,
        },
        scale: None,
        washout: None,
    };
    // 0/0 is NaN and Math.max(1, NaN) stays NaN
    assert_eq!(
        as_json(picture_watermark_box_pt(&spec(0.0, 0.0), None)),
        json!({"widthPt": null, "heightPt": null})
    );
    assert_eq!(
        as_json(picture_watermark_box_pt(&spec(800.0, 600.0), None)),
        json!({"widthPt": 468, "heightPt": 351})
    );
}

#[test]
fn notes() {
    let xml = r#"<w:footnotes><w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote><w:footnote w:id="2"><w:p><w:r><w:footnoteRef /></w:r><w:r><w:t xml:space="preserve"> A &amp; B</w:t></w:r></w:p><w:p><w:r><w:t>C</w:t></w:r></w:p></w:footnote><w:footnote w:id="3"/><w:footnote w:id='4'><w:p><w:pPr><w:pStyle w:val="X"/></w:pPr></w:p></w:footnote></w:footnotes>"#;
    assert_eq!(
        as_json(parse_notes_xml(xml, NoteKind::Footnote)),
        json!([
            {"id": "2", "text": "A & B\nC"},
            {"id": "4", "text": "", "styleId": "X", "noRefMark": true}
        ])
    );
    let note = |id: &str| NoteInfo {
        id: id.to_owned(),
        text: String::new(),
        model_text: None,
        style_id: None,
        zotero_field: None,
        no_ref_mark: None,
    };
    assert_eq!(
        next_note_id(&[note("999999999999999999999"), note("-5")]),
        "1e+21"
    );
}

/// The root tag is a pattern only where there is an original text.
#[test]
fn root_attributes_keep_the_original_namespaces() {
    assert!(root_attributes(Some("<w:x/>"), "w:(", "fb", &[]).is_err());
    let w14 = [("w14".to_owned(), "u".to_owned())];
    assert_eq!(
        root_attributes(Some(""), "w:(", "fb", &w14).as_deref(),
        Ok(r#"fb xmlns:w14="u""#)
    );
    let both = [
        ("w14".to_owned(), "u".to_owned()),
        ("r".to_owned(), "v".to_owned()),
    ];
    assert_eq!(
        root_attributes(
            Some(r#"<w:footnotes xmlns:w="a" xmlns:w14="b" >"#),
            "w:footnotes",
            "fb",
            &both
        )
        .as_deref(),
        Ok(r#"xmlns:w="a" xmlns:w14="b" xmlns:r="v""#)
    );
}
