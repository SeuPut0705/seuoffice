//! The renderer round trips: the close guard (`docs:close-check` ->
//! `docs:close-check-result`, `docs:close-save-request` ->
//! `docs:close-save-result`, `requestDocsClose`), the session-end copies
//! (`docs:write-recovery-now` -> `docs:write-recovery-now-done`), the
//! View-menu state, and the teardown and rename the shell sends.
//!
//! The TypeScript awaited each reply with a timer racing it. Here the
//! continuation waits in [`Close`] keyed as the TypeScript keyed it, the
//! event goes out, and the reply's handler (or the timer) takes and runs it.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use shell_contract::hosts::MessageBox;
use shell_contract::ipc::Target;
use shell_contract::{IpcValue, ViewId, WindowId};

use super::Docs;
use crate::kit::{self, Entry, Timer};

/// `queryCloseState`'s 2 s, after which a silent renderer counts as dirty
const CLOSE_CHECK_TIMEOUT: Duration = Duration::from_millis(2000);
/// `requestRendererSave`'s 120 s
const CLOSE_SAVE_TIMEOUT: Duration = Duration::from_millis(120_000);
/// `writeDocsCopiesNow`'s 5 s per renderer
const RECOVERY_NOW_TIMEOUT: Duration = Duration::from_millis(5000);

/// `ODT_OFF_MENU_IDS`
const ODT_OFF_MENU_IDS: [&str; 2] = ["docs-menu-insert-equation", "docs-menu-insert-comment"];

/// `DocsCloseState`
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct CloseState {
    pub dirty: bool,
    pub auto_save: bool,
    pub file_path: Option<String>,
    pub unresponsive: bool,
}

type StateThen = Box<dyn FnOnce(CloseState)>;
type BoolThen = Box<dyn FnOnce(bool)>;
/// a write-copies-now token's timer and what its answer settles
type TokenWait = (Timer, Box<dyn FnOnce()>);

/// A close check in flight: every caller that asked meanwhile shares it
struct Check {
    timer: Timer,
    waiters: Vec<StateThen>,
}

/// The waiters of the renderer round trips
#[derive(Default)]
pub(crate) struct Close {
    /// `closeCheckWaiters` with `closeStateQueries`
    checks: RefCell<HashMap<ViewId, Check>>,
    /// `closeSaveWaiters`: which request the view's reply answers
    save_routes: RefCell<HashMap<ViewId, u64>>,
    /// each save request's own continuation and timer
    saves: RefCell<HashMap<u64, (Timer, BoolThen)>>,
    /// `docsCloseRequests`: callers joining a close in progress
    closes: RefCell<HashMap<ViewId, Vec<BoolThen>>>,
    /// `recoveryNowWaiters`, by token
    recovery_now: RefCell<HashMap<String, TokenWait>>,
}

impl Close {
    /// `recoveryNowWaiters.get(token)?.()`
    pub fn recovery_now_done(&self, token: &str) {
        let waiter = self.recovery_now.borrow_mut().remove(token);
        if let Some((timer, done)) = waiter {
            kit::clear(timer);
            done()
        }
    }

    fn answer_save(&self, view: ViewId, ok: bool) {
        let Some(id) = self.save_routes.borrow_mut().remove(&view) else {
            return;
        };
        let waiter = self.saves.borrow_mut().remove(&id);
        if let Some((timer, then)) = waiter {
            kit::clear(timer);
            then(ok)
        }
    }
}

impl Docs {
    fn emit(&self, view: ViewId, channel: &'static str, args: Vec<IpcValue>) {
        self.services.events.emit(Target::View(view), channel, args)
    }

    /// `queryCloseState(contents)`
    pub(crate) fn query_close_state(self: &Rc<Self>, view: ViewId, then: StateThen) {
        if !self.alive(view) {
            return then(CloseState::default());
        }
        if let Some(check) = self.close.checks.borrow_mut().get_mut(&view) {
            check.waiters.push(then);
            return;
        }
        let docs = Rc::clone(self);
        let timer = kit::after(&self.services, CLOSE_CHECK_TIMEOUT, move || {
            let check = docs.close.checks.borrow_mut().remove(&view);
            // no reply: a busy or wedged renderer may hold unsaved changes
            let state = CloseState {
                dirty: true,
                unresponsive: true,
                ..Default::default()
            };
            for waiter in check.map(|c| c.waiters).unwrap_or_default() {
                waiter(state.clone())
            }
        });
        self.close.checks.borrow_mut().insert(
            view,
            Check {
                timer,
                waiters: vec![then],
            },
        );
        self.emit(view, "docs:close-check", Vec::new());
    }

    /// `requestRendererSave(contents)`: failure and timeout are `false`
    pub(crate) fn request_renderer_save(self: &Rc<Self>, view: ViewId, then: BoolThen) {
        let id = kit::unique();
        let docs = Rc::clone(self);
        let timer = kit::after(&self.services, CLOSE_SAVE_TIMEOUT, move || {
            let mut routes = docs.close.save_routes.borrow_mut();
            if routes.get(&view) == Some(&id) {
                routes.remove(&view);
            }
            drop(routes);
            let waiter = docs.close.saves.borrow_mut().remove(&id);
            if let Some((_, then)) = waiter {
                then(false)
            }
        });
        self.close.save_routes.borrow_mut().insert(view, id);
        self.close.saves.borrow_mut().insert(id, (timer, then));
        self.emit(view, "docs:close-save-request", Vec::new());
    }

    /// `requestDocsClose(contents, parent)`: `true` means the view may
    /// close; a second call while one runs joins it
    pub(crate) fn request_close(
        self: &Rc<Self>,
        view: ViewId,
        parent: Option<WindowId>,
        then: BoolThen,
    ) {
        if let Some(joined) = self.close.closes.borrow_mut().get_mut(&view) {
            joined.push(then);
            return;
        }
        self.close.closes.borrow_mut().insert(view, vec![then]);
        let docs = Rc::clone(self);
        let done: BoolThen = Box::new(move |proceed| {
            let waiters = docs
                .close
                .closes
                .borrow_mut()
                .remove(&view)
                .unwrap_or_default();
            for w in waiters {
                w(proceed)
            }
        });
        let docs = Rc::clone(self);
        self.query_close_state(
            view,
            Box::new(move |state| docs.perform_close(view, parent, state, done)),
        );
    }

    /// `performDocsClose` once the renderer answered the close check
    fn perform_close(
        self: &Rc<Self>,
        view: ViewId,
        parent: Option<WindowId>,
        state: CloseState,
        done: BoolThen,
    ) {
        if !state.dirty || !self.alive(view) {
            return done(true);
        }
        if state.unresponsive {
            let response = self.message(
                parent,
                MessageBox {
                    kind: Some("warning".into()),
                    message: self.tm("closeNoReplyMsg"),
                    detail: Some(self.tm("closeNoReplyDetail")),
                    buttons: vec![self.tm("btnCloseAnyway"), self.tm("btnCancel")],
                    default_id: Some(1),
                    cancel_id: Some(1),
                    ..Default::default()
                },
            );
            if response != 0 {
                return done(false);
            }
            // a hung renderer cannot save: its last copy is the only record, kept for later
            let open = self.open_doc.get(view);
            self.with_store(|store| self.book.borrow_mut().abandon(store, view, open.as_deref()));
            return done(true);
        }
        if state.auto_save {
            let docs = Rc::clone(self);
            return self.request_renderer_save(
                view,
                Box::new(move |ok| {
                    if ok {
                        docs.book.borrow_mut().note_closed_saved(view);
                        done(true)
                    } else {
                        docs.close_prompt(view, parent, state, done)
                    }
                }),
            );
        }
        self.close_prompt(view, parent, state, done)
    }

    /// Save / Don't Save / Cancel
    fn close_prompt(
        self: &Rc<Self>,
        view: ViewId,
        parent: Option<WindowId>,
        state: CloseState,
        done: BoolThen,
    ) {
        let response = self.message(
            parent,
            MessageBox {
                kind: Some("warning".into()),
                message: self.tm("closeUnsavedMsg"),
                detail: Some(self.tm("closeUnsavedDetail")),
                buttons: vec![
                    self.tm("menuSave"),
                    self.tm("btnDontSave"),
                    self.tm("btnCancel"),
                ],
                default_id: Some(0),
                cancel_id: Some(2),
                ..Default::default()
            },
        );
        match response {
            2 => done(false),
            1 => {
                // explicitly discarded: nothing offers the dropped edits back
                self.discard_tab_copies(view, state.file_path.as_deref());
                done(true)
            }
            _ => {
                let docs = Rc::clone(self);
                self.request_renderer_save(
                    view,
                    Box::new(move |saved| {
                        if saved {
                            docs.book.borrow_mut().note_closed_saved(view);
                        }
                        done(saved)
                    }),
                );
            }
        }
    }

    /// `writeDocsCopiesNow()`: every live, booted renderer writes its copy
    /// now; `then` runs when each answered or its 5 s passed
    pub(crate) fn write_copies_now(self: &Rc<Self>, then: Box<dyn FnOnce()>) {
        let targets: Vec<ViewId> = self
            .booted
            .borrow()
            .iter()
            .copied()
            .filter(|v| !self.is_torn_down(*v) && self.alive(*v))
            .collect();
        if targets.is_empty() {
            return then();
        }
        let left = Rc::new(Cell::new(targets.len()));
        let then = Rc::new(RefCell::new(Some(then)));
        for view in targets {
            let token = jscompat::random_uuid();
            let (l, t) = (left.clone(), then.clone());
            let one_done = move || {
                l.set(l.get() - 1);
                if l.get() == 0
                    && let Some(then) = t.borrow_mut().take()
                {
                    then()
                }
            };
            let docs = Rc::clone(self);
            let key = token.clone();
            let timer = kit::after(&self.services, RECOVERY_NOW_TIMEOUT, move || {
                let waiter = docs.close.recovery_now.borrow_mut().remove(&key);
                if let Some((_, done)) = waiter {
                    done()
                }
            });
            self.close
                .recovery_now
                .borrow_mut()
                .insert(token.clone(), (timer, Box::new(one_done)));
            // still open: a "Don't Save" before a cancelled quit must not drop this copy
            self.book.borrow_mut().note_still_open(view);
            self.emit(
                view,
                "docs:write-recovery-now",
                vec![IpcValue::String(token)],
            );
        }
    }

    /// `teardownDocsRenderer(contents)`: the closed tab loses its writes and
    /// its recovery copies settle by how the close was decided
    pub(crate) fn teardown(&self, view: ViewId, crashed: bool) {
        self.torn_down.borrow_mut().insert(view);
        self.engine.forget_lazy_media_owner(view);
        self.with_store(|store| self.book.borrow_mut().settle_closed(store, view, crashed));
        self.doc_writable.remove(view);
        self.pdf_writable.remove(view);
        self.disk_states.remove(view);
        self.passwords.borrow_mut().forget(view);
        if self.alive(view) {
            self.emit(view, "docs:teardown", Vec::new());
        }
    }

    /// `docsFileRenamed(wc, oldPath, newPath)`
    pub(crate) fn file_renamed(&self, view: ViewId, old: &str, new: &str) {
        if let Some(mut set) = self.doc_writable.get(view) {
            set.remove(old);
            self.doc_writable.insert(view, set);
        }
        self.allow_doc_write(view, new);
        self.remember_open_doc(view, new);
        if let Some(mut states) = self.disk_states.get(view)
            && let Some(recorded) = states.remove(old)
        {
            states.insert(new.to_owned(), recorded);
            self.disk_states.insert(view, states);
        }
        // the password follows the path, or the next save writes plaintext
        self.passwords.borrow_mut().rename(view, old, new);
        self.engine.move_lazy_media_source(old, new);
        self.emit(
            view,
            "docs:renamed",
            vec![
                super::Obj::new()
                    .set("oldPath", old)
                    .set("newPath", new)
                    .done(),
            ],
        );
    }
}

/// The `destroyed` listeners: a close check answers clean, a save `false`
pub(super) fn view_destroyed(docs: &Docs, view: ViewId) {
    let check = docs.close.checks.borrow_mut().remove(&view);
    if let Some(check) = check {
        kit::clear(check.timer);
        for waiter in check.waiters {
            waiter(CloseState::default())
        }
    }
    docs.close.answer_save(view, false);
}

pub(super) fn entries(docs: &Rc<Docs>) -> Vec<Entry> {
    let mut all = Vec::new();

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:confirm-document-replace",
        move |cx, _args, responder| {
            let view = cx.sender.view;
            let d2 = d.clone();
            d.request_close(
                view,
                d.parent(view),
                Box::new(move |proceed| {
                    // another document takes this tab: the leaving one's copies settle
                    if proceed {
                        d2.with_store(|store| {
                            d2.book.borrow_mut().settle_closed(store, view, false)
                        });
                    }
                    responder.reply(Ok(IpcValue::Bool(proceed)))
                }),
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::send("docs:close-check-result", move |cx, args| {
        let view = cx.sender.view;
        let check = d.close.checks.borrow_mut().remove(&view);
        let Some(check) = check else {
            return Ok(());
        };
        kit::clear(check.timer);
        let s = args.get(0);
        let state = match s {
            IpcValue::Bool(dirty) => CloseState {
                dirty: *dirty,
                ..Default::default()
            },
            other => CloseState {
                dirty: kit::field(other, "dirty") == &IpcValue::Bool(true),
                auto_save: kit::field(other, "autoSave") == &IpcValue::Bool(true),
                file_path: kit::as_str(kit::field(other, "filePath")).map(str::to_owned),
                unresponsive: false,
            },
        };
        // a clean answer lets this tab's close drop the copies it wrote
        d.book.borrow_mut().note_close_check(view, state.dirty);
        for waiter in check.waiters {
            waiter(state.clone())
        }
        Ok(())
    }));

    let d = docs.clone();
    all.push(kit::send("docs:close-save-result", move |cx, args| {
        d.close
            .answer_save(cx.sender.view, args.get(0) == &IpcValue::Bool(true));
        Ok(())
    }));

    let d = docs.clone();
    all.push(kit::send("docs:view-menu-state", move |cx, args| {
        let view = cx.sender.view;
        let s = args.get(0);
        let flag = |k: &str| kit::field(s, k) == &IpcValue::Bool(true);
        let next = [flag("aiSidebar"), flag("darkCanvas"), flag("odt")];
        d.view_menu.insert(view, next);
        // only the active tab patches the live menu; another tab's state waits for its focus
        if d.shell.active_docs_view() != Some(view) {
            return Ok(());
        }
        d.shell
            .set_menu_item_checked("docs-menu-ai-sidebar", next[0]);
        d.shell
            .set_menu_item_checked("docs-menu-dark-mode", next[1]);
        for id in ODT_OFF_MENU_IDS {
            d.shell.set_menu_item_enabled(id, !next[2]);
        }
        Ok(())
    }));

    all
}
