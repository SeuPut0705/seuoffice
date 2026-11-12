//! `invoke` for `@seuoffice/file-parse`: its exports by name (`fileParse.<name>`
//! on the wire), with the TypeScript arguments positionally. A `Uint8Array`
//! is a blob (see [`super`]). An error is answered as `<Name>: <message>`, the
//! name of the class the TypeScript throws, which the binding rebuilds.
//!
//! What the host keeps: reading the file (and the copy of a large zip's text
//! parts from disk), the readers that await (PDF, mind maps, OpenDocument
//! text: passed in as `hosted`), and the steps of `seu_host` (parse5, draw.io).

use serde_json::{Value, json};

use super::InvokeEnv;
use file_parse::{attachable, csv, opc, xlsx_dates, zip_text_parts};

/// What a route answers: `None` is `undefined`.
pub type Out = Result<Option<Value>, String>;

/// The JavaScript class of an error a reader returns, by the start of its message.
pub fn js_error_name(message: &str) -> &'static str {
    if message.starts_with("Redaction marks in this file") {
        "RedactionMarkError"
    } else if message.starts_with("The file is damaged or is not a valid ") {
        "DamagedFileError"
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
    }
}

/// A reader's error as the binding reads it: `<Name>: <message>`.
fn thrown(message: String) -> String {
    format!("{}: {message}", js_error_name(&message))
}

fn text(args: &[Value], index: usize) -> Result<&str, String> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("TypeError: argument {index} is not a string"))
}

/// A number argument; absent and `null` are `None` (`undefined`).
fn number(args: &[Value], index: usize) -> Result<Option<f64>, String> {
    number_of(args.get(index).unwrap_or(&Value::Null))
}

/// A number as the binding sends it: NaN and the infinities by their spelling.
fn number_of(value: &Value) -> Result<Option<f64>, String> {
    jscompat::js_f64_opt(value).map_err(|error| format!("TypeError: {error}"))
}

/// The property `key` of an options object as a number; absent is `None`.
fn option(args: &[Value], index: usize, key: &str) -> Result<Option<f64>, String> {
    match args.get(index).and_then(|options| options.get(key)) {
        None => Ok(None),
        Some(value) => number_of(value),
    }
}

/// A number answer: JSON has no NaN or infinity, so they cross as their spelling.
fn number_out(value: f64) -> Value {
    serde_json::Number::from_f64(value).map_or_else(
        || Value::String(jscompat::number_to_string(value)),
        Value::Number,
    )
}

fn string_out(result: Result<String, String>) -> Out {
    result.map(|text| Some(Value::String(text))).map_err(thrown)
}

pub fn invoke(env: &mut InvokeEnv<'_>, name: &str, args: &[Value]) -> Out {
    let blob = |index: usize| env.blob(args.get(index).unwrap_or(&Value::Null));
    match name {
        // parseFileToText over the bytes the host read: (filePath, bytes,
        // options, hosted). The host has already copied the text parts of a
        // large zip, so the size check is not made again here.
        "parseFileToText" => Ok(Some(file_parse::parse::parse_file_to_text(
            text(args, 0)?,
            blob(1)?,
            file_parse::parse::ParseFileOptions {
                max_chars: option(args, 2, "maxChars")?,
                whole_zip_max_bytes: Some(f64::INFINITY),
            },
            args.get(3).filter(|hosted| !hosted.is_null()),
        ))),
        "docxToText" => string_out(file_parse::docx::docx_to_text(
            blob(0)?,
            option(args, 1, "maxChars")?,
        )),
        "docToText" => {
            string_out(file_parse::doc::doc_to_text(blob(0)?).map_err(|error| error.message))
        }
        "pptToText" => {
            string_out(file_parse::ppt::ppt_to_text(blob(0)?).map_err(|error| error.message))
        }
        "pptxToText" => string_out(file_parse::pptx::pptx_to_text(blob(0)?)),
        "xlsxToText" => string_out(file_parse::xlsx::xlsx_to_text(
            blob(0)?,
            option(args, 1, "maxChars")?,
            option(args, 1, "formulaScanMaxBytes")?,
        )),
        "sheetXmlByteLimit" => Ok(Some(number_out(file_parse::xlsx::sheet_xml_byte_limit(
            number(args, 0)?.unwrap_or(f64::NAN),
        )))),
        "clipSheetXml" => Ok(Some(Value::String(file_parse::xlsx::clip_sheet_xml(
            text(args, 0)?,
            number(args, 1)?.unwrap_or(f64::NAN),
            args.get(2).and_then(Value::as_bool).unwrap_or(false),
        )))),
        "hwpToText" => string_out(file_parse::hwp::hwp_to_text(blob(0)?)),
        "hwpMemosOf" => file_parse::hwp::hwp_memos_of(blob(0)?)
            .map(|memos| Some(Value::Array(memos)))
            .map_err(thrown),
        // the bytes are the caller's own: the binding answers them once this passes
        "checkedHwpBytes" => file_parse::hwp::checked_hwp_bytes(blob(0)?, text(args, 1)?)
            .map(|_| None)
            .map_err(thrown),
        "epubToText" => string_out(file_parse::epub::epub_to_text(blob(0)?)),
        "redactHtmlSource" => string_out(file_parse::html::redact_html_source(text(args, 0)?)),
        "redactMarkdownSource" => {
            string_out(file_parse::markdown::redact_markdown_source(text(args, 0)?))
        }
        "resolveTarget" => Ok(Some(Value::String(opc::resolve_target(
            text(args, 0)?,
            text(args, 1)?,
        )))),
        "isTextPart" => Ok(Some(Value::Bool(zip_text_parts::is_text_part(text(
            args, 0,
        )?)))),
        "builtinDateFormat" => Ok(Some(json!(xlsx_dates::builtin_date_format(
            number(args, 0)?.unwrap_or(f64::NAN)
        )))),
        "classifyFormatCode" => Ok(Some(json!(xlsx_dates::classify_format_code(text(
            args, 0
        )?)))),
        "formatSerial" => {
            let parts: xlsx_dates::DateFormatParts =
                serde_json::from_value(args.get(1).cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("TypeError: argument 1: {error}"))?;
            Ok(Some(json!(xlsx_dates::format_serial(
                number(args, 0)?.unwrap_or(f64::NAN),
                &parts,
                args.get(2).and_then(Value::as_bool).unwrap_or(false),
            ))))
        }
        "decodeCsvBuffer" => Ok(Some(Value::String(csv::decode_csv_buffer(
            blob(0)?,
            args.get(1).and_then(Value::as_str),
        )))),
        "attachableMaxBytes" => Ok(Some(number_out(attachable::attachable_max_bytes(text(
            args, 0,
        )?)))),
        "isAttachableExt" => Ok(Some(Value::Bool(attachable::is_attachable_ext(text(
            args, 0,
        )?)))),
        "diagramPictureExtOfName" => Ok(Some(json!(attachable::diagram_picture_ext_of_name(
            text(args, 0)?
        )))),
        // (pivot | undefined, cacheXml | undefined); `pivot` is `{ text, truncated }`
        "pivotOutputOf" => {
            let pivot = args
                .first()
                .filter(|pivot| !pivot.is_null())
                .map(|pivot| {
                    let text = pivot.get("text").and_then(Value::as_str);
                    let truncated = pivot.get("truncated").and_then(Value::as_bool);
                    text.zip(truncated)
                        .ok_or("TypeError: argument 0 is not { text, truncated }")
                })
                .transpose()?;
            let cache = args.get(1).and_then(Value::as_str);
            let output = file_parse::xlsx_formula_redaction::pivot_output_of(pivot, cache)
                .map_err(thrown)?;
            let area = output.area;
            Ok(Some(json!({
                "area": {
                    "startRow": number_out(area.start_row),
                    "endRow": number_out(area.end_row),
                    "startColumn": number_out(area.start_column),
                    "endColumn": number_out(area.end_column),
                },
                "formula": output.formula,
            })))
        }
        // the constants the binding keeps as TypeScript literals, for its parity test
        "constants" => Ok(Some(json!({
            "ATTACHABLE_EXTS": attachable::ATTACHABLE_EXTS,
            "ATTACHABLE_IMAGE_EXTS": attachable::ATTACHABLE_IMAGE_EXTS,
            "ATTACHABLE_MAX_BYTES": attachable::ATTACHABLE_MAX_BYTES,
            "ATTACHABLE_IMAGE_MAX_BYTES": attachable::ATTACHABLE_IMAGE_MAX_BYTES,
            "WHOLE_ZIP_READ_MAX_BYTES": file_parse::parse::WHOLE_ZIP_READ_MAX_BYTES,
            "PPTX_REDACT_EXT_URI": file_parse::pptx_redaction::PPTX_REDACT_EXT_URI,
        }))),
        _ => Err(format!("no function fileParse.{name}")),
    }
}
