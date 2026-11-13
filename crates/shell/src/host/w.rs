//! The hosts of batch W's own handlers (`crates/shell-ipc/w`): each handler
//! module defines the trait it needs, and this file puts an implementation in
//! [`Hosts`]. What the shell can do now is real (the clock); the rest is
//! [`unbuilt`], logged stubs that a later unit replaces trait by trait.
//!
//! | trait | now |
//! | --- | --- |
//! | `editor_files::Clock` | real |
//! | `quick_look::QuickLookRuntime`, `QuickLookWindow`, `main_core`'s `QuickLookEngines` | stub (the preview window, the Explorer hook and the tray, the zip and text engines) |
//! | `doc_picker::DocPickerWindow`, `DocPickerSources` | stub |
//! | `editor_files::DocsTabs`, `SheetsTabs`, `OpenFiles`, `FileParse`, `UiLanguage` | stub |
//! | `home_files::HomeFiles`, `FileSearch`, `FolderTree`, `FolderWatch` | stub |
//! | `home_settings::HomeApp` | stub |
//! | `tabs::WindowsHost` | stub: the window system of the tab strip ([`super::window::Windows`] has the Tauri half) |
//! | `tabs::TabHooks` (provided, on the core thread) | stub, [`register_hooks`] |

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use shell_contract::Hosts;
use shell_contract::ipc::{RegisterError, Registry};
use shell_contract::provided::Provided;
use shell_contract::runtime::{Services, Thread, run_on};
use shell_ipc_w::doc_picker::{DocPickerSourcesHost, DocPickerWindowHost};
use shell_ipc_w::editor_files::{
    Clock, ClockHost, DocsTabsHost, FileParseHost, OpenFilesHost, SheetsTabsHost, UiLanguageHost,
};
use shell_ipc_w::home_files::{FileSearchHost, FolderTreeHost, FolderWatchHost, HomeFilesHost};
use shell_ipc_w::home_settings::HomeAppHost;
use shell_ipc_w::quick_look::{QuickLookEnginesHost, QuickLookHost, QuickLookWindowHost};
use shell_ipc_w::tabs::{TabHooks, WindowsHostRef};

use super::HostContext;
use super::unbuilt::Unbuilt;

/// `Date.now()`
struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0.0, |d| d.as_millis() as f64)
    }
}

pub fn install(hosts: &mut Hosts, _cx: &HostContext) {
    install_hosts(hosts);
}

fn install_hosts(hosts: &mut Hosts) {
    let clock: ClockHost = Arc::new(SystemClock);
    hosts.insert(clock);

    let stub = Arc::new(Unbuilt);
    macro_rules! stubs {
        ($($host:ty),* $(,)?) => {
            $({
                let host: $host = stub.clone();
                hosts.insert(host);
            })*
        };
    }
    stubs!(
        QuickLookHost,
        QuickLookWindowHost,
        QuickLookEnginesHost,
        DocPickerWindowHost,
        DocPickerSourcesHost,
        DocsTabsHost,
        SheetsTabsHost,
        OpenFilesHost,
        FileParseHost,
        UiLanguageHost,
        HomeFilesHost,
        FileSearchHost,
        FolderTreeHost,
        FolderWatchHost,
        HomeAppHost,
        WindowsHostRef,
    );
}

thread_local! {
    /// What the batches provide each other, kept on the core thread for the
    /// shell's own hosts whose calls start elsewhere (a menu click, a worker)
    static CORE_PROVIDED: RefCell<Option<Rc<Provided>>> = const { RefCell::new(None) };
}

/// The core thread, once the batches registered on it
static CORE: OnceLock<Arc<dyn Thread>> = OnceLock::new();

/// Runs `job` with the core thread's [`Provided`]: at once on the core
/// thread, else through `run_on(core, ..)`. `None` before the batches registered.
#[allow(dead_code)]
pub(crate) fn on_core<R: Send + 'static>(
    job: impl FnOnce(&Provided) -> R + Send + 'static,
) -> Option<R> {
    let core = CORE.get()?;
    let run = move || CORE_PROVIDED.with(|p| p.borrow().as_deref().map(job));
    if core.is_current() {
        run()
    } else {
        run_on(core.as_ref(), run)
    }
}

/// The batch that comes before the six: it adds what the shell provides on
/// the core thread. `tabs::register` takes the first `TabHooks` it finds.
pub fn register_hooks(
    registry: &mut dyn Registry,
    services: &Services,
) -> Result<(), RegisterError> {
    let _ = CORE.set(services.core.clone());
    let provided = registry.provided();
    let hooks: Rc<dyn TabHooks> = Rc::new(Unbuilt);
    provided.add::<dyn TabHooks>(hooks);
    CORE_PROVIDED.with(|p| *p.borrow_mut() = Some(provided));
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use shell_contract::hosts::{
        Clipboard, Contents, Dialogs, FileDialog, MessageBox, MessageBoxAnswer, OsShell,
    };
    use shell_contract::ids::{ViewId, WindowId};
    use shell_contract::ipc::{EventSink, Target};
    use shell_contract::runtime::{Services, Thread, Views, Workers, run_on};
    use shell_contract::value::IpcValue;
    use shell_contract::{ClipboardHost, ContentsHost, DialogsHost, OsShellHost};
    use shell_core::BATCHES;
    use shell_core::core_thread::{CoreThread, ThreadWorkers};
    use shell_core::table::{Completeness, build};

    use super::*;
    use crate::ipc::outlet::TauriOutlet;
    use crate::paths::ShellPaths;
    use crate::views::ViewTable;

    /// The shared hosts that need a window system, answering nothing
    struct Fake;

    impl Dialogs for Fake {
        fn open(&self, _: Option<WindowId>, _: &FileDialog) -> Option<Vec<std::path::PathBuf>> {
            None
        }
        fn save(&self, _: Option<WindowId>, _: &FileDialog) -> Option<std::path::PathBuf> {
            None
        }
        fn message(&self, _: Option<WindowId>, _: &MessageBox) -> MessageBoxAnswer {
            MessageBoxAnswer {
                response: 0,
                checkbox_checked: false,
            }
        }
        fn error(&self, _: &str, _: &str) {}
    }

    impl OsShell for Fake {
        fn open_external(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn open_path(&self, _: &Path) -> String {
            String::new()
        }
        fn show_item_in_folder(&self, _: &Path) {}
        fn trash_item(&self, _: &Path) -> Result<(), String> {
            Ok(())
        }
    }

    impl Clipboard for Fake {
        fn read_text(&self) -> String {
            String::new()
        }
        fn write_text(&self, _: &str) {}
        fn read_html(&self) -> String {
            String::new()
        }
        fn write_html(&self, _: &str, _: Option<&str>) {}
        fn read_image_png(&self) -> Vec<u8> {
            Vec::new()
        }
        fn write_image_png(&self, _: &[u8]) {}
        fn available_formats(&self) -> Vec<String> {
            Vec::new()
        }
    }

    impl Contents for Fake {
        fn window_of(&self, _: ViewId) -> Option<WindowId> {
            None
        }
        fn capture_png(&self, _: ViewId) -> Result<Vec<u8>, String> {
            Err("fake".into())
        }
        fn print_to_pdf(&self, _: ViewId, _: IpcValue) -> Result<Vec<u8>, String> {
            Err("fake".into())
        }
        fn print(&self, _: ViewId, _: IpcValue) -> Result<bool, String> {
            Ok(false)
        }
        fn zoom_factor(&self, _: ViewId) -> f64 {
            1.0
        }
        fn set_zoom_factor(&self, _: ViewId, _: f64) {}
        fn focus(&self, _: ViewId) {}
        fn close_window(&self, _: WindowId) {}
    }

    struct NoEvents;

    impl EventSink for NoEvents {
        fn emit(&self, _: Target, _: &'static str, _: Vec<IpcValue>) {}
    }

    /// The shell starts with the stubs: every batch registers, `tabs` finds its hooks
    #[test]
    fn the_batches_register_over_the_stubs() {
        let core = CoreThread::spawn("w-test-core");
        let core_thread: Arc<dyn Thread> = core.clone();
        let outlet = Arc::new(TauriOutlet::default());
        let views = Arc::new(ViewTable::new(outlet, core_thread.clone()));
        let mut hosts = Hosts::default();
        let dialogs: DialogsHost = Arc::new(Fake);
        let os: OsShellHost = Arc::new(Fake);
        let clipboard: ClipboardHost = Arc::new(Fake);
        let contents: ContentsHost = Arc::new(Fake);
        hosts.insert(dialogs);
        hosts.insert(os);
        hosts.insert(clipboard);
        hosts.insert(contents);
        crate::host::window::install_main_window(&mut hosts, &views);
        install_hosts(&mut hosts);
        // M's own hosts come from host::menu with an AppHandle; its fakes stand in here
        shell_ipc_m::probe_hosts(&mut hosts, &serde_json::Value::Null);
        let ui: Arc<dyn Thread> = CoreThread::spawn("w-test-ui");
        let services = Services {
            ui,
            core: core_thread.clone(),
            workers: Arc::new(ThreadWorkers) as Arc<dyn Workers>,
            events: Arc::new(NoEvents),
            views: views as Arc<dyn Views>,
            paths: Arc::new(ShellPaths::new()),
            hosts: Arc::new(hosts),
        };
        let batches: Vec<_> = std::iter::once(register_hooks as shell_contract::ipc::RegisterBatch)
            .chain(BATCHES.iter().copied())
            .collect();
        let registered = run_on(core.as_ref(), move || {
            build(&services, &batches, Completeness::AsRegistered)
                .map(|table| table.len())
                .map_err(|e| format!("{e:?}"))
        });
        let count = registered.expect("every batch registers");
        assert!(count > 100, "{count} handlers");
    }
}
