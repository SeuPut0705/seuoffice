//! `apps/shell/src/main/mcp-client/hub-ipc.ts`: the hub's two channels (user
//! MCP spec 5.1):
//!
//! - `mcp-tools:*` for every AI window (the editors and the home window): the
//!   list, calls, cancel, retry, "open in Settings". A call id belongs to the
//!   window that sent it, and the window's calls stop when it is destroyed.
//! - `mcp-servers:*` for Settings: answered only for the shell window, so an
//!   editor or the agent window cannot change a server or read its settings
//!   even by sending to the channel by name.
//!
//! `ipcMain.handle` stays in the TypeScript. Each method of [`McpHubIpc`] is
//! the body of one handler: `sender_id` is the id of the webContents that
//! asked, the other arguments are what the renderer sent (`None` is
//! `undefined`), and the answer is the value the handler returns (`None`
//! answers `undefined`, which Electron delivers to the renderer as such). A handler that awaits the hub answers [`IpcReply::Later`]
//! with the hub's [`Ticket`]; the hub keeps the state across the await (see
//! `hub`'s module doc), so there is no `begin`/`finish` pair: the caller drives
//! the hub's events and takes the answers with [`McpHubIpc::take_settled`].
//! `once('destroyed')` of a sender is [`McpHubIpc::sender_destroyed`], which
//! the adapter calls after [`McpHubIpcHost::watch_destroyed`] asked for it.
//! `hub.onChanged(...)` is [`McpHubIpc::on_changed`], which the caller runs for
//! each notice [`McpHubIpc::take_changed`] returns. The preload-bridge type
//! assertion (`McpToolsBridgeFitsSkill`) is a compile-time check in TypeScript
//! and has no counterpart.

use jscompat::{JsonValue, number_to_string};

use super::hub::{ChangedNotice, HubAnswer, HubResult, McpHub, Reply, Ticket};
use super::hub_input::{
    boolean_of, mcp_server_input_of, mcp_server_patch_of, paste_text_of, permission_of_input,
    plan_fingerprint_of, server_id_of, tool_name_of,
};
use crate::packages::ai_provider::jsval::{object, text};
use crate::packages::electron_utils::mcp_tools_channels::{
    mcp_call_id_of, mcp_server_name_of, mcp_tool_call_request_of,
};
use crate::shell::mcp_servers_api::MCP_SERVERS_CHANNELS;

/// The window and Electron parts of `McpHubIpcDeps` and of the Electron objects
/// the handlers use
pub trait McpHubIpcHost {
    /// `deps.isSettingsSender(event.sender)`: the sender is the shell window
    fn is_settings_sender(&mut self, sender_id: f64) -> bool;
    /// `typeof sender.once === 'function'` and `sender.once('destroyed', ...)`: ask
    /// for [`McpHubIpc::sender_destroyed`] to be called when the window goes
    /// away; `false` when the sender cannot be watched
    fn watch_destroyed(&mut self, sender_id: f64) -> bool;
    /// `for (const win of deps.allWindows()) if (!win.isDestroyed()) win.send(MCP_TOOLS_CHANNELS.changed)`
    fn broadcast_tools_changed(&mut self);
    /// `deps.settingsWindow()` is open and not destroyed
    fn settings_window_open(&mut self) -> bool;
    /// `shell.send(MCP_SERVERS_CHANNELS.changed, view)` of the shell window
    fn send_settings_changed(&mut self, view: &JsonValue);
}

/// the value a handler returns once the hub answered: `None` is `undefined`
/// (the handler returns nothing, which Electron delivers to the renderer as
/// `undefined`), `Some(Null)` is a real `null`; `Err` is a rejection
pub type IpcValue = HubResult<Option<JsonValue>>;

/// What a handler does after its hub call
#[derive(Debug, Clone, PartialEq)]
pub enum IpcReply {
    /// the handler returns (or, for `Err`, rejects with) this now
    Now(IpcValue),
    /// the hub answers later: [`McpHubIpc::take_settled`] hands the value out
    Later(Ticket),
}

/// `answer` of a ticket the hub settled, as the handler returns it
pub fn answer_value(answer: HubAnswer) -> IpcValue {
    match answer {
        HubAnswer::Call(value) | HubAnswer::SignIn(value) => Ok(Some(value)),
        HubAnswer::Test(result) | HubAnswer::Remove(result) => result.map(Some),
        HubAnswer::StopAll => Ok(None),
    }
}

fn now(value: JsonValue) -> IpcReply {
    IpcReply::Now(Ok(Some(value)))
}

/// a handler that returns `undefined`
fn now_undefined() -> IpcReply {
    IpcReply::Now(Ok(None))
}

/// a handler that returns what a hub method that writes the store answered
fn now_result(result: HubResult<JsonValue>) -> IpcReply {
    IpcReply::Now(result.map(Some))
}

fn lift<T>(reply: Reply<T>, f: impl FnOnce(T) -> IpcValue) -> IpcReply {
    match reply {
        Reply::Now(value) => IpcReply::Now(f(value)),
        Reply::Later(ticket) => IpcReply::Later(ticket),
    }
}

fn ok_flag(ok: bool) -> JsonValue {
    object(vec![("ok", JsonValue::Bool(ok))])
}

/// `malformed`
fn malformed() -> JsonValue {
    object(vec![
        ("ok", JsonValue::Bool(false)),
        ("problem", text("invalid")),
    ])
}

/// `notSettings`
fn not_settings() -> JsonValue {
    object(vec![
        ("ok", JsonValue::Bool(false)),
        ("problem", text("invalid")),
        ("detail", text("sender")),
    ])
}

fn not_found_problem() -> JsonValue {
    object(vec![
        ("ok", JsonValue::Bool(false)),
        ("problem", text("not-found")),
    ])
}

/// `MCP_SETTINGS_CHANNEL_NAMES`: the settings channels by name, so tests can
/// check none is an AI window's
pub fn mcp_settings_channel_names() -> Vec<&'static str> {
    MCP_SERVERS_CHANNELS.iter().map(|(_, name)| *name).collect()
}

/// `registerMcpHubIpc(deps)`: the hub and the module's own state, `watched`, the
/// windows whose going away is watched, so their calls end with them
pub struct McpHubIpc<'h> {
    pub hub: McpHub<'h>,
    watched: Vec<f64>,
}

impl<'h> McpHubIpc<'h> {
    pub fn new(hub: McpHub<'h>) -> Self {
        McpHubIpc {
            hub,
            watched: Vec::new(),
        }
    }

    /// `caller(event)`: `String(event.sender.id)`
    fn caller(sender_id: f64) -> String {
        number_to_string(sender_id)
    }

    /// `watch(sender)`
    fn watch<X: McpHubIpcHost>(&mut self, host: &mut X, sender_id: f64) {
        if self.watched.contains(&sender_id) {
            return;
        }
        if host.watch_destroyed(sender_id) {
            self.watched.push(sender_id);
        }
    }

    /// the `destroyed` listener of a watched window
    pub fn sender_destroyed(&mut self, sender_id: f64) {
        self.watched.retain(|id| *id != sender_id);
        self.hub.cancel_caller(&Self::caller(sender_id));
    }

    /// The answers of the handlers that returned [`IpcReply::Later`], in the
    /// order the hub settled them
    pub fn take_settled(&mut self) -> Vec<(Ticket, IpcValue)> {
        self.hub
            .take_settled()
            .into_iter()
            .map(|(ticket, answer)| (ticket, answer_value(answer)))
            .collect()
    }

    /// the notices `hub.onChanged` told its listeners of during the step the caller
    /// drove (see `hub`'s module doc), in order; run [`Self::on_changed`] for each
    pub fn take_changed(&mut self) -> Vec<ChangedNotice> {
        self.hub.take_changed()
    }

    /// the listener `registerMcpHubIpc` gives `hub.onChanged`, for one notice: tell
    /// every window of a change, and the shell window with the settings view the
    /// listener read when the notice fired (`notice.view`)
    pub fn on_changed<X: McpHubIpcHost>(&mut self, host: &mut X, notice: &ChangedNotice) {
        host.broadcast_tools_changed();
        if host.settings_window_open() {
            host.send_settings_changed(&notice.view);
        }
    }

    // ---- every AI window ----

    /// `MCP_TOOLS_CHANNELS.list`
    pub fn tools_list(&mut self) -> JsonValue {
        JsonValue::Array(self.hub.editor_list())
    }

    /// `MCP_TOOLS_CHANNELS.call`
    pub fn tools_call<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> IpcReply {
        let Some(request) = mcp_tool_call_request_of(raw) else {
            return now(object(vec![
                ("ok", JsonValue::Bool(false)),
                ("error", text("The MCP call was malformed.")),
            ]));
        };
        self.watch(host, sender_id);
        lift(
            self.hub.call(
                &Self::caller(sender_id),
                &request.server,
                &request.tool,
                &JsonValue::Object(request.input),
                &request.call_id,
            ),
            |v| Ok(Some(v)),
        )
    }

    /// `MCP_TOOLS_CHANNELS.cancel`
    pub fn tools_cancel(&mut self, sender_id: f64, raw: Option<&JsonValue>) {
        if let Some(call_id) = mcp_call_id_of(raw) {
            self.hub.cancel(&Self::caller(sender_id), &call_id);
        }
    }

    /// `MCP_TOOLS_CHANNELS.retry`
    pub fn tools_retry(&mut self, raw: Option<&JsonValue>) -> JsonValue {
        match mcp_server_name_of(raw) {
            Some(name) => ok_flag(self.hub.retry_by_name(&name)),
            None => ok_flag(false),
        }
    }

    /// `MCP_TOOLS_CHANNELS.openSettings`
    pub fn tools_open_settings(&mut self, raw: Option<&JsonValue>) -> JsonValue {
        match mcp_server_name_of(raw) {
            Some(name) => ok_flag(self.hub.open_settings_by_name(&name)),
            None => ok_flag(false),
        }
    }

    // ---- Settings (the shell window only) ----

    /// the refusal of `settings(channel, answer, refused)`; `None` when the
    /// sender is the shell window
    fn refused<X: McpHubIpcHost>(
        host: &mut X,
        sender_id: f64,
        refused: JsonValue,
    ) -> Option<IpcReply> {
        if host.is_settings_sender(sender_id) {
            None
        } else {
            Some(now(refused))
        }
    }

    /// `C.list`
    pub fn servers_list<X: McpHubIpcHost>(&mut self, host: &mut X, sender_id: f64) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, JsonValue::Null) {
            return refused;
        }
        now(self.hub.settings_view())
    }

    /// `C.parsePaste`
    pub fn servers_parse_paste<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        match paste_text_of(raw) {
            Some(pasted) => now(self.hub.parse_paste(&pasted)),
            None => now(object(vec![
                ("ok", JsonValue::Bool(false)),
                ("error", text("unreadable")),
            ])),
        }
    }

    /// `C.add`
    pub fn servers_add<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        match mcp_server_input_of(raw) {
            Some(input) => now_result(self.hub.add(&input)),
            None => now(malformed()),
        }
    }

    /// `C.edit`
    pub fn servers_edit<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw_id: Option<&JsonValue>,
        raw_patch: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        let id = server_id_of(raw_id);
        let patch = mcp_server_patch_of(raw_patch);
        match (id, patch) {
            (Some(id), Some(patch)) => now_result(self.hub.edit(&id, &patch)),
            _ => now(malformed()),
        }
    }

    /// `C.remove`
    pub fn servers_remove<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        match server_id_of(raw) {
            Some(id) => lift(self.hub.remove(&id), |v| v.map(Some)),
            None => now(malformed()),
        }
    }

    /// `C.test`
    pub fn servers_test<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        match server_id_of(raw) {
            Some(id) => lift(self.hub.test(&id), |v| v.map(Some)),
            None => now(malformed()),
        }
    }

    /// `C.signIn`
    pub fn servers_sign_in<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> IpcReply {
        let not_found = object(vec![
            ("ok", JsonValue::Bool(false)),
            ("reason", text("not-found")),
        ]);
        if let Some(refused) = Self::refused(host, sender_id, not_found) {
            return refused;
        }
        match server_id_of(raw) {
            Some(id) => lift(self.hub.sign_in(&id), |v| Ok(Some(v))),
            None => now(malformed()),
        }
    }

    /// `C.cancelSignIn`
    pub fn servers_cancel_sign_in<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        match server_id_of(raw) {
            Some(id) => {
                self.hub.cancel_sign_in(&id);
                now_undefined()
            }
            None => now(malformed()),
        }
    }

    /// `C.approveTool`
    pub fn servers_approve_tool<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw_id: Option<&JsonValue>,
        raw_tool: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        match (server_id_of(raw_id), tool_name_of(raw_tool)) {
            (Some(id), Some(tool)) => now_result(self.hub.approve_tool(&id, &tool)),
            _ => now(malformed()),
        }
    }

    /// `C.approveInstructions`
    pub fn servers_approve_instructions<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        match server_id_of(raw) {
            Some(id) => now_result(self.hub.approve_instructions(&id)),
            None => now(malformed()),
        }
    }

    /// `C.approveLaunch`
    pub fn servers_approve_launch<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw_id: Option<&JsonValue>,
        raw_fingerprint: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        match (server_id_of(raw_id), plan_fingerprint_of(raw_fingerprint)) {
            (Some(id), Some(fingerprint)) => now_result(self.hub.approve_launch(&id, &fingerprint)),
            _ => now(malformed()),
        }
    }

    /// `C.setToolPermission`
    pub fn servers_set_tool_permission<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw_id: Option<&JsonValue>,
        raw_tool: Option<&JsonValue>,
        raw_permission: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        match (
            server_id_of(raw_id),
            tool_name_of(raw_tool),
            permission_of_input(raw_permission),
        ) {
            (Some(id), Some(tool), Some(permission)) => {
                now_result(self.hub.set_tool_permission(&id, &tool, permission))
            }
            _ => now(malformed()),
        }
    }

    /// `C.setKeepResultsInside`
    pub fn servers_set_keep_results_inside<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw_id: Option<&JsonValue>,
        raw_on: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        match (server_id_of(raw_id), boolean_of(raw_on)) {
            (Some(id), Some(on)) => now_result(self.hub.set_keep_results_inside(&id, on)),
            _ => now(malformed()),
        }
    }

    /// `C.setEnabled`
    pub fn servers_set_enabled<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw_id: Option<&JsonValue>,
        raw_on: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        match (server_id_of(raw_id), boolean_of(raw_on)) {
            (Some(id), Some(on)) => now_result(self.hub.set_enabled(&id, on)),
            _ => now(malformed()),
        }
    }

    /// `C.markToolsSeen`
    pub fn servers_mark_tools_seen<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        match server_id_of(raw) {
            Some(id) => now_result(self.hub.mark_tools_seen(&id)),
            None => now(malformed()),
        }
    }

    /// `C.plannedLaunch`
    pub fn servers_planned_launch<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_found_problem()) {
            return refused;
        }
        match server_id_of(raw) {
            Some(id) => now(self.hub.planned_launch(&id)),
            None => now(malformed()),
        }
    }

    /// `C.answerRuntimeDownload`
    pub fn servers_answer_runtime_download<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw_id: Option<&JsonValue>,
        raw_download: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_found_problem()) {
            return refused;
        }
        match (server_id_of(raw_id), boolean_of(raw_download)) {
            (Some(id), Some(download)) => {
                now_result(self.hub.answer_runtime_download(&id, download))
            }
            _ => now(not_found_problem()),
        }
    }

    /// `C.retry`
    pub fn servers_retry<X: McpHubIpcHost>(
        &mut self,
        host: &mut X,
        sender_id: f64,
        raw: Option<&JsonValue>,
    ) -> IpcReply {
        if let Some(refused) = Self::refused(host, sender_id, not_settings()) {
            return refused;
        }
        match server_id_of(raw) {
            Some(id) => now(self.hub.retry(&id)),
            None => now(malformed()),
        }
    }
}
