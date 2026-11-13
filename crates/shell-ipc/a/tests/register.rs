//! Batch A against the shell's start-up check: every channel of the batch
//! is registered once, with the kind renderers use, and reaches its own
//! method; a shell without a port's factory does not start.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use shell_contract::ipc::{
    CallContext, ChannelKind, EventSink, Handler, RegisterError, Registry, Responder, Sender,
    Target,
};
use shell_contract::provided::Provided;
use shell_contract::runtime::{AppPaths, CancelToken, PathName, Services, Thread, Views, Workers};
use shell_contract::{Batch, CHANNELS, Hosts, IpcError, IpcValue, Surface, ViewId, WindowId};

/// The rules of `Registry::register` as the contract states them
#[derive(Default)]
struct Checked {
    handlers: BTreeMap<&'static str, (ChannelKind, Rc<dyn Handler>)>,
    provided: Rc<Provided>,
}

impl Registry for Checked {
    fn register(
        &mut self,
        by: Batch,
        channel: &'static str,
        kind: ChannelKind,
        handler: Rc<dyn Handler>,
    ) -> Result<(), RegisterError> {
        let spec = CHANNELS
            .iter()
            .find(|s| s.name == channel)
            .ok_or(RegisterError::Unknown(channel))?;
        if spec.batch != by {
            return Err(RegisterError::WrongBatch {
                channel,
                owner: spec.batch,
                by,
            });
        }
        if kind == ChannelKind::Event || !spec.kinds.contains(&kind) {
            return Err(RegisterError::WrongKind { channel, kind });
        }
        if self.handlers.insert(channel, (kind, handler)).is_some() {
            return Err(RegisterError::Twice(channel));
        }
        Ok(())
    }

    fn provided(&self) -> Rc<Provided> {
        self.provided.clone()
    }
}

struct Inline;
impl Thread for Inline {
    fn post(&self, job: Box<dyn FnOnce() + Send>) {
        job()
    }
    fn is_current(&self) -> bool {
        false
    }
}
impl Workers for Inline {
    fn spawn(&self, job: Box<dyn FnOnce() + Send>) {
        job()
    }
}
impl EventSink for Inline {
    fn emit(&self, _: Target, _: &'static str, _: Vec<IpcValue>) {}
}
impl Views for Inline {
    fn sender_of(&self, _: ViewId) -> Option<Sender> {
        None
    }
    fn all(&self) -> Vec<Sender> {
        Vec::new()
    }
    fn on_destroyed(&self, _: Box<dyn Fn(ViewId) + Send + Sync>) {}
}
impl AppPaths for Inline {
    fn path(&self, _: PathName) -> PathBuf {
        PathBuf::new()
    }
}

fn services(hosts: Hosts) -> Services {
    let inline = Arc::new(Inline);
    Services {
        ui: inline.clone(),
        core: inline.clone(),
        workers: inline.clone(),
        events: inline.clone(),
        views: inline.clone(),
        paths: inline,
        hosts: Arc::new(hosts),
    }
}

fn batch_a() -> BTreeMap<&'static str, &'static [ChannelKind]> {
    CHANNELS
        .iter()
        .filter(|s| s.batch == Batch::A)
        .map(|s| (s.name, s.kinds))
        .collect()
}

/// Every channel answers its own name, so a call that reaches another
/// channel's method shows
fn echo_case() -> serde_json::Value {
    serde_json::Value::Object(
        batch_a()
            .keys()
            .map(|name| {
                (
                    name.to_string(),
                    serde_json::Value::String(name.to_string()),
                )
            })
            .collect(),
    )
}

fn registered(case: &serde_json::Value) -> Checked {
    let mut hosts = Hosts::default();
    shell_ipc_a::fake_ports(&mut hosts, case);
    let mut registry = Checked::default();
    shell_ipc_a::register(&mut registry, &services(hosts)).expect("batch A registers");
    registry
}

#[test]
fn registers_every_handled_channel_of_the_batch_and_nothing_else() {
    let registry = registered(&serde_json::Value::Null);
    let expected: BTreeSet<_> = batch_a()
        .into_iter()
        .filter(|(_, kinds)| kinds.iter().any(|k| *k != ChannelKind::Event))
        .map(|(name, _)| name)
        .collect();
    let got: BTreeSet<_> = registry.handlers.keys().copied().collect();
    assert_eq!(got, expected);
}

#[test]
fn the_ports_name_each_channel_of_the_batch_once_with_its_kinds() {
    let mut seen: BTreeMap<&str, Vec<ChannelKind>> = BTreeMap::new();
    for (_, channels) in shell_ipc_a::port_table() {
        for c in channels {
            seen.entry(c.name).or_default().push(c.kind);
        }
    }
    let expected: BTreeMap<&str, Vec<ChannelKind>> = batch_a()
        .into_iter()
        .map(|(name, kinds)| (name, kinds.to_vec()))
        .collect();
    assert_eq!(seen, expected);
}

#[test]
fn each_channel_reaches_its_own_method() {
    let registry = registered(&echo_case());
    let cx = CallContext {
        sender: Sender {
            view: ViewId(1),
            window: WindowId(1),
            surface: Surface::Shell,
        },
        request: None,
        cancel: CancelToken::default(),
    };
    for (name, (_, handler)) in &registry.handlers {
        let got = Arc::new(Mutex::new(None));
        let slot = got.clone();
        handler.call(
            &cx,
            Vec::new(),
            Responder::new(move |r| *slot.lock().unwrap() = Some(r)),
        );
        let answer = got.lock().unwrap().take();
        assert_eq!(
            answer,
            Some(Ok(IpcValue::String(name.to_string()))),
            "{name}"
        );
    }
}

#[test]
fn a_thrown_answer_rejects_with_electron_text() {
    let case = serde_json::json!({ "skills:list": { "$throw": "nope" } });
    let registry = registered(&case);
    let (_, handler) = &registry.handlers["skills:list"];
    let got = Arc::new(Mutex::new(None));
    let slot = got.clone();
    let cx = CallContext {
        sender: Sender {
            view: ViewId(2),
            window: WindowId(1),
            surface: Surface::Docs,
        },
        request: None,
        cancel: CancelToken::default(),
    };
    handler.call(
        &cx,
        Vec::new(),
        Responder::new(move |r| *slot.lock().unwrap() = Some(r)),
    );
    let err: IpcError = got.lock().unwrap().take().unwrap().unwrap_err();
    assert_eq!(
        err.remote_message("skills:list"),
        "Error invoking remote method 'skills:list': Error: nope"
    );
}

#[test]
fn a_shell_without_a_port_does_not_start() {
    let mut registry = Checked::default();
    let err = shell_ipc_a::register(&mut registry, &services(Hosts::default())).unwrap_err();
    match err {
        RegisterError::MissingHost { batch, host } => {
            assert_eq!(batch, Batch::A);
            assert!(host.contains("Factory"), "{host}");
        }
        other => panic!("{other:?}"),
    }
}
