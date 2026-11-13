//! `packages/ai-provider/src/chatgpt/connection.ts`: the ChatGPT connection of
//! this process (decision 0081): the sign-in, the tokens it gave, keeping them
//! fresh, and the sign-out. One instance lives in the main process; the
//! subscription IPC creates it over the app's data folder and registers it in
//! [`ChatGptConnectionModuleState`], and the bridge and the status check read
//! it from there.
//!
//! Refreshes are serialized: two runs that find the access token old share one
//! refresh, so a rotated refresh token is never sent twice.
//!
//! `openBrowser` of the sign-in is [`super::chatgpt_oauth::OPEN_BROWSER_CALL`]
//! of [`Rt::call`].

use std::cell::RefCell;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use jscompat::JsonValue;

use super::chatgpt_credentials::{ChatGptConnectionRecord, ChatGptConnectionStore, ChatGptSession};
use super::chatgpt_oauth::{
    CHATGPT_CALLBACK_PATH, CHATGPT_LEGACY_CALLBACK_PATH, CHATGPT_PLAN_SCOPE,
    ChatGptAuthorizeParams, ChatGptCallback, ChatGptCallbackOptions, ChatGptCodeRequest,
    ChatGptExchange, ChatGptExpectedToken, ChatGptPages, ChatGptRefreshResult, ChatGptSignInFailed,
    ChatGptSignInFailure, ChatGptTokenSet, FetchLike, JwtSignatureVerifier, chatgpt_attempt_values,
    chatgpt_authorize_url, chatgpt_pkce_pair, exchange_chatgpt_code, fetch_chatgpt_signing_keys,
    refresh_chatgpt_tokens, revoke_chatgpt_session, verify_chatgpt_id_token,
    wait_for_chatgpt_callback,
};
use super::fetch::AiFetch;
use super::jsval::{Obj, object, text};
use super::run_error::ai_run_error;
use super::task::{Id, JsError, Rt, Signal, Wait};

/// an access token this close to its expiry is refreshed before it is used
pub const CHATGPT_REFRESH_MARGIN_MS: f64 = 60_000.0;

/// `ChatGptConnectionDeps`: what the connection reads from outside. `fetch`
/// is `deps.fetch` ([`KeyedFetchBase::Ai`](super::fetch::KeyedFetchBase) when
/// the caller gave none), `fx` the state `aiFetch` reads, `verifier` the seam
/// of the ID token's signature check.
pub struct ChatGptConnectionDeps {
    pub store: Rc<dyn ChatGptConnectionStore>,
    /// the name OpenAI shows for this app on a first registration
    pub agent_name: String,
    pub fx: AiFetch,
    pub fetch: FetchLike,
    pub now: Option<Rc<dyn Fn() -> f64>>,
    pub verifier: Rc<dyn JwtSignatureVerifier>,
}

/// `ChatGptSignInOptions`. `openBrowser` is [`super::chatgpt_oauth::OPEN_BROWSER_CALL`].
#[derive(Clone)]
pub struct ChatGptSignInOptions {
    pub pages: ChatGptPages,
    pub signal: Option<Signal>,
    pub timeout_ms: Option<f64>,
}

/// `ChatGptSignInResult`
#[derive(Debug, Clone, PartialEq)]
pub enum ChatGptSignInResult {
    Ok,
    Failed(ChatGptSignInFailed),
}

impl ChatGptSignInResult {
    pub fn to_json(&self) -> JsonValue {
        match self {
            ChatGptSignInResult::Ok => object(vec![("ok", JsonValue::Bool(true))]),
            ChatGptSignInResult::Failed(failed) => failed.to_json(),
        }
    }
}

/// `ChatGptConnectionState`
#[derive(Debug, Clone, PartialEq)]
pub struct ChatGptConnectionState {
    pub signed_in: bool,
    /// the signed-in account's e-mail, for display; known after a sign-in or a refresh this run
    pub account: Option<String>,
}

impl ChatGptConnectionState {
    pub fn to_json(&self) -> JsonValue {
        let mut out = Obj::new();
        out.set("signedIn", JsonValue::Bool(self.signed_in));
        if let Some(account) = &self.account {
            out.set("account", text(account.clone()));
        }
        JsonValue::Object(out)
    }
}

/// `signedOutError()`
fn signed_out_error() -> JsError {
    ai_run_error(
        "signed-out",
        "ChatGPT is not connected. Sign in again in the AI settings.",
        Some("chatgpt"),
        None,
    )
}

/// `sessionOf(tokens)`
fn session_of(tokens: &ChatGptTokenSet) -> ChatGptSession {
    ChatGptSession {
        access_token: tokens.access_token.clone(),
        refresh_token: tokens.refresh_token.clone(),
        expires_at: tokens.expires_at,
        scopes: tokens.scopes.clone(),
        id_token: tokens.id_token.clone().filter(|t| !t.is_empty()),
    }
}

/// `forgetSession(record)`
fn forget_session(record: &ChatGptConnectionRecord) -> ChatGptConnectionRecord {
    ChatGptConnectionRecord {
        session: None,
        ..record.clone()
    }
}

/// the string of an optional string when it is truthy
fn present(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}

/// `void promise()`: a call of an async function runs to its first `await`
/// at once, and the rest goes on beside the tasks.
fn spawn_eager(rt: &Rt, future: impl Future<Output = ()> + 'static) {
    let mut future: Pin<Box<dyn Future<Output = ()>>> = Box::pin(future);
    let mut cx = Context::from_waker(Waker::noop());
    if future.as_mut().poll(&mut cx) == Poll::Pending {
        rt.spawn_local(future);
    }
}

struct Local {
    listeners: Vec<(Id, Rc<dyn Fn()>)>,
    next_listener: Id,
    account: Option<String>,
    refreshing: Option<Wait<Result<String, JsError>>>,
    /// the tail of the writes of the record, one at a time
    queue: Option<Wait<()>>,
}

struct Shared {
    deps: ChatGptConnectionDeps,
    local: RefCell<Local>,
}

/// `ChatGptConnection`, as `createChatGptConnection(deps)` makes it. Cloning
/// shares the one connection.
#[derive(Clone)]
pub struct ChatGptConnection(Rc<Shared>);

impl ChatGptConnection {
    /// `createChatGptConnection(deps)`
    pub fn new(deps: ChatGptConnectionDeps) -> ChatGptConnection {
        ChatGptConnection(Rc::new(Shared {
            deps,
            local: RefCell::new(Local {
                listeners: Vec::new(),
                next_listener: 0,
                account: None,
                refreshing: None,
                queue: None,
            }),
        }))
    }

    fn deps(&self) -> &ChatGptConnectionDeps {
        &self.0.deps
    }

    /// `a === b` of two handles of the connection
    pub fn is_same(&self, other: &ChatGptConnection) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }

    fn now(&self, rt: &Rt) -> f64 {
        match &self.deps().now {
            Some(now) => now(),
            None => rt.now(),
        }
    }

    /// the `now` a callee takes: `None` is `Date.now`
    fn now_fn(&self) -> Option<&dyn Fn() -> f64> {
        self.deps().now.as_deref()
    }

    /// `serial(task)`: one write of the record at a time
    async fn serial<T>(&self, rt: &Rt, task: impl Future<Output = T>) -> T {
        let (settle, done) = rt.deferred::<()>();
        let previous = self.0.local.borrow_mut().queue.replace(done);
        if let Some(previous) = previous {
            previous.await;
        }
        let out = task.await;
        settle.settle(());
        out
    }

    /// `announce()`: one listener must not stop the others
    fn announce(&self) {
        let listeners: Vec<Rc<dyn Fn()>> = self
            .0
            .local
            .borrow()
            .listeners
            .iter()
            .map(|(_, l)| l.clone())
            .collect();
        for listener in listeners {
            listener();
        }
    }

    fn set_account(&self, account: Option<String>) {
        self.0.local.borrow_mut().account = account;
    }

    /// `learnAccount(idToken, clientId)`: read the e-mail off a new ID token,
    /// when it checks out; never stored
    async fn learn_account(&self, rt: &Rt, id_token: Option<String>, client_id: String) {
        let Some(id_token) = id_token.filter(|t| !t.is_empty()) else {
            return;
        };
        let deps = self.deps();
        let attempt: Result<(), JsError> = async {
            let keys = fetch_chatgpt_signing_keys(rt, &deps.fx, &deps.fetch, None).await?;
            let identity = verify_chatgpt_id_token(
                &id_token,
                &ChatGptExpectedToken {
                    client_id,
                    nonce: None,
                },
                &keys,
                (self.now(rt) / 1000.0).floor(),
                deps.verifier.as_ref(),
            );
            if let Some(email) = identity.and_then(|i| i.email).filter(|e| !e.is_empty()) {
                self.set_account(Some(email));
            }
            Ok(())
        }
        .await;
        // the account stays as it was: it is for display only
        let _ = attempt;
    }

    /// the body of the shared refresh
    async fn refresh_body(&self, rt: &Rt) -> Result<String, JsError> {
        let deps = self.deps();
        let record = deps.store.read(rt).await?;
        let (Some(session), Some(client_id)) = (record.session.clone(), present(&record.client_id))
        else {
            return Err(signed_out_error());
        };
        // another run refreshed while this one waited its turn
        if session.expires_at - self.now(rt) > CHATGPT_REFRESH_MARGIN_MS {
            return Ok(session.access_token);
        }
        let result = refresh_chatgpt_tokens(
            rt,
            &deps.fx,
            client_id,
            &session.refresh_token,
            &deps.fetch,
            None,
            self.now_fn(),
        )
        .await;
        let tokens = match result {
            ChatGptRefreshResult::Ok(tokens) => tokens,
            ChatGptRefreshResult::SignedOut => {
                deps.store.write(rt, forget_session(&record)).await?;
                self.set_account(None);
                self.announce();
                return Err(signed_out_error());
            }
            ChatGptRefreshResult::Failed => {
                // a passing failure: a token that has not run out yet still serves
                if session.expires_at > self.now(rt) {
                    return Ok(session.access_token);
                }
                return Err(JsError::error(
                    "ChatGPT could not be reached to renew the sign-in (network)",
                ));
            }
        };
        let kept = session.id_token.clone();
        let mut next = session_of(&tokens);
        if next.id_token.is_none() && kept.is_some() {
            next.id_token = kept;
        }
        deps.store
            .write(
                rt,
                ChatGptConnectionRecord {
                    session: Some(next.clone()),
                    ..record.clone()
                },
            )
            .await?;
        let this = self.clone();
        let rt2 = rt.clone();
        let id_token = tokens.id_token.clone();
        let client_id = client_id.to_owned();
        spawn_eager(rt, async move {
            this.learn_account(&rt2, id_token, client_id).await;
        });
        Ok(next.access_token)
    }

    /// `refresh()`: the shared promise of the refresh in flight
    fn refresh(&self, rt: &Rt) -> Wait<Result<String, JsError>> {
        let running = self.0.local.borrow().refreshing.clone();
        if let Some(running) = running {
            return running;
        }
        let this = self.clone();
        let rt2 = rt.clone();
        let wait = rt.share(async move {
            let result = this.serial(&rt2, this.refresh_body(&rt2)).await;
            this.0.local.borrow_mut().refreshing = None;
            result
        });
        self.0.local.borrow_mut().refreshing = Some(wait.clone());
        wait
    }

    /// `state()`: whether a session is stored; reads nothing off the network
    pub async fn state(&self, rt: &Rt) -> Result<ChatGptConnectionState, JsError> {
        let record = self.deps().store.read(rt).await?;
        let account = self
            .0
            .local
            .borrow()
            .account
            .clone()
            .filter(|a| !a.is_empty());
        Ok(if record.session.is_some() {
            ChatGptConnectionState {
                signed_in: true,
                account,
            }
        } else {
            ChatGptConnectionState {
                signed_in: false,
                account: None,
            }
        })
    }

    /// `signIn(options)`
    pub async fn sign_in(
        &self,
        rt: &Rt,
        options: &ChatGptSignInOptions,
    ) -> Result<ChatGptSignInResult, JsError> {
        let deps = self.deps();
        let record = deps.store.read(rt).await?;
        // an issued client id signs in again on the path it was issued for (one stored
        // before the path was kept was issued for the old one); a new registration takes today's
        let callback_path = if present(&record.client_id).is_some() {
            record
                .callback_path
                .clone()
                .unwrap_or_else(|| CHATGPT_LEGACY_CALLBACK_PATH.to_owned())
        } else {
            CHATGPT_CALLBACK_PATH.to_owned()
        };
        let (verifier, challenge) = chatgpt_pkce_pair(rt);
        let (state, nonce) = chatgpt_attempt_values(rt);
        let authorize_url: Rc<dyn Fn(f64) -> String> = {
            let challenge = challenge.clone();
            let state = state.clone();
            let nonce = nonce.clone();
            let host_id = record.host_id.clone();
            let client_id = record.client_id.clone();
            let callback_path = callback_path.clone();
            let agent_name = deps.agent_name.clone();
            Rc::new(move |port| {
                chatgpt_authorize_url(&ChatGptAuthorizeParams {
                    port,
                    challenge: challenge.clone(),
                    state: state.clone(),
                    nonce: nonce.clone(),
                    host_id: host_id.clone(),
                    client_id: client_id.clone(),
                    callback_path: Some(callback_path.clone()),
                    agent_name: agent_name.clone(),
                })
            })
        };
        let callback = wait_for_chatgpt_callback(
            rt,
            &ChatGptCallbackOptions {
                authorize_url,
                state,
                callback_path: Some(callback_path.clone()),
                client_id: record.client_id.clone(),
                pages: options.pages.clone(),
                signal: options.signal.clone(),
                timeout_ms: options.timeout_ms,
            },
        )
        .await;
        let (code, callback_client_id, port) = match callback {
            ChatGptCallback::Ok {
                code,
                client_id,
                port,
            } => (code, client_id, port),
            ChatGptCallback::Failed(failed) => return Ok(ChatGptSignInResult::Failed(failed)),
        };
        let exchanged = exchange_chatgpt_code(
            rt,
            &deps.fx,
            &ChatGptCodeRequest {
                code,
                client_id: callback_client_id.clone(),
                verifier,
                port,
                callback_path: Some(callback_path.clone()),
            },
            &deps.fetch,
            options.signal.as_ref(),
            self.now_fn(),
        )
        .await;
        let tokens = match exchanged {
            ChatGptExchange::Ok(tokens) => tokens,
            ChatGptExchange::Failed(failed) => return Ok(ChatGptSignInResult::Failed(failed)),
        };
        let failed = |reason, step| {
            Ok(ChatGptSignInResult::Failed(ChatGptSignInFailed {
                reason,
                step: Some(step),
                http_status: None,
                oauth_error: None,
            }))
        };
        let Some(id_token) = tokens.id_token.clone().filter(|t| !t.is_empty()) else {
            return failed(ChatGptSignInFailure::Denied, "id-token-missing");
        };
        let keys =
            fetch_chatgpt_signing_keys(rt, &deps.fx, &deps.fetch, options.signal.as_ref()).await;
        let identity = match keys {
            Ok(keys) => verify_chatgpt_id_token(
                &id_token,
                &ChatGptExpectedToken {
                    client_id: callback_client_id.clone(),
                    nonce: Some(nonce),
                },
                &keys,
                (self.now(rt) / 1000.0).floor(),
                deps.verifier.as_ref(),
            ),
            Err(_) => {
                if options.signal.as_ref().is_some_and(Signal::aborted) {
                    return Ok(ChatGptSignInResult::Failed(ChatGptSignInFailed {
                        reason: ChatGptSignInFailure::Cancelled,
                        step: None,
                        http_status: None,
                        oauth_error: None,
                    }));
                }
                return failed(ChatGptSignInFailure::Network, "signing-keys");
            }
        };
        let Some(identity) = identity else {
            return failed(ChatGptSignInFailure::Denied, "id-token-invalid");
        };
        // signed in, but the use of the ChatGPT plan was not allowed: nothing to run on.
        // OpenAI documents `scope` as always in the answer and asks for the plan scope
        // in it; a valid ID token alone does not allow plan use, so a missing field is
        // no grant either. The step tells the two apart for whoever helps the user.
        if !tokens.scopes.iter().any(|s| s == CHATGPT_PLAN_SCOPE) {
            return failed(
                ChatGptSignInFailure::NoPlan,
                if tokens.scope_missing {
                    "scope-missing"
                } else {
                    "plan-scope-missing"
                },
            );
        }
        self.serial(rt, async {
            let current = deps.store.read(rt).await?;
            deps.store
                .write(
                    rt,
                    ChatGptConnectionRecord {
                        host_id: current.host_id,
                        client_id: Some(callback_client_id.clone()),
                        callback_path: Some(callback_path.clone()),
                        subject: Some(identity.subject.clone()),
                        session: Some(session_of(&tokens)),
                    },
                )
                .await
        })
        .await?;
        self.set_account(identity.email.clone());
        self.announce();
        Ok(ChatGptSignInResult::Ok)
    }

    /// `signOut()`: revoke the session at OpenAI (as far as it can be reached)
    /// and forget it here
    pub async fn sign_out(&self, rt: &Rt) -> Result<(), JsError> {
        let deps = self.deps();
        self.serial(rt, async {
            let record = deps.store.read(rt).await?;
            if let (Some(session), Some(client_id)) = (&record.session, present(&record.client_id))
            {
                // the tokens here are forgotten whether or not OpenAI could be told
                revoke_chatgpt_session(
                    rt,
                    &deps.fx,
                    client_id,
                    &session.refresh_token,
                    &deps.fetch,
                    None,
                )
                .await;
            }
            // a sign-out ends this account's registration here; the host stays the same
            deps.store
                .write(rt, ChatGptConnectionRecord::fresh(record.host_id))
                .await
        })
        .await?;
        self.set_account(None);
        self.announce();
        Ok(())
    }

    /// `accessToken(signal)`: an access token fit for a request, refreshed
    /// first when it is old. Throws `signed-out` when there is no session or
    /// it has ended.
    pub async fn access_token(&self, rt: &Rt, signal: Option<&Signal>) -> Result<String, JsError> {
        if signal.is_some_and(Signal::aborted) {
            return Err(JsError::error("cancelled"));
        }
        let record = self.deps().store.read(rt).await?;
        let (Some(session), Some(_)) = (&record.session, present(&record.client_id)) else {
            return Err(signed_out_error());
        };
        if session.expires_at - self.now(rt) > CHATGPT_REFRESH_MARGIN_MS {
            return Ok(session.access_token.clone());
        }
        self.refresh(rt).await
    }

    /// `dropSession()`: OpenAI refused the token (the user disconnected the
    /// app in ChatGPT's settings): the session is dropped and listeners are told.
    pub async fn drop_session(&self, rt: &Rt) -> Result<(), JsError> {
        let deps = self.deps();
        let had = self
            .serial(rt, async {
                let record = deps.store.read(rt).await?;
                if record.session.is_none() {
                    return Ok(false);
                }
                deps.store.write(rt, forget_session(&record)).await?;
                Ok::<bool, JsError>(true)
            })
            .await?;
        if !had {
            return Ok(());
        }
        self.set_account(None);
        self.announce();
        Ok(())
    }

    /// `onChange(listener)`: called whenever the session comes or goes;
    /// [`ChatGptConnection::remove_listener`] is the function it answers
    pub fn on_change(&self, listener: Rc<dyn Fn()>) -> Id {
        let mut local = self.0.local.borrow_mut();
        local.next_listener += 1;
        let id = local.next_listener;
        local.listeners.push((id, listener));
        id
    }

    /// the function `onChange` answers: `() => listeners.delete(listener)`
    pub fn remove_listener(&self, id: Id) {
        self.0
            .local
            .borrow_mut()
            .listeners
            .retain(|(l, _)| *l != id);
    }
}

/// The module variable `current` of connection.ts, which the caller owns.
#[derive(Default)]
pub struct ChatGptConnectionModuleState {
    current: Option<ChatGptConnection>,
}

impl ChatGptConnectionModuleState {
    /// `setChatGptConnection(connection)`: register the process's connection
    /// (the main process does, once it knows its data folder)
    pub fn set_chatgpt_connection(&mut self, connection: Option<ChatGptConnection>) {
        self.current = connection;
    }

    /// `chatGptConnection()`: the process's connection; `None` where none was
    /// registered (the terminal command, tests)
    pub fn chatgpt_connection(&self) -> Option<ChatGptConnection> {
        self.current.clone()
    }
}
