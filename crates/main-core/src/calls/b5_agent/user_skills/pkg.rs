//! The package half of part user-skills (tools/main-diff/groups/b5-agent-user-skills-pkg.ts):
//! `packages/ai-provider/src/user-skills/*` and the skill-editor scope, named
//! `ai-provider/user-skills/<ts-file>.<export>`. `undefined` crosses as JSON
//! `null` in an argument list, so a `null` argument reads as `undefined`.

use jscompat::{JsObject, JsonValue, json_value_to_serde};
use serde_json::{Map, Value, json};

use super::{
    Answer, CallError, Context, arg, bool_of, js_of, list_of, number_of, str_of, string_list,
    thrown_error, unreadable_reason,
};
use crate::packages::ai_provider::user_skill_md::{
    BUILTIN_SKILLS_MANIFEST, EditorsText, FieldValue, IEUM_EDITORS_KEY, IEUM_SOURCE_FILE,
    IEUM_TEMPLATE_KEY, IEUM_TITLE_KEY, MAX_USER_SKILL_BYTES, MAX_USER_SKILL_FILES,
    NEW_USER_SKILL_NAME_MAX, ParsedSkillMd, RESERVED_USER_SKILL_NAMES, SKILL_SCRIPT_EXTENSIONS,
    SKILL_SCRIPTS_FOLDER, SKILL_TEMPLATE_FOLDER, SKILL_TEXT_EXTENSIONS, SkillMdError, SkillMdInput,
    USER_SKILL_PRIORITY, codex_home_dir, is_inside_codex_home, is_inside_dir,
    is_reserved_user_skill_name, normalize_skill_template_path, parse_skill_md, render_skill_md,
    without_skill_editors,
};
use crate::packages::ai_provider::user_skills_folder::{
    SkillFolderLimits, is_skill_script_path, list_skill_folder_files, mcp_servers_of_skill_md,
    read_listed_skill_md, read_user_skill_folder, skill_bundle_file_name, skill_export_info,
};
use crate::packages::ai_provider::user_skills_import::{
    CommitSkillInstallOptions, DiscardFailed, IeumSourceRecord, SkillImportCandidate,
    SkillInstallPlan, SkillInstallSource, commit_skill_install, iso_seconds,
    read_ieum_source_record, render_ieum_source_record, skill_content_hash,
};
use crate::packages::ai_provider::user_skills_states::{
    ResolvedUserSkill, SKILL_EDITORS, SkillEditorsChoice, UserSkill, initial_user_skill_state,
    pick_enabled_user_skills, resolve_user_skill_states, skill_editor_scope,
    suggest_user_skill_name, user_skill_id, validate_new_user_skill_name,
};

fn range(error: SkillMdError) -> CallError {
    CallError::plain(error.0)
}

fn strings_value(values: &[String]) -> Value {
    Value::Array(values.iter().map(|v| Value::from(v.as_str())).collect())
}

fn object_of(entries: &JsObject<String>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries.entries() {
        map.insert(key.to_owned(), Value::from(value.as_str()));
    }
    Value::Object(map)
}

fn parsed_value(parsed: &ParsedSkillMd) -> Value {
    let mut map = Map::new();
    if let Some(name) = &parsed.name {
        map.insert("name".into(), Value::from(name.as_str()));
    }
    if let Some(description) = &parsed.description {
        map.insert("description".into(), Value::from(description.as_str()));
    }
    map.insert("metadata".into(), object_of(&parsed.metadata));
    map.insert("fields".into(), object_of(&parsed.fields));
    let mut lists = Map::new();
    for (key, list) in parsed.lists.entries() {
        lists.insert(key.to_owned(), strings_value(list));
    }
    map.insert("lists".into(), Value::Object(lists));
    map.insert("body".into(), Value::from(parsed.body.as_str()));
    Value::Object(map)
}

fn render_input(value: Option<&Value>) -> SkillMdInput {
    let get = |key: &str| value.and_then(|v| v.get(key));
    let text = |key: &str| get(key).and_then(Value::as_str).map(str::to_owned);
    let editors = match get("editors") {
        None => EditorsText::Keep,
        Some(Value::Null) => EditorsText::Remove,
        Some(Value::String(text)) => EditorsText::Set(text.clone()),
        Some(_) => EditorsText::Keep,
    };
    let mut fields = Vec::new();
    if let Some(Value::Object(map)) = get("fields") {
        for (key, value) in map {
            match value {
                Value::Bool(flag) => fields.push((key.clone(), FieldValue::Bool(*flag))),
                Value::String(text) => fields.push((key.clone(), FieldValue::Text(text.clone()))),
                _ => {}
            }
        }
    }
    SkillMdInput {
        name: text("name").unwrap_or_default(),
        description: text("description").unwrap_or_default(),
        title: text("title"),
        template: text("template"),
        editors,
        body: text("body").unwrap_or_default(),
        fields,
    }
}

/// `skillEditorsOf`-style ids: the known ones only, as the `&'static str` they name
fn known_ids(value: Option<&Value>) -> Vec<&'static str> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|id| SKILL_EDITORS.iter().copied().find(|known| *known == id))
        .collect()
}

fn editors_array(ids: &[&str]) -> Value {
    Value::Array(ids.iter().map(|id| Value::from(*id)).collect())
}

/// the JSON of a `UserSkill` read back
pub(super) fn user_skill_of(value: &Value) -> UserSkill {
    let text = |key: &str| str_of(value.get(key)).unwrap_or("").to_owned();
    let opt = |key: &str| str_of(value.get(key)).map(str::to_owned);
    let file_editors = match value.get("fileEditors") {
        Some(list @ Value::Array(_)) => Some(known_ids(Some(list))),
        _ => None,
    };
    UserSkill {
        id: text("id"),
        source: text("source"),
        plugin: opt("plugin"),
        name: text("name"),
        folder_name: text("folderName"),
        dir: text("dir"),
        title: text("title"),
        description: text("description"),
        template: opt("template"),
        template_exists: bool_of(value.get("templateExists")),
        has_scripts: bool_of(value.get("hasScripts")),
        mcp_servers: string_list(value.get("mcpServers")),
        github: bool_of(value.get("github")),
        agent_only: bool_of(value.get("agentOnly")),
        file_editors,
        files: number_of(value.get("files")) as usize,
        bytes: number_of(value.get("bytes")) as u64,
        unreadable: str_of(value.get("unreadable")).and_then(unreadable_reason),
    }
}

fn resolved_from(args: &[Value]) -> Vec<ResolvedUserSkill> {
    let skills: Vec<UserSkill> = list_of(arg(args, 0)).iter().map(user_skill_of).collect();
    let raw: Option<JsonValue> = arg(args, 1).filter(|value| !value.is_null()).map(js_of);
    resolve_user_skill_states(skills, raw.as_ref())
}

fn record_of(value: Option<&Value>) -> IeumSourceRecord {
    let text = |key: &str| value.and_then(|v| v.get(key)).and_then(Value::as_str);
    IeumSourceRecord {
        repo: text("repo").unwrap_or("").to_owned(),
        ref_: text("ref").unwrap_or("").to_owned(),
        path: text("path").unwrap_or("").to_owned(),
        commit: text("commit").unwrap_or("").to_owned(),
        installed_at: text("installedAt").unwrap_or("").to_owned(),
        content_hash: text("contentHash").unwrap_or("").to_owned(),
    }
}

fn candidate_of(dir: &str, folder_name: &str, name: &str) -> SkillImportCandidate {
    SkillImportCandidate {
        key: folder_name.to_owned(),
        rel: String::new(),
        dir: dir.to_owned(),
        name: name.to_owned(),
        title: folder_name.to_owned(),
        description: String::new(),
        files: 0,
        bytes: 0,
        has_scripts: false,
        has_template: false,
        urls: Vec::new(),
        url_count: 0,
        license: None,
        warnings: Vec::new(),
        warning_count: 0,
        collision: false,
        empty_body: false,
        problem: None,
    }
}

fn commit(args: &[Value], cx: &mut Context) -> Answer {
    let app_skills_dir = super::str_arg(args, 0)?;
    let spec = arg(args, 1);
    let mut plans = Vec::new();
    for plan in list_of(spec.and_then(|s| s.get("plans"))) {
        let folder_name = str_of(plan.get("folderName")).unwrap_or("");
        let name = str_of(plan.get("name")).unwrap_or(folder_name);
        let source = plan.get("source").filter(|s| s.is_object()).map(|source| {
            let text = |key: &str| str_of(source.get(key)).unwrap_or("").to_owned();
            SkillInstallSource {
                repo: text("repo"),
                ref_: text("ref"),
                path: text("path"),
                commit: text("commit"),
            }
        });
        plans.push(SkillInstallPlan {
            candidate: candidate_of(str_of(plan.get("dir")).unwrap_or(""), folder_name, name),
            folder_name: folder_name.to_owned(),
            replace_dirs: string_list(plan.get("replaceDirs")),
            source,
        });
    }
    let fails = string_list(spec.and_then(|s| s.get("discardFails")));
    let discards = bool_of(spec.and_then(|s| s.get("discard")));
    let now_ms = cx.now_ms;
    let logs = &mut cx.logs;
    let mut discard = |dir: &str| {
        logs.push(vec![Value::from("discard"), Value::from(dir)]);
        if fails.iter().any(|suffix| dir.ends_with(suffix.as_str())) {
            Err(DiscardFailed)
        } else {
            Ok(())
        }
    };
    let mut random = || "rnd".to_owned();
    let mut options = CommitSkillInstallOptions {
        now_ms,
        discard_replaced: if discards { Some(&mut discard) } else { None },
        limits: None,
        random: Some(&mut random),
    };
    match commit_skill_install(app_skills_dir, &plans, &mut options) {
        Ok(dirs) => Ok(Some(strings_value(&dirs))),
        Err(error) => Err(thrown_error(&error)),
    }
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let name = name.strip_prefix("ai-provider/user-skills/")?;
    Some(match name {
        "constants.values" => Ok(Some(json!({
            "NEW_USER_SKILL_NAME_MAX": NEW_USER_SKILL_NAME_MAX,
            "MAX_USER_SKILL_BYTES": MAX_USER_SKILL_BYTES,
            "MAX_USER_SKILL_FILES": MAX_USER_SKILL_FILES,
            "RESERVED": RESERVED_USER_SKILL_NAMES,
            "SKILL_SCRIPT_EXTENSIONS": SKILL_SCRIPT_EXTENSIONS,
            "SKILL_SCRIPTS_FOLDER": SKILL_SCRIPTS_FOLDER,
            "SKILL_TEXT_EXTENSIONS": SKILL_TEXT_EXTENSIONS,
            "IEUM_SOURCE_FILE": IEUM_SOURCE_FILE,
            "BUILTIN_SKILLS_MANIFEST": BUILTIN_SKILLS_MANIFEST,
            "SKILL_TEMPLATE_FOLDER": SKILL_TEMPLATE_FOLDER,
            "IEUM_TITLE_KEY": IEUM_TITLE_KEY,
            "IEUM_TEMPLATE_KEY": IEUM_TEMPLATE_KEY,
            "IEUM_EDITORS_KEY": IEUM_EDITORS_KEY,
            "USER_SKILL_PRIORITY": USER_SKILL_PRIORITY,
        }))),
        // ---- frontmatter.ts ----
        "frontmatter.parseSkillMd" => {
            super::str_arg(args, 0).and_then(|text| match parse_skill_md(text).map_err(range)? {
                Some(parsed) => Ok(Some(parsed_value(&parsed))),
                None => Ok(None),
            })
        }
        "frontmatter.renderSkillMd" => {
            let input = render_input(arg(args, 0));
            let base = str_of(arg(args, 1));
            render_skill_md(&input, base)
                .map(|text| Some(Value::from(text)))
                .map_err(range)
        }
        "frontmatter.withoutSkillEditors" => super::str_arg(args, 0).and_then(|text| {
            without_skill_editors(text)
                .map(|text| Some(Value::from(text)))
                .map_err(range)
        }),
        // ---- names.ts ----
        "names.isReservedUserSkillName" => {
            super::str_arg(args, 0).map(|name| Some(Value::Bool(is_reserved_user_skill_name(name))))
        }
        "names.validateNewUserSkillName" => {
            super::str_arg(args, 0).map(|name| validate_new_user_skill_name(name).map(Value::from))
        }
        "names.suggestUserSkillName" => super::str_arg(args, 0).map(|title| {
            let taken = string_list(arg(args, 1));
            let random_text = str_of(arg(args, 2)).unwrap_or("").to_owned();
            Some(Value::from(suggest_user_skill_name(
                title,
                &taken,
                &mut || random_text.clone(),
            )))
        }),
        "names.userSkillId" => super::str_arg(args, 0).and_then(|source| {
            let name = super::str_arg(args, 1)?;
            Ok(Some(Value::from(user_skill_id(
                source,
                name,
                str_of(arg(args, 2)),
            ))))
        }),
        // ---- folder.ts ----
        "folder.listSkillFolderFiles" => super::str_arg(args, 0).map(|dir| {
            let limits = arg(args, 1)
                .filter(|l| l.is_object())
                .map(|l| SkillFolderLimits {
                    files: number_of(l.get("files")) as usize,
                    bytes: number_of(l.get("bytes")) as u64,
                });
            list_skill_folder_files(dir, limits.as_ref()).map(|listed| {
                let files: Vec<Value> = listed
                    .files
                    .iter()
                    .map(|file| json!({"rel": file.rel, "path": file.path, "size": file.size}))
                    .collect();
                json!({"files": files, "bytes": listed.bytes, "tooLarge": listed.too_large})
            })
        }),
        "folder.isSkillScriptPath" => {
            super::str_arg(args, 0).map(|rel| Some(Value::Bool(is_skill_script_path(rel))))
        }
        "folder.normalizeSkillTemplatePath" => {
            Ok(normalize_skill_template_path(str_of(arg(args, 0))).map(Value::from))
        }
        "folder.isInsideDir" => super::str_arg(args, 0).and_then(|child| {
            let parent = super::str_arg(args, 1)?;
            Ok(Some(Value::Bool(is_inside_dir(child, parent))))
        }),
        "folder.readUserSkillFolder" => super::str_arg(args, 0).and_then(|dir| {
            let options = arg(args, 1);
            let source = str_of(options.and_then(|o| o.get("source"))).unwrap_or("app");
            let plugin = str_of(options.and_then(|o| o.get("plugin")));
            let agent_only: Option<Vec<String>> = options
                .and_then(|o| o.get("agentOnly"))
                .filter(|v| v.is_array())
                .map(|v| string_list(Some(v)));
            let skill = read_user_skill_folder(dir, source, plugin, agent_only.as_deref())
                .map_err(range)?;
            Ok(skill.map(|skill| json_value_to_serde(&skill.to_json())))
        }),
        "folder.readListedSkillMd" => {
            super::str_arg(args, 0).map(|dir| read_listed_skill_md(dir).map(Value::from))
        }
        "folder.mcpServersOfSkillMd" => super::str_arg(args, 0).and_then(|text| {
            Ok(Some(match parse_skill_md(text).map_err(range)? {
                Some(parsed) => strings_value(&mcp_servers_of_skill_md(&parsed)),
                None => Value::Null,
            }))
        }),
        "folder.skillContentHash" => super::str_arg(args, 0).and_then(|dir| {
            skill_content_hash(dir, None)
                .map(|hash| Some(Value::from(hash)))
                .map_err(|error| thrown_error(&error))
        }),
        // ---- sources.ts ----
        "sources.codexHomeDir" => {
            super::str_arg(args, 0).map(|home| Some(Value::from(codex_home_dir(home))))
        }
        "sources.isInsideCodexHome" => super::str_arg(args, 0).and_then(|path| {
            let home = super::str_arg(args, 1)?;
            Ok(Some(Value::Bool(is_inside_codex_home(path, home))))
        }),
        // ---- states.ts, skill-editors.ts ----
        "states.initialUserSkillState" => super::str_arg(args, 0).map(|source| {
            let (enabled, invoke) = initial_user_skill_state(source);
            Some(json!({"enabled": enabled, "invoke": invoke}))
        }),
        "skill-editors.skillEditorScope" => {
            let choice = match arg(args, 0) {
                Some(Value::String(text)) if text == "all" => Some(SkillEditorsChoice::All),
                Some(list @ Value::Array(_)) => {
                    Some(SkillEditorsChoice::Some(known_ids(Some(list))))
                }
                _ => None,
            };
            let from_file = match arg(args, 1) {
                Some(list @ Value::Array(_)) => Some(known_ids(Some(list))),
                _ => None,
            };
            Ok(skill_editor_scope(choice.as_ref(), from_file.as_deref())
                .map(|ids| editors_array(&ids)))
        }
        "states.resolveUserSkillStates" => {
            let resolved = resolved_from(args);
            Ok(Some(Value::Array(
                resolved
                    .iter()
                    .map(|skill| json_value_to_serde(&skill.to_json()))
                    .collect(),
            )))
        }
        "states.pickEnabledUserSkills" => {
            let resolved = resolved_from(args);
            let picked = pick_enabled_user_skills(&resolved);
            let chosen: Vec<Value> = picked
                .chosen
                .iter()
                .map(|index| Value::from(resolved[*index].id.as_str()))
                .collect();
            let shadowed: Vec<Value> = picked
                .shadowed
                .iter()
                .map(|(index, by)| json!({"id": resolved[*index].id, "by": by}))
                .collect();
            Ok(Some(json!({"chosen": chosen, "shadowed": shadowed})))
        }
        // ---- source-record.ts ----
        "source-record.isoSeconds" => iso_seconds(number_of(arg(args, 0)))
            .map(|text| Some(Value::from(text)))
            .map_err(range),
        "source-record.renderIeumSourceRecord" => Ok(Some(Value::from(render_ieum_source_record(
            &record_of(arg(args, 0)),
        )))),
        "source-record.readIeumSourceRecord" => super::str_arg(args, 0).map(|dir| {
            read_ieum_source_record(dir).map(|record| json_value_to_serde(&record.to_json()))
        }),
        // ---- export.ts ----
        "export.skillBundleFileName" => Ok(Some(Value::from(skill_bundle_file_name(str_of(arg(
            args, 0,
        )))))),
        "export.skillExportInfo" => super::str_arg(args, 0).and_then(|dir| {
            let info = skill_export_info(dir, None).map_err(|error| thrown_error(&error))?;
            Ok(Some(json!({
                "name": info.name,
                "fileName": info.file_name,
                "includesTemplate": info.includes_template,
                "files": info.files,
                "bytes": info.bytes,
            })))
        }),
        // ---- import.ts ----
        "import.commitSkillInstall" => commit(args, cx),
        _ => return None,
    })
}
