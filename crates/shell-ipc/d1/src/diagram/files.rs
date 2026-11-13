//! `registerDiagramIpc()` of `diagram-main.ts`: opening, saving, the close and
//! save acknowledgements, recovery copies, the seed. A save is a round trip:
//! the renderer asks where (`save-target`), then hands the bytes over with
//! the token it got (`save`).

use std::collections::HashSet;

use jscompat::node_path::host::{basename, dirname, join};
use jscompat::{JsObject, JsonValue, js_regex, random_uuid, slice_utf16, trim};
use main_core::packages::electron_utils::atomic_write::atomic_write_file;
use main_core::packages::electron_utils::default_save_dir::configured_default_save_dir;
use main_core::packages::electron_utils::dialog_memory::show_save_dialog_with_memory;
use main_core::packages::electron_utils::recovery_store::RecoveryWriteResult;
use main_core::packages::electron_utils::save_conflict::{
    ProbeThrew, SaveConflictAnswer, SaveConflictOptions, confirm_overwrite_if_conflicted,
    record_disk_state, should_defer_auto_save,
};
use shell_contract::ipc::CallContext;
use shell_contract::{IpcError, IpcValue, ViewId, WindowId};

use super::DiagramViews;
use super::formats::{
    Detected, DiagramFormat, SAVE_AS_FORMATS, detect_format, diagram_base_name, filter_extension,
    format_for_save_path, format_of_path, is_compressed_file, openable_link, safe_file_name_base,
    with_format_extension,
};
use super::recovery::{BoxDialog, Parent};
use super::state::{Import, Target, Unopened, WaitEnd};
use crate::host::{HostDialog, Paths};
use crate::value::{Args, as_bytes, buffer, field, obj, string, thrown};

type Reply = Result<IpcValue, IpcError>;

fn failure(error: impl Into<String>) -> IpcValue {
    obj([("ok", IpcValue::Bool(false)), ("error", string(error))])
}

fn status(name: &str) -> IpcValue {
    obj([("status", string(name))])
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// `{ canceled, filePath }` of a save dialog: the path, none when cancelled
fn picked_path(result: &JsonValue) -> Option<String> {
    let JsonValue::Object(object) = result else {
        return None;
    };
    if object.get("canceled").is_some_and(JsonValue::truthy) {
        return None;
    }
    match object.get("filePath") {
        Some(JsonValue::String(path)) if !path.is_empty() => Some(path.clone()),
        _ => None,
    }
}

pub(super) fn json_filters(filters: Vec<(String, Vec<String>)>) -> JsonValue {
    JsonValue::Array(
        filters
            .into_iter()
            .map(|(name, extensions)| {
                let mut filter = JsObject::new();
                filter.set("name", JsonValue::String(name));
                filter.set(
                    "extensions",
                    JsonValue::Array(extensions.into_iter().map(JsonValue::String).collect()),
                );
                JsonValue::Object(filter)
            })
            .collect(),
    )
}

impl DiagramViews {
    /// `rememberDiskState(wcId, path)`
    fn remember_disk_state(&self, view: ViewId, path: &str) {
        if let Some(state) = record_disk_state(path) {
            self.with_state(|s| {
                s.view(view).disk_states.insert(path.to_owned(), state);
            });
        }
    }

    /// `refuseWrites(wcId)`: the view's file did not open; it has no save
    /// target and gets none
    fn refuse_writes(&self, view: ViewId) {
        self.with_state(|state| {
            let entry = state.view(view);
            entry.unopened = Some(Unopened::Failed);
            entry.save_path = None;
            entry.dirty = false;
        });
    }

    fn may_write(&self, view: ViewId) -> bool {
        self.with_state(|state| state.views.get(&view).is_none_or(|v| v.may_write()))
    }

    /// `conflictStopsSave(contents, path, auto)`: the split-copy save guard
    fn conflict_stops_save(&self, view: ViewId, path: &str, auto: bool) -> bool {
        let shell = &self.0.shell;
        if !shell.is_path_open_elsewhere(path) {
            return false;
        }
        let recorded = self.with_state(|state| {
            state
                .views
                .get(&view)
                .and_then(|v| v.disk_states.get(path).cloned())
        });
        let probe = |p: &str| -> Result<bool, ProbeThrew> { Ok(shell.is_path_open_elsewhere(p)) };
        if auto {
            return should_defer_auto_save(Some(&probe), path, recorded.as_ref());
        }
        let dialog = BoxDialog(&*self.0.dialogs);
        let parent = self.window_of(view).map(Parent);
        let lang = self.lang();
        confirm_overwrite_if_conflicted(&SaveConflictOptions {
            probe: Some(&probe),
            dialog: &dialog,
            parent: parent.as_ref(),
            path,
            recorded: recorded.as_ref(),
            lang: lang.as_str(),
        }) == SaveConflictAnswer::Cancel
    }

    /// `handOutTarget(wcId, path, format)`
    fn hand_out_target(&self, view: ViewId, path: &str, format: DiagramFormat) -> IpcValue {
        let token: String = random_uuid().chars().filter(|c| *c != '-').collect();
        self.with_state(|state| {
            state.view(view).targets.insert(
                token.clone(),
                Target {
                    path: path.to_owned(),
                    format,
                },
            );
        });
        obj([
            ("ok", IpcValue::Bool(true)),
            ("token", string(token)),
            ("path", string(path)),
            ("format", string(format.as_str())),
        ])
    }

    /// `configuredDefaultSaveDir(app)`; `Err` is what it threw
    pub(super) fn default_save_dir(&self) -> Result<String, String> {
        let paths = Paths(&*self.0.services.paths);
        let mut save_dir = self
            .0
            .shared
            .save_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        configured_default_save_dir(&paths, &mut save_dir, now_ms()).map_err(|thrown| thrown.0)
    }

    /// `askSavePath(contents, current, defaultName)`: the save dialog, the
    /// file's own format first, then the others; a new diagram proposes
    /// `.drawio`. `Err` is what the TypeScript threw.
    fn ask_save_path(
        &self,
        view: ViewId,
        current: Option<&str>,
        default_name: Option<&str>,
    ) -> Result<Option<(String, DiagramFormat)>, String> {
        let current_format = current.map_or(DiagramFormat::Drawio, format_of_path);
        let imported: Option<Import> =
            self.with_state(|state| state.views.get(&view).and_then(|v| v.import.clone()));
        let restored = if current.is_none() {
            self.view_save_as_default(view).filter(|p| !p.is_empty())
        } else {
            None
        };
        let default_path = if let Some(current) = current {
            current.to_owned()
        } else if let Some(restored) = restored {
            with_format_extension(&restored, format_of_path(&restored))
        } else {
            // an imported file's diagram is offered beside that file; an untitled one in its project or the default folder
            let dir = match &imported {
                Some(import) => dirname(&import.path),
                None => match self.0.shell.new_document_dir(view) {
                    Some(dir) => dir,
                    None => self.default_save_dir()?,
                },
            };
            let mut base =
                safe_file_name_base(imported.as_ref().map(|i| i.title.as_str()).or(default_name));
            if base.is_empty() {
                base = self.tm("untitled");
            }
            join(&[
                &dir,
                &format!("{base}{}", DiagramFormat::Drawio.extension()),
            ])
        };
        let mut order = vec![current_format];
        order.extend(
            SAVE_AS_FORMATS
                .iter()
                .copied()
                .filter(|f| *f != current_format),
        );
        let filters = order
            .iter()
            .map(|format| {
                let key = match format {
                    DiagramFormat::Drawio => "filterDrawio",
                    DiagramFormat::Dio => "filterDio",
                    DiagramFormat::DrawioSvg => "filterDrawioSvg",
                    DiagramFormat::DrawioPng => "filterDrawioPng",
                };
                (self.tm(key), vec![filter_extension(*format).to_owned()])
            })
            .collect();
        let mut options = JsObject::new();
        options.set("title", JsonValue::String(self.tm("dlgSaveTitle")));
        options.set("defaultPath", JsonValue::String(default_path));
        options.set("filters", json_filters(filters));
        let picked = self.save_dialog(view, &options);
        let Some(picked) = picked else {
            return Ok(None);
        };
        let format = format_for_save_path(&picked, current_format);
        Ok(Some((with_format_extension(&picked, format), format)))
    }

    /// `showSaveDialogWithMemory(dialog, parentWindowOf(contents), options)`:
    /// the chosen path, none when cancelled
    pub(super) fn save_dialog(
        &self,
        view: ViewId,
        options: &JsObject<JsonValue>,
    ) -> Option<String> {
        let parent: Option<WindowId> = self.window_of(view);
        let mut memory = self
            .0
            .shared
            .dialog_memory
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let result = show_save_dialog_with_memory(
            &mut memory,
            &mut HostDialog(&*self.0.dialogs),
            parent.as_ref(),
            options,
            None,
        );
        picked_path(&result)
    }

    /// `adoptWrittenPath(contents, target, previousPath)`
    fn adopt_written_path(&self, view: ViewId, target: &str, previous: Option<&str>) {
        self.with_state(|state| {
            let entry = state.view(view);
            entry.save_path = Some(target.to_owned());
            entry.open_path = Some(target.to_owned());
            entry
                .allowed
                .get_or_insert_with(HashSet::new)
                .insert(target.to_owned());
            entry.dirty = false;
            entry.clean_path = Some(target.to_owned());
            // an imported diagram is now a diagram file of its own
            entry.import = None;
        });
        self.view_saved(view);
        self.remember_disk_state(view, target);
        if let Some(previous) = previous.filter(|p| *p != target) {
            self.with_state(|state| {
                if let Some(entry) = state.views.get_mut(&view) {
                    entry.disk_states.remove(previous);
                }
            });
        }
        if previous != Some(target) {
            self.0.shell.file_saved(view, target);
        }
    }

    /// `untitledCopyTitle(contents, offered)`
    fn untitled_copy_title(&self, view: ViewId, offered: &IpcValue) -> String {
        if let Some(title) = self.0.shell.recovery_title(view)
            && !trim(&title).is_empty()
        {
            return trim(&title).to_owned();
        }
        if let Some(title) = self.with_state(|state| {
            state
                .views
                .get(&view)
                .and_then(|v| v.import.as_ref().map(|i| i.title.clone()))
        }) && !title.is_empty()
        {
            return title;
        }
        let name = match offered {
            IpcValue::String(offered) => {
                let squeezed = js_regex!(r"\s+", "g").replace_all(offered, |_| " ".to_owned());
                slice_utf16(trim(&squeezed), 0.0, Some(80.0))
            }
            _ => String::new(),
        };
        if name.is_empty() {
            self.tm("untitled")
        } else {
            name
        }
    }

    // ---- handlers ----

    pub(super) fn consume_pending(&self, cx: &CallContext, _args: Args) -> Reply {
        let path = self.with_state(|state| {
            state
                .views
                .get(&cx.sender.view)
                .and_then(|v| v.open_path.clone())
        });
        Ok(path.map_or(IpcValue::Null, string))
    }

    pub(super) fn open_file(&self, cx: &CallContext, args: Args) -> Reply {
        let view = cx.sender.view;
        let granted = args.str(0).filter(|path| {
            self.with_state(|state| {
                state
                    .views
                    .get(&view)
                    .and_then(|v| v.allowed.as_ref())
                    .is_some_and(|allowed| allowed.contains(*path))
            })
        });
        let Some(path) = granted else {
            return Err(thrown("diagram: path not granted to this view"));
        };
        let Some(kind) = detect_format(path) else {
            self.refuse_writes(view);
            return Ok(status("unsupported"));
        };
        if kind == Detected::Vsdx {
            // another program's file: read for the importer, never written; the diagram is untitled
            let Ok(bytes) = std::fs::read(path) else {
                self.refuse_writes(view);
                return Ok(status("unreadable"));
            };
            let title = diagram_base_name(path);
            self.with_state(|state| {
                let entry = state.view(view);
                entry.unopened = None;
                entry.save_path = None;
                entry.import = Some(Import {
                    path: path.to_owned(),
                    title: title.clone(),
                });
            });
            return Ok(obj([
                ("status", string("import")),
                ("importer", string("vsdx")),
                ("bytes", buffer(bytes)),
                ("title", string(title)),
            ]));
        }
        let name = basename(path, None);
        let restored = self.resolve_view_open(view, path, Some(cx.sender.window));
        let bytes = std::fs::read(path).ok();
        if let Some(restored) = restored
            && let Ok(copy) = self.0.engine.open_diagram(&name, &restored)
        {
            self.with_state(|state| state.view(view).unopened = None);
            let file_still_opens = bytes
                .as_ref()
                .is_some_and(|bytes| self.0.engine.open_diagram(&name, bytes).is_ok());
            if file_still_opens {
                self.with_state(|state| state.view(view).save_path = Some(path.to_owned()));
                self.remember_disk_state(view, path);
            } else {
                self.with_state(|state| state.view(view).save_path = None);
                self.view_restored_untitled(view, path);
            }
            let compressed = is_compressed_file(&copy.root, copy.any_page_compressed, &copy.xml);
            return Ok(obj([
                ("status", string("ok")),
                ("xml", string(copy.xml)),
                ("format", string(copy.format.as_str())),
                ("compressed", IpcValue::Bool(compressed)),
                (
                    "restored",
                    string(if file_still_opens { "file" } else { "untitled" }),
                ),
            ]));
        }
        let Some(bytes) = bytes else {
            self.refuse_writes(view);
            return Ok(status("unreadable"));
        };
        let opened = match self.0.engine.open_diagram(&name, &bytes) {
            Ok(opened) => opened,
            Err(failure) => {
                self.refuse_writes(view);
                return Ok(status(&failure.reason));
            }
        };
        self.with_state(|state| {
            let entry = state.view(view);
            entry.unopened = None;
            entry.save_path = Some(path.to_owned());
            entry.clean_path = Some(path.to_owned());
        });
        self.remember_disk_state(view, path);
        let compressed = is_compressed_file(&opened.root, opened.any_page_compressed, &opened.xml);
        Ok(obj([
            ("status", string("ok")),
            ("xml", string(opened.xml)),
            ("format", string(opened.format.as_str())),
            ("compressed", IpcValue::Bool(compressed)),
        ]))
    }

    pub(super) fn save_target(&self, cx: &CallContext, args: Args) -> Reply {
        let view = cx.sender.view;
        if !self.may_write(view) {
            return Ok(failure("diagram: the file did not open"));
        }
        let request = args.get(0);
        let mode = match field(request, "mode") {
            IpcValue::String(mode) if mode == "saveAs" => "saveAs",
            IpcValue::String(mode) if mode == "retarget" => "retarget",
            _ => "save",
        };
        let current = self.file_path(view);
        if mode != "saveAs"
            && let Some(current) = &current
        {
            return Ok(self.hand_out_target(view, current, format_of_path(current)));
        }
        let default_name = match field(request, "defaultName") {
            IpcValue::String(name) => Some(name.as_str()),
            _ => None,
        };
        match self.ask_save_path(view, current.as_deref(), default_name) {
            Ok(None) => {
                let waiter = self.with_state(|state| state.view(view).save.take());
                if let Some(waiter) = waiter {
                    (waiter.resume)(WaitEnd::Answer(false));
                }
                Ok(obj([
                    ("ok", IpcValue::Bool(true)),
                    ("canceled", IpcValue::Bool(true)),
                ]))
            }
            Ok(Some((path, format))) => Ok(self.hand_out_target(view, &path, format)),
            Err(message) => Ok(failure(message)),
        }
    }

    pub(super) fn save(&self, cx: &CallContext, args: Args) -> Reply {
        let view = cx.sender.view;
        let waiter = self.with_state(|state| state.view(view).save.take());
        let result = self.save_result(cx, &args);
        if let Some(waiter) = waiter {
            let ok = matches!(field(&result, "ok"), IpcValue::Bool(true));
            (waiter.resume)(WaitEnd::Answer(ok));
        }
        Ok(result)
    }

    /// The body of `diagram:save`, without the waiter of the save request
    fn save_result(&self, cx: &CallContext, args: &Args) -> IpcValue {
        let view = cx.sender.view;
        if !self.may_write(view) {
            return failure("diagram: the file did not open, nothing is written");
        }
        let request = args.get(0);
        let token = match field(request, "token") {
            IpcValue::String(token) => Some(token.as_str()),
            _ => None,
        };
        let target =
            token.and_then(|token| self.with_state(|state| state.view(view).targets.remove(token)));
        let Some(target) = target else {
            return failure("diagram: unknown save target");
        };
        let Some(bytes) = as_bytes(field(request, "bytes")) else {
            return failure("diagram: bad save request");
        };
        let (current, clean_path, dirty) = self.with_state(|state| {
            let entry = state.view(view);
            (
                entry.save_path.clone(),
                entry.clean_path.clone(),
                entry.dirty,
            )
        });
        // nothing changed and the file on disk is the diagram: nothing is written (spec 3.2)
        if Some(&target.path) == clean_path.as_ref() && !dirty {
            return obj([("ok", IpcValue::Bool(true)), ("path", string(&target.path))]);
        }
        // The bytes come from a renderer: they replace a file only when they open as a diagram of the target's format.
        if let Err(check) = self
            .0
            .engine
            .open_diagram(&basename(&target.path, None), bytes)
        {
            return failure(format!(
                "diagram: refusing to write a file that would not open ({})",
                check.reason
            ));
        }
        let auto = matches!(field(request, "auto"), IpcValue::Bool(true));
        if let Some(current) = &current
            && *current == target.path
            && self.conflict_stops_save(view, current, auto)
        {
            return failure("external-modified");
        }
        match atomic_write_file(&target.path, bytes) {
            Ok(()) => {
                self.adopt_written_path(view, &target.path, current.as_deref());
                obj([("ok", IpcValue::Bool(true)), ("path", string(&target.path))])
            }
            Err(err) => failure(err.message),
        }
    }

    pub(super) fn save_into_project(&self, cx: &CallContext, args: Args) -> Reply {
        let view = cx.sender.view;
        let skipped = || {
            obj([
                ("ok", IpcValue::Bool(false)),
                ("skipped", IpcValue::Bool(true)),
            ])
        };
        if !self.0.shell.has_new_document_writer()
            || !self.may_write(view)
            || self.file_path(view).is_some()
        {
            return Ok(skipped());
        }
        let request = args.get(0);
        let Some(bytes) = as_bytes(field(request, "bytes")) else {
            return Ok(failure("diagram: bad save request"));
        };
        let default_name = match field(request, "defaultName") {
            IpcValue::String(name) => Some(name.as_str()),
            _ => None,
        };
        let mut base = safe_file_name_base(default_name);
        if base.is_empty() {
            base = self.tm("untitled");
        }
        let file_name = format!("{base}{}", DiagramFormat::Drawio.extension());
        if self.0.engine.open_diagram(&file_name, bytes).is_err() {
            return Ok(failure(
                "diagram: refusing to write a diagram that would not open",
            ));
        }
        match self.0.shell.write_new_document(view, &file_name, bytes) {
            Some(Ok(Some(written))) if self.file_path(view).is_none() => {
                self.adopt_written_path(view, &written, None);
                Ok(obj([
                    ("ok", IpcValue::Bool(true)),
                    ("path", string(written)),
                ]))
            }
            Some(Err(message)) => Ok(failure(message)),
            _ => Ok(skipped()),
        }
    }

    pub(super) fn open_link(&self, _cx: &CallContext, args: Args) -> Reply {
        let Some(target) = openable_link(args.str(0)) else {
            return Ok(IpcValue::Bool(false));
        };
        Ok(IpcValue::Bool(
            self.0.os_shell.open_external(&target).is_ok(),
        ))
    }

    pub(super) fn open_help(&self, cx: &CallContext, _args: Args) -> Result<(), IpcError> {
        self.0.shell.help(cx.sender.view);
        Ok(())
    }

    pub(super) fn open_failed(&self, cx: &CallContext, args: Args) -> Reply {
        let view = cx.sender.view;
        let Some(message) = args.str(0).filter(|m| !trim(m).is_empty()) else {
            return Ok(IpcValue::Bool(false));
        };
        // only a view whose file did not open, or whose import has not become a file yet
        let may = self.with_state(|state| {
            state
                .views
                .get(&view)
                .is_some_and(|v| v.unopened == Some(Unopened::Failed) || v.import.is_some())
        });
        if !may {
            return Ok(IpcValue::Bool(false));
        }
        self.refuse_writes(view);
        let message = slice_utf16(trim(message), 0.0, Some(2000.0));
        Ok(IpcValue::Bool(self.0.shell.open_failed(view, &message)))
    }

    pub(super) fn dirty_changed(&self, cx: &CallContext, args: Args) -> Result<(), IpcError> {
        let view = cx.sender.view;
        let dirty = args.bool(0) == Some(true) && self.may_write(view);
        self.with_state(|state| {
            if dirty {
                state.view(view).dirty = true;
            } else if let Some(entry) = state.views.get_mut(&view) {
                entry.dirty = false;
            }
        });
        Ok(())
    }

    pub(super) fn close_save_result(&self, cx: &CallContext, args: Args) -> Result<(), IpcError> {
        let waiter = self.with_state(|state| {
            state
                .views
                .get_mut(&cx.sender.view)
                .and_then(|v| v.close_save.take())
        });
        if let Some(waiter) = waiter {
            (waiter.resume)(WaitEnd::Answer(args.bool(0) == Some(true)));
        }
        Ok(())
    }

    pub(super) fn save_request_ack(&self, cx: &CallContext, args: Args) -> Result<(), IpcError> {
        let waiter = self.with_state(|state| {
            state
                .views
                .get_mut(&cx.sender.view)
                .and_then(|v| v.save.take())
        });
        if let Some(waiter) = waiter {
            (waiter.resume)(WaitEnd::Answer(args.bool(0) == Some(true)));
        }
        Ok(())
    }

    pub(super) fn recovery_copy(&self, cx: &CallContext, args: Args) -> Reply {
        let view = cx.sender.view;
        let dirty = self.with_state(|state| state.views.get(&view).is_some_and(|v| v.dirty));
        if !self.may_write(view) || !dirty {
            return Ok(string("skipped"));
        }
        let request = args.get(0);
        let Some(bytes) = as_bytes(field(request, "bytes")) else {
            return Ok(string("skipped"));
        };
        let name = field(request, "name");
        let save_path = self.file_path(view);
        match self.write_view_copy(view, save_path.as_deref(), bytes, || {
            self.untitled_copy_title(view, name)
        }) {
            Ok(RecoveryWriteResult::Written) => Ok(string("written")),
            Ok(RecoveryWriteResult::Superseded) => Ok(string("superseded")),
            Err(err) => Err(thrown(err.message)),
        }
    }

    pub(super) fn recovery_copy_now_done(
        &self,
        cx: &CallContext,
        _args: Args,
    ) -> Result<(), IpcError> {
        let waiter = self.with_state(|state| {
            state
                .views
                .get_mut(&cx.sender.view)
                .and_then(|v| v.copy_now.take())
        });
        if let Some(waiter) = waiter {
            (waiter.finish)();
        }
        Ok(())
    }

    pub(super) fn seed_take(&self, cx: &CallContext, _args: Args) -> Reply {
        let seed = self.with_state(|state| {
            let entry = state.views.get_mut(&cx.sender.view)?;
            if entry.open_path.is_some() {
                return None;
            }
            entry.seed.take()
        });
        Ok(seed.map_or(IpcValue::Null, DiagramViews::seed_object))
    }
}
