//! `packages/ai-provider/src/protocols/gemini-schema.ts`: JSON Schema to the
//! Gemini `Schema` proto for function declarations.
//!
//! Tool `inputSchema`s are JSON Schema; Gemini's `FunctionDeclaration.parameters`
//! is an OpenAPI-3.0-subset protobuf, and the API front end rejects the whole
//! request with `HTTP 400` when it meets anything the proto lacks (type
//! unions, `$ref`, `const`, `additionalProperties`, a non-string `enum`, a
//! tuple `items`, an array without `items`). The schema is data from a tool
//! definition, so it is a [`JsonValue`] and every object keeps its key order.

use jscompat::JsonValue;

use super::jsval::{Obj, js_string_checked, object, text, without};
use super::task::JsError;

/// `GEMINI_SCHEMA_KEYS`: fields the Gemini `Schema` proto knows; anything
/// else is dropped.
const GEMINI_SCHEMA_KEYS: [&str; 22] = [
    "type",
    "format",
    "title",
    "description",
    "nullable",
    "enum",
    "items",
    "properties",
    "required",
    "anyOf",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "minProperties",
    "maxProperties",
    "pattern",
    "default",
    "example",
    "propertyOrdering",
];

/// `MAX_DEPTH`: recursion guard for pathological `$ref` cycles.
const MAX_DEPTH: usize = 32;

/// Where `resolveRef` stands: on a value of the schema, or on
/// `Object.prototype`, which `'__proto__' in node` reaches and which has no
/// enumerable key.
#[derive(Clone, Copy)]
enum Node<'a> {
    Value(&'a JsonValue),
    ObjectPrototype,
}

/// `resolveRef(root, ref)`: a local JSON pointer (`#/definitions/x`,
/// `#/$defs/x/items`) against the root.
fn resolve_ref(root: &JsonValue, reference: &str) -> Option<Obj> {
    let path = reference.strip_prefix("#/")?;
    let mut node = Node::Value(root);
    for raw in path.split('/') {
        let key = raw.replace("~1", "/").replace("~0", "~");
        node = match node {
            Node::Value(JsonValue::Object(object)) => match object.get(&key) {
                Some(child) => Node::Value(child),
                None if key == "__proto__" => Node::ObjectPrototype,
                // `key in node` is also true for a method of Object.prototype, and a
                // function is no schema; any other key is not there
                None => return None,
            },
            // the keys of Object.prototype are methods, and its own `__proto__` is null
            Node::ObjectPrototype | Node::Value(_) => return None,
        };
    }
    match node {
        Node::Value(JsonValue::Object(object)) => Some(object.clone()),
        Node::ObjectPrototype => Some(Obj::new()),
        Node::Value(_) => None,
    }
}

fn is_array(value: Option<&JsonValue>) -> bool {
    matches!(value, Some(JsonValue::Array(_)))
}

/// `convert(schema, root, depth, refStack)`
fn convert(
    schema: Option<&JsonValue>,
    root: &JsonValue,
    depth: usize,
    ref_stack: &[String],
) -> Result<Obj, JsError> {
    // JSON Schema allows `true` / `false` / missing sub-schemas; Gemini wants an object
    let Some(JsonValue::Object(schema)) = schema else {
        return Ok(Obj::new());
    };
    if depth > MAX_DEPTH {
        return Ok(Obj::new());
    }

    if let Some(JsonValue::String(reference)) = schema.get("$ref") {
        let target = if ref_stack.iter().any(|seen| seen == reference) {
            None
        } else {
            resolve_ref(root, reference)
        };
        let Some(target) = target else {
            return Ok(Obj::new());
        };
        // sibling keywords (usually a `description`) override the referenced schema
        let mut merged = Obj::new();
        for (key, value) in target.entries() {
            merged.set(key, value.clone());
        }
        for (key, value) in schema.entries() {
            if key != "$ref" {
                merged.set(key, value.clone());
            }
        }
        let mut stack = ref_stack.to_vec();
        stack.push(reference.clone());
        return convert(Some(&JsonValue::Object(merged)), root, depth + 1, &stack);
    }

    let mut out = Obj::new();
    for (key, value) in schema.entries() {
        if GEMINI_SCHEMA_KEYS.contains(&key) {
            out.set(key, value.clone());
        }
    }

    // `type: [...]` -> single `type` (+ `nullable`), or `anyOf` when several remain
    if let Some(JsonValue::Array(listed)) = schema.get("type") {
        let types: Vec<&str> = listed
            .iter()
            .filter_map(|t| match t {
                JsonValue::String(s) => Some(s.as_str()),
                _ => None,
            })
            .collect();
        let non_null: Vec<&str> = types.iter().copied().filter(|t| *t != "null").collect();
        if types.len() != non_null.len() {
            out.set("nullable", JsonValue::Bool(true));
        }
        if non_null.len() == 1 {
            out.set("type", text(non_null[0]));
        } else {
            out = without(&out, &["type"]);
            if non_null.len() > 1 && !is_array(schema.get("anyOf")) {
                out.set(
                    "anyOf",
                    JsonValue::Array(
                        non_null
                            .iter()
                            .map(|t| object(vec![("type", text(*t))]))
                            .collect(),
                    ),
                );
            }
        }
    }

    // `oneOf` has the same meaning for tool calling; only `anyOf` is in the proto
    if let Some(one_of @ JsonValue::Array(_)) = schema.get("oneOf")
        && !is_array(out.get("anyOf"))
    {
        out.set("anyOf", one_of.clone());
    }
    // `const` -> single-member enum
    if let Some(constant) = schema.get("const")
        && !is_array(out.get("enum"))
    {
        out.set("enum", JsonValue::Array(vec![constant.clone()]));
    }
    let stringified = match out.get("enum") {
        Some(JsonValue::Array(members)) => Some(
            members
                .iter()
                .map(|v| js_string_checked(v).map(text))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| JsError::type_error(e.0))?,
        ),
        _ => None,
    };
    if let Some(members) = stringified {
        out.set("enum", JsonValue::Array(members));
    }

    let properties = match out.get("properties") {
        Some(JsonValue::Object(properties)) => {
            let mut converted = Obj::new();
            for (name, sub) in properties.entries() {
                converted.set(
                    name,
                    JsonValue::Object(convert(Some(sub), root, depth + 1, ref_stack)?),
                );
            }
            Some(converted)
        }
        _ => None,
    };
    if let Some(properties) = properties {
        out.set("properties", JsonValue::Object(properties));
    }

    if let Some(items) = out.get("items").cloned() {
        // draft-07 tuple form `items: [a, b]` -> one schema accepting either
        let converted = match &items {
            JsonValue::Array(tuple) => {
                let mut any_of = Vec::new();
                for sub in tuple {
                    any_of.push(JsonValue::Object(convert(
                        Some(sub),
                        root,
                        depth + 1,
                        ref_stack,
                    )?));
                }
                object(vec![("anyOf", JsonValue::Array(any_of))])
            }
            single => JsonValue::Object(convert(Some(single), root, depth + 1, ref_stack)?),
        };
        out.set("items", converted);
    } else if matches!(out.get("type"), Some(JsonValue::String(t)) if t == "array") {
        // The proto has no optional-`items` array; the API refuses the whole
        // request without one. Fill in the schema it documents as accepting.
        out.set("items", object(vec![("type", text("object"))]));
    }
    let any_of = match out.get("anyOf") {
        Some(JsonValue::Array(alternatives)) => {
            let mut converted = Vec::new();
            for sub in alternatives {
                converted.push(JsonValue::Object(convert(
                    Some(sub),
                    root,
                    depth + 1,
                    ref_stack,
                )?));
            }
            Some(converted)
        }
        _ => None,
    };
    if let Some(converted) = any_of {
        out.set("anyOf", JsonValue::Array(converted));
    }
    Ok(out)
}

/// `toGeminiSchema(inputSchema)`: a tool's JSON Schema `inputSchema` as a
/// Gemini function-declaration `parameters` schema. Lossy where the proto has
/// no equivalent (dropped keywords only ever make the schema more
/// permissive). `None` is an `inputSchema` that is not there.
///
/// Where the TypeScript says it never throws, one input still does: an `enum`
/// member that is an object with its own `toString` key, which `String(v)`
/// cannot convert (`TypeError`).
pub fn to_gemini_schema(input_schema: Option<&JsonValue>) -> Result<Obj, JsError> {
    convert(
        input_schema,
        input_schema.unwrap_or(&JsonValue::Null),
        0,
        &[],
    )
}
