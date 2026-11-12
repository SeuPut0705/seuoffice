//! `apps/markdown/src/main/wiki-notes.ts`: listing the vault's notes for the
//! `[[` suggester, in the resolver's own breadth-first order.

use jscompat::node_path::host::{basename, extname, join, relative};
use serde::Serialize;

use super::wiki_resolve::{MAX_DEPTH, WikiFs, is_skip_dir};

/// `WikiNoteEntry`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WikiNoteEntry {
    /// absolute path, the shape `resolveWikiLinks` answers with
    pub path: String,
    /// file name with extension, as `[[Figure 1.png]]` addresses it
    pub file: String,
    /// stem without extension, as a bare `[[Figure 1]]` addresses it
    pub name: String,
    /// path relative to the walk root, shown under the name in the menu
    #[serde(rename = "relPath")]
    pub rel_path: String,
}

/// entries one listing may return, so a huge library cannot stall the popup
pub const MAX_NOTES: f64 = 2000.0;

/// file types the suggester offers; resolution's NOTE_EXTS plus embeddable media
const SUGGEST_EXTS: [&str; 12] = [
    ".md",
    ".markdown",
    ".txt",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".bmp",
    ".avif",
    ".ico",
];

/// `listWikiNotes(root, fs, cap)`; `cap` is a number the TypeScript compares
/// as it is (NaN, a fraction, an infinity)
pub fn list_wiki_notes(root: &str, fs: &mut dyn WikiFs, cap: f64) -> Vec<WikiNoteEntry> {
    let mut out: Vec<WikiNoteEntry> = Vec::new();
    if root.is_empty() {
        return out;
    }
    let mut queue: Vec<(String, usize)> = vec![(root.to_owned(), 0)];
    let mut budget = cap * 4.0;
    while !queue.is_empty() && (out.len() as f64) < cap && budget > 0.0 {
        let mut next: Vec<(String, usize)> = Vec::new();
        for (dir, depth) in &queue {
            // unreadable directory, same as an unplugged root
            let Ok(listing) = fs.list(dir) else {
                continue;
            };
            budget -= (listing.files.len() + listing.dirs.len()) as f64;
            for file in &listing.files {
                if !SUGGEST_EXTS.contains(&extname(file).to_lowercase().as_str()) {
                    continue;
                }
                let path = join(&[dir, file]);
                out.push(WikiNoteEntry {
                    file: file.clone(),
                    name: basename(file, Some(&extname(file))),
                    rel_path: relative(root, &path),
                    path,
                });
                if out.len() as f64 >= cap {
                    break;
                }
            }
            if out.len() as f64 >= cap || depth + 1 > MAX_DEPTH {
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
    out
}
