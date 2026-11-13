//! `apps/shell/src/main/mcp/sheets-bridge.ts`: the shell-main half of the MCP
//! to sheets-grid bridge.
//!
//! A sheets workbook lives in the **renderer**, so unlike slides this needs a
//! request/response channel into the tab, the same plumbing as the docs
//! bridge (`docs_bridge`, whose shape this follows). This module waits for a
//! tab's renderer to announce itself (`sheets:mcp-ready`, sent once the
//! workbook is mounted), pushes one command at a time over
//! `sheets:mcp-command`, and resolves the matching `sheets:mcp-result`. The
//! renderer half is `apps/sheets/src/renderer/mcp-bridge.ts`.
//!
//! The TypeScript keeps its state in module variables, hangs two listeners on
//! `ipcMain` and returns promises. Here the state is a [`SheetsBridge`] the
//! caller owns, the webContents, the timers and the promises are behind
//! [`SheetsBridgeHost`], and what happens to them is a step the caller drives:
//!
//! - registering `ipcMain.on('sheets:mcp-ready' | 'sheets:mcp-result', ..)`
//!   stays in TypeScript, once: [`SheetsBridge::install`] answers whether to
//!   register now. The listener of `sheets:mcp-ready` calls
//!   [`SheetsBridge::on_ready`] with `event.sender.id`, the one of
//!   `sheets:mcp-result` calls [`SheetsBridge::on_result`] with
//!   `event.sender.id` and the reply;
//! - `wc.once('destroyed', ..)` is [`SheetsBridgeHost::watch_destroyed`]: the
//!   host calls [`SheetsBridge::on_destroyed`] when that webContents goes;
//! - a timer that fires is [`SheetsBridge::on_timeout`];
//! - the two calls of `createSheetsControl(deps)` are
//!   [`SheetsBridge::open_blank_tab`] and [`SheetsBridge::run_command`]. Each
//!   answers [`Submitted`]: settled at once, or pending, its promise settling
//!   later through [`SheetsBridgeHost::settle`]. The host implements the tool
//!   layer's `SheetsControl` over them by waiting for that settle.
//!
//! What `deps` gave (`openBlankTab`, `authorizeSave`, `abandonBlankTab`) and
//! `existsSync` are host calls too. Unlike the docs bridge, `deps.openBlankTab`
//! is asynchronous and may reject: [`SheetsBridgeHost::open_blank_tab`] answers
//! `Err` for that, and the call rejects with it (no tab, so nothing to
//! abandon). The optional `abandonBlankTab` is a host that does nothing.
//!
//! One thing of the TypeScript's scheduling is kept: a promise's reaction runs
//! after the code that settled it. So when a tab announces itself, the waiters'
//! timers are cleared and the tab's `destroyed` hook is attached before any
//! waiter continues; and when a tab goes, the timers of its waiters and
//! commands are cleared before any `abandonBlankTab` or settle.

use std::collections::HashSet;

use jscompat::{JsonValue, js_regex};

use super::docs_bridge::{Settled, Submitted};
use super::tools::sheets_tools::SheetsCommandName;

/// `READY_TIMEOUT_MS`: kept under the MCP client's own tool timeout (30s),
/// because that is the budget the caller actually sees: waiting longer here
/// makes the client report a bare "timed out" and the reason below never
/// reaches the agent.
pub const READY_TIMEOUT_MS: f64 = 24_000.0;
/// `COMMAND_TIMEOUT_MS`
pub const COMMAND_TIMEOUT_MS: f64 = 120_000.0;

/// What the bridge does to the world.
pub trait SheetsBridgeHost {
    /// `webContents.fromId(wcId)` is a webContents that is not destroyed
    fn web_contents_alive(&mut self, wc_id: i64) -> bool;
    /// `wc.once('destroyed', ..)`: later [`SheetsBridge::on_destroyed`]
    fn watch_destroyed(&mut self, wc_id: i64);
    /// `wc.send('sheets:mcp-command', { requestId, command, payload })`
    fn send_command(
        &mut self,
        wc_id: i64,
        request_id: &str,
        command: SheetsCommandName,
        payload: Option<&JsonValue>,
    );
    /// `setTimeout(callback, ms)`: the timer's number, given back to
    /// [`SheetsBridge::on_timeout`] when it fires
    fn set_timeout(&mut self, ms: f64) -> u64;
    /// `clearTimeout(timer)`
    fn clear_timeout(&mut self, timer: u64);
    /// the promise numbered `op` settles
    fn settle(&mut self, op: u64, outcome: Settled);
    /// `existsSync(path)`
    fn exists_sync(&mut self, path: &str) -> bool;
    /// `await deps.openBlankTab()`: open a fresh blank sheets tab (a real
    /// backing file, like the app's own "new spreadsheet"); its webContents id,
    /// or the message it rejects with
    fn open_blank_tab(&mut self) -> Result<i64, String>;
    /// `deps.authorizeSave(wcId, filePath)`: grant the tab's renderer write
    /// access to the resolved save target (the sheets save handler checks it)
    fn authorize_save(&mut self, wc_id: i64, file_path: &str);
    /// `deps.abandonBlankTab?.(wcId)`: close a blank tab whose session never
    /// became ready and delete the empty workbook file created for it
    fn abandon_blank_tab(&mut self, wc_id: i64);
}

/// what a waiter does once its tab is ready
enum Then {
    /// `openBlankTab`: resolve with the tab's id
    OpenBlank,
    /// `runCommand`: carry on with the command
    RunCommand {
        command: SheetsCommandName,
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

/// the module state of `sheets-bridge.ts`
pub struct SheetsBridge<H: SheetsBridgeHost> {
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

const CLOSED: &str = "the spreadsheet tab was closed";

impl<H: SheetsBridgeHost> SheetsBridge<H> {
    pub fn new(host: H) -> Self {
        SheetsBridge {
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

    /// `installSheetsBridge()`: register the renderer reply channels. Safe to
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
        command: SheetsCommandName,
        payload: Option<JsonValue>,
    ) -> Result<(), String> {
        if command == SheetsCommandName::SaveSheet {
            // `(payload ?? {}) as { path?: unknown; overwrite?: unknown }`
            let field = |key: &str| {
                payload
                    .as_ref()
                    .and_then(|p| p.get(key))
                    .map(|value| value.into_owned())
            };
            let Some(JsonValue::String(requested)) = field("path") else {
                return Err("save_sheet requires a path".to_owned());
            };
            // same normalisation as the sheets save handler, so the authorized path is the written one
            let target = if js_regex!(r"\.xlsx$", "i").test(&requested) {
                requested
            } else {
                format!("{requested}.xlsx")
            };
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
    /// boot. Resolves with the tab's id (a number); a failed wait closes the
    /// tab and its backing file (`abandonBlankTab`) before it rejects.
    pub fn open_blank_tab(&mut self) -> Submitted {
        let wc_id = match self.host.open_blank_tab() {
            Ok(wc_id) => wc_id,
            Err(message) => return Submitted::Rejected(message),
        };
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
        command: SheetsCommandName,
        payload: Option<&JsonValue>,
    ) -> Submitted {
        if !self.host.web_contents_alive(wc_id) {
            return Submitted::Rejected("the target spreadsheet is no longer open".to_owned());
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

    /// the listener of `sheets:mcp-ready`: the renderer of `sender_id`
    /// (`event.sender.id`) announced itself
    pub fn on_ready(&mut self, sender_id: i64) {
        let waiters = self.mark_ready(sender_id);
        // webContents ids are never reused, so readiness is dropped when the tab goes away
        self.watch_destroyed(sender_id);
        for waiter in waiters {
            self.resume_waiter(sender_id, waiter);
        }
    }

    /// the listener of `sheets:mcp-result`: `result` is what the renderer
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
        // requestIds are guessable, so any sheets tab could otherwise answer another
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
                format!("the spreadsheet did not become ready within {READY_TIMEOUT_MS}ms"),
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
                    "the spreadsheet command timed out after {COMMAND_TIMEOUT_MS}ms"
                )),
            );
        }
    }
}
