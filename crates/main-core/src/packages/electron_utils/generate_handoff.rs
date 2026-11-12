//! `packages/electron-utils/src/generate-handoff.ts`.
//!
//! The generate hand-off: "make" leaves the request for the new tab, and the
//! editor in that tab takes it, once. The TypeScript keeps its store in a
//! `Symbol.for` key of `globalThis`, shared by every bundled copy of the
//! module; here the owner keeps one [`HandoffStore`] for the process.
//! `Date.now()` is the `now_ms` of the call, `process.platform` the `win32`
//! flag of the store, `path.resolve` the host's.

use jscompat::node_path::host::resolve;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use super::handoff_editors::{
    HANDOFF_EDITORS, HandoffEditor, handoff_editor_takes_attachments, is_handoff_editor,
};

/// the editor of each document extension a template may have (spec 5.7)
const EDITOR_BY_EXTENSION: [(&str, HandoffEditor); 17] = [
    ("docx", HandoffEditor::Docs),
    ("odt", HandoffEditor::Docs),
    ("xlsx", HandoffEditor::Sheets),
    ("xlsm", HandoffEditor::Sheets),
    ("xls", HandoffEditor::Sheets),
    ("csv", HandoffEditor::Sheets),
    ("tsv", HandoffEditor::Sheets),
    ("pptx", HandoffEditor::Slides),
    ("pdf", HandoffEditor::Pdf),
    ("md", HandoffEditor::Markdown),
    ("markdown", HandoffEditor::Markdown),
    ("txt", HandoffEditor::Markdown),
    ("html", HandoffEditor::Html),
    ("htm", HandoffEditor::Html),
    ("xmind", HandoffEditor::Mindmap),
    ("hwp", HandoffEditor::Hwp),
    ("hwpx", HandoffEditor::Hwp),
];

/// the editor that opens a file of this name (a path is fine), or `None`
pub fn handoff_editor_for_file(file_name: &str) -> Option<HandoffEditor> {
    // `fileName.split(/[\\/]/).pop() ?? ''`
    let base = file_name.rsplit(['\\', '/']).next().unwrap_or("");
    // `lastIndexOf('.')` in UTF-16 units: `dot <= 0 || dot === base.length - 1`
    let dot = base.rfind('.')?;
    if dot == 0 || dot == base.len() - 1 {
        return None;
    }
    let extension = base[dot + 1..].to_lowercase();
    EDITOR_BY_EXTENSION
        .iter()
        .find(|(name, _)| *name == extension)
        .map(|(_, editor)| *editor)
}

/// the editors the generate window's "make" opens
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GenerateHandoffTarget {
    #[serde(rename = "slides")]
    Slides,
    #[serde(rename = "html")]
    Html,
    #[serde(rename = "mindmap")]
    Mindmap,
}

impl GenerateHandoffTarget {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "slides" => Some(Self::Slides),
            "html" => Some(Self::Html),
            "mindmap" => Some(Self::Mindmap),
            _ => None,
        }
    }
}

/// the editors a conversion's result opens in, as a new unsaved tab
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GenerateConvertTarget {
    #[serde(rename = "markdown")]
    Markdown,
    #[serde(rename = "slides")]
    Slides,
    #[serde(rename = "mindmap")]
    Mindmap,
}

/// the conversions without AI (8.6)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GenerateConvertKind {
    #[serde(rename = "mindmap-to-markdown")]
    MindmapToMarkdown,
    #[serde(rename = "mindmap-to-slides")]
    MindmapToSlides,
    #[serde(rename = "markdown-to-mindmap")]
    MarkdownToMindmap,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Material {
    pub path: String,
    pub name: String,
}

/// What a new tab takes, once (8.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenerateHandoff {
    /// unique per press of "make"
    pub id: String,
    pub mode: String,
    pub target: GenerateHandoffTarget,
    /// the readable materials, in the order the window listed them
    pub materials: Vec<Material>,
    /// the user's words, or the kind's default request when they wrote none
    pub text: String,
    /// true when `text` is the default request (the box was left empty)
    #[serde(rename = "defaultText")]
    pub default_text: bool,
    /// when "make" was pressed, ms since epoch
    #[serde(rename = "createdAt")]
    pub created_at: f64,
}

/// one "a run started with handed-over material" record
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GenerateRunStarted {
    #[serde(rename = "tabId", skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(rename = "webContentsId")]
    pub web_contents_id: f64,
    pub target: GenerateHandoffTarget,
    pub mode: String,
    /// the handed-over material paths that were attached to the run
    pub sources: Vec<String>,
    /// every material the hand-off carried, attached or not
    #[serde(rename = "handedOver")]
    pub handed_over: Vec<String>,
    #[serde(rename = "handoffId")]
    pub handoff_id: String,
    /// ms since epoch
    pub at: f64,
}

/// one "a conversion without AI opened this new tab" record (8.6, spec 9)
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GenerateConverted {
    #[serde(rename = "tabId", skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(rename = "webContentsId")]
    pub web_contents_id: f64,
    pub target: GenerateConvertTarget,
    pub kind: GenerateConvertKind,
    pub mode: String,
    pub sources: Vec<String>,
    #[serde(rename = "conversionId")]
    pub conversion_id: String,
    pub at: f64,
}

/// a skill chip as it travels with a hand-off
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HandoffSkillChip {
    pub id: String,
    pub source: String,
    pub title: String,
}

/// What a new tab's AI panel takes, once (spec 5.6, 5.7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillHandoff {
    pub id: String,
    pub mode: String,
    pub target: HandoffEditorName,
    pub text: String,
    pub chips: Vec<HandoffSkillChip>,
    /// the template preview (`SkillHandoffPreview`), plain data this module does not read
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<Value>,
    /// the asking tab's saved document (its path)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attach: Option<Vec<String>>,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
}

/// A [`HandoffEditor`] as the JSON of a hand-off names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandoffEditorName(pub HandoffEditor);

impl Serialize for HandoffEditorName {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0.as_str())
    }
}

impl<'de> Deserialize<'de> for HandoffEditorName {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        HandoffEditor::parse(&text)
            .map(HandoffEditorName)
            .ok_or_else(|| serde::de::Error::custom("not a hand-off editor"))
    }
}

/// `new Map<number, V>()`: insertion order, a key set again keeps its place
/// (keys are `SameValueZero`).
#[derive(Debug, Clone)]
struct IdMap<V>(Vec<(f64, V)>);

impl<V> IdMap<V> {
    fn new() -> Self {
        IdMap(Vec::new())
    }

    fn at(&self, id: f64) -> Option<usize> {
        self.0
            .iter()
            .position(|(key, _)| *key == id || (key.is_nan() && id.is_nan()))
    }

    fn get(&self, id: f64) -> Option<&V> {
        self.at(id).map(|i| &self.0[i].1)
    }

    fn set(&mut self, id: f64, value: V) {
        match self.at(id) {
            Some(i) => self.0[i].1 = value,
            None => self.0.push((id, value)),
        }
    }

    fn delete(&mut self, id: f64) -> Option<V> {
        self.at(id).map(|i| self.0.remove(i).1)
    }
}

/// keep the in-memory event list bounded across a long session
const MAX_RUN_EVENTS: usize = 200;

/// `(webContentsId) => string | undefined`; `Err` is a resolver that throws
pub type TabIdResolver = dyn Fn(f64) -> Result<Option<String>, String>;

/// the part of a webContents this module needs (Electron's satisfies it)
pub trait HandoffWebContents {
    fn id(&self) -> f64;
    fn is_destroyed(&self) -> bool;
    /// `contents.once('destroyed', ...)`: when the event fires, the adapter
    /// calls [`HandoffStore::drop_generate_handoff`] with [`Self::id`]
    fn once_destroyed(&mut self);
}

/// one entry of `queuedSkillHandoffs()`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueuedSkillHandoff {
    #[serde(rename = "webContentsId")]
    pub web_contents_id: f64,
    pub target: HandoffEditorName,
    pub id: String,
}

/// one entry of `queuedGenerateHandoffs()`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueuedGenerateHandoff {
    #[serde(rename = "webContentsId")]
    pub web_contents_id: f64,
    pub target: GenerateHandoffTarget,
    pub id: String,
}

/// `HandoffStore`
pub struct HandoffStore {
    /// `process.platform === 'win32'`: path keys are compared in lower case
    pub win32: bool,
    queued: IdMap<GenerateHandoff>,
    skill_queued: IdMap<SkillHandoff>,
    /// taken but not yet reported as run: what a run-started report is checked against
    taken: IdMap<GenerateHandoff>,
    runs: Vec<GenerateRunStarted>,
    converted: Vec<GenerateConverted>,
    tab_id_of: Option<Box<TabIdResolver>>,
}

impl HandoffStore {
    pub fn new(win32: bool) -> Self {
        HandoffStore {
            win32,
            queued: IdMap::new(),
            skill_queued: IdMap::new(),
            taken: IdMap::new(),
            runs: Vec::new(),
            converted: Vec::new(),
            tab_id_of: None,
        }
    }

    fn path_key(&self, path: &str) -> String {
        let resolved = resolve(&[path]);
        if self.win32 {
            resolved.to_lowercase()
        } else {
            resolved
        }
    }

    /// queue a request for a webContents; replaces anything still queued there
    pub fn queue_generate_handoff(&mut self, web_contents_id: f64, handoff: GenerateHandoff) {
        self.taken.delete(web_contents_id);
        self.queued.set(web_contents_id, handoff);
    }

    /// queue for a live webContents, and drop the request when it goes away first
    pub fn queue_generate_handoff_for(
        &mut self,
        contents: &mut dyn HandoffWebContents,
        handoff: GenerateHandoff,
    ) {
        if contents.is_destroyed() {
            return;
        }
        let id = contents.id();
        self.queue_generate_handoff(id, handoff);
        contents.once_destroyed();
    }

    /// The receiving editor's one take. Returns the request queued for this
    /// webContents when it was made for `target`, and empties the slot; `None`
    /// for anything else (nothing queued, already taken, another kind).
    pub fn take_generate_handoff(
        &mut self,
        target: GenerateHandoffTarget,
        web_contents_id: f64,
    ) -> Option<GenerateHandoff> {
        let handoff = self.queued.get(web_contents_id)?;
        if handoff.target != target {
            return None;
        }
        let handoff = self.queued.delete(web_contents_id)?;
        self.taken.set(web_contents_id, handoff.clone());
        Some(handoff)
    }

    /// the tab closed (or its webContents went away): its request, taken or not, is gone
    pub fn drop_generate_handoff(&mut self, web_contents_id: f64) {
        self.queued.delete(web_contents_id);
        self.taken.delete(web_contents_id);
        self.skill_queued.delete(web_contents_id);
    }

    /// queue a skill hand-off for a webContents; replaces one still queued there
    pub fn queue_skill_handoff(&mut self, web_contents_id: f64, handoff: SkillHandoff) {
        self.skill_queued.set(web_contents_id, handoff);
    }

    /// queue for a live webContents, and drop the request when it goes away first
    pub fn queue_skill_handoff_for(
        &mut self,
        contents: &mut dyn HandoffWebContents,
        handoff: SkillHandoff,
    ) {
        if contents.is_destroyed() {
            return;
        }
        let id = contents.id();
        self.queue_skill_handoff(id, handoff);
        contents.once_destroyed();
    }

    /// The receiving editor's one take of a skill hand-off: the request queued
    /// for this webContents when it was made for `target`, and the slot is
    /// emptied; `None` for anything else.
    pub fn take_skill_handoff(
        &mut self,
        target: HandoffEditor,
        web_contents_id: f64,
    ) -> Option<SkillHandoff> {
        let handoff = self.skill_queued.get(web_contents_id)?;
        if handoff.target.0 != target {
            return None;
        }
        self.skill_queued.delete(web_contents_id)
    }

    /// the skill hand-offs waiting to be taken, for diagnostics; no request text
    pub fn queued_skill_handoffs(&self) -> Vec<QueuedSkillHandoff> {
        self.skill_queued
            .0
            .iter()
            .map(|(id, h)| QueuedSkillHandoff {
                web_contents_id: *id,
                target: h.target,
                id: h.id.clone(),
            })
            .collect()
    }

    /// what is waiting to be taken, for diagnostics; no request text
    pub fn queued_generate_handoffs(&self) -> Vec<QueuedGenerateHandoff> {
        self.queued
            .0
            .iter()
            .map(|(id, h)| QueuedGenerateHandoff {
                web_contents_id: *id,
                target: h.target,
                id: h.id.clone(),
            })
            .collect()
    }

    /// the shell tells this module how to name a tab from its webContents id
    pub fn set_generate_tab_id_resolver(&mut self, resolver: Option<Box<TabIdResolver>>) {
        self.tab_id_of = resolver;
    }

    /// `tabIdOf?.(id)`; `Err` is a resolver that throws
    fn tab_id(&self, web_contents_id: f64) -> Result<Option<String>, String> {
        match &self.tab_id_of {
            Some(resolver) => resolver(web_contents_id),
            None => Ok(None),
        }
    }

    /// The receiving editor reports that a run started in this tab with the
    /// given attachments. Recorded only when the tab took a hand-off for
    /// `target` and at least one of the attached paths is a handed-over
    /// material; each hand-off is recorded once (its first run). Returns the
    /// record, or `None` when nothing was recorded; `Err` is the resolver's
    /// throw, after the hand-off was already marked as run.
    pub fn report_generate_run_started(
        &mut self,
        target: GenerateHandoffTarget,
        web_contents_id: f64,
        attached_paths: &[String],
        now_ms: f64,
    ) -> Result<Option<GenerateRunStarted>, String> {
        let Some(handoff) = self.taken.get(web_contents_id) else {
            return Ok(None);
        };
        if handoff.target != target {
            return Ok(None);
        }
        let attached: Vec<String> = attached_paths.iter().map(|p| self.path_key(p)).collect();
        let sources: Vec<String> = handoff
            .materials
            .iter()
            .map(|m| m.path.clone())
            .filter(|path| attached.contains(&self.path_key(path)))
            .collect();
        if sources.is_empty() {
            return Ok(None);
        }
        let handed_over: Vec<String> = handoff.materials.iter().map(|m| m.path.clone()).collect();
        let mode = handoff.mode.clone();
        let handoff_id = handoff.id.clone();
        self.taken.delete(web_contents_id);
        let tab_id = self.tab_id(web_contents_id)?.filter(|id| !id.is_empty());
        let event = GenerateRunStarted {
            tab_id,
            web_contents_id,
            target,
            mode,
            sources,
            handed_over,
            handoff_id,
            at: now_ms,
        };
        self.runs.push(event.clone());
        if self.runs.len() > MAX_RUN_EVENTS {
            let excess = self.runs.len() - MAX_RUN_EVENTS;
            self.runs.drain(..excess);
        }
        Ok(Some(event))
    }

    /// the recorded run-started events, oldest first (a copy)
    pub fn generate_run_started_events(&self) -> Vec<GenerateRunStarted> {
        self.runs.clone()
    }

    /// The shell opened a new tab with the result of a conversion without AI
    /// (8.6) queued for it. Recorded at once: the conversion itself is done by
    /// then. `Err` is a resolver that throws.
    pub fn record_generate_converted(
        &mut self,
        web_contents_id: f64,
        target: GenerateConvertTarget,
        kind: GenerateConvertKind,
        sources: &[String],
        conversion_id: &str,
        now_ms: f64,
    ) -> Result<GenerateConverted, String> {
        let tab_id = self.tab_id(web_contents_id)?.filter(|id| !id.is_empty());
        let event = GenerateConverted {
            tab_id,
            web_contents_id,
            target,
            kind,
            mode: "convert".to_owned(),
            sources: sources.iter().filter(|p| !p.is_empty()).cloned().collect(),
            conversion_id: conversion_id.to_owned(),
            at: now_ms,
        };
        self.converted.push(event.clone());
        if self.converted.len() > MAX_RUN_EVENTS {
            let excess = self.converted.len() - MAX_RUN_EVENTS;
            self.converted.drain(..excess);
        }
        Ok(event)
    }

    /// the recorded conversions, oldest first (a copy)
    pub fn generate_converted_events(&self) -> Vec<GenerateConverted> {
        self.converted.clone()
    }

    /// tests only: forget everything
    pub fn reset_generate_handoffs_for_test(&mut self) {
        self.queued = IdMap::new();
        self.taken = IdMap::new();
        self.skill_queued = IdMap::new();
        self.runs.clear();
        self.converted.clear();
        self.tab_id_of = None;
    }
}
