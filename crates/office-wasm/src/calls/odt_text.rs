//! `odtText.*`: the plain-data exports of `packages/odt-engine/src/text`.
//!
//! Conventions (the harness's `calls-odttext.ts` follows them):
//! - `text` is the first string parameter the function reads (`value`, `tag`,
//!   `xml`, `pPr`, `rPr`, `stylesXml`, `format`, `numFmt`, `family`, `name`,
//!   `original`); `args.missing` set means that string is `undefined`/`null`
//!   (`lengthToTwips`, `twips`, `percent`, `numFmtFromOdf`); every other
//!   parameter is `args.<its TypeScript name>`;
//! - a `Map<string, string>` crosses as its entries `[[key, value], ...]`
//!   (`fontFaces`, and the answer of `docxStylesById`); `prefixes` is the list
//!   `[{ name, raw }]` of the root attributes a `PrefixMap` is built from (as in
//!   `odtCore`); a `ReadonlyArray<Record<string, string>>` of tab stops is an
//!   array of objects;
//! - `alignTexts(original, edited)` answers for the queries it is given:
//!   `args.maps: [[offset, "start" | "end"], ...]`, `args.originalOf:
//!   [index, ...]`, `args.intact: [[start, length], ...]`, and returns
//!   `{ maps: [...], originalOf: [...], intact: [...] }`, each list in the order
//!   of its queries (the TypeScript returns closures);
//! - `textOverrides(keys, edited, face)`: `face` is `family => family + "|face"`,
//!   and the answer is `{ overrides, faces }`, `faces` being the families `face`
//!   was called with, in order;
//! - `placeMarkers(rctx, originals, edited)`: `text` is the part string both
//!   parts of the fake context answer to (`part: () => ({ xml: text })`),
//!   `args.originals` the `BridgeParagraph`s and `args.edited` the texts; the
//!   answer is `{ placements, warnings }`, `warnings` the messages of every
//!   `rctx.warn` call in order (not deduplicated);
//! - `readParagraph(src, range, options)` and `textStyleAttrs(src, name)`: `text`
//!   is the content.xml the source reads (`info`: part `content.xml`, scope
//!   `content`, no font faces, the prefixes of its root), `args.stylesXml` the
//!   styles.xml (absent for none) the style table is read from together with
//!   `text`, `args.range` the element range `{ start, openEnd, closeStart, end,
//!   selfClosing }` in UTF-16 units of `text`, `args.record` the optional
//!   `BridgeParagraph`; offsets in the answer are UTF-16 units. `readParagraph`
//!   answers the model with its keys in the TypeScript's order (`range` as
//!   given, in that key order); no forward context is built here;
//! - `pairMarkers(markers)` answers the markers after pairing;
//! - `styleEntryForOdf` and `styleEntryById` read `args.map`, an object whose
//!   `styles.paragraph` is the list of style entries (the other keys of the map
//!   are not read) and answer the entry or `null`;
//! - not covered, because they take a context, a registry, an `OdtDocument`, a
//!   function the host cannot supply or write into one: `ooxmlPPr`, `ooxmlRPr`,
//!   `convertOdtStyles`, `updateOdtStyles`, `listInstance`,
//!   `listStyleFromNumbering`, `runsXml`, `paragraphStyleInfo`, `readParagraph`
//!   with a `forward` option, `paragraphToOoxml`, `paragraphToOdf`,
//!   `originalModel`, `writeTextItems`, the converters and `registerTextConverters`.

use std::rc::Rc;

use docx_engine::model::{Block, ParaFormat, Run, TableParagraph};
use jscompat::{JsMap, JsNum};
use odt_engine::core::convert::{
    BridgeMap, BridgeMarker, BridgeParagraph, BridgeStyleEntry, BridgeStyles, EditedParagraph,
    OdtPartInfo,
};
use odt_engine::core::styles::{OdtStylePart, OdtStyleScope, read_odt_styles};
use odt_engine::core::xml::{ElementRange, PrefixMap, XmlAttribute, read_root};
use odt_engine::offset::{IndexedText, U16};
use odt_engine::text::align::{Bias, align_texts};
use odt_engine::text::blocks::TEXT_OWNER;
use odt_engine::text::lists::{num_fmt_from_odf, num_fmt_to_odf};
use odt_engine::text::markers::{kept_characters, place_markers_in};
use odt_engine::text::paragraph_model::{
    Frame, ParagraphModel, ReadParagraphOptions, ReadParagraphSource, is_form_field_name,
    is_invisible_inline, pair_markers, read_paragraph, text_style_attrs,
};
use odt_engine::text::paragraph_odf::{
    edited_paragraph_from_block, edited_paragraph_from_table_paragraph,
};
use odt_engine::text::props::HIGHLIGHT_HEX;
use odt_engine::text::props::{
    AttrOverrides, OdfAttrs, ParaKey, ParaKeys, TextKey, TextKeys, changed_para_keys,
    changed_text_keys, cleared_to_inherited, para_format_from_odf, para_keys, para_overrides,
    quote_family, tab_stops_from_odf, tab_stops_to_odf, text_format_from_odf, text_keys,
    text_overrides,
};
use odt_engine::text::style_xml::{StyleXmlEdit, edit_style_xml, new_style_xml, patch_start_tag};
use odt_engine::text::styles::{
    docx_styles_by_id, read_ooxml_p_pr, read_ooxml_r_pr, style_entry_by_id, style_entry_for_odf,
};
use odt_engine::text::units::{
    half_points_to_pt, length_to_twips, percent, twips, twips_to_cm, twips_to_pt,
};
use serde_json::{Value, json};

use super::{Returned, arg, optional, required, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "constant" => constant(&required::<String>(args, "name")?),

        // ---- units
        "lengthToTwips" => optional(length_to_twips(string_arg(text, args)?).map(JsNum)),
        "twips" => optional(twips(string_arg(text, args)?).map(JsNum)),
        "percent" => optional(percent(string_arg(text, args)?).map(JsNum)),
        "twipsToCm" => value(twips_to_cm(required::<JsNum>(args, "value")?.0)),
        "twipsToPt" => value(twips_to_pt(required::<JsNum>(args, "value")?.0)),
        "halfPointsToPt" => value(half_points_to_pt(required::<JsNum>(args, "value")?.0)),

        // ---- align
        "alignTexts" => {
            let edited: String = required(args, "edited")?;
            let alignment = align_texts(text, &edited);
            let maps: Vec<(JsNum, String)> = arg(args, "maps")?.unwrap_or_default();
            let original_of: Vec<JsNum> = arg(args, "originalOf")?.unwrap_or_default();
            let intact: Vec<(JsNum, JsNum)> = arg(args, "intact")?.unwrap_or_default();
            value(json!({
                "maps": maps.iter().map(|(offset, bias)| {
                    let bias = if bias == "start" { Bias::Start } else { Bias::End };
                    JsNum(f64::from(alignment.map(unit(*offset), bias).0))
                }).collect::<Vec<_>>(),
                "originalOf": original_of.iter()
                    .map(|i| JsNum(alignment.original_of_at(i.0 as i64)))
                    .collect::<Vec<_>>(),
                "intact": intact.iter()
                    .map(|(start, length)| intact_query(&alignment, start.0, length.0))
                    .collect::<Vec<_>>(),
            }))
        }

        // ---- props
        "tabStopsFromOdf" => {
            let stops: Option<Vec<OdfAttrs>> = arg(args, "stops")?;
            let margin: JsNum = required(args, "marginLeftTwips")?;
            optional(tab_stops_from_odf(stops.as_deref(), margin.0))
        }
        "paraFormatFromOdf" => {
            let pp: OdfAttrs = arg(args, "pp")?.unwrap_or_default();
            let stops: Option<Vec<OdfAttrs>> = arg(args, "tabStops")?;
            let margin: JsNum = required(args, "marginLeftTwips")?;
            value(para_format_from_odf(&pp, stops.as_deref(), margin.0))
        }
        "paraKeys" => {
            let f: Option<ParaFormat> = arg(args, "f")?;
            value(para_keys(f.as_ref()))
        }
        "changedParaKeys" => {
            let original: ParaKeys = required(args, "original")?;
            let edited: ParaKeys = required(args, "edited")?;
            value(changed_para_keys(&original, &edited))
        }
        "tabStopsToOdf" => {
            let stops: Vec<docx_engine::model::TabStop> = required(args, "stops")?;
            let margin: JsNum = required(args, "marginLeftTwips")?;
            value(tab_stops_to_odf(&stops, margin.0))
        }
        "paraOverrides" => {
            let keys: Vec<ParaKey> = required(args, "keys")?;
            let edited: ParaFormat = required(args, "edited")?;
            let margin: JsNum = required(args, "marginLeftTwips")?;
            let original: ParaKeys = required(args, "original")?;
            value(para_overrides(&keys, &edited, margin.0, &original))
        }
        "textFormatFromOdf" => {
            let tp: OdfAttrs = arg(args, "tp")?.unwrap_or_default();
            value(text_format_from_odf(&tp, &font_faces(args)?))
        }
        "textKeys" => {
            // a `TextFormat` is a `Pick<Run, ...>`: it has no `text`, which `Run` requires
            let f: Option<Run> = match args.get("f") {
                None | Some(Value::Null) => None,
                Some(Value::Object(fields)) => {
                    let mut fields = fields.clone();
                    fields.entry("text").or_insert_with(|| json!(""));
                    Some(
                        serde_json::from_value(Value::Object(fields))
                            .map_err(|error| format!("the f argument: {error}"))?,
                    )
                }
                Some(other) => Some(
                    serde_json::from_value(other.clone())
                        .map_err(|error| format!("the f argument: {error}"))?,
                ),
            };
            value(text_keys(f.as_ref()))
        }
        "changedTextKeys" => {
            let original: TextKeys = required(args, "original")?;
            let edited: TextKeys = required(args, "edited")?;
            value(changed_text_keys(&original, &edited))
        }
        "clearedToInherited" => {
            let changed: Vec<TextKey> = required(args, "changed")?;
            let edited: TextKeys = required(args, "edited")?;
            let inherited: TextKeys = required(args, "inherited")?;
            value(cleared_to_inherited(&changed, &edited, &inherited))
        }
        "textOverrides" => {
            let keys: Vec<TextKey> = required(args, "keys")?;
            let edited: TextKeys = required(args, "edited")?;
            let mut faces: Vec<String> = Vec::new();
            let overrides = text_overrides(&keys, &edited, &mut |family: &str| {
                faces.push(family.to_owned());
                format!("{family}|face")
            });
            value(json!({ "overrides": overrides, "faces": faces }))
        }
        "quoteFamily" => value(quote_family(text)),

        // ---- style-xml
        "patchStartTag" => {
            let overrides: AttrOverrides = arg(args, "overrides")?.unwrap_or_default();
            patch_start_tag(text, &prefix_map(args)?, &overrides)
                .map_err(|e| e.message().to_owned())
                .and_then(value)
        }
        "editStyleXml" => {
            let edit: StyleXmlEdit = required(args, "edit")?;
            edit_style_xml(text, &prefix_map(args)?, &edit)
                .map_err(|e| e.message().to_owned())
                .and_then(value)
        }
        "newStyleXml" => {
            let family: String = required(args, "family")?;
            let parent: Option<String> = arg(args, "parent")?;
            value(new_style_xml(text, &family, parent.as_deref()))
        }

        // ---- styles
        "readOoxmlPPr" => value(read_ooxml_p_pr(text)),
        "readOoxmlRPr" => value(read_ooxml_r_pr(text)),
        "docxStylesById" => {
            let styles = docx_styles_by_id(text);
            value(styles.iter().collect::<Vec<(&str, &String)>>())
        }
        "styleEntryForOdf" => {
            let map = style_map(args)?;
            let odf_name: Option<String> = arg(args, "odfName")?;
            value(style_entry_for_odf(&map, odf_name.as_deref()))
        }
        "styleEntryById" => {
            let map = style_map(args)?;
            let style_id: Option<String> = arg(args, "styleId")?;
            value(style_entry_by_id(&map, style_id.as_deref()))
        }

        // ---- lists
        "numFmtFromOdf" => value(num_fmt_from_odf(string_arg(text, args)?)),
        "numFmtToOdf" => value(num_fmt_to_odf(text)),

        // ---- markers
        "placeMarkers" => {
            let originals: Vec<BridgeParagraph> = required(args, "originals")?;
            let edited: Vec<String> = required(args, "edited")?;
            let xml = Rc::new(IndexedText::new(text.to_owned()));
            let refs: Vec<&BridgeParagraph> = originals.iter().collect();
            let (placed, warnings) = place_markers_in(&|_| Rc::clone(&xml), &refs, &edited);
            let placements: Vec<Vec<Value>> = placed
                .placements
                .iter()
                .map(|piece| {
                    piece
                        .iter()
                        .map(|p| {
                            let mut o = serde_json::Map::new();
                            o.insert("offset".to_owned(), json!(p.offset));
                            o.insert("xml".to_owned(), json!(p.xml));
                            o.insert(
                                "attach".to_owned(),
                                json!(match p.attach {
                                    odt_engine::core::convert::Attach::Prev => "prev",
                                    odt_engine::core::convert::Attach::Next => "next",
                                }),
                            );
                            o.insert("seq".to_owned(), json!(p.seq));
                            if let Some(replaces) = p.replaces {
                                o.insert("replaces".to_owned(), json!(replaces));
                            }
                            Value::Object(o)
                        })
                        .collect()
                })
                .collect();
            value(json!({ "placements": placements, "warnings": warnings }))
        }
        "keptCharacters" => {
            let originals: Vec<BridgeParagraph> = required(args, "originals")?;
            let edited: Vec<String> = required(args, "edited")?;
            let refs: Vec<&BridgeParagraph> = originals.iter().collect();
            value(kept_characters(&refs, &edited))
        }

        // ---- paragraph-model
        "isInvisibleInline" => value(is_invisible_inline(text)),
        "isFormFieldName" => value(is_form_field_name(text)),
        "pairMarkers" => {
            let mut markers: Vec<BridgeMarker> = required(args, "markers")?;
            pair_markers(&mut markers);
            value(markers)
        }
        "textStyleAttrs" => {
            let info = part_info(text);
            let styles = read_odt_styles(args_styles(args)?.as_deref(), text);
            let name: Option<String> = arg(args, "name")?;
            value(text_style_attrs(
                &ReadParagraphSource {
                    info: &info,
                    styles: &styles,
                },
                name.as_deref(),
            ))
        }
        "readParagraph" => {
            let info = part_info(text);
            let styles = read_odt_styles(args_styles(args)?.as_deref(), text);
            let range_json: Value = required(args, "range")?;
            let at = |key: &str| -> Result<usize, String> {
                let n = range_json
                    .get(key)
                    .and_then(Value::as_u64)
                    .ok_or_else(|| format!("the range.{key} argument is missing"))?;
                Ok(info.xml.to_byte(U16(n as u32)))
            };
            let range = ElementRange {
                start: at("start")?,
                open_end: at("openEnd")?,
                close_start: at("closeStart")?,
                end: at("end")?,
                self_closing: range_json
                    .get("selfClosing")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            };
            let record: Option<BridgeParagraph> = arg(args, "record")?;
            let model = read_paragraph(
                &ReadParagraphSource {
                    info: &info,
                    styles: &styles,
                },
                range,
                ReadParagraphOptions {
                    forward: None,
                    record: record.as_ref(),
                },
            )
            .map_err(|e| e.message().to_owned())?;
            value(model_json(&model, &info.xml, &range_json))
        }

        // ---- paragraph-odf
        "editedParagraphFromBlock" => {
            let block: Block = required(args, "b")?;
            value(edited_json(&edited_paragraph_from_block(&block), true))
        }
        "editedParagraphFromTableParagraph" => {
            let paragraph: TableParagraph = required(args, "p")?;
            value(edited_json(
                &edited_paragraph_from_table_paragraph(&paragraph),
                false,
            ))
        }
        _ => Err(format!("no function {function}")),
    }
}

/// `HIGHLIGHT_HEX` (an object in the table's order) and `TEXT_OWNER`.
fn constant(name: &str) -> Returned {
    match name {
        "HIGHLIGHT_HEX" => {
            let mut map = serde_json::Map::new();
            for (key, hex) in HIGHLIGHT_HEX {
                map.insert(key.to_owned(), json!(hex));
            }
            value(Value::Object(map))
        }
        "TEXT_OWNER" => value(TEXT_OWNER),
        _ => Err(format!("no constant {name}")),
    }
}

/// `value` of the first string parameter: `None` where `args.missing` is set.
fn string_arg<'a>(text: &'a str, args: &Value) -> Result<Option<&'a str>, String> {
    let missing = arg::<bool>(args, "missing")?.unwrap_or(false);
    Ok((!missing).then_some(text))
}

/// `alignment.intact(start, length)` for the numbers a caller may hand the
/// closure. A start that is no array index (negative, fractional) reads
/// `undefined`: a single character then passes (`undefined < 0` is false and the
/// loop does not run) and a longer run fails (`undefined !== first + k`). A
/// fractional length runs the loop `ceil(length) - 1` times.
fn intact_query(
    alignment: &odt_engine::text::align::TextAlignment,
    start: f64,
    length: f64,
) -> bool {
    if length <= 0.0 {
        return false;
    }
    let count = length.ceil().min(f64::from(u32::MAX)) as u32;
    if start >= 0.0 && start.fract() == 0.0 {
        alignment.intact(U16(start.min(f64::from(u32::MAX)) as u32), U16(count))
    } else {
        count == 1
    }
}

/// A UTF-16 position or length given as a number.
fn unit(n: JsNum) -> U16 {
    U16(if n.0.is_finite() && n.0 > 0.0 {
        n.0 as u32
    } else {
        0
    })
}

/// `fontFaces`, as the map of its entries.
fn font_faces(args: &Value) -> Result<JsMap<String>, String> {
    let entries: Vec<(String, String)> = arg(args, "fontFaces")?.unwrap_or_default();
    let mut map = JsMap::new();
    for (key, face) in entries {
        map.set(key, face);
    }
    Ok(map)
}

/// The `PrefixMap` of the root attributes `args.prefixes` (`[{ name, raw }]`).
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

/// `args.stylesXml`, absent for none.
fn args_styles(args: &Value) -> Result<Option<String>, String> {
    arg::<String>(args, "stylesXml")
}

/// A `BridgeMap` that holds only the `styles.paragraph` entries of `args.map`.
fn style_map(args: &Value) -> Result<BridgeMap, String> {
    let map: Value = required(args, "map")?;
    let entries: Vec<BridgeStyleEntry> = match map.pointer("/styles/paragraph") {
        Some(list) => serde_json::from_value(list.clone()).map_err(|e| e.to_string())?,
        None => Vec::new(),
    };
    Ok(BridgeMap {
        version: 1,
        generator: None,
        blocks: Vec::new(),
        elements: Vec::new(),
        paragraphs: Vec::new(),
        styles: BridgeStyles {
            paragraph: entries,
            doc_defaults: String::new(),
            default_family: None,
            base_paragraph_style: None,
        },
        lists: Vec::new(),
        warnings: Vec::new(),
        ext: serde_json::Map::new(),
    })
}

/// The part info `readParagraph` reads of `text`: content.xml, its root's
/// prefixes, no font faces.
fn part_info(text: &str) -> OdtPartInfo {
    OdtPartInfo {
        part: OdtStylePart::ContentXml,
        xml: Rc::new(IndexedText::new(text.to_owned())),
        prefixes: read_root(text)
            .map(|root| root.prefixes)
            .unwrap_or_else(|| Rc::new(PrefixMap::new())),
        font_faces: JsMap::new(),
        scope: OdtStyleScope::Content,
    }
}

/// `Frame` as the TypeScript literal writes it.
fn frame_json(frame: &Frame) -> Value {
    match frame {
        Frame::Span { style, open, close } => {
            json!({ "kind": "span", "style": style, "open": open, "close": close })
        }
        Frame::A {
            href,
            style,
            open,
            close,
        } => {
            json!({ "kind": "a", "href": href, "style": style, "open": open, "close": close })
        }
    }
}

/// `ParagraphModel` as the TypeScript literal writes it.
fn model_json(model: &ParagraphModel, xml: &IndexedText, range: &Value) -> Value {
    let _ = xml;
    json!({
        "part": model.part,
        "range": range,
        "element": model.element.as_str(),
        "tag": model.tag,
        "openTag": model.open_tag,
        "closeTag": model.close_tag,
        "styleName": model.style_name,
        "outlineLevel": model.outline_level,
        "text": model.text,
        "charSets": model.char_sets,
        "sets": model.sets.iter().map(|s| json!({
            "frames": s.frames.iter().map(frame_json).collect::<Vec<_>>(),
            "key": s.key,
            "attrs": s.attrs,
            "href": s.href,
        })).collect::<Vec<_>>(),
        "emptySet": model.empty_set,
        "markers": model.markers,
        "splices": model.splices.iter().map(|s| json!({
            "offset": s.offset,
            "xml": s.xml,
            "seq": s.seq,
        })).collect::<Vec<_>>(),
        "markerSeq": model.marker_seq,
    })
}

/// `EditedParagraph` as the TypeScript literal writes it; keys the TypeScript
/// leaves `undefined` are left out. `with_block_keys`: the literal of
/// `editedParagraphFromBlock` (every key); the table paragraph one has only
/// `type`, `runs`, `format`, `styleId`, `list`.
fn edited_json(p: &EditedParagraph, with_block_keys: bool) -> Value {
    let mut o = serde_json::Map::new();
    o.insert(
        "type".to_owned(),
        json!(match p.r#type {
            odt_engine::core::convert::EditedParagraphType::Paragraph => "paragraph",
            odt_engine::core::convert::EditedParagraphType::Heading => "heading",
            odt_engine::core::convert::EditedParagraphType::ListItem => "listItem",
        }),
    );
    o.insert("runs".to_owned(), json!(p.runs));
    if let Some(format) = &p.format {
        o.insert("format".to_owned(), json!(format));
    }
    if let Some(style_id) = &p.style_id {
        o.insert("styleId".to_owned(), json!(style_id));
    }
    if with_block_keys {
        if let Some(level) = p.level {
            o.insert("level".to_owned(), json!(level));
        }
        if let Some(outline_only) = p.outline_only {
            o.insert("outlineOnly".to_owned(), json!(outline_only));
        }
    }
    if let Some(list) = &p.list {
        o.insert("list".to_owned(), json!(list));
    }
    if with_block_keys {
        if let Some(raw) = &p.raw_p_pr {
            o.insert("rawPPr".to_owned(), json!(raw));
        }
        if let Some(hidden) = &p.hidden_bookmarks {
            o.insert("hiddenBookmarks".to_owned(), json!(hidden));
        }
    }
    Value::Object(o)
}
