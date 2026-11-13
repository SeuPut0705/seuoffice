//! `apps/shell/src/main/mcp/docs-bridge.ts`: the shell-main half of the
//! MCP to docs-editor bridge.
//!
//! The MCP tools want to drive a *visible* docs editor. This module owns the
//! request/response plumbing: it waits for a tab's renderer to announce itself
//! (`docs:mcp-ready`), pushes one command at a time over `docs:mcp-command`,
//! and resolves the matching `docs:mcp-result`. The renderer half is
//! `apps/docs/src/renderer/mcp-bridge.ts`. Reopening a tab destroys its
//! webContents, so readiness is tracked per id and stale ids are dropped on
//! lookup.
//!
//! The TypeScript keeps its state in module variables, hangs two listeners on
//! `ipcMain` and returns promises. Here the state is a [`DocsBridge`] the
//! caller owns, the webContents, the timers and the promises are behind
//! [`DocsBridgeHost`], and what happens to them is a step the caller drives:
//!
//! - registering `ipcMain.on('docs:mcp-ready' | 'docs:mcp-result', ..)` stays
//!   in TypeScript, once: [`DocsBridge::install`] answers whether to register
//!   now (`installDocsBridge` is safe to call twice). The listener of
//!   `docs:mcp-ready` calls [`DocsBridge::on_ready`] with `event.sender.id`,
//!   the one of `docs:mcp-result` calls [`DocsBridge::on_result`] with
//!   `event.sender.id` and the reply;
//! - `wc.once('destroyed', ..)` is [`DocsBridgeHost::watch_destroyed`]: the
//!   host calls [`DocsBridge::on_destroyed`] when that webContents goes;
//! - a timer that fires is [`DocsBridge::on_timeout`];
//! - the two calls of `createDocsControl(deps)` are [`DocsBridge::open_blank_tab`]
//!   and [`DocsBridge::run_command`]. Each answers [`Submitted`]: settled at
//!   once, or pending, its promise settling later through
//!   [`DocsBridgeHost::settle`]. The tool layer's `DocsControl` host calls
//!   (`document_tools::docs_open_blank_call` / `docs_run_call`) are answered
//!   through them: the host remembers which suspended tool (ticket) waits on
//!   a `Pending(op)` and resumes it with the outcome `settle(op, ..)` gives.
//!
//! What `deps` gave (`openBlankTab`, `authorizeSave`, `abandonBlankTab`) and
//! `existsSync` are synchronous host calls too: the TypeScript's `deps`
//! return a number and `void`, nothing there awaits a renderer.
//! `deps.openBlankTab()` is taken not to throw; the optional `abandonBlankTab`
//! is a host that does nothing.
//!
//! One thing of the TypeScript's scheduling is kept: a promise's reaction runs
//! after the code that settled it. So when a tab announces itself, the waiters'
//! timers are cleared and the tab's `destroyed` hook is attached before any
//! waiter continues; and when a tab goes, the timers of its waiters and
//! commands are cleared before any `abandonBlankTab` or settle.

use std::collections::HashSet;

use jscompat::JsonValue;

use super::tools::document_tools::McpEditorCommandName;

/// `READY_TIMEOUT_MS`: a fresh docs tab boots its renderer and fonts; measured
/// 0.6-8s, occasionally far longer. Capped under the MCP client's own tool
/// timeout (30s) so the caller gets this reason instead of a bare "timed out"
/// from the client.
pub const READY_TIMEOUT_MS: f64 = 24_000.0;
/// `COMMAND_TIMEOUT_MS`
pub const COMMAND_TIMEOUT_MS: f64 = 120_000.0;

/// How a promise settles: a value (`None` is `undefined`), or the message of
/// the `Error` it rejects with.
pub type Settled = Result<Option<JsonValue>, String>;

/// What a call of the control gives back.
#[derive(Debug, Clone, PartialEq)]
pub enum Submitted {
    /// the promise resolved at once
    Resolved(Option<JsonValue>),
    /// the promise rejected at once, with this message
    Rejected(String),
    /// the promise is pending: it settles through [`DocsBridgeHost::settle`]
    /// with this number
    Pending(u64),
}

/// What the bridge does to the world.
pub trait DocsBridgeHost {
    /// `webContents.fromId(wcId)` is a webContents that is not destroyed
    fn web_contents_alive(&mut self, wc_id: i64) -> bool;
    /// `wc.once('destroyed', ..)`: later [`DocsBridge::on_destroyed`]
    fn watch_destroyed(&mut self, wc_id: i64);
    /// `wc.send('docs:mcp-command', { requestId, command, payload })`
    fn send_command(
        &mut self,
        wc_id: i64,
        request_id: &str,
        command: McpEditorCommandName,
        payload: Option<&JsonValue>,
    );
    /// `setTimeout(callback, ms)`: the timer's number, given back to
    /// [`DocsBridge::on_timeout`] when it fires
    fn set_timeout(&mut self, ms: f64) -> u64;
    /// `clearTimeout(timer)`
    fn clear_timeout(&mut self, timer: u64);
    /// the promise numbered `op` settles
    fn settle(&mut self, op: u64, outcome: Settled);
    /// `existsSync(path)`
    fn exists_sync(&mut self, path: &str) -> bool;
    /// `deps.openBlankTab()`: open a fresh blank docs tab; its webContents id
    fn open_blank_tab(&mut self) -> i64;
    /// `deps.authorizeSave(wcId, filePath)`: grant the tab's renderer write
    /// access to the resolved save target (`docs:save-to` checks it)
    fn authorize_save(&mut self, wc_id: i64, file_path: &str);
    /// `deps.abandonBlankTab?.(wcId)`: close a blank tab whose session never
    /// became ready, so a failed create_session leaves no orphan
    fn abandon_blank_tab(&mut self, wc_id: i64);
}

/// what a waiter does once its tab is ready
enum Then {
    /// `openBlankTab`: resolve with the tab's id
    OpenBlank,
    /// `runCommand`: carry on with the command
    RunCommand {
        command: McpEditorCommandName,
        payload: Option<JsonValue>,
    },
}

/// `ReadyWaiter` with the promise it settles
struct ReadyWaiter {
    op: u64,
    timer: u64,
    then: Then,
}

/// `PendingCommand`
struct PendingCommand {
    op: u64,
    wc_id: i64,
    timer: u64,
}

/// the module state of `docs-bridge.ts`
pub struct DocsBridge<H: DocsBridgeHost> {
    host: H,
    /// `readyIds`
    ready_ids: HashSet<i64>,
    /// `readyWaiters`: in the order the tabs got their first waiter
    ready_waiters: Vec<(i64, Vec<ReadyWaiter>)>,
    /// `watchedIds`: tabs whose 'destroyed' hook is attached (once per id)
    watched_ids: HashSet<i64>,
    /// `pending`: by request id, in the order the commands were sent
    pending: Vec<(String, PendingCommand)>,
    /// `requestSeq`
    request_seq: u64,
    /// `installed`
    installed: bool,
    next_op: u64,
}

/// the state of a tab as `waitForReady` finds it
enum Wait {
    Ready,
    Closed,
    Waiting,
}

const CLOSED: &str = "the document tab was closed";

impl<H: DocsBridgeHost> DocsBridge<H> {
    pub fn new(host: H) -> Self {
        DocsBridge {
            host,
            ready_ids: HashSet::new(),
            ready_waiters: Vec::new(),
            watched_ids: HashSet::new(),
            pending: Vec::new(),
            request_seq: 0,
            installed: false,
            next_op: 0,
        }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    /// `installDocsBridge()`: register the renderer reply channels. Safe to
    /// call more than once: `true` the first time (register the two listeners
    /// now), `false` after.
    pub fn install(&mut self) -> bool {
        if self.installed {
            return false;
        }
        self.installed = true;
        true
    }

    fn take_waiters(&mut self, wc_id: i64) -> Vec<ReadyWaiter> {
        match self.ready_waiters.iter().position(|(id, _)| *id == wc_id) {
            Some(at) => self.ready_waiters.remove(at).1,
            None => Vec::new(),
        }
    }

    /// `markReady(wcId)` up to the point the waiters' promises resolve: the
    /// waiters, their timers cleared, for the caller to continue
    fn mark_ready(&mut self, wc_id: i64) -> Vec<ReadyWaiter> {
        self.ready_ids.insert(wc_id);
        let waiters = self.take_waiters(wc_id);
        for waiter in &waiters {
            self.host.clear_timeout(waiter.timer);
        }
        waiters
    }

    /// `watchDestroyed(wcId)`: a closed tab can never become ready, so fail its
    /// waiters instead of letting them time out
    fn watch_destroyed(&mut self, wc_id: i64) {
        if self.watched_ids.contains(&wc_id) {
            return;
        }
        if !self.host.web_contents_alive(wc_id) {
            return;
        }
        self.watched_ids.insert(wc_id);
        self.host.watch_destroyed(wc_id);
    }

    /// the 'destroyed' listener of `watchDestroyed`
    pub fn on_destroyed(&mut self, wc_id: i64) {
        // the listener exists only for a tab that was watched
        if !self.watched_ids.remove(&wc_id) {
            return;
        }
        self.ready_ids.remove(&wc_id);
        let waiters = self.take_waiters(wc_id);
        for waiter in &waiters {
            self.host.clear_timeout(waiter.timer);
        }
        // in-flight commands can never be answered either
        let mut commands = Vec::new();
        let mut kept = Vec::new();
        for (request_id, entry) in std::mem::take(&mut self.pending) {
            if entry.wc_id != wc_id {
                kept.push((request_id, entry));
                continue;
            }
            self.host.clear_timeout(entry.timer);
            commands.push(entry);
        }
        self.pending = kept;
        // the promises' reactions run after the listener
        for waiter in waiters {
            self.fail_waiter(wc_id, waiter, CLOSED.to_owned());
        }
        for entry in commands {
            self.host.settle(entry.op, Err(CLOSED.to_owned()));
        }
    }

    /// a waiter's promise rejects: an `openBlankTab` abandons its tab first
    fn fail_waiter(&mut self, wc_id: i64, waiter: ReadyWaiter, message: String) {
        if matches!(waiter.then, Then::OpenBlank) {
            self.host.abandon_blank_tab(wc_id);
        }
        self.host.settle(waiter.op, Err(message));
    }

    /// a waiter's promise resolves: what comes after `await waitForReady(wcId)`
    fn resume_waiter(&mut self, wc_id: i64, waiter: ReadyWaiter) {
        match waiter.then {
            Then::OpenBlank => {
                self.host
                    .settle(waiter.op, Ok(Some(JsonValue::Number(wc_id as f64))));
            }
            Then::RunCommand { command, payload } => {
                if let Err(message) = self.send(waiter.op, wc_id, command, payload) {
                    self.host.settle(waiter.op, Err(message));
                }
            }
        }
    }

    /// `waitForReady(wcId)` up to the point it waits: `Waiting` has registered
    /// a waiter (with its timer) that runs `then` when the tab announces itself
    fn wait_for_ready(&mut self, op: u64, wc_id: i64, then: Then) -> Wait {
        if self.ready_ids.contains(&wc_id) {
            return Wait::Ready;
        }
        if !self.host.web_contents_alive(wc_id) {
            return Wait::Closed;
        }
        self.watch_destroyed(wc_id);
        let timer = self.host.set_timeout(READY_TIMEOUT_MS);
        let waiter = ReadyWaiter { op, timer, then };
        match self.ready_waiters.iter_mut().find(|(id, _)| *id == wc_id) {
            Some((_, list)) => list.push(waiter),
            None => self.ready_waiters.push((wc_id, vec![waiter])),
        }
        Wait::Waiting
    }

    /// what `runCommand` does once the tab is ready: check a save target,
    /// number the request, arm its timer and send it. `Err` is what it throws.
    fn send(
        &mut self,
        op: u64,
        wc_id: i64,
        command: McpEditorCommandName,
        payload: Option<JsonValue>,
    ) -> Result<(), String> {
        if command == McpEditorCommandName::SaveDocument {
            // `(payload ?? {}) as { path?: unknown; overwrite?: unknown }`
            let field = |key: &str| {
                payload
                    .as_ref()
                    .and_then(|p| p.get(key))
                    .map(|value| value.into_owned())
            };
            let Some(JsonValue::String(target)) = field("path") else {
                return Err("save_document requires a path".to_owned());
            };
            // checked here so the agent gets the reason; the renderer's save only reports success/failure
            if self.host.exists_sync(&target) && field("overwrite") != Some(JsonValue::Bool(true)) {
                return Err(format!(
                    "file already exists: {target} (pass overwrite:true to replace it)"
                ));
            }
            self.host.authorize_save(wc_id, &target);
        }
        self.request_seq += 1;
        let request_id = format!("mcp-{}", self.request_seq);
        let timer = self.host.set_timeout(COMMAND_TIMEOUT_MS);
        self.pending
            .push((request_id.clone(), PendingCommand { op, wc_id, timer }));
        self.host
            .send_command(wc_id, &request_id, command, payload.as_ref());
        Ok(())
    }

    fn new_op(&mut self) -> u64 {
        let op = self.next_op;
        self.next_op += 1;
        op
    }

    /// `openBlankTab()` of the control: resolve only once the tab accepts
    /// commands, so the agent's first content call never races the renderer
    /// boot. Resolves with the tab's id (a number).
    pub fn open_blank_tab(&mut self) -> Submitted {
        let wc_id = self.host.open_blank_tab();
        let op = self.new_op();
        match self.wait_for_ready(op, wc_id, Then::OpenBlank) {
            Wait::Ready => Submitted::Resolved(Some(JsonValue::Number(wc_id as f64))),
            Wait::Closed => {
                self.host.abandon_blank_tab(wc_id);
                Submitted::Rejected(CLOSED.to_owned())
            }
            Wait::Waiting => Submitted::Pending(op),
        }
    }

    /// `runCommand(wcId, command, payload)` of the control
    pub fn run_command(
        &mut self,
        wc_id: i64,
        command: McpEditorCommandName,
        payload: Option<&JsonValue>,
    ) -> Submitted {
        if !self.host.web_contents_alive(wc_id) {
            return Submitted::Rejected("the target document is no longer open".to_owned());
        }
        let op = self.new_op();
        let then = Then::RunCommand {
            command,
            payload: payload.cloned(),
        };
        match self.wait_for_ready(op, wc_id, then) {
            Wait::Ready => match self.send(op, wc_id, command, payload.cloned()) {
                Ok(()) => Submitted::Pending(op),
                Err(message) => Submitted::Rejected(message),
            },
            Wait::Closed => Submitted::Rejected(CLOSED.to_owned()),
            Wait::Waiting => Submitted::Pending(op),
        }
    }

    /// the listener of `docs:mcp-ready`: the renderer of `sender_id`
    /// (`event.sender.id`) announced itself
    pub fn on_ready(&mut self, sender_id: i64) {
        let waiters = self.mark_ready(sender_id);
        // webContents ids are never reused, so readiness is dropped when the tab goes away
        self.watch_destroyed(sender_id);
        for waiter in waiters {
            self.resume_waiter(sender_id, waiter);
        }
    }

    /// the listener of `docs:mcp-result`: `result` is what the renderer
    /// replied (`{ requestId, ok, result?, error? }`), `sender_id` is
    /// `event.sender.id`
    pub fn on_result(&mut self, sender_id: i64, result: Option<&JsonValue>) {
        let Some(JsonValue::Object(payload)) = result else {
            return;
        };
        let Some(JsonValue::String(request_id)) = payload.get("requestId") else {
            return;
        };
        let Some(at) = self.pending.iter().position(|(id, _)| id == request_id) else {
            return;
        };
        // requestIds are guessable, so any docs tab could otherwise answer another
        // tab's command: the reply is only valid from the tab the command targeted
        if self.pending[at].1.wc_id != sender_id {
            return;
        }
        let (_, entry) = self.pending.remove(at);
        self.host.clear_timeout(entry.timer);
        let outcome = if payload.get("ok") == Some(&JsonValue::Bool(true)) {
            Ok(payload.get("result").cloned())
        } else {
            Err(match payload.get("error") {
                Some(JsonValue::String(error)) => error.clone(),
                _ => "command failed".to_owned(),
            })
        };
        self.host.settle(entry.op, outcome);
    }

    /// the timer `timer` fires: a waiter that waited too long for its tab, or a
    /// command the renderer did not answer
    pub fn on_timeout(&mut self, timer: u64) {
        let found = self
            .ready_waiters
            .iter()
            .enumerate()
            .find_map(|(at, (_, list))| {
                list.iter()
                    .position(|waiter| waiter.timer == timer)
                    .map(|index| (at, index))
            });
        if let Some((at, index)) = found {
            let wc_id = self.ready_waiters[at].0;
            let waiter = self.ready_waiters[at].1.remove(index);
            if self.ready_waiters[at].1.is_empty() {
                self.ready_waiters.remove(at);
            }
            self.fail_waiter(
                wc_id,
                waiter,
                format!("the document did not become ready within {READY_TIMEOUT_MS}ms"),
            );
            return;
        }
        if let Some(at) = self
            .pending
            .iter()
            .position(|(_, entry)| entry.timer == timer)
        {
            let (_, entry) = self.pending.remove(at);
            self.host.settle(
                entry.op,
                Err(format!(
                    "the document command timed out after {COMMAND_TIMEOUT_MS}ms"
                )),
            );
        }
    }
}
