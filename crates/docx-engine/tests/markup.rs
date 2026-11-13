//! Markup read as an XML parser reads it. Every expected value is the answer
//! of the TypeScript engine (xml-tag.ts and ooxml-normalize.ts) for the same
//! input; `tools/docx-diff` compares the two over the whole corpus.

use docx_engine::props::{raw_ppr_of, strip_textboxes};
use docx_engine::xml_tag::{XmlSegment, element_inner, remove_segments, xml_segments};
use ooxml_pkg::canonical_xml_syntax;

#[test]
fn canonical_syntax_writes_the_usual_spelling() {
    for (spelled, usual) in [
        (r#"<a b = 'c' d="e>f"/>"#, r#"<a b="c" d="e&gt;f"/>"#),
        (
            "<w:t xml:space = 'preserve'>x</w:t >",
            r#"<w:t xml:space="preserve">x</w:t>"#,
        ),
        (
            r#"<!-- c --><![CDATA[a<b]]><?php x?><?xml version="1.0"?><a/>"#,
            r#"a&lt;b<?xml version="1.0"?><a/>"#,
        ),
        // a quote in the name is no value: the tag is as it was
        (r#"<a"b c="d">"#, r#"<a"b c="d">"#),
        (r#"<w:p><w:r a="1"/></w:p>"#, r#"<w:p><w:r a="1"/></w:p>"#),
    ] {
        assert_eq!(canonical_xml_syntax(spelled), usual, "{spelled}");
    }
}

#[test]
fn segments_ignore_markup_that_is_no_markup() {
    let xml = r#"<w:p><!-- <w:drawing> --><w:drawing a=">">x</w:drawing ></w:p>"#;
    assert_eq!(
        xml_segments(xml, "w:drawing", 0, xml.len()),
        [XmlSegment { start: 25, end: 56 }]
    );
    assert_eq!(
        remove_segments(xml, "w:drawing"),
        "<w:p><!-- <w:drawing> --></w:p>"
    );
}

#[test]
fn an_element_holds_what_is_between_its_own_tags() {
    assert_eq!(
        element_inner(r#"<w:tc a=">">in<!-- </w:tc> -->x</w:tc >"#),
        "in<!-- </w:tc> -->x"
    );
    assert_eq!(element_inner("<w:tc/>"), "");
}

#[test]
fn a_paragraph_keeps_its_properties_through_other_spellings() {
    let xml =
        r#"<w:p w:x=">"><!-- <w:pPr/> --><w:pPr><w:keepNext/><!-- </w:pPr> --></w:pPr ></w:p>"#;
    assert_eq!(
        raw_ppr_of(xml),
        Some("<w:pPr><w:keepNext/><!-- </w:pPr> --></w:pPr >")
    );
    assert_eq!(
        strip_textboxes(r#"a<w:txbxContent x=">">b</w:txbxContent >c"#),
        "ac"
    );
}
