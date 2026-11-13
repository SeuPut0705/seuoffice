//! `apps/shell/src/main/renderer-watchdog.ts`: samples `app.getAppMetrics()`,
//! records diagnostics under userData when a renderer stays hot, and offers
//! to close the document.
//!
//! The timer is the caller's: it calls [`RendererWatchdog::sample`] every
//! [`RendererWatchdog::sample_ms`]. A sample answers the reports it started
//! (the TypeScript starts each as a detached promise). A report runs in
//! three steps because its dialog is a promise a later sample can overtake:
//! [`RendererWatchdog::diagnose`] writes the files and finds the document,
//! [`RendererWatchdog::ask`] builds the box, and the caller shows it and
//! reports the answer to [`RendererWatchdog::answered`].

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
    /// `wc.debugger.sendCommand(method, params)`
    fn debugger_send_command(&self, method: &str, params: Option<Value>) -> Result<Value, Failure>;
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
    /// `options.closeDocument(wc)`
    fn close_document(&self, wc: &Self::Contents) -> Result<(), Failure>;
    /// `options.t(key, params)`
    fn t(&self, key: WatchdogStringKey, params: Option<&BodyParams>) -> String;
    /// `sleep(ms)`
    fn sleep(&self, ms: f64);
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

/// `captureCpuProfile`: a short CDP CPU profile of a live renderer; `Ok(false)`
/// when another debugger holds it
fn capture_cpu_profile<H: WatchdogHost>(
    host: &H,
    wc: &H::Contents,
    out_path: &str,
    ms: f64,
) -> Result<bool, Failure> {
    if wc.is_destroyed() || wc.debugger_is_attached() {
        return Ok(false);
    }
    wc.debugger_attach("1.3")?;
    let run = || -> Result<bool, Failure> {
        wc.debugger_send_command("Profiler.enable", None)?;
        let mut interval = serde_json::Map::new();
        interval.insert("interval".to_owned(), Value::from(1000));
        wc.debugger_send_command(
            "Profiler.setSamplingInterval",
            Some(Value::Object(interval)),
        )?;
        wc.debugger_send_command("Profiler.start", None)?;
        host.sleep(ms);
        let stopped = wc.debugger_send_command("Profiler.stop", None)?;
        let profile = stopped
            .get("profile")
            .ok_or_else(|| Failure("profile is undefined".to_owned()))?;
        let text = json_stringify(&json_value_from_serde(profile));
        fs::write(out_path, text).map_err(|e| Failure(node_error(&e, "open", out_path).message))?;
        Ok(true)
    };
    let result = run();
    // already gone: nothing to detach
    if !wc.is_destroyed() {
        let _ = wc.debugger_detach();
    }
    result
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

    /// the first half of `report`: the diagnostics under userData, and the
    /// document the renderer shows. `Err` is `describe` throwing, which
    /// rejects the report (the process reports it as an unhandled rejection).
    pub fn diagnose<H: WatchdogHost>(
        &self,
        host: &H,
        report: &Report<H::Contents>,
    ) -> Result<Option<WatchdogDocumentInfo>, Failure> {
        let wc = &report.wc;
        let info = host.describe(wc)?;
        let stamp = host.now_ms();
        let dir = host.user_data_dir();
        let base = join(&[
            &dir,
            &format!("renderer-watchdog-{}", jscompat::number_to_string(stamp)),
        ]);
        // diagnostics are best effort and must never make the situation worse
        let _ = self.write_diagnostics(host, report, info.as_ref(), stamp, &dir, &base);
        Ok(info)
    }

    fn write_diagnostics<H: WatchdogHost>(
        &self,
        host: &H,
        report: &Report<H::Contents>,
        info: Option<&WatchdogDocumentInfo>,
        stamp: f64,
        dir: &str,
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
        fs::write(&json_path, text).map_err(|e| node_error(&e, "open", &json_path).message)?;
        if self.profile_ms > 0.0 {
            capture_cpu_profile(host, wc, &format!("{base}.cpuprofile"), self.profile_ms)
                .map_err(|e| e.0)?;
        }
        prune_old_reports(dir).map_err(|e| e.message)
    }

    /// the prompt half of `report` up to `showMessageBox`: `None` where the
    /// report ends with its diagnostics
    pub fn ask<H: WatchdogHost>(
        &self,
        host: &H,
        report: &Report<H::Contents>,
        info: Option<&WatchdogDocumentInfo>,
    ) -> Option<WatchdogPrompt> {
        let wc = &report.wc;
        // chrome renderers (Home) have no document to close: logging is all that applies
        let info = info?;
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
                    memory: math_round(report.memory_mb),
                    cpu: math_round(report.cpu),
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

    /// the rest of `report`, once the box was answered: `response` is the
    /// pressed button, `Err` is the dialog's rejection
    pub fn answered<H: WatchdogHost>(
        &self,
        host: &H,
        report: &Report<H::Contents>,
        prompt: WatchdogPrompt,
        response: Result<f64, Failure>,
    ) {
        let wc = &report.wc;
        let outcome = (|| -> Result<bool, Failure> {
            let response = response?;
            if response == 1.0 && !wc.is_destroyed() {
                host.close_document(wc)?;
            }
            Ok(response == 2.0)
        })();
        let mut state = prompt.state.borrow_mut();
        if matches!(outcome, Ok(true)) {
            state.ignored = true;
        }
        state.prompting = false;
    }
}
