//! The in-memory password state of `apps/docs/src/main/docx-encryption.ts`,
//! keyed per view and file path. Never persisted: a relaunch re-prompts, as
//! Word does. The crypto itself (officecrypto-tool) is the engine's
//! ([`super::hosts::DocsEngine`]); `docxOpenKind` is here, over `main-core`'s
//! compound file gate.

use std::collections::{HashMap, HashSet};

use main_core::packages::compound_file::assert_compound_file;
use shell_contract::ViewId;

const CFB_MAGIC: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/// How the open path takes the bytes of a .docx path (`docxOpenKind`)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OpenKind {
    Plain,
    Encrypted,
    Damaged,
}

/// `docxOpenKind(bytes)`: an encrypted OOXML file is a sound compound file
/// naming an `EncryptedPackage` stream; one the gate refuses is damaged
pub(crate) fn docx_open_kind(bytes: &[u8]) -> OpenKind {
    if bytes.len() < 8 || bytes[..8] != CFB_MAGIC {
        return OpenKind::Plain;
    }
    if assert_compound_file(bytes).is_err() {
        return OpenKind::Damaged;
    }
    let needle: Vec<u8> = "EncryptedPackage"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    if bytes.windows(needle.len()).any(|w| w == needle) {
        OpenKind::Encrypted
    } else {
        OpenKind::Plain
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Intent {
    password: Option<String>,
    revision: u64,
}

/// `DocPasswordSaveSnapshot`
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Snapshot {
    pub source_path: Option<String>,
    pub password: Option<String>,
    intent_revision: Option<u64>,
}

/// The module state of `docx-encryption.ts`
pub(crate) struct Passwords {
    /// password that decrypts the bytes on disk
    disk: HashMap<ViewId, HashMap<String, String>>,
    /// desired password for the next save of an existing document
    desired: HashMap<ViewId, HashMap<String, Intent>>,
    /// desired password for the next save of a pathless document
    pending_new: HashMap<ViewId, Intent>,
    next_revision: u64,
    /// paths whose on-disk bytes are encrypted
    disk_encrypted: HashMap<ViewId, HashSet<String>>,
}

impl Default for Passwords {
    fn default() -> Self {
        Passwords {
            disk: HashMap::new(),
            desired: HashMap::new(),
            pending_new: HashMap::new(),
            next_revision: 1,
            disk_encrypted: HashMap::new(),
        }
    }
}

impl Passwords {
    fn set_disk(&mut self, view: ViewId, path: &str, password: Option<&str>) {
        let for_view = self.disk.entry(view).or_default();
        match password.filter(|p| !p.is_empty()) {
            Some(p) => {
                for_view.insert(path.to_owned(), p.to_owned());
            }
            None => {
                for_view.remove(path);
            }
        }
        if for_view.is_empty() {
            self.disk.remove(&view);
        }
    }

    /// `rememberDocPassword(wcId, filePath, password)`
    pub fn remember(&mut self, view: ViewId, path: &str, password: Option<&str>) {
        self.set_disk(view, path, password)
    }

    /// `docPasswordFor(wcId, filePath)`
    pub fn password_for(&self, view: ViewId, path: Option<&str>) -> Option<String> {
        let path = path.filter(|p| !p.is_empty())?;
        self.disk.get(&view)?.get(path).cloned()
    }

    /// `setDocPassword(wcId, filePath, password)`
    pub fn set(&mut self, view: ViewId, path: Option<&str>, password: Option<&str>) {
        let intent = Intent {
            password: password.map(str::to_owned),
            revision: self.next_revision,
        };
        self.next_revision += 1;
        match path.filter(|p| !p.is_empty()) {
            Some(path) => {
                self.desired
                    .entry(view)
                    .or_default()
                    .insert(path.to_owned(), intent);
            }
            None => {
                self.pending_new.insert(view, intent);
            }
        }
    }

    /// `currentDocPasswordIntentRevision()`
    pub fn current_revision(&self) -> u64 {
        self.next_revision - 1
    }

    /// `discardDocPasswordIntents(wcId, throughRevision)`
    pub fn discard(&mut self, view: ViewId, through: u64) {
        if let Some(for_view) = self.desired.get_mut(&view) {
            for_view.retain(|_, intent| intent.revision > through);
            if for_view.is_empty() {
                self.desired.remove(&view);
            }
        }
        if self
            .pending_new
            .get(&view)
            .is_some_and(|i| i.revision <= through)
        {
            self.pending_new.remove(&view);
        }
    }

    /// `snapshotDocPassword(wcId, filePath)`
    pub fn snapshot(&self, view: ViewId, path: Option<&str>) -> Snapshot {
        let path = path.filter(|p| !p.is_empty());
        let intent = match path {
            Some(p) => self.desired.get(&view).and_then(|m| m.get(p)),
            None => self.pending_new.get(&view),
        };
        Snapshot {
            source_path: path.map(str::to_owned),
            password: match intent {
                Some(i) => i.password.clone(),
                None => self.password_for(view, path),
            },
            intent_revision: intent.map(|i| i.revision),
        }
    }

    /// `commitDocPasswordSave(wcId, snapshot, savedPath)`: whether a newer
    /// intent remains for the saved path
    pub fn commit_save(&mut self, view: ViewId, snapshot: &Snapshot, saved: &str) -> bool {
        self.set_disk(view, saved, snapshot.password.as_deref());
        self.mark_encrypted(view, saved, snapshot.password.is_some());
        let mut for_view = self.desired.remove(&view).unwrap_or_default();
        match &snapshot.source_path {
            None => {
                let current = self.pending_new.remove(&view);
                for_view.remove(saved);
                if let Some(current) = current
                    && Some(current.revision) != snapshot.intent_revision
                {
                    for_view.insert(saved.to_owned(), current);
                }
            }
            Some(source) if source == saved => {
                if for_view.get(source).map(|i| i.revision) == snapshot.intent_revision
                    && snapshot.intent_revision.is_some()
                {
                    for_view.remove(source);
                }
            }
            Some(source) => {
                let current = for_view.remove(source);
                for_view.remove(saved);
                if let Some(current) = current
                    && Some(current.revision) != snapshot.intent_revision
                {
                    for_view.insert(saved.to_owned(), current);
                }
            }
        }
        let pending = for_view.contains_key(saved);
        if !for_view.is_empty() {
            self.desired.insert(view, for_view);
        }
        pending
    }

    /// `renameDocPassword(wcId, oldPath, newPath)`
    pub fn rename(&mut self, view: ViewId, old: &str, new: &str) {
        if let Some(m) = self.disk.get_mut(&view)
            && let Some(p) = m.remove(old)
        {
            m.insert(new.to_owned(), p);
        }
        if let Some(m) = self.desired.get_mut(&view)
            && let Some(i) = m.remove(old)
        {
            m.insert(new.to_owned(), i);
        }
        if let Some(s) = self.disk_encrypted.get_mut(&view)
            && s.remove(old)
        {
            s.insert(new.to_owned());
        }
    }

    /// `markDiskEncrypted(wcId, filePath, encrypted)`
    pub fn mark_encrypted(&mut self, view: ViewId, path: &str, encrypted: bool) {
        let set = self.disk_encrypted.entry(view).or_default();
        if encrypted {
            set.insert(path.to_owned());
        } else {
            set.remove(path);
        }
    }

    /// `isDiskEncrypted(wcId, filePath)`
    pub fn is_encrypted(&self, view: ViewId, path: &str) -> bool {
        self.disk_encrypted
            .get(&view)
            .is_some_and(|s| s.contains(path))
    }

    /// `forgetDocPasswords(wcId)`
    pub fn forget(&mut self, view: ViewId) {
        self.disk.remove(&view);
        self.desired.remove(&view);
        self.pending_new.remove(&view);
        self.disk_encrypted.remove(&view);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const V: ViewId = ViewId(1);

    #[test]
    fn an_intent_set_during_a_save_survives_its_commit() {
        let mut p = Passwords::default();
        p.set(V, Some("/a.docx"), Some("one"));
        let snap = p.snapshot(V, Some("/a.docx"));
        assert_eq!(snap.password.as_deref(), Some("one"));
        p.set(V, Some("/a.docx"), Some("two"));
        assert!(p.commit_save(V, &snap, "/a.docx"));
        assert_eq!(p.password_for(V, Some("/a.docx")).as_deref(), Some("one"));
        assert_eq!(
            p.snapshot(V, Some("/a.docx")).password.as_deref(),
            Some("two")
        );
    }

    #[test]
    fn a_first_save_moves_the_pending_intent_to_the_new_path() {
        let mut p = Passwords::default();
        p.set(V, None, Some("pw"));
        let snap = p.snapshot(V, None);
        assert!(!p.commit_save(V, &snap, "/n.docx"));
        assert!(p.is_encrypted(V, "/n.docx"));
        assert_eq!(p.password_for(V, Some("/n.docx")).as_deref(), Some("pw"));
    }

    #[test]
    fn discard_keeps_intents_newer_than_the_cutoff() {
        let mut p = Passwords::default();
        p.set(V, Some("/a"), Some("x"));
        let cut = p.current_revision();
        p.set(V, Some("/b"), Some("y"));
        p.discard(V, cut);
        assert_eq!(p.snapshot(V, Some("/a")).password, None);
        assert_eq!(p.snapshot(V, Some("/b")).password.as_deref(), Some("y"));
    }

    #[test]
    fn a_zip_is_plain_and_a_bad_compound_file_is_damaged() {
        assert_eq!(docx_open_kind(b"PK\x03\x04rest"), OpenKind::Plain);
        let mut cfb = CFB_MAGIC.to_vec();
        cfb.extend_from_slice(&[0; 8]);
        assert_eq!(docx_open_kind(&cfb), OpenKind::Damaged);
    }
}
