//! `packages/agent-core/src/skill-mcp-refs.ts`: the MCP servers a skill
//! expects, and the note that goes after a skill's text on its way to the
//! model (spec 8).

use jscompat::{JsonValue, js_regex};

/// Goes after every skill's text on both ways it reaches the model (`use_skill`
/// and the skills the person chose), and into the agent window's instruction.
pub const SKILL_SKIPPED_STEPS_SENTENCE: &str = "If any step of this skill cannot be done here (running scripts, a tool that is missing or failed), say in your answer which step you could not do. Do not write as if that step was done.";

/// The line naming a server the skill expects that cannot be used now
pub fn mcp_server_unusable_line(server: &str) -> String {
    format!("This skill expects tools from MCP server {server}, which cannot be used right now.")
}

fn add_once(into: &mut Vec<String>, server: &str) {
    if !server.is_empty() && !into.iter().any(|known| known == server) {
        into.push(server.to_owned());
    }
}

/// The servers of the `mcp__<server>__<tool>` names in a text, once each, in order
pub fn mcp_servers_in_text(text: &str) -> Vec<String> {
    // `mcp__<server>__<tool>` anywhere in a text; the server stops at the first `__`
    let tool_in_text = js_regex!(
        r"(?<![A-Za-z0-9_])mcp__([A-Za-z0-9][A-Za-z0-9_.-]*?)__[A-Za-z0-9*][\w.*-]*",
        "g"
    );
    let mut out: Vec<String> = Vec::new();
    for found in tool_in_text.find_iter(text) {
        add_once(&mut out, found.get(1).unwrap_or(""));
    }
    out
}

/// The servers named by a front matter `allowed-tools` value: a YAML list, or
/// one string with the names separated by commas or spaces (a string value is
/// a list of one).
pub fn mcp_servers_in_allowed_tools(value: Option<&[String]>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let text = value.join(" ");
    // one `allowed-tools` entry: a tool, or a server alone (all its tools)
    let allowed_entry =
        js_regex!(r"^mcp__([A-Za-z0-9][A-Za-z0-9_.-]*?)(?:__[A-Za-z0-9*][\w.*-]*)?$");
    let quotes = js_regex!(r#"^["']+|["']+$"#, "g");
    let mut out: Vec<String> = Vec::new();
    for raw in js_regex!(r"[\s,]+").split(&text) {
        let entry = quotes.replace_all(raw, |_| String::new());
        if let Some(found) = allowed_entry.exec(&entry) {
            add_once(&mut out, found.get(1).unwrap_or(""));
        }
    }
    out
}

/// Every MCP server a skill refers to: its front matter first, then its body
pub fn mcp_servers_of_skill(body: &str, allowed_tools: Option<&[String]>) -> Vec<String> {
    let mut out = mcp_servers_in_allowed_tools(allowed_tools);
    for server in mcp_servers_in_text(body) {
        add_once(&mut out, &server);
    }
    out
}

/// What `isUsable` does when it throws
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UsableThrew;

/// `isUsable` of `unusableMcpServers`
pub type IsUsable<'a> = &'a dyn Fn(&str) -> Result<bool, UsableThrew>;

/// The servers that cannot be used now. Without `isUsable` (no server list is
/// known), and when it throws, a server counts as not usable.
pub fn unusable_mcp_servers(servers: &[String], is_usable: Option<IsUsable<'_>>) -> Vec<String> {
    servers
        .iter()
        .filter(|server| match is_usable {
            None => true,
            Some(usable) => match usable(server) {
                Ok(usable) => !usable,
                Err(UsableThrew) => true,
            },
        })
        .cloned()
        .collect()
}

/// What follows a skill's text: a line per referenced server that cannot be
/// used now, then the sentence every skill gets.
pub fn skill_steps_note(servers: &[String], is_usable: Option<IsUsable<'_>>) -> String {
    let mut lines: Vec<String> = unusable_mcp_servers(servers, is_usable)
        .iter()
        .map(|server| mcp_server_unusable_line(server))
        .collect();
    lines.push(SKILL_SKIPPED_STEPS_SENTENCE.to_owned());
    lines.join("\n")
}

/// A bridge answer's server list: non-empty strings, once each
pub fn mcp_server_list_of(value: Option<&JsonValue>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(JsonValue::Array(items)) = value {
        for server in items.iter().filter_map(|item| match item {
            JsonValue::String(server) => Some(server),
            _ => None,
        }) {
            add_once(&mut out, server);
        }
    }
    out
}
