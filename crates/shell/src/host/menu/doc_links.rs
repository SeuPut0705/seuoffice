//! `document-links-shell.ts` in the shell: the provenance records (spec 9)
//! and the editors' File-menu entries "make another document from this one",
//! "View Sources" and "Documents Made from This" (spec 8.2), through
//! main-core's [`DocumentLinksShell`].
//!
//! The records follow the hand-off store's events, and "make" opens the make
//! window, both batch A's. Until A's host calls [`attach_make_window`] there
//! are no records and the entries stay out of the File menus.
//!
//! Everything here runs on the core thread. The calls the other batches make:
//! - [`note_document_saved`]: the editors' save hooks (markdown, html, mind
//!   map; slides' opened hook with `may_be_open`)
//! - [`document_link_file_moved`]: the in-app rename/move (`afterFileMoved`,
//!   the PDF auto-rename)
//! - [`document_link_paths`]: every path the records mention, for folder moves
//! - [`make_from_document`]: the mind map's toolbar button
//! - [`document_view_destroyed`]: a view went away (`once('destroyed')`)
//!
//! What leaves this module while the records are borrowed (opening a path,
//! the make window) is run once the borrow ends, so a batch the call reaches
//! may call back in.

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use main_core::packages::electron_utils::generate_handoff::HandoffStore;
use main_core::packages::i18n::Lang;
use main_core::shell::document_links::{
    FileLinksDeps, LinkedWebContents, StatTimes, document_links_at, handoff_store_events,
    stat_sync, watch_make_events,
};
use main_core::shell::document_links_menu::{DocumentLinkMenuLabels, MenuClick, MenuItem};
use main_core::shell::document_links_shell::{
    DocumentContents, DocumentLinksShell, DocumentLinksShellHost, GenerateWindowRequest,
    LinkedDocument,
};
use main_core::shell::tab_manager::TabKind;
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::runtime::{PathName, Services};
use shell_ipc_m::{MenuDict, current_lang, menu_label};

use super::super::shell_tabs::{ShellTabs, shell_tabs};
use super::super::w::post_core;
use super::super::window::Windows;

/// What A's host hands over: the make window's opener
pub(crate) type OpenMakeWindow = Box<dyn Fn(GenerateWindowRequest<WindowId>)>;

type Links = DocumentLinksShell<Host, FileLinksDeps<'static>>;

thread_local! {
    static LINKS: RefCell<Option<Links>> = const { RefCell::new(None) };
    /// what A attached, until the post that configures the records takes it
    static ATTACHED: RefCell<Option<(Rc<RefCell<HandoffStore>>, OpenMakeWindow)>> =
        const { RefCell::new(None) };
    /// calls out of this module made while the records were borrowed
    static DEFERRED: RefCell<Vec<Box<dyn FnOnce()>>> = const { RefCell::new(Vec::new()) };
}

/// The views, for `webContents.isDestroyed()`
static WINDOWS: OnceLock<Arc<Windows>> = OnceLock::new();

pub(super) fn install(windows: Arc<Windows>) {
    let _ = WINDOWS.set(windows);
}

/// A's host, once on the core thread: the hand-off store whose events the
/// records follow, and the make window. `configureDocumentLinks` runs on the
/// next turn of the core thread, where the tabs are reachable.
#[allow(dead_code)] // called by batch A's host
pub(crate) fn attach_make_window(store: Rc<RefCell<HandoffStore>>, open: OpenMakeWindow) {
    ATTACHED.with(|a| *a.borrow_mut() = Some((store, open)));
    post_core(|provided, services| {
        let Some((store, open)) = ATTACHED.with(|a| a.borrow_mut().take()) else {
            return;
        };
        let Some(tabs) = shell_tabs(provided) else {
            eprintln!("shell: document links: no tab manager");
            return;
        };
        configure(tabs, services.clone(), store, open);
    });
}

fn configure(
    tabs: Rc<dyn ShellTabs>,
    services: Services,
    store: Rc<RefCell<HandoffStore>>,
    open: OpenMakeWindow,
) {
    let host = Host {
        tabs: tabs.clone(),
        services,
        open: Rc::new(open),
    };
    let mut links: Links = DocumentLinksShell::new();
    let events = store.clone();
    links.configure(
        host,
        |file| {
            document_links_at(
                file,
                Box::new(move || match events.try_borrow() {
                    Ok(store) => handoff_store_events(&store),
                    // the store records a run right now; its event queues a sync
                    Err(_) => Vec::new(),
                }),
                Box::new(now_ms),
                Box::new(|message, error| eprintln!("{message} {error}")),
            )
        },
        |on_event| {
            watch_make_events(
                &mut store.borrow_mut(),
                Box::new(move |id| {
                    // `queueMicrotask(onEvent)`: the store adds the record after this
                    post_core(|_, _| {
                        with_links(|links| {
                            if let Err(error) = links.flush_make_events() {
                                eprintln!("shell: document links: {error:?}");
                            }
                        });
                    });
                    tabs.tab_id_for(view_of(id))
                }),
                on_event,
            )
        },
    );
    LINKS.with(|l| *l.borrow_mut() = Some(links));
    run_deferred();
}

/// Runs `job` on the records, then what it left for after the borrow; `None`
/// before A attached, or when called back from inside another call
fn with_links<R>(job: impl FnOnce(&mut Links) -> R) -> Option<R> {
    let result = LINKS.with(|l| {
        let Ok(mut links) = l.try_borrow_mut() else {
            eprintln!("shell: document links: called back while busy");
            return None;
        };
        links.as_mut().map(job)
    });
    run_deferred();
    result
}

fn run_deferred() {
    loop {
        let jobs = DEFERRED.with(|d| std::mem::take(&mut *d.borrow_mut()));
        if jobs.is_empty() {
            return;
        }
        for job in jobs {
            job();
        }
    }
}

fn defer(job: impl FnOnce() + 'static) {
    DEFERRED.with(|d| d.borrow_mut().push(Box::new(job)));
}

fn view_of(id: f64) -> ViewId {
    ViewId(id as u32)
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

// ---- what the other batches call ----

/// `noteDocumentSaved(wc, path, { mayBeOpen })`: a tab's document landed on a
/// path. `may_be_open`: the hook also fires when a file is opened into the
/// tab (slides), so the path counts only when it was just saved.
#[allow(dead_code)] // called by the editors' save hooks (D1, D2)
pub(crate) fn note_document_saved(view: ViewId, path: &str, may_be_open: bool) {
    with_links(|links| {
        let mut contents = Contents(view);
        if let Err(error) =
            links.note_document_saved(&mut contents, path, may_be_open.then_some(true))
        {
            eprintln!("shell: document links: {error:?}");
        }
    });
}

/// `documentLinkFileMoved(oldPath, newPath)`
#[allow(dead_code)] // called by W's afterFileMoved and D2's PDF rename
pub(crate) fn document_link_file_moved(old_path: &str, new_path: &str) {
    with_links(|links| links.document_link_file_moved(old_path, new_path));
}

/// `documentLinkPaths()`: empty before A attached
#[allow(dead_code)] // called by W's HomeFiles
pub(crate) fn document_link_paths() -> Vec<String> {
    with_links(|links| links.document_link_paths()).unwrap_or_default()
}

/// `makeFromDocument(wc)`
#[allow(dead_code)] // called by D1's mind map host
pub(crate) fn make_from_document(view: ViewId) {
    with_links(|links| links.make_from_document(&Contents(view)));
}

/// `once('destroyed')` of a view the records hold
#[allow(dead_code)] // called by W where the view table drops a view
pub(crate) fn document_view_destroyed(view: ViewId) {
    with_links(|links| {
        if let Some(records) = links.document_links() {
            records.tab_destroyed(f64::from(view.0));
        }
    });
}

// ---- the File menus ----

/// `documentLinkFileMenuItems(kind)`: the entries and the view their clicks
/// act on; nothing before A attached or without a document of that kind
pub(super) fn file_menu(kind: TabKind) -> Option<(Vec<MenuItem>, ViewId)> {
    with_links(|links| {
        let menu = links.document_link_file_menu_items(kind);
        Some((menu.items, menu.contents?.0))
    })
    .flatten()
}

/// A click on one of those entries
pub(super) fn run_click(click: &MenuClick, view: ViewId) {
    with_links(|links| links.run_menu_click(click, &Contents(view)));
}

// ---- the host ----

/// A `webContents` as the records hold it
#[derive(Clone)]
struct Contents(ViewId);

impl LinkedWebContents for Contents {
    fn id(&self) -> f64 {
        f64::from(self.0.0)
    }

    /// [`document_view_destroyed`] runs for every view that goes away
    fn once_destroyed(&mut self) {}
}

impl DocumentContents for Contents {
    fn is_destroyed(&self) -> bool {
        WINDOWS
            .get()
            .is_none_or(|windows| windows.webview(self.0).is_none())
    }
}

struct Host {
    tabs: Rc<dyn ShellTabs>,
    services: Services,
    open: Rc<OpenMakeWindow>,
}

impl Host {
    fn document(&self, view: ViewId) -> Option<LinkedDocument<Contents>> {
        let (title, file_path) = self.tabs.describe_view(view)?;
        Some(LinkedDocument {
            web_contents: Contents(view),
            file_path,
            title,
        })
    }
}

impl DocumentLinksShellHost for Host {
    type Contents = Contents;
    type Window = WindowId;

    fn user_data_path(&mut self) -> String {
        self.services
            .paths
            .path(PathName::UserData)
            .to_string_lossy()
            .into_owned()
    }

    fn active_document(&mut self, kind: TabKind) -> Option<LinkedDocument<Contents>> {
        self.document(self.tabs.active_editor(kind)?)
    }

    fn document_for(&mut self, contents: &Contents) -> Option<LinkedDocument<Contents>> {
        if contents.is_destroyed() {
            return None;
        }
        self.document(contents.0)
    }

    fn parent_for(&mut self, contents: &Contents) -> Option<WindowId> {
        self.tabs.parent_window_for(contents.0)
    }

    fn open_path(&mut self, path: &str) {
        let tabs = self.tabs.clone();
        let path = path.to_owned();
        defer(move || {
            tabs.open_path(&path);
        });
    }

    fn labels(&mut self) -> DocumentLinkMenuLabels {
        let lang = current_lang(&self.services).unwrap_or(Lang::En);
        let label = |key| menu_label(MenuDict::Shell, lang, key);
        DocumentLinkMenuLabels {
            make: label("menuMakeFromDocument"),
            sources: label("menuDocumentSources"),
            derived: label("menuDerivedDocuments"),
        }
    }

    fn menu_kind(&mut self) -> Option<TabKind> {
        self.tabs.menu_kind()
    }

    fn apply_menu(&mut self, kind: TabKind) {
        // posts the build to the core thread: it reads the records after this call
        super::apply_menu(kind);
    }

    fn open_generate_window_for_document(&mut self, request: GenerateWindowRequest<WindowId>) {
        let open = self.open.clone();
        defer(move || open(request));
    }

    fn path_exists(&mut self, path: &str) -> bool {
        Path::new(path).exists()
    }

    fn stat(&mut self, path: &str) -> Result<StatTimes, String> {
        stat_sync(path)
    }

    fn now_ms(&mut self) -> f64 {
        now_ms()
    }

    fn is_mac(&self) -> bool {
        cfg!(target_os = "macos")
    }
}
