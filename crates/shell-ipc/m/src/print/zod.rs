//! The two zod schemas the sheets print channels parse with
//! (`workbookExportPdfRequestSchema`, `printerInfoSchema` of
//! `apps/sheets/src/shared/desktop-api.ts`), checked by hand. A failure is a
//! `ZodError` whose message is zod 4's own: `JSON.stringify(issues, null, 2)`,
//! issues in the order zod collects them. The shapes below were compared with
//! what zod 4.6 printed for the same inputs; a case they do not cover (a
//! non-plain object with keys of its own) may differ.

use serde_json::{Map, Value, json};
use shell_contract::{IpcError, IpcValue, value::BytesKind};

use crate::value::to_serde;

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const MAX_PDF_TEMPLATE_CHARS: u64 = 12_000_000;
const PAGE_SIZES: [&str; 6] = ["A3", "A4", "A5", "Legal", "Letter", "Tabloid"];

struct Issue {
    head: Vec<(&'static str, Value)>,
    path: Vec<String>,
    message: String,
}

impl Issue {
    fn code(&self) -> &str {
        self.head
            .iter()
            .find(|(k, _)| *k == "code")
            .and_then(|(_, v)| v.as_str())
            .unwrap_or("")
    }

    fn to_value(&self) -> Value {
        let mut map = Map::new();
        for (key, value) in &self.head {
            map.insert((*key).to_owned(), value.clone());
        }
        map.insert("path".into(), json!(self.path));
        map.insert("message".into(), Value::String(self.message.clone()));
        Value::Object(map)
    }

    fn under(mut self, prefix: &[String]) -> Issue {
        let mut path = prefix.to_vec();
        path.append(&mut self.path);
        self.path = path;
        self
    }
}

/// A JSON number as `JSON.stringify` writes it: whole values without `.0`
fn num(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        Value::from(x as i64)
    } else {
        Value::from(x)
    }
}

fn js(x: f64) -> String {
    jscompat::number_to_string(x)
}

/// zod's `parsedType` of the received value
fn received_type(value: &IpcValue) -> String {
    match value {
        IpcValue::Undefined => "undefined".into(),
        IpcValue::Null => "null".into(),
        IpcValue::Bool(_) => "boolean".into(),
        IpcValue::Number(n) if n.is_nan() => "NaN".into(),
        IpcValue::Number(n) if n.is_infinite() => {
            if *n > 0.0 { "Infinity" } else { "-Infinity" }.into()
        }
        IpcValue::Number(_) => "number".into(),
        IpcValue::String(_) => "string".into(),
        IpcValue::Array(_) => "array".into(),
        IpcValue::Object(_) => "object".into(),
        IpcValue::Bytes(BytesKind::Uint8Array, _) => "Uint8Array".into(),
        IpcValue::Bytes(BytesKind::ArrayBuffer, _) => "ArrayBuffer".into(),
        IpcValue::Date(_) => "Date".into(),
    }
}

fn invalid_type(expected: &'static str, value: &IpcValue, path: &[String]) -> Issue {
    let received = received_type(value);
    let mut head = vec![
        ("expected", json!(expected)),
        ("code", json!("invalid_type")),
    ];
    if matches!(value, IpcValue::Number(n) if !n.is_finite()) {
        head.push(("received", json!(received)));
    }
    Issue {
        head,
        path: path.to_vec(),
        message: format!("Invalid input: expected {expected}, received {received}"),
    }
}

fn child(path: &[String], key: &str) -> Vec<String> {
    let mut path = path.to_vec();
    path.push(key.to_owned());
    path
}

fn utf16_len(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

/// `z.string().min(min).max(max)`
fn string(value: &IpcValue, path: &[String], min: Option<u64>, max: u64, out: &mut Vec<Issue>) {
    let IpcValue::String(text) = value else {
        out.push(invalid_type("string", value, path));
        return;
    };
    let len = utf16_len(text);
    if let Some(min) = min
        && len < min
    {
        out.push(Issue {
            head: vec![
                ("origin", json!("string")),
                ("code", json!("too_small")),
                ("minimum", json!(min)),
                ("inclusive", json!(true)),
            ],
            path: path.to_vec(),
            message: format!("Too small: expected string to have >={min} characters"),
        });
    }
    if len > max {
        out.push(Issue {
            head: vec![
                ("origin", json!("string")),
                ("code", json!("too_big")),
                ("maximum", json!(max)),
                ("inclusive", json!(true)),
            ],
            path: path.to_vec(),
            message: format!("Too big: expected string to have <={max} characters"),
        });
    }
}

fn boolean(value: &IpcValue, path: &[String], out: &mut Vec<Issue>) {
    if !matches!(value, IpcValue::Bool(_)) {
        out.push(invalid_type("boolean", value, path));
    }
}

/// `z.number()` with an optional `.int()`, a lower bound (`inclusive`: `.min`,
/// else `.positive()`) and an upper bound
struct Num {
    int: bool,
    min: f64,
    min_inclusive: bool,
    max: f64,
}

fn number(value: &IpcValue, path: &[String], spec: &Num, out: &mut Vec<Issue>) {
    let n = match value {
        IpcValue::Number(n) if n.is_finite() => *n,
        _ => {
            out.push(invalid_type("number", value, path));
            return;
        }
    };
    if spec.int {
        if n.fract() != 0.0 {
            out.push(Issue {
                head: vec![
                    ("expected", json!("int")),
                    ("format", json!("safeint")),
                    ("code", json!("invalid_type")),
                ],
                path: path.to_vec(),
                message: "Invalid input: expected int, received number".into(),
            });
            return;
        }
        let note = "Integers must be within the safe integer range.";
        if n > MAX_SAFE {
            out.push(Issue {
                head: vec![
                    ("code", json!("too_big")),
                    ("maximum", num(MAX_SAFE)),
                    ("note", json!(note)),
                    ("origin", json!("int")),
                    ("inclusive", json!(true)),
                ],
                path: path.to_vec(),
                message: format!("Too big: expected int to be <={}", js(MAX_SAFE)),
            });
        } else if n < -MAX_SAFE {
            out.push(Issue {
                head: vec![
                    ("code", json!("too_small")),
                    ("minimum", num(-MAX_SAFE)),
                    ("note", json!(note)),
                    ("origin", json!("int")),
                    ("inclusive", json!(true)),
                ],
                path: path.to_vec(),
                message: format!("Too small: expected int to be >={}", js(-MAX_SAFE)),
            });
        }
    }
    let below = if spec.min_inclusive {
        n < spec.min
    } else {
        n <= spec.min
    };
    if below {
        let op = if spec.min_inclusive { ">=" } else { ">" };
        out.push(Issue {
            head: vec![
                ("origin", json!("number")),
                ("code", json!("too_small")),
                ("minimum", num(spec.min)),
                ("inclusive", json!(spec.min_inclusive)),
            ],
            path: path.to_vec(),
            message: format!("Too small: expected number to be {op}{}", js(spec.min)),
        });
    }
    if n > spec.max {
        out.push(Issue {
            head: vec![
                ("origin", json!("number")),
                ("code", json!("too_big")),
                ("maximum", num(spec.max)),
                ("inclusive", json!(true)),
            ],
            path: path.to_vec(),
            message: format!("Too big: expected number to be <={}", js(spec.max)),
        });
    }
}

/// What `isObject` of zod accepts: any non-array object (a `Date` or a
/// typed array too)
fn object_like(value: &IpcValue) -> bool {
    matches!(
        value,
        IpcValue::Object(_) | IpcValue::Bytes(..) | IpcValue::Date(_)
    )
}

fn own_keys(value: &IpcValue) -> Vec<String> {
    match value {
        IpcValue::Object(entries) => entries.iter().map(|(k, _)| k.clone()).collect(),
        IpcValue::Bytes(BytesKind::Uint8Array, bytes) => {
            (0..bytes.len()).map(|i| i.to_string()).collect()
        }
        _ => Vec::new(),
    }
}

fn get<'a>(value: &'a IpcValue, key: &str) -> &'a IpcValue {
    crate::value::field(value, key)
}

/// `z.object({...}).strict()`: `Some(value)` when it is an object to read the
/// shape's keys from. The unknown-key issue is added by [`strict_keys`] once
/// the shape's own issues are in.
fn expect_object<'a>(
    value: &'a IpcValue,
    path: &[String],
    out: &mut Vec<Issue>,
) -> Option<&'a IpcValue> {
    if object_like(value) {
        Some(value)
    } else {
        out.push(invalid_type("object", value, path));
        None
    }
}

fn strict_keys(value: &IpcValue, known: &[&str], path: &[String], out: &mut Vec<Issue>) {
    let unknown: Vec<String> = own_keys(value)
        .into_iter()
        .filter(|k| !known.contains(&k.as_str()))
        .collect();
    if unknown.is_empty() {
        return;
    }
    let quoted: Vec<String> = unknown
        .iter()
        .map(|k| serde_json::to_string(k).unwrap_or_default())
        .collect();
    out.push(Issue {
        head: vec![
            ("code", json!("unrecognized_keys")),
            ("keys", json!(unknown)),
        ],
        path: path.to_vec(),
        message: format!(
            "Unrecognized key{}: {}",
            if unknown.len() > 1 { "s" } else { "" },
            quoted.join(", ")
        ),
    });
}

fn optional(value: &IpcValue) -> bool {
    matches!(value, IpcValue::Undefined)
}

fn template(value: &IpcValue, path: &[String], out: &mut Vec<Issue>) {
    if !optional(value) {
        string(value, path, Some(1), MAX_PDF_TEMPLATE_CHARS, out);
    }
}

/// `pdfPageVariantSchema.optional()`
fn page_variant(value: &IpcValue, path: &[String], out: &mut Vec<Issue>) {
    if optional(value) {
        return;
    }
    if let Some(object) = expect_object(value, path, out) {
        template(
            get(object, "headerTemplate"),
            &child(path, "headerTemplate"),
            out,
        );
        template(
            get(object, "footerTemplate"),
            &child(path, "footerTemplate"),
            out,
        );
        strict_keys(object, &["headerTemplate", "footerTemplate"], path, out);
    }
}

/// The custom `{ width, height }` of the page size union, on paths relative to it
fn custom_size(value: &IpcValue, out: &mut Vec<Issue>) {
    let side = Num {
        int: false,
        min: 0.0,
        min_inclusive: false,
        max: 100.0,
    };
    if let Some(object) = expect_object(value, &[], out) {
        number(get(object, "width"), &child(&[], "width"), &side, out);
        number(get(object, "height"), &child(&[], "height"), &side, out);
        strict_keys(object, &["width", "height"], &[], out);
    }
}

/// `z.union([z.enum([...]), z.object({ width, height })])`: zod keeps the one
/// branch that did not fail on the type of the value, else reports both
fn page_size(value: &IpcValue, path: &[String], out: &mut Vec<Issue>) {
    if matches!(value, IpcValue::String(s) if PAGE_SIZES.contains(&s.as_str())) {
        return;
    }
    let mut custom = Vec::new();
    custom_size(value, &mut custom);
    if custom.is_empty() {
        return;
    }
    if custom.iter().all(|i| i.code() != "invalid_type") {
        out.extend(custom.into_iter().map(|i| i.under(path)));
        return;
    }
    let quoted: Vec<String> = PAGE_SIZES.iter().map(|s| format!("\"{s}\"")).collect();
    let option = Issue {
        head: vec![
            ("code", json!("invalid_value")),
            ("values", json!(PAGE_SIZES)),
        ],
        path: Vec::new(),
        message: format!("Invalid option: expected one of {}", quoted.join("|")),
    };
    out.push(Issue {
        head: vec![
            ("code", json!("invalid_union")),
            (
                "errors",
                json!([
                    [option.to_value()],
                    custom.iter().map(Issue::to_value).collect::<Vec<_>>()
                ]),
            ),
        ],
        path: path.to_vec(),
        message: "Invalid input".into(),
    });
}

fn zod_error(issues: &[Issue]) -> IpcError {
    let values: Vec<Value> = issues.iter().map(Issue::to_value).collect();
    IpcError {
        name: Some("ZodError".into()),
        message: serde_json::to_string_pretty(&values).unwrap_or_default(),
    }
}

/// `workbookExportPdfRequestSchema.parse(input)`, to what the print flow reads
#[derive(Debug)]
pub struct PrintRequest {
    pub html: String,
    pub device_name_present: bool,
    /// the keys `printOptionsFor` and `printToPdfOptionsFor` read, as parsed
    pub options: Value,
}

pub fn parse_print_request(input: &IpcValue) -> Result<PrintRequest, IpcError> {
    let mut issues = Vec::new();
    let root: Vec<String> = Vec::new();
    let Some(request) = expect_object(input, &root, &mut issues) else {
        return Err(zod_error(&issues));
    };
    let key = |name: &str| child(&root, name);
    string(
        get(request, "fileName"),
        &key("fileName"),
        Some(1),
        255,
        &mut issues,
    );
    string(
        get(request, "html"),
        &key("html"),
        Some(1),
        20_000_000,
        &mut issues,
    );
    boolean(get(request, "landscape"), &key("landscape"), &mut issues);
    page_size(get(request, "pageSize"), &key("pageSize"), &mut issues);

    let margins_path = key("margins");
    if let Some(margins) = expect_object(get(request, "margins"), &margins_path, &mut issues) {
        let side = Num {
            int: false,
            min: 0.0,
            min_inclusive: true,
            max: 3.0,
        };
        for name in ["top", "bottom", "left", "right"] {
            number(
                get(margins, name),
                &child(&margins_path, name),
                &side,
                &mut issues,
            );
        }
        strict_keys(
            margins,
            &["top", "bottom", "left", "right"],
            &margins_path,
            &mut issues,
        );
    }
    let scale = Num {
        int: false,
        min: 0.1,
        min_inclusive: true,
        max: 2.0,
    };
    number(get(request, "scale"), &key("scale"), &scale, &mut issues);
    template(
        get(request, "headerTemplate"),
        &key("headerTemplate"),
        &mut issues,
    );
    template(
        get(request, "footerTemplate"),
        &key("footerTemplate"),
        &mut issues,
    );
    page_variant(get(request, "firstPage"), &key("firstPage"), &mut issues);
    page_variant(get(request, "evenPages"), &key("evenPages"), &mut issues);
    for name in ["outPath", "saveAsPath"] {
        if !optional(get(request, name)) {
            string(get(request, name), &key(name), Some(1), 4096, &mut issues);
        }
    }
    if !optional(get(request, "deviceName")) {
        string(
            get(request, "deviceName"),
            &key("deviceName"),
            None,
            255,
            &mut issues,
        );
    }
    if !optional(get(request, "copies")) {
        let copies = Num {
            int: true,
            min: 1.0,
            min_inclusive: true,
            max: 999.0,
        };
        number(get(request, "copies"), &key("copies"), &copies, &mut issues);
    }
    if !optional(get(request, "collate")) {
        boolean(get(request, "collate"), &key("collate"), &mut issues);
    }
    strict_keys(
        request,
        &[
            "fileName",
            "html",
            "landscape",
            "pageSize",
            "margins",
            "scale",
            "headerTemplate",
            "footerTemplate",
            "firstPage",
            "evenPages",
            "outPath",
            "saveAsPath",
            "deviceName",
            "copies",
            "collate",
        ],
        &root,
        &mut issues,
    );
    if !issues.is_empty() {
        return Err(zod_error(&issues));
    }

    let mut options = Map::new();
    for name in [
        "landscape",
        "pageSize",
        "margins",
        "scale",
        "deviceName",
        "copies",
        "collate",
    ] {
        let Some(mut value) = to_serde(get(request, name)) else {
            continue;
        };
        // zod's output holds a nested object's keys in the schema's order
        let shape: &[&str] = match name {
            "margins" => &["top", "bottom", "left", "right"],
            "pageSize" => &["width", "height"],
            _ => &[],
        };
        if let Value::Object(map) = &value
            && !shape.is_empty()
        {
            value = Value::Object(
                shape
                    .iter()
                    .filter_map(|k| map.get(*k).map(|v| ((*k).to_owned(), v.clone())))
                    .collect(),
            );
        }
        options.insert(name.to_owned(), value);
    }
    let IpcValue::String(html) = get(request, "html") else {
        unreachable!("html was checked to be a string")
    };
    Ok(PrintRequest {
        html: html.clone(),
        device_name_present: !optional(get(request, "deviceName")),
        options: Value::Object(options),
    })
}

/// `printerInfoSchema.parse({ name, displayName })`
pub fn parse_printer_info(name: &str, display_name: &str) -> Result<(), IpcError> {
    let mut issues = Vec::new();
    for (key, text) in [("name", name), ("displayName", display_name)] {
        string(
            &IpcValue::String(text.to_owned()),
            &[key.to_owned()],
            None,
            255,
            &mut issues,
        );
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(zod_error(&issues))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::{object, string as text};

    fn request() -> Vec<(&'static str, IpcValue)> {
        vec![
            ("fileName", text("a.xlsx")),
            ("html", text("<p>")),
            ("landscape", IpcValue::Bool(false)),
            ("pageSize", text("A4")),
            (
                "margins",
                object([
                    ("top", IpcValue::Number(0.5)),
                    ("bottom", IpcValue::Number(0.5)),
                    ("left", IpcValue::Number(0.5)),
                    ("right", IpcValue::Number(0.5)),
                ]),
            ),
            ("scale", IpcValue::Number(1.0)),
        ]
    }

    fn with(extra: Vec<(&'static str, IpcValue)>) -> IpcValue {
        let mut entries = request();
        for (k, v) in extra {
            entries.retain(|(key, _)| *key != k);
            entries.push((k, v));
        }
        IpcValue::Object(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
        )
    }

    #[test]
    fn a_valid_request_keeps_what_the_print_options_read() {
        let parsed = parse_print_request(&with(vec![("copies", IpcValue::Number(2.0))])).unwrap();
        assert_eq!(parsed.html, "<p>");
        assert!(!parsed.device_name_present);
        assert_eq!(parsed.options["copies"], json!(2.0));
        assert!(parsed.options.get("html").is_none());
    }

    #[test]
    fn issues_read_as_zod_prints_them() {
        let err = parse_print_request(&with(vec![
            ("html", text("")),
            (
                "pageSize",
                IpcValue::Object(vec![
                    ("width".into(), IpcValue::Number(0.0)),
                    ("height".into(), IpcValue::Number(5.0)),
                ]),
            ),
            ("copies", IpcValue::Number(1.5)),
            ("extra", IpcValue::Number(1.0)),
        ]))
        .unwrap_err();
        assert_eq!(err.name.as_deref(), Some("ZodError"));
        let issues: Value = serde_json::from_str(&err.message).unwrap();
        assert_eq!(
            issues,
            json!([
                {"origin":"string","code":"too_small","minimum":1,"inclusive":true,"path":["html"],"message":"Too small: expected string to have >=1 characters"},
                {"origin":"number","code":"too_small","minimum":0,"inclusive":false,"path":["pageSize","width"],"message":"Too small: expected number to be >0"},
                {"expected":"int","format":"safeint","code":"invalid_type","path":["copies"],"message":"Invalid input: expected int, received number"},
                {"code":"unrecognized_keys","keys":["extra"],"path":[],"message":"Unrecognized key: \"extra\""}
            ])
        );
        assert!(
            err.message
                .starts_with("[\n  {\n    \"origin\": \"string\""),
            "{}",
            err.message
        );
    }

    #[test]
    fn a_page_size_that_is_neither_branch_reports_the_union() {
        let err = parse_print_request(&with(vec![("pageSize", text("B7"))])).unwrap_err();
        let issues: Value = serde_json::from_str(&err.message).unwrap();
        assert_eq!(issues[0]["code"], "invalid_union");
        assert_eq!(issues[0]["path"], json!(["pageSize"]));
        assert_eq!(
            issues[0]["errors"][0][0]["message"],
            "Invalid option: expected one of \"A3\"|\"A4\"|\"A5\"|\"Legal\"|\"Letter\"|\"Tabloid\""
        );
        assert_eq!(
            issues[0]["errors"][1][0]["message"],
            "Invalid input: expected object, received string"
        );
    }

    #[test]
    fn a_non_object_and_a_long_printer_name_fail() {
        let err = parse_print_request(&IpcValue::Undefined).unwrap_err();
        assert!(err.message.contains("expected object, received undefined"));
        let long = "x".repeat(256);
        let err = parse_printer_info(&long, "Q").unwrap_err();
        assert_eq!(err.name.as_deref(), Some("ZodError"));
        assert!(
            err.message
                .contains("Too big: expected string to have <=255 characters")
        );
        assert!(parse_printer_info(&"x".repeat(255), "").is_ok());
    }
}
