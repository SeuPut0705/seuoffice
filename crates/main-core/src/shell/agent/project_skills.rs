//! `apps/shell/src/main/agent/project-skills.ts`: a project folder's own
//! skills in the agent window (decision 0064). They stay out of a session
//! until the person has seen the list for that folder and turned them on, and
//! out again once any of their files changes. What the person turned on is
//! kept per folder as a fingerprint of the skills' files (`agentProjectSkills`
//! in app-settings.json).
//!
//! `platform` is Node's `process.platform`, given by the caller.

use std::cmp::Ordering;
use std::fs;

use icu_collator::Collator;
use icu_collator::options::CollatorOptions;
use jscompat::node_path::host::{is_absolute, join, relative, resolve};
use jscompat::{JsObject, JsonValue, js_regex, truthy};
use sha2::{Digest, Sha256};

use super::agent_api::{AgentProjectSkillView, AgentProjectSkillsView};
use crate::node_fs::{NodeError, namespaced};
use crate::shell::app_settings::{read_app_settings, write_app_setting};

/// `ProjectSkillLike`: a project skill as the skills service lists it
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectSkillLike {
    pub id: String,
    pub name: String,
    pub title: String,
    pub description: String,
    pub dir: String,
    pub source: String,
}

pub const PROJECT_SKILLS_KEY: &str = "agentProjectSkills";

/// Bounds of one fingerprint: a folder past them is never "the same as before"
const MAX_FILES: i64 = 400;
const MAX_BYTES: u64 = 16 * 1024 * 1024;

/// `a.localeCompare(b)`: the root collation
fn locale_sorter() -> impl Fn(&str, &str) -> Ordering {
    let collator = Collator::try_new(Default::default(), CollatorOptions::default())
        .expect("the root collation is compiled in");
    move |a, b| collator.compare(a, b)
}

pub fn project_skills_of(skills: &[ProjectSkillLike]) -> Vec<ProjectSkillLike> {
    skills
        .iter()
        .filter(|skill| skill.source == "project")
        .cloned()
        .collect()
}

/// `filesOf(dir, budget)`: `None` where the TypeScript throws
fn files_of(
    dir: &str,
    budget: &mut i64,
    compare: &dyn Fn(&str, &str) -> Ordering,
) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    walk(dir, budget, compare, &mut out)?;
    Some(out)
}

fn walk(
    current: &str,
    budget: &mut i64,
    compare: &dyn Fn(&str, &str) -> Ordering,
    out: &mut Vec<String>,
) -> Option<()> {
    let mut entries: Vec<(String, fs::FileType)> = Vec::new();
    for entry in fs::read_dir(namespaced(current)).ok()? {
        let entry = entry.ok()?;
        entries.push((
            entry.file_name().to_string_lossy().into_owned(),
            entry.file_type().ok()?,
        ));
    }
    entries.sort_by(|a, b| compare(&a.0, &b.0));
    for (name, kind) in entries {
        let path = join(&[current, &name]);
        // links are not followed: the session's copy does not follow them either
        if fs::symlink_metadata(namespaced(&path))
            .ok()?
            .file_type()
            .is_symlink()
        {
            continue;
        }
        if kind.is_dir() {
            walk(&path, budget, compare, out)?;
        } else if kind.is_file() {
            *budget -= 1;
            if *budget < 0 {
                return None;
            }
            out.push(path);
        }
    }
    Some(())
}

/// The fingerprint of a folder's project skills: every file's place and
/// content. `None` when there are none, or when they cannot all be read within
/// the bounds (then nothing matches it and they stay off).
pub fn project_skills_fingerprint(skills: &[ProjectSkillLike]) -> Option<String> {
    if skills.is_empty() {
        return None;
    }
    let compare = locale_sorter();
    let mut sorted: Vec<&ProjectSkillLike> = skills.iter().collect();
    sorted.sort_by(|a, b| compare(&a.id, &b.id));
    let mut hash = Sha256::new();
    let mut budget = MAX_FILES;
    let mut bytes: u64 = 0;
    for skill in sorted {
        hash.update(format!("skill\0{}\0", skill.id).as_bytes());
        for file in files_of(&skill.dir, &mut budget, &compare)? {
            let content = fs::read(namespaced(&file)).ok()?;
            bytes += content.len() as u64;
            if bytes > MAX_BYTES {
                return None;
            }
            let place = relative(&skill.dir, &file).replace('\\', "/");
            hash.update(format!("{place}\0").as_bytes());
            hash.update(Sha256::digest(&content));
        }
    }
    Some(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn folder_key(folder: &str, platform: &str) -> String {
    let full = resolve(&[folder]);
    if platform == "win32" {
        full.to_lowercase()
    } else {
        full
    }
}

fn approvals_of(settings_path: &str) -> JsObject<String> {
    let settings = read_app_settings(settings_path);
    let mut out: JsObject<String> = JsObject::new();
    let Some(JsonValue::Object(raw)) = settings.get(PROJECT_SKILLS_KEY) else {
        return out;
    };
    for (key, value) in raw.entries() {
        if is_absolute(key)
            && let JsonValue::String(text) = value
            && js_regex!(r"^[0-9a-f]{64}$").test(text)
        {
            out.set(key, text.clone());
        }
    }
    out
}

/// The fingerprint the person turned on for this folder, if any
pub fn approved_fingerprint(settings_path: &str, folder: &str, platform: &str) -> Option<String> {
    approvals_of(settings_path)
        .get(&folder_key(folder, platform))
        .cloned()
}

pub fn write_project_skills_approval(
    settings_path: &str,
    folder: &str,
    fingerprint: Option<&str>,
    platform: &str,
) -> Result<(), NodeError> {
    let mut approvals = approvals_of(settings_path);
    let key = folder_key(folder, platform);
    match truthy(fingerprint) {
        Some(fingerprint) => approvals.set(key, fingerprint.to_owned()),
        None => {
            approvals = approvals
                .entries()
                .into_iter()
                .filter(|(known, _)| *known != key)
                .map(|(known, value)| (known.to_owned(), value.clone()))
                .collect();
        }
    }
    let mut value: JsObject<JsonValue> = JsObject::new();
    for (known, fingerprint) in approvals.entries() {
        value.set(known, JsonValue::String(fingerprint.clone()));
    }
    write_app_setting(
        settings_path,
        PROJECT_SKILLS_KEY,
        Some(JsonValue::Object(value)),
    )
}

/// Whether a session in this folder may carry its project skills right now
pub fn project_skills_allowed(
    settings_path: &str,
    folder: &str,
    skills: &[ProjectSkillLike],
    platform: &str,
) -> bool {
    let Some(approved) = approved_fingerprint(settings_path, folder, platform) else {
        return false;
    };
    project_skills_fingerprint(&project_skills_of(skills)).as_deref() == Some(approved.as_str())
}

/// What the start screen shows for a folder
pub fn project_skills_view(
    settings_path: &str,
    folder: &str,
    skills: &[ProjectSkillLike],
    platform: &str,
) -> AgentProjectSkillsView {
    let own = project_skills_of(skills);
    let fingerprint = project_skills_fingerprint(&own);
    let approved = approved_fingerprint(settings_path, folder, platform);
    AgentProjectSkillsView {
        skills: own
            .iter()
            .map(|skill| AgentProjectSkillView {
                name: skill.name.clone(),
                title: skill.title.clone(),
                description: skill.description.clone(),
            })
            .collect(),
        allowed: fingerprint.is_some() && approved == fingerprint,
        changed: approved.is_some() && fingerprint.is_some() && approved != fingerprint,
    }
}

/// Turn a folder's skills on (as they are now) or off; returns the view after
pub fn set_project_skills(
    settings_path: &str,
    folder: &str,
    skills: &[ProjectSkillLike],
    on: bool,
    platform: &str,
) -> Result<AgentProjectSkillsView, NodeError> {
    let fingerprint = if on {
        project_skills_fingerprint(&project_skills_of(skills))
    } else {
        None
    };
    write_project_skills_approval(settings_path, folder, fingerprint.as_deref(), platform)?;
    Ok(project_skills_view(settings_path, folder, skills, platform))
}
