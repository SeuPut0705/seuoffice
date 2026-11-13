//! `apps/shell/src/main/agent/agent-skills.ts`: the person's skills in the
//! agent window (spec 6.2 to 6.5), on the main process side: which
//! skills-management calls the agent window may make, the session's skills as
//! the window's `/` list needs them, the skill card a session's
//! `propose_skill` asks for, its template candidates, and whether a candidate
//! can be saved as it is.
//!
//! Promises are plain calls and the file system is the host's (`std::fs`,
//! the calls Node's promises API makes). `process.platform` comes from the
//! caller (`platform`, Node's name for it). The one JavaScript library the
//! TypeScript reaches, JSZip over a deck for [`template_redaction_of`], is
//! the [`DeckArchive`] the caller implements: engine-waiting, `ooxml-pkg`'s
//! `load_package` with the `PPTX_ZIP_LIMITS` figures is the implementation
//! stage 3 hands in.

use std::collections::HashMap;
use std::fs;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use jscompat::node_path::host::{basename, dirname, extname, is_absolute, join, resolve};
use jscompat::{JsonValue, js_regex, slice_utf16, sort_by_number, text_decoder_decode};
use serde::Serialize;

use crate::node_fs::namespaced;
use crate::packages::agent_core::redact_range::REDACT_NAMESPACES;
use crate::packages::ai_provider::agent_session_policy::{comparable_path, is_inside_path};
use crate::packages::ai_provider::agent_session_skills::AGENT_SKILL_PLUGIN_NAME;
use crate::packages::ai_provider::user_skill_md::{
    IEUM_TEMPLATE_KEY, MAX_USER_SKILL_BYTES, USER_SKILL_PRIORITY, is_inside_codex_home,
    is_reserved_user_skill_name, normalize_skill_template_path, parse_skill_md,
};
use crate::packages::ai_provider::user_skills_states::skill_editors_of;
use crate::packages::electron_utils::generate_handoff::handoff_editor_for_file;
use crate::packages::electron_utils::user_skills_channels::USER_SKILLS_CHANNELS;

// ---- the management gate ----------------------------------------------

/// the channel of `USER_SKILLS_CHANNELS[key]`
fn user_skills_channel(key: &str) -> &'static str {
    USER_SKILLS_CHANNELS
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, channel)| *channel)
        .expect("a key of USER_SKILLS_CHANNELS")
}

/// `AGENT_WINDOW_MANAGE_CHANNELS`, in the order the `Set` holds them
pub fn agent_window_manage_channels() -> [&'static str; 5] {
    [
        user_skills_channel("importGitHub"),
        user_skills_channel("readImport"),
        user_skills_channel("readImportFile"),
        user_skills_channel("cancelImport"),
        user_skills_channel("install"),
    ]
}

/// the `windows` of `userSkillsManageGate`: which senders are which window
pub trait ManageWindows<S> {
    fn is_main_window(&self, sender: &S) -> bool;
    fn is_agent_window(&self, sender: &S) -> bool;
}

/// `userSkillsManageGate(windows)`: the `canManage` gate of the skills
/// channels, the main window, and the agent window for its preview
pub fn user_skills_manage_gate<'a, S, W: ManageWindows<S>>(
    windows: &'a W,
) -> impl Fn(&S, &str) -> bool + 'a {
    move |sender, channel| {
        windows.is_main_window(sender)
            || (windows.is_agent_window(sender)
                && agent_window_manage_channels().contains(&channel))
    }
}

// ---- the session's skills -----------------------------------------------

/// `AgentSkillEntry` of `packages/ai-provider/src/agent-session/skills.ts`,
/// a skill as it is in the session's copy
#[derive(Debug, Clone, PartialEq)]
pub struct AgentSkillEntry {
    pub id: String,
    pub name: String,
    pub source: String,
    pub plugin: Option<String>,
    pub title: String,
    pub description: String,
    pub invoke: String,
    /// the copy's SKILL.md
    pub skill_md: String,
}

/// `AgentSessionSkill`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSkill {
    pub id: String,
    pub name: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    pub title: String,
    pub description: String,
    pub invoke: String,
    pub skill_md: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
}

/// `templateRelOf`: a template path as a skill names it, under `assets/`
fn template_rel_of(value: Option<&str>) -> Option<Vec<String>> {
    normalize_skill_template_path(value).map(|path| path.split('/').map(str::to_owned).collect())
}

/// the path of the template a skill's SKILL.md names, when that file is there
fn template_of(entry: &AgentSkillEntry) -> Option<String> {
    // `readFile(entry.skillMd, 'utf8')`
    let bytes = fs::read(namespaced(&entry.skill_md)).ok()?;
    // a throw inside the `try` of the TypeScript is no template
    let parsed = parse_skill_md(&String::from_utf8_lossy(&bytes)).ok()?;
    let rel = template_rel_of(
        parsed
            .as_ref()
            .and_then(|skill| skill.metadata.get(IEUM_TEMPLATE_KEY))
            .map(String::as_str),
    )?;
    let dir = dirname(&entry.skill_md);
    let mut parts: Vec<&str> = vec![dir.as_str()];
    parts.extend(rel.iter().map(String::as_str));
    let path = join(&parts);
    let info = fs::metadata(namespaced(&path)).ok()?;
    info.is_file().then_some(path)
}

/// `agentSessionSkillsOf(entries)`: each bundle entry with the absolute path
/// of its copied template, when its SKILL.md names one that is there
pub fn agent_session_skills_of(entries: &[AgentSkillEntry]) -> Vec<AgentSessionSkill> {
    entries
        .iter()
        .map(|entry| AgentSessionSkill {
            id: entry.id.clone(),
            name: entry.name.clone(),
            source: entry.source.clone(),
            plugin: entry.plugin.clone(),
            title: entry.title.clone(),
            description: entry.description.clone(),
            invoke: entry.invoke.clone(),
            skill_md: entry.skill_md.clone(),
            template: template_of(entry),
        })
        .collect()
}

// ---- the skill card ------------------------------------------------------

/// `AgentSkillListEntry`: one skill of the list as the card's target needs it
#[derive(Debug, Clone, PartialEq)]
pub struct AgentSkillListEntry {
    pub id: String,
    pub source: String,
    pub name: String,
    pub title: String,
    pub owned: bool,
    pub unreadable: Option<JsonValue>,
    /// where the skill is used (the list's value); absent: every editor
    pub editors: Option<JsonValue>,
}

/// `AgentSessionSkillName`: a skill of the session's copy, by identifier and name there
#[derive(Debug, Clone, PartialEq)]
pub struct AgentSessionSkillName {
    pub id: String,
    pub name: String,
}

/// `AgentSkillProposalInput` of agent-mcp.ts: what `propose_skill` hands over
#[derive(Debug, Clone, PartialEq)]
pub struct AgentSkillProposalInput {
    pub title: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub wants_template: bool,
    pub target_id: String,
    pub suggested_template_path: String,
}

/// the `target` of `SkillProposal`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkillProposalTarget {
    pub id: String,
    pub name: String,
    pub title: String,
    pub owned: bool,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editors: Option<Vec<&'static str>>,
}

/// `SkillProposal` of `packages/agent-core/src/user-skills-skill.ts`, a skill
/// the model asked to make or change; its `editors` is never set here
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillProposal {
    pub key: String,
    pub title: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub wants_template: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<SkillProposalTarget>,
}

/// `AgentSkillProposalResult`: the card, or why not (words for the model)
#[derive(Debug, Clone, PartialEq)]
pub enum AgentSkillProposalResult {
    Ok(Box<SkillProposal>),
    Refused(String),
}

/// `priorityOf`
fn priority_of(entry: &AgentSkillListEntry) -> usize {
    USER_SKILL_PRIORITY
        .iter()
        .position(|source| *source == entry.source)
        .unwrap_or(USER_SKILL_PRIORITY.len())
}

/// `targetEntryOf`: the skill a change names, by its identifier or by its
/// name in the session's copy
fn target_entry_of<'a>(
    target_id: &str,
    list: &'a [AgentSkillListEntry],
    session_skills: &[AgentSessionSkillName],
) -> Option<&'a AgentSkillListEntry> {
    let shown: Vec<&AgentSkillListEntry> = list
        .iter()
        .filter(|skill| !is_reserved_user_skill_name(&skill.name))
        .collect();
    if let Some(by_id) = shown.iter().find(|skill| skill.id == target_id).copied() {
        return Some(by_id);
    }
    let prefix = format!("{AGENT_SKILL_PLUGIN_NAME}:");
    let bare = if target_id.to_lowercase().starts_with(&prefix) {
        slice_utf16(target_id, prefix.encode_utf16().count() as f64, None)
    } else {
        target_id.to_owned()
    };
    let wanted = bare.to_lowercase();
    if let Some(in_session) = session_skills
        .iter()
        .find(|skill| skill.name.to_lowercase() == wanted)
    {
        return shown
            .iter()
            .find(|skill| skill.id == in_session.id)
            .copied();
    }
    if bare != target_id {
        return shown.iter().find(|skill| skill.id == bare).copied();
    }
    let mut named: Vec<&AgentSkillListEntry> = shown
        .into_iter()
        .filter(|skill| skill.name.to_lowercase() == wanted)
        .collect();
    sort_by_number(&mut named, |a, b| {
        priority_of(a) as f64 - priority_of(b) as f64
    });
    named.first().copied()
}

/// `agentSkillProposalOf(input, list, key, sessionSkills)`: the card a
/// `propose_skill` call asks for, or why not
pub fn agent_skill_proposal_of(
    input: &AgentSkillProposalInput,
    list: &[AgentSkillListEntry],
    key: &str,
    session_skills: &[AgentSessionSkillName],
) -> AgentSkillProposalResult {
    let mut target = None;
    if !input.target_id.is_empty() {
        let Some(entry) = target_entry_of(&input.target_id, list, session_skills) else {
            return AgentSkillProposalResult::Refused(format!(
                "No skill named {}. Give the skill's name as listed in this session, or its id, or leave targetId out to propose a new skill.",
                input.target_id
            ));
        };
        if entry.source == "project" {
            return AgentSkillProposalResult::Refused(format!(
                "{} is a skill of the project folder; change its files there instead.",
                input.target_id
            ));
        }
        if entry.unreadable.as_ref().is_some_and(JsonValue::truthy) {
            return AgentSkillProposalResult::Refused(format!(
                "The skill {} cannot be read.",
                input.target_id
            ));
        }
        target = Some(SkillProposalTarget {
            id: entry.id.clone(),
            name: entry.name.clone(),
            title: if entry.title.is_empty() {
                entry.name.clone()
            } else {
                entry.title.clone()
            },
            owned: entry.owned,
            source: entry.source.clone(),
            editors: skill_editors_of(entry.editors.as_ref().unwrap_or(&JsonValue::Null)),
        });
    }
    AgentSkillProposalResult::Ok(Box::new(SkillProposal {
        key: key.to_owned(),
        title: input.title.clone(),
        name: input.name.clone(),
        description: input.description.clone(),
        body: input.body.clone(),
        wants_template: input.wants_template,
        target,
    }))
}

// ---- template candidates -----------------------------------------------

/// `AgentTemplateCandidate`: a template candidate with its path, kept in the
/// main process
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTemplateCandidate {
    pub id: String,
    pub path: String,
    pub title: String,
    pub file_name: String,
    /// `"tab"` or `"project"`
    pub from: &'static str,
    pub unsaved: bool,
}

/// `AgentTemplateCandidateView`: what the window sees of a candidate
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTemplateCandidateView {
    pub id: String,
    pub title: String,
    pub file_name: String,
    pub from: &'static str,
    pub unsaved: bool,
}

/// `AgentOpenTab`: a document open in a tab, as the candidates need it
#[derive(Debug, Clone, PartialEq)]
pub struct AgentOpenTab {
    pub title: String,
    pub file_path: Option<String>,
    pub dirty: bool,
}

/// `MAX_PROJECT_TEMPLATE_FILES`: project files offered at most
pub const MAX_PROJECT_TEMPLATE_FILES: usize = 100;
/// `MAX_PROJECT_TEMPLATE_DEPTH`: folder levels under the project folder that are looked through
pub const MAX_PROJECT_TEMPLATE_DEPTH: usize = 4;
/// `MAX_PROJECT_ENTRIES_SEEN`: folder entries looked at in all
const MAX_PROJECT_ENTRIES_SEEN: usize = 5_000;

/// `isTemplateFile`: a file the app's editors open as a document, not a lock
/// or temporary file
fn is_template_file(name: &str) -> bool {
    handoff_editor_for_file(name).is_some() && !name.starts_with("~$") && !name.starts_with('.')
}

static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    Collator::try_new(CollatorPreferences::default(), CollatorOptions::default())
        .expect("the compiled root collation")
});

/// `a.localeCompare(b)`, in the root collation
fn locale_compare(a: &str, b: &str) -> f64 {
    match COLLATOR.compare(a, b) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    }
}

/// `limits` of `projectTemplateFiles`: a figure not given is the default
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ProjectTemplateLimits {
    pub files: Option<f64>,
    pub depth: Option<f64>,
}

/// what a folder entry is, as `readdir` with file types answers
#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    Link,
    Dir,
    File,
    Other,
}

/// `readdir(dir, { withFileTypes: true })`, `None` where it throws
fn read_entries(dir: &str) -> Option<Vec<(String, EntryKind)>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(namespaced(dir)).ok()? {
        let entry = entry.ok()?;
        let kind = match entry.file_type() {
            Ok(kind) if kind.is_symlink() => EntryKind::Link,
            Ok(kind) if kind.is_dir() => EntryKind::Dir,
            Ok(kind) if kind.is_file() => EntryKind::File,
            _ => EntryKind::Other,
        };
        entries.push((entry.file_name().to_string_lossy().into_owned(), kind));
    }
    Some(entries)
}

/// `projectTemplateFiles(projectRoot, limits)`: project files the editors
/// open, nearest first; hidden folders and links are not entered
pub fn project_template_files(project_root: &str, limits: &ProjectTemplateLimits) -> Vec<String> {
    let max_files = limits.files.unwrap_or(MAX_PROJECT_TEMPLATE_FILES as f64);
    let max_depth = limits.depth.unwrap_or(MAX_PROJECT_TEMPLATE_DEPTH as f64);
    let mut found: Vec<String> = Vec::new();
    let mut seen = 0usize;
    let mut level = vec![project_root.to_owned()];
    let mut depth = 0.0;
    while depth <= max_depth && !level.is_empty() {
        let mut next: Vec<String> = Vec::new();
        for dir in &level {
            let Some(mut entries) = read_entries(dir) else {
                continue;
            };
            sort_by_number(&mut entries, |a, b| locale_compare(&a.0, &b.0));
            for (name, kind) in &entries {
                seen += 1;
                if seen > MAX_PROJECT_ENTRIES_SEEN || found.len() as f64 >= max_files {
                    return found;
                }
                match kind {
                    EntryKind::Link => {}
                    EntryKind::Dir => {
                        if !name.starts_with('.') && name != "node_modules" {
                            next.push(join(&[dir, name]));
                        }
                    }
                    EntryKind::File if is_template_file(name) => {
                        found.push(join(&[dir, name]));
                    }
                    EntryKind::File | EntryKind::Other => {}
                }
            }
        }
        level = next;
        depth += 1.0;
    }
    found
}

/// `titleOfFile`: the file's name without its extension
fn title_of_file(path: &str) -> String {
    let name = basename(path, None);
    let extension = extname(&name);
    let stem = &name[..name.len() - extension.len()];
    if stem.is_empty() {
        name
    } else {
        stem.to_owned()
    }
}

/// `realpath(path).catch(() => undefined)`
fn real_path(path: &str) -> Option<String> {
    let real = fs::canonicalize(namespaced(path)).ok()?;
    let text = real.to_string_lossy().into_owned();
    // the verbatim form std gives on Windows is not what Node's realpath answers
    #[cfg(windows)]
    if let Some(plain) = text.strip_prefix(r"\\?\")
        && !plain.starts_with("UNC\\")
    {
        return Some(plain.to_owned());
    }
    Some(text)
}

/// the `candidates` and `known` of `agentTemplateCandidates` with its `add`
struct CandidateSet<'a> {
    platform: &'a str,
    candidates: Vec<AgentTemplateCandidate>,
    /// comparable path -> index into `candidates`
    known: HashMap<String, usize>,
}

impl CandidateSet<'_> {
    /// `key(path)`
    fn key(&self, path: &str) -> String {
        comparable_path(path, path, Some(self.platform))
    }

    fn add(&mut self, path: &str, from: &'static str, unsaved: bool, title: Option<&str>) {
        let key = self.key(path);
        if self.known.contains_key(&key) {
            return;
        }
        let candidate = AgentTemplateCandidate {
            id: format!("c{}", self.candidates.len()),
            path: path.to_owned(),
            title: match title {
                Some(title) if !title.is_empty() => title.to_owned(),
                _ => title_of_file(path),
            },
            file_name: basename(path, None),
            from,
            unsaved,
        };
        self.known.insert(key, self.candidates.len());
        self.candidates.push(candidate);
    }

    /// `known.get(key(path))?.id`
    fn id_of(&self, path: &str) -> Option<String> {
        self.known
            .get(&self.key(path))
            .map(|at| self.candidates[*at].id.clone())
    }
}

/// the `options` of `agentTemplateCandidates`
#[derive(Debug, Clone, Copy)]
pub struct TemplateCandidateOptions<'a> {
    pub project_root: &'a str,
    pub tabs: &'a [AgentOpenTab],
    pub suggested: &'a str,
    /// `process.platform`
    pub platform: &'a str,
    pub project_files: Option<&'a [String]>,
}

/// `agentTemplateCandidates(options)`: the documents a card offers as the
/// template (spec 6.3): those open in tabs, then the project folder's files
/// the editors open, each once; and the one the model suggested, when it names
/// a candidate or a document file of the project folder
pub fn agent_template_candidates(
    options: &TemplateCandidateOptions<'_>,
) -> (Vec<AgentTemplateCandidate>, Option<String>) {
    let platform = options.platform;
    let mut set = CandidateSet {
        platform,
        candidates: Vec::new(),
        known: HashMap::new(),
    };
    for tab in options.tabs {
        if let Some(path) = tab.file_path.as_deref().filter(|path| !path.is_empty())
            && is_absolute(path)
            && is_template_file(&basename(path, None))
        {
            set.add(path, "tab", tab.dirty, Some(&title_of_file(path)));
        }
    }
    let listed;
    let files: &[String] = match options.project_files {
        Some(files) => files,
        None => {
            listed =
                project_template_files(options.project_root, &ProjectTemplateLimits::default());
            &listed
        }
    };
    for path in files {
        set.add(path, "project", false, None);
    }

    let mut selected = None;
    let suggested = options.suggested;
    if !suggested.is_empty() {
        let full = if is_absolute(suggested) {
            suggested.to_owned()
        } else {
            resolve(&[options.project_root, suggested])
        };
        if let Some(id) = set.id_of(&full) {
            selected = Some(id);
        } else {
            let root = set.key(options.project_root);
            // inside the project folder as written and where it really is: a link leading out is refused
            let real_root = real_path(options.project_root);
            let real = real_path(&full);
            let inside = is_inside_path(&set.key(&full), &root, Some(platform))
                && match (&real_root, &real) {
                    (Some(real_root), Some(real)) if !real_root.is_empty() && !real.is_empty() => {
                        is_inside_path(&set.key(real), &set.key(real_root), Some(platform))
                    }
                    _ => false,
                };
            let is_file = inside && fs::metadata(namespaced(&full)).is_ok_and(|s| s.is_file());
            if inside && is_file && is_template_file(&basename(&full, None)) {
                set.add(&full, "project", false, None);
                selected = set.id_of(&full);
            }
        }
    }
    (set.candidates, selected)
}

/// `candidateView(candidate)`: what the window sees of a candidate, no path
pub fn candidate_view(candidate: &AgentTemplateCandidate) -> AgentTemplateCandidateView {
    AgentTemplateCandidateView {
        id: candidate.id.clone(),
        title: candidate.title.clone(),
        file_name: candidate.file_name.clone(),
        from: candidate.from,
        unsaved: candidate.unsaved,
    }
}

// ---- redaction marks ---------------------------------------------------

/// `PPTX_REDACT_EXT_URI`: the extension URI of the deck engine's redaction mark
const PPTX_REDACT_EXT_URI: &str = "{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}";

/// `AgentTemplateRedaction`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TemplateRedaction {
    None,
    Redacted,
    Unknown,
}

impl TemplateRedaction {
    pub fn as_str(self) -> &'static str {
        match self {
            TemplateRedaction::None => "none",
            TemplateRedaction::Redacted => "redacted",
            TemplateRedaction::Unknown => "unknown",
        }
    }
}

/// one entry of `Object.values(zip.files)`
#[derive(Debug, Clone, PartialEq)]
pub struct DeckEntry {
    pub name: String,
    pub dir: bool,
}

/// What the deck check reads of JSZip (engine-waiting)
pub trait DeckArchive {
    /// `assertZipInflatesWithinLimits(bytes, PPTX_ZIP_LIMITS)` then
    /// `JSZip.loadAsync(bytes)`: the entries `Object.values(zip.files)` holds,
    /// in that order. `Err` is any throw.
    fn open(&mut self, bytes: &[u8]) -> Result<Vec<DeckEntry>, String>;
    /// `entry.async('string')` of the entry at `index`; `Err` is any throw
    fn text(&mut self, index: usize) -> Result<String, String>;
}

/// `templateRedactionOf(fileName, bytes, openInTab)`: whether a document file
/// holds redaction marks, with the recognizers the editors use. A deck that
/// cannot be read is not known; unknown is never saved as it is.
pub fn template_redaction_of(
    file_name: &str,
    bytes: &[u8],
    open_in_tab: bool,
    deck: &mut dyn DeckArchive,
) -> TemplateRedaction {
    let extension = extname(file_name).get(1..).unwrap_or("").to_lowercase();
    match extension.as_str() {
        "md" | "markdown" | "txt" | "json" => {
            if js_regex!(r"data-redaction", "i").test(&text_decoder_decode(bytes)) {
                TemplateRedaction::Redacted
            } else {
                TemplateRedaction::None
            }
        }
        "html" | "htm" => {
            if js_regex!(r"data-gx-redact|gx:redact:", "i").test(&text_decoder_decode(bytes)) {
                TemplateRedaction::Redacted
            } else {
                TemplateRedaction::None
            }
        }
        "pptx" => {
            let Ok(entries) = deck.open(bytes) else {
                return TemplateRedaction::Unknown;
            };
            for (index, entry) in entries.iter().enumerate() {
                if entry.dir || !js_regex!(r"\.xml$", "i").test(&entry.name) {
                    continue;
                }
                let Ok(xml) = deck.text(index) else {
                    return TemplateRedaction::Unknown;
                };
                if REDACT_NAMESPACES.iter().any(|ns| xml.contains(ns))
                    || xml.contains(PPTX_REDACT_EXT_URI)
                {
                    return TemplateRedaction::Redacted;
                }
            }
            TemplateRedaction::None
        }
        "pdf" => {
            if open_in_tab {
                TemplateRedaction::Unknown
            } else {
                TemplateRedaction::None
            }
        }
        _ => TemplateRedaction::None,
    }
}

/// `TemplateReadGuard`: folders a candidate is never read from
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateReadGuard {
    pub home_dir: String,
    /// sign-in stores, the original app's folder, this app's folders (`agentProtectedPaths`)
    pub protected_paths: Vec<String>,
}

/// why a candidate was not read
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateReadRefusal {
    Unreadable,
    TooLarge,
}

impl TemplateReadRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            TemplateReadRefusal::Unreadable => "unreadable",
            TemplateReadRefusal::TooLarge => "too-large",
        }
    }
}

/// `isProtectedPath(path, guard)`: whether a path, as written or where it
/// really is, is in a protected folder or the Codex home
fn is_protected_path(path: &str, guard: &TemplateReadGuard, platform: &str) -> bool {
    let Some(real) = real_path(path) else {
        return true;
    };
    for at in [path, real.as_str()] {
        if is_inside_codex_home(at, &guard.home_dir) {
            return true;
        }
        for dir in &guard.protected_paths {
            if dir.is_empty() {
                continue;
            }
            let root = real_path(dir).unwrap_or_else(|| dir.clone());
            let mut bases = vec![dir.as_str()];
            if root != *dir {
                bases.push(&root);
            }
            for base in bases {
                if is_inside_path(
                    &comparable_path(at, at, Some(platform)),
                    &comparable_path(base, base, Some(platform)),
                    Some(platform),
                ) {
                    return true;
                }
            }
        }
    }
    false
}

/// `readTemplateCandidate(path, guard)`: a candidate's file, read whole;
/// refused when it is gone, larger than a skill may be, or (as written or
/// where it really is) inside a protected folder
pub fn read_template_candidate(
    path: &str,
    guard: &TemplateReadGuard,
    platform: &str,
) -> Result<Vec<u8>, TemplateReadRefusal> {
    if is_protected_path(path, guard, platform) {
        return Err(TemplateReadRefusal::Unreadable);
    }
    let info = fs::metadata(namespaced(path)).map_err(|_| TemplateReadRefusal::Unreadable)?;
    if !info.is_file() {
        return Err(TemplateReadRefusal::Unreadable);
    }
    if info.len() > MAX_USER_SKILL_BYTES {
        return Err(TemplateReadRefusal::TooLarge);
    }
    fs::read(namespaced(path)).map_err(|_| TemplateReadRefusal::Unreadable)
}
