//! The functions of group `b2-cli` (tools/main-diff/groups/b2-cli.ts):
//! `packages/cli/src/agent-skills.ts` and `packages/cli/src/install.ts`.
//!
//! The environment of a call is a plain object, the home folder an argument,
//! the PowerShell of the Windows PATH edit a fake that logs `powershell` with
//! the script, and a ledger a list of `[path, entry]` pairs. `links` of a
//! case are made before the call and read back (and removed) after it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;

use jscompat::node_path::host::{dirname, join};
use jscompat::{JsObject, JsonValue, json_value_from_serde, json_value_to_serde};
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::{Answer, CallError, Context, arg, str_arg};
use crate::node_fs::{NodeError, namespaced, node_error};
use crate::packages::cli_agent_skills::{
    BundledSkill, LEDGER_KEY, SHARED_AGENT_ID, SKILL_NAME, SkillLedger, agent_config_dir,
    agent_ids, agent_label, agent_present, agent_target, build_skill_zip, bundled_skill_from,
    compare_versions, detect_agents, install_row_for, install_skill, is_shared_reader,
    ledger_from_settings, legacy_skill_copies, parse_skill_frontmatter, read_install_state, sha256,
    skill_file_path, skill_files_written, skill_rows, skill_target_ids, uninstall_skill,
};
use crate::packages::cli_install::{
    CLI_COMMAND, HOME_DIR_NAME, InstallOptions, PowerShellRun, default_candidate_dirs,
    homebrew_bin_dirs, inspect_cli_link, install_cli_link, is_our_launcher, launcher_file_name,
    path_hint, user_bin_dirs,
};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- agent-skills: the table ----
        "agent-skills.agentIds" => Ok(Some(to_value(&agent_ids()))),
        "agent-skills.skillTargetIds" => Ok(Some(to_value(&skill_target_ids()))),
        "agent-skills.isSharedReader" => {
            str_arg(args, 0).map(|id| Some(Value::Bool(is_shared_reader(id))))
        }
        "agent-skills.installRowFor" => {
            str_arg(args, 0).map(|id| Some(Value::String(install_row_for(id))))
        }
        "agent-skills.agentLabel" => {
            str_arg(args, 0).map(|id| Some(Value::String(agent_label(id))))
        }
        "agent-skills.agentPresent" => (|| {
            let id = str_arg(args, 0)?;
            let env = Env::of(arg(args, 1));
            let home = str_arg(args, 2)?;
            Ok(Some(Value::Bool(agent_present(id, &env.lookup(), home))))
        })(),
        "agent-skills.detectAgents" => (|| {
            let env = Env::of(arg(args, 0));
            let home = str_arg(args, 1)?;
            Ok(Some(to_value(&detect_agents(&env.lookup(), home))))
        })(),
        "agent-skills.agentConfigDir" => (|| {
            let id = str_arg(args, 0)?;
            let env = Env::of(arg(args, 1));
            let home = str_arg(args, 2)?;
            Ok(Some(match agent_config_dir(id, &env.lookup(), home) {
                Some(dir) => Value::String(dir),
                None => Value::Null,
            }))
        })(),
        "agent-skills.agentTarget" => (|| {
            let id = str_arg(args, 0)?;
            let env = Env::of(arg(args, 1));
            let home = str_arg(args, 2)?;
            Ok(Some(match agent_target(id, &env.lookup(), home) {
                Some(target) => to_value(&target),
                None => Value::Null,
            }))
        })(),
        "agent-skills.legacySkillCopies" => (|| {
            let ledger = ledger_of(arg(args, 0));
            let env = Env::of(arg(args, 1));
            let home = str_arg(args, 2)?;
            let only = arg(args, 3).and_then(Value::as_str);
            Ok(Some(to_value(&legacy_skill_copies(
                &ledger,
                &env.lookup(),
                home,
                only,
            ))))
        })(),
        "agent-skills.skillRows" => (|| {
            let ledger = ledger_of(arg(args, 0));
            let env = Env::of(arg(args, 1));
            let home = str_arg(args, 2)?;
            Ok(Some(to_value(&skill_rows(&ledger, &env.lookup(), home))))
        })(),
        // ---- agent-skills: front matter, hashes, versions ----
        "agent-skills.parseSkillFrontmatter" => str_arg(args, 0).map(|text| {
            Some(match parse_skill_frontmatter(text) {
                Some(found) => to_value(&found),
                None => Value::Null,
            })
        }),
        "agent-skills.sha256" => Ok(Some(Value::String(sha256(&bytes_of(arg(args, 0)))))),
        "agent-skills.compareVersions" => (|| {
            let a = str_arg(args, 0)?;
            let b = str_arg(args, 1)?;
            Ok(Some(json!(compare_versions(a, b))))
        })(),
        "agent-skills.ledgerFromSettings" => {
            let settings = match json_value_from_serde(arg(args, 0).unwrap_or(&Value::Null)) {
                JsonValue::Object(settings) => settings,
                _ => JsObject::new(),
            };
            Ok(Some(ledger_object(&ledger_from_settings(&settings))))
        }
        "agent-skills.bundledSkillFrom" => {
            let bundled = bundled_skill_from(&bytes_of(arg(args, 0)));
            let mut out = Map::new();
            out.insert("bytes".into(), Value::String(hex(&bundled.bytes)));
            out.insert("text".into(), Value::String(bundled.text));
            out.insert("version".into(), Value::String(bundled.version));
            out.insert("sha256".into(), Value::String(bundled.sha256));
            Ok(Some(Value::Object(out)))
        }
        "agent-skills.skillFilePath" => {
            str_arg(args, 0).map(|dir| Some(Value::String(skill_file_path(dir))))
        }
        "agent-skills.skillFilesWritten" => (|| {
            let dir = str_arg(args, 0)?;
            let ledger = ledger_of(arg(args, 1));
            Ok(Some(to_value(&skill_files_written(dir, &ledger))))
        })(),
        "agent-skills.readInstallState" => (|| {
            let dir = str_arg(args, 0)?;
            let bundled = bundled_of(arg(args, 1));
            let ledger = ledger_of(arg(args, 2));
            Ok(Some(to_value(&read_install_state(dir, &bundled, &ledger))))
        })(),
        "agent-skills.installSkill" => (|| {
            let dir = str_arg(args, 0)?;
            let bundled = bundled_of(arg(args, 1));
            let mut ledger = ledger_of(arg(args, 2));
            let channel = arg(args, 3).and_then(Value::as_str);
            make_links(arg(args, 4))?;
            let result = install_skill(dir, &bundled, &mut ledger, channel, cx.now_ms);
            let mut out = attempt(result.map(Value::String));
            out.insert("ledger".into(), ledger_pairs(&ledger));
            Ok(Some(Value::Object(out)))
        })(),
        "agent-skills.uninstallSkill" => (|| {
            let dir = str_arg(args, 0)?;
            let mut ledger = ledger_of(arg(args, 1));
            let result = uninstall_skill(dir, &mut ledger);
            let mut out = attempt(result.map(Value::Bool));
            out.insert("ledger".into(), ledger_pairs(&ledger));
            Ok(Some(Value::Object(out)))
        })(),
        "agent-skills.buildSkillZip" => (|| {
            let bundled = bundled_of(arg(args, 0));
            let bytes = build_skill_zip(&bundled).map_err(CallError::plain)?;
            let entries =
                ooxml_pkg::read_entries(&bytes).map_err(|e| CallError::plain(e.to_string()))?;
            let mut out = Vec::new();
            for entry in entries {
                let mut item = Map::new();
                item.insert(
                    "name".into(),
                    Value::String(String::from_utf8_lossy(&entry.raw_name).into_owned()),
                );
                item.insert("dir".into(), Value::Bool(entry.is_dir));
                let text = if entry.is_dir {
                    String::new()
                } else {
                    let content = entry.content.map_err(CallError::plain)?;
                    ooxml_pkg::decode_text(&content).into_owned()
                };
                item.insert("text".into(), Value::String(text));
                out.push(Value::Object(item));
            }
            Ok(Some(Value::Array(out)))
        })(),
        "agent-skills.SKILL_NAME" => Ok(Some(Value::String(SKILL_NAME.to_owned()))),
        "agent-skills.LEDGER_KEY" => Ok(Some(Value::String(LEDGER_KEY.to_owned()))),
        "agent-skills.SHARED_AGENT_ID" => Ok(Some(Value::String(SHARED_AGENT_ID.to_owned()))),
        // ---- install ----
        "install.launcherFileName" => {
            str_arg(args, 0).map(|platform| Some(Value::String(launcher_file_name(platform))))
        }
        "install.CLI_COMMAND" => Ok(Some(Value::String(CLI_COMMAND.to_owned()))),
        "install.HOME_DIR_NAME" => Ok(Some(Value::String(HOME_DIR_NAME.to_owned()))),
        "install.defaultCandidateDirs" => (|| {
            let platform = str_arg(args, 0)?;
            let env = Env::of(arg(args, 1));
            let existing = strings_of(arg(args, 2));
            let exists = |path: &str| existing.iter().any(|known| known == path);
            Ok(Some(to_value(&default_candidate_dirs(
                platform,
                &env.lookup(),
                &exists,
            ))))
        })(),
        "install.homebrewBinDirs" => (|| {
            let platform = str_arg(args, 0)?;
            let env = Env::of(arg(args, 1));
            let existing = strings_of(arg(args, 2));
            let exists = |path: &str| existing.iter().any(|known| known == path);
            Ok(Some(to_value(&homebrew_bin_dirs(
                platform,
                &env.lookup(),
                &exists,
            ))))
        })(),
        "install.userBinDirs" => {
            let env = Env::of(arg(args, 0));
            Ok(Some(to_value(&user_bin_dirs(&env.lookup()))))
        }
        "install.pathHint" => (|| {
            let dir = str_arg(args, 0)?;
            let env = Env::of(arg(args, 1));
            Ok(path_hint(dir, &env.lookup()).map(Value::String))
        })(),
        "install.installCliLink" => link_run(args, cx, install_cli_link),
        "install.inspectCliLink" => link_run(args, cx, inspect_cli_link),
        "install.isOurLauncher" => (|| {
            let target = str_arg(args, 0)?;
            let launcher = str_arg(args, 1)?;
            let links = link_paths(arg(args, 2));
            make_links(arg(args, 2))?;
            let mut out = Map::new();
            out.insert(
                "value".into(),
                Value::Bool(is_our_launcher(target, launcher)),
            );
            out.insert("links".into(), observe(&links));
            Ok(Some(Value::Object(out)))
        })(),
        _ => return None,
    })
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a value prints")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------------------------------------------------------------------------
// the arguments
// ---------------------------------------------------------------------------

/// `process.env` of a call: a plain object of strings
struct Env(HashMap<String, String>);

impl Env {
    fn of(value: Option<&Value>) -> Env {
        let mut vars = HashMap::new();
        if let Some(Value::Object(map)) = value {
            for (name, value) in map {
                if let Value::String(text) = value {
                    vars.insert(name.clone(), text.clone());
                }
            }
        }
        Env(vars)
    }

    fn lookup(&self) -> impl Fn(&str) -> Option<String> + '_ {
        |name: &str| self.0.get(name).cloned()
    }
}

fn strings_of(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// `{ text }` or `{ hex }`, or a string, as bytes
fn bytes_of(value: Option<&Value>) -> Vec<u8> {
    match value {
        Some(Value::String(text)) => text.clone().into_bytes(),
        Some(Value::Object(spec)) => match spec.get("hex").and_then(Value::as_str) {
            Some(digits) => (0..digits.len() / 2)
                .map(|i| u8::from_str_radix(&digits[i * 2..i * 2 + 2], 16).unwrap_or(0))
                .collect(),
            None => spec
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .as_bytes()
                .to_vec(),
        },
        _ => Vec::new(),
    }
}

fn bundled_of(value: Option<&Value>) -> BundledSkill {
    bundled_skill_from(&bytes_of(value))
}

/// a ledger of `[path, entry]` pairs
fn ledger_of(value: Option<&Value>) -> SkillLedger {
    let mut ledger = JsObject::new();
    if let Some(Value::Array(pairs)) = value {
        for pair in pairs {
            if let Some([Value::String(path), entry]) = pair.as_array().map(Vec::as_slice) {
                ledger.set(path.clone(), json_value_from_serde(entry));
            }
        }
    }
    ledger
}

fn ledger_pairs(ledger: &SkillLedger) -> Value {
    Value::Array(
        ledger
            .entries()
            .into_iter()
            .map(|(path, entry)| json!([path, json_value_to_serde(entry)]))
            .collect(),
    )
}

fn ledger_object(ledger: &SkillLedger) -> Value {
    json_value_to_serde(&JsonValue::Object(ledger.clone()))
}

// ---------------------------------------------------------------------------
// the answers
// ---------------------------------------------------------------------------

/// `{ value }`, or `{ error: { code, message } }` where the call threw
fn attempt(result: Result<Value, NodeError>) -> Map<String, Value> {
    let mut out = Map::new();
    match result {
        Ok(value) => {
            out.insert("value".into(), value);
        }
        Err(error) => {
            let mut e = Map::new();
            e.insert("code".into(), error.code.map_or(Value::Null, |c| json!(c)));
            e.insert("message".into(), Value::String(error.message));
            out.insert("error".into(), Value::Object(e));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// the links of a case
// ---------------------------------------------------------------------------

/// the `[link, target]` pairs
fn link_pairs(value: Option<&Value>) -> Vec<(String, String)> {
    let Some(Value::Array(pairs)) = value else {
        return Vec::new();
    };
    pairs
        .iter()
        .filter_map(|pair| match pair.as_array().map(Vec::as_slice) {
            Some([Value::String(link), Value::String(target)]) => {
                Some((link.clone(), target.clone()))
            }
            _ => None,
        })
        .collect()
}

fn link_paths(value: Option<&Value>) -> Vec<String> {
    link_pairs(value)
        .into_iter()
        .map(|(link, _)| link)
        .collect()
}

#[cfg(unix)]
fn symlink(target: &str, link: &str) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn symlink(target: &str, link: &str) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

fn make_links(value: Option<&Value>) -> Result<(), CallError> {
    for (link, target) in link_pairs(value) {
        let parent = dirname(&link);
        fs::create_dir_all(namespaced(&parent))
            .map_err(|e| CallError::from(node_error(&e, "mkdir", &parent)))?;
        symlink(&target, &namespaced(&link))
            .map_err(|e| CallError::from(node_error(&e, "symlink", &link)))?;
    }
    Ok(())
}

/// what is at each path now (`file`, `dir` or `-> target`), the links removed
fn observe(paths: &[String]) -> Value {
    let mut out = Map::new();
    for path in paths {
        let Ok(meta) = fs::symlink_metadata(namespaced(path)) else {
            continue;
        };
        let shown = if meta.file_type().is_symlink() {
            let target = fs::read_link(namespaced(path))
                .map(|target| target.to_string_lossy().into_owned())
                .unwrap_or_default();
            let _ = fs::remove_file(namespaced(path));
            format!("-> {target}")
        } else if meta.is_dir() {
            "dir".to_owned()
        } else {
            "file".to_owned()
        };
        out.insert(path.clone(), Value::String(shown));
    }
    Value::Object(out)
}

/// a string option of the case, empty where it is missing
fn text<'a>(o: &'a Map<String, Value>, key: &str) -> &'a str {
    o.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `installCliLink` and `inspectCliLink` over the options of the case
fn link_run(
    args: &[Value],
    cx: &mut Context,
    run: fn(&InstallOptions) -> Result<crate::packages::cli_install::InstallOutcome, NodeError>,
) -> Answer {
    let Some(Value::Object(o)) = arg(args, 0) else {
        return Err(CallError::plain("argument 0 is not an object"));
    };
    let links = o.get("links");
    make_links(links)?;
    let env = Env::of(o.get("env"));
    let lookup = env.lookup();
    let candidates: Option<Vec<String>> = match o.get("candidateDirs") {
        Some(Value::Array(_)) => Some(strings_of(o.get("candidateDirs"))),
        _ => None,
    };
    let ps = o.get("ps");
    let (ps_ok, ps_stdout) = match ps {
        Some(Value::Object(ps)) => (
            ps.get("ok").and_then(Value::as_bool).unwrap_or(false),
            ps.get("stdout")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        ),
        _ => (false, String::new()),
    };
    let logs: RefCell<Vec<Vec<Value>>> = RefCell::new(Vec::new());
    let power_shell = |script: &str| {
        logs.borrow_mut()
            .push(vec![json!("powershell"), json!(script)]);
        PowerShellRun {
            ok: ps_ok,
            stdout: ps_stdout.clone(),
        }
    };
    let opts = InstallOptions {
        launcher: text(o, "launcher"),
        platform: text(o, "platform"),
        candidate_dirs: candidates.as_deref(),
        env: &lookup,
        run_power_shell: &power_shell,
    };
    let result = run(&opts).map(|outcome| to_value(&outcome));
    let mut out = attempt(result);
    let mut paths = link_paths(links);
    for dir in candidates.as_deref().unwrap_or_default() {
        paths.push(join(&[dir, CLI_COMMAND]));
    }
    out.insert("links".into(), observe(&paths));
    cx.logs.extend(logs.into_inner());
    Ok(Some(Value::Object(out)))
}
