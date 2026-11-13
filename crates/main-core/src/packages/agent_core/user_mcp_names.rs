//! `packages/agent-core/src/user-mcp/names.ts`: names of user MCP servers and
//! of their tools as the AI sees them (user MCP spec 4.2, 6.1):
//! `mcp__<server>__<tool>`.
//!
//! A server name holds no `__` and neither starts nor ends with `_`, so the
//! server part of a tool name is everything between `mcp__` and the next `__`.
//!
//! Lengths are UTF-16 code units. A length limit is an `f64` as in the
//! TypeScript (`maxLength` is a number); callers without one pass
//! [`MCP_SERVER_NAME_MAX`].

use jscompat::{js_regex, replace_first_with, slice_utf16, trim};
use url::Url;

use crate::packages::i18n::OLD_APP_MCP_SERVER_NAMES;

pub const MCP_TOOL_PREFIX: &str = "mcp__";
pub const MCP_NAME_SEPARATOR: &str = "__";

/// Longest server name, a tunable default
pub const MCP_SERVER_NAME_MAX: f64 = 24.0;
/// Longest full tool name the providers accept
pub const MCP_TOOL_NAME_MAX: f64 = 64.0;

/// The app's own MCP server; a user server may not take its name
pub const APP_MCP_SERVER_NAME: &str = "seuoffice-editor";

/// `RESERVED_MCP_SERVER_NAMES` in the order of the set: the app's own, now
/// and before. Compared without case.
pub fn reserved_mcp_server_names() -> Vec<String> {
    let mut names = vec![APP_MCP_SERVER_NAME.to_owned()];
    for old in OLD_APP_MCP_SERVER_NAMES {
        if !names.iter().any(|n| n == old) {
            names.push(old.to_owned());
        }
    }
    names
}

/// `ServerNameProblem`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerNameProblem {
    Empty,
    TooLong,
    BadChar,
    DoubleUnderscore,
    EdgeUnderscore,
    Reserved,
}

impl ServerNameProblem {
    pub fn as_str(self) -> &'static str {
        match self {
            ServerNameProblem::Empty => "empty",
            ServerNameProblem::TooLong => "too-long",
            ServerNameProblem::BadChar => "bad-char",
            ServerNameProblem::DoubleUnderscore => "double-underscore",
            ServerNameProblem::EdgeUnderscore => "edge-underscore",
            ServerNameProblem::Reserved => "reserved",
        }
    }
}

/// `text.length`
fn length(text: &str) -> f64 {
    text.encode_utf16().count() as f64
}

fn is_reserved(name: &str) -> bool {
    let lower = name.to_lowercase();
    reserved_mcp_server_names().iter().any(|n| *n == lower)
}

/// The structural part of the server rule, the one parsing relies on
fn shape_problem(name: &str) -> Option<ServerNameProblem> {
    if name.is_empty() {
        return Some(ServerNameProblem::Empty);
    }
    if !js_regex!(r"^[A-Za-z0-9_-]+$").test(name) {
        return Some(ServerNameProblem::BadChar);
    }
    if name.contains(MCP_NAME_SEPARATOR) {
        return Some(ServerNameProblem::DoubleUnderscore);
    }
    if name.starts_with('_') || name.ends_with('_') {
        return Some(ServerNameProblem::EdgeUnderscore);
    }
    None
}

/// What breaks the server-name rule, or `None` when the name may be registered
pub fn server_name_problem(name: &str, max_length: f64) -> Option<ServerNameProblem> {
    if name.is_empty() {
        return Some(ServerNameProblem::Empty);
    }
    if length(name) > max_length {
        return Some(ServerNameProblem::TooLong);
    }
    shape_problem(name).or_else(|| is_reserved(name).then_some(ServerNameProblem::Reserved))
}

pub fn is_valid_server_name(name: &str, max_length: f64) -> bool {
    server_name_problem(name, max_length).is_none()
}

/// Trim the characters a server name may not start or end with in a suggestion
fn trim_edges(text: &str) -> String {
    js_regex!(r"^[-_]+|[-_]+$", "g").replace_all(text, |_| String::new())
}

/// `raw.replace(/[^A-Za-z0-9_-]+/g, '-')`
fn dash_other_characters(raw: &str) -> String {
    js_regex!(r"[^A-Za-z0-9_-]+", "g").replace_all(raw, |_| "-".to_owned())
}

/// A name that follows the rule, made from a pasted one: other characters
/// become `-`, runs of `_` become one, the edges are trimmed and the length
/// cut. A name already taken (compared without case) or reserved gets `-2`,
/// `-3`, ... Falls back to `server` when nothing usable is left.
pub fn suggest_server_name<I>(raw: &str, taken: I, max_length: f64) -> String
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    let underscored =
        js_regex!(r"_{2,}", "g").replace_all(&dash_other_characters(raw), |_| "_".to_owned());
    let cleaned = trim_edges(&underscored);
    let base = if js_regex!(r"[A-Za-z0-9]").test(&cleaned) {
        cleaned
    } else {
        "server".to_owned()
    };
    let mut used: Vec<String> = Vec::new();
    for t in taken {
        let lower = t.as_ref().to_lowercase();
        if !used.contains(&lower) {
            used.push(lower);
        }
    }
    let fits = |suffix: &str| -> Option<String> {
        let keep = f64::max(1.0, max_length - length(suffix));
        let name = trim_edges(&slice_utf16(&base, 0.0, Some(keep))) + suffix;
        (is_valid_server_name(&name, max_length) && !used.contains(&name.to_lowercase()))
            .then_some(name)
    };
    // one more try than there are taken names always finds a free number when a suffix fits at all
    for n in 1..=used.len() + 2 {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        };
        if let Some(name) = fits(&suffix) {
            return name;
        }
    }
    let rest = trim_edges(&slice_utf16(&base, 0.0, Some(max_length)));
    if rest.is_empty() {
        "server".to_owned()
    } else {
        rest
    }
}

/// `ServerNameSource`: where a server is reached or what it runs, for a name
/// when the given one has no usable letter.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ServerNameSource {
    pub url: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
}

/// Host labels that say nothing about the server
const PLAIN_HOST_LABELS: [&str; 6] = ["www", "mcp", "api", "app", "server", "servers"];
/// Commands that run the package named in their arguments
const PACKAGE_RUNNERS: [&str; 10] = [
    "npx", "bunx", "uvx", "pnpx", "pipx", "uv", "pnpm", "npm", "bun", "yarn",
];
/// Words before the package in `uv run`, `pnpm dlx`, `npm exec`, ...
const RUNNER_WORDS: [&str; 5] = ["run", "dlx", "exec", "x", "tool"];

/// `path.split(/[\\/]/).pop() ?? ''`
fn base_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or("")
}

/// A word for a server from its address: the first telling label of the host name
fn name_from_url(raw: &str) -> String {
    let Ok(url) = Url::parse(trim(raw)) else {
        return String::new();
    };
    let host = url.host_str().unwrap_or("");
    // an address by number says nothing; neither does this PC
    if host.is_empty()
        || host.contains(':')
        || js_regex!(r"^[\d.]+$").test(host)
        || host == "localhost"
    {
        return String::new();
    }
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    let telling = &labels[..labels
        .len()
        .min(usize::max(1, labels.len().saturating_sub(1)))];
    telling
        .iter()
        .find(|label| !PLAIN_HOST_LABELS.contains(&label.to_lowercase().as_str()))
        .map_or_else(String::new, |label| (*label).to_owned())
}

/// A word for a server from what it runs: the package a runner starts, or the script or program
fn name_from_command(command: &str, args: &[String]) -> String {
    let program = replace_first_with(
        js_regex!(r"\.(exe|cmd|bat)$", "i"),
        base_name(trim(command)),
        |_| String::new(),
    )
    .to_lowercase();
    let words: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|a| !trim(a).is_empty() && !a.starts_with('-'))
        .collect();
    let target: &str = if PACKAGE_RUNNERS.contains(&program.as_str()) {
        words
            .iter()
            .find(|w| !RUNNER_WORDS.contains(*w))
            .copied()
            .unwrap_or("")
    } else if js_regex!(r"^(node|python3?|deno)$").test(&program) {
        words.first().copied().unwrap_or("")
    } else {
        &program
    };
    if target.is_empty() {
        return String::new();
    }
    // a scoped package keeps its own part; a version or a path goes
    let word = if target.starts_with('@') {
        target.split('/').nth(1).unwrap_or("")
    } else {
        target
    };
    let versionless = replace_first_with(js_regex!(r"@[^@]*$"), base_name(word), |_| String::new());
    replace_first_with(js_regex!(r"\.[A-Za-z0-9]+$"), &versionless, |_| {
        String::new()
    })
}

/// `suggestServerName`, but a name with no usable letter (a Korean name, for
/// one) is made from the address host (`dict` for `dict.example.com`) or the
/// package or script the command runs, before falling back to `server`.
pub fn suggest_server_name_from<I>(raw: &str, taken: I, source: &ServerNameSource) -> String
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    let cleaned = dash_other_characters(raw);
    if js_regex!(r"[A-Za-z0-9]").test(&cleaned) {
        return suggest_server_name(raw, taken, MCP_SERVER_NAME_MAX);
    }
    let from_url = match source.url.as_deref() {
        Some(url) if !url.is_empty() => name_from_url(url),
        _ => String::new(),
    };
    let derived = if !from_url.is_empty() {
        from_url
    } else {
        match source.command.as_deref() {
            Some(command) if !command.is_empty() => {
                name_from_command(command, source.args.as_deref().unwrap_or(&[]))
            }
            _ => String::new(),
        }
    };
    suggest_server_name(
        if derived.is_empty() {
            "server"
        } else {
            &derived
        },
        taken,
        MCP_SERVER_NAME_MAX,
    )
}

/// A tool step as a person reads it: server, a middle dot (U+00B7), tool for a user MCP tool,
/// other tool names with their underscores and dashes as spaces.
pub fn tool_step_label(name: &str) -> String {
    if let Some(parsed) = parse_mcp_tool_name(name) {
        return format!("{} \u{b7} {}", parsed.server, parsed.tool);
    }
    js_regex!(r"[_-]+", "g").replace_all(name, |_| " ".to_owned())
}

/// The tool part made safe: every character outside [A-Za-z0-9_-] becomes `_`
pub fn sanitize_tool_name(raw: &str) -> String {
    js_regex!(r"[^A-Za-z0-9_-]", "g").replace_all(raw, |_| "_".to_owned())
}

/// `mcp__<server>__<tool>`, the parts used as given
pub fn mcp_tool_name(server: &str, tool: &str) -> String {
    format!("{MCP_TOOL_PREFIX}{server}{MCP_NAME_SEPARATOR}{tool}")
}

/// Whether a tool name belongs to a user MCP server (prefix only; app tools never carry it)
pub fn is_mcp_tool_name(name: &str) -> bool {
    name.starts_with(MCP_TOOL_PREFIX)
}

/// `ToolNameProblem`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolNameProblem {
    Empty,
    TooLong,
    Collision,
    ServerName,
}

impl ToolNameProblem {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolNameProblem::Empty => "empty",
            ToolNameProblem::TooLong => "too-long",
            ToolNameProblem::Collision => "collision",
            ToolNameProblem::ServerName => "server-name",
        }
    }
}

/// `McpToolNameEntry`, the keys in this order
#[derive(Debug, Clone, PartialEq)]
pub struct McpToolNameEntry {
    /// the name the server reported
    pub original: String,
    /// the full name the AI sees
    pub name: String,
    /// the tool part had characters replaced (show the new name to the person)
    pub changed: bool,
    /// why the tool cannot be turned on
    pub problem: Option<ToolNameProblem>,
}

/// The AI-facing names of one server's tools, in the order given. A tool is
/// unusable when its name is empty, when the full name runs past 64
/// characters, or when it maps to the same full name as another tool (both
/// become unusable). With a server name that breaks the structural rule every
/// tool is unusable, since its names could not be split back.
pub fn map_server_tool_names(server: &str, tools: &[String]) -> Vec<McpToolNameEntry> {
    let bad_server = shape_problem(server).is_some();
    let entries: Vec<(String, String, bool)> = tools
        .iter()
        .map(|original| {
            let tool = sanitize_tool_name(original);
            (
                original.clone(),
                mcp_tool_name(server, &tool),
                tool != *original,
            )
        })
        .collect();
    let mut counts: jscompat::JsMap<usize> = jscompat::JsMap::new();
    for (_, name, _) in &entries {
        let seen = counts.get(name).copied().unwrap_or(0);
        counts.set(name.as_str(), seen + 1);
    }
    entries
        .into_iter()
        .map(|(original, name, changed)| {
            let problem = if bad_server {
                Some(ToolNameProblem::ServerName)
            } else if original.is_empty() {
                Some(ToolNameProblem::Empty)
            } else if length(&name) > MCP_TOOL_NAME_MAX {
                Some(ToolNameProblem::TooLong)
            } else if counts.get(&name).copied().unwrap_or(0) > 1 {
                Some(ToolNameProblem::Collision)
            } else {
                None
            };
            McpToolNameEntry {
                original,
                name,
                changed,
                problem,
            }
        })
        .collect()
}

/// `ParsedMcpToolName`
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedMcpToolName {
    pub server: String,
    /// the tool part as the AI sees it (after sanitizing)
    pub tool: String,
}

/// Split a full tool name into server and tool, or `None` when it is not a
/// well-formed user MCP tool name. Structural only: whether the server is
/// registered is `parse_mcp_tool_name_in`'s question.
pub fn parse_mcp_tool_name(name: &str) -> Option<ParsedMcpToolName> {
    if !is_mcp_tool_name(name) || !js_regex!(r"^[A-Za-z0-9_-]{1,64}$").test(name) {
        return None;
    }
    let rest = &name[MCP_TOOL_PREFIX.len()..];
    let cut = rest.find(MCP_NAME_SEPARATOR)?;
    let server = &rest[..cut];
    let tool = &rest[cut + MCP_NAME_SEPARATOR.len()..];
    if tool.is_empty() || shape_problem(server).is_some() {
        return None;
    }
    Some(ParsedMcpToolName {
        server: server.to_owned(),
        tool: tool.to_owned(),
    })
}

/// `parseMcpToolName`, accepted only when the server is one of the registered names
pub fn parse_mcp_tool_name_in<I>(name: &str, servers: I) -> Option<ParsedMcpToolName>
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    let parsed = parse_mcp_tool_name(name)?;
    servers
        .into_iter()
        .any(|s| s.as_ref() == parsed.server)
        .then_some(parsed)
}
