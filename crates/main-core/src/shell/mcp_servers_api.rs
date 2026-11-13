//! `apps/shell/src/shared/mcp-servers-api.ts`: user MCP servers between the
//! shell's main process and its screens (user MCP spec 12). The value sets,
//! the status the card shows and the address judgments of the form.
//!
//! The interfaces of the TypeScript (`McpToolEntry`, `McpServerRecordView`,
//! `McpServerInput`, the settings results, ...) describe JSON that the other
//! modules keep as [`JsonValue`]; only what the TypeScript builds with a
//! fixed literal shape is a type here.

use jscompat::{JsObject, JsonValue, Radix, js_regex, parse_int, to_int32, to_number, trim};
use url::Url;

use crate::packages::agent_core::user_mcp_names::ToolNameProblem;

/// How a tool may run (12.2)
pub const MCP_PERMISSIONS: [&str; 3] = ["always", "ask", "off"];

/// `McpPermission`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpPermission {
    Always,
    Ask,
    Off,
}

impl McpPermission {
    pub fn as_str(self) -> &'static str {
        match self {
            McpPermission::Always => "always",
            McpPermission::Ask => "ask",
            McpPermission::Off => "off",
        }
    }
}

/// A stored or pasted permission; anything unknown reads as `ask`
pub fn permission_of(value: Option<&JsonValue>) -> McpPermission {
    match value {
        Some(JsonValue::String(text)) if text == "always" => McpPermission::Always,
        Some(JsonValue::String(text)) if text == "off" => McpPermission::Off,
        _ => McpPermission::Ask,
    }
}

/// `McpServerKind`: `remote` is reached by address; `local` is a program the
/// app starts on this PC
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpServerKind {
    Remote,
    Local,
}

impl McpServerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            McpServerKind::Remote => "remote",
            McpServerKind::Local => "local",
        }
    }
}

/// `McpTransport`: `auto` is Streamable HTTP, then SSE; `sse` is SSE only
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpTransport {
    Auto,
    Sse,
}

impl McpTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            McpTransport::Auto => "auto",
            McpTransport::Sse => "sse",
        }
    }
}

/// `McpFailReason`: why a server could not be reached or started (12.2)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpFailReason {
    Unreachable,
    HttpError,
    RuntimeMissing,
    StartFailed,
    RefusedRedirect,
    InsecureAddress,
}

impl McpFailReason {
    pub fn as_str(self) -> &'static str {
        match self {
            McpFailReason::Unreachable => "unreachable",
            McpFailReason::HttpError => "http-error",
            McpFailReason::RuntimeMissing => "runtime-missing",
            McpFailReason::StartFailed => "start-failed",
            McpFailReason::RefusedRedirect => "refused-redirect",
            McpFailReason::InsecureAddress => "insecure-address",
        }
    }
}

/// `McpServerStatusInfo`: the one status a server card shows (12.2)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpServerStatusInfo {
    Connected,
    Ready,
    Unchecked,
    Connecting,
    Failed(McpFailReason),
    LoginRequired,
    /// `{ status: 'review-required', what: 'command' }`
    ReviewRequiredCommand,
    Disabled,
}

impl McpServerStatusInfo {
    /// The object the TypeScript returns
    pub fn to_json(self) -> JsonValue {
        let mut object = JsObject::new();
        let status = |s: &str| JsonValue::String(s.to_owned());
        match self {
            McpServerStatusInfo::Connected => object.set("status", status("connected")),
            McpServerStatusInfo::Ready => object.set("status", status("ready")),
            McpServerStatusInfo::Unchecked => object.set("status", status("unchecked")),
            McpServerStatusInfo::Connecting => object.set("status", status("connecting")),
            McpServerStatusInfo::Failed(reason) => {
                object.set("status", status("failed"));
                object.set("reason", status(reason.as_str()));
            }
            McpServerStatusInfo::LoginRequired => object.set("status", status("login-required")),
            McpServerStatusInfo::ReviewRequiredCommand => {
                object.set("status", status("review-required"));
                object.set("what", status("command"));
            }
            McpServerStatusInfo::Disabled => object.set("status", status("disabled")),
        }
        JsonValue::Object(object)
    }
}

/// `McpServerStatusFacts`: what is true of a server right now
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct McpServerStatusFacts {
    pub enabled: bool,
    /// a local server whose command, arguments or env names changed since approval
    pub command_review_needed: bool,
    /// the server asked for a login that has not happened or whose refresh failed
    pub login_required: bool,
    /// the last connection attempt failed
    pub failure: Option<McpFailReason>,
    pub connecting: bool,
    /// a tool list was read from it, or a call went through, in this run of the app
    pub reached: bool,
    /// approved tools or guide are stored from an earlier listing
    pub listed_before: bool,
}

/// The single status shown when several apply: disabled > review-required
/// (command) > login-required > failed > connecting > unchecked > ready >
/// connected. Tool and instruction reviews are shown apart from the server
/// status.
pub fn server_status_of(facts: &McpServerStatusFacts) -> McpServerStatusInfo {
    if !facts.enabled {
        return McpServerStatusInfo::Disabled;
    }
    if facts.command_review_needed {
        return McpServerStatusInfo::ReviewRequiredCommand;
    }
    if facts.login_required {
        return McpServerStatusInfo::LoginRequired;
    }
    if let Some(reason) = facts.failure {
        return McpServerStatusInfo::Failed(reason);
    }
    if facts.connecting {
        return McpServerStatusInfo::Connecting;
    }
    if facts.reached {
        return McpServerStatusInfo::Connected;
    }
    if facts.listed_before {
        McpServerStatusInfo::Ready
    } else {
        McpServerStatusInfo::Unchecked
    }
}

/// `McpToolDisplay`: how one tool row shows
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpToolDisplay {
    Ok,
    Review,
    Unusable(ToolNameProblem),
}

impl McpToolDisplay {
    /// The object the TypeScript returns
    pub fn to_json(self) -> JsonValue {
        let mut object = JsObject::new();
        let text = |s: &str| JsonValue::String(s.to_owned());
        match self {
            McpToolDisplay::Ok => object.set("display", text("ok")),
            McpToolDisplay::Review => object.set("display", text("review")),
            McpToolDisplay::Unusable(reason) => {
                object.set("display", text("unusable"));
                object.set("reason", text(reason.as_str()));
            }
        }
        JsonValue::Object(object)
    }
}

/// A name that cannot work outranks a pending change: approving would not
/// help. `pending` is `tool.pending`: a definition (truthy) or `null`.
pub fn tool_display_of(
    pending: Option<&JsonValue>,
    name_problem: Option<ToolNameProblem>,
) -> McpToolDisplay {
    if let Some(reason) = name_problem {
        return McpToolDisplay::Unusable(reason);
    }
    if pending.is_some_and(JsonValue::truthy) {
        return McpToolDisplay::Review;
    }
    McpToolDisplay::Ok
}

// ---- the settings channel ---------------------------------------------------

/// Settings -> Integrations talks to the main process over these channels.
/// Only the shell window's preload exposes them (as `window.aiOfficeMcpServers`).
pub const MCP_SERVERS_SETTINGS_KEY: &str = "aiOfficeMcpServers";

/// `MCP_SERVERS_CHANNELS`, as (key, channel) in the order the object has them.
pub const MCP_SERVERS_CHANNELS: [(&str, &str); 20] = [
    ("list", "mcp-servers:list"),
    ("changed", "mcp-servers:changed"),
    ("openServer", "mcp-servers:open-server"),
    ("parsePaste", "mcp-servers:parse-paste"),
    ("add", "mcp-servers:add"),
    ("edit", "mcp-servers:edit"),
    ("remove", "mcp-servers:remove"),
    ("test", "mcp-servers:test"),
    ("signIn", "mcp-servers:sign-in"),
    ("cancelSignIn", "mcp-servers:cancel-sign-in"),
    ("approveTool", "mcp-servers:approve-tool"),
    ("approveInstructions", "mcp-servers:approve-instructions"),
    ("approveLaunch", "mcp-servers:approve-launch"),
    ("setToolPermission", "mcp-servers:set-tool-permission"),
    (
        "setKeepResultsInside",
        "mcp-servers:set-keep-results-inside",
    ),
    ("setEnabled", "mcp-servers:set-enabled"),
    ("markToolsSeen", "mcp-servers:mark-tools-seen"),
    ("plannedLaunch", "mcp-servers:planned-launch"),
    (
        "answerRuntimeDownload",
        "mcp-servers:answer-runtime-download",
    ),
    ("retry", "mcp-servers:retry"),
];

// ---- addresses --------------------------------------------------------------

/// `new URL(raw.trim())`: the protocol (with its colon) and the host name
/// (an IPv6 address in brackets), or `None` where the constructor throws
pub(crate) fn url_protocol_and_hostname(raw: &str) -> Option<(String, String)> {
    let url = Url::parse(trim(raw)).ok()?;
    Some((
        format!("{}:", url.scheme()),
        url.host_str().unwrap_or("").to_owned(),
    ))
}

/// `host.replace(/^\[|\]$/g, '')`
pub(crate) fn strip_brackets(host: &str) -> String {
    js_regex!(r"^\[|\]$", "g").replace_all(host, |_| String::new())
}

/// `PlainHttpReach`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlainHttpReach {
    Near,
    Public,
    Name,
}

impl PlainHttpReach {
    pub fn as_str(self) -> &'static str {
        match self {
            PlainHttpReach::Near => "near",
            PlainHttpReach::Public => "public",
            PlainHttpReach::Name => "name",
        }
    }
}

/// Where a plain-http address leads, judged from the text alone (4.3), for
/// the form to answer at once: `near`: this PC or a private range (allowed
/// after confirmation); `public`: a number address on the internet (never
/// allowed); `name`: a host name, judged by the main process when it
/// connects; `None`: not a plain-http address.
pub fn plain_http_reach(raw: &str) -> Option<PlainHttpReach> {
    let (protocol, hostname) = url_protocol_and_hostname(raw)?;
    if protocol != "http:" || hostname.is_empty() {
        return None;
    }
    let host = strip_brackets(&hostname).to_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return Some(PlainHttpReach::Near);
    }
    if let Some([a, b, _, _]) = ipv4_of(&host) {
        return Some(if near_ipv4(a, b) {
            PlainHttpReach::Near
        } else {
            PlainHttpReach::Public
        });
    }
    if host.contains(':') {
        return Some(if near_ipv6(&host) {
            PlainHttpReach::Near
        } else {
            PlainHttpReach::Public
        });
    }
    Some(PlainHttpReach::Name)
}

/// Whether a reached-for address is on this PC or a private network (no internet to blame)
pub fn is_near_address(raw: &str) -> bool {
    match plain_http_reach(raw) {
        Some(PlainHttpReach::Near | PlainHttpReach::Name) => return true,
        Some(PlainHttpReach::Public) => return false,
        None => {}
    }
    let Some((_, hostname)) = url_protocol_and_hostname(raw) else {
        return false;
    };
    let host = strip_brackets(&hostname).to_lowercase();
    if host == "localhost" {
        return true;
    }
    if let Some([a, b, _, _]) = ipv4_of(&host) {
        return near_ipv4(a, b);
    }
    host.contains(':') && near_ipv6(&host)
}

fn ipv4_of(host: &str) -> Option<[f64; 4]> {
    let m = js_regex!(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$").exec(host)?;
    let part = |i: usize| to_number(m.get(i).unwrap_or(""));
    let parts = [part(1), part(2), part(3), part(4)];
    parts.iter().all(|p| *p <= 255.0).then_some(parts)
}

/// 127/8, 10/8, 172.16/12, 192.168/16
fn near_ipv4(a: f64, b: f64) -> bool {
    a == 127.0
        || a == 10.0
        || (a == 172.0 && (16.0..=31.0).contains(&b))
        || (a == 192.0 && b == 168.0)
}

/// ::1, fc00::/7, fe80::/10, and an IPv4 address carried as ::ffff:a.b.c.d
fn near_ipv6(host: &str) -> bool {
    if host == "::1" {
        return true;
    }
    if let Some(mapped) = js_regex!(r"^::ffff:(\d+\.\d+\.\d+\.\d+)$").exec(host) {
        return match ipv4_of(mapped.get(1).unwrap_or("")) {
            Some([a, b, _, _]) => near_ipv4(a, b),
            None => false,
        };
    }
    if let Some(hex) = js_regex!(r"^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$").exec(host) {
        let high = to_int32(parse_int(hex.get(1).unwrap_or(""), Radix::Sixteen));
        return near_ipv4(f64::from(high >> 8), f64::from(high & 0xff));
    }
    let head = host.split(':').next().unwrap_or("");
    let first = to_int32(parse_int(
        if head.is_empty() { "0" } else { head },
        Radix::Sixteen,
    ));
    (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
}
