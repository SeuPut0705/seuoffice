//! `apps/slides/src/main/seed-queue.ts`.
//!
//! The module-level `Map` is a [`SeedQueue`] the caller keeps. The
//! `contents.once('destroyed', ...)` listener is the adapter's: when the event
//! fires it calls [`SeedQueue::forget`] with the id.

use crate::packages::electron_utils::generate_handoff::HandoffWebContents;

/// `RecoveryIdentity` of an untitled copy or of a file
pub use crate::packages::electron_utils::recovery_store::RecoveryIdentity;

/// `SlidesSeedOptions`; a key left out is `undefined`
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SlidesSeedOptions {
    /// The first save asks where instead of landing in the drafts folder
    pub ask_path_on_first_save: Option<bool>,
    /// the file name that first save suggests (a full path picks the folder too)
    pub suggested_name: Option<String>,
    /// the crash-recovery copy the deck was restored from
    pub recovery_id: Option<RecoveryIdentity>,
    /// the open password of a restored copy that was encrypted
    pub password: Option<String>,
}

/// one queued deck and its options
#[derive(Debug, Clone, PartialEq)]
pub struct SeedEntry {
    pub deck: Vec<u8>,
    pub options: SlidesSeedOptions,
}

/// queued decks by webContents id: one per new tab at most
#[derive(Debug, Default)]
pub struct SeedQueue {
    seeds: Vec<(f64, SeedEntry)>,
}

/// `Map` keys compare by SameValueZero
fn same_key(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

impl SeedQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// `queueSlidesSeedFor(contents, deck, options)`
    pub fn queue_slides_seed_for(
        &mut self,
        contents: &mut dyn HandoffWebContents,
        deck: Vec<u8>,
        options: SlidesSeedOptions,
    ) {
        if contents.is_destroyed() {
            return;
        }
        let id = contents.id();
        match self.seeds.iter_mut().find(|(k, _)| same_key(*k, id)) {
            Some(slot) => slot.1 = SeedEntry { deck, options },
            None => self.seeds.push((id, SeedEntry { deck, options })),
        }
        contents.once_destroyed();
    }

    /// the listener of `once('destroyed')`: `seeds.delete(id)`
    pub fn forget(&mut self, id: f64) {
        self.seeds.retain(|(k, _)| !same_key(*k, id));
    }

    /// `takeSlidesSeed(webContentsId)`
    pub fn take_slides_seed(&mut self, web_contents_id: f64) -> Option<Vec<u8>> {
        self.take_slides_seed_entry(web_contents_id)
            .map(|entry| entry.deck)
    }

    /// `takeSlidesSeedEntry(webContentsId)`
    pub fn take_slides_seed_entry(&mut self, web_contents_id: f64) -> Option<SeedEntry> {
        let at = self
            .seeds
            .iter()
            .position(|(k, _)| same_key(*k, web_contents_id))?;
        Some(self.seeds.remove(at).1)
    }
}
