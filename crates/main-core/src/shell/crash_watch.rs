//! `apps/shell/src/main/crash-watch.ts`: records abnormal process ends in
//! `<userData>/crash-log.jsonl` and tells the user when the renderer of an
//! open document dies.
//!
//! The listeners the TypeScript registers (`process.on`, `app.on`) are the
//! caller's plumbing: it calls the matching `on_*` method of [`CrashWatch`].
//! Everything the options hold, and what comes from Electron, is the
//! [`CrashWatchHost`]. The prompt of a gone renderer is asked in two steps,
//! because its dialog is a promise the next event can overtake: the caller
//! shows the box [`CrashWatch::on_render_process_gone`] answers, then reports
//! the answer to [`CrashWatch::finish_prompt`]. The two timers become
//! [`LowMemoryWatch::sample`] calls every [`LowMemoryWatch::sample_ms`].

use std::collections::HashSet;

use jscompat::node_path::host::join;
use jscompat::{JsObject, JsonValue, math_round};

use crate::packages::electron_utils::message_box::{MessageBoxOptions, ParentWindow};
use crate::shell::crash_log::{
    CRASH_LOG_FILE, CRASH_LOG_MAX_BYTES, CrashEntry, InvalidTimeValue, Thrown, append_crash_log,
    error_reason,
};
use crate::shell::renderer_disposal::{Failure, RendererDisposal};

/// `CrashMemory`: the memory figures an entry may carry, in the order they were set
pub type CrashMemory = JsObject<JsonValue>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashStringKey {
    CrashTitle,
    CrashBody,
    CrashReopen,
    CrashReload,
    CrashClose,
    CrashLater,
}

impl CrashStringKey {
    pub fn as_str(self) -> &'static str {
        match self {
            CrashStringKey::CrashTitle => "crashTitle",
            CrashStringKey::CrashBody => "crashBody",
            CrashStringKey::CrashReopen => "crashReopen",
            CrashStringKey::CrashReload => "crashReload",
            CrashStringKey::CrashClose => "crashClose",
            CrashStringKey::CrashLater => "crashLater",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CrashedDocument {
    pub kind: String,
    pub title: String,
    pub file_path: Option<String>,
}

/// the part of a `WebContents` the watch reads
pub trait CrashContents {
    fn id(&self) -> i64;
    fn is_destroyed(&self) -> bool;
    /// `wc.reload()`; an `Err` is a throw
    fn reload(&self) -> Result<(), Failure>;
}

/// `CrashWatchOptions`, and the Electron `app` the module reads
pub trait CrashWatchHost {
    type Contents: CrashContents;
    type Window: ParentWindow;
    /// an untitled document's recovery copy, as the shell identifies it
    type Copy: Clone;

    /// `app.getPath('userData')`
    fn user_data_dir(&self) -> String;
    /// `new Date()`, in milliseconds since the epoch
    fn now_ms(&self) -> f64;
    /// `options.editorOf(wc)`
    fn editor_of(&self, wc: &Self::Contents) -> Result<String, Failure>;
    /// `options.documentOf(wc)`
    fn document_of(&self, wc: &Self::Contents) -> Result<Option<CrashedDocument>, Failure>;
    /// `options.parentWindow(wc)`
    fn parent_window(&self, wc: &Self::Contents) -> Result<Option<Self::Window>, Failure>;
    /// `options.closeDocument(wc)`
    fn close_document(&self, wc: &Self::Contents) -> Result<bool, Failure>;
    /// `options.reopen(filePath)`
    fn reopen(&self, file_path: &str) -> Result<(), Failure>;
    /// `options.untitledCopyOf?.(wc) ?? null`: `Ok(None)` too when the option is absent
    fn untitled_copy_of(&self, wc: &Self::Contents) -> Result<Option<Self::Copy>, Failure>;
    /// `options.reopenUntitled` is set
    fn can_reopen_untitled(&self) -> bool;
    /// `options.reopenUntitled(doc, copy)`
    fn reopen_untitled(&self, doc: &CrashedDocument, copy: &Self::Copy) -> Result<(), Failure>;
    /// `options.t(key, params)`; `title` is the `{ title }` param of `crashBody`
    fn t(&self, key: CrashStringKey, title: Option<&str>) -> String;
    /// `options.prompt`
    fn prompt(&self) -> bool;
    /// `options.memory`: `None` when the option is absent; `Some(Err)` when it throws
    fn memory(&self) -> Option<Result<CrashMemory, Failure>>;
    /// `console.warn('[main] unhandled rejection:', error)`, the error as text
    fn warn_unhandled_rejection(&self, error: &str);
}

/// `RenderProcessGoneDetails`: the fields the watch reads
#[derive(Debug, Clone, PartialEq)]
pub struct RenderGone {
    pub reason: String,
    pub exit_code: f64,
}

/// the details of `child-process-gone`
#[derive(Debug, Clone, PartialEq)]
pub struct ChildGone {
    pub reason: String,
    pub exit_code: f64,
    pub kind: String,
}

/// what a gone renderer's prompt does when the user presses its first button
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashAction {
    Reload,
    Reopen,
    ReopenUntitled,
    Close,
}

/// the box of `promptForCrashedDocument`, and what it was built from
pub struct CrashPrompt<C> {
    pub options: MessageBoxOptions,
    /// `showMessageBox(parent, options)`; false is `showMessageBox(options)`
    pub over_parent: bool,
    wc_id: i64,
    doc: CrashedDocument,
    copy: Option<C>,
    action: CrashAction,
}

/// What a listener of the watch may throw.
#[derive(Debug, Clone, PartialEq)]
pub enum CrashWatchError {
    /// `crashLine`'s `toISOString` on an invalid clock
    InvalidTime(InvalidTimeValue),
    /// `promptForCrashedDocument` rejected before its `try`: the process
    /// reports it as an unhandled rejection
    Rejected(Failure),
}

impl From<InvalidTimeValue> for CrashWatchError {
    fn from(e: InvalidTimeValue) -> Self {
        CrashWatchError::InvalidTime(e)
    }
}

/// `shouldPromptForGoneRenderer`: the app's own kills do not warrant telling the user
pub fn should_prompt_for_gone_renderer(reason: &str) -> bool {
    reason != "clean-exit" && reason != "killed"
}

/// `NOT_A_CRASH`: a normal exit is not a failure
fn not_a_crash(reason: &str) -> bool {
    reason == "clean-exit"
}

/// `crashLogPath`
pub fn crash_log_path(user_data_dir: &str) -> String {
    join(&[user_data_dir, CRASH_LOG_FILE])
}

const MB: f64 = 1024.0 * 1024.0;

fn number(x: f64) -> JsonValue {
    JsonValue::Number(x)
}

fn entry_of(fields: Vec<(&str, JsonValue)>) -> CrashEntry {
    let mut entry = CrashEntry::new();
    for (key, value) in fields {
        entry.set(key, value);
    }
    entry
}

/// What the figures read from the machine and the process, each in the order
/// the TypeScript reads it.
pub trait MemorySource {
    /// the `workingSetSize` (KB) of every metric of `app.getAppMetrics()`
    fn app_working_set_sizes(&self) -> Vec<f64>;
    /// `freemem()`, bytes
    fn freemem(&self) -> f64;
    /// `totalmem()`, bytes
    fn totalmem(&self) -> f64;
    /// `counts.aiStreams()`
    fn ai_streams(&self) -> f64;
    /// `counts.cliChildren()`
    fn cli_children(&self) -> f64;
    /// `getHeapStatistics()`: `used_heap_size` and `heap_size_limit`, bytes
    fn heap_statistics(&self) -> (f64, f64);
    /// `process.memoryUsage.rss()`, bytes
    fn rss(&self) -> f64;
}

/// `mainProcessFigures`: `mainMB`, `heapMB`, `heapLimitMB`
pub fn main_process_figures(source: &dyn MemorySource) -> CrashMemory {
    let (used, limit) = source.heap_statistics();
    entry_of(vec![
        ("mainMB", number(math_round(source.rss() / MB))),
        ("heapMB", number(math_round(used / MB))),
        ("heapLimitMB", number(math_round(limit / MB))),
    ])
}

/// `memoryFigures`
pub fn memory_figures(source: &dyn MemorySource) -> CrashMemory {
    let mut app_kb = 0.0;
    for size in source.app_working_set_sizes() {
        app_kb += size;
    }
    let mut figures = entry_of(vec![
        ("appMB", number(math_round(app_kb / 1024.0))),
        ("freeMB", number(math_round(source.freemem() / MB))),
        ("totalMB", number(math_round(source.totalmem() / MB))),
        ("aiStreams", number(source.ai_streams())),
        ("cliChildren", number(source.cli_children())),
    ]);
    figures.assign(&main_process_figures(source));
    figures
}

/// `LOW_MEMORY_FLOOR_MB`: below this much free memory the PC counts as short, whatever its size
pub const LOW_MEMORY_FLOOR_MB: f64 = 512.0;
/// `LOW_MEMORY_SHARE`: ...and below this share of its physical memory
pub const LOW_MEMORY_SHARE: f64 = 0.08;

/// `isLowMemory`
pub fn is_low_memory(free_mb: f64, total_mb: f64) -> bool {
    free_mb < jscompat::math_max(LOW_MEMORY_FLOOR_MB, total_mb * LOW_MEMORY_SHARE)
}

/// `HEAP_SHORT_SHARE`: past this share of its limit the main process's heap counts as short
pub const HEAP_SHORT_SHARE: f64 = 0.85;

/// `isHeapShort`
pub fn is_heap_short(heap_mb: f64, heap_limit_mb: f64) -> bool {
    heap_limit_mb > 0.0 && heap_mb > heap_limit_mb * HEAP_SHORT_SHARE
}

/// `MemoryProbe`: the cheap figures each sample looks at
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MemoryProbe {
    pub free_mb: f64,
    pub total_mb: f64,
    pub heap_mb: f64,
    pub heap_limit_mb: f64,
}

impl MemoryProbe {
    /// the object `{ ...seen }` writes into a line, keys in this order
    fn entry(&self) -> CrashMemory {
        entry_of(vec![
            ("freeMB", number(self.free_mb)),
            ("totalMB", number(self.total_mb)),
            ("heapMB", number(self.heap_mb)),
            ("heapLimitMB", number(self.heap_limit_mb)),
        ])
    }
}

/// `probeMemory`
pub fn probe_memory(source: &dyn MemorySource) -> MemoryProbe {
    let (used, limit) = source.heap_statistics();
    let free_mb = math_round(source.freemem() / MB);
    let total_mb = math_round(source.totalmem() / MB);
    MemoryProbe {
        free_mb,
        total_mb,
        heap_mb: math_round(used / MB),
        heap_limit_mb: math_round(limit / MB),
    }
}

/// What `startLowMemoryWatch` reaches: its options and the user data folder.
pub trait LowMemoryHost {
    /// `app.getPath('userData')`
    fn user_data_dir(&self) -> String;
    /// `options.memory()`; an `Err` is a throw
    fn memory(&self) -> Result<CrashMemory, Failure>;
    /// `options.probe ?? probeMemory`
    fn probe(&self) -> Result<MemoryProbe, Failure>;
    /// `options.now ?? Date.now`
    fn now(&self) -> f64;
    /// `new Date()`, in milliseconds since the epoch
    fn clock_ms(&self) -> f64;
}

/// `startLowMemoryWatch`: the state of its timer's callback
#[derive(Debug)]
pub struct LowMemoryWatch {
    cooldown_ms: f64,
    last_at: f64,
    sample_ms: f64,
}

impl LowMemoryWatch {
    /// `sampleMs` and `cooldownMs` as the options give them
    pub fn new(sample_ms: Option<f64>, cooldown_ms: Option<f64>) -> Self {
        LowMemoryWatch {
            cooldown_ms: cooldown_ms.unwrap_or(10.0 * 60_000.0),
            last_at: f64::NEG_INFINITY,
            sample_ms: sample_ms.unwrap_or(15_000.0),
        }
    }

    /// the interval the caller's timer runs at
    pub fn sample_ms(&self) -> f64 {
        self.sample_ms
    }

    /// the timer's callback; best effort, so nothing escapes
    pub fn sample(&mut self, host: &dyn LowMemoryHost) {
        let _ = self.try_sample(host);
    }

    fn try_sample(&mut self, host: &dyn LowMemoryHost) -> Result<(), ()> {
        if host.now() - self.last_at < self.cooldown_ms {
            return Ok(());
        }
        let seen = host.probe().map_err(|_| ())?;
        let reason = if is_low_memory(seen.free_mb, seen.total_mb) {
            "pc"
        } else if is_heap_short(seen.heap_mb, seen.heap_limit_mb) {
            "main-heap"
        } else {
            return Ok(());
        };
        self.last_at = host.now();
        // the arguments of appendCrashLog evaluate in order: the path first
        let path = crash_log_path(&host.user_data_dir());
        let mut entry = seen.entry();
        entry.assign(&host.memory().map_err(|_| ())?);
        entry.set("kind", JsonValue::String("low-memory".to_owned()));
        entry.set("reason", JsonValue::String(reason.to_owned()));
        append_crash_log(&path, &entry, CRASH_LOG_MAX_BYTES, host.clock_ms()).map_err(|_| ())
    }
}

/// `startCrashWatch`: the `prompting` set and the options
pub struct CrashWatch<H: CrashWatchHost> {
    host: H,
    prompting: HashSet<i64>,
}

impl<H: CrashWatchHost> CrashWatch<H> {
    pub fn start(host: H) -> Self {
        CrashWatch {
            host,
            prompting: HashSet::new(),
        }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    /// `record`
    fn record(&self, entry: CrashEntry) -> Result<(), InvalidTimeValue> {
        let mut memory = CrashMemory::new();
        // the line goes out without figures when they cannot be read
        if let Some(Ok(figures)) = self.host.memory() {
            memory = figures;
        }
        memory.assign(&entry);
        let path = crash_log_path(&self.host.user_data_dir());
        append_crash_log(&path, &memory, CRASH_LOG_MAX_BYTES, self.host.now_ms())
    }

    /// `process.on('uncaughtExceptionMonitor', error => ...)`
    pub fn on_uncaught_exception_monitor(&self, error: &Thrown) -> Result<(), InvalidTimeValue> {
        self.record(entry_of(vec![
            ("kind", JsonValue::String("main-exception".to_owned())),
            ("reason", JsonValue::String(error_reason(error))),
        ]))
    }

    /// `process.on('unhandledRejection', error => ...)`; `shown` is `error` as
    /// the console prints it
    pub fn on_unhandled_rejection(
        &self,
        error: &Thrown,
        shown: &str,
    ) -> Result<(), InvalidTimeValue> {
        self.record(entry_of(vec![
            ("kind", JsonValue::String("main-rejection".to_owned())),
            ("reason", JsonValue::String(error_reason(error))),
        ]))?;
        // a listener silences Node's own warning, so keep it on the console
        self.host.warn_unhandled_rejection(shown);
        Ok(())
    }

    /// `app.on('child-process-gone', (_event, details) => ...)`
    pub fn on_child_process_gone(&self, details: &ChildGone) -> Result<(), InvalidTimeValue> {
        if not_a_crash(&details.reason) {
            return Ok(());
        }
        // utility processes (document jobs, converters) are ended on purpose all the time
        if details.reason == "killed" && details.kind == "Utility" {
            return Ok(());
        }
        self.record(entry_of(vec![
            ("kind", JsonValue::String("child-process".to_owned())),
            ("reason", JsonValue::String(details.reason.clone())),
            ("exitCode", number(details.exit_code)),
            ("process", JsonValue::String(details.kind.clone())),
        ]))
    }

    /// `app.on('render-process-gone', (_event, wc, details) => ...)`: the box
    /// to show for the gone renderer's document, if any
    pub fn on_render_process_gone(
        &mut self,
        disposal: &RendererDisposal,
        wc: &H::Contents,
        details: &RenderGone,
    ) -> Result<Option<CrashPrompt<H::Copy>>, CrashWatchError> {
        // a closed document's renderer the shell ended to free its memory
        if disposal.was_released_renderer(wc.id()) {
            return Ok(None);
        }
        if not_a_crash(&details.reason) {
            return Ok(None);
        }
        // keep 'other' when the lookup throws
        let editor = self
            .host
            .editor_of(wc)
            .unwrap_or_else(|_| "other".to_owned());
        self.record(entry_of(vec![
            ("kind", JsonValue::String("renderer".to_owned())),
            ("reason", JsonValue::String(details.reason.clone())),
            ("exitCode", number(details.exit_code)),
            ("editor", JsonValue::String(editor)),
        ]))?;
        if !self.host.prompt() || !should_prompt_for_gone_renderer(&details.reason) {
            return Ok(None);
        }
        // no copy known: the tab is handled as before
        let untitled_copy = self.host.untitled_copy_of(wc).unwrap_or(None);
        self.begin_prompt(wc, untitled_copy)
            .map_err(CrashWatchError::Rejected)
    }

    /// `promptForCrashedDocument` up to its `showMessageBox`
    fn begin_prompt(
        &mut self,
        wc: &H::Contents,
        untitled_copy: Option<H::Copy>,
    ) -> Result<Option<CrashPrompt<H::Copy>>, Failure> {
        if wc.is_destroyed() || self.prompting.contains(&wc.id()) {
            return Ok(None);
        }
        let Some(doc) = self.host.document_of(wc)? else {
            return Ok(None);
        };
        self.prompting.insert(wc.id());
        // slides keeps the open deck in the main process, so a reload brings it all back;
        // an untitled document comes back from its recovery copy (a working file it
        // may point at, like a PDF template copy's, is not the user's document)
        let copy = if self.host.can_reopen_untitled() {
            untitled_copy
        } else {
            None
        };
        let action = if doc.kind == "slides" {
            CrashAction::Reload
        } else if copy.is_some() {
            CrashAction::ReopenUntitled
        } else if doc.file_path.as_deref().is_some_and(|p| !p.is_empty()) {
            CrashAction::Reopen
        } else {
            CrashAction::Close
        };
        let action_label = match action {
            CrashAction::Reload => self.host.t(CrashStringKey::CrashReload, None),
            CrashAction::Reopen | CrashAction::ReopenUntitled => {
                self.host.t(CrashStringKey::CrashReopen, None)
            }
            CrashAction::Close => self.host.t(CrashStringKey::CrashClose, None),
        };
        let message = self.host.t(CrashStringKey::CrashTitle, None);
        let detail = self.host.t(CrashStringKey::CrashBody, Some(&doc.title));
        let later = self.host.t(CrashStringKey::CrashLater, None);
        let options = MessageBoxOptions {
            kind: "warning",
            title: None,
            message,
            detail: Some(detail),
            buttons: vec![action_label, later],
            default_id: 0,
            cancel_id: Some(1),
            no_link: Some(true),
        };
        let parent = match self.host.parent_window(wc) {
            Ok(parent) => parent,
            Err(_) => {
                // a failed prompt leaves the tab as it is
                self.prompting.remove(&wc.id());
                return Ok(None);
            }
        };
        let over_parent = matches!(&parent, Some(parent) if !parent.is_destroyed());
        Ok(Some(CrashPrompt {
            options,
            over_parent,
            wc_id: wc.id(),
            doc,
            copy,
            action,
        }))
    }

    /// the rest of `promptForCrashedDocument`, once the box was answered:
    /// `response` is the pressed button, `Err` is the dialog's rejection
    pub fn finish_prompt(
        &mut self,
        wc: &H::Contents,
        prompt: CrashPrompt<H::Copy>,
        response: Result<f64, Failure>,
    ) {
        // a failed prompt leaves the tab as it is
        let _ = self.after_answer(wc, &prompt, response);
        self.prompting.remove(&prompt.wc_id);
    }

    fn after_answer(
        &self,
        wc: &H::Contents,
        prompt: &CrashPrompt<H::Copy>,
        response: Result<f64, Failure>,
    ) -> Result<(), Failure> {
        let response = response?;
        if response != 0.0 || wc.is_destroyed() {
            return Ok(());
        }
        if prompt.action == CrashAction::Reload {
            return wc.reload();
        }
        let gone = self.host.close_document(wc)?;
        if !gone {
            return Ok(());
        }
        if let (CrashAction::ReopenUntitled, Some(copy)) = (prompt.action, &prompt.copy) {
            self.host.reopen_untitled(&prompt.doc, copy)?;
        } else if let (CrashAction::Reopen, Some(path)) = (prompt.action, &prompt.doc.file_path)
            && !path.is_empty()
        {
            self.host.reopen(path)?;
        }
        Ok(())
    }
}
