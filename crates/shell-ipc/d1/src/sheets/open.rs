//! The open pipeline of sheets-main.ts: `prepareWorkbookForOpen`,
//! `openWorkbookSession` and what they call. Each function is the TypeScript
//! `async` function as straight-line code on a worker; state is read and
//! changed on the core thread through [`Env::core`].

use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};

use jscompat::math_round;
use jscompat::node_path::host::{basename, join};
use main_core::markdown::fs_util::sha256_file;
use main_core::packages::electron_utils::recovery_contract::RecoveryOpenDecision;
use main_core::packages::electron_utils::recovery_prompt::{
    RecoveryOpenResult, ResolveRecoveryOnOpenOptions, resolve_recovery_on_open,
};
use main_core::packages::electron_utils::recovery_store::RecoveryCopyState;
use main_core::packages::electron_utils::save_conflict::record_disk_state;
use main_core::sheets::document_locale::legacy_csv_charset;
use main_core::sheets::temp_files::{
    SessionTemporaryResources, cleanup_import_temp_directory, cleanup_session_resources,
};
use shell_contract::{IpcError, IpcValue, ViewId, WindowId};

use super::core::{Core, Env};
use super::dialogs::{
    HostMessages, Win, dialog_options, dialog_parent, json_filter, json_strings, open_dialog,
};
use super::engine::{ImportControl, LegacyConversion, UnlockFailure};
use super::recovery::io_err;
use super::recovery_policy::{allows_automatic_workbook_recovery, converted_session_recovery};
use super::session::{OpenOptions, SessionInfo, file_identity};
use crate::value::{num, string, thrown};

use jscompat::JsonValue;

/// the extensions the open pipeline accepts (`WORKBOOK_EXTS`)
pub const WORKBOOK_EXTS: [&str; 5] = ["xlsx", "xlsm", "xls", "csv", "tsv"];

/// `PreparedWorkbookOpen`
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Prepared {
    pub open_path: String,
    pub options: OpenOptions,
}

/// `path.slice(path.lastIndexOf('.') + 1).toLowerCase()`
pub fn extension_of(path: &str) -> String {
    match path.rfind('.') {
        Some(at) => path[at + 1..].to_lowercase(),
        None => path.to_lowercase(),
    }
}

/// `text.replace(/\.[^.]+$/, replacement)`
pub fn replace_extension(text: &str, replacement: &str) -> String {
    match text.rfind('.') {
        Some(at) if at + 1 < text.len() => format!("{}{replacement}", &text[..at]),
        _ => text.to_owned(),
    }
}

/// `n.toFixed(1)`
fn to_fixed1(x: f64) -> String {
    let tenths = (x * 10.0 + 0.5).floor() as i64;
    format!("{}.{}", tenths / 10, tenths % 10)
}

pub fn import_dir(env: &Env) -> String {
    join(&[&env.temp_dir(), "seuoffice-imports", &env.uuid()])
}

fn make_dir(path: &str) -> Result<(), IpcError> {
    fs::create_dir_all(path).map_err(|e| io_err(e, "mkdir", path))
}

fn write_file(path: &str, bytes: &[u8]) -> Result<(), IpcError> {
    fs::write(path, bytes).map_err(|e| io_err(e, "open", path))
}

pub fn read_file(path: &str) -> Result<Vec<u8>, IpcError> {
    fs::read(path).map_err(|e| io_err(e, "open", path))
}

fn file_size(path: &str) -> Result<f64, IpcError> {
    fs::metadata(path)
        .map(|m| m.len() as f64)
        .map_err(|e| io_err(e, "stat", path))
}

/// `snapshotWorkbook` and `reserveSnapshotPath`
pub fn reserve_snapshot_path(env: &Env) -> Result<String, IpcError> {
    let dir = join(&[&env.temp_dir(), "seuoffice-sheets-sessions"]);
    make_dir(&dir)?;
    Ok(join(&[&dir, &format!("{}.xlsx", env.uuid())]))
}

fn snapshot_workbook(env: &Env, path: &str) -> Result<String, IpcError> {
    let snapshot = reserve_snapshot_path(env)?;
    fs::copy(path, &snapshot).map_err(|e| io_err(e, "copyfile", path))?;
    Ok(snapshot)
}

/// `cleanupSessionResources` for one session: close the sidecar session, remove
/// the snapshot and, when `with_import_dir`, its converted copy's folder
pub fn cleanup_session(
    env: &Env,
    session_id: &str,
    session: &SessionInfo,
    import_temp_dir: Option<&str>,
) {
    let engine = env.engine.clone();
    let id = session_id.to_owned();
    cleanup_session_resources(
        &SessionTemporaryResources {
            snapshot_path: &session.snapshot_path,
            import_temp_dir,
        },
        &env.temp_dir(),
        move || engine.close(&id).map_err(|_| ()),
    );
}

/// `documentLocale()`
pub fn document_locale(env: &Env) -> String {
    main_core::packages::i18n::document_locale(&env.shell.requested_locale())
}

fn legacy_charset(env: &Env) -> Option<&'static str> {
    legacy_csv_charset(&env.shell.requested_locale())
}

/// The object `workbookFileSchema.parse` returns: its keys in the schema's order
fn workbook_file_value(opened: &IpcValue, overrides: Vec<(&str, IpcValue)>) -> IpcValue {
    const KEYS: [&str; 28] = [
        "sessionId",
        "name",
        "path",
        "sha256",
        "fileBytes",
        "entryCount",
        "sheets",
        "activeTab",
        "styles",
        "dxfStyles",
        "visuals",
        "definedNames",
        "readOnly",
        "needsSaveAs",
        "odsConverted",
        "formulasDropped",
        "unsavedNew",
        "csvPath",
        "emptyCsv",
        "restoredFromRecovery",
        "automaticRecoveryDisabled",
        "passwordProtected",
        "themeColors",
        "themeFonts",
        "normalFontName",
        "workbookProtection",
        "date1904",
        "shortDateFormat",
    ];
    let mut merged: Vec<(String, IpcValue)> = match opened {
        IpcValue::Object(entries) => entries.clone(),
        _ => Vec::new(),
    };
    for (key, value) in overrides {
        match merged.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = value,
            None => merged.push((key.to_owned(), value)),
        }
    }
    let mut out = Vec::new();
    for key in KEYS {
        match merged.iter().find(|(k, _)| k == key) {
            Some((_, value)) if !matches!(value, IpcValue::Undefined) => {
                out.push((key.to_owned(), value.clone()))
            }
            _ if key == "activeTab" => out.push((key.to_owned(), num(0.0))),
            _ => {}
        }
    }
    IpcValue::Object(out)
}

/// What `openWorkbookSession` leaves: the answer and the session it registered
pub struct OpenedSession {
    pub value: IpcValue,
    pub session_id: String,
    pub session: SessionInfo,
}

/// `openWorkbookSession(client, path, sessions, options)`
pub fn open_workbook_session(
    env: &Env,
    view: ViewId,
    path: &str,
    options: OpenOptions,
) -> Result<OpenedSession, IpcError> {
    // Snapshot first, then the sidecar opens the snapshot (not the live path)
    let snapshot_path = match &options.staged {
        Some(staged) => staged.snapshot_path.clone(),
        None => snapshot_workbook(env, path)?,
    };
    let disk_state_path = options
        .restore_target
        .clone()
        .or_else(|| options.csv_source_path.clone())
        .unwrap_or_else(|| path.to_owned());
    let attempt = (|| -> Result<(OpenedSession, f64), IpcError> {
        let opened = match &options.staged {
            Some(staged) => staged.opened.clone(),
            None => env.engine.open(
                &snapshot_path,
                &document_locale(env),
                &env.shell.short_date_pattern(),
                None,
            )?,
        };
        let digest = sha256_file(&snapshot_path).map_err(super::recovery::node_err)?;
        let snapshot_size = file_size(&snapshot_path)?;
        let restore_target_sha = options
            .restore_target
            .as_deref()
            .and_then(|p| sha256_file(p).ok());
        let csv_source_sha = options
            .csv_source_path
            .as_deref()
            .and_then(|p| sha256_file(p).ok());
        let disk_state = record_disk_state(&disk_state_path);
        // an encrypted workbook writes no recovery copy: it would be plaintext
        let automatic_recovery_disabled =
            options.password.is_some() || !allows_automatic_workbook_recovery(&opened.sheets);
        let session = SessionInfo {
            path: path.to_owned(),
            snapshot_path: snapshot_path.clone(),
            sha256: digest.clone(),
            sheet_names: opened
                .sheets
                .iter()
                .map(|sheet| (sheet.id.clone(), sheet.name.clone()))
                .collect(),
            automatic_recovery_disabled,
            suggest_save_as: options.suggest_save_as.clone(),
            ods_converted: options.ods_converted,
            formulas_dropped: options.formulas_dropped,
            ods_source_path: options.ods_source_path.clone(),
            csv_import: options.csv_import,
            csv_source_path: options.csv_source_path.clone(),
            csv_source_sha,
            import_temp_dir: options.import_temp_dir.clone(),
            restore_target: options.restore_target.clone(),
            restore_target_sha,
            empty_source: options.empty_source,
            unsaved_new: options.unsaved_new,
            password: options.password.clone(),
            recovery_identity: options.recovery_identity.clone(),
            recovery_original_path: options.recovery_original_path.clone(),
            unsaved_restore: options.unsaved_restore,
            disk_state: disk_state.map(|state| (disk_state_path.clone(), state)),
        };
        let display_name = options
            .restore_target
            .as_deref()
            .or(options.csv_source_path.as_deref())
            .or(options.ods_source_path.as_deref())
            .or(options.suggest_save_as.as_deref())
            .unwrap_or(path);
        let mut overrides = vec![
            ("name", string(basename(display_name, None))),
            (
                "path",
                string(
                    options
                        .restore_target
                        .clone()
                        .unwrap_or_else(|| path.to_owned()),
                ),
            ),
            ("sha256", string(digest)),
            ("fileBytes", num(snapshot_size)),
            ("readOnly", IpcValue::Bool(false)),
            (
                "needsSaveAs",
                IpcValue::Bool(options.suggest_save_as.is_some()),
            ),
        ];
        if options.ods_converted {
            overrides.push(("odsConverted", IpcValue::Bool(true)));
        }
        if let Some(count) = options.formulas_dropped {
            overrides.push(("formulasDropped", num(count)));
        }
        if options.unsaved_new {
            overrides.push(("unsavedNew", IpcValue::Bool(true)));
        }
        if let Some(csv) = &options.csv_source_path {
            overrides.push(("csvPath", string(csv.clone())));
        }
        if options.empty_csv {
            overrides.push(("emptyCsv", IpcValue::Bool(true)));
        }
        overrides.push((
            "restoredFromRecovery",
            IpcValue::Bool(options.restore_target.is_some() && options.password.is_none()),
        ));
        overrides.push((
            "automaticRecoveryDisabled",
            IpcValue::Bool(automatic_recovery_disabled),
        ));
        if options.password.is_some() && options.restore_target.is_some() {
            overrides.push(("passwordProtected", IpcValue::Bool(true)));
        }
        let value = workbook_file_value(&opened.value, overrides);
        Ok((
            OpenedSession {
                value,
                session_id: opened.session_id,
                session,
            },
            snapshot_size,
        ))
    })();
    match attempt {
        Ok((opened, _)) => {
            let (id, registered, path) = (
                opened.session_id.clone(),
                opened.session.clone(),
                path.to_owned(),
            );
            env.core(move |core| {
                if let Some(tab) = core.state.borrow_mut().tab_mut(view) {
                    tab.set_session(&id, registered);
                }
                core.state.borrow_mut().unsaved_new_workbooks.remove(&path);
            });
            Ok(opened)
        }
        Err(error) => {
            if let Some(staged) = &options.staged {
                let _ = env.engine.close(&staged.opened.session_id);
            }
            let _ = fs::remove_file(&snapshot_path);
            let key = path.to_owned();
            env.core(move |core| {
                core.state.borrow_mut().unsaved_new_workbooks.remove(&key);
            });
            if let Some(dir) = &options.import_temp_dir {
                cleanup_import_temp_directory(&env.temp_dir(), dir);
            }
            Err(error)
        }
    }
}

/// `discardPreparedOpen`: the tab died between prepare and open
pub fn discard_prepared_open(env: &Env, prepared: &Prepared) {
    let key = prepared.open_path.clone();
    env.core(move |core| {
        core.state.borrow_mut().unsaved_new_workbooks.remove(&key);
    });
    if let Some(dir) = &prepared.options.import_temp_dir {
        cleanup_import_temp_directory(&env.temp_dir(), dir);
    }
}

/// `openEmptyXlsx`: a 0-byte .xlsx is an empty workbook, not a corrupt one
fn open_empty_xlsx(env: &Env, path: &str) -> Result<Prepared, IpcError> {
    let directory = import_dir(env);
    make_dir(&directory)?;
    let open_path = join(&[&directory, &basename(path, None)]);
    let written = env
        .engine
        .blank_xlsx()
        .and_then(|bytes| write_file(&open_path, &bytes));
    if let Err(error) = written {
        cleanup_import_temp_directory(&env.temp_dir(), &directory);
        return Err(error);
    }
    Ok(Prepared {
        open_path,
        options: OpenOptions {
            import_temp_dir: Some(directory),
            restore_target: Some(path.to_owned()),
            empty_source: true,
            ..OpenOptions::default()
        },
    })
}

/// `convertLegacyImport`: the formulas the conversion could not translate
fn convert_legacy_import(env: &Env, path: &str, target: &str) -> Result<f64, IpcError> {
    match env
        .engine
        .convert_legacy_workbook(path, target, legacy_charset(env))?
    {
        LegacyConversion::HtmlTooLarge => Err(thrown(env.tm.t("errFileTooLarge"))),
        LegacyConversion::HtmlNoTable => Err(thrown(env.tm.t("errHtmlNoTable"))),
        LegacyConversion::Html => Ok(0.0),
        LegacyConversion::Workbook { formulas_dropped } => Ok(formulas_dropped),
    }
}

/// the size check of a delimited import, then the conversion
fn convert_delimited(
    env: &Env,
    path: &str,
    delimiter: Option<char>,
    control: Option<&ImportControl<'_>>,
) -> Result<super::engine::CsvConverted, IpcError> {
    let size = file_size(path)?;
    let limit = env.shell.delimited_import_limit();
    if size > limit {
        let limit_mb = math_round(limit / 1024.0 / 1024.0);
        let size_mb = to_fixed1(size / 1024.0 / 1024.0);
        return Err(thrown(format!(
            "{} ({size_mb} MB)",
            env.tm
                .with("errTooLarge", &[("mb", JsonValue::Number(limit_mb))])
        )));
    }
    env.engine.csv_to_xlsx_for_open(
        &read_file(path)?,
        legacy_charset(env),
        "Sheet1",
        delimiter,
        control,
    )
}

fn has_cfb_header(env: &Env, path: &str) -> Result<bool, IpcError> {
    let mut file = fs::File::open(path).map_err(|e| io_err(e, "open", path))?;
    let mut head = [0u8; 8];
    let mut read = 0;
    while read < head.len() {
        let n = file
            .read(&mut head[read..])
            .map_err(|e| io_err(e, "read", path))?;
        if n == 0 {
            break;
        }
        read += n;
    }
    Ok(env.engine.is_cfb_header(&head[..read]))
}

fn show_encrypted_open_failure(env: &Env, parent: Option<WindowId>) {
    let options = shell_contract::hosts::MessageBox {
        kind: Some("warning".into()),
        title: None,
        message: env.tm.t("errEncryptedOpenTitle"),
        detail: Some(env.tm.t("errEncryptedUnsupported")),
        buttons: Vec::new(),
        default_id: None,
        cancel_id: None,
        checkbox_label: None,
    };
    env.dialogs.message(parent, &options);
}

/// `prepareEncryptedWorkbook`'s three answers
enum Encrypted {
    /// `undefined`: not an encrypted file
    No,
    /// `null`: cancelled or refused
    Cancelled,
    Opened(Box<Prepared>),
}

fn prepare_encrypted(
    env: &Env,
    path: &str,
    extension: &str,
    parent: Option<WindowId>,
) -> Result<Encrypted, IpcError> {
    if !matches!(extension, "xlsx" | "xlsm" | "xls") {
        return Ok(Encrypted::No);
    }
    if !has_cfb_header(env, path)? {
        return Ok(Encrypted::No);
    }
    let bytes = read_file(path)?;
    if !env.engine.is_encrypted_office_file(&bytes) {
        return Ok(Encrypted::No);
    }
    // a headless export has no one to ask
    let headless = env.shell.is_headless();
    let prompt = if headless {
        None
    } else {
        env.shell.password_prompt(parent, &basename(path, None))
    };
    let unlocked = env
        .engine
        .unlock_office_file(&bytes, &mut |retry| match &prompt {
            Some(prompt) => Ok(prompt.ask(retry)),
            None if headless => Ok(None),
            None => Err(UnlockFailure::Decrypt),
        });
    if let Some(prompt) = &prompt {
        prompt.close();
    }
    let unlocked = match unlocked {
        Err(UnlockFailure::Decrypt) => {
            if !headless {
                show_encrypted_open_failure(env, parent);
            }
            return Ok(Encrypted::Cancelled);
        }
        Err(UnlockFailure::Other(error)) => return Err(error),
        Ok(None) => return Ok(Encrypted::Cancelled),
        Ok(Some(unlocked)) => unlocked,
    };
    let directory = import_dir(env);
    make_dir(&directory)?;
    let built = (|| -> Result<Prepared, IpcError> {
        if extension != "xls" {
            let open_path = join(&[&directory, &basename(path, None)]);
            write_file(&open_path, &unlocked.bytes)?;
            return Ok(Prepared {
                open_path,
                options: OpenOptions {
                    import_temp_dir: Some(directory.clone()),
                    restore_target: Some(path.to_owned()),
                    password: Some(unlocked.password.clone()),
                    ..OpenOptions::default()
                },
            });
        }
        let stem = replace_extension(&basename(path, None), "");
        let plain_xls = join(&[&directory, &format!("{stem}.xls")]);
        let open_path = join(&[&directory, &format!("{stem}.xlsx")]);
        write_file(&plain_xls, &unlocked.bytes)?;
        env.engine.convert_workbook(&plain_xls, &open_path)?;
        let _ = fs::remove_file(&plain_xls);
        Ok(Prepared {
            open_path,
            options: OpenOptions {
                import_temp_dir: Some(directory.clone()),
                suggest_save_as: Some(replace_extension(path, ".xlsx")),
                // Excel's built-in password guarded only editing
                password: unlocked.asked.then(|| unlocked.password.clone()),
                ..OpenOptions::default()
            },
        })
    })();
    match built {
        Ok(prepared) => Ok(Encrypted::Opened(Box::new(prepared))),
        Err(error) => {
            cleanup_import_temp_directory(&env.temp_dir(), &directory);
            Err(error)
        }
    }
}

/// What `recoveredOpenFor` decided on the core thread
enum Recovered {
    /// open the file as saved
    Skip,
    Restore(Vec<u8>),
}

impl Core {
    /// `recoveredOpenFor` up to the copy's bytes: the launch list's decision
    /// or the named per-file prompt (Esc and closing restore)
    fn recovered_decision(
        &self,
        view: Option<ViewId>,
        path: &str,
        parent: Option<WindowId>,
    ) -> Recovered {
        // a headless export converts the file on disk: no one is there to answer
        if self.env.shell.is_headless() {
            return Recovered::Skip;
        }
        let identity = file_identity(path);
        let Some(key) = self.env.copy_key(&identity) else {
            return Recovered::Skip;
        };
        let decided = view.and_then(|v| {
            let state = self.state.borrow();
            state
                .decided_opens
                .get(&v)
                .filter(|(decided_path, _)| decided_path == path)
                .map(|(_, decision)| *decision)
        });
        if let Some(v) = view
            && decided.is_some()
        {
            self.state.borrow_mut().decided_opens.remove(&v);
        }
        if let Some(v) = view {
            self.state.borrow_mut().recovery_of(v).held.remove(&key);
        }
        // a second view of a file another tab keeps a copy for: nothing is asked
        if let Some(v) = view
            && self.copy_owned_by_another_view(v, &identity)
        {
            self.state.borrow_mut().recovery_of(v).held.insert(key);
            return Recovered::Skip;
        }
        if decided == Some(RecoveryOpenDecision::Original) {
            return Recovered::Skip;
        }
        let attempt: Result<Option<Vec<u8>>, ()> = if decided.is_some() {
            self.env.with_store(|store| {
                let bytes = store.read_copy(&identity);
                if bytes.is_some() {
                    let _ = store.mark_copy_loaded(&identity);
                }
                Ok(bytes)
            })
        } else {
            let dialog = HostMessages(&*self.env.dialogs);
            let parent = parent.map(Win);
            let lang = self.env.tm.lang();
            self.env.with_store(|store| {
                resolve_recovery_on_open(&ResolveRecoveryOnOpenOptions {
                    store,
                    identity: &identity,
                    dialog: &dialog,
                    parent: parent.as_ref(),
                    lang: lang.as_str(),
                    document_name: None,
                })
                .map(|resolved| match resolved {
                    RecoveryOpenResult::Restore { bytes, .. } => Some(bytes),
                    RecoveryOpenResult::Original => None,
                })
                .map_err(|_| ())
            })
        };
        match attempt {
            Ok(Some(bytes)) => Recovered::Restore(bytes),
            Ok(None) => Recovered::Skip,
            Err(()) => {
                self.recovery_failed(view, path);
                Recovered::Skip
            }
        }
    }

    /// The copy could not be prepared: the file opens as saved and the copy
    /// waits for the next open or launch, untouched by this tab meanwhile
    fn recovery_failed(&self, view: Option<ViewId>, path: &str) {
        let identity = file_identity(path);
        let _ = self
            .env
            .with_store(|store| store.set_copy_state(&identity, RecoveryCopyState::Later));
        if let (Some(v), Some(key)) = (view, self.env.copy_key(&identity)) {
            self.state.borrow_mut().recovery_of(v).held.insert(key);
        }
    }
}

/// `recoveredOpenFor`
fn recovered_open_for(
    env: &Env,
    path: &str,
    view: Option<ViewId>,
    parent: Option<WindowId>,
) -> Option<Prepared> {
    let key = path.to_owned();
    let decision = env.core(move |core| core.recovered_decision(view, &key, parent));
    let Recovered::Restore(bytes) = decision else {
        return None;
    };
    match stage_recovered_copy(env, &bytes, &basename(path, None)) {
        Ok((open_path, directory)) => Some(Prepared {
            open_path,
            options: OpenOptions {
                import_temp_dir: Some(directory),
                restore_target: Some(path.to_owned()),
                unsaved_restore: true,
                ..OpenOptions::default()
            },
        }),
        Err(_) => {
            let key = path.to_owned();
            env.core(move |core| core.recovery_failed(view, &key));
            None
        }
    }
}

/// `stageRecoveredCopy`: copy bytes into a temp file the session runs on
pub fn stage_recovered_copy(
    env: &Env,
    bytes: &[u8],
    name: &str,
) -> Result<(String, String), IpcError> {
    let directory = import_dir(env);
    make_dir(&directory)?;
    let open_path = join(&[&directory, name]);
    if let Err(error) = write_file(&open_path, bytes) {
        cleanup_import_temp_directory(&env.temp_dir(), &directory);
        return Err(error);
    }
    Ok((open_path, directory))
}

/// How a prepare reports a delimited import
pub struct PrepareOptions<'a> {
    pub skip_recovery_prompt: bool,
    pub import: Option<&'a ImportControl<'a>>,
}

/// `prepareWorkbookForOpen`: `None` when an encrypted file's open was cancelled or refused
pub fn prepare_workbook_for_open(
    env: &Env,
    path: &str,
    view: Option<ViewId>,
    parent: Option<WindowId>,
    options: &PrepareOptions<'_>,
) -> Result<Option<Prepared>, IpcError> {
    // A shell-created "New spreadsheet" opens from a temp directory
    let key = path.to_owned();
    let unsaved_new =
        env.core(move |core| core.state.borrow().unsaved_new_workbooks.get(&key).cloned());
    if let Some(unsaved) = unsaved_new {
        let base = OpenOptions {
            suggest_save_as: Some(unsaved.suggest_save_as.clone()),
            import_temp_dir: Some(unsaved.temp_dir.clone()),
            unsaved_new: true,
            recovery_identity: Some(unsaved.recovery.clone()),
            unsaved_restore: unsaved.restored,
            recovery_original_path: unsaved.original_path.clone(),
            ods_converted: unsaved.ods_converted,
            formulas_dropped: if unsaved.ods_converted {
                unsaved.formulas_dropped
            } else {
                None
            },
            ods_source_path: if unsaved.ods_converted {
                unsaved.ods_source_path.clone()
            } else {
                None
            },
            ..OpenOptions::default()
        };
        let copy_extension = extension_of(path);
        if matches!(copy_extension.as_str(), "csv" | "tsv" | "xls") {
            let stem = replace_extension(&basename(path, None), "");
            let open_path = join(&[
                &unsaved.temp_dir,
                &format!("{stem}-{}.xlsx", &env.uuid()[..8]),
            ]);
            if copy_extension == "xls" {
                convert_legacy_import(env, path, &open_path)?;
            } else {
                let converted =
                    convert_delimited(env, path, (copy_extension == "tsv").then_some('\t'), None)?;
                write_file(&open_path, &converted.buffer)?;
            }
            // the mark follows the file the session edits
            let (from, to, mark) = (path.to_owned(), open_path.clone(), unsaved.clone());
            env.core(move |core| {
                let mut state = core.state.borrow_mut();
                state.unsaved_new_workbooks.remove(&from);
                state.unsaved_new_workbooks.insert(to, mark);
            });
            return Ok(Some(Prepared {
                open_path,
                options: base,
            }));
        }
        // a copy reopened as untitled: its content is the backing file already
        if unsaved.restored {
            let identity = unsaved.recovery.clone();
            env.core(move |core| {
                let _ = core
                    .env
                    .with_store(|store| store.mark_copy_loaded(&identity));
            });
        }
        return Ok(Some(Prepared {
            open_path: path.to_owned(),
            options: base,
        }));
    }
    let extension = extension_of(path);
    // An encrypted file never has a recovery copy
    match prepare_encrypted(env, path, &extension, parent)? {
        Encrypted::Opened(prepared) => return Ok(Some(*prepared)),
        Encrypted::Cancelled => return Ok(None),
        Encrypted::No => {}
    }
    if !matches!(extension.as_str(), "csv" | "tsv" | "xls" | "ods") {
        // Unsaved work from a lost session is settled before the file's content loads
        if !options.skip_recovery_prompt
            && let Some(recovered) = recovered_open_for(env, path, view, parent)
        {
            return Ok(Some(recovered));
        }
        if extension == "xlsx" && file_size(path)? == 0.0 {
            return open_empty_xlsx(env, path).map(Some);
        }
        return Ok(Some(Prepared {
            open_path: path.to_owned(),
            options: OpenOptions::default(),
        }));
    }
    let stem = replace_extension(&basename(path, None), "");
    let directory = import_dir(env);
    make_dir(&directory)?;
    let open_path = join(&[&directory, &format!("{stem}.xlsx")]);
    let mut empty_csv = false;
    let mut formulas_dropped = 0.0;
    let converted = (|| -> Result<(), IpcError> {
        if extension == "csv" || extension == "tsv" {
            // A .tsv's delimiter is declared by its extension; a .csv keeps the sniff
            let converted = convert_delimited(
                env,
                path,
                (extension == "tsv").then_some('\t'),
                options.import,
            )?;
            empty_csv = converted.empty;
            write_file(&open_path, &converted.buffer)
        } else {
            formulas_dropped = convert_legacy_import(env, path, &open_path)?;
            Ok(())
        }
    })();
    if let Err(error) = converted {
        cleanup_import_temp_directory(&env.temp_dir(), &directory);
        return Err(error);
    }
    Ok(Some(if extension == "csv" {
        Prepared {
            open_path,
            options: OpenOptions {
                import_temp_dir: Some(directory),
                csv_import: true,
                csv_source_path: Some(path.to_owned()),
                empty_csv,
                ..OpenOptions::default()
            },
        }
    } else {
        Prepared {
            open_path,
            options: OpenOptions {
                import_temp_dir: Some(directory),
                suggest_save_as: Some(replace_extension(path, ".xlsx")),
                ods_converted: extension == "ods",
                formulas_dropped: (extension == "ods").then_some(formulas_dropped),
                ods_source_path: (extension == "ods").then(|| path.to_owned()),
                ..OpenOptions::default()
            },
        }
    }))
}

/// `reportProgress` of the open handler: the bar this open owns
fn report_progress(
    env: &Env,
    view: ViewId,
    token: u64,
    reported: &AtomicBool,
    progress: Option<IpcValue>,
) {
    env.core({
        let was_reported = reported.load(Ordering::SeqCst);
        move |core| {
            if !core.env.alive(view) {
                return None;
            }
            let owns = {
                let state = core.state.borrow();
                match (
                    state.import_controllers.get(&token),
                    state.pending_imports.controller_for(f64::from(view.0)),
                ) {
                    (Some(mine), Some(current)) => mine.same(&current),
                    _ => false,
                }
            };
            if !owns {
                return None;
            }
            match &progress {
                None if !was_reported => return None,
                None => {}
                Some(_) => {}
            }
            core.send(
                view,
                "workbook:import-progress",
                vec![progress.clone().unwrap_or(IpcValue::Null)],
            );
            Some(progress.is_some())
        }
    })
    .map(|now_reported| reported.store(now_reported, Ordering::SeqCst))
    .unwrap_or(());
}

/// `openSelectedWorkbook`: `explicit` re-opens a known file without the picker
/// or the shell queue
pub fn open_selected_workbook(
    env: &Env,
    view: ViewId,
    explicit: Option<String>,
) -> Result<IpcValue, IpcError> {
    let queued = env.core(move |core| {
        core.ensure_tab(view);
        core.state.borrow_mut().queued_workbooks.remove(&view)
    });
    let path = match explicit.or(queued) {
        Some(path) => path,
        None => {
            let parent = dialog_parent(env, view);
            let picked = open_dialog(
                env,
                parent,
                &dialog_options(&[
                    ("properties", json_strings(&["openFile"])),
                    (
                        "filters",
                        JsonValue::Array(vec![json_filter(
                            &env.tm.t("filterSpreadsheets"),
                            &["xlsx", "xlsm", "xls", "csv", "tsv", "ods"],
                        )]),
                    ),
                ]),
            );
            match picked.paths.first() {
                Some(path) if !picked.canceled => path.clone(),
                _ => return Ok(IpcValue::Null),
            }
        }
    };
    // a delimited import can take a while, so the renderer watches its progress and can cancel it
    let token = env.core(move |core| {
        let owner = f64::from(view.0);
        let superseded = core
            .state
            .borrow()
            .pending_imports
            .controller_for(owner)
            .is_some();
        let controller = core.state.borrow_mut().pending_imports.start(owner);
        let token = {
            let mut state = core.state.borrow_mut();
            state.next_token += 1;
            let token = state.next_token;
            state.import_controllers.insert(token, controller);
            token
        };
        // a superseded import may have left its bar standing
        if superseded && core.env.alive(view) {
            core.send(view, "workbook:import-progress", vec![IpcValue::Null]);
        }
        token
    });
    let reported = AtomicBool::new(false);
    let cancelled = || {
        env.core(move |core| {
            core.state
                .borrow()
                .import_controllers
                .get(&token)
                .is_some_and(|c| c.aborted())
        })
    };
    let on_progress =
        |progress: IpcValue| report_progress(env, view, token, &reported, Some(progress));
    let control = ImportControl {
        on_progress: &on_progress,
        cancelled: &cancelled,
    };
    let parent = dialog_parent(env, view);
    let prepared = prepare_workbook_for_open(
        env,
        &path,
        Some(view),
        parent,
        &PrepareOptions {
            skip_recovery_prompt: false,
            import: Some(&control),
        },
    );
    let was_cancelled = cancelled();
    // the import is over (done, failed or cancelled): the bar must not stand into the next open
    report_progress(env, view, token, &reported, None);
    env.core(move |core| {
        let mut state = core.state.borrow_mut();
        if let Some(controller) = state.import_controllers.remove(&token) {
            state.pending_imports.finish(f64::from(view.0), &controller);
        }
    });
    let prepared = match prepared {
        Ok(prepared) => prepared,
        // The user stopped the import: nothing opens, and it is not a failure to report
        Err(_) if was_cancelled => return Ok(IpcValue::Null),
        Err(error) => return Err(error),
    };
    // a decision the shell passed for this tab served this open (or never applied)
    env.core(move |core| {
        core.state.borrow_mut().decided_opens.remove(&view);
    });
    let Some(prepared) = prepared else {
        return Ok(IpcValue::Null);
    };
    // The recovery prompt can outlive the tab
    if !env.alive(view) {
        discard_prepared_open(env, &prepared);
        return Ok(IpcValue::Null);
    }
    // a CSV or converted workbook keeps its unsaved work in an untitled copy
    let converted = converted_session_recovery(&prepared.options, &path, jscompat::random_uuid);
    let mut options = prepared.options.clone();
    if let Some(converted) = &converted {
        options.recovery_identity = Some(converted.recovery_identity.clone());
        options.recovery_original_path = Some(converted.recovery_original_path.clone());
    }
    let opened = open_workbook_session(env, view, &prepared.open_path, options)?;
    let current = path.clone();
    env.core(move |core| {
        if let Some(tab) = core.state.borrow_mut().tab_mut(view) {
            tab.current_path = Some(current);
        }
    });
    // The sidecar open itself can also outlive the tab
    if !env.alive(view) {
        let id = opened.session_id.clone();
        env.core(move |core| {
            if let Some(tab) = core.state.borrow_mut().tab_mut(view) {
                tab.remove_session(&id);
            }
        });
        cleanup_session(
            env,
            &opened.session_id,
            &opened.session,
            opened.session.import_temp_dir.as_deref(),
        );
        return Ok(IpcValue::Null);
    }
    // an unsaved new workbook's tab already shows the untitled name
    if !prepared.options.unsaved_new {
        env.shell.workbook_opened(view, &path);
    }
    // a password workbook keeps no recovery copy: say so once in this tab
    if prepared.options.password.is_some() {
        env.core(move |core| core.show_unprotectable_notice(view));
    }
    Ok(opened.value)
}

/// `openMergeSources`
pub fn open_merge_sources(env: &Env, view: ViewId, paths: &[String]) -> Result<IpcValue, IpcError> {
    env.core(move |core| core.ensure_tab(view));
    let mut opened: Vec<(String, SessionInfo)> = Vec::new();
    let mut values: Vec<IpcValue> = Vec::new();
    let close_opened = |opened: &mut Vec<(String, SessionInfo)>| {
        for (id, session) in opened.drain(..) {
            let key = id.clone();
            env.core(move |core| {
                if let Some(tab) = core.state.borrow_mut().tab_mut(view) {
                    tab.remove_session(&key);
                }
            });
            cleanup_session(env, &id, &session, session.import_temp_dir.as_deref());
        }
    };
    let parent = dialog_parent(env, view);
    let outcome = (|| -> Result<bool, IpcError> {
        for path in paths {
            let prepared = prepare_workbook_for_open(
                env,
                path,
                Some(view),
                parent,
                &PrepareOptions {
                    skip_recovery_prompt: true,
                    import: None,
                },
            )?;
            // a cancelled password prompt cancels the whole merge pick
            let Some(prepared) = prepared else {
                return Ok(false);
            };
            if !env.alive(view) {
                discard_prepared_open(env, &prepared);
                break;
            }
            let mut options = prepared.options.clone();
            options.empty_csv = false;
            let result = open_workbook_session(env, view, &prepared.open_path, options)?;
            opened.push((result.session_id.clone(), result.session.clone()));
            values.push(result.value.clone());
            if !env.alive(view) {
                break;
            }
        }
        Ok(true)
    })();
    match outcome {
        Err(error) => {
            // a later file failing must not strand the sessions already opened
            close_opened(&mut opened);
            return Err(error);
        }
        Ok(false) => {
            close_opened(&mut opened);
            return Ok(IpcValue::Null);
        }
        Ok(true) => {}
    }
    if !env.alive(view) {
        close_opened(&mut opened);
        return Ok(IpcValue::Null);
    }
    if values.is_empty() {
        Ok(IpcValue::Null)
    } else {
        Ok(IpcValue::Array(values))
    }
}
