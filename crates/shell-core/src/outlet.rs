//! Everything the shell sends a renderer goes through one ordered stream per
//! view (the stage 3 shell contract, section 2, "order"): replies and events
//! alike, so a stream's chunks arrive before the reply of the invoke that
//! produced them. The shell's stream is a Tauri `ipc::Channel`; ipc-probe's
//! records.
//!
//! Frames on the stream (headers in the wire form of [`crate::wire`]):
//!
//! - a reply: `{"reply":id,"value":v}` or `{"reply":id,"error":text}`, `text`
//!   being Electron's `Error invoking remote method …` sentence
//! - an event: `{"event":channel,"args":[…]}`

use std::sync::Arc;

use serde_json::{Map, Value};
use shell_contract::ids::{RequestId, ViewId};
use shell_contract::ipc::{EventSink, Reply, Target};
use shell_contract::runtime::Views;
use shell_contract::value::IpcValue;

use crate::wire::{Encoder, frame};

/// One view's stream. Frames for one view are delivered in call order.
pub trait Outlet: Send + Sync {
    fn deliver(&self, view: ViewId, frame: Vec<u8>);
}

pub fn reply_frame(id: RequestId, channel: &str, reply: &Reply) -> Vec<u8> {
    let mut e = Encoder::default();
    let mut map = Map::new();
    map.insert("reply".into(), Value::from(id.0));
    match reply {
        Ok(value) => map.insert("value".into(), e.value(value)),
        Err(err) => map.insert("error".into(), Value::String(err.remote_message(channel))),
    };
    frame(&Value::Object(map), &e.buffers)
}

pub fn event_frame(channel: &str, args: &[IpcValue]) -> Vec<u8> {
    let mut e = Encoder::default();
    let mut map = Map::new();
    map.insert("event".into(), Value::String(channel.into()));
    map.insert("args".into(), e.values(args));
    frame(&Value::Object(map), &e.buffers)
}

/// The views a target names, in the order [`Views::all`] lists them
pub fn resolve(views: &dyn Views, target: Target) -> Vec<ViewId> {
    match target {
        Target::View(view) => vec![view],
        Target::Window(window) => views
            .all()
            .into_iter()
            .filter(|s| s.window == window)
            .map(|s| s.view)
            .collect(),
        Target::Surface(surface) => views
            .all()
            .into_iter()
            .filter(|s| s.surface == surface)
            .map(|s| s.view)
            .collect(),
        Target::All => views.all().into_iter().map(|s| s.view).collect(),
    }
}

/// [`EventSink`] over the views' streams
pub struct OutletSink {
    pub outlet: Arc<dyn Outlet>,
    pub views: Arc<dyn Views>,
}

impl EventSink for OutletSink {
    fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
        let frame = event_frame(channel, &args);
        for view in resolve(self.views.as_ref(), target) {
            self.outlet.deliver(view, frame.clone());
        }
    }
}
