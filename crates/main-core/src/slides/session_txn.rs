//! `apps/slides/src/main/session-txn.ts`: the AI batch surface core
//! (`slides:apply-txn`), for any holder of a slides session. Raw ops arrive as
//! one transaction; the registry validates, the executor owns atomicity and
//! rollback, and a dry run rehearses the plan without touching the deck.
//!
//! What moved is the judgment of `applyTxnToSession`: the op-count gate, the
//! isolation, the dry run, the plan check before history is pushed, the
//! history push and drop, the post-pass choice per op record and the wire
//! shape of the answer. `runTxn`, `materializeSlide`, `slideDurableId`,
//! `rebuildSlide`, `rebuildSlideWithReparse`, `buildAllRenderSlides`,
//! `markMetaDirty` and the two autofit write-backs (pptx-ops, pptx-engine and
//! pptx-render are engine-waiting) are the [`TxnSession`] the caller
//! implements over its session; the holder's history bookkeeping is a
//! [`TxnHistory`]. Ops and records are JSON values: the registry owns their
//! shape.

use std::collections::HashMap;

use jscompat::{value_to_string, value_truthy};
use serde_json::{Map, Number, Value};

/// the most ops one transaction holds
pub const MAX_TXN_OPS: usize = 50;

/// `isolation` of a transaction
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Isolation {
    PerOp,
    Atomic,
}

impl Isolation {
    pub fn as_str(self) -> &'static str {
        match self {
            Isolation::PerOp => "per_op",
            Isolation::Atomic => "atomic",
        }
    }
}

/// one `{ index, error }` of a result's `failures`
#[derive(Debug, Clone, PartialEq)]
pub struct TxnFailure {
    pub index: f64,
    pub error: String,
}

/// `OpRecord`: an op the executor applied, as far as the post-pass reads it
#[derive(Debug, Clone, PartialEq)]
pub struct TxnOpRecord {
    /// the op, a JSON object (`op`, `target`, `group`, `format`, ...)
    pub op: Value,
    /// the executor-stamped durable id of the slide the op touched
    pub slide_id: Option<String>,
    pub created: Option<Vec<String>>,
    /// what the op left behind (`levelDirty` of a text op)
    pub after: Option<Value>,
}

/// `TxnResult` of pptx-ops
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TxnResult {
    pub applied: bool,
    pub plan: Option<Vec<Value>>,
    pub failures: Option<Vec<TxnFailure>>,
    pub records: Option<Vec<TxnOpRecord>>,
}

/// How the session's holder records one applied transaction (`TxnHistory`).
pub trait TxnHistory<S> {
    /// record the deck before the transaction as one undo step
    fn push(&mut self, session: &mut S);
    /// take back the step `push` recorded: the transaction applied nothing
    fn drop_step(&mut self, session: &mut S);
    /// run the transaction against the live deck
    fn run(&mut self, session: &mut S, ops: &[Value], isolation: Isolation) -> TxnResult;
}

/// The session as `applyTxnToSession` reaches it: `session.opened` and the
/// functions of pptx-engine, pptx-ops and session-state it is handed to.
pub trait TxnSession {
    /// what `rebuildSlide` answers (a render slide, or none)
    type Rendered;

    /// `runTxn(session.opened, { ops, isolation, dryRun: true })`
    fn run_dry(&mut self, ops: &[Value], isolation: Isolation) -> TxnResult;
    /// `markMetaDirty(session)`
    fn mark_meta_dirty(&mut self);
    /// `session.opened.deck.slides.findIndex((s) => slideDurableId(s) === id)`
    fn slide_index_of_durable_id(&mut self, id: &str) -> Option<usize>;
    /// `rebuildSlideWithReparse(session, index)`
    fn rebuild_slide_with_reparse(&mut self, index: usize);
    /// `materializeSlide(session.opened, index)`
    fn materialize_slide(&mut self, index: usize);
    /// `rebuildSlide(session, index)`
    fn rebuild_slide(&mut self, index: usize) -> Option<Self::Rendered>;
    /// `applyAutofitResize(session, index, sourceId, rendered)`
    fn apply_autofit_resize(
        &mut self,
        index: usize,
        source_id: &str,
        rendered: Option<Self::Rendered>,
    ) -> Option<Self::Rendered>;
    /// `syncAutofitScale(session, index, sourceId, rendered)`
    fn sync_autofit_scale(
        &mut self,
        index: usize,
        source_id: &str,
        rendered: Option<Self::Rendered>,
    ) -> Option<Self::Rendered>;
    /// `buildAllRenderSlides(session.opened, session.fitWidthPx)`
    fn build_all_render_slides(&mut self) -> Vec<Value>;
}

/// one entry of the answer's `records`: `{ op, target?, created? }`
#[derive(Debug, Clone, PartialEq)]
pub struct TxnRecordOut {
    /// `rec.op.op`; `None` when the op has none (the key is left out)
    pub op: Option<Value>,
    pub target: Option<String>,
    pub created: Option<Vec<String>>,
}

/// `ApplyTxnResult`
#[derive(Debug, Clone, PartialEq)]
pub enum ApplyTxnResult {
    /// `{ applied: false, failures }`
    Failed { failures: Option<Vec<TxnFailure>> },
    /// `{ applied: false, dryRun: true, plan, failures? }`
    DryRun {
        plan: Vec<Value>,
        failures: Option<Vec<TxnFailure>>,
    },
    /// `{ applied: true, records, failures?, slides }`
    Applied {
        records: Vec<TxnRecordOut>,
        failures: Option<Vec<TxnFailure>>,
        slides: Vec<Value>,
    },
}

fn failures_value(failures: &[TxnFailure]) -> Value {
    Value::Array(
        failures
            .iter()
            .map(|failure| {
                let mut map = Map::new();
                map.insert(
                    "index".into(),
                    Number::from_f64(failure.index).map_or(Value::Null, Value::Number),
                );
                map.insert("error".into(), Value::from(failure.error.as_str()));
                Value::Object(map)
            })
            .collect(),
    )
}

impl ApplyTxnResult {
    /// the answer as `JSON.stringify` writes it: keys in the order of the
    /// literals, `undefined` left out
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        match self {
            ApplyTxnResult::Failed { failures } => {
                map.insert("applied".into(), Value::Bool(false));
                if let Some(failures) = failures {
                    map.insert("failures".into(), failures_value(failures));
                }
            }
            ApplyTxnResult::DryRun { plan, failures } => {
                map.insert("applied".into(), Value::Bool(false));
                map.insert("dryRun".into(), Value::Bool(true));
                map.insert("plan".into(), Value::Array(plan.clone()));
                if let Some(failures) = failures {
                    map.insert("failures".into(), failures_value(failures));
                }
            }
            ApplyTxnResult::Applied {
                records,
                failures,
                slides,
            } => {
                map.insert("applied".into(), Value::Bool(true));
                map.insert(
                    "records".into(),
                    Value::Array(
                        records
                            .iter()
                            .map(|record| {
                                let mut out = Map::new();
                                if let Some(op) = &record.op {
                                    out.insert("op".into(), op.clone());
                                }
                                if let Some(target) = &record.target {
                                    out.insert("target".into(), Value::from(target.as_str()));
                                }
                                if let Some(created) = &record.created {
                                    out.insert(
                                        "created".into(),
                                        Value::Array(
                                            created
                                                .iter()
                                                .map(|id| Value::from(id.as_str()))
                                                .collect(),
                                        ),
                                    );
                                }
                                Value::Object(out)
                            })
                            .collect(),
                    ),
                );
                if let Some(failures) = failures {
                    map.insert("failures".into(), failures_value(failures));
                }
                map.insert("slides".into(), Value::Array(slides.clone()));
            }
        }
        Value::Object(map)
    }
}

/// `compact(fails)`: only `index` and `error` go to the caller
fn compact(failures: &Option<Vec<TxnFailure>>) -> Option<Vec<TxnFailure>> {
    failures.clone()
}

/// `r.failures?.length ? { failures: compact(r.failures) } : {}`
fn failures_if_any(failures: &Option<Vec<TxnFailure>>) -> Option<Vec<TxnFailure>> {
    match failures {
        Some(list) if !list.is_empty() => compact(failures),
        _ => None,
    }
}

/// `${rec.op.target.slide}${rec.op.target.el ? `/${rec.op.target.el}` : ''}`
fn target_of(op: &Value) -> Option<String> {
    let target = op
        .get("target")
        .filter(|target| value_truthy(Some(*target)))?;
    let slide = value_to_string(target.get("slide"));
    let el = target.get("el");
    Some(if value_truthy(el) {
        format!("{slide}/{}", value_to_string(el))
    } else {
        slide
    })
}

/// `applyTxnToSession(session, req, history)`. `req` is the request as it
/// arrived (`ApplyTxnOp`): a value that is not an object has no `ops`.
pub fn apply_txn_to_session<S: TxnSession, H: TxnHistory<S>>(
    session: &mut S,
    req: &Value,
    history: &mut H,
) -> ApplyTxnResult {
    let ops: Vec<Value> = match req.get("ops") {
        Some(Value::Array(ops)) => ops.clone(),
        _ => Vec::new(),
    };
    if ops.is_empty() || ops.len() > MAX_TXN_OPS {
        return ApplyTxnResult::Failed {
            failures: Some(vec![TxnFailure {
                index: 0.0,
                error: "ops must be a non-empty array (at most 50 per transaction).".to_owned(),
            }]),
        };
    }
    let isolation = if req.get("isolation").and_then(Value::as_str) == Some("per_op") {
        Isolation::PerOp
    } else {
        Isolation::Atomic
    };
    if value_truthy(req.get("dryRun")) {
        let r = session.run_dry(&ops, isolation);
        return ApplyTxnResult::DryRun {
            plan: r.plan.clone().unwrap_or_default(),
            failures: failures_if_any(&r.failures),
        };
    }
    // Plan before pushing history (a no-op request must not clear the redo stack)
    let plan = session.run_dry(&ops, isolation);
    let invalid = plan.failures.as_ref().map_or(0, Vec::len);
    let refused = match isolation {
        Isolation::Atomic => invalid > 0,
        Isolation::PerOp => invalid >= ops.len(),
    };
    if refused {
        return ApplyTxnResult::Failed {
            failures: compact(&plan.failures),
        };
    }
    history.push(session);
    let r = history.run(session, &ops, isolation);
    if !r.applied {
        history.drop_step(session);
        return ApplyTxnResult::Failed {
            failures: compact(&r.failures),
        };
    }
    // Some ops change only package state (setNotes, a theme commit) and leave no
    // element dirty, so without this the session would still look clean and a
    // close could discard the edit.
    session.mark_meta_dirty();
    // Post-pass mirroring the dedicated shims: text ops get autofit resize +
    // fontScale write-back, level changes materialize, and XML-patching ops
    // reparse the page. Slides are re-found by the executor-stamped durable id:
    // a numeric target.slide drifts when a later structural op shifts pages.
    let empty: Vec<TxnOpRecord> = Vec::new();
    let records = r.records.as_ref().unwrap_or(&empty);
    let mut rendered_by_idx: HashMap<usize, Option<S::Rendered>> = HashMap::new();
    for rec in records {
        let o = &rec.op;
        let idx = match rec.slide_id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => session.slide_index_of_durable_id(id),
            None => None,
        };
        let Some(idx) = idx else {
            continue;
        };
        let op_name = o.get("op").and_then(Value::as_str);
        if op_name == Some("setTableStyle") || op_name == Some("setChart") {
            session.rebuild_slide_with_reparse(idx);
            rendered_by_idx.remove(&idx);
            continue;
        }
        let id = o
            .get("target")
            .and_then(|target| target.get("el"))
            .filter(|el| value_truthy(Some(*el)));
        let Some(id) = id else {
            continue;
        };
        if value_truthy(o.get("group")) {
            continue;
        }
        if op_name != Some("setText")
            && op_name != Some("setFont")
            && op_name != Some("setParagraphFormat")
        {
            continue;
        }
        let id = value_to_string(Some(id));
        if op_name == Some("setText")
            && value_truthy(rec.after.as_ref().and_then(|after| after.get("levelDirty")))
        {
            continue;
        }
        if op_name == Some("setParagraphFormat")
            && value_truthy(o.get("format").and_then(|format| format.get("indentDelta")))
        {
            session.materialize_slide(idx);
            rendered_by_idx.remove(&idx);
            continue;
        }
        let mut rendered = match rendered_by_idx.remove(&idx) {
            Some(held) => held,
            None => session.rebuild_slide(idx),
        };
        rendered = session.apply_autofit_resize(idx, &id, rendered);
        rendered = session.sync_autofit_scale(idx, &id, rendered);
        rendered_by_idx.insert(idx, rendered);
    }
    let records_out: Vec<TxnRecordOut> = records
        .iter()
        .map(|rec| TxnRecordOut {
            op: rec.op.get("op").cloned(),
            target: target_of(&rec.op),
            created: rec.created.clone(),
        })
        .collect();
    let failures = failures_if_any(&r.failures);
    let slides = session.build_all_render_slides();
    ApplyTxnResult::Applied {
        records: records_out,
        failures,
        slides,
    }
}
