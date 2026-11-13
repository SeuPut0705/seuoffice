//! `apps/epub/src/main/book-session.ts`: one open book, without the engine.
//!
//! The session holds the book's bytes, its summary, and for every chapter
//! read so far its stored text, its current text with the block map and the
//! range replacements between the two. The engine calls go to
//! [`EpubEngine`]; the checks, the refusals, the versions and the answers
//! the renderer gets stay here. Reading a chapter the first time is the
//! caller's (it runs on a worker): [`load_chapter`] makes its state and
//! [`Session::insert_chapter`] keeps the first one that arrived.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};
use shell_contract::IpcValue;

use super::hosts::{BlockEdits, Bytes, ChapterMap, EpubEngine, OpenedBook, Replacement};
use crate::kit::{IntoIpc, as_num, as_str, field, from_json};

/// A JavaScript string's `length`
pub(super) fn len16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(start, end)` in UTF-16 code units (clamped as `slice` is)
pub(super) fn slice16(text: &[u16], start: usize, end: usize) -> String {
    let end = end.min(text.len());
    let start = start.min(end);
    String::from_utf16_lossy(&text[start..end])
}

/// The engine's `applyReplacements`, for the fakes: the replacements in
/// order of their start, each against the original text
#[cfg(any(test, feature = "probe"))]
pub(super) fn apply_replacements(source: &str, replacements: &[Replacement]) -> String {
    let text: Vec<u16> = source.encode_utf16().collect();
    let mut sorted: Vec<&Replacement> = replacements.iter().collect();
    sorted.sort_by_key(|r| (r.start, r.end));
    let mut out = String::new();
    let mut at = 0;
    for r in sorted {
        out.push_str(&slice16(&text, at, r.start));
        out.push_str(&r.text);
        at = r.end.max(at);
    }
    out.push_str(&slice16(&text, at, text.len()));
    out
}

/// `Number.isSafeInteger(v)`
pub(super) fn safe_integer(v: &IpcValue) -> Option<f64> {
    as_num(v).filter(|n| n.is_finite() && n.trunc() == *n && n.abs() <= 9_007_199_254_740_991.0)
}

/// `isOffset(v)`: a safe integer, not negative
fn offset(v: &IpcValue) -> Option<usize> {
    safe_integer(v).filter(|n| *n >= 0.0).map(|n| n as usize)
}

/// `{ ok: false, error, message? }`
pub(super) fn failure(error: &str, message: Option<&str>) -> IpcValue {
    let mut out = vec![
        ("ok".to_owned(), false.into_ipc()),
        ("error".to_owned(), error.into_ipc()),
    ];
    if let Some(message) = message {
        out.push(("message".to_owned(), message.into_ipc()));
    }
    IpcValue::Object(out)
}

pub(super) fn object(entries: Vec<(&str, IpcValue)>) -> IpcValue {
    IpcValue::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    )
}

fn number(n: usize) -> IpcValue {
    IpcValue::Number(n as f64)
}

fn replacement_ipc(r: &Replacement) -> IpcValue {
    object(vec![
        ("start", number(r.start)),
        ("end", number(r.end)),
        ("text", r.text.as_str().into_ipc()),
    ])
}

fn replacements_ipc(rs: &[Replacement]) -> IpcValue {
    IpcValue::Array(rs.iter().map(replacement_ipc).collect())
}

const BLOCK_EDIT_OPS: [&str; 7] = [
    "replace",
    "insert_after",
    "delete",
    "split",
    "merge",
    "line_break",
    "toggle_mark",
];

/// `blockEditOf(v)`: a block edit as it came over IPC, checked field by
/// field, as the engine's `BlockEdit`
pub(super) fn block_edit_of(v: &IpcValue) -> Option<Value> {
    if !matches!(v, IpcValue::Object(_)) {
        return None;
    }
    let op = as_str(field(v, "op")).filter(|op| BLOCK_EDIT_OPS.contains(op))?;
    let block_id = as_str(field(v, "blockId")).filter(|id| (1..=64).contains(&len16(id)))?;
    let mut out = Map::new();
    out.insert("op".into(), op.into());
    out.insert("blockId".into(), block_id.into());
    match op {
        "replace" => {
            out.insert("text".into(), as_str(field(v, "text"))?.into());
            match field(v, "dropRuby") {
                IpcValue::Undefined => {}
                IpcValue::Bool(b) => {
                    out.insert("dropRuby".into(), (*b).into());
                }
                _ => return None,
            }
        }
        "insert_after" => {
            out.insert("text".into(), as_str(field(v, "text"))?.into());
        }
        "delete" => {}
        "split" | "line_break" => {
            out.insert("offset".into(), offset(field(v, "offset"))?.into());
        }
        "merge" => {
            let with = as_str(field(v, "with")).filter(|w| *w == "previous" || *w == "next")?;
            out.insert("with".into(), with.into());
        }
        _ => {
            let mark = as_str(field(v, "mark")).filter(|m| *m == "bold" || *m == "italic")?;
            let start = offset(field(v, "start"))?;
            let end = offset(field(v, "end")).filter(|end| *end >= start)?;
            out.insert("mark".into(), mark.into());
            out.insert("start".into(), start.into());
            out.insert("end".into(), end.into());
        }
    }
    Some(Value::Object(out))
}

/// `replacementsOf(v)`
pub(super) fn replacements_of(v: &IpcValue) -> Option<Vec<Replacement>> {
    let IpcValue::Array(items) = v else {
        return None;
    };
    items
        .iter()
        .map(|r| {
            if !matches!(r, IpcValue::Object(_)) {
                return None;
            }
            Some(Replacement {
                start: offset(field(r, "start"))?,
                end: offset(field(r, "end"))?,
                text: as_str(field(r, "text"))?.to_owned(),
            })
        })
        .collect()
}

/// `invertReplacements(before, replacements)`
pub(super) fn invert_replacements(before: &str, replacements: &[Replacement]) -> Vec<Replacement> {
    let text: Vec<u16> = before.encode_utf16().collect();
    let mut sorted: Vec<&Replacement> = replacements.iter().collect();
    sorted.sort_by_key(|r| (r.start, r.end));
    let mut delta: i64 = 0;
    sorted
        .into_iter()
        .map(|r| {
            let start = (r.start as i64 + delta).max(0) as usize;
            let inserted = len16(&r.text);
            delta += inserted as i64 - (r.end as i64 - r.start as i64);
            Replacement {
                start,
                end: start + inserted,
                text: slice16(&text, r.start, r.end),
            }
        })
        .collect()
}

/// `diffReplacement(from, to)`
pub(super) fn diff_replacement(from: &str, to: &str) -> Replacement {
    let a: Vec<u16> = from.encode_utf16().collect();
    let b: Vec<u16> = to.encode_utf16().collect();
    let max = a.len().min(b.len());
    let mut head = 0;
    while head < max && a[head] == b[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < max - head && a[a.len() - 1 - tail] == b[b.len() - 1 - tail] {
        tail += 1;
    }
    Replacement {
        start: head,
        end: a.len() - tail,
        text: slice16(&b, head, b.len() - tail),
    }
}

/// `textDigest(text)`: the key a chapter text is remembered by
fn digest(text: &str) -> String {
    main_core::markdown::fs_util::sha256_hex(text.as_bytes())
}

fn block_info(map: &ChapterMap) -> IpcValue {
    IpcValue::Array(
        map.blocks
            .iter()
            .map(|b| {
                let span = |(start, end): (usize, usize)| {
                    object(vec![("start", number(start)), ("end", number(end))])
                };
                object(vec![
                    ("id", b.id.as_str().into_ipc()),
                    ("kind", b.kind.as_str().into_ipc()),
                    ("tag", b.tag.as_str().into_ipc()),
                    ("flowing", b.flowing.into_ipc()),
                    ("outer", span(b.outer)),
                    ("inner", span(b.inner)),
                ])
            })
            .collect(),
    )
}

/// `ChapterState`
pub(super) struct ChapterState {
    pub path: String,
    /// the text as stored in the session's bytes
    pub stored: String,
    /// the current text with the block map; a broken chapter never changes
    pub map: ChapterMap,
    /// current = applyReplacements(stored, replacements)
    pub replacements: Vec<Replacement>,
    /// false when the entry is not valid in its encoding
    pub valid: bool,
    pub version: u64,
    /// digests of every text the chapter has had in this session
    seen: HashSet<String>,
}

/// `state(path)` before it is kept: the chapter read from the book. Runs on
/// a worker.
pub(super) fn load_chapter(engine: &dyn EpubEngine, bytes: Bytes, path: String) -> ChapterState {
    let decoded = engine.read_text(bytes, &path);
    let (stored, valid) = decoded.map_or((String::new(), false), |d| (d.text, d.valid));
    ChapterState {
        map: engine.open_chapter(&stored),
        seen: HashSet::from([digest(&stored)]),
        path,
        stored,
        replacements: Vec::new(),
        valid,
        version: 0,
    }
}

/// One spine item as the session reads it from the summary
pub(super) struct SpineItem {
    pub index: f64,
    pub path: String,
    pub fixed_layout: bool,
}

/// `EpubBookSession`
pub(super) struct Session {
    pub bytes: Bytes,
    pub summary: Value,
    pub spine: Vec<SpineItem>,
    pub fixed_layout: bool,
    pub doc_hash: String,
    pub locked: bool,
    /// in the order the chapters were first read, as the TypeScript's Map
    chapters: Vec<ChapterState>,
}

fn spine_of(summary: &Value) -> Vec<SpineItem> {
    summary
        .get("spine")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|i| SpineItem {
                    index: i.get("index").and_then(Value::as_f64).unwrap_or(0.0),
                    path: i
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    fixed_layout: i.get("fixedLayout").and_then(Value::as_bool) == Some(true),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The refusals of an edit made before the chapter is read
pub(super) struct EditTarget {
    pub index: f64,
    pub path: String,
}

impl Session {
    pub fn new(bytes: Bytes, opened: OpenedBook) -> Self {
        Session {
            spine: spine_of(&opened.summary),
            fixed_layout: opened.summary.get("fixedLayout").and_then(Value::as_bool) == Some(true),
            summary: opened.summary,
            doc_hash: opened.doc_hash,
            bytes,
            locked: false,
            chapters: Vec::new(),
        }
    }

    pub fn summary_ipc(&self) -> IpcValue {
        from_json(&self.summary)
    }

    /// `bookReadOnly()`
    pub fn book_read_only(&self) -> Option<&'static str> {
        self.fixed_layout.then_some("fixed-layout-book")
    }

    pub fn chapter_index(&self, path: &str) -> Option<usize> {
        self.chapters.iter().position(|c| c.path == path)
    }

    /// keeps a chapter read on a worker, unless a second read finished first
    pub fn insert_chapter(&mut self, state: ChapterState) -> usize {
        if let Some(i) = self.chapter_index(&state.path) {
            return i;
        }
        self.chapters.push(state);
        self.chapters.len() - 1
    }

    /// `spineItem(spineIndex)`
    pub fn spine_item(&self, spine_index: &IpcValue) -> Option<&SpineItem> {
        let i = safe_integer(spine_index)?;
        if i < 0.0 {
            return None;
        }
        self.spine.get(i as usize)
    }

    /// the chapter paths in spine order, each once (`readText`)
    pub fn text_paths(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        self.spine
            .iter()
            .filter(|i| seen.insert(i.path.clone()))
            .map(|i| i.path.clone())
            .collect()
    }

    fn read_only_of(&self, state: &ChapterState) -> Option<&'static str> {
        if self.fixed_layout {
            return Some("fixed-layout-book");
        }
        // a chapter listed twice is read only when either listing is fixed layout
        if self
            .spine
            .iter()
            .any(|i| i.path == state.path && i.fixed_layout)
        {
            return Some("fixed-layout-chapter");
        }
        if state.map.broken || !state.valid {
            return Some("broken-chapter");
        }
        None
    }

    /// `readChapter` once the chapter is read
    pub fn chapter_result(&self, index: f64, i: usize) -> IpcValue {
        let state = &self.chapters[i];
        let mut out = vec![
            ("ok", true.into_ipc()),
            ("spineIndex", IpcValue::Number(index)),
            ("path", state.path.as_str().into_ipc()),
            ("source", state.map.source.as_str().into_ipc()),
            ("version", IpcValue::Number(state.version as f64)),
        ];
        if state.map.broken {
            out.push(("broken", true.into_ipc()));
            out.push((
                "error",
                state
                    .map
                    .error
                    .clone()
                    .map_or(IpcValue::Undefined, IntoIpc::into_ipc),
            ));
            out.push(("readOnly", "broken-chapter".into_ipc()));
        } else if !state.valid {
            out.push(("broken", true.into_ipc()));
            out.push(("error", "not valid in its encoding".into_ipc()));
            out.push(("readOnly", "broken-chapter".into_ipc()));
        } else {
            out.push(("broken", false.into_ipc()));
            out.push(("blocks", block_info(&state.map)));
            out.push(("readOnly", self.read_only_of(state).into_ipc()));
        }
        object(out)
    }

    /// `editable(spineIndex)` up to reading the chapter: no such chapter, or
    /// the tab's book translation runs
    pub fn edit_target(&self, spine_index: &IpcValue) -> Result<EditTarget, IpcValue> {
        let Some(item) = self.spine_item(spine_index) else {
            return Err(failure("invalid-request", Some("no such chapter")));
        };
        if self.locked {
            return Err(failure(
                "locked",
                Some("the book translation of this tab runs"),
            ));
        }
        Ok(EditTarget {
            index: item.index,
            path: item.path.clone(),
        })
    }

    /// `editable(spineIndex)` once the chapter is read: a read-only chapter
    fn read_only_refusal(&self, i: usize) -> Option<IpcValue> {
        let state = &self.chapters[i];
        let read_only = self.read_only_of(state);
        if read_only.is_none() && !state.map.broken {
            return None;
        }
        let reason = read_only.unwrap_or("broken-chapter");
        Some(object(vec![
            ("ok", false.into_ipc()),
            ("error", "read-only".into_ipc()),
            ("readOnly", reason.into_ipc()),
            (
                "message",
                format!("the chapter is read only ({reason})").into_ipc(),
            ),
        ]))
    }

    /// `commitEdit(state, index, next, replacements, created)`
    fn commit_edit(
        &mut self,
        engine: &dyn EpubEngine,
        i: usize,
        index: f64,
        next: ChapterMap,
        replacements: Vec<Replacement>,
        created: Vec<String>,
    ) -> IpcValue {
        let state = &mut self.chapters[i];
        let before = state.map.source.clone();
        let blocks = block_info(&next);
        if !replacements.is_empty() {
            state.replacements =
                engine.compose_replacements(&state.stored, &state.replacements, &replacements);
            state.seen.insert(digest(&next.source));
            state.map = next;
            state.version += 1;
        }
        let state = &self.chapters[i];
        let answer = vec![
            ("ok", true.into_ipc()),
            ("spineIndex", IpcValue::Number(index)),
            ("path", state.path.as_str().into_ipc()),
            ("source", state.map.source.as_str().into_ipc()),
            ("version", IpcValue::Number(state.version as f64)),
            ("blocks", blocks),
            ("created", created.into_ipc()),
            ("replacements", replacements_ipc(&replacements)),
            (
                "inverse",
                replacements_ipc(&invert_replacements(&before, &replacements)),
            ),
            ("dirty", self.is_dirty().into_ipc()),
        ];
        object(answer)
    }

    /// `applyEdits(spineIndex, edits)` once the edits were checked and the
    /// chapter is read
    pub fn apply_edits(
        &mut self,
        engine: &dyn EpubEngine,
        i: usize,
        index: f64,
        edits: &[Value],
    ) -> IpcValue {
        if let Some(refusal) = self.read_only_refusal(i) {
            return refusal;
        }
        match engine.apply_block_edits(&self.chapters[i].map, edits) {
            Err(message) => failure("invalid-request", Some(&message)),
            Ok(BlockEdits::Refused { refusal, index }) => {
                let message = refusal
                    .get("message")
                    .map_or(IpcValue::Undefined, from_json);
                object(vec![
                    ("ok", false.into_ipc()),
                    ("error", "refused".into_ipc()),
                    ("refusal", from_json(&refusal)),
                    ("index", IpcValue::Number(index)),
                    ("message", message),
                ])
            }
            Ok(BlockEdits::Applied {
                map,
                replacements,
                created,
            }) => self.commit_edit(engine, i, index, map, replacements, created),
        }
    }

    /// `replaceRanges(spineIndex, version, replacements)` once the request was
    /// checked and the chapter is read
    pub fn replace_ranges(
        &mut self,
        engine: &dyn EpubEngine,
        i: usize,
        index: f64,
        version: f64,
        replacements: Vec<Replacement>,
    ) -> IpcValue {
        if let Some(refusal) = self.read_only_refusal(i) {
            return refusal;
        }
        let state = &self.chapters[i];
        if version != state.version as f64 {
            return failure(
                "stale",
                Some(&format!("the chapter is at version {}", state.version)),
            );
        }
        let source = &state.map.source;
        if let Some(problem) = engine.validate_replacements(&replacements, len16(source)) {
            return failure("invalid-request", Some(&problem));
        }
        let text = engine.apply_replacements(source, &replacements);
        if text == *source {
            let map = state.map.clone();
            return self.commit_edit(engine, i, index, map, Vec::new(), Vec::new());
        }
        // The page edits text inside blocks only; anything else must be a way
        // back (undo, redo, rollback) to a text this chapter has had.
        let inside = replacements.iter().all(|r| {
            state
                .map
                .blocks
                .iter()
                .any(|b| b.inner.0 <= r.start && r.end <= b.inner.1)
        });
        if !inside && !state.seen.contains(&digest(&text)) {
            return failure(
                "invalid-request",
                Some("the replacements reach outside the blocks"),
            );
        }
        let next = engine.remap_chapter(&state.map, &text, &replacements);
        if next.broken {
            let refusal = object(vec![
                ("code", "not-well-formed".into_ipc()),
                (
                    "message",
                    format!(
                        "the edit would break the chapter: {}",
                        next.error.as_deref().unwrap_or("undefined")
                    )
                    .into_ipc(),
                ),
            ]);
            return object(vec![
                ("ok", false.into_ipc()),
                ("error", "refused".into_ipc()),
                ("refusal", refusal),
                ("message", "the edit would break the chapter".into_ipc()),
            ]);
        }
        let before: HashSet<&str> = state.map.blocks.iter().map(|b| b.id.as_str()).collect();
        let created = next
            .blocks
            .iter()
            .filter(|b| !before.contains(b.id.as_str()))
            .map(|b| b.id.clone())
            .collect();
        self.commit_edit(engine, i, index, next, replacements, created)
    }

    /// `isDirty()`: a chapter differs from its stored text
    pub fn is_dirty(&self) -> bool {
        self.chapters.iter().any(|c| c.map.source != c.stored)
    }

    /// `editsForSave()`
    pub fn edits_for_save(&self) -> Vec<(String, Vec<Replacement>)> {
        self.chapters
            .iter()
            .filter(|c| !c.replacements.is_empty() && c.map.source != c.stored)
            .map(|c| (c.path.clone(), c.replacements.clone()))
            .collect()
    }

    /// `prepareSave`'s snapshot: every chapter's text by entry path
    pub fn snapshot(&self) -> HashMap<String, String> {
        self.chapters
            .iter()
            .map(|c| (c.path.clone(), c.map.source.clone()))
            .collect()
    }

    /// `rebase(saved, snapshot)` once the saved bytes were opened: they are
    /// the book's now; each chapter's text at the snapshot becomes its
    /// stored text, an edit that arrived during the save stays unsaved
    pub fn rebase(&mut self, saved: Bytes, opened: OpenedBook, snapshot: &HashMap<String, String>) {
        self.bytes = saved;
        self.spine = spine_of(&opened.summary);
        self.fixed_layout =
            opened.summary.get("fixedLayout").and_then(Value::as_bool) == Some(true);
        self.summary = opened.summary;
        self.doc_hash = opened.doc_hash;
        for state in &mut self.chapters {
            if let Some(stored) = snapshot.get(&state.path) {
                state.stored = stored.clone();
            }
            state.replacements = if state.map.source == state.stored {
                Vec::new()
            } else {
                vec![diff_replacement(&state.stored, &state.map.source)]
            };
        }
    }

    /// the current text of a chapter already read
    pub fn source_of(&self, path: &str) -> Option<String> {
        self.chapter_index(path)
            .map(|i| self.chapters[i].map.source.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(start: usize, end: usize, text: &str) -> Replacement {
        Replacement {
            start,
            end,
            text: text.into(),
        }
    }

    #[test]
    fn inverse_takes_the_text_back() {
        let before = "abc def ghi";
        let edits = vec![r(4, 7, "XY"), r(0, 3, "Q")];
        let after = apply_replacements(before, &edits);
        assert_eq!(after, "Q XY ghi");
        let inverse = invert_replacements(before, &edits);
        assert_eq!(apply_replacements(&after, &inverse), before);
    }

    #[test]
    fn diff_counts_utf16_units() {
        let d = diff_replacement("a\u{1F600}b", "a\u{1F600}cb");
        assert_eq!(d, r(3, 3, "c"));
    }

    #[test]
    fn block_edits_are_checked_field_by_field() {
        let edit = |entries: Vec<(&str, IpcValue)>| block_edit_of(&object(entries));
        assert!(
            edit(vec![
                ("op", "replace".into_ipc()),
                ("blockId", "b".into_ipc()),
                ("text", "x".into_ipc())
            ])
            .is_some()
        );
        assert!(
            edit(vec![
                ("op", "replace".into_ipc()),
                ("blockId", "b".into_ipc()),
                ("text", "x".into_ipc()),
                ("dropRuby", "yes".into_ipc())
            ])
            .is_none()
        );
        assert!(
            edit(vec![
                ("op", "toggle_mark".into_ipc()),
                ("blockId", "b".into_ipc()),
                ("mark", "bold".into_ipc()),
                ("start", IpcValue::Number(3.0)),
                ("end", IpcValue::Number(2.0))
            ])
            .is_none()
        );
        assert!(
            edit(vec![
                ("op", "delete".into_ipc()),
                ("blockId", "".into_ipc())
            ])
            .is_none()
        );
    }
}
