//! `apps/docs/src/main/free-ai-ipc.ts`: the free connections' IPC (Settings
//! and the first-run guide call it): the OpenRouter browser sign-in, the
//! Gemini key check, removing a connection, today's remaining free requests,
//! and the page where a key is made.
//!
//! `ipcMain.handle` stays in TypeScript. The module-level `pending`
//! `AbortController` is [`FreeAiIpc`]; because a sign-in is a long wait that
//! another `connect` or a `cancel` interrupts, `connect` is in phases the
//! caller drives around its network calls: [`FreeAiIpc::plan_connect`], the
//! sign-in itself (`connect_open_router` or `connect_gemini` of
//! `free_connect`, with an [`FreeAiIpc::attempt_aborted`] signal), then
//! [`FreeAiIpc::finish_open_router`] or [`FreeAiIpc::finish_gemini`]. The
//! `quota` handler is [`quota_key`] and `open_router_free_quota`.
//!
//! Engine-waiting: the HTTP client and the loopback server of `free_connect`,
//! `shell.openExternal`.

use crate::packages::ai_provider::free_ai_browser::{
    free_ai_key_page, is_free_ai_provider, with_free_ai_connection, without_free_ai_connection,
};
use crate::packages::ai_provider::free_connect::{
    FreeConnectFailure, FreeConnectPage, FreeConnectResult, OpenRouterConnectOptions,
};
use crate::packages::ai_provider::jsval::{as_str, object, prop, text};
use crate::packages::electron_utils::safe_external_url::safe_external_url;
use crate::packages::i18n::Lang;

use super::free_ai_strings::free_ai_page_i18n;
use jscompat::JsonValue;

/// one browser sign-in still waiting for OpenRouter
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttemptId(u64);

/// `let pending: AbortController | null`, and the abort state of each
/// attempt that was made
#[derive(Debug, Default)]
pub struct FreeAiIpc {
    next: u64,
    pending: Option<AttemptId>,
    aborted: Vec<AttemptId>,
}

/// What a connect request asks for.
#[derive(Debug, Clone, PartialEq)]
pub enum ConnectPlan {
    /// the provider is neither of the two: `{ ok: false, reason: 'invalid' }`
    Invalid,
    /// `connectGemini(input.apiKey)`: the key as the renderer sent it
    Gemini { api_key: Option<JsonValue> },
    /// the browser sign-in; `replaced` is the attempt this one aborted
    OpenRouter {
        attempt: AttemptId,
        replaced: Option<AttemptId>,
    },
}

/// the window state `raiseWindowOf` reads
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowState {
    pub destroyed: bool,
    pub minimized: bool,
}

/// the calls `raiseWindowOf` makes on the window
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowCommand {
    Restore,
    Show,
    Focus,
}

/// `FreeAiIpcDeps` and the Electron objects the handlers reach.
pub trait FreeAiIpcHost {
    /// `deps.readSettings()`: the settings file as every reader gets it
    fn read_settings(&mut self) -> JsonValue;
    /// `deps.writeSettings(settings)`: checks, writes and announces new
    /// settings; false when they were refused
    fn write_settings(&mut self, settings: &JsonValue) -> bool;
    /// `shell.openExternal(url)`; `Err` where it rejects
    fn open_external(&mut self, url: &str) -> Result<(), String>;
    /// `deps.windowFor(event.sender)`: `None` where there is no window
    fn window_state(&mut self) -> Option<WindowState>;
    /// `win.restore()`, `win.show()`, `win.focus()`
    fn window_command(&mut self, command: WindowCommand);
}

/// `providerOf(input)`: the free provider an input names
fn provider_of(input: Option<&JsonValue>) -> Option<&str> {
    let provider = input.and_then(|i| prop(i, "provider"));
    if is_free_ai_provider(provider) {
        as_str(provider)
    } else {
        None
    }
}

/// `openInBrowser(url)`: `false` where the address is not safe to open or no
/// browser took it
pub fn open_in_browser(host: &mut dyn FreeAiIpcHost, url: &str) -> bool {
    let Some(target) = safe_external_url(Some(url), None) else {
        return false;
    };
    host.open_external(&target).is_ok()
}

/// `raiseWindowOf(event, deps)`: after the browser sign-in the user is still
/// in the browser: bring the app back
fn raise_window(host: &mut dyn FreeAiIpcHost) {
    let Some(state) = host.window_state() else {
        return;
    };
    if state.destroyed {
        return;
    }
    if state.minimized {
        host.window_command(WindowCommand::Restore);
    }
    host.window_command(WindowCommand::Show);
    host.window_command(WindowCommand::Focus);
}

/// `save(provider, result)`: a made connection is written here, in the main
/// process, so the key OpenRouter hands back never passes through a renderer.
fn save(host: &mut dyn FreeAiIpcHost, provider: &str, result: &FreeConnectResult) -> JsonValue {
    let (api_key, model) = match result {
        FreeConnectResult::Failed(_) => return result.to_json(),
        FreeConnectResult::Ok { api_key, model } => (api_key, model),
    };
    let current = host.read_settings();
    let written = host.write_settings(&with_free_ai_connection(&current, provider, api_key, model));
    if written {
        object(vec![
            ("ok", JsonValue::Bool(true)),
            ("provider", text(provider)),
            ("model", text(model.as_str())),
        ])
    } else {
        object(vec![
            ("ok", JsonValue::Bool(false)),
            ("reason", text("network")),
        ])
    }
}

/// the page the browser shows after the sign-in, by outcome
pub fn open_router_options(lang: Lang) -> OpenRouterConnectOptions {
    let t = free_ai_page_i18n();
    let page = |title: &str, body: &str| FreeConnectPage {
        lang: lang.as_str().to_owned(),
        title: t.t(lang, title, None),
        body: t.t(lang, body, None),
    };
    OpenRouterConnectOptions {
        done: page("pageDoneTitle", "pageDoneBody"),
        failed: page("pageFailedTitle", "pageFailedBody"),
        timeout_ms: None,
    }
}

impl FreeAiIpc {
    pub fn new() -> Self {
        Self::default()
    }

    /// the start of the `connect` handler: what the input asks for. A new
    /// browser sign-in aborts the one still waiting.
    pub fn plan_connect(&mut self, input: Option<&JsonValue>) -> ConnectPlan {
        match provider_of(input) {
            Some("gemini") => ConnectPlan::Gemini {
                api_key: input.and_then(|i| prop(i, "apiKey")).cloned(),
            },
            Some("openrouter") => {
                let replaced = self.pending;
                if let Some(old) = replaced {
                    self.aborted.push(old);
                }
                let attempt = AttemptId(self.next);
                self.next += 1;
                self.pending = Some(attempt);
                ConnectPlan::OpenRouter { attempt, replaced }
            }
            _ => ConnectPlan::Invalid,
        }
    }

    /// `attempt.signal.aborted`
    pub fn attempt_aborted(&self, attempt: AttemptId) -> bool {
        self.aborted.contains(&attempt)
    }

    /// `save('gemini', result)`: `result` is what `connectGemini` answered
    pub fn finish_gemini(host: &mut dyn FreeAiIpcHost, result: &FreeConnectResult) -> JsonValue {
        save(host, "gemini", result)
    }

    /// after `connectOpenRouter` answered `result`: bring the window back
    /// unless the sign-in was cancelled, save the connection, and free
    /// `pending` (the `finally`) if it is still this attempt
    pub fn finish_open_router(
        &mut self,
        host: &mut dyn FreeAiIpcHost,
        attempt: AttemptId,
        result: &FreeConnectResult,
    ) -> JsonValue {
        let cancelled = matches!(
            result,
            FreeConnectResult::Failed(FreeConnectFailure::Cancelled)
        );
        if !cancelled {
            raise_window(host);
        }
        let answer = save(host, "openrouter", result);
        self.end_attempt(attempt);
        answer
    }

    /// `if (pending === attempt) pending = null`: the `finally` of a connect
    /// that ended without an answer
    pub fn end_attempt(&mut self, attempt: AttemptId) {
        if self.pending == Some(attempt) {
            self.pending = None;
        }
    }

    /// the `cancel` handler: `pending?.abort(); pending = null`; the attempt
    /// aborted
    pub fn cancel(&mut self) -> Option<AttemptId> {
        let aborted = self.pending.take();
        if let Some(attempt) = aborted {
            self.aborted.push(attempt);
        }
        aborted
    }
}

/// the `disconnect` handler
pub fn disconnect(host: &mut dyn FreeAiIpcHost, input: Option<&JsonValue>) {
    let Some(provider) = provider_of(input) else {
        return;
    };
    let current = host.read_settings();
    host.write_settings(&without_free_ai_connection(&current, provider));
}

/// the start of the `quota` handler: the OpenRouter key whose allowance is
/// asked, or `None` where the answer is `null` (Gemini has no endpoint that
/// tells the remaining free requests). The caller asks with
/// `open_router_free_quota`.
pub fn quota_key(host: &mut dyn FreeAiIpcHost, input: Option<&JsonValue>) -> Option<String> {
    if provider_of(input) != Some("openrouter") {
        return None;
    }
    let settings = host.read_settings();
    let key = prop(&settings, "providers")
        .and_then(|p| prop(p, "openrouter"))
        .and_then(|o| prop(o, "apiKey"));
    Some(as_str(key).unwrap_or("").to_owned())
}

/// the `openKeyPage` handler
pub fn open_key_page(host: &mut dyn FreeAiIpcHost, input: Option<&JsonValue>) {
    if let Some(provider) = provider_of(input)
        && let Some(page) = free_ai_key_page(provider)
    {
        open_in_browser(host, page);
    }
}
