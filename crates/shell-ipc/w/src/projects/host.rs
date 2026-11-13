//! What the project folder handlers need from the shell beyond what `main-core`
//! has ported, the shared hosts (dialogs, the OS shell) and the tab strip
//! ([`crate::tabs::TabsState`], read through `Provided`).
//!
//! Three hosts, all `Send + Sync` and held in `shell_contract::Hosts`:
//!
//! - [`ProjectsHost`]: the platform half. The clock of the process is
//!   [`crate::home_files::HomeFiles::now_ms`]; this adds what a project folder
//!   asks of the process besides it: random bytes, the local time zone, the
//!   user's home, `Intl`, the Windows attribute listing, the page events of a
//!   view and the timers the TypeScript set with `setTimeout`.
//! - [`ProjectFiles`]: the home search index and the knowledge base's reader,
//!   which the AI's search and read tools call (neither is in `main-core`).
//! - [`LegacyProjectStore`]: the app-data `ProjectStore` of
//!   `packages/project-store/src/store.ts` behind the four `project:*`
//!   channels and the "earlier chats of this document" row of the chat list
//!   (it is not in `main-core` either).
//!
//! Nothing here blocks the core thread on a renderer. The two things that
//! waited in TypeScript, a modal question and the person's return to a page,
//! are a message box through `DialogsHost` and a [`PageEvent`] the host
//! reports later.

use std::sync::Arc;

use main_core::packages::electron_utils::default_save_dir::Thrown;
use main_core::packages::electron_utils::unsaved_files::{OpenFileState, OpenFilesSourceFailed};
use main_core::packages::i18n::Lang;
use main_core::packages::project_store::LegacyDocumentChat;
use main_core::shell::knowledge_base::KbReadPage;
use main_core::shell::projects::memory::LocalDateParts;
use main_core::shell::projects::project_tools::{IndexSearchOptions, IndexSearchResult};
use serde_json::Value;
use shell_contract::ids::ViewId;

/// A timer the TypeScript set with `setTimeout` and the core thread asks the
/// host to run
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProjectTimer {
    /// `setTimeout(arm, TRUST_RETURN_ARM_MS)` of the wait number `n` for the
    /// person's return to a page
    ReturnArm(u64),
    /// `setTimeout(flushTouches, ...)` of the project guide's use times
    Touches,
}

/// What the host reports of a page, always on the core thread
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageEvent {
    /// the view's `webContents` was destroyed
    Destroyed(ViewId),
    /// a main-frame navigation to another document started (`did-start-navigation`
    /// with `isMainFrame` and not `isSameDocument`)
    Navigated(ViewId),
    /// the page lost the focus
    Blur(ViewId),
    /// the page took the focus
    Focus(ViewId),
    /// a [`ProjectTimer`] fired
    Timer(ProjectTimer),
}

/// Where the host sends [`PageEvent`]s. Callable from any thread; the event is
/// run on the core thread, in the order it was sent.
pub trait PageEvents: Send + Sync {
    fn send(&self, event: PageEvent);
}

pub trait ProjectsHost: Send + Sync {
    /// Called once at registration: where to send [`PageEvent`]s
    fn attach(&self, events: Arc<dyn PageEvents>);
    /// `trackProjectContents(contents)`: from now on report this view's
    /// [`PageEvent::Destroyed`] and [`PageEvent::Navigated`] (once per view)
    fn track(&self, view: ViewId);
    /// `page.isDestroyed()` of the page `waitForPageReturn` is given
    fn page_destroyed(&self, view: ViewId) -> bool;
    /// `waitForPageReturn(page)`: start reporting the view's [`PageEvent::Blur`],
    /// [`PageEvent::Focus`] and [`PageEvent::Destroyed`] (its page is not
    /// destroyed)
    fn watch_return(&self, view: ViewId);
    /// the wait ended: stop reporting its focus and blur
    fn stop_return(&self, view: ViewId);
    /// `setTimeout(fire, delay_ms)`: report [`PageEvent::Timer`] with `key` once
    /// `delay_ms` have passed
    fn set_timer(&self, key: ProjectTimer, delay_ms: f64);
    /// `clearTimeout(timer)`
    fn clear_timer(&self, key: ProjectTimer);
    /// `n` random bytes (`crypto.randomBytes(n)`): project, chat and scope ids
    fn random_bytes(&self, n: usize) -> Vec<u8>;
    /// the calendar date and time of a time value in the local time zone
    /// (`getFullYear()` and the other local getters of a `Date`)
    fn local_date(&self, at_ms: f64) -> LocalDateParts;
    /// `os.homedir()`
    fn os_home_dir(&self) -> String;
    /// `new Intl.NumberFormat(lang).format(count)`
    fn format_number(&self, count: f64, lang: Lang) -> Result<String, String>;
    /// `new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' })
    /// .format(at_ms)` in the process time zone
    fn format_date_time(&self, at_ms: f64, lang: Lang) -> Result<String, String>;
    /// `execFileListing`: starts `file` without a shell, hidden, killed after
    /// `timeout_ms`, writes `input` to its standard input and answers its
    /// standard output (at most `MAX_LISTING_BYTES`). Only Windows asks.
    fn run_listing(
        &self,
        file: &str,
        args: &[String],
        cwd: &str,
        env: &[(String, String)],
        timeout_ms: f64,
        input: &str,
    ) -> Result<String, String>;
    /// `console.warn(label, error)` of the project modules; `detail` is the
    /// message of the error
    fn warn(&self, label: &str, detail: Option<&str>);
}

pub type ProjectsHostRef = Arc<dyn ProjectsHost>;

/// The home search index and the knowledge base's reader for the AI's tools
pub trait ProjectFiles: Send + Sync {
    /// `fileIndexStore.search(input, { offset, limit, exts?, within })`: the
    /// files whose path passes `within`, ranked and paged. `Err` is a throw of
    /// `within` or of the store.
    fn search(
        &self,
        input: &str,
        options: &mut IndexSearchOptions<'_>,
    ) -> Result<IndexSearchResult, Thrown>;
    /// `fileIndexStore.pathsIndexedAsOnDisk(paths)`
    fn paths_indexed_as_on_disk(&self, paths: &[String]) -> Vec<String>;
    /// `readKnowledgeFilePage(filePath, offset)`: the file parsed to text, one
    /// page of it. Waits for the parser: it runs on the core thread's call.
    fn read_page(&self, file_path: &str, offset: f64) -> Result<KbReadPage, Thrown>;
    /// `setOpenFilesSource(...)`'s list: `[...tabManager.openDocuments(),
    /// ...detachedOpenDocuments()]` with each document's dirty state. A call
    /// that cannot say is an `Err`: every file then counts as open with
    /// unsaved changes. It answers at once: the dirty state of a document the
    /// renderer owns is what the editors last reported, never a question to
    /// the renderer from the core thread.
    fn open_files(&self) -> Result<Vec<OpenFileState>, OpenFilesSourceFailed>;
}

pub type ProjectFilesHost = Arc<dyn ProjectFiles>;

/// The app-data project store (`packages/project-store/src/store.ts`) and the
/// two facts of the shell that `project:resolveChat` and `project:rebindChat`
/// read besides it. An `Err` is the message of what the store throws.
pub trait LegacyProjectStore: Send + Sync {
    /// `legacyDocumentChatFor(filePath)`: the per-document chat a saved
    /// document already has, found without creating one
    fn legacy_chat_for(&self, doc_path: &str) -> Result<Option<LegacyDocumentChat>, String>;
    /// `store.ensureDefaultProject()`
    fn ensure_default_project(&self) -> Result<(), String>;
    /// `store.resolveChatForFile(path)`: `{ projectId, chatId }`
    fn resolve_chat_for_file(&self, path: &Value) -> Result<Value, String>;
    /// `store.lookupChatForFile(path)`: `{ projectId, chatId }`, nothing written
    fn lookup_chat_for_file(&self, path: &Value) -> Result<Value, String>;
    /// `store.appendChatMessage(projectId, chatId, message)`; `message` is the
    /// `{ role, text, tools?, attachments?, scope?, skills? }` the handler built
    fn append_chat_message(
        &self,
        project_id: &Value,
        chat_id: &Value,
        message: &Value,
    ) -> Result<(), String>;
    /// `store.loadChat(projectId, chatId, limit)`: the messages
    fn load_chat(
        &self,
        project_id: &Value,
        chat_id: &Value,
        limit: &Value,
    ) -> Result<Value, String>;
    /// `store.rebindChatToFile(projectId, tempChatId, path)`: `{ projectId, chatId }`
    fn rebind_chat_to_file(
        &self,
        project_id: &Value,
        temp_chat_id: &Value,
        path: &Value,
    ) -> Result<Value, String>;
    /// `store.rebindChat(projectId, tempChatId, newChatId)`
    fn rebind_chat(
        &self,
        project_id: &Value,
        temp_chat_id: &Value,
        new_chat_id: &Value,
    ) -> Result<(), String>;
    /// `sessionPathResolver(senderId, sessionId)`: the file a sheets session of
    /// the sender shows (`resolveSheetsSessionPath` of the shell's entry)
    fn sheets_session_path(&self, sender: ViewId, session_id: &Value) -> Option<String>;
    /// `isHeadlessMode()`
    fn headless(&self) -> bool;
}

pub type LegacyProjectStoreHost = Arc<dyn LegacyProjectStore>;
