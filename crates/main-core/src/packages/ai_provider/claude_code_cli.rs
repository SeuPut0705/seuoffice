//! `packages/ai-provider/src/claude-code-cli.ts`: the bridge to the Claude
//! Code CLI (protocol `claude-code-cli`).
//!
//! The locally installed, already signed-in CLI answers one model turn. One
//! CLI process serves one turn and then ends: everything the model reads goes
//! over stdin, the command line carries fixed flags, the model name and, for a
//! structured turn, the schema (tool names only). A structured turn runs with
//! the CLI's own `StructuredOutput` tool and nothing else; a plain turn and
//! the model list run with no tool at all.
//!
//! ## Differences from the TypeScript
//!
//! - `ClaudeCodeCliDeps` is a struct. Its `spawn` seam is the runtime itself:
//!   a child is started through `Rt::spawn`, which the host (or the scripted
//!   world) answers. The module state the TypeScript reaches through imports
//!   (the shared child registry, the temporary-folder record) is passed in the
//!   struct, as the contract has it.
//! - A turn's callbacks, tools, messages and tool calls are
//!   [`jscompat::JsonValue`]s, as in the other ports of this package.
//! - `setSubscriptionModelSource(PROVIDER, ...)`, which the TypeScript runs on
//!   import, is [`install`]: the caller runs it once.

use std::cell::{Cell, RefCell};
use std::pin::Pin;
use std::rc::{Rc, Weak};

use jscompat::{
    JsonValue, Radix, js_regex, json_parse, json_stringify, math_round, number_to_string,
    parse_int, replace_first, slice_utf16, to_int32, trim,
};

use super::effort::{CLAUDE_EFFORTS, ai_effort_of, ai_efforts_of};
use super::jsval::{Obj, as_str, coalesce, js_string, length16, object, prop, slice_to, text};
use super::network_error::is_ai_network_error;
use super::protocols_shared::{
    MAX_SSE_LINE_BYTES, StreamCallbacks, is_plain_object, parse_tool_input,
    throw_if_tool_count_over_budget, throw_if_tool_json_over_budget, usage_count,
};
use super::run_error::ai_run_error;
use super::subscription_locate::{
    LocateState, SubscriptionLocateOptions, SubscriptionProgram, resolve_subscription_program,
};
use super::subscription_models::{SubscriptionModelSource, SubscriptionModelsState};
use super::subscription_process::{
    RegistryChoice, SharedChildRegistry, SubscriptionSpawnOptions, kill_process_tree_rt,
    spawn_subscription_program,
};
use super::subscription_temp_dirs::{
    TempDirOptions, TempDirs, create_tracked_temp_dir, remove_tracked_temp_dir,
};
use super::task::{Child, ChildEvent, Id, JsError, Rt, Settle, Signal};
use super::types::AiChatResponse;
use super::watchdog::{StreamWatchdog, create_stream_watchdog};
use crate::packages::mcp_sdk::streamable_http_client::Utf8Stream;

const PROVIDER: &str = "claude-code";
const BUDGET_LABEL: &str = "claude-code-cli";
const DIAGNOSTIC_LIMIT: f64 = 4_000.0;
const TEMP_PREFIX: &str = "seuoffice-claude-code-";
const INITIALIZE_REQUEST_ID: &str = "initialize";
/// How long a CLI may take to leave after its stdin was closed, before its
/// process tree is ended
const EXIT_GRACE_MS: f64 = 5_000.0;

/// Background work a run started per turn has no use for: neither touches the
/// login or the billing path.
const CLAUDE_CODE_RUN_ENV: [(&str, &str); 2] =
    [("DISABLE_AUTOUPDATER", "1"), ("DISABLE_TELEMETRY", "1")];

/// Most images one request may carry (the Anthropic API's limit per request).
/// Older images beyond it are left out, and the caller is told the input was
/// cut.
pub const MAX_CLAUDE_CODE_IMAGES: f64 = 100.0;

/// Cross-layer contracts with the agent loop: a turn that fails with the first
/// mark and delivered nothing is replayed, and a turn that fails with the
/// second and delivered no tool call is replayed once.
const EMPTY_STREAM_MARK: &str = "(empty stream)";
const TOOL_ARGS_DROP_MARK: &str = "while sending tool arguments";

/// The CLI's own tool that `--json-schema` adds.
const STRUCTURED_OUTPUT_TOOL: &str = "StructuredOutput";

const NO_TOOLS_INSTRUCTIONS: &str = "You are the language-model backend embedded in an office application. You have no tools of your own: you cannot read or change files, run commands, browse the web or call any tool, and you must not try.";

fn structured_instructions() -> String {
    format!(
        "You are the language-model backend embedded in an office application. You cannot read or change files, run commands or browse the web yourself, and you must not try. \
The caller supplies the conversation so far and the list of application tools. Give your whole answer by calling {STRUCTURED_OUTPUT_TOOL} exactly once; write nothing outside that call. \
Write the \"text\" property first and put the user-visible prose there. \
Put the application tool calls you request in \"toolCalls\"; each \"inputJson\" must be a JSON-encoded object matching that tool's inputSchema; use only the listed tool names; return an empty \"toolCalls\" array when no tool is needed. \
Never write a tool call into \"text\": a call written as text is never run. \
The application tools are not tools of yours: do not call them directly, request them in \"toolCalls\" of the {STRUCTURED_OUTPUT_TOOL} call. \
The application runs the requested tools itself and reports their results in the next turn."
    )
}

fn plain_instructions() -> String {
    format!("{NO_TOOLS_INSTRUCTIONS} Answer the request directly.")
}

/// The `note` of every tool-result event.
const AFTER_TOOL_RESULTS: &str = "These are the results of the tool calls requested in the event before this one. The application has already run those calls exactly once: do not request them again. \
Continue from the results: request only the further calls that are still needed, or finish with an empty \"toolCalls\" array.";

// ── What the CLI is started with ──

/// `MODEL_NAME.test(value)`: a model alias or id as the CLI takes it; never
/// something that could read as an option
pub fn is_model_name(value: &str) -> bool {
    js_regex!(r"^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$").test(value)
}

/// `claudeCodeCliLaunchArgs(model, outputSchema, effort)`: the whole command
/// line: fixed flags, plus the configured model, the configured effort when it
/// is one of `CLAUDE_EFFORTS` and, for a structured turn, the output schema.
/// The flags are not trusted: the run checks the tool list the CLI reports.
pub fn claude_code_cli_launch_args(
    model: &str,
    output_schema: Option<&JsonValue>,
    effort: Option<&JsonValue>,
) -> Result<Vec<String>, JsError> {
    let name = trim(model);
    if !name.is_empty() && !is_model_name(name) {
        return Err(JsError::error(format!(
            "Invalid Claude Code model name: {}",
            slice_to(name, 80)
        )));
    }
    let level = claude_code_effort(effort);
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--tools",
        "",
        "--restricted",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    if !name.is_empty() {
        args.push("--model".to_owned());
        args.push(name.to_owned());
    }
    if let Some(level) = level {
        args.push("--effort".to_owned());
        args.push(level.to_owned());
    }
    if let Some(schema) = output_schema {
        args.push("--json-schema".to_owned());
        args.push(json_stringify(schema));
    }
    Ok(args)
}

/// `claudeCodeEffort(effort)`: a configured effort as `--effort` takes it, or
/// `None` (the CLI's own default)
pub fn claude_code_effort(effort: Option<&JsonValue>) -> Option<&'static str> {
    let level = ai_effort_of(effort)?;
    CLAUDE_EFFORTS.contains(&level).then_some(level)
}

// ── What goes over stdin ──

/// `ClaudeCodeContentBlock`
#[derive(Debug, Clone, PartialEq)]
pub enum ClaudeCodeContentBlock {
    Text(String),
    /// `{ type: 'image', source: { type: 'base64', media_type, data } }`
    Image {
        media_type: String,
        data: String,
    },
}

impl ClaudeCodeContentBlock {
    pub fn to_json(&self) -> JsonValue {
        match self {
            ClaudeCodeContentBlock::Text(t) => {
                object(vec![("type", text("text")), ("text", text(t.as_str()))])
            }
            ClaudeCodeContentBlock::Image { media_type, data } => object(vec![
                ("type", text("image")),
                (
                    "source",
                    object(vec![
                        ("type", text("base64")),
                        ("media_type", text(media_type.as_str())),
                        ("data", text(data.as_str())),
                    ]),
                ),
            ]),
        }
    }
}

/// `ClaudeCodeInput`: the two stdin lines of a turn
#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeCodeInput {
    /// `initialize.request.systemPrompt`: the first line sets the system
    /// prompt, in place of the CLI's own
    pub system_prompt: Vec<String>,
    /// `user.message.content`: the second line, sent once the first was
    /// accepted, is the turn's input
    pub content: Vec<ClaudeCodeContentBlock>,
    /// images were left out to fit `MAX_CLAUDE_CODE_IMAGES`
    pub truncated: bool,
}

impl ClaudeCodeInput {
    /// `input.initialize`
    pub fn initialize_json(&self) -> JsonValue {
        object(vec![
            ("type", text("control_request")),
            ("request_id", text(INITIALIZE_REQUEST_ID)),
            (
                "request",
                object(vec![
                    ("subtype", text("initialize")),
                    (
                        "systemPrompt",
                        JsonValue::Array(
                            self.system_prompt
                                .iter()
                                .map(|p| text(p.as_str()))
                                .collect(),
                        ),
                    ),
                ]),
            ),
        ])
    }

    /// `input.user`
    pub fn user_json(&self) -> JsonValue {
        object(vec![
            ("type", text("user")),
            (
                "message",
                object(vec![
                    ("role", text("user")),
                    (
                        "content",
                        JsonValue::Array(self.content.iter().map(|b| b.to_json()).collect()),
                    ),
                ]),
            ),
        ])
    }
}

fn name_of(tool: &JsonValue) -> Option<&str> {
    as_str(prop(tool, "name"))
}

/// `claudeCodeOutputSchema(tools)`: the structured turn the model must answer
/// with: prose, and calls to the app's tools by name. It goes on the command
/// line, so it carries the tool names and nothing else of the tools, and a
/// name of any other shape is refused.
pub fn claude_code_output_schema(tools: &[JsonValue]) -> Result<JsonValue, JsError> {
    let tool_name = js_regex!(r"^[A-Za-z0-9_-]{1,64}$");
    for tool in tools {
        let name = name_of(tool).unwrap_or("");
        if !tool_name.test(name) {
            return Err(JsError::error(format!(
                "Invalid tool name for Claude Code: {}",
                slice_to(name, 80)
            )));
        }
    }
    let mut array = Obj::new();
    array.set("type", text("array"));
    if tools.is_empty() {
        array.set("maxItems", JsonValue::Number(0.0));
    }
    let mut name = Obj::new();
    name.set("type", text("string"));
    if !tools.is_empty() {
        name.set(
            "enum",
            JsonValue::Array(
                tools
                    .iter()
                    .map(|t| text(name_of(t).unwrap_or("")))
                    .collect(),
            ),
        );
    }
    array.set(
        "items",
        object(vec![
            ("type", text("object")),
            (
                "properties",
                object(vec![
                    ("name", JsonValue::Object(name)),
                    ("inputJson", object(vec![("type", text("string"))])),
                ]),
            ),
            (
                "required",
                JsonValue::Array(vec![text("name"), text("inputJson")]),
            ),
            ("additionalProperties", JsonValue::Bool(false)),
        ]),
    );
    Ok(object(vec![
        ("type", text("object")),
        (
            "properties",
            object(vec![
                ("text", object(vec![("type", text("string"))])),
                ("toolCalls", JsonValue::Object(array)),
            ]),
        ),
        (
            "required",
            JsonValue::Array(vec![text("text"), text("toolCalls")]),
        ),
        ("additionalProperties", JsonValue::Bool(false)),
    ]))
}

/// `initializeRequest(system, instructions)`'s `systemPrompt`: the parts that
/// are not blank
fn system_prompt_of(system: &str, instructions: &str) -> Vec<String> {
    [system, instructions]
        .into_iter()
        .filter(|part| !trim(part).is_empty())
        .map(str::to_owned)
        .collect()
}

fn set_some(out: &mut Obj, key: &str, value: Option<&JsonValue>) {
    if let Some(value) = value {
        out.set(key, value.clone());
    }
}

/// `buildClaudeCodeInput(system, messages, tools, maxTokens)`: the two stdin
/// lines of a structured turn. The user message is a list of blocks: the tool
/// list and the schema first, then one JSON object per conversation event with
/// a user event's images right after it. A tool-result event carries a note
/// that its calls already ran. A later turn of the same conversation repeats
/// the earlier blocks unchanged and appends to them, so the provider's prompt
/// cache can serve the common prefix.
pub fn build_claude_code_input(
    system: &str,
    messages: &[JsonValue],
    tools: &[JsonValue],
    max_tokens: f64,
) -> Result<ClaudeCodeInput, JsError> {
    let images_of = |message: &JsonValue| -> Vec<JsonValue> {
        match prop(message, "images") {
            Some(JsonValue::Array(items)) => items.clone(),
            _ => Vec::new(),
        }
    };
    let is_role = |message: &JsonValue, role: &str| as_str(prop(message, "role")) == Some(role);
    let image_count: f64 = messages
        .iter()
        .map(|m| {
            if is_role(m, "user") {
                images_of(m).len() as f64
            } else {
                0.0
            }
        })
        .sum();
    // the oldest images go first: the newest are the ones the user is asking about
    let mut to_omit = (image_count - MAX_CLAUDE_CODE_IMAGES).max(0.0);
    let truncated = to_omit > 0.0;
    let app_tools = JsonValue::Array(
        tools
            .iter()
            .map(|tool| {
                let mut entry = Obj::new();
                set_some(&mut entry, "name", prop(tool, "name"));
                set_some(&mut entry, "description", prop(tool, "description"));
                set_some(&mut entry, "inputSchema", prop(tool, "inputSchema"));
                JsonValue::Object(entry)
            })
            .collect(),
    );
    let header = [
        "<app_tools>".to_owned(),
        json_stringify(&app_tools),
        "</app_tools>".to_owned(),
        "<response_schema>".to_owned(),
        json_stringify(&claude_code_output_schema(tools)?),
        "</response_schema>".to_owned(),
        "The content blocks after this one are the conversation so far, in order: one JSON object per event, and the images attached to a user event right after it.".to_owned(),
        format!("Answer the conversation with one {STRUCTURED_OUTPUT_TOOL} call whose input matches response_schema, \"text\" first, and nothing outside it."),
        format!(
            "Keep this one-turn response within roughly {} output tokens.",
            number_to_string(max_tokens)
        ),
    ]
    .join("\n");
    let mut content = vec![ClaudeCodeContentBlock::Text(header)];
    let mut image_index = 0;
    for message in messages {
        if is_role(message, "user") {
            let images = images_of(message);
            let omitted = to_omit.min(images.len() as f64);
            to_omit -= omitted;
            let kept = &images[omitted as usize..];
            let mut entry = Obj::new();
            entry.set("role", text("user"));
            set_some(&mut entry, "text", prop(message, "text"));
            if !kept.is_empty() {
                let names = kept
                    .iter()
                    .map(|_| {
                        image_index += 1;
                        text(format!("image-{image_index}"))
                    })
                    .collect();
                entry.set("attachedImages", JsonValue::Array(names));
            }
            if omitted > 0.0 {
                entry.set("omittedImages", JsonValue::Number(omitted));
            }
            content.push(ClaudeCodeContentBlock::Text(json_stringify(
                &JsonValue::Object(entry),
            )));
            for image in kept {
                content.push(ClaudeCodeContentBlock::Image {
                    media_type: as_str(prop(image, "mime")).unwrap_or_default().to_owned(),
                    data: as_str(prop(image, "base64")).unwrap_or_default().to_owned(),
                });
            }
        } else if is_role(message, "assistant") {
            let mut entry = Obj::new();
            entry.set("role", text("assistant"));
            set_some(&mut entry, "text", prop(message, "text"));
            if let Some(JsonValue::Array(calls)) = prop(message, "toolCalls")
                && !calls.is_empty()
            {
                let calls = calls
                    .iter()
                    .map(|call| {
                        let mut c = Obj::new();
                        set_some(&mut c, "id", prop(call, "id"));
                        set_some(&mut c, "name", prop(call, "name"));
                        set_some(&mut c, "input", prop(call, "input"));
                        JsonValue::Object(c)
                    })
                    .collect();
                entry.set("toolCalls", JsonValue::Array(calls));
            }
            content.push(ClaudeCodeContentBlock::Text(json_stringify(
                &JsonValue::Object(entry),
            )));
        } else {
            // the note last: it is what the model reads last when the turn ends on this event
            let mut entry = Obj::new();
            entry.set("role", text("tool"));
            set_some(&mut entry, "results", prop(message, "results"));
            entry.set("note", text(AFTER_TOOL_RESULTS));
            content.push(ClaudeCodeContentBlock::Text(json_stringify(
                &JsonValue::Object(entry),
            )));
        }
    }
    Ok(ClaudeCodeInput {
        system_prompt: system_prompt_of(system, &structured_instructions()),
        content,
        truncated,
    })
}

// ── Reading the structured turn ──

/// `ClaudeCodeStructureError`: the answer does not follow the response
/// schema; the run hands it to the loop's replay path. `name` stays `Error`,
/// as the subclass does not set it.
pub fn claude_code_structure_error(message: impl Into<String>) -> JsError {
    JsError::new("ClaudeCodeStructureError", message).named("Error")
}

/// What `parseClaudeCodeTurn` throws: a `ClaudeCodeStructureError`, or any
/// other error (a budget).
#[derive(Debug, Clone, PartialEq)]
pub enum ClaudeCodeParseError {
    Structure(String),
    Other(JsError),
}

/// `{ text, toolCalls }`: each tool call an `AgentToolCall`
/// (`{ id, name, input, inputError? }`).
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedTurn {
    pub text: String,
    pub tool_calls: Vec<JsonValue>,
}

/// `parseClaudeCodeTurn(raw, tools, idPrefix)`: parse the model's answer into
/// text and tool calls. A call to a tool that is not in the app's list is
/// never run: it is passed on with an input error, the same way unparseable
/// input is, so the loop reports it back to the model.
pub fn parse_claude_code_turn(
    rt: &Rt,
    raw: &str,
    tools: &[JsonValue],
    id_prefix: &str,
) -> Result<ParsedTurn, ClaudeCodeParseError> {
    let trimmed = replace_first(js_regex!(r"^```(?:json)?\s*", "i"), 0, trim(raw), "");
    let trimmed = replace_first(js_regex!(r"\s*```$"), 0, &trimmed, "");
    let parsed = match json_parse(&trimmed) {
        Ok(value) => value,
        Err(error) => {
            // the object may sit inside a sentence the model added around it
            let start = trimmed.find('{');
            let end = trimmed.rfind('}');
            // No object at all: the model answered in plain prose (seen live: a bare "done" after
            // its tool calls had run). That is an answer without tool calls, not a broken one.
            if start.is_none() && !trimmed.is_empty() {
                return Ok(ParsedTurn {
                    text: trimmed,
                    tool_calls: Vec::new(),
                });
            }
            let inner = match (start, end) {
                (Some(start), Some(end)) if end > start => json_parse(&trimmed[start..=end]).ok(),
                _ => None,
            };
            match inner {
                Some(value) => value,
                None => {
                    return Err(ClaudeCodeParseError::Structure(format!(
                        "the answer is not valid JSON: {}",
                        error.message()
                    )));
                }
            }
        }
    };
    let Some(JsonValue::String(answer_text)) =
        prop(&parsed, "text").filter(|_| is_plain_object(Some(&parsed)))
    else {
        return Err(ClaudeCodeParseError::Structure(
            "the \"text\" field is missing or not a string".to_owned(),
        ));
    };
    let calls: Vec<JsonValue> = match coalesce(prop(&parsed, "toolCalls"), None) {
        None => Vec::new(),
        Some(JsonValue::Array(items)) => items.clone(),
        Some(_) => {
            return Err(ClaudeCodeParseError::Structure(
                "the \"toolCalls\" field is not an array".to_owned(),
            ));
        }
    };
    // the schema is not enforced by the CLI, so the parsed turn is capped here
    throw_if_tool_count_over_budget(calls.len() as f64, BUDGET_LABEL)
        .map_err(ClaudeCodeParseError::Other)?;
    let mut names: Vec<&str> = Vec::new();
    for tool in tools {
        if let Some(name) = name_of(tool)
            && !names.contains(&name)
        {
            names.push(name);
        }
    }
    let mut tool_calls = Vec::new();
    for call in &calls {
        let name = match as_str(prop(call, "name")) {
            Some(name) if is_plain_object(Some(call)) && !name.is_empty() => name,
            _ => {
                return Err(ClaudeCodeParseError::Structure(
                    "a tool call has no name".to_owned(),
                ));
            }
        };
        // ids are the bridge's own: every turn is a fresh CLI session, so the model cannot keep them unique
        let id = format!("{id_prefix}-{}", rt.random_uuid());
        if !names.contains(&name) {
            let name = slice_to(name, 200);
            let list = names.join(", ");
            let mut entry = Obj::new();
            entry.set("id", text(id));
            entry.set("name", text(name.as_str()));
            entry.set("input", JsonValue::Object(Obj::new()));
            entry.set(
                "inputError",
                text(format!(
                    "\"{name}\" is not a tool of this application and was not run. Use only these tools: {}",
                    if list.is_empty() {
                        "(none are available)"
                    } else {
                        list.as_str()
                    }
                )),
            );
            tool_calls.push(JsonValue::Object(entry));
            continue;
        }
        let given = coalesce(prop(call, "inputJson"), prop(call, "input"));
        let input_json = match given {
            Some(JsonValue::String(s)) => s.clone(),
            None => String::new(),
            Some(other) => json_stringify(other),
        };
        throw_if_tool_json_over_budget(length16(&input_json) as f64, BUDGET_LABEL)
            .map_err(ClaudeCodeParseError::Other)?;
        let (input, error) = parse_tool_input(&input_json);
        let mut entry = Obj::new();
        entry.set("id", text(id));
        entry.set("name", text(name));
        entry.set("input", JsonValue::Object(input));
        if let Some(error) = error {
            entry.set("inputError", text(error));
        }
        tool_calls.push(JsonValue::Object(entry));
    }
    Ok(ParsedTurn {
        text: answer_text.clone(),
        tool_calls,
    })
}

const TEXT_OPENING_SEARCH_LIMIT: usize = 256;

fn is_high_surrogate(code: f64) -> bool {
    (55296.0..=56319.0).contains(&code)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanState {
    Opening,
    Text,
    Complete,
    Off,
}

/// `TurnTextScanner`: decodes the `text` string of a structured turn while its
/// JSON is still arriving, so prose reaches the user as it is written. Only an
/// answer that opens with the `text` property is followed; anything else is
/// delivered once the whole answer has been parsed. It walks UTF-16 code
/// units, as the TypeScript does.
#[derive(Debug, Clone)]
pub struct TurnTextScanner {
    pending: Vec<u16>,
    state: ScanState,
}

impl Default for TurnTextScanner {
    fn default() -> Self {
        TurnTextScanner::new()
    }
}

impl TurnTextScanner {
    pub fn new() -> TurnTextScanner {
        TurnTextScanner {
            pending: Vec::new(),
            state: ScanState::Opening,
        }
    }

    /// the answer opened with the `text` property
    pub fn started(&self) -> bool {
        matches!(self.state, ScanState::Text | ScanState::Complete)
    }

    /// the closing quote of `text` was read
    pub fn complete(&self) -> bool {
        self.state == ScanState::Complete
    }

    /// Feed more of the answer; returns the piece of `text` it completes
    pub fn push(&mut self, chunk: &str) -> String {
        if matches!(self.state, ScanState::Complete | ScanState::Off) {
            return String::new();
        }
        let mut raw = std::mem::take(&mut self.pending);
        raw.extend(chunk.encode_utf16());
        if self.state == ScanState::Opening {
            let as_text = String::from_utf16_lossy(&raw);
            let opening =
                js_regex!(r#"^\s*(?:```[A-Za-z]*\s*)?\{\s*"text"\s*:\s*""#).exec(&as_text);
            match opening {
                None => {
                    if raw.len() > TEXT_OPENING_SEARCH_LIMIT {
                        self.state = ScanState::Off;
                    }
                    self.pending = if self.state == ScanState::Off {
                        Vec::new()
                    } else {
                        raw
                    };
                    return String::new();
                }
                Some(found) => {
                    raw.drain(..length16(found.as_str()));
                    self.state = ScanState::Text;
                }
            }
        }
        let mut out: Vec<u16> = Vec::new();
        let mut index = 0;
        while index < raw.len() {
            let unit = raw[index];
            if unit == 0x22 {
                self.state = ScanState::Complete;
                self.pending = Vec::new();
                return String::from_utf16_lossy(&out);
            }
            if unit != 0x5c {
                // half of a character outside the BMP: wait for the other half
                if is_high_surrogate(f64::from(unit)) && index + 1 >= raw.len() {
                    break;
                }
                out.push(unit);
                index += 1;
                continue;
            }
            if index + 1 >= raw.len() {
                break;
            }
            let escape = raw[index + 1];
            if escape != 0x75 {
                out.push(match escape {
                    0x6e => 0x0a,
                    0x74 => 0x09,
                    0x72 => 0x0d,
                    0x62 => 0x08,
                    0x66 => 0x0c,
                    other => other,
                });
                index += 2;
                continue;
            }
            if index + 6 > raw.len() {
                break;
            }
            let code = parse_int(
                &String::from_utf16_lossy(&raw[index + 2..index + 6]),
                Radix::Sixteen,
            );
            if code.is_nan() {
                out.push(0x75);
                index += 2;
                continue;
            }
            if is_high_surrogate(code) {
                let rest = &raw[(index + 6).min(raw.len())..(index + 12).min(raw.len())];
                let escape_start = [0x5c_u16, 0x75];
                // the pair's second escape may still be on its way
                if rest.len() < 6 && escape_start.starts_with(&rest[..rest.len().min(2)]) {
                    break;
                }
                let low = if rest.starts_with(&escape_start) {
                    parse_int(&String::from_utf16_lossy(&rest[2..]), Radix::Sixteen)
                } else {
                    f64::NAN
                };
                if (56320.0..=57343.0).contains(&low) {
                    out.push(to_int32(code) as u16);
                    out.push(to_int32(low) as u16);
                    index += 12;
                    continue;
                }
            }
            out.push(to_int32(code) as u16);
            index += 6;
        }
        self.pending = raw[index..].to_vec();
        String::from_utf16_lossy(&out)
    }
}

// ── Subscription usage ──

const USAGE_WINDOWS: [&str; 2] = ["five_hour", "seven_day"];

fn finite_number(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        Some(JsonValue::Number(x)) if x.is_finite() => Some(*x),
        _ => None,
    }
}

fn usage_entry(
    window: &str,
    utilization: Option<&JsonValue>,
    resets_at: Option<&JsonValue>,
) -> Option<JsonValue> {
    let utilization = finite_number(utilization).filter(|u| *u >= 0.0)?;
    // a window without a real reset time is not a usage value
    let resets_at = finite_number(resets_at).filter(|r| *r > 0.0)?;
    Some(object(vec![
        ("provider", text(PROVIDER)),
        ("window", text(window)),
        // the CLI reports more than 1 when usage runs past a window's cap
        ("utilization", JsonValue::Number(utilization.min(1.0))),
        (
            "resetsAt",
            JsonValue::Number(math_round(resets_at * 1000.0)),
        ),
    ]))
}

/// `claudeCodeUsage(rateLimitInfo)`: the usage windows in the
/// `rate_limit_info` of a `rate_limit_event`: one entry per window (five-hour,
/// seven-day) that has both a utilization and a reset time. The CLI gives
/// reset times in epoch seconds. Without the per-window report, the one
/// limiting window it names is read instead.
pub fn claude_code_usage(rate_limit_info: Option<&JsonValue>) -> Vec<JsonValue> {
    let Some(info) = rate_limit_info.filter(|i| is_plain_object(Some(*i))) else {
        return Vec::new();
    };
    let mut usage = Vec::new();
    if let Some(windows) = prop(info, "unifiedWindows").filter(|w| is_plain_object(Some(*w))) {
        for window in USAGE_WINDOWS {
            let Some(report) = prop(windows, window).filter(|r| is_plain_object(Some(*r))) else {
                continue;
            };
            if let Some(entry) = usage_entry(
                window,
                prop(report, "utilization"),
                prop(report, "resetsAt"),
            ) {
                usage.push(entry);
            }
        }
        return usage;
    }
    let limiting = USAGE_WINDOWS
        .iter()
        .find(|window| as_str(prop(info, "rateLimitType")) == Some(**window));
    if let Some(limiting) = limiting
        && let Some(entry) =
            usage_entry(limiting, prop(info, "utilization"), prop(info, "resetsAt"))
    {
        usage.push(entry);
    }
    usage
}

/// `rejectedUntil(rateLimitInfo)`: when the limit that rejected the run
/// resets, in epoch ms; `None` when the CLI did not say
fn rejected_until(rate_limit_info: Option<&Obj>) -> Option<f64> {
    let info = rate_limit_info?;
    if info.get("status") != Some(&text("rejected")) {
        return None;
    }
    finite_number(info.get("resetsAt"))
        .filter(|r| *r > 0.0)
        .map(|r| math_round(r * 1000.0))
}

// ── Failures ──

/// `reportedFailure(code, status, text, rateLimitInfo)`: the run error for a
/// failure the CLI reported itself. `code` is the `error` field of its
/// synthetic assistant message (`authentication_failed`, `rate_limit`,
/// `overloaded`, `model_not_found`, ...), `status` the `api_error_status` of
/// its result, `text` what it would have printed.
pub fn reported_failure(
    code: Option<&str>,
    status: Option<&JsonValue>,
    message_text: &str,
    rate_limit_info: Option<&Obj>,
) -> JsError {
    let message = match trim(message_text) {
        "" => "Claude Code reported an error",
        trimmed => trimmed,
    };
    let code = code.filter(|c| !c.is_empty());
    let is_status = |n: f64| status == Some(&JsonValue::Number(n));
    if code == Some("authentication_failed") || is_status(401.0) {
        return ai_run_error("signed-out", message, Some(PROVIDER), None);
    }
    if code == Some("rate_limit") || is_status(429.0) {
        let resets_at = rejected_until(rate_limit_info);
        return ai_run_error("rate-limit", message, Some(PROVIDER), resets_at);
    }
    if code == Some("overloaded") || is_status(529.0) || is_status(503.0) {
        return ai_run_error("overloaded", message, None, None);
    }
    if is_ai_network_error(&text(message))
        || js_regex!(r"connection error|unable to connect", "i").test(message)
    {
        return ai_run_error("network", message, None, None);
    }
    if js_regex!(r"timed out|timeout", "i").test(message) {
        return ai_run_error("timeout", message, None, None);
    }
    if (code.is_none() || code == Some("unknown"))
        && js_regex!(
            r"not logged in|please run /login|invalid api key|authentication",
            "i"
        )
        .test(message)
    {
        return ai_run_error("signed-out", message, Some(PROVIDER), None);
    }
    JsError::error(message)
}

/// `exitFailure(code, stderr)`: the run error for a CLI that ended without a
/// result
pub fn exit_failure(code: Option<f64>, stderr: &str) -> JsError {
    let detail = trim(stderr);
    if js_regex!(r"unknown option|unknown argument|unrecognized option", "i").test(detail) {
        return ai_run_error(
            "needs-update",
            "Claude Code is too old for this app: it does not know an option it is started with",
            Some(PROVIDER),
            None,
        );
    }
    // the text itself is not passed on: it can name the account
    if js_regex!(
        r"not logged in|please run /login|invalid api key|authentication",
        "i"
    )
    .test(detail)
    {
        return ai_run_error(
            "signed-out",
            "Claude Code is not signed in",
            Some(PROVIDER),
            None,
        );
    }
    JsError::error(format!(
        "Claude Code exited ({}) before answering{}",
        code.map_or_else(|| "unknown".to_owned(), number_to_string),
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    ))
}

/// `startFailure(error)`
pub fn start_failure(error: &JsError) -> JsError {
    if error.prop("code") == Some(&text("ENOENT")) {
        return ai_run_error(
            "not-installed",
            "Claude Code CLI could not be started",
            Some(PROVIDER),
            None,
        );
    }
    JsError::error(format!(
        "Claude Code could not be run: {}",
        error.message_or_string()
    ))
    .with("cause", error.to_json())
}

/// `cancelledError()`
fn cancelled_error() -> JsError {
    JsError::error("Claude Code request was cancelled").named("AbortError")
}

/// `appendDiagnostic(current, chunk)`: the last `DIAGNOSTIC_LIMIT` characters
fn append_diagnostic(current: &str, chunk: &[u8]) -> String {
    let next = format!("{current}{}", String::from_utf8_lossy(chunk));
    if (length16(&next) as f64) <= DIAGNOSTIC_LIMIT {
        next
    } else {
        slice_utf16(&next, -DIAGNOSTIC_LIMIT, None)
    }
}

// ── One turn ──

/// The program finder's seam: gets the configured path of the CLI
pub type ResolveProgram = Rc<
    dyn Fn(Option<String>) -> Pin<Box<dyn Future<Output = Result<SubscriptionProgram, JsError>>>>,
>;

/// `ClaudeCodeCliDeps`: stand-ins for tests; none of them relaxes what a run
/// requires of the CLI. `shared` and `temp_dirs` are the module state the
/// TypeScript reaches through imports; the caller owns one of each.
#[derive(Clone)]
pub struct ClaudeCodeCliDeps {
    /// where the children of the shared registry are tracked
    pub shared: SharedChildRegistry,
    /// the record of the temporary folders
    pub temp_dirs: TempDirs,
    /// the state of the program finder
    pub locate: LocateState,
    /// finds the CLI; `resolveSubscriptionProgram('claude-code')` when `None`
    pub resolve_program: Option<ResolveProgram>,
    /// where the child is registered for shutdown
    pub registry: RegistryChoice,
    /// environment to sanitise; the app's own when `None`
    pub base_env: Option<Vec<(String, String)>>,
    /// ends the process tree (gets the child's pid); `killProcessTree` with
    /// `force` when `None`
    pub kill_tree: Option<Rc<dyn Fn(Option<f64>)>>,
    pub exit_grace_ms: Option<f64>,
}

impl ClaudeCodeCliDeps {
    pub fn new(
        shared: SharedChildRegistry,
        temp_dirs: TempDirs,
        locate: LocateState,
    ) -> ClaudeCodeCliDeps {
        ClaudeCodeCliDeps {
            shared,
            temp_dirs,
            locate,
            resolve_program: None,
            registry: RegistryChoice::default(),
            base_env: None,
            kill_tree: None,
            exit_grace_ms: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Structured,
    Plain,
}

/// `TurnRequest`
struct TurnRequest {
    mode: Mode,
    input: ClaudeCodeInput,
    tools: Vec<JsonValue>,
}

/// `expectedTools(mode)`
fn expected_tools(mode: Mode) -> &'static [&'static str] {
    match mode {
        Mode::Structured => &[STRUCTURED_OUTPUT_TOOL],
        Mode::Plain => &[],
    }
}

fn is_structured_output_use(block: Option<&JsonValue>) -> bool {
    let Some(block) = block else { return false };
    is_plain_object(Some(block))
        && as_str(prop(block, "type")) == Some("tool_use")
        && as_str(prop(block, "name")) == Some(STRUCTURED_OUTPUT_TOOL)
}

/// `directCallInput(tool, input)`'s answer: `{ inputJson }` or `{ input }`
#[derive(Debug, Clone, PartialEq)]
pub enum DirectCallInput {
    InputJson(String),
    Input(Obj),
}

impl DirectCallInput {
    /// the `{ inputJson }` or `{ input }` object
    pub fn to_json(&self) -> JsonValue {
        match self {
            DirectCallInput::InputJson(s) => object(vec![("inputJson", text(s.as_str()))]),
            DirectCallInput::Input(o) => object(vec![("input", JsonValue::Object(o.clone()))]),
        }
    }
}

/// `directCallInput(tool, input)`: the input of a direct app-tool call, in the
/// shape `parseClaudeCodeTurn` takes. The CLI does not know the tool, so the
/// model guesses the input's shape (seen live): it may wrap the real input as
/// a `toolCalls` item's `"inputJson"` string, or write an array or object
/// field as a JSON string. Both are undone against the tool's schema; numeric
/// strings are left to the loop, which repairs them for every provider.
pub fn direct_call_input(tool: Option<&JsonValue>, input: Option<&JsonValue>) -> DirectCallInput {
    let Some(JsonValue::Object(input)) = input else {
        return DirectCallInput::Input(Obj::new());
    };
    let keys = input.entries();
    if keys.len() == 1
        && keys[0].0 == "inputJson"
        && let JsonValue::String(s) = keys[0].1
    {
        return DirectCallInput::InputJson(s.clone());
    }
    let properties = tool
        .and_then(|t| prop(t, "inputSchema"))
        .and_then(|s| prop(s, "properties"));
    let Some(JsonValue::Object(properties)) = properties else {
        return DirectCallInput::Input(input.clone());
    };
    let mut out = input.clone();
    for (field, schema) in properties.entries() {
        let Some(JsonValue::String(value)) = input.get(field) else {
            continue;
        };
        if !is_plain_object(Some(schema)) {
            continue;
        }
        let declared: Vec<&str> = match prop(schema, "type") {
            Some(JsonValue::Array(items)) => items.iter().filter_map(|t| as_str(Some(t))).collect(),
            Some(JsonValue::String(s)) => vec![s.as_str()],
            _ => Vec::new(),
        };
        if declared.contains(&"string") {
            continue;
        }
        let Ok(parsed) = json_parse(value) else {
            continue;
        };
        let fits = (declared.contains(&"array") && matches!(parsed, JsonValue::Array(_)))
            || (declared.contains(&"object") && matches!(parsed, JsonValue::Object(_)));
        if !fits {
            continue;
        }
        out.set(field, parsed);
    }
    DirectCallInput::Input(out)
}

/// What `readLines` keeps between chunks of a stream
pub struct LineReader {
    decoder: Utf8Stream,
    pending: String,
    pending_bytes: f64,
    stopped: bool,
}

impl Default for LineReader {
    fn default() -> Self {
        LineReader::new()
    }
}

impl LineReader {
    pub fn new() -> LineReader {
        LineReader {
            decoder: Utf8Stream::new(),
            pending: String::new(),
            pending_bytes: 0.0,
            stopped: false,
        }
    }

    /// `flush`: the stream ended or closed
    pub fn flush(&mut self, on_line: &mut dyn FnMut(&str)) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        let tail = format!("{}{}", self.pending, self.decoder.decode(&[], true));
        self.pending = String::new();
        if !trim(&tail).is_empty() {
            on_line(&tail);
        }
    }

    /// the `data` listener
    pub fn data(
        &mut self,
        chunk: &[u8],
        on_line: &mut dyn FnMut(&str),
        on_overflow: &mut dyn FnMut(),
    ) {
        if self.stopped {
            return;
        }
        self.pending.push_str(&self.decoder.decode(chunk, false));
        let joined = std::mem::take(&mut self.pending);
        let mut parts: Vec<&str> = joined.split('\n').collect();
        self.pending = parts.pop().unwrap_or_default().to_owned();
        if parts.is_empty() {
            self.pending_bytes += chunk.len() as f64;
        } else {
            self.pending_bytes = self.pending.len() as f64;
        }
        for part in parts {
            if !trim(part).is_empty() {
                on_line(part);
            }
        }
        if self.pending_bytes > MAX_SSE_LINE_BYTES {
            self.stopped = true;
            self.pending = String::new();
            on_overflow();
        }
    }
}

/// `readLines(stream, onLine, onOverflow)`: split the stdout of `child` into
/// lines, giving up on a line that grows past the cap
pub fn read_lines(
    child: &Child,
    mut on_line: impl FnMut(&str) + 'static,
    mut on_overflow: impl FnMut() + 'static,
) {
    let mut reader = LineReader::new();
    child.on(move |event| match event {
        ChildEvent::Stdout(chunk) => reader.data(chunk, &mut on_line, &mut on_overflow),
        ChildEvent::Close { .. } => reader.flush(&mut on_line),
        _ => {}
    });
}

/// `tokenUsage(usage)`: `{ inputTokens?, outputTokens? }`, or `None`
fn token_usage(usage: Option<&JsonValue>) -> Option<JsonValue> {
    let usage = usage.filter(|u| is_plain_object(Some(*u)))?;
    // the prompt as sent: what was read from and written to the prompt cache counts too
    let input: Vec<Option<f64>> = [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .iter()
    .map(|key| usage_count(prop(usage, key)))
    .collect();
    let output = usage_count(prop(usage, "output_tokens"));
    let mut result = Obj::new();
    if input.iter().any(Option::is_some) {
        let sum = input
            .iter()
            .fold(0.0, |sum, count| sum + count.unwrap_or(0.0));
        result.set("inputTokens", JsonValue::Number(sum));
    }
    if let Some(output) = output {
        result.set("outputTokens", JsonValue::Number(output));
    }
    (!result.is_empty()).then_some(JsonValue::Object(result))
}

/// `textOf(content)`: the text blocks of a message, joined
fn text_of(content: Option<&JsonValue>) -> String {
    let Some(JsonValue::Array(blocks)) = content else {
        return String::new();
    };
    blocks
        .iter()
        .map(|block| {
            if is_plain_object(Some(block)) && as_str(prop(block, "type")) == Some("text") {
                as_str(prop(block, "text")).unwrap_or_default()
            } else {
                ""
            }
        })
        .collect()
}

/// `isToolBlock(block)`: `tool_use`, `server_tool_use`, `mcp_tool_use`, and
/// their results
fn is_tool_block(block: Option<&JsonValue>) -> bool {
    let Some(block) = block else { return false };
    is_plain_object(Some(block))
        && as_str(prop(block, "type")).is_some_and(|t| js_regex!(r"tool_use$|tool_result$").test(t))
}

/// `Array.prototype.join` of one item
fn join_item(item: &JsonValue) -> String {
    match item {
        JsonValue::Null => String::new(),
        JsonValue::Array(items) => items.iter().map(join_item).collect::<Vec<_>>().join(","),
        JsonValue::Object(_) => "[object Object]".to_owned(),
        other => js_string(other),
    }
}

/// `is_error`-less helper: `value === text`
fn is_str(value: Option<&JsonValue>, expected: &str) -> bool {
    as_str(value) == Some(expected)
}

fn index_of_block(event: &Obj) -> Option<f64> {
    match event.get("index") {
        Some(JsonValue::Number(i)) => Some(*i),
        _ => None,
    }
}

fn tool_name_of(block: Option<&JsonValue>) -> String {
    match block.and_then(|b| as_str(prop(b, "name"))) {
        Some(name) if block.is_some_and(|b| is_plain_object(Some(b))) => {
            format!(" ({})", slice_to(name, 80))
        }
        _ => String::new(),
    }
}

/// What one turn keeps while the CLI runs (the `let`s of the promise executor)
#[derive(Default)]
struct TurnState {
    stderr: String,
    /// the CLI accepted the system prompt
    initialized: bool,
    /// the CLI reported its tool list, and the list is exactly what the turn may run with
    verified: bool,
    /// the model's answer as streamed: the text of a plain turn, the StructuredOutput input of a structured one
    raw: String,
    /// the model's answer as carried by whole assistant messages
    whole: String,
    /// stream indexes of the StructuredOutput blocks of the current message
    structured_blocks: Vec<f64>,
    /// ids of the StructuredOutput calls, whose acknowledgement the CLI sends back itself
    structured_ids: Vec<String>,
    app_tool_blocks: Vec<f64>,
    app_tool_ids: Vec<String>,
    /// the answer as the CLI validated it, from its result
    structured_output: Option<JsonValue>,
    /// what was passed to onDelta so far
    emitted: String,
    /// characters of a restarted answer that were already passed on
    skip: usize,
    scanner: TurnTextScanner,
    failure_code: Option<String>,
    failure_text: String,
    rate_limit_info: Option<Obj>,
}

/// One running turn: the promise executor of `runClaudeCodeTurn`
struct Turn {
    rt: Rt,
    cb: StreamCallbacks,
    mode: Mode,
    tools: Vec<JsonValue>,
    input: ClaudeCodeInput,
    child: Child,
    allowed: &'static [&'static str],
    /// A structured turn's model may call an app tool directly instead of
    /// naming it in "toolCalls" (seen live: the editor prompts name the tools).
    /// The CLI has no such tool, so the call cannot run there: `take_direct_calls`
    /// takes it as the turn's request and ends the CLI. Only a call to a tool
    /// of this turn's list is let through, and the only result the CLI may send
    /// for it is its "no such tool" error.
    app_tool_names: Vec<String>,
    kill: Rc<dyn Fn()>,
    grace_ms: f64,
    settle: Settle<Result<(), JsError>>,
    settled: Cell<bool>,
    exited: Rc<Cell<bool>>,
    abort_listener: Cell<Option<Id>>,
    st: RefCell<TurnState>,
}

impl Turn {
    /// `stop(force)`
    fn stop(&self, force: bool) {
        if self.exited.get() {
            return;
        }
        if force {
            (self.kill)();
            return;
        }
        // the CLI leaves by itself once its input ends; it is ended if it does not
        self.child.end_stdin();
        let exited = self.exited.clone();
        let kill = self.kill.clone();
        let timer = self.rt.set_timeout(self.grace_ms, move || {
            if !exited.get() {
                kill();
            }
        });
        let rt = self.rt.clone();
        let mut cleared = false;
        self.child.on(move |event| {
            if matches!(event, ChildEvent::Close { .. }) && !cleared {
                cleared = true;
                rt.clear_timeout(Some(timer));
            }
        });
    }

    /// `finish(error, end)`: `end`: the answer is complete but the CLI would go
    /// on working, so it is ended at once
    fn finish(&self, error: Option<JsError>, end: bool) {
        if self.settled.get() {
            return;
        }
        self.settled.set(true);
        if let Some(listener) = self.abort_listener.take() {
            self.cb.signal.off(listener);
        }
        self.stop(error.is_some() || end);
        self.settle.settle(match error {
            Some(error) => Err(error),
            None => Ok(()),
        });
    }

    fn refuse(&self, reason: &str) {
        self.finish(
            Some(ai_run_error(
                "unsafe-tools",
                format!("{reason}; the run was stopped"),
                None,
                None,
            )),
            false,
        );
    }

    fn require_verified(&self) -> bool {
        let verified = self.st.borrow().verified;
        if !verified {
            self.refuse("Claude Code started answering before it reported its tool list");
        }
        verified
    }

    /// `write(message)`: a CLI that is already gone is reported by the close handler
    fn write(&self, message: &JsonValue) {
        if self.child.stdin_writable() {
            self.child
                .write(format!("{}\n", json_stringify(message)).as_bytes());
        }
    }

    fn deliver(&self, piece: &str) {
        let mut piece = piece.to_owned();
        {
            let mut st = self.st.borrow_mut();
            if st.skip > 0 {
                let repeated = st.skip.min(length16(&piece));
                st.skip -= repeated;
                piece = slice_utf16(&piece, repeated as f64, None);
            }
            if piece.is_empty() {
                return;
            }
            st.emitted.push_str(&piece);
        }
        (self.cb.on_delta)(text(piece));
    }

    fn deliver_rest(&self, answer: &str) {
        let rest = {
            let mut st = self.st.borrow_mut();
            if length16(answer) > length16(&st.emitted) && answer.starts_with(&st.emitted) {
                let rest = slice_utf16(answer, length16(&st.emitted) as f64, None);
                st.emitted = answer.to_owned();
                Some(rest)
            } else {
                None
            }
        };
        if let Some(rest) = rest {
            (self.cb.on_delta)(text(rest));
        }
    }

    fn is_app_tool_use(&self, block: Option<&JsonValue>) -> bool {
        let Some(block) = block else { return false };
        is_plain_object(Some(block))
            && as_str(prop(block, "type")) == Some("tool_use")
            && as_str(prop(block, "name")).is_some_and(|name| {
                name != STRUCTURED_OUTPUT_TOOL && self.app_tool_names.iter().any(|n| n == name)
            })
    }

    /// The run must stop at the first sign of a tool other than the one it may
    /// run with: one of the CLI's own, or one of an MCP server
    fn check_tools(&self, event: &Obj) {
        let Some(JsonValue::Array(listed)) = event.get("tools") else {
            self.refuse("Claude Code did not report its tool list");
            return;
        };
        let exact = listed.len() == self.allowed.len()
            && self
                .allowed
                .iter()
                .all(|name| listed.contains(&text(*name)));
        if !exact {
            let names: Vec<String> = listed
                .iter()
                .filter_map(|name| as_str(Some(name)))
                .take(5)
                .map(|name| slice_to(name, 80))
                .collect();
            self.refuse(&format!(
                "Claude Code started with {} tool(s) available ({}{}) instead of {}",
                listed.len(),
                names.join(", "),
                if listed.len() > names.len() {
                    ", …"
                } else {
                    ""
                },
                if self.allowed.is_empty() {
                    "none".to_owned()
                } else {
                    self.allowed.join(", ")
                }
            ));
            return;
        }
        // a server that is still connecting lists no tool yet
        let attached = match event.get("mcp_servers") {
            Some(JsonValue::Array(servers)) => !servers.is_empty(),
            None | Some(JsonValue::Null) => false,
            Some(_) => true,
        };
        if attached {
            self.refuse("Claude Code started with an MCP server attached");
            return;
        }
        self.st.borrow_mut().verified = true;
    }

    fn on_stream_event(&self, event: &Obj) {
        let kind = as_str(event.get("type"));
        if kind == Some("content_block_start") {
            let block = event.get("content_block");
            if self.mode == Mode::Structured && is_structured_output_use(block) {
                let mut st = self.st.borrow_mut();
                if let Some(index) = index_of_block(event) {
                    st.structured_blocks.push(index);
                }
                if let Some(id) = block.and_then(|b| as_str(prop(b, "id"))) {
                    st.structured_ids.push(id.to_owned());
                }
                return;
            }
            if self.is_app_tool_use(block) {
                let mut st = self.st.borrow_mut();
                if let Some(index) = index_of_block(event) {
                    st.app_tool_blocks.push(index);
                }
                if let Some(id) = block.and_then(|b| as_str(prop(b, "id"))) {
                    st.app_tool_ids.push(id.to_owned());
                }
                return;
            }
            if is_tool_block(block) {
                self.refuse(&format!(
                    "Claude Code started to call a tool{}",
                    tool_name_of(block)
                ));
            }
            return;
        }
        if kind == Some("message_start") {
            let mut st = self.st.borrow_mut();
            st.structured_blocks.clear();
            st.app_tool_blocks.clear();
            // the CLI is sending the answer again (a retried request, or a new try after the
            // CLI rejected a structured answer): skip what was already passed on
            if !st.raw.is_empty() {
                st.raw = String::new();
                st.whole = String::new();
                st.skip = length16(&st.emitted);
                st.scanner = TurnTextScanner::new();
            }
            return;
        }
        let Some(JsonValue::Object(delta)) = event.get("delta") else {
            return;
        };
        if kind != Some("content_block_delta") {
            return;
        }
        let delta_kind = as_str(delta.get("type"));
        if delta_kind == Some("text_delta")
            && let Some(JsonValue::String(chunk)) = delta.get("text")
        {
            // a structured turn answers through StructuredOutput: prose beside the call is not the answer
            if self.mode == Mode::Plain {
                self.st.borrow_mut().raw.push_str(chunk);
                self.deliver(chunk);
            }
        } else if delta_kind == Some("thinking_delta")
            && let Some(JsonValue::String(thinking)) = delta.get("thinking")
        {
            if !thinking.is_empty()
                && let Some(on_reasoning) = &self.cb.on_reasoning_delta
            {
                on_reasoning(text(thinking.as_str()));
            }
        } else if delta_kind == Some("input_json_delta") {
            let index = index_of_block(event);
            // the input of a direct app-tool call is never used: the CLI refuses that call
            if let Some(index) = index
                && self.st.borrow().app_tool_blocks.contains(&index)
            {
                return;
            }
            let partial = match delta.get("partial_json") {
                Some(JsonValue::String(partial)) => Some(partial),
                _ => None,
            };
            let known = index.is_some_and(|i| self.st.borrow().structured_blocks.contains(&i));
            let Some(partial) = partial.filter(|_| known) else {
                self.refuse("Claude Code started to call a tool");
                return;
            };
            let piece = {
                let mut st = self.st.borrow_mut();
                st.raw.push_str(partial);
                st.scanner.push(partial)
            };
            self.deliver(&piece);
        }
    }

    /// Deliver a structured answer; throws what the loop should see when it is not usable
    fn deliver_structured(&self, answer: &str, stop_reason: &str) -> Result<(), JsError> {
        let error = match parse_claude_code_turn(&self.rt, answer, &self.tools, "claude") {
            Ok(turn) => {
                self.deliver_rest(&turn.text);
                for call in turn.tool_calls {
                    (self.cb.on_tool_call)(call);
                }
                return Ok(());
            }
            Err(ClaudeCodeParseError::Other(error)) => return Err(error),
            Err(ClaudeCodeParseError::Structure(message)) => message,
        };
        let cause = claude_code_structure_error(error.as_str()).to_json();
        let mut partial = TurnTextScanner::new();
        let piece = partial.push(answer);
        if stop_reason == "max_tokens" && partial.started() {
            // cut by the output limit: the text so far stands, and a call that was being written
            // goes on as truncated so the loop asks for smaller calls
            self.deliver_rest(&piece);
            if !partial.complete() {
                return Ok(());
            }
            let last = js_regex!(r#""name"\s*:\s*"([^"\\]+)""#, "g")
                .find_iter(answer)
                .last()
                .and_then(|m| m.get(1).map(str::to_owned));
            if let Some(name) = last
                && self
                    .tools
                    .iter()
                    .any(|tool| name_of(tool) == Some(name.as_str()))
            {
                let mut call = Obj::new();
                call.set("id", text(format!("claude-{}", self.rt.random_uuid())));
                call.set("name", text(name));
                call.set("input", JsonValue::Object(Obj::new()));
                call.set("truncated", JsonValue::Bool(true));
                (self.cb.on_tool_call)(JsonValue::Object(call));
                return Ok(());
            }
            return Err(JsError::error(
                "Claude Code reached the output limit before its tool calls were complete. Ask for the output in several smaller parts.",
            )
            .with("cause", cause));
        }
        if !self.st.borrow().emitted.is_empty() {
            return Err(JsError::error(format!(
                "Claude Code returned a structured response that broke off {TOOL_ARGS_DROP_MARK}: {error}"
            ))
            .with("cause", cause));
        }
        Err(JsError::error(format!(
            "Claude Code returned an invalid structured response: {error} {EMPTY_STREAM_MARK}"
        ))
        .with("cause", cause))
    }

    /// The model called app tools directly instead of naming them in
    /// StructuredOutput (seen live, the editor prompts name the tools). The CLI
    /// has no such tool and would answer with an error, which led the model to
    /// report the tool as unusable and give up. The calls are taken as this
    /// turn's requests, checked the same way as "toolCalls", and the CLI is
    /// ended before it answers them.
    fn take_direct_calls(
        &self,
        content: Option<&JsonValue>,
        calls: &[JsonValue],
        message: Option<&JsonValue>,
    ) {
        let tool_calls = calls
            .iter()
            .map(|call| {
                let tool = self
                    .tools
                    .iter()
                    .find(|entry| prop(entry, "name") == prop(call, "name"));
                let mut entry = Obj::new();
                set_some(&mut entry, "name", prop(call, "name"));
                if let JsonValue::Object(rest) =
                    direct_call_input(tool, prop(call, "input")).to_json()
                {
                    for (key, value) in rest.entries() {
                        entry.set(key, value.clone());
                    }
                }
                JsonValue::Object(entry)
            })
            .collect();
        let turn = object(vec![
            ("text", text(trim(&text_of(content)))),
            ("toolCalls", JsonValue::Array(tool_calls)),
        ]);
        if let Err(error) = self.deliver_structured(&json_stringify(&turn), "tool_use") {
            self.finish(Some(error), false);
            return;
        }
        let usage = token_usage(message.and_then(|m| prop(m, "usage")));
        if let (Some(usage), Some(on_usage)) = (usage, &self.cb.on_usage) {
            on_usage(usage);
        }
        self.finish(None, true);
    }

    fn on_result(&self, event: &Obj) {
        let result_text = as_str(event.get("result")).unwrap_or_default();
        if event.get("is_error") == Some(&JsonValue::Bool(true))
            || !is_str(event.get("subtype"), "success")
        {
            let errors = match event.get("errors") {
                Some(JsonValue::Array(items)) => {
                    items.iter().map(join_item).collect::<Vec<_>>().join("; ")
                }
                _ => String::new(),
            };
            let (code, failure_text, info) = {
                let st = self.st.borrow();
                (
                    st.failure_code.clone(),
                    st.failure_text.clone(),
                    st.rate_limit_info.clone(),
                )
            };
            let shown = [result_text, failure_text.as_str(), errors.as_str()]
                .into_iter()
                .find(|part| !part.is_empty())
                .unwrap_or("");
            self.finish(
                Some(reported_failure(
                    code.as_deref(),
                    event.get("api_error_status"),
                    shown,
                    info.as_ref(),
                )),
                false,
            );
            return;
        }
        if !self.require_verified() {
            return;
        }
        let mut stop_reason = as_str(event.get("stop_reason"))
            .unwrap_or_default()
            .to_owned();
        // the result text of a structured turn may be prose the model wrote beside the call: never the answer
        let streamed = {
            let st = self.st.borrow();
            if !st.raw.is_empty() {
                st.raw.clone()
            } else {
                st.whole.clone()
            }
        };
        let mut answer = if streamed.is_empty() {
            result_text.to_owned()
        } else {
            streamed.clone()
        };
        if self.mode == Mode::Structured {
            let mut st = self.st.borrow_mut();
            if let Some(output @ JsonValue::Object(_)) = event.get("structured_output") {
                st.structured_output = Some(output.clone());
            }
            answer = match &st.structured_output {
                Some(output) => json_stringify(output),
                None => streamed,
            };
            // the turn ended on the CLI's own tool, which the CLI answered; for the loop it is a finished turn
            if stop_reason == "tool_use" && st.structured_output.is_some() {
                stop_reason = "end_turn".to_owned();
            }
        }
        let delivered = if self.mode == Mode::Plain {
            self.deliver_rest(&answer);
            Ok(())
        } else {
            self.deliver_structured(&answer, &stop_reason)
        };
        if let Err(error) = delivered {
            self.finish(Some(error), false);
            return;
        }
        if !stop_reason.is_empty()
            && let Some(on_stop) = &self.cb.on_stop_reason
        {
            on_stop(text(stop_reason.as_str()));
        }
        if let (Some(usage), Some(on_usage)) = (token_usage(event.get("usage")), &self.cb.on_usage)
        {
            on_usage(usage);
        }
        self.finish(None, false);
    }

    fn on_line(&self, line: &str) {
        if self.settled.get() {
            return;
        }
        if let Some(on_activity) = &self.cb.on_activity {
            on_activity();
        }
        let Ok(JsonValue::Object(event)) = json_parse(line) else {
            return;
        };
        match as_str(event.get("type")) {
            Some("control_response") => {
                let response = event.get("response");
                let Some(response) = response.filter(|r| is_plain_object(Some(*r))) else {
                    return;
                };
                if !is_str(prop(response, "request_id"), INITIALIZE_REQUEST_ID) {
                    return;
                }
                if self.st.borrow().initialized {
                    return;
                }
                if !is_str(prop(response, "subtype"), "success") {
                    self.finish(
                        Some(ai_run_error(
                            "needs-update",
                            "Claude Code did not accept the setup request of this app; it may be too old",
                            Some(PROVIDER),
                            None,
                        )),
                        false,
                    );
                    return;
                }
                // only now does the conversation leave the app: the system prompt is in place
                self.st.borrow_mut().initialized = true;
                self.write(&self.input.user_json());
            }
            Some("control_request") => {
                let subtype = event
                    .get("request")
                    .filter(|r| is_plain_object(Some(*r)))
                    .and_then(|r| prop(r, "subtype"));
                if is_str(subtype, "can_use_tool") {
                    self.refuse("Claude Code asked for permission to use a tool");
                    return;
                }
                // no hook and no MCP server is registered, so nothing is expected; answer instead of
                // leaving the CLI waiting
                let mut response = Obj::new();
                response.set("subtype", text("error"));
                set_some(&mut response, "request_id", event.get("request_id"));
                response.set(
                    "error",
                    text(format!(
                        "Unsupported request: {}",
                        subtype.map_or_else(|| "undefined".to_owned(), js_string)
                    )),
                );
                self.write(&object(vec![
                    ("type", text("control_response")),
                    ("response", JsonValue::Object(response)),
                ]));
            }
            Some("system") => {
                if is_str(event.get("subtype"), "init") {
                    self.check_tools(&event);
                }
            }
            Some("rate_limit_event") => {
                let Some(JsonValue::Object(info)) = event.get("rate_limit_info") else {
                    return;
                };
                self.st.borrow_mut().rate_limit_info = Some(info.clone());
                let usage = claude_code_usage(Some(&JsonValue::Object(info.clone())));
                if !usage.is_empty()
                    && let Some(on_subscription_usage) = &self.cb.on_subscription_usage
                {
                    on_subscription_usage(JsonValue::Array(usage));
                }
            }
            Some("stream_event") => {
                if self.require_verified()
                    && let Some(JsonValue::Object(inner)) = event.get("event")
                {
                    self.on_stream_event(inner);
                }
            }
            Some("assistant") => self.on_assistant(&event),
            Some("user") => {
                let content = event
                    .get("message")
                    .filter(|m| is_plain_object(Some(*m)))
                    .and_then(|m| prop(m, "content"));
                // the only tool results a run may see: the CLI's own acknowledgement of a StructuredOutput
                // call, and its error for a direct call to an app tool it does not have
                let expected = |block: &JsonValue| -> bool {
                    if self.mode != Mode::Structured
                        || !is_plain_object(Some(block))
                        || !is_str(prop(block, "type"), "tool_result")
                    {
                        return false;
                    }
                    let Some(id) = as_str(prop(block, "tool_use_id")) else {
                        return false;
                    };
                    let st = self.st.borrow();
                    st.structured_ids.iter().any(|i| i == id)
                        || (st.app_tool_ids.iter().any(|i| i == id)
                            && prop(block, "is_error") == Some(&JsonValue::Bool(true)))
                };
                let ran_tool = match content {
                    Some(JsonValue::Array(blocks)) => blocks
                        .iter()
                        .any(|block| is_tool_block(Some(block)) && !expected(block)),
                    _ => false,
                };
                if ran_tool {
                    self.refuse("Claude Code ran a tool");
                }
            }
            Some("result") => self.on_result(&event),
            _ => {}
        }
    }

    fn on_assistant(&self, event: &Obj) {
        let message = event.get("message");
        let content = message
            .filter(|m| is_plain_object(Some(*m)))
            .and_then(|m| prop(m, "content"));
        if let Some(JsonValue::String(code)) = event.get("error") {
            // the CLI's own report of a failed request; the result that follows ends the run
            let mut st = self.st.borrow_mut();
            st.failure_code = Some(code.clone());
            st.failure_text = text_of(content);
            return;
        }
        if !self.require_verified() {
            return;
        }
        let blocks: &[JsonValue] = match content {
            Some(JsonValue::Array(blocks)) => blocks,
            _ => &[],
        };
        let mut direct: Vec<JsonValue> = Vec::new();
        let mut answered = false;
        for block in blocks {
            if self.mode == Mode::Structured && is_structured_output_use(Some(block)) {
                answered = true;
                let mut st = self.st.borrow_mut();
                if let Some(id) = as_str(prop(block, "id")) {
                    st.structured_ids.push(id.to_owned());
                }
                if let Some(input @ JsonValue::Object(_)) = prop(block, "input") {
                    st.whole = json_stringify(input);
                }
            } else if self.is_app_tool_use(Some(block)) {
                if let Some(id) = as_str(prop(block, "id")) {
                    self.st.borrow_mut().app_tool_ids.push(id.to_owned());
                }
                direct.push(block.clone());
            } else if is_tool_block(Some(block)) {
                self.refuse(&format!(
                    "Claude Code called a tool{}",
                    tool_name_of(Some(block))
                ));
                return;
            }
        }
        if self.mode == Mode::Plain {
            self.st.borrow_mut().whole.push_str(&text_of(content));
        }
        if !direct.is_empty() && !answered {
            self.take_direct_calls(content, &direct, message);
        }
    }
}

/// `config.cliPath`
fn cli_path_of(config: &JsonValue) -> Option<String> {
    as_str(prop(config, "cliPath")).map(str::to_owned)
}

/// The finder of the CLI: the seam, or `resolveSubscriptionProgram`
async fn resolve_program(
    rt: &Rt,
    deps: &ClaudeCodeCliDeps,
    cli_path: Option<String>,
) -> Result<SubscriptionProgram, JsError> {
    match &deps.resolve_program {
        Some(resolve) => resolve(cli_path).await,
        None => {
            resolve_subscription_program(
                rt,
                &deps.locate,
                PROVIDER,
                &SubscriptionLocateOptions {
                    configured_path: cli_path,
                    ..SubscriptionLocateOptions::default()
                },
            )
            .await
        }
    }
}

fn run_env() -> Vec<(String, String)> {
    CLAUDE_CODE_RUN_ENV
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

/// `void removeTrackedTempDir(cwd)`
fn remove_cwd_of(rt: &Rt, deps: &ClaudeCodeCliDeps, cwd: &str) -> Rc<dyn Fn()> {
    let rt = rt.clone();
    let temp_dirs = deps.temp_dirs.clone();
    let cwd = cwd.to_owned();
    Rc::new(move || {
        let rt = rt.clone();
        let temp_dirs = temp_dirs.clone();
        let cwd = cwd.clone();
        let task_rt = rt.clone();
        task_rt.spawn_local(async move {
            remove_tracked_temp_dir(&rt, &temp_dirs, &cwd, &TempDirOptions::default()).await;
        });
    })
}

/// `killTree` of a run: the seam, or `killProcessTree(child, { force: true })`
fn kill_of(rt: &Rt, deps: &ClaudeCodeCliDeps, child: &Child) -> Rc<dyn Fn()> {
    let pid = child.pid();
    match &deps.kill_tree {
        Some(kill) => {
            let kill = kill.clone();
            Rc::new(move || kill(pid))
        }
        None => {
            let rt = rt.clone();
            Rc::new(move || kill_process_tree_rt(&rt, pid, true))
        }
    }
}

/// `runClaudeCodeTurn(config, request, cb, deps)`
async fn run_claude_code_turn(
    rt: &Rt,
    config: &JsonValue,
    request: TurnRequest,
    cb: &StreamCallbacks,
    deps: &ClaudeCodeCliDeps,
) -> Result<(), JsError> {
    if cb.signal.aborted() {
        return Err(cancelled_error());
    }
    let TurnRequest { mode, input, tools } = request;
    let schema = match mode {
        Mode::Structured => Some(claude_code_output_schema(&tools)?),
        Mode::Plain => None,
    };
    let args = claude_code_cli_launch_args(
        as_str(prop(config, "model")).unwrap_or_default(),
        schema.as_ref(),
        prop(config, "effort"),
    )?;
    let program = resolve_program(rt, deps, cli_path_of(config)).await?;
    if cb.signal.aborted() {
        return Err(cancelled_error());
    }
    if input.truncated
        && let Some(on_input_truncated) = &cb.on_input_truncated
    {
        on_input_truncated();
    }

    // an empty directory of the run's own: no project file of some other directory applies
    let cwd = create_tracked_temp_dir(rt, &deps.temp_dirs, TEMP_PREFIX, &TempDirOptions::default())
        .await?;
    let remove_cwd = remove_cwd_of(rt, deps, &cwd);
    let spawned = if cb.signal.aborted() {
        Err(cancelled_error())
    } else {
        spawn_subscription_program(
            rt,
            &deps.shared,
            &program,
            &args,
            &SubscriptionSpawnOptions {
                cwd: Some(cwd.clone()),
                base_env: deps.base_env.clone(),
                env: run_env(),
                registry: deps.registry.clone(),
                ..SubscriptionSpawnOptions::default()
            },
        )
        .await
    };
    let child = match spawned {
        Ok(child) => child,
        Err(error) => {
            remove_cwd();
            return Err(if error.name == "AbortError" {
                error
            } else {
                start_failure(&error)
            });
        }
    };

    let (settle, wait) = rt.deferred::<Result<(), JsError>>();
    let app_tool_names = match mode {
        Mode::Structured => tools
            .iter()
            .filter_map(|tool| name_of(tool).map(str::to_owned))
            .collect(),
        Mode::Plain => Vec::new(),
    };
    let turn = Rc::new(Turn {
        rt: rt.clone(),
        cb: cb.clone(),
        mode,
        tools,
        input,
        kill: kill_of(rt, deps, &child),
        child,
        allowed: expected_tools(mode),
        app_tool_names,
        grace_ms: deps.exit_grace_ms.unwrap_or(EXIT_GRACE_MS),
        settle,
        settled: Cell::new(false),
        exited: Rc::new(Cell::new(false)),
        abort_listener: Cell::new(None),
        st: RefCell::new(TurnState::default()),
    });

    let weak = Rc::downgrade(&turn);
    turn.child.on({
        let weak = weak.clone();
        move |event| {
            if let (ChildEvent::Stderr(chunk), Some(turn)) = (event, weak.upgrade()) {
                let mut st = turn.st.borrow_mut();
                st.stderr = append_diagnostic(&st.stderr, chunk);
            }
        }
    });
    read_lines(
        &turn.child,
        {
            let weak = weak.clone();
            move |line| {
                if let Some(turn) = weak.upgrade() {
                    turn.on_line(line);
                }
            }
        },
        {
            let weak = weak.clone();
            move || {
                if let Some(turn) = weak.upgrade() {
                    turn.finish(
                        Some(JsError::error(format!(
                            "Claude Code wrote a line of more than {} bytes without a newline; it was stopped",
                            number_to_string(MAX_SSE_LINE_BYTES)
                        ))),
                        false,
                    );
                }
            }
        },
    );
    turn.child.on({
        let weak = weak.clone();
        let remove_cwd = remove_cwd.clone();
        let mut seen = false;
        move |event| {
            if let ChildEvent::Error(error) = event
                && !seen
                && let Some(turn) = weak.upgrade()
            {
                seen = true;
                // without a pid the program never started, and no close event follows
                if turn.child.pid().is_none() {
                    turn.exited.set(true);
                    remove_cwd();
                }
                turn.finish(Some(start_failure(error)), false);
            }
        }
    });
    turn.child.on({
        let weak = weak.clone();
        let mut seen = false;
        move |event| {
            if let ChildEvent::Close { code, .. } = event
                && !seen
                && let Some(turn) = weak.upgrade()
            {
                seen = true;
                turn.exited.set(true);
                remove_cwd();
                let (failure_code, failure_text, info, stderr) = {
                    let st = turn.st.borrow();
                    (
                        st.failure_code.clone(),
                        st.failure_text.clone(),
                        st.rate_limit_info.clone(),
                        st.stderr.clone(),
                    )
                };
                turn.finish(
                    Some(match failure_code.filter(|c| !c.is_empty()) {
                        Some(code) => {
                            reported_failure(Some(&code), None, &failure_text, info.as_ref())
                        }
                        None => exit_failure(*code, &stderr),
                    }),
                    false,
                );
            }
        }
    });
    let listener = cb.signal.on_abort({
        let weak = weak.clone();
        move |_| {
            if let Some(turn) = weak.upgrade() {
                turn.finish(Some(cancelled_error()), false);
            }
        }
    });
    turn.abort_listener.set(Some(listener));
    turn.write(&turn.input.initialize_json());
    wait.await
}

// ── Entry points ──

/// `streamClaudeCodeCli(config, system, messages, tools, maxTokens, cb, deps)`:
/// one streamed turn of the agent loop: text deltas, then the tool calls the
/// model requests
#[allow(clippy::too_many_arguments)]
pub async fn stream_claude_code_cli(
    rt: &Rt,
    config: &JsonValue,
    system: &str,
    messages: &[JsonValue],
    tools: &[JsonValue],
    max_tokens: f64,
    cb: &StreamCallbacks,
    deps: &ClaudeCodeCliDeps,
) -> Result<(), JsError> {
    let wd = create_stream_watchdog(rt, Some(&cb.signal), None, None);
    let touch = wd.clone();
    let on_activity = cb.on_activity.clone();
    let guarded = StreamCallbacks {
        signal: wd.signal.clone(),
        on_activity: Some(Rc::new(move || {
            touch.touch();
            if let Some(on_activity) = &on_activity {
                on_activity();
            }
        })),
        ..cb.clone()
    };
    wd.guard(async {
        let input = build_claude_code_input(system, messages, tools, max_tokens)?;
        run_claude_code_turn(
            rt,
            config,
            TurnRequest {
                mode: Mode::Structured,
                input,
                tools: tools.to_vec(),
            },
            &guarded,
            deps,
        )
        .await
    })
    .await
}

/// `chatClaudeCodeCli(wd, config, system, user, deps)`: one-shot text chat:
/// the answer is the model's text as it is, with no structure around it.
/// Answers an `AiChatResponse`.
pub async fn chat_claude_code_cli(
    rt: &Rt,
    wd: &StreamWatchdog,
    config: &JsonValue,
    system: &str,
    user: &str,
    deps: &ClaudeCodeCliDeps,
) -> Result<AiChatResponse, JsError> {
    let content = Rc::new(RefCell::new(String::new()));
    let touch = wd.clone();
    let collected = content.clone();
    let cb = StreamCallbacks {
        signal: wd.signal.clone(),
        on_delta: Rc::new(move |piece: JsonValue| {
            collected.borrow_mut().push_str(&js_string(&piece))
        }),
        on_tool_call: Rc::new(|_: JsonValue| {}),
        on_reasoning_delta: None,
        on_stop_reason: None,
        on_usage: None,
        on_subscription_usage: None,
        on_input_truncated: None,
        on_activity: Some(Rc::new(move || touch.touch())),
        session_id: None,
    };
    run_claude_code_turn(
        rt,
        config,
        TurnRequest {
            mode: Mode::Plain,
            input: ClaudeCodeInput {
                system_prompt: system_prompt_of(system, &plain_instructions()),
                content: vec![ClaudeCodeContentBlock::Text(user.to_owned())],
                truncated: false,
            },
            tools: Vec::new(),
        },
        &cb,
        deps,
    )
    .await?;
    let content = content.borrow().clone();
    Ok(if content.is_empty() {
        AiChatResponse::failed("Claude Code returned no content")
    } else {
        AiChatResponse::succeeded(JsonValue::String(content))
    })
}

// ── The model list ──

/// How long the CLI is given to answer the setup request with its model list
const MODEL_LIST_TIMEOUT_MS: f64 = 15_000.0;

/// The entry of the CLI's list that stands for its own default, which an empty
/// selection runs
const DEFAULT_MODEL_VALUE: &str = "default";

/// `claudeCodeModels(initialized)`: the models named in the CLI's answer to the
/// setup request: `{ value, displayName, resolvedModel, supportedEffortLevels }`
/// each. `value` is what `--model` takes, so an entry whose value could not be
/// passed there is left out, and so are levels `--effort` does not take. Only
/// the `models` field is read; the answer also names the account, which is not
/// touched. Each model is an `AiSubscriptionModel`.
pub fn claude_code_models(initialized: Option<&JsonValue>) -> Vec<JsonValue> {
    let listed = initialized
        .filter(|i| is_plain_object(Some(*i)))
        .and_then(|i| prop(i, "models"));
    let Some(JsonValue::Array(listed)) = listed else {
        return Vec::new();
    };
    let mut models: Vec<JsonValue> = Vec::new();
    for entry in listed {
        let Some(value) = as_str(prop(entry, "value")).filter(|_| is_plain_object(Some(entry)))
        else {
            continue;
        };
        let value = trim(value);
        if !is_model_name(value) {
            continue;
        }
        let is_default = value == DEFAULT_MODEL_VALUE;
        let id = if is_default { "" } else { value };
        if models
            .iter()
            .any(|model| as_str(prop(model, "id")) == Some(id))
        {
            continue;
        }
        let resolved = as_str(prop(entry, "resolvedModel"))
            .map(trim)
            .filter(|r| is_model_name(r));
        // the default is listed only when the CLI says what it runs on
        if is_default && resolved.is_none() {
            continue;
        }
        let name = as_str(prop(entry, "displayName")).map(trim).unwrap_or("");
        let efforts: Option<Vec<&str>> =
            if prop(entry, "supportsEffort") == Some(&JsonValue::Bool(false)) {
                None
            } else {
                ai_efforts_of(prop(entry, "supportedEffortLevels")).map(|levels| {
                    levels
                        .into_iter()
                        .filter(|level| CLAUDE_EFFORTS.contains(level))
                        .collect()
                })
            };
        let mut model = Obj::new();
        model.set("id", text(id));
        model.set("label", text(if name.is_empty() { value } else { name }));
        if let Some(resolved) = resolved {
            model.set("resolved", text(resolved));
        }
        if is_default {
            model.set("isDefault", JsonValue::Bool(true));
        }
        if let Some(efforts) = efforts.filter(|e| !e.is_empty()) {
            model.set(
                "efforts",
                JsonValue::Array(efforts.into_iter().map(text).collect()),
            );
        }
        models.push(JsonValue::Object(model));
    }
    models
}

/// `ClaudeCodeModelsRequest`
pub struct ClaudeCodeModelsRequest {
    /// the user's own path to the CLI, when one is configured
    pub cli_path: Option<String>,
    /// the caller gave up: the process tree is ended and the reading rejects
    pub signal: Signal,
    pub timeout_ms: Option<f64>,
}

/// One model-list reading: the promise executor of `listClaudeCodeModels`
struct ModelList {
    rt: Rt,
    signal: Signal,
    child: Child,
    kill: Rc<dyn Fn()>,
    grace_ms: f64,
    settle: Settle<Result<Vec<JsonValue>, JsError>>,
    settled: Cell<bool>,
    exited: Rc<Cell<bool>>,
    timer: Cell<Option<Id>>,
    abort_listener: Cell<Option<Id>>,
}

impl ModelList {
    fn finish(&self, models: Option<Vec<JsonValue>>, error: Option<JsError>) {
        if self.settled.get() {
            return;
        }
        self.settled.set(true);
        self.rt.clear_timeout(self.timer.get());
        if let Some(listener) = self.abort_listener.take() {
            self.signal.off(listener);
        }
        if !self.exited.get() {
            if error.is_some() {
                (self.kill)();
            } else {
                // the CLI leaves by itself once its input ends; it is ended if it does not
                self.child.end_stdin();
                let exited = self.exited.clone();
                let kill = self.kill.clone();
                let grace = self.rt.set_timeout(self.grace_ms, move || {
                    if !exited.get() {
                        kill();
                    }
                });
                let rt = self.rt.clone();
                let mut cleared = false;
                self.child.on(move |event| {
                    if matches!(event, ChildEvent::Close { .. }) && !cleared {
                        cleared = true;
                        rt.clear_timeout(Some(grace));
                    }
                });
            }
        }
        self.settle.settle(match error {
            Some(error) => Err(error),
            None => Ok(models.unwrap_or_default()),
        });
    }

    fn on_line(&self, line: &str) {
        if self.settled.get() {
            return;
        }
        let Ok(JsonValue::Object(event)) = json_parse(line) else {
            return;
        };
        let kind = as_str(event.get("type"));
        if kind == Some("control_response") {
            let Some(response) = event.get("response").filter(|r| is_plain_object(Some(*r))) else {
                return;
            };
            if !is_str(prop(response, "request_id"), INITIALIZE_REQUEST_ID) {
                return;
            }
            // a CLI that does not accept the request has no list to give
            self.finish(
                Some(if is_str(prop(response, "subtype"), "success") {
                    claude_code_models(prop(response, "response"))
                } else {
                    Vec::new()
                }),
                None,
            );
            return;
        }
        // Nothing was asked of a model, so there is nothing to answer, run or permit. A CLI that
        // asks for something or produces output is not doing what it was started for.
        if matches!(
            kind,
            Some("control_request" | "stream_event" | "assistant" | "user" | "result")
        ) {
            self.finish(
                None,
                Some(JsError::error(
                    "Claude Code did more than list its models; it was stopped",
                )),
            );
        }
    }
}

/// `listClaudeCodeModels(request, deps)`: ask the CLI which models it offers,
/// without asking a model anything. The CLI is started exactly as for a turn
/// (the same flags, an empty directory of its own, the sanitised environment),
/// is sent the setup request and nothing else, and is told to leave as soon as
/// it answered. No user message is ever written, so no request reaches the
/// model and no usage is spent.
///
/// Resolves with the list, empty when the CLI names none or does not accept
/// the request (an older CLI). Rejects when the CLI cannot be started, does not
/// answer in time, or does anything other than answer; its process tree is
/// ended in each of those cases, and the CLI's own output is not repeated.
pub async fn list_claude_code_models(
    rt: &Rt,
    request: &ClaudeCodeModelsRequest,
    deps: &ClaudeCodeCliDeps,
) -> Result<Vec<JsonValue>, JsError> {
    let signal = request.signal.clone();
    if signal.aborted() {
        return Err(cancelled_error());
    }
    let args = claude_code_cli_launch_args("", None, None)?;
    let program = resolve_program(rt, deps, request.cli_path.clone()).await?;
    if signal.aborted() {
        return Err(cancelled_error());
    }

    let cwd = create_tracked_temp_dir(rt, &deps.temp_dirs, TEMP_PREFIX, &TempDirOptions::default())
        .await?;
    let remove_cwd = remove_cwd_of(rt, deps, &cwd);
    let spawned = if signal.aborted() {
        Err(cancelled_error())
    } else {
        spawn_subscription_program(
            rt,
            &deps.shared,
            &program,
            &args,
            &SubscriptionSpawnOptions {
                cwd: Some(cwd.clone()),
                base_env: deps.base_env.clone(),
                env: run_env(),
                registry: deps.registry.clone(),
                ..SubscriptionSpawnOptions::default()
            },
        )
        .await
    };
    let child = match spawned {
        Ok(child) => child,
        Err(error) => {
            remove_cwd();
            return Err(if error.name == "AbortError" {
                error
            } else {
                start_failure(&error)
            });
        }
    };

    let (settle, wait) = rt.deferred::<Result<Vec<JsonValue>, JsError>>();
    let list = Rc::new(ModelList {
        rt: rt.clone(),
        signal: signal.clone(),
        kill: kill_of(rt, deps, &child),
        child,
        grace_ms: deps.exit_grace_ms.unwrap_or(EXIT_GRACE_MS),
        settle,
        settled: Cell::new(false),
        exited: Rc::new(Cell::new(false)),
        timer: Cell::new(None),
        abort_listener: Cell::new(None),
    });
    let weak: Weak<ModelList> = Rc::downgrade(&list);
    let timer = rt.set_timeout(request.timeout_ms.unwrap_or(MODEL_LIST_TIMEOUT_MS), {
        let weak = weak.clone();
        move || {
            if let Some(list) = weak.upgrade() {
                list.finish(
                    None,
                    Some(JsError::error(
                        "Claude Code did not list its models in time",
                    )),
                );
            }
        }
    });
    list.timer.set(Some(timer));

    read_lines(
        &list.child,
        {
            let weak = weak.clone();
            move |line| {
                if let Some(list) = weak.upgrade() {
                    list.on_line(line);
                }
            }
        },
        {
            let weak = weak.clone();
            move || {
                if let Some(list) = weak.upgrade() {
                    list.finish(
                        None,
                        Some(JsError::error(
                            "Claude Code wrote an endless line; it was stopped",
                        )),
                    );
                }
            }
        },
    );
    list.child.on({
        let weak = weak.clone();
        let remove_cwd = remove_cwd.clone();
        let mut seen = false;
        move |event| {
            if let ChildEvent::Error(error) = event
                && !seen
                && let Some(list) = weak.upgrade()
            {
                seen = true;
                // without a pid the program never started, and no close event follows
                if list.child.pid().is_none() {
                    list.exited.set(true);
                    remove_cwd();
                }
                list.finish(None, Some(start_failure(error)));
            }
        }
    });
    list.child.on({
        let weak = weak.clone();
        let mut seen = false;
        move |event| {
            if let ChildEvent::Close { .. } = event
                && !seen
                && let Some(list) = weak.upgrade()
            {
                seen = true;
                list.exited.set(true);
                remove_cwd();
                list.finish(
                    None,
                    Some(JsError::error(
                        "Claude Code exited before it listed its models",
                    )),
                );
            }
        }
    });
    let listener = signal.on_abort({
        let weak = weak.clone();
        move |_| {
            if let Some(list) = weak.upgrade() {
                list.finish(None, Some(cancelled_error()));
            }
        }
    });
    list.abort_listener.set(Some(listener));
    if list.child.stdin_writable() {
        let initialize = ClaudeCodeInput {
            system_prompt: system_prompt_of(NO_TOOLS_INSTRUCTIONS, ""),
            content: Vec::new(),
            truncated: false,
        }
        .initialize_json();
        list.child
            .write(format!("{}\n", json_stringify(&initialize)).as_bytes());
    }
    wait.await
}

/// `setSubscriptionModelSource(PROVIDER, ...)`, which the TypeScript runs on
/// import: the status check reads the list through this bridge, as it reads
/// Codex's through that one. The caller runs it once, with the runtime handle
/// and the deps the source will use.
pub fn install(models: &mut SubscriptionModelsState, rt: &Rt, deps: &ClaudeCodeCliDeps) {
    let rt = rt.clone();
    let deps = deps.clone();
    let source: SubscriptionModelSource = Rc::new(move |configured_path, signal| {
        let rt = rt.clone();
        let deps = deps.clone();
        Box::pin(async move {
            list_claude_code_models(
                &rt,
                &ClaudeCodeModelsRequest {
                    cli_path: configured_path,
                    signal,
                    timeout_ms: None,
                },
                &deps,
            )
            .await
        })
    });
    models.set_subscription_model_source(PROVIDER, Some(source));
}
