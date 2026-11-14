//! Written from what `packages/epub-engine` answers (tools/epub-diff/gen-pure-tests.ts (npx tsx gen-pure-tests.ts) ran the TypeScript over the chapters below).
//! The parse of a chapter is the host's step; `pure_parse.json` holds what `parseXmlPositions` answered for each source.
#![cfg(feature = "pure")]

use std::collections::HashMap;

use epub_engine::blocks::{ChapterMap, OpenChapter, find_block, open_chapter, remap_chapter};
use epub_engine::edits::{
    BlockEdit, EditFailure, EditsResult, MarkKind, Neighbour, apply_block_edit, apply_block_edits,
};
use epub_engine::marks::toggle_mark_in_tree;
use epub_engine::notation::{
    MarkName, MarkSource, NotationContext, NotationError, NotationNode, NotationOptions,
    PlaceholderSource, block_notation, block_plain_text, check_notation, escape_notation_text,
    new_block_notation_to_xhtml, notation_to_xhtml, serialize_notation,
};
use epub_engine::pdf_structure::{
    InlineRun, TranslationMode, default_target_language, easy_style_lines,
    guess_language_from_text, normalize_lang, sha256_hex, sha256_hex_text, translation_language_of,
    translation_style_lines,
};
use epub_engine::ranges::RangeReplacement;
use epub_engine::translate::keys::{
    epub_chapter_fingerprint, epub_metadata_fingerprint, epub_translation_keys,
};
use epub_engine::translate::language::{default_epub_target_language, epub_book_language};
use epub_engine::translate::output_markup::{
    StartTag, element_text_replacement, insertion_after, read_start_tag, remove_ids,
    write_start_tag,
};
use epub_engine::translate::prompt::{
    EpubTranslationRequestBlock, build_epub_translation_request, epub_translation_system_prompt,
};
use epub_engine::translate::units::{
    EpubMetadataLabels, EpubUnitSource, chapter_translation_units, metadata_translation_units,
};
use epub_engine::utf16::units;
use epub_engine::xml_positions_types::{
    Thrown, XmlDocument, XmlHost, XmlNode, XmlParseResult, XmlText, parse_result_from_wire,
    text_raw_offset,
};
use serde_json::Value;

struct HostParses(HashMap<String, Value>);

static PARSES: std::sync::LazyLock<HostParses> = std::sync::LazyLock::new(|| {
    HostParses(serde_json::from_str(include_str!("pure_parse.json")).expect("the parses are JSON"))
});

struct HostFixture;
use HostFixture as Fixture;

impl XmlHost for HostFixture {
    fn parse_xml(&self, source: &[u16]) -> Result<XmlParseResult, Thrown> {
        let key = String::from_utf16(source).expect("a fixture source has no lone surrogate");
        let wire = PARSES
            .0
            .get(&key)
            .unwrap_or_else(|| panic!("no parse recorded for {key:?}"));
        Ok(parse_result_from_wire(source.to_vec(), wire).expect("a recorded parse is well formed"))
    }

    fn resolve_html_entity(&self, name: &str) -> Result<Option<String>, Thrown> {
        Ok(match name {
            "nbsp" => Some("\u{a0}".to_owned()),
            "eacute" => Some("\u{e9}".to_owned()),
            _ => None,
        })
    }
}

fn u(text: &str) -> Vec<u16> {
    units(text)
}

fn text(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn open(source: &str) -> OpenChapter {
    match open_chapter(&Fixture, &u(source)).unwrap() {
        ChapterMap::Open(map) => map,
        ChapterMap::Broken(broken) => panic!("broken: {}", broken.error),
    }
}

fn ctx(
    placeholders: &[(usize, &str, bool, &str, &str, &str)],
    bold: &[(&str, &str)],
    italic: &[(&str, &str)],
    breaks: &[&str],
) -> NotationContext {
    let mark = |&(s, e): &(&str, &str)| MarkSource {
        start_tag: u(s),
        end_tag: u(e),
    };
    NotationContext {
        placeholders: placeholders
            .iter()
            .map(|&(n, tag, empty, s, e, o)| PlaceholderSource {
                n: n as f64,
                tag: tag.to_owned(),
                empty,
                start_tag: u(s),
                end_tag: u(e),
                outer: u(o),
            })
            .collect(),
        bold: bold.iter().map(mark).collect(),
        italic: italic.iter().map(mark).collect(),
        breaks: breaks.iter().map(|b| u(b)).collect(),
    }
}

fn err_text<T>(result: Result<T, NotationError>) -> String {
    match result {
        Err(NotationError::Invalid(message)) => text(&message),
        Err(NotationError::Thrown(thrown)) => panic!("threw {thrown:?}"),
        Ok(_) => panic!("accepted"),
    }
}

fn xhtml(result: Result<Vec<u16>, NotationError>) -> String {
    match result {
        Ok(xhtml) => text(&xhtml),
        Err(error) => panic!("refused {error:?}"),
    }
}

fn refusal<T>(result: Result<T, EditFailure>) -> String {
    match result {
        Err(EditFailure::Refused(r)) => format!("{}: {}", r.code.as_str(), text(&r.message)),
        _ => panic!("not refused"),
    }
}

fn reps(replacements: &[RangeReplacement]) -> Vec<String> {
    replacements.iter().map(|r| rep(r.clone())).collect()
}

fn reps_in(list: &[(usize, usize, &str)]) -> Vec<RangeReplacement> {
    list.iter()
        .map(|&(s, e, t)| RangeReplacement {
            start: s as f64,
            end: e as f64,
            text: u(t),
        })
        .collect()
}

fn rep(r: RangeReplacement) -> String {
    format!("{}..{} {}", r.start, r.end, text(&r.text))
}

fn t(v: &str) -> NotationNode {
    NotationNode::Text(u(v))
}

fn mark(t: MarkName, orig: Option<usize>, c: Vec<NotationNode>) -> NotationNode {
    NotationNode::Mark { t, orig, c }
}

fn br(orig: Option<usize>) -> NotationNode {
    NotationNode::Br { orig }
}

fn x(n: f64, c: Option<Vec<NotationNode>>) -> NotationNode {
    NotationNode::X { n, c }
}

fn serialized(tree: Vec<NotationNode>) -> String {
    text(&serialize_notation(&tree).unwrap())
}

fn start_tag(read: Option<(StartTag, usize)>) -> Option<String> {
    read.map(|(tag, end)| {
        format!(
            "{}|{}|{}|{end}",
            text(&write_start_tag(&tag)),
            tag.attributes.len(),
            text(&tag.tail)
        )
    })
}

fn source(source: &EpubUnitSource) -> String {
    match source {
        EpubUnitSource::Block {
            spine_index,
            path,
            block_id,
        } => format!("block:{spine_index}:{path}:{block_id}"),
        EpubUnitSource::Title { index } => format!("title:{index}"),
        EpubUnitSource::Nav { index } => format!("nav:{index}"),
        EpubUnitSource::Ncx { index } => format!("ncx:{index}"),
    }
}

fn block(id: &str, v: &[u16]) -> EpubTranslationRequestBlock {
    EpubTranslationRequestBlock {
        id: u(id),
        text: v.to_vec(),
    }
}

fn doc(source: &str) -> XmlDocument {
    match HostFixture.parse_xml(&u(source)).unwrap() {
        XmlParseResult::Ok(doc) => doc,
        XmlParseResult::Err { error, .. } => panic!("{error}"),
    }
}

fn text_of(source: &str) -> (XmlDocument, XmlText) {
    let doc = doc(source);
    let node = doc
        .elements
        .iter()
        .find(|e| e.local == "p")
        .and_then(|p| {
            p.children.iter().find_map(|c| {
                if let XmlNode::Text(t) = c {
                    Some(t.clone())
                } else {
                    None
                }
            })
        })
        .expect("a paragraph with text");
    (doc, node)
}

#[test]
fn open_chapter_numbers_the_blocks_in_reading_order() {
    let map = open(
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p>Second <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>",
    );
    let blocks: Vec<String> = map
        .blocks
        .iter()
        .map(|b| {
            format!(
                "{} {} {} {} {}..{} {}..{}",
                b.id,
                b.kind.as_str(),
                b.flowing,
                b.self_closing,
                b.outer.start,
                b.outer.end,
                b.inner.start,
                b.inner.end
            )
        })
        .collect();
    assert_eq!(
        blocks,
        vec![
            "b1 p true false 74..140 84..136",
            "b2 p true false 143..179 146..175",
            "b3 p true false 187..200 190..196",
            "b4 p true true 209..213 211..211",
            "b5 td false false 216..229 220..224"
        ]
    );
    assert_eq!(map.next_id, 6);
}

#[test]
fn block_notation_and_plain_text() {
    let map = open(
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p>Second <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>",
    );
    let b0 = find_block(&map, &u("b1")).unwrap();
    let n0 = block_notation(&map, b0, NotationOptions::default()).unwrap();
    assert_eq!(
        text(&n0.text),
        "Hello <b>big</b> &amp; <x1>link</x1><br/>end"
    );
    assert_eq!(
        n0.context,
        ctx(
            &[(
                1,
                "a",
                false,
                "<a href=\"#x\">",
                "</a>",
                "<a href=\"#x\">link</a>"
            )],
            &[("<b>", "</b>")],
            &[],
            &["<br/>"]
        )
    );
    assert_eq!(
        text(&block_plain_text(&map, b0).unwrap()),
        "Hello big & linkend"
    );
    let b1 = find_block(&map, &u("b2")).unwrap();
    let n1 = block_notation(&map, b1, NotationOptions::default()).unwrap();
    assert_eq!(text(&n1.text), "Second <x1>one</x1>");
    assert_eq!(
        n1.context,
        ctx(
            &[(
                1,
                "em",
                false,
                "<em class=\"k\">",
                "</em>",
                "<em class=\"k\">one</em>"
            )],
            &[],
            &[],
            &[]
        )
    );
    assert_eq!(text(&block_plain_text(&map, b1).unwrap()), "Second one");
    let b2 = find_block(&map, &u("b3")).unwrap();
    let n2 = block_notation(&map, b2, NotationOptions::default()).unwrap();
    assert_eq!(text(&n2.text), "in div");
    assert_eq!(n2.context, ctx(&[], &[], &[], &[]));
    assert_eq!(text(&block_plain_text(&map, b2).unwrap()), "in div");
    let b3 = find_block(&map, &u("b4")).unwrap();
    let n3 = block_notation(&map, b3, NotationOptions::default()).unwrap();
    assert_eq!(text(&n3.text), "");
    assert_eq!(n3.context, ctx(&[], &[], &[], &[]));
    assert_eq!(text(&block_plain_text(&map, b3).unwrap()), "");
}

#[test]
fn notation_checks_and_decodes_against_the_context() {
    let map = open(
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p>Second <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>",
    );
    let context = block_notation(&map, &map.blocks[0], NotationOptions::default())
        .unwrap()
        .context;
    assert!(check_notation(&u("Hello <b>big</b> &amp; <x1>link</x1><br/>end"), &context).is_ok());
    assert_eq!(
        xhtml(notation_to_xhtml(
            &u("Hello <b>big</b> &amp; <x1>link</x1><br/>end"),
            &context
        )),
        "Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end"
    );
    assert!(check_notation(&u("Hello <i>big</i> &amp; <x1>link</x1><br/>end"), &context).is_ok());
    assert_eq!(
        xhtml(notation_to_xhtml(
            &u("Hello <i>big</i> &amp; <x1>link</x1><br/>end"),
            &context
        )),
        "Hello <em>big</em> &amp; <a href=\"#x\">link</a><br/>end"
    );
    assert!(check_notation(&u("Hi <x1>link</x1><br/><br/>end"), &context).is_ok());
    assert_eq!(
        xhtml(notation_to_xhtml(
            &u("Hi <x1>link</x1><br/><br/>end"),
            &context
        )),
        "Hi <a href=\"#x\">link</a><br/><br/>end"
    );
    assert!(check_notation(&u("Hello <x1>link</x1>"), &context).is_ok());
    assert_eq!(
        xhtml(notation_to_xhtml(&u("Hello <x1>link</x1>"), &context)),
        "Hello <a href=\"#x\">link</a>"
    );
    assert_eq!(
        err_text(check_notation(&u("<x1>a</x1><x1>b</x1>"), &context)),
        "placeholder x1 appears more than once"
    );
    assert_eq!(
        err_text(notation_to_xhtml(&u("<x1>a</x1><x1>b</x1>"), &context)),
        "placeholder x1 appears more than once"
    );
    assert_eq!(
        err_text(check_notation(&u("a <q>"), &context)),
        "unknown tag <q>"
    );
    assert_eq!(
        err_text(notation_to_xhtml(&u("a <q>"), &context)),
        "unknown tag <q>"
    );
    assert_eq!(
        err_text(check_notation(&u("a </b>"), &context)),
        "closing </b> has no opening tag"
    );
    assert_eq!(
        err_text(notation_to_xhtml(&u("a </b>"), &context)),
        "closing </b> has no opening tag"
    );
    assert_eq!(
        err_text(check_notation(&u("<b>a"), &context)),
        "<b> is not closed"
    );
    assert_eq!(
        err_text(notation_to_xhtml(&u("<b>a"), &context)),
        "<b> is not closed"
    );
    assert_eq!(
        err_text(check_notation(&u("x <x2/>"), &context)),
        "placeholder x2 does not exist in this block"
    );
    assert_eq!(
        err_text(notation_to_xhtml(&u("x <x2/>"), &context)),
        "placeholder x2 does not exist in this block"
    );
    assert_eq!(
        err_text(check_notation(&u("<x1/>"), &context)),
        "placeholder x1 must be written <x1>\u{2026}</x1>"
    );
    assert_eq!(
        err_text(notation_to_xhtml(&u("<x1/>"), &context)),
        "placeholder x1 must be written <x1>\u{2026}</x1>"
    );
}

#[test]
fn new_block_notation_allows_marks_and_breaks_only() {
    assert_eq!(
        xhtml(new_block_notation_to_xhtml(&u(
            "a <b>b</b> <i>c</i><br/> &amp; &lt;"
        ))),
        "a <strong>b</strong> <em>c</em><br/> &amp; &lt;"
    );
    assert_eq!(
        err_text(new_block_notation_to_xhtml(&u("<x1/>"))),
        "placeholder <x1/> is not allowed in a new block"
    );
    assert_eq!(
        err_text(new_block_notation_to_xhtml(&u("a <q>"))),
        "unknown tag <q>"
    );
    assert_eq!(
        err_text(new_block_notation_to_xhtml(&u("<b>a"))),
        "<b> is not closed"
    );
    assert_eq!(
        xhtml(new_block_notation_to_xhtml(&u("&#x1F600;&#65;&bogus;"))),
        "\u{1f600}A&amp;bogus;"
    );
    assert_eq!(xhtml(new_block_notation_to_xhtml(&u("<br />"))), "<br/>");
    assert_eq!(
        text(&escape_notation_text(&u("a<b&c>d"))),
        "a&lt;b&amp;c&gt;d"
    );
}

#[test]
fn edits_replacements_and_the_chapter_they_make() {
    let map = open(
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p>Second <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>",
    );
    // split
    let edit = BlockEdit::Split {
        block_id: u("b1"),
        offset: 8.0,
    };
    let applied = apply_block_edit(&Fixture, &map, &edit).unwrap();
    assert_eq!(
        reps(&applied.replacements),
        vec!["95..95 </b></p>\n  <p><b>"]
    );
    let next = applied.map.as_ref().unwrap_or(&map);
    assert_eq!(
        text(next.source()),
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>bi</b></p>\n  <p><b>g</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p>Second <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>"
    );
    assert_eq!(
        next.blocks
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b1", "b6", "b2", "b3", "b4", "b5"]
    );
    assert_eq!(applied.created, vec!["b6"]);
    // split at link end
    let edit = BlockEdit::Split {
        block_id: u("b1"),
        offset: 16.0,
    };
    let applied = apply_block_edit(&Fixture, &map, &edit).unwrap();
    assert_eq!(reps(&applied.replacements), vec!["128..128 </p>\n  <p>"]);
    let next = applied.map.as_ref().unwrap_or(&map);
    assert_eq!(
        text(next.source()),
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a></p>\n  <p><br/>end</p>\n  <p>Second <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>"
    );
    assert_eq!(
        next.blocks
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b1", "b6", "b2", "b3", "b4", "b5"]
    );
    assert_eq!(applied.created, vec!["b6"]);
    // line break
    let edit = BlockEdit::LineBreak {
        block_id: u("b2"),
        offset: 3.0,
    };
    let applied = apply_block_edit(&Fixture, &map, &edit).unwrap();
    assert_eq!(reps(&applied.replacements), vec!["149..149 <br/>"]);
    let next = applied.map.as_ref().unwrap_or(&map);
    assert_eq!(
        text(next.source()),
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p>Sec<br/>ond <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>"
    );
    assert_eq!(
        next.blocks
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b1", "b2", "b3", "b4", "b5"]
    );
    assert_eq!(applied.created, Vec::<&str>::new());
    // merge next
    let edit = BlockEdit::Merge {
        block_id: u("b1"),
        with: Neighbour::Next,
    };
    let applied = apply_block_edit(&Fixture, &map, &edit).unwrap();
    assert_eq!(reps(&applied.replacements), vec!["136..146 "]);
    let next = applied.map.as_ref().unwrap_or(&map);
    assert_eq!(
        text(next.source()),
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>endSecond <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>"
    );
    assert_eq!(
        next.blocks
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b1", "b3", "b4", "b5"]
    );
    assert_eq!(applied.created, Vec::<&str>::new());
    // merge previous
    let edit = BlockEdit::Merge {
        block_id: u("b2"),
        with: Neighbour::Previous,
    };
    let applied = apply_block_edit(&Fixture, &map, &edit).unwrap();
    assert_eq!(reps(&applied.replacements), vec!["136..146 "]);
    let next = applied.map.as_ref().unwrap_or(&map);
    assert_eq!(
        text(next.source()),
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>endSecond <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>"
    );
    assert_eq!(
        next.blocks
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b1", "b3", "b4", "b5"]
    );
    assert_eq!(applied.created, Vec::<&str>::new());
    // delete
    let edit = BlockEdit::Delete { block_id: u("b1") };
    let applied = apply_block_edit(&Fixture, &map, &edit).unwrap();
    assert_eq!(
        reps(&applied.replacements),
        vec!["146..146 <span id=\"a\"></span>", "71..140 "]
    );
    let next = applied.map.as_ref().unwrap_or(&map);
    assert_eq!(
        text(next.source()),
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p><span id=\"a\"></span>Second <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>"
    );
    assert_eq!(
        next.blocks
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b2", "b3", "b4", "b5"]
    );
    assert_eq!(applied.created, Vec::<&str>::new());
    // insert
    let edit = BlockEdit::InsertAfter {
        block_id: u("b2"),
        text: u("new <b>b</b>"),
    };
    let applied = apply_block_edit(&Fixture, &map, &edit).unwrap();
    assert_eq!(
        reps(&applied.replacements),
        vec!["179..179 \n  <p>new <strong>b</strong></p>"]
    );
    let next = applied.map.as_ref().unwrap_or(&map);
    assert_eq!(
        text(next.source()),
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p>Second <em class=\"k\">one</em></p>\n  <p>new <strong>b</strong></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>"
    );
    assert_eq!(
        next.blocks
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b1", "b2", "b6", "b3", "b4", "b5"]
    );
    assert_eq!(applied.created, vec!["b6"]);
    // toggle
    let edit = BlockEdit::ToggleMark {
        block_id: u("b2"),
        mark: MarkKind::Bold,
        start: 0.0,
        end: 6.0,
    };
    let applied = apply_block_edit(&Fixture, &map, &edit).unwrap();
    assert_eq!(
        reps(&applied.replacements),
        vec!["146..175 <strong>Second</strong> <em class=\"k\">one</em>"]
    );
    let next = applied.map.as_ref().unwrap_or(&map);
    assert_eq!(
        text(next.source()),
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p><strong>Second</strong> <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>"
    );
    assert_eq!(
        next.blocks
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b1", "b2", "b3", "b4", "b5"]
    );
    assert_eq!(applied.created, Vec::<&str>::new());
    // replace
    let edit = BlockEdit::Replace {
        block_id: u("b2"),
        text: u("Zweite <x1>eins</x1>"),
        drop_ruby: false,
    };
    let applied = apply_block_edit(&Fixture, &map, &edit).unwrap();
    assert_eq!(
        reps(&applied.replacements),
        vec!["146..175 Zweite <em class=\"k\">eins</em>"]
    );
    let next = applied.map.as_ref().unwrap_or(&map);
    assert_eq!(
        text(next.source()),
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p>Zweite <em class=\"k\">eins</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>"
    );
    assert_eq!(
        next.blocks
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b1", "b2", "b3", "b4", "b5"]
    );
    assert_eq!(applied.created, Vec::<&str>::new());
    // bad offset
    let edit = BlockEdit::Split {
        block_id: u("b1"),
        offset: 99.0,
    };
    let refused = refusal(apply_block_edit(&Fixture, &map, &edit));
    assert_eq!(
        refused,
        "bad-offset: offset 99 is outside the block text (0\u{2013}19)"
    );
    // not flowing
    let edit = BlockEdit::Split {
        block_id: u("b5"),
        offset: 0.0,
    };
    let refused = refusal(apply_block_edit(&Fixture, &map, &edit));
    assert_eq!(refused, "not-flowing: td blocks cannot be split");
    // unknown
    let edit = BlockEdit::Delete {
        block_id: u("b404"),
    };
    let refused = refusal(apply_block_edit(&Fixture, &map, &edit));
    assert_eq!(refused, "unknown-block: no block b404 in this chapter");
    // invalid notation
    let edit = BlockEdit::Replace {
        block_id: u("b1"),
        text: u("x"),
        drop_ruby: false,
    };
    let refused = refusal(apply_block_edit(&Fixture, &map, &edit));
    assert_eq!(refused, "invalid-notation: placeholders missing: x1");
    // a sequence
    let edits = [
        BlockEdit::Split {
            block_id: u("b1"),
            offset: 5.0,
        },
        BlockEdit::InsertAfter {
            block_id: u("b2"),
            text: u("x"),
        },
        BlockEdit::Merge {
            block_id: u("b1"),
            with: Neighbour::Next,
        },
    ];
    let EditsResult::Applied {
        map: last,
        replacements,
        created,
    } = apply_block_edits(&Fixture, &map, &edits).unwrap()
    else {
        panic!("refused")
    };
    assert_eq!(reps(&replacements), vec!["179..179 \n  <p>x</p>"]);
    assert_eq!(
        text(last.source()),
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p>Second <em class=\"k\">one</em></p>\n  <p>x</p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>"
    );
    assert_eq!(created, vec!["b7"]);
    assert_eq!(
        last.blocks
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b1", "b2", "b7", "b3", "b4", "b5"]
    );
    assert_eq!(last.next_id, 8);
    let two = [
        BlockEdit::Delete { block_id: u("b1") },
        BlockEdit::Delete { block_id: u("b1") },
    ];
    let EditsResult::Refused { index, refusal } = apply_block_edits(&Fixture, &map, &two).unwrap()
    else {
        panic!("applied")
    };
    assert_eq!(
        format!(
            "{index} {}: {}",
            refusal.code.as_str(),
            text(&refusal.message)
        ),
        "1 unknown-block: no block b1 in this chapter"
    );
}

#[test]
fn remap_keeps_ids_of_untouched_blocks() {
    let map = open(
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p>Second <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>",
    );
    let source = u(
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p>Sec</p>\n  <p>ond <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>",
    );
    let ChapterMap::Open(next) = remap_chapter(
        &Fixture,
        &map,
        &source,
        &reps_in(&[(149, 149, "</p>\n  <p>")]),
    )
    .unwrap() else {
        panic!("broken")
    };
    assert_eq!(
        next.blocks
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b1", "b2", "b6", "b3", "b4", "b5"]
    );
    assert_eq!(next.next_id, 7);
}

#[test]
fn a_broken_chapter_is_a_value_not_an_error() {
    let ChapterMap::Broken(broken) = open_chapter(&Fixture, &u("<a><b></a>")).unwrap() else {
        panic!("opened")
    };
    assert_eq!(
        (broken.error.as_str(), broken.offset),
        ("1:10: unexpected close tag.", 10)
    );
}

#[test]
fn toggle_mark_rebuilds_the_tree() {
    let tree = vec![
        t("ab"),
        mark(
            MarkName::B,
            Some(0),
            vec![t("cd"), x(1.0, Some(vec![t("ef")]))],
        ),
        br(None),
        t("gh"),
    ];
    assert_eq!(
        serialized(
            toggle_mark_in_tree(&tree, MarkName::B, 1.0, 3.0)
                .unwrap()
                .unwrap()
        ),
        "a<b>bcd<x1>ef</x1></b><br/>gh"
    );
    assert_eq!(
        serialized(
            toggle_mark_in_tree(&tree, MarkName::B, 0.0, 8.0)
                .unwrap()
                .unwrap()
        ),
        "<b>abcd<x1>ef</x1><br/>gh</b>"
    );
    assert_eq!(
        serialized(
            toggle_mark_in_tree(&tree, MarkName::I, 3.0, 6.0)
                .unwrap()
                .unwrap()
        ),
        "ab<b>c<i>d<x1>ef</x1></i></b><br/>gh"
    );
    assert_eq!(
        serialized(
            toggle_mark_in_tree(&tree, MarkName::B, 2.0, 4.0)
                .unwrap()
                .unwrap()
        ),
        "abcd<b><x1>ef</x1></b><br/>gh"
    );
    assert_eq!(
        serialized(
            toggle_mark_in_tree(&tree, MarkName::I, 0.0, 1.0)
                .unwrap()
                .unwrap()
        ),
        "<i>a</i>b<b>cd<x1>ef</x1></b><br/>gh"
    );
    assert!(
        toggle_mark_in_tree(&tree, MarkName::B, 5.0, 5.0)
            .unwrap()
            .is_none()
    );
    assert!(
        toggle_mark_in_tree(&tree, MarkName::B, 7.0, 3.0)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        serialized(
            toggle_mark_in_tree(&tree, MarkName::I, 0.5, 2.0)
                .unwrap()
                .unwrap()
        ),
        "<i>ab</i><b>cd<x1>ef</x1></b><br/>gh"
    );
    assert_eq!(
        serialized(
            toggle_mark_in_tree(&tree, MarkName::B, -1.0, 100.0)
                .unwrap()
                .unwrap()
        ),
        "ab<b>cd<x1>ef</x1></b><br/>g<b>h</b>"
    );
    assert_eq!(
        serialized(
            toggle_mark_in_tree(&[t("a\u{1F600}b")], MarkName::B, 2.0, 3.0)
                .unwrap()
                .unwrap()
        ),
        "a<b>\u{1f600}</b>b"
    );
    assert_eq!(
        serialized(
            toggle_mark_in_tree(&[t("a\u{1F600}b")], MarkName::B, 1.0, 2.0)
                .unwrap()
                .unwrap()
        ),
        "a<b>\u{1f600}</b>b"
    );
    assert_eq!(
        serialized(
            toggle_mark_in_tree(&[t("a\u{1F600}b")], MarkName::B, 0.0, 2.0)
                .unwrap()
                .unwrap()
        ),
        "<b>a\u{1f600}</b>b"
    );
}

#[test]
fn start_tags_are_read_and_ids_removed() {
    assert_eq!(
        start_tag(read_start_tag(
            &u("<a href=\"x\" id=\"i\" class='c'>t</a>"),
            0
        ))
        .unwrap(),
        "<a href=\"x\" id=\"i\" class='c'>|3|>|29"
    );
    assert_eq!(
        start_tag(read_start_tag(&u("<p\tid\n=\r\"a\" />"), 0)).unwrap(),
        "<p\tid\n=\r\"a\" />|1| />|14"
    );
    assert_eq!(
        start_tag(read_start_tag(&u("<br/>"), 0)).unwrap(),
        "<br/>|0|/>|5"
    );
    assert!(read_start_tag(&u("<p id=a>"), 0).is_none());
    assert!(read_start_tag(&u("x <p id=\"a\"> y <!-- <p id=\"b\"> --> <![CDATA[<p id=\"c\">]]> <p xml:id=\"d\" data-id=\"e\"/>"), 0).is_none());
    assert_eq!(
        text(&remove_ids(&u(
            "x <p id=\"a\"> y <!-- <p id=\"b\"> --> <![CDATA[<p id=\"c\">]]> <p xml:id=\"d\" data-id=\"e\"/>"
        ))),
        "x <p> y <!-- <p id=\"b\"> --> <![CDATA[<p id=\"c\">]]> <p data-id=\"e\"/>"
    );
}

#[test]
fn element_helpers_edit_the_source_as_written() {
    let doc = doc(
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p>Second <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>",
    );
    assert_eq!(rep(insertion_after(&doc, 1, &u("<i/>"))), "237..237 <i/>");
    assert_eq!(rep(insertion_after(&doc, 4, &u("<i/>"))), "128..128 <i/>");
    assert_eq!(rep(insertion_after(&doc, 5, &u("<i/>"))), "133..133 <i/>");
    assert_eq!(
        rep(element_text_replacement(&doc, 2, &u("T")).unwrap()),
        "84..136 T"
    );
    assert_eq!(
        rep(element_text_replacement(&doc, 6, &u("T")).unwrap()),
        "146..175 T"
    );
    assert_eq!(
        rep(element_text_replacement(&doc, 7, &u("T")).unwrap()),
        "167..170 T"
    );
}

#[test]
fn text_raw_offset_skips_references_whole() {
    let (doc, node) = text_of(
        "<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>x&nbsp;y&eacute;z</p></body></html>",
    );
    let at = |k| text_raw_offset(&Fixture, &doc, &node, k).unwrap();
    assert_eq!(at(0), 68);
    assert_eq!(at(1), 69);
    assert_eq!(at(2), 75);
    assert_eq!(at(3), 76);
    assert_eq!(at(4), 84);
    assert_eq!(at(5), 85);
    assert_eq!(at(6), 85);
    assert_eq!(at(7), 85);
    assert_eq!(at(9), 85);
}

#[test]
fn prompts_are_the_typescript_text() {
    assert_eq!(
        sha256_hex(epub_translation_system_prompt("en", TranslationMode::Translate).as_bytes()),
        "51fb8299b75e58f6ec00cbb720bc960f9d7ed5d2e0015dc951cf33cfe28d50bc"
    );
    assert_eq!(
        sha256_hex(epub_translation_system_prompt("en", TranslationMode::Easy).as_bytes()),
        "5875bd88641837d4eb66e9f38db4842bf9e66e1c9448961c3e66c8d886df9a28"
    );
    assert_eq!(
        sha256_hex(epub_translation_system_prompt("ko", TranslationMode::Translate).as_bytes()),
        "c930c0351bc3c40c001bb60dc9f469ec3f3e6482cc2e9257aa8cf3b7ef079509"
    );
    assert_eq!(
        sha256_hex(epub_translation_system_prompt("ko", TranslationMode::Easy).as_bytes()),
        "5227e39e98c9a9ed2808146d0825d78d2af8b40941b3126fb515b7a1319febc1"
    );
    assert_eq!(
        sha256_hex(epub_translation_system_prompt("zh-TW", TranslationMode::Translate).as_bytes()),
        "aa17de0fd1555e127eeeb2834abba26cb3717ab977b241a1307d1d6fdf9e2219"
    );
    assert_eq!(
        sha256_hex(epub_translation_system_prompt("zh-TW", TranslationMode::Easy).as_bytes()),
        "e625a0634d55826060b5d801361a0c1e776f99f590fc33b4f234208498c4901b"
    );
    assert_eq!(
        sha256_hex(epub_translation_system_prompt("xx", TranslationMode::Translate).as_bytes()),
        "b2c7e3b2bd6f40d11b4b4d5f9caa60e69cc467f6548d2857755d61b7a9cce92f"
    );
    assert_eq!(
        sha256_hex(epub_translation_system_prompt("xx", TranslationMode::Easy).as_bytes()),
        "0038e428b2b57e7ca6cae95e580de93945c2a2151e72c23aa597c955386953ba"
    );
    assert_eq!(
        sha256_hex(epub_translation_system_prompt("ja", TranslationMode::Translate).as_bytes()),
        "2813ae31b7d49af8e122c3942ea461a93e820d405906e3dd9ed1cf97c545bff4"
    );
    assert_eq!(
        sha256_hex(epub_translation_system_prompt("ja", TranslationMode::Easy).as_bytes()),
        "c761fd777aa4bcf3f1b02d4f5b90e8e20387095d28af5cfbbec91a05fe0acb54"
    );
    assert_eq!(
        sha256_hex(translation_style_lines("en").join("\n").as_bytes()),
        "07eda3ad1c491e78936b9483e0dc92796e95b406f3d610c41be68f1098d708ed"
    );
    assert_eq!(
        sha256_hex(easy_style_lines("en").join("\n").as_bytes()),
        "c4d8c3b163a73544fe54c562647e351c6f53346b33aab0e0921185f9810449af"
    );
    assert_eq!(
        sha256_hex(translation_style_lines("ko").join("\n").as_bytes()),
        "27d46938c4be91c465d62a92d1920dadca103b522bb2bdf28aa425e7305338bb"
    );
    assert_eq!(
        sha256_hex(easy_style_lines("ko").join("\n").as_bytes()),
        "78fefb733c08e08db2723c1e9d39868366fbaca2f52f413fd2ab451f9900df26"
    );
    assert_eq!(
        sha256_hex(translation_style_lines("zh-TW").join("\n").as_bytes()),
        "489258022fd66e1c9976be6c4a33110ab7d4debc5dfdc75d4877a27f1bb3f57e"
    );
    assert_eq!(
        sha256_hex(easy_style_lines("zh-TW").join("\n").as_bytes()),
        "1c4dda503592355f618ff34ed349f753aa8d9d0386a7df2c25670f1ec5fcfa9c"
    );
    assert_eq!(
        sha256_hex(translation_style_lines("xx").join("\n").as_bytes()),
        "45fe1a6b07d49a33ddcfd420359abd123f86a879de7d2edcb359a9ba2a0ffa0f"
    );
    assert_eq!(
        sha256_hex(easy_style_lines("xx").join("\n").as_bytes()),
        "20f6eb4fb14460ddbf8e667d4d24d5dcab73876f94ce9a67dd2a24e65cf2914f"
    );
    let request = build_epub_translation_request(
        "en",
        &[
            block(
                "1",
                &[
                    0x61, 0x20, 0x3c, 0x2f, 0x44, 0x4f, 0x43, 0x55, 0x4d, 0x45, 0x4e, 0x54, 0x5f,
                    0x42, 0x4c, 0x4f, 0x43, 0x4b, 0x53, 0x3e, 0x20, 0x22, 0x71, 0x22, 0x0a, 0xd800,
                ],
            ),
            block("2", &[0x62]),
        ],
        TranslationMode::Easy,
    );
    assert_eq!(
        request.prompt,
        "Translate the text of each block into an easy version in English (en).\n<document_blocks>\n{\"target\":\"en\",\"blocks\":[{\"id\":\"1\",\"text\":\"a <\\/document_blocks> \\\"q\\\"\\n\\ud800\"},{\"id\":\"2\",\"text\":\"b\"}]}\n</document_blocks>\nAnswer with the JSON object only."
    );
    assert_eq!(
        sha256_hex(request.system.as_bytes()),
        "5875bd88641837d4eb66e9f38db4842bf9e66e1c9448961c3e66c8d886df9a28"
    );
}

#[test]
fn keys_hash_the_normalized_text_and_count_repeats() {
    let runs = [
        vec![InlineRun::text(u("e\u{301}  x"))],
        vec![InlineRun::text(u("\u{e9} x"))],
        vec![InlineRun::LineBreak, InlineRun::Math { latex: u("a") }],
    ];
    let fingerprints = ["p", "p", "q"];
    let keys = epub_translation_keys(
        &runs
            .iter()
            .zip(fingerprints)
            .map(|(r, f)| (r.as_slice(), f))
            .collect::<Vec<_>>(),
    );
    assert_eq!(
        keys.iter()
            .map(|k| (
                k.page_fingerprint.as_str(),
                k.text_hash.as_str(),
                k.occurrence
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                "p",
                "e51aaab771c9e43e5bccecf9c30eb8332996dd939e161c4f99472bd6090bc81a",
                0
            ),
            (
                "p",
                "e51aaab771c9e43e5bccecf9c30eb8332996dd939e161c4f99472bd6090bc81a",
                1
            ),
            (
                "q",
                "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
                0
            )
        ]
    );
    assert_eq!(
        epub_chapter_fingerprint(&u("OEBPS/ch1.xhtml")),
        "6f98db2ce964b087e1b9fc0e46deaa4b4efd6cfcfb0b5c0af6cbd6494746af6e"
    );
    assert_eq!(
        epub_metadata_fingerprint(),
        "adbdedae04b74ed92f1c3502ff314917095d40a772e5fe9a1ff7dccb795a714e"
    );
}

#[test]
fn chapter_units_leave_out_blocks_without_a_letter() {
    let map = open(
        "<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>\n  <p id=\"a\">Hello <b>big</b> &amp; <a href=\"#x\">link</a><br/>end</p>\n  <p>Second <em class=\"k\">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>",
    );
    let units = chapter_translation_units(&map, 2.0, "a/b.xhtml").unwrap();
    assert_eq!(
        units
            .iter()
            .map(|u| format!(
                "{}|{}|{}|{}|{}|{}",
                text(&u.text),
                text(&u.plain_text),
                u.page,
                u.key.text_hash,
                u.key.occurrence,
                source(&u.sources[0])
            ))
            .collect::<Vec<_>>(),
        vec![
            "Hello <b>big</b> &amp; <x1>link</x1><br/>end|Hello big & linkend|2|add7ffb51f2c2391a8dab4131b8d31c7d7be1dc8b04d8c120d54d3c38248ae90|0|block:2:a/b.xhtml:b1",
            "Second <x1>one</x1>|Second one|2|86fefab1be27408e3f609ee8e1b34122e6e4c509757e81003779f4f68ecc5a77|0|block:2:a/b.xhtml:b2",
            "in div|in div|2|9ce7dad9e8bb11845121a106226a4308752a64c4182434df3202890c2bbc24c3|0|block:2:a/b.xhtml:b3",
            "cell|cell|2|39d02b42938b2b75d027ebeb25c9d1fd0b71b6e0453e217a2e85cedc7e4637b4|0|block:2:a/b.xhtml:b5"
        ]
    );
}

#[test]
fn metadata_units_share_one_text() {
    let labels = EpubMetadataLabels {
        titles: vec![u("Caf\u{e9}  Book"), u("123")],
        nav: vec![u("Cafe\u{301} Book"), u("Two")],
        ncx: vec![u("Two")],
    };
    let units = metadata_translation_units(&labels);
    assert_eq!(
        units
            .iter()
            .map(|u| format!(
                "{}|{}|{}|{}",
                text(&u.text),
                u.sources.iter().map(source).collect::<Vec<_>>().join(","),
                u.key.text_hash,
                u.page_fingerprint
            ))
            .collect::<Vec<_>>(),
        vec![
            "Caf\u{e9} Book|title:0,nav:0|bc15ffac199eb3d42bff1cb41479300f65831527b61dbf0377f6fa461e4b61ad|adbdedae04b74ed92f1c3502ff314917095d40a772e5fe9a1ff7dccb795a714e",
            "Two|nav:1,ncx:0|94a72c074cfe574742c9e99e863322f73feff82981d065ff65a0308f44f19f62|adbdedae04b74ed92f1c3502ff314917095d40a772e5fe9a1ff7dccb795a714e"
        ]
    );
}

#[test]
fn languages_and_hashes_follow_the_typescript() {
    assert_eq!(
        guess_language_from_text(&u(&String::from(
            "\u{c548}\u{b155}\u{d558}\u{c138}\u{c694} \u{c138}\u{acc4} \u{c548}\u{b155}\u{d558}\u{c138}\u{c694} \u{c138}\u{acc4} \u{c548}\u{b155}\u{d558}\u{c138}\u{c694} \u{c138}\u{acc4} \u{c548}\u{b155}\u{d558}\u{c138}\u{c694} \u{c138}\u{acc4} "
        ))),
        Some("ko")
    );
    assert_eq!(
        guess_language_from_text(&u(&String::from(
            "The quick brown fox jumps over the lazy dog."
        ))),
        Some("en")
    );
    assert_eq!(guess_language_from_text(&u(&String::from("a b c"))), None);
    assert_eq!(
        guess_language_from_text(&u(&format!("{}{}", "a".repeat(20), ""))),
        Some("en")
    );
    assert_eq!(
        guess_language_from_text(&u(&String::from(
            "\u{3042}\u{5b57}\u{5b57}\u{5b57}\u{5b57}\u{5b57}\u{5b57}\u{5b57}\u{5b57}\u{5b57}"
        ))),
        Some("ja")
    );
    assert_eq!(
        guess_language_from_text(&u(&String::from(
            "\u{3042}\u{5b57}\u{5b57}\u{5b57}\u{5b57}\u{5b57}\u{5b57}\u{5b57}\u{5b57}\u{5b57}\u{5b57}"
        ))),
        Some("zh")
    );
    assert_eq!(
        guess_language_from_text(&u(&String::from(
            "\u{41f}\u{440}\u{438}\u{432}\u{435}\u{442} \u{43c}\u{438}\u{440} \u{41f}\u{440}\u{438}\u{432}\u{435}\u{442} \u{43c}\u{438}\u{440} \u{41f}\u{440}\u{438}\u{432}\u{435}\u{442} \u{43c}\u{438}\u{440} \u{41f}\u{440}\u{438}\u{432}\u{435}\u{442} \u{43c}\u{438}\u{440} "
        ))),
        Some("ru")
    );
    assert_eq!(
        guess_language_from_text(&u(&format!(
            "{}{}",
            "a".repeat(99990),
            "\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}\u{431}"
        ))),
        Some("en")
    );
    assert_eq!(
        default_target_language(
            "ko",
            &u("The quick brown fox jumps over the lazy dog."),
            TranslationMode::Translate
        ),
        "ko"
    );
    assert_eq!(
        default_target_language(
            "en",
            &u("The quick brown fox jumps over the lazy dog."),
            TranslationMode::Translate
        ),
        "en"
    );
    assert_eq!(
        default_target_language(
            "zh-CN",
            &u(
                "\u{4f60}\u{597d}\u{4e16}\u{754c}\u{4f60}\u{597d}\u{4e16}\u{754c}\u{4f60}\u{597d}\u{4e16}\u{754c}\u{4f60}\u{597d}\u{4e16}\u{754c}\u{4f60}\u{597d}\u{4e16}\u{754c}\u{4f60}\u{597d}\u{4e16}\u{754c}"
            ),
            TranslationMode::Translate
        ),
        "en"
    );
    assert_eq!(
        default_target_language(
            "zh-TW",
            &u(
                "\u{4f60}\u{597d}\u{4e16}\u{754c}\u{4f60}\u{597d}\u{4e16}\u{754c}\u{4f60}\u{597d}\u{4e16}\u{754c}\u{4f60}\u{597d}\u{4e16}\u{754c}\u{4f60}\u{597d}\u{4e16}\u{754c}\u{4f60}\u{597d}\u{4e16}\u{754c}"
            ),
            TranslationMode::Translate
        ),
        "en"
    );
    assert_eq!(
        default_target_language("ko", &u("x"), TranslationMode::Easy),
        "ko"
    );
    assert_eq!(
        default_target_language("xx", &u(""), TranslationMode::Translate),
        "en"
    );
    assert_eq!(translation_language_of(Some("zh-HK")), "zh-TW");
    assert_eq!(translation_language_of(Some("ZH_hant")), "zh-TW");
    assert_eq!(translation_language_of(Some("ja-JP")), "ja");
    assert_eq!(translation_language_of(Some("in")), "id");
    assert_eq!(translation_language_of(Some("iw-IL")), "he");
    assert_eq!(translation_language_of(Some("pt-BR")), "pt");
    assert_eq!(translation_language_of(Some("xx")), "en");
    assert_eq!(translation_language_of(Some("")), "en");
    assert_eq!(translation_language_of(Some(" ko ")), "ko");
    assert_eq!(translation_language_of(None), "en");
    assert_eq!(normalize_lang(Some("ko")), "ko");
    assert_eq!(normalize_lang(Some("KO_kr")), "ko");
    assert_eq!(normalize_lang(Some(" ko-KR ")), "ko");
    assert_eq!(normalize_lang(Some("ko-")), "ko");
    assert_eq!(normalize_lang(Some("kor")), "en");
    assert_eq!(normalize_lang(Some("zh-TW")), "en");
    assert_eq!(normalize_lang(Some("ja-JP")), "en");
    assert_eq!(normalize_lang(Some("in")), "en");
    assert_eq!(normalize_lang(Some("")), "en");
    assert_eq!(normalize_lang(None), "en");
    assert_eq!(
        epub_book_language(
            &["und", " fr_CA "]
                .iter()
                .map(|l: &&str| l.to_string())
                .collect::<Vec<_>>(),
            &u("")
        ),
        Some("fr_CA".to_owned())
    );
    assert_eq!(
        epub_book_language(
            &[].iter().map(|l: &&str| l.to_string()).collect::<Vec<_>>(),
            &u("The quick brown fox jumps over the lazy dog.")
        ),
        Some("en".to_owned())
    );
    assert_eq!(
        epub_book_language(
            &["en-US"]
                .iter()
                .map(|l: &&str| l.to_string())
                .collect::<Vec<_>>(),
            &u("")
        ),
        Some("en-US".to_owned())
    );
    assert_eq!(
        default_epub_target_language("ko", &["ko-KR".to_owned()], &[], TranslationMode::Translate),
        "en"
    );
    assert_eq!(
        sha256_hex_text(&[0x61, 0xd800, 0x62]),
        "05087813392efc16fe8ff448920c6328e53af865df39419436659d9ffda90f7b"
    );
}
