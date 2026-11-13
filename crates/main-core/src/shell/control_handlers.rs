//! `apps/shell/src/main/control-handlers.ts`: runs one CLI control request
//! against the open tabs.
//!
//! Requests and replies are raw JSON values (`ControlRequest` is checked by
//! `parseEnvelope` only as far as `cmd` and `path`, and the renderer's reply
//! is not checked at all). The handler awaits the renderer's answer and sleeps
//! between polls, so it is a state machine the caller drives: [`ControlHandler::handle`]
//! answers the first [`ControlStep`], the caller carries each step out (the
//! script in the tab's page, the 250 ms wait) and hands the answer to
//! [`ControlRun::resume`]. The `Date.now()` of the poll loop is
//! [`ControlHost::now_ms`].

use jscompat::{JsObject, JsonValue, json_stringify};

use crate::packages::i18n::PRODUCT_NAME;

/// A rejected `executeJavaScript` promise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptRejected;

/// the `webContents` calls the handler makes
pub trait ControlContents {
    fn is_destroyed(&mut self) -> bool;
    fn is_loading(&mut self) -> bool;
}

/// what `findTab` returns
pub struct ControlTab<C> {
    pub id: String,
    /// `TabKind`
    pub kind: String,
    pub web_contents: C,
}

/// `ControlHost`
pub trait ControlHost {
    type Contents: ControlContents + Clone;
    fn reveal(&mut self);
    fn open_document(&mut self, path: &str) -> bool;
    fn activate_tab(&mut self, id: &str);
    fn find_tab(&mut self, path: &str) -> Option<ControlTab<Self::Contents>>;
    /// `readyTimeoutMs`: ms to keep asking a renderer that has not loaded its
    /// document yet (`None`: 20 s)
    fn ready_timeout_ms(&self) -> Option<f64>;
    /// `Date.now()`
    fn now_ms(&mut self) -> f64;
}

/// what `TARGET_KIND_BY_TAB[tab.kind]` gives
enum Expected {
    /// no entry: `undefined`
    Undefined,
    Kind(&'static str),
    /// a name every object inherits (`constructor`, `toString`, ...): a truthy
    /// function or object that no target kind equals
    Inherited,
}

/// the names an object literal inherits from `Object.prototype`
const INHERITED_NAMES: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

fn target_kind_by_tab(kind: &str) -> Expected {
    match kind {
        "slides" => Expected::Kind("slide"),
        "docs" => Expected::Kind("block"),
        "sheets" => Expected::Kind("range"),
        "pdf" => Expected::Kind("page"),
        other if INHERITED_NAMES.contains(&other) => Expected::Inherited,
        _ => Expected::Undefined,
    }
}

/// `flagFor(kind)`
fn flag_for(kind: &Expected) -> &'static str {
    match kind {
        Expected::Kind(kind) => kind,
        Expected::Undefined | Expected::Inherited => "target",
    }
}

fn object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.set(key, value);
    }
    JsonValue::Object(object)
}

fn string(text: &str) -> JsonValue {
    JsonValue::String(text.to_string())
}

/// `fail(reason, message, detail)`
fn fail(reason: &str, message: &str, detail: Option<JsonValue>) -> JsonValue {
    let mut error = vec![("reason", string(reason)), ("message", string(message))];
    if let Some(detail) = detail {
        error.push(("detail", detail));
    }
    object(vec![
        ("ok", JsonValue::Bool(false)),
        ("error", object(error)),
    ])
}

/// What the caller does next.
#[derive(Debug, Clone, PartialEq)]
pub enum ControlStep<C> {
    /// `await wc.executeJavaScript(script, true)`: answer with
    /// [`ControlAnswer::Script`] (`None` is a reply of `undefined`, `Err` a
    /// rejection)
    ExecuteJavaScript { web_contents: C, script: String },
    /// `await new Promise((r) => setTimeout(r, ms))`: answer with
    /// [`ControlAnswer::Waited`] when the time is over
    Wait(f64),
    /// the request is answered
    Done(JsonValue),
}

/// The answer of the `await` the last step asked for.
#[derive(Debug, Clone, PartialEq)]
pub enum ControlAnswer {
    Script(Result<Option<JsonValue>, ScriptRejected>),
    Waited,
}

/// `ask(wc, request, readyTimeoutMs)` between its `await`s.
pub struct ControlRun<C> {
    web_contents: C,
    request: JsonValue,
    deadline: f64,
}

fn not_ready() -> JsObject<JsonValue> {
    let mut reply = JsObject::new();
    reply.set("status", string("not_ready"));
    reply
}

impl<C: ControlContents + Clone> ControlRun<C> {
    /// `ask(...)` up to its first `await`
    fn begin<H: ControlHost<Contents = C>>(
        host: &mut H,
        web_contents: C,
        request: JsonValue,
        ready_timeout_ms: f64,
    ) -> (Self, ControlStep<C>) {
        let deadline = host.now_ms() + ready_timeout_ms;
        let mut run = ControlRun {
            web_contents,
            request,
            deadline,
        };
        let step = run.evaluate(host);
        (run, step)
    }

    /// `evaluateControl(wc, request)` up to its `await`
    fn evaluate<H: ControlHost<Contents = C>>(&mut self, host: &mut H) -> ControlStep<C> {
        let wc = &mut self.web_contents;
        if wc.is_destroyed() || wc.is_loading() {
            return self.after_reply(host, not_ready());
        }
        let script = format!(
            "(async () => {{\n    const handler = window.__seuofficeControl\n    if (typeof handler !== 'function') return {{ status: 'not_ready' }}\n    try {{\n      return await handler({})\n    }} catch (err) {{\n      return {{ status: 'error', error: {{ reason: 'app_unavailable', message: String(err && err.message || err) }} }}\n    }}\n  }})()",
            json_stringify(&self.request)
        );
        ControlStep::ExecuteJavaScript {
            web_contents: wc.clone(),
            script,
        }
    }

    /// the rest of the loop once `evaluateControl` has its reply
    fn after_reply<H: ControlHost<Contents = C>>(
        &mut self,
        host: &mut H,
        reply: JsObject<JsonValue>,
    ) -> ControlStep<C> {
        match reply.get("status") {
            Some(JsonValue::String(status)) if status == "ok" => {
                let mut ok = vec![("ok", JsonValue::Bool(true))];
                if let Some(result) = reply.get("result") {
                    ok.push(("result", result.clone()));
                }
                return ControlStep::Done(object(ok));
            }
            Some(JsonValue::String(status)) if status == "error" => {
                let mut error = vec![("ok", JsonValue::Bool(false))];
                if let Some(detail) = reply.get("error") {
                    error.push(("error", detail.clone()));
                }
                return ControlStep::Done(object(error));
            }
            _ => {}
        }
        if host.now_ms() > self.deadline {
            return ControlStep::Done(fail(
                "app_unavailable",
                "the editor did not finish loading the document in time",
                None,
            ));
        }
        ControlStep::Wait(250.0)
    }

    /// the answer of the `await` the last step asked for
    pub fn resume<H: ControlHost<Contents = C>>(
        &mut self,
        handler: &mut ControlHandler<H>,
        answer: ControlAnswer,
    ) -> ControlStep<C> {
        let host = &mut handler.host;
        match answer {
            ControlAnswer::Waited => self.evaluate(host),
            ControlAnswer::Script(result) => {
                let reply = match result {
                    // `reply && typeof reply === 'object' && 'status' in reply`
                    Ok(Some(JsonValue::Object(reply))) if reply.get("status").is_some() => reply,
                    _ => not_ready(),
                };
                self.after_reply(host, reply)
            }
        }
    }
}

/// the function `controlHandler(host)` returns
pub struct ControlHandler<H: ControlHost> {
    host: H,
}

/// `controlHandler(host)`
pub fn control_handler<H: ControlHost>(host: H) -> ControlHandler<H> {
    ControlHandler { host }
}

impl<H: ControlHost> ControlHandler<H> {
    /// the host the handler runs against
    pub fn host(&self) -> &H {
        &self.host
    }

    /// `(req) => Promise<ControlReply>` up to its first `await`: `req` is a
    /// request `parseEnvelope` accepted (its `path` is a string). The run is
    /// there while the reply is not (`Done`) yet.
    pub fn handle(
        &mut self,
        req: &JsonValue,
    ) -> (Option<ControlRun<H::Contents>>, ControlStep<H::Contents>) {
        let field = |key: &str| req.get(key).map(std::borrow::Cow::into_owned);
        let path = match field("path") {
            Some(JsonValue::String(path)) => path,
            _ => String::new(),
        };
        if !std::path::Path::new(&path).exists() {
            return done(fail(
                "file_not_found",
                &format!("file not found: {path}"),
                None,
            ));
        }
        let ready_timeout = self.host.ready_timeout_ms().unwrap_or(20_000.0);
        let is_open = matches!(field("cmd"), Some(JsonValue::String(cmd)) if cmd == "open");
        if is_open {
            self.host.reveal();
            // the tab lookup resolves links and casing; the raw-path route would open a twin tab
            let existing = self.host.find_tab(&path);
            let had_existing = existing.is_some();
            if let Some(existing) = &existing {
                self.host.activate_tab(&existing.id);
            } else if !self.host.open_document(&path) {
                return done(fail(
                    "unsupported",
                    &format!("{PRODUCT_NAME} cannot open {path}"),
                    None,
                ));
            }
            let target = field("target").unwrap_or(JsonValue::Null);
            if !target.truthy() {
                return done(object(vec![
                    ("ok", JsonValue::Bool(true)),
                    ("result", object(vec![("opened", string(&path))])),
                ]));
            }
            let tab = if had_existing {
                existing
            } else {
                self.host.find_tab(&path)
            };
            let Some(tab) = tab else {
                return done(fail(
                    "file_not_open_in_gui",
                    &format!("no editor tab is showing {path}"),
                    None,
                ));
            };
            let expected = target_kind_by_tab(&tab.kind);
            let target_kind = target.get("kind").map(std::borrow::Cow::into_owned);
            let same = match (&expected, &target_kind) {
                (Expected::Undefined, None) => true,
                (Expected::Kind(kind), Some(JsonValue::String(given))) => given.as_str() == *kind,
                _ => false,
            };
            if !same {
                let supported = match expected {
                    Expected::Undefined => Vec::new(),
                    _ => vec![string(flag_for(&expected))],
                };
                return done(fail(
                    "unsupported",
                    &format!(
                        "a {} tab takes a --{} target",
                        tab.kind,
                        flag_for(&expected)
                    ),
                    Some(object(vec![("supported", JsonValue::Array(supported))])),
                ));
            }
            let request = object(vec![("cmd", string("goto")), ("target", target)]);
            let (run, step) =
                ControlRun::begin(&mut self.host, tab.web_contents, request, ready_timeout);
            return (Some(run), step);
        }
        let Some(tab) = self.host.find_tab(&path) else {
            return done(fail(
                "file_not_open_in_gui",
                &format!("{PRODUCT_NAME} does not have {path} open"),
                Some(object(vec![(
                    "suggestion",
                    string(&format!("seuoffice open {path}")),
                )])),
            ));
        };
        let request = object(vec![("cmd", string("selection"))]);
        let (run, step) =
            ControlRun::begin(&mut self.host, tab.web_contents, request, ready_timeout);
        (Some(run), step)
    }
}

/// a request answered without a run
fn done<C>(reply: JsonValue) -> (Option<ControlRun<C>>, ControlStep<C>) {
    (None, ControlStep::Done(reply))
}
