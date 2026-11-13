//! `@modelcontextprotocol/sdk` 1.32.1 `types.js`: the protocol versions, the
//! error codes, `McpError` and the JSON-RPC envelopes `shared/protocol.js`
//! writes, with their keys in the order the TypeScript writes them.

use jscompat::{JsObject, JsonValue, number_to_string};

pub const JSONRPC_VERSION: &str = "2.0";
pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";
pub const DEFAULT_NEGOTIATED_PROTOCOL_VERSION: &str = "2025-03-26";
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 5] = [
    LATEST_PROTOCOL_VERSION,
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

/// `ErrorCode`
pub mod error_code {
    pub const CONNECTION_CLOSED: f64 = -32000.0;
    pub const REQUEST_TIMEOUT: f64 = -32001.0;
    pub const PARSE_ERROR: f64 = -32700.0;
    pub const INVALID_REQUEST: f64 = -32600.0;
    pub const METHOD_NOT_FOUND: f64 = -32601.0;
    pub const INVALID_PARAMS: f64 = -32602.0;
    pub const INTERNAL_ERROR: f64 = -32603.0;
    pub const URL_ELICITATION_REQUIRED: f64 = -32042.0;
}

/// `McpError`: `message` is the `Error`'s message, `MCP error ${code}:
/// ${message}`; `data` is `undefined` when `None`.
#[derive(Debug, Clone, PartialEq)]
pub struct McpError {
    pub code: f64,
    pub message: String,
    pub data: Option<JsonValue>,
}

impl McpError {
    /// `new McpError(code, message, data)`
    pub fn new(code: f64, message: &str, data: Option<JsonValue>) -> Self {
        McpError {
            code,
            message: format!("MCP error {}: {message}", number_to_string(code)),
            data,
        }
    }
}

fn object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut out = JsObject::new();
    for (key, value) in entries {
        out.set(key, value);
    }
    JsonValue::Object(out)
}

/// The answer to a request: `{ result, jsonrpc: '2.0', id }`
pub fn result_response(id: JsonValue, result: JsonValue) -> JsonValue {
    object(vec![
        ("result", result),
        ("jsonrpc", JsonValue::String(JSONRPC_VERSION.into())),
        ("id", id),
    ])
}

/// The error answer to a request: `{ jsonrpc: '2.0', id, error: { code,
/// message, data? } }`
pub fn error_response(
    id: JsonValue,
    code: f64,
    message: &str,
    data: Option<JsonValue>,
) -> JsonValue {
    let mut error = vec![
        ("code", JsonValue::Number(code)),
        ("message", JsonValue::String(message.into())),
    ];
    if let Some(data) = data {
        error.push(("data", data));
    }
    object(vec![
        ("jsonrpc", JsonValue::String(JSONRPC_VERSION.into())),
        ("id", id),
        ("error", object(error)),
    ])
}

/// An outgoing request: `{ ...request, jsonrpc: '2.0', id }`, the request
/// being `{ method, params }` with `params` left out when `None`
pub fn request(method: &str, params: Option<JsonValue>, id: f64) -> JsonValue {
    let mut entries = vec![("method", JsonValue::String(method.into()))];
    if let Some(params) = params {
        entries.push(("params", params));
    }
    entries.push(("jsonrpc", JsonValue::String(JSONRPC_VERSION.into())));
    entries.push(("id", JsonValue::Number(id)));
    object(entries)
}

/// An outgoing notification: `{ ...notification, jsonrpc: '2.0' }`
pub fn notification(method: &str, params: Option<JsonValue>) -> JsonValue {
    let mut entries = vec![("method", JsonValue::String(method.into()))];
    if let Some(params) = params {
        entries.push(("params", params));
    }
    entries.push(("jsonrpc", JsonValue::String(JSONRPC_VERSION.into())));
    object(entries)
}

/// zod 4.6.7 parsing as the SDK's schemas use it. What a peer sends is read as
/// `JsonValue` and checked here; the parsed value comes out as zod builds it:
/// keys in the order of the shape (unknown keys after them, or stripped),
/// defaults filled in, `undefined` (`None`) where a transform or a catch made
/// it. A failure is the list of zod issues, with the keys and the message zod
/// 4.6.7 gives them.
pub mod schema {
    use jscompat::{
        JsObject, JsonValue, atob, js_regex, json_stringify_pretty, number_to_string, trim,
    };

    /// a `ZodRawShape`: keys in the order of the literal
    pub type Shape = Vec<(String, Schema)>;

    /// one issue as `finalizeIssue` leaves it
    #[derive(Debug, Clone, PartialEq)]
    pub struct Issue {
        /// the keys the issue was made with, `code` among them, in order
        pub fields: Vec<(&'static str, JsonValue)>,
        /// the path, a string key or an array index (number) at each step
        pub path: Vec<JsonValue>,
        pub message: String,
        /// zod's `continue: true`: the checks after it still run
        pub carry_on: bool,
    }

    impl Issue {
        fn new(fields: Vec<(&'static str, JsonValue)>, message: String, carry_on: bool) -> Issue {
            Issue {
                fields,
                path: Vec::new(),
                message,
                carry_on,
            }
        }

        /// `issue.code`
        pub fn code(&self) -> &str {
            for (key, value) in &self.fields {
                if *key == "code"
                    && let JsonValue::String(code) = value
                {
                    return code.as_str();
                }
            }
            "custom"
        }

        /// the issue as `JSON.stringify` prints it: the keys it was made
        /// with, then `path`, then `message`
        pub fn to_json(&self) -> JsonValue {
            let mut out = JsObject::new();
            for (key, value) in &self.fields {
                out.set(*key, value.clone());
            }
            out.set("path", JsonValue::Array(self.path.clone()));
            out.set("message", JsonValue::String(self.message.clone()));
            JsonValue::Object(out)
        }
    }

    /// `error.message` of a `ZodError`: `JSON.stringify(issues, null, 2)`
    pub fn error_message(issues: &[Issue]) -> String {
        let list: Vec<JsonValue> = issues.iter().map(Issue::to_json).collect();
        json_stringify_pretty(&JsonValue::Array(list), 2)
    }

    fn text(value: &str) -> JsonValue {
        JsonValue::String(value.to_owned())
    }

    /// `util.parsedType`
    fn parsed_type(input: Option<&JsonValue>) -> &'static str {
        match input {
            None => "undefined",
            Some(JsonValue::Null) => "null",
            Some(JsonValue::Bool(_)) => "boolean",
            Some(JsonValue::Number(x)) => {
                if x.is_nan() {
                    "nan"
                } else {
                    "number"
                }
            }
            Some(JsonValue::String(_)) => "string",
            Some(JsonValue::Array(_)) => "array",
            Some(JsonValue::Object(_)) => "object",
        }
    }

    /// `getTypeName` of the English locale
    fn type_name(kind: &str, input: Option<&JsonValue>) -> String {
        if kind == "number"
            && let Some(JsonValue::Number(x)) = input
            && !x.is_finite()
        {
            return number_to_string(*x);
        }
        if kind == "nan" {
            "NaN".to_owned()
        } else {
            kind.to_owned()
        }
    }

    /// `util.stringifyPrimitive`
    fn stringify_primitive(value: &JsonValue) -> String {
        match value {
            JsonValue::String(s) => format!("\"{s}\""),
            other => other.to_js_string(),
        }
    }

    fn invalid_type(expected: &'static str, input: Option<&JsonValue>) -> Issue {
        let mut fields = vec![("expected", text(expected)), ("code", text("invalid_type"))];
        if expected == "number"
            && let Some(JsonValue::Number(x)) = input
            && !x.is_finite()
        {
            let received = if x.is_nan() {
                "NaN".to_owned()
            } else {
                number_to_string(*x)
            };
            fields.push(("received", JsonValue::String(received)));
        }
        let message = format!(
            "Invalid input: expected {}, received {}",
            type_name(expected, None),
            type_name(parsed_type(input), input)
        );
        Issue::new(fields, message, false)
    }

    fn invalid_value(values: Vec<JsonValue>) -> Issue {
        let message = if values.len() == 1 {
            format!(
                "Invalid input: expected {}",
                stringify_primitive(&values[0])
            )
        } else {
            let joined: Vec<String> = values.iter().map(stringify_primitive).collect();
            format!("Invalid option: expected one of {}", joined.join("|"))
        };
        Issue::new(
            vec![
                ("code", text("invalid_value")),
                ("values", JsonValue::Array(values)),
            ],
            message,
            false,
        )
    }

    fn unrecognized_keys(keys: Vec<String>) -> Issue {
        let joined: Vec<String> = keys.iter().map(|k| format!("\"{k}\"")).collect();
        let message = format!(
            "Unrecognized key{}: {}",
            if keys.len() > 1 { "s" } else { "" },
            joined.join(", ")
        );
        let list = keys.into_iter().map(JsonValue::String).collect();
        Issue::new(
            vec![
                ("code", text("unrecognized_keys")),
                ("keys", JsonValue::Array(list)),
            ],
            message,
            true,
        )
    }

    fn custom(message: &str, carry_on: bool) -> Issue {
        Issue::new(vec![("code", text("custom"))], message.to_owned(), carry_on)
    }

    /// `util.prefixIssues`
    fn prefix(key: JsonValue, issues: Vec<Issue>) -> Vec<Issue> {
        issues
            .into_iter()
            .map(|mut issue| {
                issue.path.insert(0, key.clone());
                issue
            })
            .collect()
    }

    /// what is left of a key's absence: `optional` lets it be missing,
    /// `defaulted` fills it in
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Rung {
        Optional,
        Defaulted,
    }

    /// what an object does with the keys its shape does not name
    #[derive(Debug, Clone)]
    pub enum Catchall {
        /// `z.object`: dropped
        Strip,
        /// `.strict()`: an `unrecognized_keys` issue
        Never,
        /// `.catchall(schema)`: parsed by the schema (`z.looseObject`: `z.unknown()`)
        Schema(Box<Schema>),
    }

    /// what a schema checks after its own parse, in order
    #[derive(Debug, Clone)]
    pub enum Check {
        /// `z.url()`: the trimmed text parses as a URL, and is the value
        Url,
        /// `SafeUrlSchema`'s `superRefine`
        SafeUrlParses,
        /// `SafeUrlSchema`'s `refine`: no `javascript:`, `data:` or `vbscript:`
        SafeUrlScheme,
        /// `z.number().int()`: a safe integer
        Int,
        /// `.min(n)`
        Min(f64),
        /// `.max(n)`
        Max(f64),
        /// the `refine` of `Base64Schema`
        Base64,
        /// `z.iso.datetime({ offset: true })`
        DatetimeOffset,
    }

    /// one zod schema node
    #[derive(Debug, Clone)]
    pub enum Schema {
        String,
        /// `z.number()`; `coerce` is `z.coerce.number()`
        Number {
            coerce: bool,
        },
        Boolean,
        Unknown,
        /// `z.custom((v) => v !== null && (typeof v === 'object' || typeof v === 'function'))`
        ObjectLike,
        Literal(JsonValue),
        Enum(Vec<String>),
        Array(Box<Schema>),
        Object {
            shape: Shape,
            catchall: Catchall,
        },
        /// `z.record(z.string(), value)`
        Record(Box<Schema>),
        Union(Vec<Schema>),
        Optional(Box<Schema>),
        /// `.default(value)`
        Default(Box<Schema>, JsonValue),
        /// `.catch(undefined)`
        CatchUndefined(Box<Schema>),
        /// `z.literal('').transform(() => undefined)`
        EmptyToUndefined,
        Checked(Box<Schema>, Vec<Check>),
    }

    fn optin(schema: &Schema) -> Option<Rung> {
        match schema {
            Schema::Optional(inner) | Schema::CatchUndefined(inner) => {
                if optin(inner) == Some(Rung::Defaulted) {
                    Some(Rung::Defaulted)
                } else {
                    Some(Rung::Optional)
                }
            }
            Schema::Default(..) => Some(Rung::Defaulted),
            Schema::Union(options) => {
                if options.iter().any(|o| optin(o) == Some(Rung::Defaulted)) {
                    Some(Rung::Defaulted)
                } else if options.iter().any(|o| optin(o).is_some()) {
                    Some(Rung::Optional)
                } else {
                    None
                }
            }
            Schema::Checked(inner, _) => optin(inner),
            _ => None,
        }
    }

    fn optout(schema: &Schema) -> Option<Rung> {
        match schema {
            Schema::Optional(_) => Some(Rung::Optional),
            Schema::CatchUndefined(inner) | Schema::Checked(inner, _) => optout(inner),
            Schema::Union(options) => {
                if options.iter().any(|o| optout(o) == Some(Rung::Optional)) {
                    Some(Rung::Optional)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    struct Payload {
        value: Option<JsonValue>,
        issues: Vec<Issue>,
        aborted: bool,
    }

    impl Payload {
        fn ok(value: Option<JsonValue>) -> Payload {
            Payload {
                value,
                issues: Vec::new(),
                aborted: false,
            }
        }

        fn fail(issue: Issue) -> Payload {
            Payload {
                value: None,
                issues: vec![issue],
                aborted: false,
            }
        }

        /// `util.aborted(payload, from)`
        fn is_aborted(&self, from: usize) -> bool {
            self.aborted || self.issues.iter().skip(from).any(|issue| !issue.carry_on)
        }
    }

    const DATETIME_PATTERN: &str = r"^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$";

    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

    /// `value.replace(/[\t\n\r]/g, '')`
    fn strip_tab_and_newline(value: &str) -> String {
        value
            .chars()
            .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
            .collect()
    }

    /// `URL.canParse(text)`
    fn can_parse_url(value: &str) -> bool {
        url::Url::parse(value).is_ok()
    }

    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    fn apply_check(check: &Check, payload: &mut Payload) {
        match check {
            Check::Url => {
                let value = match &payload.value {
                    Some(JsonValue::String(s)) => s.clone(),
                    _ => return,
                };
                let trimmed = trim(&value);
                if can_parse_url(trimmed) {
                    payload.value = Some(JsonValue::String(strip_tab_and_newline(trimmed)));
                } else {
                    payload.issues.push(Issue::new(
                        vec![("code", text("invalid_format")), ("format", text("url"))],
                        "Invalid URL".to_owned(),
                        true,
                    ));
                }
            }
            Check::SafeUrlParses => {
                if let Some(JsonValue::String(value)) = &payload.value
                    && !can_parse_url(value)
                {
                    payload.issues.push(custom("URL must be parseable", false));
                }
            }
            Check::SafeUrlScheme => {
                if let Some(JsonValue::String(value)) = &payload.value
                    && let Ok(parsed) = url::Url::parse(value)
                    && matches!(parsed.scheme(), "javascript" | "data" | "vbscript")
                {
                    payload.issues.push(custom(
                        "URL cannot use javascript:, data:, or vbscript: scheme",
                        true,
                    ));
                }
            }
            Check::Int => {
                let x = match &payload.value {
                    Some(JsonValue::Number(x)) => *x,
                    _ => return,
                };
                if !(x.is_finite() && x.fract() == 0.0) {
                    payload.issues.push(Issue::new(
                        vec![
                            ("expected", text("int")),
                            ("format", text("safeint")),
                            ("code", text("invalid_type")),
                        ],
                        format!(
                            "Invalid input: expected int, received {}",
                            type_name(parsed_type(payload.value.as_ref()), payload.value.as_ref())
                        ),
                        false,
                    ));
                    return;
                }
                if x.abs() > MAX_SAFE_INTEGER {
                    if x > 0.0 {
                        payload.issues.push(Issue::new(
                            vec![
                                ("code", text("too_big")),
                                ("maximum", JsonValue::Number(MAX_SAFE_INTEGER)),
                                (
                                    "note",
                                    text("Integers must be within the safe integer range."),
                                ),
                                ("origin", text("int")),
                                ("inclusive", JsonValue::Bool(true)),
                            ],
                            format!(
                                "Too big: expected int to be <={}",
                                number_to_string(MAX_SAFE_INTEGER)
                            ),
                            true,
                        ));
                    } else {
                        payload.issues.push(Issue::new(
                            vec![
                                ("code", text("too_small")),
                                ("minimum", JsonValue::Number(-MAX_SAFE_INTEGER)),
                                (
                                    "note",
                                    text("Integers must be within the safe integer range."),
                                ),
                                ("origin", text("int")),
                                ("inclusive", JsonValue::Bool(true)),
                            ],
                            format!(
                                "Too small: expected int to be >={}",
                                number_to_string(-MAX_SAFE_INTEGER)
                            ),
                            true,
                        ));
                    }
                }
            }
            Check::Min(minimum) => {
                if let Some(JsonValue::Number(x)) = &payload.value
                    && !(*x >= *minimum)
                {
                    payload.issues.push(Issue::new(
                        vec![
                            ("origin", text("number")),
                            ("code", text("too_small")),
                            ("minimum", JsonValue::Number(*minimum)),
                            ("inclusive", JsonValue::Bool(true)),
                        ],
                        format!(
                            "Too small: expected number to be >={}",
                            number_to_string(*minimum)
                        ),
                        true,
                    ));
                }
            }
            Check::Max(maximum) => {
                if let Some(JsonValue::Number(x)) = &payload.value
                    && !(*x <= *maximum)
                {
                    payload.issues.push(Issue::new(
                        vec![
                            ("origin", text("number")),
                            ("code", text("too_big")),
                            ("maximum", JsonValue::Number(*maximum)),
                            ("inclusive", JsonValue::Bool(true)),
                        ],
                        format!(
                            "Too big: expected number to be <={}",
                            number_to_string(*maximum)
                        ),
                        true,
                    ));
                }
            }
            Check::Base64 => {
                if let Some(JsonValue::String(value)) = &payload.value
                    && atob(value).is_err()
                {
                    payload.issues.push(custom("Invalid Base64 string", true));
                }
            }
            Check::DatetimeOffset => {
                if let Some(JsonValue::String(value)) = &payload.value
                    && !js_regex!(DATETIME_PATTERN).test(value)
                {
                    payload.issues.push(Issue::new(
                        vec![
                            ("origin", text("string")),
                            ("code", text("invalid_format")),
                            ("format", text("datetime")),
                            (
                                "pattern",
                                JsonValue::String(format!("/{DATETIME_PATTERN}/")),
                            ),
                        ],
                        "Invalid ISO datetime".to_owned(),
                        true,
                    ));
                }
            }
        }
    }

    /// `runChecks`
    fn run_checks(mut payload: Payload, checks: &[Check]) -> Payload {
        let mut aborted = payload.is_aborted(0);
        for check in checks {
            if aborted {
                continue;
            }
            let before = payload.issues.len();
            apply_check(check, &mut payload);
            if payload.issues.len() == before {
                continue;
            }
            if !aborted {
                aborted = payload.is_aborted(before);
            }
        }
        payload
    }

    /// `handlePropertyResult`
    fn property_result(
        result: Payload,
        out: &mut JsObject<JsonValue>,
        issues: &mut Vec<Issue>,
        key: &str,
        present: bool,
        input_rung: Option<Rung>,
        output_rung: Option<Rung>,
    ) {
        let optional_out = output_rung == Some(Rung::Optional);
        if !present && optional_out && input_rung == Some(Rung::Optional) {
            return;
        }
        let Payload {
            value,
            issues: found,
            ..
        } = result;
        let clean = found.is_empty();
        if !clean {
            if input_rung.is_some() && optional_out && !present {
                return;
            }
            issues.extend(prefix(JsonValue::String(key.to_owned()), found));
        }
        if !present && input_rung.is_none() {
            if clean {
                let mut issue = Issue::new(
                    vec![
                        ("code", text("invalid_type")),
                        ("expected", text("nonoptional")),
                    ],
                    "Invalid input: expected nonoptional, received undefined".to_owned(),
                    false,
                );
                issue.path.push(JsonValue::String(key.to_owned()));
                issues.push(issue);
            }
            return;
        }
        // a value that is `undefined` leaves the key out of what is printed
        if let Some(value) = value {
            out.set(key, value);
        }
    }

    fn run_object(shape: &Shape, catchall: &Catchall, input: Option<&JsonValue>) -> Payload {
        let object = match input {
            Some(JsonValue::Object(object)) => object,
            _ => return Payload::fail(invalid_type("object", input)),
        };
        let mut out: JsObject<JsonValue> = JsObject::new();
        let mut issues: Vec<Issue> = Vec::new();
        for (key, field) in shape {
            if key == "__proto__" {
                continue;
            }
            let present = object.get(key).is_some();
            let result = run(field, object.get(key));
            property_result(
                result,
                &mut out,
                &mut issues,
                key,
                present,
                optin(field),
                optout(field),
            );
        }
        if !matches!(catchall, Catchall::Strip) {
            let mut unrecognized: Vec<String> = Vec::new();
            for (key, value) in object.entries() {
                if shape.iter().any(|(named, _)| named.as_str() == key) {
                    continue;
                }
                match catchall {
                    Catchall::Strip => {}
                    Catchall::Never => unrecognized.push(key.to_owned()),
                    Catchall::Schema(_) if key == "__proto__" => {}
                    Catchall::Schema(each) => {
                        let result = run(each, Some(value));
                        property_result(
                            result,
                            &mut out,
                            &mut issues,
                            key,
                            true,
                            optin(each),
                            optout(each),
                        );
                    }
                }
            }
            if !unrecognized.is_empty() {
                issues.push(unrecognized_keys(unrecognized));
            }
        }
        Payload {
            value: Some(JsonValue::Object(out)),
            issues,
            aborted: false,
        }
    }

    fn run(schema: &Schema, input: Option<&JsonValue>) -> Payload {
        match schema {
            Schema::String => match input {
                Some(JsonValue::String(_)) => Payload::ok(input.cloned()),
                _ => Payload::fail(invalid_type("string", input)),
            },
            Schema::Number { coerce } => {
                let value = if *coerce {
                    Some(JsonValue::Number(
                        input.map_or(f64::NAN, |value| value.to_number()),
                    ))
                } else {
                    input.cloned()
                };
                match &value {
                    Some(JsonValue::Number(x)) if x.is_finite() => Payload::ok(value.clone()),
                    _ => Payload::fail(invalid_type("number", value.as_ref())),
                }
            }
            Schema::Boolean => match input {
                Some(JsonValue::Bool(_)) => Payload::ok(input.cloned()),
                _ => Payload::fail(invalid_type("boolean", input)),
            },
            Schema::Unknown => Payload::ok(input.cloned()),
            Schema::ObjectLike => match input {
                Some(JsonValue::Object(_)) | Some(JsonValue::Array(_)) => {
                    Payload::ok(input.cloned())
                }
                _ => Payload::fail(custom("Invalid input", true)),
            },
            Schema::Literal(expected) => {
                if input == Some(expected) {
                    Payload::ok(input.cloned())
                } else {
                    Payload::fail(invalid_value(vec![expected.clone()]))
                }
            }
            Schema::Enum(values) => match input {
                Some(JsonValue::String(value)) if values.contains(value) => {
                    Payload::ok(input.cloned())
                }
                _ => Payload::fail(invalid_value(
                    values.iter().map(|v| text(v)).collect::<Vec<JsonValue>>(),
                )),
            },
            Schema::Array(element) => match input {
                Some(JsonValue::Array(items)) => {
                    let mut out: Vec<JsonValue> = Vec::new();
                    let mut issues: Vec<Issue> = Vec::new();
                    for (index, item) in items.iter().enumerate() {
                        let result = run(element, Some(item));
                        issues.extend(prefix(JsonValue::Number(index as f64), result.issues));
                        out.push(result.value.unwrap_or(JsonValue::Null));
                    }
                    Payload {
                        value: Some(JsonValue::Array(out)),
                        issues,
                        aborted: false,
                    }
                }
                _ => Payload::fail(invalid_type("array", input)),
            },
            Schema::Object { shape, catchall } => run_object(shape, catchall, input),
            Schema::Record(value_schema) => match input {
                Some(JsonValue::Object(object)) => {
                    let mut out: JsObject<JsonValue> = JsObject::new();
                    let mut issues: Vec<Issue> = Vec::new();
                    for (key, value) in object.entries() {
                        if key == "__proto__" {
                            continue;
                        }
                        let result = run(value_schema, Some(value));
                        issues.extend(prefix(JsonValue::String(key.to_owned()), result.issues));
                        if let Some(parsed) = result.value {
                            out.set(key, parsed);
                        }
                    }
                    Payload {
                        value: Some(JsonValue::Object(out)),
                        issues,
                        aborted: false,
                    }
                }
                _ => Payload::fail(invalid_type("record", input)),
            },
            Schema::Union(options) => {
                if options.len() == 1 {
                    return run(&options[0], input);
                }
                let mut results: Vec<Payload> = Vec::new();
                for option in options {
                    let result = run(option, input);
                    if result.issues.is_empty() {
                        return result;
                    }
                    results.push(result);
                }
                let open: Vec<usize> = (0..results.len())
                    .filter(|index| !results[*index].is_aborted(0))
                    .collect();
                if open.len() == 1 {
                    return results.swap_remove(open[0]);
                }
                let errors: Vec<JsonValue> = results
                    .iter()
                    .map(|result| {
                        JsonValue::Array(result.issues.iter().map(Issue::to_json).collect())
                    })
                    .collect();
                Payload::fail(Issue::new(
                    vec![
                        ("code", text("invalid_union")),
                        ("errors", JsonValue::Array(errors)),
                    ],
                    "Invalid input".to_owned(),
                    false,
                ))
            }
            Schema::Optional(inner) => {
                if input.is_none() {
                    if optin(inner) != Some(Rung::Defaulted) {
                        return Payload::ok(None);
                    }
                    let result = run(inner, None);
                    return Payload::ok(if result.issues.is_empty() {
                        result.value
                    } else {
                        None
                    });
                }
                run(inner, input)
            }
            Schema::Default(inner, default) => match input {
                None => Payload::ok(Some(default.clone())),
                Some(_) => {
                    let mut result = run(inner, input);
                    if result.value.is_none() {
                        result.value = Some(default.clone());
                    }
                    result
                }
            },
            Schema::CatchUndefined(inner) => {
                let result = run(inner, input);
                if result.issues.is_empty() {
                    Payload::ok(result.value)
                } else {
                    Payload::ok(None)
                }
            }
            Schema::EmptyToUndefined => {
                let mut left = run(&Schema::Literal(JsonValue::String(String::new())), input);
                if left
                    .issues
                    .iter()
                    .any(|issue| issue.code() != "unrecognized_keys")
                {
                    left.aborted = true;
                    return left;
                }
                Payload {
                    value: None,
                    issues: left.issues,
                    aborted: false,
                }
            }
            Schema::Checked(base, checks) => run_checks(run(base, input), checks),
        }
    }

    /// `schema.safeParse(input)`: the parsed value, or the issues. A value
    /// that came out `undefined` is `null` here (no schema of the SDK that is
    /// parsed at the top does that).
    pub fn safe_parse(schema: &Schema, input: &JsonValue) -> Result<JsonValue, Vec<Issue>> {
        let payload = run(schema, Some(input));
        if payload.issues.is_empty() {
            Ok(payload.value.unwrap_or(JsonValue::Null))
        } else {
            Err(payload.issues)
        }
    }

    /// `schema.safeParse(input).success`
    pub fn is_valid(schema: &Schema, input: &JsonValue) -> bool {
        run(schema, Some(input)).issues.is_empty()
    }

    // ---- builders, named as zod's ----

    pub fn string() -> Schema {
        Schema::String
    }

    pub fn number() -> Schema {
        Schema::Number { coerce: false }
    }

    /// `z.coerce.number()`
    pub fn coerce_number() -> Schema {
        Schema::Number { coerce: true }
    }

    /// `z.number().int()`
    pub fn int() -> Schema {
        Schema::Checked(Box::new(number()), vec![Check::Int])
    }

    /// `z.number().min(min).max(max)`
    pub fn number_between(min: f64, max: f64) -> Schema {
        Schema::Checked(Box::new(number()), vec![Check::Min(min), Check::Max(max)])
    }

    pub fn boolean() -> Schema {
        Schema::Boolean
    }

    pub fn unknown() -> Schema {
        Schema::Unknown
    }

    pub fn object_like() -> Schema {
        Schema::ObjectLike
    }

    /// `z.literal(value)` of a string
    pub fn literal(value: &str) -> Schema {
        Schema::Literal(text(value))
    }

    pub fn enum_of(values: &[&str]) -> Schema {
        Schema::Enum(values.iter().map(|v| (*v).to_owned()).collect())
    }

    pub fn array(element: Schema) -> Schema {
        Schema::Array(Box::new(element))
    }

    /// `z.record(z.string(), value)`
    pub fn record(value: Schema) -> Schema {
        Schema::Record(Box::new(value))
    }

    pub fn union(options: Vec<Schema>) -> Schema {
        Schema::Union(options)
    }

    /// `z.url()` and `z.string().url()`
    pub fn url() -> Schema {
        Schema::Checked(Box::new(Schema::String), vec![Check::Url])
    }

    /// `SafeUrlSchema` of `shared/auth.js`
    pub fn safe_url() -> Schema {
        Schema::Checked(
            Box::new(Schema::String),
            vec![Check::Url, Check::SafeUrlParses, Check::SafeUrlScheme],
        )
    }

    /// `Base64Schema`
    pub fn base64() -> Schema {
        Schema::Checked(Box::new(Schema::String), vec![Check::Base64])
    }

    /// `z.iso.datetime({ offset: true })`
    pub fn iso_datetime_offset() -> Schema {
        Schema::Checked(Box::new(Schema::String), vec![Check::DatetimeOffset])
    }

    /// `z.literal('').transform(() => undefined)`
    pub fn empty_to_undefined() -> Schema {
        Schema::EmptyToUndefined
    }

    /// a shape from `(key, schema)` pairs
    pub fn shape(entries: Vec<(&str, Schema)>) -> Shape {
        entries
            .into_iter()
            .map(|(key, schema)| (key.to_owned(), schema))
            .collect()
    }

    /// `z.object(shape)`
    pub fn object(entries: Shape) -> Schema {
        Schema::Object {
            shape: entries,
            catchall: Catchall::Strip,
        }
    }

    /// `z.looseObject(shape)`
    pub fn loose_object(entries: Shape) -> Schema {
        Schema::Object {
            shape: entries,
            catchall: Catchall::Schema(Box::new(Schema::Unknown)),
        }
    }

    impl Schema {
        pub fn optional(self) -> Schema {
            Schema::Optional(Box::new(self))
        }

        pub fn default_value(self, value: JsonValue) -> Schema {
            Schema::Default(Box::new(self), value)
        }

        pub fn catch_undefined(self) -> Schema {
            Schema::CatchUndefined(Box::new(self))
        }

        /// `.or(other)`
        pub fn or(self, other: Schema) -> Schema {
            Schema::Union(vec![self, other])
        }

        /// `.strict()` of an object
        pub fn strict(self) -> Schema {
            match self {
                Schema::Object { shape, .. } => Schema::Object {
                    shape,
                    catchall: Catchall::Never,
                },
                other => other,
            }
        }

        /// `.loose()` of an object
        pub fn loose(self) -> Schema {
            match self {
                Schema::Object { shape, .. } => loose_object(shape),
                other => other,
            }
        }

        /// `.catchall(each)` of an object
        pub fn catchall(self, each: Schema) -> Schema {
            match self {
                Schema::Object { shape, .. } => Schema::Object {
                    shape,
                    catchall: Catchall::Schema(Box::new(each)),
                },
                other => other,
            }
        }

        /// the shape of an object (`.shape`)
        pub fn shape(&self) -> Shape {
            match self {
                Schema::Object { shape, .. } => shape.clone(),
                _ => Vec::new(),
            }
        }

        /// `.extend(extra)` and `.merge(other)`: a key already there keeps its place
        pub fn extend(self, extra: Shape) -> Schema {
            match self {
                Schema::Object { shape, catchall } => {
                    let mut merged = shape;
                    for (key, schema) in extra {
                        match merged.iter_mut().find(|(named, _)| *named == key) {
                            Some(slot) => slot.1 = schema,
                            None => merged.push((key, schema)),
                        }
                    }
                    Schema::Object {
                        shape: merged,
                        catchall,
                    }
                }
                other => other,
            }
        }

        /// `.omit({ key: true })` of an object
        pub fn omit(self, key: &str) -> Schema {
            match self {
                Schema::Object { shape, catchall } => Schema::Object {
                    shape: shape
                        .into_iter()
                        .filter(|(named, _)| named != key)
                        .collect(),
                    catchall,
                },
                other => other,
            }
        }
    }

    // ---- the schemas of `types.js` ----

    fn request_id() -> Schema {
        union(vec![string(), int()])
    }

    fn request_meta() -> Schema {
        loose_object(shape(vec![
            ("progressToken", union(vec![string(), int()]).optional()),
            (
                "io.modelcontextprotocol/related-task",
                object(shape(vec![("taskId", string())])).optional(),
            ),
        ]))
    }

    fn base_request_params() -> Schema {
        object(shape(vec![("_meta", request_meta().optional())]))
    }

    /// `RequestSchema`
    fn request_schema() -> Schema {
        object(shape(vec![
            ("method", string()),
            ("params", base_request_params().loose().optional()),
        ]))
    }

    fn notifications_params() -> Schema {
        object(shape(vec![("_meta", request_meta().optional())]))
    }

    /// `NotificationSchema`
    fn notification_schema() -> Schema {
        object(shape(vec![
            ("method", string()),
            ("params", notifications_params().loose().optional()),
        ]))
    }

    /// `ResultSchema`
    pub fn result() -> Schema {
        loose_object(shape(vec![("_meta", request_meta().optional())]))
    }

    /// `JSONRPCRequestSchema`
    pub fn jsonrpc_request() -> Schema {
        object(
            shape(vec![("jsonrpc", literal("2.0")), ("id", request_id())])
                .into_iter()
                .chain(request_schema().shape())
                .collect(),
        )
        .strict()
    }

    /// `JSONRPCNotificationSchema`
    pub fn jsonrpc_notification() -> Schema {
        object(
            shape(vec![("jsonrpc", literal("2.0"))])
                .into_iter()
                .chain(notification_schema().shape())
                .collect(),
        )
        .strict()
    }

    /// `JSONRPCResultResponseSchema`
    pub fn jsonrpc_result_response() -> Schema {
        object(shape(vec![
            ("jsonrpc", literal("2.0")),
            ("id", request_id()),
            ("result", result()),
        ]))
        .strict()
    }

    /// `JSONRPCErrorResponseSchema`
    pub fn jsonrpc_error_response() -> Schema {
        object(shape(vec![
            ("jsonrpc", literal("2.0")),
            ("id", request_id().optional()),
            (
                "error",
                object(shape(vec![
                    ("code", int()),
                    ("message", string()),
                    ("data", unknown().optional()),
                ])),
            ),
        ]))
        .strict()
    }

    /// `JSONRPCMessageSchema`
    pub fn jsonrpc_message() -> Schema {
        union(vec![
            jsonrpc_request(),
            jsonrpc_notification(),
            jsonrpc_result_response(),
            jsonrpc_error_response(),
        ])
    }

    /// `EmptyResultSchema`
    pub fn empty_result() -> Schema {
        result().strict()
    }

    fn icons() -> Schema {
        array(object(shape(vec![
            ("src", string()),
            ("mimeType", string().optional()),
            ("sizes", array(string()).optional()),
            ("theme", enum_of(&["light", "dark"]).optional()),
        ])))
        .optional()
    }

    fn base_metadata() -> Shape {
        shape(vec![("name", string()), ("title", string().optional())])
    }

    fn implementation() -> Schema {
        object(base_metadata()).extend(shape(vec![
            ("icons", icons()),
            ("version", string()),
            ("websiteUrl", string().optional()),
            ("description", string().optional()),
        ]))
    }

    fn server_tasks_capability() -> Schema {
        loose_object(shape(vec![
            ("list", object_like().optional()),
            ("cancel", object_like().optional()),
            (
                "requests",
                loose_object(shape(vec![(
                    "tools",
                    loose_object(shape(vec![("call", object_like().optional())])).optional(),
                )]))
                .optional(),
            ),
        ]))
    }

    /// `ServerCapabilitiesSchema`
    pub fn server_capabilities() -> Schema {
        object(shape(vec![
            ("experimental", record(object_like()).optional()),
            ("logging", object_like().optional()),
            ("completions", object_like().optional()),
            (
                "prompts",
                object(shape(vec![("listChanged", boolean().optional())])).optional(),
            ),
            (
                "resources",
                object(shape(vec![
                    ("subscribe", boolean().optional()),
                    ("listChanged", boolean().optional()),
                ]))
                .optional(),
            ),
            (
                "tools",
                object(shape(vec![("listChanged", boolean().optional())])).optional(),
            ),
            ("tasks", server_tasks_capability().optional()),
            ("extensions", record(object_like()).optional()),
        ]))
    }

    /// `InitializeResultSchema`
    pub fn initialize_result() -> Schema {
        result().extend(shape(vec![
            ("protocolVersion", string()),
            ("capabilities", server_capabilities()),
            ("serverInfo", implementation()),
            ("instructions", string().optional()),
        ]))
    }

    fn annotations() -> Schema {
        object(shape(vec![
            (
                "audience",
                array(enum_of(&["user", "assistant"])).optional(),
            ),
            ("priority", number_between(0.0, 1.0).optional()),
            ("lastModified", iso_datetime_offset().optional()),
        ]))
    }

    fn meta_record() -> Schema {
        record(unknown()).optional()
    }

    fn resource_contents() -> Shape {
        shape(vec![
            ("uri", string()),
            ("mimeType", string().optional()),
            ("_meta", meta_record()),
        ])
    }

    fn content_block() -> Schema {
        let text_content = object(shape(vec![
            ("type", literal("text")),
            ("text", string()),
            ("annotations", annotations().optional()),
            ("_meta", meta_record()),
        ]));
        let image_content = object(shape(vec![
            ("type", literal("image")),
            ("data", base64()),
            ("mimeType", string()),
            ("annotations", annotations().optional()),
            ("_meta", meta_record()),
        ]));
        let audio_content = object(shape(vec![
            ("type", literal("audio")),
            ("data", base64()),
            ("mimeType", string()),
            ("annotations", annotations().optional()),
            ("_meta", meta_record()),
        ]));
        let mut resource_shape = base_metadata();
        resource_shape.push(("icons".to_owned(), icons()));
        resource_shape.extend(shape(vec![
            ("uri", string()),
            ("description", string().optional()),
            ("mimeType", string().optional()),
            ("size", number().optional()),
            ("annotations", annotations().optional()),
            ("_meta", loose_object(Vec::new()).optional()),
            ("type", literal("resource_link")),
        ]));
        let resource_link = object(resource_shape);
        let text_resource = object(resource_contents()).extend(shape(vec![("text", string())]));
        let blob_resource = object(resource_contents()).extend(shape(vec![("blob", base64())]));
        let embedded = object(shape(vec![
            ("type", literal("resource")),
            ("resource", union(vec![text_resource, blob_resource])),
            ("annotations", annotations().optional()),
            ("_meta", meta_record()),
        ]));
        union(vec![
            text_content,
            image_content,
            audio_content,
            resource_link,
            embedded,
        ])
    }

    fn tool_schema_object() -> Schema {
        object(shape(vec![
            ("type", literal("object")),
            ("properties", record(object_like()).optional()),
            ("required", array(string()).optional()),
        ]))
        .catchall(unknown())
    }

    fn tool() -> Schema {
        let mut fields = base_metadata();
        fields.push(("icons".to_owned(), icons()));
        fields.extend(shape(vec![
            ("description", string().optional()),
            ("inputSchema", tool_schema_object()),
            ("outputSchema", tool_schema_object().optional()),
            (
                "annotations",
                object(shape(vec![
                    ("title", string().optional()),
                    ("readOnlyHint", boolean().optional()),
                    ("destructiveHint", boolean().optional()),
                    ("idempotentHint", boolean().optional()),
                    ("openWorldHint", boolean().optional()),
                ]))
                .optional(),
            ),
            (
                "execution",
                object(shape(vec![(
                    "taskSupport",
                    enum_of(&["required", "optional", "forbidden"]).optional(),
                )]))
                .optional(),
            ),
            ("_meta", meta_record()),
        ]));
        object(fields)
    }

    /// `ListToolsResultSchema`
    pub fn list_tools_result() -> Schema {
        result().extend(shape(vec![
            ("nextCursor", string().optional()),
            ("tools", array(tool())),
        ]))
    }

    /// `CallToolResultSchema`
    pub fn call_tool_result() -> Schema {
        result().extend(shape(vec![
            (
                "content",
                array(content_block()).default_value(JsonValue::Array(Vec::new())),
            ),
            ("structuredContent", record(unknown()).optional()),
            ("isError", boolean().optional()),
        ]))
    }

    /// `ToolListChangedNotificationSchema`
    pub fn tool_list_changed_notification() -> Schema {
        notification_schema().extend(shape(vec![
            ("method", literal("notifications/tools/list_changed")),
            ("params", notifications_params().optional()),
        ]))
    }

    /// `InitializedNotificationSchema`
    pub fn initialized_notification() -> Schema {
        notification_schema().extend(shape(vec![
            ("method", literal("notifications/initialized")),
            ("params", notifications_params().optional()),
        ]))
    }

    /// `CancelledNotificationSchema`
    pub fn cancelled_notification() -> Schema {
        notification_schema().extend(shape(vec![
            ("method", literal("notifications/cancelled")),
            (
                "params",
                notifications_params().extend(shape(vec![
                    ("requestId", request_id().optional()),
                    ("reason", string().optional()),
                ])),
            ),
        ]))
    }

    /// `ProgressNotificationSchema`
    pub fn progress_notification() -> Schema {
        notification_schema().extend(shape(vec![
            ("method", literal("notifications/progress")),
            (
                "params",
                notifications_params().extend(shape(vec![
                    ("progress", number()),
                    ("total", number().optional()),
                    ("message", string().optional()),
                    ("progressToken", union(vec![string(), int()])),
                ])),
            ),
        ]))
    }

    /// `PingRequestSchema`
    pub fn ping_request() -> Schema {
        request_schema().extend(shape(vec![
            ("method", literal("ping")),
            ("params", base_request_params().optional()),
        ]))
    }

    /// `isJSONRPCRequest(value)`
    pub fn is_jsonrpc_request(value: &JsonValue) -> bool {
        is_valid(&jsonrpc_request(), value)
    }

    /// `isJSONRPCNotification(value)`
    pub fn is_jsonrpc_notification(value: &JsonValue) -> bool {
        is_valid(&jsonrpc_notification(), value)
    }

    /// `isJSONRPCResultResponse(value)`
    pub fn is_jsonrpc_result_response(value: &JsonValue) -> bool {
        is_valid(&jsonrpc_result_response(), value)
    }

    /// `isJSONRPCErrorResponse(value)`
    pub fn is_jsonrpc_error_response(value: &JsonValue) -> bool {
        is_valid(&jsonrpc_error_response(), value)
    }

    /// `isInitializedNotification(value)`
    pub fn is_initialized_notification(value: &JsonValue) -> bool {
        is_valid(&initialized_notification(), value)
    }
}
