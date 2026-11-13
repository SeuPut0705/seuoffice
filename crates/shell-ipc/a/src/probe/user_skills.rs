//! The probe fakes of the `user_skills` and `template_tabs` ports' batch hosts:
//! the import library the shell entry reaches through `@seuoffice/ai-provider`
//! ([`SkillImporter`]), the packaged app's folder ([`SkillsShell`]) and the tab
//! manager ([`TemplateCopyTabs`]), answering from the case's
//! `hosts.a.userSkills`. `groups/a/user-skills.ts` and
//! `groups/a/template-tabs.ts` are the same table in JavaScript.
//!
//! | key          | shape                                                                                                                 |
//! | ------------ | --------------------------------------------------------------------------------------------------------------------- |
//! | `appPath`    | `app.getAppPath()`; the builtin skills folder is `<appPath>/resources/builtin-skills` (default `$DIR/app`)              |
//! | `prepare`    | `{"<folder, zip, skill-file, text, github>": spec}`: what `prepareSkillImport` finds; absent: one skill `demo`          |
//! | `install`    | `{throw, importError, skipped: [key]}`: `installImportedSkills` (installs the selected keys)                          |
//! | `check`      | `{throw, importError, upToDate: {commit, locallyEdited}, changed: {commit, locallyEdited, changedFiles, update}}`|
//! | `apply`      | `{throw, importError, name}`: `applyGitHubSkillUpdate`                                                                |
//! | `exportError`| both zip writers reject with this message                                                                             |
//! | `copyTabs`   | `{open: {tabId, view, ownsCopy} or null, files: {"<view>": path}, openFiles: [{path, dirty}] or "fail", focusable: [tabId]}` |
//!
//! A `spec` is `{throw: message}` (a plain `Error`), `{importError: kind}` (a
//! `SkillImportError`) or what it found:
//! `{origin?, candidates?: [{key, name, title?, description?, collision?,
//! problem?, hasScripts?, emptyBody?}], rootLicense?}`. A found import is a
//! folder `<temp>/seuoffice-skills/import-<n>` with one `SKILL.md` per
//! candidate (`name`, `description`, the body `Body of <name>`).
//!
//! One log line per call, named after the function it stands for.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use jscompat::node_path::host::join;
use main_core::packages::ai_provider::user_skills_import::{
    ChangedCheck, GitHubSkillUpdateCheck, IeumSourceRecord, InstallImportedSkillsResult,
    InstalledSkill, SkillFileChange, SkillImport, SkillImportCandidate, SkillImportError,
    SkillImportOrigin, SkillImportSource, Thrown,
};
use main_core::packages::electron_utils::unsaved_files::{OpenFileState, OpenFilesSourceFailed};
use main_core::shell::user_skills::builtin_dir::{BuiltinSkillsDirOptions, builtin_skills_dir_for};
use main_core::shell::user_skills::template_tabs::TemplateCopy;
use main_core::shell::user_skills::user_skills_service::{
    Aborted, ApplyUpdateOptions, CheckUpdateOptions, Discard, InstallOptions, PrepareEnv,
};
use serde_json::{Value, json};
use shell_contract::ViewId;

use super::{Log, push};
use crate::user_skills::{
    OpenedCopy, Pinned, SkillImporter, SkillImporterHost, SkillsShell, SkillsShellHost,
    TemplateCopyTabs, TemplateCopyTabsHost,
};

/// `Date.now()` of the case
const NOW: f64 = 1_700_000_000_000.0;

/// Inserts the factories of both ports and the fakes of their hosts,
/// answering from the case's `hosts.a` value; `log` is the case's host log
pub fn insert(hosts: &mut shell_contract::Hosts, case: &Value, log: Option<Log>) {
    hosts.insert(crate::user_skills::factory());
    hosts.insert(crate::user_skills::template_tabs_factory());
    hosts.insert(Pinned { now: NOW });
    let case = &case["userSkills"];
    let shell: SkillsShellHost = Arc::new(FakeShell(
        case["appPath"].as_str().unwrap_or("$DIR/app").to_owned(),
    ));
    hosts.insert(shell);
    let importer: SkillImporterHost = Arc::new(FakeImporter {
        case: case.clone(),
        log: log.clone(),
        stage: AtomicUsize::new(0),
    });
    hosts.insert(importer);
    let tabs: TemplateCopyTabsHost = Arc::new(FakeTabs {
        case: case["copyTabs"].clone(),
        log,
    });
    hosts.insert(tabs);
}

struct FakeShell(String);

impl SkillsShell for FakeShell {
    /// `builtinSkillsDirFor` over an unpackaged app at `appPath`
    fn builtin_skills_dir(&self) -> String {
        builtin_skills_dir_for(&BuiltinSkillsDirOptions {
            is_packaged: false,
            resources_path: "",
            app_path: &self.0,
        })
    }
}

fn text(value: &Value, fallback: &str) -> String {
    value.as_str().unwrap_or(fallback).to_owned()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// the kinds a case may reject with (`SkillImportError.kind` is a static name)
fn kind_of(kind: &str) -> &'static str {
    [
        "bad-address",
        "not-found",
        "rate-limited",
        "network",
        "too-large",
        "unsafe",
        "no-skills",
        "cancelled",
        "needs-choice",
        "not-installable",
        "invalid-source",
        "not-github",
        "trash-failed",
        "failed",
    ]
    .into_iter()
    .find(|known| *known == kind)
    .unwrap_or("failed")
}

fn problem_of(problem: &str) -> &'static str {
    ["too-large", "unreadable", "duplicate"]
        .into_iter()
        .find(|known| *known == problem)
        .unwrap_or("unreadable")
}

struct FakeImporter {
    case: Value,
    log: Option<Log>,
    /// the import folders made so far
    stage: AtomicUsize,
}

fn source_json(source: &SkillImportSource) -> Value {
    match source {
        SkillImportSource::Folder { folder } => json!({"kind": "folder", "folder": folder}),
        SkillImportSource::Zip { file } => json!({"kind": "zip", "file": file}),
        SkillImportSource::SkillFile { file } => json!({"kind": "skill-file", "file": file}),
        SkillImportSource::Text { text } => json!({"kind": "text", "text": text}),
        SkillImportSource::Github { address } => json!({"kind": "github", "address": address}),
    }
}

fn kind_name(origin: &SkillImportOrigin) -> &'static str {
    match origin {
        SkillImportOrigin::Folder { .. } => "folder",
        SkillImportOrigin::Zip { .. } => "zip",
        SkillImportOrigin::SkillFile { .. } => "skill-file",
        SkillImportOrigin::Text => "text",
        SkillImportOrigin::Github { .. } => "github",
    }
}

/// the failure a spec asks for, if any
fn failure_of(spec: &Value) -> Option<Thrown> {
    if let Some(message) = spec["throw"].as_str() {
        return Some(Thrown::Plain(message.to_owned()));
    }
    spec["importError"]
        .as_str()
        .map(|kind| Thrown::Import(SkillImportError::new(kind_of(kind), "import failed")))
}

impl FakeImporter {
    fn log(&self, line: Value) {
        push(&self.log, line);
    }

    /// the import a spec found, made on disk under `temp_dir`
    fn found(&self, spec: &Value, origin: SkillImportOrigin, temp_dir: &str) -> SkillImport {
        let n = self.stage.fetch_add(1, Ordering::SeqCst) + 1;
        let root = join(&[temp_dir, &format!("import-{n}")]);
        let listed = spec["candidates"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![json!({"key": ".", "name": "demo"})]);
        let mut candidates = Vec::new();
        for item in &listed {
            let key = text(&item["key"], ".");
            let name = text(&item["name"], "demo");
            let title = text(&item["title"], &name);
            let description = text(&item["description"], &format!("About {name}"));
            let dir = if key == "." {
                root.clone()
            } else {
                join(&[&root, &key])
            };
            let skill_md =
                format!("---\nname: {name}\ndescription: {description}\n---\nBody of {name}\n");
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(join(&[&dir, "SKILL.md"]), &skill_md);
            candidates.push(SkillImportCandidate {
                rel: if key == "." {
                    String::new()
                } else {
                    key.clone()
                },
                key,
                dir,
                name,
                title,
                description,
                files: 1,
                bytes: skill_md.len() as u64,
                has_scripts: item["hasScripts"].as_bool().unwrap_or(false),
                has_template: false,
                urls: Vec::new(),
                url_count: 0,
                license: None,
                warnings: Vec::new(),
                warning_count: 0,
                collision: item["collision"].as_bool().unwrap_or(false),
                empty_body: item["emptyBody"].as_bool().unwrap_or(false),
                problem: item["problem"].as_str().map(problem_of),
            });
        }
        SkillImport {
            origin,
            root,
            candidates,
            root_license: spec["rootLicense"].as_str().map(str::to_owned),
            temp_dir: None,
        }
    }
}

const REPO: (&str, &str, &str) = ("o/r", "main", "");

fn github_origin(commit: &str) -> SkillImportOrigin {
    SkillImportOrigin::Github {
        repo: REPO.0.into(),
        ref_: REPO.1.into(),
        commit: commit.into(),
        path: REPO.2.into(),
    }
}

fn record(commit: &str) -> IeumSourceRecord {
    IeumSourceRecord {
        repo: REPO.0.into(),
        ref_: REPO.1.into(),
        path: REPO.2.into(),
        commit: commit.into(),
        installed_at: "2026-01-01T00:00:00Z".into(),
        content_hash: "h".into(),
    }
}

impl SkillImporter for FakeImporter {
    fn prepare_skill_import(
        &self,
        source: &SkillImportSource,
        env: &PrepareEnv,
        _aborted: Option<Aborted<'_>>,
    ) -> Result<SkillImport, Thrown> {
        self.log(json!([
            "skills.prepareSkillImport",
            source_json(source),
            env.app_skills_dir
        ]));
        let kind = source_json(source)["kind"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let spec = &self.case["prepare"][&kind];
        if let Some(thrown) = failure_of(spec) {
            return Err(thrown);
        }
        let origin = match source {
            SkillImportSource::Folder { folder } => SkillImportOrigin::Folder {
                folder: folder.clone(),
            },
            SkillImportSource::Zip { file } => SkillImportOrigin::Zip { file: file.clone() },
            SkillImportSource::SkillFile { file } => {
                SkillImportOrigin::SkillFile { file: file.clone() }
            }
            SkillImportSource::Text { .. } => SkillImportOrigin::Text,
            SkillImportSource::Github { .. } => github_origin("c1"),
        };
        Ok(self.found(spec, origin, &env.temp_dir))
    }

    fn install_imported_skills(
        &self,
        imported: &SkillImport,
        options: &InstallOptions,
        _discard: Discard<'_>,
    ) -> Result<InstallImportedSkillsResult, Thrown> {
        let choices: serde_json::Map<String, Value> = options
            .on_collision
            .iter()
            .map(|(key, choice)| (key.clone(), json!(choice)))
            .collect();
        self.log(json!([
            "skills.installImportedSkills",
            options.selected,
            choices
        ]));
        let spec = &self.case["install"];
        if let Some(thrown) = failure_of(spec) {
            return Err(thrown);
        }
        let installed = imported
            .candidates
            .iter()
            .filter(|candidate| options.selected.contains(&candidate.key))
            .map(|candidate| InstalledSkill {
                key: candidate.key.clone(),
                name: candidate.name.clone(),
                dir: join(&[&options.app_skills_dir, &candidate.name]),
                replaced: false,
            })
            .collect();
        let skipped = spec["skipped"]
            .as_array()
            .map(|keys| {
                keys.iter()
                    .filter_map(|key| key.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        Ok(InstallImportedSkillsResult { installed, skipped })
    }

    fn dispose_skill_import(&self, imported: &SkillImport) {
        let keys: Vec<&str> = imported.candidates.iter().map(|c| c.key.as_str()).collect();
        self.log(json!([
            "skills.disposeSkillImport",
            kind_name(&imported.origin),
            keys
        ]));
        let _ = std::fs::remove_dir_all(&imported.root);
    }

    fn check_github_skill_update(
        &self,
        options: &CheckUpdateOptions,
        _aborted: Option<Aborted<'_>>,
    ) -> Result<GitHubSkillUpdateCheck, Thrown> {
        self.log(json!(["skills.checkGitHubSkillUpdate", options.skill_dir]));
        let spec = &self.case["check"];
        if let Some(thrown) = failure_of(spec) {
            return Err(thrown);
        }
        if spec["changed"].is_object() {
            let changed = &spec["changed"];
            let commit = text(&changed["commit"], "c2");
            let files = changed["changedFiles"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .map(|item| SkillFileChange {
                            rel: text(&item["rel"], ""),
                            change: match item["change"].as_str() {
                                Some("added") => "added",
                                Some("removed") => "removed",
                                _ => "modified",
                            },
                        })
                        .collect()
                })
                .unwrap_or_default();
            let update = self.found(
                &changed["update"],
                github_origin(&commit),
                &options.temp_dir,
            );
            return Ok(GitHubSkillUpdateCheck::Changed(Box::new(ChangedCheck {
                record: record(&commit),
                commit,
                locally_edited: changed["locallyEdited"].as_bool().unwrap_or(false),
                changed_files: files,
                update,
            })));
        }
        let current = &spec["upToDate"];
        let commit = text(&current["commit"], "c1");
        Ok(GitHubSkillUpdateCheck::UpToDate {
            record: record(&commit),
            commit,
            locally_edited: current["locallyEdited"].as_bool().unwrap_or(false),
        })
    }

    fn apply_github_skill_update(
        &self,
        check: &ChangedCheck,
        options: &ApplyUpdateOptions,
        _discard: Discard<'_>,
    ) -> Result<InstalledSkill, Thrown> {
        self.log(json!([
            "skills.applyGitHubSkillUpdate",
            options.skill_dir,
            check.commit
        ]));
        let spec = &self.case["apply"];
        if let Some(thrown) = failure_of(spec) {
            return Err(thrown);
        }
        let name = match spec["name"].as_str() {
            Some(name) => name.to_owned(),
            None => options
                .skill_dir
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_owned(),
        };
        Ok(InstalledSkill {
            key: ".".into(),
            name,
            dir: options.skill_dir.clone(),
            replaced: true,
        })
    }

    fn export_skill_zip(&self, skill_dir: &str, out_path: &str) -> Result<(), Thrown> {
        self.log(json!(["skills.exportSkillZip", skill_dir, out_path]));
        self.write_zip(out_path, &[skill_dir.to_owned()])
    }

    fn export_skill_bundle_zip(&self, skill_dirs: &[String], out_path: &str) -> Result<(), Thrown> {
        self.log(json!(["skills.exportSkillBundleZip", skill_dirs, out_path]));
        self.write_zip(out_path, skill_dirs)
    }
}

impl FakeImporter {
    /// the zip the case's writer makes: `zip:` and the folders, one per line
    fn write_zip(&self, out_path: &str, dirs: &[String]) -> Result<(), Thrown> {
        if let Some(message) = self.case["exportError"].as_str() {
            return Err(Thrown::Plain(message.to_owned()));
        }
        std::fs::write(out_path, format!("zip:{}", dirs.join("\n")))
            .map_err(|error| Thrown::Plain(error.to_string()))
    }
}

struct FakeTabs {
    case: Value,
    log: Option<Log>,
}

impl TemplateCopyTabs for FakeTabs {
    fn open_template_copy(&self, copy: &TemplateCopy) -> Result<Option<OpenedCopy>, String> {
        push(
            &self.log,
            json!([
                "templateTabs.openCopy",
                {
                    "editor": copy.editor.as_str(),
                    "path": copy.path,
                    "dir": copy.dir,
                    "bytes": hex(&copy.bytes),
                    "fileName": copy.file_name,
                    "title": copy.title,
                }
            ]),
        );
        let open = &self.case["open"];
        if open.is_null() && self.case.get("open").is_some() {
            return Ok(None);
        }
        if let Some(message) = open["throw"].as_str() {
            return Err(message.to_owned());
        }
        Ok(Some(OpenedCopy {
            tab_id: text(&open["tabId"], "tab-1"),
            view: ViewId(open["view"].as_u64().unwrap_or(4) as u32),
            owns_copy: open["ownsCopy"].as_bool().unwrap_or(false),
        }))
    }

    fn opener_file_path(&self, opener: ViewId) -> Option<String> {
        push(
            &self.log,
            json!(["tabManager.describeWebContents", opener.0]),
        );
        self.case["files"][opener.0.to_string()]
            .as_str()
            .map(str::to_owned)
    }

    fn open_files(&self) -> Result<Vec<OpenFileState>, OpenFilesSourceFailed> {
        push(&self.log, json!(["fileHasUnsavedChanges"]));
        if self.case["openFiles"].as_str() == Some("fail") {
            return Err(OpenFilesSourceFailed);
        }
        Ok(self.case["openFiles"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|item| OpenFileState {
                        file_path: item["path"].as_str().map(str::to_owned),
                        dirty: item["dirty"].as_bool().unwrap_or(false),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    fn focus_tab(&self, tab_id: &str) -> bool {
        let found = self.case["focusable"]
            .as_array()
            .is_some_and(|tabs| tabs.iter().any(|tab| tab.as_str() == Some(tab_id)));
        if found {
            push(&self.log, json!(["tabManager.activateTab", tab_id]));
        }
        found
    }

    fn follow_opener_project(&self, copy: ViewId, opener: ViewId) {
        push(&self.log, json!(["followOpenerProject", copy.0, opener.0]));
    }
}
