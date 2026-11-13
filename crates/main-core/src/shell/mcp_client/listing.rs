//! `apps/shell/src/main/mcp-client/listing.ts`: what a fresh tool list does to
//! a stored server (spec 6.2), and the approvals that clear a review. Pure:
//! each function returns a new server.
//!
//! A stored server (`McpServerConfig`) is a [`JsonValue`] object: it comes
//! from the store file and goes back to it, with every key it holds. The
//! functions read `tools` (an object of entries), `newTools` (an array),
//! `instructions`, `pendingInstructions`, `kind`, `command`, `args` and `env`
//! as the store guarantees them (a missing `tools` or `newTools` reads as
//! empty); a result is the server with the keys the TypeScript spreads over
//! it set, a key that was there keeping its place.

use jscompat::{JsMap, JsObject, JsonValue};

use super::fingerprint::{
    instructions_fingerprint, server_launch_fingerprint, stable_json, tool_fingerprint,
};
use crate::shell::mcp_servers_api::McpPermission;

/// `ListedTool`: one tool as a server lists it
#[derive(Debug, Clone, PartialEq)]
pub struct ListedTool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<JsonValue>,
    pub annotations: Option<JsonValue>,
}

/// `McpListing`
#[derive(Debug, Clone, PartialEq)]
pub struct McpListing {
    pub tools: Vec<ListedTool>,
    /// the server's instructions text, or `None` when it sent none
    pub instructions: Option<String>,
}

/// `ListingChanges`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ListingChanges {
    /// tools whose description or input schema changed: they wait for review
    pub changed_tools: Vec<String>,
    /// tools added with the initial permission
    pub new_tools: Vec<String>,
    /// tools gone from the server, dropped from the list
    pub removed_tools: Vec<String>,
    /// the instructions changed and wait for review
    pub instructions_changed: bool,
}

fn text(value: &str) -> JsonValue {
    JsonValue::String(value.to_owned())
}

fn object_of(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.set(key, value);
    }
    JsonValue::Object(object)
}

/// `{ ...value }` of an object; anything else spreads no key
fn spread(value: Option<&JsonValue>) -> JsObject<JsonValue> {
    match value {
        Some(JsonValue::Object(object)) => object.clone(),
        _ => JsObject::new(),
    }
}

/// `{ ...value, ...changes }`
fn with_keys(value: &JsonValue, changes: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut object = spread(Some(value));
    for (key, change) in changes {
        object.set(key, change);
    }
    JsonValue::Object(object)
}

/// `server.tools` as the object it is
fn tools_of(server: &JsonValue) -> JsObject<JsonValue> {
    spread(server.get("tools").as_deref())
}

fn string_of(value: Option<&JsonValue>) -> Option<&str> {
    match value {
        Some(JsonValue::String(text)) => Some(text),
        _ => None,
    }
}

/// 4.7: a tool the server marks read-only runs without asking; any other asks
pub fn initial_permission(annotations: Option<&JsonValue>) -> McpPermission {
    let read_only = annotations
        .and_then(|a| a.get("readOnlyHint"))
        .is_some_and(|hint| matches!(hint.as_ref(), JsonValue::Bool(true)));
    if read_only {
        McpPermission::Always
    } else {
        McpPermission::Ask
    }
}

/// `definitionOf(tool)`: `{ description, inputSchema, annotations? }`
pub fn definition_of(tool: &ListedTool) -> JsonValue {
    let mut def = JsObject::new();
    def.set(
        "description",
        text(tool.description.as_deref().unwrap_or("")),
    );
    def.set(
        "inputSchema",
        match &tool.input_schema {
            None | Some(JsonValue::Null) => JsonValue::Object(JsObject::new()),
            Some(schema) => schema.clone(),
        },
    );
    if let Some(annotations) = tool.annotations.as_ref().filter(|a| a.truthy()) {
        def.set("annotations", annotations.clone());
    }
    JsonValue::Object(def)
}

/// `toolFingerprint(name, definition)` of a definition object
fn fingerprint_of_definition(name: &str, definition: &JsonValue) -> String {
    let description = definition.get("description");
    tool_fingerprint(
        name,
        string_of(description.as_deref()),
        definition.get("inputSchema").as_deref(),
    )
}

fn fingerprint_of_tool(tool: &ListedTool) -> String {
    fingerprint_of_definition(&tool.name, &definition_of(tool))
}

fn same_definition(a: Option<&JsonValue>, b: &JsonValue) -> bool {
    matches!(a, Some(a) if !matches!(a, JsonValue::Null)) && stable_json(a) == stable_json(Some(b))
}

fn has_text(text: &Option<String>) -> Option<&str> {
    text.as_deref().filter(|t| !t.is_empty())
}

/// Later entries win when a server lists a name twice
fn by_name(tools: &[ListedTool]) -> JsMap<&ListedTool> {
    let mut map = JsMap::new();
    for tool in tools {
        map.set(tool.name.as_str(), tool);
    }
    map
}

fn new_entry(tool: &ListedTool) -> JsonValue {
    object_of(vec![
        (
            "permission",
            text(initial_permission(tool.annotations.as_ref()).as_str()),
        ),
        ("approved", text(&fingerprint_of_tool(tool))),
        ("definition", definition_of(tool)),
        ("pending", JsonValue::Null),
    ])
}

/// The listing seen when the person registers the server (4.6): every tool
/// is approved with its initial permission and the instructions shown there
/// are approved too. Nothing counts as new.
pub fn accept_first_listing(server: &JsonValue, listing: &McpListing) -> JsonValue {
    let mut tools = JsObject::new();
    for tool in by_name(&listing.tools).values() {
        tools.set(tool.name.as_str(), new_entry(tool));
    }
    let instructions = match has_text(&listing.instructions) {
        Some(text_of) => object_of(vec![
            ("approved", text(&instructions_fingerprint(text_of))),
            ("text", text(text_of)),
        ]),
        None => JsonValue::Null,
    };
    with_keys(
        server,
        vec![
            ("tools", JsonValue::Object(tools)),
            ("newTools", JsonValue::Array(Vec::new())),
            ("instructions", instructions),
            ("pendingInstructions", JsonValue::Null),
        ],
    )
}

/// A later listing against what the person approved:
/// - a changed description or input schema puts the new definition in
///   `pending` (the tool leaves every window until approved; its permission
///   is kept for afterwards); a tool that changes back clears its review;
/// - changed or newly appearing instructions go to `pendingInstructions`;
///   instructions that disappear are dropped;
/// - a new tool gets the initial permission and is listed in `newTools`;
/// - a tool gone from the server is dropped.
///
/// Annotations are display hints outside the fingerprint and follow the server.
pub fn apply_listing(server: &JsonValue, listing: &McpListing) -> (JsonValue, ListingChanges) {
    let listed = by_name(&listing.tools);
    let server_tools = tools_of(server);
    let mut changes = ListingChanges {
        removed_tools: server_tools
            .entries()
            .into_iter()
            .map(|(name, _)| name)
            .filter(|name| !listed.has(name))
            .map(str::to_owned)
            .collect(),
        ..ListingChanges::default()
    };

    let mut entries: Vec<(String, JsonValue)> = Vec::new();
    for tool in listed.values() {
        let def = definition_of(tool);
        let stored = server_tools.get(&tool.name).filter(|s| s.truthy());
        let Some(stored) = stored else {
            changes.new_tools.push(tool.name.clone());
            entries.push((tool.name.clone(), new_entry(tool)));
            continue;
        };
        let fingerprint = fingerprint_of_tool(tool);
        if string_of(stored.get("approved").as_deref()) == Some(fingerprint.as_str()) {
            let stored_definition = stored.get("definition");
            let definition = match def.get("annotations") {
                None => {
                    let mut kept = Vec::new();
                    for key in ["description", "inputSchema"] {
                        if let Some(value) = stored_definition.as_deref().and_then(|d| d.get(key)) {
                            kept.push((key, value.into_owned()));
                        }
                    }
                    object_of(kept)
                }
                Some(annotations) => with_keys(
                    stored_definition.as_deref().unwrap_or(&JsonValue::Null),
                    vec![("annotations", annotations.into_owned())],
                ),
            };
            entries.push((
                tool.name.clone(),
                with_keys(
                    stored,
                    vec![("definition", definition), ("pending", JsonValue::Null)],
                ),
            ));
            continue;
        }
        changes.changed_tools.push(tool.name.clone());
        let stored_pending = stored.get("pending");
        let pending = if same_definition(stored_pending.as_deref(), &def) {
            stored_pending.map_or(JsonValue::Null, |p| p.into_owned())
        } else {
            def
        };
        entries.push((
            tool.name.clone(),
            with_keys(stored, vec![("pending", pending)]),
        ));
    }

    let mut instructions: Option<JsonValue> = server.get("instructions").map(|i| i.into_owned());
    let mut pending_instructions = JsonValue::Null;
    match has_text(&listing.instructions) {
        None => instructions = Some(JsonValue::Null),
        Some(listed_text) => {
            let approved = instructions
                .as_ref()
                .filter(|i| i.truthy())
                .map(|i| i.get("approved"));
            let unchanged = matches!(
                approved,
                Some(approved)
                    if string_of(approved.as_deref()) == Some(instructions_fingerprint(listed_text).as_str())
            );
            if !unchanged {
                pending_instructions = text(listed_text);
                changes.instructions_changed = true;
            }
        }
    }

    let kept: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
    let mut new_tools: Vec<String> = Vec::new();
    let previous = server.get("newTools");
    let carried = match previous.as_deref() {
        Some(JsonValue::Array(items)) => items.as_slice(),
        _ => &[],
    };
    for name in carried
        .iter()
        .filter_map(|n| string_of(Some(n)))
        .filter(|n| kept.contains(n))
        .map(str::to_owned)
        .chain(changes.new_tools.iter().cloned())
    {
        if !new_tools.contains(&name) {
            new_tools.push(name);
        }
    }
    let mut tools = JsObject::new();
    for (name, entry) in entries {
        tools.set(name, entry);
    }
    let mut changes_for_server = vec![
        ("tools", JsonValue::Object(tools)),
        (
            "newTools",
            JsonValue::Array(new_tools.into_iter().map(JsonValue::String).collect()),
        ),
    ];
    if let Some(instructions) = instructions {
        changes_for_server.push(("instructions", instructions));
    }
    changes_for_server.push(("pendingInstructions", pending_instructions));
    (with_keys(server, changes_for_server), changes)
}

/// Replace one entry without assigning through a key (a tool may be called `__proto__`)
fn with_entry(tools: &JsObject<JsonValue>, name: &str, entry: JsonValue) -> JsonValue {
    let mut replaced = JsObject::new();
    for (n, tool) in tools.entries() {
        replaced.set(
            n,
            if n == name {
                entry.clone()
            } else {
                tool.clone()
            },
        );
    }
    JsonValue::Object(replaced)
}

/// The person approved a changed tool: its pending definition becomes the approved one
pub fn approve_tool(server: &JsonValue, name: &str) -> JsonValue {
    let tools = tools_of(server);
    let Some(tool) = tools.get(name) else {
        return server.clone();
    };
    let pending = tool.get("pending").map(|p| p.into_owned());
    let Some(pending) = pending.filter(JsonValue::truthy) else {
        return server.clone();
    };
    // `{ ...tool, definition: tool.pending, approved, pending: null }`
    let entry = with_keys(
        tool,
        vec![
            ("definition", pending.clone()),
            ("approved", text(&fingerprint_of_definition(name, &pending))),
            ("pending", JsonValue::Null),
        ],
    );
    with_keys(server, vec![("tools", with_entry(&tools, name, entry))])
}

/// The person approved changed instructions
pub fn approve_instructions(server: &JsonValue) -> JsonValue {
    let pending = server.get("pendingInstructions");
    let Some(JsonValue::String(pending)) = pending.as_deref() else {
        return server.clone();
    };
    with_keys(
        server,
        vec![
            (
                "instructions",
                object_of(vec![
                    ("approved", text(&instructions_fingerprint(pending))),
                    ("text", text(pending)),
                ]),
            ),
            ("pendingInstructions", JsonValue::Null),
        ],
    )
}

/// The person approved the command shown to them: the stored command,
/// arguments and env names, and the resolved plan they saw (`planFingerprint`)
pub fn approve_launch(server: &JsonValue, plan: &str) -> JsonValue {
    if string_of(server.get("kind").as_deref()) != Some("local") {
        return server.clone();
    }
    with_keys(
        server,
        vec![
            ("approvedLaunch", text(&server_launch_fingerprint(server))),
            ("approvedPlan", text(plan)),
        ],
    )
}

/// The person opened this server's tool list: the new-tool notice goes
pub fn mark_tools_seen(server: &JsonValue) -> JsonValue {
    match server.get("newTools").as_deref() {
        Some(JsonValue::Array(items)) if !items.is_empty() => {
            with_keys(server, vec![("newTools", JsonValue::Array(Vec::new()))])
        }
        _ => server.clone(),
    }
}

pub fn set_tool_permission(server: &JsonValue, name: &str, permission: McpPermission) -> JsonValue {
    let tools = tools_of(server);
    let Some(tool) = tools.get(name) else {
        return server.clone();
    };
    let entry = with_keys(tool, vec![("permission", text(permission.as_str()))]);
    with_keys(server, vec![("tools", with_entry(&tools, name, entry))])
}

/// Tools waiting for the person to approve a changed definition
pub fn tools_awaiting_review(server: &JsonValue) -> Vec<String> {
    tools_of(server)
        .entries()
        .into_iter()
        .filter(|(_, tool)| !matches!(tool.get("pending").as_deref(), Some(JsonValue::Null)))
        .map(|(name, _)| name.to_owned())
        .collect()
}
