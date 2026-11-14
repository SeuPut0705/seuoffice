//! `translate/migrate.ts`: carrying stored translations over an in-app save
//! (spec 8). The save changes the file bytes and so the document key, but not
//! the chapter paths the fingerprints are made from. A block whose chapter
//! path and text did not change keeps its key in the saved book, so the
//! store's `migrateDocument` moves exactly the blocks whose key the saved book
//! still has (`keepBlockKeys`); the translation of an edited block stays behind.
//!
//! `epubMigrationInfo` reads the saved book (`epubTranslationUnits(saved)`);
//! the caller does that, and passes the paths of its spine items and the keys
//! of the units it read.

use crate::pdf_structure::{MigrateInput, TranslationBlockKey};
use crate::translate::keys::{epub_chapter_fingerprint, epub_metadata_fingerprint};
use crate::utf16::units;

/// `EpubMigrationInfo`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpubMigrationInfo {
    pub input: MigrateInput,
    /// the keys of every unit of the saved book (all chapters, title and contents)
    pub block_keys: Vec<TranslationBlockKey>,
}

/// `epubMigrationInfo`: the input of `ResultStore.migrateDocument` for a saved
/// book: the title and contents fingerprint and every spine chapter's, plus the
/// block keys the saved book has, which are the only translation blocks that move.
pub fn epub_migration_info(
    spine_paths: &[String],
    block_keys: Vec<TranslationBlockKey>,
    old_doc_hash: &str,
    new_doc_hash: &str,
) -> EpubMigrationInfo {
    let mut fingerprints = vec![epub_metadata_fingerprint()];
    for path in spine_paths {
        let fingerprint = epub_chapter_fingerprint(&units(path));
        if !fingerprints.contains(&fingerprint) {
            fingerprints.push(fingerprint);
        }
    }
    EpubMigrationInfo {
        input: MigrateInput {
            old_doc_hash: old_doc_hash.to_owned(),
            new_doc_hash: new_doc_hash.to_owned(),
            page_fingerprints: fingerprints,
            keep_block_keys: Some(block_keys.clone()),
        },
        block_keys,
    }
}
