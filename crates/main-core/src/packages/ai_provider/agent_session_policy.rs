//! `packages/ai-provider/src/agent-session/policy.ts`: what the app does with
//! an action a program wants to take in agent mode, before anyone is asked.
//! Pure: the session runners call it for every permission request.
//!
//! `platform` is `NodeJS.Platform` as a string (`"win32"`, `"darwin"`,
//! `"linux"`...); `None` is the TypeScript's `process.platform` default (see
//! [`process_platform`]). The path functions are `node:path` of that
//! platform, as the TypeScript picks them (`jscompat::node_path`).
//!
//! The types of `agent-session/types.ts` this file takes and answers
//! ([`AgentAction`] and its parts) are defined here, with the fields the
//! policy reads.

use std::collections::HashSet;

use jscompat::node_path::{posix, win32};
use jscompat::{js_regex, truthy};
use url::Url;

use crate::packages::ai_provider::jsval::length16;

/// `AgentPermissionMode`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPermissionMode {
    AskCommands,
    AskWrites,
    TrustProject,
}

/// `AgentActionKind`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentActionKind {
    Read,
    Write,
    Command,
    AppTool,
    McpTool,
    Skill,
    WebSearch,
    WebFetch,
    Other,
}

/// `AgentAction`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentAction {
    pub kind: AgentActionKind,
    /// the program's own tool name
    pub tool: String,
    /// the full command line, for a command
    pub command: Option<String>,
    pub summary: Option<String>,
    /// absolute paths the action names, when the program said so
    pub paths: Vec<String>,
    /// the folder a command runs in, when the program said so
    pub cwd: Option<String>,
    pub reason: Option<String>,
    /// what a web action names: the search words, or the page address
    pub target: Option<String>,
    /// the site (host name, lower case) of a page address, when it has one
    pub host: Option<String>,
    /// the person's MCP server an `mcp-tool` action calls
    pub server: Option<String>,
}

/// `AgentSessionAllowances`: what the person allowed for the rest of a session
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentSessionAllowances {
    /// every web search
    pub web_search: bool,
    /// sites (lower-case host names) whose pages may be read
    pub web_hosts: HashSet<String>,
}

/// `AgentDenyReason`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentDenyReason {
    OutsideProject,
    OpenDocument,
    ProtectedPath,
}

impl AgentDenyReason {
    /// the word the TypeScript writes
    pub fn as_str(self) -> &'static str {
        match self {
            AgentDenyReason::OutsideProject => "outside-project",
            AgentDenyReason::OpenDocument => "open-document",
            AgentDenyReason::ProtectedPath => "protected-path",
        }
    }
}

/// `AgentPolicyVerdict`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPolicyVerdict {
    Allow,
    Ask,
    Deny(AgentDenyReason),
}

/// `AgentPolicyContext`
#[derive(Debug, Clone)]
pub struct AgentPolicyContext<'a> {
    pub mode: AgentPermissionMode,
    pub project_root: &'a str,
    pub open_documents: &'a [String],
    pub protected_paths: &'a [String],
    /// the session's copy of the skills; its scripts may be read and run
    pub skill_bundle_dir: Option<&'a str>,
    /// what the person allowed for the rest of this session (web actions)
    pub allowances: Option<&'a AgentSessionAllowances>,
    pub platform: Option<&'a str>,
}

/// `process.platform` of this machine, as Node names it.
pub fn process_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// `pathApi(platform)`: `win32` or `posix` of `node:path`.
#[derive(Clone, Copy)]
struct PathApi {
    win: bool,
}

impl PathApi {
    fn of(platform: &str) -> PathApi {
        PathApi {
            win: platform == "win32",
        }
    }

    fn resolve(self, base: &str, path: &str) -> String {
        if self.win {
            win32::resolve(&[base, path])
        } else {
            posix::resolve(&[base, path])
        }
    }

    fn relative(self, from: &str, to: &str) -> String {
        if self.win {
            win32::relative(from, to)
        } else {
            posix::relative(from, to)
        }
    }

    fn is_absolute(self, path: &str) -> bool {
        if self.win {
            win32::is_absolute(path)
        } else {
            posix::is_absolute(path)
        }
    }

    fn sep(self) -> &'static str {
        if self.win { win32::SEP } else { posix::SEP }
    }
}

/// `comparablePath(path, base, platform)`: a comparable form: absolute,
/// normalised, and case-folded where the file system ignores case.
pub fn comparable_path(path: &str, base: &str, platform: Option<&str>) -> String {
    let platform = platform.unwrap_or(process_platform());
    let api = PathApi::of(platform);
    let unified = if platform == "win32" {
        path.replace('/', "\\")
    } else {
        path.to_owned()
    };
    let resolved = api.resolve(base, &unified);
    if platform == "win32" {
        resolved.to_lowercase()
    } else {
        resolved
    }
}

/// `isInsidePath(child, root, platform)`: `child` is `root` itself or
/// somewhere below it. Only a whole `..` step leads out. On Windows another
/// drive or share comes back from `relative` as an absolute path.
pub fn is_inside_path(child: &str, root: &str, platform: Option<&str>) -> bool {
    let platform = platform.unwrap_or(process_platform());
    let api = PathApi::of(platform);
    let rel = api.relative(root, child);
    if rel.is_empty() {
        return true;
    }
    let up = rel == ".."
        || rel.starts_with(&format!("..{}", api.sep()))
        || (platform == "win32" && rel.starts_with("../"));
    !up && !api.is_absolute(&rel)
}

/// `commandNamesPath(command, path, platform)`: a command line names a
/// protected path when it contains it, written with either separator, single
/// or doubled.
fn command_names_path(command: &str, path: &str, platform: &str) -> bool {
    let separators = |value: &str| js_regex!(r"[\\/]+", "g").replace_all(value, |_| "/".to_owned());
    let text = separators(&if platform == "win32" {
        command.to_lowercase()
    } else {
        command.to_owned()
    });
    let form = separators(path);
    length16(&form) > 3 && text.contains(&form)
}

/// `webHostOf(url)`: the site of a web address: its lower-case host name, for
/// http and https only.
pub fn web_host_of(url: Option<&str>) -> Option<String> {
    let url = truthy(url)?;
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let hostname = parsed.host_str().unwrap_or("").to_lowercase();
    if hostname.is_empty() {
        None
    } else {
        Some(hostname)
    }
}

/// `agentPolicyVerdict(action, ctx)`
pub fn agent_policy_verdict(
    action: &AgentAction,
    ctx: &AgentPolicyContext<'_>,
) -> AgentPolicyVerdict {
    let platform = ctx.platform.unwrap_or(process_platform());
    let root = comparable_path(ctx.project_root, ctx.project_root, Some(platform));
    let base = match truthy(action.cwd.as_deref()) {
        Some(cwd) => comparable_path(cwd, &root, Some(platform)),
        None => root.clone(),
    };
    let paths: Vec<String> = action
        .paths
        .iter()
        .map(|path| comparable_path(path, &base, Some(platform)))
        .collect();
    let protected_paths: Vec<String> = ctx
        .protected_paths
        .iter()
        .map(|path| comparable_path(path, &root, Some(platform)))
        .collect();
    let open_documents: HashSet<String> = ctx
        .open_documents
        .iter()
        .map(|path| comparable_path(path, &root, Some(platform)))
        .collect();
    let skills =
        truthy(ctx.skill_bundle_dir).map(|dir| comparable_path(dir, &root, Some(platform)));
    let in_scope = |path: &str| -> bool {
        is_inside_path(path, &root, Some(platform))
            || skills
                .as_deref()
                .is_some_and(|skills| is_inside_path(path, skills, Some(platform)))
    };

    if paths.iter().any(|path| {
        protected_paths
            .iter()
            .any(|guard| is_inside_path(path, guard, Some(platform)))
    }) {
        return AgentPolicyVerdict::Deny(AgentDenyReason::ProtectedPath);
    }
    if truthy(action.command.as_deref()).is_some()
        && protected_paths.iter().any(|guard| {
            command_names_path(action.command.as_deref().unwrap_or(""), guard, platform)
        })
    {
        return AgentPolicyVerdict::Deny(AgentDenyReason::ProtectedPath);
    }

    match action.kind {
        AgentActionKind::Skill | AgentActionKind::AppTool => AgentPolicyVerdict::Allow,
        // outside the folder the person chose, someone looks first, whatever the mode
        AgentActionKind::Read => {
            if paths.iter().all(|path| in_scope(path)) {
                AgentPolicyVerdict::Allow
            } else {
                AgentPolicyVerdict::Ask
            }
        }
        AgentActionKind::Write => {
            if paths.iter().any(|path| open_documents.contains(path)) {
                return AgentPolicyVerdict::Deny(AgentDenyReason::OpenDocument);
            }
            if !paths
                .iter()
                .all(|path| is_inside_path(path, &root, Some(platform)))
            {
                return AgentPolicyVerdict::Deny(AgentDenyReason::OutsideProject);
            }
            if ctx.mode == AgentPermissionMode::AskWrites {
                AgentPolicyVerdict::Ask
            } else {
                AgentPolicyVerdict::Allow
            }
        }
        AgentActionKind::Command => {
            if ctx.mode == AgentPermissionMode::TrustProject {
                AgentPolicyVerdict::Allow
            } else {
                AgentPolicyVerdict::Ask
            }
        }
        // The web asks the first time, as the program's own app does; the person may allow every
        // search, or one site's pages, for the rest of the session. Trusting the project leaves the
        // decision to the program's own mode, so a request that still reaches the app asks.
        AgentActionKind::WebSearch => {
            if ctx
                .allowances
                .is_some_and(|allowances| allowances.web_search)
            {
                AgentPolicyVerdict::Allow
            } else {
                AgentPolicyVerdict::Ask
            }
        }
        AgentActionKind::WebFetch => {
            let allowed = match (truthy(action.host.as_deref()), ctx.allowances) {
                (Some(host), Some(allowances)) => {
                    allowances.web_hosts.contains(&host.to_lowercase())
                }
                _ => false,
            };
            if allowed {
                AgentPolicyVerdict::Allow
            } else {
                AgentPolicyVerdict::Ask
            }
        }
        // the relay asks the person itself; a request of this kind that reaches the policy asks
        AgentActionKind::McpTool | AgentActionKind::Other => AgentPolicyVerdict::Ask,
    }
}
