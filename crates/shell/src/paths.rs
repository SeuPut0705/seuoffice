//! `app.getPath` for the handlers (the stage 3 shell contract, `AppPaths`).
//! Paths stay where the Electron build kept them (decisions 0013 and 0019):
//! the shell reads the same userData folder, named after the product's
//! machine name (`USER_DATA_DIR_NAME` of packages/i18n/src/product.ts), not
//! after the display name.

use std::path::PathBuf;

use shell_contract::runtime::{AppPaths, PathName};

/// `USER_DATA_DIR_NAME`
const USER_DATA_DIR_NAME: &str = "seuoffice";
/// `DEV_USER_DATA_DIR_NAME`: an unpackaged run never shares the installed app's profile
const DEV_USER_DATA_DIR_NAME: &str = "seuoffice-Dev";

pub struct ShellPaths {
    user_data: PathBuf,
}

impl ShellPaths {
    /// `SEUOFFICE_USER_DATA` points a test driver at a scratch folder, as the
    /// Electron build's did. Otherwise `appData/<name>`; a debug build is the
    /// Electron build's unpackaged run.
    pub fn new() -> Self {
        let user_data = std::env::var_os("SEUOFFICE_USER_DATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let name = if cfg!(debug_assertions) {
                    DEV_USER_DATA_DIR_NAME
                } else {
                    USER_DATA_DIR_NAME
                };
                app_data().join(name)
            });
        ShellPaths { user_data }
    }
}

impl ShellPaths {
    /// `APP_SETTINGS_PATH()`
    pub fn settings_file(&self) -> PathBuf {
        self.user_data.join("app-settings.json")
    }
}

/// `app.getPath('appData')`: `~/Library/Application Support`, `%APPDATA%`, `$XDG_CONFIG_HOME`
fn app_data() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| home().join(".config"))
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir)
}

/// `process.resourcesPath`: the folder the bundle's resources sit in, as the
/// Electron build laid it out (`modules/<app>/renderer`, the CLI, the wasm).
/// Tauri's `resource_dir` is `Contents/Resources` on macOS, Electron's too,
/// but the executable's folder on Windows, where Electron's is
/// `<install>\resources`. None when Tauri cannot tell.
pub fn resources_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    use tauri::Manager;
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| resources_below(dir, cfg!(windows)))
}

/// The resources folder below Tauri's `resource_dir`
fn resources_below(resource_dir: PathBuf, windows: bool) -> PathBuf {
    if windows {
        resource_dir.join("resources")
    } else {
        resource_dir
    }
}

impl AppPaths for ShellPaths {
    fn path(&self, name: PathName) -> PathBuf {
        match name {
            PathName::Home => home(),
            PathName::AppData => app_data(),
            PathName::UserData => self.user_data.clone(),
            PathName::Temp => std::env::temp_dir(),
            PathName::Exe => std::env::current_exe().unwrap_or_default(),
            PathName::Desktop => dirs::desktop_dir().unwrap_or_else(|| home().join("Desktop")),
            PathName::Documents => dirs::document_dir().unwrap_or_else(|| home().join("Documents")),
            PathName::Downloads => dirs::download_dir().unwrap_or_else(|| home().join("Downloads")),
            // Electron: `~/Library/Logs/<app name>` on macOS, `<userData>/logs` elsewhere
            PathName::Logs => {
                if cfg!(target_os = "macos") {
                    home().join("Library/Logs").join(USER_DATA_DIR_NAME)
                } else {
                    self.user_data.join("logs")
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_resources_sit_below_the_executables_folder() {
        let exe_dir = PathBuf::from(r"C:\Program Files\SeuOffice");
        assert_eq!(
            resources_below(exe_dir.clone(), true),
            exe_dir.join("resources")
        );
        let resources = PathBuf::from("/Applications/SeuOffice.app/Contents/Resources");
        assert_eq!(resources_below(resources.clone(), false), resources);
    }
}
