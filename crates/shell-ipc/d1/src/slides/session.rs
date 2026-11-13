//! The helpers every slides handler shares: the lookup of the sender's
//! session, the journaled transaction pipeline of `slides-main.ts`
//! (`journaledTxn`, `sessionTxn`), history and deck broadcast scheduling with
//! its `setImmediate` flush, `rebuildSlide`, `buildSlideUpdate`, and the
//! small object and number helpers the TypeScript shims lean on.
//!
//! A handler of an edit channel is, in this crate:
//!
//! ```ignore
//! fn edit_x(app: &App, cx: &CallContext, args: Args) -> Reply {
//!     let op = args.get(0);
//!     app.with_session(cx.sender.view, |app, s| {
//!         let slide_index = prop(op, "slideIndex")?;
//!         let r = app.session_txn(s, TxnRequest::atomic(vec![ /* ops */ ]), OpSource::Edit);
//!         Ok(match r { Some(_) => or_null(app.rebuild_slide(s, slide_index)), None => Null })
//!     })
//! }
//! ```
//!
//! Every handler wrapper ([`super::now`], [`super::later`], [`super::on`])
//! calls [`App::pump`] after the handler, which queues the flushes the
//! sessions scheduled (what `setImmediate` did).

use main_core::packages::i18n::Lang;
use main_core::slides::session_state::{
    DeckBroadcast, OpRecord, OpSource, Scheduled, SlideUpdate, plan_slide_update,
};
use shell_contract::ipc::Target;
use shell_contract::{IpcError, IpcValue, ViewId};

use super::engine::{DeckSize, TxnRequest, TxnResult};
use super::i18n::tm;
use super::state::{App, RenderSlide, SlideSession};
use crate::value::{as_num, field, is_nullish, num, obj, string};
use jscompat::JsonValue;

/// `EMU_PER_PX_96`
pub const EMU_PER_PX_96: f64 = 9525.0;
/// `EMU_PER_PT`
pub const EMU_PER_PT: f64 = 12700.0;

/// `Math.round`: halves go up
pub fn js_round(x: f64) -> f64 {
    if x.is_nan() || x.is_infinite() {
        return x;
    }
    (x + 0.5).floor()
}

/// `op.key` of an argument the TypeScript reads without a guard: a read on
/// `null` or `undefined` throws a `TypeError`
pub fn prop<'a>(value: &'a IpcValue, key: &str) -> Result<&'a IpcValue, IpcError> {
    if is_nullish(value) {
        let what = if matches!(value, IpcValue::Null) {
            "null"
        } else {
            "undefined"
        };
        return Err(IpcError {
            name: Some("TypeError".into()),
            message: format!("Cannot read properties of {what} (reading '{key}')"),
        });
    }
    Ok(field(value, key))
}

pub fn null() -> Result<IpcValue, IpcError> {
    Ok(IpcValue::Null)
}

/// An object literal built key by key, with `...(cond ? { k: v } : {})`
#[derive(Default)]
pub struct Obj(Vec<(String, IpcValue)>);

impl Obj {
    pub fn new() -> Self {
        Obj::default()
    }

    /// An object continued: its keys first (anything else starts empty)
    pub fn from_value(value: IpcValue) -> Self {
        match value {
            IpcValue::Object(entries) => Obj(entries),
            _ => Obj::default(),
        }
    }

    pub fn set(mut self, key: &str, value: IpcValue) -> Self {
        self.0.push((key.to_owned(), value));
        self
    }

    pub fn set_if(self, cond: bool, key: &str, value: impl FnOnce() -> IpcValue) -> Self {
        if cond { self.set(key, value()) } else { self }
    }

    pub fn build(self) -> IpcValue {
        IpcValue::Object(self.0)
    }
}

/// `{ slide }` or `{ slide, el }`
pub fn target(slide: &IpcValue, el: Option<&IpcValue>) -> IpcValue {
    match el {
        Some(el) => obj([("slide", slide.clone()), ("el", el.clone())]),
        None => obj([("slide", slide.clone())]),
    }
}

/// `{ op: name, ...rest }`
pub fn op(name: &str) -> Obj {
    Obj::new().set("op", string(name))
}

/// `{ x, y, cx, cy }` of a box in px converted to EMU at `scale`
pub fn emu_box(scale: f64, x: f64, y: f64, w: f64, h: f64) -> IpcValue {
    let to_emu = |px: f64| js_round((px / scale) * EMU_PER_PX_96);
    obj([
        ("x", num(to_emu(x))),
        ("y", num(to_emu(y))),
        ("cx", num(to_emu(w))),
        ("cy", num(to_emu(h))),
    ])
}

/// A number read like `op.xPx` of a loosely typed argument; a non-number is
/// `NaN` as arithmetic would make it
pub fn number(value: &IpcValue) -> f64 {
    as_num(value).unwrap_or(f64::NAN)
}

pub fn array_of_strings(items: &[String]) -> IpcValue {
    IpcValue::Array(items.iter().map(|s| string(s.as_str())).collect())
}

impl App {
    pub fn lang(&self) -> Lang {
        self.locale.ui_lang()
    }

    /// `tm(key, params)`
    pub fn tm(&self, key: &str, params: &[(&str, JsonValue)]) -> String {
        tm(self.lang(), key, params)
    }

    pub fn emit(&self, view: ViewId, channel: &'static str, args: Vec<IpcValue>) {
        self.services.events.emit(Target::View(view), channel, args)
    }

    /// `setImmediate(job)`: runs on the core thread after the current
    /// handler has returned (and released the state). The job may be
    /// posted from any thread; it finds the app again on the core thread.
    pub fn post(&self, job: impl FnOnce(&App) + Send + 'static) {
        super::post_to(&self.services, self.registry_index, job)
    }

    /// `sessions.get(view)` of a handler that answers `null` without one
    pub fn with_session(
        &self,
        view: ViewId,
        f: impl FnOnce(&App, &mut SlideSession) -> Result<IpcValue, IpcError>,
    ) -> Result<IpcValue, IpcError> {
        let mut state = self.state.borrow_mut();
        match state.session_mut(view) {
            Some(session) => f(self, session),
            None => null(),
        }
    }

    /// `sessions.get(view)` of a handler that answers `default` without one
    pub fn with_session_or(
        &self,
        view: ViewId,
        default: IpcValue,
        f: impl FnOnce(&App, &mut SlideSession) -> Result<IpcValue, IpcError>,
    ) -> Result<IpcValue, IpcError> {
        let mut state = self.state.borrow_mut();
        match state.session_mut(view) {
            Some(session) => f(self, session),
            None => Ok(default),
        }
    }

    /// `{ cx, cy }` of the deck
    pub fn size_value(&self, size: DeckSize) -> IpcValue {
        obj([("cx", num(size.cx)), ("cy", num(size.cy))])
    }

    /// `rebuildSlide(session, slideIndex)`: `None` for a page the deck lacks
    pub fn rebuild_slide(&self, s: &SlideSession, index: &IpcValue) -> Option<IpcValue> {
        let index = slide_index(index, self.engine.slide_paths(s.deck()).len())?;
        self.engine
            .render_slide(s.deck(), index, s.fit_width_px, false)
    }

    /// `rebuildSlideWithReparse(session, slideIndex)`
    pub fn rebuild_slide_with_reparse(
        &self,
        s: &SlideSession,
        index: &IpcValue,
    ) -> Option<IpcValue> {
        let index = slide_index(index, self.engine.slide_paths(s.deck()).len())?;
        self.engine
            .render_slide(s.deck(), index, s.fit_width_px, true)
    }

    /// `buildAllRenderSlides(session.opened, session.fitWidthPx)`
    pub fn render_all(&self, s: &SlideSession) -> IpcValue {
        IpcValue::Array(self.engine.render_all(s.deck(), s.fit_width_px))
    }

    /// `session.opened.deck.slides.map((_, i) => rebuildSlide(session, i))`
    pub fn rebuild_every_slide(&self, s: &SlideSession) -> IpcValue {
        let count = self.engine.slide_paths(s.deck()).len();
        IpcValue::Array(
            (0..count)
                .map(|i| {
                    self.engine
                        .render_slide(s.deck(), i, s.fit_width_px, false)
                        .unwrap_or(IpcValue::Null)
                })
                .collect(),
        )
    }

    /// `journaledTxn(session, source, req)`: every applied batch lands in the
    /// session's op journal and schedules the deck broadcast
    pub fn journaled_txn(
        &self,
        s: &mut SlideSession,
        source: OpSource,
        request: &TxnRequest,
    ) -> TxnResult {
        let result = self.engine.run_txn(s.deck(), request);
        if result.applied {
            let records = result
                .records
                .iter()
                .flatten()
                .map(|record| OpRecord {
                    op: record.op.clone(),
                    slide_id: record.slide_id.clone(),
                    created: record.created.clone(),
                })
                .collect();
            s.core.journal_ops(source, records);
            s.core.schedule_deck_broadcast();
        }
        result
    }

    /// `sessionTxn(session, req, source)`: one undo step wrapping a
    /// transaction; planned first so an invalid request never touches
    /// history, and the step is erased when nothing applied
    pub fn session_txn(
        &self,
        s: &mut SlideSession,
        request: TxnRequest,
        source: OpSource,
    ) -> Option<TxnResult> {
        let plan = self.engine.run_txn(s.deck(), &request.dry());
        let invalid = plan.failure_count();
        let refused = match request.isolation {
            super::engine::Isolation::Atomic => invalid > 0,
            super::engine::Isolation::PerOp => invalid >= request.ops.len(),
        };
        if refused {
            return None;
        }
        s.core.push_history();
        let result = self.journaled_txn(s, source, &request);
        if !result.applied {
            s.core.undo_stack.pop();
            return None;
        }
        Some(result)
    }

    /// `pushHistory(session)`, the transaction, and `undoStack.pop()` when it
    /// applied nothing: the shape of the shims that call `journaledTxn`
    /// themselves
    pub fn push_and_journal(
        &self,
        s: &mut SlideSession,
        source: OpSource,
        request: &TxnRequest,
    ) -> Option<TxnResult> {
        s.core.push_history();
        let result = self.journaled_txn(s, source, request);
        if !result.applied {
            s.core.undo_stack.pop();
            return None;
        }
        Some(result)
    }

    /// `buildSlideUpdate(session, before, changed)`
    pub fn build_slide_update(
        &self,
        s: &mut SlideSession,
        before: &[String],
        changed: &[f64],
    ) -> IpcValue {
        let refs = self.engine.slide_refs(s.deck());
        let (order, rebuild) = plan_slide_update(&refs, before, changed);
        let slides: Vec<RenderSlide> = rebuild
            .iter()
            .map(|i| {
                RenderSlide(
                    self.engine
                        .render_slide(s.deck(), *i, s.fit_width_px, false)
                        .unwrap_or(IpcValue::Null),
                )
            })
            .collect();
        let value = obj([
            ("order", array_of_strings(&order)),
            (
                "slides",
                IpcValue::Array(slides.iter().map(|r| r.0.clone()).collect()),
            ),
        ]);
        s.core.note_slide_update(SlideUpdate { order, slides });
        value
    }

    /// The `{ path, slides, size, defaultFont }` an open answers
    pub fn open_result(&self, s: &SlideSession, slides: IpcValue) -> IpcValue {
        let deck = s.deck();
        obj([
            ("path", string(s.path())),
            ("slides", slides),
            ("size", self.size_value(self.engine.size(deck))),
            (
                "defaultFont",
                self.engine
                    .default_font(deck)
                    .map_or(IpcValue::Undefined, string),
            ),
        ])
    }

    /// `sessionDirty(session)`
    pub fn session_dirty(&self, s: &SlideSession) -> bool {
        s.core.meta_dirty || self.engine.slides_dirty(s.deck())
    }

    /// Queues what the sessions scheduled with `setImmediate`
    pub fn pump(&self) {
        let jobs: Vec<(usize, Scheduled)> = {
            let mut state = self.state.borrow_mut();
            let mut jobs = Vec::new();
            for slot in state.live_slots() {
                if let Some(session) = state.slot_mut(slot) {
                    for scheduled in session.core.take_scheduled() {
                        jobs.push((slot, scheduled));
                    }
                }
            }
            jobs
        };
        for (slot, scheduled) in jobs {
            self.post(move |app| app.flush(slot, scheduled));
        }
    }

    /// The callbacks of `scheduleHistoryNotify` and `scheduleDeckBroadcast`
    fn flush(&self, slot: usize, scheduled: Scheduled) {
        let sends: Vec<(ViewId, &'static str, IpcValue)> = {
            let mut state = self.state.borrow_mut();
            let attached = state.attached_ids(slot);
            let Some(session) = state.slot_mut(slot) else {
                return;
            };
            match scheduled {
                Scheduled::HistoryNotify => {
                    let changed = session.core.flush_history_notify();
                    let payload = obj([
                        ("canUndo", IpcValue::Bool(changed.can_undo)),
                        ("canRedo", IpcValue::Bool(changed.can_redo)),
                        ("aiRunActive", IpcValue::Bool(changed.ai_run_active)),
                    ]);
                    attached
                        .into_iter()
                        .map(|view| (view, "slides:history-changed", payload.clone()))
                        .collect()
                }
                Scheduled::DeckBroadcast => {
                    let plan = session.core.flush_deck_broadcast(attached.len());
                    let size = self.size_value(self.engine.size(session.deck()));
                    let payload = match plan {
                        DeckBroadcast::Nothing => return,
                        DeckBroadcast::Partial { order, slides } => obj([
                            ("order", array_of_strings(&order)),
                            (
                                "slides",
                                IpcValue::Array(slides.into_iter().map(|r| r.0).collect()),
                            ),
                            ("size", size),
                        ]),
                        DeckBroadcast::Full => {
                            obj([("slides", self.render_all(session)), ("size", size)])
                        }
                    };
                    attached
                        .into_iter()
                        .map(|view| (view, "slides:deck-changed", payload.clone()))
                        .collect()
                }
            }
        };
        for (view, channel, payload) in sends {
            self.emit(view, channel, vec![payload]);
        }
    }
}

/// `slides[index]` of a number that may not index anything: the index when
/// it is a whole number below `len`
pub fn slide_index(value: &IpcValue, len: usize) -> Option<usize> {
    let x = as_num(value)?;
    if x.fract() != 0.0 || x < 0.0 || x >= len as f64 {
        return None;
    }
    Some(x as usize)
}

/// `String(value)` of a loosely typed argument
pub fn js_string(value: &IpcValue) -> String {
    match value {
        IpcValue::Undefined => "undefined".into(),
        IpcValue::Null => "null".into(),
        IpcValue::Bool(flag) => flag.to_string(),
        IpcValue::Number(x) => jscompat::number_to_string(*x),
        IpcValue::String(text) => text.clone(),
        IpcValue::Array(items) => items
            .iter()
            .map(|i| match i {
                IpcValue::Undefined | IpcValue::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => "[object Object]".into(),
    }
}
