//! The disk-change notice (issue #405) around `main-core`'s `DiskWatch`
//! state machine: the folder watch comes from the shell
//! ([`super::PdfShell::watch_dir`]), its events and the machine's timers
//! run on the core thread, and the `stat` and `read` a check waits for run
//! on a worker. `diskWatchDeps`, `watchViewFile`, `stopViewWatch` of pdf-main.ts.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Weak;
use std::time::Duration;

use main_core::markdown::fs_util::sha256_hex;
use main_core::pdf::disk_watch::{
    DiskBaseline, DiskChangeKind, DiskWatch, DiskWatchDeps, FileStat, Pending, watch_disk_file,
};
use main_core::pdf::font_locate::Platform;
use main_core::shell::recent_files::StatInfo;
use shell_contract::ViewId;

use super::Editor;
use crate::kit::{self, IntoIpc, Timer};

/// `settleMs`
const SETTLE_MS: f64 = 400.0;

/// One view's watcher: the machine and what its deps handed out
pub(super) struct Watch {
    machine: DiskWatch,
    aux: Aux,
    /// tells this watcher from a later one of the same view
    generation: u64,
}

#[derive(Default)]
struct Aux {
    /// the shell's folder watch, and the token its events come back under
    handle: Option<(u64, u64)>,
    timers: HashMap<u64, Timer>,
    next_timer: u64,
}

/// The editor, the view and the watcher generation a folder event is for
type Who = (Weak<Editor>, ViewId, u64);

thread_local! {
    /// folder-watch events on their way to a watcher: token -> who
    static TOKENS: RefCell<HashMap<u64, Who>> = RefCell::new(HashMap::new());
}

struct Deps<'a> {
    ed: &'a Editor,
    view: ViewId,
    generation: u64,
    path: String,
    aux: &'a mut Aux,
}

impl DiskWatchDeps for Deps<'_> {
    fn watch_dir(&mut self, dir: &str) -> bool {
        let token = kit::unique();
        TOKENS.with(|t| {
            t.borrow_mut()
                .insert(token, (self.ed.me.clone(), self.view, self.generation))
        });
        let core = self.ed.services.core.clone();
        let handle = self.ed.shell.watch_dir(
            dir,
            Box::new(move |name| {
                core.post(Box::new(move || {
                    let who = TOKENS.with(|t| t.borrow().get(&token).cloned());
                    if let Some((ed, view, generation)) = who
                        && let Some(ed) = ed.upgrade()
                    {
                        ed.run_watch(
                            view,
                            generation,
                            Box::new(move |m, d| {
                                m.on_event(d, name.as_deref());
                                None
                            }),
                        );
                    }
                }))
            }),
        );
        match handle {
            Some(handle) => {
                self.aux.handle = Some((handle, token));
                true
            }
            None => {
                TOKENS.with(|t| t.borrow_mut().remove(&token));
                false
            }
        }
    }

    fn close_watch(&mut self) {
        if let Some((handle, token)) = self.aux.handle.take() {
            TOKENS.with(|t| t.borrow_mut().remove(&token));
            self.ed.shell.close_watch(handle);
        }
    }

    fn hash(&mut self, bytes: &[u8]) -> String {
        sha256_hex(bytes)
    }

    fn set_timer(&mut self, ms: f64) -> u64 {
        let id = self.aux.next_timer;
        self.aux.next_timer += 1;
        let ed = self.ed.me.clone();
        let (view, generation) = (self.view, self.generation);
        let timer = kit::after(
            &self.ed.services,
            Duration::from_millis(ms.max(0.0) as u64),
            move || {
                if let Some(ed) = ed.upgrade() {
                    ed.run_watch(
                        view,
                        generation,
                        Box::new(move |m, d| {
                            d.aux.timers.remove(&id);
                            m.fire_timer(d)
                        }),
                    );
                }
            },
        );
        self.aux.timers.insert(id, timer);
        id
    }

    fn clear_timer(&mut self, handle: u64) {
        if let Some(timer) = self.aux.timers.remove(&handle) {
            kit::clear(timer)
        }
    }

    fn own_write_in_flight(&mut self, path: &str) -> bool {
        self.ed
            .st
            .borrow()
            .in_flight
            .get(path)
            .is_some_and(|n| *n > 0)
    }

    fn on_change(&mut self, kind: DiskChangeKind) {
        self.ed.emit(
            self.view,
            "pdf:disk-file-changed",
            vec![kit::obj([
                ("path", self.path.as_str().into_ipc()),
                ("kind", kind.as_str().into_ipc()),
            ])],
        )
    }

    fn settle_ms(&self) -> f64 {
        SETTLE_MS
    }

    fn case_insensitive(&self) -> bool {
        matches!(self.ed.shell.platform(), Platform::Win32 | Platform::Darwin)
    }
}

fn baseline(
    state: &main_core::packages::electron_utils::save_conflict::SaveDiskState,
) -> DiskBaseline {
    DiskBaseline {
        mtime_ms: state.mtime_ms,
        size: state.size,
        hash: state.hash.clone(),
    }
}

impl Watch {
    pub fn path(&self) -> &str {
        self.machine.path()
    }

    /// `watcher.close()` with the view's deps
    pub fn close(mut self, ed: &Editor, view: ViewId) {
        let mut deps = Deps {
            ed,
            view,
            generation: self.generation,
            path: self.machine.path().to_owned(),
            aux: &mut self.aux,
        };
        self.machine.close(&mut deps);
    }
}

/// One step of a watcher's machine: boxed, because a step's continuation
/// schedules the next one
type Step = Box<dyn FnOnce(&mut DiskWatch, &mut Deps<'_>) -> Option<Pending>>;

impl Editor {
    /// Runs `step` on the view's watcher when it is still the one of
    /// `generation`, then the `stat` or `read` it waits for
    fn run_watch(&self, view: ViewId, generation: u64, step: Step) {
        let taken = self.with_view(view, |v| v.watch.take_if(|w| w.generation == generation));
        let Some(mut watch) = taken else { return };
        let path = watch.machine.path().to_owned();
        let pending = {
            let mut deps = Deps {
                ed: self,
                view,
                generation,
                path: path.clone(),
                aux: &mut watch.aux,
            };
            step(&mut watch.machine, &mut deps)
        };
        // a step never replaces the watcher, so the slot is still free
        self.with_view(view, |v| v.watch = Some(watch));
        let ed = self.rc();
        match pending {
            None => {}
            Some(Pending::Stat) => kit::on_worker(
                &self.services,
                move || {
                    let meta = std::fs::metadata(main_core::node_fs::namespaced(&path)).ok();
                    meta.filter(|m| m.is_file()).map(|m| FileStat {
                        mtime_ms: StatInfo::of(&m).mtime_ms,
                        size: m.len() as f64,
                    })
                },
                move |stat| {
                    ed.run_watch(
                        view,
                        generation,
                        Box::new(move |m, d| m.answer_stat(d, stat)),
                    )
                },
            ),
            Some(Pending::Read) => kit::on_worker(
                &self.services,
                move || std::fs::read(&path).ok(),
                move |bytes| {
                    ed.run_watch(
                        view,
                        generation,
                        Box::new(move |m, d| m.answer_read(d, bytes.as_deref())),
                    )
                },
            ),
        }
    }

    /// `watchViewFile(contents, path)`: watch `path` against what the view
    /// last read of it
    pub(super) fn watch_view_file(&self, view: ViewId, path: &str) {
        let (current, base) = self.with_view(view, |v| {
            let base = v.disk_states.get(path).map(baseline);
            if let Some(w) = v.watch.as_mut().filter(|w| w.path() == path) {
                w.machine.rebase(base);
                return (None, None);
            }
            (Some(v.watch.take()), base)
        });
        let Some(current) = current else { return };
        if let Some(old) = current {
            old.close(self, view);
        }
        let generation = kit::unique();
        let mut aux = Aux::default();
        let machine = {
            let mut deps = Deps {
                ed: self,
                view,
                generation,
                path: path.to_owned(),
                aux: &mut aux,
            };
            watch_disk_file(path, base, &mut deps)
        };
        self.with_view(view, |v| {
            v.watch = Some(Watch {
                machine,
                aux,
                generation,
            })
        });
    }

    /// `stopViewWatch(wcId)`
    pub(super) fn stop_view_watch(&self, view: ViewId) {
        let old = self.with_view(view, |v| v.watch.take());
        if let Some(old) = old {
            old.close(self, view);
        }
    }

    /// after a write of `path` by this view: its watcher's baseline follows
    pub(super) fn rebase_watch(&self, view: ViewId, path: &str) {
        self.with_view(view, |v| {
            let base = v.disk_states.get(path).map(baseline);
            if let Some(w) = v.watch.as_mut().filter(|w| w.path() == path) {
                w.machine.rebase(base);
            }
        });
    }
}
