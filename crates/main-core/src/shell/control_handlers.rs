//! `apps/shell/src/main/control-handlers.ts`: runs one CLI control request
//! against the open tabs.
//!
//! Requests and replies are raw JSON values (`ControlRequest` is checked by
//! `parseEnvelope` only as far as `cmd` and `path`, and the renderer's reply
//! is not checked at all). The `Date.now()` and `setTimeout` of the poll loop
//! are [`ControlHost::now_ms`] and [`ControlHost::wait`].

use jscompat::{JsObject, JsonValue, json_stringify};

use crate::packages::i18n::PRODUCT_NAME;

/// A rejected `executeJavaScript` promise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptRejected;

/// the `webContents` calls the handler makes
pub trait ControlContents {
    fn is_destroyed(&mut self) -> bool;
    fn is_loading(&mut self) -> bool;
    /// `executeJavaScript(script, true)`: the reply (`None` is `undefined`),
    /// `Err` where it rejects
    fn execute_javascript(&mut self, script: &str) -> Result<Option<JsonValue>, ScriptRejected>;
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
    type Contents: ControlContents;
    fn reveal(&mut self);
    fn open_document(&mut self, path: &str) -> bool;
    fn activate_tab(&mut self, id: &str);
    fn find_tab(&mut self, path: &str) -> Option<ControlTab<Self::Contents>>;
    /// `readyTimeoutMs`: ms to keep asking a renderer that has not loaded its
    /// document yet (`None`: 20 s)
    fn ready_timeout_ms(&self) -> Option<f64>;
    /// `Date.now()`
    fn now_ms(&mut self) -> f64;
    /// `await new Promise((r) => setTimeout(r, ms))`
    fn wait(&mut self, ms: f64);
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

/// `evaluateControl(wc, request)`: the renderer's reply, `not_ready` when it
/// has none
fn evaluate_control(wc: &mut dyn ControlContents, request: &JsonValue) -> JsObject<JsonValue> {
    let not_ready = || {
        let mut reply = JsObject::new();
        reply.set("status", string("not_ready"));
        reply
    };
    if wc.is_destroyed() || wc.is_loading() {
        return not_ready();
    }
    let script = format!(
        "(async () => {{\n    const handler = window.__seuofficeControl\n    if (typeof handler !== 'function') return {{ status: 'not_ready' }}\n    try {{\n      return await handler({})\n    }} catch (err) {{\n      return {{ status: 'error', error: {{ reason: 'app_unavailable', message: String(err && err.message || err) }} }}\n    }}\n  }})()",
        json_stringify(request)
    );
    match wc.execute_javascript(&script) {
        // `reply && typeof reply === 'object' && 'status' in reply`
        Ok(Some(JsonValue::Object(reply))) if reply.get("status").is_some() => reply,
        _ => not_ready(),
    }
}

/// `ask(wc, request, readyTimeoutMs)`
fn ask<H: ControlHost>(
    host: &mut H,
    wc: &mut H::Contents,
    request: &JsonValue,
    ready_timeout_ms: f64,
) -> JsonValue {
    let deadline = host.now_ms() + ready_timeout_ms;
    loop {
        let reply = evaluate_control(wc, request);
        match reply.get("status") {
            Some(JsonValue::String(status)) if status == "ok" => {
                let mut ok = vec![("ok", JsonValue::Bool(true))];
                if let Some(result) = reply.get("result") {
                    ok.push(("result", result.clone()));
                }
                return object(ok);
            }
            Some(JsonValue::String(status)) if status == "error" => {
                let mut error = vec![("ok", JsonValue::Bool(false))];
                if let Some(detail) = reply.get("error") {
                    error.push(("error", detail.clone()));
                }
                return object(error);
            }
            _ => {}
        }
        if host.now_ms() > deadline {
            return fail(
                "app_unavailable",
                "the editor did not finish loading the document in time",
                None,
            );
        }
        host.wait(250.0);
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

    /// `(req) => Promise<ControlReply>`: `req` is a request `parseEnvelope`
    /// accepted (its `path` is a string)
    pub fn handle(&mut self, req: &JsonValue) -> JsonValue {
        let field = |key: &str| req.get(key).map(std::borrow::Cow::into_owned);
        let path = match field("path") {
            Some(JsonValue::String(path)) => path,
            _ => String::new(),
        };
        if !std::path::Path::new(&path).exists() {
            return fail("file_not_found", &format!("file not found: {path}"), None);
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
                return fail(
                    "unsupported",
                    &format!("{PRODUCT_NAME} cannot open {path}"),
                    None,
                );
            }
            let target = field("target").unwrap_or(JsonValue::Null);
            if !target.truthy() {
                return object(vec![
                    ("ok", JsonValue::Bool(true)),
                    ("result", object(vec![("opened", string(&path))])),
                ]);
            }
            let tab = if had_existing {
                existing
            } else {
                self.host.find_tab(&path)
            };
            let Some(mut tab) = tab else {
                return fail(
                    "file_not_open_in_gui",
                    &format!("no editor tab is showing {path}"),
                    None,
                );
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
                return fail(
                    "unsupported",
                    &format!(
                        "a {} tab takes a --{} target",
                        tab.kind,
                        flag_for(&expected)
                    ),
                    Some(object(vec![("supported", JsonValue::Array(supported))])),
                );
            }
            let request = object(vec![("cmd", string("goto")), ("target", target)]);
            return ask(
                &mut self.host,
                &mut tab.web_contents,
                &request,
                ready_timeout,
            );
        }
        let Some(mut tab) = self.host.find_tab(&path) else {
            return fail(
                "file_not_open_in_gui",
                &format!("{PRODUCT_NAME} does not have {path} open"),
                Some(object(vec![(
                    "suggestion",
                    string(&format!("seuoffice open {path}")),
                )])),
            );
        };
        let request = object(vec![("cmd", string("selection"))]);
        ask(
            &mut self.host,
            &mut tab.web_contents,
            &request,
            ready_timeout,
        )
    }
}
