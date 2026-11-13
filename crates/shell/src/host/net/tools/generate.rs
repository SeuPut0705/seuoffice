//! The host of the generate window (`shell_ipc_a::generate`): the Electron
//! window it lives in, the shell entry's tabs and settings, and the engines
//! of the conversions. The clock, the ids, the timers, the language and the
//! theme setting are real. The window, the tabs and the editors' saves wait
//! for the window system and the tab manager; the renderer strings and the
//! engines (`parseFileToText`, the map and deck engines) are not in
//! main-core, so they are stubs (see the report's "main-core gaps").

use std::sync::Arc;
use std::time::Duration;

use jscompat::{JsonValue, random_uuid};
use main_core::packages::electron_utils::generate_handoff::GenerateHandoff;
use main_core::packages::i18n::Lang;
use main_core::shell::app_routing::DocumentTabKind;
use main_core::shell::app_settings::read_app_settings;
use main_core::shell::generate::convert::{ConvertedDocument, OpOutcome, XmindTopic};
use main_core::shell::generate::generate_window::{
    GenerateText, GenerateWindowOptions, NewDocumentOpener,
};
use main_core::shell::generate::materials::ParsedFile;
use main_core::shell::generate::open_materials::{OpenDocumentTab, SaveAnswer, SaveNeed};
use main_core::shell::renderer_disposal::Failure;
use main_core::shell::title_bar_overlay::TitleBarOverlay;
use shell_contract::{Hosts, ViewId, WindowId};
use shell_ipc_a::generate::GenerateWindowEvents;
use shell_ipc_a::generate::host::{GenerateShell, GenerateShellHost, TabContents};

use super::{NOT_BUILT, current_lang, now_ms, unbuilt};
use crate::host::HostContext;
use crate::paths::ShellPaths;

pub(super) fn install(hosts: &mut Hosts, _cx: &HostContext) {
    let shell: GenerateShellHost = Arc::new(ShellGenerate);
    hosts.insert(shell);
    hosts.insert(shell_ipc_a::generate::factory());
}

struct ShellGenerate;

impl GenerateShell for ShellGenerate {
    // ---- the window ----

    fn create_window(&self, _: &GenerateWindowOptions, _: GenerateWindowEvents) -> WindowId {
        unbuilt("GenerateShell::create_window");
        panic!("GenerateShell::create_window is {NOT_BUILT}")
    }

    fn window_view(&self, _: WindowId) -> Option<ViewId> {
        unbuilt("GenerateShell::window_view");
        None
    }

    fn window_is_destroyed(&self, _: WindowId) -> bool {
        unbuilt("GenerateShell::window_is_destroyed");
        true
    }

    fn window_is_minimized(&self, _: WindowId) -> bool {
        unbuilt("GenerateShell::window_is_minimized");
        false
    }

    fn window_restore(&self, _: WindowId) {
        unbuilt("GenerateShell::window_restore");
    }

    fn window_show(&self, _: WindowId) {
        unbuilt("GenerateShell::window_show");
    }

    fn window_focus(&self, _: WindowId) {
        unbuilt("GenerateShell::window_focus");
    }

    fn window_close(&self, _: WindowId) {
        unbuilt("GenerateShell::window_close");
    }

    fn window_remove_menu(&self, _: WindowId) {
        unbuilt("GenerateShell::window_remove_menu");
    }

    fn window_set_title_bar_overlay(&self, _: WindowId, _: &TitleBarOverlay) -> Result<(), String> {
        unbuilt("GenerateShell::window_set_title_bar_overlay");
        Err(NOT_BUILT.into())
    }

    fn watch_theme(&self, _: WindowId) {
        unbuilt("GenerateShell::watch_theme");
    }

    fn unwatch_theme(&self, _: WindowId) {
        unbuilt("GenerateShell::unwatch_theme");
    }

    /// `process.env.ELECTRON_RENDERER_URL`: only the Electron dev server sets it
    fn renderer_url(&self) -> Option<String> {
        std::env::var("ELECTRON_RENDERER_URL").ok()
    }

    fn window_load_url(&self, _: WindowId, _: &str) {
        unbuilt("GenerateShell::window_load_url");
    }

    fn window_load_generate_page(&self, _: WindowId) {
        unbuilt("GenerateShell::window_load_generate_page");
    }

    fn should_use_dark_colors(&self) -> bool {
        unbuilt("GenerateShell::should_use_dark_colors");
        false
    }

    // ---- `GenerateWindowDeps` ----

    fn lang(&self) -> Lang {
        current_lang()
    }

    /// `currentTheme()`: the saved choice, else `system`
    fn theme(&self) -> String {
        let path = ShellPaths::new().settings_file();
        let settings = read_app_settings(&path.to_string_lossy());
        match settings.get("theme") {
            Some(JsonValue::String(theme)) if theme == "light" || theme == "dark" => theme.clone(),
            _ => "system".to_owned(),
        }
    }

    /// `generateText(lang, key)` of the renderer's i18n tables, which are TypeScript
    fn generate_text(&self, _: Lang, _: GenerateText) -> String {
        unbuilt("GenerateShell::generate_text");
        String::new()
    }

    fn starred_group_paths(&self, _: &str) -> Vec<String> {
        unbuilt("GenerateShell::starred_group_paths");
        Vec::new()
    }

    fn tab_id_for(&self, _: f64) -> Option<String> {
        unbuilt("GenerateShell::tab_id_for");
        None
    }

    fn open_target_tab(
        &self,
        _: &GenerateHandoff,
        _: Option<&NewDocumentOpener>,
    ) -> Result<(), String> {
        unbuilt("GenerateShell::open_target_tab");
        Err(NOT_BUILT.into())
    }

    fn can_open_converted(&self) -> bool {
        unbuilt("GenerateShell::can_open_converted");
        false
    }

    fn open_converted_tab(
        &self,
        _: &ConvertedDocument,
        _: Option<&NewDocumentOpener>,
    ) -> Result<(), String> {
        unbuilt("GenerateShell::open_converted_tab");
        Err(NOT_BUILT.into())
    }

    // ---- `deps.openMaterials` ----

    fn open_documents(&self, then: Box<dyn FnOnce(Vec<OpenDocumentTab>) + Send>) {
        // no tab is open
        unbuilt("GenerateShell::open_documents");
        then(Vec::new());
    }

    fn tab_contents(&self, _: &str) -> Option<TabContents> {
        unbuilt("GenerateShell::tab_contents");
        None
    }

    fn reveal_tab(&self, _: &str) {
        unbuilt("GenerateShell::reveal_tab");
    }

    fn has_save(&self, _: DocumentTabKind) -> bool {
        unbuilt("GenerateShell::has_save");
        false
    }

    fn save(&self, need: SaveNeed, then: Box<dyn FnOnce(SaveAnswer) + Send>) {
        unbuilt("GenerateShell::save");
        let failed = Failure(NOT_BUILT.into());
        then(match need {
            SaveNeed::ToPath { .. } => SaveAnswer::ToPath(Err(failed)),
            SaveNeed::Editor { .. } => SaveAnswer::Editor(Err(failed)),
        });
    }

    /// `setTimeout(then, ms)`
    fn set_timeout(&self, ms: f64, then: Box<dyn FnOnce() + Send>) {
        let wait = Duration::from_millis(ms.max(0.0) as u64);
        std::thread::spawn(move || {
            std::thread::sleep(wait);
            then();
        });
    }

    // ---- `randomUUID()` and `Date.now()` of session.ts ----

    fn new_id(&self) -> String {
        random_uuid()
    }

    fn now_ms(&self) -> f64 {
        now_ms()
    }

    // ---- engines not in main-core ----

    fn parse_file_to_text(&self, _: &str) -> Result<ParsedFile, String> {
        unbuilt("GenerateShell::parse_file_to_text");
        Err(NOT_BUILT.into())
    }

    /// `OUTLINE_KIND_MARKS.boundary` and `.relationship` of
    /// packages/xmind-engine/src/outline-marks.ts, two constants of the map editor
    fn not_topic_marks(&self) -> [String; 2] {
        ["(boundary)".to_owned(), "(relationship)".to_owned()]
    }

    fn first_sheet_root(&self, _: &str, _: &str) -> Result<XmindTopic, String> {
        unbuilt("GenerateShell::first_sheet_root");
        Err(NOT_BUILT.into())
    }

    fn create_xmind_document_from_outline(&self, _: &str, _: &str) -> Result<(), String> {
        unbuilt("GenerateShell::create_xmind_document_from_outline");
        Err(NOT_BUILT.into())
    }

    fn open_blank_deck(&self) -> Result<u64, String> {
        unbuilt("GenerateShell::open_blank_deck");
        Err(NOT_BUILT.into())
    }

    fn apply_deck_op(&self, _: u64, _: &JsonValue) -> Result<OpOutcome, String> {
        unbuilt("GenerateShell::apply_deck_op");
        Err(NOT_BUILT.into())
    }

    fn save_deck(&self, _: u64) -> Result<Vec<u8>, String> {
        unbuilt("GenerateShell::save_deck");
        Err(NOT_BUILT.into())
    }
}
