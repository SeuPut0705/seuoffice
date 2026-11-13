//! The stage 3 shell (decisions 0025, 0029, 0030; the stage 3 shell contract
//! under docs/seuoffice): Tauri 3 on the CEF runtime, with `main-core` linked
//! in this process.
//!
//! Three kinds of thread (the contract, section 3):
//!
//! - the UI thread runs the Tauri/CEF event loop; windows, menus, dialogs and
//!   the clipboard are touched there only;
//! - the core thread runs every handler in arrival order, and holds
//!   `main-core`'s state;
//! - workers run what TypeScript awaited and post the result back.
//!
//! At start the shell builds [`Services`], then on the core thread fills the
//! channel table from the six batches (`shell_core::table::build`) and stops
//! with the error printed when a batch is refused or a channel renderers use
//! has no handler. `SEUOFFICE_SHELL_PARTIAL=1` starts with the table as the
//! batches fill it, which is all there is while they are incomplete.
//!
//! `--measure-dialog <out.json>` runs the dialog measurement of the contract
//! (see `measure.rs`) instead of the shell window.

#![cfg_attr(
    all(not(debug_assertions), feature = "windows-gui"),
    windows_subsystem = "windows"
)]

mod app_scheme;
mod host;
mod ipc;
mod measure;
mod paths;
mod preload;
mod views;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::thread::ThreadId;

use shell_contract::ipc::{EventSink, RegisterBatch};
use shell_contract::runtime::{Services, Thread, Views, Workers, run_on};
use shell_contract::{Hosts, Surface};
use shell_core::BATCHES;
use shell_core::core_thread::{CoreThread, ThreadWorkers};
use shell_core::dispatch::{CatchingWorkers, Dispatcher};
use shell_core::outlet::OutletSink;
use shell_core::table::{Completeness, StartError, build};
use tauri::{AppHandle, DragDropEvent, Manager, WebviewEvent, WindowEvent};
use tauri_runtime_cef::Cef;

use crate::host::HostContext;
use crate::host::window::{Bridge, ViewSpec, WindowSpec, Windows};
use crate::ipc::Ipc;
use crate::ipc::outlet::TauriOutlet;
use crate::measure::Measure;
use crate::paths::ShellPaths;
use crate::views::ViewTable;

/// `SEUOFFICE_SHELL_PARTIAL=1`: start with the channels the batches have registered
const PARTIAL_ENV: &str = "SEUOFFICE_SHELL_PARTIAL";

struct Options {
    /// `--measure-dialog <out.json>`
    measure: Option<PathBuf>,
    partial: bool,
}

impl Options {
    fn read() -> Self {
        let mut args = std::env::args().skip(1);
        let mut measure = None;
        while let Some(arg) = args.next() {
            if arg == "--measure-dialog" {
                measure = args.next().map(PathBuf::from);
            }
        }
        Options {
            partial: std::env::var(PARTIAL_ENV).is_ok_and(|v| v == "1"),
            measure,
        }
    }

    /// The measurement needs W's channels, not a complete table
    fn completeness(&self) -> Completeness {
        if self.partial || self.measure.is_some() {
            Completeness::AsRegistered
        } else {
            Completeness::Complete
        }
    }
}

/// The Tauri/CEF event loop as a [`Thread`]
struct TauriUi {
    app: AppHandle,
    main: ThreadId,
}

impl Thread for TauriUi {
    fn post(&self, job: Box<dyn FnOnce() + Send>) {
        if let Err(error) = self.app.run_on_main_thread(job) {
            eprintln!("shell: a job for the UI thread was not accepted: {error}");
        }
    }

    fn is_current(&self) -> bool {
        std::thread::current().id() == self.main
    }
}

/// Why the shell did not start, for a person
fn describe(error: &StartError) -> String {
    match error {
        StartError::Register(error) => {
            format!("a batch could not register its channels: {error:?}")
        }
        StartError::Missing(missing) => {
            let shown: Vec<String> = missing
                .iter()
                .take(12)
                .map(|(channel, kind)| format!("{channel} ({kind:?})"))
                .collect();
            format!(
                "{} channels that renderers use have no handler yet, e.g. {}{}. \
                 {PARTIAL_ENV}=1 starts with the channels that are registered.",
                missing.len(),
                shown.join(", "),
                if missing.len() > shown.len() {
                    ", …"
                } else {
                    ""
                },
            )
        }
    }
}

/// A start that failed: print it, leave a note in userData, tell the person, end
fn fail(app: &AppHandle, paths: &ShellPaths, options: &Options, why: String) {
    use shell_contract::runtime::{AppPaths, PathName};
    eprintln!("shell: cannot start: {why}");
    let user_data = paths.path(PathName::UserData);
    if std::fs::create_dir_all(&user_data).is_ok() {
        let _ = std::fs::write(user_data.join("shell-start-error.txt"), format!("{why}\n"));
    }
    let quiet = options.measure.is_some() || std::env::var_os("CI").is_some();
    let app = app.clone();
    let shown = app.run_on_main_thread({
        let app = app.clone();
        move || {
            if !quiet {
                rfd::MessageDialog::new()
                    .set_level(rfd::MessageLevel::Error)
                    .set_title("SeuOffice")
                    .set_description(&why)
                    .show();
            }
            app.exit(1);
        }
    });
    if shown.is_err() {
        app.exit(1);
    }
}

/// The first window: the shell window, or the measurement's test page
fn open_first_window(windows: &Windows, options: &Options) -> Result<(), String> {
    let (url, bridge, main, title) = if options.measure.is_some() {
        (
            "genoffice-app://shell/measure.html",
            Bridge::Measure,
            false,
            "SeuOffice IPC measurement",
        )
    } else {
        (
            "genoffice-app://shell/index.html",
            Bridge::Surface(Surface::Shell),
            true,
            "SeuOffice",
        )
    };
    windows
        .open_window(WindowSpec {
            title: title.into(),
            size: (1280.0, 860.0),
            min_size: None,
            visible: true,
            main,
            view: ViewSpec {
                url: url.into(),
                bridge,
            },
        })
        .map(|_| ())
}

/// Builds the table on the core thread, then opens the first window. Off the
/// UI thread: registering may ask the UI thread for something, and a window
/// is made by the UI thread.
fn start(
    app: AppHandle,
    services: Services,
    windows: Arc<Windows>,
    paths: Arc<ShellPaths>,
    options: Options,
) {
    let spawned = std::thread::Builder::new()
        .name("shell-start".into())
        .spawn(move || {
            let completeness = options.completeness();
            let core = services.core.clone();
            // the shell provides what the batches need of each other on the core thread, first
            let batches: Vec<RegisterBatch> =
                std::iter::once(host::w::register_hooks as RegisterBatch)
                    .chain(BATCHES.iter().copied())
                    .collect();
            let built = run_on(core.as_ref(), move || {
                let table = build(&services, &batches, completeness)?;
                let handlers = table.len();
                ipc::install_dispatcher(Dispatcher::new(table));
                Ok::<usize, StartError>(handlers)
            });
            match built {
                Ok(handlers) => {
                    eprintln!("shell: {handlers} handlers registered ({completeness:?})");
                    if let Err(error) = open_first_window(&windows, &options) {
                        fail(&app, &paths, &options, error);
                    }
                }
                Err(error) => fail(&app, &paths, &options, describe(&error)),
            }
        });
    if let Err(error) = spawned {
        eprintln!("shell: cannot start the start-up thread: {error}");
        std::process::exit(1);
    }
}

/// The renderer folders, found once on the first request
static ROOTS: OnceLock<Vec<(String, String)>> = OnceLock::new();

#[tauri_runtime_cef::cef_entry_point]
fn main() {
    let options = Options::read();
    // the thread that starts the event loop is the UI thread
    let ui_thread = std::thread::current().id();

    let core = CoreThread::spawn("seuoffice-core");
    let core_thread: Arc<dyn Thread> = core.clone();
    let outlet = Arc::new(TauriOutlet::default());
    let views = Arc::new(ViewTable::new(outlet.clone(), core_thread.clone()));
    let paths = Arc::new(ShellPaths::new());

    // Chromium's profile stays out of the Electron build's userData folder:
    // by default it is `{user cache}/com.seuput.seuoffice/cef`. A scratch
    // userData (a test driver, the measurement) takes its own beside it.
    let mut cef = Cef::default();
    if let Some(dir) = std::env::var_os("SEUOFFICE_USER_DATA").filter(|v| !v.is_empty()) {
        let mut cache = dir;
        cache.push("-cef");
        cef = cef.root_cache_path(PathBuf::from(cache));
    }

    let mut builder = tauri::Builder::default()
        .runtime(cef)
        .invoke_handler(tauri::generate_handler![
            ipc::ipc_invoke,
            ipc::ipc_send,
            ipc::ipc_listen
        ])
        .register_asynchronous_uri_scheme_protocol(ipc::sync::SCHEME, ipc::sync::handle);

    // one scheme per renderer host: one origin each, as Electron's were
    let measure_page = options.measure.is_some();
    for host in app_scheme::hosts() {
        builder = builder.register_asynchronous_uri_scheme_protocol(
            app_scheme::scheme_of(host),
            move |ctx, request, responder| {
                let roots = ROOTS.get_or_init(|| {
                    app_scheme::roots(ctx.app_handle().path().resource_dir().ok(), measure_page)
                });
                // reading a file is not for the UI thread
                tauri::async_runtime::spawn_blocking(move || {
                    responder.respond(app_scheme::serve(roots, host, &request));
                });
            },
        );
    }

    let setup_views = views.clone();
    let setup_paths = paths.clone();
    let setup_core = core.clone();
    builder
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event
                && let Some(ipc) = window.try_state::<Ipc>()
                && let Some(id) = ipc.views.window_of_window_label(window.label())
            {
                ipc.views.remove_window(id);
            }
        })
        .on_webview_event(|webview, event| {
            // the paths of a drop, for `webUtils.getPathForFile`
            if let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event
                && let Some(ipc) = webview.try_state::<Ipc>()
            {
                ipc.views.set_dropped(webview.label(), paths.clone());
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let views = setup_views;
            let paths = setup_paths;

            let ui: Arc<dyn Thread> = Arc::new(TauriUi {
                app: handle.clone(),
                main: ui_thread,
            });
            let windows = Arc::new(Windows::new(handle.clone(), views.clone()));
            let context = HostContext {
                app: handle.clone(),
                ui: ui.clone(),
                views: views.clone(),
                windows: windows.clone(),
            };
            let mut hosts = Hosts::default();
            host::install(&mut hosts, &context);

            let events: Arc<dyn EventSink> = Arc::new(OutletSink {
                outlet: outlet.clone(),
                views: views.clone() as Arc<dyn Views>,
            });
            let workers: Arc<dyn Workers> = Arc::new(CatchingWorkers(Arc::new(ThreadWorkers)));
            let services = Services {
                ui: ui.clone(),
                core: core_thread.clone(),
                workers,
                events,
                views: views.clone(),
                paths: paths.clone(),
                hosts: Arc::new(hosts),
            };

            let measure = options
                .measure
                .clone()
                .map(|out| Measure::new(out, ui, handle.clone()));
            app.manage(Ipc {
                core: setup_core,
                views,
                outlet,
                measure,
            });
            start(handle, services, windows, paths, options);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the tauri application");
}
