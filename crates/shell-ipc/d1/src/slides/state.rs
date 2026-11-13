//! The slides session model: `session-state.ts`'s `sessions` map, the module
//! level variables of `slides-main.ts` and `presenter-show.ts`, as one value
//! the handlers share (`Rc<RefCell<AppState>>`, core thread only).
//!
//! A deck session is shared by every view attached to it (a second window on
//! the same file, a presenter's audience window), so sessions sit in slots
//! and a view names its slot. Slots are never reused within a run, so a
//! deferred flush that finds its slot empty or replaced simply does nothing.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use jscompat::JsonValue;
use main_core::packages::electron_utils::recovery_store::RecoveryIdentity;
use main_core::packages::electron_utils::save_conflict::SaveDiskState;
use main_core::slides::paste_cascade::PasteCascade;
use main_core::slides::save_as_formats::SaveAsImageTargets;
use main_core::slides::seed_queue::SeedQueue;
use main_core::slides::session_state::{Deck, PartPath, Session, SessionIds};
use shell_contract::hosts::{ClipboardHost, ContentsHost, DialogsHost, OsShellHost};
use shell_contract::runtime::Services;
use shell_contract::{IpcValue, ViewId};

use super::engine::{DeckId, SlidesEngineHost, SlidesShellHost, Snapshot};
use crate::host::{LocaleHost, RecoveryStateHost, Shared};
use crate::value::field;

/// A render slide: the render tree the renderer draws, opaque here but for
/// the `partPath` key the deck broadcast coalesces on
#[derive(Clone, Debug, PartialEq)]
pub struct RenderSlide(pub IpcValue);

impl PartPath for RenderSlide {
    fn part_path(&self) -> Option<&str> {
        crate::value::as_str(field(&self.0, "partPath"))
    }
}

/// The live deck of a session: a deck in the engine, released with the
/// session
pub struct DeckHandle {
    pub id: DeckId,
    engine: SlidesEngineHost,
}

impl DeckHandle {
    pub fn new(id: DeckId, engine: SlidesEngineHost) -> Self {
        DeckHandle { id, engine }
    }
}

impl Deck<Snapshot> for DeckHandle {
    fn take_snapshot(&self, meta_dirty: bool) -> Snapshot {
        self.engine.snapshot(self.id, meta_dirty)
    }

    fn restore_snapshot(&mut self, fresh: Snapshot) -> bool {
        self.engine.restore(self.id, &fresh)
    }
}

impl Drop for DeckHandle {
    fn drop(&mut self) {
        self.engine.release(self.id)
    }
}

/// `session-state.ts`'s `Session` fields that main-core's [`Session`] holds
pub type CoreSession = Session<DeckHandle, Snapshot, IpcValue, RenderSlide>;

/// The part open in master view (`masterEdit`): the part path; the engine
/// keeps the live master slide the ops are seeded with
#[derive(Clone, Debug, PartialEq)]
pub struct MasterEdit {
    pub part_path: String,
}

/// `contentMark(session)`: what a recovery copy was taken of. Equal marks
/// mean the copy on disk already holds the deck.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CopyMark {
    pub op_seq: u64,
    pub meta_rev: u64,
    pub meta_dirty: bool,
    pub undo_len: usize,
    pub undo_top: usize,
    pub redo_len: usize,
    pub redo_top: usize,
    pub slide_count: usize,
}

/// A close waiting on the renderer: the view, the ticket its timeout finds it
/// by, and what to do with the answer
pub type CloseWaiter = (ViewId, u64, Box<dyn FnOnce(bool)>);
/// `Session` of `session-state.ts`
pub struct SlideSession {
    /// fixed for the life of this session object (`SlidesDocument::id`)
    pub id: u64,
    pub core: CoreSession,
    pub fit_width_px: f64,
    /// the disk snapshot of `path` this deck last read or wrote
    pub disk_state: Option<SaveDiskState>,
    /// the open password of a deck opened from an encrypted file
    pub password: Option<String>,
    /// an untitled copy's first save asks where
    pub ask_path_on_first_save: bool,
    /// the file name that first save suggests
    pub first_save_name: Option<String>,
    /// the crash-recovery copy of a deck without a path
    pub recovery_id: Option<RecoveryIdentity>,
    pub transform_preview: bool,
    pub preview_redo: Option<Vec<Snapshot>>,
    pub master_edit: Option<MasterEdit>,
    /// what the last recovery copy of this deck was taken of (`copyMarks`)
    pub copy_mark: Cell<Option<CopyMark>>,
}

impl SlideSession {
    pub fn new(path: &str, deck: DeckHandle, fit_width_px: f64) -> Self {
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        SlideSession {
            id: NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            core: Session::new(path, deck),
            fit_width_px,
            disk_state: None,
            password: None,
            ask_path_on_first_save: false,
            first_save_name: None,
            recovery_id: None,
            transform_preview: false,
            preview_redo: None,
            master_edit: None,
            copy_mark: Cell::new(None),
        }
    }

    pub fn deck(&self) -> DeckId {
        self.core.deck.id
    }

    pub fn path(&self) -> &str {
        &self.core.path
    }
}

/// `slideClipboard`: slides copied from any deck of this process
#[derive(Clone, Debug, PartialEq)]
pub struct SlideClipboard {
    pub bundles: Vec<IpcValue>,
    pub pngs: Option<Vec<IpcValue>>,
}

/// `lastSlidePaste` of one view
#[derive(Clone, Debug, PartialEq)]
pub struct LastSlidePaste {
    pub after_index: f64,
    pub undo_len: usize,
    pub changed: Vec<f64>,
}

/// `elementClipboard`: elements copied from any deck of this process
pub struct ElementClipboard {
    pub items: Vec<IpcValue>,
    pub cascade: PasteCascade,
    pub token: String,
    pub sender_id: f64,
}

/// A pending OS question or a recording of the narration microphone; the
/// 4 hour bound is a deadline checked when asked
pub struct NarrationMicrophone {
    /// `None` while the OS question is pending
    pub deadline: Option<Instant>,
    /// distinguishes a newer recording from the one a late answer belongs to
    pub ticket: u64,
}

/// `PresenterShow`
pub struct PresenterShow {
    pub audience: Option<(ViewId, shell_contract::WindowId)>,
    pub last_sync: Option<IpcValue>,
}

/// The parts of [`AppState`] a handler holds next to a session
pub struct StateRest<'a> {
    pub slide_clipboard: &'a mut Option<SlideClipboard>,
    pub last_slide_paste: &'a mut HashMap<ViewId, LastSlidePaste>,
    pub element_clipboard: &'a mut Option<ElementClipboard>,
}

/// All of the module state the slides handlers share
#[derive(Default)]
pub struct AppState {
    slots: Vec<Option<SlideSession>>,
    attach: HashMap<ViewId, usize>,
    /// `viewerWcIds`
    pub viewers: HashSet<ViewId>,
    pub ids: SessionIds,
    /// `pendingOpenPath`
    pub pending_open_path: Option<String>,
    /// `pendingByWc`
    pub pending_by_view: HashMap<ViewId, String>,
    pub slide_clipboard: Option<SlideClipboard>,
    pub last_slide_paste: HashMap<ViewId, LastSlidePaste>,
    pub element_clipboard: Option<ElementClipboard>,
    /// `issuedCloudPages`
    pub issued_cloud_pages: HashSet<String>,
    /// `closeSaveWaiters`: the continuations of closes that wait for the
    /// renderer's `slides:close-save-result`, with the ticket their timeout
    /// finds them by; the last of a view is the one the map would hold
    pub close_waiters: Vec<CloseWaiter>,
    /// `autoSavePrefByWc`
    pub auto_save_pref: HashMap<ViewId, bool>,
    pub save_as_image_targets: SaveAsImageTargets,
    pub narration: HashMap<ViewId, NarrationMicrophone>,
    pub next_ticket: u64,
    /// `covers` of `template-cover.ts`, answers kept per (id, language)
    pub covers: HashMap<String, Option<IpcValue>>,
    pub seeds: SeedQueue,
    /// `presenterShows`, by presenter view
    pub presenter_shows: HashMap<ViewId, PresenterShow>,
    /// `audiencePresenter`
    pub audience_presenter: HashMap<ViewId, ViewId>,
    /// `pastedImageSeq`
    pub pasted_image_seq: u32,
    /// bumped by every show-fullscreen call: a delayed release only runs
    /// when no newer call came (the debounce of `showFsRelease`)
    pub show_fs_ticket: u64,
}

impl AppState {
    /// `sessions.get(view)`
    pub fn session(&self, view: ViewId) -> Option<&SlideSession> {
        let slot = *self.attach.get(&view)?;
        self.slots.get(slot)?.as_ref()
    }

    pub fn session_mut(&mut self, view: ViewId) -> Option<&mut SlideSession> {
        let slot = *self.attach.get(&view)?;
        self.slots.get_mut(slot)?.as_mut()
    }

    pub fn has_session(&self, view: ViewId) -> bool {
        self.session(view).is_some()
    }

    /// The sender's session together with the clipboards a paste reads
    /// while it edits the session
    pub fn session_split(&mut self, view: ViewId) -> Option<(&mut SlideSession, StateRest<'_>)> {
        let slot = *self.attach.get(&view)?;
        let session = self.slots.get_mut(slot)?.as_mut()?;
        Some((
            session,
            StateRest {
                slide_clipboard: &mut self.slide_clipboard,
                last_slide_paste: &mut self.last_slide_paste,
                element_clipboard: &mut self.element_clipboard,
            },
        ))
    }

    /// The slot a view is attached to
    pub fn slot_of(&self, view: ViewId) -> Option<usize> {
        self.attach.get(&view).copied()
    }

    pub fn slot(&self, slot: usize) -> Option<&SlideSession> {
        self.slots.get(slot)?.as_ref()
    }

    pub fn slot_mut(&mut self, slot: usize) -> Option<&mut SlideSession> {
        self.slots.get_mut(slot)?.as_mut()
    }

    pub fn slot_count(&self) -> usize {
        self.slots.len()
    }

    /// `sessions.set(view, session)`: a new session in a new slot; answers
    /// the slot. The session the view held before loses the view and is
    /// dropped when no view is left on it.
    pub fn set_session(&mut self, view: ViewId, session: SlideSession) -> usize {
        self.slots.push(Some(session));
        let slot = self.slots.len() - 1;
        self.attach_view(view, slot);
        slot
    }

    /// `sessions.set(view, existing)`: the view joins the slot's session
    pub fn attach_view(&mut self, view: ViewId, slot: usize) {
        let previous = self.attach.insert(view, slot);
        if let Some(previous) = previous.filter(|p| *p != slot) {
            self.drop_if_unattached(previous);
        }
    }

    /// `sessions.delete(view)`
    pub fn detach_view(&mut self, view: ViewId) {
        if let Some(slot) = self.attach.remove(&view) {
            self.drop_if_unattached(slot);
        }
    }

    fn drop_if_unattached(&mut self, slot: usize) {
        if !self.attach.values().any(|s| *s == slot)
            && let Some(entry) = self.slots.get_mut(slot)
        {
            *entry = None;
        }
    }

    /// `attachedIds(session)`, in the order the views attached... views sort
    /// by id so the order is stable
    pub fn attached_ids(&self, slot: usize) -> Vec<ViewId> {
        let mut ids: Vec<ViewId> = self
            .attach
            .iter()
            .filter(|(_, s)| **s == slot)
            .map(|(view, _)| *view)
            .collect();
        ids.sort_by_key(|view| view.0);
        ids
    }

    /// `editorAttachedIds(session)`
    pub fn editor_attached_ids(&self, slot: usize) -> Vec<ViewId> {
        self.attached_ids(slot)
            .into_iter()
            .filter(|view| !self.viewers.contains(view))
            .collect()
    }

    /// `sessions.set(id, replacement)` for every view that shared `old`
    pub fn repoint(&mut self, old: usize, new: usize) {
        for slot in self.attach.values_mut() {
            if *slot == old {
                *slot = new;
            }
        }
        self.drop_if_unattached(old);
    }

    /// The slots that hold a session, once each
    pub fn live_slots(&self) -> Vec<usize> {
        (0..self.slots.len())
            .filter(|slot| self.slots[*slot].is_some())
            .collect()
    }
}

/// Everything a handler needs, cloned into each closure: the shared state
/// and the hosts
#[derive(Clone)]
pub struct App {
    pub state: Rc<RefCell<AppState>>,
    /// where [`super::with_app`] finds this app on the core thread
    pub registry_index: usize,
    pub services: Services,
    pub engine: SlidesEngineHost,
    pub shell: SlidesShellHost,
    pub dialogs: DialogsHost,
    pub os_shell: OsShellHost,
    pub clipboard: ClipboardHost,
    pub contents: ContentsHost,
    pub locale: LocaleHost,
    pub shared: Arc<Shared>,
    pub recovery_state: RecoveryStateHost,
    /// the attachment text cache, read on workers
    pub text_cache: super::files::SharedTextCache,
    /// what the batches provide to each other; read at call time
    pub provided: Rc<shell_contract::provided::Provided>,
    /// `autosaveBackoff`: ticks to skip after a failed recovery copy, per copy slot
    pub backoff: Rc<RefCell<HashMap<String, u32>>>,
}

/// A JSON number, for `tm` parameters
pub fn json_number(value: f64) -> JsonValue {
    JsonValue::Number(value)
}
