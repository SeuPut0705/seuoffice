//! The fake network under `main-core`'s SSRF guard, answering from the case's
//! `hosts.d1.mindmap`:
//!
//! - `dns`: `{"<host>": [{address, family}]}`; a host not listed fails to resolve
//! - `network`: `{"<url>": {status?, headers?, body?, throws?}}`, `body` a
//!   string or a list of chunks; a URL not listed fails to connect
//! - `proxy`: true when the global dispatcher is a forward proxy's
//!
//! Each call is one log line: `["dns.lookup", host]`, `["undici.fetch", url,
//! {headers?, signal, pinned}]`, `["undici.agent.close"]`. `pinned` is what the
//! hop's per-hop agent answers a connect-time lookup with.

use std::collections::VecDeque;
use std::sync::Arc;

use main_core::packages::electron_utils::safe_remote_url::{
    FetchError, FetchInit, Fetcher, GlobalDispatcher, LookupAddress, LookupOptions, PinnedAnswer,
    Resolver, Response, pinned_lookup,
};
use serde_json::{Map, Value, json};

use super::hosts::ProbeLog;

pub struct Net {
    dns: Value,
    network: Value,
    proxy: bool,
    log: Option<ProbeLog>,
}

impl Net {
    pub fn new(script: &Value, log: Option<ProbeLog>) -> Net {
        Net {
            dns: script.get("dns").cloned().unwrap_or(Value::Null),
            network: script.get("network").cloned().unwrap_or(Value::Null),
            proxy: script
                .get("proxy")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            log,
        }
    }

    fn note(&self, line: Value) {
        if let Some(log) = &self.log {
            log.lock().unwrap().push(line);
        }
    }
}

pub struct FakeResolver(pub std::sync::Arc<Net>);

impl Resolver for FakeResolver {
    fn lookup_all(&mut self, host: &str) -> Result<Vec<LookupAddress>, FetchError> {
        self.0.note(json!(["dns.lookup", host]));
        let Some(found) = self.0.dns.get(host).and_then(Value::as_array) else {
            return Err(FetchError(format!("getaddrinfo ENOTFOUND {host}")));
        };
        Ok(found
            .iter()
            .map(|entry| LookupAddress {
                address: entry
                    .get("address")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                family: entry.get("family").and_then(Value::as_f64).unwrap_or(4.0),
            })
            .collect())
    }
}

pub struct FakeFetcher(pub std::sync::Arc<Net>);

/// A scripted answer: the body is handed out chunk by chunk
struct Scripted {
    status: u16,
    headers: Vec<(String, String)>,
    chunks: VecDeque<Vec<u8>>,
}

impl Response for Scripted {
    fn status(&self) -> u16 {
        self.status
    }

    fn header(&self, name: &str) -> Option<String> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(key, _)| key.to_ascii_lowercase() == name)
            .map(|(_, value)| value.clone())
    }

    fn has_body(&self) -> bool {
        true
    }

    fn cancel_body(&mut self) {
        self.chunks.clear();
    }

    fn read_chunk(&mut self) -> Result<Option<Vec<u8>>, FetchError> {
        Ok(self.chunks.pop_front())
    }

    fn array_buffer(&mut self) -> Result<Vec<u8>, FetchError> {
        Ok(self.chunks.drain(..).flatten().collect())
    }
}

impl Fetcher for FakeFetcher {
    fn global_dispatcher(&mut self) -> GlobalDispatcher {
        if self.0.proxy {
            GlobalDispatcher::Plain(vec![Some("proxy agent".to_owned())])
        } else {
            GlobalDispatcher::Declared(Arc::new(|_| false))
        }
    }

    fn fetch(&mut self, url: &str, init: &FetchInit<'_>) -> Result<Box<dyn Response>, FetchError> {
        let mut shown = Map::new();
        if let Some(headers) = init.headers {
            let mut object = Map::new();
            for (name, value) in headers {
                object.insert(name.clone(), Value::String(value.clone()));
            }
            shown.insert("headers".into(), Value::Object(object));
        }
        shown.insert("signal".into(), Value::Bool(init.signal));
        let pinned = match init.pinned {
            Some(target) => {
                let answer = pinned_lookup(target)(
                    &target.hostname,
                    &LookupOptions {
                        all: true,
                        family: None,
                    },
                );
                match answer {
                    PinnedAnswer::All(addresses) => Value::Array(
                        addresses
                            .iter()
                            .map(|a| json!({"address": a.address, "family": a.family}))
                            .collect(),
                    ),
                    _ => Value::Null,
                }
            }
            None => Value::Null,
        };
        shown.insert("pinned".into(), pinned);
        self.0
            .note(json!(["undici.fetch", url, Value::Object(shown)]));

        let Some(page) = self.0.network.get(url) else {
            return Err(FetchError("fetch failed".into()));
        };
        if let Some(message) = page.get("throws").and_then(Value::as_str) {
            return Err(FetchError(message.to_owned()));
        }
        let headers = page
            .get("headers")
            .and_then(Value::as_object)
            .map(|object| {
                object
                    .iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
                    .collect()
            })
            .unwrap_or_default();
        let chunks = match page.get("body") {
            Some(Value::String(body)) => VecDeque::from([body.clone().into_bytes()]),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| item.as_str().unwrap_or_default().as_bytes().to_vec())
                .collect(),
            _ => VecDeque::new(),
        };
        Ok(Box::new(Scripted {
            status: page.get("status").and_then(Value::as_u64).unwrap_or(200) as u16,
            headers,
            chunks,
        }))
    }

    fn close_dispatcher(&mut self) {
        self.0.note(json!(["undici.agent.close"]));
    }

    fn sleep(&mut self, _ms: f64) {}
}
