//! What the EPUB editor reaches that is not in Rust yet.
//!
//! - [`EpubEngine`]: the libraries: `@seuoffice/epub-engine` (the book, its
//!   chapters, saving, the translated books), `@seuoffice/file-parse` (an
//!   attachment's text), `@seuoffice/drawio-model` (whether a `.drawio.png`
//!   holds its diagram) and `ResultStore` of `@seuoffice/pdf-structure/store`
//!   (the result store at `<userData>/pdf-store`, shared with the PDF editor).
//! - [`EpubShell`]: what the shell answered: `configureEpubRuntime`'s
//!   `isPathOpenInTab` and `migrateJobRecords`, `setEpubFileSavedHook`, the
//!   save-conflict probe, the open-files source of `unsaved-files` and
//!   `getUiLang()`.
//!
//! Every method takes and returns owned data, so it can run on a worker. The
//! book is the bytes it was opened from (`Bytes`): the engine opens them
//! again on each call, which keeps no engine object alive between calls.

// The shell's implementation builds these answers; until the crate exports
// the module (an open contract question) only the fakes do.
#![cfg_attr(not(any(test, feature = "probe")), allow(dead_code))]

use std::sync::Arc;

use main_core::epub::store_handlers::{StoreError, StoredTranslation};
use main_core::packages::electron_utils::unsaved_files::OpenFileState;
use main_core::packages::i18n::Lang;
use main_core::packages::pdf_structure::TranslationMode;
use serde_json::Value;
use shell_contract::ViewId;

/// The bytes a book was opened from or last saved as
pub type Bytes = Arc<Vec<u8>>;

/// The engine's `RangeReplacement`; offsets in UTF-16 code units, as in
/// JavaScript
#[derive(Clone, Debug, PartialEq)]
pub struct Replacement {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// One block of the engine's `OpenChapter.blocks`; ranges are `[start, end)`
/// in UTF-16 code units
#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    pub id: String,
    pub kind: String,
    pub tag: String,
    pub flowing: bool,
    pub outer: (usize, usize),
    pub inner: (usize, usize),
}

/// The engine's `ChapterMap`: a chapter's text and its blocks; a broken one
/// has no blocks and says why. What it leaves out (`doc`, each block's
/// `element`, `attributes`, `selfClosing`) is what parsing `source` gives at
/// the blocks' ranges, so the host parses again; `next_id` cannot be had so
/// and travels here.
#[derive(Clone, Debug, PartialEq)]
pub struct ChapterMap {
    pub source: String,
    pub broken: bool,
    pub error: Option<String>,
    pub blocks: Vec<Block>,
    /// `OpenChapter.nextId`: the number the next fresh block id (`b<n>`)
    /// takes. The session hands it back with the map on every call; it
    /// cannot be recovered from the blocks once the highest one is deleted.
    pub next_id: u64,
}

/// An opened book: `bookSummary(book)` (`EpubBookSummary`) and
/// `epubDocumentHash(bytes)`
#[derive(Clone, Debug, PartialEq)]
pub struct OpenedBook {
    pub summary: Value,
    pub doc_hash: String,
}

/// `book.readText(path)`: the entry's text, and whether it was valid in its
/// encoding
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedText {
    pub text: String,
    pub valid: bool,
}

/// `applyBlockEdits(map, edits)`
#[derive(Clone, Debug, PartialEq)]
pub enum BlockEdits {
    Applied {
        map: ChapterMap,
        replacements: Vec<Replacement>,
        created: Vec<String>,
    },
    /// `{ ok: false, refusal, index }`: `refusal` is the engine's `EditRefusal`
    Refused { refusal: Value, index: f64 },
}

/// `saveEpub(book, edits)`
#[derive(Clone, Debug, PartialEq)]
pub enum SavedBytes {
    /// `{ ok: true, changed: false }`
    Unchanged,
    /// `{ ok: true, changed: true, bytes }`
    Changed(Vec<u8>),
    Refused {
        reason: String,
        detail: String,
    },
}

/// The options of `buildTranslatedEpub`
#[derive(Clone, Debug, PartialEq)]
pub struct TranslatedRequest {
    /// `'translated' | 'bilingual'`
    pub kind: String,
    pub lang: String,
    pub chapters: Option<Vec<usize>>,
    /// the stored translation's blocks, the values of its `Map` in order
    pub results: Vec<Value>,
    /// `mode: 'easy'`
    pub easy: bool,
}

/// `buildTranslatedEpub(bytes, options)`
#[derive(Clone, Debug, PartialEq)]
pub enum Translated {
    Built {
        bytes: Vec<u8>,
        report: Value,
        identifier: String,
    },
    Refused {
        reason: String,
        detail: String,
    },
}

/// The libraries the EPUB editor calls that are not in Rust. `dir` of the
/// `store_*` methods is the app data folder: the store is
/// `new ResultStore(dir)`, whose folder is `<dir>/pdf-store`.
pub trait EpubEngine: Send + Sync {
    /// `openEpub(bytes)` (the zip gate), then `bookSummary(book)` and
    /// `epubDocumentHash(bytes)`; `Err` is the `EpubRefusalReason`
    fn open(&self, bytes: Bytes) -> Result<OpenedBook, String>;
    /// `book.readText(path)` of the book opened from `bytes`; `None` when it
    /// has no such entry
    fn read_text(&self, bytes: Bytes, path: &str) -> Option<DecodedText>;
    /// `openChapter(text)`
    fn open_chapter(&self, text: &str) -> ChapterMap;
    /// `applyBlockEdits(map, edits)`; `edits` are checked `BlockEdit`s
    /// (`blockEditOf`). `Err` is what it threw.
    fn apply_block_edits(&self, map: &ChapterMap, edits: &[Value]) -> Result<BlockEdits, String>;
    /// `composeReplacements(stored, earlier, later)`
    fn compose_replacements(
        &self,
        stored: &str,
        earlier: &[Replacement],
        later: &[Replacement],
    ) -> Vec<Replacement>;
    /// `validateReplacements(replacements, length)`: the problem, if any
    fn validate_replacements(&self, replacements: &[Replacement], length: usize) -> Option<String>;
    /// `applyReplacements(source, replacements)`
    fn apply_replacements(&self, source: &str, replacements: &[Replacement]) -> String;
    /// `remapChapter(map, text, replacements)`
    fn remap_chapter(
        &self,
        map: &ChapterMap,
        text: &str,
        replacements: &[Replacement],
    ) -> ChapterMap;
    /// `extractChapterText(source)`
    fn extract_chapter_text(&self, source: &str) -> String;
    /// `saveEpub(book, edits)` of the book opened from `bytes`, the edits per
    /// entry path in the order the session holds them. `Err` is what it threw.
    fn save(
        &self,
        bytes: Bytes,
        edits: &[(String, Vec<Replacement>)],
    ) -> Result<SavedBytes, String>;
    /// `epubMigrationInfo(savedBook, { oldDocHash, newDocHash })`
    fn migration_info(&self, saved: Bytes, old_doc_hash: &str, new_doc_hash: &str) -> Value;
    /// `epubTranslationUnits(book, { chapters })`: `{ units, skipped }`
    fn translation_units(&self, bytes: Bytes, chapters: Option<&[usize]>) -> Result<Value, String>;
    /// `buildTranslatedEpub(bytes, options)`
    fn build_translated(
        &self,
        bytes: Bytes,
        request: TranslatedRequest,
    ) -> Result<Translated, String>;

    /// `parseFileToText(path)` (file-parse): the text; `Err(Some(message))`
    /// when it failed with an error the reader may show (`!parsed.damaged &&
    /// parsed.error`), `Err(None)` for any other failure
    fn parse_file_to_text(&self, path: &str) -> Result<String, Option<String>>;
    /// The rest of `diagramPictureExtOf` (file-parse) once the name and the
    /// size said "maybe": `extractDiagramXml` of the file; `false` only when
    /// the picture holds no diagram (`no_original`)
    fn picture_holds_diagram(&self, path: &str) -> bool;

    /// `ResultStore.listTranslations(docHash, ...mode)`
    fn store_list_translations(
        &self,
        dir: &str,
        doc_hash: &str,
        mode: Option<TranslationMode>,
    ) -> Result<Vec<String>, StoreError>;
    /// `ResultStore.readTranslation(docHash, lang, ...mode)`
    fn store_read_translation(
        &self,
        dir: &str,
        doc_hash: &str,
        lang: &str,
        mode: Option<TranslationMode>,
    ) -> Result<Option<StoredTranslation>, StoreError>;
    /// `ResultStore.unfinishedJobs(docHash)`
    fn store_unfinished_jobs(&self, dir: &str, doc_hash: &str) -> Result<Vec<Value>, StoreError>;
    /// `ResultStore.writeTranslationMeta(docHash, lang, { provider, model }, ...mode)`
    fn store_write_translation_meta(
        &self,
        dir: &str,
        doc_hash: &str,
        lang: &str,
        provider: &str,
        model: &str,
        mode: Option<TranslationMode>,
    ) -> Result<(), StoreError>;
    /// `ResultStore.writeTranslationBlocks(docHash, lang, blocks, ...mode)`
    fn store_write_translation_blocks(
        &self,
        dir: &str,
        doc_hash: &str,
        lang: &str,
        blocks: &[Value],
        mode: Option<TranslationMode>,
    ) -> Result<(), StoreError>;
    /// `ResultStore.deleteTranslation(docHash, lang, ...mode)`
    fn store_delete_translation(
        &self,
        dir: &str,
        doc_hash: &str,
        lang: &str,
        mode: Option<TranslationMode>,
    ) -> Result<(), StoreError>;
    /// `ResultStore.deleteTranslationExceptEdited(docHash, lang, ...mode)`
    fn store_delete_translation_except_edited(
        &self,
        dir: &str,
        doc_hash: &str,
        lang: &str,
        mode: Option<TranslationMode>,
    ) -> Result<f64, StoreError>;
    /// `ResultStore.writeJob(docHash, job)`
    fn store_write_job(&self, dir: &str, doc_hash: &str, job: &Value) -> Result<(), StoreError>;
    /// `ResultStore.heartbeatJob(docHash, kind, key, ...mode)`
    fn store_heartbeat_job(
        &self,
        dir: &str,
        doc_hash: &str,
        kind: &str,
        key: Option<&str>,
        mode: Option<TranslationMode>,
    ) -> Result<bool, StoreError>;
    /// `ResultStore.migrateDocument(info)`: the `MigrateResult`
    fn store_migrate_document(&self, dir: &str, info: Value) -> Result<Value, StoreError>;
}

pub type EpubEngineHost = Arc<dyn EpubEngine>;

/// What the shell answers the EPUB editor
pub trait EpubShell: Send + Sync {
    /// `getUiLang()`
    fn ui_lang(&self) -> Lang;
    /// the save-conflict probe (`isPathOpenElsewhere`): `path` is open in
    /// another pane; no probe, or one that threw, is `false`
    fn open_elsewhere(&self, path: &str) -> bool;
    /// `runtime.isPathOpenInTab(path)`: a tab of any editor has the file
    /// open; `Ok(false)` when the shell gave none, `Err` with what it threw
    fn is_path_open_in_tab(&self, path: &str) -> Result<bool, String>;
    /// `runtime.migrateJobRecords(new ResultStore(dir), old, new)`: the job
    /// records moved; `Ok(0)` when the shell gave none
    fn migrate_job_records(
        &self,
        dir: &str,
        old_doc_hash: &str,
        new_doc_hash: &str,
    ) -> Result<f64, String>;
    /// `fileSavedHook(contents, path)`: a save landed on a new path
    fn file_saved(&self, view: ViewId, path: &str);
    /// the `unsaved-files` source (`setOpenFilesSource`): `None` when none is
    /// set, `Some(Err)` when it threw
    fn open_files(&self) -> Option<Result<Vec<OpenFileState>, ()>>;
    /// `randomBytes(16).toString('hex')`: a view's asset token, a flush
    /// request id
    fn random_token(&self) -> String;
    /// `Date.now()`: the time a reading position is stamped with, a pasted
    /// picture is named by, and old pasted pictures are judged against
    fn now(&self) -> f64;
}

pub type EpubShellHost = Arc<dyn EpubShell>;

#[cfg(any(test, feature = "probe"))]
pub(crate) use fake::{FakeEngine, FakeShell, Log};

#[cfg(any(test, feature = "probe"))]
mod fake {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// The case's host log (ipc-probe's `ProbeLog`)
    pub(crate) type Log = Arc<Mutex<Vec<Value>>>;

    use main_core::epub::store_handlers::{StoreError, StoredTranslation};
    use main_core::packages::electron_utils::unsaved_files::OpenFileState;
    use main_core::packages::i18n::Lang;
    use main_core::packages::pdf_structure::TranslationMode;
    use serde_json::{Value, json};
    use shell_contract::ViewId;

    use super::{
        BlockEdits, Bytes, ChapterMap, DecodedText, EpubEngine, EpubShell, OpenedBook, Replacement,
        SavedBytes, Translated, TranslatedRequest,
    };
    use crate::epub::session::{apply_replacements, diff_replacement, len16, slice16};

    /// `case[name]`: an array is a queue of answers, one per call (wrap a
    /// list answer in an array: `[["en"]]`), past its end the default;
    /// anything else answers every call
    struct Answers {
        case: Value,
        used: Mutex<HashMap<&'static str, usize>>,
    }

    impl Answers {
        fn new(case: &Value) -> Self {
            Answers {
                case: case.clone(),
                used: Mutex::default(),
            }
        }

        fn next(&self, name: &'static str) -> Option<Value> {
            match self.case.get(name)? {
                Value::Array(queue) => {
                    let mut used = self.used.lock().unwrap();
                    let i = used.entry(name).or_insert(0);
                    let answer = queue.get(*i).cloned();
                    *i += 1;
                    answer
                }
                other => Some(other.clone()),
            }
        }
    }

    fn text_of(v: &Value, key: &str) -> String {
        v.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
    }

    /// The engine's fake, answering from `hosts.d2.epub.engine`:
    ///
    /// - `open`: `{ summary?, docHash? }` or `{ refused: reason }`; by default
    ///   a book of one reflowable chapter `OEBPS/c1.xhtml`, its hash the
    ///   SHA-256 of the bytes
    /// - `readText`: an object by entry path, each a string or `{ text, valid }`
    ///   (`null`: no such entry); by default `<p>{path}</p>`
    /// - chapters: a chapter containing `<broken` is broken; any other is a
    ///   run of `<p>…</p>` blocks, `b1`, `b2`, … as `openChapter` numbers
    ///   them. `replace`, `insert_after` and `delete` edits apply (a new
    ///   block takes `b<nextId>`), any other is refused (`applyBlockEdits`:
    ///   `{ throw }` or `{ refusal, index }` overrides). `remapChapter`
    ///   keeps the id of a block whose start a replacement did not touch and
    ///   numbers the rest from `nextId`. Replacements apply and compose as
    ///   text does.
    /// - `save`: `"unchanged"`, `{ refused: { reason, detail } }`,
    ///   `{ throw }`; by default unchanged without edits, else the bytes with
    ///   every edit's text appended
    /// - `translationUnits`, `buildTranslated`: the answer, `{ throw }` or
    ///   (`buildTranslated`) `{ refused: { reason, detail } }`; by default no
    ///   units, a small built book
    /// - `parseFileToText`: a string, `{ error }` or `{ damaged: true }`; by
    ///   default the file read as UTF-8
    /// - `pictureHoldsDiagram`: by default `true`
    /// - store: `listTranslations`, `readTranslation`, `unfinishedJobs`,
    ///   `deleteTranslationExceptEdited`, `heartbeatJob`; by default empty,
    ///   writes succeed. Every write is logged as `ResultStore.<method>` with
    ///   its arguments, the mode last when it is `easy`.
    pub(crate) struct FakeEngine(Answers, Log);

    impl FakeEngine {
        pub(crate) fn new(case: &Value, log: Log) -> Self {
            FakeEngine(Answers::new(case), log)
        }

        fn store_line(&self, method: &str, mut args: Vec<Value>, mode: Option<TranslationMode>) {
            args.insert(0, json!(format!("ResultStore.{method}")));
            if let Some(mode) = mode {
                args.push(json!(mode.as_str()));
            }
            self.1.lock().unwrap().push(Value::Array(args));
        }
    }

    fn default_summary() -> Value {
        json!({
            "opfPath": "OEBPS/content.opf",
            "version": "3",
            "metadata": {},
            "manifest": [],
            "spine": [{
                "index": 0, "idref": "c1", "path": "OEBPS/c1.xhtml",
                "mediaType": "application/xhtml+xml", "linear": true, "properties": [],
                "layout": null, "fixedLayout": false
            }],
            "pageProgressionDirection": null,
            "toc": { "source": "spine", "entries": [] },
            "fixedLayout": false,
            "verticalWriting": false
        })
    }

    /// the `<p>…</p>` runs of a chapter: outer and inner ranges in UTF-16 units
    fn paragraphs(text: &str) -> Vec<((usize, usize), (usize, usize))> {
        let at16 = |i: usize| len16(&text[..i]);
        let mut out = Vec::new();
        let mut at = 0;
        while let Some(open) = text[at..].find("<p>") {
            let start = at + open;
            let Some(close) = text[start..].find("</p>") else {
                break;
            };
            let end = start + close;
            out.push(((at16(start), at16(end + 4)), (at16(start + 3), at16(end))));
            at = end + 4;
        }
        out
    }

    fn broken(text: &str, next_id: u64) -> ChapterMap {
        ChapterMap {
            source: text.to_owned(),
            broken: true,
            error: Some("not well-formed".into()),
            blocks: Vec::new(),
            next_id,
        }
    }

    /// the map of `text` whose blocks take the ids `id` gives, in order
    fn numbered(text: &str, mut id: impl FnMut(usize) -> String, next_id: u64) -> ChapterMap {
        let blocks = paragraphs(text)
            .into_iter()
            .map(|(outer, inner)| super::Block {
                id: id(outer.0),
                kind: "paragraph".into(),
                tag: "p".into(),
                flowing: true,
                outer,
                inner,
            })
            .collect();
        ChapterMap {
            source: text.to_owned(),
            broken: false,
            error: None,
            blocks,
            next_id,
        }
    }

    /// `openChapter(text)`
    fn chapter(text: &str) -> ChapterMap {
        if text.contains("<broken") {
            return broken(text, 1);
        }
        let count = paragraphs(text).len() as u64;
        let mut n = 0;
        numbered(
            text,
            |_| {
                n += 1;
                format!("b{n}")
            },
            count + 1,
        )
    }

    /// where `offset` lands after `replacements`; `None` inside a replaced range
    fn map_offset(offset: usize, replacements: &[Replacement]) -> Option<usize> {
        let mut delta: i64 = 0;
        for r in replacements {
            if offset < r.start {
                break;
            }
            if offset < r.end {
                return None;
            }
            delta += len16(&r.text) as i64 - (r.end - r.start) as i64;
        }
        Some((offset as i64 + delta) as usize)
    }

    fn thrown(v: &Value) -> Option<String> {
        v.get("throw").and_then(Value::as_str).map(str::to_owned)
    }

    impl EpubEngine for FakeEngine {
        fn open(&self, bytes: Bytes) -> Result<OpenedBook, String> {
            let answer = self.0.next("open").unwrap_or(Value::Null);
            if let Some(reason) = answer.get("refused").and_then(Value::as_str) {
                return Err(reason.to_owned());
            }
            Ok(OpenedBook {
                summary: answer
                    .get("summary")
                    .cloned()
                    .unwrap_or_else(default_summary),
                doc_hash: answer.get("docHash").and_then(Value::as_str).map_or_else(
                    || main_core::markdown::fs_util::sha256_hex(&bytes),
                    str::to_owned,
                ),
            })
        }

        fn read_text(&self, _bytes: Bytes, path: &str) -> Option<DecodedText> {
            let known = self
                .0
                .case
                .get("readText")
                .and_then(|texts| texts.get(path));
            match known {
                None => Some(DecodedText {
                    text: format!("<p>{path}</p>"),
                    valid: true,
                }),
                Some(Value::Null) => None,
                Some(Value::String(text)) => Some(DecodedText {
                    text: text.clone(),
                    valid: true,
                }),
                Some(other) => Some(DecodedText {
                    text: text_of(other, "text"),
                    valid: other.get("valid").and_then(Value::as_bool).unwrap_or(true),
                }),
            }
        }

        fn open_chapter(&self, text: &str) -> ChapterMap {
            chapter(text)
        }

        fn apply_block_edits(
            &self,
            map: &ChapterMap,
            edits: &[Value],
        ) -> Result<BlockEdits, String> {
            if let Some(answer) = self.0.next("applyBlockEdits") {
                if let Some(message) = thrown(&answer) {
                    return Err(message);
                }
                return Ok(BlockEdits::Refused {
                    refusal: answer.get("refusal").cloned().unwrap_or(Value::Null),
                    index: answer.get("index").and_then(Value::as_f64).unwrap_or(0.0),
                });
            }
            let units: Vec<u16> = map.source.encode_utf16().collect();
            let mut items: Vec<(String, String)> = map
                .blocks
                .iter()
                .map(|b| (b.id.clone(), slice16(&units, b.inner.0, b.inner.1)))
                .collect();
            let mut next_id = map.next_id;
            let mut created = Vec::new();
            for (i, edit) in edits.iter().enumerate() {
                let at = items.iter().position(|(id, _)| {
                    Some(id.as_str()) == edit.get("blockId").and_then(Value::as_str)
                });
                let refused = || BlockEdits::Refused {
                    refusal: json!({ "code": "unsupported", "message": "the fake cannot apply this edit" }),
                    index: i as f64,
                };
                let Some(at) = at else { return Ok(refused()) };
                match edit.get("op").and_then(Value::as_str) {
                    Some("replace") => items[at].1 = text_of(edit, "text"),
                    Some("insert_after") => {
                        let id = format!("b{next_id}");
                        next_id += 1;
                        created.push(id.clone());
                        items.insert(at + 1, (id, text_of(edit, "text")));
                    }
                    Some("delete") => {
                        items.remove(at);
                    }
                    _ => return Ok(refused()),
                }
            }
            let text: String = items.iter().map(|(_, t)| format!("<p>{t}</p>")).collect();
            let mut ids = items.into_iter().map(|(id, _)| id);
            let replacements = if text == map.source {
                Vec::new()
            } else {
                vec![diff_replacement(&map.source, &text)]
            };
            Ok(BlockEdits::Applied {
                map: numbered(&text, |_| ids.next().unwrap_or_default(), next_id),
                replacements,
                created,
            })
        }

        fn compose_replacements(
            &self,
            stored: &str,
            earlier: &[Replacement],
            later: &[Replacement],
        ) -> Vec<Replacement> {
            let current = apply_replacements(&apply_replacements(stored, earlier), later);
            if current == stored {
                return Vec::new();
            }
            vec![diff_replacement(stored, &current)]
        }

        fn validate_replacements(
            &self,
            replacements: &[Replacement],
            length: usize,
        ) -> Option<String> {
            let mut at = 0;
            for r in replacements {
                if r.start < at || r.end < r.start || r.end > length {
                    return Some("replacements overlap or leave the text".into());
                }
                at = r.end;
            }
            None
        }

        fn apply_replacements(&self, source: &str, replacements: &[Replacement]) -> String {
            apply_replacements(source, replacements)
        }

        fn remap_chapter(&self, map: &ChapterMap, text: &str, r: &[Replacement]) -> ChapterMap {
            if text.contains("<broken") {
                return broken(text, map.next_id);
            }
            let mut carried: HashMap<usize, String> = map
                .blocks
                .iter()
                .filter_map(|b| map_offset(b.outer.0, r).map(|at| (at, b.id.clone())))
                .collect();
            let mut next_id = map.next_id;
            let mut remapped = numbered(
                text,
                |start| {
                    carried.remove(&start).unwrap_or_else(|| {
                        next_id += 1;
                        format!("b{}", next_id - 1)
                    })
                },
                0,
            );
            remapped.next_id = next_id;
            remapped
        }

        fn extract_chapter_text(&self, source: &str) -> String {
            let mut out = String::new();
            let mut in_tag = false;
            for c in source.chars() {
                match c {
                    '<' => in_tag = true,
                    '>' => in_tag = false,
                    c if !in_tag => out.push(c),
                    _ => {}
                }
            }
            out
        }

        fn save(
            &self,
            bytes: Bytes,
            edits: &[(String, Vec<Replacement>)],
        ) -> Result<SavedBytes, String> {
            match self.0.next("save") {
                Some(Value::String(s)) if s == "unchanged" => return Ok(SavedBytes::Unchanged),
                Some(answer) => {
                    if let Some(message) = thrown(&answer) {
                        return Err(message);
                    }
                    if let Some(refused) = answer.get("refused") {
                        return Ok(SavedBytes::Refused {
                            reason: text_of(refused, "reason"),
                            detail: text_of(refused, "detail"),
                        });
                    }
                }
                None => {}
            }
            if edits.is_empty() {
                return Ok(SavedBytes::Unchanged);
            }
            let mut out = bytes.as_ref().clone();
            for (_, replacements) in edits {
                for r in replacements {
                    out.extend_from_slice(r.text.as_bytes());
                }
            }
            Ok(SavedBytes::Changed(out))
        }

        fn migration_info(&self, _saved: Bytes, old: &str, new: &str) -> Value {
            json!({ "oldDocHash": old, "newDocHash": new })
        }

        fn translation_units(
            &self,
            _bytes: Bytes,
            chapters: Option<&[usize]>,
        ) -> Result<Value, String> {
            self.1
                .lock()
                .unwrap()
                .push(json!(["epubTranslationUnits", chapters]));
            match self.0.next("translationUnits") {
                Some(answer) => thrown(&answer).map_or(Ok(answer), Err),
                None => Ok(json!({ "units": [], "skipped": [] })),
            }
        }

        fn build_translated(
            &self,
            _bytes: Bytes,
            request: TranslatedRequest,
        ) -> Result<Translated, String> {
            self.1.lock().unwrap().push(json!([
                "buildTranslatedEpub",
                request.kind,
                request.lang,
                request.chapters,
                request.results,
                request.easy.then_some("easy"),
            ]));
            if let Some(answer) = self.0.next("buildTranslated") {
                if let Some(message) = thrown(&answer) {
                    return Err(message);
                }
                if let Some(refused) = answer.get("refused") {
                    return Ok(Translated::Refused {
                        reason: text_of(refused, "reason"),
                        detail: text_of(refused, "detail"),
                    });
                }
            }
            Ok(Translated::Built {
                bytes: format!(
                    "{} {} {} blocks{}",
                    request.kind,
                    request.lang,
                    request.results.len(),
                    if request.easy { " easy" } else { "" }
                )
                .into_bytes(),
                report: json!({ "chapters": request.chapters.map_or(0, |c| c.len()) }),
                identifier: "urn:uuid:fake".into(),
            })
        }

        fn parse_file_to_text(&self, path: &str) -> Result<String, Option<String>> {
            self.1
                .lock()
                .unwrap()
                .push(json!(["parseFileToText", path]));
            match self.0.next("parseFileToText") {
                Some(Value::String(text)) => Ok(text),
                // `!parsed.damaged && parsed.error`: a damaged file's error is not shown
                Some(answer) => Err(answer
                    .get("error")
                    .and_then(Value::as_str)
                    .filter(|_| answer.get("damaged") != Some(&Value::Bool(true)))
                    .map(str::to_owned)),
                None => std::fs::read(path)
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .map_err(|e| Some(e.to_string())),
            }
        }

        fn picture_holds_diagram(&self, _path: &str) -> bool {
            self.0
                .next("pictureHoldsDiagram")
                .and_then(|v| v.as_bool())
                .unwrap_or(true)
        }

        fn store_list_translations(
            &self,
            _dir: &str,
            doc_hash: &str,
            mode: Option<TranslationMode>,
        ) -> Result<Vec<String>, StoreError> {
            self.store_line("listTranslations", vec![json!(doc_hash)], mode);
            Ok(self
                .0
                .next("listTranslations")
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect())
        }

        fn store_read_translation(
            &self,
            _dir: &str,
            doc_hash: &str,
            lang: &str,
            mode: Option<TranslationMode>,
        ) -> Result<Option<StoredTranslation>, StoreError> {
            self.store_line("readTranslation", vec![json!(doc_hash), json!(lang)], mode);
            Ok(self
                .0
                .next("readTranslation")
                .filter(|v| !v.is_null())
                .map(|v| StoredTranslation {
                    lang: lang.to_owned(),
                    provider: v.get("provider").and_then(Value::as_str).map(str::to_owned),
                    model: v.get("model").and_then(Value::as_str).map(str::to_owned),
                    blocks: v
                        .get("blocks")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                }))
        }

        fn store_unfinished_jobs(
            &self,
            _dir: &str,
            doc_hash: &str,
        ) -> Result<Vec<Value>, StoreError> {
            self.store_line("unfinishedJobs", vec![json!(doc_hash)], None);
            Ok(self
                .0
                .next("unfinishedJobs")
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default())
        }

        fn store_write_translation_meta(
            &self,
            _dir: &str,
            doc_hash: &str,
            lang: &str,
            provider: &str,
            model: &str,
            mode: Option<TranslationMode>,
        ) -> Result<(), StoreError> {
            let meta = json!({ "provider": provider, "model": model });
            self.store_line(
                "writeTranslationMeta",
                vec![json!(doc_hash), json!(lang), meta],
                mode,
            );
            Ok(())
        }

        fn store_write_translation_blocks(
            &self,
            _dir: &str,
            doc_hash: &str,
            lang: &str,
            blocks: &[Value],
            mode: Option<TranslationMode>,
        ) -> Result<(), StoreError> {
            self.store_line(
                "writeTranslationBlocks",
                vec![json!(doc_hash), json!(lang), json!(blocks)],
                mode,
            );
            Ok(())
        }

        fn store_delete_translation(
            &self,
            _dir: &str,
            doc_hash: &str,
            lang: &str,
            mode: Option<TranslationMode>,
        ) -> Result<(), StoreError> {
            self.store_line(
                "deleteTranslation",
                vec![json!(doc_hash), json!(lang)],
                mode,
            );
            Ok(())
        }

        fn store_delete_translation_except_edited(
            &self,
            _dir: &str,
            doc_hash: &str,
            lang: &str,
            mode: Option<TranslationMode>,
        ) -> Result<f64, StoreError> {
            self.store_line(
                "deleteTranslationExceptEdited",
                vec![json!(doc_hash), json!(lang)],
                mode,
            );
            Ok(self
                .0
                .next("deleteTranslationExceptEdited")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0))
        }

        fn store_write_job(
            &self,
            _dir: &str,
            doc_hash: &str,
            job: &Value,
        ) -> Result<(), StoreError> {
            self.store_line("writeJob", vec![json!(doc_hash), job.clone()], None);
            Ok(())
        }

        fn store_heartbeat_job(
            &self,
            _dir: &str,
            doc_hash: &str,
            kind: &str,
            key: Option<&str>,
            mode: Option<TranslationMode>,
        ) -> Result<bool, StoreError> {
            self.store_line(
                "heartbeatJob",
                vec![json!(doc_hash), json!(kind), json!(key)],
                mode,
            );
            Ok(self
                .0
                .next("heartbeatJob")
                .and_then(|v| v.as_bool())
                .unwrap_or(true))
        }

        fn store_migrate_document(&self, _dir: &str, info: Value) -> Result<Value, StoreError> {
            self.store_line("migrateDocument", vec![info], None);
            Ok(Value::Null)
        }
    }

    /// The shell's fake, answering from `hosts.d2.epub.shell`: `uiLang`
    /// (`"en"` by default), `openElsewhere` (a boolean, `false`),
    /// `openInTab` (the paths a tab has open, or `"throws"`), `openFiles`
    /// (`[{ filePath, dirty }]` or `"throws"`; absent: no source). Tokens
    /// are 1, 2, ... as 32 hex digits. `fileSavedHook` and
    /// `migrateJobRecords` are logged.
    pub(crate) struct FakeShell {
        case: Value,
        log: Log,
        tokens: Mutex<u64>,
    }

    impl FakeShell {
        pub(crate) fn new(case: &Value, log: Log) -> Self {
            FakeShell {
                case: case.clone(),
                log,
                tokens: Mutex::default(),
            }
        }
    }

    impl EpubShell for FakeShell {
        fn ui_lang(&self) -> Lang {
            match self.case.get("uiLang").and_then(Value::as_str) {
                Some("ko") => Lang::Ko,
                _ => Lang::En,
            }
        }

        fn open_elsewhere(&self, _path: &str) -> bool {
            self.case
                .get("openElsewhere")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        }

        fn is_path_open_in_tab(&self, path: &str) -> Result<bool, String> {
            match self.case.get("openInTab") {
                Some(Value::String(s)) if s == "throws" => Err("the probe threw".into()),
                Some(Value::Array(paths)) => Ok(paths.iter().any(|p| p.as_str() == Some(path))),
                _ => Ok(false),
            }
        }

        fn migrate_job_records(&self, _dir: &str, old: &str, new: &str) -> Result<f64, String> {
            self.log
                .lock()
                .unwrap()
                .push(json!(["migrateJobRecords", old, new]));
            Ok(0.0)
        }

        fn file_saved(&self, view: ViewId, path: &str) {
            self.log
                .lock()
                .unwrap()
                .push(json!(["fileSavedHook", view.0, path]));
        }

        fn open_files(&self) -> Option<Result<Vec<OpenFileState>, ()>> {
            match self.case.get("openFiles")? {
                Value::Array(files) => Some(Ok(files
                    .iter()
                    .map(|f| OpenFileState {
                        file_path: f.get("filePath").and_then(Value::as_str).map(str::to_owned),
                        dirty: f.get("dirty").and_then(Value::as_bool).unwrap_or(false),
                    })
                    .collect())),
                _ => Some(Err(())),
            }
        }

        /// `now` of the case, 2024-01-01T00:00:00Z by default
        fn now(&self) -> f64 {
            self.case
                .get("now")
                .and_then(Value::as_f64)
                .unwrap_or(1_704_067_200_000.0)
        }

        fn random_token(&self) -> String {
            let mut n = self.tokens.lock().unwrap();
            *n += 1;
            format!("{:032x}", *n)
        }
    }
}
