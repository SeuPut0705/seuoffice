//! Every expected value here is what `serializeXNode(xmlParser.parse(input))`
//! of the TypeScript engine returns for the same input (fast-xml-parser 5.10.1).

use super::*;

fn round_trip(xml: &str) -> Result<String, ParseError> {
    parse_ordered(xml, 100).map(|nodes| nodes.iter().map(serialize).collect())
}

#[track_caller]
fn assert_round_trip(xml: &str, expected: &str) {
    assert_eq!(round_trip(xml).as_deref(), Ok(expected), "input {xml:?}");
}

#[test]
fn a_run_property_fragment_comes_back_normalized() {
    assert_round_trip(
        r#"<w:rPr><w:b/><w:sz w:val="24"/></w:rPr>"#,
        r#"<w:rPr><w:b/><w:sz w:val="24"/></w:rPr>"#,
    );
    assert_round_trip("<w:rPr ><w:b />\n</w:rPr >", "<w:rPr><w:b/>\n</w:rPr>");
    assert_round_trip("<w:rPr></w:rPr>", "<w:rPr/>");
}

#[test]
fn the_tree_keeps_text_and_elements_in_document_order() {
    let nodes = parse_ordered(r#"<w:a b="1">t<w:c/><![CDATA[]]></w:a>x"#, 100).unwrap();
    assert_eq!(
        nodes,
        [XNode::Element(XElement {
            name: "w:a".into(),
            attrs: vec![("b".into(), "1".into())],
            children: vec![
                XNode::Text("t".into()),
                XNode::Element(XElement {
                    name: "w:c".into(),
                    attrs: vec![],
                    children: vec![]
                }),
                XNode::Text(String::new()),
            ],
        })]
    );
}

#[test]
fn the_five_xml_entities_are_decoded_and_written_back_escaped() {
    assert_round_trip(
        r#"<w:x a="a&amp;b&lt;c&gt;d&quot;e&apos;f"/>"#,
        r#"<w:x a="a&amp;b&lt;c&gt;d&quot;e'f"/>"#,
    );
    assert_round_trip(
        "<w:t>a &amp; &lt;b&gt; &quot;</w:t>",
        "<w:t>a &amp; &lt;b&gt; \"</w:t>",
    );
}

#[test]
fn numeric_references_and_unknown_entities_are_not_decoded() {
    assert_round_trip(
        r#"<w:x a="&#65;&#x41;"/>"#,
        r#"<w:x a="&amp;#65;&amp;#x41;"/>"#,
    );
    assert_round_trip(
        r#"<w:x a="&nbsp;&;&amp&lt "/>"#,
        r#"<w:x a="&amp;nbsp;&amp;;&amp;amp&amp;lt "/>"#,
    );
}

#[test]
fn references_to_forbidden_code_points_are_removed() {
    assert_round_trip(
        r#"<w:x a="[&#0;][&#x1F;][&#xD800;][&#9;][&#10;][&#13;][&#-0;]"/>"#,
        r#"<w:x a="[][][][&amp;#9;][&amp;#10;][&amp;#13;][]"/>"#,
    );
}

#[test]
fn an_element_whose_only_text_was_removed_self_closes() {
    assert_round_trip("<w:t>&#1;</w:t>", "<w:t/>");
}

#[test]
fn xml_1_1_keeps_control_references_until_another_declaration_resets_it() {
    assert_round_trip(
        r#"<?xml version="1.1"?><w:x a="[&#1;][&#0;]"/>"#,
        r#"<?xml version="1.1"/><w:x a="[&amp;#1;][]"/>"#,
    );
    assert_round_trip(
        r#"<?xml version="1.1"?><?other a="b"?><w:x a="[&#1;]"/>"#,
        r#"<?xml version="1.1"/><?other a="b"/><w:x a="[]"/>"#,
    );
}

#[test]
fn an_entity_name_is_at_most_32_utf16_units() {
    let at_limit = format!(r#"<w:x a="&#0{};"/>"#, " ".repeat(30));
    assert_round_trip(&at_limit, r#"<w:x a=""/>"#);
    let past_limit = format!(r#"<w:x a="&#0{};"/>"#, " ".repeat(31));
    assert_round_trip(
        &past_limit,
        &format!(r#"<w:x a="&amp;#0{};"/>"#, " ".repeat(31)),
    );
    let astral_at_limit = format!(r#"<w:x a="&#0{};"/>"#, "\u{1F600}".repeat(15));
    assert_round_trip(&astral_at_limit, r#"<w:x a=""/>"#);
    let astral_past_limit = format!(r#"<w:x a="&#0{};"/>"#, "\u{1F600}".repeat(16));
    assert_eq!(
        round_trip(&astral_past_limit)
            .unwrap()
            .matches("&amp;#0")
            .count(),
        1
    );
}

#[test]
fn line_ends_are_normalized_and_tabs_survive_only_inside_values() {
    assert_round_trip(
        "<w:x a=\"1\r\n2\r3\">a\r\nb\rc</w:x>",
        "<w:x a=\"1\n2\n3\">a\nb\nc</w:x>",
    );
    assert_round_trip(
        "<w:b\t/><w:u\tw:val=\"a\tb\"/>",
        "<w:b/><w:u w:val=\"a\tb\"/>",
    );
    assert_round_trip("<w:a> <w:b/> </w:a>", "<w:a> <w:b/> </w:a>");
}

#[test]
fn a_repeated_attribute_keeps_its_first_position_and_its_last_value() {
    assert_round_trip(r#"<w:x a="1" a="2" b="3" a="4"/>"#, r#"<w:x a="4" b="3"/>"#);
}

#[test]
fn integer_like_attribute_names_come_first_in_numeric_order() {
    assert_round_trip(
        r#"<w:x 10="ten" b="b" 2="two" 0="zero" 01="x" 4294967295="y"/>"#,
        r#"<w:x 0="zero" 2="two" 10="ten" b="b" 01="x" 4294967295="y"/>"#,
    );
}

#[test]
fn only_a_quoted_value_makes_an_attribute() {
    assert_round_trip(
        r#"<w:x novalue a="1" bare=unquoted b="2"/>"#,
        r#"<w:x a="1" b="2"/>"#,
    );
    assert_round_trip(
        r#"<w:x a='it"s' b = "spaced"/>"#,
        r#"<w:x a="it&quot;s" b="spaced"/>"#,
    );
    assert_round_trip(r#"<w:x/ a="1"/>"#, "<w:x/>");
}

#[test]
fn names_that_collide_with_object_internals_are_renamed_or_rejected() {
    assert_round_trip(
        r#"<w:x toString="1"/><toString/>"#,
        r#"<w:x __toString="1"/><__toString/>"#,
    );
    for xml in [
        r#"<w:x constructor="1"/>"#,
        "<w:x prototype/>",
        "<constructor/>",
        "<a></ prototype >",
    ] {
        assert!(
            matches!(round_trip(xml), Err(ParseError::ReservedName(_))),
            "{xml}"
        );
    }
    assert_eq!(
        round_trip("<#text>"),
        Err(ParseError::InvalidTagName("#text".into()))
    );
}

#[test]
fn elements_the_serializer_cannot_name_vanish_with_their_content() {
    assert_round_trip("<>x</><w:b/>", "<w:b/>");
    assert_round_trip(r#"<:@ a="1">x</:@><w:b/>"#, "<w:b/>");
    assert_round_trip("<#text/>", "");
}

#[test]
fn comments_vanish_without_splitting_the_text_around_them() {
    assert_round_trip("<w:a>a<!-- c -->b<w:b/>c</w:a>", "<w:a>ab<w:b/>c</w:a>");
    let nodes = parse_ordered("<w:a>a<!-- c -->b</w:a>", 100).unwrap();
    let XNode::Element(element) = &nodes[0] else {
        panic!("an element")
    };
    assert_eq!(element.children, [XNode::Text("ab".into())]);
    assert_round_trip("<!---->x<!-->y--><w:b/>", "<w:b/>");
}

#[test]
fn cdata_is_text_taken_literally() {
    assert_round_trip(
        "<w:a><![CDATA[a<b&amp;]]><![CDATA[]]></w:a>",
        "<w:a>a&lt;b&amp;amp;</w:a>",
    );
    assert_round_trip("<![]]>", "]]&gt;");
    assert_round_trip("<![\u{E9}\u{E9}\u{E9}\u{E9}\u{E9}\u{E9}x]]>", "x");
}

#[test]
fn a_processing_instruction_is_an_element_with_empty_text() {
    assert_round_trip(r#"<w:a><?pi a="1" b?></w:a>"#, r#"<w:a><?pi a="1"/></w:a>"#);
}

#[test]
fn text_directly_under_the_document_is_kept_only_before_some_constructs() {
    assert_round_trip("text<w:a/>", "<w:a/>");
    assert_round_trip("text<?pi?>", "text<?pi/>");
    assert_round_trip("kept</w:a>", "kept");
    assert_round_trip("<w:a>kept</w:a>dropped", "<w:a>kept</w:a>");
}

#[test]
fn control_characters_are_dropped_on_the_way_out() {
    assert_round_trip("<w:a>\u{1}x\u{1F}</w:a>", "<w:a>x</w:a>");
    assert_round_trip("<w:a b=\"\u{1}&quot;\"/>", r#"<w:a b="&quot;"/>"#);
}

#[test]
fn closing_tags_close_whatever_is_open() {
    assert_round_trip("<w:a><w:b></w:a></w:b><w:c/>", "<w:a><w:b/></w:a><w:c/>");
}

#[test]
fn elements_left_open_are_kept_and_the_text_after_the_last_tag_is_not() {
    assert_round_trip("<w:a><w:b>dropped", "<w:a><w:b/></w:a>");
}

#[test]
fn after_a_closing_tag_with_nothing_open_only_text_comments_and_closing_tags_pass() {
    assert_round_trip("</w:a>text</w:b><!-- c -->", "");
    for xml in [
        "</w:a><w:b/>",
        "</w:a><w:b>",
        "</w:a><?pi?>",
        "</w:a><![CDATA[x]]>",
    ] {
        assert_eq!(round_trip(xml), Err(ParseError::NoOpenNode), "{xml}");
    }
}

#[test]
fn unterminated_constructs_are_errors() {
    assert_eq!(round_trip("<w:a"), Err(ParseError::TagNotClosed));
    assert_eq!(round_trip("<w:a b=\"c>"), Err(ParseError::TagNotClosed));
    assert_eq!(round_trip("</w:a"), Err(ParseError::ClosingTagNotClosed));
    assert_eq!(round_trip("<!-- never"), Err(ParseError::CommentNotClosed));
    assert_eq!(
        round_trip("<![CDATA[never"),
        Err(ParseError::CdataNotClosed)
    );
    assert_eq!(round_trip("<?never"), Err(ParseError::PiNotClosed));
}

#[test]
fn nesting_is_limited_to_one_past_the_configured_depth() {
    assert!(parse_ordered(&"<a>".repeat(101), 100).is_ok());
    assert_eq!(
        parse_ordered(&"<a>".repeat(102), 100),
        Err(ParseError::MaxNestedTags)
    );
    assert!(parse_ordered(&"<a>".repeat(102), 101).is_ok());
}

#[test]
fn a_self_closing_tag_is_not_a_nesting_level() {
    assert!(parse_ordered(&("<a>".repeat(101) + "<b/>"), 100).is_ok());
}

#[test]
fn a_tree_far_deeper_than_the_call_stack_parses_serializes_and_drops() {
    let depth = 200_000;
    let xml = "<a>".repeat(depth) + "x" + &"</a>".repeat(depth);
    let nodes = parse_ordered(&xml, usize::MAX).unwrap();
    assert_eq!(nodes.iter().map(serialize).collect::<String>(), xml);
}

#[test]
fn what_is_not_ported_is_an_error_not_a_guess() {
    // the original accepts a document type declaration and registers its entities
    assert_eq!(round_trip("<!DOCTYPE a>"), Err(ParseError::Doctype));
    // the original cuts the pair in half and keeps a lone surrogate
    assert_eq!(
        round_trip("<![x\u{1F600}\u{1F600}\u{1F600}]]>"),
        Err(ParseError::SplitSurrogatePair)
    );
}
