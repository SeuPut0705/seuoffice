//! The package-level readers. Expected values are answers of the TypeScript
//! engine: the table of relationship targets comes from
//! crates/fixtures/package-layer.json (tools/docx-diff/write-fixtures.ts), and
//! the whole of each reader is compared over the corpus by tools/docx-diff.

use docx_engine::font_table::{deobfuscate_odttf, is_sfnt, parse_font_table, sfnt_line_metrics};
use docx_engine::numbering::parse_numbering;
use docx_engine::package::{
    content_types_of, parse_rels, rels_path_of, resolve_main_document_path,
    resolve_relationship_target_path,
};
use docx_engine::settings::{parse_protection, parse_remove_personal_info};
use docx_engine::theme::{ThemeColors, parse_theme};
use ooxml_pkg::Package;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Fixtures {
    targets: Vec<Target>,
}

#[derive(Deserialize)]
struct Target {
    source: String,
    target: String,
    resolved: Option<String>,
}

#[test]
fn relationship_targets_resolve_as_in_typescript() {
    let fixtures: Fixtures = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/package-layer.json"
    )))
    .expect("the fixtures are JSON");
    assert!(fixtures.targets.len() >= 100, "the fixtures hold the table");
    for case in fixtures.targets {
        assert_eq!(
            resolve_relationship_target_path(&case.source, &case.target),
            case.resolved,
            "resolveRelationshipTargetPath({:?}, {:?})",
            case.source,
            case.target
        );
    }
}

const RELS_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_DOCUMENT: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

fn rels(relationships: &str) -> String {
    format!(r#"<Relationships xmlns="{RELS_NS}">{relationships}</Relationships>"#)
}

#[test]
fn the_relationships_of_a_part_sit_in_the_rels_folder_beside_it() {
    assert_eq!(
        rels_path_of("word/document.xml"),
        "word/_rels/document.xml.rels"
    );
    assert_eq!(rels_path_of("top.xml"), "_rels/top.xml.rels");
    assert_eq!(rels_path_of("folder/"), "folder/");
}

#[test]
fn relationships_keep_document_order_and_an_id_set_again_keeps_its_place() {
    let package = Package::from_parts([(
        "_rels/.rels",
        rels(concat!(
            r#"<Relationship Id="a" Type="t1" Target="x.xml"/>"#,
            r#"<Relationship Id="b" Target="http://e.com" TargetMode="External"/>"#,
            r#"<Relationship Target="no id"/><Relationship Id="" Target="empty id"/>"#,
            r#"<Relationship Id="a" Type="t2"/>"#,
        )),
    )]);
    let parsed = parse_rels(&package, "_rels/.rels").unwrap();
    assert_eq!(
        serde_json::to_value(&parsed).unwrap(),
        json!([
            ["a", {"target": "", "type": "t2"}],
            ["b", {"target": "http://e.com", "type": "", "targetMode": "External"}],
        ])
    );
    assert!(parse_rels(&package, "missing.rels").unwrap().is_empty());
}

#[test]
fn a_doctype_before_the_relationships_is_dropped_and_broken_xml_is_an_error() {
    let with_doctype = format!(
        r#"<!DOCTYPE Relationships [<!ENTITY x SYSTEM "file:///etc/passwd">]>{}"#,
        rels(r#"<Relationship Id="a" Target="x.xml"/>"#)
    );
    let package = Package::from_parts([
        ("a.rels", with_doctype),
        ("b.rels", "<Relationships><!--".to_owned()),
    ]);
    assert_eq!(parse_rels(&package, "a.rels").unwrap().len(), 1);
    assert!(parse_rels(&package, "b.rels").is_err());
}

#[test]
fn the_main_part_is_word_document_xml_or_what_the_package_relationship_names() {
    let default_name = Package::from_parts([("word/document.xml", "<w:document/>")]);
    assert_eq!(
        resolve_main_document_path(&default_name),
        Ok(Some("word/document.xml".to_owned()))
    );

    let other_name = Package::from_parts([
        (
            "_rels/.rels",
            rels(&format!(
                concat!(
                    r#"<Relationship Id="r0" Type="{t}" Target="http://e.com/x" TargetMode="External"/>"#,
                    r#"<Relationship Id="r1" Type="{t}" Target="missing.xml"/>"#,
                    r#"<Relationship Id="r2" Type="{t}" Target="/word/trial%20run.xml#frag"/>"#,
                ),
                t = OFFICE_DOCUMENT
            )),
        ),
        ("word/trial run.xml", "<w:document/>".to_owned()),
    ]);
    assert_eq!(
        resolve_main_document_path(&other_name),
        Ok(Some("word/trial run.xml".to_owned()))
    );

    let none = Package::from_parts([("word/styles.xml", "<w:styles/>")]);
    assert_eq!(resolve_main_document_path(&none), Ok(None));
}

#[test]
fn content_types_lower_case_the_extension_and_skip_incomplete_entries() {
    let package = Package::from_parts([(
        "[Content_Types].xml",
        concat!(
            r#"<Types><Default Extension="RELS" ContentType="a/rels"/>"#,
            r#"<Default Extension="xml" ContentType="a/xml"/><Default Extension="xml" ContentType="a/second"/>"#,
            r#"<Default ContentType="a/none"/><Default Extension="" ContentType="x/y"/>"#,
            r#"<Override PartName="/word/document.xml" ContentType="a/main"/><Override PartName="/a"/></Types>"#,
        ),
    )]);
    assert_eq!(
        serde_json::to_value(content_types_of(&package).unwrap()).unwrap(),
        json!({
            "defaults": [["rels", "a/rels"], ["xml", "a/second"]],
            "overrides": [["/word/document.xml", "a/main"]],
        })
    );
}

#[test]
fn a_package_without_a_theme_part_resolves_against_the_office_palette() {
    let theme = parse_theme(&Package::from_parts([(
        "word/document.xml",
        "<w:document/>",
    )]))
    .unwrap();
    assert_eq!(theme.fonts, None);
    assert_eq!(theme.colors, Some(ThemeColors::office()));
}

#[test]
fn theme_fonts_take_the_language_of_the_settings_part() {
    let package = Package::from_parts([
        (
            "word/theme/theme1.xml",
            concat!(
                r#"<a:theme><a:themeElements><a:clrScheme name="Mine"><a:dk1><a:sysClr val="windowText" lastClr="0a0b0c"/></a:dk1>"#,
                r#"<a:accent1><a:srgbClr val="4472c4"/></a:accent1><a:accent2><a:srgbClr val="xyz"/></a:accent2></a:clrScheme>"#,
                r#"<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Major"/><a:ea typeface=""/><a:cs typeface="Cs"/>"#,
                r#"<a:font script="Hang" typeface="Malgun Gothic"/><a:font script="__proto__" typeface="x"/></a:majorFont>"#,
                r#"<a:minorFont><a:latin typeface=""/><a:ea typeface="Ea"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>"#,
            ),
        ),
        (
            "word/settings.xml",
            r#"<w:settings><w:themeFontLang w:val="en-US" w:eastAsia="ko-KR" w:bidi=""/></w:settings>"#,
        ),
    ]);
    assert_eq!(
        serde_json::to_value(parse_theme(&package).unwrap()).unwrap(),
        json!({
            "fonts": {
                "major": "Major", "minor": "", "eastAsia": "Ea", "majorCs": "Cs",
                "eaLang": "ko-KR", "majorScripts": {"Hang": "Malgun Gothic", "__proto__": "x"},
            },
            "colors": {"name": "Mine", "dk1": "0A0B0C", "accent1": "4472C4"},
        })
    );
}

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

#[test]
fn a_numbering_definition_carries_the_levels_of_its_abstract_with_overrides() {
    let package = Package::from_parts([(
        "word/numbering.xml",
        format!(
            concat!(
                r#"<w:numbering xmlns:w="{w}">"#,
                r#"<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#61623;"/>"#,
                r#"<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol"/><w:color w:val="ff0000"/></w:rPr></w:lvl>"#,
                r#"<w:lvl w:ilvl="1"><w:start w:val="3"/><w:lvlText w:val="%2."/><w:lvlJc w:val="end"/><w:pPr><w:ind w:hanging="0" w:firstLine="200"/></w:pPr></w:lvl>"#,
                r#"<w:lvl w:ilvl="x"/></w:abstractNum>"#,
                r#"<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>"#,
                r#"<w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/>"#,
                r#"<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:lvlOverride></w:num>"#,
                r#"<w:num w:numId="3"/></w:numbering>"#,
            ),
            w = W
        ),
    )]);
    assert_eq!(
        serde_json::to_value(parse_numbering(&package).unwrap()).unwrap(),
        json!({
            "formats": [["1", "bullet"], ["2", "ordered"]],
            "defs": [
                ["1", {
                    "numId": "1", "abstractNumId": "0", "startOverrides": {},
                    "levels": {
                        "0": {
                            "numFmt": "bullet", "lvlText": "\u{f0b7}", "start": 0,
                            "indentLeft": 720, "hanging": 360, "color": "FF0000", "font": "Symbol",
                        },
                        "1": {
                            "numFmt": "decimal", "lvlText": "%2.", "start": 3, "lvlJc": "right",
                            "indentLeft": 0, "firstLine": 200,
                        },
                    },
                }],
                ["2", {
                    "numId": "2", "abstractNumId": "0", "startOverrides": {"0": 5},
                    "levels": {
                        "0": {"numFmt": "decimal", "lvlText": "", "start": 0},
                        "1": {
                            "numFmt": "decimal", "lvlText": "%2.", "start": 3, "lvlJc": "right",
                            "indentLeft": 0, "firstLine": 200,
                        },
                    },
                }],
            ],
            "picBullets": [],
        })
    );
}

#[test]
fn the_font_table_keeps_hints_and_embed_slots() {
    // the Korean name of Malgun Gothic
    let alt_name = "\u{b9d1}\u{c740} \u{ace0}\u{b515}";
    let table = parse_font_table(&format!(
        concat!(
            r#"<w:fonts xmlns:w="{w}"><w:font w:name="Malgun Gothic"><w:altName w:val="{alt_name}"/><w:panose1 w:val="020B0503020000020004"/>"#,
            r#"<w:charset w:val="81"/><w:family w:val=""/><w:sig w:csb0="00080000"/>"#,
            r#"<w:embedBold r:id="rId2" w:fontKey="{{A}}"/><w:embedItalic w:fontKey="no id"/></w:font>"#,
            r#"<w:font/><w:other w:name="x"/></w:fonts>"#,
        ),
        w = W,
        alt_name = alt_name
    ));
    assert_eq!(
        serde_json::to_value(&table).unwrap(),
        json!([{
            "name": "Malgun Gothic", "altName": alt_name, "panose": "020B0503020000020004",
            "charset": "81", "csb0": "00080000",
            "embedded": {"bold": {"rId": "rId2", "fontKey": "{A}"}},
        }])
    );
    assert!(parse_font_table("<w:fonts><!--").is_empty());
}

#[test]
fn an_embedded_font_is_unmasked_with_its_key_read_backwards() {
    let key = "{00112233-4455-6677-8899-AABBCCDDEEFF}";
    let mut masked: Vec<u8> = vec![0; 40];
    masked[..4].copy_from_slice(&[0x00, 0x01, 0x00, 0x00]);
    let key_bytes: Vec<u8> = (0..16u8).map(|index| index * 0x11).collect();
    for (index, byte) in masked.iter_mut().take(32).enumerate() {
        *byte ^= key_bytes[15 - index % 16];
    }
    assert!(!is_sfnt(&masked));
    let clear = deobfuscate_odttf(&masked, Some(key)).expect("the key applies");
    assert!(is_sfnt(&clear));
    assert_eq!(&clear[4..], &[0u8; 36][..]);
    // nothing to undo: no key, a zero key, a part that is a font already
    assert_eq!(deobfuscate_odttf(&masked, None), None);
    assert_eq!(deobfuscate_odttf(&masked, Some(&"0".repeat(32))), None);
    assert_eq!(deobfuscate_odttf(&clear, Some(key)), None);
    assert_eq!(sfnt_line_metrics(&clear), None);
}

#[test]
fn protection_is_read_from_the_raw_settings_tag() {
    let settings = |tag: &str| {
        Package::from_parts([(
            "word/settings.xml",
            format!(r#"<w:settings xmlns:w="{W}">{tag}</w:settings>"#),
        )])
    };
    assert_eq!(
        serde_json::to_value(
            parse_protection(&settings(
                r#"<w:documentProtection w:edit='readOnly' w:enforcement="on" w:cryptSpinCount="100000" w:hash="h"/>"#
            ))
            .unwrap()
        )
        .unwrap(),
        json!({"edit": "readOnly", "enforced": true, "hash": "h", "spinCount": 100000})
    );
    assert_eq!(
        parse_protection(&settings(r#"<w:documentProtection w:edit="none"/>"#)),
        Ok(None)
    );
    assert_eq!(
        parse_remove_personal_info(&settings("<w:removePersonalInformation/>")),
        Ok(true)
    );
    assert_eq!(
        parse_remove_personal_info(&settings(r#"<w:removePersonalInformation w:val="FALSE"/>"#)),
        Ok(false)
    );
}
