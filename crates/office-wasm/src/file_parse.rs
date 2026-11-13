//! Gate-only calls into the attachment readers.

use serde::Serialize;
use serde_json::Value;

use crate::invoke::file_parse::js_error_name;

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

/// What a reader written to answer `Option<Result<Value, String>>` threw, as
/// `{ name, message }`: the legacy readers write `name\u{1}message`, the HWP
/// reader only the message, named as the binding names it.
fn delegated(
    function: &str,
    text: &str,
    bytes: &[u8],
    args: &Value,
) -> Option<Result<Value, (String, String)>> {
    if function == "epubToText" {
        return crate::epub_xml::run_named(function, text, bytes, args);
    }
    if let Some(result) = crate::file_parse_legacy::run(function, text, bytes, args) {
        return Some(result.map_err(|thrown| match thrown.split_once('\u{1}') {
            Some((name, message)) => (name.to_owned(), message.to_owned()),
            None => ("Error".to_owned(), thrown),
        }));
    }
    let result = crate::file_parse_hwp::run(function, text, bytes, args)?;
    Some(result.map_err(|message| (js_error_name(&message).to_owned(), message)))
}

pub fn run(function: &str, text: &str, bytes: &[u8], args: &Value) -> Vec<u8> {
    if let Some(result) = delegated(function, text, bytes, args) {
        let outcome = match result {
            Ok(value) => serde_json::json!({ "value": value }),
            Err((name, message)) => {
                serde_json::json!({ "error": { "name": name, "message": message } })
            }
        };
        return serde_json::to_vec(&outcome).expect("attachment outcome contains only JSON values");
    }
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
        "parseFileToText" => Ok(file_parse::parse::parse_file_to_text(
            text,
            bytes,
            file_parse::parse::ParseFileOptions {
                max_chars: args.get("maxChars").and_then(Value::as_f64),
                whole_zip_max_bytes: args.get("wholeZipMaxBytes").and_then(Value::as_f64),
            },
            args.get("hosted"),
        )),
        "fileHoldsHiddenContent" => {
            file_parse::hidden_content::file_holds_hidden_content(bytes, string("ext"))
                .map(Value::Bool)
        }
        "xmlHoldsMark" => Ok(Value::Bool(file_parse::hidden_content::xml_holds_mark(text))),
        "markdownHoldsMark" => {
            file_parse::hidden_content::markdown_holds_mark(text).map(Value::Bool)
        }
        "htmlHoldsMark" => Ok(Value::Bool(file_parse::hidden_content::html_holds_mark(text))),
        "redactHtmlSource" => file_parse::html::redact_html_source(text).map(Value::String),
        "redactPptxPartXml" => {
            file_parse::pptx_redaction::redact_pptx_part_xml(text).map(Value::String)
        }
        "docxToText" => {
            file_parse::docx::docx_to_text(bytes, numeric("maxChars")).map(Value::String)
        }
        "xlsxToText" => file_parse::xlsx::xlsx_to_text(
            bytes,
            numeric("maxChars"),
            numeric("formulaScanMaxBytes"),
        )
        .map(Value::String),
        "xlsxWithheldCells" => file_parse::xlsx::xlsx_withheld_cells(bytes).map(|withheld| {
            // `queries` is a list of `[sheet, ref, hasFormula]`; the answer to each is its marker or null
            withheld.map_or(Value::Null, |withheld| {
                Value::Array(
                    args.get("queries")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .map(|query| {
                            let text = |index: usize| {
                                query.get(index).and_then(Value::as_str).unwrap_or_default()
                            };
                            let has_formula =
                                query.get(2).and_then(Value::as_bool).unwrap_or(false);
                            withheld
                                .marker(text(0), text(1), has_formula)
                                .map_or(Value::Null, Value::String)
                        })
                        .collect(),
                )
            })
        }),
        "unknownCellMarker" => Ok(Value::String(file_parse::xlsx::unknown_cell_marker())),
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
                name: js_error_name(&message),
                message,
            },
        },
    };
    serde_json::to_vec(&outcome).expect("attachment outcome contains only JSON values")
}
