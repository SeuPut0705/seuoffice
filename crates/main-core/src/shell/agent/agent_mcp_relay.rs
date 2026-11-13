//! `apps/shell/src/main/agent/agent-mcp-relay.ts`: relays of the person's MCP
//! servers for one agent session (user MCP spec 9).
//!
//! At the start of a session the app opens, for each of the person's servers
//! that is on, an MCP server of its own with the same name: loopback, a port
//! the system picks and a fresh token of the session. A relay hands each call
//! to the hub, so the server's address, keys and environment never reach the
//! program. A relay lists the tools that were `always` or `ask` and not
//! waiting for review when the session started, read again at every listing.
//! An `ask` tool waits for the agent window's card (deny, allow for the
//! session, allow once) before the call goes on.
//!
//! The pure parts ([`agent_relay_plans`], [`relay_result_of`], [`RELAY_TEXT`])
//! are plain functions. The rest is a state machine the caller drives, as it
//! drives a `McpServerService` (see `shell::mcp::mcp_server`): one service per
//! plan, each with its own listener, sockets and timers, so every [`Command`]
//! this module returns is a [`ServiceCommand`], the command and the index of
//! the service it belongs to.
//!
//! The caller carries out every command, from this module's methods and from
//! the services' (`service_mut(i).on_request(..)` and the like) alike, and
//! reports three of them back:
//!
//! - `Command::StartSettled` of service `i`: [`AgentMcpRelays::on_started`]
//!   (the next relay starts, or the failure stops them all);
//! - `Command::StopSettled` of service `i`: [`AgentMcpRelays::on_stopped`];
//! - `Command::Aborted` of service `i`: [`AgentMcpRelays::on_aborted`] (the
//!   client cancelled the call, or its session closed).
//!
//! The TypeScript promises become host operations that start now and answer
//! later:
//!
//! - `hub.call(..)` is [`AgentRelayHub::call`]; its answer is
//!   [`AgentMcpRelays::on_hub_answer`] with the call id given (an `Err` is a
//!   rejection);
//! - `ask(request, signal)` is [`AgentRelayAsk::ask`]; the signal aborting is
//!   [`AgentRelayAsk::abort`]; the answer is [`AgentMcpRelays::on_ask_answer`]
//!   (an `Err` is a rejection, taken as a refusal).
//!
//! A `tools/call` is answered by the low-level `Server` through a deferred
//! request handler: the handler records the call and answers later, and the
//! answers above settle it through `McpServerService::settle`.
//!
//! `startAgentMcpRelays` ends with [`RelayDone::Started`] and `stop()` with
//! [`RelayDone::Stopped`] in the [`RelayStep`] of the call that finished them.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::{JsObject, JsonValue, json_stringify, trim};

use super::agent_mcp::{AgentMcpHost, ServiceHost, session_token};
use crate::packages::agent_core::user_mcp_names::{MCP_SERVER_NAME_MAX, is_valid_server_name};
use crate::packages::agent_core::user_mcp_result::{McpCallAnswer, mcp_call_answer_of};
use crate::packages::mcp_sdk::server::{
    Aborted, Command, DeferredHandler, HandlerReply, RequestExtra, RequestHandler, RequestSchema,
    Server, ServerOptions, SessionServer, StartError, StopId, Ticket,
};
use crate::shell::mcp::mcp_server::{McpServerService, McpServerServiceOptions};
use crate::shell::mcp::tools::session_tools::spread;

/// `McpHub` as a relay uses it (`AgentRelayHub`). `editor_list` answers the
/// `McpServerView[]` as the hub's JSON; a call that is not read from the hub
/// until the caller reports its answer.
pub trait AgentRelayHub {
    fn editor_list(&self) -> Vec<JsonValue>;
    /// starts `call(caller, server, tool, input, callId)`; the answer is [`AgentMcpRelays::on_hub_answer`]
    fn call(&self, caller: &str, server: &str, tool: &str, input: &JsonValue, call_id: &str);
    fn cancel(&self, caller: &str, call_id: &str);
}

/// one call waiting for the person's answer: what the caller reports it by
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RelayCallId(pub u64);

/// `AgentRelayAskRequest`: what the agent window's card shows for a call of an `ask` tool
#[derive(Debug, Clone, PartialEq)]
pub struct AgentRelayAskRequest {
    pub server: String,
    /// the tool's name as the program calls it, `mcp__<server>__<tool>`
    pub exposed_name: String,
    pub input: JsonValue,
}

/// `AgentRelayAnswer`'s `scope`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRelayScope {
    Once,
    Session,
}

/// `AgentRelayAnswer`: `{ allow: false }` or `{ allow: true, scope }`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRelayAnswer {
    Deny,
    Allow(AgentRelayScope),
}

/// `AgentRelayAsk`: ask the person. The `signal` of the TypeScript aborting is
/// [`abort`](Self::abort) (the call is cancelled or the session ends; a
/// refusal follows).
pub trait AgentRelayAsk {
    fn ask(&self, call: RelayCallId, request: &AgentRelayAskRequest);
    fn abort(&self, call: RelayCallId);
}

/// `AgentRelayToolPlan`: one tool a relay offers
#[derive(Debug, Clone, PartialEq)]
pub struct AgentRelayToolPlan {
    /// the server's own name for the tool (what the hub takes)
    pub name: String,
    /// the name on the relay: `mcp__<server>__<relayName>` is the exposed name
    pub relay_name: String,
    pub description: String,
    pub input_schema: JsonValue,
}

/// `AgentRelayPlan`: one relay to open
#[derive(Debug, Clone, PartialEq)]
pub struct AgentRelayPlan {
    pub server: String,
    pub keep_results_inside: bool,
    /// the approved server instructions, if any
    pub instructions: Option<String>,
    pub tools: Vec<AgentRelayToolPlan>,
}

/// `AgentMcpRelay` of the agent session types: what the program is given
#[derive(Debug, Clone, PartialEq)]
pub struct AgentMcpRelay {
    pub name: String,
    pub url: String,
    pub token: String,
    pub tools: Vec<String>,
}

/// `offered(permission)`
fn offered(permission: &str) -> bool {
    permission == "always" || permission == "ask"
}

/// a field of a hub JSON object, `""` when it is not a string
fn string_field(value: &JsonValue, key: &str) -> String {
    match value.get(key).as_deref() {
        Some(JsonValue::String(text)) => text.clone(),
        _ => String::new(),
    }
}

/// a field of a hub JSON object, read for its truthiness
fn truthy_field(value: &JsonValue, key: &str) -> bool {
    value.get(key).is_some_and(|field| field.truthy())
}

/// the tools array of a server view
fn tools_of(server: &JsonValue) -> Vec<JsonValue> {
    match server.get("tools").as_deref() {
        Some(JsonValue::Array(tools)) => tools.clone(),
        _ => Vec::new(),
    }
}

/// `agentRelayPlans(list)`: the relays of a session, from the hub's list at
/// its start: each server that is on and has a usable name, with its tools
/// that are `always` or `ask`, not waiting for review and with a name the
/// program can call. A server left with no such tool gets no relay.
pub fn agent_relay_plans(list: &[JsonValue]) -> Vec<AgentRelayPlan> {
    let mut plans = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for server in list {
        let name = string_field(server, "name");
        let key = name.to_lowercase();
        if string_field(server, "status") == "disabled"
            || !is_valid_server_name(&name, MCP_SERVER_NAME_MAX)
            || seen.contains(&key)
        {
            continue;
        }
        let prefix = format!("mcp__{name}__");
        let mut tools = Vec::new();
        for tool in tools_of(server) {
            if !offered(&string_field(&tool, "permission"))
                || truthy_field(&tool, "pending")
                || truthy_field(&tool, "unusable")
            {
                continue;
            }
            let exposed = string_field(&tool, "exposedName");
            if !exposed.starts_with(&prefix) || exposed.len() == prefix.len() {
                continue;
            }
            tools.push(AgentRelayToolPlan {
                name: string_field(&tool, "name"),
                relay_name: exposed[prefix.len()..].to_owned(),
                description: string_field(&tool, "description"),
                input_schema: tool
                    .get("inputSchema")
                    .map(|schema| schema.into_owned())
                    .unwrap_or(JsonValue::Null),
            });
        }
        if tools.is_empty() {
            continue;
        }
        seen.push(key);
        plans.push(AgentRelayPlan {
            server: name,
            keep_results_inside: truthy_field(server, "keepResultsInside"),
            instructions: match server.get("instructions").as_deref() {
                Some(JsonValue::String(text)) => Some(text.clone()),
                _ => None,
            },
            tools,
        });
    }
    plans
}

/// `quoted(text)`: `JSON.stringify(text.slice(0, 80))`. The slice counts
/// UTF-16 units and may end inside a pair; `JSON.stringify` then writes the
/// lone half as a `\udXXX` escape (well-formed JSON.stringify, ES2019), so the
/// text holds those six ASCII characters, which a Rust string can hold too.
fn quoted(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().take(80).collect();
    let mut out = String::from("\"");
    let mut whole = String::new();
    for unit in char::decode_utf16(units) {
        match unit {
            Ok(c) => whole.push(c),
            Err(lone) => {
                let escaped = json_stringify(&JsonValue::String(std::mem::take(&mut whole)));
                out.push_str(&escaped[1..escaped.len() - 1]);
                out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate()));
            }
        }
    }
    let escaped = json_stringify(&JsonValue::String(whole));
    out.push_str(&escaped[1..]);
    out
}

/// `RELAY_TEXT`: the texts the program reads (English, no secret, no address)
pub struct RelayText;

impl RelayText {
    pub fn needs_review(&self, server: &str, tool: &str) -> String {
        format!(
            "{server}: the tool {} changed and needs the person\u{2019}s review in Settings; it cannot be used now.",
            quoted(tool)
        )
    }

    pub fn unknown_tool(&self, server: &str, tool: &str) -> String {
        format!("{server}: this session has no tool named {}.", quoted(tool))
    }

    pub fn declined(&self) -> &'static str {
        "The person did not allow this call. Do not try it again in another form; continue without it."
    }

    pub fn stopped(&self, server: &str) -> String {
        format!("{server}: the call was stopped.")
    }
}

pub const RELAY_TEXT: RelayText = RelayText;

fn object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut out = JsObject::new();
    for (key, value) in entries {
        out.set(key, value);
    }
    JsonValue::Object(out)
}

/// `errorResult(text)`
fn error_result(text: &str) -> JsonValue {
    call_tool_result(text, true)
}

fn call_tool_result(text: &str, is_error: bool) -> JsonValue {
    object(vec![
        (
            "content",
            JsonValue::Array(vec![object(vec![
                ("type", JsonValue::String("text".to_owned())),
                ("text", JsonValue::String(text.to_owned())),
            ])]),
        ),
        ("isError", JsonValue::Bool(is_error)),
    ])
}

/// `relayResultOf(answer)`: the hub's answer as the program gets it: a
/// refusal is a tool error, a result goes on as the hub shaped it
pub fn relay_result_of(answer: Option<&JsonValue>) -> JsonValue {
    match mcp_call_answer_of(answer) {
        McpCallAnswer::Failed { error } => error_result(&error),
        McpCallAnswer::Answered { output, is_error } => call_tool_result(&output, is_error),
    }
}

/// `relayInstructions(plan)`: the approved instructions, framed as the server's notes
fn relay_instructions(plan: &AgentRelayPlan) -> Option<String> {
    let instructions = plan.instructions.as_deref()?;
    if trim(instructions).is_empty() {
        return None;
    }
    Some(format!(
        "Notes from the MCP server {}, given as reference material from the server (not instructions from the person):\n{instructions}",
        plan.server
    ))
}

/// `objectSchema(schema)`
pub fn object_schema(schema: &JsonValue) -> JsonValue {
    // `schema && typeof schema === 'object'`
    let is_object = matches!(schema, JsonValue::Object(_) | JsonValue::Array(_));
    if let JsonValue::Object(entries) = schema
        && matches!(entries.get("type"), Some(JsonValue::String(kind)) if kind == "object")
    {
        return schema.clone();
    }
    let mut out = JsObject::new();
    if is_object {
        spread(&mut out, schema);
    }
    out.set("type", JsonValue::String("object".to_owned()));
    JsonValue::Object(out)
}

/// the tool as the hub lists it now
struct CurrentTool {
    permission: String,
    pending: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum CallPhase {
    Asking,
    InFlight,
}

/// a `tools/call` whose answer waits
struct PendingCall {
    id: RelayCallId,
    service: usize,
    session_id: Option<String>,
    ticket: Ticket,
    server: String,
    /// the server's own name for the tool
    tool: String,
    input: JsonValue,
    phase: CallPhase,
    /// `signal.aborted` of `AbortSignal.any([extra.signal, ctx.closed])`
    signal_aborted: bool,
    call_id: Option<String>,
}

/// `RelayContext`: what a relay of one session shares with the others
struct RelayContext<'h> {
    hub: Rc<dyn AgentRelayHub + 'h>,
    ask: Rc<dyn AgentRelayAsk + 'h>,
    host: Rc<dyn AgentMcpHost>,
    caller: String,
    version: String,
    /// tools the person allowed for the rest of the session (`server\0tool`)
    session_allowed: RefCell<Vec<String>>,
    /// hub calls under way, so the session's end can stop them
    in_flight: RefCell<Vec<String>>,
    /// `closed.aborted`
    closed: Cell<bool>,
    /// the calls waiting, in the order they began
    calls: RefCell<Vec<PendingCall>>,
    next_call: Cell<u64>,
}

impl RelayContext<'_> {
    /// `currentTool(ctx, server, name)`: the tool as the hub lists it now
    fn current_tool(&self, server: &str, name: &str) -> Option<CurrentTool> {
        let list = self.hub.editor_list();
        let view = list.iter().find(|s| string_field(s, "name") == server)?;
        let tool = tools_of(view)
            .into_iter()
            .find(|t| string_field(t, "name") == name)?;
        Some(CurrentTool {
            permission: string_field(&tool, "permission"),
            pending: truthy_field(&tool, "pending"),
        })
    }

    /// `ctx.hub.call` of a call that was allowed: the call id, the listener
    /// that cancels it, the in-flight set
    fn begin_hub_call(&self, id: RelayCallId) {
        let call_id = self.host.random_uuid();
        let (server, tool, input) = {
            let mut calls = self.calls.borrow_mut();
            let Some(call) = calls.iter_mut().find(|c| c.id == id) else {
                return;
            };
            call.phase = CallPhase::InFlight;
            call.call_id = Some(call_id.clone());
            (call.server.clone(), call.tool.clone(), call.input.clone())
        };
        self.in_flight.borrow_mut().push(call_id.clone());
        self.hub
            .call(&self.caller, &server, &tool, &input, &call_id);
    }

    /// the signal of a call fires: the card is told, or the hub call cancelled
    fn fire_signal(&self, id: RelayCallId) {
        let fired = {
            let mut calls = self.calls.borrow_mut();
            match calls.iter_mut().find(|c| c.id == id) {
                Some(call) if !call.signal_aborted => {
                    call.signal_aborted = true;
                    Some((call.phase, call.call_id.clone()))
                }
                _ => None,
            }
        };
        match fired {
            Some((CallPhase::Asking, _)) => self.ask.abort(id),
            Some((CallPhase::InFlight, Some(call_id))) => {
                self.hub.cancel(&self.caller, &call_id);
            }
            _ => {}
        }
    }

    fn take_call(&self, id: RelayCallId) -> Option<PendingCall> {
        let mut calls = self.calls.borrow_mut();
        let at = calls.iter().position(|c| c.id == id)?;
        Some(calls.remove(at))
    }
}

/// the `arguments` of a `tools/call` request: `request.params.arguments ?? {}`
fn arguments_of(request: &JsonValue) -> JsonValue {
    match request
        .get("params")
        .and_then(|params| params.get("arguments").map(|a| a.into_owned()))
    {
        None | Some(JsonValue::Null) => JsonValue::Object(JsObject::new()),
        Some(arguments) => arguments,
    }
}

/// `relayServer(ctx, plan)`: one client session's MCP server for a relay
fn relay_server<'h>(
    ctx: Rc<RelayContext<'h>>,
    plan: Rc<AgentRelayPlan>,
    service: usize,
) -> Box<dyn SessionServer + 'h> {
    let instructions = relay_instructions(&plan);
    let mut server = Server::new(
        object(vec![
            ("name", JsonValue::String(plan.server.clone())),
            ("version", JsonValue::String(ctx.version.clone())),
        ]),
        ServerOptions {
            capabilities: Some(object(vec![("tools", object(Vec::new()))])),
            instructions,
        },
    );

    let list_ctx = Rc::clone(&ctx);
    let list_plan = Rc::clone(&plan);
    let list: RequestHandler<'h> = Box::new(move |_, _| {
        let tools: Vec<JsonValue> = list_plan
            .tools
            .iter()
            .filter(|tool| {
                list_ctx
                    .current_tool(&list_plan.server, &tool.name)
                    .is_some_and(|now| offered(&now.permission) && !now.pending)
            })
            .map(|tool| {
                object(vec![
                    ("name", JsonValue::String(tool.relay_name.clone())),
                    ("description", JsonValue::String(tool.description.clone())),
                    ("inputSchema", object_schema(&tool.input_schema)),
                ])
            })
            .collect();
        Ok(object(vec![("tools", JsonValue::Array(tools))]))
    });
    server
        .set_request_handler(RequestSchema::ListTools, list)
        .expect("a relay server declares the tools capability");

    let call: DeferredHandler<'h> = Box::new(move |request: &JsonValue, extra: &RequestExtra| {
        let name = match request
            .get("params")
            .and_then(|params| params.get("name").map(|name| name.into_owned()))
        {
            Some(JsonValue::String(name)) => name,
            _ => String::new(),
        };
        let input = arguments_of(request);
        let Some(tool) = plan.tools.iter().rev().find(|t| t.relay_name == name) else {
            return HandlerReply::Now(Ok(error_result(
                &RELAY_TEXT.unknown_tool(&plan.server, &name),
            )));
        };
        let now = ctx.current_tool(&plan.server, &tool.name);
        if now.as_ref().is_some_and(|now| now.pending) {
            return HandlerReply::Now(Ok(error_result(
                &RELAY_TEXT.needs_review(&plan.server, &tool.name),
            )));
        }
        let allow_key = format!("{}\u{0}{}", plan.server, tool.name);
        let asks = now.as_ref().is_some_and(|now| now.permission == "ask")
            && !ctx.session_allowed.borrow().contains(&allow_key);
        // a tool that is gone or off goes on to the hub, which answers why it cannot be used
        if !asks && ctx.closed.get() {
            return HandlerReply::Now(Ok(error_result(&RELAY_TEXT.stopped(&plan.server))));
        }
        let id = RelayCallId(ctx.next_call.get());
        ctx.next_call.set(id.0 + 1);
        ctx.calls.borrow_mut().push(PendingCall {
            id,
            service,
            session_id: extra.session_id.clone(),
            ticket: extra.ticket,
            server: plan.server.clone(),
            tool: tool.name.clone(),
            input: input.clone(),
            phase: if asks {
                CallPhase::Asking
            } else {
                CallPhase::InFlight
            },
            signal_aborted: ctx.closed.get(),
            call_id: None,
        });
        if asks {
            ctx.ask.ask(
                id,
                &AgentRelayAskRequest {
                    server: plan.server.clone(),
                    exposed_name: format!("mcp__{}__{}", plan.server, name),
                    input,
                },
            );
        } else {
            ctx.begin_hub_call(id);
        }
        HandlerReply::Later(extra.ticket)
    });
    server
        .set_deferred_request_handler(RequestSchema::CallTool, call)
        .expect("a relay server declares the tools capability");
    Box::new(server)
}

/// a command of the service with this index
#[derive(Debug, Clone, PartialEq)]
pub struct ServiceCommand {
    pub service: usize,
    pub command: Command,
}

fn tagged(service: usize, commands: Vec<Command>) -> Vec<ServiceCommand> {
    commands
        .into_iter()
        .map(|command| ServiceCommand { service, command })
        .collect()
}

/// what finished
#[derive(Debug, Clone, PartialEq)]
pub enum RelayDone {
    /// `startAgentMcpRelays` resolved (`Ok`) or threw (`Err`: `String(error)`, after the relays stopped)
    Started(Result<(), String>),
    /// `stop()` resolved
    Stopped,
}

/// the commands of a step, and what the step finished
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RelayStep {
    pub commands: Vec<ServiceCommand>,
    pub done: Option<RelayDone>,
}

#[derive(Clone, PartialEq)]
enum Stage {
    Starting,
    Running,
}

/// what happens when the services of a `stop()` have stopped
enum AfterStop {
    Stopped,
    StartFailed(String),
}

struct StopWait {
    remaining: Vec<(usize, StopId)>,
    then: AfterStop,
}

/// `AgentMcpRelaysDeps`
pub struct AgentMcpRelaysDeps<'h> {
    pub hub: Rc<dyn AgentRelayHub + 'h>,
    pub ask: Rc<dyn AgentRelayAsk + 'h>,
    /// keeps this session's call ids apart from other windows' in the hub
    pub caller: String,
    pub version: String,
    pub host: Rc<dyn AgentMcpHost>,
}

/// `AgentMcpRelays`: a session's relays. The caller stops them when the session ends.
pub struct AgentMcpRelays<'h> {
    ctx: Rc<RelayContext<'h>>,
    host: Rc<dyn AgentMcpHost>,
    plans: Vec<Rc<AgentRelayPlan>>,
    services: Vec<McpServerService<'h>>,
    tokens: Vec<String>,
    relays: Vec<AgentMcpRelay>,
    stage: Stage,
    waits: Vec<StopWait>,
}

impl<'h> AgentMcpRelays<'h> {
    /// `startAgentMcpRelays(deps)`: the first relay starts; the step's `done`
    /// says when the rest did
    pub fn start(deps: AgentMcpRelaysDeps<'h>) -> (Self, RelayStep) {
        let ctx = Rc::new(RelayContext {
            hub: deps.hub,
            ask: deps.ask,
            host: Rc::clone(&deps.host),
            caller: deps.caller,
            version: deps.version,
            session_allowed: RefCell::new(Vec::new()),
            in_flight: RefCell::new(Vec::new()),
            closed: Cell::new(false),
            calls: RefCell::new(Vec::new()),
            next_call: Cell::new(1),
        });
        let plans = agent_relay_plans(&ctx.hub.editor_list())
            .into_iter()
            .map(Rc::new)
            .collect();
        let mut relays = AgentMcpRelays {
            ctx,
            host: deps.host,
            plans,
            services: Vec::new(),
            tokens: Vec::new(),
            relays: Vec::new(),
            stage: Stage::Starting,
            waits: Vec::new(),
        };
        let step = relays.start_next();
        (relays, step)
    }

    /// what the program is given: names, loopback addresses, session tokens and tool names
    pub fn relays(&self) -> &[AgentMcpRelay] {
        &self.relays
    }

    /// the attached servers that keep received content inside (the start warning names them)
    pub fn keep_results_inside(&self) -> Vec<String> {
        self.plans
            .iter()
            .filter(|plan| plan.keep_results_inside)
            .map(|plan| plan.server.clone())
            .collect()
    }

    /// the service of relay `index`, which the caller drives
    pub fn service_mut(&mut self, index: usize) -> &mut McpServerService<'h> {
        &mut self.services[index]
    }

    /// the token of relay `index`
    pub fn token(&self, index: usize) -> &str {
        &self.tokens[index]
    }

    /// how many relays were made
    pub fn len(&self) -> usize {
        self.services.len()
    }

    pub fn is_empty(&self) -> bool {
        self.services.is_empty()
    }

    /// one iteration of the loop of `startAgentMcpRelays`: the next plan's service starts
    fn start_next(&mut self) -> RelayStep {
        let index = self.services.len();
        let Some(plan) = self.plans.get(index).cloned() else {
            self.stage = Stage::Running;
            return RelayStep {
                commands: Vec::new(),
                done: Some(RelayDone::Started(Ok(()))),
            };
        };
        let token = session_token(&*self.host);
        let ctx = Rc::clone(&self.ctx);
        let factory_plan = Rc::clone(&plan);
        let mut service = McpServerService::new(
            McpServerServiceOptions {
                port: 0.0,
                tools: None,
                tools_factory: None,
                server_factory: Some(Box::new(move || {
                    relay_server(Rc::clone(&ctx), Rc::clone(&factory_plan), index)
                })),
                version: Some(self.ctx.version.clone()),
                max_listen_attempts: Some(1.0),
                listen_retry_delay_ms: None,
                token: Some(token.clone()),
            },
            Box::new(ServiceHost(Rc::clone(&self.host))),
        );
        self.tokens.push(token);
        let (_, commands) = service.start(Some(0.0));
        self.services.push(service);
        RelayStep {
            commands: tagged(index, commands),
            done: None,
        }
    }

    /// `Command::StartSettled` of service `service`
    pub fn on_started(&mut self, service: usize, outcome: Result<(), StartError>) -> RelayStep {
        if self.stage != Stage::Starting || service + 1 != self.services.len() {
            return RelayStep::default();
        }
        match outcome {
            Ok(()) => {
                let plan = &self.plans[service];
                self.relays.push(AgentMcpRelay {
                    name: plan.server.clone(),
                    url: format!("{}/mcp", self.services[service].get_url()),
                    token: self.tokens[service].clone(),
                    tools: plan.tools.iter().map(|t| t.relay_name.clone()).collect(),
                });
                self.start_next()
            }
            Err(error) => {
                self.stage = Stage::Running;
                self.begin_stop(AfterStop::StartFailed(error.text))
            }
        }
    }

    /// `stop()`: closes every relay and stops the calls under way
    pub fn stop(&mut self) -> RelayStep {
        self.begin_stop(AfterStop::Stopped)
    }

    fn begin_stop(&mut self, then: AfterStop) -> RelayStep {
        // `closing.abort()`: the signal of every call fires, in the order the calls began
        self.ctx.closed.set(true);
        let ids: Vec<RelayCallId> = self.ctx.calls.borrow().iter().map(|c| c.id).collect();
        for id in ids {
            self.ctx.fire_signal(id);
        }
        let in_flight: Vec<String> = std::mem::take(&mut *self.ctx.in_flight.borrow_mut());
        for call_id in in_flight {
            self.ctx.hub.cancel(&self.ctx.caller, &call_id);
        }
        let mut commands = Vec::new();
        let mut remaining = Vec::new();
        for (index, service) in self.services.iter_mut().enumerate() {
            let (stop, issued) = service.stop();
            remaining.push((index, stop));
            commands.extend(tagged(index, issued));
        }
        if remaining.is_empty() {
            return RelayStep {
                commands,
                done: Some(Self::done_of(then)),
            };
        }
        self.waits.push(StopWait { remaining, then });
        RelayStep {
            commands,
            done: None,
        }
    }

    fn done_of(then: AfterStop) -> RelayDone {
        match then {
            AfterStop::Stopped => RelayDone::Stopped,
            AfterStop::StartFailed(text) => RelayDone::Started(Err(text)),
        }
    }

    /// `Command::StopSettled` of service `service`
    pub fn on_stopped(&mut self, service: usize, stop: StopId) -> RelayStep {
        let mut done = None;
        for wait in &mut self.waits {
            wait.remaining.retain(|entry| *entry != (service, stop));
        }
        if let Some(at) = self.waits.iter().position(|w| w.remaining.is_empty()) {
            done = Some(Self::done_of(self.waits.remove(at).then));
        }
        RelayStep {
            commands: Vec::new(),
            done,
        }
    }

    /// `Command::Aborted` of service `service`: `extra.signal` of a call fired
    pub fn on_aborted(&mut self, service: usize, aborted: &Aborted) -> RelayStep {
        let id = self
            .ctx
            .calls
            .borrow()
            .iter()
            .find(|c| {
                c.service == service
                    && c.session_id == aborted.session_id
                    && c.ticket == aborted.ticket
            })
            .map(|c| c.id);
        if let Some(id) = id {
            self.ctx.fire_signal(id);
        }
        RelayStep::default()
    }

    /// the call settles: the SDK sends `result` unless the request was aborted
    fn finish(&mut self, id: RelayCallId, result: JsonValue) -> RelayStep {
        let Some(call) = self.ctx.take_call(id) else {
            return RelayStep::default();
        };
        let commands = self.services[call.service].settle(
            call.session_id.as_deref().unwrap_or(""),
            call.ticket,
            Ok(result),
        );
        RelayStep {
            commands: tagged(call.service, commands),
            done: None,
        }
    }

    /// the answer of the card the host showed for call `call`; `Err` is a rejection
    pub fn on_ask_answer(
        &mut self,
        call: RelayCallId,
        answer: Result<AgentRelayAnswer, ()>,
    ) -> RelayStep {
        let waiting = self
            .ctx
            .calls
            .borrow()
            .iter()
            .find(|c| c.id == call && c.phase == CallPhase::Asking)
            .map(|c| (c.server.clone(), c.tool.clone()));
        let Some((server, tool)) = waiting else {
            return RelayStep::default();
        };
        let scope = match answer.unwrap_or(AgentRelayAnswer::Deny) {
            AgentRelayAnswer::Deny => {
                return self.finish(call, error_result(RELAY_TEXT.declined()));
            }
            AgentRelayAnswer::Allow(scope) => scope,
        };
        if scope == AgentRelayScope::Session {
            let key = format!("{server}\u{0}{tool}");
            let mut allowed = self.ctx.session_allowed.borrow_mut();
            if !allowed.contains(&key) {
                allowed.push(key);
            }
        }
        let aborted = self
            .ctx
            .calls
            .borrow()
            .iter()
            .any(|c| c.id == call && c.signal_aborted);
        if aborted {
            return self.finish(call, error_result(&RELAY_TEXT.stopped(&server)));
        }
        self.ctx.begin_hub_call(call);
        RelayStep::default()
    }

    /// the answer of `hub.call` for `call_id`; `Err` is a rejection
    pub fn on_hub_answer(
        &mut self,
        call_id: &str,
        answer: Result<Option<JsonValue>, ()>,
    ) -> RelayStep {
        let found = self
            .ctx
            .calls
            .borrow()
            .iter()
            .find(|c| c.call_id.as_deref() == Some(call_id))
            .map(|c| (c.id, c.server.clone()));
        let Some((id, server)) = found else {
            return RelayStep::default();
        };
        let result = match answer {
            Ok(answer) => relay_result_of(answer.as_ref()),
            Err(()) => error_result(&RELAY_TEXT.stopped(&server)),
        };
        self.ctx.in_flight.borrow_mut().retain(|c| c != call_id);
        self.finish(id, result)
    }
}
