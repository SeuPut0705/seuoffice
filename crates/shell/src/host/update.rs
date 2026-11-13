//! Batch U's hosts (host/update.rs): the update window and the updater.
//!
//! - [`UpdateWindowsHost`]: the update card (`update-window.ts`'s
//!   `BrowserWindow`): a frameless, transparent, fixed-size window over the
//!   shell window loading `update.html` with the `ShellUpdate` preload. Its
//!   close, by any means, reaches `UpdateWindow::closed` on the core thread.
//! - [`UpdaterControlHost`]: the updater of `updater.ts`, which is
//!   `main_core::shell::updater::Updater` driven here: its timers, its
//!   dialogs, and electron-updater's part (the feed, the download, the
//!   installer start), which `update/feed.rs` does in its place. The updater
//!   lives on the core thread; a check and a download run on a worker and
//!   come back as the updater's steps say (`UpdaterStep`, `resume_check`,
//!   `resume_download`, `on_event`).
//!
//! At quit ("Restart & Install"), the event loop's exit is held until the
//! core thread has run `on_will_quit`, which starts the installer (Windows)
//! or schedules the bundle swap (macOS), as Electron's `will-quit` did.

mod feed;

use std::cell::RefCell;
use std::collections::HashSet;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use main_core::packages::electron_utils::message_box::MessageBoxOptions;
use main_core::packages::i18n::Lang;
use main_core::shell::app_settings::read_app_settings;
use main_core::shell::mac_update::{SpawnOptions, SwapChild};
use main_core::shell::update_build_channel::packaged_update_channel;
use main_core::shell::updater::{
    Timer, UpdateAction, UpdateStatePatch, UpdateUiState, Updater, UpdaterEnv, UpdaterEvent,
    UpdaterHost, UpdaterSetting, UpdaterStep,
};
use shell_contract::hosts::{MessageBox, MessageBoxAnswer};
use shell_contract::ids::WindowId;
use shell_contract::runtime::{PathName, Services};
use shell_contract::{DialogsHost, Hosts, MainWindowHost, OsShellHost, Surface};
use shell_ipc_u::update_window::{self, UpdateWindowSpec, UpdateWindows};
use shell_ipc_u::{UpdateWindowsHost, UpdaterControl, UpdaterControlHost};
use shell_ipc_w::editor_files::UiLanguageHost;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use self::feed::{Feed, FeedConfig};
use super::HostContext;
use super::w::post_core;
use super::window::{Bridge, ViewSpec, WindowSpec, Windows};
use crate::views::ViewTable;

/// When this process started (`process.uptime()`), read first at install
static STARTED_AT: LazyLock<Instant> = LazyLock::new(Instant::now);

pub fn install(hosts: &mut Hosts, cx: &HostContext) {
    LazyLock::force(&STARTED_AT);
    hosts.insert(QuitHost(cx.app.clone()));
    let windows: UpdateWindowsHost = Arc::new(CardWindows {
        app: cx.app.clone(),
        windows: cx.windows.clone(),
        views: cx.views.clone(),
    });
    hosts.insert(windows);
    let control: UpdaterControlHost = Arc::new(Control {
        resources: cx.app.path().resource_dir().ok(),
    });
    hosts.insert(control);
}

// ---- the update card ----

struct CardWindows {
    app: AppHandle,
    windows: Arc<Windows>,
    views: Arc<ViewTable>,
}

impl UpdateWindows for CardWindows {
    fn create(&self, spec: &UpdateWindowSpec, inactive: bool) -> WindowId {
        let opened = self.windows.open_window(WindowSpec {
            title: spec.title.clone(),
            size: (f64::from(spec.width), f64::from(spec.height)),
            min_size: None,
            visible: true,
            decorations: false,
            transparent: true,
            resizable: false,
            parent: spec.parent,
            focus: !inactive,
            main: false,
            view: ViewSpec {
                url: "genoffice-app://shell/update.html".into(),
                bridge: Bridge::Surface(Surface::ShellUpdate),
            },
        });
        let (window, _view) = match opened {
            Ok(opened) => opened,
            Err(error) => {
                // the card is not there: the updater goes on as if it was closed
                eprintln!("shell: the update window did not open: {error}");
                return WindowId(u32::MAX);
            }
        };
        if let Some(tauri_window) = self
            .views
            .label_of_window(window)
            .and_then(|label| self.app.get_window(&label))
        {
            tauri_window.on_window_event(move |event| {
                if let WindowEvent::Destroyed = event {
                    post_core(move |_, _| {
                        if let Some(card) = update_window::current() {
                            card.closed(window);
                        }
                    });
                }
            });
        }
        window
    }

    fn show(&self, window: WindowId, inactive: bool) {
        if let Err(error) = self.windows.show(window, !inactive) {
            eprintln!("shell: showing the update window: {error}");
        }
    }

    fn close(&self, window: WindowId) {
        if let Err(error) = self.windows.close_window(window) {
            eprintln!("shell: closing the update window: {error}");
        }
    }
}

// ---- the updater ----

struct Control {
    /// where the packaged app keeps `app-update.yml`, if it is packaged
    resources: Option<PathBuf>,
}

impl UpdaterControl for Control {
    fn started(&self) {
        let resources = self.resources.clone();
        // after the batches registered: the update window is there by then
        post_core(move |_, services| Driver::start(services, resources));
    }

    fn available(&self) -> bool {
        DRIVER.with(|d| d.borrow().as_ref().is_some_and(|d| d.shell.packaged))
    }

    fn check_now(&self) {
        with_driver(|updater, shell| {
            let step = updater.check_for_updates_now(shell);
            shell.run(step);
        });
    }
}

thread_local! {
    /// The updater and its host, on the core thread
    static DRIVER: RefCell<Option<Driver>> = const { RefCell::new(None) };
}

struct Driver {
    updater: Updater,
    shell: ShellUpdater,
}

/// Runs `job` with the updater on the core thread; a call made while the
/// updater is busy (a host call that re-entered) runs right after it
fn with_driver(job: impl FnOnce(&mut Updater, &mut ShellUpdater) + 'static) {
    let ran = DRIVER.with(|d| match d.try_borrow_mut() {
        Ok(mut driver) => {
            if let Some(driver) = driver.as_mut() {
                job(&mut driver.updater, &mut driver.shell);
            }
            None
        }
        Err(_) => Some(job),
    });
    if let Some(job) = ran {
        post_core(move |_, _| with_driver(job));
    }
}

/// The env of the updater's log: the console and the clocks
struct Env;

impl UpdaterEnv for Env {
    fn console_log(&self, args: &[String]) {
        eprintln!("{}", args.join(" "));
    }
    fn now_ms(&self) -> f64 {
        now_ms()
    }
    fn perf_now(&self) -> f64 {
        STARTED_AT.elapsed().as_secs_f64() * 1000.0
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

impl Driver {
    fn start(services: &Services, resources: Option<PathBuf>) {
        let config = resources
            .as_ref()
            .and_then(|dir| FeedConfig::read(&dir.join("app-update.yml")));
        let channel = packaged_update_channel(
            &resources
                .as_ref()
                .map_or_else(String::new, |d| d.to_string_lossy().into_owned()),
        );
        let shell = ShellUpdater {
            services: services.clone(),
            packaged: config.is_some(),
            feed: config.map(Feed::new),
            timers: HashSet::new(),
            next_timer: 0,
            download: None,
            exit_held: false,
        };
        let updater = Updater::new(Rc::new(Env));
        DRIVER.with(|d| *d.borrow_mut() = Some(Driver { updater, shell }));
        with_driver(move |updater, shell| updater.init_auto_updater(shell, channel));
    }
}

/// The updater's host: what `updater.ts` read and did outside itself
struct ShellUpdater {
    services: Services,
    /// a packaged app: its resources carry `app-update.yml`
    packaged: bool,
    feed: Option<Feed>,
    /// running intervals (a cleared one stops at its next tick)
    timers: HashSet<u32>,
    next_timer: u32,
    /// the running download's cancel flag
    download: Option<Arc<AtomicBool>>,
    /// `RunEvent::ExitRequested` was held for the installer
    exit_held: bool,
}

impl ShellUpdater {
    fn dialogs(&self) -> Option<DialogsHost> {
        self.services.hosts.get::<DialogsHost>().cloned()
    }

    fn settings_path(&self) -> String {
        self.services
            .paths
            .path(PathName::UserData)
            .join("app-settings.json")
            .to_string_lossy()
            .into_owned()
    }

    /// Carries out what the updater asked for
    fn run(&mut self, step: UpdaterStep) {
        match step {
            UpdaterStep::Idle => {}
            UpdaterStep::StartCheck { ticket } => {
                let Some(feed) = self.feed.clone() else {
                    with_driver(move |updater, shell| {
                        updater.resume_check(shell, ticket, Ok(None));
                    });
                    return;
                };
                let version = self.version();
                self.services.workers.spawn(Box::new(move || {
                    let outcome = feed.check(&version);
                    post_core(move |_, _| {
                        with_driver(move |updater, shell| {
                            if let Some(feed) = shell.feed.as_mut() {
                                feed.remember(&outcome);
                            }
                            for event in outcome.events {
                                updater.on_event(shell, event);
                            }
                            updater.resume_check(shell, ticket, outcome.result);
                        });
                    });
                }));
            }
            UpdaterStep::StartDownload { generation } => {
                let Some(feed) = self.feed.clone() else {
                    return;
                };
                // a new download stops the one before it
                if let Some(running) = self.download.take() {
                    running.store(true, Ordering::Release);
                }
                let cancel = Arc::new(AtomicBool::new(false));
                self.download = Some(cancel.clone());
                self.services.workers.spawn(Box::new(move || {
                    let rejection = feed.download(&cancel, &|event: UpdaterEvent| {
                        post_core(move |_, _| {
                            with_driver(move |updater, shell| updater.on_event(shell, event));
                        });
                    });
                    post_core(move |_, _| {
                        with_driver(move |updater, shell| {
                            updater.resume_download(shell, generation, rejection);
                        });
                    });
                }));
            }
        }
    }

    /// A timer of the updater fired
    fn fire(updater: &mut Updater, shell: &mut ShellUpdater, timer: Timer, id: u32) {
        match timer {
            Timer::Check => {
                let step = updater.check(shell);
                shell.run(step);
            }
            Timer::ClearCache(tries) => updater.clear_installed_cache(shell, tries),
            Timer::FakeShow => updater.fake_show_again(shell),
            Timer::FakeProgress => updater.fake_progress(shell, id),
        }
    }

    fn actions() -> update_window::Actions {
        Rc::new(|action: UpdateAction| {
            with_driver(move |updater, shell| {
                let step = updater.on_action(shell, action);
                shell.run(step);
            });
        })
    }
}

impl UpdaterHost for ShellUpdater {
    fn platform(&self) -> String {
        match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        }
        .to_owned()
    }

    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    fn is_packaged(&self) -> bool {
        self.packaged
    }

    fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_owned()
    }

    fn user_data_dir(&self) -> String {
        self.services
            .paths
            .path(PathName::UserData)
            .to_string_lossy()
            .into_owned()
    }

    fn exec_path(&self) -> String {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    fn pid(&self) -> f64 {
        f64::from(std::process::id())
    }

    fn uptime_seconds(&self) -> f64 {
        STARTED_AT.elapsed().as_secs_f64()
    }

    fn reopened_by_installer(&self) -> bool {
        std::env::args().any(|a| a == "--updated")
    }

    fn ui_lang(&self) -> Lang {
        self.services
            .hosts
            .get::<UiLanguageHost>()
            .map_or(Lang::Ko, |l| l.lang())
    }

    fn auto_check_enabled(&self) -> bool {
        read_app_settings(&self.settings_path())
            .get("autoUpdateCheck")
            .is_none_or(|v| v != &jscompat::JsonValue::Bool(false))
    }

    fn quit_soon(&mut self) {
        // as `app.quit()`: every window closes, each through its own close
        // guard (W's), and the event loop's exit runs `on_will_quit`
        let app = self.services.hosts.get::<QuitHost>().map(|q| q.0.clone());
        if let Some(app) = app {
            let _ = app.clone().run_on_main_thread(move || {
                for window in app.windows().into_values() {
                    let _ = window.close();
                }
            });
        }
    }

    fn show_message_box(&mut self, options: &MessageBoxOptions) -> f64 {
        let Some(dialogs) = self.dialogs() else {
            return f64::from(options.cancel_id.unwrap_or(0));
        };
        let parent = self
            .services
            .hosts
            .get::<MainWindowHost>()
            .and_then(|m| m.window());
        let MessageBoxAnswer { response, .. } = dialogs.message(
            parent,
            &MessageBox {
                kind: Some(options.kind.to_owned()),
                title: options.title.clone(),
                message: options.message.clone(),
                detail: options.detail.clone(),
                buttons: options.buttons.clone(),
                default_id: Some(options.default_id as usize),
                cancel_id: options.cancel_id.map(|c| c as usize),
                checkbox_label: None,
            },
        );
        response as f64
    }

    fn open_external(&mut self, url: &str) {
        if let Some(os) = self.services.hosts.get::<OsShellHost>()
            && let Err(error) = os.open_external(url)
        {
            eprintln!("[updater] opening {url}: {error}");
        }
    }

    fn set_update_parent_window(&mut self) {
        // the card's parent is the shell window, asked of MainWindowHost each time
    }

    fn show_update_window(&mut self, state: &UpdateUiState, inactive: bool) {
        if let Some(card) = update_window::current() {
            card.show(state.clone(), Self::actions(), inactive);
        }
    }

    fn is_update_window_open(&self) -> bool {
        update_window::current().is_some_and(|card| card.is_open())
    }

    fn push_update_state(&mut self, patch: &UpdateStatePatch) {
        if let Some(card) = update_window::current() {
            card.push(patch);
        }
    }

    fn close_update_window(&mut self) {
        if let Some(card) = update_window::current() {
            card.close();
        }
    }

    fn set_timeout(&mut self, timer: Timer, ms: f64) {
        let wait = Duration::from_secs_f64(ms.max(0.0) / 1000.0);
        std::thread::spawn(move || {
            std::thread::sleep(wait);
            post_core(move |_, _| {
                with_driver(move |updater, shell| ShellUpdater::fire(updater, shell, timer, 0));
            });
        });
    }

    fn set_interval(&mut self, timer: Timer, ms: f64) -> u32 {
        self.next_timer += 1;
        let id = self.next_timer;
        self.timers.insert(id);
        let every = Duration::from_secs_f64(ms.max(1.0) / 1000.0);
        let alive = Arc::new(AtomicBool::new(true));
        INTERVALS.lock().unwrap().push((id, alive.clone()));
        std::thread::spawn(move || {
            while alive.load(Ordering::Acquire) {
                std::thread::sleep(every);
                if !alive.load(Ordering::Acquire) {
                    break;
                }
                post_core(move |_, _| {
                    with_driver(move |updater, shell| {
                        if shell.timers.contains(&id) {
                            ShellUpdater::fire(updater, shell, timer, id);
                        }
                    });
                });
            }
        });
        id
    }

    fn clear_interval(&mut self, id: u32) {
        self.timers.remove(&id);
        INTERVALS.lock().unwrap().retain(|(i, alive)| {
            if *i == id {
                alive.store(false, Ordering::Release);
            }
            *i != id
        });
    }

    fn configure(&mut self, setting: UpdaterSetting) {
        if let Some(feed) = self.feed.as_mut() {
            feed.configure(&setting);
        }
    }

    fn install_resume_download(&mut self) {
        // a download is resumed from what it left in the cache (feed.rs)
    }

    fn has_mac_staging_methods(&self) -> (bool, bool) {
        // the download's end is the updater's `on_event(UpdateDownloaded)`,
        // which stages the bundle itself
        (true, true)
    }

    fn install(&mut self, silent: bool, force_run_after: bool) -> Option<bool> {
        let feed = self.feed.as_ref()?;
        Some(feed.start_installer(silent, force_run_after))
    }

    fn download_cache_dir(&mut self) -> Result<Option<String>, String> {
        Ok(self
            .feed
            .as_ref()
            .map(|f| f.cache_dir().to_string_lossy().into_owned()))
    }

    fn run_program(&mut self, file: &str, args: &[String]) -> Result<String, String> {
        let out = std::process::Command::new(file)
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(format!(
                "{file} exited with {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }

    fn spawn_program(
        &mut self,
        file: &str,
        args: &[String],
        _options: &SpawnOptions,
    ) -> Result<Box<dyn SwapChild>, String> {
        // detached, no stdio: it outlives the app it waits for
        let child = std::process::Command::new(file)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(Box::new(Spawned(child.id())))
    }
}

/// The intervals' stop flags, by timer id
static INTERVALS: Mutex<Vec<(u32, Arc<AtomicBool>)>> = Mutex::new(Vec::new());

/// A started child the updater lets go of
struct Spawned(u32);

impl SwapChild for Spawned {
    fn on_error_ignore(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn unref(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn has_pid(&self) -> bool {
        self.0 != 0
    }
}

/// The app, for the quit the updater asks for
#[derive(Clone)]
struct QuitHost(AppHandle);

/// The event loop's events: the exit is held once for `on_will_quit`
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    let RunEvent::ExitRequested { api, .. } = event else {
        return;
    };
    if HELD.swap(true, Ordering::AcqRel) {
        // the second request is the one made below: it goes through
        return;
    }
    api.prevent_exit();
    let app = app.clone();
    post_core(move |_, _| {
        with_driver(|updater, shell| {
            shell.exit_held = true;
            updater.on_will_quit(shell);
        });
        let _ = app.clone().run_on_main_thread(move || app.exit(0));
    });
}

/// `on_will_quit` ran once: the next exit request is not held
static HELD: AtomicBool = AtomicBool::new(false);
