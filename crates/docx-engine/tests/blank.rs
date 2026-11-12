//! What blank.ts answers. Every expected value is the answer of the
//! TypeScript engine (packages/docx-engine/src/blank.ts) under Node 22.22.3
//! for the same arguments; `tools/docx-diff` compares the two over built and
//! mutated inputs (`calls-blank.ts`).

use docx_engine::blank::{
    BlankDocxOptions, BlankPaperSize, CustomNumberingLevel, LvlJc, blank_docx_package,
    build_blank_docx, custom_level_xml, merge_level_xml, paper_size_for_locale,
};
use jscompat::JsNum;
use ooxml_pkg::read_entries;

fn level(num_fmt: &str, lvl_text: &str, indent_left: f64) -> CustomNumberingLevel {
    CustomNumberingLevel {
        num_fmt: num_fmt.to_owned(),
        lvl_text: lvl_text.to_owned(),
        indent_left: JsNum(indent_left),
        ..CustomNumberingLevel::default()
    }
}

#[test]
fn a_level_rounds_like_math_round_and_prints_numbers_like_string() {
    let l = CustomNumberingLevel {
        custom_format: Some("a\"b".to_owned()),
        hanging: Some(JsNum(-2.5)),
        tab_stop: Some(JsNum(-0.5)),
        sz_half_points: Some(JsNum(21.5)),
        font: Some(String::new()),
        p_style: Some(String::new()),
        suff: Some("tab".to_owned()),
        ..level("custom", "<%1>", 1e21)
    };
    assert_eq!(
        custom_level_xml(&l, 2.5),
        "<w:lvl w:ilvl=\"2.5\"><w:start w:val=\"1\"/><mc:AlternateContent xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\"><mc:Choice Requires=\"w14\"><w:numFmt w:val=\"custom\" w:format=\"a&quot;b\"/></mc:Choice><mc:Fallback><w:numFmt w:val=\"decimal\"/></mc:Fallback></mc:AlternateContent><w:lvlText w:val=\"&lt;%1&gt;\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:tabs><w:tab w:val=\"num\" w:pos=\"0\"/></w:tabs><w:ind w:left=\"1e+21\" w:hanging=\"-2\"/></w:pPr><w:rPr><w:sz w:val=\"21.5\"/><w:szCs w:val=\"21.5\"/></w:rPr></w:lvl>"
    );
}

#[test]
fn a_merge_keeps_unknown_children_in_schema_order() {
    let l = CustomNumberingLevel {
        p_style: Some(String::new()),
        bold: Some(false),
        sz_half_points: Some(JsNum(0.0)),
        suff: Some("space".to_owned()),
        font: Some("Symbol".to_owned()),
        ..level("decimal", "%2.", 1440.0)
    };
    let existing = "<w:lvl w:ilvl=\"1\" w15:tentative=\"1\"><w:pStyle w:val=\"H\"/><w:lvlText w:val=\"x\"/><w:legacy w:legacy=\"1\"/><w:pPr><w:keepNext/><w:x/><w:jc w:val=\"left\"/></w:pPr><w:rPr><w14:shadow/><w:b/><w:sz w:val=\"8\"/></w:rPr></w:lvl>";
    assert_eq!(
        merge_level_xml(existing, &l, 1.0),
        "<w:lvl w:ilvl=\"1\" w15:tentative=\"1\"><w:start w:val=\"1\"/><w:numFmt w:val=\"decimal\"/><w:suff w:val=\"space\"/><w:lvlText w:val=\"%2.\"/><w:legacy w:legacy=\"1\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:keepNext/><w:ind w:left=\"1440\" w:hanging=\"360\"/><w:jc w:val=\"left\"/><w:x/></w:pPr><w:rPr><w:rFonts w:ascii=\"Symbol\" w:hAnsi=\"Symbol\" w:eastAsia=\"Symbol\" w:cs=\"Symbol\" w:hint=\"default\"/><w14:shadow/></w:rPr></w:lvl>"
    );
    // an rPr left empty goes
    let l = CustomNumberingLevel {
        bold: Some(false),
        lvl_jc: Some(LvlJc::Left),
        ..level("bullet", "o", 0.0)
    };
    assert_eq!(
        merge_level_xml("<w:lvl w:ilvl=\"0\"><w:rPr><w:b/></w:rPr></w:lvl>", &l, 0.0),
        "<w:lvl w:ilvl=\"0\"><w:start w:val=\"1\"/><w:numFmt w:val=\"bullet\"/><w:lvlText w:val=\"o\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"0\" w:hanging=\"360\"/></w:pPr></w:lvl>"
    );
}

#[test]
fn the_paper_size_of_a_locale_follows_intl_locale() {
    let cases = [
        ("en", BlankPaperSize::Letter),
        ("en_CA", BlankPaperSize::Letter),
        ("my-BU", BlankPaperSize::Letter),
        ("und-Cher", BlankPaperSize::Letter),
        // an unknown region is filled in unless the script is given
        ("en-ZZ", BlankPaperSize::Letter),
        ("en-Latn-ZZ", BlankPaperSize::A4),
        // a1 is no key, until a key repeats
        ("en-u-ca-a1", BlankPaperSize::A4),
        ("en-u-ca-ca-a1", BlankPaperSize::Letter),
        ("en-t-en-posix", BlankPaperSize::A4),
        ("en-t-en-fonipa-posix", BlankPaperSize::Letter),
        ("en-aaland", BlankPaperSize::A4),
        ("en-US-aaland", BlankPaperSize::Letter),
        ("sgn-US-aaland", BlankPaperSize::A4),
        ("sgn-840-aaland", BlankPaperSize::Letter),
        ("zh-guoyu-guoyu", BlankPaperSize::A4),
        ("", BlankPaperSize::A4),
    ];
    for (locale, paper) in cases {
        assert_eq!(paper_size_for_locale(Some(locale)), paper, "{locale}");
    }
}

#[test]
fn a_blank_document_lists_the_folders_jszip_adds() {
    let options = BlankDocxOptions {
        created_at: Some(253_402_300_800_000.0),
        ..BlankDocxOptions::default()
    };
    let bytes = build_blank_docx(&options, 1_700_000_001_999.0).expect("a valid date");
    let names: Vec<String> = read_entries(&bytes)
        .expect("a zip")
        .into_iter()
        .map(|entry| String::from_utf8_lossy(&entry.raw_name).into_owned())
        .collect();
    assert_eq!(
        names,
        [
            "[Content_Types].xml",
            "_rels/",
            "_rels/.rels",
            "word/",
            "word/_rels/",
            "word/_rels/document.xml.rels",
            "word/styles.xml",
            "word/numbering.xml",
            "docProps/",
            "docProps/core.xml",
            "docProps/app.xml",
            "word/document.xml",
        ]
    );
    let package = blank_docx_package(&options, 0.0).expect("a valid date");
    let core = package.text("docProps/core.xml").expect("readable");
    assert!(core.is_some_and(|core| core.contains(
        "<dcterms:created xsi:type=\"dcterms:W3CDTF\">+010000-01-01T00:00:00Z</dcterms:created>"
    )));
}

#[test]
fn an_invalid_creation_date_throws() {
    let options = BlankDocxOptions {
        created_at: Some(f64::NAN),
        ..BlankDocxOptions::default()
    };
    assert!(build_blank_docx(&options, 0.0).is_err());
    // the clock is only the default
    assert!(build_blank_docx(&BlankDocxOptions::default(), f64::NAN).is_err());
}

#[test]
fn a_new_document_has_revision_zero_and_can_leave_out_the_generator_fields() {
    let options = BlankDocxOptions {
        omit_generator_fields: true,
        ..BlankDocxOptions::default()
    };
    let package = blank_docx_package(&options, 0.0).expect("a valid date");
    let core = package.text("docProps/core.xml").expect("readable");
    assert!(core.is_some_and(|core| core.contains("<cp:revision>0</cp:revision>")));
    let app = package.text("docProps/app.xml").expect("readable");
    assert_eq!(
        app,
        Some(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
             <Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" \
             xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\">\
             <Template>Normal.dotm</Template></Properties>"
        )
    );
}
