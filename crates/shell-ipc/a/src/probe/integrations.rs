//! The probe fakes of the `integrations` port's batch hosts: the stand-in for
//! `@seuoffice/cli/agent-skills` and `inspectCliLink` of
//! `@seuoffice/cli/install`, answering from the case's `hosts.a.integrations`
//! (the TypeScript side of the group, groups/a/integrations.ts, is the same
//! table in JavaScript):
//!
//! - `appsRoot`, `resourcesPath`, `packaged`, `appImage`: where the shell
//!   entry says the bundled files are and what `app` / `process` say
//! - `targets`: every agent row (`{id, label, skillsDir, legacy?}`);
//!   `detected`, `rows`, `legacy`: the ids `detectAgents()`, `skillRows()` and
//!   `legacySkillCopies()` answer
//! - `states`: `{<skillsDir>: {status, installedVersion?, older?}}` before the
//!   case; an installed or removed copy changes its row; anything else is
//!   `missing`
//! - `link`: what `inspectCliLink` answers (`{status: "missing"}` by default)
//! - `installError`: `{<skillsDir>: message}`, `installSkill` throws there;
//!   `zipError`: `buildSkillZip` rejects
//!
//! One log line per call, named after the function it stands for; the ledger
//! is logged as its sorted keys.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use jscompat::node_path::host::join;
use jscompat::{JsObject, JsonValue};
use serde_json::{Value, json};

use super::{Log, push};
use crate::integrations::{
    AgentSkills, AgentSkillsHost, AgentTarget, BundledSkill, Ledger, SkillInstallState,
};

/// Inserts this port's factory and the fakes of its hosts, answering from
/// the case's `hosts.a` value; `log` is the case's host log
pub fn insert(hosts: &mut shell_contract::Hosts, case: &serde_json::Value, log: Option<Log>) {
    hosts.insert(crate::integrations::factory());
    hosts.insert::<AgentSkillsHost>(Arc::new(FakeAgentSkills::new(&case["integrations"], log)));
}

/// `<skillsDir>/seuoffice/SKILL.md`
fn skill_file(skills_dir: &str) -> String {
    format!("{skills_dir}/seuoffice/SKILL.md")
}

fn json_value(value: &Value) -> JsonValue {
    match value {
        Value::Null => JsonValue::Null,
        Value::Bool(b) => JsonValue::Bool(*b),
        Value::Number(n) => JsonValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => JsonValue::String(s.clone()),
        Value::Array(a) => JsonValue::Array(a.iter().map(json_value).collect()),
        Value::Object(o) => JsonValue::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), json_value(v)))
                .collect::<JsObject<JsonValue>>(),
        ),
    }
}

/// The ledger's keys, sorted: what a log line shows of it
fn ledger_keys(ledger: &Ledger) -> Value {
    let mut keys: Vec<&str> = ledger.entries().into_iter().map(|(k, _)| k).collect();
    keys.sort_unstable();
    json!(keys)
}

/// The ledger keys that name a file inside `skills_dir`
fn written_in(skills_dir: &str, ledger: &Ledger) -> Vec<String> {
    let prefix = format!("{skills_dir}/");
    ledger
        .entries()
        .into_iter()
        .map(|(k, _)| k)
        .filter(|k| k.starts_with(&prefix))
        .map(str::to_owned)
        .collect()
}

struct FakeAgentSkills {
    log: Option<Log>,
    case: Value,
    states: Mutex<HashMap<String, SkillInstallState>>,
}

impl FakeAgentSkills {
    fn new(case: &Value, log: Option<Log>) -> Self {
        let states = case["states"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(dir, state)| {
                let state = SkillInstallState {
                    status: state["status"].as_str().unwrap_or("missing").to_owned(),
                    path: skill_file(dir),
                    installed_version: state["installedVersion"].as_str().map(str::to_owned),
                    older: state["older"].as_bool(),
                };
                (dir.clone(), state)
            })
            .collect();
        FakeAgentSkills {
            log,
            case: case.clone(),
            states: Mutex::new(states),
        }
    }

    fn log(&self, line: Value) {
        push(&self.log, line);
    }

    fn text(&self, key: &str) -> String {
        self.case[key].as_str().unwrap_or_default().to_owned()
    }

    fn target(&self, id: &str) -> Option<AgentTarget> {
        let target = self.case["targets"]
            .as_array()?
            .iter()
            .find(|t| t["id"].as_str() == Some(id))?;
        Some(AgentTarget {
            id: id.to_owned(),
            label: target["label"].as_str().unwrap_or_default().to_owned(),
            skills_dir: target["skillsDir"].as_str().unwrap_or_default().to_owned(),
            legacy: target["legacy"].as_bool().unwrap_or(false),
        })
    }

    /// The rows named by the ids of `key`; an id that is no target is left out
    fn rows(&self, key: &str) -> Vec<AgentTarget> {
        self.case[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(|id| self.target(id))
            .collect()
    }

    fn packaged(&self) -> bool {
        self.case["packaged"].as_bool().unwrap_or(false)
    }

    /// The `cliDir` of the shell entry's `registerIntegrationsIpc({...})`
    fn bundled_dir(&self) -> String {
        if self.packaged() {
            join(&[&self.text("resourcesPath"), "cli"])
        } else {
            join(&[&self.text("appsRoot"), "..", "packages", "cli", "bin"])
        }
    }
}

impl AgentSkills for FakeAgentSkills {
    fn cli_dir(&self) -> String {
        self.bundled_dir()
    }

    fn skill_path(&self) -> String {
        if self.packaged() {
            join(&[&self.bundled_dir(), "skills", "seuoffice", "SKILL.md"])
        } else {
            join(&[
                &self.text("appsRoot"),
                "..",
                "skills",
                "seuoffice",
                "SKILL.md",
            ])
        }
    }

    fn cli_package_json(&self) -> String {
        if self.packaged() {
            join(&[&self.bundled_dir(), "package.json"])
        } else {
            join(&[
                &self.text("appsRoot"),
                "..",
                "packages",
                "cli",
                "package.json",
            ])
        }
    }

    fn is_packaged(&self) -> bool {
        self.packaged()
    }

    fn resources_path(&self) -> String {
        self.text("resourcesPath")
    }

    fn env(&self, name: &str) -> Option<String> {
        (name == "APPIMAGE")
            .then(|| self.case["appImage"].as_str().map(str::to_owned))
            .flatten()
    }

    /// The machine's own platform, which the TypeScript side reads as
    /// `process.platform`
    fn platform(&self) -> String {
        match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        }
        .to_owned()
    }

    fn bundled_skill_from(&self, bytes: Vec<u8>) -> BundledSkill {
        let text = String::from_utf8_lossy(&bytes).into_owned();
        // `/^version:[ \t]*(\S*)/m`
        let version = text
            .lines()
            .find_map(|line| line.strip_prefix("version:"))
            .map(|rest| {
                rest.trim_start_matches([' ', '\t'])
                    .chars()
                    .take_while(|c| !c.is_whitespace())
                    .collect::<String>()
            })
            .unwrap_or_default();
        let sum = bytes
            .iter()
            .fold(0u32, |sum, byte| (sum + u32::from(*byte)) % 65521);
        BundledSkill {
            sha256: format!("{}:{sum}", bytes.len()),
            bytes,
            text,
            version,
        }
    }

    fn detect_agents(&self) -> Vec<AgentTarget> {
        self.log(json!(["agentSkills.detectAgents"]));
        self.rows("detected")
    }

    fn agent_target(&self, id: &str) -> Option<AgentTarget> {
        self.log(json!(["agentSkills.agentTarget", id]));
        self.target(id)
    }

    fn skill_rows(&self, ledger: &Ledger) -> Vec<AgentTarget> {
        self.log(json!(["agentSkills.skillRows", ledger_keys(ledger)]));
        self.rows("rows")
    }

    fn legacy_skill_copies(&self, ledger: &Ledger, only: &str) -> Vec<AgentTarget> {
        self.log(json!([
            "agentSkills.legacySkillCopies",
            ledger_keys(ledger),
            only
        ]));
        self.rows("legacy")
    }

    fn skill_files_written(&self, skills_dir: &str, ledger: &Ledger) -> Vec<String> {
        self.log(json!([
            "agentSkills.skillFilesWritten",
            skills_dir,
            ledger_keys(ledger)
        ]));
        written_in(skills_dir, ledger)
    }

    fn read_install_state(
        &self,
        skills_dir: &str,
        bundled: &BundledSkill,
        ledger: &Ledger,
    ) -> SkillInstallState {
        self.log(json!([
            "agentSkills.readInstallState",
            skills_dir,
            bundled.version,
            ledger_keys(ledger)
        ]));
        self.states
            .lock()
            .expect("the states")
            .get(skills_dir)
            .cloned()
            .unwrap_or_else(|| SkillInstallState {
                status: "missing".into(),
                path: skill_file(skills_dir),
                installed_version: None,
                older: None,
            })
    }

    fn install_skill(
        &self,
        skills_dir: &str,
        bundled: &BundledSkill,
        ledger: &mut Ledger,
    ) -> Result<String, String> {
        self.log(json!([
            "agentSkills.installSkill",
            skills_dir,
            bundled.version,
            ledger_keys(ledger)
        ]));
        if let Some(message) = self.case["installError"][skills_dir].as_str() {
            return Err(message.to_owned());
        }
        let path = skill_file(skills_dir);
        let mut written = JsObject::new();
        written.set("version", JsonValue::String(bundled.version.clone()));
        written.set("sha256", JsonValue::String(bundled.sha256.clone()));
        ledger.set(path.clone(), JsonValue::Object(written));
        self.states.lock().expect("the states").insert(
            skills_dir.to_owned(),
            SkillInstallState {
                status: "installed".into(),
                path: path.clone(),
                installed_version: Some(bundled.version.clone()),
                older: None,
            },
        );
        Ok(path)
    }

    fn uninstall_skill(&self, skills_dir: &str, ledger: &mut Ledger) -> bool {
        self.log(json!([
            "agentSkills.uninstallSkill",
            skills_dir,
            ledger_keys(ledger)
        ]));
        let gone = written_in(skills_dir, ledger);
        if gone.is_empty() {
            return false;
        }
        *ledger = ledger
            .entries()
            .into_iter()
            .filter(|(key, _)| !gone.iter().any(|g| g == key))
            .map(|(key, value)| (key.to_owned(), value.clone()))
            .collect();
        self.states.lock().expect("the states").insert(
            skills_dir.to_owned(),
            SkillInstallState {
                status: "missing".into(),
                path: skill_file(skills_dir),
                installed_version: None,
                older: None,
            },
        );
        true
    }

    fn build_skill_zip(&self, bundled: &BundledSkill) -> Result<Vec<u8>, String> {
        self.log(json!([
            "agentSkills.buildSkillZip",
            bundled.version,
            bundled.sha256
        ]));
        if let Some(message) = self.case["zipError"].as_str() {
            return Err(message.to_owned());
        }
        Ok(format!("zip:{}:{}", bundled.version, bundled.sha256).into_bytes())
    }

    fn inspect_cli_link(&self, launcher: &str) -> JsonValue {
        self.log(json!(["agentSkills.inspectCliLink", launcher]));
        match &self.case["link"] {
            Value::Object(_) => json_value(&self.case["link"]),
            _ => json_value(&json!({ "status": "missing" })),
        }
    }
}
