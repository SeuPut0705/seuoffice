//! `apps/slides/src/main/session-state.ts`: the main-process state of SeuOffice
//! Slides shared by its IPC modules: per-renderer sessions, snapshot
//! undo/redo history, the op journal, window references and the media URLs of
//! the deck.
//!
//! The module's state becomes values the caller owns: a [`Session`] per deck
//! (its deck behind [`Deck`], its snapshots a type `S`), a [`WcSessions`] for
//! the `sessions` map and `viewerWcIds`, a [`SessionIds`] for the module's
//! `nextAiSnapshotId`, a [`MediaRegistry`] for `mediaSources`, `mediaUrls`
//! and `byteVersions`, and a [`FontMetrics`] for `fontMetrics`.
//!
//! What stays with the caller: `webContents.fromId(id).send(...)`,
//! `setImmediate` (a [`Session`] lists what it would have queued in
//! [`Session::take_scheduled`], and the caller runs the matching
//! `flush_*` when its turn comes), `BrowserWindow`, the render-tree builders
//! (`buildRenderSlide`, `materializeSlide`: the slide update below says which
//! slides to rebuild), `runtime`/`configureSlidesRuntime` (plain fields) and
//! the `WeakRef`/`FinalizationRegistry` bookkeeping of the media URLs, which
//! follows the garbage collector: here the registry keeps the bytes it was
//! given until [`MediaRegistry::prune`] drops them.

use std::rc::Rc;

use jscompat::{JsMap, encode_uri_component, js_regex};

use super::jpeg_orientation::neutralize_jpeg_orientation;
use super::media_mime::{DisplayMime, display_mime};
use crate::packages::electron_utils::message_box::ParentWindow;

/// `OP_LOG_MAX`
pub const OP_LOG_MAX: usize = 200;
/// `MAX_HISTORY`
pub const MAX_HISTORY: usize = 50;
/// `MAX_AI_SNAPSHOTS`
pub const MAX_AI_SNAPSHOTS: usize = 20;

/// `OpLogEntry['source']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpSource {
    Edit,
    Batch,
    Script,
    Generate,
    Reset,
}

impl OpSource {
    pub fn as_str(self) -> &'static str {
        match self {
            OpSource::Edit => "edit",
            OpSource::Batch => "batch",
            OpSource::Script => "script",
            OpSource::Generate => "generate",
            OpSource::Reset => "reset",
        }
    }
}

/// One record handed to `journalOps`: the op (opaque here) and its optional keys.
#[derive(Debug, Clone, PartialEq)]
pub struct OpRecord<O> {
    pub op: O,
    pub slide_id: Option<String>,
    pub created: Option<Vec<String>>,
}

/// One op of a journal entry: `{ op, slideId?, created? }`
#[derive(Debug, Clone, PartialEq)]
pub struct OpEntry<O> {
    pub op: O,
    pub slide_id: Option<String>,
    pub created: Option<Vec<String>>,
}

/// `OpLogEntry`
#[derive(Debug, Clone, PartialEq)]
pub struct OpLogEntry<O> {
    pub seq: u64,
    pub source: OpSource,
    pub ops: Vec<OpEntry<O>>,
}

/// The live deck a session's snapshots are taken from and handed back to.
pub trait Deck<S> {
    /// `takeSnapshot(session)`: a deep copy of the deck; `meta_dirty` is the
    /// session's flag.
    fn take_snapshot(&self, meta_dirty: bool) -> S;
    /// The deck half of `restoreSnapshot`: `fresh` is already a copy of the
    /// snapshot; it becomes the live deck. Answers the snapshot's `metaDirty`.
    fn restore_snapshot(&mut self, fresh: S) -> bool;
}

/// `historyBatch`
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryBatch<S> {
    pub depth: u32,
    pub undo_start: usize,
    pub before: S,
}

/// What `setImmediate` would have been given.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheduled {
    /// the callback of `scheduleHistoryNotify`: [`Session::flush_history_notify`]
    HistoryNotify,
    /// the callback of `scheduleDeckBroadcast`: [`Session::flush_deck_broadcast`]
    DeckBroadcast,
}

/// The module's `nextAiSnapshotId`.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionIds {
    next_ai_snapshot_id: u64,
}

impl Default for SessionIds {
    fn default() -> Self {
        SessionIds {
            next_ai_snapshot_id: 1,
        }
    }
}

impl SessionIds {
    pub fn new() -> Self {
        Self::default()
    }
}

/// The `slides:history-changed` message.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct HistoryChanged {
    #[serde(rename = "canUndo")]
    pub can_undo: bool,
    #[serde(rename = "canRedo")]
    pub can_redo: bool,
    /// an AI run's unaccepted edits are in the deck: every attached window is read-only
    #[serde(rename = "aiRunActive")]
    pub ai_run_active: bool,
}

/// A render slide as far as the broadcast reads it: the key its updates
/// coalesce under (`partPath`, `undefined` for none).
pub trait PartPath {
    fn part_path(&self) -> Option<&str>;
}

/// `SlideUpdate`: the slide order and the render slides that changed.
#[derive(Debug, Clone, PartialEq)]
pub struct SlideUpdate<R> {
    pub order: Vec<String>,
    pub slides: Vec<R>,
}

/// What the `slides:deck-changed` flush comes to.
#[derive(Debug, Clone, PartialEq)]
pub enum DeckBroadcast<R> {
    /// fewer than two windows attached: nothing is sent
    Nothing,
    /// every update was partial: `order` of the last one, the changed slides
    /// (the last version of each part, still in the order)
    Partial { order: Vec<String>, slides: Vec<R> },
    /// some edit needs a full resync: the caller rebuilds every slide
    Full,
}

/// One session per renderer process (standalone window or shell tab): the
/// fields this module reads and writes.
pub struct Session<D, S, O, R> {
    pub path: String,
    pub deck: D,
    pub undo_stack: Vec<S>,
    pub redo_stack: Vec<S>,
    pub history_batch: Option<HistoryBatch<S>>,
    /// rollback points for the AI panel's Snapshots list, keyed by id
    pub ai_snapshots: Option<Vec<(u64, S)>>,
    /// presence of `aiRun`
    pub ai_run: bool,
    pub meta_dirty: bool,
    pub meta_rev: Option<u64>,
    pub history_notify_scheduled: bool,
    pub deck_broadcast_scheduled: bool,
    /// one entry per queued edit; `None` requires a full resync
    pub deck_broadcast_updates: Option<Vec<Option<SlideUpdate<R>>>>,
    pub op_seq: Option<u64>,
    pub op_log: Option<Vec<OpLogEntry<O>>>,
    scheduled: Vec<Scheduled>,
}

fn trim_history<S>(stack: &mut Vec<S>) {
    while stack.len() > MAX_HISTORY {
        stack.remove(0);
    }
}

impl<D: Deck<S>, S: Clone, O: Clone, R> Session<D, S, O, R> {
    pub fn new(path: &str, deck: D) -> Self {
        Session {
            path: path.to_owned(),
            deck,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            history_batch: None,
            ai_snapshots: None,
            ai_run: false,
            meta_dirty: false,
            meta_rev: None,
            history_notify_scheduled: false,
            deck_broadcast_scheduled: false,
            deck_broadcast_updates: None,
            op_seq: None,
            op_log: None,
            scheduled: Vec::new(),
        }
    }

    /// What the session queued with `setImmediate` since the last call, in order.
    pub fn take_scheduled(&mut self) -> Vec<Scheduled> {
        std::mem::take(&mut self.scheduled)
    }

    /// `markMetaDirty(session)`: flag an archive-only edit (notes/comments)
    /// and advance the save-snapshot counter.
    pub fn mark_meta_dirty(&mut self) {
        self.meta_dirty = true;
        self.meta_rev = Some(self.meta_rev.unwrap_or(0) + 1);
    }

    /// `journalOps(session, source, records)`
    pub fn journal_ops(&mut self, source: OpSource, records: Vec<OpRecord<O>>) {
        if records.is_empty() {
            return;
        }
        let seq = self.op_seq.unwrap_or(0) + 1;
        self.op_seq = Some(seq);
        let log = self.op_log.get_or_insert_with(Vec::new);
        log.push(OpLogEntry {
            seq,
            source,
            ops: records
                .into_iter()
                .map(|record| OpEntry {
                    op: record.op,
                    // `r.slideId ? ... : {}`: an empty id is left out
                    slide_id: record.slide_id.filter(|id| !id.is_empty()),
                    created: record.created,
                })
                .collect(),
        });
        while log.len() > OP_LOG_MAX {
            log.remove(0);
        }
    }

    /// `takeSnapshot(session)`
    pub fn take_snapshot(&self) -> S {
        self.deck.take_snapshot(self.meta_dirty)
    }

    /// `scheduleHistoryNotify(session)`: coalesces per task.
    pub fn schedule_history_notify(&mut self) {
        if self.history_notify_scheduled {
            return;
        }
        self.history_notify_scheduled = true;
        self.scheduled.push(Scheduled::HistoryNotify);
    }

    /// The `setImmediate` callback of `scheduleHistoryNotify`, up to the sends:
    /// the caller prunes the media sources, then sends the message to every
    /// attached window.
    pub fn flush_history_notify(&mut self) -> HistoryChanged {
        self.history_notify_scheduled = false;
        HistoryChanged {
            can_undo: !self.undo_stack.is_empty(),
            can_redo: !self.redo_stack.is_empty(),
            ai_run_active: self.ai_run,
        }
    }

    /// `pushHistory(session)`: call before an edit operation.
    pub fn push_history(&mut self) {
        let snapshot = self.take_snapshot();
        self.undo_stack.push(snapshot);
        trim_history(&mut self.undo_stack);
        self.redo_stack = Vec::new();
        self.schedule_history_notify();
    }

    /// `beginHistoryBatch(session)`: a nestable transaction.
    pub fn begin_history_batch(&mut self) {
        if let Some(batch) = self.history_batch.as_mut() {
            batch.depth += 1;
            return;
        }
        self.history_batch = Some(HistoryBatch {
            depth: 1,
            undo_start: self.undo_stack.len(),
            before: self.take_snapshot(),
        });
    }

    /// `endHistoryBatch(session)`: collapse every successful edit since begin
    /// into the pre-transaction snapshot. Answers that snapshot when the
    /// outermost end collapsed real edits.
    pub fn end_history_batch(&mut self) -> Option<S> {
        let batch = self.history_batch.as_mut()?;
        batch.depth -= 1;
        if batch.depth > 0 {
            return None;
        }
        let batch = self.history_batch.take()?;
        if self.undo_stack.len() <= batch.undo_start {
            return None;
        }
        self.undo_stack.truncate(batch.undo_start);
        self.undo_stack.push(batch.before.clone());
        trim_history(&mut self.undo_stack);
        self.schedule_history_notify();
        Some(batch.before)
    }

    /// `registerAiSnapshot(session, snap)`: a rollback point, stored as its
    /// own copy; answers its id.
    pub fn register_ai_snapshot(&mut self, ids: &mut SessionIds, snapshot: &S) -> u64 {
        let map = self.ai_snapshots.get_or_insert_with(Vec::new);
        let id = ids.next_ai_snapshot_id;
        ids.next_ai_snapshot_id += 1;
        map.push((id, snapshot.clone()));
        while map.len() > MAX_AI_SNAPSHOTS {
            map.remove(0);
        }
        id
    }

    /// `restoreSnapshot(session, snap)`
    pub fn restore_snapshot(&mut self, snapshot: &S) {
        // Clone: the live deck mutates elements in place, so handing a
        // snapshot's own arrays over would let later edits rewrite history
        // still referenced by the other stack.
        let fresh = snapshot.clone();
        self.meta_dirty = self.deck.restore_snapshot(fresh);
        // The journal cannot express a snapshot jump as ops; mark the
        // divergence so a future consumer knows to full-resync.
        if self.op_log.as_ref().is_some_and(|log| !log.is_empty()) {
            let seq = self.op_seq.unwrap_or(0) + 1;
            self.op_seq = Some(seq);
            if let Some(log) = self.op_log.as_mut() {
                log.push(OpLogEntry {
                    seq,
                    source: OpSource::Reset,
                    ops: Vec::new(),
                });
                while log.len() > OP_LOG_MAX {
                    log.remove(0);
                }
            }
        }
    }

    /// `restoreAiSnapshot(session, id)`: roll the deck back to a registered
    /// AI snapshot; the pre-rollback state becomes one undo step.
    pub fn restore_ai_snapshot(&mut self, id: f64) -> bool {
        let found = self
            .ai_snapshots
            .as_ref()
            .and_then(|map| map.iter().find(|(key, _)| *key as f64 == id))
            .map(|(_, snapshot)| snapshot.clone());
        let Some(snapshot) = found else {
            return false;
        };
        self.push_history();
        self.restore_snapshot(&snapshot);
        if let Some(map) = self.ai_snapshots.as_mut() {
            map.retain(|(key, _)| *key as f64 != id);
        }
        true
    }

    /// `settleStaleHistoryBatch(session)`: close a history batch that
    /// outlived its run, keeping the run's edits as one step.
    pub fn settle_stale_history_batch(&mut self, ids: &mut SessionIds) {
        while self.history_batch.is_some() {
            if let Some(collapsed) = self.end_history_batch() {
                self.register_ai_snapshot(ids, &collapsed);
            }
        }
    }

    /// `carryHistoryForReplacement(previous, replacement)`: preserve the old
    /// deck and its history when AI replaces the entire presentation. The
    /// stacks, batch and snapshots are copies here, where the TypeScript
    /// hands the replacement the same objects; `previous` is dropped after.
    pub fn carry_history_for_replacement(
        previous: Option<&mut Session<D, S, O, R>>,
        replacement: &mut Session<D, S, O, R>,
    ) {
        let Some(previous) = previous else {
            return;
        };
        previous.push_history();
        replacement.undo_stack = previous.undo_stack.clone();
        replacement.redo_stack = previous.redo_stack.clone();
        replacement.history_batch = previous.history_batch.clone();
        replacement.ai_snapshots = previous.ai_snapshots.clone();
        // A replaced untitled deck keeps its identity (no path, same recovery slot), so the run can
        // still be held; a file-backed deck becomes an untitled draft, which a snapshot cannot revert.
        if previous.path.is_empty() {
            replacement.ai_run = previous.ai_run;
        }
        replacement.schedule_history_notify();
    }

    /// The end of `buildSlideUpdate`: the transaction just queued this edit,
    /// so its partial state replaces the last queued update (any unrelated
    /// edit in the same task still forces a full resync).
    pub fn note_slide_update(&mut self, update: SlideUpdate<R>) {
        if let Some(pending) = self.deck_broadcast_updates.as_mut() {
            if let Some(last) = pending.last_mut() {
                *last = Some(update);
            }
        }
    }

    /// `scheduleDeckBroadcast(session)`: queue a full-resync update; the flush
    /// is coalesced per task.
    pub fn schedule_deck_broadcast(&mut self) {
        self.deck_broadcast_updates
            .get_or_insert_with(Vec::new)
            .push(None);
        if self.deck_broadcast_scheduled {
            return;
        }
        self.deck_broadcast_scheduled = true;
        self.scheduled.push(Scheduled::DeckBroadcast);
    }
}

impl<D, S, O, R: PartPath + Clone> Session<D, S, O, R> {
    /// The `setImmediate` callback of `scheduleDeckBroadcast`, up to the
    /// sends: `attached` is how many windows are attached to the session. The
    /// caller adds `size`, and for [`DeckBroadcast::Full`] rebuilds every
    /// slide.
    pub fn flush_deck_broadcast(&mut self, attached: usize) -> DeckBroadcast<R> {
        self.deck_broadcast_scheduled = false;
        let updates = self.deck_broadcast_updates.take().unwrap_or_default();
        plan_deck_broadcast(updates, attached)
    }
}

/// `sessions` and `viewerWcIds`: webContents ids mapped to the session they
/// attach to (a session is named by its slot), in the order they were set.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WcSessions {
    entries: Vec<(f64, usize)>,
    /// view-only attachments (presenter audience windows)
    viewers: Vec<f64>,
}

impl WcSessions {
    pub fn new() -> Self {
        Self::default()
    }

    /// `sessions.set(wcId, session)`: a key set again keeps its place.
    pub fn set(&mut self, wc_id: f64, slot: usize) {
        match self.entries.iter_mut().find(|(id, _)| *id == wc_id) {
            Some(entry) => entry.1 = slot,
            None => self.entries.push((wc_id, slot)),
        }
    }

    /// `viewerWcIds.add(wcId)`
    pub fn add_viewer(&mut self, wc_id: f64) {
        if !self.viewers.contains(&wc_id) {
            self.viewers.push(wc_id);
        }
    }

    /// `attachedIds(session)`: webContents ids currently mapped to this
    /// session (aliased entries included).
    pub fn attached_ids(&self, slot: usize) -> Vec<f64> {
        self.entries
            .iter()
            .filter(|(_, s)| *s == slot)
            .map(|(id, _)| *id)
            .collect()
    }

    /// `editorAttachedIds(session)`: attached windows that can actually
    /// edit/save the session.
    pub fn editor_attached_ids(&self, slot: usize) -> Vec<f64> {
        self.attached_ids(slot)
            .into_iter()
            .filter(|id| !self.viewers.contains(id))
            .collect()
    }
}

/// The flush of `scheduleDeckBroadcast`, up to the sends: `updates` is what
/// the session queued (taken out of it), `attached` how many windows are
/// attached. `Full` asks the caller for `buildAllRenderSlides`.
pub fn plan_deck_broadcast<R: PartPath + Clone>(
    updates: Vec<Option<SlideUpdate<R>>>,
    attached: usize,
) -> DeckBroadcast<R> {
    if attached < 2 {
        return DeckBroadcast::Nothing;
    }
    let partial = !updates.is_empty() && updates.iter().all(Option::is_some);
    if !partial {
        return DeckBroadcast::Full;
    }
    let last_order = match updates.last() {
        Some(Some(last)) => last.order.clone(),
        _ => return DeckBroadcast::Full,
    };
    // `changed.set(slide.partPath, slide)`: the key keeps its first place
    let mut changed: Vec<(Option<String>, R)> = Vec::new();
    for update in updates.iter().flatten() {
        for slide in &update.slides {
            let key = slide.part_path().map(str::to_owned);
            match changed.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 = slide.clone(),
                None => changed.push((key, slide.clone())),
            }
        }
    }
    let slides = changed
        .into_iter()
        .filter(|(key, _)| {
            // `last.order.includes(s.partPath!)`
            match key {
                Some(path) => last_order.iter().any(|p| p == path),
                None => false,
            }
        })
        .map(|(_, slide)| slide)
        .collect();
    DeckBroadcast::Partial {
        order: last_order,
        slides,
    }
}

/// A slide as `buildSlideUpdate` sees it: its part path, and whether any of
/// its elements or decorations holds a slide-number field.
#[derive(Debug, Clone, PartialEq)]
pub struct SlideRef {
    pub path: String,
    pub has_number: bool,
}

/// `buildSlideUpdate(session, before, changed)`: the new order and the
/// indices of the slides to rebuild, in order. Insertions only change new
/// pages and shifted slide-number fields.
pub fn plan_slide_update(
    slides: &[SlideRef],
    before: &[String],
    changed: &[f64],
) -> (Vec<String>, Vec<usize>) {
    // `new Map(before.map((path, i) => [path, i]))`: a path seen again keeps its last index
    let mut previous: JsMap<usize> = JsMap::new();
    for (i, path) in before.iter().enumerate() {
        previous.set(path.as_str(), i);
    }
    let order = slides.iter().map(|s| s.path.clone()).collect();
    let mut rebuild = Vec::new();
    for (i, slide) in slides.iter().enumerate() {
        let old_index = previous.get(&slide.path).copied();
        let renumber = old_index.is_some_and(|old| old != i) && slide.has_number;
        if old_index.is_none() || changed.contains(&(i as f64)) || renumber {
            rebuild.push(i);
        }
    }
    (order, rebuild)
}

/// `hostWindowFor(wc)`: the window a tab view lives in: its own
/// `BrowserWindow`, the shell-registered detached window, else the shell
/// window. Each is asked in that order, only when needed.
pub fn host_window_for<'a, W: ParentWindow>(
    from_web_contents: impl FnOnce() -> Option<&'a W>,
    host_window_hook: Option<impl FnOnce() -> Option<&'a W>>,
    shell_window: Option<&'a W>,
) -> Option<&'a W> {
    let own = from_web_contents().or_else(|| host_window_hook.and_then(|hook| hook()));
    if let Some(own) = own {
        if !own.is_destroyed() {
            return Some(own);
        }
    }
    match shell_window {
        Some(shell) if !shell.is_destroyed() => Some(shell),
        _ => None,
    }
}

/// `dialogParent()`: the focused window first: a detached editor window must
/// parent its own dialogs.
pub fn dialog_parent<'a, W>(focused: Option<&'a W>, shell_window: Option<&'a W>) -> Option<&'a W> {
    focused.or(shell_window)
}

/// `fontMetrics`: lazily built, shared process-wide.
#[derive(Debug, Default)]
pub struct FontMetrics<T> {
    metrics: Option<T>,
}

impl<T> FontMetrics<T> {
    pub fn new() -> Self {
        FontMetrics { metrics: None }
    }

    /// `getFontMetrics()`
    pub fn get(&mut self, create: impl FnOnce() -> T) -> &T {
        self.metrics.get_or_insert_with(create)
    }

    /// `resetFontMetrics()`: drop the cached metrics (and its font registry)
    /// after the user font store changes.
    pub fn reset(&mut self, reset_font_registry: impl FnOnce()) {
        reset_font_registry();
        self.metrics = None;
    }
}

// ---- SVG theme classes ----

/// `SVG_THEME_SLOTS`: Office theme-class slot to schemeClr name.
fn svg_theme_slot(slot: &str) -> Option<&'static str> {
    Some(match slot {
        "background1" => "bg1",
        "text1" => "tx1",
        "background2" => "bg2",
        "text2" => "tx2",
        "accent1" => "accent1",
        "accent2" => "accent2",
        "accent3" => "accent3",
        "accent4" => "accent4",
        "accent5" => "accent5",
        "accent6" => "accent6",
        "hyperlink" => "hlink",
        "followedhyperlink" => "folHlink",
        _ => return None,
    })
}

/// The `.MsftOfcThm_<slot>_Fill/_Stroke` rewrite of `retintThemedSvg`, once the
/// theme is known: `resolve_scheme_color` is `resolveSchemeColor(scheme, theme)`.
/// A slot the table does not own finds what `Object.prototype` answers
/// there, which no theme resolves; the rule stays as it is.
pub fn retint_svg_rules(
    svg: &str,
    resolve_scheme_color: &mut dyn FnMut(&str) -> Option<String>,
) -> String {
    js_regex!(r"\.MsftOfcThm_(\w+?)_(Fill|Stroke)\w*\s*\{[^}]*\}", "g").replace_all(svg, |found| {
        let rule = found.as_str();
        let slot = found.get(1).unwrap_or("").to_lowercase();
        let color = svg_theme_slot(&slot).and_then(|scheme| resolve_scheme_color(scheme));
        let Some(color) = color.filter(|c| !c.is_empty()) else {
            return rule.to_owned();
        };
        if found.get(2) == Some("Stroke") {
            js_regex!(r"stroke\s*:\s*[^;}]+", "g").replace_all(rule, |_| format!("stroke:{color}"))
        } else {
            js_regex!(r"fill\s*:\s*[^;}]+", "g").replace_all(rule, |_| format!("fill:{color}"))
        }
    })
}

/// What `archive.resolveSlideChain(path)` answers, as far as the module reads it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SlideChain {
    pub layout_path: Option<String>,
    pub master_path: Option<String>,
    pub theme_path: Option<String>,
}

/// The archive calls of the module: bytes are shared handles, so two reads of
/// one part are the same bytes (`byteVersions` keys on that).
pub trait SlideArchive {
    /// `archive.readBytes(path)`
    fn read_bytes(&self, path: &str) -> Option<Rc<Vec<u8>>>;
    /// `archive.readText(path)`
    fn read_text(&self, path: &str) -> Option<String>;
    /// `archive.resolveSlideChain(path)`
    fn resolve_slide_chain(&self, path: &str) -> SlideChain;
    /// `opened.deck.slides[0]?.path`
    fn first_slide_path(&self) -> Option<String>;
}

/// `parseTheme`, `parseClrMap` and `resolveSchemeColor` of the pptx engine.
/// A `parse_*` that throws is an `Err`.
pub trait ThemeEngine {
    type Theme;
    fn parse_theme(&mut self, xml: &str) -> Result<Self::Theme, ()>;
    /// `theme.clrMap = parseClrMap(master, layout, slide)`
    fn set_clr_map(
        &mut self,
        theme: &mut Self::Theme,
        master_xml: Option<&str>,
        layout_xml: Option<&str>,
        slide_xml: Option<&str>,
    ) -> Result<(), ()>;
    fn resolve_scheme_color(&mut self, scheme: &str, theme: &Self::Theme) -> Option<String>;
}

/// `retintThemedSvg(svg, opened, slidePath)`: Office-exported SVGs carry
/// `.MsftOfcThm_<slot>_Fill/_Stroke` CSS classes whose baked values PowerPoint
/// rewrites to the CURRENT theme's colors at render time; mirror that rewrite
/// before serving the SVG.
pub fn retint_themed_svg<A: SlideArchive + ?Sized, E: ThemeEngine>(
    svg: &str,
    archive: &A,
    engine: &mut E,
    slide_path: Option<&str>,
) -> String {
    let path = slide_path
        .map(str::to_owned)
        .or_else(|| archive.first_slide_path())
        .unwrap_or_default();
    if path.is_empty() {
        return svg.to_owned();
    }
    let chain = archive.resolve_slide_chain(&path);
    let Some(theme_xml) = chain
        .theme_path
        .as_deref()
        .and_then(|p| archive.read_text(p))
        .filter(|xml| !xml.is_empty())
    else {
        return svg.to_owned();
    };
    let Ok(mut theme) = engine.parse_theme(&theme_xml) else {
        return svg.to_owned();
    };
    let master_xml = chain
        .master_path
        .as_deref()
        .and_then(|p| archive.read_text(p));
    let layout_xml = chain
        .layout_path
        .as_deref()
        .and_then(|p| archive.read_text(p));
    let slide_xml = archive.read_text(&path);
    if engine
        .set_clr_map(
            &mut theme,
            master_xml.as_deref(),
            layout_xml.as_deref(),
            slide_xml.as_deref(),
        )
        .is_err()
    {
        return svg.to_owned();
    }
    retint_svg_rules(svg, &mut |scheme| {
        engine.resolve_scheme_color(scheme, &theme)
    })
}

// ---- media URLs ----

/// The text a mime takes in a template literal or `encodeURIComponent`.
fn mime_text(mime: &DisplayMime) -> String {
    match mime {
        DisplayMime::Mime(text) => (*text).to_owned(),
        DisplayMime::ObjectConstructor => "function Object() { [native code] }".to_owned(),
        DisplayMime::ObjectPrototype => "[object Object]".to_owned(),
    }
}

struct MediaSource {
    opened: u64,
    bytes: Rc<Vec<u8>>,
    media_ref: String,
    slide_path: Option<String>,
}

/// `mediaSources`, `mediaUrls` and `byteVersions` with `nextByteVersion`.
/// A deck (`opened`) is named by an id the caller chooses.
#[derive(Default)]
pub struct MediaRegistry {
    sources: JsMap<MediaSource>,
    urls: Vec<(u64, JsMap<String>)>,
    versions: Vec<(Rc<Vec<u8>>, u64)>,
    next_byte_version: u64,
}

/// What `readSlideMedia` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct SlideMedia {
    pub body: Vec<u8>,
    pub mime: String,
}

impl MediaRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// `byteVersion(bytes)`: the same bytes get the same number; none is 0.
    fn byte_version(&mut self, bytes: Option<&Rc<Vec<u8>>>) -> u64 {
        let Some(bytes) = bytes else {
            return 0;
        };
        if let Some((_, version)) = self
            .versions
            .iter()
            .find(|(known, _)| Rc::ptr_eq(known, bytes))
        {
            return *version;
        }
        self.next_byte_version += 1;
        self.versions
            .push((Rc::clone(bytes), self.next_byte_version));
        self.next_byte_version
    }

    /// The function `makeMediaResolver(opened, slidePath)` makes, for one
    /// `mediaRef`: an opaque URL, or `None` for a part the archive lacks.
    /// `new_uuid` is `randomUUID()`.
    pub fn resolve_media<A: SlideArchive + ?Sized>(
        &mut self,
        opened: u64,
        archive: &A,
        slide_path: Option<&str>,
        media_ref: &str,
        new_uuid: impl FnOnce() -> String,
    ) -> Option<String> {
        let bytes = archive.read_bytes(media_ref)?;
        let mime = display_mime(media_ref, &bytes);
        let mut context = String::new();
        // SVG theme classes depend on the live theme and clrMap, including per-slide overrides.
        if mime == DisplayMime::Mime("image/svg+xml") {
            let path = slide_path
                .map(str::to_owned)
                .or_else(|| archive.first_slide_path())
                .filter(|p| !p.is_empty());
            if let Some(path) = path {
                let chain = archive.resolve_slide_chain(&path);
                let parts = [
                    Some(path),
                    chain.layout_path,
                    chain.master_path,
                    chain.theme_path,
                ];
                let mut pieces = Vec::new();
                for part in parts {
                    let part_bytes = match part.as_deref().filter(|p| !p.is_empty()) {
                        Some(p) => archive.read_bytes(p),
                        None => None,
                    };
                    let version = self.byte_version(part_bytes.as_ref());
                    pieces.push(format!(
                        "{}:{version}",
                        part.as_deref().unwrap_or("undefined")
                    ));
                }
                context = pieces.join("|");
            }
        }
        let at = match self.urls.iter().position(|(id, _)| *id == opened) {
            Some(at) => at,
            None => {
                self.urls.push((opened, JsMap::new()));
                self.urls.len() - 1
            }
        };
        let mime = mime_text(&mime);
        let key = format!("{}:{mime}:{context}", self.byte_version(Some(&bytes)));
        if let Some(url) = self.urls[at].1.get(&key) {
            return Some(url.clone());
        }
        let url = format!(
            "seuoffice-slide-media://archive/{}?mime={}",
            new_uuid(),
            encode_uri_component(&mime)
        );
        self.urls[at].1.set(key, url.clone());
        self.sources.set(
            url.clone(),
            MediaSource {
                opened,
                bytes,
                media_ref: media_ref.to_owned(),
                slide_path: slide_path.filter(|p| !p.is_empty()).map(str::to_owned),
            },
        );
        Some(url)
    }

    /// `pruneMediaSources(session)`: keep archive and rollback bytes,
    /// including media used by masters, layouts and notes. `retained` is
    /// every bytes handle the archive and the session's snapshots hold.
    pub fn prune(&mut self, opened: u64, retained: &[Rc<Vec<u8>>]) {
        let Some(at) = self.urls.iter().position(|(id, _)| *id == opened) else {
            return;
        };
        let entries: Vec<(String, String)> = self.urls[at]
            .1
            .iter()
            .map(|(key, url)| (key.to_owned(), url.clone()))
            .collect();
        for (key, url) in entries {
            let keep = self
                .sources
                .get(&url)
                .is_some_and(|source| retained.iter().any(|b| Rc::ptr_eq(b, &source.bytes)));
            if !keep {
                self.urls[at].1.delete(&key);
                self.sources.delete(&url);
            }
        }
    }

    /// `readSlideMedia(url)`: display-only conversion; the original archive
    /// bytes are untouched for PPTX save. `tiff_to_png` is `tiffToPng`.
    pub fn read_slide_media<A: SlideArchive + ?Sized, E: ThemeEngine>(
        &self,
        url: &str,
        archive: &A,
        engine: &mut E,
        tiff_to_png: &mut dyn FnMut(&[u8]) -> Option<Vec<u8>>,
    ) -> Option<SlideMedia> {
        let source = self.sources.get(url)?;
        let _ = source.opened;
        let bytes = &source.bytes;
        let mut mime = mime_text(&display_mime(&source.media_ref, bytes));
        let mut body: Vec<u8> = bytes.to_vec();
        if mime == "image/tiff" {
            body = tiff_to_png(bytes)?;
            mime = "image/png".to_owned();
        } else if mime == "image/svg+xml" {
            let text = String::from_utf8_lossy(bytes).into_owned();
            body = retint_themed_svg(&text, archive, engine, source.slide_path.as_deref())
                .into_bytes();
        } else if mime == "image/jpeg" {
            body = neutralize_jpeg_orientation(bytes);
        }
        Some(SlideMedia { body, mime })
    }
}
