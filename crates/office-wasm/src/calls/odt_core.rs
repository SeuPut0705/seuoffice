//! `odtCore.*`: the plain-data exports of `packages/odt-engine/src/core` and
//! `assemble/zip.ts`.
//!
//! Conventions (the harness's `calls-odtcore.ts` follows them):
//! - `text` is the first string parameter the function reads (`xml`, `raw`,
//!   `text`, a path); offsets in arguments and results are UTF-16 units
//!   (`U16`) over `text`; the engine's own byte offsets are converted here;
//! - `readRoot` answers `{ name, tag, start, end, attributes, prefixes }` or
//!   `null`; `prefixes` is the list `[prefix, canonical prefix]` of every
//!   `xmlns:*` attribute of the root (the `PrefixMap` is not plain data), and
//!   `attributeMap` / `walkElements` read the root attributes `[{ name, raw }]`
//!   the map is built from as `args.prefixes`;
//! - `walkElements` answers the list of the visitor's calls in order, then
//!   `{ call: "return", value }`: `{ call: "open", name, tag, start, nameEnd,
//!   openEnd, selfClosing, parent }`, `{ call: "close", name, tag, start,
//!   nameEnd, openEnd, closeStart, end, selfClosing, parent }`, `{ call:
//!   "other", kind, start, end, parent }`, `{ call: "warn", message }`
//!   (`parent` is the canonical name of the parent frame or `null`). Args:
//!   `from`, `to`, `skip` (names whose `open` answers skip), `stopOpen`,
//!   `stopClose`;
//! - `XmlScanner` answers the tokens `{ kind, start, end, name, nameEnd }`
//!   (args `from`, `to`);
//! - `scanOdtBody` answers `{ text, blocks, warnings, prefixes }`, a node as
//!   `{ kind, name, tag, start, openEnd, closeStart, end, nameEnd,
//!   selfClosing, attrs, attributes, children }`;
//! - `anchorType`, `cellSpan`, `bookmarkName` read `args.attrs`, the decoded
//!   attributes of the node;
//! - `readOdtStyles` and `OdtStyleTable.resolve` read the styles.xml as
//!   `text` (`args.missing` for none) and `args.contentXml`; a style's offsets
//!   are U16 over the string of its own part;
//! - `paragraphIdentityName`, `markerBookmarkName`, `paragraphIdFromBookmarks`
//!   take ids as numbers: past `usize` the answer is written from the number
//!   as the TypeScript template does; `paragraphIdFromBookmarks` answers the
//!   `Number` of an id past `usize`, where the engine function answers `None`
//!   (such an id names no paragraph);
//! - `editedItems` and `paragraphBlockOf` read their blocks as the model
//!   reads them: a block the model refuses is an error;
//! - `constant` answers the exported constant `args.name`;
//! - `readDocxPart` takes the path as `text` and `args.bytes`; `crc32` takes
//!   `args.bytes`; `dosDateTime` takes `args.ms`, a host in UTC.

use std::rc::Rc;

use docx_engine::model::{Block, Bytes};
use jscompat::{JsNum, number_to_string, parse_float};
use odt_engine::assemble::zip as odt_zip;
use odt_engine::core::HostNow;
use odt_engine::core::body::{
    AnnotationPair, BookmarkPair, ODT_NODE_KINDS, OdtBody, OdtNode, OdtNodeKind, anchor_type,
    bookmark_name, cell_span, nodes_of_kind, pair_annotations, pair_bookmarks, scan_odt_body,
    slice_range, walk_nodes,
};
use odt_engine::core::convert::{
    BRIDGE_MAP_VERSION, EditedItem, TextPatch, apply_text_patches_checked, create_bridge_map,
    marker_bookmark_name, paragraph_id_from_bookmarks, paragraph_identity_name, unquote_family,
};
use odt_engine::core::docx_package::{BRIDGE_DOCUMENT_NAMESPACES, read_docx_part};
use odt_engine::core::flow::{edited_items_of_blocks, paragraph_block_of};
use odt_engine::core::manifest::read_manifest;
use odt_engine::core::meta::{OdtGenerator, OdtProducer, classify_generator, detect_generator};
use odt_engine::core::package::{ODT_TEXT_MEDIA_TYPE, ODT_ZIP_LIMITS};
use odt_engine::core::styles::{
    OdtListLevel, OdtMasterPage, OdtMasterPageRegion, OdtStyle, OdtStyleContainers, OdtStylePart,
    OdtStyleScope, read_odt_styles,
};
use odt_engine::core::xml::{
    CloseVerdict, ElementFrame, ElementRange, ElementVisitor, ODF_NAMESPACES, OpenVerdict,
    PrefixMap, XmlAttribute, XmlScanner, XmlTokenKind, attribute_map, decode_xml_entities,
    escape_xml_attr, escape_xml_text, read_attributes, read_root, walk_elements,
};
use odt_engine::offset::{IndexedText, U16};
use serde_json::{Map, Value, json};

use super::{Returned, arg, byte_past_end, required, u16_past_end, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "decodeXmlEntities" => value(decode_xml_entities(text)),
        "escapeXmlText" => value(escape_xml_text(text)),
        "escapeXmlAttr" => value(escape_xml_attr(text)),
        "readAttributes" => {
            let idx = IndexedText::new(text.to_owned());
            let name_end = byte_arg(&idx, args, "nameEnd")?.unwrap_or(0);
            let tag_end = byte_arg(&idx, args, "tagEnd")?.unwrap_or(0);
            let attributes = read_attributes(&idx.text, name_end, tag_end);
            value(
                attributes
                    .iter()
                    .map(|a| attribute_json(&idx, a))
                    .collect::<Vec<_>>(),
            )
        }
        "attributeMap" => {
            let idx = IndexedText::new(text.to_owned());
            let name_end = byte_arg(&idx, args, "nameEnd")?.unwrap_or(0);
            let tag_end = byte_arg(&idx, args, "tagEnd")?.unwrap_or(0);
            let prefixes = prefix_map(args)?;
            value(attribute_map(&idx.text, name_end, tag_end, &prefixes))
        }
        "readRoot" => {
            let idx = IndexedText::new(text.to_owned());
            let Some(root) = read_root(&idx.text) else {
                return Ok(Some(Value::Null));
            };
            value(json!({
                "name": root.name,
                "tag": root.tag,
                "start": u16_past_end(&idx, root.start),
                "end": u16_past_end(&idx, root.end),
                "attributes": root.attributes.iter().map(|a| attribute_json(&idx, a)).collect::<Vec<_>>(),
                "prefixes": prefix_list(&root.attributes, &root.prefixes),
            }))
        }
        "XmlScanner" => {
            let idx = IndexedText::new(text.to_owned());
            let from = byte_arg(&idx, args, "from")?.unwrap_or(0);
            let to = byte_arg(&idx, args, "to")?.unwrap_or(idx.text.len());
            let mut scanner = XmlScanner::new(&idx.text, from, to);
            let mut tokens = Vec::new();
            while scanner.next() {
                tokens.push(json!({
                    "kind": scanner.kind.as_str(),
                    "start": u16_past_end(&idx, scanner.start),
                    "end": u16_past_end(&idx, scanner.end),
                    "name": scanner.name,
                    "nameEnd": u16_past_end(&idx, scanner.name_end),
                }));
            }
            value(tokens)
        }
        "walkElements" => walk_record(text, args),
        "scanOdtBody" => {
            let idx = Rc::new(IndexedText::new(text.to_owned()));
            let body = scan_odt_body(Rc::clone(&idx)).map_err(|e| e.message().to_owned())?;
            let root_attributes = read_root(&idx.text)
                .map(|r| r.attributes)
                .unwrap_or_default();
            value(json!({
                "text": range_json(&idx, &body.text),
                "blocks": body.blocks.iter().map(|n| node_json(&idx, n)).collect::<Vec<_>>(),
                "warnings": body.warnings,
                "prefixes": prefix_list(&root_attributes, &body.prefixes),
            }))
        }
        "sliceNode" => {
            // `xml.slice(node.start, node.end)`: negative offsets count from the end
            let node: Value = required(args, "node")?;
            let idx = IndexedText::new(text.to_owned());
            let len = idx.len_u16().0 as f64;
            let rel = |key: &str| -> usize {
                let n = node.get(key).and_then(Value::as_f64).unwrap_or(0.0).trunc();
                let units = if n < 0.0 {
                    (len + n).max(0.0)
                } else {
                    n.min(len)
                };
                idx.to_byte(U16(units as u32))
            };
            let range = ElementRange {
                start: rel("start"),
                end: rel("end"),
                ..ElementRange::default()
            };
            value(slice_range(&idx.text, &range))
        }
        "nodesOfKind" => {
            let (idx, body) = scan(text)?;
            let kind: OdtNodeKind = serde_json::from_value(Value::String(required(args, "kind")?))
                .unwrap_or(OdtNodeKind::Opaque);
            let known = required::<String>(args, "kind")?;
            if !is_kind(&known) {
                return value(Vec::<Value>::new());
            }
            value(
                nodes_of_kind(&body.blocks, kind)
                    .iter()
                    .map(|n| node_json(&idx, n))
                    .collect::<Vec<_>>(),
            )
        }
        "walkNodes" => {
            let (idx, body) = scan(text)?;
            let skip: Vec<String> = arg(args, "skipKinds")?.unwrap_or_default();
            let mut visited = Vec::new();
            walk_nodes(&body.blocks, |node| {
                visited.push(u16_past_end(&idx, node.start));
                !skip.iter().any(|k| k == node.kind.as_str())
            });
            value(visited)
        }
        "pairBookmarks" => {
            let (idx, body) = scan(text)?;
            value(
                pair_bookmarks(&body)
                    .iter()
                    .map(|p| bookmark_pair_json(&idx, p))
                    .collect::<Vec<_>>(),
            )
        }
        "pairAnnotations" => {
            let (idx, body) = scan(text)?;
            value(
                pair_annotations(&body)
                    .iter()
                    .map(|p| annotation_pair_json(&idx, p))
                    .collect::<Vec<_>>(),
            )
        }
        "anchorType" => {
            let node = node_with_attrs(args)?;
            value(anchor_type(&node.1[0]))
        }
        "bookmarkName" => {
            let node = node_with_attrs(args)?;
            value(bookmark_name(&node.1[0]))
        }
        "cellSpan" => {
            let node = node_with_attrs(args)?;
            let span = cell_span(&node.1[0]);
            value(json!({ "columns": span.columns, "rows": span.rows }))
        }
        "readManifest" => {
            let idx = IndexedText::new(text.to_owned());
            let manifest = read_manifest(Some(&idx.text));
            value(json!({
                "entries": manifest.entries.iter().map(|e| json!({
                    "fullPath": e.full_path,
                    "mediaType": e.media_type,
                    "version": e.version,
                    "encrypted": e.encrypted,
                    "start": u16_past_end(&idx, e.start),
                    "end": u16_past_end(&idx, e.end),
                })).collect::<Vec<_>>(),
                "rootMediaType": manifest.root_media_type,
                "encrypted": manifest.encrypted,
            }))
        }
        "classifyGenerator" => {
            let missing = arg::<bool>(args, "missing")?.unwrap_or(false);
            value(classify_generator((!missing).then_some(text)).as_str())
        }
        "detectGenerator" => {
            let missing = arg::<bool>(args, "missing")?.unwrap_or(false);
            let generator = detect_generator((!missing).then_some(text));
            value(json!({ "name": generator.name, "producer": generator.producer.as_str() }))
        }
        "readOdtStyles" => {
            let missing = arg::<bool>(args, "missing")?.unwrap_or(false);
            let content: String = required(args, "contentXml")?;
            let table = read_odt_styles((!missing).then_some(text), &content);
            let texts = PartTexts::new(&content, (!missing).then_some(text));
            value(json!({
                "all": table.all.iter().map(|s| style_json(&texts, s)).collect::<Vec<_>>(),
                "masterPages": table.master_pages.iter().map(|m| master_page_json(&texts, m)).collect::<Vec<_>>(),
                "containers": json!({
                    "styles": containers_json(&texts, OdtStylePart::StylesXml, &table.containers.styles),
                    "content": containers_json(&texts, OdtStylePart::ContentXml, &table.containers.content),
                }),
            }))
        }
        "OdtStyleTable.resolve" => {
            let content: String = required(args, "contentXml")?;
            let table = read_odt_styles(Some(text), &content);
            let texts = PartTexts::new(&content, Some(text));
            let name: String = required(args, "name")?;
            let family: String = required(args, "family")?;
            let scope = match required::<String>(args, "scope")?.as_str() {
                "content" => OdtStyleScope::Content,
                _ => OdtStyleScope::Styles,
            };
            let Some(resolved) = table.resolve(&name, &family, scope) else {
                return Ok(Some(Value::Null));
            };
            value(json!({
                "style": style_json(&texts, &resolved.style),
                "chain": resolved.chain.iter().map(|s| style_json(&texts, s)).collect::<Vec<_>>(),
                "defaultStyle": resolved.default_style.as_ref().map(|s| style_json(&texts, s)),
                "properties": resolved.properties,
                "tabStops": resolved.tab_stops,
                "missingParent": resolved.missing_parent,
            }))
        }
        "createBridgeMap" => {
            let generator: Value = required::<Value>(args, "doc")?
                .get("generator")
                .cloned()
                .unwrap_or(Value::Null);
            let name = generator
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let generator = OdtGenerator {
                name,
                producer: OdtProducer::Unknown,
            };
            value(create_bridge_map(&generator))
        }
        "paragraphIdentityName" => {
            let id: f64 = required(args, "id")?;
            value(match as_index(id) {
                Some(id) => paragraph_identity_name(id),
                None => format!("_odtp{}", number_to_string(id)),
            })
        }
        "markerBookmarkName" => {
            let id: f64 = required(args, "id")?;
            let index: f64 = required(args, "index")?;
            value(match (as_index(id), as_index(index)) {
                (Some(id), Some(index)) => marker_bookmark_name(id, index),
                _ => format!("_odtm{}_{}", number_to_string(id), number_to_string(index)),
            })
        }
        "paragraphIdFromBookmarks" => {
            let names: Option<Vec<String>> = arg(args, "names")?;
            match paragraph_id_from_bookmarks(names.as_deref()) {
                Some(id) => value(id),
                None => {
                    // an id past `usize` names no paragraph; the TypeScript answers its `Number`
                    let overflow = names.as_deref().unwrap_or_default().iter().find_map(|n| {
                        let digits = n.strip_prefix("_odtp")?;
                        (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
                            .then(|| parse_float(digits))
                    });
                    match overflow {
                        Some(number) => value(JsNum(number)),
                        None => value(Option::<usize>::None),
                    }
                }
            }
        }
        "constant" => constant(&required::<String>(args, "name")?),
        "unquoteFamily" => value(unquote_family(text)),
        "applyTextPatches" => {
            let idx = IndexedText::new(text.to_owned());
            let raw: Vec<PatchArg> = required(args, "patches")?;
            let patches: Vec<TextPatch> = raw
                .iter()
                .map(|p| TextPatch {
                    part: p.part,
                    start: byte_past_end(&idx, p.start),
                    end: byte_past_end(&idx, p.end),
                    xml: p.xml.clone(),
                })
                .collect();
            match apply_text_patches_checked(&idx.text, &patches) {
                Ok(out) => value(out),
                Err(start) => {
                    let shown = if start > idx.text.len() {
                        idx.len_u16().0 as usize + (start - idx.text.len())
                    } else {
                        idx.to_u16(start).0 as usize
                    };
                    Err(format!("odt: overlapping patches at {shown}"))
                }
            }
        }
        "readDocxPart" => {
            let bytes: Bytes = required(args, "bytes")?;
            read_docx_part(&bytes.0, text)
                .map_err(|e| e.message().to_owned())
                .and_then(value)
        }
        "crc32" => {
            let bytes: Bytes = required(args, "bytes")?;
            value(odt_zip::crc32(&bytes.0))
        }
        "dosDateTime" => {
            let ms: f64 = required(args, "ms")?;
            value(odt_zip::dos_date_time(HostNow {
                ms,
                offset_minutes: 0.0,
            }))
        }
        "editedItems" => {
            let edited: Value = required(args, "edited")?;
            let blocks = blocks_of(edited.get("blocks"))?;
            let items = edited_items_of_blocks(&blocks);
            value(
                items
                    .iter()
                    .map(|item| {
                        let item = item.borrow();
                        json!({ "index": item.index, "xml": item.xml, "blocks": item.blocks.iter().map(block_json).collect::<Vec<_>>() })
                    })
                    .collect::<Vec<_>>(),
            )
        }
        "paragraphBlockOf" => {
            let item: Value = required(args, "item")?;
            let blocks = blocks_of(item.get("blocks"))?;
            let item = EditedItem {
                index: item.get("index").and_then(Value::as_i64).unwrap_or(-1),
                xml: item
                    .get("xml")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                blocks,
            };
            value(paragraph_block_of(&item).map(block_json))
        }
        _ => Err(format!("no function {function}")),
    }
}

/// The blocks of an `editedItems` or `paragraphBlockOf` argument, read as the
/// model reads them (a block the model refuses is an error).
fn blocks_of(blocks: Option<&Value>) -> Result<Vec<Block>, String> {
    serde_json::from_value(blocks.cloned().unwrap_or_else(|| json!([]))).map_err(|e| e.to_string())
}

/// A block as JSON.
fn block_json(block: &Block) -> Value {
    serde_json::to_value(block).unwrap_or(Value::Null)
}

#[derive(serde::Deserialize)]
struct PatchArg {
    part: OdtStylePart,
    start: f64,
    end: f64,
    xml: String,
}

/// `constant`: the exported constants of the group.
fn constant(name: &str) -> Returned {
    match name {
        "ODT_MIMETYPE" => value(odt_engine::assemble::ODT_MIMETYPE),
        "BRIDGE_MAP_VERSION" => value(BRIDGE_MAP_VERSION),
        "ODF_NAMESPACES" => value(
            ODF_NAMESPACES
                .iter()
                .map(|(uri, prefix)| ((*uri).to_owned(), Value::String((*prefix).to_owned())))
                .collect::<Map<String, Value>>(),
        ),
        "BRIDGE_DOCUMENT_NAMESPACES" => value(BRIDGE_DOCUMENT_NAMESPACES),
        "ODT_TEXT_MEDIA_TYPE" => value(ODT_TEXT_MEDIA_TYPE),
        "ODT_ZIP_LIMITS" => value(json!({
            "maxParts": ODT_ZIP_LIMITS.max_parts,
            "maxPartBytes": JsNum(ODT_ZIP_LIMITS.max_part_bytes),
            "maxTotalBytes": JsNum(ODT_ZIP_LIMITS.max_total_bytes),
        })),
        "ODT_NODE_KINDS" => value(
            ODT_NODE_KINDS
                .iter()
                .map(|(name, kind)| ((*name).to_owned(), Value::String(kind.as_str().to_owned())))
                .collect::<Map<String, Value>>(),
        ),
        _ => Err(format!("no constant {name}")),
    }
}

/// An id as `usize` when it is a whole number that fits.
fn as_index(n: f64) -> Option<usize> {
    (n >= 0.0 && n.fract() == 0.0 && n < 4_294_967_296.0).then_some(n as usize)
}

/// The byte offset of a `U16` offset argument; `None` where it is absent.
fn byte_arg(idx: &IndexedText, args: &Value, key: &str) -> Result<Option<usize>, String> {
    Ok(arg::<f64>(args, key)?.map(|n| byte_past_end(idx, n)))
}

fn is_kind(name: &str) -> bool {
    serde_json::from_value::<OdtNodeKind>(Value::String(name.to_owned())).is_ok()
}

fn scan(text: &str) -> Result<(Rc<IndexedText>, OdtBody), String> {
    let idx = Rc::new(IndexedText::new(text.to_owned()));
    let body = scan_odt_body(Rc::clone(&idx)).map_err(|e| e.message().to_owned())?;
    Ok((idx, body))
}

fn range_json(idx: &IndexedText, range: &ElementRange) -> Value {
    json!({
        "start": u16_past_end(idx, range.start),
        "openEnd": u16_past_end(idx, range.open_end),
        "closeStart": u16_past_end(idx, range.close_start),
        "end": u16_past_end(idx, range.end),
        "selfClosing": range.self_closing,
    })
}

fn attribute_json(idx: &IndexedText, a: &XmlAttribute) -> Value {
    json!({
        "name": a.name,
        "raw": a.raw,
        "nameStart": u16_past_end(idx, a.name_start),
        "valueStart": u16_past_end(idx, a.value_start),
        "valueEnd": u16_past_end(idx, a.value_end),
    })
}

fn node_json(idx: &IndexedText, node: &Rc<OdtNode>) -> Value {
    json!({
        "kind": node.kind.as_str(),
        "name": node.name,
        "tag": node.tag,
        "start": u16_past_end(idx, node.start),
        "openEnd": u16_past_end(idx, node.open_end),
        "closeStart": u16_past_end(idx, node.close_start),
        "end": u16_past_end(idx, node.end),
        "nameEnd": u16_past_end(idx, node.name_end),
        "selfClosing": node.self_closing,
        "attrs": node.attrs(),
        "attributes": node.attributes().iter().map(|a| attribute_json(idx, a)).collect::<Vec<_>>(),
        "children": node.children.iter().map(|c| node_json(idx, c)).collect::<Vec<_>>(),
    })
}

fn bookmark_pair_json(idx: &IndexedText, p: &BookmarkPair) -> Value {
    let start = |n: &Option<Rc<OdtNode>>| n.as_ref().map(|n| u16_past_end(idx, n.start));
    json!({ "name": p.name, "start": start(&p.start), "end": start(&p.end), "point": start(&p.point) })
}

fn annotation_pair_json(idx: &IndexedText, p: &AnnotationPair) -> Value {
    json!({
        "name": p.name,
        "annotation": u16_past_end(idx, p.annotation.start),
        "end": p.end.as_ref().map(|n| u16_past_end(idx, n.start)),
    })
}

/// The root attributes `[{ name, raw }]` of `args.prefixes`, as a `PrefixMap`.
fn prefix_map(args: &Value) -> Result<PrefixMap, String> {
    let list: Vec<Value> = arg(args, "prefixes")?.unwrap_or_default();
    let attributes: Vec<XmlAttribute> = list
        .iter()
        .map(|a| XmlAttribute {
            name: a
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            raw: a
                .get("raw")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            name_start: 0,
            value_start: 0,
            value_end: 0,
        })
        .collect();
    Ok(PrefixMap::from_attributes(&attributes))
}

/// `prefixList`: `[prefix, canonical prefix]` of every `xmlns:*` attribute.
fn prefix_list(attributes: &[XmlAttribute], map: &PrefixMap) -> Vec<Value> {
    attributes
        .iter()
        .filter_map(|a| a.name.strip_prefix("xmlns:"))
        .map(|prefix| {
            let canonical = map.canonical(&format!("{prefix}:x")).into_owned();
            let head = canonical.split(':').next().unwrap_or("").to_owned();
            json!([prefix, head])
        })
        .collect()
}

/// A node with the attributes of `args.attrs`, made by scanning one element.
fn node_with_attrs(args: &Value) -> Result<(Rc<IndexedText>, Vec<Rc<OdtNode>>), String> {
    let attrs: Map<String, Value> = arg(args, "attrs")?.unwrap_or_default();
    let written: String = attrs
        .iter()
        .map(|(k, v)| format!(" {k}=\"{}\"", escape_xml_attr(v.as_str().unwrap_or(""))))
        .collect();
    let xml = format!(
        "<office:document-content><office:body><office:text><text:p{written}/></office:text></office:body></office:document-content>"
    );
    let (idx, body) = scan(&xml)?;
    Ok((idx, body.blocks.clone()))
}

// ---- walkElements

struct Recorder<'a> {
    idx: &'a IndexedText,
    calls: Vec<Value>,
    skip: Vec<String>,
    stop_open: Option<String>,
    stop_close: Option<String>,
}

fn frame_json(idx: &IndexedText, el: &ElementFrame<()>) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("name".into(), json!(el.name));
    m.insert("tag".into(), json!(el.tag));
    m.insert("start".into(), json!(u16_past_end(idx, el.start)));
    m.insert("nameEnd".into(), json!(u16_past_end(idx, el.name_end)));
    m.insert("openEnd".into(), json!(u16_past_end(idx, el.open_end)));
    m.insert("selfClosing".into(), json!(el.self_closing));
    m
}

impl ElementVisitor for Recorder<'_> {
    type Data = ();

    fn open(
        &mut self,
        el: &mut ElementFrame<()>,
        parent: Option<&ElementFrame<()>>,
    ) -> OpenVerdict {
        let mut m = Map::new();
        m.insert("call".into(), json!("open"));
        m.extend(frame_json(self.idx, el));
        m.insert("parent".into(), json!(parent.map(|p| p.name.clone())));
        self.calls.push(Value::Object(m));
        if self.stop_open.as_deref() == Some(el.name.as_str()) {
            return OpenVerdict::Stop;
        }
        if self.skip.contains(&el.name) {
            return OpenVerdict::Skip;
        }
        OpenVerdict::Continue
    }

    fn close(
        &mut self,
        el: &mut ElementFrame<()>,
        parent: Option<&ElementFrame<()>>,
    ) -> CloseVerdict {
        let mut m = Map::new();
        m.insert("call".into(), json!("close"));
        m.extend(frame_json(self.idx, el));
        m.insert(
            "closeStart".into(),
            json!(el.close_start.map(|b| u16_past_end(self.idx, b))),
        );
        m.insert(
            "end".into(),
            json!(el.end.map(|b| u16_past_end(self.idx, b))),
        );
        m.insert("parent".into(), json!(parent.map(|p| p.name.clone())));
        self.calls.push(Value::Object(m));
        if self.stop_close.as_deref() == Some(el.name.as_str()) {
            return CloseVerdict::Stop;
        }
        CloseVerdict::Continue
    }

    fn other(
        &mut self,
        kind: XmlTokenKind,
        start: usize,
        end: usize,
        parent: Option<&ElementFrame<()>>,
    ) {
        self.calls.push(json!({
            "call": "other",
            "kind": kind.as_str(),
            "start": u16_past_end(self.idx, start),
            "end": u16_past_end(self.idx, end),
            "parent": parent.map(|p| p.name.clone()),
        }));
    }

    fn warn(&mut self, message: &str) {
        self.calls
            .push(json!({ "call": "warn", "message": message }));
    }
}

fn walk_record(text: &str, args: &Value) -> Returned {
    let idx = IndexedText::new(text.to_owned());
    let prefixes = prefix_map(args)?;
    let from = byte_arg(&idx, args, "from")?.unwrap_or(0);
    let to = byte_arg(&idx, args, "to")?
        .unwrap_or(idx.text.len())
        .min(idx.text.len());
    let mut recorder = Recorder {
        idx: &idx,
        calls: Vec::new(),
        skip: arg(args, "skip")?.unwrap_or_default(),
        stop_open: arg(args, "stopOpen")?,
        stop_close: arg(args, "stopClose")?,
    };
    let ended = walk_elements(&idx.text, &prefixes, &mut recorder, from, to);
    let mut calls = recorder.calls;
    calls.push(json!({ "call": "return", "value": u16_past_end(&idx, ended) }));
    value(calls)
}

// ---- styles

/// The strings the offsets of the style records index.
struct PartTexts {
    content: IndexedText,
    styles: Option<IndexedText>,
}

impl PartTexts {
    fn new(content: &str, styles: Option<&str>) -> Self {
        Self {
            content: IndexedText::new(content.to_owned()),
            styles: styles.map(|s| IndexedText::new(s.to_owned())),
        }
    }

    fn at(&self, part: OdtStylePart, byte: usize) -> u32 {
        match (part, &self.styles) {
            (OdtStylePart::ContentXml, _) => u16_past_end(&self.content, byte),
            (OdtStylePart::StylesXml, Some(styles)) => u16_past_end(styles, byte),
            (OdtStylePart::StylesXml, None) => 0,
        }
    }
}

/// `{ start, openEnd, closeStart, end, selfClosing }` first, as `{ ...rangeOf(el) }` spreads them.
fn range_fields(
    texts: &PartTexts,
    part: OdtStylePart,
    start: usize,
    open_end: usize,
    close_start: usize,
    end: usize,
    self_closing: bool,
) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("start".into(), json!(texts.at(part, start)));
    m.insert("openEnd".into(), json!(texts.at(part, open_end)));
    m.insert("closeStart".into(), json!(texts.at(part, close_start)));
    m.insert("end".into(), json!(texts.at(part, end)));
    m.insert("selfClosing".into(), json!(self_closing));
    m
}

fn level_json(texts: &PartTexts, part: OdtStylePart, l: &OdtListLevel) -> Value {
    let mut m = range_fields(
        texts,
        part,
        l.start,
        l.open_end,
        l.close_start,
        l.end,
        l.self_closing,
    );
    m.insert("level".into(), json!(l.level));
    m.insert("kind".into(), json!(l.kind.as_str()));
    m.insert("elementName".into(), json!(l.element_name));
    m.insert("attrs".into(), json!(l.attrs));
    m.insert("properties".into(), json!(l.properties));
    Value::Object(m)
}

fn style_json(texts: &PartTexts, s: &OdtStyle) -> Value {
    let mut m = range_fields(
        texts,
        s.part,
        s.start,
        s.open_end,
        s.close_start,
        s.end,
        s.self_closing,
    );
    m.insert("kind".into(), json!(s.kind.as_str()));
    m.insert("elementName".into(), json!(s.element_name));
    m.insert("tag".into(), json!(s.tag));
    m.insert("name".into(), json!(s.name));
    m.insert("rawName".into(), json!(s.raw_name));
    m.insert("displayName".into(), json!(s.display_name));
    m.insert("family".into(), json!(s.family));
    m.insert("parentName".into(), json!(s.parent_name));
    m.insert("masterPageName".into(), json!(s.master_page_name));
    m.insert("listStyleName".into(), json!(s.list_style_name));
    m.insert("nextStyleName".into(), json!(s.next_style_name));
    m.insert("automatic".into(), json!(s.automatic));
    m.insert("part".into(), json!(s.part.as_str()));
    m.insert("attrs".into(), json!(s.attrs));
    m.insert("properties".into(), json!(s.properties));
    m.insert("tabStops".into(), json!(s.tab_stops));
    m.insert(
        "levels".into(),
        Value::Array(
            s.levels
                .iter()
                .map(|l| level_json(texts, s.part, l))
                .collect(),
        ),
    );
    Value::Object(m)
}

fn region_json(texts: &PartTexts, r: &OdtMasterPageRegion) -> Value {
    let mut m = range_fields(
        texts,
        OdtStylePart::StylesXml,
        r.start,
        r.open_end,
        r.close_start,
        r.end,
        r.self_closing,
    );
    m.insert("attrs".into(), json!(r.attrs));
    Value::Object(m)
}

fn master_page_json(texts: &PartTexts, p: &OdtMasterPage) -> Value {
    let mut m = range_fields(
        texts,
        OdtStylePart::StylesXml,
        p.start,
        p.open_end,
        p.close_start,
        p.end,
        p.self_closing,
    );
    m.insert("name".into(), json!(p.name));
    m.insert("rawName".into(), json!(p.raw_name));
    m.insert("displayName".into(), json!(p.display_name));
    m.insert("pageLayoutName".into(), json!(p.page_layout_name));
    m.insert("nextStyleName".into(), json!(p.next_style_name));
    m.insert("tag".into(), json!(p.tag));
    m.insert("attrs".into(), json!(p.attrs));
    let mut regions = Map::new();
    for (name, region) in &p.regions {
        regions.insert(name.as_str().to_owned(), region_json(texts, region));
    }
    m.insert("regions".into(), Value::Object(regions));
    m.insert("part".into(), json!("styles.xml"));
    Value::Object(m)
}

fn containers_json(texts: &PartTexts, part: OdtStylePart, c: &OdtStyleContainers) -> Value {
    let mut m = Map::new();
    for key in &c.order {
        let range = match *key {
            "fontFaceDecls" => c.font_face_decls,
            "styles" => c.styles,
            "automaticStyles" => c.automatic_styles,
            _ => c.master_styles,
        };
        if let Some(r) = range {
            m.insert(
                (*key).to_owned(),
                Value::Object(range_fields(
                    texts,
                    part,
                    r.start,
                    r.open_end,
                    r.close_start,
                    r.end,
                    r.self_closing,
                )),
            );
        }
    }
    Value::Object(m)
}
