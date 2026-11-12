//! The functions of group `files` (tools/main-diff/groups/files.ts).
//!
//! A `null` argument is an argument left out where the TypeScript has a
//! default (`maxBytes`, a `Date`).

use super::{Answer, CallError, Context, arg, str_arg};
use crate::node_fs::NodeError;
use crate::packages::electron_utils::atomic_write::{
    atomic_copy_file, atomic_move_file, atomic_write_file, atomic_write_via, is_save_temp_name,
    temp_path_beside, write_json_atomic,
};
use crate::shell::app_routing::{self, app_for_path, document_extension, rename_stays_in_app};
use crate::shell::crash_heartbeat::{
    HEARTBEAT_FILE, HEARTBEAT_MS, HeartbeatEnd, HeartbeatOptions, gone_entry_from, heartbeat_path,
    parse_heartbeat, start_heartbeat,
};
use crate::shell::crash_log::{
    self, CRASH_LOG_FILE, CRASH_LOG_MAX_BYTES, CrashEntry, Thrown, append_crash_log, crash_line,
    error_reason,
};
use crate::shell::recent_files::{
    self, EXT_FAMILY, STAT_PATHS_MAX, cap_stat_paths, matches_ext_family, normalize_recent_query,
    page_recent_paths, stat_path_entries, stat_path_entries_async,
};
use crate::shell::rename_validation::{
    self, is_same_file, is_valid_raw_rename_name, is_valid_rename_name, pdf_save_as_target,
};
use jscompat::{JsRegex, JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Number, Value};
use std::cell::Cell;
use std::collections::HashSet;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "app-routing.DOCX_RE" => re_test(app_routing::docx_re(), args),
        "app-routing.ODT_RE" => re_test(app_routing::odt_re(), args),
        "app-routing.WORD97_RE" => re_test(app_routing::word97_re(), args),
        "app-routing.ODS_RE" => re_test(app_routing::ods_re(), args),
        "app-routing.XLSX_RE" => re_test(app_routing::xlsx_re(), args),
        "app-routing.PPTX_RE" => re_test(app_routing::pptx_re(), args),
        "app-routing.PDF_RE" => re_test(app_routing::pdf_re(), args),
        "app-routing.HTML_RE" => re_test(app_routing::html_re(), args),
        "app-routing.MINDMAP_RE" => re_test(app_routing::mindmap_re(), args),
        "app-routing.HWP_RE" => re_test(app_routing::hwp_re(), args),
        "app-routing.EPUB_RE" => re_test(app_routing::epub_re(), args),
        "app-routing.DIAGRAM_RE" => re_test(app_routing::diagram_re(), args),
        "app-routing.TEXT_RE" => re_test(app_routing::text_re(), args),
        "app-routing.documentExtension" => {
            str_arg(args, 0).map(|name| Some(Value::from(document_extension(name))))
        }
        "app-routing.appForPath" => str_arg(args, 0).map(|path| {
            app_for_path(path).map(|kind| serde_json::to_value(kind).expect("a kind prints"))
        }),
        "app-routing.renameStaysInApp" => str_arg(args, 0).and_then(|from| {
            let new_name = str_arg(args, 1)?;
            Ok(Some(Value::Bool(rename_stays_in_app(from, new_name))))
        }),
        "recent-files.STAT_PATHS_MAX" => Ok(Some(Value::from(STAT_PATHS_MAX))),
        "recent-files.EXT_FAMILY" => Ok(Some(ext_family())),
        "recent-files.statPathEntries" => stat_entries(args, stat_path_entries),
        "recent-files.statPathEntriesAsync" => stat_entries(args, stat_path_entries_async),
        "recent-files.capStatPaths" => string_list(args, 0).map(|paths| {
            Some(Value::Array(
                cap_stat_paths(&paths)
                    .into_iter()
                    .map(Value::from)
                    .collect(),
            ))
        }),
        "recent-files.normalizeRecentQuery" => {
            let raw = arg(args, 0).map(json_value_from_serde);
            normalize_recent_query(raw.as_ref())
                .map(|query| Some(serde_json::to_value(query).expect("a query prints")))
                .map_err(|e| CallError::plain(e.0))
        }
        "recent-files.matchesExtFamily" => str_arg(args, 0).and_then(|entry_ext| {
            let filter_ext = str_arg(args, 1)?;
            matches_ext_family(entry_ext, filter_ext)
                .map(|hit| Some(Value::Bool(hit)))
                .map_err(|e| CallError::plain(e.0))
        }),
        "recent-files.pageRecentPaths" => page_recent(args),
        "rename-validation.RENAME_ILLEGAL_NAME_CHARS" => {
            re_test(rename_validation::rename_illegal_name_chars(), args)
        }
        "rename-validation.isValidRawRenameName" => {
            str_arg(args, 0).map(|name| Some(Value::Bool(is_valid_raw_rename_name(name))))
        }
        "rename-validation.isValidRenameName" => {
            str_arg(args, 0).map(|name| Some(Value::Bool(is_valid_rename_name(name))))
        }
        "rename-validation.isSameFile" => str_arg(args, 0).and_then(|a| {
            let b = str_arg(args, 1)?;
            Ok(Some(Value::Bool(is_same_file(a, b))))
        }),
        "rename-validation.pdfSaveAsTarget" => pdf_target(args),
        "crash-log.CRASH_LOG_FILE" => Ok(Some(Value::from(CRASH_LOG_FILE))),
        "crash-log.CRASH_LOG_MAX_BYTES" => Ok(Some(num(CRASH_LOG_MAX_BYTES))),
        "crash-log.crashLine" => crash_line_call(args, cx),
        "crash-log.errorReason" => Ok(Some(Value::from(error_reason(&thrown_arg(args))))),
        "crash-log.appendCrashLog" => append_call(args, cx),
        "crash-heartbeat.HEARTBEAT_FILE" => Ok(Some(Value::from(HEARTBEAT_FILE))),
        "crash-heartbeat.HEARTBEAT_MS" => Ok(Some(num(HEARTBEAT_MS))),
        "crash-heartbeat.heartbeatPath" => {
            str_arg(args, 0).map(|dir| Some(Value::from(heartbeat_path(dir))))
        }
        "crash-heartbeat.parseHeartbeat" => {
            let raw = arg(args, 0).map(json_value_from_serde);
            Ok(Some(match parse_heartbeat(raw.as_ref()) {
                Some(beat) => serde_json::to_value(beat).expect("a heartbeat prints"),
                None => Value::Null,
            }))
        }
        "crash-heartbeat.goneEntryFrom" => gone_entry_call(args),
        "crash-heartbeat.startHeartbeat" => start_heartbeat_call(args, cx),
        "atomic-write.isSaveTempName" => {
            str_arg(args, 0).map(|name| Some(Value::Bool(is_save_temp_name(name))))
        }
        "atomic-write.tempPathBeside" => {
            str_arg(args, 0).map(|path| Some(Value::from(mask_tmp(&temp_path_beside(path)))))
        }
        "atomic-write.atomicWriteFile" => str_arg(args, 0).and_then(|path| {
            let text = str_arg(args, 1)?;
            atomic_write_file(path, text.as_bytes())
                .map(|()| None)
                .map_err(masked)
        }),
        "atomic-write.atomicCopyFile" => str_arg(args, 0).and_then(|source| {
            let path = str_arg(args, 1)?;
            atomic_copy_file(source, path)
                .map(|()| None)
                .map_err(masked)
        }),
        "atomic-write.atomicMoveFile" => str_arg(args, 0).and_then(|temp| {
            let path = str_arg(args, 1)?;
            atomic_move_file(temp, path).map(|()| None).map_err(masked)
        }),
        "atomic-write.atomicWriteVia" => write_via_call(args),
        "atomic-write.writeJsonAtomic" => str_arg(args, 0).and_then(|path| {
            let value = arg(args, 1)
                .map(json_value_from_serde)
                .ok_or_else(|| bad("a value"))?;
            write_json_atomic(path, &value)
                .map(|()| None)
                .map_err(masked)
        }),
        _ => return None,
    })
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

/// `.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')`: a temp name's random part
/// differs on each side, so both sides write it as `<hex>`.
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

fn masked(mut error: NodeError) -> CallError {
    error.message = mask_tmp(&error.message);
    error.into()
}

/// `[text]`: `RE.test(text)`
fn re_test(re: &JsRegex, args: &[Value]) -> Answer {
    Ok(Some(Value::Bool(re.test(str_arg(args, 0)?))))
}

fn ext_family() -> Value {
    let mut map = Map::new();
    for (key, family) in EXT_FAMILY {
        map.insert(
            (*key).to_owned(),
            Value::Array(family.iter().map(|e| Value::from(*e)).collect()),
        );
    }
    Value::Object(map)
}

fn string_list(args: &[Value], i: usize) -> Result<Vec<String>, CallError> {
    arg(args, i)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list"))?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad("a string")))
        .collect()
}

fn string_set(args: &[Value], i: usize) -> Result<HashSet<String>, CallError> {
    Ok(string_list(args, i)?.into_iter().collect())
}

fn stat_entries(
    args: &[Value],
    stat: fn(&[String], &HashSet<String>) -> Vec<recent_files::RecentEntry>,
) -> Answer {
    let paths = string_list(args, 0)?;
    let starred = string_set(args, 1)?;
    Ok(Some(
        serde_json::to_value(stat(&paths, &starred)).expect("entries print"),
    ))
}

/// `[paths, raw, starredPaths]`
fn page_recent(args: &[Value]) -> Answer {
    let paths = string_list(args, 0)?;
    let raw = arg(args, 1).map(json_value_from_serde);
    let starred = string_set(args, 2)?;
    page_recent_paths(&paths, raw.as_ref(), &starred)
        .map(|page| Some(serde_json::to_value(page).expect("a page prints")))
        .map_err(|e| CallError::plain(e.0))
}

/// `[picked: { canceled, filePath? }, currentPath]`
fn pdf_target(args: &[Value]) -> Answer {
    let picked = arg(args, 0).ok_or_else(|| bad("picked"))?;
    let canceled = jscompat::value_truthy(picked.get("canceled"));
    let file_path = match picked.get("filePath") {
        None | Some(Value::Null) => None,
        Some(Value::String(path)) => Some(path.as_str()),
        Some(_) => return Err(bad("filePath")),
    };
    let current = str_arg(args, 1)?;
    Ok(Some(
        pdf_save_as_target(canceled, file_path, current).map_or(Value::Null, Value::from),
    ))
}

fn entry_arg(args: &[Value], i: usize) -> Result<CrashEntry, CallError> {
    match arg(args, i).map(json_value_from_serde) {
        Some(JsonValue::Object(entry)) => Ok(entry),
        _ => Err(bad("an entry")),
    }
}

/// a `Date` argument: the number at `i`, `cx.now` when null or left out
fn date_arg(args: &[Value], i: usize, cx: &Context) -> f64 {
    arg(args, i).and_then(Value::as_f64).unwrap_or(cx.now_ms)
}

fn invalid_time(_: crash_log::InvalidTimeValue) -> CallError {
    CallError::plain("Invalid time value")
}

/// `[entry, nowMs | null]`
fn crash_line_call(args: &[Value], cx: &Context) -> Answer {
    let entry = entry_arg(args, 0)?;
    crash_line(&entry, date_arg(args, 1, cx))
        .map(|line| Some(Value::from(line)))
        .map_err(invalid_time)
}

/// `[file, entry, maxBytes | null, nowMs | null]`
fn append_call(args: &[Value], cx: &Context) -> Answer {
    let file = str_arg(args, 0)?;
    let entry = entry_arg(args, 1)?;
    let max_bytes = arg(args, 2)
        .and_then(Value::as_f64)
        .unwrap_or(CRASH_LOG_MAX_BYTES);
    append_crash_log(file, &entry, max_bytes, date_arg(args, 3, cx))
        .map(|()| None)
        .map_err(invalid_time)
}

/// `[x]`: an object with `isError: true` stands for an `Error` holding its
/// `name` and `code` keys; anything else is its own value.
fn thrown_arg(args: &[Value]) -> Thrown {
    match arg(args, 0) {
        Some(Value::Object(object)) if object.get("isError") == Some(&Value::Bool(true)) => {
            Thrown::Error {
                name: object.get("name").map(json_value_from_serde),
                code: object.get("code").map(json_value_from_serde),
            }
        }
        Some(Value::Object(_) | Value::Array(_) | Value::Null) => Thrown::Other("object"),
        Some(Value::Bool(_)) => Thrown::Other("boolean"),
        Some(Value::Number(_)) => Thrown::Other("number"),
        Some(Value::String(_)) => Thrown::Other("string"),
        None => Thrown::Other("undefined"),
    }
}

/// `[heartbeat | null, now]`
fn gone_entry_call(args: &[Value]) -> Answer {
    let previous = arg(args, 0).map(json_value_from_serde);
    let now = arg(args, 1)
        .and_then(Value::as_f64)
        .ok_or_else(|| bad("now"))?;
    let previous = previous.as_ref().and_then(|raw| parse_heartbeat(Some(raw)));
    Ok(Some(match gone_entry_from(previous.as_ref(), now) {
        Some(entry) => json_value_to_serde(&JsonValue::Object(entry)),
        None => Value::Null,
    }))
}

/// `[{ userDataDir, logPath, memory, memoryThrows?, writeThrows?, steps }]`:
/// the clock counts up from `cx.now` by one millisecond a call, `steps` are
/// `"quit"`, `"os"` or `"stop"` on the handle, and the handle is stopped at the end.
fn start_heartbeat_call(args: &[Value], cx: &Context) -> Answer {
    let options = arg(args, 0).ok_or_else(|| bad("options"))?;
    let field = |key: &str| {
        options
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| bad(key))
    };
    let (user_data_dir, log_path) = (field("userDataDir")?, field("logPath")?);
    let memory = options
        .get("memory")
        .map(json_value_from_serde)
        .unwrap_or(JsonValue::Null);
    let memory_throws = options.get("memoryThrows") == Some(&Value::Bool(true));
    let write_throws = options.get("writeThrows") == Some(&Value::Bool(true));
    let steps: Vec<&str> = options
        .get("steps")
        .and_then(Value::as_array)
        .map(|steps| steps.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let clock = Cell::new(cx.now_ms);
    let wall = cx.now_ms;
    let mut handle = start_heartbeat(HeartbeatOptions {
        user_data_dir,
        log_path,
        memory: Box::new(move || {
            if memory_throws {
                Err(())
            } else {
                Ok(memory.clone())
            }
        }),
        now: Some(Box::new(|| {
            let at = clock.get();
            clock.set(at + 1.0);
            at
        })),
        wall_clock: Some(Box::new(move || wall)),
        write_json: write_throws.then(|| {
            Box::new(|_: &str, _: &JsonValue| {
                Err(NodeError {
                    code: None,
                    message: "write refused".to_owned(),
                })
            }) as Box<dyn Fn(&str, &JsonValue) -> Result<(), NodeError>>
        }),
    });
    for step in steps {
        match step {
            "quit" => handle.mark_ended(HeartbeatEnd::Quit),
            "os" => handle.mark_ended(HeartbeatEnd::Os),
            "stop" => handle.stop(),
            _ => return Err(bad("step")),
        }
    }
    handle.stop();
    Ok(None)
}

/// `[path, "ok" | "fail", text]`: the writer puts `text` at the temp path;
/// `"fail"` then throws an error `{ code: "EBOOM", message: "boom" }`.
fn write_via_call(args: &[Value]) -> Answer {
    let path = str_arg(args, 0)?;
    let mode = str_arg(args, 1)?;
    let text = str_arg(args, 2)?;
    let fail = mode == "fail";
    let mut write = |tmp: &str| -> Result<(), NodeError> {
        std::fs::write(tmp, text).map_err(|e| crate::node_fs::node_error(&e, "open", tmp))?;
        if fail {
            return Err(NodeError {
                code: Some("EBOOM"),
                message: "boom".to_owned(),
            });
        }
        Ok(())
    };
    atomic_write_via(path, &mut write)
        .map(|()| None)
        .map_err(masked)
}
