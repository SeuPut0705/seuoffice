//! Logged stubs of batch W's host traits (`crates/shell-ipc/w`) whose real
//! implementation is a later unit: the tab strip and window system
//! (`WindowsHost`), the editors' tab and file facts, the home screen's file
//! index, tree and watcher, the app facts, the preview and picker windows.
//!
//! Each call logs its trait and method once, then answers what an app with
//! nothing open would: empty, `false`, an error that says "not built yet". A
//! call that has no such answer (it must hand back a window or a view) panics
//! with the same words; the dispatch turns that into an error reply.
//!
//! Written from the compiler's list of missing items: when a trait of batch
//! W changes, rustc names what the impl lacks, and the lines below follow it.
//! `TabHooks` lives on the core thread and is provided, not hosted
//! ([`super::w::register_hooks`]).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use main_core::packages::ai_provider::settings_secrets::AiSecretCodec;
use main_core::packages::electron_utils::unsaved_files::{OpenFileState, OpenFilesSourceFailed};
use main_core::packages::i18n::Lang;
use main_core::shell::detached_windows::WindowOptions;
use main_core::shell::doc_picker::asker::DocAsker;
use main_core::shell::doc_picker::doc_list::{OpenDocumentEntry, ProjectFile, RecentDocumentEntry};
use main_core::shell::tab_manager::{
    DiagramIdentity, LoadedTabView, Opener, SplitViewState, TabError, TabKind,
    UnloadedTabOpenContext,
};
use shell_contract::error::IpcError;
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::value::IpcValue;
use shell_ipc_w::doc_picker::*;
use shell_ipc_w::editor_files::{DocsTab, DocsTabs, FileParse, OpenFiles, SheetsTabs, UiLanguage};
use shell_ipc_w::home_files::*;
use shell_ipc_w::home_settings::*;
use shell_ipc_w::quick_look::*;
use shell_ipc_w::tabs::*;

const NOT_BUILT: &str = "not built yet";

/// What is not built is said once per call site
fn unbuilt(what: &'static str) {
    static SEEN: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    let mut seen = SEEN.lock().unwrap();
    if !seen.contains(&what) {
        seen.push(what);
        eprintln!("shell: not built yet: {what}");
    }
}

fn not_running() -> McpStatus {
    McpStatus {
        running: false,
        settings: McpSettings {
            enabled: false,
            port: DEFAULT_MCP_PORT,
            background: false,
            logging: false,
        },
        url: None,
        capabilities: Vec::new(),
    }
}

pub(super) struct Unbuilt;

impl QuickLookRuntime for Unbuilt {
    fn attach(&self, _: QuickLookControl) {
        unbuilt("QuickLookRuntime::attach");
    }
    fn windows_explorer(&self) -> bool {
        unbuilt("QuickLookRuntime::windows_explorer");
        false
    }
    fn sync(&self, _: &QuickLookSettings) {
        unbuilt("QuickLookRuntime::sync");
    }
    fn refresh_tray(&self) {
        unbuilt("QuickLookRuntime::refresh_tray");
    }
    fn stop(&self) {
        unbuilt("QuickLookRuntime::stop");
    }
}

impl QuickLookWindow for Unbuilt {
    fn attach(&self, _: QuickLookControl) {
        unbuilt("QuickLookWindow::attach");
    }
    fn lang(&self) -> Lang {
        unbuilt("QuickLookWindow::lang");
        Lang::Ko
    }
    fn theme(&self) -> String {
        unbuilt("QuickLookWindow::theme");
        String::new()
    }
    fn create(&self, _: &QuickLookWindowOptions) -> ViewId {
        unbuilt("QuickLookWindow::create");
        panic!("QuickLookWindow::create is not built yet")
    }
    fn is_visible(&self) -> bool {
        unbuilt("QuickLookWindow::is_visible");
        false
    }
    fn set_title(&self, _: &str) {
        unbuilt("QuickLookWindow::set_title");
    }
    fn show_inactive(&self) {
        unbuilt("QuickLookWindow::show_inactive");
    }
    fn hide(&self) {
        unbuilt("QuickLookWindow::hide");
    }
    fn destroy(&self) {
        unbuilt("QuickLookWindow::destroy");
    }
    fn open_in_editor(&self, _: &str) {
        unbuilt("QuickLookWindow::open_in_editor");
    }
}

impl main_core::shell::quick_look::QuickLookEngines for Unbuilt {
    fn parse_file_to_text(
        &self,
        _: &str,
    ) -> Result<main_core::shell::quick_look::ParsedFile, String> {
        unbuilt("QuickLookEngines::parse_file_to_text");
        Err(NOT_BUILT.into())
    }
    fn open_zip(&self, _: &[u8]) -> Option<Box<dyn main_core::shell::quick_look::ZipArchive>> {
        unbuilt("QuickLookEngines::open_zip");
        None
    }
}

impl DocPickerWindow for Unbuilt {
    fn attach(&self, _: DocPickerControl) {
        unbuilt("DocPickerWindow::attach");
    }
    fn lang(&self) -> Lang {
        unbuilt("DocPickerWindow::lang");
        Lang::Ko
    }
    fn theme(&self) -> String {
        unbuilt("DocPickerWindow::theme");
        String::new()
    }
    fn create(&self, _: &DocPickerWindowOptions) -> ViewId {
        unbuilt("DocPickerWindow::create");
        panic!("DocPickerWindow::create is not built yet")
    }
    fn show(&self) {
        unbuilt("DocPickerWindow::show");
    }
    fn focus(&self) {
        unbuilt("DocPickerWindow::focus");
    }
    fn close(&self) {
        unbuilt("DocPickerWindow::close");
    }
}

impl DocPickerSources for Unbuilt {
    fn asker_for(&self, _: ViewId) -> DocAsker {
        unbuilt("DocPickerSources::asker_for");
        DocAsker::default()
    }
}

impl main_core::shell::doc_picker::doc_list::DocListDeps for Unbuilt {
    fn open_documents(&self) -> Vec<OpenDocumentEntry> {
        unbuilt("DocListDeps::open_documents");
        Vec::new()
    }
    fn recent(&self) -> Vec<RecentDocumentEntry> {
        unbuilt("DocListDeps::recent");
        Vec::new()
    }
    fn project_files(&self, _: &DocAsker) -> Vec<ProjectFile> {
        unbuilt("DocListDeps::project_files");
        Vec::new()
    }
    fn stat(&self, _: &str) -> Option<f64> {
        unbuilt("DocListDeps::stat");
        None
    }
}

impl DocsTabs for Unbuilt {
    fn open_tab(&self, _: Option<&str>, _: bool) {
        unbuilt("DocsTabs::open_tab");
    }
    fn list_tabs(&self) -> Vec<DocsTab> {
        unbuilt("DocsTabs::list_tabs");
        Vec::new()
    }
    fn focus_tab(&self, _: &str) {
        unbuilt("DocsTabs::focus_tab");
    }
}

impl OpenFiles for Unbuilt {
    fn open_files(&self) -> Result<Vec<OpenFileState>, OpenFilesSourceFailed> {
        unbuilt("OpenFiles::open_files");
        panic!("OpenFiles::open_files is not built yet")
    }
}

impl FileParse for Unbuilt {
    fn parse_file_to_text(
        &self,
        _: &std::path::Path,
    ) -> Result<shell_ipc_w::editor_files::ParsedFile, String> {
        unbuilt("FileParse::parse_file_to_text");
        Err(NOT_BUILT.into())
    }
    fn diagram_picture_ext(&self, _: &std::path::Path) -> Option<&'static str> {
        unbuilt("FileParse::diagram_picture_ext");
        None
    }
}

impl UiLanguage for Unbuilt {
    fn lang(&self) -> Lang {
        unbuilt("UiLanguage::lang");
        Lang::Ko
    }
}

impl SheetsTabs for Unbuilt {
    fn is_tab(&self, _: ViewId) -> bool {
        unbuilt("SheetsTabs::is_tab");
        false
    }
    fn external_link_source(&self, _: ViewId, _: &str, _: u64) -> Option<String> {
        unbuilt("SheetsTabs::external_link_source");
        None
    }
}

impl HomeFiles for Unbuilt {
    fn now_ms(&self) -> f64 {
        unbuilt("HomeFiles::now_ms");
        0.0
    }
    fn system_locale(&self) -> String {
        unbuilt("HomeFiles::system_locale");
        String::new()
    }
    fn open_document_path(&self, _: &str) -> bool {
        unbuilt("HomeFiles::open_document_path");
        false
    }
    fn open_dropped_files(&self, _: Vec<String>) {
        unbuilt("HomeFiles::open_dropped_files");
    }
    fn open_file_paths(&self) -> Vec<String> {
        unbuilt("HomeFiles::open_file_paths");
        Vec::new()
    }
    fn project_file_paths(&self) -> Vec<String> {
        unbuilt("HomeFiles::project_file_paths");
        Vec::new()
    }
    fn slides_recent_files(&self) -> Vec<String> {
        unbuilt("HomeFiles::slides_recent_files");
        Vec::new()
    }
    fn document_link_paths(&self) -> Vec<String> {
        unbuilt("HomeFiles::document_link_paths");
        Vec::new()
    }
    fn project_file_renamed(&self, _: &str, _: &str) {
        unbuilt("HomeFiles::project_file_renamed");
    }
    fn file_moved(&self, _: &str, _: &str) {
        unbuilt("HomeFiles::file_moved");
    }
    fn recents_changed(&self) {
        unbuilt("HomeFiles::recents_changed");
    }
    fn open_recycle_bin(&self) {
        unbuilt("HomeFiles::open_recycle_bin");
    }
}

impl FileSearch for Unbuilt {
    fn available(&self) -> bool {
        unbuilt("FileSearch::available");
        false
    }
    fn refresh_if_stale(&self, _: f64) {
        unbuilt("FileSearch::refresh_if_stale");
    }
    fn refresh(&self) {
        unbuilt("FileSearch::refresh");
    }
    fn search(&self, _: &str, _: Option<&[String]>, _: f64, _: f64) -> SearchResult {
        unbuilt("FileSearch::search");
        SearchResult {
            hits: Vec::new(),
            total: 0.0,
        }
    }
    fn progress(&self) -> IndexProgress {
        unbuilt("FileSearch::progress");
        IndexProgress {
            indexed: 0.0,
            pending: 0.0,
            scanning: false,
        }
    }
    fn rerank(&self, _: &str, _: &[String]) -> Option<IpcValue> {
        unbuilt("FileSearch::rerank");
        None
    }
}

impl FolderTree for Unbuilt {
    fn list_folder(&self, _: &str, _: &HashSet<String>) -> FolderListing {
        unbuilt("FolderTree::list_folder");
        panic!("FolderTree::list_folder is not built yet")
    }
    fn create_folder(&self, _: &str, _: &str, _: &FolderErrors) -> RenameResult {
        unbuilt("FolderTree::create_folder");
        RenameResult {
            ok: false,
            path: None,
            error: Some("not built yet".into()),
        }
    }
    fn rename_folder(&self, _: &str, _: &str, _: &FolderErrors) -> RenameResult {
        unbuilt("FolderTree::rename_folder");
        RenameResult {
            ok: false,
            path: None,
            error: Some("not built yet".into()),
        }
    }
    fn move_paths_into(
        &self,
        _: &[String],
        _: &str,
        _: MoveConflictPolicy,
        _: &FolderErrors,
        _: &mut dyn MoveOptions,
    ) -> Result<MoveResult, Option<String>> {
        unbuilt("FolderTree::move_paths_into");
        Err(Some(NOT_BUILT.into()))
    }
}

impl FolderWatch for Unbuilt {
    fn watch(&self, _: &[String], _: Arc<dyn Fn(Vec<String>) + Send + Sync>) {
        unbuilt("FolderWatch::watch");
    }
}

impl HomeApp for Unbuilt {
    fn version(&self) -> String {
        unbuilt("HomeApp::version");
        String::new()
    }
    fn is_packaged(&self) -> bool {
        unbuilt("HomeApp::is_packaged");
        false
    }
    fn locale(&self) -> String {
        unbuilt("HomeApp::locale");
        String::new()
    }
    fn os_release(&self) -> String {
        unbuilt("HomeApp::os_release");
        String::new()
    }
    fn now_ms(&self) -> f64 {
        unbuilt("HomeApp::now_ms");
        0.0
    }
    fn third_party_notices_path(&self) -> PathBuf {
        unbuilt("HomeApp::third_party_notices_path");
        PathBuf::new()
    }
    fn open_help(&self, _: Option<&str>) {
        unbuilt("HomeApp::open_help");
    }
    fn auto_update_check_changed(&self, _: bool) {
        unbuilt("HomeApp::auto_update_check_changed");
    }
    fn delimited_import_limit_changed(&self, _: f64) {
        unbuilt("HomeApp::delimited_import_limit_changed");
    }
    fn home_kinds_changed(&self) {
        unbuilt("HomeApp::home_kinds_changed");
    }
    fn folder_watchers_changed(&self) {
        unbuilt("HomeApp::folder_watchers_changed");
    }
    fn secrets(&self) -> Option<&dyn AiSecretCodec> {
        unbuilt("HomeApp::secrets");
        None
    }
    fn probe_decision(&self, _: &FileSearchSettings) -> Result<(), String> {
        unbuilt("HomeApp::probe_decision");
        Err(NOT_BUILT.into())
    }
    fn mcp_status(&self) -> McpStatus {
        unbuilt("HomeApp::mcp_status");
        not_running()
    }
    fn mcp_apply(&self, _: McpSettings) -> Result<McpStatus, String> {
        unbuilt("HomeApp::mcp_apply");
        Err(NOT_BUILT.into())
    }
    fn mcp_logs(&self) -> Vec<String> {
        unbuilt("HomeApp::mcp_logs");
        Vec::new()
    }
    fn mcp_clear_logs(&self) {
        unbuilt("HomeApp::mcp_clear_logs");
    }
    fn mcp_reveal_log_file(&self) {
        unbuilt("HomeApp::mcp_reveal_log_file");
    }
    fn mcp_log_file(&self) -> Option<PathBuf> {
        unbuilt("HomeApp::mcp_log_file");
        None
    }
}

impl WindowsHost for Unbuilt {
    fn attach(&self, _: Arc<dyn HostEvents>) {
        unbuilt("WindowsHost::attach");
    }
    fn shell_window(&self) -> Option<ShellWindow> {
        unbuilt("WindowsHost::shell_window");
        None
    }
    fn create_shell_window(&self) -> ShellWindow {
        unbuilt("WindowsHost::create_shell_window");
        panic!("WindowsHost::create_shell_window is not built yet")
    }
    fn window_state(&self, _: WindowId) -> WindowState {
        unbuilt("WindowsHost::window_state");
        panic!("WindowsHost::window_state is not built yet")
    }
    fn create_window(&self, _: &WindowOptions) -> WindowId {
        unbuilt("WindowsHost::create_window");
        panic!("WindowsHost::create_window is not built yet")
    }
    fn window_restore(&self, _: WindowId) {
        unbuilt("WindowsHost::window_restore");
    }
    fn window_show(&self, _: WindowId) {
        unbuilt("WindowsHost::window_show");
    }
    fn window_show_inactive(&self, _: WindowId) {
        unbuilt("WindowsHost::window_show_inactive");
    }
    fn window_focus(&self, _: WindowId) {
        unbuilt("WindowsHost::window_focus");
    }
    fn window_destroy(&self, _: WindowId) {
        unbuilt("WindowsHost::window_destroy");
    }
    fn window_set_title(&self, _: WindowId, _: &str) {
        unbuilt("WindowsHost::window_set_title");
    }
    fn window_set_position(&self, _: WindowId, _: f64, _: f64) {
        unbuilt("WindowsHost::window_set_position");
    }
    fn window_set_frame(&self, _: WindowId, _: &main_core::shell::split_layout::Rect) {
        unbuilt("WindowsHost::window_set_frame");
    }
    fn window_work_area(&self, _: WindowId) -> main_core::shell::split_layout::Rect {
        unbuilt("WindowsHost::window_work_area");
        panic!("WindowsHost::window_work_area is not built yet")
    }
    fn add_child_view(&self, _: WindowId, _: ViewId) {
        unbuilt("WindowsHost::add_child_view");
    }
    fn remove_child_view(&self, _: WindowId, _: ViewId) {
        unbuilt("WindowsHost::remove_child_view");
    }
    fn view_destroyed(&self, _: ViewId) -> bool {
        unbuilt("WindowsHost::view_destroyed");
        false
    }
    fn view_set_visible(&self, _: ViewId, _: bool) {
        unbuilt("WindowsHost::view_set_visible");
    }
    fn view_set_bounds(&self, _: ViewId, _: &main_core::shell::split_layout::Rect) {
        unbuilt("WindowsHost::view_set_bounds");
    }
    fn view_focus(&self, _: ViewId) {
        unbuilt("WindowsHost::view_focus");
    }
    fn view_close(&self, _: ViewId) {
        unbuilt("WindowsHost::view_close");
    }
    fn view_reload(&self, _: ViewId) {
        unbuilt("WindowsHost::view_reload");
    }
    fn view_load_url(&self, _: ViewId, _: &str) {
        unbuilt("WindowsHost::view_load_url");
    }
    fn view_listen(&self, _: ViewId, _: ViewListen) {
        unbuilt("WindowsHost::view_listen");
    }
    fn watch_page_load(&self, _: ViewId, _: u64) {
        unbuilt("WindowsHost::watch_page_load");
    }
    fn create_help_view(&self) -> ViewId {
        unbuilt("WindowsHost::create_help_view");
        panic!("WindowsHost::create_help_view is not built yet")
    }
    fn cursor_point(&self) -> (f64, f64) {
        unbuilt("WindowsHost::cursor_point");
        panic!("WindowsHost::cursor_point is not built yet")
    }
    fn display_work_area(&self, _: (f64, f64)) -> main_core::shell::split_layout::Rect {
        unbuilt("WindowsHost::display_work_area");
        panic!("WindowsHost::display_work_area is not built yet")
    }
    fn set_timer(&self, _: TimerKey, _: f64) {
        unbuilt("WindowsHost::set_timer");
    }
    fn clear_timer(&self, _: TimerKey) {
        unbuilt("WindowsHost::clear_timer");
    }
    fn popup_menu(
        &self,
        _: WindowId,
        _: &[shell_ipc_w::tabs::MenuEntry],
        _: Option<(f64, f64)>,
        _: u64,
    ) {
        unbuilt("WindowsHost::popup_menu");
    }
}

impl TabHooks for Unbuilt {
    fn create_view(
        &self,
        _: &main_core::shell::tab_manager::ViewSpec<'_>,
    ) -> Result<ViewId, TabError> {
        unbuilt("TabHooks::create_view");
        panic!("TabHooks::create_view is not built yet")
    }
    fn sheets_pending_edit_count(&self, _: i64) -> f64 {
        unbuilt("TabHooks::sheets_pending_edit_count");
        0.0
    }
    fn family_is_dirty(&self, _: TabKind, _: i64) -> bool {
        unbuilt("TabHooks::family_is_dirty");
        false
    }
    fn hwp_memo_modal_open(&self, _: i64) -> bool {
        unbuilt("TabHooks::hwp_memo_modal_open");
        false
    }
    fn docs_query_dirty(&self, _: ViewId, _: Box<dyn FnOnce(Result<bool, IpcError>)>) {
        unbuilt("TabHooks::docs_query_dirty");
    }
    fn set_active_docs_resolver(&self, _: Option<ViewId>, _: bool) {
        unbuilt("TabHooks::set_active_docs_resolver");
    }
    fn set_active_sheets_web_contents(&self, _: Option<ViewId>) {
        unbuilt("TabHooks::set_active_sheets_web_contents");
    }
    fn set_active_slides_web_contents(&self, _: ViewId) {
        unbuilt("TabHooks::set_active_slides_web_contents");
    }
    fn apply_menu_for(&self, kind: TabKind) {
        super::menu::apply_menu(kind);
    }
    fn teardown_docs_renderer(&self, _: ViewId) {
        unbuilt("TabHooks::teardown_docs_renderer");
    }
    fn release_closed_renderer(&self, _: ViewId) {
        unbuilt("TabHooks::release_closed_renderer");
    }
    fn mark_docs_new_blank(&self, _: i64) {
        unbuilt("TabHooks::mark_docs_new_blank");
    }
    fn queue_docs_ai_content(&self, _: i64, _: &serde_json::Value) {
        unbuilt("TabHooks::queue_docs_ai_content");
    }
    fn queue_docs_copy(&self, _: i64, _: &str, _: &str) {
        unbuilt("TabHooks::queue_docs_copy");
    }
    fn set_sheets_new_blank(&self) {
        unbuilt("TabHooks::set_sheets_new_blank");
    }
    fn queue_workbook_for_view(&self, _: ViewId, _: &str) {
        unbuilt("TabHooks::queue_workbook_for_view");
    }
    fn nudge_queued_workbook(&self, _: ViewId) {
        unbuilt("TabHooks::nudge_queued_workbook");
    }
    fn mark_pdf_untitled_copy(&self, _: &str) {
        unbuilt("TabHooks::mark_pdf_untitled_copy");
    }
    fn clear_pdf_dirty(&self, _: i64) {
        unbuilt("TabHooks::clear_pdf_dirty");
    }
    fn queue_markdown_seed_for(&self, _: ViewId, _: &str) {
        unbuilt("TabHooks::queue_markdown_seed_for");
    }
    fn queue_html_seed_for(&self, _: ViewId, _: &str) {
        unbuilt("TabHooks::queue_html_seed_for");
    }
    fn queue_mindmap_seed_for(&self, _: ViewId, _: &[u8]) {
        unbuilt("TabHooks::queue_mindmap_seed_for");
    }
    fn queue_slides_seed_for(&self, _: ViewId, _: &[u8], _: &str) {
        unbuilt("TabHooks::queue_slides_seed_for");
    }
    fn queue_generate_handoff_for(&self, _: ViewId, _: &serde_json::Value) {
        unbuilt("TabHooks::queue_generate_handoff_for");
    }
    fn queue_converted_content(&self, _: ViewId, _: &serde_json::Value) {
        unbuilt("TabHooks::queue_converted_content");
    }
    fn drop_generate_handoff(&self, _: i64) {
        unbuilt("TabHooks::drop_generate_handoff");
    }
    fn diagram_tab_identity(&self, _: i64) -> Option<DiagramIdentity> {
        unbuilt("TabHooks::diagram_tab_identity");
        None
    }
    fn opener_open(
        &self,
        _: &Opener,
        _: &UnloadedTabOpenContext,
    ) -> Result<LoadedTabView<ViewId>, String> {
        unbuilt("TabHooks::opener_open");
        Err(NOT_BUILT.into())
    }
    fn reset_sheets_shutting_down(&self) {
        unbuilt("TabHooks::reset_sheets_shutting_down");
    }
    fn cancel_update_restart(&self) {
        unbuilt("TabHooks::cancel_update_restart");
    }
    fn resume_discarded_copies(&self) {
        unbuilt("TabHooks::resume_discarded_copies");
    }
    fn pdf_close_cancelled(&self, _: ViewId) {
        unbuilt("TabHooks::pdf_close_cancelled");
    }
    fn ui_scale(&self) -> f64 {
        unbuilt("TabHooks::ui_scale");
        0.0
    }
    fn no_spare_view_env(&self) -> bool {
        unbuilt("TabHooks::no_spare_view_env");
        false
    }
    fn renderer_dev_url(&self) -> Option<String> {
        unbuilt("TabHooks::renderer_dev_url");
        None
    }
    fn tm(&self, _: &str) -> String {
        unbuilt("TabHooks::tm");
        String::new()
    }
    fn tm_params(&self, _: &str, _: &[(&str, &str)]) -> String {
        unbuilt("TabHooks::tm_params");
        String::new()
    }
    fn random_uuid(&self) -> String {
        unbuilt("TabHooks::random_uuid");
        String::new()
    }
    fn warn(&self, _: &str, _: &str) {
        unbuilt("TabHooks::warn");
    }
    fn tabs_changed(&self, _: &TabsChanged) {
        unbuilt("TabHooks::tabs_changed");
    }
    fn split_changed(&self, _: Option<&SplitViewState>) {
        unbuilt("TabHooks::split_changed");
    }
    fn detached_changed(&self) {
        unbuilt("TabHooks::detached_changed");
    }
    fn app_menu_popup(&self) -> Option<Vec<shell_ipc_w::tabs::MenuEntry>> {
        unbuilt("TabHooks::app_menu_popup");
        None
    }
    fn app_menu_activate(&self, _: u32) {
        unbuilt("TabHooks::app_menu_activate");
    }
    fn visible_home_kinds(&self) -> Vec<String> {
        unbuilt("TabHooks::visible_home_kinds");
        Vec::new()
    }
    fn drive_reopen(&self, _: &str) -> bool {
        unbuilt("TabHooks::drive_reopen");
        false
    }
    fn record_recent_file(&self, _: &str) {
        unbuilt("TabHooks::record_recent_file");
    }
    fn notify_unsupported_file(&self, _: &str) {
        unbuilt("TabHooks::notify_unsupported_file");
    }
    fn show_app_warning(&self, _: &str, _: Option<&str>) {
        unbuilt("TabHooks::show_app_warning");
    }
    fn diagram_open_refusal(&self, _: &str) -> Option<String> {
        unbuilt("TabHooks::diagram_open_refusal");
        None
    }
    fn start_queued_workbook_nudge(&self) {
        unbuilt("TabHooks::start_queued_workbook_nudge");
    }
    fn default_save_dir(&self) -> String {
        unbuilt("TabHooks::default_save_dir");
        String::new()
    }
    fn blank_xlsx(&self) -> Vec<u8> {
        unbuilt("TabHooks::blank_xlsx");
        Vec::new()
    }
    fn blank_pdf(&self) -> Vec<u8> {
        unbuilt("TabHooks::blank_pdf");
        Vec::new()
    }
    fn unique_path_in(&self, _: &str, _: &str) -> String {
        unbuilt("TabHooks::unique_path_in");
        String::new()
    }
    fn sheets_suggested_path_taken(&self, _: &str) -> bool {
        unbuilt("TabHooks::sheets_suggested_path_taken");
        false
    }
    fn mark_sheets_unsaved_new(&self, _: &str, _: &str, _: &str) {
        unbuilt("TabHooks::mark_sheets_unsaved_new");
    }
    fn unmark_sheets_unsaved_new(&self, _: &str) {
        unbuilt("TabHooks::unmark_sheets_unsaved_new");
    }
    fn mark_sheets_untitled_path(&self, _: &str) {
        unbuilt("TabHooks::mark_sheets_untitled_path");
    }
    fn mark_pdf_untitled_path(&self, _: &str) {
        unbuilt("TabHooks::mark_pdf_untitled_path");
    }
    fn show_error_dialog(&self, _: &str, _: &str) {
        unbuilt("TabHooks::show_error_dialog");
    }
    fn open_agent_window(&self) {
        unbuilt("TabHooks::open_agent_window");
    }
    fn drop_skill_file(&self, _: &str) -> bool {
        unbuilt("TabHooks::drop_skill_file");
        false
    }
    fn drop_no_skills_found(&self) {
        unbuilt("TabHooks::drop_no_skills_found");
    }
    fn is_inside_root(&self, _: &str, _: &str) -> bool {
        unbuilt("TabHooks::is_inside_root");
        false
    }
    fn open_file_via_dialog(&self) {
        unbuilt("TabHooks::open_file_via_dialog");
    }
    fn tab_document_action(&self, _: TabKind, _: ViewId, _: &str, _: Option<&str>, _: DocAction) {
        unbuilt("TabHooks::tab_document_action");
    }
}
