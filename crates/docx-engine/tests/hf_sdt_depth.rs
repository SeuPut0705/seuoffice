//! A header whose original part nests block controls deeply: the walk through
//! them is a loop, so depth costs heap, never stack.

use docx_engine::model::HeaderFooter;
use docx_engine::save::parts::hf_parts::header_footer_part_xml;

fn nested_header(depth: usize) -> String {
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:hdr \
         xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
    );
    for _ in 0..depth {
        xml.push_str("<w:sdt><w:sdtPr/><w:sdtContent>");
    }
    xml.push_str("<w:p><w:r><w:t>x</w:t></w:r></w:p>");
    for _ in 0..depth {
        xml.push_str("</w:sdtContent></w:sdt>");
    }
    xml.push_str("</w:hdr>");
    xml
}

#[test]
fn deeply_nested_controls_finish_without_recursion() {
    let hf = HeaderFooter::default();
    let original = nested_header(900);
    let out = header_footer_part_xml("header", &hf, None, Some(&original), 1.0)
        .expect("depth within the bound");
    assert_eq!(out.matches("<w:sdt>").count(), 900);
}

#[test]
fn nesting_past_the_bound_is_the_engine_error() {
    let hf = HeaderFooter::default();
    let original = nested_header(5_000);
    let error = header_footer_part_xml("header", &hf, None, Some(&original), 1.0)
        .expect_err("past the bound");
    assert!(
        error.contains("Maximum call stack size exceeded"),
        "{error}"
    );
}
