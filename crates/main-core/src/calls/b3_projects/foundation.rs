//! The functions of group `b3-projects`, part `foundation`
//! (tools/main-diff/groups/b3-projects-foundation.ts): the paths, ignore,
//! memory, folder-files, visibility and trust modules of
//! `apps/shell/src/main/projects/`, and the pieces of project-store,
//! folder-tree, agent-sessions, user-skills and file-index they call.
//!
//! The functions that read a folder take as their first argument the list of
//! links to make before the call (`[[linkPath, target], ...]`), as the spec
//! does. `realPlainFileIn` takes the project root as `canonicalPath` writes
//! it, and the refusal functions a POSIX absolute folder canonicalized: the
//! spec does both on the TypeScript side.

use jscompat::{RegexLimit, RegexSyntaxError};
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::ai_provider::user_skills_sources::folder_holds_data;
use crate::packages::project_store::{
    FolderRefusalReason, PROJECT_EDITORS, PROJECT_FORMAT_VERSION, PROJECT_NAME_MAX_CHARS,
    ProjectMemoryOp, memory_backup_pattern,
};
use crate::shell::projects::folder_files::{
    clean_project_name, data_dir_name, hash_text, is_data_dir_name, plain_file_in,
    plain_folder_entries, project_file_text, read_data_text, read_folder_text, read_project_file,
    real_plain_file_in,
};
use crate::shell::projects::ignore::{
    IgnoreOptions, add_ignore_line, compile_ignore, ignore_folds_case, ignore_line_for,
    remove_ignore_line,
};
use crate::shell::projects::memory::{
    LocalDateParts, MEMORY_SOFT_LIMIT_CHARS, MemoryOpContext, MemoryOpResult, apply_memory_op,
    build_memory_text, local_date, memory_backup_name, memory_entries, memory_has_content,
    memory_header,
};
use crate::shell::projects::paths::{
    RefusalContext, canonical_path, comparable_path, folder_refusal, is_inside_folder,
    is_plain_segment, location_refusal, path_api, relative_inside, same_path,
};
use crate::shell::projects::trust::{
    HashedTexts, TrustScanInput, has_foreign_message, hashes_of, list_foreign_chats,
    read_hashed_texts, scan_for_trust,
};
use crate::shell::projects::visibility::is_ai_visible_path;

pub(super) fn call(name: &str, args: &[Value], _cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "paths.pathApi" => path_api_call(args),
        "paths.canonicalPath" => str_arg(args, 0).map(|p| Some(Value::from(canonical_path(p)))),
        "paths.comparablePath" => both(args, |a, b| Value::from(comparable_path(a, b))),
        "paths.isPlainSegment" => str_arg(args, 0).map(|s| Some(Value::from(is_plain_segment(s)))),
        "paths.samePath" => three(args, |a, b, c| Value::from(same_path(a, b, c))),
        "paths.isInsideFolder" => three(args, |a, b, c| Value::from(is_inside_folder(a, b, c))),
        "paths.relativeInside" => three(args, |a, b, c| {
            relative_inside(a, b, c).map_or(Value::Null, Value::from)
        }),
        "paths.folderRefusal" => refusal_call(args, folder_refusal),
        "paths.locationRefusal" => refusal_call(args, location_refusal),

        "ignore.ignoreFoldsCase" => {
            str_arg(args, 0).map(|p| Some(Value::from(ignore_folds_case(p))))
        }
        "ignore.compileIgnore" => compile_ignore_call(args),
        "ignore.ignoreLineFor" => str_arg(args, 0).map(|p| Some(Value::from(ignore_line_for(p)))),
        "ignore.addIgnoreLine" => both(args, |a, b| Value::from(add_ignore_line(a, b))),
        "ignore.removeIgnoreLine" => both(args, |a, b| Value::from(remove_ignore_line(a, b))),

        "memory.MEMORY_SOFT_LIMIT_CHARS" => Ok(Some(Value::from(MEMORY_SOFT_LIMIT_CHARS))),
        "memory.memoryHeader" => str_arg(args, 0).map(|l| Some(Value::from(memory_header(l)))),
        "memory.memoryHasContent" => Ok(Some(Value::from(memory_has_content(
            arg(args, 0).and_then(Value::as_str),
        )))),
        "memory.memoryEntries" => str_arg(args, 0).map(|t| Some(Value::from(memory_entries(t)))),
        "memory.applyMemoryOp" => apply_memory_op_call(args),
        "memory.buildMemoryText" => build_memory_text_call(args),
        "memory.localDate" => parts_in(args).map(|p| Some(Value::from(local_date(&p)))),
        "memory.memoryBackupName" => {
            parts_in(args).map(|p| Some(Value::from(memory_backup_name(&p))))
        }

        "folder-files.hashText" => str_arg(args, 0).map(|t| Some(Value::from(hash_text(t)))),
        "folder-files.plainFileIn" | "folder-files.plainFileIn.hardLinks" => on_folder(args, |a| {
            let segments = strings(arg(a, 1))?;
            Ok(opt_text(plain_file_in(str_arg(a, 0)?, &segments)))
        }),
        "folder-files.realPlainFileIn" => on_folder(args, |a| {
            let segments = strings(arg(a, 1))?;
            let root = canonical_path(str_arg(a, 0)?);
            Ok(real_plain_file_in(&root, &segments, str_arg(a, 2)?).map_or(
                Value::Null,
                |real| json!({ "path": real.path, "segments": real.segments }),
            ))
        }),
        "folder-files.plainFolderEntries" => on_folder(args, |a| {
            let segments = strings(arg(a, 1))?;
            Ok(Value::from(plain_folder_entries(str_arg(a, 0)?, &segments)))
        }),
        "folder-files.readFolderText" => on_folder(args, |a| {
            let segments = strings(arg(a, 1))?;
            Ok(opt_text(read_folder_text(str_arg(a, 0)?, &segments)))
        }),
        "folder-files.isDataDirName" => {
            str_arg(args, 0).map(|s| Some(Value::from(is_data_dir_name(s))))
        }
        "folder-files.dataDirName" => {
            on_folder(args, |a| Ok(Value::from(data_dir_name(str_arg(a, 0)?))))
        }
        "folder-files.readDataText" => on_folder(args, |a| {
            Ok(opt_text(read_data_text(
                str_arg(a, 0)?,
                str_arg(a, 1)?,
                arg(a, 2).and_then(Value::as_str),
            )))
        }),
        "folder-files.cleanProjectName" => {
            str_arg(args, 0).map(|n| Some(Value::from(clean_project_name(n))))
        }
        "folder-files.readProjectFile" => on_folder(args, |a| {
            Ok(
                read_project_file(str_arg(a, 0)?, arg(a, 1).and_then(Value::as_str))
                    .map_or(Value::Null, |file| to_value(&file)),
            )
        }),
        "folder-files.projectFileText" => {
            let file = serde_json::from_value(arg(args, 0).cloned().unwrap_or(Value::Null))
                .map_err(|e| bad(&e.to_string()));
            file.map(|file| Some(Value::from(project_file_text(&file))))
        }

        "visibility.isAiVisiblePath" => visible_call(args),

        "trust.readHashedTexts" => on_folder(args, |a| {
            Ok(texts_value(&read_hashed_texts(str_arg(a, 0)?)))
        }),
        "trust.hashesOf" => texts_in(arg(args, 0)).map(|t| Some(to_value(&hashes_of(&t)))),
        "trust.hasForeignMessage" => on_folder(args, |a| {
            Ok(Value::from(has_foreign_message(
                str_arg(a, 0)?,
                str_arg(a, 1)?,
                str_arg(a, 2)?,
                arg(a, 3).and_then(Value::as_str),
            )))
        }),
        "trust.listForeignChats" => on_folder(args, |a| {
            Ok(to_value(&list_foreign_chats(
                str_arg(a, 0)?,
                str_arg(a, 1)?,
                str_arg(a, 2)?,
                arg(a, 3).and_then(Value::as_str),
            )))
        }),
        "trust.scanForTrust" => on_folder(args, |a| {
            let input = a.first().cloned().unwrap_or(Value::Null);
            let field = |key: &str| {
                input
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| bad(key))
            };
            let scan = scan_for_trust(&TrustScanInput {
                root: field("root")?,
                project_id: field("projectId")?,
                name: field("name")?,
                install_id: field("installId")?,
            });
            Ok(json!({
                "prompt": to_value(&scan.prompt),
                "foreign": scan.foreign,
                "hashes": to_value(&scan.hashes),
            }))
        }),

        "folder-api.PROJECT_EDITORS" => Ok(Some(Value::from(PROJECT_EDITORS.to_vec()))),
        "folder-api.PROJECT_NAME_MAX_CHARS" => Ok(Some(Value::from(PROJECT_NAME_MAX_CHARS))),
        "folder-api.PROJECT_FORMAT_VERSION" => Ok(Some(Value::from(PROJECT_FORMAT_VERSION))),
        "folder-api.MEMORY_BACKUP_PATTERN" => {
            str_arg(args, 0).map(|n| Some(Value::from(memory_backup_pattern().test(n))))
        }
        "sources.folderHoldsData" => on_folder(args, |a| {
            let depth = arg(a, 1).and_then(Value::as_i64).unwrap_or(3);
            Ok(Value::from(folder_holds_data(str_arg(a, 0)?, depth)))
        }),
        _ => return None,
    })
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a model prints")
}

fn opt_text(text: Option<String>) -> Value {
    text.map_or(Value::Null, Value::from)
}

fn both(args: &[Value], run: impl FnOnce(&str, &str) -> Value) -> Answer {
    Ok(Some(run(str_arg(args, 0)?, str_arg(args, 1)?)))
}

fn three(args: &[Value], run: impl FnOnce(&str, &str, &str) -> Value) -> Answer {
    Ok(Some(run(
        str_arg(args, 0)?,
        str_arg(args, 1)?,
        str_arg(args, 2)?,
    )))
}

/// a list of strings
fn strings(value: Option<&Value>) -> Result<Vec<String>, CallError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list of strings"))?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| bad("a list of strings"))
        })
        .collect()
}

/// makes the links of a case: `[[linkPath, target], ...]`
fn make_links(links: Option<&Value>) -> Result<(), CallError> {
    for pair in links.and_then(Value::as_array).into_iter().flatten() {
        let pair = pair.as_array().map_or(&[][..], Vec::as_slice);
        let link = str_arg(pair, 0)?;
        let target = str_arg(pair, 1)?;
        if let Some(parent) = std::path::Path::new(link).parent() {
            std::fs::create_dir_all(parent).map_err(|e| bad(&e.to_string()))?;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).map_err(|e| bad(&e.to_string()))?;
        #[cfg(not(unix))]
        let _ = target;
    }
    Ok(())
}

/// a function that reads a folder: its first argument is the list of links
fn on_folder(args: &[Value], run: impl FnOnce(&[Value]) -> Result<Value, CallError>) -> Answer {
    make_links(arg(args, 0))?;
    run(args.get(1..).unwrap_or(&[])).map(Some)
}

fn path_api_call(args: &[Value]) -> Answer {
    let api = path_api(str_arg(args, 0)?);
    let path = str_arg(args, 1)?;
    Ok(Some(json!({
        "sep": api.sep(),
        "normalized": api.normalize(path),
        "absolute": api.is_absolute(path),
        "root": api.parse(path).root,
        "dirname": api.dirname(path),
        "relative": api.relative(&api.normalize(path), &api.normalize(str_arg(args, 2)?)),
    })))
}

fn refusal_call(
    args: &[Value],
    run: fn(&str, &RefusalContext) -> Option<FolderRefusalReason>,
) -> Answer {
    let folder = str_arg(args, 0)?;
    let ctx = arg(args, 1).cloned().unwrap_or(Value::Null);
    let field = |key: &str| {
        ctx.get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| bad(key))
    };
    let ctx = RefusalContext {
        home_dir: field("homeDir")?,
        user_data: field("userData")?,
        platform: field("platform")?,
    };
    // a POSIX absolute folder is the canonical path in the spec
    let folder = if folder.starts_with('/') && folder != "/" {
        canonical_path(folder)
    } else {
        folder.to_owned()
    };
    Ok(Some(run(&folder, &ctx).map_or(Value::Null, |reason| {
        Value::from(reason.as_str())
    })))
}

fn syntax(error: RegexSyntaxError) -> CallError {
    CallError::plain(error.to_string())
}

fn limit(error: RegexLimit) -> CallError {
    CallError::plain(error.to_string())
}

fn compile_ignore_call(args: &[Value]) -> Answer {
    let matcher = compile_ignore(
        str_arg(args, 0)?,
        IgnoreOptions {
            case_insensitive: arg(args, 1).and_then(Value::as_bool).unwrap_or(false),
        },
    )
    .map_err(syntax)?;
    let mut results = Vec::new();
    for probe in arg(args, 2).and_then(Value::as_array).into_iter().flatten() {
        let probe = probe.as_array().map_or(&[][..], Vec::as_slice);
        let is_dir = arg(probe, 1).and_then(Value::as_bool).unwrap_or(false);
        results.push(Value::from(
            matcher.ignores(str_arg(probe, 0)?, is_dir).map_err(limit)?,
        ));
    }
    Ok(Some(
        json!({ "patterns": matcher.patterns, "results": results }),
    ))
}

fn visible_call(args: &[Value]) -> Answer {
    let matcher = compile_ignore(
        str_arg(args, 2)?,
        IgnoreOptions {
            case_insensitive: arg(args, 3).and_then(Value::as_bool).unwrap_or(false),
        },
    )
    .map_err(syntax)?;
    let is_dir = arg(args, 4).and_then(Value::as_bool).unwrap_or(false);
    is_ai_visible_path(str_arg(args, 0)?, str_arg(args, 1)?, &matcher, is_dir)
        .map(|visible| Some(Value::from(visible)))
        .map_err(limit)
}

fn apply_memory_op_call(args: &[Value]) -> Answer {
    let op: ProjectMemoryOp = serde_json::from_value(arg(args, 1).cloned().unwrap_or(Value::Null))
        .map_err(|e| bad(&e.to_string()))?;
    let ctx_value = arg(args, 2).cloned().unwrap_or(Value::Null);
    let field = |key: &str| {
        ctx_value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| bad(key))
    };
    let ctx = MemoryOpContext {
        today: field("today")?,
        header: field("header")?,
    };
    let result = apply_memory_op(arg(args, 0).and_then(Value::as_str), &op, &ctx);
    Ok(Some(match result {
        MemoryOpResult::Ok { text, change } => {
            json!({ "ok": true, "text": text, "change": to_value(&change) })
        }
        MemoryOpResult::Refused { reason } => json!({
            "ok": false,
            "reason": to_value(&crate::packages::project_store::ProjectMemoryRefusal::from(reason)),
        }),
    }))
}

fn build_memory_text_call(args: &[Value]) -> Answer {
    let entries = strings(arg(args, 0))?;
    Ok(Some(Value::from(build_memory_text(
        &entries,
        str_arg(args, 1)?,
        str_arg(args, 2)?,
    ))))
}

fn parts_in(args: &[Value]) -> Result<LocalDateParts, CallError> {
    let parts: Vec<i64> = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("date parts"))?
        .iter()
        .map(|part| part.as_i64().ok_or_else(|| bad("date parts")))
        .collect::<Result<_, _>>()?;
    let [full_year, month, date, hours, minutes, seconds] = parts[..] else {
        return Err(bad("date parts"));
    };
    Ok(LocalDateParts {
        full_year,
        month,
        date,
        hours,
        minutes,
        seconds,
    })
}

fn texts_value(texts: &HashedTexts) -> Value {
    let mut out = Map::new();
    out.insert("dataDir".to_owned(), Value::from(texts.data_dir.as_str()));
    out.insert(
        "instructions".to_owned(),
        opt_text(texts.instructions.clone()),
    );
    out.insert("memory".to_owned(), opt_text(texts.memory.clone()));
    out.insert("agents".to_owned(), opt_text(texts.agents.clone()));
    out.insert("claude".to_owned(), opt_text(texts.claude.clone()));
    Value::Object(out)
}

fn texts_in(value: Option<&Value>) -> Result<HashedTexts, CallError> {
    let value = value.cloned().unwrap_or(Value::Null);
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(HashedTexts {
        data_dir: text("dataDir").ok_or_else(|| bad("dataDir"))?,
        instructions: text("instructions"),
        memory: text("memory"),
        agents: text("agents"),
        claude: text("claude"),
    })
}
