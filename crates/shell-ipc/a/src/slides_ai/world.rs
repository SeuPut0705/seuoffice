//! A small in-memory D1: decks of named pages with real `main-core` session
//! state, the AI review state and the picture functions behind
//! [`SlidesAiSessions`]. The unit tests and the probe drive the port over it;
//! it also shows how D1's implementation calls `main_core::slides`: every
//! method is the generic function applied to the view's session and review.

// the probe opens decks and masters; the tests also close them and track writes
#![cfg_attr(not(test), allow(dead_code))]

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use jscompat::JsonValue;
use main_core::packages::ai_provider::jsval::{object, text};
use main_core::packages::pipelines::slides_cover_crop::CoverCrop;
use main_core::slides::ai_ipc::{
    ImageDecoder, IpcError as CoreError, PictureDeck, PictureOffset, PictureTicket,
    insert_image_begin, insert_image_finish, replace_picture_begin, replace_picture_finish,
};
use main_core::slides::ai_proposal::{
    AiReview, RunBeginTicket, RunBeginWake, SettleStep, WindowLives, accept_ai_proposal,
    begin_write, end_write, hold_ai_run, reject_ai_proposal, run_begin_finish, run_begin_start,
    settle_writes_step,
};
use main_core::slides::session_state::{Deck, EngineThrew, PartPath, Session, SessionIds};
use shell_contract::slides::{SlidesDocument, SlidesDocuments};
use shell_contract::{IpcValue, ViewId};

use super::sessions::SlidesAiSessions;

/// A deck snapshot: the pages, by identity (`===`) like the TypeScript's
pub type Snap = Rc<Vec<String>>;

/// The render slide: the page's text
#[derive(Clone, Debug, PartialEq)]
pub struct Page(pub String);

impl PartPath for Page {
    fn part_path(&self) -> Option<&str> {
        Some(&self.0)
    }
}

/// The deck of a session: pages are strings; a picture appends to its page
pub struct FakeDeck {
    pub slides: Vec<String>,
    pub size_cx: f64,
}

impl Deck<Snap> for FakeDeck {
    fn take_snapshot(&self, _meta_dirty: bool) -> Snap {
        Rc::new(self.slides.clone())
    }

    fn restore_snapshot(&mut self, fresh: Snap) -> bool {
        self.slides = (*fresh).clone();
        false
    }
}

impl PictureDeck for FakeDeck {
    fn has_slide(&self, index: f64) -> bool {
        index >= 0.0 && index.fract() == 0.0 && (index as usize) < self.slides.len()
    }

    fn size_cx(&self) -> f64 {
        self.size_cx
    }

    fn add_picture(
        &mut self,
        slide_index: f64,
        bytes: &[u8],
        ext: &str,
        offset: PictureOffset,
    ) -> Result<Option<String>, EngineThrew> {
        let page = &mut self.slides[slide_index as usize];
        page.push_str(&format!(
            "+picture({} bytes,{ext},{},{},{},{})",
            bytes.len(),
            offset.x,
            offset.y,
            offset.cx,
            offset.cy
        ));
        Ok(Some(format!("pic-{}", page.len())))
    }

    fn edit_picture_src_rect(
        &mut self,
        slide_index: f64,
        _id: &str,
        crop: &CoverCrop,
    ) -> Result<(), EngineThrew> {
        self.slides[slide_index as usize].push_str(&format!(
            "+crop({},{},{},{})",
            crop.l, crop.t, crop.r, crop.b
        ));
        Ok(())
    }

    fn replace_picture_bytes(
        &mut self,
        slide_index: f64,
        id: &str,
        bytes: &[u8],
        ext: &str,
        keep_src_rect: bool,
    ) -> Result<bool, EngineThrew> {
        if id == "missing" {
            return Ok(false);
        }
        self.slides[slide_index as usize].push_str(&format!(
            "+replace({id},{} bytes,{ext},keep={keep_src_rect})",
            bytes.len()
        ));
        Ok(true)
    }

    fn find_element_id(&self, _slide_index: f64, reference: &str) -> Option<String> {
        // a durable id `d:<id>` stands for the parse-time id `<id>`
        reference.strip_prefix("d:").map(str::to_owned)
    }

    fn picture_frame(&self, _slide_index: f64, id: &str) -> Option<(f64, f64)> {
        // the pictures the page has: `7` and `8`
        matches!(id, "7" | "8").then_some((100.0, 100.0))
    }

    fn set_fit_width_px(&mut self, _px: f64) {}

    fn rebuild_slide(&mut self, slide_index: f64) -> Option<JsonValue> {
        Some(object(vec![(
            "page",
            text(self.slides[slide_index as usize].as_str()),
        )]))
    }
}

type FakeSession = Session<FakeDeck, Snap, (), Page>;

struct Entry {
    id: u64,
    session: FakeSession,
    review: AiReview<Snap>,
    ids: SessionIds,
}

/// The slides sessions of a shell: one per view
#[derive(Default)]
pub struct World {
    entries: RefCell<HashMap<u32, Entry>>,
    lives: RefCell<WindowLives>,
    next_id: RefCell<u64>,
}

impl World {
    pub fn new() -> Rc<World> {
        Rc::new(World::default())
    }

    /// A deck of `pages` opened for `view` at `path` (`""` before the first save);
    /// the session's id
    pub fn open(&self, view: ViewId, path: &str, pages: &[&str]) -> u64 {
        let mut next = self.next_id.borrow_mut();
        *next += 1;
        let id = *next;
        let deck = FakeDeck {
            slides: pages.iter().map(|page| (*page).to_owned()).collect(),
            size_cx: 9_525.0 * 960.0,
        };
        self.entries.borrow_mut().insert(
            view.0,
            Entry {
                id,
                session: Session::new(path, deck),
                review: AiReview::new(),
                ids: SessionIds::new(),
            },
        );
        id
    }

    /// The window of `view` was reloaded or closed: its session is another one
    pub fn close(&self, view: ViewId) {
        self.entries.borrow_mut().remove(&view.0);
    }

    /// `trackWrite`: a write that began and has not ended; its id
    pub fn begin_write(&self, view: ViewId) -> Option<u64> {
        let mut entries = self.entries.borrow_mut();
        begin_write(&mut entries.get_mut(&view.0)?.review).ok()
    }

    pub fn end_write(&self, view: ViewId, write: u64) {
        if let Some(entry) = self.entries.borrow_mut().get_mut(&view.0) {
            end_write(&mut entry.review, write);
        }
    }

    /// An edit of the open run (or an ordinary one): one undo step, then the page changes
    pub fn edit(&self, view: ViewId, page: usize, suffix: &str) {
        if let Some(entry) = self.entries.borrow_mut().get_mut(&view.0) {
            entry.session.push_history();
            entry.session.deck.slides[page].push_str(suffix);
            entry.session.op_seq = Some(entry.session.op_seq.unwrap_or(0) + 1);
        }
    }

    /// The pages of the deck now
    pub fn pages(&self, view: ViewId) -> Vec<String> {
        self.entries
            .borrow()
            .get(&view.0)
            .map(|entry| entry.session.deck.slides.clone())
            .unwrap_or_default()
    }

    /// `session.aiRun !== undefined`
    pub fn run_open(&self, view: ViewId) -> bool {
        self.entries
            .borrow()
            .get(&view.0)
            .is_some_and(|entry| entry.review.run.is_some())
    }

    /// `session.aiProposal !== undefined`
    pub fn proposal_held(&self, view: ViewId) -> bool {
        self.entries
            .borrow()
            .get(&view.0)
            .is_some_and(|entry| entry.review.proposal.is_some())
    }

    /// `session.undoStack.length`
    pub fn undo_depth(&self, view: ViewId) -> usize {
        self.entries
            .borrow()
            .get(&view.0)
            .map_or(0, |entry| entry.session.undo_stack.len())
    }

    /// `session.masterEdit = true`
    pub fn set_master_edit(&self, view: ViewId, on: bool) {
        if let Some(entry) = self.entries.borrow_mut().get_mut(&view.0) {
            entry.review.master_edit = on;
        }
    }

    fn deck_of(entry: &Entry) -> IpcValue {
        IpcValue::Array(
            entry
                .session
                .deck
                .slides
                .iter()
                .map(|page| IpcValue::String(page.clone()))
                .collect(),
        )
    }
}

impl SlidesDocuments for World {
    fn document(&self, view: ViewId) -> Option<SlidesDocument> {
        self.entries
            .borrow()
            .get(&view.0)
            .map(|entry| SlidesDocument {
                id: entry.id,
                path: entry.session.path.clone(),
            })
    }
}

impl SlidesAiSessions for World {
    fn run_begin_start(&self, view: ViewId) -> Option<RunBeginTicket> {
        let has_session = self.entries.borrow().contains_key(&view.0);
        run_begin_start(&self.lives.borrow(), view.0 as f64, has_session)
    }

    fn settle_step(&self, view: ViewId, now_ms: f64, deadline_ms: f64) -> SettleStep {
        match self.entries.borrow().get(&view.0) {
            Some(entry) => settle_writes_step(&entry.review, now_ms, deadline_ms),
            None => SettleStep::Quiet,
        }
    }

    fn run_begin_finish(&self, view: ViewId, ticket: RunBeginTicket, wake: RunBeginWake) -> bool {
        let mut entries = self.entries.borrow_mut();
        let Some(entry) = entries.get_mut(&view.0) else {
            return false;
        };
        run_begin_finish(
            &mut entry.session,
            &mut entry.review,
            &self.lives.borrow(),
            view.0 as f64,
            ticket,
            wake,
        )
    }

    fn run_hold(&self, view: ViewId) -> Option<IpcValue> {
        let mut entries = self.entries.borrow_mut();
        let entry = entries.get_mut(&view.0)?;
        hold_ai_run(&mut entry.session, &mut entry.review, view.0 as f64)
            .then(|| Self::deck_of(entry))
    }

    fn proposal_accept(&self, view: ViewId) -> Option<(IpcValue, u64)> {
        let mut entries = self.entries.borrow_mut();
        let entry = entries.get_mut(&view.0)?;
        let id = accept_ai_proposal(&mut entry.session, &mut entry.review, &mut entry.ids)?;
        Some((Self::deck_of(entry), id))
    }

    fn proposal_reject(&self, view: ViewId) -> bool {
        self.entries
            .borrow_mut()
            .get_mut(&view.0)
            .is_some_and(|entry| reject_ai_proposal(&mut entry.review))
    }

    fn snapshot_restore(&self, view: ViewId, id: f64) -> Option<IpcValue> {
        let mut entries = self.entries.borrow_mut();
        let entry = entries.get_mut(&view.0)?;
        if entry.review.master_edit || entry.session.history_batch.is_some() {
            return None;
        }
        if !entry.session.restore_ai_snapshot(id) {
            return None;
        }
        entry.session.schedule_deck_broadcast();
        Some(Self::deck_of(entry))
    }

    fn picture_begin(
        &self,
        view: ViewId,
        replace: bool,
        images: &dyn ImageDecoder,
        op: Option<&JsonValue>,
    ) -> Result<Option<PictureTicket>, CoreError> {
        let entries = self.entries.borrow();
        let Some(entry) = entries.get(&view.0) else {
            return Ok(None);
        };
        if replace {
            replace_picture_begin(&entry.session, &entry.review, images, op)
        } else {
            insert_image_begin(&entry.session, &entry.review, images, op)
        }
    }

    fn picture_finish(
        &self,
        view: ViewId,
        replace: bool,
        images: &dyn ImageDecoder,
        op: &JsonValue,
        ticket: PictureTicket,
        downloaded: Option<Vec<u8>>,
    ) -> Option<JsonValue> {
        let mut entries = self.entries.borrow_mut();
        let entry = entries.get_mut(&view.0)?;
        if replace {
            replace_picture_finish(
                &mut entry.session,
                &entry.review,
                images,
                op,
                ticket,
                downloaded,
            )
        } else {
            insert_image_finish(
                &mut entry.session,
                &entry.review,
                images,
                op,
                ticket,
                downloaded,
            )
        }
    }
}
