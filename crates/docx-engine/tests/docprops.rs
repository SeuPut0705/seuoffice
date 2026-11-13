//! Expected values are what the TypeScript gave for the same inputs
//! (`npx tsx` over doc-properties.ts, zotero-doc-props.ts, sources.ts and
//! protection.ts, and `hashProtectionPassword` with `crypto.getRandomValues`
//! made to return the salt below).

use docx_engine::doc_properties::parse_custom_properties_xml;
use docx_engine::doc_properties::zotero::{decode_xml_text, parse_zotero_document_data_xml};
use docx_engine::protection::{
    ProtectionRecord, SpinCount, hash_protection_password, resolve_spin_count,
    verify_protection_password,
};
use docx_engine::sources::parse_sources_xml;

#[test]
fn character_references_join_surrogate_halves_and_keep_out_of_range_ones() {
    assert_eq!(
        decode_xml_text("&#x41;&#xD83D;&#56832;&#x26;#67;&amp;lt;&#x110000;"),
        "A\u{1F600}C&lt;&#x110000;"
    );
}

#[test]
fn zotero_chunks_go_in_numeric_order_and_win_over_the_legacy_property() {
    let xml = concat!(
        r#"<property name="ZOTERO_PREF_10"><vt:lpwstr>c</vt:lpwstr></property>"#,
        r#"<property name="ZOTERO_PREF_2"><vt:lpwstr>b</vt:lpwstr></property>"#,
        r#"<property name="ZOTERO_PREF"><vt:lpwstr>legacy</vt:lpwstr></property>"#,
        r#"<property name="ZOTERO_PREF_1"><vt:lpwstr>a</vt:lpwstr></property>"#,
    );
    assert_eq!(parse_zotero_document_data_xml(xml), "abc");
}

#[test]
fn custom_properties_are_an_object_table() {
    let xml = concat!(
        r#"<property name="b"><vt:i4>1</vt:i4></property>"#,
        r#"<property name="__proto__"><vt:lpwstr>p</vt:lpwstr></property>"#,
        r#"<property name="b"><vt:lpwstr>2</vt:lpwstr></property>"#,
        r#"<property name="7"><vt:i4>5</vt:i4></vt:i8></property>"#,
    );
    let json = serde_json::to_string(&parse_custom_properties_xml(xml)).unwrap_or_default();
    assert_eq!(json, r#"{"7":"5","b":"2","__proto__":"p"}"#);
}

#[test]
fn spin_counts_resolve_like_number_and_clamp() {
    let resolve = |raw: SpinCount| resolve_spin_count(&raw).ok();
    assert_eq!(resolve(SpinCount::Text(" 12 ".into())), Some(12.0));
    assert_eq!(resolve(SpinCount::Text(String::new())), Some(100_000.0));
    assert_eq!(resolve(SpinCount::Text("0x10".into())), Some(16.0));
    assert_eq!(resolve(SpinCount::Text("1.5".into())), None);
    assert_eq!(resolve(SpinCount::Number(2e6)), Some(1_000_000.0));
}

#[test]
fn a_hash_verifies_with_its_password_only() {
    let salt: Vec<u8> = (0..16).collect();
    let Ok(made) = hash_protection_password("secret", &SpinCount::Number(2.0), &salt) else {
        panic!("a valid spin count");
    };
    assert_eq!(
        made.hash,
        "8ksaeikUOI/cDAyxYyW3GT/YUGNQl1ivK55Lzsjq/qAi/Ondvpjq2jxtgU0NR09iybGPYCtPaXSx5CHH+1T4nQ=="
    );
    assert_eq!(made.salt, "AAECAwQFBgcICQoLDA0ODw==");
    let record = ProtectionRecord {
        hash: Some(made.hash),
        salt: Some(made.salt),
        spin_count: SpinCount::Text("2".into()),
        algorithm_sid: None,
    };
    assert_eq!(verify_protection_password("secret", &record), Ok(true));
    assert_eq!(verify_protection_password("Secret", &record), Ok(false));
    let hostile = ProtectionRecord {
        spin_count: SpinCount::Text("abc".into()),
        ..record
    };
    assert!(verify_protection_password("secret", &hostile).is_err());
}

#[test]
fn a_blank_corporate_author_falls_back_to_the_person() {
    let sources = parse_sources_xml(concat!(
        "<b:Source><b:Tag> T </b:Tag><b:Corporate> </b:Corporate><b:Last>L</b:Last>",
        "<b:First>F</b:First><b:SourceType> </b:SourceType><b:JournalName>J &amp;amp;</b:JournalName></b:Source>",
        "<b:Source><b:Tag> </b:Tag></b:Source>",
    ));
    let json = serde_json::to_string(&sources).unwrap_or_default();
    assert_eq!(
        json,
        r#"[{"tag":"T","type":"","author":"L, F","title":"","year":"","publisher":"J &amp;"}]"#
    );
}
