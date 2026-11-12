use serde_json::Value;

use crate::number_to_string;

/// `String(value)` over a parsed tree, `None` being `undefined`. An array
/// joins its items with commas, a `null` item reading as nothing.
pub fn value_to_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(value) => {
            let mut out = String::new();
            append(&mut out, value);
            out
        }
    }
}

fn append(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            out.push_str(&number_to_string(number.as_f64().unwrap_or(f64::NAN)));
        }
        Value::String(text) => out.push_str(text),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                if !item.is_null() {
                    append(out, item);
                }
            }
        }
        Value::Object(_) => out.push_str("[object Object]"),
    }
}

/// `if (value)` over a parsed tree, `None` being `undefined`.
pub fn value_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_as_javascript_string_does() {
        assert_eq!(value_to_string(None), "undefined");
        assert_eq!(value_to_string(Some(&json!(null))), "null");
        assert_eq!(value_to_string(Some(&json!(1e21))), "1e+21");
        assert_eq!(value_to_string(Some(&json!([1, null, [2, "a"]]))), "1,,2,a");
        assert_eq!(value_to_string(Some(&json!({"a": 1}))), "[object Object]");
    }

    #[test]
    fn truthiness_is_javascript_truthiness() {
        assert!(!value_truthy(None));
        assert!(!value_truthy(Some(&json!(""))));
        assert!(!value_truthy(Some(&json!(0))));
        assert!(value_truthy(Some(&json!([]))));
        assert!(value_truthy(Some(&json!("0"))));
    }
}
