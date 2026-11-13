//! `apps/docs/src/main/free-ai-ipc.ts`: the free connections' IPC (Settings
//! and the first-run guide call it): the OpenRouter browser sign-in, the
//! Gemini key check, removing a connection, today's remaining free requests,
//! and the page where a key is made. The judgment is
//! `main_core::docs::free_ai_ipc`'s ([`FreeAiIpc`]); what it asks of the
//! entry is [`FreeAiHost`] (the settings the docs entry reads and writes, the
//! window it raises, the HTTP client and the loopback server of
//! `free-connect`).
//!
//! A sign-in is a long wait that another `connect` or a `cancel` interrupts:
//! `connect` plans on the core thread, runs the network on a worker and
//! finishes on the core thread. The abort of an attempt reaches the worker
//! as its [`CancelToken`].

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use jscompat::JsonValue;
use main_core::docs::free_ai_ipc::AttemptId;
use main_core::docs::free_ai_ipc::{
    ConnectPlan, FreeAiIpc, FreeAiIpcHost, WindowCommand, WindowState, disconnect, open_key_page,
    open_router_options, quota_key,
};
use main_core::packages::ai_provider::free_connect::{
    FreeConnectFailure, FreeConnectNet, FreeConnectResult, OpenRouterHost, connect_gemini,
    connect_open_router, open_router_free_quota,
};
use main_core::packages::electron_utils::safe_external_url::safe_external_url;
use main_core::packages::i18n::Lang;
use shell_contract::hosts::OsShellHost;
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::runtime::{CancelToken, Services};
use shell_contract::{Batch, IpcValue, ViewId};

use crate::ports::FreeAi;
use crate::value::{arg, from_json};

/// `options.openBrowser` of `connectOpenRouter`: `Ok(false)` where the address
/// is not safe to open or no browser took it
pub type OpenBrowser = Arc<dyn Fn(&str) -> Result<bool, String> + Send + Sync>;

/// Batch A host of the free AI IPC: the docs entry's deps and the network
pub trait FreeAiHost: Send + Sync {
    /// `deps.readSettings()`: the settings file as every reader gets it
    fn read_settings(&self) -> JsonValue;
    /// `deps.writeSettings(settings)`: checks, writes and announces new
    /// settings; `false` when they were refused
    fn write_settings(&self, settings: &JsonValue) -> bool;
    /// `getUiLang()`
    fn ui_lang(&self) -> Lang;
    /// `deps.windowFor(event.sender)`, as `isDestroyed()` and `isMinimized()`
    /// read it; `None` where there is no window
    fn window_state(&self, view: ViewId) -> Option<WindowState>;
    /// `win.restore()`, `win.show()`, `win.focus()` of that window
    fn window_command(&self, view: ViewId, command: WindowCommand);
    /// The `fetch` of `connectGemini` and `openRouterFreeQuota`, aborted by
    /// `signal`; used on a worker
    fn net(&self, signal: CancelToken) -> Box<dyn FreeConnectNet>;
    /// The host of `connectOpenRouter`: `fetch`, the PKCE random bytes, the
    /// loopback servers and the timer; `open_browser` is its `openBrowser`;
    /// used on a worker
    fn open_router(
        &self,
        signal: CancelToken,
        open_browser: OpenBrowser,
    ) -> Box<dyn OpenRouterHost>;
}

pub type FreeAiHostHandle = Arc<dyn FreeAiHost>;

/// `shell.openExternal` behind `safeExternalUrl`: `openInBrowser`
fn open_in_browser(os: &OsShellHost, url: &str) -> bool {
    match safe_external_url(Some(url), None) {
        Some(target) => os.open_external(&target).is_ok(),
        None => false,
    }
}

/// What `main_core::docs::free_ai_ipc` asks of Electron, over the host
struct Bridge<'a> {
    host: &'a FreeAiHostHandle,
    os: &'a OsShellHost,
    view: ViewId,
}

impl FreeAiIpcHost for Bridge<'_> {
    fn read_settings(&mut self) -> JsonValue {
        self.host.read_settings()
    }

    fn write_settings(&mut self, settings: &JsonValue) -> bool {
        self.host.write_settings(settings)
    }

    fn open_external(&mut self, url: &str) -> Result<(), String> {
        self.os.open_external(url)
    }

    fn window_state(&mut self) -> Option<WindowState> {
        self.host.window_state(self.view)
    }

    fn window_command(&mut self, command: WindowCommand) {
        self.host.window_command(self.view, command)
    }
}

/// The `pending` attempt and the signal of each attempt in flight; on the
/// core thread
struct Core {
    services: Services,
    host: FreeAiHostHandle,
    os: OsShellHost,
    state: RefCell<FreeAiIpc>,
    signals: RefCell<Vec<(AttemptId, CancelToken)>>,
}

thread_local! {
    static CORES: RefCell<Vec<Rc<Core>>> = const { RefCell::new(Vec::new()) };
}

/// Runs `f` with the core registered at `index`, on the core thread
fn with_core<R>(index: usize, f: impl FnOnce(&Rc<Core>) -> R) -> Option<R> {
    let core = CORES.with(|cores| cores.borrow().get(index).cloned())?;
    Some(f(&core))
}

impl Core {
    /// `abort()` of an attempt: its signal fires
    fn abort(&self, attempt: AttemptId) {
        for (_, signal) in self
            .signals
            .borrow()
            .iter()
            .filter(|(id, _)| *id == attempt)
        {
            signal.cancel();
        }
    }

    fn forget(&self, attempt: AttemptId) {
        self.signals.borrow_mut().retain(|(id, _)| *id != attempt);
    }
}

pub struct FreeAiPort {
    core: Rc<Core>,
    index: usize,
}

impl FreeAiPort {
    /// The answer the handler gives once the network step has its result
    fn answer(result: JsonValue) -> IpcValue {
        from_json(&result)
    }
}

impl FreeAi for FreeAiPort {
    fn ai_free_connect(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let core = &self.core;
        let view = cx.sender.view;
        let input = arg(&args, 0);
        let plan = core.state.borrow_mut().plan_connect(input.as_ref());
        let host = core.host.clone();
        let core_thread = core.services.core.clone();
        let index = self.index;
        match plan {
            ConnectPlan::Invalid => reply.reply(Ok(Self::answer(
                FreeConnectResult::Failed(FreeConnectFailure::Invalid).to_json(),
            ))),
            ConnectPlan::Gemini { api_key } => {
                // `connectGemini(input.apiKey)` has no signal: nothing aborts it
                core.services.workers.spawn(Box::new(move || {
                    let mut net = host.net(CancelToken::default());
                    let result = connect_gemini(&mut *net, api_key.as_ref());
                    core_thread.post(Box::new(move || {
                        with_core(index, |core| {
                            let mut bridge = Bridge {
                                host: &core.host,
                                os: &core.os,
                                view,
                            };
                            let answer = FreeAiIpc::finish_gemini(&mut bridge, &result);
                            reply.reply(Ok(Self::answer(answer)));
                        });
                    }));
                }));
            }
            ConnectPlan::OpenRouter { attempt, replaced } => {
                // `pending?.abort()` of the attempt this one replaced
                if let Some(old) = replaced {
                    core.abort(old);
                    core.forget(old);
                }
                let signal = CancelToken::default();
                core.signals.borrow_mut().push((attempt, signal.clone()));
                let options = open_router_options(host.ui_lang());
                let os = core.os.clone();
                let open_browser: OpenBrowser = Arc::new(move |url| Ok(open_in_browser(&os, url)));
                core.services.workers.spawn(Box::new(move || {
                    let mut router = host.open_router(signal, open_browser);
                    let result = connect_open_router(&mut *router, &options);
                    core_thread.post(Box::new(move || {
                        with_core(index, |core| {
                            let mut bridge = Bridge {
                                host: &core.host,
                                os: &core.os,
                                view,
                            };
                            let answer = core.state.borrow_mut().finish_open_router(
                                &mut bridge,
                                attempt,
                                &result,
                            );
                            core.forget(attempt);
                            reply.reply(Ok(Self::answer(answer)));
                        });
                    }));
                }));
            }
        }
    }

    fn ai_free_connect_cancel(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let aborted = self.core.state.borrow_mut().cancel();
        if let Some(attempt) = aborted {
            self.core.abort(attempt);
        }
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn ai_free_disconnect(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let mut bridge = Bridge {
            host: &self.core.host,
            os: &self.core.os,
            view: cx.sender.view,
        };
        disconnect(&mut bridge, arg(&args, 0).as_ref());
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn ai_free_open_key_page(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let mut bridge = Bridge {
            host: &self.core.host,
            os: &self.core.os,
            view: cx.sender.view,
        };
        open_key_page(&mut bridge, arg(&args, 0).as_ref());
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn ai_free_quota(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let core = &self.core;
        let mut bridge = Bridge {
            host: &core.host,
            os: &core.os,
            view: cx.sender.view,
        };
        // Gemini has no endpoint that tells the remaining free requests
        let Some(key) = quota_key(&mut bridge, arg(&args, 0).as_ref()) else {
            return reply.reply(Ok(IpcValue::Null));
        };
        let host = core.host.clone();
        let core_thread = core.services.core.clone();
        core.services.workers.spawn(Box::new(move || {
            let mut net = host.net(CancelToken::default());
            let quota = open_router_free_quota(&mut *net, &key);
            core_thread.post(Box::new(move || {
                reply.reply(Ok(quota.as_ref().map_or(IpcValue::Null, from_json)));
            }));
        }));
    }
}

/// The port the shell inserts
pub fn factory() -> crate::Factory<dyn FreeAi> {
    crate::Factory::new(|services, _| {
        let hosts = &services.hosts;
        let core = Rc::new(Core {
            services: services.clone(),
            host: hosts.need::<FreeAiHostHandle>(Batch::A)?,
            os: hosts.need::<OsShellHost>(Batch::A)?,
            state: RefCell::new(FreeAiIpc::new()),
            signals: RefCell::default(),
        });
        let index = CORES.with(|cores| {
            let mut cores = cores.borrow_mut();
            cores.push(core.clone());
            cores.len() - 1
        });
        let port: Rc<dyn FreeAi> = Rc::new(FreeAiPort { core, index });
        Ok(port)
    })
}

#[cfg(test)]
mod tests;
