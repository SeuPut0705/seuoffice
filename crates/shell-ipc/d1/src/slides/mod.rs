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
#[cfg(any(test, feature = "probe"))]
pub mod fixtures;
pub mod generate;
pub mod i18n;
pub mod inserts;
pub mod lifecycle;
pub mod master;
pub mod presenter;
pub mod reads;
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
use shell_contract::slides::{SlidesDocument, SlidesDocuments, SlidesTemplateSelectionHooks};
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
    /// reports on `slides:close-save-result`. `saveAs` is the menu's
    /// `slides:menu` message: the renderer's Save As ends in `slides:save-as`,
    /// whose answer resumes the request (`true` saved; `false` cancelled, a
    /// copy format, or failed: the contract's "user cancelled or it failed",
    /// so a handler error is `false` here, not an `Err`).
    fn request_save(&self, view: ViewId, mode: SaveMode, then: Then<bool>) {
        match mode {
            SaveMode::Save => self
                .app
                .request_renderer_save(view, Box::new(move |ok| then(Ok(ok)))),
            SaveMode::SaveAs => self
                .app
                .request_save_as(view, Box::new(move |ok| then(Ok(ok)))),
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

/// `sessions.get(view)` for the batches that ask which deck a view shows
struct SlidesDocs {
    app: App,
}

impl SlidesDocuments for SlidesDocs {
    fn document(&self, view: ViewId) -> Option<SlidesDocument> {
        let state = self.app.state.borrow();
        state.session(view).map(|s| self.app.document_of_session(s))
    }
}

impl App {
    /// The session as the other batches name it
    pub fn document_of_session(&self, s: &state::SlideSession) -> SlidesDocument {
        SlidesDocument {
            id: s.id,
            path: s.path().to_owned(),
        }
    }

    /// `followTemplateSelection(session, fromPath, toPath)`: every hook
    /// provided, none when absent
    pub fn follow_template(&self, s: &state::SlideSession, from: &str, to: &str) {
        let doc = self.document_of_session(s);
        for hooks in self.provided.all::<dyn SlidesTemplateSelectionHooks>() {
            hooks.follow(&doc, from, to);
        }
    }

    /// `inheritTemplateSelection(previous, replacement)`
    pub fn inherit_template(
        &self,
        previous: Option<&SlidesDocument>,
        replacement: &state::SlideSession,
    ) {
        let doc = self.document_of_session(replacement);
        for hooks in self.provided.all::<dyn SlidesTemplateSelectionHooks>() {
            hooks.inherit(previous, &doc);
        }
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
            let at = state.close_waiters.iter().rposition(|w| w.0 == view);
            at.map(|at| state.close_waiters.remove(at).2)
        };
        if let Some(waiter) = waiter {
            waiter(false);
        }
        // a Save As the menu asked for ends with its view
        let save_as = self.state.borrow_mut().save_as_waiters.remove(&view);
        if let Some((_, waiter)) = save_as {
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
    let shared = Shared::need(hosts)?;
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
        provided: provided.clone(),
        backoff: Rc::default(),
    };
    APPS.with(|apps| apps.borrow_mut().push(app.clone()));
    provided.add::<dyn DocumentEditors>(Rc::new(SlidesEditors { app: app.clone() }));
    provided.add::<dyn SlidesDocuments>(Rc::new(SlidesDocs { app: app.clone() }));
    let gone = app.clone();
    on_view_gone(services, move |view| gone.view_gone(view));
    app.schedule_recovery_tick();

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
        now(
            &app,
            "slides:ask-withheld-export",
            export::ask_withheld_export,
        ),
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
    routes.extend(reads::routes(&app));
    routes.extend(master::routes(&app));
    routes.extend(inserts::routes(&app));
    Ok(routes)
}

/// This app's fake hosts for [`crate::testkit::Kit`] and `ipc-probe`; `case`
/// is the case's `hosts.d1` value (Null in unit tests)
#[cfg(any(test, feature = "probe"))]
pub fn insert_fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    fake::insert(hosts, case);
}

/// The shell's `createSlidesWindow(openPath)` and `open-file` after the page
/// loaded: opens `path` in `view` at the editor's default width and tells the
/// renderer with `slides:opened`. A deck that cannot be opened is ignored, as
/// the TypeScript's `catch` does. Called by the shell on the core thread.
pub fn open_file_in_window(view: shell_contract::ViewId, path: &str) {
    let app = APPS.with(|apps| apps.borrow().last().cloned());
    if let Some(app) = app {
        if let Ok(result) = app.open_and_build(view, path, 1280.0, None) {
            // the history notice is queued for the end of the task: it goes out while
            // the TypeScript awaits the recent list, before the open's answer is sent
            app.pump();
            let index = app.registry_index;
            post_to(&app.services.clone(), index, move |app| {
                app.emit(view, "slides:opened", vec![result]);
                app.pump();
            });
        }
        app.pump();
    }
}

/// This app's triggers for [`crate::probe_trigger`]: `name` without its
/// `d1/` prefix; false when it is not one of them. Named after the TypeScript
/// the shell runs:
///
/// - `slides:requestSlidesClose` `[withParent]`: `requestSlidesClose(contents, parent)`
/// - `slides:slidesMenu` `[command]`: the click of the File or Edit menu item that
///   sends `slides:menu` `command` (`save-as`, `export-pdf`, `export-images`,
///   `export-images-jpg`)
/// - `slides:openFileInWindow` `[path]`: the open of `createSlidesWindow(path)`
#[cfg(feature = "probe")]
pub fn probe_trigger(
    name: &str,
    view: shell_contract::ViewId,
    args: &serde_json::Value,
    _services: &Services,
    _provided: &std::rc::Rc<shell_contract::provided::Provided>,
    then: shell_contract::editors::Then<shell_contract::IpcValue>,
) -> bool {
    use shell_contract::editors::{DocumentEditors, SaveMode};
    let Some(what) = name.strip_prefix("slides:") else {
        return false;
    };
    let Some(app) = APPS.with(|apps| apps.borrow().last().cloned()) else {
        return false;
    };
    let text = args
        .get(0)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned();
    let editors = SlidesEditors { app: app.clone() };
    match what {
        "requestSlidesClose" => {
            let parent = args
                .get(0)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
                .then(|| app.shell.host_window_for(view))
                .flatten();
            editors.request_close(
                view,
                parent,
                Box::new(move |close| then(close.map(shell_contract::IpcValue::Bool))),
            );
        }
        "slidesMenu" => {
            match text.as_str() {
                "save-as" => editors.request_save(view, SaveMode::SaveAs, Box::new(|_| {})),
                "export-pdf" => editors.export_request(view, "pdf"),
                "export-images" => editors.export_request(view, "png"),
                "export-images-jpg" => editors.export_request(view, "jpg"),
                _ => return false,
            }
            app.pump();
            then(Ok(shell_contract::IpcValue::Undefined));
        }
        // `createSlidesView(openPath)`: the tab opens the path when its renderer mounts
        "createSlidesView" => {
            if !text.is_empty() && std::path::Path::new(&text).exists() {
                app.queue_open(view, &text);
            }
            then(Ok(shell_contract::IpcValue::Undefined));
        }
        "openFileInWindow" => {
            open_file_in_window(view, &text);
            then(Ok(shell_contract::IpcValue::Undefined));
        }
        _ => return false,
    }
    true
}
