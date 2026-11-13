//! `apps/shell/src/main/user-skills/user-skills-ipc.ts`: the skills channels of
//! the shell's main process. Any window may list skills, read them for the AI
//! (checked again here), save a skill card and ask for the settings page;
//! changing, importing, exporting and removing skills is for the settings
//! screen only. Previewed imports and found updates wait under a token until
//! installed or dropped; a window that goes away drops its own. A skill file
//! dropped on any window waits in a queue (only the path) until the settings
//! screen takes it and previews it as its own; a drop that held no skill waits
//! there too, as the notice it becomes.
//!
//! `ipcMain.handle` stays in the TypeScript. Each method here is the body of
//! one handler: `sender_id` is the id of the webContents that asked, the other
//! arguments are what the renderer sent (`None` is `undefined`), and the
//! answer is the value the handler returns. `once('destroyed')` of a sender
//! is [`UserSkillsIpc::sender_destroyed`], which the adapter calls after
//! [`UserSkillsIpcHost::watch_destroyed`] asked for it. The GitHub import and
//! the update check keep a window's abort controller across an `await`, so
//! each is two calls, `begin` and `finish`, with the library call between them.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use jscompat::{JsMap, JsObject, JsonValue, slice_utf16};

use super::user_skills_service::{
    Failure, SkillLibrary, Svc, UserSkillCardSaveInput, UserSkillSaveInput, UserSkillStatePatch,
    UserSkillsFail, UserSkillsHost, UserSkillsService, import_preview_of,
};
use crate::packages::ai_provider::user_skills_folder::skill_bundle_file_name;
use crate::packages::ai_provider::user_skills_import::{
    ChangedCheck, GitHubSkillUpdateCheck, SkillImport, SkillImportSource,
};
use crate::packages::electron_utils::dialog_memory::Dialog;
use crate::packages::electron_utils::user_skills_channels::{
    card_save_input_of, import_text_of, install_request_of, save_input_of, skill_id_list_of,
    skill_id_of, state_patch_of,
};

/// Most dropped skill files waiting at once; older ones go first
pub const DROPPED_SKILLS_MAX: usize = 20;

/// Longest bundle name a window may suggest; the core cuts it to a file name
const BUNDLE_NAME_MAX_CHARS: usize = 300;

/// What a drop leaves for the settings screen: a file that holds skills, or
/// word that the dropped zip or `SKILL.md` held none (the screen says so)
#[derive(Debug, Clone, PartialEq)]
pub enum DroppedSkillEntry {
    Zip { file: String },
    SkillFile { file: String },
    NoSkills,
}

/// The window and OS parts of `UserSkillsIpcDeps` and of the Electron objects
/// the handlers use
pub trait UserSkillsIpcHost {
    type Dialog: Dialog;
    fn dialog(&mut self) -> &mut Self::Dialog;
    /// `BrowserWindow.fromWebContents(event.sender)`
    fn parent_of(&mut self, sender_id: f64) -> Option<<Self::Dialog as Dialog>::Window>;
    /// whether a window may make this management call: the settings screen
    /// any of them, the agent window only its install preview (spec 6.4)
    fn can_manage(&mut self, sender_id: f64, channel: &str) -> bool;
    /// bring the main window forward with the settings open on the skills page
    fn open_settings(&mut self);
    /// the agent window's one-time notice is due (spec 6.5); `Err` is a throw
    fn agent_notice_due(&mut self) -> Result<bool, String>;
    fn mark_agent_notice_seen(&mut self) -> Result<(), String>;
    /// tell every live webContents `C.changed`
    fn broadcast_changed(&mut self);
    /// tell every live webContents `C.dropped`
    fn broadcast_dropped(&mut self);
    /// `randomUUID()`
    fn random_uuid(&mut self) -> String;
    /// `sender.isDestroyed()`
    fn is_destroyed(&mut self, sender_id: f64) -> bool;
    /// ask for `sender.once('destroyed', ...)` to call [`UserSkillsIpc::sender_destroyed`]
    fn watch_destroyed(&mut self, sender_id: f64);
    /// `shell.openPath(path)`: an error text, empty when it worked
    fn open_path(&mut self, path: &str) -> String;
}

struct Pending<T> {
    value: T,
    owner: f64,
}

/// the GitHub import or update check running for a window: its abort signal
#[derive(Debug, Clone)]
pub struct Run {
    pub owner: f64,
    /// `signal.aborted`
    pub signal: Arc<AtomicBool>,
}

impl Run {
    pub fn aborted(&self) -> bool {
        self.signal.load(Ordering::SeqCst)
    }
}

struct UpdateEntry {
    id: String,
    check: ChangedCheck,
}

fn text(value: &str) -> JsonValue {
    JsonValue::String(value.to_owned())
}

fn fail_json(reason: &str) -> JsonValue {
    UserSkillsFail {
        reason: reason.to_owned(),
        problem: None,
    }
    .to_json()
}

fn not_allowed() -> JsonValue {
    fail_json("not-allowed")
}

fn invalid() -> JsonValue {
    fail_json("invalid")
}

fn ok_with(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut object = JsObject::new();
    object.set("ok", JsonValue::Bool(true));
    for (key, value) in entries {
        object.set(key, value);
    }
    JsonValue::Object(object)
}

/// the result a `manage` handler ends with: a thrown error is `failureOf`
fn settled<T>(result: Svc<T>, ok: impl FnOnce(T) -> JsonValue) -> JsonValue {
    match result {
        Ok(value) => ok(value),
        Err(failure) => failure.as_fail().to_json(),
    }
}

/// `typeof value === 'string'` of a value that also has a length limit
fn string_within(value: Option<&JsonValue>, max: usize) -> Option<&str> {
    match value {
        Some(JsonValue::String(text)) if text.encode_utf16().count() <= max => Some(text),
        _ => None,
    }
}

fn dialog_canceled(picked: &JsonValue) -> bool {
    match picked {
        JsonValue::Object(object) => object.get("canceled").is_some_and(JsonValue::truthy),
        _ => false,
    }
}

fn first_path(picked: &JsonValue) -> Option<String> {
    let JsonValue::Object(object) = picked else {
        return None;
    };
    match object.get("filePaths") {
        Some(JsonValue::Array(paths)) => match paths.first() {
            Some(JsonValue::String(path)) if !path.is_empty() => Some(path.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn file_path(picked: &JsonValue) -> Option<String> {
    let JsonValue::Object(object) = picked else {
        return None;
    };
    match object.get("filePath") {
        Some(JsonValue::String(path)) if !path.is_empty() => Some(path.clone()),
        _ => None,
    }
}

fn zip_filter() -> JsonValue {
    let mut filter = JsObject::new();
    filter.set("name", text("Zip"));
    filter.set("extensions", JsonValue::Array(vec![text("zip")]));
    JsonValue::Array(vec![JsonValue::Object(filter)])
}

/// `registerUserSkillsIpc(deps)`
pub struct UserSkillsIpc<H: UserSkillsHost, L: SkillLibrary> {
    pub service: UserSkillsService<H, L>,
    imports: JsMap<Pending<SkillImport>>,
    updates: JsMap<Pending<UpdateEntry>>,
    /// the GitHub import or update check running for a window
    running: Vec<(f64, Arc<AtomicBool>)>,
    watched: Vec<f64>,
    dropped: Vec<DroppedSkillEntry>,
}

impl<H: UserSkillsHost, L: SkillLibrary> UserSkillsIpc<H, L> {
    pub fn new(service: UserSkillsService<H, L>) -> Self {
        UserSkillsIpc {
            service,
            imports: JsMap::new(),
            updates: JsMap::new(),
            running: Vec::new(),
            watched: Vec::new(),
            dropped: Vec::new(),
        }
    }

    /// `broadcastChanged()`
    pub fn broadcast_changed<X: UserSkillsIpcHost>(&mut self, host: &mut X) {
        host.broadcast_changed();
    }

    /// `queueDropped(entry)`: keep what a drop left for the settings screen
    /// and tell the windows; the caller opens the settings on the skills page
    pub fn queue_dropped<X: UserSkillsIpcHost>(&mut self, host: &mut X, entry: DroppedSkillEntry) {
        self.dropped.push(entry);
        if self.dropped.len() > DROPPED_SKILLS_MAX {
            let extra = self.dropped.len() - DROPPED_SKILLS_MAX;
            self.dropped.drain(0..extra);
        }
        host.broadcast_dropped();
    }

    /// the entries waiting for the settings screen, for diagnostics
    pub fn dropped(&self) -> &[DroppedSkillEntry] {
        &self.dropped
    }

    fn running_of(&self, owner: f64) -> Option<&Arc<AtomicBool>> {
        self.running
            .iter()
            .find(|(id, _)| *id == owner)
            .map(|(_, signal)| signal)
    }

    fn stop_running(&mut self, owner: f64) {
        self.running.retain(|(id, _)| *id != owner);
    }

    /// `watch(sender)`: the first time a window is seen, ask to hear when it goes away
    fn watch<X: UserSkillsIpcHost>(&mut self, host: &mut X, sender_id: f64) {
        if self.watched.contains(&sender_id) {
            return;
        }
        self.watched.push(sender_id);
        host.watch_destroyed(sender_id);
    }

    /// the `once('destroyed')` listener of `watch`: drop everything a window left waiting
    pub fn sender_destroyed(&mut self, owner: f64) {
        self.watched.retain(|id| *id != owner);
        if let Some(signal) = self.running_of(owner) {
            signal.store(true, Ordering::SeqCst);
        }
        self.stop_running(owner);
        let tokens: Vec<String> = self
            .imports
            .iter()
            .filter(|(_, entry)| entry.owner == owner)
            .map(|(token, _)| token.to_owned())
            .collect();
        for token in tokens {
            if let Some(entry) = self.imports.delete(&token) {
                self.service.dispose(&entry.value);
            }
        }
        let tokens: Vec<String> = self
            .updates
            .iter()
            .filter(|(_, entry)| entry.owner == owner)
            .map(|(token, _)| token.to_owned())
            .collect();
        for token in tokens {
            if let Some(entry) = self.updates.delete(&token) {
                self.service.dispose(&entry.value.check.update);
            }
        }
    }

    /// `changing(work)`: tell every window when a change worked
    fn changing<X: UserSkillsIpcHost, T>(
        host: &mut X,
        result: Svc<T>,
        ok: impl FnOnce(T) -> JsonValue,
    ) -> JsonValue {
        let worked = result.is_ok();
        let answer = settled(result, ok);
        if worked {
            host.broadcast_changed();
        }
        answer
    }

    /// `keepImport(event, imported)`
    fn keep_import<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        imported: SkillImport,
    ) -> JsonValue {
        self.watch(host, sender_id);
        let token = host.random_uuid();
        let preview = import_preview_of(&imported, &token);
        self.imports.set(
            token,
            Pending {
                value: imported,
                owner: sender_id,
            },
        );
        ok_with(vec![("preview", preview)])
    }

    /// `ownImport(event, token)`: the previewed import a window asks about by its token: its own only
    fn own_import(&self, sender_id: f64, token: Option<&JsonValue>) -> Option<SkillImport> {
        let Some(JsonValue::String(token)) = token else {
            return None;
        };
        self.imports
            .get(token)
            .filter(|entry| entry.owner == sender_id)
            .map(|entry| entry.value.clone())
    }

    /// the gate of `manage(channel, run)`: the settings screen only
    fn managed<X: UserSkillsIpcHost>(
        host: &mut X,
        sender_id: f64,
        channel: &str,
    ) -> Option<JsonValue> {
        if host.can_manage(sender_id, channel) {
            None
        } else {
            Some(not_allowed())
        }
    }

    // ---- any window ----

    /// `C.list`
    pub fn list(&mut self) -> JsonValue {
        match self.service.list() {
            Ok(views) => JsonValue::Array(views),
            Err(_) => JsonValue::Array(Vec::new()),
        }
    }

    /// `C.read`
    pub fn read(&mut self, id: Option<&JsonValue>) -> JsonValue {
        let Some(skill_id) = skill_id_of(id) else {
            return invalid();
        };
        settled(self.service.read(&skill_id), |skill| {
            ok_with(vec![("skill", skill)])
        })
    }

    /// `C.suggestName`
    pub fn suggest_name(&mut self, title: Option<&JsonValue>) -> JsonValue {
        let title = match title {
            Some(JsonValue::String(title)) => slice_utf16(title, 0.0, Some(10_000.0)),
            _ => String::new(),
        };
        match self.service.suggest_name(&title) {
            Ok(name) => JsonValue::String(name),
            Err(_) => JsonValue::String(String::new()),
        }
    }

    /// `C.checkName`
    pub fn check_name(
        &mut self,
        name: Option<&JsonValue>,
        for_id: Option<&JsonValue>,
    ) -> JsonValue {
        let problem = |problem: &str| {
            let mut object = JsObject::new();
            object.set("ok", JsonValue::Bool(false));
            object.set("problem", text(problem));
            JsonValue::Object(object)
        };
        let Some(JsonValue::String(name)) = name else {
            return problem("empty");
        };
        match self
            .service
            .check_name(name, skill_id_of(for_id).as_deref())
        {
            Ok(None) => ok_with(Vec::new()),
            Ok(Some(found)) => problem(&found),
            Err(_) => problem("empty"),
        }
    }

    /// `C.saveFromCard`; `template_bytes` are the bytes the renderer's
    /// `template.bytes` stands for
    pub fn save_from_card<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        raw: Option<&JsonValue>,
        template_bytes: Option<Vec<u8>>,
    ) -> JsonValue {
        let Some(input) = card_save_input_of(raw)
            .and_then(|input| UserSkillCardSaveInput::from_json(&input, template_bytes))
        else {
            return invalid();
        };
        let result = self.service.save_from_card(&input);
        Self::changing(host, result, |id| {
            ok_with(vec![("id", JsonValue::String(id))])
        })
    }

    /// `C.aiRead`
    pub fn ai_read(&mut self, id: Option<&JsonValue>) -> JsonValue {
        let Some(skill_id) = skill_id_of(id) else {
            return invalid();
        };
        settled(self.service.ai_read(&skill_id), |skill| {
            ok_with(vec![("skill", skill)])
        })
    }

    /// `C.aiReadFile`
    pub fn ai_read_file(&mut self, id: Option<&JsonValue>, rel: Option<&JsonValue>) -> JsonValue {
        let skill_id = skill_id_of(id);
        let (Some(skill_id), Some(rel)) = (skill_id, string_within(rel, 4096)) else {
            return invalid();
        };
        settled(self.service.ai_read_file(&skill_id, rel), |body| {
            ok_with(vec![("text", JsonValue::String(body))])
        })
    }

    /// `C.openSettings`
    pub fn open_settings<X: UserSkillsIpcHost>(&mut self, host: &mut X) {
        host.open_settings();
    }

    /// `C.agentNotice`
    pub fn agent_notice<X: UserSkillsIpcHost>(&mut self, host: &mut X) -> bool {
        host.agent_notice_due().unwrap_or(false)
    }

    /// `C.agentNoticeSeen`: an unwritable settings file shows the notice once more next time
    pub fn agent_notice_seen<X: UserSkillsIpcHost>(&mut self, host: &mut X) {
        let _ = host.mark_agent_notice_seen();
    }

    // ---- the settings screen ----

    /// `C.setState`
    pub fn set_state<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        id: Option<&JsonValue>,
        patch: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:set-state") {
            return refused;
        }
        let skill_id = skill_id_of(id);
        let change = state_patch_of(patch);
        let (Some(skill_id), Some(change)) = (skill_id, change) else {
            return invalid();
        };
        let result = self
            .service
            .set_state(&skill_id, &UserSkillStatePatch::from_json(&change));
        Self::changing(host, result, |()| ok_with(Vec::new()))
    }

    /// `C.hideBuiltin`
    pub fn hide_builtin<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        id: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:hide-builtin") {
            return refused;
        }
        let Some(skill_id) = skill_id_of(id) else {
            return invalid();
        };
        let result = self.service.hide_builtin(&skill_id);
        Self::changing(host, result, |()| ok_with(Vec::new()))
    }

    /// `C.unhideBuiltins`
    pub fn unhide_builtins<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        names: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:unhide-builtins") {
            return refused;
        }
        let list: Option<Vec<String>> = match names {
            None => None,
            Some(JsonValue::Array(items)) => Some(
                items
                    .iter()
                    .filter_map(|item| match item {
                        JsonValue::String(name) => Some(name.clone()),
                        _ => None,
                    })
                    .collect(),
            ),
            Some(_) => return invalid(),
        };
        let result = self.service.unhide_builtins(list.as_deref());
        Self::changing(host, result, |()| ok_with(Vec::new()))
    }

    /// `C.remove`
    pub fn remove<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        id: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:remove") {
            return refused;
        }
        let Some(skill_id) = skill_id_of(id) else {
            return invalid();
        };
        let result = self.service.remove(&skill_id);
        Self::changing(host, result, |()| ok_with(Vec::new()))
    }

    /// `C.copyToMine`
    pub fn copy_to_mine<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        id: Option<&JsonValue>,
        overwrite: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:copy-to-mine") {
            return refused;
        }
        let Some(skill_id) = skill_id_of(id) else {
            return invalid();
        };
        let result = self
            .service
            .copy_to_mine(&skill_id, overwrite == Some(&JsonValue::Bool(true)));
        Self::changing(host, result, |id| {
            ok_with(vec![("id", JsonValue::String(id))])
        })
    }

    /// `C.save`
    pub fn save<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:save") {
            return refused;
        }
        let Some(input) =
            save_input_of(raw).and_then(|input| UserSkillSaveInput::from_json(&input))
        else {
            return invalid();
        };
        let result = self.service.save(&input);
        Self::changing(host, result, |id| {
            ok_with(vec![("id", JsonValue::String(id))])
        })
    }

    /// the dialog of `C.importFolder` and `C.importZip`: the picked path, or
    /// the `cancelled` answer
    fn pick_to_import<X: UserSkillsIpcHost>(
        host: &mut X,
        sender_id: f64,
        options: &JsObject<JsonValue>,
    ) -> Result<String, JsonValue> {
        let parent = host.parent_of(sender_id);
        let picked = host.dialog().show_open_dialog(parent.as_ref(), options);
        match first_path(&picked) {
            Some(path) if !dialog_canceled(&picked) => Ok(path),
            _ => Err(fail_json("cancelled")),
        }
    }

    /// `C.importFolder`
    pub fn import_folder<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:import-folder") {
            return refused;
        }
        let mut options = JsObject::new();
        options.set("properties", JsonValue::Array(vec![text("openDirectory")]));
        let folder = match Self::pick_to_import(host, sender_id, &options) {
            Ok(folder) => folder,
            Err(cancelled) => return cancelled,
        };
        match self
            .service
            .prepare(&SkillImportSource::Folder { folder }, None)
        {
            Ok(imported) => self.keep_import(host, sender_id, imported),
            Err(failure) => failure.as_fail().to_json(),
        }
    }

    /// `C.importZip`
    pub fn import_zip<X: UserSkillsIpcHost>(&mut self, host: &mut X, sender_id: f64) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:import-zip") {
            return refused;
        }
        let mut options = JsObject::new();
        options.set("properties", JsonValue::Array(vec![text("openFile")]));
        options.set("filters", zip_filter());
        let file = match Self::pick_to_import(host, sender_id, &options) {
            Ok(file) => file,
            Err(cancelled) => return cancelled,
        };
        match self.service.prepare(&SkillImportSource::Zip { file }, None) {
            Ok(imported) => self.keep_import(host, sender_id, imported),
            Err(failure) => failure.as_fail().to_json(),
        }
    }

    /// `C.importText`
    pub fn import_text<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:import-text") {
            return refused;
        }
        let Some(body) = import_text_of(raw) else {
            return invalid();
        };
        match self
            .service
            .prepare(&SkillImportSource::Text { text: body }, None)
        {
            Ok(imported) => self.keep_import(host, sender_id, imported),
            Err(failure) => failure.as_fail().to_json(),
        }
    }

    /// `C.takeDropped`
    pub fn take_dropped<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:take-dropped") {
            return refused;
        }
        if self.dropped.is_empty() {
            return ok_with(vec![("preview", JsonValue::Null)]);
        }
        let next = self.dropped.remove(0);
        let source = match next {
            DroppedSkillEntry::NoSkills => return fail_json("no-skills"),
            DroppedSkillEntry::Zip { file } => SkillImportSource::Zip { file },
            DroppedSkillEntry::SkillFile { file } => SkillImportSource::SkillFile { file },
        };
        match self.service.prepare(&source, None) {
            Ok(imported) => self.keep_import(host, sender_id, imported),
            Err(failure) => failure.as_fail().to_json(),
        }
    }

    /// `C.importGitHub`, first half: the checks and the abort controller. `Err`
    /// is the answer; `Ok` is the run to hand to [`Self::import_github_finish`]
    /// once `service.prepare(github, signal)` has answered.
    pub fn import_github_begin<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        address: Option<&JsonValue>,
    ) -> Result<(Run, SkillImportSource), JsonValue> {
        if let Some(refused) = Self::managed(host, sender_id, "skills:import-github") {
            return Err(refused);
        }
        let Some(address) = string_within(address, 2048) else {
            return Err(invalid());
        };
        if self.running_of(sender_id).is_some() {
            return Err(fail_json("busy"));
        }
        self.watch(host, sender_id);
        let signal = Arc::new(AtomicBool::new(false));
        self.running.push((sender_id, signal.clone()));
        Ok((
            Run {
                owner: sender_id,
                signal,
            },
            SkillImportSource::Github {
                address: address.to_owned(),
            },
        ))
    }

    /// `C.importGitHub`, second half: what the handler does with the prepared import
    pub fn import_github_finish<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        run: &Run,
        prepared: Svc<SkillImport>,
    ) -> JsonValue {
        let answer = match prepared {
            Err(failure) => failure.as_fail().to_json(),
            Ok(imported) => {
                if run.aborted() || host.is_destroyed(run.owner) {
                    self.service.dispose(&imported);
                    fail_json("cancelled")
                } else {
                    self.keep_import(host, run.owner, imported)
                }
            }
        };
        self.finish_run(run);
        answer
    }

    /// `if (running.get(owner) === controller) running.delete(owner)`
    fn finish_run(&mut self, run: &Run) {
        if self
            .running_of(run.owner)
            .is_some_and(|signal| Arc::ptr_eq(signal, &run.signal))
        {
            self.stop_running(run.owner);
        }
    }

    /// `C.readImport`
    pub fn read_import<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        token: Option<&JsonValue>,
        key: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:read-import") {
            return refused;
        }
        let Some(key) = string_within(key, 4096) else {
            return invalid();
        };
        let Some(imported) = self.own_import(sender_id, token) else {
            return fail_json("not-found");
        };
        settled(self.service.read_imported(&imported, key), |content| {
            ok_with(vec![("content", content)])
        })
    }

    /// `C.readImportFile`
    pub fn read_import_file<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        token: Option<&JsonValue>,
        key: Option<&JsonValue>,
        rel: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:read-import-file") {
            return refused;
        }
        let Some(key) = string_within(key, 4096) else {
            return invalid();
        };
        let Some(rel) = string_within(rel, 4096) else {
            return invalid();
        };
        let Some(imported) = self.own_import(sender_id, token) else {
            return fail_json("not-found");
        };
        settled(
            self.service.read_imported_file(&imported, key, rel),
            |file| ok_with(vec![("file", file)]),
        )
    }

    /// `C.cancelImport`
    pub fn cancel_import<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        token: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:cancel-import") {
            return refused;
        }
        match token {
            None | Some(JsonValue::Null) => {
                if let Some(signal) = self.running_of(sender_id) {
                    signal.store(true, Ordering::SeqCst);
                }
                return ok_with(Vec::new());
            }
            Some(JsonValue::String(_)) => {}
            Some(_) => return invalid(),
        }
        let Some(JsonValue::String(token)) = token else {
            return invalid();
        };
        if self
            .imports
            .get(token)
            .is_some_and(|entry| entry.owner == sender_id)
            && let Some(entry) = self.imports.delete(token)
        {
            self.service.dispose(&entry.value);
        }
        ok_with(Vec::new())
    }

    /// `C.install`
    pub fn install<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:install") {
            return refused;
        }
        let Some(JsonValue::Object(request)) = install_request_of(raw) else {
            return invalid();
        };
        let token = match request.get("token") {
            Some(JsonValue::String(token)) => token.clone(),
            _ => return invalid(),
        };
        let selected: Vec<String> = match request.get("selected") {
            Some(JsonValue::Array(items)) => items
                .iter()
                .filter_map(|item| match item {
                    JsonValue::String(key) => Some(key.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let mut on_collision: Vec<(String, String)> = Vec::new();
        if let Some(JsonValue::Object(choices)) = request.get("onCollision") {
            for (key, choice) in choices.entries() {
                if let JsonValue::String(choice) = choice {
                    on_collision.push((key.to_owned(), choice.clone()));
                }
            }
        }
        let entry = self
            .imports
            .get(&token)
            .filter(|entry| entry.owner == sender_id)
            .map(|entry| entry.value.clone());
        let Some(imported) = entry else {
            return fail_json("not-found");
        };
        let done = self.service.install(&imported, &selected, &on_collision);
        // a name choice still missing keeps the preview open for the person to answer
        let needs_choice =
            matches!(&done, Err(failure) if failure.as_fail().reason == "needs-choice");
        if done.is_ok() || !needs_choice {
            self.imports.delete(&token);
            self.service.dispose(&imported);
        }
        let answer = settled(done, |done| {
            let installed = done
                .installed
                .iter()
                .map(|(key, id)| {
                    let mut entry = JsObject::new();
                    entry.set("key", text(key));
                    entry.set("id", text(id));
                    JsonValue::Object(entry)
                })
                .collect();
            let skipped = done.skipped.iter().map(|key| text(key)).collect();
            ok_with(vec![
                ("installed", JsonValue::Array(installed)),
                ("skipped", JsonValue::Array(skipped)),
            ])
        });
        if matches!(&answer, JsonValue::Object(object) if object.get("ok") == Some(&JsonValue::Bool(true)))
        {
            host.broadcast_changed();
        }
        answer
    }

    /// `C.checkUpdate`, first half: the checks and the abort controller. `Err`
    /// is the answer; `Ok` carries the run and the skill id for
    /// `service.check_update(id, signal)`, then [`Self::check_update_finish`].
    pub fn check_update_begin<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        id: Option<&JsonValue>,
    ) -> Result<(Run, String), JsonValue> {
        if let Some(refused) = Self::managed(host, sender_id, "skills:check-update") {
            return Err(refused);
        }
        let Some(skill_id) = skill_id_of(id) else {
            return Err(invalid());
        };
        if self.running_of(sender_id).is_some() {
            return Err(fail_json("busy"));
        }
        self.watch(host, sender_id);
        let signal = Arc::new(AtomicBool::new(false));
        self.running.push((sender_id, signal.clone()));
        Ok((
            Run {
                owner: sender_id,
                signal,
            },
            skill_id,
        ))
    }

    /// `C.checkUpdate`, second half: what the handler does with the check
    pub fn check_update_finish<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        run: &Run,
        skill_id: &str,
        answer: Svc<GitHubSkillUpdateCheck>,
    ) -> JsonValue {
        let result = match answer {
            Err(failure) => failure.as_fail().to_json(),
            Ok(GitHubSkillUpdateCheck::UpToDate { locally_edited, .. }) => ok_with(vec![
                ("status", text("up-to-date")),
                ("locallyEdited", JsonValue::Bool(locally_edited)),
            ]),
            Ok(GitHubSkillUpdateCheck::Changed(check)) => {
                if run.aborted() || host.is_destroyed(run.owner) {
                    self.service.dispose(&check.update);
                    fail_json("cancelled")
                } else {
                    let token = host.random_uuid();
                    let preview = import_preview_of(&check.update, &token);
                    let candidate = match &preview {
                        JsonValue::Object(preview) => match preview.get("candidates") {
                            Some(JsonValue::Array(candidates)) => candidates.first().cloned(),
                            _ => None,
                        },
                        _ => None,
                    };
                    let changed_files = check
                        .changed_files
                        .iter()
                        .map(|change| {
                            let mut entry = JsObject::new();
                            entry.set("rel", text(&change.rel));
                            entry.set("change", text(change.change));
                            JsonValue::Object(entry)
                        })
                        .collect();
                    let locally_edited = check.locally_edited;
                    self.updates.set(
                        token.clone(),
                        Pending {
                            value: UpdateEntry {
                                id: skill_id.to_owned(),
                                check: *check,
                            },
                            owner: run.owner,
                        },
                    );
                    let mut entries = vec![
                        ("status", text("changed")),
                        ("token", JsonValue::String(token)),
                        ("locallyEdited", JsonValue::Bool(locally_edited)),
                        ("changedFiles", JsonValue::Array(changed_files)),
                    ];
                    if let Some(candidate) = candidate {
                        entries.push(("candidate", candidate));
                    }
                    ok_with(entries)
                }
            }
        };
        self.finish_run(run);
        result
    }

    /// `C.applyUpdate`
    pub fn apply_update<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        token: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:apply-update") {
            return refused;
        }
        let Some(JsonValue::String(token)) = token else {
            return invalid();
        };
        if !self
            .updates
            .get(token)
            .is_some_and(|entry| entry.owner == sender_id)
        {
            return fail_json("not-found");
        }
        let entry = self
            .updates
            .delete(token)
            .expect("the update was just found");
        let result = self
            .service
            .apply_update(&entry.value.id, &entry.value.check);
        Self::changing(host, result, |id| {
            ok_with(vec![("id", JsonValue::String(id))])
        })
    }

    /// `C.cancelUpdate`
    pub fn cancel_update<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        token: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:cancel-update") {
            return refused;
        }
        let Some(JsonValue::String(token)) = token else {
            return invalid();
        };
        if self
            .updates
            .get(token)
            .is_some_and(|entry| entry.owner == sender_id)
            && let Some(entry) = self.updates.delete(token)
        {
            self.service.dispose(&entry.value.check.update);
        }
        ok_with(Vec::new())
    }

    /// the answer of `C.exportInfo`
    fn export_info_json(
        info: &crate::packages::ai_provider::user_skills_folder::SkillExportInfo,
    ) -> JsonValue {
        ok_with(vec![
            ("fileName", text(&info.file_name)),
            ("includesTemplate", JsonValue::Bool(info.includes_template)),
        ])
    }

    /// `C.exportInfo`
    pub fn export_info<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        id: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:export-info") {
            return refused;
        }
        let Some(skill_id) = skill_id_of(id) else {
            return invalid();
        };
        settled(self.service.export_info(&skill_id), |info| {
            Self::export_info_json(&info)
        })
    }

    /// the save dialog of the two exports: the path picked, or the `cancelled` answer
    fn pick_to_save<X: UserSkillsIpcHost>(
        host: &mut X,
        sender_id: f64,
        default_path: &str,
    ) -> Result<String, JsonValue> {
        let mut options = JsObject::new();
        options.set("defaultPath", text(default_path));
        options.set("filters", zip_filter());
        let parent = host.parent_of(sender_id);
        let picked = host.dialog().show_save_dialog(parent.as_ref(), &options);
        match file_path(&picked) {
            Some(path) if !dialog_canceled(&picked) => Ok(path),
            _ => Err(fail_json("cancelled")),
        }
    }

    /// `C.exportZip`
    pub fn export_zip<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        id: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:export-zip") {
            return refused;
        }
        let Some(skill_id) = skill_id_of(id) else {
            return invalid();
        };
        let info = match self.service.export_info(&skill_id) {
            Ok(info) => info,
            Err(failure) => return failure.as_fail().to_json(),
        };
        let path = match Self::pick_to_save(host, sender_id, &info.file_name) {
            Ok(path) => path,
            Err(cancelled) => return cancelled,
        };
        settled(self.service.export_to(&skill_id, &path), |path| {
            ok_with(vec![("path", JsonValue::String(path))])
        })
    }

    /// `C.exportBundle`
    pub fn export_bundle<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
        suggested: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:export-bundle") {
            return refused;
        }
        let Some(ids) = skill_id_list_of(raw) else {
            return invalid();
        };
        // one skill goes out under its own file name; several under the words the screen made
        let words = match suggested {
            Some(JsonValue::String(words)) => {
                Some(slice_utf16(words, 0.0, Some(BUNDLE_NAME_MAX_CHARS as f64)))
            }
            _ => None,
        };
        let mut default_path = skill_bundle_file_name(words.as_deref());
        if ids.len() == 1 {
            match self.service.export_info(&ids[0]) {
                Ok(info) => default_path = info.file_name,
                Err(failure) => return failure.as_fail().to_json(),
            }
        }
        let path = match Self::pick_to_save(host, sender_id, &default_path) {
            Ok(path) => path,
            Err(cancelled) => return cancelled,
        };
        settled(self.service.export_bundle_to(&ids, &path), |path| {
            ok_with(vec![("path", JsonValue::String(path))])
        })
    }

    /// `C.openFolder`
    pub fn open_folder<X: UserSkillsIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        id: Option<&JsonValue>,
    ) -> JsonValue {
        if let Some(refused) = Self::managed(host, sender_id, "skills:open-folder") {
            return refused;
        }
        let Some(skill_id) = skill_id_of(id) else {
            return invalid();
        };
        let dir = match self.service.folder_of(&skill_id) {
            Ok(dir) => dir,
            Err(failure) => return failure.as_fail().to_json(),
        };
        if host.open_path(&dir).is_empty() {
            ok_with(Vec::new())
        } else {
            fail_json("failed")
        }
    }
}

/// a service rejection as the failure `.catch(failureOf)` makes of it
pub fn failure_answer(failure: &Failure) -> JsonValue {
    failure.as_fail().to_json()
}
