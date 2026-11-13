//! `packages/ai-provider/src/subscription/ipc.ts` wired as `apps/docs/src/main/docs-main.ts`
//! does in `registerAiIpc` (`ensureSubscriptionIpc(ipcMain, {...})`), and the
//! shell entry's `home:open-subscription-install-help`: the statuses of the
//! AI subscriptions (Claude Code, Codex, ChatGPT), signing in and out,
//! installing and updating the vendor CLIs, "use anyway" on a metered plan,
//! turning a CLI off, and `ai:subscription-changed` to every view.
//!
//! The handlers are `main_core::packages::ai_provider::subscription_ipc`; they
//! await the ai-provider runtime, so they run on the shared
//! [`crate::runtime::Driver`] (children, timers, the loopback server of the
//! ChatGPT sign-in through [`crate::runtime::Net`]). What the docs entry
//! passes in is built here: the settings file (read and written as
//! `storedAiSettings` and `writeAiSettingsFile` do), the broadcast, the
//! ChatGPT connection over `userData/chatgpt-connection.json`, and the
//! sign-in's `openBrowser` (a function the ported code calls by name,
//! [`OPEN_BROWSER_CALL`]).
//!
//! The registrations of the bridges that the TypeScript runs when it imports
//! them (`setSubscriptionModelSource`, `setCodexAccountSource`,
//! `onSubscriptionLoginChange`, `onSubscriptionOffChange`) are made on the
//! states this port creates, over the finder and child registry of the
//! driver's providers, so a run of the AI sees what the statuses see.
//! Everything other ports need of the process-wide registration
//! (`sharedSubscriptionStatuses`, the Codex image flag, the states) is
//! [`SubscriptionShared`], added to `Provided`.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use jscompat::JsonValue;
use main_core::docs::ai_run::{with_metered_accepted, with_subscription_off};
use main_core::packages::ai_provider::chatgpt_connection::{
    ChatGptConnection, ChatGptConnectionDeps,
};
use main_core::packages::ai_provider::chatgpt_credentials::ChatGptConnectionFileStore;
use main_core::packages::ai_provider::chatgpt_oauth::{
    ChatGptPages, JwtSignatureVerifier, OPEN_BROWSER_CALL,
};
use main_core::packages::ai_provider::chatgpt_responses;
use main_core::packages::ai_provider::claude_code_cli;
use main_core::packages::ai_provider::codex_app_server::codex_hooks;
use main_core::packages::ai_provider::fetch::KeyedFetchBase;
use main_core::packages::ai_provider::free_connect::FreeConnectPage;
use main_core::packages::ai_provider::image_backend::ImageBackendState;
use main_core::packages::ai_provider::providers::with_migrated_subscription_notice_version;
use main_core::packages::ai_provider::settings_secrets::{
    AiSecretCodec, CodecThrow, seal_ai_secrets,
};
use main_core::packages::ai_provider::stored_settings::with_stored_unknown_fields;
use main_core::packages::ai_provider::subscription_contract::{
    SUBSCRIPTION_CHATGPT_USAGE_URL, SUBSCRIPTION_INSTALL_URLS, is_subscription_provider_id,
};
use main_core::packages::ai_provider::subscription_ipc::{
    ChatGptSignInSetup, SubscriptionIpcSetup, SubscriptionIpcShared, create_subscription_ipc_deps,
    ensure_subscription_ipc,
};
use main_core::packages::ai_provider::subscription_launch::{
    LaunchState, SubscriptionLaunchState, SubscriptionLoginWindowText,
    on_subscription_login_change, on_subscription_off_change,
};
use main_core::packages::ai_provider::subscription_locate::{
    SubscriptionLocator, SubscriptionProgram,
};
use main_core::packages::ai_provider::subscription_models::{
    SubscriptionModelListOptions, SubscriptionModelLister, SubscriptionModelSource,
    SubscriptionModelsState,
};
use main_core::packages::ai_provider::subscription_service::SettingWriter;
use main_core::packages::ai_provider::subscription_status::{
    CodexAccountSource, StatusState, SubscriptionDetection, SubscriptionDetector,
    SubscriptionStatusState, set_codex_account_source,
};
use main_core::packages::ai_provider::task::JsError;
use main_core::packages::electron_utils::atomic_write::write_json_atomic;
use main_core::packages::electron_utils::safe_external_url::safe_external_url;
use main_core::slides::ai_ipc::stored_ai_settings;
use shell_contract::hosts::OsShellHost;
use shell_contract::ipc::{CallContext, EventSink, Responder, Target};
use shell_contract::provided::Provided;
use shell_contract::runtime::{PathName, Services};
use shell_contract::{Batch, IpcError, IpcValue};

use crate::ports::Subscription;
use crate::runtime::Driver;
use crate::secrets::SecretCodecHost;
use crate::value::{arg, from_json};

/// `SUBSCRIPTION_IPC_CHANNELS.changed`
const CHANGED: &str = "ai:subscription-changed";
/// `broadcastAiSettingsChanged()`
const SETTINGS_CHANGED: &str = "ai:settings-changed";
/// `PRODUCT_NAME`: the name OpenAI shows for this app on a first registration
const PRODUCT_NAME: &str = "SeuOffice";

/// What the docs entry reaches beyond main-core and the shared hosts
pub trait SubscriptionShell: Send + Sync {
    /// `getUiLang()`
    fn ui_lang(&self) -> String;
    /// `aiSubscriptionLoginWindowText(lang, provider)`: `{ title?, guide?, closing? }`
    fn login_window_text(&self, lang: &str, provider: &str) -> JsonValue;
    /// `aiChatGptSignInPages(lang)`: `{ done, failed }`, each `{ lang, title, body }`
    fn chat_gpt_sign_in_pages(&self, lang: &str) -> JsonValue;
    /// `signatureValid(alg, data, signature, jwk)` of the ChatGPT sign-in:
    /// `createPublicKey` and `verify` of `node:crypto`; `Err` is what they
    /// threw
    fn signature_valid(
        &self,
        alg: &str,
        data: &[u8],
        signature: &[u8],
        jwk: &JsonValue,
    ) -> Result<bool, String>;
}

pub type SubscriptionShellHost = Arc<dyn SubscriptionShell>;

/// The stand-ins `SubscriptionIpcSetup` takes for tests (`detect`,
/// `listModels`, `locate`): the shell inserts none and the real CLIs are
/// probed; the probe inserts one so that a case does not depend on the PCs
/// programs
pub trait SubscriptionStandIns: Send + Sync {
    /// `setup.detect(provider, { configuredPath })`: `Err` is a rejection
    fn detect(
        &self,
        provider: &str,
        configured_path: Option<&str>,
    ) -> Result<SubscriptionDetection, String>;
    /// `setup.listModels(provider, { configuredPath })`
    fn list_models(
        &self,
        provider: &str,
        configured_path: Option<&str>,
    ) -> Result<Vec<JsonValue>, String>;
    /// `setup.locate(provider, { configuredPath })`
    fn locate(
        &self,
        provider: &str,
        configured_path: Option<&str>,
    ) -> Result<Option<SubscriptionProgram>, String>;
}

pub type SubscriptionStandInsHost = Arc<dyn SubscriptionStandIns>;

/// What the process-wide registration is, for the ports that read it
/// (`sharedSubscriptionStatuses`, `codexImageGenerationAvailable`, the
/// launch and status states): added to `Provided` by the factory
pub struct SubscriptionShared {
    pub ipc: Rc<RefCell<SubscriptionIpcShared>>,
    pub image: Rc<RefCell<ImageBackendState>>,
    pub launch: LaunchState,
    pub status: StatusState,
}

/// What a [`SubscriptionShared`] is built from
pub struct Wiring {
    pub driver: Driver,
    pub events: Arc<dyn EventSink>,
    pub user_data: PathBuf,
    pub codec: SecretCodecHost,
    pub shell: SubscriptionShellHost,
    pub os: OsShellHost,
    pub stand_ins: Option<SubscriptionStandInsHost>,
    /// `process.platform` for the launchers; the driver's when `None`
    pub platform: Option<String>,
}

/// `Rc<dyn AiSecretCodec>` over the shell's shared codec
struct SharedCodec(SecretCodecHost);

impl AiSecretCodec for SharedCodec {
    fn seal(&self, plain: &str) -> Result<Option<String>, CodecThrow> {
        self.0.seal(plain)
    }
    fn open(&self, sealed: &str) -> Result<Option<String>, CodecThrow> {
        self.0.open(sealed)
    }
}

/// The `verifier` of the ChatGPT connection: the shell's crypto
struct HostVerifier(SubscriptionShellHost);

impl JwtSignatureVerifier for HostVerifier {
    fn signature_valid(
        &self,
        alg: &str,
        data: &[u8],
        signature: &[u8],
        jwk: &JsonValue,
    ) -> Result<bool, JsError> {
        self.0
            .signature_valid(alg, data, signature, jwk)
            .map_err(JsError::error)
    }
}

/// `readJson(path, {})`
fn read_raw(path: &str) -> JsonValue {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| jscompat::json_parse(&text).ok())
        .unwrap_or_else(|| JsonValue::Object(jscompat::JsObject::new()))
}

fn string_of(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// `{ title?, guide?, closing? }` as the window's words
fn window_text_of(value: &JsonValue) -> SubscriptionLoginWindowText {
    let JsonValue::Object(o) = value else {
        return SubscriptionLoginWindowText::default();
    };
    SubscriptionLoginWindowText {
        title: string_of(o.get("title")),
        guide: string_of(o.get("guide")),
        closing: string_of(o.get("closing")),
    }
}

/// `{ lang, title, body }`
fn page_of(value: Option<&JsonValue>) -> Result<FreeConnectPage, JsError> {
    let JsonValue::Object(o) = value.unwrap_or(&JsonValue::Null) else {
        return Err(JsError::type_error("a sign-in page is not an object"));
    };
    let field = |key: &str| string_of(o.get(key)).unwrap_or_default();
    Ok(FreeConnectPage {
        lang: field("lang"),
        title: field("title"),
        body: field("body"),
    })
}

fn pages_of(value: &JsonValue) -> Result<ChatGptPages, JsError> {
    let JsonValue::Object(o) = value else {
        return Err(JsError::type_error("the sign-in pages are not an object"));
    };
    Ok(ChatGptPages {
        done: page_of(o.get("done"))?,
        failed: page_of(o.get("failed"))?,
    })
}

/// `writeAiSettingsFile(settings)`: keys and tokens go to disk sealed, and
/// fields a newer build wrote stay as they are
fn write_file(path: &str, codec: &SecretCodecHost, settings: &JsonValue) -> Result<(), JsError> {
    let stored = read_raw(path);
    let sealed = seal_ai_secrets(
        Some(&**codec as &dyn AiSecretCodec),
        &with_stored_unknown_fields(settings, &stored),
    );
    write_json_atomic(path, &sealed).map_err(|e| JsError::error(e.message))
}

/// `writeAiSettingsFile(next(readJson(SETTINGS_PATH(), {})))`, then
/// `broadcastAiSettingsChanged()`
fn write_settings(
    path: &str,
    codec: &SecretCodecHost,
    events: &Arc<dyn EventSink>,
    next: impl FnOnce(&JsonValue) -> JsonValue,
) -> Result<(), JsError> {
    write_file(path, codec, &next(&read_raw(path)))?;
    events.emit(Target::All, SETTINGS_CHANGED, Vec::new());
    Ok(())
}

impl SubscriptionShared {
    /// `ensureSubscriptionIpc(ipcMain, setup)` of `registerAiIpc`, and the
    /// import-time registrations of the bridges
    pub fn build(wiring: Wiring) -> Rc<SubscriptionShared> {
        let Wiring {
            driver,
            events,
            user_data,
            codec,
            shell,
            os,
            stand_ins,
            platform,
        } = wiring;
        let rt = driver.rt();
        let providers = driver.providers();
        let launch: LaunchState = Rc::new(RefCell::new(SubscriptionLaunchState::new(
            providers.claude.locate.clone(),
            providers.claude.shared.clone(),
        )));
        let status: StatusState = Rc::new(RefCell::new(SubscriptionStatusState::new(
            providers.claude.locate.clone(),
            providers.claude.shared.clone(),
            providers.chatgpt.module.clone(),
        )));
        let models_state = Rc::new(RefCell::new(SubscriptionModelsState::default()));

        // the registrations the bridges make when they are imported
        claude_code_cli::install(&mut models_state.borrow_mut(), &rt, &providers.claude);
        chatgpt_responses::install(
            &mut models_state.borrow_mut(),
            &rt,
            &providers.fx,
            &providers.chatgpt.module,
        );
        let hooks = codex_hooks(&providers.codex);
        {
            let login = hooks.login_change.clone();
            on_subscription_login_change(
                &launch,
                Rc::new(move |provider| {
                    login(provider);
                    Ok(())
                }),
            );
            let off = hooks.off_change.clone();
            on_subscription_off_change(
                &launch,
                Rc::new(move |change| {
                    off(&change.provider, change.off);
                    Ok(())
                }),
            );
            let account = hooks.account_source.clone();
            let source: CodexAccountSource = Rc::new(move |rt, configured_path, signal| {
                let account = account.clone();
                Box::pin(async move { account(&rt, configured_path, signal).await })
            });
            set_codex_account_source(&status, Some(source));
            let models = hooks.model_source.clone();
            let model_rt = rt.clone();
            let source: SubscriptionModelSource = Rc::new(move |configured_path, signal| {
                let (models, rt) = (models.clone(), model_rt.clone());
                Box::pin(async move {
                    match models(&rt, configured_path, signal).await? {
                        JsonValue::Array(list) => Ok(list),
                        _ => Ok(Vec::new()),
                    }
                })
            });
            main_core::packages::ai_provider::subscription_models::set_subscription_model_source(
                &mut models_state.borrow_mut(),
                "codex",
                Some(source),
            );
        }

        // the process's `openBrowser` of the ChatGPT sign-in
        driver.on_call(OPEN_BROWSER_CALL, move |args, reply| {
            let url = match &args {
                JsonValue::Array(list) => match list.first() {
                    Some(JsonValue::String(url)) => Some(url.clone()),
                    _ => None,
                },
                _ => None,
            };
            let opened = safe_external_url(url.as_deref(), None)
                .is_some_and(|target| os.open_external(&target).is_ok());
            reply.value(JsonValue::Bool(opened));
        });

        let settings_path = user_data
            .join("ai-settings.json")
            .to_string_lossy()
            .into_owned();
        let data_dir = user_data.to_string_lossy().into_owned();

        // `getSettings: storedAiSettings`
        let get_settings: Rc<dyn Fn() -> Result<JsonValue, JsError>> = {
            let (path, codec) = (settings_path.clone(), codec.clone());
            Rc::new(move || {
                // `migratedNoticeVersion(raw)`: a file written before the notice
                // carried a version is written back with one
                let raw = read_raw(&path);
                let raw = match with_migrated_subscription_notice_version(&raw) {
                    Some(next) => {
                        write_file(&path, &codec, &next)?;
                        next
                    }
                    None => raw,
                };
                Ok(stored_ai_settings(
                    Some(&*codec as &dyn AiSecretCodec),
                    &raw,
                ))
            })
        };
        // `setMeteredAccepted` and `setSubscriptionOff`
        let metered: SettingWriter = {
            let (path, codec, events) = (settings_path.clone(), codec.clone(), events.clone());
            Rc::new(move |provider, accepted| {
                let (path, codec, events) = (path.clone(), codec.clone(), events.clone());
                Box::pin(async move {
                    let c = codec.clone();
                    write_settings(&path, &codec, &events, move |stored| {
                        with_metered_accepted(
                            Some(&*c as &dyn AiSecretCodec),
                            Some(stored),
                            &provider,
                            accepted,
                        )
                    })
                })
            })
        };
        let off: SettingWriter = {
            let (path, codec, events) = (settings_path, codec.clone(), events.clone());
            Rc::new(move |provider, off| {
                let (path, codec, events) = (path.clone(), codec.clone(), events.clone());
                Box::pin(async move {
                    let c = codec.clone();
                    write_settings(&path, &codec, &events, move |stored| {
                        with_subscription_off(
                            Some(&*c as &dyn AiSecretCodec),
                            Some(stored),
                            &provider,
                            off,
                        )
                    })
                })
            })
        };

        // the stand-ins of the probe
        let (detect, list_models, locate) = match &stand_ins {
            None => (None, None, None),
            Some(stand) => {
                let s = stand.clone();
                let detect: SubscriptionDetector = Rc::new(move |_rt, provider, options| {
                    let s = s.clone();
                    Box::pin(async move {
                        s.detect(&provider, options.configured_path.as_deref())
                            .map_err(JsError::error)
                    })
                });
                let s = stand.clone();
                let lister: SubscriptionModelLister = Rc::new(
                    move |_rt, provider, options: SubscriptionModelListOptions| {
                        let s = s.clone();
                        Box::pin(async move {
                            s.list_models(&provider, options.configured_path.as_deref())
                                .ok()
                                .map(JsonValue::Array)
                        })
                    },
                );
                let s = stand.clone();
                let locator: SubscriptionLocator = Rc::new(move |_rt, provider, options| {
                    let s = s.clone();
                    Box::pin(async move {
                        s.locate(&provider, options.configured_path.as_deref())
                            .map_err(JsError::error)
                    })
                });
                (Some(detect), Some(lister), Some(locator))
            }
        };

        let chat_gpt_connection = ChatGptConnection::new(ChatGptConnectionDeps {
            store: Rc::new(ChatGptConnectionFileStore::new(
                &data_dir,
                Some(Rc::new(SharedCodec(codec.clone()))),
            )),
            agent_name: PRODUCT_NAME.to_owned(),
            fx: providers.fx.clone(),
            fetch: KeyedFetchBase::Ai,
            now: None,
            verifier: Rc::new(HostVerifier(shell.clone())),
        });

        let broadcast_events = events.clone();
        let setup = SubscriptionIpcSetup {
            get_settings,
            set_metered_accepted: metered,
            set_subscription_off: Some(off),
            data_dir,
            broadcast: Some(Rc::new(move |_channel, statuses| {
                broadcast_events.emit(Target::All, CHANGED, vec![from_json(statuses)]);
            })),
            detect,
            list_models,
            models_state,
            locate,
            platform,
            kill_tree: None,
            hidden_login_timeout_ms: None,
            login_window_text: Some({
                let shell = shell.clone();
                Rc::new(move |provider: &str| {
                    let lang = shell.ui_lang();
                    Ok(window_text_of(&shell.login_window_text(&lang, provider)))
                })
            }),
            chat_gpt_sign_in: Some(ChatGptSignInSetup {
                pages: {
                    let shell = shell.clone();
                    Rc::new(move || {
                        let lang = shell.ui_lang();
                        pages_of(&shell.chat_gpt_sign_in_pages(&lang))
                    })
                },
            }),
            chat_gpt_connection,
        };

        let shared = Rc::new(RefCell::new(SubscriptionIpcShared::default()));
        // the Codex image backend is registered by `registerAiIpc` in every
        // process of this app (`registerCodexImageBackend`)
        let image = Rc::new(RefCell::new(ImageBackendState::new()));
        image
            .borrow_mut()
            .set_codex_image_generation_available(true);
        let (made_rt, made_launch, made_status) = (rt.clone(), launch.clone(), status.clone());
        ensure_subscription_ipc(&rt, &shared, &launch, &image, setup, move |setup| {
            create_subscription_ipc_deps(&made_rt, &made_launch, &made_status, setup)
        });
        Rc::new(SubscriptionShared {
            ipc: shared,
            image,
            launch,
            status,
        })
    }
}

pub struct SubscriptionPort {
    shared: Rc<SubscriptionShared>,
    driver: Driver,
    os: OsShellHost,
}

impl SubscriptionPort {
    pub fn new(shared: Rc<SubscriptionShared>, driver: Driver, os: OsShellHost) -> Self {
        SubscriptionPort { shared, driver, os }
    }

    /// The handler of `channel`, run on the driver; answered when it ends
    fn ask(&self, channel: &'static str, args: Vec<IpcValue>, reply: Responder) {
        let Some(ipc) = self.shared.ipc.borrow().ipc() else {
            reply.reply(Err(IpcError {
                name: Some("Error".into()),
                message: format!("No handler registered for '{channel}'"),
            }));
            return;
        };
        let payload = arg(&args, 0);
        self.driver.run(
            async move { ipc.handle(channel, payload.as_ref()).await },
            move |answer| {
                reply.reply(Ok(match answer {
                    Some(value) => from_json(&value),
                    None => IpcValue::Undefined,
                }))
            },
        );
    }
}

impl Subscription for SubscriptionPort {
    fn ai_subscription_cancel_login(&self, _: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.ask("ai:subscription-cancel-login", args, reply)
    }
    fn ai_subscription_codex_image(&self, _: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.ask("ai:subscription-codex-image", args, reply)
    }
    fn ai_subscription_install(&self, _: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.ask("ai:subscription-install", args, reply)
    }
    fn ai_subscription_login(&self, _: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.ask("ai:subscription-login", args, reply)
    }
    fn ai_subscription_logout(&self, _: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.ask("ai:subscription-logout", args, reply)
    }
    fn ai_subscription_metered(&self, _: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.ask("ai:subscription-metered", args, reply)
    }
    fn ai_subscription_off(&self, _: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.ask("ai:subscription-off", args, reply)
    }
    fn ai_subscription_recheck(&self, _: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.ask("ai:subscription-recheck", args, reply)
    }
    fn ai_subscription_statuses(&self, _: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.ask("ai:subscription-statuses", args, reply)
    }
    fn ai_subscription_update(&self, _: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.ask("ai:subscription-update", args, reply)
    }

    /// `SHELL_SUBSCRIPTION_CHANNELS.openInstallHelp`: the vendor's fixed
    /// install guide; the renderer only names the provider
    fn home_open_subscription_install_help(
        &self,
        _: &CallContext,
        args: Vec<IpcValue>,
        reply: Responder,
    ) {
        let provider = arg(&args, 0);
        if is_subscription_provider_id(provider.as_ref()) {
            let id = string_of(provider.as_ref()).unwrap_or_default();
            // ChatGPT installs nothing: its page is where the user sees and limits the app's use of the plan
            let page = if id == "chatgpt" {
                SUBSCRIPTION_CHATGPT_USAGE_URL
            } else {
                SUBSCRIPTION_INSTALL_URLS
                    .iter()
                    .find(|(known, _)| *known == id)
                    .map_or("", |(_, url)| url)
            };
            if let Some(url) = safe_external_url(Some(page), None) {
                // no browser handler available; nothing actionable for the user here
                let _ = self.os.open_external(&url);
            }
        }
        reply.reply(Ok(IpcValue::Undefined));
    }
}

/// The driver the shell provides once for every port
fn driver_of(provided: &Provided) -> Driver {
    provided
        .all::<Driver>()
        .first()
        .expect("the shared driver is provided before the ports are built")
        .as_ref()
        .clone()
}

/// The host the shell inserts for this port
pub fn factory() -> crate::Factory<dyn Subscription> {
    crate::Factory::new(|services: &Services, provided| {
        let hosts = &services.hosts;
        let driver = driver_of(provided);
        let os = hosts.need::<OsShellHost>(Batch::A)?;
        let shared = SubscriptionShared::build(Wiring {
            driver: driver.clone(),
            events: services.events.clone(),
            user_data: services.paths.path(PathName::UserData),
            codec: hosts.need::<SecretCodecHost>(Batch::A)?,
            shell: hosts.need::<SubscriptionShellHost>(Batch::A)?,
            os: os.clone(),
            stand_ins: hosts.get::<SubscriptionStandInsHost>().cloned(),
            platform: None,
        });
        provided.add(shared.clone());
        let port: Rc<dyn Subscription> = Rc::new(SubscriptionPort::new(shared, driver, os));
        Ok(port)
    })
}

#[cfg(test)]
mod tests;
