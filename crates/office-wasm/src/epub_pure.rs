//! Gate-only calls into the pure editors of the EPUB engine: the block map, the
//! notation, marks, edits and the book translation helpers (feature `pure` of
//! `epub-engine`), by the name of the TypeScript function.
//!
//! The wire follows `ranges.rs`: a JavaScript string that can hold a lone
//! surrogate crosses as a list of UTF-16 units, a number JSON has no form for
//! as its text (`"NaN"`, `"-0"`) going in and as `{ "$number" }` coming out.
//! A chapter crosses as its text (the case's `text`, or `args.source` in
//! units): the map is rebuilt by `openChapter`, whose parse is the host's step
//! `parseXmlPositions`. A notation tree crosses flat, as the list of its
//! tokens: `["t", units]`, `["br", orig]`, `["o", "b" | "i", orig]` (open a
//! mark), `["xo", n]` (open a placeholder), `["xe", n]` (an empty one) and
//! `["c"]` (close what is open), so that no nesting reaches JSON.

use std::collections::HashSet;

use epub_engine::blocks::{
    ChapterBlock, ChapterMap, OPAQUE_ELEMENTS, OpenChapter, find_block, is_flowing_kind, is_opaque,
    open_chapter, remap_chapter,
};
use epub_engine::edits::{
    BlockEdit, EditApplied, EditFailure, EditRefusal, EditsResult, MarkKind, Neighbour,
    apply_block_edit, apply_block_edits, block_edit_replacements,
};
use epub_engine::marks::toggle_mark_in_tree;
use epub_engine::notation::{
    BlockNotation, MarkName, MarkSource, NotationContext, NotationError, NotationNode,
    NotationOptions, PlaceholderSource, block_notation, block_plain_text, check_notation,
    encode_block, escape_notation_text, new_block_notation_to_xhtml, notation_plain_text,
    notation_to_xhtml, notation_tree_to_xhtml, parse_block_notation, serialize_notation,
};
use epub_engine::pdf_structure::{
    InlineRun, LANGUAGE_SAMPLE_CHARS, TranslationBlockKey, TranslationMode,
    default_target_language, easy_style_lines, guess_language_from_text, normalize_lang, runs_text,
    sha256_hex, sha256_hex_text, translation_language_name, translation_language_of,
    translation_style_lines,
};
use epub_engine::ranges::RangeReplacement;
use epub_engine::translate::keys::{
    EPUB_METADATA_FINGERPRINT_SOURCE, epub_block_key_string, epub_chapter_fingerprint,
    epub_document_hash, epub_metadata_fingerprint, epub_translation_keys,
};
use epub_engine::translate::language::{
    default_epub_target_language, epub_book_language, epub_sample_text,
};
use epub_engine::translate::migrate::epub_migration_info;
use epub_engine::translate::output_markup::{
    StartTag, StartTagAttribute, attribute_of, child_elements, element_text,
    element_text_replacement, escape_attribute, id_attributes, insertion_after, local_is,
    namespace_of, prefix_of, read_start_tag, remove_ids, remove_tag_attributes, set_tag_attribute,
    start_tag_replacement, tag_attribute, walk_elements, whitespace_start, write_start_tag,
};
use epub_engine::translate::prompt::{
    EpubTranslationRequestBlock, build_epub_translation_request, epub_translation_system_prompt,
};
use epub_engine::translate::units::{
    EPUB_METADATA_PAGE, EpubMetadataLabels, EpubTranslationUnit, EpubUnitSource,
    chapter_translation_units, metadata_translation_units,
};
use epub_engine::utf16::{from_wire, lossy, to_wire, units};
use epub_engine::xml_positions_types::{
    ElementId, Thrown, XmlDocument, XmlHost, XmlParseResult, parse_result_from_wire,
};
use jscompat::{number_to_string, to_number};
use serde_json::{Map, Value, json};

/// The parse side of `xml-positions.ts`, through the host's steps.
struct Host;

impl XmlHost for Host {
    fn parse_xml(&self, source: &[u16]) -> Result<XmlParseResult, Thrown> {
        let answer = seu_host::call("parseXmlPositions", &json!({ "source": source }))
            .map_err(|e| Thrown::new(&e.name, e.message))?;
        parse_result_from_wire(source.to_vec(), &answer)
            .map_err(|message| Thrown::new("HostProtocolError", message))
    }

    fn resolve_html_entity(&self, name: &str) -> Result<Option<String>, Thrown> {
        let answer = seu_host::call("resolveHtmlEntity", &json!({ "name": name }))
            .map_err(|e| Thrown::new(&e.name, e.message))?;
        Ok(answer.as_str().map(str::to_owned))
    }
}

type Answer = Result<Value, Thrown>;

fn wire_error(message: String) -> Thrown {
    Thrown::new("Error", message)
}

// ---------------------------------------------------------------------------
// Reading arguments

fn number_of(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => Some(to_number(text)),
        _ => None,
    }
}

fn number_arg(args: &Value, key: &str) -> Result<f64, Thrown> {
    number_of(args.get(key)).ok_or_else(|| wire_error(format!("args.{key} is not a number")))
}

fn units_arg(args: &Value, key: &str) -> Result<Vec<u16>, Thrown> {
    args.get(key)
        .and_then(from_wire)
        .ok_or_else(|| wire_error(format!("args.{key} is not a list of code units")))
}

/// The text the case gives: `args[key]` in units where there is one, else the case's `text`.
fn text_or(args: &Value, key: &str, text: &str) -> Result<Vec<u16>, Thrown> {
    match args.get(key) {
        Some(_) => units_arg(args, key),
        None => Ok(units(text)),
    }
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, Thrown> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| wire_error(format!("args.{key} is not a string")))
}

fn bool_arg(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn mode_arg(args: &Value) -> TranslationMode {
    if args.get("mode").and_then(Value::as_str) == Some("easy") {
        TranslationMode::Easy
    } else {
        TranslationMode::Translate
    }
}

fn list_arg<'a>(value: &'a Value, what: &str) -> Result<&'a Vec<Value>, Thrown> {
    value
        .as_array()
        .ok_or_else(|| wire_error(format!("{what} is not a list")))
}

fn index_of(value: Option<&Value>, what: &str) -> Result<usize, Thrown> {
    value
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| wire_error(format!("{what} is not an index")))
}

fn orig_of(value: Option<&Value>) -> Result<Option<usize>, Thrown> {
    match value {
        Some(Value::Null) | None => Ok(None),
        other => index_of(other, "an original index").map(Some),
    }
}

fn string_list(value: &Value, what: &str) -> Result<Vec<String>, Thrown> {
    list_arg(value, what)?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| wire_error(format!("{what} holds a value that is not a string")))
        })
        .collect()
}

fn units_list(value: &Value, what: &str) -> Result<Vec<Vec<u16>>, Thrown> {
    list_arg(value, what)?
        .iter()
        .map(|item| {
            from_wire(item)
                .ok_or_else(|| wire_error(format!("{what} holds a value that is not units")))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Writing answers

/// A number as `JSON.stringify` writes it (-0 is 0), or `{ "$number" }`.
fn number_value(x: f64) -> Value {
    if !x.is_finite() {
        json!({ "$number": number_to_string(x) })
    } else if x == 0.0 {
        Value::from(0)
    } else if x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0 {
        Value::from(x as i64)
    } else {
        Value::from(x)
    }
}

fn replacement_value(r: &RangeReplacement) -> Value {
    json!({ "start": number_value(r.start), "end": number_value(r.end), "text": to_wire(&r.text) })
}

fn replacements_value(replacements: &[RangeReplacement]) -> Value {
    Value::Array(replacements.iter().map(replacement_value).collect())
}

fn optional_value<T>(value: Option<T>, write: impl FnOnce(T) -> Value) -> Value {
    value.map_or(Value::Null, write)
}

fn units_or_null(value: Option<&[u16]>) -> Value {
    optional_value(value, to_wire)
}

fn attributes_value(attributes: &[epub_engine::xml_positions_types::XmlAttribute]) -> Value {
    Value::Array(
        attributes
            .iter()
            .map(|a| json!({ "name": a.name, "value": a.value }))
            .collect(),
    )
}

fn block_value(block: &ChapterBlock, map: &OpenChapter) -> Value {
    json!({
        "id": block.id,
        "kind": block.kind.as_str(),
        "tag": block.tag,
        "attributes": attributes_value(&block.attributes),
        "flowing": block.flowing,
        "selfClosing": block.self_closing,
        "outer": { "start": block.outer.start, "end": block.outer.end },
        "inner": { "start": block.inner.start, "end": block.inner.end },
        "elementStart": map.doc.element(block.element).start,
    })
}

fn chapter_value(map: &ChapterMap) -> Value {
    match map {
        ChapterMap::Open(open) => json!({
            "broken": false,
            "source": to_wire(open.source()),
            "blocks": open.blocks.iter().map(|b| block_value(b, open)).collect::<Vec<_>>(),
            "nextId": open.next_id,
            "hasDoctype": open.doc.has_doctype,
        }),
        ChapterMap::Broken(broken) => json!({
            "broken": true,
            "source": to_wire(&broken.source),
            "error": broken.error,
            "offset": broken.offset,
        }),
    }
}

fn open_chapter_value(map: &OpenChapter) -> Value {
    chapter_value(&ChapterMap::Open(map.clone()))
}

fn refusal_value(refusal: &EditRefusal) -> Value {
    json!({ "code": refusal.code.as_str(), "message": to_wire(&refusal.message) })
}

// ---------------------------------------------------------------------------
// Notation trees and contexts

fn tokens_of(tree: &[NotationNode]) -> Value {
    enum Step<'a> {
        Nodes(std::slice::Iter<'a, NotationNode>),
    }
    let mut out: Vec<Value> = Vec::new();
    let mut stack = vec![Step::Nodes(tree.iter())];
    while let Some(Step::Nodes(nodes)) = stack.last_mut() {
        let Some(node) = nodes.next() else {
            stack.pop();
            if !stack.is_empty() {
                out.push(json!(["c"]));
            }
            continue;
        };
        match node {
            NotationNode::Text(v) => out.push(json!(["t", to_wire(v)])),
            NotationNode::Br { orig } => out.push(json!(["br", orig])),
            NotationNode::Mark { t, orig, c } => {
                out.push(json!(["o", t.as_str(), orig]));
                stack.push(Step::Nodes(c.iter()));
            }
            NotationNode::X { n, c: None } => out.push(json!(["xe", number_value(*n)])),
            NotationNode::X { n, c: Some(c) } => {
                out.push(json!(["xo", number_value(*n)]));
                stack.push(Step::Nodes(c.iter()));
            }
        }
    }
    Value::Array(out)
}

fn tree_of(value: &Value) -> Result<Vec<NotationNode>, Thrown> {
    enum Open {
        Mark(MarkName, Option<usize>),
        X(f64),
    }
    let mut root: Vec<NotationNode> = Vec::new();
    let mut stack: Vec<(Open, Vec<NotationNode>)> = Vec::new();
    for token in list_arg(value, "a notation tree")? {
        let token = list_arg(token, "a notation token")?;
        let kind = token.first().and_then(Value::as_str).unwrap_or_default();
        let node = match kind {
            "t" => Some(NotationNode::Text(
                token
                    .get(1)
                    .and_then(from_wire)
                    .ok_or_else(|| wire_error("a text token has no units".to_owned()))?,
            )),
            "br" => Some(NotationNode::Br {
                orig: orig_of(token.get(1))?,
            }),
            "xe" => Some(NotationNode::X {
                n: number_of(token.get(1))
                    .ok_or_else(|| wire_error("xe has no number".to_owned()))?,
                c: None,
            }),
            "o" => {
                let t = match token.get(1).and_then(Value::as_str) {
                    Some("b") => MarkName::B,
                    Some("i") => MarkName::I,
                    _ => return Err(wire_error("a mark is neither b nor i".to_owned())),
                };
                stack.push((Open::Mark(t, orig_of(token.get(2))?), Vec::new()));
                None
            }
            "xo" => {
                let n = number_of(token.get(1))
                    .ok_or_else(|| wire_error("xo has no number".to_owned()))?;
                stack.push((Open::X(n), Vec::new()));
                None
            }
            "c" => {
                let (open, c) = stack
                    .pop()
                    .ok_or_else(|| wire_error("a close token closes nothing".to_owned()))?;
                Some(match open {
                    Open::Mark(t, orig) => NotationNode::Mark { t, orig, c },
                    Open::X(n) => NotationNode::X { n, c: Some(c) },
                })
            }
            other => return Err(wire_error(format!("unknown notation token {other}"))),
        };
        if let Some(node) = node {
            match stack.last_mut() {
                Some((_, c)) => c.push(node),
                None => root.push(node),
            }
        }
    }
    if !stack.is_empty() {
        return Err(wire_error("a notation tree is not closed".to_owned()));
    }
    Ok(root)
}

fn context_value(context: &NotationContext) -> Value {
    json!({
        "placeholders": context.placeholders.iter().map(|p| json!({
            "n": number_value(p.n),
            "tag": p.tag,
            "empty": p.empty,
            "startTag": to_wire(&p.start_tag),
            "endTag": to_wire(&p.end_tag),
            "outer": to_wire(&p.outer),
        })).collect::<Vec<_>>(),
        "bold": context.bold.iter().map(mark_source_value).collect::<Vec<_>>(),
        "italic": context.italic.iter().map(mark_source_value).collect::<Vec<_>>(),
        "breaks": context.breaks.iter().map(|b| to_wire(b)).collect::<Vec<_>>(),
    })
}

fn mark_source_value(mark: &MarkSource) -> Value {
    json!({ "startTag": to_wire(&mark.start_tag), "endTag": to_wire(&mark.end_tag) })
}

fn mark_sources_of(value: &Value) -> Result<Vec<MarkSource>, Thrown> {
    list_arg(value, "the marks of a context")?
        .iter()
        .map(|m| {
            Ok(MarkSource {
                start_tag: units_arg(m, "startTag")?,
                end_tag: units_arg(m, "endTag")?,
            })
        })
        .collect()
}

fn context_of(value: &Value) -> Result<NotationContext, Thrown> {
    let field = |key: &str| {
        value
            .get(key)
            .ok_or_else(|| wire_error(format!("args.context.{key} is missing")))
    };
    let mut placeholders = Vec::new();
    for p in list_arg(field("placeholders")?, "context.placeholders")? {
        placeholders.push(PlaceholderSource {
            n: number_arg(p, "n")?,
            tag: str_arg(p, "tag")?.to_owned(),
            empty: bool_arg(p, "empty"),
            start_tag: units_arg(p, "startTag")?,
            end_tag: units_arg(p, "endTag")?,
            outer: units_arg(p, "outer")?,
        });
    }
    Ok(NotationContext {
        placeholders,
        bold: mark_sources_of(field("bold")?)?,
        italic: mark_sources_of(field("italic")?)?,
        breaks: units_list(field("breaks")?, "context.breaks")?,
    })
}

fn notation_ok(key: &str, value: Value) -> Value {
    let mut object = Map::new();
    object.insert("ok".to_owned(), Value::Bool(true));
    object.insert(key.to_owned(), value);
    Value::Object(object)
}

/// `{ ok: true, ... } | { ok: false, error }` of a notation function.
fn notation_answer(result: Result<Value, NotationError>) -> Answer {
    match result {
        Ok(value) => Ok(value),
        Err(NotationError::Invalid(error)) => Ok(json!({ "ok": false, "error": to_wire(&error) })),
        Err(NotationError::Thrown(thrown)) => Err(thrown),
    }
}

// ---------------------------------------------------------------------------
// A chapter and a block of it

fn open_map(text: &str, args: &Value) -> Result<ChapterMap, Thrown> {
    let source = text_or(args, "source", text)?;
    open_chapter(&Host, &source)
}

/// The chapter the case names and one of its blocks, or the broken chapter's answer.
enum Mapped {
    Open(Box<OpenChapter>),
    Broken(Value),
}

fn mapped(text: &str, args: &Value) -> Result<Mapped, Thrown> {
    Ok(match open_map(text, args)? {
        ChapterMap::Open(open) => Mapped::Open(Box::new(open)),
        broken @ ChapterMap::Broken(_) => Mapped::Broken(chapter_value(&broken)),
    })
}

fn block_of<'a>(map: &'a OpenChapter, args: &Value) -> Result<&'a ChapterBlock, Thrown> {
    let id = units_arg(args, "blockId")?;
    find_block(map, &id).ok_or_else(|| wire_error(format!("no block {}", lossy(&id))))
}

// ---------------------------------------------------------------------------
// Edits

fn edit_of(value: &Value) -> Result<BlockEdit, Thrown> {
    let block_id = units_arg(value, "blockId")?;
    Ok(match str_arg(value, "op")? {
        "replace" => BlockEdit::Replace {
            block_id,
            text: units_arg(value, "text")?,
            drop_ruby: value.get("dropRuby").and_then(Value::as_bool) == Some(true),
        },
        "insert_after" => BlockEdit::InsertAfter {
            block_id,
            text: units_arg(value, "text")?,
        },
        "delete" => BlockEdit::Delete { block_id },
        "split" => BlockEdit::Split {
            block_id,
            offset: number_arg(value, "offset")?,
        },
        "merge" => BlockEdit::Merge {
            block_id,
            with: if str_arg(value, "with")? == "next" {
                Neighbour::Next
            } else {
                Neighbour::Previous
            },
        },
        "line_break" => BlockEdit::LineBreak {
            block_id,
            offset: number_arg(value, "offset")?,
        },
        "toggle_mark" => BlockEdit::ToggleMark {
            block_id,
            mark: if str_arg(value, "mark")? == "bold" {
                MarkKind::Bold
            } else {
                MarkKind::Italic
            },
            start: number_arg(value, "start")?,
            end: number_arg(value, "end")?,
        },
        other => return Err(wire_error(format!("unknown edit op {other}"))),
    })
}

fn failure(result: Result<Value, EditFailure>) -> Answer {
    match result {
        Ok(value) => Ok(value),
        Err(EditFailure::Refused(refusal)) => {
            Ok(json!({ "ok": false, "refusal": refusal_value(&refusal) }))
        }
        Err(EditFailure::Thrown(thrown)) => Err(thrown),
    }
}

fn applied_value(applied: &EditApplied, map: &OpenChapter) -> Value {
    json!({
        "ok": true,
        "map": open_chapter_value(applied.map.as_ref().unwrap_or(map)),
        "replacements": replacements_value(&applied.replacements),
        "created": applied.created,
    })
}

// ---------------------------------------------------------------------------
// Start tags

fn start_tag_value(tag: &StartTag) -> Value {
    json!({
        "name": to_wire(&tag.name),
        "attributes": tag.attributes.iter().map(|a| json!({
            "name": to_wire(&a.name),
            "raw": to_wire(&a.raw),
            "value": to_wire(&a.value),
        })).collect::<Vec<_>>(),
        "tail": to_wire(&tag.tail),
    })
}

fn start_tag_of(value: &Value) -> Result<StartTag, Thrown> {
    let mut attributes = Vec::new();
    for a in list_arg(
        value
            .get("attributes")
            .ok_or_else(|| wire_error("a tag has no attributes".to_owned()))?,
        "attributes",
    )? {
        attributes.push(StartTagAttribute {
            name: units_arg(a, "name")?,
            raw: units_arg(a, "raw")?,
            value: units_arg(a, "value")?,
        });
    }
    Ok(StartTag {
        name: units_arg(value, "name")?,
        attributes,
        tail: units_arg(value, "tail")?,
    })
}

/// `ToLength` of a `lastIndex`, for a text of `length` units: `None` where the sticky match fails at once.
fn last_index(at: f64, length: usize) -> Option<usize> {
    let integer = if at.is_nan() {
        0.0
    } else {
        at.trunc().max(0.0)
    };
    (integer <= length as f64).then_some(integer as usize)
}

fn element_at(doc: &XmlDocument, args: &Value) -> Result<Option<ElementId>, Thrown> {
    let k = index_of(args.get("element"), "args.element")?;
    Ok(walk_elements(doc, doc.root)?.get(k).copied())
}

fn element_ref(doc: &XmlDocument, ids: &[ElementId]) -> Value {
    let order = walk_elements(doc, doc.root).unwrap_or_default();
    Value::Array(
        ids.iter()
            .map(|id| optional_value(order.iter().position(|o| o == id), Value::from))
            .collect(),
    )
}

enum Parsed {
    Document(Box<XmlDocument>),
    Failed(Value),
}

fn parsed(text: &str, args: &Value) -> Result<Parsed, Thrown> {
    let source = text_or(args, "source", text)?;
    Ok(match Host.parse_xml(&source)? {
        XmlParseResult::Ok(doc) => Parsed::Document(Box::new(doc)),
        XmlParseResult::Err { error, offset } => {
            Parsed::Failed(json!({ "ok": false, "error": error, "offset": offset }))
        }
    })
}

// ---------------------------------------------------------------------------
// Runs and units of the translation

fn run_of(value: &Value) -> Result<InlineRun, Thrown> {
    Ok(match str_arg(value, "kind")? {
        "text" => InlineRun::Text {
            text: units_arg(value, "text")?,
            bold: bool_arg(value, "bold"),
            italic: bool_arg(value, "italic"),
            href: value.get("href").and_then(Value::as_str).map(str::to_owned),
        },
        "footnoteRef" => InlineRun::FootnoteRef {
            id: str_arg(value, "id")?.to_owned(),
            marker: value
                .get("marker")
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
        "math" => InlineRun::Math {
            latex: units_arg(value, "latex")?,
        },
        "lineBreak" => InlineRun::LineBreak,
        other => return Err(wire_error(format!("unknown run kind {other}"))),
    })
}

fn runs_of(value: &Value) -> Result<Vec<InlineRun>, Thrown> {
    list_arg(value, "runs")?.iter().map(run_of).collect()
}

fn key_value(key: &TranslationBlockKey) -> Value {
    json!({
        "pageFingerprint": key.page_fingerprint,
        "textHash": key.text_hash,
        "occurrence": key.occurrence,
    })
}

fn key_of(value: &Value) -> Result<TranslationBlockKey, Thrown> {
    Ok(TranslationBlockKey {
        page_fingerprint: str_arg(value, "pageFingerprint")?.to_owned(),
        text_hash: str_arg(value, "textHash")?.to_owned(),
        occurrence: index_of(value.get("occurrence"), "occurrence")?,
    })
}

fn run_value(run: &InlineRun) -> Value {
    match run {
        InlineRun::Text {
            text,
            bold,
            italic,
            href,
        } => {
            let mut object = Map::new();
            object.insert("kind".to_owned(), json!("text"));
            object.insert("text".to_owned(), to_wire(text));
            if *bold {
                object.insert("bold".to_owned(), json!(true));
            }
            if *italic {
                object.insert("italic".to_owned(), json!(true));
            }
            if let Some(href) = href {
                object.insert("href".to_owned(), json!(href));
            }
            Value::Object(object)
        }
        InlineRun::FootnoteRef { id, marker } => {
            let mut object = Map::new();
            object.insert("kind".to_owned(), json!("footnoteRef"));
            object.insert("id".to_owned(), json!(id));
            if let Some(marker) = marker {
                object.insert("marker".to_owned(), json!(marker));
            }
            Value::Object(object)
        }
        InlineRun::Math { latex } => json!({ "kind": "math", "latex": to_wire(latex) }),
        InlineRun::LineBreak => json!({ "kind": "lineBreak" }),
    }
}

fn source_value(source: &EpubUnitSource) -> Value {
    match source {
        EpubUnitSource::Block {
            spine_index,
            path,
            block_id,
        } => json!({
            "kind": "block",
            "spineIndex": number_value(*spine_index),
            "path": path,
            "blockId": block_id,
        }),
        EpubUnitSource::Title { index } => json!({ "kind": "title", "index": index }),
        EpubUnitSource::Nav { index } => json!({ "kind": "nav", "index": index }),
        EpubUnitSource::Ncx { index } => json!({ "kind": "ncx", "index": index }),
    }
}

fn unit_value(unit: &EpubTranslationUnit) -> Value {
    json!({
        "runs": unit.runs.iter().map(run_value).collect::<Vec<_>>(),
        "pageFingerprint": unit.page_fingerprint,
        "page": number_value(unit.page),
        "text": to_wire(&unit.text),
        "plainText": to_wire(&unit.plain_text),
        "context": context_value(&unit.context),
        "sources": unit.sources.iter().map(source_value).collect::<Vec<_>>(),
        "key": key_value(&unit.key),
    })
}

fn skeleton_unit(page: f64, plain_text: Vec<u16>) -> EpubTranslationUnit {
    EpubTranslationUnit {
        runs: Vec::new(),
        page_fingerprint: String::new(),
        page,
        key: TranslationBlockKey {
            page_fingerprint: String::new(),
            text_hash: String::new(),
            occurrence: 0,
        },
        text: Vec::new(),
        plain_text,
        context: NotationContext::default(),
        sources: Vec::new(),
    }
}

fn optional_string(value: Option<String>) -> Value {
    optional_value(value, Value::String)
}

// ---------------------------------------------------------------------------
// The functions

/// Every function of the pure editors by its TypeScript name: `None` where the
/// name is not one of them, else the answer or what the TypeScript threw.
pub fn run_named(
    function: &str,
    text: &str,
    bytes: &[u8],
    args: &Value,
) -> Option<Result<Value, Thrown>> {
    dispatch(function, text, bytes, args)
}

/// The shape `epub.rs` asks of a module: a name this module does not know is
/// the error the dispatcher passes on to the next.
pub fn call(
    function: &str,
    text: &str,
    bytes: &[u8],
    args: &Value,
) -> Result<Value, (String, String)> {
    match run_named(function, text, bytes, args) {
        None => Err(("Error".to_owned(), format!("unknown function {function}"))),
        Some(Ok(value)) => Ok(value),
        Some(Err(thrown)) => Err((thrown.name, thrown.message)),
    }
}

fn dispatch(function: &str, text: &str, bytes: &[u8], args: &Value) -> Option<Answer> {
    let answer = match function {
        // blocks.ts
        "isFlowingKind" => Ok(Value::Bool(is_flowing_kind(
            args.get("value").and_then(Value::as_str).unwrap_or_default(),
        ))),
        "openChapter" => open_map(text, args).map(|map| chapter_value(&map)),
        "remapChapter" => remap(text, args),
        "findBlock" => with_block(text, args, |map, block| Ok(block_value(block, map)), true),
        // notation.ts
        "escapeNotationText" => text_or(args, "text", text)
            .map(|text| to_wire(&escape_notation_text(&text))),
        "encodeBlock" => with_block(
            text,
            args,
            |map, block| {
                let (tree, context) = encode_block(map, block, options_of(args))?;
                Ok(json!({ "tree": tokens_of(&tree), "context": context_value(&context) }))
            },
            false,
        ),
        "serializeNotation" => tree_of(args.get("tree").unwrap_or(&Value::Null))
            .and_then(|tree| Ok(to_wire(&serialize_notation(&tree)?))),
        "blockNotation" => with_block(
            text,
            args,
            |map, block| {
                let BlockNotation { text, context } = block_notation(map, block, options_of(args))?;
                Ok(json!({ "text": to_wire(&text), "context": context_value(&context) }))
            },
            false,
        ),
        "notationPlainText" => tree_of(args.get("tree").unwrap_or(&Value::Null))
            .and_then(|tree| Ok(to_wire(&notation_plain_text(&tree)?))),
        "blockPlainText" => with_block(
            text,
            args,
            |map, block| Ok(to_wire(&block_plain_text(map, block)?)),
            false,
        ),
        "checkNotation" => notation_text(text, args).and_then(|(notation, context)| {
            notation_answer(check_notation(&notation, &context).map(|()| json!({ "ok": true })))
        }),
        "notationTreeToXhtml" => tree_of(args.get("tree").unwrap_or(&Value::Null)).and_then(|tree| {
            let context = context_of(args.get("context").unwrap_or(&Value::Null))?;
            Ok(to_wire(&notation_tree_to_xhtml(&tree, &context)?))
        }),
        "parseBlockNotation" => notation_text(text, args).and_then(|(notation, context)| {
            notation_answer(
                parse_block_notation(&notation, &context)
                    .map(|tree| notation_ok("tree", tokens_of(&tree))),
            )
        }),
        "notationToXhtml" => notation_text(text, args).and_then(|(notation, context)| {
            notation_answer(
                notation_to_xhtml(&notation, &context)
                    .map(|xhtml| notation_ok("xhtml", to_wire(&xhtml))),
            )
        }),
        "newBlockNotationToXhtml" => text_or(args, "text", text).and_then(|notation| {
            notation_answer(
                new_block_notation_to_xhtml(&notation)
                    .map(|xhtml| notation_ok("xhtml", to_wire(&xhtml))),
            )
        }),
        // marks.ts
        "toggleMarkInTree" => toggle(args),
        // edits.ts
        "blockEditReplacements" => mapped(text, args).and_then(|mapped| match mapped {
            Mapped::Broken(value) => Ok(value),
            Mapped::Open(map) => {
                let edit = edit_of(args.get("edit").unwrap_or(&Value::Null))?;
                failure(block_edit_replacements(&Host, &map, &edit).map(
                    |replacements| json!({ "ok": true, "replacements": replacements_value(&replacements) }),
                ))
            }
        }),
        "applyBlockEdit" => mapped(text, args).and_then(|mapped| match mapped {
            Mapped::Broken(value) => Ok(value),
            Mapped::Open(map) => {
                let edit = edit_of(args.get("edit").unwrap_or(&Value::Null))?;
                failure(
                    apply_block_edit(&Host, &map, &edit)
                        .map(|applied| applied_value(&applied, &map)),
                )
            }
        }),
        "applyBlockEdits" => mapped(text, args).and_then(|mapped| match mapped {
            Mapped::Broken(value) => Ok(value),
            Mapped::Open(map) => {
                let edits = list_arg(args.get("edits").unwrap_or(&Value::Null), "args.edits")?
                    .iter()
                    .map(edit_of)
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(match apply_block_edits(&Host, &map, &edits)? {
                    EditsResult::Applied {
                        map,
                        replacements,
                        created,
                    } => json!({
                        "ok": true,
                        "map": open_chapter_value(&map),
                        "replacements": replacements_value(&replacements),
                        "created": created,
                    }),
                    EditsResult::Refused { index, refusal } => {
                        json!({ "ok": false, "index": index, "refusal": refusal_value(&refusal) })
                    }
                })
            }
        }),
        // translate/output-markup.ts
        "readStartTag" => text_or(args, "markup", text).map(|markup| {
            let at = number_of(args.get("at")).unwrap_or(0.0);
            match last_index(at, markup.len()).and_then(|at| read_start_tag(&markup, at)) {
                Some((tag, end)) => json!({ "tag": start_tag_value(&tag), "end": end }),
                None => Value::Null,
            }
        }),
        "writeStartTag" => start_tag_of(args.get("tag").unwrap_or(&Value::Null))
            .map(|tag| to_wire(&write_start_tag(&tag))),
        "escapeAttribute" => text_or(args, "value", text).map(|v| to_wire(&escape_attribute(&v))),
        "tagAttribute" => start_tag_of(args.get("tag").unwrap_or(&Value::Null)).and_then(|tag| {
            let name = units_arg(args, "name")?;
            Ok(units_or_null(tag_attribute(&tag, &name)))
        }),
        "setTagAttribute" => start_tag_of(args.get("tag").unwrap_or(&Value::Null)).and_then(|mut tag| {
            set_tag_attribute(&mut tag, &units_arg(args, "name")?, &units_arg(args, "escaped")?)?;
            Ok(start_tag_value(&tag))
        }),
        "removeTagAttributes" => {
            start_tag_of(args.get("tag").unwrap_or(&Value::Null)).and_then(|mut tag| {
                let names: HashSet<Vec<u16>> =
                    units_list(args.get("names").unwrap_or(&Value::Null), "args.names")?
                        .into_iter()
                        .collect();
                remove_tag_attributes(&mut tag, &names);
                Ok(start_tag_value(&tag))
            })
        }
        "removeIds" => text_or(args, "markup", text).map(|markup| to_wire(&remove_ids(&markup))),
        "childElements" => with_element(text, args, |doc, el| {
            Ok(element_ref(doc, &child_elements(doc, el)))
        }),
        "walkElements" => with_element(text, args, |doc, el| {
            Ok(element_ref(doc, &walk_elements(doc, el)?))
        }),
        "attributeOf" => with_element(text, args, |doc, el| {
            Ok(optional_value(
                attribute_of(doc, el, str_arg(args, "name")?),
                Value::from,
            ))
        }),
        "localIs" => with_element(text, args, |doc, el| {
            Ok(Value::Bool(local_is(doc, el, str_arg(args, "local")?)))
        }),
        "prefixOf" => str_arg(args, "name").map(|name| Value::String(prefix_of(name))),
        "namespaceOf" => with_element(text, args, |doc, el| {
            Ok(optional_string(namespace_of(doc, el, str_arg(args, "prefix")?)))
        }),
        "elementText" => with_element(text, args, |doc, el| {
            let skip: HashSet<String> = string_list(args.get("skip").unwrap_or(&Value::Null), "args.skip")?
                .into_iter()
                .collect();
            Ok(to_wire(&element_text(doc, el, &skip, 0)?))
        }),
        "whitespaceStart" => text_or(args, "source", text).and_then(|source| {
            let offset = index_of(args.get("offset"), "args.offset")?;
            Ok(Value::from(whitespace_start(&source, offset)))
        }),
        "startTagReplacement" => with_element(text, args, |doc, el| {
            let changes = list_arg(args.get("changes").unwrap_or(&Value::Null), "args.changes")?;
            let replacement = start_tag_replacement(doc, el, |tag| {
                for change in changes {
                    match str_arg(change, "op")? {
                        "set" => set_tag_attribute(
                            tag,
                            &units_arg(change, "name")?,
                            &units_arg(change, "escaped")?,
                        )?,
                        "remove" => {
                            let names: HashSet<Vec<u16>> =
                                units_list(change.get("names").unwrap_or(&Value::Null), "names")?
                                    .into_iter()
                                    .collect();
                            remove_tag_attributes(tag, &names);
                        }
                        "tail" => tag.tail = units_arg(change, "value")?,
                        other => return Err(wire_error(format!("unknown change {other}"))),
                    }
                }
                Ok(())
            })?;
            Ok(optional_value(replacement, |r| replacement_value(&r)))
        }),
        "elementTextReplacement" => with_element(text, args, |doc, el| {
            Ok(replacement_value(&element_text_replacement(
                doc,
                el,
                &units_arg(args, "escaped")?,
            )?))
        }),
        "insertionAfter" => with_element(text, args, |doc, el| {
            Ok(replacement_value(&insertion_after(
                doc,
                el,
                &units_arg(args, "markup")?,
            )))
        }),
        // translate/prompt.ts
        "epubTranslationSystemPrompt" => str_arg(args, "lang")
            .map(|lang| Value::String(epub_translation_system_prompt(lang, mode_arg(args)))),
        "buildEpubTranslationRequest" => build_request(args),
        // translate/language.ts
        "epubBookLanguage" => languages(args).and_then(|languages| {
            let sample = text_or(args, "sampleText", text)?;
            Ok(optional_string(epub_book_language(&languages, &sample)))
        }),
        "defaultEpubTargetLanguage" => languages(args).and_then(|languages| {
            let sample = text_or(args, "sampleText", text)?;
            Ok(Value::String(
                default_epub_target_language(
                    str_arg(args, "uiLanguage")?,
                    &languages,
                    &sample,
                    mode_arg(args),
                )
                .to_owned(),
            ))
        }),
        "epubSampleText" => list_arg(args.get("units").unwrap_or(&Value::Null), "args.units").and_then(|list| {
            let units = list
                .iter()
                .map(|u| Ok(skeleton_unit(number_arg(u, "page")?, units_arg(u, "plainText")?)))
                .collect::<Result<Vec<_>, Thrown>>()?;
            Ok(to_wire(&epub_sample_text(&units)))
        }),
        // translate/keys.ts
        "epubChapterFingerprint" => text_or(args, "path", text)
            .map(|path| Value::String(epub_chapter_fingerprint(&path))),
        "epubTranslationKeys" => translation_keys(args),
        "epubBlockKeyString" => key_of(args.get("key").unwrap_or(&Value::Null))
            .map(|key| Value::String(epub_block_key_string(&key))),
        "epubDocumentHash" => Ok(Value::String(epub_document_hash(bytes))),
        // translate/units.ts
        "chapterTranslationUnits" => mapped(text, args).and_then(|mapped| match mapped {
            Mapped::Broken(value) => Ok(value),
            Mapped::Open(map) => {
                let path = str_arg(args, "path")?;
                let units = chapter_translation_units(&map, number_arg(args, "index")?, path)?;
                Ok(Value::Array(units.iter().map(unit_value).collect()))
            }
        }),
        "metadataTranslationUnits" => (|| {
            let labels = EpubMetadataLabels {
                titles: units_list(args.get("titles").unwrap_or(&Value::Null), "args.titles")?,
                nav: units_list(args.get("nav").unwrap_or(&Value::Null), "args.nav")?,
                ncx: units_list(args.get("ncx").unwrap_or(&Value::Null), "args.ncx")?,
            };
            Ok(Value::Array(
                metadata_translation_units(&labels).iter().map(unit_value).collect(),
            ))
        })(),
        // translate/migrate.ts
        "epubMigrationInfo" => migration(args),
        // pdf-structure and i18n pieces
        "normalizeLang" => Ok(Value::String(
            normalize_lang(args.get("value").and_then(Value::as_str)).to_owned(),
        )),
        "translationLanguageOf" => Ok(Value::String(
            translation_language_of(args.get("value").and_then(Value::as_str)).to_owned(),
        )),
        "translationLanguageName" => str_arg(args, "code")
            .map(|code| Value::String(translation_language_name(code))),
        "translationStyleLines" => str_arg(args, "lang").map(|lang| json!(translation_style_lines(lang))),
        "easyStyleLines" => str_arg(args, "lang").map(|lang| json!(easy_style_lines(lang))),
        "guessLanguageFromText" => text_or(args, "text", text)
            .map(|text| optional_string(guess_language_from_text(&text).map(str::to_owned))),
        "defaultTargetLanguage" => text_or(args, "documentText", text).and_then(|document| {
            Ok(Value::String(
                default_target_language(str_arg(args, "uiLanguage")?, &document, mode_arg(args))
                    .to_owned(),
            ))
        }),
        "runsText" => runs_of(args.get("runs").unwrap_or(&Value::Null))
            .map(|runs| to_wire(&runs_text(&runs))),
        "sha256Hex" => match args.get("text") {
            Some(_) => units_arg(args, "text").map(|t| Value::String(sha256_hex_text(&t))),
            None => Ok(Value::String(sha256_hex(bytes))),
        },
        "pureConstants" => Ok(json!({
            "OPAQUE_ELEMENTS": OPAQUE_ELEMENTS,
            "ID_ATTRIBUTES": sorted_ids(),
            "EPUB_METADATA_FINGERPRINT_SOURCE": EPUB_METADATA_FINGERPRINT_SOURCE,
            "EPUB_METADATA_FINGERPRINT": epub_metadata_fingerprint(),
            "EPUB_METADATA_PAGE": number_value(EPUB_METADATA_PAGE),
            "LANGUAGE_SAMPLE_CHARS": LANGUAGE_SAMPLE_CHARS,
            "opaque": OPAQUE_ELEMENTS.iter().map(|e| is_opaque(e)).collect::<Vec<_>>(),
        })
        .get(args.get("name").and_then(Value::as_str).unwrap_or_default())
        .cloned()
        .unwrap_or(Value::Null)),
        _ => return None,
    };
    Some(answer)
}

fn sorted_ids() -> Vec<String> {
    let mut ids: Vec<String> = id_attributes().iter().map(|n| lossy(n)).collect();
    ids.sort();
    ids
}

fn options_of(args: &Value) -> NotationOptions {
    NotationOptions {
        drop_ruby: args.get("dropRuby").and_then(Value::as_bool) == Some(true),
    }
}

/// The notation text of a case and its context.
fn notation_text(text: &str, args: &Value) -> Result<(Vec<u16>, NotationContext), Thrown> {
    Ok((
        text_or(args, "text", text)?,
        context_of(args.get("context").unwrap_or(&Value::Null))?,
    ))
}

fn with_block(
    text: &str,
    args: &Value,
    f: impl FnOnce(&OpenChapter, &ChapterBlock) -> Answer,
    missing_is_null: bool,
) -> Answer {
    match mapped(text, args)? {
        Mapped::Broken(value) => Ok(value),
        Mapped::Open(map) => match block_of(&map, args) {
            Ok(block) => f(&map, block),
            Err(_) if missing_is_null => Ok(Value::Null),
            Err(error) => Err(error),
        },
    }
}

fn with_element(
    text: &str,
    args: &Value,
    f: impl FnOnce(&XmlDocument, ElementId) -> Answer,
) -> Answer {
    match parsed(text, args)? {
        Parsed::Failed(value) => Ok(value),
        Parsed::Document(doc) => match element_at(&doc, args)? {
            Some(el) => f(&doc, el),
            None => Ok(Value::Null),
        },
    }
}

fn remap(text: &str, args: &Value) -> Answer {
    let previous = units_arg(args, "previousSource")?;
    let ChapterMap::Open(previous) = open_chapter(&Host, &previous)? else {
        return Err(wire_error(
            "args.previousSource is not a chapter".to_owned(),
        ));
    };
    let replacements = list_arg(
        args.get("replacements").unwrap_or(&Value::Null),
        "args.replacements",
    )?
    .iter()
    .map(|r| {
        Ok(RangeReplacement {
            start: number_arg(r, "start")?,
            end: number_arg(r, "end")?,
            text: units_arg(r, "text")?,
        })
    })
    .collect::<Result<Vec<_>, Thrown>>()?;
    let source = text_or(args, "source", text)?;
    remap_chapter(&Host, &previous, &source, &replacements).map(|map| chapter_value(&map))
}

fn toggle(args: &Value) -> Answer {
    let tree = tree_of(args.get("tree").unwrap_or(&Value::Null))?;
    let mark = if str_arg(args, "mark")? == "b" {
        MarkName::B
    } else {
        MarkName::I
    };
    let toggled = toggle_mark_in_tree(
        &tree,
        mark,
        number_arg(args, "start")?,
        number_arg(args, "end")?,
    )?;
    Ok(optional_value(toggled, |tree| tokens_of(&tree)))
}

fn build_request(args: &Value) -> Answer {
    let blocks = list_arg(args.get("blocks").unwrap_or(&Value::Null), "args.blocks")?
        .iter()
        .map(|b| {
            Ok(EpubTranslationRequestBlock {
                id: units_arg(b, "id")?,
                text: units_arg(b, "text")?,
            })
        })
        .collect::<Result<Vec<_>, Thrown>>()?;
    let request = build_epub_translation_request(str_arg(args, "lang")?, &blocks, mode_arg(args));
    Ok(json!({ "system": request.system, "prompt": request.prompt }))
}

fn languages(args: &Value) -> Result<Vec<String>, Thrown> {
    string_list(
        args.get("languages").unwrap_or(&Value::Null),
        "args.languages",
    )
}

fn translation_keys(args: &Value) -> Answer {
    let mut owned: Vec<(Vec<InlineRun>, String)> = Vec::new();
    for unit in list_arg(args.get("units").unwrap_or(&Value::Null), "args.units")? {
        owned.push((
            runs_of(unit.get("runs").unwrap_or(&Value::Null))?,
            str_arg(unit, "pageFingerprint")?.to_owned(),
        ));
    }
    let units: Vec<(&[InlineRun], &str)> = owned
        .iter()
        .map(|(r, f)| (r.as_slice(), f.as_str()))
        .collect();
    Ok(Value::Array(
        epub_translation_keys(&units)
            .iter()
            .map(key_value)
            .collect(),
    ))
}

fn migration(args: &Value) -> Answer {
    let spine_paths = string_list(
        args.get("spinePaths").unwrap_or(&Value::Null),
        "args.spinePaths",
    )?;
    let block_keys = list_arg(
        args.get("blockKeys").unwrap_or(&Value::Null),
        "args.blockKeys",
    )?
    .iter()
    .map(key_of)
    .collect::<Result<Vec<_>, _>>()?;
    let info = epub_migration_info(
        &spine_paths,
        block_keys,
        str_arg(args, "oldDocHash")?,
        str_arg(args, "newDocHash")?,
    );
    let keys = |list: &[TranslationBlockKey]| Value::Array(list.iter().map(key_value).collect());
    Ok(json!({
        "oldDocHash": info.input.old_doc_hash,
        "newDocHash": info.input.new_doc_hash,
        "pageFingerprints": info.input.page_fingerprints,
        "blockKeys": keys(&info.block_keys),
        "keepBlockKeys": keys(info.input.keep_block_keys.as_deref().unwrap_or_default()),
    }))
}
