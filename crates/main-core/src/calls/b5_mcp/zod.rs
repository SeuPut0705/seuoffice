//! node_modules/zod 4.6.7: the schema builders the MCP tools use, `toJSONSchema` as the MCP SDK calls it, `safeParse` and its issues.
//! Group `b5-mcp`, slice `zod`: see tools/main-diff/groups/b5-mcp/zod.ts.
//!
//! A schema in a case is the descriptor `[base, ...modifiers]` the spec describes; `zod_of` and
//! `shape_of` build the schema and the raw shape from it, for this slice and the others.
//!
//! - `zod.toJsonSchema(shape)`: the `inputSchema` the SDK lists for the shape.
//! - `zod.safeParse(shape, input)`: `{ success: true, data }` or
//!   `{ success: false, issues: [{ message, path }], message }` with the SDK's `getParseErrorMessage`.

use jscompat::{json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value};

use super::super::{Answer, CallError, Context};
use crate::packages::zod::{ZodShape, ZodType, parse_error_message, safe_parse, to_json_schema, z};

/// a descriptor that is not one is a bug of the spec, not an answer
fn malformed(what: &str) -> ! {
    panic!("malformed zod descriptor: {what}")
}

/// the operand of a compound base
fn operand<'a>(parts: &'a [Value], index: usize, kind: &str) -> &'a Value {
    let Some(operand) = parts.get(index) else {
        malformed(kind);
    };
    operand
}

fn base_of(base: &Value) -> ZodType {
    if let Some(name) = base.as_str() {
        return match name {
            "string" => z::string(),
            "number" => z::number(),
            "boolean" => z::boolean(),
            "null" => z::null(),
            "any" => z::any(),
            "unknown" => z::unknown(),
            other => malformed(other),
        };
    }
    let Some(parts) = base.as_array() else {
        malformed("a base is a name or an array");
    };
    let Some(kind) = parts.first().and_then(Value::as_str) else {
        malformed("a base array starts with its kind");
    };
    match kind {
        "enum" => {
            let Some(values) = operand(parts, 1, kind).as_array() else {
                malformed("enum values");
            };
            let values: Vec<&str> = values
                .iter()
                .map(|value| {
                    let Some(value) = value.as_str() else {
                        malformed("an enum value is a string");
                    };
                    value
                })
                .collect();
            z::enum_(&values)
        }
        "array" => z::array(zod_of(operand(parts, 1, kind))),
        "object" => z::object(shape_of(operand(parts, 1, kind))),
        "looseObject" => z::loose_object(shape_of(operand(parts, 1, kind))),
        "record" => z::record(
            zod_of(operand(parts, 1, kind)),
            zod_of(operand(parts, 2, kind)),
        ),
        "union" => {
            let Some(options) = operand(parts, 1, kind).as_array() else {
                malformed("union options");
            };
            z::union(options.iter().map(zod_of).collect())
        }
        other => malformed(other),
    }
}

/// the schema a descriptor `[base, ...modifiers]` names
pub(super) fn zod_of(desc: &Value) -> ZodType {
    let Some(parts) = desc.as_array() else {
        malformed("a descriptor is an array");
    };
    let Some((base, modifiers)) = parts.split_first() else {
        malformed("a descriptor has a base");
    };
    let mut schema = base_of(base);
    for modifier in modifiers {
        let Some(modifier) = modifier.as_array() else {
            malformed("a modifier is an array");
        };
        let name = modifier.first().and_then(Value::as_str);
        let number = || {
            let Some(number) = modifier.get(1).and_then(Value::as_f64) else {
                malformed("min and max take a number");
            };
            number
        };
        schema = match name {
            Some("optional") => schema.optional(),
            Some("describe") => {
                let Some(text) = modifier.get(1).and_then(Value::as_str) else {
                    malformed("describe takes a text");
                };
                schema.describe(text)
            }
            Some("int") => schema.int(),
            Some("min") => schema.min(number()),
            Some("max") => schema.max(number()),
            _ => malformed("a modifier is optional, describe, int, min or max"),
        };
    }
    schema
}

/// the raw shape a descriptor `[[key, desc], ...]` names, its keys in that order
pub(super) fn shape_of(shape: &Value) -> ZodShape {
    let Some(entries) = shape.as_array() else {
        malformed("a shape is an array");
    };
    entries
        .iter()
        .map(|entry| {
            let Some([key, desc]) = entry.as_array().map(Vec::as_slice) else {
                malformed("a shape entry is [key, desc]");
            };
            let Some(key) = key.as_str() else {
                malformed("a shape key is a string");
            };
            (key.to_owned(), zod_of(desc))
        })
        .collect()
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let _ = cx;
    let shape_arg = |index: usize| {
        args.get(index)
            .ok_or_else(|| CallError::plain(format!("argument {index} is missing")))
    };
    Some(match name {
        "zod.toJsonSchema" => shape_arg(0).map(|shape| {
            let schema = to_json_schema(&shape_of(shape));
            Some(json_value_to_serde(&schema))
        }),
        "zod.safeParse" => shape_arg(0).and_then(|shape| {
            let input = shape_arg(1)?;
            let answer = match safe_parse(&shape_of(shape), &json_value_from_serde(input)) {
                Ok(data) => object(vec![
                    ("success", Value::Bool(true)),
                    ("data", json_value_to_serde(&data)),
                ]),
                Err(issues) => {
                    let listed = issues
                        .iter()
                        .map(|issue| {
                            object(vec![
                                ("message", Value::String(issue.message.clone())),
                                (
                                    "path",
                                    Value::Array(
                                        issue.path.iter().map(json_value_to_serde).collect(),
                                    ),
                                ),
                            ])
                        })
                        .collect();
                    object(vec![
                        ("success", Value::Bool(false)),
                        ("issues", Value::Array(listed)),
                        ("message", Value::String(parse_error_message(&issues))),
                    ])
                }
            };
            Ok(Some(answer))
        }),
        _ => return None,
    })
}
