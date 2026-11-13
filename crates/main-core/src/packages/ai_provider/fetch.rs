//! `packages/ai-provider/src/fetch.ts`: the fetch every AI request goes
//! through: the user agent, the retries after a busy answer, the rescue over
//! Electron's network stack, and the requests that carry a credential and
//! must never follow a redirect to another address.
//!
//! The module's variables (`setRescueFetch`, `setAiFetch`, `setAiUserAgent`,
//! `setAiTransientRetryDelays`) are [`AiFetchState`], which the caller owns
//! and hands to every call as [`AiFetch`].

use std::cell::{Cell, RefCell};
use std::pin::Pin;
use std::rc::Rc;

use jscompat::{JsonValue, date_parse, js_regex, math_max, to_number};

use super::free_ai::{free_limit_of, is_free_tier_model_refusal};
use super::jsval::{slice_to, text};
use super::protocols_shared::parse_url;
use super::task::{Fetcher, JsError, Request, RequestBody, Response, Rt, Signal};
use crate::packages::i18n::PRODUCT_NAME;

/// `AI_DEFAULT_USER_AGENT`
pub const AI_DEFAULT_USER_AGENT: &str = PRODUCT_NAME;

/// `DEFAULT_TRANSIENT_RETRY_DELAYS_MS`
pub const DEFAULT_TRANSIENT_RETRY_DELAYS_MS: [f64; 2] = [2000.0, 5000.0];

/// The module state of `fetch.ts`.
#[derive(Debug, Clone, PartialEq)]
pub struct AiFetchState {
    /// `rescueFetch`: `None` until `setRescueFetch`
    pub rescue: Option<Fetcher>,
    /// `primaryFetch`: `None` is the global fetch
    pub primary: Option<Fetcher>,
    pub user_agent: String,
    pub transient_retry_delays: Vec<f64>,
}

impl Default for AiFetchState {
    fn default() -> Self {
        AiFetchState {
            rescue: None,
            primary: None,
            user_agent: AI_DEFAULT_USER_AGENT.to_owned(),
            transient_retry_delays: DEFAULT_TRANSIENT_RETRY_DELAYS_MS.to_vec(),
        }
    }
}

impl AiFetchState {
    /// `setRescueFetch(fn)`
    pub fn set_rescue_fetch(&mut self, fetcher: Option<Fetcher>) {
        self.rescue = fetcher;
    }

    /// `setAiFetch(fn)`
    pub fn set_ai_fetch(&mut self, fetcher: Option<Fetcher>) {
        self.primary = fetcher;
    }

    /// `setAiUserAgent(ua)`
    pub fn set_ai_user_agent(&mut self, ua: &str) {
        self.user_agent = if ua.is_empty() {
            AI_DEFAULT_USER_AGENT.to_owned()
        } else {
            ua.to_owned()
        };
    }

    /// `setAiTransientRetryDelays(delays)`; `None` restores the default
    pub fn set_ai_transient_retry_delays(&mut self, delays: Option<Vec<f64>>) {
        self.transient_retry_delays =
            delays.unwrap_or_else(|| DEFAULT_TRANSIENT_RETRY_DELAYS_MS.to_vec());
    }
}

/// The state every call reads.
pub type AiFetch = Rc<RefCell<AiFetchState>>;

/// A `RequestInit`: what is sent, and the signal.
#[derive(Clone, Default)]
pub struct Init {
    pub request: Request,
    pub signal: Option<Signal>,
}

/// `headerRecord(given)`: the headers as a plain record: a name given twice
/// keeps its first place and its last value.
fn header_record(given: &[(String, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (name, value) in given {
        match out.iter_mut().find(|(k, _)| k == name) {
            Some(slot) => slot.1 = value.clone(),
            None => out.push((name.clone(), value.clone())),
        }
    }
    out
}

/// `withUserAgent(init)`
pub fn with_user_agent(fx: &AiFetch, init: &Init) -> Init {
    let mut headers = header_record(&init.request.headers);
    if !headers
        .iter()
        .any(|(name, _)| name.to_lowercase() == "user-agent")
    {
        headers.push(("User-Agent".into(), fx.borrow().user_agent.clone()));
    }
    let mut out = init.clone();
    out.request.headers = headers;
    out
}

/// `isBlockPage(response)`
fn is_block_page(response: &Response) -> bool {
    response.status() == 403.0
        && response
            .header("content-type")
            .unwrap_or_default()
            .contains("text/html")
}

/// `MAX_RETRY_AFTER_MS`
const MAX_RETRY_AFTER_MS: f64 = 20_000.0;

/// `retryAfterMs(response)`
fn retry_after_ms(rt: &Rt, response: &Response) -> Option<f64> {
    let raw = response.header("retry-after")?;
    if raw.is_empty() {
        return None;
    }
    let seconds = to_number(&raw);
    if seconds.is_finite() {
        return Some(math_max(0.0, seconds * 1000.0));
    }
    let at = date_parse(&raw);
    at.is_finite().then(|| math_max(0.0, at - rt.now()))
}

/// `wait(ms, signal)`: `true` once the time is up, `false` when the signal
/// aborted first.
async fn wait(rt: &Rt, ms: f64, signal: Option<&Signal>) -> bool {
    if signal.is_some_and(Signal::aborted) {
        return false;
    }
    let (settle, done) = rt.deferred::<bool>();
    let listener: Rc<Cell<Option<u64>>> = Rc::new(Cell::new(None));
    let on_time = settle.clone();
    let off = (signal.cloned(), listener.clone());
    let timer = rt.set_timeout(ms, move || {
        if let (Some(signal), Some(l)) = (&off.0, off.1.get()) {
            signal.off(l);
        }
        on_time.settle(true);
    });
    if let Some(signal) = signal {
        let rt2 = rt.clone();
        let on_abort = settle.clone();
        listener.set(Some(signal.on_abort(move |_| {
            rt2.clear_timeout(Some(timer));
            on_abort.settle(false);
        })));
    }
    done.await
}

/// `isTransientRefusal(response)`
async fn is_transient_refusal(rt: &Rt, response: &Response) -> bool {
    let status = response.status();
    if status == 503.0 || status == 529.0 {
        return true;
    }
    if status != 429.0 {
        return false;
    }
    match response.clone_response().text().await {
        Ok(body) => {
            let text = JsonValue::String(format!("HTTP 429: {body}"));
            free_limit_of(&text, rt.now()).is_none() && !is_free_tier_model_refusal(&text)
        }
        Err(_) => true,
    }
}

/// Why a request went out a second time (`AiFetchResend`): `failed`, `busy`,
/// `blocked`.
pub type AiFetchResend = &'static str;

/// `AiFetchWatch`: told before each resend.
#[derive(Clone, Default)]
pub struct AiFetchWatch {
    pub on_resend: Option<Rc<dyn Fn(AiFetchResend)>>,
}

fn resend(watch: Option<&AiFetchWatch>, why: AiFetchResend) {
    if let Some(on_resend) = watch.and_then(|w| w.on_resend.as_ref()) {
        on_resend(why);
    }
}

/// `init.body == null || typeof init.body === 'string'`
fn resendable(init: &Init) -> bool {
    matches!(init.request.body, None | Some(RequestBody::Text(_)))
}

/// `aiFetch(url, init, watch)`
pub async fn ai_fetch(
    rt: &Rt,
    fx: &AiFetch,
    url: &str,
    raw_init: &Init,
    watch: Option<&AiFetchWatch>,
) -> Result<Response, JsError> {
    let init = with_user_agent(fx, raw_init);
    let signal = init.signal.clone();
    let mut response = fetch_once(rt, fx, url, &init, watch).await?;
    let resendable = resendable(&init);
    let delays = fx.borrow().transient_retry_delays.clone();
    for delay in delays {
        if !resendable
            || signal.as_ref().is_some_and(Signal::aborted)
            || !is_transient_refusal(rt, &response).await
        {
            break;
        }
        let after = retry_after_ms(rt, &response);
        if after.is_some_and(|after| after > MAX_RETRY_AFTER_MS) {
            break;
        }
        if !wait(rt, after.unwrap_or(delay), signal.as_ref()).await {
            break;
        }
        // the refused answer is dropped unread; only the last one reaches the caller
        response.cancel();
        resend(watch, "busy");
        response = fetch_once(rt, fx, url, &init, watch).await?;
    }
    Ok(response)
}

/// `REDIRECT_STATUSES`
fn is_redirect_status(status: f64) -> bool {
    [301.0, 302.0, 303.0, 307.0, 308.0].contains(&status)
}

/// `MAX_DOWNLOAD_REDIRECTS`
pub const MAX_DOWNLOAD_REDIRECTS: f64 = 5.0;

/// `AiRedirectRefusal`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiRedirectRefusal {
    NotFollowed,
    TooMany,
    Insecure,
    Unreadable,
}

impl AiRedirectRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            AiRedirectRefusal::NotFollowed => "not-followed",
            AiRedirectRefusal::TooMany => "too-many",
            AiRedirectRefusal::Insecure => "insecure",
            AiRedirectRefusal::Unreadable => "unreadable",
        }
    }
}

/// `new AiRedirectRefusedError(target, reason)`
pub fn ai_redirect_refused_error(target: &str, reason: AiRedirectRefusal) -> JsError {
    let to = if target.is_empty() {
        String::new()
    } else {
        format!(" to {target}")
    };
    let message = match reason {
        AiRedirectRefusal::NotFollowed => format!(
            "The provider answered with a redirect{to}, which a request carrying the API key does not follow. The API key was not sent on."
        ),
        AiRedirectRefusal::TooMany => format!(
            "The download was redirected more than {} times (the last time{to}) and was stopped.",
            jscompat::number_to_string(MAX_DOWNLOAD_REDIRECTS)
        ),
        AiRedirectRefusal::Insecure => format!(
            "The download was redirected{to}, which is not an https address, and was stopped. The API key was not sent on."
        ),
        AiRedirectRefusal::Unreadable => "The download was redirected to an address that cannot be read and was stopped. The API key was not sent on.".to_owned(),
    };
    JsError::new("AiRedirectRefusedError", message).with("reason", text(reason.as_str()))
}

/// `refusedInsideFetch(error)`
pub fn refused_inside_fetch(error: &JsError) -> bool {
    error.is_error()
        && js_regex!(r"^(Redirect was cancelled$|Attempted to redirect, but redirect policy was)")
            .test(&error.message)
}

/// `KeyedFetchBase`: what `keyedFetch` sends through.
#[derive(Debug, Clone, PartialEq)]
pub enum KeyedFetchBase {
    /// `aiFetch`
    Ai,
    /// a plain fetch (called with two arguments)
    Plain(Fetcher),
    /// `fetchSeeingRedirects(first, seeing)`
    SeeingRedirects(Box<KeyedFetchBase>, Box<KeyedFetchBase>),
}

pub type FetchFuture<'a> = Pin<Box<dyn Future<Output = Result<Response, JsError>> + 'a>>;

/// A call of a base: `watch` is passed only to a base that takes it.
pub fn call_base<'a>(
    rt: &'a Rt,
    fx: &'a AiFetch,
    base: &'a KeyedFetchBase,
    url: &'a str,
    init: &'a Init,
    watch: Option<&'a AiFetchWatch>,
) -> FetchFuture<'a> {
    Box::pin(async move {
        match base {
            KeyedFetchBase::Ai => ai_fetch(rt, fx, url, init, watch).await,
            KeyedFetchBase::Plain(via) => {
                rt.fetch(*via, url, init.request.clone(), init.signal.as_ref())
                    .await
            }
            // `fetchSeeingRedirects`: a fetch of two arguments
            KeyedFetchBase::SeeingRedirects(first, seeing) => {
                match call_base(rt, fx, first, url, init, None).await {
                    Ok(response) => Ok(response),
                    Err(error) => {
                        if !refused_inside_fetch(&error) {
                            return Err(error);
                        }
                        call_base(rt, fx, seeing, url, init, None).await
                    }
                }
            }
        }
    })
}

/// `fetchSeeingRedirects(first, seeing)`
pub fn fetch_seeing_redirects(first: KeyedFetchBase, seeing: KeyedFetchBase) -> KeyedFetchBase {
    KeyedFetchBase::SeeingRedirects(Box::new(first), Box::new(seeing))
}

struct Unfollowed {
    response: Response,
    redirected: bool,
    location: Option<String>,
}

/// `askUnfollowed(base, url, init, watch)`
async fn ask_unfollowed(
    rt: &Rt,
    fx: &AiFetch,
    base: &KeyedFetchBase,
    url: &str,
    init: &Init,
    watch: Option<&AiFetchWatch>,
) -> Result<Unfollowed, JsError> {
    let mut no_follow = init.clone();
    no_follow.request.redirect = Some("manual".into());
    let response = match call_base(rt, fx, base, url, &no_follow, watch).await {
        Ok(response) => response,
        Err(error) => {
            if refused_inside_fetch(&error) {
                return Err(ai_redirect_refused_error(
                    "",
                    AiRedirectRefusal::NotFollowed,
                ));
            }
            return Err(error);
        }
    };
    let location = response.header("location");
    let redirected = response.kind() == "opaqueredirect"
        || (is_redirect_status(response.status()) && location.is_some());
    Ok(Unfollowed {
        response,
        redirected,
        location,
    })
}

/// `url.host` of a parsed URL: the host and a port that is not the default
fn url_host(url: &url::Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

/// `siteOf(url)`: scheme and host of an address, for an error text
fn site_of(url: &url::Url) -> String {
    format!("{}://{}", url.scheme(), slice_to(&url_host(url), 100))
}

/// `keyedFetch(url, init, watch, base)`: a request that carries a credential
/// never follows a redirect.
pub async fn keyed_fetch(
    rt: &Rt,
    fx: &AiFetch,
    url: &str,
    init: &Init,
    watch: Option<&AiFetchWatch>,
    base: &KeyedFetchBase,
) -> Result<Response, JsError> {
    let Unfollowed {
        response,
        redirected,
        location,
    } = ask_unfollowed(rt, fx, base, url, init, watch).await?;
    if !redirected {
        return Ok(response);
    }
    response.cancel();
    let mut target = String::new();
    if let Some(location) = location
        && let Ok(home) = url::Url::parse(url)
        && let Ok(to) = home.join(&location)
    {
        // an unreadable Location is not worth a second error
        target = site_of(&to);
    }
    Err(ai_redirect_refused_error(
        &target,
        AiRedirectRefusal::NotFollowed,
    ))
}

/// `UNKEYED_HEADERS`
fn is_unkeyed_header(name: &str) -> bool {
    [
        "accept",
        "accept-encoding",
        "accept-language",
        "range",
        "user-agent",
    ]
    .contains(&name)
}

/// `BODY_HEADERS`
fn is_body_header(name: &str) -> bool {
    [
        "content-encoding",
        "content-language",
        "content-length",
        "content-location",
        "content-type",
    ]
    .contains(&name)
}

fn is_loopback_host(host: &str) -> bool {
    js_regex!(r"^(localhost|127(\.\d{1,3}){3}|\[::1\])$", "i").test(host)
}

/// `KeyedDownloadOptions`
#[derive(Debug, Clone, Default)]
pub struct KeyedDownloadOptions {
    /// `None`: `aiFetch`
    pub base: Option<KeyedFetchBase>,
    pub key_outside_headers: bool,
}

/// `keyedDownload(url, init, options)`: a download asked for with a
/// credential, whose redirects are followed by hand and never carry the
/// credential to another origin.
pub async fn keyed_download(
    rt: &Rt,
    fx: &AiFetch,
    url: &str,
    init: &Init,
    options: &KeyedDownloadOptions,
) -> Result<Response, JsError> {
    let base = options.base.clone().unwrap_or(KeyedFetchBase::Ai);
    let home = parse_url(url)?;
    let local_http =
        home.scheme() == "http" && is_loopback_host(home.host_str().unwrap_or_default());
    let key_stays = options.key_outside_headers
        || !home.username().is_empty()
        || home.password().is_some_and(|p| !p.is_empty())
        || home.query_pairs().any(|(name, _)| {
            js_regex!(r"^(key|api[-_]?key|access[-_]?token|token)$", "i").test(&name)
        });
    let mut at = home.clone();
    let mut method = init
        .request
        .method
        .clone()
        .unwrap_or_else(|| "GET".into())
        .to_uppercase();
    let mut body = init.request.body.clone();
    let mut headers = header_record(&init.request.headers);
    let mut keyed = true;
    let mut followed = 0.0;
    loop {
        let mut hop = init.clone();
        hop.request.method = Some(method.clone());
        hop.request.headers = headers.clone();
        hop.request.body = body.clone();
        let Unfollowed {
            response,
            redirected,
            location,
        } = ask_unfollowed(rt, fx, &base, at.as_str(), &hop, None).await?;
        if !redirected {
            return Ok(response);
        }
        response.cancel();
        // an opaque redirect (a browser) names no address to follow by hand
        let Some(location) = location else {
            return Err(ai_redirect_refused_error(
                "",
                AiRedirectRefusal::NotFollowed,
            ));
        };
        let Ok(next) = at.join(&location) else {
            return Err(ai_redirect_refused_error("", AiRedirectRefusal::Unreadable));
        };
        if key_stays {
            return Err(ai_redirect_refused_error(
                &site_of(&next),
                AiRedirectRefusal::NotFollowed,
            ));
        }
        if followed >= MAX_DOWNLOAD_REDIRECTS {
            return Err(ai_redirect_refused_error(
                &site_of(&next),
                AiRedirectRefusal::TooMany,
            ));
        }
        let secure = next.scheme() == "https"
            || (local_http
                && next.scheme() == "http"
                && is_loopback_host(next.host_str().unwrap_or_default()));
        if !secure {
            return Err(ai_redirect_refused_error(
                &site_of(&next),
                AiRedirectRefusal::Insecure,
            ));
        }
        let status = response.status();
        let as_get = if status == 303.0 {
            method != "GET" && method != "HEAD"
        } else {
            (status == 301.0 || status == 302.0) && method == "POST"
        };
        if as_get {
            method = "GET".into();
            body = None;
            headers.retain(|(name, _)| !is_body_header(&name.to_lowercase()));
        }
        if keyed && next.origin() != home.origin() {
            if body.is_some() {
                return Err(ai_redirect_refused_error(
                    &site_of(&next),
                    AiRedirectRefusal::NotFollowed,
                ));
            }
            keyed = false;
            headers.retain(|(name, _)| is_unkeyed_header(&name.to_lowercase()));
        }
        at = next;
        followed += 1.0;
    }
}

/// `fetchOnce(url, init, watch)`: the request, then the rescue fetch when
/// the first try threw or met an edge block page.
async fn fetch_once(
    rt: &Rt,
    fx: &AiFetch,
    url: &str,
    init: &Init,
    watch: Option<&AiFetchWatch>,
) -> Result<Response, JsError> {
    let signal = init.signal.as_ref();
    let (primary, rescue) = {
        let state = fx.borrow();
        (state.primary.unwrap_or(Fetcher::Node), state.rescue)
    };
    let response = match rt.fetch(primary, url, init.request.clone(), signal).await {
        Ok(response) => response,
        Err(primary_error) => {
            let Some(rescue) = rescue else {
                return Err(primary_error);
            };
            if signal.is_some_and(Signal::aborted) {
                return Err(primary_error);
            }
            rt.log(
                "warn",
                vec![
                    text("[ai-provider] fetch failed, retrying via rescue fetch:"),
                    text(primary_error.to_js_string()),
                ],
            );
            resend(watch, "failed");
            return match rt.fetch(rescue, url, init.request.clone(), signal).await {
                Ok(response) => Ok(response),
                // a redirect the rescue fetch refused is the service's answer, not the first failure
                Err(rescue_error) if refused_inside_fetch(&rescue_error) => Err(rescue_error),
                Err(_) => Err(primary_error),
            };
        }
    };
    if let Some(rescue) = rescue
        && resendable(init)
        && !signal.is_some_and(Signal::aborted)
        && is_block_page(&response)
    {
        let host = parse_url(url).map(|u| url_host(&u)).unwrap_or_default();
        rt.log(
            "warn",
            vec![
                text("[ai-provider] 403 block page from"),
                text(host),
                text("- retrying via rescue fetch"),
            ],
        );
        resend(watch, "blocked");
        if let Ok(rescued) = rt.fetch(rescue, url, init.request.clone(), signal).await
            && !is_block_page(&rescued)
        {
            return Ok(rescued);
        }
    }
    Ok(response)
}
