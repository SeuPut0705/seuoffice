//! `packages/electron-utils/src/safe-remote-url.ts`.
//!
//! The TypeScript is asynchronous and reaches the network through three
//! things the Electron side supplies here as traits: the resolver
//! (`dns.lookup(host, { all: true })`), the fetcher (`fetchImpl` or undici's
//! `fetch`, together with the global dispatcher and the per-hop pinned
//! `Agent`) and the abort signal. Each call is one blocking call; the order
//! of the calls is the order of the TypeScript's awaits.
//!
//! `node:net` (`isIP`, `BlockList`) is ported here as well: [`is_ip`] and
//! [`is_blocked_address`].

use std::net::Ipv6Addr;
use std::str::FromStr;
use std::sync::Arc;

use jscompat::{JsRegex, RegexLimit, TryJsRegex, js_regex, try_js_regex};
use url::Url;

// The IPv4 pattern of node:net (lib/internal/net.js)
const IPV4_PATTERN: &str = r"^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$";
// the IPv6 pattern of node:net (lib/internal/net.js), written out
const IPV6_PATTERN: &str = r"^(?:(?:(?:[0-9a-fA-F]{1,4}):){7}(?:(?:[0-9a-fA-F]{1,4})|:)|(?:(?:[0-9a-fA-F]{1,4}):){6}(?:(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])|:(?:[0-9a-fA-F]{1,4})|:)|(?:(?:[0-9a-fA-F]{1,4}):){5}(?::(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])|(?::(?:[0-9a-fA-F]{1,4})){1,2}|:)|(?:(?:[0-9a-fA-F]{1,4}):){4}(?:(?::(?:[0-9a-fA-F]{1,4})){0,1}:(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])|(?::(?:[0-9a-fA-F]{1,4})){1,3}|:)|(?:(?:[0-9a-fA-F]{1,4}):){3}(?:(?::(?:[0-9a-fA-F]{1,4})){0,2}:(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])|(?::(?:[0-9a-fA-F]{1,4})){1,4}|:)|(?:(?:[0-9a-fA-F]{1,4}):){2}(?:(?::(?:[0-9a-fA-F]{1,4})){0,3}:(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])|(?::(?:[0-9a-fA-F]{1,4})){1,5}|:)|(?:(?:[0-9a-fA-F]{1,4}):){1}(?:(?::(?:[0-9a-fA-F]{1,4})){0,4}:(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])|(?::(?:[0-9a-fA-F]{1,4})){1,6}|:)|(?::(?:(?::(?:[0-9a-fA-F]{1,4})){0,5}:(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])|(?::(?:[0-9a-fA-F]{1,4})){1,7}|:)))(?:%[0-9a-zA-Z-.:]{1,})?$";

fn ipv4_regex() -> &'static JsRegex {
    js_regex!(IPV4_PATTERN)
}

fn ipv6_regex() -> &'static TryJsRegex {
    try_js_regex!(IPV6_PATTERN)
}

/// `net.isIP(text)`: 4, 6 or 0. `Err` is a search of the IPv6 pattern that
/// stopped at the bound, which V8 never does; every caller here treats it as
/// unsafe.
pub fn is_ip(text: &str) -> Result<u8, RegexLimit> {
    Ok(if ipv4_regex().test(text) {
        4
    } else if ipv6_regex().try_test(text)? {
        6
    } else {
        0
    })
}

/// An address list of `net.BlockList`: subnets as (network, prefix bits).
const BLOCKED_V4: [([u8; 4], u32); 11] = [
    ([0, 0, 0, 0], 8),      // "this network"
    ([10, 0, 0, 0], 8),     // private
    ([100, 64, 0, 0], 10),  // carrier NAT
    ([127, 0, 0, 0], 8),    // loopback
    ([169, 254, 0, 0], 16), // link-local (cloud metadata)
    ([172, 16, 0, 0], 12),  // private
    ([192, 0, 0, 0], 24),   // IETF protocol assignments
    ([192, 168, 0, 0], 16), // private
    ([198, 18, 0, 0], 15),  // benchmarking
    ([224, 0, 0, 0], 4),    // multicast
    ([240, 0, 0, 0], 4),    // reserved + broadcast
];

const fn v6(head: [u8; 2], last: u8) -> [u8; 16] {
    let mut bytes = [0u8; 16];
    bytes[0] = head[0];
    bytes[1] = head[1];
    bytes[15] = last;
    bytes
}

const BLOCKED_V6: [([u8; 16], u32); 7] = [
    (v6([0, 0], 0), 128), // unspecified
    (v6([0, 0], 1), 128), // loopback
    (v6([0, 0], 0), 96),  // deprecated IPv4-compatible (::127.0.0.1)
    (
        [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        96,
    ), // NAT64
    (v6([0xfc, 0], 0), 7), // unique local
    (v6([0xfe, 0x80], 0), 10), // link-local
    (v6([0xff, 0], 0), 8), // multicast
];

const FAKE_IP_V4: ([u8; 4], u32) = ([198, 18, 0, 0], 15);

/// The first `bits` bits of `a` and `b` agree.
fn prefix_matches(a: &[u8], b: &[u8], bits: u32) -> bool {
    (0..bits as usize).all(|i| {
        let mask = 0x80u8 >> (i & 7);
        a[i >> 3] & mask == b[i >> 3] & mask
    })
}

fn parse_v4(text: &str) -> Option<[u8; 4]> {
    let mut out = [0u8; 4];
    let mut parts = text.split('.');
    for slot in out.iter_mut() {
        *slot = parts.next()?.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// The 16 bytes of an address `is_ip` accepted. A zone (`%eth0`) is ignored,
/// as libuv ignores an interface it does not know; an address the parser
/// refuses is none and, as in `BlockList.check`, matches no rule.
fn parse_v6(text: &str) -> Option<[u8; 16]> {
    let bare = text.split('%').next().unwrap_or(text);
    Ipv6Addr::from_str(bare).ok().map(|ip| ip.octets())
}

fn in_blocked_v4(address: &[u8; 4]) -> bool {
    BLOCKED_V4
        .iter()
        .any(|(network, bits)| prefix_matches(address, network, *bits))
}

fn in_blocked_v6(address: &[u8; 16]) -> bool {
    if BLOCKED_V6
        .iter()
        .any(|(network, bits)| prefix_matches(address, network, *bits))
    {
        return true;
    }
    // ::ffff:0:0/96 maps back onto the IPv4 rules
    let mapped =
        address[..10].iter().all(|b| *b == 0) && address[10] == 0xff && address[11] == 0xff;
    mapped && in_blocked_v4(&[address[12], address[13], address[14], address[15]])
}

/// True when `ip` is a fake-ip placeholder a VPN resolver handed out for a real hostname.
pub fn is_fake_ip_dns_artifact(ip: &str) -> bool {
    is_ip(ip) == Ok(4)
        && parse_v4(ip).is_some_and(|address| prefix_matches(&address, &FAKE_IP_V4.0, FAKE_IP_V4.1))
}

/// True when `ip` is a literal address outside the public ranges (non-addresses count as unsafe).
pub fn is_blocked_address(ip: &str) -> bool {
    match is_ip(ip) {
        Ok(0) | Err(_) => true,
        Ok(4) => parse_v4(ip).is_some_and(|address| in_blocked_v4(&address)),
        _ => parse_v6(ip).is_some_and(|address| in_blocked_v6(&address)),
    }
}

/// Hostname suffixes that never denote a public host.
const BLOCKED_HOST_SUFFIXES: [&str; 3] = [".localhost", ".local", ".internal"];

/// One resolved, validated connection target.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteTargetAddress {
    pub address: String,
    /// 4 or 6
    pub family: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SafeRemoteTarget {
    /// The URL the addresses were validated for (fetch this exact string).
    pub url: String,
    /// Normalized hostname (no brackets, no trailing dot) the addresses answer for.
    pub hostname: String,
    pub addresses: Vec<RemoteTargetAddress>,
    /// The URL carried an address literal; no resolution happened, nothing to pin.
    pub literal: bool,
}

fn normalize_host(hostname: &str) -> String {
    let stripped = js_regex!(r"^\[|\]$", "g").replace_all(hostname, |_| String::new());
    let lowered = stripped.to_lowercase();
    js_regex!(r"\.+$").replace_all(&lowered, |_| String::new())
}

/// What a thrown `Error` carries: its message.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchError(pub String);

/// One answer of `dns.lookup(host, { all: true })`.
#[derive(Debug, Clone, PartialEq)]
pub struct LookupAddress {
    pub address: String,
    pub family: f64,
}

/// `dns.lookup(host, { all: true })`; an `Err` is a rejected lookup.
pub trait Resolver {
    fn lookup_all(&mut self, host: &str) -> Result<Vec<LookupAddress>, FetchError>;
}

/// An `AbortSignal`: what the TypeScript reads is `signal.aborted`.
pub trait AbortSignal {
    fn aborted(&self) -> bool;
}

/// `lookupBeforeAbort`: the lookup, or none as soon as `signal` aborts. The
/// resolver call is blocking, so an abort raised while it runs is seen when it
/// returns; a lookup that rejects is none as well.
fn lookup_before_abort(
    resolver: &mut dyn Resolver,
    host: &str,
    signal: Option<&dyn AbortSignal>,
) -> Option<Vec<LookupAddress>> {
    let Some(signal) = signal else {
        return resolver.lookup_all(host).ok();
    };
    if signal.aborted() {
        return None;
    }
    let found = resolver.lookup_all(host);
    if signal.aborted() {
        return None;
    }
    found.ok()
}

/// Resolves and validates `raw`: http(s) only, a public literal, or a hostname
/// whose every resolved address is public. Literal addresses are checked
/// directly; the single allowance on the resolved side is an address in the
/// VPN fake-ip range (see [`is_fake_ip_dns_artifact`]). `raw` is `None` where
/// the TypeScript is given something that is not a string.
pub fn resolve_safe_remote_target(
    resolver: &mut dyn Resolver,
    raw: Option<&str>,
    signal: Option<&dyn AbortSignal>,
) -> Option<SafeRemoteTarget> {
    let raw = raw?;
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    // URL keeps IPv6 literals bracketed; isIP does not accept the brackets.
    // Strip a trailing dot: DNS treats "localhost." as "localhost", so the
    // hostname gate must too.
    let host = normalize_host(url.host_str().unwrap_or(""));
    if host.is_empty() {
        return None;
    }
    let literal_family = is_ip(&host).ok()?;
    if literal_family != 0 {
        if is_blocked_address(&host) {
            return None;
        }
        return Some(SafeRemoteTarget {
            url: url.to_string(),
            hostname: host.clone(),
            literal: true,
            addresses: vec![RemoteTargetAddress {
                address: host,
                family: if literal_family == 4 { 4 } else { 6 },
            }],
        });
    }
    if host == "localhost" || BLOCKED_HOST_SUFFIXES.iter().any(|s| host.ends_with(s)) {
        return None;
    }
    let addrs = lookup_before_abort(resolver, &host, signal)?;
    if addrs.is_empty()
        || !addrs
            .iter()
            .all(|a| !is_blocked_address(&a.address) || is_fake_ip_dns_artifact(&a.address))
    {
        return None;
    }
    Some(SafeRemoteTarget {
        url: url.to_string(),
        hostname: host,
        literal: false,
        addresses: addrs
            .iter()
            .map(|a| RemoteTargetAddress {
                address: a.address.clone(),
                family: if a.family == 6.0 { 6 } else { 4 },
            })
            .collect(),
    })
}

/// True when the URL is http(s) and its host is public (see
/// [`resolve_safe_remote_target`] for the exact rules).
pub fn is_safe_remote_url(
    resolver: &mut dyn Resolver,
    raw: Option<&str>,
    signal: Option<&dyn AbortSignal>,
) -> bool {
    resolve_safe_remote_target(resolver, raw, signal).is_some()
}

/// The options a connect-time `lookup` is called with.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LookupOptions {
    /// `options.all` (truthy)
    pub all: bool,
    /// `options.family`, `None` for undefined
    pub family: Option<f64>,
}

/// What the callback of a pinned lookup receives.
#[derive(Debug, Clone, PartialEq)]
pub enum PinnedAnswer {
    /// `callback(err, '')`
    Error { code: &'static str, message: String },
    /// `callback(null, addresses)`
    All(Vec<RemoteTargetAddress>),
    /// `callback(null, address, family)`
    One { address: String, family: u8 },
}

/// A connect-time `lookup` that ignores the OS resolver and answers with the
/// addresses the gate validated for this hostname: the binding half of the
/// guard. Any other hostname fails closed.
pub fn pinned_lookup(
    target: &SafeRemoteTarget,
) -> impl Fn(&str, &LookupOptions) -> PinnedAnswer + '_ {
    move |hostname, options| {
        if normalize_host(hostname) != target.hostname {
            return PinnedAnswer::Error {
                code: "ESSRFHOST",
                message: format!("ssrf guard: refusing to connect to unvalidated host {hostname}"),
            };
        }
        // net.connect only passes all:true on the happy-eyeballs path; the
        // single-address path expects (err, address, family)
        if options.all {
            return PinnedAnswer::All(target.addresses.clone());
        }
        let pick = options
            .family
            .and_then(|family| {
                target
                    .addresses
                    .iter()
                    .find(|a| f64::from(a.family) == family)
            })
            .or_else(|| target.addresses.first());
        match pick {
            Some(pick) => PinnedAnswer::One {
                address: pick.address.clone(),
                family: pick.family,
            },
            // unreachable from resolve_safe_remote_target, but a pinned lookup
            // must never answer "connect anywhere" instead
            None => PinnedAnswer::Error {
                code: "ESSRFHOST",
                message: "ssrf guard: no validated address to pin".to_owned(),
            },
        }
    }
}

/// A `Response` as the guard and its callers read it.
pub trait Response {
    fn status(&self) -> u16;
    /// `resp.ok`
    fn ok(&self) -> bool {
        (200..=299).contains(&self.status())
    }
    /// `resp.headers.get(name)`
    fn header(&self, name: &str) -> Option<String>;
    /// `resp.body !== null`
    fn has_body(&self) -> bool;
    /// `resp.body?.cancel()` (or the reader's `cancel()`); a refused cancel is
    /// swallowed by every caller, so it is not reported
    fn cancel_body(&mut self);
    /// `reader.read()` of the body's reader: the next chunk, `None` when done
    fn read_chunk(&mut self) -> Result<Option<Vec<u8>>, FetchError>;
    /// `await resp.arrayBuffer()`
    fn array_buffer(&mut self) -> Result<Vec<u8>, FetchError>;
}

/// For one request URL: does the dispatcher hand it to a forward proxy?
/// Shared and `Send + Sync`, so a fetcher that keeps its dispatcher can move to
/// a worker thread.
pub type ProxyRouting = Arc<dyn Fn(&Url) -> bool + Send + Sync>;

/// The global dispatcher as `hopRidesProxy` finds it.
#[derive(Clone)]
pub enum GlobalDispatcher {
    /// `null` or not an object
    NotAnObject,
    /// an object that declared its routing (`declareProxyRouting`)
    Declared(ProxyRouting),
    /// an object that declared none: the descriptions of its own symbols
    /// (`None` for a symbol without one)
    Plain(Vec<Option<String>>),
}

// a fetcher holding its dispatcher moves to a worker thread only if this does
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<GlobalDispatcher>();
};

/// Own symbols that only undici's ProxyAgent carries.
const PROXY_DISPATCHER_SYMBOLS: [&str; 5] = [
    "proxy agent options",
    "proxy client",
    "proxy agent",
    "proxy headers",
    "tunnel proxy",
];

/// True when the global dispatcher will send the request for `url` to a forward proxy.
pub fn hop_rides_proxy(dispatcher: &GlobalDispatcher, url: &str) -> bool {
    match dispatcher {
        GlobalDispatcher::NotAnObject => false,
        GlobalDispatcher::Declared(routing) => match Url::parse(url) {
            Ok(parsed) => routing(&parsed),
            // `new URL(url)` throws in the TypeScript; the URL is one the gate
            // has just serialized, so it parses
            Err(_) => false,
        },
        GlobalDispatcher::Plain(symbols) => symbols
            .iter()
            .any(|s| PROXY_DISPATCHER_SYMBOLS.contains(&s.as_deref().unwrap_or(""))),
    }
}

/// What a hop's request carries besides its URL (the `init` of `fetch`).
pub struct FetchInit<'a> {
    /// `headers`, absent rather than empty when none
    pub headers: Option<&'a [(String, String)]>,
    /// a signal rides along
    pub signal: bool,
    /// the per-hop `Agent` whose `lookup` hands back exactly these addresses
    /// (`new undici.Agent({ connect: { lookup: pinnedLookup(target) } })`);
    /// `redirect: 'manual'` goes with every hop
    pub pinned: Option<&'a SafeRemoteTarget>,
}

/// The transport of a hop: `fetchImpl`, or undici's `fetch`.
pub trait Fetcher {
    /// `undici.getGlobalDispatcher()`
    fn global_dispatcher(&mut self) -> GlobalDispatcher;
    /// The request of one hop. An `Err` is a thrown error.
    fn fetch(&mut self, url: &str, init: &FetchInit<'_>) -> Result<Box<dyn Response>, FetchError>;
    /// `dispatcher.close()` of the hop's pinned agent: graceful, in-flight
    /// bodies keep streaming, only new dispatches are refused
    fn close_dispatcher(&mut self);
    /// `await new Promise((r) => setTimeout(r, ms))`
    fn sleep(&mut self, ms: f64);
}

type HeaderList = Vec<(String, String)>;

/// Supplies the headers for one hop from its URL and hop index.
pub type HopHeaders<'a> = dyn FnMut(&str, usize) -> Option<HeaderList> + 'a;

#[derive(Default)]
pub struct FetchWithSsrfGuardOptions<'a> {
    /// Redirect hops to follow; `None` is the default 5.
    pub max_redirects: Option<f64>,
    /// `redirect === 'manual'`: one hop only, the answer handed back as it
    /// came, a redirect included
    pub manual: bool,
    pub headers: Option<HeaderList>,
    /// Headers for one hop, replacing `headers` for that hop.
    pub headers_for_hop: Option<&'a mut HopHeaders<'a>>,
    /// Aborts the in-flight request and every later hop of the chain.
    pub signal: Option<&'a dyn AbortSignal>,
}

fn aborted(signal: Option<&dyn AbortSignal>) -> bool {
    signal.is_some_and(|s| s.aborted())
}

/// fetch() that validates the target before every hop and binds the connection
/// to the validated addresses, following redirects manually. `Ok(None)` when
/// any hop fails validation, a redirect lacks a usable Location, the hop
/// budget is exhausted, or the caller aborts; `Err` where the transport threw.
pub fn fetch_with_ssrf_guard(
    resolver: &mut dyn Resolver,
    fetcher: &mut dyn Fetcher,
    raw_url: &str,
    options: &mut FetchWithSsrfGuardOptions<'_>,
) -> Result<Option<Box<dyn Response>>, FetchError> {
    let max_redirects = options.max_redirects.unwrap_or(5.0);
    let signal = options.signal;
    // maxRedirects arrives from callers: an Infinity value would follow
    // redirects forever, so normalize to 0..10.
    let hop_budget = if max_redirects.is_finite() {
        jscompat::math_min(jscompat::math_max(max_redirects.floor(), 0.0), 10.0) as usize
    } else {
        5
    };
    let mut current = raw_url.to_owned();
    for hop in 0..=hop_budget {
        // Stop between hops too: an aborted chain must not start another request.
        if aborted(signal) {
            return Ok(None);
        }
        let Some(target) = resolve_safe_remote_target(resolver, Some(&current), signal) else {
            return Ok(None);
        };
        if aborted(signal) {
            return Ok(None);
        }
        let hop_headers = match options.headers_for_hop.as_mut() {
            Some(for_hop) => for_hop(&current, hop),
            None => None,
        }
        .or_else(|| options.headers.clone());
        let pinned =
            if !target.literal && !hop_rides_proxy(&fetcher.global_dispatcher(), &target.url) {
                Some(&target)
            } else {
                None
            };
        let init = FetchInit {
            headers: hop_headers.as_deref(),
            signal: signal.is_some(),
            pinned,
        };
        let answer = fetcher.fetch(&current, &init);
        let next = match answer {
            Ok(mut resp) => {
                if options.manual || resp.status() < 300 || resp.status() >= 400 {
                    if pinned.is_some() {
                        fetcher.close_dispatcher();
                    }
                    return Ok(Some(resp));
                }
                match resp.header("location").filter(|l| !l.is_empty()) {
                    None => {
                        if pinned.is_some() {
                            fetcher.close_dispatcher();
                        }
                        return Ok(None);
                    }
                    Some(location) => {
                        // The redirect hop's body is never read; cancel it so the
                        // socket returns to its pool now
                        resp.cancel_body();
                        match Url::parse(&current).and_then(|base| base.join(&location)) {
                            Ok(joined) => Ok(joined.to_string()),
                            Err(_) => Err(None),
                        }
                    }
                }
            }
            // An abort is cancellation, not a network failure to hand back.
            Err(error) => Err(if aborted(signal) { None } else { Some(error) }),
        };
        if pinned.is_some() {
            fetcher.close_dispatcher();
        }
        match next {
            Ok(url) => current = url,
            Err(None) => return Ok(None),
            Err(Some(error)) => return Err(error),
        }
    }
    Ok(None)
}
