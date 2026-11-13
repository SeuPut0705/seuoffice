//! `mcp-queries.ts`: questions the in-app MCP server asks an open diagram:
//! the read table (every page, one page, or the page on screen) and a list of
//! ops to apply. The renderer answers on `read-result` / `apply-result` with
//! the id of the question; the stored continuation is resumed there.
//!
//! A read the renderer has not answered is sent again every 250 ms until an
//! answer comes or 30 s pass (it stays silent while draw.io starts). An apply
//! is never sent twice: it waits for a read to be answered first (proof that
//! the editor listens and has a diagram), then asks once. Applies to one view
//! run one after another.

use std::time::Duration;

use jscompat::random_uuid;
use shell_contract::ipc::CallContext;
use shell_contract::{IpcError, IpcValue, ViewId};

use super::DiagramViews;
use super::state::{ApplyDone, ApplyJob, ApplyWaiter, PageRead, ReadDone, ReadWaiter};
use crate::value::{Args, field, obj, string};

/// How long a read waits for the renderer before giving up
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// How long an apply waits: a Mermaid conversion runs inside it
const APPLY_TIMEOUT: Duration = Duration::from_secs(120);
/// How often an unanswered read is sent again
const RESEND: Duration = Duration::from_millis(250);

const GONE: &str = "the diagram is no longer open";

/// Which read table: `page` names one page (id or name), `Current` the page
/// on screen with the ids selected there, `All` every page
#[derive(Clone, Debug, PartialEq)]
pub enum ReadScope {
    All,
    Page(String),
    Current,
}

/// `String(value)` for what a renderer's error field may hold
pub(super) fn js_string(value: &IpcValue) -> String {
    match value {
        IpcValue::Undefined => "undefined".into(),
        IpcValue::Null => "null".into(),
        IpcValue::Bool(flag) => flag.to_string(),
        IpcValue::Number(x) => jscompat::number_to_string(*x),
        IpcValue::String(text) => text.clone(),
        IpcValue::Date(_) => "Invalid Date".into(),
        IpcValue::Bytes(..) => "[object ArrayBuffer]".into(),
        IpcValue::Array(items) => items
            .iter()
            .map(|item| match item {
                IpcValue::Undefined | IpcValue::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        IpcValue::Object(_) => "[object Object]".into(),
    }
}

fn has_key(value: &IpcValue, key: &str) -> bool {
    matches!(value, IpcValue::Object(entries) if entries.iter().any(|(name, _)| name == key))
}

fn is_object(value: &IpcValue) -> bool {
    matches!(value, IpcValue::Object(_) | IpcValue::Array(_))
}

/// `pageTableOf(read)`: the renderer's one-page table, when it is shaped like one
fn page_table_of(read: &IpcValue) -> Option<(IpcValue, IpcValue)> {
    if !is_object(read) {
        return None;
    }
    let pages = field(read, "pages");
    let page = field(read, "page");
    if !matches!(pages, IpcValue::Array(_)) || !is_object(page) {
        return None;
    }
    let is_list = |key: &str| matches!(field(page, key), IpcValue::Array(_));
    if !is_list("shapes") || !is_list("edges") {
        return None;
    }
    Some((pages.clone(), page.clone()))
}

impl DiagramViews {
    /// `askRead(contents, scope)`: ask for the read table, sending again
    /// until the renderer answers
    fn ask_read(&self, view: ViewId, scope: ReadScope, done: ReadDone) {
        if !self.alive(view) {
            return done(Err(GONE.into()));
        }
        let id = random_uuid();
        let query = match &scope {
            ReadScope::All => obj([("id", string(&id))]),
            ReadScope::Page(page) => obj([("id", string(&id)), ("page", string(page))]),
            ReadScope::Current => obj([("id", string(&id)), ("current", IpcValue::Bool(true))]),
        };
        self.with_state(|state| state.reads.insert(id.clone(), ReadWaiter { view, done }));
        self.emit(view, "diagram:read-request", vec![query.clone()]);
        self.read_tick(id, view, query, Duration::ZERO);
    }

    /// the resend interval and the timeout of one read
    fn read_tick(&self, id: String, view: ViewId, query: IpcValue, elapsed: Duration) {
        self.after(RESEND, move |views| {
            let elapsed = elapsed + RESEND;
            if !views.with_state(|state| state.reads.contains_key(&id)) {
                return;
            }
            if !views.alive(view) {
                return views.settle_read(&id, Err(GONE.into()));
            }
            if elapsed >= READ_TIMEOUT {
                return views.settle_read(&id, Err("timed out reading the diagram".into()));
            }
            views.emit(view, "diagram:read-request", vec![query.clone()]);
            views.read_tick(id, view, query, elapsed);
        });
    }

    fn settle_read(&self, id: &str, result: Result<PageRead, String>) {
        if let Some(waiter) = self.with_state(|state| state.reads.remove(id)) {
            (waiter.done)(result);
        }
    }

    /// `diagramReadText(contents)`: every page as the read table text, unsaved
    /// edits included
    pub fn read_text(&self, view: ViewId, done: Box<dyn FnOnce(Result<String, String>)>) {
        self.ask_read(
            view,
            ReadScope::All,
            Box::new(move |read| done(read.map(|read| read.text))),
        );
    }

    /// `diagramReadPage(contents, page)`: one page as the read table, text and
    /// values, with the page list: `page` by id or name, or the page on
    /// screen when it is left out
    pub fn read_page(&self, view: ViewId, page: Option<&str>, done: ReadDone) {
        let scope = match page.filter(|p| !p.is_empty()) {
            Some(page) => ReadScope::Page(page.to_owned()),
            None => ReadScope::Current,
        };
        self.ask_read(view, scope, done);
    }

    /// `diagramApplyOps(contents, ops)`: plan `ops` against the live diagram
    /// and apply them as one undo step, all or nothing. Resolves with the
    /// renderer's result; rejects when the editor cannot be asked.
    pub fn apply_ops(&self, view: ViewId, ops: Vec<IpcValue>, done: ApplyDone) {
        if !self.alive(view) {
            return done(Err(GONE.into()));
        }
        let first = self.with_state(|state| {
            let queue = state.apply_chains.entry(view).or_default();
            queue.push_back(ApplyJob {
                ops: IpcValue::Array(ops),
                done,
            });
            queue.len() == 1
        });
        if first {
            self.run_apply(view);
        }
    }

    fn run_apply(&self, view: ViewId) {
        let ops = self.with_state(|state| {
            state
                .apply_chains
                .get(&view)
                .and_then(|queue| queue.front())
                .map(|job| job.ops.clone())
        });
        let Some(ops) = ops else { return };
        let views = self.clone();
        // the read answers only once draw.io is up with a diagram
        self.ask_read(
            view,
            ReadScope::Current,
            Box::new(move |read| match read {
                Err(error) => views.finish_apply(view, Err(error)),
                Ok(_) => {
                    let next = views.clone();
                    views.ask_apply(
                        view,
                        ops,
                        Box::new(move |result| next.finish_apply(view, result)),
                    );
                }
            }),
        );
    }

    fn finish_apply(&self, view: ViewId, result: Result<IpcValue, String>) {
        let (job, more) = self
            .with_state(|state| {
                let queue = state.apply_chains.get_mut(&view)?;
                let job = queue.pop_front();
                let more = !queue.is_empty();
                if !more {
                    state.apply_chains.remove(&view);
                }
                Some((job, more))
            })
            .unwrap_or((None, false));
        if let Some(job) = job {
            (job.done)(result);
        }
        if more {
            self.run_apply(view);
        }
    }

    /// `askApply(contents, ops)`: no resend, only a watch for a view that went away
    fn ask_apply(&self, view: ViewId, ops: IpcValue, done: ApplyDone) {
        if !self.alive(view) {
            return done(Err(GONE.into()));
        }
        let id = random_uuid();
        self.with_state(|state| state.applies.insert(id.clone(), ApplyWaiter { view, done }));
        self.emit(
            view,
            "diagram:apply-request",
            vec![obj([("id", string(&id)), ("ops", ops)])],
        );
        self.apply_tick(id, view, Duration::ZERO);
    }

    fn apply_tick(&self, id: String, view: ViewId, elapsed: Duration) {
        self.after(RESEND, move |views| {
            let elapsed = elapsed + RESEND;
            if !views.with_state(|state| state.applies.contains_key(&id)) {
                return;
            }
            if !views.alive(view) {
                return views.settle_apply(&id, Err(GONE.into()));
            }
            if elapsed >= APPLY_TIMEOUT {
                return views.settle_apply(
                    &id,
                    Err("timed out applying the ops: the diagram may or may not have changed; read it again before retrying".into()),
                );
            }
            views.apply_tick(id, view, elapsed);
        });
    }

    fn settle_apply(&self, id: &str, result: Result<IpcValue, String>) {
        if let Some(waiter) = self.with_state(|state| state.applies.remove(id)) {
            (waiter.done)(result);
        }
    }

    /// A view that went away answers nothing any more
    pub(super) fn fail_queries_of(&self, view: ViewId) {
        let reads: Vec<String> = self.with_state(|state| {
            state
                .reads
                .iter()
                .filter(|(_, w)| w.view == view)
                .map(|(id, _)| id.clone())
                .collect()
        });
        for id in reads {
            self.settle_read(&id, Err(GONE.into()));
        }
        let applies: Vec<String> = self.with_state(|state| {
            state
                .applies
                .iter()
                .filter(|(_, w)| w.view == view)
                .map(|(id, _)| id.clone())
                .collect()
        });
        for id in applies {
            self.settle_apply(&id, Err(GONE.into()));
        }
    }

    // ---- handlers ----

    pub(super) fn read_result(&self, cx: &CallContext, args: Args) -> Result<(), IpcError> {
        let reply = args.get(0);
        let Some(id) = self.answered_id(cx.sender.view, reply, true) else {
            return Ok(());
        };
        if has_key(reply, "text")
            && let IpcValue::String(text) = field(reply, "text")
        {
            let table = page_table_of(field(reply, "read"));
            let read = match table {
                Some((pages, page)) => PageRead {
                    text: text.clone(),
                    pages: Some(pages),
                    page: Some(page),
                },
                None => PageRead {
                    text: text.clone(),
                    pages: None,
                    page: None,
                },
            };
            self.settle_read(&id, Ok(read));
        } else if has_key(reply, "error") {
            self.settle_read(&id, Err(js_string(field(reply, "error"))));
        }
        Ok(())
    }

    pub(super) fn apply_result(&self, cx: &CallContext, args: Args) -> Result<(), IpcError> {
        let reply = args.get(0);
        let Some(id) = self.answered_id(cx.sender.view, reply, false) else {
            return Ok(());
        };
        match field(reply, "ok") {
            IpcValue::Bool(true) => self.settle_apply(&id, Ok(field(reply, "result").clone())),
            IpcValue::Bool(false) => self.settle_apply(&id, Err(js_string(field(reply, "error")))),
            _ => {}
        }
        Ok(())
    }

    /// The id of the question a reply answers, when it counts: an object with
    /// a string id of a waiting question, from the view that was asked
    fn answered_id(&self, sender: ViewId, reply: &IpcValue, read: bool) -> Option<String> {
        if !is_object(reply) {
            return None;
        }
        let IpcValue::String(id) = field(reply, "id") else {
            return None;
        };
        let asked = self.with_state(|state| {
            if read {
                state.reads.get(id).map(|w| w.view)
            } else {
                state.applies.get(id).map(|w| w.view)
            }
        });
        (asked == Some(sender)).then(|| id.clone())
    }

    /// `diagram:bytes-result`: the TypeScript registers no listener, so the
    /// renderer's reply goes nowhere
    pub(super) fn bytes_result(&self, _cx: &CallContext, _args: Args) -> Result<(), IpcError> {
        Ok(())
    }
}
