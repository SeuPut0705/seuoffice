//! Group `b5-mcp`, slice `client_pure`: see tools/main-diff/groups/b5-mcp/client-pure.ts.
//!
//! The pure modules of the user MCP client. Arguments are JSON; a JSON value
//! that stands for `unknown` is a [`JsonValue`] (an argument past the end is
//! `undefined`, `None`). The host resolver of
//! `address.checkResolvedServerAddress` is its second argument, a table
//! `{ host: [addresses] }`: a host that is not a key does not resolve, and each
//! lookup is one log line `resolve <host>`.

use std::cell::RefCell;

use jscompat::{JsObject, JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value};

use super::super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::agent_core::user_mcp_names::{
    APP_MCP_SERVER_NAME, MCP_NAME_SEPARATOR, MCP_SERVER_NAME_MAX, MCP_TOOL_NAME_MAX,
    MCP_TOOL_PREFIX, ServerNameSource, ToolNameProblem, is_mcp_tool_name, is_valid_server_name,
    map_server_tool_names, mcp_tool_name, parse_mcp_tool_name, parse_mcp_tool_name_in,
    reserved_mcp_server_names, sanitize_tool_name, server_name_problem, suggest_server_name,
    suggest_server_name_from, tool_step_label,
};
use crate::packages::agent_core::user_mcp_result::{
    MCP_ERROR_EMPTY, MCP_NO_ANSWER, MCP_RESULT_EMPTY, MCP_RESULT_MAX_CHARS, MCP_RESULT_UNREADABLE,
    McpCallAnswer, ShapedMcpResult, mcp_call_answer_of, shape_mcp_result, shaped_mcp_answer,
};
use crate::packages::i18n::Lang;
use crate::shell::mcp_client::address::{
    AddressCheck, HostResolver, ResolveFailed, check_resolved_server_address, check_server_address,
    plain_http_allowed_ip,
};
use crate::shell::mcp_client::fingerprint::{
    LaunchShape, PlanEnv, PlanShape, fingerprint_of, instructions_fingerprint, launch_fingerprint,
    launch_review_needed, plan_fingerprint, server_launch_fingerprint, stable_json,
    tool_fingerprint,
};
use crate::shell::mcp_client::hub_input::{
    boolean_of, mcp_server_input_of, mcp_server_patch_of, paste_text_of, permission_of_input,
    plan_fingerprint_of, server_id_of, tool_name_of,
};
use crate::shell::mcp_client::hub_strings::{
    MCP_HUB_STRINGS, McpLaunchProblemKey, mcp_hub_text, mcp_launch_problem_text, mcp_sign_in_pages,
};
use crate::shell::mcp_client::limits::MCP_CALL_TIMEOUT_MS;
use crate::shell::mcp_client::listing::{
    ListedTool, McpListing, accept_first_listing, apply_listing, approve_instructions,
    approve_launch, approve_tool, definition_of, initial_permission, mark_tools_seen,
    set_tool_permission, tools_awaiting_review,
};
use crate::shell::mcp_servers_api::{
    MCP_PERMISSIONS, MCP_SERVERS_CHANNELS, MCP_SERVERS_SETTINGS_KEY, McpFailReason, McpPermission,
    McpServerStatusFacts, is_near_address, permission_of, plain_http_reach, server_status_of,
    tool_display_of,
};

fn text(value: &str) -> Value {
    Value::from(value)
}

fn json(value: JsonValue) -> Answer {
    Ok(Some(json_value_to_serde(&value)))
}

fn jv(args: &[Value], i: usize) -> Option<JsonValue> {
    arg(args, i).map(json_value_from_serde)
}

fn num_arg(args: &[Value], i: usize) -> Option<f64> {
    arg(args, i).and_then(Value::as_f64)
}

fn strings_arg(args: &[Value], i: usize) -> Vec<String> {
    arg(args, i)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn opt_text(value: Option<&str>) -> Value {
    value.map_or(Value::Null, Value::from)
}

/// `Lang` of an argument
fn lang_arg(args: &[Value], i: usize) -> Result<Lang, CallError> {
    match str_arg(args, i)? {
        "en" => Ok(Lang::En),
        "ko" => Ok(Lang::Ko),
        other => Err(CallError::plain(format!("no such language: {other}"))),
    }
}

fn permission_arg(args: &[Value], i: usize) -> Result<McpPermission, CallError> {
    match str_arg(args, i)? {
        "always" => Ok(McpPermission::Always),
        "ask" => Ok(McpPermission::Ask),
        "off" => Ok(McpPermission::Off),
        other => Err(CallError::plain(format!("no such permission: {other}"))),
    }
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|v| v.get(key))
}

fn fail_reason(value: Option<&Value>) -> Option<McpFailReason> {
    [
        McpFailReason::Unreachable,
        McpFailReason::HttpError,
        McpFailReason::RuntimeMissing,
        McpFailReason::StartFailed,
        McpFailReason::RefusedRedirect,
        McpFailReason::InsecureAddress,
    ]
    .into_iter()
    .find(|reason| value.and_then(Value::as_str) == Some(reason.as_str()))
}

fn tool_problem(value: Option<&Value>) -> Option<ToolNameProblem> {
    [
        ToolNameProblem::Empty,
        ToolNameProblem::TooLong,
        ToolNameProblem::Collision,
        ToolNameProblem::ServerName,
    ]
    .into_iter()
    .find(|problem| value.and_then(Value::as_str) == Some(problem.as_str()))
}

fn launch_problem(name: &str) -> Result<McpLaunchProblemKey, CallError> {
    [
        McpLaunchProblemKey::NeedsCommandWindow,
        McpLaunchProblemKey::EmptyCommand,
        McpLaunchProblemKey::NotAProgram,
        McpLaunchProblemKey::RuntimeMissing,
        McpLaunchProblemKey::DidNotStart,
    ]
    .into_iter()
    .find(|problem| problem.as_str() == name)
    .ok_or_else(|| CallError::plain(format!("no such problem: {name}")))
}

fn flag(value: Option<&Value>, key: &str) -> bool {
    field(value, key).and_then(Value::as_bool).unwrap_or(false)
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn string_field(value: Option<&Value>, key: &str) -> String {
    field(value, key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// A `ListedTool` of a case
fn listed_tool(value: &Value) -> ListedTool {
    ListedTool {
        name: string_field(Some(value), "name"),
        description: field(Some(value), "description")
            .and_then(Value::as_str)
            .map(str::to_owned),
        input_schema: field(Some(value), "inputSchema").map(json_value_from_serde),
        annotations: field(Some(value), "annotations").map(json_value_from_serde),
    }
}

/// An `McpListing` of a case
fn mcp_listing(value: Option<&Value>) -> McpListing {
    McpListing {
        tools: field(value, "tools")
            .and_then(Value::as_array)
            .map(|tools| tools.iter().map(listed_tool).collect())
            .unwrap_or_default(),
        instructions: field(value, "instructions")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

fn server_arg(args: &[Value]) -> JsonValue {
    jv(args, 0).unwrap_or(JsonValue::Null)
}

fn answer_json(answer: &McpCallAnswer) -> Value {
    match answer {
        McpCallAnswer::Answered { output, is_error } => object(vec![
            ("ok", Value::Bool(true)),
            ("output", text(output)),
            ("isError", Value::Bool(*is_error)),
        ]),
        McpCallAnswer::Failed { error } => {
            object(vec![("ok", Value::Bool(false)), ("error", text(error))])
        }
    }
}

fn shaped_json(shaped: &ShapedMcpResult) -> Value {
    object(vec![
        ("output", text(&shaped.output)),
        ("isError", Value::Bool(shaped.is_error)),
    ])
}

/// The resolver table of a case: each lookup is one log line
struct TableResolver<'a> {
    table: Option<&'a Value>,
    log: RefCell<Vec<Vec<Value>>>,
}

impl HostResolver for TableResolver<'_> {
    fn resolve(&self, host: &str) -> Result<Vec<String>, ResolveFailed> {
        self.log
            .borrow_mut()
            .push(vec![text("resolve"), text(host)]);
        match self.table.and_then(|table| table.get(host)) {
            Some(Value::Array(addresses)) => Ok(addresses
                .iter()
                .filter_map(|a| a.as_str().map(str::to_owned))
                .collect()),
            _ => Err(ResolveFailed(format!("ENOTFOUND {host}"))),
        }
    }
}

fn check_json(check: AddressCheck) -> Answer {
    json(check.to_json())
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- mcp-servers-api ----
        "mcp-servers-api.MCP_PERMISSIONS" => Ok(Some(Value::from(MCP_PERMISSIONS.to_vec()))),
        "mcp-servers-api.permissionOf" => {
            Ok(Some(text(permission_of(jv(args, 0).as_ref()).as_str())))
        }
        "mcp-servers-api.serverStatusOf" => {
            let facts = arg(args, 0);
            let status = server_status_of(&McpServerStatusFacts {
                enabled: flag(facts, "enabled"),
                command_review_needed: flag(facts, "commandReviewNeeded"),
                login_required: flag(facts, "loginRequired"),
                failure: fail_reason(field(facts, "failure")),
                connecting: flag(facts, "connecting"),
                reached: flag(facts, "reached"),
                listed_before: flag(facts, "listedBefore"),
            });
            json(status.to_json())
        }
        "mcp-servers-api.toolDisplayOf" => {
            let pending = field(arg(args, 0), "pending").map(json_value_from_serde);
            let display = tool_display_of(pending.as_ref(), tool_problem(arg(args, 1)));
            json(display.to_json())
        }
        "mcp-servers-api.MCP_SERVERS_SETTINGS_KEY" => Ok(Some(text(MCP_SERVERS_SETTINGS_KEY))),
        "mcp-servers-api.MCP_SERVERS_CHANNELS" => Ok(Some(object(
            MCP_SERVERS_CHANNELS
                .iter()
                .map(|(key, channel)| (*key, text(channel)))
                .collect(),
        ))),
        "mcp-servers-api.plainHttpReach" => str_arg(args, 0)
            .map(|raw| Some(opt_text(plain_http_reach(raw).map(|reach| reach.as_str())))),
        "mcp-servers-api.isNearAddress" => {
            str_arg(args, 0).map(|raw| Some(Value::Bool(is_near_address(raw))))
        }

        // ---- agent-core/user-mcp/names ----
        "agent-core/user-mcp/names.MCP_TOOL_PREFIX" => Ok(Some(text(MCP_TOOL_PREFIX))),
        "agent-core/user-mcp/names.MCP_NAME_SEPARATOR" => Ok(Some(text(MCP_NAME_SEPARATOR))),
        "agent-core/user-mcp/names.MCP_SERVER_NAME_MAX" => {
            Ok(Some(Value::from(MCP_SERVER_NAME_MAX)))
        }
        "agent-core/user-mcp/names.MCP_TOOL_NAME_MAX" => Ok(Some(Value::from(MCP_TOOL_NAME_MAX))),
        "agent-core/user-mcp/names.APP_MCP_SERVER_NAME" => Ok(Some(text(APP_MCP_SERVER_NAME))),
        "agent-core/user-mcp/names.RESERVED_MCP_SERVER_NAMES" => {
            Ok(Some(Value::from(reserved_mcp_server_names())))
        }
        "agent-core/user-mcp/names.serverNameProblem" => str_arg(args, 0).map(|name| {
            let max = num_arg(args, 1).unwrap_or(MCP_SERVER_NAME_MAX);
            Some(opt_text(
                server_name_problem(name, max).map(|problem| problem.as_str()),
            ))
        }),
        "agent-core/user-mcp/names.isValidServerName" => str_arg(args, 0).map(|name| {
            let max = num_arg(args, 1).unwrap_or(MCP_SERVER_NAME_MAX);
            Some(Value::Bool(is_valid_server_name(name, max)))
        }),
        "agent-core/user-mcp/names.suggestServerName" => str_arg(args, 0).map(|raw| {
            let max = num_arg(args, 2).unwrap_or(MCP_SERVER_NAME_MAX);
            Some(text(&suggest_server_name(raw, strings_arg(args, 1), max)))
        }),
        "agent-core/user-mcp/names.suggestServerNameFrom" => str_arg(args, 0).map(|raw| {
            let source = arg(args, 2);
            let source = ServerNameSource {
                url: field(source, "url")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                command: field(source, "command")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                args: field(source, "args").map(|_| string_list(field(source, "args"))),
            };
            Some(text(&suggest_server_name_from(
                raw,
                strings_arg(args, 1),
                &source,
            )))
        }),
        "agent-core/user-mcp/names.toolStepLabel" => {
            str_arg(args, 0).map(|name| Some(text(&tool_step_label(name))))
        }
        "agent-core/user-mcp/names.sanitizeToolName" => {
            str_arg(args, 0).map(|raw| Some(text(&sanitize_tool_name(raw))))
        }
        "agent-core/user-mcp/names.mcpToolName" => (|| {
            Ok(Some(text(&mcp_tool_name(
                str_arg(args, 0)?,
                str_arg(args, 1)?,
            ))))
        })(),
        "agent-core/user-mcp/names.isMcpToolName" => {
            str_arg(args, 0).map(|name| Some(Value::Bool(is_mcp_tool_name(name))))
        }
        "agent-core/user-mcp/names.mapServerToolNames" => str_arg(args, 0).map(|server| {
            let entries = map_server_tool_names(server, &strings_arg(args, 1));
            Some(Value::Array(
                entries
                    .iter()
                    .map(|e| {
                        object(vec![
                            ("original", text(&e.original)),
                            ("name", text(&e.name)),
                            ("changed", Value::Bool(e.changed)),
                            ("problem", opt_text(e.problem.map(|p| p.as_str()))),
                        ])
                    })
                    .collect(),
            ))
        }),
        "agent-core/user-mcp/names.parseMcpToolName" => str_arg(args, 0).map(|name| {
            Some(parse_mcp_tool_name(name).map_or(Value::Null, |parsed| {
                object(vec![
                    ("server", text(&parsed.server)),
                    ("tool", text(&parsed.tool)),
                ])
            }))
        }),
        "agent-core/user-mcp/names.parseMcpToolNameIn" => str_arg(args, 0).map(|name| {
            Some(
                parse_mcp_tool_name_in(name, strings_arg(args, 1)).map_or(Value::Null, |parsed| {
                    object(vec![
                        ("server", text(&parsed.server)),
                        ("tool", text(&parsed.tool)),
                    ])
                }),
            )
        }),

        // ---- agent-core/user-mcp/result ----
        "agent-core/user-mcp/result.MCP_RESULT_MAX_CHARS" => {
            Ok(Some(Value::from(MCP_RESULT_MAX_CHARS)))
        }
        "agent-core/user-mcp/result.MCP_RESULT_UNREADABLE" => Ok(Some(text(MCP_RESULT_UNREADABLE))),
        "agent-core/user-mcp/result.MCP_RESULT_EMPTY" => Ok(Some(text(MCP_RESULT_EMPTY))),
        "agent-core/user-mcp/result.MCP_ERROR_EMPTY" => Ok(Some(text(MCP_ERROR_EMPTY))),
        "agent-core/user-mcp/result.MCP_NO_ANSWER" => Ok(Some(text(MCP_NO_ANSWER))),
        "agent-core/user-mcp/result.shapeMcpResult" => {
            let max = num_arg(args, 1).unwrap_or(MCP_RESULT_MAX_CHARS);
            Ok(Some(shaped_json(&shape_mcp_result(
                jv(args, 0).as_ref(),
                max,
            ))))
        }
        "agent-core/user-mcp/result.shapedMcpAnswer" => {
            let shaped = ShapedMcpResult {
                output: string_field(arg(args, 0), "output"),
                is_error: flag(arg(args, 0), "isError"),
            };
            Ok(Some(answer_json(&shaped_mcp_answer(&shaped))))
        }
        "agent-core/user-mcp/result.mcpCallAnswerOf" => {
            Ok(Some(answer_json(&mcp_call_answer_of(jv(args, 0).as_ref()))))
        }

        // ---- limits ----
        "limits.MCP_CALL_TIMEOUT_MS" => Ok(Some(Value::from(MCP_CALL_TIMEOUT_MS))),

        // ---- fingerprint ----
        "fingerprint.stableJson" => Ok(Some(text(&stable_json(jv(args, 0).as_ref())))),
        "fingerprint.fingerprintOf" => {
            str_arg(args, 0).map(|content| Some(text(&fingerprint_of(content))))
        }
        "fingerprint.toolFingerprint" => str_arg(args, 0).and_then(|tool| {
            let definition = arg(args, 1);
            let description = match field(definition, "description") {
                None | Some(Value::Null) => None,
                Some(Value::String(description)) => Some(description.as_str()),
                Some(_) => return Err(CallError::plain("text.replace is not a function")),
            };
            let schema = field(definition, "inputSchema").map(json_value_from_serde);
            Ok(Some(text(&tool_fingerprint(
                tool,
                description,
                schema.as_ref(),
            ))))
        }),
        "fingerprint.instructionsFingerprint" => {
            str_arg(args, 0).map(|content| Some(text(&instructions_fingerprint(content))))
        }
        "fingerprint.launchFingerprint" => {
            let launch = arg(args, 0);
            Ok(Some(text(&launch_fingerprint(&LaunchShape {
                command: string_field(launch, "command"),
                args: string_list(field(launch, "args")),
                env_names: string_list(field(launch, "envNames")),
            }))))
        }
        "fingerprint.planFingerprint" => {
            let plan = arg(args, 0);
            let env = field(plan, "env")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|e| PlanEnv {
                            name: string_field(Some(e), "name"),
                            origin: string_field(Some(e), "origin"),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(Some(text(&plan_fingerprint(&PlanShape {
                command: string_field(plan, "command"),
                args: string_list(field(plan, "args")),
                env,
            }))))
        }
        "fingerprint.serverLaunchFingerprint" => {
            Ok(Some(text(&server_launch_fingerprint(&server_arg(args)))))
        }
        "fingerprint.launchReviewNeeded" => {
            Ok(Some(Value::Bool(launch_review_needed(&server_arg(args)))))
        }

        // ---- listing ----
        "listing.initialPermission" => Ok(Some(text(
            initial_permission(jv(args, 0).as_ref()).as_str(),
        ))),
        "listing.definitionOf" => json(definition_of(&listed_tool(
            arg(args, 0).unwrap_or(&Value::Null),
        ))),
        "listing.acceptFirstListing" => json(accept_first_listing(
            &server_arg(args),
            &mcp_listing(arg(args, 1)),
        )),
        "listing.applyListing" => {
            let (server, changes) = apply_listing(&server_arg(args), &mcp_listing(arg(args, 1)));
            let names = |names: &[String]| Value::from(names.to_vec());
            Ok(Some(object(vec![
                ("server", json_value_to_serde(&server)),
                (
                    "changes",
                    object(vec![
                        ("changedTools", names(&changes.changed_tools)),
                        ("newTools", names(&changes.new_tools)),
                        ("removedTools", names(&changes.removed_tools)),
                        (
                            "instructionsChanged",
                            Value::Bool(changes.instructions_changed),
                        ),
                    ]),
                ),
            ])))
        }
        "listing.approveTool" => {
            str_arg(args, 1).and_then(|tool| json(approve_tool(&server_arg(args), tool)))
        }
        "listing.approveInstructions" => json(approve_instructions(&server_arg(args))),
        "listing.approveLaunch" => {
            str_arg(args, 1).and_then(|plan| json(approve_launch(&server_arg(args), plan)))
        }
        "listing.markToolsSeen" => json(mark_tools_seen(&server_arg(args))),
        "listing.setToolPermission" => (|| {
            let tool = str_arg(args, 1)?;
            let permission = permission_arg(args, 2)?;
            json(set_tool_permission(&server_arg(args), tool, permission))
        })(),
        "listing.toolsAwaitingReview" => {
            Ok(Some(Value::from(tools_awaiting_review(&server_arg(args)))))
        }

        // ---- hub-input ----
        "hub-input.serverIdOf" => Ok(server_id_of(jv(args, 0).as_ref()).map(Value::from)),
        "hub-input.toolNameOf" => Ok(tool_name_of(jv(args, 0).as_ref()).map(Value::from)),
        "hub-input.pasteTextOf" => Ok(paste_text_of(jv(args, 0).as_ref()).map(Value::from)),
        "hub-input.permissionOfInput" => {
            Ok(permission_of_input(jv(args, 0).as_ref())
                .map(|permission| text(permission.as_str())))
        }
        "hub-input.booleanOf" => Ok(boolean_of(jv(args, 0).as_ref()).map(Value::Bool)),
        "hub-input.planFingerprintOf" => {
            Ok(plan_fingerprint_of(jv(args, 0).as_ref()).map(|fingerprint| text(&fingerprint)))
        }
        "hub-input.mcpServerInputOf" => {
            Ok(mcp_server_input_of(jv(args, 0).as_ref()).map(|input| json_value_to_serde(&input)))
        }
        "hub-input.mcpServerPatchOf" => {
            Ok(mcp_server_patch_of(jv(args, 0).as_ref()).map(|patch| json_value_to_serde(&patch)))
        }

        // ---- hub-strings ----
        "hub-strings.MCP_HUB_STRINGS" => {
            let mut en = JsObject::new();
            let mut ko = JsObject::new();
            for (key, en_text, ko_text) in MCP_HUB_STRINGS {
                en.set(key, JsonValue::String(en_text.to_owned()));
                ko.set(key, JsonValue::String(ko_text.to_owned()));
            }
            let mut dicts = JsObject::new();
            dicts.set("en", JsonValue::Object(en));
            dicts.set("ko", JsonValue::Object(ko));
            json(JsonValue::Object(dicts))
        }
        "hub-strings.mcpHubText" => (|| {
            Ok(Some(text(&mcp_hub_text(
                lang_arg(args, 0)?,
                str_arg(args, 1)?,
            ))))
        })(),
        "hub-strings.mcpSignInPages" => lang_arg(args, 0).map(|lang| {
            let pages = mcp_sign_in_pages(lang);
            let page = |p: &crate::shell::mcp_client::hub_strings::McpSignInPage| {
                object(vec![
                    ("lang", text(&p.lang)),
                    ("title", text(&p.title)),
                    ("body", text(&p.body)),
                ])
            };
            Some(object(vec![
                ("done", page(&pages.done)),
                ("failed", page(&pages.failed)),
            ]))
        }),
        "hub-strings.mcpLaunchProblemText" => (|| {
            let lang = lang_arg(args, 0)?;
            let problem = launch_problem(str_arg(args, 1)?)?;
            Ok(Some(text(&mcp_launch_problem_text(lang, problem))))
        })(),

        // ---- address ----
        "address.plainHttpAllowedIp" => {
            str_arg(args, 0).map(|ip| Some(Value::Bool(plain_http_allowed_ip(ip))))
        }
        "address.checkServerAddress" => {
            str_arg(args, 0).and_then(|raw| check_json(check_server_address(raw)))
        }
        "address.checkResolvedServerAddress" => str_arg(args, 0).and_then(|raw| {
            let resolver = TableResolver {
                table: arg(args, 1),
                log: RefCell::new(Vec::new()),
            };
            let check = check_resolved_server_address(raw, &resolver);
            cx.logs.extend(resolver.log.into_inner());
            check_json(check)
        }),

        _ => return None,
    })
}
