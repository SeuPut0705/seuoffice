//! `packages/electron-utils/src/mcp-tools-channels.ts`.

use jscompat::{JsObject, JsonValue};

/// `MCP_TOOLS_BRIDGE_KEY`
pub const MCP_TOOLS_BRIDGE_KEY: &str = "aiOfficeMcpTools";

/// `MCP_TOOLS_CHANNELS`, as (key, channel) in the order the object has them.
pub const MCP_TOOLS_CHANNELS: [(&str, &str); 6] = [
    ("list", "mcp-tools:list"),
    ("call", "mcp-tools:call"),
    ("cancel", "mcp-tools:cancel"),
    ("retry", "mcp-tools:retry"),
    ("openSettings", "mcp-tools:open-settings"),
    ("changed", "mcp-tools:changed"),
];

const NAME_MAX: usize = 256;
const CALL_ID_MAX: usize = 200;

/// `McpToolCallRequest`
#[derive(Debug, Clone, PartialEq)]
pub struct McpToolCallRequest {
    pub server: String,
    pub tool: String,
    pub input: JsObject<JsonValue>,
    pub call_id: String,
}

impl McpToolCallRequest {
    /// The object the TypeScript builds: `{ server, tool, input, callId }`.
    pub fn to_json(&self) -> JsonValue {
        let mut object = JsObject::new();
        object.set("server", JsonValue::String(self.server.clone()));
        object.set("tool", JsonValue::String(self.tool.clone()));
        object.set("input", JsonValue::Object(self.input.clone()));
        object.set("callId", JsonValue::String(self.call_id.clone()));
        JsonValue::Object(object)
    }
}

/// `shortText(value, max)`: a string of 1..=max UTF-16 units
fn short_text(value: Option<&JsonValue>, max: usize) -> Option<&str> {
    match value {
        Some(JsonValue::String(s)) if !s.is_empty() && s.encode_utf16().count() <= max => Some(s),
        _ => None,
    }
}

/// `mcpServerNameOf(value)`
pub fn mcp_server_name_of(value: Option<&JsonValue>) -> Option<String> {
    short_text(value, NAME_MAX).map(str::to_owned)
}

/// `mcpCallIdOf(value)`
pub fn mcp_call_id_of(value: Option<&JsonValue>) -> Option<String> {
    short_text(value, CALL_ID_MAX).map(str::to_owned)
}

/// `mcpToolCallRequestOf(raw)`
pub fn mcp_tool_call_request_of(raw: Option<&JsonValue>) -> Option<McpToolCallRequest> {
    let Some(JsonValue::Object(raw)) = raw else {
        return None;
    };
    let server = mcp_server_name_of(raw.get("server"));
    let tool = short_text(raw.get("tool"), NAME_MAX);
    let call_id = mcp_call_id_of(raw.get("callId"));
    let input = match raw.get("input") {
        None => Some(JsObject::new()),
        Some(JsonValue::Object(input)) => Some(input.clone()),
        Some(_) => None,
    };
    Some(McpToolCallRequest {
        server: server?,
        tool: tool?.to_owned(),
        input: input?,
        call_id: call_id?,
    })
}
