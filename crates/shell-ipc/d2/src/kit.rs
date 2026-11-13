//! What every D2 handler is built from: a registration entry, the two handler
//! shapes (answers at once, answers later), argument reads as the TypeScript's
//! `typeof` checks make them, values to send back, the errors a handler throws,
//! and work handed to a worker thread whose result comes back to the core
//! thread.

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::Path;
use std::rc::{Rc, Weak};
use std::time::Duration;

use shell_contract::ViewId;

use shell_contract::ipc::{CallContext, ChannelKind, Handler, Reply, Responder};
use shell_contract::runtime::Services;
use shell_contract::{BytesKind, IpcError, IpcValue};

/// One channel's handler as `register` hands it to the registry
pub(crate) struct Entry {
    pub channel: &'static str,
    pub kind: ChannelKind,
    pub handler: Rc<dyn Handler>,
}

/// A handler that answers before it returns (a synchronous `ipcMain` handler,
/// or an async one whose awaits are all synchronous here)
struct Now<F>(F);

impl<F: Fn(&CallContext, Args) -> Reply> Handler for Now<F> {
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        reply.reply((self.0)(cx, Args(args)))
    }
}

/// A handler that keeps the responder and answers when its work ends
struct Later<F>(F);

impl<F: Fn(&CallContext, Args, Responder)> Handler for Later<F> {
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        (self.0)(cx, Args(args), reply)
    }
}

fn entry(channel: &'static str, kind: ChannelKind, handler: Rc<dyn Handler>) -> Entry {
    Entry {
        channel,
        kind,
        handler,
    }
}

/// `ipcMain.handle(channel, handler)`
pub(crate) fn invoke(
    channel: &'static str,
    f: impl Fn(&CallContext, Args) -> Reply + 'static,
) -> Entry {
    entry(channel, ChannelKind::Invoke, Rc::new(Now(f)))
}

/// `ipcMain.handle(channel, async handler)` that awaits real work
pub(crate) fn invoke_later(
    channel: &'static str,
    f: impl Fn(&CallContext, Args, Responder) + 'static,
) -> Entry {
    entry(channel, ChannelKind::Invoke, Rc::new(Later(f)))
}

/// `ipcMain.on(channel, listener)`: no reply; an `Err` is what the listener
/// threw, which the shell logs
pub(crate) fn send(
    channel: &'static str,
    f: impl Fn(&CallContext, Args) -> Result<(), IpcError> + 'static,
) -> Entry {
    entry(
        channel,
        ChannelKind::Send,
        Rc::new(Now(move |cx: &CallContext, args| {
            f(cx, args).map(|()| IpcValue::Undefined)
        })),
    )
}

/// `ipcMain.on(channel, listener)` that a renderer calls with `sendSync`: the
/// answer is what the listener set as `event.returnValue`
pub(crate) fn send_sync(
    channel: &'static str,
    f: impl Fn(&CallContext, Args) -> Reply + 'static,
) -> Entry {
    entry(channel, ChannelKind::SendSync, Rc::new(Now(f)))
}

/// The arguments of one call. A missing argument reads as `undefined`, as in
/// JavaScript.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Args(pub Vec<IpcValue>);

static UNDEFINED: IpcValue = IpcValue::Undefined;

impl Args {
    pub fn get(&self, i: usize) -> &IpcValue {
        self.0.get(i).unwrap_or(&UNDEFINED)
    }

    /// `typeof args[i] === 'string'`
    pub fn str(&self, i: usize) -> Option<&str> {
        as_str(self.get(i))
    }

    /// `typeof args[i] === 'number'`
    pub fn num(&self, i: usize) -> Option<f64> {
        as_num(self.get(i))
    }

    /// `typeof args[i] === 'boolean'`
    pub fn bool(&self, i: usize) -> Option<bool> {
        match self.get(i) {
            IpcValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// an `ArrayBuffer` or `Uint8Array` argument
    pub fn bytes(&self, i: usize) -> Option<&[u8]> {
        as_bytes(self.get(i))
    }

    /// moves one argument out, leaving `undefined`
    pub fn take(&mut self, i: usize) -> IpcValue {
        match self.0.get_mut(i) {
            Some(v) => std::mem::replace(v, IpcValue::Undefined),
            None => IpcValue::Undefined,
        }
    }
}

pub(crate) fn as_str(v: &IpcValue) -> Option<&str> {
    match v {
        IpcValue::String(s) => Some(s),
        _ => None,
    }
}

pub(crate) fn as_num(v: &IpcValue) -> Option<f64> {
    match v {
        IpcValue::Number(n) => Some(*n),
        _ => None,
    }
}

pub(crate) fn as_bytes(v: &IpcValue) -> Option<&[u8]> {
    match v {
        IpcValue::Bytes(_, b) => Some(b),
        _ => None,
    }
}

/// `value[key]` of a plain object; `undefined` for anything else
pub(crate) fn field<'a>(v: &'a IpcValue, key: &str) -> &'a IpcValue {
    match v {
        IpcValue::Object(entries) => entries
            .iter()
            .find(|(k, _)| k == key)
            .map_or(&UNDEFINED, |(_, v)| v),
        _ => &UNDEFINED,
    }
}

/// `typeof v === 'object' && v !== null` (arrays included, as in JavaScript)
pub(crate) fn is_object(v: &IpcValue) -> bool {
    matches!(
        v,
        IpcValue::Object(_) | IpcValue::Array(_) | IpcValue::Bytes(..) | IpcValue::Date(_)
    )
}

/// JavaScript truthiness
pub(crate) fn truthy(v: &IpcValue) -> bool {
    match v {
        IpcValue::Undefined | IpcValue::Null => false,
        IpcValue::Bool(b) => *b,
        IpcValue::Number(n) => *n != 0.0 && !n.is_nan(),
        IpcValue::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// A value a handler sends back
pub(crate) trait IntoIpc {
    fn into_ipc(self) -> IpcValue;
}

impl IntoIpc for IpcValue {
    fn into_ipc(self) -> IpcValue {
        self
    }
}

impl IntoIpc for &str {
    fn into_ipc(self) -> IpcValue {
        IpcValue::String(self.to_owned())
    }
}

impl IntoIpc for String {
    fn into_ipc(self) -> IpcValue {
        IpcValue::String(self)
    }
}

impl IntoIpc for &Path {
    /// a path as the TypeScript string it was; a path that is not Unicode
    /// cannot come from JavaScript, so it is replaced lossily
    fn into_ipc(self) -> IpcValue {
        IpcValue::String(self.to_string_lossy().into_owned())
    }
}

impl IntoIpc for f64 {
    fn into_ipc(self) -> IpcValue {
        IpcValue::Number(self)
    }
}

impl IntoIpc for bool {
    fn into_ipc(self) -> IpcValue {
        IpcValue::Bool(self)
    }
}

/// `null` for `None`, as the TypeScript's `?? null`
impl<T: IntoIpc> IntoIpc for Option<T> {
    fn into_ipc(self) -> IpcValue {
        self.map_or(IpcValue::Null, IntoIpc::into_ipc)
    }
}

impl<T: IntoIpc> IntoIpc for Vec<T> {
    fn into_ipc(self) -> IpcValue {
        IpcValue::Array(self.into_iter().map(IntoIpc::into_ipc).collect())
    }
}

/// An object literal: `obj([("ok", true.into_ipc()), ...])`
pub(crate) fn obj<const N: usize>(entries: [(&str, IpcValue); N]) -> IpcValue {
    IpcValue::Object(entries.map(|(k, v)| (k.to_owned(), v)).into())
}

/// A Node `Buffer` or `Uint8Array` the main side returns
pub(crate) fn u8_array(bytes: Vec<u8>) -> IpcValue {
    IpcValue::Bytes(BytesKind::Uint8Array, bytes)
}

/// `throw new Error(message)`
pub(crate) fn error(message: impl Into<String>) -> IpcError {
    named_error("Error", message)
}

/// `throw new TypeError(message)` and the like
pub(crate) fn named_error(name: &str, message: impl Into<String>) -> IpcError {
    IpcError {
        name: Some(name.to_owned()),
        message: message.into(),
    }
}

/// `JSON.stringify(value)` as a `serde_json::Value` (the shape `main-core`
/// takes): `undefined` members are dropped, `undefined` in an array and the
/// non-finite numbers are `null`, a date is its ISO string, an `ArrayBuffer`
/// is `{}` and a `Uint8Array` its indexed object. `None` where
/// `JSON.stringify` gives `undefined` (the value itself is `undefined`).
pub(crate) fn to_json(v: &IpcValue) -> Option<serde_json::Value> {
    use serde_json::Value;
    Some(match v {
        IpcValue::Undefined => return None,
        IpcValue::Null => Value::Null,
        IpcValue::Bool(b) => Value::Bool(*b),
        IpcValue::Number(n) => number_json(*n),
        IpcValue::String(s) => Value::String(s.clone()),
        IpcValue::Bytes(BytesKind::ArrayBuffer, _) => Value::Object(Default::default()),
        IpcValue::Bytes(BytesKind::Uint8Array, b) => Value::Object(
            b.iter()
                .enumerate()
                .map(|(i, byte)| (i.to_string(), Value::from(*byte)))
                .collect(),
        ),
        IpcValue::Date(ms) => match jscompat::to_iso_string(*ms) {
            Some(iso) => Value::String(iso),
            // Date.prototype.toJSON of an invalid date
            None => Value::Null,
        },
        IpcValue::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| to_json(item).unwrap_or(Value::Null))
                .collect(),
        ),
        IpcValue::Object(entries) => Value::Object(
            entries
                .iter()
                .filter_map(|(k, v)| to_json(v).map(|v| (k.clone(), v)))
                .collect(),
        ),
    })
}

fn number_json(n: f64) -> serde_json::Value {
    if !n.is_finite() {
        return serde_json::Value::Null;
    }
    // integers print without a fraction, as JSON.stringify does
    if n == n.trunc() && n.abs() < 9_007_199_254_740_992.0 {
        return serde_json::Value::from(n as i64);
    }
    serde_json::Number::from_f64(n).map_or(serde_json::Value::Null, serde_json::Value::Number)
}

/// The value a JSON-shaped answer from `main-core` arrives as in the renderer
pub(crate) fn from_json(v: &serde_json::Value) -> IpcValue {
    use serde_json::Value;
    match v {
        Value::Null => IpcValue::Null,
        Value::Bool(b) => IpcValue::Bool(*b),
        Value::Number(n) => IpcValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => IpcValue::String(s.clone()),
        Value::Array(items) => IpcValue::Array(items.iter().map(from_json).collect()),
        Value::Object(map) => {
            IpcValue::Object(map.iter().map(|(k, v)| (k.clone(), from_json(v))).collect())
        }
    }
}

/// `JSON.stringify(value)` as `jscompat`'s parsed value, for the `main-core`
/// functions that take one
pub(crate) fn to_js_json(v: &IpcValue) -> Option<jscompat::JsonValue> {
    use jscompat::JsonValue;
    fn conv(v: &serde_json::Value) -> JsonValue {
        match v {
            serde_json::Value::Null => JsonValue::Null,
            serde_json::Value::Bool(b) => JsonValue::Bool(*b),
            serde_json::Value::Number(n) => JsonValue::Number(n.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(s) => JsonValue::String(s.clone()),
            serde_json::Value::Array(items) => JsonValue::Array(items.iter().map(conv).collect()),
            serde_json::Value::Object(map) => {
                JsonValue::Object(map.iter().map(|(k, v)| (k.clone(), conv(v))).collect())
            }
        }
    }
    to_json(v).as_ref().map(conv)
}

/// `jscompat`'s parsed value as the renderer receives it
pub(crate) fn from_js_json(v: &jscompat::JsonValue) -> IpcValue {
    use jscompat::JsonValue;
    match v {
        JsonValue::Null => IpcValue::Null,
        JsonValue::Bool(b) => IpcValue::Bool(*b),
        JsonValue::Number(n) => IpcValue::Number(*n),
        JsonValue::String(s) => IpcValue::String(s.clone()),
        JsonValue::Array(items) => IpcValue::Array(items.iter().map(from_js_json).collect()),
        JsonValue::Object(map) => IpcValue::Object(
            map.entries()
                .into_iter()
                .map(|(k, v)| (k.to_owned(), from_js_json(v)))
                .collect(),
        ),
    }
}

type Continuation = Box<dyn FnOnce(Box<dyn Any + Send>)>;

thread_local! {
    /// continuations waiting for a worker, on the core thread that queued them
    static WAITING: RefCell<HashMap<u64, Continuation>> = RefCell::new(HashMap::new());
    static NEXT: Cell<u64> = const { Cell::new(0) };
}

/// What TypeScript awaited: `work` runs on a worker with the data it owns,
/// then `then` runs on the core thread with its result, where it may touch
/// the handler's state and answer. Call it on the core thread.
pub(crate) fn on_worker<R: Send + 'static>(
    services: &Services,
    work: impl FnOnce() -> R + Send + 'static,
    then: impl FnOnce(R) + 'static,
) {
    debug_assert!(services.core.is_current(), "on_worker off the core thread");
    let id = NEXT.with(|next| {
        let id = next.get();
        next.set(id + 1);
        id
    });
    WAITING.with(|waiting| {
        waiting.borrow_mut().insert(
            id,
            Box::new(move |result: Box<dyn Any + Send>| {
                then(
                    *result
                        .downcast::<R>()
                        .expect("a worker result of its own type"),
                )
            }),
        )
    });
    let core = services.core.clone();
    services.workers.spawn(Box::new(move || {
        let result: Box<dyn Any + Send> = Box::new(work());
        core.post(Box::new(move || {
            let then = WAITING.with(|waiting| waiting.borrow_mut().remove(&id));
            if let Some(then) = then {
                then(result)
            }
        }));
    }));
}

thread_local! {
    /// what each per-view state drops when its view ends, by registration
    static ON_DESTROYED: RefCell<HashMap<u64, Weak<dyn Fn(ViewId)>>> = RefCell::new(HashMap::new());
}

fn next_id() -> u64 {
    NEXT.with(|next| {
        let id = next.get();
        next.set(id + 1);
        id
    })
}

/// Runs `f` on the core thread after a view is destroyed, for as long as the
/// returned guard lives: the TypeScript's `contents.once('destroyed', …)`.
/// Keep the guard beside the state it cleans.
pub(crate) fn on_view_destroyed(
    services: &Services,
    f: impl Fn(ViewId) + 'static,
) -> Rc<dyn Fn(ViewId)> {
    let hook: Rc<dyn Fn(ViewId)> = Rc::new(f);
    let id = next_id();
    ON_DESTROYED.with(|hooks| hooks.borrow_mut().insert(id, Rc::downgrade(&hook)));
    services.views.on_destroyed(Box::new(move |view| {
        let hook = ON_DESTROYED.with(|hooks| {
            let mut hooks = hooks.borrow_mut();
            let hook = hooks.get(&id).and_then(Weak::upgrade);
            if hook.is_none() {
                hooks.remove(&id);
            }
            hook
        });
        if let Some(hook) = hook {
            hook(view)
        }
    }));
    hook
}

/// State kept per view, as the TypeScript's `Map<number, T>` keyed by
/// `webContents.id`, and dropped when the view is destroyed. Cloning shares it.
pub(crate) struct ViewMap<T> {
    map: Rc<RefCell<HashMap<ViewId, T>>>,
    _hook: Rc<dyn Fn(ViewId)>,
}

impl<T> Clone for ViewMap<T> {
    fn clone(&self) -> Self {
        ViewMap {
            map: Rc::clone(&self.map),
            _hook: Rc::clone(&self._hook),
        }
    }
}

impl<T: 'static> ViewMap<T> {
    pub fn new(services: &Services) -> Self {
        let map: Rc<RefCell<HashMap<ViewId, T>>> = Rc::default();
        let weak = Rc::downgrade(&map);
        let hook = on_view_destroyed(services, move |view| {
            if let Some(map) = weak.upgrade() {
                // dropped outside the borrow: a value's Drop may reach the map
                let gone = map.borrow_mut().remove(&view);
                drop(gone);
            }
        });
        ViewMap { map, _hook: hook }
    }
}

impl<T> ViewMap<T> {
    pub fn insert(&self, view: ViewId, value: T) -> Option<T> {
        self.map.borrow_mut().insert(view, value)
    }

    pub fn remove(&self, view: ViewId) -> Option<T> {
        self.map.borrow_mut().remove(&view)
    }

    pub fn contains(&self, view: ViewId) -> bool {
        self.map.borrow().contains_key(&view)
    }

    /// `map.get(id)`, cloned out so no borrow outlives the call
    pub fn get(&self, view: ViewId) -> Option<T>
    where
        T: Clone,
    {
        self.map.borrow().get(&view).cloned()
    }

    /// Reads or changes one view's entry. `f` must not reach this map again.
    pub fn with<R>(&self, view: ViewId, f: impl FnOnce(Option<&mut T>) -> R) -> R {
        f(self.map.borrow_mut().get_mut(&view))
    }

    pub fn views(&self) -> Vec<ViewId> {
        self.map.borrow().keys().copied().collect()
    }
}

/// A pending `setTimeout`; [`clear`] it as `clearTimeout`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Timer(u64);

thread_local! {
    static TIMERS: RefCell<HashMap<u64, Box<dyn FnOnce()>>> = RefCell::new(HashMap::new());
}

fn fire(id: u64) {
    let f = TIMERS.with(|timers| timers.borrow_mut().remove(&id));
    if let Some(f) = f {
        f()
    }
}

/// `setTimeout(f, delay)`: `f` runs on the core thread unless cleared first
pub(crate) fn after(services: &Services, delay: Duration, f: impl FnOnce() + 'static) -> Timer {
    let id = next_id();
    TIMERS.with(|timers| timers.borrow_mut().insert(id, Box::new(f)));
    #[cfg(not(test))]
    {
        let core = services.core.clone();
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            core.post(Box::new(move || fire(id)));
        });
    }
    #[cfg(test)]
    {
        let _ = services;
        crate::testing::schedule(delay, id);
    }
    Timer(id)
}

/// `clearTimeout(timer)`
pub(crate) fn clear(timer: Timer) {
    TIMERS.with(|timers| timers.borrow_mut().remove(&timer.0));
}

#[cfg(test)]
pub(crate) fn fire_timer(id: u64) {
    fire(id)
}

/// A number no other call in this process gets (temporary names)
pub(crate) fn unique() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_drops_undefined_members_and_nulls_holes() {
        let v = IpcValue::Object(vec![
            ("a".into(), IpcValue::Undefined),
            (
                "b".into(),
                IpcValue::Array(vec![IpcValue::Undefined, IpcValue::Number(f64::NAN)]),
            ),
            ("c".into(), IpcValue::Number(1.0)),
            ("d".into(), IpcValue::Number(1.5)),
        ]);
        assert_eq!(
            to_json(&v).unwrap().to_string(),
            r#"{"b":[null,null],"c":1,"d":1.5}"#
        );
        assert_eq!(to_json(&IpcValue::Undefined), None);
    }

    #[test]
    fn json_round_trip_keeps_key_order() {
        let v = obj([
            ("z", 1.0.into_ipc()),
            ("a", "x".into_ipc()),
            ("m", None::<String>.into_ipc()),
        ]);
        assert_eq!(from_json(&to_json(&v).unwrap()), v);
        assert_eq!(from_js_json(&to_js_json(&v).unwrap()), v);
    }

    #[test]
    fn args_read_missing_as_undefined() {
        let args = Args(vec!["p".into_ipc()]);
        assert_eq!(args.str(0), Some("p"));
        assert_eq!(args.get(3), &IpcValue::Undefined);
        assert_eq!(args.num(0), None);
    }
}
