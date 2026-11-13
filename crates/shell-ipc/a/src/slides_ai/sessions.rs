//! What the slides AI handlers ask of the sender's deck session. The session
//! (`sessions.get(event.sender.id)` of `apps/slides/src/main/session-state.ts`,
//! with the review state `ai-proposal.ts` keeps beside it: `aiRun`,
//! `aiProposal`, `writesInFlight`, `windowLives`) is batch D1's. It sits on
//! the core thread (`Rc`), so it is not a host ([`shell_contract::Hosts`] are
//! `Send + Sync`) but a provided thing: D1 adds an `Rc<dyn SlidesAiSessions>`
//! to [`shell_contract::Provided`] and this batch looks it up when a handler
//! runs, the way it looks up [`SlidesDocuments`] for the template selection.
//!
//! Every method names a view and answers what the TypeScript handler did with
//! `sessions.get(view)`: a view without a session answers as the handler does
//! (`null` / `false`). The judgment is `main_core::slides::{ai_proposal,
//! ai_ipc}`'s; D1's implementation calls those generic functions over its own
//! session and [`AiReview`] and scheduled flushes (history notice, deck
//! broadcast), so the same code runs for the save paths that ask
//! `assert_no_ai_run`.
//!
//! [`AiReview`]: main_core::slides::ai_proposal::AiReview

use std::rc::Rc;
use std::sync::Arc;

use jscompat::JsonValue;
use main_core::slides::ai_ipc::{ImageDecoder, IpcError as CoreError, PictureTicket};
use main_core::slides::ai_proposal::{RunBeginTicket, RunBeginWake, SettleStep};
use shell_contract::slides::SlidesDocuments;
use shell_contract::{IpcValue, ViewId};

/// D1 provides it (`Rc<dyn SlidesAiSessions>`); it is also the session's
/// [`SlidesDocuments`], so the document's id and path come from the same
/// session the review state belongs to.
pub trait SlidesAiSessions: SlidesDocuments {
    /// `slides:ai-run-begin`, first half: `windowLives.get(sender) ?? 0` read
    /// with the session lookup (`run_begin_start` of ai_proposal); `None` for
    /// a view without a session
    fn run_begin_start(&self, view: ViewId) -> Option<RunBeginTicket>;
    /// One turn of `settleWrites(session)`'s loop (`settle_writes_step`); a
    /// view whose session is gone is quiet
    fn settle_step(&self, view: ViewId, now_ms: f64, deadline_ms: f64) -> SettleStep;
    /// `slides:ai-run-begin`, second half: `beginAiRun(session, sender.id)`
    /// once the wait ended (`run_begin_finish`); `false` for a view without a
    /// session
    fn run_begin_finish(&self, view: ViewId, ticket: RunBeginTicket, wake: RunBeginWake) -> bool;
    /// `slides:ai-run-hold`: `holdAiRun(session, sender.id)` and, when it held
    /// something, `buildAllRenderSlides(...)` as an array; `None` for `null`
    fn run_hold(&self, view: ViewId) -> Option<IpcValue>;
    /// `slides:ai-proposal-accept`: `acceptAiProposal(session)`: the render
    /// slides and the snapshot id; `None` for `null`
    fn proposal_accept(&self, view: ViewId) -> Option<(IpcValue, u64)>;
    /// `slides:ai-proposal-reject`: `rejectAiProposal(session)`; `false` without a session
    fn proposal_reject(&self, view: ViewId) -> bool;
    /// `slides:ai-snapshot-restore`: nothing while the deck is in master view
    /// or inside a history batch, else `restoreAiSnapshot(session, id)` and
    /// `scheduleDeckBroadcast`, answering `buildAllRenderSlides(...)`; `None`
    /// for `null`. `id` is the renderer's argument (NaN for a non-number)
    fn snapshot_restore(&self, view: ViewId, id: f64) -> Option<IpcValue>;
    /// `ai:insert-image-url` (`replace` false) or `ai:replace-picture-url`,
    /// up to the download (`insert_image_begin`, `replace_picture_begin`);
    /// `Ok(None)` answers `null` (no session included)
    fn picture_begin(
        &self,
        view: ViewId,
        replace: bool,
        images: &dyn ImageDecoder,
        op: Option<&JsonValue>,
    ) -> Result<Option<PictureTicket>, CoreError>;
    /// The same handler after the download (`downloaded` is `None` where it
    /// failed): `insert_image_finish` / `replace_picture_finish`; `None` for
    /// `null`
    fn picture_finish(
        &self,
        view: ViewId,
        replace: bool,
        images: &dyn ImageDecoder,
        op: &JsonValue,
        ticket: PictureTicket,
        downloaded: Option<Vec<u8>>,
    ) -> Option<JsonValue>;
}

/// `new Set<AbortController>()` per window of `media-call-abort.ts`, which
/// `ai:stream-cancel` (the shared AI port) reaches with `abortMediaCalls`:
/// this batch provides it (`Rc<dyn MediaCallAbort>`) with the slides AI port,
/// the owner of the calls in flight
pub trait MediaCallAbort {
    /// `abortMediaCalls(senderId)`
    fn abort_media_calls(&self, sender_id: f64);
}

/// What a probe passes to [`super::factory_with`]: builds the sessions where
/// the shell has none provided (D1 absent)
pub type SessionsBuilder = Arc<dyn Fn() -> Rc<dyn SlidesAiSessions> + Send + Sync>;

/// What a probe changes in [`super::factory_with`]: the sessions where the
/// shell has none provided (D1 absent) and the clock of `appendRunFailure`
#[derive(Clone, Default)]
pub struct Overrides {
    pub sessions: Option<SessionsBuilder>,
    /// `Date.now()` in milliseconds
    pub now_ms: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
}
