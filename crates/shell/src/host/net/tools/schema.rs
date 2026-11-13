//! A tool's `outputSchema` validators for the MCP hub: what the SDK's
//! `AjvJsonSchemaValidator` does (`new Ajv({ strict: false, validateFormats:
//! true, validateSchema: false, allErrors: true })` plus ajv-formats; SDK
//! 1.32.1, `validation/ajv-provider.js`) over the `jsonschema` crate.
//!
//! Matched: draft-07 when the schema names no `$schema` (Ajv's default class),
//! every error reported (`allErrors`), formats checked and unknown formats
//! ignored, no schema check on compile, the message in Ajv's `errorsText` form
//! (`data/path must ...`, joined by `, `).
//!
//! Not matched (the contract's section 10 row):
//! - a `$schema` the crate knows (2019-09, 2020-12) compiles here; Ajv's
//!   default class throws "no schema with key or ref";
//! - `$ref` to a remote or file address does not resolve (the crate is built
//!   without `resolve-http` and `resolve-file`) and fails the compile, as an
//!   unresolvable `$ref` does in Ajv, with the crate's words;
//! - the order of the errors, and with `anyOf`/`oneOf` the errors of the
//!   branches Ajv lists before the combinator's own, follow the crate;
//! - messages of keywords the table below does not know are the crate's own;
//!   `uniqueItems` lacks Ajv's "(items ## j and i are identical)", `contains`
//!   says "at least 1 valid item(s)" without Ajv's `minContains` forms;
//! - a compile error's text is the crate's, not Ajv's.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Mutex;

use jscompat::{JsonValue, json_value_to_serde};
use jsonschema::error::{TypeKind, ValidationError, ValidationErrorKind};
use jsonschema::{Draft, Validator};
use main_core::packages::mcp_sdk::client::OutputCheck;
use serde_json::Value;

/// The compiled validators, by the number `compile` gave
#[derive(Default)]
pub(super) struct OutputSchemas {
    validators: Mutex<Compiled>,
}

#[derive(Default)]
struct Compiled {
    next: u64,
    by_number: HashMap<u64, Validator>,
}

impl OutputSchemas {
    /// `ajv.compile(schema)`: the validator's number, or the message of the error
    pub(super) fn compile(&self, schema: &JsonValue) -> Result<u64, String> {
        let schema = json_value_to_serde(schema);
        if !matches!(schema, Value::Object(_) | Value::Bool(_)) {
            return Err("schema must be object or boolean".to_owned());
        }
        let options = jsonschema::options()
            .should_validate_formats(true)
            .should_ignore_unknown_formats(true);
        // Ajv's default class is draft-07
        let options = if schema.get("$schema").is_some_and(Value::is_string) {
            options
        } else {
            options.with_draft(Draft::Draft7)
        };
        let validator = options.build(&schema).map_err(|error| error.to_string())?;
        let mut compiled = self
            .validators
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        compiled.next += 1;
        let number = compiled.next;
        compiled.by_number.insert(number, validator);
        Ok(number)
    }

    /// `validator(structuredContent)`
    pub(super) fn check(&self, number: u64, content: &JsonValue) -> OutputCheck {
        let compiled = self
            .validators
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(validator) = compiled.by_number.get(&number) else {
            return OutputCheck::Threw(format!("no validator {number}"));
        };
        let content = json_value_to_serde(content);
        let run = catch_unwind(AssertUnwindSafe(|| {
            validator
                .iter_errors(&content)
                .flat_map(|error| messages(&error))
                .collect::<Vec<_>>()
        }));
        match run {
            Ok(errors) if errors.is_empty() => OutputCheck::Valid,
            Ok(errors) => OutputCheck::Invalid(errors.join(", ")),
            Err(panic) => OutputCheck::Threw(
                panic
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| panic.downcast_ref::<&str>().map(|text| (*text).to_owned()))
                    .unwrap_or_else(|| "the validator failed".to_owned()),
            ),
        }
    }
}

/// `dataVar + instancePath + " " + message` of Ajv's `errorsText`, one per
/// reported error (Ajv reports an unexpected property once each)
fn messages(error: &ValidationError<'_>) -> Vec<String> {
    let at = format!("data{}", error.instance_path());
    let said = |message: String| format!("{at} {message}");
    match error.kind() {
        ValidationErrorKind::AdditionalProperties { unexpected } => unexpected
            .iter()
            .map(|_| said("must NOT have additional properties".to_owned()))
            .collect(),
        kind => vec![said(message(kind, error))],
    }
}

/// Ajv's `message` of the keyword
fn message(kind: &ValidationErrorKind, error: &ValidationError<'_>) -> String {
    match kind {
        ValidationErrorKind::Required { property } => {
            let name = property.as_str().map_or_else(|| property.to_string(), str::to_owned);
            format!("must have required property '{name}'")
        }
        ValidationErrorKind::Type { kind } => {
            let names = match kind {
                TypeKind::Single(single) => single.to_string(),
                TypeKind::Multiple(set) => set
                    .iter()
                    .map(|single| single.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
            };
            format!("must be {names}")
        }
        ValidationErrorKind::Enum { .. } => "must be equal to one of the allowed values".to_owned(),
        ValidationErrorKind::Constant { .. } => "must be equal to constant".to_owned(),
        ValidationErrorKind::Minimum { limit } => format!("must be >= {limit}"),
        ValidationErrorKind::Maximum { limit } => format!("must be <= {limit}"),
        ValidationErrorKind::ExclusiveMinimum { limit } => format!("must be > {limit}"),
        ValidationErrorKind::ExclusiveMaximum { limit } => format!("must be < {limit}"),
        ValidationErrorKind::MultipleOf { multiple_of } => {
            format!("must be multiple of {multiple_of}")
        }
        ValidationErrorKind::MinLength { limit } => {
            format!("must NOT have fewer than {limit} characters")
        }
        ValidationErrorKind::MaxLength { limit } => {
            format!("must NOT have more than {limit} characters")
        }
        ValidationErrorKind::MinItems { limit } => {
            format!("must NOT have fewer than {limit} items")
        }
        ValidationErrorKind::MaxItems { limit } => {
            format!("must NOT have more than {limit} items")
        }
        ValidationErrorKind::AdditionalItems { limit } => {
            format!("must NOT have more than {limit} items")
        }
        ValidationErrorKind::MinProperties { limit } => {
            format!("must NOT have fewer than {limit} properties")
        }
        ValidationErrorKind::MaxProperties { limit } => {
            format!("must NOT have more than {limit} properties")
        }
        ValidationErrorKind::Pattern { pattern } => format!("must match pattern \"{pattern}\""),
        ValidationErrorKind::Format { format } => format!("must match format \"{format}\""),
        ValidationErrorKind::AnyOf { .. } => "must match a schema in anyOf".to_owned(),
        ValidationErrorKind::OneOfNotValid { .. }
        | ValidationErrorKind::OneOfMultipleValid { .. } => {
            "must match exactly one schema in oneOf".to_owned()
        }
        ValidationErrorKind::Not { .. } => "must NOT be valid".to_owned(),
        ValidationErrorKind::UniqueItems => "must NOT have duplicate items".to_owned(),
        ValidationErrorKind::Contains => "must contain at least 1 valid item(s)".to_owned(),
        ValidationErrorKind::FalseSchema => "boolean schema is false".to_owned(),
        _ => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use jscompat::json_parse;

    use super::*;

    fn json(text: &str) -> JsonValue {
        json_parse(text).expect("test JSON")
    }

    const SCHEMA: &str = r#"{
        "type": "object",
        "properties": { "name": { "type": "string" }, "count": { "type": "integer" } },
        "required": ["name"]
    }"#;

    #[test]
    fn a_missing_required_property_is_invalid() {
        let schemas = OutputSchemas::default();
        let number = schemas.compile(&json(SCHEMA)).expect("compiles");
        match schemas.check(number, &json(r#"{ "count": 2 }"#)) {
            OutputCheck::Invalid(message) => {
                assert_eq!(message, "data must have required property 'name'");
            }
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn a_matching_object_is_valid() {
        let schemas = OutputSchemas::default();
        let number = schemas.compile(&json(SCHEMA)).expect("compiles");
        assert_eq!(
            schemas.check(number, &json(r#"{ "name": "a", "count": 2 }"#)),
            OutputCheck::Valid
        );
    }

    #[test]
    fn every_error_is_reported_with_its_path() {
        let schemas = OutputSchemas::default();
        let number = schemas.compile(&json(SCHEMA)).expect("compiles");
        match schemas.check(number, &json(r#"{ "name": 1, "count": "x" }"#)) {
            OutputCheck::Invalid(message) => {
                assert!(message.contains("data/name must be string"), "{message}");
                assert!(message.contains("data/count must be integer"), "{message}");
            }
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn a_bad_schema_is_an_error() {
        let schemas = OutputSchemas::default();
        assert!(schemas.compile(&json(r#"{ "type": "nonsense" }"#)).is_err());
        assert!(schemas.compile(&json("3")).is_err());
    }

    #[test]
    fn validators_are_kept_by_their_number() {
        let schemas = OutputSchemas::default();
        let strings = schemas.compile(&json(r#"{ "type": "string" }"#)).unwrap();
        let numbers = schemas.compile(&json(r#"{ "type": "number" }"#)).unwrap();
        assert_ne!(strings, numbers);
        assert_eq!(schemas.check(strings, &json(r#""a""#)), OutputCheck::Valid);
        assert!(matches!(
            schemas.check(numbers, &json(r#""a""#)),
            OutputCheck::Invalid(_)
        ));
        assert!(matches!(
            schemas.check(99, &json("1")),
            OutputCheck::Threw(_)
        ));
    }
}
