//! Batch M's hosts (the stage 3 shell contract, the batch table: host/menu.rs
//! and host/print.rs). This file inserts them all:
//!
//! - `MHostRef`: the app's locale and user, the native theme, the menus that
//!   follow the language, the spellchecker of the default session, and the
//!   printing of [`super::print`];
//! - `MStateRef`: the batch's process state (language and theme caches,
//!   context-menu claims, ignored words, print guards), one per process;
//! - `FontQueriesRef`: the installed-font queries, which wait for stage 2's
//!   port of packages/font-metrics ([`FontsNotPorted`]).
//!
//! The application menu ([`apply_menu_for`]) and the context menus live in
//! the submodules.

mod app;
mod cef_ops;
mod context;
mod dock;

pub(crate) use app::{app_menu_activate, app_menu_popup};

pub(crate) use cef_ops::{host_of, print_preview};

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use main_core::packages::electron_utils::default_save_dir::{
    PathProvider, SaveDirState, Thrown, configured_default_save_dir,
};
use main_core::packages::electron_utils::printer_options::CommandOutcome;
use main_core::shell::tab_manager::TabKind;
use serde_json::Value;
use shell_contract::Hosts;
use shell_contract::ids::ViewId;
use shell_contract::runtime::{AppPaths, PathName, Thread};
use shell_ipc_m::hosts::{
    FontQueries, FontQueriesRef, KeyInput, MHost, MHostRef, PrintSurface, PrintWindowSpec, Printer,
};
use shell_ipc_m::state::{MState, MStateRef};
use shell_ipc_m::{MenuDict, menu_label};
use shell_ipc_w::quick_look::QuickLookHost;
use tauri::{AppHandle, Manager, Theme};
use tauri_runtime_cef::WebviewCefExt;

use super::shell_tabs::shell_tabs;
use super::w::{on_core, post_core};
use super::window::Windows;
use super::{HostContext, on_ui, print};
use crate::paths::ShellPaths;
use crate::views::ViewTable;

/// How long a call into a view's browser may take before it counts as lost
const BROWSER_TIMEOUT: Duration = Duration::from_secs(10);

/// The hunspell languages Chromium ships dictionaries for
/// (`kSupportedSpellCheckerLanguages`, components/spellcheck/common/
/// spellcheck_common.cc), which is what Electron's
/// `session.availableSpellCheckerLanguages` lists where the OS checker is not used
const HUNSPELL_LANGUAGES: &[&str] = &[
    "af",
    "bg",
    "ca",
    "cs",
    "cy",
    "da",
    "de",
    "de-DE",
    "el",
    "en-AU",
    "en-CA",
    "en-GB",
    "en-GB-oxendict",
    "en-US",
    "es",
    "es-419",
    "es-AR",
    "es-ES",
    "es-MX",
    "es-US",
    "et",
    "fa",
    "fo",
    "fr",
    "fr-FR",
    "he",
    "hi",
    "hr",
    "hu",
    "hy",
    "id",
    "it",
    "it-IT",
    "ko",
    "lt",
    "lv",
    "nb",
    "nl",
    "pl",
    "pt",
    "pt-BR",
    "pt-PT",
    "ro",
    "ru",
    "sh",
    "sk",
    "sl",
    "sq",
    "sr",
    "sv",
    "ta",
    "tg",
    "tr",
    "uk",
    "vi",
];

struct ShellM {
    app: AppHandle,
    ui: Arc<dyn Thread>,
    windows: Arc<Windows>,
    views: Arc<ViewTable>,
    paths: ShellPaths,
    tray: Option<QuickLookHost>,
    save_dir: Mutex<SaveDirState>,
}

/// The app the menus are set on, for callers that have no handle (the tab
/// hooks on the core thread)
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn install(hosts: &mut Hosts, cx: &HostContext) {
    let _ = APP.set(cx.app.clone());
    context::install(&cx.app, cx.views.clone(), cx.windows.clone());
    app::install(cx);
    let host: MHostRef = Arc::new(ShellM {
        app: cx.app.clone(),
        ui: cx.ui.clone(),
        windows: cx.windows.clone(),
        views: cx.views.clone(),
        paths: ShellPaths::new(),
        tray: hosts.get::<QuickLookHost>().cloned(),
        save_dir: Mutex::default(),
    });
    hosts.insert(host);
    hosts.insert::<MStateRef>(Arc::new(MState::new()));
    hosts.insert::<FontQueriesRef>(Arc::new(FontsNotPorted));
}

/// [`apply_menu_for`] on the shell's app; nothing before the hosts are installed
pub(crate) fn apply_menu(kind: TabKind) {
    if let Some(app) = APP.get() {
        apply_menu_for(app, kind);
    }
}

/// `homeKinds.set`: the home menu and the Dock list the new-document kinds
pub(crate) fn home_kinds_changed() {
    if let Some(app) = APP.get() {
        apply_menu_for(app, TabKind::Home);
        install_dock_menu(app);
    }
}

/// `applyMenuFor(kind)`: the application menu of the active editor. Callable
/// from any thread; the menu is set on the UI thread.
pub(crate) fn apply_menu_for(app: &AppHandle, kind: TabKind) {
    app::apply_menu_for(app, kind);
    // the Dock needs the tabs, which exist once a menu is first applied
    static DOCK: std::sync::Once = std::sync::Once::new();
    DOCK.call_once(|| install_dock_menu(app));
}

/// The kinds the Dock may offer (`installDockMenu`'s `only`); they appear in home's order
const DOCK_KINDS: [(&str, &str); 5] = [
    ("docx", "menuNewDoc"),
    ("xlsx", "menuNewSheet"),
    ("pptx", "menuNewSlide"),
    ("md", "menuNewMarkdown"),
    ("pdf", "menuNewPdf"),
];

/// `installDockMenu()`: Home, then the new-document entries the person did not
/// hide, in home's order and the app's language. At start, after a language
/// change and after the home kinds change.
pub(crate) fn install_dock_menu(app: &AppHandle) {
    let app = app.clone();
    post_core(move |provided, services| {
        let Ok(lang) = shell_ipc_m::current_lang(services) else {
            return;
        };
        let Some(tabs) = shell_tabs(provided) else {
            return;
        };
        let visible = tabs.new_document_kinds();
        let mut entries = vec![dock::DockEntry {
            label: menu_label(MenuDict::Shell, lang, "menuHome"),
            action: dock::DockAction::Home,
        }];
        entries.extend(visible.iter().filter_map(|kind| {
            let (kind, key) = DOCK_KINDS.iter().find(|(k, _)| k == kind)?;
            Some(dock::DockEntry {
                label: menu_label(MenuDict::Shell, lang, key),
                action: dock::DockAction::NewDocument(kind),
            })
        }));
        dock::set_dock_menu(
            &app,
            entries,
            Arc::new(|action| {
                post_core(move |provided, _| {
                    let Some(tabs) = shell_tabs(provided) else {
                        return;
                    };
                    match action {
                        dock::DockAction::Home => {
                            tabs.reveal_shell_window();
                            tabs.open_home_tab();
                        }
                        dock::DockAction::NewDocument(kind) => {
                            tabs.reveal_shell_window();
                            tabs.new_document(kind);
                        }
                    }
                });
            }),
        );
    });
}

/// The first language of the profile's accept languages: the locale Chromium
/// runs the app in, which is what Electron's `app.getLocale()` reported
fn first_accept_language(ui: &Arc<dyn Thread>) -> Option<String> {
    on_ui(ui, || {
        cef_ops::string_list_preference("intl.accept_languages")
    })
    .into_iter()
    .next()
}

impl ShellM {
    /// Runs `job` with a view's browser on the UI thread and waits for it
    fn with_browser<R: Send + 'static>(
        &self,
        view: ViewId,
        job: impl FnOnce(&cef::BrowserHost) -> R + Send + 'static,
    ) -> Option<R> {
        let webview = self.windows.webview(view)?;
        let (tx, rx) = mpsc::sync_channel(1);
        webview
            .with_cef_webview(move |cef_view| {
                if let Some(host) = cef_ops::host_of(cef_view) {
                    let _ = tx.send(job(&host));
                }
            })
            .ok()?;
        rx.recv_timeout(BROWSER_TIMEOUT).ok()
    }
}

impl PathProvider for ShellPaths {
    fn get_path(&self, name: &str) -> Result<String, Thrown> {
        let name = match name {
            "home" => PathName::Home,
            "appData" => PathName::AppData,
            "userData" => PathName::UserData,
            "temp" => PathName::Temp,
            "exe" => PathName::Exe,
            "desktop" => PathName::Desktop,
            "documents" => PathName::Documents,
            "downloads" => PathName::Downloads,
            "logs" => PathName::Logs,
            other => return Err(Thrown(format!("Failed to get '{other}' path"))),
        };
        Ok(self.path(name).to_string_lossy().into_owned())
    }
}

impl MHost for ShellM {
    fn now_ms(&self) -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0.0, |d| d.as_millis() as f64)
    }

    fn app_locale(&self) -> String {
        first_accept_language(&self.ui).unwrap_or_else(|| "en-US".to_owned())
    }

    fn system_locale(&self) -> String {
        self.app_locale()
    }

    fn env_lang(&self) -> Option<String> {
        // the old name is still read (old-names, decision 0024)
        ["SEUOFFICE_LANG", "GENOFFICE_LANG"]
            .iter()
            .find_map(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
    }

    fn username(&self) -> Option<String> {
        ["USER", "USERNAME", "LOGNAME"]
            .iter()
            .find_map(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
    }

    fn set_native_theme(&self, theme: &str) {
        let theme = match theme {
            "light" => Some(Theme::Light),
            "dark" => Some(Theme::Dark),
            _ => None,
        };
        let app = self.app.clone();
        on_ui(&self.ui, move || app.set_theme(theme));
    }

    /// The window frames follow `set_native_theme` themselves; Electron only
    /// recoloured its custom title-bar overlay, which the Tauri windows do not use
    fn refresh_title_bar_overlay(&self) {}

    fn rebuild_menus_for_language(&self) {
        // the language switcher lives on the home page, so the home menu is the active one;
        // the editors' Back to Home items are built with each editor menu, in its language
        apply_menu_for(&self.app, TabKind::Home);
        install_dock_menu(&self.app);
    }

    fn sync_tray_menu(&self) {
        if let Some(tray) = &self.tray {
            tray.refresh_tray();
        }
    }

    fn reveal_home(&self) -> bool {
        on_core(|provided| match shell_tabs(provided) {
            Some(tabs) => {
                tabs.reveal_shell_window();
                tabs.open_home_tab();
                true
            }
            None => false,
        })
        .unwrap_or(false)
    }

    fn is_packaged(&self) -> bool {
        !cfg!(debug_assertions)
    }

    fn app_path(&self) -> String {
        // `app.getAppPath()` of an unpackaged run: the shell's package folder,
        // from which `templateFontsDir` climbs to packages/ui
        std::env::var_os("SEUOFFICE_APPS_DIR")
            .map_or_else(
                || Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../apps")).to_path_buf(),
                std::path::PathBuf::from,
            )
            .join("shell")
            .to_string_lossy()
            .into_owned()
    }

    fn resources_path(&self) -> String {
        self.app
            .path()
            .resource_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    /// The shell has no headless export mode: that runs in the command-line tool
    fn headless(&self) -> bool {
        false
    }

    fn open_generated_path(&self, path: &str) -> bool {
        let path = path.to_owned();
        on_core(move |provided| shell_tabs(provided).is_some_and(|tabs| tabs.open_path(&path)))
            .unwrap_or(false)
    }

    fn default_save_dir(&self) -> String {
        let mut state = self.save_dir.lock().unwrap();
        configured_default_save_dir(&self.paths, &mut state, self.now_ms()).unwrap_or_else(|_| {
            self.paths
                .path(PathName::Documents)
                .to_string_lossy()
                .into_owned()
        })
    }

    fn spell_add_word(&self, view: ViewId, word: &str) -> bool {
        let word = word.to_owned();
        self.with_browser(view, move |host| {
            cef_ops::add_word(host, &word);
            true
        })
        .unwrap_or(false)
    }

    /// CEF has no call that takes a word out of the profile's custom
    /// dictionary (Electron's `removeWordFromSpellCheckerDictionary`): an
    /// ignored word stays known after its last tab closes. Listed among the
    /// stage 3 differences of the shell contract.
    fn spell_remove_word(&self, word: &str) {
        eprintln!("shell: the spellchecker keeps '{word}': CEF cannot remove a dictionary word");
    }

    fn spell_languages(&self, _view: ViewId) -> Vec<String> {
        on_ui(&self.ui, || {
            cef_ops::string_list_preference("spellcheck.dictionaries")
        })
    }

    /// macOS checks with the system's own spellchecker, which picks the
    /// language itself: Electron listed nothing there, and so does this
    fn spell_available_languages(&self, _view: ViewId) -> Vec<String> {
        if cfg!(target_os = "macos") {
            Vec::new()
        } else {
            HUNSPELL_LANGUAGES.iter().map(|l| (*l).to_owned()).collect()
        }
    }

    fn spell_set_languages(&self, _view: ViewId, languages: &[String]) {
        let languages = languages.to_vec();
        let set = on_ui(&self.ui, move || {
            cef_ops::set_string_list_preference("spellcheck.dictionaries", &languages)
        });
        if let Err(error) = set {
            eprintln!("shell: spellcheck languages not set: {error}");
        }
    }

    fn replace_misspelling(&self, view: ViewId, word: &str) {
        let word = word.to_owned();
        self.with_browser(view, move |host| cef_ops::replace_misspelling(host, &word));
    }

    fn send_space(&self, view: ViewId, input: KeyInput) {
        let kind = match input {
            KeyInput::KeyDown => cef::KeyEventType::RAWKEYDOWN,
            KeyInput::Char => cef::KeyEventType::CHAR,
            KeyInput::KeyUp => cef::KeyEventType::KEYUP,
        };
        self.with_browser(view, move |host| cef_ops::send_space(host, kind));
    }

    fn printers(&self, _view: ViewId) -> Vec<Printer> {
        print::printers()
    }

    fn print_window(&self, spec: &PrintWindowSpec) -> Box<dyn PrintSurface> {
        print::window(
            self.app.clone(),
            self.ui.clone(),
            self.views.clone(),
            spec.clone(),
        )
    }

    fn run_command(&self, file: &str, args: &[String], stdin: Option<&[u8]>) -> CommandOutcome {
        print::run_command(file, args, stdin)
    }
}

/// The font queries of packages/font-metrics (`familyInfoFor`,
/// `familyVerticalMetrics`, `familyAliases`) and the PDF editor's
/// `listEditFonts`, which stage 2 is porting to main-core. Until then every
/// query answers as a machine with no matching font would, and says so once.
struct FontsNotPorted;

impl FontsNotPorted {
    fn note(&self) {
        static SAID: Mutex<bool> = Mutex::new(false);
        let mut said = SAID.lock().unwrap();
        if !*said {
            *said = true;
            eprintln!("shell: font queries answer empty until main-core has packages/font-metrics");
        }
    }
}

impl FontQueries for FontsNotPorted {
    fn family_info_for(&self, _families: &Value) -> Value {
        self.note();
        Value::Array(Vec::new())
    }

    fn family_vertical_metrics(&self, _family: &str) -> Option<Value> {
        self.note();
        None
    }

    fn family_aliases(&self, _name: &str) -> Vec<String> {
        self.note();
        Vec::new()
    }

    fn list_edit_fonts(&self) -> Vec<String> {
        self.note();
        Vec::new()
    }
}
