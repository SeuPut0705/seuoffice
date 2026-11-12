//! `apps/pdf/src/main/disk-watch.ts`: notice when another program changes or
//! removes the PDF a view shows (issue #405).
//!
//! `watchDiskFile` is an `async` state machine in the TypeScript: its checks
//! wait for `stat` and `read`, and events and timers arrive meanwhile. Here
//! the machine is explicit. The caller owns the timers and the pending
//! operations and feeds each outcome back:
//!
//! - [`DiskWatch::on_event`] is the callback of `watchDir`;
//! - [`DiskWatch::fire_timer`] is the callback of the timer `setTimer` made;
//! - a method that can wait answers `Some(Pending)`: the caller does the
//!   `stat` (or `read`) and calls [`DiskWatch::answer_stat`] (or
//!   [`DiskWatch::answer_read`]) with the outcome, whenever it likes, other
//!   calls in between.

/// What the view shows: the disk state when it last read or wrote the file
#[derive(Debug, Clone, PartialEq)]
pub struct DiskBaseline {
    pub mtime_ms: f64,
    pub size: f64,
    pub hash: String,
}

/// `unchanged` only follows an earlier report: the file is back to what the view shows
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiskChangeKind {
    Changed,
    Missing,
    Unchanged,
}

impl DiskChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DiskChangeKind::Changed => "changed",
            DiskChangeKind::Missing => "missing",
            DiskChangeKind::Unchanged => "unchanged",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FileStat {
    pub mtime_ms: f64,
    pub size: f64,
}

/// What a check waits for
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pending {
    /// `deps.stat(path)`: answer with [`DiskWatch::answer_stat`]
    Stat,
    /// `deps.read(path)`: answer with [`DiskWatch::answer_read`]
    Read,
}

/// `DiskWatchDeps` without the two operations that wait (`stat`, `read`),
/// plus the `onChange` the TypeScript takes beside them.
pub trait DiskWatchDeps {
    /// `watchDir(dir, ...)`: whether the platform gave a handle (`null` otherwise)
    fn watch_dir(&mut self, dir: &str) -> bool;
    /// `handle.close()` of what `watch_dir` gave
    fn close_watch(&mut self);
    fn hash(&mut self, bytes: &[u8]) -> String;
    /// `setTimer(fn, ms)`: the handle the caller later passes to `clear_timer`
    fn set_timer(&mut self, ms: f64) -> u64;
    fn clear_timer(&mut self, handle: u64);
    /// true while this app itself writes `path`
    fn own_write_in_flight(&mut self, path: &str) -> bool;
    fn on_change(&mut self, kind: DiskChangeKind);
    fn settle_ms(&self) -> f64;
    /// case-insensitive file names (Windows, macOS)
    fn case_insensitive(&self) -> bool;
}

/// Checks of a file that keeps changing, cannot be read or does not end like
/// a PDF wait for the writer; after this many in a row the change is reported
/// as it is.
pub const DISK_WATCH_MAX_WAITS: u32 = 20;
/// A replace may delete the file a moment before the new one lands
pub const DISK_WATCH_MISSING_CONFIRMATIONS: u32 = 2;

const EOF_WINDOW: usize = 1024;
const EOF_MARK: [u8; 5] = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF

/// True when the last 1 KiB holds `%%EOF`, as every complete PDF ends
pub fn ends_like_whole_pdf(bytes: &[u8]) -> bool {
    let from = bytes.len().saturating_sub(EOF_WINDOW) as isize;
    let mut i = bytes.len() as isize - EOF_MARK.len() as isize;
    while i >= from {
        let at = i as usize;
        if bytes[at..at + EOF_MARK.len()] == EOF_MARK {
            return true;
        }
        i -= 1;
    }
    false
}

fn split_path(path: &str) -> (&str, &str) {
    match path.rfind(['/', '\\']) {
        None => (".", path),
        Some(cut) => {
            let dir = &path[..cut];
            (if dir.is_empty() { "/" } else { dir }, &path[cut + 1..])
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Reported {
    Changed(String),
    Missing,
}

#[derive(Debug, Clone, PartialEq)]
enum Stage {
    Idle,
    AwaitStat,
    AwaitRead(FileStat),
}

pub struct DiskWatch {
    path: String,
    name: String,
    shown: Option<DiskBaseline>,
    closed: bool,
    timer: Option<u64>,
    checking: bool,
    again: bool,
    /// size and time seen by the previous check; equal twice = the writer stopped
    last_seen: Option<FileStat>,
    waits: u32,
    missing_seen: u32,
    /// what the view was last told: nothing yet, a hash it was offered, or missing
    reported: Option<Reported>,
    stage: Stage,
    handle: bool,
}

pub fn watch_disk_file(
    path: &str,
    baseline: Option<DiskBaseline>,
    deps: &mut dyn DiskWatchDeps,
) -> DiskWatch {
    let (dir, name) = split_path(path);
    let handle = deps.watch_dir(dir);
    DiskWatch {
        path: path.to_owned(),
        name: name.to_owned(),
        shown: baseline,
        closed: false,
        timer: None,
        checking: false,
        again: false,
        last_seen: None,
        waits: 0,
        missing_seen: 0,
        reported: None,
        stage: Stage::Idle,
        handle,
    }
}

impl DiskWatch {
    pub fn path(&self) -> &str {
        &self.path
    }

    fn same_name(&self, deps: &dyn DiskWatchDeps, filename: &str) -> bool {
        if deps.case_insensitive() {
            filename.to_lowercase() == self.name.to_lowercase()
        } else {
            filename == self.name
        }
    }

    fn schedule(&mut self, deps: &mut dyn DiskWatchDeps) {
        if self.closed {
            return;
        }
        if let Some(timer) = self.timer {
            deps.clear_timer(timer);
        }
        self.timer = Some(deps.set_timer(deps.settle_ms()));
    }

    fn report(&self, deps: &mut dyn DiskWatchDeps, kind: DiskChangeKind) {
        if !self.closed {
            deps.on_change(kind);
        }
    }

    /// the file is what the view shows: clear an earlier notice
    fn settled_same(&mut self, deps: &mut dyn DiskWatchDeps) {
        if self.reported.is_some() {
            self.report(deps, DiskChangeKind::Unchanged);
        }
        self.reported = None;
    }

    /// the callback of `watchDir`; `None` = the platform did not say which entry moved
    pub fn on_event(&mut self, deps: &mut dyn DiskWatchDeps, filename: Option<&str>) {
        if self.closed {
            return;
        }
        if let Some(filename) = filename
            && !self.same_name(deps, filename)
        {
            return;
        }
        self.schedule(deps);
    }

    /// the callback of the timer `set_timer` made
    pub fn fire_timer(&mut self, deps: &mut dyn DiskWatchDeps) -> Option<Pending> {
        self.timer = None;
        self.check(deps)
    }

    /// `check()`
    fn check(&mut self, deps: &mut dyn DiskWatchDeps) -> Option<Pending> {
        if self.closed {
            return None;
        }
        if self.checking {
            self.again = true;
            return None;
        }
        self.checking = true;
        self.evaluate(deps)
    }

    /// the `finally` of `check()`
    fn finish(&mut self, deps: &mut dyn DiskWatchDeps) -> Option<Pending> {
        self.stage = Stage::Idle;
        self.checking = false;
        if self.again && !self.closed {
            self.again = false;
            self.schedule(deps);
        }
        None
    }

    fn evaluate(&mut self, deps: &mut dyn DiskWatchDeps) -> Option<Pending> {
        if deps.own_write_in_flight(&self.path) {
            // the app writes this file now; its write ends with a rebase
            self.schedule(deps);
            return self.finish(deps);
        }
        self.stage = Stage::AwaitStat;
        Some(Pending::Stat)
    }

    /// the outcome of the `stat` of [`Pending::Stat`]; `None` = the file is not there
    pub fn answer_stat(
        &mut self,
        deps: &mut dyn DiskWatchDeps,
        current: Option<FileStat>,
    ) -> Option<Pending> {
        if self.stage != Stage::AwaitStat {
            return None;
        }
        if self.closed {
            return self.finish(deps);
        }
        let Some(current) = current else {
            self.last_seen = None;
            self.missing_seen += 1;
            if self.missing_seen < DISK_WATCH_MISSING_CONFIRMATIONS {
                self.schedule(deps);
                return self.finish(deps);
            }
            if self.reported != Some(Reported::Missing) {
                self.reported = Some(Reported::Missing);
                self.report(deps, DiskChangeKind::Missing);
            }
            return self.finish(deps);
        };
        self.missing_seen = 0;
        if let Some(shown) = &self.shown
            && current.mtime_ms == shown.mtime_ms
            && current.size == shown.size
        {
            self.last_seen = None;
            self.waits = 0;
            self.settled_same(deps);
            return self.finish(deps);
        }
        let steady = matches!(
            self.last_seen,
            Some(last) if last.mtime_ms == current.mtime_ms && last.size == current.size
        );
        self.last_seen = Some(current);
        if !steady && self.waits < DISK_WATCH_MAX_WAITS {
            self.waits += 1;
            self.schedule(deps);
            return self.finish(deps);
        }
        self.stage = Stage::AwaitRead(current);
        Some(Pending::Read)
    }

    /// the outcome of the `read` of [`Pending::Read`]; `None` = it cannot be read now
    pub fn answer_read(
        &mut self,
        deps: &mut dyn DiskWatchDeps,
        bytes: Option<&[u8]>,
    ) -> Option<Pending> {
        let Stage::AwaitRead(current) = self.stage else {
            return None;
        };
        if self.closed {
            return self.finish(deps);
        }
        if bytes.is_none_or(|b| !ends_like_whole_pdf(b)) && self.waits < DISK_WATCH_MAX_WAITS {
            self.waits += 1;
            self.last_seen = None;
            self.schedule(deps);
            return self.finish(deps);
        }
        self.last_seen = None;
        self.waits = 0;
        let Some(bytes) = bytes else {
            // unreadable for good: say so once, the reload explains the rest
            if !matches!(self.reported, Some(Reported::Changed(_))) {
                self.reported = Some(Reported::Changed(String::new()));
                self.report(deps, DiskChangeKind::Changed);
            }
            return self.finish(deps);
        };
        let hash = deps.hash(bytes);
        if let Some(shown) = &self.shown
            && hash == shown.hash
        {
            // touched or rewritten with the same bytes: nothing to offer
            self.shown = Some(DiskBaseline {
                mtime_ms: current.mtime_ms,
                size: current.size,
                hash,
            });
            self.settled_same(deps);
            return self.finish(deps);
        }
        if matches!(&self.reported, Some(Reported::Changed(seen)) if *seen == hash) {
            return self.finish(deps);
        }
        self.reported = Some(Reported::Changed(hash));
        self.report(deps, DiskChangeKind::Changed);
        self.finish(deps)
    }

    /// the view now shows `baseline` (it reloaded, or the app wrote the file)
    pub fn rebase(&mut self, next: Option<DiskBaseline>) {
        self.shown = next;
        self.reported = None;
        self.last_seen = None;
        self.waits = 0;
        self.missing_seen = 0;
    }

    pub fn close(&mut self, deps: &mut dyn DiskWatchDeps) {
        self.closed = true;
        if let Some(timer) = self.timer.take() {
            deps.clear_timer(timer);
        }
        if self.handle {
            deps.close_watch();
        }
    }
}
