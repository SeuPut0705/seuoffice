//! The service scenario of part user-skills: `createUserSkillsService` with a
//! scripted library, and the fakes the IPC scenario shares (the service host
//! and the library).

use std::fs;

use jscompat::node_path::host::join;
use jscompat::{js_regex, json_value_to_serde};
use serde_json::{Map, Value, json};

use super::{
    Answer, Context, Log, arg, bool_of, changed_of, check_of, hex_bytes, import_of, js_of, kind_of,
    list_of, log_line, number_of, str_of, string_list, thrown_error, unreal,
};
use crate::packages::ai_provider::user_skills_import::{
    GitHubSkillUpdateCheck, InstallImportedSkillsResult, InstalledSkill, SkillImport,
    SkillImportError, SkillImportSource, Thrown, remove_quietly,
};
use crate::shell::user_skills::user_skills_service::{
    Aborted, ApplyUpdateOptions, CheckUpdateOptions, Discard, Failure, InstallOptions, PrepareEnv,
    SkillLibrary, UserSkillCardSaveInput, UserSkillSaveInput, UserSkillStatePatch, UserSkillsHost,
    UserSkillsService, import_preview_of,
};

/// the `answer(script)` of the TypeScript fake: the scripted value, or the
/// error it names, or the `Error` of a missing script
fn answer(script: Option<&Value>) -> Result<Value, Thrown> {
    match script {
        None => Err(Thrown::Plain("no script".to_owned())),
        Some(value) => match value.get("throw").and_then(Value::as_str) {
            Some(kind) => Err(Thrown::Import(SkillImportError::new(
                kind_of(kind),
                "scripted",
            ))),
            None => Ok(value.clone()),
        },
    }
}

/// the host of the service: the folders of the case, a trash that logs
pub(super) struct SvcHost {
    pub root: String,
    pub builtin: bool,
    pub log: Log,
    pub trash_fails: Vec<String>,
    pub now_ms: f64,
}

impl UserSkillsHost for SvcHost {
    fn home_dir(&self) -> String {
        join(&[&self.root, "home"])
    }

    fn builtin_dir(&self) -> Option<String> {
        self.builtin.then(|| join(&[&self.root, "builtin"]))
    }

    fn settings_path(&self) -> String {
        join(&[&self.root, "settings.json"])
    }

    fn temp_dir(&self) -> String {
        join(&[&self.root, "tmp"])
    }

    fn trash(&mut self, path: &str) -> Result<(), ()> {
        // the staging folder of an install is named by chance
        let shown = js_regex!(r"\.ieum-staging-[0-9a-f]{12}")
            .replace_all(path, |_| ".ieum-staging-RND".to_owned());
        log_line(&self.log, vec![Value::from("trash"), Value::from(shown)]);
        if self
            .trash_fails
            .iter()
            .any(|suffix| path.ends_with(suffix.as_str()))
        {
            return Err(());
        }
        remove_quietly(path);
        Ok(())
    }

    fn now_ms(&self) -> f64 {
        self.now_ms
    }
}

/// the scripted library: each call is one log line, as the TypeScript fake writes it
pub(super) struct ScriptLib {
    pub script: Value,
    pub log: Log,
}

impl ScriptLib {
    fn discards(&self, discard: Discard<'_>) {
        for dir in string_list(self.script.get("discard")) {
            let worked = discard(&dir).is_ok();
            log_line(
                &self.log,
                vec![
                    Value::from("discard"),
                    Value::from(dir),
                    Value::Bool(worked),
                ],
            );
        }
        // the files the library would have written where it replaced a skill
        for written in list_of(self.script.get("write")) {
            if let (Some(path), Some(body)) =
                (str_of(written.get("path")), str_of(written.get("text")))
            {
                let _ = fs::write(path, body);
            }
        }
    }
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

fn installed_of(value: &Value) -> InstalledSkill {
    let text = |key: &str| str_of(value.get(key)).unwrap_or("").to_owned();
    InstalledSkill {
        key: text("key"),
        name: text("name"),
        dir: text("dir"),
        replaced: bool_of(value.get("replaced")),
    }
}

impl SkillLibrary for ScriptLib {
    fn prepare_skill_import(
        &mut self,
        source: &SkillImportSource,
        env: &PrepareEnv,
        aborted: Option<Aborted<'_>>,
    ) -> Result<SkillImport, Thrown> {
        log_line(
            &self.log,
            vec![
                Value::from("prepareSkillImport"),
                source_json(source),
                json!({
                    "appSkillsDir": env.app_skills_dir,
                    "homeDir": env.home_dir,
                    "tempDir": env.temp_dir,
                    "signal": aborted.is_some(),
                }),
            ],
        );
        Ok(import_of(&answer(self.script.get("prepare"))?))
    }

    fn install_imported_skills(
        &mut self,
        imported: &SkillImport,
        options: &InstallOptions,
        discard: Discard<'_>,
    ) -> Result<InstallImportedSkillsResult, Thrown> {
        let keys: Vec<&str> = imported.candidates.iter().map(|c| c.key.as_str()).collect();
        let mut collisions = Map::new();
        for (key, choice) in &options.on_collision {
            collisions.insert(key.clone(), Value::from(choice.as_str()));
        }
        log_line(
            &self.log,
            vec![
                Value::from("installImportedSkills"),
                json!(keys),
                json!({
                    "appSkillsDir": options.app_skills_dir,
                    "selected": options.selected,
                    "onCollision": Value::Object(collisions),
                }),
            ],
        );
        self.discards(discard);
        let done = answer(self.script.get("install"))?;
        Ok(InstallImportedSkillsResult {
            installed: list_of(done.get("installed"))
                .iter()
                .map(installed_of)
                .collect(),
            skipped: string_list(done.get("skipped")),
        })
    }

    fn dispose_skill_import(&mut self, imported: &SkillImport) {
        log_line(
            &self.log,
            vec![
                Value::from("disposeSkillImport"),
                imported
                    .temp_dir
                    .as_deref()
                    .map_or(Value::Null, Value::from),
            ],
        );
        if let Some(temp_dir) = &imported.temp_dir {
            remove_quietly(temp_dir);
        }
    }

    fn check_github_skill_update(
        &mut self,
        options: &CheckUpdateOptions,
        aborted: Option<Aborted<'_>>,
    ) -> Result<GitHubSkillUpdateCheck, Thrown> {
        log_line(
            &self.log,
            vec![
                Value::from("checkGitHubSkillUpdate"),
                json!({
                    "skillDir": options.skill_dir,
                    "appSkillsDir": options.app_skills_dir,
                    "tempDir": options.temp_dir,
                    "signal": aborted.is_some(),
                }),
            ],
        );
        Ok(check_of(&answer(self.script.get("check"))?))
    }

    fn apply_github_skill_update(
        &mut self,
        check: &crate::packages::ai_provider::user_skills_import::ChangedCheck,
        options: &ApplyUpdateOptions,
        discard: Discard<'_>,
    ) -> Result<InstalledSkill, Thrown> {
        log_line(
            &self.log,
            vec![
                Value::from("applyGitHubSkillUpdate"),
                Value::from(check.commit.as_str()),
                json!({"skillDir": options.skill_dir, "appSkillsDir": options.app_skills_dir}),
            ],
        );
        self.discards(discard);
        Ok(installed_of(&answer(self.script.get("apply"))?))
    }

    fn export_skill_zip(&mut self, skill_dir: &str, out_path: &str) -> Result<(), Thrown> {
        log_line(
            &self.log,
            vec![
                Value::from("exportSkillZip"),
                Value::from(skill_dir),
                Value::from(out_path),
            ],
        );
        answer(Some(self.script.get("exportZip").unwrap_or(&json!({})))).map(|_| ())
    }

    fn export_skill_bundle_zip(
        &mut self,
        skill_dirs: &[String],
        out_path: &str,
    ) -> Result<(), Thrown> {
        log_line(
            &self.log,
            vec![
                Value::from("exportSkillBundleZip"),
                json!(skill_dirs),
                Value::from(out_path),
            ],
        );
        answer(Some(self.script.get("exportZip").unwrap_or(&json!({})))).map(|_| ())
    }
}

/// the Claude plugin list a case writes before the service reads it
pub(super) fn write_plugins(opts: &Value, root: &str) {
    if let Some(plugins) = opts.get("plugins") {
        let dir = join(&[root, "home", ".claude", "plugins"]);
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(
            join(&[&dir, "installed_plugins.json"]),
            serde_json::to_string(plugins).expect("a value prints"),
        );
    }
}

pub(super) type Service = UserSkillsService<SvcHost, ScriptLib>;

/// the service of a scenario's options
pub(super) fn service_of(opts: &Value, log: &Log, now_ms: f64) -> Service {
    let root = str_of(opts.get("root")).unwrap_or("").to_owned();
    write_plugins(opts, &root);
    let host = SvcHost {
        root,
        builtin: bool_of(opts.get("builtin")),
        log: log.clone(),
        trash_fails: string_list(opts.get("trashFails")),
        now_ms,
    };
    let library = ScriptLib {
        script: opts.get("lib").cloned().unwrap_or_else(|| json!({})),
        log: log.clone(),
    };
    let ai_max = opts
        .get("aiMax")
        .map(|_| number_of(opts.get("aiMax")) as u64);
    UserSkillsService::new(host, library, ai_max)
}

fn ok_with(entries: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    object.insert("ok".into(), Value::Bool(true));
    for (key, value) in entries {
        object.insert(key.to_owned(), value);
    }
    Value::Object(object)
}

/// the answer of a method: its value shaped by `ok`, a failure as the object
/// it resolves with, a rejection as `{ threw }`
fn settled<T>(result: Result<T, Failure>, ok: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(value) => ok(value),
        Err(Failure::Fail(fail)) => json_value_to_serde(&fail.to_json()),
        Err(Failure::Thrown(thrown)) => json!({"threw": thrown_error(&thrown).message}),
    }
}

fn save_input(value: &Value) -> Option<UserSkillSaveInput> {
    UserSkillSaveInput::from_json(&js_of(value))
}

fn card_input(value: &Value) -> Option<UserSkillCardSaveInput> {
    let bytes = value
        .get("template")
        .and_then(|template| template.get("bytes"))
        .and_then(hex_bytes);
    UserSkillCardSaveInput::from_json(&js_of(value), bytes)
}

/// the `{ ok: true, ... }` of `checkUpdate`: the check with its new version as a preview
fn check_summary(check: &GitHubSkillUpdateCheck) -> Value {
    match check {
        GitHubSkillUpdateCheck::UpToDate {
            record,
            commit,
            locally_edited,
        } => ok_with(vec![(
            "check",
            json!({
                "status": "up-to-date",
                "record": json_value_to_serde(&record.to_json()),
                "commit": commit,
                "locallyEdited": locally_edited,
            }),
        )]),
        GitHubSkillUpdateCheck::Changed(changed) => {
            let files: Vec<Value> = changed
                .changed_files
                .iter()
                .map(|file| json!({"rel": file.rel, "change": file.change}))
                .collect();
            ok_with(vec![(
                "check",
                json!({
                    "status": "changed",
                    "record": json_value_to_serde(&changed.record.to_json()),
                    "commit": changed.commit,
                    "locallyEdited": changed.locally_edited,
                    "changedFiles": files,
                    "update": json_value_to_serde(&import_preview_of(&changed.update, "tok")),
                }),
            )])
        }
    }
}

/// one step of a service scenario
fn step(svc: &mut Service, step: &Value) -> Value {
    let method = str_of(step.get("m")).unwrap_or("");
    let a = list_of(step.get("a"));
    let text = |i: usize| str_of(a.get(i)).unwrap_or("");
    let nothing = |()| ok_with(Vec::new());
    let with_id = |id: String| ok_with(vec![("id", Value::from(id))]);
    match method {
        "list" => settled(svc.list(), |views| {
            Value::Array(views.iter().map(json_value_to_serde).collect())
        }),
        "read" => settled(svc.read(text(0)), |skill| {
            ok_with(vec![("skill", json_value_to_serde(&skill))])
        }),
        "setState" => {
            let patch = UserSkillStatePatch::from_json(&js_of(a.get(1).unwrap_or(&Value::Null)));
            settled(svc.set_state(text(0), &patch), nothing)
        }
        "hideBuiltin" => settled(svc.hide_builtin(text(0)), nothing),
        "unhideBuiltins" => {
            let names: Option<Vec<String>> = a
                .first()
                .filter(|names| names.is_array())
                .map(|names| string_list(Some(names)));
            settled(svc.unhide_builtins(names.as_deref()), nothing)
        }
        "remove" => settled(svc.remove(text(0)), nothing),
        "copyToMine" => settled(svc.copy_to_mine(text(0), bool_of(a.get(1))), with_id),
        "suggestName" => settled(svc.suggest_name(text(0)), Value::from),
        "checkName" => settled(
            svc.check_name(text(0), str_of(a.get(1))),
            |problem| match problem {
                None => ok_with(Vec::new()),
                Some(problem) => json!({"ok": false, "problem": problem}),
            },
        ),
        "save" => match a.first().and_then(save_input) {
            Some(input) => settled(svc.save(&input), with_id),
            None => json!({"threw": "bad step"}),
        },
        "saveFromCard" => match a.first().and_then(card_input) {
            Some(input) => settled(svc.save_from_card(&input), with_id),
            None => json!({"threw": "bad step"}),
        },
        "prepare" => {
            let source = a.first().map_or(Value::Null, Clone::clone);
            let source = match str_of(source.get("kind")) {
                Some("zip") => SkillImportSource::Zip {
                    file: str_of(source.get("file")).unwrap_or("").to_owned(),
                },
                Some("skill-file") => SkillImportSource::SkillFile {
                    file: str_of(source.get("file")).unwrap_or("").to_owned(),
                },
                Some("text") => SkillImportSource::Text {
                    text: str_of(source.get("text")).unwrap_or("").to_owned(),
                },
                Some("github") => SkillImportSource::Github {
                    address: str_of(source.get("address")).unwrap_or("").to_owned(),
                },
                _ => SkillImportSource::Folder {
                    folder: str_of(source.get("folder")).unwrap_or("").to_owned(),
                },
            };
            settled(svc.prepare(&source, None), |imported| {
                json_value_to_serde(&import_preview_of(&imported, "tok"))
            })
        }
        "dispose" => {
            svc.dispose(&import_of(a.first().unwrap_or(&Value::Null)));
            Value::Null
        }
        "install" => {
            let imported = import_of(a.first().unwrap_or(&Value::Null));
            let request = a.get(1);
            let selected = string_list(request.and_then(|r| r.get("selected")));
            let on_collision: Vec<(String, String)> = request
                .and_then(|r| r.get("onCollision"))
                .and_then(Value::as_object)
                .map(|choices| {
                    choices
                        .iter()
                        .filter_map(|(key, choice)| {
                            choice
                                .as_str()
                                .map(|choice| (key.clone(), choice.to_owned()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            settled(svc.install(&imported, &selected, &on_collision), |done| {
                let installed: Vec<Value> = done
                    .installed
                    .iter()
                    .map(|(key, id)| json!({"key": key, "id": id}))
                    .collect();
                ok_with(vec![
                    ("installed", Value::Array(installed)),
                    ("skipped", json!(done.skipped)),
                ])
            })
        }
        "readImported" => {
            let imported = import_of(a.first().unwrap_or(&Value::Null));
            settled(svc.read_imported(&imported, text(1)), |content| {
                ok_with(vec![("content", json_value_to_serde(&content))])
            })
        }
        "readImportedFile" => {
            let imported = import_of(a.first().unwrap_or(&Value::Null));
            settled(
                svc.read_imported_file(&imported, text(1), text(2)),
                |file| ok_with(vec![("file", json_value_to_serde(&file))]),
            )
        }
        "checkUpdate" => settled(svc.check_update(text(0), None), |check| {
            check_summary(&check)
        }),
        "applyUpdate" => {
            let check = changed_of(a.get(1).unwrap_or(&Value::Null));
            settled(svc.apply_update(text(0), &check), with_id)
        }
        "exportInfo" => settled(svc.export_info(text(0)), |info| {
            ok_with(vec![
                ("fileName", Value::from(info.file_name)),
                ("includesTemplate", Value::Bool(info.includes_template)),
            ])
        }),
        "exportTo" => settled(svc.export_to(text(0), text(1)), |path| {
            ok_with(vec![("path", Value::from(path))])
        }),
        "exportBundleTo" => {
            let ids = string_list(a.first());
            settled(svc.export_bundle_to(&ids, text(1)), |path| {
                ok_with(vec![("path", Value::from(path))])
            })
        }
        "folderOf" => settled(svc.folder_of(text(0)), |dir| {
            ok_with(vec![("dir", Value::from(dir))])
        }),
        "aiRead" => settled(svc.ai_read(text(0)), |skill| {
            ok_with(vec![("skill", json_value_to_serde(&skill))])
        }),
        "templateFile" => settled(svc.template_file(text(0)), |file| {
            ok_with(vec![
                ("path", Value::from(file.path)),
                ("fileName", Value::from(file.file_name)),
                ("title", Value::from(file.title)),
            ])
        }),
        "aiReadFile" => settled(svc.ai_read_file(text(0), text(1)), |body| {
            ok_with(vec![("text", Value::from(body))])
        }),
        "enabledForAgent" => settled(svc.enabled_for_agent(str_of(a.first())), |skills| {
            Value::Array(
                skills
                    .iter()
                    .map(|skill| {
                        let mut object = Map::new();
                        object.insert("id".into(), Value::from(skill.id.as_str()));
                        object.insert("source".into(), Value::from(skill.source.as_str()));
                        if let Some(plugin) = &skill.plugin {
                            object.insert("plugin".into(), Value::from(plugin.as_str()));
                        }
                        object.insert("name".into(), Value::from(skill.name.as_str()));
                        object.insert("title".into(), Value::from(skill.title.as_str()));
                        object.insert(
                            "description".into(),
                            Value::from(skill.description.as_str()),
                        );
                        object.insert("dir".into(), Value::from(skill.dir.as_str()));
                        object.insert("invoke".into(), Value::from(skill.invoke.as_str()));
                        object.insert("agentOnly".into(), Value::Bool(skill.agent_only));
                        Value::Object(object)
                    })
                    .collect(),
            )
        }),
        _ => json!({"threw": "no such method"}),
    }
}

pub(super) fn run(args: &[Value], cx: &mut Context) -> Answer {
    let opts = arg(args, 0).cloned().unwrap_or(Value::Null);
    let root = str_of(opts.get("root")).unwrap_or("").to_owned();
    let log: Log = Log::default();
    let mut svc = service_of(&opts, &log, cx.now_ms);
    let mut out: Vec<Value> = Vec::new();
    for entry in list_of(arg(args, 1)) {
        let answer = step(&mut svc, entry);
        out.push(unreal(answer, &root));
    }
    cx.logs.extend(log.borrow().iter().cloned());
    Ok(Some(Value::Array(out)))
}
