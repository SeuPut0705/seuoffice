//! What the property readers answer. Every expected value is the answer of
//! the TypeScript engine (parse-props.ts and the helpers it stands on) for
//! the same input; `tools/docx-diff` compares the two over the whole corpus.

use docx_engine::props::{self, CharIndents, CharUnits, ParaBorderModel, ParaBorderSides, Run};
use docx_engine::styles::run_border_of;
use docx_engine::theme::{ThemeColors, ThemeFonts, resolve_theme_color};
use docx_engine::xml_text;
use ooxml_xml::{XNode, parse_ordered, serialize_element};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn element(xml: &str) -> XNode {
    parse_ordered(xml, props::XML_PARSER_MAX_NESTED_TAGS)
        .expect("the test fragment parses")
        .into_iter()
        .next()
        .expect("the test fragment has an element")
}

fn as_json(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("the result serializes")
}

fn model<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("the test model deserializes")
}

/// The palette of a document without a theme part (`DEFAULT_THEME_COLORS`).
fn office_palette() -> ThemeColors {
    model(json!({
        "dk1": "000000", "lt1": "FFFFFF", "dk2": "44546A", "lt2": "E7E6E6",
        "accent1": "4472C4", "accent2": "ED7D31", "accent3": "A5A5A5",
        "accent4": "FFC000", "accent5": "5B9BD5", "accent6": "70AD47",
        "hlink": "0563C1", "folHlink": "954F72",
    }))
}

#[test]
fn hanging_indent_becomes_a_negative_first_line() {
    let twips = |xml| as_json(props::indent_twips_of(&element(xml)));
    assert_eq!(
        twips(r#"<w:ind w:left="720" w:hanging="360" w:firstLine="200"/>"#),
        json!({"left": 720, "firstLine": -360})
    );
    // a zero hanging does not hide the first-line indent
    assert_eq!(
        twips(r#"<w:ind w:hanging="0" w:firstLine="200"/>"#),
        json!({"firstLine": 200})
    );
    assert_eq!(
        twips(r#"<w:ind w:start="100" w:end="-5" w:firstLine="0"/>"#),
        json!({"left": 100, "right": -5, "firstLine": 0})
    );
    assert_eq!(
        twips(r#"<w:ind w:hanging="-5" w:firstLine="abc"/>"#),
        json!({"firstLine": 0})
    );
}

#[test]
fn twips_attributes_are_read_as_parse_int_reads_them() {
    assert_eq!(
        as_json(props::indent_twips_of(&element(
            r#"<w:ind w:left="12.9pt" w:firstLine=" 7"/>"#
        ))),
        json!({"left": 12, "firstLine": 7})
    );
}

#[test]
fn tab_stops_drop_unreadable_positions_and_default_to_left() {
    let p_pr = element(concat!(
        r#"<w:pPr><w:tabs><w:tab w:val="center" w:pos="4320" w:leader="dot"/>"#,
        r#"<w:tab w:val="num" w:pos="100.9"/><w:tab w:pos="x"/>"#,
        r#"<w:tab w:val="clear" w:pos="-360" w:leader="none"/></w:tabs></w:pPr>"#,
    ));
    assert_eq!(
        as_json(props::tab_stops_of(&p_pr)),
        json!([
            {"pos": 4320, "val": "center", "leader": "dot"},
            {"pos": 100, "val": "left"},
            {"pos": -360, "val": "clear"},
        ])
    );
}

#[test]
fn character_indents_keep_zero_and_drop_negatives() {
    let chars = |xml| as_json(props::char_indents_of(Some(&element(xml))));
    assert_eq!(
        chars(r#"<w:ind w:leftChars="150" w:firstLineChars="0" w:hangingChars="-100"/>"#),
        json!({"left": 150, "firstLine": 0})
    );
    assert_eq!(chars(r#"<w:ind w:left="1"/>"#), Value::Null);
    assert_eq!(as_json(props::char_indents_of(None)), Value::Null);
}

#[test]
fn either_special_character_indent_replaces_both() {
    let base: CharIndents = model(json!({"left": 100, "firstLine": 200}));
    let over: CharIndents = model(json!({"hanging": 0}));
    assert_eq!(
        as_json(props::merge_char_indents(Some(base), Some(over))),
        json!({"left": 100, "hanging": 0})
    );
    let chars: CharIndents = model(json!({"left": 0, "hanging": 50}));
    assert_eq!(
        as_json(props::active_char_indents(Some(&chars))),
        json!({"hanging": 50})
    );
}

#[test]
fn character_indents_resolve_to_rounded_twips() {
    let resolve = |format: Value, chars: Value, units: Value| {
        let format = format.as_object().cloned();
        Value::Object(props::resolve_char_indents(
            format.as_ref(),
            &model::<CharIndents>(chars),
            model::<CharUnits>(units),
        ))
    };
    // a character first-line indent beats a twips hanging indent
    assert_eq!(
        resolve(
            json!({"indentFirstLine": -360, "indentLeft": 720}),
            json!({"firstLine": 200}),
            json!({"run": 240, "normal": 210}),
        ),
        json!({"indentFirstLine": 480, "indentLeft": 720})
    );
    // hangingChars puts the left edge in character mode: 150 * 2.1 + 499
    assert_eq!(
        resolve(
            json!({"indentFirstLine": 360}),
            json!({"left": 150, "hanging": 250}),
            json!({"run": 199.5, "normal": 210}),
        ),
        json!({"indentFirstLine": -499, "indentLeft": 814})
    );
    // firstLineChars="0" cancels the twips first line
    assert_eq!(
        resolve(
            json!({"indentFirstLine": 360}),
            json!({"firstLine": 0, "right": 33.333}),
            json!({"run": 240, "normal": 210}),
        ),
        json!({"indentRight": 70})
    );
}

#[test]
fn an_empty_paragraph_is_sized_by_its_mark_then_its_last_run() {
    let rtl = element(r#"<w:p><w:pPr><w:rPr><w:rtl/><w:sz w:val="36"/></w:rPr></w:pPr></w:p>"#);
    assert_eq!(
        props::empty_para_size_half_points(&rtl, rtl.find_child("w:pPr"), false, Some(21.5)),
        Some(21.0)
    );
    let runs = element(concat!(
        r#"<w:p><w:pPr><w:rPr><w:sz w:val=""/></w:rPr></w:pPr>"#,
        r#"<w:r><w:rPr><w:sz w:val="18"/></w:rPr></w:r>"#,
        r#"<w:r><w:rPr><w:sz w:val="2pt"/></w:rPr></w:r></w:p>"#,
    ));
    let p_pr = runs.find_child("w:pPr");
    assert_eq!(
        props::empty_para_size_half_points(&runs, p_pr, false, None),
        Some(2.0)
    );
    assert_eq!(
        props::empty_para_size_half_points(&runs, p_pr, true, None),
        None
    );
}

#[test]
fn shading_blends_the_pattern_colour_over_the_fill() {
    let fill = |xml| props::shd_display_fill(Some(&element(xml)), None);
    let some = |hex: &str| Some(hex.to_owned());
    assert_eq!(
        fill(r#"<w:shd w:val="pct25" w:color="FF0000" w:fill="auto"/>"#),
        some("FFBFBF")
    );
    assert_eq!(
        fill(r#"<w:shd w:val="pct12" w:color="000000" w:fill="FFFFFF"/>"#),
        some("DFDFDF")
    );
    assert_eq!(
        fill(r#"<w:shd w:val="thinHorzStripe" w:color="0000FF"/>"#),
        some("BFBFFF")
    );
    assert_eq!(
        fill(r#"<w:shd w:val="solid" w:color="auto" w:fill="FFFF00"/>"#),
        some("000000")
    );
    // the percentage is read with Number(): "1e1" is 10, and 101 is no blend
    assert_eq!(
        fill(r##"<w:shd w:val="pct1e1" w:fill="#0000ff"/>"##),
        some("0000E6")
    );
    assert_eq!(
        fill(r#"<w:shd w:val="pct101" w:fill="0000ff"/>"#),
        some("0000ff")
    );
    assert_eq!(fill(r#"<w:shd w:val="clear" w:fill="12345"/>"#), None);
    assert_eq!(props::shd_display_fill(None, None), None);
}

#[test]
fn shading_resolves_theme_colours_when_given_a_palette() {
    let shd = element(concat!(
        r#"<w:shd w:val="pct50" w:themeColor="accent1" "#,
        r#"w:themeFill="background1" w:themeFillShade="D9"/>"#,
    ));
    assert_eq!(
        props::shd_display_fill(Some(&shd), Some(&office_palette())),
        Some("8FA6CF".to_owned())
    );
}

#[test]
fn table_look_reads_the_bit_mask_and_lets_attributes_override() {
    let look = |xml| as_json(props::table_look_of(Some(&element(xml))));
    let default_look = json!({
        "firstRow": true, "lastRow": false, "firstColumn": true,
        "lastColumn": false, "bandedRows": true, "bandedColumns": false,
    });
    assert_eq!(
        look(r#"<w:tblPr><w:tblLook w:val="04A0"/></w:tblPr>"#),
        default_look
    );
    assert_eq!(
        look(r#"<w:tblPr><w:tblLook w:val="zz"/></w:tblPr>"#),
        default_look
    );
    // a mask beyond 32 bits wraps as JavaScript's `&` wraps it
    assert_eq!(
        look(concat!(
            r#"<w:tblPr><w:tblLook w:val="FFFFFFFF0020" "#,
            r#"w:lastRow="1" w:noVBand="false"/></w:tblPr>"#,
        )),
        json!({
            "firstRow": true, "lastRow": true, "firstColumn": false,
            "lastColumn": false, "bandedRows": true, "bandedColumns": true,
        })
    );
    assert_eq!(
        props::row_band_size_of(Some(&element(
            r#"<w:tblPr><w:tblStyleRowBandSize w:val="3.7"/></w:tblPr>"#
        ))),
        Some(3.0)
    );
}

#[test]
fn duplicated_border_containers_merge_per_side() {
    let tbl_pr = element(concat!(
        r#"<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="nil"/>"#,
        r#"<w:start w:val="double" w:sz="8"/>"#,
        r##"<w:end w:val="dotted" w:sz="0" w:color="#FF0000"/>"##,
        r#"<w:insideH w:val="single" w:sz="0x10"/></w:tblBorders>"#,
        r#"<w:tblBorders><w:top w:val="double" w:sz="1e1"/>"#,
        r#"<w:bottom w:val="single" w:sz="abc" w:color=""/></w:tblBorders></w:tblPr>"#,
    ));
    assert_eq!(
        as_json(props::merged_border_lines_of(
            Some(&tbl_pr),
            "w:tblBorders",
            true
        )),
        json!({
            "top": {"style": "double", "szEighths": 10},
            "left": {"style": "nil"},
            "right": {"style": "dotted", "color": "FF0000"},
            "insideH": {"style": "single", "szEighths": 16},
            "bottom": {"style": "single"},
        })
    );
}

#[test]
fn cell_margins_skip_other_units_and_clamp_at_zero() {
    let margins = |xml| as_json(props::cell_margins_of(Some(&element(xml))));
    assert_eq!(
        margins(concat!(
            r#"<w:tcMar><w:top w:w="100" w:type="dxa"/><w:left w:w="-5"/><w:start w:w="20"/>"#,
            r#"<w:bottom w:w="5" w:type="pct"/><w:right w:w=""/><w:end w:w="7.5"/></w:tcMar>"#,
        )),
        json!({"top": 100, "right": 0, "left": 20})
    );
    assert_eq!(
        margins(concat!(
            r#"<w:tcMar><w:top w:w="0x10"/><w:left w:w="1e2"/>"#,
            r#"<w:bottom/><w:right w:w="Infinity"/></w:tcMar>"#,
        )),
        json!({"top": 16, "left": 100})
    );
}

#[test]
fn paragraph_border_sides_tell_reset_from_undeclared() {
    let p_pr = element(concat!(
        r#"<w:pPr><w:pBdr><w:top w:val="single" w:sz="12" w:space="1" w:color="FF0000"/>"#,
        r#"<w:bottom w:val="none" w:space="4"/><w:left w:val="nil"/>"#,
        r#"<w:right w:val="double" w:sz="0" w:color="auto"/></w:pBdr>"#,
        r#"<w:pBdr><w:top w:val="dashed" w:sz="5.5" w:themeColor="accent1" w:themeTint="99"/>"#,
        r#"</w:pBdr></w:pPr>"#,
    ));
    assert_eq!(
        as_json(props::para_border_sides_of(&p_pr, None)),
        json!({"t": {"szPt": 0.625}, "b": {"none": true, "spacePt": 4}, "l": null, "r": {}})
    );
    let themed = element(concat!(
        r##"<w:pPr><w:pBdr><w:top w:val="dashed" w:sz="5" w:color="#00ff00" "##,
        r#"w:themeColor="accent1" w:themeTint="99"/></w:pBdr></w:pPr>"#,
    ));
    assert_eq!(
        as_json(props::para_border_sides_of(
            &themed,
            Some(&office_palette())
        )),
        json!({"t": {"color": "8FAADC", "szPt": 0.625}})
    );
}

#[test]
fn paragraph_borders_fold_into_the_model_and_direct_wins_over_style() {
    let sides: ParaBorderSides = model(json!({
        "t": {"color": "FF0000", "szPt": 1.5, "spacePt": 1},
        "b": {"none": true, "spacePt": 4},
        "l": null,
        "r": {},
    }));
    assert_eq!(
        as_json(props::para_borders_of(&sides)),
        json!({
            "borders": "tr",
            "borderLines": {"t": {"color": "FF0000", "szPt": 1.5, "spacePt": 1}},
            "borderReset": "bl",
            "borderPad": {"b": 4},
        })
    );
    let style: ParaBorderSides = model(json!({
        "t": {"color": "FF0000"}, "b": {"szPt": 1}, "l": {"szPt": 2}, "r": null,
    }));
    let direct: ParaBorderModel = model(json!({
        "borders": "t", "borderReset": "b", "borderPad": {"l": 3},
    }));
    assert_eq!(
        as_json(props::merge_style_borders(&style, Some(&direct))),
        json!({"borders": "t", "borderPad": {"l": 3}})
    );
}

fn field(instruction: &str) -> String {
    format!(
        concat!(
            r#"<w:r><w:fldChar w:fldCharType="begin"/></w:r>"#,
            "<w:r><w:instrText>{}</w:instrText></w:r>",
            r#"<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>r</w:t></w:r>"#,
            r#"<w:r><w:fldChar w:fldCharType="end"/></w:r>"#,
        ),
        instruction
    )
}

#[test]
fn nested_fields_give_their_own_instruction_first() {
    let xml = format!(
        concat!(
            r#"<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>"#,
            "<w:r><w:instrText> IF </w:instrText></w:r>{}",
            "<w:r><w:instrText> = 1 &quot;a&quot; </w:instrText></w:r>",
            r#"<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>"#,
        ),
        field(" PAGE ")
    );
    assert_eq!(
        props::field_instructions(&xml),
        [" PAGE ", " IF  = 1 \"a\" "]
    );
    assert!(props::field_chars_balanced(&xml));
    assert!(!props::only_xe_fields(&xml));
}

#[test]
fn foldable_fields_keep_a_paragraph_editable() {
    let foldable = format!(
        r#"<w:p>{}{}<w:fldSimple w:instr=" PAGE "/></w:p>"#,
        field(r#" XE "t" "#),
        field(r#"HYPERLINK "https://e.com" \o "tip""#)
    );
    assert!(props::only_xe_fields(&foldable));
    assert!(!props::only_ole_fields(&foldable));

    let form = format!("<w:p>{}</w:p>", field(" FORMCHECKBOX "));
    assert!(!props::only_xe_fields(&form));
    // a fldSimple without w:instr cannot fold
    assert!(!props::only_xe_fields(
        "<w:p><w:fldSimple>x</w:fldSimple></w:p>"
    ));

    let ole = format!("<w:p>{}</w:p>", field(" EMBED Excel.Sheet.12 "));
    assert!(props::only_ole_fields(&ole));
}

#[test]
fn an_end_without_a_begin_is_unbalanced() {
    let xml = r#"<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>"#;
    assert!(!props::field_chars_balanced(xml));
    assert!(props::field_instructions(xml).is_empty());
}

#[test]
fn only_a_plain_hyperlink_instruction_converts() {
    let link = |instr| as_json(props::convertible_hyperlink(instr));
    assert_eq!(
        link(r#"HYPERLINK "https://e.com/a?b=1" \o "tip""#),
        json!({"href": "https://e.com/a?b=1", "tooltip": "tip"})
    );
    assert_eq!(
        link(" HYPERLINK &#34;https://e.com&#34;"),
        json!({"href": "https://e.com"})
    );
    assert_eq!(link(r#"HYPERLINK "a" \o """#), json!({"href": "a"}));
    assert_eq!(link(r#"HYPERLINK "a" \t "_blank""#), Value::Null);
}

#[test]
fn a_mail_merge_name_is_quoted_or_bare() {
    let name = |instr| {
        let found = props::mergefield_instr().exec(instr).expect("a MERGEFIELD");
        (found.get(1), found.get(2))
    };
    assert_eq!(
        name(r#" MERGEFIELD "First Name" \* Upper "#),
        (Some("First Name"), None)
    );
    assert_eq!(name("MERGEFIELD\u{a0}Name"), (None, Some("Name")));
}

#[test]
fn a_legacy_checkbox_prefers_checked_over_default() {
    let state = |xml| as_json(props::checkbox_state_of(Some(&element(xml))));
    assert_eq!(
        state(concat!(
            r#"<w:r><w:fldChar><w:ffData><w:checkBox><w:default w:val="1"/>"#,
            r#"<w:checked w:val="0"/></w:checkBox></w:ffData></w:fldChar></w:r>"#,
        )),
        json!({"checked": false})
    );
    assert_eq!(
        state(
            "<w:r><w:fldChar><w:ffData><w:checkBox><w:default/></w:checkBox></w:ffData></w:fldChar></w:r>"
        ),
        json!({"checked": true})
    );
    assert_eq!(
        state("<w:r><w:fldChar><w:ffData><w:checkBox/></w:ffData></w:fldChar></w:r>"),
        json!({"checked": false})
    );
    assert_eq!(state("<w:r><w:fldChar/></w:r>"), Value::Null);
}

#[test]
fn the_raw_ppr_is_the_first_child_and_spans_a_nested_ppr() {
    assert_eq!(
        props::raw_ppr_of(concat!(
            r#"<w:p><w:pPr><w:pPrChange><w:pPr><w:jc w:val="left"/></w:pPr>"#,
            "</w:pPrChange></w:pPr><w:r/></w:p>",
        )),
        Some(r#"<w:pPr><w:pPrChange><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>"#)
    );
    assert_eq!(
        props::raw_ppr_of("<w:p>\n  <w:pPr/>\n</w:p>"),
        Some("<w:pPr/>")
    );
    assert_eq!(
        props::raw_ppr_of(r#"<w:p><w:pPr a=">"><w:b/></w:pPr></w:p>"#),
        Some(r#"<w:pPr a=">"><w:b/></w:pPr>"#)
    );
    assert_eq!(props::raw_ppr_of("<w:p><w:r><w:pPr/></w:r></w:p>"), None);
    assert_eq!(props::raw_ppr_of("<w:p><w:pPr><w:jc/>"), None);
    assert_eq!(props::raw_ppr_of("no tag"), None);
}

#[test]
fn the_raw_ppr_scan_keeps_the_quirks_of_the_original() {
    // w:pPrChange is taken for a w:pPr opener only where it comes first
    assert_eq!(
        props::raw_ppr_of("<w:p><w:pPrChange/><w:pPr/></w:p>"),
        Some("<w:pPrChange/><w:pPr/>")
    );
    // a closer with white space before its `>` closes it (main 3f9c4cebb)
    assert_eq!(
        props::raw_ppr_of("<w:p><w:pPr\t><w:keepNext/></w:pPr\t></w:p>"),
        Some("<w:pPr\t><w:keepNext/></w:pPr\t>")
    );
}

#[test]
fn a_decorative_rule_reports_stroke_and_extent() {
    assert_eq!(
        as_json(props::rule_display_of(concat!(
            r#"<w:p><wp:extent cx="14287" cy="10"/><a:ln w="100"><a:solidFill>"#,
            "\n",
            r#"<a:srgbClr val="abcdef"/></a:solidFill></a:ln></w:p>"#,
        ))),
        json!({"ruleColorHex": "ABCDEF", "ruleThicknessPx": 1, "ruleWidthPx": 1})
    );
    assert_eq!(
        as_json(props::rule_display_of(
            r#"<w:p><wp:extent cx="4762" cy="10"/><a:ln w="19050"></a:ln></w:p>"#
        )),
        json!({"ruleThicknessPx": 2, "ruleWidthPx": 0})
    );
    assert!(props::is_thin_rule(r#"<wp:extent cx="1" cy="130000"/>"#));
    assert!(!props::is_thin_rule(r#"<wp:extent cx="1" cy="130001"/>"#));
    assert!(!props::is_thin_rule(r#"<wp:extent cx="0" cy="0"/>"#));
}

#[test]
fn vml_that_draws_nothing_is_invisible() {
    let invisible = props::is_invisible_vml_pict;
    assert!(invisible(r#"<w:pict><v:shapetype id="t"/></w:pict>"#));
    assert!(invisible(
        r#"<w:pict><v:rect fillcolor=" White " stroked="f"/></w:pict>"#
    ));
    assert!(invisible(
        r#"<w:pict><v:shape style="visibility:  hidden"/></w:pict>"#
    ));
    assert!(!invisible(
        r#"<w:pict><v:rect fillcolor="white" stroked="t"/></w:pict>"#
    ));
    assert!(!invisible("<w:pict><o:lock/></w:pict>"));
}

#[test]
fn bookmark_names_are_decoded_deduplicated_and_split_by_underscore() {
    assert_eq!(
        as_json(props::bookmark_names_of(concat!(
            r#"<w:p><w:bookmarkStart w:id="1" w:name="_Toc1"/>"#,
            r#"<w:bookmarkStart w:id="2" w:name="a &amp; b"/>"#,
            r#"<w:bookmarkStart w:id="3" w:name='q'/>"#,
            r#"<w:bookmarkStart w:id="4" w:name="a &amp; b"/>"#,
            r#"<w:bookmarkStart w:name="&#95;x"/></w:p>"#,
        ))),
        json!({"bookmarks": ["a & b", "q"], "hiddenBookmarks": ["_Toc1", "_x"]})
    );
}

#[test]
fn only_comment_ranges_with_one_end_here_are_reported() {
    assert_eq!(
        as_json(props::cross_para_comment_markers(concat!(
            r#"<w:p><w:commentRangeStart w:id="3"/><w:commentRangeStart w:id="4"/>"#,
            r#"<w:commentRangeEnd w:id="4"/><w:commentRangeEnd w:id = '5'/></w:p>"#,
        ))),
        json!({"commentStarts": ["3"], "commentEnds": ["5"]})
    );
}

#[test]
fn a_page_break_inside_a_textbox_is_not_the_host_paragraphs() {
    assert!(props::host_page_break(
        r#"<w:p><w:r><w:br w:clear="all" w:type="page"/></w:r></w:p>"#
    ));
    assert!(!props::host_page_break(concat!(
        "<w:p><w:r><w:pict><w:txbxContent><w:p><w:r>",
        r#"<w:br w:type="page"/></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>"#,
    )));
    // the original matches the double-quoted form only
    assert!(!props::host_page_break(
        "<w:p><w:r><w:br w:type='page'/></w:r></w:p>"
    ));
}

#[test]
fn a_vanished_paragraph_stays_vanished_unless_a_run_or_an_anchor_shows() {
    assert!(props::stays_vanished(
        "<w:p><w:r><w:rPr><w:vanish/></w:rPr></w:r></w:p>"
    ));
    assert!(!props::stays_vanished(
        "<w:p><w:r><w:rPr><w:vanish w:val='OFF'/></w:rPr></w:r></w:p>"
    ));
    assert!(!props::stays_vanished("<w:p><w:bookmarkStart/></w:p>"));
}

#[test]
fn xml_space_counts_on_the_part_root_only() {
    assert_eq!(
        props::part_xml_space_preserve("<w:hdr xml:space='preserve'><w:p/></w:hdr>", "w:hdr"),
        Ok(true)
    );
    assert_eq!(
        props::part_xml_space_preserve(r#"<w:hdr><w:p xml:space="preserve"/></w:hdr>"#, "w:hdr"),
        Ok(false)
    );
    // where the original throws a SyntaxError, the port refuses
    assert!(props::part_xml_space_preserve("<w:hdr/>", "w:(").is_err());
}

#[test]
fn theme_font_references_beat_literal_faces() {
    let fonts: ThemeFonts = model(json!({
        "major": "Maj", "minor": "Min", "eastAsia": "", "majorEastAsia": "",
        "majorCs": "", "minorCs": "", "eaLang": "ja-JP", "bidiLang": "ar-SA",
        "majorScripts": {"Jpan": "MS Gothic"}, "minorScripts": {"Arab": "Arial"},
    }));
    let themed = |xml, fonts| as_json(props::themed_r_fonts(&element(xml), fonts));
    assert_eq!(
        themed(
            concat!(
                r#"<w:rFonts w:ascii="A" w:hAnsi="B" w:eastAsia="C" w:cs="D" "#,
                r#"w:asciiTheme="majorBidi" w:hAnsiTheme="minorHAnsi" "#,
                r#"w:cstheme="minorBidi" w:eastAsiaTheme="majorEastAsia"/>"#,
            ),
            Some(&fonts)
        ),
        json!({
            "ascii": "Times New Roman", "hAnsi": "Min", "eastAsia": "MS Gothic", "cs": "Arial",
            "eaSlotEmpty": true,
            "themed": {"ascii": true, "hAnsi": true, "eastAsia": true},
        })
    );
    // an unknown reference falls back to the literal; an empty East Asian
    // slot takes the face of the document language
    assert_eq!(
        themed(
            r#"<w:rFonts w:ascii="A" w:eastAsia="C" w:asciiTheme="bogus" w:eastAsiaTheme="minorEastAsia"/>"#,
            Some(&fonts)
        ),
        json!({
            "ascii": "A", "eastAsia": "Yu Mincho", "eaSlotEmpty": true,
            "themed": {"ascii": false, "hAnsi": false, "eastAsia": true},
        })
    );
    assert_eq!(
        themed(r#"<w:rFonts w:ascii="A" w:asciiTheme="majorHAnsi"/>"#, None),
        json!({"ascii": "A", "themed": {"ascii": false, "hAnsi": false, "eastAsia": false}})
    );
}

fn serialized(runs: &[props::SyntheticRun<'_>]) -> Vec<String> {
    runs.iter()
        .map(|run| serialize_element("w:r", run.attrs, &run.children))
        .collect()
}

#[test]
fn a_symbol_gets_a_run_of_its_own() {
    let run = element(concat!(
        r#"<w:r w:rsidR="1"><w:rPr><w:b/></w:rPr><w:t>a</w:t>"#,
        r#"<w:sym w:font="W" w:char="F0FC"/><w:t>b</w:t><w:t>c</w:t></w:r>"#,
    ));
    assert_eq!(
        serialized(&props::split_sym_run(&run).expect("the run splits")),
        [
            r#"<w:r w:rsidR="1"><w:rPr><w:b/></w:rPr><w:t>a</w:t></w:r>"#,
            r#"<w:r w:rsidR="1"><w:rPr><w:b/></w:rPr><w:sym w:font="W" w:char="F0FC"/></w:r>"#,
            r#"<w:r w:rsidR="1"><w:rPr><w:b/></w:rPr><w:t>b</w:t><w:t>c</w:t></w:r>"#,
        ]
    );
}

#[test]
fn each_picture_ends_a_run() {
    let run = element(concat!(
        r#"<w:r w:rsidR="1"><w:rPr><w:b/></w:rPr>"#,
        "<w:drawing/><w:t>x</w:t><w:pict/><w:t>y</w:t></w:r>",
    ));
    assert_eq!(
        serialized(&props::split_image_run(&run)),
        [
            r#"<w:r w:rsidR="1"><w:rPr><w:b/></w:rPr><w:drawing/></w:r>"#,
            r#"<w:r w:rsidR="1"><w:rPr><w:b/></w:rPr><w:t>x</w:t><w:pict/></w:r>"#,
            r#"<w:r w:rsidR="1"><w:rPr><w:b/></w:rPr><w:t>y</w:t></w:r>"#,
        ]
    );
    let bare = element("<w:r><w:rPr><w:b/></w:rPr></w:r>");
    assert!(props::split_image_run(&bare).is_empty());
}

#[test]
fn neighbouring_runs_of_one_style_merge() {
    let runs: Vec<Run> = model(json!([
        {"text": "a", "bold": true},
        {"text": "b", "bold": true, "italic": false},
        {"text": "c"},
        {"text": "d", "xeTerm": ""},
        {"text": "e"},
    ]));
    assert_eq!(
        as_json(props::merge_runs(&runs)),
        json!([
            {"text": "ab", "bold": true},
            {"text": "c"},
            {"text": "d", "xeTerm": ""},
            {"text": "e"},
        ])
    );
}

#[test]
fn plain_text_separates_cells_and_decodes_entities() {
    assert_eq!(
        xml_text::plain_text(concat!(
            "<w:tbl><w:tr><w:tc><w:p/></w:tc><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc>",
            r#"<w:tc><w:p><w:r><w:tab/><w:t xml:space="preserve"> b&amp;c </w:t></w:r></w:p>"#,
            "</w:tc></w:tr></w:tbl>",
        )),
        "a  b&c "
    );
}

#[test]
fn entities_decode_once_and_bad_code_points_stay() {
    assert_eq!(
        xml_text::decode_entities(
            "&amp;lt; &#38;amp; &#x26;#65; &quot;&apos; &#xD800; &#1114112; &#x10FFFF;"
        ),
        "&lt; & &#65; \"' &#xD800; &#1114112; \u{10ffff}"
    );
    assert_eq!(
        xml_text::decode_numeric_char_refs("&#65;&#x42;&#X43;&amp;&#0;"),
        "ABC&amp;\0"
    );
}

#[test]
fn a_theme_colour_beats_a_stale_literal() {
    let palette = office_palette();
    let color = |xml| xml_text::color_from(Some(&element(xml)), Some(&palette));
    assert_eq!(
        color(
            r##"<w:rPr><w:color w:val="#00ff00" w:themeColor="accent2" w:themeShade="BF"/></w:rPr>"##
        ),
        Some("C55A11".to_owned())
    );
    assert_eq!(
        color(r#"<w:rPr><w:color w:val=" AABBCC " w:themeColor="none"/></w:rPr>"#),
        Some("AABBCC".to_owned())
    );
}

#[test]
fn tint_and_shade_scale_lightness() {
    let palette = office_palette();
    let some = |hex: &str| Some(hex.to_owned());
    assert_eq!(
        resolve_theme_color("accent1", &palette, Some("99"), None),
        some("8FAADC")
    );
    assert_eq!(
        resolve_theme_color("background1", &palette, Some("80"), Some("80")),
        some("BFBFBF")
    );
    // an unreadable factor is no factor
    assert_eq!(
        resolve_theme_color("accent2", &palette, Some("zz"), None),
        some("ED7D31")
    );
    // an empty palette still answers the text and background slots
    assert_eq!(
        resolve_theme_color("text1", &ThemeColors::default(), None, Some("BF")),
        some("000000")
    );
    let broken: ThemeColors = model(json!({"dk2": "xyz"}));
    assert_eq!(resolve_theme_color("dark2", &broken, None, None), None);
}

#[test]
fn on_off_toggles_are_three_state() {
    let r_pr = element(r#"<w:rPr><w:b w:val="OFF"/><w:i/></w:rPr>"#);
    assert_eq!(xml_text::on_off_of(&r_pr, "w:b"), Some(false));
    assert_eq!(xml_text::on_off_of(&r_pr, "w:i"), Some(true));
    assert_eq!(xml_text::on_off_of(&r_pr, "w:u"), None);
    assert_eq!(
        xml_text::on_off_tag_in("<w:rPr><w:B w:val='0'/></w:rPr>", "w:b"),
        Ok(Some(false))
    );
    assert!(xml_text::on_off_tag_in("<w:rPr><w:b/></w:rPr>", "w:(").is_err());
}

#[test]
fn a_run_border_has_a_floor_width() {
    let bdr = element(r##"<w:bdr w:val="dashed" w:sz="0" w:space="3" w:color="#112233"/>"##);
    assert_eq!(
        as_json(run_border_of(&bdr)),
        json!({"val": "dashed", "sz": 4, "color": "112233", "space": 3})
    );
    assert_eq!(run_border_of(&element(r#"<w:bdr w:val="nil"/>"#)), None);
}
