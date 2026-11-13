//! Batch A's hosts for the tool-side ports: MCP, the knowledge base, Drive,
//! Settings > Integrations, the user skills and the generate window. Each
//! port defines the host traits it `need`s; this file inserts an
//! implementation of every one (and the factory of the port), so `register`
//! finds all of them. What the shell can do now is real; what needs a part
//! not built yet (tabs, windows, editors, TypeScript logic nobody ported to
//! main-core) is a logged stub: `unbuilt("Trait::method")` once per call
//! site, then the answer an app with nothing open gives (empty, `false`, an
//! `Err` that says "not built yet"). A method that must hand back a window or
//! a view panics with the same words; the dispatch turns that into an error
//! reply.
//!
//! | trait | now |
//! | --- | --- |
//! | `mcp::McpNet` | real: `fetch` (reqwest, blocking on the calling thread); `compile_output_schema`, `validate_output` over the `jsonschema` crate ([`schema`]) |
//! | `mcp::McpShell` | real (language from the settings, version from the package info) |
//! | `mcp::McpTabs` | stub (the docs and sheets tabs of the tab manager) |
//! | `knowledge_base::KbServices` | `default_save_dir` real; the rest stub (file index, file parser, project folders, docx writer, recent list) |
//! | `drive::host::DriveShell` | `lang`, `stored_ai_settings` real; the rest stub (tabs, file parser, folder watch) |
//! | `drive::client::DriveClient` | real: main-core's `DriveConnection` on a runtime driver of the core thread, the token in the Drive vault, the Google client from the build's environment |
//! | `integrations::AgentSkills` | real (`main_core::packages::cli_agent_skills`, `cli_install`) |
//! | `user_skills::SkillImporter` | `dispose_skill_import` real; the rest stub (the ai-provider import pipeline, GitHub update check, zip writers are not in main-core) |
//! | `user_skills::SkillsShell` | real |
//! | `user_skills::TemplateCopyTabs` | stub (tab manager) |
//! | `generate::host::GenerateShell` | clock, ids, language, timers real; the window, tabs, engines and renderer strings stub |
//!
//! `mcp::kit::KitHost` is built by the MCP port itself and needs no host of
//! its own.
//!
//! Factories inserted: `integrations`, `knowledge_base`, `drive`,
//! `user_skills` (`factory` and `template_tabs_factory`), `mcp` (`hub_factory`
//! and `bridges_factory`) and `generate`.

use std::sync::Mutex;

use main_core::packages::i18n::{Lang, install_lang};
use main_core::shell::app_settings::read_app_settings;
use shell_contract::Hosts;

use super::super::HostContext;
use crate::paths::ShellPaths;

mod drive;
mod generate;
mod kb;
mod mcp;
mod schema;
mod skills;

const NOT_BUILT: &str = "not built yet";

/// What is not built is said once per call site
fn unbuilt(what: &'static str) {
    static SEEN: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    let mut seen = SEEN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !seen.contains(&what) {
        seen.push(what);
        eprintln!("shell: not built yet: {what}");
    }
}

/// The stand-in of every host whose real half is not built
struct Unbuilt;

/// `currentLang()` of the shell entry: `SEUOFFICE_LANG`, else the language
/// recorded in app-settings.json, else the system's. Read at each call, so a
/// language the person switched is seen at once.
fn current_lang() -> Lang {
    if let Ok(forced) = std::env::var("SEUOFFICE_LANG") {
        return main_core::packages::i18n::normalize_lang(Some(&forced));
    }
    let path = ShellPaths::new().settings_file();
    let settings = read_app_settings(&path.to_string_lossy());
    install_lang(settings.get("language"), system_locale().as_deref())
}

/// `app.getLocale()`, as far as the environment says. A GUI launch on macOS
/// carries none of these, so the default there is English until a locale
/// source (the `sys-locale` crate) is added.
fn system_locale() -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
}

/// `Date.now()`
fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

pub fn install(hosts: &mut Hosts, cx: &HostContext) {
    mcp::install(hosts, cx);
    kb::install(hosts, cx);
    drive::install(hosts, cx);
    skills::install(hosts, cx);
    generate::install(hosts, cx);
}
