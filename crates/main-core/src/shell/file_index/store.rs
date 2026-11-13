//! `apps/shell/src/main/file-index/store.ts`: the SQLite FTS5 index over file
//! names, folders and extracted text, over `rusqlite` where the TypeScript
//! uses `node:sqlite`. The SQL text and the order of its statements are the
//! TypeScript's.
//!
//! `node:sqlite` binds every JavaScript number as a double (an integer the
//! column's affinity turns back into one) and reads an INTEGER back as a
//! number, so a number here is bound as `Real` and read as `f64`; the ids the
//! TypeScript carries as numbers are `i64` read from the row and bound as
//! `Real`. A thrown `Error` of `node:sqlite` is a [`StoreError`] holding the
//! message SQLite gave.

use std::collections::{HashMap, HashSet};

use jscompat::node_path::host::{basename, dirname};
use jscompat::{JsMap, math_max, math_min, slice_utf16, sort_by_number};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Row as SqlRow, params_from_iter};
use serde::Serialize;

use super::extract::MAX_BODY_CHARS;
use super::scan::{ScannedFile, stat_or_null};
use super::snippet::{SnippetPart, build_snippet, contains_any, excerpt};
use super::tokenize::{
    MatchJoin, ParsedQuery, QueryTerm, parse_query, term_chars, term_expr, to_index_text,
    to_match_expression, token_exprs, tokenize,
};
use crate::shell::app_routing::document_extension;

/// What a failing `node:sqlite` call throws: an `Error` with the message
/// SQLite gave (its `code` is `ERR_SQLITE_ERROR`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError(pub String);

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn sql(e: rusqlite::Error) -> StoreError {
    match e {
        rusqlite::Error::SqliteFailure(code, message) => {
            StoreError(message.unwrap_or_else(|| code.to_string()))
        }
        other => StoreError(other.to_string()),
    }
}

/// bump when tokenize() changes shape; the index is rebuilt from scratch
const TOKENIZER_VERSION: u32 = 2;
/// bump when extraction changes what may enter a body; the index is rebuilt
/// from scratch. 1: text a file withholds from a model is indexed as its
/// {{label}} marker. An index with no stamp predates that and may hold the
/// withheld words, which search excerpts would quote. 2: pptx comments join
/// the extracted body.
const EXTRACT_VERSION: u32 = 2;

/// `IndexStatus`. `Cloud`: indexed by name only because the file is not on
/// this PC and lies in a project folder (spec 5.8); a later scan looks again
/// and extracts the body once the file is local.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexStatus {
    Ok,
    NameOnly,
    Error,
    Cloud,
}

impl IndexStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            IndexStatus::Ok => "ok",
            IndexStatus::NameOnly => "name-only",
            IndexStatus::Error => "error",
            IndexStatus::Cloud => "cloud",
        }
    }

    /// The status a row holds; only [`IndexStatus::as_str`] writes one
    fn from_row(text: &str) -> IndexStatus {
        match text {
            "ok" => IndexStatus::Ok,
            "name-only" => IndexStatus::NameOnly,
            "cloud" => IndexStatus::Cloud,
            _ => IndexStatus::Error,
        }
    }
}

/// `IndexedFile`
#[derive(Debug, Clone, PartialEq)]
pub struct IndexedFile {
    pub path: String,
    pub mtime_ms: f64,
    pub size_bytes: f64,
    pub status: IndexStatus,
}

/// `SearchHit`, serialized with the keys of the TypeScript literal in its order
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub ext: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: f64,
    /// excerpt around the first content match; `None` when only the name/path matched
    pub snippet: Option<Vec<SnippetPart>>,
    /// the folded query fragments this file matched, for highlighting name and folder
    pub needles: Vec<String>,
    /// body text around the first hit, only when `excerptChars` was requested
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
}

/// `SearchOptions`; an absent or `null` number is `None`
#[derive(Default)]
pub struct SearchOptions<'a> {
    /// restrict to these lowercased extensions
    pub exts: Option<Vec<String>>,
    pub offset: Option<f64>,
    pub limit: Option<f64>,
    /// attach this many characters of body around the first hit to each result
    pub excerpt_chars: Option<f64>,
    /// keep only the files whose path passes; applied before ranking and
    /// paging, so files elsewhere cannot fill the page first and `total`
    /// counts the kept ones
    pub within: Option<&'a dyn Fn(&str) -> bool>,
}

/// `SearchResult`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub total: usize,
}

/// `{ path, name, excerpt }` of `excerptsFor`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExcerptHit {
    pub path: String,
    pub name: String,
    pub excerpt: String,
}

/// a term with no phrase hit still matches a file covering more than this share of its characters
const RELAXED_MIN_COVERAGE: f64 = 0.5;
const RELAXED_MIN_TOKENS: usize = 3;

struct Row {
    id: i64,
    path: String,
    name: String,
    ext: String,
    mtime_ms: f64,
    size_bytes: f64,
}

/// how one file fares against the whole query
struct Candidate {
    exact: usize,
    relaxed: usize,
    /// summed character coverage of relaxed term hits
    cover: f64,
    /// summed BM25 over exact term hits (lower is better)
    score: f64,
    needles: Vec<String>,
}

impl Candidate {
    /// `needles.add(needle)` of a `Set<string>`
    fn add_needle(&mut self, needle: &str) {
        if !self.needles.iter().any(|known| known == needle) {
            self.needles.push(needle.to_owned());
        }
    }
}

/// A `Map<number, V>`: entries in the order they were first set. Only
/// deletions come after the last insertion in `search`, so a deleted id is
/// left in `order` and skipped.
struct Ordered<V> {
    order: Vec<i64>,
    map: HashMap<i64, V>,
}

impl<V> Ordered<V> {
    fn new() -> Self {
        Ordered {
            order: Vec::new(),
            map: HashMap::new(),
        }
    }

    fn entry(&mut self, id: i64, make: impl FnOnce() -> V) -> &mut V {
        if !self.map.contains_key(&id) {
            self.order.push(id);
            self.map.insert(id, make());
        }
        self.map.get_mut(&id).expect("just set")
    }

    fn get(&self, id: i64) -> Option<&V> {
        self.map.get(&id)
    }

    fn remove(&mut self, id: i64) {
        self.map.remove(&id);
    }

    fn len(&self) -> usize {
        self.map.len()
    }

    /// `[...map.keys()]`
    fn keys(&self) -> Vec<i64> {
        self.order
            .iter()
            .copied()
            .filter(|id| self.map.contains_key(id))
            .collect()
    }

    /// `for (const [id, v] of map)`
    fn iter(&self) -> impl Iterator<Item = (i64, &V)> {
        self.order
            .iter()
            .filter_map(|id| self.map.get(id).map(|v| (*id, v)))
    }
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  body TEXT
);
";

const FTS_SCHEMA: &str = "
CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(
  name, path, body, name_u, path_u, body_u,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);
";

fn text(value: &str) -> SqlValue {
    SqlValue::Text(value.to_owned())
}

/// a number as `node:sqlite` binds it
fn real(value: f64) -> SqlValue {
    SqlValue::Real(value)
}

fn real_id(id: i64) -> SqlValue {
    SqlValue::Real(id as f64)
}

/// `(?,?,...)` of n parameters
fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

/// `array.slice(start, end)` for a start and an end that are not negative
fn slice_range(len: usize, start: f64, end: f64) -> std::ops::Range<usize> {
    let from = start.trunc().min(len as f64) as usize;
    let to = end.trunc().min(len as f64) as usize;
    if from >= to { from..from } else { from..to }
}

/// SQLite FTS5 index over file names, folders and extracted text. FTS5 only
/// sees pre-tokenized shadow text (see tokenize.rs); the raw body stays in
/// `files` for snippets. Contentless FTS keeps the shadow text out of the
/// database.
pub struct FileIndexStore {
    db: Connection,
}

impl FileIndexStore {
    pub fn new(db_path: &str) -> Result<FileIndexStore, StoreError> {
        let db = Connection::open(db_path).map_err(sql)?;
        let store = FileIndexStore { db };
        store.exec("PRAGMA journal_mode = WAL")?;
        store.exec(SCHEMA)?;
        let tokenizer = TOKENIZER_VERSION.to_string();
        if store.meta("tokenizer")?.as_deref() != Some(tokenizer.as_str()) {
            store.exec("DROP TABLE IF EXISTS file_fts; DELETE FROM files;")?;
            store.set_meta("tokenizer", &tokenizer)?;
        }
        let extract = EXTRACT_VERSION.to_string();
        if store.meta("extract")?.as_deref() != Some(extract.as_str()) {
            store.exec("DROP TABLE IF EXISTS file_fts; DELETE FROM files;")?;
            store.set_meta("extract", &extract)?;
        }
        store.exec(FTS_SCHEMA)?;
        Ok(store)
    }

    /// `db.exec(sql)`
    fn exec(&self, statements: &str) -> Result<(), StoreError> {
        self.db.execute_batch(statements).map_err(sql)
    }

    /// `db.prepare(query).all(...params)`, each row read by `read`
    fn all<T>(
        &self,
        query: &str,
        params: Vec<SqlValue>,
        read: impl FnMut(&SqlRow<'_>) -> rusqlite::Result<T>,
    ) -> Result<Vec<T>, StoreError> {
        let mut stmt = self.db.prepare(query).map_err(sql)?;
        let rows = stmt
            .query_map(params_from_iter(params), read)
            .map_err(sql)?;
        rows.collect::<rusqlite::Result<Vec<T>>>().map_err(sql)
    }

    /// `db.prepare(query).get(...params)`, the row read by `read`
    fn get<T>(
        &self,
        query: &str,
        params: Vec<SqlValue>,
        read: impl FnOnce(&SqlRow<'_>) -> rusqlite::Result<T>,
    ) -> Result<Option<T>, StoreError> {
        let mut stmt = self.db.prepare(query).map_err(sql)?;
        stmt.query_row(params_from_iter(params), read)
            .optional()
            .map_err(sql)
    }

    fn meta(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.get(
            "SELECT value FROM meta WHERE key = ?",
            vec![text(key)],
            |r| r.get::<_, String>(0),
        )
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.db
            .prepare(
                "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .map_err(sql)?
            .execute(params_from_iter(vec![text(key), text(value)]))
            .map_err(sql)?;
        Ok(())
    }

    pub fn list_all(&self) -> Result<JsMap<IndexedFile>, StoreError> {
        let rows = self.all(
            "SELECT path, mtime_ms, size_bytes, status FROM files",
            Vec::new(),
            |r| {
                Ok(IndexedFile {
                    path: r.get::<_, String>(0)?,
                    mtime_ms: r.get::<_, f64>(1)?,
                    size_bytes: r.get::<_, f64>(2)?,
                    status: IndexStatus::from_row(&r.get::<_, String>(3)?),
                })
            },
        )?;
        let mut out = JsMap::new();
        for file in rows {
            out.set(file.path.clone(), file);
        }
        Ok(out)
    }

    pub fn count(&self) -> Result<i64, StoreError> {
        Ok(self
            .get("SELECT count(*) AS n FROM files", Vec::new(), |r| {
                r.get::<_, i64>(0)
            })?
            .unwrap_or(0))
    }

    /// insert or replace one file; `text` `None` indexes the name and folder only
    pub fn upsert(
        &self,
        meta: &ScannedFile,
        body_text: Option<&str>,
        status: IndexStatus,
    ) -> Result<(), StoreError> {
        let name = basename(&meta.path, None);
        // a draw.io picture is listed as `drawio.svg` / `drawio.png`, like the recents
        let ext = document_extension(&meta.path);
        let body = body_text
            .filter(|t| !t.is_empty())
            .map(|t| slice_utf16(t, 0.0, Some(MAX_BODY_CHARS as f64)));
        let name_tok = tokenize(&name);
        let path_tok = tokenize(&dirname(&meta.path));
        let body_tok = match &body {
            Some(b) => tokenize(b),
            None => Default::default(),
        };
        self.exec("BEGIN")?;
        let run = || -> Result<(), StoreError> {
            let existing = self.get(
                "SELECT id FROM files WHERE path = ?",
                vec![text(&meta.path)],
                |r| r.get::<_, i64>(0),
            )?;
            if let Some(id) = existing {
                self.run("DELETE FROM file_fts WHERE rowid = ?", vec![real_id(id)])?;
                self.run("DELETE FROM files WHERE id = ?", vec![real_id(id)])?;
            }
            self.run(
                "INSERT INTO files(path, name, ext, mtime_ms, size_bytes, status, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
                vec![
                    text(&meta.path),
                    text(&name),
                    text(&ext),
                    real(meta.mtime_ms),
                    real(meta.size_bytes),
                    text(status.as_str()),
                    match &body {
                        Some(b) => text(b),
                        None => SqlValue::Null,
                    },
                ],
            )?;
            let inserted = self.db.last_insert_rowid();
            self.run(
                "INSERT INTO file_fts(rowid, name, path, body, name_u, path_u, body_u) VALUES (?, ?, ?, ?, ?, ?, ?)",
                vec![
                    real_id(inserted),
                    text(&to_index_text(&name_tok.bi)),
                    text(&to_index_text(&path_tok.bi)),
                    text(&to_index_text(&body_tok.bi)),
                    text(&to_index_text(&name_tok.uni)),
                    text(&to_index_text(&path_tok.uni)),
                    text(&to_index_text(&body_tok.uni)),
                ],
            )?;
            self.exec("COMMIT")
        };
        match run() {
            Ok(()) => Ok(()),
            Err(e) => {
                self.exec("ROLLBACK")?;
                Err(e)
            }
        }
    }

    /// `db.prepare(query).run(...params)`
    fn run(&self, query: &str, params: Vec<SqlValue>) -> Result<(), StoreError> {
        let mut stmt = self.db.prepare(query).map_err(sql)?;
        stmt.execute(params_from_iter(params)).map_err(sql)?;
        Ok(())
    }

    pub fn remove(&self, paths: &[String]) -> Result<(), StoreError> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut select = self
            .db
            .prepare("SELECT id FROM files WHERE path = ?")
            .map_err(sql)?;
        let mut del_fts = self
            .db
            .prepare("DELETE FROM file_fts WHERE rowid = ?")
            .map_err(sql)?;
        let mut del_file = self
            .db
            .prepare("DELETE FROM files WHERE id = ?")
            .map_err(sql)?;
        self.exec("BEGIN")?;
        let mut run = || -> Result<(), StoreError> {
            for p in paths {
                let row = select
                    .query_row(params_from_iter(vec![text(p)]), |r| r.get::<_, i64>(0))
                    .optional()
                    .map_err(sql)?;
                let Some(id) = row else { continue };
                del_fts
                    .execute(params_from_iter(vec![real_id(id)]))
                    .map_err(sql)?;
                del_file
                    .execute(params_from_iter(vec![real_id(id)]))
                    .map_err(sql)?;
            }
            self.exec("COMMIT")
        };
        match run() {
            Ok(()) => Ok(()),
            Err(e) => {
                self.exec("ROLLBACK")?;
                Err(e)
            }
        }
    }

    /// Each term is judged on its own: a phrase hit, or failing that a file
    /// holding most of the term's tokens. Files matching every term come
    /// first; when none does, any term will do. Within that, a name starting
    /// with the query, then name/folder hits, then more exact terms, then BM25
    /// and recency.
    pub fn search(
        &self,
        input: &str,
        opts: &SearchOptions<'_>,
    ) -> Result<SearchResult, StoreError> {
        let parsed = parse_query(input);
        if parsed.include.is_empty() {
            return Ok(SearchResult {
                hits: Vec::new(),
                total: 0,
            });
        }
        let mut candidates: Ordered<Candidate> = Ordered::new();
        let new_candidate = || Candidate {
            exact: 0,
            relaxed: 0,
            cover: 0.0,
            score: 0.0,
            needles: Vec::new(),
        };
        for term in &parsed.include {
            let mut exact_ids: HashSet<i64> = HashSet::new();
            for (rowid, score) in self.match_scored(&term_expr(term))? {
                exact_ids.insert(rowid);
                let c = candidates.entry(rowid, new_candidate);
                c.exact += 1;
                c.score += score;
                c.add_needle(&term.text);
            }
            for (id, m) in self.relaxed_matches(term)?.iter() {
                if exact_ids.contains(&id) {
                    continue;
                }
                let c = candidates.entry(id, new_candidate);
                c.relaxed += 1;
                c.cover += m.cover;
                for t in &m.tokens {
                    c.add_needle(t);
                }
            }
        }
        if !parsed.exclude.is_empty() {
            let expr = to_match_expression(
                &ParsedQuery {
                    include: parsed.exclude.clone(),
                    exclude: Vec::new(),
                },
                MatchJoin::Or,
            );
            if let Some(expr) = expr.filter(|e| !e.is_empty()) {
                for id in self.match_ids(&expr)? {
                    candidates.remove(id);
                }
            }
        }
        if candidates.len() == 0 {
            return Ok(SearchResult {
                hits: Vec::new(),
                total: 0,
            });
        }
        let wanted = parsed.include.len();
        // the type filter applies before choosing all-term over any-term, so a pill never hides the fallback
        let fetched = self.fetch_rows(&candidates.keys(), opts.exts.as_deref())?;
        let all_rows: Vec<Row> = match opts.within {
            Some(within) => fetched.into_iter().filter(|r| within(&r.path)).collect(),
            None => fetched,
        };
        let is_full = |r: &Row| {
            let c = candidates.get(r.id).expect("a fetched id is a candidate");
            c.exact + c.relaxed == wanted
        };
        let full_count = all_rows.iter().filter(|r| is_full(r)).count();
        let rows: Vec<Row> = if full_count > 0 {
            all_rows.into_iter().filter(|r| is_full(r)).collect()
        } else {
            all_rows
        };
        let first = &parsed.include[0].text;
        let mut ranked: Vec<(Row, [f64; 7])> = rows
            .into_iter()
            .map(|r| {
                let c = candidates.get(r.id).expect("a fetched id is a candidate");
                let meta = contains_any(&r.name, &c.needles)
                    || contains_any(&dirname(&r.path), &c.needles);
                let rank = [
                    if r.name.to_lowercase().starts_with(first.as_str()) {
                        0.0
                    } else {
                        1.0
                    },
                    -((c.exact + c.relaxed) as f64),
                    if meta { 0.0 } else { 1.0 },
                    -(c.exact as f64),
                    -c.cover,
                    c.score,
                    -r.mtime_ms,
                ];
                (r, rank)
            })
            .collect();
        sort_by_number(&mut ranked, |a, b| {
            for i in 0..a.1.len() {
                if a.1[i] != b.1[i] {
                    return a.1[i] - b.1[i];
                }
            }
            0.0
        });
        let limit = match opts.limit {
            Some(limit) if limit.is_finite() => math_max(0.0, math_min(200.0, limit)),
            _ => 50.0,
        };
        let offset = match opts.offset {
            Some(offset) if offset.is_finite() => math_max(0.0, offset),
            _ => 0.0,
        };
        let total = ranked.len();
        let page = &ranked[slice_range(total, offset, offset + limit)];
        let bodies = self.fetch_bodies(&page.iter().map(|(r, _)| r.id).collect::<Vec<_>>())?;
        let excerpt_chars = opts.excerpt_chars.filter(|c| *c != 0.0 && !c.is_nan());
        let hits = page
            .iter()
            .map(|(r, _)| {
                let needles = candidates
                    .get(r.id)
                    .expect("a fetched id is a candidate")
                    .needles
                    .clone();
                let body = bodies.get(&r.id);
                SearchHit {
                    path: r.path.clone(),
                    name: r.name.clone(),
                    ext: r.ext.clone(),
                    mtime_ms: r.mtime_ms,
                    size_bytes: r.size_bytes,
                    snippet: body.and_then(|b| build_snippet(b, &needles)),
                    excerpt: match (excerpt_chars, body) {
                        (Some(chars), Some(b)) => Some(excerpt(b, &needles, chars)),
                        _ => None,
                    },
                    needles,
                }
            })
            .collect();
        Ok(SearchResult { hits, total })
    }

    /// name and body excerpt for the given paths, in that order; unknown paths are skipped
    pub fn excerpts_for(
        &self,
        paths: &[String],
        q: &str,
        chars: f64,
    ) -> Result<Vec<ExcerptHit>, StoreError> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let parsed = parse_query(q);
        let needles: Vec<&str> = parsed
            .include
            .iter()
            .flat_map(|t: &QueryTerm| {
                std::iter::once(t.text.as_str()).chain(t.tokens.bi.iter().map(String::as_str))
            })
            .collect();
        let rows = self.all(
            &format!(
                "SELECT path, name, body FROM files WHERE path IN ({})",
                placeholders(paths.len())
            ),
            paths.iter().map(|p| text(p)).collect(),
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )?;
        let mut by_path: JsMap<(String, String, Option<String>)> = JsMap::new();
        for row in rows {
            by_path.set(row.0.clone(), row);
        }
        let mut out = Vec::new();
        for p in paths {
            if let Some((path, name, body)) = by_path.get(p) {
                out.push(ExcerptHit {
                    path: path.clone(),
                    name: name.clone(),
                    excerpt: match body {
                        Some(b) if !b.is_empty() => excerpt(b, &needles, chars),
                        _ => String::new(),
                    },
                });
            }
        }
        Ok(out)
    }

    /// The paths whose indexed body is the file as it is on disk now: same
    /// mtime and size, the test a scan uses to decide what to re-read. A file
    /// saved since its last scan is still indexed as it was before the save,
    /// withheld spans it has gained included, so a caller that sends excerpts
    /// out of the machine asks this first. Unknown and vanished files are left
    /// out too.
    pub fn paths_indexed_as_on_disk(&self, paths: &[String]) -> Result<Vec<String>, StoreError> {
        let mut indexed: JsMap<(f64, f64)> = JsMap::new();
        for chunk in paths.chunks(500) {
            let rows = self.all(
                &format!(
                    "SELECT path, mtime_ms, size_bytes FROM files WHERE path IN ({})",
                    placeholders(chunk.len())
                ),
                chunk.iter().map(|p| text(p)).collect(),
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, f64>(1)?,
                        r.get::<_, f64>(2)?,
                    ))
                },
            )?;
            for (path, mtime_ms, size_bytes) in rows {
                indexed.set(path, (mtime_ms, size_bytes));
            }
        }
        Ok(paths
            .iter()
            .filter(|path| {
                let row = indexed.get(path);
                let now = row.and_then(|_| stat_or_null(path));
                match (row, now) {
                    (Some((mtime_ms, size_bytes)), Some(now)) => {
                        now.mtime_ms == *mtime_ms && now.size_bytes == *size_bytes
                    }
                    _ => false,
                }
            })
            .cloned()
            .collect())
    }

    fn match_scored(&self, expr: &str) -> Result<Vec<(i64, f64)>, StoreError> {
        self.all(
            "SELECT rowid, bm25(file_fts, 10.0, 5.0, 1.0, 10.0, 5.0, 1.0) AS score FROM file_fts WHERE file_fts MATCH ?",
            vec![text(expr)],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?)),
        )
    }

    fn match_ids(&self, expr: &str) -> Result<Vec<i64>, StoreError> {
        self.all(
            "SELECT rowid FROM file_fts WHERE file_fts MATCH ?",
            vec![text(expr)],
            |r| r.get::<_, i64>(0),
        )
    }

    /// files covering more than half of the term's characters, with the tokens they hold
    fn relaxed_matches(&self, term: &QueryTerm) -> Result<Ordered<Relaxed>, StoreError> {
        let tokens = token_exprs(term);
        let mut out: Ordered<(Vec<String>, HashSet<usize>)> = Ordered::new();
        if tokens.len() < RELAXED_MIN_TOKENS {
            return Ok(Ordered::new());
        }
        for t in &tokens {
            for id in self.match_ids(&t.expr)? {
                let m = out.entry(id, || (Vec::new(), HashSet::new()));
                m.0.push(t.text.clone());
                for i in &t.at {
                    m.1.insert(*i);
                }
            }
        }
        let total = term_chars(term);
        let mut kept: Ordered<Relaxed> = Ordered::new();
        for (id, m) in out.iter() {
            let cover = m.1.len() as f64 / total as f64;
            if cover > RELAXED_MIN_COVERAGE {
                kept.entry(id, || Relaxed {
                    tokens: m.0.clone(),
                    cover,
                });
            }
        }
        Ok(kept)
    }

    fn fetch_rows(&self, ids: &[i64], exts: Option<&[String]>) -> Result<Vec<Row>, StoreError> {
        let lower: Vec<String> = exts
            .map(|exts| exts.iter().map(|e| e.to_lowercase()).collect())
            .unwrap_or_default();
        let ext_clause = if lower.is_empty() {
            String::new()
        } else {
            format!(" AND ext IN ({})", placeholders(lower.len()))
        };
        let mut rows = Vec::new();
        for chunk in ids.chunks(500) {
            let mut params: Vec<SqlValue> = chunk.iter().map(|id| real_id(*id)).collect();
            params.extend(lower.iter().map(|e| text(e)));
            rows.extend(self.all(
                &format!(
                    "SELECT id, path, name, ext, mtime_ms, size_bytes FROM files WHERE id IN ({}){}",
                    placeholders(chunk.len()),
                    ext_clause
                ),
                params,
                |r| {
                    Ok(Row {
                        id: r.get::<_, i64>(0)?,
                        path: r.get::<_, String>(1)?,
                        name: r.get::<_, String>(2)?,
                        ext: r.get::<_, String>(3)?,
                        mtime_ms: r.get::<_, f64>(4)?,
                        size_bytes: r.get::<_, f64>(5)?,
                    })
                },
            )?);
        }
        Ok(rows)
    }

    fn fetch_bodies(&self, ids: &[i64]) -> Result<HashMap<i64, String>, StoreError> {
        let mut out = HashMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        let rows = self.all(
            &format!(
                "SELECT id, body FROM files WHERE id IN ({})",
                placeholders(ids.len())
            ),
            ids.iter().map(|id| real_id(*id)).collect(),
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
        )?;
        for (id, body) in rows {
            if let Some(body) = body.filter(|b| !b.is_empty()) {
                out.insert(id, body);
            }
        }
        Ok(out)
    }

    pub fn close(self) -> Result<(), StoreError> {
        self.db.close().map_err(|(_, e)| sql(e))
    }
}

/// `{ tokens, cover }` of `relaxedMatches`
struct Relaxed {
    tokens: Vec<String>,
    cover: f64,
}
