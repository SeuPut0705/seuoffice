//! `pdf-structure-ipc.ts` and `pdf-structure/handlers.ts`: the pdf editor's
//! structure jobs and result store.
//!
//! A job reads only a file granted to the calling view (its open file) and
//! writes only to a target the main process's dialog picked for that view,
//! never to a granted source. A store call takes only a document hash the
//! main process computed for that view. Every handler answers an outcome
//! (`{ ok: true, ... }` or `{ ok: false, error, message? }`), never throws.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use jscompat::js_regex;
use jscompat::node_path::host::{basename, dirname, extname, join, resolve};
use main_core::packages::pdf_structure::job_key_of;
use shell_contract::ipc::{Responder, Target};
use shell_contract::runtime::PathName;
use shell_contract::{IpcValue, ViewId};

use super::hosts::{JobFailure, PdfToolsEngine, StoreError, StoreMethod};
use super::runner::Progress;
use super::{Ctx, is_record, js_filter, js_len, js_str, js_strs, ok_with, options, safe_int, with};
use crate::kit::{self, Args, Entry, IntoIpc, as_num, as_str, field, obj, truthy};

const MAX_PAGES: usize = 100_000;
const MAX_PAGE_NUMBER: f64 = 10_000_000.0;
const MAX_TEXT: usize = 2_000;
const MAX_PASSWORD: usize = 1_024;
/// a person's edit of one translated block
const MAX_EDITED_TEXT: usize = 200_000;
/// suggestion states changed in one call
const MAX_STATES: usize = 10_000;
const SUGGESTION_STATES: [&str; 3] = ["pending", "accepted", "dismissed"];
/// `JOB_KINDS` (packages/pdf-structure/src/store/job-keys.ts)
const JOB_KINDS: [&str; 5] = [
    "ai-read",
    "translate",
    "translate-page",
    "highlight",
    "summary",
];
/// `COPY_ATTEMPTS` of job-migration.ts
const COPY_ATTEMPTS: usize = 3;

/// `fail(error, message)`
pub fn fail(error: &str, message: &str) -> IpcValue {
    let mut out = vec![
        ("ok".to_owned(), false.into_ipc()),
        ("error".to_owned(), error.into_ipc()),
    ];
    if !message.is_empty() {
        out.push(("message".to_owned(), message.into_ipc()));
    }
    IpcValue::Object(out)
}

/// A runner's failure as the renderer gets it (`failureOf`)
pub fn failure(f: JobFailure) -> IpcValue {
    let mut out = vec![
        ("ok".to_owned(), false.into_ipc()),
        ("error".to_owned(), f.error.into_ipc()),
    ];
    if let Some(m) = f.message.filter(|m| !m.is_empty()) {
        out.push(("message".to_owned(), m.into_ipc()));
    }
    if let Some((first, last)) = f.valid_range {
        out.push((
            "validRange".to_owned(),
            obj([("first", first.into_ipc()), ("last", last.into_ipc())]),
        ));
    }
    IpcValue::Object(out)
}

/// `storeFailure(err)`
fn store_failure(e: StoreError) -> IpcValue {
    match e {
        StoreError::Write(m) => fail("store-write-failed", &m),
        StoreError::Type(m) => fail("invalid-request", &m),
        StoreError::Other(m) => fail("failed", &m),
    }
}

/// `optText(v, max)`
fn opt_text(v: &IpcValue, max: usize) -> bool {
    match v {
        IpcValue::Undefined => true,
        IpcValue::String(s) => js_len(s) <= max,
        _ => false,
    }
}

/// `isKey(v)`: a store key
fn is_key(v: &IpcValue) -> bool {
    as_str(v).is_some_and(|s| js_regex!(r"^[A-Za-z0-9_-]{1,128}$").test(s))
}

fn is_job_id(s: &str) -> bool {
    js_regex!(r"^[A-Za-z0-9_-]{1,64}$").test(s)
}

fn is_language_tag(s: &str) -> bool {
    js_regex!(r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$").test(s)
}

/// `blockKeyOf(v)`
fn block_key_of(v: &IpcValue) -> Option<IpcValue> {
    if !is_record(v) || !is_key(field(v, "pageFingerprint")) || !is_key(field(v, "textHash")) {
        return None;
    }
    let occurrence = safe_int(field(v, "occurrence")).filter(|o| *o >= 0.0)?;
    Some(obj([
        ("pageFingerprint", field(v, "pageFingerprint").clone()),
        ("textHash", field(v, "textHash").clone()),
        ("occurrence", occurrence.into_ipc()),
    ]))
}

/// `suggestionStatesOf(v)`
fn suggestion_states_of(v: &IpcValue) -> Option<IpcValue> {
    if !is_record(v) {
        return None;
    }
    let IpcValue::Object(entries) = v else {
        return Some(IpcValue::Object(Vec::new()));
    };
    if entries.len() > MAX_STATES {
        return None;
    }
    let mut out = Vec::new();
    for (id, state) in entries {
        let len = js_len(id);
        if len == 0 || len > 200 || !as_str(state).is_some_and(|s| SUGGESTION_STATES.contains(&s)) {
            return None;
        }
        out.push((id.clone(), state.clone()));
    }
    Some(IpcValue::Object(out))
}

/// `modeOf(v)`: left out is `translate`; `None` when it is not a mode
fn mode_of(v: &IpcValue) -> Option<&'static str> {
    match v {
        IpcValue::Undefined => Some("translate"),
        IpcValue::String(s) if s == "translate" => Some("translate"),
        IpcValue::String(s) if s == "easy" => Some("easy"),
        _ => None,
    }
}

/// `modeArgs(mode)`: a mode argument only for an easy explanation
fn mode_args(mode: &str) -> Vec<IpcValue> {
    if mode == "easy" {
        vec!["easy".into_ipc()]
    } else {
        Vec::new()
    }
}

fn target_ext(kind: &str) -> &'static str {
    match kind {
        "md" => ".md",
        "epub" => ".epub",
        _ => ".pdf",
    }
}

fn target_filter(kind: &str) -> &'static str {
    match kind {
        "md" => "Markdown",
        "epub" => "EPUB",
        _ => "PDF",
    }
}

/// `withoutImageData(tree)`: picture bytes left out
fn without_image_data(tree: &IpcValue) -> IpcValue {
    let IpcValue::Array(blocks) = field(tree, "blocks") else {
        return tree.clone();
    };
    let blocks = blocks
        .iter()
        .map(|b| match as_str(field(b, "kind")) {
            Some("image" | "pageImage") => with(b.clone(), "data", kit::u8_array(Vec::new())),
            _ => b.clone(),
        })
        .collect();
    with(tree.clone(), "blocks", IpcValue::Array(blocks))
}

/// `a.localeCompare(b)` for store keys (`[A-Za-z0-9_-]`): punctuation, then
/// digits, then letters without case, lower case first on a tie
fn key_compare(a: &str, b: &str) -> std::cmp::Ordering {
    fn primary(c: char) -> u32 {
        match c {
            '_' => 0,
            '-' => 1,
            '0'..='9' => 2 + c as u32 - '0' as u32,
            c if c.is_ascii_alphabetic() => 20 + c.to_ascii_lowercase() as u32 - 'a' as u32,
            c => 100 + c as u32,
        }
    }
    let pa: Vec<u32> = a.chars().map(primary).collect();
    let pb: Vec<u32> = b.chars().map(primary).collect();
    pa.cmp(&pb).then_with(|| {
        let ta: Vec<bool> = a.chars().map(|c| c.is_ascii_uppercase()).collect();
        let tb: Vec<bool> = b.chars().map(|c| c.is_ascii_uppercase()).collect();
        ta.cmp(&tb)
    })
}

/// `newestFirst(runs)`
fn newest_first(runs: IpcValue) -> Vec<IpcValue> {
    let IpcValue::Array(mut runs) = runs else {
        return Vec::new();
    };
    runs.sort_by(|a, b| {
        let created = |r: &IpcValue| as_num(field(r, "createdAt")).unwrap_or(f64::NAN);
        let d = created(b) - created(a);
        if d != 0.0 && !d.is_nan() {
            return d.partial_cmp(&0.0).unwrap();
        }
        key_compare(
            as_str(field(a, "runId")).unwrap_or(""),
            as_str(field(b, "runId")).unwrap_or(""),
        )
    });
    runs
}

#[derive(Clone)]
struct CachedTree {
    doc_hash: String,
    pages_key: String,
    tree: IpcValue,
    fingerprints: IpcValue,
}

#[derive(Default)]
struct Inner {
    /// dialog-picked targets per view: path key -> kind (held until a job using it succeeds)
    targets: HashMap<ViewId, HashMap<String, String>>,
    /// targets a running job writes to
    in_use: HashSet<(ViewId, String)>,
    /// document hashes the main process computed for each view
    known: HashMap<ViewId, HashSet<String>>,
    /// one cached tree per view
    trees: HashMap<ViewId, CachedTree>,
    /// one fingerprint list per view
    fingerprints: HashMap<ViewId, (String, Vec<String>)>,
    internal_jobs: u64,
}

/// A checked request source: the job's `source`, its path, the pages key
struct Source {
    job: IpcValue,
    path: String,
    pages_key: String,
}

#[derive(Clone)]
pub struct Structure {
    ctx: Rc<Ctx>,
    s: Rc<RefCell<Inner>>,
    _gone: Rc<dyn Fn(ViewId)>,
}

impl Structure {
    pub fn new(ctx: &Rc<Ctx>) -> Self {
        let s: Rc<RefCell<Inner>> = Rc::default();
        let (weak, c) = (Rc::downgrade(&s), Rc::downgrade(ctx));
        // `watch()`: the view is gone, end its jobs and drop what it was granted
        let gone = kit::on_view_destroyed(&ctx.services, move |view| {
            if let Some(ctx) = c.upgrade() {
                ctx.runner.cancel_owner(view);
            }
            if let Some(s) = weak.upgrade() {
                let mut s = s.borrow_mut();
                s.targets.remove(&view);
                s.known.remove(&view);
                s.trees.remove(&view);
                s.fingerprints.remove(&view);
                s.in_use.retain(|(owner, _)| *owner != view);
            }
        });
        Structure {
            ctx: ctx.clone(),
            s,
            _gone: gone,
        }
    }

    fn path_key(&self, p: &str) -> String {
        let r = resolve(&[p]);
        // `caseInsensitivePaths` on win32 and darwin
        if cfg!(any(windows, target_os = "macos")) {
            r.to_lowercase()
        } else {
            r
        }
    }

    fn granted(&self, owner: ViewId, path: &str) -> bool {
        self.ctx.grants.granted(owner, path)
    }

    fn know(&self, owner: ViewId, doc_hash: &str) {
        self.s
            .borrow_mut()
            .known
            .entry(owner)
            .or_default()
            .insert(doc_hash.to_owned());
    }

    fn knows(&self, owner: ViewId, doc_hash: &IpcValue) -> Option<String> {
        let h = as_str(doc_hash)?;
        self.s
            .borrow()
            .known
            .get(&owner)
            .is_some_and(|set| set.contains(h))
            .then(|| h.to_owned())
    }

    /// `sourceOf(owner, req)`
    fn source_of(&self, owner: ViewId, req: &IpcValue) -> Result<Source, IpcValue> {
        if !is_record(req) {
            return Err(fail("invalid-request", "request must be an object"));
        }
        let path = match as_str(field(req, "path")) {
            Some(p) if self.granted(owner, p) => p.to_owned(),
            _ => return Err(fail("not-granted", "pdf: path not granted to this view")),
        };
        let password = field(req, "password");
        if !opt_text(password, MAX_PASSWORD) {
            return Err(fail("invalid-request", "bad password"));
        }
        let pages = field(req, "pages");
        let mut pages_key = "all".to_owned();
        let mut job = vec![("pdfPath".to_owned(), path.clone().into_ipc())];
        if password != &IpcValue::Undefined {
            job.push(("password".to_owned(), password.clone()));
        }
        if pages != &IpcValue::Undefined {
            let ok = match pages {
                IpcValue::Array(list) => {
                    !list.is_empty()
                        && list.len() <= MAX_PAGES
                        && list.iter().all(|p| {
                            safe_int(p).is_some_and(|p| (1.0..=MAX_PAGE_NUMBER).contains(&p))
                        })
                }
                _ => false,
            };
            if !ok {
                return Err(fail(
                    "invalid-request",
                    "pages must be 1-based page numbers",
                ));
            }
            let IpcValue::Array(list) = pages else {
                unreachable!()
            };
            let mut sorted: Vec<f64> = Vec::new();
            for p in list.iter().filter_map(as_num) {
                if !sorted.contains(&p) {
                    sorted.push(p);
                }
            }
            sorted.sort_by(f64::total_cmp);
            pages_key = sorted
                .iter()
                .map(|p| super::int_text(*p))
                .collect::<Vec<_>>()
                .join(",");
            job.push(("pages".to_owned(), pages.clone()));
        }
        Ok(Source {
            job: IpcValue::Object(job),
            path,
            pages_key,
        })
    }

    /// `claimTarget(owner, sourcePath, outPath, kind)`
    fn claim_target(
        &self,
        owner: ViewId,
        source: &str,
        out: &IpcValue,
        kind: &str,
    ) -> Result<String, IpcValue> {
        let picked = as_str(out).filter(|o| {
            self.s
                .borrow()
                .targets
                .get(&owner)
                .and_then(|t| t.get(&self.path_key(o)))
                .is_some_and(|k| k == kind)
        });
        let Some(out) = picked else {
            return Err(fail("not-granted", "pdf: target not picked for this view"));
        };
        if self.path_key(out) == self.path_key(source) || self.granted(owner, out) {
            return Err(fail(
                "invalid-target",
                "the source document is never written",
            ));
        }
        let key = (owner, self.path_key(out));
        if !self.s.borrow_mut().in_use.insert(key) {
            return Err(fail("busy", "another job writes to this target"));
        }
        Ok(out.to_owned())
    }

    /// `releaseTarget(owner, outPath, used)`
    fn release_target(&self, owner: ViewId, out: &str, used: bool) {
        let key = self.path_key(out);
        let mut s = self.s.borrow_mut();
        s.in_use.remove(&(owner, key.clone()));
        if used && let Some(t) = s.targets.get_mut(&owner) {
            t.remove(&key);
        }
    }

    /// `deps.hashFile(path)` on a worker
    fn hash_file(&self, path: String, then: impl FnOnce(Result<String, String>) + 'static) {
        kit::on_worker(
            &self.ctx.services,
            move || main_core::markdown::fs_util::sha256_file(&path).map_err(|e| e.message),
            then,
        )
    }

    /// `cachedTree(owner, path, pagesKey)`: the cached tree when the file
    /// bytes and pages are unchanged
    fn cached_tree(
        &self,
        owner: ViewId,
        path: &str,
        pages_key: &str,
        then: impl FnOnce(Option<CachedTree>) + 'static,
    ) {
        let cached = self.s.borrow().trees.get(&owner).cloned();
        let Some(cached) = cached.filter(|c| c.pages_key == pages_key) else {
            return then(None);
        };
        let me = self.clone();
        self.hash_file(path.to_owned(), move |hash| match hash {
            Err(_) => then(None),
            Ok(hash) => {
                me.know(owner, &hash);
                then((cached.doc_hash == hash).then_some(cached))
            }
        })
    }

    /// `run(ctx, jobId, job)`: progress goes to the sender as `pdf:structure-progress`
    fn run(
        &self,
        owner: ViewId,
        job_id: &str,
        job: IpcValue,
        then: impl FnOnce(Result<IpcValue, IpcValue>) + 'static,
    ) {
        let events = self.ctx.services.events.clone();
        let views = self.ctx.services.views.clone();
        let id = job_id.to_owned();
        let progress: Progress = Arc::new(move |done, total| {
            if views.sender_of(owner).is_some() {
                events.emit(
                    Target::View(owner),
                    "pdf:structure-progress",
                    vec![obj([
                        ("jobId", id.clone().into_ipc()),
                        ("done", done.into_ipc()),
                        ("total", total.into_ipc()),
                    ])],
                );
            }
        });
        self.ctx
            .runner
            .run(&self.ctx, owner, job_id, job, Some(progress), move |o| {
                then(o.map_err(failure))
            })
    }

    /// `grantTarget(owner, sourcePath, outPath, kind)`
    pub fn grant_target(&self, owner: ViewId, source: &str, out: &str, kind: &str) -> bool {
        if kind != "md" && kind != "epub" {
            return false;
        }
        if !out.to_lowercase().ends_with(target_ext(kind)) || !self.granted(owner, source) {
            return false;
        }
        if self.path_key(out) == self.path_key(source) || self.granted(owner, out) {
            return false;
        }
        let key = self.path_key(out);
        self.s
            .borrow_mut()
            .targets
            .entry(owner)
            .or_default()
            .insert(key, kind.to_owned());
        true
    }

    /// `pickTarget(owner, req)`
    fn pick_target(&self, owner: ViewId, req: &IpcValue) -> IpcValue {
        if !is_record(req) {
            return IpcValue::Null;
        }
        let kind = match as_str(field(req, "kind")) {
            Some(k @ ("md" | "epub" | "pdf" | "folder")) => k.to_owned(),
            _ => return IpcValue::Null,
        };
        let path = match as_str(field(req, "path")) {
            Some(p) if self.granted(owner, p) => p.to_owned(),
            _ => return IpcValue::Null,
        };
        let (default_name, title) = (field(req, "defaultName"), field(req, "title"));
        if !opt_text(default_name, 255) || !opt_text(title, 200) {
            return IpcValue::Null;
        }
        let mut default_path = dirname(&path);
        if kind != "folder" {
            let ext = target_ext(&kind);
            let raw = match as_str(default_name).filter(|n| !n.is_empty()) {
                Some(name) => basename(name, None),
                None => basename(&path, Some(&extname(&path))),
            };
            let stem = js_regex!(r#"[\\/:*?"<>|\u0000-\u001f]"#, "g")
                .replace_all(&raw, |_| "_".to_owned());
            let name = if stem.to_lowercase().ends_with(ext) {
                stem
            } else {
                format!("{}{ext}", if stem.is_empty() { "document" } else { &stem })
            };
            default_path = join(&[&dirname(&path), &name]);
        }
        let title = as_str(title).filter(|t| !t.is_empty()).map(js_str);
        let parent = self.ctx.window_of(owner);
        let picked = if kind == "folder" {
            self.ctx
                .show_open(
                    parent,
                    options([
                        ("title", title),
                        ("defaultPath", Some(js_str(&default_path))),
                        (
                            "properties",
                            Some(js_strs(&["openDirectory", "createDirectory"])),
                        ),
                    ]),
                    None,
                )
                .and_then(|p| p.into_iter().next())
        } else {
            self.ctx.show_save(
                parent,
                options([
                    ("title", title),
                    ("defaultPath", Some(js_str(&default_path))),
                    (
                        "filters",
                        Some(js_filter(target_filter(&kind), &[&target_ext(&kind)[1..]])),
                    ),
                ]),
            )
        };
        let Some(picked) = picked.filter(|p| !p.is_empty()) else {
            return IpcValue::Null;
        };
        // the source is read only: never hand it out as a write target
        if kind != "folder"
            && (self.path_key(&picked) == self.path_key(&path) || self.granted(owner, &picked))
        {
            return IpcValue::Null;
        }
        let key = self.path_key(&picked);
        self.s
            .borrow_mut()
            .targets
            .entry(owner)
            .or_default()
            .insert(key, kind);
        picked.into_ipc()
    }

    fn tree(&self, owner: ViewId, req: IpcValue, r: Responder) {
        let Some(job_id) = job_id_of(&req) else {
            return r.reply(Ok(fail("invalid-request", "bad job id")));
        };
        let src = match self.source_of(owner, &req) {
            Ok(s) => s,
            Err(f) => return r.reply(Ok(f)),
        };
        let image_data = field(&req, "imageData") == &IpcValue::Bool(true);
        let shape = move |c: &CachedTree, cached: bool| {
            obj([
                ("ok", true.into_ipc()),
                ("docHash", c.doc_hash.clone().into_ipc()),
                (
                    "tree",
                    if image_data {
                        c.tree.clone()
                    } else {
                        without_image_data(&c.tree)
                    },
                ),
                ("fingerprints", c.fingerprints.clone()),
                ("cached", cached.into_ipc()),
            ])
        };
        let me = self.clone();
        self.cached_tree(owner, &src.path, &src.pages_key.clone(), move |hit| {
            if let Some(hit) = hit {
                return r.reply(Ok(shape(&hit, true)));
            }
            let job = obj([("op", "tree".into_ipc()), ("source", src.job)]);
            let me2 = me.clone();
            me.run(owner, &job_id, job, move |out| match out {
                Err(f) => r.reply(Ok(f)),
                Ok(value) => {
                    let entry = CachedTree {
                        doc_hash: as_str(field(&value, "docHash")).unwrap_or("").to_owned(),
                        pages_key: src.pages_key,
                        tree: field(&value, "tree").clone(),
                        fingerprints: field(&value, "fingerprints").clone(),
                    };
                    me2.s.borrow_mut().trees.insert(owner, entry.clone());
                    me2.know(owner, &entry.doc_hash);
                    r.reply(Ok(shape(&entry, false)))
                }
            })
        })
    }

    fn text(&self, owner: ViewId, req: IpcValue, r: Responder) {
        let Some(job_id) = job_id_of(&req) else {
            return r.reply(Ok(fail("invalid-request", "bad job id")));
        };
        let src = match self.source_of(owner, &req) {
            Ok(s) => s,
            Err(f) => return r.reply(Ok(f)),
        };
        let me = self.clone();
        self.cached_tree(owner, &src.path, &src.pages_key.clone(), move |hit| {
            let mut job = vec![
                ("op".to_owned(), "structuredText".into_ipc()),
                ("source".to_owned(), src.job),
            ];
            if let Some(hit) = hit {
                job.push(("tree".to_owned(), hit.tree));
            }
            let me2 = me.clone();
            me.run(
                owner,
                &job_id,
                IpcValue::Object(job),
                move |out| match out {
                    Err(f) => r.reply(Ok(f)),
                    Ok(value) => {
                        let doc_hash = as_str(field(&value, "docHash")).unwrap_or("").to_owned();
                        let extracted = field(&value, "extracted");
                        if truthy(extracted) {
                            me2.s.borrow_mut().trees.insert(
                                owner,
                                CachedTree {
                                    doc_hash: doc_hash.clone(),
                                    pages_key: src.pages_key,
                                    tree: field(extracted, "tree").clone(),
                                    fingerprints: field(extracted, "fingerprints").clone(),
                                },
                            );
                        }
                        me2.know(owner, &doc_hash);
                        r.reply(Ok(obj([
                            ("ok", true.into_ipc()),
                            ("docHash", doc_hash.into_ipc()),
                            ("pages", field(&value, "pages").clone()),
                        ])))
                    }
                },
            )
        })
    }

    /// The common end of convert, extract-images and write-back: run the
    /// job, release the target (consumed on success), learn the hash
    fn run_writing(
        &self,
        owner: ViewId,
        job_id: String,
        job: IpcValue,
        out: String,
        shape: impl FnOnce(IpcValue) -> IpcValue + 'static,
        r: Responder,
    ) {
        let me = self.clone();
        self.run(owner, &job_id, job, move |o| match o {
            Err(f) => {
                me.release_target(owner, &out, false);
                r.reply(Ok(f))
            }
            Ok(value) => {
                me.release_target(owner, &out, true);
                if let Some(h) = as_str(field(&value, "docHash")) {
                    me.know(owner, h);
                }
                r.reply(Ok(shape(value)))
            }
        })
    }

    fn convert(&self, owner: ViewId, req: IpcValue, r: Responder) {
        let Some(job_id) = job_id_of(&req) else {
            return r.reply(Ok(fail("invalid-request", "bad job id")));
        };
        let src = match self.source_of(owner, &req) {
            Ok(s) => s,
            Err(f) => return r.reply(Ok(f)),
        };
        let format = match as_str(field(&req, "format")) {
            Some(f @ ("md" | "epub")) => f.to_owned(),
            _ => return r.reply(Ok(fail("invalid-request", "bad format"))),
        };
        let Ok(translation) = translation_of(field(&req, "translation")) else {
            return r.reply(Ok(fail("invalid-request", "bad translation")));
        };
        let mut epub = None;
        if format == "epub" {
            match epub_options_of(field(&req, "epub")) {
                Some(e) => epub = Some(e),
                None => return r.reply(Ok(fail("invalid-request", "bad EPUB options"))),
            }
        }
        let out = match self.claim_target(owner, &src.path, field(&req, "outPath"), &format) {
            Ok(o) => o,
            Err(f) => return r.reply(Ok(f)),
        };
        let me = self.clone();
        self.cached_tree(owner, &src.path, &src.pages_key.clone(), move |hit| {
            let op = if epub.is_some() { "epub" } else { "markdown" };
            let mut job = vec![
                ("op".to_owned(), op.into_ipc()),
                ("source".to_owned(), src.job),
                ("outPath".to_owned(), out.clone().into_ipc()),
            ];
            if let Some(hit) = hit {
                job.push(("tree".to_owned(), hit.tree));
            }
            if let Some(t) = translation {
                job.push(("translation".to_owned(), t));
            }
            let is_epub = epub.is_some();
            if let Some(e) = epub {
                job.push(("epub".to_owned(), e));
            }
            me.run_writing(
                owner,
                job_id,
                IpcValue::Object(job),
                out,
                move |value| {
                    let v = ok_with(value);
                    if is_epub {
                        let v = with(v, "warnings", IpcValue::Array(Vec::new()));
                        let v = with(v, "assetsWritten", 0.0.into_ipc());
                        with(v, "assetsReused", 0.0.into_ipc())
                    } else {
                        v
                    }
                },
                r,
            )
        })
    }

    fn extract_images(&self, owner: ViewId, req: IpcValue, r: Responder) {
        let Some(job_id) = job_id_of(&req) else {
            return r.reply(Ok(fail("invalid-request", "bad job id")));
        };
        let src = match self.source_of(owner, &req) {
            Ok(s) => s,
            Err(f) => return r.reply(Ok(f)),
        };
        let base_name = field(&req, "baseName");
        if !opt_text(base_name, 200) {
            return r.reply(Ok(fail("invalid-request", "bad base name")));
        }
        let min = field(&req, "minImagePx");
        if min != &IpcValue::Undefined
            && !safe_int(min).is_some_and(|m| (1.0..=10_000.0).contains(&m))
        {
            return r.reply(Ok(fail("invalid-request", "bad minimum image size")));
        }
        let out = match self.claim_target(owner, &src.path, field(&req, "outDir"), "folder") {
            Ok(o) => o,
            Err(f) => return r.reply(Ok(f)),
        };
        let base = match as_str(base_name).filter(|b| !b.is_empty()) {
            Some(b) => b.to_owned(),
            None => basename(&src.path, Some(&extname(&src.path))),
        };
        let mut job = vec![
            ("op".to_owned(), "images".into_ipc()),
            ("source".to_owned(), src.job),
            ("outDir".to_owned(), out.clone().into_ipc()),
            ("baseName".to_owned(), base.into_ipc()),
        ];
        if min != &IpcValue::Undefined {
            job.push(("minImagePx".to_owned(), min.clone()));
        }
        self.run_writing(owner, job_id, IpcValue::Object(job), out, ok_with, r)
    }

    fn write_back(&self, owner: ViewId, req: IpcValue, r: Responder) {
        let Some(job_id) = job_id_of(&req) else {
            return r.reply(Ok(fail("invalid-request", "bad job id")));
        };
        let src = match self.source_of(owner, &req) {
            Ok(s) => s,
            Err(f) => return r.reply(Ok(f)),
        };
        let out = match self.claim_target(owner, &src.path, field(&req, "outPath"), "pdf") {
            Ok(o) => o,
            Err(f) => return r.reply(Ok(f)),
        };
        let Some(payload) = write_back_payload_of(field(&req, "payload")) else {
            self.release_target(owner, &out, false);
            return r.reply(Ok(fail("invalid-request", "bad translated PDF payload")));
        };
        let me = self.clone();
        self.cached_tree(owner, &src.path, &src.pages_key.clone(), move |hit| {
            let mut job = vec![
                ("op".to_owned(), "writeBack".into_ipc()),
                ("source".to_owned(), src.job),
            ];
            if let Some(hit) = hit {
                job.push(("tree".to_owned(), hit.tree));
            }
            job.push(("outPath".to_owned(), out.clone().into_ipc()));
            job.push(("payload".to_owned(), payload));
            me.run_writing(owner, job_id, IpcValue::Object(job), out, ok_with, r)
        })
    }

    /// A store call for a known document hash, on a worker
    fn store<W>(&self, r: Responder, work: W)
    where
        W: FnOnce(&dyn PdfToolsEngine, PathBuf) -> Result<IpcValue, StoreError> + Send + 'static,
    {
        let engine = self.ctx.engine.clone();
        let dir = self.ctx.services.paths.path(PathName::UserData);
        kit::on_worker(
            &self.ctx.services,
            move || work(&*engine, dir),
            move |answer| r.reply(Ok(answer.unwrap_or_else(store_failure))),
        )
    }

    fn store_doc_hash(&self, owner: ViewId, path: &IpcValue, r: Responder) {
        let path = match as_str(path) {
            Some(p) if self.granted(owner, p) => p.to_owned(),
            _ => {
                return r.reply(Ok(fail(
                    "not-granted",
                    "pdf: path not granted to this view",
                )));
            }
        };
        let me = self.clone();
        self.hash_file(path, move |h| match h {
            Ok(h) => {
                me.know(owner, &h);
                r.reply(Ok(obj([
                    ("ok", true.into_ipc()),
                    ("docHash", h.into_ipc()),
                ])))
            }
            Err(m) => r.reply(Ok(fail("failed", &m))),
        })
    }

    /// `storeWrite(owner, req)`: the call to make, or why not
    fn store_write(&self, owner: ViewId, req: &IpcValue, r: Responder) {
        if !is_record(req) {
            return r.reply(Ok(fail("invalid-request", "request must be an object")));
        }
        let Some(doc_hash) = self.knows(owner, field(req, "docHash")) else {
            return r.reply(Ok(fail("not-granted", "unknown document hash")));
        };
        // only the translation writes and the heartbeat name a mode
        let Some(mode) = mode_of(field(req, "mode")) else {
            return r.reply(Ok(fail("invalid-request", "bad mode")));
        };
        let Some((method, args, answer)) = write_plan(req, &doc_hash, mode) else {
            return r.reply(Ok(fail("invalid-request", "bad store write")));
        };
        self.store(r, move |engine, dir| {
            let got = engine.store(dir, method, args)?;
            Ok(match answer {
                WriteAnswer::Ok => obj([("ok", true.into_ipc())]),
                WriteAnswer::Removed => obj([("ok", true.into_ipc()), ("removed", got)]),
                WriteAnswer::Found(message) => {
                    if truthy(&got) {
                        obj([("ok", true.into_ipc())])
                    } else {
                        fail("failed", message)
                    }
                }
            })
        })
    }

    fn store_translation_recency(
        engine: &dyn PdfToolsEngine,
        dir: PathBuf,
        doc_hash: String,
        mode: &str,
    ) -> Result<IpcValue, StoreError> {
        let mut args = vec![doc_hash.clone().into_ipc()];
        args.extend(mode_args(mode));
        let langs = engine.store(dir.clone(), StoreMethod::ListTranslations, args)?;
        let mut out: Vec<(IpcValue, Option<f64>)> = Vec::new();
        for lang in iter(&langs) {
            let mut args = vec![doc_hash.clone().into_ipc(), lang.clone()];
            args.extend(mode_args(mode));
            let stored = engine.store(dir.clone(), StoreMethod::ReadTranslation, args)?;
            let mut saved: Option<f64> = None;
            for b in iter(field(&stored, "blocks")) {
                let at = as_num(field(b, "savedAt")).unwrap_or(f64::NAN);
                if saved.is_none_or(|s| at > s) {
                    saved = Some(at);
                }
            }
            out.push((lang.clone(), saved));
        }
        // newest first; languages without a block last
        out.sort_by(|a, b| {
            let (x, y) = (
                b.1.unwrap_or(f64::NEG_INFINITY),
                a.1.unwrap_or(f64::NEG_INFINITY),
            );
            (x - y)
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(obj([
            ("ok", true.into_ipc()),
            (
                "langs",
                IpcValue::Array(
                    out.into_iter()
                        .map(|(lang, saved)| obj([("lang", lang), ("savedAt", saved.into_ipc())]))
                        .collect(),
                ),
            ),
        ]))
    }

    /// `storePageFingerprints(ctx, req)`
    fn store_page_fingerprints(&self, owner: ViewId, req: &IpcValue, r: Responder) {
        if !is_record(req) {
            return r.reply(Ok(fail("invalid-request", "request must be an object")));
        }
        let req = obj([
            ("path", field(req, "path").clone()),
            ("password", field(req, "password").clone()),
        ]);
        let src = match self.source_of(owner, &req) {
            Ok(s) => s,
            Err(f) => return r.reply(Ok(f)),
        };
        let me = self.clone();
        self.hash_file(src.path.clone(), move |h| {
            let doc_hash = match h {
                Ok(h) => h,
                Err(m) => return r.reply(Ok(fail("failed", &m))),
            };
            me.know(owner, &doc_hash);
            let answer = |doc_hash: String, fingerprints: Vec<String>| {
                obj([
                    ("ok", true.into_ipc()),
                    ("docHash", doc_hash.into_ipc()),
                    ("fingerprints", fingerprints.into_ipc()),
                ])
            };
            let cached = me.s.borrow().fingerprints.get(&owner).cloned();
            if let Some((h, f)) = cached.filter(|(h, _)| *h == doc_hash) {
                return r.reply(Ok(answer(h, f)));
            }
            let tree = me.s.borrow().trees.get(&owner).cloned();
            if let Some(tree) = tree.filter(|t| t.doc_hash == doc_hash && t.pages_key == "all") {
                let mut pages: Vec<&IpcValue> = iter(&tree.fingerprints).collect();
                pages.sort_by(|a, b| {
                    let page = |v: &IpcValue| as_num(field(v, "page")).unwrap_or(f64::NAN);
                    (page(a) - page(b))
                        .partial_cmp(&0.0)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                let fingerprints: Vec<String> = pages
                    .iter()
                    .map(|f| as_str(field(f, "fingerprint")).unwrap_or("").to_owned())
                    .collect();
                me.s.borrow_mut()
                    .fingerprints
                    .insert(owner, (doc_hash.clone(), fingerprints.clone()));
                return r.reply(Ok(answer(doc_hash, fingerprints)));
            }
            let id = {
                let mut s = me.s.borrow_mut();
                s.internal_jobs += 1;
                format!("_fingerprints-{}", s.internal_jobs)
            };
            let job = obj([("op", "fingerprints".into_ipc()), ("source", src.job)]);
            let me2 = me.clone();
            me.ctx
                .runner
                .run(&me.ctx, owner, &id, job, None, move |o| match o {
                    Err(f) => r.reply(Ok(failure(f))),
                    Ok(value) => {
                        // the file changed again while it was read: answer what was read
                        let h = as_str(field(&value, "docHash")).unwrap_or("").to_owned();
                        let f: Vec<String> = iter(field(&value, "fingerprints"))
                            .map(|f| as_str(f).unwrap_or("").to_owned())
                            .collect();
                        me2.know(owner, &h);
                        me2.s
                            .borrow_mut()
                            .fingerprints
                            .insert(owner, (h.clone(), f.clone()));
                        r.reply(Ok(answer(h, f)))
                    }
                })
        })
    }

    /// `storeMigrate(ctx, req)`
    fn store_migrate(&self, owner: ViewId, req: &IpcValue, r: Responder) {
        if !is_record(req) {
            return r.reply(Ok(fail("invalid-request", "request must be an object")));
        }
        let Some(old) = self.knows(owner, field(req, "oldDocHash")) else {
            return r.reply(Ok(fail("not-granted", "unknown document hash")));
        };
        let req = obj([
            ("path", field(req, "path").clone()),
            ("password", field(req, "password").clone()),
        ]);
        let src = match self.source_of(owner, &req) {
            Ok(s) => s,
            Err(f) => return r.reply(Ok(f)),
        };
        let me = self.clone();
        self.hash_file(src.path.clone(), move |h| {
            let new = match h {
                Ok(h) => h,
                Err(m) => return r.reply(Ok(fail("failed", &m))),
            };
            me.know(owner, &new);
            if new == old {
                return r.reply(Ok(obj([
                    ("ok", true.into_ipc()),
                    ("docHash", new.into_ipc()),
                    ("aiReadPages", 0.0.into_ipc()),
                    ("translationBlocks", 0.0.into_ipc()),
                    ("languages", IpcValue::Array(Vec::new())),
                    ("jobs", 0.0.into_ipc()),
                ])));
            }
            let id = {
                let mut s = me.s.borrow_mut();
                s.internal_jobs += 1;
                format!("_migrate-{}", s.internal_jobs)
            };
            let job = obj([("op", "fingerprints".into_ipc()), ("source", src.job)]);
            let me2 = me.clone();
            me.ctx.runner.run(&me.ctx, owner, &id, job, None, move |o| {
                let value = match o {
                    Ok(v) => v,
                    Err(f) => return r.reply(Ok(failure(f))),
                };
                // the file changed again while it was read: migrate to what was read
                let new = as_str(field(&value, "docHash")).unwrap_or("").to_owned();
                me2.know(owner, &new);
                let fingerprints = field(&value, "fingerprints").clone();
                me2.store(r, move |engine, dir| {
                    let moved = engine.store(
                        dir.clone(),
                        StoreMethod::MigrateDocument,
                        vec![obj([
                            ("oldDocHash", old.clone().into_ipc()),
                            ("newDocHash", new.clone().into_ipc()),
                            ("pageFingerprints", fingerprints),
                        ])],
                    )?;
                    let jobs = migrate_job_records(engine, &dir, &old, &new)?;
                    let out = ok_with(obj([("docHash", new.into_ipc())]));
                    let mut out = match (out, moved) {
                        (IpcValue::Object(mut o), IpcValue::Object(m)) => {
                            o.extend(m);
                            IpcValue::Object(o)
                        }
                        (o, _) => o,
                    };
                    out = with(out, "jobs", (jobs as f64).into_ipc());
                    Ok(out)
                })
            })
        })
    }

    pub fn entries(&self) -> Vec<Entry> {
        let mut out = Vec::new();
        let me = self.clone();
        out.push(kit::invoke("pdf:structure-pick-target", move |cx, args| {
            Ok(me.pick_target(cx.sender.view, args.get(0)))
        }));
        type Job = fn(&Structure, ViewId, IpcValue, Responder);
        let jobs: [(&'static str, Job); 5] = [
            ("pdf:structure-tree", Structure::tree),
            ("pdf:structure-text", Structure::text),
            ("pdf:structure-convert", Structure::convert),
            ("pdf:structure-extract-images", Structure::extract_images),
            ("pdf:structure-write-back", Structure::write_back),
        ];
        for (channel, f) in jobs {
            let me = self.clone();
            out.push(kit::invoke_later(channel, move |cx, mut args, r| {
                f(&me, cx.sender.view, args.take(0), r)
            }));
        }
        let me = self.clone();
        out.push(kit::invoke("pdf:structure-cancel", move |cx, args| {
            Ok(args
                .str(0)
                .is_some_and(|id| is_job_id(id) && me.ctx.runner.cancel(cx.sender.view, id))
                .into_ipc())
        }));
        let me = self.clone();
        out.push(kit::invoke_later(
            "pdf:store-doc-hash",
            move |cx, args, r| me.store_doc_hash(cx.sender.view, args.get(0), r),
        ));
        let me = self.clone();
        out.push(kit::invoke_later("pdf:store-write", move |cx, args, r| {
            me.store_write(cx.sender.view, args.get(0), r)
        }));
        let me = self.clone();
        out.push(kit::invoke_later(
            "pdf:store-migrate",
            move |cx, args, r| me.store_migrate(cx.sender.view, args.get(0), r),
        ));
        let me = self.clone();
        out.push(kit::invoke_later(
            "pdf:store-page-fingerprints",
            move |cx, args, r| me.store_page_fingerprints(cx.sender.view, args.get(0), r),
        ));
        // the reads that take a known document hash and one call's arguments
        type Read = fn(&Args, String) -> Result<Reader, IpcValue>;
        let reads: [(&'static str, Read); 11] = [
            ("pdf:store-ai-read-pages", read_ai_read_pages),
            ("pdf:store-translations", read_translations),
            ("pdf:store-translation", read_translation),
            ("pdf:store-unfinished-jobs", read_unfinished_jobs),
            ("pdf:store-delete-document", read_delete_document),
            ("pdf:store-passages", read_passages),
            ("pdf:store-highlight-runs", read_highlight_runs),
            ("pdf:store-highlight-blocks", read_highlight_blocks),
            ("pdf:store-latest-highlight", read_latest_highlight),
            ("pdf:store-insights", read_insights),
            ("pdf:store-delete-counts", read_delete_counts),
        ];
        for (channel, f) in reads.into_iter().chain([(
            "pdf:store-translation-recency",
            read_translation_recency as Read,
        )]) {
            let me = self.clone();
            out.push(kit::invoke_later(channel, move |cx, args, r| {
                let Some(doc_hash) = me.knows(cx.sender.view, args.get(0)) else {
                    return r.reply(Ok(fail("not-granted", "unknown document hash")));
                };
                match f(&args, doc_hash) {
                    Err(f) => r.reply(Ok(f)),
                    Ok(reader) => me.store(r, reader),
                }
            }));
        }
        out
    }
}

/// A store read, run on a worker
type Reader = Box<dyn FnOnce(&dyn PdfToolsEngine, PathBuf) -> Result<IpcValue, StoreError> + Send>;

fn iter(v: &IpcValue) -> impl Iterator<Item = &IpcValue> {
    match v {
        IpcValue::Array(items) => items.iter(),
        _ => [].iter(),
    }
}

fn ok_field(key: &'static str, v: IpcValue) -> IpcValue {
    obj([("ok", true.into_ipc()), (key, v)])
}

fn read_ai_read_pages(_: &Args, doc_hash: String) -> Result<Reader, IpcValue> {
    Ok(Box::new(move |e, dir| {
        Ok(ok_field(
            "pages",
            e.store(dir, StoreMethod::ReadAiReadPages, vec![doc_hash.into_ipc()])?,
        ))
    }))
}

fn read_translations(args: &Args, doc_hash: String) -> Result<Reader, IpcValue> {
    let mode = mode_of(args.get(1)).ok_or_else(|| fail("invalid-request", "bad mode"))?;
    let mut call = vec![doc_hash.into_ipc()];
    call.extend(mode_args(mode));
    Ok(Box::new(move |e, dir| {
        Ok(ok_field(
            "langs",
            e.store(dir, StoreMethod::ListTranslations, call)?,
        ))
    }))
}

fn read_translation(args: &Args, doc_hash: String) -> Result<Reader, IpcValue> {
    let lang = args.get(1).clone();
    if !is_key(&lang) {
        return Err(fail("invalid-request", "bad language"));
    }
    let mode = mode_of(args.get(2)).ok_or_else(|| fail("invalid-request", "bad mode"))?;
    let mut call = vec![doc_hash.into_ipc(), lang];
    call.extend(mode_args(mode));
    Ok(Box::new(move |e, dir| {
        let stored = e.store(dir, StoreMethod::ReadTranslation, call)?;
        Ok(ok_field(
            "translation",
            if truthy(&stored) {
                stored
            } else {
                IpcValue::Null
            },
        ))
    }))
}

fn read_unfinished_jobs(_: &Args, doc_hash: String) -> Result<Reader, IpcValue> {
    Ok(Box::new(move |e, dir| {
        Ok(ok_field(
            "jobs",
            e.store(dir, StoreMethod::UnfinishedJobs, vec![doc_hash.into_ipc()])?,
        ))
    }))
}

fn read_delete_document(_: &Args, doc_hash: String) -> Result<Reader, IpcValue> {
    Ok(Box::new(move |e, dir| {
        // a cached tree is not a store entry; it stays valid for the same bytes
        e.store(dir, StoreMethod::DeleteDocument, vec![doc_hash.into_ipc()])?;
        Ok(obj([("ok", true.into_ipc())]))
    }))
}

fn read_passages(_: &Args, doc_hash: String) -> Result<Reader, IpcValue> {
    Ok(Box::new(move |e, dir| {
        Ok(ok_field(
            "cards",
            e.store(dir, StoreMethod::ReadPassages, vec![doc_hash.into_ipc()])?,
        ))
    }))
}

fn read_highlight_runs(_: &Args, doc_hash: String) -> Result<Reader, IpcValue> {
    Ok(Box::new(move |e, dir| {
        let runs = e.store(
            dir,
            StoreMethod::ListHighlightRuns,
            vec![doc_hash.into_ipc()],
        )?;
        Ok(ok_field("runs", IpcValue::Array(newest_first(runs))))
    }))
}

fn read_highlight_blocks(args: &Args, doc_hash: String) -> Result<Reader, IpcValue> {
    let run_id = args.get(1).clone();
    if !is_key(&run_id) {
        return Err(fail("invalid-request", "bad run id"));
    }
    Ok(Box::new(move |e, dir| {
        let blocks = e.store(
            dir,
            StoreMethod::ReadHighlightBlocks,
            vec![doc_hash.into_ipc(), run_id],
        )?;
        Ok(ok_field("blocks", blocks))
    }))
}

fn read_latest_highlight(_: &Args, doc_hash: String) -> Result<Reader, IpcValue> {
    Ok(Box::new(move |e, dir| {
        let runs = e.store(
            dir.clone(),
            StoreMethod::ListHighlightRuns,
            vec![doc_hash.clone().into_ipc()],
        )?;
        let run = newest_first(runs).into_iter().next();
        let blocks = match &run {
            Some(run) => e.store(
                dir,
                StoreMethod::ReadHighlightBlocks,
                vec![doc_hash.into_ipc(), field(run, "runId").clone()],
            )?,
            None => IpcValue::Array(Vec::new()),
        };
        Ok(obj([
            ("ok", true.into_ipc()),
            ("run", run.unwrap_or(IpcValue::Null)),
            ("blocks", blocks),
        ]))
    }))
}

fn read_insights(args: &Args, doc_hash: String) -> Result<Reader, IpcValue> {
    let lang = args.get(1).clone();
    if !is_key(&lang) {
        return Err(fail("invalid-request", "bad language"));
    }
    Ok(Box::new(move |e, dir| {
        Ok(ok_field(
            "insights",
            e.store(
                dir,
                StoreMethod::ReadInsights,
                vec![doc_hash.into_ipc(), lang],
            )?,
        ))
    }))
}

fn read_delete_counts(_: &Args, doc_hash: String) -> Result<Reader, IpcValue> {
    Ok(Box::new(move |e, dir| {
        let h = || doc_hash.clone().into_ipc();
        // the easy explanations' edits are lost with the document too
        let plain = e.store(
            dir.clone(),
            StoreMethod::CountEditedTranslationBlocks,
            vec![h()],
        )?;
        let easy = e.store(
            dir.clone(),
            StoreMethod::CountEditedTranslationBlocks,
            vec![h(), IpcValue::Undefined, "easy".into_ipc()],
        )?;
        let passages = e.store(dir, StoreMethod::CountPassages, vec![h()])?;
        Ok(obj([
            ("ok", true.into_ipc()),
            (
                "editedTranslationBlocks",
                (as_num(&plain).unwrap_or(f64::NAN) + as_num(&easy).unwrap_or(f64::NAN)).into_ipc(),
            ),
            ("passages", passages),
        ]))
    }))
}

fn read_translation_recency(args: &Args, doc_hash: String) -> Result<Reader, IpcValue> {
    let mode = mode_of(args.get(1)).ok_or_else(|| fail("invalid-request", "bad mode"))?;
    Ok(Box::new(move |e, dir| {
        Structure::store_translation_recency(e, dir, doc_hash, mode)
    }))
}

/// What a store write answers
enum WriteAnswer {
    Ok,
    /// `{ ok: true, removed }`
    Removed,
    /// `ok` when the store found what it was to change, else this failure message
    Found(&'static str),
}

/// The `switch (req.kind)` of `storeWrite`: the store call, or `None` for a
/// request that fails its checks (`bad store write`)
fn write_plan(
    req: &IpcValue,
    doc_hash: &str,
    mode: &str,
) -> Option<(StoreMethod, Vec<IpcValue>, WriteAnswer)> {
    use StoreMethod::*;
    let f = |k: &str| field(req, k).clone();
    let h = doc_hash.into_ipc();
    let with_mode = |mut args: Vec<IpcValue>| {
        args.extend(mode_args(mode));
        args
    };
    Some(match as_str(field(req, "kind"))? {
        "aiReadPage" => {
            if !opt_text(field(req, "provider"), 200) || !opt_text(field(req, "model"), 200) {
                return None;
            }
            let mut meta = Vec::new();
            for k in ["provider", "model"] {
                if field(req, k) != &IpcValue::Undefined {
                    meta.push((k.to_owned(), f(k)));
                }
            }
            (
                WriteAiReadPage,
                vec![
                    h,
                    f("pageFingerprint"),
                    f("payload"),
                    IpcValue::Object(meta),
                ],
                WriteAnswer::Ok,
            )
        }
        "translationMeta" => (
            WriteTranslationMeta,
            with_mode(vec![
                h,
                f("lang"),
                obj([("provider", f("provider")), ("model", f("model"))]),
            ]),
            WriteAnswer::Ok,
        ),
        "translationBlocks" => {
            let IpcValue::Array(blocks) = field(req, "blocks") else {
                return None;
            };
            if !blocks.iter().all(is_record) {
                return None;
            }
            (
                WriteTranslationBlocks,
                with_mode(vec![h, f("lang"), f("blocks")]),
                WriteAnswer::Ok,
            )
        }
        "deleteTranslation" => (
            DeleteTranslation,
            with_mode(vec![h, f("lang")]),
            WriteAnswer::Ok,
        ),
        "job" => {
            if !is_record(field(req, "job")) {
                return None;
            }
            (WriteJob, vec![h, f("job")], WriteAnswer::Ok)
        }
        "heartbeat" => {
            let kind = as_str(field(req, "job")).filter(|k| JOB_KINDS.contains(k))?;
            if !opt_text(field(req, "lang"), 128) || !opt_text(field(req, "runId"), 128) {
                return None;
            }
            let key = job_key_of(
                kind,
                as_str(field(req, "lang")),
                as_str(field(req, "runId")),
            );
            (
                HeartbeatJob,
                with_mode(vec![
                    h,
                    kind.into_ipc(),
                    key.map_or(IpcValue::Undefined, IntoIpc::into_ipc),
                ]),
                WriteAnswer::Found("no running job record"),
            )
        }
        "passage" => {
            if !is_record(field(req, "card")) {
                return None;
            }
            (WritePassage, vec![h, f("card")], WriteAnswer::Ok)
        }
        "deletePassage" => {
            if !is_key(field(req, "id")) {
                return None;
            }
            (DeletePassage, vec![h, f("id")], WriteAnswer::Ok)
        }
        "highlightRun" => {
            if !is_record(field(req, "run")) {
                return None;
            }
            (WriteHighlightRun, vec![h, f("run")], WriteAnswer::Ok)
        }
        "highlightBlocks" => {
            if !is_key(field(req, "runId")) {
                return None;
            }
            let IpcValue::Array(blocks) = field(req, "blocks") else {
                return None;
            };
            if !blocks
                .iter()
                .all(|b| is_record(b) && block_key_of(field(b, "key")).is_some())
            {
                return None;
            }
            (
                WriteHighlightBlocks,
                vec![h, f("runId"), f("blocks")],
                WriteAnswer::Ok,
            )
        }
        "highlightSuggestionStates" => {
            let key = block_key_of(field(req, "key"));
            let states = suggestion_states_of(field(req, "states"));
            if !is_key(field(req, "runId")) {
                return None;
            }
            (
                SetHighlightSuggestionStates,
                vec![h, f("runId"), key?, states?],
                WriteAnswer::Found("no such highlight block"),
            )
        }
        "deleteHighlightRun" => {
            if !is_key(field(req, "runId")) {
                return None;
            }
            (DeleteHighlightRun, vec![h, f("runId")], WriteAnswer::Ok)
        }
        "insights" => {
            if !is_record(field(req, "entry")) {
                return None;
            }
            (WriteInsights, vec![h, f("entry")], WriteAnswer::Ok)
        }
        "editedTranslationBlock" => {
            let key = block_key_of(field(req, "key"));
            if !is_key(field(req, "lang")) {
                return None;
            }
            let key = key?;
            if !as_str(field(req, "text")).is_some_and(|t| js_len(t) <= MAX_EDITED_TEXT) {
                return None;
            }
            (
                WriteEditedTranslationBlock,
                with_mode(vec![h, f("lang"), key, f("text")]),
                WriteAnswer::Ok,
            )
        }
        "deleteTranslationExceptEdited" => {
            if !is_key(field(req, "lang")) {
                return None;
            }
            (
                DeleteTranslationExceptEdited,
                with_mode(vec![h, f("lang")]),
                WriteAnswer::Removed,
            )
        }
        _ => return None,
    })
}

/// `recordOf(job)` of job-migration.ts
fn record_of(job: &IpcValue) -> IpcValue {
    let state = match field(job, "state") {
        IpcValue::String(s) if s == "idle" => "stopped".into_ipc(),
        other => other.clone(),
    };
    let mut out = vec![
        ("kind".to_owned(), field(job, "kind").clone()),
        ("state".to_owned(), state),
        ("outputs".to_owned(), field(job, "outputs").clone()),
    ];
    for k in ["lang", "runId"] {
        if field(job, k) != &IpcValue::Undefined {
            out.push((k.to_owned(), field(job, k).clone()));
        }
    }
    if as_str(field(job, "mode")) == Some("easy") {
        out.push(("mode".to_owned(), "easy".into_ipc()));
    }
    for k in ["last_error", "resetsAt", "progress"] {
        if field(job, k) != &IpcValue::Undefined {
            out.push((k.to_owned(), field(job, k).clone()));
        }
    }
    IpcValue::Object(out)
}

/// `migrateJobRecords(store, oldDocHash, newDocHash)`: carry job records to
/// the new document hash; a record already there wins when at least as recent
fn migrate_job_records(
    engine: &dyn PdfToolsEngine,
    dir: &std::path::Path,
    old: &str,
    new: &str,
) -> Result<usize, StoreError> {
    if old == new {
        return Ok(0);
    }
    let dir = || dir.to_path_buf();
    let mut moved = 0;
    for job in iter(&engine.store(dir(), StoreMethod::ListJobs, vec![old.into_ipc()])?) {
        let kind = field(job, "kind").clone();
        let key = job_key_of(
            as_str(&kind).unwrap_or(""),
            as_str(field(job, "lang")),
            as_str(field(job, "runId")),
        )
        .map_or(IpcValue::Undefined, IntoIpc::into_ipc);
        let mode = if as_str(field(job, "mode")) == Some("easy") {
            "easy"
        } else {
            "translate"
        };
        let read = |hash: &str| {
            engine.store(
                dir(),
                StoreMethod::ReadJob,
                vec![hash.into_ipc(), kind.clone(), key.clone(), mode.into_ipc()],
            )
        };
        let updated = |j: &IpcValue| as_num(field(j, "updatedAt")).unwrap_or(0.0);
        let current = read(new)?;
        if as_str(field(&current, "state")) != Some("idle") && updated(&current) >= updated(job) {
            continue;
        }
        // the copy is stamped with the time of the copy: a write the job made
        // while it was being copied is copied too
        let mut source = job.clone();
        for _ in 0..COPY_ATTEMPTS {
            engine.store(
                dir(),
                StoreMethod::WriteJob,
                vec![new.into_ipc(), record_of(&source)],
            )?;
            let again = read(old)?;
            if as_str(field(&again, "state")) == Some("idle")
                || field(&again, "updatedAt") == field(&source, "updatedAt")
            {
                break;
            }
            source = again;
        }
        moved += 1;
    }
    Ok(moved)
}

fn job_id_of(req: &IpcValue) -> Option<String> {
    if !is_record(req) {
        return None;
    }
    as_str(field(req, "jobId"))
        .filter(|id| is_job_id(id))
        .map(str::to_owned)
}

/// `translationOf(v)`: absent, a checked translation, or `Err` when malformed
fn translation_of(v: &IpcValue) -> Result<Option<IpcValue>, ()> {
    if v == &IpcValue::Undefined {
        return Ok(None);
    }
    if !is_record(v) || !is_key(field(v, "lang")) {
        return Err(());
    }
    if !matches!(field(v, "bilingual"), IpcValue::Bool(_)) {
        return Err(());
    }
    // no units: the job reads the stored translation of the file's document hash
    match field(v, "units") {
        IpcValue::Undefined => Ok(Some(obj([
            ("lang", field(v, "lang").clone()),
            ("bilingual", field(v, "bilingual").clone()),
        ]))),
        IpcValue::Array(units) => {
            let ok = units.iter().all(|u| {
                is_record(u)
                    && as_str(field(u, "key")).is_some()
                    && matches!(field(u, "runs"), IpcValue::Array(runs) if runs.iter().all(is_record))
            });
            if ok { Ok(Some(v.clone())) } else { Err(()) }
        }
        _ => Err(()),
    }
}

/// `writeBackPayloadOf(v)`: the target language and whether it is bilingual
fn write_back_payload_of(v: &IpcValue) -> Option<IpcValue> {
    if !is_record(v) || !as_str(field(v, "lang")).is_some_and(is_language_tag) {
        return None;
    }
    let bilingual = field(v, "bilingual");
    if bilingual != &IpcValue::Undefined && !matches!(bilingual, IpcValue::Bool(_)) {
        return None;
    }
    let mut out = vec![("lang".to_owned(), field(v, "lang").clone())];
    if bilingual == &IpcValue::Bool(true) {
        out.push(("bilingual".to_owned(), true.into_ipc()));
    }
    Some(IpcValue::Object(out))
}

/// `epubOptionsOf(v)`
fn epub_options_of(v: &IpcValue) -> Option<IpcValue> {
    if !is_record(v) || !as_str(field(v, "title")).is_some_and(|t| js_len(t) <= MAX_TEXT) {
        return None;
    }
    if !opt_text(field(v, "author"), MAX_TEXT) || !opt_text(field(v, "pageImageAlt"), 200) {
        return None;
    }
    for k in ["cover", "pageBreaks"] {
        if !matches!(field(v, k), IpcValue::Undefined | IpcValue::Bool(_)) {
            return None;
        }
    }
    for k in ["language", "uiLanguage"] {
        let tag = field(v, k);
        if tag != &IpcValue::Undefined && !as_str(tag).is_some_and(is_language_tag) {
            return None;
        }
    }
    let mut out = vec![("title".to_owned(), field(v, "title").clone())];
    for k in [
        "author",
        "cover",
        "language",
        "uiLanguage",
        "pageImageAlt",
        "pageBreaks",
    ] {
        if field(v, k) != &IpcValue::Undefined {
            out.push((k.to_owned(), field(v, k).clone()));
        }
    }
    Some(IpcValue::Object(out))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use shell_contract::{IpcValue, ViewId};

    use super::super::test_support::*;
    use crate::kit::IntoIpc;
    use crate::testing::HostCall;

    fn tree_job(path: &str) -> IpcValue {
        v(json!({ "jobId": "j1", "path": path }))
    }

    #[test]
    fn a_tree_job_reads_only_a_granted_file_and_caches_by_bytes() {
        let tree_value = json!({ "value": {
            "docHash": "h", "fingerprints": [{ "page": 1, "fingerprint": "f1" }],
            "tree": { "blocks": [{ "kind": "image", "data": { "$u8": [1, 2] } }, { "kind": "text" }] }
        }, "progress": [[1, 2]] });
        let mut t = tools(json!({ "run_job": [tree_value] }));
        let pdf = t.pdf_view(5);
        let path = t.file("a.pdf", b"%PDF");
        assert_eq!(
            j(&t.call("pdf:structure-tree", pdf, vec![tree_job(&path)])),
            json!({ "ok": false, "error": "not-granted", "message": "pdf: path not granted to this view" })
        );
        t.grant(5, &path);
        assert_eq!(
            j(&t.call(
                "pdf:structure-tree",
                pdf,
                vec![v(json!({ "jobId": "bad id", "path": path }))]
            ))["message"],
            json!("bad job id")
        );
        let first = t.call("pdf:structure-tree", pdf, vec![tree_job(&path)]);
        assert_eq!(j(&first)["cached"], json!(false));
        // picture bytes left out unless asked for
        assert_eq!(j(&first)["tree"]["blocks"][0]["data"], json!({}));
        let events = t.rt.events();
        assert_eq!(events[0].channel, "pdf:structure-progress");
        assert_eq!(
            j(&events[0].args[0]),
            json!({ "jobId": "j1", "done": 1, "total": 2 })
        );
        // a cached tree answers only when the file's hash is its own
        let hash = main_core::markdown::fs_util::sha256_file(&path).unwrap();
        assert_ne!(hash, "h");
        let again = t.call("pdf:structure-tree", pdf, vec![tree_job(&path)]);
        assert_eq!(j(&again)["error"], json!("not-available"));
    }

    #[test]
    fn store_reads_need_a_hash_the_main_process_computed() {
        let mut t = tools(json!({
            "store.listTranslations": [["en", "ko"]],
            "store.listHighlightRuns": [[
                { "runId": "b", "createdAt": 1 }, { "runId": "A", "createdAt": 2 }, { "runId": "a", "createdAt": 1 }
            ]],
        }));
        let pdf = t.pdf_view(5);
        let path = t.file("a.pdf", b"%PDF-1");
        assert_eq!(
            j(&t.call("pdf:store-translations", pdf, vec!["x".into_ipc()])),
            json!({ "ok": false, "error": "not-granted", "message": "unknown document hash" })
        );
        t.grant(5, &path);
        let hash =
            j(&t.call("pdf:store-doc-hash", pdf, vec![path.clone().into_ipc()]))["docHash"].clone();
        let h = hash.as_str().unwrap().into_ipc();
        assert_eq!(
            j(&t.call(
                "pdf:store-translations",
                pdf,
                vec![h.clone(), "odd".into_ipc()]
            ))["message"],
            json!("bad mode")
        );
        assert_eq!(
            j(&t.call(
                "pdf:store-translations",
                pdf,
                vec![h.clone(), "easy".into_ipc()]
            )),
            json!({ "ok": true, "langs": ["en", "ko"] })
        );
        assert_eq!(
            t.fake.called("store.listTranslations")[0]["args"],
            json!([hash, "easy"])
        );
        assert_eq!(
            j(&t.call("pdf:store-highlight-runs", pdf, vec![h.clone()]))["runs"],
            json!([{ "runId": "A", "createdAt": 2 }, { "runId": "a", "createdAt": 1 }, { "runId": "b", "createdAt": 1 }])
        );
        // another view does not know the hash
        let other = t.pdf_view(6);
        assert_eq!(
            j(&t.call("pdf:store-passages", other, vec![h.clone()]))["error"],
            json!("not-granted")
        );
        // a closed view forgets it
        t.rt.destroy(ViewId(5));
        let pdf = t.pdf_view(5);
        assert_eq!(
            j(&t.call("pdf:store-passages", pdf, vec![h]))["error"],
            json!("not-granted")
        );
    }

    #[test]
    fn ai_read_pages_are_the_stored_entries_of_a_known_hash() {
        let page = json!({ "fingerprint": "f1", "page": 1, "blocks": [] });
        let mut t = tools(json!({
            "store.readAiReadPages": [[page], { "$error": "other", "message": "disk gone" }],
        }));
        let pdf = t.pdf_view(5);
        let path = t.file("a.pdf", b"%PDF-1");
        assert_eq!(
            j(&t.call("pdf:store-ai-read-pages", pdf, vec!["x".into_ipc()]))["error"],
            json!("not-granted")
        );
        assert!(t.fake.called("store.readAiReadPages").is_empty());
        t.grant(5, &path);
        let hash = j(&t.call("pdf:store-doc-hash", pdf, vec![path.into_ipc()]))["docHash"].clone();
        let h = hash.as_str().unwrap().into_ipc();
        assert_eq!(
            j(&t.call("pdf:store-ai-read-pages", pdf, vec![h.clone()])),
            json!({ "ok": true, "pages": [page] })
        );
        assert_eq!(
            t.fake.called("store.readAiReadPages")[0]["args"],
            json!([hash])
        );
        let failed = j(&t.call("pdf:store-ai-read-pages", pdf, vec![h.clone()]));
        assert_eq!(failed["ok"], json!(false));
        assert_eq!(failed["message"], json!("disk gone"));
        // nothing stored: an empty list
        assert_eq!(
            j(&t.call("pdf:store-ai-read-pages", pdf, vec![h])),
            json!({ "ok": true, "pages": [] })
        );
    }

    #[test]
    fn store_writes_check_their_fields_and_map_store_errors() {
        let mut t = tools(json!({
            "store.heartbeatJob": [false],
            "store.writeJob": [{ "$error": "write", "message": "disk full" }],
            "store.deleteTranslationExceptEdited": [3],
        }));
        let pdf = t.pdf_view(5);
        let path = t.file("a.pdf", b"x");
        t.grant(5, &path);
        let h = j(&t.call("pdf:store-doc-hash", pdf, vec![path.into_ipc()]))["docHash"].clone();
        let mut write = |req: serde_json::Value| {
            let mut req = req;
            req["docHash"] = h.clone();
            j(&t.call("pdf:store-write", pdf, vec![v(req)]))
        };
        assert_eq!(
            write(json!({ "kind": "deletePassage", "id": "a b" }))["message"],
            json!("bad store write")
        );
        assert_eq!(
            write(json!({ "kind": "job", "job": {}, "mode": 1 }))["message"],
            json!("bad mode")
        );
        assert_eq!(
            write(json!({ "kind": "heartbeat", "job": "translate", "lang": "en" })),
            json!({ "ok": false, "error": "failed", "message": "no running job record" })
        );
        assert_eq!(
            write(json!({ "kind": "job", "job": {} })),
            json!({ "ok": false, "error": "store-write-failed", "message": "disk full" })
        );
        assert_eq!(
            write(json!({ "kind": "deleteTranslationExceptEdited", "lang": "en", "mode": "easy" })),
            json!({ "ok": true, "removed": 3 })
        );
        assert_eq!(
            write(json!({ "kind": "highlightSuggestionStates", "runId": "r",
                "key": { "pageFingerprint": "p", "textHash": "t", "occurrence": 0, "extra": 1 },
                "states": { "s1": "accepted" } })),
            json!({ "ok": true })
        );
        let calls = t.fake.called("store.heartbeatJob");
        assert_eq!(
            calls[0]["args"].as_array().unwrap()[1..],
            [json!("translate"), json!("en")]
        );
        assert_eq!(
            t.fake.called("store.setHighlightSuggestionStates")[0]["args"][2],
            json!({ "pageFingerprint": "p", "textHash": "t", "occurrence": 0 })
        );
    }

    #[test]
    fn a_convert_writes_only_to_a_target_picked_for_its_view() {
        let mut t = tools(json!({
            "run_job": [{ "value": { "docHash": "h2", "outPath": "x" } }, { "error": "failed", "message": "boom" }]
        }));
        let pdf = t.pdf_view(5);
        let src = t.file("book.pdf", b"x");
        t.grant(5, &src);
        let out = t.rt.dir.join("book.epub").to_string_lossy().into_owned();
        let req = |out: &str| {
            v(
                json!({ "jobId": "c1", "path": src, "format": "epub", "outPath": out,
                      "epub": { "title": "T", "cover": true } }),
            )
        };
        assert_eq!(
            j(&t.call("pdf:structure-convert", pdf, vec![req(&out)]))["error"],
            json!("not-granted")
        );
        t.rt.script().save.push_back(Some(out.clone().into()));
        let picked = t.call(
            "pdf:structure-pick-target",
            pdf,
            vec![v(
                json!({ "kind": "epub", "path": src, "defaultName": "a:b" }),
            )],
        );
        assert_eq!(j(&picked), json!(out));
        let HostCall::Save(_, dialog) = t.rt.script().calls.last().cloned().unwrap() else {
            panic!()
        };
        assert_eq!(
            dialog.default_path.unwrap().file_name().unwrap(),
            "a_b.epub"
        );
        assert_eq!(
            j(&t.call("pdf:structure-convert", pdf, vec![req(&out)])),
            json!({ "ok": true, "docHash": "h2", "outPath": "x", "warnings": [], "assetsWritten": 0, "assetsReused": 0 })
        );
        assert_eq!(
            t.fake.called("run_job")[0]["epub"],
            json!({ "title": "T", "cover": true })
        );
        // a used target is consumed
        assert_eq!(
            j(&t.call("pdf:structure-convert", pdf, vec![req(&out)]))["error"],
            json!("not-granted")
        );
        // the store now knows the job's hash
        assert_eq!(
            j(&t.call("pdf:store-passages", pdf, vec!["h2".into_ipc()]))["ok"],
            json!(true)
        );
    }

    #[test]
    fn a_migration_moves_newer_job_records() {
        let mut t = tools(json!({
            "run_job": [{ "value": { "docHash": "new", "fingerprints": ["f"] } }],
            "store.migrateDocument": [{ "aiReadPages": 1, "translationBlocks": 2, "languages": ["en"] }],
            "store.listJobs": [[{ "kind": "translate", "lang": "en", "state": "idle", "outputs": [], "updatedAt": 5 }]],
            "store.readJob": [{ "state": "running", "updatedAt": 1 }, { "state": "idle" }],
        }));
        let pdf = t.pdf_view(5);
        let path = t.file("a.pdf", b"x");
        t.grant(5, &path);
        assert_eq!(
            j(&t.call(
                "pdf:store-migrate",
                pdf,
                vec![v(json!({ "oldDocHash": "old", "path": path }))]
            ))["error"],
            json!("not-granted")
        );
        let old =
            j(&t.call("pdf:store-doc-hash", pdf, vec![path.clone().into_ipc()]))["docHash"].clone();
        // same bytes: nothing moves
        assert_eq!(
            j(&t.call(
                "pdf:store-migrate",
                pdf,
                vec![v(json!({ "oldDocHash": old, "path": path }))]
            ))["jobs"],
            json!(0)
        );
        std::fs::write(&path, b"changed").unwrap();
        assert_eq!(
            j(&t.call(
                "pdf:store-migrate",
                pdf,
                vec![v(json!({ "oldDocHash": old, "path": path }))]
            )),
            json!({ "ok": true, "docHash": "new", "aiReadPages": 1, "translationBlocks": 2, "languages": ["en"], "jobs": 1 })
        );
        assert_eq!(
            t.fake.called("store.writeJob")[0]["args"][1],
            json!({ "kind": "translate", "state": "stopped", "outputs": [], "lang": "en" })
        );
    }

    #[test]
    fn page_fingerprints_answer_from_the_cache_for_the_same_bytes() {
        let mut t = tools(
            json!({ "run_job": [{ "value": { "docHash": "x", "fingerprints": ["a", "b"] } }] }),
        );
        let pdf = t.pdf_view(5);
        let path = t.file("a.pdf", b"x");
        t.grant(5, &path);
        let req = || vec![v(json!({ "path": path }))];
        assert_eq!(
            j(&t.call("pdf:store-page-fingerprints", pdf, req())),
            json!({ "ok": true, "docHash": "x", "fingerprints": ["a", "b"] })
        );
        // the job read other bytes than the file has now: the next call runs a job again
        assert_eq!(
            j(&t.call("pdf:store-page-fingerprints", pdf, req()))["error"],
            json!("not-available")
        );
        assert_eq!(t.fake.called("run_job").len(), 2);
    }

    #[test]
    fn save_as_grants_a_markdown_target_but_never_the_source() {
        let mut t = tools(json!({ "run_job": [{ "value": { "docHash": "h", "outPath": "o" } }] }));
        let pdf = t.pdf_view(5);
        let src = t.file("a.pdf", b"x");
        let tools = t.tools();
        let out = t.rt.dir.join("a.md").to_string_lossy().into_owned();
        assert!(!tools.grant_structure_target(ViewId(5), &src, &out, "md"));
        t.grant(5, &src);
        assert!(!tools.grant_structure_target(ViewId(5), &src, &src, "md"));
        assert!(!tools.grant_structure_target(ViewId(5), &src, &out, "epub"));
        assert!(tools.grant_structure_target(ViewId(5), &src, &out, "md"));
        let req = v(json!({ "jobId": "m", "path": src, "format": "md", "outPath": out }));
        assert_eq!(
            j(&t.call("pdf:structure-convert", pdf, vec![req])),
            json!({ "ok": true, "docHash": "h", "outPath": "o" })
        );
    }
}
