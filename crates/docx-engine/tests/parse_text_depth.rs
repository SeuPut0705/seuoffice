//! The read side of text and tables on hostile input: nesting a document
//! drives arbitrarily deep must not recurse without a bound, and work that
//! grows with the input must not grow faster than it. Each test builds its
//! document in a loop and parses it whole.

use std::rc::Rc;

use docx_engine::model::RunZoteroFieldPart;
use docx_engine::parse::drawings::host::{MediaEnv, NoHost};
use docx_engine::parse::parse_docx_full;
use docx_engine::parse::tables::extract::extract_table;
use docx_engine::parse::tables::hf_fields::{parse_field_tree, render_field};
use docx_engine::parse::text::{BuildContext, cell_resolver_of, cross_paragraph_zotero_fields};
use docx_engine::resolve::{ResolveCtx, ResolveDoc, resolve_ctx_of};
use docx_engine::scan::BodyElement;
use docx_engine::styles::StyleInfo;
use jscompat::JsMap;
use ooxml_pkg::Package;
use serde_json::Value;

const W: &str = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" \
                 xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"";

fn docx(parts: &[(&str, &str)]) -> Vec<u8> {
    let package = Package::from_parts(parts.iter().map(|(name, text)| (*name, text.as_bytes())));
    ooxml_pkg::write::generate(&package, 0.0).expect("a package of in-memory files")
}

fn document(body: &str) -> String {
    format!("<w:document {W}><w:body>{body}</w:body></w:document>")
}

fn parse(parts: &[(&str, &str)]) -> Result<Value, String> {
    let full = parse_docx_full(&docx(parts), &NoHost)?;
    Ok(serde_json::to_value(&full).expect("the model is JSON"))
}

fn blocks(doc: &Value) -> &Vec<Value> {
    doc["blocks"].as_array().expect("blocks")
}

fn table_with_cell_paragraph(inner: &str) -> String {
    format!(
        "<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w=\"3000\"/></w:tblGrid>\
         <w:tr><w:tc><w:p>{inner}</w:p></w:tc></w:tr></w:tbl>"
    )
}

#[test]
fn a_table_nested_within_the_bound_keeps_its_model() {
    // an unoptimized frame of the run walk is large: a test thread's stack
    // holds a few dozen levels, a release build far more
    let mut inner = String::new();
    for _ in 0..20 {
        inner.push_str("<w:ins w:id=\"1\" w:author=\"a\">");
    }
    inner.push_str("<w:r><w:t>deep</w:t></w:r>");
    for _ in 0..20 {
        inner.push_str("</w:ins>");
    }
    let doc = parse(&[(
        "word/document.xml",
        &document(&table_with_cell_paragraph(&inner)),
    )])
    .expect("parses");
    assert!(
        blocks(&doc)[0]["table"].is_object(),
        "{:?}",
        blocks(&doc)[0]
    );
}

fn bare_context<'a>(package: &'a Package, media: &'a MediaEnv<'a>) -> BuildContext<'a> {
    BuildContext::bare(package, Rc::new(ResolveCtx::default()), media)
}

#[test]
fn tables_nested_far_deeper_than_the_flattening_depth_keep_their_model() {
    // the structure of tables does not count toward the content bound
    let depth = 300;
    let grid = "<w:tblPr/><w:tblGrid><w:gridCol w:w=\"3000\"/></w:tblGrid>";
    let xml = format!(
        "<w:tbl {W}>{grid}{}<w:p/>{}</w:tbl>",
        format!("<w:tr><w:tc><w:tbl>{grid}").repeat(depth),
        "</w:tbl></w:tc></w:tr>".repeat(depth),
    );
    let package = Package::default();
    let media = MediaEnv::new(&NoHost);
    let table = extract_table(&xml, &bare_context(&package, &media), None);
    assert!(matches!(table, Ok(Some(_))), "{table:?}");
}

#[test]
fn a_cell_paragraph_nested_past_the_bound_is_a_protected_table() {
    // far past the bound, yet inside the 100 000 levels the table parser takes
    let depth = 50_000;
    let xml = table_with_cell_paragraph(&format!(
        "{}<w:r><w:t>deep</w:t></w:r>{}",
        "<w:ins>".repeat(depth),
        "</w:ins>".repeat(depth)
    ));
    let package = Package::default();
    let media = MediaEnv::new(&NoHost);
    let table = extract_table(&xml, &bare_context(&package, &media), None);
    assert_eq!(table, Ok(None));
}

fn header_with_nested_fields(depth: usize) -> String {
    let mut xml = format!("<w:hdr {W}><w:p>");
    for _ in 0..depth {
        xml.push_str(
            "<w:r><w:rPr></w:rPr><w:fldChar w:fldCharType=\"begin\"/>\
             <w:fldChar w:fldCharType=\"separate\"/><w:t>r</w:t></w:r>",
        );
    }
    xml.push_str("<w:r><w:t>cached</w:t></w:r>");
    for _ in 0..depth {
        xml.push_str("<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>");
    }
    xml.push_str("</w:p></w:hdr>");
    xml
}

/// A header part read end to end, on a thread with room for the unoptimized
/// frames of the field render.
fn with_header(header: &str) -> Result<Value, String> {
    let header = header.to_owned();
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || parse_with_header(&header))
        .expect("a thread")
        .join()
        .expect("the parse does not crash")
}

fn parse_with_header(header: &str) -> Result<Value, String> {
    let body = "<w:p><w:r><w:t>body</w:t></w:r></w:p>\
         <w:sectPr><w:headerReference w:type=\"default\" r:id=\"rId1\"/></w:sectPr>";
    parse(&[
        ("word/document.xml", &document(body)),
        (
            "word/_rels/document.xml.rels",
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
             <Relationship Id=\"rId1\" \
             Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/header\" \
             Target=\"header1.xml\"/></Relationships>",
        ),
        ("word/header1.xml", header),
    ])
}

#[test]
fn nested_header_fields_within_the_bound_render() {
    let doc = with_header(&header_with_nested_fields(20)).expect("parses");
    assert!(
        doc["headerText"]
            .as_str()
            .is_some_and(|text| text.contains("cached")),
        "{:?}",
        doc["headerText"]
    );
}

#[test]
fn nested_header_fields_past_the_bound_are_the_engine_error() {
    let xml = header_with_nested_fields(600);
    let error = std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            let tree = parse_field_tree(&xml);
            let root = &tree.frames[tree.roots[0]];
            render_field(&xml, root, &tree, &mut false, 0)
        })
        .expect("a thread")
        .join()
        .expect("the render does not crash")
        .expect_err("past the bound");
    assert!(
        error.contains("Maximum call stack size exceeded"),
        "{error}"
    );
}

#[test]
fn a_field_whose_instruction_is_only_a_byte_order_mark_is_empty() {
    // JavaScript `trim` removes U+FEFF; Rust `str::trim` does not
    let runs = "<w:r><w:fldChar w:fldCharType=\"begin\"/></w:r>\
        <w:r><w:instrText>\u{feff}</w:instrText></w:r>\
        <w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>\
        <w:r><w:t>kept</w:t></w:r>\
        <w:r><w:fldChar w:fldCharType=\"end\"/></w:r>";
    let doc = parse(&[(
        "word/document.xml",
        &document(&format!("<w:p>{runs}</w:p>")),
    )])
    .expect("parses");
    let run = &blocks(&doc)[0]["runs"][0];
    assert_eq!(run["text"], "kept", "{run:?}");
    assert_eq!(run["instrField"], "", "{run:?}");
}

#[test]
fn each_cell_shares_the_style_and_numbering_definitions() {
    let mut styles = JsMap::new();
    for index in 0..2_000 {
        let style: StyleInfo = serde_json::from_value(serde_json::json!({
            "styleId": format!("S{index}"),
            "name": format!("S{index}"),
            "type": "paragraph",
        }))
        .expect("a style");
        styles.set(format!("S{index}"), style);
    }
    let resolver = Rc::new(resolve_ctx_of(ResolveDoc {
        styles,
        ..ResolveDoc::default()
    }));
    let package = Package::default();
    let media = MediaEnv::new(&NoHost);
    let ctx = BuildContext::bare(&package, Rc::clone(&resolver), &media);
    // cells x definitions: a copy of the 2 000 styles for each of 20 000 cells
    for _ in 0..20_000 {
        let scoped = cell_resolver_of(&ctx, Some("Grid"), &[]);
        assert!(Rc::ptr_eq(&scoped.styles, &resolver.styles));
        assert!(Rc::ptr_eq(&scoped.numbering, &resolver.numbering));
        assert!(scoped.table.is_some());
    }
}

#[test]
fn a_zotero_field_across_many_paragraphs_is_indexed_not_scanned() {
    let count = 20_000;
    let mut xml = String::from(
        "<w:p><w:r><w:fldChar w:fldCharType=\"begin\"/></w:r>\
         <w:r><w:instrText> ADDIN ZOTERO_ITEM CSL_CITATION {} </w:instrText></w:r>\
         <w:r><w:fldChar w:fldCharType=\"separate\"/></w:r></w:p>",
    );
    for _ in 0..count {
        xml.push_str("<w:p></w:p>");
    }
    xml.push_str("<w:p><w:r><w:fldChar w:fldCharType=\"end\"/></w:r></w:p>");
    let mut elements = Vec::new();
    let mut at = 0;
    while let Some(found) = xml[at..].find("</w:p>") {
        let end = at + found + "</w:p>".len();
        elements.push(BodyElement {
            name: "w:p",
            start: at,
            end,
        });
        at = end;
    }
    assert_eq!(elements.len(), count + 2);

    let fields = cross_paragraph_zotero_fields(&elements, &xml);
    assert_eq!(fields.len(), count + 2);
    for (index, element) in elements.iter().enumerate() {
        let field = fields.get(element.start).expect("every paragraph is in it");
        let part = match index {
            0 => RunZoteroFieldPart::Begin,
            last if last == count + 1 => RunZoteroFieldPart::End,
            _ => RunZoteroFieldPart::Inside,
        };
        assert_eq!(field.part, part, "paragraph {index}");
        assert_eq!(field.id, 1);
    }
    assert!(fields.get(1).is_none());
}
