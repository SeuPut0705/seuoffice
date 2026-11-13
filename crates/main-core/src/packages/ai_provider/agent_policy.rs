//! Temporary stand-in for the MCP session's agent_session_policy.rs (policy.ts); delete at merge and use that module.
//!
//! `comparablePath` and `isInsidePath` of
//! `packages/ai-provider/src/agent-session/policy.ts`. `platform` is Node's
//! `process.platform`, given by the caller.

use jscompat::node_path::{posix, win32};

/// A comparable form: absolute, normalised, and case-folded where the file system ignores case
pub fn comparable_path(path: &str, base: &str, platform: &str) -> String {
    let windows = platform == "win32";
    let unified = if windows {
        path.replace('/', "\\")
    } else {
        path.to_owned()
    };
    let resolved = if windows {
        win32::resolve(&[base, &unified])
    } else {
        posix::resolve(&[base, &unified])
    };
    if windows {
        resolved.to_lowercase()
    } else {
        resolved
    }
}

/// `child` is `root` itself or somewhere below it. Only a whole `..` step leads
/// out: a name that merely starts with dots (`..x`, `...`) is below. On Windows
/// another drive or share comes back from `relative` as an absolute path.
pub fn is_inside_path(child: &str, root: &str, platform: &str) -> bool {
    let windows = platform == "win32";
    let rel = if windows {
        win32::relative(root, child)
    } else {
        posix::relative(root, child)
    };
    if rel.is_empty() {
        return true;
    }
    let sep = if windows { "\\" } else { "/" };
    let up =
        rel == ".." || rel.starts_with(&format!("..{sep}")) || (windows && rel.starts_with("../"));
    let absolute = if windows {
        win32::is_absolute(&rel)
    } else {
        posix::is_absolute(&rel)
    };
    !up && !absolute
}
