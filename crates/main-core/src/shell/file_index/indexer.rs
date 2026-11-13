//! `apps/shell/src/main/file-index/indexer.ts`: keeps the store in step with
//! the disk. A scan diffs mtime and size against the index, changed files
//! queue for extraction on the worker one at a time, and vanished files are
//! dropped. Scans coalesce; extraction is sequential so the user's foreground
//! work keeps the CPU.
//!
//! The class is [`FileIndexer`], a struct the caller owns. What it awaits
//! and what it schedules are the caller's: [`IndexerHost`] is the worker
//! (`new Worker`, `postMessage`, `terminate`), the timers (`setTimeout`,
//! `setImmediate`), the clock and the sources of the files to index, each
//! called where the TypeScript calls it. What arrives from outside is an
//! event method the caller calls, one per macrotask of the TypeScript: a
//! timer that fires ([`FileIndexer::on_timer`]), a message of the worker
//! ([`FileIndexer::on_worker_message`]), the `error` and `exit` of the worker
//! ([`FileIndexer::on_worker_drop`]), the end of the immediate
//! ([`FileIndexer::on_immediate`]) and the answer of `sources.nameOnly`
//! ([`FileIndexer::on_name_only`]). The store is passed to each call, as the
//! TypeScript's constructor held it.
//!
//! An `await` of a promise that is already settled (a request that could not
//! be posted, a name-only decision that was answered at once, the end of the
//! diff) resumes after the code that is running, in the order the promises
//! settled: that is a queue the event methods empty before they return. Each
//! `await` counts as one such step. A rejection of a promise nobody awaits
//! (`void this.scan()`) is an `Err` of the event method that was running.

use std::collections::{HashSet, VecDeque};

use jscompat::JsMap;
use serde::Serialize;

use super::extract::Extracted;
use super::extract_worker::{WorkerRequest, WorkerResponse};
use super::scan::{ScannedFile, stat_or_null};
use super::store::{FileIndexStore, IndexStatus, StoreError};
use crate::shell::folder_tree::is_supported_tree_file;

/// `IndexProgress`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IndexProgress {
    /// files currently in the index
    pub indexed: i64,
    /// files waiting for extraction
    pub pending: usize,
    pub scanning: bool,
}

pub const RESCAN_DEBOUNCE_MS: f64 = 1500.0;
/// a worker request left unanswered this long means a wedged parse or a
/// stalled walk: the request fails as an extraction error and the worker is
/// recycled, so one bad file cannot stall indexing (and search with it) for good
pub const WORKER_REQUEST_TIMEOUT_MS: f64 = 120_000.0;
/// heap cap for the extraction worker (`resourceLimits.maxOldGenerationSizeMb`)
pub const WORKER_HEAP_LIMIT_MB: f64 = 256.0;
/// Once a scan and its extractions are done nothing is lost by retiring the
/// worker: the next refresh spawns a fresh one in milliseconds
pub const WORKER_IDLE_MS: f64 = 5_000.0;
/// name-only rows written in one go before yielding to the event loop
const NAME_ONLY_BATCH: usize = 64;

/// The constructor's tunables: `requestTimeoutMs`, `workerHeapLimitMb` and
/// `workerIdleMs`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IndexerConfig {
    pub request_timeout_ms: f64,
    pub worker_heap_limit_mb: f64,
    pub worker_idle_ms: f64,
}

impl Default for IndexerConfig {
    fn default() -> Self {
        IndexerConfig {
            request_timeout_ms: WORKER_REQUEST_TIMEOUT_MS,
            worker_heap_limit_mb: WORKER_HEAP_LIMIT_MB,
            worker_idle_ms: WORKER_IDLE_MS,
        }
    }
}

/// Which timer: what `setTimeout` of the TypeScript is for. Each kind has at
/// most one timer at a time, so the kind names it for `clear_timer`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TimerKind {
    /// the debounce of `refresh`
    Rescan,
    /// the idle recycle of the worker (the TypeScript unrefs it)
    Idle,
    /// the timeout of the worker request with this id
    Request(f64),
}

/// The worker of the host, by a number of its own.
pub type WorkerId = u64;

/// What `sources.nameOnly` does with a batch.
#[derive(Debug, Clone, PartialEq)]
pub enum NameOnlyCall {
    /// the answer is not known yet: the caller calls [`FileIndexer::on_name_only`] with it
    Pending,
    /// answered now; `Err` is a source that throws or rejects
    Done(Result<HashSet<String>, ()>),
}

/// The world of a [`FileIndexer`].
pub trait IndexerHost {
    /// `Date.now()`
    fn now_ms(&mut self) -> f64;

    /// `sources.roots()`: the folders walked recursively
    fn roots(&mut self) -> Vec<String>;

    /// `sources.extraPaths()`: files outside the roots that should still be searchable
    fn extra_paths(&mut self) -> Vec<String>;

    /// `sources.nameOnly(paths)`: of the files a scan is about to (re)index,
    /// those to index by name only. `None` when the source has no such
    /// function (every file is extracted).
    fn name_only(&mut self, paths: &[String]) -> Option<NameOnlyCall>;

    /// `setTimeout`
    fn set_timer(&mut self, kind: TimerKind, ms: f64);

    /// `clearTimeout`
    fn clear_timer(&mut self, kind: TimerKind);

    /// `setImmediate`: the caller calls [`FileIndexer::on_immediate`]
    fn set_immediate(&mut self);

    /// `new Worker(workerPath, { resourceLimits })` with its listeners; `Err`
    /// is what the constructor throws, as its message
    fn spawn_worker(&mut self, heap_limit_mb: f64) -> Result<WorkerId, String>;

    /// `worker.postMessage(request)`; `Err` is the message of what it throws
    fn post(&mut self, worker: WorkerId, request: &WorkerRequest) -> Result<(), String>;

    /// `void worker.terminate()`
    fn terminate(&mut self, worker: WorkerId);
}

/// a scanned file and whether its body is left out (not on this PC)
#[derive(Debug, Clone, PartialEq)]
struct QueuedFile {
    file: ScannedFile,
    cloud: bool,
}

/// who is waiting for a worker request
#[derive(Debug, Clone, Copy, PartialEq)]
enum Awaiter {
    Scan,
    Drain,
}

/// `waiting`: the callback of a request in flight
struct Waiting {
    id: f64,
    awaiter: Awaiter,
}

/// a promise that settled and whose `await` has not resumed yet
enum Ready {
    Response(Awaiter, WorkerResponse),
    NameOnly(Result<HashSet<String>, ()>),
    DiffDone,
}

/// the `scan()` that is running
struct ScanTask {
    seen: JsMap<ScannedFile>,
    walked: bool,
    complete: bool,
    roots: Vec<String>,
    next_root: usize,
    changed: Vec<ScannedFile>,
    /// name-only for want of the content: looked at again, extracted once local
    recheck: Vec<ScannedFile>,
}

/// where the `drain()` that is running is suspended
enum DrainWait {
    /// not suspended
    Running,
    /// at the `setImmediate`
    Immediate,
    /// at the extraction of this file
    Extract(ScannedFile),
}

struct DrainTask {
    name_only_run: usize,
    wait: DrainWait,
}

pub struct FileIndexer {
    config: IndexerConfig,
    worker: Option<WorkerId>,
    next_id: f64,
    waiting: Vec<Waiting>,
    /// request ids posted to each worker: a retired worker's exit fails only its own
    posted_to: Vec<(WorkerId, Vec<f64>)>,
    queue: VecDeque<QueuedFile>,
    queued: HashSet<String>,
    draining: bool,
    scanning: bool,
    scan_requested: bool,
    rescan_timer: bool,
    idle_timer: bool,
    last_scan_at: f64,
    stopped: bool,
    scan_task: Option<ScanTask>,
    drain_task: Option<DrainTask>,
    ready: VecDeque<Ready>,
    errors: VecDeque<StoreError>,
}

impl FileIndexer {
    pub fn new(config: IndexerConfig) -> FileIndexer {
        FileIndexer {
            config,
            worker: None,
            next_id: 1.0,
            waiting: Vec::new(),
            posted_to: Vec::new(),
            queue: VecDeque::new(),
            queued: HashSet::new(),
            draining: false,
            scanning: false,
            scan_requested: false,
            rescan_timer: false,
            idle_timer: false,
            last_scan_at: 0.0,
            stopped: false,
            scan_task: None,
            drain_task: None,
            ready: VecDeque::new(),
            errors: VecDeque::new(),
        }
    }

    /// whether an extraction worker is currently alive (test seam)
    pub fn worker_is_running(&self) -> bool {
        self.worker.is_some()
    }

    pub fn progress(&self, store: &FileIndexStore) -> Result<IndexProgress, StoreError> {
        Ok(IndexProgress {
            indexed: store.count()?,
            pending: self.queue.len(),
            scanning: self.scanning,
        })
    }

    /// schedule a scan soon; repeated calls within the debounce window fold into one
    pub fn refresh(&mut self, host: &mut dyn IndexerHost) {
        if self.stopped {
            return;
        }
        if self.rescan_timer {
            host.clear_timer(TimerKind::Rescan);
        }
        self.rescan_timer = true;
        host.set_timer(TimerKind::Rescan, RESCAN_DEBOUNCE_MS);
    }

    /// scan now unless one ran within `max_age_ms`
    pub fn refresh_if_stale(
        &mut self,
        host: &mut dyn IndexerHost,
        store: &FileIndexStore,
        max_age_ms: f64,
    ) -> Result<(), StoreError> {
        if host.now_ms() - self.last_scan_at >= max_age_ms {
            return self.scan(host, store);
        }
        Ok(())
    }

    /// `scan()`: it runs on as the events of its worker requests arrive
    pub fn scan(
        &mut self,
        host: &mut dyn IndexerHost,
        store: &FileIndexStore,
    ) -> Result<(), StoreError> {
        self.start_scan(host, store);
        self.end_event(host, store)
    }

    pub fn stop(&mut self, host: &mut dyn IndexerHost) {
        self.stopped = true;
        if self.rescan_timer {
            host.clear_timer(TimerKind::Rescan);
        }
        if self.idle_timer {
            host.clear_timer(TimerKind::Idle);
        }
        self.queue.clear();
        self.queued.clear();
        if let Some(worker) = self.worker.take() {
            host.terminate(worker);
        }
    }

    // ---- events ----

    /// a timer of the host fired
    pub fn on_timer(
        &mut self,
        host: &mut dyn IndexerHost,
        store: &FileIndexStore,
        kind: TimerKind,
    ) -> Result<(), StoreError> {
        match kind {
            TimerKind::Rescan => {
                self.rescan_timer = false;
                self.start_scan(host, store);
            }
            TimerKind::Idle => {
                self.idle_timer = false;
                if !(self.scanning
                    || self.draining
                    || !self.queue.is_empty()
                    || !self.waiting.is_empty())
                {
                    self.recycle_worker(host);
                }
            }
            TimerKind::Request(id) => {
                // a wedged worker never answers: fail this request the way a crashed
                // worker's requests fail, and retire the worker so later requests get a
                // fresh one instead of hanging too
                let waiter = self.take_waiting(id);
                self.recycle_worker(host);
                if let Some(waiter) = waiter {
                    self.ready.push_back(Ready::Response(
                        waiter.awaiter,
                        WorkerResponse::Extract {
                            id,
                            result: Extracted::Error("worker request timed out".to_owned()),
                        },
                    ));
                }
            }
        }
        self.end_event(host, store)
    }

    /// the worker posted `message`
    pub fn on_worker_message(
        &mut self,
        host: &mut dyn IndexerHost,
        store: &FileIndexStore,
        message: WorkerResponse,
    ) -> Result<(), StoreError> {
        let id = match &message {
            WorkerResponse::Extract { id, .. } | WorkerResponse::Scan { id, .. } => *id,
        };
        if let Some(waiter) = self.take_waiting(id) {
            host.clear_timer(TimerKind::Request(id));
            self.ready
                .push_back(Ready::Response(waiter.awaiter, message));
        }
        self.end_event(host, store)
    }

    /// the worker emitted `error` or `exit`. A crashed worker fails its
    /// in-flight request as an extraction error so the queue moves on; the exit
    /// of a worker retired for idleness or a timeout arrives after its
    /// successor may already have requests in flight, so only this worker's own
    /// requests are failed.
    pub fn on_worker_drop(
        &mut self,
        host: &mut dyn IndexerHost,
        store: &FileIndexStore,
        worker: WorkerId,
    ) -> Result<(), StoreError> {
        if self.worker == Some(worker) {
            self.worker = None;
        }
        let posted = match self.posted_to.iter_mut().find(|(w, _)| *w == worker) {
            Some((_, ids)) => std::mem::take(ids),
            None => Vec::new(),
        };
        for id in posted {
            let Some(waiter) = self.take_waiting(id) else {
                continue;
            };
            host.clear_timer(TimerKind::Request(id));
            self.ready.push_back(Ready::Response(
                waiter.awaiter,
                WorkerResponse::Extract {
                    id,
                    result: Extracted::Error("worker exited".to_owned()),
                },
            ));
        }
        self.end_event(host, store)
    }

    /// the `setImmediate` the drain yielded on ran
    pub fn on_immediate(
        &mut self,
        host: &mut dyn IndexerHost,
        store: &FileIndexStore,
    ) -> Result<(), StoreError> {
        if let Some(task) = self.drain_task.as_mut()
            && matches!(task.wait, DrainWait::Immediate)
        {
            task.wait = DrainWait::Running;
            self.drain_loop(host, store);
        }
        self.end_event(host, store)
    }

    /// `sources.nameOnly` answered a batch [`NameOnlyCall::Pending`] left open
    pub fn on_name_only(
        &mut self,
        host: &mut dyn IndexerHost,
        store: &FileIndexStore,
        answer: Result<HashSet<String>, ()>,
    ) -> Result<(), StoreError> {
        self.ready.push_back(Ready::NameOnly(answer));
        self.end_event(host, store)
    }

    // ---- the event loop ----

    /// what runs after the code of an event: the awaits that can resume, then
    /// the rejections nobody handled
    fn end_event(
        &mut self,
        host: &mut dyn IndexerHost,
        store: &FileIndexStore,
    ) -> Result<(), StoreError> {
        while let Some(item) = self.ready.pop_front() {
            match item {
                Ready::Response(Awaiter::Scan, response) => {
                    self.scan_response(host, store, response)
                }
                Ready::Response(Awaiter::Drain, response) => {
                    self.drain_response(host, store, response)
                }
                Ready::NameOnly(answer) => self.name_only_decided(host, store, answer),
                Ready::DiffDone => self.scan_end(host, store),
            }
        }
        match self.errors.pop_front() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    fn take_waiting(&mut self, id: f64) -> Option<Waiting> {
        let at = self.waiting.iter().position(|w| w.id == id)?;
        Some(self.waiting.remove(at))
    }

    // ---- scan ----

    fn start_scan(&mut self, host: &mut dyn IndexerHost, store: &FileIndexStore) {
        if self.stopped {
            return;
        }
        if self.scanning {
            self.scan_requested = true;
            return;
        }
        self.scanning = true;
        let task = ScanTask {
            seen: JsMap::new(),
            walked: true,
            complete: true,
            roots: host.roots(),
            next_root: 0,
            changed: Vec::new(),
            recheck: Vec::new(),
        };
        self.scan_step(host, store, task);
    }

    /// the next root of the walk, or the end of it
    fn scan_step(
        &mut self,
        host: &mut dyn IndexerHost,
        store: &FileIndexStore,
        mut task: ScanTask,
    ) {
        if task.next_root < task.roots.len() {
            let root = task.roots[task.next_root].clone();
            task.next_root += 1;
            self.scan_task = Some(task);
            self.ask(host, Awaiter::Scan, move |id| WorkerRequest::Scan {
                id,
                root,
            });
            return;
        }
        if task.walked {
            self.diff(host, store, task);
        } else {
            self.scan_end(host, store);
        }
    }

    fn scan_response(
        &mut self,
        host: &mut dyn IndexerHost,
        store: &FileIndexStore,
        response: WorkerResponse,
    ) {
        let Some(mut task) = self.scan_task.take() else {
            return;
        };
        // a crashed worker answers with an extract error; dropping the index on that would empty search
        match response {
            WorkerResponse::Scan {
                files, truncated, ..
            } => {
                for f in files {
                    task.seen.set(f.path.clone(), f);
                }
                if truncated {
                    task.complete = false;
                }
            }
            WorkerResponse::Extract { .. } => task.walked = false,
        }
        self.scan_step(host, store, task);
    }

    /// The end of the scan: `finally`, then a refresh that arrived mid-scan
    /// runs now, whether or not the walk succeeded.
    fn scan_end(&mut self, host: &mut dyn IndexerHost, store: &FileIndexStore) {
        self.scan_task = None;
        self.scanning = false;
        self.schedule_idle_recycle(host);
        if self.scan_requested {
            self.scan_requested = false;
            self.start_scan(host, store);
        }
    }

    /// the scan threw: its `finally` only
    fn scan_failed(&mut self, host: &mut dyn IndexerHost, e: StoreError) {
        self.scan_task = None;
        self.scanning = false;
        self.schedule_idle_recycle(host);
        self.errors.push_back(e);
    }

    /// bring the store in step with what the walk saw; extra paths are stat-ed
    /// here. A budget-capped walk cannot tell a vanished file from one it never
    /// reached, so entries are only removed when every root was walked to the end.
    fn diff(&mut self, host: &mut dyn IndexerHost, store: &FileIndexStore, mut task: ScanTask) {
        for p in host.extra_paths() {
            if task.seen.has(&p) || !is_supported_tree_file(&p) {
                continue;
            }
            if let Some(st) = stat_or_null(&p) {
                task.seen.set(p, st);
            }
        }
        let known = match store.list_all() {
            Ok(known) => known,
            Err(e) => return self.scan_failed(host, e),
        };
        if task.complete {
            let gone: Vec<String> = known
                .keys()
                .filter(|path| !task.seen.has(path))
                .map(str::to_owned)
                .collect();
            if let Err(e) = store.remove(&gone) {
                return self.scan_failed(host, e);
            }
        }
        for f in task.seen.values() {
            // an unchanged file that already failed is not retried: a parse that
            // kills the worker would otherwise be re-run on every scan
            if let Some(k) = known.get(&f.path)
                && k.mtime_ms == f.mtime_ms
                && k.size_bytes == f.size_bytes
            {
                if k.status == IndexStatus::Cloud {
                    task.recheck.push(f.clone());
                }
                continue;
            }
            task.changed.push(f.clone());
        }
        // `decideNameOnly`: one call for the whole batch
        let paths: Vec<String> = task
            .changed
            .iter()
            .chain(task.recheck.iter())
            .map(|f| f.path.clone())
            .collect();
        let call = if paths.is_empty() {
            None
        } else {
            host.name_only(&paths)
        };
        self.scan_task = Some(task);
        match call {
            None => self.ready.push_back(Ready::NameOnly(Ok(HashSet::new()))),
            Some(NameOnlyCall::Done(answer)) => self.ready.push_back(Ready::NameOnly(answer)),
            Some(NameOnlyCall::Pending) => {}
        }
    }

    /// the rest of the diff, once `decideNameOnly` answered; a source that
    /// fails leaves every file name-only rather than extracted
    fn name_only_decided(
        &mut self,
        host: &mut dyn IndexerHost,
        store: &FileIndexStore,
        answer: Result<HashSet<String>, ()>,
    ) {
        let Some(task) = self.scan_task.take() else {
            return;
        };
        let name_only: HashSet<String> = match answer {
            Ok(set) => set,
            Err(()) => task
                .changed
                .iter()
                .chain(task.recheck.iter())
                .map(|f| f.path.clone())
                .collect(),
        };
        for f in &task.changed {
            self.enqueue(host, store, f.clone(), name_only.contains(&f.path));
        }
        for f in &task.recheck {
            if !name_only.contains(&f.path) {
                self.enqueue(host, store, f.clone(), false);
            }
        }
        self.last_scan_at = host.now_ms();
        self.scan_task = Some(task);
        self.ready.push_back(Ready::DiffDone);
    }

    // ---- the queue ----

    fn enqueue(
        &mut self,
        host: &mut dyn IndexerHost,
        store: &FileIndexStore,
        file: ScannedFile,
        cloud: bool,
    ) {
        if self.queued.contains(&file.path) {
            return;
        }
        self.queued.insert(file.path.clone());
        self.queue.push_back(QueuedFile { file, cloud });
        self.drain(host, store);
    }

    fn drain(&mut self, host: &mut dyn IndexerHost, store: &FileIndexStore) {
        if self.draining {
            return;
        }
        self.draining = true;
        self.drain_task = Some(DrainTask {
            name_only_run: 0,
            wait: DrainWait::Running,
        });
        self.drain_loop(host, store);
    }

    /// the loop of `drain`, from where it is up to its next `await` or its end
    fn drain_loop(&mut self, host: &mut dyn IndexerHost, store: &FileIndexStore) {
        loop {
            if self.queue.is_empty() || self.stopped {
                return self.drain_end(host);
            }
            let f = self.queue.pop_front().expect("the queue has a file");
            self.queued.remove(&f.file.path);
            // the file may have changed again while queued; index what is on disk now
            let Some(st) = stat_or_null(&f.file.path) else {
                if let Err(e) = store.remove(std::slice::from_ref(&f.file.path)) {
                    self.drain_end(host);
                    self.errors.push_back(e);
                    return;
                }
                continue;
            };
            if f.cloud {
                // name and folder only: the content is never opened, so never downloaded
                self.apply(store, &st, Extracted::NameOnly, IndexStatus::Cloud);
                let task = self.drain_task.as_mut().expect("a drain is running");
                task.name_only_run += 1;
                if task.name_only_run.is_multiple_of(NAME_ONLY_BATCH) {
                    task.wait = DrainWait::Immediate;
                    host.set_immediate();
                    return;
                }
                continue;
            }
            let path = st.path.clone();
            self.drain_task.as_mut().expect("a drain is running").wait = DrainWait::Extract(st);
            self.ask(host, Awaiter::Drain, move |id| WorkerRequest::Extract {
                id,
                path,
            });
            return;
        }
    }

    fn drain_response(
        &mut self,
        host: &mut dyn IndexerHost,
        store: &FileIndexStore,
        response: WorkerResponse,
    ) {
        let Some(task) = self.drain_task.as_mut() else {
            return;
        };
        let DrainWait::Extract(st) = std::mem::replace(&mut task.wait, DrainWait::Running) else {
            return;
        };
        if let WorkerResponse::Extract { result, .. } = response {
            self.apply(store, &st, result, IndexStatus::NameOnly);
        }
        self.drain_loop(host, store);
    }

    fn drain_end(&mut self, host: &mut dyn IndexerHost) {
        self.draining = false;
        self.drain_task = None;
        self.schedule_idle_recycle(host);
    }

    fn apply(
        &mut self,
        store: &FileIndexStore,
        f: &ScannedFile,
        r: Extracted,
        name_only_status: IndexStatus,
    ) {
        // a corrupt row must not stall the queue; the next scan retries it
        let _ = match r {
            Extracted::Text(text) => store.upsert(f, Some(&text), IndexStatus::Ok),
            Extracted::NameOnly => store.upsert(f, None, name_only_status),
            Extracted::Error(_) => store.upsert(f, None, IndexStatus::Error),
        };
    }

    // ---- the worker ----

    fn schedule_idle_recycle(&mut self, host: &mut dyn IndexerHost) {
        if self.idle_timer {
            host.clear_timer(TimerKind::Idle);
        }
        self.idle_timer = true;
        host.set_timer(TimerKind::Idle, self.config.worker_idle_ms);
    }

    /// one worker request: the caller's `await` resumes with its response
    fn ask(
        &mut self,
        host: &mut dyn IndexerHost,
        awaiter: Awaiter,
        make: impl FnOnce(f64) -> WorkerRequest,
    ) {
        let id = self.next_id;
        self.next_id += 1.0;
        host.set_timer(TimerKind::Request(id), self.config.request_timeout_ms);
        self.waiting.push(Waiting { id, awaiter });
        let request = make(id);
        if let Err(message) = self.post(host, id, &request) {
            // a failed post must not reject into the void-ed callers: answer as an
            // extraction error, exactly like the drop handler does for a crash
            host.clear_timer(TimerKind::Request(id));
            self.take_waiting(id);
            self.ready.push_back(Ready::Response(
                awaiter,
                WorkerResponse::Extract {
                    id,
                    result: Extracted::Error(message),
                },
            ));
        }
    }

    fn post(
        &mut self,
        host: &mut dyn IndexerHost,
        id: f64,
        request: &WorkerRequest,
    ) -> Result<(), String> {
        let worker = self.ensure_worker(host)?;
        if let Some((_, ids)) = self.posted_to.iter_mut().find(|(w, _)| *w == worker) {
            ids.push(id);
        }
        host.post(worker, request)
    }

    /// retire the current worker; its `exit` fails any other in-flight request via drop
    fn recycle_worker(&mut self, host: &mut dyn IndexerHost) {
        if let Some(worker) = self.worker.take() {
            host.terminate(worker);
        }
    }

    fn ensure_worker(&mut self, host: &mut dyn IndexerHost) -> Result<WorkerId, String> {
        if self.idle_timer {
            host.clear_timer(TimerKind::Idle);
            self.idle_timer = false;
        }
        if let Some(worker) = self.worker {
            return Ok(worker);
        }
        let worker = host.spawn_worker(self.config.worker_heap_limit_mb)?;
        self.posted_to.retain(|(w, _)| *w != worker);
        self.posted_to.push((worker, Vec::new()));
        self.worker = Some(worker);
        Ok(worker)
    }
}
