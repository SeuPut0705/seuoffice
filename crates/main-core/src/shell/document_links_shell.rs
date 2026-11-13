//! `apps/shell/src/main/document-links-shell.ts`: the shell's side of the
//! provenance records (spec 9) and of the editors' File-menu entry "make
//! another document from this one" (spec 8.2): one record store for the app,
//! fed by the editors' save hooks, the in-app rename/move notification and
//! the hand-off store's events; the File-menu entries every editor shows; the
//! make window opened for one document.
//!
//! The module state of the TypeScript (`deps`, `links`, `shownSignature`) is
//! a [`DocumentLinksShell`] the caller owns. `index.ts`'s supply of tabs,
//! windows and menus is the [`DocumentLinksShellHost`] (`BrowserWindow`,
//! `webContents`, `Menu`, `openGenerateWindowForDocument`, `existsSync`,
//! `Date.now`, `process.platform`). A `Menu` item template is a [`MenuItem`]
//! of data: its `click` is a [`MenuClick`] the caller runs through
//! [`DocumentLinksShell::run_menu_click`]. Two events become explicit
//! methods the caller drives: the listener of `links.onChange` runs inside
//! the call that changed the records, and the `queueMicrotask` of the
//! hand-off store's events is [`DocumentLinksShell::flush_make_events`].
//! `tabIdFor` is the closure the caller gives `watch_make_events`.

use std::cell::Cell;
use std::rc::Rc;

use jscompat::node_path::host::join;
use jscompat::number_to_string;

use crate::shell::crash_log::InvalidTimeValue;
use crate::shell::document_links::{
    DOCUMENT_LINKS_FILE, DocumentLinks, DocumentLinksDeps, LinkedWebContents, MakeEventsWatch,
    StatTimes, document_link_menu_model, is_freshly_saved_path,
};
use crate::shell::document_links_menu::{
    DocumentLinkMenuLabels, MenuClick, MenuItem, document_link_menu_items,
};
use crate::shell::tab_manager::TabKind;

/// the editors whose File menu shows the entries
const EDITOR_KINDS: [TabKind; 7] = [
    TabKind::Docs,
    TabKind::Sheets,
    TabKind::Slides,
    TabKind::Pdf,
    TabKind::Markdown,
    TabKind::Html,
    TabKind::Mindmap,
];

/// a `WebContents` as the shell's links read it
pub trait DocumentContents: LinkedWebContents {
    fn is_destroyed(&self) -> bool;
}

/// `LinkedDocument`: an open document as a menu or the make window sees it
pub struct LinkedDocument<C> {
    pub web_contents: C,
    pub file_path: Option<String>,
    /// the tab or window title; what the make window lists an unsaved document as
    pub title: String,
}

/// the argument of `openGenerateWindowForDocument`; `file_path` is left out of
/// the TypeScript's object when the document has none
pub struct GenerateWindowRequest<W> {
    pub web_contents_id: f64,
    pub file_path: Option<String>,
    pub title: String,
    pub parent: Option<W>,
}

/// `DocumentLinksShellDeps`, with the Electron and OS calls the module makes
/// itself
pub trait DocumentLinksShellHost {
    type Contents: DocumentContents;
    /// `BrowserWindow`
    type Window;

    fn user_data_path(&mut self) -> String;
    /// the document a kind's File menu acts on (the focused detached window of
    /// that kind, else the active tab of that kind)
    fn active_document(&mut self, kind: TabKind) -> Option<LinkedDocument<Self::Contents>>;
    /// the document behind a webContents, in a tab or a detached window
    fn document_for(&mut self, contents: &Self::Contents)
    -> Option<LinkedDocument<Self::Contents>>;
    /// the window the make window sits above
    fn parent_for(&mut self, contents: &Self::Contents) -> Option<Self::Window>;
    /// the usual path to tab route
    fn open_path(&mut self, path: &str);
    fn labels(&mut self) -> DocumentLinkMenuLabels;
    /// the kind whose menu is the application menu now
    fn menu_kind(&mut self) -> Option<TabKind>;
    /// build that kind's menu again
    fn apply_menu(&mut self, kind: TabKind);
    /// `openGenerateWindowForDocument(request)`
    fn open_generate_window_for_document(&mut self, request: GenerateWindowRequest<Self::Window>);
    /// `existsSync(path)`
    fn path_exists(&mut self, path: &str) -> bool;
    /// `statSync(path)`'s two times; `Err` is a stat that throws
    fn stat(&mut self, path: &str) -> Result<StatTimes, String>;
    /// `Date.now()`
    fn now_ms(&mut self) -> f64;
    /// `process.platform === 'darwin'`
    fn is_mac(&self) -> bool;
}

/// the File-menu entries built for one document, and the webContents their
/// clicks act on (`onMake` captures it when the entries are built)
pub struct FileMenu<C> {
    pub items: Vec<MenuItem>,
    pub contents: Option<C>,
}

/// the module state of `document-links-shell.ts`
pub struct DocumentLinksShell<H: DocumentLinksShellHost, D: DocumentLinksDeps> {
    deps: Option<H>,
    links: Option<DocumentLinks<D>>,
    /// what the last built File menu showed: rebuilt only when this changes
    shown_signature: String,
    /// records changed since the listeners were last run
    changes: Rc<Cell<usize>>,
    /// events the hand-off store queued for `links.sync()`
    syncs: Rc<Cell<usize>>,
    watch: Option<MakeEventsWatch>,
}

impl<H: DocumentLinksShellHost, D: DocumentLinksDeps> Default for DocumentLinksShell<H, D> {
    fn default() -> Self {
        Self::new()
    }
}

/// `signature(kind, doc)`
fn signature<C: LinkedWebContents, D: DocumentLinksDeps>(
    kind: TabKind,
    doc: Option<&LinkedDocument<C>>,
    links: Option<&DocumentLinks<D>>,
) -> String {
    match (doc, links) {
        (Some(doc), Some(links)) => format!(
            "{}|{}|{}|{}",
            kind.as_str(),
            number_to_string(doc.web_contents.id()),
            doc.file_path.as_deref().unwrap_or(""),
            links.version()
        ),
        _ => format!("{}|", kind.as_str()),
    }
}

impl<H: DocumentLinksShellHost, D: DocumentLinksDeps> DocumentLinksShell<H, D> {
    /// the state before `configureDocumentLinks`
    pub fn new() -> Self {
        DocumentLinksShell {
            deps: None,
            links: None,
            shown_signature: String::new(),
            changes: Rc::new(Cell::new(0)),
            syncs: Rc::new(Cell::new(0)),
            watch: None,
        }
    }

    /// `configureDocumentLinks(next)`. `links_at` is `documentLinksAt` over
    /// the path it is given (`<userData>/document-links.json`); `watch` is
    /// `watchMakeEvents(next.tabIdFor, onEvent)` with the `onEvent` it is given.
    pub fn configure(
        &mut self,
        mut host: H,
        links_at: impl FnOnce(&str) -> DocumentLinks<D>,
        watch: impl FnOnce(Box<dyn FnMut()>) -> MakeEventsWatch,
    ) {
        let file = join(&[&host.user_data_path(), DOCUMENT_LINKS_FILE]);
        self.deps = Some(host);
        self.links = Some(links_at(&file));
        let syncs = self.syncs.clone();
        self.watch = Some(watch(Box::new(move || syncs.set(syncs.get() + 1))));
        let changes = self.changes.clone();
        if let Some(links) = self.links.as_mut() {
            links.on_change(Box::new(move || changes.set(changes.get() + 1)));
        }
        self.refresh_document_link_menu();
    }

    /// `documentLinks()`: the app's record store, once configured
    pub fn document_links(&mut self) -> Option<&mut DocumentLinks<D>> {
        self.links.as_mut()
    }

    /// the listeners of `links.onChange`, for each change since the last call
    fn flush_changes(&mut self) {
        while self.changes.get() > 0 {
            self.changes.set(self.changes.get() - 1);
            self.refresh_document_link_menu();
        }
    }

    /// The `queueMicrotask`s of the hand-off store's events: one
    /// `links?.sync()` for each record the store made since the last call.
    pub fn flush_make_events(&mut self) -> Result<(), InvalidTimeValue> {
        if let Some(watch) = self.watch.as_mut() {
            watch.flush();
        }
        while self.syncs.get() > 0 {
            self.syncs.set(self.syncs.get() - 1);
            if let Some(links) = self.links.as_mut() {
                links.sync()?;
            }
            self.flush_changes();
        }
        Ok(())
    }

    /// `noteDocumentSaved(contents, path, options)`: an editor's save hook,
    /// the tab's document landed on a path (first save or Save As). Only a
    /// tab's first path can carry a record. `may_be_open` is for a hook that
    /// also fires when an existing file is opened into the tab (slides): such
    /// a path counts only when it is a save happening now.
    pub fn note_document_saved(
        &mut self,
        contents: &mut H::Contents,
        path: &str,
        may_be_open: Option<bool>,
    ) -> Result<(), InvalidTimeValue> {
        let (Some(links), Some(host)) = (self.links.as_mut(), self.deps.as_mut()) else {
            return Ok(());
        };
        if contents.is_destroyed() {
            return Ok(());
        }
        let fresh = if may_be_open == Some(true) {
            let now = host.now_ms();
            is_freshly_saved_path(path, now, &mut |stat_path| host.stat(stat_path))
        } else {
            true
        };
        links.note_tab_path(contents, path, Some(fresh))?;
        self.flush_changes();
        Ok(())
    }

    /// `documentLinkFileMoved(oldPath, newPath)`: the in-app rename/move notification
    pub fn document_link_file_moved(&mut self, old_path: &str, new_path: &str) {
        if let Some(links) = self.links.as_mut() {
            links.file_moved(old_path, new_path);
        }
        self.flush_changes();
    }

    /// `documentLinkPaths()`: every path the records mention, for folder moves
    pub fn document_link_paths(&mut self) -> Vec<String> {
        match self.links.as_mut() {
            Some(links) => links.paths(),
            None => Vec::new(),
        }
    }

    /// `syncDocumentLinks()`: a run start or conversion may be waiting for a
    /// save that already happened
    pub fn sync_document_links(&mut self) -> Result<(), InvalidTimeValue> {
        if let Some(links) = self.links.as_mut() {
            links.sync()?;
        }
        self.flush_changes();
        Ok(())
    }

    /// `makeFromDocument(contents)`: "make another document from this one"
    /// for the document behind this webContents
    pub fn make_from_document(&mut self, contents: &H::Contents) {
        let Some(host) = self.deps.as_mut() else {
            return;
        };
        if contents.is_destroyed() {
            return;
        }
        let Some(doc) = host.document_for(contents) else {
            return;
        };
        let parent = host.parent_for(contents);
        host.open_generate_window_for_document(GenerateWindowRequest {
            web_contents_id: contents.id(),
            file_path: doc.file_path.filter(|path| !path.is_empty()),
            title: doc.title,
            parent,
        });
    }

    /// `documentLinkFileMenuItems(kind)`: the File-menu entries for the open
    /// document of this kind, led by a separator
    pub fn document_link_file_menu_items(&mut self, kind: TabKind) -> FileMenu<H::Contents> {
        let nothing = FileMenu {
            items: Vec::new(),
            contents: None,
        };
        let (Some(host), Some(links)) = (self.deps.as_mut(), self.links.as_mut()) else {
            return nothing;
        };
        let doc = host.active_document(kind);
        self.shown_signature = signature(kind, doc.as_ref(), Some(&*links));
        let Some(doc) = doc else {
            return nothing;
        };
        let model = document_link_menu_model(doc.file_path.as_deref(), links, &mut |path| {
            host.path_exists(path)
        });
        let labels = host.labels();
        let is_mac = host.is_mac();
        FileMenu {
            items: document_link_menu_items(&model, &labels, is_mac),
            contents: Some(doc.web_contents),
        }
    }

    /// what an item's `click` does: `onMake` for the webContents the entries
    /// were built for, `onOpen` for a listed file
    pub fn run_menu_click(&mut self, click: &MenuClick, contents: &H::Contents) {
        match click {
            MenuClick::Make => self.make_from_document(contents),
            MenuClick::Open(path) => self.open_listed_file(path),
        }
    }

    /// `openListedFile(d, path)`: a listed file was picked. Presence is
    /// checked when the menu is built, so a file deleted since then can still
    /// be picked: it is then not opened, and the menu is built again to show
    /// it dimmed.
    fn open_listed_file(&mut self, path: &str) {
        let Some(host) = self.deps.as_mut() else {
            return;
        };
        if host.path_exists(path) {
            host.open_path(path);
            return;
        }
        self.shown_signature = String::new();
        self.refresh_document_link_menu();
    }

    /// `refreshDocumentLinkMenu()`: rebuild the application menu when what
    /// its File-menu entries would show changed: another document, a new
    /// path, or other records.
    pub fn refresh_document_link_menu(&mut self) {
        let Some(host) = self.deps.as_mut() else {
            return;
        };
        let Some(kind) = host.menu_kind() else {
            return;
        };
        if !EDITOR_KINDS.contains(&kind) {
            return;
        }
        let doc = host.active_document(kind);
        if signature(kind, doc.as_ref(), self.links.as_ref()) == self.shown_signature {
            return;
        }
        host.apply_menu(kind);
    }
}
