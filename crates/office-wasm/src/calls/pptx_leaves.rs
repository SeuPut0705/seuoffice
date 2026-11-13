//! scan.ts, xml-utils.ts, slide-ids.ts, named-action.ts, table-grid.ts and
//! crc32.ts of the slides engine, called as `<module>.<TypeScript name>`.

use jscompat::JsNum;
use ooxml_xml::Utf16Map;
use pptx_engine::crc32::crc32;
use pptx_engine::named_action::{named_action_attr, named_action_of};
use pptx_engine::scan::scan_slide;
use pptx_engine::slide_ids::{
    can_list_slide, next_slide_id, with_slide_listed, with_slide_unlisted,
};
use pptx_engine::table_grid::{GridCell, table_row_grid_cols};
use pptx_engine::xml_utils::{
    as_xml_node, attribute_of, c_sld_name_of, creation_id_ext_xml, creation_id_xml, decode_xml,
    default_content_type_for, element_range, escape_xml_attr, escape_xml_text,
    has_content_type_override, has_default_for, max_relationship_id_number, root_prefix_of,
    with_relationship_ids, xml_array,
};
use serde::Serialize;
use serde_json::Value;

use super::{Returned, arg, optional, required, value};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireElement<'a> {
    name: &'a str,
    start: u32,
    end: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    gap_after: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireRange {
    start: u32,
    end: u32,
    content_start: u32,
    content_end: u32,
}

/// The byte offset of UTF-16 offset `units` in `text`; `None` past its end.
fn byte_at_utf16(text: &str, units: usize) -> Option<usize> {
    let mut seen = 0;
    for (byte, ch) in text.char_indices() {
        if seen >= units {
            return Some(byte);
        }
        seen += ch.len_utf16();
    }
    (seen >= units).then_some(text.len())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireScan<'a> {
    elements: Vec<WireElement<'a>>,
    body_prefix: &'a str,
    body_suffix: &'a str,
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "scan.scanSlide" => {
            let scan = scan_slide(text).map_err(|error| error.to_string())?;
            let map = Utf16Map::new(text);
            value(WireScan {
                elements: scan
                    .elements
                    .iter()
                    .map(|element| WireElement {
                        name: element.name,
                        start: map.to_utf16(element.start as usize),
                        end: map.to_utf16(element.end as usize),
                        gap_after: element.gap_after,
                    })
                    .collect(),
                body_prefix: scan.body_prefix,
                body_suffix: scan.body_suffix,
            })
        }
        "xml-utils.asXmlNode" => value(as_xml_node(args.get("value"))),
        "xml-utils.xmlArray" => value(xml_array(args.get("value")).collect::<Vec<_>>()),
        "xml-utils.decodeXml" => value(decode_xml(text)),
        "xml-utils.escapeXmlText" => value(escape_xml_text(text)),
        "xml-utils.escapeXmlAttr" => value(escape_xml_attr(text)),
        "xml-utils.percentFraction" => {
            let raw: Option<serde_json::Value> = arg(args, "raw")?;
            optional(pptx_engine::xml_utils::percent_fraction(raw.as_ref()).map(JsNum))
        }
        "xml-utils.maxRelationshipIdNumber" => value(JsNum(max_relationship_id_number(text))),
        "xml-utils.hasContentTypeOverride" => value(has_content_type_override(
            text,
            &required::<String>(args, "partPath")?,
        )),
        "xml-utils.creationIdExtXml" => value(creation_id_ext_xml(text)),
        "xml-utils.creationIdXml" => value(creation_id_xml(text)),
        "xml-utils.hasDefaultFor" => {
            value(has_default_for(text, &required::<String>(args, "ext")?))
        }
        "xml-utils.defaultContentTypeFor" => optional(default_content_type_for(
            text,
            &required::<String>(args, "ext")?,
        )),
        "xml-utils.attributeOf" => optional(attribute_of(text, &required::<String>(args, "name")?)),
        "xml-utils.rootPrefixOf" => value(root_prefix_of(text, &required::<String>(args, "ns")?)?),
        "xml-utils.elementRange" => {
            let name = required::<String>(args, "name")?;
            let from: Option<f64> = arg(args, "from")?;
            // `regex.lastIndex = from`: a negative index reads as 0, one past the end fails
            let from = from.unwrap_or(0.0).max(0.0) as usize;
            let range = match byte_at_utf16(text, from) {
                Some(from) => element_range(text, &name, from)?,
                None => None,
            };
            let map = Utf16Map::new(text);
            value(range.map(|range| WireRange {
                start: map.to_utf16(range.start),
                end: map.to_utf16(range.end),
                content_start: map.to_utf16(range.content_start),
                content_end: map.to_utf16(range.content_end),
            }))
        }
        "xml-utils.cSldNameOf" => optional(c_sld_name_of(text)),
        "xml-utils.withRelationshipIds" => {
            let names: Vec<String> = required(args, "names")?;
            let ids: serde_json::Map<String, Value> = required(args, "ids")?;
            let mut map = jscompat::JsMap::new();
            for (key, to) in &ids {
                map.set(
                    key.clone(),
                    to.as_str()
                        .ok_or("ids: a value is not a string")?
                        .to_owned(),
                );
            }
            let names: Vec<&str> = names.iter().map(String::as_str).collect();
            value(with_relationship_ids(text, &names, &map))
        }
        "slide-ids.nextSlideId" => value(next_slide_id(text).map_err(|error| error.to_string())?),
        "slide-ids.canListSlide" => {
            let absent: Option<bool> = arg(args, "absent")?;
            value(can_list_slide((absent != Some(true)).then_some(text)))
        }
        "slide-ids.withSlideListed" => {
            let after_rid: Option<String> = arg(args, "afterRid")?;
            value(
                with_slide_listed(
                    text,
                    &required::<String>(args, "rid")?,
                    after_rid.as_deref(),
                )
                .map_err(|error| error.to_string())?,
            )
        }
        "slide-ids.withSlideUnlisted" => {
            value(with_slide_unlisted(text, &required::<String>(args, "rid")?))
        }
        "named-action.namedActionOf" => {
            let nullish: Option<String> = arg(args, "nullish")?;
            value(named_action_of(nullish.is_none().then_some(text)))
        }
        "named-action.namedActionAttr" => value(named_action_attr(text)),
        "table-grid.tableRowGridCols" => {
            let row: Vec<GridCell> = required(args, "row")?;
            value(
                table_row_grid_cols(&row)
                    .into_iter()
                    .map(JsNum)
                    .collect::<Vec<_>>(),
            )
        }
        "crc32.crc32" => {
            let bytes: Option<Vec<u8>> = arg(args, "bytes")?;
            value(crc32(bytes.as_deref().unwrap_or(text.as_bytes())))
        }
        _ => Err(format!("unknown function {function}")),
    }
}
