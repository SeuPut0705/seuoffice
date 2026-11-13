//! `FreeAiHost`: the free connections' host. The settings are the AI settings
//! file, the window is the one the Settings page sits in, and the network is
//! reqwest plus a loopback server of std sockets for the OpenRouter sign-in.
//! Everything that waits runs on a worker (the trait says so), so the
//! blocking server loop and `block_on` never touch the core thread.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, TcpListener, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

use jscompat::{JsonValue, json_parse};
use main_core::docs::free_ai_ipc::{WindowCommand, WindowState};
use main_core::packages::ai_provider::free_connect::{
    CallbackReply, CodeWait, FetchRequest, FetchResponse, FreeConnectNet, OpenRouterHost,
    REQUEST_TIMEOUT_MS,
};
use main_core::packages::i18n::Lang;
use shell_contract::ids::ViewId;
use shell_contract::runtime::{AppPaths, CancelToken, PathName, Thread};
use shell_ipc_a::free_ai::{FreeAiHost, OpenBrowser};
use tauri::AppHandle;

use super::settings::SettingsFile;
use super::{UiLang, window_of};
use crate::host::net::http;
use crate::paths::ShellPaths;
use crate::views::ViewTable;

pub struct FreeAi {
    lang: UiLang,
    app: AppHandle,
    ui: Arc<dyn Thread>,
    views: Arc<ViewTable>,
    settings: SettingsFile,
}

impl FreeAi {
    pub fn new(lang: UiLang, app: AppHandle, ui: Arc<dyn Thread>, views: Arc<ViewTable>) -> FreeAi {
        let paths = ShellPaths::new();
        FreeAi {
            lang,
            app,
            ui,
            views,
            settings: SettingsFile::new(paths.path(PathName::UserData), paths.path(PathName::Home)),
        }
    }
}

impl FreeAiHost for FreeAi {
    fn read_settings(&self) -> JsonValue {
        self.settings.stored().unwrap_or_else(|error| {
            // `storedAiSettings()` threw: the free connection cannot be changed either
            eprintln!("shell: reading the AI settings: {error}");
            JsonValue::Object(jscompat::JsObject::new())
        })
    }

    fn write_settings(&self, settings: &JsonValue) -> bool {
        match self.settings.write_renderer(settings) {
            Ok(written) => written,
            Err(error) => {
                eprintln!("shell: writing the AI settings: {error}");
                false
            }
        }
    }

    fn ui_lang(&self) -> Lang {
        self.lang.get()
    }

    fn window_state(&self, view: ViewId) -> Option<WindowState> {
        let (app, views) = (self.app.clone(), self.views.clone());
        crate::host::on_ui(&self.ui, move || {
            window_of(&app, &views, view).map(|window| WindowState {
                destroyed: false,
                minimized: window.is_minimized().unwrap_or(false),
            })
        })
    }

    fn window_command(&self, view: ViewId, command: WindowCommand) {
        let (app, views) = (self.app.clone(), self.views.clone());
        crate::host::on_ui(&self.ui, move || {
            if let Some(window) = window_of(&app, &views, view) {
                let _ = match command {
                    WindowCommand::Restore => window.unminimize(),
                    WindowCommand::Show => window.show(),
                    WindowCommand::Focus => window.set_focus(),
                };
            }
        });
    }

    fn net(&self, signal: CancelToken) -> Box<dyn FreeConnectNet> {
        Box::new(Net { signal })
    }

    fn open_router(
        &self,
        signal: CancelToken,
        open_browser: OpenBrowser,
    ) -> Box<dyn OpenRouterHost> {
        Box::new(Router {
            net: Net { signal },
            open_browser,
            listeners: Vec::new(),
            deadline: None,
        })
    }
}

/// Resolves once `signal` fires
async fn aborted(signal: &CancelToken) {
    while !signal.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The `fetch` of the free connections: one request, a redirect handed back
/// when asked, 20 seconds at most, ended at once by the signal
struct Net {
    signal: CancelToken,
}

impl FreeConnectNet for Net {
    fn fetch(&mut self, request: &FetchRequest) -> Result<FetchResponse, String> {
        let client = http::client(&request.url, !request.redirect_manual);
        let method = reqwest::Method::from_bytes(request.method.unwrap_or("GET").as_bytes())
            .map_err(|e| e.to_string())?;
        let mut builder = client
            .request(method, &request.url)
            .timeout(Duration::from_millis(REQUEST_TIMEOUT_MS as u64));
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }
        let signal = self.signal.clone();
        tauri::async_runtime::block_on(async move {
            let work = async {
                let response = builder.send().await.map_err(|e| e.to_string())?;
                let status = response.status().as_u16();
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                let json = response
                    .text()
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|text| json_parse(&text).map_err(|_| "invalid JSON".to_owned()));
                Ok::<_, String>(FetchResponse {
                    status,
                    opaque_redirect: false,
                    location,
                    json,
                })
            };
            tokio::select! {
                result = work => result,
                () = aborted(&signal) => Err("This operation was aborted".to_owned()),
            }
        })
    }

    fn signal_aborted(&self) -> bool {
        self.signal.is_cancelled()
    }
}

/// The loopback servers, the browser and the random source of the OpenRouter
/// sign-in
struct Router {
    net: Net,
    open_browser: OpenBrowser,
    listeners: Vec<TcpListener>,
    deadline: Option<Instant>,
}

/// How often the wait looks at the listeners, the timer and the signal
const POLL: Duration = Duration::from_millis(25);

impl FreeConnectNet for Router {
    fn fetch(&mut self, request: &FetchRequest) -> Result<FetchResponse, String> {
        self.net.fetch(request)
    }

    fn signal_aborted(&self) -> bool {
        self.net.signal_aborted()
    }
}

impl OpenRouterHost for Router {
    /// `randomBytes(32)`: the 32 bytes of a PKCE verifier, from the operating
    /// system's random source
    fn random_bytes(&mut self) -> [u8; 32] {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("the system has random bytes");
        bytes
    }

    /// `127.0.0.1` on a free port, and `::1` on the same port where this PC has it
    fn listen(&mut self) -> Result<f64, String> {
        let v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
        let port = v4.local_addr().map_err(|e| e.to_string())?.port();
        v4.set_nonblocking(true).map_err(|e| e.to_string())?;
        self.listeners.push(v4);
        if let Ok(v6) = TcpListener::bind((Ipv6Addr::LOCALHOST, port))
            && v6.set_nonblocking(true).is_ok()
        {
            self.listeners.push(v6);
        }
        Ok(f64::from(port))
    }

    fn open_browser(&mut self, url: &str) -> Result<bool, String> {
        (self.open_browser)(url)
    }

    fn start_timer(&mut self, timeout_ms: f64) {
        self.deadline = Some(Instant::now() + Duration::from_millis(timeout_ms as u64));
    }

    fn await_outcome(&mut self, wait: &mut CodeWait) {
        while wait.outcome().is_none() {
            if self.net.signal.is_cancelled() {
                wait.abort();
                break;
            }
            if self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
            {
                wait.timeout();
                break;
            }
            let mut idle = true;
            for listener in &self.listeners {
                if let Ok((stream, _)) = listener.accept() {
                    idle = false;
                    serve(stream, wait);
                }
            }
            if idle {
                std::thread::sleep(POLL);
            }
        }
    }

    fn close_servers(&mut self) {
        self.listeners.clear();
    }
}

/// One request to a loopback server: `handle(req, res)` of `waitForCode`
fn serve(mut stream: TcpStream, wait: &mut CodeWait) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut head = Vec::new();
    let mut buffer = [0u8; 1024];
    while head.len() < 8192 && !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&buffer[..n]),
        }
    }
    if head.is_empty() {
        return;
    }
    let text = String::from_utf8_lossy(&head);
    let mut line = text.lines().next().unwrap_or_default().split(' ');
    let method = line.next().unwrap_or_default();
    let answer = match wait.handle(method, line.next()) {
        Ok(CallbackReply::NotFound) => response(
            "404 Not Found",
            &[("Content-Type", "text/plain; charset=utf-8")],
            b"",
        ),
        Ok(CallbackReply::Page { headers, html }) => response("200 OK", &headers, html.as_bytes()),
        Err(_) => response("400 Bad Request", &[], b""),
    };
    let _ = stream.write_all(&answer);
    let _ = stream.flush();
}

fn response(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status}\r\n");
    for (name, value) in headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    ));
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}
