//! Batch U's hosts (host/crash.rs): the crash watch of `crash-watch.ts` and
//! the heartbeat of `crash-heartbeat.ts`, over main-core's
//! `shell::crash_watch` and `shell::crash_heartbeat`.
//!
//! - A view's renderer that ends (CEF's `RendererTerminated` of a main frame,
//!   Electron's `render-process-gone`) leaves a line in
//!   `<userData>/crash-log.jsonl`. When it showed a document, the person is
//!   asked whether to reload it, reopen it (its file, or an untitled
//!   document's recovery copy) or close it.
//! - Every 30 s the shell writes `<userData>/crash-heartbeat.json`; a run
//!   that ended without its end mark is reported at the next start as a
//!   `main-gone` line. The quit path writes the mark.
//!
//! CEF does not say why a renderer ended (Electron's `reason`): every end is
//! recorded as `crashed` with exit code 0. A view the shell closed or
//! released on purpose is closed by then and no longer in the view table,
//! so it does not reach here.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::OnceLock;
use std::time::Duration;

use main_core::packages::electron_utils::message_box::ParentWindow;
use main_core::packages::i18n::Lang;
use main_core::shell::crash_heartbeat::{
    HEARTBEAT_MS, HeartbeatEnd, HeartbeatHandle, HeartbeatOptions, start_heartbeat,
};
use main_core::shell::crash_watch::{
    CrashContents, CrashMemory, CrashStringKey, CrashWatch, CrashWatchHost, CrashedDocument,
    RenderGone, crash_log_path,
};
use main_core::shell::renderer_disposal::{Failure, RendererDisposal};
use main_core::shell::tab_manager::TabKind;
use shell_contract::hosts::{MessageBox, MessageBoxAnswer};
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::runtime::{PathName, Services};
use shell_contract::{DialogsHost, Hosts, Provided};
use shell_ipc_w::editor_files::UiLanguageHost;
use shell_ipc_w::tabs::TabsState;

use super::HostContext;
use super::w::post_core;

pub fn install(_hosts: &mut Hosts, _cx: &HostContext) {
    // the heartbeat starts with the event loop, a beat every HEARTBEAT_MS
    std::thread::Builder::new()
        .name("seuoffice-heartbeat".into())
        .spawn(|| {
            // the first beat once the core thread runs the batches
            std::thread::sleep(Duration::from_secs(1));
            loop {
                post_core(|_, services| beat(services));
                std::thread::sleep(Duration::from_millis(HEARTBEAT_MS as u64));
            }
        })
        .ok();
}

thread_local! {
    static HEARTBEAT: RefCell<Option<HeartbeatHandle<'static>>> = const { RefCell::new(None) };
    static WATCH: RefCell<Option<CrashWatch<Watch>>> = const { RefCell::new(None) };
}

fn user_data(services: &Services) -> String {
    services
        .paths
        .path(PathName::UserData)
        .to_string_lossy()
        .into_owned()
}

/// userData and the crash log, fixed for the process: the heartbeat borrows them
static HEARTBEAT_PATHS: OnceLock<(String, String)> = OnceLock::new();

fn beat(services: &Services) {
    HEARTBEAT.with(|h| {
        let mut h = h.borrow_mut();
        match h.as_mut() {
            Some(handle) => handle.tick(),
            None => {
                let (dir, log) = HEARTBEAT_PATHS.get_or_init(|| {
                    let dir = user_data(services);
                    let log = crash_log_path(&dir);
                    (dir, log)
                });
                *h = Some(start_heartbeat(HeartbeatOptions {
                    user_data_dir: dir,
                    log_path: log,
                    // no memory figures yet: a beat without them, as a `memory()` that throws
                    memory: Box::new(|| Err(())),
                    now: None,
                    wall_clock: None,
                    write_json: None,
                }));
            }
        }
    });
}

/// The quit path: the run ends on purpose, so the next start reports nothing
pub fn mark_ended() {
    post_core(|_, _| {
        HEARTBEAT.with(|h| {
            if let Some(handle) = h.borrow_mut().as_mut() {
                handle.mark_ended(HeartbeatEnd::Quit);
            }
        });
    });
}

/// A view's main frame lost its renderer; called on the UI thread
pub fn renderer_terminated(view: ViewId) {
    post_core(move |provided, services| gone(view, provided, services));
}

fn gone(view: ViewId, provided: &Provided, services: &Services) {
    let Some(tabs) = provided.all::<TabsState>().into_iter().next() else {
        return;
    };
    let Some(lang) = services.hosts.get::<UiLanguageHost>().cloned() else {
        return;
    };
    let host = Watch {
        tabs,
        lang,
        user_data: user_data(services),
        prompt: !std::env::args().any(|a| a == "--headless" || a.starts_with("--export")),
    };
    let dialogs = services.hosts.get::<DialogsHost>().cloned();
    WATCH.with(|w| {
        let mut w = w.borrow_mut();
        let watch = w.get_or_insert_with(|| CrashWatch::start(host));
        let wc = View(view);
        let details = RenderGone {
            reason: "crashed".to_owned(),
            exit_code: 0.0,
        };
        let prompt = match watch.on_render_process_gone(&RendererDisposal::new(), &wc, &details) {
            Ok(Some(prompt)) => prompt,
            Ok(None) => return,
            Err(error) => {
                eprintln!("shell: the crash watch failed: {error:?}");
                return;
            }
        };
        let Some(dialogs) = dialogs else {
            watch.finish_prompt(&wc, prompt, Err(Failure("no dialogs".into())));
            return;
        };
        let parent = if prompt.over_parent {
            watch.host().tabs.dialog_parent(view)
        } else {
            None
        };
        let o = &prompt.options;
        let MessageBoxAnswer { response, .. } = dialogs.message(
            parent,
            &MessageBox {
                kind: Some(o.kind.to_owned()),
                title: o.title.clone(),
                message: o.message.clone(),
                detail: o.detail.clone(),
                buttons: o.buttons.clone(),
                default_id: Some(o.default_id as usize),
                cancel_id: o.cancel_id.map(|c| c as usize),
                checkbox_label: None,
            },
        );
        watch.finish_prompt(&wc, prompt, Ok(response as f64));
    });
}

/// The view a renderer ended in
struct View(ViewId);

impl CrashContents for View {
    fn id(&self) -> i64 {
        i64::from(self.0.0)
    }
    fn is_destroyed(&self) -> bool {
        false
    }
    fn reload(&self) -> Result<(), Failure> {
        Err(Failure("reloading a view is not built yet".into()))
    }
}

struct Parent;

impl ParentWindow for Parent {
    fn is_destroyed(&self) -> bool {
        false
    }
}

/// `startCrashWatch`'s options, as `index.ts` gives them
struct Watch {
    tabs: Rc<TabsState>,
    lang: UiLanguageHost,
    user_data: String,
    prompt: bool,
}

fn kind_name(kind: TabKind) -> String {
    format!("{kind:?}").to_lowercase()
}

impl CrashWatchHost for Watch {
    type Contents = View;
    type Window = Parent;
    type Copy = ();

    fn user_data_dir(&self) -> String {
        self.user_data.clone()
    }
    fn now_ms(&self) -> f64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
    }
    fn editor_of(&self, wc: &View) -> Result<String, Failure> {
        if self.tabs.shell_window().is_some_and(|s| s.view == wc.0) {
            return Ok("home".to_owned());
        }
        Ok(self
            .tabs
            .document_of(wc.0)
            .map_or_else(|| "other".to_owned(), |d| kind_name(d.kind)))
    }
    fn document_of(&self, wc: &View) -> Result<Option<CrashedDocument>, Failure> {
        Ok(self.tabs.document_of(wc.0).and_then(|d| {
            let kind = kind_name(d.kind);
            (kind != "home" && kind != "help").then(|| CrashedDocument {
                title: d
                    .file_path
                    .as_deref()
                    .and_then(|p| std::path::Path::new(p).file_name())
                    .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
                kind,
                file_path: d.file_path,
            })
        }))
    }
    fn parent_window(&self, wc: &View) -> Result<Option<Parent>, Failure> {
        Ok(self.tabs.dialog_parent(wc.0).map(|_: WindowId| Parent))
    }
    fn close_document(&self, wc: &View) -> Result<bool, Failure> {
        let wc_id = i64::from(wc.0.0);
        Ok(self
            .tabs
            .with_manager(|m, host| {
                m.tab_id_for_web_contents(host, wc_id)
                    .is_some_and(|id| m.close_tab_without_prompt(host, &id))
            })
            .unwrap_or(false))
    }
    fn reopen(&self, file_path: &str) -> Result<(), Failure> {
        self.tabs.open_document_path(file_path);
        Ok(())
    }
    fn untitled_copy_of(&self, _wc: &View) -> Result<Option<()>, Failure> {
        // an untitled document's copy comes back through the launch list
        Ok(None)
    }
    fn can_reopen_untitled(&self) -> bool {
        false
    }
    fn reopen_untitled(&self, _doc: &CrashedDocument, _copy: &()) -> Result<(), Failure> {
        Ok(())
    }
    fn t(&self, key: CrashStringKey, title: Option<&str>) -> String {
        crash_text(key, title, self.lang.lang())
    }
    fn prompt(&self) -> bool {
        self.prompt
    }
    fn memory(&self) -> Option<Result<CrashMemory, Failure>> {
        None
    }
    fn warn_unhandled_rejection(&self, error: &str) {
        eprintln!("[main] unhandled rejection: {error}");
    }
}

/// `tm(key, params)` of the crash prompt: the shell's strings in `index.ts`
fn crash_text(key: CrashStringKey, title: Option<&str>, lang: Lang) -> String {
    let ko = lang == Lang::Ko;
    let text = match key {
        CrashStringKey::CrashTitle if ko => "문서가 예기치 않게 멈췄습니다",
        CrashStringKey::CrashTitle => "A document stopped unexpectedly",
        CrashStringKey::CrashBody if ko => {
            "\"{title}\" 화면이 예기치 않게 꺼졌습니다. 마지막으로 저장한 뒤의 변경은 사라졌을 수 있습니다."
        }
        CrashStringKey::CrashBody => {
            "\"{title}\" stopped unexpectedly. Changes made since it was last saved may be lost."
        }
        CrashStringKey::CrashReopen if ko => "다시 열기",
        CrashStringKey::CrashReopen => "Reopen",
        CrashStringKey::CrashReload if ko => "다시 불러오기",
        CrashStringKey::CrashReload => "Reload",
        CrashStringKey::CrashClose if ko => "닫기",
        CrashStringKey::CrashClose => "Close",
        CrashStringKey::CrashLater if ko => "나중에",
        CrashStringKey::CrashLater => "Not Now",
    };
    text.replace("{title}", title.unwrap_or_default())
}
