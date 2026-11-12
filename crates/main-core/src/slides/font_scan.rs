//! `apps/slides/src/main/font-scan.ts`.
//!
//! The scan runs on a worker thread that posts one result per task, and the
//! caller waits until all arrived or the deadline passed, as the TypeScript
//! does with a `worker_threads` worker. `console.warn` has no counterpart:
//! the warnings are not part of what the function answers.

use std::fs;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use jscompat::js_regex;
use jscompat::node_path::host::join;
use serde::Serialize;

/// `ScanTask`
#[derive(Debug, Clone, PartialEq)]
pub enum ScanTask {
    /// Font files directly inside the dir
    Flat { dir: String },
    /// Office cloud fonts: `<base>/<cache-id>/<sub>/<Family Name>/<numeric-id>.ttf`
    Cloud { base: String, sub: String },
}

/// One cloud root: `{ root, families }`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CloudRoot {
    pub root: String,
    pub families: Vec<(String, Vec<String>)>,
}

/// `ScanResult`
#[derive(Debug, Clone, PartialEq)]
pub enum ScanResult {
    /// File names (not paths) of the font files found; empty when the dir is unreadable
    Flat { files: Vec<String> },
    /// Readable roots only; families carry absolute font paths and skip empty dirs
    Cloud { roots: Vec<CloudRoot> },
}

/// `readdirSync(dir)` with libuv's sort by bytes, `None` where it throws
fn list(dir: &str) -> Option<Vec<String>> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    Some(names)
}

fn is_file(path: &str) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

fn font_files(dir: &str) -> Vec<String> {
    let font_file = js_regex!(r"\.(ttf|otf|ttc|otc)$", "i");
    list(dir)
        .unwrap_or_default()
        .into_iter()
        .filter(|name| font_file.test(name))
        .collect()
}

/// The body of the worker for one task
pub fn scan_task(task: &ScanTask) -> ScanResult {
    match task {
        ScanTask::Flat { dir } => ScanResult::Flat {
            files: font_files(dir)
                .into_iter()
                .filter(|name| is_file(&join(&[dir, name])))
                .collect(),
        },
        ScanTask::Cloud { base, sub } => {
            let mut roots = Vec::new();
            for id in list(base).unwrap_or_default() {
                let root = join(&[base, &id, sub]);
                let Some(fams) = list(&root) else {
                    continue;
                };
                let families = fams
                    .into_iter()
                    .map(|family| {
                        let files = font_files(&join(&[&root, &family]))
                            .into_iter()
                            .map(|name| join(&[&root, &family, &name]))
                            .collect::<Vec<_>>();
                        (family, files)
                    })
                    .filter(|(_, files)| !files.is_empty())
                    .collect();
                roots.push(CloudRoot { root, families });
            }
            ScanResult::Cloud { roots }
        }
    }
}

/// `scanFontDirs(tasks, deadlineMs)`: the slot of a task that did not finish
/// stays `None`.
pub fn scan_font_dirs(tasks: &[ScanTask], deadline_ms: f64) -> Vec<Option<ScanResult>> {
    let mut out: Vec<Option<ScanResult>> = vec![None; tasks.len()];
    if tasks.is_empty() {
        return out;
    }
    let (sender, receiver) = mpsc::channel::<(usize, ScanResult)>();
    let owned: Vec<ScanTask> = tasks.to_vec();
    let worker = std::thread::Builder::new()
        .name("font-scan".into())
        .spawn(move || {
            for (i, task) in owned.iter().enumerate() {
                if sender.send((i, scan_task(task))).is_err() {
                    return;
                }
            }
        });
    if worker.is_err() {
        // console.warn('[fonts] font directory scan worker unavailable:', e)
        return out;
    }
    let deadline = Instant::now() + duration_of(deadline_ms);
    let mut done = 0;
    loop {
        while let Ok((i, result)) = receiver.try_recv() {
            out[i] = Some(result);
            done += 1;
        }
        if done >= tasks.len() {
            break;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        // Atomics.wait: until the worker posts or the time is up
        match receiver.recv_timeout(left) {
            Ok((i, result)) => {
                out[i] = Some(result);
                done += 1;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // a worker stuck inside readdir cannot be interrupted: it is left behind
    out
}

/// A deadline in milliseconds: negative and NaN are already past.
fn duration_of(ms: f64) -> Duration {
    if ms.is_nan() || ms <= 0.0 {
        Duration::ZERO
    } else {
        Duration::from_secs_f64((ms / 1000.0).min(31_536_000.0))
    }
}
