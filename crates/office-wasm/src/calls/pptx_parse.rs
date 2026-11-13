//! parse.ts and master-edit.ts of the slides engine, called as
//! `<module>.<TypeScript name>`. Every id counter starts at 0: the spec
//! rebases the TypeScript ids to that start (`Uids` in parse/context.rs).

use ooxml_xml::Utf16Map;
use pptx_engine::master_edit::{list_master_parts, parse_master_part};
use pptx_engine::parse::{
    DecorationOptions, ParseContextData, SlideParseInput, Uids, layout_diagram_fallback,
    parse_background, parse_decorations, parse_slide, slice_group_child_xmls,
};
use pptx_engine::zip::PackageArchive;
use serde::Serialize;
use serde_json::Value;

use super::{Returned, arg, optional, required, value};

/// The archive of `args.parts`, `[name, text]` pairs, with the text under
/// `args.textPart` set last: what the TypeScript builds through the private
/// constructor.
fn archive(text: &str, args: &Value) -> Result<PackageArchive, String> {
    let mut parts: Vec<(String, Vec<u8>)> = arg::<Vec<(String, String)>>(args, "parts")?
        .unwrap_or_default()
        .into_iter()
        .map(|(name, text)| (name, text.into_bytes()))
        .collect();
    if let Some(name) = arg::<String>(args, "textPart")? {
        parts.push((name, text.as_bytes().to_vec()));
    }
    Ok(PackageArchive::from_parts(parts, "gate".to_owned()))
}

/// `args.ctx`, the `ParseContext` as the spec writes it.
fn context_data(args: &Value) -> Result<ParseContextData, String> {
    Ok(arg::<ParseContextData>(args, "ctx")?.unwrap_or_default())
}

/// Deeper than any tree a parse returns: groups nest at most 64 deep.
const MAX_TREE_DEPTH: u32 = 2048;

/// `result` with every `anchor.range` in it, byte offsets into `xml`, as
/// UTF-16 code units.
fn with_utf16_anchors(result: &impl Serialize, xml: &str) -> Returned {
    let mut tree = serde_json::to_value(result).map_err(|error| error.to_string())?;
    let map = Utf16Map::new(xml);
    convert_anchors(&mut tree, xml, &map, 0)?;
    Ok(Some(tree))
}

fn convert_anchors(
    node: &mut Value,
    xml: &str,
    map: &Utf16Map<'_>,
    depth: u32,
) -> Result<(), String> {
    if depth > MAX_TREE_DEPTH {
        return Err("the returned tree is too deep".to_owned());
    }
    match node {
        Value::Array(items) => {
            for item in items {
                convert_anchors(item, xml, map, depth + 1)?;
            }
        }
        Value::Object(object) => {
            if let Some(Value::Array(range)) = object
                .get_mut("anchor")
                .and_then(|anchor| anchor.get_mut("range"))
            {
                for offset in range.iter_mut() {
                    let byte = offset
                        .as_u64()
                        .and_then(|byte| usize::try_from(byte).ok())
                        .filter(|&byte| xml.is_char_boundary(byte))
                        .ok_or("an anchor offset is not a character boundary of the slide")?;
                    *offset = Value::from(map.to_utf16(byte));
                }
            }
            for value in object.values_mut() {
                convert_anchors(value, xml, map, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    let uids = Uids::starting_at(0);
    match function {
        "parse.parseSlide" => {
            let data = context_data(args)?;
            let path: String = required(args, "path")?;
            let layout_path: Option<String> = arg(args, "layoutPath")?;
            let master_path: Option<String> = arg(args, "masterPath")?;
            let slide = parse_slide(SlideParseInput {
                path: &path,
                slide_xml: text,
                layout_path: layout_path.as_deref(),
                master_path: master_path.as_deref(),
                ctx: data.context(&uids),
            })?;
            // the anchors are offsets into the slide as it was read: its canonical spelling
            let xml = slide.original_xml.as_deref().unwrap_or_default();
            with_utf16_anchors(&slide, xml)
        }
        "parse.parseBackground" => {
            let data = context_data(args)?;
            optional(parse_background(text, &data.context(&uids)))
        }
        "parse.sliceGroupChildXmls" => value(slice_group_child_xmls(text)?),
        "parse.layoutDiagramFallback" => {
            let data = context_data(args)?;
            let layout_id: Option<String> = arg(args, "layoutId")?;
            let colors_xml: Option<String> = arg(args, "colorsXml")?;
            let layout_xml: Option<String> = arg(args, "layoutXml")?;
            let shapes = layout_diagram_fallback(
                text,
                &data.context(&uids),
                required(args, "frameCx")?,
                required(args, "frameCy")?,
                layout_id.as_deref(),
                colors_xml.as_deref(),
                layout_xml.as_deref(),
            )?;
            with_utf16_anchors(&shapes, text)
        }
        "parse.parseDecorations" => {
            let data = context_data(args)?;
            let opts: DecorationOptions = arg(args, "opts")?.unwrap_or_default();
            let elements = parse_decorations(text, &data.context(&uids), &opts)?;
            with_utf16_anchors(&elements, text)
        }
        "master-edit.listMasterParts" => value(list_master_parts(&archive(text, args)?)?),
        "master-edit.parseMasterPart" => {
            let archive = archive(text, args)?;
            let path: String = required(args, "path")?;
            match parse_master_part(&archive, &path, &uids)? {
                Some(slide) => {
                    let xml = slide.original_xml.as_deref().unwrap_or_default();
                    with_utf16_anchors(&slide, xml)
                }
                None => value(Value::Null),
            }
        }
        _ => Err(format!("unknown function {function}")),
    }
}
