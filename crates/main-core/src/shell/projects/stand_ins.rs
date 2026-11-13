//! The few pieces of modules other stage-2 slices own that the project code
//! calls, ported here until those modules land. Each item names the file that
//! replaces it; at merge this file goes and its users import from there.

use jscompat::node_path::host::join;
use jscompat::node_path::win32;
use jscompat::{JsObject, try_js_regex};

use crate::markdown::asset_lifecycle::ASSET_MANIFEST_FILENAME;
use crate::markdown::old_names::OLD_ASSET_MANIFEST_FILENAMES;
use crate::node_fs::namespaced;
use crate::packages::i18n::OLD_HOME_DIR_NAMES;
use crate::shell::app_routing::document_extension;

// --- `apps/shell/src/main/agent/agent-sessions.ts`, replaced by
// `crate::shell::agent::agent_sessions`

/// `HOME_DIR_NAME` of `packages/cli/src/names.ts` (`.${CLI_COMMAND}`): the
/// per-user folder under the home directory
pub const HOME_DIR_NAME: &str = ".seuoffice";

/// `agentProtectedPaths(homeDir, userData)`: folders no session may use or
/// reach: sign-in stores, the original app, this app's data
pub fn agent_protected_paths(home_dir: &str, user_data: &str) -> Vec<String> {
    let mut paths = vec![
        join(&[home_dir, ".claude"]),
        join(&[home_dir, ".codex"]),
        // the upstream app's home folder
        join(&[home_dir, ".genoffice"]),
    ];
    for name in std::iter::once(HOME_DIR_NAME).chain(OLD_HOME_DIR_NAMES) {
        paths.push(join(&[home_dir, name]));
    }
    paths.push(user_data.to_owned());
    paths
}

// --- `apps/shell/src/main/file-index/scan.ts`, replaced by
// `crate::shell::file_index::scan`

/// `SCAN_MAX_DEPTH`: how many folder levels a scan descends
pub const SCAN_MAX_DEPTH: u32 = 32;

// --- `apps/shell/src/main/folder-tree.ts`, replaced by
// `crate::shell::folder_tree`

/// `TREE_FILE_EXTENSIONS`: files the home tree shows; mirrors the shell's
/// open-dialog filter
pub const TREE_FILE_EXTENSIONS: [&str; 31] = [
    "docx",
    "doc",
    "dot",
    "odt",
    "xlsx",
    "xlsm",
    "xls",
    "csv",
    "tsv",
    "ods",
    "pptx",
    "ppt",
    "odp",
    "otp",
    "pdf",
    "md",
    "markdown",
    "txt",
    "json",
    "html",
    "htm",
    "xmind",
    "mm",
    "hwp",
    "hwpx",
    "epub",
    "drawio",
    "dio",
    "vsdx",
    // draw.io pictures, by their double extension (documentExtension)
    "drawio.svg",
    "drawio.png",
];

/// `isSupportedTreeFile(name)`
pub fn is_supported_tree_file(name: &str) -> bool {
    let extension = document_extension(name);
    TREE_FILE_EXTENSIONS.contains(&extension.as_str())
}

const HIDDEN_DIR_NAMES: [&str; 2] = ["node_modules", "__macosx"];
const HIDDEN_FILE_NAMES: [&str; 2] = ["thumbs.db", "desktop.ini"];

/// `isHiddenEntry(dir, name, isDir)`: dotfiles, Office lock files, OS junk and
/// the Markdown `assets/` folder stay out of the tree
pub fn is_hidden_entry(dir: &str, name: &str, is_dir: bool) -> bool {
    if name.starts_with('.') || name.starts_with("~$") {
        return true;
    }
    let lower = name.to_lowercase();
    if is_dir {
        if HIDDEN_DIR_NAMES.contains(&lower.as_str()) {
            return true;
        }
        // the Markdown / HTML apps' image folder is app-owned when it holds
        // their list, under either name
        if lower == "assets"
            && std::iter::once(ASSET_MANIFEST_FILENAME)
                .chain(OLD_ASSET_MANIFEST_FILENAMES)
                .any(|manifest| {
                    std::fs::metadata(namespaced(&join(&[dir, name, manifest]))).is_ok()
                })
        {
            return true;
        }
        return false;
    }
    HIDDEN_FILE_NAMES.contains(&lower.as_str())
}

// --- `packages/ai-provider/src/subscription/process.ts`, replaced by
// `crate::packages::ai_provider::subscription_process`

/// `WINDOWS_ROOT_PATTERN.test(value)`: a drive path made of plain file names.
/// Anything else is not taken as the Windows directory.
///
/// The pattern has a loop over a group, which `jscompat/tests/sites.rs` makes
/// a `TryJsRegex`: its search stops at the backtrack bound on a value of about
/// a million characters, where V8 throws a `RangeError`. An environment value
/// holds at most 32,767 characters on Windows, so that bound is not reached.
fn is_windows_root(value: &str) -> bool {
    try_js_regex!(r#"^[A-Za-z]:(?:\\[^\\/:*?"<>|%\r\n]+)+\\?$"#)
        .try_test(value)
        .expect("an environment value is far below the backtrack bound")
}

/// `windowsSystemDir(env)`: the Windows system directory (`%SystemRoot%\System32`)
pub fn windows_system_dir(env: &JsObject<String>) -> String {
    let root = ["SystemRoot", "SYSTEMROOT", "windir"]
        .into_iter()
        .filter_map(|key| env.get(key))
        .find(|value| is_windows_root(value));
    win32::join(&[root.map_or("C:\\Windows", String::as_str), "System32"])
}

/// `windowsSystemTool(env, ...segments)`: Windows system tools are started by
/// full path: PATH is not trusted to find them
pub fn windows_system_tool(env: &JsObject<String>, segments: &[&str]) -> String {
    let dir = windows_system_dir(env);
    let mut parts: Vec<&str> = Vec::with_capacity(segments.len() + 1);
    parts.push(&dir);
    parts.extend_from_slice(segments);
    win32::join(&parts)
}
