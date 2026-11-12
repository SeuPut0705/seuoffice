//! `apps/shell/src/main/update-notes.ts`: the release body of the update
//! feed as a small block tree. `parse5`'s `parseFragment` is
//! [`crate::html::parse_fragment`].

use crate::html::{self, Node};
use jscompat::{js_regex, slice_utf16, trim};
use serde::Serialize;
use serde_json::Value;

/// raw feed content beyond this is cut before parsing
pub const MAX_RAW_CHARS: usize = 256 * 1024;
/// total characters of converted note text; trailing content is dropped to fit
pub const MAX_TOTAL_CHARS: usize = 48_000;
pub const MAX_SECTIONS: usize = 12;
pub const MAX_VERSION_CHARS: usize = 64;

const SKIP_TAGS: [&str; 3] = ["script", "style", "img"];

/// `UpdateNoteRun`: `strong` and `code` are only written when true.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UpdateNoteRun {
    pub text: String,
    #[serde(skip_serializing_if = "is_false")]
    pub strong: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub code: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// `UpdateNoteBlock`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum UpdateNoteBlock {
    Heading {
        level: u8,
        runs: Vec<UpdateNoteRun>,
    },
    Paragraph {
        runs: Vec<UpdateNoteRun>,
    },
    List {
        ordered: bool,
        items: Vec<Vec<UpdateNoteRun>>,
    },
}

/// `UpdateNoteSection`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UpdateNoteSection {
    pub version: Option<String>,
    pub blocks: Vec<UpdateNoteBlock>,
}

/// `UpdateReleaseNotes`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UpdateReleaseNotes {
    pub sections: Vec<UpdateNoteSection>,
    pub truncated: bool,
}

#[derive(Clone, Copy, Default)]
struct RunFlags {
    strong: bool,
    code: bool,
}

fn run(text: &str, strong: bool, code: bool) -> UpdateNoteRun {
    UpdateNoteRun {
        text: text.to_string(),
        strong,
        code,
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The children of a parse5 element (empty for a `template`, as there).
fn children_of(node: &Node) -> &[Node] {
    match node {
        Node::Element(element) => &element.children,
        _ => &[],
    }
}

/// The lower-cased `tagName` of an element node.
fn tag_of(node: &Node) -> Option<String> {
    match node {
        Node::Element(element) => Some(element.name.to_lowercase()),
        _ => None,
    }
}

/// `normalizeReleaseNotes`; `input` is `UpdateInfo.releaseNotes` as JSON.
pub fn normalize_release_notes(input: &Value) -> Option<UpdateReleaseNotes> {
    let notes = note_inputs(input);
    if notes.is_empty() {
        return None;
    }

    let mut truncated = notes.len() > MAX_SECTIONS;
    let mut sections: Vec<UpdateNoteSection> = Vec::new();
    for (version, note_html) in notes.into_iter().take(MAX_SECTIONS) {
        let mut html = note_html;
        if utf16_len(&html) > MAX_RAW_CHARS {
            html = slice_utf16(&html, 0.0, Some(MAX_RAW_CHARS as f64));
            truncated = true;
        }
        let blocks = html_to_blocks(&html);
        if !blocks.is_empty() {
            sections.push(UpdateNoteSection { version, blocks });
        }
    }
    if sections.is_empty() {
        return None;
    }

    let (capped, capped_truncated) = cap_total_chars(sections);
    let kept: Vec<UpdateNoteSection> = capped
        .into_iter()
        .filter(|section| !section.blocks.is_empty())
        .collect();
    if kept.is_empty() {
        return None;
    }
    Some(UpdateReleaseNotes {
        sections: kept,
        truncated: truncated || capped_truncated,
    })
}

/// `noteInputs`: `(version, html)` pairs.
fn note_inputs(input: &Value) -> Vec<(Option<String>, String)> {
    if let Value::String(s) = input {
        return if has_content(s) {
            vec![(None, s.clone())]
        } else {
            Vec::new()
        };
    }
    let Value::Array(items) = input else {
        return Vec::new();
    };
    let mut notes = Vec::new();
    for item in items {
        // `item === null || typeof item !== 'object'`; an array is an object
        // whose `note` is undefined
        let Value::Object(map) = item else { continue };
        let Some(Value::String(note)) = map.get("note") else {
            continue;
        };
        if !has_content(note) {
            continue;
        }
        let version = match map.get("version") {
            Some(Value::String(v)) if !trim(v).is_empty() => {
                Some(slice_utf16(trim(v), 0.0, Some(MAX_VERSION_CHARS as f64)))
            }
            _ => None,
        };
        notes.push((version, note.clone()));
    }
    notes
}

/// `hasContent`: GitHub reports a release without a body as "No content."
fn has_content(html: &str) -> bool {
    let trimmed = trim(html);
    !trimmed.is_empty() && trimmed != "No content."
}

/// `htmlToBlocks`
fn html_to_blocks(html: &str) -> Vec<UpdateNoteBlock> {
    let fragment = html::parse_fragment(html);
    let mut blocks = Vec::new();
    collect_blocks(&fragment, &mut blocks);
    blocks
}

fn text_of(node: &Node) -> Option<String> {
    match node {
        Node::Text(value) => Some(value.clone()),
        _ => None,
    }
}

/// `collectBlocks`
fn collect_blocks(nodes: &[Node], blocks: &mut Vec<UpdateNoteBlock>) {
    for node in nodes {
        if let Some(value) = text_of(node) {
            // the newlines GitHub puts between block tags are not paragraphs
            let text = trim(&inline_text(&value)).to_string();
            if !text.is_empty() {
                blocks.push(UpdateNoteBlock::Paragraph {
                    runs: vec![run(&text, false, false)],
                });
            }
            continue;
        }
        let Some(tag) = tag_of(node) else { continue };
        if SKIP_TAGS.contains(&tag.as_str()) {
            continue;
        }
        // HEADING_RE = /^h([1-6])$/
        if tag.len() == 2 && tag.starts_with('h') && matches!(tag.as_bytes()[1], b'1'..=b'6') {
            let digit = &tag[1..];
            let runs = finalize_runs(collect_runs(children_of(node), RunFlags::default()));
            if !runs.is_empty() {
                blocks.push(UpdateNoteBlock::Heading {
                    level: heading_level(digit),
                    runs,
                });
            }
            continue;
        }
        match tag.as_str() {
            "p" | "blockquote" => {
                let runs = finalize_runs(collect_runs(children_of(node), RunFlags::default()));
                if !runs.is_empty() {
                    blocks.push(UpdateNoteBlock::Paragraph { runs });
                }
            }
            "ul" | "ol" => {
                let items = list_items(node);
                if !items.is_empty() {
                    blocks.push(UpdateNoteBlock::List {
                        ordered: tag == "ol",
                        items,
                    });
                }
            }
            "pre" => {
                let raw = raw_text(node);
                let text = raw.trim_start_matches('\n');
                let text = text.trim_end_matches([' ', '\n']);
                if !text.is_empty() {
                    blocks.push(UpdateNoteBlock::Paragraph {
                        runs: vec![run(text, false, true)],
                    });
                }
            }
            // div, details, table...: keep their blocks, drop the wrapper
            _ => collect_blocks(children_of(node), blocks),
        }
    }
}

/// `headingLevel`
fn heading_level(value: &str) -> u8 {
    let level = jscompat::to_number(value);
    if level <= 1.0 {
        1
    } else if level == 2.0 {
        2
    } else {
        3
    }
}

/// `listItems`
fn list_items(node: &Node) -> Vec<Vec<UpdateNoteRun>> {
    let mut items = Vec::new();
    for child in children_of(node) {
        if tag_of(child).as_deref() != Some("li") {
            continue;
        }
        let runs = finalize_runs(collect_runs(children_of(child), RunFlags::default()));
        if !runs.is_empty() {
            items.push(runs);
        }
    }
    items
}

/// `collectRuns`: the inline runs of one block, nested lists flattened into text.
fn collect_runs(nodes: &[Node], flags: RunFlags) -> Vec<UpdateNoteRun> {
    let mut runs = Vec::new();
    walk_runs(nodes, flags, &mut runs);
    runs
}

fn push_run(runs: &mut Vec<UpdateNoteRun>, text: &str, flags: RunFlags) {
    if text.is_empty() {
        return;
    }
    runs.push(run(text, flags.strong, flags.code));
}

fn walk_runs(list: &[Node], f: RunFlags, runs: &mut Vec<UpdateNoteRun>) {
    for node in list {
        if let Some(value) = text_of(node) {
            push_run(runs, &inline_text(&value), f);
            continue;
        }
        let Some(tag) = tag_of(node) else { continue };
        if SKIP_TAGS.contains(&tag.as_str()) {
            continue;
        }
        match tag.as_str() {
            "br" => push_run(runs, "\n", f),
            "strong" | "b" => walk_runs(children_of(node), RunFlags { strong: true, ..f }, runs),
            "code" => walk_runs(children_of(node), RunFlags { code: true, ..f }, runs),
            "ul" | "ol" => {
                for item in list_items(node) {
                    push_run(runs, "\n", f);
                    for r in &item {
                        push_run(
                            runs,
                            &r.text,
                            RunFlags {
                                strong: r.strong,
                                code: r.code,
                            },
                        );
                    }
                }
            }
            // a, em, span, del, unknown: keep the text, whatever the wrapper
            _ => walk_runs(children_of(node), f, runs),
        }
    }
}

/// `finalizeRuns`: merges adjacent runs with equal flags and trims the edges
fn finalize_runs(raw: Vec<UpdateNoteRun>) -> Vec<UpdateNoteRun> {
    let mut runs: Vec<UpdateNoteRun> = Vec::new();
    for r in raw {
        let mut text = r.text.clone();
        if let Some(prev) = runs.last()
            && prev.text.ends_with([' ', '\n'])
        {
            text = text.trim_start_matches(' ').to_string();
        }
        if text.is_empty() {
            continue;
        }
        if let Some(prev) = runs.last_mut()
            && prev.strong == r.strong
            && prev.code == r.code
        {
            prev.text.push_str(&text);
            continue;
        }
        runs.push(run(&text, r.strong, r.code));
    }
    while let Some(first) = runs.first_mut() {
        first.text = first.text.trim_start_matches([' ', '\n']).to_string();
        if first.text.is_empty() {
            runs.remove(0);
        } else {
            break;
        }
    }
    while let Some(last) = runs.last_mut() {
        last.text = last.text.trim_end_matches([' ', '\n']).to_string();
        if last.text.is_empty() {
            runs.pop();
        } else {
            break;
        }
    }
    runs
}

/// `inlineText`
fn inline_text(value: &str) -> String {
    js_regex!(r"\s+", "g").replace_all(value, |_| " ".to_string())
}

/// `rawText`: text of a `<pre>` as written, newlines kept
fn raw_text(node: &Node) -> String {
    fn walk(list: &[Node], out: &mut String) {
        for child in list {
            if let Some(value) = text_of(child) {
                out.push_str(&value);
                continue;
            }
            let Some(tag) = tag_of(child) else { continue };
            if SKIP_TAGS.contains(&tag.as_str()) {
                continue;
            }
            if tag == "br" {
                out.push('\n');
            } else {
                walk(children_of(child), out);
            }
        }
    }
    let mut out = String::new();
    walk(children_of(node), &mut out);
    out
}

/// `capTotalChars`
fn cap_total_chars(sections: Vec<UpdateNoteSection>) -> (Vec<UpdateNoteSection>, bool) {
    let mut total = count_chars(&sections);
    if total <= MAX_TOTAL_CHARS {
        return (sections, false);
    }
    let mut trimmed = sections;
    while total > MAX_TOTAL_CHARS {
        let Some(section) = trimmed.last() else { break };
        if section.blocks.is_empty() {
            trimmed.pop();
            continue;
        }
        let with_blocks: Vec<&UpdateNoteSection> =
            trimmed.iter().filter(|c| !c.blocks.is_empty()).collect();
        let single = with_blocks.len() == 1 && with_blocks[0].blocks.len() == 1;
        let section = trimmed.last_mut().expect("checked above");
        let index = section.blocks.len() - 1;
        if single {
            // a single runaway block must not disappear whole: keep its head
            let cut = block_within_budget(&section.blocks[index], MAX_TOTAL_CHARS);
            section.blocks[index] = cut;
            break;
        }
        if let UpdateNoteBlock::List { items, .. } = &mut section.blocks[index]
            && items.len() > 1
        {
            let item = items.pop().expect("more than one item");
            total -= count_runs(&item);
            continue;
        }
        let block = section.blocks.remove(index);
        total -= count_block(&block);
    }
    (trimmed, true)
}

/// `blockWithinBudget`: a copy of the block cut to at most `budget` characters
fn block_within_budget(block: &UpdateNoteBlock, budget: usize) -> UpdateNoteBlock {
    match block {
        UpdateNoteBlock::List { ordered, items } => {
            let mut kept_items = Vec::new();
            let mut used = 0usize;
            for item in items {
                let kept = runs_within_budget(item, budget.saturating_sub(used));
                if kept.is_empty() {
                    break;
                }
                used += count_runs(&kept);
                kept_items.push(kept);
            }
            UpdateNoteBlock::List {
                ordered: *ordered,
                items: kept_items,
            }
        }
        UpdateNoteBlock::Heading { level, runs } => UpdateNoteBlock::Heading {
            level: *level,
            runs: runs_within_budget(runs, budget),
        },
        UpdateNoteBlock::Paragraph { runs } => UpdateNoteBlock::Paragraph {
            runs: runs_within_budget(runs, budget),
        },
    }
}

/// `runsWithinBudget`
fn runs_within_budget(runs: &[UpdateNoteRun], budget: usize) -> Vec<UpdateNoteRun> {
    let mut kept = Vec::new();
    let mut used = 0usize;
    for r in runs {
        if used >= budget {
            break;
        }
        let text = slice_utf16(&r.text, 0.0, Some((budget - used) as f64));
        if text.is_empty() {
            continue;
        }
        used += utf16_len(&text);
        kept.push(run(&text, r.strong, r.code));
    }
    kept
}

/// `countChars`
fn count_chars(sections: &[UpdateNoteSection]) -> usize {
    sections
        .iter()
        .flat_map(|section| section.blocks.iter())
        .map(count_block)
        .sum()
}

/// `countBlock`
fn count_block(block: &UpdateNoteBlock) -> usize {
    match block {
        UpdateNoteBlock::List { items, .. } => items.iter().map(|item| count_runs(item)).sum(),
        UpdateNoteBlock::Heading { runs, .. } | UpdateNoteBlock::Paragraph { runs } => {
            count_runs(runs)
        }
    }
}

/// `countRuns`
fn count_runs(runs: &[UpdateNoteRun]) -> usize {
    runs.iter().map(|r| utf16_len(&r.text)).sum()
}
