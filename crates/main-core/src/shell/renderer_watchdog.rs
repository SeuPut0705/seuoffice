//! `apps/shell/src/main/renderer-watchdog.ts`: samples `app.getAppMetrics()`,
//! records diagnostics under userData when a renderer stays hot, and offers
//! to close the document.
//!
//! The timer is the caller's: it calls [`RendererWatchdog::sample`] every
//! [`RendererWatchdog::sample_ms`]. A sample answers the reports it started
//! (the TypeScript starts each as a detached promise). A report is a state
//! machine the caller drives, because it awaits things whose answers arrive
//! on the thread that asked: [`RendererWatchdog::start_report`] starts it and
//! answers the first [`ReportStep`]; the caller carries each step out (a CDP
//! command, a sleep, the box, the close of the document) and hands the
//! answer to [`ReportRun::resume`], which answers the next one.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::rc::Rc;

use jscompat::node_path::host::join;
use jscompat::{
    JsObject, JsonValue, js_regex, json_stringify, json_stringify_pretty, json_value_from_serde,
    math_max, math_round, sort_by_number, to_iso_string, to_number,
};
use serde_json::Value;

use crate::node_fs::{NodeError, node_error};
use crate::packages::electron_utils::message_box::{MessageBoxOptions, ParentWindow};
use crate::shell::renderer_disposal::Failure;

#[derive(Debug, Clone, PartialEq)]
pub struct WatchdogDocumentInfo {
    pub kind: String,
    pub title: String,
    pub file_path: Option<String>,
}

impl WatchdogDocumentInfo {
    fn json(&self) -> JsonValue {
        let mut object = JsObject::new();
        object.set("kind", JsonValue::String(self.kind.clone()));
        object.set("title", JsonValue::String(self.title.clone()));
        if let Some(path) = &self.file_path {
            object.set("filePath", JsonValue::String(path.clone()));
        }
        JsonValue::Object(object)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogStringKey {
    WatchdogTitle,
    WatchdogBody,
    WatchdogWait,
    WatchdogClose,
    WatchdogIgnore,
}

impl WatchdogStringKey {
    pub fn as_str(self) -> &'static str {
        match self {
            WatchdogStringKey::WatchdogTitle => "watchdogTitle",
            WatchdogStringKey::WatchdogBody => "watchdogBody",
            WatchdogStringKey::WatchdogWait => "watchdogWait",
            WatchdogStringKey::WatchdogClose => "watchdogClose",
            WatchdogStringKey::WatchdogIgnore => "watchdogIgnore",
        }
    }
}

/// the `{ title, memory, cpu }` params of `watchdogBody`
#[derive(Debug, Clone, PartialEq)]
pub struct BodyParams {
    pub title: String,
    pub memory: f64,
    pub cpu: f64,
}

/// the part of a `WebContents` the watchdog reads
pub trait WatchdogContents {
    fn id(&self) -> i64;
    fn is_destroyed(&self) -> bool;
    fn get_os_process_id(&self) -> i64;
    fn get_url(&self) -> String;
    /// `wc.debugger.isAttached()`
    fn debugger_is_attached(&self) -> bool;
    /// `wc.debugger.attach(protocol)`
    fn debugger_attach(&self, protocol: &str) -> Result<(), Failure>;
    /// `wc.debugger.detach()`
    fn debugger_detach(&self) -> Result<(), Failure>;
}

/// the `ProcessMetric` the watchdog reads, with the object itself for the report
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessMetric {
    pub pid: i64,
    /// `metric.type`
    pub kind: String,
    /// `metric.memory.workingSetSize`, kilobytes
    pub working_set_size: f64,
    /// `metric.cpu.cumulativeCPUUsage`
    pub cumulative_cpu_usage: Option<f64>,
    pub json: Value,
}

/// `RendererWatchdogOptions` and what the watchdog reads from Electron
pub trait WatchdogHost {
    type Contents: WatchdogContents + Clone;
    type Window: ParentWindow;

    /// `app.getPath('userData')`
    fn user_data_dir(&self) -> String;
    /// `Date.now()`
    fn now_ms(&self) -> f64;
    /// `app.getAppMetrics()`; an `Err` is a throw
    fn app_metrics(&self) -> Result<Vec<ProcessMetric>, Failure>;
    /// `webContents.getAllWebContents()`
    fn all_web_contents(&self) -> Vec<Self::Contents>;
    /// `options.describe(wc)`
    fn describe(&self, wc: &Self::Contents) -> Result<Option<WatchdogDocumentInfo>, Failure>;
    /// `options.parentWindow(wc)`
    fn parent_window(&self, wc: &Self::Contents) -> Result<Option<Self::Window>, Failure>;
    /// `options.t(key, params)`
    fn t(&self, key: WatchdogStringKey, params: Option<&BodyParams>) -> String;
}

/// what the options leave out, the `DEFAULTS` fill
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct WatchdogOptions {
    pub sample_ms: Option<f64>,
    pub memory_limit_mb: Option<f64>,
    pub cpu_limit_percent: Option<f64>,
    /// consecutive hot samples before the renderer is reported
    pub hot_samples_before_report: Option<f64>,
    /// minimum gap between two reports of the same renderer
    pub report_cooldown_ms: Option<f64>,
    /// duration of the CPU profile captured with a report (0 disables)
    pub profile_ms: Option<f64>,
}

/// `DEFAULTS`
const DEFAULT_SAMPLE_MS: f64 = 30_000.0;
const DEFAULT_CPU_LIMIT_PERCENT: f64 = 90.0;
const DEFAULT_HOT_SAMPLES_BEFORE_REPORT: f64 = 10.0;
const DEFAULT_REPORT_COOLDOWN_MS: f64 = 15.0 * 60_000.0;
const DEFAULT_PROFILE_MS: f64 = 5_000.0;

/// `MEMORY_REPROMPT_GROWTH`: after the first prompt, a memory-triggered report
/// repeats only when the renderer has grown this much past the memory at the
/// previous prompt
const MEMORY_REPROMPT_GROWTH: f64 = 1.25;

const MEMORY_LIMIT_FLOOR_MB: f64 = 1536.0;
const MEMORY_LIMIT_SHARE_OF_PC: f64 = 1.0 / 8.0;

/// `memoryLimitFor`
pub fn memory_limit_for(total_bytes: f64) -> f64 {
    math_max(
        MEMORY_LIMIT_FLOOR_MB,
        (total_bytes / (1024.0 * 1024.0)) * MEMORY_LIMIT_SHARE_OF_PC,
    )
}

const KEPT_REPORTS: usize = 5;

/// `pruneOldReports`: the newest `KEPT_REPORTS` report stamps stay
pub fn prune_old_reports(dir: &str) -> Result<(), NodeError> {
    let mut by_stamp: Vec<(f64, Vec<String>)> = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| node_error(&e, "scandir", dir))?;
    for entry in entries {
        let entry = entry.map_err(|e| node_error(&e, "scandir", dir))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let stamp = js_regex!(r"^renderer-watchdog-(\d+)\.(?:json|cpuprofile)$")
            .exec(&name)
            .and_then(|m| m.get(1).map(str::to_owned));
        if let Some(stamp) = stamp.filter(|s| !s.is_empty()) {
            let key = to_number(&stamp);
            match by_stamp.iter_mut().find(|(k, _)| *k == key) {
                Some((_, names)) => names.push(name),
                None => by_stamp.push((key, vec![name])),
            }
        }
    }
    let mut stamps: Vec<f64> = by_stamp.iter().map(|(k, _)| *k).collect();
    sort_by_number(&mut stamps, |a, b| b - a);
    let mut first_error = None;
    for stamp in stamps.into_iter().skip(KEPT_REPORTS) {
        let Some((_, names)) = by_stamp.iter().find(|(k, _)| *k == stamp) else {
            continue;
        };
        for name in names {
            // rm(path, { force: true }): a missing file is fine, a folder is not
            let path = join(&[dir, name]);
            let result = match fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_dir() => Err(NodeError {
                    code: Some("ERR_FS_EISDIR"),
                    message: format!(
                        "Path is a directory: rm returned EISDIR (is a directory) {path}"
                    ),
                }),
                Ok(_) => fs::remove_file(&path).map_err(|e| node_error(&e, "rm", &path)),
                Err(_) => Ok(()),
            };
            if let Err(e) = result
                && first_error.is_none()
            {
                first_error = Some(e);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// `RendererState`
#[derive(Debug, Clone, Default)]
struct RendererState {
    hot: f64,
    reported_at: f64,
    prompting: bool,
    /// user chose "don't remind again" for this renderer
    ignored: bool,
    /// memory at the previous prompt; gates memory-only re-prompts
    prompted_memory_mb: Option<f64>,
    /// cumulative CPU seconds at the previous sample (absent on the first)
    cpu_seconds: Option<f64>,
    sampled_at: Option<f64>,
}

/// a renderer `sample` decided to report
pub struct Report<C> {
    wc: C,
    metric: Value,
    all: Vec<Value>,
    memory_mb: f64,
    cpu: f64,
}

/// the box of a report, and what it was built from
pub struct WatchdogPrompt {
    pub options: MessageBoxOptions,
    /// `showMessageBox(parent, options)`; false is `showMessageBox(options)`
    pub over_parent: bool,
    /// `state` of the report: the object the TypeScript captured, which a
    /// sample may drop from `states` while the box is up
    state: Rc<RefCell<RendererState>>,
}

/// `startRendererWatchdog`: its merged options and `states`
pub struct RendererWatchdog {
    sample_ms: f64,
    memory_limit_mb: f64,
    cpu_limit_percent: f64,
    hot_samples_before_report: f64,
    report_cooldown_ms: f64,
    profile_ms: f64,
    states: HashMap<i64, Rc<RefCell<RendererState>>>,
}

/// What [`RendererWatchdog::start_report`] answers: the run and its first step.
pub type ReportStart<C> = (ReportRun<C>, ReportStep<C>);

impl RendererWatchdog {
    /// `{ ...DEFAULTS, memoryLimitMB: memoryLimitFor(totalmem()), ...options }`
    pub fn new(options: WatchdogOptions, total_bytes: f64) -> Self {
        RendererWatchdog {
            sample_ms: options.sample_ms.unwrap_or(DEFAULT_SAMPLE_MS),
            memory_limit_mb: options
                .memory_limit_mb
                .unwrap_or_else(|| memory_limit_for(total_bytes)),
            cpu_limit_percent: options
                .cpu_limit_percent
                .unwrap_or(DEFAULT_CPU_LIMIT_PERCENT),
            hot_samples_before_report: options
                .hot_samples_before_report
                .unwrap_or(DEFAULT_HOT_SAMPLES_BEFORE_REPORT),
            report_cooldown_ms: options
                .report_cooldown_ms
                .unwrap_or(DEFAULT_REPORT_COOLDOWN_MS),
            profile_ms: options.profile_ms.unwrap_or(DEFAULT_PROFILE_MS),
            states: HashMap::new(),
        }
    }

    /// the interval the caller's timer runs at
    pub fn sample_ms(&self) -> f64 {
        self.sample_ms
    }

    /// `rendererFor`
    fn renderer_for<H: WatchdogHost>(host: &H, pid: i64) -> Option<H::Contents> {
        host.all_web_contents()
            .into_iter()
            .find(|wc| !wc.is_destroyed() && wc.get_os_process_id() == pid)
    }

    /// `sample`: the reports it started, in order
    pub fn sample<H: WatchdogHost>(&mut self, host: &H) -> Vec<Report<H::Contents>> {
        let mut reports = Vec::new();
        let Ok(metrics) = host.app_metrics() else {
            return reports;
        };
        let all: Vec<Value> = metrics.iter().map(|m| m.json.clone()).collect();
        let mut seen: Vec<i64> = Vec::new();
        for metric in &metrics {
            if metric.kind != "Tab" {
                continue;
            }
            let Some(wc) = Self::renderer_for(host, metric.pid) else {
                continue;
            };
            seen.push(wc.id());
            // workingSetSize is reported in kilobytes
            let memory_mb = metric.working_set_size / 1024.0;
            let state = Rc::clone(self.states.entry(wc.id()).or_default());
            let mut state = state.borrow_mut();
            // percentCPUUsage is normalized differently per platform (a full core
            // read 10% on a 10-core Mac): derive one-core percent from the
            // cumulative CPU seconds between two samples instead
            let now = host.now_ms();
            let mut cpu = 0.0;
            if let Some(cpu_seconds) = metric.cumulative_cpu_usage {
                if let (Some(before), Some(sampled_at)) = (state.cpu_seconds, state.sampled_at)
                    && now > sampled_at
                {
                    cpu = ((cpu_seconds - before) / ((now - sampled_at) / 1000.0)) * 100.0;
                }
                state.cpu_seconds = Some(cpu_seconds);
                state.sampled_at = Some(now);
            }
            if state.ignored {
                continue;
            }
            let hot = memory_mb > self.memory_limit_mb || cpu > self.cpu_limit_percent;
            state.hot = if hot { state.hot + 1.0 } else { 0.0 };
            let escalated = state.prompted_memory_mb.is_none()
                || cpu > self.cpu_limit_percent
                || memory_mb >= state.prompted_memory_mb.unwrap_or(0.0) * MEMORY_REPROMPT_GROWTH;
            if state.hot >= self.hot_samples_before_report
                && !state.prompting
                && escalated
                && host.now_ms() - state.reported_at >= self.report_cooldown_ms
            {
                state.reported_at = host.now_ms();
                state.prompted_memory_mb = Some(memory_mb);
                state.hot = 0.0;
                reports.push(Report {
                    wc,
                    metric: metric.json.clone(),
                    all: all.clone(),
                    memory_mb,
                    cpu,
                });
            }
        }
        let gone: Vec<i64> = self
            .states
            .keys()
            .filter(|id| !seen.contains(*id))
            .copied()
            .collect();
        for id in gone {
            self.states.remove(&id);
        }
        reports
    }

    /// `report` up to its first `await`: the document the renderer shows, the
    /// report file under userData, and the rest as steps. `Err` is `describe`
    /// throwing, which rejects the report (the process reports it as an
    /// unhandled rejection).
    pub fn start_report<H: WatchdogHost>(
        &self,
        host: &H,
        report: Report<H::Contents>,
    ) -> Result<ReportStart<H::Contents>, Failure> {
        let info = host.describe(&report.wc)?;
        let stamp = host.now_ms();
        let dir = host.user_data_dir();
        let base = join(&[
            &dir,
            &format!("renderer-watchdog-{}", jscompat::number_to_string(stamp)),
        ]);
        let mut run = ReportRun {
            wc: report.wc.clone(),
            info,
            dir,
            base,
            memory_mb: report.memory_mb,
            cpu: report.cpu,
            phase: Phase::Finished,
        };
        // diagnostics are best effort and must never make the situation worse
        let step = match self.write_report_file(&report, run.info.as_ref(), stamp, &run.base) {
            Ok(()) => self.after_report_file(host, &mut run),
            Err(_) => self.prompt_step(host, &mut run),
        };
        Ok((run, step))
    }

    /// the `writeFile` of the report's JSON
    fn write_report_file<C: WatchdogContents>(
        &self,
        report: &Report<C>,
        info: Option<&WatchdogDocumentInfo>,
        stamp: f64,
        base: &str,
    ) -> Result<(), String> {
        let wc = &report.wc;
        let at = to_iso_string(stamp).ok_or_else(|| "Invalid time value".to_owned())?;
        let mut object = JsObject::new();
        object.set("at", JsonValue::String(at));
        object.set("webContentsId", JsonValue::Number(wc.id() as f64));
        object.set(
            "pid",
            report
                .metric
                .get("pid")
                .map_or(JsonValue::Null, json_value_from_serde),
        );
        object.set(
            "document",
            info.map_or(JsonValue::Null, WatchdogDocumentInfo::json),
        );
        object.set("url", JsonValue::String(wc.get_url()));
        object.set("memoryMB", JsonValue::Number(math_round(report.memory_mb)));
        object.set("cpuPercent", JsonValue::Number(math_round(report.cpu)));
        object.set("metric", json_value_from_serde(&report.metric));
        object.set(
            "appMetrics",
            JsonValue::Array(report.all.iter().map(json_value_from_serde).collect()),
        );
        let text = json_stringify_pretty(&JsonValue::Object(object), 2);
        let json_path = format!("{base}.json");
        fs::write(&json_path, text).map_err(|e| node_error(&e, "open", &json_path).message)
    }

    /// after the JSON: the CPU profile, then the prune
    fn after_report_file<H: WatchdogHost>(
        &self,
        host: &H,
        run: &mut ReportRun<H::Contents>,
    ) -> ReportStep<H::Contents> {
        if self.profile_ms > 0.0 {
            match self.begin_profile(&run.wc) {
                Ok(Some(step)) => {
                    run.phase = Phase::Profile(ProfileAt::Enable);
                    return step;
                }
                // another debugger holds the renderer: no profile
                Ok(None) => {}
                // a failure skips the prune
                Err(_) => return self.prompt_step(host, run),
            }
        }
        self.prune_step(host, run)
    }

    /// `pruneOldReports`, then the prompt
    fn prune_step<H: WatchdogHost>(
        &self,
        host: &H,
        run: &mut ReportRun<H::Contents>,
    ) -> ReportStep<H::Contents> {
        // a failed prune only means diagnostics stay as they are
        let _ = prune_old_reports(&run.dir);
        self.prompt_step(host, run)
    }

    /// `captureCpuProfile` up to its first `await`: `Ok(None)` is its `false`
    fn begin_profile<C: WatchdogContents + Clone>(
        &self,
        wc: &C,
    ) -> Result<Option<ReportStep<C>>, Failure> {
        if wc.is_destroyed() || wc.debugger_is_attached() {
            return Ok(None);
        }
        wc.debugger_attach("1.3")?;
        Ok(Some(ReportStep::Command {
            wc: wc.clone(),
            method: "Profiler.enable",
            params: None,
        }))
    }

    /// the `finally` of `captureCpuProfile`
    fn end_profile<C: WatchdogContents>(wc: &C) {
        // already gone: nothing to detach
        if !wc.is_destroyed() {
            let _ = wc.debugger_detach();
        }
    }

    /// what the report does once its diagnostics are over: the box, or the end
    fn prompt_step<H: WatchdogHost>(
        &self,
        host: &H,
        run: &mut ReportRun<H::Contents>,
    ) -> ReportStep<H::Contents> {
        match self.ask(host, run) {
            Some(prompt) => {
                run.phase = Phase::Prompting(prompt.state);
                ReportStep::Prompt {
                    options: prompt.options,
                    over_parent: prompt.over_parent,
                }
            }
            None => {
                run.phase = Phase::Finished;
                ReportStep::Done
            }
        }
    }

    /// the prompt half of `report` up to `showMessageBox`: `None` where the
    /// report ends with its diagnostics
    fn ask<H: WatchdogHost>(
        &self,
        host: &H,
        run: &ReportRun<H::Contents>,
    ) -> Option<WatchdogPrompt> {
        let wc = &run.wc;
        // chrome renderers (Home) have no document to close: logging is all that applies
        let info = run.info.as_ref()?;
        if wc.is_destroyed() {
            return None;
        }
        let state = Rc::clone(self.states.get(&wc.id())?);
        if state.borrow().prompting {
            return None;
        }
        state.borrow_mut().prompting = true;
        let built = (|| -> Result<(MessageBoxOptions, bool), Failure> {
            let parent = host.parent_window(wc)?;
            let message = host.t(WatchdogStringKey::WatchdogTitle, None);
            let detail = host.t(
                WatchdogStringKey::WatchdogBody,
                Some(&BodyParams {
                    title: info.title.clone(),
                    memory: math_round(run.memory_mb),
                    cpu: math_round(run.cpu),
                }),
            );
            let buttons = vec![
                host.t(WatchdogStringKey::WatchdogWait, None),
                host.t(WatchdogStringKey::WatchdogClose, None),
                host.t(WatchdogStringKey::WatchdogIgnore, None),
            ];
            let options = MessageBoxOptions {
                kind: "warning",
                title: None,
                message,
                detail: Some(detail),
                buttons,
                default_id: 0,
                cancel_id: Some(0),
                no_link: None,
            };
            let over_parent = matches!(&parent, Some(parent) if !parent.is_destroyed());
            Ok((options, over_parent))
        })();
        match built {
            Ok((options, over_parent)) => Some(WatchdogPrompt {
                options,
                over_parent,
                state,
            }),
            Err(_) => {
                // a failed prompt only means the renderer keeps running
                state.borrow_mut().prompting = false;
                None
            }
        }
    }
}

/// where a report is waiting
enum Phase {
    /// inside `captureCpuProfile`, waiting for a command or the sleep
    Profile(ProfileAt),
    /// the box is up: `state` is the renderer's, which a sample may drop from
    /// `states` meanwhile
    Prompting(Rc<RefCell<RendererState>>),
    /// `await opts.closeDocument(wc)`
    Closing(Rc<RefCell<RendererState>>),
    Finished,
}

/// which `await` of `captureCpuProfile` is pending
#[derive(Clone, Copy, PartialEq, Eq)]
enum ProfileAt {
    Enable,
    Interval,
    Start,
    Sleep,
    Stop,
}

/// What the caller does next for a report.
pub enum ReportStep<C> {
    /// `await wc.debugger.sendCommand(method, params)`: answer with
    /// [`ReportAnswer::Command`]
    Command {
        wc: C,
        method: &'static str,
        params: Option<Value>,
    },
    /// `await sleep(ms)`: answer with [`ReportAnswer::Slept`] when it is over
    Sleep(f64),
    /// the box: `showMessageBox(parent, options)` when `over_parent`, else
    /// `showMessageBox(options)`; answer with [`ReportAnswer::Dialog`]
    Prompt {
        options: MessageBoxOptions,
        over_parent: bool,
    },
    /// `await opts.closeDocument(wc)`: answer with [`ReportAnswer::Closed`]
    CloseDocument(C),
    /// the report ended
    Done,
}

/// The answer of the `await` the last step asked for. `Err` is a rejection.
pub enum ReportAnswer {
    Command(Result<Value, Failure>),
    Slept,
    /// the pressed button
    Dialog(Result<f64, Failure>),
    Closed(Result<(), Failure>),
}

/// One `report` of the TypeScript, between its `await`s.
pub struct ReportRun<C> {
    wc: C,
    info: Option<WatchdogDocumentInfo>,
    dir: String,
    base: String,
    memory_mb: f64,
    cpu: f64,
    phase: Phase,
}

impl<C: WatchdogContents + Clone> ReportRun<C> {
    /// the answer of the `await` the last step asked for
    pub fn resume<H: WatchdogHost<Contents = C>>(
        &mut self,
        dog: &RendererWatchdog,
        host: &H,
        answer: ReportAnswer,
    ) -> ReportStep<C> {
        let phase = std::mem::replace(&mut self.phase, Phase::Finished);
        match (phase, answer) {
            (Phase::Profile(at), answer) => self.resume_profile(dog, host, at, answer),
            (Phase::Prompting(state), ReportAnswer::Dialog(response)) => {
                let wc = &self.wc;
                if let Ok(response) = &response {
                    let response = *response;
                    if response == 1.0 && !wc.is_destroyed() {
                        self.phase = Phase::Closing(state);
                        return ReportStep::CloseDocument(wc.clone());
                    }
                }
                let outcome = (|| -> Result<bool, Failure> {
                    let response = response?;
                    Ok(response == 2.0)
                })();
                Self::end_prompt(&state, outcome);
                ReportStep::Done
            }
            (Phase::Closing(state), ReportAnswer::Closed(result)) => {
                Self::end_prompt(&state, result.map(|()| false));
                ReportStep::Done
            }
            // an answer to nothing that was asked
            _ => ReportStep::Done,
        }
    }

    /// the `finally` of the prompt: an ignore is remembered, the box is free again
    fn end_prompt(state: &Rc<RefCell<RendererState>>, outcome: Result<bool, Failure>) {
        let mut state = state.borrow_mut();
        if matches!(outcome, Ok(true)) {
            state.ignored = true;
        }
        state.prompting = false;
    }

    fn resume_profile<H: WatchdogHost<Contents = C>>(
        &mut self,
        dog: &RendererWatchdog,
        host: &H,
        at: ProfileAt,
        answer: ReportAnswer,
    ) -> ReportStep<C> {
        let wc = self.wc.clone();
        let command = |method: &'static str, params: Option<Value>| ReportStep::Command {
            wc: wc.clone(),
            method,
            params,
        };
        // a throw leaves captureCpuProfile through its `finally`, and the
        // report through its `catch`: no prune
        let failed = |run: &mut Self| {
            RendererWatchdog::end_profile(&wc);
            dog.prompt_step(host, run)
        };
        match (at, answer) {
            (ProfileAt::Enable, ReportAnswer::Command(Ok(_))) => {
                self.phase = Phase::Profile(ProfileAt::Interval);
                let mut interval = serde_json::Map::new();
                interval.insert("interval".to_owned(), Value::from(1000));
                command(
                    "Profiler.setSamplingInterval",
                    Some(Value::Object(interval)),
                )
            }
            (ProfileAt::Interval, ReportAnswer::Command(Ok(_))) => {
                self.phase = Phase::Profile(ProfileAt::Start);
                command("Profiler.start", None)
            }
            (ProfileAt::Start, ReportAnswer::Command(Ok(_))) => {
                self.phase = Phase::Profile(ProfileAt::Sleep);
                ReportStep::Sleep(dog.profile_ms)
            }
            (ProfileAt::Sleep, ReportAnswer::Slept) => {
                self.phase = Phase::Profile(ProfileAt::Stop);
                command("Profiler.stop", None)
            }
            (ProfileAt::Stop, ReportAnswer::Command(Ok(stopped))) => {
                let out_path = format!("{}.cpuprofile", self.base);
                let written = stopped
                    .get("profile")
                    .ok_or_else(|| Failure("profile is undefined".to_owned()))
                    .and_then(|profile| {
                        let text = json_stringify(&json_value_from_serde(profile));
                        fs::write(&out_path, text)
                            .map_err(|e| Failure(node_error(&e, "open", &out_path).message))
                    });
                RendererWatchdog::end_profile(&wc);
                match written {
                    Ok(()) => dog.prune_step(host, self),
                    Err(_) => dog.prompt_step(host, self),
                }
            }
            // a command that rejected
            (_, ReportAnswer::Command(Err(_))) => failed(self),
            _ => ReportStep::Done,
        }
    }
}
