//! `packages/google-drive/src/connection.ts`: one Drive connection per app:
//! the refresh token kept in a vault the caller supplies (the shell encrypts
//! it with the operating system), the access token in memory only, refreshed
//! shortly before it runs out. When Google says the grant is gone, the
//! connection forgets the token and reports itself disconnected.
//!
//! The caller's `TokenVault` is three functions the runtime asks for by name:
//! `vault.load()` (a string, or null), `vault.save(refreshToken)` (true when
//! the token was kept) and `vault.clear()`; `openBrowser(url)` of the sign-in
//! is asked for the same way (see `oauth`).

use std::cell::RefCell;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Waker};

use jscompat::JsonValue;

use crate::packages::ai_provider::jsval::js_string;

use super::drive_api::{AccessTokenSource, DriveAccount, DriveApi, DriveApiOptions};
use super::oauth::{
    Clock, GoogleClient, GoogleSignInFailure, GoogleSignInOptions, GoogleTokens, PickRequest,
    RefreshFailure, SignInPages, clock_now, refresh_google_token, revoke_google_token,
    sign_in_with_google,
};
use crate::packages::ai_provider::task::{Fetcher, LocalBoxFuture, Rt, Signal};

/// `DriveConnectionState`. `Unavailable`: this build has no Google client, so
/// Drive is not offered; `Disconnected`: no connection (`expired`: Google
/// ended a connection the app had, shown once, so the user knows why it is
/// gone); `Connected`: a usable connection (the account is filled once Drive
/// has answered).
#[derive(Debug, Clone, PartialEq)]
pub enum DriveConnectionState {
    Unavailable,
    Disconnected {
        expired: bool,
    },
    /// `persisted` is what the vault's `save` answered (`undefined` when it
    /// answered nothing, so the key is left out where the state is written)
    Connected {
        account: Option<DriveAccount>,
        persisted: Option<JsonValue>,
    },
}

/// `DriveConnectionOptions` without the vault, which is asked for by name.
#[derive(Clone)]
pub struct DriveConnectionOptions {
    pub client: Option<GoogleClient>,
    /// the token exchange and every Drive call but a file's bytes; it must not follow a redirect
    pub fetch: Fetcher,
    /// a file's bytes; see `DriveApiOptions::download`
    pub download: Option<Fetcher>,
    /// `now`: `Date.now` when absent
    pub now: Option<Clock>,
}

/// What `connect` and `pick` answer where they fail: `Google` is the
/// sign-in's own reason, `Unavailable` a build without a Google client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectFailure {
    Google(GoogleSignInFailure),
    Unavailable,
}

impl ConnectFailure {
    /// the reason as the TypeScript spells it
    pub fn as_str(self) -> &'static str {
        match self {
            ConnectFailure::Google(reason) => reason.as_str(),
            ConnectFailure::Unavailable => "unavailable",
        }
    }
}

/// A listener of `onChange`: the same `Rc` (the same function) is one
/// registration, as the `Set` of the TypeScript holds a function once.
pub type ChangeListener = Rc<dyn Fn(&DriveConnectionState)>;

/// What `onChange` answers: the function that removes the listener. Every
/// handle of the same listener removes that one registration.
#[derive(Clone)]
pub struct ListenerHandle {
    listener: ChangeListener,
}

/// `a === b` of two listeners
fn same_listener(a: &ChangeListener, b: &ChangeListener) -> bool {
    std::ptr::addr_eq(Rc::as_ptr(a), Rc::as_ptr(b))
}

type Listener = ChangeListener;

#[derive(Default)]
struct ConnState {
    refresh_token: Option<String>,
    access_token: Option<String>,
    expires_at: f64,
    account: Option<DriveAccount>,
    persisted: Option<JsonValue>,
    expired: bool,
    loaded: bool,
    /// the refresh the concurrent callers share
    refreshing: Option<crate::packages::ai_provider::task::Wait<Option<String>>>,
    sign_in: Option<Signal>,
    /// `listeners`: a removed one leaves its place, as a deleted `Set` entry
    /// is skipped by an iteration in progress
    listeners: Vec<Option<Listener>>,
}

struct Core {
    options: DriveConnectionOptions,
    st: RefCell<ConnState>,
}

/// `vault.load().catch(() => null)`: the kept token. Any truthy value is a
/// token; what goes to Google is `String(token)`.
async fn vault_load(rt: &Rt) -> Option<String> {
    match rt.call("vault.load", JsonValue::Array(Vec::new())).await {
        Ok(value) if value.truthy() => Some(js_string(&value)),
        _ => None,
    }
}

/// `vault.save(token).catch(() => false)`: what the vault answered; `None`
/// is `undefined`, `Some(Null)` is `null`.
async fn vault_save(rt: &Rt, token: &str) -> Option<JsonValue> {
    match rt
        .call_exact(
            "vault.save",
            JsonValue::Array(vec![JsonValue::String(token.to_owned())]),
        )
        .await
    {
        Ok(kept) => kept,
        Err(_) => Some(JsonValue::Bool(false)),
    }
}

/// `vault.clear().catch(() => {})`
async fn vault_clear(rt: &Rt) {
    let _ = rt.call("vault.clear", JsonValue::Array(Vec::new())).await;
}

/// A promise started by calling an `async` function: it runs up to its first
/// wait now, as JavaScript runs it, and goes on beside the tasks after that.
fn start_now(rt: &Rt, future: impl Future<Output = ()> + 'static) {
    let mut future: Pin<Box<dyn Future<Output = ()>>> = Box::pin(future);
    let mut cx = Context::from_waker(Waker::noop());
    if future.as_mut().poll(&mut cx).is_pending() {
        rt.spawn_local(future);
    }
}

impl Core {
    /// `this.now()`
    fn now(&self, rt: &Rt) -> f64 {
        clock_now(rt, self.options.now.as_ref())
    }

    /// `state()`
    fn state(&self) -> DriveConnectionState {
        if self.options.client.is_none() {
            return DriveConnectionState::Unavailable;
        }
        let st = self.st.borrow();
        if st.refresh_token.is_none() {
            return DriveConnectionState::Disconnected {
                expired: st.expired,
            };
        }
        DriveConnectionState::Connected {
            account: st.account.clone(),
            persisted: st.persisted.clone(),
        }
    }

    /// `emit()`: every listener, in the order added, one that was added
    /// meanwhile included and one that was removed meanwhile left out.
    fn emit(&self) {
        let state = self.state();
        let mut at = 0;
        loop {
            let listener = {
                let st = self.st.borrow();
                match st.listeners.get(at) {
                    None => break,
                    Some(slot) => slot.clone(),
                }
            };
            at += 1;
            if let Some(listener) = listener {
                listener(&state);
            }
        }
    }

    /// `forget(expired)`
    fn forget(&self, expired: bool) {
        {
            let mut st = self.st.borrow_mut();
            st.refresh_token = None;
            st.access_token = None;
            st.expires_at = 0.0;
            st.account = None;
            st.persisted = Some(JsonValue::Bool(false));
            st.expired = expired;
        }
        self.emit();
    }
}

/// The refresh the concurrent callers share (the async function `accessTokenFor`
/// starts).
async fn refresh(
    core: &Rc<Core>,
    rt: &Rt,
    client: &GoogleClient,
    signal: Option<&Signal>,
) -> Option<String> {
    let refresh_token = core.st.borrow().refresh_token.clone()?;
    let result = refresh_google_token(
        rt,
        client,
        &refresh_token,
        core.options.fetch,
        signal,
        core.options.now.as_ref(),
    )
    .await;
    // a disconnect or a new sign-in while this ran wins
    if core.st.borrow().refresh_token.as_deref() != Some(refresh_token.as_str()) {
        return core.st.borrow().access_token.clone();
    }
    match result {
        Ok(refreshed) => {
            let mut st = core.st.borrow_mut();
            st.access_token = Some(refreshed.access_token.clone());
            st.expires_at = refreshed.expires_at;
            Some(refreshed.access_token)
        }
        Err(RefreshFailure::Revoked) => {
            core.forget(true);
            vault_clear(rt).await;
            None
        }
        Err(RefreshFailure::Network) => None,
    }
}

/// `accessTokenFor(signal)`: a valid access token, refreshing when needed;
/// `None` when not connected.
async fn access_token_for(core: Rc<Core>, rt: Rt, signal: Option<Signal>) -> Option<String> {
    let client = core.options.client.clone()?;
    core.st.borrow().refresh_token.as_ref()?;
    {
        let st = core.st.borrow();
        if let Some(token) = st.access_token.as_ref().filter(|t| !t.is_empty())
            && core.now(&rt) < st.expires_at
        {
            return Some(token.clone());
        }
    }
    // concurrent callers share one refresh
    let shared = core.st.borrow().refreshing.clone();
    let wait = match shared {
        Some(wait) => wait,
        None => {
            let (settle, wait) = rt.deferred::<Option<String>>();
            core.st.borrow_mut().refreshing = Some(wait.clone());
            let (core, rt) = (core.clone(), rt.clone());
            start_now(&rt.clone(), async move {
                let token = refresh(&core, &rt, &client, signal.as_ref()).await;
                // finally: the next caller starts a refresh of its own
                core.st.borrow_mut().refreshing = None;
                settle.settle(token);
            });
            wait
        }
    };
    wait.await
}

/// `DriveConnection`
#[derive(Clone)]
pub struct DriveConnection {
    core: Rc<Core>,
    /// `api`
    pub api: DriveApi,
}

impl DriveConnection {
    /// `new DriveConnection(options)`
    pub fn new(options: DriveConnectionOptions) -> DriveConnection {
        let api_options = (options.fetch, options.download);
        let core = Rc::new(Core {
            options,
            st: RefCell::new(ConnState::default()),
        });
        let source = core.clone();
        let token: AccessTokenSource = Rc::new(
            move |rt: Rt, signal: Option<Signal>| -> LocalBoxFuture<Option<String>> {
                Box::pin(access_token_for(source.clone(), rt, signal))
            },
        );
        DriveConnection {
            core,
            api: DriveApi::new(DriveApiOptions {
                token,
                fetch: api_options.0,
                download: api_options.1,
            }),
        }
    }

    /// `onChange(listener)`: the same listener again is the same
    /// registration; the handle is the function it returns.
    pub fn on_change(&self, listener: ChangeListener) -> ListenerHandle {
        let mut st = self.core.st.borrow_mut();
        if !st
            .listeners
            .iter()
            .flatten()
            .any(|known| same_listener(known, &listener))
        {
            st.listeners.push(Some(listener.clone()));
        }
        ListenerHandle { listener }
    }

    /// The function `onChange` returns (`Set.delete`): whether the listener
    /// was still registered.
    pub fn remove_listener(&self, handle: &ListenerHandle) -> bool {
        let mut st = self.core.st.borrow_mut();
        match st.listeners.iter_mut().find(|slot| {
            slot.as_ref()
                .is_some_and(|known| same_listener(known, &handle.listener))
        }) {
            Some(slot) => {
                *slot = None;
                true
            }
            None => false,
        }
    }

    /// `state()`
    pub fn state(&self) -> DriveConnectionState {
        self.core.state()
    }

    /// `connected()`
    pub fn connected(&self) -> bool {
        self.core.options.client.is_some() && self.core.st.borrow().refresh_token.is_some()
    }

    /// `load()`: read the kept token once; after that the connection lives in
    /// memory.
    pub async fn load(&self, rt: &Rt) -> DriveConnectionState {
        if self.core.st.borrow().loaded || self.core.options.client.is_none() {
            return self.state();
        }
        self.core.st.borrow_mut().loaded = true;
        let token = vault_load(rt).await;
        let adopted = {
            let mut st = self.core.st.borrow_mut();
            match token {
                Some(token) if st.refresh_token.is_none() => {
                    st.refresh_token = Some(token);
                    st.persisted = Some(JsonValue::Bool(true));
                    true
                }
                _ => false,
            }
        };
        if adopted {
            self.core.emit();
            let (connection, rt) = (self.clone(), rt.clone());
            start_now(&rt.clone(), async move {
                connection.fetch_account(&rt).await;
            });
        }
        self.state()
    }

    /// `fetchAccount()`: a rejection of the call is unhandled where it is
    /// not awaited.
    async fn fetch_account(&self, rt: &Rt) {
        let result = self.api.account(rt, None).await;
        if let Ok(account) = result
            && self.core.st.borrow().refresh_token.is_some()
        {
            self.core.st.borrow_mut().account = Some(account);
            self.core.emit();
        }
    }

    /// `connect(options)`: the browser sign-in. A second call while one is
    /// waiting replaces it.
    pub async fn connect(&self, rt: &Rt, pages: &SignInPages) -> Result<(), ConnectFailure> {
        self.sign_in_once(rt, pages, None).await.map(|_| ())
    }

    /// `pick(options, multiple)`: Google's file picker, through the same
    /// browser round trip as signing in (decision 0085). It connects when
    /// there is no connection yet, and gives the ids of the files the person
    /// chose, which the app may open from then on.
    pub async fn pick(
        &self,
        rt: &Rt,
        pages: &SignInPages,
        multiple: bool,
    ) -> Result<Vec<String>, ConnectFailure> {
        self.sign_in_once(rt, pages, Some(PickRequest { multiple }))
            .await
    }

    async fn sign_in_once(
        &self,
        rt: &Rt,
        pages: &SignInPages,
        pick: Option<PickRequest>,
    ) -> Result<Vec<String>, ConnectFailure> {
        let Some(client) = self.core.options.client.clone() else {
            return Err(ConnectFailure::Unavailable);
        };
        let previous = self.core.st.borrow().sign_in.clone();
        if let Some(previous) = previous {
            previous.abort(None);
        }
        let controller = rt.controller();
        self.core.st.borrow_mut().sign_in = Some(controller.clone());
        let result = sign_in_with_google(
            rt,
            &GoogleSignInOptions {
                client,
                pages: pages.clone(),
                signal: Some(controller.clone()),
                fetch: Some(self.core.options.fetch),
                timeout_ms: None,
                now: self.core.options.now.clone(),
                pick,
            },
        )
        .await;
        {
            let mut st = self.core.st.borrow_mut();
            if st
                .sign_in
                .as_ref()
                .is_some_and(|s| s.id() == controller.id())
            {
                st.sign_in = None;
            }
        }
        let picked = result.map_err(ConnectFailure::Google)?;
        let account = {
            let st = self.core.st.borrow();
            if st.refresh_token.is_some() {
                st.account.clone()
            } else {
                None
            }
        };
        self.adopt(rt, picked.tokens).await;
        // the same account picking again keeps its name on screen; a new sign-in reads it afresh
        if let Some(account) = &account {
            self.core.st.borrow_mut().account = Some(account.clone());
        }
        self.core.emit();
        if account.is_none() {
            self.fetch_account(rt).await;
        }
        Ok(picked.picked)
    }

    /// `adopt(tokens)`: keep the newest tokens. The previous refresh token is
    /// let go, not revoked: revoking can end the app's whole grant for the
    /// account, and with it the access to files picked before (decision 0085).
    async fn adopt(&self, rt: &Rt, tokens: GoogleTokens) {
        {
            let mut st = self.core.st.borrow_mut();
            st.refresh_token = Some(tokens.refresh_token.clone());
            st.access_token = Some(tokens.access_token.clone());
            st.expires_at = tokens.expires_at;
            st.account = None;
            st.expired = false;
        }
        let persisted = vault_save(rt, &tokens.refresh_token).await;
        let kept = persisted.as_ref().is_some_and(JsonValue::truthy);
        self.core.st.borrow_mut().persisted = persisted;
        if !kept {
            vault_clear(rt).await;
        }
    }

    /// `cancelConnect()`
    pub fn cancel_connect(&self) {
        let current = self.core.st.borrow_mut().sign_in.take();
        if let Some(current) = current {
            current.abort(None);
        }
    }

    /// `disconnect()`: forget the connection here and ask Google to drop the
    /// grant.
    pub async fn disconnect(&self, rt: &Rt) {
        let token = self.core.st.borrow().refresh_token.clone();
        self.core.forget(false);
        vault_clear(rt).await;
        if let Some(token) = token {
            revoke_google_token(rt, &token, self.core.options.fetch).await;
        }
    }
}
