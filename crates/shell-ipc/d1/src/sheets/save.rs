//! Saving, exporting and the recovery copy: the `saveWorkbook`,
//! `exportCsv`, `exportOds`, `exportPdf`, `createDocument`,
//! `writeWorkbookRecovery`, `workbookTemplateBytes`, `closeWorkbook`,
//! `autoRenameWorkbook`, `updateWorkbookPassword` and save-transfer handlers
//! of sheets-main.ts, as straight-line code on a worker.

use std::fs;
use std::path::Path;

use jscompat::node_path::host::{basename, dirname, is_absolute, join, resolve};
use jscompat::{JsMap, JsonValue, trim};
use main_core::markdown::fs_util::sha256_file;
use main_core::packages::electron_utils::atomic_write::atomic_write_file;
use main_core::packages::electron_utils::save_conflict::{
    SaveConflictAnswer, SaveConflictOptions, SaveDiskState, confirm_overwrite_if_conflicted,
    is_modified_since, record_disk_state, should_defer_auto_save,
};
use main_core::sheets::csv_digest::refresh_csv_digest;
use main_core::sheets::save_as_formats::{
    SaveAsKind, resolve_sheets_save_as_pick, sheets_save_as_filters, sheets_save_as_suggestion,
};
use main_core::sheets::save_edits_transfer::{SaveEditsBegin, SaveEditsChunk};
use main_core::sheets::save_failure_log::{
    ReopenError, SAVE_FAILURE_LOG_FILE, SAVE_FAILURE_LOG_MAX_BYTES, SaveFailureEntry, ZodIssue,
    append_save_failure, describe_reopen_failure, reopen_failure_note, session_source_format,
};
use main_core::sheets::temp_files::cleanup_import_temp_directory;
use main_core::sheets::template_fonts::with_template_font_faces;
use main_core::sheets::workbook_save_resolve::resolve_workbook_save;
use serde_json::Value;
use shell_contract::{IpcError, IpcValue, ViewId, WindowId};

use super::conv::ipc_to_serde;
use super::core::{Core, Env};
use super::dialogs::{
    HostMessages, Win, ask, default_save_dir, dialog_options, dialog_parent, json_filter,
    message_box, save_dialog, save_dialog_plain,
};
use super::engine::OdsConversion;
use super::open::{
    cleanup_session, import_dir, open_workbook_session, read_file, reserve_snapshot_path,
};
use super::recovery::{io_err, node_err, ok_answer, write_session_copy};
use super::recovery_policy::session_recovery_identity;
use super::schema;
use super::session::{OpenOptions, SessionInfo, Staged, file_identity};
use crate::value::{field, obj, string, thrown};

const BOM: [u8; 3] = [0xef, 0xbb, 0xbf];
/// a save's output opens as part of that save (`SAVE_REOPEN_TIMEOUT_MS`)
const SAVE_REOPEN_TIMEOUT_MS: f64 = 180_000.0;

pub fn unknown_session() -> IpcError {
    thrown("Unknown workbook session.")
}

/// `sessionFor(event)` then the session of `id`, or `Unknown workbook session.`
pub fn session_for(env: &Env, view: ViewId, id: &str) -> Result<SessionInfo, IpcError> {
    let id = id.to_owned();
    env.core(move |core| {
        core.ensure_tab(view);
        core.session_of(view, &id)
    })
    .ok_or_else(unknown_session)
}

fn text<'a>(request: &'a Value, key: &str) -> Option<&'a str> {
    request.get(key).and_then(Value::as_str)
}

fn csv_bytes(content: &str) -> Vec<u8> {
    let mut bytes = BOM.to_vec();
    bytes.extend_from_slice(content.as_bytes());
    bytes
}

/// `sanitizeAutoRenameBase`: a safe file name base, or `None`
pub fn sanitize_auto_rename_base(raw: &str) -> Option<String> {
    let replaced: String = raw
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                || (c as u32) < 0x20
            {
                ' '
            } else {
                c
            }
        })
        .collect();
    let mut collapsed = String::new();
    let mut in_space = false;
    for c in replaced.chars() {
        if jscompat::is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let trimmed = trim(&collapsed);
    let stripped = trimmed.trim_start_matches('.').trim_end_matches('.');
    let cleaned = trim(stripped);
    if cleaned.is_empty() {
        return None;
    }
    let units: Vec<u16> = cleaned.encode_utf16().collect();
    if units.len() > 40 {
        return Some(trim(&String::from_utf16_lossy(&units[..40])).to_owned());
    }
    Some(cleaned.to_owned())
}

/// `sanitizeGeneratedFileBase`
pub fn sanitize_generated_file_base(title: &str) -> String {
    let replaced: String = title
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                || (c as u32) < 0x20
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = trim(&replaced);
    let units: Vec<u16> = trimmed.encode_utf16().collect();
    let cut = if units.len() > 80 {
        String::from_utf16_lossy(&units[..80])
    } else {
        trimmed.to_owned()
    };
    let cleaned = trim(&cut);
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "Untitled".to_owned()
    } else {
        cleaned.to_owned()
    }
}

/// `uniquePathIn`: the first free `name.ext`, `name-2.ext`, `name-3.ext`…
pub fn unique_path_in(dir: &str, file_name: &str) -> String {
    let dot = file_name.rfind('.').filter(|at| *at > 0);
    let (base, ext) = match dot {
        Some(at) => (&file_name[..at], &file_name[at..]),
        None => (file_name, ""),
    };
    let mut candidate = join(&[dir, file_name]);
    let mut i = 2;
    while Path::new(&candidate).exists() {
        candidate = join(&[dir, &format!("{base}-{i}{ext}")]);
        i += 1;
    }
    candidate
}

/// `openGeneratedFile`: opened in a tab, else revealed in the folder
fn open_generated_file(env: &Env, path: &str) {
    if env.shell.is_headless() {
        return;
    }
    if env.shell.open_generated_path(path) {
        return;
    }
    env.os_shell.show_item_in_folder(Path::new(path));
}

/// the first `JSON.stringify`-able request of the save pipeline: the engine's
/// parse, then JSON for `main-core`
pub fn parse_save_request(env: &Env, input: &IpcValue) -> Result<Value, IpcError> {
    let parsed = env.engine.parse_save_request(input)?;
    ipc_to_serde(&parsed).ok_or_else(|| thrown("Save request is not JSON."))
}

/// `resolveTransferredEdits`: a save request referencing a chunked edit
/// transfer gets the accumulated edits spliced back in
pub fn resolve_transferred(env: &Env, view: ViewId, request: Value) -> Result<Value, IpcError> {
    let Some(transfer_id) = text(&request, "editsTransferId").map(str::to_owned) else {
        return Ok(request);
    };
    let inline = request
        .get("edits")
        .and_then(Value::as_array)
        .is_some_and(|edits| !edits.is_empty());
    if inline {
        return Err(thrown("Save request mixes inline and transferred edits."));
    }
    let session_id = text(&request, "sessionId").unwrap_or_default().to_owned();
    let taken = env.core(move |core| {
        core.ensure_tab(view);
        let mut state = core.state.borrow_mut();
        let tab = state.tab_mut(view).expect("ensured");
        tab.save_transfers
            .take(&transfer_id, &session_id)
            .map_err(|e| e.0.to_owned())
    });
    let edits = taken.map_err(thrown)?;
    let mut request = request;
    if let Some(map) = request.as_object_mut() {
        map.insert("edits".into(), Value::Array(edits));
    }
    Ok(request)
}

/// `writeWorkbookTo`: the workbook with a save request's edits, through the
/// sidecar, from the session's snapshot
pub fn write_workbook_to(
    env: &Env,
    session: &SessionInfo,
    request: &Value,
    target: &str,
) -> Result<IpcValue, IpcError> {
    let resolved = resolve_workbook_save(&session.sheet_names, request).map_err(|e| thrown(e.0))?;
    env.engine
        .write_workbook(&session.snapshot_path, target, &resolved)
}

fn recorded_state_for(session: &SessionInfo, path: &str) -> Option<SaveDiskState> {
    session
        .disk_state
        .as_ref()
        .filter(|(state_path, _)| state_path == path)
        .map(|(_, state)| state.clone())
}

#[derive(PartialEq)]
enum SplitVerdict {
    Proceed,
    Cancel,
    Overwrite,
}

/// `guardSplitSave`
fn guard_split_save(
    env: &Env,
    view: ViewId,
    path: &str,
    recorded: Option<&SaveDiskState>,
    quiet: bool,
) -> SplitVerdict {
    let shell = env.shell.clone();
    let probe = move |p: &str| Ok(shell.is_path_open_elsewhere(p));
    if quiet {
        return if should_defer_auto_save(Some(&probe), path, recorded) {
            SplitVerdict::Cancel
        } else {
            SplitVerdict::Proceed
        };
    }
    if !env.shell.is_path_open_elsewhere(path) {
        return SplitVerdict::Proceed;
    }
    if !is_modified_since(recorded, path) {
        return SplitVerdict::Proceed;
    }
    let dialog = HostMessages(&*env.dialogs);
    let parent = dialog_parent(env, view).map(Win);
    let lang = env.tm.lang();
    let verdict = confirm_overwrite_if_conflicted(&SaveConflictOptions {
        probe: Some(&probe),
        dialog: &dialog,
        parent: parent.as_ref(),
        path,
        recorded,
        lang: lang.as_str(),
    });
    if verdict == SaveConflictAnswer::Proceed {
        SplitVerdict::Overwrite
    } else {
        SplitVerdict::Cancel
    }
}

/// `placeStagedSave`: beside the target first, then promoted over it
fn place_staged_save(env: &Env, staged: &str, target: &str) -> Result<(), IpcError> {
    let beside = join(&[&dirname(target), &format!(".{}.tmp.xlsx", env.uuid())]);
    let placed = fs::copy(staged, &beside)
        .map_err(|e| io_err(e, "copyfile", staged))
        .and_then(|_| env.engine.promote_file_atomically(&beside, target));
    if placed.is_err() {
        let _ = fs::remove_file(&beside);
    }
    placed
}

fn show_save_unreadable_dialog(
    env: &Env,
    parent: Option<WindowId>,
    reason: &str,
    source_format: &str,
) {
    let options = message_box(
        "warning",
        env.tm.t("errSaveUnreadable"),
        Some(env.tm.with(
            "errSaveUnreadableReason",
            &[("reason", JsonValue::String(reason.to_owned()))],
        )),
        vec![env.tm.t("btnCopyReason"), env.tm.t("btnCloseDialog")],
        0,
        Some(1),
    );
    if ask(env, parent, &options) != 0 {
        return;
    }
    env.clipboard.write_text(&format!(
        "{} {reason} ({source_format}, {})",
        env.tm.t("errSaveUnreadable"),
        env.shell.app_version()
    ));
}

/// the `ReopenError` of a failed open
fn reopen_error(error: &IpcError) -> ReopenError {
    if error.name.is_none()
        && let Ok(Value::Array(issues)) = serde_json::from_str::<Value>(&error.message)
    {
        return ReopenError::Zod(
            issues
                .iter()
                .map(|issue| ZodIssue {
                    path: issue
                        .get("path")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                    code: issue
                        .get("code")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                })
                .collect(),
        );
    }
    ReopenError::Error(error.message.clone())
}

fn sha_of(path: &str) -> Option<String> {
    sha256_file(path).ok()
}

fn disk_changed(env: &Env) -> IpcError {
    thrown(env.tm.t("errDiskChanged"))
}

/// `saveWorkbook`
pub fn save_workbook(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.ensure_tab(view));
    let request = parse_save_request(env, &input)?;
    let request = resolve_transferred(env, view, request)?;
    let session_id = text(&request, "sessionId").unwrap_or_default().to_owned();
    let session = session_for(env, view, &session_id)?;
    let mode = text(&request, "mode").unwrap_or("save").to_owned();
    let quiet = request.get("quiet").and_then(Value::as_bool) == Some(true);
    // A CSV session's plain Save keeps the CSV identity
    let csv_in_place = mode == "save" && session.csv_source_path.is_some();
    let mut target_path = session.path.clone();
    if let Some(requested) = text(&request, "targetPath") {
        // MCP explicit-path save: dialog-free Save As to an exact path with a clobber guard
        if mode != "save-as" {
            return Err(thrown("An explicit save path needs Save As."));
        }
        if !is_absolute(requested) {
            return Err(thrown("Save path must be absolute."));
        }
        target_path = if requested.to_lowercase().ends_with(".xlsx") {
            requested.to_owned()
        } else {
            format!("{requested}.xlsx")
        };
        let key = target_path.clone();
        let authorized = env.core(move |core| {
            core.state
                .borrow()
                .mcp_writable
                .get(&view)
                .is_some_and(|paths| paths.contains(&key))
        });
        if !authorized {
            return Err(thrown("save target was not authorized"));
        }
        if Path::new(&target_path).exists()
            && request.get("overwrite").and_then(Value::as_bool) != Some(true)
        {
            return Err(thrown(format!("file already exists: {target_path}")));
        }
    } else if mode == "save" && quiet && session.unsaved_new {
        // AutoSave of a workbook the user has not named yet: the edits land in the backing temp file
        target_path = session.path.clone();
    } else if mode == "save-as" || session.suggest_save_as.is_some() {
        let macro_enabled = session
            .suggest_save_as
            .as_deref()
            .or(session.restore_target.as_deref())
            .unwrap_or(&session.path)
            .to_lowercase()
            .ends_with(".xlsm");
        // a new workbook whose panel has a project is offered in that folder
        let project_dir = if session.unsaved_new
            && session.suggest_save_as.is_some()
            && session
                .recovery_original_path
                .as_deref()
                .is_none_or(str::is_empty)
        {
            env.shell.new_document_dir(view)
        } else {
            None
        };
        // PDF/ODS (copies) only on an explicit Save As
        let offer_copies = mode == "save-as";
        let suggestion = match (&project_dir, &session.suggest_save_as) {
            (Some(dir), Some(suggested)) if !dir.is_empty() => {
                Some(join(&[dir, &basename(suggested, None)]))
            }
            _ => None,
        }
        .or_else(|| session.suggest_save_as.clone())
        .or_else(|| {
            session
                .csv_source_path
                .as_deref()
                .map(|p| match p.rfind('.') {
                    Some(at) if at + 1 < p.len() => format!("{}.xlsx", &p[..at]),
                    _ => p.to_owned(),
                })
        })
        .or_else(|| session.restore_target.clone())
        .unwrap_or_else(|| session.path.clone());
        // A name the model proposed prefills the dialog rather than replacing it
        let proposed = text(&request, "defaultName")
            .filter(|name| !name.is_empty())
            .and_then(sanitize_auto_rename_base);
        let named = match proposed {
            Some(name) => join(&[
                &dirname(&suggestion),
                &format!("{name}.{}", if macro_enabled { "xlsm" } else { "xlsx" }),
            ]),
            None => suggestion,
        };
        let parent = dialog_parent(env, view);
        let tm = env.tm.clone();
        let filters = sheets_save_as_filters(macro_enabled, offer_copies, &mut |key| tm.t(key));
        let mut entries = vec![
            (
                "defaultPath",
                JsonValue::String(if offer_copies {
                    sheets_save_as_suggestion(&named)
                } else {
                    named
                }),
            ),
            (
                "filters",
                JsonValue::Array(
                    filters
                        .iter()
                        .map(|f| json_filter(&f.name, &f.extensions))
                        .collect(),
                ),
            ),
        ];
        if session.csv_import {
            entries.push(("title", JsonValue::String(env.tm.t("csvSaveAsNotice"))));
            entries.push(("message", JsonValue::String(env.tm.t("csvSaveAsNotice"))));
        }
        let selection = save_dialog(env, parent, &dialog_options(&entries));
        let Some(file_path) = selection
            .path
            .filter(|p| !p.is_empty() && !selection.canceled)
        else {
            return Ok(obj([("canceled", IpcValue::Bool(true))]));
        };
        let pick = resolve_sheets_save_as_pick(&file_path, macro_enabled, offer_copies);
        match pick.kind {
            SaveAsKind::NeedsExtension => {
                let options = message_box(
                    "warning",
                    env.tm.t("saveAsNeedsExtension"),
                    None,
                    vec![env.tm.t("btnCloseDialog")],
                    0,
                    None,
                );
                ask(env, dialog_parent(env, view), &options);
                return Ok(obj([("canceled", IpcValue::Bool(true))]));
            }
            // A CSV pick can't ride the xlsx pipeline: hand the path back
            SaveAsKind::Csv => {
                return Ok(obj([
                    ("canceled", IpcValue::Bool(true)),
                    ("csvSaveAsPath", string(pick.path)),
                ]));
            }
            SaveAsKind::Ods | SaveAsKind::Pdf => {
                let key = pick.path.clone();
                env.core(move |core| {
                    core.state
                        .borrow_mut()
                        .save_as_export_targets
                        .authorize(f64::from(view.0), &key)
                });
                let name = if pick.kind == SaveAsKind::Ods {
                    "odsSaveAsPath"
                } else {
                    "pdfSaveAsPath"
                };
                return Ok(obj([
                    ("canceled", IpcValue::Bool(true)),
                    (name, string(pick.path)),
                ]));
            }
            SaveAsKind::Workbook => target_path = pick.path,
        }
    } else if let Some(restore) = session.restore_target.clone() {
        // Restored crash-recovery copy: Save writes straight back to the original
        let verdict = guard_split_save(
            env,
            view,
            &restore,
            recorded_state_for(&session, &restore).as_ref(),
            quiet,
        );
        if verdict == SplitVerdict::Cancel {
            return Ok(obj([("canceled", IpcValue::Bool(true))]));
        }
        if verdict != SplitVerdict::Overwrite
            && let Some(current) = sha_of(&restore)
            && Some(&current) != session.restore_target_sha.as_ref()
        {
            return Err(disk_changed(env));
        }
        target_path = restore;
    } else {
        // Plain in-place save: refuse to silently overwrite a file some other program changed
        let verdict = guard_split_save(
            env,
            view,
            &session.path,
            recorded_state_for(&session, &session.path).as_ref(),
            quiet,
        );
        if verdict == SplitVerdict::Cancel {
            return Ok(obj([("canceled", IpcValue::Bool(true))]));
        }
        if verdict != SplitVerdict::Overwrite
            && let Some(current) = sha_of(&session.path)
            && current != session.sha256
        {
            return Err(disk_changed(env));
        }
    }
    // The CSV write-back gets the same external-change guard
    if csv_in_place && let Some(csv_source) = session.csv_source_path.clone() {
        let verdict = guard_split_save(
            env,
            view,
            &csv_source,
            recorded_state_for(&session, &csv_source).as_ref(),
            quiet,
        );
        if verdict == SplitVerdict::Cancel {
            return Ok(obj([("canceled", IpcValue::Bool(true))]));
        }
        if verdict != SplitVerdict::Overwrite
            && let Some(csv_sha) = sha_of(&csv_source)
            && Some(&csv_sha) != session.csv_source_sha.as_ref()
        {
            return Err(disk_changed(env));
        }
    }
    // An encrypted workbook's save lands as plaintext only inside its own temp dir
    let plain_save_dir = match (&session.password, &session.import_temp_dir) {
        (Some(_), Some(dir)) => Some(join(&[dir, &env.uuid()])),
        _ => None,
    };
    let plain_save_path = plain_save_dir
        .as_ref()
        .map(|dir| join(&[dir, &basename(&target_path, None)]));
    if let Some(dir) = &plain_save_dir {
        fs::create_dir_all(dir).map_err(|e| io_err(e, "mkdir", dir))?;
    }
    // The save lands on the next session's snapshot first, and the sidecar
    // opens it there before any user-visible file is touched
    let staged_path = reserve_snapshot_path(env)?;
    let mutation = match write_workbook_to(env, &session, &request, &staged_path) {
        Ok(mutation) => mutation,
        Err(error) => {
            let _ = fs::remove_file(&staged_path);
            return Err(error);
        }
    };
    let staged_open = match env.engine.open(
        &staged_path,
        &super::open::document_locale(env),
        &env.shell.short_date_pattern(),
        Some(SAVE_REOPEN_TIMEOUT_MS),
    ) {
        Ok(opened) => opened,
        Err(error) => {
            let staged_bytes = fs::metadata(&staged_path).ok().map(|m| m.len() as f64);
            let _ = fs::remove_file(&staged_path);
            let failure = describe_reopen_failure(&reopen_error(&error));
            let source_format = session_source_format(&Value::Object(session.to_map()));
            append_save_failure(
                &join(&[&env.user_data_dir(), SAVE_FAILURE_LOG_FILE]),
                &SaveFailureEntry {
                    failure: failure.clone(),
                    source_format: source_format.clone(),
                    staged_bytes,
                    app_version: env.shell.app_version(),
                },
                env.shell.now_ms(),
                SAVE_FAILURE_LOG_MAX_BYTES,
            );
            if !quiet && !env.shell.is_headless() {
                show_save_unreadable_dialog(
                    env,
                    dialog_parent(env, view),
                    &reopen_failure_note(&failure),
                    &source_format,
                );
            }
            return Err(thrown(format!(
                "{} {}",
                env.tm.t("errSaveUnreadable"),
                reopen_failure_note(&failure)
            )));
        }
    };
    let placed = (|| -> Result<(), IpcError> {
        if let (Some(plain), Some(password)) = (&plain_save_path, &session.password) {
            fs::copy(&staged_path, plain).map_err(|e| io_err(e, "copyfile", &staged_path))?;
            let encrypted = env
                .engine
                .encrypt_ooxml(&read_file(&staged_path)?, password)?;
            atomic_write_file(&target_path, &encrypted).map_err(node_err)?;
        } else {
            place_staged_save(env, &staged_path, &target_path)?;
        }
        if csv_in_place
            && let (Some(csv_source), Some(content)) =
                (&session.csv_source_path, text(&request, "csvContent"))
        {
            // refresh the session's guard digest first, so a failed CSV
            // write-back leaves a retryable session
            if let Some(saved_sha) = sha_of(&session.path) {
                let (id, mut next) = (session_id.clone(), session.clone());
                next.sha256 = saved_sha;
                env.core(move |core| {
                    if let Some(tab) = core.state.borrow_mut().tab_mut(view)
                        && tab.session(&id).is_some()
                    {
                        tab.set_session(&id, next);
                    }
                });
            }
            fs::write(csv_source, csv_bytes(content)).map_err(|e| io_err(e, "open", csv_source))?;
        }
        Ok(())
    })();
    if let Err(error) = placed {
        let _ = env.engine.close(&staged_open.session_id);
        let _ = fs::remove_file(&staged_path);
        return Err(error);
    }
    // swap the sidecar session for a fresh one over the saved file
    let quiet_unsaved_new = target_path == session.path && session.unsaved_new;
    {
        let id = session_id.clone();
        env.core(move |core| {
            if let Some(tab) = core.state.borrow_mut().tab_mut(view) {
                tab.remove_session(&id);
            }
        });
    }
    cleanup_session(
        env,
        &session_id,
        &session,
        if csv_in_place || quiet_unsaved_new || plain_save_path.is_some() {
            None
        } else {
            session.import_temp_dir.as_deref()
        },
    );
    if plain_save_path.is_some() {
        let _ = fs::remove_file(&session.path);
    }
    let staged = Staged {
        snapshot_path: staged_path,
        opened: staged_open,
    };
    let options = if plain_save_path.is_some() {
        OpenOptions {
            import_temp_dir: session.import_temp_dir.clone(),
            restore_target: Some(target_path.clone()),
            password: session.password.clone(),
            ods_source_path: session.ods_source_path.clone(),
            staged: Some(staged),
            ..OpenOptions::default()
        }
    } else if csv_in_place {
        OpenOptions {
            csv_import: true,
            csv_source_path: session.csv_source_path.clone(),
            import_temp_dir: session.import_temp_dir.clone(),
            recovery_identity: session.recovery_identity.clone(),
            recovery_original_path: session.recovery_original_path.clone(),
            ods_source_path: session.ods_source_path.clone(),
            staged: Some(staged),
            ..OpenOptions::default()
        }
    } else if quiet_unsaved_new {
        OpenOptions {
            suggest_save_as: session.suggest_save_as.clone(),
            import_temp_dir: session.import_temp_dir.clone(),
            unsaved_new: true,
            recovery_identity: session.recovery_identity.clone(),
            recovery_original_path: session.recovery_original_path.clone(),
            unsaved_restore: session.unsaved_restore,
            ods_source_path: session.ods_source_path.clone(),
            ods_converted: session.ods_converted,
            formulas_dropped: session.formulas_dropped,
            staged: Some(staged),
            ..OpenOptions::default()
        }
    } else {
        OpenOptions {
            ods_source_path: session.ods_source_path.clone(),
            staged: Some(staged),
            ..OpenOptions::default()
        }
    };
    let open_path = plain_save_path
        .clone()
        .unwrap_or_else(|| target_path.clone());
    let file = open_workbook_session(env, view, &open_path, options)?.value;
    // the swap retargets the tab: a Save As renames the file the picker matches links against
    let current = if csv_in_place {
        session
            .csv_source_path
            .clone()
            .unwrap_or_else(|| target_path.clone())
    } else {
        target_path.clone()
    };
    env.core(move |core| {
        if let Some(tab) = core.state.borrow_mut().tab_mut(view) {
            tab.current_path = Some(current);
        }
    });
    let answer = |file: IpcValue| {
        obj([
            ("canceled", IpcValue::Bool(false)),
            ("file", file),
            ("touchedEntries", mutation.clone()),
        ])
    };
    if quiet_unsaved_new && session.suggest_save_as.is_some() {
        // the recovery copy tracks the saved bytes even when the periodic copy is off for size
        let source = target_path.clone();
        let copied = write_session_copy(
            env,
            view,
            &session,
            |target| {
                fs::copy(&source, target)
                    .map(|_| ())
                    .map_err(|e| io_err(e, "copyfile", &source))
            },
            true,
        );
        let _ = copied;
        return Ok(answer(file));
    }
    // Notify the shell so it can update the tab title and record the saved path
    env.shell.workbook_opened(
        view,
        &if csv_in_place {
            session
                .csv_source_path
                .clone()
                .unwrap_or_else(|| target_path.clone())
        } else {
            target_path.clone()
        },
    );
    let identities = vec![
        Some(file_identity(&target_path)),
        session_recovery_identity(&session),
        session.restore_target.as_deref().map(file_identity),
    ];
    env.core(move |core| core.delete_copies_after_save(view, identities));
    Ok(answer(file))
}

// ---- ODS export ----

const DROPPED_LABELS: [(&str, &str); 11] = [
    ("formulas", "odsLossFormulas"),
    ("charts", "odsLossCharts"),
    ("images", "odsLossImages"),
    ("conditionalFormats", "odsLossConditionalFormats"),
    ("validations", "odsLossValidations"),
    ("pivots", "odsLossPivots"),
    ("comments", "odsLossComments"),
    ("macros", "odsLossMacros"),
    ("shapes", "odsLossShapes"),
    ("slicers", "odsLossSlicers"),
    ("sparklines", "odsLossSparklines"),
];

/// `odsLosses`: the non-zero losses, in the order the warning lists them
fn ods_losses(result: &OdsConversion) -> Vec<(&'static str, f64)> {
    let mut losses = Vec::new();
    if result.formulas_dropped > 0.0 {
        losses.push(("formulas", result.formulas_dropped));
    }
    for (kind, count) in &result.dropped {
        if *count > 0.0 {
            losses.push((*kind, *count));
        }
    }
    losses
}

/// `confirmOdsLoss`
fn confirm_ods_loss(env: &Env, parent: Option<WindowId>, losses: &[(&'static str, f64)]) -> bool {
    let mut lines = vec![env.tm.t("odsLossDetail"), String::new()];
    for (kind, count) in losses {
        let key = DROPPED_LABELS
            .iter()
            .find(|(k, _)| k == kind)
            .map_or("odsLossFormulas", |(_, key)| key);
        lines.push(format!(
            "• {}",
            env.tm.with(key, &[("count", JsonValue::Number(*count))])
        ));
    }
    let options = message_box(
        "warning",
        env.tm.t("odsLossMsg"),
        Some(lines.join("\n")),
        vec![env.tm.t("odsContinueBtn"), env.tm.t("btnCancel")],
        1,
        Some(1),
    );
    ask(env, parent, &options) == 0
}

#[derive(PartialEq)]
enum Withheld {
    Xlsx,
    Export,
    Cancel,
}

/// `askWithheldExport`
fn ask_withheld_export(env: &Env, parent: Option<WindowId>, format: &str) -> Withheld {
    let params = [("format", JsonValue::String(format.to_owned()))];
    let options = message_box(
        "warning",
        env.tm.with("withheldExportMsg", &params),
        Some(env.tm.with("withheldExportDetail", &params)),
        vec![
            env.tm.t("csvKeepXlsxBtn"),
            env.tm.with("withheldExportWithoutMarksBtn", &params),
            env.tm.t("btnCancel"),
        ],
        0,
        Some(2),
    );
    match ask(env, parent, &options) {
        0 => Withheld::Xlsx,
        1 => Withheld::Export,
        _ => Withheld::Cancel,
    }
}

fn show_ods_message(env: &Env, parent: Option<WindowId>, kind: &str, message: String) {
    let options = message_box(
        kind,
        message,
        None,
        vec![env.tm.t("btnCloseDialog")],
        0,
        None,
    );
    ask(env, parent, &options);
}

/// `odsTargetPath`: dialogs that omit the extension still write .ods
fn ods_target_path(path: &str) -> String {
    if path.to_lowercase().ends_with(".ods") {
        path.to_owned()
    } else {
        format!("{path}.ods")
    }
}

fn canonical_path(path: &str) -> String {
    let absolute = resolve(&[path]);
    if let Ok(real) = fs::canonicalize(&absolute) {
        return real.to_string_lossy().into_owned();
    }
    if let Ok(real) = fs::canonicalize(dirname(&absolute)) {
        return join(&[&real.to_string_lossy(), &basename(&absolute, None)]);
    }
    absolute
}

/// `sameFilePath`: case-insensitive everywhere on purpose
fn same_file_path(a: &str, b: &str) -> bool {
    canonical_path(a).to_lowercase() == canonical_path(b).to_lowercase()
}

/// `suggestedOdsPath`
fn suggested_ods_path(session: &SessionInfo) -> String {
    let source = workbook_suggestion(session);
    let name = basename(&source, None);
    let ext = jscompat::node_path::host::extname(&name);
    let stem = if name.len() > ext.len() {
        name[..name.len() - ext.len()].to_owned()
    } else {
        name.clone()
    };
    let candidate = join(&[&dirname(&source), &format!("{stem}.ods")]);
    if let Some(original) = &session.ods_source_path
        && same_file_path(&candidate, original)
    {
        return unique_path_in(&dirname(&candidate), &basename(&candidate, None));
    }
    candidate
}

/// `workbookSuggestion`: the .xlsx-shaped path a session's Save As defaults come from
fn workbook_suggestion(session: &SessionInfo) -> String {
    session
        .suggest_save_as
        .clone()
        .or_else(|| {
            session
                .csv_source_path
                .as_deref()
                .map(super::recovery_policy::save_as_default_for)
        })
        .or_else(|| session.restore_target.clone())
        .unwrap_or_else(|| session.path.clone())
}

/// the outcomes of `exportWorkbookAsOds`
enum OdsOutcome {
    Exported { path: String, result: OdsConversion },
    Canceled,
    Redacted(Withheld),
    Unreadable,
    Failed(String),
}

/// `hidesCells`: an unreadable record counts
fn hides_cells(env: &Env, source: &str) -> bool {
    let Ok(read) = env.engine.read_redactions(source) else {
        return true;
    };
    match field(&read, "status") {
        IpcValue::String(status) if status == "absent" => false,
        IpcValue::String(status) if status == "unreadable" => true,
        _ => match field(&read, "states") {
            IpcValue::Array(states) => states.iter().any(|state| {
                matches!(field(state, "marks"), IpcValue::Array(marks) if !marks.is_empty())
            }),
            _ => false,
        },
    }
}

/// `exportWorkbookAsOds`
fn export_workbook_as_ods(
    env: &Env,
    parent: Option<WindowId>,
    source: &str,
    target: &str,
) -> OdsOutcome {
    if hides_cells(env, source) {
        let choice = ask_withheld_export(env, parent, "ODS");
        if choice != Withheld::Export {
            return OdsOutcome::Redacted(choice);
        }
    }
    let work_dir = join(&[
        &env.temp_dir(),
        &format!("seuoffice-ods-export-{}", &jscompat::random_uuid()[..8]),
    ]);
    if let Err(error) = fs::create_dir_all(&work_dir) {
        return OdsOutcome::Failed(io_err(error, "mkdtemp", &work_dir).message);
    }
    let name = basename(target, None);
    let stem = if name.to_lowercase().ends_with(".ods") {
        name[..name.len() - 4].to_owned()
    } else {
        name
    };
    let temp_ods = join(&[&work_dir, &format!("{stem}.ods")]);
    let verify = join(&[&work_dir, "verify.xlsx"]);
    let outcome = (|| {
        let result = match env.engine.convert_to_ods(source, &temp_ods) {
            Ok(result) => result,
            Err(error) => return OdsOutcome::Failed(error.message),
        };
        let losses = ods_losses(&result);
        if !losses.is_empty() && !confirm_ods_loss(env, parent, &losses) {
            return OdsOutcome::Canceled;
        }
        // Verify the private package before it replaces the target
        match env.engine.convert_workbook(&temp_ods, &verify) {
            Ok(reopened) if reopened.sheets > 0.0 => {}
            _ => return OdsOutcome::Unreadable,
        }
        let beside = join(&[&dirname(target), &format!(".{}.tmp.ods", env.uuid())]);
        let placed = fs::copy(&temp_ods, &beside)
            .map_err(|e| io_err(e, "copyfile", &temp_ods))
            .and_then(|_| env.engine.promote_file_atomically(&beside, target));
        if let Err(error) = placed {
            let _ = fs::remove_file(&beside);
            return OdsOutcome::Failed(error.message);
        }
        OdsOutcome::Exported {
            path: target.to_owned(),
            result,
        }
    })();
    let _ = fs::remove_dir_all(&work_dir);
    outcome
}

/// `exportOds`
pub fn export_ods(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.ensure_tab(view));
    schema::parse(
        &schema::strict(vec![
            ("sessionId", schema::uuid()),
            ("targetPath", schema::string().min(1).max(4096).optional()),
        ]),
        &without(&input, "workbook"),
    )?;
    let session_id = match field(&input, "sessionId") {
        IpcValue::String(id) => id.clone(),
        _ => String::new(),
    };
    // The pending edits ride along as a save request; an upload they refer to is taken first
    let workbook = field(&input, "workbook");
    let pending = if matches!(workbook, IpcValue::Undefined) {
        None
    } else {
        let parsed = parse_save_request(env, workbook)?;
        if text(&parsed, "sessionId") == Some(session_id.as_str()) {
            Some(resolve_transferred(env, view, parsed)?)
        } else {
            None
        }
    };
    let session = session_for(env, view, &session_id)?;
    let parent = dialog_parent(env, view);
    // A password workbook runs on a plaintext temp copy
    if session.password.is_some() {
        show_ods_message(env, parent, "error", env.tm.t("errOdsEncrypted"));
        return Ok(obj([
            ("canceled", IpcValue::Bool(true)),
            ("reason", string("encrypted")),
        ]));
    }
    // Save As > ODS: only the path this tab's Save As dialog just returned skips the export's own dialog
    let mut target_path: Option<String> = None;
    if let IpcValue::String(requested) = field(&input, "targetPath") {
        let (key, requested) = (requested.clone(), requested.clone());
        let taken = env.core(move |core| {
            core.state
                .borrow_mut()
                .save_as_export_targets
                .take(f64::from(view.0), &key)
        });
        if !taken {
            return Err(thrown("export target was not authorized"));
        }
        target_path = Some(ods_target_path(&requested));
    }
    // The original .ods the session was converted from is read-only for this session
    let target = loop {
        if target_path.is_none() {
            let selection = save_dialog(
                env,
                parent,
                &dialog_options(&[
                    (
                        "defaultPath",
                        JsonValue::String(suggested_ods_path(&session)),
                    ),
                    (
                        "filters",
                        JsonValue::Array(vec![json_filter(&env.tm.t("filterOds"), &["ods"])]),
                    ),
                ]),
            );
            match selection
                .path
                .filter(|p| !p.is_empty() && !selection.canceled)
            {
                Some(path) => target_path = Some(ods_target_path(&path)),
                None => {
                    return Ok(obj([
                        ("canceled", IpcValue::Bool(true)),
                        ("reason", string("canceled")),
                    ]));
                }
            }
        }
        let candidate = target_path.clone().unwrap_or_default();
        match &session.ods_source_path {
            Some(original) if same_file_path(&candidate, original) => {
                show_ods_message(env, parent, "error", env.tm.t("errOdsOriginalTarget"));
                target_path = None;
            }
            _ => break candidate,
        }
    };
    // With edits pending the package is a private copy written through the save writer
    let copy_directory = pending.as_ref().map(|_| import_dir(env));
    let outcome = (|| {
        let mut source = session.snapshot_path.clone();
        if let (Some(pending), Some(directory)) = (&pending, &copy_directory) {
            if let Err(error) = fs::create_dir_all(directory) {
                return OdsOutcome::Failed(io_err(error, "mkdir", directory).message);
            }
            source = join(&[directory, "export.xlsx"]);
            if let Err(error) = write_workbook_to(env, &session, pending, &source) {
                return OdsOutcome::Failed(error.message);
            }
        }
        export_workbook_as_ods(env, parent, &source, &target)
    })();
    if let Some(directory) = &copy_directory {
        cleanup_import_temp_directory(&env.temp_dir(), directory);
    }
    Ok(match outcome {
        OdsOutcome::Exported { path, result } => {
            let mut entries = vec![
                ("canceled".to_owned(), IpcValue::Bool(false)),
                ("path".to_owned(), string(path)),
            ];
            if let IpcValue::Object(extra) = result.value {
                entries.extend(extra);
            }
            IpcValue::Object(entries)
        }
        OdsOutcome::Redacted(choice) => {
            let mut entries = vec![
                ("canceled".to_owned(), IpcValue::Bool(true)),
                ("reason".to_owned(), string("redacted")),
            ];
            if choice == Withheld::Xlsx {
                entries.push(("saveAsXlsxInstead".to_owned(), IpcValue::Bool(true)));
            }
            IpcValue::Object(entries)
        }
        OdsOutcome::Unreadable => {
            show_ods_message(env, parent, "error", env.tm.t("errOdsReopenFailed"));
            obj([
                ("canceled", IpcValue::Bool(true)),
                ("reason", string("unreadable")),
            ])
        }
        OdsOutcome::Failed(message) => {
            show_ods_message(
                env,
                parent,
                "error",
                env.tm.with(
                    "errOdsExportFailed",
                    &[("message", JsonValue::String(message))],
                ),
            );
            obj([
                ("canceled", IpcValue::Bool(true)),
                ("reason", string("failed")),
            ])
        }
        OdsOutcome::Canceled => obj([
            ("canceled", IpcValue::Bool(true)),
            ("reason", string("canceled")),
        ]),
    })
}

/// the object without one key
fn without(value: &IpcValue, key: &str) -> IpcValue {
    match value {
        IpcValue::Object(entries) => {
            IpcValue::Object(entries.iter().filter(|(k, _)| k != key).cloned().collect())
        }
        other => other.clone(),
    }
}

// ---- CSV ----

/// `exportCsv`
pub fn export_csv(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.ensure_tab(view));
    schema::parse(
        &schema::strict(vec![
            ("fileName", schema::string().min(1).max(255)),
            ("content", schema::string().max(64_000_000)),
            ("hasFormulas", schema::boolean()),
            ("activeSheetName", schema::string().max(255).optional()),
            ("targetPath", schema::string().min(1).optional()),
        ]),
        &input,
    )?;
    let get = |key: &str| match field(&input, key) {
        IpcValue::String(text) => Some(text.clone()),
        _ => None,
    };
    let parent = dialog_parent(env, view);
    if matches!(field(&input, "hasFormulas"), IpcValue::Bool(true)) {
        // Excel's CSV warning flow: offer keeping the formulas via .xlsx first
        let options = message_box(
            "warning",
            env.tm.t("csvFormulaLossMsg"),
            Some(env.tm.t("csvFormulaLossDetail")),
            vec![
                env.tm.t("csvKeepXlsxBtn"),
                env.tm.t("csvContinueBtn"),
                env.tm.t("btnCancel"),
            ],
            0,
            Some(2),
        );
        match ask(env, parent, &options) {
            0 => {
                return Ok(obj([
                    ("canceled", IpcValue::Bool(true)),
                    ("saveAsXlsxInstead", IpcValue::Bool(true)),
                ]));
            }
            2 => return Ok(obj([("canceled", IpcValue::Bool(true))])),
            _ => {}
        }
    }
    let picked = match get("targetPath") {
        Some(path) => path,
        None => {
            let mut entries = vec![
                (
                    "defaultPath",
                    JsonValue::String(get("fileName").unwrap_or_default()),
                ),
                (
                    "filters",
                    JsonValue::Array(vec![json_filter(&env.tm.t("filterCsv"), &["csv"])]),
                ),
            ];
            if let Some(name) = get("activeSheetName").filter(|n| !n.is_empty()) {
                let notice = env.tm.with(
                    "csvActiveSheetOnlyNotice",
                    &[("name", JsonValue::String(name))],
                );
                entries.push(("title", JsonValue::String(notice.clone())));
                entries.push(("message", JsonValue::String(notice)));
            }
            let selection = save_dialog(env, parent, &dialog_options(&entries));
            match selection
                .path
                .filter(|p| !p.is_empty() && !selection.canceled)
            {
                Some(path) => path,
                None => return Ok(obj([("canceled", IpcValue::Bool(true))])),
            }
        }
    };
    let target = if picked.to_lowercase().ends_with(".csv") {
        picked
    } else {
        format!("{picked}.csv")
    };
    // UTF-8 BOM so Excel decodes the reopened file correctly
    atomic_write_file(&target, &csv_bytes(&get("content").unwrap_or_default()))
        .map_err(node_err)?;
    // An export can land on a CSV session's own source file: refresh the digest
    if let Some(written) = sha_of(&target) {
        let target = target.clone();
        env.core(move |core| {
            let mut state = core.state.borrow_mut();
            let Some(tab) = state.tab_mut(view) else {
                return;
            };
            let mut sessions: JsMap<serde_json::Map<String, Value>> = JsMap::new();
            for (id, session) in &tab.sessions {
                sessions.set(id.clone(), session.to_map());
            }
            refresh_csv_digest(&mut sessions, &target, &written);
            for (id, map) in sessions.iter() {
                if let Some(sha) = map.get("csvSourceSha").and_then(Value::as_str)
                    && let Some(mut session) = tab.session(id).cloned()
                    && session.csv_source_sha.as_deref() != Some(sha)
                {
                    session.csv_source_sha = Some(sha.to_owned());
                    tab.set_session(id, session);
                }
            }
        });
    }
    Ok(obj([
        ("canceled", IpcValue::Bool(false)),
        ("path", string(target)),
    ]))
}

/// `csvSaveConfirm`
pub fn csv_save_confirm(env: &Env, view: ViewId) -> IpcValue {
    env.core(move |core| core.ensure_tab(view));
    let options = message_box(
        "warning",
        env.tm.t("csvKeepFormatMsg"),
        Some(env.tm.t("csvKeepFormatDetail")),
        vec![
            env.tm.t("csvContinueBtn"),
            env.tm.t("csvKeepXlsxBtn"),
            env.tm.t("btnCancel"),
        ],
        0,
        Some(2),
    );
    string(match ask(env, dialog_parent(env, view), &options) {
        0 => "csv",
        1 => "xlsx",
        _ => "cancel",
    })
}

/// `csvWithheldChoice`
pub fn csv_withheld_choice(env: &Env, view: ViewId) -> IpcValue {
    env.core(move |core| core.ensure_tab(view));
    string(
        match ask_withheld_export(env, dialog_parent(env, view), "CSV") {
            Withheld::Xlsx => "xlsx",
            Withheld::Export => "export",
            Withheld::Cancel => "cancel",
        },
    )
}

// ---- PDF ----

/// `exportPdf` of the handler and pdf-export.ts
pub fn export_pdf(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.ensure_tab(view));
    let request = env.engine.parse_export_pdf_request(&input)?;
    let save_as = match field(&request, "saveAsPath") {
        IpcValue::String(path) => Some(path.clone()),
        _ => None,
    };
    // Save As > PDF: only the path this tab's Save As dialog just returned skips the export's own dialog
    if let Some(path) = &save_as {
        let key = path.clone();
        let taken = env.core(move |core| {
            core.state
                .borrow_mut()
                .save_as_export_targets
                .take(f64::from(view.0), &key)
        });
        if !taken {
            return Err(thrown("export target was not authorized"));
        }
    }
    let out_path = match field(&request, "outPath") {
        IpcValue::String(path) if !path.is_empty() => Some(path.clone()),
        _ => None,
    };
    let selected = if let Some(path) = save_as {
        Some(path)
    } else if env.shell.is_headless() && out_path.is_some() {
        out_path
    } else {
        let file_name = match field(&request, "fileName") {
            IpcValue::String(name) => name.clone(),
            _ => String::new(),
        };
        let selection = save_dialog_plain(
            env,
            env.window_of(view),
            &dialog_options(&[
                ("defaultPath", JsonValue::String(file_name)),
                (
                    "filters",
                    JsonValue::Array(vec![json_filter("PDF", &["pdf"])]),
                ),
            ]),
        );
        selection
            .path
            .filter(|p| !p.is_empty() && !selection.canceled)
    };
    let Some(path) = selected else {
        return Ok(obj([("canceled", IpcValue::Bool(true))]));
    };
    let html = match field(&request, "html") {
        IpcValue::String(html) => html.clone(),
        _ => String::new(),
    };
    let html = with_template_font_faces(&html, &env.shell.template_fonts_dir());
    let pdf = env.engine.render_pdf(&html, &request)?;
    atomic_write_file(&path, &pdf).map_err(node_err)?;
    open_generated_file(env, &path);
    Ok(obj([
        ("canceled", IpcValue::Bool(false)),
        ("path", string(path)),
    ]))
}

// ---- create document ----

/// `createDocument`: never throws, answers `{ ok: false, error }`
pub fn create_document(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.ensure_tab(view));
    let types: &'static [&'static str] = &["xlsx", "csv", "docx", "pdf", "md", "html"];
    schema::parse(
        &schema::strict(vec![
            ("type", schema::one_of(types)),
            ("title", schema::string().min(1).max(200)),
            ("content", schema::string().min(1).max(64_000_000)),
            ("sheetName", schema::string().min(1).max(31).optional()),
        ]),
        &input,
    )?;
    let get = |key: &str| match field(&input, key) {
        IpcValue::String(text) => text.clone(),
        _ => String::new(),
    };
    let kind = get("type");
    let content = get("content");
    if kind != "xlsx" && kind != "csv" && content.encode_utf16().count() > 2_000_000 {
        let mut issues = serde_json::Map::new();
        issues.insert("code".into(), Value::from("custom"));
        issues.insert("path".into(), Value::Array(vec![Value::from("content")]));
        issues.insert(
            "message".into(),
            Value::from("content must not exceed 2000000 characters for docx/pdf/md"),
        );
        return Err(schema::zod_error(vec![Value::Object(issues)]));
    }
    let failure =
        |message: String| obj([("ok", IpcValue::Bool(false)), ("error", string(message))]);
    let attempt = (|| -> Result<IpcValue, IpcError> {
        if kind == "csv" || kind == "xlsx" {
            let ext = kind.as_str();
            let file_name = format!("{}.{ext}", sanitize_generated_file_base(&get("title")));
            let bytes = if kind == "csv" {
                csv_bytes(&content)
            } else {
                let sheet = match field(&input, "sheetName") {
                    IpcValue::String(name) => name.clone(),
                    _ => "Sheet1".to_owned(),
                };
                env.engine.sheet_csv_to_xlsx(&content, &sheet)?
            };
            // with a project chosen in this view's panel, into that folder
            let placed = env
                .shell
                .write_new_document(view, &file_name, &bytes)
                .map_err(thrown)?;
            let path = match placed {
                Some(path) if !path.is_empty() => path,
                _ => {
                    let path = unique_path_in(&default_save_dir(env)?, &file_name);
                    atomic_write_file(&path, &bytes).map_err(node_err)?;
                    path
                }
            };
            open_generated_file(env, &path);
            return Ok(obj([("ok", IpcValue::Bool(true)), ("path", string(path))]));
        }
        let request = obj([
            ("type", string(kind.clone())),
            ("title", string(get("title"))),
            ("content", string(content.clone())),
        ]);
        Ok(env
            .shell
            .create_document(&request, view)
            .unwrap_or_else(|| failure("Document creation is unavailable in this host.".into())))
    })();
    Ok(attempt.unwrap_or_else(|error| failure(error.message)))
}

// ---- recovery copy, template bytes, close, rename, password ----

/// `writeWorkbookRecovery`: best-effort, silent on failure
pub fn write_workbook_recovery(
    env: &Env,
    view: ViewId,
    input: IpcValue,
) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.ensure_tab(view));
    let request = parse_save_request(env, &input)?;
    let request = resolve_transferred(env, view, request)?;
    let id = text(&request, "sessionId").unwrap_or_default().to_owned();
    let Some(session) = env.core(move |core| core.session_of(view, &id)) else {
        return Ok(ok_answer(false));
    };
    let written = write_session_copy(
        env,
        view,
        &session,
        |target| write_workbook_to(env, &session, &request, target).map(|_| ()),
        false,
    );
    Ok(ok_answer(written.unwrap_or(false)))
}

/// `workbookTemplateBytes`
pub fn template_bytes(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.ensure_tab(view));
    let request = parse_save_request(env, &input)?;
    let request = resolve_transferred(env, view, request)?;
    let id = text(&request, "sessionId").unwrap_or_default().to_owned();
    let Some(session) = env.core(move |core| core.session_of(view, &id)) else {
        return Ok(ok_answer(false));
    };
    let directory = import_dir(env);
    let outcome = (|| -> Result<Vec<u8>, IpcError> {
        fs::create_dir_all(&directory).map_err(|e| io_err(e, "mkdir", &directory))?;
        let target = join(&[&directory, "template.xlsx"]);
        write_workbook_to(env, &session, &request, &target)?;
        read_file(&target)
    })();
    cleanup_import_temp_directory(&env.temp_dir(), &directory);
    Ok(match outcome {
        Ok(bytes) => obj([
            ("ok", IpcValue::Bool(true)),
            ("bytes", crate::value::buffer(bytes)),
        ]),
        Err(_) => ok_answer(false),
    })
}

fn uuid_arg(value: &IpcValue) -> Result<String, IpcError> {
    schema::parse(&schema::uuid(), value)?;
    Ok(match value {
        IpcValue::String(id) => id.clone(),
        _ => String::new(),
    })
}

/// `closeWorkbook`
pub fn close_workbook(
    env: &Env,
    view: ViewId,
    session_arg: IpcValue,
) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.ensure_tab(view));
    let id = uuid_arg(&session_arg)?;
    let key = id.clone();
    let session = env.core(move |core| {
        let mut state = core.state.borrow_mut();
        let tab = state.tab_mut(view)?;
        tab.save_transfers.discard_session(&key);
        tab.remove_session(&key)
    });
    let Some(session) = session else {
        return Ok(IpcValue::Undefined);
    };
    // The copy is left alone here: a copy still holding unsaved work is remembered
    let noted = session.clone();
    env.core(move |core| core.note_session_closed(view, &noted));
    cleanup_session(env, &id, &session, session.import_temp_dir.as_deref());
    Ok(IpcValue::Undefined)
}

/// `autoRenameWorkbook`
pub fn auto_rename(
    env: &Env,
    view: ViewId,
    session_arg: IpcValue,
    base_arg: IpcValue,
) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.ensure_tab(view));
    let id = uuid_arg(&session_arg)?;
    let not_renamed = || obj([("renamed", IpcValue::Bool(false))]);
    let key = id.clone();
    let found = env.core(move |core| {
        let session = core.session_of(view, &key)?;
        let marked = core
            .state
            .borrow()
            .untitled_workbook_paths
            .contains(&session.path);
        marked.then_some(session)
    });
    let Some(session) = found else {
        return Ok(not_renamed());
    };
    schema::parse(&schema::string().min(1).max(100), &base_arg)?;
    let IpcValue::String(raw) = &base_arg else {
        return Ok(not_renamed());
    };
    let Some(base) = sanitize_auto_rename_base(raw) else {
        return Ok(not_renamed());
    };
    // An unsaved new workbook has no user-visible file to rename: retarget the suggested Save As name
    if let Some(suggest) = session.suggest_save_as.clone() {
        let suggest_dir = dirname(&suggest);
        let taken = |env: &Env, p: String, current: String| {
            env.core(move |core| {
                p != current && (Path::new(&p).exists() || core.suggested_path_taken(&p))
            })
        };
        let mut suggested = join(&[&suggest_dir, &format!("{base}.xlsx")]);
        let mut i = 2;
        while taken(env, suggested.clone(), suggest.clone()) && i < 100 {
            suggested = join(&[&suggest_dir, &format!("{base}-{i}.xlsx")]);
            i += 1;
        }
        if suggested == suggest || taken(env, suggested.clone(), suggest.clone()) {
            return Ok(not_renamed());
        }
        let name = basename(&suggested, None);
        let (key, mut next) = (id.clone(), session.clone());
        next.suggest_save_as = Some(suggested);
        let sent = name.clone();
        env.core(move |core| {
            if let Some(tab) = core.state.borrow_mut().tab_mut(view) {
                tab.set_session(&key, next);
            }
            core.send(view, "workbook:renamed", vec![string(sent)]);
        });
        return Ok(obj([
            ("renamed", IpcValue::Bool(true)),
            ("name", string(name)),
        ]));
    }
    let dir = dirname(&session.path);
    let mut target = join(&[&dir, &format!("{base}.xlsx")]);
    let mut i = 2;
    while Path::new(&target).exists() && i < 100 {
        target = join(&[&dir, &format!("{base}-{i}.xlsx")]);
        i += 1;
    }
    if Path::new(&target).exists() || target == session.path {
        return Ok(not_renamed());
    }
    if fs::rename(&session.path, &target).is_err() {
        return Ok(not_renamed());
    }
    let name = basename(&target, None);
    let (key, mut next, old) = (id.clone(), session.clone(), session.path.clone());
    next.path = target.clone();
    let sent = name.clone();
    env.core(move |core| {
        core.state.borrow_mut().untitled_workbook_paths.remove(&old);
        if let Some(tab) = core.state.borrow_mut().tab_mut(view) {
            tab.set_session(&key, next);
        }
        core.send(view, "workbook:renamed", vec![string(sent)]);
    });
    // Same contract as open/save: the shell updates the tab title and recents
    env.shell.workbook_opened(view, &target);
    Ok(obj([
        ("renamed", IpcValue::Bool(true)),
        ("name", string(name)),
    ]))
}

/// `updateWorkbookPassword`
pub fn update_password(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    schema::parse(
        &schema::strict(vec![
            ("sessionId", schema::uuid()),
            ("newPassword", schema::string().min(1).max(255)),
        ]),
        &input,
    )?;
    let (IpcValue::String(id), IpcValue::String(new_password)) =
        (field(&input, "sessionId"), field(&input, "newPassword"))
    else {
        return Ok(IpcValue::Undefined);
    };
    let session = session_for(env, view, id).map_err(|_| thrown("Unknown workbook session."))?;
    let encrypted_path = session.restore_target.clone();
    let (Some(_), Some(encrypted_path)) = (&session.password, encrypted_path) else {
        return Err(thrown(
            "This workbook is not protected by an open password.",
        ));
    };
    let current = sha_of(&encrypted_path);
    if let Some(current) = &current
        && Some(current) != session.restore_target_sha.as_ref()
    {
        return Err(disk_changed(env));
    }
    let bytes = env
        .engine
        .encrypt_ooxml(&read_file(&session.snapshot_path)?, new_password)?;
    let encrypted_sha = main_core::markdown::fs_util::sha256_hex(&bytes);
    if let Err(error) = atomic_write_file(&encrypted_path, &bytes) {
        // A write can fail after its bytes are in place: answer what the file holds
        if sha_of(&encrypted_path).as_deref() != Some(encrypted_sha.as_str()) {
            return Err(node_err(error));
        }
    }
    // The session follows the file before anything else is awaited
    let (key, password, sha) = (id.clone(), new_password.clone(), encrypted_sha);
    env.core(move |core| {
        if let Some(tab) = core.state.borrow_mut().tab_mut(view)
            && let Some(mut current) = tab.session(&key).cloned()
        {
            current.password = Some(password);
            current.restore_target_sha = Some(sha);
            tab.set_session(&key, current);
        }
    });
    let disk_state = record_disk_state(&encrypted_path);
    let (key, path) = (id.clone(), encrypted_path);
    env.core(move |core| {
        if let (Some(state), Some(tab)) = (disk_state, core.state.borrow_mut().tab_mut(view))
            && let Some(mut current) = tab.session(&key).cloned()
        {
            current.disk_state = Some((path, state));
            tab.set_session(&key, current);
        }
    });
    Ok(IpcValue::Undefined)
}

// ---- the chunked edit transfer ----

/// `saveEditsBegin`
pub fn save_edits_begin(core: &Core, view: ViewId, input: &IpcValue) -> Result<IpcValue, IpcError> {
    core.ensure_tab(view);
    schema::parse(
        &schema::strict(vec![
            ("sessionId", schema::uuid()),
            ("transferId", schema::uuid()),
            ("total", schema::int().positive().max(10_000_000)),
        ]),
        input,
    )?;
    let get = |key: &str| match field(input, key) {
        IpcValue::String(text) => text.clone(),
        _ => String::new(),
    };
    let session_id = get("sessionId");
    if core.session_of(view, &session_id).is_none() {
        return Err(unknown_session());
    }
    let total = match field(input, "total") {
        IpcValue::Number(n) => *n,
        _ => 0.0,
    };
    let mut state = core.state.borrow_mut();
    let tab = state.tab_mut(view).expect("ensured");
    tab.save_transfers
        .begin(
            &SaveEditsBegin {
                session_id,
                transfer_id: get("transferId"),
                total,
            },
            core.env.shell.now_ms(),
        )
        .map_err(|e| thrown(e.0))?;
    Ok(IpcValue::Undefined)
}

/// `saveEditsChunk`: the chunk's JSON is parsed on the worker
pub fn save_edits_chunk(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.ensure_tab(view));
    schema::parse(
        &schema::strict(vec![
            ("sessionId", schema::uuid()),
            ("transferId", schema::uuid()),
            ("seq", schema::int().nonneg()),
            ("editsJson", schema::string().min(2).max(256_000_000)),
        ]),
        &input,
    )?;
    let get = |key: &str| match field(&input, key) {
        IpcValue::String(text) => text.clone(),
        _ => String::new(),
    };
    let edits = env.engine.parse_edits_chunk(&get("editsJson"))?;
    let chunk = SaveEditsChunk {
        session_id: get("sessionId"),
        transfer_id: get("transferId"),
        seq: match field(&input, "seq") {
            IpcValue::Number(n) => *n,
            _ => 0.0,
        },
        edits,
    };
    env.core(move |core| {
        let mut state = core.state.borrow_mut();
        let tab = state.tab_mut(view).expect("ensured");
        tab.save_transfers
            .add_chunk(chunk, core.env.shell.now_ms())
            .map_err(|e| thrown(e.0))
    })?;
    Ok(IpcValue::Undefined)
}

/// `saveEditsAbort`: a no-op when the transfer was already consumed or expired
pub fn save_edits_abort(core: &Core, view: ViewId, input: &IpcValue) -> Result<IpcValue, IpcError> {
    core.ensure_tab(view);
    schema::parse(
        &schema::strict(vec![
            ("sessionId", schema::uuid()),
            ("transferId", schema::uuid()),
        ]),
        input,
    )?;
    let get = |key: &str| match field(input, key) {
        IpcValue::String(text) => text.clone(),
        _ => String::new(),
    };
    let mut state = core.state.borrow_mut();
    let tab = state.tab_mut(view).expect("ensured");
    tab.save_transfers
        .discard(&get("transferId"), &get("sessionId"));
    Ok(IpcValue::Undefined)
}

impl Core {
    /// `sheetsSuggestedPathTaken`: a would-be path already promised to another unsaved new workbook
    pub fn suggested_path_taken(&self, path: &str) -> bool {
        let state = self.state.borrow();
        if state
            .unsaved_new_workbooks
            .values()
            .any(|pending| pending.suggest_save_as == path)
        {
            return true;
        }
        state.tabs.iter().any(|(_, tab)| {
            tab.sessions
                .iter()
                .any(|(_, s)| s.suggest_save_as.as_deref() == Some(path))
        })
    }
}
