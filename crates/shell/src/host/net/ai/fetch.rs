//! `fetchRemoteImage(url)` and `readBodyCapped` for the AI channels: main-core's
//! guarded download (the SSRF gate, the retries, the cap) over the operating
//! system's resolver and reqwest. Blocking: the caller is on a worker, and a
//! request is driven with `tauri::async_runtime::block_on`.
//!
//! A hop to a host name connects to the addresses the gate validated (the
//! pinned lookup of the TypeScript's per-hop `Agent`), so the system proxy is
//! not used for it; a hop to an address literal goes through the shell's
//! shared client and its proxy.

use std::net::{SocketAddr, ToSocketAddrs};
use std::time::Duration;

use main_core::packages::electron_utils::remote_image::{
    MAX_REMOTE_IMAGE_BYTES, fetch_remote_image, read_body_capped,
};
use main_core::packages::electron_utils::safe_remote_url::{
    FetchError, FetchInit, Fetcher, GlobalDispatcher, LookupAddress, Resolver, Response,
    SafeRemoteTarget,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use shell_ipc_a::ai_core::RemoteImage;

use crate::host::net::http;

/// undici's connect and body timeouts
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const BODY_TIMEOUT: Duration = Duration::from_secs(300);

/// `dns.lookup(host, { all: true })`
struct SystemResolver;

impl Resolver for SystemResolver {
    fn lookup_all(&mut self, host: &str) -> Result<Vec<LookupAddress>, FetchError> {
        let found = (host, 0)
            .to_socket_addrs()
            .map_err(|e| FetchError(e.to_string()))?;
        Ok(found
            .map(|addr| LookupAddress {
                address: addr.ip().to_string(),
                family: if addr.is_ipv6() { 6.0 } else { 4.0 },
            })
            .collect())
    }
}

/// One client whose connection goes to the validated addresses of `url`'s host
fn pinned_client(url: &str, target: &SafeRemoteTarget) -> Result<reqwest::Client, FetchError> {
    let parsed = reqwest::Url::parse(url).map_err(|e| FetchError(e.to_string()))?;
    let port = parsed.port_or_known_default().unwrap_or(0);
    let addrs: Vec<SocketAddr> = target
        .addresses
        .iter()
        .filter_map(|a| a.address.parse().ok().map(|ip| SocketAddr::new(ip, port)))
        .collect();
    let host = parsed.host_str().unwrap_or(&target.hostname);
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(Duration::from_secs(60))
        .resolve_to_addrs(host, &addrs)
        .build()
        .map_err(|e| FetchError(e.to_string()))
}

fn header_map(headers: &[(String, String)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            map.insert(name, value);
        }
    }
    map
}

/// A hop's answer, its body not yet read
struct Download {
    status: u16,
    headers: HeaderMap,
    response: Option<reqwest::Response>,
}

impl Response for Download {
    fn status(&self) -> u16 {
        self.status
    }

    fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    }

    fn has_body(&self) -> bool {
        true
    }

    fn cancel_body(&mut self) {
        self.response = None;
    }

    fn read_chunk(&mut self) -> Result<Option<Vec<u8>>, FetchError> {
        let Some(response) = self.response.as_mut() else {
            return Ok(None);
        };
        tauri::async_runtime::block_on(response.chunk())
            .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
            .map_err(|e| FetchError(e.to_string()))
    }

    fn array_buffer(&mut self) -> Result<Vec<u8>, FetchError> {
        let Some(response) = self.response.take() else {
            return Ok(Vec::new());
        };
        tauri::async_runtime::block_on(response.bytes())
            .map(|bytes| bytes.to_vec())
            .map_err(|e| FetchError(e.to_string()))
    }
}

/// The transport of a hop: one `GET`, its redirect handed back
struct Hops;

impl Fetcher for Hops {
    /// No dispatcher of ours rides a proxy for a pinned hop
    fn global_dispatcher(&mut self) -> GlobalDispatcher {
        GlobalDispatcher::NotAnObject
    }

    fn fetch(&mut self, url: &str, init: &FetchInit<'_>) -> Result<Box<dyn Response>, FetchError> {
        let client = match init.pinned {
            Some(target) if !target.literal => pinned_client(url, target)?,
            _ => http::client(url, false),
        };
        let mut request = client.get(url).timeout(BODY_TIMEOUT);
        if let Some(headers) = init.headers {
            request = request.headers(header_map(headers));
        }
        let response = tauri::async_runtime::block_on(request.send())
            .map_err(|e| FetchError(e.to_string()))?;
        Ok(Box::new(Download {
            status: response.status().as_u16(),
            headers: response.headers().clone(),
            response: Some(response),
        }))
    }

    fn close_dispatcher(&mut self) {}

    fn sleep(&mut self, ms: f64) {
        std::thread::sleep(Duration::from_millis(ms as u64));
    }
}

/// `fetchRemoteImage(url)` then `readBodyCapped(resp, MAX_REMOTE_IMAGE_BYTES)`:
/// `None` for a refused address, a response that is not ok, a body over the
/// cap or a failure of any kind. `tmpdir` is `os.tmpdir()`.
pub fn remote_image(url: &str, tmpdir: &str) -> Option<RemoteImage> {
    let mut response = fetch_remote_image(&mut SystemResolver, &mut Hops, tmpdir, url, None)?;
    if !response.ok() {
        return None;
    }
    let content_type = response.header("content-type").unwrap_or_default();
    let bytes = read_body_capped(&mut *response, MAX_REMOTE_IMAGE_BYTES as f64).ok()?;
    Some(RemoteImage {
        bytes,
        content_type,
    })
}
