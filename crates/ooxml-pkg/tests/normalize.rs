//! `normalize_ooxml_xml` against the answers of the TypeScript engine.
//!
//! The parts and the expected texts are in crates/fixtures/package-layer.json,
//! written by tools/docx-diff/write-fixtures.ts from `normalizeOoxmlXml`.

use ooxml_pkg::{needs_ooxml_normalization, normalize_ooxml_xml};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixtures {
    normalized: Vec<Part>,
}

#[derive(Deserialize)]
struct Part {
    xml: String,
    needed: bool,
    normalized: String,
}

fn parts() -> Vec<Part> {
    let fixtures: Fixtures = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/package-layer.json"
    )))
    .expect("the fixtures are JSON");
    assert!(
        fixtures.normalized.len() >= 30,
        "the fixtures hold the parts"
    );
    fixtures.normalized
}

#[test]
fn every_part_is_rewritten_as_the_typescript_rewrites_it() {
    for part in parts() {
        assert_eq!(
            normalize_ooxml_xml(&part.xml),
            part.normalized,
            "normalizeOoxmlXml({:?})",
            part.xml
        );
    }
}

#[test]
fn the_cheap_check_says_which_parts_need_it() {
    for part in parts() {
        assert_eq!(
            needs_ooxml_normalization(&part.xml),
            part.needed,
            "needsOoxmlNormalization({:?})",
            part.xml
        );
    }
}

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STRICT_W: &str = "http://purl.oclc.org/ooxml/wordprocessingml/main";

#[test]
fn a_strict_namespace_and_a_prefix_of_its_own_become_the_ones_the_engine_matches() {
    let strict =
        format!(r#"<x:p xmlns:x="{STRICT_W}"><x:ind x:left="1in" x:hanging="36pt"/></x:p>"#);
    assert_eq!(
        normalize_ooxml_xml(&strict),
        format!(r#"<w:p xmlns:w="{W}"><w:ind w:left="1440" w:hanging="720"/></w:p>"#)
    );
}

#[test]
fn a_transitional_part_with_canonical_prefixes_needs_nothing() {
    let part = format!(r#"<w:p xmlns:w="{W}"><w:r/></w:p>"#);
    assert!(!needs_ooxml_normalization(&part));
    assert!(needs_ooxml_normalization(
        &part.replace("xmlns:w", "xmlns:x")
    ));
}
