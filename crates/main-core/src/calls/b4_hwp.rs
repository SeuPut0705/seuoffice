//! The functions of group `b4-hwp` (tools/main-diff/groups/b4-hwp.ts):
//! `apps/hwp/src/main` without Electron.
//!
//! Names are `<ts-file>.<export>`; the three files that other apps have under
//! the same name (`atomic-write`, `print-document`, `save-as-formats`) carry
//! the app: `hwp/<ts-file>.<export>`.
//!
//! Wire forms the specs and this file agree on:
//!
//! - bytes cross as lowercase hex; a function that answers bytes takes a last
//!   argument, `"exact"` for the hex of the bytes or `"inflated"` for what
//!   they hold (the streams of a compound file, the entries of a zip, each
//!   inflated), because a deflate stream is not the same bytes from Node's
//!   zlib and from zlib-rs;
//! - a number a JSON number cannot carry is the string `"NaN"`, `"Infinity"`,
//!   `"-Infinity"` or `"-0"`;
//! - a `Map` crosses as its `[key, value]` entries;
//! - the print windows are fakes driven by a script of outcomes; each call of
//!   one is one `logs` line, as in the TypeScript spec.

use std::cell::RefCell;
use std::collections::HashSet;

use jscompat::{JsMap, JsObject, json_value_from_serde, number_to_string};
use serde_json::{Map, Number, Value};

use super::{Answer, CallError, Context, arg, str_arg};
use crate::hwp::atomic_write::atomic_write_file;
use crate::hwp::dialog_strings::tm;
use crate::hwp::field_kinds::{FieldKinds, field_kinds_of, restore_field_kinds};
use crate::hwp::hwp5_file::{open_hwp, paths_of};
use crate::hwp::ipc::HwpFormat;
use crate::hwp::ipc::PrintPage;
use crate::hwp::print_document::{
    PrintJob, PrintWindow, bad_job, image_file, own_ids, print_job_to_pdf, print_job_to_printer,
    printable_html, side_mm,
};
use crate::hwp::save_as_formats::{
    SaveAsLabelKey, save_as_default_path, save_as_filters, save_as_target,
};
use crate::hwp::save_fixes::{SaveBase, apply_save_fixes};
use crate::hwp::save_plan::{
    backup_path_for, bytes_match_format, needs_backup, with_format_extension,
};
use crate::hwp::section_tails::{
    Caption, SectionTails, TailList, restore_section_tails, section_tails_of,
};
use crate::hwp::tab_widths::{MAX_NEW_TABS, hwpx_memo_count_of, new_tabs_of, write_tab_widths};
use crate::hwp::zlib::inflate_raw_sync;
use crate::node_fs::NodeError;
use crate::packages::compound_file::has_ole2_signature;
use crate::packages::electron_utils::print_window::{JsError, PrintReport};
use crate::packages::i18n::{Lang, normalize_lang};

type Logs = RefCell<Vec<Vec<Value>>>;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // atomic-write.ts
        "hwp/atomic-write.atomicWriteFile" => str_arg(args, 0).and_then(|path| {
            let text = str_arg(args, 1)?;
            atomic_write_file(path, text.as_bytes())
                .map(|()| None)
                .map_err(masked_node)
        }),
        // dialog-strings.ts
        "dialog-strings.tm" => tm_call(args),
        // field-kinds.ts
        "field-kinds.fieldKindsOf" => unhex_arg(args, 0)
            .map(|file| Some(field_kinds_of(&file).map_or(Value::Null, |k| kinds_value(&k)))),
        "field-kinds.restoreFieldKinds" => restore_kinds_call(args),
        // print-document.ts
        "hwp/print-document.sideMm" => num_arg(args, 0).map(|px| Some(num_value(side_mm(px)))),
        "hwp/print-document.ownIds" => str_arg(args, 0).and_then(|svg| {
            let prefix = str_arg(args, 1)?;
            Ok(Some(Value::from(own_ids(svg, prefix))))
        }),
        "hwp/print-document.imageFile" => str_arg(args, 0).and_then(|url| {
            let index = num_arg(args, 1)?;
            Ok(Some(match image_file(url, index) {
                None => Value::Null,
                Some((file_name, bytes)) => {
                    let mut map = Map::new();
                    map.insert("name".into(), Value::from(file_name));
                    map.insert("bytes".into(), Value::from(hex(&bytes)));
                    Value::Object(map)
                }
            }))
        }),
        "hwp/print-document.badJob" => {
            Ok(Some(bad_job(arg(args, 0)).map_or(Value::Null, Value::from)))
        }
        "hwp/print-document.printableHtml" => printable_html_call(args, cx),
        "hwp/print-document.printJobToPdf" => print_job_call(args, cx, true),
        "hwp/print-document.printJobToPrinter" => print_job_call(args, cx, false),
        // save-as-formats.ts
        "hwp/save-as-formats.saveAsFilters" => save_as_filters_call(args, cx),
        "hwp/save-as-formats.saveAsDefaultPath" => str_arg(args, 0).and_then(|suggestion| {
            let offer = bool_arg(args, 1)?;
            Ok(Some(Value::from(save_as_default_path(suggestion, offer))))
        }),
        "hwp/save-as-formats.saveAsTarget" => str_arg(args, 0).and_then(|path| {
            let fallback = format_arg(args, 1)?;
            let offer = bool_arg(args, 2)?;
            let (path, kind) = save_as_target(path, fallback, offer);
            let mut map = Map::new();
            map.insert("path".into(), Value::from(path));
            map.insert("kind".into(), Value::from(kind.as_str()));
            Ok(Some(Value::Object(map)))
        }),
        // save-fixes.ts
        "save-fixes.applySaveFixes" => apply_save_fixes_call(args),
        // save-plan.ts
        "save-plan.backupPathFor" => {
            str_arg(args, 0).map(|path| Some(Value::from(backup_path_for(path))))
        }
        "save-plan.needsBackup" => str_arg(args, 0).and_then(|target| {
            let exists = bool_arg(args, 1)?;
            let written: HashSet<String> = arg(args, 2)
                .and_then(Value::as_array)
                .ok_or_else(|| bad("a list"))?
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad("a string")))
                .collect::<Result<_, _>>()?;
            Ok(Some(Value::Bool(needs_backup(target, exists, &written))))
        }),
        "save-plan.bytesMatchFormat" => unhex_arg(args, 0).and_then(|bytes| {
            let format = format_arg(args, 1)?;
            Ok(Some(Value::Bool(bytes_match_format(&bytes, format))))
        }),
        "save-plan.withFormatExtension" => str_arg(args, 0).and_then(|path| {
            let fallback = format_arg(args, 1)?;
            Ok(Some(Value::from(with_format_extension(path, fallback))))
        }),
        // section-tails.ts
        "section-tails.sectionTailsOf" => unhex_arg(args, 0)
            .map(|file| Some(section_tails_of(&file).map_or(Value::Null, |t| tails_value(&t)))),
        "section-tails.restoreSectionTails" => restore_tails_call(args),
        // tab-widths.ts
        "tab-widths.MAX_NEW_TABS" => Ok(Some(Value::from(MAX_NEW_TABS))),
        "tab-widths.hwpxMemoCountOf" => unhex_arg(args, 0)
            .map(|file| Some(hwpx_memo_count_of(&file).map_or(Value::Null, Value::from))),
        "tab-widths.newTabsOf" => unhex_arg(args, 0).and_then(|file| {
            let format = format_arg(args, 1)?;
            Ok(Some(
                serde_json::to_value(new_tabs_of(&file, format)).expect("spots print"),
            ))
        }),
        "tab-widths.writeTabWidths" => write_tab_widths_call(args),
        _ => return None,
    })
}

// ---- arguments and answers ----

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Result<Vec<u8>, CallError> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return Err(bad("hex"));
    }
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).map_err(|_| bad("hex")))
        .collect()
}

fn unhex_arg(args: &[Value], i: usize) -> Result<Vec<u8>, CallError> {
    unhex(str_arg(args, i)?)
}

fn bool_arg(args: &[Value], i: usize) -> Result<bool, CallError> {
    match arg(args, i) {
        Some(Value::Bool(flag)) => Ok(*flag),
        _ => Err(bad("a flag")),
    }
}

fn format_arg(args: &[Value], i: usize) -> Result<HwpFormat, CallError> {
    HwpFormat::parse(str_arg(args, i)?).ok_or_else(|| bad("a format"))
}

fn number_of(value: Option<&Value>) -> Result<f64, CallError> {
    match value {
        Some(Value::Number(n)) => n.as_f64().ok_or_else(|| bad("a number")),
        Some(Value::String(text)) => match text.as_str() {
            "NaN" => Ok(f64::NAN),
            "Infinity" => Ok(f64::INFINITY),
            "-Infinity" => Ok(f64::NEG_INFINITY),
            "-0" => Ok(-0.0),
            _ => Err(bad("a number")),
        },
        _ => Err(bad("a number")),
    }
}

fn num_arg(args: &[Value], i: usize) -> Result<f64, CallError> {
    number_of(arg(args, i))
}

fn num_value(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn mode_arg(args: &[Value], i: usize) -> Result<&str, CallError> {
    match str_arg(args, i)? {
        mode @ ("exact" | "inflated") => Ok(mode),
        _ => Err(bad("a mode")),
    }
}

/// `.replace(/\/ieum-hwp-print-[A-Za-z0-9]{6}/g, '/ieum-hwp-print-<rand>')`:
/// the random part of a temp folder's name differs on each side.
fn mask_rand(text: &str) -> String {
    const PREFIX: &str = "/ieum-hwp-print-";
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(PREFIX) {
        let after = at + PREFIX.len();
        let random = &rest[after..];
        let six = random.len() >= 6 && random.bytes().take(6).all(|b| b.is_ascii_alphanumeric());
        out.push_str(&rest[..after]);
        if six {
            out.push_str("<rand>");
            rest = &random[6..];
        } else {
            rest = random;
        }
    }
    out.push_str(rest);
    out
}

/// `.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')`
fn mask_tmp(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut at = 0;
    let mut copied = 0;
    while at + 17 <= bytes.len() {
        let window = &bytes[at..at + 17];
        if window[0] == b'.'
            && window[1..13]
                .iter()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            && &window[13..] == b".tmp"
        {
            out.push_str(&text[copied..at]);
            out.push_str(".<hex>.tmp");
            at += 17;
            copied = at;
        } else {
            at += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

fn masked_node(mut error: NodeError) -> CallError {
    error.message = mask_tmp(&error.message);
    error.into()
}

fn error_of(error: JsError) -> CallError {
    CallError {
        code: error.code,
        message: mask_rand(&error.message),
    }
}

// ---- dialog-strings ----

fn tm_call(args: &[Value]) -> Answer {
    let lang: Lang = normalize_lang(Some(str_arg(args, 0)?));
    let key = str_arg(args, 1)?;
    let vars: Option<JsObject<jscompat::JsonValue>> = match arg(args, 2) {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) => {
            let mut object = JsObject::new();
            for (name, value) in map {
                object.set(name.clone(), json_value_from_serde(value));
            }
            Some(object)
        }
        Some(_) => return Err(bad("vars")),
    };
    Ok(Some(Value::from(tm(lang, key, vars.as_ref()))))
}

// ---- bytes out ----

/// `[...].map(...)` of a compound file or a zip: what the bytes hold, each
/// stream or entry inflated, so that a deflate stream's own bytes do not count.
fn normalized(bytes: &[u8]) -> Value {
    let mut out = Map::new();
    if has_ole2_signature(bytes) {
        let value = match open_hwp(bytes) {
            Ok(Some(opened)) => {
                let paths = paths_of(&opened);
                let root_len = paths
                    .first()
                    .map_or(0.0, |root| root.encode_utf16().count() as f64);
                let mut streams = Vec::new();
                for path in &paths {
                    if path.ends_with('/') {
                        continue;
                    }
                    let name = format!("/{}", jscompat::slice_utf16(path, root_len, None));
                    let raw = crate::hwp::cfb::find(&opened.cfb, &name)
                        .and_then(|at| opened.cfb.file_index[at].content.clone())
                        .unwrap_or_default();
                    let body = name.starts_with("/BodyText/") || name == "/DocInfo";
                    let shown = if opened.compressed && body {
                        match inflate_raw_sync(&raw, 64 * 1024 * 1024) {
                            Ok(data) => Value::from(hex(&data)),
                            Err(_) => Value::Null,
                        }
                    } else {
                        Value::from(hex(&raw))
                    };
                    streams.push(Value::Array(vec![Value::from(name), shown]));
                }
                let mut hwp = Map::new();
                hwp.insert("compressed".into(), Value::Bool(opened.compressed));
                hwp.insert("streams".into(), Value::Array(streams));
                Value::Object(hwp)
            }
            _ => Value::Null,
        };
        out.insert("hwp".into(), value);
    } else {
        out.insert("zip".into(), zip_listing(bytes));
    }
    Value::Object(out)
}

/// The entries of a zip by its central directory: `[name, method, inflated hex]`.
fn zip_listing(zip: &[u8]) -> Value {
    fn u16_at(zip: &[u8], at: usize) -> Option<usize> {
        zip.get(at..at + 2)
            .map(|b| usize::from(u16::from_le_bytes([b[0], b[1]])))
    }
    fn u32_at(zip: &[u8], at: usize) -> Option<usize> {
        zip.get(at..at + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
    }
    let listing = (|| -> Option<Vec<Value>> {
        let end = (0..=zip.len().checked_sub(22)?)
            .rev()
            .find(|&at| u32_at(zip, at) == Some(0x0605_4b50))?;
        let count = u16_at(zip, end + 10)?;
        let mut at = u32_at(zip, end + 16)?;
        let mut entries = Vec::new();
        for _ in 0..count {
            let method = u16_at(zip, at + 10)?;
            let compressed = u32_at(zip, at + 20)?;
            let name_length = u16_at(zip, at + 28)?;
            let extra = u16_at(zip, at + 30)?;
            let comment = u16_at(zip, at + 32)?;
            let local = u32_at(zip, at + 42)?;
            let name =
                String::from_utf8_lossy(zip.get(at + 46..at + 46 + name_length)?).into_owned();
            let data_at = local + 30 + u16_at(zip, local + 26)? + u16_at(zip, local + 28)?;
            let raw = zip.get(data_at..data_at + compressed)?;
            let content = if method == 8 {
                inflate_raw_sync(raw, 64 * 1024 * 1024).ok()?
            } else {
                raw.to_vec()
            };
            entries.push(Value::Array(vec![
                Value::from(name),
                Value::from(method),
                Value::from(hex(&content)),
            ]));
            at += 46 + name_length + extra + comment;
        }
        Some(entries)
    })();
    listing.map_or(Value::Null, Value::Array)
}

fn bytes_out(bytes: &[u8], mode: &str) -> Value {
    if mode == "exact" {
        Value::from(hex(bytes))
    } else {
        normalized(bytes)
    }
}

// ---- field-kinds ----

fn kinds_value(kinds: &FieldKinds) -> Value {
    Value::Array(
        kinds
            .iter()
            .map(|(digest, kind)| Value::Array(vec![Value::from(digest), num_value(*kind)]))
            .collect(),
    )
}

fn kinds_arg(value: &Value) -> Result<FieldKinds, CallError> {
    let mut kinds: FieldKinds = JsMap::new();
    for entry in value.as_array().ok_or_else(|| bad("kinds"))? {
        let pair = entry.as_array().ok_or_else(|| bad("a kind"))?;
        let digest = pair
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| bad("a digest"))?;
        kinds.set(digest, number_of(pair.get(1))?);
    }
    Ok(kinds)
}

fn restore_kinds_call(args: &[Value]) -> Answer {
    let saved = unhex_arg(args, 0)?;
    let kept = kinds_arg(arg(args, 1).ok_or_else(|| bad("kinds"))?)?;
    let mode = mode_arg(args, 2)?;
    let restored = restore_field_kinds(&saved, &kept);
    let mut map = Map::new();
    map.insert("bytes".into(), bytes_out(&restored.bytes, mode));
    map.insert("restored".into(), Value::from(restored.restored));
    Ok(Some(Value::Object(map)))
}

// ---- section-tails ----

fn tails_value(tails: &SectionTails) -> Value {
    let mut map = Map::new();
    map.insert("sections".into(), num_value(tails.sections));
    map.insert(
        "tails".into(),
        Value::Array(
            tails
                .tails
                .iter()
                .map(|(index, lists)| {
                    Value::Array(vec![
                        Value::from(*index),
                        Value::Array(
                            lists
                                .iter()
                                .map(|list| {
                                    let mut item = Map::new();
                                    item.insert("key".into(), Value::from(list.key.clone()));
                                    item.insert("bytes".into(), Value::from(hex(&list.bytes)));
                                    if let Some(memo) = list.memo {
                                        item.insert("memo".into(), Value::from(memo));
                                    }
                                    Value::Object(item)
                                })
                                .collect(),
                        ),
                    ])
                })
                .collect(),
        ),
    );
    map.insert(
        "ids".into(),
        Value::Array(
            tails
                .ids
                .iter()
                .map(|(kind, digests)| {
                    Value::Array(vec![
                        Value::from(kind),
                        Value::Array(digests.iter().map(|d| Value::from(d.clone())).collect()),
                    ])
                })
                .collect(),
        ),
    );
    map.insert(
        "binData".into(),
        Value::Array(
            tails
                .bin_data
                .iter()
                .map(|n| Value::from(n.clone()))
                .collect(),
        ),
    );
    map.insert(
        "captions".into(),
        Value::Array(
            tails
                .captions
                .iter()
                .map(|(digest, caption)| {
                    let mut item = Map::new();
                    item.insert("bytes".into(), Value::from(hex(&caption.bytes)));
                    item.insert("level".into(), Value::from(caption.level));
                    Value::Array(vec![Value::from(digest), Value::Object(item)])
                })
                .collect(),
        ),
    );
    Value::Object(map)
}

fn tails_arg(value: &Value) -> Result<SectionTails, CallError> {
    let object = value.as_object().ok_or_else(|| bad("section tails"))?;
    let field = |name: &str| object.get(name).ok_or_else(|| bad(name));
    let list_of = |value: &Value| -> Result<Vec<Value>, CallError> {
        value.as_array().cloned().ok_or_else(|| bad("a list"))
    };
    let mut tails = Vec::new();
    for entry in list_of(field("tails")?)? {
        let pair = list_of(&entry)?;
        let index = pair
            .first()
            .and_then(Value::as_u64)
            .ok_or_else(|| bad("a section index"))? as usize;
        let mut lists = Vec::new();
        for item in list_of(pair.get(1).ok_or_else(|| bad("lists"))?)? {
            let item = item.as_object().ok_or_else(|| bad("a list"))?;
            lists.push(TailList {
                key: item
                    .get("key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| bad("a key"))?
                    .to_owned(),
                bytes: unhex(
                    item.get("bytes")
                        .and_then(Value::as_str)
                        .ok_or_else(|| bad("bytes"))?,
                )?,
                memo: item.get("memo").and_then(Value::as_u64).map(|m| m as u32),
            });
        }
        tails.push((index, lists));
    }
    let mut ids: JsMap<Vec<String>> = JsMap::new();
    for entry in list_of(field("ids")?)? {
        let pair = list_of(&entry)?;
        let kind = pair
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| bad("a kind"))?;
        let digests = list_of(pair.get(1).ok_or_else(|| bad("digests"))?)?
            .iter()
            .map(|d| d.as_str().map(str::to_owned).ok_or_else(|| bad("a digest")))
            .collect::<Result<Vec<_>, _>>()?;
        ids.set(kind, digests);
    }
    let bin_data = list_of(field("binData")?)?
        .iter()
        .map(|d| d.as_str().map(str::to_owned).ok_or_else(|| bad("a name")))
        .collect::<Result<Vec<_>, _>>()?;
    let mut captions: JsMap<Caption> = JsMap::new();
    for entry in list_of(field("captions")?)? {
        let pair = list_of(&entry)?;
        let digest = pair
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| bad("a digest"))?;
        let item = pair
            .get(1)
            .and_then(Value::as_object)
            .ok_or_else(|| bad("a caption"))?;
        captions.set(
            digest,
            Caption {
                bytes: unhex(
                    item.get("bytes")
                        .and_then(Value::as_str)
                        .ok_or_else(|| bad("bytes"))?,
                )?,
                level: item
                    .get("level")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| bad("a level"))? as u32,
            },
        );
    }
    Ok(SectionTails {
        sections: number_of(Some(field("sections")?))?,
        tails,
        ids,
        bin_data,
        captions,
    })
}

fn restore_tails_call(args: &[Value]) -> Answer {
    let saved = unhex_arg(args, 0)?;
    let kept = tails_arg(arg(args, 1).ok_or_else(|| bad("section tails"))?)?;
    let mode = mode_arg(args, 2)?;
    let result = restore_section_tails(&saved, &kept);
    let mut map = Map::new();
    map.insert("bytes".into(), bytes_out(&result.bytes, mode));
    map.insert("restored".into(), Value::from(result.restored));
    if let Some(skipped) = result.skipped {
        map.insert("skipped".into(), Value::from(skipped.as_str()));
    }
    Ok(Some(Value::Object(map)))
}

// ---- tab-widths and save-fixes ----

fn write_tab_widths_call(args: &[Value]) -> Answer {
    let file = unhex_arg(args, 0)?;
    let format = format_arg(args, 1)?;
    let measured = arg(args, 2)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("measured tabs"))?;
    let mode = mode_arg(args, 3)?;
    let result = write_tab_widths(&file, format, measured);
    let mut map = Map::new();
    map.insert("bytes".into(), bytes_out(&result.bytes, mode));
    map.insert("written".into(), Value::from(result.written));
    Ok(Some(Value::Object(map)))
}

/// `[bytes, format, tabs | null, base, mode]` with `base` as `{ tails, kinds }`,
/// each `null` where the TypeScript has `undefined`.
fn apply_save_fixes_call(args: &[Value]) -> Answer {
    let data = unhex_arg(args, 0)?;
    let format = format_arg(args, 1)?;
    let tabs: Option<&[Value]> = match arg(args, 2) {
        None | Some(Value::Null) => None,
        Some(Value::Array(tabs)) => Some(tabs),
        Some(_) => return Err(bad("tabs")),
    };
    let base_value = arg(args, 3)
        .and_then(Value::as_object)
        .ok_or_else(|| bad("a base"))?;
    let base = SaveBase {
        tails: match base_value.get("tails") {
            None | Some(Value::Null) => None,
            Some(value) => Some(tails_arg(value)?),
        },
        kinds: match base_value.get("kinds") {
            None | Some(Value::Null) => None,
            Some(value) => Some(kinds_arg(value)?),
        },
    };
    let mode = mode_arg(args, 4)?;
    let result = apply_save_fixes(&data, format, tabs, &base);
    let mut map = Map::new();
    map.insert("bytes".into(), bytes_out(&result.bytes, mode));
    if let Some(skipped) = result.tails_skipped {
        map.insert("tailsSkipped".into(), Value::from(skipped.as_str()));
    }
    Ok(Some(Value::Object(map)))
}

// ---- save-as-formats ----

fn save_as_filters_call(args: &[Value], cx: &mut Context) -> Answer {
    let fallback = format_arg(args, 0)?;
    let offer = bool_arg(args, 1)?;
    let mut logs: Vec<Vec<Value>> = Vec::new();
    let filters = save_as_filters(fallback, offer, &mut |key: SaveAsLabelKey| {
        logs.push(vec![Value::from("label"), Value::from(key.as_str())]);
        format!("L({})", key.as_str())
    });
    cx.logs.extend(logs);
    Ok(Some(Value::Array(
        filters
            .into_iter()
            .map(|filter| {
                let mut map = Map::new();
                map.insert("name".into(), Value::from(filter.name));
                map.insert(
                    "extensions".into(),
                    Value::Array(filter.extensions.into_iter().map(Value::from).collect()),
                );
                Value::Object(map)
            })
            .collect(),
    )))
}

// ---- print-document ----

fn pages_arg(value: Option<&Value>) -> Result<Vec<PrintPage>, CallError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| bad("pages"))?
        .iter()
        .map(|page| {
            Ok(PrintPage {
                svg: page
                    .get("svg")
                    .and_then(Value::as_str)
                    .ok_or_else(|| bad("an svg"))?
                    .to_owned(),
                width: number_of(page.get("width"))?,
                height: number_of(page.get("height"))?,
            })
        })
        .collect()
}

fn printable_html_call(args: &[Value], cx: &mut Context) -> Answer {
    let pages = pages_arg(arg(args, 0))?;
    let mut logs: Vec<Vec<Value>> = Vec::new();
    let html = printable_html(&pages, &mut |index| {
        logs.push(vec![Value::from("picture"), num_value(index)]);
        format!("<{}>", number_to_string(index))
    });
    cx.logs.extend(logs);
    Ok(Some(Value::from(html)))
}

/// The window of the specs, driven by `{ createWindow, loadFile, printToPDF,
/// pdfHex, destroyThrows, print }`.
struct FakeWindow<'a> {
    script: &'a Value,
    logs: &'a Logs,
    work_dir: &'a RefCell<Option<String>>,
}

fn script_is(script: &Value, key: &str, text: &str) -> bool {
    script.get(key).and_then(Value::as_str) == Some(text)
}

impl FakeWindow<'_> {
    fn log(&self, line: Vec<Value>) {
        self.logs.borrow_mut().push(line);
    }
}

/// The folder as the spec shows it: each file by name, `print.html` as text, the rest as hex.
fn listing(dir: &str) -> Value {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    Value::Array(
        names
            .into_iter()
            .map(|name| {
                let bytes = std::fs::read(format!("{dir}/{name}")).unwrap_or_default();
                let shown = if name == "print.html" {
                    Value::from(String::from_utf8_lossy(&bytes).into_owned())
                } else {
                    Value::from(hex(&bytes))
                };
                Value::Array(vec![Value::from(name), shown])
            })
            .collect(),
    )
}

impl PrintWindow for FakeWindow<'_> {
    fn load_file(&mut self, path: &str) -> Result<(), JsError> {
        let dir = std::path::Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        *self.work_dir.borrow_mut() = Some(dir.clone());
        self.log(vec![
            Value::from("loadFile"),
            Value::from(mask_rand(path)),
            listing(&dir),
        ]);
        if script_is(self.script, "loadFile", "throws") {
            return Err(JsError::plain("load failed"));
        }
        Ok(())
    }

    fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, JsError> {
        self.log(vec![Value::from("printToPDF"), options.clone()]);
        if script_is(self.script, "printToPDF", "throws") {
            return Err(JsError::plain("printToPDF threw"));
        }
        let pdf = self
            .script
            .get("pdfHex")
            .and_then(Value::as_str)
            .unwrap_or("");
        unhex(pdf).map_err(|e| JsError::plain(e.message))
    }

    fn print(&mut self, options: &Value) -> Result<PrintReport, JsError> {
        self.log(vec![Value::from("print"), options.clone()]);
        let outcome = self.script.get("print");
        if matches!(outcome, Some(Value::String(mode)) if mode == "throws") {
            return Err(JsError::plain("print threw"));
        }
        let success = outcome
            .and_then(|o| o.get("success"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let failure_reason = outcome
            .and_then(|o| o.get("reason"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        Ok(PrintReport {
            success,
            failure_reason,
        })
    }

    fn destroy(&mut self) -> Result<(), JsError> {
        self.log(vec![Value::from("destroy")]);
        if self.script.get("destroyThrows") == Some(&Value::Bool(true)) {
            return Err(JsError::plain("destroy threw"));
        }
        Ok(())
    }
}

/// `os.tmpdir()` on a POSIX host
fn os_tmpdir() -> String {
    let dir = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "/tmp".to_owned());
    if dir.len() > 1 && dir.ends_with('/') {
        dir[..dir.len() - 1].to_owned()
    } else {
        dir
    }
}

/// `[job, script]`
fn print_job_call(args: &[Value], cx: &mut Context, to_pdf: bool) -> Answer {
    let job = arg(args, 0).ok_or_else(|| bad("a job"))?;
    let script = arg(args, 1).ok_or_else(|| bad("a script"))?;
    let print_job = PrintJob {
        pages: pages_arg(job.get("pages"))?,
        images: job
            .get("images")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("images"))?
            .iter()
            .map(|image| {
                image
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| bad("an image"))
            })
            .collect::<Result<_, _>>()?,
    };
    let logs: Logs = RefCell::new(Vec::new());
    let work_dir: RefCell<Option<String>> = RefCell::new(None);
    let tmp = os_tmpdir();
    let mut create = || -> Result<FakeWindow<'_>, JsError> {
        logs.borrow_mut().push(vec![Value::from("createWindow")]);
        if script_is(script, "createWindow", "throws") {
            return Err(JsError::plain("createWindow threw"));
        }
        Ok(FakeWindow {
            script,
            logs: &logs,
            work_dir: &work_dir,
        })
    };
    let answer = if to_pdf {
        print_job_to_pdf(&print_job, &tmp, &mut create).map(|pdf| Value::from(hex(&pdf)))
    } else {
        print_job_to_printer(&print_job, &tmp, &mut create).map(Value::Bool)
    };
    if let Some(dir) = work_dir.borrow().as_deref() {
        let _ = std::fs::remove_dir_all(dir);
    }
    cx.logs.extend(logs.into_inner());
    answer.map(Some).map_err(error_of)
}
