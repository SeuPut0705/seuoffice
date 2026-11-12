//! `apps/html/src/main/generate-handoff-ipc.ts`.
//!
//! The HTML editor's side of the generate hand-off (8.5). The shell queues a
//! request for a new untitled tab; the panel in that tab takes it here, once,
//! and reports when a run started with handed-over material attached. Nothing
//! here starts a run or picks a provider.
//!
//! `ipcMain.handle(channel, handler)` is the trait [`HandoffIpc`]; the store
//! the TypeScript reaches through `@seuoffice/electron-utils/generate-handoff`
//! is the one [`HandoffStore`] the owner shares, behind `Rc<RefCell<_>>` (the
//! store holds a resolver closure, so it does not cross threads). The handlers
//! are boxed closures the owner calls with the event and the arguments of an
//! `invoke`.

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{Map, Value};

use crate::packages::electron_utils::generate_handoff::{GenerateHandoffTarget, HandoffStore};

/// `HTML_HANDOFF_CHANNELS`: `invoke` -> `HtmlGenerateHandoff | null`, the
/// request left for this view, once
pub const HTML_HANDOFF_TAKE: &str = "html:handoff-take";
/// `invoke(attachedPaths: string[])` -> `boolean`: a run started with
/// handed-over material attached
pub const HTML_HANDOFF_RUN_STARTED: &str = "html:handoff-run-started";

/// `HandoffEvent`: `{ sender: { id } }`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HandoffEvent {
    pub sender_id: f64,
}

/// What a handler answers: a value, or the message of what it throws.
pub type HandoffReply = Result<Value, String>;

/// `(event, ...args) => unknown`
pub type HandoffHandler = Box<dyn FnMut(&HandoffEvent, &[Value]) -> HandoffReply>;

/// `HandoffIpc`: the part of ipcMain this module needs
pub trait HandoffIpc {
    fn handle(&mut self, channel: &str, handler: HandoffHandler);
}

/// `registerHtmlHandoffIpc(ipc, openedOnFile)`: registers `html:handoff-take`
/// and `html:handoff-run-started`. `opened_on_file` tells whether a view was
/// opened on an existing file: such a tab never takes. `now_ms` is `Date.now()`
/// of the report.
pub fn register_html_handoff_ipc(
    ipc: &mut dyn HandoffIpc,
    store: Rc<RefCell<HandoffStore>>,
    mut opened_on_file: Box<dyn FnMut(f64) -> bool>,
    mut now_ms: Box<dyn FnMut() -> f64>,
) {
    let take_store = Rc::clone(&store);
    ipc.handle(
        HTML_HANDOFF_TAKE,
        Box::new(move |event, _args| {
            let id = event.sender_id;
            if opened_on_file(id) {
                return Ok(Value::Null);
            }
            let handoff = take_store
                .borrow_mut()
                .take_generate_handoff(GenerateHandoffTarget::Html, id);
            let Some(handoff) = handoff else {
                return Ok(Value::Null);
            };
            let mut out = Map::new();
            out.insert("id".into(), Value::String(handoff.id));
            out.insert("text".into(), Value::String(handoff.text));
            out.insert(
                "materials".into(),
                Value::Array(
                    handoff
                        .materials
                        .into_iter()
                        .map(|material| {
                            let mut item = Map::new();
                            item.insert("path".into(), Value::String(material.path));
                            item.insert("name".into(), Value::String(material.name));
                            Value::Object(item)
                        })
                        .collect(),
                ),
            );
            Ok(Value::Object(out))
        }),
    );

    ipc.handle(
        HTML_HANDOFF_RUN_STARTED,
        Box::new(move |event, args| {
            let Some(Value::Array(attached)) = args.first() else {
                return Ok(Value::Bool(false));
            };
            let paths: Vec<String> = attached
                .iter()
                .filter_map(|path| path.as_str().map(str::to_owned))
                .collect();
            let now = now_ms();
            let recorded = store.borrow_mut().report_generate_run_started(
                GenerateHandoffTarget::Html,
                event.sender_id,
                &paths,
                now,
            )?;
            Ok(Value::Bool(recorded.is_some()))
        }),
    );
}
