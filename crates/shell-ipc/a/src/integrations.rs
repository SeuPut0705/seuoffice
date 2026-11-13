//! `apps/shell/src/main/integrations-ipc.ts`: Settings > Integrations.
//! Probe the command line link and every detected AI tool's skills folder,
//! install or remove the app's skill there, save it as a zip. No write
//! happens without a click in that pane.
//!
//! `@seuoffice/cli/agent-skills` and `inspectCliLink` of
//! `@seuoffice/cli/install` are not in `main-core`: the host trait
//! [`AgentSkills`] stands for them, one method per function. What the module
//! decides itself stays here: which folders `install-skill` may write to, the
//! ledger in app settings, the shape of the status.

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::Arc;

use jscompat::node_path::host::join;
use jscompat::{JsObject, JsonValue, js_regex, json_parse, to_primitive};
use main_core::node_fs::{NodeError, node_error};
use main_core::shell::app_settings::{read_app_settings, write_app_setting};
use main_core::shell::cli_link::{is_ephemeral_install, launcher_file_name};
use main_core::shell::skill_target::is_installable_skill_dir;
use shell_contract::hosts::{ClipboardHost, DialogsHost, FileDialog, FileFilter, MainWindowHost};
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::runtime::{AppPaths, PathName};
use shell_contract::{IpcError, IpcValue};

use crate::ports::Integrations;
use crate::value::{arg, from_json};

/// `LEDGER_KEY`: app-settings.json key under which every install this
/// machine's SeuOffice wrote is remembered
const LEDGER_KEY: &str = "agentSkillInstalls";
/// `SHARED_AGENT_ID`
const SHARED_AGENT_ID: &str = "agents";
/// `CLI_COMMAND`
const CLI_COMMAND: &str = "seuoffice";

/// `SkillLedger`: absolute SKILL.md path to what this app wrote there
pub type Ledger = JsObject<JsonValue>;

/// `BundledSkill`
#[derive(Clone, Debug, PartialEq)]
pub struct BundledSkill {
    pub bytes: Vec<u8>,
    pub text: String,
    pub version: String,
    pub sha256: String,
}

/// `AgentTarget`
#[derive(Clone, Debug, PartialEq)]
pub struct AgentTarget {
    pub id: String,
    pub label: String,
    pub skills_dir: String,
    /// an older copy in a tool's own folder that the shared row now serves
    pub legacy: bool,
}

/// `SkillInstallState`; `status` is one of missing, installed, outdated,
/// modified, foreign, newer, occupied
#[derive(Clone, Debug, PartialEq)]
pub struct SkillInstallState {
    pub status: String,
    pub path: String,
    pub installed_version: Option<String>,
    pub older: Option<bool>,
}

impl SkillInstallState {
    fn to_json(&self) -> JsonValue {
        let mut o = JsObject::new();
        o.set("status", JsonValue::String(self.status.clone()));
        o.set("path", JsonValue::String(self.path.clone()));
        if let Some(version) = &self.installed_version {
            o.set("installedVersion", JsonValue::String(version.clone()));
        }
        if let Some(older) = self.older {
            o.set("older", JsonValue::Bool(older));
        }
        JsonValue::Object(o)
    }
}

/// What the module reaches outside `main-core`: the skill table and installer
/// of `@seuoffice/cli/agent-skills`, the command line link probe, and where
/// the shell entry says the bundled files are. Every method with a `ledger`
/// reads and, where it writes, updates that ledger only; the module saves it.
pub trait AgentSkills {
    /// `cliDir`: directory holding seuoffice / seuoffice.cmd
    fn cli_dir(&self) -> String;
    /// `skillPath`: skills/seuoffice/SKILL.md
    fn skill_path(&self) -> String;
    /// `cliPackageJson`: packages/cli/package.json
    fn cli_package_json(&self) -> String;
    /// `app.isPackaged`
    fn is_packaged(&self) -> bool;
    /// `process.resourcesPath`
    fn resources_path(&self) -> String;
    /// `process.env[name]`
    fn env(&self, name: &str) -> Option<String>;
    /// `process.platform`
    fn platform(&self) -> String;
    /// `bundledSkillFrom(bytes)`
    fn bundled_skill_from(&self, bytes: Vec<u8>) -> BundledSkill;
    /// `detectAgents()`: the install rows present on this machine
    fn detect_agents(&self) -> Vec<AgentTarget>;
    /// `agentTarget(id)`; `None` for an id that is no row
    fn agent_target(&self, id: &str) -> Option<AgentTarget>;
    /// `skillRows(ledger)`: the detected rows, then the legacy copies, in pane order
    fn skill_rows(&self, ledger: &Ledger) -> Vec<AgentTarget>;
    /// `legacySkillCopies(ledger, process.env, undefined, only)`
    fn legacy_skill_copies(&self, ledger: &Ledger, only: &str) -> Vec<AgentTarget>;
    /// `skillFilesWritten(skillsDir, ledger)`
    fn skill_files_written(&self, skills_dir: &str, ledger: &Ledger) -> Vec<String>;
    /// `readInstallState(skillsDir, bundled, ledger)`
    fn read_install_state(
        &self,
        skills_dir: &str,
        bundled: &BundledSkill,
        ledger: &Ledger,
    ) -> SkillInstallState;
    /// `installSkill(skillsDir, bundled, ledger)`: the SKILL.md path; `Err` is its throw
    fn install_skill(
        &self,
        skills_dir: &str,
        bundled: &BundledSkill,
        ledger: &mut Ledger,
    ) -> Result<String, String>;
    /// `uninstallSkill(skillsDir, ledger)`: whether anything was removed
    fn uninstall_skill(&self, skills_dir: &str, ledger: &mut Ledger) -> bool;
    /// `buildSkillZip(bundled)`; `Err` is its rejection
    fn build_skill_zip(&self, bundled: &BundledSkill) -> Result<Vec<u8>, String>;
    /// `inspectCliLink({ launcher })`: the `InstallOutcome` object as is
    fn inspect_cli_link(&self, launcher: &str) -> JsonValue;
}

pub type AgentSkillsHost = Arc<dyn AgentSkills + Send + Sync>;

fn plain_error(message: impl Into<String>) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: message.into(),
    }
}

fn unknown_target() -> IpcError {
    plain_error("unknown skill target")
}

fn node(error: NodeError) -> IpcError {
    plain_error(error.message)
}

/// `String(value ?? '')`
fn string_or_empty(value: Option<&JsonValue>) -> String {
    match value {
        None | Some(JsonValue::Null) => String::new(),
        Some(value) => to_primitive(Some(value)).map_or_else(|e| e.0, |p| p.to_js_string()),
    }
}

/// `cliVersion(packageJson)`: the version of the bundled command line, empty
/// when the file is missing, not JSON, or has none
fn cli_version(package_json: &str) -> String {
    let Ok(bytes) = std::fs::read(package_json) else {
        return String::new();
    };
    match json_parse(&String::from_utf8_lossy(&bytes)) {
        Ok(parsed) => string_or_empty(parsed.get("version").as_deref()),
        Err(_) => String::new(),
    }
}

fn agent_json(row: &AgentTarget, state: &SkillInstallState) -> JsonValue {
    let mut o = JsObject::new();
    o.set("id", JsonValue::String(row.id.clone()));
    o.set("label", JsonValue::String(row.label.clone()));
    o.set("skillsDir", JsonValue::String(row.skills_dir.clone()));
    if row.legacy {
        o.set("legacy", JsonValue::Bool(true));
    }
    o.set("state", state.to_json());
    JsonValue::Object(o)
}

pub struct IntegrationsPort {
    paths: Arc<dyn AppPaths>,
    dialogs: DialogsHost,
    clipboard: ClipboardHost,
    main_window: MainWindowHost,
    skills: AgentSkillsHost,
    /// `pickedSkillDir`: the only non-agent folder `install-skill` may write
    /// to is the one the person just picked
    picked: RefCell<Option<String>>,
}

impl IntegrationsPort {
    pub fn new(
        paths: Arc<dyn AppPaths>,
        dialogs: DialogsHost,
        clipboard: ClipboardHost,
        main_window: MainWindowHost,
        skills: AgentSkillsHost,
    ) -> Self {
        IntegrationsPort {
            paths,
            dialogs,
            clipboard,
            main_window,
            skills,
            picked: RefCell::new(None),
        }
    }

    /// `deps.settingsPath()`
    fn settings_path(&self) -> String {
        let path: PathBuf = self
            .paths
            .path(PathName::UserData)
            .join("app-settings.json");
        path.to_string_lossy().into_owned()
    }

    /// `bundled()`: reads the bundled SKILL.md
    fn bundled(&self) -> Result<BundledSkill, IpcError> {
        let path = self.skills.skill_path();
        let bytes = std::fs::read(&path).map_err(|e| node(node_error(&e, "open", &path)))?;
        Ok(self.skills.bundled_skill_from(bytes))
    }

    /// `ledger()`: `ledgerFromSettings(readAppSettings(settingsPath))`
    fn ledger(&self) -> Ledger {
        match read_app_settings(&self.settings_path()).get(LEDGER_KEY) {
            Some(JsonValue::Object(raw)) => raw.clone(),
            _ => Ledger::new(),
        }
    }

    /// `saveLedger(l)`
    fn save_ledger(&self, ledger: Ledger) -> Result<(), IpcError> {
        write_app_setting(
            &self.settings_path(),
            LEDGER_KEY,
            Some(JsonValue::Object(ledger)),
        )
        .map_err(node)
    }

    /// `stateOf(skillsDir)`
    fn state_of(&self, skills_dir: &str) -> Result<SkillInstallState, IpcError> {
        Ok(self
            .skills
            .read_install_state(skills_dir, &self.bundled()?, &self.ledger()))
    }

    /// `vouchedSkillDirs()`
    fn vouched_skill_dirs(&self) -> Vec<String> {
        let mut dirs: Vec<String> = self
            .skills
            .detect_agents()
            .into_iter()
            .map(|a| a.skills_dir)
            .collect();
        dirs.extend(self.picked.borrow().clone());
        dirs
    }

    fn status(&self) -> Result<JsonValue, IpcError> {
        let skill = self.bundled()?;
        let ledger = self.ledger();
        let launcher = join(&[
            &self.skills.cli_dir(),
            &launcher_file_name(&self.skills.platform()),
        ]);
        let mut cli = JsObject::new();
        if let JsonValue::Object(link) = self.skills.inspect_cli_link(&launcher) {
            for (key, value) in link.entries() {
                cli.set(key, value.clone());
            }
        }
        cli.set("launcherDir", JsonValue::String(self.skills.cli_dir()));
        cli.set(
            "ephemeral",
            JsonValue::Bool(
                self.skills.is_packaged()
                    && is_ephemeral_install(
                        &self.skills.resources_path(),
                        self.skills.env("APPIMAGE").as_deref(),
                    ),
            ),
        );
        cli.set(
            "version",
            JsonValue::String(cli_version(&self.skills.cli_package_json())),
        );
        let needs_cli = js_regex!(r#"^\s+cli:\s*['"]?>=\s*(\d+\.\d+\.\d+)"#, "m")
            .exec(&skill.text)
            .and_then(|m| m.get(1).map(str::to_owned))
            .unwrap_or_default();
        let agents = self
            .skills
            .skill_rows(&ledger)
            .iter()
            .map(|row| {
                let state = self
                    .skills
                    .read_install_state(&row.skills_dir, &skill, &ledger);
                agent_json(row, &state)
            })
            .collect();
        let mut status = JsObject::new();
        status.set("cli", JsonValue::Object(cli));
        status.set("skillVersion", JsonValue::String(skill.version.clone()));
        status.set("skillNeedsCli", JsonValue::String(needs_cli));
        status.set("agents", JsonValue::Array(agents));
        Ok(JsonValue::Object(status))
    }

    /// `INTEGRATIONS_CHANNELS.installSkill`: `target` is `{ agentId?, dir? }`
    fn install(&self, target: Option<&JsonValue>) -> Result<SkillInstallState, IpcError> {
        let target = match target {
            None => return Err(type_error("undefined")),
            Some(JsonValue::Null) => return Err(type_error("null")),
            Some(target) => target,
        };
        let dir = target.get("dir");
        let dir = dir.as_deref();
        let agent_id = match target.get("agentId").as_deref() {
            Some(JsonValue::String(id)) => Some(id.clone()),
            _ => None,
        };
        let row = if dir.is_some_and(JsonValue::truthy) {
            None
        } else {
            agent_id.and_then(|id| self.skills.agent_target(&id))
        };
        let skills_dir = match dir {
            None | Some(JsonValue::Null) => row.as_ref().map(|r| r.skills_dir.clone()),
            Some(JsonValue::String(dir)) => Some(dir.clone()),
            // a number, flag or object is no folder: the check below refuses it
            Some(_) => return Err(unknown_target()),
        };
        let skills_dir = skills_dir
            .filter(|dir| !dir.is_empty())
            .ok_or_else(unknown_target)?;
        if dir.is_some_and(JsonValue::truthy)
            && !is_installable_skill_dir(Some(&skills_dir), &self.vouched_skill_dirs())
        {
            return Err(unknown_target());
        }
        let mut ledger = self.ledger();
        // a tool the shared row serves gets no new copy of its own: only one this app already wrote is rewritten
        if row.as_ref().is_some_and(|r| r.legacy)
            && self
                .skills
                .skill_files_written(&skills_dir, &ledger)
                .is_empty()
        {
            return Err(unknown_target());
        }
        let skill = self.bundled()?;
        self.skills
            .install_skill(&skills_dir, &skill, &mut ledger)
            .map_err(plain_error)?;
        // the shared row brings the older copies along so a tool never finds two versions under one
        // name; a copy edited by hand (or otherwise not plainly outdated) waits for its own row's click
        if row.as_ref().is_some_and(|r| r.id == SHARED_AGENT_ID) {
            for copy in self.skills.legacy_skill_copies(&ledger, SHARED_AGENT_ID) {
                let state = self
                    .skills
                    .read_install_state(&copy.skills_dir, &skill, &ledger);
                if state.status == "outdated" {
                    self.skills
                        .install_skill(&copy.skills_dir, &skill, &mut ledger)
                        .map_err(plain_error)?;
                }
            }
        }
        self.save_ledger(ledger)?;
        self.state_of(&skills_dir)
    }

    fn uninstall(&self, agent_id: Option<&JsonValue>) -> Result<SkillInstallState, IpcError> {
        let target = match agent_id {
            Some(JsonValue::String(id)) => self.skills.agent_target(id),
            _ => None,
        }
        .ok_or_else(unknown_target)?;
        let mut ledger = self.ledger();
        if self.skills.uninstall_skill(&target.skills_dir, &mut ledger) {
            self.save_ledger(ledger)?;
        }
        self.state_of(&target.skills_dir)
    }

    fn pick_skill_dir(&self, title: Option<&JsonValue>) -> IpcValue {
        let options = FileDialog {
            title: Some(string_or_empty(title)),
            properties: vec!["openDirectory".into(), "createDirectory".into()],
            ..FileDialog::default()
        };
        let chosen = self
            .dialogs
            .open(self.main_window.window(), &options)
            .and_then(|paths| paths.into_iter().next())
            .map(|path| path.to_string_lossy().into_owned());
        *self.picked.borrow_mut() = chosen.clone();
        chosen.map_or(IpcValue::Null, IpcValue::String)
    }

    fn save_skill_zip(&self, title: Option<&JsonValue>) -> Result<IpcValue, IpcError> {
        let skill = self.bundled()?;
        let downloads = self.paths.path(PathName::Downloads);
        let options = FileDialog {
            title: Some(string_or_empty(title)),
            default_path: Some(
                downloads.join(format!("{CLI_COMMAND}-skill-{}.zip", skill.version)),
            ),
            filters: vec![FileFilter {
                name: "ZIP".into(),
                extensions: vec!["zip".into()],
            }],
            ..FileDialog::default()
        };
        let Some(path) = self
            .dialogs
            .save(self.main_window.window(), &options)
            .filter(|path| !path.as_os_str().is_empty())
        else {
            return Ok(IpcValue::Null);
        };
        let zip = self.skills.build_skill_zip(&skill).map_err(plain_error)?;
        let shown = path.to_string_lossy().into_owned();
        std::fs::write(&path, zip).map_err(|e| node(node_error(&e, "open", &shown)))?;
        Ok(IpcValue::String(shown))
    }
}

/// What reading `target.dir` throws on a missing argument
fn type_error(what: &str) -> IpcError {
    IpcError {
        name: Some("TypeError".into()),
        message: format!("Cannot read properties of {what} (reading 'dir')"),
    }
}

impl Integrations for IntegrationsPort {
    fn integrations_copy_text(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        if let Some(IpcValue::String(text)) = args.first() {
            self.clipboard.write_text(text);
        }
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn integrations_install_skill(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        reply.reply(
            self.install(arg(&args, 0).as_ref())
                .map(|state| from_json(&state.to_json())),
        )
    }

    fn integrations_pick_skill_dir(
        &self,
        _cx: &CallContext,
        args: Vec<IpcValue>,
        reply: Responder,
    ) {
        reply.reply(Ok(self.pick_skill_dir(arg(&args, 0).as_ref())))
    }

    fn integrations_save_skill_zip(
        &self,
        _cx: &CallContext,
        args: Vec<IpcValue>,
        reply: Responder,
    ) {
        reply.reply(self.save_skill_zip(arg(&args, 0).as_ref()))
    }

    fn integrations_status(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        reply.reply(self.status().map(|status| from_json(&status)))
    }

    fn integrations_uninstall_skill(
        &self,
        _cx: &CallContext,
        args: Vec<IpcValue>,
        reply: Responder,
    ) {
        reply.reply(
            self.uninstall(arg(&args, 0).as_ref())
                .map(|state| from_json(&state.to_json())),
        )
    }
}

/// The host the shell inserts for this port
pub fn factory() -> crate::Factory<dyn Integrations> {
    crate::Factory::new(|services, _| {
        let hosts = &services.hosts;
        let batch = shell_contract::Batch::A;
        let port: std::rc::Rc<dyn Integrations> = std::rc::Rc::new(IntegrationsPort::new(
            services.paths.clone(),
            hosts.need::<DialogsHost>(batch)?,
            hosts.need::<ClipboardHost>(batch)?,
            hosts.need::<MainWindowHost>(batch)?,
            hosts.need::<AgentSkillsHost>(batch)?,
        ));
        Ok(port)
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Mutex;

    use shell_contract::hosts::{Clipboard, Dialogs, MainWindow, MessageBox, MessageBoxAnswer};
    use shell_contract::ipc::Sender;
    use shell_contract::runtime::CancelToken;
    use shell_contract::{Surface, ViewId, WindowId};

    use super::*;

    const SKILL: &str =
        "---\nname: seuoffice\nversion: 2.0.0\nmetadata:\n  cli: '>=1.4.0'\n---\nbody\n";

    struct Dir {
        user_data: PathBuf,
        downloads: PathBuf,
    }
    impl AppPaths for Dir {
        fn path(&self, name: PathName) -> PathBuf {
            match name {
                PathName::Downloads => self.downloads.clone(),
                _ => self.user_data.clone(),
            }
        }
    }

    #[derive(Default)]
    struct Pc {
        picks: Mutex<Vec<Option<PathBuf>>>,
        save: Mutex<Option<PathBuf>>,
        seen_open: Mutex<Vec<(Option<WindowId>, FileDialog)>>,
        seen_save: Mutex<Vec<FileDialog>>,
        clip: Mutex<Vec<String>>,
    }
    impl Dialogs for Pc {
        fn open(&self, parent: Option<WindowId>, options: &FileDialog) -> Option<Vec<PathBuf>> {
            self.seen_open
                .lock()
                .unwrap()
                .push((parent, options.clone()));
            self.picks.lock().unwrap().remove(0).map(|p| vec![p])
        }
        fn save(&self, _: Option<WindowId>, options: &FileDialog) -> Option<PathBuf> {
            self.seen_save.lock().unwrap().push(options.clone());
            self.save.lock().unwrap().clone()
        }
        fn message(&self, _: Option<WindowId>, _: &MessageBox) -> MessageBoxAnswer {
            unreachable!("integrations asks no question")
        }
        fn error(&self, _: &str, _: &str) {}
    }
    impl Clipboard for Pc {
        fn read_text(&self) -> String {
            String::new()
        }
        fn write_text(&self, text: &str) {
            self.clip.lock().unwrap().push(text.to_owned());
        }
        fn read_html(&self) -> String {
            String::new()
        }
        fn write_html(&self, _: &str, _: Option<&str>) {}
        fn read_image_png(&self) -> Vec<u8> {
            Vec::new()
        }
        fn write_image_png(&self, _: &[u8]) {}
        fn available_formats(&self) -> Vec<String> {
            Vec::new()
        }
    }

    struct Main;
    impl MainWindow for Main {
        fn view(&self) -> Option<ViewId> {
            Some(ViewId(1))
        }
        fn window(&self) -> Option<WindowId> {
            Some(WindowId(1))
        }
    }

    /// The skill table over real folders: a SKILL.md this app wrote is in the
    /// ledger and equal to the bundled bytes (installed), in the ledger and
    /// different (outdated), or not in the ledger (foreign)
    struct Skills {
        root: PathBuf,
        packaged: bool,
        resources: String,
    }

    impl Skills {
        fn row(&self, id: &str, legacy: bool) -> AgentTarget {
            AgentTarget {
                id: id.into(),
                label: format!("label of {id}"),
                skills_dir: self.root.join(id).to_string_lossy().into_owned(),
                legacy,
            }
        }
        fn file(skills_dir: &str) -> String {
            format!("{skills_dir}/seuoffice/SKILL.md")
        }
    }

    impl AgentSkills for Skills {
        fn cli_dir(&self) -> String {
            self.root.join("cli").to_string_lossy().into_owned()
        }
        fn skill_path(&self) -> String {
            self.root.join("SKILL.md").to_string_lossy().into_owned()
        }
        fn cli_package_json(&self) -> String {
            self.root
                .join("package.json")
                .to_string_lossy()
                .into_owned()
        }
        fn is_packaged(&self) -> bool {
            self.packaged
        }
        fn resources_path(&self) -> String {
            self.resources.clone()
        }
        fn env(&self, _: &str) -> Option<String> {
            None
        }
        fn platform(&self) -> String {
            "darwin".into()
        }
        fn bundled_skill_from(&self, bytes: Vec<u8>) -> BundledSkill {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let version = text
                .lines()
                .find_map(|l| l.strip_prefix("version: "))
                .unwrap_or("0.0.0")
                .to_owned();
            BundledSkill {
                bytes,
                text,
                version,
                sha256: String::new(),
            }
        }
        fn detect_agents(&self) -> Vec<AgentTarget> {
            vec![
                self.row("claude-code", false),
                self.row(SHARED_AGENT_ID, false),
            ]
        }
        fn agent_target(&self, id: &str) -> Option<AgentTarget> {
            match id {
                "claude-code" | "agents" => Some(self.row(id, false)),
                "codex" => Some(self.row(id, true)),
                _ => None,
            }
        }
        fn skill_rows(&self, ledger: &Ledger) -> Vec<AgentTarget> {
            let mut rows = self.detect_agents();
            rows.extend(self.legacy_skill_copies(ledger, SHARED_AGENT_ID));
            rows
        }
        fn legacy_skill_copies(&self, ledger: &Ledger, _only: &str) -> Vec<AgentTarget> {
            let codex = self.row("codex", true);
            if self
                .skill_files_written(&codex.skills_dir, ledger)
                .is_empty()
            {
                Vec::new()
            } else {
                vec![codex]
            }
        }
        fn skill_files_written(&self, skills_dir: &str, ledger: &Ledger) -> Vec<String> {
            let file = Self::file(skills_dir);
            if ledger.get(&file).is_some() {
                vec![file]
            } else {
                Vec::new()
            }
        }
        fn read_install_state(
            &self,
            skills_dir: &str,
            bundled: &BundledSkill,
            ledger: &Ledger,
        ) -> SkillInstallState {
            let path = Self::file(skills_dir);
            let status = match std::fs::read(&path) {
                Err(_) => "missing",
                Ok(_) if ledger.get(&path).is_none() => "foreign",
                Ok(bytes) if bytes == bundled.bytes => "installed",
                Ok(_) => "outdated",
            };
            SkillInstallState {
                status: status.into(),
                path,
                installed_version: None,
                older: None,
            }
        }
        fn install_skill(
            &self,
            skills_dir: &str,
            bundled: &BundledSkill,
            ledger: &mut Ledger,
        ) -> Result<String, String> {
            let path = Self::file(skills_dir);
            if skills_dir.ends_with("refused") {
                return Err(format!("{path} is a symlink"));
            }
            std::fs::create_dir_all(Path::new(&path).parent().unwrap()).unwrap();
            std::fs::write(&path, &bundled.bytes).unwrap();
            ledger.set(path.clone(), JsonValue::Bool(true));
            Ok(path)
        }
        fn uninstall_skill(&self, skills_dir: &str, ledger: &mut Ledger) -> bool {
            let written = self.skill_files_written(skills_dir, ledger);
            for file in &written {
                let _ = std::fs::remove_file(file);
            }
            *ledger = ledger
                .entries()
                .into_iter()
                .filter(|(key, _)| !written.iter().any(|w| w == key))
                .map(|(k, v)| (k.to_owned(), v.clone()))
                .collect();
            !written.is_empty()
        }
        fn build_skill_zip(&self, bundled: &BundledSkill) -> Result<Vec<u8>, String> {
            if bundled.version == "0.0.0" {
                return Err("zip failed".into());
            }
            let mut zip = b"ZIP:".to_vec();
            zip.extend(&bundled.bytes);
            Ok(zip)
        }
        fn inspect_cli_link(&self, launcher: &str) -> JsonValue {
            let mut o = JsObject::new();
            o.set("status", JsonValue::String("missing".into()));
            o.set("location", JsonValue::String(format!("link of {launcher}")));
            JsonValue::Object(o)
        }
    }

    struct Rig {
        dir: PathBuf,
        pc: Arc<Pc>,
        port: IntegrationsPort,
    }

    fn rig_with(name: &str, packaged: bool, resources: &str, skill: Option<&str>) -> Rig {
        let dir = std::env::temp_dir().join(format!(
            "shell-a-integrations-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("downloads")).unwrap();
        std::fs::create_dir_all(dir.join("data")).unwrap();
        if let Some(skill) = skill {
            std::fs::write(dir.join("SKILL.md"), skill).unwrap();
        }
        std::fs::write(dir.join("package.json"), r#"{"version":"1.4.2"}"#).unwrap();
        let pc = Arc::new(Pc::default());
        let port = IntegrationsPort::new(
            Arc::new(Dir {
                user_data: dir.join("data"),
                downloads: dir.join("downloads"),
            }),
            pc.clone(),
            pc.clone(),
            Arc::new(Main),
            Arc::new(Skills {
                root: dir.clone(),
                packaged,
                resources: resources.into(),
            }),
        );
        Rig { dir, pc, port }
    }

    fn rig(name: &str) -> Rig {
        rig_with(
            name,
            false,
            "/Applications/SeuOffice.app/Contents/Resources",
            Some(SKILL),
        )
    }

    fn call(f: impl FnOnce(&CallContext, Responder)) -> Result<IpcValue, IpcError> {
        let cx = CallContext {
            sender: Sender {
                view: ViewId(5),
                window: WindowId(2),
                surface: Surface::Docs,
            },
            request: None,
            cancel: CancelToken::default(),
        };
        let out = Arc::new(Mutex::new(None));
        let slot = out.clone();
        f(
            &cx,
            Responder::new(move |r| *slot.lock().unwrap() = Some(r)),
        );
        out.lock().unwrap().take().expect("answered")
    }

    fn obj(entries: &[(&str, IpcValue)]) -> IpcValue {
        IpcValue::Object(
            entries
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        )
    }

    fn s(text: &str) -> IpcValue {
        IpcValue::String(text.into())
    }

    fn field(value: &IpcValue, key: &str) -> IpcValue {
        match value {
            IpcValue::Object(entries) => entries
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .unwrap_or(IpcValue::Undefined),
            other => panic!("not an object: {other:?}"),
        }
    }

    fn install(r: &Rig, target: IpcValue) -> Result<IpcValue, IpcError> {
        call(|cx, re| r.port.integrations_install_skill(cx, vec![target], re))
    }

    fn uninstall(r: &Rig, id: IpcValue) -> Result<IpcValue, IpcError> {
        call(|cx, re| r.port.integrations_uninstall_skill(cx, vec![id], re))
    }

    fn status(r: &Rig) -> IpcValue {
        call(|cx, re| r.port.integrations_status(cx, vec![], re)).unwrap()
    }

    fn dir_of(r: &Rig, id: &str) -> String {
        r.dir.join(id).to_string_lossy().into_owned()
    }

    fn ledger_keys(r: &Rig) -> Vec<String> {
        r.port
            .ledger()
            .entries()
            .into_iter()
            .map(|(k, _)| k.to_owned())
            .collect()
    }

    fn message(result: Result<IpcValue, IpcError>) -> String {
        result.expect_err("rejected").message
    }

    #[test]
    fn copy_text_reaches_the_clipboard_only_for_a_string() {
        let r = rig("copy");
        for text in [s("seuoffice --help"), IpcValue::Number(3.0), IpcValue::Null] {
            let got = call(|cx, re| r.port.integrations_copy_text(cx, vec![text], re));
            assert_eq!(got, Ok(IpcValue::Undefined));
        }
        assert_eq!(
            *r.pc.clip.lock().unwrap(),
            vec!["seuoffice --help".to_owned()]
        );
    }

    #[test]
    fn status_reports_the_link_the_skill_and_a_state_per_row() {
        let r = rig("status");
        let got = status(&r);
        let cli = field(&got, "cli");
        assert_eq!(field(&cli, "status"), s("missing"));
        assert_eq!(
            field(&cli, "location"),
            s(&format!("link of {}/cli/seuoffice", r.dir.display()))
        );
        assert_eq!(
            field(&cli, "launcherDir"),
            s(&format!("{}/cli", r.dir.display()))
        );
        assert_eq!(field(&cli, "ephemeral"), IpcValue::Bool(false));
        assert_eq!(field(&cli, "version"), s("1.4.2"));
        assert_eq!(field(&got, "skillVersion"), s("2.0.0"));
        assert_eq!(field(&got, "skillNeedsCli"), s("1.4.0"));
        let IpcValue::Array(rows) = field(&got, "agents") else {
            panic!("agents is a list")
        };
        let ids: Vec<IpcValue> = rows.iter().map(|row| field(row, "id")).collect();
        assert_eq!(ids, vec![s("claude-code"), s("agents")]);
        assert_eq!(field(&field(&rows[0], "state"), "status"), s("missing"));
        assert_eq!(field(&rows[0], "legacy"), IpcValue::Undefined);
        assert_eq!(field(&rows[0], "skillsDir"), s(&dir_of(&r, "claude-code")));
    }

    #[test]
    fn status_lists_an_installed_row_and_a_legacy_copy_this_app_wrote() {
        let r = rig("status-rows");
        install(&r, obj(&[("agentId", s("claude-code"))])).unwrap();
        let mut ledger = r.port.ledger();
        let codex = format!("{}/seuoffice/SKILL.md", dir_of(&r, "codex"));
        ledger.set(codex.clone(), JsonValue::Bool(true));
        r.port.save_ledger(ledger).unwrap();
        std::fs::create_dir_all(Path::new(&codex).parent().unwrap()).unwrap();
        std::fs::write(&codex, "old").unwrap();
        let IpcValue::Array(rows) = field(&status(&r), "agents") else {
            panic!("agents is a list")
        };
        let seen: Vec<(IpcValue, IpcValue, IpcValue)> = rows
            .iter()
            .map(|row| {
                (
                    field(row, "id"),
                    field(&field(row, "state"), "status"),
                    field(row, "legacy"),
                )
            })
            .collect();
        assert_eq!(
            seen,
            vec![
                (s("claude-code"), s("installed"), IpcValue::Undefined),
                (s("agents"), s("missing"), IpcValue::Undefined),
                (s("codex"), s("outdated"), IpcValue::Bool(true)),
            ]
        );
    }

    #[test]
    fn status_marks_an_install_from_a_temporary_mount_and_survives_a_bad_package_json() {
        let on_mount = rig_with(
            "mount",
            true,
            "/Volumes/SeuOffice/x.app/Contents/Resources",
            Some(SKILL),
        );
        assert_eq!(
            field(&field(&status(&on_mount), "cli"), "ephemeral"),
            IpcValue::Bool(true)
        );
        let installed = rig_with(
            "installed",
            true,
            "/Applications/x.app/Contents/Resources",
            Some(SKILL),
        );
        assert_eq!(
            field(&field(&status(&installed), "cli"), "ephemeral"),
            IpcValue::Bool(false)
        );
        std::fs::write(installed.dir.join("package.json"), "{oops").unwrap();
        assert_eq!(field(&field(&status(&installed), "cli"), "version"), s(""));
        std::fs::write(installed.dir.join("package.json"), r#"{"name":"cli"}"#).unwrap();
        assert_eq!(field(&field(&status(&installed), "cli"), "version"), s(""));
    }

    #[test]
    fn status_without_the_bundled_skill_rejects() {
        let r = rig_with("no-skill", false, "/r", None);
        let got = call(|cx, re| r.port.integrations_status(cx, vec![], re));
        assert!(message(got).starts_with("ENOENT: no such file or directory, open"));
    }

    #[test]
    fn installing_into_a_detected_row_writes_the_skill_and_remembers_it() {
        let r = rig("install");
        let got = install(&r, obj(&[("agentId", s("claude-code"))])).unwrap();
        let file = format!("{}/seuoffice/SKILL.md", dir_of(&r, "claude-code"));
        assert_eq!(field(&got, "status"), s("installed"));
        assert_eq!(field(&got, "path"), s(&file));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), SKILL);
        assert_eq!(ledger_keys(&r), vec![file]);
    }

    #[test]
    fn installing_for_an_unknown_target_is_refused_and_writes_nothing() {
        let r = rig("unknown");
        for bad in [
            obj(&[("agentId", s("nobody"))]),
            obj(&[]),
            obj(&[("agentId", IpcValue::Number(1.0))]),
            obj(&[("dir", s(""))]),
            obj(&[("dir", IpcValue::Number(7.0))]),
        ] {
            assert_eq!(message(install(&r, bad)), "unknown skill target");
        }
        assert!(!r.dir.join("data/app-settings.json").exists());
        assert!(!r.dir.join("claude-code").exists());
    }

    #[test]
    fn a_missing_target_argument_throws_the_type_error_of_reading_dir() {
        let r = rig("type-error");
        let none = call(|cx, re| r.port.integrations_install_skill(cx, vec![], re));
        let err = none.unwrap_err();
        assert_eq!(err.name.as_deref(), Some("TypeError"));
        assert_eq!(
            err.message,
            "Cannot read properties of undefined (reading 'dir')"
        );
        let null = install(&r, IpcValue::Null).unwrap_err();
        assert_eq!(
            null.message,
            "Cannot read properties of null (reading 'dir')"
        );
    }

    #[test]
    fn a_picked_folder_takes_a_skill_until_the_next_pick_replaces_it() {
        let r = rig("picked");
        let mine = r.dir.join("mine").to_string_lossy().into_owned();
        let other = r.dir.join("other").to_string_lossy().into_owned();
        assert_eq!(
            message(install(&r, obj(&[("dir", s(&mine))]))),
            "unknown skill target"
        );
        *r.pc.picks.lock().unwrap() = vec![Some(PathBuf::from(&mine)), None];
        let picked = call(|cx, re| r.port.integrations_pick_skill_dir(cx, vec![s("Pick")], re));
        assert_eq!(picked, Ok(s(&mine)));
        let got = install(&r, obj(&[("dir", s(&mine))])).unwrap();
        assert_eq!(field(&got, "status"), s("installed"));
        assert_eq!(
            message(install(&r, obj(&[("dir", s(&other))]))),
            "unknown skill target"
        );
        let cancelled = call(|cx, re| r.port.integrations_pick_skill_dir(cx, vec![s("Pick")], re));
        assert_eq!(cancelled, Ok(IpcValue::Null));
        assert_eq!(
            message(install(&r, obj(&[("dir", s(&mine))]))),
            "unknown skill target"
        );
    }

    #[test]
    fn the_folder_dialog_opens_over_the_shell_window_with_the_renderers_title() {
        let r = rig("pick-dialog");
        *r.pc.picks.lock().unwrap() = vec![None, None];
        call(|cx, re| {
            r.port
                .integrations_pick_skill_dir(cx, vec![s("Choose a folder")], re)
        })
        .unwrap();
        call(|cx, re| r.port.integrations_pick_skill_dir(cx, vec![], re)).unwrap();
        let seen = r.pc.seen_open.lock().unwrap();
        assert_eq!(seen[0].0, Some(WindowId(1)));
        assert_eq!(seen[0].1.title.as_deref(), Some("Choose a folder"));
        assert_eq!(
            seen[0].1.properties,
            vec!["openDirectory", "createDirectory"]
        );
        assert_eq!(seen[1].1.title.as_deref(), Some(""));
    }

    #[test]
    fn a_legacy_row_takes_a_write_only_where_this_app_wrote_before() {
        let r = rig("legacy");
        assert_eq!(
            message(install(&r, obj(&[("agentId", s("codex"))]))),
            "unknown skill target"
        );
        let codex = format!("{}/seuoffice/SKILL.md", dir_of(&r, "codex"));
        std::fs::create_dir_all(Path::new(&codex).parent().unwrap()).unwrap();
        std::fs::write(&codex, "old").unwrap();
        let mut ledger = r.port.ledger();
        ledger.set(codex.clone(), JsonValue::Bool(true));
        r.port.save_ledger(ledger).unwrap();
        let got = install(&r, obj(&[("agentId", s("codex"))])).unwrap();
        assert_eq!(field(&got, "status"), s("installed"));
        assert_eq!(std::fs::read_to_string(&codex).unwrap(), SKILL);
    }

    #[test]
    fn the_shared_row_brings_outdated_legacy_copies_along_but_not_edited_ones() {
        let r = rig("shared");
        let old = format!("{}/seuoffice/SKILL.md", dir_of(&r, "codex"));
        std::fs::create_dir_all(Path::new(&old).parent().unwrap()).unwrap();
        std::fs::write(&old, "old").unwrap();
        let mut ledger = r.port.ledger();
        ledger.set(old.clone(), JsonValue::Bool(true));
        r.port.save_ledger(ledger).unwrap();
        install(&r, obj(&[("agentId", s("agents"))])).unwrap();
        assert_eq!(std::fs::read_to_string(&old).unwrap(), SKILL);
        // a claude-code install leaves the legacy copy alone
        std::fs::write(&old, "older").unwrap();
        install(&r, obj(&[("agentId", s("claude-code"))])).unwrap();
        assert_eq!(std::fs::read_to_string(&old).unwrap(), "older");
    }

    #[test]
    fn a_refused_write_rejects_with_its_message_and_leaves_the_ledger_alone() {
        let r = rig("refused");
        *r.pc.picks.lock().unwrap() = vec![Some(r.dir.join("refused"))];
        call(|cx, re| r.port.integrations_pick_skill_dir(cx, vec![s("t")], re)).unwrap();
        let dir = r.dir.join("refused").to_string_lossy().into_owned();
        let got = install(&r, obj(&[("dir", s(&dir))]));
        assert_eq!(
            message(got),
            format!("{dir}/seuoffice/SKILL.md is a symlink")
        );
        assert!(!r.dir.join("data/app-settings.json").exists());
    }

    #[test]
    fn uninstalling_removes_what_this_app_wrote_and_forgets_it() {
        let r = rig("uninstall");
        install(&r, obj(&[("agentId", s("claude-code"))])).unwrap();
        let file = format!("{}/seuoffice/SKILL.md", dir_of(&r, "claude-code"));
        let got = uninstall(&r, s("claude-code")).unwrap();
        assert_eq!(field(&got, "status"), s("missing"));
        assert!(!Path::new(&file).exists());
        assert!(ledger_keys(&r).is_empty());
    }

    #[test]
    fn uninstalling_what_this_app_did_not_write_changes_nothing() {
        let r = rig("uninstall-foreign");
        let file = format!("{}/seuoffice/SKILL.md", dir_of(&r, "claude-code"));
        std::fs::create_dir_all(Path::new(&file).parent().unwrap()).unwrap();
        std::fs::write(&file, "by hand").unwrap();
        let got = uninstall(&r, s("claude-code")).unwrap();
        assert_eq!(field(&got, "status"), s("foreign"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "by hand");
        assert!(!r.dir.join("data/app-settings.json").exists());
        assert_eq!(message(uninstall(&r, s("nobody"))), "unknown skill target");
        assert_eq!(
            message(uninstall(&r, IpcValue::Undefined)),
            "unknown skill target"
        );
    }

    #[test]
    fn the_zip_is_saved_where_the_person_chose_and_nothing_is_written_on_cancel() {
        let r = rig("zip");
        let target = r.dir.join("out.zip");
        *r.pc.save.lock().unwrap() = Some(target.clone());
        let got = call(|cx, re| r.port.integrations_save_skill_zip(cx, vec![s("Save")], re));
        assert_eq!(got, Ok(s(&target.to_string_lossy())));
        assert_eq!(
            std::fs::read(&target).unwrap(),
            [b"ZIP:".as_slice(), SKILL.as_bytes()].concat()
        );
        let asked = r.pc.seen_save.lock().unwrap()[0].clone();
        assert_eq!(asked.title.as_deref(), Some("Save"));
        assert_eq!(
            asked.default_path,
            Some(r.dir.join("downloads").join("seuoffice-skill-2.0.0.zip"))
        );
        assert_eq!(
            asked.filters,
            vec![FileFilter {
                name: "ZIP".into(),
                extensions: vec!["zip".into()]
            }]
        );
        let cancelled = rig("zip-cancel");
        let got = call(|cx, re| {
            cancelled
                .port
                .integrations_save_skill_zip(cx, vec![s("Save")], re)
        });
        assert_eq!(got, Ok(IpcValue::Null));
        assert!(!cancelled.dir.join("out.zip").exists());
    }

    #[test]
    fn a_zip_that_cannot_be_built_or_written_rejects() {
        let r = rig_with("zip-fail", false, "/r", Some("no version here"));
        *r.pc.save.lock().unwrap() = Some(r.dir.join("out.zip"));
        let got = call(|cx, re| r.port.integrations_save_skill_zip(cx, vec![s("Save")], re));
        assert_eq!(message(got), "zip failed");
        let unwritable = rig("zip-unwritable");
        *unwritable.pc.save.lock().unwrap() = Some(unwritable.dir.join("missing-dir/out.zip"));
        let got = call(|cx, re| {
            unwritable
                .port
                .integrations_save_skill_zip(cx, vec![s("t")], re)
        });
        assert!(message(got).starts_with("ENOENT: no such file or directory, open"));
    }
}
