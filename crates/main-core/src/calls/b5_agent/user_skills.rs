//! The functions of group `b5-agent`, part user-skills
//! (tools/main-diff/groups/b5-agent-user-skills.ts and
//! b5-agent-user-skills-pkg.ts): the user-skills modules of
//! `apps/shell/src/main` and the package functions they call. What they call
//! is a fake the spec describes; each call of a fake is one `logs` line, and
//! the TypeScript writes the same lines. A scenario plays the part of the
//! adapter: it carries out what the Rust decides on the fakes.

mod ipc;
mod pkg;
mod service;
mod tabs;

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsonValue, js_regex, json_value_from_serde};
use serde_json::{Value, json};

use super::super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::ai_provider::user_skill_md::real_path;
use crate::packages::ai_provider::user_skills_import::{
    ChangedCheck, GitHubSkillUpdateCheck, IeumSourceRecord, SkillFileChange, SkillImport,
    SkillImportCandidate, SkillImportError, SkillImportOrigin, SkillWarning, Thrown,
};
use crate::shell::user_skills::builtin_dir::{BuiltinSkillsDirOptions, builtin_skills_dir_for};
use crate::shell::user_skills::template_tabs::copy_file_name_of;
use crate::shell::user_skills::user_skills_ipc::DROPPED_SKILLS_MAX;
use crate::shell::user_skills::user_skills_service::{
    AI_SKILL_FILE_MAX_BYTES, SKILL_TEMPLATE_MAX_BYTES, failure_of, import_preview_of,
    template_file_name_of,
};

/// the lines of every fake of a scenario, in the order they were called
pub(super) type Log = Rc<RefCell<Vec<Vec<Value>>>>;

pub(super) fn log_line(log: &Log, line: Vec<Value>) {
    log.borrow_mut().push(line);
}

/// a string of the spec; `null` reads as `undefined`
pub(super) fn str_of(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

pub(super) fn bool_of(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
}

pub(super) fn number_of(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(0.0)
}

pub(super) fn list_of(value: Option<&Value>) -> &[Value] {
    match value.and_then(Value::as_array) {
        Some(items) => items.as_slice(),
        None => &[],
    }
}

pub(super) fn string_list(value: Option<&Value>) -> Vec<String> {
    list_of(value)
        .iter()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect()
}

pub(super) fn js_of(value: &Value) -> JsonValue {
    json_value_from_serde(value)
}

/// the error a rejected function shows the comparison
pub(super) fn thrown_error(error: &Thrown) -> CallError {
    match error {
        Thrown::Import(error) => CallError::plain(error.message.clone()),
        Thrown::Range(error) => CallError::plain(error.0.clone()),
        Thrown::Node(error) => CallError {
            code: error.code.map(str::to_owned),
            message: error.message.clone(),
        },
        Thrown::Plain(message) => CallError::plain(message.clone()),
    }
}

/// `UserSkillUnreadableReason` named by a spec
pub(super) fn unreadable_reason(reason: &str) -> Option<&'static str> {
    ["no-frontmatter", "bad-name", "too-large", "unreadable"]
        .into_iter()
        .find(|known| *known == reason)
}

/// the `kind` of a `SkillImportError` named by a spec
pub(super) fn kind_of(kind: &str) -> &'static str {
    [
        "bad-address",
        "not-found",
        "rate-limited",
        "network",
        "too-large",
        "unsafe",
        "no-skills",
        "unclosed-frontmatter",
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

pub(super) fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `{ "hex": "..." }` of a spec: the bytes it stands for
pub(super) fn hex_bytes(value: &Value) -> Option<Vec<u8>> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    let hex = object.get("hex")?.as_str()?;
    (0..hex.len() / 2)
        .map(|at| u8::from_str_radix(hex.get(at * 2..at * 2 + 2)?, 16).ok())
        .collect()
}

/// `JSON.parse(JSON.stringify(value).split(realpath(root)).join(root)
/// .replace(RANDOM_NAME, '"skill-<random>"'))`
pub(super) fn unreal(value: Value, root: &str) -> Value {
    let real = real_path(root).unwrap_or_else(|| root.to_owned());
    let text = serde_json::to_string(&value).expect("a value prints");
    let random_name = js_regex!(r#""skill-[a-z0-9]{6}""#);
    let text = text.replace(&real, root);
    let text = random_name.replace_all(&text, |_| r#""skill-<random>""#.to_owned());
    serde_json::from_str(&text).expect("a value reads")
}

fn warning_of(value: &Value) -> SkillWarning {
    let text = |key: &str| str_of(value.get(key)).unwrap_or("").to_owned();
    SkillWarning {
        message_key: text("messageKey"),
        file: text("file"),
        line: number_of(value.get("line")),
        excerpt: text("excerpt"),
    }
}

fn problem_of(problem: &str) -> Option<&'static str> {
    [
        "no-frontmatter",
        "bad-name",
        "too-large",
        "unreadable",
        "duplicate",
    ]
    .into_iter()
    .find(|known| *known == problem)
}

fn candidate_of(value: &Value) -> SkillImportCandidate {
    let text = |key: &str| str_of(value.get(key)).unwrap_or("").to_owned();
    SkillImportCandidate {
        key: text("key"),
        rel: text("rel"),
        dir: text("dir"),
        name: text("name"),
        title: text("title"),
        description: text("description"),
        files: number_of(value.get("files")) as usize,
        bytes: number_of(value.get("bytes")) as u64,
        has_scripts: bool_of(value.get("hasScripts")),
        has_template: bool_of(value.get("hasTemplate")),
        urls: string_list(value.get("urls")),
        url_count: number_of(value.get("urlCount")) as usize,
        license: str_of(value.get("license")).map(str::to_owned),
        warnings: list_of(value.get("warnings"))
            .iter()
            .map(warning_of)
            .collect(),
        warning_count: number_of(value.get("warningCount")) as usize,
        collision: bool_of(value.get("collision")),
        empty_body: bool_of(value.get("emptyBody")),
        problem: str_of(value.get("problem")).and_then(problem_of),
    }
}

/// the `SkillImport` a spec describes
pub(super) fn import_of(value: &Value) -> SkillImport {
    let origin = value.get("origin");
    let field = |key: &str| {
        str_of(origin.and_then(|o| o.get(key)))
            .unwrap_or("")
            .to_owned()
    };
    let origin = match str_of(origin.and_then(|o| o.get("kind"))) {
        Some("zip") => SkillImportOrigin::Zip {
            file: field("file"),
        },
        Some("skill-file") => SkillImportOrigin::SkillFile {
            file: field("file"),
        },
        Some("text") => SkillImportOrigin::Text,
        Some("github") => SkillImportOrigin::Github {
            repo: field("repo"),
            ref_: field("ref"),
            commit: field("commit"),
            path: field("path"),
        },
        _ => SkillImportOrigin::Folder {
            folder: field("folder"),
        },
    };
    SkillImport {
        origin,
        root: str_of(value.get("root")).unwrap_or("").to_owned(),
        candidates: list_of(value.get("candidates"))
            .iter()
            .map(candidate_of)
            .collect(),
        root_license: str_of(value.get("rootLicense")).map(str::to_owned),
        temp_dir: str_of(value.get("tempDir")).map(str::to_owned),
    }
}

pub(super) fn record_of(value: Option<&Value>) -> IeumSourceRecord {
    let text = |key: &str| {
        str_of(value.and_then(|v| v.get(key)))
            .unwrap_or("")
            .to_owned()
    };
    IeumSourceRecord {
        repo: text("repo"),
        ref_: text("ref"),
        path: text("path"),
        commit: text("commit"),
        installed_at: text("installedAt"),
        content_hash: text("contentHash"),
    }
}

fn change_of(change: &str) -> &'static str {
    ["added", "removed"]
        .into_iter()
        .find(|known| *known == change)
        .unwrap_or("modified")
}

/// the `changed` check a spec describes
pub(super) fn changed_of(value: &Value) -> ChangedCheck {
    ChangedCheck {
        record: record_of(value.get("record")),
        commit: str_of(value.get("commit")).unwrap_or("").to_owned(),
        locally_edited: bool_of(value.get("locallyEdited")),
        changed_files: list_of(value.get("changedFiles"))
            .iter()
            .map(|file| SkillFileChange {
                rel: str_of(file.get("rel")).unwrap_or("").to_owned(),
                change: change_of(str_of(file.get("change")).unwrap_or("")),
            })
            .collect(),
        update: import_of(value.get("update").unwrap_or(&Value::Null)),
    }
}

/// a check as a spec scripts it
pub(super) fn check_of(value: &Value) -> GitHubSkillUpdateCheck {
    if str_of(value.get("status")) == Some("changed") {
        return GitHubSkillUpdateCheck::Changed(Box::new(changed_of(value)));
    }
    GitHubSkillUpdateCheck::UpToDate {
        record: record_of(value.get("record")),
        commit: str_of(value.get("commit")).unwrap_or("").to_owned(),
        locally_edited: bool_of(value.get("locallyEdited")),
    }
}

/// `UUID` of the spec: any version 4 UUID in an answer reads as `<uuid>`
pub(super) fn clean_uuids(value: &Value, last: &mut String) -> Value {
    let text = serde_json::to_string(value).expect("a value prints");
    let uuid = js_regex!(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    for found in uuid.find_iter(&text) {
        *last = found.as_str().to_owned();
    }
    let replaced = uuid.replace_all(&text, |_| "<uuid>".to_owned());
    serde_json::from_str(&replaced).expect("a value reads")
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    if let Some(answer) = pkg::call(name, args, cx) {
        return Some(answer);
    }
    Some(match name {
        "builtin-dir.builtinSkillsDirFor" => {
            let options = arg(args, 0);
            let text = |key: &str| str_of(options.and_then(|o| o.get(key))).unwrap_or("");
            Ok(Some(Value::from(builtin_skills_dir_for(
                &BuiltinSkillsDirOptions {
                    is_packaged: bool_of(options.and_then(|o| o.get("isPackaged"))),
                    resources_path: text("resourcesPath"),
                    app_path: text("appPath"),
                },
            ))))
        }
        "user-skills-service.AI_SKILL_FILE_MAX_BYTES" => {
            Ok(Some(Value::from(AI_SKILL_FILE_MAX_BYTES)))
        }
        "user-skills-service.SKILL_TEMPLATE_MAX_BYTES" => {
            Ok(Some(Value::from(SKILL_TEMPLATE_MAX_BYTES)))
        }
        "user-skills-service.failureOf" => {
            let thrown = match str_of(arg(args, 0).and_then(|e| e.get("kind"))) {
                Some(kind) => Thrown::Import(SkillImportError::new(kind_of(kind), "x")),
                None => Thrown::Plain("plain".to_owned()),
            };
            Ok(Some(jscompat::json_value_to_serde(
                &failure_of(&thrown).to_json(),
            )))
        }
        "user-skills-service.templateFileNameOf" => {
            str_arg(args, 0).map(|raw| template_file_name_of(raw).map(Value::from))
        }
        "user-skills-service.importPreviewOf" => {
            let imported = import_of(arg(args, 0).unwrap_or(&Value::Null));
            str_arg(args, 1).map(|token| {
                Some(jscompat::json_value_to_serde(&import_preview_of(
                    &imported, token,
                )))
            })
        }
        "user-skills-service.createUserSkillsService" => service::run(args, cx),
        "user-skills-ipc.DROPPED_SKILLS_MAX" => Ok(Some(json!(DROPPED_SKILLS_MAX))),
        "user-skills-ipc.registerUserSkillsIpc" => ipc::run(args, cx),
        "template-tabs.copyFileNameOf" => str_arg(args, 0).and_then(|title| {
            let extension = str_arg(args, 1)?;
            Ok(Some(Value::from(copy_file_name_of(title, extension))))
        }),
        "template-tabs.createTemplateTabs" => tabs::run(args, cx),
        "template-tabs-ipc.registerTemplateTabsIpc" => tabs::run_ipc(args, cx),
        _ => return None,
    })
}
