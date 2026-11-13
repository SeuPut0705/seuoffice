//! `apps/shell/src/main/mcp-client/oauth-loopback.ts`: the one-shot server
//! the browser comes back to after an MCP sign-in (user MCP spec 4.8), built
//! the same way as the Google sign-in: bound to 127.0.0.1 on a free port,
//! answering only a `GET /callback` whose `state` matches, with a static page
//! that has no script and loads nothing. It closes when the code arrives,
//! when the attempt is cancelled, or when the time limit passes.
//!
//! # Driving a receiver
//!
//! The HTTP server and the timer are the host's ([`LoopbackHost`]);
//! [`LoopbackReceiver`] is what the TypeScript's closure holds.
//!
//! 1. [`LoopbackReceiver::start`] listens (`server.listen(0, '127.0.0.1')`,
//!    one plain host call) and starts the time limit. A listen that fails is
//!    the `Err` the TypeScript's `startLoopbackReceiver` rejects with.
//! 2. Each request the server gets is [`LoopbackReceiver::on_request`]; the
//!    answer the server writes is the [`LoopbackHost::respond`] call made from
//!    inside it, before the receiver closes itself.
//! 3. The timer's firing is [`LoopbackReceiver::on_timeout`]; the
//!    `AbortSignal` of the attempt aborting is [`LoopbackReceiver::on_abort`];
//!    [`LoopbackReceiver::close`] is `receiver.close()`.
//! 4. [`LoopbackReceiver::outcome`] is `await receiver.outcome` once it is
//!    there: it settles once, and settling stops the server (clears the timer,
//!    closes the server and its idle connections) at once. The TypeScript does
//!    that in a promise reaction that runs before anything else can happen.
//!
//! A request target the TypeScript's `new URL(req.url, base)` throws on would
//! throw out of the request listener; it is answered as a stray request
//! here.

use url::Url;

use crate::packages::google_drive::oauth::{SignInPage, sign_in_page_html};

/// `LoopbackFailure`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopbackFailure {
    Cancelled,
    Timeout,
    Denied,
}

impl LoopbackFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            LoopbackFailure::Cancelled => "cancelled",
            LoopbackFailure::Timeout => "timeout",
            LoopbackFailure::Denied => "denied",
        }
    }
}

/// `LoopbackOutcome`
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopbackOutcome {
    Code(String),
    Failed(LoopbackFailure),
}

/// `LoopbackPages`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackPages {
    pub done: SignInPage,
    pub failed: SignInPage,
}

/// What `res.writeHead(status, headers)` and `res.end(body)` write; `body`
/// is `None` for `res.end()`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// The server and the timer, as plain calls. `port` names the server of one
/// receiver when several are alive.
pub trait LoopbackHost {
    /// `server.listen(0, '127.0.0.1')`: the port, or the message of the error
    fn listen(&mut self) -> Result<u16, String>;
    /// `setTimeout(callback, ms)`: the timer's number, given back to
    /// [`LoopbackReceiver::on_timeout`] when it fires
    fn set_timeout(&mut self, ms: f64) -> u64;
    /// `clearTimeout(timer)`
    fn clear_timeout(&mut self, timer: u64);
    /// the answer of the request being handled
    fn respond(&mut self, port: u16, response: &LoopbackResponse);
    /// `server.close()`
    fn close_server(&mut self, port: u16);
    /// `server.closeIdleConnections()`
    fn close_idle_connections(&mut self, port: u16);
    /// `server.closeAllConnections()`
    fn close_all_connections(&mut self, port: u16);
}

/// `sameText(a, b)`: equal as bytes, compared without stopping at the first difference
fn same_text(a: &str, b: &str) -> bool {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    if x.len() != y.len() {
        return false;
    }
    x.iter().zip(y).fold(0u8, |acc, (p, q)| acc | (p ^ q)) == 0
}

/// `startLoopbackReceiver`'s closure
#[derive(Debug)]
pub struct LoopbackReceiver {
    state: String,
    pages: LoopbackPages,
    port: u16,
    timer: u64,
    /// `settled` and the value `outcome` resolved with
    outcome: Option<LoopbackOutcome>,
    /// `stopped`
    stopped: bool,
}

impl LoopbackReceiver {
    /// `startLoopbackReceiver({ state, pages, timeoutMs, signal })`; `aborted`
    /// is `signal?.aborted` at that moment
    pub fn start(
        host: &mut dyn LoopbackHost,
        state: &str,
        pages: &LoopbackPages,
        timeout_ms: f64,
        aborted: bool,
    ) -> Result<LoopbackReceiver, String> {
        let port = host.listen()?;
        let timer = host.set_timeout(timeout_ms);
        let mut receiver = LoopbackReceiver {
            state: state.to_owned(),
            pages: pages.clone(),
            port,
            timer,
            outcome: None,
            stopped: false,
        };
        if aborted {
            receiver.on_abort(host);
        }
        Ok(receiver)
    }

    /// `receiver.redirectUri`
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.port)
    }

    /// the port the server listens on
    pub fn port(&self) -> u16 {
        self.port
    }

    /// `receiver.outcome` once it settled
    pub fn outcome(&self) -> Option<&LoopbackOutcome> {
        self.outcome.as_ref()
    }

    /// `settle(value)`: only the first counts; the server stops right after
    fn settle(&mut self, host: &mut dyn LoopbackHost, outcome: LoopbackOutcome) {
        if self.outcome.is_some() {
            return;
        }
        self.outcome = Some(outcome);
        self.stop_listening(host);
    }

    /// `stopListening()`
    fn stop_listening(&mut self, host: &mut dyn LoopbackHost) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        host.clear_timeout(self.timer);
        host.close_server(self.port);
        host.close_idle_connections(self.port);
    }

    /// `handle(req, res)`: `method` and `target` are `req.method` and `req.url`
    pub fn on_request(&mut self, host: &mut dyn LoopbackHost, method: &str, target: &str) {
        let parsed = Url::parse("http://127.0.0.1").and_then(|base| base.join(target));
        let found = match &parsed {
            // a stray request (favicon, another program guessing) neither answers nor ends the wait
            Ok(url)
                if method == "GET"
                    && url.path() == "/callback"
                    && self.outcome.is_none()
                    && same_text(
                        url.query_pairs()
                            .find(|(key, _)| key == "state")
                            .map(|(_, value)| value.into_owned())
                            .as_deref()
                            .unwrap_or(""),
                        &self.state,
                    ) =>
            {
                Some(url)
            }
            _ => None,
        };
        let Some(url) = found else {
            host.respond(
                self.port,
                &LoopbackResponse {
                    status: 404,
                    headers: vec![(
                        "Content-Type".to_owned(),
                        "text/plain; charset=utf-8".to_owned(),
                    )],
                    body: None,
                },
            );
            return;
        };
        let code = url
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.into_owned());
        let code = code.filter(|code| !code.is_empty());
        let page = if code.is_some() {
            &self.pages.done
        } else {
            &self.pages.failed
        };
        let response = LoopbackResponse {
            status: 200,
            headers: vec![
                (
                    "Content-Type".to_owned(),
                    "text/html; charset=utf-8".to_owned(),
                ),
                (
                    "Content-Security-Policy".to_owned(),
                    "default-src 'none'; style-src 'unsafe-inline'".to_owned(),
                ),
                ("Cache-Control".to_owned(), "no-store".to_owned()),
                ("Connection".to_owned(), "close".to_owned()),
            ],
            body: Some(sign_in_page_html(page)),
        };
        host.respond(self.port, &response);
        self.settle(
            host,
            match code {
                Some(code) => LoopbackOutcome::Code(code),
                None => LoopbackOutcome::Failed(LoopbackFailure::Denied),
            },
        );
    }

    /// the time limit's timer fired: whether it was this receiver's
    pub fn on_timeout(&mut self, host: &mut dyn LoopbackHost, timer: u64) -> bool {
        if timer != self.timer {
            return false;
        }
        self.settle(host, LoopbackOutcome::Failed(LoopbackFailure::Timeout));
        true
    }

    /// `onAbort`: the `AbortSignal` of the attempt aborted
    pub fn on_abort(&mut self, host: &mut dyn LoopbackHost) {
        self.settle(host, LoopbackOutcome::Failed(LoopbackFailure::Cancelled));
    }

    /// `receiver.close()`: stop waiting and free the port; safe to call more than once
    pub fn close(&mut self, host: &mut dyn LoopbackHost) {
        self.settle(host, LoopbackOutcome::Failed(LoopbackFailure::Cancelled));
        self.stop_listening(host);
        host.close_all_connections(self.port);
    }
}
