//! `apps/slides/src/main/ai-proposal.ts`: AI edit review. An AI request edits
//! the live deck as before, but when it ends the edits are taken back out with
//! the snapshot history and held as a proposal the person accepts or rejects.
//!
//! The fields the TypeScript adds to the session (`aiRun`, `aiProposal`,
//! `masterEdit`, `writesInFlight`) are an [`AiReview`] the caller keeps beside
//! its [`Session`]; the session's own `ai_run` flag (the presence of `aiRun`,
//! which the history notice reads) is kept in step with `review.run` by every
//! function here. Snapshots are compared by identity (`===`): the caller's
//! snapshot type implements [`SameSnapshot`] (an `Rc` does, by pointer).
//!
//! Promises become explicit steps the caller drives: a write in flight is an
//! id ([`begin_write`], [`end_write`]), the wait of `settleWrites` is
//! [`settle_writes_step`] over a clock the caller reads, and the begin of a
//! run that waits for writes is [`run_begin_start`] and [`run_begin_finish`].
//! The module state `windowLives` is a [`WindowLives`] the caller owns.

use std::rc::Rc;

use crate::slides::session_state::{Deck, Session, SessionIds};

/// `snap === other`
pub trait SameSnapshot {
    fn same_snapshot(&self, other: &Self) -> bool;
}

impl<T> SameSnapshot for Rc<T> {
    fn same_snapshot(&self, other: &Self) -> bool {
        Rc::ptr_eq(self, other)
    }
}

/// `AiRun`: the deck as an AI request found it, recorded before its first edit.
#[derive(Debug, Clone)]
pub struct AiRun<S> {
    /// the object identity of the run: a later run is another one
    pub id: u64,
    /// the window that began the run: only it may hold the run
    pub owner: f64,
    pub before: S,
    /// copies of both stacks: the run's edits may trim or replace the live arrays
    pub undo: Vec<S>,
    pub redo: Vec<S>,
    /// journal and notes counters at the start
    pub op_seq: u64,
    pub meta_rev: u64,
    /// AI rollback points that existed before the run
    pub known_snapshots: Vec<u64>,
}

/// `HistoryMarker`: what the session looked like right after the revert.
#[derive(Debug, Clone)]
pub struct HistoryMarker<S> {
    pub undo_top: Option<S>,
    pub undo_len: usize,
    pub redo_len: usize,
    pub op_seq: u64,
    pub meta_rev: u64,
}

/// `AiProposal`
#[derive(Debug, Clone)]
pub struct AiProposal<S> {
    /// the window whose run produced it
    pub owner: f64,
    pub before: S,
    pub after: S,
    pub marker: HistoryMarker<S>,
}

/// The session fields of ai-proposal.ts that the ported `Session` has no
/// place for.
#[derive(Debug)]
pub struct AiReview<S> {
    /// `session.aiRun`
    pub run: Option<AiRun<S>>,
    /// `session.aiProposal`
    pub proposal: Option<AiProposal<S>>,
    /// `session.masterEdit` is set
    pub master_edit: bool,
    /// `session.writesInFlight`, in the order the writes began
    writes_in_flight: Vec<u64>,
    next_write: u64,
    next_run: u64,
}

impl<S> Default for AiReview<S> {
    fn default() -> Self {
        AiReview {
            run: None,
            proposal: None,
            master_edit: false,
            writes_in_flight: Vec::new(),
            next_write: 1,
            next_run: 1,
        }
    }
}

impl<S> AiReview<S> {
    pub fn new() -> Self {
        Self::default()
    }

    /// `session.writesInFlight?.size`
    pub fn writes_in_flight(&self) -> usize {
        self.writes_in_flight.len()
    }
}

/// `reason` a save returns while an AI run's edits wait for review (nothing was written)
pub const AI_REVIEW_SAVE_REASON: &str = "ai-review";

/// What `assertNoAiRun` throws.
pub const AI_RUN_OPEN_MESSAGE: &str =
    "An AI request is editing this deck; saving waits for your review";

/// The error `assertNoAiRun` throws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiRunOpen;

impl AiRunOpen {
    /// `error.message`
    pub fn message(&self) -> &'static str {
        AI_RUN_OPEN_MESSAGE
    }
}

/// `markerOf(session)`
pub fn marker_of<D, S: Clone, O, R>(session: &Session<D, S, O, R>) -> HistoryMarker<S> {
    HistoryMarker {
        undo_top: session.undo_stack.last().cloned(),
        undo_len: session.undo_stack.len(),
        redo_len: session.redo_stack.len(),
        op_seq: session.op_seq.unwrap_or(0),
        meta_rev: session.meta_rev.unwrap_or(0),
    }
}

/// `sameMarker(a, b)`
fn same_marker<S: SameSnapshot>(a: &HistoryMarker<S>, b: &HistoryMarker<S>) -> bool {
    let same_top = match (&a.undo_top, &b.undo_top) {
        (Some(x), Some(y)) => x.same_snapshot(y),
        (None, None) => true,
        _ => false,
    };
    same_top
        && a.undo_len == b.undo_len
        && a.redo_len == b.redo_len
        && a.op_seq == b.op_seq
        && a.meta_rev == b.meta_rev
}

/// `sameStack(a, b)`
fn same_stack<S: SameSnapshot>(a: &[S], b: &[S]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.same_snapshot(y))
}

/// `assertNoAiRun(session)`: the backstop for every serializer of the deck:
/// fails while a run is open, so no save, recovery copy or export of the live
/// deck can carry unaccepted AI edits.
pub fn assert_no_ai_run<S>(review: &AiReview<S>) -> Result<(), AiRunOpen> {
    if review.run.is_some() {
        return Err(AiRunOpen);
    }
    Ok(())
}

/// The start of `trackWrite(session, write)`: refuses while a run is open,
/// else counts a write as in flight. The answer names the write; the caller
/// runs it and calls [`end_write`] when it settles, commit steps included.
pub fn begin_write<S>(review: &mut AiReview<S>) -> Result<u64, AiRunOpen> {
    assert_no_ai_run(review)?;
    let id = review.next_write;
    review.next_write += 1;
    review.writes_in_flight.push(id);
    Ok(id)
}

/// The settling of a write [`begin_write`] counted (the promise of `entry`).
pub fn end_write<S>(review: &mut AiReview<S>, write: u64) {
    review.writes_in_flight.retain(|id| *id != write);
}

/// `WRITE_SETTLE_MS`: how long a run's start waits for writes that began before it
pub const WRITE_SETTLE_MS: f64 = 30_000.0;

/// The deadline a `settleWrites` call that starts at `now_ms` has.
pub fn settle_deadline(now_ms: f64) -> f64 {
    now_ms + WRITE_SETTLE_MS
}

/// One turn of the loop of `settleWrites`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SettleStep {
    /// no write is in flight: the session is quiet (`true`)
    Quiet,
    /// the deadline has passed (`false`)
    TimedOut,
    /// wait for the writes in flight or `left_ms`, whichever ends first, then
    /// call again
    Wait { left_ms: f64 },
}

/// `while (session.writesInFlight?.size)` of `settleWrites`, one turn: the
/// caller reads the clock (`Date.now()`), waits as the step says and asks again.
pub fn settle_writes_step<S>(review: &AiReview<S>, now_ms: f64, deadline_ms: f64) -> SettleStep {
    if review.writes_in_flight.is_empty() {
        return SettleStep::Quiet;
    }
    let left = deadline_ms - now_ms;
    if left <= 0.0 {
        return SettleStep::TimedOut;
    }
    SettleStep::Wait { left_ms: left }
}

/// `beginAiRun(session, owner)`: record the deck before an AI request's first
/// edit. `false`, and the run must not start, when it could not be reverted:
/// another window's run is still open, or the deck is in master view. A run of
/// this window that was never held is reverted first. A proposal still held
/// from an earlier request is dropped.
pub fn begin_ai_run<D: Deck<S>, S: Clone + SameSnapshot, O: Clone, R>(
    session: &mut Session<D, S, O, R>,
    review: &mut AiReview<S>,
    owner: f64,
) -> bool {
    if review.master_edit {
        return false;
    }
    if let Some(run) = &review.run {
        if run.owner != owner {
            return false;
        }
        hold_ai_run(session, review, owner);
    }
    review.proposal = None;
    let id = review.next_run;
    review.next_run += 1;
    review.run = Some(AiRun {
        id,
        owner,
        before: session.take_snapshot(),
        undo: session.undo_stack.clone(),
        redo: session.redo_stack.clone(),
        op_seq: session.op_seq.unwrap_or(0),
        meta_rev: session.meta_rev.unwrap_or(0),
        known_snapshots: session
            .ai_snapshots
            .iter()
            .flatten()
            .map(|(snapshot_id, _)| *snapshot_id)
            .collect(),
    });
    session.ai_run = true;
    session.schedule_history_notify();
    true
}

/// `holdAiRun(session, owner)`: end of an AI request: when it changed the
/// deck, put the deck back to its pre-run state (undo and redo stacks too) and
/// keep the run's result as the session's pending proposal. `false` when there
/// was nothing to hold; the deck is untouched then. A history batch the run
/// left open is dropped. Only the window that began the run can hold it.
pub fn hold_ai_run<D: Deck<S>, S: Clone + SameSnapshot, O: Clone, R>(
    session: &mut Session<D, S, O, R>,
    review: &mut AiReview<S>,
    owner: f64,
) -> bool {
    let run = match review.run.take() {
        Some(run) if run.owner == owner => run,
        other => {
            review.run = other;
            return false;
        }
    };
    session.ai_run = false;
    session.history_batch = None;
    session.schedule_history_notify();
    let changed = !same_stack(&session.undo_stack, &run.undo)
        || session.op_seq.unwrap_or(0) != run.op_seq
        || session.meta_rev.unwrap_or(0) != run.meta_rev;
    if !changed {
        return false;
    }
    let after = session.take_snapshot();
    session.undo_stack = run.undo.clone();
    session.redo_stack = run.redo;
    session.restore_snapshot(&run.before);
    if let Some(snapshots) = session.ai_snapshots.as_mut() {
        snapshots.retain(|(id, _)| run.known_snapshots.contains(id));
    }
    review.proposal = Some(AiProposal {
        owner,
        before: run.before,
        after,
        marker: marker_of(session),
    });
    session.schedule_deck_broadcast();
    true
}

/// `acceptAiProposal(session)`: apply the held proposal when nothing changed
/// since the revert: the deck becomes the run's result as one undo step, and
/// the pre-run state becomes an AI rollback point. Answers its id; `None`, with
/// the deck and the proposal left alone, when the deck changed meanwhile or no
/// proposal is held.
pub fn accept_ai_proposal<D: Deck<S>, S: Clone + SameSnapshot, O: Clone, R>(
    session: &mut Session<D, S, O, R>,
    review: &mut AiReview<S>,
    ids: &mut SessionIds,
) -> Option<u64> {
    let proposal = review.proposal.as_ref()?;
    if session.history_batch.is_some() || review.master_edit || review.run.is_some() {
        return None;
    }
    if !same_marker(&proposal.marker, &marker_of(session)) {
        return None;
    }
    let proposal = review.proposal.take()?;
    session.push_history();
    session.restore_snapshot(&proposal.after);
    session.schedule_deck_broadcast();
    Some(session.register_ai_snapshot(ids, &proposal.before))
}

/// `windowLives`: bumped every time a window's runs are dropped (it went away,
/// crashed or reloaded), so a run begin that was still waiting for writes can
/// tell its window is no longer the one that asked.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WindowLives {
    lives: Vec<(f64, u64)>,
}

impl WindowLives {
    pub fn new() -> Self {
        Self::default()
    }

    /// `windowLives.get(id) ?? 0`
    pub fn get(&self, id: f64) -> u64 {
        self.lives
            .iter()
            .find(|(key, _)| *key == id)
            .map_or(0, |(_, life)| *life)
    }

    /// `windowLives.set(id, (windowLives.get(id) ?? 0) + 1)`
    fn bump(&mut self, id: f64) {
        let next = self.get(id) + 1;
        match self.lives.iter_mut().find(|(key, _)| *key == id) {
            Some(entry) => entry.1 = next,
            None => self.lives.push((id, next)),
        }
    }
}

/// `dropAiRunOf(session, owner)`: the window that owns a run (or the proposal
/// it left) is gone, crashed or reloaded: the run is reverted and dropped, as
/// a reject would.
pub fn drop_ai_run_of<D: Deck<S>, S: Clone + SameSnapshot, O: Clone, R>(
    session: &mut Session<D, S, O, R>,
    review: &mut AiReview<S>,
    lives: &mut WindowLives,
    owner: f64,
) {
    lives.bump(owner);
    if review.run.as_ref().is_some_and(|run| run.owner == owner) {
        hold_ai_run(session, review, owner);
    }
    if review
        .proposal
        .as_ref()
        .is_some_and(|proposal| proposal.owner == owner)
    {
        review.proposal = None;
    }
}

/// `rejectAiProposal(session)`
pub fn reject_ai_proposal<S>(review: &mut AiReview<S>) -> bool {
    if review.proposal.is_none() {
        return false;
    }
    review.proposal = None;
    true
}

/// What `slides:ai-run-begin` read before it waited for the writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunBeginTicket {
    life: u64,
}

/// The first half of the `slides:ai-run-begin` handler: `None` answers `false`
/// at once (the window has no session); else the caller waits for the writes
/// (`settleWrites`) and calls [`run_begin_finish`].
pub fn run_begin_start(
    lives: &WindowLives,
    sender_id: f64,
    has_session: bool,
) -> Option<RunBeginTicket> {
    if !has_session {
        return None;
    }
    Some(RunBeginTicket {
        life: lives.get(sender_id),
    })
}

/// What the handler finds after the wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunBeginWake {
    /// `settleWrites` answered `true`
    pub settled: bool,
    /// `sender.isDestroyed?.()`
    pub sender_destroyed: bool,
    /// `sessionOf(e) === session`: the window still has the session it asked with
    pub same_session: bool,
}

/// The second half of the `slides:ai-run-begin` handler: the asking window may
/// go away during the wait; a run begun for it then would lock the deck for
/// every other window with nobody left to settle it.
pub fn run_begin_finish<D: Deck<S>, S: Clone + SameSnapshot, O: Clone, R>(
    session: &mut Session<D, S, O, R>,
    review: &mut AiReview<S>,
    lives: &WindowLives,
    sender_id: f64,
    ticket: RunBeginTicket,
    wake: RunBeginWake,
) -> bool {
    if !wake.settled {
        return false;
    }
    if wake.sender_destroyed || !wake.same_session {
        return false;
    }
    if lives.get(sender_id) != ticket.life {
        return false;
    }
    begin_ai_run(session, review, sender_id)
}
