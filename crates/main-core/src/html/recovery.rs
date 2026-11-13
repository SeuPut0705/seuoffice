//! `apps/html/src/main/recovery.ts`: crash-recovery copies for a text editor.
//! `apps/markdown/src/main/recovery.ts` is the same file byte for byte, so
//! `crate::markdown::recovery` re-exports this module: one implementation.
//!
//! What moved: every judgment of `createTextRecovery`, as a [`TextRecovery`]
//! the caller owns, one method per function the closure returned (the
//! `contract` object's methods included).
//!
//! What stays with the caller:
//! - The Electron objects: [`TextRecoveryContents`] is the part of a
//!   `WebContents` the module calls, [`TextRecoveryHost`] the host object of
//!   the TypeScript. `host.userDataDir` is gone: the caller builds the one
//!   [`RecoveryStore`] over that folder (`getStore`'s lazy
//!   `createRecoveryStore`) and hands it to [`TextRecovery::new`] with the
//!   process's [`HeadlessMode`] and the random source behind
//!   `crypto.randomUUID`.
//! - Events and timers. `contents.once('render-process-gone', ...)` is
//!   [`TextRecovery::track`], which answers a [`RenderGoneListener`] the
//!   caller fires with [`TextRecovery::render_process_gone`]. The promise of
//!   `writeCopiesNow` is a [`FlushRound`]: the caller starts one
//!   [`RECOVERY_FLUSH_TIMEOUT_MS`] timer per waiter, calls
//!   [`TextRecovery::flush_timeout`] when it fires, and reads
//!   [`TextRecovery::flush_settled`] where the TypeScript awaits.
//! - `ipcMain` plumbing, and the adapter of `RecoveryEditorContract`: it
//!   forwards to [`TextRecovery::write_copies_now`] and the other methods
//!   below, because `write_copies_now` answers the round it waits on.
//!
//! Promises are plain calls. The one place the TypeScript lets another call
//! in while it waits is the prompt of `resolveOpen`; every method takes
//! `&self` and no cell stays borrowed across a host call, so a host whose
//! dialog pumps events can call back in, as the TypeScript allows.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

use jscompat::node_path::host::basename;
use jscompat::{JsMap, truthy};

use crate::node_fs::NodeError;
use crate::packages::electron_utils::headless_mode::HeadlessMode;
use crate::packages::electron_utils::message_box::{MessageBox, ParentWindow};
use crate::packages::electron_utils::recovery_contract::{
    RecoveryOpenDecision, RecoveryOpenFileRequest, RecoveryOpenUntitledRequest,
};
use crate::packages::electron_utils::recovery_prompt::{
    RecoveryOpenResult, ResolveRecoveryOnOpenOptions, resolve_recovery_on_open,
};
use crate::packages::electron_utils::recovery_store::{
    RecoveryDeleteReason, RecoveryFileIdentity, RecoveryIdentity, RecoveryStore,
    RecoveryUntitledIdentity, RecoveryWriteOptions, RecoveryWriteResult, new_untitled_recovery_id,
};

/// how long `writeCopiesNow` waits for one renderer to send its copy
pub const RECOVERY_FLUSH_TIMEOUT_MS: f64 = 3_000.0;

/// the part of a `WebContents` this module calls
pub trait TextRecoveryContents {
    fn id(&self) -> i64;
    fn is_destroyed(&self) -> bool;
    fn reload(&self);
    /// `contents.send(channel)`; an `Err` is a throw
    fn send(&self, channel: &str) -> Result<(), NodeError>;
}

/// `TextRecoveryHost`
pub trait TextRecoveryHost {
    type Contents: TextRecoveryContents + Clone;
    /// what `parentOf` answers (a `BrowserWindow`)
    type Window: ParentWindow;
    type Dialog: MessageBox<Self::Window>;

    /// 'markdown' | 'html'
    fn kind(&self) -> &str;
    /// the format an untitled document's copy is written in ('.md', '.html')
    fn untitled_ext(&self) -> String;
    fn dialog(&self) -> &Self::Dialog;
    fn parent_of(&self, contents: &Self::Contents) -> Option<Self::Window>;
    fn lang(&self) -> String;
    /// the document's save target; `None` while untitled
    fn save_path(&self, wc_id: i64) -> Option<String>;
    /// the file the view opens (its pending open); `None` for an untitled view
    fn open_path(&self, wc_id: i64) -> Option<String>;
    /// the main process's unsaved-changes flag for the view
    fn is_dirty(&self, wc_id: i64) -> bool;
    /// point an existing view at `file_path`: grant it, make it the open path and the save target
    fn adopt_file(&self, contents: &Self::Contents, file_path: &str);
    /// The restored text replaces the file's: record the disk state the save
    /// guard compares with. The TypeScript property is optional; a host
    /// without it leaves this as it is.
    fn restored_file(&self, _wc_id: i64, _file_path: &str) {}
    /// last-resort title of an untitled document's copy
    fn untitled_fallback_title(&self) -> String;
    /// main to renderer channel: "send your copy now"
    fn flush_channel(&self) -> String;
    /// `console.warn(message, detail)`
    fn warn(&self, message: &str, detail: &str);
}

/// what a copy write answered
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextRecoveryWriteResult {
    Written,
    Superseded,
    Unchanged,
    Skipped,
}

impl TextRecoveryWriteResult {
    pub fn as_str(self) -> &'static str {
        match self {
            TextRecoveryWriteResult::Written => "written",
            TextRecoveryWriteResult::Superseded => "superseded",
            TextRecoveryWriteResult::Unchanged => "unchanged",
            TextRecoveryWriteResult::Skipped => "skipped",
        }
    }
}

/// a restored copy's text (see [`TextRecovery::resolve_open`])
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveredText {
    pub text: String,
    pub original_path: Option<String>,
}

/// `setTitleSource`'s function: the shell's tab title of a view; an `Err` is a throw
pub type TitleSource<C> = Rc<dyn Fn(&C) -> Result<Option<String>, NodeError>>;

/// one renderer a `writeCopiesNow` round waits for; `token` names its timer
#[derive(Debug, Clone, PartialEq)]
pub struct FlushWaiter {
    pub wc_id: i64,
    pub token: u64,
}

/// the promise `writeCopiesNow` returned: it settles when every waiter has
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FlushRound {
    pub waiters: Vec<FlushWaiter>,
}

struct ViewState<C> {
    id: i64,
    contents: C,
    /// the copy identity while the document has no save path (untitled, or a restored missing original)
    untitled: Option<RecoveryIdentity>,
    /// the text of this tab's last copy; `None` when there is none to compare with
    last_text: Option<String>,
    /// this tab wrote (or loaded) the copy of its current identity
    owns: bool,
    /// the renderer process died: the copy outlives the view
    crashed: bool,
    /// the renderer already asked how to open (a later decision reloads it)
    asked: bool,
    /// the per-file prompt is open: no copy is written until it is answered
    resolving: bool,
    /// the shell's answer for the next open (launch list / restored tab)
    decision: Option<RecoveryOpenDecision>,
    /// an untitled copy to load on the next open
    untitled_seed: Option<RecoveryIdentity>,
    /// the title the shell gave an untitled copy, or the editor's provisional title
    title: Option<String>,
    /// first Save As suggestion of a restored document whose original is missing
    save_as_default_path: Option<String>,
    /// a copy left under the path the file had before a rename; dropped after the next write
    renamed_from: Option<RecoveryIdentity>,
    /// the identity this tab's last copy was written under
    written_as: Option<RecoveryIdentity>,
    /// the timers of the `writeCopiesNow` rounds still waiting for this view
    flush_waiters: Vec<u64>,
}

type View<C> = Rc<RefCell<ViewState<C>>>;

/// The listener `track` put on `render-process-gone`, which fires once: the
/// caller keeps it and hands it to [`TextRecovery::render_process_gone`] when
/// the event comes.
pub struct RenderGoneListener<C> {
    state: View<C>,
    fired: Cell<bool>,
}

fn same_identity(a: &RecoveryIdentity, b: &RecoveryIdentity) -> bool {
    match (a, b) {
        (RecoveryIdentity::Untitled(a), RecoveryIdentity::Untitled(b)) => {
            a.kind == b.kind && a.untitled_id == b.untitled_id
        }
        (RecoveryIdentity::File(a), RecoveryIdentity::File(b)) => {
            a.kind == b.kind && a.file_path == b.file_path
        }
        _ => false,
    }
}

/// `createTextRecovery(host)`
pub struct TextRecovery<'s, H: TextRecoveryHost> {
    host: H,
    store: &'s RecoveryStore<'s>,
    headless: &'s HeadlessMode,
    /// `crypto.randomUUID()`, for an untitled document's copy id
    random_uuid: &'s dyn Fn() -> String,
    views: RefCell<JsMap<View<H::Contents>>>,
    title_source: RefCell<Option<TitleSource<H::Contents>>>,
    /// the timers that fired or whose view settled: their waiters are done
    settled: RefCell<HashSet<u64>>,
    next_waiter: Cell<u64>,
}

impl<'s, H: TextRecoveryHost> TextRecovery<'s, H> {
    pub fn new(
        host: H,
        store: &'s RecoveryStore<'s>,
        headless: &'s HeadlessMode,
        random_uuid: &'s dyn Fn() -> String,
    ) -> Self {
        TextRecovery {
            host,
            store,
            headless,
            random_uuid,
            views: RefCell::new(JsMap::new()),
            title_source: RefCell::new(None),
            settled: RefCell::new(HashSet::new()),
            next_waiter: Cell::new(0),
        }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    /// recovery never breaks the editor: a store failure is logged and ignored
    fn quietly(&self, what: &str, task: impl FnOnce() -> Result<(), NodeError>) {
        if let Err(error) = task() {
            self.host.warn(
                &format!("[{}] recovery {} failed:", self.host.kind(), what),
                &error.message,
            );
        }
    }

    fn state_of(&self, contents: &H::Contents) -> View<H::Contents> {
        let key = contents.id().to_string();
        let mut views = self.views.borrow_mut();
        if let Some(state) = views.get(&key) {
            return Rc::clone(state);
        }
        let state = Rc::new(RefCell::new(ViewState {
            id: contents.id(),
            contents: contents.clone(),
            untitled: None,
            last_text: None,
            owns: false,
            crashed: false,
            asked: false,
            resolving: false,
            decision: None,
            untitled_seed: None,
            title: None,
            save_as_default_path: None,
            renamed_from: None,
            written_as: None,
            flush_waiters: Vec::new(),
        }));
        views.set(key, Rc::clone(&state));
        state
    }

    fn view_of(&self, wc_id: i64) -> Option<View<H::Contents>> {
        self.views.borrow().get(&wc_id.to_string()).cloned()
    }

    /// the views in the order the `Map` holds them
    fn all_views(&self) -> Vec<View<H::Contents>> {
        self.views.borrow().values().cloned().collect()
    }

    fn identity_for(&self, wc_id: i64, state: &View<H::Contents>) -> RecoveryIdentity {
        let save_path = self.host.save_path(wc_id);
        if let Some(file_path) = truthy(save_path.as_deref()) {
            return RecoveryIdentity::File(RecoveryFileIdentity {
                kind: self.host.kind().to_owned(),
                file_path: file_path.to_owned(),
            });
        }
        let mut state = state.borrow_mut();
        if state.untitled.is_none() {
            state.untitled = Some(RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
                kind: self.host.kind().to_owned(),
                untitled_id: new_untitled_recovery_id(self.random_uuid),
                ext: self.host.untitled_ext(),
            }));
        }
        match &state.untitled {
            Some(identity) => identity.clone(),
            None => unreachable!("the untitled identity was set above"),
        }
    }

    fn copy_title(&self, state: &View<H::Contents>, identity: &RecoveryIdentity) -> String {
        if let RecoveryIdentity::File(file) = identity {
            return basename(&file.file_path, None);
        }
        let contents = state.borrow().contents.clone();
        let source = self.title_source.borrow().clone();
        let from_shell = match source {
            Some(source) => source(&contents).unwrap_or(None),
            None => None,
        };
        if let Some(title) = truthy(from_shell.as_deref()) {
            return title.to_owned();
        }
        let own = state.borrow().title.clone();
        if let Some(title) = truthy(own.as_deref()) {
            return title.to_owned();
        }
        self.host.untitled_fallback_title()
    }

    fn settle_flush(&self, state: &View<H::Contents>) {
        let waiters: Vec<u64> = std::mem::take(&mut state.borrow_mut().flush_waiters);
        self.settled.borrow_mut().extend(waiters);
    }

    /// the renderer process is gone or reloads: it will ask again (or never)
    fn reload_if_asked(&self, state: &View<H::Contents>) {
        let contents = {
            let state = state.borrow();
            if !state.asked || state.contents.is_destroyed() {
                return;
            }
            state.contents.clone()
        };
        state.borrow_mut().asked = false;
        contents.reload();
    }

    /// the copy `identity` is (or was) this view's: its save or open path, or what it last wrote
    fn shows_copy(
        &self,
        wc_id: i64,
        state: &ViewState<H::Contents>,
        identity: &RecoveryIdentity,
    ) -> bool {
        if let Some(written) = &state.written_as
            && same_identity(written, identity)
        {
            return true;
        }
        if let Some(untitled) = &state.untitled
            && same_identity(untitled, identity)
        {
            return true;
        }
        let RecoveryIdentity::File(file) = identity else {
            return false;
        };
        self.host.save_path(wc_id).as_deref() == Some(file.file_path.as_str())
            || self.host.open_path(wc_id).as_deref() == Some(file.file_path.as_str())
    }

    fn delete_for(
        &self,
        state: &View<H::Contents>,
        identity: &RecoveryIdentity,
        reason: RecoveryDeleteReason,
    ) {
        self.quietly("delete", || {
            self.store.delete_copy(identity, reason).map(|_| ())
        });
        {
            let mut state = state.borrow_mut();
            state.last_text = None;
            state.owns = false;
            state.written_as = None;
        }
        // panes on the same file share the copy: one still unsaved must write it again
        let mut shared = false;
        for other in self.all_views() {
            if Rc::ptr_eq(&other, state) {
                continue;
            }
            let id = other.borrow().id;
            if !self.shows_copy(id, &other.borrow(), identity) {
                continue;
            }
            {
                let mut other = other.borrow_mut();
                other.last_text = None;
                other.owns = false;
                other.written_as = None;
            }
            shared = true;
        }
        // "Don't Save" blocks the copy until the close is cancelled; another pane's
        // edits were not thrown away, so its copies go on
        if reason == RecoveryDeleteReason::DontSave && shared {
            self.quietly("resume", || self.store.clear_discarded(identity));
        }
    }

    fn read_text(&self, identity: &RecoveryIdentity) -> Option<String> {
        self.store
            .read_copy(identity)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    /// another live view shows the same file and already settled its copy question
    fn sibling_owns_path(&self, wc_id: i64, file_path: &str) -> bool {
        for other in self.all_views() {
            let (id, destroyed, resolving) = {
                let other = other.borrow();
                (other.id, other.contents.is_destroyed(), other.resolving)
            };
            if id == wc_id || destroyed || resolving {
                continue;
            }
            if self.host.save_path(id).as_deref() == Some(file_path)
                || self.host.open_path(id).as_deref() == Some(file_path)
            {
                return true;
            }
        }
        false
    }

    /// start tracking a view (call once, when it is created)
    pub fn track(&self, contents: &H::Contents) -> RenderGoneListener<H::Contents> {
        RenderGoneListener {
            state: self.state_of(contents),
            fired: Cell::new(false),
        }
    }

    /// the `render-process-gone` listener `track` made fires (only the first time)
    pub fn render_process_gone(&self, listener: &RenderGoneListener<H::Contents>) {
        if listener.fired.replace(true) {
            return;
        }
        listener.state.borrow_mut().crashed = true;
        self.settle_flush(&listener.state);
    }

    /// The view is being destroyed: delete the copy it wrote when it closes
    /// clean, keep it otherwise. Call before the module drops the view's dirty flag.
    pub fn forget(&self, wc_id: i64) {
        let removed = self.views.borrow_mut().delete(&wc_id.to_string());
        let Some(state) = removed else {
            return;
        };
        self.settle_flush(&state);
        let (crashed, owns) = {
            let state = state.borrow();
            (state.crashed, state.owns)
        };
        if crashed || self.host.is_dirty(wc_id) || !owns {
            return;
        }
        let identity = self.identity_for(wc_id, &state);
        self.delete_for(&state, &identity, RecoveryDeleteReason::ClosedClean);
    }

    /// the renderer's copy (`None`: nothing to write, only answers a flush request)
    pub fn write_copy(
        &self,
        contents: &H::Contents,
        text: Option<&str>,
    ) -> Result<TextRecoveryWriteResult, NodeError> {
        let Some(state) = self.view_of(contents.id()) else {
            return Ok(TextRecoveryWriteResult::Skipped);
        };
        let result = self.write_copy_of(contents.id(), &state, text);
        self.settle_flush(&state);
        result
    }

    fn write_copy_of(
        &self,
        wc_id: i64,
        state: &View<H::Contents>,
        text: Option<&str>,
    ) -> Result<TextRecoveryWriteResult, NodeError> {
        let Some(text) = text else {
            return Ok(TextRecoveryWriteResult::Skipped);
        };
        {
            let state = state.borrow();
            if state.resolving || state.crashed {
                return Ok(TextRecoveryWriteResult::Skipped);
            }
        }
        if !self.host.is_dirty(wc_id) {
            return Ok(TextRecoveryWriteResult::Skipped);
        }
        if state.borrow().last_text.as_deref() == Some(text) {
            return Ok(TextRecoveryWriteResult::Unchanged);
        }
        let identity = self.identity_for(wc_id, state);
        let options = RecoveryWriteOptions {
            title: Some(self.copy_title(state, &identity)),
            ..RecoveryWriteOptions::default()
        };
        let result = self
            .store
            .write_copy(&identity, text.as_bytes(), &options)?;
        if result != RecoveryWriteResult::Written {
            return Ok(TextRecoveryWriteResult::Superseded);
        }
        let old = {
            let mut state = state.borrow_mut();
            state.last_text = Some(text.to_owned());
            state.owns = true;
            state.written_as = Some(identity);
            state.renamed_from.take()
        };
        // the copy under the pre-rename path is replaced by this one
        if let Some(old) = old {
            self.quietly("delete", || {
                self.store
                    .delete_copy(&old, RecoveryDeleteReason::ClosedClean)
                    .map(|_| ())
            });
        }
        Ok(TextRecoveryWriteResult::Written)
    }

    /// the identity the view's copy has before a save; pass it to [`Self::saved`] afterwards
    pub fn identity_of(&self, wc_id: i64) -> Option<RecoveryIdentity> {
        let state = self.view_of(wc_id)?;
        Some(self.identity_for(wc_id, &state))
    }

    /// a save succeeded: delete the copy of the identity the document had when the save began
    pub fn saved(&self, wc_id: i64, before: Option<&RecoveryIdentity>) {
        let Some(state) = self.view_of(wc_id) else {
            return;
        };
        if let Some(before) = before {
            self.delete_for(&state, before, RecoveryDeleteReason::Saved);
        } else {
            let mut state = state.borrow_mut();
            state.last_text = None;
            state.owns = false;
        }
        // the document has a path now; a restored missing original is saved
        let save_path = self.host.save_path(wc_id);
        if truthy(save_path.as_deref()).is_some() {
            let mut state = state.borrow_mut();
            state.untitled = None;
            state.save_as_default_path = None;
        }
    }

    /// "Don't Save" / MCP close without saving
    pub fn dont_save(&self, wc_id: i64) {
        let Some(state) = self.view_of(wc_id) else {
            return;
        };
        let identity = self.identity_for(wc_id, &state);
        self.delete_for(&state, &identity, RecoveryDeleteReason::DontSave);
    }

    /// a save to `file_path` given from outside (MCP) failed and the old target is back
    pub fn save_to_path_failed(&self, wc_id: i64, file_path: &str) {
        let Some(state) = self.view_of(wc_id) else {
            return;
        };
        let target = RecoveryIdentity::File(RecoveryFileIdentity {
            kind: self.host.kind().to_owned(),
            file_path: file_path.to_owned(),
        });
        // the failed save pointed at the document's own path: that copy is its own
        if same_identity(&self.identity_for(wc_id, &state), &target) {
            return;
        }
        let written_as = state.borrow().written_as.clone();
        match written_as {
            Some(written) if same_identity(&written, &target) => {}
            _ => return,
        }
        self.delete_for(&state, &target, RecoveryDeleteReason::DontSave);
        // a cleanup, not the user's "Don't Save": that path takes copies as usual
        self.quietly("resume", || self.store.clear_discarded(&target));
    }

    /// the file was renamed on disk while open; an `Err` is the throw of `contents.send`
    pub fn renamed(&self, wc_id: i64, old_path: &str) -> Result<(), NodeError> {
        let Some(state) = self.view_of(wc_id) else {
            return Ok(());
        };
        if !state.borrow().owns {
            return Ok(());
        }
        // the next copy lands under the new path; the old one goes once it has
        let contents = {
            let mut state = state.borrow_mut();
            state.renamed_from = Some(RecoveryIdentity::File(RecoveryFileIdentity {
                kind: self.host.kind().to_owned(),
                file_path: old_path.to_owned(),
            }));
            state.last_text = None;
            state.owns = false;
            state.contents.clone()
        };
        if !contents.is_destroyed() {
            contents.send(&self.host.flush_channel())?;
        }
        Ok(())
    }

    /// The renderer's open question: the text to load instead of the file, or
    /// `None`. `original_path` names the file an untitled restored copy came
    /// from (its original is missing): it tells the editor the format, not
    /// the save target.
    pub fn resolve_open(&self, contents: &H::Contents) -> Option<RecoveredText> {
        let state = self.state_of(contents);
        state.borrow_mut().asked = true;
        // a hidden export window never asks and never restores
        if self.headless.is_headless_mode() {
            return None;
        }
        let seed = state.borrow_mut().untitled_seed.take();
        if let Some(seed) = seed {
            let text = self.read_text(&seed)?;
            self.quietly("mark loaded", || {
                self.store.mark_copy_loaded(&seed).map(|_| ())
            });
            let mut state = state.borrow_mut();
            state.owns = true;
            // the file this copy was of: the old path of a missing original, or
            // the original an untitled copy names; the document stays untitled
            let original_path = state.save_as_default_path.clone().or_else(|| match &seed {
                RecoveryIdentity::File(file) => Some(file.file_path.clone()),
                RecoveryIdentity::Untitled(_) => None,
            });
            return Some(RecoveredText {
                text,
                original_path: truthy(original_path.as_deref()).map(str::to_owned),
            });
        }
        let open_path = self.host.open_path(contents.id());
        let file_path = truthy(open_path.as_deref())?.to_owned();
        let identity = RecoveryIdentity::File(RecoveryFileIdentity {
            kind: self.host.kind().to_owned(),
            file_path: file_path.clone(),
        });
        let decision = state.borrow_mut().decision.take();
        match decision {
            Some(RecoveryOpenDecision::Original) => return None,
            Some(RecoveryOpenDecision::Restore) => {
                let text = self.read_text(&identity)?;
                self.quietly("mark loaded", || {
                    self.store.mark_copy_loaded(&identity).map(|_| ())
                });
                state.borrow_mut().owns = true;
                self.host.restored_file(contents.id(), &file_path);
                return Some(RecoveredText {
                    text,
                    original_path: None,
                });
            }
            None => {}
        }
        if self.sibling_owns_path(contents.id(), &file_path) {
            return None;
        }
        state.borrow_mut().resolving = true;
        let parent = self.host.parent_of(contents);
        let lang = self.host.lang();
        let result = resolve_recovery_on_open(&ResolveRecoveryOnOpenOptions {
            store: self.store,
            identity: &identity,
            dialog: self.host.dialog(),
            parent: parent.as_ref(),
            lang: &lang,
            document_name: None,
        });
        let recovered = match result {
            Ok(RecoveryOpenResult::Restore { bytes, .. }) => {
                state.borrow_mut().owns = true;
                self.host.restored_file(contents.id(), &file_path);
                Some(RecoveredText {
                    text: String::from_utf8_lossy(&bytes).into_owned(),
                    original_path: None,
                })
            }
            Ok(RecoveryOpenResult::Original) => None,
            Err(error) => {
                self.host.warn(
                    &format!("[{}] recovery open failed:", self.host.kind()),
                    &error.message,
                );
                None
            }
        };
        state.borrow_mut().resolving = false;
        recovered
    }

    /// the default Save As path for an untitled view, when recovery has one
    pub fn save_as_default_path(&self, wc_id: i64) -> Option<String> {
        let state = self.view_of(wc_id)?;
        let state = state.borrow();
        if let Some(path) = truthy(state.save_as_default_path.as_deref()) {
            return Some(path.to_owned());
        }
        // a copy of a missing original reopened without a suggestion: its old path
        match &state.untitled {
            Some(RecoveryIdentity::File(file)) => Some(file.file_path.clone()),
            _ => None,
        }
    }

    /// remember an untitled document's own title (the editor's provisional name)
    pub fn set_title(&self, wc_id: i64, title: &str) {
        if let Some(state) = self.view_of(wc_id) {
            state.borrow_mut().title = Some(title.to_owned());
        }
    }

    /// where the title of an untitled copy comes from first (the shell's tab title)
    pub fn set_title_source(&self, source: Option<TitleSource<H::Contents>>) {
        *self.title_source.borrow_mut() = source;
    }

    // ---- contract ----

    /// `contract.kind`
    pub fn kind(&self) -> &str {
        self.host.kind()
    }

    /// `contract.writeCopiesNow()`: ask every dirty renderer for its copy now
    pub fn write_copies_now(&self) -> FlushRound {
        let mut round = FlushRound::default();
        for state in self.all_views() {
            let (id, crashed, contents) = {
                let state = state.borrow();
                (state.id, state.crashed, state.contents.clone())
            };
            if crashed || contents.is_destroyed() || !self.host.is_dirty(id) {
                continue;
            }
            let token = self.next_waiter.get();
            self.next_waiter.set(token + 1);
            state.borrow_mut().flush_waiters.push(token);
            round.waiters.push(FlushWaiter { wc_id: id, token });
            if contents.send(&self.host.flush_channel()).is_err() {
                self.settle_flush(&state);
            }
        }
        round
    }

    /// the [`RECOVERY_FLUSH_TIMEOUT_MS`] timer of a waiter fired
    pub fn flush_timeout(&self, token: u64) {
        self.settled.borrow_mut().insert(token);
    }

    /// whether one waiter is done (its timer can be cleared)
    pub fn waiter_settled(&self, token: u64) -> bool {
        self.settled.borrow().contains(&token)
    }

    /// whether the promise of the round has resolved
    pub fn flush_settled(&self, round: &FlushRound) -> bool {
        round
            .waiters
            .iter()
            .all(|waiter| self.waiter_settled(waiter.token))
    }

    /// `contract.openFileWithDecision(contents, request)`
    pub fn open_file_with_decision(
        &self,
        contents: &H::Contents,
        request: &RecoveryOpenFileRequest,
    ) {
        let state = self.state_of(contents);
        self.host.adopt_file(contents, &request.file_path);
        state.borrow_mut().decision = Some(request.decision);
        self.reload_if_asked(&state);
    }

    /// `contract.openUntitledCopy(contents, request)`
    pub fn open_untitled_copy(
        &self,
        contents: &H::Contents,
        request: &RecoveryOpenUntitledRequest,
    ) {
        let state = self.state_of(contents);
        {
            let mut state = state.borrow_mut();
            state.untitled = Some(request.copy.clone());
            state.untitled_seed = Some(request.copy.clone());
            state.title = Some(request.title.clone());
            state.save_as_default_path = request.save_as_default_path.clone();
        }
        self.reload_if_asked(&state);
    }

    /// `contract.isUnprotectable()`: password documents do not exist in these editors
    pub fn is_unprotectable(&self, _contents: &H::Contents) -> bool {
        false
    }
}
