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

/// `app.getPath('appData')`: `~/Library/Application Support`, `%APPDATA%`, `$XDG_CONFIG_HOME`
fn app_data() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| home().join(".config"))
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir)
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
