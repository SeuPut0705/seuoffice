//! scan.ts, xml-utils.ts, slide-ids.ts, named-action.ts, table-grid.ts and
//! crc32.ts of the slides engine, called as `<module>.<TypeScript name>`.

use jscompat::JsNum;
use ooxml_xml::Utf16Map;
use pptx_engine::crc32::crc32;
use pptx_engine::named_action::{named_action_attr, named_action_of};
use pptx_engine::scan::scan_slide;
use pptx_engine::slide_ids::next_slide_id;
use pptx_engine::table_grid::{GridCell, table_row_grid_cols};
use pptx_engine::xml_utils::{
    as_xml_node, creation_id_ext_xml, creation_id_xml, decode_numeric_char_refs, escape_xml_attr,
    escape_xml_text, has_content_type_override, has_default_for, max_relationship_id_number,
    xml_array,
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
        "xml-utils.decodeNumericCharRefs" => value(decode_numeric_char_refs(text)),
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
        "xml-utils.hasDefaultFor" => value(
            has_default_for(text, &required::<String>(args, "ext")?)
                .map_err(|error| error.to_string())?,
        ),
        "slide-ids.nextSlideId" => value(next_slide_id(text).map_err(|error| error.to_string())?),
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
