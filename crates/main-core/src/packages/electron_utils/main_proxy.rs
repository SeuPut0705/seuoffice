//! `packages/electron-utils/src/main-proxy.ts`.
//!
//! `undici`'s `EnvHttpProxyAgent` object stays on the Electron side; what is
//! ported is its decision: the environment variables it reads, the NO_PROXY
//! rules (node_modules/undici/lib/dispatcher/env-http-proxy-agent.js) and
//! which of its three agents carries a URL ([`EnvHttpProxyDecision`]).
//! `createMainProcessProxyDispatcher` is [`create_main_process_proxy_dispatcher`],
//! which answers the routing it declares ([`MainProxy::routes_via_proxy`])
//! and the agent undici would use ([`MainProxy::agent_for`]).
//! `declareProxyRouting` itself, which defines a symbol property on the
//! dispatcher object, is the Electron side's.

use jscompat::{Radix, js_regex, parse_int};
use url::Url;

/// The NO_PROXY list the main-process dispatcher ships with: the caller's own
/// entries first, then loopback. undici matches entries exactly (or by `*.` or
/// leading-dot suffix), and the URL host of IPv6 loopback keeps its brackets.
pub fn merge_no_proxy(user_no_proxy: Option<&str>) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if let Some(user) = user_no_proxy.filter(|v| !v.is_empty()) {
        parts.push(user);
    }
    parts.extend(["localhost", "127.0.0.1", "[::1]"]);
    parts.join(",")
}

fn default_port(protocol: &str) -> f64 {
    match protocol {
        "http:" => 80.0,
        "https:" => 443.0,
        _ => 0.0,
    }
}

struct NoProxyEntry {
    hostname: String,
    port: f64,
}

/// Whether a NO_PROXY list exempts a URL, by EnvHttpProxyAgent's rules: an
/// entry matches the host exactly, or as a suffix when it starts with `.` or
/// `*`, and an entry with a port only matches that port.
pub struct NoProxyMatcher {
    entries: Vec<NoProxyEntry>,
}

/// `noProxyMatcher(noProxy)`
pub fn no_proxy_matcher(no_proxy: &str) -> NoProxyMatcher {
    let entries = js_regex!(r"[,\s]")
        .split(no_proxy)
        .into_iter()
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            let with_port = js_regex!(r"^(.+):(\d+)$").exec(entry);
            NoProxyEntry {
                hostname: with_port
                    .as_ref()
                    .and_then(|m| m.get(1))
                    .unwrap_or(entry)
                    .to_lowercase(),
                port: parse_int(
                    with_port.as_ref().and_then(|m| m.get(2)).unwrap_or("0"),
                    Radix::Ten,
                ),
            }
        })
        .collect();
    NoProxyMatcher { entries }
}

impl NoProxyMatcher {
    /// no entry at all: everything is proxied
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// True when the list exempts `url`.
    pub fn matches(&self, url: &Url) -> bool {
        // host minus the port keeps the brackets of an IPv6 literal, as the entries do
        let mut host = url.host_str().unwrap_or("").to_owned();
        if let Some(port) = url.port() {
            host.push(':');
            host.push_str(&port.to_string());
        }
        let hostname = js_regex!(r":\d*$")
            .replace_all(&host, |_| String::new())
            .to_lowercase();
        // `Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol] || 0`
        let explicit = f64::from(url.port().unwrap_or(0));
        let port = if explicit != 0.0 {
            explicit
        } else {
            default_port(&format!("{}:", url.scheme()))
        };
        self.entries.iter().any(|entry| {
            if entry.port != 0.0 && entry.port != port {
                return false;
            }
            if js_regex!(r"^[.*]").test(&entry.hostname) {
                let suffix = js_regex!(r"^\*").replace_all(&entry.hostname, |_| String::new());
                hostname.ends_with(&suffix)
            } else {
                hostname == entry.hostname
            }
        })
    }
}

/// What `new ProxyAgent({ uri })` throws for a proxy address it cannot open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyAgentError {
    /// `new URL(uri)` throws: a `TypeError`
    InvalidUrl,
    /// the proxy client refuses an origin that is not http or https: an
    /// `InvalidArgumentError`
    InvalidProtocol,
}

impl ProxyAgentError {
    /// `error.code`
    pub fn code(&self) -> &'static str {
        match self {
            ProxyAgentError::InvalidUrl => "ERR_INVALID_URL",
            ProxyAgentError::InvalidProtocol => "UND_ERR_INVALID_ARG",
        }
    }

    /// `error.message`
    pub fn message(&self) -> &'static str {
        match self {
            ProxyAgentError::InvalidUrl => "Invalid URL",
            ProxyAgentError::InvalidProtocol => {
                "Invalid URL protocol: the URL must start with `http:` or `https:`."
            }
        }
    }
}

/// undici's `isHttpOrHttpsPrefixed`
fn is_http_or_https_prefixed(value: &str) -> bool {
    value.starts_with("http:") || value.starts_with("https:")
}

/// What the constructor of `ProxyAgent` does with `uri`: it opens the URL and
/// its proxy client takes the origin of it.
fn open_proxy(uri: &str) -> Result<(), ProxyAgentError> {
    let url = Url::parse(uri).map_err(|_| ProxyAgentError::InvalidUrl)?;
    // `url.origin || url.protocol`: the origin is "null" for an opaque one
    if is_http_or_https_prefixed(&url.origin().ascii_serialization()) {
        Ok(())
    } else {
        Err(ProxyAgentError::InvalidProtocol)
    }
}

/// The variables `EnvHttpProxyAgent` reads, `None` where unset.
#[derive(Debug, Clone, Default)]
pub struct ProxyEnv {
    pub http_proxy_lower: Option<String>,
    pub http_proxy_upper: Option<String>,
    pub https_proxy_lower: Option<String>,
    pub https_proxy_upper: Option<String>,
    pub no_proxy_lower: Option<String>,
    pub no_proxy_upper: Option<String>,
}

/// The options of `new EnvHttpProxyAgent(opts)` the decision reads, `None`
/// where undefined.
#[derive(Debug, Clone, Default)]
pub struct EnvHttpProxyOptions {
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub no_proxy: Option<String>,
}

/// Which of the agent's three dispatchers carries a request. Where no proxy
/// is configured for a scheme the agent holds the dispatcher of the scheme
/// before it (https, then http, then the direct one): that is the identity
/// named here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyAgentChoice {
    /// the agent without a proxy
    NoProxy,
    /// the agent of `httpProxy`
    HttpProxy,
    /// the agent of `httpsProxy`
    HttpsProxy,
}

/// The decision of `EnvHttpProxyAgent`.
pub struct EnvHttpProxyDecision {
    http: ProxyAgentChoice,
    https: ProxyAgentChoice,
    no_proxy: NoProxyMatcher,
    no_proxy_value: String,
}

fn truthy(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

impl EnvHttpProxyDecision {
    /// The constructor: `Err` where a proxy address it has to open is not a URL.
    pub fn new(opts: &EnvHttpProxyOptions, env: &ProxyEnv) -> Result<Self, ProxyAgentError> {
        let http_proxy = opts
            .http_proxy
            .as_deref()
            .or(env.http_proxy_lower.as_deref())
            .or(env.http_proxy_upper.as_deref());
        let http = if let Some(uri) = truthy(http_proxy) {
            open_proxy(uri)?;
            ProxyAgentChoice::HttpProxy
        } else {
            ProxyAgentChoice::NoProxy
        };
        let https_proxy = opts
            .https_proxy
            .as_deref()
            .or(env.https_proxy_lower.as_deref())
            .or(env.https_proxy_upper.as_deref());
        let https = if let Some(uri) = truthy(https_proxy) {
            open_proxy(uri)?;
            ProxyAgentChoice::HttpsProxy
        } else {
            http
        };
        let no_proxy_value = opts
            .no_proxy
            .as_deref()
            .or(env.no_proxy_lower.as_deref())
            .or(env.no_proxy_upper.as_deref())
            .unwrap_or("")
            .to_owned();
        Ok(EnvHttpProxyDecision {
            http,
            https,
            no_proxy: no_proxy_matcher(&no_proxy_value),
            no_proxy_value,
        })
    }

    /// `#shouldProxy`
    fn should_proxy(&self, url: &Url) -> bool {
        if self.no_proxy.is_empty() {
            return true; // Always proxy if NO_PROXY is not set or empty.
        }
        if self.no_proxy_value == "*" {
            return false; // Never proxy if wildcard is set.
        }
        !self.no_proxy.matches(url)
    }

    /// `#getProxyAgentForUrl(url)`
    pub fn agent_for(&self, url: &Url) -> ProxyAgentChoice {
        if !self.should_proxy(url) {
            return ProxyAgentChoice::NoProxy;
        }
        if url.scheme() == "https" {
            return self.https;
        }
        self.http
    }
}

/// What `createMainProcessProxyDispatcher` builds, as far as it is a decision.
pub struct MainProxy {
    decision: EnvHttpProxyDecision,
    exempt: NoProxyMatcher,
}

/// `createMainProcessProxyDispatcher(proxyUrl)`: `no_proxy_lower` and
/// `no_proxy_upper` are `process.env.no_proxy` and `process.env.NO_PROXY`.
/// `Err` where the proxy address is not a URL (the agent refuses it).
pub fn create_main_process_proxy_dispatcher(
    proxy_url: &str,
    no_proxy_lower: Option<&str>,
    no_proxy_upper: Option<&str>,
) -> Result<MainProxy, ProxyAgentError> {
    let no_proxy = merge_no_proxy(no_proxy_lower.or(no_proxy_upper));
    let opts = EnvHttpProxyOptions {
        http_proxy: Some(proxy_url.to_owned()),
        https_proxy: Some(proxy_url.to_owned()),
        no_proxy: Some(no_proxy.clone()),
    };
    // both options are given, so the environment is never read
    let decision = EnvHttpProxyDecision::new(&opts, &ProxyEnv::default())?;
    // both schemes go to the proxy, so only a NO_PROXY entry keeps a URL off it
    let exempt = no_proxy_matcher(&no_proxy);
    Ok(MainProxy { decision, exempt })
}

impl MainProxy {
    /// The routing the dispatcher declares: `(url) => !exempt(url)`.
    pub fn routes_via_proxy(&self, url: &Url) -> bool {
        !self.exempt.matches(url)
    }

    /// The dispatcher undici sends the request for `url` through.
    pub fn agent_for(&self, url: &Url) -> ProxyAgentChoice {
        self.decision.agent_for(url)
    }
}
