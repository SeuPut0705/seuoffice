//! The functions of group `b2-remote` (tools/main-diff/groups/b2-remote.ts).
//!
//! The network is never touched: the resolver, the fetcher, the abort signal
//! and the Electron objects are fakes built from the JSON the case carries
//! (see the header of the harness file for the shape of the "world"). Each
//! fake writes the log lines the TypeScript fakes write.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::Arc;

use jscompat::{JsObject, js_regex};
use serde_json::{Map, Value};
use url::Url;

use super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::electron_utils::fetch_image_bytes::fetch_image_bytes;
use crate::packages::electron_utils::generated_images::{
    GeneratedImage, MAX_GENERATED_IMAGE_BYTES, file_url_to_path, generated_image_dir,
    path_to_file_url, read_generated_image, store_generated_image,
};
use crate::packages::electron_utils::main_proxy::{
    EnvHttpProxyDecision, EnvHttpProxyOptions, ProxyAgentChoice, ProxyEnv,
    create_main_process_proxy_dispatcher, merge_no_proxy,
};
use crate::packages::electron_utils::navigation_guard::{
    ContentsCreatedListener, GuardedApp, GuardedContents, WillNavigateEvent, WillNavigateListener,
    WindowOpenAction, WindowOpenHandler, install_navigation_guard,
};
use crate::packages::electron_utils::permission_guard::{
    AppPages, AskingContents, CheckDetails, FrameId, GuardedSession, PermissionApp, PermissionAsk,
    PermissionCheckHandler, PermissionPolicy, PermissionRequestHandler, ReadyListener,
    RequestDetails, SessionCreatedListener, TornDown, app_page_of, install_permission_guard,
    permission_allowed, permission_check_handler, permission_request_handler,
};
use crate::packages::electron_utils::remote_image::{
    MAX_REMOTE_IMAGE_BYTES, ResponseTooLargeError, fetch_remote_image, read_body_capped,
    remote_image_headers,
};
use crate::packages::electron_utils::remote_table::{
    MAX_REMOTE_TABLE_BYTES, MAX_REMOTE_TABLE_CELL_CHARS, MAX_REMOTE_TABLE_COLUMNS,
    MAX_REMOTE_TABLE_ROWS, REMOTE_TABLE_TIMEOUT_MS, detect_delimiter, fetch_remote_table,
    parse_delimited_row, parse_delimited_table, parse_html_table,
};
use crate::packages::electron_utils::renderer_scheme::{
    MAX_RENDERER_QUERY_CHARS, MAX_RENDERER_QUERY_ENTRIES, RENDERER_SCHEME,
    docx_media_scheme_privilege, renderer_scheme_privilege, renderer_url, resolve_renderer_file,
    slide_media_scheme_privilege,
};
use crate::packages::electron_utils::safe_external_url::{
    SafeExternalUrlOptions, safe_external_url,
};
use crate::packages::electron_utils::safe_remote_url::{
    AbortSignal, FetchError, FetchInit, FetchWithSsrfGuardOptions, Fetcher, GlobalDispatcher,
    LookupAddress, LookupOptions, PinnedAnswer, RemoteTargetAddress, Resolver, Response,
    SafeRemoteTarget, fetch_with_ssrf_guard, is_blocked_address, is_fake_ip_dns_artifact, is_ip,
    is_safe_remote_url, pinned_lookup, resolve_safe_remote_target,
};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "safe-remote-url.isFakeIpDnsArtifact" => {
            str_arg(args, 0).map(|ip| Some(Value::Bool(is_fake_ip_dns_artifact(ip))))
        }
        "safe-remote-url.isBlockedAddress" => {
            str_arg(args, 0).map(|ip| Some(Value::Bool(is_blocked_address(ip))))
        }
        "safe-remote-url.isIP" => str_arg(args, 0).map(|ip| Some(Value::from(is_ip(ip)))),
        "safe-remote-url.resolveSafeRemoteTarget" => resolve_target_call(args, cx),
        "safe-remote-url.isSafeRemoteUrl" => is_safe_call(args, cx),
        "safe-remote-url.pinnedLookup" => pinned_lookup_call(args),
        "safe-remote-url.fetchWithSsrfGuard" => guard_call(args, cx),
        "remote-image.MAX_REMOTE_IMAGE_BYTES" => Ok(Some(Value::from(MAX_REMOTE_IMAGE_BYTES))),
        "remote-image.ResponseTooLargeError" => too_large_call(args),
        "remote-image.readBodyCapped" => read_body_call(args, cx),
        "remote-image.remoteImageHeaders" => Ok(Some(object(
            remote_image_headers()
                .into_iter()
                .map(|(k, v)| (k, Value::String(v))),
        ))),
        "remote-image.fetchRemoteImage" => fetch_image_call(args, cx),
        "fetch-image-bytes.fetchImageBytes" => image_bytes_call(args, cx),
        "generated-images.GENERATED_IMAGE_DIR" => {
            str_arg(args, 0).map(|tmpdir| Some(Value::from(generated_image_dir(tmpdir))))
        }
        "generated-images.MAX_GENERATED_IMAGE_BYTES" => {
            Ok(Some(Value::from(MAX_GENERATED_IMAGE_BYTES)))
        }
        "generated-images.storeGeneratedImage" => store_call(args, cx),
        "generated-images.readGeneratedImage" => read_image_call(args),
        "remote-table.MAX_REMOTE_TABLE_BYTES" => Ok(Some(Value::from(MAX_REMOTE_TABLE_BYTES))),
        "remote-table.MAX_REMOTE_TABLE_ROWS" => Ok(Some(Value::from(MAX_REMOTE_TABLE_ROWS))),
        "remote-table.MAX_REMOTE_TABLE_COLUMNS" => Ok(Some(Value::from(MAX_REMOTE_TABLE_COLUMNS))),
        "remote-table.MAX_REMOTE_TABLE_CELL_CHARS" => {
            Ok(Some(Value::from(MAX_REMOTE_TABLE_CELL_CHARS)))
        }
        "remote-table.REMOTE_TABLE_TIMEOUT_MS" => Ok(Some(Value::from(REMOTE_TABLE_TIMEOUT_MS))),
        "remote-table.parseHtmlTable" => {
            str_arg(args, 0).map(|html| Some(table_value(parse_html_table(html))))
        }
        "remote-table.detectDelimiter" => {
            str_arg(args, 0).map(|text| Some(Value::from(detect_delimiter(text).to_string())))
        }
        "remote-table.parseDelimitedRow" => str_arg(args, 0).and_then(|line| {
            let delimiter = str_arg(args, 1)?;
            Ok(Some(Value::Array(
                parse_delimited_row(line, delimiter)
                    .into_iter()
                    .map(Value::from)
                    .collect(),
            )))
        }),
        "remote-table.parseDelimitedTable" => str_arg(args, 0).map(|text| {
            let delimiter = arg(args, 1).and_then(Value::as_str);
            Some(table_value(parse_delimited_table(text, delimiter)))
        }),
        "remote-table.fetchRemoteTable" => fetch_table_call(args, cx),
        "main-proxy.mergeNoProxy" => {
            let user = arg(args, 0).and_then(Value::as_str);
            Ok(Some(Value::from(merge_no_proxy(user))))
        }
        "main-proxy.createMainProcessProxyDispatcher" => main_proxy_call(args),
        "main-proxy.EnvHttpProxyAgent" => env_agent_call(args),
        "safe-external-url.safeExternalUrl" => safe_external_call(args),
        "navigation-guard.installNavigationGuard" => navigation_call(args, cx),
        "renderer-scheme.RENDERER_SCHEME" => Ok(Some(Value::from(RENDERER_SCHEME))),
        "renderer-scheme.RENDERER_SCHEME_PRIVILEGE" => {
            Ok(Some(to_value(&renderer_scheme_privilege())))
        }
        "renderer-scheme.DOCX_MEDIA_SCHEME_PRIVILEGE" => {
            Ok(Some(to_value(&docx_media_scheme_privilege())))
        }
        "renderer-scheme.SLIDE_MEDIA_SCHEME_PRIVILEGE" => {
            Ok(Some(to_value(&slide_media_scheme_privilege())))
        }
        "renderer-scheme.MAX_RENDERER_QUERY_ENTRIES" => {
            Ok(Some(Value::from(MAX_RENDERER_QUERY_ENTRIES)))
        }
        "renderer-scheme.MAX_RENDERER_QUERY_CHARS" => {
            Ok(Some(Value::from(MAX_RENDERER_QUERY_CHARS)))
        }
        "renderer-scheme.rendererUrl" => renderer_url_call(args),
        "renderer-scheme.resolveRendererFile" => resolve_file_call(args),
        "permission-guard.appPageOf" => app_page_call(args),
        "permission-guard.permissionAllowed" => allowed_call(args, cx),
        "permission-guard.permissionRequestHandler" => request_handler_call(args, cx),
        "permission-guard.permissionCheckHandler" => check_handler_call(args, cx),
        "permission-guard.installPermissionGuard" => install_guard_call(args, cx),
        _ => return None,
    })
}

// ------------------------------------------------------------------ helpers

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a value prints")
}

fn object(entries: impl IntoIterator<Item = (String, Value)>) -> Value {
    Value::Object(entries.into_iter().collect::<Map<String, Value>>())
}

fn obj(entries: &[(&str, Value)]) -> Value {
    object(entries.iter().map(|(k, v)| ((*k).to_owned(), v.clone())))
}

fn table_value<T: serde::Serialize>(table: Option<T>) -> Value {
    match table {
        Some(table) => to_value(&table),
        None => Value::Null,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .chunks(2)
        .filter_map(|pair| std::str::from_utf8(pair).ok())
        .filter_map(|pair| u8::from_str_radix(pair, 16).ok())
        .collect()
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|v| !v.is_null())
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    field(value, key).and_then(Value::as_str).map(str::to_owned)
}

/// `a ?? undefined` for a number the spec may write as a string
fn number_field(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::String(s)) => match s.as_str() {
            "NaN" => Some(f64::NAN),
            "Infinity" => Some(f64::INFINITY),
            "-Infinity" => Some(f64::NEG_INFINITY),
            _ => None,
        },
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    }
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// A JSON object as `Object.entries` gives it: keys that are array indices
/// first, ascending, the rest as they were set.
fn js_entries<V: serde::de::DeserializeOwned + Clone>(value: Option<&Value>) -> Vec<(String, V)> {
    let Some(value) = value.filter(|v| v.is_object()) else {
        return Vec::new();
    };
    let Ok(object) = serde_json::from_value::<JsObject<V>>(value.clone()) else {
        return Vec::new();
    };
    object
        .entries()
        .into_iter()
        .map(|(key, v)| (key.to_owned(), v.clone()))
        .collect()
}

type Sink = Rc<RefCell<Vec<Vec<Value>>>>;

fn log(sink: &Sink, line: Vec<Value>) {
    sink.borrow_mut().push(line);
}

fn flush(sink: &Sink, cx: &mut Context) {
    cx.logs.extend(sink.borrow_mut().drain(..));
}

fn plain(message: impl Into<String>) -> CallError {
    CallError::plain(message)
}

// ------------------------------------------------------------------- world

#[derive(Clone)]
struct RespSpec {
    status: u16,
    headers: Vec<(String, String)>,
    chunks: Vec<Vec<u8>>,
    no_body: bool,
    stream_error: Option<String>,
}

#[derive(Clone)]
enum Route {
    Throw,
    AbortThrow,
    Resp(RespSpec),
}

fn parse_resp(value: &Value) -> RespSpec {
    RespSpec {
        status: value.get("status").and_then(Value::as_u64).unwrap_or(200) as u16,
        headers: value
            .get("headers")
            .and_then(Value::as_object)
            .map(|h| {
                h.iter()
                    .map(|(k, v)| {
                        (
                            k.to_ascii_lowercase(),
                            v.as_str()
                                .unwrap_or("")
                                .trim_matches([' ', '\t'])
                                .to_owned(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
        chunks: string_list(value.get("chunks"))
            .iter()
            .map(|chunk| match chunk.strip_prefix("hex:") {
                Some(rest) => unhex(rest),
                None => chunk.as_bytes().to_vec(),
            })
            .collect(),
        no_body: value.get("noBody").and_then(Value::as_bool) == Some(true),
        stream_error: value
            .get("streamError")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

fn parse_route(value: &Value) -> Route {
    match value.as_str() {
        Some("throw") => Route::Throw,
        Some("abort-throw") => Route::AbortThrow,
        _ => Route::Resp(parse_resp(value)),
    }
}

enum Dns {
    Reject,
    Abort,
    Addresses(Vec<LookupAddress>),
}

struct Seed {
    text: Option<String>,
    hex: Option<String>,
    dir: bool,
    mtime_ms: Option<f64>,
}

#[derive(Clone, Copy, PartialEq)]
enum SignalKind {
    None,
    Live,
    Aborted,
}

struct World {
    tmpdir: String,
    seeds: Vec<(String, Seed)>,
    dns: HashMap<String, Dns>,
    routes: HashMap<String, Vec<Route>>,
    signal: SignalKind,
    dispatcher: GlobalDispatcher,
    mock: bool,
}

fn parse_world(value: Option<&Value>) -> Result<World, CallError> {
    let value = value.ok_or_else(|| plain("the world is missing"))?;
    let tmpdir = string_field(value, "tmpdir").ok_or_else(|| plain("the world has no tmpdir"))?;
    let mut seeds = Vec::new();
    if let Some(map) = field(value, "seeds").and_then(Value::as_object) {
        for (name, spec) in map {
            seeds.push((
                name.clone(),
                Seed {
                    text: string_field(spec, "text"),
                    hex: string_field(spec, "hex"),
                    dir: spec.get("dir").and_then(Value::as_bool) == Some(true),
                    mtime_ms: spec.get("mtimeMs").and_then(Value::as_f64),
                },
            ));
        }
    }
    let mut dns = HashMap::new();
    if let Some(map) = field(value, "dns").and_then(Value::as_object) {
        for (host, answer) in map {
            let parsed = match answer {
                Value::String(s) if s == "abort" => Dns::Abort,
                Value::String(_) => Dns::Reject,
                Value::Array(list) => Dns::Addresses(
                    list.iter()
                        .map(|a| LookupAddress {
                            address: a["address"].as_str().unwrap_or("").to_owned(),
                            family: a["family"].as_f64().unwrap_or(0.0),
                        })
                        .collect(),
                ),
                _ => Dns::Reject,
            };
            dns.insert(host.clone(), parsed);
        }
    }
    let mut routes = HashMap::new();
    if let Some(map) = field(value, "routes").and_then(Value::as_object) {
        for (url, entry) in map {
            let list = match entry {
                Value::Array(items) => items.iter().map(parse_route).collect(),
                other => vec![parse_route(other)],
            };
            routes.insert(url.clone(), list);
        }
    }
    let signal = match value.get("signal").and_then(Value::as_str) {
        Some("live") => SignalKind::Live,
        Some("aborted") => SignalKind::Aborted,
        _ => SignalKind::None,
    };
    let mock = value.get("mock").and_then(Value::as_bool) == Some(true);
    let dispatcher = if mock {
        GlobalDispatcher::Declared(Arc::new(|_: &Url| true))
    } else {
        match value.get("dispatcher") {
            Some(Value::Object(d)) if d.contains_key("proxyHosts") => {
                let hosts = string_list(d.get("proxyHosts"));
                GlobalDispatcher::Declared(Arc::new(move |url: &Url| {
                    hosts.iter().any(|h| Some(h.as_str()) == url.host_str())
                }))
            }
            Some(Value::Object(d)) if d.contains_key("symbols") => GlobalDispatcher::Plain(
                string_list(d.get("symbols"))
                    .into_iter()
                    .map(Some)
                    .collect(),
            ),
            _ => GlobalDispatcher::Plain(Vec::new()),
        }
    };
    Ok(World {
        tmpdir,
        seeds,
        dns,
        routes,
        signal,
        dispatcher,
        mock,
    })
}

/// the seeds of a world in the generated-image folder; removed when it goes
struct Seeded {
    dir: String,
    names: Vec<String>,
    extra: Vec<String>,
}

impl Seeded {
    fn new(world: &World) -> Seeded {
        let dir = generated_image_dir(&world.tmpdir);
        let mut names = Vec::new();
        if !world.seeds.is_empty() {
            let _ = std::fs::create_dir_all(&dir);
        }
        for (name, seed) in &world.seeds {
            let path = format!("{dir}/{name}");
            if seed.dir {
                let _ = std::fs::create_dir_all(&path);
            } else {
                let bytes = match &seed.hex {
                    Some(h) => unhex(h),
                    None => seed.text.clone().unwrap_or_default().into_bytes(),
                };
                let _ = std::fs::write(&path, bytes);
            }
            if let Some(ms) = seed.mtime_ms {
                set_mtime(&path, ms);
            }
            names.push(name.clone());
        }
        Seeded {
            dir,
            names,
            extra: Vec::new(),
        }
    }
}

impl Drop for Seeded {
    fn drop(&mut self) {
        for name in self.names.iter().chain(self.extra.iter()) {
            let path = format!("{}/{}", self.dir, name);
            let _ = std::fs::remove_dir_all(&path);
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// `utimesSync(path, ms / 1000, ms / 1000)`: libuv turns the seconds into a
/// `timespec` as a double
fn set_mtime(path: &str, ms: f64) {
    let seconds = ms / 1000.0;
    let whole = seconds.floor();
    let nanos = ((seconds - whole) * 1e9) as u32;
    let time = std::time::UNIX_EPOCH + std::time::Duration::new(whole as u64, nanos);
    if let Ok(file) = std::fs::File::options().write(true).open(path) {
        let _ = file.set_modified(time);
    } else if let Ok(file) = std::fs::File::open(path) {
        let _ = file.set_modified(time);
    }
}

/// `$GEN` in an address is the `file:` URL of the generated-image folder
fn with_gen(tmpdir: &str, text: &str) -> String {
    let url = path_to_file_url(&generated_image_dir(tmpdir)).to_string();
    let base = url.strip_suffix('/').unwrap_or(&url);
    text.replace("$GEN", base)
}

// ------------------------------------------------------------------- fakes

struct FlagSignal(Rc<Cell<bool>>);

impl AbortSignal for FlagSignal {
    fn aborted(&self) -> bool {
        self.0.get()
    }
}

struct NeverAborted;

impl AbortSignal for NeverAborted {
    fn aborted(&self) -> bool {
        false
    }
}

struct FakeResolver {
    sink: Sink,
    dns: HashMap<String, Dns>,
    flag: Rc<Cell<bool>>,
    has_signal: bool,
}

impl Resolver for FakeResolver {
    fn lookup_all(&mut self, host: &str) -> Result<Vec<LookupAddress>, FetchError> {
        log(&self.sink, vec![Value::from("dns"), Value::from(host)]);
        match self.dns.get(host) {
            None | Some(Dns::Reject) => Err(FetchError(format!("getaddrinfo ENOTFOUND {host}"))),
            Some(Dns::Abort) => {
                if self.has_signal {
                    self.flag.set(true);
                }
                Ok(vec![LookupAddress {
                    address: "93.184.216.34".to_owned(),
                    family: 4.0,
                }])
            }
            Some(Dns::Addresses(list)) => Ok(list.clone()),
        }
    }
}

struct FakeResponse {
    sink: Sink,
    url: String,
    status: u16,
    headers: Vec<(String, String)>,
    chunks: VecDeque<Vec<u8>>,
    stream_error: Option<String>,
    has_body: bool,
    terse: bool,
    cancelled: bool,
}

impl FakeResponse {
    fn new(sink: &Sink, url: &str, spec: &RespSpec, terse: bool) -> Self {
        FakeResponse {
            sink: sink.clone(),
            url: url.to_owned(),
            status: spec.status,
            headers: spec.headers.clone(),
            chunks: spec.chunks.iter().cloned().collect(),
            stream_error: spec.stream_error.clone(),
            has_body: !spec.no_body,
            terse,
            cancelled: false,
        }
    }
}

impl Response for FakeResponse {
    fn status(&self) -> u16 {
        self.status
    }

    fn header(&self, name: &str) -> Option<String> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.clone())
    }

    fn has_body(&self) -> bool {
        self.has_body
    }

    fn cancel_body(&mut self) {
        if self.has_body && !self.terse {
            log(
                &self.sink,
                vec![Value::from("cancel"), Value::from(self.url.clone())],
            );
        }
        self.cancelled = true;
    }

    fn read_chunk(&mut self) -> Result<Option<Vec<u8>>, FetchError> {
        if self.cancelled {
            return Ok(None);
        }
        if let Some(chunk) = self.chunks.pop_front() {
            return Ok(Some(chunk));
        }
        match &self.stream_error {
            Some(message) => Err(FetchError(message.clone())),
            None => Ok(None),
        }
    }

    fn array_buffer(&mut self) -> Result<Vec<u8>, FetchError> {
        let mut out = Vec::new();
        while let Some(chunk) = self.read_chunk()? {
            out.extend_from_slice(&chunk);
        }
        Ok(out)
    }
}

struct FakeFetcher {
    sink: Sink,
    routes: HashMap<String, Vec<Route>>,
    counters: HashMap<String, usize>,
    dispatcher: GlobalDispatcher,
    flag: Rc<Cell<bool>>,
    has_signal: bool,
    terse: bool,
    last_url: String,
}

impl Fetcher for FakeFetcher {
    fn global_dispatcher(&mut self) -> GlobalDispatcher {
        self.dispatcher.clone()
    }

    fn fetch(&mut self, url: &str, init: &FetchInit<'_>) -> Result<Box<dyn Response>, FetchError> {
        self.last_url = url.to_owned();
        if self.terse {
            log(&self.sink, vec![Value::from("fetch"), Value::from(url)]);
        } else {
            let pinned = match init.pinned {
                Some(target) => {
                    let host = Url::parse(url)
                        .ok()
                        .and_then(|u| u.host_str().map(str::to_owned))
                        .unwrap_or_default();
                    match pinned_lookup(target)(
                        &host,
                        &LookupOptions {
                            all: true,
                            family: None,
                        },
                    ) {
                        PinnedAnswer::All(list) => addresses_value(&list),
                        _ => Value::Null,
                    }
                }
                None => Value::Null,
            };
            let headers = match init.headers {
                Some(list) => object(
                    list.iter()
                        .map(|(k, v)| (k.clone(), Value::from(v.clone()))),
                ),
                None => Value::Null,
            };
            log(
                &self.sink,
                vec![
                    Value::from("fetch"),
                    Value::from(url),
                    headers,
                    Value::Bool(init.signal),
                    pinned,
                ],
            );
        }
        let list = self.routes.get(url).cloned().unwrap_or_default();
        let at = self.counters.get(url).copied().unwrap_or(0);
        self.counters.insert(url.to_owned(), at + 1);
        let route = if list.is_empty() {
            None
        } else {
            Some(list[at.min(list.len() - 1)].clone())
        };
        match route {
            None => Err(FetchError(format!("no route: {url}"))),
            Some(Route::Throw) => Err(FetchError(format!("transport down: {url}"))),
            Some(Route::AbortThrow) => {
                if self.has_signal {
                    self.flag.set(true);
                }
                Err(FetchError(format!("aborted: {url}")))
            }
            Some(Route::Resp(spec)) => Ok(Box::new(FakeResponse::new(
                &self.sink, url, &spec, self.terse,
            ))),
        }
    }

    fn close_dispatcher(&mut self) {
        log(
            &self.sink,
            vec![Value::from("close"), Value::from(self.last_url.clone())],
        );
    }

    fn sleep(&mut self, ms: f64) {
        log(&self.sink, vec![Value::from("sleep"), num(ms)]);
    }
}

fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn addresses_value(list: &[RemoteTargetAddress]) -> Value {
    Value::Array(
        list.iter()
            .map(|a| {
                obj(&[
                    ("address", Value::from(a.address.clone())),
                    ("family", Value::from(a.family)),
                ])
            })
            .collect(),
    )
}

/// the resolver, the fetcher and the signal of a world, with the logs they write
struct Env {
    sink: Sink,
    resolver: FakeResolver,
    fetcher: FakeFetcher,
    signal: Option<FlagSignal>,
    #[allow(dead_code)]
    seeded: Seeded,
    tmpdir: String,
}

fn make_env(world: World) -> Env {
    let sink: Sink = Rc::new(RefCell::new(Vec::new()));
    let flag = Rc::new(Cell::new(world.signal == SignalKind::Aborted));
    let has_signal = world.signal != SignalKind::None;
    let seeded = Seeded::new(&world);
    let resolver = FakeResolver {
        sink: sink.clone(),
        dns: world.dns,
        flag: flag.clone(),
        has_signal,
    };
    let fetcher = FakeFetcher {
        sink: sink.clone(),
        routes: world.routes,
        counters: HashMap::new(),
        dispatcher: world.dispatcher,
        flag: flag.clone(),
        has_signal,
        terse: world.mock,
        last_url: String::new(),
    };
    Env {
        sink,
        resolver,
        fetcher,
        signal: has_signal.then_some(FlagSignal(flag)),
        seeded,
        tmpdir: world.tmpdir,
    }
}

/// a response as the comparison prints it; its body is read to the end
fn render(resp: Option<Box<dyn Response>>) -> Value {
    let Some(mut resp) = resp else {
        return Value::Null;
    };
    let body = match resp.array_buffer() {
        Ok(bytes) => hex(&bytes),
        Err(e) => format!("error: {}", e.0),
    };
    let header = |name: &str| resp.header(name).map_or(Value::Null, Value::from);
    obj(&[
        ("status", Value::from(resp.status())),
        ("ok", Value::Bool(resp.ok())),
        ("contentType", header("content-type")),
        ("contentLength", header("content-length")),
        ("location", header("location")),
        ("body", Value::from(body)),
    ])
}

// ----------------------------------------------------------- safe-remote-url

fn target_value(target: Option<SafeRemoteTarget>) -> Value {
    match target {
        None => Value::Null,
        Some(t) => obj(&[
            ("url", Value::from(t.url)),
            ("hostname", Value::from(t.hostname)),
            ("literal", Value::Bool(t.literal)),
            ("addresses", addresses_value(&t.addresses)),
        ]),
    }
}

fn resolve_target_call(args: &[Value], cx: &mut Context) -> Answer {
    let mut env = make_env(parse_world(arg(args, 1))?);
    let raw = arg(args, 0).and_then(Value::as_str);
    let target = resolve_safe_remote_target(
        &mut env.resolver,
        raw,
        env.signal.as_ref().map(|s| s as &dyn AbortSignal),
    );
    flush(&env.sink, cx);
    Ok(Some(target_value(target)))
}

fn is_safe_call(args: &[Value], cx: &mut Context) -> Answer {
    let mut env = make_env(parse_world(arg(args, 1))?);
    let raw = arg(args, 0).and_then(Value::as_str);
    let safe = is_safe_remote_url(
        &mut env.resolver,
        raw,
        env.signal.as_ref().map(|s| s as &dyn AbortSignal),
    );
    flush(&env.sink, cx);
    Ok(Some(Value::Bool(safe)))
}

/// `guardTarget` of the harness: the defaults, then the keys the case sets
fn pinned_target(spec: Option<&Value>) -> SafeRemoteTarget {
    let spec = spec.cloned().unwrap_or(Value::Null);
    let addresses = match spec.get("addresses").and_then(Value::as_array) {
        Some(list) => list
            .iter()
            .map(|a| RemoteTargetAddress {
                address: a["address"].as_str().unwrap_or("").to_owned(),
                family: a["family"].as_u64().unwrap_or(4) as u8,
            })
            .collect(),
        None => vec![
            RemoteTargetAddress {
                address: "93.184.216.34".to_owned(),
                family: 4,
            },
            RemoteTargetAddress {
                address: "2606:2800:220:1:248:1893:25c8:1946".to_owned(),
                family: 6,
            },
        ],
    };
    SafeRemoteTarget {
        url: spec
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("http://example.com/")
            .to_owned(),
        hostname: spec
            .get("hostname")
            .and_then(Value::as_str)
            .unwrap_or("example.com")
            .to_owned(),
        addresses,
        literal: spec
            .get("literal")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn pinned_lookup_call(args: &[Value]) -> Answer {
    let target = pinned_target(arg(args, 0));
    let hostname = str_arg(args, 1)?;
    let options = arg(args, 2).cloned().unwrap_or(Value::Null);
    let options = LookupOptions {
        all: options.get("all").and_then(Value::as_bool).unwrap_or(false),
        family: options.get("family").and_then(Value::as_f64),
    };
    let answer = pinned_lookup(&target)(hostname, &options);
    Ok(Some(match answer {
        PinnedAnswer::Error { code, message } => obj(&[
            (
                "err",
                obj(&[
                    ("code", Value::from(code)),
                    ("message", Value::from(message)),
                ]),
            ),
            ("address", Value::from("")),
        ]),
        PinnedAnswer::All(list) => {
            obj(&[("err", Value::Null), ("address", addresses_value(&list))])
        }
        PinnedAnswer::One { address, family } => obj(&[
            ("err", Value::Null),
            ("address", Value::from(address)),
            ("family", Value::from(family)),
        ]),
    }))
}

fn header_list(value: Option<&Value>) -> Option<Vec<(String, String)>> {
    let map = value?.as_object()?;
    Some(
        map.iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_owned()))
            .collect(),
    )
}

fn guard_call(args: &[Value], cx: &mut Context) -> Answer {
    let url = str_arg(args, 0)?;
    let mut env = make_env(parse_world(arg(args, 1))?);
    let options = arg(args, 2).cloned().unwrap_or(Value::Null);
    let hop_headers = field(&options, "hopHeaders").cloned();
    let sink = env.sink.clone();
    let mut for_hop = move |hop_url: &str, hop: usize| -> Option<Vec<(String, String)>> {
        log(
            &sink,
            vec![
                Value::from("headersForHop"),
                Value::from(hop_url),
                Value::from(hop),
            ],
        );
        header_list(hop_headers.as_ref()?.get(hop.to_string()))
    };
    let has_hop_headers = field(&options, "hopHeaders").is_some();
    let mut guard = FetchWithSsrfGuardOptions {
        max_redirects: number_field(options.get("maxRedirects")),
        manual: options.get("redirect").and_then(Value::as_str) == Some("manual"),
        headers: header_list(options.get("headers")),
        headers_for_hop: if has_hop_headers {
            Some(&mut for_hop)
        } else {
            None
        },
        signal: env.signal.as_ref().map(|s| s as &dyn AbortSignal),
    };
    let answer = fetch_with_ssrf_guard(&mut env.resolver, &mut env.fetcher, url, &mut guard);
    let out = match answer {
        Ok(resp) => Ok(Some(render(resp))),
        Err(FetchError(message)) => Err(plain(message)),
    };
    flush(&env.sink, cx);
    out
}

// --------------------------------------------------------------- remote-image

fn too_large_call(args: &[Value]) -> Answer {
    let max_bytes = arg(args, 0)
        .and_then(Value::as_f64)
        .ok_or_else(|| plain("argument 0 is not a number"))?;
    let error = ResponseTooLargeError { max_bytes };
    Ok(Some(obj(&[
        ("message", Value::from(error.message())),
        ("maxBytes", num(error.max_bytes)),
    ])))
}

fn read_body_call(args: &[Value], cx: &mut Context) -> Answer {
    let sink: Sink = Rc::new(RefCell::new(Vec::new()));
    let spec = parse_resp(arg(args, 0).ok_or_else(|| plain("the response is missing"))?);
    let max_bytes = arg(args, 1)
        .and_then(Value::as_f64)
        .ok_or_else(|| plain("argument 1 is not a number"))?;
    let mut resp = FakeResponse::new(&sink, "body", &spec, false);
    let out = match read_body_capped(&mut resp, max_bytes) {
        Ok(bytes) => Ok(Some(obj(&[("bytes", Value::from(hex(&bytes)))]))),
        Err(e) => Err(plain(e.message())),
    };
    flush(&sink, cx);
    out
}

fn fetch_image_call(args: &[Value], cx: &mut Context) -> Answer {
    let url = str_arg(args, 0)?;
    let mut env = make_env(parse_world(arg(args, 1))?);
    let url = with_gen(&env.tmpdir, url);
    let delays: Option<Vec<f64>> = arg(args, 2)
        .and_then(|o| field(o, "retryDelaysMs"))
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_f64).collect());
    let resp = fetch_remote_image(
        &mut env.resolver,
        &mut env.fetcher,
        &env.tmpdir,
        &url,
        delays.as_deref(),
    );
    let out = render(resp);
    flush(&env.sink, cx);
    Ok(Some(out))
}

fn image_bytes_call(args: &[Value], cx: &mut Context) -> Answer {
    let mut env = make_env(parse_world(arg(args, 1))?);
    let url = arg(args, 0)
        .and_then(Value::as_str)
        .map(|u| with_gen(&env.tmpdir, u));
    let found = fetch_image_bytes(
        &mut env.resolver,
        &mut env.fetcher,
        &env.tmpdir,
        url.as_deref(),
    );
    flush(&env.sink, cx);
    Ok(Some(match found {
        Some(image) => to_value(&image),
        None => Value::Null,
    }))
}

// ----------------------------------------------------------- generated-images

fn mask_uuid(text: &str) -> String {
    js_regex!(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        "g"
    )
    .replace_all(text, |_| "<uuid>".to_owned())
}

fn bytes_of_spec(spec: Option<&Value>) -> Option<Vec<u8>> {
    let spec = spec?;
    if !spec.is_object() {
        return None;
    }
    if let Some(h) = spec.get("hex").and_then(Value::as_str) {
        return Some(unhex(h));
    }
    Some(vec![
        0u8;
        spec.get("length").and_then(Value::as_u64).unwrap_or(0)
            as usize
    ])
}

fn store_call(args: &[Value], cx: &mut Context) -> Answer {
    let world = parse_world(arg(args, 0))?;
    let tmpdir = world.tmpdir.clone();
    let mut seeded = Seeded::new(&world);
    let bytes = bytes_of_spec(arg(args, 1));
    let mime = arg(args, 2).and_then(Value::as_str);
    let stored = store_generated_image(&tmpdir, cx.now_ms, bytes.as_deref(), mime);
    let url = match stored {
        Ok(url) => url,
        Err(e) => {
            return Err(CallError {
                code: e.code().map(str::to_owned),
                message: mask_uuid(e.message()),
            });
        }
    };
    let path = Url::parse(&url)
        .ok()
        .and_then(|u| file_url_to_path(&u, cfg!(windows)))
        .ok_or_else(|| plain("the stored URL is not a file URL"))?;
    let name = jscompat::node_path::host::basename(&path, None);
    seeded.extra.push(name.clone());
    let dir = generated_image_dir(&tmpdir);
    let written = std::fs::read(&path).map_err(|e| plain(e.to_string()))?;
    let left: Vec<Value> = seeded
        .names
        .iter()
        .filter(|n| std::path::Path::new(&format!("{dir}/{n}")).exists())
        .map(|n| Value::from(n.clone()))
        .collect();
    Ok(Some(obj(&[
        ("url", Value::from(mask_uuid(&url))),
        ("name", Value::from(mask_uuid(&name))),
        ("bytes", Value::from(hex(&written))),
        ("seedsLeft", Value::Array(left)),
    ])))
}

fn read_image_call(args: &[Value]) -> Answer {
    let world = parse_world(arg(args, 0))?;
    let _seeded = Seeded::new(&world);
    let raw = with_gen(&world.tmpdir, str_arg(args, 1)?);
    Ok(Some(match read_generated_image(&world.tmpdir, &raw) {
        Some(GeneratedImage { bytes, mime }) => obj(&[
            ("bytes", Value::from(hex(&bytes))),
            ("mime", Value::from(mime)),
        ]),
        None => Value::Null,
    }))
}

// ---------------------------------------------------------------- remote-table

fn fetch_table_call(args: &[Value], cx: &mut Context) -> Answer {
    let url = str_arg(args, 0)?;
    let mut env = make_env(parse_world(arg(args, 1))?);
    let table = fetch_remote_table(&mut env.resolver, &mut env.fetcher, &NeverAborted, url);
    flush(&env.sink, cx);
    Ok(Some(table_value(table)))
}

// ------------------------------------------------------------------ main-proxy

fn choice_name(choice: ProxyAgentChoice) -> &'static str {
    match choice {
        ProxyAgentChoice::NoProxy => "noProxy",
        ProxyAgentChoice::HttpProxy => "http",
        ProxyAgentChoice::HttpsProxy => "https",
    }
}

fn proxy_error(e: crate::packages::electron_utils::main_proxy::ProxyAgentError) -> CallError {
    CallError {
        code: Some(e.code().to_owned()),
        message: e.message().to_owned(),
    }
}

fn main_proxy_call(args: &[Value]) -> Answer {
    let proxy = str_arg(args, 0)?;
    let env = arg(args, 1).cloned().unwrap_or(Value::Null);
    let lower = string_field(&env, "no_proxy");
    let upper = string_field(&env, "NO_PROXY");
    let dispatcher =
        create_main_process_proxy_dispatcher(proxy, lower.as_deref(), upper.as_deref())
            .map_err(proxy_error)?;
    let urls = string_list(arg(args, 2));
    let mut out = Vec::new();
    for url in &urls {
        let parsed = Url::parse(url).map_err(|_| plain("a probe URL does not parse"))?;
        out.push(obj(&[
            ("url", Value::from(url.clone())),
            ("routes", Value::Bool(dispatcher.routes_via_proxy(&parsed))),
            (
                "agent",
                Value::from(choice_name(dispatcher.agent_for(&parsed))),
            ),
        ]));
    }
    Ok(Some(Value::Array(out)))
}

fn env_agent_call(args: &[Value]) -> Answer {
    let opts = arg(args, 0).cloned().unwrap_or(Value::Null);
    let env = arg(args, 1).cloned().unwrap_or(Value::Null);
    let options = EnvHttpProxyOptions {
        http_proxy: string_field(&opts, "httpProxy"),
        https_proxy: string_field(&opts, "httpsProxy"),
        no_proxy: string_field(&opts, "noProxy"),
    };
    let proxy_env = ProxyEnv {
        http_proxy_lower: string_field(&env, "http_proxy"),
        http_proxy_upper: string_field(&env, "HTTP_PROXY"),
        https_proxy_lower: string_field(&env, "https_proxy"),
        https_proxy_upper: string_field(&env, "HTTPS_PROXY"),
        no_proxy_lower: string_field(&env, "no_proxy"),
        no_proxy_upper: string_field(&env, "NO_PROXY"),
    };
    let agent = EnvHttpProxyDecision::new(&options, &proxy_env).map_err(proxy_error)?;
    let mut out = Vec::new();
    for url in string_list(arg(args, 2)) {
        let parsed = Url::parse(&url).map_err(|_| plain("a probe URL does not parse"))?;
        out.push(Value::from(choice_name(agent.agent_for(&parsed))));
    }
    Ok(Some(Value::Array(out)))
}

// ----------------------------------------------------------- safe-external-url

fn safe_external_call(args: &[Value]) -> Answer {
    let url = arg(args, 0).and_then(Value::as_str);
    let options = arg(args, 1)
        .filter(|o| !o.is_null())
        .map(|o| SafeExternalUrlOptions {
            allowed_protocols: field(o, "allowedProtocols")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|p| p.as_str().map(str::to_owned))
                        .collect()
                }),
        });
    Ok(Some(match safe_external_url(url, options.as_ref()) {
        Some(text) => Value::from(text),
        None => Value::Null,
    }))
}

// -------------------------------------------------------------- navigation-guard

struct FakeNavApp {
    sink: Sink,
    installed: bool,
    listeners: Vec<ContentsCreatedListener>,
}

impl GuardedApp for FakeNavApp {
    fn guard_installed(&self) -> bool {
        self.installed
    }

    fn set_guard_installed(&mut self) {
        self.installed = true;
    }

    fn on_web_contents_created(&mut self, listener: ContentsCreatedListener) {
        log(
            &self.sink,
            vec![Value::from("app.on"), Value::from("web-contents-created")],
        );
        self.listeners.push(listener);
    }
}

struct FakeNavContents {
    sink: Sink,
    will: Vec<WillNavigateListener>,
    open: Option<WindowOpenHandler>,
}

impl GuardedContents for FakeNavContents {
    fn on_will_navigate(&mut self, listener: WillNavigateListener) {
        log(
            &self.sink,
            vec![Value::from("contents.on"), Value::from("will-navigate")],
        );
        self.will.push(listener);
    }

    fn set_window_open_handler(&mut self, handler: WindowOpenHandler) {
        log(
            &self.sink,
            vec![Value::from("contents.setWindowOpenHandler")],
        );
        self.open = Some(handler);
    }
}

struct FakeNavEvent {
    url: String,
    prevented: bool,
}

impl WillNavigateEvent for FakeNavEvent {
    fn url(&self) -> String {
        self.url.clone()
    }

    fn prevent_default(&mut self) {
        self.prevented = true;
    }
}

fn navigation_call(args: &[Value], cx: &mut Context) -> Answer {
    let scenario = arg(args, 0).cloned().unwrap_or(Value::Null);
    let sink: Sink = Rc::new(RefCell::new(Vec::new()));
    let mut app = FakeNavApp {
        sink: sink.clone(),
        installed: false,
        listeners: Vec::new(),
    };
    let installs = scenario
        .get("installs")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    for _ in 0..installs {
        install_navigation_guard(&mut app);
    }
    let mut results = Vec::new();
    for spec in scenario
        .get("contents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let page_url = string_field(&spec, "url").unwrap_or_default();
        let mut contents = FakeNavContents {
            sink: sink.clone(),
            will: Vec::new(),
            open: None,
        };
        for listener in &app.listeners {
            listener(&mut contents);
        }
        let get_url = || page_url.clone();
        let prevented: Vec<Value> = string_list(spec.get("navigations"))
            .into_iter()
            .map(|url| {
                let mut event = FakeNavEvent {
                    url,
                    prevented: false,
                };
                for listener in &contents.will {
                    listener(&mut event, &get_url);
                }
                Value::Bool(event.prevented)
            })
            .collect();
        let window_open = match &contents.open {
            Some(handler) => match handler() {
                WindowOpenAction::Deny => obj(&[("action", Value::from("deny"))]),
            },
            None => Value::Null,
        };
        results.push(obj(&[
            ("listeners", Value::from(contents.will.len())),
            ("prevented", Value::Array(prevented)),
            ("windowOpen", window_open),
        ]));
    }
    let out = obj(&[
        ("handlers", Value::from(app.listeners.len())),
        ("results", Value::Array(results)),
    ]);
    flush(&sink, cx);
    Ok(Some(out))
}

// ---------------------------------------------------------------- renderer-scheme

fn renderer_url_call(args: &[Value]) -> Answer {
    let dev_url = arg(args, 0).and_then(Value::as_str);
    let host = str_arg(args, 1)?;
    let query: Vec<(String, String)> = js_entries(arg(args, 2));
    renderer_url(dev_url, host, &query)
        .map(|url| Some(Value::from(url)))
        .map_err(|e| plain(e.0))
}

fn resolve_file_call(args: &[Value]) -> Answer {
    let roots: Vec<(String, String)> = js_entries(arg(args, 0));
    let request = str_arg(args, 1)?;
    Ok(Some(match resolve_renderer_file(&roots, request) {
        Some(file) => Value::from(file),
        None => Value::Null,
    }))
}

// ------------------------------------------------------------- permission-guard

fn pages_of(value: Option<&Value>) -> AppPages {
    let value = value.cloned().unwrap_or(Value::Null);
    AppPages {
        dev_urls: js_entries::<Option<String>>(field(&value, "devUrls")),
        file_roots: js_entries::<String>(field(&value, "fileRoots")),
    }
}

fn policy_of(value: Option<&Value>, sink: &Sink) -> PermissionPolicy {
    let value = value.cloned().unwrap_or(Value::Null);
    let open: Vec<i64> = value
        .get("micOpen")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    let sink = sink.clone();
    PermissionPolicy {
        pages: pages_of(value.get("pages")),
        microphone_open: Box::new(move |id| {
            log(&sink, vec![Value::from("microphoneOpen"), Value::from(id)]);
            open.contains(&id)
        }),
    }
}

struct FakeFrame {
    url: String,
    origin: String,
    parent: Option<usize>,
}

struct FakeContents {
    id: i64,
    frames: Vec<FakeFrame>,
    main: Option<usize>,
    torn: HashSet<String>,
}

fn contents_of(value: Option<&Value>) -> Option<FakeContents> {
    let value = value.filter(|v| !v.is_null())?;
    let frames = value
        .get("frames")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|f| FakeFrame {
                    url: string_field(f, "url").unwrap_or_default(),
                    origin: string_field(f, "origin").unwrap_or_default(),
                    parent: f.get("parent").and_then(Value::as_u64).map(|p| p as usize),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(FakeContents {
        id: value.get("id").and_then(Value::as_i64).unwrap_or(0),
        frames,
        main: value
            .get("main")
            .and_then(Value::as_u64)
            .map(|m| m as usize),
        torn: string_list(value.get("torn")).into_iter().collect(),
    })
}

impl FakeContents {
    fn guard(&self, key: &str) -> Result<(), TornDown> {
        if self.torn.contains(key) {
            Err(TornDown)
        } else {
            Ok(())
        }
    }
}

impl AskingContents for FakeContents {
    fn id(&self) -> i64 {
        self.id
    }

    fn main_frame(&self) -> Result<Option<FrameId>, TornDown> {
        self.guard("mainFrame")?;
        Ok(self.main)
    }

    fn frames_in_subtree(&self, _frame: FrameId) -> Result<Vec<FrameId>, TornDown> {
        self.guard("subtree")?;
        Ok((0..self.frames.len())
            .filter(|&i| {
                let mut at = Some(i);
                while let Some(current) = at {
                    if Some(current) == self.main {
                        return true;
                    }
                    at = self.frames[current].parent;
                }
                false
            })
            .collect())
    }

    fn frame_url(&self, frame: FrameId) -> Result<String, TornDown> {
        self.guard(&format!("url:{frame}"))?;
        Ok(self.frames[frame].url.clone())
    }

    fn frame_origin(&self, frame: FrameId) -> Result<String, TornDown> {
        self.guard(&format!("origin:{frame}"))?;
        Ok(self.frames[frame].origin.clone())
    }

    fn frame_parent(&self, frame: FrameId) -> Result<Option<FrameId>, TornDown> {
        self.guard(&format!("parent:{frame}"))?;
        Ok(self.frames[frame].parent)
    }
}

fn app_page_call(args: &[Value]) -> Answer {
    let pages = pages_of(arg(args, 0));
    let address = arg(args, 1).and_then(Value::as_str);
    Ok(Some(match app_page_of(&pages, address) {
        Some(page) => Value::from(page),
        None => Value::Null,
    }))
}

fn allowed_call(args: &[Value], cx: &mut Context) -> Answer {
    let sink: Sink = Rc::new(RefCell::new(Vec::new()));
    let policy = policy_of(arg(args, 0), &sink);
    let ask = arg(args, 1).cloned().unwrap_or(Value::Null);
    let allowed = permission_allowed(
        &policy,
        &PermissionAsk {
            permission: string_field(&ask, "permission").unwrap_or_default(),
            web_contents_id: field(&ask, "webContentsId").and_then(Value::as_i64),
            url: string_field(&ask, "url"),
            is_main_frame: ask
                .get("isMainFrame")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            own_frame: field(&ask, "ownFrame").and_then(Value::as_bool),
            media: field(&ask, "media")
                .and_then(Value::as_array)
                .map(|_| string_list(ask.get("media"))),
        },
    );
    flush(&sink, cx);
    Ok(Some(Value::Bool(allowed)))
}

fn request_details(value: Option<&Value>) -> RequestDetails {
    let value = value.cloned().unwrap_or(Value::Null);
    RequestDetails {
        is_main_frame: value
            .get("isMainFrame")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        requesting_url: string_field(&value, "requestingUrl"),
        media_types: field(&value, "mediaTypes")
            .and_then(Value::as_array)
            .map(|_| string_list(value.get("mediaTypes"))),
    }
}

fn check_details(value: Option<&Value>) -> CheckDetails {
    let value = value.cloned().unwrap_or(Value::Null);
    CheckDetails {
        is_main_frame: value
            .get("isMainFrame")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        requesting_url: string_field(&value, "requestingUrl"),
        media_type: string_field(&value, "mediaType"),
    }
}

fn request_handler_call(args: &[Value], cx: &mut Context) -> Answer {
    let sink: Sink = Rc::new(RefCell::new(Vec::new()));
    let policy = policy_of(arg(args, 0), &sink);
    let contents = contents_of(arg(args, 1));
    let permission = str_arg(args, 2)?;
    let details = request_details(arg(args, 3));
    let mut answers = Vec::new();
    permission_request_handler(
        &policy,
        contents.as_ref().map(|c| c as &dyn AskingContents),
        permission,
        &mut |granted| answers.push(Value::Bool(granted)),
        &details,
    );
    flush(&sink, cx);
    Ok(Some(Value::Array(answers)))
}

fn check_handler_call(args: &[Value], cx: &mut Context) -> Answer {
    let sink: Sink = Rc::new(RefCell::new(Vec::new()));
    let policy = policy_of(arg(args, 0), &sink);
    let contents = contents_of(arg(args, 1));
    let permission = str_arg(args, 2)?;
    let origin = str_arg(args, 3)?;
    let details = check_details(arg(args, 4));
    let granted = permission_check_handler(
        &policy,
        contents.as_ref().map(|c| c as &dyn AskingContents),
        permission,
        origin,
        &details,
    );
    flush(&sink, cx);
    Ok(Some(Value::Bool(granted)))
}

struct SessionRecord {
    name: String,
    request: Option<PermissionRequestHandler>,
    check: Option<PermissionCheckHandler>,
}

struct FakeSession {
    sink: Sink,
    record: Rc<RefCell<SessionRecord>>,
}

impl GuardedSession for FakeSession {
    fn set_permission_request_handler(&mut self, handler: PermissionRequestHandler) {
        let name = self.record.borrow().name.clone();
        log(
            &self.sink,
            vec![
                Value::from("session.setPermissionRequestHandler"),
                Value::from(name),
            ],
        );
        self.record.borrow_mut().request = Some(handler);
    }

    fn set_permission_check_handler(&mut self, handler: PermissionCheckHandler) {
        let name = self.record.borrow().name.clone();
        log(
            &self.sink,
            vec![
                Value::from("session.setPermissionCheckHandler"),
                Value::from(name),
            ],
        );
        self.record.borrow_mut().check = Some(handler);
    }
}

struct FakePermissionApp {
    sink: Sink,
    listeners: Vec<SessionCreatedListener>,
    ready: Option<ReadyListener>,
}

impl PermissionApp for FakePermissionApp {
    fn on_session_created(&mut self, listener: SessionCreatedListener) {
        log(
            &self.sink,
            vec![Value::from("app.on"), Value::from("session-created")],
        );
        self.listeners.push(listener);
    }

    fn when_ready(&mut self, listener: ReadyListener) {
        log(&self.sink, vec![Value::from("app.whenReady")]);
        self.ready = Some(listener);
    }
}

fn install_guard_call(args: &[Value], cx: &mut Context) -> Answer {
    let scenario = arg(args, 0).cloned().unwrap_or(Value::Null);
    let sink: Sink = Rc::new(RefCell::new(Vec::new()));
    let policy = Rc::new(policy_of(scenario.get("policy"), &sink));
    let records: Rc<RefCell<Vec<Rc<RefCell<SessionRecord>>>>> = Rc::new(RefCell::new(Vec::new()));
    let new_session = |name: &str| -> FakeSession {
        let record = Rc::new(RefCell::new(SessionRecord {
            name: name.to_owned(),
            request: None,
            check: None,
        }));
        records.borrow_mut().push(record.clone());
        FakeSession {
            sink: sink.clone(),
            record,
        }
    };
    // the harness makes the default session before the guard is installed
    let mut default_session = new_session("default");
    let mut app = FakePermissionApp {
        sink: sink.clone(),
        listeners: Vec::new(),
        ready: None,
    };
    install_permission_guard(&mut app, policy);
    for name in string_list(scenario.get("sessions")) {
        for listener in &app.listeners {
            let mut session = new_session(&name);
            listener(&mut session);
        }
    }
    if let Some(ready) = app.ready.take() {
        ready(&mut default_session);
    }
    let slides = "genoffice-app://slides/index.html";
    let docs = "genoffice-app://docs/index.html";
    let mut results = Vec::new();
    for record in records.borrow().iter() {
        let record = record.borrow();
        let contents = contents_of(scenario.get("probe"));
        let contents_ref = contents.as_ref().map(|c| c as &dyn AskingContents);
        let request = match &record.request {
            Some(handler) => {
                let mut asked = Vec::new();
                handler(
                    contents_ref,
                    "media",
                    &mut |granted| asked.push(Value::Bool(granted)),
                    &RequestDetails {
                        is_main_frame: true,
                        requesting_url: Some(slides.to_owned()),
                        media_types: Some(vec!["audio".to_owned()]),
                    },
                );
                Value::Array(asked)
            }
            None => Value::Null,
        };
        let check = match &record.check {
            Some(handler) => Value::Bool(handler(
                contents_ref,
                "fullscreen",
                "o",
                &CheckDetails {
                    is_main_frame: true,
                    requesting_url: Some(docs.to_owned()),
                    media_type: None,
                },
            )),
            None => Value::Null,
        };
        results.push(obj(&[
            ("name", Value::from(record.name.clone())),
            ("request", request),
            ("check", check),
        ]));
    }
    flush(&sink, cx);
    Ok(Some(Value::Array(results)))
}
