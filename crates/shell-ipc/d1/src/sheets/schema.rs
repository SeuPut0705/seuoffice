//! The shallow `zod` checks the sheets handlers run on a renderer's request
//! before they use it (`schema.parse(input)`). A failure is thrown as the
//! `ZodError` of zod 4: no error name, the issues as indented JSON.
//!
//! Only the shapes the handlers' control flow depends on live here. A deep
//! schema (the save request's cell edits, visuals and structural ops) is the
//! engine's: [`super::engine::WorkbookEngine::parse_save_request`].

use serde_json::{Map, Value};
use shell_contract::{IpcError, IpcValue};

use crate::value::as_str;

#[derive(Clone, Debug)]
enum Kind {
    Str {
        min: Option<usize>,
        max: Option<usize>,
        exact: Option<usize>,
        uuid: bool,
    },
    Num {
        int: bool,
        min: Option<(f64, bool)>,
        max: Option<f64>,
    },
    Pattern {
        matches: fn(&str) -> bool,
        source: &'static str,
    },
    Bool,
    Enum(&'static [&'static str]),
    Arr {
        item: Box<Ty>,
        min: Option<usize>,
        max: Option<usize>,
    },
    Obj {
        fields: Vec<(&'static str, Ty)>,
        strict: bool,
    },
}

/// One schema node
#[derive(Clone, Debug)]
pub struct Ty {
    kind: Kind,
    optional: bool,
}

pub fn string() -> Ty {
    Ty::of(Kind::Str {
        min: None,
        max: None,
        exact: None,
        uuid: false,
    })
}

pub fn uuid() -> Ty {
    Ty::of(Kind::Str {
        min: None,
        max: None,
        exact: None,
        uuid: true,
    })
}

/// `z.string().regex(pattern)`: `source` is the pattern as `String(regex)` shows it
pub fn pattern(matches: fn(&str) -> bool, source: &'static str) -> Ty {
    Ty::of(Kind::Pattern { matches, source })
}

pub fn int() -> Ty {
    Ty::of(Kind::Num {
        int: true,
        min: None,
        max: None,
    })
}

pub fn boolean() -> Ty {
    Ty::of(Kind::Bool)
}

pub fn one_of(options: &'static [&'static str]) -> Ty {
    Ty::of(Kind::Enum(options))
}

pub fn array(item: Ty) -> Ty {
    Ty::of(Kind::Arr {
        item: Box::new(item),
        min: None,
        max: None,
    })
}

/// `z.object({...}).strict()`
pub fn strict(fields: Vec<(&'static str, Ty)>) -> Ty {
    Ty::of(Kind::Obj {
        fields,
        strict: true,
    })
}

impl Ty {
    fn of(kind: Kind) -> Ty {
        Ty {
            kind,
            optional: false,
        }
    }

    pub fn optional(mut self) -> Ty {
        self.optional = true;
        self
    }

    pub fn min(mut self, n: usize) -> Ty {
        match &mut self.kind {
            Kind::Str { min, .. } | Kind::Arr { min, .. } => *min = Some(n),
            _ => {}
        }
        self
    }

    pub fn max(mut self, n: usize) -> Ty {
        match &mut self.kind {
            Kind::Str { max, .. } | Kind::Arr { max, .. } => *max = Some(n),
            Kind::Num { max, .. } => *max = Some(n as f64),
            _ => {}
        }
        self
    }

    /// `.nonnegative()`
    pub fn nonneg(mut self) -> Ty {
        if let Kind::Num { min, .. } = &mut self.kind {
            *min = Some((0.0, true));
        }
        self
    }

    /// `.min(n)` of a number: at least `n`
    pub fn at_least(mut self, n: usize) -> Ty {
        if let Kind::Num { min, .. } = &mut self.kind {
            *min = Some((n as f64, true));
        }
        self
    }

    /// `.positive()`
    pub fn positive(mut self) -> Ty {
        if let Kind::Num { min, .. } = &mut self.kind {
            *min = Some((0.0, false));
        }
        self
    }
}

const UUID_PATTERN: &str = "/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/";

fn is_uuid(text: &str) -> bool {
    if text == "00000000-0000-0000-0000-000000000000"
        || text == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    let parts: Vec<&str> = text.split('-').collect();
    let lens = [8usize, 4, 4, 4, 12];
    if parts.len() != 5 {
        return false;
    }
    if !parts
        .iter()
        .zip(lens)
        .all(|(part, len)| part.len() == len && part.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return false;
    }
    let version = parts[2].as_bytes()[0];
    let variant = parts[3].as_bytes()[0].to_ascii_lowercase();
    (b'1'..=b'8').contains(&version) && matches!(variant, b'8' | b'9' | b'a' | b'b')
}

fn received(value: &IpcValue) -> &'static str {
    match value {
        IpcValue::Undefined => "undefined",
        IpcValue::Null => "null",
        IpcValue::Bool(_) => "boolean",
        IpcValue::Number(x) if x.is_nan() => "NaN",
        IpcValue::Number(x) if x.is_infinite() && *x > 0.0 => "Infinity",
        IpcValue::Number(x) if x.is_infinite() => "-Infinity",
        IpcValue::Number(_) => "number",
        IpcValue::String(_) => "string",
        IpcValue::Array(_) => "array",
        IpcValue::Bytes(..) | IpcValue::Date(_) | IpcValue::Object(_) => "object",
    }
}

fn js_number(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        Value::from(x as i64)
    } else {
        serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
    }
}

struct Issues {
    list: Vec<Value>,
}

impl Issues {
    fn push(&mut self, mut head: Vec<(&str, Value)>, path: &[Value], message: String) {
        let mut object = Map::new();
        for (key, value) in head.drain(..) {
            object.insert(key.to_owned(), value);
        }
        object.insert("path".into(), Value::Array(path.to_vec()));
        object.insert("message".into(), Value::String(message));
        self.list.push(Value::Object(object));
    }

    fn invalid_type(&mut self, expected: &str, got: &IpcValue, path: &[Value]) {
        self.push(
            vec![
                ("expected", Value::from(expected)),
                ("code", Value::from("invalid_type")),
            ],
            path,
            format!(
                "Invalid input: expected {expected}, received {}",
                received(got)
            ),
        );
    }

    fn too_small(
        &mut self,
        origin: &str,
        minimum: f64,
        inclusive: bool,
        exact: bool,
        path: &[Value],
        what: &str,
    ) {
        let mut head = vec![
            ("origin", Value::from(origin)),
            ("code", Value::from("too_small")),
            ("minimum", js_number(minimum)),
            ("inclusive", Value::Bool(inclusive)),
        ];
        if exact {
            head.push(("exact", Value::Bool(true)));
        }
        let qualifier = if exact {
            format!("exactly {}", js_number(minimum))
        } else if inclusive {
            format!(">={}", js_number(minimum))
        } else {
            format!(">{}", js_number(minimum))
        };
        let message = if origin == "number" {
            format!("Too small: expected number to be {qualifier}")
        } else {
            format!("Too small: expected {origin} to have {qualifier} {what}")
        };
        self.push(head, path, message);
    }

    fn too_big(&mut self, origin: &str, maximum: f64, path: &[Value], what: &str) {
        let head = vec![
            ("origin", Value::from(origin)),
            ("code", Value::from("too_big")),
            ("maximum", js_number(maximum)),
            ("inclusive", Value::Bool(true)),
        ];
        let message = if origin == "number" {
            format!("Too big: expected number to be <={}", js_number(maximum))
        } else {
            format!(
                "Too big: expected {origin} to have <={} {what}",
                js_number(maximum)
            )
        };
        self.push(head, path, message);
    }
}

fn walk(ty: &Ty, value: &IpcValue, path: &mut Vec<Value>, issues: &mut Issues) {
    if ty.optional && matches!(value, IpcValue::Undefined) {
        return;
    }
    match &ty.kind {
        Kind::Str {
            min,
            max,
            exact,
            uuid,
        } => {
            let IpcValue::String(text) = value else {
                return issues.invalid_type("string", value, path);
            };
            let length = text.encode_utf16().count();
            if *uuid && !is_uuid(text) {
                issues.push(
                    vec![
                        ("origin", Value::from("string")),
                        ("code", Value::from("invalid_format")),
                        ("format", Value::from("uuid")),
                        ("pattern", Value::from(UUID_PATTERN)),
                    ],
                    path,
                    "Invalid UUID".into(),
                );
            }
            if let Some(n) = exact {
                if length < *n {
                    issues.too_small("string", *n as f64, true, true, path, "characters");
                } else if length > *n {
                    issues.push(
                        vec![
                            ("origin", Value::from("string")),
                            ("code", Value::from("too_big")),
                            ("maximum", js_number(*n as f64)),
                            ("inclusive", Value::Bool(true)),
                            ("exact", Value::Bool(true)),
                        ],
                        path,
                        format!("Too big: expected string to have exactly {n} characters"),
                    );
                }
            }
            if let Some(n) = min
                && length < *n
            {
                issues.too_small("string", *n as f64, true, false, path, "characters");
            }
            if let Some(n) = max
                && length > *n
            {
                issues.too_big("string", *n as f64, path, "characters");
            }
        }
        Kind::Pattern { matches, source } => {
            let IpcValue::String(text) = value else {
                return issues.invalid_type("string", value, path);
            };
            if !matches(text) {
                issues.push(
                    vec![
                        ("origin", Value::from("string")),
                        ("code", Value::from("invalid_format")),
                        ("format", Value::from("regex")),
                        ("pattern", Value::from(*source)),
                    ],
                    path,
                    format!("Invalid string: must match pattern {source}"),
                );
            }
        }
        Kind::Num { int, min, max } => {
            let IpcValue::Number(x) = value else {
                return issues.invalid_type("number", value, path);
            };
            if !x.is_finite() {
                return issues.invalid_type("number", value, path);
            }
            if *int && x.fract() != 0.0 {
                issues.push(
                    vec![
                        ("expected", Value::from("int")),
                        ("format", Value::from("safeint")),
                        ("code", Value::from("invalid_type")),
                    ],
                    path,
                    "Invalid input: expected int, received number".into(),
                );
                return;
            }
            if let Some((limit, inclusive)) = min
                && (if *inclusive {
                    *x < *limit
                } else {
                    *x <= *limit
                })
            {
                issues.too_small("number", *limit, *inclusive, false, path, "");
            }
            if let Some(limit) = max
                && *x > *limit
            {
                issues.too_big("number", *limit, path, "");
            }
        }
        Kind::Bool => {
            if !matches!(value, IpcValue::Bool(_)) {
                issues.invalid_type("boolean", value, path);
            }
        }
        Kind::Enum(options) => {
            if !as_str(value).is_some_and(|text| options.contains(&text)) {
                issues.push(
                    vec![
                        ("code", Value::from("invalid_value")),
                        (
                            "values",
                            Value::Array(options.iter().map(|o| Value::from(*o)).collect()),
                        ),
                    ],
                    path,
                    format!(
                        "Invalid option: expected one of {}",
                        options
                            .iter()
                            .map(|o| format!("\"{o}\""))
                            .collect::<Vec<_>>()
                            .join("|")
                    ),
                );
            }
        }
        Kind::Arr { item, min, max } => {
            let IpcValue::Array(items) = value else {
                return issues.invalid_type("array", value, path);
            };
            let before = issues.list.len();
            if let Some(n) = min
                && items.len() < *n
            {
                issues.too_small("array", *n as f64, true, false, path, "items");
            }
            if let Some(n) = max
                && items.len() > *n
            {
                issues.too_big("array", *n as f64, path, "items");
            }
            if issues.list.len() != before {
                return;
            }
            for (index, element) in items.iter().enumerate() {
                path.push(Value::from(index as u64));
                walk(item, element, path, issues);
                path.pop();
            }
        }
        Kind::Obj { fields, strict } => {
            let IpcValue::Object(entries) = value else {
                return issues.invalid_type("object", value, path);
            };
            for (name, field_ty) in fields {
                let found = entries
                    .iter()
                    .find(|(key, _)| key == name)
                    .map_or(&IpcValue::Undefined, |(_, v)| v);
                path.push(Value::from(*name));
                walk(field_ty, found, path, issues);
                path.pop();
            }
            if *strict {
                let extra: Vec<&str> = entries
                    .iter()
                    .map(|(key, _)| key.as_str())
                    .filter(|key| !fields.iter().any(|(name, _)| name == key))
                    .collect();
                if !extra.is_empty() {
                    let message = if extra.len() == 1 {
                        format!("Unrecognized key: \"{}\"", extra[0])
                    } else {
                        format!(
                            "Unrecognized keys: {}",
                            extra
                                .iter()
                                .map(|k| format!("\"{k}\""))
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                    };
                    issues.push(
                        vec![
                            ("code", Value::from("unrecognized_keys")),
                            (
                                "keys",
                                Value::Array(extra.iter().map(|k| Value::from(*k)).collect()),
                            ),
                        ],
                        path,
                        message,
                    );
                }
            }
        }
    }
}

/// The `ZodError` of a failed parse: its issues, indented as `JSON.stringify(issues, null, 2)`
pub fn zod_error(issues: Vec<Value>) -> IpcError {
    IpcError {
        name: None,
        message: serde_json::to_string_pretty(&Value::Array(issues)).unwrap_or_default(),
    }
}

/// A custom issue, as a `superRefine` adds one
pub fn custom_issue(message: &str) -> IpcError {
    // a custom issue keeps `message` ahead of `path`
    let mut issue = Map::new();
    issue.insert("code".into(), Value::from("custom"));
    issue.insert("message".into(), Value::from(message));
    issue.insert("path".into(), Value::Array(Vec::new()));
    zod_error(vec![Value::Object(issue)])
}

/// `schema.parse(value)`: Ok when the value matches
pub fn parse(ty: &Ty, value: &IpcValue) -> Result<(), IpcError> {
    let mut issues = Issues { list: Vec::new() };
    walk(ty, value, &mut Vec::new(), &mut issues);
    if issues.list.is_empty() {
        Ok(())
    } else {
        Err(zod_error(issues.list))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::{num, obj, string as text};

    #[test]
    fn issues_read_as_zod_four_wrote_them() {
        let schema = strict(vec![("sessionId", uuid()), ("n", int().nonneg())]);
        let error = parse(&schema, &obj([("n", num(-1.0)), ("x", num(1.0))])).unwrap_err();
        assert_eq!(error.name, None);
        let issues: Value = serde_json::from_str(&error.message).unwrap();
        let messages: Vec<&str> = issues
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["message"].as_str().unwrap())
            .collect();
        assert_eq!(
            messages,
            [
                "Invalid input: expected string, received undefined",
                "Too small: expected number to be >=0",
                "Unrecognized key: \"x\""
            ]
        );
        let ok = obj([
            ("sessionId", text("123e4567-e89b-42d3-a456-426614174000")),
            ("n", num(2.0)),
        ]);
        assert!(parse(&schema, &ok).is_ok());
    }
}
