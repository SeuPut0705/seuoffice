//! node_modules/zod 4.6.7: the schema builders the MCP tools use, `toJSONSchema` as the MCP SDK calls it, `safeParse` and its issues.
//!
//! What the shell writes as `{ offset: z.number().int().min(0).optional().describe('...') }`
//! is written here as `z::shape(vec![("offset", z::number().int().min(0.0).optional().describe("..."))])`.
//! The chain keeps zod's order: `describe` and `optional` return a new schema, so
//! `describe(..).optional()` and `optional().describe(..)` differ in what the listing shows.
//!
//! Two operations stand on it, both as `@modelcontextprotocol/sdk` 1.32.1 runs them for a tool whose
//! `inputSchema` is a raw shape (`objectFromShape` makes `z4mini.object(shape)` of it):
//!
//! - [`to_json_schema`]: what `tools/list` answers,
//!   `z4mini.toJSONSchema(object, { target: 'draft-7', io: 'input' })`. The key order is
//!   the one zod writes: a schema's own keywords, then its `description`; an `optional`
//!   wrapper puts its own `description` first and the wrapped schema's keywords after it; a
//!   union of bare types is rewritten to a `type` array after its own `description`.
//! - [`safe_parse`]: `safeParseAsync(object, args)` of `validateToolInput`. The asynchronous
//!   parse takes the interpreted object path (no generated fast path): unknown keys are
//!   stripped by `z::object` and kept by `z::loose_object`, the output keys follow the
//!   shape, then the unknown keys in the order JavaScript lists them, and the issues carry
//!   zod's English messages. [`parse_error_message`] is the SDK's `getParseErrorMessage`.
//!
//! What the port does not cover, because no tool shape reaches it: `undefined` as an input value (JSON
//! has none), a shape key that names a property of `Object.prototype` (JavaScript reads it
//! through the prototype), and the schema types the shell never builds (literals, tuples,
//! defaults, nullable, transforms, strict objects, string checks). A chain method a type lacks
//! (`z::string().int()`) panics, where zod throws a `TypeError` while the tool is declared.

use jscompat::{JsObject, JsonValue, number_to_string, to_number};

type Obj = JsObject<JsonValue>;

const MIN_SAFE_INTEGER: f64 = -9_007_199_254_740_991.0;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
/// `regexes.number.source` and `regexes.integer.source`
const NUMBER_PATTERN: &str = r"^-?\d+(?:\.\d+)?$";
const INTEGER_PATTERN: &str = r"^-?\d+$";

/// one schema node: what its `def` holds, and the description registered for it
#[derive(Debug, Clone)]
pub struct ZodType {
    kind: Kind,
    /// the text of the last `describe`, kept by the clones a later `int`, `min` or `max` makes
    description: Option<String>,
}

/// a `ZodRawShape`: the keys in the order the object literal wrote them
pub type ZodShape = Vec<(String, ZodType)>;

#[derive(Debug, Clone)]
enum Kind {
    String,
    Number(Vec<Check>),
    Boolean,
    Null,
    Any,
    Unknown,
    /// `getEnumValues(entries)`: the values as the entries object lists them
    Enum(Vec<String>),
    Array {
        element: Box<ZodType>,
        checks: Vec<Check>,
    },
    Object {
        shape: ZodShape,
        loose: bool,
    },
    Record {
        key: Box<ZodType>,
        value: Box<ZodType>,
    },
    Union(Vec<ZodType>),
    Optional(Box<ZodType>),
}

/// a check of `def.checks`, in the order the chain added them
#[derive(Debug, Clone, Copy)]
enum Check {
    /// `.int()`: the `safeint` number format
    Int,
    /// `.min(n)`: `gte` on a number, `min_length` on an array
    Min(f64),
    /// `.max(n)`: `lte` on a number, `max_length` on an array
    Max(f64),
}

impl ZodType {
    fn new(kind: Kind) -> ZodType {
        ZodType {
            kind,
            description: None,
        }
    }

    /// `schema.optional()`
    pub fn optional(self) -> ZodType {
        ZodType::new(Kind::Optional(Box::new(self)))
    }

    /// `schema.describe(text)`
    pub fn describe(mut self, text: &str) -> ZodType {
        self.description = Some(text.to_owned());
        self
    }

    /// `schema.int()` of a number
    pub fn int(self) -> ZodType {
        self.with_check("int", Check::Int)
    }

    /// `schema.min(n)` of a number or an array
    pub fn min(self, n: f64) -> ZodType {
        self.with_check("min", Check::Min(n))
    }

    /// `schema.max(n)` of a number or an array
    pub fn max(self, n: f64) -> ZodType {
        self.with_check("max", Check::Max(n))
    }

    fn with_check(mut self, method: &str, check: Check) -> ZodType {
        let allowed = match &mut self.kind {
            Kind::Number(checks) => {
                checks.push(check);
                true
            }
            Kind::Array { checks, .. } if !matches!(check, Check::Int) => {
                checks.push(check);
                true
            }
            _ => false,
        };
        if !allowed {
            panic!("TypeError: schema.{method} is not a function");
        }
        self
    }
}

/// the builders, named as zod's `z`
pub mod z {
    use super::{Kind, ZodShape, ZodType};
    use jscompat::JsObject;

    pub fn string() -> ZodType {
        ZodType::new(Kind::String)
    }

    pub fn number() -> ZodType {
        ZodType::new(Kind::Number(Vec::new()))
    }

    pub fn boolean() -> ZodType {
        ZodType::new(Kind::Boolean)
    }

    pub fn null() -> ZodType {
        ZodType::new(Kind::Null)
    }

    pub fn any() -> ZodType {
        ZodType::new(Kind::Any)
    }

    pub fn unknown() -> ZodType {
        ZodType::new(Kind::Unknown)
    }

    /// `z.enum(values)`: the entries object `Object.fromEntries(values.map(v => [v, v]))`
    /// drops repeated values and lists the integer-like ones first
    pub fn enum_(values: &[&str]) -> ZodType {
        let mut entries: JsObject<()> = JsObject::new();
        for value in values {
            entries.set(*value, ());
        }
        let values = entries
            .entries()
            .into_iter()
            .map(|(key, _)| key.to_owned())
            .collect();
        ZodType::new(Kind::Enum(values))
    }

    pub fn array(item: ZodType) -> ZodType {
        ZodType::new(Kind::Array {
            element: Box::new(item),
            checks: Vec::new(),
        })
    }

    /// `z.object(shape)`: unknown keys are stripped
    pub fn object(shape: ZodShape) -> ZodType {
        ZodType::new(Kind::Object {
            shape,
            loose: false,
        })
    }

    /// `z.looseObject(shape)`: unknown keys are kept
    pub fn loose_object(shape: ZodShape) -> ZodType {
        ZodType::new(Kind::Object { shape, loose: true })
    }

    pub fn record(key: ZodType, value: ZodType) -> ZodType {
        ZodType::new(Kind::Record {
            key: Box::new(key),
            value: Box::new(value),
        })
    }

    pub fn union(options: Vec<ZodType>) -> ZodType {
        ZodType::new(Kind::Union(options))
    }

    /// a `ZodRawShape` from its entries
    pub fn shape(entries: Vec<(&str, ZodType)>) -> ZodShape {
        entries
            .into_iter()
            .map(|(key, schema)| (key.to_owned(), schema))
            .collect()
    }
}

/// `Object.keys(shape)` with the fields: `out[key] = schema` keeps the place of a key set before
/// and lists the integer-like keys first
fn ordered(shape: &ZodShape) -> Vec<(String, &ZodType)> {
    let mut object: JsObject<&ZodType> = JsObject::new();
    for (key, schema) in shape {
        object.set(key.clone(), schema);
    }
    object
        .entries()
        .into_iter()
        .map(|(key, schema)| (key.to_owned(), *schema))
        .collect()
}

/// `schema._zod.optin !== undefined`, which is `optout === "optional"` for every type here: only
/// `optional` and a union holding one leave a key out
fn optional_in(schema: &ZodType) -> bool {
    match &schema.kind {
        Kind::Optional(_) => true,
        Kind::Union(options) => options.iter().any(optional_in),
        _ => false,
    }
}

/// `schema._zod.values`, as the strings it holds: `None` where the schema declares no values
fn values_of(schema: &ZodType) -> Option<Vec<String>> {
    match &schema.kind {
        Kind::Null => Some(Vec::new()),
        Kind::Enum(values) => Some(values.clone()),
        Kind::Optional(inner) => values_of(inner),
        Kind::Union(options) => {
            let mut all: Vec<String> = Vec::new();
            for option in options {
                for value in values_of(option)? {
                    if !all.contains(&value) {
                        all.push(value);
                    }
                }
            }
            Some(all)
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// toJSONSchema
// ---------------------------------------------------------------------------

fn text(value: &str) -> JsonValue {
    JsonValue::String(value.to_owned())
}

/// `narrowMin`
fn narrow_min(aggregate: &mut Option<f64>, value: f64) {
    if (*aggregate).is_none_or(|current| value > current) {
        *aggregate = Some(value);
    }
}

/// `narrowMax`
fn narrow_max(aggregate: &mut Option<f64>, value: f64) {
    if (*aggregate).is_none_or(|current| value < current) {
        *aggregate = Some(value);
    }
}

/// the JSON Schema of one schema, as `finalize` leaves it: its own keywords, `description`, and the
/// union rewrite. `optional` has no keywords of its own: the schema it wraps shows through.
fn node_json(schema: &ZodType) -> Obj {
    let mut json = Obj::new();
    match &schema.kind {
        Kind::Optional(inner) => {
            if let Some(description) = &schema.description {
                json.set("description", text(description));
            }
            let wrapped = node_json(inner);
            for (key, value) in wrapped.entries() {
                if json.get(key).is_none() {
                    json.set(key, value.clone());
                }
            }
            return json;
        }
        Kind::String => json.set("type", text("string")),
        Kind::Number(checks) => {
            let mut minimum: Option<f64> = None;
            let mut maximum: Option<f64> = None;
            let mut is_int = false;
            for check in checks {
                match check {
                    Check::Int => {
                        is_int = true;
                        narrow_min(&mut minimum, MIN_SAFE_INTEGER);
                        narrow_max(&mut maximum, MAX_SAFE_INTEGER);
                    }
                    Check::Min(value) => narrow_min(&mut minimum, *value),
                    Check::Max(value) => narrow_max(&mut maximum, *value),
                }
            }
            json.set("type", text(if is_int { "integer" } else { "number" }));
            if let Some(minimum) = minimum {
                json.set("minimum", JsonValue::Number(minimum));
            }
            if let Some(maximum) = maximum {
                json.set("maximum", JsonValue::Number(maximum));
            }
        }
        Kind::Boolean => json.set("type", text("boolean")),
        Kind::Null => json.set("type", text("null")),
        Kind::Any | Kind::Unknown => {}
        Kind::Enum(values) => {
            if values.is_empty() {
                json.set("not", JsonValue::Object(Obj::new()));
            } else {
                json.set("type", text("string"));
                json.set(
                    "enum",
                    JsonValue::Array(values.iter().map(|value| text(value)).collect()),
                );
            }
        }
        Kind::Array { element, checks } => {
            let mut minimum: Option<f64> = None;
            let mut maximum: Option<f64> = None;
            for check in checks {
                match check {
                    Check::Int => {}
                    Check::Min(value) => narrow_min(&mut minimum, *value),
                    Check::Max(value) => narrow_max(&mut maximum, *value),
                }
            }
            if let Some(minimum) = minimum {
                json.set("minItems", JsonValue::Number(minimum));
            }
            if let Some(maximum) = maximum {
                json.set("maxItems", JsonValue::Number(maximum));
            }
            json.set("type", text("array"));
            json.set("items", JsonValue::Object(node_json(element)));
        }
        Kind::Object { shape, loose } => json = object_json(shape, *loose),
        Kind::Record { key, value } => {
            json.set("type", text("object"));
            let mut names = node_json(key);
            if let Some(rewritten) = stringify_key_names(&names) {
                names = rewritten;
            }
            json.set("propertyNames", JsonValue::Object(names));
            json.set("additionalProperties", JsonValue::Object(node_json(value)));
            if !optional_in(value)
                && let Some(keys) = values_of(key)
                && !keys.is_empty()
            {
                json.set(
                    "required",
                    JsonValue::Array(keys.iter().map(|key| text(key)).collect()),
                );
            }
        }
        Kind::Union(options) => {
            json.set(
                "anyOf",
                JsonValue::Array(
                    options
                        .iter()
                        .map(|option| JsonValue::Object(node_json(option)))
                        .collect(),
                ),
            );
        }
    }
    if let Some(description) = &schema.description {
        json.set("description", text(description));
    }
    compact_type_union(&mut json);
    json
}

/// `objectProcessor` for `io: 'input'`: no `additionalProperties` unless the object is loose
fn object_json(shape: &ZodShape, loose: bool) -> Obj {
    let fields = ordered(shape);
    let mut json = Obj::new();
    json.set("type", text("object"));
    let mut properties = Obj::new();
    for (key, field) in &fields {
        properties.set(key.clone(), JsonValue::Object(node_json(field)));
    }
    json.set("properties", JsonValue::Object(properties));
    let required: Vec<JsonValue> = fields
        .iter()
        .filter(|(_, field)| !optional_in(field))
        .map(|(key, _)| text(key))
        .collect();
    if !required.is_empty() {
        json.set("required", JsonValue::Array(required));
    }
    if loose {
        json.set("additionalProperties", JsonValue::Object(Obj::new()));
    }
    json
}

/// `compactTypeUnion`: `anyOf` of bare `{ type }` branches becomes `type`, at the end of the keys
fn compact_type_union(json: &mut Obj) {
    if json.get("type").is_some() {
        return;
    }
    let Some(JsonValue::Array(options)) = json.get("anyOf") else {
        return;
    };
    if options.is_empty() {
        return;
    }
    let mut types: Vec<String> = Vec::new();
    for option in options {
        let JsonValue::Object(option) = option else {
            return;
        };
        let entries = option.entries();
        if entries.len() != 1 || entries[0].0 != "type" {
            return;
        }
        let members: Vec<&JsonValue> = match entries[0].1 {
            JsonValue::Array(members) => members.iter().collect(),
            single => vec![single],
        };
        for member in members {
            let JsonValue::String(member) = member else {
                return;
            };
            if !types.contains(member) {
                types.push(member.clone());
            }
        }
    }
    let mut compacted = Obj::new();
    for (key, value) in json.entries() {
        if key != "anyOf" {
            compacted.set(key, value.clone());
        }
    }
    let type_value = if types.len() == 1 {
        text(&types[0])
    } else {
        JsonValue::Array(types.iter().map(|member| text(member)).collect())
    };
    compacted.set("type", type_value);
    *json = compacted;
}

/// `stringifyKeyNames`: a record key that is numeric becomes the string form a property name has.
/// `None` where the key schema stays as it is. A key schema here never carries `enum` or `const`
/// members that are numbers, so the branches for those do not exist.
fn stringify_key_names(json: &Obj) -> Option<Obj> {
    let mut rebuilt: Option<Obj> = None;
    for keyword in ["anyOf", "oneOf"] {
        let source = rebuilt.as_ref().unwrap_or(json);
        let Some(JsonValue::Array(branches)) = source.get(keyword) else {
            continue;
        };
        let mut mapped: Vec<JsonValue> = Vec::new();
        let mut changed = false;
        for branch in branches {
            match branch {
                JsonValue::Object(object) => match stringify_key_names(object) {
                    Some(replacement) => {
                        changed = true;
                        mapped.push(JsonValue::Object(replacement));
                    }
                    None => mapped.push(branch.clone()),
                },
                other => mapped.push(other.clone()),
            }
        }
        if changed {
            let mut next = source.clone();
            next.set(keyword, JsonValue::Array(mapped));
            rebuilt = Some(next);
        }
    }
    let current = rebuilt.as_ref().unwrap_or(json);
    let types: Vec<&JsonValue> = match current.get("type") {
        Some(JsonValue::Array(items)) => items.iter().collect(),
        Some(single) => vec![single],
        None => Vec::new(),
    };
    let has = |name: &str| {
        types
            .iter()
            .any(|member| matches!(member, JsonValue::String(member) if member == name))
    };
    if has("string") || !(has("number") || has("integer")) {
        return rebuilt;
    }
    let pattern = if has("number") {
        NUMBER_PATTERN
    } else {
        INTEGER_PATTERN
    };
    let mut rest = Obj::new();
    for (key, value) in current.entries() {
        if matches!(
            key,
            "minimum"
                | "maximum"
                | "exclusiveMinimum"
                | "exclusiveMaximum"
                | "multipleOf"
                | "format"
                | "id"
        ) {
            continue;
        }
        rest.set(key, value.clone());
    }
    rest.set("type", text("string"));
    rest.set("pattern", text(pattern));
    Some(rest)
}

/// the JSON Schema `McpServer` lists for a tool whose `inputSchema` is `shape`
/// (`z4mini.toJSONSchema(z.object(shape), { target: 'draft-7', io: 'input' })`)
pub fn to_json_schema(shape: &ZodShape) -> JsonValue {
    let mut result = Obj::new();
    result.set("$schema", text("http://json-schema.org/draft-07/schema#"));
    let object = object_json(shape, false);
    for (key, value) in object.entries() {
        result.set(key, value.clone());
    }
    JsonValue::Object(result)
}

// ---------------------------------------------------------------------------
// safeParse
// ---------------------------------------------------------------------------

/// an issue as the parse pushes it: the message zod's English locale gives it, the path, and `continue`
struct Issue {
    message: String,
    path: Vec<JsonValue>,
    /// `issue.continue`: `Some(true)` lets the checks after it run, `Some(false)` stops them, `None` is unset
    cont: Option<bool>,
}

/// a payload: the value (`None` is `undefined`) and the issues so far
struct Parsed {
    value: Option<JsonValue>,
    issues: Vec<Issue>,
}

/// one issue of a failed parse
#[derive(Debug, Clone, PartialEq)]
pub struct ZodIssue {
    pub message: String,
    /// the keys (strings) and indexes (numbers) from the root to the value
    pub path: Vec<JsonValue>,
}

fn issue(message: String, cont: Option<bool>) -> Issue {
    Issue {
        message,
        path: Vec::new(),
        cont,
    }
}

fn pass(input: Option<&JsonValue>) -> Parsed {
    Parsed {
        value: input.cloned(),
        issues: Vec::new(),
    }
}

fn failed(issue: Issue) -> Parsed {
    Parsed {
        value: None,
        issues: vec![issue],
    }
}

/// `util.aborted(payload)`: some issue does not say `continue: true`
fn aborted(issues: &[Issue]) -> bool {
    issues.iter().any(|issue| issue.cont != Some(true))
}

/// `util.explicitlyAborted(payload)`: some issue says `continue: false`
fn explicitly_aborted(issues: &[Issue]) -> bool {
    issues.iter().any(|issue| issue.cont == Some(false))
}

/// `util.prefixIssues(key, issues)`
fn prefixed(key: &JsonValue, issues: Vec<Issue>) -> Vec<Issue> {
    issues
        .into_iter()
        .map(|mut issue| {
            issue.path.insert(0, key.clone());
            issue
        })
        .collect()
}

/// `getTypeName(util.parsedType(input), input)` of the English locale
fn received_name(input: Option<&JsonValue>) -> String {
    match input {
        None => "undefined".to_owned(),
        Some(JsonValue::Null) => "null".to_owned(),
        Some(JsonValue::Bool(_)) => "boolean".to_owned(),
        Some(JsonValue::Number(x)) if x.is_nan() => "NaN".to_owned(),
        Some(JsonValue::Number(x)) if !x.is_finite() => number_to_string(*x),
        Some(JsonValue::Number(_)) => "number".to_owned(),
        Some(JsonValue::String(_)) => "string".to_owned(),
        Some(JsonValue::Array(_)) => "array".to_owned(),
        Some(JsonValue::Object(_)) => "object".to_owned(),
    }
}

/// an `invalid_type` issue; `cont` is `Some(false)` for the integer check's
fn invalid_type(expected: &str, input: Option<&JsonValue>, cont: Option<bool>) -> Issue {
    issue(
        format!(
            "Invalid input: expected {expected}, received {}",
            received_name(input)
        ),
        cont,
    )
}

/// `util.stringifyPrimitive` of a string
fn quoted(value: &str) -> String {
    format!("\"{value}\"")
}

fn invalid_value(values: &[String]) -> Issue {
    if values.len() == 1 {
        return issue(
            format!("Invalid input: expected {}", quoted(&values[0])),
            None,
        );
    }
    let joined: Vec<String> = values.iter().map(|value| quoted(value)).collect();
    issue(
        format!("Invalid option: expected one of {}", joined.join("|")),
        None,
    )
}

/// `too_big` of a number (origin `number` or `int`) or an array, which count items
fn too_big(origin: &str, maximum: f64, cont: bool) -> Issue {
    let limit = number_to_string(maximum);
    let message = if origin == "array" {
        format!("Too big: expected array to have <={limit} items")
    } else {
        format!("Too big: expected {origin} to be <={limit}")
    };
    issue(message, Some(cont))
}

/// `too_small`, as `too_big`
fn too_small(origin: &str, minimum: f64, cont: bool) -> Issue {
    let limit = number_to_string(minimum);
    let message = if origin == "array" {
        format!("Too small: expected array to have >={limit} items")
    } else {
        format!("Too small: expected {origin} to be >={limit}")
    };
    issue(message, Some(cont))
}

fn invalid_key(key: &str) -> Issue {
    Issue {
        message: "Invalid key in record".to_owned(),
        path: vec![text(key)],
        cont: None,
    }
}

fn unrecognized_keys(keys: &[String]) -> Issue {
    let joined: Vec<String> = keys.iter().map(|key| quoted(key)).collect();
    issue(
        format!(
            "Unrecognized key{}: {}",
            if keys.len() > 1 { "s" } else { "" },
            joined.join(", ")
        ),
        Some(true),
    )
}

/// `Number.isInteger`
fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// the number checks of `runChecks`: each runs unless an earlier issue stopped them
fn run_number_checks(x: f64, checks: &[Check]) -> Vec<Issue> {
    let mut issues: Vec<Issue> = Vec::new();
    let mut stopped = false;
    for check in checks {
        if stopped {
            continue;
        }
        let start = issues.len();
        match check {
            Check::Int => {
                if !is_integer(x) {
                    issues.push(invalid_type(
                        "int",
                        Some(&JsonValue::Number(x)),
                        Some(false),
                    ));
                } else if x.abs() > MAX_SAFE_INTEGER {
                    if x > 0.0 {
                        issues.push(too_big("int", MAX_SAFE_INTEGER, true));
                    } else {
                        issues.push(too_small("int", MIN_SAFE_INTEGER, true));
                    }
                }
            }
            Check::Min(minimum) => {
                let satisfied = x >= *minimum;
                if !satisfied {
                    issues.push(too_small("number", *minimum, true));
                }
            }
            Check::Max(maximum) => {
                let satisfied = x <= *maximum;
                if !satisfied {
                    issues.push(too_big("number", *maximum, true));
                }
            }
        }
        if issues.len() > start {
            stopped = aborted(&issues[start..]);
        }
    }
    issues
}

/// `handlePropertyResult` of the interpreted object parse. An `undefined` value leaves the key out,
/// as `JSON.stringify` of the output would.
fn handle_property(
    result: Parsed,
    issues: &mut Vec<Issue>,
    value: &mut Obj,
    key: &str,
    is_present: bool,
    optional: bool,
) {
    if !is_present && optional {
        return;
    }
    if !result.issues.is_empty() {
        issues.extend(prefixed(&text(key), result.issues));
        if !is_present {
            return;
        }
    } else if !is_present {
        issues.push(Issue {
            message: "Invalid input: expected nonoptional, received undefined".to_owned(),
            path: vec![text(key)],
            cont: None,
        });
        return;
    }
    if let Some(parsed) = result.value {
        value.set(key, parsed);
    }
}

fn run_object(shape: &ZodShape, loose: bool, input: Option<&JsonValue>) -> Parsed {
    let Some(JsonValue::Object(object)) = input else {
        return failed(invalid_type("object", input, None));
    };
    let fields = ordered(shape);
    let mut issues: Vec<Issue> = Vec::new();
    let mut value = Obj::new();
    for (key, field) in &fields {
        if key == "__proto__" {
            continue;
        }
        let present = object.get(key);
        let result = run(field, present);
        handle_property(
            result,
            &mut issues,
            &mut value,
            key,
            present.is_some(),
            optional_in(field),
        );
    }
    if loose {
        // `handleCatchall` with the `unknown` catchall: every other key passes as it is
        for (key, entry) in object.entries() {
            if fields.iter().any(|(known, _)| known == key) || key == "__proto__" {
                continue;
            }
            handle_property(pass(Some(entry)), &mut issues, &mut value, key, true, false);
        }
    }
    Parsed {
        value: Some(JsonValue::Object(value)),
        issues,
    }
}

/// a property name from what a key schema parsed: a string, or the number of a numeric key
fn property_key(parsed: Option<&JsonValue>) -> Option<String> {
    match parsed {
        Some(JsonValue::String(key)) => Some(key.clone()),
        Some(JsonValue::Number(key)) => Some(number_to_string(*key)),
        _ => None,
    }
}

/// `regexes.number.test(key)`
fn is_number_key(key: &str) -> bool {
    let unsigned = key.strip_prefix('-').unwrap_or(key);
    let (whole, fraction) = match unsigned.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (unsigned, None),
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    digits(whole) && fraction.is_none_or(digits)
}

fn run_record(key_type: &ZodType, value_type: &ZodType, input: Option<&JsonValue>) -> Parsed {
    let Some(JsonValue::Object(object)) = input else {
        return failed(invalid_type("record", input, None));
    };
    let mut issues: Vec<Issue> = Vec::new();
    let mut value = Obj::new();
    if let Some(keys) = values_of(key_type) {
        // the key schema lists its values: each is read, and any other key is unrecognized
        for key in &keys {
            if key == "__proto__" {
                continue;
            }
            let key_result = run(key_type, Some(&text(key)));
            if !key_result.issues.is_empty() {
                issues.push(invalid_key(key));
                continue;
            }
            let Some(out_key) = property_key(key_result.value.as_ref()) else {
                continue;
            };
            if out_key == "__proto__" {
                continue;
            }
            let result = run(value_type, object.get(key));
            issues.extend(prefixed(&text(key), result.issues));
            if let Some(parsed) = result.value {
                value.set(out_key, parsed);
            }
        }
        let unrecognized: Vec<String> = object
            .entries()
            .into_iter()
            .filter(|(key, _)| !keys.iter().any(|known| known.as_str() == *key))
            .map(|(key, _)| key.to_owned())
            .collect();
        if !unrecognized.is_empty() {
            issues.push(unrecognized_keys(&unrecognized));
        }
    } else {
        for (key, entry) in object.entries() {
            if key == "__proto__" {
                continue;
            }
            let mut key_result = run(key_type, Some(&text(key)));
            if !key_result.issues.is_empty() && is_number_key(key) {
                let retry = run(key_type, Some(&JsonValue::Number(to_number(key))));
                if retry.issues.is_empty() {
                    key_result = retry;
                }
            }
            if !key_result.issues.is_empty() {
                issues.push(invalid_key(key));
                continue;
            }
            let Some(out_key) = property_key(key_result.value.as_ref()) else {
                continue;
            };
            if out_key == "__proto__" {
                continue;
            }
            let result = run(value_type, Some(entry));
            issues.extend(prefixed(&text(key), result.issues));
            if let Some(parsed) = result.value {
                value.set(out_key, parsed);
            }
        }
    }
    Parsed {
        value: Some(JsonValue::Object(value)),
        issues,
    }
}

fn run_array(element: &ZodType, checks: &[Check], input: Option<&JsonValue>) -> Parsed {
    // `capSize`: an array longer than a `max` fails it before any element is read
    if let Some(JsonValue::Array(items)) = input {
        let length = items.len() as f64;
        let cap = checks
            .iter()
            .filter_map(|check| match check {
                Check::Max(maximum) if *maximum >= 0.0 => Some(*maximum),
                _ => None,
            })
            .reduce(f64::min);
        if let Some(cap) = cap
            && length > cap
        {
            for check in checks {
                if let Check::Max(maximum) = check
                    && *maximum >= 0.0
                    && length > *maximum
                {
                    return Parsed {
                        value: input.cloned(),
                        issues: vec![too_big("array", *maximum, false)],
                    };
                }
            }
        }
    }
    let Some(JsonValue::Array(items)) = input else {
        return failed(invalid_type("array", input, None));
    };
    let mut issues: Vec<Issue> = Vec::new();
    let mut value: Vec<JsonValue> = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let result = run(element, Some(item));
        issues.extend(prefixed(&JsonValue::Number(index as f64), result.issues));
        value.push(result.value.unwrap_or(JsonValue::Null));
    }
    // `runChecks`: the length checks run unless an issue says `continue: false`
    let length = items.len() as f64;
    for check in checks {
        if explicitly_aborted(&issues) {
            continue;
        }
        match check {
            Check::Min(minimum) => {
                let satisfied = length >= *minimum;
                if !satisfied {
                    issues.push(too_small("array", *minimum, true));
                }
            }
            Check::Max(maximum) => {
                let satisfied = length <= *maximum;
                if !satisfied {
                    issues.push(too_big("array", *maximum, true));
                }
            }
            Check::Int => {}
        }
    }
    Parsed {
        value: Some(JsonValue::Array(value)),
        issues,
    }
}

fn run_union(options: &[ZodType], input: Option<&JsonValue>) -> Parsed {
    if options.len() == 1 {
        return run(&options[0], input);
    }
    let mut results: Vec<Parsed> = Vec::new();
    for option in options {
        let result = run(option, input);
        if result.issues.is_empty() {
            return result;
        }
        results.push(result);
    }
    // `handleUnionResults`: one option that did not abort speaks for the union
    let mut not_aborted: Vec<Parsed> = results
        .into_iter()
        .filter(|result| !aborted(&result.issues))
        .collect();
    if not_aborted.len() == 1
        && let Some(only) = not_aborted.pop()
    {
        return only;
    }
    Parsed {
        value: input.cloned(),
        issues: vec![issue("Invalid input".to_owned(), None)],
    }
}

/// `schema._zod.run({ value: input, issues: [] }, { async: true })`
fn run(schema: &ZodType, input: Option<&JsonValue>) -> Parsed {
    match &schema.kind {
        Kind::String => match input {
            Some(JsonValue::String(_)) => pass(input),
            _ => failed(invalid_type("string", input, None)),
        },
        Kind::Number(checks) => match input {
            Some(JsonValue::Number(x)) if x.is_finite() => Parsed {
                value: input.cloned(),
                issues: run_number_checks(*x, checks),
            },
            _ => failed(invalid_type("number", input, None)),
        },
        Kind::Boolean => match input {
            Some(JsonValue::Bool(_)) => pass(input),
            _ => failed(invalid_type("boolean", input, None)),
        },
        Kind::Null => match input {
            Some(JsonValue::Null) => pass(input),
            _ => failed(invalid_type("null", input, None)),
        },
        Kind::Any | Kind::Unknown => pass(input),
        Kind::Enum(values) => match input {
            Some(JsonValue::String(member)) if values.contains(member) => pass(input),
            _ => failed(invalid_value(values)),
        },
        Kind::Array { element, checks } => run_array(element, checks, input),
        Kind::Object { shape, loose } => run_object(shape, *loose, input),
        Kind::Record { key, value } => run_record(key, value, input),
        Kind::Union(options) => run_union(options, input),
        Kind::Optional(inner) => {
            if input.is_none() {
                return pass(None);
            }
            run(inner, input)
        }
    }
}

/// `z.object(shape).safeParseAsync(input)`: the parsed output, or the issues
pub fn safe_parse(shape: &ZodShape, input: &JsonValue) -> Result<JsonValue, Vec<ZodIssue>> {
    let result = run_object(shape, false, Some(input));
    match (result.issues.is_empty(), result.value) {
        (true, Some(value)) => Ok(value),
        _ => Err(result
            .issues
            .into_iter()
            .map(|issue| ZodIssue {
                message: issue.message,
                path: issue.path,
            })
            .collect()),
    }
}

/// `getDotPath`: the first segment as it is, an index as `[i]`, a key after a dot
fn dot_path(path: &[JsonValue]) -> String {
    let mut out = String::new();
    for (index, segment) in path.iter().enumerate() {
        let segment_text = match segment {
            JsonValue::String(key) => key.clone(),
            JsonValue::Number(position) => number_to_string(*position),
            _ => unreachable!("a path segment is a key or an index"),
        };
        if index == 0 {
            out = segment_text;
        } else if matches!(segment, JsonValue::Number(_)) {
            out.push_str(&format!("[{segment_text}]"));
        } else {
            out.push('.');
            out.push_str(&segment_text);
        }
    }
    out
}

/// the SDK's `getParseErrorMessage` of a ZodError: one line per issue, `<message> at <path>`. With no
/// issues the error's own message, which is the issues printed as JSON: `[]`.
pub fn parse_error_message(issues: &[ZodIssue]) -> String {
    if issues.is_empty() {
        return "[]".to_owned();
    }
    issues
        .iter()
        .map(|issue| {
            if issue.path.is_empty() {
                issue.message.clone()
            } else {
                format!("{} at {}", issue.message, dot_path(&issue.path))
            }
        })
        .collect::<Vec<String>>()
        .join("\n")
}
