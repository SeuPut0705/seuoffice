//! `apps/pdf/src/main/note-link.ts`: the note of each PDF (reading-assist
//! spec 4.9, 5.4): one Markdown file per PDF, linked in the result store's
//! `note-links.json`.
//!
//! The service is `async` in the TypeScript; every dependency that waits is a
//! blocking call here. A call that is "in flight" is a call inside one of the
//! dependencies: [`NoteLinkService`] keeps its `busy` set in a `RefCell` and
//! its methods take `&self`, so a dependency (the save dialog) can ask the
//! service again and is told `busy`, as a second request while the first
//! waits is in JavaScript.
//!
//! `createNoteLinkService(deps)` is [`NoteLinkService::new`] with the
//! platform; the `deps` are passed to each call.

use super::font_locate::Platform;
use crate::node_fs::{NodeError, node_error};
use jscompat::node_path::{posix, win32};
use jscompat::{
    JsMap, JsonValue, encode_uri_component, is_js_space, js_regex, number_to_string, slice_utf16,
    trim,
};
use std::cell::RefCell;
use std::fs;
use std::io::Write;

const MAX_EXCERPT_CHARS: usize = 20_000;
const MAX_BODY_CHARS: usize = 200_000;
const MAX_HEADING_CHARS: usize = 200;
const MAX_TITLE_CHARS: f64 = 300.0;
const MAX_PAGE: f64 = 1_000_000.0;

/// `pathApi(platform)`: `win32` or `posix` of `node:path`
#[derive(Clone, Copy)]
enum Api {
    Posix,
    Win32,
}

impl Api {
    fn of(platform: Platform) -> Api {
        if platform == Platform::Win32 {
            Api::Win32
        } else {
            Api::Posix
        }
    }
    fn sep(self) -> &'static str {
        match self {
            Api::Posix => posix::SEP,
            Api::Win32 => win32::SEP,
        }
    }
    fn dirname(self, p: &str) -> String {
        match self {
            Api::Posix => posix::dirname(p),
            Api::Win32 => win32::dirname(p),
        }
    }
    fn basename(self, p: &str) -> String {
        match self {
            Api::Posix => posix::basename(p, None),
            Api::Win32 => win32::basename(p, None),
        }
    }
    fn resolve(self, p: &str) -> String {
        match self {
            Api::Posix => posix::resolve(&[p]),
            Api::Win32 => win32::resolve(&[p]),
        }
    }
    fn normalize(self, p: &str) -> String {
        match self {
            Api::Posix => posix::normalize(p),
            Api::Win32 => win32::normalize(p),
        }
    }
    fn is_absolute(self, p: &str) -> bool {
        match self {
            Api::Posix => posix::is_absolute(p),
            Api::Win32 => win32::is_absolute(p),
        }
    }
    fn relative(self, from: &str, to: &str) -> String {
        match self {
            Api::Posix => posix::relative(from, to),
            Api::Win32 => win32::relative(from, to),
        }
    }
    fn join(self, a: &str, b: &str) -> String {
        match self {
            Api::Posix => posix::join(&[a, b]),
            Api::Win32 => win32::join(&[a, b]),
        }
    }
    fn root(self, p: &str) -> String {
        match self {
            Api::Posix => posix::parse(p).root,
            Api::Win32 => win32::parse(p).root,
        }
    }
}

/// one link segment, percent-encoded (parentheses too: they would end a Markdown link)
fn encode_segment(segment: &str) -> String {
    encode_uri_component(segment)
        .replace('(', "%28")
        .replace(')', "%29")
}

/// a file:/// URL of an absolute path, every segment encoded except a drive letter
fn file_url(absolute: &str, platform: Platform) -> String {
    let p = Api::of(platform);
    let normalized = p.normalize(absolute);
    if platform == Platform::Win32 && normalized.starts_with("\\\\") {
        // UNC: \\server\share\dir\file -> file://server/share/dir/file
        let mut parts = normalized[2..].split('\\');
        let host = parts.next().unwrap_or_default();
        let rest: Vec<String> = parts.map(encode_segment).collect();
        return format!("file://{host}/{}", rest.join("/"));
    }
    let parts: Vec<&str> = normalized
        .split(p.sep())
        .enumerate()
        .filter(|(i, part)| !part.is_empty() || *i == 0)
        .map(|(_, part)| part)
        .collect();
    let drive = js_regex!(r"^[A-Za-z]:$");
    let encoded: Vec<String> = parts
        .into_iter()
        .map(|part| {
            if drive.test(part) {
                part.to_owned()
            } else {
                encode_segment(part)
            }
        })
        .collect();
    let joined = encoded.join("/");
    format!("file:///{}", joined.trim_start_matches('/'))
}

/// The link to the PDF as written in the note: the path relative to the note's
/// folder with `/` separators and encoded segments; a `file:///` URL when no
/// relative path exists (another drive).
pub fn pdf_link_from_note(note_path: &str, pdf_path: &str, platform: Platform) -> String {
    let p = Api::of(platform);
    let note_dir = p.dirname(&p.resolve(note_path));
    let pdf = p.resolve(pdf_path);
    let root_of = |path: &str| p.root(path).to_lowercase();
    if platform == Platform::Win32 && root_of(&note_dir) != root_of(&pdf) {
        return file_url(&pdf, platform);
    }
    let relative = p.relative(&note_dir, &pdf);
    if relative.is_empty() || p.is_absolute(&relative) {
        return file_url(&pdf, platform);
    }
    relative
        .split(p.sep())
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

/// Inserted text is document or model output: a Markdown image (`![...]`) or a
/// raw `<img>` tag in it would make the note's editor fetch a remote picture.
/// Both lose their meaning behind a backslash; one already escaped (an odd run
/// of backslashes before it) stays as it is.
fn without_images(text: &str) -> String {
    js_regex!(r"(\\*)(!\[|<img\b)", "gi").replace_all(text, |m| {
        let slashes = m.get(1).unwrap_or_default();
        let mark = m.get(2).unwrap_or_default();
        if slashes.len() % 2 == 1 {
            m.as_str().to_owned()
        } else {
            format!("{slashes}\\{mark}")
        }
    })
}

/// `PdfNoteInsertRequest`
#[derive(Debug, Clone, PartialEq)]
pub enum NoteInsertRequest {
    Quote {
        /// the marked text or passage ('' for an item without text)
        excerpt: String,
        /// 1-based page of the PDF file on disk
        page: f64,
        /// a memo, an AI answer; omitted when empty
        body: Option<String>,
        title: Option<String>,
    },
    Overview {
        heading: String,
        body: String,
        title: Option<String>,
    },
}

impl NoteInsertRequest {
    pub fn title(&self) -> Option<&str> {
        match self {
            NoteInsertRequest::Quote { title, .. } | NoteInsertRequest::Overview { title, .. } => {
                title.as_deref()
            }
        }
    }
}

/// `trimEnd()`
fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_space)
}

/// the text one "Add to note" puts at the end of the note (spec 4.9)
pub fn note_insert_text(
    note_path: &str,
    pdf_path: &str,
    request: &NoteInsertRequest,
    platform: Platform,
) -> String {
    let (head, body) = match request {
        NoteInsertRequest::Overview { heading, body, .. } => (
            format!("## {}", without_images(trim(heading))),
            without_images(trim(body)),
        ),
        NoteInsertRequest::Quote {
            excerpt,
            page,
            body,
            ..
        } => {
            let link = format!(
                "([p.{}]({}#page={}))",
                number_to_string(*page),
                pdf_link_from_note(note_path, pdf_path, platform),
                number_to_string(*page)
            );
            let cleaned = without_images(excerpt);
            let normalized = js_regex!(r"\r\n?", "g").replace_all(&cleaned, |_| "\n".to_owned());
            let mut lines: Vec<&str> = normalized.split('\n').map(trim_end).collect();
            while lines.first().is_some_and(|l| trim(l).is_empty()) {
                lines.remove(0);
            }
            while lines.last().is_some_and(|l| trim(l).is_empty()) {
                lines.pop();
            }
            let head = if lines.is_empty() {
                format!("> {link}")
            } else {
                let mut quoted: Vec<String> = lines
                    .iter()
                    .map(|line| {
                        if trim(line).is_empty() {
                            ">".to_owned()
                        } else {
                            format!("> {line}")
                        }
                    })
                    .collect();
                if let Some(last) = quoted.last_mut() {
                    last.push(' ');
                    last.push_str(&link);
                }
                quoted.join("\n")
            };
            (
                head,
                without_images(trim(body.as_deref().unwrap_or_default())),
            )
        }
    };
    if body.is_empty() {
        head
    } else {
        format!("{head}\n\n{body}")
    }
}

/// `typeof value === 'string' && value.length <= max ? value : null`
fn text_of(value: Option<&JsonValue>, max: usize) -> Option<String> {
    match value {
        Some(JsonValue::String(text)) if text.encode_utf16().count() <= max => Some(text.clone()),
        _ => None,
    }
}

fn title_of(value: Option<&JsonValue>) -> Option<String> {
    let JsonValue::String(text) = value? else {
        return None;
    };
    let squeezed = js_regex!(r"\s+", "g").replace_all(text, |_| " ".to_owned());
    let line = slice_utf16(trim(&squeezed), 0.0, Some(MAX_TITLE_CHARS));
    if line.is_empty() { None } else { Some(line) }
}

fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// the renderer's request reduced to its text parts; `None` when malformed (any path is dropped)
pub fn parse_note_insert_request(raw: Option<&JsonValue>) -> Option<NoteInsertRequest> {
    let r = match raw? {
        v @ (JsonValue::Object(_) | JsonValue::Array(_)) => v,
        _ => return None,
    };
    let title = title_of(r.get("title").as_deref());
    let kind = r.get("kind");
    match kind.as_deref() {
        Some(JsonValue::String(kind)) if kind == "quote" => {
            let excerpt = text_of(r.get("excerpt").as_deref(), MAX_EXCERPT_CHARS)?;
            let page = match r.get("page").as_deref() {
                Some(JsonValue::Number(x)) if is_integer(*x) && *x >= 1.0 && *x <= MAX_PAGE => *x,
                _ => return None,
            };
            let body = match r.get("body").as_deref() {
                None => None,
                other => Some(text_of(other, MAX_BODY_CHARS)?),
            };
            Some(NoteInsertRequest::Quote {
                excerpt,
                page,
                body,
                title,
            })
        }
        Some(JsonValue::String(kind)) if kind == "overview" => {
            let heading = text_of(r.get("heading").as_deref(), MAX_HEADING_CHARS);
            let body = text_of(r.get("body").as_deref(), MAX_BODY_CHARS);
            match (heading, body) {
                (Some(heading), Some(body))
                    if !trim(&heading).is_empty() && !trim(&body).is_empty() =>
                {
                    Some(NoteInsertRequest::Overview {
                        heading,
                        body,
                        title,
                    })
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// `PdfNoteOpenRequest`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteOpenRequest {
    pub title: Option<String>,
}

pub fn parse_note_open_request(raw: Option<&JsonValue>) -> NoteOpenRequest {
    let title = match raw {
        Some(v @ (JsonValue::Object(_) | JsonValue::Array(_))) => {
            title_of(v.get("title").as_deref())
        }
        _ => None,
    };
    NoteOpenRequest { title }
}

/// `<PDF folder>/<PDF name without extension> <note word>.md`
pub fn default_note_path(pdf_path: &str, note_word: &str, platform: Platform) -> String {
    let p = Api::of(platform);
    let base = p.basename(pdf_path);
    let stem = js_regex!(r"\.pdf$", "i").replace_all(&base, |_| String::new());
    p.join(&p.dirname(pdf_path), &format!("{stem} {note_word}.md"))
}

/// `defaultCreateNoteFile`: exclusive create; `false` when the file already exists
fn default_create_note_file(path: &str, text: &str) -> Result<bool, NodeError> {
    let opened = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(crate::node_fs::namespaced(path));
    match opened {
        Ok(mut file) => {
            file.write_all(text.as_bytes())
                .map_err(|e| node_error(&e, "write", path))?;
            Ok(true)
        }
        Err(e) if crate::node_fs::code_of(&e) == Some("EEXIST") => Ok(false),
        Err(e) => Err(node_error(&e, "open", path)),
    }
}

/// `defaultFileExists`: `access(path)`
fn default_file_exists(path: &str) -> bool {
    fs::metadata(crate::node_fs::namespaced(path)).is_ok()
}

fn is_markdown_path(path: &str) -> bool {
    js_regex!(r"\.md$", "i").test(path)
}

/// What a dependency throws, as `err instanceof Error ? err.message : String(err)` reads it
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thrown(pub String);

impl From<NodeError> for Thrown {
    fn from(e: NodeError) -> Self {
        Thrown(e.message)
    }
}

/// `NoteLink` of the store, as far as this module reads it
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteLink {
    pub note_path: String,
    pub doc_hash: String,
}

/// `NoteLinks`: keyed by `noteLinkKey(pdf path)`
#[derive(Debug, Clone)]
pub struct NoteLinks {
    pub links: JsMap<NoteLink>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchedBy {
    Path,
    DocHash,
}

/// `FoundNoteLink`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundNoteLink {
    pub note_path: String,
    pub matched_by: MatchedBy,
}

/// the store calls this module makes (`ResultStore`)
pub trait NoteLinkStore {
    fn read_note_links(&self) -> Result<NoteLinks, Thrown>;
    fn find_note_link(
        &self,
        pdf_path: &str,
        doc_hash: &str,
    ) -> Result<Option<FoundNoteLink>, Thrown>;
    fn set_note_link(&self, pdf_path: &str, link: &NoteLink) -> Result<(), Thrown>;
    fn update_note_link_doc_hash(&self, pdf_path: &str, doc_hash: &str) -> Result<bool, Thrown>;
}

/// what the shell injects (`configurePdfRuntime`); each member is absent when
/// the pdf app runs alone
pub trait NoteHost {
    fn has_open_note(&self) -> bool;
    fn has_insert_into_note(&self) -> bool;
    fn open_note(&self, path: &str) -> Result<bool, Thrown>;
    fn insert_into_note(&self, path: &str, text: &str) -> Result<bool, Thrown>;
}

/// `NoteLinkDeps`
pub trait NoteLinkDeps {
    fn store(&self) -> Result<&dyn NoteLinkStore, Thrown>;
    fn hash_file(&self, path: &str) -> Result<String, Thrown>;
    /// a shell-created blank still carrying its untitled name (never saved by the person)
    fn is_untitled(&self, pdf_path: &str) -> Result<bool, Thrown>;
    /// the main-process save dialog for the asking view; `None` when cancelled
    fn pick_note_path(&self, owner: f64, default_path: &str) -> Result<Option<String>, Thrown>;
    /// "note" in the UI language, for the default file name
    fn note_word(&self) -> Result<String, Thrown>;
    fn host(&self) -> Result<&dyn NoteHost, Thrown>;
    /// exclusive create; `Some(false)` when the file already exists; `None`
    /// when the dependency does not supply it (the default is used)
    fn create_note_file(&self, _path: &str, _text: &str) -> Option<Result<bool, Thrown>> {
        None
    }
    fn file_exists(&self, _path: &str) -> Option<Result<bool, Thrown>> {
        None
    }
}

/// `PdfNoteResult`
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteResult {
    Ok,
    Refused {
        reason: &'static str,
        message: Option<String>,
    },
}

impl NoteResult {
    fn refused(reason: &'static str) -> Self {
        NoteResult::Refused {
            reason,
            message: None,
        }
    }
}

/// the key of a PDF: its `path.resolve()`d path, lower-cased on Windows
/// (`noteLinkKey` of `packages/pdf-structure/src/store/note-links.ts`)
pub fn note_link_key(pdf_path: &str, platform: Platform) -> String {
    let full = jscompat::node_path::host::resolve(&[pdf_path]);
    if platform == Platform::Win32 {
        full.to_lowercase()
    } else {
        full
    }
}

pub struct NoteLinkService {
    platform: Platform,
    /// views with a note request in flight (one save dialog per view)
    busy: RefCell<Vec<f64>>,
}

enum Resolved {
    Note(String),
    Result(NoteResult),
}

impl NoteLinkService {
    pub fn new(platform: Platform) -> Self {
        NoteLinkService {
            platform,
            busy: RefCell::new(Vec::new()),
        }
    }

    fn is_busy(&self, owner: f64) -> bool {
        self.busy
            .borrow()
            .iter()
            .any(|&o| o == owner || (o.is_nan() && owner.is_nan()))
    }

    /// the linked note, or the one the person picks now; a refusal otherwise
    fn resolve_note(
        &self,
        deps: &dyn NoteLinkDeps,
        owner: f64,
        pdf_path: &str,
        title: Option<&str>,
    ) -> Result<Resolved, Thrown> {
        let store = deps.store()?;
        let doc_hash = deps.hash_file(pdf_path)?;
        if let Some(found) = store.find_note_link(pdf_path, &doc_hash)? {
            // a copy found by hash keeps its own link from now on
            if found.matched_by == MatchedBy::DocHash {
                store.set_note_link(
                    pdf_path,
                    &NoteLink {
                        note_path: found.note_path.clone(),
                        doc_hash: doc_hash.clone(),
                    },
                )?;
            }
            return Ok(Resolved::Note(found.note_path));
        }
        let picked = deps.pick_note_path(
            owner,
            &default_note_path(pdf_path, &deps.note_word()?, self.platform),
        )?;
        let Some(picked) = picked.filter(|p| !p.is_empty()) else {
            return Ok(Resolved::Result(NoteResult::refused("cancelled")));
        };
        let p = Api::of(self.platform);
        if !p.is_absolute(&picked) {
            return Ok(Resolved::Result(NoteResult::Refused {
                reason: "failed",
                message: Some("not absolute".to_owned()),
            }));
        }
        let note_path = if is_markdown_path(&picked) {
            picked
        } else {
            format!("{picked}.md")
        };
        let exists = match deps.file_exists(&note_path) {
            Some(answer) => answer?,
            None => default_file_exists(&note_path),
        };
        if !exists {
            let header = format!(
                "# {}\n",
                title.map_or_else(|| p.basename(pdf_path), str::to_owned)
            );
            // a file that appeared meanwhile is linked as it is, never overwritten
            match deps.create_note_file(&note_path, &header) {
                Some(answer) => {
                    answer?;
                }
                None => {
                    default_create_note_file(&note_path, &header)?;
                }
            }
        }
        store.set_note_link(
            pdf_path,
            &NoteLink {
                note_path: note_path.clone(),
                doc_hash,
            },
        )?;
        Ok(Resolved::Note(note_path))
    }

    fn run(
        &self,
        deps: &dyn NoteLinkDeps,
        owner: f64,
        pdf_path: Option<&str>,
        title: Option<&str>,
        use_note: &dyn Fn(&dyn NoteHost, &str) -> Result<bool, Thrown>,
    ) -> Result<NoteResult, Thrown> {
        let Some(pdf_path) = pdf_path.filter(|p| !p.is_empty()) else {
            return Ok(NoteResult::refused("unsaved"));
        };
        if deps.is_untitled(pdf_path)? {
            return Ok(NoteResult::refused("unsaved"));
        }
        let host = deps.host()?;
        if !host.has_open_note() || !host.has_insert_into_note() {
            return Ok(NoteResult::refused("unavailable"));
        }
        if self.is_busy(owner) {
            return Ok(NoteResult::refused("busy"));
        }
        self.busy.borrow_mut().push(owner);
        let outcome = (|| {
            let resolved = self.resolve_note(deps, owner, pdf_path, title)?;
            let note_path = match resolved {
                Resolved::Result(result) => return Ok(result),
                Resolved::Note(path) => path,
            };
            let ok = use_note(host, &note_path)?;
            Ok::<_, Thrown>(if ok {
                NoteResult::Ok
            } else {
                NoteResult::refused("failed")
            })
        })();
        {
            let mut busy = self.busy.borrow_mut();
            if let Some(at) = busy
                .iter()
                .position(|&o| o == owner || (o.is_nan() && owner.is_nan()))
            {
                busy.remove(at);
            }
        }
        Ok(match outcome {
            Ok(result) => result,
            Err(Thrown(message)) => NoteResult::Refused {
                reason: "failed",
                message: Some(message),
            },
        })
    }

    pub fn open(
        &self,
        deps: &dyn NoteLinkDeps,
        owner: f64,
        pdf_path: Option<&str>,
        request: &NoteOpenRequest,
    ) -> Result<NoteResult, Thrown> {
        self.run(
            deps,
            owner,
            pdf_path,
            request.title.as_deref(),
            &|host: &dyn NoteHost, note_path: &str| host.open_note(note_path),
        )
    }

    pub fn insert(
        &self,
        deps: &dyn NoteLinkDeps,
        owner: f64,
        pdf_path: Option<&str>,
        request: &NoteInsertRequest,
    ) -> Result<NoteResult, Thrown> {
        let platform = self.platform;
        self.run(
            deps,
            owner,
            pdf_path,
            request.title(),
            &|host: &dyn NoteHost, note_path: &str| {
                let text = note_insert_text(note_path, pdf_path.unwrap_or(""), request, platform);
                host.insert_into_note(note_path, &text)
            },
        )
    }

    /// after a save wrote `pdf_path` in place: the link of that path follows the new
    /// hash. `warn` is `console.warn`; its second argument is what was thrown.
    pub fn after_save(
        &self,
        deps: &dyn NoteLinkDeps,
        pdf_path: &str,
        warn: &mut dyn FnMut(&str, &Thrown),
    ) {
        let attempt = || -> Result<(), Thrown> {
            let store = deps.store()?;
            let links = store.read_note_links()?;
            if !links.links.has(&note_link_key(pdf_path, self.platform)) {
                return Ok(());
            }
            let hash = deps.hash_file(pdf_path)?;
            store.update_note_link_doc_hash(pdf_path, &hash)?;
            Ok(())
        };
        if let Err(err) = attempt() {
            warn("[pdf] note link hash update failed:", &err);
        }
    }
}

// ---- main-process words (the save dialog and the default file name) ----

pub const NOTE_DIALOG_KEYS: [&str; 3] = ["noteWord", "dialogTitle", "filterMarkdown"];

/// `NOTE_DIALOG_TEXT`: per language, the three words in the order of `NOTE_DIALOG_KEYS`
pub const NOTE_DIALOG_TEXT: [(&str, [&str; 3]); 2] = [
    (
        "en",
        [
            "Note",
            "Choose the note file for this PDF",
            "Markdown document",
        ],
    ),
    (
        "ko",
        [
            "\u{B178}\u{D2B8}",
            "\u{C774} PDF\u{C758} \u{B178}\u{D2B8} \u{D30C}\u{C77C} \u{ACE0}\u{B974}\u{AE30}",
            "\u{B9C8}\u{D06C}\u{B2E4}\u{C6B4} \u{BB38}\u{C11C}",
        ],
    ),
];

/// The names `Object.prototype` has: `NOTE_DIALOG_TEXT[lang]` finds a function
/// or the prototype there, and `[key]` of either is `undefined`
const PROTOTYPE_NAMES: [&str; 12] = [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

/// `noteDialogText(lang, key)`; `None` is `undefined`
pub fn note_dialog_text(lang: &str, key: &str) -> Option<&'static str> {
    if PROTOTYPE_NAMES.contains(&lang) {
        return None;
    }
    let row = NOTE_DIALOG_TEXT
        .iter()
        .find(|(name, _)| *name == lang)
        .unwrap_or(&NOTE_DIALOG_TEXT[0]);
    NOTE_DIALOG_KEYS
        .iter()
        .position(|k| *k == key)
        .map(|at| row.1[at])
}
