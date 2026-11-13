//! `apps/markdown/src/main/wiki-index.ts`: the vault's cross-file link index,
//! what the backlinks panel and the graph view both read.
//!
//! The TypeScript keeps its per-root indexes in a module-level `Map` and
//! chains the async builds of one root; here the indexes are a value the
//! caller owns ([`WikiIndex`]) and a build runs to its end when called, so
//! there is nothing to chain.

use std::collections::{HashMap, HashSet};
use std::fs;

use jscompat::node_path::host::{basename, extname, join, relative};
use jscompat::{js_regex, string_less_than};
use serde::Serialize;

use super::fs_util::read_file_utf8;
use super::wiki_resolve::{
    Listing, MAX_DEPTH, NodeWikiFs, ResolveOptions, WikiFs, is_skip_dir, node_fs,
    resolve_wiki_links,
};
use crate::node_fs::{NodeError, namespaced};
use crate::shell::recent_files::StatInfo;
use jscompat::JsMap;

/// notes one build may walk, mirroring the suggester's cap
pub const MAX_INDEX_FILES: usize = 2000;

/// the graph's node cap; a bigger vault takes the first walk order
pub const MAX_GRAPH_NODES: usize = 400;

/// `VaultFs`: a filesystem the index walks.
pub trait VaultFs: WikiFs {
    /// `read(path)`
    fn read(&mut self, path: &str) -> Result<String, NodeError>;
    /// `mtimeMs(path)`: 0 where the file cannot be statted
    fn mtime_ms(&mut self, path: &str) -> f64;
}

/// `nodeVaultFs()`
pub struct NodeVaultFs<'a> {
    fs: NodeWikiFs<'a>,
}

pub fn node_vault_fs(now_ms: &dyn Fn() -> f64) -> NodeVaultFs<'_> {
    NodeVaultFs {
        fs: node_fs(now_ms),
    }
}

impl WikiFs for NodeVaultFs<'_> {
    fn is_file(&mut self, path: &str) -> bool {
        self.fs.is_file(path)
    }

    fn list(&mut self, dir: &str) -> Result<Listing, NodeError> {
        self.fs.list(dir)
    }
}

impl VaultFs for NodeVaultFs<'_> {
    fn read(&mut self, path: &str) -> Result<String, NodeError> {
        read_file_utf8(path)
    }

    fn mtime_ms(&mut self, path: &str) -> f64 {
        fs::metadata(namespaced(path)).map_or(0.0, |meta| StatInfo::of(&meta).mtime_ms)
    }
}

/// note files the index walks; media joins the graph only as a link target
fn is_note_ext(ext: &str) -> bool {
    matches!(ext, ".md" | ".markdown" | ".txt")
}

/// The fence a line opens or closes, as the TypeScript's `inFence` walk keeps it.
struct FenceWalk {
    in_fence: bool,
    fence: String,
}

impl FenceWalk {
    fn new() -> Self {
        FenceWalk {
            in_fence: false,
            fence: String::new(),
        }
    }

    /// true when the line is a fence line or inside a fence: it carries nothing
    fn skips(&mut self, line: &str) -> bool {
        let opens = js_regex!(r"^\s{0,3}(```|~~~)");
        if let Some(opens) = opens.exec(line) {
            let marker = opens.get(1).unwrap_or("");
            if !self.in_fence {
                self.in_fence = true;
                self.fence = marker.to_owned();
            } else if marker == self.fence {
                self.in_fence = false;
                self.fence = String::new();
            }
            return true;
        }
        self.in_fence
    }
}

/// `extractWikiTargets(text)`: the wiki targets one document carries, in
/// order, deduplicated.
pub fn extract_wiki_targets(text: &str) -> Vec<String> {
    let code_span = js_regex!(r"`[^`\n]*`", "g");
    let target_re = js_regex!(r"!?\[\[([^[|\n]+?)(?:\|[^[|\n]*)?\]\]", "g");
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut walk = FenceWalk::new();
    for line in text.split('\n') {
        if walk.skips(line) {
            continue;
        }
        let clean = code_span.replace_all(line, |_| " ".to_owned());
        for found in target_re.find_iter(&clean) {
            let target = found.get(1).unwrap_or("");
            if seen.insert(target.to_owned()) {
                out.push(target.to_owned());
            }
        }
    }
    out
}

/// `extractTags(text)`: `#tag` as Obsidian reads it.
pub fn extract_tags(text: &str) -> Vec<String> {
    let code_span = js_regex!(r"`[^`\n]*`", "g");
    let link_dest = js_regex!(r"\]\([^)\n]*\)", "g");
    let autolink = js_regex!(r"<[a-z][a-z0-9+.-]*:[^>\s]*>", "gi");
    let url = js_regex!(r"\b[a-z][a-z0-9+.-]*:\/\/\S+", "gi");
    let tag_re = js_regex!(r"(^|[^\w#/])#(\p{L}[\p{L}\p{N}/_-]*)", "gu");
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut walk = FenceWalk::new();
    for line in text.split('\n') {
        if walk.skips(line) {
            continue;
        }
        let clean = code_span.replace_all(line, |_| " ".to_owned());
        let clean = link_dest.replace_all(&clean, |_| "]".to_owned());
        let clean = autolink.replace_all(&clean, |_| " ".to_owned());
        let clean = url.replace_all(&clean, |_| " ".to_owned());
        for found in tag_re.find_iter(&clean) {
            let tag = found.get(2).unwrap_or("");
            if seen.insert(tag.to_owned()) {
                out.push(tag.to_owned());
            }
        }
    }
    out
}

struct VaultFileEntry {
    mtime_ms: f64,
    /// the targets this file's links carry, deduplicated in order
    targets: Vec<String>,
    /// the #tags this file carries, deduplicated in order
    tags: Vec<String>,
}

#[derive(Clone)]
struct Edge {
    target: String,
    path: String,
}

struct EdgeMemo {
    mtime_ms: f64,
    to: Vec<Edge>,
}

#[derive(Default)]
struct IndexState {
    files: JsMap<VaultFileEntry>,
    /// resolved edges per file, valid for the mtime the file was parsed at
    edges: JsMap<EdgeMemo>,
}

/// The module-level `indexes` map of the TypeScript, per root.
#[derive(Default)]
pub struct WikiIndex {
    indexes: HashMap<String, IndexState>,
}

/// `WikiBacklink`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WikiBacklink {
    /// absolute path of the note whose link lands here
    pub source: String,
    /// the target as written there (`Note#Heading`)
    pub target: String,
}

/// `WikiTagEntry`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WikiTagEntry {
    pub tag: String,
    /// absolute paths of notes carrying the tag, sorted
    pub files: Vec<String>,
}

/// `WikiGraphNode`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WikiGraphNode {
    pub path: String,
    /// stem, the label a node carries
    pub name: String,
    /// path relative to the root, the label's smaller half
    #[serde(rename = "relPath")]
    pub rel_path: String,
}

/// `WikiGraphEdge`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WikiGraphEdge {
    pub from: String,
    pub to: String,
}

/// `WikiGraph`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WikiGraph {
    pub nodes: Vec<WikiGraphNode>,
    pub edges: Vec<WikiGraphEdge>,
    /// the node cap cut the vault short: this is a slice, not the whole graph
    pub truncated: bool,
    /// notes the walk found, which is at least nodes.length and larger when cut
    #[serde(rename = "totalNotes")]
    pub total_notes: usize,
}

/// `a.sort()` of strings: UTF-16 code unit order
fn utf16_order(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

impl WikiIndex {
    pub fn new() -> Self {
        Self::default()
    }

    fn index_for(&mut self, root: &str) -> &mut IndexState {
        self.indexes.entry(root.to_owned()).or_default()
    }

    /// `refreshFiles(root, fs)`: walk the vault's notes, re-reading only what
    /// changed since the last build.
    fn refresh_files(&mut self, root: &str, fs: &mut dyn VaultFs) {
        let state = self.index_for(root);
        let mut seen: HashSet<String> = HashSet::new();
        // taken BEFORE the walk
        let before: HashSet<String> = state.files.keys().map(str::to_owned).collect();
        let mut set_moved = false;
        let mut queue: Vec<(String, usize)> = vec![(root.to_owned(), 0)];
        let mut budget = (MAX_INDEX_FILES * 4) as i64;
        while !queue.is_empty() && seen.len() < MAX_INDEX_FILES && budget > 0 {
            let mut next: Vec<(String, usize)> = Vec::new();
            for (dir, depth) in &queue {
                let Ok(listing) = fs.list(dir) else {
                    continue;
                };
                budget -= (listing.files.len() + listing.dirs.len()) as i64;
                for file in &listing.files {
                    if !is_note_ext(&extname(file).to_lowercase()) {
                        continue;
                    }
                    let path = join(&[dir, file]);
                    if seen.contains(&path) {
                        continue;
                    }
                    seen.insert(path.clone());
                    let mtime_ms = fs.mtime_ms(&path);
                    if state
                        .files
                        .get(&path)
                        .is_some_and(|known| known.mtime_ms == mtime_ms)
                    {
                        continue;
                    }
                    // unreadable this round; the next one retries
                    let Ok(text) = fs.read(&path) else {
                        continue;
                    };
                    let targets = extract_wiki_targets(&text);
                    let tags = extract_tags(&text);
                    state.files.set(
                        &path,
                        VaultFileEntry {
                            mtime_ms,
                            targets,
                            tags,
                        },
                    );
                    state.edges.delete(&path);
                }
                if seen.len() >= MAX_INDEX_FILES || depth + 1 > MAX_DEPTH {
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
        // A memoized edge answers "does this target exist?", so it is only
        // valid while the file SET is what it was resolved against.
        let known: Vec<String> = state.files.keys().map(str::to_owned).collect();
        for path in known {
            if !seen.contains(&path) {
                state.files.delete(&path);
                set_moved = true;
            }
        }
        // compare the paths, not the sizes
        if seen.iter().any(|path| !before.contains(path)) {
            set_moved = true;
        }
        if set_moved {
            state.edges.clear();
        }
    }

    /// `refreshEdges(root, fs)`: resolve every link in the vault to the note
    /// it lands on, memoised per file mtime.
    fn refresh_edges(&mut self, root: &str, fs: &mut dyn VaultFs) -> JsMap<Vec<Edge>> {
        self.refresh_files(root, fs);
        let files: Vec<(String, f64, Vec<String>)> = self
            .index_for(root)
            .files
            .iter()
            .map(|(path, entry)| (path.to_owned(), entry.mtime_ms, entry.targets.clone()))
            .collect();
        let mut out: JsMap<Vec<Edge>> = JsMap::new();
        for (path, mtime_ms, targets) in files {
            if let Some(done) = self.index_for(root).edges.get(&path)
                && done.mtime_ms == mtime_ms
            {
                out.set(&path, done.to.clone());
                continue;
            }
            let answers = if targets.is_empty() {
                None
            } else {
                Some(resolve_wiki_links(
                    &targets,
                    &ResolveOptions {
                        from_path: &path,
                        root,
                    },
                    fs,
                ))
            };
            let mut to: Vec<Edge> = Vec::new();
            if let Some(answers) = &answers {
                for (target, answer) in answers.iter() {
                    if answer.found && !answer.path.is_empty() && answer.path != path {
                        to.push(Edge {
                            target: target.to_owned(),
                            path: answer.path.clone(),
                        });
                    }
                }
            }
            self.index_for(root).edges.set(
                &path,
                EdgeMemo {
                    mtime_ms,
                    to: to.clone(),
                },
            );
            out.set(&path, to);
        }
        out
    }

    /// `wikiBacklinks(root, path, fs)`: every note whose link resolves to `path`.
    pub fn wiki_backlinks(
        &mut self,
        root: &str,
        path: &str,
        fs: &mut dyn VaultFs,
    ) -> Vec<WikiBacklink> {
        if path.is_empty() {
            return Vec::new();
        }
        let edges = self.refresh_edges(root, fs);
        let mut out: Vec<WikiBacklink> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for (source, list) in edges.iter() {
            for edge in list {
                if edge.path != path {
                    continue;
                }
                let key = format!("{source}\u{0}{}", edge.target);
                if !seen.insert(key) {
                    continue;
                }
                out.push(WikiBacklink {
                    source: source.to_owned(),
                    target: edge.target.clone(),
                });
            }
        }
        out
    }

    /// `wikiTags(root, fs)`: every #tag in the vault with the notes that
    /// carry it, most-used first.
    pub fn wiki_tags(&mut self, root: &str, fs: &mut dyn VaultFs) -> Vec<WikiTagEntry> {
        self.refresh_files(root, fs);
        let mut by_tag: JsMap<Vec<String>> = JsMap::new();
        for (path, entry) in self.index_for(root).files.iter() {
            for tag in &entry.tags {
                if let Some(list) = by_tag.get_mut(tag) {
                    list.push(path.to_owned());
                } else {
                    by_tag.set(tag, vec![path.to_owned()]);
                }
            }
        }
        let mut entries: Vec<WikiTagEntry> = by_tag
            .iter()
            .map(|(tag, files)| {
                let mut files = files.clone();
                files.sort_by(|a, b| utf16_order(a, b));
                WikiTagEntry {
                    tag: tag.to_owned(),
                    files,
                }
            })
            .collect();
        entries.sort_by(|a, b| {
            let by_count = b.files.len().cmp(&a.files.len());
            if by_count.is_ne() {
                by_count
            } else if string_less_than(&a.tag, &b.tag) {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        });
        entries
    }

    /// `wikiGraph(root, fs)`: the vault as nodes and edges.
    pub fn wiki_graph(&mut self, root: &str, fs: &mut dyn VaultFs) -> WikiGraph {
        let edges = self.refresh_edges(root, fs);
        let mut nodes: Vec<WikiGraphNode> = Vec::new();
        let state = self.index_for(root);
        let total_notes = state.files.len();
        for path in state.files.keys() {
            nodes.push(WikiGraphNode {
                path: path.to_owned(),
                name: basename(path, Some(&extname(path))),
                rel_path: relative(root, path),
            });
            if nodes.len() >= MAX_GRAPH_NODES {
                break;
            }
        }
        let node_set: HashSet<&str> = nodes.iter().map(|node| node.path.as_str()).collect();
        let mut out: Vec<WikiGraphEdge> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for (from, list) in edges.iter() {
            if !node_set.contains(from) {
                continue;
            }
            for edge in list {
                if !node_set.contains(edge.path.as_str()) {
                    continue;
                }
                let key = format!("{from}\u{0}{}", edge.path);
                if !seen.insert(key) {
                    continue;
                }
                out.push(WikiGraphEdge {
                    from: from.to_owned(),
                    to: edge.path.clone(),
                });
            }
        }
        // a cut graph is a slice: say so
        let truncated = total_notes > nodes.len();
        WikiGraph {
            nodes,
            edges: out,
            truncated,
            total_notes,
        }
    }

    /// `warmWikiIndex(root, fs)`: a build whose answer nobody waits for.
    pub fn warm_wiki_index(&mut self, root: &str, fs: &mut dyn VaultFs) {
        if root.is_empty() {
            return;
        }
        self.refresh_edges(root, fs);
    }
}
