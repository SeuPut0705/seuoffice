//! Gate-only calls into the attachment readers.

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
struct Failure<'a> {
    name: &'a str,
    message: String,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Outcome<'a> {
    Value { value: Value },
    Error { error: Failure<'a> },
}

/// A number as the gate reads it: JSON has no NaN or infinity.
fn number(value: f64) -> Value {
    serde_json::Number::from_f64(value).map_or_else(
        || serde_json::json!({ "$number": if value.is_nan() { "NaN" } else if value.is_sign_negative() { "-Infinity" } else { "Infinity" } }),
        Value::Number,
    )
}

pub fn run(function: &str, text: &str, bytes: &[u8], args: &Value) -> Vec<u8> {
    let string = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or_default();
    // `maxChars` and `budget` travel as the text of a number, so NaN and infinity cross
    let numeric = |key: &str| {
        args.get(key).and_then(|value| {
            value
                .as_str()
                .map(jscompat::to_number)
                .or_else(|| value.as_f64())
        })
    };
    let result = match function {
        "resolveTarget" => Ok(Value::String(file_parse::opc::resolve_target(
            string("basePart"),
            text,
        ))),
        "attachableMaxBytes" => Ok(number(file_parse::attachable::attachable_max_bytes(text))),
        "isAttachableExt" => Ok(Value::Bool(file_parse::attachable::is_attachable_ext(text))),
        "diagramPictureExtOfName" => Ok(file_parse::attachable::diagram_picture_ext_of_name(text)
            .map_or(Value::Null, |s| Value::String(s.to_owned()))),
        "redactMarkdownSource" => {
            file_parse::markdown::redact_markdown_source(text).map(Value::String)
        }
        "redactPptxPartXml" => {
            file_parse::pptx_redaction::redact_pptx_part_xml(text).map(Value::String)
        }
        "docxToText" => {
            file_parse::docx::docx_to_text(bytes, numeric("maxChars")).map(Value::String)
        }
        "xlsxToText" => {
            file_parse::xlsx::xlsx_to_text(bytes, numeric("maxChars")).map(Value::String)
        }
        "sheetXmlByteLimit" => Ok(number(file_parse::xlsx::sheet_xml_byte_limit(
            jscompat::to_number(text),
        ))),
        "clipSheetXml" => Ok(Value::String(file_parse::xlsx::clip_sheet_xml(
            text,
            numeric("budget").unwrap_or(f64::NAN),
            args.get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ))),
        "pptxToText" => file_parse::pptx::pptx_to_text(bytes).map(Value::String),
        "builtinDateFormat" => serde_json::to_value(file_parse::xlsx_dates::builtin_date_format(
            jscompat::to_number(text),
        ))
        .map_err(|error| error.to_string()),
        "classifyFormatCode" => {
            serde_json::to_value(file_parse::xlsx_dates::classify_format_code(text))
                .map_err(|error| error.to_string())
        }
        "formatSerial" => match serde_json::from_value::<file_parse::xlsx_dates::DateFormatParts>(
            args.get("parts").cloned().unwrap_or(Value::Null),
        ) {
            Ok(parts) => Ok(file_parse::xlsx_dates::format_serial(
                jscompat::to_number(text),
                &parts,
                args.get("date1904")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
            .map_or(Value::Null, Value::String)),
            Err(error) => Err(error.to_string()),
        },
        "isTextPart" => Ok(Value::Bool(file_parse::zip_text_parts::is_text_part(text))),
        "readZipTextParts" => file_parse::zip_text_parts::read_zip_text_parts(bytes)
            .map(|bytes| Value::Array(bytes.into_iter().map(Value::from).collect())),
        "decodeCsvBuffer" => Ok(Value::String(file_parse::csv::decode_csv_buffer(
            bytes,
            args.get("preferred").and_then(Value::as_str),
        ))),
        "compoundStreams" => file_parse::compound::read_streams(bytes)
            .and_then(|streams| serde_json::to_value(streams).map_err(|error| error.to_string())),
        _ => Err(format!("unknown attachment reader: {function}")),
    };
    let outcome = match result {
        Ok(value) => Outcome::Value { value },
        Err(message) => Outcome::Error {
            error: Failure {
                name: if message.starts_with("Redaction marks in this file") {
                    "RedactionMarkError"
                } else if message.starts_with("Invalid code point ")
                    || message.starts_with("Invalid column index: ")
                {
                    "RangeError"
                } else if message.starts_with("Cannot read properties of undefined ")
                    || message.starts_with("Cannot set properties of undefined ")
                    || message.starts_with("undefined is not iterable")
                    || message.starts_with("cellRef.toUpperCase is not a function")
                {
                    "TypeError"
                } else {
                    "Error"
                },
                message,
            },
        },
    };
    serde_json::to_vec(&outcome).expect("attachment outcome contains only JSON values")
}
