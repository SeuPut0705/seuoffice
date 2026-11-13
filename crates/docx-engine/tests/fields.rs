//! Field, EQ field, SDT and field-balance readers. Every expected value is
//! what the TypeScript of packages/docx-engine/src (parse-fields.ts,
//! eq-field.ts, parse-sdt.ts, field-balance.ts) returned for the same input,
//! printed with `npx tsx` and `JSON.stringify`. The inputs are ASCII, so the
//! byte offsets of the Rust equal the UTF-16 offsets it printed.

use docx_engine::eq_field::eq_field_to_omml;
use docx_engine::field_balance::balance_field_chars;
use docx_engine::fields::{field_label, field_stack_after, tag_attr, toc_level_of};
use docx_engine::sdt::{SdtRange, parse_sdt_block, sdt_ranges, split_sdt_parts};

#[test]
fn eq_fraction_and_depth_limit() {
    let fraction = eq_field_to_omml(r"EQ \f(1,2)").expect("an EQ field");
    assert_eq!(fraction.text, "1/2");
    assert_eq!(
        fraction.omml,
        r#"<m:oMath><m:f><m:num><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve">1</m:t></m:r></m:num><m:den><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve">2</m:t></m:r></m:den></m:f></m:oMath>"#
    );
    let nested = |depth: usize| format!("EQ {}x{}", r"\r(".repeat(depth), ")".repeat(depth));
    let deepest = eq_field_to_omml(&nested(64)).expect("64 levels lay out");
    assert_eq!(
        deepest.text,
        format!("{}x{}", "\u{221A}(".repeat(64), ")".repeat(64))
    );
    assert_eq!(eq_field_to_omml(&nested(65)), None);
    // a character switch argument outside the BMP is half a pair: no layout
    assert_eq!(eq_field_to_omml("EQ \\b\\bc\\\u{1F600}(x)"), None);
}

#[test]
fn balance_closes_an_open_begin_and_drops_a_stray_end() {
    assert_eq!(
        balance_field_chars(
            r#"<w:body><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:p></w:body>"#
        ),
        r#"<w:body><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body>"#
    );
    assert_eq!(
        balance_field_chars(
            r#"<w:body><w:p><w:r><w:t>a</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body>"#
        ),
        "<w:body><w:p><w:r><w:t>a</w:t></w:r></w:p></w:body>"
    );
    let commented = r#"<w:body><!-- <w:r><w:fldChar w:fldCharType="end"/></w:r> --></w:body>"#;
    assert_eq!(balance_field_chars(commented), commented);
}

#[test]
fn nested_controls_keep_their_own_ranges() {
    let nested = r#"<w:sdt><w:sdtContent><w:sdt><w:sdtPr><w:tag w:val="in"/></w:sdtPr><w:sdtContent><w:p/></w:sdtContent></w:sdt><w:p/></w:sdtContent></w:sdt>"#;
    let range = |open_start, open_end, close_start, close_end| SdtRange {
        open_start,
        open_end,
        close_start,
        close_end,
    };
    assert_eq!(
        sdt_ranges(nested).unwrap(),
        [range(0, 21, 115, 138), range(21, 80, 86, 109)]
    );
    let parts = split_sdt_parts(nested).unwrap().expect("two paragraphs");
    let summary: Vec<_> = parts
        .iter()
        .map(|part| {
            (
                part.name.as_str(),
                part.start,
                part.end,
                part.child_start,
                part.child_end,
                part.chain.len(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [("w:p", 0, 109, 80, 86, 2), ("w:p", 109, 138, 109, 115, 1)]
    );
    let block = parse_sdt_block(nested).unwrap().expect("a paragraph");
    assert_eq!(block.p_xml, "<w:p/>");
    // the outer control has no w:sdtPr of its own and reads the inner one's
    let tags: Vec<_> = block
        .chain
        .iter()
        .map(|level| level.shell.meta.tag.as_str())
        .collect();
    assert_eq!(tags, ["in", "in"]);
}

#[test]
fn field_readers() {
    assert!(tag_attr("<w:p/>", "w:(", "w:val").is_err());
    assert_eq!(
        tag_attr(r#"<w:a{ w:val="b"/>"#, "w:a{", "w:val").ok(),
        Some(None)
    );
    assert_eq!(
        field_label(
            r#"<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:br w:type="page"/></w:r></w:p>"#
        ),
        "Field end marker + page break"
    );
    assert_eq!(
        field_label("<w:p><w:r><w:instrText> stra\u{DF}e x</w:instrText></w:r></w:p>"),
        "Field (STRASSE)"
    );
    assert_eq!(toc_level_of("TOC 9", None), Some(9.0));
    assert_eq!(toc_level_of("toc10", None), None);
    assert_eq!(toc_level_of("TableofFigures", None), Some(1.0));
    assert_eq!(
        field_stack_after(
            r#"<w:fldChar w:fldCharType="end"/><w:fldChar w:fldCharType="separate"/><w:fldChar w:fldCharType="begin"/>"#,
            &[false],
        ),
        [false]
    );
}
