//! `apps/shell/src/main/mcp-client/oauth.ts`: the browser sign-in to a remote
//! MCP server (user MCP spec 4.8, 4.9), following the MCP authorization
//! rules: discovery from the server's protected resource metadata, then the
//! authorization server's metadata; dynamic client registration when offered,
//! else the client the person entered under "advanced"; PKCE (S256), a fresh
//! `state`, a return to 127.0.0.1 and a ten-minute limit.
//!
//! Requests here go to the addresses discovery names. Each must be https, or
//! plain http to this PC or a private address, judged by what the name
//! resolves to ([`AuthFetch`]). No redirect is followed outside the address
//! asked. Token text never reaches a log or an error message.
//!
//! # What is plain and what is driven
//!
//! Every network call is a plain host call ([`NetHost`]): discovery,
//! registration, the token exchange, a refresh and a revocation each run to
//! their end inside one call, as the TypeScript awaits them one after the
//! other. The 20 s limit of [`AuthFetch`] is the `limit_ms` the host gets
//! with the request ([`NetHost::fetch_limited`]): the host fails the request
//! with `TimeoutError` when it passes, as `AbortSignal.timeout` does.
//!
//! [`SignIn`] is the one state machine here. The browser sign-in waits for
//! the person, so [`SignIn::start`] runs up to opening the browser and then
//! waits for what the loopback server and the clock tell it:
//!
//! 1. [`SignIn::start`] with a [`SignInContext`]. It answers a finished
//!    sign-in ([`SignIn::take_result`]) when discovery, the checks or the
//!    registration ended it, else it is waiting.
//! 2. While waiting, feed it [`SignIn::on_request`] (a request of the loopback
//!    server, by port), [`SignIn::on_timeout`] (the receiver's timer) and
//!    [`SignIn::on_abort`] (the attempt's `AbortSignal` aborted). The token
//!    exchange runs inside the call that brings the outcome, and the receiver
//!    is closed on every way out.
//!
//! An abort that arrives while a plain call is running is not seen by that
//! call (the TypeScript's checks of `signal.aborted` happen at the same
//! places, so an abort between two awaits that the script cannot place
//! between two host calls is the only thing a script cannot reproduce).

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsonValue, base64, json_parse, json_stringify, number_to_string};
use url::Url;

use super::address::{
    AddressCheck, AddressProblem, HostResolver, ResolveFailed, check_resolved_server_address,
};
use super::oauth_loopback::{
    LoopbackFailure, LoopbackHost, LoopbackOutcome, LoopbackPages, LoopbackReceiver,
};
use super::store::{McpOAuthConfig, McpServersStore};
use crate::packages::ai_provider::jsval::{as_str, object, prop, text};
use crate::packages::mcp_sdk::auth::{
    self, AuthError, AuthHost, ExchangeAuthorizationOptions, RefreshAuthorizationOptions,
    StartAuthorizationOptions,
};
use crate::packages::mcp_sdk::client::net::{
    FetchError, FetchHost, FetchInit, FetchResponse, Headers, Redirect, cancel_body,
};

/// `MCP_SIGN_IN_TIMEOUT_MS`: how long the browser sign-in may take before the waiting server gives up
pub const MCP_SIGN_IN_TIMEOUT_MS: f64 = 10.0 * 60.0 * 1000.0;

/// `EXPIRY_MARGIN_MS`: a token is refreshed this long before the server says it ends
const EXPIRY_MARGIN_MS: f64 = 60.0 * 1000.0;

/// `AUTH_REQUEST_TIMEOUT_MS`: each request to an authorization server
pub const AUTH_REQUEST_TIMEOUT_MS: f64 = 20_000.0;

/// The network the shell injects (`McpFetch`, Electron's `net.fetch`), the
/// name resolver, the clock and the randomness of one connection, as plain
/// calls. [`FetchHost::fetch`] is `fetch(url, init)` with no time limit.
pub trait NetHost: AuthHost {
    /// `fetch(url, init)` that fails with `TimeoutError` once `limit_ms` has
    /// passed (`AbortSignal.timeout(limit_ms)` in the init's `signal`), or
    /// with no limit when `None`
    fn fetch_limited(
        &mut self,
        url: &str,
        init: &FetchInit,
        limit_ms: Option<f64>,
    ) -> Result<FetchResponse, FetchError>;
    /// `HostResolver.resolve(host)`: every address the name resolves to
    fn resolve_host(&mut self, host: &str) -> Result<Vec<String>, ResolveFailed>;
    /// `now()` (`Date.now`)
    fn now(&mut self) -> f64;
}

/// What [`SignIn`] needs: the network and the loopback server. The browser
/// is the `open_external` of the [`SignInContext`].
pub trait SignInHost: NetHost + LoopbackHost {}

/// `McpOAuthAccess`: where a server's OAuth values live, the store in the
/// app. `write_tokens("")` forgets the sign-in.
pub trait McpOAuthAccess {
    /// `read()`
    fn read(&mut self) -> Option<McpOAuthConfig>;
    /// `writeTokens(tokens)`: the message of the error when it fails
    fn write_tokens(&mut self, tokens: &str) -> Result<(), String>;
}

/// `storeOAuthAccess(store, serverId)`'s value
pub struct StoreOAuthAccess<'a, 'h> {
    store: &'a mut McpServersStore<'h>,
    server_id: String,
}

/// `storeOAuthAccess(store, serverId)`: the store's OAuth values of one
/// server; writing adds the OAuth block when it is missing
pub fn store_oauth_access<'a, 'h>(
    store: &'a mut McpServersStore<'h>,
    server_id: &str,
) -> StoreOAuthAccess<'a, 'h> {
    StoreOAuthAccess {
        store,
        server_id: server_id.to_owned(),
    }
}

/// the update `storeOAuthAccess(...).writeTokens(tokens)` makes
fn write_oauth_tokens(
    store: &mut McpServersStore<'_>,
    server_id: &str,
    tokens: &str,
) -> Result<(), String> {
    store
        .update(&mut |file| {
            let server = file.servers.iter_mut().find(|s| s.id == server_id)?;
            if server.oauth.is_none() && tokens.is_empty() {
                return None;
            }
            match &mut server.oauth {
                Some(oauth) => oauth.tokens = tokens.to_owned(),
                None => {
                    server.oauth = Some(McpOAuthConfig {
                        client_id: String::new(),
                        client_secret: String::new(),
                        tokens: tokens.to_owned(),
                    });
                }
            }
            None
        })
        .map(|_| ())
        .map_err(|error| error.message)
}

impl McpOAuthAccess for StoreOAuthAccess<'_, '_> {
    fn read(&mut self) -> Option<McpOAuthConfig> {
        self.store
            .server(&self.server_id)
            .and_then(|server| server.oauth)
    }

    fn write_tokens(&mut self, tokens: &str) -> Result<(), String> {
        write_oauth_tokens(self.store, &self.server_id, tokens)
    }
}

/// [`StoreOAuthAccess`] over the store the hub and its connections share
pub struct SharedStoreOAuthAccess<'h> {
    store: Rc<RefCell<McpServersStore<'h>>>,
    server_id: String,
}

/// `storeOAuthAccess(store, serverId)` over a shared store
pub fn shared_store_oauth_access<'h>(
    store: &Rc<RefCell<McpServersStore<'h>>>,
    server_id: &str,
) -> SharedStoreOAuthAccess<'h> {
    SharedStoreOAuthAccess {
        store: Rc::clone(store),
        server_id: server_id.to_owned(),
    }
}

impl McpOAuthAccess for SharedStoreOAuthAccess<'_> {
    fn read(&mut self) -> Option<McpOAuthConfig> {
        self.store
            .borrow()
            .server(&self.server_id)
            .and_then(|server| server.oauth)
    }

    fn write_tokens(&mut self, tokens: &str) -> Result<(), String> {
        write_oauth_tokens(&mut self.store.borrow_mut(), &self.server_id, tokens)
    }
}

// ---- what is kept between runs ---------------------------------------------

/// `StoredOAuth`: the sign-in as kept in `oauth.tokens` (sealed on disk): the
/// tokens and what is needed to refresh and revoke them without discovering
/// again. `v` is always 1.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredOAuth {
    pub tokens: JsonValue,
    /// epoch ms after which the access token is not used; `None` when the server gave no lifetime
    pub expires_at: Option<f64>,
    pub authorization_server_url: String,
    pub metadata: JsonValue,
    pub resource: Option<String>,
    /// the client registered for this sign-in; `None` when the person's entered client was used
    pub registered_client: Option<JsonValue>,
}

fn is_record(value: Option<&JsonValue>) -> bool {
    matches!(value, Some(JsonValue::Object(_)))
}

/// `parseStoredOAuth(text)`
pub fn parse_stored_oauth(source: &str) -> Option<StoredOAuth> {
    if source.is_empty() {
        return None;
    }
    let raw = json_parse(source).ok()?;
    if !is_record(Some(&raw)) {
        return None;
    }
    let tokens = prop(&raw, "tokens");
    let metadata = prop(&raw, "metadata");
    if !matches!(prop(&raw, "v"), Some(JsonValue::Number(v)) if *v == 1.0)
        || !is_record(tokens)
        || as_str(tokens.and_then(|t| prop(t, "access_token"))).is_none()
        || as_str(prop(&raw, "authorizationServerUrl")).is_none()
        || !is_record(metadata)
        || as_str(metadata.and_then(|m| prop(m, "token_endpoint"))).is_none()
    {
        return None;
    }
    let client = prop(&raw, "registeredClient");
    let has_client =
        is_record(client) && as_str(client.and_then(|c| prop(c, "client_id"))).is_some();
    Some(StoredOAuth {
        tokens: tokens?.clone(),
        expires_at: match prop(&raw, "expiresAt") {
            Some(JsonValue::Number(at)) => Some(*at),
            _ => None,
        },
        authorization_server_url: as_str(prop(&raw, "authorizationServerUrl"))?.to_owned(),
        metadata: metadata?.clone(),
        resource: as_str(prop(&raw, "resource")).map(str::to_owned),
        registered_client: if has_client { client.cloned() } else { None },
    })
}

/// `serializeStoredOAuth(stored)`
pub fn serialize_stored_oauth(stored: &StoredOAuth) -> String {
    json_stringify(&object(vec![
        ("v", JsonValue::Number(1.0)),
        ("tokens", stored.tokens.clone()),
        (
            "expiresAt",
            stored.expires_at.map_or(JsonValue::Null, JsonValue::Number),
        ),
        (
            "authorizationServerUrl",
            text(stored.authorization_server_url.as_str()),
        ),
        ("metadata", stored.metadata.clone()),
        (
            "resource",
            stored.resource.as_deref().map_or(JsonValue::Null, text),
        ),
        (
            "registeredClient",
            stored.registered_client.clone().unwrap_or(JsonValue::Null),
        ),
    ]))
}

/// `accessTokenExpired(stored, now)`: whether the access token should be refreshed before it is sent
pub fn access_token_expired(stored: &StoredOAuth, now: f64) -> bool {
    stored
        .expires_at
        .is_some_and(|at| now >= at - EXPIRY_MARGIN_MS)
}

/// `expiresAtOf(tokens, now)`
fn expires_at_of(tokens: &JsonValue, now: f64) -> Option<f64> {
    match prop(tokens, "expires_in") {
        Some(JsonValue::Number(seconds)) if seconds.is_finite() => Some(now + seconds * 1000.0),
        _ => None,
    }
}

/// `clientOf(stored, config)`: the client information to present
fn client_of(registered: Option<&JsonValue>, config: Option<&McpOAuthConfig>) -> Option<JsonValue> {
    if let Some(client) = registered {
        return Some(client.clone());
    }
    let config = config.filter(|c| !c.client_id.is_empty())?;
    Some(if config.client_secret.is_empty() {
        object(vec![("client_id", text(config.client_id.as_str()))])
    } else {
        object(vec![
            ("client_id", text(config.client_id.as_str())),
            ("client_secret", text(config.client_secret.as_str())),
        ])
    })
}

/// `String(value)` of a JSON value
fn js_string(value: &JsonValue) -> String {
    match value {
        JsonValue::String(s) => s.clone(),
        JsonValue::Number(n) => number_to_string(*n),
        JsonValue::Bool(b) => b.to_string(),
        JsonValue::Null => "null".to_owned(),
        JsonValue::Array(items) => items
            .iter()
            .map(|item| match item {
                JsonValue::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        JsonValue::Object(_) => "[object Object]".to_owned(),
    }
}

// ---- requests to authorization servers --------------------------------------

/// `AuthAddressError`: an authorization-server address that is neither https
/// nor a private plain-http address
pub const AUTH_ADDRESS_ERROR: &str = "AuthAddressError";

fn auth_address_error() -> FetchError {
    FetchError::other(AUTH_ADDRESS_ERROR, "insecure-address")
}

/// `checkResolvedServerAddress(url, resolve)` over the host's resolver
pub fn check_address(host: &mut dyn NetHost, url: &str) -> AddressCheck {
    struct Via<'a>(RefCell<&'a mut dyn NetHost>);
    impl HostResolver for Via<'_> {
        fn resolve(&self, host: &str) -> Result<Vec<String>, ResolveFailed> {
            self.0.borrow_mut().resolve_host(host)
        }
    }
    check_resolved_server_address(url, &Via(RefCell::new(host)))
}

/// whether `check` says the address may not be reached because it does not resolve
pub fn is_unresolved(check: AddressCheck) -> bool {
    matches!(check, AddressCheck::Refused(AddressProblem::Unresolved))
}

/// `authFetch(base, resolve)`: the fetch for sign-in, refresh and revoke.
/// Each address is checked as a server address would be (4.3), redirects are
/// not followed, and every request has a time limit.
pub struct AuthFetch<'a> {
    host: &'a mut dyn NetHost,
}

impl<'a> AuthFetch<'a> {
    pub fn new(host: &'a mut dyn NetHost) -> AuthFetch<'a> {
        AuthFetch { host }
    }
}

impl FetchHost for AuthFetch<'_> {
    fn fetch(&mut self, url: &str, init: &FetchInit) -> Result<FetchResponse, FetchError> {
        let url = Url::parse(url).map_err(|_| FetchError::type_error("Invalid URL"))?;
        if !matches!(
            check_address(&mut *self.host, url.as_str()),
            AddressCheck::Allowed { .. }
        ) {
            return Err(auth_address_error());
        }
        let mut next = init.clone();
        next.redirect = Some(Redirect::Manual);
        self.host
            .fetch_limited(url.as_str(), &next, Some(AUTH_REQUEST_TIMEOUT_MS))
    }

    fn read_body(&mut self, stream: u64) -> Result<Vec<u8>, FetchError> {
        self.host.read_body(stream)
    }

    fn cancel_body(&mut self, stream: u64) {
        self.host.cancel_body(stream);
    }

    fn abort_body(&mut self, stream: u64) {
        self.host.abort_body(stream);
    }
}

impl AuthHost for AuthFetch<'_> {
    fn random_bytes(&mut self, len: usize) -> Vec<u8> {
        self.host.random_bytes(len)
    }
}

/// A fetch and the clock `refreshStoredOAuth(stored, config, fetchFn, now)` takes
pub trait RefreshNet: FetchHost {
    /// `now()`
    fn now(&mut self) -> f64;
}

impl RefreshNet for AuthFetch<'_> {
    fn now(&mut self) -> f64 {
        self.host.now()
    }
}

// ---- signing in ------------------------------------------------------------

/// `McpSignInFailure`: cancelled: stopped, or replaced by a newer attempt;
/// timeout: the browser did not come back in ten minutes; denied: refused in
/// the browser or by the token endpoint; not-supported: the server offers no
/// usable MCP authorization; client-required: no dynamic registration and no
/// client entered under "advanced"; network: a server could not be reached;
/// insecure-address: discovery named an address plain http may not reach;
/// key-in-use: the server is set up with a pasted `Authorization` header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpSignInFailure {
    Cancelled,
    Timeout,
    Denied,
    NotSupported,
    ClientRequired,
    Network,
    InsecureAddress,
    KeyInUse,
}

impl McpSignInFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            McpSignInFailure::Cancelled => "cancelled",
            McpSignInFailure::Timeout => "timeout",
            McpSignInFailure::Denied => "denied",
            McpSignInFailure::NotSupported => "not-supported",
            McpSignInFailure::ClientRequired => "client-required",
            McpSignInFailure::Network => "network",
            McpSignInFailure::InsecureAddress => "insecure-address",
            McpSignInFailure::KeyInUse => "key-in-use",
        }
    }
}

impl From<LoopbackFailure> for McpSignInFailure {
    fn from(reason: LoopbackFailure) -> McpSignInFailure {
        match reason {
            LoopbackFailure::Cancelled => McpSignInFailure::Cancelled,
            LoopbackFailure::Timeout => McpSignInFailure::Timeout,
            LoopbackFailure::Denied => McpSignInFailure::Denied,
        }
    }
}

/// `McpSignInResult`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpSignInResult {
    Ok,
    Failed(McpSignInFailure),
}

/// `McpSignInOptions` without the `AbortSignal` (the caller reports an abort
/// with [`SignIn::on_abort`])
#[derive(Clone)]
pub struct McpSignInOptions<'a> {
    /// `openExternal(url)`: opens an address in the system browser; `false`
    /// when it did not open (the TypeScript's promise rejected)
    pub open_external: &'a dyn Fn(&str) -> bool,
    /// what the browser shows once it is back, in the person's language
    pub pages: LoopbackPages,
    /// tests shorten it; the app keeps [`MCP_SIGN_IN_TIMEOUT_MS`]
    pub timeout_ms: Option<f64>,
}

/// `SignInContext`
#[derive(Clone)]
pub struct SignInContext<'a> {
    /// `openExternal(url)`; `false` when the browser did not open
    pub open_external: &'a dyn Fn(&str) -> bool,
    pub server_url: String,
    /// from the server's last 401, when it named one (`URL.href`)
    pub resource_metadata_url: Option<String>,
    /// from the server's last 401, when it named one
    pub scope: Option<String>,
    pub config: Option<McpOAuthConfig>,
    /// the product name, sent when registering a client
    pub client_name: String,
    pub pages: LoopbackPages,
    pub timeout_ms: Option<f64>,
    /// `signal.aborted` when the attempt starts
    pub aborted: bool,
}

/// What `signInToServer` answers, or throws
#[derive(Debug, Clone, PartialEq)]
pub enum SignInResult {
    Signed(Box<StoredOAuth>),
    Failed(McpSignInFailure),
    /// the TypeScript throws (`String(error)`)
    Threw(String),
}

/// What is known when the browser has been opened
struct Waiting {
    receiver: LoopbackReceiver,
    authorization_server_url: String,
    metadata: JsonValue,
    resource: Option<String>,
    client: JsonValue,
    registered_client: Option<JsonValue>,
    code_verifier: String,
}

enum Phase {
    Waiting(Box<Waiting>),
    Done(Option<SignInResult>),
}

/// `signInToServer(ctx)` as a state machine; see the module doc
pub struct SignIn {
    phase: Phase,
    /// `ctx.signal?.aborted`
    aborted: bool,
}

fn includes(list: Option<&JsonValue>, wanted: &str) -> bool {
    matches!(list, Some(JsonValue::Array(items))
        if items.iter().any(|item| matches!(item, JsonValue::String(s) if s == wanted)))
}

fn base64url(bytes: &[u8]) -> String {
    base64(bytes)
        .replace('+', "-")
        .replace('/', "_")
        .trim_end_matches('=')
        .to_owned()
}

/// `failureOf(err, fallback)`
fn failure_of(aborted: bool, error: &AuthError, fallback: McpSignInFailure) -> SignInResult {
    if aborted {
        return SignInResult::Failed(McpSignInFailure::Cancelled);
    }
    if matches!(error, AuthError::Fetch(e) if e.name == AUTH_ADDRESS_ERROR) {
        return SignInResult::Failed(McpSignInFailure::InsecureAddress);
    }
    SignInResult::Failed(fallback)
}

fn fail(reason: McpSignInFailure) -> SignInResult {
    SignInResult::Failed(reason)
}

struct Prepared {
    client: JsonValue,
    registered_client: Option<JsonValue>,
    code_verifier: String,
}

impl SignIn {
    fn done(result: SignInResult, aborted: bool) -> SignIn {
        SignIn {
            phase: Phase::Done(Some(result)),
            aborted,
        }
    }

    /// `signInToServer(ctx)` up to the wait for the browser
    pub fn start(host: &mut dyn SignInHost, ctx: SignInContext<'_>) -> SignIn {
        let aborted = ctx.aborted;
        let finished = |result: SignInResult| SignIn::done(result, aborted);

        // discovery: the protected resource metadata, then the authorization server's
        let info = {
            let mut fetch = AuthFetch::new(&mut *host);
            auth::discover_oauth_server_info(
                &mut fetch,
                &ctx.server_url,
                ctx.resource_metadata_url.as_deref(),
            )
        };
        let info = match info {
            Ok(info) => info,
            Err(error) => {
                return finished(failure_of(aborted, &error, McpSignInFailure::Network));
            }
        };
        // PKCE S256 is required; a server that does not say it supports it is not used
        let Some(metadata) = info.authorization_server_metadata.clone() else {
            return finished(fail(McpSignInFailure::NotSupported));
        };
        if !includes(
            metadata.get("code_challenge_methods_supported").as_deref(),
            "S256",
        ) {
            return finished(fail(McpSignInFailure::NotSupported));
        }
        if !includes(metadata.get("response_types_supported").as_deref(), "code") {
            return finished(fail(McpSignInFailure::NotSupported));
        }
        let mut resource: Option<String> = None;
        if let Some(resource_metadata) = &info.resource_metadata {
            let requested = match auth::resource_url_from_server_url(&ctx.server_url) {
                Ok(requested) => requested,
                Err(error) => return finished(SignInResult::Threw(error.to_js_string())),
            };
            let configured = as_str(prop(resource_metadata, "resource")).unwrap_or("undefined");
            match auth::check_resource_allowed(&requested, configured) {
                Err(error) => return finished(SignInResult::Threw(error.to_js_string())),
                Ok(false) => return finished(fail(McpSignInFailure::NotSupported)),
                Ok(true) => {}
            }
            match Url::parse(configured) {
                Ok(url) => resource = Some(url.as_str().to_owned()),
                Err(_) => {
                    return finished(SignInResult::Threw("TypeError: Invalid URL".to_owned()));
                }
            }
        }
        let authorization_endpoint_value = metadata.get("authorization_endpoint");
        let authorization_endpoint =
            as_str(authorization_endpoint_value.as_deref()).unwrap_or("undefined");
        if !matches!(
            check_address(&mut *host, authorization_endpoint),
            AddressCheck::Allowed { .. }
        ) {
            return finished(fail(McpSignInFailure::InsecureAddress));
        }
        let scope = ctx.scope.clone().or_else(|| {
            match info
                .resource_metadata
                .as_ref()
                .and_then(|m| prop(m, "scopes_supported"))
            {
                Some(JsonValue::Array(scopes)) => Some(
                    scopes
                        .iter()
                        .map(|s| match s {
                            JsonValue::Null => String::new(),
                            other => js_string(other),
                        })
                        .collect::<Vec<_>>()
                        .join(" "),
                ),
                _ => None,
            }
        });

        let state = base64url(&host.random_bytes(24));
        let timeout_ms = ctx.timeout_ms.unwrap_or(MCP_SIGN_IN_TIMEOUT_MS);
        let mut receiver =
            match LoopbackReceiver::start(&mut *host, &state, &ctx.pages, timeout_ms, aborted) {
                Ok(receiver) => receiver,
                Err(_) => return finished(fail(McpSignInFailure::Network)),
            };
        // the client: registered for this return address, else the one the person entered
        let prepared = Self::prepare(
            host,
            &ctx,
            &info.authorization_server_url,
            &metadata,
            resource.as_deref(),
            scope.as_deref(),
            &state,
            &receiver,
            aborted,
        );
        match prepared {
            Err(result) => {
                receiver.close(&mut *host);
                finished(result)
            }
            Ok(prepared) => {
                let mut sign_in = SignIn {
                    phase: Phase::Waiting(Box::new(Waiting {
                        receiver,
                        authorization_server_url: info.authorization_server_url,
                        metadata,
                        resource,
                        client: prepared.client,
                        registered_client: prepared.registered_client,
                        code_verifier: prepared.code_verifier,
                    })),
                    aborted,
                };
                sign_in.advance(host);
                sign_in
            }
        }
    }

    /// the registration, the authorization address and the browser
    #[allow(clippy::too_many_arguments)]
    fn prepare(
        host: &mut dyn SignInHost,
        ctx: &SignInContext<'_>,
        authorization_server_url: &str,
        metadata: &JsonValue,
        resource: Option<&str>,
        scope: Option<&str>,
        state: &str,
        receiver: &LoopbackReceiver,
        aborted: bool,
    ) -> Result<Prepared, SignInResult> {
        let scope = scope.filter(|s| !s.is_empty());
        let mut registered_client: Option<JsonValue> = None;
        let mut client = client_of(None, ctx.config.as_ref());
        if client.is_none() {
            let has_registration = as_str(metadata.get("registration_endpoint").as_deref())
                .is_some_and(|e| !e.is_empty());
            if !has_registration {
                return Err(fail(McpSignInFailure::ClientRequired));
            }
            let client_metadata = object(vec![
                ("client_name", text(ctx.client_name.as_str())),
                (
                    "redirect_uris",
                    JsonValue::Array(vec![text(receiver.redirect_uri())]),
                ),
                (
                    "grant_types",
                    JsonValue::Array(vec![text("authorization_code"), text("refresh_token")]),
                ),
                ("response_types", JsonValue::Array(vec![text("code")])),
                ("token_endpoint_auth_method", text("none")),
            ]);
            let registered = {
                let mut fetch = AuthFetch::new(&mut *host);
                auth::register_client(
                    &mut fetch,
                    authorization_server_url,
                    Some(metadata),
                    &client_metadata,
                    scope,
                )
            };
            match registered {
                Ok(found) => {
                    registered_client = Some(found.clone());
                    client = Some(found);
                }
                Err(error) => return Err(failure_of(aborted, &error, McpSignInFailure::Network)),
            }
        }
        let Some(client) = client else {
            return Err(fail(McpSignInFailure::ClientRequired));
        };
        let client_id = as_str(prop(&client, "client_id")).unwrap_or("undefined");
        let authorization = {
            let mut fetch = AuthFetch::new(&mut *host);
            auth::start_authorization(
                &mut fetch,
                authorization_server_url,
                &StartAuthorizationOptions {
                    metadata: Some(metadata),
                    client_id,
                    redirect_url: &receiver.redirect_uri(),
                    scope,
                    state: Some(state),
                    resource,
                },
            )
        };
        let authorization = match authorization {
            Ok(authorization) => authorization,
            Err(error) => return Err(failure_of(aborted, &error, McpSignInFailure::Network)),
        };
        if aborted {
            return Err(fail(McpSignInFailure::Cancelled));
        }
        if !(ctx.open_external)(&authorization.authorization_url) {
            return Err(fail(McpSignInFailure::Network));
        }
        Ok(Prepared {
            client,
            registered_client,
            code_verifier: authorization.code_verifier,
        })
    }

    /// `const back = await receiver.outcome` once it is there, and what follows
    fn advance(&mut self, host: &mut dyn SignInHost) {
        let Phase::Waiting(waiting) = &self.phase else {
            return;
        };
        let Some(outcome) = waiting.receiver.outcome().cloned() else {
            return;
        };
        let Phase::Waiting(mut waiting) = std::mem::replace(&mut self.phase, Phase::Done(None))
        else {
            return;
        };
        let result = match outcome {
            LoopbackOutcome::Failed(reason) => fail(reason.into()),
            LoopbackOutcome::Code(code) => self.exchange(host, &waiting, &code),
        };
        waiting.receiver.close(&mut *host);
        self.phase = Phase::Done(Some(result));
    }

    /// the token exchange
    fn exchange(
        &mut self,
        host: &mut dyn SignInHost,
        waiting: &Waiting,
        code: &str,
    ) -> SignInResult {
        let redirect_uri = waiting.receiver.redirect_uri();
        let exchanged = {
            let mut fetch = AuthFetch::new(&mut *host);
            auth::exchange_authorization(
                &mut fetch,
                &waiting.authorization_server_url,
                &ExchangeAuthorizationOptions {
                    metadata: Some(&waiting.metadata),
                    client_information: &waiting.client,
                    authorization_code: code,
                    code_verifier: &waiting.code_verifier,
                    redirect_uri: &redirect_uri,
                    resource: waiting.resource.as_deref(),
                },
            )
        };
        match exchanged {
            Err(error) => {
                let fallback = if error.oauth_error_code().is_some() {
                    McpSignInFailure::Denied
                } else {
                    McpSignInFailure::Network
                };
                failure_of(self.aborted, &error, fallback)
            }
            Ok(tokens) => {
                let expires_at = expires_at_of(&tokens, host.now());
                SignInResult::Signed(Box::new(StoredOAuth {
                    tokens,
                    expires_at,
                    authorization_server_url: waiting.authorization_server_url.clone(),
                    metadata: waiting.metadata.clone(),
                    resource: waiting.resource.clone(),
                    registered_client: waiting.registered_client.clone(),
                }))
            }
        }
    }

    /// whether the sign-in is over and its result not yet taken
    pub fn is_done(&self) -> bool {
        matches!(self.phase, Phase::Done(Some(_)))
    }

    /// the result, once, when the sign-in is over
    pub fn take_result(&mut self) -> Option<SignInResult> {
        match &mut self.phase {
            Phase::Done(result) => result.take(),
            Phase::Waiting(_) => None,
        }
    }

    /// the port of the loopback server while the sign-in waits for the browser
    pub fn port(&self) -> Option<u16> {
        match &self.phase {
            Phase::Waiting(waiting) => Some(waiting.receiver.port()),
            Phase::Done(_) => None,
        }
    }

    /// a request of the loopback server on `port`: whether this sign-in's
    pub fn on_request(
        &mut self,
        host: &mut dyn SignInHost,
        port: u16,
        method: &str,
        target: &str,
    ) -> bool {
        match &mut self.phase {
            Phase::Waiting(waiting) if waiting.receiver.port() == port => {
                waiting.receiver.on_request(&mut *host, method, target);
            }
            _ => return false,
        }
        self.advance(host);
        true
    }

    /// a timer fired: whether it was this sign-in's (the time limit)
    pub fn on_timeout(&mut self, host: &mut dyn SignInHost, timer: u64) -> bool {
        let owned = match &mut self.phase {
            Phase::Waiting(waiting) => waiting.receiver.on_timeout(&mut *host, timer),
            Phase::Done(_) => false,
        };
        if owned {
            self.advance(host);
        }
        owned
    }

    /// the attempt's `AbortSignal` aborted
    pub fn on_abort(&mut self, host: &mut dyn SignInHost) {
        self.aborted = true;
        if let Phase::Waiting(waiting) = &mut self.phase {
            waiting.receiver.on_abort(&mut *host);
        }
        self.advance(host);
    }
}

// ---- refreshing and revoking -------------------------------------------------

/// `RefreshOutcome`: refused: the grant is gone and only a new sign-in
/// helps; network: try again later
#[derive(Debug, Clone, PartialEq)]
pub enum RefreshOutcome {
    Refreshed(Box<StoredOAuth>),
    Refused,
    Network,
}

/// `REFUSALS`: OAuth answers that mean the refresh token or the client is no longer honoured
const REFUSALS: [&str; 3] = ["invalid_grant", "invalid_client", "unauthorized_client"];

/// `refreshStoredOAuth(stored, config, fetchFn, now)`
pub fn refresh_stored_oauth(
    stored: &StoredOAuth,
    config: Option<&McpOAuthConfig>,
    net: &mut dyn RefreshNet,
) -> RefreshOutcome {
    let client = client_of(stored.registered_client.as_ref(), config);
    let refresh_token = prop(&stored.tokens, "refresh_token").filter(|t| t.truthy());
    let (Some(client), Some(refresh_token)) = (client, refresh_token) else {
        return RefreshOutcome::Refused;
    };
    let resource = match stored.resource.as_deref() {
        Some(resource) => match Url::parse(resource) {
            Ok(url) => Some(url.as_str().to_owned()),
            Err(_) => return RefreshOutcome::Network,
        },
        None => None,
    };
    let refresh_token = js_string(refresh_token);
    let refreshed = auth::refresh_authorization(
        net,
        &stored.authorization_server_url,
        &RefreshAuthorizationOptions {
            metadata: Some(&stored.metadata),
            client_information: &client,
            refresh_token: &refresh_token,
            resource: resource.as_deref(),
        },
    );
    match refreshed {
        Ok(tokens) => {
            let expires_at = expires_at_of(&tokens, net.now());
            let mut next = stored.clone();
            next.tokens = tokens;
            next.expires_at = expires_at;
            RefreshOutcome::Refreshed(Box::new(next))
        }
        Err(error) => match error.oauth_error_code() {
            Some(code) if REFUSALS.contains(&code) => RefreshOutcome::Refused,
            _ => RefreshOutcome::Network,
        },
    }
}

/// `revokeStoredOAuth(stored, config, fetchFn)`: ask the authorization server
/// to forget the grant (RFC 7009), when it named a revocation endpoint. Best
/// effort: `false` on any failure; the caller forgets the tokens either way.
pub fn revoke_stored_oauth(
    stored: &StoredOAuth,
    config: Option<&McpOAuthConfig>,
    fetch: &mut dyn FetchHost,
) -> bool {
    let endpoint = match prop(&stored.metadata, "revocation_endpoint") {
        Some(JsonValue::String(endpoint)) if !endpoint.is_empty() => endpoint.clone(),
        _ => return false,
    };
    let refresh = prop(&stored.tokens, "refresh_token").filter(|t| !matches!(t, JsonValue::Null));
    let token = refresh
        .map(js_string)
        .or_else(|| prop(&stored.tokens, "access_token").map(js_string))
        .unwrap_or_else(|| "undefined".to_owned());
    let hint = if refresh.is_some_and(|r| r.truthy()) {
        "refresh_token"
    } else {
        "access_token"
    };
    let mut body = url::form_urlencoded::Serializer::new(String::new());
    body.append_pair("token", &token);
    body.append_pair("token_type_hint", hint);
    if let Some(client) = client_of(stored.registered_client.as_ref(), config) {
        body.append_pair(
            "client_id",
            as_str(prop(&client, "client_id")).unwrap_or("undefined"),
        );
        if let Some(secret) = prop(&client, "client_secret").filter(|s| s.truthy()) {
            body.append_pair("client_secret", &js_string(secret));
        }
    }
    let init = FetchInit {
        method: Some("POST".to_owned()),
        headers: Some(Headers::from_pairs(&[(
            "Content-Type",
            "application/x-www-form-urlencoded",
        )])),
        body: Some(body.finish()),
        redirect: None,
    };
    match fetch.fetch(&endpoint, &init) {
        Ok(response) => {
            cancel_body(fetch, &response.body);
            response.ok()
        }
        Err(_) => false,
    }
}
