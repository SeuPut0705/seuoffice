//! The launch recovery list over IPC: `recovery:get-launch-list` and
//! `recovery:submit-launch-list` of `apps/shell/src/main/index.ts`, over the
//! gate of `launch-recovery.ts` (`main_core::shell::launch_recovery`).
//!
//! The launch flow publishes the rows (or that there are none) with
//! [`LaunchList::publish`]; until then a `get` waits. A `submit` hands the
//! Home screen's answer to the flow's `apply`, which settles through
//! [`ApplyDone`]; a submit made while that runs settles with it.

use std::cell::RefCell;
use std::rc::Rc;

use main_core::shell::launch_recovery::{
    GateGet, GateSubmit, LaunchListGate, RecoveryListItem, RecoveryListResult,
};
use shell_contract::ipc::{CallContext, ChannelKind, RegisterError, Registry, Reply, Responder};
use shell_contract::{Batch, IpcError, IpcValue, MainWindowHost};

use crate::handler;
use crate::value::to_js;

pub const GET: &str = "recovery:get-launch-list";
pub const SUBMIT: &str = "recovery:submit-launch-list";

/// The launch flow's `apply(result)`: carries out the answer and settles
/// `done`, at once or later, on the core thread. It may run again after a
/// failure: a failed apply leaves the list up.
pub type Apply = Rc<dyn Fn(RecoveryListResult, ApplyDone)>;

struct State {
    gate: LaunchListGate,
    apply: Option<Apply>,
    /// `get` calls waiting for the launch flow to know the rows
    waiting: Vec<Responder>,
    /// the submit whose answer is being applied, then those that joined it
    applying: Vec<Responder>,
    /// `apply` has not returned yet
    in_sync_apply: bool,
    /// what an apply settled with before it returned
    settled_early: Option<Result<(), IpcError>>,
    /// what waits for the launch to have its answer
    unblocked: Vec<Box<dyn FnOnce()>>,
}

pub struct LaunchList {
    main_window: MainWindowHost,
    state: RefCell<State>,
}

thread_local! {
    static CURRENT: RefCell<Option<Rc<LaunchList>>> = const { RefCell::new(None) };
}

/// The list of this core thread, once the batch is registered: the launch
/// flow publishes here
pub fn current() -> Option<Rc<LaunchList>> {
    CURRENT.with(|current| current.borrow().clone())
}

/// Settles one apply. Dropping it unsettled fails the apply, so a submit
/// never hangs.
pub struct ApplyDone {
    list: Option<Rc<LaunchList>>,
}

impl ApplyDone {
    pub fn settle(mut self, outcome: Result<(), IpcError>) {
        if let Some(list) = self.list.take() {
            list.apply_settled(outcome);
        }
    }
}

impl Drop for ApplyDone {
    fn drop(&mut self) {
        if let Some(list) = self.list.take() {
            list.apply_settled(Err(IpcError {
                name: Some("Error".into()),
                message: "the launch recovery answer was dropped".into(),
            }));
        }
    }
}

fn item_value(item: &RecoveryListItem) -> IpcValue {
    IpcValue::Object(vec![
        ("id".into(), IpcValue::String(item.id.clone())),
        (
            "editorKind".into(),
            IpcValue::String(item.editor_kind.clone()),
        ),
        ("name".into(), IpcValue::String(item.name.clone())),
        (
            "folder".into(),
            item.folder.clone().map_or(IpcValue::Null, IpcValue::String),
        ),
        ("lastCopyTime".into(), IpcValue::Number(item.last_copy_time)),
        ("untitled".into(), IpcValue::Bool(item.untitled)),
        (
            "fileChangedAfterCopy".into(),
            IpcValue::Bool(item.file_changed_after_copy),
        ),
        (
            "originalMissing".into(),
            IpcValue::Bool(item.original_missing),
        ),
    ])
}

fn error(message: &str) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: message.into(),
    }
}

impl LaunchList {
    pub fn new(main_window: MainWindowHost) -> Self {
        LaunchList {
            main_window,
            state: RefCell::new(State {
                gate: LaunchListGate::new(),
                apply: None,
                waiting: Vec::new(),
                applying: Vec::new(),
                in_sync_apply: false,
                settled_early: None,
                unblocked: Vec::new(),
            }),
        }
    }

    /// `publish(items, apply)`: the launch flow asks these rows (none: there
    /// is nothing to ask)
    pub fn publish(&self, items: Vec<RecoveryListItem>, apply: Apply) {
        let mut s = self.state.borrow_mut();
        // the gate takes the rows only while it does not know them yet
        let unknown = s.gate.blocking() && s.gate.current().is_none();
        let woken = s.gate.publish(items);
        if unknown {
            s.apply = Some(apply);
        }
        drop(s);
        self.wake(woken);
    }

    /// `publishNone()`
    pub fn publish_none(&self) {
        let woken = self.state.borrow_mut().gate.publish_none();
        self.wake(woken);
    }

    /// `blocking()`: no restored tab may load while true
    pub fn blocking(&self) -> bool {
        self.state.borrow().gate.blocking()
    }

    fn rows(&self) -> IpcValue {
        match self.state.borrow().gate.current() {
            Some(items) => IpcValue::Array(items.iter().map(item_value).collect()),
            None => IpcValue::Null,
        }
    }

    /// Runs `then` once the launch has its answer (`blocking()` is false):
    /// now, or when the list is answered or found empty
    pub fn when_unblocked(&self, then: Box<dyn FnOnce()>) {
        if self.blocking() {
            self.state.borrow_mut().unblocked.push(then);
        } else {
            then();
        }
    }

    fn wake(&self, woken: usize) {
        if !self.blocking() {
            let waiting = std::mem::take(&mut self.state.borrow_mut().unblocked);
            for then in waiting {
                then();
            }
        }
        if woken == 0 {
            return;
        }
        let waiting = std::mem::take(&mut self.state.borrow_mut().waiting);
        for reply in waiting {
            reply.reply(Ok(self.rows()));
        }
    }

    fn sent_by_main_window(&self, cx: &CallContext) -> bool {
        self.main_window.view() == Some(cx.sender.view)
    }

    fn get(&self, cx: &CallContext, reply: Responder) {
        // the shell window's Home only (the manual shares the preload)
        if !self.sent_by_main_window(cx) {
            reply.reply(Ok(IpcValue::Null));
            return;
        }
        let mut s = self.state.borrow_mut();
        match s.gate.get() {
            GateGet::Waiting => s.waiting.push(reply),
            GateGet::Ready(_) => {
                drop(s);
                reply.reply(Ok(self.rows()));
            }
        }
    }

    fn submit(self: &Rc<Self>, cx: &CallContext, raw: Option<&IpcValue>, reply: Responder) {
        if !self.sent_by_main_window(cx) {
            reply.reply(Err(error(
                "the launch recovery list belongs to the main window",
            )));
            return;
        }
        let raw = to_js(raw.unwrap_or(&IpcValue::Undefined));
        let mut s = self.state.borrow_mut();
        match s.gate.submit(&raw) {
            GateSubmit::Resolved => {
                drop(s);
                reply.reply(Ok(IpcValue::Undefined));
            }
            GateSubmit::Joined => s.applying.push(reply),
            GateSubmit::Rejected(message) => {
                drop(s);
                reply.reply(Err(error(&message)));
            }
            GateSubmit::Apply(result) => {
                s.applying.push(reply);
                s.in_sync_apply = true;
                let apply = s.apply.clone().expect("an asking gate has its apply");
                drop(s);
                apply(
                    result,
                    ApplyDone {
                        list: Some(self.clone()),
                    },
                );
                let mut s = self.state.borrow_mut();
                s.in_sync_apply = false;
                s.gate.applying_started();
                let early = s.settled_early.take();
                drop(s);
                if let Some(outcome) = early {
                    self.apply_settled(outcome);
                }
            }
        }
    }

    fn apply_settled(&self, outcome: Result<(), IpcError>) {
        let mut s = self.state.borrow_mut();
        if s.in_sync_apply {
            // the promise of the TypeScript settles after `apply` returns
            s.settled_early = Some(outcome);
            return;
        }
        let woken = s.gate.apply_finished(outcome.is_ok());
        let replies = std::mem::take(&mut s.applying);
        drop(s);
        self.wake(woken);
        let answer: Reply = outcome.map(|()| IpcValue::Undefined);
        for reply in replies {
            reply.reply(answer.clone());
        }
    }
}

pub(crate) fn register(registry: &mut dyn Registry, list: LaunchList) -> Result<(), RegisterError> {
    let list = Rc::new(list);
    CURRENT.with(|current| *current.borrow_mut() = Some(list.clone()));

    let l = list.clone();
    registry.register(
        Batch::U,
        GET,
        ChannelKind::Invoke,
        handler(move |cx: &CallContext, _, reply: Responder| l.get(cx, reply)),
    )?;
    let l = list;
    registry.register(
        Batch::U,
        SUBMIT,
        ChannelKind::Invoke,
        handler(
            move |cx: &CallContext, args: Vec<IpcValue>, reply: Responder| {
                l.submit(cx, args.first(), reply)
            },
        ),
    )
}
