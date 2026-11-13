//! `apps/shell/src/main/launch-recovery.ts`: the launch side of crash recovery
//! as decisions without Electron (spec 4, 5.1, 5.2, 5.3, 6, 8): which tabs
//! come back after an abnormal exit, which copies the launch list asks about,
//! what the list's answer does to the store and the strip, the list's IPC
//! semantics, the order of an OS shutdown, and how an MCP / `@` lookup treats
//! a restored tab that waits on the user.
//!
//! What the TypeScript does with promises and timers is explicit here:
//!
//! - [`LaunchListGate`] is a state machine. A `get()` that has to wait answers
//!   [`GateGet::Waiting`] and is counted; `publish`, `publish_none` and
//!   [`LaunchListGate::apply_finished`] say how many waiters they woke, each
//!   of which then reads [`LaunchListGate::current`]. `submit` hands the caller
//!   the answer to apply ([`GateSubmit::Apply`]); the caller runs its `apply`,
//!   calls [`LaunchListGate::applying_started`] once the synchronous part of
//!   it has returned, and [`LaunchListGate::apply_finished`] when it settles.
//! - [`OsSessionEnd`] starts the shutdown with [`OsSessionEnd::run`]; an
//!   editor's pending write settles with [`OsSessionEnd::write_settled`] and
//!   the timeout fires with [`OsSessionEnd::timer_fired`].
//!
//! Values that cross as JavaScript values (the Home screen's answer, the
//! session strip) are [`JsonValue`]s; the rest is typed.

use std::collections::{HashMap, HashSet};

use jscompat::node_path::host::{basename, dirname};
use jscompat::{JsObject, JsonValue, trim};

use crate::packages::electron_utils::recovery_store::{
    RecoveryCopyFilter, RecoveryCopyInfo, RecoveryCopyState, RecoveryFileIdentity,
    RecoveryIdentity, RecoveryLaunchDecision, RecoveryStore, RecoveryUntitledIdentity,
    is_recovery_editor_kind,
};
use crate::shell::renderer_disposal::Failure;
use crate::shell::session_record::{
    PreviousExitJudgment, SessionRecordReadResult, SessionUntitledCopy, session_restore_layout,
};

/// `LaunchCopy`: the part of a recovery copy's description the launch needs
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchCopy {
    pub identity: RecoveryIdentity,
    pub kind: String,
    /// `None` for an untitled document
    pub file_path: Option<String>,
    pub untitled_id: Option<String>,
    pub title: String,
    pub written_at: f64,
    pub state: RecoveryCopyState,
    pub file_changed_after_copy: bool,
    pub original_missing: bool,
    pub original_path: Option<String>,
}

impl From<&RecoveryCopyInfo> for LaunchCopy {
    fn from(info: &RecoveryCopyInfo) -> Self {
        LaunchCopy {
            identity: info.identity.clone(),
            kind: info.kind.clone(),
            file_path: info.file_path.clone(),
            untitled_id: info.untitled_id.clone(),
            title: info.title.clone(),
            written_at: info.written_at,
            state: info.state,
            file_changed_after_copy: info.file_changed_after_copy,
            original_missing: info.original_missing,
            original_path: info.original_path.clone(),
        }
    }
}

/// `LaunchCopySource`
pub trait LaunchCopySource {
    /// `listCopies(filter)`; an `Err` is a throw
    fn list_copies(&self, filter: &RecoveryCopyFilter) -> Result<Vec<LaunchCopy>, Failure>;
}

impl LaunchCopySource for RecoveryStore<'_> {
    fn list_copies(&self, filter: &RecoveryCopyFilter) -> Result<Vec<LaunchCopy>, Failure> {
        RecoveryStore::list_copies(self, filter)
            .map(|found| found.iter().map(LaunchCopy::from).collect())
            .map_err(|e| Failure(e.message))
    }
}

/// `PlannedOpen`: how a planned tab makes its editor view when it is first loaded
#[derive(Debug, Clone, PartialEq)]
pub enum PlannedOpen {
    /// the tab's file as a plain open: the editor settles any copy of it itself
    File,
    /// a copy opened as an untitled document (an untitled copy, or one whose
    /// original is gone)
    UntitledCopy {
        copy: RecoveryIdentity,
        save_as_default_path: Option<String>,
    },
}

/// `PlannedTab`: one document tab the launch puts in the strip, unloaded
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedTab {
    /// stable within one launch: front, split, remove and replace refer to it
    pub key: String,
    pub kind: String,
    pub title: String,
    pub file_path: Option<String>,
    pub open: PlannedOpen,
}

/// `PlannedSplit`
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedSplit {
    pub a: String,
    pub b: String,
    pub orientation: String,
    pub ratio: f64,
    /// `"a"` or `"b"`
    pub focus: String,
}

/// `RecoveryListItem`: one document with unsaved content left, as the list shows it
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryListItem {
    pub id: String,
    pub editor_kind: String,
    pub name: String,
    pub folder: Option<String>,
    pub last_copy_time: f64,
    pub untitled: bool,
    pub file_changed_after_copy: bool,
    pub original_missing: bool,
}

/// `RecoveryChoice`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryChoice {
    Restore,
    Discard,
}

impl RecoveryChoice {
    /// the choice as a store decision
    pub fn decision(self) -> RecoveryLaunchDecision {
        match self {
            RecoveryChoice::Restore => RecoveryLaunchDecision::Restore,
            RecoveryChoice::Discard => RecoveryLaunchDecision::Discard,
        }
    }
}

/// `RecoveryListResult`
#[derive(Debug, Clone, PartialEq)]
pub enum RecoveryListResult {
    /// a choice for every row the list showed, by row id
    Decisions(JsObject<RecoveryChoice>),
    /// the list was closed without choosing
    Dismissed,
}

/// `LaunchPlan`
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchPlan {
    /// the previous run ended abnormally: this run restores
    pub restore_run: bool,
    /// the previous run was a restore that died right away: nothing is loaded up front
    pub crash_loop: bool,
    /// nothing to rebuild or ask: today's launch
    pub plain_launch: bool,
    /// the strip to rebuild, in order
    pub tabs: Vec<PlannedTab>,
    /// the tab to load and bring forward (absent = Home)
    pub front: Option<String>,
    pub split: Option<PlannedSplit>,
    /// the launch list's rows; empty = no list
    pub items: Vec<RecoveryListItem>,
    /// the copy behind each row, by row id, in the order the rows were made
    pub copies: Vec<(String, LaunchCopy)>,
    /// files the launch was asked to open: last in the strip and in front
    pub launch_paths: Vec<String>,
}

impl LaunchPlan {
    /// `plan.copies.get(id)`
    pub fn copy_of(&self, id: &str) -> Option<&LaunchCopy> {
        self.copies
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, copy)| copy)
    }
}

/// `LaunchOutcome`
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchOutcome {
    /// the store decision for every row
    pub store_decisions: Vec<(RecoveryIdentity, RecoveryLaunchDecision)>,
    /// planned tabs to drop: untitled copies that were not restored
    pub remove: Vec<String>,
    /// planned tabs to swap in place, keeping their key
    pub replace: Vec<PlannedTab>,
    /// new tabs at the end of the strip: restored copies that had no tab
    pub append: Vec<PlannedTab>,
    pub front: Option<String>,
    pub split: Option<PlannedSplit>,
    /// open these files last; they end up in front
    pub launch_paths: Vec<String>,
    /// nothing else comes forward: run today's launch
    pub split_memory_or_home: bool,
}

/// `Pick<PreviousExitJudgment, 'abnormal' | 'crashLoop'>`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchJudgment {
    pub abnormal: bool,
    pub crash_loop: bool,
}

impl From<&PreviousExitJudgment> for LaunchJudgment {
    fn from(judgment: &PreviousExitJudgment) -> Self {
        LaunchJudgment {
            abnormal: judgment.abnormal,
            crash_loop: judgment.crash_loop,
        }
    }
}

/// `recoveryIdentityKey`: one key per document a copy belongs to (the store's
/// own identity)
pub fn recovery_identity_key(identity: &RecoveryIdentity) -> String {
    match identity {
        RecoveryIdentity::File(file) => format!("{}\u{0}file\u{0}{}", file.kind, file.file_path),
        RecoveryIdentity::Untitled(untitled) => {
            format!(
                "{}\u{0}untitled\u{0}{}",
                untitled.kind, untitled.untitled_id
            )
        }
    }
}

/// `saveAsDefaultOf`: the path an untitled copy opens with as its first Save As
fn save_as_default_of(copy: &LaunchCopy) -> Option<String> {
    copy.file_path
        .clone()
        .or_else(|| copy.original_path.clone())
        .filter(|path| !path.is_empty())
}

/// `untitledOpen`: an untitled copy opened from `copy`, with its first Save As
/// when it has one
fn untitled_open(copy: &LaunchCopy) -> PlannedOpen {
    PlannedOpen::UntitledCopy {
        copy: copy.identity.clone(),
        save_as_default_path: save_as_default_of(copy),
    }
}

/// `rowName`
fn row_name(copy: &LaunchCopy, fallback: Option<&str>) -> String {
    if let Some(path) = copy.file_path.as_deref().filter(|path| !path.is_empty()) {
        return basename(path, None);
    }
    let title = trim(&copy.title);
    if !title.is_empty() {
        return title.to_owned();
    }
    match fallback.filter(|fallback| !fallback.is_empty()) {
        Some(fallback) => fallback.to_owned(),
        None => copy.kind.clone(),
    }
}

fn add_rows(rows: &mut Vec<LaunchCopy>, seen: &mut HashSet<String>, copies: Vec<LaunchCopy>) {
    for copy in copies {
        let key = recovery_identity_key(&copy.identity);
        if !seen.insert(key) {
            continue;
        }
        rows.push(copy);
    }
}

/// `planLaunch`: what this launch rebuilds and asks.
///
/// - The list after an abnormal exit holds every undecided and restore-chosen
///   copy; after either kind of exit it holds the untitled "later" copies.
/// - After an abnormal exit the previous tabs come back unloaded. An untitled
///   tab comes back only while its copy is there. A crash loop keeps the strip
///   but loads nothing; a launch file takes the front instead of the previous
///   front tab and split.
pub fn plan_launch(
    judgment: &LaunchJudgment,
    previous: &SessionRecordReadResult,
    copies: &dyn LaunchCopySource,
    launch_paths: &[String],
) -> Result<LaunchPlan, Failure> {
    let launch_paths: Vec<String> = launch_paths.to_vec();

    let mut rows: Vec<LaunchCopy> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    if judgment.abnormal {
        add_rows(
            &mut rows,
            &mut seen,
            copies.list_copies(&RecoveryCopyFilter {
                states: Some(vec![
                    RecoveryCopyState::Undecided,
                    RecoveryCopyState::RestoreChosen,
                ]),
                ..RecoveryCopyFilter::default()
            })?,
        );
    }
    add_rows(
        &mut rows,
        &mut seen,
        copies.list_copies(&RecoveryCopyFilter {
            states: Some(vec![RecoveryCopyState::Later]),
            untitled: Some(true),
            ..RecoveryCopyFilter::default()
        })?,
    );
    let row_by_key: HashMap<String, usize> = rows
        .iter()
        .enumerate()
        .map(|(index, copy)| (recovery_identity_key(&copy.identity), index))
        .collect();

    let mut tabs: Vec<PlannedTab> = Vec::new();
    let mut front: Option<String> = None;
    let mut split: Option<PlannedSplit> = None;
    let mut untitled_titles: HashMap<String, String> = HashMap::new();
    if let (true, SessionRecordReadResult::Ok(record)) = (judgment.abnormal, previous) {
        let layout = session_restore_layout(record, judgment.crash_loop);
        let mut key_by_index: HashMap<usize, String> = HashMap::new();
        for (index, tab) in layout.tabs.iter().enumerate() {
            let key = format!("s{index}");
            if let Some(file_path) = tab.file_path.as_deref().filter(|path| !path.is_empty()) {
                tabs.push(PlannedTab {
                    key: key.clone(),
                    kind: tab.kind.clone(),
                    title: tab.title.clone(),
                    file_path: Some(file_path.to_owned()),
                    open: PlannedOpen::File,
                });
                key_by_index.insert(index, key);
                continue;
            }
            let Some(untitled) = &tab.untitled else {
                continue;
            };
            if !is_recovery_editor_kind(&tab.kind) {
                continue;
            }
            let identity = RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
                kind: tab.kind.clone(),
                untitled_id: untitled.untitled_id.clone(),
                ext: untitled.ext.clone(),
            });
            let identity_key = recovery_identity_key(&identity);
            // an untitled document without its copy has nothing to come back with
            let Some(&row) = row_by_key.get(&identity_key) else {
                continue;
            };
            untitled_titles.insert(identity_key, tab.title.clone());
            tabs.push(PlannedTab {
                key: key.clone(),
                kind: tab.kind.clone(),
                title: tab.title.clone(),
                file_path: None,
                open: untitled_open(&rows[row]),
            });
            key_by_index.insert(index, key);
        }
        if launch_paths.is_empty() {
            front = layout
                .active
                .and_then(|active| key_by_index.get(&active).cloned());
            if let Some(s) = &layout.split {
                let a = key_by_index.get(&s.a);
                let b = key_by_index.get(&s.b);
                if let (Some(a), Some(b)) = (a, b) {
                    split = Some(PlannedSplit {
                        a: a.clone(),
                        b: b.clone(),
                        orientation: s.orientation.to_owned(),
                        ratio: s.ratio,
                        focus: s.focus.to_owned(),
                    });
                }
            }
        }
    }

    let mut by_id: Vec<(String, LaunchCopy)> = Vec::new();
    let items: Vec<RecoveryListItem> = rows
        .iter()
        .enumerate()
        .map(|(index, copy)| {
            let id = format!("r{index}");
            by_id.push((id.clone(), copy.clone()));
            RecoveryListItem {
                id,
                editor_kind: copy.kind.clone(),
                name: row_name(
                    copy,
                    untitled_titles
                        .get(&recovery_identity_key(&copy.identity))
                        .map(String::as_str),
                ),
                // an untitled copy of a CSV or converted workbook shows where that file is
                folder: match copy.file_path.as_deref().filter(|path| !path.is_empty()) {
                    Some(path) => Some(dirname(path)),
                    None => copy
                        .original_path
                        .as_deref()
                        .filter(|path| !path.is_empty())
                        .map(dirname),
                },
                last_copy_time: copy.written_at,
                untitled: copy.file_path.is_none(),
                file_changed_after_copy: copy.file_changed_after_copy,
                original_missing: copy.original_missing,
            }
        })
        .collect();

    Ok(LaunchPlan {
        restore_run: judgment.abnormal,
        crash_loop: judgment.abnormal && judgment.crash_loop,
        plain_launch: tabs.is_empty() && items.is_empty(),
        tabs,
        front: front.filter(|front| !front.is_empty()),
        split,
        items,
        copies: by_id,
        launch_paths,
    })
}

/// `untitledTabFor`
fn untitled_tab_for(key: &str, copy: &LaunchCopy, title: &str) -> PlannedTab {
    // a file copy here has lost its original: it opens untitled under the old file name
    let name = match &copy.file_path {
        Some(path) => basename(path, None),
        None => title.to_owned(),
    };
    PlannedTab {
        key: key.to_owned(),
        kind: copy.kind.clone(),
        title: name,
        file_path: None,
        open: untitled_open(copy),
    }
}

/// `resolveLaunchDecisions`: what the launch list's answer does. `None` = there
/// was no list.
///
/// - restore: the copy is "restore-chosen"; an untitled copy gets its tab; a
///   copy whose original is gone opens as an untitled document with the old
///   path as the first Save As.
/// - discard: the copy goes; a file tab opens the saved file; an untitled
///   copy gets no tab.
/// - a dismissed list, or a row without a choice: "later" for that row.
///
/// Restored copies outside the strip are appended. When nothing else is in
/// front, the first of them comes forward (never in a crash loop); launch
/// files always take the front.
pub fn resolve_launch_decisions(
    plan: &LaunchPlan,
    result: Option<&RecoveryListResult>,
) -> LaunchOutcome {
    let decision_of = |id: &str| -> RecoveryLaunchDecision {
        match result {
            None | Some(RecoveryListResult::Dismissed) => RecoveryLaunchDecision::Later,
            Some(RecoveryListResult::Decisions(decisions)) => decisions
                .get(id)
                .map_or(RecoveryLaunchDecision::Later, |choice| choice.decision()),
        }
    };
    let mut store_decisions: Vec<(RecoveryIdentity, RecoveryLaunchDecision)> = Vec::new();
    let mut decision_by_key: HashMap<String, RecoveryLaunchDecision> = HashMap::new();
    if result.is_some() {
        for item in &plan.items {
            let Some(copy) = plan.copy_of(&item.id) else {
                continue;
            };
            let decision = decision_of(&item.id);
            store_decisions.push((copy.identity.clone(), decision));
            decision_by_key.insert(recovery_identity_key(&copy.identity), decision);
        }
    }

    let mut remove: Vec<String> = Vec::new();
    let mut replace: Vec<PlannedTab> = Vec::new();
    let mut in_strip: HashSet<String> = HashSet::new();
    for tab in &plan.tabs {
        if let PlannedOpen::UntitledCopy { copy, .. } = &tab.open {
            let key = recovery_identity_key(copy);
            in_strip.insert(key.clone());
            if result.is_some()
                && decision_by_key.get(&key) != Some(&RecoveryLaunchDecision::Restore)
            {
                remove.push(tab.key.clone());
            }
            continue;
        }
        let Some(file_path) = tab.file_path.as_deref().filter(|path| !path.is_empty()) else {
            continue;
        };
        if !is_recovery_editor_kind(&tab.kind) {
            continue;
        }
        let key = recovery_identity_key(&RecoveryIdentity::File(RecoveryFileIdentity {
            kind: tab.kind.clone(),
            file_path: file_path.to_owned(),
        }));
        in_strip.insert(key.clone());
        let copy = plan
            .copies
            .iter()
            .map(|(_, copy)| copy)
            .find(|copy| recovery_identity_key(&copy.identity) == key);
        if let Some(copy) = copy
            && copy.original_missing
            && decision_by_key.get(&key) == Some(&RecoveryLaunchDecision::Restore)
        {
            replace.push(untitled_tab_for(&tab.key, copy, &tab.title));
        }
    }

    let mut append: Vec<PlannedTab> = Vec::new();
    for (index, item) in plan.items.iter().enumerate() {
        let Some(copy) = plan.copy_of(&item.id) else {
            continue;
        };
        let key = recovery_identity_key(&copy.identity);
        if in_strip.contains(&key)
            || decision_by_key.get(&key) != Some(&RecoveryLaunchDecision::Restore)
        {
            continue;
        }
        let tab_key = format!("a{index}");
        match &copy.file_path {
            Some(path) if !copy.original_missing => append.push(PlannedTab {
                key: tab_key,
                kind: copy.kind.clone(),
                title: basename(path, None),
                file_path: Some(path.clone()),
                open: PlannedOpen::File,
            }),
            _ => append.push(untitled_tab_for(&tab_key, copy, &item.name)),
        }
    }

    let removed: HashSet<&str> = remove.iter().map(String::as_str).collect();
    let split = plan
        .split
        .clone()
        .filter(|s| !(removed.contains(s.a.as_str()) || removed.contains(s.b.as_str())));
    let mut front = plan
        .front
        .clone()
        .filter(|front| !front.is_empty() && !removed.contains(front.as_str()));
    let launch_paths = plan.launch_paths.clone();
    if front.is_none() && split.is_none() && launch_paths.is_empty() && !plan.crash_loop {
        front = append.first().map(|tab| tab.key.clone());
    }
    let split_memory_or_home =
        !plan.restore_run && front.is_none() && split.is_none() && launch_paths.is_empty();
    LaunchOutcome {
        store_decisions,
        remove,
        replace,
        append,
        front: front.filter(|front| !front.is_empty()),
        split,
        launch_paths,
        split_memory_or_home,
    }
}

/// `normalizeLaunchListResult`: check what the Home screen sent back.
/// Decisions for rows the list never showed are dropped; a missing row counts
/// as "later" when applied.
pub fn normalize_launch_list_result(
    raw: &JsonValue,
    ids: &[String],
) -> Result<RecoveryListResult, Failure> {
    let JsonValue::Object(value) = raw else {
        return Err(Failure("invalid launch recovery result".to_owned()));
    };
    if value.get("dismissed") == Some(&JsonValue::Bool(true)) {
        return Ok(RecoveryListResult::Dismissed);
    }
    let Some(JsonValue::Object(decisions)) = value.get("decisions") else {
        return Err(Failure("invalid launch recovery result".to_owned()));
    };
    let known: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut out: JsObject<RecoveryChoice> = JsObject::new();
    for (id, choice) in decisions.entries() {
        let choice = match choice {
            JsonValue::String(text) if text == "restore" => RecoveryChoice::Restore,
            JsonValue::String(text) if text == "discard" => RecoveryChoice::Discard,
            _ => return Err(Failure("invalid launch recovery choice".to_owned())),
        };
        if known.contains(id) {
            out.set(id, choice);
        }
    }
    Ok(RecoveryListResult::Decisions(out))
}

// ---- the launch list over IPC ----

/// `State` of `createLaunchListGate`
#[derive(Debug, Clone, PartialEq)]
enum GateState {
    Unknown,
    Asking(Vec<RecoveryListItem>),
    Done,
}

/// what `get()` does
#[derive(Debug, Clone, PartialEq)]
pub enum GateGet {
    /// the launch flow does not know the rows yet: the call waits
    Waiting,
    /// the rows, or `None` once answered or when there is nothing to ask
    Ready(Option<Vec<RecoveryListItem>>),
}

/// what `submit(raw)` does
#[derive(Debug, Clone, PartialEq)]
pub enum GateSubmit {
    /// settles at once: nothing is being asked, or the answer is being applied
    /// by a call whose promise is not yet the gate's
    Resolved,
    /// settles when the apply in flight settles
    Joined,
    /// the answer was not valid: the call rejects with this message
    Rejected(String),
    /// carry out `apply(result)` now
    Apply(RecoveryListResult),
}

/// `createLaunchListGate`
#[derive(Debug)]
pub struct LaunchListGate {
    state: GateState,
    /// which state is current (the `state === asking` identity check)
    state_id: u64,
    waiters: usize,
    /// an answer is being applied (set before `apply` runs, which may be synchronous)
    answering: bool,
    /// the `applying` promise is set
    applying: bool,
    /// the state the apply in flight was asked in
    in_flight: Option<u64>,
}

impl Default for LaunchListGate {
    fn default() -> Self {
        Self::new()
    }
}

impl LaunchListGate {
    pub fn new() -> Self {
        LaunchListGate {
            state: GateState::Unknown,
            state_id: 0,
            waiters: 0,
            answering: false,
            applying: false,
            in_flight: None,
        }
    }

    /// `settle(next)`: the number of waiters woken
    fn settle(&mut self, next: GateState) -> usize {
        self.state = next;
        self.state_id += 1;
        std::mem::take(&mut self.waiters)
    }

    /// the rows of an asking gate, each a copy
    pub fn current(&self) -> Option<Vec<RecoveryListItem>> {
        match &self.state {
            GateState::Asking(items) => Some(items.clone()),
            _ => None,
        }
    }

    /// `get()`
    pub fn get(&mut self) -> GateGet {
        if self.state == GateState::Unknown {
            self.waiters += 1;
            return GateGet::Waiting;
        }
        GateGet::Ready(self.current())
    }

    /// `submit(raw)`
    pub fn submit(&mut self, raw: &JsonValue) -> GateSubmit {
        let GateState::Asking(items) = &self.state else {
            return GateSubmit::Resolved;
        };
        if self.answering {
            return if self.applying {
                GateSubmit::Joined
            } else {
                GateSubmit::Resolved
            };
        }
        let ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
        let result = match normalize_launch_list_result(raw, &ids) {
            Ok(result) => result,
            Err(Failure(message)) => return GateSubmit::Rejected(message),
        };
        self.answering = true;
        self.in_flight = Some(self.state_id);
        GateSubmit::Apply(result)
    }

    /// the synchronous part of `apply` has returned: `applying` is set
    pub fn applying_started(&mut self) {
        self.applying = true;
    }

    /// `apply` settled (`ok`: it resolved): the number of waiters woken
    pub fn apply_finished(&mut self, ok: bool) -> usize {
        let mut woken = 0;
        if ok && self.in_flight == Some(self.state_id) {
            woken = self.settle(GateState::Done);
        }
        self.answering = false;
        self.applying = false;
        self.in_flight = None;
        woken
    }

    /// `publish(items, apply)`: the number of waiters woken
    pub fn publish(&mut self, items: Vec<RecoveryListItem>) -> usize {
        if self.state != GateState::Unknown {
            return 0;
        }
        if items.is_empty() {
            self.settle(GateState::Done)
        } else {
            self.settle(GateState::Asking(items))
        }
    }

    /// `publishNone()`: the number of waiters woken
    pub fn publish_none(&mut self) -> usize {
        if self.state == GateState::Unknown {
            self.settle(GateState::Done)
        } else {
            0
        }
    }

    /// `blocking()`: true until the launch has its answer; false while an
    /// answer is being applied, since applying it loads the front tabs
    pub fn blocking(&self) -> bool {
        self.state == GateState::Unknown
            || (matches!(self.state, GateState::Asking(_)) && !self.answering)
    }
}

// ---- the OS ending the session ----

/// how long an OS shutdown waits for the editors' copies before ending anyway
pub const OS_SESSION_END_WRITE_TIMEOUT_MS: f64 = 10_000.0;

/// what one editor's `writeCopiesNow()` did when it was called
#[derive(Debug, Clone, PartialEq)]
pub enum WriteState {
    /// threw, returned a settled promise, or returned a value: the outcome
    Settled(Result<(), Failure>),
    /// a promise that settles later: [`OsSessionEnd::write_settled`]
    Pending,
}

/// `OsSessionEndDeps`
pub trait OsSessionEndDeps {
    /// `markShuttingDown()`; an `Err` is a throw
    fn mark_shutting_down(&mut self) -> Result<(), Failure>;
    /// `markSessionOsEnd()`; an `Err` is a throw
    fn mark_session_os_end(&mut self) -> Result<(), Failure>;
    /// `editors()`: how many editors there are; an `Err` is a throw
    fn editors(&mut self) -> Result<usize, Failure>;
    /// `editors[index].writeCopiesNow()`
    fn write_copies_now(&mut self, index: usize) -> WriteState;
    /// `finish()`
    fn finish(&mut self);
    /// `deps.timeoutMs`
    fn timeout_ms(&self) -> Option<f64>;
    /// `console.warn(prefix, error)`
    fn warn(&mut self, prefix: &str, detail: &str);
    /// `setTimeout(resolve, ms)`: the caller calls [`OsSessionEnd::timer_fired`] when it fires
    fn set_timeout(&mut self, ms: f64);
    /// `clearTimeout(timer)`
    fn clear_timeout(&mut self);
}

/// `createOsSessionEnd`: the OS is shutting down, restarting or logging out:
/// no save prompt. The latch goes up first, then the session record stops
/// without its clean mark, then every editor writes its copies at once as far
/// as time allows, and the app ends. Runs once.
#[derive(Debug, Default)]
pub struct OsSessionEnd {
    running: bool,
    pending: usize,
    finished: bool,
}

impl OsSessionEnd {
    pub fn new() -> Self {
        Self::default()
    }

    /// the promise the function returned has settled
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// the function `createOsSessionEnd` returns; a later call does nothing
    pub fn run(&mut self, deps: &mut dyn OsSessionEndDeps) {
        if self.running {
            return;
        }
        self.running = true;
        if let Err(Failure(error)) = deps.mark_shutting_down() {
            deps.warn("[recovery] could not latch the shutdown:", &error);
        }
        if let Err(Failure(error)) = deps.mark_session_os_end() {
            deps.warn("[recovery] could not close the session record:", &error);
        }
        let editors = deps.editors().unwrap_or(0);
        let timeout = deps.timeout_ms().unwrap_or(OS_SESSION_END_WRITE_TIMEOUT_MS);
        deps.set_timeout(timeout);
        // the writes start one microtask later, in the editors' order; those
        // that fail at once are warned about after every write has started
        let mut failed: Vec<String> = Vec::new();
        for index in 0..editors {
            match deps.write_copies_now(index) {
                WriteState::Settled(Ok(())) => {}
                WriteState::Settled(Err(Failure(error))) => failed.push(error),
                WriteState::Pending => self.pending += 1,
            }
        }
        for error in failed {
            deps.warn("[recovery] copy at shutdown failed:", &error);
        }
        if self.pending == 0 {
            self.complete(deps);
        }
    }

    /// a pending write settled
    pub fn write_settled(&mut self, deps: &mut dyn OsSessionEndDeps, result: Result<(), Failure>) {
        if let Err(Failure(error)) = result {
            deps.warn("[recovery] copy at shutdown failed:", &error);
        }
        self.pending = self.pending.saturating_sub(1);
        if self.pending == 0 {
            self.complete(deps);
        }
    }

    /// the timeout fired
    pub fn timer_fired(&mut self, deps: &mut dyn OsSessionEndDeps) {
        self.complete(deps);
    }

    /// `await Promise.race([writes, timeout])`, then `clearTimeout` and `finish`
    fn complete(&mut self, deps: &mut dyn OsSessionEndDeps) {
        if self.finished {
            return;
        }
        self.finished = true;
        deps.clear_timeout();
        deps.finish();
    }
}

// ---- the live strip as the session record keeps it ----

/// what `liveSessionSource` builds: the snapshot source for `noteSessionChanged`
#[derive(Debug, Clone, PartialEq)]
pub struct LiveSessionSource {
    pub strip: Option<JsonValue>,
    pub detached: Vec<JsonValue>,
    untitled: HashMap<String, SessionUntitledCopy>,
}

impl LiveSessionSource {
    /// `untitledCopyFor(tab)`
    pub fn untitled_copy_for(&self, tab_id: &str) -> Option<&SessionUntitledCopy> {
        self.untitled.get(tab_id)
    }
}

/// `liveSessionSource`: a tab whose editor says its document is untitled is
/// recorded by its copy even when the tab points at a working file: that file
/// is not the user's document and must not come back as one.
///
/// A tab and the strip are JavaScript values; `untitled_of` is `input.untitledOf`,
/// called with the tab as it was handed over.
pub fn live_session_source(
    strip: Option<&JsonValue>,
    detached: &[JsonValue],
    untitled_of: &mut dyn FnMut(&JsonValue) -> Option<SessionUntitledCopy>,
) -> LiveSessionSource {
    let mut untitled: HashMap<String, SessionUntitledCopy> = HashMap::new();
    let mut without_working_file = |tab: &JsonValue| -> JsonValue {
        let Some(copy) = untitled_of(tab) else {
            return tab.clone();
        };
        if let Some(JsonValue::String(id)) = tab.get("id").as_deref() {
            untitled.insert(id.clone(), copy);
        }
        let mut rest = tab.clone();
        if let JsonValue::Object(object) = &mut rest {
            *object = object
                .entries()
                .into_iter()
                .filter(|(key, _)| *key != "filePath")
                .map(|(key, value)| (key.to_owned(), value.clone()))
                .collect();
        }
        rest
    };
    let strip = strip.map(|strip| {
        let mut out = strip.clone();
        if let (JsonValue::Object(object), Some(JsonValue::Array(tabs))) =
            (&mut out, strip.get("tabs").as_deref())
        {
            object.set(
                "tabs",
                JsonValue::Array(tabs.iter().map(&mut without_working_file).collect()),
            );
        }
        out
    });
    let detached: Vec<JsonValue> = detached.iter().map(&mut without_working_file).collect();
    LiveSessionSource {
        strip,
        detached,
        untitled,
    }
}

// ---- MCP and `@` lookups of a restored tab ----

/// the failure an MCP / AI caller gets for a document that waits on the user's answer
pub const LAUNCH_NEEDS_USER_MESSAGE: &str = "the user must open this document in the app first";

/// `ensureLoaded(tabId)`'s answer
#[derive(Debug, Clone, PartialEq)]
pub enum EnsureLoaded<C> {
    Ready(C),
    NeedsUser,
    Missing,
}

/// `LiveTabContentsDeps<C>` without `ensureLoaded`: that one waits for the
/// tab's editor page, an answer that arrives on the thread asking for it, so
/// it is the caller's step ([`LiveTabStep::EnsureLoaded`]).
pub trait LiveTabContentsDeps<C> {
    /// a document in a detached window
    fn detached(&mut self, tab_id: &str) -> Option<C>;
    fn title_of(&mut self, tab_id: &str) -> Option<String>;
}

/// What the caller does next.
#[derive(Debug, Clone, PartialEq)]
pub enum LiveTabStep<C> {
    /// `await deps.ensureLoaded(tabId)`: load the tab, wait for its editor
    /// page, and answer with [`LiveTabLookup::resume`] (`Err` is a rejection)
    EnsureLoaded(String),
    /// `liveTabContents` returned (`Ok`) or threw (`Err`)
    Done(Result<Option<C>, Failure>),
}

/// `liveTabContents`: the live webContents of an open document for a caller
/// that cannot wait on a person. An unloaded tab is loaded first and its
/// editor page waited for; a document that must first ask the user fails with
/// a message the agent can relay (spec 5.3). `Ok(None)` when no such document
/// is open.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveTabLookup {
    tab_id: String,
}

impl LiveTabLookup {
    /// the call: the first step is always the load
    pub fn begin<C>(tab_id: &str) -> (Self, LiveTabStep<C>) {
        (
            LiveTabLookup {
                tab_id: tab_id.to_owned(),
            },
            LiveTabStep::EnsureLoaded(tab_id.to_owned()),
        )
    }

    /// the answer of the `ensureLoaded` the last step asked for
    pub fn resume<C>(
        &self,
        deps: &mut dyn LiveTabContentsDeps<C>,
        answer: Result<EnsureLoaded<C>, Failure>,
    ) -> LiveTabStep<C> {
        let tab_id = self.tab_id.as_str();
        let loaded = match answer {
            Ok(loaded) => loaded,
            Err(failure) => return LiveTabStep::Done(Err(failure)),
        };
        let result = match loaded {
            EnsureLoaded::Ready(contents) => Ok(Some(contents)),
            EnsureLoaded::NeedsUser => {
                let title = deps.title_of(tab_id).filter(|title| !title.is_empty());
                Err(Failure(match title {
                    Some(title) => format!(
                        "\"{title}\" has recovered changes to decide on: {LAUNCH_NEEDS_USER_MESSAGE}"
                    ),
                    None => format!(
                        "this document has recovered changes to decide on: {LAUNCH_NEEDS_USER_MESSAGE}"
                    ),
                }))
            }
            EnsureLoaded::Missing => Ok(deps.detached(tab_id)),
        };
        LiveTabStep::Done(result)
    }
}
