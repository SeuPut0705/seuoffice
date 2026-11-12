//! The functions of group `b4-sheets` (tools/main-diff/groups/b4-sheets.ts).
//!
//! A number the TypeScript reads and a spec writes as NaN reaches Rust as
//! `null`, which [`f64_arg`] reads as NaN again; a spec never uses an infinity.
//! A class is a list of steps (`ops`) that answers one entry per step; where a
//! step needs the clock, a timer or a process, the spec drives a fake that logs
//! each call as one `logs` line, and the Rust side logs the same lines from the
//! trait it implements.

use jscompat::{JsMap, js_regex, value_truthy};
use serde_json::{Map, Number, Value};

use super::{Answer, CallError, Context, arg, str_arg};
use crate::node_fs::NodeError;
use crate::packages::xlsx_gateway::{CSV_IMPORT_DEFAULT_LIMIT_MB, legacy_csv_charset_for};
use crate::sheets::atomic_write::atomic_write_file;
use crate::sheets::close_guard::{ShutdownLatch, close_guard_decision};
use crate::sheets::csv_digest::{self, refresh_csv_digest};
use crate::sheets::csv_import_limit::DelimitedImportLimit;
use crate::sheets::document_locale::legacy_csv_charset;
use crate::sheets::import_registry::{AbortController, ImportRegistry};
use crate::sheets::pdf_page_variants::{
    VariantFlags, even_page_ranges, stitch_plan, variant_for_page,
};
use crate::sheets::print_options::{CSS_PX_PER_INCH, MICRONS_PER_INCH, print_options_for};
use crate::sheets::save_as_formats::{
    SaveAsExportTargets, resolve_sheets_save_as_pick, sheets_save_as_filters,
    sheets_save_as_suggestion,
};
use crate::sheets::save_edits_transfer::{
    SaveEditsBegin, SaveEditsChunk, SaveEditsTransferStore, SweepTimers, TRANSFER_IDLE_EXPIRY_MS,
};
use crate::sheets::save_failure_log::{
    ReopenError, ReopenFailure, ReopenFailureKind, SAVE_FAILURE_LOG_FILE,
    SAVE_FAILURE_LOG_MAX_BYTES, SaveFailureEntry, ZodIssue, append_save_failure,
    describe_reopen_failure, reopen_failure_note, scrub_detail, session_source_format,
};
use crate::sheets::session_rename::{self, session_after_rename, xlsx_sibling_of};
use crate::sheets::session_reopen::{self, continued_open_options, session_to_continue};
use crate::sheets::temp_files::{
    PASTED_FILE_TTL_MS, SessionTemporaryResources, cleanup_expired_pasted_files,
    cleanup_import_temp_directory, cleanup_session_resources,
};
use crate::sheets::workbook_save_resolve::resolve_workbook_save;
use crate::sheets::xlsx_sidecar_client::{
    ListenerId, Settled, SidecarHost, Submitted, XlsxSidecarClient,
};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // atomic-write
        "sheets/atomic-write.atomicWriteFile" => atomic_write_call(args),
        // close-guard
        "close-guard.closeGuardDecision" => close_guard_call(args),
        "close-guard.ShutdownLatch" => latch_call(args),
        // csv-digest
        "csv-digest.refreshCsvDigest" => csv_digest_call(args),
        // csv-import-limit
        "sheets/csv-import-limit.delimitedImportLimit" => import_limit_call(args, false),
        "sheets/csv-import-limit.setDelimitedImportLimit" => import_limit_call(args, true),
        // document-locale
        "document-locale.legacyCsvCharset" => {
            str_arg(args, 0).map(|requested| legacy_csv_charset(requested).map(Value::from))
        }
        // import-registry
        "import-registry.ImportRegistry" => registry_call(args),
        // pdf-page-variants
        "pdf-page-variants.variantForPage" => flags_arg(arg(args, 1)).map(|flags| {
            Some(Value::from(
                variant_for_page(f64_arg(arg(args, 0)), flags).as_str(),
            ))
        }),
        "pdf-page-variants.evenPageRanges" => {
            Ok(Some(Value::from(even_page_ranges(f64_arg(arg(args, 0))))))
        }
        "pdf-page-variants.stitchPlan" => flags_arg(arg(args, 1)).map(|flags| {
            Some(Value::Array(
                stitch_plan(f64_arg(arg(args, 0)), flags)
                    .into_iter()
                    .map(|step| {
                        let mut map = Map::new();
                        map.insert("page".into(), num(step.page));
                        map.insert("source".into(), Value::from(step.source.as_str()));
                        map.insert("index".into(), num(step.index));
                        Value::Object(map)
                    })
                    .collect(),
            ))
        }),
        // print-options
        "print-options.MICRONS_PER_INCH" => Ok(Some(num(MICRONS_PER_INCH))),
        "print-options.CSS_PX_PER_INCH" => Ok(Some(num(CSS_PX_PER_INCH))),
        "print-options.printOptionsFor" => {
            Ok(Some(print_options_for(arg(args, 0).unwrap_or(&NULL))))
        }
        // save-as-formats
        "sheets/save-as-formats.sheetsSaveAsFilters" => filters_call(args, cx),
        "sheets/save-as-formats.sheetsSaveAsSuggestion" => {
            str_arg(args, 0).map(|path| Some(Value::from(sheets_save_as_suggestion(path))))
        }
        "sheets/save-as-formats.resolveSheetsSaveAsPick" => pick_call(args),
        "sheets/save-as-formats.SaveAsExportTargets" => targets_call(args),
        // save-edits-transfer
        "save-edits-transfer.SaveEditsTransferStore" => transfer_call(args, cx),
        // save-failure-log
        "save-failure-log.SAVE_FAILURE_LOG_FILE" => Ok(Some(Value::from(SAVE_FAILURE_LOG_FILE))),
        "save-failure-log.SAVE_FAILURE_LOG_MAX_BYTES" => Ok(Some(num(SAVE_FAILURE_LOG_MAX_BYTES))),
        "save-failure-log.scrubDetail" => {
            str_arg(args, 0).map(|text| Some(Value::from(scrub_detail(text))))
        }
        "save-failure-log.describeReopenFailure" => reopen_error_arg(arg(args, 0))
            .map(|error| Some(failure_value(&describe_reopen_failure(&error)))),
        "save-failure-log.reopenFailureNote" => failure_arg(arg(args, 0))
            .map(|failure| Some(Value::from(reopen_failure_note(&failure)))),
        "save-failure-log.sessionSourceFormat" => Ok(Some(Value::from(session_source_format(
            arg(args, 0).unwrap_or(&NULL),
        )))),
        "save-failure-log.appendSaveFailure" => append_failure_call(args, cx),
        // session-rename
        "session-rename.xlsxSiblingOf" => {
            str_arg(args, 0).map(|path| Some(Value::from(xlsx_sibling_of(path))))
        }
        "session-rename.sessionAfterRename" => rename_call(args),
        // session-reopen
        "session-reopen.sessionToContinue" => reopen_call(args),
        "session-reopen.continuedOpenOptions" => {
            object_arg(args, 0).map(|session: &session_reopen::Session| {
                Some(Value::Object(continued_open_options(session)))
            })
        }
        // temp-files
        "temp-files.PASTED_FILE_TTL_MS" => Ok(Some(num(PASTED_FILE_TTL_MS))),
        "temp-files.cleanupSessionResources" => cleanup_session_call(args, cx),
        "temp-files.cleanupImportTempDirectory" => str_arg(args, 0).and_then(|root| {
            cleanup_import_temp_directory(root, str_arg(args, 1)?);
            Ok(None)
        }),
        "temp-files.cleanupExpiredPastedFiles" => str_arg(args, 0).map(|root| {
            let now = match arg(args, 1) {
                None | Some(Value::Null) => cx.now_ms,
                other => f64_arg(other),
            };
            Some(Value::Array(
                cleanup_expired_pasted_files(root, now)
                    .into_iter()
                    .map(Value::from)
                    .collect(),
            ))
        }),
        // workbook-save-resolve
        "workbook-save-resolve.resolveWorkbookSave" => resolve_call(args),
        // xlsx-sidecar-client
        "xlsx-sidecar-client.XlsxSidecarClient" => client_call(args, cx),
        // packages/xlsx-gateway
        "xlsx-gateway/csv-limits.CSV_IMPORT_DEFAULT_LIMIT_MB" => {
            Ok(Some(num(CSV_IMPORT_DEFAULT_LIMIT_MB)))
        }
        "xlsx-gateway/document-locale.legacyCsvCharsetFor" => {
            str_arg(args, 0).map(|locale| legacy_csv_charset_for(locale).map(Value::from))
        }
        _ => return None,
    })
}

// ---- helpers ----

static NULL: Value = Value::Null;

fn bad(what: &str) -> CallError {
    CallError::plain(format!("argument is not {what}"))
}

/// a number the spec wrote; `null` (NaN on the wire) and anything else is NaN
fn f64_arg(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// a number as the JSON the TypeScript's `JSON.stringify` writes
fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn object_arg(args: &[Value], i: usize) -> Result<&Map<String, Value>, CallError> {
    arg(args, i)
        .and_then(Value::as_object)
        .ok_or_else(|| bad("an object"))
}

fn text_of<'a>(value: &'a Value, key: &str) -> Result<&'a str, CallError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| bad(&format!("a string ({key})")))
}

fn list_arg(args: &[Value], i: usize) -> Result<&Vec<Value>, CallError> {
    arg(args, i)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list"))
}

fn flags_arg(value: Option<&Value>) -> Result<VariantFlags, CallError> {
    let flags = value.ok_or_else(|| bad("flags"))?;
    Ok(VariantFlags {
        has_first: value_truthy(flags.get("hasFirst")),
        has_even: value_truthy(flags.get("hasEven")),
    })
}

fn push_log(cx: &mut Context, line: Vec<Value>) {
    cx.logs.push(line);
}

// ---- atomic-write ----

/// `<12 hex>.tmp` of a temp file's random name, written `.<hex>.tmp`
fn mask_tmp(text: &str) -> String {
    js_regex!(r"\.[0-9a-f]{12}\.tmp", "g").replace_all(text, |_| ".<hex>.tmp".to_owned())
}

fn masked(mut error: NodeError) -> CallError {
    error.message = mask_tmp(&error.message);
    error.into()
}

fn atomic_write_call(args: &[Value]) -> Answer {
    let path = str_arg(args, 0)?;
    let text = str_arg(args, 1)?;
    atomic_write_file(path, text.as_bytes())
        .map(|()| None)
        .map_err(masked)
}

// ---- close-guard ----

fn close_guard_call(args: &[Value]) -> Answer {
    let state = arg(args, 0).ok_or_else(|| bad("a state"))?;
    let decision = close_guard_decision(
        f64_arg(state.get("pendingEdits")),
        value_truthy(state.get("destroyed")),
        value_truthy(state.get("shuttingDown")),
    );
    Ok(Some(Value::from(decision.as_str())))
}

/// `[op, ...]` with `mark`, `reset`, `active`; one answer per step
fn latch_call(args: &[Value]) -> Answer {
    let mut latch = ShutdownLatch::new();
    let mut out = Vec::new();
    for op in list_arg(args, 0)? {
        out.push(match op.as_str() {
            Some("mark") => {
                latch.mark();
                Value::Null
            }
            Some("reset") => {
                latch.reset();
                Value::Null
            }
            Some("active") => Value::Bool(latch.active()),
            _ => return Err(bad("a latch step")),
        });
    }
    Ok(Some(Value::Array(out)))
}

// ---- csv-digest ----

/// `[[sessionId, session], ...]`, the entries of the `Map`; answers the
/// entries after the call
fn csv_digest_call(args: &[Value]) -> Answer {
    let mut sessions: JsMap<csv_digest::Session> = JsMap::new();
    for entry in list_arg(args, 0)? {
        let pair = entry.as_array().ok_or_else(|| bad("a pair"))?;
        let id = pair
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| bad("a session id"))?;
        let session = pair
            .get(1)
            .and_then(Value::as_object)
            .ok_or_else(|| bad("a session"))?;
        sessions.set(id, session.clone());
    }
    refresh_csv_digest(&mut sessions, str_arg(args, 1)?, str_arg(args, 2)?);
    Ok(Some(Value::Array(
        sessions
            .into_iter()
            .map(|(id, session)| Value::Array(vec![Value::from(id), Value::Object(session)]))
            .collect(),
    )))
}

// ---- csv-import-limit ----

/// `[bytes, ...]` set one after the other on a fresh limit: the answer is the
/// limit after the steps, or (`all`) the limit before and after each step
fn import_limit_call(args: &[Value], all: bool) -> Answer {
    let mut limit = DelimitedImportLimit::new();
    let mut seen = vec![num(limit.delimited_import_limit())];
    for bytes in list_arg(args, 0)? {
        limit.set_delimited_import_limit(match bytes {
            Value::Number(n) => n.as_f64(),
            _ => None,
        });
        seen.push(num(limit.delimited_import_limit()));
    }
    Ok(Some(if all {
        Value::Array(seen)
    } else {
        seen.pop().unwrap_or(Value::Null)
    }))
}

// ---- import-registry ----

/// steps `{ op, owner, as, id }`: `start` (the controller is kept as `as`),
/// `cancel`, `controllerFor` (the name of the controller, or null),
/// `wasCancelled` and `finish` (by the name `id`)
fn registry_call(args: &[Value]) -> Answer {
    let mut registry = ImportRegistry::new();
    let mut controllers: Vec<(String, AbortController)> = Vec::new();
    let named = |controllers: &[(String, AbortController)], step: &Value| {
        let id = text_of(step, "id")?;
        controllers
            .iter()
            .find(|(name, _)| name == id)
            .map(|(_, controller)| controller.clone())
            .ok_or_else(|| bad("a known controller"))
    };
    let mut out = Vec::new();
    for step in list_arg(args, 0)? {
        let owner = f64_arg(step.get("owner"));
        out.push(match text_of(step, "op")? {
            "start" => {
                let controller = registry.start(owner);
                let name = text_of(step, "as")?.to_owned();
                match controllers.iter_mut().find(|(n, _)| *n == name) {
                    Some(entry) => entry.1 = controller,
                    None => controllers.push((name, controller)),
                }
                Value::Null
            }
            "cancel" => Value::Bool(registry.cancel(owner)),
            "controllerFor" => match registry.controller_for(owner) {
                None => Value::Null,
                Some(found) => controllers
                    .iter()
                    .find(|(_, controller)| controller.same(&found))
                    .map_or(Value::Null, |(name, _)| Value::from(name.as_str())),
            },
            "wasCancelled" => Value::Bool(registry.was_cancelled(&named(&controllers, step)?)),
            "finish" => Value::Bool(registry.finish(owner, &named(&controllers, step)?)),
            _ => return Err(bad("a registry step")),
        });
    }
    Ok(Some(Value::Array(out)))
}

// ---- save-as-formats ----

/// `[macroEnabled, offerCopies, prefix]`: the label of a key is `prefix + key`,
/// and each call of it is one log line
fn filters_call(args: &[Value], cx: &mut Context) -> Answer {
    let macro_enabled = value_truthy(arg(args, 0));
    let offer_copies = value_truthy(arg(args, 1));
    let prefix = str_arg(args, 2)?;
    let mut label = |key: &str| {
        cx.logs.push(vec![Value::from(key)]);
        format!("{prefix}{key}")
    };
    let filters = sheets_save_as_filters(macro_enabled, offer_copies, &mut label);
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

fn pick_call(args: &[Value]) -> Answer {
    let pick = resolve_sheets_save_as_pick(
        str_arg(args, 0)?,
        value_truthy(arg(args, 1)),
        value_truthy(arg(args, 2)),
    );
    let mut map = Map::new();
    map.insert("kind".into(), Value::from(pick.kind.as_str()));
    map.insert("path".into(), Value::from(pick.path));
    Ok(Some(Value::Object(map)))
}

/// steps `[op, wcId, path?]`: `authorize`, `take` (a bool), `forget`
fn targets_call(args: &[Value]) -> Answer {
    let mut targets = SaveAsExportTargets::new();
    let mut out = Vec::new();
    for step in list_arg(args, 0)? {
        let step = step.as_array().ok_or_else(|| bad("a step"))?;
        let wc_id = f64_arg(step.get(1));
        let path = step.get(2).and_then(Value::as_str);
        out.push(match step.first().and_then(Value::as_str) {
            Some("authorize") => {
                targets.authorize(wc_id, path.ok_or_else(|| bad("a path"))?);
                Value::Null
            }
            Some("take") => Value::Bool(targets.take(wc_id, path.ok_or_else(|| bad("a path"))?)),
            Some("forget") => {
                targets.forget(wc_id);
                Value::Null
            }
            _ => return Err(bad("a targets step")),
        });
    }
    Ok(Some(Value::Array(out)))
}

// ---- save-edits-transfer ----

/// The interval of the store: each call is the log lines the spec's fake
/// writes (`setInterval` with its time, then `unref`; `clearInterval`).
struct LoggedTimers<'a> {
    logs: &'a mut Vec<Vec<Value>>,
    active: bool,
}

impl SweepTimers for LoggedTimers<'_> {
    fn set_interval(&mut self, ms: f64) {
        self.logs.push(vec![Value::from("setInterval"), num(ms)]);
        self.logs.push(vec![Value::from("unref")]);
        self.active = true;
    }

    fn clear_interval(&mut self) {
        self.logs.push(vec![Value::from("clearInterval")]);
        self.active = false;
    }
}

/// steps `{ op, transferId, sessionId, total, seq, edits, now, idle }`; the
/// answer of a step is `null`, the edits of `take`, the count, or
/// `{ error: message }`
fn transfer_call(args: &[Value], cx: &mut Context) -> Answer {
    let default_now = cx.now_ms;
    let mut store = SaveEditsTransferStore::new(LoggedTimers {
        logs: &mut cx.logs,
        active: false,
    });
    let mut out = Vec::new();
    for step in list_arg(args, 0)? {
        let now = match step.get("now") {
            None | Some(Value::Null) => default_now,
            other => f64_arg(other),
        };
        let transfer_id = || text_of(step, "transferId");
        let session_id = || text_of(step, "sessionId");
        let failed = |e: crate::sheets::save_edits_transfer::TransferError| {
            let mut map = Map::new();
            map.insert("error".into(), Value::from(e.0));
            Value::Object(map)
        };
        out.push(match text_of(step, "op")? {
            "begin" => {
                let request = SaveEditsBegin {
                    session_id: session_id()?.to_owned(),
                    transfer_id: transfer_id()?.to_owned(),
                    total: f64_arg(step.get("total")),
                };
                store
                    .begin(&request, now)
                    .map_or_else(failed, |()| Value::Null)
            }
            "addChunk" => {
                let request = SaveEditsChunk {
                    session_id: session_id()?.to_owned(),
                    transfer_id: transfer_id()?.to_owned(),
                    seq: f64_arg(step.get("seq")),
                    edits: step
                        .get("edits")
                        .and_then(Value::as_array)
                        .ok_or_else(|| bad("edits"))?
                        .clone(),
                };
                store
                    .add_chunk(request, now)
                    .map_or_else(failed, |()| Value::Null)
            }
            "take" => store
                .take(transfer_id()?, session_id()?)
                .map_or_else(failed, Value::Array),
            "discard" => {
                store.discard(transfer_id()?, session_id()?);
                Value::Null
            }
            "discardSession" => {
                store.discard_session(session_id()?);
                Value::Null
            }
            "sweep" => {
                let idle = match step.get("idle") {
                    None | Some(Value::Null) => TRANSFER_IDLE_EXPIRY_MS,
                    other => f64_arg(other),
                };
                store.sweep(now, idle);
                Value::Null
            }
            "tick" => {
                // the interval fires only while it is set
                if store.timers().active {
                    store.tick(now);
                }
                Value::Null
            }
            "dispose" => {
                store.dispose();
                Value::Null
            }
            "count" => Value::from(store.open_transfer_count()),
            _ => return Err(bad("a transfer step")),
        });
    }
    Ok(Some(Value::Array(out)))
}

// ---- save-failure-log ----

fn failure_value(failure: &ReopenFailure) -> Value {
    let mut map = Map::new();
    map.insert("kind".into(), Value::from(failure.kind.as_str()));
    map.insert("detail".into(), Value::from(failure.detail.as_str()));
    Value::Object(map)
}

fn failure_arg(value: Option<&Value>) -> Result<ReopenFailure, CallError> {
    let value = value.ok_or_else(|| bad("a failure"))?;
    let kind = match text_of(value, "kind")? {
        "unreadable" => ReopenFailureKind::Unreadable,
        "reply-shape" => ReopenFailureKind::ReplyShape,
        "timeout" => ReopenFailureKind::Timeout,
        "sidecar-ended" => ReopenFailureKind::SidecarEnded,
        _ => return Err(bad("a failure kind")),
    };
    Ok(ReopenFailure {
        kind,
        detail: text_of(value, "detail")?.to_owned(),
    })
}

/// `{ zod: [{ path, code }] }` (a `ZodError` of those issues), `{ error:
/// message }` (an `Error`), `{ value }` (another value, read as `String(value)`)
/// or `{ undefined: true }`
fn reopen_error_arg(value: Option<&Value>) -> Result<ReopenError, CallError> {
    let value = value.ok_or_else(|| bad("an error"))?;
    if let Some(issues) = value.get("zod").and_then(Value::as_array) {
        let mut out = Vec::new();
        for issue in issues {
            out.push(ZodIssue {
                path: issue
                    .get("path")
                    .and_then(Value::as_array)
                    .ok_or_else(|| bad("a path"))?
                    .clone(),
                code: text_of(issue, "code")?.to_owned(),
            });
        }
        return Ok(ReopenError::Zod(out));
    }
    if let Some(message) = value.get("error").and_then(Value::as_str) {
        return Ok(ReopenError::Error(message.to_owned()));
    }
    if value.get("undefined").is_some() {
        return Ok(ReopenError::Other(None));
    }
    Ok(ReopenError::Other(value.get("value").cloned()))
}

/// `[file, entry, now, maxBytes]`; `now` and `maxBytes` `null` are left out
fn append_failure_call(args: &[Value], cx: &mut Context) -> Answer {
    let file = str_arg(args, 0)?;
    let entry = arg(args, 1).ok_or_else(|| bad("an entry"))?;
    let entry = SaveFailureEntry {
        failure: failure_arg(entry.get("failure"))?,
        source_format: text_of(entry, "sourceFormat")?.to_owned(),
        staged_bytes: match entry.get("stagedBytes") {
            Some(Value::Number(n)) => n.as_f64(),
            _ => None,
        },
        app_version: text_of(entry, "appVersion")?.to_owned(),
    };
    let now = match arg(args, 2) {
        None | Some(Value::Null) => cx.now_ms,
        other => f64_arg(other),
    };
    let max_bytes = match arg(args, 3) {
        None | Some(Value::Null) => SAVE_FAILURE_LOG_MAX_BYTES,
        other => f64_arg(other),
    };
    append_save_failure(file, &entry, now, max_bytes);
    Ok(None)
}

// ---- session-rename, session-reopen ----

fn rename_call(args: &[Value]) -> Answer {
    let session: &session_rename::Session = object_arg(args, 0)?;
    Ok(Some(
        session_after_rename(session, str_arg(args, 1)?, str_arg(args, 2)?)
            .map_or(Value::Null, Value::Object),
    ))
}

fn reopen_call(args: &[Value]) -> Answer {
    let mut sessions: Vec<session_reopen::Session> = Vec::new();
    for session in list_arg(args, 0)? {
        sessions.push(session.as_object().ok_or_else(|| bad("a session"))?.clone());
    }
    Ok(Some(
        session_to_continue(&sessions, str_arg(args, 1)?)
            .map_or(Value::Null, |session| Value::Object(session.clone())),
    ))
}

// ---- temp-files ----

/// `[{ snapshotPath, importTempDir?, tempRoot, closeSidecar }]`: `closeSidecar`
/// is `"ok"`, `"reject"` or `"throw"`; it logs one line when called
fn cleanup_session_call(args: &[Value], cx: &mut Context) -> Answer {
    let options = arg(args, 0).ok_or_else(|| bad("options"))?;
    let resources = SessionTemporaryResources {
        snapshot_path: text_of(options, "snapshotPath")?,
        import_temp_dir: match options.get("importTempDir") {
            None | Some(Value::Null) => None,
            Some(_) => Some(text_of(options, "importTempDir")?),
        },
    };
    let mode = text_of(options, "closeSidecar")?.to_owned();
    cleanup_session_resources(&resources, text_of(options, "tempRoot")?, || {
        push_log(cx, vec![Value::from("closeSidecar")]);
        if mode == "ok" { Ok(()) } else { Err(()) }
    });
    Ok(None)
}

// ---- workbook-save-resolve ----

/// `[[[sheetId, name], ...], request]`
fn resolve_call(args: &[Value]) -> Answer {
    let mut names = Vec::new();
    for entry in list_arg(args, 0)? {
        let pair = entry.as_array().ok_or_else(|| bad("a pair"))?;
        let id = pair
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| bad("an id"))?;
        let name = pair
            .get(1)
            .and_then(Value::as_str)
            .ok_or_else(|| bad("a name"))?;
        names.push((id.to_owned(), name.to_owned()));
    }
    let request = arg(args, 1).ok_or_else(|| bad("a request"))?;
    resolve_workbook_save(&names, request)
        .map(Some)
        .map_err(|e| CallError::plain(e.0))
}

// ---- xlsx-sidecar-client ----

/// What the spec's fakes do, and what they log, in the words of the TypeScript
/// calls they stand for.
struct FakeSidecar {
    logs: Vec<Vec<Value>>,
    uuids: u64,
    /// per timer (numbered from 1): still set
    timers: Vec<bool>,
    /// per process: it has exited, so a kill finds nobody
    exited: Vec<bool>,
    /// per process: its line reader was closed
    closed: Vec<bool>,
    /// per spawn attempt: what it throws
    spawn_failures: Vec<Option<String>>,
    spawns: usize,
    /// the requests whose stdin write has a callback, in the order written
    write_callbacks: Vec<String>,
    settled: Vec<(String, Settled)>,
}

impl FakeSidecar {
    fn log(&mut self, line: Vec<Value>) {
        self.logs.push(line);
    }
}

impl SidecarHost for FakeSidecar {
    fn spawn(&mut self, binary_path: &str, _process: u64) -> Result<(), String> {
        self.log(vec![Value::from("spawn"), Value::from(binary_path)]);
        let attempt = self.spawns;
        self.spawns += 1;
        if let Some(Some(message)) = self.spawn_failures.get(attempt) {
            return Err(message.clone());
        }
        self.exited.push(false);
        self.closed.push(false);
        Ok(())
    }

    fn pid(&mut self, process: u64) -> Option<f64> {
        Some(1000.0 + process as f64)
    }

    fn write_stdin(&mut self, _process: u64, data: &str, request_id: Option<&str>) {
        self.log(vec![
            Value::from("write"),
            Value::from(data),
            Value::Bool(request_id.is_some()),
        ]);
        if let Some(request_id) = request_id {
            self.write_callbacks.push(request_id.to_owned());
        }
    }

    fn kill(&mut self, process: u64) -> bool {
        self.log(vec![Value::from("kill")]);
        !self.exited[process as usize]
    }

    fn close_lines(&mut self, process: u64) {
        self.log(vec![Value::from("closeLines")]);
        self.closed[process as usize] = true;
    }

    fn random_uuid(&mut self) -> String {
        self.uuids += 1;
        format!("uuid-{}", self.uuids)
    }

    fn set_timeout(&mut self, ms: f64) -> u64 {
        self.log(vec![Value::from("setTimeout"), num(ms)]);
        self.timers.push(true);
        self.timers.len() as u64
    }

    fn clear_timeout(&mut self, timer: u64) {
        self.log(vec![Value::from("clearTimeout"), Value::from(timer)]);
        self.timers[timer as usize - 1] = false;
    }

    fn settle(&mut self, request_id: &str, outcome: Settled) {
        self.settled.push((request_id.to_owned(), outcome));
    }

    fn warn_prewarm_failed(&mut self, message: &str) {
        self.log(vec![
            Value::from("warn"),
            Value::from("[sheets] XLSX sidecar prewarm failed:"),
            Value::from(message),
        ]);
    }

    fn exit_notified(&mut self, listener: ListenerId) {
        self.log(vec![Value::from("exitListener"), Value::from(listener)]);
    }
}

/// How a request settled, as the spec records it: `{ ok }`, `{}` for
/// `undefined`, `{ err }`
fn outcome_value(outcome: &Settled) -> Value {
    let mut map = Map::new();
    match outcome {
        Ok(Some(value)) => {
            map.insert("ok".into(), value.clone());
        }
        Ok(None) => {}
        Err(message) => {
            map.insert("err".into(), Value::from(message.as_str()));
        }
    }
    Value::Object(map)
}

/// `null` is an argument left out
fn opt_str(value: Option<&Value>) -> Result<Option<&str>, CallError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(bad("a string")),
    }
}

/// `[binaryPath, { spawnFailures }, steps]`. A step is `{ op, ... }`:
/// `call` (`label`, `method`, `args`: a request method of the client; its
/// answer is recorded under the label), `start`, `stop`, `pid`, `onExit`
/// (`id`), `offExit` (`id`), the events of a process (`line`, `stderr`, `exit`,
/// `error`, `stdinError`: `child` is the spawn's number, the last one by
/// default), `writeDone` (`index`, `error`) and `timeout` (`timer`). The answer
/// is `{ results, outcomes }`.
fn client_call(args: &[Value], cx: &mut Context) -> Answer {
    let binary_path = str_arg(args, 0)?;
    let options = arg(args, 1).ok_or_else(|| bad("options"))?;
    let spawn_failures = options
        .get("spawnFailures")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|failure| match failure {
                    Value::Null => None,
                    Value::String(message) => Some(message.clone()),
                    other => Some(jscompat::value_to_string(other.get("value"))),
                })
                .collect()
        })
        .unwrap_or_default();
    let host = FakeSidecar {
        logs: Vec::new(),
        uuids: 0,
        timers: Vec::new(),
        exited: Vec::new(),
        closed: Vec::new(),
        spawn_failures,
        spawns: 0,
        write_callbacks: Vec::new(),
        settled: Vec::new(),
    };
    let mut client = XlsxSidecarClient::new(host, binary_path);
    let mut labels: Vec<(String, String)> = Vec::new();
    // label -> how its request ended, in the order the labels were made
    let mut outcomes: Vec<(String, Value)> = Vec::new();
    let mut results = Vec::new();
    for step in list_arg(args, 2)? {
        let child = |client: &XlsxSidecarClient<FakeSidecar>| match step.get("child") {
            Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
            _ => client.host().exited.len().saturating_sub(1) as u64,
        };
        let result = match text_of(step, "op")? {
            "call" => {
                let label = text_of(step, "label")?.to_owned();
                let no_args: &[Value] = &[];
                let call_args: &[Value] = step
                    .get("args")
                    .and_then(Value::as_array)
                    .map_or(no_args, Vec::as_slice);
                match request_call(&mut client, text_of(step, "method")?, call_args)? {
                    Submitted::Pending(request_id) => {
                        outcomes.push((label.clone(), Value::from("pending")));
                        labels.push((request_id, label));
                    }
                    Submitted::Rejected(message) => {
                        outcomes.push((label, outcome_value(&Err(message))));
                    }
                }
                Value::Null
            }
            "start" => {
                client.start();
                Value::Null
            }
            "stop" => {
                client.stop();
                Value::Null
            }
            "pid" => client.get_process_id().map_or(Value::Null, num),
            "onExit" => {
                // the listener's number is the one the spec names
                let id = client.on_process_exit();
                if Some(id) != step.get("id").and_then(Value::as_u64) {
                    return Err(bad("the next listener id"));
                }
                Value::Null
            }
            "offExit" => Value::Bool(
                client.off_process_exit(
                    step.get("id")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| bad("a listener id"))?,
                ),
            ),
            "line" => {
                let process = child(&client);
                // a closed reader emits no more lines
                if !client
                    .host()
                    .closed
                    .get(process as usize)
                    .copied()
                    .unwrap_or(true)
                {
                    let _ = client.on_line(text_of(step, "text")?);
                }
                Value::Null
            }
            "stderr" => {
                client.on_stderr(text_of(step, "text")?);
                Value::Null
            }
            "exit" => {
                let process = child(&client);
                *client
                    .host_mut()
                    .exited
                    .get_mut(process as usize)
                    .ok_or_else(|| bad("a spawned process"))? = true;
                let code = match step.get("code") {
                    Some(Value::Number(n)) => n.as_f64(),
                    _ => None,
                };
                client.on_exit(process, code, opt_str(step.get("signal"))?);
                Value::Null
            }
            "error" => {
                let process = child(&client);
                client.on_error(process, text_of(step, "message")?);
                Value::Null
            }
            "stdinError" => {
                let process = child(&client);
                client.on_stdin_error(process);
                Value::Null
            }
            "writeDone" => {
                let index = step
                    .get("index")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| bad("a write number"))? as usize;
                let request_id = client
                    .host()
                    .write_callbacks
                    .get(index)
                    .cloned()
                    .ok_or_else(|| bad("a known write"))?;
                client.on_write_done(&request_id, opt_str(step.get("error"))?);
                Value::Null
            }
            "timeout" => {
                let timer = step
                    .get("timer")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| bad("a timer number"))?;
                let at = (timer as usize)
                    .checked_sub(1)
                    .ok_or_else(|| bad("a timer number"))?;
                let host = client.host_mut();
                if host.timers.get(at).copied().unwrap_or(false) {
                    // a timer that fired is done
                    host.timers[at] = false;
                    client.on_timeout(timer);
                }
                Value::Null
            }
            _ => return Err(bad("a client step")),
        };
        results.push(result);
        for (request_id, outcome) in std::mem::take(&mut client.host_mut().settled) {
            let label = labels
                .iter()
                .find(|(id, _)| *id == request_id)
                .map(|(_, label)| label.clone())
                .ok_or_else(|| bad("a known request"))?;
            if let Some(entry) = outcomes.iter_mut().find(|(l, _)| *l == label) {
                entry.1 = outcome_value(&outcome);
            }
        }
    }
    cx.logs.append(&mut client.host_mut().logs);
    let mut outcome_map = Map::new();
    for (label, outcome) in outcomes {
        outcome_map.insert(label, outcome);
    }
    let mut answer = Map::new();
    answer.insert("results".into(), Value::Array(results));
    answer.insert("outcomes".into(), Value::Object(outcome_map));
    Ok(Some(Value::Object(answer)))
}

/// `client[method](...args)` of the request methods
fn request_call(
    client: &mut XlsxSidecarClient<FakeSidecar>,
    method: &str,
    args: &[Value],
) -> Result<Submitted, CallError> {
    let input = || object_arg(args, 0);
    Ok(match method {
        "open" => {
            let timeout = match arg(args, 3).and_then(|options| options.get("timeoutMs")) {
                Some(Value::Number(n)) => n.as_f64(),
                _ => None,
            };
            client.open(
                str_arg(args, 0)?,
                opt_str(arg(args, 1))?,
                opt_str(arg(args, 2))?,
                timeout,
            )
        }
        "readRange" => client.read("read_range", input()?),
        "readFormulaCells" => client.read("read_formula_cells", input()?),
        "findCells" => client.read("find_cells", input()?),
        "readRowOutline" => client.read("read_row_outline", input()?),
        "readMedia" => client.read("read_media", input()?),
        "close" => client.close(str_arg(args, 0)?),
        "convertWorkbook" => client.convert_workbook(input()?),
        "convertToOds" => client.convert_to_ods(input()?),
        "archiveManifest" => client.archive_manifest(str_arg(args, 0)?),
        "readEntries" => client.archive_command("read_entries", input()?),
        "scanEntries" => client.archive_command("scan_entries", input()?),
        "saveArchive" => client.archive_command("save_archive", input()?),
        "recalcCells" => client.archive_command("recalc_cells", input()?),
        "updateExternalLinks" => client.archive_command("update_external_links", input()?),
        "readExternalLinks" => client.archive_command("read_external_links", input()?),
        "readExternalLinkUsage" => client.archive_command("read_external_link_usage", input()?),
        "listExternalLinks" => client.archive_command("list_external_links", input()?),
        _ => return Err(bad("a request method")),
    })
}
