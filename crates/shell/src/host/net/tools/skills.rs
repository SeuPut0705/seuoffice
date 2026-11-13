//! The hosts of Settings > Integrations (`shell_ipc_a::integrations`) and of
//! the user skills (`shell_ipc_a::user_skills`).
//!
//! `AgentSkills` is main-core's `cli_agent_skills` and `cli_install` over the
//! machine's home and environment: real. `SkillsShell` says where the bundled
//! skills are: real. `SkillImporter` stands for the ai-provider import
//! pipeline (archives, GitHub, zip writers), which main-core does not have:
//! stub, except removing the import's temporary folder. `TemplateCopyTabs` is
//! the tab manager: stub.
//!
//! Where the bundled files are: a packaged shell carries them under the
//! resource folder (`cli/`, `builtin-skills/`); a shell run from a checkout
//! reads the repository, as the Electron build's unpackaged run did. A folder
//! under the resources that exists is what says "packaged", as it does for the
//! renderer bundles (`app_scheme.rs`).

use std::path::PathBuf;
use std::sync::Arc;

use jscompat::{JsObject, JsonValue, json_value_from_serde};
use main_core::packages::ai_provider::user_skills_import::{
    ChangedCheck, GitHubSkillUpdateCheck, InstallImportedSkillsResult, InstalledSkill, SkillImport,
    SkillImportSource, Thrown, remove_quietly,
};
use main_core::packages::cli_agent_skills as skills;
use main_core::packages::cli_install::{
    Env, InstallOptions, InstallOutcome, inspect_cli_link, run_power_shell,
};
use main_core::packages::electron_utils::unsaved_files::{OpenFileState, OpenFilesSourceFailed};
use main_core::shell::user_skills::builtin_dir::{BuiltinSkillsDirOptions, builtin_skills_dir_for};
use main_core::shell::user_skills::template_tabs::TemplateCopy;
use main_core::shell::user_skills::user_skills_service::{
    Aborted, ApplyUpdateOptions, CheckUpdateOptions, Discard, InstallOptions as ImportOptions,
    PrepareEnv,
};
use shell_contract::{Hosts, ViewId};
use shell_ipc_a::integrations::{
    AgentSkills, AgentSkillsHost, AgentTarget, BundledSkill, Ledger, SkillInstallState,
};
use shell_ipc_a::user_skills::{
    OpenedCopy, SkillImporter, SkillImporterHost, SkillsShell, SkillsShellHost, TemplateCopyTabs,
    TemplateCopyTabsHost,
};
use tauri::Manager;

use super::{NOT_BUILT, Unbuilt, now_ms, unbuilt};
use crate::host::HostContext;

pub(super) fn install(hosts: &mut Hosts, cx: &HostContext) {
    let layout = Layout {
        resources: cx.app.path().resource_dir().ok(),
        repo: repo_root(),
    };
    let agent_skills: AgentSkillsHost = Arc::new(ShellAgentSkills {
        layout: layout.clone(),
    });
    hosts.insert(agent_skills);
    hosts.insert(shell_ipc_a::integrations::factory());

    let importer: SkillImporterHost = Arc::new(Unbuilt);
    hosts.insert(importer);
    let skills_shell: SkillsShellHost = Arc::new(ShellSkills { layout });
    hosts.insert(skills_shell);
    let tabs: TemplateCopyTabsHost = Arc::new(Unbuilt);
    hosts.insert(tabs);
    hosts.insert(shell_ipc_a::user_skills::factory());
    hosts.insert(shell_ipc_a::user_skills::template_tabs_factory());
}

/// The apps folder, as `app_scheme.rs` finds it: `SEUOFFICE_APPS_DIR`, else
/// the checkout the shell was built from
fn apps_dir() -> PathBuf {
    std::env::var_os("SEUOFFICE_APPS_DIR").map_or_else(
        || PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../apps")),
        PathBuf::from,
    )
}

/// `APPS_ROOT/..` of the Electron build
fn repo_root() -> PathBuf {
    apps_dir().join("..")
}

#[derive(Clone)]
struct Layout {
    resources: Option<PathBuf>,
    repo: PathBuf,
}

impl Layout {
    /// `<resources>/<name>` when the shell is packaged (the folder is there)
    fn packaged(&self, name: &str) -> Option<PathBuf> {
        self.resources
            .as_ref()
            .map(|resources| resources.join(name))
            .filter(|dir| dir.is_dir())
    }

    fn text(path: PathBuf) -> String {
        path.to_string_lossy().into_owned()
    }
}

// ---- Settings > Integrations ----

struct ShellAgentSkills {
    layout: Layout,
}

fn env_of(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn home() -> String {
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .to_string_lossy()
        .into_owned()
}

fn target_of(target: skills::AgentTarget) -> AgentTarget {
    AgentTarget {
        id: target.id,
        label: target.label,
        skills_dir: target.skills_dir,
        legacy: target.legacy.unwrap_or(false),
    }
}

fn bundled_of(bundled: &BundledSkill) -> skills::BundledSkill {
    skills::BundledSkill {
        bytes: bundled.bytes.clone(),
        text: bundled.text.clone(),
        version: bundled.version.clone(),
        sha256: bundled.sha256.clone(),
    }
}

impl AgentSkills for ShellAgentSkills {
    fn cli_dir(&self) -> String {
        Layout::text(match self.layout.packaged("cli") {
            Some(cli) => cli,
            None => self.layout.repo.join("packages/cli/bin"),
        })
    }

    fn skill_path(&self) -> String {
        Layout::text(match self.layout.packaged("cli") {
            Some(cli) => cli.join("skills/seuoffice/SKILL.md"),
            None => self.layout.repo.join("skills/seuoffice/SKILL.md"),
        })
    }

    fn cli_package_json(&self) -> String {
        Layout::text(match self.layout.packaged("cli") {
            Some(cli) => cli.join("package.json"),
            None => self.layout.repo.join("packages/cli/package.json"),
        })
    }

    fn is_packaged(&self) -> bool {
        self.layout.packaged("cli").is_some()
    }

    fn resources_path(&self) -> String {
        self.layout
            .resources
            .as_ref()
            .map_or_else(String::new, |dir| dir.to_string_lossy().into_owned())
    }

    fn env(&self, name: &str) -> Option<String> {
        env_of(name)
    }

    fn platform(&self) -> String {
        shell_ipc_a::secrets::PLATFORM.to_owned()
    }

    fn bundled_skill_from(&self, bytes: Vec<u8>) -> BundledSkill {
        let bundled = skills::bundled_skill_from(&bytes);
        BundledSkill {
            bytes: bundled.bytes,
            text: bundled.text,
            version: bundled.version,
            sha256: bundled.sha256,
        }
    }

    fn detect_agents(&self) -> Vec<AgentTarget> {
        skills::detect_agents(&env_of, &home())
            .into_iter()
            .map(target_of)
            .collect()
    }

    fn agent_target(&self, id: &str) -> Option<AgentTarget> {
        skills::agent_target(id, &env_of, &home()).map(target_of)
    }

    fn skill_rows(&self, ledger: &Ledger) -> Vec<AgentTarget> {
        skills::skill_rows(ledger, &env_of, &home())
            .into_iter()
            .map(target_of)
            .collect()
    }

    fn legacy_skill_copies(&self, ledger: &Ledger, only: &str) -> Vec<AgentTarget> {
        skills::legacy_skill_copies(ledger, &env_of, &home(), Some(only))
            .into_iter()
            .map(target_of)
            .collect()
    }

    fn skill_files_written(&self, skills_dir: &str, ledger: &Ledger) -> Vec<String> {
        skills::skill_files_written(skills_dir, ledger)
    }

    fn read_install_state(
        &self,
        skills_dir: &str,
        bundled: &BundledSkill,
        ledger: &Ledger,
    ) -> SkillInstallState {
        let state = skills::read_install_state(skills_dir, &bundled_of(bundled), ledger);
        // the status as the TypeScript spells it: its serde name
        let status = serde_json::to_value(state.status)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        SkillInstallState {
            status,
            path: state.path,
            installed_version: state.installed_version,
            older: state.older,
        }
    }

    fn install_skill(
        &self,
        skills_dir: &str,
        bundled: &BundledSkill,
        ledger: &mut Ledger,
    ) -> Result<String, String> {
        skills::install_skill(skills_dir, &bundled_of(bundled), ledger, None, now_ms())
            .map_err(|error| error.message)
    }

    fn uninstall_skill(&self, skills_dir: &str, ledger: &mut Ledger) -> bool {
        match skills::uninstall_skill(skills_dir, ledger) {
            Ok(removed) => removed,
            Err(error) => {
                eprintln!("shell: uninstalling the skill failed: {}", error.message);
                false
            }
        }
    }

    fn build_skill_zip(&self, bundled: &BundledSkill) -> Result<Vec<u8>, String> {
        skills::build_skill_zip(&bundled_of(bundled))
    }

    fn inspect_cli_link(&self, launcher: &str) -> JsonValue {
        let env: Env = &env_of;
        let outcome = inspect_cli_link(&InstallOptions {
            launcher,
            platform: shell_ipc_a::secrets::PLATFORM,
            candidate_dirs: None,
            env,
            run_power_shell: &run_power_shell,
        });
        match outcome.map(|outcome: InstallOutcome| serde_json::to_value(&outcome)) {
            Ok(Ok(value)) => json_value_from_serde(&value),
            // the link could not be read: what a person is told is that it is not usable
            _ => {
                let mut object = JsObject::new();
                object.set("status", JsonValue::String("unwritable".into()));
                JsonValue::Object(object)
            }
        }
    }
}

// ---- user skills ----

struct ShellSkills {
    layout: Layout,
}

impl SkillsShell for ShellSkills {
    fn builtin_skills_dir(&self) -> String {
        let packaged = self.layout.packaged("builtin-skills").is_some();
        let resources = self
            .layout
            .resources
            .as_ref()
            .map_or_else(String::new, |dir| dir.to_string_lossy().into_owned());
        // `app.getAppPath()` of an unpackaged run is the shell package folder
        let app_path = Layout::text(apps_dir().join("shell"));
        builtin_skills_dir_for(&BuiltinSkillsDirOptions {
            is_packaged: packaged,
            resources_path: &resources,
            app_path: &app_path,
        })
    }
}

fn not_built() -> Thrown {
    Thrown::Plain(NOT_BUILT.into())
}

impl SkillImporter for Unbuilt {
    fn prepare_skill_import(
        &self,
        _: &SkillImportSource,
        _: &PrepareEnv,
        _: Option<Aborted<'_>>,
    ) -> Result<SkillImport, Thrown> {
        unbuilt("SkillImporter::prepare_skill_import");
        Err(not_built())
    }

    fn install_imported_skills(
        &self,
        _: &SkillImport,
        _: &ImportOptions,
        _: Discard<'_>,
    ) -> Result<InstallImportedSkillsResult, Thrown> {
        unbuilt("SkillImporter::install_imported_skills");
        Err(not_built())
    }

    /// `disposeSkillImport(imported)`: the import's temporary folder goes
    fn dispose_skill_import(&self, imported: &SkillImport) {
        if let Some(dir) = &imported.temp_dir {
            remove_quietly(dir);
        }
    }

    fn check_github_skill_update(
        &self,
        _: &CheckUpdateOptions,
        _: Option<Aborted<'_>>,
    ) -> Result<GitHubSkillUpdateCheck, Thrown> {
        unbuilt("SkillImporter::check_github_skill_update");
        Err(not_built())
    }

    fn apply_github_skill_update(
        &self,
        _: &ChangedCheck,
        _: &ApplyUpdateOptions,
        _: Discard<'_>,
    ) -> Result<InstalledSkill, Thrown> {
        unbuilt("SkillImporter::apply_github_skill_update");
        Err(not_built())
    }

    fn export_skill_zip(&self, _: &str, _: &str) -> Result<(), Thrown> {
        unbuilt("SkillImporter::export_skill_zip");
        Err(not_built())
    }

    fn export_skill_bundle_zip(&self, _: &[String], _: &str) -> Result<(), Thrown> {
        unbuilt("SkillImporter::export_skill_bundle_zip");
        Err(not_built())
    }
}

impl TemplateCopyTabs for Unbuilt {
    fn open_template_copy(&self, _: &TemplateCopy) -> Result<Option<OpenedCopy>, String> {
        unbuilt("TemplateCopyTabs::open_template_copy");
        Err(NOT_BUILT.into())
    }

    fn opener_file_path(&self, _: ViewId) -> Option<String> {
        unbuilt("TemplateCopyTabs::opener_file_path");
        None
    }

    fn open_files(&self) -> Result<Vec<OpenFileState>, OpenFilesSourceFailed> {
        // no tab is open, so no document has unsaved changes
        unbuilt("TemplateCopyTabs::open_files");
        Ok(Vec::new())
    }

    fn focus_tab(&self, _: &str) -> bool {
        unbuilt("TemplateCopyTabs::focus_tab");
        false
    }

    fn follow_opener_project(&self, _: ViewId, _: ViewId) {
        unbuilt("TemplateCopyTabs::follow_opener_project");
    }
}
