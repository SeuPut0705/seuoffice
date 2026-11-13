//! `apps/markdown/src/main/wiki-resolve.ts`: resolving `[[target]]` to a file.
//!
//! The TypeScript is async over an injectable `WikiFs`; here the calls are
//! plain and `WikiFs` is a trait. `Promise.all` over a step's listings is
//! the listings in queue order, which is the order the TypeScript issues
//! them in.

use std::collections::HashMap;
use std::fs;

use jscompat::node_path::host::{SEP, basename, dirname, extname, is_absolute, join, relative};
use jscompat::{JsMap, trim};

use crate::node_fs::{NodeError, namespaced, node_error};
use crate::shell::recent_files::StatInfo;

/// `Listing`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Listing {
    pub files: Vec<String>,
    pub dirs: Vec<String>,
}

/// `WikiFs`: a filesystem the resolver walks.
pub trait WikiFs {
    /// `isFile(path)`
    fn is_file(&mut self, path: &str) -> bool;
    /// `list(dir)`; the error is what the TypeScript's promise rejects with
    fn list(&mut self, dir: &str) -> Result<Listing, NodeError>;
}

/// directories never entered: version control, dependency trees, app sandboxes
pub const SKIP_DIRS: [&str; 8] = [
    ".git",
    ".obsidian",
    ".trash",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".DS_Store",
];

/// `SKIP_DIRS.has(name)`
pub fn is_skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

/// note extensions a bare `[[Name]]` may stand for, in preference order
const NOTE_EXTS: [&str; 3] = [".md", ".markdown", ".txt"];

/// how deep below the root a link may reach; a walk past this is not a note
pub const MAX_DEPTH: usize = 6;

/// entries under one walk step, so a huge library cannot stall the UI
const MAX_ENTRIES: i64 = 20000;

/// a listing is trusted this long without a stat; a typing burst re-resolves far more often
const LISTING_TTL_MS: f64 = 2000.0;

const MAX_CACHED_DIRS: usize = 8000;

struct CachedListing {
    listing: Listing,
    mtime_ms: f64,
    checked_at: f64,
}

/// `nodeFs()`: the real filesystem; listings are cached per instance and
/// revalidated by directory mtime. `now_ms` is `Date.now()`.
pub struct NodeWikiFs<'a> {
    now_ms: &'a dyn Fn() -> f64,
    cache: HashMap<String, CachedListing>,
}

pub fn node_fs(now_ms: &dyn Fn() -> f64) -> NodeWikiFs<'_> {
    NodeWikiFs {
        now_ms,
        cache: HashMap::new(),
    }
}

impl WikiFs for NodeWikiFs<'_> {
    fn is_file(&mut self, path: &str) -> bool {
        fs::metadata(namespaced(path)).is_ok_and(|meta| meta.is_file())
    }

    fn list(&mut self, dir: &str) -> Result<Listing, NodeError> {
        let now = (self.now_ms)();
        let hit = self.cache.get(dir);
        if let Some(hit) = hit
            && now - hit.checked_at < LISTING_TTL_MS
        {
            return Ok(hit.listing.clone());
        }
        let meta = fs::metadata(namespaced(dir)).map_err(|e| node_error(&e, "stat", dir))?;
        let mtime_ms = StatInfo::of(&meta).mtime_ms;
        if let Some(hit) = self.cache.get_mut(dir)
            && hit.mtime_ms == mtime_ms
        {
            hit.checked_at = now;
            return Ok(hit.listing.clone());
        }
        let mut entries: Vec<(String, fs::FileType)> = Vec::new();
        let reader = fs::read_dir(namespaced(dir)).map_err(|e| node_error(&e, "scandir", dir))?;
        for entry in reader {
            let entry = entry.map_err(|e| node_error(&e, "scandir", dir))?;
            let kind = entry
                .file_type()
                .map_err(|e| node_error(&e, "scandir", dir))?;
            entries.push((entry.file_name().to_string_lossy().into_owned(), kind));
        }
        // libuv sorts the names by bytes
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let mut listing = Listing::default();
        for (name, kind) in entries {
            if kind.is_dir() {
                listing.dirs.push(name);
            } else if kind.is_file() {
                listing.files.push(name);
            }
        }
        if self.cache.len() >= MAX_CACHED_DIRS {
            self.cache.clear();
        }
        self.cache.insert(
            dir.to_owned(),
            CachedListing {
                listing: listing.clone(),
                mtime_ms,
                checked_at: now,
            },
        );
        Ok(listing)
    }
}

/// `SplitTarget`
#[derive(Debug, Clone, PartialEq)]
pub struct SplitTarget {
    /// the file part, '' for a same-file `[[#Heading]]`
    pub name: String,
    /// the `#Heading` / `#^block` fragment, '' when there is none
    pub fragment: String,
}

/// `splitTarget(raw)`
pub fn split_target(raw: &str) -> SplitTarget {
    match raw.find('#') {
        None => SplitTarget {
            name: trim(raw).to_owned(),
            fragment: String::new(),
        },
        Some(hash) => SplitTarget {
            name: trim(&raw[..hash]).to_owned(),
            fragment: trim(&raw[hash + 1..]).to_owned(),
        },
    }
}

/// `ResolvedLink`
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedLink {
    /// absolute path, or '' when the target is this document
    pub path: String,
    pub fragment: String,
    /// true when a file was found
    pub found: bool,
}

/// `ResolveOptions`
pub struct ResolveOptions<'a> {
    /// absolute path of the document holding the links; '' for an untitled one
    pub from_path: &'a str,
    /// the root a bare name may reach beyond the document's own directory
    pub root: &'a str,
}

/// Whether a target may be joined onto a directory at all.
fn escapes_vault(name: &str) -> bool {
    if name.is_empty() {
        return true;
    }
    if is_absolute(name) {
        return true;
    }
    name.split(['\\', '/']).any(|segment| segment == "..")
}

/// the candidates a bare name can stand for, in the order they are tried
fn candidate_paths(dir: &str, name: &str) -> Vec<String> {
    if !extname(name).is_empty() {
        return vec![join(&[dir, name])];
    }
    NOTE_EXTS
        .iter()
        .map(|ext| join(&[dir, &format!("{name}{ext}")]))
        .collect()
}

fn first_existing(fs: &mut dyn WikiFs, dir: &str, name: &str) -> Option<String> {
    candidate_paths(dir, name)
        .into_iter()
        .find(|candidate| fs.is_file(candidate))
}

fn has_dir(name: &str) -> bool {
    name.contains(['\\', '/'])
}

fn slashes(path: &str) -> String {
    path.split(SEP).collect::<Vec<_>>().join("/")
}

struct Pending {
    raw: String,
    name: String,
    fragment: String,
}

/// `resolveWikiLinks(targets, options, fs)`: every link in one walk.
pub fn resolve_wiki_links(
    targets: &[String],
    options: &ResolveOptions<'_>,
    fs: &mut dyn WikiFs,
) -> JsMap<ResolvedLink> {
    let mut out: JsMap<ResolvedLink> = JsMap::new();
    if targets.is_empty() {
        return out;
    }

    let mut pending: Vec<Pending> = Vec::new();
    for raw in targets {
        if out.has(raw) {
            continue;
        }
        let SplitTarget { name, fragment } = split_target(raw);
        out.set(
            raw.as_str(),
            ResolvedLink {
                path: String::new(),
                fragment: fragment.clone(),
                found: false,
            },
        );
        // `[[#Heading]]` addresses this document; it is never a lookup
        if name.is_empty() {
            out.set(
                raw.as_str(),
                ResolvedLink {
                    path: options.from_path.to_owned(),
                    fragment,
                    found: !options.from_path.is_empty(),
                },
            );
            continue;
        }
        // refused before it reaches the filesystem, so it reports unresolved
        if escapes_vault(&name) {
            continue;
        }
        pending.push(Pending {
            raw: raw.clone(),
            name,
            fragment,
        });
    }
    if pending.is_empty() {
        return out;
    }

    // 1. the document's own directory, then the root for a path with a directory
    let mut remaining: Vec<usize> = Vec::new();
    let from_dir = if options.from_path.is_empty() {
        String::new()
    } else {
        dirname(options.from_path)
    };
    let bases: Vec<&str> = [from_dir.as_str(), options.root]
        .into_iter()
        .filter(|base| !base.is_empty())
        .collect();
    for (at, item) in pending.iter().enumerate() {
        let mut hit: Option<String> = None;
        for base in &bases {
            if *base == options.root && !has_dir(&item.name) {
                continue;
            }
            hit = first_existing(fs, base, &item.name);
            if hit.is_some() {
                break;
            }
        }
        match hit {
            Some(path) => out.set(
                item.raw.as_str(),
                ResolvedLink {
                    path,
                    fragment: item.fragment.clone(),
                    found: true,
                },
            ),
            None => remaining.push(at),
        }
    }

    // 2. breadth-first from the root: a shallower file beats a deeper one
    if !remaining.is_empty() && !options.root.is_empty() {
        let mut wanted: JsMap<Vec<usize>> = JsMap::new();
        // `[[dir/Note]]` keys match as a suffix of the root-relative path
        let mut wanted_paths: Vec<String> = Vec::new();
        for &at in &remaining {
            let item = &pending[at];
            let key = if has_dir(&item.name) {
                slashes(&item.name)
            } else {
                item.name.clone()
            };
            if let Some(list) = wanted.get_mut(&key) {
                list.push(at);
            } else {
                wanted.set(&key, vec![at]);
                if has_dir(&key) {
                    wanted_paths.push(key);
                }
            }
        }
        if !wanted.is_empty() {
            let mut queue: Vec<(String, usize)> = vec![(options.root.to_owned(), 0)];
            let mut budget = MAX_ENTRIES;
            while !queue.is_empty() && !wanted.is_empty() && budget > 0 {
                let mut next: Vec<(String, usize)> = Vec::new();
                // an unreadable directory reads as empty, same as an unplugged root
                let listings: Vec<Listing> = queue
                    .iter()
                    .map(|(dir, _)| fs.list(dir).unwrap_or_default())
                    .collect();
                for ((dir, depth), listing) in queue.iter().zip(listings.iter()) {
                    budget -= (listing.files.len() + listing.dirs.len()) as i64;
                    let rel_dir = slashes(&relative(options.root, dir));
                    for file in &listing.files {
                        // indexed under both spellings: a bare `[[Name]]` matches
                        // the stem, an explicit `[[Figure 1.png]]` the file as written
                        let stem = basename(file, Some(&extname(file)));
                        let mut names: Vec<String> = vec![file.clone()];
                        if stem != *file {
                            names.push(stem.clone());
                        }
                        if !wanted_paths.is_empty() && !rel_dir.is_empty() {
                            for key in &wanted_paths {
                                if !wanted.has(key) {
                                    continue;
                                }
                                let tail = format!("/{key}");
                                for spelled in
                                    [format!("{rel_dir}/{file}"), format!("{rel_dir}/{stem}")]
                                {
                                    if spelled.ends_with(&tail) && !names.contains(key) {
                                        names.push(key.clone());
                                    }
                                }
                            }
                        }
                        let mut satisfied: Vec<String> = Vec::new();
                        for key in &names {
                            let Some(items) = wanted.get(key) else {
                                continue;
                            };
                            for &at in items {
                                let item = &pending[at];
                                if out.get(&item.raw).is_some_and(|link| link.found) {
                                    continue;
                                }
                                out.set(
                                    item.raw.as_str(),
                                    ResolvedLink {
                                        path: join(&[dir, file]),
                                        fragment: item.fragment.clone(),
                                        found: true,
                                    },
                                );
                                if !satisfied.contains(key) {
                                    satisfied.push(key.clone());
                                }
                            }
                        }
                        if satisfied.is_empty() {
                            continue;
                        }
                        for key in &satisfied {
                            wanted.delete(key);
                        }
                        if wanted.is_empty() {
                            break;
                        }
                    }
                    if wanted.is_empty() || budget <= 0 || depth + 1 > MAX_DEPTH {
                        continue;
                    }
                    for sub in &listing.dirs {
                        if is_skip_dir(sub) {
                            continue;
                        }
                        next.push((join(&[dir, sub]), depth + 1));
                    }
                }
                queue = next;
            }
        }
    }

    out
}
