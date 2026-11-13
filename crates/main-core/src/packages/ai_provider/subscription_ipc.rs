//! `packages/ai-provider/src/subscription/ipc.ts`: the main-process side of
//! the subscription IPC contract: one handler per request channel, wired to
//! whatever the caller injects. Nothing here imports Electron.
//!
//! ## What stays in the host
//!
//! `ipcMain.handle(channel, listener)` and `removeHandler` are plumbing of
//! the host's: it registers [`SubscriptionIpc::channels`] and forwards each
//! request to [`SubscriptionIpc::handle`], which is the body of the handler
//! the TypeScript registers. What `registerSubscriptionIpc` does besides
//! registering (forward status changes to the `changed` channel, clear the
//! metered acceptance after a login or logout the app ran) is in
//! [`register_subscription_ipc`], and the function it answers is
//! [`SubscriptionIpc::unregister`].
//!
//! `createSubscriptionIpcDeps` takes the ChatGPT connection from the setup
//! (the TypeScript makes one over `createChatGptConnectionFileStore(dataDir)`
//! with the product name as the agent name; its fetch, clock and signature
//! check are the host's, so the host builds it). The stand-ins `spawn` has no
//! counterpart ([`Rt::spawn`] is the host's); `locate`, `killTree`,
//! `detect`, `listModels`, `platform`, `hiddenLoginTimeoutMs`,
//! `loginWindowText` are fields of [`SubscriptionIpcSetup`].
//!
//! ## State
//!
//! `sharedRegistration` is [`SubscriptionIpcShared`], which the caller owns.

use std::cell::RefCell;
use std::rc::{Rc, Weak};

use jscompat::{JsMap, JsonValue};

use super::chatgpt_connection::{ChatGptConnection, ChatGptSignInOptions, ChatGptSignInResult};
use super::chatgpt_oauth::{ChatGptPages, ChatGptSignInFailed, ChatGptSignInFailure};
use super::image_backend::ImageBackendState;
use super::jsval::{Obj, as_str, prop, prop2, text};
use super::provider_selection::is_subscription_provider;
use super::providers::is_subscription_cli;
use super::subscription_contract::{SUBSCRIPTION_IPC_CHANNELS, subscription_install_url};
use super::subscription_launch::{
    KillTree, LaunchState, StartedHook, SubscriptionInstallOptions, SubscriptionLaunchResult,
    SubscriptionLoginOptions, SubscriptionLoginWindowText, SubscriptionLogoutOptions,
    SubscriptionUpdateOptions, launch_subscription_install, launch_subscription_login,
    launch_subscription_logout, launch_subscription_update, on_subscription_login_change,
};
use super::subscription_locate::SubscriptionLocator;
use super::subscription_metered::create_metered_acceptance_file_store;
use super::subscription_models::{
    SubscriptionModelListOptions, SubscriptionModelLister, SubscriptionModelsState,
    list_subscription_models,
};
use super::subscription_service::{
    SettingWriter, SubscriptionServiceResult, SubscriptionStatusService,
    SubscriptionStatusServiceDeps, create_subscription_status_service,
};
use super::subscription_status::{Fut, StatusState, SubscriptionDetector, start_now, tick};
use super::task::{Id, JsError, Rt};

/// `SubscriptionIpcDeps.launchLogout`, `launchInstall`...: provider in, result out
pub type Launch = Rc<dyn Fn(String) -> Fut<Result<SubscriptionLaunchResult, JsError>>>;
/// `launchLogin(provider, mode)`
pub type LaunchLogin =
    Rc<dyn Fn(String, Option<String>) -> Fut<Result<SubscriptionLaunchResult, JsError>>>;
/// `broadcast(channel, payload)`
pub type Broadcast = Rc<dyn Fn(&str, &JsonValue)>;

/// `SubscriptionIpcDeps`
pub struct SubscriptionIpcDeps {
    pub service: SubscriptionStatusService,
    /// start the CLI's own login; `mode` `window` asks for its window
    pub launch_login: LaunchLogin,
    /// run the CLI's own logout to its end
    pub launch_logout: Launch,
    pub launch_install: Launch,
    /// run the official update of the CLI the app found, in a terminal window
    pub launch_update: Launch,
    /// end a login the app started; nothing to end is not a failure
    pub cancel_login: Launch,
    /// send an event to every window; called with the `changed` channel when a status changes
    pub broadcast: Option<Broadcast>,
}

/// `providerOf(payload)`
fn provider_of(payload: Option<&JsonValue>) -> Option<String> {
    let provider = payload.and_then(|p| prop(p, "provider"));
    if is_subscription_provider(provider) {
        as_str(provider).map(str::to_owned)
    } else {
        None
    }
}

/// `loginModeOf(payload)`: the login mode a renderer asked for. Only `window`
/// means anything: everything else (absent, `browser`, an unknown value) is
/// the browser sign-in as always.
fn login_mode_of(payload: Option<&JsonValue>) -> Option<String> {
    match payload.and_then(|p| prop(p, "mode")) {
        Some(JsonValue::String(mode)) if mode == "window" => Some("window".to_owned()),
        _ => None,
    }
}

/// `failure(error, provider)`
fn failure(error: &JsError, provider: &str) -> SubscriptionLaunchResult {
    SubscriptionLaunchResult {
        ok: false,
        reason: Some("failed".to_owned()),
        error: Some(error.message_or_string()),
        install_url: is_subscription_cli(Some(&text(provider)))
            .then(|| subscription_install_url(provider).to_owned()),
    }
}

/// `SUBSCRIPTION_IPC_CHANNELS[name]`
fn channel(name: &str) -> &'static str {
    SUBSCRIPTION_IPC_CHANNELS
        .iter()
        .find(|(known, _)| *known == name)
        .map_or("", |(_, channel)| *channel)
}

/// What `registerSubscriptionIpc` registered
pub struct SubscriptionIpc {
    rt: Rt,
    deps: Rc<SubscriptionIpcDeps>,
    image: Rc<RefCell<ImageBackendState>>,
    stop_listening: Rc<dyn Fn()>,
    stop_clearing: Rc<dyn Fn()>,
}

/// `registerSubscriptionIpc(ipcMain, deps)`, without the registering itself:
/// forward status changes to the `changed` channel and clear the metered
/// acceptance after a login or logout the app ran. Payloads come from a
/// renderer and are checked in [`SubscriptionIpc::handle`]: an unknown
/// provider is answered with `invalid`, never passed on, and so is a login,
/// logout, install, update or "use anyway" for a CLI turned off in this app
/// (none of them starts it).
pub fn register_subscription_ipc(
    rt: &Rt,
    launch: &LaunchState,
    deps: Rc<SubscriptionIpcDeps>,
    image: &Rc<RefCell<ImageBackendState>>,
) -> SubscriptionIpc {
    let service = deps.service.clone();
    let stop_listening: Rc<dyn Fn()> = match deps.broadcast.clone() {
        Some(broadcast) => service.on_change(Rc::new(move |statuses| {
            broadcast(channel("changed"), statuses);
            Ok(())
        })),
        None => Rc::new(|| ()),
    };
    // The app ran this provider's login or logout to its end. "Use anyway" was given for the
    // login before it, and the kind of login cannot tell that one from another account of the
    // same kind: the acceptance goes, the stored setting and the remembered kind with it.
    let stop_clearing = {
        let (service, rt) = (service.clone(), rt.clone());
        on_subscription_login_change(
            launch,
            Rc::new(move |provider| {
                let (service, provider) = (service.clone(), provider.to_owned());
                start_now(&rt, async move {
                    service.clear_metered_acceptance(&provider).await
                });
                Ok(())
            }),
        )
    };
    SubscriptionIpc {
        rt: rt.clone(),
        deps,
        image: image.clone(),
        stop_listening,
        stop_clearing,
    }
}

impl SubscriptionIpc {
    /// The request channels the handlers answer, in the order they register
    pub fn channels() -> Vec<&'static str> {
        [
            "statuses",
            "recheck",
            "login",
            "logout",
            "install",
            "update",
            "cancelLogin",
            "metered",
            "off",
            "codexImage",
        ]
        .into_iter()
        .map(channel)
        .collect()
    }

    /// The function `registerSubscriptionIpc` answers: stops forwarding
    /// changes and clearing acceptances (the host removes its handlers)
    pub fn unregister(&self) {
        (self.stop_listening)();
        (self.stop_clearing)();
    }

    /// The handler of `channel` run on `payload`; `None` for a channel that
    /// has none
    pub async fn handle(
        &self,
        channel_name: &str,
        payload: Option<&JsonValue>,
    ) -> Option<JsonValue> {
        let service = &self.deps.service;
        let known = Self::channels();
        let index = known.iter().position(|known| *known == channel_name)?;
        Some(match index {
            // statuses
            0 => {
                let statuses = service.get_statuses();
                // a window that asks before anything was checked starts the first check; the answer
                // arrives on the `changed` channel (overlapping checks share one run)
                let checking = match &statuses {
                    JsonValue::Object(map) => map
                        .entries()
                        .iter()
                        .any(|(_, status)| as_str(prop(status, "state")) == Some("checking")),
                    _ => false,
                };
                if checking {
                    let service = service.clone();
                    // `void service.check().catch(...)`: the check starts now
                    start_now(&self.rt, async move {
                        service.check(None, false).await;
                    });
                }
                statuses
            }
            // recheck
            1 => {
                let requested = payload.and_then(|p| prop(p, "providers"));
                let providers: Vec<String> = match requested {
                    Some(JsonValue::Array(list)) => list
                        .iter()
                        .filter(|p| is_subscription_provider(Some(p)))
                        .filter_map(|p| as_str(Some(p)).map(str::to_owned))
                        .collect(),
                    _ => Vec::new(),
                };
                service
                    .check(
                        if providers.is_empty() {
                            None
                        } else {
                            Some(&providers[..])
                        },
                        false,
                    )
                    .await
            }
            // login: a function per call, so a launcher replaced on `deps` later is the one that runs
            2 => {
                let mode = login_mode_of(payload);
                let deps = self.deps.clone();
                self.launch_handler(payload, true, move |provider| {
                    (deps.launch_login)(provider, mode)
                })
                .await
                .to_json()
            }
            // logout: the provider is looked at again before the answer goes back, so the window
            // that asked already shows the outcome; a logout that failed may have signed the CLI
            // out all the same. A check of its own time: one already under way may have asked
            // before the logout ended.
            3 => {
                let deps = self.deps.clone();
                let rt = self.rt.clone();
                self.launch_handler(payload, true, move |provider| {
                    Box::pin(async move {
                        let outcome = (deps.launch_logout)(provider.clone()).await;
                        // `return await ...`
                        tick(&rt).await;
                        // `finally { await service.check(...).catch(...) }`
                        deps.service.check(Some(&[provider][..]), true).await;
                        tick(&rt).await;
                        tick(&rt).await;
                        outcome
                    })
                })
                .await
                .to_json()
            }
            4 => {
                let deps = self.deps.clone();
                self.launch_handler(payload, true, move |provider| {
                    (deps.launch_install)(provider)
                })
                .await
                .to_json()
            }
            5 => {
                let deps = self.deps.clone();
                self.launch_handler(payload, true, move |provider| {
                    (deps.launch_update)(provider)
                })
                .await
                .to_json()
            }
            6 => {
                let deps = self.deps.clone();
                self.launch_handler(payload, false, move |provider| {
                    (deps.cancel_login)(provider)
                })
                .await
                .to_json()
            }
            // metered
            7 => {
                let provider = provider_of(payload);
                let accepted = payload.and_then(|p| prop(p, "accepted"));
                // consent is a real boolean from the UI, not anything truthy
                let (Some(provider), Some(JsonValue::Bool(accepted))) = (provider, accepted) else {
                    return Some(
                        SubscriptionServiceResult {
                            ok: false,
                            statuses: service.get_statuses(),
                        }
                        .to_json(),
                    );
                };
                let off = service.is_off(&provider).await;
                tick(&self.rt).await;
                if off {
                    return Some(
                        SubscriptionServiceResult {
                            ok: false,
                            statuses: service.get_statuses(),
                        }
                        .to_json(),
                    );
                }
                let answered = service.set_metered_accepted(&provider, *accepted).await;
                // the async handler returns a promise, which its own promise adopts in two turns
                tick(&self.rt).await;
                tick(&self.rt).await;
                answered.to_json()
            }
            // off: decision 0114: the screen offers it on the Settings cards alone (the shell preload)
            8 => {
                let provider = provider_of(payload);
                let off = payload.and_then(|p| prop(p, "off"));
                let (Some(provider), Some(JsonValue::Bool(off))) = (provider, off) else {
                    return Some(self.refused().to_json());
                };
                if !is_subscription_cli(Some(&text(provider.clone()))) {
                    return Some(self.refused().to_json());
                }
                let result = service.set_off(&provider, *off).await;
                tick(&self.rt).await;
                if !result.ok || !*off {
                    return Some(result.to_json());
                }
                // a sign-in the app started for it ends with it: nothing is left running for a program off
                // `await deps.cancelLogin(provider).catch(...)`: the `catch` is a promise of its own
                let _ = (self.deps.cancel_login)(provider).await;
                tick(&self.rt).await;
                tick(&self.rt).await;
                SubscriptionServiceResult {
                    ok: true,
                    statuses: service.get_statuses(),
                }
                .to_json()
            }
            // true only in a process that loaded the Codex image backend (it registers itself on import)
            _ => JsonValue::Bool(self.image.borrow().codex_image_generation_available()),
        })
    }

    fn refused(&self) -> SubscriptionServiceResult {
        SubscriptionServiceResult {
            ok: false,
            statuses: self.deps.service.get_statuses(),
        }
    }

    /// `launch(start)` and, with `check_off`, `launchOn(start)`: the provider
    /// is checked, a CLI turned off in this app is refused (`invalid`), and a
    /// launcher that rejects answers a `failed` result
    async fn launch_handler(
        &self,
        payload: Option<&JsonValue>,
        check_off: bool,
        start: impl FnOnce(String) -> Fut<Result<SubscriptionLaunchResult, JsError>>,
    ) -> SubscriptionLaunchResult {
        let Some(provider) = provider_of(payload) else {
            return SubscriptionLaunchResult::failure("invalid");
        };
        let rt = &self.rt;
        let answered = if check_off {
            // `async (provider) => (await service.isOff(provider)) ? invalid : start(provider)`
            let off = self.deps.service.is_off(&provider).await;
            tick(rt).await;
            if off {
                Ok(SubscriptionLaunchResult::failure("invalid"))
            } else {
                let started = start(provider.clone()).await;
                // the async arrow returns a promise, which its own promise adopts in two turns
                tick(rt).await;
                tick(rt).await;
                started
            }
        } else {
            start(provider.clone()).await
        };
        // `await start(provider)`
        tick(rt).await;
        match answered {
            Ok(result) => result,
            Err(error) => failure(&error, &provider),
        }
    }
}

/// `SubscriptionIpcSetup.chatGptSignIn`: how the system browser is opened
/// (the host function of [`super::chatgpt_oauth::OPEN_BROWSER_CALL`]), and
/// what it shows once it is back on this PC, in the app's language. Without
/// it the ChatGPT login answers `unsupported`.
#[derive(Clone)]
pub struct ChatGptSignInSetup {
    pub pages: Rc<dyn Fn() -> Result<ChatGptPages, JsError>>,
}

/// `loginWindowText`: the window's words
pub type LoginWindowTextFn = Rc<dyn Fn(&str) -> Result<SubscriptionLoginWindowText, JsError>>;

/// `SubscriptionIpcSetup`
pub struct SubscriptionIpcSetup {
    /// the AI settings as stored right now
    pub get_settings: Rc<dyn Fn() -> Result<JsonValue, JsError>>,
    /// persist `AiSettings.meteredAccepted[provider]`
    pub set_metered_accepted: SettingWriter,
    /// persist `AiSettings.subscriptionOff[provider]` (decision 0114); without
    /// it a CLI cannot be turned off or on from this process
    pub set_subscription_off: Option<SettingWriter>,
    /// the app's userData directory: the metered acceptance record is kept here
    pub data_dir: String,
    pub broadcast: Option<Broadcast>,
    /// stand-in for tests; `detectSubscriptionLogin` when absent
    pub detect: Option<SubscriptionDetector>,
    /// stand-in for tests; the lists the bridges registered (`listSubscriptionModels`) when absent
    pub list_models: Option<SubscriptionModelLister>,
    /// the registry of model sources `listSubscriptionModels` reads
    pub models_state: Rc<RefCell<SubscriptionModelsState>>,
    pub locate: Option<SubscriptionLocator>,
    pub platform: Option<String>,
    /// stand-in for tests: how a login is ended
    pub kill_tree: Option<KillTree>,
    /// stand-in for tests; [`HIDDEN_LOGIN_TIMEOUT_MS`] when absent
    pub hidden_login_timeout_ms: Option<f64>,
    /// What the visible login window says besides what the CLI prints, in the
    /// app's language. The app's own fixed strings: nothing a window sent.
    pub login_window_text: Option<LoginWindowTextFn>,
    /// The ChatGPT sign-in (decision 0081)
    pub chat_gpt_sign_in: Option<ChatGptSignInSetup>,
    /// the ChatGPT connection (a stand-in in tests; the host's own otherwise)
    pub chat_gpt_connection: ChatGptConnection,
}

/// A browser sign-in the app started, with the CLI's window hidden, is ended
/// after this long; the provider then shows its login button again.
pub const HIDDEN_LOGIN_TIMEOUT_MS: f64 = 10.0 * 60_000.0;

/// `PendingLogin`
struct PendingLogin {
    mode: String,
    /// ends the login; asked before the program was found, it ends the login
    /// once it starts
    stop: Rc<dyn Fn()>,
    stopped: bool,
    timer: Option<Id>,
}

type Login = Rc<RefCell<PendingLogin>>;

/// What the closures of `createSubscriptionIpcDeps` close over
struct Ctx {
    rt: Rt,
    launch: LaunchState,
    setup: SubscriptionIpcSetup,
    service: SubscriptionStatusService,
    chat_gpt: ChatGptConnection,
    logins: RefCell<JsMap<Login>>,
    platform: String,
}

/// `setup.getSettings().providers?.[provider]?.cliPath`
fn cli_path_of(setup: &SubscriptionIpcSetup, provider: &str) -> Result<Option<String>, JsError> {
    let settings = (setup.get_settings)()?;
    Ok(
        as_str(prop2(Some(&settings), "providers", provider).and_then(|p| prop(p, "cliPath")))
            .map(str::to_owned),
    )
}

fn sign_in_failure_json(failed: &ChatGptSignInFailed) -> JsonValue {
    let mut out = Obj::new();
    out.set("reason", text(failed.reason.as_str()));
    if let Some(step) = failed.step {
        out.set("step", text(step));
    }
    if let Some(status) = failed.http_status {
        out.set("httpStatus", JsonValue::Number(status));
    }
    if let Some(error) = failed.oauth_error.as_ref().filter(|e| !e.is_empty()) {
        out.set("oauthError", text(error.clone()));
    }
    JsonValue::Object(out)
}

impl Ctx {
    /// A check of its own time, off to the side: `void service.check([provider], { fresh: true })`
    fn recheck(&self, provider: &str) {
        let (service, provider) = (self.service.clone(), provider.to_owned());
        start_now(&self.rt, async move {
            service.check(Some(&[provider][..]), true).await;
        });
    }

    fn same_login(&self, provider: &str, login: &Login) -> bool {
        self.logins
            .borrow()
            .get(provider)
            .is_some_and(|current| Rc::ptr_eq(current, login))
    }

    /// The app's own browser sign-in; a press while one runs leaves it running
    async fn launch_chat_gpt_login(self: &Rc<Self>) -> Result<SubscriptionLaunchResult, JsError> {
        if self.logins.borrow().has("chatgpt") {
            return Ok(SubscriptionLaunchResult::ok());
        }
        let Some(sign_in) = &self.setup.chat_gpt_sign_in else {
            return Ok(SubscriptionLaunchResult::failure("unsupported"));
        };
        let attempt = self.rt.controller();
        let stopper = attempt.clone();
        let login: Login = Rc::new(RefCell::new(PendingLogin {
            mode: "browser".to_owned(),
            stop: Rc::new(move || stopper.abort(None)),
            stopped: false,
            timer: None,
        }));
        self.logins.borrow_mut().set("chatgpt", login.clone());
        self.service.set_login_unfinished("chatgpt", false, None);
        self.service.set_signing_in("chatgpt", Some("browser"));
        let pages = (sign_in.pages)()?;
        let ctx = self.clone();
        start_now(&self.rt, async move {
            let result = ctx
                .chat_gpt
                .sign_in(
                    &ctx.rt,
                    &ChatGptSignInOptions {
                        pages,
                        signal: Some(attempt),
                        timeout_ms: None,
                    },
                )
                .await
                .unwrap_or(ChatGptSignInResult::Failed(ChatGptSignInFailed {
                    reason: ChatGptSignInFailure::Network,
                    step: None,
                    http_status: None,
                    oauth_error: None,
                }));
            // `.catch(...)` and `.then(...)`
            tick(&ctx.rt).await;
            tick(&ctx.rt).await;
            if !ctx.same_login("chatgpt", &login) {
                return;
            }
            ctx.logins.borrow_mut().delete("chatgpt");
            ctx.service.set_signing_in("chatgpt", None);
            // a sign-in nobody finished, or one that failed: the card says why and offers it again
            if let ChatGptSignInResult::Failed(failed) = &result
                && failed.reason != ChatGptSignInFailure::Cancelled
            {
                ctx.service.set_login_unfinished(
                    "chatgpt",
                    true,
                    Some(&sign_in_failure_json(failed)),
                );
            }
            ctx.recheck("chatgpt");
        });
        Ok(SubscriptionLaunchResult::ok())
    }

    /// `end(unfinished)` of `launchLogin`
    fn end_login(self: &Rc<Self>, provider: &str, login: &Login, unfinished: bool) {
        self.rt.clear_timeout(login.borrow().timer);
        // a login replaced by its window has ended, but the window has not
        if !self.same_login(provider, login) {
            return;
        }
        self.logins.borrow_mut().delete(provider);
        self.service.set_signing_in(provider, None);
        // a check of its own time: one already under way may have asked before the login ended
        let (ctx, provider) = (self.clone(), provider.to_owned());
        start_now(&self.rt, async move {
            let statuses = ctx.service.check(Some(&[provider.clone()][..]), true).await;
            // `.then(...)`
            tick(&ctx.rt).await;
            // it ended on its own and still no login: the browser may have handed back a
            // code nobody pasted, so the card offers the window instead of repeating it
            if !unfinished || ctx.logins.borrow().has(&provider) {
                return;
            }
            if as_str(prop2(Some(&statuses), &provider, "state")) == Some("signed-out") {
                ctx.service.set_login_unfinished(&provider, true, None);
            }
        });
    }

    async fn launch_login(
        self: &Rc<Self>,
        provider: &str,
        requested: Option<&str>,
    ) -> Result<SubscriptionLaunchResult, JsError> {
        if provider == "chatgpt" {
            return self.launch_chat_gpt_login().await;
        }
        let current = self.logins.borrow().get(provider).cloned();
        // the window is already open: it is where the user is now
        if current
            .as_ref()
            .is_some_and(|c| c.borrow().mode == "window")
        {
            return Ok(SubscriptionLaunchResult::ok());
        }
        // On Windows the first press signs in in the browser alone, with the CLI's window
        // hidden; a press while that runs, or a press that asks for the window, opens it
        // instead, for a code the browser shows. Elsewhere the CLI has no window to show,
        // so a press while it runs changes nothing and both are the same login.
        if current.is_some() && self.platform != "win32" {
            return Ok(SubscriptionLaunchResult::ok());
        }
        let mode = if current.is_some() || (requested == Some("window") && self.platform == "win32")
        {
            "window"
        } else {
            "browser"
        };
        if let Some(current) = current {
            let stop = current.borrow().stop.clone();
            stop();
        }
        let login: Login = Rc::new(RefCell::new(PendingLogin {
            mode: mode.to_owned(),
            stop: Rc::new(|| ()),
            stopped: false,
            timer: None,
        }));
        {
            let weak: Weak<RefCell<PendingLogin>> = Rc::downgrade(&login);
            login.borrow_mut().stop = Rc::new(move || {
                if let Some(login) = weak.upgrade() {
                    login.borrow_mut().stopped = true;
                }
            });
        }
        self.logins.borrow_mut().set(provider, login.clone());
        // a login is starting: whatever the last one left behind no longer applies
        self.service.set_login_unfinished(provider, false, None);
        self.service.set_signing_in(provider, Some(mode));
        let configured_path = cli_path_of(&self.setup, provider)?;
        let window_text = if mode == "window" {
            self.setup
                .login_window_text
                .as_ref()
                .and_then(|words| words(provider).ok())
        } else {
            None
        };
        let on_started: StartedHook = {
            let (ctx, login) = (self.clone(), login.clone());
            let browser = mode == "browser";
            Rc::new(move |stop| {
                // cancelled, turned off or replaced while the program was being looked for
                if login.borrow().stopped {
                    stop();
                    return;
                }
                login.borrow_mut().stop = stop.clone();
                // a sign-in nobody finishes does not wait unseen for ever
                if browser {
                    let timer = ctx.rt.set_timeout(
                        ctx.setup
                            .hidden_login_timeout_ms
                            .unwrap_or(HIDDEN_LOGIN_TIMEOUT_MS),
                        move || stop(),
                    );
                    login.borrow_mut().timer = Some(timer);
                }
            })
        };
        let on_exit: Rc<dyn Fn()> = {
            let (ctx, login, provider) = (self.clone(), login.clone(), provider.to_owned());
            Rc::new(move || ctx.end_login(&provider, &login, true))
        };
        let result = launch_subscription_login(
            &self.rt,
            &self.launch,
            provider,
            &SubscriptionLoginOptions {
                configured_path,
                window: Some(
                    if mode == "browser" {
                        "hidden"
                    } else {
                        "visible"
                    }
                    .to_owned(),
                ),
                window_text,
                on_started: Some(on_started),
                on_exit: Some(on_exit),
                locate: self.setup.locate.clone(),
                platform: Some(self.platform.clone()),
                kill_tree: self.setup.kill_tree.clone(),
                ..SubscriptionLoginOptions::default()
            },
        )
        .await;
        // `await launchSubscriptionLogin(...)`
        tick(&self.rt).await;
        if !result.ok {
            self.end_login(provider, &login, false);
        }
        Ok(result)
    }

    async fn launch_logout(&self, provider: &str) -> Result<SubscriptionLaunchResult, JsError> {
        if provider != "chatgpt" {
            let result = launch_subscription_logout(
                &self.rt,
                &self.launch,
                provider,
                &SubscriptionLogoutOptions {
                    configured_path: cli_path_of(&self.setup, provider)?,
                    ..SubscriptionLogoutOptions::default()
                },
            )
            .await;
            // the async function returns a promise, which its own promise adopts in two turns
            tick(&self.rt).await;
            tick(&self.rt).await;
            return Ok(result);
        }
        self.chat_gpt.sign_out(&self.rt).await?;
        // `await chatGpt.signOut()`
        tick(&self.rt).await;
        Ok(SubscriptionLaunchResult::ok())
    }

    async fn launch_update(&self, provider: &str) -> Result<SubscriptionLaunchResult, JsError> {
        Ok(launch_subscription_update(
            &self.rt,
            &self.launch,
            provider,
            &SubscriptionUpdateOptions {
                install: SubscriptionInstallOptions {
                    platform: Some(self.platform.clone()),
                    env: None,
                },
                configured_path: cli_path_of(&self.setup, provider)?,
                locate: self.setup.locate.clone(),
            },
        )
        .await)
    }

    fn cancel_login(&self, provider: &str) -> SubscriptionLaunchResult {
        let login = self.logins.borrow().get(provider).cloned();
        let Some(login) = login else {
            return SubscriptionLaunchResult::ok();
        };
        self.rt.clear_timeout(login.borrow().timer);
        // gone from the list first: the exit that follows finds nothing left to end
        self.logins.borrow_mut().delete(provider);
        self.service.set_signing_in(provider, None);
        let stop = login.borrow().stop.clone();
        stop();
        self.recheck(provider);
        SubscriptionLaunchResult::ok()
    }
}

/// `createSubscriptionIpcDeps(setup)`: the real dependencies for
/// `registerSubscriptionIpc`: a status service over the app's settings that
/// also reads each CLI's model list, and the launchers. After a login window
/// closes the provider is checked again, by a check that starts then, so the
/// UI follows without being asked.
pub fn create_subscription_ipc_deps(
    rt: &Rt,
    launch: &LaunchState,
    status: &StatusState,
    setup: SubscriptionIpcSetup,
) -> SubscriptionIpcDeps {
    // the process's ChatGPT connection, over the same data folder as the metered record
    let chat_gpt = setup.chat_gpt_connection.clone();
    status
        .borrow()
        .chat_gpt
        .borrow_mut()
        .set_chatgpt_connection(Some(chat_gpt.clone()));
    let read_settings = setup.get_settings.clone();
    let list_models: SubscriptionModelLister = match &setup.list_models {
        Some(list_models) => list_models.clone(),
        None => {
            let models_state = setup.models_state.clone();
            Rc::new(move |rt, provider, options: SubscriptionModelListOptions| {
                let models_state = models_state.clone();
                Box::pin(async move {
                    list_subscription_models(&rt, &models_state, &provider, &options).await
                })
            })
        }
    };
    let service = create_subscription_status_service(
        rt,
        launch,
        status,
        SubscriptionStatusServiceDeps {
            get_settings: Rc::new(move || {
                let read = read_settings.clone();
                Box::pin(async move { read() })
            }),
            set_metered_accepted: setup.set_metered_accepted.clone(),
            set_subscription_off: setup.set_subscription_off.clone(),
            acceptance_store: create_metered_acceptance_file_store(rt, &setup.data_dir),
            detect: setup.detect.clone(),
            list_models: Some(list_models),
            on_change: None,
            timeout_ms: None,
        },
    );
    // a session that came or went (a sign-in, a sign-out, one OpenAI ended) shows at once
    {
        let (rt, service) = (rt.clone(), service.clone());
        chat_gpt.on_change(Rc::new(move || {
            let service = service.clone();
            start_now(&rt, async move {
                service.check(Some(&["chatgpt".to_owned()][..]), true).await;
            });
        }));
    }
    let platform = setup.platform.clone().unwrap_or_else(|| rt.platform());
    let broadcast = setup.broadcast.clone();
    let ctx = Rc::new(Ctx {
        rt: rt.clone(),
        launch: launch.clone(),
        setup,
        service: service.clone(),
        chat_gpt,
        logins: RefCell::new(JsMap::new()),
        platform,
    });
    let launcher =
        |run: fn(Rc<Ctx>, String) -> Fut<Result<SubscriptionLaunchResult, JsError>>| -> Launch {
            let ctx = ctx.clone();
            Rc::new(move |provider| run(ctx.clone(), provider))
        };
    SubscriptionIpcDeps {
        service,
        launch_login: {
            let ctx = ctx.clone();
            Rc::new(move |provider, requested| {
                let ctx = ctx.clone();
                Box::pin(async move { ctx.launch_login(&provider, requested.as_deref()).await })
            })
        },
        launch_logout: launcher(|ctx, provider| {
            Box::pin(async move { ctx.launch_logout(&provider).await })
        }),
        // there is no program to install or update for ChatGPT: those answer `invalid`
        launch_install: launcher(|ctx, provider| {
            Box::pin(async move {
                Ok(launch_subscription_install(
                    &ctx.rt,
                    &provider,
                    &SubscriptionInstallOptions::default(),
                )
                .await)
            })
        }),
        launch_update: launcher(|ctx, provider| {
            Box::pin(async move { ctx.launch_update(&provider).await })
        }),
        cancel_login: launcher(|ctx, provider| {
            Box::pin(async move { Ok(ctx.cancel_login(&provider)) })
        }),
        broadcast,
    }
}

/// `sharedRegistration`: the registration of the process, which the caller owns
#[derive(Default)]
pub struct SubscriptionIpcShared {
    registration: Option<(Rc<SubscriptionIpcDeps>, Rc<SubscriptionIpc>)>,
}

impl SubscriptionIpcShared {
    /// The registration of the process, for the host to wire to its `ipcMain`
    pub fn ipc(&self) -> Option<Rc<SubscriptionIpc>> {
        self.registration.as_ref().map(|(_, ipc)| ipc.clone())
    }
}

/// `ensureSubscriptionIpc(ipcMain, setup, createDeps)`: register the
/// subscription channels once per process, whoever asks first. Several
/// editors' main-process modules run in one process in the packaged app, and
/// registering a channel twice throws, so every caller goes through this
/// instead of [`register_subscription_ipc`]: the first call registers, later
/// calls get the same dependencies back. Nothing is checked here: the first
/// window that asks for the statuses starts the first check, so a process that
/// never shows AI (a headless export, a second instance about to quit) does
/// not start the vendor programs at all.
pub fn ensure_subscription_ipc(
    rt: &Rt,
    shared: &Rc<RefCell<SubscriptionIpcShared>>,
    launch: &LaunchState,
    image: &Rc<RefCell<ImageBackendState>>,
    setup: SubscriptionIpcSetup,
    create_deps: impl FnOnce(SubscriptionIpcSetup) -> SubscriptionIpcDeps,
) -> Rc<SubscriptionIpcDeps> {
    if let Some((deps, _)) = &shared.borrow().registration {
        return deps.clone();
    }
    let deps = Rc::new(create_deps(setup));
    let ipc = Rc::new(register_subscription_ipc(rt, launch, deps.clone(), image));
    shared.borrow_mut().registration = Some((deps.clone(), ipc));
    deps
}

/// `sharedSubscriptionStatuses()`: the statuses of the process-wide
/// registration, as the main process decides on them (which provider runs,
/// which route a tool takes); empty until `ensureSubscriptionIpc` ran. The
/// account a CLI names is left out: it is for the windows to show and has no
/// part in any decision, so it does not travel with the run and tool contexts
/// built from this.
pub fn shared_subscription_statuses(shared: &Rc<RefCell<SubscriptionIpcShared>>) -> JsonValue {
    let known = shared
        .borrow()
        .registration
        .as_ref()
        .map(|(deps, _)| deps.service.get_statuses());
    let mut statuses = Obj::new();
    if let Some(JsonValue::Object(known)) = known {
        for (_, status) in known.entries() {
            let mut copy = super::jsval::spread(Some(status));
            copy = super::jsval::without(&copy, &["account"]);
            let provider = as_str(copy.get("provider"))
                .unwrap_or("undefined")
                .to_owned();
            statuses.set(provider, JsonValue::Object(copy));
        }
    }
    JsonValue::Object(statuses)
}

/// `resetSharedSubscriptionIpc()`: drop the process-wide registration (tests,
/// and an app that tears its IPC down).
pub fn reset_shared_subscription_ipc(shared: &Rc<RefCell<SubscriptionIpcShared>>) {
    let registration = shared.borrow_mut().registration.take();
    if let Some((_, ipc)) = registration {
        ipc.unregister();
    }
}
