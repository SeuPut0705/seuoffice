//! `apps/markdown/src/main/wiki-heads.ts`: what `[[Note#` offers, the target
//! note's headings and the block ids it already carries.

use jscompat::js_regex;
use jscompat::{is_js_space, trim};
use serde::Serialize;

use super::fs_util::read_file_utf8;
use super::wiki_resolve::{ResolveOptions, WikiFs, resolve_wiki_links};

/// each kind is capped on its own, so a heading-heavy file still shows its blocks
pub const MAX_HEAD_ENTRIES_PER_KIND: usize = 200;

/// `WikiHeadEntry`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WikiHeadEntry {
    Heading { text: String, level: usize },
    Block { id: String, text: String },
}

fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_space)
}

/// `parseWikiHeads(raw)`: headings and block ids of a note's raw text, in
/// document order.
pub fn parse_wiki_heads(raw: &str) -> Vec<WikiHeadEntry> {
    let heading_re = js_regex!(r"^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$");
    let fence_re = js_regex!(r"^ {0,3}(`{3,}|~{3,})");
    let trailing_id_re = js_regex!(r"(?:^|\s)\^([A-Za-z0-9-]+)\s*$");
    let lone_id_re = js_regex!(r"^\^([A-Za-z0-9-]+)\s*$");
    let heading_marker_re = js_regex!(r"\s*\^[A-Za-z0-9-]+\s*$");

    let lines: Vec<&str> = raw.split('\n').collect();
    let mut out: Vec<WikiHeadEntry> = Vec::new();
    let mut headings = 0usize;
    let mut blocks = 0usize;
    let mut fence: Option<&str> = None;
    // `---` frontmatter opens the file; skip through its closing fence
    let mut at = 0usize;
    if lines.first().is_some_and(|line| trim_end(line) == "---") {
        at = 1;
        while at < lines.len() && trim_end(lines[at]) != "---" {
            at += 1;
        }
        at += 1;
    }
    // the last non-blank line outside fences
    let mut previous = "";
    while at < lines.len() {
        let line = lines[at];
        at += 1;
        let open = fence_re.exec(line);
        if let Some(opened) = fence {
            // the closing fence is the same character, at least as long, with no info string
            if let Some(run) = open.as_ref().and_then(|m| m.get(1))
                && !run.is_empty()
                && run.as_bytes()[0] == opened.as_bytes()[0]
                && run.len() >= opened.len()
                && trim(line) == run
            {
                fence = None;
                previous = "";
            }
            continue;
        }
        if let Some(open) = open {
            fence = open.get(1);
            previous = "";
            continue;
        }
        if trim(line).is_empty() {
            continue;
        }
        if let Some(lone) = lone_id_re.exec(line) {
            if blocks < MAX_HEAD_ENTRIES_PER_KIND {
                out.push(WikiHeadEntry::Block {
                    id: lone.get(1).unwrap_or("").to_owned(),
                    text: previous.to_owned(),
                });
                blocks += 1;
            }
            previous = line;
            continue;
        }
        if let Some(heading) = heading_re.exec(line) {
            let hashes = heading.get(1).unwrap_or("");
            let body = heading.get(2).unwrap_or("");
            // a heading line may carry its own marker; the heading is addressed
            // by its text, the marker is a block id on the heading
            let marker = trailing_id_re.exec(body);
            let text = match heading_marker_re.exec(body) {
                Some(m) => format!("{}{}", &body[..m.start()], &body[m.end()..]),
                None => body.to_owned(),
            };
            let text = trim(&text);
            if !text.is_empty() {
                if headings < MAX_HEAD_ENTRIES_PER_KIND {
                    out.push(WikiHeadEntry::Heading {
                        text: text.to_owned(),
                        level: hashes.encode_utf16().count(),
                    });
                    headings += 1;
                }
                if let Some(marker) = marker
                    && blocks < MAX_HEAD_ENTRIES_PER_KIND
                {
                    out.push(WikiHeadEntry::Block {
                        id: marker.get(1).unwrap_or("").to_owned(),
                        // marker.index sits inside the heading text, not the line
                        text: trim(&format!("{hashes} {}", trim(&body[..marker.start()])))
                            .to_owned(),
                    });
                    blocks += 1;
                }
            }
            previous = line;
            continue;
        }
        if let Some(trailing) = trailing_id_re.exec(line)
            && blocks < MAX_HEAD_ENTRIES_PER_KIND
        {
            out.push(WikiHeadEntry::Block {
                id: trailing.get(1).unwrap_or("").to_owned(),
                text: trim(&line[..trailing.start()]).to_owned(),
            });
            blocks += 1;
        }
        previous = line;
    }
    out
}

/// `wikiHeads(target, fromPath, root)`: resolve the typed target the way the
/// resolver does, then parse that file.
pub fn wiki_heads(
    target: &str,
    from_path: &str,
    root: &str,
    fs: &mut dyn WikiFs,
) -> Vec<WikiHeadEntry> {
    if target.is_empty() {
        return Vec::new();
    }
    let resolved = resolve_wiki_links(
        &[target.to_owned()],
        &ResolveOptions { from_path, root },
        fs,
    );
    let Some(hit) = resolved.get(target).filter(|hit| hit.found) else {
        return Vec::new();
    };
    match read_file_utf8(&hit.path) {
        Ok(raw) => parse_wiki_heads(&raw),
        Err(_) => Vec::new(),
    }
}
