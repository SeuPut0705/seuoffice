//! The hidden-from-AI readers. Every expected value is what the TypeScript
//! function returned for the same input, printed with `JSON.stringify` by a
//! `npx tsx` script calling withheld.ts, comment-slices.ts, text-patch.ts and
//! notes.ts of tools/docx-diff/reference.

use docx_engine::notes::{NoteKind, note_model_text, parse_notes_xml};
use docx_engine::save::parts::text_patch::patch_paragraph_texts;
use docx_engine::withheld::{
    comment_entries, first_mark_label, over_withheld, over_withheld_model_text, parse_entry,
    placeholder_source, runs_text, with_redact_namespace, withheld_label_of, withheld_node,
    withheld_text,
};
use serde_json::json;

#[test]
fn a_placeholder_reads_a_cleaned_label() {
    assert_eq!(placeholder_source("phone"), "{{phone}}");
    assert_eq!(placeholder_source(""), "{{private}}");
    assert_eq!(placeholder_source("  a   b  "), "{{a b}}");
    assert_eq!(placeholder_source("{x}<y>\"z\"'w'="), "{{xyzw}}");
    assert_eq!(placeholder_source("$&"), "{{$&}}");
    // forty units at most, never half of a surrogate pair
    let straddling = format!("{}\u{1F600}b", "a".repeat(39));
    assert_eq!(
        placeholder_source(&straddling),
        format!("{{{{{}}}}}", "a".repeat(39))
    );
    assert_eq!(
        placeholder_source(&"a".repeat(45)),
        format!("{{{{{}}}}}", "a".repeat(40))
    );
    assert_eq!(
        placeholder_source(&"\u{1F600}".repeat(25)),
        format!("{{{{{}}}}}", "\u{1F600}".repeat(20))
    );
}

#[test]
fn a_label_is_read_from_the_serialised_rpr() {
    let label = |xml: &str| withheld_label_of(Some(xml));
    assert_eq!(
        label(r#"<w:rPr><go:redact w:label="a &amp; b"/></w:rPr>"#).as_deref(),
        Some("a & b")
    );
    assert_eq!(
        label("<w:rPr><go:redact/></w:rPr>").as_deref(),
        Some("private")
    );
    assert_eq!(label("<w:rPr><w:b/></w:rPr>"), None);
    assert_eq!(
        label(r#"<w:rPr><redact w:label=""/></w:rPr>"#).as_deref(),
        Some("")
    );
    assert_eq!(withheld_label_of(None), None);
    assert_eq!(withheld_label_of(Some("")), None);
}

#[test]
fn an_entry_written_anew_is_hidden_under_the_first_label() {
    let entry = r#"<w:comment w:id="1"><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>words</w:t></w:r><w:r><w:t> </w:t></w:r><w:r w:x="1"><w:t>more</w:t></w:r></w:p></w:comment>"#;
    // a `$&` of the label is read as the replacement pattern it is in the TypeScript
    assert_eq!(
        over_withheld(entry, "p$&q"),
        r#"<w:comment w:id="1"><w:p><w:r><w:rPr><w:b/><w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/><go:redact xmlns:go="https://genspark.ai/genoffice/redaction/2026" w:label="p</w:rPr>amp;q"/></w:rPr><w:t>words</w:t></w:r><w:r><w:t> </w:t></w:r><w:r w:x="1"><w:rPr><w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/><go:redact xmlns:go="https://genspark.ai/genoffice/redaction/2026" w:label="p$&amp;q"/></w:rPr><w:t>more</w:t></w:r></w:p></w:comment>"#
    );
    assert_eq!(over_withheld_model_text("a\n \nb", "q"), "{{q}}\n \n{{q}}");
}

#[test]
fn a_part_root_declares_the_mark_and_ignores_it() {
    let read = |xml: &str| with_redact_namespace(xml, "w:comments").unwrap();
    assert_eq!(
        read(r#"<w:comments xmlns:w="w"><go:redact/></w:comments>"#),
        r#"<w:comments mc:Ignorable="go" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:go="https://genspark.ai/genoffice/redaction/2026" xmlns:w="w"><go:redact/></w:comments>"#
    );
    assert_eq!(
        read(
            r#"<w:comments xmlns:w="w" xmlns:mc="mc" mc:Ignorable="w14 $&"><go:redact/></w:comments>"#
        ),
        r#"<w:comments xmlns:go="https://genspark.ai/genoffice/redaction/2026" xmlns:w="w" xmlns:mc="mc" mc:Ignorable="w14 mc:Ignorable="w14 $&" go"><go:redact/></w:comments>"#
    );
    // another binding of the prefix is left as it is
    let other = r#"<w:comments xmlns:go="other"><go:redact/></w:comments>"#;
    assert_eq!(read(other), other);
    assert!(with_redact_namespace("<w:(", "w:(").is_err());
}

#[test]
fn comments_are_found_the_way_the_parser_finds_them() {
    let xml = r#"<w:comments><!-- <w:comment w:id="9"/> --><w:comment w:id='1' w:x="a>b"><w:p/></w:comment><w:comment w:id = "2"/><w:comment w:id="a&amp;b"><w:p><![CDATA[</w:comment>]]></w:p></w:comment ></w:comments>"#;
    let found: Vec<_> = comment_entries(xml)
        .unwrap()
        .into_iter()
        .map(|entry| json!([entry.id, entry.xml]))
        .collect();
    assert_eq!(
        found,
        vec![
            json!(["1", r#"<w:comment w:id='1' w:x="a>b"><w:p/></w:comment>"#]),
            json!(["2", r#"<w:comment w:id = "2"/>"#]),
            json!([
                "a&b",
                r#"<w:comment w:id="a&amp;b"><w:p><![CDATA[</w:comment>]]></w:p></w:comment >"#
            ]),
        ]
    );
}

#[test]
fn an_edit_is_patched_around_the_hidden_run_only_where_it_cannot_spill() {
    let entry = r#"<w:comment w:id="1"><w:p><w:r><w:t xml:space="preserve">Call </w:t></w:r><w:r><w:rPr><go:redact w:label="phone"/></w:rPr><w:t>138</w:t></w:r><w:r><w:t xml:space="preserve"> now</w:t></w:r></w:p></w:comment>"#;
    let patch = |text: &str| patch_paragraph_texts(entry, text, false).unwrap();
    assert_eq!(patch("Call 138 now").as_deref(), Some(entry));
    assert_eq!(
        patch("Call 138 later").as_deref(),
        Some(
            r#"<w:comment w:id="1"><w:p><w:r><w:t xml:space="preserve">Call </w:t></w:r><w:r><w:rPr><go:redact w:label="phone"/></w:rPr><w:t>138</w:t></w:r><w:r><w:t xml:space="preserve"> later</w:t></w:r></w:p></w:comment>"#
        )
    );
    assert_eq!(
        patch("Call 000 now").as_deref(),
        Some(
            r#"<w:comment w:id="1"><w:p><w:r><w:t xml:space="preserve">Call </w:t></w:r><w:r><w:rPr><go:redact w:label="phone"/></w:rPr><w:t xml:space="preserve">000</w:t></w:r><w:r><w:t xml:space="preserve"> now</w:t></w:r></w:p></w:comment>"#
        )
    );
}

#[test]
fn a_note_reads_its_hidden_runs_as_placeholders() {
    let xml = r#"<w:footnotes><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> See </w:t></w:r><w:r><w:rPr><go:redact w:label="phone"/></w:rPr><w:t>138</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"/></w:footnotes>"#;
    let notes = serde_json::to_value(parse_notes_xml(xml, NoteKind::Footnote)).unwrap();
    assert_eq!(
        notes,
        json!([{"id": "1", "text": "See 138", "modelText": "See {{phone}}"}])
    );
    let runs: Vec<Vec<docx_engine::model::NoteRun>> = serde_json::from_value(json!([[
        {"text": "a"}, {"text": "1", "redact": "phone"}, {"text": "2", "redact": "phone"}, {"text": "b"}
    ]]))
    .unwrap();
    assert_eq!(note_model_text(&runs).as_deref(), Some("a{{phone}}b"));
    assert_eq!(note_model_text(&[]), None);
}

#[test]
fn a_mark_no_run_accounts_for_withholds_the_whole_entry() {
    let hidden = |text: &str| {
        format!(r#"<w:r><w:rPr><go:redact w:label="phone"/></w:rPr><w:t>{text}</w:t></w:r>"#)
    };
    let read = |xml: &str| {
        let node = parse_entry(xml).unwrap();
        (
            withheld_node(&node).map(|view| runs_text(&view)),
            withheld_text(&node, &runs_text),
        )
    };
    assert_eq!(
        read(&format!(
            "<w:p><w:r><w:t>Call </w:t></w:r>{}</w:p>",
            hidden("secret")
        )),
        (
            Some("Call {{phone}}".to_owned()),
            Some("Call {{phone}}".to_owned())
        )
    );
    assert_eq!(
        read(r#"<w:p><go:redact w:label="phone"/><w:r><w:t>secret</w:t></w:r></w:p>"#),
        (None, Some("{{private}}".to_owned()))
    );
    // markup inside CDATA is words, not an entry
    assert_eq!(
        read(&format!(
            "<w:p>{}</w:p>",
            hidden("<![CDATA[</w:p><w:p><w:r><w:t>secret</w:t></w:r></w:p>]]>")
        )),
        (Some("{{phone}}".to_owned()), Some("{{phone}}".to_owned()))
    );
    assert_eq!(
        first_mark_label(r#"<w:p><gx:redact w:label="x"/></w:p>"#),
        "x"
    );
}
