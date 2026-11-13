//! `packages/ai-provider/src/subscription/locate.ts`: where the subscription
//! CLIs are looked for. Only the directory lists the lookups use are here:
//! `commonUnixBinDirs`, `isFullDir`, `pathDirs` and what they reach
//! (`cleanCliPath`, `expandHome`, `npmPrefixDirs`, the nvm order).
//!
//! `env` is `NodeJS.ProcessEnv` as a lookup: the value of a variable, `None`
//! where it is `undefined` (the adapter decides how `process.env` answers,
//! case-insensitively on Windows). `platform` is `NodeJS.Platform` as a
//! string. The `node:path` functions `join`, `isAbsolute`, `sep` and
//! `delimiter` are the HOST's, as the TypeScript imports them
//! (`jscompat::node_path::host`), whatever `platform` says. The reads are
//! `std::fs`, in the order of the TypeScript's.

use std::fs;

use jscompat::node_path::host;
use jscompat::{js_regex, sort_by_number, string_less_than, to_number, trim, truthy};

use crate::node_fs::namespaced;
use crate::packages::ai_provider::jsval::length16;

/// `NodeJS.ProcessEnv` as a lookup
pub type EnvGet<'a> = &'a dyn Fn(&str) -> Option<String>;

/// `cleanCliPath(value)`: trimmed, and one pair of matching quotes taken off.
pub fn clean_cli_path(value: Option<&str>) -> String {
    let trimmed = trim(value.unwrap_or(""));
    if length16(trimmed) >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        // both ends are one-unit quotes: slice(1, -1)
        return trimmed[1..trimmed.len() - 1].to_owned();
    }
    trimmed.to_owned()
}

/// `expandHome(value, home)`
fn expand_home(value: &str, home: &str) -> String {
    if value == "~" {
        return home.to_owned();
    }
    if value.starts_with("~/") || value.starts_with("~\\") {
        return host::join(&[home, &value[2..]]);
    }
    value.to_owned()
}

/// `isFullDir(dir)`: a directory named in full. A relative one (`.`, `tools`)
/// would be completed from the working directory, which is the document's
/// folder when the app was started by opening a file. `\tools` is absolute to
/// Node, yet Windows completes it from the drive of the working directory.
pub fn is_full_dir(dir: &str) -> bool {
    host::is_absolute(dir) && !(host::SEP == "\\" && js_regex!(r"^[\\/](?![\\/])").test(dir))
}

/// `pathDirs(env, platform)`: the PATH directories a lookup may use: empty
/// and relative entries are left out (see [`is_full_dir`]).
pub fn path_dirs(env: EnvGet<'_>, platform: &str) -> Vec<String> {
    let value = env("PATH")
        .or_else(|| env("Path"))
        .or_else(|| env("path"))
        .unwrap_or_default();
    if value.is_empty() {
        return Vec::new();
    }
    value
        .split(if platform == "win32" {
            ";"
        } else {
            host::DELIMITER
        })
        .map(|dir| clean_cli_path(Some(dir)))
        .filter(|dir| is_full_dir(dir))
        .collect()
}

/// `compareNvmVersionDirsNewestFirst(a, b)`: nvm installs under
/// `~/.nvm/versions/node/vX.Y.Z`. Prefer higher X.Y.Z first.
fn compare_nvm_version_dirs_newest_first(a: &str, b: &str) -> f64 {
    let parts = |name: &str| -> [f64; 3] {
        match js_regex!(r"^v?(\d+)\.(\d+)\.(\d+)", "i").exec(trim(name)) {
            Some(m) => [
                to_number(m.get(1).unwrap_or("")),
                to_number(m.get(2).unwrap_or("")),
                to_number(m.get(3).unwrap_or("")),
            ],
            None => [-1.0, -1.0, -1.0],
        }
    };
    let pa = parts(a);
    let pb = parts(b);
    for (x, y) in pa.iter().zip(pb.iter()) {
        if x != y {
            return y - x;
        }
    }
    // Equal numeric triples (or both unparsable): keep a stable string order.
    if string_less_than(a, b) {
        -1.0
    } else if string_less_than(b, a) {
        1.0
    } else {
        0.0
    }
}

/// `readdir(dir).catch(() => [])`: libuv sorts the names by bytes.
fn read_dir_names(dir: &str) -> Vec<String> {
    let Ok(reader) = fs::read_dir(namespaced(dir)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = Vec::new();
    for entry in reader {
        let Ok(entry) = entry else {
            return Vec::new();
        };
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    names
}

/// `commonUnixBinDirs(home, env, platform)`: Finder/Dock-launched Electron
/// inherits a minimal PATH, so the directories npm, Homebrew, version managers
/// and the Claude installer (`~/.local/bin`) install into are probed
/// explicitly.
pub fn common_unix_bin_dirs(home: &str, env: EnvGet<'_>, platform: &str) -> Vec<String> {
    let mut dirs: Vec<String> = vec![
        "/opt/homebrew/bin".to_owned(),
        "/usr/local/bin".to_owned(),
        "/opt/local/bin".to_owned(),
    ];
    if !home.is_empty() {
        // Tool managers that keep their data outside the home directory's dotfiles
        let data_home = non_empty(clean_cli_path(env("XDG_DATA_HOME").as_deref()))
            .unwrap_or_else(|| host::join(&[home, ".local", "share"]));
        let fnm_root = non_empty(clean_cli_path(env("FNM_DIR").as_deref())).unwrap_or_else(|| {
            if platform == "darwin" {
                host::join(&[home, "Library", "Application Support", "fnm"])
            } else {
                host::join(&[&data_home, "fnm"])
            }
        });
        let pnpm_home =
            non_empty(clean_cli_path(env("PNPM_HOME").as_deref())).unwrap_or_else(|| {
                if platform == "darwin" {
                    host::join(&[home, "Library", "pnpm"])
                } else {
                    host::join(&[&data_home, "pnpm"])
                }
            });
        dirs.push(host::join(&[home, ".local", "bin"]));
        dirs.push(host::join(&[home, ".npm-global", "bin"]));
        dirs.push(host::join(&[home, ".volta", "bin"]));
        dirs.push(host::join(&[home, ".bun", "bin"]));
        dirs.push(host::join(&[home, ".yarn", "bin"]));
        dirs.push(host::join(&[home, ".asdf", "shims"]));
        dirs.push(host::join(&[&data_home, "mise", "shims"]));
        dirs.push(pnpm_home);
        // the version fnm's `default` alias points at; its per-shell directories
        // live under a process id and are gone by the next sign-in
        dirs.push(host::join(&[&fnm_root, "aliases", "default", "bin"]));
        dirs.extend(npm_prefix_dirs(env, platform, home));
        let nvm_root = host::join(&[home, ".nvm", "versions", "node"]);
        let mut versions = read_dir_names(&nvm_root);
        // Newest first: String.sort is lexicographic, so "v8.x" sorts ahead of "v20.x".
        sort_by_number(&mut versions, |a, b| {
            compare_nvm_version_dirs_newest_first(a, b)
        });
        for version in versions {
            dirs.push(host::join(&[&nvm_root, &version, "bin"]));
        }
    }
    dirs
}

/// `a || b` on a string: `Some` when the text is not empty
fn non_empty(text: String) -> Option<String> {
    truthy(Some(&text)).map(str::to_owned)
}

/// `npmPrefixDirs(env, platform, home)`: the bin directory of a global npm
/// prefix the user moved (`npm config set prefix`, `NPM_CONFIG_PREFIX`), which
/// PATH may not list for a GUI app. npm is not run to read it: `npm config
/// set` writes the value to `~/.npmrc`.
fn npm_prefix_dirs(env: EnvGet<'_>, platform: &str, home: &str) -> Vec<String> {
    let mut values: Vec<Option<String>> = vec![env("npm_config_prefix"), env("NPM_CONFIG_PREFIX")];
    if !home.is_empty() {
        let npmrc = fs::read(namespaced(&host::join(&[home, ".npmrc"])))
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        for line in js_regex!(r"\r?\n").split(&npmrc) {
            if let Some(m) = js_regex!(r"^\s*prefix\s*=\s*(.*)$").exec(line) {
                values.push(m.get(1).map(str::to_owned));
            }
        }
    }
    let mut dirs: Vec<String> = Vec::new();
    for value in values {
        let prefix = expand_home(&clean_cli_path(value.as_deref()), home);
        if !is_full_dir(&prefix) {
            continue;
        }
        // npm links a global command into `<prefix>/bin`; on Windows into the prefix itself
        let dir = if platform == "win32" {
            prefix
        } else {
            host::join(&[&prefix, "bin"])
        };
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}
