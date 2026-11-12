//! `apps/shell/src/main/document-links.ts`: provenance records (spec 9).
//!
//! Where the TypeScript hands a `webContents` that `once('destroyed')` a
//! listener, the caller of [`DocumentLinks::note_tab_path`] registers one that
//! calls [`DocumentLinks::tab_destroyed`]. A listener of `onChange` is a boxed
//! closure with an id ([`ListenerId`]) in place of the function identity.
//! `console.warn` is [`DocumentLinksDeps::warn`]. `queueMicrotask` of
//! `watchMakeEvents` is [`MakeEventsWatch::flush`]. The hand-off store is the
//! [`HandoffStore`] its owner keeps.

use std::cell::Cell;
use std::fs;
use std::rc::Rc;

use jscompat::node_path::host::{basename, resolve};
use jscompat::{JsObject, JsonValue, json_parse, to_iso_string};
use serde::Serialize;

use crate::packages::electron_utils::atomic_write::write_json_atomic;
use crate::packages::electron_utils::generate_handoff::HandoffStore;
use crate::shell::crash_log::InvalidTimeValue;

pub const DOCUMENT_LINKS_FILE: &str = "document-links.json";

/// `DocumentLinkVia`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentLinkVia {
    Ai,
    Convert,
}

impl DocumentLinkVia {
    fn as_str(self) -> &'static str {
        match self {
            DocumentLinkVia::Ai => "ai",
            DocumentLinkVia::Convert => "convert",
        }
    }
}

/// `DocumentLink`, its keys in the order `validLink` builds them
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DocumentLink {
    /// absolute path of the document that was made
    pub derived: String,
    /// absolute paths of the handed-over materials
    pub sources: Vec<String>,
    /// ISO 8601 time the record was written
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub via: DocumentLinkVia,
}

impl DocumentLink {
    fn to_json(&self) -> JsonValue {
        let mut object = JsObject::new();
        object.set("derived", JsonValue::String(self.derived.clone()));
        object.set(
            "sources",
            JsonValue::Array(
                self.sources
                    .iter()
                    .cloned()
                    .map(JsonValue::String)
                    .collect(),
            ),
        );
        object.set("createdAt", JsonValue::String(self.created_at.clone()));
        object.set("via", JsonValue::String(self.via.as_str().to_string()));
        JsonValue::Object(object)
    }
}

/// `DocumentLinksFile`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DocumentLinksFile {
    /// always 1
    pub version: u32,
    pub links: Vec<DocumentLink>,
}

impl DocumentLinksFile {
    /// the value `writeJsonAtomic` writes
    pub fn to_json(&self) -> JsonValue {
        let mut object = JsObject::new();
        object.set("version", JsonValue::Number(f64::from(self.version)));
        object.set(
            "links",
            JsonValue::Array(self.links.iter().map(DocumentLink::to_json).collect()),
        );
        JsonValue::Object(object)
    }
}

/// `MakeEvent`: "something was made in this tab from these files", as the
/// hand-off store records it. A `None` source stands for a value that is not
/// a string.
#[derive(Debug, Clone, PartialEq)]
pub struct MakeEvent {
    pub web_contents_id: f64,
    pub mode: DocumentLinkVia,
    pub sources: Vec<Option<String>>,
    /// ms since epoch
    pub at: f64,
}

/// the part of a webContents the tracker needs (`LinkedWebContents`)
pub trait LinkedWebContents {
    fn id(&self) -> f64;
    /// `once('destroyed', ...)`: the caller arranges for
    /// [`DocumentLinks::tab_destroyed`] to run with this id once
    fn once_destroyed(&mut self);
}

/// `DocumentLinksDeps`
pub trait DocumentLinksDeps {
    /// the stored records; a missing or broken file is no records
    fn load(&mut self) -> Vec<DocumentLink>;
    /// replace the stored file with these records (atomically); `Err` is the
    /// message of what it threw
    fn save(&mut self, file: &DocumentLinksFile) -> Result<(), String>;
    /// the hand-off store's run-started and converted events
    fn events(&mut self) -> Vec<MakeEvent>;
    /// `now()`: the clock, in ms since the epoch
    fn now_ms(&mut self) -> f64;
    /// `console.warn(message, error)`
    fn warn(&mut self, message: &str, error: &str);
}

/// `linkPathKey(path)`: the key two paths are compared by: resolved, and
/// case-blind on Windows
pub fn link_path_key(path: &str) -> String {
    let resolved = resolve(&[path]);
    if cfg!(windows) {
        resolved.to_lowercase()
    } else {
        resolved
    }
}

fn is_string_list(value: Option<&JsonValue>) -> Option<Vec<String>> {
    let Some(JsonValue::Array(items)) = value else {
        return None;
    };
    items
        .iter()
        .map(|item| match item {
            JsonValue::String(text) if !text.is_empty() => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn valid_link(value: &JsonValue) -> Option<DocumentLink> {
    let (JsonValue::Object(_) | JsonValue::Array(_)) = value else {
        return None;
    };
    let field = |key: &str| value.get(key).map(std::borrow::Cow::into_owned);
    let derived = match field("derived") {
        Some(JsonValue::String(text)) if !text.is_empty() => text,
        _ => return None,
    };
    let sources = is_string_list(field("sources").as_ref())?;
    if sources.is_empty() {
        return None;
    }
    let created_at = match field("createdAt") {
        Some(JsonValue::String(text)) => text,
        _ => return None,
    };
    let via = match field("via") {
        Some(JsonValue::String(text)) if text == "ai" => DocumentLinkVia::Ai,
        Some(JsonValue::String(text)) if text == "convert" => DocumentLinkVia::Convert,
        _ => return None,
    };
    Some(DocumentLink {
        derived,
        sources,
        created_at,
        via,
    })
}

/// `parseDocumentLinks(text)`: the records in a file's text. Anything that is
/// not the expected shape reads as no records; a single malformed record is
/// skipped, and a repeated `derived` keeps its last record.
pub fn parse_document_links(text: &str) -> Vec<DocumentLink> {
    let Ok(JsonValue::Object(raw)) = json_parse(text) else {
        return Vec::new();
    };
    let Some(JsonValue::Array(links)) = raw.get("links") else {
        return Vec::new();
    };
    // a `Map` keyed by the path key: a key set again moves to the end
    let mut by_derived: Vec<(String, DocumentLink)> = Vec::new();
    for entry in links {
        let Some(link) = valid_link(entry) else {
            continue;
        };
        let key = link_path_key(&link.derived);
        by_derived.retain(|(held, _)| *held != key);
        by_derived.push((key, link));
    }
    by_derived.into_iter().map(|(_, link)| link).collect()
}

/// `readDocumentLinksFile(path)`: read the records file; missing or
/// unreadable is no records
pub fn read_document_links_file(path: &str) -> Vec<DocumentLink> {
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    // readFileSync(path, 'utf8') keeps a byte order mark, which JSON.parse refuses
    parse_document_links(&String::from_utf8_lossy(&bytes))
}

/// `handoffStoreEvents()`: the hand-off store's events in the shape the join
/// reads (`generateRunStartedEvents()` then `generateConvertedEvents()`).
pub fn handoff_store_events(store: &HandoffStore) -> Vec<MakeEvent> {
    let mut events: Vec<MakeEvent> = store
        .generate_run_started_events()
        .into_iter()
        .map(|e| MakeEvent {
            web_contents_id: e.web_contents_id,
            mode: DocumentLinkVia::Ai,
            // the record lists the materials handed over, not only those still attached (9)
            sources: e.handed_over.into_iter().map(Some).collect(),
            at: e.at,
        })
        .collect();
    events.extend(
        store
            .generate_converted_events()
            .into_iter()
            .map(|e| MakeEvent {
                web_contents_id: e.web_contents_id,
                mode: DocumentLinkVia::Convert,
                sources: e.sources.into_iter().map(Some).collect(),
                at: e.at,
            }),
    );
    events
}

/// What `watchMakeEvents(tabIdFor, onEvent)` leaves behind: the resolver is
/// installed in the hand-off store, and each record the store makes queues
/// one `onEvent` (`queueMicrotask`) that [`MakeEventsWatch::flush`] runs once
/// the shell's code of that turn is done.
pub struct MakeEventsWatch {
    queued: Rc<Cell<usize>>,
    on_event: Box<dyn FnMut()>,
}

/// `watchMakeEvents(tabIdFor, onEvent)`: the hand-off store asks the shell for
/// a tab id each time it records a run start or a conversion, right before
/// the record goes in. Answer as before and look at the records once that
/// one is in.
pub fn watch_make_events(
    store: &mut HandoffStore,
    tab_id_for: Box<dyn Fn(f64) -> Option<String>>,
    on_event: Box<dyn FnMut()>,
) -> MakeEventsWatch {
    let queued = Rc::new(Cell::new(0usize));
    let counter = queued.clone();
    store.set_generate_tab_id_resolver(Some(Box::new(move |web_contents_id| {
        counter.set(counter.get() + 1);
        Ok(tab_id_for(web_contents_id))
    })));
    MakeEventsWatch { queued, on_event }
}

impl MakeEventsWatch {
    /// the queued microtasks: one `onEvent` per record since the last flush
    pub fn flush(&mut self) {
        while self.queued.get() > 0 {
            self.queued.set(self.queued.get() - 1);
            (self.on_event)();
        }
    }
}

const FRESH_WINDOW_MS: f64 = 10_000.0;

/// the two times of a `statSync` result `isFreshlySavedPath` reads
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StatTimes {
    pub birthtime_ms: f64,
    pub mtime_ms: f64,
}

/// the default `stat` of `isFreshlySavedPath`: `statSync(path)`; `Err` where it throws
pub fn stat_sync(path: &str) -> Result<StatTimes, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let millis = |time: std::io::Result<std::time::SystemTime>| -> f64 {
        match time.map(|t| t.duration_since(std::time::UNIX_EPOCH)) {
            // Node: seconds * 1e3 + nanoseconds / 1e6
            Ok(Ok(since)) => since.as_secs() as f64 * 1e3 + f64::from(since.subsec_nanos()) / 1e6,
            _ => 0.0,
        }
    };
    Ok(StatTimes {
        birthtime_ms: millis(meta.created()),
        mtime_ms: millis(meta.modified()),
    })
}

/// `isFreshlySavedPath(path, nowMs, stat)`: whether a path a tab just got is a
/// document saved there now, not an existing file opened into the tab: not on
/// disk yet (the save is about to write it), or born within the last few
/// seconds.
pub fn is_freshly_saved_path(
    path: &str,
    now_ms: f64,
    stat: &mut dyn FnMut(&str) -> Result<StatTimes, String>,
) -> bool {
    match stat(path) {
        Ok(s) => {
            // `s.birthtimeMs || s.mtimeMs`
            let born = if s.birthtime_ms != 0.0 && !s.birthtime_ms.is_nan() {
                s.birthtime_ms
            } else {
                s.mtime_ms
            };
            born >= now_ms - FRESH_WINDOW_MS
        }
        Err(_) => true,
    }
}

struct TrackedTab {
    /// the path of the first save, following renames; `None` when the first
    /// path was not a save
    path: Option<String>,
    recorded: bool,
}

/// the key of a `Map` of numbers (SameValueZero)
fn same_value_zero(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

/// The handle `onChange` gives back (the function it returns to unsubscribe).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListenerId(usize);

pub struct DocumentLinks<D: DocumentLinksDeps> {
    deps: D,
    links: Option<Vec<DocumentLink>>,
    tabs: Vec<(f64, TrackedTab)>,
    listeners: Vec<(ListenerId, Box<dyn FnMut()>)>,
    next_listener: usize,
    version: u64,
}

impl<D: DocumentLinksDeps> DocumentLinks<D> {
    pub fn new(deps: D) -> Self {
        DocumentLinks {
            deps,
            links: None,
            tabs: Vec::new(),
            listeners: Vec::new(),
            next_listener: 0,
            version: 0,
        }
    }

    /// the dependencies the records were built with
    pub fn deps(&self) -> &D {
        &self.deps
    }

    /// `version`: bumps whenever the records change (menus compare it)
    pub fn version(&self) -> u64 {
        self.version
    }

    /// `#all()`
    fn all(&mut self) -> &mut Vec<DocumentLink> {
        if self.links.is_none() {
            self.links = Some(self.deps.load());
        }
        self.links.as_mut().expect("loaded above")
    }

    /// `links()`: a copy of every record
    pub fn links(&mut self) -> Vec<DocumentLink> {
        self.all().clone()
    }

    /// `onChange(listener)`
    pub fn on_change(&mut self, listener: Box<dyn FnMut()>) -> ListenerId {
        let id = ListenerId(self.next_listener);
        self.next_listener += 1;
        self.listeners.push((id, listener));
        id
    }

    /// the function `onChange` returns: unsubscribe
    pub fn off_change(&mut self, id: ListenerId) {
        self.listeners.retain(|(held, _)| *held != id);
    }

    fn tab_index(&self, id: f64) -> Option<usize> {
        self.tabs
            .iter()
            .position(|(held, _)| same_value_zero(*held, id))
    }

    /// the listener of `once('destroyed')`: `this.#tabs.delete(contents.id)`
    pub fn tab_destroyed(&mut self, id: f64) {
        if let Some(at) = self.tab_index(id) {
            self.tabs.remove(at);
        }
    }

    /// `noteTabPath(contents, path, options)`: a tab's document got a path.
    /// Only the first one counts: a later Save As to another path is not where
    /// the record goes. `fresh` of `Some(false)` says the path is an existing
    /// file opened into the tab, not a save; such a tab is never recorded.
    /// (`options?.fresh ?? true`: `None` is true.)
    pub fn note_tab_path(
        &mut self,
        contents: &mut dyn LinkedWebContents,
        path: &str,
        fresh: Option<bool>,
    ) -> Result<(), InvalidTimeValue> {
        if self.tab_index(contents.id()).is_some() {
            return Ok(());
        }
        let fresh = fresh.unwrap_or(true);
        self.tabs.push((
            contents.id(),
            TrackedTab {
                path: if fresh { Some(resolve(&[path])) } else { None },
                recorded: false,
            },
        ));
        contents.once_destroyed();
        self.sync()?;
        Ok(())
    }

    /// `sync()`: write the records that are due: every tracked tab that has its
    /// first saved path and a make event, and no record yet. Returns whether
    /// anything was written.
    pub fn sync(&mut self) -> Result<bool, InvalidTimeValue> {
        let pending: Vec<(f64, String)> = self
            .tabs
            .iter()
            .filter(|(_, t)| t.path.is_some() && !t.recorded)
            .map(|(id, t)| (*id, t.path.clone().expect("filtered on a path")))
            .collect();
        if pending.is_empty() {
            return Ok(false);
        }
        let events = self.deps.events();
        let mut changed = false;
        for (wc_id, derived) in pending {
            // `events.filter(...).sort((a, b) => a.at - b.at)[0]`: the first of the earliest
            let mut event: Option<&MakeEvent> = None;
            for candidate in events.iter().filter(|e| e.web_contents_id == wc_id) {
                if event.is_none_or(|best| candidate.at < best.at) {
                    event = Some(candidate);
                }
            }
            let Some(event) = event else {
                continue;
            };
            if let Some(at) = self.tab_index(wc_id) {
                self.tabs[at].1.recorded = true;
            }
            let derived_key = link_path_key(&derived);
            let mut seen: Vec<String> = Vec::new();
            let mut sources: Vec<String> = Vec::new();
            for source in &event.sources {
                let Some(source) = source else {
                    continue;
                };
                if source.is_empty() {
                    continue;
                }
                let key = link_path_key(source);
                if key == derived_key || seen.contains(&key) {
                    continue;
                }
                seen.push(key);
                sources.push(resolve(&[source]));
            }
            if sources.is_empty() {
                continue;
            }
            let mut kept: Vec<DocumentLink> = self
                .all()
                .iter()
                .filter(|l| link_path_key(&l.derived) != derived_key)
                .cloned()
                .collect();
            let created_at = to_iso_string(self.deps.now_ms()).ok_or(InvalidTimeValue)?;
            kept.push(DocumentLink {
                derived,
                sources,
                created_at,
                via: event.mode,
            });
            self.links = Some(kept);
            changed = true;
        }
        if changed {
            self.commit();
        }
        Ok(changed)
    }

    /// `fileMoved(oldPath, newPath)`: a file was renamed or moved inside the
    /// app: records and tracked tabs follow
    pub fn file_moved(&mut self, old_path: &str, new_path: &str) {
        let old_key = link_path_key(old_path);
        let next = resolve(&[new_path]);
        for (_, tab) in &mut self.tabs {
            if let Some(path) = &tab.path
                && link_path_key(path) == old_key
            {
                tab.path = Some(next.clone());
            }
        }
        let mut changed = false;
        let mut moved_derived: Option<usize> = None;
        let moved: Vec<DocumentLink> = self
            .all()
            .iter()
            .enumerate()
            .map(|(i, link)| {
                let derived_moved = link_path_key(&link.derived) == old_key;
                let sources_moved = link.sources.iter().any(|s| link_path_key(s) == old_key);
                if !derived_moved && !sources_moved {
                    return link.clone();
                }
                changed = true;
                if derived_moved {
                    moved_derived = Some(i);
                }
                DocumentLink {
                    derived: if derived_moved {
                        next.clone()
                    } else {
                        link.derived.clone()
                    },
                    sources: link
                        .sources
                        .iter()
                        .map(|s| {
                            if link_path_key(s) == old_key {
                                next.clone()
                            } else {
                                s.clone()
                            }
                        })
                        .collect(),
                    created_at: link.created_at.clone(),
                    via: link.via,
                }
            })
            .collect();
        if !changed {
            return;
        }
        // a made document moved onto another one's path: one record per path, the moved one
        let next_key = link_path_key(&next);
        self.links = Some(match moved_derived {
            None => moved,
            Some(at) => moved
                .into_iter()
                .enumerate()
                .filter(|(i, link)| *i == at || link_path_key(&link.derived) != next_key)
                .map(|(_, link)| link)
                .collect(),
        });
        self.commit();
    }

    /// `sourcesOf(path)`: the sources of the document at `path`, when it is a
    /// made document
    pub fn sources_of(&mut self, path: &str) -> Vec<String> {
        let key = link_path_key(path);
        self.all()
            .iter()
            .find(|l| link_path_key(&l.derived) == key)
            .map_or_else(Vec::new, |link| link.sources.clone())
    }

    /// `derivedFrom(path)`: the documents made from `path`, oldest record first
    pub fn derived_from(&mut self, path: &str) -> Vec<String> {
        let key = link_path_key(path);
        self.all()
            .iter()
            .filter(|l| l.sources.iter().any(|s| link_path_key(s) == key))
            .map(|l| l.derived.clone())
            .collect()
    }

    /// `paths()`: every path the records and the tracked tabs mention (folder
    /// moves re-key them)
    pub fn paths(&mut self) -> Vec<String> {
        let mut all: Vec<(String, String)> = Vec::new();
        let mut add = |path: &str| {
            let key = link_path_key(path);
            if !all.iter().any(|(held, _)| *held == key) {
                all.push((key, path.to_string()));
            }
        };
        for link in self.links.get_or_insert_with(|| self.deps.load()) {
            add(&link.derived);
            for source in &link.sources {
                add(source);
            }
        }
        for (_, tab) in &self.tabs {
            if let Some(path) = &tab.path
                && !tab.recorded
            {
                add(path);
            }
        }
        all.into_iter().map(|(_, path)| path).collect()
    }

    /// `#commit()`
    fn commit(&mut self) {
        self.version += 1;
        let file = DocumentLinksFile {
            version: 1,
            links: self.links(),
        };
        if let Err(error) = self.deps.save(&file) {
            self.deps
                .warn("[document-links] could not write the records:", &error);
        }
        for (_, listener) in &mut self.listeners {
            listener();
        }
    }
}

/// `console.warn(message, error)`.
type WarnSink<'a> = Box<dyn FnMut(&str, &str) + 'a>;

/// The dependencies of `documentLinksAt(filePath)`: the records kept in
/// `file_path`, written like the other state files. The clock, the hand-off
/// store and `console.warn` come from the caller.
pub struct FileLinksDeps<'a> {
    file_path: String,
    events: Box<dyn FnMut() -> Vec<MakeEvent> + 'a>,
    now_ms: Box<dyn FnMut() -> f64 + 'a>,
    warn: WarnSink<'a>,
}

impl DocumentLinksDeps for FileLinksDeps<'_> {
    fn load(&mut self) -> Vec<DocumentLink> {
        read_document_links_file(&self.file_path)
    }

    fn save(&mut self, file: &DocumentLinksFile) -> Result<(), String> {
        write_json_atomic(&self.file_path, &file.to_json()).map_err(|e| e.message)
    }

    fn events(&mut self) -> Vec<MakeEvent> {
        (self.events)()
    }

    fn now_ms(&mut self) -> f64 {
        (self.now_ms)()
    }

    fn warn(&mut self, message: &str, error: &str) {
        (self.warn)(message, error);
    }
}

/// `documentLinksAt(filePath)`
pub fn document_links_at<'a>(
    file_path: &str,
    events: Box<dyn FnMut() -> Vec<MakeEvent> + 'a>,
    now_ms: Box<dyn FnMut() -> f64 + 'a>,
    warn: WarnSink<'a>,
) -> DocumentLinks<FileLinksDeps<'a>> {
    DocumentLinks::new(FileLinksDeps {
        file_path: file_path.to_string(),
        events,
        now_ms,
        warn,
    })
}

/// `LinkMenuEntry`: one entry of a "View Sources" / "Documents Made from This" list
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LinkMenuEntry {
    pub path: String,
    pub name: String,
    /// not on disk: drawn dimmed and not clickable
    pub missing: bool,
}

/// `DocumentLinkMenuModel`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DocumentLinkMenuModel {
    pub sources: Vec<LinkMenuEntry>,
    pub derived: Vec<LinkMenuEntry>,
}

/// `Pick<DocumentLinks, 'sourcesOf' | 'derivedFrom'>`
pub trait LinkLookup {
    fn sources_of(&mut self, path: &str) -> Vec<String>;
    fn derived_from(&mut self, path: &str) -> Vec<String>;
}

impl<D: DocumentLinksDeps> LinkLookup for DocumentLinks<D> {
    fn sources_of(&mut self, path: &str) -> Vec<String> {
        DocumentLinks::sources_of(self, path)
    }

    fn derived_from(&mut self, path: &str) -> Vec<String> {
        DocumentLinks::derived_from(self, path)
    }
}

/// `documentLinkMenuModel(filePath, links, exists)`: what the File menu shows
/// for the open document; nothing for an unsaved one (`None` or `""`)
pub fn document_link_menu_model(
    file_path: Option<&str>,
    links: &mut dyn LinkLookup,
    exists: &mut dyn FnMut(&str) -> bool,
) -> DocumentLinkMenuModel {
    let Some(file_path) = file_path.filter(|path| !path.is_empty()) else {
        return DocumentLinkMenuModel {
            sources: Vec::new(),
            derived: Vec::new(),
        };
    };
    let mut entry = |path: String| {
        let name = basename(&path, None);
        let missing = !exists(&path);
        LinkMenuEntry {
            path,
            name,
            missing,
        }
    };
    let sources = links
        .sources_of(file_path)
        .into_iter()
        .map(&mut entry)
        .collect();
    let derived = links
        .derived_from(file_path)
        .into_iter()
        .map(&mut entry)
        .collect();
    DocumentLinkMenuModel { sources, derived }
}
