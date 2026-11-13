//! The `slides` channels of batch D1: a port of the `ipcMain` handlers of
//! `apps/slides/src/main` (`slides-main.ts`, `attachments-ipc.ts`,
//! `presenter-show.ts`, `generate-handoff-ipc.ts`, `template-bytes.ts`,
//! `template-cover.ts`, `seed-deck.ts`).
//!
//! Layout:
//!
//! - [`engine`]: the deck engine ([`engine::SlidesEngine`]) and the shell
//!   hooks ([`engine::SlidesShell`]) the handlers lean on.
//! - [`state`]: the session model: one [`state::SlideSession`] per deck
//!   (main-core's `Session` plus the `slides-main.ts` fields), attached to
//!   views through slots, and the module-level state of the TypeScript.
//! - [`session`]: helpers every edit handler shares (session lookup,
//!   journaled transactions, history and deck broadcast flush, slide
//!   updates, object builders).
//! - `lifecycle`, `export`, `generate`, `files`, `clipboard`, `presenter`,
//!   `edits`: the channels.

pub mod clipboard;
pub mod dialog;
pub mod edit_ops;
pub mod edits;
pub mod engine;
pub mod export;
#[cfg(any(test, feature = "probe"))]
pub mod fake;
pub mod files;
pub mod generate;
pub mod i18n;
pub mod lifecycle;
pub mod presenter;
pub mod recovery;
pub mod session;
pub mod state;
#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use shell_contract::editors::{DocumentEditors, SaveMode, Then};
use shell_contract::hosts::{ClipboardHost, ContentsHost, DialogsHost, OsShellHost};
use shell_contract::ipc::{CallContext, RegisterError, Responder};
use shell_contract::provided::Provided;
use shell_contract::runtime::Services;
use shell_contract::{Batch, IpcError, IpcValue, ViewId, WindowId};

use crate::host::{LocaleHost, RecoveryStateHost, Shared, on_view_gone};
use crate::route::{self, Route};
use crate::value::{Args, string, thrown};
use engine::{SlidesEngineHost, SlidesShellHost};
use state::{App, AppState};

type Reply = Result<IpcValue, IpcError>;

thread_local! {
    /// the apps registered on this (core) thread, for deferred jobs
    static APPS: RefCell<Vec<App>> = const { RefCell::new(Vec::new()) };
}

/// Runs `f` with the app registered at `index`, on the core thread
pub(crate) fn with_app<R>(index: usize, f: impl FnOnce(&App) -> R) -> Option<R> {
    let app = APPS.with(|apps| apps.borrow().get(index).cloned())?;
    Some(f(&app))
}

/// Posts `job` to the core thread: it finds the app again there, runs, and
/// queues what the sessions scheduled meanwhile. Callable from any thread.
pub(crate) fn post_to(services: &Services, index: usize, job: impl FnOnce(&App) + Send + 'static) {
    services.core.post(Box::new(move || {
        with_app(index, |app| {
            job(app);
            app.pump();
        });
    }));
}

/// The audience window of a presenter show closed (`win.on('closed')`): the
/// shell calls this from the window's close
pub fn audience_closed(view: ViewId) {
    let app = APPS.with(|apps| apps.borrow().last().cloned());
    if let Some(app) = app {
        app.audience_closed(view);
    }
}

type NowFn = fn(&App, &CallContext, Args) -> Reply;
type LaterFn = fn(&App, &CallContext, Args, Responder);
type OnFn = fn(&App, &CallContext, Args) -> Result<(), IpcError>;

/// `ipcMain.handle(channel, fn)` that answers at once
pub(crate) fn now(app: &App, channel: &'static str, f: NowFn) -> Route {
    let app = app.clone();
    route::invoke(channel, move |cx, args| {
        let reply = f(&app, cx, args);
        app.pump();
        reply
    })
}

/// `ipcMain.handle(channel, async fn)`
pub(crate) fn later(app: &App, channel: &'static str, f: LaterFn) -> Route {
    let app = app.clone();
    route::invoke_later(channel, move |cx, args, responder| {
        f(&app, cx, args, responder);
        app.pump();
    })
}

/// `ipcMain.on(channel, fn)`
pub(crate) fn on(app: &App, channel: &'static str, f: OnFn) -> Route {
    let app = app.clone();
    route::send(channel, move |cx, args| {
        let result = f(&app, cx, args);
        app.pump();
        result
    })
}

/// What the other areas call into (tabs, menus, MCP): the exported
/// functions of `slides-main.ts`
struct SlidesEditors {
    app: App,
}

impl DocumentEditors for SlidesEditors {
    fn owns(&self, view: ViewId) -> bool {
        self.app.state.borrow().has_session(view)
    }

    fn document_path(&self, view: ViewId) -> Option<PathBuf> {
        let state = self.app.state.borrow();
        let session = state.session(view)?;
        (!session.path().is_empty()).then(|| PathBuf::from(session.path()))
    }

    /// `requestRendererSave`: the renderer runs its full save flow and
    /// reports on `slides:close-save-result`. `saveAs` has no counterpart in
    /// the TypeScript but the menu's `slides:menu` message, which waits for
    /// nothing: it answers true once the message is sent.
    fn request_save(&self, view: ViewId, mode: SaveMode, then: Then<bool>) {
        match mode {
            SaveMode::Save => self
                .app
                .request_renderer_save(view, Box::new(move |ok| then(Ok(ok)))),
            SaveMode::SaveAs => {
                self.app.emit(view, "slides:menu", vec![string("save-as")]);
                then(Ok(true))
            }
        }
        self.app.pump();
    }

    fn request_close(&self, view: ViewId, parent: Option<WindowId>, then: Then<bool>) {
        self.app.request_close(view, parent, then);
        self.app.pump();
    }

    /// The slides main process has no text export of its own (the AI reads
    /// through `slides:apply-txn` and the session ops): the caller sees an
    /// error as a missing function would give it
    fn read_text(&self, _view: ViewId, then: Then<String>) {
        then(Err(thrown("slides has no read-text export")))
    }

    /// `saveSessionDeckTo(session, filePath)`
    fn save_to_path(&self, view: ViewId, path: PathBuf, then: Then<()>) {
        let result = self.app.save_session_deck_to(view, &path.to_string_lossy());
        self.app.pump();
        then(result)
    }

    /// `slidesFileRenamed(wc, oldPath, newPath)`
    fn file_renamed(&self, view: ViewId, old_path: &Path, new_path: &Path) {
        self.app.file_renamed(
            view,
            &old_path.to_string_lossy(),
            &new_path.to_string_lossy(),
        );
    }

    /// The File menu's `slides:menu` command: `pdf`, `png` and `jpg` are the
    /// menu's export-pdf, export-images and export-images-jpg
    fn export_request(&self, view: ViewId, format: &str) {
        let command = match format {
            "png" => "export-images".to_owned(),
            "jpg" => "export-images-jpg".to_owned(),
            other => format!("export-{other}"),
        };
        self.app.emit(view, "slides:menu", vec![string(command)]);
    }
}

impl App {
    /// A view is gone: the work of `trackSlidesWebContents`'s
    /// `once('destroyed')` and of the presenter show
    fn view_gone(&self, view: ViewId) {
        self.close_narration_microphone(view);
        self.release_recovery(view);
        self.close_presenter_show(view);
        self.audience_closed(view);
        let waiter = {
            let mut state = self.state.borrow_mut();
            state.detach_view(view);
            state.pending_by_view.remove(&view);
            state.last_slide_paste.remove(&view);
            state.auto_save_pref.remove(&view);
            state.save_as_image_targets.forget(f64::from(view.0));
            state.seeds.forget(f64::from(view.0));
            state.close_waiters.remove(&view)
        };
        if let Some(waiter) = waiter {
            waiter(false);
        }
        self.pump();
    }

    /// Queues the path a view opens when its renderer asks (`pendingByWc`)
    pub fn queue_open(&self, view: ViewId, path: &str) {
        self.state
            .borrow_mut()
            .pending_by_view
            .insert(view, path.to_owned());
    }
}

pub fn routes(services: &Services, provided: &Rc<Provided>) -> Result<Vec<Route>, RegisterError> {
    let hosts = &services.hosts;
    let engine = hosts.need::<SlidesEngineHost>(Batch::D1)?;
    let shell = hosts.need::<SlidesShellHost>(Batch::D1)?;
    let dialogs = hosts.need::<DialogsHost>(Batch::D1)?;
    let os_shell = hosts.need::<OsShellHost>(Batch::D1)?;
    let clipboard = hosts.need::<ClipboardHost>(Batch::D1)?;
    let contents = hosts.need::<ContentsHost>(Batch::D1)?;
    let locale = hosts.need::<LocaleHost>(Batch::D1)?;
    let shared = hosts.need::<Arc<Shared>>(Batch::D1)?;
    let recovery_state = hosts.need::<RecoveryStateHost>(Batch::D1)?;
    let registry_index = APPS.with(|apps| apps.borrow().len());
    let app = App {
        state: Rc::new(RefCell::new(AppState::default())),
        registry_index,
        services: services.clone(),
        engine,
        shell,
        dialogs,
        os_shell,
        clipboard,
        contents,
        locale,
        shared,
        recovery_state,
        text_cache: Arc::new(Mutex::default()),
    };
    APPS.with(|apps| apps.borrow_mut().push(app.clone()));
    provided.add::<dyn DocumentEditors>(Rc::new(SlidesEditors { app: app.clone() }));
    let gone = app.clone();
    on_view_gone(services, move |view| gone.view_gone(view));

    let mut routes = vec![
        // lifecycle
        later(&app, "slides:open", lifecycle::open),
        later(&app, "slides:open-path", lifecycle::open_path),
        later(
            &app,
            "slides:consume-pending-open",
            lifecycle::consume_pending_open,
        ),
        now(&app, "slides:new-blank", lifecycle::new_blank),
        now(&app, "slides:recent", lifecycle::recent),
        now(&app, "slides:save", lifecycle::save),
        now(&app, "slides:save-as", lifecycle::save_as),
        now(
            &app,
            "slides:save-into-project",
            lifecycle::save_into_project,
        ),
        now(&app, "slides:is-dirty", lifecycle::is_dirty),
        on(&app, "slides:autosave-pref", lifecycle::autosave_pref),
        on(
            &app,
            "slides:close-save-result",
            lifecycle::close_save_result,
        ),
        now(&app, "slides:undo", lifecycle::undo),
        now(&app, "slides:redo", lifecycle::redo),
        now(
            &app,
            "slides:history-batch-begin",
            lifecycle::history_batch_begin,
        ),
        now(
            &app,
            "slides:history-batch-end",
            lifecycle::history_batch_end,
        ),
        now(
            &app,
            "slides:get-render-slides",
            lifecycle::get_render_slides,
        ),
        // export and pickers
        now(&app, "slides:pick-export-dir", export::pick_export_dir),
        now(
            &app,
            "slides:pick-export-pdf-path",
            export::pick_export_pdf_path,
        ),
        later(&app, "slides:export-images", export::export_images),
        later(&app, "slides:export-pdf", export::export_pdf),
        now(&app, "slides:save-picture", export::save_picture),
        now(
            &app,
            "slides:consume-headless-export",
            export::consume_headless_export,
        ),
        on(
            &app,
            "slides:headless-export-done",
            export::headless_export_done,
        ),
        // fonts, templates, hand-off
        now(
            &app,
            "slides:font-install-local",
            export::font_install_local,
        ),
        now(
            &app,
            "slides:private-font-faces",
            export::private_font_faces,
        ),
        now(&app, "slides:private-font-data", export::private_font_data),
        now(&app, "slides:template-bytes", export::template_bytes),
        now(
            &app,
            "slides:template-cover-render",
            export::template_cover_render,
        ),
        now(&app, "slides:handoff-take", export::handoff_take),
        now(
            &app,
            "slides:handoff-run-started",
            export::handoff_run_started,
        ),
        // narration microphone
        later(&app, "slides:microphone-access", export::microphone_access),
        on(
            &app,
            "slides:microphone-release",
            export::microphone_release,
        ),
        // generated pages
        later(
            &app,
            "slides:local-page-generate",
            export::local_page_generate,
        ),
        now(
            &app,
            "slides:land-generated-pages",
            generate::land_generated_pages,
        ),
        // attachments
        now(&app, "slides:files-pick", files::files_pick),
        now(&app, "slides:files-add", files::files_add),
        now(
            &app,
            "slides:files-add-pasted-image",
            files::files_add_pasted_image,
        ),
        later(&app, "slides:files-read", files::files_read),
        now(&app, "slides:files-read-image", files::files_read_image),
        // presenter and show
        now(&app, "slides:presenter-start", presenter::presenter_start),
        on(&app, "slides:presenter-sync", presenter::presenter_sync),
        on(&app, "slides:presenter-ink", presenter::presenter_ink),
        now(&app, "slides:presenter-swap", presenter::presenter_swap),
        now(&app, "slides:presenter-end", presenter::presenter_end),
        now(&app, "slides:audience-ready", presenter::audience_ready),
        on(&app, "slides:audience-nav", presenter::audience_nav),
        now(&app, "slides:show-fullscreen", presenter::show_fullscreen),
        // clipboards
        now(
            &app,
            "slides:has-slide-clipboard",
            clipboard::has_slide_clipboard,
        ),
        now(&app, "slides:copy-slides", clipboard::copy_slides),
        now(&app, "slides:paste-slide", clipboard::paste_slide),
        now(&app, "slides:repaste-slide", clipboard::repaste_slide),
        now(
            &app,
            "slides:clipboard-external",
            clipboard::clipboard_external,
        ),
        now(&app, "slides:clipboard-probe", clipboard::clipboard_probe),
        now(&app, "slides:copy-elements", clipboard::copy_elements),
        now(
            &app,
            "slides:copy-elements-image",
            clipboard::copy_elements_image,
        ),
        now(&app, "slides:paste-elements", clipboard::paste_elements),
        now(
            &app,
            "slides:duplicate-elements",
            clipboard::duplicate_elements,
        ),
        now(&app, "slides:native-clipboard", clipboard::native_clipboard),
    ];
    routes.extend(edits::routes(&app));
    routes.extend(edit_ops::routes(&app));
    Ok(routes)
}

/// This app's fake hosts for [`crate::testkit::Kit`] and `ipc-probe`; `case`
/// is the case's `hosts.d1` value (Null in unit tests)
#[cfg(any(test, feature = "probe"))]
pub fn insert_fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    fake::insert(hosts, case);
}
