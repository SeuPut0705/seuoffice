//! `apps/shell/src/main/cli-link.ts`.
//!
//! What the module reads from the process and from Electron (`app`,
//! `process.resourcesPath`, `process.env`, `process.platform`, the console)
//! is the [`CliLinkHost`]; `installCliLink` of `@seuoffice/cli/install` (it
//! links into a PATH directory, or edits the Windows PATH through
//! PowerShell) and `appHomeDir` of `@seuoffice/ai-provider` are two of its
//! methods, so neither is ported here.

use std::fs;

use jscompat::node_path::host::join;
use jscompat::{JsObject, JsonValue, js_regex, truthy};

use crate::node_fs::{NodeError, node_error};
use crate::shell::app_settings::{read_app_settings, write_app_setting};

const SETTING_KEY: &str = "cliLink";

/// `InstallOutcome` of `@seuoffice/cli/install`: the fields cli-link.ts reads
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InstallOutcome {
    pub status: String,
    /// where the link or PATH entry lives (or would live)
    pub location: Option<String>,
    /// the link landed in a directory the current shell does not search
    pub path_hint: Option<String>,
}

pub trait CliLinkHost {
    /// `app.isPackaged`
    fn is_packaged(&self) -> bool;
    /// `process.resourcesPath`
    fn resources_path(&self) -> String;
    /// `process.env[name]`
    fn env(&self, name: &str) -> Option<String>;
    /// `process.platform`
    fn platform(&self) -> String;
    /// `app.getVersion()`
    fn version(&self) -> String;
    /// `homedir()`
    fn home_dir(&self) -> String;
    /// `appHomeDir(homeDir)`
    fn app_home_dir(&self, home_dir: &str) -> String;
    /// `installCliLink({ launcher })`; an `Err` is its throw
    fn install_cli_link(&self, launcher: &str) -> Result<InstallOutcome, String>;
    /// `console.log(line)`
    fn log(&self, line: &str);
    /// `console.warn(prefix, detail)`
    fn warn(&self, prefix: &str, detail: &str);
}

/// `launcherFileName` of `@seuoffice/cli`: the launcher file for a platform
pub fn launcher_file_name(platform: &str) -> String {
    if platform == "win32" {
        "seuoffice.cmd".to_owned()
    } else {
        "seuoffice".to_owned()
    }
}

/// `installCliLinkBestEffort`
pub fn install_cli_link_best_effort(host: &dyn CliLinkHost, settings_path: &str) {
    if !host.is_packaged() {
        return;
    }
    if let Err(message) = install(host, settings_path) {
        host.warn("[seuoffice] cli link failed:", &message);
    }
}

fn install(host: &dyn CliLinkHost, settings_path: &str) -> Result<(), String> {
    let resources = host.resources_path();
    let appimage = host.env("APPIMAGE");
    if is_ephemeral_install(&resources, appimage.as_deref()) {
        // a DMG under /Volumes or an AppImage FUSE mount vanishes on exit; linking
        // to it would leave a dead command, so wait for a real install
        host.log("[seuoffice] cli link skipped: app runs from a temporary mount");
        return Ok(());
    }
    let dir = join(&[&resources, "cli"]);
    let auth_dir = host.env("SEUOFFICE_AUTH_DIR");
    let home = host.home_dir();
    let file = launcher_file_path(auth_dir.as_deref(), &home, |home| host.app_home_dir(home));
    write_launcher_file(&file, &dir).map_err(|e| e.message)?;
    let version = host.version();
    let platform = host.platform();
    let previous = read_app_settings(settings_path).get(SETTING_KEY).cloned();
    let recorded = matches!(
        &previous,
        Some(JsonValue::Object(record))
            if matches!(record.get("version"), Some(JsonValue::String(v)) if *v == version)
    );
    if platform == "win32" && recorded {
        return Ok(());
    }
    let launcher = join(&[&dir, &launcher_file_name(&platform)]);
    let outcome = host.install_cli_link(&launcher)?;
    let location = truthy(outcome.location.as_deref());
    let mut line = format!("[seuoffice] cli link: {}", outcome.status);
    if let Some(location) = location {
        line.push_str(&format!(" ({location})"));
    }
    if let Some(hint) = truthy(outcome.path_hint.as_deref()) {
        line.push_str(&format!("; not on PATH, add it with: {hint}"));
    }
    host.log(&line);
    let mut record = JsObject::new();
    record.set("version", JsonValue::String(version));
    record.set("status", JsonValue::String(outcome.status.clone()));
    if let Some(location) = location {
        record.set("location", JsonValue::String(location.to_owned()));
    }
    write_app_setting(settings_path, SETTING_KEY, Some(JsonValue::Object(record)))
        .map_err(|e| e.message)?;
    Ok(())
}

/// `isEphemeralInstall`; `appimage` is `env.APPIMAGE`
pub fn is_ephemeral_install(resources_path: &str, appimage: Option<&str>) -> bool {
    if truthy(appimage).is_some() {
        return true;
    }
    js_regex!(r"^\/Volumes\/").test(resources_path)
        || js_regex!(r"\/\.mount_[^/]+\/").test(resources_path)
}

/// `launcherFilePath(env, homeDir)`; `auth_dir` is `env.SEUOFFICE_AUTH_DIR`
/// and `app_home_dir` is `appHomeDir`, which the `||` reaches only when the
/// variable is unset or empty.
pub fn launcher_file_path(
    auth_dir: Option<&str>,
    home_dir: &str,
    app_home_dir: impl FnOnce(&str) -> String,
) -> String {
    let base = match truthy(auth_dir) {
        Some(dir) => dir.to_owned(),
        None => app_home_dir(home_dir),
    };
    join(&[&base, "launcher"])
}

/// `writeLauncherFile`: true when the file was written
pub fn write_launcher_file(file: &str, launcher_dir: &str) -> Result<bool, NodeError> {
    let content = format!("{launcher_dir}\n");
    if let Ok(bytes) = fs::read(file)
        && String::from_utf8_lossy(&bytes) == content
    {
        return Ok(false);
    }
    let parent = join(&[file, ".."]);
    fs::create_dir_all(&parent).map_err(|e| node_error(&e, "mkdir", &parent))?;
    fs::write(file, content).map_err(|e| node_error(&e, "open", file))?;
    Ok(true)
}
