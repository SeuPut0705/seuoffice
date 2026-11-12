//! compare.ts: the redline of two documents, as the save plan that writes it.

use std::collections::HashMap;

use jscompat::serde::Serialize;
use jscompat::{JsNum, is_js_space, js_regex, number_to_string, slice_utf16, trim};

use crate::inline_opaque::run_copied_elsewhere;
use crate::model::{
    Block, BlockBlockRevisionKind, BlockListKind, BlockType, GeneratedBlock, GeneratedBlockList,
    GeneratedBlockListKind, GeneratedBlockType, ParsedDocFull, RevisionInfo, Run,
};
use crate::save::save::{RevisionKind, SaveBlock, SaveBlockKind, SaveRevision};

/// `CompareGranularity`: at what granularity a changed paragraph is diffed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareGranularity {
    Word,
    Char,
}

/// `CompareIgnore`: what the comparison leaves out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareIgnore {
    Formatting,
    Case,
    Whitespace,
}

/// `CompareOptions`
#[derive(Debug, Clone, Default)]
pub struct CompareOptions {
    /// author recorded on every revision; default "SeuOffice"
    pub author: Option<String>,
    /// ISO timestamp recorded on every revision; default: now
    pub date: Option<String>,
    /// default "word"
    pub granularity: Option<CompareGranularity>,
    /// default: nothing is ignored
    pub ignore: Vec<CompareIgnore>,
}

impl CompareOptions {
    /// The options a JSON object names, as the TypeScript reads `options`: a
    /// field of another type is absent, an `ignore` entry that names no rule is
    /// skipped and any granularity but "char" is "word".
    pub fn from_json(options: Option<&serde_json::Value>) -> Self {
        let text_of = |name: &str| {
            options
                .and_then(|options| options.get(name))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        };
        let ignore = options
            .and_then(|options| options.get("ignore"))
            .and_then(serde_json::Value::as_array)
            .map(|names| {
                names
                    .iter()
                    .filter_map(|name| match name.as_str() {
                        Some("formatting") => Some(CompareIgnore::Formatting),
                        Some("case") => Some(CompareIgnore::Case),
                        Some("whitespace") => Some(CompareIgnore::Whitespace),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            author: text_of("author"),
            date: text_of("date"),
            granularity: (text_of("granularity").as_deref() == Some("char"))
                .then_some(CompareGranularity::Char),
            ignore,
        }
    }
}

/// `CompareSummary`
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(crate = "jscompat::serde", rename_all = "camelCase")]
pub struct CompareSummary {
    /// paragraphs the revised document adds
    pub inserted_paragraphs: u32,
    /// paragraphs the revised document drops
    pub deleted_paragraphs: u32,
    /// paragraphs both have, with a different content
    pub changed_paragraphs: u32,
    /// paragraphs both have, identical
    pub unchanged_paragraphs: u32,
    /// inserted text regions (w:ins)
    pub insertions: u32,
    /// deleted text regions (w:del)
    pub deletions: u32,
}

/// What `compareBlocks` returns.
#[derive(Debug, Clone, Serialize)]
#[serde(crate = "jscompat::serde", rename_all = "camelCase")]
pub struct ComparePlan {
    pub blocks: Vec<SaveBlock>,
    pub summary: CompareSummary,
    pub next_revision_id: JsNum,
}

struct Rules {
    ignore_case: bool,
    ignore_whitespace: bool,
    ignore_formatting: bool,
}

/// one comparable unit of a document: a text paragraph, or a table / picture block
struct Unit<'a> {
    block: &'a Block,
    /// the comparable text: the paragraph text, or a table's cell texts
    text: String,
}

/// An entry of the alignment, by the indexes of its units.
#[derive(Clone, Copy)]
enum Aligned {
    Pair(usize, usize),
    Removed(usize),
    Added(usize),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChunkKind {
    Keep,
    Del,
    Ins,
}

/// a piece of the compared paragraph: text kept, deleted or inserted
#[derive(Clone, Copy)]
struct Chunk {
    kind: ChunkKind,
    /// char range in the original text
    left: Option<(usize, usize)>,
    /// char range in the revised text
    right: Option<(usize, usize)>,
}

struct Token {
    text: Vec<u16>,
    /// char offset in the paragraph text
    start: usize,
    end: usize,
}

/// below this share of common words two paragraphs are unrelated, not an edit
const PAIR_THRESHOLD: f64 = 0.6;

/// `DEFAULT_COMPARE_AUTHOR`: the author recorded when the caller names none
pub const DEFAULT_COMPARE_AUTHOR: &str = "SeuOffice";

/// cells of the LCS table a gap between two unique anchors may cost before it is left unanchored
const LCS_GAP_CELLS: usize = 4_000_000;

/// stands in for a picture in the compared text, so a picture is a token the diff keeps or moves
const PICTURE_TOKEN: &str = "\u{FFFC}";

/// `block.originalXml ?? ''`
/// A kept span: the left and right `(run, offset)` ends it covers.
type KeepSpan = ((usize, usize), (usize, usize));

fn original_xml_of(block: &Block) -> &str {
    block
        .original_xml
        .as_ref()
        .and_then(|xml| xml.as_deref())
        .unwrap_or("")
}

/// `block.docxIndex`: the body index, `None` for a block that has none (null).
fn docx_index_of(block: &Block) -> Option<JsNum> {
    (*block.docx_index).flatten()
}

fn run_text(run: &Run) -> &str {
    run.text.as_deref().unwrap_or("")
}

fn units_of_str(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `compareBlocks`: the save plan of a comparison, for a caller that writes the
/// file itself. `now` is what `new Date().toISOString()` gives: the engine has
/// no clock.
pub fn compare_blocks(
    original: &ParsedDocFull,
    revised: &ParsedDocFull,
    options: &CompareOptions,
    now: &str,
) -> ComparePlan {
    compare_block_lists(
        &original.blocks,
        &revised.blocks,
        &revised.internal.document_xml,
        options,
        now,
    )
}

/// `compareBlocks` over what it reads of the two documents: their blocks and
/// the revised document's XML (the revision ids it already uses).
pub fn compare_block_lists(
    original: &[Block],
    revised: &[Block],
    revised_document_xml: &str,
    options: &CompareOptions,
    now: &str,
) -> ComparePlan {
    let rules = Rules {
        ignore_case: options.ignore.contains(&CompareIgnore::Case),
        ignore_whitespace: options.ignore.contains(&CompareIgnore::Whitespace),
        ignore_formatting: options.ignore.contains(&CompareIgnore::Formatting),
    };
    let author = options
        .author
        .as_deref()
        .map(trim)
        .filter(|author| !author.is_empty())
        .unwrap_or(DEFAULT_COMPARE_AUTHOR)
        .to_owned();
    let date = options
        .date
        .as_deref()
        .filter(|date| !date.is_empty())
        .unwrap_or(now)
        .to_owned();
    let granularity = if options.granularity == Some(CompareGranularity::Char) {
        CompareGranularity::Char
    } else {
        CompareGranularity::Word
    };
    let mut ids = RevisionIds::new(revised_document_xml);

    let left = units_of(original);
    let right = units_of(revised);
    let aligned = align_units(&left, &right, &rules);

    let mut blocks = Vec::new();
    let mut summary = CompareSummary::default();

    for entry in aligned {
        match entry {
            Aligned::Pair(l, r) => {
                let left_block = left[l].block;
                let right_block = right[r].block;
                if let (Some(left_runs), Some(right_runs)) =
                    (left_block.runs.as_ref(), right_block.runs.as_ref())
                {
                    let left_runs = comparable_runs(left_runs);
                    let right_runs = comparable_runs(right_runs);
                    let chunks = paragraph_chunks(&left_runs, &right_runs, granularity, &rules);
                    if !has_revision(&chunks) {
                        summary.unchanged_paragraphs += 1;
                        blocks.push(original_passthrough(right_block));
                        continue;
                    }
                    summary.changed_paragraphs += 1;
                    let mut runs: Vec<Run> = Vec::new();
                    for chunk in &chunks {
                        if chunk.kind == ChunkKind::Keep {
                            let (from, to) = chunk.right.unwrap_or((0, 0));
                            runs.extend(
                                slice_runs(&right_runs, from, to)
                                    .into_iter()
                                    .map(emitted_run),
                            );
                            continue;
                        }
                        let info = RevisionInfo {
                            author: author.clone(),
                            date: Some(date.clone()),
                            date_utc: None,
                            id: Some(ids.take()),
                            r#move: None,
                        };
                        if chunk.kind == ChunkKind::Del {
                            summary.deletions += 1;
                            let (from, to) = chunk.left.unwrap_or((0, 0));
                            for run in slice_runs(&left_runs, from, to) {
                                let mut run = foreign_run(&run);
                                run.del.set(info.clone());
                                runs.push(run);
                            }
                        } else {
                            summary.insertions += 1;
                            let (from, to) = chunk.right.unwrap_or((0, 0));
                            for run in slice_runs(&right_runs, from, to) {
                                let mut run = emitted_run(run);
                                run.ins.set(info.clone());
                                runs.push(run);
                            }
                        }
                    }
                    blocks.push(SaveBlock {
                        kind: SaveBlockKind::Generated {
                            block: Box::new(generated_from(right_block, runs)),
                            docx_index: None,
                        },
                        revision: None,
                    });
                    continue;
                }
                // a table, a picture or a field: the whole block is kept or replaced
                if comparable_text(&left[l].text, &rules) == comparable_text(&right[r].text, &rules)
                {
                    summary.unchanged_paragraphs += 1;
                    blocks.push(original_passthrough(right_block));
                    continue;
                }
                summary.deleted_paragraphs += 1;
                summary.inserted_paragraphs += 1;
                blocks.push(deleted_block(left_block, &author, &date, &mut ids));
                blocks.push(inserted_block(right_block, &author, &date, &mut ids));
            }
            Aligned::Removed(l) => {
                summary.deleted_paragraphs += 1;
                summary.deletions += 1;
                blocks.push(deleted_block(left[l].block, &author, &date, &mut ids));
            }
            Aligned::Added(r) => {
                summary.inserted_paragraphs += 1;
                summary.insertions += 1;
                blocks.push(inserted_block(right[r].block, &author, &date, &mut ids));
            }
        }
    }

    ComparePlan {
        blocks,
        summary,
        next_revision_id: JsNum(ids.peek()),
    }
}

/// `unitsOf`: the comparable units of a document, in body order
fn units_of(blocks: &[Block]) -> Vec<Unit<'_>> {
    let mut out = Vec::new();
    for block in blocks {
        let removed = block
            .block_revision
            .as_ref()
            .is_some_and(|revision| revision.kind == BlockBlockRevisionKind::Del);
        if block.hidden.unwrap_or(false) || removed {
            continue;
        }
        out.push(Unit {
            block,
            text: content_signature(block),
        });
    }
    out
}

/// `contentSignature`: the text a block is compared by: its runs, a table's
/// cell texts, or its preview
fn content_signature(block: &Block) -> String {
    if let Some(runs) = block.runs.as_ref() {
        return comparable_runs(runs).iter().map(run_text).collect();
    }
    if let Some(table) = block.table.as_ref() {
        return table
            .rows
            .iter()
            .map(|row| {
                row.iter()
                    .map(|cell| cell.paras.as_deref().unwrap_or(&[]).join("\n"))
                    .collect::<Vec<_>>()
                    .join("\t")
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    // a picture is its bytes: the drawing xml names a media part by an id the
    // other package does not share, so the data url is what two pictures are
    // compared by. A block with nothing to compare by never matches another.
    if let Some(url) = block
        .image_data_url
        .as_deref()
        .filter(|url| !url.is_empty())
    {
        return format!("{PICTURE_TOKEN}{url}");
    }
    if let Some(preview) = block
        .preview_text
        .as_deref()
        .filter(|text| !text.is_empty())
    {
        return preview.to_owned();
    }
    format!("{PICTURE_TOKEN}opaque:{}", original_xml_of(block))
}

/// `alignUnits`: align the two documents: unchanged paragraphs anchor the
/// sequence, and the paragraphs between two anchors are paired by how much
/// they have in common, so an edited paragraph reads as an edit and a
/// paragraph that really was deleted stays a deletion.
fn align_units(left: &[Unit<'_>], right: &[Unit<'_>], rules: &Rules) -> Vec<Aligned> {
    let anchors = anchor_pairs(
        &left
            .iter()
            .map(|unit| comparable_text(&unit.text, rules))
            .collect::<Vec<_>>(),
        &right
            .iter()
            .map(|unit| comparable_text(&unit.text, rules))
            .collect::<Vec<_>>(),
    );
    let mut out = Vec::new();
    let mut li = 0;
    let mut ri = 0;
    for (l, r) in anchors {
        out.extend(pair_region(left, li..l, right, ri..r));
        out.push(Aligned::Pair(l, r));
        li = l + 1;
        ri = r + 1;
    }
    out.extend(pair_region(left, li..left.len(), right, ri..right.len()));
    out
}

/// `anchorPairs`: the unchanged paragraphs that anchor the alignment:
/// paragraphs whose text occurs once in each document pair up first (their
/// order is the longest increasing subsequence), and the gaps between them are
/// aligned by LCS. That keeps the LCS table to the gaps instead of the whole
/// document.
fn anchor_pairs(left: &[String], right: &[String]) -> Vec<(usize, usize)> {
    fn count(texts: &[String]) -> HashMap<&str, usize> {
        let mut counts = HashMap::new();
        for text in texts {
            *counts.entry(text.as_str()).or_insert(0) += 1;
        }
        counts
    }
    let left_count = count(left);
    let right_count = count(right);
    let mut right_index: HashMap<&str, usize> = HashMap::new();
    for (j, text) in right.iter().enumerate() {
        if right_count.get(text.as_str()) == Some(&1) && left_count.get(text.as_str()) == Some(&1) {
            right_index.insert(text.as_str(), j);
        }
    }
    let mut candidates = Vec::new();
    for (i, text) in left.iter().enumerate() {
        if let Some(&j) = right_index.get(text.as_str()) {
            candidates.push((i, j));
        }
    }
    let unique = longest_increasing(&candidates);

    let mut out = Vec::new();
    let mut li = 0;
    let mut ri = 0;
    let fill_gap =
        |li: usize, ri: usize, l_end: usize, r_end: usize, out: &mut Vec<(usize, usize)>| {
            let n = l_end.saturating_sub(li);
            let m = r_end.saturating_sub(ri);
            if n > 0 && m > 0 && n * m <= LCS_GAP_CELLS {
                for (l, r) in lcs_pairs(&left[li..l_end], &right[ri..r_end], |a, b| a == b) {
                    out.push((li + l, ri + r));
                }
            }
        };
    for (l, r) in unique {
        fill_gap(li, ri, l, r, &mut out);
        out.push((l, r));
        li = l + 1;
        ri = r + 1;
    }
    fill_gap(li, ri, left.len(), right.len(), &mut out);
    out
}

/// `longestIncreasing`: the longest run of candidate pairs whose right index
/// rises with the left one (pairs come sorted by left)
fn longest_increasing(pairs: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut tails: Vec<usize> = Vec::new();
    let mut tail_at: Vec<usize> = Vec::new();
    let mut prev: Vec<Option<usize>> = vec![None; pairs.len()];
    for (k, &(_, r)) in pairs.iter().enumerate() {
        let mut lo = 0;
        let mut hi = tails.len();
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if tails[mid] < r {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo == tails.len() {
            tails.push(r);
            tail_at.push(k);
        } else {
            tails[lo] = r;
            tail_at[lo] = k;
        }
        prev[k] = if lo > 0 { Some(tail_at[lo - 1]) } else { None };
    }
    let mut out = Vec::new();
    let mut k = tail_at.last().copied();
    while let Some(at) = k {
        out.push(pairs[at]);
        k = prev[at];
    }
    out.reverse();
    out
}

/// `x.replace(/\s+/g, ' ')`
fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `comparableText`: the text two paragraphs are matched by, the ignored
/// differences set aside
fn comparable_text(text: &str, rules: &Rules) -> String {
    let mut x = text.to_owned();
    if rules.ignore_whitespace {
        x = trim(&collapse_whitespace(&x)).to_owned();
    }
    if rules.ignore_case {
        x = x.to_lowercase();
    }
    x
}

/// `pairRegion`: the paragraphs between two anchors: pair the ones that
/// resemble each other
fn pair_region(
    left: &[Unit<'_>],
    left_range: std::ops::Range<usize>,
    right: &[Unit<'_>],
    right_range: std::ops::Range<usize>,
) -> Vec<Aligned> {
    let (l0, r0) = (left_range.start, right_range.start);
    let n = left_range.len();
    let m = right_range.len();
    if n == 0 {
        return right_range.map(Aligned::Added).collect();
    }
    if m == 0 {
        return left_range.map(Aligned::Removed).collect();
    }
    if n * m > 250_000 {
        return left_range
            .map(Aligned::Removed)
            .chain(right_range.map(Aligned::Added))
            .collect();
    }
    let mut dp = vec![vec![0.0f64; m + 1]; n + 1];
    // -1: removed, -2: added, -3: paired
    let mut paired = vec![vec![-1i8; m + 1]; n + 1];
    for i in 1..=n {
        for j in 1..=m {
            let mut best = dp[i - 1][j];
            let mut from = -1i8;
            if dp[i][j - 1] > best {
                best = dp[i][j - 1];
                from = -2;
            }
            let sim = similarity(&left[l0 + i - 1].text, &right[r0 + j - 1].text);
            if sim >= PAIR_THRESHOLD && dp[i - 1][j - 1] + sim > best {
                best = dp[i - 1][j - 1] + sim;
                from = -3;
            }
            dp[i][j] = best;
            paired[i][j] = from;
        }
    }
    let mut region = Vec::new();
    let mut i = n;
    let mut j = m;
    while i > 0 || j > 0 {
        let from = if i > 0 && j > 0 { paired[i][j] } else { -1 };
        if from == -3 {
            region.push(Aligned::Pair(l0 + i - 1, r0 + j - 1));
            i -= 1;
            j -= 1;
        } else if from == -2 {
            region.push(Aligned::Added(r0 + j - 1));
            j -= 1;
        } else if i > 0 {
            region.push(Aligned::Removed(l0 + i - 1));
            i -= 1;
        } else {
            region.push(Aligned::Added(r0 + j - 1));
            j -= 1;
        }
    }
    region.reverse();
    region
}

/// `similarity`: the share of words two texts have in common, 0 to 1
fn similarity(a: &str, b: &str) -> f64 {
    let left: Vec<Vec<u16>> = tokenize(&units_of_str(a), CompareGranularity::Word)
        .into_iter()
        .map(|token| token.text)
        .collect();
    let right: Vec<Vec<u16>> = tokenize(&units_of_str(b), CompareGranularity::Word)
        .into_iter()
        .map(|token| token.text)
        .collect();
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let common = lcs_pairs(&left, &right, |x, y| x == y).len();
    (2 * common) as f64 / (left.len() + right.len()) as f64
}

enum Op {
    Eq(usize, usize),
    Del(usize),
    Ins(usize),
}

/// `paragraphChunks`: the pieces of a changed paragraph: what stays, what was
/// deleted, what was added
fn paragraph_chunks(
    left_runs: &[Run],
    right_runs: &[Run],
    granularity: CompareGranularity,
    rules: &Rules,
) -> Vec<Chunk> {
    let left_text: Vec<u16> = left_runs
        .iter()
        .flat_map(|run| run_text(run).encode_utf16())
        .collect();
    let right_text: Vec<u16> = right_runs
        .iter()
        .flat_map(|run| run_text(run).encode_utf16())
        .collect();
    let left_tokens = tokenize(&left_text, granularity);
    let right_tokens = tokenize(&right_text, granularity);
    let pairs = lcs_pairs(&left_tokens, &right_tokens, |a, b| {
        token_equal(&a.text, &b.text, rules)
    });

    let mut ops = Vec::new();
    let mut li = 0;
    let mut ri = 0;
    for (l, r) in pairs {
        while li < l {
            ops.push(Op::Del(li));
            li += 1;
        }
        while ri < r {
            ops.push(Op::Ins(ri));
            ri += 1;
        }
        ops.push(Op::Eq(l, r));
        li = l + 1;
        ri = r + 1;
    }
    while li < left_tokens.len() {
        ops.push(Op::Del(li));
        li += 1;
    }
    while ri < right_tokens.len() {
        ops.push(Op::Ins(ri));
        ri += 1;
    }

    let left_starts = run_starts(left_runs);
    let right_starts = run_starts(right_runs);
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut keep: Option<KeepSpan> = None;
    fn flush(keep: &mut Option<KeepSpan>, chunks: &mut Vec<Chunk>) {
        if let Some((left, right)) = keep.take() {
            chunks.push(Chunk {
                kind: ChunkKind::Keep,
                left: Some(left),
                right: Some(right),
            });
        }
    }
    let blank = |text: &[u16]| text.iter().all(|&unit| is_space_unit(unit));
    for op in ops {
        match op {
            Op::Del(l) => {
                let token = &left_tokens[l];
                // a whitespace run the caller asked to ignore is not a difference
                if rules.ignore_whitespace && blank(&token.text) {
                    continue;
                }
                flush(&mut keep, &mut chunks);
                chunks.push(Chunk {
                    kind: ChunkKind::Del,
                    left: Some((token.start, token.end)),
                    right: None,
                });
            }
            Op::Ins(r) => {
                let token = &right_tokens[r];
                if rules.ignore_whitespace && blank(&token.text) {
                    continue;
                }
                flush(&mut keep, &mut chunks);
                chunks.push(Chunk {
                    kind: ChunkKind::Ins,
                    left: None,
                    right: Some((token.start, token.end)),
                });
            }
            Op::Eq(l, r) => {
                let (lt, rt) = (&left_tokens[l], &right_tokens[r]);
                let styled = !rules.ignore_formatting
                    && style_of(left_runs, &left_starts, lt)
                        != style_of(right_runs, &right_starts, rt);
                if styled {
                    flush(&mut keep, &mut chunks);
                    chunks.push(Chunk {
                        kind: ChunkKind::Del,
                        left: Some((lt.start, lt.end)),
                        right: None,
                    });
                    chunks.push(Chunk {
                        kind: ChunkKind::Ins,
                        left: None,
                        right: Some((rt.start, rt.end)),
                    });
                    continue;
                }
                keep = Some(match keep {
                    Some((left, right)) => ((left.0, lt.end), (right.0, rt.end)),
                    None => ((lt.start, lt.end), (rt.start, rt.end)),
                });
            }
        }
    }
    flush(&mut keep, &mut chunks);
    merge_chunks(chunks)
}

/// `mergeChunks`: neighbouring deletions (or insertions) become one revision region
fn merge_chunks(chunks: Vec<Chunk>) -> Vec<Chunk> {
    let mut out: Vec<Chunk> = Vec::new();
    for chunk in chunks {
        if let Some(last) = out.last_mut()
            && last.kind == chunk.kind
            && chunk.kind != ChunkKind::Keep
        {
            let (last_range, range) = if chunk.kind == ChunkKind::Del {
                (&mut last.left, chunk.left)
            } else {
                (&mut last.right, chunk.right)
            };
            if let (Some(last_range), Some(range)) = (last_range.as_mut(), range)
                && last_range.1 == range.0
            {
                last_range.1 = range.1;
                continue;
            }
        }
        out.push(chunk);
    }
    out
}

/// `hasRevision`
fn has_revision(chunks: &[Chunk]) -> bool {
    chunks.iter().any(|chunk| chunk.kind != ChunkKind::Keep)
}

fn is_space_unit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_space)
}

/// `tokenize`: words (or characters) and the whitespace between them, over
/// UTF-16 code units: without the `u` flag `[^\s]` takes one unit.
fn tokenize(text: &[u16], granularity: CompareGranularity) -> Vec<Token> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < text.len() {
        let space = is_space_unit(text[at]);
        let mut end = at + 1;
        if space || granularity == CompareGranularity::Word {
            while end < text.len() && is_space_unit(text[end]) == space {
                end += 1;
            }
        }
        out.push(Token {
            text: text[at..end].to_vec(),
            start: at,
            end,
        });
        at = end;
    }
    out
}

/// `lcsPairs`: the longest common subsequence of two sequences, as index pairs
fn lcs_pairs<T>(a: &[T], b: &[T], eq: impl Fn(&T, &T) -> bool) -> Vec<(usize, usize)> {
    let n = a.len();
    let m = b.len();
    let w = m + 1;
    let mut lcs = vec![0i32; (n + 1) * w];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i * w + j] = if eq(&a[i], &b[j]) {
                lcs[(i + 1) * w + j + 1] + 1
            } else {
                lcs[(i + 1) * w + j].max(lcs[i * w + j + 1])
            };
        }
    }
    let mut out = Vec::new();
    let mut i = 0;
    let mut j = 0;
    while i < n && j < m {
        if eq(&a[i], &b[j]) {
            out.push((i, j));
            i += 1;
            j += 1;
        } else if lcs[(i + 1) * w + j] >= lcs[i * w + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

/// `toLowerCase` over code units: a lone surrogate stays as it is.
fn lower_units(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut valid = String::new();
    let flush = |valid: &mut String, out: &mut Vec<u16>| {
        out.extend(valid.to_lowercase().encode_utf16());
        valid.clear();
    };
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(c) => valid.push(c),
            Err(error) => {
                flush(&mut valid, &mut out);
                out.push(error.unpaired_surrogate());
            }
        }
    }
    flush(&mut valid, &mut out);
    out
}

/// `x.replace(/\s+/g, ' ')` over code units
fn collapse_units(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut in_space = false;
    for &unit in units {
        if is_space_unit(unit) {
            if !in_space {
                out.push(u16::from(b' '));
            }
            in_space = true;
        } else {
            out.push(unit);
            in_space = false;
        }
    }
    out
}

/// `tokenEqual`: two tokens are the same when the ignored differences are set aside
fn token_equal(a: &[u16], b: &[u16], rules: &Rules) -> bool {
    let (mut x, mut y) = (a.to_vec(), b.to_vec());
    if rules.ignore_whitespace {
        x = collapse_units(&x);
        y = collapse_units(&y);
    }
    if rules.ignore_case {
        x = lower_units(&x);
        y = lower_units(&y);
    }
    x == y
}

/// `sliceRuns`: the runs covering a char range of the paragraph text. A
/// surrogate pair cut in half gives U+FFFD where JavaScript keeps the lone
/// half.
fn slice_runs(runs: &[Run], start: usize, end: usize) -> Vec<Run> {
    let mut out = Vec::new();
    let mut pos = 0;
    for run in runs {
        let run_start = pos;
        let run_end = pos + run_text(run).encode_utf16().count();
        pos = run_end;
        if run_end <= start || run_start >= end {
            continue;
        }
        let from = start.max(run_start);
        let to = end.min(run_end);
        let text = slice_utf16(
            run_text(run),
            (from - run_start) as f64,
            Some((to - run_start) as f64),
        );
        if text.is_empty() {
            continue;
        }
        let mut sliced = run.clone();
        sliced.text.set(text);
        out.push(sliced);
    }
    out
}

/// `runStarts`: the char offset each run starts at
fn run_starts(runs: &[Run]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut pos = 0;
    for run in runs {
        out.push(pos);
        pos += run_text(run).encode_utf16().count();
    }
    out
}

/// A number as `JSON.stringify` writes it: `null` for NaN, zero without its sign.
fn number_key(value: Option<JsNum>) -> serde_json::Value {
    match value {
        Some(JsNum(x)) if x.is_finite() => {
            if x == 0.0 {
                serde_json::Value::from(0)
            } else if x.fract() == 0.0 && x.abs() < 1e15 {
                serde_json::Value::from(x as i64)
            } else {
                serde_json::Value::from(x)
            }
        }
        _ => serde_json::Value::Null,
    }
}

fn text_key<T: Serialize>(value: Option<&T>) -> serde_json::Value {
    value
        .and_then(|value| serde_json::to_value(value).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// `styleOf`: the formatting of the run a token starts in
fn style_of(runs: &[Run], starts: &[usize], token: &Token) -> String {
    let Some(run) = run_index_at(starts, token.start).and_then(|index| runs.get(index)) else {
        return String::new();
    };
    let flag = |value: Option<bool>| serde_json::Value::Bool(value.unwrap_or(false));
    let key = serde_json::Value::Array(vec![
        text_key(run.style_id.as_ref()),
        flag(*run.bold),
        flag(*run.italic),
        flag(*run.underline),
        flag(*run.strike),
        flag(*run.dstrike),
        text_key(run.color.as_ref()),
        number_key(*run.size_half_points),
        text_key(run.font.as_ref()),
        text_key(run.font_ascii.as_ref()),
        text_key(run.east_asia_font.as_ref()),
        text_key(run.highlight.as_ref()),
        text_key(run.shading.as_ref()),
        text_key(run.vert_align.as_ref()),
        text_key(run.caps.as_ref()),
        flag(*run.vanish),
        number_key(*run.char_spacing_twips),
        number_key(*run.char_scale_pct),
        flag(*run.rtl),
    ]);
    key.to_string()
}

/// `runIndexAt`: the run that holds a char offset
fn run_index_at(starts: &[usize], offset: usize) -> Option<usize> {
    let mut ans = None;
    let mut lo = 0isize;
    let mut hi = starts.len() as isize - 1;
    while lo <= hi {
        let mid = (lo + hi) >> 1;
        if starts[mid as usize] <= offset {
            ans = Some(mid as usize);
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    ans
}

/// `generatedFrom`: the block as the generator wants it, with the given runs
fn generated_from(block: &Block, runs: Vec<Run>) -> GeneratedBlock {
    let r#type = match *block.r#type {
        Some(BlockType::Heading) => GeneratedBlockType::Heading,
        Some(BlockType::ListItem) => GeneratedBlockType::ListItem,
        _ => GeneratedBlockType::Paragraph,
    };
    GeneratedBlock {
        r#type,
        level: *block.level,
        outline_only: block.outline_only.unwrap_or(false).then_some(true),
        style_id: (*block.style_id).clone(),
        list: block.list.as_ref().map(|list| GeneratedBlockList {
            kind: match list.kind {
                BlockListKind::Bullet => GeneratedBlockListKind::Bullet,
                BlockListKind::Ordered => GeneratedBlockListKind::Ordered,
                BlockListKind::Unlisted(ref text) => GeneratedBlockListKind::Unlisted(text.clone()),
            },
            num_id: list.num_id.clone(),
            ilvl: list.ilvl,
        }),
        format: (*block.format).clone(),
        raw_p_pr: (*block.raw_p_pr).clone(),
        bookmarks: (*block.bookmarks).clone(),
        hidden_bookmarks: (*block.hidden_bookmarks).clone(),
        comment_starts: (*block.comment_starts).clone(),
        comment_ends: (*block.comment_ends).clone(),
        runs,
        sdt_shell: (*block.sdt_shell).clone(),
        p_pr_change: None,
        para_mark_del: None,
        para_mark_ins: None,
        para_mark_r_pr_change: None,
        numbering_change: None,
        sect_pr_change: None,
        block_revision: None,
    }
}

/// `blockRevision`: the block-level w:ins / w:del wrapper of a whole block,
/// unless the block sits in a content control: the shell bytes ride on the
/// block, and a wrapper around them would open w:del before w:sdt. The runs
/// carry the marks there.
fn block_revision(
    block: &Block,
    kind: RevisionKind,
    author: &str,
    date: &str,
    ids: &mut RevisionIds,
) -> Option<SaveRevision> {
    if block.sdt_shell.is_some() {
        return None;
    }
    Some(revision_of(kind, author, date, ids))
}

fn revision_of(
    kind: RevisionKind,
    author: &str,
    date: &str,
    ids: &mut RevisionIds,
) -> SaveRevision {
    SaveRevision {
        kind,
        info: RevisionInfo {
            author: author.to_owned(),
            date: Some(date.to_owned()),
            date_utc: None,
            id: Some(ids.take()),
            r#move: None,
        },
    }
}

/// `originalPassthrough`: an unchanged block: the original bytes, untouched
fn original_passthrough(block: &Block) -> SaveBlock {
    let kind = match docx_index_of(block) {
        Some(docx_index) => SaveBlockKind::Original { docx_index },
        None => SaveBlockKind::Generated {
            block: Box::new(generated_from(
                block,
                (*block.runs).clone().unwrap_or_default(),
            )),
            docx_index: None,
        },
    };
    SaveBlock {
        kind,
        revision: None,
    }
}

/// `deletedBlock`: a block the revised document dropped
fn deleted_block(block: &Block, author: &str, date: &str, ids: &mut RevisionIds) -> SaveBlock {
    let revision = revision_of(RevisionKind::Del, author, date, ids).info;
    if let Some(block_runs) = block.runs.as_ref() {
        let runs = comparable_runs(block_runs)
            .iter()
            .map(|run| {
                let mut run = foreign_run(run);
                run.del.set(revision.clone());
                run
            })
            .collect();
        return SaveBlock {
            kind: SaveBlockKind::Generated {
                block: Box::new(generated_from(block, runs)),
                docx_index: None,
            },
            revision: block_revision(block, RevisionKind::Del, author, date, ids),
        };
    }
    if *block.r#type == Some(BlockType::Image) {
        let mut picture = Run::default();
        picture.text.set("[picture]".to_owned());
        picture.del.set(revision);
        return SaveBlock {
            kind: SaveBlockKind::Generated {
                block: Box::new(generated_from(block, vec![picture])),
                docx_index: None,
            },
            revision: Some(revision_of(RevisionKind::Del, author, date, ids)),
        };
    }
    SaveBlock {
        kind: SaveBlockKind::Xml {
            xml: without_foreign_objects(original_xml_of(block)),
            docx_index: None,
            replace_image: None,
        },
        revision: Some(revision_of(RevisionKind::Del, author, date, ids)),
    }
}

/// `insertedBlock`: a block the revised document added
fn inserted_block(block: &Block, author: &str, date: &str, ids: &mut RevisionIds) -> SaveBlock {
    let revision = revision_of(RevisionKind::Ins, author, date, ids).info;
    if let Some(block_runs) = block.runs.as_ref() {
        let runs = comparable_runs(block_runs)
            .into_iter()
            .map(|run| {
                let mut run = emitted_run(run);
                run.ins.set(revision.clone());
                run
            })
            .collect();
        return SaveBlock {
            kind: SaveBlockKind::Generated {
                block: Box::new(generated_from(block, runs)),
                docx_index: None,
            },
            revision: block_revision(block, RevisionKind::Ins, author, date, ids),
        };
    }
    if let Some(docx_index) = docx_index_of(block) {
        return SaveBlock {
            kind: SaveBlockKind::Original { docx_index },
            revision: Some(revision_of(RevisionKind::Ins, author, date, ids)),
        };
    }
    SaveBlock {
        kind: SaveBlockKind::Xml {
            xml: original_xml_of(block).to_owned(),
            docx_index: None,
            replace_image: None,
        },
        revision: Some(revision_of(RevisionKind::Ins, author, date, ids)),
    }
}

/// `comparableRuns`: the runs as a reader sees them with every pending change
/// accepted: deleted text is gone, inserted text is plain. A picture becomes a
/// one-character token so it survives slicing by character range.
fn comparable_runs(runs: &[Run]) -> Vec<Run> {
    let mut out = Vec::new();
    for run in runs {
        if run.del.is_some() {
            continue;
        }
        let mut rest = run.clone();
        rest.ins.delete();
        if rest.image.is_some() && run_text(&rest).is_empty() {
            rest.text.set(PICTURE_TOKEN.to_owned());
        }
        out.push(rest);
    }
    out
}

/// `emittedRun`: a run of the revised document, the picture token folded back
/// into the picture run
fn emitted_run(mut run: Run) -> Run {
    if run.image.is_some() && run_text(&run) == PICTURE_TOKEN {
        run.text.set(String::new());
    }
    run
}

/// `foreignRun`: a run of the original document that ends up in the redline:
/// its picture points at a media part the revised package does not have, so
/// the deletion names it instead of carrying it. Its content controls stay
/// behind too: their ids belong to the other document.
fn foreign_run(run: &Run) -> Run {
    let mut own = run_copied_elsewhere(run);
    if own.image.is_none() {
        return own;
    }
    own.image.delete();
    own.text.set("[picture]".to_owned());
    own
}

/// `withoutForeignObjects`: drop the drawings, VML pictures and embedded
/// objects of a fragment from the other package
fn without_foreign_objects(xml: &str) -> String {
    let xml =
        js_regex!(r"<w:drawing>[\s\S]*?<\/w:drawing>", "g").replace_all(xml, |_| String::new());
    let xml = js_regex!(r"<w:pict(?:\s[^>]*)?>[\s\S]*?<\/w:pict>", "g")
        .replace_all(&xml, |_| String::new());
    js_regex!(r"<w:object(?:\s[^>]*)?>[\s\S]*?<\/w:object>", "g")
        .replace_all(&xml, |_| String::new())
}

/// `RevisionIds`: revision ids are unique across the document: they start
/// above every id the revised document already uses, so the redline never
/// repeats one.
struct RevisionIds {
    next: f64,
}

impl RevisionIds {
    fn new(document_xml: &str) -> Self {
        let mut max = 0.0f64;
        for found in js_regex!(r#"\bw:id\s*=\s*["'](\d+)["']"#, "g").find_iter(document_xml) {
            let id: f64 = found.get(1).unwrap_or("0").parse().unwrap_or(f64::NAN);
            max = max.max(id);
        }
        Self {
            next: (max + 1.0).max(9001.0),
        }
    }

    fn take(&mut self) -> String {
        let id = number_to_string(self.next);
        self.next += 1.0;
        id
    }

    /// the first id not handed out yet
    fn peek(&self) -> f64 {
        self.next
    }
}

/// `compareDocuments`: the redline of `revised` against `original`, written
/// as a docx. `now_ms` stands for the clock: the default date of a revision
/// and what `saveDocx` reads.
pub fn compare_documents(
    original: &ParsedDocFull,
    revised: &ParsedDocFull,
    options: &CompareOptions,
    now_ms: f64,
) -> Result<(Vec<u8>, CompareSummary), String> {
    let now = crate::save::save::helpers::to_iso_string(now_ms);
    let plan = compare_blocks(original, revised, options, &now);
    let save_options = crate::save::save::SaveOptions {
        revision_id_floor: Some(plan.next_revision_id),
        ..Default::default()
    };
    let bytes = crate::save::save::save_docx(revised, &plan.blocks, &save_options, now_ms)?;
    Ok((bytes, plan.summary))
}
