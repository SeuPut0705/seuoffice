//! `fields.<name>`: parse-fields.ts, eq-field.ts, parse-sdt.ts and
//! field-balance.ts. Offsets cross as UTF-16 code units.

use docx_engine::resolve::{ResolveCompat, ResolveCtx};
use docx_engine::sdt::{SdtChainLevel, SdtRange, SdtShell};
use docx_engine::styles::StyleInfo;
use docx_engine::{eq_field, field_balance, fields, sdt};
use jscompat::{JsMap, JsNum};
use ooxml_xml::{Utf16Map, XNode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Returned, arg, optional, required, value};

/// What a built style carries over the wire: `tocLevelOf` reads the name only.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StyleArg {
    #[serde(default)]
    style_id: String,
    name: String,
}

fn style_of(style: StyleArg) -> StyleInfo {
    StyleInfo {
        style_id: style.style_id,
        name: style.name,
        kind: "paragraph",
        heading_level: None,
        heading_outline_off: None,
        based_on: None,
        semi_hidden: None,
        q_format: None,
        ui_priority: None,
        unhide_when_used: None,
        custom: None,
        display: None,
        table_display: None,
        num_pr: None,
        is_default: None,
        heading_level_inherited: None,
        linked_char_shell: None,
    }
}

/// What a context carries over the wire: `additiveSpacingOf` reads its compat only.
#[derive(Deserialize)]
struct CtxArg {
    compat: ResolveCompat,
}

/// An `XNode` as fast-xml-parser builds it with `preserveOrder`, its
/// attributes as `[name, value]` pairs so their order is compared.
pub(super) fn node_json(node: &XNode) -> Value {
    let mut object = Map::new();
    match node {
        XNode::Text(text) => {
            object.insert("#text".to_owned(), Value::String(text.clone()));
        }
        XNode::Element(element) => {
            object.insert(
                element.name.clone(),
                Value::Array(element.children.iter().map(node_json).collect()),
            );
            if !element.attrs.is_empty() {
                let attrs = element
                    .attrs
                    .iter()
                    .map(|(key, value)| {
                        Value::Array(vec![
                            Value::String(key.clone()),
                            Value::String(value.clone()),
                        ])
                    })
                    .collect();
                object.insert(":@".to_owned(), Value::Array(attrs));
            }
        }
    }
    Value::Object(object)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Range16 {
    open_start: u32,
    open_end: u32,
    close_start: u32,
    close_end: u32,
}

fn range16(range: &SdtRange, map: &Utf16Map<'_>) -> Range16 {
    Range16 {
        open_start: map.to_utf16(range.open_start),
        open_end: map.to_utf16(range.open_end),
        close_start: map.to_utf16(range.close_start),
        close_end: map.to_utf16(range.close_end),
    }
}

#[derive(Serialize)]
struct Level16<'a> {
    #[serde(flatten)]
    range: Range16,
    shell: &'a SdtShell,
}

fn chain16<'a>(chain: &'a [SdtChainLevel], map: &Utf16Map<'_>) -> Vec<Level16<'a>> {
    chain
        .iter()
        .map(|level| Level16 {
            range: range16(&level.range, map),
            shell: &level.shell,
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Block16<'a> {
    shell: &'a SdtShell,
    p_xml: &'a str,
    chain: Vec<Level16<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Part16<'a> {
    name: &'a str,
    start: u32,
    end: u32,
    child_start: u32,
    child_end: u32,
    chain: Vec<Level16<'a>>,
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "rPrNodeOf" => optional(fields::r_pr_node_of(text).as_ref().map(node_json)),
        "tocLevelOf" => {
            let styles = arg::<Vec<(String, StyleArg)>>(args, "styles")?.map(|entries| {
                let mut styles = JsMap::new();
                for (id, style) in entries {
                    styles.set(id, style_of(style));
                }
                styles
            });
            value(fields::toc_level_of(text, styles.as_ref()).map(JsNum))
        }
        "tagAttr" => {
            let tag: String = required(args, "tag")?;
            let name: String = required(args, "name")?;
            optional(fields::tag_attr(text, &tag, &name).map_err(|error| error.to_string())?)
        }
        "directParaGeometry" => value(fields::direct_para_geometry(&required(args, "eff")?)),
        "directLineOf" => value(fields::direct_line_of(&required(args, "eff")?)),
        "additiveSpacingOf" => {
            let ctx: CtxArg = required(args, "ctx")?;
            value(fields::additive_spacing_of(&ResolveCtx {
                compat: ctx.compat,
                ..ResolveCtx::default()
            }))
        }
        "fieldStackAfter" => {
            let stack: Vec<bool> = required(args, "stack")?;
            value(fields::field_stack_after(text, &stack))
        }
        "markInsideFieldCode" => {
            let stack: Vec<bool> = required(args, "stack")?;
            value(fields::mark_inside_field_code(&stack))
        }
        "loneFieldEnd" => value(fields::lone_field_end(text)),
        "fieldLabel" => value(fields::field_label(text)),
        "eqFieldToOmml" => value(eq_field::eq_field_to_omml(text)),
        "inlineEqFieldResults" => value(eq_field::inline_eq_field_results(text)),
        "sdtRanges" => {
            let map = Utf16Map::new(text);
            let ranges: Vec<Range16> = sdt::sdt_ranges(text)
                .map_err(|limit| limit.to_string())?
                .iter()
                .map(|range| range16(range, &map))
                .collect();
            value(ranges)
        }
        "parseSdtBlock" => {
            let map = Utf16Map::new(text);
            let block = sdt::parse_sdt_block(text).map_err(|limit| limit.to_string())?;
            value(block.as_ref().map(|block| Block16 {
                shell: &block.shell,
                p_xml: &block.p_xml,
                chain: chain16(&block.chain, &map),
            }))
        }
        "sdtMeta" => value(sdt::sdt_meta(text)),
        "splitSdtParts" => {
            let map = Utf16Map::new(text);
            let parts = sdt::split_sdt_parts(text).map_err(|limit| limit.to_string())?;
            value(parts.as_ref().map(|parts| {
                parts
                    .iter()
                    .map(|part| Part16 {
                        name: &part.name,
                        start: map.to_utf16(part.start),
                        end: map.to_utf16(part.end),
                        child_start: map.to_utf16(part.child_start),
                        child_end: map.to_utf16(part.child_end),
                        chain: chain16(&part.chain, &map),
                    })
                    .collect::<Vec<_>>()
            }))
        }
        "sdtTableXml" => value(sdt::sdt_table_xml(text)),
        "balanceFieldChars" => value(field_balance::balance_field_chars(text)),
        _ => Err(format!("unknown function {function}")),
    }
}
